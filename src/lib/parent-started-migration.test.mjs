// Run with `pnpm test`. VEC-420: the backfill for parents already stuck in a not-started status while their sub-tasks
// are worked on (lib/parent-started-migration.ts), against a small in-memory stand-in for the Mongo collections it uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { ObjectId } from "mongodb";

// The migration uses the app's extensionless sibling imports; let node resolve them to .ts files.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (err) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context);
      throw err;
    }
  },
});
const { backfillParentStarted, planParentStarted, PARENT_STARTED_MIGRATION } = await import("./parent-started-migration.ts");

/* ---------- a tiny Mongo stand-in: the filters/operators the migration uses ---------- */
const same = (a, b) => (a instanceof ObjectId || b instanceof ObjectId ? !!a && !!b && String(a) === String(b) : a === b);
function matches(doc, filter) {
  return Object.entries(filter).every(([k, cond]) => {
    if (k === "$or") return cond.some((f) => matches(doc, f));
    const v = doc[k];
    if (cond && typeof cond === "object" && !(cond instanceof ObjectId)) {
      if ("$in" in cond) return cond.$in.some((x) => same(v, x));
      if ("$type" in cond) return v instanceof ObjectId;
      if ("$exists" in cond) return (v !== undefined) === cond.$exists;
    }
    if (cond === null) return v == null;
    return same(v, cond);
  });
}
function cursor(rows) {
  let list = rows;
  const c = {
    sort(spec) {
      const [[k, dir]] = Object.entries(spec);
      list = [...list].sort((a, b) => (a[k] < b[k] ? -dir : a[k] > b[k] ? dir : 0));
      return c;
    },
    limit(n) {
      list = list.slice(0, n);
      return c;
    },
    toArray: async () => list,
    next: async () => list[0] ?? null,
  };
  return c;
}
function fakeDb(data) {
  const colls = new Map(Object.entries(data));
  const coll = (name) => {
    if (!colls.has(name)) colls.set(name, []);
    const rows = colls.get(name);
    return {
      find: (f = {}) => cursor(rows.filter((d) => matches(d, f))),
      async updateOne(f, u) {
        const d = rows.find((x) => matches(x, f));
        if (!d) return { modifiedCount: 0 };
        Object.assign(d, u.$set);
        return { modifiedCount: 1 };
      },
      async insertOne(d) {
        rows.push(d);
        return { insertedId: d._id };
      },
    };
  };
  return { collection: coll, rows: (name) => colls.get(name) ?? [] };
}

/* ---------- fixture: one org, a VEC project with the standard statuses and the seeded default flow ---------- */
const org = new ObjectId();
const vec = new ObjectId();
const web = new ObjectId();
const st = {};
const statuses = [];
for (const [pid, prefix] of [
  [vec, "v"],
  [web, "w"],
]) {
  [
    ["Backlog", "backlog"],
    ["Triage", "triage"],
    ["Todo", "unstarted"],
    ["In Progress", "started"],
    ["In Review", "started"],
    ["Done", "done"],
    ["Cancelled", "cancelled"],
  ].forEach(([name, category], order) => {
    const _id = new ObjectId();
    st[`${prefix}${name.replace(" ", "")}`] = _id;
    statuses.push({ _id, orgId: org, projectId: pid, name, category, order });
  });
}
const ryan = new ObjectId();
const bot = new ObjectId();
let n = 0;
const task = (status, extra = {}) => ({
  _id: new ObjectId(),
  orgId: org,
  projectId: extra.projectId ?? vec,
  number: ++n,
  statusId: st[status],
  createdBy: ryan,
  assigneeId: null,
  updatedAt: new Date(Date.UTC(2026, 10, 20, 0, n)),
  ...extra,
});

function scenario() {
  n = 0;
  const ryans = task("vTodo"); // VEC-1: Ryan's case, 3 Done + 2 In Progress + 2 Todo
  const subsOfRyans = [
    ...["vDone", "vDone", "vDone", "vInProgress", "vInProgress", "vTodo", "vTodo"].map((s) => task(s, { parentId: ryans._id })),
  ];
  const doneOnly = task("vTodo"); // VEC-9: only a Done sub-task counts too
  const doneSub = task("vDone", { parentId: doneOnly._id });
  const cancelledOnly = task("vTodo"); // cancelled + Todo sub-tasks only: stays
  const cancelledSubs = [task("vCancelled", { parentId: cancelledOnly._id }), task("vTodo", { parentId: cancelledOnly._id })];
  const parked = task("vBacklog"); // Backlog parent: stays
  const parkedSub = task("vInProgress", { parentId: parked._id });
  const triage = task("vTriage"); // Triage parent: stays
  const triageSub = task("vInProgress", { parentId: triage._id });
  const already = task("vInReview"); // already started: never backwards / sideways
  const alreadySub = task("vInProgress", { parentId: already._id });
  const archived = task("vTodo", { archivedAt: new Date() }); // archived parent: stays
  const archivedParentSub = task("vInProgress", { parentId: archived._id });
  const archivedSubOnly = task("vTodo"); // its only active sub-task is archived: stays
  const archivedSub = task("vInProgress", { parentId: archivedSubOnly._id, archivedAt: new Date() });
  const stopped = task("vTodo", { stopped: { by: ryan } }); // a person stopped it: stays
  const stoppedSub = task("vInProgress", { parentId: stopped._id });
  const cross = task("vTodo"); // sub-task in another project: parent moves in its OWN project
  const crossSub = task("wInProgress", { parentId: cross._id, projectId: web });
  const tasks = [
    ryans,
    ...subsOfRyans,
    doneOnly,
    doneSub,
    cancelledOnly,
    ...cancelledSubs,
    parked,
    parkedSub,
    triage,
    triageSub,
    already,
    alreadySub,
    archived,
    archivedParentSub,
    archivedSubOnly,
    archivedSub,
    stopped,
    stoppedSub,
    cross,
    crossSub,
  ];
  // The bot moved Ryan's newest In Progress sub-task: the activity on the parent is attributed to it.
  const activity = [{ _id: new ObjectId(), orgId: org, taskId: subsOfRyans[4]._id, actorId: bot, kind: "status", createdAt: new Date() }];
  const db = fakeDb({
    tasks,
    statuses,
    activity,
    projects: [
      { _id: vec, orgId: org, key: "VEC" },
      { _id: web, orgId: org, key: "WEB" },
    ],
    flows: [],
    bots: [{ _id: bot, orgId: org, name: "Hermes" }],
    memberships: [{ _id: new ObjectId(), orgId: org, userId: ryan }],
    users: [{ _id: ryan, name: "Ryan" }],
  });
  return { db, ryans, subsOfRyans, doneOnly, cross, bot };
}

test("dry run finds Ryan's parent, a done-only parent and a cross-project one, and writes nothing", async () => {
  const { db } = scenario();
  const before = JSON.stringify(db.rows("tasks"));
  const r = await backfillParentStarted(db, { dryRun: true });
  assert.equal(r.found, 3);
  assert.equal(r.moved, 0);
  assert.deepEqual(r.keys, ["VEC-1 Todo -> In Progress (VEC-6 started)", "VEC-9 Todo -> In Progress (VEC-10 done)", "VEC-26 Todo -> In Progress (WEB-27 started)"]);
  assert.equal(JSON.stringify(db.rows("tasks")), before);
  assert.equal(db.rows("activity").length, 1);
});

test("apply moves them to their own project's first started status with one activity each, attributed sensibly", async () => {
  const { db, ryans, doneOnly, cross, bot } = scenario();
  const r = await backfillParentStarted(db);
  assert.deepEqual([r.found, r.moved], [3, 3]);
  const status = (t) => String(db.rows("tasks").find((x) => x._id.equals(t._id)).statusId);
  assert.equal(status(ryans), String(st.vInProgress));
  assert.equal(status(doneOnly), String(st.vInProgress));
  assert.equal(status(cross), String(st.vInProgress), "parent's own project, not the sub-task's");
  const acts = db.rows("activity").filter((a) => a.note);
  assert.equal(acts.length, 3);
  const onRyans = acts.find((a) => a.taskId.equals(ryans._id));
  assert.deepEqual(
    { kind: onRyans.kind, from: onRyans.from, to: onRyans.to, note: onRyans.note, subtask: onRyans.subtask, actor: String(onRyans.actorId) },
    { kind: "status", from: String(st.vTodo), to: String(st.vInProgress), note: "subtask_started", subtask: "VEC-6", actor: String(bot) },
  );
  const onDone = acts.find((a) => a.taskId.equals(doneOnly._id));
  assert.equal(onDone.note, "subtask_done");
  assert.equal(String(onDone.actorId), String(ryan), "no status activity on the sub-task: falls back to its creator");
});

test("a second run is a no-op", async () => {
  const { db } = scenario();
  await backfillParentStarted(db);
  const acts = db.rows("activity").length;
  const r = await backfillParentStarted(db);
  assert.deepEqual([r.found, r.moved, r.keys.length], [0, 0, 0]);
  assert.equal(db.rows("activity").length, acts);
});

test("the write is conditional: a parent someone moved since the plan was read is left alone", async () => {
  const { db, ryans } = scenario();
  const plan = await planParentStarted(db);
  assert.ok(plan.some((m) => m.parentId.equals(ryans._id)));
  db.rows("tasks").find((x) => x._id.equals(ryans._id)).statusId = st.vDone;
  // Re-planning drops it; the stored status stays Done.
  const r = await backfillParentStarted(db);
  assert.equal(r.keys.some((k) => k.startsWith("VEC-1 ")), false);
  assert.equal(String(db.rows("tasks").find((x) => x._id.equals(ryans._id)).statusId), String(st.vDone));
});

test("a flow step that keeps its status or waits leaves the parent alone (pickupDecision / waitStepAt)", async () => {
  for (const advance of ["wait", "complete"]) {
    const { db, ryans } = scenario();
    // Custom flow on VEC: a Todo step whose working status is taken by a later step (In Progress), and In Review.
    db.rows("projects")[0].flowMode = "custom";
    const step = (id, stage, name, extra = {}) => ({ id, name, status: { stage, statusId: st[name] }, owner: { kind: "keep" }, instructions: "", advance: "complete", required: true, ...extra });
    db.rows("flows").push({
      _id: new ObjectId(),
      orgId: org,
      projectId: vec,
      version: 1,
      steps: [
        step("todo", "unstarted", "vTodo", advance === "wait" ? { advance: "wait", wait: { label: "Ryan signs off", resolvers: [ryan] } } : {}),
        step("work", "started", "vInProgress"),
        step("review", "started", "vInReview"),
        step("done", "done", "vDone"),
      ],
    });
    const r = await backfillParentStarted(db, { dryRun: true });
    assert.equal(r.keys.some((k) => k.startsWith("VEC-1 ")), false, advance);
    assert.equal(r.keys.some((k) => k.startsWith("VEC-26 ")), false, "same project, same flow");
    void ryans;
  }
  // Control: the same flow with a free working status moves it (the flow's own working status, In Progress).
  {
    const { db } = scenario();
    db.rows("projects")[0].flowMode = "custom";
    const step = (id, stage, name) => ({ id, name, status: { stage, statusId: st[name] }, owner: { kind: "keep" }, advance: "complete", required: true });
    db.rows("flows").push({ _id: new ObjectId(), orgId: org, projectId: vec, version: 1, steps: [step("todo", "unstarted", "vTodo"), step("review", "started", "vInReview"), step("done", "done", "vDone")] });
    const r = await backfillParentStarted(db, { dryRun: true });
    assert.ok(r.keys.includes("VEC-1 Todo -> In Progress (VEC-6 started)"), r.keys.join("; "));
  }
});

test("wired into ensureIndexes under its migration id, after the sub-task parent backfill", () => {
  assert.equal(PARENT_STARTED_MIGRATION, "2026-11-parent-started");
  const db = readFileSync(new URL("./db.ts", import.meta.url), "utf8");
  const a = db.indexOf("once(TASK_PARENT_MIGRATION");
  const b = db.indexOf("once(PARENT_STARTED_MIGRATION");
  assert.ok(a > 0 && b > a);
  const mig = readFileSync(new URL("./parent-started-migration.ts", import.meta.url), "utf8");
  // Same rule as the live hook, and nothing that wakes, notifies or publishes.
  for (const used of ["parentProgress(", "parentTarget(", "pickupDecision(", "waitStepAt("]) assert.ok(mig.includes(used), used);
  for (const banned of ['import "server-only"', 'from "@/', "publish(", "notify(", "wakeBots", "wakeTriage"]) assert.equal(mig.includes(banned), false, banned);
});
