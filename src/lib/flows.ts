import "server-only";
import { ObjectId } from "mongodb";
import { nanoid } from "nanoid";
import { cols } from "@/lib/db";
import { UserError } from "@/lib/result";
import { loadStatuses } from "@/lib/statuses";
import { defaultFlowDoc } from "@/lib/flows-migration";
import { flowStepsFromDoc, flowStepsToDoc } from "@/lib/flow-convert";
import {
  defaultFlowSteps,
  pinStepsToProject,
  resolveFlowSteps,
  validateFlow,
  type FlowDirectory,
  type FlowMode,
  type FlowStatusLike,
  type FlowStep,
  type ResolvedFlow,
} from "@/lib/flow-model";
import type { FlowDoc, ProjectDoc, StatusDoc } from "@/lib/types";

/**
 * Project flows, storage + resolution (VEC-174; design docs/flows.md). The org default is a FlowDoc with
 * projectId null (seeded by migration and at org creation, and read as the seeded default when missing);
 * a project with flowMode "custom" has its own FlowDoc; "off" means no flow. Everything that reads a flow
 * goes through resolveFlow, which maps the steps onto the project's statuses and drops/flags bad references.
 */

const hex = (id: ObjectId) => id.toHexString();
export const newStepId = () => nanoid(8);

const toStatusLike = (s: StatusDoc): FlowStatusLike => ({ id: hex(s._id), name: s.name, category: s.category, order: s.order });

/** The org's bots and people, by id (hex) -> name. */
export async function loadFlowDirectory(orgId: ObjectId): Promise<FlowDirectory> {
  const c = await cols();
  const [bots, memberships] = await Promise.all([
    c.bots.find({ orgId }, { projection: { name: 1 } }).toArray(),
    c.memberships.find({ orgId }, { projection: { userId: 1 } }).toArray(),
  ]);
  const users = memberships.length
    ? await c.users.find({ _id: { $in: memberships.map((m) => m.userId) } }, { projection: { name: 1 } }).toArray()
    : [];
  return {
    bots: new Map(bots.map((b) => [hex(b._id), b.name])),
    people: new Map(users.map((u) => [hex(u._id), u.name])),
  };
}

/** The org default flow doc. Lazy default: an org the migration never reached reads as the seeded default (version 0). */
export async function loadOrgFlowDoc(orgId: ObjectId): Promise<FlowDoc> {
  const c = await cols();
  const doc = await c.flows.findOne({ orgId, projectId: null });
  return doc ?? { ...defaultFlowDoc(orgId), version: 0 };
}

/** Gives a new org its default flow (idempotent). */
export async function seedOrgFlow(orgId: ObjectId): Promise<void> {
  const c = await cols();
  const { _id, ...rest } = defaultFlowDoc(orgId);
  await c.flows.updateOne({ orgId, projectId: null }, { $setOnInsert: { _id, ...rest } }, { upsert: true });
}

type ProjectRef = Pick<ProjectDoc, "_id" | "orgId"> & Partial<Pick<ProjectDoc, "flowMode">>;
export interface ResolveContext {
  statuses?: StatusDoc[];
  dir?: FlowDirectory;
  /** Reuse an already-loaded org default (e.g. when resolving every project of an org). */
  orgFlow?: FlowDoc;
}

/**
 * The flow that applies to `project`: its own (flowMode "custom" with a FlowDoc), else the org default,
 * mapped onto the project's statuses. Null when the project switched flows off. Never throws on bad data:
 * deleted statuses fall back by stage/name, removed owners become unowned, missing stages are skipped,
 * each flagged in the step's `issues`.
 */
export async function resolveFlow(project: ProjectRef, ctx: ResolveContext = {}): Promise<ResolvedFlow | null> {
  const c = await cols();
  const mode = project.flowMode ?? (await c.projects.findOne({ _id: project._id, orgId: project.orgId }, { projection: { flowMode: 1 } }))?.flowMode ?? "inherit";
  if (mode === "off") return null;
  const [statuses, dir] = await Promise.all([ctx.statuses ?? loadStatuses(project.orgId, project._id), ctx.dir ?? loadFlowDirectory(project.orgId)]);
  let doc: FlowDoc | null = null;
  if (mode === "custom") doc = await c.flows.findOne({ orgId: project.orgId, projectId: project._id });
  const source = doc ? "project" : "org";
  doc ??= ctx.orgFlow ?? (await loadOrgFlowDoc(project.orgId));
  return resolveFlowSteps(flowStepsFromDoc(doc.steps), statuses.map(toStatusLike), dir, { source, version: doc.version });
}

/** Resolved flows of every project of the org (one directory + org default load). Key = project id hex. */
export async function resolveOrgFlows(orgId: ObjectId): Promise<Map<string, ResolvedFlow | null>> {
  const c = await cols();
  const [projects, dir, orgFlow, statusDocs] = await Promise.all([
    c.projects.find({ orgId }, { projection: { flowMode: 1, orgId: 1 } }).toArray(),
    loadFlowDirectory(orgId),
    loadOrgFlowDoc(orgId),
    c.statuses.find({ orgId }).sort({ order: 1 }).toArray(),
  ]);
  const out = new Map<string, ResolvedFlow | null>();
  for (const p of projects) {
    const statuses = statusDocs.filter((s) => s.projectId.equals(p._id));
    out.set(hex(p._id), await resolveFlow({ _id: p._id, orgId, flowMode: p.flowMode ?? "inherit" }, { statuses, dir, orgFlow }));
  }
  return out;
}

/* ---------------- editor data ---------------- */

/** What the flow editor (VEC-177) needs for the org default. */
export interface OrgFlowSettings {
  steps: FlowStep[];
  version: number;
  updatedAt: string | null;
}
export async function loadOrgFlowSettings(orgId: ObjectId): Promise<OrgFlowSettings> {
  const doc = await loadOrgFlowDoc(orgId);
  return { steps: flowStepsFromDoc(doc.steps), version: doc.version, updatedAt: doc.version ? doc.updatedAt.toISOString() : null };
}

/** A project's flow setting: its mode, its own steps (custom only) and the resolved flow it runs. */
export interface ProjectFlowSettings {
  mode: FlowMode;
  steps: FlowStep[] | null;
  version: number | null;
  resolved: ResolvedFlow | null;
  /** The project has a flow of its own stored (kept while it inherits or is off, until Reset to default). */
  hasOwn: boolean;
}
export async function loadProjectFlowSettings(orgId: ObjectId, projectId: ObjectId): Promise<ProjectFlowSettings> {
  const c = await cols();
  const project = await c.projects.findOne({ _id: projectId, orgId }, { projection: { flowMode: 1, orgId: 1 } });
  if (!project) throw new UserError("That project no longer exists.");
  const mode = project.flowMode ?? "inherit";
  const stored = await c.flows.findOne({ orgId, projectId });
  const own = mode === "custom" ? stored : null;
  return {
    mode,
    steps: own ? flowStepsFromDoc(own.steps) : null,
    version: own?.version ?? null,
    resolved: await resolveFlow({ _id: projectId, orgId, flowMode: mode }),
    hasOwn: !!stored,
  };
}

/** Open, unarchived tasks sitting at each step (by step id), for the editor: a project's own flow, or every task positioned against the org default. */
export async function loadFlowStepCounts(orgId: ObjectId, scope: { projectId: ObjectId } | { source: "org" }): Promise<Record<string, number>> {
  const c = await cols();
  const closed = await c.statuses.find({ orgId, category: { $in: ["done", "cancelled"] } }, { projection: { _id: 1 } }).toArray();
  const rows = await c.tasks
    .aggregate<{ _id: string; n: number }>([
      {
        $match: {
          orgId,
          archivedAt: null,
          "flow.stepId": { $type: "string" },
          statusId: { $nin: closed.map((s) => s._id) },
          ...("projectId" in scope ? { projectId: scope.projectId, "flow.source": "project" } : { "flow.source": "org" }),
        },
      },
      { $group: { _id: "$flow.stepId", n: { $sum: 1 } } },
    ])
    .toArray();
  return Object.fromEntries(rows.map((r) => [r._id, r.n]));
}

/** Per project, for the org default editor: which flow it uses and which default steps it skips. Archived projects are left out. */
export interface ProjectFlowSummary {
  id: string;
  key: string;
  name: string;
  color: string;
  mode: FlowMode;
  /** Inheriting projects only: ids of default steps that don't apply there (stage missing). */
  skipped: string[];
  /** The flow it runs has adjusted or skipped steps. */
  hasIssues: boolean;
}
export async function loadProjectFlowSummaries(orgId: ObjectId): Promise<ProjectFlowSummary[]> {
  const c = await cols();
  const [projects, resolved] = await Promise.all([
    c.projects.find({ orgId, archivedAt: null }, { projection: { key: 1, name: 1, color: 1, flowMode: 1, createdAt: 1 } }).sort({ createdAt: 1 }).toArray(),
    resolveOrgFlows(orgId),
  ]);
  return projects.map((p) => {
    const mode = p.flowMode ?? "inherit";
    const flow = resolved.get(hex(p._id)) ?? null;
    return {
      id: hex(p._id),
      key: p.key,
      name: p.name,
      color: p.color,
      mode,
      skipped: mode === "inherit" && flow ? flow.skipped.map((s) => s.id) : [],
      hasIssues: !!flow?.hasIssues,
    };
  });
}

/* ---------------- a bot's part in flows (VEC-187) ---------------- */

/** One step a bot takes part in: it owns it, can resolve its wait, or picks it up as a triage bot. */
export interface BotFlowStep {
  id: string;
  name: string;
  as: ("owner" | "resolver" | "triage")[];
}
/** A flow the bot takes part in: the org default (with how many projects follow it) or a project's own flow. */
export interface BotFlowPlace {
  source: "org" | "project";
  project: { id: string; key: string; name: string; color: string } | null;
  /** Org default only: unarchived projects that follow it. */
  followedBy: number;
  steps: BotFlowStep[];
}

/**
 * Where a bot works, for the read-only "Where it works" row on its settings page: every step of the org default and of
 * each unarchived project's own flow that it owns or can resolve, plus triage steps when `triage` (its role has
 * check_for_triage). Steps are still edited in the flows; this is the view from the bot's side.
 */
export async function loadBotFlowPlaces(orgId: ObjectId, botId: ObjectId, { triage }: { triage: boolean }): Promise<BotFlowPlace[]> {
  const c = await cols();
  const id = hex(botId);
  const [orgFlow, projects] = await Promise.all([
    loadOrgFlowDoc(orgId),
    c.projects.find({ orgId, archivedAt: null }, { projection: { key: 1, name: 1, color: 1, flowMode: 1, createdAt: 1 } }).sort({ createdAt: 1 }).toArray(),
  ]);
  const custom = projects.filter((p) => p.flowMode === "custom");
  const own = custom.length ? await c.flows.find({ orgId, projectId: { $in: custom.map((p) => p._id) } }).toArray() : [];
  const stepsOf = (steps: FlowStep[]): BotFlowStep[] =>
    steps.flatMap((s) => {
      const as: BotFlowStep["as"] = [];
      if (s.owner.kind === "bot" && s.owner.id === id) as.push("owner");
      if (s.owner.kind === "triage" && triage) as.push("triage");
      if (s.advance === "wait" && s.wait?.resolvers?.includes(id)) as.push("resolver");
      return as.length ? [{ id: s.id, name: s.name, as }] : [];
    });
  const out: BotFlowPlace[] = [];
  const followedBy = projects.filter((p) => (p.flowMode ?? "inherit") === "inherit").length;
  const orgSteps = stepsOf(flowStepsFromDoc(orgFlow.steps));
  if (orgSteps.length) out.push({ source: "org", project: null, followedBy, steps: orgSteps });
  for (const p of custom) {
    const doc = own.find((f) => f.projectId?.equals(p._id));
    if (!doc) continue;
    const steps = stepsOf(flowStepsFromDoc(doc.steps));
    if (steps.length) out.push({ source: "project", project: { id: hex(p._id), key: p.key, name: p.name, color: p.color }, followedBy: 0, steps });
  }
  return out;
}

/* ---------------- writes (callers authorise and publish) ---------------- */

function failValidation(errors: string[]): never {
  const shown = errors.slice(0, 5).join(" ");
  throw new UserError(errors.length > 5 ? `${shown} (and ${errors.length - 5} more)` : shown);
}

/** Validates and stores the org default flow. Returns the new version. */
export async function writeOrgFlow(orgId: ObjectId, actorId: ObjectId, input: unknown): Promise<number> {
  const res = validateFlow(input, { level: "org", dir: await loadFlowDirectory(orgId), newId: newStepId });
  if (!res.ok) failValidation(res.errors);
  return upsertFlow(orgId, null, actorId, res.steps);
}

/** Puts the org default back to the seeded default. */
export async function writeOrgFlowReset(orgId: ObjectId, actorId: ObjectId): Promise<number> {
  return upsertFlow(orgId, null, actorId, defaultFlowSteps());
}

/** Validates (against the project's own statuses) and stores a project's flow; sets flowMode "custom". */
export async function writeProjectFlow(orgId: ObjectId, projectId: ObjectId, actorId: ObjectId, input: unknown): Promise<number> {
  await requireProject(orgId, projectId);
  const [statuses, dir] = await Promise.all([loadStatuses(orgId, projectId), loadFlowDirectory(orgId)]);
  const res = validateFlow(input, { level: "project", statuses: statuses.map(toStatusLike), dir, newId: newStepId });
  if (!res.ok) failValidation(res.errors);
  const version = await upsertFlow(orgId, projectId, actorId, res.steps);
  await (await cols()).projects.updateOne({ _id: projectId, orgId }, { $set: { flowMode: "custom" } });
  return version;
}

/** "Reset to default": deletes the project's own flow and inherits the org default again. */
export async function writeProjectFlowReset(orgId: ObjectId, projectId: ObjectId): Promise<void> {
  await requireProject(orgId, projectId);
  const c = await cols();
  await c.flows.deleteOne({ orgId, projectId });
  await c.projects.updateOne({ _id: projectId, orgId }, { $unset: { flowMode: "" } });
}

/**
 * Switches a project's flow mode. "custom" without a flow of its own copies the resolved org default
 * ("Customise for this project", steps pinned to the project's statuses); "inherit" keeps any own flow
 * stored but unused (use reset to drop it); "off" turns flows off for the project.
 */
export async function writeProjectFlowMode(orgId: ObjectId, projectId: ObjectId, actorId: ObjectId, mode: FlowMode): Promise<void> {
  await requireProject(orgId, projectId);
  const c = await cols();
  if (mode === "custom" && !(await c.flows.findOne({ orgId, projectId }, { projection: { _id: 1 } }))) {
    const resolved = await resolveFlow({ _id: projectId, orgId, flowMode: "inherit" });
    const steps = resolved ? pinStepsToProject(resolved) : [];
    if (!steps.length || steps[steps.length - 1].status.stage !== "done") throw new UserError("The default flow doesn't fit this project's statuses. Edit the default flow first.");
    await upsertFlow(orgId, projectId, actorId, steps);
  }
  await c.projects.updateOne({ _id: projectId, orgId }, mode === "inherit" ? { $unset: { flowMode: "" } } : { $set: { flowMode: mode } });
}

async function requireProject(orgId: ObjectId, projectId: ObjectId) {
  const p = await (await cols()).projects.findOne({ _id: projectId, orgId }, { projection: { _id: 1 } });
  if (!p) throw new UserError("That project no longer exists.");
}

async function upsertFlow(orgId: ObjectId, projectId: ObjectId | null, actorId: ObjectId, steps: FlowStep[]): Promise<number> {
  const c = await cols();
  const res = await c.flows.findOneAndUpdate(
    { orgId, projectId },
    { $set: { steps: flowStepsToDoc(steps), updatedAt: new Date(), updatedBy: actorId }, $inc: { version: 1 }, $setOnInsert: { _id: new ObjectId() } },
    { upsert: true, returnDocument: "after" },
  );
  return res?.version ?? 1;
}

/* ---------------- consistency hooks ---------------- */

/** A project status changed stage: its project flow's steps keep their stored stage (the fallback) in step. Renames need nothing (steps hold the id). */
export async function flowStatusUpdated(orgId: ObjectId, projectId: ObjectId, status: Pick<StatusDoc, "_id" | "name" | "category">): Promise<void> {
  const c = await cols();
  await c.flows.updateOne(
    { orgId, projectId, "steps.status.statusId": status._id },
    { $set: { "steps.$[s].status.stage": status.category, "steps.$[s].status.name": status.name }, $inc: { version: 1 }, $currentDate: { updatedAt: true } },
    { arrayFilters: [{ "s.status.statusId": status._id }] },
  );
}

/**
 * A project status was deleted: the project flow's steps on it fall back to its stage + name (resolved in
 * the project as the first status of that stage, preferring the same name) and are flagged `deleted` for
 * the editor. No dangling status ids stay behind.
 */
export async function flowStatusDeleted(orgId: ObjectId, projectId: ObjectId, removed: Pick<StatusDoc, "_id" | "name" | "category">): Promise<void> {
  const c = await cols();
  await c.flows.updateOne(
    { orgId, projectId, "steps.status.statusId": removed._id },
    { $set: { "steps.$[s].status": { stage: removed.category, name: removed.name, deleted: true } }, $inc: { version: 1 }, $currentDate: { updatedAt: true } },
    { arrayFilters: [{ "s.status.statusId": removed._id }] },
  );
}

/**
 * A bot was deleted or a person left the org: every flow step they owned becomes unowned (flagged with who
 * was removed, so the editor and the engine can say so), and bots are dropped from wait resolvers.
 * Returns how many flows changed.
 */
export async function flowOwnerRemoved(orgId: ObjectId, kind: "bot" | "person", id: ObjectId, name: string): Promise<number> {
  const c = await cols();
  const flows = await c.flows.find({ orgId, $or: [{ "steps.owner.id": id }, { "steps.wait.resolvers": id }] }).toArray();
  for (const f of flows) {
    const steps = f.steps.map((s) => ({
      ...s,
      owner: s.owner?.id && s.owner.id.equals(id) && s.owner.kind === kind ? { kind: "none" as const, removed: { kind, name } } : s.owner,
      ...(s.wait ? { wait: { ...s.wait, resolvers: (s.wait.resolvers ?? []).filter((r) => !r.equals(id)) } } : {}),
    }));
    await c.flows.updateOne({ _id: f._id }, { $set: { steps, updatedAt: new Date() }, $inc: { version: 1 } });
  }
  return flows.length;
}

/** A project was deleted: its own flow goes with it. */
export async function deleteProjectFlow(orgId: ObjectId, projectId: ObjectId): Promise<void> {
  await (await cols()).flows.deleteMany({ orgId, projectId });
}
