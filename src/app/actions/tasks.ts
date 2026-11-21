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
  moveTask,
  oid,
  updateTaskAs,
  type Actor,
  type MoveInput,
  type NewTaskInput,
  type TaskPatch,
} from "@/lib/task-service";
import { retryHandOff } from "@/lib/retry-handoff";
import { advanceStepAs, moveStalledOnAs, setFlowPausedAs } from "@/lib/flow-actions";
import { resumeWorkAs, stopWorkAs } from "@/lib/stop-work";
import type { CommentResult, Counts, FeedItem, ResumeOutcome, RetryOutcome, Task, TaskDetail, TaskDoc } from "@/lib/types";

export type { MoveInput, NewTaskInput, TaskPatch };

const actorOf = ({ org, user, isAdmin }: OrgContext): Actor => ({ orgId: org._id, id: user._id, isAdmin });

export async function createTask(slug: string, input: NewTaskInput): Promise<Result<Task>> {
  return guard(async () => createTaskAs(actorOf(await requireOrg(slug)), input));
}

export async function updateTask(slug: string, taskId: string, patch: TaskPatch): Promise<Result<Task>> {
  return guard(async () => updateTaskAs(actorOf(await requireOrg(slug)), oid(taskId, "task"), patch));
}

/**
 * Reorder a task and/or change its status or project in one write (VEC-57). `beforeKey` / `afterKey` are the
 * keys of its new neighbours (it goes above `beforeKey`, below `afterKey`). Creator or admin only.
 */
export async function moveTaskAction(slug: string, taskKey: string, move: MoveInput): Promise<Result<Task>> {
  return guard(async () => moveTask(actorOf(await requireOrg(slug)), taskKey, move ?? {}));
}

/**
 * Hand a stalled task to its bot again, or, for a task waiting on others, the open ready tasks at the front of its
 * chain (VEC-159). Creator, assignee or admin. Without `force`, a bot that posted in the last few minutes is left be.
 */
export async function retryTask(slug: string, taskId: string, force = false): Promise<Result<RetryOutcome>> {
  return guard(async () => retryHandOff(actorOf(await requireOrg(slug)), oid(taskId, "task"), { force: force === true }));
}

/**
 * The task pane's flow step action (VEC-183): a wait step's "<wait label>" button or "Complete step" on a step a
 * person holds. Moves it to the next step (like advance_task), posting `comment` first when given. `stepId` is the
 * step shown, so a stale pane can't move it twice.
 */
export async function advanceTaskStep(slug: string, taskId: string, stepId: string, comment: string | null): Promise<Result<Task>> {
  return guard(async () => advanceStepAs(actorOf(await requireOrg(slug)), oid(taskId, "task"), { stepId: String(stepId ?? ""), comment: typeof comment === "string" ? comment : null }));
}

/**
 * "Move to <next step>" on a Stalled flow task (VEC-317): its bot finished the step but the task never moved. Creator
 * or admin. Same advance as complete_task without a status; `stepId` is the step shown, so it can't move twice.
 */
export async function moveStalledTaskOn(slug: string, taskId: string, stepId: string): Promise<Result<Task>> {
  return guard(async () => moveStalledOnAs(actorOf(await requireOrg(slug)), oid(taskId, "task"), { stepId: String(stepId ?? "") }));
}

/** Pause / Resume the task's flow (VEC-183): creator, assignee or admin. Resuming re-syncs it by status. */
export async function setTaskFlowPaused(slug: string, taskId: string, paused: boolean): Promise<Result<Task>> {
  return guard(async () => setFlowPausedAs(actorOf(await requireOrg(slug)), oid(taskId, "task"), paused === true));
}

/**
 * Stop the bot working on this task (VEC-215): its claim ends (state stopped), the flow pauses, an In Progress task
 * goes back to Todo, and no wake-up goes out for it until Resume. Creator, the bot's owner or an admin.
 */
export async function stopTaskWork(slug: string, taskId: string): Promise<Result<Task>> {
  return guard(async () => stopWorkAs(actorOf(await requireOrg(slug)), oid(taskId, "task")));
}

/** Resume a stopped task (VEC-215): clears the stop, resumes its flow and hands it back to its bot with one wake-up. */
export async function resumeTaskWork(slug: string, taskId: string): Promise<Result<ResumeOutcome>> {
  return guard(async () => resumeWorkAs(actorOf(await requireOrg(slug)), oid(taskId, "task")));
}

export async function deleteTask(slug: string, taskId: string): Promise<Result> {
  return guard(async () => deleteTaskAs(actorOf(await requireOrg(slug)), oid(taskId, "task")));
}

/** Adds a comment. `heldMentions` lists mentioned bots that are disabled: stored, but not delivered until enabled (VEC-352). */
export async function addComment(slug: string, taskId: string, body: string): Promise<Result<CommentResult>> {
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
