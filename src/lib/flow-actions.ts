import "server-only";
import { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { UserError } from "@/lib/result";
import { publish } from "@/lib/realtime/server";
import { toFeed, toTask, withWorkingBots } from "@/lib/data";
import { advanceTarget, loadTaskFlow } from "@/lib/flow-engine";
import { canPauseFlow, flowStepAction, locateStep, stalledMoveOn, type FlowViewer } from "@/lib/flow-engine-core";
import { addCommentAs, updateTaskAs, type Actor } from "@/lib/task-service";
import type { ActivityDoc, Task, TaskDoc, TaskFlowState } from "@/lib/types";

/**
 * People's flow actions in the task pane (VEC-183, docs/flows.md 5.6 / 5.7). The rules for who gets which action
 * are the client-safe `flowStepAction` / `canPauseFlow` (lib/flow-engine-core.ts), so the pane offers exactly what
 * these accept. Moves go through updateTaskAs with `flowTo`, the same path as a bot's advance_task / complete_task,
 * so hand-overs, claims, wake-ups, notifications and dependency bookkeeping are the engine's own.
 */

const viewerOf = (actor: Actor, task: TaskDoc, bots: ReadonlyMap<string, string>): FlowViewer => {
  const assignee = task.assigneeId?.toHexString() ?? null;
  return { me: actor.id.toHexString(), isAdmin: actor.isAdmin, createdBy: task.createdBy.toHexString(), assigneeId: assignee, assigneeIsPerson: !!assignee && !bots.has(assignee) };
};

async function loadTask(actor: Actor, taskId: ObjectId) {
  if (actor.isBot) throw new UserError("This action is for people. Bots move a flow on with complete_task or advance_task.");
  const task = await (await cols()).tasks.findOne({ _id: taskId, orgId: actor.orgId });
  if (!task) throw new UserError("This task no longer exists.");
  if (task.archivedAt) throw new UserError("This task is archived. Restore it first.");
  return task;
}

/**
 * The current step's action: a wait step's "<wait label>" (resolves it, like advance_task) or "Complete step" on a
 * step a person holds. `stepId` is the step the person saw, so a double click or a stale pane can't move it twice.
 */
export async function advanceStepAs(actor: Actor, taskId: ObjectId, opts: { stepId: string; comment?: string | null }): Promise<Task> {
  const task = await loadTask(actor, taskId);
  const ctx = task.flow?.paused ? null : await loadTaskFlow(task);
  const step = ctx?.current;
  if (!ctx || !step || !ctx.status) throw new UserError(task.flow?.paused ? "Its flow is paused. Resume the flow first, or change the status." : "This task isn't at a step of a flow.");
  if (step.id !== opts.stepId) throw new UserError(`It has already moved on: it's at the ${step.name} step now.`);
  const action = flowStepAction(ctx.flow, step, ctx.status, viewerOf(actor, task, ctx.dir.bots));
  if (!action) throw new UserError(`You can't move it on from ${step.name}. Its assignee, creator${step.owner.kind === "person" ? ", the step's owner" : ""} or an admin can.`);
  const comment = opts.comment?.trim();
  if (comment) await addCommentAs(actor, taskId, comment);
  const statusChanges = action.next.status.id !== ctx.status.id;
  // flowResolver: the step's owner may not have edit rights (another person was assigned); this is the one move it may make.
  return updateTaskAs(actor, taskId, statusChanges ? { statusId: action.next.status.id } : {}, { flowTo: action.next.id, flowResolver: true });
}

/**
 * "Move to <next step>" on a flow task that sits Stalled after its bot finished the step (VEC-317, docs/flows.md 5.8):
 * the one-click fix instead of a comment and an @mention. The creator or an admin. It takes the same advance path as
 * complete_task without a status (advanceTarget, then updateTaskAs with `flowTo`), so the status moves, the next
 * step's owner is assigned and woken or notified, and a same-bot keep step re-opens that bot's claim.
 */
export async function moveStalledOnAs(actor: Actor, taskId: ObjectId, opts: { stepId: string }): Promise<Task> {
  const task = await loadTask(actor, taskId);
  const ctx = task.flow?.paused ? null : await loadTaskFlow(task);
  const step = ctx?.current;
  if (!ctx || !step || !ctx.status) throw new UserError(task.flow?.paused ? "Its flow is paused. Resume the flow first, or change the status." : "This task isn't at a step of a flow.");
  if (step.id !== opts.stepId) throw new UserError(`It has already moved on: it's at the ${step.name} step now.`);
  const project = await (await cols()).projects.findOne({ _id: task.projectId }, { projection: { key: 1 } });
  const [shown] = await withWorkingBots([toTask(task, project?.key ?? "?")]);
  const move = stalledMoveOn(ctx.flow, step, ctx.status, viewerOf(actor, task, ctx.dir.bots), shown.stalled?.reason);
  if (!move) {
    if (!shown.stalled) throw new UserError("It isn't stalled any more, so there's nothing to fix. Move it with the flow or the status instead.");
    throw new UserError(`You can't move it on from ${step.name}. Its creator or an admin can.`);
  }
  const target = await advanceTarget(task);
  if (target.kind !== "advance" || target.to.id !== move.next.id) throw new UserError(`The flow can't hand it on from ${step.name} right now.`);
  return updateTaskAs(actor, taskId, target.statusChanges ? { statusId: target.to.status.id } : {}, { flowTo: target.to.id });
}

type TaskFlowCtx = NonNullable<Awaited<ReturnType<typeof loadTaskFlow>>>;

/**
 * The task's flow state once paused / resumed (shared with Stop / Resume, lib/stop-work.ts). Pausing keeps the
 * position; resuming re-syncs it by the task's status. Load `ctx` with `{ ignoreRecorded: !paused }`.
 */
export function flowPauseState(task: TaskDoc, ctx: TaskFlowCtx, paused: boolean, now: Date) {
  const at = paused ? ctx.current : ctx.status ? locateStep(ctx.flow, ctx.status, null) : null;
  const flow: TaskFlowState = paused
    ? { ...(task.flow ?? { stepId: at?.id ?? null, source: ctx.flow.source, version: ctx.flow.version, enteredAt: now }), paused: true }
    : {
        stepId: at?.id ?? null,
        source: ctx.flow.source,
        version: ctx.flow.version,
        enteredAt: at && at.id === task.flow?.stepId ? task.flow.enteredAt : now,
        paused: false,
      };
  return { flow, at };
}

/**
 * Pause / Resume flow (creator, assignee, admin). Paused, the flow is out of the way: status and assignee edits and
 * complete_task behave as without flows. Resuming re-syncs the position by the task's status (the step of that
 * status, or detached), without reassigning or waking anyone: the next status change or complete_task hands it on.
 */
export async function setFlowPausedAs(actor: Actor, taskId: ObjectId, paused: boolean): Promise<Task> {
  const c = await cols();
  const task = await loadTask(actor, taskId);
  const ctx = await loadTaskFlow(task, { ignoreRecorded: !paused });
  if (!ctx) throw new UserError("This task's project has no flow.");
  if (!canPauseFlow(viewerOf(actor, task, ctx.dir.bots))) throw new UserError("Only the task's creator, its assignee or an admin can pause or resume its flow.");
  const project = await c.projects.findOne({ _id: task.projectId });
  const key = project?.key ?? "?";
  if (!!task.flow?.paused === paused) return (await withWorkingBots([toTask(task, key)]))[0];

  const now = new Date();
  const { flow, at } = flowPauseState(task, ctx, paused, now);
  const after = await c.tasks.findOneAndUpdate(
    { _id: taskId, orgId: actor.orgId, "flow.paused": paused ? { $ne: true } : true },
    { $set: { flow, updatedAt: now } },
    { returnDocument: "after" },
  );
  if (!after) return (await withWorkingBots([toTask((await c.tasks.findOne({ _id: taskId })) ?? task, key)]))[0];
  const out = toTask(after, key);
  const orgHex = actor.orgId.toHexString();
  const actorId = actor.id.toHexString();
  await publish(orgHex, { type: "task.upsert", actorId, task: out });
  const act: ActivityDoc = {
    _id: new ObjectId(),
    orgId: actor.orgId,
    taskId,
    actorId: actor.id,
    kind: "flow_step",
    from: task.flow?.stepId ? (ctx.flow.steps.find((s) => s.id === task.flow?.stepId)?.name ?? null) : null,
    to: at?.name ?? null,
    note: paused ? "paused" : "resumed",
    flowStatus: ctx.status?.name ?? null,
    flowOwner: null,
    createdAt: now,
  };
  await c.activity.insertOne(act);
  await publish(orgHex, { type: "feed.add", actorId, taskId: taskId.toHexString(), item: toFeed(act) });
  return (await withWorkingBots([out]))[0];
}
