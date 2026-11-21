import "server-only";
import { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { publishWorking } from "@/lib/claims";
import { decideMark, markLive, newMark, touchMark, type HermesState, type RunMarkKind, type RunMarkMethod } from "@/lib/run-marks-core";
import type { BotDoc } from "@/lib/types";

/**
 * VEC-380: run marks, the working ring for a run that holds no in-progress claim (a mention the bot answers as a
 * question, a close-out). Rules and lifetimes in lib/run-marks-core.ts; data.ts merges live marks into
 * `workingBotIds` after Stalled is worked out from claims alone. Every change that shows or clears a ring is
 * broadcast with publishWorking.
 */

/** The push methods whose turn runs inside the delivery request. */
export const directMethod = (m: string | undefined) => m === "claude-api" || m === "openai-api";

/**
 * A run on this task started for `botId`. Nothing to do when the bot already holds an in-progress claim on it (that
 * claim shows the ring, and ends with it). A newer wake on the same task replaces the old mark.
 */
export async function startRunMark(orgId: ObjectId, botId: ObjectId, taskId: ObjectId, kind: RunMarkKind, method: RunMarkMethod, runId: string | null = null): Promise<void> {
  try {
    const c = await cols();
    const [task, claim] = await Promise.all([
      c.tasks.findOne({ _id: taskId, orgId }, { projection: { _id: 1 } }),
      c.agentClaims.findOne({ botId, taskId, state: "in_progress" }, { projection: { _id: 1 } }),
    ]);
    if (!task || claim) return;
    const now = new Date();
    const before = await c.runMarks.findOneAndUpdate(
      { botId, taskId },
      { $set: { orgId, ...newMark(kind, method, now, runId) }, $setOnInsert: { _id: new ObjectId() } },
      { upsert: true, returnDocument: "before" },
    );
    if (!before || !markLive(before, now)) await publishWorking(orgId, botId, [taskId]);
  } catch (err) {
    // Best-effort, like the ring itself: the run goes ahead either way.
    console.error("[run marks] start failed", err);
  }
}

/** The Hermes run the wake-up started, so the sweep can tell when it's over. */
export async function setRunMarkRun(botId: ObjectId, taskId: ObjectId, runId: string) {
  await (await cols()).runMarks.updateOne({ botId, taskId }, { $set: { runId } });
}

/**
 * The run is over (or its work was handed back / stopped / deleted): drop the marks matching `filter` and broadcast
 * the tasks whose ring changed. `publish: false` when the caller's own task.upsert follows and already carries it.
 * Returns the task ids that had a live mark.
 */
export async function endRunMarks(orgId: ObjectId, actorId: ObjectId, filter: { botId?: ObjectId; taskId?: ObjectId | { $in: ObjectId[] } }, opts: { publish?: boolean } = {}): Promise<ObjectId[]> {
  try {
    const c = await cols();
    const now = new Date();
    const marks = await c.runMarks.find({ orgId, ...filter }, { projection: { taskId: 1, expiresAt: 1 } }).toArray();
    if (!marks.length) return [];
    await c.runMarks.deleteMany({ _id: { $in: marks.map((m) => m._id) } });
    const live = [...new Map(marks.filter((m) => markLive(m, now)).map((m) => [m.taskId.toHexString(), m.taskId])).values()];
    if (live.length && opts.publish !== false) await publishWorking(orgId, actorId, live);
    return live;
  } catch (err) {
    console.error("[run marks] end failed", err);
    return [];
  }
}

/** A sign of life from the bot on the task (an MCP call on it; `replied`: it commented): keeps its mark alive. */
export async function touchRunMark(botId: ObjectId, taskId: ObjectId, replied: boolean) {
  try {
    const c = await cols();
    const m = await c.runMarks.findOne({ botId, taskId });
    const now = new Date();
    if (!m || !markLive(m, now)) return;
    await c.runMarks.updateOne({ _id: m._id, startedAt: m.startedAt }, { $set: touchMark(m, now, replied) });
  } catch (err) {
    console.error("[run marks] touch failed", err);
  }
}

/* ---------------- sweep ---------------- */

const MIN_GAP_MS = 10_000;
const PER_SWEEP = 200;
type Gate = { last?: number };
const g = globalThis as unknown as { __aimpointRunMarks?: Gate };

/** Throttled entry point for the wake sweep (every 15 s in the server process, /api/cron/wakes on Vercel). */
export async function sweepRunMarksSoon() {
  const gate = (g.__aimpointRunMarks ??= {});
  if (gate.last && Date.now() - gate.last < MIN_GAP_MS) return null;
  gate.last = Date.now();
  return sweepRunMarks();
}

/** Ends the marks whose run is over (Hermes says so, the bot went quiet, or they expired) and broadcasts them. */
export async function sweepRunMarks(): Promise<{ checked: number; ended: number }> {
  const c = await cols();
  const marks = await c.runMarks.find({}).sort({ expiresAt: 1 }).limit(PER_SWEEP).toArray();
  let ended = 0;
  const bots = new Map<string, BotDoc | null>();
  for (const m of marks) {
    try {
      const now = new Date();
      let d = decideMark(m, now);
      if (d.kind === "poll") {
        const k = m.botId.toHexString();
        if (!bots.has(k)) bots.set(k, await c.bots.findOne({ _id: m.botId }));
        const bot = bots.get(k);
        const state: HermesState = bot?.connection?.method === "hermes-api" ? await (await import("./unfinished-runs")).hermesRunState(bot, m.runId!) : "gone";
        d = decideMark(m, new Date(), state);
      }
      if (d.kind === "keep") {
        if (d.expiresAt.getTime() !== m.expiresAt.getTime()) await c.runMarks.updateOne({ _id: m._id, startedAt: m.startedAt }, { $set: { expiresAt: d.expiresAt } });
        continue;
      }
      if (d.kind !== "end") continue;
      // Only this run's mark: a newer wake may have replaced it meanwhile.
      const gone = await c.runMarks.deleteOne({ _id: m._id, startedAt: m.startedAt });
      if (!gone.deletedCount) continue;
      ended++;
      await publishWorking(m.orgId, m.botId, [m.taskId]);
    } catch (err) {
      console.error("[run marks sweep]", err);
    }
  }
  return { checked: marks.length, ended };
}
