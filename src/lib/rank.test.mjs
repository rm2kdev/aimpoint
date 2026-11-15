// Run with `pnpm test` (node --test; Node strips the TypeScript types of rank.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { rankBetween, ranksAfter, isRank, compareRank } from "./rank.ts";

const between = (a, b) => {
  const k = rankBetween(a, b);
  assert.ok(isRank(k), `${k} is a valid rank`);
  if (a != null) assert.ok(a < k, `${a} < ${k}`);
  if (b != null) assert.ok(k < b, `${k} < ${b}`);
  return k;
};

test("rankBetween: first key and both ends", () => {
  const first = between(null, null);
  assert.equal(first, "a0");
  const top = between(null, first);
  const bottom = between(first, null);
  assert.ok(top < first && first < bottom);
  // Keys at the ends stay short: 1000 prepends / appends only bump the integer part.
  let lo = first;
  let hi = first;
  for (let i = 0; i < 1000; i++) {
    lo = between(null, lo);
    hi = between(hi, null);
  }
  assert.ok(lo.length <= 4, `prepended key ${lo} stays short`);
  assert.ok(hi.length <= 4, `appended key ${hi} stays short`);
});

test("rankBetween: adjacent keys get a key strictly between", () => {
  for (const [a, b] of [
    ["a0", "a1"],
    ["a1", "a2"],
    ["az", "b00"],
    ["Zz", "a0"],
    ["a0V", "a1"],
    ["a0", "a0V"],
    ["a01", "a02"],
  ]) between(a, b);
});

test("rankBetween: many inserts into the same gap keep strict order", () => {
  // Always insert just below the upper neighbour, then just above the lower one.
  const keys = ["a0", "a1"];
  let lo = "a0";
  let hi = "a1";
  for (let i = 0; i < 500; i++) {
    const k = between(lo, hi);
    keys.push(k);
    if (i % 2) lo = k;
    else hi = k;
  }
  const sorted = [...keys].sort();
  assert.equal(new Set(keys).size, keys.length, "all distinct");
  // Always inserting directly after "a0" (newest first under it).
  let top = "a1";
  const stack = [];
  for (let i = 0; i < 300; i++) stack.push((top = between("a0", top)));
  for (let i = 1; i < stack.length; i++) assert.ok(stack[i] < stack[i - 1]);
  assert.ok(stack.at(-1).length < 60, `gap keys grow slowly (${stack.at(-1).length} chars after 300)`);
  assert.deepEqual(sorted, [...keys].sort((a, b) => (a < b ? -1 : 1)));
});

test("rankBetween: refuses inverted, equal and malformed neighbours", () => {
  assert.throws(() => rankBetween("a1", "a0"));
  assert.throws(() => rankBetween("a1", "a1"));
  assert.throws(() => rankBetween("a10", null), "trailing zero in the fraction");
  assert.throws(() => rankBetween("?", null));
  assert.equal(isRank(""), false);
  assert.equal(isRank(null), false);
});

test("ranksAfter + compareRank: backfill order and stable ties", () => {
  const r = ranksAfter(null, 200);
  for (let i = 1; i < r.length; i++) assert.ok(r[i - 1] < r[i]);
  const rows = [
    { id: "b", rank: "a1" },
    { id: "a", rank: "a1" },
    { id: "c", rank: null },
    { id: "d", rank: "a0" },
  ];
  assert.deepEqual(rows.sort(compareRank).map((x) => x.id), ["d", "a", "b", "c"]);
});
