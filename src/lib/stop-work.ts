import "server-only";
import { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { UserError } from "@/lib/result";
import { publish } from "@/lib/realtime/server";
import { toFeed, toTask, withWorkingBots } from "@/lib/data";
import { isPush } from "@/lib/bot-connect";
import { signalStop, wakeBots, wakeTriage } from "@/lib/bot-dispatch";
import { disabledResumeNote, isBotEnabled } from "@/lib/bot-enabled";
import { loadTaskFlow } from "@/lib/flow-engine";
import { flowPauseState } from "@/lib/flow-actions";
import type { Actor } from "@/lib/task-service";
import {
  isClosedCategory,
  type ActivityDoc,
  type ActivityNote,
  type BotDoc,
  type ResumeOutcome,
  type Task,
  type TaskDoc,
  type TaskFlowState,
  type TaskStopDoc,
} from "@/lib/types";

/**
 * Stop / Resume a bot's work on a task (VEC-215, part of VEC-214). A bot that picked a task up by accident (or is
 * going the wrong way) can be stopped by a person; the task then sits paused, can be edited freely, and Resume
 * hands it back with one fresh wake-up.
 *
 * Stop (creator, the bot's owner, or an admin; people only):
 * - records `task.stopped` {by, at, botId, kind, pausedFlow}; this is what every wake path checks (wakeBots,
 *   wakeTriage, dispatchWake, the wake queue's stillOwed, the reconciler query, markHandedOver);
 * - moves the bot's in-progress claims (assigned and triage) to state "stopped": off the working ring, not
 *   finished (no Stalled "finished"), and check_for_work / check_for_triage skip a task with any claim;
 * - pauses the task's flow (as Pause flow does) and moves a task the bot's pickup put In Progress back to the
 *   project's first not-started status (Todo); the assignee is kept;
 * - drops queued and retrying work / close-out wake-ups for the task.
 *
 * Edits while stopped are normal edits (title, description, assignee, status) and never resume it: the gates above
 * hold any hand-off they would make. Resume clears the stop, resumes the flow it paused (re-synced by status), drops
 * the stopped claims and hands the task back: a Triage task to the bot that was triaging it (wakeTriage, that bot
 * first), anything else open and ready to its assignee bot as an assigned wake-up with a stopped-and-resumed note.
 * A polling bot gets it from its next check_for_work (no claim left); a blocked task waits for its ready hand-off.
 */

const hex = (id: ObjectId) => id.toHexString();
const WORK_WAKES = ["assigned", "ready", "closeout"] as const;

async function load(actor: Actor, taskId: ObjectId) {
  if (actor.isBot) throw new UserError("Stopping and resuming a bot's work is for people.");
  const c = await cols();
  const task = await c.tasks.findOne({ _id: taskId, orgId: actor.orgId });
  if (!task) throw new UserError("This task no longer exists.");
  if (task.archivedAt) throw new UserError("This task is archived. Restore it first.");
  const project = await c.projects.findOne({ _id: task.projectId }, { projection: { key: 1 } });
  return { c, task, key: project?.key ?? "?" };
}

/** Same people as Pause flow, with the bot's owner standing in for the (bot) assignee. */
function mayStop(actor: Actor, task: TaskDoc, bot: BotDoc | null) {
  return actor.isAdmin || task.createdBy.equals(actor.id) || !!task.assigneeId?.equals(actor.id) || !!bot?.createdBy.equals(actor.id);
}

async function actorName(actor: Actor) {
  const c = await cols();
  return (await c.users.findOne({ _id: actor.id }, { projection: { name: 1 } }))?.name ?? "Someone";
}

async function record(actor: Actor, taskId: ObjectId, act: Omit<ActivityDoc, "_id" | "orgId" | "taskId" | "actorId" | "createdAt">, at: Date) {
  const c = await cols();
  const doc: ActivityDoc = { _id: new ObjectId(), orgId: actor.orgId, taskId, actorId: actor.id, createdAt: at, ...act };
  await c.activity.insertOne(doc);
  await publish(hex(actor.orgId), { type: "feed.add", actorId: hex(actor.id), taskId: hex(taskId), item: toFeed(doc) });
}

export async function stopWorkAs(actor: Actor, taskId: ObjectId): Promise<Task> {
  const { c, task, key } = await load(actor, taskId);
  if (task.stopped) {
    const bot = await c.bots.findOne({ _id: task.stopped.botId }, { projection: { name: 1 } });
    throw new UserError(`${bot?.name ?? "The bot"}'s work on this task is already stopped. Resume it to hand it back.`);
  }
  const claims = await c.agentClaims.find({ taskId, orgId: actor.orgId, state: "in_progress" }).toArray();
  // Which bot is "working": a triage in progress, else the assignee's pick-up, else a hand-off to it still queued.
  const triage = claims.find((cl) => cl.kind === "triage");
  const assigned = claims.find((cl) => cl.kind !== "triage" && task.assigneeId?.equals(cl.botId)) ?? claims.find((cl) => cl.kind !== "triage");
  const queued =
    !triage && !assigned && task.assigneeId
      ? await c.botWakes.findOne({ taskId, botId: task.assigneeId, kind: { $in: [...WORK_WAKES] }, failedAt: null }, { projection: { botId: 1 } })
      : null;
  const botId = triage?.botId ?? assigned?.botId ?? queued?.botId ?? null;
  if (!botId) throw new UserError("No bot is working on this task, so there's nothing to stop.");
  const bot = await c.bots.findOne({ _id: botId, orgId: actor.orgId });
  if (!mayStop(actor, task, bot)) throw new UserError(`Only the task's creator, ${bot?.name ?? "the bot"}'s owner or an admin can stop its work.`);
  const kind: TaskStopDoc["kind"] = triage ? "triage" : "assigned";

  const now = new Date();
  // Flow: paused like Pause flow, unless it already is (then Resume leaves it paused).
  const ctx = task.flow?.paused ? null : await loadTaskFlow(task);
  const flow: TaskFlowState | null = ctx ? flowPauseState(task, ctx, true, now).flow : null;
  // Status: back to the first not-started status if the bot's pickup put it in a started one (In Progress). A flow
  // step that already sat in a started status (a tester's In Review) stays where it is.
  const statuses = await c.statuses.find({ orgId: actor.orgId, projectId: task.projectId }, { projection: { category: 1, order: 1 } }).sort({ order: 1 }).toArray();
  const current = statuses.find((s) => s._id.equals(task.statusId));
  const todo = statuses.find((s) => s.category === "unstarted");
  let moveTo: ObjectId | null = null;
  if (kind === "assigned" && current?.category === "started" && todo) {
    const firstStarted = statuses.find((s) => s.category === "started");
    const [last] = await c.activity.find({ taskId, kind: "status" }).sort({ createdAt: -1 }).limit(1).toArray();
    const botMoved = !!last && last.to === hex(current._id) && (last.note === "started_work" || last.note === "resumed_work");
    if (botMoved || firstStarted?._id.equals(current._id)) moveTo = todo._id;
  }

  const stopped: TaskStopDoc = { by: actor.id, at: now, botId, kind, pausedFlow: !!flow };
  const after = await c.tasks.findOneAndUpdate(
    { _id: taskId, orgId: actor.orgId, stopped: null },
    { $set: { stopped, updatedAt: now, ...(flow ? { flow } : {}), ...(moveTo ? { statusId: moveTo } : {}) } },
    { returnDocument: "after" },
  );
  if (!after) throw new UserError("Someone else stopped it a moment ago.");

  // Before the broadcast, so the upsert carries the cleared working ring.
  await c.agentClaims.updateMany({ taskId, state: "in_progress" }, { $set: { state: "stopped", finishedAt: now } });
  await c.botWakes.deleteMany({ taskId, kind: { $in: [...WORK_WAKES] } });
  // Runs with no claim (VEC-380: a reply, a close-out) stop showing too. A later mention is answered with a fresh one.
  await c.runMarks.deleteMany({ taskId });

  const [out] = await withWorkingBots([toTask(after, key)]);
  await publish(hex(actor.orgId), { type: "task.upsert", actorId: hex(actor.id), task: out }, { workingLoaded: true });
  if (moveTo) await record(actor, taskId, { kind: "status", from: hex(task.statusId), to: hex(moveTo), note: "stopped_work" }, now);
  await record(actor, taskId, { kind: "stopped", to: hex(botId), ...(kind === "triage" ? { note: "triage" as ActivityNote } : {}) }, now);
  // Cut a run that's still going short (VEC-216): cancel the Hermes run, tell a webhook bot (task.stopped).
  signalStop(actor.orgId, { taskId, botId, taskKey: `${key}-${after.number}`, title: after.title, by: await actorName(actor), work: kind });
  return out;
}

/**
 * VEC-352: a disabled bot doesn't stop Resume. The stop is cleared either way; the assignee's wake-up goes through
 * wakeBots, which queues it held (dispatchWake) so it goes out when the bot is enabled, and the outcome's `note`
 * says so. A disabled triager is skipped by wakeTriage (next enabled triager, or held in Triage).
 */
export async function resumeWorkAs(actor: Actor, taskId: ObjectId): Promise<ResumeOutcome> {
  const { c, task, key } = await load(actor, taskId);
  const stop = task.stopped;
  if (!stop) throw new UserError("This task isn't stopped, so there's nothing to resume.");
  const [stoppedBot, assigneeBot] = await Promise.all([
    c.bots.findOne({ _id: stop.botId, orgId: actor.orgId }),
    task.assigneeId ? c.bots.findOne({ _id: task.assigneeId, orgId: actor.orgId }) : null,
  ]);
  if (!mayStop(actor, task, stoppedBot) && !(assigneeBot && mayStop(actor, task, assigneeBot))) {
    throw new UserError(`Only the task's creator, ${stoppedBot?.name ?? "the bot"}'s owner or an admin can resume its work.`);
  }

  const now = new Date();
  const ctx = stop.pausedFlow && task.flow?.paused ? await loadTaskFlow(task, { ignoreRecorded: true }) : null;
  const flow = ctx ? flowPauseState(task, ctx, false, now).flow : null;
  const after = await c.tasks.findOneAndUpdate(
    { _id: taskId, orgId: actor.orgId, "stopped.at": stop.at },
    { $set: { stopped: null, updatedAt: now, ...(flow ? { flow } : {}) } },
    { returnDocument: "after" },
  );
  if (!after) throw new UserError("Someone else resumed it a moment ago.");
  // The stopped pick-ups are history: the hand-back below starts fresh (check_for_work skips tasks with any claim).
  await c.agentClaims.deleteMany({ taskId, state: "stopped" });
  await c.botWakes.deleteMany({ taskId, kind: { $in: [...WORK_WAKES] } });

  const status = await c.statuses.findOne({ _id: after.statusId }, { projection: { category: 1 } });
  const open = !!status && !isClosedCategory(status.category);
  const by = await actorName(actor);
  let handedTo: ObjectId | null = null;
  let disabled: BotDoc | null = null;
  let note: string | null = null;
  if (open && status.category === "triage") {
    // Back to the triager it was taken from (that bot first), else the next connected triage bot.
    wakeTriage(actor.orgId, { taskId, taskKey: `${key}-${after.number}`, title: after.title, by, prefer: stop.kind === "triage" ? stop.botId : undefined });
    handedTo = stop.kind === "triage" ? stop.botId : null;
    if (stop.kind === "triage" && stoppedBot && !isBotEnabled(stoppedBot)) {
      // wakeTriage skips a disabled triager (triageOrder), so it isn't the one the task goes back to.
      disabled = stoppedBot;
      note = disabledResumeNote(stoppedBot.name, "triage");
      handedTo = null;
    }
  } else if (open && assigneeBot && !after.waitingOn?.length) {
    if (!isBotEnabled(assigneeBot)) {
      disabled = assigneeBot;
      note = disabledResumeNote(assigneeBot.name, "assigned");
    }
    // Exactly one wake-up: through the wake queue (retried if it fails), or the next check_for_work for a polling bot.
    if (assigneeBot.connection && isPush(assigneeBot.connection.method)) {
      // Reassigned while stopped (VEC-219): this bot never worked on it, so its note says so rather than "stopped your work".
      const reassignedFrom = assigneeBot._id.equals(stop.botId) ? undefined : (stoppedBot?.name ?? "another bot");
      wakeBots(actor.orgId, [assigneeBot._id], { kind: "assigned", taskId, taskKey: `${key}-${after.number}`, title: after.title, by, retry: true, resumed: true, ...(reassignedFrom ? { reassignedFrom } : {}) });
    }
    handedTo = assigneeBot._id;
  }

  const [out] = await withWorkingBots([toTask(after, key)]);
  await publish(hex(actor.orgId), { type: "task.upsert", actorId: hex(actor.id), task: out }, { workingLoaded: true });
  await record(actor, taskId, { kind: "resumed", to: handedTo ? hex(handedTo) : null }, now);
  return { task: out, note, botDisabled: disabled ? { id: hex(disabled._id), name: disabled.name } : null };
}
