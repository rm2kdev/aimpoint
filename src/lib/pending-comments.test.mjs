// Run with `pnpm test` (node --test). Instant comments: feed merge/dedupe and the comment store (VEC-454).
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// background-uploads-core imports pending-actions-core with the app's extensionless specifier.
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
const { addOnce, createCommentStore, matchLocals, mergeFeed } = await import("./pending-comments-core.ts");
const { createActionQueue } = await import("./pending-actions-core.ts");
const { createUploadQueue } = await import("./background-uploads-core.ts");

const tick = () => new Promise((r) => setImmediate(r));
const flush = async (n = 20) => {
  for (let i = 0; i < n; i++) await tick();
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};
const ME = "a".repeat(24);
const OTHER = "b".repeat(24);
const T = "2026-11-24T10:00:00.000Z";
const at = (s) => new Date(Date.parse(T) + s * 1000).toISOString();
const comment = (id, body, actorId = ME, createdAt = at(1)) => ({ id, kind: "comment", actorId, body, createdAt });
const local = (localId, body, extra = {}) => ({ localId, taskId: "t1", actorId: ME, body, sent: body, realId: null, actionId: null, previews: [], createdAt: T, ...extra });

test("mergeFeed: unsent comments follow the feed", () => {
  const feed = [comment("c1", "old", OTHER, at(-60))];
  const rows = mergeFeed(feed, [local("l1", "hello")]);
  assert.deepEqual(rows.map((r) => (r.kind === "server" ? r.item.id : r.local.localId)), ["c1", "l1"]);
});

test("mergeFeed: reply first (matched by id) hides the local copy", () => {
  const rows = mergeFeed([comment("c9", "hello")], [local("l1", "hello", { realId: "c9" })]);
  assert.deepEqual(rows.map((r) => r.kind), ["server"]);
});

test("mergeFeed: realtime echo before the reply (matched by author + sent body) hides the local copy", () => {
  const rows = mergeFeed([comment("c9", "  hello  ")], [local("l1", "hello")]);
  assert.deepEqual(rows.map((r) => r.kind), ["server"]);
});

test("mergeFeed: a comment by someone else with the same text is not the echo", () => {
  const rows = mergeFeed([comment("c9", "hello", OTHER)], [local("l1", "hello")]);
  assert.equal(rows.filter((r) => r.kind === "local").length, 1);
});

test("mergeFeed: an older identical comment of mine (before this one was typed) is not the echo", () => {
  const rows = mergeFeed([comment("c0", "+1", ME, at(-3600))], [local("l1", "+1")]);
  assert.equal(rows.filter((r) => r.kind === "local").length, 1);
});

test("mergeFeed: one echo stands for one local copy (same text posted twice)", () => {
  const locals = [local("l1", "+1"), local("l2", "+1", { createdAt: at(2) })];
  let rows = mergeFeed([comment("c1", "+1")], locals);
  assert.deepEqual(rows.filter((r) => r.kind === "local").map((r) => r.local.localId), ["l2"]);
  rows = mergeFeed([comment("c1", "+1"), comment("c2", "+1", ME, at(3))], locals);
  assert.equal(rows.filter((r) => r.kind === "local").length, 0);
});

test("mergeFeed: a reply-matched comment isn't claimed again by another local's body match", () => {
  const locals = [local("l1", "+1", { realId: "c2", createdAt: at(2) }), local("l2", "+1")];
  const m = matchLocals([comment("c2", "+1")], locals);
  assert.equal(m.get("l1")?.id, "c2");
  assert.equal(m.has("l2"), false);
});

test("mergeFeed: a local copy whose body isn't known yet (images still uploading) is never matched by text", () => {
  const rows = mergeFeed([comment("c1", "hi")], [local("l1", "hi", { sent: null })]);
  assert.equal(rows.filter((r) => r.kind === "local").length, 1);
});

test("addOnce: the reply and the echo add the comment once, in either order", () => {
  const c = comment("c1", "hi");
  assert.equal(addOnce(addOnce([], c), c).length, 1);
});

/* ---------- the store over the real queue + upload queue ---------- */

function setup({ addComment, upload } = {}) {
  const queue = createActionQueue({ sleep: async () => {} });
  let n = 0;
  const uploads = createUploadQueue({ upload: upload ?? (async () => "/api/uploads/x.png"), preview: () => `blob:p${n++}`, revoke: () => {}, sleep: async () => {} });
  const calls = [];
  const pruned = [];
  const store = createCommentStore({
    queue,
    uploads,
    addComment: async (slug, taskId, body) => {
      calls.push(body);
      return addComment ? addComment(body, calls.length) : { ok: true, data: comment(`c${calls.length}`, body) };
    },
    now: () => new Date(T),
    later: (fn) => pruned.push(fn),
  });
  return { queue, uploads, store, calls, pruned };
}

test("store: the comment shows at once, then is sent and replaced by the stored copy", async () => {
  const { store, calls, pruned } = setup();
  const posted = [];
  store.post({ slug: "o", taskId: "t1", actorId: ME, body: "hi <@" + OTHER + ">", onPosted: (r) => posted.push(r) });
  assert.equal(store.forTask("t1").length, 1, "visible synchronously");
  assert.equal(store.forTask("t1")[0].body, "hi <@" + OTHER + ">");
  await flush();
  assert.deepEqual(calls, ["hi <@" + OTHER + ">"]);
  assert.equal(posted.length, 1);
  const [l] = store.forTask("t1");
  assert.equal(l.realId, "c1");
  // The stored copy in the feed hides it; it's pruned later.
  assert.equal(mergeFeed([posted[0]], store.forTask("t1")).length, 1);
  pruned.forEach((f) => f());
  assert.equal(store.forTask("t1").length, 0);
});

test("store: can send before the image upload finishes; the server gets the stored URL, never blob:", async () => {
  const up = deferred();
  const { store, uploads, calls } = setup({ upload: () => up.promise });
  const preview = uploads.add({ name: "shot.png" });
  const body = `look\n![shot.png](${preview})`;
  store.post({ slug: "o", taskId: "t1", actorId: ME, body });
  const [l] = store.forTask("t1");
  assert.deepEqual(l.previews, [preview]);
  await flush();
  assert.equal(calls.length, 0, "waits for the upload");
  up.resolve("/api/uploads/" + "c".repeat(24) + "-abc.png");
  await flush();
  assert.deepEqual(calls, [`look\n![shot.png](/api/uploads/${"c".repeat(24)}-abc.png)`]);
  assert.ok(!calls[0].includes("blob:"));
  assert.equal(uploads.get(preview), null, "preview freed after sending");
});

test("store: offline -> failed with text kept; retry sends it", async () => {
  let offline = true;
  const { store, queue, calls } = setup({
    addComment: async (body, n) => {
      if (offline) throw new TypeError("Failed to fetch");
      return { ok: true, data: comment(`c${n}`, body) };
    },
  });
  store.post({ slug: "o", taskId: "t1", actorId: ME, body: "keep me" });
  await flush(60);
  const [l] = store.forTask("t1");
  assert.equal(queue.get(l.actionId)?.state, "failed");
  assert.equal(l.body, "keep me");
  offline = false;
  assert.equal(store.retry(l), true);
  await flush();
  assert.equal(store.forTask("t1")[0].realId, `c${calls.length}`);
});

test("store: discard drops a failed comment and its images", async () => {
  const { store, queue, uploads } = setup({ addComment: async () => { throw new TypeError("Failed to fetch"); } });
  const preview = uploads.add({ name: "a.png" });
  store.post({ slug: "o", taskId: "t1", actorId: ME, body: `![a.png](${preview})` });
  await flush(60);
  const [l] = store.forTask("t1");
  assert.equal(queue.get(l.actionId)?.state, "failed");
  store.discard(l);
  await flush();
  assert.equal(store.forTask("t1").length, 0);
  assert.equal(uploads.get(preview), null);
});

test("store: a failed image fails the comment; Retry uploads it again, then sends", async () => {
  let fail = true;
  const { store, queue, calls, uploads } = setup({
    upload: async () => {
      if (fail) throw new Error("Too big");
      return "/api/uploads/x.png";
    },
  });
  const preview = uploads.add({ name: "a.png" });
  store.post({ slug: "o", taskId: "t1", actorId: ME, body: `![a.png](${preview})` });
  await flush();
  const [l] = store.forTask("t1");
  assert.equal(queue.get(l.actionId)?.state, "failed");
  assert.match(queue.get(l.actionId)?.error ?? "", /a\.png didn't upload/);
  assert.equal(calls.length, 0);
  fail = false;
  store.retry(l);
  await flush();
  assert.deepEqual(calls, ["![a.png](/api/uploads/x.png)"]);
});

test("store: a refusal rolls back and hands the text back (previews kept for the draft)", async () => {
  const { store, uploads } = setup({ addComment: async () => ({ ok: false, error: "You don't have access." }) });
  const preview = uploads.add({ name: "a.png" });
  const back = [];
  store.post({ slug: "o", taskId: "t1", actorId: ME, body: `hi ![a.png](${preview})`, onRefused: (body, error) => back.push([body, error]) });
  await flush();
  assert.equal(store.forTask("t1").length, 0);
  assert.deepEqual(back, [[`hi ![a.png](${preview})`, "You don't have access."]]);
  assert.notEqual(uploads.get(preview), null, "the restored draft still shows its image");
});

test("store: comments on one task are sent in order", async () => {
  const first = deferred();
  const { store, calls } = setup({ addComment: async (body, n) => (n === 1 ? first.promise : { ok: true, data: comment(`c${n}`, body) }) });
  store.post({ slug: "o", taskId: "t1", actorId: ME, body: "one" });
  store.post({ slug: "o", taskId: "t1", actorId: ME, body: "two" });
  await flush();
  assert.deepEqual(calls, ["one"]);
  first.resolve({ ok: true, data: comment("c1", "one") });
  await flush();
  assert.deepEqual(calls, ["one", "two"]);
});
