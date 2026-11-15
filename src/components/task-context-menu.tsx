"use client";

import { ArchiveIcon, ArchiveRestoreIcon, ArrowDownToLineIcon, ArrowUpToLineIcon, CircleDashedIcon, CopyIcon, LinkIcon, PanelRightOpenIcon, SignalHighIcon, TagIcon, UserIcon, UserPlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useOrgBase } from "@/components/org-provider";
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

interface TaskMenuProps {
  task: Task;
  onOpen: () => void;
  onPatch: (patch: TaskPatch) => void;
  onArchive: (archived: boolean) => void;
  /** Manual sort only: move to the top or bottom of its status group (creator or admin). */
  onMove?: (where: "top" | "bottom") => void;
}

const touchOrPen = (e: React.PointerEvent) => e.pointerType !== "mouse";

/**
 * Right-click menu for a task row: move it through the workflow (status, priority, assignee, type) without
 * opening it, plus open, copy link/ID and archive. Follows the same access rule as the pane: the assignee
 * can change the workflow fields, only the creator or an admin can archive, everyone else gets read-only items.
 *
 * Mounted lazily (VEC-81): spread `rowProps` on the row and render `menu` inside it. The Radix menu (and its
 * status/assignee option lists) mounts on the row's first right-click or long press, not with the row, so a
 * long list opens without a context-menu tree per row. Same gestures as ContextMenuTrigger: right-click (or
 * the context-menu key) opens at the pointer, a 700 ms touch/pen press opens, and the row gets
 * `data-state="open"` while the menu is up.
 */
export function useTaskContextMenu(props: TaskMenuProps) {
  // `n` changes on every request, so a second right-click on the same row reopens the menu at the new point.
  const [at, setAt] = useState<{ x: number; y: number; n: number } | null>(null);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const longPress = useRef(0);
  const clear = () => window.clearTimeout(longPress.current);
  useEffect(() => () => window.clearTimeout(longPress.current), []);
  const request = (x: number, y: number) => setAt((p) => ({ x, y, n: (p?.n ?? 0) + 1 }));

  const rowProps = {
    "data-state": open ? "open" : "closed",
    style: { WebkitTouchCallout: "none" } as React.CSSProperties,
    onContextMenu: (e: React.MouseEvent) => {
      // The replayed event from the menu's own trigger bubbles through the row: not a new request.
      if (e.target === anchor.current) return;
      clear();
      e.preventDefault();
      request(e.clientX, e.clientY);
    },
    onPointerDown: (e: React.PointerEvent) => {
      if (!touchOrPen(e)) return;
      clear();
      const { clientX, clientY } = e;
      longPress.current = window.setTimeout(() => request(clientX, clientY), 700);
    },
    onPointerMove: (e: React.PointerEvent) => touchOrPen(e) && clear(),
    onPointerUp: (e: React.PointerEvent) => touchOrPen(e) && clear(),
    onPointerCancel: (e: React.PointerEvent) => touchOrPen(e) && clear(),
  };
  const menu = at && <LazyMenu {...props} at={at} anchor={anchor} onOpenChange={setOpen} />;
  return { rowProps, menu };
}

function LazyMenu({
  at,
  anchor,
  onOpenChange,
  ...props
}: TaskMenuProps & {
  at: { x: number; y: number; n: number };
  anchor: React.RefObject<HTMLSpanElement | null>;
  onOpenChange: (open: boolean) => void;
}) {
  // Hand the request to Radix's trigger as the contextmenu event it expects; it opens at clientX/clientY.
  useEffect(() => {
    anchor.current?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y }));
  }, [at, anchor]);
  return (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger asChild>
        <span ref={anchor} hidden />
      </ContextMenuTrigger>
      <TaskMenuContent {...props} />
    </ContextMenu>
  );
}

function TaskMenuContent({ task, onOpen, onPatch, onArchive, onMove }: TaskMenuProps) {
  const { me, isAdmin, memberById } = useOrgBase();
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
        {onMove && access === "full" && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => onMove("top")}>
              <ArrowUpToLineIcon />
              Move to top
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onMove("bottom")}>
              <ArrowDownToLineIcon />
              Move to bottom
            </ContextMenuItem>
          </>
        )}
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
