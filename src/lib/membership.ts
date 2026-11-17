import "server-only";
import { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { UserError } from "@/lib/result";
import { publish } from "@/lib/realtime/server";
import { publishWorking } from "@/lib/claims";
import { toFeed } from "@/lib/data";
import { isClosedCategory, type ActivityDoc } from "@/lib/types";
import { flowOwnerRemoved } from "@/lib/flows";

/**
 * Take a person out of an organisation: used both when they leave (account page, org settings) and when
 * an admin removes them. Refuses to remove the org's last admin. Their open tasks in the org become
 * unassigned (recorded as assignee activity by `actorId`) and open clients get task.upsert + feed.add for
 * each, then org.changed so member lists and pickers drop them. Closed tasks keep their assignee as history.
 */
export async function removeMembership(orgId: ObjectId, userId: ObjectId, actorId: ObjectId): Promise<{ unassigned: number }> {
  const c = await cols();
  const m = await c.memberships.findOne({ orgId, userId });
  if (!m) throw new UserError("That person isn't a member.");
  const self = userId.equals(actorId);
  const lastAdminError = () =>
    new UserError(
      self
        ? "You're the only admin of this organisation. Promote someone else to admin first, then leave."
        : "This is the organisation's only admin. Promote someone else to admin first.",
    );
  if (m.role === "admin" && (await c.memberships.countDocuments({ orgId, role: "admin" })) <= 1) throw lastAdminError();

  await c.memberships.deleteOne({ _id: m._id });
  // Two admins leaving at the same moment could each have seen the other: put this one back if none remain.
  if (m.role === "admin" && (await c.memberships.countDocuments({ orgId, role: "admin" })) === 0) {
    await c.memberships.insertOne(m);
    throw lastAdminError();
  }

  const statuses = await c.statuses.find({ orgId }, { projection: { category: 1 } }).toArray();
  const open = statuses.filter((s) => !isClosedCategory(s.category)).map((s) => s._id);
  const tasks = await c.tasks
    .find({ orgId, assigneeId: userId, statusId: { $in: open } }, { projection: { _id: 1 } })
    .toArray();
  const ids = tasks.map((t) => t._id);
  const orgHex = orgId.toHexString();
  const actorHex = actorId.toHexString();
  if (ids.length) {
    const now = new Date();
    await c.tasks.updateMany({ _id: { $in: ids }, orgId, assigneeId: userId }, { $set: { assigneeId: null, updatedAt: now } });
    const acts: ActivityDoc[] = ids.map((taskId) => ({
      _id: new ObjectId(),
      orgId,
      taskId,
      actorId,
      kind: "assignee",
      from: userId.toHexString(),
      to: null,
      createdAt: now,
    }));
    await c.activity.insertMany(acts);
    await publishWorking(orgId, actorId, ids, { workingOnly: false });
    for (const a of acts) {
      await publish(orgHex, { type: "feed.add", actorId: actorHex, taskId: a.taskId.toHexString(), item: toFeed(a) });
    }
  }
  // Flow steps they owned become unowned and say so (VEC-174).
  const person = await c.users.findOne({ _id: userId }, { projection: { name: 1 } });
  await flowOwnerRemoved(orgId, "person", userId, person?.name ?? "A former member");
  // Their unread inbox for this org is no use to them any more (and may name tasks they can't open).
  await c.notifications.deleteMany({ orgId, userId });
  await publish(orgHex, { type: "org.changed", actorId: actorHex });
  return { unassigned: ids.length };
}
