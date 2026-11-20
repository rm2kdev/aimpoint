// Run with `pnpm test` (node --test; Node strips the TypeScript types of the .ts modules).
// VEC-316: when a bot's run ended without complete_task, and what Aimpoint does about it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRun, exempt, finishedAtStep, followUpText, hermesRunOver, isUnfinishedClaim, ENDED_GRACE_MS, HERMES_BACKSTOP_MS, QUIET_MS } from "./run-watch-core.ts";

const T0 = new Date("2026-11-20T10:00:00Z");
const at = (ms) => new Date(T0.getTime() + ms);
const MIN = 60_000;

/** A watched in_progress claim on a ready, open task assigned to the bot, on an ordinary flow step. */
function check({ method = "webhook", endedAt = null, followUpAt = null, runId = null, now = at(0), last = null, claim = {}, task = {}, flow = { kind: "step", wait: false, paused: false }, watch } = {}) {
  return {
    claim: { kind: "assigned", state: "in_progress", runId, watch: watch === undefined ? { method, at: T0, endedAt, followUpAt } : watch, ...claim },
    task: { assignedToBot: true, archived: false, stopped: false, closed: false, triage: false, waiting: false, parked: false, ...task },
    flow,
    lastBotActivity: last,
    now,
  };
}

test("direct API turn: follow-up once the ended run is past the grace period", () => {
  for (const method of ["claude-api", "openai-api"]) {
    assert.equal(decideRun(check({ method, endedAt: T0, now: at(ENDED_GRACE_MS - 1) })).kind, "none");
    assert.equal(decideRun(check({ method, endedAt: T0, now: at(ENDED_GRACE_MS) })).kind, "followup");
  }
  // A direct turn without endedAt is still running (deliver() hasn't returned).
  assert.equal(decideRun(check({ method: "claude-api", now: at(10 * 60 * MIN) })).kind, "none");
});

test("follow-up's run ended too: unfinished", () => {
  assert.equal(decideRun(check({ method: "claude-api", endedAt: T0, followUpAt: T0, now: at(ENDED_GRACE_MS) })).kind, "unfinished");
});

test("hermes: poll while running, follow up when the run is completed, failed, cancelled or gone", () => {
  const c = check({ method: "hermes-api", runId: "run_1", now: at(MIN) });
  assert.equal(decideRun(c).kind, "poll");
  for (const s of ["queued", "running", "waiting_for_approval", null]) assert.equal(decideRun(c, s).kind, "none", String(s));
  for (const s of ["completed", "failed", "cancelled", "gone"]) assert.equal(decideRun(c, s).kind, "followup", s);
  assert.equal(decideRun(check({ method: "hermes-api", runId: "run_2", followUpAt: T0, now: at(MIN) }), "completed").kind, "unfinished");
  assert.ok(hermesRunOver("gone") && !hermesRunOver(null) && !hermesRunOver("running"));
});

test("hermes backstop: still 'running' for hours with a quiet bot counts as over", () => {
  const long = check({ method: "hermes-api", runId: "r", now: at(HERMES_BACKSTOP_MS), last: at(HERMES_BACKSTOP_MS - QUIET_MS) });
  assert.equal(decideRun(long, "running").kind, "followup");
  const chatty = check({ method: "hermes-api", runId: "r", now: at(HERMES_BACKSTOP_MS), last: at(HERMES_BACKSTOP_MS - MIN) });
  assert.equal(decideRun(chatty, "running").kind, "none");
  // Hermes unreachable (null) also falls to the backstop.
  assert.equal(decideRun(long, null).kind, "followup");
});

test("hermes without a run id (a 409'd retry) and webhooks: quiet timeout since the delivery or the last sign of life", () => {
  for (const method of ["webhook", "hermes-api"]) {
    assert.equal(decideRun(check({ method, now: at(QUIET_MS - 1) })).kind, "none", method);
    assert.equal(decideRun(check({ method, now: at(QUIET_MS) })).kind, "followup", method);
    assert.equal(decideRun(check({ method, now: at(QUIET_MS + 5 * MIN), last: at(10 * MIN) })).kind, "none", method);
    assert.equal(decideRun(check({ method, now: at(QUIET_MS + 10 * MIN), last: at(10 * MIN) })).kind, "followup", method);
  }
});

test("runs that called complete_task or release_task, and claims without a watch, are left alone", () => {
  assert.deepEqual(decideRun(check({ method: "claude-api", endedAt: T0, now: at(MIN), claim: { state: "done" } })), { kind: "none", clear: true });
  assert.deepEqual(decideRun(check({ watch: null, now: at(10 * QUIET_MS) })), { kind: "none" });
  // (release_task deletes the claim, so the sweep never sees it.)
});

test("exempt: triage claims, wait steps, paused / detached flows, stopped / parked / closed / not-ready / reassigned tasks", () => {
  const ended = { method: "claude-api", endedAt: T0, now: at(MIN) };
  const cases = {
    triage: { claim: { kind: "triage" } },
    stoppedClaim: { claim: { state: "stopped" } },
    wait: { flow: { kind: "step", wait: true, paused: false } },
    paused: { flow: { kind: "step", wait: false, paused: true } },
    detached: { flow: { kind: "detached", paused: false } },
    stopped: { task: { stopped: true } },
    parked: { task: { parked: true } },
    closed: { task: { closed: true } },
    inTriage: { task: { triage: true } },
    waiting: { task: { waiting: true } },
    archived: { task: { archived: true } },
    reassigned: { task: { assignedToBot: false } },
  };
  for (const [name, over] of Object.entries(cases)) {
    const c = check({ ...ended, ...over });
    assert.ok(exempt(c), name);
    assert.deepEqual(decideRun(c), { kind: "none", clear: true }, name);
  }
  // No flow at all (flows off) is followed up like any work.
  assert.equal(decideRun(check({ ...ended, flow: { kind: "none" } })).kind, "followup");
});

test("isUnfinishedClaim: marked by the sweep, cleared by a later complete_task or a pickup", () => {
  assert.ok(isUnfinishedClaim({ state: "done", unfinishedAt: T0, finishedAt: T0 }));
  assert.ok(!isUnfinishedClaim({ state: "done", unfinishedAt: T0, finishedAt: at(1) }), "complete_task afterwards");
  assert.ok(!isUnfinishedClaim({ state: "in_progress", unfinishedAt: T0, finishedAt: null }), "picked up again");
  assert.ok(!isUnfinishedClaim({ state: "done", finishedAt: T0 }), "an ordinary finish");
});

test("finishedAtStep: a driven, non-wait, non-last step with no hand-off", () => {
  const base = { driven: true, wait: false, paused: false, lastStep: false, waiting: false, closeoutPending: false };
  assert.ok(finishedAtStep(base));
  for (const k of ["wait", "paused", "lastStep", "waiting", "closeoutPending"]) assert.ok(!finishedAtStep({ ...base, [k]: true }), k);
  assert.ok(!finishedAtStep({ ...base, driven: false }), "the seeded default flow");
});

test("followUpText names the step and the flow's finish, or the done status without a flow", () => {
  const flow = followUpText({ key: "MAR-1", title: "Plan", org: "Acme", status: "Research", step: { name: "Research", number: 3, of: 5 }, finish: "When your part is done, call complete_task without a status: that moves it to Draft.", done: "Done" });
  assert.match(flow, /still at step 3 of 5, "Research" \(Research\)/);
  assert.match(flow, /If the work is finished: when your part is done, call complete_task without a status/);
  assert.match(flow, /only reminder/);
  const plain = followUpText({ key: "WEB-2", title: "Fix", org: "Acme", status: "In Progress", step: null, finish: null, done: "Shipped" });
  assert.match(plain, /still open in In Progress/);
  assert.match(plain, /complete_task on WEB-2 now with status "Shipped"/);
});
