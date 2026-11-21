// Run with `pnpm test`. VEC-394: the stalled headline says why the task stalled, for new and older rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { notificationHeadline } from "./notification-text.ts";

const base = { id: "n1", kind: "stalled", taskId: "t1", taskKey: "TPA-420", taskTitle: "Scratch", taskArchived: false, actorId: null, detail: null, createdAt: "2026-11-21T00:00:00.000Z", read: false };
const n = (extra) => ({ ...base, ...extra });

test("each stored reason gets its own headline", () => {
  assert.equal(notificationHeadline(n({ reason: "unassigned" }), null), "TPA-420 is stalled: nobody is assigned to it");
  assert.equal(notificationHeadline(n({ reason: "unfinished", actorId: "b1" }), "Hermes"), "TPA-420 is stalled: Hermes left it unfinished");
  assert.equal(notificationHeadline(n({ reason: "finished", actorId: "b1" }), "Hermes"), "TPA-420 is stalled: Hermes finished but left it open");
  assert.equal(notificationHeadline(n({ reason: "undelivered", actorId: "b1" }), "Hermes"), "TPA-420 is stalled: it never reached Hermes");
});

test("a bot that no longer resolves falls back to its bot", () => {
  assert.equal(notificationHeadline(n({ reason: "unfinished", actorId: "gone" }), null), "TPA-420 is stalled: its bot left it unfinished");
});

test("rows from before VEC-394 (no reason) infer it from the actor", () => {
  assert.equal(notificationHeadline(n({}), null), "TPA-420 is stalled: nobody is assigned to it");
  assert.equal(notificationHeadline(n({ reason: null }), null), "TPA-420 is stalled: nobody is assigned to it");
  assert.equal(notificationHeadline(n({ actorId: "b1" }), "Hermes"), "TPA-420 is stalled: Hermes left it unfinished");
});

test("other kinds are unchanged", () => {
  assert.equal(notificationHeadline(n({ kind: "ready" }), null), "TPA-420 is ready to work on");
  assert.equal(notificationHeadline(n({ kind: "assigned", actorId: "u1" }), "Mia"), "Mia assigned you TPA-420");
});
