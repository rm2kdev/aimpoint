import "server-only";
import { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { UserError } from "@/lib/result";
import { loadStatuses } from "@/lib/statuses";
import { newTaskStatusFor } from "@/lib/project-defaults";
import { hasFeature, requireFeatureById } from "@/lib/billing-limits";
import { createTaskAs, type Actor } from "@/lib/task-service";
import { hit, ipKey, waitText } from "@/lib/form-submit";
import { claimUploads, pendingUploads, receivePendingImage, type UploadOwner, type UploadResult } from "@/lib/form-uploads";
import { PUBLIC_UPLOAD_RATE_LIMITS } from "@/lib/form-upload-core";
import { INTAKE_ERRORS, SUBMITTER_NAME_MAX, imageSources, normalizeTitle, prepareDescription, publicSanitize, resolveStatus, resolveType } from "@/lib/task-intake-core";
import { loadDirectory, personName } from "@/lib/mcp/context";
import {
  PUBLIC_COMMENTS_MAX,
  PUBLIC_RATE_LIMITS,
  PUBLIC_STATS_RATE_LIMIT,
  PUBLIC_SUBTASKS_MAX,
  PUBLIC_TASKS_MAX,
  PUBLIC_UNAVAILABLE,
  PUBLIC_UPLOAD_FILE,
  initialSubmitStatuses,
  isPublicSubmitStage,
  parsePublicRef,
  pruneSubmitStatuses,
  resolveSubmitStatuses,
  rewritePublicImages,
  shapePublicComment,
  shapePublicSubtask,
  shapePublicTask,
  computeStats,
  publicProgress,
  type PublicProjectStats,
  type StatsRow,
} from "@/lib/project-public-core";
import {
  TASK_TYPES,
  type OrgDoc,
  type ProjectDoc,
  type ProjectPublicAccess,
  type ProjectPublicAccessDoc,
  type PublicComment,
  type PublicProgress,
  type PublicProjectResult,
  type PublicProjectView,
  type PublicStatus,
  type PublicSubtask,
  type PublicTask,
  type StatusCategory,
  type StatusDoc,
  type Task,
  type TaskDoc,
  type UserDoc,
} from "@/lib/types";

/**
 * Public projects (VEC-254/255). An admin makes a project public (`ProjectDoc.publicAccess`): anyone can then read a
 * sanitised view of its non-archived tasks, and any signed-in Aimpoint account (membership not needed) can submit a
 * ticket into the statuses the admin allows. Gated on the same plan feature as external forms (`publicForms`).
 *
 * Submissions are created through createTaskAs with the project's id as the creator (no person has that id, like a
 * form's id for form tasks), so the submitter never gets creator edit rights, creator notifications or anything a
 * membership gives; who submitted it is `source: {kind: "public", userId, userName}`. Pure rules live in
 * lib/project-public-core.ts.
 */

/** Who manages a project's public settings: a signed-in member of its org. Only admins may. */
export interface PublicSettingsActor {
  orgId: ObjectId;
  userId: ObjectId;
  isAdmin: boolean;
}

export interface PublicAccessPatch {
  enabled?: boolean;
  submitStatusIds?: string[];
  showComments?: boolean;
  /** Serve public task counts + shields.io badges (VEC-363). Default off. */
  showStats?: boolean;
}

const oid = (id: string, what: string) => {
  if (typeof id !== "string" || !ObjectId.isValid(id)) throw new UserError(`Unknown ${what}.`);
  return new ObjectId(id);
};

const statusLike = (s: StatusDoc) => ({ id: s._id.toHexString(), name: s.name, category: s.category });
const toPublicStatus = (s: StatusDoc): PublicStatus => ({ id: s._id.toHexString(), name: s.name, color: s.color, stage: s.category });

export function toPublicAccess(projectId: ObjectId, a: ProjectPublicAccessDoc | null | undefined): ProjectPublicAccess {
  return {
    projectId: projectId.toHexString(),
    enabled: !!a?.enabled,
    submitStatusIds: (a?.submitStatusIds ?? []).map((id) => id.toHexString()),
    showComments: !!a?.showComments,
    showStats: !!a?.showStats,
    updatedAt: a?.updatedAt ? a.updatedAt.toISOString() : null,
    updatedBy: a?.updatedBy ? a.updatedBy.toHexString() : null,
  };
}

function assertAdmin(actor: PublicSettingsActor) {
  if (!actor.isAdmin) throw new UserError("Only admins can change whether a project is public.");
}

async function ownProject(orgId: ObjectId, projectId: string) {
  const c = await cols();
  const project = await c.projects.findOne({ _id: oid(projectId, "project"), orgId }, { projection: { name: 1, key: 1, archivedAt: 1, publicAccess: 1, defaults: 1 } });
  if (!project) throw new UserError("That project no longer exists.");
  return project;
}

/** The project's public settings (admins only), with statuses that are no longer allowed left out. */
export async function getProjectPublicAccess(actor: PublicSettingsActor, projectId: string): Promise<ProjectPublicAccess> {
  assertAdmin(actor);
  const project = await ownProject(actor.orgId, projectId);
  const view = toPublicAccess(project._id, project.publicAccess);
  view.submitStatusIds = pruneSubmitStatuses(view.submitStatusIds, (await loadStatuses(actor.orgId, project._id)).map(statusLike));
  return view;
}

/**
 * Changes the project's public settings (admins only). Fields left out keep their saved values. Turning it on needs
 * the plan feature and an unarchived project; turning it off or editing a switched-off one always works.
 */
export async function setProjectPublicAccess(actor: PublicSettingsActor, projectId: string, patch: PublicAccessPatch): Promise<ProjectPublicAccess> {
  assertAdmin(actor);
  const project = await ownProject(actor.orgId, projectId);
  const prev = project.publicAccess;
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") throw new UserError("`enabled` is true or false.");
  if (patch.showComments !== undefined && typeof patch.showComments !== "boolean") throw new UserError("`showComments` is true or false.");
  if (patch.showStats !== undefined && typeof patch.showStats !== "boolean") throw new UserError("`showStats` is true or false.");
  const enabled = patch.enabled ?? !!prev?.enabled;
  if (enabled && !prev?.enabled) {
    if (project.archivedAt) throw new UserError(`${project.name} (${project.key}) is archived. Restore it before making it public.`);
    await requireFeatureById(actor.orgId, "publicForms");
  }
  const statuses = (await loadStatuses(actor.orgId, project._id)).map(statusLike);
  let submitStatusIds: string[];
  if (patch.submitStatusIds !== undefined) {
    const r = resolveSubmitStatuses(patch.submitStatusIds, statuses);
    if (!r.ok) throw new UserError(r.error);
    submitStatusIds = r.ids;
  } else submitStatusIds = pruneSubmitStatuses((prev?.submitStatusIds ?? []).map((id) => id.toHexString()), statuses);
  // Switching on with nothing allowed yet: submissions follow the project's new-task status (AIM-2).
  if (enabled && !prev?.enabled && patch.submitStatusIds === undefined && !submitStatusIds.length) {
    const newTask = (await newTaskStatusFor(actor.orgId, project._id, project)).status;
    submitStatusIds = initialSubmitStatuses([], newTask?._id.toHexString(), statuses);
  }
  const doc: ProjectPublicAccessDoc = {
    enabled,
    submitStatusIds: submitStatusIds.map((id) => new ObjectId(id)),
    showComments: patch.showComments ?? !!prev?.showComments,
    showStats: patch.showStats ?? !!prev?.showStats,
    updatedAt: new Date(),
    updatedBy: actor.userId,
  };
  const c = await cols();
  const r = await c.projects.updateOne({ _id: project._id, orgId: actor.orgId }, { $set: { publicAccess: doc } });
  if (!r.matchedCount) throw new UserError("That project no longer exists.");
  return toPublicAccess(project._id, doc);
}

/* ---------------- keeping the settings valid ---------------- */

/** A status of the project was deleted: it can't be a submit destination any more. */
export async function publicStatusDeleted(orgId: ObjectId, projectId: ObjectId, statusId: ObjectId): Promise<number> {
  const c = await cols();
  const r = await c.projects.updateOne({ _id: projectId, orgId, "publicAccess.submitStatusIds": statusId }, { $pull: { "publicAccess.submitStatusIds": statusId } });
  return r.modifiedCount;
}

/** A status changed stage: when it left the submit stages it's dropped from the submit statuses. */
export async function publicStatusStageChanged(orgId: ObjectId, projectId: ObjectId, statusId: ObjectId, to: StatusCategory): Promise<number> {
  if (isPublicSubmitStage(to)) return 0;
  return publicStatusDeleted(orgId, projectId, statusId);
}

/** The project was archived: it stops being public (restoring it doesn't turn it back on by itself). */
export async function publicProjectArchived(orgId: ObjectId, projectId: ObjectId): Promise<number> {
  const c = await cols();
  const r = await c.projects.updateOne({ _id: projectId, orgId, "publicAccess.enabled": true }, { $set: { "publicAccess.enabled": false, "publicAccess.updatedAt": new Date() } });
  return r.modifiedCount;
}

/* ---------------- public read side ---------------- */

type PublicProjectDoc = Pick<ProjectDoc, "_id" | "orgId" | "name" | "key" | "color" | "archivedAt" | "publicAccess">;
interface Found {
  org: Pick<OrgDoc, "_id" | "name" | "slug">;
  project: PublicProjectDoc;
  available: boolean;
}

/**
 * The org + project behind a public URL when the project is public (enabled, not archived), else null. `available`
 * is false while the org's plan lacks the feature: callers then show nothing but an unavailable message.
 */
export async function findPublicProject(slugIn: unknown, keyIn: unknown): Promise<Found | null> {
  const ref = parsePublicRef(slugIn, keyIn);
  if (!ref) return null;
  const c = await cols();
  const org = await c.orgs.findOne({ slug: ref.slug }, { projection: { _id: 1, name: 1, slug: 1 } });
  if (!org) return null;
  const project = await c.projects.findOne(
    { orgId: org._id, key: ref.key, "publicAccess.enabled": true, archivedAt: null },
    { projection: { _id: 1, orgId: 1, name: 1, key: 1, color: 1, archivedAt: 1, publicAccess: 1 } },
  );
  if (!project) return null;
  return { org, project, available: await hasFeature(org._id, "publicForms") };
}

/**
 * Projection of the only task fields the public view reads. `parentId` (VEC-409) is read to fold sub-tasks under
 * their request and is never copied out: the public shapes (shapePublicTask / shapePublicSubtask) are allow-lists.
 */
const TASK_FIELDS = { _id: 1, number: 1, title: 1, type: 1, statusId: 1, priority: 1, description: 1, createdAt: 1, updatedAt: 1, parentId: 1 } as const;
type PublicTaskDoc = Pick<TaskDoc, "_id" | "number" | "title" | "type" | "statusId" | "priority" | "description" | "createdAt" | "updatedAt" | "parentId">;

type ProjectRef = Pick<ProjectDoc, "_id" | "orgId">;

/**
 * Aggregation stages keeping only a public project's top-level tasks (VEC-409): tasks with no parent, or whose parent
 * isn't visible on this page (archived, or in another project), so a sub-task never vanishes with nothing to sit under.
 */
const topLevelStages = (project: ProjectRef) => [
  {
    $lookup: {
      from: "tasks",
      let: { pid: "$parentId" },
      pipeline: [{ $match: { $expr: { $eq: ["$_id", "$$pid"] } } }, { $match: { orgId: project.orgId, projectId: project._id, archivedAt: null } }, { $project: { _id: 1 } }],
      as: "_visibleParent",
    },
  },
  { $match: { "_visibleParent.0": { $exists: false } } },
];

/**
 * Sub-task progress of the given parents (VEC-409): one $group aggregation over their unarchived sub-tasks in this
 * project (a sub-task filed into another project is never counted or named here), stages from the project's statuses.
 */
async function childProgress(project: ProjectRef, parentIds: ObjectId[], statuses: StatusDoc[]): Promise<Map<string, PublicProgress>> {
  if (!parentIds.length) return new Map();
  const c = await cols();
  const groups = await c.tasks
    .aggregate<{ _id: { parentId: ObjectId; statusId: ObjectId }; count: number }>([
      { $match: { orgId: project.orgId, projectId: project._id, archivedAt: null, parentId: { $in: parentIds } } },
      { $group: { _id: { parentId: "$parentId", statusId: "$statusId" }, count: { $sum: 1 } } },
    ])
    .toArray();
  const stageOf = new Map(statuses.map((s) => [s._id.toHexString(), s.category]));
  return publicProgress(groups.map((g) => ({ parentId: g._id.parentId, stage: stageOf.get(String(g._id.statusId)) ?? null, count: g.count })));
}

async function viewParts(f: Found) {
  const statuses = await loadStatuses(f.project.orgId, f.project._id);
  const byId = new Map(statuses.map((s) => [s._id.toHexString(), toPublicStatus(s)]));
  const allowed = pruneSubmitStatuses((f.project.publicAccess?.submitStatusIds ?? []).map((id) => id.toHexString()), statuses.map(statusLike));
  const ctx = { orgId: f.org._id.toHexString(), slug: f.org.slug, key: f.project.key };
  const shape = (t: PublicTaskDoc, progress?: PublicProgress | null) =>
    shapePublicTask(t, f.project.key, byId, rewritePublicImages(publicSanitize(t.description ?? "", { allowImages: true }), ctx), progress ?? null);
  /** Shapes docs with their sub-task progress (one aggregation for the whole list). */
  const shapeAll = async (docs: PublicTaskDoc[]) => {
    const progress = await childProgress(f.project, docs.map((d) => d._id), statuses);
    return docs.map((d) => shape(d, progress.get(d._id.toHexString())));
  };
  return { statuses, byId, allowed, shape, shapeAll };
}

/**
 * The public view of a project: null unless it's public; `{available: false}` (and nothing else) while the plan lacks
 * the feature. Otherwise its name/key/colour, statuses, the statuses open to submissions, and its non-archived
 * top-level tasks (VEC-409: sub-tasks fold under their request, see topLevelStages; newest activity first, at most
 * PUBLIC_TASKS_MAX) in the allow-listed public shape with their sub-task progress. No member, bot, activity, flow,
 * claim, parent id, project metadata or other project data is ever read into it.
 */
export async function loadPublicProject(slug: unknown, key: unknown): Promise<PublicProjectResult | null> {
  const f = await findPublicProject(slug, key);
  if (!f) return null;
  if (!f.available) return { available: false };
  const c = await cols();
  const [{ statuses, byId, allowed, shapeAll }, docs, stats] = await Promise.all([
    viewParts(f),
    c.tasks
      .aggregate<PublicTaskDoc>([
        { $match: { orgId: f.project.orgId, projectId: f.project._id, archivedAt: null } },
        { $sort: { updatedAt: -1 } },
        ...topLevelStages(f.project),
        { $limit: PUBLIC_TASKS_MAX + 1 },
        { $project: TASK_FIELDS },
      ])
      .toArray(),
    // Header counts (VEC-364) only when the admin opted into public statistics.
    f.project.publicAccess?.showStats ? projectStats(f.project) : null,
  ]);
  const view: PublicProjectView = {
    org: { name: f.org.name, slug: f.org.slug },
    project: { name: f.project.name, key: f.project.key, color: f.project.color },
    statuses: statuses.map(toPublicStatus),
    submitStatuses: allowed.map((id) => byId.get(id)!).filter(Boolean),
    showComments: !!f.project.publicAccess?.showComments,
    tasks: await shapeAll(docs.slice(0, PUBLIC_TASKS_MAX)),
    truncated: docs.length > PUBLIC_TASKS_MAX,
    stats: stats && { open: stats.open, inProgress: stats.inProgress, done: stats.done, total: stats.total },
  };
  return { available: true, view };
}

export type PublicTaskResult =
  | {
      available: true;
      task: PublicTask;
      comments: PublicComment[] | null;
      /** VEC-409: the request a sub-task was filed under, when it's visible here (same project, unarchived). */
      parent: { key: string; title: string } | null;
      /** VEC-409: its unarchived sub-tasks in this project, by number (at most PUBLIC_SUBTASKS_MAX). */
      subtasks: PublicSubtask[];
    }
  | { available: false };

/**
 * One task of a public project (`taskKey` like "VEC-12"): null unless the project is public and the task is one of
 * its non-archived tasks (a task moved to another project is gone from here). `comments` is null unless the project
 * shows comments; authors are display names only. A sub-task opens by its key too and links back to its `parent`;
 * a request lists its `subtasks` (key, title, status only).
 */
export async function loadPublicTask(slug: unknown, key: unknown, taskKey: unknown): Promise<PublicTaskResult | null> {
  const f = await findPublicProject(slug, key);
  if (!f) return null;
  if (!f.available) return { available: false };
  const m = typeof taskKey === "string" ? /^([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,9})$/.exec(taskKey.trim()) : null;
  if (!m || m[1].toUpperCase() !== f.project.key) return null;
  const c = await cols();
  const doc = await c.tasks.findOne({ orgId: f.project.orgId, projectId: f.project._id, number: Number(m[2]), archivedAt: null }, { projection: TASK_FIELDS });
  if (!doc) return null;
  const [{ shape, statuses, byId }, parentDoc, subDocs] = await Promise.all([
    viewParts(f),
    doc.parentId
      ? c.tasks.findOne({ _id: doc.parentId, orgId: f.project.orgId, projectId: f.project._id, archivedAt: null }, { projection: { number: 1, title: 1 } })
      : null,
    c.tasks
      .find({ orgId: f.project.orgId, projectId: f.project._id, archivedAt: null, parentId: doc._id }, { projection: { number: 1, title: 1, statusId: 1 } })
      .sort({ number: 1 })
      .limit(PUBLIC_SUBTASKS_MAX)
      .toArray(),
  ]);
  const progress = subDocs.length ? (await childProgress(f.project, [doc._id], statuses)).get(doc._id.toHexString()) : null;
  let comments: PublicComment[] | null = null;
  if (f.project.publicAccess?.showComments) {
    const list = await c.comments.find({ orgId: f.project.orgId, taskId: doc._id }, { projection: { authorId: 1, body: 1, createdAt: 1 } }).sort({ createdAt: 1 }).limit(PUBLIC_COMMENTS_MAX).toArray();
    const dir = list.length ? await loadDirectory(f.project.orgId) : null;
    const nameOf = (id: string) => (dir ? personName(dir, id) : undefined);
    comments = list.map((cm) => shapePublicComment(cm, nameOf));
  }
  return {
    available: true,
    task: shape(doc, progress),
    comments,
    parent: parentDoc ? { key: `${f.project.key}-${parentDoc.number}`, title: parentDoc.title } : null,
    subtasks: subDocs.map((d) => shapePublicSubtask(d, f.project.key, byId)),
  };
}

/**
 * The signed-in account's own submissions to a public project (non-archived, still in this project), newest first,
 * with their sub-task progress. Null when the project isn't public or is unavailable.
 */
export async function listMyPublicSubmissions(user: Pick<UserDoc, "_id">, slug: unknown, key: unknown): Promise<PublicTask[] | null> {
  const f = await findPublicProject(slug, key);
  if (!f || !f.available) return null;
  const c = await cols();
  const { shapeAll } = await viewParts(f);
  const docs = await c.tasks
    .find({ orgId: f.project.orgId, projectId: f.project._id, archivedAt: null, "source.kind": "public", "source.userId": user._id }, { projection: TASK_FIELDS })
    .sort({ createdAt: -1 })
    .limit(PUBLIC_TASKS_MAX)
    .toArray();
  return shapeAll(docs);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The stored upload name the public image route may serve for `file` (the name without its org prefix, see
 * publicImagePath), or null: the project is public and available, and a non-archived task of the project references
 * `<orgId>-<file>` in its description. Only this org's task uploads can match (never an avatar or another org's).
 */
export async function publicImageName(slug: unknown, key: unknown, file: unknown): Promise<string | null> {
  if (typeof file !== "string" || !PUBLIC_UPLOAD_FILE.test(file)) return null;
  const f = await findPublicProject(slug, key);
  if (!f || !f.available) return null;
  const name = `${f.org._id.toHexString()}-${file}`;
  const c = await cols();
  const hitDoc = await c.tasks.findOne(
    { orgId: f.project.orgId, projectId: f.project._id, archivedAt: null, description: { $regex: `src="/api/uploads/${escapeRe(name)}"` } },
    { projection: { _id: 1 } },
  );
  return hitDoc ? name : null;
}

/* ---------------- public stats (VEC-363) ---------------- */

export type PublicStatsResult =
  | { ok: true; project: { key: string; name: string }; stats: PublicProjectStats }
  | { ok: false; status: 404 }
  | { ok: false; status: 429; retryAfter: number };

/**
 * Task counts of a public project for the stats and shields.io badge routes. Served only when the project is public,
 * not archived, its org isn't locked (plan feature) and `publicAccess.showStats` is on; anything else is a bare 404,
 * like the public page. Rate limited per client IP per project. One aggregation over the project's non-archived
 * top-level tasks (VEC-409: a request with 10 sub-tasks counts once; grouped by status + type, nothing else read),
 * with stages from the project's statuses.
 */
export async function loadPublicStats(slug: unknown, key: unknown, ip: string): Promise<PublicStatsResult> {
  const f = await findPublicProject(slug, key);
  if (!f || !f.available || !f.project.publicAccess?.showStats) return { ok: false, status: 404 };
  const wait = await hit(`public-stats:${ipKey(ip)}:${f.project._id.toHexString()}`, PUBLIC_STATS_RATE_LIMIT);
  if (wait !== null) return { ok: false, status: 429, retryAfter: wait };
  return { ok: true, project: { key: f.project.key, name: f.project.name }, stats: await projectStats(f.project) };
}

/** One $group aggregation (status + type) over a project's non-archived top-level tasks, counted by stage. No rate limit. */
async function projectStats(project: ProjectRef): Promise<PublicProjectStats> {
  const c = await cols();
  const [groups, statuses] = await Promise.all([
    c.tasks
      .aggregate<{ _id: { statusId: ObjectId; type: string }; count: number }>([
        { $match: { orgId: project.orgId, projectId: project._id, archivedAt: null } },
        ...topLevelStages(project),
        { $group: { _id: { statusId: "$statusId", type: "$type" }, count: { $sum: 1 } } },
      ])
      .toArray(),
    loadStatuses(project.orgId, project._id),
  ]);
  const stageOf = new Map(statuses.map((s) => [s._id.toHexString(), s.category]));
  const rows: StatsRow[] = groups.map((g) => ({ stage: stageOf.get(String(g._id.statusId)) ?? null, type: g._id.type, count: g.count }));
  return computeStats(rows);
}

/* ---------------- submitting ---------------- */


/** A refusal because the account submitted too much; `retryAfter` in seconds. */
export class PublicRateLimitError extends UserError {
  constructor(readonly retryAfter: number) {
    super(`You've submitted a lot of tickets here. Try again in ${waitText(retryAfter)}.`);
    this.name = "PublicRateLimitError";
  }
}

export interface PublicSubmission {
  title: unknown;
  /**
   * The rich editor's HTML. Sanitised with the public allow-list; images survive only when they're this account's
   * pending uploads to this project (`uploadPublicProjectImage`, VEC-356).
   */
  description?: unknown;
  type?: unknown;
  /** One of the project's submit statuses; empty = the first one. */
  statusId?: unknown;
}

/**
 * A signed-in account (any, membership not needed) files a ticket into a public project. Re-reads the project (still
 * public, unarchived, plan feature), checks the status is allowed, validates and sanitises before counting the
 * submission against the per-account and per-project rate limits, then creates the task through createTaskAs, so the
 * normal create path runs (task.upsert, flow owner wake-ups, a Triage destination reaches the triage bots). The
 * creator is the project id and provenance is `source: {kind: "public", userId, userName}`. Throws UserError
 * (an unavailable project says PUBLIC_UNAVAILABLE; PublicRateLimitError when over the limit).
 */
export async function createTaskFromPublicProject(user: Pick<UserDoc, "_id" | "name">, projectRef: Pick<ProjectDoc, "_id" | "orgId">, input: PublicSubmission): Promise<Task> {
  if (!user?._id) throw new UserError("Sign in to submit a ticket.");
  const c = await cols();
  const project = await c.projects.findOne({ _id: projectRef._id, orgId: projectRef.orgId }, { projection: { _id: 1, orgId: 1, archivedAt: 1, publicAccess: 1 } });
  if (!project || project.archivedAt || !project.publicAccess?.enabled) throw new UserError("This project isn't public.");
  if (!(await hasFeature(project.orgId, "publicForms"))) throw new UserError(PUBLIC_UNAVAILABLE);
  // Shape and size first (shared intake core, VEC-356): bad input never spends rate limit.
  const named = normalizeTitle(input.title);
  if (!named.ok) throw new UserError(named.error);
  const typed = resolveType(input.type, TASK_TYPES, "issue");
  if (!typed.ok) throw new UserError(typed.error);
  const prep = prepareDescription(input.description, { rich: true, allowImages: true });
  if (!prep.ok || !prep.rich) throw new UserError(prep.ok ? INTAKE_ERRORS.descriptionNotText : prep.error);
  const statuses = await loadStatuses(project.orgId, project._id);
  const allowed = pruneSubmitStatuses((project.publicAccess.submitStatusIds ?? []).map((id) => id.toHexString()), statuses.map(statusLike));
  const pick = resolveStatus(input.statusId, allowed);
  if (!pick.ok) throw new UserError(pick.error);
  const pid = project._id.toHexString();
  const wait = (await hit(`public-user:${user._id.toHexString()}:${pid}`, PUBLIC_RATE_LIMITS.userProject)) ?? (await hit(`public-project:${pid}`, PUBLIC_RATE_LIMITS.project));
  if (wait !== null) throw new PublicRateLimitError(wait);
  // Images survive only when they're this account's own pending uploads to this project; every other source is dropped.
  const owner: UploadOwner = { kind: "public", id: project._id, userId: user._id };
  const pending = prep.sources.length ? await pendingUploads(owner, prep.sources) : [];
  const byUrl = new Map(pending.map((u) => [u.url, u._id]));
  const description = publicSanitize(prep.html, { allowImages: byUrl.size > 0, imageAllowed: (src) => byUrl.has(src) });
  const claim = [...new Set(imageSources(description))].map((u) => byUrl.get(u)).filter((id): id is ObjectId => !!id);
  const userName = String(user.name ?? "").trim().slice(0, SUBMITTER_NAME_MAX) || "Aimpoint user";
  const actor: Actor = { orgId: project.orgId, id: project._id, isAdmin: false, isBot: false, name: userName };
  const task = await createTaskAs(
    actor,
    { title: named.title, projectId: pid, type: typed.type, statusId: pick.id, description },
    { source: { kind: "public", userId: user._id, userName }, createdNote: { note: "public", to: userName } },
  );
  // The task exists: its images are kept from now on. Unreferenced uploads stay pending and expire.
  if (claim.length) await claimUploads(owner, claim, new ObjectId(task.id)).catch((err) => console.error("[public submit] claiming uploads", err));
  return task;
}

/**
 * Image upload for a public project's submit form (VEC-356): what `POST /api/public/<org>/<KEY>/uploads` does. The
 * same pending-upload mechanism as forms (lib/form-uploads.ts), owned by the project and the signed-in account: only
 * that account's next submission to this project can use it. Needs a signed-in account (401), a public, available
 * project (404 / 403), and is rate limited per account per project and per project (PUBLIC_UPLOAD_RATE_LIMITS).
 */
export async function uploadPublicProjectImage(
  user: Pick<UserDoc, "_id"> | null,
  slug: unknown,
  key: unknown,
  req: Request,
  ip: string,
): Promise<UploadResult | { ok: false; status: 401; error: string }> {
  if (!user) return { ok: false, status: 401, error: "Sign in to add images." };
  const f = await findPublicProject(slug, key);
  if (!f) return { ok: false, status: 404, error: "This project doesn't exist or isn't public." };
  if (!f.available) return { ok: false, status: 403, error: PUBLIC_UNAVAILABLE };
  const pid = f.project._id.toHexString();
  const uid = user._id.toHexString();
  return receivePendingImage(req, {
    owner: { kind: "public", id: f.project._id, userId: user._id },
    orgId: f.project.orgId,
    ipHash: ipKey(ip),
    limits: [
      [`up-public-user:${uid}:${pid}`, PUBLIC_UPLOAD_RATE_LIMITS.userProject],
      [`up-public-project:${pid}`, PUBLIC_UPLOAD_RATE_LIMITS.project],
    ],
  });
}

export type PublicSubmitResult = { ok: true; key: string } | { ok: false; status: 400 | 401 | 403 | 404 | 429; error: string; retryAfter?: number };

/** createTaskFromPublicProject by org slug + project key, answering with the new key or a short error (pages, routes). */
export async function submitPublicTicket(user: Pick<UserDoc, "_id" | "name"> | null, slug: unknown, key: unknown, input: PublicSubmission): Promise<PublicSubmitResult> {
  if (!user) return { ok: false, status: 401, error: "Sign in to submit a ticket." };
  const f = await findPublicProject(slug, key);
  if (!f) return { ok: false, status: 404, error: "This project doesn't exist or isn't public." };
  if (!f.available) return { ok: false, status: 403, error: PUBLIC_UNAVAILABLE };
  try {
    const task = await createTaskFromPublicProject(user, f.project, input);
    return { ok: true, key: task.key };
  } catch (err) {
    if (err instanceof PublicRateLimitError) return { ok: false, status: 429, error: err.message, retryAfter: err.retryAfter };
    if (err instanceof UserError) {
      if (err.message === "This project isn't public.") return { ok: false, status: 404, error: "This project doesn't exist or isn't public." };
      if (err.message === PUBLIC_UNAVAILABLE) return { ok: false, status: 403, error: err.message };
      return { ok: false, status: 400, error: err.message };
    }
    throw err;
  }
}
