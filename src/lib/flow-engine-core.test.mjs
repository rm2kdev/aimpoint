// Run with `pnpm test` (node --test; Node strips the TypeScript types of the .ts modules).
// Flow engine decisions (VEC-175): a 4-step dev flow (Develop > Test > Deploy > Done) and a flow that ends at a
// person (Outreach > Planning > Sign-off > Won), driven through the same pure rules lib/flow-engine.ts applies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveFlowSteps, DEFAULT_FLOW_STEPS } from "./flow-model.ts";
import { flowIsActive, locateStep, moveNote, nextStepOf, ownerPlan, requiredBetween, stepById, syncByStatus, workingStatus } from "./flow-engine-core.ts";

const S = (id, name, category, order) => ({ id, name, category, order });
const HERMES = "b".repeat(24);
const TESTER = "c".repeat(24);
const CICD = "d".repeat(24);
const OUTREACH = "e".repeat(24);
const PLANNER = "f".repeat(24);
const SOFIA = "a".repeat(24);
const dir = {
  bots: new Map([[HERMES, "Hermes"], [TESTER, "Testing Verification"], [CICD, "CI/CD Bot"], [OUTREACH, "Outreach Bot"], [PLANNER, "Planning Bot"]]),
  people: new Map([[SOFIA, "Sofia Ortega"]]),
};

const dev = [
  S("bk", "Backlog", "backlog", 0),
  S("tr", "Triage", "triage", 1),
  S("todo", "Todo", "unstarted", 2),
  S("prog", "In Progress", "started", 3),
  S("rev", "In Review", "started", 4),
  S("dep", "Deploying", "started", 5),
  S("done", "Done", "done", 6),
  S("x", "Cancelled", "cancelled", 7),
];
const st = (id, list = dev) => list.find((s) => s.id === id);
const step = (id, name, statusId, owner, extra = {}, list = dev) => ({ id, name, status: { statusId, stage: st(statusId, list)?.category ?? "started" }, owner, advance: "complete", required: true, next: null, ...extra });

const devFlow = resolveFlowSteps(
  [
    step("develop", "Develop", "todo", { kind: "bot", id: HERMES }, { instructions: "Implement; tsc + lint; commit." }),
    step("test", "Test", "rev", { kind: "bot", id: TESTER }, { instructions: "Verify each acceptance criterion." }),
    step("deploy", "Deploy", "dep", { kind: "bot", id: CICD }),
    step("done", "Done", "done", { kind: "none" }),
  ],
  dev,
  dir,
  { source: "project", version: 3 },
);

/**
 * The engine's moves as a tiny state machine over a task {statusId, stepId, assignee}:
 * pickup (markStartedByBot), complete (complete_task without a status), set (an explicit status).
 */
function machine(flow, statuses, task, actorIsBot = true) {
  const owner = (s, keepId) => {
    const p = ownerPlan(s);
    return p.kind === "set" ? p.id : keepId;
  };
  return {
    task,
    pickup() {
      const cur = locateStep(flow, st(task.statusId, statuses), task.stepId);
      const to = cur && workingStatus(flow, cur, statuses);
      const status = st(task.statusId, statuses);
      if (to && (status.category === "backlog" || status.category === "unstarted")) task.statusId = to.id;
      return task;
    },
    complete() {
      const cur = locateStep(flow, st(task.statusId, statuses), task.stepId);
      const next = cur && nextStepOf(flow, cur);
      if (!next) return { moved: false };
      task.note = moveNote(flow, cur, next);
      task.statusId = next.status.id;
      task.stepId = next.id;
      task.assignee = owner(next, task.assignee);
      return { moved: true, to: next };
    },
    set(statusId) {
      const cur = locateStep(flow, st(task.statusId, statuses), task.stepId);
      const r = syncByStatus({ flow, current: cur, status: st(statusId, statuses) });
      if (r.kind === "step" && actorIsBot && cur) {
        const skipped = requiredBetween(flow, cur, r.step);
        if (skipped.length) throw new Error(`${skipped[0].name} still has to run`);
      }
      task.statusId = statusId;
      if (r.kind === "detach") task.stepId = null;
      if (r.kind === "step") {
        task.note = moveNote(flow, cur, r.step);
        task.stepId = r.step.id;
        task.assignee = owner(r.step, task.assignee);
      }
      return r;
    },
  };
}

test("4-step dev flow resolves onto the project's statuses with owners", () => {
  assert.deepEqual(devFlow.steps.map((s) => `${s.name}:${s.status.name}`), ["Develop:Todo", "Test:In Review", "Deploy:Deploying", "Done:Done"]);
  assert.equal(devFlow.hasIssues, false);
  assert.ok(devFlow.steps.filter((s) => s.status.category !== "done").every((s) => flowIsActive(devFlow, s)));
});

test("4-step dev flow: develop -> test -> deploy -> done, each owner handed it in turn", () => {
  const m = machine(devFlow, dev, { statusId: "todo", stepId: "develop", assignee: HERMES });
  // Hermes picks it up: Todo -> In Progress (the first started status no later step uses; In Review and Deploying are taken).
  assert.equal(m.pickup().statusId, "prog");
  // complete_task without a status from In Progress (still the Develop step): to In Review, tester assigned.
  let r = m.complete();
  assert.equal(r.to.name, "Test");
  assert.deepEqual([m.task.statusId, m.task.assignee, m.task.note], ["rev", TESTER, "advanced"]);
  // The tester's pickup leaves In Review alone (a started-stage step).
  assert.equal(m.pickup().statusId, "rev");
  r = m.complete();
  assert.deepEqual([r.to.name, m.task.statusId, m.task.assignee], ["Deploy", "dep", CICD]);
  assert.equal(m.pickup().statusId, "dep");
  r = m.complete();
  // The done step closes it and keeps the assignee (closing never unassigns whoever did the work).
  assert.deepEqual([r.to.name, m.task.statusId, m.task.assignee], ["Done", "done", CICD]);
  assert.equal(m.complete().moved, false, "nothing after the done step");
});

test("4-step dev flow: the tester sends it back with an explicit earlier status", () => {
  const m = machine(devFlow, dev, { statusId: "rev", stepId: "test", assignee: TESTER });
  const r = m.set("todo");
  assert.equal(r.kind, "step");
  assert.deepEqual([m.task.stepId, m.task.assignee, m.task.note], ["develop", HERMES, "back"]);
});

test("4-step dev flow: a bot can't skip a required step, a person can", () => {
  const bot = machine(devFlow, dev, { statusId: "prog", stepId: "develop", assignee: HERMES });
  assert.throws(() => bot.set("done"), /Test still has to run/);
  assert.equal(bot.task.statusId, "prog", "refused: nothing changed");
  const person = machine(devFlow, dev, { statusId: "prog", stepId: "develop", assignee: HERMES }, false);
  person.set("done");
  assert.deepEqual([person.task.statusId, person.task.stepId, person.task.assignee], ["done", "done", HERMES]);
  // An optional step in between may be skipped by a bot.
  const optional = resolveFlowSteps(
    [step("develop", "Develop", "todo", { kind: "bot", id: HERMES }), step("test", "Test", "rev", { kind: "bot", id: TESTER }, { required: false }), step("done", "Done", "done", { kind: "none" })],
    dev,
    dir,
    { source: "project", version: 1 },
  );
  const m = machine(optional, dev, { statusId: "prog", stepId: "develop", assignee: HERMES });
  m.set("done");
  assert.equal(m.task.stepId, "done");
});

test("person drags a card: sync to the step of that status and apply its owner; within-step moves change nothing", () => {
  const m = machine(devFlow, dev, { statusId: "todo", stepId: "develop", assignee: HERMES }, false);
  assert.equal(m.set("prog").kind, "stay", "Todo -> In Progress stays on Develop");
  assert.equal(m.task.assignee, HERMES);
  assert.equal(m.set("rev").kind, "step");
  assert.deepEqual([m.task.stepId, m.task.assignee], ["test", TESTER]);
  // Back to In Progress (no step uses it): it belongs to Develop, so that's a send-back to Hermes.
  m.set("prog");
  assert.deepEqual([m.task.stepId, m.task.assignee, m.task.note], ["develop", HERMES, "back"]);
  // Cancelled is never a step: the task leaves the flow.
  assert.equal(m.set("x").kind, "detach");
  assert.equal(m.task.stepId, null);
  // Backlog (no step, nothing before it): detached too.
  assert.equal(syncByStatus({ flow: devFlow, current: null, status: st("bk") }).kind, "detach");
});

test("unpositioned tasks are located lazily by status", () => {
  assert.equal(locateStep(devFlow, st("todo")).id, "develop");
  assert.equal(locateStep(devFlow, st("prog")).id, "develop", "In Progress is Develop's working status");
  assert.equal(locateStep(devFlow, st("rev")).id, "test");
  assert.equal(locateStep(devFlow, st("x")), null);
  assert.equal(locateStep(devFlow, st("rev"), "deploy").id, "deploy", "a recorded step wins over the status");
});

/* ---------------- a flow ending at a person ---------------- */

const bld = [
  S("tri", "Triage", "triage", 0),
  S("lead", "New lead", "unstarted", 1),
  S("out", "Outreach", "started", 2),
  S("plan", "Planning", "started", 3),
  S("sign", "Client sign-off", "started", 4),
  S("won", "Won", "done", 5),
  S("lost", "Lost", "cancelled", 6),
];
const bstep = (id, name, statusId, owner, extra = {}) => step(id, name, statusId, owner, extra, bld);
const humanFlow = resolveFlowSteps(
  [
    bstep("outreach", "Outreach", "lead", { kind: "bot", id: OUTREACH }, { instructions: "Email the lead." }),
    bstep("planning", "Planning", "plan", { kind: "bot", id: PLANNER }),
    bstep("signoff", "Sign-off", "sign", { kind: "person", id: SOFIA }, { advance: "manual" }),
    bstep("won", "Won", "won", { kind: "none" }),
  ],
  bld,
  dir,
  { source: "project", version: 1 },
);

test("flow ending at a person: bots hand on, then the person owns sign-off and closes it", () => {
  assert.deepEqual(humanFlow.steps.map((s) => s.status.name), ["New lead", "Planning", "Client sign-off", "Won"]);
  const m = machine(humanFlow, bld, { statusId: "lead", stepId: "outreach", assignee: OUTREACH });
  // Pickup from New lead goes to Outreach (the first started status no later step uses).
  assert.equal(m.pickup().statusId, "out");
  let r = m.complete();
  assert.deepEqual([r.to.name, m.task.statusId, m.task.assignee], ["Planning", "plan", PLANNER]);
  r = m.complete();
  assert.deepEqual([r.to.name, m.task.statusId, m.task.assignee], ["Sign-off", "sign", SOFIA]);
  assert.equal(r.to.owner.kind, "person", "a human step: the person is assigned (notified), no bot woken");
  // Sofia finishes by moving it to Won (a person's status change syncs to the done step).
  const p = machine(humanFlow, bld, m.task, false);
  assert.equal(p.set("won").kind, "step");
  assert.deepEqual([p.task.stepId, p.task.statusId, p.task.assignee], ["won", "won", SOFIA]);
});

test("flow ending at a person: a bot can't finish it past the person's required step", () => {
  const m = machine(humanFlow, bld, { statusId: "plan", stepId: "planning", assignee: PLANNER });
  assert.throws(() => m.set("won"), /Sign-off still has to run/);
  // Lost (cancelled) is always allowed and leaves the flow.
  assert.equal(m.set("lost").kind, "detach");
});

/* ---------------- the seeded default stays behaviour-preserving ---------------- */

test("default flow: keep/triage owners never reassign, the done step never unassigns, nothing is 'active'", () => {
  const std = [S("s0", "Backlog", "backlog", 0), S("s1", "Triage", "triage", 1), S("s2", "Todo", "unstarted", 2), S("s3", "In Progress", "started", 3), S("s4", "In Review", "started", 4), S("s5", "Done", "done", 5), S("s6", "Cancelled", "cancelled", 6)];
  const flow = resolveFlowSteps(DEFAULT_FLOW_STEPS, std, dir, { source: "org", version: 1 });
  assert.ok(flow.steps.every((s) => ownerPlan(s).kind === "keep"));
  assert.ok(flow.steps.every((s) => !flowIsActive(flow, s)));
  // A bot passing Done from Build is fine: Review is optional.
  assert.deepEqual(requiredBetween(flow, stepById(flow, "build"), stepById(flow, "done")), []);
  // Pickup from Todo still goes to In Progress, as before flows.
  assert.equal(workingStatus(flow, stepById(flow, "build"), std).name, "In Progress");
  // ...and a task on the review step stays put on pickup.
  assert.equal(workingStatus(flow, stepById(flow, "review"), std), null);
});

test("shared statuses: a status used by two steps picks the next one forward", () => {
  const flow = resolveFlowSteps(
    [
      step("a", "Plan", "prog", { kind: "bot", id: PLANNER }),
      step("b", "Build", "prog", { kind: "bot", id: HERMES }),
      step("done", "Done", "done", { kind: "none" }),
    ],
    dev,
    dir,
    { source: "project", version: 1 },
  );
  const m = machine(flow, dev, { statusId: "prog", stepId: "a", assignee: PLANNER });
  const r = m.complete();
  assert.deepEqual([r.to.id, m.task.statusId, m.task.assignee], ["b", "prog", HERMES], "same status, next owner");
  // A jump target overrides the order.
  const jump = resolveFlowSteps(
    [step("a", "A", "todo", { kind: "bot", id: HERMES }, { next: "c" }), step("b", "B", "rev", { kind: "bot", id: TESTER }, { required: false }), step("c", "C", "dep", { kind: "bot", id: CICD }), step("done", "Done", "done", { kind: "none" })],
    dev,
    dir,
    { source: "project", version: 1 },
  );
  assert.equal(nextStepOf(jump, stepById(jump, "a")).id, "c");
});
