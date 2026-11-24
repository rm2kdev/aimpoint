"use client";

import { useEffect, useRef, useState } from "react";
import { CircleAlertIcon, HourglassIcon, UserRoundIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useOrgBase } from "@/components/org-provider";
import { TaskStatusRing } from "@/components/task-status-ring";
import { searchTasks } from "@/app/actions/tasks";
import type { Stalled, Task, TaskRef } from "@/lib/types";

export const toRef = (t: Task | TaskRef): TaskRef => ({
  id: t.id,
  key: t.key,
  title: t.title,
  statusId: t.statusId,
  assigneeId: t.assigneeId,
  archived: "archived" in t ? t.archived : !!t.archivedAt,
  workingBotIds: t.workingBotIds ?? [],
});

/** Debounced task search for pickers while `open`: an empty query lists recently updated unarchived tasks. */
export function useTaskSearch(open: boolean, q: string) {
  const { org } = useOrgBase();
  const [results, setResults] = useState<Task[]>([]);
  const seq = useRef(0);
  useEffect(() => {
    if (!open) return;
    const id = ++seq.current;
    const t = setTimeout(async () => {
      const r = await searchTasks(org.slug, q, { recentWhenEmpty: true });
      if (id === seq.current && r.ok) setResults(r.data ?? []);
    }, q ? 140 : 0);
    return () => clearTimeout(t);
  }, [q, open, org.slug]);
  return results;
}

/** Search the organisation's tasks and pick one (for dependencies). Empty search lists recently updated tasks. */
export function TaskSearchPicker({
  exclude,
  onPick,
  children,
  label = "Add dependency",
}: {
  /** Task ids not to offer (the task itself, current dependencies). */
  exclude: string[];
  onPick: (t: Task) => void;
  children: React.ReactNode;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const results = useTaskSearch(open, q);

  const shown = results.filter((t) => !exclude.includes(t.id));
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQ("");
      }}
    >
      <PopoverTrigger asChild aria-label={label}>
        {children}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0" onClick={(e) => e.stopPropagation()}>
        <Command shouldFilter={false}>
          <CommandInput value={q} onValueChange={setQ} placeholder="Search tasks by title or key…" />
          <CommandList>
            <CommandEmpty>{q.trim() ? "No matching tasks" : "No other tasks yet"}</CommandEmpty>
            {shown.length > 0 && (
              <CommandGroup heading={q.trim() ? "Tasks" : "Recently updated"}>
                {shown.map((t) => (
                  <CommandItem
                    key={t.id}
                    value={t.id}
                    onSelect={() => {
                      setOpen(false);
                      setQ("");
                      onPick(t);
                    }}
                    className="gap-2.5"
                  >
                    <TaskStatusRing task={t} size={14} />
                    <span className="truncate">{t.title}</span>
                    <span className="tabular ml-auto shrink-0 font-mono text-[11.5px] text-faint">{t.key}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** "Waiting on WEB-1" marker for task rows. `keys` has null for dependencies this view doesn't know the key of. */
export function WaitingBadge({ keys, className }: { keys: (string | null)[]; className?: string }) {
  if (!keys.length) return null;
  const known = keys.filter((k): k is string => !!k);
  const label = known.length === keys.length ? `Waiting on ${known.join(", ")}` : `Waiting on ${keys.length} task${keys.length === 1 ? "" : "s"} to be done`;
  return (
    <span title={label} aria-label={label} className={`inline-flex items-center gap-1 text-[12px] text-faint ${className ?? ""}`}>
      <HourglassIcon className="size-3.5" />
      <span className="tabular font-mono">{keys.length === 1 && known.length === 1 ? known[0] : keys.length}</span>
    </span>
  );
}

/** What a stalled task needs, in a sentence: "VEC-16 and VEC-17 are waiting on it ..." */
export function stalledText(stalled: Stalled, botName: string | null) {
  const n = stalled.blocking.length;
  const keys = n <= 1 ? stalled.blocking.join("") : `${stalled.blocking.slice(0, -1).join(", ")} and ${stalled.blocking[n - 1]}`;
  const waiting = `${keys} ${n === 1 ? "is" : "are"} waiting on it`;
  if (stalled.reason === "needs_owner") return `Nobody is assigned yet. ${waiting}, and it can start once its own dependencies are done, so assign it before then.`;
  if (stalled.reason === "undelivered")
    return `Aimpoint couldn't hand it to ${botName ?? "its bot"}: the wake-up still failed after several retries, so nobody is working on it${n ? `, and ${waiting}` : ""}. Check the bot's connection, then reassign it or @mention the bot to send it again.`;
  if (stalled.reason === "unfinished")
    return `${botName ?? "Its bot"} ended its run without calling complete_task, and again after Aimpoint's one follow-up, so nothing moved it on${n ? `, and ${waiting}` : ""}. Check its last comments, then move it on, reassign it or @mention the bot to hand it back.`;
  // A flow task finished at a step with no hand-off is Stalled even with nothing waiting on it (VEC-316).
  if (stalled.reason === "finished" && !n) return `${botName ?? "Its bot"} finished its work but the task is still at the same step of its flow, and nothing handed it on. Review it and move it to the next step, or reassign it.`;
  return stalled.reason === "finished"
    ? `${botName ?? "Its bot"} finished its work but left it open, and ${waiting}. Review it and move it to Done to release ${n === 1 ? "it" : "them"}, or reassign it.`
    : `Nobody is assigned, and ${waiting}. Assign it to someone.`;
}

/**
 * Chip for task rows. Red "Stalled": other tasks wait on this one and nobody is moving it. Neutral "Needs owner"
 * (reason needs_owner): unassigned with waiters but still blocked itself, so nothing is held up yet (VEC-86).
 */
export function StalledBadge({ stalled, className }: { stalled: Stalled; className?: string }) {
  const { memberById } = useOrgBase();
  if (stalled.reason === "needs_owner") {
    const hint = `Needs an owner. ${stalledText(stalled, null)}`;
    return (
      <span
        title={hint}
        aria-label={hint}
        className={cn("inline-flex h-5 items-center gap-1 rounded-[5px] bg-chip px-1.5 text-[12px] whitespace-nowrap text-muted-foreground", className)}
      >
        <UserRoundIcon className="size-3.5" />
        <span data-chip-word="">Needs owner</span>
      </span>
    );
  }
  const label = `Stalled, needs attention. ${stalledText(stalled, stalled.botId ? (memberById.get(stalled.botId)?.name ?? null) : null)}`;
  return (
    <span
      title={label}
      aria-label={label}
      className={cn("inline-flex h-5 items-center gap-1 rounded-[5px] bg-destructive/10 px-1.5 text-[12px] font-medium whitespace-nowrap text-destructive", className)}
    >
      <CircleAlertIcon className="size-3.5" />
      <span data-chip-word="">Stalled</span>
    </span>
  );
}
