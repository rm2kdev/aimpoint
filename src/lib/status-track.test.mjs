// Run with `pnpm test` (node --test). The task pane's status bar track (VEC-329): flow steps at a step, otherwise the
// project's statuses, for every case the pane shows (no flow, off-flow, paused, Done, Cancelled, triage).
import { test } from "node:test";
import assert from "node:assert/strict";
import { statusTrack } from "./status-track.ts";

// A standard project's statuses, deliberately out of order to prove sorting.
const S = {
  backlog: { id: "s-backlog", name: "Backlog", category: "backlog", order: 0 },
  triage: { id: "s-triage", name: "Triage", category: "triage", order: 1 },
  todo: { id: "s-todo", name: "Todo", category: "unstarted", order: 2 },
  progress: { id: "s-progress", name: "In Progress", category: "started", order: 3 },
  review: { id: "s-review", name: "In Review", category: "started", order: 4 },
  done: { id: "s-done", name: "Done", category: "done", order: 5 },
  cancelled: { id: "s-cancelled", name: "Cancelled", category: "cancelled", order: 6 },
};
const statuses = [S.done, S.todo, S.cancelled, S.backlog, S.review, S.triage, S.progress];
// Triage > Build > Review > Done, like Northwind's org flow.
const flow = {
  steps: [
    { id: "triage", name: "Triage", status: S.triage },
    { id: "build", name: "Build", status: S.todo },
    { id: "review", name: "Review", status: S.review },
    { id: "done", name: "Done", status: S.done },
  ],
};
const states = (t) => t.steps.map((s) => `${s.name}:${s.state}`);

test("at a flow step: the flow's steps, earlier done, the step current, later upcoming", () => {
  const t = statusTrack({ statuses, statusId: S.todo.id, flow, stepIndex: 1 });
  assert.equal(t.source, "flow");
  assert.equal(t.reason, "flow");
  assert.equal(t.index, 1);
  assert.equal(t.finished, false);
  assert.equal(t.label, "Step 2 of 4: Build");
  assert.deepEqual(states(t), ["Triage:done", "Build:current", "Review:upcoming", "Done:upcoming"]);
  assert.equal(t.steps[2].statusName, "In Review");
});

test("flow finished (Done step): every step done, label says finished", () => {
  const t = statusTrack({ statuses, statusId: S.done.id, flow, stepIndex: 3 });
  assert.equal(t.source, "flow");
  assert.equal(t.finished, true);
  assert.equal(t.label, "Flow finished at Done");
  assert.deepEqual(states(t), ["Triage:done", "Build:done", "Review:done", "Done:done"]);
});

test("project with no flow: its statuses in order, triage and cancelled left out", () => {
  const t = statusTrack({ statuses, statusId: S.progress.id, flow: null });
  assert.equal(t.source, "statuses");
  assert.equal(t.reason, "no_flow");
  assert.equal(t.label, "Status 3 of 5: In Progress");
  assert.deepEqual(states(t), ["Backlog:done", "Todo:done", "In Progress:current", "In Review:upcoming", "Done:upcoming"]);
  assert.equal(t.finished, false);
});

test("no flow, Done: statuses before it done, Done current and finished", () => {
  const t = statusTrack({ statuses, statusId: S.done.id });
  assert.equal(t.reason, "no_flow");
  assert.equal(t.finished, true);
  assert.deepEqual(states(t), ["Backlog:done", "Todo:done", "In Progress:done", "In Review:done", "Done:current"]);
});

test("off-flow open status (a status no step uses, not located): statuses, current highlighted", () => {
  const t = statusTrack({ statuses, statusId: S.backlog.id, flow, stepIndex: -1 });
  assert.equal(t.source, "statuses");
  assert.equal(t.reason, "off_flow");
  assert.deepEqual(states(t), ["Backlog:current", "Todo:upcoming", "In Progress:upcoming", "In Review:upcoming", "Done:upcoming"]);
});

test("Cancelled (off its flow): Cancelled shown as the current step, every other step skipped", () => {
  const t = statusTrack({ statuses, statusId: S.cancelled.id, flow, stepIndex: -1 });
  assert.equal(t.reason, "off_flow");
  assert.equal(t.finished, true);
  assert.equal(t.label, "Status 6 of 6: Cancelled");
  assert.deepEqual(states(t), ["Backlog:skipped", "Todo:skipped", "In Progress:skipped", "In Review:skipped", "Done:skipped", "Cancelled:current"]);
});

test("Cancelled with no flow: same track, reason no_flow", () => {
  const t = statusTrack({ statuses, statusId: S.cancelled.id, flow: undefined });
  assert.equal(t.reason, "no_flow");
  assert.equal(t.steps.at(-1).state, "current");
});

test("paused flow: statuses even when a step was located", () => {
  const t = statusTrack({ statuses, statusId: S.todo.id, flow, stepIndex: 1, paused: true });
  assert.equal(t.source, "statuses");
  assert.equal(t.reason, "paused");
  assert.deepEqual(states(t), ["Backlog:done", "Todo:current", "In Progress:upcoming", "In Review:upcoming", "Done:upcoming"]);
});

test("in a triage status off-flow (paused): triage appears in its place as the current step", () => {
  const t = statusTrack({ statuses, statusId: S.triage.id, flow, stepIndex: 0, paused: true });
  assert.deepEqual(states(t), ["Backlog:done", "Triage:current", "Todo:upcoming", "In Progress:upcoming", "In Review:upcoming", "Done:upcoming"]);
  assert.equal(t.index, 1);
});

test("unknown status: steps drawn, nothing current", () => {
  const t = statusTrack({ statuses, statusId: "gone" });
  assert.equal(t.index, -1);
  assert.equal(t.label, "Status unknown");
  assert.ok(t.steps.every((s) => s.state === "upcoming"));
});

test("out-of-range step index falls back to statuses", () => {
  const t = statusTrack({ statuses, statusId: S.review.id, flow, stepIndex: 9 });
  assert.equal(t.source, "statuses");
  assert.equal(t.reason, "off_flow");
});
