import "server-only";
import { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { publish } from "@/lib/realtime/server";
import type { Notification, NotificationDoc, NotificationKind, StalledReason } from "@/lib/types";

/**
 * People's inbox. Bots hear about the same events through wake-ups and check_for_work;
 * people get a notification here, a live toast and an unread count in the sidebar.
 */

export interface NotifyInput {
  kind: NotificationKind;
  taskId: ObjectId;
  actorId: ObjectId | null;
  commentId?: ObjectId | null;
  detail?: string | null;
  /** "stalled" only (VEC-394). */
  reason?: StalledReason | null;
}

/** Notifies org members among `recipients` (bots and non-members are skipped). Never throws into the caller. */
export async function notify(orgId: ObjectId, recipients: ObjectId[], input: NotifyInput) {
  try {
    const ids = [...new Map(recipients.map((id) => [id.toHexString(), id])).values()].filter((id) => !input.actorId || !id.equals(input.actorId));
    if (!ids.length) return;
    const c = await cols();
    const members = await c.memberships.find({ orgId, userId: { $in: ids } }, { projection: { userId: 1 } }).toArray();
    if (!members.length) return;
    const task = await c.tasks.findOne({ _id: input.taskId, orgId }, { projection: { projectId: 1, number: 1, title: 1, archivedAt: 1 } });
    if (!task) return;
    const project = await c.projects.findOne({ _id: task.projectId }, { projection: { key: 1 } });
    const now = new Date();
    const docs: NotificationDoc[] = members.map((m) => ({
      _id: new ObjectId(),
      orgId,
      userId: m.userId,
      taskId: input.taskId,
      kind: input.kind,
      actorId: input.actorId,
      commentId: input.commentId ?? null,
      detail: input.detail ?? null,
      ...(input.reason ? { reason: input.reason } : {}),
      createdAt: now,
      readAt: null,
    }));
    await c.notifications.insertMany(docs);
    const key = `${project?.key ?? "?"}-${task.number}`;
    for (const d of docs) {
      await publish(orgId.toHexString(), {
        type: "notification",
        userId: d.userId.toHexString(),
        notification: toNotification(d, { key, title: task.title, archived: !!task.archivedAt }),
      });
    }
  } catch (err) {
    console.error("[notify]", err);
  }
}

function toNotification(d: NotificationDoc, task: { key: string; title: string; archived: boolean }): Notification {
  return {
    id: d._id.toHexString(),
    kind: d.kind,
    taskId: d.taskId.toHexString(),
    taskKey: task.key,
    taskTitle: task.title,
    taskArchived: task.archived,
    actorId: d.actorId?.toHexString() ?? null,
    detail: d.detail ?? null,
    reason: d.reason ?? null,
    createdAt: d.createdAt.toISOString(),
    read: !!d.readAt,
  };
}

/** Newest first. Notifications whose task was deleted are dropped. */
export async function loadNotifications(orgId: ObjectId, userId: ObjectId, limit = 100): Promise<Notification[]> {
  const c = await cols();
  const docs = await c.notifications.find({ orgId, userId }).sort({ createdAt: -1 }).limit(limit).toArray();
  const tasks = await c.tasks
    .find({ _id: { $in: [...new Set(docs.map((d) => d.taskId.toHexString()))].map((id) => new ObjectId(id)) } }, { projection: { projectId: 1, number: 1, title: 1, archivedAt: 1 } })
    .toArray();
  const projects = await c.projects.find({ orgId }, { projection: { key: 1 } }).toArray();
  const pk = new Map(projects.map((p) => [p._id.toHexString(), p.key]));
  const byId = new Map(tasks.map((t) => [t._id.toHexString(), { key: `${pk.get(t.projectId.toHexString()) ?? "?"}-${t.number}`, title: t.title, archived: !!t.archivedAt }]));
  return docs.flatMap((d) => {
    const t = byId.get(d.taskId.toHexString());
    return t ? [toNotification(d, t)] : [];
  });
}

export async function unreadCount(orgId: ObjectId, userId: ObjectId) {
  return (await cols()).notifications.countDocuments({ orgId, userId, readAt: null });
}

/** Marks some (or all) of a person's notifications read. */
export async function markRead(orgId: ObjectId, userId: ObjectId, ids: ObjectId[] | "all") {
  const c = await cols();
  await c.notifications.updateMany(
    ids === "all" ? { orgId, userId, readAt: null } : { orgId, userId, _id: { $in: ids }, readAt: null },
    { $set: { readAt: new Date() } },
  );
  await publish(orgId.toHexString(), { type: "notifications.read", userId: userId.toHexString(), ids: ids === "all" ? "all" : ids.map((id) => id.toHexString()) });
}
