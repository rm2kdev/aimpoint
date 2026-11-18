import "server-only";
import { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { UserError } from "@/lib/result";
import { publish } from "@/lib/realtime/server";
import { findTaskByKey, sanitizeDescription, toFeed, toTask, withWorkingBots } from "@/lib/data";
import { rankBetween } from "@/lib/rank";
import { loadStatuses, requireProjectStatus, statusFor, statusInProject } from "@/lib/statuses";
import { publishWorking } from "@/lib/claims";
import { newTaskStatusFor } from "@/lib/project-defaults";
import { ASSIGNEE_FIELDS, CLOSE_OUT_FIELDS, TRIAGE_FIELDS, closeOutStatuses, taskAccess } from "@/lib/access";
import { signalStop, wakeBots, wakeTriage } from "@/lib/bot-dispatch";
import { backlogMove, parkRelease, unparkWakes, writeHandOff, type BacklogMove } from "@/lib/backlog-moves";
import { notify } from "@/lib/notifications";
import { checkDependencies, dependencyChanged, detachDeleted, handOffReady, openDependencies, recordCloseout, reopenForHandOff, resolveCloseout, taskKeys, type By } from "@/lib/dependencies";
import { isParked, planFlowForCreate, planFlowForUpdate, pickupTarget, reopenForNextStep, type FlowActivity, type FlowHandoff, type FlowPlan } from "@/lib/flow-engine";
import { isClosedCategory, isTaskType, type ActivityDoc, type ActivityNote, type FeedItem, type Priority, type StatusCategory, type StatusDoc, type Task, type TaskDoc, type TaskSourceDoc, type TaskType, type ProjectFormDoc } from "@/lib/types";
import { requireFormDestination } from "@/lib/project-forms";
import { plainTextToHtml as plainToHtml } from "@/lib/form-fields-core";
import { assertNotStopped } from "@/lib/stop-guard";

/**
 * Task writes shared by the web app (server actions) and the bot API.
 * An actor is a signed-in user or a bot; bots are never admins.
 */
export interface Actor {
  orgId: ObjectId;
  id: ObjectId;
  isAdmin: boolean;
  isBot?: boolean;
  /** Display name when the actor is neither a user nor a bot (an external form, VEC-205). */
  name?: string;
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

/**
 * The task changed owner away from a bot (a person's reassign, a status drag that crosses a flow step, a flow advance
 * by someone else): that bot isn't working on it any more, so its pick-up is finished like complete_task would
 * (VEC-180). Marked done rather than deleted: it no longer counts as working (ring, tray, stillInProgress), Stalled
 * only looks at the current assignee's claim, and resetClaimOnAssign drops it if the task comes back to this bot.
 * Runs before the task.upsert, which then carries only the new owner as working. Triage claims are left alone.
 */
async function finishClaimOnUnassign(taskId: ObjectId, from: ObjectId | null, to: ObjectId | null) {
  if (!from || (to && from.equals(to))) return;
  const c = await cols();
  await c.agentClaims.updateMany({ taskId, botId: from, state: "in_progress", kind: { $ne: "triage" } }, { $set: { state: "done", finishedAt: new Date() } });
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
  // The task's own project's closing statuses (VEC-115).
  const closing = closeOutStatuses(await loadStatuses(actor.orgId, task.projectId));
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

/**
 * Stages a bot's pickup moves out of. Triage, done and cancelled tasks are never touched, and neither is a parked
 * backlog task (VEC-274): only a flow step that explicitly owns a Backlog status (pickupTarget "move") starts one.
 */
const STARTABLE = new Set<StatusCategory>(["unstarted", "started"]);

/**
 * A bot took a (non-triage) in-progress claim on a task: the status follows the work. Moves it to the
 * first started-stage status in workflow order (In Progress by default) when it's in a backlog/unstarted
 * status or in another started status (e.g. In Review). Records the move as the bot's activity and
 * broadcasts the task. Returns true when it moved; the caller can then skip its own working-state publish,
 * since this upsert carries the claim too.
 */
export async function markStartedByBot(orgId: ObjectId, botId: ObjectId, taskId: ObjectId, note: ActivityNote = "started_work"): Promise<boolean> {
  try {
    const c = await cols();
    const task = await c.tasks.findOne({ _id: taskId, orgId }, { projection: { statusId: 1, projectId: 1, orgId: 1, flow: 1 } });
    if (!task) return false;
    // The task's own project's workflow (VEC-114).
    const statuses = await c.statuses.find({ orgId, projectId: task.projectId }, { projection: { category: 1, order: 1 } }).sort({ order: 1 }).toArray();
    // On a flow step (VEC-175) pickup stays within the step: a Todo step goes to its working status (a started status
    // no later step uses), a step that already sits in a started status (the tester's In Review) isn't moved at all.
    const flowPick = await pickupTarget(task);
    if (flowPick.kind === "stay") return false;
    const target = flowPick.kind === "move" ? statuses.find((s) => s._id.equals(flowPick.statusId)) : statuses.find((s) => s.category === "started");
    const current = statuses.find((s) => s._id.equals(task.statusId));
    const startable = STARTABLE.has(current?.category as StatusCategory) || (flowPick.kind === "move" && current?.category === "backlog");
    if (!target || !current || current._id.equals(target._id) || !startable) return false;
    const now = new Date();
    // Conditional on the status we read, so a concurrent move by a person wins.
    const after = await c.tasks.findOneAndUpdate({ _id: taskId, orgId, statusId: current._id }, { $set: { statusId: target._id, updatedAt: now } }, { returnDocument: "after" });
    if (!after) return false;
    const act: ActivityDoc = { _id: new ObjectId(), orgId, taskId, actorId: botId, kind: "status", from: current._id.toHexString(), to: target._id.toHexString(), note, createdAt: now };
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
 * Whether an @mention of `botId` on this task hands the work back to it: the bot is the assignee and the
 * task is open (not archived, not in a triage, done or cancelled status) and ready (nothing it waits on). Mentions of any other bot are a
 * question, not a hand-over. Used for the wake-up wording before delivery and by resumeOnMention after it.
 */
export async function mentionResumesWork(orgId: ObjectId, botId: ObjectId, taskId: ObjectId): Promise<boolean> {
  const c = await cols();
  const task = await c.tasks.findOne({ _id: taskId, orgId }, { projection: { assigneeId: 1, statusId: 1, archivedAt: 1, waitingOn: 1, stopped: 1, flow: 1, projectId: 1 } });
  // Stopped by a person (VEC-215): a mention is a question until they resume it.
  if (task?.stopped) return false;
  // Still waiting on dependencies: it isn't ready, so a mention can't start work on it (the ready hand-off will).
  if (!task || task.archivedAt || task.waitingOn?.length || !task.assigneeId?.equals(botId)) return false;
  const st = await c.statuses.findOne({ _id: task.statusId, orgId }, { projection: { category: 1 } });
  if (!st || st.category === "triage" || isClosedCategory(st.category)) return false;
  // Parked in Backlog (VEC-274): a mention is a question, not a hand-over.
  return !(await isParked({ orgId, projectId: task.projectId, statusId: task.statusId, flow: task.flow }, st.category));
}

/**
 * An @mention reached the task's assigned bot (push delivery or check_for_work): it's working on the task
 * again. Reopens its claim to in_progress (a finished one, or a fresh one if it never picked the task up),
 * moves In Review / Todo back to In Progress via markStartedByBot, and broadcasts, so the working ring shows
 * and the derived Stalled state clears live (publish recomputes `stalled` along with `workingBotIds`).
 * Returns true when the bot is now working on it; false for a non-assignee bot or a closed task.
 */
export async function resumeOnMention(orgId: ObjectId, botId: ObjectId, taskId: ObjectId): Promise<boolean> {
  try {
    if (!(await mentionResumesWork(orgId, botId, taskId))) return false;
    const c = await cols();
    const now = new Date();
    const claim = await c.agentClaims.findOne({ botId, taskId });
    if (claim?.kind === "triage") return false; // it's triaging, not working, on this task
    let changed = false;
    if (!claim) {
      try {
        await c.agentClaims.insertOne({ _id: new ObjectId(), orgId, botId, taskId, state: "in_progress", claimedAt: now, finishedAt: null });
        changed = true;
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) throw err; // a concurrent pickup took it: already working
      }
    } else if (claim.state !== "in_progress") {
      const res = await c.agentClaims.updateOne({ _id: claim._id, state: claim.state }, { $set: { state: "in_progress", claimedAt: now, finishedAt: null } });
      changed = res.modifiedCount > 0;
    }
    // The move's upsert carries the reopened claim (and the cleared stall); otherwise publish the claim alone.
    const moved = await markStartedByBot(orgId, botId, taskId, "resumed_work");
    if (changed && !moved) await publishWorking(orgId, botId, [taskId]);
    return true;
  } catch (err) {
    console.error("[tasks] resumeOnMention failed", err);
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
  if (actor.name) return actor.name;
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
async function announceAssignment(actor: Actor, task: TaskDoc, key: string, handoff?: FlowHandoff) {
  const assigneeId = task.assigneeId;
  if (!assigneeId) return;
  const self = assigneeId.equals(actor.id);
  if (self && !actor.isBot) return;
  const c = await cols();
  const isBot = !!(await c.bots.findOne({ orgId: actor.orgId, _id: assigneeId }, { projection: { _id: 1 } }));
  const waiting = task.waitingOn ?? [];
  if (isBot) {
    // A closed task is no work: check_for_work never hands it out, so push doesn't wake for it either.
    if (task.archivedAt || (await isClosedTask(task))) return;
    // Parked in Backlog (VEC-274): the assignee is recorded only. Moving it to a not-started status hands it over.
    if (await isParked(task)) return;
    if (self && (await c.agentClaims.findOne({ botId: assigneeId, taskId: task._id, state: "in_progress" }, { projection: { _id: 1 } }))) return;
    if (!waiting.length) {
      wakeBots(actor.orgId, [assigneeId], {
        kind: "assigned",
        taskId: task._id,
        taskKey: key,
        title: task.title,
        by: await actorName(actor),
        ...(handoff ? { handoff: { fromStep: handoff.fromStep, toStep: handoff.toStep } } : {}),
      });
    }
    return;
  }
  const keys = waiting.length ? await taskKeys(actor.orgId, waiting) : new Map<string, string>();
  const parts = [
    handoff ? `${handoff.toStep} step is yours${handoff.fromStep ? ` (after ${handoff.fromStep})` : ""}` : "",
    waiting.length ? `Waiting on ${waiting.map((id) => keys.get(id.toHexString()) ?? "another task").join(", ")}` : "",
  ].filter(Boolean);
  await notify(actor.orgId, [assigneeId], { kind: "assigned", taskId: task._id, actorId: actor.id, detail: parts.length ? parts.join(". ") : null });
}

/**
 * A task assigned to a bot was unparked (VEC-274/275): it left Backlog, so the bot assigned while it sat there is
 * handed it now with the same `assigned` wake-up as a fresh assignment (once: writeHandOff picks one hand-off per
 * write). Nothing while it still waits on dependencies (the ready hand-off releases it later), is stopped, archived
 * or closed, or when the bot already holds a claim (a flow step that owned the Backlog status handed it over).
 */
async function announceUnparked(actor: Actor, task: TaskDoc, key: string) {
  if (!task.assigneeId) return;
  const c = await cols();
  const [bot, claim, status] = await Promise.all([
    c.bots.findOne({ orgId: actor.orgId, _id: task.assigneeId }, { projection: { _id: 1 } }),
    c.agentClaims.findOne({ botId: task.assigneeId, taskId: task._id }, { projection: { _id: 1 } }),
    c.statuses.findOne({ _id: task.statusId }, { projection: { category: 1 } }),
  ]);
  const wakes = unparkWakes({
    assigneeIsBot: !!bot,
    assigneeHasClaim: !!claim,
    archived: !!task.archivedAt,
    stage: status?.category ?? null,
    waiting: (task.waitingOn ?? []).length > 0,
    stopped: !!task.stopped,
    parked: await isParked(task, status?.category ?? null),
  });
  if (wakes) await announceAssignment(actor, task, key);
}

/**
 * The write parked the task (moved it into Backlog, VEC-275): it isn't work any more, so the bots working on it are
 * released and told to stop through the Stop path's signal (a Hermes run is cancelled, a webhook bot gets
 * task.stopped with `parked`), except a bot that parked it itself. Their non-triage claims are deleted, so a later
 * move out of Backlog hands it over afresh, and queued work wake-ups are dropped. A stopped task is left to Resume.
 * Runs before the task.upsert, which then carries the cleared working ring. Returns the stop signals to send after it.
 */
async function releaseParked(actor: Actor, task: TaskDoc): Promise<{ botId: ObjectId; runIds: string[] }[]> {
  const c = await cols();
  const claims = await c.agentClaims.find({ taskId: task._id }).toArray();
  const { release, signal } = parkRelease(
    claims.map((cl) => ({ id: cl._id.toHexString(), botId: cl.botId.toHexString(), kind: cl.kind ?? null, state: cl.state })),
    { actorId: actor.id.toHexString(), stopped: !!task.stopped },
  );
  if (!release.length) return [];
  const out = signal.map((b) => ({ botId: new ObjectId(b), runIds: [...new Set(claims.filter((cl) => cl.botId.toHexString() === b && typeof cl.runId === "string").map((cl) => cl.runId!))] }));
  await c.agentClaims.deleteMany({ _id: { $in: release.map((id) => new ObjectId(id)) } });
  await c.botWakes.deleteMany({ taskId: task._id, kind: { $in: ["assigned", "ready"] } });
  return out;
}

/** The flow_step activity doc for a flow move (VEC-175). */
const flowActivityDoc = (actor: Actor, taskId: ObjectId, a: FlowActivity, at: Date): ActivityDoc => ({
  _id: new ObjectId(),
  orgId: actor.orgId,
  taskId,
  actorId: actor.id,
  kind: "flow_step",
  from: a.from,
  to: a.to,
  note: a.note,
  flowStatus: a.status,
  flowOwner: a.owner,
  createdAt: at,
});

/**
 * A flow step handed the task to the owner who already had it (the same bot or person owns consecutive steps): no
 * assignee change, so announceAssignment never runs. A bot is woken again for the new step (its finished claim was
 * dropped before the broadcast, reopenForNextStep); a person is notified.
 */
async function handOverSameOwner(actor: Actor, task: TaskDoc, key: string, handoff: FlowHandoff) {
  if (!handoff.sameOwner || !task.assigneeId?.equals(handoff.ownerId)) return;
  if (handoff.ownerKind === "bot") {
    if (task.archivedAt || (task.waitingOn ?? []).length || (await isClosedTask(task)) || (await isParked(task))) return;
    wakeBots(actor.orgId, [handoff.ownerId], { kind: "assigned", taskId: task._id, taskKey: key, title: task.title, by: await actorName(actor), handoff: { fromStep: handoff.fromStep, toStep: handoff.toStep } });
    return;
  }
  if (handoff.ownerId.equals(actor.id)) return;
  await notify(actor.orgId, [handoff.ownerId], { kind: "assigned", taskId: task._id, actorId: actor.id, detail: `${handoff.toStep} step is yours${handoff.fromStep ? ` (after ${handoff.fromStep})` : ""}` });
}

/** The task's status is done or cancelled. */
async function isClosedTask(task: Pick<TaskDoc, "statusId">) {
  const c = await cols();
  const st = await c.statuses.findOne({ _id: task.statusId }, { projection: { category: 1 } });
  return isClosedCategory(st?.category);
}

/**
 * The task was just closed (done or cancelled): any bot still working on it as assignee has nothing left
 * to do, so its claim is finished like complete_task would. Runs before the task.upsert broadcast, which
 * then carries the cleared working ring. Triage claims are left for complete_task / release_task.
 */
async function finishClaimsOnClose(orgId: ObjectId, taskId: ObjectId) {
  const c = await cols();
  const now = new Date();
  const filter = { taskId, state: "in_progress" as const, kind: { $ne: "triage" as const } };
  await c.agentClaims.updateMany(filter, { $set: { state: "done", finishedAt: now } });
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

/** Internal create options no client input may set: provenance of a form submission (createTaskFromForm). */
interface CreateInternal {
  source?: TaskSourceDoc;
  /** Note and `to` on the "created" activity entry. */
  createdNote?: { note: ActivityNote; to: string };
}

export async function createTaskAs(actor: Actor, input: NewTaskInput, internal: CreateInternal = {}): Promise<Task> {
  const title = (input.title ?? "").trim();
  if (!title) throw new UserError("Give the task a title.");
  // A bot whose work a person stopped can't link new tasks to that task (VEC-216).
  await assertNotStopped(actor, input.dependsOn ?? []);
  if (title.length > 300) throw new UserError("Keep titles under 300 characters.");
  const c = await cols();
  const projectId = oid(input.projectId, "project");
  const project = await c.projects.findOneAndUpdate(
    { _id: projectId, orgId: actor.orgId, archivedAt: null },
    { $inc: { nextNumber: 1 } },
    { returnDocument: "before" },
  );
  if (!project) throw new UserError(await missingProjectReason(projectId, actor.orgId, "Pick a project."));
  // A status of the new task's own project (VEC-115): the given one must be one of them (another project's is
  // refused). Without one, a person's task starts in the project's own override (VEC-190), else the project's
  // first status of the org's default stage (VEC-128, preset Triage), else its first not-started one
  // (lib/project-defaults newTaskStatusFor). Bots/REST/MCP without a status keep the first not-started one.
  const status = input.statusId
    ? await requireProjectStatus(actor.orgId, projectId, oid(input.statusId, "status").toHexString())
    : ((!actor.isBot ? (await newTaskStatusFor(actor.orgId, projectId, project)).status : null) ??
      (await statusFor(actor.orgId, projectId, "unstarted")) ??
      (await c.statuses.find({ orgId: actor.orgId, projectId }).sort({ order: 1 }).limit(1).next()));
  if (!status) throw new UserError("Pick a status.");
  let assigneeId: ObjectId | null = null;
  if (input.assigneeId) {
    assigneeId = oid(input.assigneeId, "assignee");
    await assertAssignable(actor.orgId, assigneeId);
  }
  const dependsOn = input.dependsOn?.length ? await checkDependencies(actor.orgId, null, parseIds(input.dependsOn, "`dependsOn`")) : [];
  const waitingOn = await openDependencies(actor.orgId, dependsOn);
  // It enters its project's flow at the step of its status; that step's owner applies unless an assignee was given (VEC-175).
  const flowPlan = await planFlowForCreate(actor.orgId, projectId, status, !!assigneeId);
  if (flowPlan.assigneeId) assigneeId = flowPlan.assigneeId;
  const now = new Date();
  const priority = input.priority ?? 0;
  const rank = await topRank(actor.orgId);
  const doc: TaskDoc = {
    _id: new ObjectId(),
    orgId: actor.orgId,
    projectId,
    number: project.nextNumber,
    title,
    description: sanitizeDescription(input.description ?? ""),
    type: isTaskType(input.type) ? input.type : "issue",
    statusId: status._id,
    assigneeId,
    priority: ([0, 1, 2, 3] as const).includes(priority) ? priority : 0,
    dueDate: input.dueDate ? parseDueDate(input.dueDate) : null,
    archivedAt: null,
    archivedBy: null,
    dependsOn,
    waitingOn,
    rank,
    ...(flowPlan.flow !== undefined ? { flow: flowPlan.flow } : {}),
    ...(internal.source ? { source: internal.source } : {}),
    createdBy: actor.id,
    createdAt: now,
    updatedAt: now,
  };
  await c.tasks.insertOne(doc);
  await c.activity.insertOne({ _id: new ObjectId(), orgId: actor.orgId, taskId: doc._id, actorId: actor.id, kind: "created", ...(internal.createdNote ?? {}), createdAt: now });
  if (flowPlan.activity) await c.activity.insertOne(flowActivityDoc(actor, doc._id, flowPlan.activity, now));
  const task = toTask(doc, project.key);
  await publish(actor.orgId.toHexString(), { type: "task.upsert", actorId: actor.id.toHexString(), task });
  await announceAssignment(actor, doc, task.key, flowPlan.handoff);
  if (status.category === "triage") await enterTriage(actor, doc, task.key);
  // A bot creating a task for itself that waits on unowned work takes that work too (VEC-107).
  if (waitingOn.length) ownedBlockers.set(task, await ownUnownedBlockers(actor, doc._id));
  // The tasks it depends on just gained a waiter: their derived Stalled / needs-owner state may have changed.
  // Only after taking ownership above, or this broadcast shows a blocker the bot is about to own as unassigned
  // Stalled and syncStalledNotice sends a false "nobody is assigned" notice (VEC-111).
  if (dependsOn.length) await publishWorking(actor.orgId, actor.id, dependsOn);
  return task;
}

/** What a person submits through an external form (VEC-205). `description` is plain text. */
export interface FormSubmission {
  title: string;
  description?: string;
  /**
   * A rich-text form's description (VEC-234), already through `publicSanitize` with only this form's own uploads as
   * image sources (lib/form-submit.ts). Used instead of `description` when set; createTaskAs sanitises it once more.
   */
  descriptionHtml?: string | null;
  /** Only used by a "choose" form, and only when it's one of the form's allowed types. Ignored by a fixed form. */
  type?: string | null;
  submitterName?: string | null;
  submitterEmail?: string | null;
}

export const FORM_DESCRIPTION_MAX = 10_000;
export const FORM_SUBMITTER_NAME_MAX = 100;
export const FORM_SUBMITTER_EMAIL_MAX = 200;

/**
 * A submission through an external form becomes a task in the form's project, in the form's destination status and
 * with its type (the submitted type only for a "choose" form, and only one it allows). The task records where it came
 * from (`source`), its creator is the form (`createdBy` = form id, so only admins can edit it), the activity reads
 * "created" with note "form" and the form's name, and the normal create path runs: task.upsert, flow owner wake-ups,
 * and a Triage destination reaches the triage bots like any new triage task. Re-reads the form so a form disabled or
 * deleted since the caller loaded it takes nothing. Throws UserError on bad input.
 */
export async function createTaskFromForm(form: Pick<ProjectFormDoc, "_id" | "orgId">, input: FormSubmission): Promise<Task> {
  const c = await cols();
  const live = await c.projectForms.findOne({ _id: form._id, orgId: form.orgId });
  if (!live || !live.enabled) throw new UserError("This form isn't taking submissions.");
  const title = String(input.title ?? "").trim();
  if (!title) throw new UserError("Give it a title.");
  const description = String(input.description ?? "").replace(/\r\n?/g, "\n");
  const html = typeof input.descriptionHtml === "string" ? input.descriptionHtml : null;
  if (html === null && description.length > FORM_DESCRIPTION_MAX) throw new UserError(`Keep the description under ${FORM_DESCRIPTION_MAX.toLocaleString()} characters.`);
  let type: TaskType = live.type;
  if (live.typeMode === "choose" && input.type !== undefined && input.type !== null && input.type !== "") {
    if (!isTaskType(input.type) || !live.allowedTypes.includes(input.type)) throw new UserError(`Pick one of: ${live.allowedTypes.join(", ")}.`);
    type = input.type;
  }
  const submitterName = String(input.submitterName ?? "").trim() || null;
  if (submitterName && submitterName.length > FORM_SUBMITTER_NAME_MAX) throw new UserError(`Keep your name under ${FORM_SUBMITTER_NAME_MAX} characters.`);
  const submitterEmail = String(input.submitterEmail ?? "").trim().toLowerCase() || null;
  if (submitterEmail && (submitterEmail.length > FORM_SUBMITTER_EMAIL_MAX || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(submitterEmail))) {
    throw new UserError("That email address doesn't look right.");
  }
  // The destination is re-checked: one of the project's own statuses, still in an allowed stage.
  const status = await requireFormDestination(live.orgId, live.projectId, live.destinationStatusId.toHexString());
  const actor: Actor = { orgId: live.orgId, id: live._id, isAdmin: false, isBot: false, name: live.name };
  return createTaskAs(
    actor,
    { title, projectId: live.projectId.toHexString(), type, statusId: status._id.toHexString(), description: html ?? plainToHtml(description) },
    {
      source: { kind: "form", formId: live._id, formName: live.name, submitterName, submitterEmail },
      createdNote: { note: "form", to: live.name },
    },
  );
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

/**
 * `internal` carries fields no client patch may set directly: `rank` comes only from moveTask, which computes
 * it from the neighbours itself.
 */
export async function updateTaskAs(
  actor: Actor,
  taskId: ObjectId,
  patch: TaskPatch,
  internal: { rank?: string; flowTo?: string; /** advance_task resolving a wait step (VEC-176): the caller already checked the bot may. */ flowResolver?: boolean } = {},
): Promise<Task> {
  const c = await cols();
  const before = await c.tasks.findOne({ _id: taskId, orgId: actor.orgId });
  if (!before) throw new UserError("This task no longer exists.");
  // The stopped bot's writes on a stopped task, or linking another task to it, are refused (VEC-216).
  await assertNotStopped(actor, [taskId, ...(patch.dependsOn ?? [])]);
  const access = taskAccess(
    { createdBy: before.createdBy.toHexString(), assigneeId: before.assigneeId?.toHexString() ?? null },
    actor.id.toHexString(),
    actor.isAdmin,
  );
  // A wait step's resolver (advance_task) moves only the task's flow on, nothing else, whatever its access.
  const resolving = !!internal.flowResolver && !!internal.flowTo && Object.keys(patch).every((k) => k === "statusId" || patch[k as keyof TaskPatch] === undefined);
  if (access !== "full" && !resolving) {
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
    set.type = isTaskType(patch.type) ? patch.type : "issue";
    acts.push({ kind: "type", from: before.type, to: set.type });
  }
  if (patch.priority !== undefined && patch.priority !== before.priority) {
    if (![0, 1, 2, 3].includes(patch.priority)) throw new UserError("Priority is 0 (none) to 3 (high).");
    set.priority = patch.priority;
    acts.push({ kind: "priority", from: String(before.priority), to: String(patch.priority) });
  }
  let doneChanged = false;
  let closed = false;
  let enteredTriage = false;
  // Statuses belong to the task's project (VEC-115): the status must be one of the destination project's
  // (the task's own unless it moves too). Another project's status is refused, never mapped. Its current status
  // sent along with a project move means "keep it": mapped below like a move without a status.
  const destProjectId = patch.projectId && ObjectId.isValid(patch.projectId) ? new ObjectId(patch.projectId) : before.projectId;
  const statusChanges = !!patch.statusId && patch.statusId !== before.statusId.toHexString();
  const s = statusChanges ? await requireProjectStatus(actor.orgId, destProjectId, oid(patch.statusId!, "status").toHexString()) : null;
  // The task's status after this write, for the flow engine (VEC-175).
  let finalStatus: StatusDoc | null = s;
  if (s && !s._id.equals(before.statusId)) {
    set.statusId = s._id;
    acts.push({ kind: "status", from: before.statusId.toHexString(), to: s._id.toHexString() });
    const prev = await c.statuses.findOne({ _id: before.statusId }, { projection: { category: 1 } });
    // Closing (done or cancelled) or reopening it releases or re-blocks its dependents.
    doneChanged = isClosedCategory(prev?.category) !== isClosedCategory(s.category);
    closed = doneChanged && isClosedCategory(s.category);
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
    // Keep the status in the destination project's workflow: same name and stage, else same stage (VEC-114).
    if (!set.statusId) {
      const mapped = await statusInProject(actor.orgId, p._id, before.statusId);
      if (!mapped) throw new UserError(`${p.key} has no statuses to move this task into.`);
      if (!mapped._id.equals(before.statusId)) set.statusId = mapped._id;
      finalStatus = mapped;
    }
    acts.push({ kind: "project", from: before.projectId.toHexString(), to: p._id.toHexString() });
  }
  // A reorder alone writes no activity, only the new rank.
  if (internal.rank !== undefined && internal.rank !== before.rank) set.rank = internal.rank;

  // The flow (VEC-175): a status change re-positions the task (and applies the step's owner unless this write names
  // an assignee), complete_task without a status advances it (internal.flowTo), an assignee-only edit is an override.
  let flowPlan: FlowPlan = {};
  if (set.statusId || set.projectId || internal.flowTo || set.assigneeId !== undefined) {
    finalStatus ??= await c.statuses.findOne({ _id: set.statusId ?? before.statusId });
    if (finalStatus) {
      flowPlan = await planFlowForUpdate({
        actor,
        before,
        projectId: set.projectId ?? before.projectId,
        status: finalStatus,
        statusChanged: !!set.statusId && !set.statusId.equals(before.statusId),
        projectMoved: !!set.projectId,
        explicitAssignee: set.assigneeId !== undefined,
        assigneeAfter: set.assigneeId !== undefined ? set.assigneeId : (before.assigneeId ?? null),
        waitingAfter: set.waitingOn ?? before.waitingOn ?? [],
        advanceTo: internal.flowTo,
        isTriaging: () => isTriaging(actor.id, taskId),
      });
    }
    if (flowPlan.flow !== undefined) set.flow = flowPlan.flow;
    if (flowPlan.assigneeId !== undefined) {
      set.assigneeId = flowPlan.assigneeId;
      acts.push({ kind: "assignee", from: before.assigneeId?.toHexString() ?? null, to: flowPlan.assigneeId?.toHexString() ?? null });
    }
    if (flowPlan.activity) {
      const a = flowPlan.activity;
      acts.push({ kind: "flow_step", from: a.from, to: a.to, note: a.note, flowStatus: a.status, flowOwner: a.owner });
    }
  }

  if (!Object.keys(set).length) {
    const p = await c.projects.findOne({ _id: before.projectId });
    return (await withWorkingBots([toTask(before, p?.key ?? "?")]))[0];
  }
  const now = new Date();
  set.updatedAt = now;
  const after = await c.tasks.findOneAndUpdate({ _id: taskId, orgId: actor.orgId }, { $set: set }, { returnDocument: "after" });
  if (!after) throw new UserError("This task no longer exists.");
  // Into or out of Backlog (VEC-274/275): parked tasks aren't work. Parking releases the bots working on it (before
  // the unassign step finishes an old assignee's claim, so that bot is told to stop too) and before the upsert.
  const move: BacklogMove =
    set.statusId || set.flow !== undefined || set.projectId ? backlogMove(await isParked(before), await isParked(after)) : null;
  const stops = move === "park" ? await releaseParked(actor, after) : [];
  if (set.assigneeId !== undefined) {
    await finishClaimOnUnassign(taskId, before.assigneeId ?? null, set.assigneeId);
    await resetClaimOnAssign(taskId, set.assigneeId);
  }
  // The same bot owns the next step too: drop its finished claim before the broadcast, so it's handed the task afresh.
  if (flowPlan.handoff?.sameOwner && flowPlan.handoff.ownerKind === "bot") await reopenForNextStep(taskId, flowPlan.handoff.ownerId);
  if (closed) await finishClaimsOnClose(actor.orgId, taskId);
  // Removing its last open dependency makes it ready: hand it back to a bot that had parked it (before the upsert).
  const nowReady = !!set.waitingOn && (before.waitingOn ?? []).length > 0 && !set.waitingOn.length;
  if (nowReady && set.assigneeId === undefined) await reopenForHandOff(actor.orgId, after);
  // Its triager's close-out is recorded before the upsert too, so the broadcast never shows it "finished" Stalled (VEC-89).
  const closer = nowReady && set.assigneeId === undefined ? await recordCloseout(actor.orgId, after) : undefined;
  // The triager moving its status is it handling the close-out: no longer pending (VEC-89).
  if (set.statusId && actor.isBot) await resolveCloseout(taskId, actor.id);
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

  for (const stop of stops) signalStop(actor.orgId, { taskId, botId: stop.botId, taskKey: task.key, title: after.title, by: await actorName(actor), work: "assigned", parked: finalStatus?.name ?? "Backlog", runIds: stop.runIds });

  // One hand-off per write (VEC-275), so a status change and an assignee change together wake the bot once.
  const handOff = writeHandOff({ assigneeSet: !!set.assigneeId, sameOwnerHandoff: !!flowPlan.handoff?.sameOwner, nowReady, move });
  if (handOff === "assignment") {
    await announceAssignment(actor, after, task.key, flowPlan.handoff);
  } else if (handOff === "same_owner" && flowPlan.handoff) {
    await handOverSameOwner(actor, after, task.key, flowPlan.handoff);
  } else if (handOff === "ready") {
    // Removing the last open dependency makes it ready, just as finishing it would.
    const keys = await taskKeys(actor.orgId, removedDeps);
    await handOffReady(actor.orgId, byOf(actor), after, task.key, removedDeps.flatMap((id) => keys.get(id.toHexString()) ?? []), "removed", [], closer);
  } else if (handOff === "unpark") {
    // Out of Backlog (VEC-274/275): a bot assigned while it was parked hears about it now.
    await announceUnparked(actor, after, task.key);
  }
  // Closing (or reopening) this task releases (or re-blocks) the tasks that wait for it.
  if (doneChanged) await dependencyChanged(actor.orgId, byOf(actor), [taskId]);
  // The tasks it depends on gained or lost an open waiter: their derived Stalled state may have changed.
  const prevDeps = before.dependsOn ?? [];
  const addedDeps = set.dependsOn ? set.dependsOn.filter((id) => !prevDeps.some((p) => p.equals(id))) : [];
  const upstream = doneChanged || set.archivedAt !== undefined ? [...(after.dependsOn ?? []), ...removedDeps] : [...addedDeps, ...removedDeps];
  if (enteredTriage && !after.archivedAt) await enterTriage(actor, after, task.key);
  // A bot leaving its own task parked behind open dependencies (moved to an open status, or deps added) takes
  // the ones nobody owns, so someone is woken for them (VEC-107).
  if (actor.isBot && after.waitingOn?.length && ((set.statusId && !closed) || addedDeps.length)) {
    ownedBlockers.set(task, await ownUnownedBlockers(actor, taskId));
  }
  // Republished after the ownership step, so no broadcast shows an auto-owned blocker as unassigned Stalled
  // (that would send a false stalled notice, VEC-111).
  if (upstream.length) await publishWorking(actor.orgId, actor.id, upstream);
  return task;
}

/* ---------------- owners for blockers a bot parks its own task behind (VEC-107) ---------------- */

/** Keys of the blockers a write assigned to the acting bot, for the tool / API reply. Keyed by the returned Task. */
const ownedBlockers = new WeakMap<Task, string[]>();

/** Keys of the open, unowned dependencies the write that returned `task` assigned to the acting bot (VEC-107). */
export function assignedBlockersOf(task: Task | null | undefined): string[] {
  return (task && ownedBlockers.get(task)) ?? [];
}

/**
 * A bot left a task it's assigned to waiting on open dependencies (complete_task / set_status to an open status,
 * or depends_on added by update_task / create_task). A blocker nobody owns would sit there with nobody woken, so
 * every open, unarchived dependency with no assignee is assigned to that bot here, through the normal assign
 * steps: activity (note auto_owner, naming the waiting task), task.upsert, then announceAssignment, which wakes
 * the bot now for a blocker that is ready and leaves blocked ones to the ready hand-off. Dependencies that have an
 * assignee are untouched, and so are dependencies still in Triage (a triager breaks those down). Triage umbrellas are
 * exempt: the caller triaging it right now, or the bot that triaged it (it waits on its sub-tasks by design).
 * Returns the keys it assigned.
 */
export async function ownUnownedBlockers(actor: Actor, taskId: ObjectId): Promise<string[]> {
  if (!actor.isBot) return [];
  const c = await cols();
  const task = await c.tasks.findOne({ _id: taskId, orgId: actor.orgId });
  const waiting = task?.waitingOn ?? [];
  if (!task || task.archivedAt || !waiting.length || !task.assigneeId?.equals(actor.id)) return [];
  if (task.triagedBy?.equals(actor.id) || (await isTriaging(actor.id, taskId))) return [];
  const own = await c.statuses.findOne({ _id: task.statusId }, { projection: { category: 1 } });
  if (!own || isClosedCategory(own.category) || own.category === "triage") return [];
  const deps = await c.tasks.find({ _id: { $in: waiting }, orgId: actor.orgId, assigneeId: null, archivedAt: null }).toArray();
  if (!deps.length) return [];
  const statuses = await c.statuses.find({ _id: { $in: deps.map((d) => d.statusId) } }, { projection: { category: 1 } }).toArray();
  const category = new Map(statuses.map((st) => [st._id.toHexString(), st.category]));
  const projects = await c.projects.find({ _id: { $in: [task.projectId, ...deps.map((d) => d.projectId)] } }, { projection: { key: 1 } }).toArray();
  const projectKey = new Map(projects.map((p) => [p._id.toHexString(), p.key]));
  const waiterKey = `${projectKey.get(task.projectId.toHexString()) ?? "?"}-${task.number}`;
  const orgHex = actor.orgId.toHexString();
  const actorHex = actor.id.toHexString();
  const assigned: string[] = [];
  for (const dep of deps) {
    const cat = category.get(dep.statusId.toHexString());
    if (!cat || isClosedCategory(cat) || cat === "triage") continue;
    const now = new Date();
    // Conditional on still having no owner, so a person assigning it at the same moment wins.
    const after = await c.tasks.findOneAndUpdate(
      { _id: dep._id, orgId: actor.orgId, assigneeId: null, archivedAt: null },
      { $set: { assigneeId: actor.id, updatedAt: now } },
      { returnDocument: "after" },
    );
    if (!after) continue;
    await resetClaimOnAssign(dep._id, actor.id);
    const pk = projectKey.get(after.projectId.toHexString()) ?? "?";
    const depTask = toTask(after, pk);
    const act: ActivityDoc = { _id: new ObjectId(), orgId: actor.orgId, taskId: dep._id, actorId: actor.id, kind: "assignee", from: null, to: actorHex, note: "auto_owner", waiter: waiterKey, createdAt: now };
    await c.activity.insertOne(act);
    await publish(orgHex, { type: "task.upsert", actorId: actorHex, task: depTask });
    await publish(orgHex, { type: "feed.add", actorId: actorHex, taskId: dep._id.toHexString(), item: toFeed(act) });
    await announceAssignment(actor, after, depTask.key);
    assigned.push(depTask.key);
  }
  return assigned;
}

/* ---------------- manual order (VEC-57) ---------------- */

/**
 * Rank for a new task: above every task in the organisation, so it's first in its status group in every view
 * (project views and All share one key space). Documented choice: new tasks go to the top.
 */
async function topRank(orgId: ObjectId, exclude?: ObjectId) {
  const c = await cols();
  const first = await c.tasks.find({ orgId, rank: { $type: "string", $gt: "" }, ...(exclude ? { _id: { $ne: exclude } } : {}) }, { projection: { rank: 1 } }).sort({ rank: 1 }).limit(1).next();
  return rankBetween(null, first?.rank ?? null);
}

/** The closest rank above (`dir` -1) or below (`dir` 1) `rank` in the organisation, skipping the moving task. */
async function neighbourRank(orgId: ObjectId, rank: string, dir: 1 | -1, exclude: ObjectId) {
  const c = await cols();
  const n = await c.tasks
    .find({ orgId, _id: { $ne: exclude }, rank: dir === 1 ? { $gt: rank } : { $lt: rank, $gt: "" } }, { projection: { rank: 1 } })
    .sort({ rank: dir })
    .limit(1)
    .next();
  return n?.rank ?? null;
}

export interface MoveInput {
  /** Key of the task the moved one should sit directly above (e.g. "VEC-12"). */
  beforeKey?: string | null;
  /** Key of the task the moved one should sit directly below. */
  afterKey?: string | null;
  /** Status id to move it into, in the same write. */
  status?: string | null;
  /** Project id to move it into, in the same write (the task gets a new key there). */
  project?: string | null;
  /**
   * Without neighbours: put it above every other unarchived task of its (new) status in its (new) project,
   * e.g. a task dropped straight onto a sidebar project row (VEC-61).
   */
  toTop?: boolean;
}

/**
 * Drag-to-reorder write (VEC-57): put `taskKey` between its new neighbours and optionally change its status
 * and/or project, in one update and one `task.upsert`. Neighbours are given by key; with only one of them the
 * other side is that task's org-wide neighbour, so the task lands directly next to it in every view. Without
 * either it keeps its rank. Only the creator or an admin may move a task (canEditTask); status and project
 * follow updateTaskAs's rules (archived project refused, new key on a project move, activity for status and
 * project, none for a pure reorder).
 */
export async function moveTask(actor: Actor, taskKey: string, input: MoveInput): Promise<Task> {
  const found = await findTaskByKey(actor.orgId, String(taskKey ?? ""));
  if (!found || !found.task.orgId.equals(actor.orgId)) throw new UserError(`Unknown task "${taskKey}".`);
  const task = found.task;
  await assertNotStopped(actor, [task._id]); // VEC-216
  if (!canEditTask(task, actor.id, actor.isAdmin)) throw new UserError("Only the task's creator or an admin can move it.");

  const neighbour = async (key: string | null | undefined, side: string) => {
    if (!key) return null;
    const n = await findTaskByKey(actor.orgId, String(key));
    if (!n) throw new UserError(`Unknown task "${key}" for \`${side}\`.`);
    if (n.task._id.equals(task._id)) throw new UserError(`A task can't move ${side === "beforeKey" ? "before" : "after"} itself.`);
    if (!n.task.rank) throw new UserError(`${key} has no position yet. Reload and try again.`);
    return n.task.rank;
  };
  const below = await neighbour(input.beforeKey, "beforeKey"); // the task it goes above
  const above = await neighbour(input.afterKey, "afterKey"); // the task it goes below

  let rank: string | undefined;
  if (above !== null && below !== null && above < below) {
    rank = rankBetween(above, below);
  } else if (above !== null) {
    // Directly below `above` (also the fallback when a stale client sent neighbours out of order).
    rank = rankBetween(above, await neighbourRank(actor.orgId, above, 1, task._id));
  } else if (below !== null) {
    rank = rankBetween(await neighbourRank(actor.orgId, below, -1, task._id), below);
  } else if (input.toTop) {
    const groupProject = input.project && ObjectId.isValid(String(input.project)) ? new ObjectId(String(input.project)) : task.projectId;
    const groupStatus = input.status && ObjectId.isValid(String(input.status)) ? new ObjectId(String(input.status)) : task.statusId;
    const c = await cols();
    const first = await c.tasks
      .find(
        { orgId: actor.orgId, projectId: groupProject, statusId: groupStatus, archivedAt: null, _id: { $ne: task._id }, rank: { $type: "string", $gt: "" } },
        { projection: { rank: 1 } },
      )
      .sort({ rank: 1 })
      .limit(1)
      .next();
    if (first?.rank) rank = rankBetween(await neighbourRank(actor.orgId, first.rank, -1, task._id), first.rank);
    else rank = task.rank || (await topRank(actor.orgId, task._id)); // alone in that group: already the top
  } else if (!task.rank) {
    rank = await topRank(actor.orgId, task._id);
  }

  const statusId = input.status ? String(input.status) : undefined;
  const projectId = input.project ? String(input.project) : undefined;
  if (rank === undefined && !statusId && !projectId) throw new UserError("Say where to move it: a task to go before or after, a status or a project.");
  return updateTaskAs(actor, task._id, { statusId, projectId }, { rank });
}

export async function deleteTaskAs(actor: Actor, taskId: ObjectId) {
  const c = await cols();
  const t = await c.tasks.findOne({ _id: taskId, orgId: actor.orgId });
  if (!t) return;
  await assertNotStopped(actor, [taskId]); // VEC-216
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
  // The tasks it depended on lost a waiter: their derived Stalled state may have cleared.
  if (t.dependsOn?.length) await publishWorking(actor.orgId, actor.id, t.dependsOn);
}

export async function addCommentAs(actor: Actor, taskId: ObjectId, body: string): Promise<FeedItem> {
  const text = String(body ?? "").trim();
  if (!text) throw new UserError("Write something first.");
  if (text.length > 10_000) throw new UserError("Comments are limited to 10,000 characters.");
  const c = await cols();
  const target = await c.tasks.findOne({ _id: taskId, orgId: actor.orgId }, { projection: { _id: 1, projectId: 1, number: 1, title: 1 } });
  if (!target) throw new UserError("This task no longer exists.");
  // A stopped bot may only answer a mention made after the stop (VEC-216).
  await assertNotStopped(actor, [taskId], { reply: true });
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
