import "server-only";
import { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { UserError } from "@/lib/result";
import { publish } from "@/lib/realtime/server";
import { loadWorkingBots, toFeed, toTask } from "@/lib/data";
import { wakeBots } from "@/lib/bot-dispatch";
import { notify } from "@/lib/notifications";
import { isClosedCategory, type ActivityDoc, type TaskDoc, type TaskRef } from "@/lib/types";

/**
 * Task dependencies. A task depends on other tasks in the same organisation; it's *ready* once every one
 * of them is closed (a done- or cancelled-stage status). A cancelled dependency releases its dependents
 * too, with a "was cancelled" note, so the assignee (or the triager closing out an umbrella) decides
 * what that means instead of the task waiting forever. `waitingOn` stores the ones that aren't, so "is this ready?" is a
 * plain query (check_for_work skips tasks with anything in it).
 *
 * When the last dependency finishes, the task's assignee hears about it: a bot gets a wake-up (or finds it
 * on its next check_for_work), a person gets a notification. Until then, assigning a bot doesn't wake it.
 * If a bot triaged the task (TaskDoc.triagedBy), that bot is also called back to close it out (TaskDoc.closeout).
 */

export const MAX_DEPENDENCIES = 50;

/** Mongo filter for tasks with nothing left to wait for (also matches tasks that never had dependencies). */
export const READY = { "waitingOn.0": { $exists: false } } as const;

/** Who caused a change, for activity, wake-ups and notifications. */
export interface By {
  id: ObjectId;
  name: () => Promise<string>;
}

const hex = (id: ObjectId) => id.toHexString();
const sameIds = (a: ObjectId[], b: ObjectId[]) => a.length === b.length && a.every((id, i) => id.equals(b[i]));

async function closedStatusIds(orgId: ObjectId) {
  const c = await cols();
  return new Set((await c.statuses.find({ orgId, category: { $in: ["done", "cancelled"] } }, { projection: { _id: 1 } }).toArray()).map((s) => hex(s._id)));
}

/** The dependencies that aren't closed (done or cancelled) yet, in `deps` order. Missing tasks don't count. */
export async function openDependencies(orgId: ObjectId, deps: ObjectId[]): Promise<ObjectId[]> {
  if (!deps.length) return [];
  const c = await cols();
  const [done, docs] = await Promise.all([closedStatusIds(orgId), c.tasks.find({ orgId, _id: { $in: deps } }, { projection: { statusId: 1 } }).toArray()]);
  const open = new Set(docs.filter((d) => !done.has(hex(d.statusId))).map((d) => hex(d._id)));
  return deps.filter((id) => open.has(hex(id)));
}

/** "WEB-12" for each task id. */
export async function taskKeys(orgId: ObjectId, ids: ObjectId[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const c = await cols();
  const [tasks, projects] = await Promise.all([
    c.tasks.find({ orgId, _id: { $in: ids } }, { projection: { projectId: 1, number: 1 } }).toArray(),
    c.projects.find({ orgId }, { projection: { key: 1 } }).toArray(),
  ]);
  const pk = new Map(projects.map((p) => [hex(p._id), p.key]));
  return new Map(tasks.map((t) => [hex(t._id), `${pk.get(hex(t.projectId)) ?? "?"}-${t.number}`]));
}

/** Does `from` (transitively) depend on `target`? */
async function reaches(orgId: ObjectId, from: ObjectId, target: ObjectId) {
  const c = await cols();
  const seen = new Set<string>([hex(from)]);
  let frontier = [from];
  while (frontier.length && seen.size < 5000) {
    const docs = await c.tasks.find({ orgId, _id: { $in: frontier } }, { projection: { dependsOn: 1 } }).toArray();
    const next: ObjectId[] = [];
    for (const d of docs) {
      for (const dep of d.dependsOn ?? []) {
        if (dep.equals(target)) return true;
        if (!seen.has(hex(dep))) {
          seen.add(hex(dep));
          next.push(dep);
        }
      }
    }
    frontier = next;
  }
  return false;
}

/**
 * Validates a task's full dependency list: tasks in this organisation, not the task itself, at most
 * MAX_DEPENDENCIES, and no loops. Returns the list deduplicated, in the order given.
 */
export async function checkDependencies(orgId: ObjectId, taskId: ObjectId | null, ids: ObjectId[], previous: ObjectId[] = []): Promise<ObjectId[]> {
  const list = [...new Map(ids.map((id) => [hex(id), id])).values()];
  if (list.length > MAX_DEPENDENCIES) throw new UserError(`A task can depend on at most ${MAX_DEPENDENCIES} others.`);
  if (taskId && list.some((id) => id.equals(taskId))) throw new UserError("A task can't depend on itself.");
  if (!list.length) return list;
  const c = await cols();
  const found = await c.tasks.countDocuments({ orgId, _id: { $in: list } });
  if (found !== list.length) throw new UserError("One of those dependencies isn't a task in this organisation any more.");
  if (taskId) {
    for (const id of list.filter((x) => !previous.some((p) => p.equals(x)))) {
      if (await reaches(orgId, id, taskId)) {
        const keys = await taskKeys(orgId, [id, taskId]);
        throw new UserError(`${keys.get(hex(id))} already depends on ${keys.get(hex(taskId))}, directly or through other tasks. Depending on it would be a loop.`);
      }
    }
  }
  return list;
}

/** A task's dependencies (in order) and dependents, for the task pane. */
export async function loadTaskRefs(orgId: ObjectId, task: TaskDoc): Promise<{ dependencies: TaskRef[]; dependents: TaskRef[] }> {
  const c = await cols();
  const [deps, dependents, projects] = await Promise.all([
    task.dependsOn?.length ? c.tasks.find({ orgId, _id: { $in: task.dependsOn } }, { projection: { description: 0 } }).toArray() : [],
    c.tasks.find({ orgId, dependsOn: task._id }, { projection: { description: 0 } }).sort({ createdAt: 1 }).limit(200).toArray(),
    c.projects.find({ orgId }, { projection: { key: 1 } }).toArray(),
  ]);
  const pk = new Map(projects.map((p) => [hex(p._id), p.key]));
  const working = await loadWorkingBots([...(deps as TaskDoc[]), ...(dependents as TaskDoc[])].map((t) => t._id));
  const ref = (t: TaskDoc): TaskRef => ({
    id: hex(t._id),
    key: `${pk.get(hex(t.projectId)) ?? "?"}-${t.number}`,
    title: t.title,
    statusId: hex(t.statusId),
    assigneeId: t.assigneeId ? hex(t.assigneeId) : null,
    archived: !!t.archivedAt,
    workingBotIds: working.get(hex(t._id)) ?? [],
  });
  const byId = new Map((deps as TaskDoc[]).map((t) => [hex(t._id), t]));
  return {
    dependencies: (task.dependsOn ?? []).flatMap((id) => (byId.has(hex(id)) ? [ref(byId.get(hex(id))!)] : [])),
    dependents: (dependents as TaskDoc[]).map(ref),
  };
}

/* ---------------- keeping waitingOn in step ---------------- */

async function projectKey(projectId: ObjectId) {
  return (await (await cols()).projects.findOne({ _id: projectId }, { projection: { key: 1 } }))?.key ?? "?";
}

/**
 * Recomputes `waitingOn` for `tasks` and publishes the ones that changed. A task whose last open
 * dependency just closed is handed to its assignee. `finished` names the tasks whose change triggered
 * this (for the "WEB-1 is done" line); `drop` removes deleted tasks from the lists first.
 */
async function reevaluate(orgId: ObjectId, by: By, tasks: TaskDoc[], opts: { finished?: ObjectId[]; drop?: ObjectId[]; deleted?: boolean } = {}) {
  const c = await cols();
  const drop = opts.drop ?? [];
  const finishedKeys = await taskKeys(orgId, opts.finished ?? []);
  const cancelled = await cancelledIds(orgId, opts.deleted ? [] : (opts.finished ?? []));
  for (const t of tasks) {
    const deps = (t.dependsOn ?? []).filter((id) => !drop.some((d) => d.equals(id)));
    const waiting = await openDependencies(orgId, deps);
    const depsChanged = deps.length !== (t.dependsOn ?? []).length;
    if (!depsChanged && sameIds(waiting, t.waitingOn ?? [])) continue;
    const set: Partial<TaskDoc> = { waitingOn: waiting, updatedAt: new Date() };
    if (depsChanged) set.dependsOn = deps;
    const after = await c.tasks.findOneAndUpdate({ _id: t._id, orgId }, { $set: set }, { returnDocument: "after" });
    if (!after) continue;
    // Before the upsert, so the task never broadcasts as "finished" Stalled in between (a pending close-out also
    // keeps it from being Stalled, so it's recorded here too).
    const nowReady = (t.waitingOn ?? []).length > 0 && !waiting.length;
    if (nowReady) await reopenForHandOff(orgId, after);
    const closer = nowReady ? await recordCloseout(orgId, after) : null;
    const pKey = await projectKey(after.projectId);
    const key = `${pKey}-${after.number}`;
    await publish(hex(orgId), { type: "task.upsert", actorId: hex(by.id), task: toTask(after, pKey) });
    if (nowReady) {
      const ids = (t.dependsOn ?? []).filter((id) => finishedKeys.has(hex(id)));
      const finished = ids.map((id) => finishedKeys.get(hex(id))!);
      const cancelledKeys = ids.filter((id) => cancelled.has(hex(id))).map((id) => finishedKeys.get(hex(id))!);
      await handOffReady(orgId, by, after, key, finished, opts.deleted ? "deleted" : "done", cancelledKeys, closer);
    }
  }
}

/**
 * The task just became ready (its last open dependency closed or was removed). If its assignee is a bot that had
 * finished a round on it (a `done` claim, e.g. it parked the task behind new dependencies and called complete_task),
 * forget that claim so the ready hand-off really hands it back: a push delivery takes a fresh in-progress claim
 * (and moves Todo / In Review to In Progress), and check_for_work offers it again, which it never does for a task
 * the bot holds any claim on. Call it before publishing the task. Skipped when that bot also triaged the task:
 * it gets only the close-out wake-up then, which it ends with complete_task as before.
 */
export async function reopenForHandOff(orgId: ObjectId, task: TaskDoc) {
  const assignee = task.assigneeId;
  if (!assignee || task.archivedAt || task.triagedBy?.equals(assignee)) return;
  const c = await cols();
  if (!(await c.bots.findOne({ orgId, _id: assignee }, { projection: { _id: 1 } }))) return;
  const status = await c.statuses.findOne({ _id: task.statusId }, { projection: { category: 1 } });
  if (!status || status.category === "triage" || isClosedCategory(status.category)) return;
  await c.agentClaims.deleteMany({ taskId: task._id, botId: assignee, state: "done", kind: { $ne: "triage" } });
}

/** Which of `ids` are in a cancelled-stage status now. */
async function cancelledIds(orgId: ObjectId, ids: ObjectId[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const c = await cols();
  const statuses = (await c.statuses.find({ orgId, category: "cancelled" }, { projection: { _id: 1 } }).toArray()).map((s) => s._id);
  if (!statuses.length) return new Set();
  const docs = await c.tasks.find({ orgId, _id: { $in: ids }, statusId: { $in: statuses } }, { projection: { _id: 1 } }).toArray();
  return new Set(docs.map((d) => hex(d._id)));
}

/** A task was closed (done or cancelled) or reopened: re-check everything that depends on it. */
export async function dependencyChanged(orgId: ObjectId, by: By, changed: ObjectId[]) {
  const c = await cols();
  const dependents = await c.tasks.find({ orgId, dependsOn: { $in: changed } }).toArray();
  if (dependents.length) await reevaluate(orgId, by, dependents, { finished: changed });
}

/** Tasks are about to be deleted: take them out of every dependency list (call before deleting). */
export async function detachDeleted(orgId: ObjectId, by: By, ids: ObjectId[]) {
  if (!ids.length) return;
  const c = await cols();
  const dependents = await c.tasks.find({ orgId, dependsOn: { $in: ids }, _id: { $nin: ids } }).toArray();
  if (dependents.length) await reevaluate(orgId, by, dependents, { drop: ids, finished: ids, deleted: true });
}

/**
 * Statuses changed stage (one now counts as closed, or stopped counting) or tasks were moved between statuses by an
 * admin: re-check only the tasks that depend on tasks in those statuses (VEC-115: one project's statuses, so the
 * rest of the org is untouched).
 */
export async function recomputeForStatuses(orgId: ObjectId, by: By, statusIds: ObjectId[]) {
  if (!statusIds.length) return;
  const c = await cols();
  const affected = (await c.tasks.find({ orgId, statusId: { $in: statusIds } }, { projection: { _id: 1 } }).toArray()).map((t) => t._id);
  if (!affected.length) return;
  const dependents = await c.tasks.find({ orgId, dependsOn: { $in: affected } }).toArray();
  if (dependents.length) await reevaluate(orgId, by, dependents, { finished: affected });
}

/**
 * Every dependency of `task` is closed (done or cancelled). Log it, then tell the assignee: a bot gets a wake-up (pull-mode bots
 * find it on their next check_for_work), a person gets a notification. The bot that triaged it gets a close-out
 * wake-up (or kind "closeout" on check_for_work); when that bot is also the assignee it gets only the close-out.
 * Closed and archived tasks are only logged, and so are unassigned, untriaged ones.
 */
export async function handOffReady(
  orgId: ObjectId,
  by: By,
  task: TaskDoc,
  key: string,
  finishedKeys: string[],
  how: "done" | "deleted" | "removed" = "done",
  /** The subset of `finishedKeys` that was cancelled rather than done. */
  cancelledKeys: string[] = [],
  /** The close-out the caller already recorded with recordCloseout (before its task.upsert); undefined records it here. */
  recorded?: ObjectId | null,
) {
  const c = await cols();
  // `from` names what finished it; a removal is already logged as dependency_removed, so it stays empty then.
  const act: ActivityDoc = { _id: new ObjectId(), orgId, taskId: task._id, actorId: by.id, kind: "unblocked", from: how === "done" ? finishedKeys.join(", ") || null : null, createdAt: new Date() };
  await c.activity.insertOne(act);
  await publish(hex(orgId), { type: "feed.add", actorId: hex(by.id), taskId: hex(task._id), item: toFeed(act) });

  if (task.archivedAt) return;
  const status = await c.statuses.findOne({ _id: task.statusId }, { projection: { category: 1 } });
  if (status && (status.category === "done" || status.category === "cancelled")) return;
  const detail = readyDetail(finishedKeys, how, cancelledKeys);

  // A triaged umbrella: its triager is called back to close it out (on top of the assignee hearing about it).
  const closer = recorded !== undefined ? recorded : await recordCloseout(orgId, task);
  if (closer) wakeBots(orgId, [closer], { kind: "closeout", taskId: task._id, taskKey: key, title: task.title, by: await by.name(), detail });

  if (!task.assigneeId) return;
  // The triager is also the assignee: the close-out wake-up already covers it.
  if (closer && closer.equals(task.assigneeId)) return;
  const bot = await c.bots.findOne({ orgId, _id: task.assigneeId }, { projection: { _id: 1 } });
  if (bot) {
    // Even when the bot finished the dependency itself: this is a different task it now has to start.
    wakeBots(orgId, [task.assigneeId], { kind: "ready", taskId: task._id, taskKey: key, title: task.title, by: await by.name(), detail });
  } else {
    await notify(orgId, [task.assigneeId], { kind: "ready", taskId: task._id, actorId: by.id, detail });
  }
}

/** "WEB-1 is done", "WEB-2 was cancelled", "WEB-1 is done and WEB-2 was cancelled", "WEB-3 was deleted"... */
function readyDetail(keys: string[], how: "done" | "deleted" | "removed", cancelledKeys: string[]) {
  if (!keys.length) return "Nothing it depends on is open any more";
  const phrase = (list: string[], one: string, many: string) => `${list.join(", ")} ${list.length === 1 ? one : many}`;
  if (how === "deleted") return phrase(keys, "was deleted", "were deleted");
  if (how === "removed") return `${keys.join(", ")} no longer blocks it`;
  const done = keys.filter((k) => !cancelledKeys.includes(k));
  const cancelled = keys.filter((k) => cancelledKeys.includes(k));
  return [done.length ? phrase(done, "is done", "are done") : "", cancelled.length ? phrase(cancelled, "was cancelled", "were cancelled") : ""].filter(Boolean).join(" and ");
}

/**
 * The task is ready and open. If a bot triaged it, record a pending close-out for that bot (push bots are woken by
 * handOffReady; polling bots find it on check_for_work). Returns the bot, or null for untriaged tasks.
 * The record is only written while the task is still ready, open, unarchived and triaged by that bot, so a
 * task closed or re-triaged in the meantime isn't handed out. Call it before the task's upsert: a pending
 * close-out keeps the task from showing as "finished" Stalled (VEC-89), so the broadcast must already see it.
 */
export async function recordCloseout(orgId: ObjectId, task: TaskDoc): Promise<ObjectId | null> {
  const botId = task.triagedBy;
  if (!botId || task.archivedAt) return null;
  const c = await cols();
  if (!(await c.bots.findOne({ orgId, _id: botId }, { projection: { _id: 1 } }))) return null;
  const status = await c.statuses.findOne({ _id: task.statusId }, { projection: { category: 1 } });
  if (!status || isClosedCategory(status.category)) return null;
  const res = await c.tasks.updateOne(
    { _id: task._id, orgId, triagedBy: botId, archivedAt: null, ...READY },
    { $set: { closeout: { botId, requestedAt: new Date(), deliveredAt: null, resolvedAt: null } } },
  );
  return res.matchedCount ? botId : null;
}

/**
 * The bot handled its close-out of this task (complete_task, or moved its status): the close-out is no longer
 * pending, so a task it left open with waiters shows as "finished" Stalled again. Returns whether one was pending;
 * the caller republishes the task.
 */
export async function resolveCloseout(taskId: ObjectId, botId: ObjectId): Promise<boolean> {
  const c = await cols();
  const res = await c.tasks.updateOne({ _id: taskId, "closeout.botId": botId, "closeout.resolvedAt": null }, { $set: { "closeout.resolvedAt": new Date() } });
  return res.modifiedCount > 0;
}
