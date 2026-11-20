// Run with `pnpm test` (node --test; Node strips the TypeScript types of the .ts modules).
// Flow engine decisions (VEC-175): a 4-step dev flow (Develop > Test > Deploy > Done) and a flow that ends at a
// person (Outreach > Planning > Sign-off > Won), driven through the same pure rules lib/flow-engine.ts applies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveFlowSteps, DEFAULT_FLOW_STEPS } from "./flow-model.ts";
import {
  canPauseFlow,
  pausedAsUmbrella,
  pausedMoveNote,
  pausedStatusNote,
  pausedWhy,
  finishWithStatus,
  flowDrives,
  flowIsActive,
  flowStepAction,
  handoffKind,
  isParkedStatus,
  locateStep,
  moveNote,
  nextStepOf,
  ownerPlan,
  requiredBetween,
  stepById,
  stalledMoveOn,
  stepDriven,
  syncByStatus,
  workingStatus,
} from "./flow-engine-core.ts";

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

/* ---------------- parked Backlog tasks (VEC-274) ---------------- */

test("backlog is parked: no wake, no hand-out, no pickup move, unless a flow step there names its owner", () => {
  const std = [S("s0", "Backlog", "backlog", 0), S("s1", "Triage", "triage", 1), S("s2", "Todo", "unstarted", 2), S("s3", "In Progress", "started", 3), S("s4", "In Review", "started", 4), S("s5", "Done", "done", 5), S("s6", "Cancelled", "cancelled", 6)];
  const flow = resolveFlowSteps(DEFAULT_FLOW_STEPS, std, dir, { source: "org", version: 1 });
  const backlog = st("s0", std);
  // The seeded default has no Backlog step: a Backlog task is parked whatever step it was last on.
  assert.equal(locateStep(flow, backlog), null);
  assert.equal(isParkedStatus(backlog, null), true);
  assert.equal(isParkedStatus(backlog, stepById(flow, "build")), true);
  // Flows off or paused: still parked.
  assert.equal(isParkedStatus(backlog, null, { paused: true }), true);
  // Todo / started / triage tasks keep today's behaviour (assigning a bot wakes it, check_for_work offers it).
  for (const id of ["s1", "s2", "s3", "s4"]) assert.equal(isParkedStatus(st(id, std), stepById(flow, "build")), false, id);
  assert.equal(isParkedStatus(st("s2", std), null), false);

  // A flow whose first step sits in Backlog with a "keep" owner doesn't own it: parked, pickup leaves it alone.
  const keepFlow = resolveFlowSteps(
    [step("plan", "Plan", "bk", { kind: "keep" }), step("build", "Build", "todo", { kind: "keep" }), step("done", "Done", "done", { kind: "none" })],
    dev,
    dir,
    { source: "project", version: 1 },
  );
  assert.equal(isParkedStatus(st("bk"), stepById(keepFlow, "plan")), true);
  assert.equal(workingStatus(keepFlow, stepById(keepFlow, "plan"), dev), null);
  const parkedTask = machine(keepFlow, dev, { statusId: "bk", stepId: "plan", assignee: HERMES }).pickup();
  assert.equal(parkedTask.statusId, "bk");

  // A Backlog step that names its bot is owned by the flow: not parked, and pickup starts it.
  const owned = resolveFlowSteps(
    [step("groom", "Groom", "bk", { kind: "bot", id: PLANNER }), step("build", "Build", "todo", { kind: "bot", id: HERMES }), step("done", "Done", "done", { kind: "none" })],
    dev,
    dir,
    { source: "project", version: 1 },
  );
  const groom = stepById(owned, "groom");
  assert.equal(isParkedStatus(st("bk"), groom), false);
  assert.equal(workingStatus(owned, groom, dev).name, "In Progress");
  assert.equal(machine(owned, dev, { statusId: "bk", stepId: "groom", assignee: PLANNER }).pickup().statusId, "prog");
  // ...but not when a person overrode the step's owner, or the task's flow is paused.
  assert.equal(isParkedStatus(st("bk"), groom, { ownerOverride: true }), true);
  assert.equal(isParkedStatus(st("bk"), groom, { paused: true }), true);
  // ...and not when the task sits in Backlog while its recorded step is elsewhere (Build in Todo).
  assert.equal(isParkedStatus(st("bk"), stepById(owned, "build")), true);
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

/* ---------------- people's step actions in the task pane (VEC-183) ---------------- */

test("pane step actions: a wait step's label for people with a say, Complete step on a person's step, nothing on bot steps", () => {
  const RYAN = "1".repeat(24);
  const MIA = "2".repeat(24);
  const waitFlow = resolveFlowSteps(
    [
      bstep("outreach", "Outreach", "lead", { kind: "bot", id: OUTREACH }, { instructions: "Email the lead." }),
      bstep("await", "Awaiting reply", "out", { kind: "bot", id: OUTREACH }, { advance: "wait", wait: { label: "Reply received", resolvers: [OUTREACH], remindAfterDays: 5 } }),
      bstep("planning", "Planning", "plan", { kind: "bot", id: PLANNER }),
      bstep("signoff", "Sign-off", "sign", { kind: "person", id: SOFIA }, { advance: "manual" }),
      bstep("won", "Won", "won", { kind: "none" }),
    ],
    bld,
    dir,
    { source: "project", version: 1 },
  );
  const at = (id) => stepById(waitFlow, id);
  const v = (me, extra = {}) => ({ me, isAdmin: false, createdBy: RYAN, assigneeId: OUTREACH, assigneeIsPerson: false, ...extra });
  // Wait step: labelled from wait.label, moves to the next step; creator / admin / assignee may, a bystander may not.
  const w = flowStepAction(waitFlow, at("await"), st("out", bld), v(RYAN));
  assert.deepEqual([w.kind, w.label, w.next.id], ["wait", "Reply received", "planning"]);
  assert.equal(flowStepAction(waitFlow, at("await"), st("out", bld), v(MIA)), null);
  assert.equal(flowStepAction(waitFlow, at("await"), st("out", bld), v(MIA, { isAdmin: true })).kind, "wait");
  // A bot's step: nothing for people (its bot completes it; people can still change the status).
  assert.equal(flowStepAction(waitFlow, at("planning"), st("plan", bld), v(RYAN, { assigneeId: PLANNER })), null);
  // ...unless a person took it over (assigned on an active flow).
  assert.equal(flowStepAction(waitFlow, at("planning"), st("plan", bld), v(MIA, { assigneeId: MIA, assigneeIsPerson: true })).kind, "complete");
  // Person-owned step: Complete step for that person even when someone else is assigned, and it hands on to Won.
  const c = flowStepAction(waitFlow, at("signoff"), st("sign", bld), v(SOFIA, { assigneeId: MIA, assigneeIsPerson: true }));
  assert.deepEqual([c.kind, c.label, c.next.id], ["complete", "Complete step", "won"]);
  assert.equal(flowStepAction(waitFlow, at("signoff"), st("sign", bld), v(MIA, { assigneeId: SOFIA, assigneeIsPerson: true, createdBy: OUTREACH })), null);
  // Finished or cancelled: nothing.
  assert.equal(flowStepAction(waitFlow, at("won"), st("won", bld), v(RYAN)), null);
  assert.equal(flowStepAction(waitFlow, at("signoff"), st("lost", bld), v(SOFIA)), null);
  // The seeded default flow (keep owners): no Complete step even for a person assignee.
  const std = [S("s1", "Triage", "triage", 1), S("s2", "Todo", "unstarted", 2), S("s4", "In Review", "started", 4), S("s5", "Done", "done", 5)];
  const def = resolveFlowSteps(DEFAULT_FLOW_STEPS, std, dir, { source: "org", version: 1 });
  assert.equal(flowStepAction(def, stepById(def, "build"), std[1], v(MIA, { assigneeId: MIA, assigneeIsPerson: true })), null);
});

test("VEC-317: Move to <next step> on a Stalled flow task, for the creator or an admin, where complete_task would send it", () => {
  const RYAN = "1".repeat(24);
  const MIA = "2".repeat(24);
  const flow = resolveFlowSteps(
    [
      bstep("outreach", "Outreach", "lead", { kind: "bot", id: OUTREACH }, { instructions: "Email the lead." }),
      bstep("await", "Awaiting reply", "out", { kind: "bot", id: OUTREACH }, { advance: "wait", wait: { label: "Reply received", resolvers: [OUTREACH], remindAfterDays: 5 } }),
      bstep("planning", "Planning", "plan", { kind: "keep" }),
      bstep("signoff", "Sign-off", "sign", { kind: "person", id: SOFIA }, { advance: "manual" }),
      bstep("won", "Won", "won", { kind: "none" }),
    ],
    bld,
    dir,
    { source: "project", version: 1 },
  );
  const at = (id) => stepById(flow, id);
  const v = (me, extra = {}) => ({ me, isAdmin: false, createdBy: RYAN, ...extra });
  // Bot finished at Outreach, task never moved: the creator gets "Move to Awaiting reply".
  const m = stalledMoveOn(flow, at("outreach"), st("lead", bld), v(RYAN), "finished");
  assert.deepEqual([m.label, m.step.id, m.next.id], ["Move to Awaiting reply", "outreach", "await"]);
  // VEC-316's run-ended reason counts too; an admin may, a bystander may not.
  assert.equal(stalledMoveOn(flow, at("outreach"), st("lead", bld), v(MIA, { isAdmin: true }), "unfinished").next.id, "await");
  assert.equal(stalledMoveOn(flow, at("outreach"), st("lead", bld), v(MIA), "finished"), null);
  // A quiet keep step inside a driven flow still moves on (stepDriven), to the person's step.
  assert.equal(stalledMoveOn(flow, at("planning"), st("plan", bld), v(RYAN), "finished").label, "Move to Sign-off");
  // Not stalled, or stalled for a reason moving on doesn't fix (nobody assigned, wake-up never delivered): nothing.
  assert.equal(stalledMoveOn(flow, at("outreach"), st("lead", bld), v(RYAN), null), null);
  assert.equal(stalledMoveOn(flow, at("outreach"), st("lead", bld), v(RYAN), "unassigned"), null);
  assert.equal(stalledMoveOn(flow, at("outreach"), st("lead", bld), v(RYAN), "undelivered"), null);
  // Wait steps move on with their own action; the last step and closed tasks have nowhere to go.
  assert.equal(stalledMoveOn(flow, at("await"), st("out", bld), v(RYAN), "finished"), null);
  assert.equal(stalledMoveOn(flow, at("won"), st("won", bld), v(RYAN), "finished"), null);
  assert.equal(stalledMoveOn(flow, at("signoff"), st("lost", bld), v(RYAN), "finished"), null);
  // The seeded default flow doesn't drive the work, so complete_task wouldn't move it either: no button.
  const std = [S("s1", "Triage", "triage", 1), S("s2", "Todo", "unstarted", 2), S("s4", "In Review", "started", 4), S("s5", "Done", "done", 5)];
  const def = resolveFlowSteps(DEFAULT_FLOW_STEPS, std, dir, { source: "org", version: 1 });
  assert.equal(stalledMoveOn(def, stepById(def, "build"), std[1], v(RYAN), "finished"), null);
});

test("pause / resume flow: creator, assignee or admin", () => {
  const base = { createdBy: "c", assigneeId: "a" };
  assert.ok(canPauseFlow({ ...base, me: "c", isAdmin: false }));
  assert.ok(canPauseFlow({ ...base, me: "a", isAdmin: false }));
  assert.ok(canPauseFlow({ ...base, me: "x", isAdmin: true }));
  assert.ok(!canPauseFlow({ ...base, me: "x", isAdmin: false }));
});

/* ---------------- every way a step owner finishes moves the flow (VEC-315) ---------------- */

// The reporter's flow (MAR-1 on app.aimpoint.dev): Ideas (Triage) > Todo > Research > Write > Ready to post (Ryan).
// Every work step is "its current assignee"; only Research carries instructions and the done step names Ryan.
const mar = [
  S("idea", "Ideas", "backlog", 0),
  S("mtri", "Triage", "triage", 1),
  S("mtodo", "Todo", "unstarted", 2),
  S("res", "Research", "started", 3),
  S("wri", "Write", "started", 4),
  S("post", "Ready to post", "done", 5),
  S("mx", "Cancelled", "cancelled", 6),
];
const mstep = (id, name, statusId, owner, extra = {}) => step(id, name, statusId, owner, extra, mar);
const marFlow = resolveFlowSteps(
  [
    mstep("triage", "Ideas", "mtri", { kind: "triage" }),
    mstep("build", "Todo", "mtodo", { kind: "keep" }),
    mstep("review", "Research", "res", { kind: "keep" }, { instructions: "Find credible sources." }),
    mstep("write", "Write", "wri", { kind: "keep" }),
    mstep("done", "Done", "post", { kind: "person", id: SOFIA }),
  ],
  mar,
  dir,
  { source: "project", version: 2 },
);
const ms = (id) => stepById(marFlow, id);
const hand = (from, to, extra = {}) =>
  handoffKind({ flow: marFlow, from: ms(from), to: ms(to), assignee: HERMES, ownerOverride: false, assignedInTriage: false, actor: HERMES, actorIsBot: true, ...extra });

test("MAR-1: a keep step on a flow that drives the work hands the same bot the next step (the Research stall)", () => {
  assert.equal(flowDrives(marFlow), true);
  // Write (keep, no instructions) is followed by Ryan's done step, Todo by Research's instructions: all driven.
  for (const id of ["build", "review", "write"]) assert.equal(stepDriven(marFlow, ms(id)), true, id);
  // Todo -> Research and Research -> Write: the current assignee is handed the new step (was: no hand-off at all).
  assert.equal(hand("build", "review"), "keep");
  assert.equal(hand("review", "write"), "keep");
  // A send-back to a keep step hands it over too, so it never sits silently.
  assert.equal(hand("write", "review"), "keep");
  // Not when nothing moved, nobody is assigned, or it reached the done step (closing hands nothing on).
  assert.equal(hand("review", "review"), null);
  assert.equal(hand("review", "write", { assignee: null }), null);
  assert.equal(hand("write", "done"), null);
  // Re-attaching a detached task by status isn't a hand-off.
  assert.equal(handoffKind({ flow: marFlow, from: null, to: ms("write"), assignee: HERMES, ownerOverride: false, assignedInTriage: false, actor: HERMES, actorIsBot: true }), null);
});

test("MAR-1: the triager that assigned itself is handed the first work step when it leaves Triage (the Todo stall)", () => {
  assert.equal(hand("triage", "build", { ownerOverride: true, assignedInTriage: true }), "triager");
  // Someone else assigned during triage: their assignment already told them; the triager hands nothing.
  assert.equal(hand("triage", "build", { ownerOverride: true, assignedInTriage: true, actor: TESTER }), null);
  // A person moving it out of Triage, or an explicit assignee in the same write: no extra hand-off.
  assert.equal(hand("triage", "build", { ownerOverride: true, assignedInTriage: true, actorIsBot: false }), null);
  assert.equal(hand("triage", "build", { ownerOverride: true, assignedInTriage: false }), null);
});

test("MAR-1: pickup at Todo stays in Todo when every started status belongs to a later step", () => {
  // Was: fell back to Research, so the task sat in the next step's status while still at Todo.
  assert.equal(workingStatus(marFlow, ms("build"), mar), null);
  // Started steps keep their own status as before.
  assert.equal(workingStatus(marFlow, ms("review"), mar), null);
  // The dev flow still has a free working status (In Progress).
  assert.equal(workingStatus(devFlow, stepById(devFlow, "develop"), dev).name, "In Progress");
});

test("named owners still hand off as before; a person's override still wins", () => {
  const h = (from, to, extra = {}) =>
    handoffKind({ flow: devFlow, from: stepById(devFlow, from), to: stepById(devFlow, to), assignee: TESTER, ownerOverride: false, assignedInTriage: false, actor: HERMES, actorIsBot: true, ...extra });
  assert.equal(h("develop", "test"), "named");
  assert.equal(h("develop", "test", { ownerOverride: true }), null);
  assert.equal(h("deploy", "done"), null);
});

test("complete_task with a status: the step's own, a working or the next step's status hands it on; others apply as given", () => {
  const at = (id) => stepById(devFlow, id);
  const f = (cur, statusId) => finishWithStatus(devFlow, at(cur), st(statusId));
  // At Develop (Todo): Todo (its own), In Progress (its working status), In Review (Test's, the next step) -> advance.
  assert.equal(f("develop", "todo"), "advance");
  assert.equal(f("develop", "prog"), "advance");
  assert.equal(f("develop", "rev"), "advance");
  // Deploying is a later step's status: a jump, so the skip rules decide (a bot is refused past required Test).
  assert.equal(f("develop", "dep"), "explicit");
  // Done and Cancelled still close it; Backlog leaves the flow; Triage re-triages.
  for (const id of ["done", "x", "bk", "tr"]) assert.equal(f("develop", id), "explicit", id);
  // At Test (In Review): its own status or Deploying (next) hand on; Todo (Develop's) sends it back...
  assert.equal(f("test", "rev"), "advance");
  assert.equal(f("test", "dep"), "advance");
  assert.equal(f("test", "todo"), "explicit");
  // ...and so does In Progress, Develop's working status (an earlier step's), the same as a person's drag.
  assert.equal(f("test", "prog"), "explicit");
  // The reporter's flow: Research's own status or Write (next) both hand on from Research.
  assert.equal(finishWithStatus(marFlow, ms("review"), st("res", mar)), "advance");
  assert.equal(finishWithStatus(marFlow, ms("review"), st("wri", mar)), "advance");
  assert.equal(finishWithStatus(marFlow, ms("review"), st("mtodo", mar)), "explicit");
  // Ready to post from Write: the done step either way (sync closes it, as a status-less finish would).
  assert.equal(finishWithStatus(marFlow, ms("write"), st("post", mar)), "explicit");
});

test("complete_task with a status: wait steps, the done step and Triage keep their own rules", () => {
  const waitFlow = resolveFlowSteps(
    [
      bstep("outreach", "Outreach", "lead", { kind: "bot", id: OUTREACH }, { instructions: "Email the lead." }),
      bstep("await", "Awaiting reply", "out", { kind: "bot", id: OUTREACH }, { advance: "wait", wait: { label: "Reply received", resolvers: [], remindAfterDays: null } }),
      bstep("planning", "Planning", "plan", { kind: "bot", id: PLANNER }),
      bstep("won", "Won", "won", { kind: "none" }),
    ],
    bld,
    dir,
    { source: "project", version: 1 },
  );
  assert.equal(finishWithStatus(waitFlow, stepById(waitFlow, "await"), st("plan", bld)), "explicit");
  assert.equal(finishWithStatus(waitFlow, stepById(waitFlow, "won"), st("won", bld)), "explicit");
  assert.equal(finishWithStatus(marFlow, ms("triage"), st("mtodo", mar)), "explicit");
});

test("a quiet step inside a flow that drives the work is driven; the seeded default and triage-only notes are not", () => {
  // Build and Review are both "its current assignee" with no instructions; Test names a bot two steps later.
  const quiet = resolveFlowSteps(
    [
      step("build", "Build", "todo", { kind: "keep" }),
      step("review", "Review", "prog", { kind: "keep" }),
      step("test", "Test", "rev", { kind: "bot", id: TESTER }),
      step("done", "Done", "done", { kind: "none" }),
    ],
    dev,
    dir,
    { source: "project", version: 1 },
  );
  // flowIsActive (this step or the next) says no at Build; that left complete_task without a status moving nothing.
  assert.equal(flowIsActive(quiet, stepById(quiet, "build")), false);
  assert.equal(stepDriven(quiet, stepById(quiet, "build")), true);
  assert.equal(handoffKind({ flow: quiet, from: stepById(quiet, "build"), to: stepById(quiet, "review"), assignee: HERMES, ownerOverride: false, assignedInTriage: false, actor: HERMES, actorIsBot: true }), "keep");
  // The seeded default: nothing driven, no keep hand-offs (behaviour unchanged for projects without an active flow).
  const std = [S("s1", "Triage", "triage", 1), S("s2", "Todo", "unstarted", 2), S("s3", "In Progress", "started", 3), S("s4", "In Review", "started", 4), S("s5", "Done", "done", 5)];
  const def = resolveFlowSteps(DEFAULT_FLOW_STEPS, std, dir, { source: "org", version: 1 });
  assert.equal(flowDrives(def), false);
  assert.ok(def.steps.every((s) => !stepDriven(def, s)));
  assert.equal(handoffKind({ flow: def, from: stepById(def, "build"), to: stepById(def, "review"), assignee: HERMES, ownerOverride: false, assignedInTriage: false, actor: HERMES, actorIsBot: true }), null);
  assert.equal(handoffKind({ flow: def, from: stepById(def, "triage"), to: stepById(def, "build"), assignee: HERMES, ownerOverride: true, assignedInTriage: true, actor: HERMES, actorIsBot: true }), null);
  // Instructions only on the Triage step (for triage bots) don't make Build -> optional Review hand on.
  const triageNote = resolveFlowSteps(
    DEFAULT_FLOW_STEPS.map((s) => (s.id === "triage" ? { ...s, instructions: "Split it up." } : s)),
    std,
    dir,
    { source: "org", version: 2 },
  );
  assert.equal(flowDrives(triageNote), false);
  assert.equal(stepDriven(triageNote, stepById(triageNote, "build")), false);
});

test("VEC-325: a person's pause is told apart from a triage umbrella's", () => {
  const none = { waiting: false, triaged: false };
  assert.equal(pausedAsUmbrella({ paused: true, pausedBy: "umbrella" }, none), true);
  assert.equal(pausedAsUmbrella({ paused: true, pausedBy: "person" }, { waiting: true, triaged: true }), false);
  assert.equal(pausedAsUmbrella({ paused: false, pausedBy: "umbrella" }, none), false);
  assert.equal(pausedAsUmbrella(null, { waiting: true, triaged: true }), false);
  // Pauses from before pausedBy: an umbrella still waits on sub-tasks or was triaged; anything else is a person's.
  assert.equal(pausedAsUmbrella({ paused: true }, { waiting: true, triaged: false }), true);
  assert.equal(pausedAsUmbrella({ paused: true }, { waiting: false, triaged: true }), true);
  assert.equal(pausedAsUmbrella({ paused: true }, none), false);
});

test("VEC-325: paused wording mentions sub-tasks only for an umbrella", () => {
  assert.equal(pausedWhy(true), "its flow is paused (it waits on the sub-tasks it was split into), so the flow didn't move it");
  assert.match(pausedWhy(false), /^its flow is paused, so the flow didn't move it/);
  assert.doesNotMatch(pausedWhy(false), /sub-task/);
  assert.equal(pausedMoveNote(true, "Todo"), " Its flow is paused (it waits on the sub-tasks it was split into), so it moved to Todo and nobody new was assigned.");
  assert.match(pausedMoveNote(false, "Todo"), /moved to Todo/);
  assert.doesNotMatch(pausedMoveNote(false, "Todo"), /sub-task/);
  assert.doesNotMatch(pausedStatusNote, /sub-task/);
});
