// Run with `pnpm test` (node --test; Node strips the TypeScript types of project-public-core.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PUBLIC_SUBMIT_STAGES,
  isPublicSubmitStage,
  resolveSubmitStatuses,
  pruneSubmitStatuses,
  pickSubmitStatus,
  rewritePublicImages,
  localUploadNames,
  publicImagePath,
  publicCommentBody,
  shapePublicTask,
  shapePublicComment,
  parsePublicRef,
} from "./project-public-core.ts";
import { publicSanitize } from "./form-rich-core.ts";

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
    createdAt: new Date("2026-11-18T01:00:00Z"),
    updatedAt: new Date("2026-11-18T02:00:00Z"),
  };
  const t = shapePublicTask(doc, "VEC", new Map([[T, status]]), "<p>clean</p>");
  assert.deepEqual(Object.keys(t).sort(), ["createdAt", "description", "key", "priority", "status", "title", "type", "updatedAt"]);
  assert.deepEqual(t, {
    key: "VEC-12",
    title: "Crash on save",
    type: "issue",
    status,
    priority: 2,
    description: "<p>clean</p>",
    createdAt: "2026-11-18T01:00:00.000Z",
    updatedAt: "2026-11-18T02:00:00.000Z",
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
