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
import { isDragActive } from "@/components/ui/drag-provider";
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
const LONG_PRESS_MS = 700;
/** Same tolerance as the drag provider's touch slop: a smaller move is a finger resting, not a gesture. */
const LONG_PRESS_SLOP = 8;

/**
 * Right-click menu for a task row: move it through the workflow (status, priority, assignee, type) without
 * opening it, plus open, copy link/ID and archive. Follows the same access rule as the pane: the assignee
 * can change the workflow fields, only the creator or an admin can archive, everyone else gets read-only items.
 *
 * Mounted lazily (VEC-81): spread `rowProps` on the row and render `menu` inside it. The Radix menu (and its
 * status/assignee option lists) mounts on the row's first right-click or long press, not with the row, so a
 * long list opens without a context-menu tree per row. Same gestures as ContextMenuTrigger: right-click (or
 * the context-menu key) opens at the pointer, a 700 ms touch/pen press opens, and the row gets
 * `data-state="open"` while the menu is up. On a row that touch can drag (Manual sort, creator or admin) the
 * press has lifted a drag by then, so the menu opens on release instead, and only if the finger didn't move
 * (VEC-103): press and hold 700 ms, lift without moving. Moving the lifted row is a drag with no menu.
 */
export function useTaskContextMenu(props: TaskMenuProps) {
  // `n` changes on every request, so a second right-click on the same row reopens the menu at the new point.
  const [at, setAt] = useState<{ x: number; y: number; n: number } | null>(null);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const longPress = useRef(0);
  const pressStart = useRef({ x: 0, y: 0 });
  // Stops waiting for the release of a lifted long-press (see holdForRelease).
  const stopHold = useRef<(() => void) | null>(null);
  const clear = () => {
    window.clearTimeout(longPress.current);
    stopHold.current?.();
  };
  useEffect(
    () => () => {
      window.clearTimeout(longPress.current);
      stopHold.current?.();
    },
    [],
  );
  const request = (x: number, y: number) => setAt((p) => ({ x, y, n: (p?.n ?? 0) + 1 }));

  // VEC-103: on a draggable row a touch press lifts a drag at 250 ms, so by 700 ms the gesture is a drag
  // and the menu must not open over it. Wait for the release instead: a finger lifted where it went down
  // (no move past the slop) was a long-press, not a move, so the menu opens then; any move makes it a drag
  // and no menu follows. Window capture listeners, because the drag shield takes the moves from the row.
  const holdForRelease = (pointerId: number, x: number, y: number) => {
    const stop = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", stop, true);
      if (stopHold.current === stop) stopHold.current = null;
    };
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId && Math.hypot(ev.clientX - x, ev.clientY - y) > LONG_PRESS_SLOP) stop();
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      // Still lifted at the release (an Escape cancel already ended it): let the no-op drop finish first.
      const lifted = isDragActive();
      stop();
      if (lifted) window.setTimeout(() => request(x, y), 0);
    };
    stopHold.current?.();
    stopHold.current = stop;
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", stop, true);
  };

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
      const { clientX, clientY, pointerId } = e;
      pressStart.current = { x: clientX, y: clientY };
      longPress.current = window.setTimeout(
        () => (isDragActive() ? holdForRelease(pointerId, clientX, clientY) : request(clientX, clientY)),
        LONG_PRESS_MS,
      );
    },
    // A finger never holds perfectly still: only a move past the slop cancels the long-press.
    onPointerMove: (e: React.PointerEvent) =>
      touchOrPen(e) &&
      Math.hypot(e.clientX - pressStart.current.x, e.clientY - pressStart.current.y) > LONG_PRESS_SLOP &&
      window.clearTimeout(longPress.current),
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
  const statusOptions = useStatusOptions(task.projectId);
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
