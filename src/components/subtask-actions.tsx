"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useOrgBase } from "@/components/org-provider";
import { TaskStatusRing } from "@/components/task-status-ring";
import { useTaskSearch } from "@/components/dependencies";
import { emitLocalTask } from "@/components/new-task-dialog";
import { updateTask } from "@/app/actions/tasks";
import { taskAccess } from "@/lib/access";
import type { Task } from "@/lib/types";

/*
 * VEC-428: people's sub-task actions on top of VEC-426's parent patch (TaskPatch.parentId). "Make sub-task of",
 * "Move to another task" and "Remove from KEY" on a task (pane + row menu), and "Add existing task" in a parent's
 * Sub-tasks section. Rights are the server's (creator or admin of the task being moved); the callers gate on them.
 */

/** Why this task can't go under another one (one level only), or null. */
export function parentBlockedReason(task: Pick<Task, "children">): string | null {
  return task.children && task.children.total > 0 ? "It has sub-tasks of its own" : null;
}

/**
 * VEC-431: the reason a disabled "Make sub-task of" can't be picked, as a muted line under the item. Shared by the
 * pane actions menu and the row context menu. Not a `title`: disabled Radix items get pointer-events-none, so a
 * tooltip on one never shows.
 */
export function ParentBlockedNote({ reason }: { reason: string | null }) {
  if (!reason) return null;
  return <p className="px-1.5 pt-0.5 pb-1 text-[11.5px] leading-snug text-muted-foreground">{reason}, so it can&rsquo;t go under another task.</p>;
}

/**
 * Sets or clears a task's parent, toasts the result, and echoes it to open lists. Resolves to the saved task, or null.
 * `drop`: it was dragged onto the parent's row in a list (VEC-449), so the toast says "Moved X under Y".
 */
export function useSetParent() {
  const { org } = useOrgBase();
  return async (task: Pick<Task, "id" | "key" | "parentKey">, parent: Pick<Task, "id" | "key"> | null, opts?: { drop?: boolean }): Promise<Task | null> => {
    const r = await updateTask(org.slug, task.id, { parentId: parent?.id ?? null });
    if (!r.ok) {
      toast.error(r.error ?? "That didn't go through. Try again.");
      return null;
    }
    const saved = r.data!;
    emitLocalTask(saved);
    const made = (key: string) => (opts?.drop ? `Moved ${task.key} under ${key}` : `Made ${task.key} a sub-task of ${key}`);
    if (!parent) toast.success(`Removed ${task.key} from ${task.parentKey ?? "its parent task"}`);
    else if (saved.parentKey && saved.parentKey !== parent.key)
      toast.success(made(saved.parentKey), { description: `${parent.key} is a sub-task of ${saved.parentKey}, so it went there.` });
    else toast.success(made(saved.parentKey ?? parent.key));
    return saved;
  };
}

/** A searchable task list in a dialog (works from a row's context menu and on phones, where a popover is cramped). */
function TaskPickerDialog({
  open,
  onOpenChange,
  title,
  description,
  filter,
  hint,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  filter: (t: Task) => boolean;
  /** A short note on the right of a result (e.g. where it goes). */
  hint?: (t: Task) => string | null;
  onPick: (t: Task) => void;
}) {
  const [q, setQ] = useState("");
  const results = useTaskSearch(open, q);
  const shown = results.filter(filter);
  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) setQ("");
  };
  // The dialog may render inside a task row (its context menu): keep its clicks and keys from reaching the row.
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        showCloseButton={false}
        className="top-[14vh] translate-y-0 gap-0 overflow-hidden rounded-xl! p-0 sm:max-w-[520px]"
        onClick={stop}
        onPointerDown={stop}
        onContextMenu={stop}
        onKeyDown={stop}
        data-task-picker=""
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        <Command shouldFilter={false}>
          <div className="px-2.5 pt-2 pb-1 text-[12.5px] font-medium text-muted-foreground">{title}</div>
          <CommandInput value={q} onValueChange={setQ} placeholder="Search tasks by title or key…" />
          <CommandList className="max-h-[min(360px,50dvh)]">
            <CommandEmpty>{q.trim() ? "No matching tasks" : "No tasks to pick yet"}</CommandEmpty>
            {shown.length > 0 && (
              <CommandGroup heading={q.trim() ? "Tasks" : "Recently updated"}>
                {shown.map((t) => {
                  const note = hint?.(t);
                  return (
                    <CommandItem
                      key={t.id}
                      value={t.id}
                      onSelect={() => {
                        close(false);
                        onPick(t);
                      }}
                      className="gap-2.5"
                    >
                      <TaskStatusRing task={t} size={14} />
                      <span className="min-w-0 truncate">{t.title}</span>
                      <span className="ml-auto flex shrink-0 items-center gap-2">
                        {note && <span className="text-[11.5px] text-faint max-sm:hidden">{note}</span>}
                        <span className="tabular font-mono text-[11.5px] text-faint">{t.key}</span>
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Make sub-task of…" / "Move to another task…" for `task`. Leaves out the task itself, its own sub-tasks (a loop),
 * archived tasks and where it already is; a sub-task can be picked and the server puts it under that one's parent.
 */
export function ParentPickerDialog({
  task,
  open,
  onOpenChange,
  onSaved,
}: {
  task: Pick<Task, "id" | "key" | "parentId" | "parentKey">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (t: Task) => void;
}) {
  const setParent = useSetParent();
  const moving = !!task.parentId;
  return (
    <TaskPickerDialog
      open={open}
      onOpenChange={onOpenChange}
      title={moving ? `Move ${task.key} to another task` : `Make ${task.key} a sub-task of…`}
      description={`Pick the task ${task.key} should be part of.`}
      filter={(t) => t.id !== task.id && !t.archivedAt && t.parentId !== task.id && t.id !== task.parentId && !(task.parentId && t.parentId === task.parentId)}
      hint={(t) => (t.parentKey ? `goes under ${t.parentKey}` : null)}
      onPick={async (t) => {
        const saved = await setParent(task, t);
        if (saved) onSaved?.(saved);
      }}
    />
  );
}

/**
 * "Add existing task" in a parent's Sub-tasks section: attach another task under `parent`. Offers only tasks the
 * person may move (creator or admin), that aren't archived, already here, or parents themselves.
 */
export function AddExistingSubtaskDialog({
  parent,
  open,
  onOpenChange,
  onSaved,
}: {
  parent: Pick<Task, "id" | "key" | "parentId">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (t: Task) => void;
}) {
  const { me, isAdmin } = useOrgBase();
  const setParent = useSetParent();
  return (
    <TaskPickerDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Add an existing task to ${parent.key}`}
      description={`Pick a task to make it a sub-task of ${parent.key}.`}
      filter={(t) =>
        t.id !== parent.id && t.id !== parent.parentId && t.parentId !== parent.id && !t.archivedAt && !parentBlockedReason(t) && taskAccess(t, me.id, isAdmin) === "full"
      }
      hint={(t) => (t.parentKey ? `moves from ${t.parentKey}` : null)}
      onPick={async (t) => {
        const saved = await setParent(t, parent);
        if (saved) onSaved?.(saved);
      }}
    />
  );
}
