/**
 * Runs that end without finishing their work (VEC-316). A bot can end its run having said "done" in chat without
 * calling complete_task: its claim stays in_progress and the task sits at its step for ever. Every push delivery of
 * work (assigned / ready / a mention that hands the work back) puts a `watch` on the bot's claim; the sweep in
 * lib/unfinished-runs.ts decides from it, with the pure rules below, when the run is over and what to do:
 *
 * 1. the run ended and the claim is still in_progress: ONE follow-up wake ("still at <step>, finish with
 *    complete_task or say what blocks it");
 * 2. the follow-up's run also ended unfinished: the claim is marked done with `unfinishedAt`, so the task shows as
 *    Stalled "unfinished" (whether or not anything waits on it) and its people are told once.
 *
 * When a run is over, per connection method:
 * - claude-api / openai-api: the turn runs inside the delivery request, so it is over when the request returns.
 * - hermes-api: the delivery returns a run id; GET /v1/runs/{id} says queued/running/... or completed / failed /
 *   cancelled (404 once Hermes swept it, also over). Without a run id (a retry Hermes answered 409) it falls back to
 *   the quiet timeout, and so does a run Hermes keeps reporting as running for longer than HERMES_BACKSTOP_MS.
 * - webhook: nothing to observe, so the claim counts as over once the bot has been quiet (no comment, no activity
 *   on the task) for QUIET_MS since the delivery or its last sign of life.
 *
 * No follow-up for: claims without a watch (poll bots, anything claimed before this shipped), triage claims, wait
 * steps, paused or detached flows, stopped / parked / closed / archived / not-ready tasks, reassigned tasks, or a run
 * that did call complete_task (claim done) or release_task (claim gone).
 *
 * Pure (no server imports) so `pnpm test` covers it (run-watch-core.test.mjs).
 */

export type WatchMethod = "claude-api" | "openai-api" | "hermes-api" | "webhook";

/** What a work delivery recorded on the bot's claim (AgentClaimDoc.watch). */
export interface RunWatch {
  method: WatchMethod;
  /** When the delivery that started the watched run went out. */
  at: Date;
  /** When Aimpoint saw the run end (direct APIs: when the turn returned; Hermes: when the run reported a final status). */
  endedAt: Date | null;
  /** Set on the follow-up wake's own watch: this run already is the one reminder. */
  followUpAt: Date | null;
}

/** A bot that went quiet this long after a delivery it can't be observed on (webhook) has ended its run. */
export const QUIET_MS = 30 * 60_000;
/** A Hermes run still "running" after this long, with the bot quiet for QUIET_MS, counts as over too. */
export const HERMES_BACKSTOP_MS = 3 * 60 * 60_000;
/** Leave a just-ended run this long before acting, so a tool call that raced the run's end lands first. */
export const ENDED_GRACE_MS = 20_000;

/** Final statuses of a Hermes run (GET /v1/runs/{id}). Anything else (queued, running, waiting_for_approval, ...) is live. */
export const HERMES_FINAL = new Set(["completed", "failed", "cancelled"]);

/** Hermes's answer to GET /v1/runs/{id}: `null` = couldn't ask (network, auth), `"gone"` = 404. */
export type HermesRunState = string | "gone" | null;

export const hermesRunOver = (s: HermesRunState) => s === "gone" || (typeof s === "string" && HERMES_FINAL.has(s));

/** Everything the decision needs about one claim and its task, gathered by the sweep. */
export interface RunCheck {
  claim: {
    kind: "assigned" | "triage";
    state: "in_progress" | "done" | "stopped";
    watch: RunWatch | null;
    /** The Hermes run the delivery started (AgentClaimDoc.runId). */
    runId: string | null;
  };
  task: {
    /** The claim's bot is still the assignee. */
    assignedToBot: boolean;
    archived: boolean;
    stopped: boolean;
    /** done or cancelled */
    closed: boolean;
    triage: boolean;
    /** Waiting on open dependencies of its own (not ready): the ready hand-off gives it back. */
    waiting: boolean;
    parked: boolean;
  };
  /** The task's flow position: no flow, on a step, or off it (detached). */
  flow: { kind: "none" } | { kind: "step"; wait: boolean; paused: boolean } | { kind: "detached"; paused: boolean };
  /** The bot's latest comment / activity on the task (or null). */
  lastBotActivity: Date | null;
  now: Date;
}

export type RunDecision =
  /** Nothing to do (not watched, finished, or exempt). `clear`: the watch no longer applies, drop it. */
  | { kind: "none"; clear?: boolean }
  /** A Hermes run whose status needs asking. */
  | { kind: "poll" }
  /** The run is over and the claim still open: send the one follow-up. */
  | { kind: "followup" }
  /** The follow-up's run is over too: mark the claim unfinished (Stalled). */
  | { kind: "unfinished" };

/** Exempt from follow-ups whatever the run did (the watch is cleared so the sweep stops looking). */
export function exempt(i: Pick<RunCheck, "claim" | "task" | "flow">): boolean {
  if (i.claim.kind === "triage" || i.claim.state !== "in_progress") return true;
  const t = i.task;
  if (!t.assignedToBot || t.archived || t.stopped || t.closed || t.triage || t.waiting || t.parked) return true;
  if (i.flow.kind === "detached") return true;
  if (i.flow.kind === "step" && (i.flow.wait || i.flow.paused)) return true;
  return false;
}

/** Quiet long enough since the delivery and the bot's last sign of life. */
const quietFor = (i: Pick<RunCheck, "claim" | "lastBotActivity" | "now">, ms: number) => {
  const since = Math.max(i.claim.watch!.at.getTime(), i.lastBotActivity?.getTime() ?? 0);
  return i.now.getTime() - since >= ms;
};

/**
 * What the sweep does with one claim. `hermes`: the run's state when the sweep already asked Hermes (undefined =
 * not asked yet; the decision is then `poll` when asking could end it).
 */
export function decideRun(i: RunCheck, hermes?: HermesRunState): RunDecision {
  const w = i.claim.watch;
  if (!w) return { kind: "none" };
  if (exempt(i)) return { kind: "none", clear: true };
  let ended: Date | null = w.endedAt;
  if (!ended) {
    if (w.method === "hermes-api" && i.claim.runId) {
      if (hermes === undefined) return { kind: "poll" };
      if (hermesRunOver(hermes)) ended = i.now;
      else if (i.now.getTime() - w.at.getTime() >= HERMES_BACKSTOP_MS && quietFor(i, QUIET_MS)) ended = i.now;
    } else if (w.method === "webhook" || w.method === "hermes-api") {
      if (quietFor(i, QUIET_MS)) ended = i.now;
    }
    // claude-api / openai-api record endedAt when the turn returns; until then the turn is still running.
  }
  if (!ended || i.now.getTime() - ended.getTime() < (w.endedAt ? ENDED_GRACE_MS : 0)) return { kind: "none" };
  return w.followUpAt ? { kind: "unfinished" } : { kind: "followup" };
}

/** A claim the sweep marked unfinished, and not finished (complete_task) or picked up again since. */
export function isUnfinishedClaim(c: { state: string; unfinishedAt?: Date | null; finishedAt?: Date | null }): boolean {
  if (c.state !== "done" || !c.unfinishedAt) return false;
  return !c.finishedAt || c.finishedAt.getTime() <= c.unfinishedAt.getTime();
}

/**
 * A flow task whose bot finished (claim done) while the task stays at the same step with no hand-off: Stalled
 * "finished" even when nothing waits on it (VEC-316). Only on a step the flow drives (not the seeded default), not a
 * wait step, not paused, and not while it waits on its own dependencies or a close-out of it is pending.
 */
export function finishedAtStep(i: { driven: boolean; wait: boolean; paused: boolean; lastStep: boolean; waiting: boolean; closeoutPending: boolean }): boolean {
  return i.driven && !i.wait && !i.paused && !i.lastStep && !i.waiting && !i.closeoutPending;
}

/** Where the task sits, for the follow-up prompt. */
export interface FollowUpWhere {
  key: string;
  title: string;
  org: string;
  /** The task's status name. */
  status: string;
  /** Its flow step when the flow drives it. */
  step: { name: string; number: number; of: number } | null;
  /** The flow's own finish sentence for that step (flowBriefing.finish), when there is one. */
  finish: string | null;
  /** The project's done status name. */
  done: string;
}

/** The follow-up wake's opening paragraphs. */
export function followUpText(w: FollowUpWhere): string {
  const at = w.step ? `still at step ${w.step.number} of ${w.step.of}, "${w.step.name}" (${w.status})` : `still open in ${w.status}`;
  const finish = w.finish
    ? `If the work is finished: ${w.finish.charAt(0).toLowerCase()}${w.finish.slice(1)}`
    : `If the work is finished, call complete_task on ${w.key} now with status "${w.done}" (or a review status only when a named person must check something, with a <@id> mention of them).`;
  return [
    `Your last run on ${w.key} "${w.title}" in Aimpoint (${w.org}) ended, but the task is ${at} and your claim on it is still open: Aimpoint never saw complete_task or release_task, so nothing moved. Saying you're done in chat doesn't move the task; only the tools do.`,
    `${finish} Add a short comment saying what was done. If something blocks it, add_comment saying what and @mention whoever must act (<@id>), then complete_task (or release_task to hand it back). If you're part way through, carry on and finish with complete_task.`,
    `This is the only reminder: if this run also ends without complete_task or release_task, the task shows as Stalled and its people are told.`,
  ].join("\n\n");
}
