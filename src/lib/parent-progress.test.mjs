// Run with `pnpm test`. VEC-419: a not-started parent starts when any sub-task starts or finishes. Pure rules from
// lib/parent-progress-core.ts (when to move, where to, the activity wording) plus a check that every status write
// primitive in task-service calls the one hook.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parentProgress, parentTarget, parentProgressText } from "./parent-progress-core.ts";

const move = (parentStage, subtaskTo, extra = {}) => parentProgress({ parentStage, subtaskTo, ...extra });

test("a sub-task starting moves a Todo parent", () => {
  assert.equal(move("unstarted", "started"), "started");
});

test("a sub-task finishing moves a Todo parent (Ryan's case: some done, none started yet counts)", () => {
  assert.equal(move("unstarted", "done"), "done");
});

test("cancelled, Todo, Backlog or Triage sub-tasks aren't activity", () => {
  for (const to of ["cancelled", "unstarted", "backlog", "triage", null, undefined]) assert.equal(move("unstarted", to), null, String(to));
});

test("parents in Backlog (parked), Triage, started, done or cancelled never move", () => {
  for (const stage of ["backlog", "triage", "started", "done", "cancelled", null, undefined]) {
    assert.equal(move(stage, "started"), null, String(stage));
    assert.equal(move(stage, "done"), null, String(stage));
  }
});

test("never backwards: a sub-task going back to Todo leaves a started parent alone", () => {
  assert.equal(move("started", "unstarted"), null);
  assert.equal(move("unstarted", "unstarted"), null);
});

test("archived or stopped parents stay put", () => {
  assert.equal(move("unstarted", "started", { parentArchived: true }), null);
  assert.equal(move("unstarted", "started", { parentStopped: true }), null);
});

const statuses = [
  { id: "bl", stage: "backlog", order: 0 },
  { id: "tri", stage: "triage", order: 1 },
  { id: "todo", stage: "unstarted", order: 2 },
  { id: "rev", stage: "started", order: 4 },
  { id: "prog", stage: "started", order: 3 },
  { id: "done", stage: "done", order: 5 },
];

test("target without a flow in charge: the first started status by order", () => {
  assert.equal(parentTarget(statuses, { kind: "legacy" })?.id, "prog");
});

test("target on an active flow: its working status, or nothing when the step keeps its status", () => {
  assert.equal(parentTarget(statuses, { kind: "move", statusId: "rev" })?.id, "rev");
  assert.equal(parentTarget(statuses, { kind: "stay" }), null);
  // A flow target that isn't a started status would skip a step: refused.
  assert.equal(parentTarget(statuses, { kind: "move", statusId: "done" }), null);
  assert.equal(parentTarget(statuses, { kind: "move", statusId: "missing" }), null);
});

test("a project with no started status: nothing to move to", () => {
  assert.equal(parentTarget(statuses.filter((s) => s.stage !== "started"), { kind: "legacy" }), null);
});

test("activity wording names the sub-task", () => {
  assert.equal(parentProgressText("started", "VEC-12"), " (sub-task VEC-12 started)");
  assert.equal(parentProgressText("done", "WEB-3"), " (sub-task WEB-3 is done)");
  assert.equal(parentProgressText("started", null), " (a sub-task started)");
});

test("every status write primitive calls the one hook", () => {
  const src = readFileSync(new URL("./task-service.ts", import.meta.url), "utf8");
  const fn = (name) => {
    const start = src.indexOf(`export async function ${name}(`);
    assert.ok(start >= 0, name);
    const next = src.indexOf("\nexport ", start + 10);
    return src.slice(start, next < 0 ? undefined : next);
  };
  for (const name of ["updateTaskAs", "markStartedByBot", "createTaskAs"]) assert.match(fn(name), /startParentOnActivity\(/, name);
  // moveTask writes through updateTaskAs, so drags are covered by it.
  assert.match(fn("moveTask"), /return updateTaskAs\(/);
  // No other module writes the hook's logic again.
  assert.equal((src.match(/startParentOnActivity\(/g) ?? []).length, 3);
});
