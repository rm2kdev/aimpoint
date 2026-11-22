// Run with `pnpm test`. VEC-408: sub-tasks grouped under their parent in the app's task lists (lib/subtask-groups-core.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutSubtasks, progressLabel, progressTitle, stableChildren } from "./subtask-groups-core.ts";

const t = (id, parentId = null, n = 0) => ({ id, parentId, n });
const byN = (a, b) => a.n - b.n;
const ids = (list) => list.map((x) => x.id);

test("grouping off: the flat list as filtered", () => {
  const all = [t("p"), t("c1", "p"), t("c2", "p")];
  const r = layoutSubtasks(all, all, false, byN);
  assert.deepEqual(ids(r.rows), ["p", "c1", "c2"]);
  assert.equal(r.children.size, 0);
  assert.equal(r.detached.size, 0);
});

test("grouping on: sub-tasks leave the rows and sit under their parent, sorted", () => {
  const all = [t("p"), t("c2", "p", 2), t("c1", "p", 1), t("q")];
  const r = layoutSubtasks(all, all, true, byN);
  assert.deepEqual(ids(r.rows), ["p", "q"]);
  assert.deepEqual(ids(r.children.get("p")), ["c1", "c2"]);
  assert.equal(r.detached.size, 0);
});

test("a child that matches while its parent doesn't stays a row, marked detached", () => {
  const all = [t("p"), t("c1", "p"), t("c2", "p")];
  const visible = [all[1]];
  const r = layoutSubtasks(all, visible, true, byN);
  assert.deepEqual(ids(r.rows), ["c1"]);
  assert.ok(r.detached.has("c1"));
});

test("a parent outside the view (other project / archived) leaves its child a detached row", () => {
  const all = [t("c1", "elsewhere")];
  const r = layoutSubtasks(all, all, true, byN);
  assert.deepEqual(ids(r.rows), ["c1"]);
  assert.ok(r.detached.has("c1"));
});

test("an expanded parent lists every sub-task the view holds, including filtered-out ones", () => {
  const all = [t("p"), t("c1", "p", 1), t("c2", "p", 2)];
  const visible = [all[0], all[2]]; // c1 filtered out (e.g. Created by: People)
  const r = layoutSubtasks(all, visible, true, byN);
  assert.deepEqual(ids(r.rows), ["p"]);
  assert.deepEqual(ids(r.children.get("p")), ["c1", "c2"]);
});

test("a self-parent is never nested under itself", () => {
  const all = [t("x", "x")];
  const r = layoutSubtasks(all, all, true, byN);
  assert.deepEqual(ids(r.rows), ["x"]);
  assert.equal(r.children.size, 0);
});

test("stableChildren keeps unchanged arrays and swaps changed ones", () => {
  const a = t("a", "p");
  const b = t("b", "p");
  const prev = new Map([["p", [a, b]], ["q", [a]]]);
  const next = stableChildren(prev, new Map([["p", [a, b]], ["q", [b]]]));
  assert.equal(next.get("p"), prev.get("p"));
  assert.notEqual(next.get("q"), prev.get("q"));
});

test("progress chip counts cancelled as closed", () => {
  assert.equal(progressLabel({ total: 5, done: 2, cancelled: 1 }), "3/5 done");
  assert.equal(progressTitle({ total: 5, done: 2, cancelled: 1 }), "3 of 5 sub-tasks closed (1 cancelled)");
  assert.equal(progressTitle({ total: 1, done: 0, cancelled: 0 }), "0 of 1 sub-task closed");
});
