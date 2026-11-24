"use client";

/**
 * React side of the background action queue (VEC-453). One queue per tab, so actions from different components on
 * the same task still reach the server in order, and one registry of unsent work behind a single `beforeunload`
 * warning. The rules live in `pending-actions-core.ts` (tested); the pattern is described in
 * `docs/optimistic-actions.md`.
 *
 *   const { run } = usePendingActions();
 *   run({ key: task.id, label: "Rename", apply: () => setTitle(next), rollback: () => setTitle(prev),
 *         run: () => updateTask(slug, task.id, { title: next }) });
 *
 * Refusals toast their error (as the screens do today) after `rollback`; an item that can't reach the server
 * toasts once with a Retry action and stays listed as failed until retried or discarded.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { bindBeforeUnload, createActionQueue, createPendingRegistry, holdWhilePending, type ActionQueue, type ActionSpec, type PendingItem, type PendingRegistry } from "./pending-actions-core";

export type { ActionResult, ActionSpec, PendingItem, PendingState, Settled } from "./pending-actions-core";

/** Unsent work across the tab (actions, background uploads). Hold it with `pendingWork.hold(reason)`. */
export const pendingWork: PendingRegistry = createPendingRegistry();

/** The tab's action queue. Prefer `usePendingActions()` in components. */
export const pendingActions: ActionQueue = createActionQueue({
  onRefused: (_item, error) => toast.error(error),
  onFailed: (item, error) =>
    toast.error(`${item.label} not sent. ${error}`, {
      id: `pending-failed-${item.id}`,
      action: { label: "Retry", onClick: () => pendingActions.retry(item.id) },
    }),
});

let wired = false;
/** Attaches the window-level pieces once, on first client use (never during SSR). */
function wireWindow() {
  if (wired || typeof window === "undefined") return;
  wired = true;
  holdWhilePending(pendingActions, pendingWork, "actions");
  bindBeforeUnload(window, pendingWork);
  // Back online: send what failed for lack of a connection without making people click Retry on each.
  window.addEventListener("online", () => pendingActions.retryAll());
}

/** Attaches the leave-page warning (and online retry) for work held outside the action queue, e.g. editor uploads. */
export const ensureLeaveWarning = wireWindow;

const noItems: readonly PendingItem[] = [];

/**
 * Runs actions in the background and lists the unsent ones. `filter` narrows `items` (e.g. to one task's key);
 * keep it stable or cheap, it runs on every render.
 */
export function usePendingActions(filter?: (item: PendingItem) => boolean) {
  useEffect(wireWindow, []);
  const all = useSyncExternalStore(pendingActions.subscribe, pendingActions.items, () => noItems);
  const run = useCallback(<T,>(spec: ActionSpec<T>) => {
    wireWindow();
    return pendingActions.enqueue(spec);
  }, []);
  return {
    run,
    items: filter ? all.filter(filter) : all,
    retry: pendingActions.retry,
    discard: pendingActions.discard,
  };
}

/** One item's live state (null once it went through or was discarded), for a "Sending… / Not sent · Retry" line. */
export function usePendingItem(id: string | null | undefined): PendingItem | null {
  const all = useSyncExternalStore(pendingActions.subscribe, pendingActions.items, () => noItems);
  return id ? (all.find((i) => i.id === id) ?? null) : null;
}

/** Holds the leave-page warning while `active` (for work the queue doesn't know about, e.g. a draft being saved). */
export function useUnsentWork(active: boolean, reason = "work") {
  useEffect(() => {
    wireWindow();
    if (!active) return;
    return pendingWork.hold(reason);
  }, [active, reason]);
}
