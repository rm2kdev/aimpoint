import "server-only";
import { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { UserError } from "@/lib/result";
import { publish } from "@/lib/realtime/server";
import { sanitizeDescription, toFeed, toTask, withWorkingBots } from "@/lib/data";
import { publishWorking } from "@/lib/claims";
import { ASSIGNEE_FIELDS, CLOSE_OUT_FIELDS, TRIAGE_FIELDS, closeOutStatuses, taskAccess } from "@/lib/access";
import { wakeBots, wakeTriage } from "@/lib/bot-dispatch";
import { notify } from "@/lib/notifications";
import { checkDependencies, dependencyChanged, detachDeleted, handOffReady, openDependencies, taskKeys, type By } from "@/lib/dependencies";
import { isClosedCategory, type ActivityDoc, type FeedItem, type Priority, type StatusCategory, type Task, type TaskDoc, type TaskType } from "@/lib/types";

/**
 * Task writes shared by the web app (server actions) and the bot API.
 * An actor is a signed-in user or a bot; bots are never admins.
 */
export interface Actor {
  orgId: ObjectId;
  id: ObjectId;
  isAdmin: boolean;
  isBot?: boolean;
}

/** Ownership rule: the creator and org admins may change a task; everyone in the org can read and comment. */
export function canEditTask(task: TaskDoc, actorId: ObjectId, isAdmin: boolean) {
  return isAdmin || task.createdBy.equals(actorId);
}

/**
 * A (re)assignment to a bot is fresh work: forget any earlier pick-up of this task by that bot.
 * A triage still in progress stays (the triager may be assigning the task to itself).
 */
async function resetClaimOnAssign(taskId: ObjectId, assigneeId: ObjectId | null) {
  if (!assigneeId) return;
  const c = await cols();
  await c.agentClaims.deleteMany({ taskId, botId: assigneeId, $or: [{ kind: { $ne: "triage" } }, { state: "done" }] });
}

/** The bot took this task with check_for_triage and hasn't finished or released it. */
export async function isTriaging(botId: ObjectId, taskId: ObjectId) {
  const c = await cols();
  return !!(await c.agentClaims.findOne({ botId, taskId, kind: "triage", state: "in_progress" }, { projection: { _id: 1 } }));
}

/**
 * The bot that triaged this task (and isn't its creator or assignee) closing it out: only a status change,
 * only to a closing status, and only once nothing it depends on is open.
 */
async function assertCloseOut(actor: Actor, task: TaskDoc, patch: TaskPatch) {
  const blocked = (Object.keys(patch) as (keyof TaskPatch)[]).filter((k) => patch[k] !== undefined && !(CLOSE_OUT_FIELDS as readonly string[]).includes(k));
  const c = await cols();
  const closing = closeOutStatuses(await c.statuses.find({ orgId: actor.orgId }).toArray());
  const names = closing.map((s) => s.name).join(", ") || "a done status";
  if (blocked.length) {
    throw new UserError(`You triaged this task, so you can comment on it and close it out (move it to ${names}) once nothing it depends on is open. Anything else needs its creator, its assignee or an admin.`);
  }
  if (!patch.statusId || patch.statusId === task.statusId.toHexString()) return;
  if (!closing.some((s) => s._id.toHexString() === patch.statusId)) {
    throw new UserError(`As the bot that triaged this task you can only move it to a closing status: ${names}.`);
  }
  const waiting = task.waitingOn ?? [];
  if (waiting.length) {
    const keys = await taskKeys(actor.orgId, waiting);
    const list = waiting.map((id) => keys.get(id.toHexString()) ?? "another task").join(", ");
    throw new UserError(`This task is still waiting on ${list}. As the bot that triaged it you can close it out once ${waiting.length === 1 ? "that is" : "those are"} done.`);
  }
}

/** Record that `botId` finished triaging the task: it now owns closing the umbrella out. */
export async function recordTriagedBy(taskId: ObjectId, botId: ObjectId) {
  const c = await cols();
  await c.tasks.updateOne({ _id: taskId }, { $set: { triagedBy: botId } });
}

/** Stages a bot's pickup moves out of. Triage, done and cancelled tasks are never touched. */
const STARTABLE = new Set<StatusCategory>(["backlog", "unstarted", "started"]);

/**
 * A bot took a (non-triage) in-progress claim on a task: the status follows the work. Moves it to the
 * first started-stage status in workflow order (In Progress by default) when it's in a backlog/unstarted
 * status or in another started status (e.g. In Review). Records the move as the bot's activity and
 * broadcasts the task. Returns true when it moved; the caller can then skip its own working-state publish,
 * since this upsert carries the claim too.
 */
export async function markStartedByBot(orgId: ObjectId, botId: ObjectId, taskId: ObjectId): Promise<boolean> {
  try {
    const c = await cols();
    const task = await c.tasks.findOne({ _id: taskId, orgId }, { projection: { statusId: 1 } });
    if (!task) return false;
    const statuses = await c.statuses.find({ orgId }, { projection: { category: 1, order: 1 } }).sort({ order: 1 }).toArray();
    const target = statuses.find((s) => s.category === "started");
    const current = statuses.find((s) => s._id.equals(task.statusId));
    if (!target || !current || current._id.equals(target._id) || !STARTABLE.has(current.category)) return false;
    const now = new Date();
    // Conditional on the status we read, so a concurrent move by a person wins.
    const after = await c.tasks.findOneAndUpdate({ _id: taskId, orgId, statusId: current._id }, { $set: { statusId: target._id, updatedAt: now } }, { returnDocument: "after" });
    if (!after) return false;
    const act: ActivityDoc = { _id: new ObjectId(), orgId, taskId, actorId: botId, kind: "status", from: current._id.toHexString(), to: target._id.toHexString(), note: "started_work", createdAt: now };
    await c.activity.insertOne(act);
    const project = await c.projects.findOne({ _id: after.projectId }, { projection: { key: 1 } });
    const orgHex = orgId.toHexString();
    const actorId = botId.toHexString();
    await publish(orgHex, { type: "task.upsert", actorId, task: toTask(after, project?.key ?? "?") });
    await publish(orgHex, { type: "feed.add", actorId, taskId: taskId.toHexString(), item: toFeed(act) });
    return true;
  } catch (err) {
    // The pickup itself already happened; a failed status follow-up shouldn't fail it.
    console.error("[tasks] markStartedByBot failed", err);
    return false;
  }
}

/**
 * A task arrived in a Triage status (created there or moved in). Any earlier triage of it is history, so
 * it's offered afresh: pushed to a connected triage bot now, or found by the next check_for_triage.
 */
async function enterTriage(actor: Actor, task: TaskDoc, key: string) {
  const c = await cols();
  // The last triager's close-out rights end here; whoever triages it next takes them over.
  if (task.triagedBy || task.closeout) await c.tasks.updateOne({ _id: task._id }, { $set: { triagedBy: null, closeout: null } });
  const dropped = await c.agentClaims.deleteMany({ taskId: task._id, kind: "triage" });
  if (dropped.deletedCount) await publishWorking(actor.orgId, actor.id, [task._id]);
  wakeTriage(actor.orgId, { taskId: task._id, taskKey: key, title: task.title, by: await actorName(actor), exclude: actor.id });
}

export const oid = (id: string, what = "item") => {
  if (!ObjectId.isValid(id)) throw new UserError(`Unknown ${what}.`);
  return new ObjectId(id);
};

/** Display name of a user or bot, for wake-up messages. */
async function actorName(actor: Actor) {
  const c = await cols();
  const doc = actor.isBot ? await c.bots.findOne({ _id: actor.id }, { projection: { name: 1 } }) : await c.users.findOne({ _id: actor.id }, { projection: { name: 1 } });
  return doc?.name ?? "Someone";
}

const byOf = (actor: Actor): By => ({ id: actor.id, name: () => actorName(actor) });

const parseIds = (ids: unknown, what: string) => {
  if (!Array.isArray(ids)) throw new UserError(`${what} is a list of task ids.`);
  return ids.map((id) => oid(String(id), "dependency"));
};

/**
 * Tell a new assignee. Bots are woken only when the task is ready (nothing it depends on is open); a
 * blocked task reaches them when it becomes ready. People are notified either way, with what it waits on.
 *
 * A bot assigning a task to itself (e.g. a triager creating the subtasks it will do) is still woken: that's
 * new work, and push bots never poll for it. Only a task the bot already holds (it's working on or
 * triaging it right now) is skipped. People assigning themselves aren't notified.
 */
async function announceAssignment(actor: Actor, task: TaskDoc, key: string) {
  const assigneeId = task.assigneeId;
  if (!assigneeId) return;
  const self = assigneeId.equals(actor.id);
  if (self && !actor.isBot) return;
  const c = await cols();
  const isBot = !!(await c.bots.findOne({ orgId: actor.orgId, _id: assigneeId }, { projection: { _id: 1 } }));
  const waiting = task.waitingOn ?? [];
  if (isBot) {
    if (self && (await c.agentClaims.findOne({ botId: assigneeId, taskId: task._id, state: "in_progress" }, { projection: { _id: 1 } }))) return;
    if (!waiting.length) wakeBots(actor.orgId, [assigneeId], { kind: "assigned", taskId: task._id, taskKey: key, title: task.title, by: await actorName(actor) });
    return;
  }
  const keys = waiting.length ? await taskKeys(actor.orgId, waiting) : new Map<string, string>();
  await notify(actor.orgId, [assigneeId], {
    kind: "assigned",
    taskId: task._id,
    actorId: actor.id,
    detail: waiting.length ? `Waiting on ${waiting.map((id) => keys.get(id.toHexString()) ?? "another task").join(", ")}` : null,
  });
}

/** Assignees can be org members or the org's bots. */
async function assertAssignable(orgId: ObjectId, id: ObjectId) {
  const c = await cols();
  const [m, b] = await Promise.all([
    c.memberships.findOne({ orgId, userId: id }, { projection: { _id: 1 } }),
    c.bots.findOne({ orgId, _id: id }, { projection: { _id: 1 } }),
  ]);
  if (!m && !b) throw new UserError("That assignee isn't a member or bot of this organisation.");
}

export interface NewTaskInput {
  title: string;
  projectId: string;
  type: TaskType;
  statusId?: string;
  assigneeId?: string | null;
  priority?: Priority;
  description?: string;
  dueDate?: string | null;
  /** Ids of tasks this one waits for. */
  dependsOn?: string[];
}

/** "YYYY-MM-DD" -> UTC-midnight Date; null clears; throws on anything else. */
export function parseDueDate(v: unknown): Date | null {
  if (v === null || v === "") return null;
  const s = String(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
    throw new UserError("Due dates look like 2026-11-30.");
  }
  return new Date(`${s}T00:00:00Z`);
}

/** Why a project can't take tasks: it's archived, or it doesn't exist. */
async function missingProjectReason(projectId: ObjectId, orgId: ObjectId, fallback: string) {
  const p = await (await cols()).projects.findOne({ _id: projectId, orgId }, { projection: { name: 1, key: 1, archivedAt: 1 } });
  return p?.archivedAt ? `${p.name} (${p.key}) is archived and doesn't take new tasks. An admin can restore it in project settings.` : fallback;
}

export async function createTaskAs(actor: Actor, input: NewTaskInput): Promise<Task> {
  const title = (input.title ?? "").trim();
  if (!title) throw new UserError("Give the task a title.");
  if (title.length > 300) throw new UserError("Keep titles under 300 characters.");
  const c = await cols();
  const projectId = oid(input.projectId, "project");
  const project = await c.projects.findOneAndUpdate(
    { _id: projectId, orgId: actor.orgId, archivedAt: null },
    { $inc: { nextNumber: 1 } },
    { returnDocument: "before" },
  );
  if (!project) throw new UserError(await missingProjectReason(projectId, actor.orgId, "Pick a project."));
  const status = input.statusId
    ? await c.statuses.findOne({ _id: oid(input.statusId, "status"), orgId: actor.orgId })
    : (await c.statuses.find({ orgId: actor.orgId, category: "unstarted" }).sort({ order: 1 }).limit(1).next()) ??
      (await c.statuses.find({ orgId: actor.orgId }).sort({ order: 1 }).limit(1).next());
  if (!status) throw new UserError("Pick a status.");
  let assigneeId: ObjectId | null = null;
  if (input.assigneeId) {
    assigneeId = oid(input.assigneeId, "assignee");
    await assertAssignable(actor.orgId, assigneeId);
  }
  const dependsOn = input.dependsOn?.length ? await checkDependencies(actor.orgId, null, parseIds(input.dependsOn, "`dependsOn`")) : [];
  const waitingOn = await openDependencies(actor.orgId, dependsOn);
  const now = new Date();
  const priority = input.priority ?? 0;
  const doc: TaskDoc = {
    _id: new ObjectId(),
    orgId: actor.orgId,
    projectId,
    number: project.nextNumber,
    title,
    description: sanitizeDescription(input.description ?? ""),
    type: input.type === "feature" ? "feature" : "issue",
    statusId: status._id,
    assigneeId,
    priority: ([0, 1, 2, 3] as const).includes(priority) ? priority : 0,
    dueDate: input.dueDate ? parseDueDate(input.dueDate) : null,
    archivedAt: null,
    archivedBy: null,
    dependsOn,
    waitingOn,
    createdBy: actor.id,
    createdAt: now,
    updatedAt: now,
  };
  await c.tasks.insertOne(doc);
  await c.activity.insertOne({ _id: new ObjectId(), orgId: actor.orgId, taskId: doc._id, actorId: actor.id, kind: "created", createdAt: now });
  const task = toTask(doc, project.key);
  await publish(actor.orgId.toHexString(), { type: "task.upsert", actorId: actor.id.toHexString(), task });
  await announceAssignment(actor, doc, task.key);
  if (status.category === "triage") await enterTriage(actor, doc, task.key);
  return task;
}

export interface TaskPatch {
  title?: string;
  description?: string;
  type?: TaskType;
  statusId?: string;
  assigneeId?: string | null;
  priority?: Priority;
  projectId?: string;
  dueDate?: string | null;
  archived?: boolean;
  /** Replaces the whole dependency list (ids). An empty list removes every dependency. */
  dependsOn?: string[];
}

export async function updateTaskAs(actor: Actor, taskId: ObjectId, patch: TaskPatch): Promise<Task> {
  const c = await cols();
  const before = await c.tasks.findOne({ _id: taskId, orgId: actor.orgId });
  if (!before) throw new UserError("This task no longer exists.");
  const access = taskAccess(
    { createdBy: before.createdBy.toHexString(), assigneeId: before.assigneeId?.toHexString() ?? null },
    actor.id.toHexString(),
    actor.isAdmin,
  );
  if (access !== "full") {
    const triaging = actor.isBot && (await isTriaging(actor.id, taskId));
    // The bot that triaged it may close it out (but nothing more) when it otherwise only gets to comment.
    const closingOut = access === "comment" && !triaging && actor.isBot && !!before.triagedBy?.equals(actor.id);
    if (closingOut) {
      await assertCloseOut(actor, before, patch);
    } else {
      if (access === "comment" && !triaging) throw new UserError("Only the task's creator, its assignee or an admin can change it. You can still comment.");
      const allowed = new Set<string>(triaging ? TRIAGE_FIELDS : ASSIGNEE_FIELDS);
      const blocked = (Object.keys(patch) as (keyof TaskPatch)[]).filter((k) => patch[k] !== undefined && !allowed.has(k));
      if (blocked.length) {
        throw new UserError(
          triaging
            ? "While triaging you can change everything except archiving. Only the task's creator or an admin can archive it."
            : "Only the task's creator or an admin can change its title, description, project or dependencies, or archive it. As the assignee you can change status, assignee, priority, type and due date.",
        );
      }
    }
  }
  const set: Partial<TaskDoc> = {};
  const acts: Omit<ActivityDoc, "_id" | "orgId" | "taskId" | "actorId" | "createdAt">[] = [];

  if (patch.title !== undefined) {
    const t = String(patch.title).trim();
    if (!t) throw new UserError("Titles can't be empty.");
    if (t.length > 300) throw new UserError("Keep titles under 300 characters.");
    if (t !== before.title) {
      set.title = t;
      acts.push({ kind: "title", from: before.title, to: t });
    }
  }
  if (patch.description !== undefined) set.description = sanitizeDescription(String(patch.description));
  if (patch.type && patch.type !== before.type) {
    set.type = patch.type === "feature" ? "feature" : "issue";
    acts.push({ kind: "type", from: before.type, to: set.type });
  }
  if (patch.priority !== undefined && patch.priority !== before.priority) {
    if (![0, 1, 2, 3].includes(patch.priority)) throw new UserError("Priority is 0 (none) to 3 (high).");
    set.priority = patch.priority;
    acts.push({ kind: "priority", from: String(before.priority), to: String(patch.priority) });
  }
  let doneChanged = false;
  let enteredTriage = false;
  if (patch.statusId && patch.statusId !== before.statusId.toHexString()) {
    const s = await c.statuses.findOne({ _id: oid(patch.statusId, "status"), orgId: actor.orgId });
    if (!s) throw new UserError("Unknown status.");
    set.statusId = s._id;
    acts.push({ kind: "status", from: before.statusId.toHexString(), to: s._id.toHexString() });
    const prev = await c.statuses.findOne({ _id: before.statusId }, { projection: { category: 1 } });
    // Closing (done or cancelled) or reopening it releases or re-blocks its dependents.
    doneChanged = isClosedCategory(prev?.category) !== isClosedCategory(s.category);
    enteredTriage = s.category === "triage" && prev?.category !== "triage";
  }
  let removedDeps: ObjectId[] = [];
  if (patch.dependsOn !== undefined) {
    const prev = before.dependsOn ?? [];
    const next = await checkDependencies(actor.orgId, taskId, parseIds(patch.dependsOn, "`dependsOn`"), prev);
    const added = next.filter((id) => !prev.some((p) => p.equals(id)));
    removedDeps = prev.filter((id) => !next.some((n) => n.equals(id)));
    if (added.length || removedDeps.length || next.some((id, i) => !prev[i]?.equals(id))) {
      set.dependsOn = next;
      set.waitingOn = await openDependencies(actor.orgId, next);
      const keys = await taskKeys(actor.orgId, [...added, ...removedDeps]);
      for (const id of added) acts.push({ kind: "dependency_added", to: keys.get(id.toHexString()) ?? null });
      for (const id of removedDeps) acts.push({ kind: "dependency_removed", to: keys.get(id.toHexString()) ?? null });
    }
  }
  if (patch.assigneeId !== undefined && (patch.assigneeId ?? null) !== (before.assigneeId?.toHexString() ?? null)) {
    let a: ObjectId | null = null;
    if (patch.assigneeId) {
      a = oid(patch.assigneeId, "assignee");
      await assertAssignable(actor.orgId, a);
    }
    set.assigneeId = a;
    acts.push({ kind: "assignee", from: before.assigneeId?.toHexString() ?? null, to: a?.toHexString() ?? null });
  }
  if (patch.dueDate !== undefined) {
    const d = parseDueDate(patch.dueDate);
    const fromS = before.dueDate ? before.dueDate.toISOString().slice(0, 10) : null;
    const toS = d ? d.toISOString().slice(0, 10) : null;
    if (fromS !== toS) {
      set.dueDate = d;
      acts.push({ kind: "due", from: fromS, to: toS });
    }
  }
  if (patch.archived !== undefined && patch.archived !== !!before.archivedAt) {
    set.archivedAt = patch.archived ? new Date() : null;
    set.archivedBy = patch.archived ? actor.id : null;
    acts.push({ kind: patch.archived ? "archived" : "restored" });
  }
  let projectKey: string | undefined;
  if (patch.projectId && patch.projectId !== before.projectId.toHexString()) {
    // Moving projects gives the task a new number in the destination project.
    const dest = oid(patch.projectId, "project");
    const p = await c.projects.findOneAndUpdate(
      { _id: dest, orgId: actor.orgId, archivedAt: null },
      { $inc: { nextNumber: 1 } },
      { returnDocument: "before" },
    );
    if (!p) throw new UserError(await missingProjectReason(dest, actor.orgId, "Unknown project."));
    set.projectId = p._id;
    set.number = p.nextNumber;
    projectKey = p.key;
    acts.push({ kind: "project", from: before.projectId.toHexString(), to: p._id.toHexString() });
  }

  if (!Object.keys(set).length) {
    const p = await c.projects.findOne({ _id: before.projectId });
    return (await withWorkingBots([toTask(before, p?.key ?? "?")]))[0];
  }
  const now = new Date();
  set.updatedAt = now;
  const after = await c.tasks.findOneAndUpdate({ _id: taskId, orgId: actor.orgId }, { $set: set }, { returnDocument: "after" });
  if (!after) throw new UserError("This task no longer exists.");
  if (set.assigneeId !== undefined) await resetClaimOnAssign(taskId, set.assigneeId);
  projectKey ??= (await c.projects.findOne({ _id: after.projectId }))?.key ?? "?";
  const task = toTask(after, projectKey);
  const orgHex = actor.orgId.toHexString();
  const actorId = actor.id.toHexString();
  await publish(orgHex, { type: "task.upsert", actorId, task, descriptionChanged: patch.description !== undefined });

  if (acts.length) {
    const docs: ActivityDoc[] = acts.map((a) => ({ ...a, _id: new ObjectId(), orgId: actor.orgId, taskId, actorId: actor.id, createdAt: now }));
    await c.activity.insertMany(docs);
    for (const d of docs) await publish(orgHex, { type: "feed.add", actorId, taskId: taskId.toHexString(), item: toFeed(d) });
  }

  if (set.assigneeId) {
    await announceAssignment(actor, after, task.key);
  } else if (set.waitingOn && (before.waitingOn ?? []).length && !set.waitingOn.length) {
    // Removing the last open dependency makes it ready, just as finishing it would.
    const keys = await taskKeys(actor.orgId, removedDeps);
    await handOffReady(actor.orgId, byOf(actor), after, task.key, removedDeps.flatMap((id) => keys.get(id.toHexString()) ?? []), "removed");
  }
  // Closing (or reopening) this task releases (or re-blocks) the tasks that wait for it.
  if (doneChanged) await dependencyChanged(actor.orgId, byOf(actor), [taskId]);
  if (enteredTriage && !after.archivedAt) await enterTriage(actor, after, task.key);
  return task;
}

export async function deleteTaskAs(actor: Actor, taskId: ObjectId) {
  const c = await cols();
  const t = await c.tasks.findOne({ _id: taskId, orgId: actor.orgId });
  if (!t) return;
  if (!canEditTask(t, actor.id, actor.isAdmin)) throw new UserError("Only the task's creator or an admin can delete it.");
  // Tasks waiting on this one stop waiting (and are handed over if it was the last thing they waited for).
  await detachDeleted(actor.orgId, byOf(actor), [taskId]);
  await c.tasks.deleteOne({ _id: taskId });
  await Promise.all([
    c.comments.deleteMany({ taskId }),
    c.activity.deleteMany({ taskId }),
    c.agentClaims.deleteMany({ taskId }),
    c.botMentions.deleteMany({ taskId }),
    c.notifications.deleteMany({ taskId }),
  ]);
  await publish(actor.orgId.toHexString(), { type: "task.delete", actorId: actor.id.toHexString(), taskId: taskId.toHexString() });
}

export async function addCommentAs(actor: Actor, taskId: ObjectId, body: string): Promise<FeedItem> {
  const text = String(body ?? "").trim();
  if (!text) throw new UserError("Write something first.");
  if (text.length > 10_000) throw new UserError("Comments are limited to 10,000 characters.");
  const c = await cols();
  const target = await c.tasks.findOne({ _id: taskId, orgId: actor.orgId }, { projection: { _id: 1, projectId: 1, number: 1, title: 1 } });
  if (!target) throw new UserError("This task no longer exists.");
  // Mentions are <@id> tokens; keep only ids that are members or bots of this org.
  const ids = [...new Set([...text.matchAll(/<@([a-f0-9]{24})>/g)].map((m) => m[1]))].map((id) => new ObjectId(id));
  let mentions: ObjectId[] = [];
  let mentionedBots: ObjectId[] = [];
  let mentionedPeople: ObjectId[] = [];
  if (ids.length) {
    const [ms, bs] = await Promise.all([
      c.memberships.find({ orgId: actor.orgId, userId: { $in: ids } }, { projection: { userId: 1 } }).toArray(),
      c.bots.find({ orgId: actor.orgId, _id: { $in: ids } }, { projection: { _id: 1 } }).toArray(),
    ]);
    const ok = new Set([...ms.map((m) => m.userId.toHexString()), ...bs.map((b) => b._id.toHexString())]);
    mentions = ids.filter((id) => ok.has(id.toHexString()));
    mentionedBots = bs.map((b) => b._id).filter((id) => !id.equals(actor.id));
    mentionedPeople = ms.map((m) => m.userId).filter((id) => !id.equals(actor.id));
  }
  const doc = { _id: new ObjectId(), orgId: actor.orgId, taskId, authorId: actor.id, body: text, mentions, createdAt: new Date() };
  await c.comments.insertOne(doc);
  // Mentioned bots get an inbox entry; their next check_for_work surfaces the thread.
  if (mentionedBots.length) {
    await c.botMentions.insertMany(
      mentionedBots.map((botId) => ({ _id: new ObjectId(), orgId: actor.orgId, botId, taskId, commentId: doc._id, createdAt: doc.createdAt, deliveredAt: null })),
    );
  }
  const item = toFeed(doc);
  await publish(actor.orgId.toHexString(), { type: "feed.add", actorId: actor.id.toHexString(), taskId: taskId.toHexString(), item });
  if (mentionedPeople.length) {
    const snippet = text.replace(/<@[a-f0-9]{24}>\s*/g, "").replace(/\s+/g, " ").trim();
    await notify(actor.orgId, mentionedPeople, { kind: "mentioned", taskId, actorId: actor.id, commentId: doc._id, detail: snippet.length > 140 ? `${snippet.slice(0, 139)}…` : snippet || null });
  }
  if (mentionedBots.length) {
    const project = await c.projects.findOne({ _id: target.projectId }, { projection: { key: 1 } });
    wakeBots(actor.orgId, mentionedBots, { kind: "mentioned", taskId, commentId: doc._id, taskKey: `${project?.key ?? "?"}-${target.number}`, title: target.title, by: await actorName(actor) });
  }
  return item;
}
