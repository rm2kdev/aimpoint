"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { gapFromPointer, gapOffset, gapToIndex, indexToGap, isNoopGap, moveItem, type Span } from "@/lib/reorder"

/**
 * Drag-to-reorder for vertical lists, shared app-wide. Call sites import only this module
 * (and `@/lib/reorder` for pure helpers); there is no DnD library underneath, just pointer
 * and keyboard events, so nothing else needs to know how dragging works.
 *
 * Usage:
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
 * Behaviour:
 * - Mouse/pen: press and move 4px to start (plain clicks on links still navigate; the click
 *   that ends a real drag is swallowed). Touch: long-press 250ms, then drag; moving first
 *   scrolls as usual.
 * - While dragging, a 2px brand-blue line marks the insertion point between rows and the
 *   dragged row dims in place, so nothing shifts. Positions that would not change the order
 *   (directly above or below the row itself) show no line.
 * - Keyboard: focus the element carrying `handleProps`, Space lifts, Up/Down (Home/End)
 *   move, Space or Enter drops, Escape or Tab cancels. Every step is announced in an
 *   assertive live region.
 * - Escape, pointer cancel, or releasing more than 24px outside the list cancels without
 *   calling `onReorder`; dropping in the same place is a no-op.
 * - `onReorder` gets the full new id order plus what moved. The list does not keep its own
 *   order: update `items` (optimistically) in the callback.
 * - `handleProps` must be spread on one focusable element per row: the row's link for
 *   whole-row dragging, or a grip button together with `handle` to drag from the grip only.
 */

export type ReorderDetail = { movedId: string; fromIndex: number; toIndex: number }

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
  /** Only start pointer drags from inside an element carrying `handleProps`. */
  handle?: boolean
  disabled?: boolean
  className?: string
  itemClassName?: string
  /** Accessible name for the list. */
  "aria-label"?: string
}

const MOUSE_THRESHOLD = 4
const TOUCH_DELAY_MS = 250
const TOUCH_SLOP = 8
const OUTSIDE_MARGIN = 24
const IGNORE = "input, textarea, select, [contenteditable=''], [contenteditable='true'], [data-sortable-ignore]"

type DragState = {
  id: string
  from: number
  /** Insertion gap (0..n), or null while the pointer is outside the list. */
  gap: number | null
  mode: "pointer" | "keyboard"
  lineTop: number | null
}

type Session = { cleanup: () => void }

export function SortableList<T>({
  items,
  getId,
  renderItem,
  onReorder,
  getLabel,
  handle = false,
  disabled = false,
  className,
  itemClassName,
  "aria-label": ariaLabel,
}: SortableListProps<T>) {
  const uid = React.useId()
  const instructionsId = `${uid}-instructions`
  const listRef = React.useRef<HTMLUListElement>(null)
  const sessionRef = React.useRef<Session | null>(null)
  const dragRef = React.useRef<DragState | null>(null)
  const pendingFocusRef = React.useRef<HTMLElement | null>(null)
  const latest = React.useRef({ items, getId, getLabel, onReorder })
  const [drag, setDragState] = React.useState<DragState | null>(null)
  const [announcement, setAnnouncement] = React.useState("")

  React.useLayoutEffect(() => {
    latest.current = { items, getId, getLabel, onReorder }
  })

  // Keyboard drops re-render the rows in a new order; keep focus on the moved handle.
  React.useLayoutEffect(() => {
    const el = pendingFocusRef.current
    if (!el) return
    pendingFocusRef.current = null
    if (el.isConnected && document.activeElement !== el) el.focus({ preventScroll: true })
  }, [items])

  React.useEffect(() => () => sessionRef.current?.cleanup(), [])

  const setDrag = React.useCallback((next: DragState | null) => {
    const prev = dragRef.current
    if (
      prev && next && prev.id === next.id && prev.gap === next.gap &&
      prev.mode === next.mode && prev.lineTop === next.lineTop
    ) return
    dragRef.current = next
    setDragState(next)
  }, [])

  const label = (id: string) => {
    const { items, getId, getLabel } = latest.current
    const item = items.find((it) => getId(it) === id)
    return item !== undefined && getLabel ? getLabel(item) : id
  }

  /** Row extents and list height, in the list's own (scrolling) coordinates. */
  const measure = () => {
    const list = listRef.current
    if (!list) return null
    const box = list.getBoundingClientRect()
    const originY = box.top + list.clientTop - list.scrollTop
    const rows = Array.from(list.querySelectorAll<HTMLElement>(":scope > li[data-sortable-id]"))
    const spans: Span[] = rows.map((row) => {
      const r = row.getBoundingClientRect()
      return { start: r.top - originY, end: r.bottom - originY }
    })
    return { list, box, originY, rows, spans }
  }

  const lineTopFor = (spans: Span[], gap: number) => {
    const list = listRef.current
    const max = list ? list.scrollHeight - 1 : Infinity
    return Math.min(Math.max(gapOffset(spans, gap), 1), max)
  }

  const commit = (id: string, from: number, gap: number | null) => {
    const n = latest.current.items.length
    if (gap === null) {
      setAnnouncement(`Reorder cancelled. ${label(id)} stays at position ${from + 1} of ${n}.`)
      return
    }
    if (isNoopGap(from, gap)) {
      setAnnouncement(`${label(id)} dropped in its original position, ${from + 1} of ${n}.`)
      return
    }
    const { items: list, getId, onReorder } = latest.current
    const toIndex = gapToIndex(from, gap)
    const ids = moveItem(list.map(getId), from, toIndex)
    setAnnouncement(`${label(id)} moved to position ${toIndex + 1} of ${n}.`)
    onReorder(ids, { movedId: id, fromIndex: from, toIndex })
  }

  // ---- Pointer (mouse, pen, touch) -------------------------------------------------------

  const onPointerDown = (e: React.PointerEvent<HTMLLIElement>, id: string, index: number) => {
    if (disabled || dragRef.current || sessionRef.current) return
    if (e.pointerType === "mouse" && e.button !== 0) return
    const target = e.target as Element
    if (target.closest(IGNORE)) return
    if (handle && !target.closest("[data-sortable-handle]")) return
    if (target.closest("li[data-sortable-id]") !== e.currentTarget) return // nested list

    const touch = e.pointerType === "touch"
    const pointerId = e.pointerId
    const startX = e.clientX
    const startY = e.clientY
    let active = false
    let lastX = startX
    let lastY = startY
    let timer: ReturnType<typeof setTimeout> | undefined
    const prevBody = { userSelect: document.body.style.userSelect, cursor: document.body.style.cursor }

    const update = (x: number, y: number) => {
      const m = measure()
      if (!m) return
      const outside =
        x < m.box.left - OUTSIDE_MARGIN || x > m.box.right + OUTSIDE_MARGIN ||
        y < m.box.top - OUTSIDE_MARGIN || y > m.box.bottom + OUTSIDE_MARGIN
      const gap = outside ? null : gapFromPointer(m.spans, y - m.originY)
      setDrag({
        id, from: index, gap, mode: "pointer",
        lineTop: gap === null || isNoopGap(index, gap) ? null : lineTopFor(m.spans, gap),
      })
    }

    const activate = () => {
      active = true
      document.body.style.userSelect = "none"
      document.body.style.cursor = "grabbing"
      window.getSelection()?.removeAllRanges()
      if (touch) navigator.vibrate?.(10)
      setAnnouncement(`Picked up ${label(id)}.`)
      update(lastX, lastY)
    }

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      lastX = ev.clientX
      lastY = ev.clientY
      if (active) {
        update(lastX, lastY)
        return
      }
      const dist = Math.hypot(lastX - startX, lastY - startY)
      if (touch) {
        if (dist > TOUCH_SLOP) cleanup() // a scroll or swipe, not a long-press
      } else if (dist >= MOUSE_THRESHOLD) {
        activate()
      }
    }

    const swallowClick = (ev: MouseEvent) => {
      ev.preventDefault()
      ev.stopPropagation()
    }

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      if (!active) return cleanup()
      // The click that ends a drag must not follow the link under the pointer.
      window.addEventListener("click", swallowClick, { capture: true, once: true })
      setTimeout(() => window.removeEventListener("click", swallowClick, { capture: true }), 0)
      const gap = dragRef.current?.gap ?? null
      cleanup()
      commit(id, index, gap)
    }

    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      const wasActive = active
      cleanup()
      if (wasActive) commit(id, index, null)
    }

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || !active) return
      ev.preventDefault()
      ev.stopPropagation()
      cleanup()
      commit(id, index, null)
    }

    // Once a touch drag is live, stop the page from scrolling under the finger.
    const onTouchMove = (ev: TouchEvent) => {
      if (active && ev.cancelable) ev.preventDefault()
    }
    const onContextMenu = (ev: Event) => {
      if (active || touch) ev.preventDefault()
    }

    function cleanup() {
      if (timer) clearTimeout(timer)
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onCancel)
      window.removeEventListener("keydown", onKey, { capture: true })
      window.removeEventListener("touchmove", onTouchMove)
      window.removeEventListener("contextmenu", onContextMenu)
      if (active) {
        document.body.style.userSelect = prevBody.userSelect
        document.body.style.cursor = prevBody.cursor
        setDrag(null)
      }
      active = false
      sessionRef.current = null
    }

    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onCancel)
    window.addEventListener("keydown", onKey, { capture: true })
    if (touch) {
      window.addEventListener("touchmove", onTouchMove, { passive: false })
      window.addEventListener("contextmenu", onContextMenu)
      timer = setTimeout(activate, TOUCH_DELAY_MS)
    }
    sessionRef.current = { cleanup }
  }

  // ---- Keyboard -------------------------------------------------------------------------

  const onKeyDown = (e: React.KeyboardEvent<HTMLLIElement>, id: string, index: number) => {
    if (disabled) return
    const current = dragRef.current
    const n = latest.current.items.length
    const target = e.target as HTMLElement

    if (!current) {
      if (e.key !== " " || e.repeat) return
      if (!target.matches("[data-sortable-handle]")) return
      if (target.closest("li[data-sortable-id]") !== e.currentTarget) return
      e.preventDefault()
      e.stopPropagation()
      setDrag({ id, from: index, gap: index, mode: "keyboard", lineTop: null })
      setAnnouncement(
        `Picked up ${label(id)}, position ${index + 1} of ${n}. ` +
        `Use the up and down arrow keys to move, Space or Enter to drop, Escape to cancel.`,
      )
      return
    }
    if (current.mode !== "keyboard" || current.id !== id) return

    const finish = (gap: number | null) => {
      setDrag(null)
      if (gap !== null && !isNoopGap(current.from, gap)) pendingFocusRef.current = target
      commit(id, current.from, gap)
    }

    const to = gapToIndex(current.from, current.gap ?? current.from)
    let nextTo: number | null = null
    switch (e.key) {
      case "ArrowUp": nextTo = Math.max(0, to - 1); break
      case "ArrowDown": nextTo = Math.min(n - 1, to + 1); break
      case "Home": nextTo = 0; break
      case "End": nextTo = n - 1; break
      case " ":
      case "Enter":
        e.preventDefault()
        e.stopPropagation()
        finish(current.gap)
        return
      case "Escape":
        e.preventDefault()
        e.stopPropagation()
        finish(null)
        return
      case "Tab":
        finish(null) // let focus move on
        return
      default:
        return
    }
    e.preventDefault()
    e.stopPropagation()
    if (nextTo === to) return
    const gap = indexToGap(current.from, nextTo)
    const m = measure()
    setDrag({
      ...current, gap,
      lineTop: m && !isNoopGap(current.from, gap) ? lineTopFor(m.spans, gap) : null,
    })
    m?.rows[nextTo]?.scrollIntoView({ block: "nearest" })
    setAnnouncement(`${label(id)} will move to position ${nextTo + 1} of ${n}.`)
  }

  const onBlur = (e: React.FocusEvent<HTMLLIElement>, id: string) => {
    const current = dragRef.current
    if (!current || current.mode !== "keyboard" || current.id !== id) return
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setDrag(null)
    commit(id, current.from, null)
  }

  const handleProps: SortableHandleProps = {
    "data-sortable-handle": "",
    "aria-roledescription": "sortable",
    "aria-describedby": instructionsId,
  }

  return (
    <>
      <ul
        ref={listRef}
        role="list"
        aria-label={ariaLabel}
        data-sortable-list=""
        data-dragging={drag ? "" : undefined}
        className={cn("relative", className)}
        onDragStart={disabled ? undefined : (e) => e.preventDefault()}
      >
        {items.map((item, index) => {
          const id = getId(item)
          const isDragging = drag?.id === id
          return (
            <li
              key={id}
              data-sortable-id={id}
              data-dragging={isDragging ? "" : undefined}
              className={cn(
                "transition-opacity duration-150 motion-reduce:transition-none",
                isDragging && "opacity-45",
                // Rows under the pointer shouldn't hover-wash or show a link cursor mid-drag.
                drag?.mode === "pointer" && "pointer-events-none",
                itemClassName,
              )}
              onPointerDown={(e) => onPointerDown(e, id, index)}
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
        {drag && drag.lineTop !== null && (
          <li
            aria-hidden
            role="presentation"
            data-sortable-indicator=""
            className="pointer-events-none absolute inset-x-0 h-0.5 -translate-y-1/2 rounded-full bg-brand transition-[top] duration-100 ease-out motion-reduce:transition-none"
            style={{ top: drag.lineTop }}
          />
        )}
      </ul>
      <span id={instructionsId} className="sr-only">
        To reorder, press Space to pick up, use the up and down arrow keys to move, then Space
        or Enter to drop, or Escape to cancel.
      </span>
      <span aria-live="assertive" aria-atomic className="sr-only">
        {announcement}
      </span>
    </>
  )
}
