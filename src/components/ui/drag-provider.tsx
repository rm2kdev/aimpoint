"use client"

import * as React from "react"
import {
  adjacentList, dropIndex, gapOffset, indexToGap, isNoopDrop, moveItem, pickBox,
  type Span,
} from "@/lib/reorder"

/**
 * The drag session behind `SortableList` and `useDropTarget`. It lives in `DragProvider`,
 * mounted once in the app shell above the page, so a drag survives a client-side route
 * change: the window listeners, the dragged item and the floating preview belong to the
 * provider, not to the list the drag started in. Lists and drop targets only register
 * themselves and render what the current snapshot says.
 *
 * Call sites import from `@/components/ui/sortable-list`, which re-exports what they need.
 */

/** What is being dragged. `listId`/`group` are the list it was lifted from. */
export type DragItem = {
  id: string
  listId: string
  group: string
  label: string
  /** Whatever the source list's `getData` returned for the row (e.g. the task). */
  data?: unknown
}

/** Where a drop would land right now. `gap` is an insertion point (see `@/lib/reorder`). */
export type DropOver =
  | { kind: "list"; listId: string; gap: number; lineTop: number | null }
  | { kind: "target"; id: string }

export type DragSnapshot = {
  item: DragItem
  mode: "pointer" | "keyboard"
  over: DropOver | null
}

export type ReorderDetail = { movedId: string; fromIndex: number; toIndex: number }

export type MoveDetail = {
  fromList: string
  toList: string
  /** Index in the source list, or -1 when that list is no longer mounted. */
  fromIndex: number
  toIndex: number
  /** The receiving list's ids with the item inserted. */
  ids: string[]
  /** The dragged item, incl. its `data` (the only copy once the source list has unmounted). */
  item: DragItem
}

/** What a `SortableList` hands the session about itself (kept current every render). */
export type ListRegistration = {
  listId: string
  group: string
  label: string
  disabled: boolean
  el: HTMLUListElement | null
  ids: () => string[]
  itemLabel: (id: string) => string | undefined
  onReorder: (ids: string[], detail: ReorderDetail) => void
  onMove?: (id: string, detail: MoveDetail) => void
  accepts?: (item: DragItem) => boolean
}

export type DropTargetOptions = {
  /** Name used in announcements ("dropped on Website"). */
  label?: string
  /** Defaults to accepting every item. */
  accepts?: (item: DragItem) => boolean
  onHoverStart?: (item: DragItem) => void
  /** `dwellMs` is how long the item hovered; `dropped` is true when it ended in a drop. */
  onHoverEnd?: (item: DragItem, info: { dropped: boolean; dwellMs: number }) => void
  onDrop?: (item: DragItem) => void
  /** Spring-loading: `onDwell` fires once after the item has hovered this long (ms). */
  dwellMs?: number
  onDwell?: (item: DragItem) => void
  disabled?: boolean
  /**
   * The target sits over lists (a sticky status heading over its group): an item it refuses drops nothing
   * while over its box, instead of falling through to the list underneath, and the floating preview stays
   * up as over any other target (VEC-78).
   */
  opaque?: boolean
}

type TargetRegistration = { el: HTMLElement | null; opts: DropTargetOptions }
type Ref<T> = { readonly current: T }

const MOUSE_THRESHOLD = 4
const TOUCH_DELAY_MS = 250
const TOUCH_SLOP = 8
/** A pointer within this distance of a list still counts as over it; further out drops nothing. */
const OUTSIDE_MARGIN = 24
/** Distance from a scroll container's top/bottom edge where a pointer drag starts auto-scrolling. */
const AUTOSCROLL_EDGE = 36
/** Max auto-scroll speed in px per frame (reached right at the edge). */
const AUTOSCROLL_MAX = 14
/** The floating preview's left edge sits at most this far left of the pointer. */
const GHOST_POINTER_X = 12
/** The floating preview is never wider than this. */
const GHOST_MAX_WIDTH = 420

/** Nearest ancestor that scrolls vertically (the element itself counts), or null. */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let node = el; node && node !== document.body; node = node.parentElement) {
    const oy = getComputedStyle(node).overflowY
    if ((oy === "auto" || oy === "scroll") && node.scrollHeight > node.clientHeight) return node
  }
  return null
}

/**
 * A transparent layer over the whole window for the length of a pointer drag (VEC-80). It takes the
 * pointer, so rows and links under it get no hover wash or link cursor, and the cursor reads "grabbing"
 * everywhere; text selection is refused while it's up. It replaces styling the body (cursor, user-select)
 * and each list (pointer-events on its rows): those are inherited by, or re-matched against, every row
 * underneath, so each drag start and drop restyled the whole page, a 50 ms long task with a few hundred
 * rows. Inserting and removing one fixed element restyles only that element. Hit testing is geometric
 * (cached rects), so it doesn't see the layer; wheel scrolling goes to the scroller under the pointer.
 */
function createDragShield(): () => void {
  const el = document.createElement("div")
  el.setAttribute("aria-hidden", "true")
  el.setAttribute("data-drag-shield", "")
  el.style.cssText =
    "position:fixed;inset:0;z-index:2147483646;cursor:grabbing;user-select:none;-webkit-user-select:none;touch-action:none"
  const onWheel = (ev: WheelEvent) => {
    const under = document.elementsFromPoint(ev.clientX, ev.clientY).find((n) => n !== el)
    const box = under instanceof HTMLElement ? scrollParent(under) : null
    if (!box) return
    ev.preventDefault()
    const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? box.clientHeight : 1
    box.scrollBy({ left: ev.deltaX * unit, top: ev.deltaY * unit })
  }
  const onSelectStart = (ev: Event) => ev.preventDefault()
  el.addEventListener("wheel", onWheel, { passive: false })
  document.addEventListener("selectstart", onSelectStart, { capture: true })
  document.body.appendChild(el)
  return () => {
    document.removeEventListener("selectstart", onSelectStart, { capture: true })
    el.remove()
  }
}

/**
 * Row extents in the list's own (scrolling) coordinates. Layout positions (`offsetTop`, relative to the
 * list, which is `position: relative`), not screen rects: rows shifted with a transform to open a gap
 * keep their hit areas, so the gap under the pointer never moves the targets it is measured against.
 */
function measure(list: HTMLUListElement) {
  const box = list.getBoundingClientRect()
  const originY = box.top + list.clientTop - list.scrollTop
  const rows = Array.from(list.querySelectorAll<HTMLElement>(":scope > li[data-sortable-id]"))
  const spans: Span[] = rows.map((row) => ({ start: row.offsetTop, end: row.offsetTop + row.offsetHeight }))
  return { box, originY, rows, spans }
}

/** How long rows take to slide aside and a list's extra room to open (VEC-96); sortable-list.tsx matches it. */
const GAP_MS = 150
const GAP_EASE = "cubic-bezier(.2,.8,.2,1)"

/**
 * What a pointer drag has done to one list's DOM to open the landing gap: rows shifted with a transform,
 * extra bottom padding (a list the item isn't from, so the rows pushed down have room) or a taller empty
 * drop zone. Everything here is undone when the drag ends.
 */
type ListGap = {
  el: HTMLUListElement
  /** Distance between one row's bottom and the next row's top, measured before anything moved. */
  spacing: number
  offsets: Map<HTMLElement, number>
  pad: number
  zone: HTMLElement | null
}

function lineTopFor(list: HTMLUListElement, spans: Span[], gap: number): number | null {
  if (!spans.length) return null // empty list: its drop zone lights up instead
  return Math.min(Math.max(gapOffset(spans, gap), 1), list.scrollHeight - 1)
}

function sameOver(a: DropOver | null, b: DropOver | null) {
  if (a === b) return true
  if (!a || !b || a.kind !== b.kind) return false
  if (a.kind === "target") return a.id === (b as typeof a).id
  const c = b as typeof a
  return a.listId === c.listId && a.gap === c.gap && a.lineTop === c.lineTop
}

/** Drags in progress across every store on the page (normally 0 or 1). */
let activeDrags = 0

/**
 * True while any drag is in progress. Work that would re-render large parts of the page mid-drag (count
 * refreshes, background fetches) can wait for it to finish instead (VEC-73).
 */
export function isDragActive() {
  return activeDrags > 0
}

export type DragStore = ReturnType<typeof createDragStore>

export function createDragStore() {
  let snap: DragSnapshot | null = null
  let announcement = ""
  const listeners = new Set<() => void>()
  const lists = new Map<string, Ref<ListRegistration>>()
  const targets = new Map<string, Ref<TargetRegistration>>()
  let pending: { cleanup: () => void; rehit: () => void } | null = null
  let pendingFocus: { listId: string; id: string } | null = null
  let hover: { id: string; at: number; timer?: ReturnType<typeof setTimeout> } | null = null
  const endListeners = new Set<(item: DragItem, dropped: boolean) => void>()

  // Layout reads during a pointer drag are cached until something can have moved: a scroll, a resize, a
  // list re-rendering (new rows, a drop zone appearing) or a list/target (un)registering. Rows shifted to open
  // the landing gap move by transform only (measure() reads layout positions), so most pointermoves read no
  // layout at all (VEC-73); the slot and padding changes re-measure once they've settled (VEC-96).
  const rects = new Map<Element, DOMRect>()
  const measured = new Map<HTMLUListElement, ReturnType<typeof measure>>()
  const scrollers = new Map<HTMLElement, HTMLElement | null>()
  const invalidate = () => {
    rects.clear()
    measured.clear()
  }
  const rectOf = (el: Element) => {
    let r = rects.get(el)
    if (!r) rects.set(el, (r = el.getBoundingClientRect()))
    return r
  }
  const measureCached = (el: HTMLUListElement) => {
    let m = measured.get(el)
    if (!m) measured.set(el, (m = measure(el)))
    return m
  }
  const scrollerOf = (el: HTMLElement) => {
    if (!scrollers.has(el)) scrollers.set(el, scrollParent(el))
    return scrollers.get(el) ?? null
  }

  // ---- The landing gap (VEC-96) ------------------------------------------------------------
  // A pointer drag opens a gap the height of the dragged row where it would land, in whichever list is
  // under the pointer: rows slide aside with a CSS transform transition (sortable-list.tsx gives every row
  // a static `transition-transform`), so a gap change writes a transform on the few rows that change side
  // and re-renders nothing. In the source list the rows between the lifted row's empty slot and the gap
  // shift by one row, and once the card leaves the list the rows below the slot slide up over it. The slot
  // keeps its layout height meanwhile (the list's end keeps the room): collapsing it would pull everything
  // below up under a pointer that's on its way there, so a drag out of a list downwards would land a row
  // too far. Another list grows by one row of bottom padding, animated with the same timing, for the rows
  // it pushes down. Keyboard drags keep the insertion line.
  const gapped = new Map<string, ListGap>()
  let gapItem: { height: number } | null = null
  let gapTimer: ReturnType<typeof setTimeout> | undefined
  let gapUndo: (() => void) | null = null
  /** After a drop: the card glides into the row once a list renders it (`claimSettle`), else fades. */
  let settling: { id: string; ghost: HTMLElement; timer: number } | null = null

  const translate = (row: HTMLElement, dy: number) => {
    row.style.transform = dy ? `translate3d(0,${dy}px,0)` : ""
  }

  /** Bring every list's gap in line with the current snapshot. Touches only what changed. */
  const applyGaps = () => {
    if (!snap || snap.mode !== "pointer" || !gapItem) return
    const { item, over } = snap
    const overId = over?.kind === "list" ? over.listId : null
    let structural = false
    const ids = new Set([...gapped.keys(), item.listId])
    if (overId) ids.add(overId)
    for (const id of ids) {
      const el = list(id)?.el
      if (!el?.isConnected) {
        gapped.delete(id)
        continue
      }
      const m = measureCached(el)
      let st = gapped.get(id)
      if (!st || st.el !== el) {
        const spacing =
          m.spans.length > 1 ? Math.max(0, m.spans[1].start - m.spans[0].end) : parseFloat(getComputedStyle(el).rowGap) || 0
        st = { el, spacing, offsets: new Map(), pad: 0, zone: null }
        gapped.set(id, st)
      }
      const H = gapItem.height + st.spacing
      const from = id === item.listId ? m.rows.findIndex((r) => r.dataset.sortableId === item.id) : -1
      const gap = overId === id && over?.kind === "list" ? over.gap : null
      const want = (i: number) => {
        if (from < 0) return gap !== null && i >= gap ? H : 0
        if (gap === null) return i > from ? -H : 0 // the card is elsewhere: close the slot up
        if (isNoopDrop(true, from, gap)) return 0 // the slot itself is the gap
        if (i >= gap && i < from) return H
        if (i > from && i < gap) return -H
        return 0
      }
      const live = new Set<HTMLElement>()
      m.rows.forEach((row, i) => {
        live.add(row)
        const dy = want(i)
        if ((st.offsets.get(row) ?? 0) === dy) return
        translate(row, dy)
        if (dy) st.offsets.set(row, dy)
        else st.offsets.delete(row)
      })
      for (const row of st.offsets.keys()) {
        if (live.has(row)) continue
        translate(row, 0)
        st.offsets.delete(row)
      }
      if (from < 0) {
        const pad = gap !== null && m.rows.length ? H : 0
        if (pad !== st.pad) {
          st.pad = pad
          el.style.paddingBottom = pad ? `${pad}px` : ""
          structural = true
        }
        const zone = m.rows.length ? null : el.querySelector<HTMLElement>(":scope > [data-sortable-empty]")
        if (zone) {
          st.zone = zone
          const h = gap !== null ? `${Math.max(gapItem.height, zone.offsetHeight)}px` : ""
          if (zone.style.height !== h) {
            zone.style.height = h
            structural = true
          }
        }
      }
    }
    // The padding and drop zone change layout as they animate: measure again once they've settled.
    if (structural) {
      clearTimeout(gapTimer)
      gapTimer = setTimeout(() => pending?.rehit(), GAP_MS + 30)
    }
  }

  /** The source row is lifted: the gap it opens elsewhere is its height. */
  const beginGaps = (row: HTMLElement) => {
    gapUndo?.()
    gapItem = { height: row.offsetHeight }
  }

  /**
   * Undo every gap. `instant` after a drop that moves the item: the re-render puts the rows around the gap
   * where their shift already shows them, so the shifts go in the same frame with no transition, and the
   * list's FLIP glide (task-workspace.tsx) moves anything else, such as the rows that closed up a slot the
   * item didn't leave, from where it showed at the drop. Otherwise (cancel, no-op drop) the rows slide back
   * and the slot reopens.
   */
  const endGaps = (instant: boolean) => {
    clearTimeout(gapTimer)
    const touched: HTMLElement[] = []
    for (const st of gapped.values()) {
      touched.push(st.el, ...st.offsets.keys())
      if (st.zone) touched.push(st.zone)
    }
    if (instant) touched.forEach((n) => (n.style.transition = "none"))
    for (const st of gapped.values()) {
      st.offsets.forEach((_, row) => translate(row, 0))
      st.el.style.paddingBottom = ""
      if (st.zone) st.zone.style.height = ""
    }
    gapped.clear()
    gapItem = null
    const finish = () => {
      gapUndo = null
      for (const n of touched) n.style.transition = ""
    }
    // Instant: drop the `transition: none` after this frame's style is computed. Animated: after the slide.
    const timer = instant ? 0 : setTimeout(finish, GAP_MS + 30)
    const raf = instant ? requestAnimationFrame(() => requestAnimationFrame(finish)) : 0
    gapUndo = () => {
      clearTimeout(timer)
      cancelAnimationFrame(raf)
      finish()
    }
  }

  /** Called by each list after it renders: the dropped (or returning) row is here, glide the card onto it. */
  const claimSettle = (root: HTMLElement | null) => {
    if (!settling || !root) return
    const row = Array.from(root.querySelectorAll<HTMLElement>(":scope > li[data-sortable-id]")).find(
      (li) => li.dataset.sortableId === settling!.id,
    )
    if (!row) return
    const { ghost, timer } = settling
    settling = null
    cancelAnimationFrame(timer)
    const r = row.getBoundingClientRect()
    if (!r.width && !r.height) return ghost.remove()
    row.style.visibility = "hidden"
    const done = () => {
      ghost.remove()
      row.style.visibility = ""
    }
    const anim = ghost.animate(
      [{ transform: ghost.style.transform }, { transform: `translate3d(${r.left}px, ${r.top}px, 0)` }],
      { duration: 160, easing: GAP_EASE, fill: "forwards" },
    )
    anim.onfinish = done
    anim.oncancel = done
  }

  /** Hand the card to whichever list renders the row next; fade it out if none does within two frames. */
  const settleGhost = (id: string, ghost: HTMLElement) => {
    if (settling) settling.ghost.remove()
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return ghost.remove()
    const fade = () => {
      if (settling?.ghost !== ghost) return
      for (const ref of lists.values()) {
        claimSettle(ref.current.el) // a list that didn't re-render may still hold the row
        if (settling?.ghost !== ghost) return
      }
      settling = null
      const anim = ghost.animate([{ opacity: 0.95 }, { opacity: 0 }], { duration: 120, fill: "forwards" })
      anim.onfinish = () => ghost.remove()
      anim.oncancel = () => ghost.remove()
    }
    settling = { id, ghost, timer: requestAnimationFrame(() => (settling ? (settling.timer = requestAnimationFrame(fade)) : 0)) }
  }

  const emit = () => listeners.forEach((l) => l())
  /** Every drag ends here once: `dropped` is false for a cancel (Escape, release away from targets). */
  const ended = (item: DragItem, dropped: boolean) => endListeners.forEach((l) => l(item, dropped))

  const announce = (text: string) => {
    // Repeating the same sentence must still be read out, so nudge it.
    announcement = text === announcement ? `${text}\u00a0` : text
    emit()
  }

  const list = (id: string) => lists.get(id)?.current
  const target = (id: string) => targets.get(id)?.current

  const itemLabel = (item: DragItem) => list(item.listId)?.itemLabel(item.id) ?? item.label

  const accepts = (reg: ListRegistration, item: DragItem) => {
    if (reg.disabled || reg.group !== item.group || !reg.el?.isConnected) return false
    const own = reg.listId === item.listId
    if (!own && !reg.onMove) return false // can't receive items it has no handler for
    return reg.accepts ? reg.accepts(item) : true
  }

  /** Lists an item can drop into, in document order (for keyboard Left/Right). */
  const groupOrder = (item: DragItem) =>
    [...lists.values()]
      .map((r) => r.current)
      .filter((r) => accepts(r, item))
      .sort((a, b) => (a.el!.compareDocumentPosition(b.el!) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
      .map((r) => r.listId)

  /** Index of the item in a list, or -1 when that list isn't the one it came from. */
  const fromIndexIn = (reg: ListRegistration, item: DragItem) =>
    reg.listId === item.listId ? reg.ids().indexOf(item.id) : -1

  // ---- Hover on external targets ---------------------------------------------------------

  const endHover = (item: DragItem, dropped: boolean) => {
    if (!hover) return
    const h = hover
    hover = null
    if (h.timer) clearTimeout(h.timer)
    target(h.id)?.opts.onHoverEnd?.(item, { dropped, dwellMs: performance.now() - h.at })
  }

  const startHover = (item: DragItem, id: string) => {
    const opts = target(id)?.opts
    hover = { id, at: performance.now() }
    opts?.onHoverStart?.(item)
    if (opts?.dwellMs !== undefined && opts.onDwell) {
      const h = hover
      h.timer = setTimeout(() => {
        if (hover === h && snap) target(id)?.opts.onDwell?.(snap.item)
      }, opts.dwellMs)
    }
  }

  const set = (next: DragSnapshot | null) => {
    const prev = snap
    if (prev && next && prev.item === next.item && prev.mode === next.mode && sameOver(prev.over, next.over)) return
    const prevTarget = prev?.over?.kind === "target" ? prev.over.id : null
    const nextTarget = next?.over?.kind === "target" ? next.over.id : null
    if (!prev && next) activeDrags++
    else if (prev && !next) {
      activeDrags--
      if (gapItem || gapped.size) endGaps(false)
      invalidate()
      scrollers.clear()
    }
    snap = next
    if (next?.mode === "pointer") applyGaps()
    if (prevTarget !== nextTarget && prev) {
      endHover(prev.item, false)
      if (next && nextTarget) startHover(next.item, nextTarget)
    }
    emit()
  }

  // ---- Hit testing -----------------------------------------------------------------------

  const overList = (reg: ListRegistration, item: DragItem, y: number): DropOver => {
    const el = reg.el!
    const m = measureCached(el)
    const pos = y - m.originY
    // Where the rows show now, gap shifts included: the item lands after every other row whose middle is
    // above the pointer. Measuring against the shifted rows keeps the gap under the pointer (against the
    // unshifted layout, rows pushed down would keep the gap a row ahead of a pointer moving down), and it's
    // stable: a row that slides past the pointer leaves its middle on the far side.
    const shift = gapped.get(reg.listId)?.offsets
    const from = reg.listId === item.listId ? m.rows.findIndex((r) => r.dataset.sortableId === item.id) : -1
    let to = 0
    m.rows.forEach((row, i) => {
      if (i !== from && pos > (m.spans[i].start + m.spans[i].end) / 2 + (shift?.get(row) ?? 0)) to++
    })
    const gap = from >= 0 ? indexToGap(from, to) : to
    // A pointer drag shows where it lands by opening a gap there (applyGaps), not with the line.
    return { kind: "list", listId: reg.listId, gap, lineTop: null }
  }

  /** Set by the last hit test: the pointer is over an opaque target that refuses the item (VEC-78). */
  let blocked = false

  const hitTest = (item: DragItem, x: number, y: number): DropOver | null => {
    blocked = false
    for (const [id, ref] of targets) {
      const { el, opts } = ref.current
      if (!el?.isConnected || opts.disabled) continue
      const refused = !!opts.accepts && !opts.accepts(item)
      if (refused && !opts.opaque) continue
      const r = rectOf(el)
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue
      if (!refused) return { kind: "target", id }
      blocked = true // keep looking: an accepting target on top of it still wins
    }
    if (blocked) return null
    const candidates = [...lists.values()].map((r) => r.current).filter((r) => accepts(r, item))
    const i = pickBox(candidates.map((r) => rectOf(r.el!)), x, y, OUTSIDE_MARGIN)
    return i < 0 ? null : overList(candidates[i], item, y)
  }

  // ---- Committing a drop -----------------------------------------------------------------

  const drop = (item: DragItem, over: DropOver | null): string | null => {
    const name = itemLabel(item)
    const source = list(item.listId)
    const sourceFrom = source ? source.ids().indexOf(item.id) : -1
    // A list that isn't linked to others only ever reorders, so keep its wording.
    const verb = item.group.startsWith("list:") ? "Reorder" : "Move"
    const cancelled = () =>
      source && sourceFrom >= 0
        ? `${verb} cancelled. ${name} stays at position ${sourceFrom + 1} of ${source.ids().length}.`
        : `${verb} cancelled. ${name} stays where it was.`

    if (!over) {
      endHover(item, false)
      announce(cancelled())
      ended(item, false)
      return null
    }
    if (over.kind === "target") {
      const t = target(over.id)
      t?.opts.onDrop?.(item)
      endHover(item, true)
      announce(t ? `${name} dropped on ${t.opts.label ?? over.id}.` : cancelled())
      ended(item, !!t)
      return null
    }
    const reg = list(over.listId)
    if (!reg) {
      announce(cancelled())
      ended(item, false)
      return null
    }
    const ids = reg.ids()
    const from = fromIndexIn(reg, item)
    const same = from >= 0
    if (isNoopDrop(same, from, over.gap)) {
      announce(`${name} dropped in its original position, ${from + 1} of ${ids.length}.`)
      ended(item, true)
      return null
    }
    const toIndex = dropIndex(same, from, over.gap)
    if (same) {
      announce(`${name} moved to position ${toIndex + 1} of ${ids.length}.`)
      reg.onReorder(moveItem(ids, from, toIndex), { movedId: item.id, fromIndex: from, toIndex })
    } else {
      const at = Math.max(0, Math.min(ids.length, toIndex))
      const next = ids.filter((id) => id !== item.id)
      next.splice(at, 0, item.id)
      announce(`${name} moved to ${reg.label}, position ${at + 1} of ${next.length}.`)
      reg.onMove?.(item.id, { fromList: item.listId, toList: reg.listId, fromIndex: sourceFrom, toIndex: at, ids: next, item })
    }
    ended(item, true)
    return reg.listId
  }

  // ---- Pointer (mouse, pen, touch) -------------------------------------------------------

  const beginPointer = (
    e: { pointerId: number; pointerType: string; clientX: number; clientY: number },
    item: DragItem,
    row: HTMLElement,
  ) => {
    if (snap || pending) return
    const touch = e.pointerType === "touch"
    const pointerId = e.pointerId
    const startX = e.clientX
    const startY = e.clientY
    let active = false
    let lastX = startX
    let lastY = startY
    let timer: ReturnType<typeof setTimeout> | undefined
    let raf = 0
    let rehitRaf = 0
    let moveRaf = 0
    let ghost: HTMLElement | null = null
    let offset = { x: 0, y: 0 }
    let removeShield: (() => void) | null = null

    // A floating copy of the row that follows the pointer for the whole drag (VEC-95): in its own list,
    // over another list or a drop target, or after the source row is gone (a route change). The source row
    // is left as an empty slot meanwhile (SortableRow), so the card reads as the task in your hand.
    const makeGhost = () => {
      const r = row.getBoundingClientRect()
      // Hang the preview just right of the pointer, and cap its width, so it never covers the target
      // under the pointer (a sidebar project row has to stay visible while it blinks, VEC-61).
      offset = { x: Math.min(startX - r.left, GHOST_POINTER_X), y: startY - r.top }
      const g = row.cloneNode(true) as HTMLElement
      g.removeAttribute("data-sortable-id")
      g.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"))
      g.setAttribute("aria-hidden", "true")
      g.setAttribute("inert", "")
      g.setAttribute("data-drag-ghost", "")
      g.className =
        "pointer-events-none fixed top-0 left-0 z-[100] list-none rounded-lg bg-popover opacity-95 shadow-lg ring-1 ring-border"
      g.style.width = `${Math.min(r.width, GHOST_MAX_WIDTH)}px`
      g.style.transform = `translate3d(${lastX - offset.x}px, ${lastY - offset.y}px, 0)`
      document.body.appendChild(g)
      // Promote it to the top layer where supported, so nothing on the page can paint over it (VEC-76):
      // a z-index alone loses to the sticky status headings where the engine composites them separately
      // from the list scroller (seen in Safari). Undo the UA popover box styles so it keeps the row's look.
      if (typeof g.showPopover === "function") {
        g.popover = "manual"
        g.style.inset = "0 auto auto 0"
        g.style.margin = "0"
        g.style.padding = "0"
        g.style.border = "0"
        g.style.overflow = "visible"
        g.style.color = "inherit"
        try {
          g.showPopover()
        } catch {
          // Stays a plain fixed overlay.
        }
      }
      ghost = g
    }

    const placeGhost = () => {
      if (!ghost) return
      ghost.style.transform = `translate3d(${lastX - offset.x}px, ${lastY - offset.y}px, 0)`
    }

    const update = () => {
      if (moveRaf) {
        cancelAnimationFrame(moveRaf)
        moveRaf = 0
      }
      if (!active) return
      set({ item, mode: "pointer", over: hitTest(item, lastX, lastY) })
      placeGhost()
    }

    // Pointermoves can outpace frames (high-rate mice, coalesced events): hit-test once per frame, with
    // the latest position, instead of once per event.
    const scheduleUpdate = () => {
      if (!moveRaf) moveRaf = requestAnimationFrame(update)
    }

    const activate = () => {
      active = true
      removeShield = createDragShield()
      window.getSelection()?.removeAllRanges()
      if (touch) navigator.vibrate?.(10)
      announce(`Picked up ${itemLabel(item)}.`)
      beginGaps(row)
      makeGhost()
      update()
      document.addEventListener("scroll", onScroll, { capture: true, passive: true })
      window.addEventListener("resize", onResize)
      raf = requestAnimationFrame(autoScroll)
    }

    const onScroll = () => {
      invalidate()
      update()
    }
    const onResize = () => {
      invalidate()
      scrollers.clear()
      scheduleUpdate()
    }

    // Hold the pointer near the top or bottom edge of the scrolling container around the list
    // under it (or the source list) to scroll; stop once that list's end is in view.
    const autoScroll = () => {
      if (!active) return
      const over = snap?.over
      const reg = (over?.kind === "list" ? list(over.listId) : undefined) ?? list(item.listId)
      const listEl = reg?.el?.isConnected ? reg.el : null
      const scroller = listEl ? scrollerOf(listEl) : null
      if (listEl && scroller) {
        const r = rectOf(scroller)
        const top = lastY - r.top
        const bottom = r.bottom - lastY
        const inX = lastX > r.left - OUTSIDE_MARGIN && lastX < r.right + OUTSIDE_MARGIN
        let dy = 0
        if (inX && top < AUTOSCROLL_EDGE && lastY > r.top - OUTSIDE_MARGIN) dy = -Math.ceil(AUTOSCROLL_MAX * (1 - Math.max(top, 0) / AUTOSCROLL_EDGE))
        else if (inX && bottom < AUTOSCROLL_EDGE && lastY < r.bottom + OUTSIDE_MARGIN) dy = Math.ceil(AUTOSCROLL_MAX * (1 - Math.max(bottom, 0) / AUTOSCROLL_EDGE))
        const lb = rectOf(listEl)
        if (dy > 0) dy = Math.min(dy, Math.max(0, Math.ceil(lb.bottom - r.bottom)))
        if (dy < 0) dy = Math.max(dy, Math.min(0, Math.floor(lb.top - r.top)))
        if (dy) scroller.scrollTop += dy // fires onScroll, which moves the line
      }
      raf = requestAnimationFrame(autoScroll)
    }

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      lastX = ev.clientX
      lastY = ev.clientY
      if (active) return scheduleUpdate()
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
      update()
      const over = snap?.over ?? null
      const reg = over?.kind === "list" ? list(over.listId) : undefined
      const stays = !over || (over.kind === "list" && !!reg && isNoopDrop(true, fromIndexIn(reg, item), over.gap))
      // The card glides into the row wherever it renders next: the open gap, or its own slot after a cancel.
      if (ghost) settleGhost(item.id, ghost)
      ghost = null
      cleanup(false)
      drop(item, over)
      // A drop that moves it: the re-render takes over from the shifts at once. A cancel or no-op slides back.
      endGaps(!stays)
      set(null)
    }

    const cancel = () => {
      const wasActive = active
      if (wasActive && ghost) settleGhost(item.id, ghost)
      ghost = null
      cleanup(false)
      if (wasActive) {
        drop(item, null)
        endGaps(false)
        set(null)
      }
    }

    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) cancel()
    }

    // Escape cancels while the button is still down: the release that follows would click the row
    // (or link) under the pointer, so eat that one click too, as onUp does after a drop (VEC-82).
    const swallowNextRelease = () => {
      const done = () => {
        window.removeEventListener("pointerup", onLateUp, { capture: true })
        window.removeEventListener("pointercancel", onLateEnd, { capture: true })
        window.removeEventListener("pointerdown", onLateEnd, { capture: true })
      }
      const onLateUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return
        done()
        window.addEventListener("click", swallowClick, { capture: true, once: true })
        setTimeout(() => window.removeEventListener("click", swallowClick, { capture: true }), 0)
      }
      // The release never came (lost outside the window, cancelled): stop waiting for it.
      const onLateEnd = (ev: PointerEvent) => {
        if (ev.pointerId === pointerId) done()
      }
      window.addEventListener("pointerup", onLateUp, { capture: true })
      window.addEventListener("pointercancel", onLateEnd, { capture: true })
      window.addEventListener("pointerdown", onLateEnd, { capture: true })
    }

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || !active) return
      ev.preventDefault()
      ev.stopPropagation()
      cancel()
      swallowNextRelease()
    }

    // Once a touch drag is live, stop the page from scrolling under the finger.
    const onTouchMove = (ev: TouchEvent) => {
      if (active && ev.cancelable) ev.preventDefault()
    }
    const onContextMenu = (ev: Event) => {
      if (active || touch) ev.preventDefault()
    }

    // Lists or targets mounted or unmounted mid-drag (a route change, spring-loading): look
    // again under the still pointer so the new page's list lights up without a move.
    const rehit = () => {
      invalidate()
      if (!active || rehitRaf) return
      rehitRaf = requestAnimationFrame(() => {
        rehitRaf = 0
        update()
      })
    }

    function cleanup(clearSnap = true) {
      if (timer) clearTimeout(timer)
      if (raf) cancelAnimationFrame(raf)
      if (rehitRaf) cancelAnimationFrame(rehitRaf)
      if (moveRaf) cancelAnimationFrame(moveRaf)
      moveRaf = 0
      document.removeEventListener("scroll", onScroll, { capture: true })
      window.removeEventListener("resize", onResize)
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onCancel)
      window.removeEventListener("keydown", onKey, { capture: true })
      window.removeEventListener("touchmove", onTouchMove)
      window.removeEventListener("contextmenu", onContextMenu)
      ghost?.remove()
      ghost = null
      removeShield?.()
      removeShield = null
      if (active) {
        if (clearSnap) {
          endHover(item, false)
          set(null)
        }
      }
      active = false
      pending = null
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
    pending = { cleanup: () => cancel(), rehit }
  }

  // ---- Keyboard --------------------------------------------------------------------------

  const instructions = (item: DragItem) =>
    groupOrder(item).length > 1
      ? "Use the up and down arrow keys to move, left and right to move to another list, Space or Enter to drop, Escape to cancel."
      : "Use the up and down arrow keys to move, Space or Enter to drop, Escape to cancel."

  /** Keyboard over a list: place the line at final index `to` (clamped) and announce it. */
  const keyboardPlace = (item: DragItem, reg: ListRegistration, to: number, moved: boolean) => {
    const ids = reg.ids()
    const from = fromIndexIn(reg, item)
    const same = from >= 0
    const n = same ? ids.length : ids.length + 1
    const index = Math.max(0, Math.min(n - 1, to))
    const gap = same ? indexToGap(from, index) : index
    const el = reg.el
    const m = el ? measure(el) : null
    const lineTop = !el || !m || isNoopDrop(same, from, gap) ? null : lineTopFor(el, m.spans, gap)
    set({ item, mode: "keyboard", over: { kind: "list", listId: reg.listId, gap, lineTop } })
    const near = m?.rows[Math.min(index, m.rows.length - 1)] ?? el?.querySelector<HTMLElement>("[data-sortable-empty]")
    near?.scrollIntoView({ block: "nearest" })
    const name = itemLabel(item)
    announce(
      moved || !same
        ? `${name} will move to ${reg.label}, position ${index + 1} of ${n}.`
        : `${name} will move to position ${index + 1} of ${n}.`,
    )
  }

  /** Returns true when the key was handled (the caller then prevents its default). */
  const keyDown = (
    key: string,
    repeat: boolean,
    reg: ListRegistration,
    id: string,
    index: number,
    data: unknown,
  ): boolean => {
    if (!snap) {
      if (key !== " " || repeat || reg.disabled || pending) return false
      const item: DragItem = { id, listId: reg.listId, group: reg.group, label: reg.itemLabel(id) ?? id, data }
      set({ item, mode: "keyboard", over: { kind: "list", listId: reg.listId, gap: index, lineTop: null } })
      announce(`Picked up ${item.label}, position ${index + 1} of ${reg.ids().length}. ${instructions(item)}`)
      return true
    }
    const { item, mode, over } = snap
    if (mode !== "keyboard" || item.id !== id || item.listId !== reg.listId) return false
    const cur = over?.kind === "list" ? list(over.listId) : undefined

    const finish = (target: DropOver | null) => {
      const into = drop(item, target)
      set(null)
      if (into) pendingFocus = { listId: into, id }
    }

    switch (key) {
      case " ":
      case "Enter":
        finish(over)
        return true
      case "Escape":
        finish(null)
        return true
      case "Tab":
        finish(null)
        return false // let focus move on
    }
    if (!cur || over?.kind !== "list") return false
    const from = fromIndexIn(cur, item)
    const to = dropIndex(from >= 0, from, over.gap)
    const n = from >= 0 ? cur.ids().length : cur.ids().length + 1
    switch (key) {
      case "ArrowUp":
        if (to > 0) keyboardPlace(item, cur, to - 1, cur.listId !== item.listId)
        return true
      case "ArrowDown":
        if (to < n - 1) keyboardPlace(item, cur, to + 1, cur.listId !== item.listId)
        return true
      case "Home":
        keyboardPlace(item, cur, 0, cur.listId !== item.listId)
        return true
      case "End":
        keyboardPlace(item, cur, n - 1, cur.listId !== item.listId)
        return true
      case "ArrowLeft":
      case "ArrowRight": {
        const order = groupOrder(item)
        if (order.length < 2) return false // an unlinked list ignores Left/Right, as before
        const next = adjacentList(order, cur.listId, key === "ArrowLeft" ? -1 : 1)
        const reg2 = next ? list(next) : undefined
        if (!reg2) {
          announce(`No list to the ${key === "ArrowLeft" ? "left" : "right"}. ${itemLabel(item)} stays in ${cur.label}.`)
          return true
        }
        keyboardPlace(item, reg2, to, true)
        return true
      }
    }
    return false
  }

  /** Focus left the lifted row (keyboard): cancel, as before. */
  const blur = (listId: string, id: string) => {
    if (snap?.mode !== "keyboard" || snap.item.id !== id || snap.item.listId !== listId) return
    drop(snap.item, null)
    set(null)
  }

  return {
    subscribe(fn: () => void) {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },
    get: () => snap,
    getAnnouncement: () => announcement,
    /** Called once when a drag ends: dropped somewhere (true) or cancelled (false). Returns an unsubscribe. */
    onEnd(fn: (item: DragItem, dropped: boolean) => void) {
      endListeners.add(fn)
      return () => void endListeners.delete(fn)
    },
    announce,
    /** Layout around the lists may have changed (a list re-rendered): re-measure on the next hit test. */
    invalidate,
    registerList(listId: string, ref: Ref<ListRegistration>) {
      lists.set(listId, ref)
      invalidate()
      pending?.rehit()
      return () => {
        if (lists.get(listId) === ref) lists.delete(listId)
        invalidate()
        pending?.rehit()
      }
    },
    registerTarget(id: string, ref: Ref<TargetRegistration>) {
      targets.set(id, ref)
      invalidate()
      pending?.rehit()
      return () => {
        if (targets.get(id) !== ref) return
        if (hover?.id === id) {
          if (hover.timer) clearTimeout(hover.timer)
          hover = null
        }
        targets.delete(id)
        invalidate()
        pending?.rehit()
      }
    },
    beginPointer,
    claimSettle,
    keyDown,
    blur,
    /** How long the current drag has hovered target `id` (ms), or null when it isn't over it. */
    dwell(id: string) {
      return hover?.id === id ? performance.now() - hover.at : null
    },
    /** After a keyboard drop, the receiving list focuses the moved row's handle once it renders. */
    takeFocus(listId: string, root: HTMLElement | null) {
      if (!pendingFocus || pendingFocus.listId !== listId || !root) return
      const row = Array.from(root.querySelectorAll<HTMLElement>(":scope > li[data-sortable-id]")).find(
        (li) => li.dataset.sortableId === pendingFocus!.id,
      )
      if (!row) return
      pendingFocus = null
      const handle = row.querySelector<HTMLElement>("[data-sortable-handle]")
      if (handle && document.activeElement !== handle) handle.focus({ preventScroll: true })
    },
    destroy() {
      pending?.cleanup()
      if (snap) set(null)
    },
  }
}

const DragContext = React.createContext<DragStore | null>(null)

/**
 * Holds the drag session. Mount once above every page (the app shell) so drags survive
 * client-side navigation. A `SortableList` outside any provider makes its own.
 */
export function DragProvider({ children }: { children: React.ReactNode }) {
  const [store] = React.useState(createDragStore)
  React.useEffect(() => () => store.destroy(), [store])
  const announcement = React.useSyncExternalStore(store.subscribe, store.getAnnouncement, () => "")
  return (
    <DragContext.Provider value={store}>
      {children}
      <span aria-live="assertive" aria-atomic className="sr-only">
        {announcement}
      </span>
    </DragContext.Provider>
  )
}

export function useDragStore() {
  return React.useContext(DragContext)
}

/**
 * One value derived from the current drag. The component re-renders only when the selected value changes
 * (compared with `Object.is`), not on every pointer move, so return primitives or objects that are stable
 * for the whole drag (`snap.item`). Prefer this over `useDragState` anywhere that renders many rows: a list
 * reading the whole snapshot re-renders on every gap change (VEC-73).
 */
export function useDragSelector<T>(select: (snap: DragSnapshot | null) => T): T {
  const store = useDragStore()
  return React.useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    () => select(store ? store.get() : null),
    () => select(null),
  )
}

/**
 * The current drag (item, pointer or keyboard, where it would drop), or null. Re-renders on every change of
 * the drop position; use `useDragSelector` for anything that renders more than a few elements.
 */
export function useDragState(): DragSnapshot | null {
  const store = useDragStore()
  return React.useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.get : nullSnapshot,
    nullSnapshot,
  )
}

const noopSubscribe = () => () => {}
const nullSnapshot = () => null

/**
 * Lets any element outside a `SortableList` (a sidebar project row, a trash zone) react to
 * a dragged item. Spread `ref` on the element; it's hit-tested by its box, so it needs no
 * pointer events of its own. Hovering calls `onHoverStart`/`onHoverEnd`; releasing over it
 * calls `onDrop`. For spring-loading, pass `dwellMs` + `onDwell` (fires once per hover), or
 * read `dwell()` (ms hovered so far, null when not hovered).
 */
export function useDropTarget<E extends HTMLElement = HTMLElement>(id: string, options: DropTargetOptions = {}) {
  const store = useDragStore()
  const elRef = React.useRef<E | null>(null)
  const regRef = React.useRef<TargetRegistration>({ el: null, opts: options })
  React.useLayoutEffect(() => {
    regRef.current = { el: elRef.current, opts: options }
  })
  React.useLayoutEffect(() => store?.registerTarget(id, regRef), [store, id])
  const ref = React.useCallback((el: E | null) => {
    elRef.current = el
    regRef.current = { ...regRef.current, el }
  }, [])
  // Three narrow subscriptions: the target re-renders when a drag starts/ends or enters/leaves it, never
  // for pointer moves elsewhere.
  const item = useDragSelector((snap) => snap?.item ?? null)
  const isOver = useDragSelector((snap) => snap?.over?.kind === "target" && snap.over.id === id)
  const canDrop = !!item && !options.disabled && (options.accepts ? options.accepts(item) : true)
  const dwell = React.useCallback(() => store?.dwell(id) ?? null, [store, id])
  return { ref, isOver, canDrop, item, dwell }
}
