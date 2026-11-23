/**
 * Pure helpers behind drag-to-reorder (`@/components/ui/sortable-list`). No React, no DOM,
 * so they are safe on the server, in server actions and in plain `node --test`.
 *
 * Two coordinate systems are used:
 * - an **index** is a position in the list (0..n-1), as in `moveItem(list, from, to)`;
 * - a **gap** is an insertion point between items (0..n): gap `g` means "just before item g",
 *   and gap `n` means "after the last item". The blue drop line is drawn at a gap.
 */

/**
 * Returns a new array with the item at `from` moved so it ends up at index `to`.
 * `to` is clamped to the list; an out-of-range `from` or `from === to` returns an
 * unchanged copy. The input is never mutated.
 *
 * moveItem(["a","b","c"], 0, 2) -> ["b","c","a"]
 */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = list.slice();
  const n = next.length;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= n) return next;
  const target = Math.max(0, Math.min(n - 1, to));
  if (target === from) return next;
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item);
  return next;
}

/** Final index of an item dragged from `from` and dropped at `gap`. */
export function gapToIndex(from: number, gap: number): number {
  return gap > from ? gap - 1 : gap;
}

/** The gap that drops an item from `from` onto final index `to` (inverse of gapToIndex). */
export function indexToGap(from: number, to: number): number {
  return to > from ? to + 1 : to;
}

/** Dropping at either gap touching the item's own slot leaves the order unchanged. */
export function isNoopGap(from: number, gap: number): boolean {
  return gap === from || gap === from + 1;
}

/** An item's extent along the drag axis (e.g. top/bottom), in any consistent coordinates. */
export type Span = { start: number; end: number };

/** The gap closest to a pointer position: before the first item whose midpoint is below it. */
export function gapFromPointer(spans: readonly Span[], pos: number): number {
  for (let i = 0; i < spans.length; i++) {
    if (pos < (spans[i].start + spans[i].end) / 2) return i;
  }
  return spans.length;
}

/**
 * Where to draw the drop line for `gap`: halfway between the neighbouring items, or half
 * the usual spacing outside the first/last item at the ends.
 */
export function gapOffset(spans: readonly Span[], gap: number): number {
  const n = spans.length;
  if (n === 0) return 0;
  const spacing = n > 1 ? Math.max(0, spans[1].start - spans[0].end) : 0;
  if (gap <= 0) return spans[0].start - spacing / 2;
  if (gap >= n) return spans[n - 1].end + spacing / 2;
  return (spans[gap - 1].end + spans[gap].start) / 2;
}

// ---- Linked lists (several lists sharing a drag group) --------------------------------------

/**
 * Final index for a drop at `gap`. In the item's own list the item is still counted, so gaps
 * after it shift down by one; in any other list the gap is the index.
 */
export function dropIndex(sameList: boolean, from: number, gap: number): number {
  return sameList ? gapToIndex(from, gap) : gap;
}

/** A drop that changes nothing: only possible in the item's own list, next to its own slot. */
export function isNoopDrop(sameList: boolean, from: number, gap: number): boolean {
  return sameList && from >= 0 && isNoopGap(from, gap);
}

/**
 * Moves the item at `fromIndex` of `from` into `to` at `toIndex` (clamped to 0..to.length).
 * Returns new arrays; inputs are never mutated. An out-of-range `fromIndex` returns copies.
 *
 * transferItem(["a","b"], ["x"], 0, 1) -> { from: ["b"], to: ["x","a"] }
 */
export function transferItem<T>(
  from: readonly T[],
  to: readonly T[],
  fromIndex: number,
  toIndex: number,
): { from: T[]; to: T[] } {
  const a = from.slice();
  const b = to.slice();
  if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= a.length) return { from: a, to: b };
  const [item] = a.splice(fromIndex, 1);
  const at = Number.isInteger(toIndex) ? Math.max(0, Math.min(b.length, toIndex)) : b.length;
  b.splice(at, 0, item);
  return { from: a, to: b };
}

/** A screen rectangle (e.g. from getBoundingClientRect). */
export type Box = { left: number; top: number; right: number; bottom: number };

/** Distance from a point to a box (0 inside it). */
export function distanceToBox(box: Box, x: number, y: number): number {
  const dx = Math.max(box.left - x, 0, x - box.right);
  const dy = Math.max(box.top - y, 0, y - box.bottom);
  return Math.hypot(dx, dy);
}

/**
 * Which of several boxes a pointer is over: the one containing it, else the nearest within
 * `margin` px, else -1. Ties go to the earlier box. Used to pick the list under a drag.
 */
export function pickBox(boxes: readonly (Box | null)[], x: number, y: number, margin: number): number {
  let best = -1;
  let bestDist = Infinity;
  boxes.forEach((box, i) => {
    if (!box) return;
    const d = distanceToBox(box, x, y);
    if (d <= margin && d < bestDist) {
      best = i;
      bestDist = d;
    }
  });
  return best;
}

/**
 * The neighbouring list for keyboard moves: `dir` -1 = previous, +1 = next, in `order`
 * (lists in document order). Returns null at either end or when `current` isn't listed.
 */
export function adjacentList(order: readonly string[], current: string, dir: -1 | 1): string | null {
  const i = order.indexOf(current);
  if (i < 0) return null;
  return order[i + dir] ?? null;
}

// ---- Nesting onto a row (VEC-448) ------------------------------------------------------------
// A row in a list can also be a drop target of its own: the central band of its height is "onto the row" (the
// nest zone), the edges above and below stay the insertion points between rows. Positions are in the same space
// as `Span`s, measured where the rows show now (gap shifts included).

/** Default share of a row's height, centred, that counts as onto the row. */
export const NEST_BAND = 0.5;

/**
 * Index of the row whose nest zone (its central `band` share of height, 0..1) holds `pos`, or -1 when `pos` is on
 * a row's edge band, in a gap, or off the rows. `skip` is a row to ignore (the lifted one), -1 for none.
 * `zone(i)` (VEC-449): the part of row `i` the band applies to, inside its span (a parent row whose sub-tasks
 * render under it in the same item); asked only for the row whose span holds `pos`. Default: the whole span.
 *
 * nestZoneAt([{start: 0, end: 40}], 20) -> 0;  nestZoneAt([{start: 0, end: 40}], 5) -> -1 (top edge)
 */
export function nestZoneAt(spans: readonly Span[], pos: number, band: number = NEST_BAND, skip = -1, zone?: (i: number) => Span): number {
  const b = Math.min(Math.max(band, 0), 1);
  for (let i = 0; i < spans.length; i++) {
    if (i === skip) continue;
    if (zone && (pos < spans[i].start || pos > spans[i].end)) continue;
    const { start, end } = zone ? zone(i) : spans[i];
    const h = end - start;
    if (h <= 0 || b === 0) continue;
    const inset = (h * (1 - b)) / 2;
    if (pos >= start + inset && pos <= end - inset) return i;
  }
  return -1;
}

/**
 * The gap to show while the pointer is over the nest zone of row `row` (its index). The gap must not move that row:
 * rows only slide when the gap changes, and a row sliding away from a pointer that stays still leaves it over a
 * hole while the drag still says it's on the row (no pointer move, no new hit test). So keep the gap of the last
 * hit test on this list (`prev`): it's what put the row where the pointer found it, and it also stops the midpoint
 * rule from flipping the gap as the pointer crosses the row's middle. Coming from elsewhere (`prev` null): the gap
 * right after the row, which leaves the row itself where it shows (in its own list or another). Off every zone the
 * caller uses the midpoint gap as usual.
 */
export function nestGap(prev: { gap: number } | null, row: number): number {
  return prev ? prev.gap : row + 1;
}
