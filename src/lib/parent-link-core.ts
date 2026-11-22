// VEC-407: sub-task parent links. Pure rules (no "server-only", no path aliases), so node tests import this file
// directly and the backfill migration can run from a one-off node script. Ids are compared as hex strings.
//
// A task's parent (`TaskDoc.parentId`) is the task it was spawned from: one level only, same organisation, so a parent
// never has a parent itself and a task with children never becomes a child. Bots get it set automatically from the
// one task they're working on (their in-progress claim) when they call create_task; an explicit `parent` wins.

/** What the rules need to know about a would-be parent task. */
export interface ParentCandidate {
  id: string;
  key: string;
  /** Its own parent, if it has one. A sub-task can't be a parent (one level). */
  parentId: string | null;
  parentKey?: string | null;
  archived: boolean;
}

export type ParentCheck = { ok: true } | { ok: false; error: string };

/**
 * May `child` be put under `parent`? Refuses itself, a parent that is a sub-task (one level only: name its own parent
 * instead), a parent that is the child's own sub-task (a cycle), an archived parent, and a child that already has
 * sub-tasks of its own (it would become a middle level). `childKey`/`childHasChildren` describe the task being linked:
 * null/false for a task still being created.
 */
export function checkParentLink(child: { id: string | null; key: string | null; hasChildren: boolean }, parent: ParentCandidate): ParentCheck {
  if (child.id && child.id === parent.id) return { ok: false, error: `A task can't be its own parent.` };
  if (child.id && parent.parentId === child.id) return { ok: false, error: `${parent.key} is a sub-task of ${child.key ?? "this task"}, so it can't be its parent.` };
  if (parent.parentId) {
    const root = parent.parentKey ? ` Use ${parent.parentKey}, the task it belongs to.` : "";
    return { ok: false, error: `${parent.key} is itself a sub-task, and sub-tasks only go one level deep.${root}` };
  }
  if (child.hasChildren) return { ok: false, error: `${child.key ?? "This task"} has sub-tasks of its own, so it can't go under ${parent.key} (sub-tasks only go one level deep).` };
  if (parent.archived) return { ok: false, error: `${parent.key} is archived. Restore it before filing sub-tasks under it.` };
  return { ok: true };
}

/** An open, unarchived task a bot holds an in-progress claim on (triage or work), with its own parent. */
export interface ClaimedTask {
  id: string;
  parentId: string | null;
}

/**
 * The automatic parent for a task a bot creates while it works: the task its in-progress claim is on, or that task's own
 * parent when the claim is on a sub-task (so a bug filed while working VEC-407 groups under VEC-406, one level).
 * Several claims that lead to different tasks leave it unset (we can't tell which one the call is for); several claims
 * that lead to the same task (triaging an umbrella while working one of its sub-tasks) use it.
 */
export function autoParentId(claimed: ClaimedTask[]): string | null {
  const roots = new Set(claimed.map((t) => t.parentId ?? t.id));
  return roots.size === 1 ? [...roots][0] : null;
}

/** A sub-task count for a parent: how many sub-tasks it has (unarchived) and how many of them are closed. */
export interface ChildrenSummary {
  total: number;
  done: number;
  cancelled: number;
}

/** Folds per-status-stage counts into a ChildrenSummary. */
export function summariseChildren(rows: { category: string | null | undefined; n: number }[]): ChildrenSummary {
  const out: ChildrenSummary = { total: 0, done: 0, cancelled: 0 };
  for (const r of rows) {
    out.total += r.n;
    if (r.category === "done") out.done += r.n;
    else if (r.category === "cancelled") out.cancelled += r.n;
  }
  return out;
}

/** The fields of a task the backfill reads. */
export interface BackfillTask {
  id: string;
  orgId: string;
  createdBy: string;
  createdAt: number;
  dependsOn: string[];
  triagedBy: string | null;
  parentId: string | null;
}

/**
 * The backfill selector (migration `2026-11-task-parent`): a task gets a parent when it was created by a bot AND is
 * listed in the `dependsOn` of a task whose `triagedBy` is that same bot (the umbrella that bot split it from).
 * `triagedBy` is always a bot, so "createdBy == triagedBy" also proves the creator was a bot, deleted bots included.
 * Tasks that already have a parent keep it. A task several umbrellas claim goes to the oldest one. One level: if the
 * chosen parent is itself picked as a child, the task goes to that task's parent instead (followed to the top), and
 * nothing that has children of its own is made a child. Returns child id -> parent id.
 */
export function selectBackfill(tasks: BackfillTask[]): Map<string, string> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  // Tasks that already have sub-tasks stay top-level.
  const existingParents = new Set(tasks.filter((t) => t.parentId).map((t) => t.parentId!));
  const pick = new Map<string, BackfillTask>();
  for (const u of tasks) {
    if (!u.triagedBy) continue;
    for (const depId of u.dependsOn) {
      const d = byId.get(depId);
      if (!d || d.id === u.id || d.orgId !== u.orgId || d.parentId || existingParents.has(d.id) || d.createdBy !== u.triagedBy) continue;
      const prev = pick.get(d.id);
      if (!prev || u.createdAt < prev.createdAt || (u.createdAt === prev.createdAt && u.id < prev.id)) pick.set(d.id, u);
    }
  }
  // Existing links count as parents too, so a root is followed through them.
  const parentOf = (id: string): string | null => pick.get(id)?.id ?? byId.get(id)?.parentId ?? null;
  const out = new Map<string, string>();
  for (const childId of pick.keys()) {
    let root = pick.get(childId)!.id;
    const seen = new Set([childId]);
    let loop = false;
    for (;;) {
      if (seen.has(root)) {
        loop = true; // dependsOn refuses loops, but never write one
        break;
      }
      seen.add(root);
      const up = parentOf(root);
      if (!up) break;
      root = up;
    }
    if (!loop) out.set(childId, root);
  }
  // Every value is a root (it has no parent, picked or existing), so no parent is also a child.
  return out;
}
