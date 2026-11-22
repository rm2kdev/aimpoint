// Run with `pnpm test`. VEC-407: sub-task parent links. Pure rules from lib/parent-link-core.ts (auto parent from a
// bot's claims, one-level / self / cycle / archived refusal, the children summary, the backfill selector) and the agent
// wording that tells triagers and tool callers about `parent`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { autoParentId, checkParentLink, selectBackfill, summariseChildren } from "./parent-link-core.ts";

const fresh = { id: null, key: null, hasChildren: false };
const top = (id, key = id.toUpperCase()) => ({ id, key, parentId: null, archived: false });

test("auto parent: the one task a bot's claim is on", () => {
  assert.equal(autoParentId([{ id: "a", parentId: null }]), "a");
});

test("auto parent: a claim on a sub-task leads to its parent (one level)", () => {
  assert.equal(autoParentId([{ id: "sub", parentId: "umb" }]), "umb");
});

test("auto parent: several claims that lead to the same task use it", () => {
  // Triaging the umbrella while working one of its sub-tasks.
  assert.equal(autoParentId([{ id: "umb", parentId: null }, { id: "sub", parentId: "umb" }]), "umb");
});

test("auto parent: several unrelated claims or none leave it unset", () => {
  assert.equal(autoParentId([{ id: "a", parentId: null }, { id: "b", parentId: null }]), null);
  assert.equal(autoParentId([{ id: "s1", parentId: "a" }, { id: "s2", parentId: "b" }]), null);
  assert.equal(autoParentId([]), null);
});

test("explicit parent: a top-level, unarchived task is accepted", () => {
  assert.deepEqual(checkParentLink(fresh, top("p", "VEC-1")), { ok: true });
});

test("explicit parent: a sub-task is refused (one level), naming the task to use instead", () => {
  const r = checkParentLink(fresh, { id: "s", key: "VEC-2", parentId: "p", parentKey: "VEC-1", archived: false });
  assert.equal(r.ok, false);
  assert.match(r.error, /VEC-2 is itself a sub-task/);
  assert.match(r.error, /Use VEC-1/);
});

test("refuses self and cycles", () => {
  assert.match(checkParentLink({ id: "x", key: "VEC-5", hasChildren: false }, top("x", "VEC-5")).error, /own parent/);
  // Making VEC-1 a child of its own sub-task VEC-2.
  const r = checkParentLink({ id: "p", key: "VEC-1", hasChildren: true }, { id: "s", key: "VEC-2", parentId: "p", archived: false });
  assert.equal(r.ok, false);
  assert.match(r.error, /VEC-2 is a sub-task of VEC-1/);
});

test("a task with sub-tasks can't become a sub-task; an archived parent is refused", () => {
  assert.match(checkParentLink({ id: "p", key: "VEC-1", hasChildren: true }, top("q", "VEC-9")).error, /has sub-tasks of its own/);
  assert.match(checkParentLink(fresh, { ...top("q", "VEC-9"), archived: true }).error, /VEC-9 is archived/);
});

test("children summary counts done and cancelled separately", () => {
  assert.deepEqual(
    summariseChildren([
      { category: "done", n: 3 },
      { category: "cancelled", n: 1 },
      { category: "started", n: 2 },
      { category: null, n: 1 },
    ]),
    { total: 7, done: 3, cancelled: 1 },
  );
  assert.deepEqual(summariseChildren([]), { total: 0, done: 0, cancelled: 0 });
});

const task = (id, over = {}) => ({ id, orgId: "o", createdBy: "user", createdAt: 0, dependsOn: [], triagedBy: null, parentId: null, ...over });

test("backfill: bot-created tasks the umbrella its creator triaged depends on get that umbrella", () => {
  const tasks = [
    task("umb", { triagedBy: "bot", dependsOn: ["a", "b", "c", "d"], createdAt: 10 }),
    task("a", { createdBy: "bot" }),
    task("b", { createdBy: "bot" }),
    task("c", { createdBy: "otherbot" }), // another bot's task: not this triage's
    task("d", { createdBy: "user" }), // a person's task the umbrella waits on
    task("e", { createdBy: "bot" }), // created by the bot but not listed
  ];
  assert.deepEqual([...selectBackfill(tasks)].sort(), [["a", "umb"], ["b", "umb"]]);
});

test("backfill: no triagedBy, other orgs, existing parents and self are left alone", () => {
  const tasks = [
    task("u1", { dependsOn: ["a"] }), // nobody triaged it
    task("a", { createdBy: "bot" }),
    task("u2", { triagedBy: "bot", dependsOn: ["x", "y", "u2"] }),
    task("x", { createdBy: "bot", orgId: "other" }),
    task("y", { createdBy: "bot", parentId: "zzz" }),
  ];
  assert.equal(selectBackfill(tasks).size, 0);
});

test("backfill: a task two umbrellas claim goes to the oldest", () => {
  const tasks = [
    task("late", { triagedBy: "bot", dependsOn: ["s"], createdAt: 20 }),
    task("early", { triagedBy: "bot", dependsOn: ["s"], createdAt: 5 }),
    task("s", { createdBy: "bot" }),
  ];
  assert.deepEqual([...selectBackfill(tasks)], [["s", "early"]]);
});

test("backfill: one level, nested triages flatten to the top task and nothing is both parent and child", () => {
  // root (triaged by bot) -> mid (created + triaged by bot) -> leaf (created by bot).
  const tasks = [
    task("root", { triagedBy: "bot", dependsOn: ["mid"], createdAt: 1 }),
    task("mid", { createdBy: "bot", triagedBy: "bot", dependsOn: ["leaf"], createdAt: 2 }),
    task("leaf", { createdBy: "bot", createdAt: 3 }),
  ];
  const out = selectBackfill(tasks);
  assert.deepEqual([...out].sort(), [["leaf", "root"], ["mid", "root"]]);
  for (const p of out.values()) assert.ok(!out.has(p));
});

test("backfill: a task that already has sub-tasks stays top-level; selector is idempotent", () => {
  const tasks = [
    task("umb", { triagedBy: "bot", dependsOn: ["owner"] }),
    task("owner", { createdBy: "bot" }),
    task("kid", { createdBy: "bot", parentId: "owner" }),
  ];
  assert.equal(selectBackfill(tasks).size, 0);
  // After applying a plan, running it again picks nothing new.
  const first = [task("umb", { triagedBy: "bot", dependsOn: ["a"] }), task("a", { createdBy: "bot" })];
  const plan = selectBackfill(first);
  const applied = first.map((t) => (plan.has(t.id) ? { ...t, parentId: plan.get(t.id) } : t));
  assert.equal(selectBackfill(applied).size, 0);
});

test("backfill: a dependency loop never writes a loop", () => {
  const tasks = [
    task("a", { createdBy: "bot", triagedBy: "bot", dependsOn: ["b"] }),
    task("b", { createdBy: "bot", triagedBy: "bot", dependsOn: ["a"] }),
  ];
  const out = selectBackfill(tasks);
  for (const [c, p] of out) assert.notEqual(out.get(p), c);
});

const dispatch = readFileSync(new URL("./bot-dispatch.ts", import.meta.url), "utf8");
const server = readFileSync(new URL("./mcp/server.ts", import.meta.url), "utf8");
const block = (src, start, end) => src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)));

test("triage steps and tool descriptions say sub-tasks are grouped under the task they're filed from", () => {
  const step3 = block(dispatch, "export const TRIAGE_STEPS", "export const CLOSEOUT_STEPS").split("\n").find((l) => l.includes("3. create_task"));
  assert.match(step3, /\\?`parent\\?` "\$\{key\}"/);
  assert.match(step3, /grouped under the task they're filed from/);
  const create = block(server, "  create_task: {", "inputSchema");
  assert.match(create, /grouped under the task they're filed from/);
  const createSchema = block(server, "  create_task: {", "run: async");
  assert.match(createSchema, /parent: \{/);
  assert.match(block(server, "  list_tasks: {", "run: async"), /top_level: \{ type: "boolean"/);
  assert.match(block(server, "  get_task: {", "run: async"), /`children`/);
  assert.match(block(dispatch, "export const BLOCKER_NOTE", "export const STOP_NOTE"), /pass `parent`/);
});
