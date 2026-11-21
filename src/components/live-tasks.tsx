"use client";

import { useState } from "react";
import { useOrgEvents } from "@/components/org-provider";
import type { Task } from "@/lib/types";

/**
 * VEC-381: keep a fetched snapshot of tasks (command menu results, a settings Work list) in step with live task.upsert
 * events, so their status rings start and stop spinning without a refresh, like the list rows and the task pane.
 * Overrides are dropped when a new snapshot arrives (it is at least as fresh); deleted tasks drop out.
 */
export function useLiveTasks<T extends Task>(tasks: T[]): T[] {
  const [live, setLive] = useState<{ base: T[]; over: Map<string, Task>; gone: Set<string> }>({ base: tasks, over: new Map(), gone: new Set() });
  let state = live;
  if (live.base !== tasks) {
    // New snapshot: adjust during render (no effect) and start over from it.
    state = { base: tasks, over: new Map(), gone: new Set() };
    setLive(state);
  }
  useOrgEvents((e) => {
    if (e.type === "task.upsert") {
      if (!tasks.some((t) => t.id === e.task.id)) return;
      setLive((cur) => ({ ...cur, over: new Map(cur.over).set(e.task.id, e.task) }));
    } else if (e.type === "task.delete") {
      if (!tasks.some((t) => t.id === e.taskId)) return;
      setLive((cur) => ({ ...cur, gone: new Set(cur.gone).add(e.taskId) }));
    }
  });
  if (!state.over.size && !state.gone.size) return tasks;
  return tasks
    .filter((t) => !state.gone.has(t.id))
    .map((t) => {
      const o = state.over.get(t.id);
      return o && o.updatedAt >= t.updatedAt ? ({ ...t, ...o } as T) : t;
    });
}
