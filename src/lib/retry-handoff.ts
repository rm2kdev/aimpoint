import "server-only";
import { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { UserError } from "@/lib/result";
import { publish } from "@/lib/realtime/server";
import { toFeed } from "@/lib/data";
import { publishWorking } from "@/lib/claims";
import { isPush } from "@/lib/bot-connect";
import { wakeBots } from "@/lib/bot-dispatch";
import { disabledRetryWhy, isBotEnabled } from "@/lib/bot-enabled";
import { isClosedCategory, type ActivityDoc, type RetryOutcome, type TaskDoc } from "@/lib/types";
import type { Actor } from "@/lib/task-service";
import { PARENT_PROGRESS_NOTES } from "@/lib/parent-progress-core";

/**
 * Retry / unstall (VEC-159). A hand-off can land and still go nowhere: the bot's run dies part way (agent restarted,
 * provider error, quota), so the task sits In Progress with a working claim that nothing will ever finish. The wake
 * queue only retries deliveries that failed; this is the manual "hand it over again" for everything else.
 *
 * - A ready task assigned to a bot: forget the bot's claim and any queued wake-up, then hand it over again. A push
 *   bot gets a fresh wake-up (through the wake queue, so it is retried like any other) whose prompt says to carry on
 *   from the comments; a polling bot is offered it again by check_for_work. Hermes keeps one session per bot and
 *   task, so the new run continues the same chat.
 * - A pending close-out (a triager's umbrella whose sub-tasks are closed): the close-out is sent again.
 * - A task still waiting on others: the chain is retried from its front, i.e. the open, ready tasks it (transitively)
 *   waits on. Everything behind them is then handed out by the normal ready hand-offs, in dependency order.
 *
 * A task whose bot is disabled (VEC-352) is reported in `disabled` and left untouched (no wake-up queued, even held).
 *
 * Unless `force`, a task whose bot is working on it and posted within RETRY_QUIET_MS is left alone and reported as
 * busy, so a click doesn't start a second run beside one that is still going.
 */
export const RETRY_QUIET_MS = 10 * 60_000;
const MAX_CHAIN = 200;

const hex = (id: ObjectId) => id.toHexString();

export async function retryHandOff(actor: Actor, taskId: ObjectId, opts: { force?: boolean } = {}): Promise<RetryOutcome> {
  const c = await cols();
  const task = await c.tasks.findOne({ _id: taskId, orgId: actor.orgId });
  if (!task) throw new UserError("That task doesn't exist any more.");
  const allowed = actor.isAdmin || task.createdBy.equals(actor.id) || !!task.assigneeId?.equals(actor.id);
  if (!allowed) throw new UserError("Only the task's creator, its assignee or an admin can retry it.");
  if (task.archivedAt) throw new UserError("This task is archived. Restore it to hand it out again.");
  if (task.stopped) throw new UserError("Its bot's work is stopped. Resume it to hand it back.");
  const status = await c.statuses.findOne({ _id: task.statusId }, { projection: { category: 1, name: 1 } });
  if (status && isClosedCategory(status.category)) throw new UserError(`This task is ${status.name}. Reopen it to hand it out again.`);

  const targets = task.waitingOn?.length ? await chainFront(actor.orgId, task) : [task];
  const out: RetryOutcome = { retried: [], busy: [], skipped: [], disabled: [] };
  if (!targets.length) return out;

  const [projects, statuses] = await Promise.all([
    c.projects.find({ _id: { $in: unique(targets.map((t) => t.projectId)) } }, { projection: { key: 1 } }).toArray(),
    c.statuses.find({ _id: { $in: unique(targets.map((t) => t.statusId)) } }, { projection: { category: 1 } }).toArray(),
  ]);
  const keyOf = new Map(projects.map((p) => [hex(p._id), p.key]));
  const category = new Map(statuses.map((s) => [hex(s._id), s.category]));
  const org = await c.orgs.findOne({ _id: actor.orgId });
  if (!org) throw new UserError("That organisation doesn't exist any more.");
  const by = await actorName(actor);
  const touched: ObjectId[] = [];

  for (const t of targets.sort((a, b) => a.number - b.number)) {
    const key = `${keyOf.get(hex(t.projectId)) ?? "?"}-${t.number}`;
    if (category.get(hex(t.statusId)) === "triage") {
      out.skipped.push({ key, why: "it's in Triage, waiting to be broken down" });
      continue;
    }
    const closeout = t.closeout && !t.closeout.resolvedAt ? t.closeout : null;
    const botId = closeout ? closeout.botId : t.assigneeId;
    if (!botId) {
      out.skipped.push({ key, why: "nobody is assigned to it" });
      continue;
    }
    const bot = await c.bots.findOne({ _id: botId, orgId: actor.orgId });
    if (!bot) {
      out.skipped.push({ key, why: "it's assigned to a person, not a bot" });
      continue;
    }
    // VEC-352: a disabled bot isn't handed work. Leave its claim and any held wake-up as they are (no new one queued),
    // and say so, rather than queueing a wake that would only sit held.
    if (!isBotEnabled(bot)) {
      out.disabled.push({ kind: "bot_disabled", key, botId: hex(bot._id), bot: bot.name, why: disabledRetryWhy(bot.name) });
      continue;
    }
    if (!opts.force) {
      const last = await lastBotActivity(bot._id, t._id);
      const working = !!(await c.agentClaims.findOne({ botId: bot._id, taskId: t._id, kind: { $ne: "triage" }, state: "in_progress" }, { projection: { _id: 1 } }));
      if (last && (working || closeout) && Date.now() - last.getTime() < RETRY_QUIET_MS) {
        out.busy.push({ key, botId: hex(bot._id), lastAt: last.toISOString() });
        continue;
      }
    }

    // Forget the earlier hand-off, so it can be made again: a claim (working or finished) blocks both push pickup
    // and check_for_work, and a queued or failed wake-up would be re-sent beside the new one.
    if (closeout) {
      await c.tasks.updateOne({ _id: t._id, "closeout.botId": bot._id }, { $set: { "closeout.deliveredAt": null } });
      await c.botWakes.deleteMany({ botId: bot._id, taskId: t._id, kind: "closeout" });
    } else {
      await c.agentClaims.deleteMany({ botId: bot._id, taskId: t._id, kind: { $ne: "triage" } });
      await c.botWakes.deleteMany({ botId: bot._id, taskId: t._id, kind: { $in: ["assigned", "ready", "mentioned"] } });
    }
    const act: ActivityDoc = {
      _id: new ObjectId(),
      orgId: actor.orgId,
      taskId: t._id,
      actorId: actor.id,
      kind: "retried",
      to: hex(bot._id),
      ...(closeout ? { note: "closeout" as const } : {}),
      createdAt: new Date(),
    };
    await c.activity.insertOne(act);
    await publish(hex(actor.orgId), { type: "feed.add", actorId: hex(actor.id), taskId: hex(t._id), item: toFeed(act) });
    touched.push(t._id);

    if (bot.connection && isPush(bot.connection.method)) {
      const base = { taskId: t._id, taskKey: key, title: t.title, by, retry: true };
      wakeBots(actor.orgId, [bot._id], closeout ? { kind: "closeout", ...base, detail: "Nothing it depends on is open any more" } : { kind: "assigned", ...base });
    }
    // A polling bot gets it from its next check_for_work: no claim, so it's offered again.
    out.retried.push({ key, botId: hex(bot._id) });
  }

  // The working ring and Stalled badge clear now; the push pickup brings the ring back once the bot has it.
  if (touched.length) await publishWorking(actor.orgId, actor.id, touched);
  return out;
}

/** The open, ready tasks at the front of what `task` waits on (breadth-first through `waitingOn`). */
async function chainFront(orgId: ObjectId, task: TaskDoc): Promise<TaskDoc[]> {
  const c = await cols();
  const seen = new Set<string>([hex(task._id)]);
  const front: TaskDoc[] = [];
  let level = (task.waitingOn ?? []).filter((id) => !seen.has(hex(id)));
  while (level.length && seen.size < MAX_CHAIN) {
    level.forEach((id) => seen.add(hex(id)));
    const docs = await c.tasks.find({ _id: { $in: level }, orgId, archivedAt: null }).toArray();
    const cats = new Map(
      (await c.statuses.find({ _id: { $in: unique(docs.map((d) => d.statusId)) } }, { projection: { category: 1 } }).toArray()).map((s) => [hex(s._id), s.category]),
    );
    const next: ObjectId[] = [];
    for (const d of docs) {
      if (isClosedCategory(cats.get(hex(d.statusId)))) continue;
      if (d.waitingOn?.length) next.push(...d.waitingOn.filter((id) => !seen.has(hex(id))));
      else front.push(d);
    }
    level = unique(next);
  }
  return front;
}

/** When the bot last commented on or changed the task. */
async function lastBotActivity(botId: ObjectId, taskId: ObjectId): Promise<Date | null> {
  const c = await cols();
  const [comment] = await c.comments.find({ taskId, authorId: botId }, { projection: { createdAt: 1 } }).sort({ createdAt: -1 }).limit(1).toArray();
  const [act] = await c.activity.find({ taskId, actorId: botId, note: { $nin: [...PARENT_PROGRESS_NOTES] } }, { projection: { createdAt: 1 } }).sort({ createdAt: -1 }).limit(1).toArray();
  const times = [comment?.createdAt, act?.createdAt].filter((d): d is Date => !!d);
  return times.length ? new Date(Math.max(...times.map((d) => d.getTime()))) : null;
}

async function actorName(actor: Actor) {
  const c = await cols();
  const doc = actor.isBot ? await c.bots.findOne({ _id: actor.id }, { projection: { name: 1 } }) : await c.users.findOne({ _id: actor.id }, { projection: { name: 1 } });
  return doc?.name ?? "Someone";
}

function unique(ids: ObjectId[]): ObjectId[] {
  const m = new Map(ids.map((id) => [hex(id), id]));
  return [...m.values()];
}
