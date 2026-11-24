// Run with `pnpm test` (node --test). Optimistic task writes: overlay + pending creates (VEC-456).
import { test } from "node:test";
import assert from "node:assert/strict";
import { beforeOf, createPendingCreates, createTaskOverlay, isTempId } from "./task-writes-core.ts";
import { createActionQueue } from "./pending-actions-core.ts";

const task = (over = {}) => ({ id: "t1", title: "Old", statusId: "todo", priority: 0, updatedAt: "1", ...over });

test("overlay lays pending fields over a server copy, later writes winning", () => {
  const o = createTaskOverlay();
  const base = task();
  assert.equal(o.apply(base), base, "nothing pending: same object");
  o.add("a", "t1", { title: "New" });
  o.add("b", "t1", { statusId: "done", title: "Newer" });
  assert.deepEqual(o.apply(base), { ...base, title: "Newer", statusId: "done" });
  o.remove("b");
  assert.deepEqual(o.apply(base), { ...base, title: "New" });
  o.remove("a");
  assert.equal(o.apply(base), base);
  assert.equal(o.has("t1"), false);
});

test("an echo of an earlier write can't flash over a later pending one", () => {
  const o = createTaskOverlay();
  o.add("rename", "t1", { title: "New" });
  o.add("status", "t1", { statusId: "done" });
  // The rename lands; its echo still carries the old status.
  o.remove("rename");
  const echo = task({ title: "New", updatedAt: "2" });
  assert.equal(o.apply(echo).statusId, "done");
  assert.equal(o.apply(echo).title, "New");
});

test("revert puts back the old values but keeps what later writes still hold", () => {
  const o = createTaskOverlay();
  const shown = task();
  const before = beforeOf(shown, { title: "New", statusId: "doing" });
  assert.deepEqual(before, { title: "Old", statusId: "todo" });
  o.add("a", "t1", { title: "New", statusId: "doing" });
  o.add("b", "t1", { statusId: "done" });
  o.remove("a"); // refused
  assert.deepEqual(o.revert("t1", before), { title: "Old", statusId: "done" });
});

test("deleting marks a task until the write settles", () => {
  const o = createTaskOverlay();
  let calls = 0;
  o.subscribe(() => calls++);
  o.addDelete("d", "t1");
  assert.equal(o.isDeleting("t1"), true);
  assert.equal(o.has("t1"), true);
  o.remove("d");
  assert.equal(o.isDeleting("t1"), false);
  assert.equal(calls, 2);
  o.remove("unknown"); // harmless
  // Deleted for good: a stale copy from a list refresh stays out even after the write settled.
  o.markGone("t1");
  assert.equal(o.isDeleting("t1"), true);
});

test("with the queue: refusal reverts per field, success leaves the server copy", async () => {
  const o = createTaskOverlay();
  const q = createActionQueue({ sleep: async () => {} });
  let shown = task();
  const write = (fields, result) => {
    const before = beforeOf(shown, fields);
    const t = Math.random().toString(36);
    return q.enqueue({
      key: "t1",
      apply: () => {
        o.add(t, "t1", fields);
        shown = { ...shown, ...fields };
      },
      rollback: () => {
        o.remove(t);
        shown = { ...shown, ...o.revert("t1", before) };
      },
      run: async () => result,
      onSuccess: (data) => {
        o.remove(t);
        shown = o.apply(data);
      },
    });
  };
  const a = write({ title: "New" }, { ok: false, error: "No access" });
  const b = write({ statusId: "done" }, { ok: true, data: task({ statusId: "done", updatedAt: "2" }) });
  assert.equal(shown.title, "New");
  assert.equal(shown.statusId, "done");
  await a.done;
  assert.equal(shown.title, "Old", "refused rename rolled back");
  assert.equal(shown.statusId, "done", "later status change kept");
  await b.done;
  assert.deepEqual(shown, task({ statusId: "done", updatedAt: "2" }));
  assert.equal(o.has("t1"), false);
});

test("pending creates: the echo claims the temporary row once, the answer after it is recognised", () => {
  const c = createPendingCreates();
  const id = c.newId();
  assert.ok(isTempId(id));
  c.register({ id, projectId: "p", title: "Fix login", createdBy: "me" });
  // Someone else's task with the same title, or another project: not ours.
  assert.equal(c.claim({ id: "x", projectId: "p", title: "Fix login", createdBy: "them" }), null);
  assert.equal(c.claim({ id: "y", projectId: "q", title: "Fix login", createdBy: "me" }), null);
  assert.equal(c.claim({ id: "r1", projectId: "p", title: "Fix login", createdBy: "me" }), id);
  // The same echo again (e.g. a second broadcast) doesn't claim anything else.
  assert.equal(c.claim({ id: "r1", projectId: "p", title: "Fix login", createdBy: "me" }), null);
  assert.equal(c.realIdOf(id), "r1");
  assert.equal(c.resolve(id, "r1"), true, "the answer knows the echo got there first");
  c.forget(id);
  assert.equal(c.pending().length, 0);
});

test("pending creates: two tasks with one title map to one temporary row each, oldest first", () => {
  const c = createPendingCreates();
  const a = c.newId();
  const b = c.newId();
  c.register({ id: a, projectId: "p", title: "Same", createdBy: "me" });
  c.register({ id: b, projectId: "p", title: "Same", createdBy: "me" });
  assert.equal(c.claim({ id: "r1", projectId: "p", title: "Same", createdBy: "me" }), a);
  assert.equal(c.claim({ id: "r2", projectId: "p", title: "Same", createdBy: "me" }), b);
  assert.equal(c.resolve(a, "r1"), true);
  assert.equal(c.pending().length, 0);
});

test("pending creates: an answer before any echo resolves without a claim", () => {
  const c = createPendingCreates();
  const a = c.newId();
  c.register({ id: a, projectId: "p", title: "T", createdBy: "me" });
  assert.equal(c.resolve(a, "r1"), false);
  assert.equal(c.pending().length, 0);
  // Its echo arriving later is not claimed (the list holds r1 by then).
  assert.equal(c.claim({ id: "r1", projectId: "p", title: "T", createdBy: "me" }), null);
});
