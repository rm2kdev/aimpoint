"use client";

import { useEffect, useState } from "react";
import { ArrowDownUpIcon, CalendarIcon, CircleDashedIcon, ListFilterIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useOrg } from "@/components/org-provider";
import { MemberAvatar, PriorityIcon, UnassignedAvatar } from "@/components/bits";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { daysUntil } from "@/lib/dates";
import { PRIORITY_LABELS } from "@/lib/format";
import { compareRank } from "@/lib/rank";
import type { Priority, Task } from "@/lib/types";
import { adoptLegacyKey } from "@/lib/stored-keys";

/* ---------------- model ---------------- */

export type SortKey = "manual" | "priority" | "due" | "created" | "created-asc" | "updated" | "title" | "archived";
export type DueFilter = "overdue" | "today" | "week" | "none";

export interface ViewState {
  sort: SortKey;
  /** member ids, plus "none" for unassigned */
  assignees: string[];
  priorities: Priority[];
  due: DueFilter[];
  /** Status ids in a project view, stage names in a cross-project view (VEC-117). */
  statuses: string[];
}

/** A status (or stage) a view can filter by. */
export interface StatusFilterOption {
  value: string;
  label: string;
  icon?: React.ReactNode;
}

export const SORT_LABELS: Record<SortKey, string> = {
  manual: "Manual",
  priority: "Priority",
  due: "Due date",
  created: "Newest",
  "created-asc": "Oldest",
  updated: "Recently updated",
  title: "Title",
  archived: "Recently archived",
};

const DUE_LABELS: Record<DueFilter, string> = {
  overdue: "Overdue",
  today: "Due today",
  week: "Due in the next 7 days",
  none: "No due date",
};

const EMPTY: Omit<ViewState, "sort"> = { assignees: [], priorities: [], due: [], statuses: [] };

/**
 * Saved-state version. v1 (before VEC-57) saved the sort on every visit, so a saved "priority" there was
 * usually just the old default: it no longer overrides the new default (Manual). v2 keeps whatever is saved.
 */
const VIEW_STATE_VERSION = 2;

/** Per-view sort/filter, remembered in localStorage under the view's path. */
export function useViewState(storageKey: string, defaultSort: SortKey) {
  const [state, setState] = useState<ViewState>({ sort: defaultSort, ...EMPTY });
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  useEffect(() => {
    try {
      adoptLegacyKey(localStorage, storageKey);
      const raw = localStorage.getItem(storageKey);
      const saved = raw ? (JSON.parse(raw) as Partial<ViewState> & { v?: number }) : {};
      const legacyDefault = (saved.v ?? 1) < VIEW_STATE_VERSION && saved.sort === "priority";
      // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is client-only; read after hydration
      setState({
        sort: saved.sort && saved.sort in SORT_LABELS && !legacyDefault ? saved.sort : defaultSort,
        assignees: Array.isArray(saved.assignees) ? saved.assignees : [],
        priorities: Array.isArray(saved.priorities) ? saved.priorities : [],
        due: Array.isArray(saved.due) ? saved.due : [],
        statuses: Array.isArray(saved.statuses) ? saved.statuses.filter((s): s is string => typeof s === "string") : [],
      });
    } catch {
      setState({ sort: defaultSort, ...EMPTY });
    }
    setLoadedKey(storageKey);
  }, [storageKey, defaultSort]);

  useEffect(() => {
    if (loadedKey === storageKey) localStorage.setItem(storageKey, JSON.stringify({ ...state, v: VIEW_STATE_VERSION }));
  }, [state, storageKey, loadedKey]);

  return [state, setState] as const;
}

export function filterCount(v: ViewState) {
  return v.assignees.length + v.priorities.length + v.due.length + v.statuses.length;
}

/** `statusKey` gives the value a task's status filters by (its status id, or its stage in cross-project views). */
export function applyFilters(tasks: Task[], v: ViewState, statusKey?: (t: Task) => string) {
  return tasks.filter((t) => {
    if (v.statuses.length && statusKey && !v.statuses.includes(statusKey(t))) return false;
    if (v.assignees.length && !v.assignees.includes(t.assigneeId ?? "none")) return false;
    if (v.priorities.length && !v.priorities.includes(t.priority)) return false;
    if (v.due.length) {
      const n = t.dueDate ? daysUntil(t.dueDate) : null;
      const hit = v.due.some((d) =>
        d === "none" ? n === null : n !== null && (d === "overdue" ? n < 0 : d === "today" ? n === 0 : n >= 0 && n <= 7),
      );
      if (!hit) return false;
    }
    return true;
  });
}

const newest = (a: Task, b: Task) => b.createdAt.localeCompare(a.createdAt) || b.number - a.number;

export function comparator(sort: SortKey): (a: Task, b: Task) => number {
  switch (sort) {
    case "manual":
      // Shared manual order (lib/rank.ts): identical for every member, ties broken by id.
      return compareRank;
    case "due":
      // Dated tasks first, soonest first; undated fall to the bottom by priority.
      return (a, b) =>
        (a.dueDate && b.dueDate ? a.dueDate.localeCompare(b.dueDate) : a.dueDate ? -1 : b.dueDate ? 1 : 0) ||
        b.priority - a.priority ||
        newest(a, b);
    case "created":
      return newest;
    case "created-asc":
      return (a, b) => -newest(a, b);
    case "updated":
      return (a, b) => b.updatedAt.localeCompare(a.updatedAt);
    case "title":
      return (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true });
    case "archived":
      return (a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? "");
    default:
      return (a, b) => b.priority - a.priority || newest(a, b);
  }
}

/* ---------------- UI ---------------- */

const triggerCls =
  "inline-flex h-[28px] items-center gap-1.5 rounded-lg px-2 text-[12.5px] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent data-[state=open]:text-foreground";

const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

export function SortMenu({ value, onChange, options }: { value: SortKey; onChange: (s: SortKey) => void; options: SortKey[] }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={triggerCls} aria-label={`Sort by ${SORT_LABELS[value]}`}>
        <ArrowDownUpIcon className="size-3.5" />
        <span className="max-md:hidden">{SORT_LABELS[value]}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel className="text-xs font-normal text-faint">Sort by</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={(v) => onChange(v as SortKey)}>
          {options.map((o) => (
            <DropdownMenuRadioItem key={o} value={o}>
              {SORT_LABELS[o]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function FilterMenu({
  value,
  onChange,
  hideAssignee,
  statusOptions,
  statusLabel = "Status",
}: {
  value: ViewState;
  onChange: (v: ViewState) => void;
  hideAssignee?: boolean;
  /** The view's statuses (a project view) or stages (cross-project views); no Status filter without them. */
  statusOptions?: StatusFilterOption[];
  statusLabel?: string;
}) {
  const { members, me } = useOrg();
  const n = filterCount(value);
  const people = members.filter((m) => m.kind === "user").sort((a, b) => (a.id === me.id ? -1 : b.id === me.id ? 1 : 0));
  const bots = members.filter((m) => m.kind === "bot");
  const keep = (e: Event) => e.preventDefault(); // keep the menu open while ticking several boxes

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={cn(triggerCls, n > 0 && "text-foreground")} aria-label={n ? `Filters (${n} active)` : "Filter"}>
        <ListFilterIcon className="size-3.5" />
        <span className="max-md:hidden">Filter</span>
        {n > 0 && <span className="tabular grid h-4 min-w-4 place-items-center rounded-full bg-foreground px-1 text-[11px] font-medium text-background">{n}</span>}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {statusOptions && statusOptions.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-2.5">
              <CircleDashedIcon className="size-4 text-muted-foreground" /> {statusLabel}
              {value.statuses.length > 0 && <Count n={value.statuses.length} />}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-[320px] w-52 overflow-y-auto">
              {statusOptions.map((o) => (
                <DropdownMenuCheckboxItem
                  key={o.value}
                  checked={value.statuses.includes(o.value)}
                  onSelect={keep}
                  onCheckedChange={() => onChange({ ...value, statuses: toggle(value.statuses, o.value) })}
                  className="gap-2.5"
                >
                  {o.icon}
                  <span className="truncate">{o.label}</span>
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {!hideAssignee && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-2.5">
              <UnassignedAvatar size={16} /> Assignee
              {value.assignees.length > 0 && <Count n={value.assignees.length} />}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-[320px] w-56 overflow-y-auto">
              <DropdownMenuCheckboxItem checked={value.assignees.includes("none")} onSelect={keep} onCheckedChange={() => onChange({ ...value, assignees: toggle(value.assignees, "none") })} className="gap-2.5">
                <UnassignedAvatar size={16} /> Unassigned
              </DropdownMenuCheckboxItem>
              {[...people, ...bots].map((m) => (
                <DropdownMenuCheckboxItem
                  key={m.id}
                  checked={value.assignees.includes(m.id)}
                  onSelect={keep}
                  onCheckedChange={() => onChange({ ...value, assignees: toggle(value.assignees, m.id) })}
                  className="gap-2.5"
                >
                  <MemberAvatar member={m} id={m.id} size={16} />
                  <span className="truncate">{m.id === me.id ? `${m.name} (you)` : m.name}</span>
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="gap-2.5">
            <PriorityIcon priority={3} /> Priority
            {value.priorities.length > 0 && <Count n={value.priorities.length} />}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-44">
            {([3, 2, 1, 0] as Priority[]).map((p) => (
              <DropdownMenuCheckboxItem
                key={p}
                checked={value.priorities.includes(p)}
                onSelect={keep}
                onCheckedChange={() => onChange({ ...value, priorities: toggle(value.priorities, p) })}
                className="gap-2.5"
              >
                <PriorityIcon priority={p} /> {PRIORITY_LABELS[p]}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="gap-2.5">
            <CalendarIcon className="size-4 text-muted-foreground" /> Due date
            {value.due.length > 0 && <Count n={value.due.length} />}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52">
            {(Object.keys(DUE_LABELS) as DueFilter[]).map((d) => (
              <DropdownMenuCheckboxItem key={d} checked={value.due.includes(d)} onSelect={keep} onCheckedChange={() => onChange({ ...value, due: toggle(value.due, d) })}>
                {DUE_LABELS[d]}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {n > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onChange({ ...value, ...EMPTY })} className="text-muted-foreground">
              Clear filters
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Count({ n }: { n: number }) {
  return <span className="tabular ml-auto font-mono text-[11.5px] text-faint">{n}</span>;
}

/** Removable chips for the active filters, shown under the view header. */
export function FilterChips({
  value,
  onChange,
  statusOptions = [],
}: {
  value: ViewState;
  onChange: (v: ViewState) => void;
  statusOptions?: StatusFilterOption[];
}) {
  const { memberById, me } = useOrg();
  if (!filterCount(value)) return null;
  const chips: { key: string; label: React.ReactNode; remove: () => void }[] = [
    ...value.statuses.map((v) => {
      const o = statusOptions.find((x) => x.value === v);
      return {
        key: `s${v}`,
        label: (
          <>
            {o?.icon}
            {o?.label ?? "A removed status"}
          </>
        ),
        remove: () => onChange({ ...value, statuses: value.statuses.filter((x) => x !== v) }),
      };
    }),
    ...value.assignees.map((id) => {
      const m = memberById.get(id);
      return {
        key: `a${id}`,
        label: (
          <>
            {m ? <MemberAvatar member={m} id={m.id} size={14} /> : <UnassignedAvatar size={13} />}
            {id === "none" ? "Unassigned" : id === me.id ? "You" : (m?.name ?? "Former member")}
          </>
        ),
        remove: () => onChange({ ...value, assignees: value.assignees.filter((x) => x !== id) }),
      };
    }),
    ...value.priorities.map((p) => ({
      key: `p${p}`,
      label: (
        <>
          <PriorityIcon priority={p} /> {PRIORITY_LABELS[p]}
        </>
      ),
      remove: () => onChange({ ...value, priorities: value.priorities.filter((x) => x !== p) }),
    })),
    ...value.due.map((d) => ({
      key: `d${d}`,
      label: (
        <>
          <CalendarIcon className="size-3.5" /> {DUE_LABELS[d]}
        </>
      ),
      remove: () => onChange({ ...value, due: value.due.filter((x) => x !== d) }),
    })),
  ];
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2 sm:px-7">
      {chips.map((c) => (
        <span key={c.key} className="inline-flex h-6 items-center gap-1.5 rounded-md bg-chip pr-0.5 pl-2 text-[12px] text-foreground">
          {c.label}
          <button onClick={c.remove} aria-label="Remove filter" className="grid size-5 place-items-center rounded text-faint hover:bg-accent hover:text-foreground">
            <XIcon className="size-3" />
          </button>
        </span>
      ))}
      <button onClick={() => onChange({ ...value, ...EMPTY })} className="ml-1 h-6 rounded-md px-1.5 text-[12px] text-muted-foreground hover:text-foreground">
        Clear
      </button>
    </div>
  );
}

