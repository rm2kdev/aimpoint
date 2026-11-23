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

/** An existing task whose parent is being set, changed or cleared (VEC-426). */
export interface ParentChild {
  id: string;
  key: string;
  /** Its current parent, null = top-level. */
  parentId: string | null;
  /** Whether any task (archived ones too) names it as parent. */
  hasChildren: boolean;
}

export type ParentChange =
  | { ok: true; change: null }
  /** `to` null = make it top-level. `flattenedFrom`: the key asked for, a sub-task, whose own parent `to` is. */
  | { ok: true; change: { from: string | null; to: string | null; flattenedFrom?: string } }
  | { ok: false; error: string };

/**
 * VEC-426: set or change an existing task's parent. `requested` null clears it. A requested parent that is itself a
 * sub-task is flattened to its own parent (`requestedRoot`, the task it belongs to), so asking for VEC-12 (under
 * VEC-10) files it under VEC-10, unless that would be the task itself (VEC-12 is the child's own sub-task: a cycle).
 * Then the same rules as on create (checkParentLink): not itself, no cycle, no archived parent, and a task that has
 * sub-tasks of its own can't become one. Asking for the parent it already has is no change.
 */
export function planParentChange(child: ParentChild, requested: ParentCandidate | null, requestedRoot?: ParentCandidate | null): ParentChange {
  if (!requested) return { ok: true, change: child.parentId ? { from: child.parentId, to: null } : null };
  let target = requested;
  let flattenedFrom: string | undefined;
  if (requested.parentId && requested.parentId !== child.id && requestedRoot && requestedRoot.id === requested.parentId) {
    target = requestedRoot;
    flattenedFrom = requested.key;
  }
  const check = checkParentLink({ id: child.id, key: child.key, hasChildren: child.hasChildren }, target);
  if (!check.ok) return check;
  if (target.id === child.parentId) return { ok: true, change: null };
  return { ok: true, change: { from: child.parentId, to: target.id, ...(flattenedFrom ? { flattenedFrom } : {}) } };
}

/**
 * The activity line for a parent change (`parent` entry, `from`/`to` = the parents' keys at the time), as read in the
 * task's history: "made it a sub-task of VEC-10", "removed it from VEC-10", or "made it a sub-task of VEC-11 (was
 * under VEC-10)". `it` is the pronoun for the task ("it" for agents, "this" in the pane).
 */
export function parentChangeText(from: string | null | undefined, to: string | null | undefined, it = "it"): string {
  if (to) return `made ${it} a sub-task of ${to}${from ? ` (was under ${from})` : ""}`;
  return `removed ${it} from ${from ?? "its parent task"}`;
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

/** The dragged task, for canNestOnto. */
export interface NestDragged {
  id: string;
  key: string;
  parentId: string | null;
  parentKey?: string | null;
  /** Whether it has sub-tasks (the client's `children.total > 0`). */
  hasChildren: boolean;
  archived: boolean;
  createdBy: string;
}

/** The row it's held over. `parentKey` names the parent a sub-task target flattens to. */
export interface NestTarget {
  id: string;
  key: string;
  parentId: string | null;
  parentKey?: string | null;
  archived: boolean;
}

export type NestRefusal = "no-access" | "archived" | "self" | "cycle" | "current-parent" | "has-children" | "target-archived";

export type NestCheck =
  /** `parentId`/`parentKey`: where it would go. `flattenedFrom`: the target's key when that was a sub-task and it goes under the target's parent. */
  | { ok: true; parentId: string; parentKey: string; flattenedFrom?: string }
  | { ok: false; reason: NestRefusal; error: string };

/**
 * VEC-447/448: may the person drop `dragged` onto `target` to make it a sub-task? The client-side mirror of what the
 * server does for a parent change (planParentChange / checkParentLink behind updateTaskAs), so a list can refuse the
 * nest zone up front instead of arming a drop the server refuses:
 * - only the dragged task's creator or an admin may set its parent (taskAccess "full", same as Make sub-task of);
 * - not an archived task, not onto itself, not onto its own sub-task (a cycle);
 * - a target that is itself a sub-task flattens to that sub-task's parent (one level only), returned as `parentId`
 *   with `flattenedFrom` so the UI can say where it goes; `root` is that parent when the caller has it (for its
 *   archived flag), otherwise it's taken from the target's `parentId`/`parentKey` and the server re-checks;
 * - onto its current parent (or a sibling, which flattens there) is a no-op and refused as such;
 * - a task with sub-tasks of its own can't become one; an archived (resolved) parent is refused.
 */
export function canNestOnto(
  dragged: NestDragged,
  target: NestTarget,
  actor: { id: string; isAdmin: boolean },
  root?: NestTarget | null,
): NestCheck {
  const no = (reason: NestRefusal, error: string): NestCheck => ({ ok: false, reason, error });
  if (!actor.isAdmin && dragged.createdBy !== actor.id) return no("no-access", `Only ${dragged.key}'s creator or an admin can make it a sub-task.`);
  if (dragged.archived) return no("archived", `${dragged.key} is archived.`);
  if (target.id === dragged.id) return no("self", "A task can't be its own parent.");
  if (target.parentId === dragged.id) return no("cycle", `${target.key} is a sub-task of ${dragged.key}, so it can't be its parent.`);
  let parent: ParentCandidate = { id: target.id, key: target.key, parentId: target.parentId, parentKey: target.parentKey ?? null, archived: target.archived };
  let flattenedFrom: string | undefined;
  if (target.parentId) {
    const r = root && root.id === target.parentId ? root : null;
    parent = { id: target.parentId, key: r?.key ?? target.parentKey ?? "its parent", parentId: null, archived: r?.archived ?? false };
    flattenedFrom = target.key;
  }
  if (parent.id === dragged.parentId) return no("current-parent", `${dragged.key} is already a sub-task of ${dragged.parentKey ?? parent.key}.`);
  // The server's rules decide the rest, with its wording.
  const check = checkParentLink({ id: dragged.id, key: dragged.key, hasChildren: dragged.hasChildren }, parent);
  if (!check.ok) return no(dragged.hasChildren ? "has-children" : parent.archived ? "target-archived" : "cycle", check.error);
  return { ok: true, parentId: parent.id, parentKey: parent.key, ...(flattenedFrom ? { flattenedFrom } : {}) };
}
