// Run with `pnpm test`. VEC-426: setting, changing or clearing an existing task's parent (planParentChange), its
// activity wording, who may do it (access.ts), and the agent-facing text for update_task / REST PATCH `parent`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parentChangeText, planParentChange } from "./parent-link-core.ts";
import { refusePatch, taskAccess, TRIAGE_FIELDS, ASSIGNEE_FIELDS } from "./access.ts";

const top = (id, key = id.toUpperCase()) => ({ id, key, parentId: null, archived: false });
const sub = (id, parentId, key = id.toUpperCase(), parentKey = parentId.toUpperCase()) => ({ id, key, parentId, parentKey, archived: false });
const child = (over = {}) => ({ id: "c", key: "C", parentId: null, hasChildren: false, ...over });

test("attach: a top-level task goes under a top-level parent", () => {
  assert.deepEqual(planParentChange(child(), top("p")), { ok: true, change: { from: null, to: "p" } });
});

test("detach: null clears the parent; already top-level is no change", () => {
  assert.deepEqual(planParentChange(child({ parentId: "p" }), null), { ok: true, change: { from: "p", to: null } });
  assert.deepEqual(planParentChange(child(), null), { ok: true, change: null });
});

test("re-parent: moves from the old parent to the new one; same parent is no change", () => {
  assert.deepEqual(planParentChange(child({ parentId: "p" }), top("q")), { ok: true, change: { from: "p", to: "q" } });
  assert.deepEqual(planParentChange(child({ parentId: "p" }), top("p")), { ok: true, change: null });
});

test("flatten: a sub-task given as parent files it under that sub-task's own parent", () => {
  assert.deepEqual(planParentChange(child(), sub("s", "p"), top("p")), { ok: true, change: { from: null, to: "p", flattenedFrom: "S" } });
  // Already under that root: nothing changes.
  assert.deepEqual(planParentChange(child({ parentId: "p" }), sub("s", "p"), top("p")), { ok: true, change: null });
  // Root not loaded (dangling link): refused with the one-level message instead of guessing.
  const r = planParentChange(child(), sub("s", "p"));
  assert.equal(r.ok, false);
  assert.match(r.error, /S is itself a sub-task.*Use P/);
  // An archived root is refused like any archived parent.
  const a = planParentChange(child(), sub("s", "p"), { ...top("p"), archived: true });
  assert.equal(a.ok, false);
  assert.match(a.error, /P is archived/);
});

test("refuses a child that has sub-tasks of its own, and says so", () => {
  const r = planParentChange(child({ hasChildren: true }), top("p"));
  assert.equal(r.ok, false);
  assert.match(r.error, /C has sub-tasks of its own, so it can't go under P/);
  // Detaching a task with sub-tasks is fine (it is top-level already, or becomes it).
  assert.deepEqual(planParentChange(child({ hasChildren: true }), null), { ok: true, change: null });
});

test("cycle and self: refused", () => {
  const self = planParentChange(child(), top("c", "C"));
  assert.equal(self.ok, false);
  assert.match(self.error, /its own parent/);
  // S is C's own sub-task: not flattened back onto C itself, refused as a cycle.
  const cyc = planParentChange(child({ hasChildren: true }), sub("s", "c", "S", "C"), top("c", "C"));
  assert.equal(cyc.ok, false);
  assert.match(cyc.error, /S is a sub-task of C, so it can't be its parent/);
});

test("archived parent: refused", () => {
  const r = planParentChange(child(), { ...top("p"), archived: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /P is archived\. Restore it/);
});

test("activity wording", () => {
  assert.equal(parentChangeText(null, "VEC-10"), "made it a sub-task of VEC-10");
  assert.equal(parentChangeText("VEC-10", null), "removed it from VEC-10");
  assert.equal(parentChangeText("VEC-10", "VEC-11"), "made it a sub-task of VEC-11 (was under VEC-10)");
  assert.equal(parentChangeText(null, "VEC-10", "this"), "made this a sub-task of VEC-10");
  assert.equal(parentChangeText(null, null), "removed it from its parent task");
});

test("permission: creator or admin (full), triager; not the assignee or anyone else", () => {
  assert.equal(taskAccess({ createdBy: "u", assigneeId: null }, "u", false), "full");
  assert.equal(taskAccess({ createdBy: "u", assigneeId: null }, "x", true), "full");
  assert.equal(taskAccess({ createdBy: "u", assigneeId: "a" }, "a", false), "assignee");
  assert.equal(taskAccess({ createdBy: "u", assigneeId: "a" }, "x", false), "comment");
  assert.ok(!ASSIGNEE_FIELDS.includes("parentId"));
  assert.ok(TRIAGE_FIELDS.includes("parentId"), "a triager may group it, like dependsOn");
  const refused = refusePatch({ parentId: "p" }, false);
  assert.deepEqual(refused?.blocked, ["parentId"]);
  assert.match(refused.error, /dependencies or parent task/);
  assert.equal(refusePatch({ parentId: null }, true), null);
  // undefined doesn't count as setting it.
  assert.equal(refusePatch({ parentId: undefined, priority: 2 }, false), null);
});

test("agent text: update_task and REST PATCH document `parent`, task-service passes it through", () => {
  const server = readFileSync(new URL("./mcp/server.ts", import.meta.url), "utf8");
  const updateTool = server.slice(server.indexOf("update_task: {"), server.indexOf("create_task: {"));
  assert.match(updateTool, /parent: \{\s*type: \["string", "null"\]/);
  assert.match(updateTool, /parentId: await parentArg\(ctx, args\.parent\)/);
  assert.match(updateTool, /dependencies, parent and archiving are creator-only/);
  const rest = readFileSync(new URL("../app/api/v1/tasks/[key]/route.ts", import.meta.url), "utf8");
  assert.match(rest, /parentId: await parentRef\(ctx\.org\._id, b\.parent\)/);
  const service = readFileSync(new URL("./task-service.ts", import.meta.url), "utf8");
  assert.match(service, /parentForUpdate\(actor\.orgId, before, patch\.parentId\)/);
  assert.match(service, /kind: "parent", from: parentChange\.fromKey, to: parentChange\.toKey/);
});
