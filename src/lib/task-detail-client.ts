"use client";

import type { Result } from "@/lib/result";
import type { FeedItem, Task, TaskDetail } from "@/lib/types";

/**
 * The task pane's data on the client (VEC-458): fetched from /api/task-detail (a GET, so it never queues behind the
 * server actions still on their way, as the getTaskDetail action did), shared by concurrent callers, and kept for a
 * short while so reopening a task or stepping back with j/k shows it at once. A kept copy is only a first paint:
 * the pane always fetches again and takes the fresh copy.
 */
export type PaneData = { task: TaskDetail; feed: FeedItem[] };

const KEEP_MS = 60_000;
const MAX = 40;
const kept = new Map<string, { at: number; data: PaneData }>();
const inflight = new Map<string, Promise<Result<PaneData>>>();
const id = (slug: string, key: string) => `${slug}/${key}`;

export function fetchTaskDetail(slug: string, key: string): Promise<Result<PaneData>> {
  const k = id(slug, key);
  const running = inflight.get(k);
  if (running) return running;
  const p = fetch(`/api/task-detail?org=${encodeURIComponent(slug)}&key=${encodeURIComponent(key)}`, { cache: "no-store" })
    .then(async (res): Promise<Result<PaneData>> => {
      if (!res.ok) return { ok: false, error: res.status === 401 || res.status === 403 ? "You are signed out. Sign in and try again." : "Something went wrong. Try again." };
      return (await res.json()) as Result<PaneData>;
    })
    .catch((): Result<PaneData> => ({ ok: false, error: "Couldn't reach Aimpoint. Check your connection and try again." }))
    .then((r) => {
      inflight.delete(k);
      if (r.ok && r.data) rememberTaskDetail(slug, key, r.data);
      else kept.delete(k);
      return r;
    });
  inflight.set(k, p);
  return p;
}

/** Warm the copy for a task the user is likely to open next (row hover, j/k neighbours). */
export function prefetchTaskDetail(slug: string, key: string) {
  const c = kept.get(id(slug, key));
  if (c && Date.now() - c.at < KEEP_MS / 2) return;
  void fetchTaskDetail(slug, key);
}

/** A recent copy of the task's pane data, with the live list copy (`latest`) laid over its task fields. */
export function keptTaskDetail(slug: string, key: string, latest?: Task): PaneData | null {
  const c = kept.get(id(slug, key));
  if (!c || Date.now() - c.at > KEEP_MS) return null;
  if (!latest || latest.id !== c.data.task.id) return c.data;
  return { ...c.data, task: { ...c.data.task, ...latest } };
}

/** Store the pane's current copy (it stays live through realtime events while the pane is open). */
export function rememberTaskDetail(slug: string, key: string, data: PaneData) {
  const k = id(slug, key);
  kept.delete(k);
  kept.set(k, { at: Date.now(), data });
  if (kept.size > MAX) kept.delete(kept.keys().next().value!);
}

/** Drop the kept copy (the task changed in a way the list copy can't carry, or it was deleted). */
export function forgetTaskDetail(slug: string, key: string) {
  kept.delete(id(slug, key));
}

/**
 * The pane's first paint from the list's copy of the task: header and properties at once, while the description,
 * relations and comments load (`partial`).
 */
export function seedDetail(t: Task): TaskDetail {
  return { ...t, description: "", triagePlan: null, triagePlanBy: null, triagePlanAt: null, dependencies: [], dependents: [], subtasks: [] };
}
