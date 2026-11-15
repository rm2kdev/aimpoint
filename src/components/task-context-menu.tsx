"use client";

import { ArchiveIcon, ArchiveRestoreIcon, CircleDashedIcon, CopyIcon, LinkIcon, PanelRightOpenIcon, SignalHighIcon, TagIcon, UserIcon, UserPlusIcon } from "lucide-react";
import { toast } from "sonner";
import { useOrg } from "@/components/org-provider";
import { PRIORITY_OPTIONS, TYPE_OPTIONS, useAssigneeOptions, useStatusOptions, type Option } from "@/components/pickers";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { taskAccess } from "@/lib/access";
import type { TaskPatch } from "@/app/actions/tasks";
import type { Priority, Task, TaskType } from "@/lib/types";

/**
 * Right-click menu for a task row: move it through the workflow (status, priority, assignee, type) without
 * opening it, plus open, copy link/ID and archive. Follows the same access rule as the pane: the assignee
 * can change the workflow fields, only the creator or an admin can archive, everyone else gets read-only items.
 */
export function TaskContextMenu({
  task,
  children,
  onOpen,
  onPatch,
  onArchive,
}: {
  task: Task;
  children: React.ReactNode;
  onOpen: () => void;
  onPatch: (patch: TaskPatch) => void;
  onArchive: (archived: boolean) => void;
}) {
  const { me, isAdmin, memberById } = useOrg();
  const access = taskAccess(task, me.id, isAdmin);
  const canWork = access !== "comment";
  const creator = memberById.get(task.createdBy);
  const statusOptions = useStatusOptions();
  const assigneeOptions = useAssigneeOptions();

  const copy = (text: string, what: string) => {
    navigator.clipboard.writeText(text).then(
      () => toast.success(`Copied ${what}`),
      () => toast.error("Couldn't copy to the clipboard"),
    );
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56" aria-label={`${task.key} actions`}>
        <ContextMenuLabel className="truncate">
          <span className="font-mono">{task.key}</span> <span className="font-normal">{task.title}</span>
        </ContextMenuLabel>
        <ContextMenuItem onSelect={onOpen}>
          <PanelRightOpenIcon />
          Open
        </ContextMenuItem>
        <ContextMenuSeparator />

        <FieldSub
          icon={<CircleDashedIcon />}
          label="Status"
          disabled={!canWork}
          value={task.statusId}
          options={statusOptions}
          onChange={(statusId) => onPatch({ statusId })}
        />
        <FieldSub
          icon={<SignalHighIcon />}
          label="Priority"
          disabled={!canWork}
          value={`${task.priority}`}
          options={PRIORITY_OPTIONS}
          onChange={(v) => onPatch({ priority: Number(v) as Priority })}
        />
        <FieldSub
          icon={<UserIcon />}
          label="Assignee"
          disabled={!canWork}
          value={task.assigneeId ?? "none"}
          options={assigneeOptions}
          onChange={(v) => onPatch({ assigneeId: v === "none" ? null : v })}
          className="max-h-80"
        />
        {canWork && task.assigneeId !== me.id && (
          <ContextMenuItem onSelect={() => onPatch({ assigneeId: me.id })}>
            <UserPlusIcon />
            Assign to me
          </ContextMenuItem>
        )}
        <FieldSub
          icon={<TagIcon />}
          label="Type"
          disabled={!canWork}
          value={task.type}
          options={TYPE_OPTIONS}
          onChange={(type) => onPatch({ type: type as TaskType })}
        />
        {!canWork && (
          <p className="px-1.5 pt-0.5 pb-1 text-[11.5px] leading-snug text-muted-foreground">
            Only {creator?.name ?? "the creator"}, the assignee or an admin can change this task.
          </p>
        )}

        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => copy(`${location.origin}${location.pathname}?task=${task.key}`, "link")}>
          <LinkIcon />
          Copy link
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => copy(task.key, task.key)}>
          <CopyIcon />
          Copy ID
        </ContextMenuItem>
        {access === "full" && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => onArchive(!task.archivedAt)}>
              {task.archivedAt ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
              {task.archivedAt ? "Restore" : "Archive"}
              <ContextMenuShortcut>E</ContextMenuShortcut>
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function FieldSub<V extends string>({
  icon,
  label,
  value,
  options,
  onChange,
  disabled,
  className,
}: {
  icon: React.ReactNode;
  label: string;
  value: V;
  options: Option<V>[];
  onChange: (v: V) => void;
  disabled?: boolean;
  className?: string;
}) {
  const current = options.find((o) => o.value === value);
  const groups = [...new Set(options.map((o) => o.group))];
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger disabled={disabled}>
        {icon}
        {label}
        <span className="ml-auto max-w-24 truncate pl-3 text-xs text-muted-foreground">{current?.label}</span>
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className={className} aria-label={label}>
        <ContextMenuRadioGroup value={value} onValueChange={(v) => v !== value && onChange(v as V)}>
          {groups.map((g, i) => (
            <div key={g ?? "_"} role="group">
              {g && (
                <>
                  {i > 0 && <ContextMenuSeparator />}
                  <ContextMenuLabel>{g}</ContextMenuLabel>
                </>
              )}
              {options
                .filter((o) => o.group === g)
                .map((o) => (
                  <ContextMenuRadioItem key={o.value} value={o.value}>
                    {o.icon}
                    <span className="truncate">{o.label}</span>
                  </ContextMenuRadioItem>
                ))}
            </div>
          ))}
        </ContextMenuRadioGroup>
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}
