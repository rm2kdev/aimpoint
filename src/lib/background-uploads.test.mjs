// Run with `pnpm test` (node --test). Background image uploads with instant previews (VEC-453).
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
const { createUploadQueue, UploadsFailedError } = await import("./background-uploads-core.ts");
const { NETWORK_ERROR_MESSAGE, createPendingRegistry, holdWhilePending, bindBeforeUnload } = await import("./pending-actions-core.ts");

const tick = () => new Promise((r) => setImmediate(r));
const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) await tick();
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};
const file = (name) => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: "image/png" });

/** Upload stub: each call waits on its own gate, keyed by file name. */
function harness(opts = {}) {
  const gates = new Map();
  const calls = [];
  const revoked = [];
  const errors = [];
  let n = 0;
  const q = createUploadQueue({
    upload: (f) => {
      calls.push(f.name);
      const d = deferred();
      gates.set(f.name, [...(gates.get(f.name) ?? []), d]);
      return d.promise;
    },
    preview: () => `blob:http://localhost:3000/preview-${n++}`,
    revoke: (p) => revoked.push(p),
    sleep: async () => {},
    onError: (entry, message) => errors.push([entry.name, message]),
    ...opts,
  });
  const gate = (name, i = -1) => gates.get(name).at(i);
  return { q, calls, revoked, errors, gate };
}

test("add returns a local preview at once and uploads in the background; resolve swaps it for the stored URL", async () => {
  const { q, calls, gate } = harness();
  const preview = q.add(file("a.png"));
  assert.equal(preview, "blob:http://localhost:3000/preview-0", "preview returned synchronously");
  assert.deepEqual(calls, ["a.png"]);
  assert.equal(q.get(preview).state, "uploading");
  assert.equal(q.count(), 1);
  gate("a.png").resolve("/api/uploads/org1-abc.png");
  await flush();
  assert.equal(q.get(preview).state, "done");
  assert.equal(q.stored(preview), "/api/uploads/org1-abc.png");
  assert.equal(q.count(), 0);
  const html = `<p>look</p><img src="${preview}"><p>${preview}</p>`;
  assert.equal(await q.resolve(html), `<p>look</p><img src="/api/uploads/org1-abc.png"><p>/api/uploads/org1-abc.png</p>`);
});

test("resolve waits for uploads still in flight", async () => {
  const { q, gate } = harness();
  const a = q.add(file("a.png"));
  const b = q.add(file("b.png"));
  let out = null;
  const resolving = q.resolve(`![](${a}) ![](${b})`).then((t) => (out = t));
  await flush();
  assert.equal(out, null, "not before uploads finish");
  gate("a.png").resolve("/api/uploads/a.png");
  await flush();
  assert.equal(out, null, "still waiting on b");
  gate("b.png").resolve("/api/uploads/b.png");
  await resolving;
  assert.equal(out, "![](/api/uploads/a.png) ![](/api/uploads/b.png)");
});

test("resolve also waits for an upload added while it was waiting", async () => {
  const { q, gate } = harness();
  const a = q.add(file("a.png"));
  let out = null;
  const resolving = q.resolve(a).then((t) => (out = t));
  const b = q.add(file("b.png"));
  gate("a.png").resolve("/api/uploads/a.png");
  await flush();
  assert.equal(out, null);
  gate("b.png").resolve("/api/uploads/b.png");
  await resolving;
  assert.equal(out, "/api/uploads/a.png");
  assert.equal(q.stored(b), "/api/uploads/b.png");
});

test("a failed upload is reported and makes resolve refuse, never sending the blob: preview", async () => {
  const { q, gate, errors } = harness();
  const ok = q.add(file("ok.png"));
  const bad = q.add(file("big.png"));
  gate("ok.png").resolve("/api/uploads/ok.png");
  gate("big.png").reject(new Error("That image is too large. Images can be up to 10 MB."));
  await flush();
  assert.equal(q.get(bad).state, "failed");
  assert.equal(q.get(bad).error, "That image is too large. Images can be up to 10 MB.");
  assert.deepEqual(errors, [["big.png", "That image is too large. Images can be up to 10 MB."]]);
  assert.equal(q.failed().length, 1);
  await assert.rejects(q.resolve(`<img src="${ok}"><img src="${bad}">`), (err) => {
    assert.ok(err instanceof UploadsFailedError);
    assert.deepEqual(err.failed.map((f) => f.name), ["big.png"]);
    assert.match(err.message, /big\.png didn't upload \(That image is too large/);
    return true;
  });
  // The user removed the broken image from the text: sending goes ahead.
  assert.equal(await q.resolve(`<img src="${ok}">`), `<img src="/api/uploads/ok.png">`);
});

test("several failures are named together", async () => {
  const { q, gate } = harness();
  const a = q.add(file("a.png"));
  const b = q.add(file("b.png"));
  gate("a.png").reject(new Error("x"));
  gate("b.png").reject(new Error("y"));
  await assert.rejects(q.resolve(a + b), /2 images didn't upload \(a\.png, b\.png\)/);
});

test("network errors retry on their own; past the retries the upload fails with the offline message", async () => {
  const { q, calls, gate, errors } = harness({ retries: 2 });
  const p = q.add(file("a.png"));
  gate("a.png").reject(new TypeError("Failed to fetch"));
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(q.get(p).state, "uploading", "retrying counts as in flight");
  gate("a.png").reject(new TypeError("Load failed"));
  await flush();
  gate("a.png").reject(new TypeError("Failed to fetch"));
  await flush();
  assert.equal(calls.length, 3);
  assert.equal(q.get(p).state, "failed");
  assert.equal(q.get(p).error, NETWORK_ERROR_MESSAGE);
  assert.deepEqual(errors, [["a.png", NETWORK_ERROR_MESSAGE]]);
});

test("retry uploads a failed image again and resolve then succeeds", async () => {
  const { q, calls, gate } = harness({ retries: 0 });
  const p = q.add(file("a.png"));
  gate("a.png").reject(new Error("The image didn't upload. Try again."));
  await flush();
  assert.equal(q.get(p).state, "failed");
  assert.equal(await q.retry("blob:unknown"), false);
  const retrying = q.retry(p);
  assert.equal(q.get(p).state, "uploading");
  gate("a.png").resolve("/api/uploads/a.png");
  assert.equal(await retrying, true);
  assert.equal(await q.resolve(`x ${p}`), "x /api/uploads/a.png");
  assert.equal(calls.length, 2);
});

test("forget drops an image (revoking its preview), even mid-upload; reset drops everything", async () => {
  const { q, gate, revoked, errors } = harness();
  const a = q.add(file("a.png"));
  const b = q.add(file("b.png"));
  q.forget(a);
  assert.deepEqual(revoked, [a]);
  assert.equal(q.get(a), null);
  gate("a.png").reject(new Error("late failure"));
  await flush();
  assert.deepEqual(errors, [], "a forgotten upload's failure isn't reported");
  gate("b.png").resolve("/api/uploads/b.png");
  await flush();
  q.reset();
  assert.deepEqual(revoked, [a, b]);
  assert.deepEqual(q.entries(), []);
});

test("beforeunload is held only while uploads are in flight", async () => {
  const { q, gate } = harness({ retries: 0 });
  const target = new EventTarget();
  const registry = createPendingRegistry();
  bindBeforeUnload(target, registry);
  holdWhilePending(q, registry, "uploads");
  const asks = () => {
    const e = new Event("beforeunload", { cancelable: true });
    target.dispatchEvent(e);
    return e.defaultPrevented;
  };
  assert.equal(asks(), false);
  q.add(file("a.png"));
  assert.equal(asks(), true);
  gate("a.png").resolve("/api/uploads/a.png");
  await flush();
  assert.equal(asks(), false);
});
