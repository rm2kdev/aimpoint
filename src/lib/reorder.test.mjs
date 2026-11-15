// Run with `pnpm test` (node --test; Node strips the TypeScript types of reorder.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { moveItem, gapToIndex, indexToGap, isNoopGap, gapFromPointer, gapOffset } from "./reorder.ts";

const abcd = ["a", "b", "c", "d"];

test("moveItem: first to last and last to first", () => {
  assert.deepEqual(moveItem(abcd, 0, 3), ["b", "c", "d", "a"]);
  assert.deepEqual(moveItem(abcd, 3, 0), ["d", "a", "b", "c"]);
});

test("moveItem: neighbours and middle", () => {
  assert.deepEqual(moveItem(abcd, 1, 2), ["a", "c", "b", "d"]);
  assert.deepEqual(moveItem(abcd, 2, 1), ["a", "c", "b", "d"]);
  assert.deepEqual(moveItem(abcd, 0, 1), ["b", "a", "c", "d"]);
});

test("moveItem: same index is a no-op copy and never mutates", () => {
  const out = moveItem(abcd, 2, 2);
  assert.deepEqual(out, abcd);
  assert.notEqual(out, abcd);
  moveItem(abcd, 0, 3);
  assert.deepEqual(abcd, ["a", "b", "c", "d"]);
});

test("moveItem: clamps `to`, ignores a bad `from`, handles tiny lists", () => {
  assert.deepEqual(moveItem(abcd, 0, 99), ["b", "c", "d", "a"]);
  assert.deepEqual(moveItem(abcd, 3, -5), ["d", "a", "b", "c"]);
  assert.deepEqual(moveItem(abcd, -1, 2), abcd);
  assert.deepEqual(moveItem(abcd, 4, 0), abcd);
  assert.deepEqual(moveItem(abcd, 1.5, 0), abcd);
  assert.deepEqual(moveItem([], 0, 0), []);
  assert.deepEqual(moveItem(["x"], 0, 1), ["x"]);
});

test("gaps <-> indexes round-trip, and own-slot gaps are no-ops", () => {
  for (let from = 0; from < 4; from++) {
    for (let gap = 0; gap <= 4; gap++) {
      const to = gapToIndex(from, gap);
      assert.ok(to >= 0 && to <= 3);
      if (!isNoopGap(from, gap)) assert.equal(indexToGap(from, to), gap);
      else assert.equal(to, from);
    }
  }
  assert.equal(gapToIndex(0, 4), 3); // dropped after the last item
  assert.equal(gapToIndex(3, 0), 0); // dropped before the first
});

test("gapFromPointer and gapOffset", () => {
  const spans = [{ start: 0, end: 40 }, { start: 42, end: 82 }, { start: 84, end: 124 }];
  assert.equal(gapFromPointer(spans, -10), 0);
  assert.equal(gapFromPointer(spans, 19), 0);
  assert.equal(gapFromPointer(spans, 21), 1);
  assert.equal(gapFromPointer(spans, 100), 2);
  assert.equal(gapFromPointer(spans, 110), 3);
  assert.equal(gapOffset(spans, 0), -1);
  assert.equal(gapOffset(spans, 1), 41);
  assert.equal(gapOffset(spans, 2), 83);
  assert.equal(gapOffset(spans, 3), 125);
  assert.equal(gapOffset([], 0), 0);
});
