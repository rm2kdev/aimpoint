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

// ---- Linked lists ------------------------------------------------------------------------

import { dropIndex, isNoopDrop, transferItem, distanceToBox, pickBox, adjacentList } from "./reorder.ts";

test("dropIndex: own list shifts past the item, other lists use the gap", () => {
  assert.equal(dropIndex(true, 1, 3), 2);
  assert.equal(dropIndex(true, 3, 1), 1);
  assert.equal(dropIndex(false, 1, 3), 3);
  assert.equal(dropIndex(false, 0, 0), 0);
});

test("isNoopDrop: only next to the item's own slot in its own list", () => {
  assert.equal(isNoopDrop(true, 2, 2), true);
  assert.equal(isNoopDrop(true, 2, 3), true);
  assert.equal(isNoopDrop(true, 2, 4), false);
  assert.equal(isNoopDrop(false, 2, 2), false);
  assert.equal(isNoopDrop(true, -1, 0), false); // item no longer in its list
});

test("transferItem: moves across lists, clamps, never mutates", () => {
  const a = ["a", "b", "c"];
  const x = ["x", "y"];
  assert.deepEqual(transferItem(a, x, 1, 1), { from: ["a", "c"], to: ["x", "b", "y"] });
  assert.deepEqual(transferItem(a, x, 0, 99), { from: ["b", "c"], to: ["x", "y", "a"] });
  assert.deepEqual(transferItem(a, x, 2, -5), { from: ["a", "b"], to: ["c", "x", "y"] });
  assert.deepEqual(transferItem(a, [], 0, 0), { from: ["b", "c"], to: ["a"] });
  assert.deepEqual(transferItem(a, x, 7, 0), { from: a, to: x });
  assert.deepEqual(a, ["a", "b", "c"]);
  assert.deepEqual(x, ["x", "y"]);
});

test("distanceToBox: zero inside, euclidean outside", () => {
  const b = { left: 0, top: 0, right: 10, bottom: 10 };
  assert.equal(distanceToBox(b, 5, 5), 0);
  assert.equal(distanceToBox(b, 15, 5), 5);
  assert.equal(distanceToBox(b, 13, 14), 5);
});

test("pickBox: containing box wins, else nearest within margin, else -1", () => {
  const left = { left: 0, top: 0, right: 100, bottom: 200 };
  const right = { left: 120, top: 0, right: 220, bottom: 200 };
  assert.equal(pickBox([left, right], 50, 50, 24), 0);
  assert.equal(pickBox([left, right], 150, 50, 24), 1);
  assert.equal(pickBox([left, right], 108, 50, 24), 0); // gap between columns: nearer the left
  assert.equal(pickBox([left, right], 113, 50, 24), 1);
  assert.equal(pickBox([left, right], 300, 50, 24), -1);
  assert.equal(pickBox([null, right], 50, 50, 24), -1);
  assert.equal(pickBox([], 0, 0, 24), -1);
});

test("adjacentList: previous/next in order, null at the ends", () => {
  const order = ["todo", "doing", "done"];
  assert.equal(adjacentList(order, "doing", -1), "todo");
  assert.equal(adjacentList(order, "doing", 1), "done");
  assert.equal(adjacentList(order, "todo", -1), null);
  assert.equal(adjacentList(order, "done", 1), null);
  assert.equal(adjacentList(order, "nope", 1), null);
});
