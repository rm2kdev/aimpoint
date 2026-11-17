import "server-only";
import { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { UserError } from "@/lib/result";
import { loadStatuses } from "@/lib/statuses";
import { loadFlowDirectory, resolveFlow } from "@/lib/flows";
import {
  flowIsActive,
  locateStep,
  moveNote,
  nextStepOf,
  ownerPlan,
  requiredBetween,
  stepById,
  stepIndex,
  syncByStatus,
  workingStatus,
  type FlowMoveNote,
} from "@/lib/flow-engine-core";
import type { FlowDirectory, FlowStatusLike, ResolvedFlow, ResolvedStep } from "@/lib/flow-model";
import type { StatusDoc, TaskDoc, TaskFlowState } from "@/lib/types";

/**
 * The flow engine (VEC-175, docs/flows.md section 5). It never writes on its own: task-service asks it what a write
 * means for the task's flow (planFlowForUpdate / planFlowForCreate), applies the answer in the same task write, and
 * hands the task over through the existing paths (resetClaimOnAssign, announceAssignment -> wakeBots -> wake queue,
 * notify). So claims, close-outs, stalled notices, dependency bookkeeping and publish order stay exactly as they are.
 *
 * Rules, in short:
 * - A bot's complete_task without a status advances the task to the next step (advanceTarget), assigning that
 *   step's owner. An explicit status (complete_task / set_status / a person's edit) always wins: the task goes
 *   exactly there and the flow re-positions to the step of that status (sync), applying its owner; an explicit
 *   assignee in the same write wins over the owner. A status no step uses leaves the flow (detached).
 * - "keep" / "any triage bot" owners and the done step never change the assignee; "keep" steps wake nobody.
 * - Bots can't skip a required later step (Done included); people may. Triagers are exempt.
 * - A triage umbrella (it left Triage waiting on the sub-tasks it was split into) pauses its flow.
 * - Paused tasks and projects with flows off behave exactly as without flows.
 */

const hex = (id: ObjectId) => id.toHexString();
const toLike = (s: StatusDoc): FlowStatusLike => ({ id: hex(s._id), name: s.name, category: s.category, order: s.order });

export interface TaskFlowContext {
  flow: ResolvedFlow;
  statuses: FlowStatusLike[];
  dir: FlowDirectory;
  /** The task's status in this project (null if it isn't one of the project's, e.g. mid project move). */
  status: FlowStatusLike | null;
  /** Its step (recorded, else located by status). */
  current: ResolvedStep | null;
}

type FlowTask = Pick<TaskDoc, "orgId" | "projectId" | "statusId"> & { flow?: TaskFlowState | null };

/** The task's flow and position. Null when its project has no flow (flows off). */
export async function loadTaskFlow(task: FlowTask, opts: { ignoreRecorded?: boolean } = {}): Promise<TaskFlowContext | null> {
  const [statusDocs, dir] = await Promise.all([loadStatuses(task.orgId, task.projectId), loadFlowDirectory(task.orgId)]);
  const flow = await resolveFlow({ _id: task.projectId, orgId: task.orgId }, { statuses: statusDocs, dir });
  if (!flow || !flow.steps.length) return null;
  const statuses = statusDocs.map(toLike);
  const status = statuses.find((s) => s.id === hex(task.statusId)) ?? null;
  const current = status ? locateStep(flow, status, opts.ignoreRecorded ? null : task.flow?.stepId) : null;
  return { flow, statuses, dir, status, current };
}

/** Any step names an owner or carries instructions: hand-offs get logged and explained. The seeded default doesn't. */
const flowActive = (flow: ResolvedFlow) => flow.steps.some((s) => flowIsActive(flow, s));

export const ownerName = (dir: FlowDirectory, step: ResolvedStep) =>
  step.owner.kind === "bot" || step.owner.kind === "person"
    ? ((step.owner.kind === "bot" ? dir.bots : dir.people).get(step.owner.id ?? "") ?? "its owner")
    : step.owner.kind === "triage"
      ? "any triage bot"
      : step.owner.kind === "keep"
        ? "its current assignee"
        : "nobody (anyone can pick it up)";

const position = (flow: ResolvedFlow, step: ResolvedStep | null, extra: Partial<TaskFlowState> = {}): TaskFlowState => ({
  stepId: step?.id ?? null,
  source: flow.source,
  version: flow.version,
  enteredAt: new Date(),
  ...extra,
});

/** The flow_step activity a write records (from/to = step names). */
export interface FlowActivity {
  from: string | null;
  to: string;
  note: FlowMoveNote;
  /** Name of the status the step sits in. */
  status: string;
  /** Who it was handed to (hex), null = nobody. */
  owner: string | null;
}

/** A hand-over the caller makes after the write. */
export interface FlowHandoff {
  fromStep: string | null;
  toStep: string;
  ownerKind: "bot" | "person";
  ownerId: ObjectId;
  /** The owner already had the task (the same bot/person owns both steps): no assignee change, hand over anyway. */
  sameOwner: boolean;
}

export interface FlowPlan {
  /** New `task.flow` (undefined = leave it). */
  flow?: TaskFlowState | null;
  /** The step owner the flow assigns (undefined = leave the assignee as the write has it). */
  assigneeId?: ObjectId | null;
  activity?: FlowActivity;
  handoff?: FlowHandoff;
}

export interface FlowUpdateInput {
  actor: { orgId: ObjectId; id: ObjectId; isBot?: boolean };
  before: TaskDoc;
  /** The project the task is in after the write. */
  projectId: ObjectId;
  /** Its status after the write. */
  status: StatusDoc;
  statusChanged: boolean;
  projectMoved: boolean;
  /** The write sets the assignee explicitly. */
  explicitAssignee: boolean;
  /** The assignee after the write (before any flow owner). */
  assigneeAfter: ObjectId | null;
  /** `waitingOn` after the write. */
  waitingAfter: ObjectId[];
  /** complete_task without a status: go to this step. */
  advanceTo?: string;
  isTriaging: () => Promise<boolean>;
}

/**
 * What a task write means for the task's flow. Called inside updateTaskAs before its single write; throws a
 * UserError when a bot tries to skip a required step.
 */
export async function planFlowForUpdate(input: FlowUpdateInput): Promise<FlowPlan> {
  const { before, actor } = input;
  const touchesPosition = input.statusChanged || input.projectMoved || !!input.advanceTo;
  if (!touchesPosition) {
    // Assignee change only: the step stays, the flow assigns again on the next advance.
    if (input.explicitAssignee && before.flow?.stepId && !before.flow.paused && !before.flow.ownerOverride) {
      return { flow: { ...before.flow, ownerOverride: true } };
    }
    return {};
  }
  const ctx = await loadTaskFlow({ orgId: before.orgId, projectId: input.projectId, statusId: input.status._id, flow: input.projectMoved ? null : before.flow });
  if (!ctx) return {};
  const { flow, statuses, dir } = ctx;
  const statusAfter = toLike(input.status);
  const paused = !!before.flow?.paused && !input.projectMoved;
  // Paused: the flow is out of the way until the task re-enters Triage (a fresh start) or is resumed.
  if (paused && statusAfter.category !== "triage") return {};

  // Where it was. After a project move it starts afresh in the destination's flow.
  const beforeStatus = statuses.find((s) => s.id === hex(before.statusId)) ?? null;
  const current = input.projectMoved || paused || !beforeStatus ? null : locateStep(flow, beforeStatus, before.flow?.stepId);

  let target: ResolvedStep | null;
  if (input.advanceTo) {
    target = stepById(flow, input.advanceTo);
    if (!target) return {};
  } else {
    const r = syncByStatus({ flow, current, status: statusAfter });
    if (r.kind === "detach") return before.flow?.stepId || before.flow === undefined ? { flow: position(flow, null) } : {};
    if (r.kind === "stay") return before.flow?.stepId === current?.id && !paused ? {} : { flow: position(flow, current) };
    target = r.step;
  }

  // A project move only re-positions: nobody is reassigned or woken by moving a task between projects.
  if (input.projectMoved && !input.statusChanged && !input.advanceTo) return { flow: position(flow, target) };

  const triaging = actor.isBot ? await input.isTriaging() : false;
  const triager = triaging || (!!actor.isBot && !!before.triagedBy?.equals(actor.id));

  // Bots can't jump over a required step (Done included); people may. Triagers keep today's freedom.
  if (actor.isBot && !triager && current && !input.advanceTo && stepIndex(flow, target.id) > stepIndex(flow, current.id)) {
    const skipped = requiredBetween(flow, current, target);
    if (skipped.length) {
      const s = skipped[0];
      const who = s.owner.kind === "bot" || s.owner.kind === "person" ? ` (${ownerName(dir, s)})` : "";
      throw new UserError(
        `${s.name}${who} still has to run before ${target.status.name}: it's a required step of this project's flow. Call complete_task without a status to hand it on to ${s.name}, or ask a person to move it.`,
      );
    }
  }

  const note = input.advanceTo ? moveNote(flow, current, target) : current ? moveNote(flow, current, target) : "synced";
  const fromName = current?.name ?? null;

  // A triage umbrella: split into sub-tasks it now waits on. Its flow pauses; the triager closes it out as today.
  if (current?.status.category === "triage" && target.status.category !== "triage" && input.waitingAfter.length && triager) {
    return {
      flow: position(flow, target, { paused: true }),
      ...(flowActive(flow) ? { activity: { from: fromName, to: target.name, note: "umbrella" as const, status: target.status.name, owner: input.assigneeAfter ? hex(input.assigneeAfter) : null } } : {}),
    };
  }

  let assigneeId: ObjectId | null | undefined;
  let ownerOverride = false;
  const plan = ownerPlan(target);
  if (input.explicitAssignee) {
    ownerOverride = true; // explicit beats flow
  } else if (current?.status.category === "triage" && input.assigneeAfter) {
    ownerOverride = true; // assigned during triage: the triager (or creator) decided who does it
  } else if (plan.kind === "set") {
    const next = plan.id ? new ObjectId(plan.id) : null;
    if ((next ? hex(next) : null) !== (input.assigneeAfter ? hex(input.assigneeAfter) : null)) assigneeId = next;
  }
  const ownerAfter = assigneeId !== undefined ? assigneeId : input.assigneeAfter;
  const named = target.owner.kind === "bot" || target.owner.kind === "person";
  const handoff: FlowHandoff | undefined =
    !ownerOverride && named && ownerAfter && target.status.category !== "done"
      ? { fromStep: fromName, toStep: target.name, ownerKind: target.owner.kind as "bot" | "person", ownerId: ownerAfter, sameOwner: assigneeId === undefined }
      : undefined;
  return {
    flow: position(flow, target, ownerOverride ? { ownerOverride: true } : {}),
    ...(assigneeId !== undefined ? { assigneeId } : {}),
    ...(flowActive(flow) || handoff ? { activity: { from: fromName, to: target.name, note, status: target.status.name, owner: ownerAfter ? hex(ownerAfter) : null } } : {}),
    ...(handoff ? { handoff } : {}),
  };
}

/** A new task enters its project's flow at the step of its status; the step owner applies unless it was given an assignee. */
export async function planFlowForCreate(orgId: ObjectId, projectId: ObjectId, status: StatusDoc, assigneeGiven: boolean): Promise<FlowPlan> {
  const ctx = await loadTaskFlow({ orgId, projectId, statusId: status._id, flow: null });
  if (!ctx) return {};
  const { flow } = ctx;
  const step = ctx.current;
  if (!step) return { flow: position(flow, null) };
  const plan = ownerPlan(step);
  const assigneeId = !assigneeGiven && plan.kind === "set" && plan.id ? new ObjectId(plan.id) : undefined;
  const named = step.owner.kind === "bot" || step.owner.kind === "person";
  const handoff: FlowHandoff | undefined =
    assigneeId && named ? { fromStep: null, toStep: step.name, ownerKind: step.owner.kind as "bot" | "person", ownerId: assigneeId, sameOwner: false } : undefined;
  return {
    flow: position(flow, step, assigneeGiven && named ? { ownerOverride: true } : {}),
    ...(assigneeId ? { assigneeId } : {}),
    ...(handoff ? { activity: { from: null, to: step.name, note: "synced" as const, status: step.status.name, owner: hex(assigneeId!) } } : {}),
    ...(handoff ? { handoff } : {}),
  };
}

/** What complete_task without a status does on this task. */
export type AdvanceTarget =
  /** Hand it to the next step: move to `statusId` (unchanged when the next step shares the status). */
  | { kind: "advance"; from: ResolvedStep; to: ResolvedStep; statusChanges: boolean }
  /** A wait step: it moves on when what it waits for happens (advance_task / a person), not on complete_task. */
  | { kind: "wait"; step: ResolvedStep }
  /** No flow, paused, detached, or already at the last step: today's behaviour (the claim is finished, nothing moves). */
  | { kind: "none" };

export async function advanceTarget(task: TaskDoc): Promise<AdvanceTarget> {
  if (task.flow?.paused) return { kind: "none" };
  const ctx = await loadTaskFlow(task);
  if (!ctx?.current || !ctx.status) return { kind: "none" };
  if (ctx.status.category === "done" || ctx.status.category === "cancelled") return { kind: "none" };
  const from = ctx.current;
  if (from.advance === "wait") return { kind: "wait", step: from };
  // A flow that says nothing here (the seeded default: keep owners, no instructions) moves nothing on complete_task,
  // as before flows (VEC-176): otherwise Build -> its optional Review step would park every finished task in In Review.
  if (!flowIsActive(ctx.flow, from)) return { kind: "none" };
  const to = nextStepOf(ctx.flow, from);
  if (!to) return { kind: "none" };
  return { kind: "advance", from, to, statusChanges: to.status.id !== ctx.status.id };
}

/**
 * The task sits at a wait step of its flow (design 5.7, VEC-181): a bot handed it is told once with the wait
 * instructions and its claim is done straight away, so it isn't shown as working (nor as "finished" Stalled) while
 * the task waits. Paused flows and closed statuses don't count.
 */
export async function atWaitStep(task: FlowTask, loaded?: TaskFlowContext | null): Promise<boolean> {
  if (task.flow?.paused) return false;
  const ctx = loaded !== undefined ? loaded : await loadTaskFlow(task);
  if (!ctx?.current || !ctx.status) return false;
  if (ctx.status.category === "done" || ctx.status.category === "cancelled" || ctx.status.category === "triage") return false;
  return ctx.current.advance === "wait";
}

/**
 * Where a bot's pickup moves a flow task (design 5.4). `legacy`: no flow / not on a step, use the old rule (first
 * started status). `stay`: leave the status alone (the step already sits in a started status). `move`: go here.
 */
export async function pickupTarget(task: FlowTask): Promise<{ kind: "legacy" } | { kind: "stay" } | { kind: "move"; statusId: ObjectId }> {
  if (task.flow?.paused) return { kind: "legacy" };
  const ctx = await loadTaskFlow(task);
  if (!ctx?.current || !ctx.status) return { kind: "legacy" };
  const target = workingStatus(ctx.flow, ctx.current, ctx.statuses);
  if (!target) return { kind: "stay" };
  // Only from the step's own (not started) status, or another not-started one; never back from a started status.
  if (ctx.status.category !== "backlog" && ctx.status.category !== "unstarted") return { kind: "stay" };
  return target.id === ctx.status.id ? { kind: "stay" } : { kind: "move", statusId: new ObjectId(target.id) };
}

/* ---------------- what the owner is told (wake-up prompt, webhook, check_for_work) ---------------- */

export interface FlowBriefing {
  /** Paragraph for the prompt: the step, its instructions, how to hand it on. */
  text: string;
  /** Replaces the generic "finish with complete_task and Done" sentence. */
  finish: string;
  /** The status pickup leaves it in (a started-stage step), or null when pickup moves it as usual. */
  stays: string | null;
  /** For webhook payloads and tool replies. */
  payload: {
    step: { id: string; name: string; status: string; owner: string; instructions: string; advance: string; number: number; of: number };
    next: { id: string; name: string; status: string; owner: string } | null;
  };
}

/** The briefing for whoever holds the task's current step; null when the flow has nothing to say (no flow, paused, the default). */
export async function flowBriefing(task: TaskDoc, projectKey: string, loaded?: TaskFlowContext | null): Promise<FlowBriefing | null> {
  if (task.flow?.paused) return null;
  const ctx = loaded !== undefined ? loaded : await loadTaskFlow(task);
  const step = ctx?.current;
  if (!ctx || !step || step.status.category === "done" || !flowIsActive(ctx.flow, step)) return null;
  const { flow, dir } = ctx;
  const i = stepIndex(flow, step.id);
  const next = nextStepOf(flow, step);
  const instructions = step.instructions.trim();
  const later = flow.steps.slice(i + 1).filter((s) => s.required && s.status.category !== "done");
  let finish: string;
  if (step.advance === "wait") {
    finish = `This step waits for "${step.wait?.label ?? "an outside event"}": it moves on when that happens, not when you call complete_task. When it has happened, call advance_task with a comment saying what happened (the step owner and its resolver bots may), or a person moves it on. While it waits you aren't counted as working on it: Vector marks your part done as soon as it's handed to you, so there's nothing to complete_task.`;
  } else if (!next) {
    finish = "Finish with complete_task.";
  } else if (next.status.category === "done") {
    finish = `When your part is done, call complete_task without a status: that closes it as ${next.status.name} and releases the tasks waiting on it.`;
  } else {
    finish = `When your part is done, call complete_task without a status: that moves it to ${next.status.name} and hands it to ${ownerName(dir, next)} for the ${next.name} step. To send it back to an earlier step, pass that step's status (say what failed in the comment).${
      later.length ? ` Don't pass a done status: ${later.map((s) => s.name).join(", ")} still ${later.length === 1 ? "has" : "have"} to run.` : ""
    }`;
  }
  const text = `This task is at step ${i + 1} of ${flow.steps.length}, "${step.name}", of ${projectKey}'s flow (${flow.steps.map((s) => s.name).join(" > ")}).${
    instructions ? ` Instructions for this step:\n${instructions}\n` : " "
  }${finish}`;
  return {
    text,
    finish,
    stays: step.status.category === "started" ? step.status.name : null,
    payload: {
      step: { id: step.id, name: step.name, status: step.status.name, owner: ownerName(dir, step), instructions, advance: step.advance, number: i + 1, of: flow.steps.length },
      next: next ? { id: next.id, name: next.name, status: next.status.name, owner: ownerName(dir, next) } : null,
    },
  };
}

/** Same-owner hand-off: the bot keeps the task for its next step, so its finished claim is dropped before the broadcast. */
export async function reopenForNextStep(taskId: ObjectId, botId: ObjectId) {
  const c = await cols();
  await c.agentClaims.deleteMany({ taskId, botId, kind: { $ne: "triage" } });
}
