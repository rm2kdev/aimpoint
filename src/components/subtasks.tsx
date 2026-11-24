"use client";

import { CornerLeftUpIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { PaneLink } from "@/lib/pane-url";
import { progressTitle } from "@/lib/subtask-groups-core";
import { storageKey } from "@/lib/stored-keys";
import type { Task, TaskChildren } from "@/lib/types";

/*
 * VEC-408: sub-tasks grouped under their parent in the task lists. Layout rules live in lib/subtask-groups-core.ts;
 * this file has the per-row stores (so a toggle or a live edit re-renders the affected group only) and the chips.
 */

const OPEN_KEY = storageKey("subtasks-open");

/** Parents whose sub-tasks are showing, remembered for the browser session (sessionStorage). Collapsed by default. */
export function createExpandedStore() {
  let open: Set<string> | null = null;
  const listeners = new Set<() => void>();
  const load = () => {
    if (open) return open;
    open = new Set();
    try {
      const raw: unknown = JSON.parse(sessionStorage.getItem(OPEN_KEY) ?? "[]");
      if (Array.isArray(raw)) for (const x of raw) if (typeof x === "string") open.add(x);
    } catch {}
    return open;
  };
  return {
    has: (id: string) => load().has(id),
    set: (id: string, on: boolean) => {
      const cur = load();
      if (cur.has(id) === on) return;
      open = new Set(cur);
      if (on) open.add(id);
      else open.delete(id);
      try {
        sessionStorage.setItem(OPEN_KEY, JSON.stringify([...open]));
      } catch {}
      listeners.forEach((l) => l());
    },
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
}
export type ExpandedStore = ReturnType<typeof createExpandedStore>;

const NONE: Task[] = [];

/** Each parent's sub-tasks in this view, by parent id. Arrays keep their identity while unchanged (stableChildren). */
export function createKidsStore() {
  let map = new Map<string, Task[]>();
  const listeners = new Set<() => void>();
  return {
    get: (id: string) => map.get(id) ?? NONE,
    all: () => map,
    replace: (next: Map<string, Task[]>) => {
      if (next === map) return;
      map = next;
      listeners.forEach((l) => l());
    },
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
}
export type KidsStore = ReturnType<typeof createKidsStore>;

/** "3/5 done" on a parent row: readable while the group is collapsed. Cancelled counts as closed. */
export function ProgressChip({ summary, className }: { summary: TaskChildren; className?: string }) {
  const closed = summary.done + summary.cancelled;
  const complete = closed >= summary.total;
  const title = progressTitle(summary);
  return (
    <span
      title={title}
      aria-label={title}
      data-subtask-progress=""
      className={cn(
        "tabular inline-flex h-5 shrink-0 items-center gap-1.5 rounded-[5px] bg-chip px-1.5 text-[11.5px] whitespace-nowrap text-muted-foreground",
        className,
      )}
    >
      <ProgressPie value={summary.total ? closed / summary.total : 0} complete={complete} />
      {/* VEC-412: in a tight list row (row-main container under 15rem) the chip drops "done" so the title keeps room. */}
      <span>
        {closed}/{summary.total}
        <span className="@max-[15rem]/row-main:hidden"> done</span>
      </span>
    </span>
  );
}

function ProgressPie({ value, complete }: { value: number; complete: boolean }) {
  const r = 4.5;
  const c = 2 * Math.PI * r;
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className={complete ? "text-brand" : "text-muted-foreground"}>
      <circle cx="6" cy="6" r={r} fill="none" stroke="currentColor" strokeOpacity={0.3} strokeWidth="1.6" />
      <circle
        cx="6"
        cy="6"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeDasharray={`${c * value} ${c}`}
        strokeLinecap={value > 0 && value < 1 ? "round" : "butt"}
        transform="rotate(-90 6 6)"
      />
    </svg>
  );
}

/** "Part of VEC-x" on a sub-task shown on its own (its parent isn't in this list) or in the task pane. */
export function PartOfLink({ parentKey, href, className }: { parentKey: string; href: string; className?: string }) {
  return (
    <PaneLink
      href={href}
      title={`Sub-task of ${parentKey}`}
      data-part-of={parentKey}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "relative z-10 inline-flex h-5 shrink-0 items-center gap-1 rounded-[5px] px-1 text-[11.5px] whitespace-nowrap text-faint transition-colors hover:bg-background hover:text-foreground",
        className,
      )}
    >
      <CornerLeftUpIcon className="size-3" />
      <span className="@max-[15rem]/row-main:hidden">Part of</span> <span className="tabular font-mono">{parentKey}</span>
    </PaneLink>
  );
}
