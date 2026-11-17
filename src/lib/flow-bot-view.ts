import "server-only";
import type { ObjectId } from "mongodb";
import { loadFlowDirectory, resolveOrgFlows } from "@/lib/flows";
import { flowBriefing, loadTaskFlow, ownerName } from "@/lib/flow-engine";
import { flowIsActive, nextStepOf, stepIndex } from "@/lib/flow-engine-core";
import type { FlowDirectory, ResolvedFlow, ResolvedStep } from "@/lib/flow-model";
import type { TaskDoc } from "@/lib/types";

/**
 * What bots see of flows (VEC-176, docs/flows.md section 6): the same JSON in MCP get_task / check_for_work / wake-up
 * payloads (task context `flow`), REST `GET /api/v1/tasks/{key}` (top-level `flow`), and per project in get_workspace,
 * `GET /api/v1/projects` and `GET /api/v1/flows`. Read-only views over the resolved flow; the engine decides moves.
 * (The task UI's slimmer copy is lib/flow-view.ts, VEC-178.)
 */

export interface BotFlowOwner {
  /** bot / person = that one; triage = any triage bot; keep = whoever has the task; none = nobody (a pool or a wait). */
  kind: ResolvedStep["owner"]["kind"];
  id: string | null;
  /** Readable: the bot's or person's name, "any triage bot", "its current assignee" or "nobody (anyone can pick it up)". */
  name: string;
}

export interface BotFlowStep {
  id: string;
  name: string;
  /** The status the task sits in during this step (one of the project's own statuses) and its stage. */
  status: string;
  stage: string;
  owner: BotFlowOwner;
  /** complete = its owner hands it on with complete_task (no status); wait = it waits for an outside event (advance_task); manual = a person moves it on. */
  advance: ResolvedStep["advance"];
  /** A bot can't jump past a required step (Done included); people can. */
  required: boolean;
  instructions: string;
  /** Wait steps only: what it waits for and which bots (besides the owner) may resolve it with advance_task. */
  wait: { label: string; resolvers: string[]; remindAfterDays: number | null } | null;
  /** Jump target (a step id) instead of the next step in order, or null. */
  next: string | null;
}

export interface BotProjectFlow {
  /** "project" = the project's own flow, "org" = the organisation default. */
  source: ResolvedFlow["source"];
  version: number;
  /** False when no step names an owner or carries instructions (the seeded default): bots then finish with a status as usual. */
  active: boolean;
  steps: BotFlowStep[];
  /** Steps of the flow that don't apply in this project (e.g. it has no status of that stage). */
  skipped: { name: string; why: string }[];
}

const ownerOut = (dir: FlowDirectory, s: ResolvedStep): BotFlowOwner => ({ kind: s.owner.kind, id: s.owner.id ?? null, name: ownerName(dir, s) });

export function botFlowStep(dir: FlowDirectory, s: ResolvedStep): BotFlowStep {
  return {
    id: s.id,
    name: s.name,
    status: s.status.name,
    stage: s.status.category,
    owner: ownerOut(dir, s),
    advance: s.advance,
    required: s.required,
    instructions: s.instructions.trim(),
    wait: s.wait
      ? { label: s.wait.label, resolvers: (s.wait.resolvers ?? []).map((id) => dir.bots.get(id) ?? id), remindAfterDays: s.wait.remindAfterDays ?? null }
      : null,
    next: s.next,
  };
}

export function botProjectFlow(flow: ResolvedFlow, dir: FlowDirectory): BotProjectFlow {
  return {
    source: flow.source,
    version: flow.version,
    active: flow.steps.some((s) => flowIsActive(flow, s)),
    steps: flow.steps.map((s) => botFlowStep(dir, s)),
    skipped: flow.skipped.map((s) => ({ name: s.name, why: s.issues.map((i) => i.message).join(" ") })),
  };
}

/** Every project's resolved flow, keyed by project id hex (null = the project switched flows off). */
export async function botOrgFlows(orgId: ObjectId): Promise<Map<string, BotProjectFlow | null>> {
  const [flows, dir] = await Promise.all([resolveOrgFlows(orgId), loadFlowDirectory(orgId)]);
  return new Map([...flows].map(([id, f]) => [id, f && f.steps.length ? botProjectFlow(f, dir) : null]));
}

export interface BotTaskFlow {
  source: ResolvedFlow["source"];
  version: number;
  /** The flow drives this task: its step or the next names an owner or carries instructions. False on the seeded default. */
  active: boolean;
  /** Paused (a triage umbrella waiting on its sub-tasks, or switched off for this task): Vector treats it as if there were no flow. */
  paused: boolean;
  /** Its status isn't any step's (e.g. Cancelled): it re-joins the flow on a status change into a step's status. */
  detached: boolean;
  /** The step it's at, with its position (1-based) in the flow. */
  step: (BotFlowStep & { number: number; of: number }) | null;
  /** Where complete_task without a status sends it and who gets it there. Null at the last step, or when the flow isn't active. */
  next: { id: string; name: string; status: string; stage: string; owner: BotFlowOwner } | null;
  /** Who has the task now (its assignee's name), null = nobody. */
  holder: string | null;
  /** How to finish this step: complete_task without a status, advance_task for a wait, or as usual. */
  howToFinish: string;
  /** The whole pipeline, with where the task is. */
  steps: { id: string; name: string; status: string; owner: string; current: boolean; passed: boolean }[];
}

const PAUSED_FINISH = "Its flow is paused, so finish it as if there were no flow: complete_task with the status it should end in.";
const QUIET_FINISH =
  "This project's flow names no owners or instructions here, so finish as usual: complete_task with Done (a done-stage status releases the tasks waiting on it), or a review status only when a named person must check something. Without a status nothing moves.";

/** The task's place in its project's flow. Null when its project has no flow (flows off). */
export async function botTaskFlow(task: TaskDoc, projectKey: string, holder: string | null): Promise<BotTaskFlow | null> {
  const ctx = await loadTaskFlow(task);
  if (!ctx) return null;
  const { flow, dir } = ctx;
  const paused = !!task.flow?.paused;
  const current = paused ? null : ctx.current;
  const at = current ? stepIndex(flow, current.id) : -1;
  const next = current ? nextStepOf(flow, current) : null;
  const active = !!current && flowIsActive(flow, current);
  const briefing = active ? await flowBriefing(task, projectKey, ctx) : null;
  const howToFinish = paused
    ? PAUSED_FINISH
    : !current
      ? "It isn't at any step of its flow right now (its status belongs to none), so finish as usual: complete_task with the status it should end in."
      : current.status.category === "done"
        ? "It's at the last step (done). Nothing to hand on."
        : (briefing?.finish ?? QUIET_FINISH);
  return {
    source: flow.source,
    version: flow.version,
    active,
    paused,
    detached: !paused && !current,
    step: current ? { ...botFlowStep(dir, current), number: at + 1, of: flow.steps.length } : null,
    next: next && active ? { id: next.id, name: next.name, status: next.status.name, stage: next.status.category, owner: ownerOut(dir, next) } : null,
    holder,
    howToFinish,
    steps: flow.steps.map((s, i) => ({ id: s.id, name: s.name, status: s.status.name, owner: ownerName(dir, s), current: i === at, passed: at >= 0 && i < at })),
  };
}
