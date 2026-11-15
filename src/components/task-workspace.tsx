"use client";

import Link from "next/link";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArchiveIcon, ArchiveRestoreIcon, ChevronDownIcon, PlusIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { taskAccess } from "@/lib/access";
import { useOrg, useOrgBase, useOrgEvents } from "@/components/org-provider";
import { MobileNavButton, useShell } from "@/components/app-shell";
import { Kbd, MemberAvatar, PriorityIcon, ProjectDot, StatusRing, TypeTag, UserAvatar } from "@/components/bits";
import { TaskStatusRing } from "@/components/task-status-ring";
import { LazyPicker, useStatusOptions } from "@/components/pickers";
import { TaskPane } from "@/components/task-pane";
import { useTaskContextMenu } from "@/components/task-context-menu";
import { DueBadge } from "@/components/due-date";
import { StalledBadge, WaitingBadge } from "@/components/dependencies";
import { applyFilters, comparator, FilterChips, FilterMenu, filterCount, SortMenu, useViewState, type SortKey } from "@/components/view-options";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SortableList, useDragSelector, useDropTarget, type DragItem, type SortableHandleProps } from "@/components/ui/sortable-list";
import { useDragStore } from "@/components/ui/drag-provider";
import { timeAgo } from "@/lib/format";
import { moveTaskAction, updateTask, type TaskPatch } from "@/app/actions/tasks";
import { compareRank, rankBetween } from "@/lib/rank";
import { TASK_DRAG_GROUP as TASK_GROUP } from "@/lib/task-drag";
import type { Status, Task, TaskType } from "@/lib/types";

export interface Scope {
  projectId?: string;
  mine?: boolean;
  archived?: boolean;
}

type TypeFilter = "all" | TaskType;

const SORTS: SortKey[] = ["manual", "priority", "due", "created", "created-asc", "updated", "title"];
const ARCHIVE_SORTS: SortKey[] = ["archived", "due", "created", "updated", "title"];

export function TaskWorkspace({
  title,
  scope,
  initialTasks,
  showProject,
  emptyHint,
}: {
  title: string;
  scope: Scope;
  initialTasks: Task[];
  showProject: boolean;
  emptyHint: string;
}) {
  const { org, me, statuses, isAdmin, projectById } = useOrg();
  const { newTask, setViewDefaults } = useShell();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const selectedKey = params.get("task");

  const [tasks, setTasks] = useState<Map<string, Task>>(() => new Map(initialTasks.map((t) => [t.id, t])));
  // Newest version of every task this view has seen (incl. ones that left it). A server refresh can be
  // older than a change we already applied (e.g. archive, then navigate): never let it roll that back.
  const latest = useRef(new Map<string, Task>());

  // Rows a teammate changed live: id -> actor id. Cleared once seen (hovered or opened). A small store each
  // row subscribes to for its own id, so a highlight re-renders that row only (VEC-73).
  const [freshStore] = useState(createFreshStore);
  const setFresh = freshStore.update;
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  // Manual (shared drag order) is the default for project views and All; My tasks keeps priority.
  const [view, setView] = useViewState(`vector:view:${pathname}`, scope.archived ? "archived" : scope.mine ? "priority" : "manual");
  const [collapsed, toggleGroup] = useCollapsedGroups(`vector:collapsed:${pathname}`);

  useEffect(() => {
    setViewDefaults({ projectId: scope.projectId, assigneeId: scope.mine ? me.id : undefined });
    return () => setViewDefaults({});
  }, [scope.projectId, scope.mine, me.id, setViewDefaults]);

  const matches = useCallback(
    (t: Task) =>
      !!t.archivedAt === !!scope.archived &&
      (!scope.projectId || t.projectId === scope.projectId) &&
      (!scope.mine || t.assigneeId === me.id),
    [scope.projectId, scope.mine, scope.archived, me.id],
  );

  useEffect(() => {
    const next = new Map<string, Task>();
    for (const t of initialTasks) {
      const seen = latest.current.get(t.id);
      next.set(t.id, seen && seen.updatedAt > t.updatedAt ? seen : t);
    }
    latest.current.forEach((t) => {
      if (!next.has(t.id) && matches(t)) next.set(t.id, t);
    });
    next.forEach((t, id) => !matches(t) && next.delete(id));
    setTasks(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTasks]);

  const upsert = useCallback(
    (t: Task) =>
      setTasks((prev) => {
        const seen = latest.current.get(t.id);
        if (!seen || seen.updatedAt <= t.updatedAt) latest.current.set(t.id, t);
        const next = new Map(prev);
        if (matches(t)) next.set(t.id, t);
        else next.delete(t.id);
        return next;
      }),
    [matches],
  );

  const mark = (id: string, actorId: string, verb: string) =>
    setFresh((f) => new Map(f).set(id, { actorId, verb, at: Date.now() }));

  useOrgEvents((e) => {
    if (e.type === "task.upsert") {
      const prev = tasks.get(e.task.id);
      upsert(e.task);
      // A bot starting or stopping work isn't an edit: no "changed" highlight for that.
      if (!e.workingOnly && e.actorId !== me.id && matches(e.task) && e.task.key !== selectedKey) {
        const verb = !prev
          ? "added this"
          : prev.statusId !== e.task.statusId
            ? "moved this"
            : prev.assigneeId !== e.task.assigneeId
              ? "reassigned this"
              : prev.rank !== e.task.rank
                ? "reordered this"
                : "edited this";
        mark(e.task.id, e.actorId, verb);
      }
    } else if (e.type === "feed.add" && e.item.kind === "comment" && e.actorId !== me.id) {
      const t = tasks.get(e.taskId);
      if (t && t.key !== selectedKey) mark(t.id, e.actorId, e.item.mentions?.includes(me.id) ? "mentioned you" : "commented");
    } else if (e.type === "task.delete") {
      latest.current.delete(e.taskId);
      setTasks((prev) => {
        if (!prev.has(e.taskId)) return prev;
        const next = new Map(prev);
        next.delete(e.taskId);
        return next;
      });
    }
  });

  useEffect(() => {
    const onLocal = (e: Event) => upsert((e as CustomEvent<Task>).detail);
    window.addEventListener("vector:task", onLocal);
    return () => window.removeEventListener("vector:task", onLocal);
  }, [upsert]);

  const seen = useCallback(
    (id: string) => {
      setFresh((f) => {
        if (!f.has(id)) return f;
        const n = new Map(f);
        n.delete(id);
        return n;
      });
    },
    [setFresh],
  );

  const visible = useMemo(
    () => applyFilters([...tasks.values()].filter((t) => typeFilter === "all" || t.type === typeFilter), view),
    [tasks, typeFilter, view],
  );
  const filtering = typeFilter !== "all" || filterCount(view) > 0;
  const clearFilters = () => {
    setTypeFilter("all");
    setView((v) => ({ ...v, assignees: [], priorities: [], due: [] }));
  };

  const groups = useMemo(() => {
    const out: { status: Status; tasks: Task[] }[] = [];
    const cmp = comparator(view.sort);
    for (const s of statuses) {
      // Every status gets a section, empty ones included, so there is always somewhere to drop a task.
      out.push({ status: s, tasks: visible.filter((t) => t.statusId === s.id).sort(cmp) });
    }
    // Tasks whose status was deleted mid-session.
    const known = new Set(statuses.map((s) => s.id));
    const orphans = visible.filter((t) => !known.has(t.statusId));
    if (orphans.length && statuses[0]) out[0]?.tasks.push(...orphans);
    return out;
  }, [visible, statuses, view.sort]);
  const archivedList = useMemo(() => (scope.archived ? [...visible].sort(comparator(view.sort)) : []), [scope.archived, visible, view.sort]);

  const isClosed = (s: Status) => s.category === "done" || s.category === "cancelled";
  const openCount = groups.reduce((n, g) => n + (isClosed(g.status) ? 0 : g.tasks.length), 0);
  const shown = useMemo(() => (scope.archived ? [] : groups), [scope.archived, groups]);
  // Done and cancelled groups start folded until opened from their heading.
  const isFolded = (s: Status) => collapsed.get(s.id) ?? isClosed(s);

  /* ----- selection & keyboard ----- */
  // Tasks in folded groups are out of sight, so j/k skips them.
  const flat = useMemo(
    () => (scope.archived ? archivedList : shown.flatMap((g) => ((collapsed.get(g.status.id) ?? isClosed(g.status)) ? [] : g.tasks))),
    [scope.archived, archivedList, shown, collapsed],
  );

  /* ----- glide rows to their new position (FLIP) ----- */
  // Runs only when the rendered order changes (rows moved, added, removed, a group folded), not on every
  // render: measuring every row per render made each realtime edit and drag commit a full-list layout read
  // (VEC-73). Mid-drag, positions are recorded without animating, so rows don't slide under the pointer.
  const dragStore = useDragStore();
  const rowEls = useRef(new Map<string, HTMLElement>());
  const lastTop = useRef(new Map<string, number>());
  const scrollRef = useRef<HTMLDivElement>(null);
  const order = useMemo(() => flat.map((t) => `${t.id}:${t.statusId}`).join(","), [flat]);
  // A pointer drop: where every row shows right now, gap shifts included (VEC-96), so the glide after the
  // drop starts from there rather than from where the rows sat before the drag. The dropped row is left out:
  // the floating card carries it into place. Dropped a frame later if the drop changed no order.
  const dropTop = useRef<Map<string, number> | null>(null);
  useEffect(
    () =>
      dragStore?.onEnd((item, dropped) => {
        if (!dropped || dragStore.get()?.mode !== "pointer") return;
        const box = scrollRef.current;
        const origin = box ? box.getBoundingClientRect().top - box.scrollTop : 0;
        // Rows far off screen don't glide (below), so their old position is enough: read only the rest.
        const lo = box ? box.scrollTop - box.clientHeight : -Infinity;
        const hi = box ? box.scrollTop + box.clientHeight * 2 : Infinity;
        const at = new Map(lastTop.current);
        rowEls.current.forEach((el, id) => {
          const was = lastTop.current.get(id);
          if (id === item.id) at.delete(id);
          else if (was === undefined || (was > lo && was < hi)) at.set(id, el.getBoundingClientRect().top - origin);
        });
        dropTop.current = at;
        requestAnimationFrame(() => {
          if (dropTop.current === at) dropTop.current = null;
        });
      }),
    [dragStore],
  );
  useLayoutEffect(() => {
    const next = new Map<string, number>();
    // Position within the scrolled content, so scrolling between renders doesn't read as a move.
    const box = scrollRef.current;
    const origin = box ? box.getBoundingClientRect().top - box.scrollTop : 0;
    const glide = !dragStore?.get() && !matchMedia("(prefers-reduced-motion: reduce)").matches;
    const before = dropTop.current ?? lastTop.current;
    dropTop.current = null;
    // Only rows that are (or were) on screen glide: a drop into another group moves every row below it, and
    // animating hundreds of off-screen rows made the drop a long task (VEC-96).
    const viewTop = box ? box.scrollTop - box.clientHeight / 2 : -Infinity;
    const viewBottom = box ? box.scrollTop + box.clientHeight * 1.5 : Infinity;
    const onScreen = (y: number) => y > viewTop && y < viewBottom;
    rowEls.current.forEach((el, id) => {
      const top = el.getBoundingClientRect().top - origin;
      next.set(id, top);
      const prev = before.get(id);
      if (glide && prev !== undefined && Math.abs(prev - top) > 2 && (onScreen(prev) || onScreen(top))) {
        el.animate([{ transform: `translateY(${prev - top}px)` }, { transform: "translateY(0)" }], {
          duration: 380,
          easing: "cubic-bezier(.2,.8,.2,1)",
        });
      }
    });
    lastTop.current = next;
  }, [order, dragStore]);
  const open = useCallback(
    (key: string | null) => {
      const q = new URLSearchParams(params.toString());
      if (key) q.set("task", key);
      else q.delete("task");
      const s = q.toString();
      router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );
  // The pane re-renders on its own data, not whenever the list does (a live edit mid-drag, VEC-73).
  const closePane = useCallback(() => open(null), [open]);
  /** Archive or restore with an optimistic move and an Undo toast. */
  const setArchived = async (task: Task, archived: boolean, undo = true) => {
    upsert({ ...task, archivedAt: archived ? new Date().toISOString() : null });
    const r = await updateTask(org.slug, task.id, { archived });
    if (!r.ok) {
      upsert(task);
      return void toast.error(r.error);
    }
    if (r.data) window.dispatchEvent(new CustomEvent<Task>("vector:task", { detail: r.data }));
    if (undo) {
      toast.success(`${archived ? "Archived" : "Restored"} ${task.key}`, {
        description: task.title,
        action: { label: "Undo", onClick: () => setArchived(r.data ?? task, !archived, false) },
      });
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || e.metaKey || e.ctrlKey) return;
      if (document.querySelector("[role=dialog],[data-radix-popper-content-wrapper]")) return;
      // A row lifted for a keyboard (or pointer) reorder owns the keys until it's dropped.
      if (document.querySelector("[data-sortable-list][data-dragging]")) return;
      if (e.key === "Escape" && selectedKey) return open(null);
      if (e.key === "j" || e.key === "k" || e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!flat.length) return;
        e.preventDefault();
        const i = flat.findIndex((x) => x.key === selectedKey);
        const d = e.key === "j" || e.key === "ArrowDown" ? 1 : -1;
        const nextTask = flat[Math.max(0, Math.min(flat.length - 1, i < 0 ? 0 : i + d))];
        open(nextTask.key);
        rowEls.current.get(nextTask.id)?.scrollIntoView({ block: "nearest" });
      }
      if (e.key === "e" && selectedKey) {
        const t = flat.find((x) => x.key === selectedKey);
        if (t && (isAdmin || t.createdBy === me.id)) {
          e.preventDefault();
          const i = flat.indexOf(t);
          const next = flat[i + 1] ?? flat[i - 1];
          setArchived(t, !t.archivedAt);
          open(next ? next.key : null);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setArchived is recreated each render
  }, [flat, selectedKey, open]);

  useEffect(() => {
    const t = flat.find((x) => x.key === selectedKey);
    if (t) seen(t.id);
  }, [selectedKey, flat, seen]);

  /**
   * Manual order (VEC-57): move `task` between its new neighbours (`beforeKey` = the task it goes above,
   * `afterKey` = the one it goes below) and/or into another status or project, optimistically. The server
   * computes the real rank; a refusal rolls the row back with a toast. Returns the saved task, or null.
   */
  const moveTask = async (task: Task, move: { beforeKey?: string; afterKey?: string; statusId?: string; projectId?: string }): Promise<Task | null> => {
    const others = [...tasks.values()].filter((t) => t.id !== task.id && t.rank).sort(compareRank);
    const at = (key?: string) => (key ? others.findIndex((t) => t.key === key) : -1);
    const ia = at(move.afterKey);
    const ib = at(move.beforeKey);
    let rank = task.rank;
    try {
      // Same neighbour rule as the server, over the tasks this view holds.
      if (ia >= 0 && ib >= 0 && ia < ib) rank = rankBetween(others[ia].rank, others[ib].rank);
      else if (ia >= 0) rank = rankBetween(others[ia].rank, others[ia + 1]?.rank);
      else if (ib >= 0) rank = rankBetween(others[ib - 1]?.rank, others[ib].rank);
    } catch {
      // Ties or stale ranks: keep the old position until the server's answer arrives.
    }
    upsert({ ...task, rank, statusId: move.statusId ?? task.statusId, projectId: move.projectId ?? task.projectId });
    const r = await moveTaskAction(org.slug, task.key, { beforeKey: move.beforeKey, afterKey: move.afterKey, status: move.statusId, project: move.projectId });
    if (!r.ok) {
      upsert(task);
      toast.error(r.error);
      return null;
    }
    if (r.data) upsert(r.data);
    return r.data ?? task;
  };

  const manual = view.sort === "manual";
  /** A drag attempt on a row that can't be dragged here: say why (once per gesture, deduped by id). */
  const dragHint = (task: Task, canEdit: boolean) => {
    if (!manual && !scope.archived) {
      toast("Switch to Manual sort to drag tasks into order", {
        id: "drag-hint",
        action: { label: "Use Manual", onClick: () => setView((v) => ({ ...v, sort: "manual" })) },
      });
    } else if (manual && !canEdit) {
      toast(`Only the creator of ${task.key} or an admin can reorder it`, { id: "drag-hint" });
    }
  };

  /**
   * A task dropped into another status group (VEC-60): one write sets the status and the position. On a
   * heading it lands at the top of that group; folded groups say where it went, since the row disappears.
   * A task from another project (dragged in through a spring-loaded sidebar row, VEC-61) also moves into
   * this view's project in the same write, gets that project's key, and the open pane follows it.
   */
  const dropIntoGroup = async (
    id: string,
    status: Status,
    neighbours: { afterKey?: string; beforeKey?: string },
    viaHeading = false,
    dragged?: Task,
  ) => {
    const t = tasks.get(id) ?? dragged;
    if (!t) return;
    const intoProject = scope.projectId && t.projectId !== scope.projectId ? scope.projectId : undefined;
    const same = t.statusId === status.id;
    if (same && !intoProject && !neighbours.afterKey && !neighbours.beforeKey) return;
    const moved = await moveTask(t, { ...neighbours, statusId: same ? undefined : status.id, projectId: intoProject });
    if (moved && intoProject) {
      if (selectedKey === t.key) open(moved.key);
      toast.success(`Moved ${t.key} to ${projectById.get(intoProject)?.name ?? "this project"} as ${moved.key}`, {
        description: t.title,
        action: { label: "Open", onClick: () => open(moved.key) },
      });
      return;
    }
    if (moved && viaHeading && isFolded(status)) {
      toast.success(`Moved ${t.key} to ${status.name}`, {
        description: t.title,
        action: { label: "Show", onClick: () => toggleGroup(status.id, false) },
      });
    }
  };

  /** Optimistic edit from the row (status ring, right-click menu); rolls back with a toast if refused. */
  const patchTask = async (task: Task, patch: TaskPatch) => {
    upsert({ ...task, ...(patch as Partial<Task>) });
    const r = await updateTask(org.slug, task.id, patch);
    if (!r.ok) {
      upsert(task);
      toast.error(r.error);
    } else if (r.data) upsert(r.data);
  };

  /** Row menu "Move to top/bottom" of its status group. */
  const moveToEdge = (task: Task, where: "top" | "bottom") => {
    const g = shown.find((x) => x.status.id === task.statusId);
    if (!g) return;
    const i = g.tasks.findIndex((x) => x.id === task.id);
    const first = g.tasks[0];
    const last = g.tasks[g.tasks.length - 1];
    if (where === "top" && i > 0) void moveTask(task, { beforeKey: first.key });
    if (where === "bottom" && i >= 0 && i < g.tasks.length - 1) void moveTask(task, { afterKey: last.key });
  };

  // Rows are memoised (VEC-73): give them callbacks with one identity for the view's lifetime, which call
  // the latest version of each action through a ref.
  const actions = useRef({ patchTask, setArchived, moveToEdge, open, seen, dragHint });
  useLayoutEffect(() => {
    actions.current = { patchTask, setArchived, moveToEdge, open, seen, dragHint };
  });
  const rowActions = useMemo<RowActions>(
    () => ({
      seen: (id) => actions.current.seen(id),
      open: (key) => actions.current.open(key),
      patch: (t, p) => void actions.current.patchTask(t, p),
      archive: (t, a) => void actions.current.setArchived(t, a),
      move: (t, where) => actions.current.moveToEdge(t, where),
      dragHint: (t, canEdit) => actions.current.dragHint(t, canEdit),
      rowRef: (id, el) => {
        if (el) rowEls.current.set(id, el);
        else rowEls.current.delete(id);
      },
      fresh: freshStore,
    }),
    [freshStore],
  );

  // Dependency keys by task id. Rebuilt only when some key changes (not on every edit), so the row
  // renderers below keep their identity through live updates and memoised rows stay put (VEC-73).
  const keySig = useMemo(() => [...tasks.values()].map((t) => `${t.id}:${t.key}`).join(","), [tasks]);
  const keyById = useMemo(() => new Map(keySig ? keySig.split(",").map((p) => p.split(":") as [string, string]) : []), [keySig]);

  /** A status group's rows. Two variants (with or without the menu's Move to top/bottom), both stable. */
  const renderRow = useCallback(
    (t: Task, { handleProps, isDragging }: { handleProps: SortableHandleProps; isDragging: boolean }, movable: boolean) => (
      <TaskRow
        task={t}
        selected={t.key === selectedKey}
        showProject={showProject}
        waitingKeys={t.waitingOn.map((id) => keyById.get(id) ?? null)}
        sort={view.sort}
        href={`${pathname}?task=${t.key}`}
        actions={rowActions}
        handleProps={manual ? handleProps : undefined}
        dragging={isDragging}
        dragHints
        movable={movable}
      />
    ),
    [selectedKey, showProject, keyById, view.sort, pathname, rowActions, manual],
  );
  const renderers = useMemo(
    () => ({
      movable: (t: Task, state: { handleProps: SortableHandleProps; isDragging: boolean }) => renderRow(t, state, true),
      fixed: (t: Task, state: { handleProps: SortableHandleProps; isDragging: boolean }) => renderRow(t, state, false),
    }),
    [renderRow],
  );

  return (
    <div className="flex min-w-0 flex-1">
      <section className={cn("flex min-w-0 flex-1 flex-col", selectedKey && "max-lg:hidden")} aria-label={title}>
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 sm:px-7">
          <MobileNavButton />
          <h1 className="truncate text-[15px] font-semibold tracking-[-0.01em]">{title}</h1>
          <span className="tabular font-mono text-[12px] text-faint">{scope.archived ? archivedList.length : openCount}</span>
          {scope.archived ? null : (
          <div className="ml-3 hidden items-center rounded-full border border-input p-0.5 sm:flex" role="radiogroup" aria-label="Filter by type">
            {(
              [
                ["all", "All"],
                ["issue", "Issues"],
                ["feature", "Features"],
                ["task", "Tasks"],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                role="radio"
                aria-checked={typeFilter === v}
                onClick={() => setTypeFilter(v)}
                className={cn(
                  "h-[22px] rounded-full px-2 text-[12.5px] transition-colors",
                  typeFilter === v ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          )}
          <div className="ml-auto flex items-center gap-3">
            <Presence />
            <div className="flex items-center gap-0.5">
              <FilterMenu value={view} onChange={setView} hideAssignee={scope.mine} />
              <SortMenu value={view.sort} onChange={(sort) => setView((v) => ({ ...v, sort }))} options={scope.archived ? ARCHIVE_SORTS : SORTS} />
            </div>
            {!scope.archived && (
              <Button onClick={() => newTask()} className="h-[30px] gap-2 rounded-lg px-3">
                <PlusIcon className="size-3.5" />
                <span className="max-sm:hidden">New task</span>
                <Kbd className={cn("border-transparent bg-white/15 text-current max-sm:hidden dark:bg-black/10", selectedKey && "max-2xl:hidden")}>N</Kbd>
              </Button>
            )}
          </div>
        </header>
        <FilterChips value={view} onChange={setView} />

        <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-16 sm:px-4">
          {tasks.size === 0 ? (
            scope.archived ? (
              <EmptyState title="Nothing archived" hint={emptyHint} icon="archive" />
            ) : (
              <EmptyState title={scope.mine ? "Nothing assigned to you" : "No tasks yet"} hint={emptyHint} onNew={() => newTask()} />
            )
          ) : visible.length === 0 && filtering ? (
            <EmptyState
              title="Nothing matches these filters"
              hint="Loosen a filter to see more tasks."
              action={<Button variant="outline" onClick={clearFilters}>Clear filters</Button>}
            />
          ) : scope.archived ? (
            <ul className="mt-2 flex flex-col gap-1">
              {archivedList.map((t) => (
                <li key={t.id}>
                <TaskRow
                  task={t}
                  selected={t.key === selectedKey}
                  showProject={showProject}
                  sort={view.sort}
                  href={`${pathname}?task=${t.key}`}
                  actions={rowActions}
                />
                </li>
              ))}
            </ul>
          ) : (
            <>
              {openCount === 0 && (
                <EmptyState title="All clear" hint="Every task in this view is done. Nice." onNew={() => newTask()} compact />
              )}
              {shown.map((g) => {
                const folded = isFolded(g.status);
                return (
                <div key={g.status.id} className="mt-4 first:mt-2">
                  <GroupHeading
                    status={g.status}
                    count={g.tasks.length}
                    folded={folded}
                    canDrop={manual}
                    projectId={scope.projectId}
                    onToggle={() => toggleGroup(g.status.id, !folded)}
                    onDrop={(item) => {
                      const top = g.tasks.find((x) => x.id !== item.id);
                      void dropIntoGroup(item.id, g.status, { beforeKey: top?.key }, true, item.data as Task | undefined);
                    }}
                  />
                  {!folded && (
                  <SortableList
                    // Drag to reorder within the group (VEC-59): Manual sort only, creator or admin rows only.
                    listId={g.status.id}
                    // Linked with the other groups: dropping a row into another group changes its status (VEC-60).
                    group={TASK_GROUP}
                    emptyLabel={`Move to ${g.status.name}`}
                    onMove={(id, { toIndex, ids, item }) => {
                      const keyOf = (i: string | undefined) => (i ? g.tasks.find((x) => x.id === i)?.key : undefined);
                      void dropIntoGroup(
                        id,
                        g.status,
                        { afterKey: keyOf(ids[toIndex - 1]), beforeKey: keyOf(ids[toIndex + 1]) },
                        false,
                        item.data as Task | undefined,
                      );
                    }}
                    aria-label={g.status.name}
                    className="flex flex-col gap-1"
                    items={g.tasks}
                    getId={(t) => t.id}
                    getLabel={(t) => `${t.key} ${t.title}`}
                    getData={(t) => t}
                    handle
                    disabled={!manual}
                    onReorder={(ids, { movedId, toIndex }) => {
                      const t = g.tasks.find((x) => x.id === movedId);
                      if (!t) return;
                      const keyOf = (id?: string) => (id ? g.tasks.find((x) => x.id === id)?.key : undefined);
                      void moveTask(t, { afterKey: keyOf(ids[toIndex - 1]), beforeKey: keyOf(ids[toIndex + 1]) });
                    }}
                    renderItem={manual && g.tasks.length > 1 ? renderers.movable : renderers.fixed}
                  />
                  )}
                  {!folded && g.tasks.length === 0 && <EmptyGroup />}
                </div>
                );
              })}
            </>
          )}
        </div>
      </section>

      {selectedKey && <MemoTaskPane key={selectedKey} taskKey={selectedKey} onClose={closePane} onTask={upsert} />}
    </div>
  );
}

const MemoTaskPane = memo(TaskPane);

/**
 * A status group's heading: folds the group, and takes drops (the task goes to the top of the group), which
 * is how a task gets into a folded group.
 */
function GroupHeading({
  status,
  count,
  folded,
  canDrop,
  projectId,
  onToggle,
  onDrop,
}: {
  status: Status;
  count: number;
  folded: boolean;
  canDrop: boolean;
  /** The view's project: a task from another project may drop on any heading, its own status included. */
  projectId?: string;
  onToggle: () => void;
  onDrop: (item: DragItem) => void;
}) {
  const { statuses } = useOrgBase();
  const { ref, isOver, canDrop: accepting } = useDropTarget<HTMLHeadingElement>(`status-heading:${status.id}`, {
    label: status.name,
    disabled: !canDrop,
    // Its own tasks are refused but must not fall through to the group under the sticky heading (VEC-78).
    opaque: true,
    // Tasks from other groups (or other projects); the group itself takes its own rows through its list.
    accepts: (item) => {
      const t = item.data as Task | undefined;
      return item.group === TASK_GROUP && !!t && (t.statusId !== status.id || (!!projectId && t.projectId !== projectId));
    },
    onDrop,
  });
  const over = isOver && accepting;
  return (
    <h2 ref={ref} data-drop-over={over ? "" : undefined} className="sticky top-0 z-20 flex h-8 items-center bg-background px-1 text-[12.5px] font-semibold">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!folded}
        aria-controls={`group-${status.id}`}
        title={folded ? `Show ${status.name}` : `Hide ${status.name}`}
        className={cn(
          "group/heading flex h-7 items-center gap-2 rounded-md pr-2 pl-0.5 transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
          over && "bg-brand/10 text-brand shadow-[inset_0_0_0_1px_var(--color-brand)] hover:bg-brand/10",
        )}
      >
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3.5 text-faint transition-transform duration-200 group-hover/heading:text-foreground motion-reduce:transition-none",
            folded && "-rotate-90",
          )}
        />
        <StatusRing status={status} statuses={statuses} size={15} />
        {status.name}
        <span className="tabular font-mono font-normal text-faint">{count}</span>
      </button>
      {over && <span className="ml-2 text-[12px] font-normal text-brand">Drop to move to the top</span>}
    </h2>
  );
}

/** An empty, unfolded group: a slim "No tasks" line, which the list's drop zone replaces during a drag. */
function EmptyGroup() {
  const dragging = useDragSelector((d) => d?.item.group === TASK_GROUP);
  if (dragging) return null;
  return <p className="flex h-9 items-center px-3 text-[12.5px] text-faint">No tasks</p>;
}

/** What a row can do. One object for the whole view (stable identity), so memoised rows skip re-rendering. */
interface RowActions {
  seen: (id: string) => void;
  open: (key: string) => void;
  patch: (task: Task, patch: TaskPatch) => void;
  archive: (task: Task, archived: boolean) => void;
  move: (task: Task, where: "top" | "bottom") => void;
  dragHint: (task: Task, canEdit: boolean) => void;
  rowRef: (id: string, el: HTMLDivElement | null) => void;
  /** Teammates' live changes, by task id. */
  fresh: FreshStore;
}

interface TaskRowProps {
  task: Task;
  selected: boolean;
  showProject: boolean;
  /** Keys of the dependencies this task still waits on (null where this view doesn't have the task). */
  waitingKeys?: (string | null)[];
  sort: SortKey;
  href: string;
  actions: RowActions;
  /** Manual sort: SortableList handle props. Spread on the row's link only if this person may move the task. */
  handleProps?: SortableHandleProps;
  /** Being dragged or lifted with the keyboard. */
  dragging?: boolean;
  /** Explain a refused drag (wrong sort, or not theirs to move) when someone tries one on this row. */
  dragHints?: boolean;
  /** Offer "Move to top/bottom" in the row menu (Manual sort, more than one row in the group). */
  movable?: boolean;
}

/** Shallow, except `waitingKeys`, which is rebuilt every render and compared by value. */
function sameRowProps(a: TaskRowProps, b: TaskRowProps) {
  for (const k of Object.keys(a) as (keyof TaskRowProps)[]) {
    if (k === "waitingKeys") continue;
    if (!Object.is(a[k], b[k])) return false;
  }
  if (Object.keys(a).length !== Object.keys(b).length) return false;
  const wa = a.waitingKeys;
  const wb = b.waitingKeys;
  if (wa === wb) return true;
  if (!wa || !wb || wa.length !== wb.length) return false;
  return wa.every((k, i) => k === wb[i]);
}

/**
 * One task row. Memoised (VEC-73): every row mounts a context menu, a status picker and a tooltip, so
 * re-rendering a whole list per drag or live update was the main source of drag lag. It reads only the
 * stable part of the org context for the same reason.
 */
const TaskRow = memo(function TaskRow({
  task,
  selected,
  showProject,
  waitingKeys,
  sort,
  href,
  actions,
  handleProps,
  dragging,
  dragHints,
  movable,
}: TaskRowProps) {
  const { statusById, memberById, projectById, me, isAdmin } = useOrgBase();
  const fresh = useSyncExternalStore(actions.fresh.subscribe, () => actions.fresh.get().get(task.id), () => undefined);
  const onSeen = () => actions.seen(task.id);
  const onArchive = (archived: boolean) => actions.archive(task, archived);
  const onPatch = (patch: TaskPatch) => actions.patch(task, patch);
  const onDragHint = dragHints ? (canEdit: boolean) => actions.dragHint(task, canEdit) : undefined;
  const { rowRef } = actions;
  const refCb = useCallback((el: HTMLDivElement | null) => rowRef(task.id, el), [rowRef, task.id]);
  const statusOptions = useStatusOptions();
  const access = taskAccess(task, me.id, isAdmin);
  const canEdit = access === "full";
  const status = statusById.get(task.statusId);
  const assignee = task.assigneeId ? memberById.get(task.assigneeId) : undefined;
  const project = projectById.get(task.projectId);
  const closed = status?.category === "done" || status?.category === "cancelled";
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hinted = useRef(false);
  // The row's menus and tooltip mount on first use, not with the row (VEC-81).
  const { rowProps, menu } = useTaskContextMenu({
    task,
    onOpen: () => (onSeen(), actions.open(task.key)),
    onPatch,
    onArchive,
    onMove: movable ? (where) => actions.move(task, where) : undefined,
  });

  return (
    <div
      {...rowProps}
      ref={refCb}
      onPointerEnter={() => fresh && (hoverTimer.current = setTimeout(onSeen, 700))}
      onPointerLeave={() => clearTimeout(hoverTimer.current)}
      className={cn(
        "group relative grid h-10 grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-3 rounded-[9px] px-3 transition-colors duration-300",
        dragging && "cursor-grabbing",
        selected ? "bg-selected" : fresh ? "bg-live shadow-[inset_0_0_0_1px_var(--live-border)]" : "hover:bg-accent data-[state=open]:bg-accent",
      )}
    >
      <LazyPicker
        disabled={access === "comment"}
        label={`Status: ${status?.name ?? "none"}`}
        value={task.statusId}
        options={statusOptions}
        onChange={(statusId) => onPatch({ statusId })}
        searchable={false}
      >
        <button className="relative z-10 -m-1 grid size-[26px] place-items-center rounded-full transition-transform enabled:hover:scale-110 enabled:active:scale-95 disabled:pointer-events-none">
          <TaskStatusRing task={task} size={18} />
        </button>
      </LazyPicker>
      <Link
        href={href}
        scroll={false}
        replace
        onClick={(e) => {
          // The click that ends a refused drag gesture doesn't open the task.
          if (hinted.current) {
            hinted.current = false;
            return e.preventDefault();
          }
          onSeen();
        }}
        aria-current={selected ? "true" : undefined}
        {...(canEdit ? handleProps : undefined)}
        // Rows are dragged through SortableList only; never start the browser's own link drag.
        onDragStart={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          // A mouse drag on a row that can't be dragged here: explain why once the pointer travels.
          if (!onDragHint || (canEdit && handleProps) || e.pointerType === "touch" || e.button !== 0) return;
          hinted.current = false;
          const x0 = e.clientX;
          const y0 = e.clientY;
          const move = (m: PointerEvent) => {
            if (Math.hypot(m.clientX - x0, m.clientY - y0) < 8) return;
            stop();
            hinted.current = true;
            onDragHint(canEdit);
          };
          const stop = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", stop);
            window.removeEventListener("pointercancel", stop);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", stop);
          window.addEventListener("pointercancel", stop);
        }}
        className={cn(
          "truncate text-[14px] outline-none after:absolute after:inset-0 after:rounded-[9px] focus-visible:after:ring-2 focus-visible:after:ring-ring",
          closed && "text-faint",
        )}
      >
        {task.title}
      </Link>
      <div className="flex items-center gap-3">
        {fresh && <FreshNote fresh={fresh} />}
        {!fresh && task.archivedAt ? (
          <span className="text-[12px] text-faint max-md:hidden" title={new Date(task.archivedAt).toLocaleString()}>
            Archived {timeAgo(task.archivedAt)}
          </span>
        ) : !fresh && (sort === "created" || sort === "created-asc") ? (
          <span className="text-[12px] text-faint max-md:hidden" title={`Created ${new Date(task.createdAt).toLocaleString()}`}>
            {timeAgo(task.createdAt)}
          </span>
        ) : !fresh && sort === "updated" ? (
          <span className="text-[12px] text-faint max-md:hidden" title={`Updated ${new Date(task.updatedAt).toLocaleString()}`}>
            {timeAgo(task.updatedAt)}
          </span>
        ) : null}
        {!closed && !task.archivedAt && task.stalled && <StalledBadge stalled={task.stalled} />}
        {!closed && !task.archivedAt && waitingKeys && <WaitingBadge keys={waitingKeys} className="max-sm:hidden" />}
        {task.dueDate && <DueBadge due={task.dueDate} closed={closed || !!task.archivedAt} className="max-sm:hidden" />}
        {(
          <>
            {showProject && project && !fresh && (
              <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground max-xl:hidden">
                <ProjectDot color={project.color} />
                {project.name}
              </span>
            )}
            <TypeTag type={task.type} className={fresh ? "max-xl:hidden" : "max-md:hidden"} />
          </>
        )}
        <PriorityIcon priority={task.priority} />
        <span className="w-[22px]">
          {assignee ? <MemberAvatar member={assignee} id={assignee.id} size={20} /> : null}
        </span>
        <span className="tabular w-[64px] text-right font-mono text-[12px] text-faint max-sm:hidden">{task.key}</span>
        {canEdit && <ArchiveButton task={task} onArchive={onArchive} />}
      </div>
      {menu}
    </div>
  );
}, sameRowProps);

/**
 * A row's archive/restore button. Its tooltip mounts the first time a pointer or focus reaches the button
 * (mouse hover or keyboard focus, VEC-81), so a list doesn't mount a Radix tooltip per row. Arming swaps the
 * button for a new element, so focus that armed it is put back on the new one (which then shows the tooltip,
 * as a focused trigger does).
 */
function ArchiveButton({ task, onArchive }: { task: Task; onArchive: (archived: boolean) => void }) {
  const [armed, setArmed] = useState<false | "pointer" | "focus">(false);
  const ref = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (armed === "focus" && document.activeElement !== ref.current) ref.current?.focus();
  }, [armed]);
  const button = (
    <button
      ref={ref}
      onClick={() => onArchive(!task.archivedAt)}
      onPointerEnter={armed ? undefined : (e) => e.pointerType === "mouse" && setArmed("pointer")}
      // Keyboard focus only: a tap focuses the button too, and swapping it then would swallow the tap's click.
      onFocus={armed ? undefined : (e) => e.currentTarget.matches(":focus-visible") && setArmed("focus")}
      aria-label={task.archivedAt ? `Restore ${task.key}` : `Archive ${task.key}`}
      className={cn(
        "relative z-10 -mr-1.5 grid size-7 place-items-center rounded-md text-faint transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100",
        task.archivedAt ? "opacity-100" : "opacity-0 group-hover:opacity-100 max-md:hidden",
      )}
    >
      {task.archivedAt ? <ArchiveRestoreIcon className="size-4" /> : <ArchiveIcon className="size-4" />}
    </button>
  );
  if (!armed) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>
        {task.archivedAt ? "Restore" : "Archive"} <Kbd className="ml-1">E</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}

interface Fresh {
  actorId: string;
  verb: string;
  at: number;
}

type FreshStore = ReturnType<typeof createFreshStore>;

function createFreshStore() {
  let map = new Map<string, Fresh>();
  const listeners = new Set<() => void>();
  return {
    get: () => map,
    update: (fn: (prev: Map<string, Fresh>) => Map<string, Fresh>) => {
      const next = fn(map);
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

function FreshNote({ fresh }: { fresh: Fresh }) {
  const { memberById } = useOrgBase();
  const who = memberById.get(fresh.actorId);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground max-md:hidden">
      {who && <MemberAvatar member={who} id={who.id} size={16} />}
      {who ? (who.kind === "bot" ? who.name : who.name.split(" ")[0]) : "A teammate"} {fresh.verb} · {timeAgo(new Date(fresh.at).toISOString())}
    </span>
  );
}

function Presence() {
  const { online, me, memberById } = useOrg();
  const others = online.filter((id) => id !== me.id).map((id) => memberById.get(id)).filter((m) => !!m);
  if (!others.length) return null;
  const shown = others.slice(0, 3);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center pl-1.5 max-sm:hidden" aria-label={`Also here: ${others.map((m) => m.name).join(", ")}`}>
          {shown.map((m) => (
            <UserAvatar key={m.id} id={m.id} name={m.name} image={m.image} size={24} className="-ml-1.5 ring-2 ring-background" />
          ))}
          {others.length > 3 && (
            <span className="tabular -ml-1.5 grid size-6 place-items-center rounded-full bg-chip text-[10.5px] font-medium text-muted-foreground ring-2 ring-background">
              +{others.length - 3}
            </span>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent>Also here: {others.map((m) => m.name).join(", ")}</TooltipContent>
    </Tooltip>
  );
}

function EmptyState({
  title,
  hint,
  onNew,
  action,
  compact,
  icon,
}: {
  title: string;
  hint: string;
  onNew?: () => void;
  action?: React.ReactNode;
  compact?: boolean;
  icon?: "archive";
}) {
  return (
    <div className={cn("mx-auto flex max-w-sm flex-col items-center text-center", compact ? "py-10" : "py-[18vh]")}>
      {icon === "archive" ? <ArchiveIcon className="mb-4 size-9 stroke-1 text-faint/60" /> : <svg width="40" height="40" viewBox="0 0 20 20" aria-hidden className="mb-4 text-faint/60">
        <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="1" />
        <path d="m6.6 10.2 2.3 2.3 4.5-4.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>}
      <h2 className="text-[15px] font-semibold">{title}</h2>
      <p className="mt-1 text-[13.5px] text-muted-foreground">{hint}</p>
      <div className="mt-5">
        {action ??
          (onNew && (
            <Button variant="outline" onClick={onNew} className="gap-2">
              <PlusIcon className="size-3.5" /> New task <Kbd>N</Kbd>
            </Button>
          ))}
      </div>
    </div>
  );
}

/**
 * Status groups the user folded or unfolded in this view (id -> folded), remembered per view in
 * localStorage. Groups without an entry use their default (done/cancelled folded, others open).
 */
function useCollapsedGroups(storageKey: string) {
  const [collapsed, setCollapsed] = useState<Map<string, boolean>>(() => new Map());
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  useEffect(() => {
    const entries: [string, boolean][] = [];
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
      // Older format: an array of folded ids.
      if (Array.isArray(raw)) for (const x of raw) if (typeof x === "string") entries.push([x, true]);
      if (raw && typeof raw === "object" && !Array.isArray(raw))
        for (const [k, v] of Object.entries(raw)) if (typeof v === "boolean") entries.push([k, v]);
    } catch {}
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is client-only; read after hydration
    setCollapsed(new Map(entries));
    setLoadedKey(storageKey);
  }, [storageKey]);

  useEffect(() => {
    if (loadedKey !== storageKey) return;
    if (collapsed.size) localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(collapsed)));
    else localStorage.removeItem(storageKey);
  }, [collapsed, storageKey, loadedKey]);

  const toggle = useCallback((id: string, folded: boolean) => {
    setCollapsed((prev) => new Map(prev).set(id, folded));
  }, []);

  return [collapsed, toggle] as const;
}
