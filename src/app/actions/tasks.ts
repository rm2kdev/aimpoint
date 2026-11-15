"use server";

import { cols } from "@/lib/db";
import { requireOrg, type OrgContext } from "@/lib/session";
import { guard, UserError, type Result } from "@/lib/result";
import { findTaskByKey, loadCounts, loadFeed, toTask, toTaskDetail, withWorkingBots } from "@/lib/data";
import { loadTaskRefs } from "@/lib/dependencies";
import {
  addCommentAs,
  createTaskAs,
  deleteTaskAs,
  oid,
  updateTaskAs,
  type Actor,
  type NewTaskInput,
  type TaskPatch,
} from "@/lib/task-service";
import type { Counts, FeedItem, Task, TaskDetail, TaskDoc } from "@/lib/types";

export type { NewTaskInput, TaskPatch };

const actorOf = ({ org, user, isAdmin }: OrgContext): Actor => ({ orgId: org._id, id: user._id, isAdmin });

export async function createTask(slug: string, input: NewTaskInput): Promise<Result<Task>> {
  return guard(async () => createTaskAs(actorOf(await requireOrg(slug)), input));
}

export async function updateTask(slug: string, taskId: string, patch: TaskPatch): Promise<Result<Task>> {
  return guard(async () => updateTaskAs(actorOf(await requireOrg(slug)), oid(taskId, "task"), patch));
}

export async function deleteTask(slug: string, taskId: string): Promise<Result> {
  return guard(async () => deleteTaskAs(actorOf(await requireOrg(slug)), oid(taskId, "task")));
}

export async function addComment(slug: string, taskId: string, body: string): Promise<Result<FeedItem>> {
  return guard(async () => addCommentAs(actorOf(await requireOrg(slug)), oid(taskId, "task"), body));
}

export async function getTaskDetail(slug: string, key: string): Promise<Result<{ task: TaskDetail; feed: FeedItem[] }>> {
  return guard(async () => {
    const { org } = await requireOrg(slug);
    const found = await findTaskByKey(org._id, key);
    if (!found) throw new UserError("This task no longer exists.");
    const [refs, feed] = await Promise.all([loadTaskRefs(org._id, found.task), loadFeed(found.task._id)]);
    const [task] = await withWorkingBots([toTaskDetail(found.task, found.project.key, refs)]);
    return { task, feed };
  });
}

export async function getCounts(slug: string): Promise<Result<Counts>> {
  return guard(async () => {
    const { org, user } = await requireOrg(slug);
    return loadCounts(org._id, user._id);
  });
}

/** Tasks by title or key. With `recentWhenEmpty`, an empty query returns recently updated unarchived tasks (for pickers). */
export async function searchTasks(slug: string, q: string, opts: { recentWhenEmpty?: boolean } = {}): Promise<Result<Task[]>> {
  return guard(async () => {
    const { org } = await requireOrg(slug);
    const query = q.trim().slice(0, 100);
    const c = await cols();
    if (!query) {
      if (!opts.recentWhenEmpty) return [];
      const [docs, projects] = await Promise.all([
        c.tasks.find({ orgId: org._id, archivedAt: null }, { projection: { description: 0 } }).sort({ updatedAt: -1 }).limit(20).toArray(),
        c.projects.find({ orgId: org._id }, { projection: { key: 1 } }).toArray(),
      ]);
      const pk = new Map(projects.map((p) => [p._id.toHexString(), p.key]));
      return withWorkingBots(docs.map((d) => toTask(d as TaskDoc, pk.get(d.projectId.toHexString()) ?? "?")));
    }
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
    return withWorkingBots(docs.map((d) => toTask(d as TaskDoc, keys.get(d.projectId.toHexString()) ?? "?")));
  });
}
