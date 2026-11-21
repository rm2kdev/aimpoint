import "server-only";
import type { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { unseal } from "@/lib/secrets";
import { isPush } from "@/lib/bot-connect";
import { isBotEnabled } from "@/lib/bot-enabled";
import { hermesBase } from "@/lib/bot-dispatch";
import { dispatchWake } from "@/lib/wake-queue";
import { publishWorking } from "@/lib/claims";
import { isParked, loadTaskFlow } from "@/lib/flow-engine";
import { decideRun, type HermesRunState, type RunCheck } from "@/lib/run-watch-core";
import { isClosedCategory, type AgentClaimDoc, type BotDoc, type OrgDoc } from "@/lib/types";

/**
 * VEC-316 sweep: bot runs that ended without finishing their work (rules in lib/run-watch-core.ts). For every
 * watched in_progress claim it works out whether the run is over (direct APIs: recorded at delivery; Hermes: asks
 * GET /v1/runs/{id}; webhook: the bot went quiet) and then sends the ONE follow-up wake through the wake queue, or,
 * when the follow-up's run ended unfinished as well, marks the claim done + `unfinishedAt`: the task then shows as
 * Stalled "unfinished" and its people get one notification (lib/stalled-notice.ts, from the task.upsert).
 *
 * Rides on the wake sweep (sweepWakes in lib/wake-queue.ts: every 15 s in the server process, /api/cron/wakes on
 * Vercel), throttled to once per MIN_GAP_MS.
 */

const MIN_GAP_MS = 30_000;
const PER_SWEEP = 100;
const HERMES_TIMEOUT_MS = 8_000;


type Gate = { last?: number };
const g = globalThis as unknown as { __aimpointUnfinishedRuns?: Gate };

/** Throttled entry point for the wake sweep. */
export async function sweepUnfinishedRunsSoon() {
  const gate = (g.__aimpointUnfinishedRuns ??= {});
  if (gate.last && Date.now() - gate.last < MIN_GAP_MS) return null;
  gate.last = Date.now();
  return sweepUnfinishedRuns();
}

/** Asks the bot's Hermes how the run is doing. */
export async function hermesRunState(bot: BotDoc, runId: string): Promise<HermesRunState> {
  const conn = bot.connection;
  if (!conn?.url || !conn.secretSealed) return null;
  try {
    const res = await fetch(`${hermesBase(conn.url)}/v1/runs/${encodeURIComponent(runId)}`, {
      headers: { Authorization: `Bearer ${unseal(conn.secretSealed)}` },
      signal: AbortSignal.timeout(HERMES_TIMEOUT_MS),
    });
    if (res.status === 404) return "gone";
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { status?: unknown } | null;
    return typeof body?.status === "string" ? body.status : null;
  } catch {
    return null;
  }
}

/** The bot's latest comment or activity on the task. Moves Aimpoint made in the bot's name on hand-over (pickup to
 * In Progress, a mention resuming it) aren't the bot doing anything, so they don't count. */
async function lastActivity(botId: ObjectId, taskId: ObjectId): Promise<Date | null> {
  const c = await cols();
  const [cm, act] = await Promise.all([
    c.comments.find({ taskId, authorId: botId }, { projection: { createdAt: 1 } }).sort({ createdAt: -1 }).limit(1).next(),
    c.activity.find({ taskId, actorId: botId, note: { $nin: ["started_work", "resumed_work"] } }, { projection: { createdAt: 1 } }).sort({ createdAt: -1 }).limit(1).next(),
  ]);
  const t = Math.max(cm?.createdAt.getTime() ?? 0, act?.createdAt.getTime() ?? 0);
  return t ? new Date(t) : null;
}

export async function sweepUnfinishedRuns(): Promise<{ checked: number; followedUp: number; unfinished: number }> {
  const c = await cols();
  const claims = await c.agentClaims.find({ state: "in_progress", kind: { $ne: "triage" }, "watch.at": { $exists: true } }).sort({ "watch.at": 1 }).limit(PER_SWEEP).toArray();
  let followedUp = 0;
  let unfinished = 0;
  for (const claim of claims) {
    try {
      const r = await checkClaim(claim);
      if (r === "followup") followedUp++;
      if (r === "unfinished") unfinished++;
    } catch (err) {
      console.error("[unfinished runs]", err);
    }
  }
  return { checked: claims.length, followedUp, unfinished };
}

async function checkClaim(claim: AgentClaimDoc): Promise<"followup" | "unfinished" | null> {
  const c = await cols();
  const watch = claim.watch!;
  const clear = () => c.agentClaims.updateOne({ _id: claim._id, "watch.at": watch.at }, { $unset: { watch: "" } });
  const [task, bot, org] = await Promise.all([
    c.tasks.findOne({ _id: claim.taskId }, { projection: { description: 0 } }),
    c.bots.findOne({ _id: claim.botId }),
    c.orgs.findOne({ _id: claim.orgId }),
  ]);
  // The bot's connection no longer pushes (or is another method now): nothing Aimpoint could send it.
  if (!task || !bot || !org || !bot.connection || !isPush(bot.connection.method) || bot.connection.method !== watch.method) {
    await clear();
    return null;
  }
  // VEC-344: a disabled bot isn't followed up (or marked unfinished) while it's off; the watch stays, so the check
  // picks up again once it's enabled.
  if (!isBotEnabled(bot)) return null;
  const status = await c.statuses.findOne({ _id: task.statusId }, { projection: { category: 1, name: 1 } });
  const ctx = task.flow?.paused ? null : await loadTaskFlow(task);
  const input: RunCheck = {
    claim: { kind: claim.kind ?? "assigned", state: claim.state, watch, runId: claim.runId ?? null },
    task: {
      assignedToBot: !!task.assigneeId?.equals(bot._id),
      archived: !!task.archivedAt,
      stopped: !!task.stopped,
      closed: !status || isClosedCategory(status.category),
      triage: status?.category === "triage",
      waiting: !!task.waitingOn?.length,
      parked: status ? await isParked(task, status.category) : false,
    },
    flow: task.flow?.paused
      ? { kind: "step", wait: false, paused: true }
      : !ctx
        ? { kind: "none" }
        : !ctx.current
          ? { kind: "detached", paused: false }
          : { kind: "step", wait: ctx.current.advance === "wait", paused: false },
    lastBotActivity: await lastActivity(bot._id, task._id),
    now: new Date(),
  };
  let decision = decideRun(input);
  if (decision.kind === "poll") decision = decideRun(input, await hermesRunState(bot, claim.runId!));
  if (decision.kind === "none") {
    if (decision.clear) await clear();
    return null;
  }
  if (decision.kind === "poll") return null;
  const project = await c.projects.findOne({ _id: task.projectId }, { projection: { key: 1 } });
  const key = `${project?.key ?? "?"}-${task.number}`;
  if (decision.kind === "followup") {
    // Take it (one sender), and drop the old run id: the follow-up's own run id replaces it on delivery, and a
    // retry Hermes answers 409 to (no id) then falls back to the quiet timeout instead of re-reading the old run.
    const now = new Date();
    const took = await c.agentClaims.updateOne(
      { _id: claim._id, state: "in_progress", "watch.at": watch.at, "watch.followUpAt": null },
      { $set: { watch: { method: watch.method, at: now, endedAt: null, followUpAt: now }, runId: null } },
    );
    if (!took.modifiedCount) return null;
    console.info(`[unfinished runs] ${bot.name}'s run on ${key} ended without complete_task; sending the follow-up`);
    // Not awaited: a direct-API bot runs its whole turn inside the delivery, which would hold up the sweep.
    void dispatchWake(bot, org as OrgDoc, { kind: "assigned", taskId: task._id, taskKey: key, title: task.title, by: "Aimpoint", followUp: true }).catch((err) => console.error("[unfinished runs] follow-up", err));
    return "followup";
  }
  // The follow-up's run is over too: finished as "unfinished", so it shows as Stalled and isn't offered again.
  const now = new Date();
  const marked = await c.agentClaims.updateOne(
    { _id: claim._id, state: "in_progress", "watch.at": watch.at },
    { $set: { state: "done", finishedAt: now, unfinishedAt: now }, $unset: { watch: "" } },
  );
  if (!marked.modifiedCount) return null;
  console.info(`[unfinished runs] ${bot.name}'s follow-up run on ${key} also ended without complete_task: Stalled (unfinished)`);
  await publishWorking(org._id, bot._id, [task._id]);
  return "unfinished";
}
