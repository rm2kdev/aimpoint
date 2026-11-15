"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import {
  DragProvider, useDragState, useDragStore,
  type DragItem, type ListRegistration, type MoveDetail, type ReorderDetail,
} from "@/components/ui/drag-provider"

export {
  DragProvider, useDropTarget, useDragState,
  type DragItem, type DragSnapshot, type DropTargetOptions, type MoveDetail, type ReorderDetail,
} from "@/components/ui/drag-provider"

/**
 * Drag-to-reorder for vertical lists, shared app-wide, plus moving items between linked
 * lists and onto other drop targets. Call sites import only this module (and
 * `@/lib/reorder` for pure helpers); there is no DnD library underneath, just pointer and
 * keyboard events, so nothing else needs to know how dragging works.
 *
 * One list (reorder only):
 *
 *   <SortableList
 *     items={projects}
 *     getId={(p) => p.id}
 *     getLabel={(p) => p.name}
 *     onReorder={(ids, { movedId, toIndex }) => saveOrder(ids)}
 *     renderItem={(p, { handleProps, isDragging }) => (
 *       <Link href={p.href} {...handleProps}>{p.name}</Link>
 *     )}
 *   />
 *
 * Linked lists (a board): give each list the same `group`, a stable `listId` and `onMove`.
 * `onMove` is called on the list that receives the item; update both lists there
 * (`transferItem` in `@/lib/reorder`).
 *
 *   {columns.map((col) => (
 *     <SortableList key={col.id} listId={col.id} group="board" aria-label={col.name}
 *       items={col.tasks} getId={(t) => t.id} getLabel={(t) => t.title} getData={(t) => t}
 *       onReorder={(ids) => reorder(col.id, ids)}
 *       onMove={(id, { fromList, toList, toIndex }) => move(id, fromList, toList, toIndex)}
 *       renderItem={...} />
 *   ))}
 *
 * External targets (e.g. sidebar project rows): `useDropTarget(id, { onHoverStart,
 * onHoverEnd, onDrop, accepts, dwellMs, onDwell })` returns `{ ref, isOver, canDrop, dwell }`.
 *
 * Behaviour:
 * - The session lives in `DragProvider` (mounted in the app shell), so a drag started in one
 *   list continues across a client-side route change and can drop into a list on the new
 *   page. A list outside any provider makes its own.
 * - Mouse/pen: press and move 4px to start (plain clicks on links still navigate; the click
 *   that ends a real drag is swallowed). Touch: long-press 250ms, then drag; moving first
 *   scrolls as usual.
 * - While dragging, a 2px brand-blue line marks the insertion point in the list under the
 *   pointer and the dragged row dims in place, so nothing shifts. Positions that would not
 *   change the order show no line. An empty linked list shows a dashed drop zone. A floating
 *   copy of the row follows the pointer once it is over another list or a drop target, or
 *   once the source row is gone (after navigating).
 * - Keyboard: focus the element carrying `handleProps`, Space lifts, Up/Down (Home/End)
 *   move, Left/Right move to the previous/next linked list, Space or Enter drops, Escape or
 *   Tab cancels. Every step is announced in an assertive live region, naming the list.
 * - Inside a scrolling container, holding the pointer near its top or bottom edge
 *   auto-scrolls it; the line follows the scroll.
 * - Escape, pointer cancel, or releasing more than 24px away from every list and target
 *   cancels without calling anything; dropping in the same place is a no-op.
 * - `onReorder` gets the full new id order plus what moved. The list does not keep its own
 *   order: update `items` (optimistically) in the callback.
 * - `handleProps` must be spread on one focusable element per row: the row's link for
 *   whole-row dragging, or a grip button together with `handle` to drag from the grip only.
 */

/** Spread on the row's focusable element (its link, or a grip button). */
export type SortableHandleProps = {
  "data-sortable-handle": ""
  "aria-roledescription": string
  "aria-describedby": string
}

export type SortableItemState = {
  index: number
  /** This row is being dragged (pointer) or is lifted (keyboard). */
  isDragging: boolean
  /** Lifted with the keyboard (the focus ring is still on it). */
  isKeyboardDragging: boolean
  handleProps: SortableHandleProps
}

export type SortableListProps<T> = {
  items: readonly T[]
  getId: (item: T) => string
  renderItem: (item: T, state: SortableItemState) => React.ReactNode
  /** New order of every id, plus the move. Not called on cancel or a same-place drop. */
  onReorder: (ids: string[], detail: ReorderDetail) => void
  /** Name used in screen-reader announcements. Defaults to the id. */
  getLabel?: (item: T) => string
  /** Attached to the dragged item (`DragItem.data`) for drop targets and other lists. */
  getData?: (item: T) => unknown
  /** Stable id for this list, reported as `fromList`/`toList`. Defaults to a generated id. */
  listId?: string
  /** Lists sharing a group exchange items. Without one, the list only reorders itself. */
  group?: string
  /** An item from another list in the group was dropped here. Lists without it don't receive items. */
  onMove?: (id: string, detail: MoveDetail) => void
  /** Refuse some items from other lists. */
  accepts?: (item: DragItem) => boolean
  /** Text in the drop zone an empty linked list shows during a drag. */
  emptyLabel?: string
  /** Only start pointer drags from inside an element carrying `handleProps`. */
  handle?: boolean
  disabled?: boolean
  className?: string
  itemClassName?: string
  /** Accessible name for the list; also names it in announcements. */
  "aria-label"?: string
}

const IGNORE = "input, textarea, select, [contenteditable=''], [contenteditable='true'], [data-sortable-ignore]"

export function SortableList<T>(props: SortableListProps<T>) {
  const store = useDragStore()
  if (!store) {
    return (
      <DragProvider>
        <SortableListInner {...props} />
      </DragProvider>
    )
  }
  return <SortableListInner {...props} />
}

function SortableListInner<T>({
  items,
  getId,
  renderItem,
  onReorder,
  getLabel,
  getData,
  listId: listIdProp,
  group: groupProp,
  onMove,
  accepts,
  emptyLabel = "Drop here",
  handle = false,
  disabled = false,
  className,
  itemClassName,
  "aria-label": ariaLabel,
}: SortableListProps<T>) {
  const store = useDragStore()!
  const uid = React.useId()
  const listId = listIdProp ?? uid
  const group = groupProp ?? `list:${listId}`
  const instructionsId = `${uid}-instructions`
  const listRef = React.useRef<HTMLUListElement>(null)
  const drag = useDragState()

  const reg = (): ListRegistration => ({
    listId,
    group,
    label: ariaLabel ?? "the list",
    disabled,
    el: listRef.current,
    ids: () => items.map(getId),
    itemLabel: (id) => {
      const item = items.find((it) => getId(it) === id)
      return item !== undefined && getLabel ? getLabel(item) : undefined
    },
    onReorder,
    onMove,
    accepts,
  })
  const regRef = React.useRef<ListRegistration | null>(null)
  React.useLayoutEffect(() => {
    regRef.current = reg()
  })
  React.useLayoutEffect(
    () => store.registerList(listId, regRef as { readonly current: ListRegistration }),
    [store, listId],
  )

  // A keyboard drop re-renders the rows (maybe in another list): keep focus on the moved row.
  React.useLayoutEffect(() => {
    store.takeFocus(listId, listRef.current)
  }, [store, listId, items])

  const itemFor = (id: string): DragItem => {
    const item = items.find((it) => getId(it) === id)
    return {
      id,
      listId,
      group,
      label: item !== undefined && getLabel ? getLabel(item) : id,
      data: item !== undefined && getData ? getData(item) : undefined,
    }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLLIElement>, id: string) => {
    if (disabled || store.get()) return
    if (e.pointerType === "mouse" && e.button !== 0) return
    const target = e.target as Element
    if (target.closest(IGNORE)) return
    if (handle && !target.closest("[data-sortable-handle]")) return
    if (target.closest("li[data-sortable-id]") !== e.currentTarget) return // nested list
    store.beginPointer(e, itemFor(id), e.currentTarget)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLLIElement>, id: string, index: number) => {
    if (disabled || !regRef.current) return
    const target = e.target as HTMLElement
    if (!store.get()) {
      if (!target.matches("[data-sortable-handle]")) return
      if (target.closest("li[data-sortable-id]") !== e.currentTarget) return
    }
    const item = items.find((it) => getId(it) === id)
    const data = item !== undefined && getData ? getData(item) : undefined
    if (store.keyDown(e.key, e.repeat, regRef.current, id, index, data)) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  const onBlur = (e: React.FocusEvent<HTMLLIElement>, id: string) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    store.blur(listId, id)
  }

  const handleProps: SortableHandleProps = {
    "data-sortable-handle": "",
    "aria-roledescription": "sortable",
    "aria-describedby": instructionsId,
  }

  const inGroup = !!drag && drag.item.group === group
  const over = drag?.over?.kind === "list" && drag.over.listId === listId ? drag.over : null
  const showEmpty = inGroup && items.length === 0 && !disabled && !!onMove && (!accepts || accepts(drag.item))

  return (
    <>
      <ul
        ref={listRef}
        role="list"
        aria-label={ariaLabel}
        data-sortable-list=""
        data-list-id={listId}
        data-dragging={drag && drag.item.listId === listId ? "" : undefined}
        data-drop-over={over ? "" : undefined}
        className={cn("relative", className)}
        onDragStart={disabled ? undefined : (e) => e.preventDefault()}
      >
        {items.map((item, index) => {
          const id = getId(item)
          const isDragging = drag?.item.id === id && drag.item.listId === listId
          return (
            <li
              key={id}
              data-sortable-id={id}
              data-dragging={isDragging ? "" : undefined}
              className={cn(
                "transition-opacity duration-150 motion-reduce:transition-none",
                isDragging && "opacity-45",
                // Rows under the pointer shouldn't hover-wash or show a link cursor mid-drag.
                inGroup && drag.mode === "pointer" && "pointer-events-none",
                itemClassName,
              )}
              onPointerDown={(e) => onPointerDown(e, id)}
              onKeyDown={(e) => onKeyDown(e, id, index)}
              onBlur={(e) => onBlur(e, id)}
            >
              {renderItem(item, {
                index,
                isDragging,
                isKeyboardDragging: isDragging && drag?.mode === "keyboard",
                handleProps,
              })}
            </li>
          )
        })}
        {showEmpty && (
          <li
            aria-hidden
            role="presentation"
            data-sortable-empty=""
            className={cn(
              "flex h-9 items-center justify-center rounded-lg border border-dashed text-[12px] text-faint transition-colors duration-100 motion-reduce:transition-none",
              over ? "border-brand bg-brand/5 text-brand" : "border-input",
            )}
          >
            {emptyLabel}
          </li>
        )}
        {over && over.lineTop !== null && (
          <li
            aria-hidden
            role="presentation"
            data-sortable-indicator=""
            className="pointer-events-none absolute inset-x-0 h-0.5 -translate-y-1/2 rounded-full bg-brand transition-[top] duration-100 ease-out motion-reduce:transition-none"
            style={{ top: over.lineTop }}
          />
        )}
      </ul>
      <span id={instructionsId} className="sr-only">
        {group.startsWith("list:")
          ? "To reorder, press Space to pick up, use the up and down arrow keys to move, then Space or Enter to drop, or Escape to cancel."
          : "To move, press Space to pick up, use the up and down arrow keys to move within a list and left and right to move to another list, then Space or Enter to drop, or Escape to cancel."}
      </span>
    </>
  )
}
