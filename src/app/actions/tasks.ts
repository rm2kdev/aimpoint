"use server";

import { cols } from "@/lib/db";
import { requireOrg, type OrgContext } from "@/lib/session";
import { guard, UserError, type Result } from "@/lib/result";
import { findTaskByKey, loadCounts, loadFeed, toTask, toTaskDetail } from "@/lib/data";
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
