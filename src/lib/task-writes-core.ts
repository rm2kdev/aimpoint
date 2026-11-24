/**
 * Optimistic task writes (VEC-456, part of VEC-452 "make actions happen immediately"). Pure and framework-free so
 * `task-writes.test.mjs` runs it under plain `node --test`; the React side is `lib/task-writes.ts`.
 *
 * Two pieces sit on top of VEC-453's action queue:
 *
 * - **Overlay**: the fields of every task write still on its way to the server, per task id. Anything that takes a
 *   task from the server (a realtime echo, an action's answer, a list refresh) passes it through `apply(task)`, so an
 *   echo of an earlier write can't flash an older value over a later write that hasn't landed yet. A write leaves
 *   the overlay when it settles; on a refusal the caller puts back the old values with `revert(id, before)`, which
 *   keeps whatever later writes still hold.
 * - **Pending creates**: a new task shows at once as a temporary row (`tmp_` id, no number yet). The server's
 *   realtime echo may land before the action's answer; `claim(real)` matches it to the temporary row (same creator,
 *   project and title, oldest first) so the list swaps it instead of showing both.
 */

export type Fields = Record<string, unknown>;

export interface TaskLike {
  id: string;
}

export type TaskOverlay = ReturnType<typeof createTaskOverlay>;

export function createTaskOverlay() {
  /** task id -> token -> fields, in write order (Map keeps insertion order). */
  const byTask = new Map<string, Map<string, Fields>>();
  /** Tasks being deleted (token -> task id). */
  const deleting = new Map<string, string>();
  /**
   * Tasks known to be deleted for good. A list refresh that started before the delete (e.g. the navigation that closes
   * the pane runs beside the delete action) can still carry them; they must not come back.
   */
  const gone = new Set<string>();
  const tokenTask = new Map<string, string>();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((fn) => fn());

  /** Pending fields for one task, later writes winning. Empty object when nothing is pending. */
  const fieldsFor = (id: string): Fields => {
    const writes = byTask.get(id);
    if (!writes) return {};
    const out: Fields = {};
    writes.forEach((f) => Object.assign(out, f));
    return out;
  };

  return {
    /** Records a write's optimistic fields under `token` (one per action). */
    add(token: string, id: string, fields: Fields) {
      let writes = byTask.get(id);
      if (!writes) byTask.set(id, (writes = new Map()));
      writes.set(token, { ...fields });
      tokenTask.set(token, id);
      emit();
    },
    /** Marks a task as being deleted until `remove(token)`. */
    addDelete(token: string, id: string) {
      deleting.set(token, id);
      tokenTask.set(token, id);
      emit();
    },
    /** The write settled (saved, refused or discarded). */
    remove(token: string) {
      const id = tokenTask.get(token);
      if (id === undefined) return;
      tokenTask.delete(token);
      deleting.delete(token);
      const writes = byTask.get(id);
      if (writes) {
        writes.delete(token);
        if (!writes.size) byTask.delete(id);
      }
      emit();
    },
    fieldsFor,
    /** The task was deleted (for good, see `markGone`). */
    markGone(id: string) {
      gone.add(id);
      emit();
    },
    /** Being deleted, or deleted: views leave it out whatever copy arrives. */
    isDeleting(id: string) {
      if (gone.has(id)) return true;
      for (const t of deleting.values()) if (t === id) return true;
      return false;
    },
    /** `task` with every pending write on it laid over. Returns the same object when nothing is pending. */
    apply<T extends TaskLike>(task: T): T {
      const writes = byTask.get(task.id);
      return writes ? { ...task, ...fieldsFor(task.id) } : task;
    },
    /**
     * The fields to put back after a refused write: `before` (the values it replaced) minus what later writes on the
     * task still hold, so a rename refused after a status change doesn't undo the status change.
     */
    revert(id: string, before: Fields): Fields {
      const still = fieldsFor(id);
      const out: Fields = {};
      for (const [k, v] of Object.entries(before)) out[k] = k in still ? still[k] : v;
      return out;
    },
    /** Is anything pending on this task? */
    has(id: string) {
      return byTask.has(id) || this.isDeleting(id);
    },
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}

/** The values `fields` would replace on `task` (what a refusal puts back). */
export function beforeOf(task: object, fields: Fields): Fields {
  const out: Fields = {};
  for (const k of Object.keys(fields)) out[k] = (task as Fields)[k];
  return out;
}

/* ----- pending creates ----- */

export const TEMP_PREFIX = "tmp_";
export const isTempId = (id: string) => id.startsWith(TEMP_PREFIX);

export interface TempTask extends TaskLike {
  projectId: string;
  title: string;
  createdBy: string;
}

export type PendingCreates = ReturnType<typeof createPendingCreates>;

export function createPendingCreates() {
  let seq = 0;
  /** temp id -> the temporary task, oldest first. */
  const temps = new Map<string, TempTask>();
  /** temp id -> real id once known (by echo or answer), so the second of the two is recognised too. */
  const resolved = new Map<string, string>();

  const sameTask = (temp: TempTask, real: TempTask) => temp.projectId === real.projectId && temp.createdBy === real.createdBy && temp.title === real.title;

  return {
    newId: () => `${TEMP_PREFIX}${Date.now().toString(36)}${(seq++).toString(36)}`,
    register(temp: TempTask) {
      temps.set(temp.id, temp);
    },
    /**
     * A task arrived from the server that the list doesn't hold yet. If it is one of ours still waiting for its
     * answer, returns the temporary id it replaces (and links them), else null.
     */
    claim(real: TempTask): string | null {
      if ([...resolved.values()].includes(real.id)) return null;
      for (const [tempId, temp] of temps) {
        if (!resolved.has(tempId) && sameTask(temp, real)) {
          resolved.set(tempId, real.id);
          return tempId;
        }
      }
      return null;
    },
    /** The action answered with the real task: links it, returns true if an echo had already claimed it. */
    resolve(tempId: string, realId: string): boolean {
      const was = resolved.get(tempId) === realId;
      resolved.set(tempId, realId);
      return was;
    },
    /** The real id a temporary task became, if known. */
    realIdOf: (tempId: string) => resolved.get(tempId) ?? null,
    /** Done with this temporary task (saved and swapped, refused or discarded). */
    forget(tempId: string) {
      temps.delete(tempId);
      resolved.delete(tempId);
    },
    pending: () => [...temps.values()].filter((t) => !resolved.has(t.id)),
  };
}
