// Run with `pnpm test` (node --test; Node strips the TypeScript types of the .ts modules).
// VEC-380: run marks, the working ring for runs that hold no in-progress claim (mentions, close-outs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideMark, markExpiry, markLive, mergeWorking, newMark, touchMark, MAX_MS, QUIET_MS, REPLIED_QUIET_MS } from "./run-marks-core.ts";

const T0 = new Date("2026-11-21T06:00:00Z");
const at = (ms) => new Date(T0.getTime() + ms);
const MIN = 60_000;

test("a fresh mark is live for one quiet window", () => {
  const m = newMark("mentioned", "webhook", T0);
  assert.equal(m.expiresAt.getTime(), T0.getTime() + QUIET_MS);
  assert.equal(markLive(m, at(QUIET_MS - 1)), true);
  assert.equal(markLive(m, at(QUIET_MS)), false);
});

test("signs of life push the expiry out; a reply shortens the quiet window", () => {
  const m = newMark("mentioned", "poll", T0);
  const seen = { ...m, ...touchMark(m, at(5 * MIN), false) };
  assert.equal(seen.expiresAt.getTime(), at(5 * MIN).getTime() + QUIET_MS);
  const replied = { ...seen, ...touchMark(seen, at(6 * MIN), true) };
  assert.equal(replied.expiresAt.getTime(), at(6 * MIN).getTime() + REPLIED_QUIET_MS);
  // Still doing things after the reply (e.g. reading the task): the long window again.
  const after = { ...replied, ...touchMark(replied, at(7 * MIN), false) };
  assert.equal(after.expiresAt.getTime(), at(7 * MIN).getTime() + QUIET_MS);
});

test("no mark outlives MAX_MS, however busy", () => {
  let m = newMark("closeout", "webhook", T0);
  m = { ...m, ...touchMark(m, at(MAX_MS - MIN), false) };
  assert.equal(m.expiresAt.getTime(), T0.getTime() + MAX_MS);
  assert.deepEqual(decideMark(m, at(MAX_MS)), { kind: "end" });
  assert.equal(markExpiry({ startedAt: T0, seenAt: at(MAX_MS + MIN), repliedAt: null }).getTime(), T0.getTime() + MAX_MS);
});

test("hermes with a run id: poll, then end on a final status or 404", () => {
  const m = newMark("mentioned", "hermes-api", T0, "run_1");
  assert.deepEqual(decideMark(m, at(MIN)), { kind: "poll" });
  for (const s of ["completed", "failed", "cancelled", "gone"]) assert.deepEqual(decideMark(m, at(MIN), s), { kind: "end" }, s);
});

test("hermes still running: kept for another quiet window, even long after the bot went quiet", () => {
  const m = newMark("mentioned", "hermes-api", T0, "run_1");
  assert.deepEqual(decideMark(m, at(30 * MIN), "running"), { kind: "keep", expiresAt: at(30 * MIN + QUIET_MS) });
  assert.deepEqual(decideMark(m, at(MAX_MS - MIN), "running"), { kind: "keep", expiresAt: at(MAX_MS) });
});

test("hermes unreachable: falls back to the quiet rule without shortening what the sweep allowed", () => {
  const m = { ...newMark("mentioned", "hermes-api", T0, "run_1"), expiresAt: at(25 * MIN) };
  assert.deepEqual(decideMark(m, at(20 * MIN), null), { kind: "keep", expiresAt: at(25 * MIN) });
  assert.deepEqual(decideMark(m, at(25 * MIN), null), { kind: "end" });
});

test("a comment on a followed hermes run doesn't cut its expiry short", () => {
  const m = { ...newMark("mentioned", "hermes-api", T0, "run_1"), expiresAt: at(20 * MIN) };
  assert.equal(touchMark(m, at(11 * MIN), true).expiresAt.getTime(), at(20 * MIN).getTime());
});

test("hermes without a run id (409 retry) and webhook / poll: the quiet rule", () => {
  for (const method of ["hermes-api", "webhook", "poll"]) {
    const m = newMark("mentioned", method, T0);
    assert.equal(decideMark(m, at(QUIET_MS - 1)).kind, "keep", method);
    assert.deepEqual(decideMark(m, at(QUIET_MS)), { kind: "end" }, method);
  }
  const replied = { ...newMark("mentioned", "webhook", T0) };
  Object.assign(replied, touchMark(replied, at(MIN), true));
  assert.deepEqual(decideMark(replied, at(MIN + REPLIED_QUIET_MS)), { kind: "end" });
});

test("mergeWorking: claims first, marks after, each bot once", () => {
  const claims = new Map([["t1", ["a"]], ["t2", ["b"]]]);
  const marks = new Map([["t1", ["c", "a"]], ["t3", ["d"]]]);
  const out = mergeWorking(claims, marks);
  assert.deepEqual(out.get("t1"), ["a", "c"]);
  assert.deepEqual(out.get("t2"), ["b"]);
  assert.deepEqual(out.get("t3"), ["d"]);
  assert.deepEqual(claims.get("t1"), ["a"], "inputs untouched");
});
