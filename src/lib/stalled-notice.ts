import "server-only";
import { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { notify } from "@/lib/notifications";
import { loadTaskFlow } from "@/lib/flow-engine";
import type { Task, TaskDoc } from "@/lib/types";

/**
 * VEC-108: tell a person when a task goes red Stalled because nobody owns it (open, ready, unassigned, at least
 * one open task waiting on it). Auto-assignment (VEC-107) covers bots parking their own work; this is the safety
 * net for everything else (a person files a blocker, an assignee is removed, a bot is deleted).
 *
 * Called from publish() on every task.upsert, with `task.stalled` already computed (withWorkingBots). One
 * notification per entry into the state: `stalledNoticeAt` on the task is taken with a conditional update, so
 * concurrent upserts send it once, and it's cleared when the task leaves the state, which re-arms it.
 * "needs_owner" (still waiting on its own dependencies) sends nothing.
 *
 * VEC-316: entering "unfinished" Stalled (its bot's run, and the one follow-up, ended without complete_task) sends
 * one too, on the same once-per-entry marker, to the creator plus the people of the task's flow step.
 *
 * Recipients: the task's creator if that's a person in the org; otherwise the people among the assignees and
 * creators of the waiting tasks; otherwise the org admins. Never throws into the caller.
 */
export async function syncStalledNotice(orgId: string, task: Task) {
  try {
    const c = await cols();
    const org = new ObjectId(orgId);
    const _id = new ObjectId(task.id);
    const reason = task.stalled?.reason;
    if (reason !== "unassigned" && reason !== "unfinished") {
      await c.tasks.updateOne({ _id, orgId: org, stalledNoticeAt: { $ne: null, $exists: true } }, { $set: { stalledNoticeAt: null } });
      return;
    }
    const doc = await c.tasks.findOneAndUpdate(
      { _id, orgId: org, ...(reason === "unassigned" ? { assigneeId: null } : {}), archivedAt: null, $or: [{ stalledNoticeAt: null }, { stalledNoticeAt: { $exists: false } }] },
      { $set: { stalledNoticeAt: new Date() } },
      { projection: { createdBy: 1, orgId: 1, projectId: 1, statusId: 1, flow: 1 } },
    );
    if (!doc) return; // already told, or it changed meanwhile
    if (reason === "unfinished") {
      // VEC-316: the creator plus the step's person owner (bots aren't notified); else as below.
      const bot = task.stalled!.botId ? await c.bots.findOne({ _id: new ObjectId(task.stalled!.botId) }, { projection: { name: 1 } }) : null;
      const blocking = task.stalled!.blocking.length ? ` ${task.stalled!.blocking.join(", ")} ${task.stalled!.blocking.length === 1 ? "is" : "are"} waiting on it.` : "";
      await notify(org, await unfinishedRecipients(org, _id, doc), {
        kind: "stalled",
        reason: "unfinished",
        taskId: _id,
        actorId: task.stalled!.botId ? new ObjectId(task.stalled!.botId) : null,
        detail: `${bot?.name ?? "Its bot"} ended its run twice without finishing it, so nothing moved it on.${blocking} Check its last comments, then move it on, reassign it or @mention the bot.`.slice(0, 200),
      });
      return;
    }
    const recipients = await stalledRecipients(org, _id, doc.createdBy);
    const keys = task.stalled!.blocking;
    const waiting = keys.length === 1 ? `${keys[0]} is waiting on it` : `${keys.join(", ")} are waiting on it`;
    await notify(org, recipients, { kind: "stalled", reason: "unassigned", taskId: _id, actorId: null, detail: `${waiting}. Assign it to someone.`.slice(0, 200) });
  } catch (err) {
    console.error("[stalled notice]", err);
  }
}

async function stalledRecipients(orgId: ObjectId, taskId: ObjectId, createdBy: ObjectId): Promise<ObjectId[]> {
  const c = await cols();
  const creator = await c.memberships.findOne({ orgId, userId: createdBy }, { projection: { userId: 1 } });
  if (creator) return [creator.userId];
  const closed = (await c.statuses.find({ orgId, category: { $in: ["done", "cancelled"] } }, { projection: { _id: 1 } }).toArray()).map((s) => s._id);
  const waiters = await c.tasks
    .find({ orgId, waitingOn: taskId, archivedAt: null, statusId: { $nin: closed } }, { projection: { assigneeId: 1, createdBy: 1 } })
    .toArray();
  const ids = [...new Map(waiters.flatMap((w) => [w.assigneeId, w.createdBy]).filter((id): id is ObjectId => !!id).map((id) => [id.toHexString(), id])).values()];
  const people = ids.length ? await c.memberships.find({ orgId, userId: { $in: ids } }, { projection: { userId: 1 } }).toArray() : [];
  if (people.length) return people.map((m) => m.userId);
  return (await c.memberships.find({ orgId, role: "admin" }, { projection: { userId: 1 } }).toArray()).map((m) => m.userId);
}

/** "unfinished" (VEC-316): the creator if a person, plus the step's owner when that's a person; else as stalledRecipients. */
async function unfinishedRecipients(orgId: ObjectId, taskId: ObjectId, doc: Pick<TaskDoc, "createdBy" | "orgId" | "projectId" | "statusId" | "flow">): Promise<ObjectId[]> {
  const c = await cols();
  const ids: ObjectId[] = [doc.createdBy];
  const ctx = doc.flow?.paused ? null : await loadTaskFlow(doc).catch(() => null);
  const step = ctx?.current;
  if (step?.owner.kind === "person" && step.owner.id && ObjectId.isValid(step.owner.id)) ids.push(new ObjectId(step.owner.id));
  const people = await c.memberships.find({ orgId, userId: { $in: ids } }, { projection: { userId: 1 } }).toArray();
  if (people.length) return [...new Map(people.map((m) => [m.userId.toHexString(), m.userId])).values()];
  return stalledRecipients(orgId, taskId, doc.createdBy);
}
