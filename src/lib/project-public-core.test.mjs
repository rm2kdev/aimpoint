// Run with `pnpm test` (node --test; Node strips the TypeScript types of project-public-core.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PUBLIC_SUBMIT_STAGES,
  isPublicSubmitStage,
  resolveSubmitStatuses,
  pruneSubmitStatuses,
  pickSubmitStatus,
  initialSubmitStatuses,
  intakeSkips,
  rewritePublicImages,
  localUploadNames,
  publicImagePath,
  publicCommentBody,
  shapePublicTask,
  shapePublicSubtask,
  shapePublicSubtaskEntry,
  publicListRows,
  passesPublicStatusFilter,
  publicProgress,
  shapePublicComment,
  parsePublicRef,
  computeStats,
  shapeBadge,
  badgeLabel,
  badgeMarkdown,
  shieldsImageUrl,
  isBadgeMetric,
  BADGE_METRICS,
  STATS_TYPES,
  PUBLIC_STATS_CACHE,
} from "./project-public-core.ts";
import { publicSanitize } from "./task-intake-core.ts";

const ORG = "6af98310a81f713925ea19bc";
const OTHER = "6af98310a81f713925ea19bd";
const statuses = [
  { id: "a".repeat(24), name: "Backlog", category: "backlog" },
  { id: "b".repeat(24), name: "Triage", category: "triage" },
  { id: "c".repeat(24), name: "Todo", category: "unstarted" },
  { id: "d".repeat(24), name: "In Progress", category: "started" },
  { id: "e".repeat(24), name: "Done", category: "done" },
  { id: "f".repeat(24), name: "Cancelled", category: "cancelled" },
];
const [B, T, U, S, D, C] = statuses.map((s) => s.id);

test("submit stages are backlog, triage and not started (the forms rule)", () => {
  assert.deepEqual([...PUBLIC_SUBMIT_STAGES], ["backlog", "triage", "unstarted"]);
  for (const s of ["started", "done", "cancelled", "", null, 3]) assert.equal(isPublicSubmitStage(s), false);
});

test("resolveSubmitStatuses keeps order, drops duplicates, allows an empty list", () => {
  assert.deepEqual(resolveSubmitStatuses([T, B, T], statuses), { ok: true, ids: [T, B] });
  assert.deepEqual(resolveSubmitStatuses([], statuses), { ok: true, ids: [] });
  assert.deepEqual(resolveSubmitStatuses([U], statuses), { ok: true, ids: [U] });
});

test("resolveSubmitStatuses refuses other stages, other projects' ids and non-lists", () => {
  for (const bad of [[S], [D], [C], [B, D]]) {
    const r = resolveSubmitStatuses(bad, statuses);
    assert.equal(r.ok, false);
    assert.match(r.error, /only go into Backlog, Triage or a not-started status/);
  }
  const foreign = resolveSubmitStatuses(["0".repeat(24)], statuses);
  assert.equal(foreign.ok, false);
  assert.match(foreign.error, /isn't one of this project's statuses/);
  assert.equal(resolveSubmitStatuses([42], statuses).ok, false);
  assert.equal(resolveSubmitStatuses("x", statuses).ok, false);
  assert.equal(resolveSubmitStatuses(null, statuses).ok, false);
});

test("pruneSubmitStatuses drops deleted and re-staged statuses", () => {
  const restaged = statuses.map((s) => (s.id === T ? { ...s, category: "started" } : s));
  assert.deepEqual(pruneSubmitStatuses([T, B, "0".repeat(24), U], restaged), [B, U]);
  assert.deepEqual(pruneSubmitStatuses([B, B], statuses), [B]);
});

test("pickSubmitStatus defaults to the first allowed one and refuses others", () => {
  assert.deepEqual(pickSubmitStatus(undefined, [T, B]), { ok: true, id: T });
  assert.deepEqual(pickSubmitStatus("", [T, B]), { ok: true, id: T });
  assert.deepEqual(pickSubmitStatus(B, [T, B]), { ok: true, id: B });
  assert.equal(pickSubmitStatus(U, [T, B]).ok, false);
  assert.equal(pickSubmitStatus({}, [T]).ok, false);
  assert.match(pickSubmitStatus(undefined, []).error, /isn't taking new tickets/);
});

test("public images: own uploads re-pointed, other local files dropped, absolute kept", () => {
  const own = `${ORG}-AbCdEfGhIjKlMnOp.png`;
  const html = publicSanitize(
    `<p>a<img src="/api/uploads/${own}" alt="x" width="10"></p>` +
      `<img src="/api/uploads/${OTHER}-AbCdEfGhIjKlMnOp.png">` +
      `<img src="/api/uploads/avatar-${ORG}-AbCdEfGhIjKlMnOpQrStU.png">` +
      `<img src="https://x.public.blob.vercel-storage.com/uploads/${own}">` +
      `<img src="javascript:alert(1)"><img src="data:image/png;base64,AA==">`,
    { allowImages: true },
  );
  const out = rewritePublicImages(html, { orgId: ORG, slug: "northwind", key: "VEC" });
  assert.ok(out.includes(`src="${publicImagePath("northwind", "VEC", "AbCdEfGhIjKlMnOp.png")}"`), out);
  assert.equal(out.split(ORG).length - 1, 1, "only the Blob URL still names the org id");
  assert.ok(out.includes(`src="https://x.public.blob.vercel-storage.com/uploads/${own}"`));
  assert.ok(!out.includes(OTHER), out);
  assert.ok(!out.includes("avatar-"), out);
  assert.ok(!/javascript:|data:/.test(out), out);
  assert.ok(!out.includes("width"), out);
  assert.equal((out.match(/<img/g) ?? []).length, 2);
});

test("localUploadNames lists referenced local uploads once", () => {
  const n = `${ORG}-AbCdEfGhIjKlMnOp.png`;
  assert.deepEqual(localUploadNames(`<img src="/api/uploads/${n}"><p><img alt="" src="/api/uploads/${n}"></p><img src="https://a/b.png">`), [n]);
});

test("comment bodies show mentions by name only", () => {
  const names = new Map([[ORG, "Mia Chen"]]);
  assert.equal(publicCommentBody(`hi <@${ORG}> and <@${OTHER}>`, (id) => names.get(id)), "hi @Mia Chen and @someone");
  const cm = shapePublicComment({ authorId: OTHER, body: "x", createdAt: new Date("2026-11-18T00:00:00Z"), mentions: [ORG], orgId: ORG, _id: ORG }, (id) => names.get(id));
  assert.deepEqual(cm, { author: "Former member", body: "x", createdAt: "2026-11-18T00:00:00.000Z" });
});

test("shapePublicTask copies only the allow-listed fields", () => {
  const status = { id: T, name: "Triage", color: "#888888", stage: "triage" };
  const doc = {
    _id: ORG,
    orgId: ORG,
    projectId: ORG,
    number: 12,
    title: "Crash on save",
    type: "issue",
    statusId: T,
    priority: 2,
    description: "<p>secret html not used</p>",
    assigneeId: OTHER,
    createdBy: OTHER,
    source: { kind: "public", userId: OTHER, userName: "X" },
    flow: { stepId: "build" },
    dependsOn: [OTHER],
    waitingOn: [OTHER],
    closeout: { botId: OTHER },
    rank: "a0",
    parentId: OTHER,
    createdByBot: true,
    triagePlan: "<p>secret plan</p>",
    createdAt: new Date("2026-11-18T01:00:00Z"),
    updatedAt: new Date("2026-11-18T02:00:00Z"),
  };
  const t = shapePublicTask(doc, "VEC", new Map([[T, status]]), "<p>clean</p>");
  assert.deepEqual(Object.keys(t).sort(), ["createdAt", "description", "key", "priority", "progress", "status", "title", "type", "updatedAt"]);
  assert.deepEqual(t, {
    key: "VEC-12",
    title: "Crash on save",
    type: "issue",
    status,
    priority: 2,
    description: "<p>clean</p>",
    createdAt: "2026-11-18T01:00:00.000Z",
    updatedAt: "2026-11-18T02:00:00.000Z",
    progress: null,
  });
  assert.equal(shapePublicTask({ ...doc, statusId: S }, "VEC", new Map([[T, status]]), "").status, null);
  assert.ok(!JSON.stringify(t).includes(OTHER));
});

test("parsePublicRef normalises slug and key and refuses junk", () => {
  assert.deepEqual(parsePublicRef(" Northwind ", "vec"), { slug: "northwind", key: "VEC" });
  for (const [s, k] of [["", "VEC"], ["north wind", "VEC"], ["northwind", "1AB"], ["northwind", "V"], [{}, "VEC"], ["northwind", null], ["a/b", "VEC"]]) {
    assert.equal(parsePublicRef(s, k), null);
  }
});

test("initialSubmitStatuses seeds the new-task status when nothing is saved (AIM-2)", () => {
  assert.deepEqual(initialSubmitStatuses([], T, statuses), [T]);
  assert.deepEqual(initialSubmitStatuses([], U, statuses), [U]);
  assert.deepEqual(initialSubmitStatuses([B], T, statuses), [B], "a saved list is kept");
  assert.deepEqual(initialSubmitStatuses([], S, statuses), [], "a started new-task status can't take submissions");
  assert.deepEqual(initialSubmitStatuses([], null, statuses), []);
  assert.deepEqual(initialSubmitStatuses([], "9".repeat(24), statuses), []);
});

test("intakeSkips flags a default that isn't the new-task status (AIM-2)", () => {
  assert.equal(intakeSkips([B], T, statuses)?.id, T, "Backlog default skips Triage");
  assert.equal(intakeSkips([B, T], T, statuses)?.id, T, "Triage allowed but not the default");
  assert.equal(intakeSkips([T, B], T, statuses), null);
  assert.equal(intakeSkips([], T, statuses), null, "read-only project");
  assert.equal(intakeSkips([B], S, statuses), null, "new-task status outside the submit stages");
  assert.equal(intakeSkips([B], null, statuses), null);
});

test("a project seeded from its new-task status files public tickets there (AIM-2)", () => {
  const allowed = pruneSubmitStatuses(initialSubmitStatuses([], T, statuses), statuses);
  assert.deepEqual(pickSubmitStatus(undefined, allowed), { ok: true, id: T });
});

/* ---------------- public stats + badges (VEC-363) ---------------- */

const statRows = [
  { stage: "backlog", type: "issue", count: 2 },
  { stage: "triage", type: "feature", count: 1 },
  { stage: "unstarted", type: "issue", count: 3 },
  { stage: "started", type: "issue", count: 1 },
  { stage: "started", type: "feature", count: 2 },
  { stage: "done", type: "issue", count: 5 },
  { stage: "done", type: "task", count: 1 },
  { stage: "cancelled", type: "feature", count: 4 },
];

test("computeStats counts by stage overall and per type", () => {
  const s = computeStats(statRows);
  assert.deepEqual(
    { total: s.total, open: s.open, inProgress: s.inProgress, done: s.done, cancelled: s.cancelled },
    { total: 19, open: 9, inProgress: 3, done: 6, cancelled: 4 },
  );
  assert.deepEqual(s.byType.issue, { total: 11, open: 6, inProgress: 1, done: 5, cancelled: 0 });
  assert.deepEqual(s.byType.feature, { total: 7, open: 3, inProgress: 2, done: 0, cancelled: 4 });
  assert.deepEqual(s.byType.task, { total: 1, open: 0, inProgress: 0, done: 1, cancelled: 0 });
  assert.deepEqual(Object.keys(s.byType).sort(), [...STATS_TYPES].sort());
});

test("computeStats: rows split across custom statuses of one stage add up; empty project is all zeros", () => {
  const split = computeStats([
    { stage: "started", type: "issue", count: 1 },
    { stage: "started", type: "issue", count: 2 },
  ]);
  assert.equal(split.inProgress, 3);
  assert.equal(split.open, 3);
  const empty = computeStats([]);
  assert.deepEqual({ ...empty, byType: undefined }, { total: 0, open: 0, inProgress: 0, done: 0, cancelled: 0, byType: undefined });
  assert.equal(empty.byType.feature.open, 0);
});

test("computeStats: unknown status counts in total only, unknown type overall only, bad counts ignored", () => {
  const s = computeStats([
    { stage: null, type: "issue", count: 2 },
    { stage: "backlog", type: "epic", count: 1 },
    { stage: "done", type: "issue", count: -3 },
    { stage: "done", type: "issue", count: Number.NaN },
  ]);
  assert.equal(s.total, 3);
  assert.equal(s.open, 1);
  assert.equal(s.done, 0);
  assert.deepEqual(s.byType.issue, { total: 2, open: 0, inProgress: 0, done: 0, cancelled: 0 });
});

test("shapeBadge returns exactly the shields.io endpoint fields for every metric", () => {
  const s = computeStats(statRows);
  const want = {
    open: { label: "open", message: "9", color: "blue" },
    "in-progress": { label: "in progress", message: "3", color: "yellow" },
    done: { label: "done", message: "6", color: "brightgreen" },
    total: { label: "tasks", message: "19", color: "informational" },
    bugs: { label: "open bugs", message: "6", color: "red" },
    features: { label: "feature requests", message: "3", color: "blueviolet" },
  };
  assert.deepEqual([...BADGE_METRICS].sort(), Object.keys(want).sort());
  for (const m of BADGE_METRICS) {
    const b = shapeBadge(m, s);
    assert.deepEqual(b, { schemaVersion: 1, ...want[m] }, m);
    assert.deepEqual(Object.keys(b).sort(), ["color", "label", "message", "schemaVersion"]);
    assert.equal(typeof b.message, "string");
  }
});

test("shapeBadge: no open bugs is green, unknown metrics are null", () => {
  const s = computeStats([{ stage: "done", type: "issue", count: 2 }]);
  assert.deepEqual(shapeBadge("bugs", s), { schemaVersion: 1, label: "open bugs", message: "0", color: "brightgreen" });
  for (const bad of ["", "Open", "issues", "__proto__", "toString", null, undefined, 1]) {
    assert.equal(isBadgeMetric(bad), false, String(bad));
    assert.equal(shapeBadge(bad, s), null, String(bad));
  }
});

test("stats are cached by shared caches for 5 minutes", () => {
  assert.equal(PUBLIC_STATS_CACHE, "public, s-maxage=300, stale-while-revalidate=600");
});

test("badgeMarkdown links the shields image to the public board (VEC-364)", () => {
  const endpoint = "https://app.aimpoint.dev/api/public/rm2kdev/AIM/badge/bugs";
  const board = "https://app.aimpoint.dev/p/rm2kdev/AIM";
  assert.equal(shieldsImageUrl(endpoint), "https://img.shields.io/endpoint?url=https%3A%2F%2Fapp.aimpoint.dev%2Fapi%2Fpublic%2Frm2kdev%2FAIM%2Fbadge%2Fbugs");
  assert.equal(badgeMarkdown("bugs", endpoint, board), `[![Open bugs](${shieldsImageUrl(endpoint)})](${board})`);
  assert.equal(badgeMarkdown("in-progress", endpoint, board).slice(0, 16), "[![In progress](");
  for (const m of BADGE_METRICS) assert.ok(badgeLabel(m).length > 0);
  // Labels match the badge JSON.
  const stats = computeStats([]);
  for (const m of BADGE_METRICS) assert.equal(shapeBadge(m, stats).label, badgeLabel(m));
});

/* ---------------- sub-tasks folded under requests (VEC-409) ---------------- */

test("shapePublicTask carries sub-task progress only as {total, done}, null when there are none", () => {
  const doc = { number: 5, title: "Umbrella", type: "feature", statusId: U, priority: 0, createdAt: new Date(0), updatedAt: new Date(0) };
  const map = new Map();
  assert.deepEqual(shapePublicTask(doc, "VEC", map, "", { total: 5, done: 3, cancelled: 1, extra: OTHER }).progress, { total: 5, done: 3 });
  assert.equal(shapePublicTask(doc, "VEC", map, "", { total: 0, done: 0 }).progress, null);
  assert.equal(shapePublicTask(doc, "VEC", map, "").progress, null);
});

test("shapePublicSubtask copies key, title and status only", () => {
  const status = { id: S, name: "In Progress", color: "#f5a524", stage: "started" };
  const doc = {
    _id: ORG,
    number: 7,
    title: "Add parentId",
    statusId: S,
    description: "<p>private detail</p>",
    assigneeId: OTHER,
    createdBy: OTHER,
    createdByBot: true,
    parentId: ORG,
    flow: { stepId: "build" },
    triagePlan: "<p>plan</p>",
  };
  const t = shapePublicSubtask(doc, "VEC", new Map([[S, status]]));
  assert.deepEqual(t, { key: "VEC-7", title: "Add parentId", status });
  assert.equal(shapePublicSubtask({ ...doc, statusId: D }, "VEC", new Map([[S, status]])).status, null);
  assert.ok(!JSON.stringify(t).includes(OTHER) && !JSON.stringify(t).includes(ORG));
});

test("publicProgress: an umbrella with 5 sub-tasks, done and cancelled count as closed", () => {
  const P = "6b023046a7ffe3ad7b70343a";
  const Q = "6b023046a7ffe3ad7b70343b";
  const rows = [
    { parentId: P, stage: "done", count: 2 },
    { parentId: P, stage: "cancelled", count: 1 },
    { parentId: P, stage: "started", count: 1 },
    { parentId: P, stage: "triage", count: 1 },
    { parentId: { toString: () => Q }, stage: "unstarted", count: 2 },
  ];
  const m = publicProgress(rows);
  assert.deepEqual(m.get(P), { total: 5, done: 3 });
  assert.deepEqual(m.get(Q), { total: 2, done: 0 });
  assert.equal(m.size, 2);
});

test("publicProgress: unknown status counts in total only, bad counts ignored, empty in -> empty out", () => {
  const P = "6b023046a7ffe3ad7b70343a";
  const m = publicProgress([
    { parentId: P, stage: null, count: 2 },
    { parentId: P, stage: "done", count: 1.9 },
    { parentId: P, stage: "done", count: -3 },
    { parentId: P, stage: "done", count: Number.NaN },
    { parentId: "x", stage: "done", count: 0 },
  ]);
  assert.deepEqual(m.get(P), { total: 3, done: 1 });
  assert.equal(m.has("x"), false);
  assert.equal(publicProgress([]).size, 0);
});

test("stats over top-level rows: an umbrella with 5 sub-tasks counts once", () => {
  // The loader groups only top-level tasks (topLevelStages), so the rows it hands computeStats hold the umbrella alone.
  const s = computeStats([{ stage: "started", type: "feature", count: 1 }]);
  assert.equal(s.total, 1);
  assert.equal(s.inProgress, 1);
  assert.equal(s.byType.feature.open, 1);
});

/* ---------------- public search reaches sub-tasks (VEC-411) ---------------- */

const st = (id, stage) => ({ id, name: id === D ? "Done" : "Status", color: "#888", stage });
const SS = st(S, "started");
const SD = st(D, "done");
const task = (n, title, status = SS) => ({ key: `TPA-${n}`, title, type: "feature", status, priority: 0, description: "", createdAt: "", updatedAt: "", progress: null });
const sub = (n, title, parent, status = SS) => ({ key: `TPA-${n}`, title, status, parentKey: `TPA-${parent}` });
const keys = (rows) => rows.map((r) => `${r.kind}:${r.kind === "task" ? r.task.key : r.subtask.key}`);

test("shapePublicSubtaskEntry adds the parent key and nothing else", () => {
  const status = { id: S, name: "In Progress", color: "#f5a524", stage: "started" };
  const doc = { number: 455, title: "Fold sub-tasks", statusId: S, parentId: ORG, assigneeId: OTHER, description: "<p>x</p>", parentNumber: 451 };
  const e = shapePublicSubtaskEntry(doc, 451, "TPA", new Map([[S, status]]));
  assert.deepEqual(e, { key: "TPA-455", title: "Fold sub-tasks", status, parentKey: "TPA-451" });
  assert.ok(!JSON.stringify(e).includes(ORG) && !JSON.stringify(e).includes(OTHER));
});

test("publicListRows: no query lists top-level tasks only, one row per request", () => {
  const tasks = [task(451, "Bot vs human tasks"), task(460, "Other")];
  const subs = [sub(455, "Fold sub-tasks", 451), sub(452, "Add parentId", 451)];
  assert.deepEqual(keys(publicListRows(tasks, subs, "", "")), ["task:TPA-451", "task:TPA-460"]);
  assert.deepEqual(keys(publicListRows(tasks, subs, "   ", "")), ["task:TPA-451", "task:TPA-460"]);
});

test("publicListRows: a sub-task matching by title or key shows in its request's place when the request doesn't match", () => {
  const tasks = [task(460, "Other"), task(451, "Bot vs human tasks"), task(470, "Last")];
  const subs = [sub(455, "Fold sub-tasks", 451), sub(452, "Fold parent links", 451), sub(453, "Unrelated", 451)];
  assert.deepEqual(keys(publicListRows(tasks, subs, "fold SUB", "")), ["subtask:TPA-455"]);
  // Several matches of one request, by number, where the request sat in the list.
  assert.deepEqual(keys(publicListRows(tasks, subs, "fold", "")), ["subtask:TPA-452", "subtask:TPA-455"]);
  assert.deepEqual(keys(publicListRows(tasks, subs, "tpa-453", "")), ["subtask:TPA-453"]);
  const row = publicListRows(tasks, subs, "Fold sub-tasks", "")[0];
  assert.equal(row.subtask.parentKey, "TPA-451");
});

test("publicListRows: a matching request is shown once, its matching sub-tasks aren't repeated", () => {
  const tasks = [task(451, "Fold everything"), task(460, "Other")];
  const subs = [sub(455, "Fold sub-tasks", 451)];
  assert.deepEqual(keys(publicListRows(tasks, subs, "fold", "")), ["task:TPA-451"]);
  // TPA-45 matches the request's key as well as the sub-task's: the request alone.
  assert.deepEqual(keys(publicListRows(tasks, subs, "tpa-45", "")), ["task:TPA-451"]);
});

test("publicListRows: status filter applies to sub-task rows too; filtered-out request lets its sub-tasks through", () => {
  const tasks = [task(451, "Fold all", SD), task(460, "Other")];
  const subs = [sub(455, "Fold sub-tasks", 451, SS), sub(456, "Fold done", 451, SD)];
  assert.deepEqual(keys(publicListRows(tasks, subs, "fold", "open")), ["subtask:TPA-455"]);
  assert.deepEqual(keys(publicListRows(tasks, subs, "fold", D)), ["task:TPA-451"]);
  assert.deepEqual(keys(publicListRows(tasks, subs, "fold", S)), ["subtask:TPA-455"]);
});

test("publicListRows: sub-tasks of requests beyond the list come last; no match is empty", () => {
  const tasks = [task(460, "Other")];
  const subs = [sub(455, "Fold sub-tasks", 451), sub(461, "Fold child", 460)];
  assert.deepEqual(keys(publicListRows(tasks, subs, "fold", "")), ["subtask:TPA-461", "subtask:TPA-455"]);
  assert.deepEqual(publicListRows(tasks, subs, "zzz", ""), []);
});

test("passesPublicStatusFilter: all, open (not done or cancelled), one status id", () => {
  assert.equal(passesPublicStatusFilter(SS, ""), true);
  assert.equal(passesPublicStatusFilter(null, ""), true);
  assert.equal(passesPublicStatusFilter(SD, "open"), false);
  assert.equal(passesPublicStatusFilter(st(C, "cancelled"), "open"), false);
  assert.equal(passesPublicStatusFilter(null, "open"), true);
  assert.equal(passesPublicStatusFilter(SS, S), true);
  assert.equal(passesPublicStatusFilter(SS, D), false);
});
