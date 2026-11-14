"use server";

import { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { requireOrg } from "@/lib/session";
import { guard, UserError, type Result } from "@/lib/result";
import { publish } from "@/lib/realtime/server";
import { findTaskByKey, loadCounts, loadFeed, sanitizeDescription, toFeed, toTask, toTaskDetail } from "@/lib/data";
import type { ActivityDoc, Counts, FeedItem, Priority, Task, TaskDetail, TaskDoc, TaskType } from "@/lib/types";

/** Ownership rule: the creator and org admins may change a task; everyone in the org can read and comment. */
function canEditTask(task: TaskDoc, userId: ObjectId, isAdmin: boolean) {
  return isAdmin || task.createdBy.equals(userId);
}

const oid = (id: string, what = "item") => {
  if (!ObjectId.isValid(id)) throw new UserError(`Unknown ${what}.`);
  return new ObjectId(id);
};

export interface NewTaskInput {
  title: string;
  projectId: string;
  type: TaskType;
  statusId?: string;
  assigneeId?: string | null;
  priority?: Priority;
  description?: string;
}

export async function createTask(slug: string, input: NewTaskInput): Promise<Result<Task>> {
  return guard(async () => {
    const { org, user } = await requireOrg(slug);
    const title = input.title.trim();
    if (!title) throw new UserError("Give the task a title.");
    if (title.length > 300) throw new UserError("Keep titles under 300 characters.");
    const c = await cols();
    const projectId = oid(input.projectId, "project");
    const project = await c.projects.findOneAndUpdate(
      { _id: projectId, orgId: org._id },
      { $inc: { nextNumber: 1 } },
      { returnDocument: "before" },
    );
    if (!project) throw new UserError("Pick a project.");
    const status = input.statusId
      ? await c.statuses.findOne({ _id: oid(input.statusId, "status"), orgId: org._id })
      : await c.statuses.find({ orgId: org._id, category: { $in: ["unstarted", "backlog"] } }).sort({ order: 1 }).limit(1).next();
    if (!status) throw new UserError("Pick a status.");
    let assigneeId: ObjectId | null = null;
    if (input.assigneeId) {
      assigneeId = oid(input.assigneeId, "member");
      if (!(await c.memberships.findOne({ orgId: org._id, userId: assigneeId }))) throw new UserError("That person isn't a member.");
    }
    const now = new Date();
    const doc: TaskDoc = {
      _id: new ObjectId(),
      orgId: org._id,
      projectId,
      number: project.nextNumber,
      title,
      description: sanitizeDescription(input.description ?? ""),
      type: input.type === "feature" ? "feature" : "issue",
      statusId: status._id,
      assigneeId,
      priority: ([0, 1, 2, 3] as const).includes(input.priority ?? 0) ? (input.priority ?? 0) : 0,
      createdBy: user._id,
      createdAt: now,
      updatedAt: now,
    };
    await c.tasks.insertOne(doc);
    const act: ActivityDoc = { _id: new ObjectId(), orgId: org._id, taskId: doc._id, actorId: user._id, kind: "created", createdAt: now };
    await c.activity.insertOne(act);
    const task = toTask(doc, project.key);
    await publish(org._id.toHexString(), { type: "task.upsert", actorId: user._id.toHexString(), task });
    return task;
  });
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

export async function updateTask(slug: string, taskId: string, patch: TaskPatch): Promise<Result<Task>> {
  return guard(async () => {
    const { org, user, isAdmin } = await requireOrg(slug);
    const c = await cols();
    const id = oid(taskId, "task");
    const before = await c.tasks.findOne({ _id: id, orgId: org._id });
    if (!before) throw new UserError("This task no longer exists.");
    if (!canEditTask(before, user._id, isAdmin)) throw new UserError("Only the task's creator or an admin can edit it.");
    const set: Partial<TaskDoc> = {};
    const acts: Omit<ActivityDoc, "_id" | "orgId" | "taskId" | "actorId" | "createdAt">[] = [];

    if (patch.title !== undefined) {
      const t = patch.title.trim();
      if (!t) throw new UserError("Titles can't be empty.");
      if (t.length > 300) throw new UserError("Keep titles under 300 characters.");
      if (t !== before.title) {
        set.title = t;
        acts.push({ kind: "title", from: before.title, to: t });
      }
    }
    if (patch.description !== undefined) set.description = sanitizeDescription(patch.description);
    if (patch.type && patch.type !== before.type) {
      set.type = patch.type === "feature" ? "feature" : "issue";
      acts.push({ kind: "type", from: before.type, to: set.type });
    }
    if (patch.priority !== undefined && patch.priority !== before.priority) {
      if (![0, 1, 2, 3].includes(patch.priority)) throw new UserError("Unknown priority.");
      set.priority = patch.priority;
      acts.push({ kind: "priority", from: String(before.priority), to: String(patch.priority) });
    }
    if (patch.statusId && patch.statusId !== before.statusId.toHexString()) {
      const s = await c.statuses.findOne({ _id: oid(patch.statusId, "status"), orgId: org._id });
      if (!s) throw new UserError("Unknown status.");
      set.statusId = s._id;
      acts.push({ kind: "status", from: before.statusId.toHexString(), to: s._id.toHexString() });
    }
    if (patch.assigneeId !== undefined && (patch.assigneeId ?? null) !== (before.assigneeId?.toHexString() ?? null)) {
      let a: ObjectId | null = null;
      if (patch.assigneeId) {
        a = oid(patch.assigneeId, "member");
        if (!(await c.memberships.findOne({ orgId: org._id, userId: a }))) throw new UserError("That person isn't a member.");
      }
      set.assigneeId = a;
      acts.push({ kind: "assignee", from: before.assigneeId?.toHexString() ?? null, to: a?.toHexString() ?? null });
    }
    let projectKey: string | undefined;
    if (patch.projectId && patch.projectId !== before.projectId.toHexString()) {
      // Moving projects gives the task a new number in the destination project.
      const p = await c.projects.findOneAndUpdate(
        { _id: oid(patch.projectId, "project"), orgId: org._id },
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
    const after = await c.tasks.findOneAndUpdate({ _id: id, orgId: org._id }, { $set: set }, { returnDocument: "after" });
    if (!after) throw new UserError("This task no longer exists.");
    projectKey ??= (await c.projects.findOne({ _id: after.projectId }))?.key ?? "?";
    const task = toTask(after, projectKey);
    const orgHex = org._id.toHexString();
    const actorId = user._id.toHexString();
    await publish(orgHex, { type: "task.upsert", actorId, task, descriptionChanged: patch.description !== undefined });

    if (acts.length) {
      const docs: ActivityDoc[] = acts.map((a) => ({ ...a, _id: new ObjectId(), orgId: org._id, taskId: id, actorId: user._id, createdAt: now }));
      await c.activity.insertMany(docs);
      for (const d of docs) await publish(orgHex, { type: "feed.add", actorId, taskId, item: toFeed(d) });
    }
    return task;
  });
}

export async function deleteTask(slug: string, taskId: string): Promise<Result> {
  return guard(async () => {
    const { org, user, isAdmin } = await requireOrg(slug);
    const c = await cols();
    const id = oid(taskId, "task");
    const t = await c.tasks.findOne({ _id: id, orgId: org._id });
    if (!t) return;
    if (!canEditTask(t, user._id, isAdmin)) throw new UserError("Only the task's creator or an admin can delete it.");
    await c.tasks.deleteOne({ _id: id });
    await Promise.all([c.comments.deleteMany({ taskId: id }), c.activity.deleteMany({ taskId: id })]);
    await publish(org._id.toHexString(), { type: "task.delete", actorId: user._id.toHexString(), taskId });
  });
}

export async function addComment(slug: string, taskId: string, body: string): Promise<Result<FeedItem>> {
  return guard(async () => {
    const { org, user } = await requireOrg(slug);
    const text = body.trim();
    if (!text) throw new UserError("Write something first.");
    if (text.length > 10_000) throw new UserError("Comments are limited to 10,000 characters.");
    const c = await cols();
    const id = oid(taskId, "task");
    if (!(await c.tasks.findOne({ _id: id, orgId: org._id }, { projection: { _id: 1 } }))) throw new UserError("This task no longer exists.");
    const doc = { _id: new ObjectId(), orgId: org._id, taskId: id, authorId: user._id, body: text, createdAt: new Date() };
    await c.comments.insertOne(doc);
    const item = toFeed(doc);
    await publish(org._id.toHexString(), { type: "feed.add", actorId: user._id.toHexString(), taskId, item });
    return item;
  });
}

export async function getTaskDetail(slug: string, key: string): Promise<Result<{ task: TaskDetail; feed: FeedItem[] }>> {
  return guard(async () => {
    const { org } = await requireOrg(slug);
    const found = await findTaskByKey(org._id, key);
    if (!found) throw new UserError("This task no longer exists.");
    return { task: toTaskDetail(found.task, found.project.key), feed: await loadFeed(found.task._id) };
  });
}

export async function getCounts(slug: string): Promise<Result<Counts>> {
  return guard(async () => {
    const { org, user } = await requireOrg(slug);
    return loadCounts(org._id, user._id);
  });
}

export async function searchTasks(slug: string, q: string): Promise<Result<Task[]>> {
  return guard(async () => {
    const { org } = await requireOrg(slug);
    const query = q.trim().slice(0, 100);
    if (!query) return [];
    const c = await cols();
    const projects = await c.projects.find({ orgId: org._id }).toArray();
    const keys = new Map(projects.map((p) => [p._id.toHexString(), p.key]));
    const keyMatch = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(query);
    const esc = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const or: object[] = [{ title: { $regex: esc, $options: "i" } }];
    if (keyMatch) {
      const p = projects.find((x) => x.key === keyMatch[1].toUpperCase());
      if (p) or.push({ projectId: p._id, number: Number(keyMatch[2]) });
    }
    const docs = await c.tasks
      .find({ orgId: org._id, $or: or }, { projection: { description: 0 } })
      .sort({ updatedAt: -1 })
      .limit(20)
      .toArray();
    return docs.map((d) => toTask(d as TaskDoc, keys.get(d.projectId.toHexString()) ?? "?"));
  });
}
