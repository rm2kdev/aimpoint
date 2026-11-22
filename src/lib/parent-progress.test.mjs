// Run with `pnpm test`. VEC-419: a not-started parent starts when any sub-task starts or finishes. Pure rules from
// lib/parent-progress-core.ts (when to move, where to, the activity wording) plus a check that every status write
// primitive in task-service calls the one hook.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { movedOnReply, parentProgress, parentTarget, parentProgressText, pickActiveSubtask } from "./parent-progress-core.ts";

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

// VEC-444: a parent's own status written into a not-started status re-checks its current sub-tasks.
const sub = (key, stage, at) => ({ key, stage, updatedAt: new Date(`2026-11-22T04:${at}:00Z`) });

test("own status into Todo: the newest started sub-task counts, started beats a newer done one", () => {
  const subs = [sub("A", "done", "50"), sub("B", "started", "10"), sub("C", "started", "20"), sub("D", "unstarted", "59")];
  assert.equal(pickActiveSubtask(subs)?.key, "C");
  assert.equal(move("unstarted", pickActiveSubtask(subs)?.stage), "started");
});

test("own status into Todo: only done sub-tasks still count (the newest one is named)", () => {
  const subs = [sub("A", "done", "10"), sub("B", "done", "30"), sub("C", "cancelled", "40")];
  assert.equal(pickActiveSubtask(subs)?.key, "B");
  assert.equal(move("unstarted", pickActiveSubtask(subs)?.stage), "done");
});

test("own status into Todo: no started or done sub-task (or none at all) leaves it put", () => {
  assert.equal(pickActiveSubtask([]), null);
  assert.equal(pickActiveSubtask([sub("A", "unstarted", "10"), sub("B", "cancelled", "11"), sub("C", "triage", "12"), sub("D", "backlog", "13"), sub("E", null, "14")]), null);
});

test("own status written into Triage, Backlog or a started status never moves it, even with started sub-tasks", () => {
  const active = pickActiveSubtask([sub("A", "started", "10")]);
  for (const stage of ["triage", "backlog", "started", "done", "cancelled"]) assert.equal(move(stage, active.stage), null, stage);
  assert.equal(move("unstarted", active.stage, { parentStopped: true }), null);
  assert.equal(move("unstarted", active.stage, { parentArchived: true }), null);
});

test("pickActiveSubtask accepts ISO strings and epoch numbers as updatedAt", () => {
  assert.equal(pickActiveSubtask([{ k: 1, stage: "started", updatedAt: "2026-11-22T01:00:00Z" }, { k: 2, stage: "started", updatedAt: Date.parse("2026-11-22T02:00:00Z") }])?.k, 2);
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
  // VEC-444: the parent side, once, in updateTaskAs: every own-status write (pane, moveTask, set_status, complete_task
  // incl. triage close-out, flow advances, REST) goes through it, gated on a not-started status just written.
  assert.equal((src.match(/startParentOnOwnStatus\(/g) ?? []).length, 1);
  assert.match(fn("updateTaskAs"), /set\.statusId && finalStatus\?\.category === "unstarted"[^\n]*\n\s*const moved = await startParentOnOwnStatus\(actor, after\)/);
});

test("both triggers share one move, and the backfill picks the sub-task the same way", () => {
  const hook = readFileSync(new URL("./parent-progress.ts", import.meta.url), "utf8");
  assert.equal((hook.match(/findOneAndUpdate\(/g) ?? []).length, 1);
  assert.equal((hook.match(/await moveParent\(/g) ?? []).length, 2);
  assert.match(hook, /pickActiveSubtask\(/);
  const backfill = readFileSync(new URL("./parent-started-migration.ts", import.meta.url), "utf8");
  assert.match(backfill, /pickActiveSubtask\(/);
});

test("complete_task, set_status and flow advances write a task's status only through updateTaskAs", () => {
  for (const file of ["./mcp/server.ts", "./flow-actions.ts"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(src, /\$set:\s*\{[^}]*\bstatusId\b/, file);
  }
});

test("VEC-446: set_status reply names the final status and why it moved on", () => {
  assert.equal(movedOnReply("DEF-21", "Todo", "In Progress", "started", "DEF-22"), "DEF-21 is now In Progress: moved to Todo, then straight on to In Progress because sub-task DEF-22 already started.");
  assert.equal(movedOnReply("DEF-21", "Todo", "In Progress", "done", "DEF-23"), "DEF-21 is now In Progress: moved to Todo, then straight on to In Progress because sub-task DEF-23 is already done.");
  assert.equal(movedOnReply("DEF-21", "Todo", "Doing", "started", null), "DEF-21 is now Doing: moved to Todo, then straight on to Doing because a sub-task already started.");
  // set_status only uses it when the task ended somewhere other than the requested status.
  const src = readFileSync(new URL("./mcp/server.ts", import.meta.url), "utf8");
  assert.match(src, /t\.statusId !== st\._id\.toHexString\(\) \? await movedOnNote\(/);
  assert.match(src, /\$\{movedOn \?\? `\$\{t\.key\} is now \$\{st\.name\}\.`\}/);
});
