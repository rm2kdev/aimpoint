// Run with `pnpm test`. VEC-381: the bot tray's label covers claimed work and runs with no claim (replies, close-outs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { trayLabel } from "./bot-tray-core.ts";

test("claimed work only keeps the capacity wording", () => {
  assert.equal(trayLabel(1, 3, []), "working on 1 of 3 tasks");
  assert.equal(trayLabel(3, 3, []), "working on 3 of 3 tasks, at capacity");
  assert.equal(trayLabel(2, 1, []), "working on 2 of 1 task, over capacity");
});

test("runs with no claim name the tasks", () => {
  assert.equal(trayLabel(0, 3, ["VEC-12"]), "running on VEC-12");
  assert.equal(trayLabel(0, 3, ["VEC-12", "VEC-14"]), "running on VEC-12 and VEC-14");
  assert.equal(trayLabel(0, 3, ["A-1", "A-2", "A-3"]), "running on A-1, A-2 and A-3");
  assert.equal(trayLabel(0, 3, ["A-1", "A-2", "A-3", "A-4", "A-5"]), "running on A-1, A-2 and 3 more");
  assert.equal(trayLabel(1, 3, ["VEC-12"]), "working on 1 of 3 tasks, also running on VEC-12");
});
