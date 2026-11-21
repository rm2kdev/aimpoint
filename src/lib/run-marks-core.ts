/**
 * Run marks (VEC-380): "this bot is working on this task right now" for a run that holds no in-progress claim.
 *
 * The working ring (Task.workingBotIds) comes from in-progress `agentClaims`, which only assigned / ready pickups,
 * triage and a mention that hands the work back to its assignee open. Every other run a bot starts on a task (a
 * question to a non-assignee bot or the triager, a mention on a closed, stopped, parked or waiting task, a close-out)
 * used to work with no ring at all. Those runs get a run mark instead: a doc in `runMarks` (one per bot and task),
 * kept apart from agentClaims on purpose, so it can never count as assigned work (check_for_work, list_my_tasks),
 * move the status, or feed Stalled and the run-watch follow-ups (run-stalled.ts, unfinished-runs.ts), which all
 * read claims only.
 *
 * A mark ends when the run does:
 * - claude-api / openai-api: the turn runs inside the delivery, so the mark is taken before it and dropped after.
 * - hermes-api with a run id: the sweep (lib/run-marks.ts) asks GET /v1/runs/{id}; a final status or 404 ends it.
 * - webhook, poll (check_for_work), or Hermes without a run id / unreachable: the bot going quiet ends it,
 *   QUIET_MS after its last sign of life on the task, or REPLIED_QUIET_MS once it has commented (it answered).
 * - complete_task / release_task on the task, a person stopping work on it, deleting it: dropped at once.
 * Every mark also carries `expiresAt`, and reads ignore expired marks, so a run that dies without a clean end (or a
 * sweep that never runs) can't leave the ring spinning: at most QUIET_MS after the last sign of life, and never past
 * MAX_MS from the start.
 *
 * Pure (no server imports) so `pnpm test` covers it (run-marks-core.test.mjs).
 */

/** The wake-ups that start a marked run. */
export type RunMarkKind = "mentioned" | "closeout";
/** How the run is observed: a push connection method, or "poll" for a check_for_work hand-out. */
export type RunMarkMethod = "claude-api" | "openai-api" | "hermes-api" | "webhook" | "poll";

export interface RunMark {
  kind: RunMarkKind;
  method: RunMarkMethod;
  /** The Hermes run the wake-up started, when Hermes returned one. */
  runId: string | null;
  startedAt: Date;
  /** The bot's last sign of life on the task (an MCP call on it); starts at startedAt. */
  seenAt: Date;
  /** When the bot last commented on the task during this run. */
  repliedAt: Date | null;
  expiresAt: Date;
}

/** A run nobody can observe is over once the bot has been quiet on the task this long. */
export const QUIET_MS = 10 * 60_000;
/** ...or this long once it has replied (commented): answering was the job. */
export const REPLIED_QUIET_MS = 2 * 60_000;
/** No mark outlives this, whatever Hermes says (the same backstop run-watch uses for a run stuck on "running"). */
export const MAX_MS = 3 * 60 * 60_000;

const HERMES_FINAL = new Set(["completed", "failed", "cancelled"]);
/** GET /v1/runs/{id}: a status string, "gone" (404), or null (couldn't ask). */
export type HermesState = string | "gone" | null;

/** When a mark with no live run to ask about expires: quiet since the last sign of life, capped at MAX_MS. */
export function markExpiry(m: Pick<RunMark, "startedAt" | "seenAt" | "repliedAt">): Date {
  const quiet = m.repliedAt && m.repliedAt.getTime() >= m.seenAt.getTime() ? REPLIED_QUIET_MS : QUIET_MS;
  const last = Math.max(m.seenAt.getTime(), m.repliedAt?.getTime() ?? 0);
  return new Date(Math.min(m.startedAt.getTime() + MAX_MS, last + quiet));
}

/** A fresh mark for a run starting now. */
export function newMark(kind: RunMarkKind, method: RunMarkMethod, now: Date, runId: string | null = null): RunMark {
  const m = { kind, method, runId, startedAt: now, seenAt: now, repliedAt: null };
  return { ...m, expiresAt: markExpiry(m) };
}

/** The mark after a sign of life from the bot on the task (`replied`: it posted a comment). */
export function touchMark(m: RunMark, now: Date, replied: boolean): Pick<RunMark, "seenAt" | "repliedAt" | "expiresAt"> {
  const next = { startedAt: m.startedAt, seenAt: now, repliedAt: replied ? now : m.repliedAt };
  // A Hermes run being followed keeps whatever the sweep last allowed it, so a comment can't cut a live run short.
  const quiet = markExpiry(next);
  const expiresAt = hermesFollowed(m) && m.expiresAt.getTime() > quiet.getTime() ? m.expiresAt : quiet;
  return { seenAt: next.seenAt, repliedAt: next.repliedAt, expiresAt };
}

/** Shown as working right now. */
export function markLive(m: Pick<RunMark, "expiresAt">, now: Date): boolean {
  return m.expiresAt.getTime() > now.getTime();
}

const hermesFollowed = (m: Pick<RunMark, "method" | "runId">) => m.method === "hermes-api" && !!m.runId;

export type MarkDecision =
  /** Ask Hermes how the run is doing, then decide again with the answer. */
  | { kind: "poll" }
  /** The run is over: drop the mark (and broadcast). */
  | { kind: "end" }
  /** Still going: store this expiry (unchanged when no different). */
  | { kind: "keep"; expiresAt: Date };

/** What the sweep does with one mark. `hermes`: the run's state when already asked (undefined = not yet). */
export function decideMark(m: RunMark, now: Date, hermes?: HermesState): MarkDecision {
  const cap = m.startedAt.getTime() + MAX_MS;
  if (now.getTime() >= cap) return { kind: "end" };
  if (hermesFollowed(m)) {
    if (hermes === undefined) return { kind: "poll" };
    if (hermes === "gone" || (typeof hermes === "string" && HERMES_FINAL.has(hermes))) return { kind: "end" };
    // Hermes says it's still going: keep it shown for another quiet window from now.
    if (typeof hermes === "string") return { kind: "keep", expiresAt: new Date(Math.min(cap, now.getTime() + QUIET_MS)) };
    // Couldn't ask (network, auth): fall back to the bot's own signs of life, and never shorten what was allowed.
    const quiet = markExpiry(m);
    const exp = m.expiresAt.getTime() > quiet.getTime() ? m.expiresAt : quiet;
    return exp.getTime() <= now.getTime() ? { kind: "end" } : { kind: "keep", expiresAt: exp };
  }
  const exp = markExpiry(m);
  return exp.getTime() <= now.getTime() ? { kind: "end" } : { kind: "keep", expiresAt: exp };
}

/** Bots working on each task: in-progress claims first (pickup order), then live marks; each bot once. */
export function mergeWorking(claims: Map<string, string[]>, marks: Map<string, string[]>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [task, ids] of claims) out.set(task, [...ids]);
  for (const [task, ids] of marks) {
    const list = out.get(task) ?? [];
    for (const id of ids) if (!list.includes(id)) list.push(id);
    out.set(task, list);
  }
  return out;
}
