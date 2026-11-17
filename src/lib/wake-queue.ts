import "server-only";
import { after } from "next/server";
import { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { isPush } from "@/lib/bot-connect";
import { deliver, markHandedOver, wakeTriage, type WakeReason } from "@/lib/bot-dispatch";
import { publishWorking } from "@/lib/claims";
import { billingEnabled } from "@/lib/billing";
import { busyWith, concurrencyLimit } from "@/lib/bot-capacity";
import { mentionResumesWork } from "@/lib/task-service";
import { notify } from "@/lib/notifications";
// Starts the wait-step reminder sweeper (VEC-182) alongside this one: every server path that writes tasks loads this module.
import "@/lib/wait-reminders";
import { isClosedCategory, type BotDoc, type BotWakeDoc, type OrgDoc, type QueuedWakeKind } from "@/lib/types";

/**
 * Push wake-ups that must reach their bot (VEC-101). A push bot never polls check_for_work, so a task wake-up that
 * fails to send (agent down, network blip, timeout) used to leave the task "ready" with nobody working on it.
 *
 * - dispatchWake queues the wake-up (botWakes) before the first attempt and deletes it once a delivery succeeds.
 * - A failed attempt is retried with backoff (BACKOFF_MS) by the sweeper. Before each retry it checks the task is
 *   still owed to that bot, and whether the bot already acted on the task since the hand-off (an attempt that timed
 *   out may still have started a run): then it only does the hand-over bookkeeping (claim, In Progress), no second
 *   run. Every attempt of one wake-up uses the same id (Hermes Idempotency-Key, webhook delivery id).
 * - After the last attempt the wake-up is kept with `failedAt`: the task shows Stalled ("undelivered") and the
 *   task's creator (a person), else the org admins, get an "undelivered" notification. The next successful
 *   delivery to that bot re-arms it for one more try.
 * - The reconciler (same sweep) re-sends hand-offs that never got a queue row at all (the after() job was lost,
 *   the process died before sending): ready tasks assigned to a push bot, with no claim, no queued wake-up and no
 *   sign of the bot since they were handed over (GRACE_MS ago), and close-outs never delivered.
 *
 * - Plan limit (VEC-225): when the org's plan caps simultaneous bot work (Free: one task) the wake-up is `gated`. If
 *   the bot's slot is taken (lib/bot-capacity.ts) it is queued as held (`heldAt`, no attempt) and releaseHeld sends
 *   the oldest held one once the slot frees: kicked by complete_task, release_task, advance_task, Stop and a person
 *   closing the task (kickHeld), and on every sweep as the safety net. Unlimited plans never gate.
 *
 * The sweep runs every SWEEP_MS in the long-lived server process (started when this module loads); on Vercel, where
 * nothing outlives a request, /api/cron/wakes runs it.
 */

const BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000, 2 * 60 * 60_000];
/** First attempt plus one per backoff step (about 3 h 45 min in all). */
export const MAX_WAKE_ATTEMPTS = BACKOFF_MS.length + 1;
/** An attempt in flight holds the wake-up this long (direct API methods run a whole agent turn, up to 4 min). */
const LEASE_MS = 5 * 60_000;
/** The reconciler leaves a hand-off this long for the normal path before it treats it as lost. */
const GRACE_MS = 2 * 60_000;
/** ...and doesn't dig up hand-offs older than this. */
const LOOKBACK_MS = 7 * 24 * 60 * 60_000;
const SWEEP_MS = 15_000;
const RETRIES_PER_SWEEP = 10;

/** Assigned, ready and mention wake-ups all hand the bot work on the task; one landing settles the others. */
const WORK_KINDS: QueuedWakeKind[] = ["assigned", "ready", "mentioned"];

type QueuedReason = Extract<WakeReason, { kind: QueuedWakeKind }>;

export const isQueuedWake = (r: WakeReason): r is QueuedReason => r.kind === "assigned" || r.kind === "ready" || r.kind === "closeout" || r.kind === "mentioned";

const hex = (id: ObjectId) => id.toHexString();

/** A person stopped the bot's work on this task (VEC-215) and hasn't resumed it. */
async function isStopped(taskId: ObjectId) {
  const c = await cols();
  return !!(await c.tasks.findOne({ _id: taskId, stopped: { $ne: null } }, { projection: { _id: 1 } }));
}

function storedReason(r: QueuedReason): BotWakeDoc["reason"] {
  return {
    kind: r.kind,
    taskId: r.taskId,
    taskKey: r.taskKey,
    title: r.title,
    by: r.by,
    ...("detail" in r ? { detail: r.detail } : {}),
    ...("commentId" in r ? { commentId: r.commentId } : {}),
    ...("retry" in r && r.retry ? { retry: true } : {}),
    ...("resumed" in r && r.resumed ? { resumed: true } : {}),
    ...("reassignedFrom" in r && r.reassignedFrom ? { reassignedFrom: r.reassignedFrom } : {}),
    ...("handoff" in r && r.handoff ? { handoff: r.handoff } : {}),
  };
}

function toReason(w: BotWakeDoc): QueuedReason {
  const r = w.reason;
  const base = { taskId: r.taskId, taskKey: r.taskKey, title: r.title, by: r.by };
  switch (r.kind) {
    case "ready":
      return { kind: r.kind, ...base, detail: r.detail ?? "Nothing it depends on is open any more" };
    case "closeout":
      return { kind: r.kind, ...base, detail: r.detail ?? "Nothing it depends on is open any more", ...(r.retry ? { retry: true } : {}) };
    case "mentioned":
      return { kind: "mentioned", ...base, commentId: r.commentId ?? new ObjectId() };
    default:
      return { kind: "assigned", ...base, ...(r.retry ? { retry: true } : {}), ...(r.resumed ? { resumed: true } : {}), ...(r.reassignedFrom ? { reassignedFrom: r.reassignedFrom } : {}), ...(r.handoff ? { handoff: r.handoff } : {}) };
  }
}

/**
 * A fresh hand-off to a push bot: queue it, then make the first attempt. Replaces an older queued wake-up of the
 * same kind for the same task (a new hand-off gets a new id, so Hermes doesn't take it for a retry of the old one).
 */
export async function dispatchWake(bot: BotDoc, org: OrgDoc, reason: QueuedReason) {
  const c = await cols();
  // A stopped task (VEC-215) gets no work hand-off until it's resumed; Resume sends its own. Mentions still go out.
  if (reason.kind !== "mentioned" && (await isStopped(reason.taskId))) return;
  await c.botWakes.deleteMany({ botId: bot._id, taskId: reason.taskId, kind: reason.kind });
  const gated = await gatedWake(bot, org, reason);
  const now = new Date();
  const wake: BotWakeDoc = {
    _id: new ObjectId(),
    orgId: org._id,
    botId: bot._id,
    taskId: reason.taskId,
    kind: reason.kind,
    reason: storedReason(reason),
    attempts: 0,
    nextAttemptAt: new Date(now.getTime() + LEASE_MS),
    lastError: null,
    createdAt: now,
    updatedAt: now,
    failedAt: null,
    notifiedAt: null,
    // Limited plan: queued as held, then released below straight away if the bot's slot is free.
    ...(gated ? { gated: true, heldAt: now } : {}),
  };
  try {
    await c.botWakes.insertOne(wake);
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return; // the same hand-off is being sent right now
    throw err;
  }
  if (gated) await releaseHeld(bot, org);
  else await attempt(bot, org, wake);
}

/**
 * Does this wake-up take the bot's slot under a plan limit (VEC-225)? Work hand-offs and close-outs do; a mention
 * only when it hands the work back (the bot is its open, ready task's assignee), otherwise it's a question.
 */
async function gatedWake(bot: BotDoc, org: OrgDoc, reason: QueuedReason): Promise<boolean> {
  if (concurrencyLimit(org) === null) return false;
  if (reason.kind !== "mentioned") return true;
  return mentionResumesWork(org._id, bot._id, reason.taskId);
}

/**
 * Sends the bot's held wake-ups, oldest first, while its plan leaves a slot free (VEC-225). Each is released
 * atomically (one sender), re-checked after the release in case a concurrent hand-off took the slot meanwhile (then
 * held again for the next kick or sweep), and checked as still owed like a retry. Returns how many went out.
 */
export async function releaseHeld(bot: BotDoc, org: OrgDoc): Promise<number> {
  const c = await cols();
  let sent = 0;
  for (let guard = 0; guard < 50; guard++) {
    const next = await c.botWakes.find({ botId: bot._id, heldAt: { $ne: null }, failedAt: null }).sort({ createdAt: 1, _id: 1 }).limit(1).next();
    if (!next) break;
    if (!bot.connection || !isPush(bot.connection.method)) {
      // No longer pushed to: a polling bot gets its work from check_for_work.
      await c.botWakes.deleteMany({ botId: bot._id, heldAt: { $ne: null } });
      break;
    }
    const limit = concurrencyLimit(org);
    if (limit !== null && (await busyWith(org._id, bot._id, next.taskId)).length >= limit) break;
    const wake = await c.botWakes.findOneAndUpdate(
      { _id: next._id, heldAt: { $ne: null } },
      { $set: { heldAt: null, nextAttemptAt: new Date(Date.now() + LEASE_MS), updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!wake) continue; // another sender released it
    if (limit !== null && (await busyWith(org._id, bot._id, wake.taskId)).length >= limit) {
      await c.botWakes.updateOne({ _id: wake._id }, { $set: { heldAt: new Date(), updatedAt: new Date() } });
      break;
    }
    const owed = await stillOwed(wake);
    if (owed === "drop") {
      await c.botWakes.deleteOne({ _id: wake._id });
      continue;
    }
    if (owed === "landed" && wake.attempts > 0) {
      // An attempt from before it was held got through after all (a re-armed retry): bookkeeping only.
      await markHandedOver(bot, org, toReason(wake));
      await settled(bot, org, wake);
      continue;
    }
    // Never sent yet: the bot acting on the task while it waited (answering a question) isn't this hand-off landing.
    await attempt(bot, org, wake);
    sent++;
  }
  return sent;
}

/** Bots with held wake-ups, and Triage tasks a busy triager was skipped for: offered again when there's room. */
async function releaseAllHeld(orgId?: ObjectId, botId?: ObjectId): Promise<number> {
  if (!billingEnabled()) {
    // Billing switched off (self-hosted) while some were held: nothing limits them any more.
    const c0 = await cols();
    if (!(await c0.botWakes.findOne({ heldAt: { $ne: null } }, { projection: { _id: 1 } })) && !(await c0.tasks.findOne({ "triageHeld.at": { $exists: true } }, { projection: { _id: 1 } }))) return 0;
  }
  const c = await cols();
  const scope = { ...(orgId ? { orgId } : {}), ...(botId ? { botId } : {}) };
  const botIds = (await c.botWakes.distinct("botId", { ...scope, heldAt: { $ne: null }, failedAt: null })) as ObjectId[];
  let sent = 0;
  for (const id of botIds) {
    const bot = await c.bots.findOne({ _id: id });
    const org = bot && (await c.orgs.findOne({ _id: bot.orgId }));
    if (!bot || !org) {
      await c.botWakes.deleteMany({ botId: id, heldAt: { $ne: null } });
      continue;
    }
    try {
      sent += await releaseHeld(bot, org);
    } catch (err) {
      console.error("[bot wake] releasing held wake-ups failed", err);
    }
  }
  // Triage: unmark and offer again; wakeTriage marks it again if every triager is still busy.
  const held = await c.tasks.find({ ...(orgId ? { orgId } : {}), "triageHeld.at": { $exists: true }, archivedAt: null }, { projection: { description: 0 } }).limit(50).toArray();
  for (const t of held) {
    const un = await c.tasks.updateOne({ _id: t._id, "triageHeld.at": t.triageHeld!.at }, { $set: { triageHeld: null } });
    if (!un.modifiedCount || t.stopped) continue;
    const [status, claim, project] = await Promise.all([
      c.statuses.findOne({ _id: t.statusId }, { projection: { category: 1 } }),
      c.agentClaims.findOne({ taskId: t._id, kind: "triage" }, { projection: { _id: 1 } }),
      c.projects.findOne({ _id: t.projectId }, { projection: { key: 1 } }),
    ]);
    if (status?.category !== "triage" || claim || !project) continue;
    wakeTriage(t.orgId, { taskId: t._id, taskKey: `${project.key}-${t.number}`, title: t.title, by: "Aimpoint", ...(t.triageHeld!.exclude ? { exclude: t.triageHeld!.exclude } : {}) });
  }
  return sent;
}

/**
 * A bot's work on a task ended (complete_task, release_task, advance_task, Stop, the task closed): send what was held
 * for it, after the response. No-op unless billing is on. Never throws into the caller.
 */
export function kickHeld(orgId: ObjectId, botIds: ObjectId[]) {
  if (!billingEnabled() || !botIds.length) return;
  const job = async () => {
    try {
      for (const id of botIds) await releaseAllHeld(orgId, id);
    } catch (err) {
      console.error("[bot wake] kick failed", err);
    }
  };
  try {
    after(job);
  } catch {
    void job();
  }
}

async function attempt(bot: BotDoc, org: OrgDoc, wake: BotWakeDoc) {
  const n = wake.attempts + 1;
  const out = await deliver(bot, org, toReason(wake), { wakeId: wake._id, attempt: n });
  if (out.ok) await settled(bot, org, wake);
  else await retryLater(bot, org, wake, n, out.error ?? (out.status ? `Answered ${out.status}.` : "Delivery failed."));
}

/** Delivered: drop the wake-up (and any other work wake-up for this task, now moot); re-arm the bot's failed ones. */
async function settled(bot: BotDoc, org: OrgDoc, wake: BotWakeDoc) {
  const c = await cols();
  const kinds = WORK_KINDS.includes(wake.kind) ? WORK_KINDS : [wake.kind];
  const stale = await c.botWakes.find({ botId: bot._id, taskId: wake.taskId, kind: { $in: kinds } }, { projection: { failedAt: 1 } }).toArray();
  await c.botWakes.deleteMany({ _id: { $in: [wake._id, ...stale.map((s) => s._id)] } });
  // A failed one showed the task as Stalled: republish so it clears.
  if (stale.some((s) => s.failedAt)) await publishWorking(org._id, bot._id, [wake.taskId]);
  // The bot is reachable again: give what gave up on it one more try on the next sweep.
  // Plan-gated ones (VEC-225) go back in line as held, so they still go out one at a time.
  await c.botWakes.updateMany({ botId: bot._id, failedAt: { $ne: null }, gated: true }, { $set: { failedAt: null, heldAt: new Date(), attempts: MAX_WAKE_ATTEMPTS - 1, updatedAt: new Date() } });
  await c.botWakes.updateMany({ botId: bot._id, failedAt: { $ne: null } }, { $set: { failedAt: null, attempts: MAX_WAKE_ATTEMPTS - 1, nextAttemptAt: new Date(), updatedAt: new Date() } });
}

async function retryLater(bot: BotDoc, org: OrgDoc, wake: BotWakeDoc, attempts: number, error: string) {
  const c = await cols();
  const now = new Date();
  if (attempts < MAX_WAKE_ATTEMPTS) {
    const at = new Date(now.getTime() + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]);
    await c.botWakes.updateOne({ _id: wake._id }, { $set: { attempts, nextAttemptAt: at, lastError: error, updatedAt: now } });
    return;
  }
  const res = await c.botWakes.updateOne({ _id: wake._id }, { $set: { attempts, failedAt: now, lastError: error, updatedAt: now } });
  if (!res.matchedCount) return; // replaced by a newer hand-off meanwhile
  console.error(`[bot wake] giving up: ${bot.name} never got ${wake.reason.taskKey} (${wake.kind}) after ${attempts} attempts: ${error}`);
  await giveUp(bot, org, wake, attempts, error);
}

/** Make the stuck task visible: Stalled on the task (derived from the failed wake-up) and a person told once. */
async function giveUp(bot: BotDoc, org: OrgDoc, wake: BotWakeDoc, attempts: number, error: string) {
  const c = await cols();
  await publishWorking(org._id, bot._id, [wake.taskId]);
  const first = await c.botWakes.findOneAndUpdate({ _id: wake._id, notifiedAt: null }, { $set: { notifiedAt: new Date() } });
  if (!first) return;
  const task = await c.tasks.findOne({ _id: wake.taskId }, { projection: { createdBy: 1 } });
  if (!task) return;
  const creator = await c.memberships.findOne({ orgId: org._id, userId: task.createdBy }, { projection: { userId: 1 } });
  const recipients = creator ? [creator.userId] : (await c.memberships.find({ orgId: org._id, role: "admin" }, { projection: { userId: 1 } }).toArray()).map((m) => m.userId);
  await notify(org._id, recipients, { kind: "undelivered", taskId: wake.taskId, actorId: bot._id, detail: `Not delivered after ${attempts} tries: ${error}`.slice(0, 200) });
}

/* ---------------- the sweep ---------------- */

/** Is this queued wake-up still owed, and did an earlier attempt reach the bot after all? */
async function stillOwed(wake: BotWakeDoc): Promise<"send" | "landed" | "drop"> {
  const c = await cols();
  const task = await c.tasks.findOne({ _id: wake.taskId, orgId: wake.orgId }, { projection: { description: 0 } });
  if (!task || task.archivedAt) return "drop";
  if (task.stopped && wake.kind !== "mentioned") return "drop"; // VEC-215: Resume sends a fresh one
  const status = await c.statuses.findOne({ _id: task.statusId }, { projection: { category: 1 } });
  if (!status || isClosedCategory(status.category)) return "drop";
  if (wake.kind === "closeout") {
    const co = task.closeout;
    if (!co || !co.botId.equals(wake.botId) || co.deliveredAt || co.resolvedAt) return "drop";
  } else if (wake.kind === "mentioned") {
    if (!(await c.botMentions.findOne({ botId: wake.botId, taskId: wake.taskId, deliveredAt: null }, { projection: { _id: 1 } }))) return "drop";
  } else {
    // Reassigned, blocked again (the next ready hand-off will wake it), in Triage, or already picked up / finished.
    if (!task.assigneeId?.equals(wake.botId) || task.waitingOn?.length || status.category === "triage") return "drop";
    if (await c.agentClaims.findOne({ botId: wake.botId, taskId: wake.taskId }, { projection: { _id: 1 } })) return "drop";
  }
  return (await actedSince(wake.botId, wake.taskId, wake.createdAt)) ? "landed" : "send";
}

/** Has the bot commented on, or changed, the task after `since`? */
async function actedSince(botId: ObjectId, taskId: ObjectId, since: Date, except?: ObjectId) {
  const c = await cols();
  const [comment, act] = await Promise.all([
    c.comments.findOne({ taskId, authorId: botId, createdAt: { $gt: since } }, { projection: { _id: 1 } }),
    c.activity.findOne({ taskId, actorId: botId, createdAt: { $gt: since }, ...(except ? { _id: { $ne: except } } : {}) }, { projection: { _id: 1 } }),
  ]);
  return !!(comment || act);
}

async function retryOne(wake: BotWakeDoc) {
  const c = await cols();
  const [bot, org] = await Promise.all([c.bots.findOne({ _id: wake.botId, orgId: wake.orgId }), c.orgs.findOne({ _id: wake.orgId })]);
  if (!bot || !org || !bot.connection || !isPush(bot.connection.method)) {
    await c.botWakes.deleteOne({ _id: wake._id });
    return;
  }
  const owed = await stillOwed(wake);
  if (owed === "drop") {
    await c.botWakes.deleteOne({ _id: wake._id });
    return;
  }
  if (owed === "landed") {
    // An earlier attempt reached it (it timed out on our side but the agent is working): no second run.
    console.info(`[bot wake] ${bot.name} is already acting on ${wake.reason.taskKey}; not sending it again`);
    await markHandedOver(bot, org, toReason(wake));
    await settled(bot, org, wake);
    return;
  }
  await attempt(bot, org, wake);
}

/** Retries the wake-ups that are due. Each is leased first, so overlapping sweeps (or servers) don't double-send. */
async function retryDue(): Promise<number> {
  const c = await cols();
  let n = 0;
  for (; n < RETRIES_PER_SWEEP; n++) {
    const now = Date.now();
    const wake = await c.botWakes.findOneAndUpdate(
      // Held ones (VEC-225) wait for the bot's slot, not the clock: releaseAllHeld sends them.
      { failedAt: null, heldAt: null, nextAttemptAt: { $lte: new Date(now) } },
      { $set: { nextAttemptAt: new Date(now + LEASE_MS) } },
      { sort: { nextAttemptAt: 1 }, returnDocument: "after" },
    );
    if (!wake) break;
    try {
      await retryOne(wake);
    } catch (err) {
      console.error("[bot wake] retry failed", err);
    }
  }
  return n;
}

async function actorName(id: ObjectId) {
  const c = await cols();
  const [u, b] = await Promise.all([c.users.findOne({ _id: id }, { projection: { name: 1 } }), c.bots.findOne({ _id: id }, { projection: { name: 1 } })]);
  return u?.name ?? b?.name ?? "Aimpoint";
}

/**
 * Hand-offs that never reached the queue: a ready (or newly assigned) task of a push bot that has no claim on it, no
 * queued wake-up and hasn't touched it since it was handed over GRACE_MS ago; and close-outs never delivered.
 * Each is sent through dispatchWake, so it is queued and retried like any other.
 */
async function reconcile(): Promise<number> {
  const c = await cols();
  const pushBots = (await c.bots.find({ "connection.method": { $exists: true } }).toArray()).filter((b) => b.connection && isPush(b.connection.method));
  if (!pushBots.length) return 0;
  const botById = new Map(pushBots.map((b) => [hex(b._id), b]));
  const botIds = pushBots.map((b) => b._id);
  const now = Date.now();
  const since = new Date(now - LOOKBACK_MS);
  const cutoff = new Date(now - GRACE_MS);
  const orgs = new Map((await c.orgs.find({ _id: { $in: [...new Set(pushBots.map((b) => hex(b.orgId)))].map((id) => new ObjectId(id)) } }).toArray()).map((o) => [hex(o._id), o]));
  let sent = 0;

  // Work hand-offs (ready / assigned).
  const tasks = await c.tasks
    .find({ assigneeId: { $in: botIds }, archivedAt: null, stopped: null, "waitingOn.0": { $exists: false }, updatedAt: { $gte: since } }, { projection: { description: 0 } })
    .toArray();
  if (tasks.length) {
    const taskIds = tasks.map((t) => t._id);
    const [statuses, claims, wakes] = await Promise.all([
      c.statuses.find({ _id: { $in: [...new Set(tasks.map((t) => hex(t.statusId)))].map((id) => new ObjectId(id)) } }, { projection: { category: 1 } }).toArray(),
      c.agentClaims.find({ taskId: { $in: taskIds }, botId: { $in: botIds } }, { projection: { taskId: 1, botId: 1 } }).toArray(),
      c.botWakes.find({ taskId: { $in: taskIds } }, { projection: { taskId: 1, botId: 1 } }).toArray(),
    ]);
    const category = new Map(statuses.map((s) => [hex(s._id), s.category]));
    const held = new Set([...claims, ...wakes].map((x) => `${hex(x.taskId)}:${hex(x.botId)}`));
    for (const t of tasks) {
      const bot = botById.get(hex(t.assigneeId!))!;
      const cat = category.get(hex(t.statusId));
      if (!cat || cat === "triage" || isClosedCategory(cat)) continue;
      if (t.triagedBy?.equals(bot._id)) continue; // its close-out covers it (triager == assignee)
      if (held.has(`${hex(t._id)}:${hex(bot._id)}`)) continue;
      // The latest hand-off: it became ready, or was assigned (or created) to this bot.
      const [ev] = await c.activity.find({ taskId: t._id, kind: { $in: ["unblocked", "assignee", "created"] } }).sort({ createdAt: -1 }).limit(1).toArray();
      if (!ev || ev.createdAt > cutoff || ev.createdAt < since) continue;
      if (ev.kind === "assignee" && ev.to !== hex(bot._id)) continue;
      if (await actedSince(bot._id, t._id, ev.createdAt, ev._id)) continue;
      const org = orgs.get(hex(t.orgId));
      const project = await c.projects.findOne({ _id: t.projectId }, { projection: { key: 1 } });
      if (!org || !project) continue;
      const base = { taskId: t._id, taskKey: `${project.key}-${t.number}`, title: t.title, by: await actorName(ev.actorId) };
      const reason: QueuedReason =
        ev.kind === "unblocked" ? { kind: "ready", ...base, detail: ev.from ? `${ev.from} closed` : "Nothing it depends on is open any more" } : { kind: "assigned", ...base };
      console.info(`[bot wake] re-sending a lost hand-off: ${base.taskKey} to ${bot.name} (${reason.kind}, handed over ${ev.createdAt.toISOString()})`);
      await dispatchWake(bot, org, reason);
      sent++;
    }
  }

  // Close-outs recorded for a push triager but never delivered.
  const umbrellas = await c.tasks
    .find(
      { "closeout.botId": { $in: botIds }, "closeout.deliveredAt": null, "closeout.resolvedAt": null, "closeout.requestedAt": { $lte: cutoff, $gte: since }, archivedAt: null, stopped: null },
      { projection: { description: 0 } },
    )
    .toArray();
  for (const t of umbrellas) {
    const bot = botById.get(hex(t.closeout!.botId))!;
    if (await c.botWakes.findOne({ botId: bot._id, taskId: t._id, kind: "closeout" }, { projection: { _id: 1 } })) continue;
    const status = await c.statuses.findOne({ _id: t.statusId }, { projection: { category: 1 } });
    if (!status || isClosedCategory(status.category) || t.waitingOn?.length) continue;
    const org = orgs.get(hex(t.orgId));
    const project = await c.projects.findOne({ _id: t.projectId }, { projection: { key: 1 } });
    if (!org || !project) continue;
    const key = `${project.key}-${t.number}`;
    console.info(`[bot wake] re-sending a lost close-out: ${key} to ${bot.name}`);
    await dispatchWake(bot, org, { kind: "closeout", taskId: t._id, taskKey: key, title: t.title, by: "Aimpoint", detail: "Nothing it depends on is open any more" });
    sent++;
  }
  return sent;
}

/** One pass: retry what's due, then re-send lost hand-offs. Also the body of /api/cron/wakes. */
export async function sweepWakes(): Promise<{ retried: number; resent: number; released: number }> {
  const retried = await retryDue();
  const released = await releaseAllHeld();
  const resent = await reconcile();
  return { retried, resent, released };
}

type SweepState = { timer?: ReturnType<typeof setInterval>; running?: boolean; run?: () => Promise<unknown> };
const g = globalThis as unknown as { __vectorWakeSweep?: SweepState };

/** Runs the sweep every SWEEP_MS in this process (not on Vercel, not during a build). Safe to call repeatedly. */
export function startWakeSweeper() {
  const st = (g.__vectorWakeSweep ??= {});
  st.run = sweepWakes; // after a dev reload the timer calls the new code
  if (st.timer || process.env.VERCEL || process.env.NEXT_PHASE === "phase-production-build" || process.env.VECTOR_WAKE_SWEEP === "off") return;
  st.timer = setInterval(async () => {
    if (st.running) return;
    st.running = true;
    try {
      await st.run?.();
    } catch (err) {
      console.error("[bot wake sweep]", err);
    } finally {
      st.running = false;
    }
  }, SWEEP_MS);
  st.timer.unref?.();
}

startWakeSweeper();
