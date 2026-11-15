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
