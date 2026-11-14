"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useOrg, useOrgEvents } from "@/components/org-provider";
import { MobileNavButton, useShell } from "@/components/app-shell";
import { Kbd, PriorityIcon, ProjectDot, StatusRing, TypeTag, UserAvatar } from "@/components/bits";
import { Picker, useStatusOptions } from "@/components/pickers";
import { TaskPane } from "@/components/task-pane";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { timeAgo } from "@/lib/format";
import { updateTask } from "@/app/actions/tasks";
import type { Status, Task, TaskType } from "@/lib/types";

export interface Scope {
  projectId?: string;
  mine?: boolean;
}

type TypeFilter = "all" | TaskType;

const byPriorityThenNewest = (a: Task, b: Task) =>
  b.priority - a.priority || b.createdAt.localeCompare(a.createdAt) || b.number - a.number;

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
  const { org, me, statuses, memberById } = useOrg();
  const { newTask, setViewDefaults } = useShell();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const selectedKey = params.get("task");

  const [tasks, setTasks] = useState<Map<string, Task>>(() => new Map(initialTasks.map((t) => [t.id, t])));
  useEffect(() => setTasks(new Map(initialTasks.map((t) => [t.id, t]))), [initialTasks]);

  // Rows a teammate changed live: id -> actor id. Cleared once seen (hovered or opened).
  const [fresh, setFresh] = useState<Map<string, Fresh>>(new Map());
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [showClosed, setShowClosed] = useState(false);

  useEffect(() => {
    setViewDefaults({ projectId: scope.projectId, assigneeId: scope.mine ? me.id : undefined });
    return () => setViewDefaults({});
  }, [scope.projectId, scope.mine, me.id, setViewDefaults]);

  const matches = useCallback(
    (t: Task) => (!scope.projectId || t.projectId === scope.projectId) && (!scope.mine || t.assigneeId === me.id),
    [scope.projectId, scope.mine, me.id],
  );

  const upsert = useCallback(
    (t: Task) =>
      setTasks((prev) => {
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
      if (e.actorId !== me.id && matches(e.task) && e.task.key !== selectedKey) {
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
      if (t && t.key !== selectedKey) mark(t.id, e.actorId, "commented");
    } else if (e.type === "task.delete") {
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

  const visible = useMemo(() => [...tasks.values()].filter((t) => typeFilter === "all" || t.type === typeFilter), [tasks, typeFilter]);

  const groups = useMemo(() => {
    const out: { status: Status; tasks: Task[] }[] = [];
    for (const s of statuses) {
      const list = visible.filter((t) => t.statusId === s.id).sort(byPriorityThenNewest);
      if (list.length) out.push({ status: s, tasks: list });
    }
    // Tasks whose status was deleted mid-session.
    const known = new Set(statuses.map((s) => s.id));
    const orphans = visible.filter((t) => !known.has(t.statusId));
    if (orphans.length && statuses[0]) out[0]?.tasks.push(...orphans);
    return out;
  }, [visible, statuses]);

  const isClosed = (s: Status) => s.category === "done" || s.category === "cancelled";
  const openGroups = groups.filter((g) => !isClosed(g.status));
  const closedGroups = groups.filter((g) => isClosed(g.status));
  const closedCount = closedGroups.reduce((n, g) => n + g.tasks.length, 0);
  const openCount = openGroups.reduce((n, g) => n + g.tasks.length, 0);
  const shown = showClosed ? groups : openGroups;

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
  const flat = useMemo(() => shown.flatMap((g) => g.tasks), [shown]);
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
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flat, selectedKey, open]);

  useEffect(() => {
    const t = flat.find((x) => x.key === selectedKey);
    if (t) seen(t.id);
  }, [selectedKey, flat, seen]);

  const setStatus = async (task: Task, statusId: string) => {
    upsert({ ...task, statusId });
    const r = await updateTask(org.slug, task.id, { statusId });
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
          <span className="tabular font-mono text-[12px] text-faint">{openCount}</span>
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
          <div className="ml-auto flex items-center gap-3">
            <Presence />
            <LiveIndicator />
            <Button onClick={() => newTask()} className="h-[30px] gap-2 rounded-lg px-3">
              <PlusIcon className="size-3.5" />
              <span className="max-sm:hidden">New task</span>
              <Kbd className="border-transparent bg-white/15 text-current max-sm:hidden dark:bg-black/10">N</Kbd>
            </Button>
          </div>
        </header>

        <div className="relative min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-16 sm:px-4">
          {tasks.size === 0 ? (
            <EmptyState title={scope.mine ? "Nothing assigned to you" : "No tasks yet"} hint={emptyHint} onNew={() => newTask()} />
          ) : visible.length === 0 ? (
            <EmptyState
              title={typeFilter === "issue" ? "No issues here" : "No feature requests here"}
              hint="Try a different filter."
              action={<Button variant="outline" onClick={() => setTypeFilter("all")}>Show all types</Button>}
            />
          ) : (
            <>
              {openGroups.length === 0 && !showClosed && (
                <EmptyState title="All clear" hint="Every task in this view is done. Nice." onNew={() => newTask()} compact />
              )}
              {shown.map((g) => (
                <div key={g.status.id} className="mt-4 first:mt-2">
                  <h2 className="sticky top-0 z-10 flex h-8 items-center gap-2 bg-background px-3 text-[12.5px] font-semibold">
                    <StatusRing status={g.status} statuses={statuses} size={15} />
                    {g.status.name}
                    <span className="tabular font-mono font-normal text-faint">{g.tasks.length}</span>
                  </h2>
                  <ul className="flex flex-col gap-1">
                    {g.tasks.map((t) => (
                      <TaskRow
                        key={t.id}
                        task={t}
                        selected={t.key === selectedKey}
                        fresh={fresh.get(t.id)}
                        showProject={showProject}
                        href={`${pathname}?task=${t.key}`}
                        onSeen={() => seen(t.id)}
                        onStatus={(s) => setStatus(t, s)}
                        refCb={(el) => {
                          if (el) rowEls.current.set(t.id, el);
                          else rowEls.current.delete(t.id);
                        }}
                      />
                    ))}
                  </ul>
                </div>
              ))}
              {closedCount > 0 && (
                <button
                  onClick={() => setShowClosed((s) => !s)}
                  className="mt-5 ml-3 inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-expanded={showClosed}
                >
                  <ChevronDownIcon className={cn("size-3.5 transition-transform", !showClosed && "-rotate-90")} />
                  {showClosed ? "Hide" : "Show"} {closedCount} completed
                </button>
              )}
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
  href,
  onSeen,
  onStatus,
  refCb,
}: {
  task: Task;
  selected: boolean;
  fresh?: Fresh;
  showProject: boolean;
  href: string;
  onSeen: () => void;
  onStatus: (statusId: string) => void;
  refCb: (el: HTMLLIElement | null) => void;
}) {
  const { statuses, statusById, memberById, projectById, me, isAdmin } = useOrg();
  const statusOptions = useStatusOptions();
  const canEdit = isAdmin || task.createdBy === me.id;
  const status = statusById.get(task.statusId);
  const assignee = task.assigneeId ? memberById.get(task.assigneeId) : undefined;
  const project = projectById.get(task.projectId);
  const closed = status?.category === "done" || status?.category === "cancelled";
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  return (
    <li
      ref={refCb}
      onPointerEnter={() => fresh && (hoverTimer.current = setTimeout(onSeen, 700))}
      onPointerLeave={() => clearTimeout(hoverTimer.current)}
      className={cn(
        "group relative grid h-10 grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-3 rounded-[9px] px-3 transition-colors duration-300",
        selected ? "bg-selected" : fresh ? "bg-live shadow-[inset_0_0_0_1px_var(--live-border)]" : "hover:bg-accent",
      )}
    >
      <Picker
        disabled={!canEdit}
        label={`Status: ${status?.name ?? "none"}`}
        value={task.statusId}
        options={statusOptions}
        onChange={onStatus}
        searchable={false}
      >
        <button className="relative z-10 -m-1 grid size-[26px] place-items-center rounded-full transition-transform enabled:hover:scale-110 enabled:active:scale-95 disabled:pointer-events-none">
          <StatusRing status={status} statuses={statuses} size={18} />
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
          {assignee ? <UserAvatar id={assignee.id} name={assignee.name} size={20} /> : null}
        </span>
        <span className="tabular w-[64px] text-right font-mono text-[12px] text-faint max-sm:hidden">{task.key}</span>
      </div>
    </li>
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
      {who && <UserAvatar id={who.id} name={who.name} size={16} />}
      {who?.name.split(" ")[0] ?? "A teammate"} {fresh.verb} · {timeAgo(new Date(fresh.at).toISOString())}
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
            <UserAvatar key={m.id} id={m.id} name={m.name} size={24} className="-ml-1.5 ring-2 ring-background" />
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

function LiveIndicator() {
  const { connected } = useOrg();
  return (
    <span
      className="hidden items-center gap-1.5 text-[12px] text-faint md:flex"
      title={connected ? "Changes from your team appear instantly" : "Reconnecting…"}
    >
      <span className={cn("size-1.5 rounded-full", connected ? "bg-[#30a46c]" : "bg-faint")} />
      {connected ? "Live" : "Offline"}
    </span>
  );
}

function EmptyState({
  title,
  hint,
  onNew,
  action,
  compact,
}: {
  title: string;
  hint: string;
  onNew?: () => void;
  action?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={cn("mx-auto flex max-w-sm flex-col items-center text-center", compact ? "py-10" : "py-[18vh]")}>
      <svg width="40" height="40" viewBox="0 0 20 20" aria-hidden className="mb-4 text-faint/60">
        <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="1" />
        <path d="m6.6 10.2 2.3 2.3 4.5-4.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
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
