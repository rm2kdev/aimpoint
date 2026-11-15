"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArchiveIcon, ArchiveRestoreIcon, ChevronDownIcon, PlusIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { taskAccess } from "@/lib/access";
import { useOrg, useOrgEvents } from "@/components/org-provider";
import { MobileNavButton, useShell } from "@/components/app-shell";
import { Kbd, MemberAvatar, PriorityIcon, ProjectDot, StatusRing, TypeTag, UserAvatar } from "@/components/bits";
import { TaskStatusRing } from "@/components/task-status-ring";
import { Picker, useStatusOptions } from "@/components/pickers";
import { TaskPane } from "@/components/task-pane";
import { TaskContextMenu } from "@/components/task-context-menu";
import { DueBadge } from "@/components/due-date";
import { StalledBadge, WaitingBadge } from "@/components/dependencies";
import { applyFilters, comparator, FilterChips, FilterMenu, filterCount, SortMenu, useViewState, type SortKey } from "@/components/view-options";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { timeAgo } from "@/lib/format";
import { updateTask, type TaskPatch } from "@/app/actions/tasks";
import type { Status, Task, TaskType } from "@/lib/types";

export interface Scope {
  projectId?: string;
  mine?: boolean;
  archived?: boolean;
}

type TypeFilter = "all" | TaskType;

const SORTS: SortKey[] = ["priority", "due", "created", "created-asc", "updated", "title"];
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
  const { org, me, statuses, isAdmin } = useOrg();
  const { newTask, setViewDefaults } = useShell();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const selectedKey = params.get("task");

  const [tasks, setTasks] = useState<Map<string, Task>>(() => new Map(initialTasks.map((t) => [t.id, t])));
  // Newest version of every task this view has seen (incl. ones that left it). A server refresh can be
  // older than a change we already applied (e.g. archive, then navigate): never let it roll that back.
  const latest = useRef(new Map<string, Task>());

  // Rows a teammate changed live: id -> actor id. Cleared once seen (hovered or opened).
  const [fresh, setFresh] = useState<Map<string, Fresh>>(new Map());
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [view, setView] = useViewState(`vector:view:${pathname}`, scope.archived ? "archived" : "priority");
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

  const seen = useCallback((id: string) => {
    setFresh((f) => {
      if (!f.has(id)) return f;
      const n = new Map(f);
      n.delete(id);
      return n;
    });
  }, []);

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
      const list = visible.filter((t) => t.statusId === s.id).sort(cmp);
      if (list.length) out.push({ status: s, tasks: list });
    }
    // Tasks whose status was deleted mid-session.
    const known = new Set(statuses.map((s) => s.id));
    const orphans = visible.filter((t) => !known.has(t.statusId));
    if (orphans.length && statuses[0]) out[0]?.tasks.push(...orphans);
    return out;
  }, [visible, statuses, view.sort]);
  const archivedList = useMemo(() => (scope.archived ? [...visible].sort(comparator(view.sort)) : []), [scope.archived, visible, view.sort]);

  const isClosed = (s: Status) => s.category === "done" || s.category === "cancelled";
  const openGroups = groups.filter((g) => !isClosed(g.status));
  const openCount = openGroups.reduce((n, g) => n + g.tasks.length, 0);
  const shown = useMemo(() => (scope.archived ? [] : groups), [scope.archived, groups]);
  // Done and cancelled groups start folded until opened from their heading.
  const isFolded = (s: Status) => collapsed.get(s.id) ?? isClosed(s);

  /* ----- glide rows to their new position (FLIP) ----- */
  const rowEls = useRef(new Map<string, HTMLElement>());
  const lastTop = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const next = new Map<string, number>();
    rowEls.current.forEach((el, id) => {
      const top = el.offsetTop;
      next.set(id, top);
      const prev = lastTop.current.get(id);
      if (prev !== undefined && Math.abs(prev - top) > 2 && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
        el.animate([{ transform: `translateY(${prev - top}px)` }, { transform: "translateY(0)" }], {
          duration: 380,
          easing: "cubic-bezier(.2,.8,.2,1)",
        });
      }
    });
    lastTop.current = next;
  });

  /* ----- selection & keyboard ----- */
  // Tasks in folded groups are out of sight, so j/k skips them.
  const flat = useMemo(
    () => (scope.archived ? archivedList : shown.flatMap((g) => ((collapsed.get(g.status.id) ?? isClosed(g.status)) ? [] : g.tasks))),
    [scope.archived, archivedList, shown, collapsed],
  );
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

  /** Optimistic edit from the row (status ring, right-click menu); rolls back with a toast if refused. */
  const patchTask = async (task: Task, patch: TaskPatch) => {
    upsert({ ...task, ...(patch as Partial<Task>) });
    const r = await updateTask(org.slug, task.id, patch);
    if (!r.ok) {
      upsert(task);
      toast.error(r.error);
    } else if (r.data) upsert(r.data);
  };

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
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                role="radio"
                aria-checked={typeFilter === v}
                onClick={() => setTypeFilter(v)}
                className={cn(
                  "h-[22px] rounded-full px-2.5 text-[12.5px] transition-colors",
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
                <Kbd className="border-transparent bg-white/15 text-current max-sm:hidden dark:bg-black/10">N</Kbd>
              </Button>
            )}
          </div>
        </header>
        <FilterChips value={view} onChange={setView} />

        <div className="relative min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-16 sm:px-4">
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
                <TaskRow
                  key={t.id}
                  task={t}
                  selected={t.key === selectedKey}
                  fresh={fresh.get(t.id)}
                  showProject={showProject}
                  sort={view.sort}
                  href={`${pathname}?task=${t.key}`}
                  onSeen={() => seen(t.id)}
                  onStatus={(s) => patchTask(t, { statusId: s })}
                  onPatch={(p) => patchTask(t, p)}
                  onOpen={() => open(t.key)}
                  onArchive={(a) => setArchived(t, a)}
                  refCb={(el) => {
                    if (el) rowEls.current.set(t.id, el);
                    else rowEls.current.delete(t.id);
                  }}
                />
              ))}
            </ul>
          ) : (
            <>
              {openGroups.length === 0 && (
                <EmptyState title="All clear" hint="Every task in this view is done. Nice." onNew={() => newTask()} compact />
              )}
              {shown.map((g) => {
                const folded = isFolded(g.status);
                return (
                <div key={g.status.id} className="mt-4 first:mt-2">
                  <h2 className="sticky top-0 z-10 flex h-8 items-center bg-background px-1 text-[12.5px] font-semibold">
                    <button
                      type="button"
                      onClick={() => toggleGroup(g.status.id, !folded)}
                      aria-expanded={!folded}
                      aria-controls={`group-${g.status.id}`}
                      title={folded ? `Show ${g.status.name}` : `Hide ${g.status.name}`}
                      className="group/heading flex h-7 items-center gap-2 rounded-md pr-2 pl-0.5 transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
                      <ChevronDownIcon
                        aria-hidden
                        className={cn(
                          "size-3.5 text-faint transition-transform duration-200 group-hover/heading:text-foreground motion-reduce:transition-none",
                          folded && "-rotate-90",
                        )}
                      />
                      <StatusRing status={g.status} statuses={statuses} size={15} />
                      {g.status.name}
                      <span className="tabular font-mono font-normal text-faint">{g.tasks.length}</span>
                    </button>
                  </h2>
                  {!folded && (
                  <ul id={`group-${g.status.id}`} className="flex flex-col gap-1">
                    {g.tasks.map((t) => (
                      <TaskRow
                        key={t.id}
                        task={t}
                        selected={t.key === selectedKey}
                        fresh={fresh.get(t.id)}
                        showProject={showProject}
                        waitingKeys={t.waitingOn.map((id) => tasks.get(id)?.key ?? null)}
                        sort={view.sort}
                        href={`${pathname}?task=${t.key}`}
                        onSeen={() => seen(t.id)}
                        onStatus={(s) => patchTask(t, { statusId: s })}
                  onPatch={(p) => patchTask(t, p)}
                  onOpen={() => open(t.key)}
                        onArchive={(a) => setArchived(t, a)}
                        refCb={(el) => {
                          if (el) rowEls.current.set(t.id, el);
                          else rowEls.current.delete(t.id);
                        }}
                      />
                    ))}
                  </ul>
                  )}
                </div>
                );
              })}
            </>
          )}
        </div>
      </section>

      {selectedKey && <TaskPane key={selectedKey} taskKey={selectedKey} onClose={() => open(null)} onTask={upsert} />}
    </div>
  );
}

function TaskRow({
  task,
  selected,
  fresh,
  showProject,
  waitingKeys,
  sort,
  href,
  onSeen,
  onStatus,
  onArchive,
  onPatch,
  onOpen,
  refCb,
}: {
  task: Task;
  selected: boolean;
  fresh?: Fresh;
  showProject: boolean;
  /** Keys of the dependencies this task still waits on (null where this view doesn't have the task). */
  waitingKeys?: (string | null)[];
  sort: SortKey;
  href: string;
  onSeen: () => void;
  onStatus: (statusId: string) => void;
  onArchive: (archived: boolean) => void;
  onPatch: (patch: TaskPatch) => void;
  onOpen: () => void;
  refCb: (el: HTMLLIElement | null) => void;
}) {
  const { statusById, memberById, projectById, me, isAdmin } = useOrg();
  const statusOptions = useStatusOptions();
  const access = taskAccess(task, me.id, isAdmin);
  const canEdit = access === "full";
  const status = statusById.get(task.statusId);
  const assignee = task.assigneeId ? memberById.get(task.assigneeId) : undefined;
  const project = projectById.get(task.projectId);
  const closed = status?.category === "done" || status?.category === "cancelled";
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  return (
    <TaskContextMenu task={task} onOpen={() => (onSeen(), onOpen())} onPatch={onPatch} onArchive={onArchive}>
    <li
      ref={refCb}
      onPointerEnter={() => fresh && (hoverTimer.current = setTimeout(onSeen, 700))}
      onPointerLeave={() => clearTimeout(hoverTimer.current)}
      className={cn(
        "group relative grid h-10 grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-3 rounded-[9px] px-3 transition-colors duration-300",
        selected ? "bg-selected" : fresh ? "bg-live shadow-[inset_0_0_0_1px_var(--live-border)]" : "hover:bg-accent data-[state=open]:bg-accent",
      )}
    >
      <Picker
        disabled={access === "comment"}
        label={`Status: ${status?.name ?? "none"}`}
        value={task.statusId}
        options={statusOptions}
        onChange={onStatus}
        searchable={false}
      >
        <button className="relative z-10 -m-1 grid size-[26px] place-items-center rounded-full transition-transform enabled:hover:scale-110 enabled:active:scale-95 disabled:pointer-events-none">
          <TaskStatusRing task={task} size={18} />
        </button>
      </Picker>
      <Link
        href={href}
        scroll={false}
        replace
        onClick={onSeen}
        aria-current={selected ? "true" : undefined}
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
        {canEdit && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => onArchive(!task.archivedAt)}
                aria-label={task.archivedAt ? `Restore ${task.key}` : `Archive ${task.key}`}
                className={cn(
                  "relative z-10 -mr-1.5 grid size-7 place-items-center rounded-md text-faint transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100",
                  task.archivedAt ? "opacity-100" : "opacity-0 group-hover:opacity-100 max-md:hidden",
                )}
              >
                {task.archivedAt ? <ArchiveRestoreIcon className="size-4" /> : <ArchiveIcon className="size-4" />}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {task.archivedAt ? "Restore" : "Archive"} <Kbd className="ml-1">E</Kbd>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </li>
    </TaskContextMenu>
  );
}

interface Fresh {
  actorId: string;
  verb: string;
  at: number;
}

function FreshNote({ fresh }: { fresh: Fresh }) {
  const { memberById } = useOrg();
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
