import "server-only";
import { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { publish } from "@/lib/realtime/server";
import { toFeed, toTask } from "@/lib/data";
import { atWaitStep, pickupTarget } from "@/lib/flow-engine";
import { parentProgress, parentTarget, pickActiveSubtask, type Stage } from "@/lib/parent-progress-core";
import type { ActivityDoc, StatusCategory, TaskDoc } from "@/lib/types";

/**
 * VEC-419: a sub-task just entered a started or done status (updateTaskAs: set_status / complete_task / REST / pane /
 * board drag via moveTask; markStartedByBot: a bot's pickup or mention resume; createTaskAs: created straight into
 * one). If its parent sits in a not-started status, move the parent to the first started status of its own project
 * (rules in parent-progress-core.ts), as the same actor, with a status activity whose note names the sub-task.
 *
 * The parent's write is a plain conditional status update like markStartedByBot's, never updateTaskAs, on purpose:
 * - no flow re-plan (an active flow picks the target with pickupTarget, staying within the parent's current step,
 *   so no required step is skipped and nobody is reassigned; a step that keeps its status or waits skips the move);
 * - no hand-off or wake-up (a not-started -> started move changes no done-ness, so dependents, the umbrella's ready
 *   hand-off and its triager's close-out are untouched; those still fire when its sub-tasks close);
 * - no notification (status moves notify nobody; the activity line is the record).
 * Its own task.upsert (publish fills `children`, working bots and Stalled) updates open rows and panes live.
 *
 * Returns true when it moved and published the parent, so the caller can skip its own republish of the parent.
 * Never throws: the sub-task's write already happened.
 */
export async function startParentOnActivity(
  actor: { orgId: ObjectId; id: ObjectId },
  sub: Pick<TaskDoc, "_id" | "parentId" | "number" | "projectId">,
  subtaskTo: StatusCategory | null | undefined,
): Promise<boolean> {
  try {
    if (!sub.parentId || (subtaskTo !== "started" && subtaskTo !== "done")) return false;
    return !!(await moveParent(actor, sub.parentId, sub, subtaskTo as Stage, null));
  } catch (err) {
    console.error("[tasks] startParentOnActivity failed", err);
    return false;
  }
}

/**
 * VEC-444: the other side of the same rule. A task's OWN status was just written into a not-started status (any
 * updateTaskAs status write: pane, board drag via moveTask, MCP set_status / complete_task incl. a triage close-out
 * Triage -> Todo, flow advances, REST). If one of its non-archived sub-tasks is already started or done (typically a
 * triaged umbrella whose first sub-task was handed over and started while it was still in Triage, where parents never
 * move), it moves on to its started status now, instead of sitting in Todo until the next sub-task status change.
 * The sub-task named in the activity is pickActiveSubtask's (as the VEC-420 backfill picks it), and the move is the
 * hook's own: same stopped / archived / wait-step / flow pickup rules, same conditional write and activity notes, no
 * wake-up or notification. The write is conditional on the status the caller just wrote (`writtenStatusId`), so a
 * person moving it again in between wins. Triage and Backlog parents never get here moved (parentProgress).
 * Returns the moved task (already published) or null when it stayed. Never throws: the caller's write already happened.
 */
export async function startParentOnOwnStatus(
  actor: { orgId: ObjectId; id: ObjectId },
  task: Pick<TaskDoc, "_id" | "statusId">,
): Promise<TaskDoc | null> {
  try {
    const c = await cols();
    const subs = await c.tasks
      .find({ orgId: actor.orgId, parentId: task._id, archivedAt: null }, { projection: { statusId: 1, updatedAt: 1, number: 1, projectId: 1, parentId: 1 } })
      .toArray();
    if (!subs.length) return null;
    const stages = await c.statuses.find({ _id: { $in: subs.map((s) => s.statusId) } }, { projection: { category: 1 } }).toArray();
    const stageOf = new Map(stages.map((s) => [s._id.toHexString(), s.category as Stage]));
    const sub = pickActiveSubtask(subs.map((s) => ({ ...s, stage: stageOf.get(s.statusId.toHexString()) ?? null })));
    if (!sub?.stage) return null;
    return await moveParent(actor, task._id, sub, sub.stage, task.statusId);
  } catch (err) {
    console.error("[tasks] startParentOnOwnStatus failed", err);
    return null;
  }
}

/**
 * The one parent move both triggers share: `sub` just counts as having entered a `subtaskTo` stage status. When
 * `expectStatusId` is set, the parent must still be in that status (the one its caller just wrote) or nothing moves.
 * Returns the moved parent, published, or null.
 */
async function moveParent(
  actor: { orgId: ObjectId; id: ObjectId },
  parentId: ObjectId,
  sub: Pick<TaskDoc, "number" | "projectId">,
  subtaskTo: Stage,
  expectStatusId: ObjectId | null,
): Promise<TaskDoc | null> {
  const c = await cols();
  const parent = await c.tasks.findOne(
    { _id: parentId, orgId: actor.orgId, ...(expectStatusId ? { statusId: expectStatusId } : {}) },
    { projection: { statusId: 1, projectId: 1, orgId: 1, flow: 1, archivedAt: 1, stopped: 1 } },
  );
  if (!parent) return null;
  const statuses = await c.statuses.find({ orgId: actor.orgId, projectId: parent.projectId }, { projection: { category: 1, order: 1, name: 1 } }).toArray();
  const current = statuses.find((s) => s._id.equals(parent.statusId));
  const reason = parentProgress({
    parentStage: current?.category as Stage | undefined,
    subtaskTo,
    parentArchived: !!parent.archivedAt,
    parentStopped: !!parent.stopped,
  });
  if (!reason || !current) return null;
  // A wait step (VEC-181) is someone else's to resolve: moving its status would look like it moved on.
  if (await atWaitStep(parent)) return null;
  const pick = await pickupTarget(parent);
  const target = parentTarget(
    statuses.map((s) => ({ id: s._id.toHexString(), stage: s.category as Stage, order: s.order })),
    pick.kind === "move" ? { kind: "move", statusId: pick.statusId.toHexString() } : pick,
  );
  if (!target || target.id === current._id.toHexString()) return null;
  const now = new Date();
  // Conditional on the status we read, so a concurrent move by a person (or another sub-task's trigger) wins once.
  const after = await c.tasks.findOneAndUpdate(
    { _id: parent._id, orgId: actor.orgId, statusId: current._id },
    { $set: { statusId: new ObjectId(target.id), updatedAt: now } },
    { returnDocument: "after" },
  );
  if (!after) return null;
  const subProject = await c.projects.findOne({ _id: sub.projectId }, { projection: { key: 1 } });
  const act: ActivityDoc = {
    _id: new ObjectId(),
    orgId: actor.orgId,
    taskId: parent._id,
    actorId: actor.id,
    kind: "status",
    from: current._id.toHexString(),
    to: target.id,
    note: reason === "done" ? "subtask_done" : "subtask_started",
    subtask: `${subProject?.key ?? "?"}-${sub.number}`,
    createdAt: now,
  };
  await c.activity.insertOne(act);
  const project = after.projectId.equals(sub.projectId) ? subProject : await c.projects.findOne({ _id: after.projectId }, { projection: { key: 1 } });
  const orgHex = actor.orgId.toHexString();
  const actorHex = actor.id.toHexString();
  await publish(orgHex, { type: "task.upsert", actorId: actorHex, task: toTask(after, project?.key ?? "?") });
  await publish(orgHex, { type: "feed.add", actorId: actorHex, taskId: parent._id.toHexString(), item: toFeed(act) });
  return after;
}
