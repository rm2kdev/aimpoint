"use client";

/**
 * Optimistic task writes for every screen (VEC-456, on VEC-453's queue in `lib/pending-actions.ts`). Rules live in
 * `task-writes-core.ts` (tested); the pattern is in `docs/optimistic-actions.md`.
 *
 *   writeTask({ task, label: "Status change", fields: { statusId }, run: () => updateTask(slug, task.id, { statusId }) });
 *
 * The change shows at once in every open view (list rows, the pane) through local events, reaches the server in the
 * background in per-task order, and an echo of an earlier write never flashes over a later one (the overlay). A
 * refusal puts the old values back and toasts; a network failure retries, then the task shows "Not sent" with Retry.
 */
import { useSyncExternalStore } from "react";
import { pendingActions, runPending, type ActionResult, type Settled } from "@/lib/pending-actions";
import { beforeOf, createPendingCreates, createTaskOverlay, type Fields } from "@/lib/task-writes-core";
import type { Task } from "@/lib/types";

export { isTempId } from "@/lib/task-writes-core";

/** Fields of writes still on their way, per task. Apply it to every task copy that comes from the server. */
export const taskOverlay = createTaskOverlay();
/** New tasks shown before the server gave them a key. */
export const pendingCreates = createPendingCreates();

/** A full task (from the server, or a temporary new one). Receivers lay `taskOverlay` over it. */
export const TASK_EVENT = "aimpoint:task";
/** Some fields of a task changed locally: `{id, fields}`, merged into whatever copy a view holds. */
export const TASK_PATCH_EVENT = "aimpoint:task-patch";
/** A task left locally (an optimistic delete, or a temporary row swapped for the real one): `{id}`. */
export const TASK_GONE_EVENT = "aimpoint:task-gone";

export interface TaskPatchDetail {
  id: string;
  fields: Partial<Task> & Fields;
}

/** Latest key of each task this tab saved: a project move changes it, and a queued move after it must use the new one. */
const savedKeys = new Map<string, string>();
export const keyOf = (id: string, fallback: string) => savedKeys.get(id) ?? fallback;

export const emitTask = (task: Task) => {
  if (task.key && task.number) savedKeys.set(task.id, task.key);
  window.dispatchEvent(new CustomEvent<Task>(TASK_EVENT, { detail: task }));
};
export const emitPatch = (id: string, fields: Fields) =>
  window.dispatchEvent(new CustomEvent<TaskPatchDetail>(TASK_PATCH_EVENT, { detail: { id, fields } }));
export const emitGone = (id: string) => window.dispatchEvent(new CustomEvent<{ id: string }>(TASK_GONE_EVENT, { detail: { id } }));

let seq = 0;
const token = () => `tw_${(seq++).toString(36)}`;

export interface TaskWrite<T> {
  /** The task as shown now (its current values are what a refusal puts back). */
  task: { id: string };
  /** For "<label> not sent" toasts. */
  label: string;
  /** The optimistic result, as task fields. */
  fields: Fields;
  run: () => Promise<ActionResult<T>>;
  /** Saved. The returned task is already sent to every view (`echo: false` to skip, e.g. a non-task result). */
  onSaved?: (data: T | undefined) => void;
  onRefused?: (error: string) => void;
  echo?: boolean;
}

/** One optimistic task write. Returns the queue item id and a promise of how it ended. */
export function writeTask<T = Task>(w: TaskWrite<T>): { id: string; done: Promise<Settled<T>> } {
  const id = w.task.id;
  const t = token();
  const before = beforeOf(w.task, w.fields);
  return runPending<T>({
    key: id,
    label: w.label,
    apply: () => {
      taskOverlay.add(t, id, w.fields);
      emitPatch(id, w.fields);
    },
    rollback: () => {
      taskOverlay.remove(t);
      emitPatch(id, taskOverlay.revert(id, before));
    },
    run: w.run,
    onSuccess: (data) => {
      taskOverlay.remove(t);
      if (w.echo !== false && data && typeof data === "object" && "id" in data) emitTask(data as unknown as Task);
      w.onSaved?.(data);
    },
    onRefused: w.onRefused,
  });
}

/** Deletes a task optimistically: it leaves every view at once and comes back if the server refuses. */
export function deleteTaskOptimistic(task: Task, run: () => Promise<ActionResult<unknown>>, onSaved?: () => void) {
  const t = token();
  return runPending({
    key: task.id,
    label: `Delete ${task.key}`,
    apply: () => {
      taskOverlay.addDelete(t, task.id);
      emitGone(task.id);
    },
    rollback: () => {
      taskOverlay.remove(t);
      emitTask(task);
    },
    run,
    onSuccess: () => {
      taskOverlay.markGone(task.id);
      taskOverlay.remove(t);
      onSaved?.();
    },
  });
}

/**
 * Creates a task optimistically: `temp` (a `tmp_` id, from `pendingCreates.newId()`) shows in the lists at once and
 * is swapped for the saved task when the server answers (or when its realtime echo lands first, see
 * `pendingCreates.claim`). A refusal removes the row and calls `onRefused`.
 */
export function createTaskOptimistic(temp: Task, run: () => Promise<ActionResult<Task>>, hooks: { onSaved?: (t: Task) => void; onRefused?: (error: string) => void } = {}) {
  return runPending<Task>({
    key: temp.id,
    label: `New task "${temp.title}"`,
    apply: () => {
      pendingCreates.register(temp);
      emitTask(temp);
    },
    rollback: () => {
      pendingCreates.forget(temp.id);
      emitGone(temp.id);
    },
    run,
    onSuccess: (real) => {
      if (real) pendingCreates.resolve(temp.id, real.id);
      emitGone(temp.id);
      if (real) emitTask(real);
      pendingCreates.forget(temp.id);
      if (real) hooks.onSaved?.(real);
    },
    onRefused: hooks.onRefused,
  });
}

/** TaskPatch -> the task fields it changes (the list and pane show these at once). */
export function patchFields(patch: object): Fields {
  const out: Fields = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (k === "archived") out.archivedAt = v ? new Date().toISOString() : null;
    else if (k === "triagePlan") continue; // the plan card shows its own copy
    else out[k] = v;
  }
  return out;
}

/** Words for "<label> not sent" toasts. */
export function patchLabel(patch: object): string {
  const p = patch as Record<string, unknown>;
  const k = Object.keys(p).filter((x) => p[x] !== undefined);
  if (k.length !== 1) return "Change";
  return (
    {
      title: "Rename",
      description: "Description",
      triagePlan: "Plan",
      type: "Type change",
      statusId: "Status change",
      assigneeId: "Assignee change",
      priority: "Priority change",
      projectId: "Project move",
      dueDate: "Due date change",
      archived: p.archived ? "Archive" : "Restore",
      dependsOn: "Dependency change",
      parentId: "Parent change",
    } as Record<string, string>
  )[k[0]] ?? "Change";
}

/* ----- per-task unsent state, for a row or pane marker ----- */

export type UnsentState = "sending" | "failed" | null;

/** "failed" if any write on the task is waiting for the person, "sending" while one is on its way, else null. */
function unsentOf(taskId: string): UnsentState {
  let state: UnsentState = null;
  for (const i of pendingActions.items()) {
    if (i.key !== taskId) continue;
    if (i.state === "failed") return "failed";
    state = "sending";
  }
  return state;
}

/** Re-renders only when this task's unsent state changes (cheap enough per list row). */
export function useUnsentState(taskId: string): UnsentState {
  return useSyncExternalStore(
    pendingActions.subscribe,
    () => unsentOf(taskId),
    () => null,
  );
}

/** Retry / discard every failed write on a task (the row and pane "Not sent" marker). */
export function retryTaskWrites(taskId: string) {
  pendingActions.items().forEach((i) => i.key === taskId && i.state === "failed" && pendingActions.retry(i.id));
}
export function discardTaskWrites(taskId: string) {
  // Newest first, so each rollback puts back the value the one before it replaced.
  [...pendingActions.items()].reverse().forEach((i) => i.key === taskId && i.state === "failed" && pendingActions.discard(i.id));
}
