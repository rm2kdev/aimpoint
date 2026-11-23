"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import {
  DragProvider, useDragSelector, useDragStore,
  type DragItem, type ListRegistration, type MoveDetail, type NestOptions, type ReorderDetail,
} from "@/components/ui/drag-provider"

export {
  DragProvider, useDropTarget, useDragState, useDragSelector, useNestState,
  type DragItem, type DragSnapshot, type DropTargetOptions, type MoveDetail, type NestOptions, type ReorderDetail,
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
 * Rows as drop targets (dwell-to-nest, VEC-448): pass `nest={{ accepts, dwellMs, onNest }}`. The middle band of
 * each row (`band`, default half its height; of its `[data-nest-zone]` parts when it has them, e.g. a parent row
 * with its sub-tasks listed under it in the same item; a part with `data-nest-zone="<id>"` is a zone for row `id`,
 * VEC-451) becomes a nest zone and its top/bottom edges stay reorder insertion
 * points. Hovering a row's zone keeps the gap where it was (nothing slides under the pointer); after `dwellMs`
 * the row arms, and a release then calls `onNest(item, rowId)` instead of moving the item. Leaving the zone first
 * cancels the dwell. A row reads its state with `useNestState(rowId)` ("over" | "armed" | null).
 *
 * Behaviour:
 * - The session lives in `DragProvider` (mounted in the app shell), so a drag started in one
 *   list continues across a client-side route change and can drop into a list on the new
 *   page. A list outside any provider makes its own.
 * - Mouse/pen: press and move 4px to start (plain clicks on links still navigate; the click
 *   that ends a real drag is swallowed). Touch: long-press 250ms, then drag; moving first
 *   scrolls as usual.
 * - A pointer drag looks the same everywhere (VEC-95): a floating copy of the row follows the
 *   pointer from the moment the drag starts, in its own list, over another list, a heading or
 *   a drop target, and the source row leaves an empty slot.
 * - Where it would land opens up (VEC-96): in the list under the pointer the rows slide apart
 *   to leave a gap the height of the row (in its own list, the rows between the slot and the
 *   gap close the slot up); when the card leaves its list the rows below the slot slide up
 *   over it, and it reopens when the card comes back. The list keeps the room at its end
 *   meanwhile, so nothing below moves under the pointer. An empty linked list shows a dashed
 *   drop zone that grows to the row's height. On a drop the card
 *   glides into the gap (or back into its slot after a cancel) and the gaps close. Rows move
 *   by transform only; under reduced motion the gaps open and close without sliding. A
 *   keyboard lift keeps the row in place, dimmed, with no floating copy, and a 2px brand-blue
 *   line marks where it would land.
 * - Keyboard: focus the element carrying `handleProps`, Space lifts, Up/Down (Home/End)
 *   move, Left/Right move to the previous/next linked list, Space or Enter drops, Escape or
 *   Tab cancels. Every step is announced in an assertive live region, naming the list.
 * - Inside a scrolling container, holding the pointer near its top or bottom edge
 *   auto-scrolls it; the gap follows the scroll.
 * - Escape, pointer cancel, or releasing more than 24px away from every list and target
 *   cancels without calling anything; dropping in the same place is a no-op.
 * - `onReorder` gets the full new id order plus what moved. The list does not keep its own
 *   order: update `items` (optimistically) in the callback.
 * - `handleProps` must be spread on one focusable element per row: the row's link for
 *   whole-row dragging, or a grip button together with `handle` to drag from the grip only.
 *
 * Performance (VEC-73): the list subscribes only to the parts of the drag that change its own
 * markup (drag starts/ends, the pointer enters/leaves it, which row is lifted), and each row is
 * a memoised component, so a pointer move that only moves the gap re-renders nothing: the
 * provider writes a transform on the rows that change side (and the keyboard line re-renders
 * itself only). `renderItem` is called again only for rows whose item, index or drag
 * state changed, or when `renderItem` itself changes identity; keep it (and what it closes
 * over) stable when the rows are expensive, and memoise the row component it returns.
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
  /** Rows double as dwell-to-nest drop targets (VEC-448). Pointer drags only. */
  nest?: NestOptions
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

/** Duration and easing shared by the row and list-padding slides; matches GAP_MS / GAP_EASE in drag-provider. */
const GAP_TRANSITION = "duration-150 ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none"

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

type RowHandlers = {
  pointerDown: (e: React.PointerEvent<HTMLLIElement>, id: string) => void
  keyDown: (e: React.KeyboardEvent<HTMLLIElement>, id: string, index: number) => void
  blur: (e: React.FocusEvent<HTMLLIElement>, id: string) => void
}

function SortableListInner<T>(props: SortableListProps<T>) {
  const {
    items,
    getId,
    renderItem,
    listId: listIdProp,
    group: groupProp,
    onMove,
    accepts,
    emptyLabel = "Drop here",
    disabled = false,
    className,
    itemClassName,
    "aria-label": ariaLabel,
  } = props
  const store = useDragStore()!
  const uid = React.useId()
  const listId = listIdProp ?? uid
  const group = groupProp ?? `list:${listId}`
  const instructionsId = `${uid}-instructions`
  const listRef = React.useRef<HTMLUListElement>(null)

  // Narrow subscriptions: each re-renders the list only when its own value changes (VEC-73).
  const inGroup = useDragSelector((d) => !!d && d.item.group === group)
  const draggingId = useDragSelector((d) => (d && d.item.listId === listId ? d.item.id : null))
  const keyboard = useDragSelector((d) => d?.mode === "keyboard")
  const isOver = useDragSelector((d) => d?.over?.kind === "list" && d.over.listId === listId)
  const accepting = useDragSelector((d) => !!d && (!accepts || accepts(d.item)))
  const showEmpty = inGroup && items.length === 0 && !disabled && !!onMove && accepting

  // The latest props, for the registration and the row event handlers (which keep one identity).
  const latest = React.useRef({ props, listId, group })
  React.useLayoutEffect(() => {
    latest.current = { props, listId, group }
  })

  const regRef = React.useRef<ListRegistration | null>(null)
  const layoutSig = React.useRef("")
  React.useLayoutEffect(() => {
    regRef.current = registration(latest.current.props, listId, group, listRef.current)
    // Rows added, moved or removed, or the drop zone shown: cached row positions are stale. A re-render that
    // changed neither (a teammate edited a row's fields) keeps them, so live edits cost no layout reads.
    // Mid-drag the open gap is re-applied to the new rows too, or it stays keyed to the old ones (VEC-104).
    const sig = `${showEmpty}|${items.map(getId).join(",")}`
    if (sig !== layoutSig.current) {
      layoutSig.current = sig
      store.rowsChanged()
    }
    // A drop just ended and this list renders the dropped row: the floating card glides onto it (VEC-96).
    store.claimSettle(listRef.current)
  })
  React.useLayoutEffect(
    () => store.registerList(listId, regRef as { readonly current: ListRegistration }),
    [store, listId],
  )

  // A keyboard drop re-renders the rows (maybe in another list): keep focus on the moved row.
  React.useLayoutEffect(() => {
    store.takeFocus(listId, listRef.current)
  }, [store, listId, items])

  // Row event handlers with a stable identity (they read the list's latest props), so memoised rows stay put.
  const handlers = React.useMemo<RowHandlers>(() => {
    const find = (id: string) => {
      const { items, getId } = latest.current.props
      return items.find((it) => getId(it) === id)
    }
    const itemFor = (id: string): DragItem => {
      const { props: p, listId, group } = latest.current
      const item = find(id)
      return {
        id,
        listId,
        group,
        label: item !== undefined && p.getLabel ? p.getLabel(item) : id,
        data: item !== undefined && p.getData ? p.getData(item) : undefined,
      }
    }
    return {
      pointerDown(e, id) {
        const { disabled, handle } = latest.current.props
        if (disabled || store.get()) return
        if (e.pointerType === "mouse" && e.button !== 0) return
        const target = e.target as Element
        if (target.closest(IGNORE)) return
        if (handle && !target.closest("[data-sortable-handle]")) return
        if (target.closest("li[data-sortable-id]") !== e.currentTarget) return // nested list
        store.beginPointer(e, itemFor(id), e.currentTarget)
      },
      keyDown(e, id, index) {
        const p = latest.current.props
        const reg = regRef.current
        if (p.disabled || !reg) return
        const target = e.target as HTMLElement
        if (!store.get()) {
          if (!target.matches("[data-sortable-handle]")) return
          if (target.closest("li[data-sortable-id]") !== e.currentTarget) return
        }
        const item = find(id)
        const data = item !== undefined && p.getData ? p.getData(item) : undefined
        if (store.keyDown(e.key, e.repeat, reg, id, index, data)) {
          e.preventDefault()
          e.stopPropagation()
        }
      },
      blur(e, id) {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        store.blur(latest.current.listId, id)
      },
    }
  }, [store])

  const handleProps = React.useMemo<SortableHandleProps>(
    () => ({
      "data-sortable-handle": "",
      "aria-roledescription": "sortable",
      "aria-describedby": instructionsId,
    }),
    [instructionsId],
  )

  return (
    <>
      <ul
        ref={listRef}
        role="list"
        aria-label={ariaLabel}
        data-sortable-list=""
        data-list-id={listId}
        data-dragging={draggingId !== null ? "" : undefined}
        data-drop-over={isOver ? "" : undefined}
        // Mid-drag the provider's shield layer keeps rows from hover-washing or showing a link cursor. No
        // drag-time class here: a rule toggled on the list restyles every row at each drag start and drop (VEC-80).
        // The bottom padding is the room a pointer drag's gap needs in a list it isn't from (VEC-96); it
        // animates with the rows' slide. Static, so nothing is toggled on the list.
        className={cn(GAP_TRANSITION, "relative transition-[padding-bottom]", className)}
        onDragStart={disabled ? undefined : (e) => e.preventDefault()}
      >
        {items.map((item, index) => {
          const id = getId(item)
          const isDragging = draggingId === id
          return (
            <SortableRow
              key={id}
              id={id}
              item={item}
              index={index}
              isDragging={isDragging}
              isKeyboardDragging={isDragging && keyboard}
              lifted={isDragging && !keyboard}
              handleProps={handleProps}
              renderItem={renderItem}
              handlers={handlers}
              className={itemClassName}
            />
          )
        })}
        {showEmpty && (
          <li
            aria-hidden
            role="presentation"
            data-sortable-empty=""
            // The pointer drag's taller drop zone (VEC-96) snaps to the row's height (a few px) rather than
            // animating it: a height transition relays out and repaints everything below the group on each of
            // its frames, a hundred rows a frame in a long list (VEC-97).
            className={cn(
              "flex h-9 items-center justify-center rounded-lg border border-dashed text-[12px] text-faint transition-[color,background-color,border-color] duration-150 motion-reduce:transition-none",
              isOver ? "border-brand bg-brand/5 text-brand" : "border-input",
            )}
          >
            {emptyLabel}
          </li>
        )}
        <InsertionLine listId={listId} />
      </ul>
      <span id={instructionsId} className="sr-only">
        {group.startsWith("list:")
          ? "To reorder, press Space to pick up, use the up and down arrow keys to move, then Space or Enter to drop, or Escape to cancel."
          : "To move, press Space to pick up, use the up and down arrow keys to move within a list and left and right to move to another list, then Space or Enter to drop, or Escape to cancel."}
      </span>
    </>
  )
}

function registration<T>(p: SortableListProps<T>, listId: string, group: string, el: HTMLUListElement | null): ListRegistration {
  return {
    listId,
    group,
    label: p["aria-label"] ?? "the list",
    disabled: !!p.disabled,
    el,
    ids: () => p.items.map(p.getId),
    itemLabel: (id) => {
      const item = p.items.find((it) => p.getId(it) === id)
      return item !== undefined && p.getLabel ? p.getLabel(item) : undefined
    },
    onReorder: p.onReorder,
    onMove: p.onMove,
    accepts: p.accepts,
    nest: p.nest,
  }
}

type SortableRowProps<T> = {
  id: string
  item: T
  index: number
  isDragging: boolean
  isKeyboardDragging: boolean
  /** Lifted by a pointer drag: an empty slot while the floating card stands in for it. */
  lifted: boolean
  handleProps: SortableHandleProps
  renderItem: (item: T, state: SortableItemState) => React.ReactNode
  handlers: RowHandlers
  className?: string
}

/** One row. Memoised: a drag re-renders only the lifted row, not its siblings. */
const SortableRow = React.memo(function SortableRow<T>({
  id,
  item,
  index,
  isDragging,
  isKeyboardDragging,
  lifted,
  handleProps,
  renderItem,
  handlers,
  className,
}: SortableRowProps<T>) {
  return (
    <li
      data-sortable-id={id}
      data-dragging={isDragging ? "" : undefined}
      // A pointer drag lifts the row out (the provider's floating card is the task in your hand) and leaves
      // its slot empty: same height, so nothing shifts under a still pointer and the gaps next to it stay the
      // no-op drop. A keyboard lift keeps it in place, dimmed, with the focus ring on it.
      data-drag-lifted={lifted ? "" : undefined}
      // A static transition (nothing toggled per drag, VEC-80): the provider shifts rows with a transform to
      // open the landing gap, and they slide (VEC-96). `isolate` makes every row its own stacking context up
      // front, so a row's z-indexed buttons never sit in the list's shared stacking order: a transform starting
      // or ending on one row then repaints that row, not every row on the page (VEC-97).
      className={cn(
        GAP_TRANSITION,
        "isolate transition-[opacity,transform]",
        lifted && "invisible",
        isKeyboardDragging && "opacity-45",
        className,
      )}
      onPointerDown={(e) => handlers.pointerDown(e, id)}
      onKeyDown={(e) => handlers.keyDown(e, id, index)}
      onBlur={(e) => handlers.blur(e, id)}
    >
      {renderItem(item, { index, isDragging, isKeyboardDragging, handleProps })}
    </li>
  )
}) as <T>(props: SortableRowProps<T>) => React.ReactElement

/** The 2px insertion line, for keyboard moves. Its own subscriber: a gap change re-renders this element only. */
function InsertionLine({ listId }: { listId: string }) {
  const lineTop = useDragSelector((d) => (d?.over?.kind === "list" && d.over.listId === listId ? d.over.lineTop : null))
  if (lineTop === null) return null
  return (
    <li
      aria-hidden
      role="presentation"
      data-sortable-indicator=""
      // Positioned with a transform (composited) rather than `top`, so gliding between gaps never relayouts the list.
      className="pointer-events-none absolute inset-x-0 top-0 h-0.5 rounded-full bg-brand transition-transform duration-100 ease-out motion-reduce:transition-none"
      style={{ transform: `translateY(calc(${lineTop}px - 50%))` }}
    />
  )
}
