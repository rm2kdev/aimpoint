import "server-only";
import { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { UserError } from "@/lib/result";
import { publish } from "@/lib/realtime/server";
import { sanitizeDescription, toFeed, toTask } from "@/lib/data";
import type { ActivityDoc, FeedItem, Priority, Task, TaskDoc, TaskType } from "@/lib/types";

/**
 * Task writes shared by the web app (server actions) and the bot API.
 * An actor is a signed-in user or a bot; bots are never admins.
 */
export interface Actor {
  orgId: ObjectId;
  id: ObjectId;
  isAdmin: boolean;
}

/** Ownership rule: the creator and org admins may change a task; everyone in the org can read and comment. */
export function canEditTask(task: TaskDoc, actorId: ObjectId, isAdmin: boolean) {
  return isAdmin || task.createdBy.equals(actorId);
}

export const oid = (id: string, what = "item") => {
  if (!ObjectId.isValid(id)) throw new UserError(`Unknown ${what}.`);
  return new ObjectId(id);
};

/** Assignees can be org members or the org's bots. */
async function assertAssignable(orgId: ObjectId, id: ObjectId) {
  const c = await cols();
  const [m, b] = await Promise.all([
    c.memberships.findOne({ orgId, userId: id }, { projection: { _id: 1 } }),
    c.bots.findOne({ orgId, _id: id }, { projection: { _id: 1 } }),
  ]);
  if (!m && !b) throw new UserError("That assignee isn't a member or bot of this organisation.");
}

export interface NewTaskInput {
  title: string;
  projectId: string;
  type: TaskType;
  statusId?: string;
  assigneeId?: string | null;
  priority?: Priority;
  description?: string;
}

export async function createTaskAs(actor: Actor, input: NewTaskInput): Promise<Task> {
  const title = (input.title ?? "").trim();
  if (!title) throw new UserError("Give the task a title.");
  if (title.length > 300) throw new UserError("Keep titles under 300 characters.");
  const c = await cols();
  const projectId = oid(input.projectId, "project");
  const project = await c.projects.findOneAndUpdate(
    { _id: projectId, orgId: actor.orgId },
    { $inc: { nextNumber: 1 } },
    { returnDocument: "before" },
  );
  if (!project) throw new UserError("Pick a project.");
  const status = input.statusId
    ? await c.statuses.findOne({ _id: oid(input.statusId, "status"), orgId: actor.orgId })
    : (await c.statuses.find({ orgId: actor.orgId, category: "unstarted" }).sort({ order: 1 }).limit(1).next()) ??
      (await c.statuses.find({ orgId: actor.orgId }).sort({ order: 1 }).limit(1).next());
  if (!status) throw new UserError("Pick a status.");
  let assigneeId: ObjectId | null = null;
  if (input.assigneeId) {
    assigneeId = oid(input.assigneeId, "assignee");
    await assertAssignable(actor.orgId, assigneeId);
  }
  const now = new Date();
  const priority = input.priority ?? 0;
  const doc: TaskDoc = {
    _id: new ObjectId(),
    orgId: actor.orgId,
    projectId,
    number: project.nextNumber,
    title,
    description: sanitizeDescription(input.description ?? ""),
    type: input.type === "feature" ? "feature" : "issue",
    statusId: status._id,
    assigneeId,
    priority: ([0, 1, 2, 3] as const).includes(priority) ? priority : 0,
    createdBy: actor.id,
    createdAt: now,
    updatedAt: now,
  };
  await c.tasks.insertOne(doc);
  await c.activity.insertOne({ _id: new ObjectId(), orgId: actor.orgId, taskId: doc._id, actorId: actor.id, kind: "created", createdAt: now });
  const task = toTask(doc, project.key);
  await publish(actor.orgId.toHexString(), { type: "task.upsert", actorId: actor.id.toHexString(), task });
  return task;
}

export interface TaskPatch {
  title?: string;
  description?: string;
  type?: TaskType;
  statusId?: string;
  assigneeId?: string | null;
  priority?: Priority;
  projectId?: string;
}

export async function updateTaskAs(actor: Actor, taskId: ObjectId, patch: TaskPatch): Promise<Task> {
  const c = await cols();
  const before = await c.tasks.findOne({ _id: taskId, orgId: actor.orgId });
  if (!before) throw new UserError("This task no longer exists.");
  if (!canEditTask(before, actor.id, actor.isAdmin)) throw new UserError("Only the task's creator or an admin can edit it.");
  const set: Partial<TaskDoc> = {};
  const acts: Omit<ActivityDoc, "_id" | "orgId" | "taskId" | "actorId" | "createdAt">[] = [];

  if (patch.title !== undefined) {
    const t = String(patch.title).trim();
    if (!t) throw new UserError("Titles can't be empty.");
    if (t.length > 300) throw new UserError("Keep titles under 300 characters.");
    if (t !== before.title) {
      set.title = t;
      acts.push({ kind: "title", from: before.title, to: t });
    }
  }
  if (patch.description !== undefined) set.description = sanitizeDescription(String(patch.description));
  if (patch.type && patch.type !== before.type) {
    set.type = patch.type === "feature" ? "feature" : "issue";
    acts.push({ kind: "type", from: before.type, to: set.type });
  }
  if (patch.priority !== undefined && patch.priority !== before.priority) {
    if (![0, 1, 2, 3].includes(patch.priority)) throw new UserError("Priority is 0 (none) to 3 (high).");
    set.priority = patch.priority;
    acts.push({ kind: "priority", from: String(before.priority), to: String(patch.priority) });
  }
  if (patch.statusId && patch.statusId !== before.statusId.toHexString()) {
    const s = await c.statuses.findOne({ _id: oid(patch.statusId, "status"), orgId: actor.orgId });
    if (!s) throw new UserError("Unknown status.");
    set.statusId = s._id;
    acts.push({ kind: "status", from: before.statusId.toHexString(), to: s._id.toHexString() });
  }
  if (patch.assigneeId !== undefined && (patch.assigneeId ?? null) !== (before.assigneeId?.toHexString() ?? null)) {
    let a: ObjectId | null = null;
    if (patch.assigneeId) {
      a = oid(patch.assigneeId, "assignee");
      await assertAssignable(actor.orgId, a);
    }
    set.assigneeId = a;
    acts.push({ kind: "assignee", from: before.assigneeId?.toHexString() ?? null, to: a?.toHexString() ?? null });
  }
  let projectKey: string | undefined;
  if (patch.projectId && patch.projectId !== before.projectId.toHexString()) {
    // Moving projects gives the task a new number in the destination project.
    const p = await c.projects.findOneAndUpdate(
      { _id: oid(patch.projectId, "project"), orgId: actor.orgId },
      { $inc: { nextNumber: 1 } },
      { returnDocument: "before" },
    );
    if (!p) throw new UserError("Unknown project.");
    set.projectId = p._id;
    set.number = p.nextNumber;
    projectKey = p.key;
    acts.push({ kind: "project", from: before.projectId.toHexString(), to: p._id.toHexString() });
  }

  if (!Object.keys(set).length) {
    const p = await c.projects.findOne({ _id: before.projectId });
    return toTask(before, p?.key ?? "?");
  }
  const now = new Date();
  set.updatedAt = now;
  const after = await c.tasks.findOneAndUpdate({ _id: taskId, orgId: actor.orgId }, { $set: set }, { returnDocument: "after" });
  if (!after) throw new UserError("This task no longer exists.");
  projectKey ??= (await c.projects.findOne({ _id: after.projectId }))?.key ?? "?";
  const task = toTask(after, projectKey);
  const orgHex = actor.orgId.toHexString();
  const actorId = actor.id.toHexString();
  await publish(orgHex, { type: "task.upsert", actorId, task, descriptionChanged: patch.description !== undefined });

  if (acts.length) {
    const docs: ActivityDoc[] = acts.map((a) => ({ ...a, _id: new ObjectId(), orgId: actor.orgId, taskId, actorId: actor.id, createdAt: now }));
    await c.activity.insertMany(docs);
    for (const d of docs) await publish(orgHex, { type: "feed.add", actorId, taskId: taskId.toHexString(), item: toFeed(d) });
  }
  return task;
}

export async function deleteTaskAs(actor: Actor, taskId: ObjectId) {
  const c = await cols();
  const t = await c.tasks.findOne({ _id: taskId, orgId: actor.orgId });
  if (!t) return;
  if (!canEditTask(t, actor.id, actor.isAdmin)) throw new UserError("Only the task's creator or an admin can delete it.");
  await c.tasks.deleteOne({ _id: taskId });
  await Promise.all([c.comments.deleteMany({ taskId }), c.activity.deleteMany({ taskId })]);
  await publish(actor.orgId.toHexString(), { type: "task.delete", actorId: actor.id.toHexString(), taskId: taskId.toHexString() });
}

export async function addCommentAs(actor: Actor, taskId: ObjectId, body: string): Promise<FeedItem> {
  const text = String(body ?? "").trim();
  if (!text) throw new UserError("Write something first.");
  if (text.length > 10_000) throw new UserError("Comments are limited to 10,000 characters.");
  const c = await cols();
  if (!(await c.tasks.findOne({ _id: taskId, orgId: actor.orgId }, { projection: { _id: 1 } }))) throw new UserError("This task no longer exists.");
  const doc = { _id: new ObjectId(), orgId: actor.orgId, taskId, authorId: actor.id, body: text, createdAt: new Date() };
  await c.comments.insertOne(doc);
  const item = toFeed(doc);
  await publish(actor.orgId.toHexString(), { type: "feed.add", actorId: actor.id.toHexString(), taskId: taskId.toHexString(), item });
  return item;
}
