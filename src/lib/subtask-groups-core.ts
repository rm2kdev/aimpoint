// VEC-408: grouping sub-tasks under their parent in the app's task lists. Pure (no path aliases, no React), so node
// tests import it directly.
//
// Rules:
// - A task whose parent is shown in the list (it passed the view's filters) is not a row of its own: it sits under
//   that parent. Expanding a parent shows all its sub-tasks this view holds, filtered or not, so the expanded group
//   reads the same as the progress chip.
// - A task whose parent isn't shown (filtered out, archived, in another project, not yours in My tasks) stays a
//   normal row and gets a "Part of KEY" link, so nothing becomes unfindable.
// - Grouping off: the old flat list, untouched.

export interface GroupableTask {
  id: string;
  parentId: string | null;
}

export interface SubtaskLayout<T extends GroupableTask> {
  /** Rows that sit in the status groups: top-level tasks, and sub-tasks whose parent isn't shown. */
  rows: T[];
  /** Sub-tasks by parent id, over every task the view holds, sorted with `cmp`. */
  children: Map<string, T[]>;
  /** Ids of rows that are sub-tasks of a parent not shown here (they get the "Part of" link). */
  detached: Set<string>;
}

/**
 * `all` = every task the view holds (its scope: project / mine / unarchived), `visible` = the ones that pass its
 * filters, `grouped` = the view option. `cmp` orders the sub-tasks inside a group (the view's sort).
 */
export function layoutSubtasks<T extends GroupableTask>(
  all: Iterable<T>,
  visible: T[],
  grouped: boolean,
  cmp: (a: T, b: T) => number,
): SubtaskLayout<T> {
  const children = new Map<string, T[]>();
  const detached = new Set<string>();
  if (!grouped) return { rows: visible, children, detached };
  const shown = new Set(visible.map((t) => t.id));
  for (const t of all) {
    if (!t.parentId || t.parentId === t.id) continue;
    const list = children.get(t.parentId);
    if (list) list.push(t);
    else children.set(t.parentId, [t]);
  }
  children.forEach((list) => list.sort(cmp));
  const rows: T[] = [];
  for (const t of visible) {
    if (t.parentId && t.parentId !== t.id && shown.has(t.parentId)) continue;
    if (t.parentId) detached.add(t.id);
    rows.push(t);
  }
  return { rows, children, detached };
}

/**
 * Keeps each parent's sub-task array identical (same object) when its contents didn't change, so memoised rows
 * that receive it skip re-rendering on unrelated live edits.
 */
export function stableChildren<T>(prev: Map<string, T[]>, next: Map<string, T[]>): Map<string, T[]> {
  const out = new Map<string, T[]>();
  next.forEach((list, id) => {
    const old = prev.get(id);
    out.set(id, old && old.length === list.length && old.every((x, i) => x === list[i]) ? old : list);
  });
  return out;
}

/** "3/5 done" for a parent's chip; cancelled sub-tasks count as closed. */
export function progressLabel(c: { total: number; done: number; cancelled: number }) {
  return `${c.done + c.cancelled}/${c.total} done`;
}

/** The chip's tooltip, e.g. "3 of 5 sub-tasks closed (1 cancelled)". */
export function progressTitle(c: { total: number; done: number; cancelled: number }) {
  const closed = c.done + c.cancelled;
  const noun = c.total === 1 ? "sub-task" : "sub-tasks";
  return `${closed} of ${c.total} ${noun} closed${c.cancelled ? ` (${c.cancelled} cancelled)` : ""}`;
}
