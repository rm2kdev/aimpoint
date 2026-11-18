// Run with `pnpm test`. Moving a bot's task into / out of Backlog (VEC-275): the decisions updateTaskAs applies on
// every status write (MCP set_status / update_task, REST, board drag, task page).
import { test } from "node:test";
import assert from "node:assert/strict";
import { backlogMove, parkRelease, unparkWakes, writeHandOff } from "./backlog-moves.ts";

const ready = { assigneeIsBot: true, assigneeHasClaim: false, archived: false, stage: "unstarted", waiting: false, stopped: false, parked: false };

test("leaving Backlog unparks, entering parks, staying changes nothing", () => {
  assert.equal(backlogMove(true, false), "unpark");
  assert.equal(backlogMove(false, true), "park");
  assert.equal(backlogMove(true, true), null); // Backlog -> another backlog-stage status
  assert.equal(backlogMove(false, false), null); // Todo -> In Progress
});

test("unparking into Todo or a started status wakes the assigned bot", () => {
  assert.equal(unparkWakes(ready), true);
  assert.equal(unparkWakes({ ...ready, stage: "started" }), true);
});

test("no wake while waiting on dependencies, stopped, archived or closed", () => {
  assert.equal(unparkWakes({ ...ready, waiting: true }), false); // the ready hand-off releases it later
  assert.equal(unparkWakes({ ...ready, stopped: true }), false);
  assert.equal(unparkWakes({ ...ready, archived: true }), false);
  assert.equal(unparkWakes({ ...ready, stage: "done" }), false);
  assert.equal(unparkWakes({ ...ready, stage: "cancelled" }), false);
  assert.equal(unparkWakes({ ...ready, stage: "triage" }), false);
});

test("no wake for a person, a bot that already holds it, or a task still parked", () => {
  assert.equal(unparkWakes({ ...ready, assigneeIsBot: false }), false);
  assert.equal(unparkWakes({ ...ready, assigneeHasClaim: true }), false);
  assert.equal(unparkWakes({ ...ready, parked: true }), false);
});

test("one hand-off per write: status + assignee in one write wakes once, through the assignment", () => {
  assert.equal(writeHandOff({ assigneeSet: true, sameOwnerHandoff: false, nowReady: false, move: "unpark" }), "assignment");
  assert.equal(writeHandOff({ assigneeSet: true, sameOwnerHandoff: false, nowReady: true, move: "unpark" }), "assignment");
  assert.equal(writeHandOff({ assigneeSet: false, sameOwnerHandoff: true, nowReady: false, move: "unpark" }), "same_owner");
  assert.equal(writeHandOff({ assigneeSet: false, sameOwnerHandoff: false, nowReady: true, move: "unpark" }), "ready");
  assert.equal(writeHandOff({ assigneeSet: false, sameOwnerHandoff: false, nowReady: false, move: "unpark" }), "unpark");
  assert.equal(writeHandOff({ assigneeSet: false, sameOwnerHandoff: false, nowReady: false, move: "park" }), null);
  assert.equal(writeHandOff({ assigneeSet: false, sameOwnerHandoff: false, nowReady: false, move: null }), null);
});

const BOT = "b".repeat(24);
const OTHER = "c".repeat(24);
const PERSON = "a".repeat(24);

test("parking releases the working bot's claim and tells it to stop", () => {
  const claims = [{ id: "1", botId: BOT, kind: null, state: "in_progress" }];
  assert.deepEqual(parkRelease(claims, { actorId: PERSON, stopped: false }), { release: ["1"], signal: [BOT] });
});

test("parking drops finished claims too (so leaving Backlog hands it over afresh) but signals only working bots", () => {
  const claims = [
    { id: "1", botId: BOT, kind: "assigned", state: "done" },
    { id: "2", botId: OTHER, kind: null, state: "in_progress" },
  ];
  assert.deepEqual(parkRelease(claims, { actorId: PERSON, stopped: false }), { release: ["1", "2"], signal: [OTHER] });
});

test("parking leaves triage claims and a stopped task alone, and a bot parking it itself isn't signalled", () => {
  assert.deepEqual(parkRelease([{ id: "t", botId: BOT, kind: "triage", state: "in_progress" }], { actorId: PERSON, stopped: false }), { release: [], signal: [] });
  assert.deepEqual(parkRelease([{ id: "1", botId: BOT, kind: null, state: "stopped" }], { actorId: PERSON, stopped: true }), { release: [], signal: [] });
  assert.deepEqual(parkRelease([{ id: "1", botId: BOT, kind: null, state: "in_progress" }], { actorId: BOT, stopped: false }), { release: ["1"], signal: [] });
});
