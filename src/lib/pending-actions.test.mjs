// Run with `pnpm test` (node --test). Background action queue + beforeunload binding (VEC-453).
import { test } from "node:test";
import assert from "node:assert/strict";
import { backoffDelay, bindBeforeUnload, createActionQueue, createPendingRegistry, holdWhilePending, isNetworkError, NETWORK_ERROR_MESSAGE } from "./pending-actions-core.ts";

const tick = () => new Promise((r) => setImmediate(r));
const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) await tick();
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};
const offline = () => new TypeError("Failed to fetch");
/** A queue whose backoff sleeps are recorded and skipped. */
const queue = (opts = {}) => {
  const delays = [];
  const q = createActionQueue({ sleep: async (ms) => void delays.push(ms), ...opts });
  return { q, delays };
};

test("isNetworkError: fetch TypeErrors from every browser, aborts and timeouts; not refusals or bugs", () => {
  assert.equal(isNetworkError(new TypeError("Failed to fetch")), true);
  assert.equal(isNetworkError(new TypeError("Load failed")), true);
  assert.equal(isNetworkError(new TypeError("NetworkError when attempting to fetch resource.")), true);
  assert.equal(isNetworkError(Object.assign(new Error("x"), { name: "AbortError" })), true);
  assert.equal(isNetworkError(Object.assign(new Error("x"), { network: true })), true);
  assert.equal(isNetworkError(new TypeError("Cannot read properties of undefined")), false);
  assert.equal(isNetworkError(new Error("Server Action unavailable")), false);
  assert.equal(isNetworkError(null), false);
});

test("backoffDelay doubles and caps", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((a) => backoffDelay(a, 1000, 15000)), [1000, 2000, 4000, 8000, 15000, 15000]);
});

test("success: optimistic result applied at once, item pending until the server answers, then gone", async () => {
  const { q } = queue();
  const server = deferred();
  const log = [];
  const { id, done } = q.enqueue({
    key: "t1",
    label: "Comment",
    apply: () => log.push("apply"),
    rollback: () => log.push("rollback"),
    run: () => server.promise,
    onSuccess: (data) => log.push(`ok:${data}`),
  });
  assert.deepEqual(log, ["apply"], "apply runs synchronously in enqueue");
  assert.equal(q.get(id).state, "pending");
  assert.equal(q.get(id).label, "Comment");
  assert.equal(q.count(), 1);
  server.resolve({ ok: true, data: "c1" });
  assert.deepEqual(await done, { ok: true, data: "c1" });
  assert.deepEqual(log, ["apply", "ok:c1"]);
  assert.equal(q.count(), 0);
  assert.deepEqual(q.items(), []);
});

test("server refusal rolls back, reports the error once and is not retried", async () => {
  const refused = [];
  const { q } = queue({ onRefused: (item, error) => refused.push([item.label, error]) });
  let calls = 0;
  const log = [];
  const { done } = q.enqueue({
    label: "Rename",
    apply: () => log.push("apply"),
    rollback: () => log.push("rollback"),
    run: async () => (calls++, { ok: false, error: "Only the creator or an admin can edit this task." }),
    onRefused: (e) => log.push(`refused:${e}`),
  });
  assert.deepEqual(await done, { ok: false, error: "Only the creator or an admin can edit this task." });
  assert.equal(calls, 1);
  assert.deepEqual(log, ["apply", "rollback", "refused:Only the creator or an admin can edit this task."]);
  assert.deepEqual(refused, [["Rename", "Only the creator or an admin can edit this task."]]);
  assert.equal(q.count(), 0);
});

test("network failure retries with backoff, then succeeds without rolling back", async () => {
  const { q, delays } = queue({ retries: 3, baseDelayMs: 500 });
  let calls = 0;
  const log = [];
  const { done } = q.enqueue({
    apply: () => log.push("apply"),
    rollback: () => log.push("rollback"),
    run: async () => {
      calls++;
      if (calls < 3) throw offline();
      return { ok: true };
    },
  });
  assert.deepEqual(await done, { ok: true, data: undefined });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [500, 1000]);
  assert.deepEqual(log, ["apply"]);
});

test("network failure past the retries turns failed (optimistic result kept); retry() then succeeds", async () => {
  const failed = [];
  const { q, delays } = queue({ retries: 2, onFailed: (item, error) => failed.push(error) });
  let online = false;
  let calls = 0;
  const log = [];
  const { id, done } = q.enqueue({
    rollback: () => log.push("rollback"),
    run: async () => {
      calls++;
      if (!online) throw offline();
      return { ok: true, data: 7 };
    },
  });
  await flush();
  const item = q.get(id);
  assert.equal(item.state, "failed");
  assert.equal(item.error, NETWORK_ERROR_MESSAGE);
  assert.equal(item.attempts, 3, "first try + 2 automatic retries");
  assert.equal(delays.length, 2);
  assert.deepEqual(failed, [NETWORK_ERROR_MESSAGE]);
  assert.deepEqual(log, [], "a failed item is not rolled back");
  assert.equal(q.count(), 1, "failed still counts as unsent");
  online = true;
  assert.equal(q.retry(id), true);
  assert.deepEqual(await done, { ok: true, data: 7 });
  assert.equal(calls, 4);
  assert.equal(q.count(), 0);
  assert.equal(q.retry(id), false, "nothing to retry any more");
});

test("retry() of a failed item that fails again goes back through automatic retries to failed", async () => {
  const { q, delays } = queue({ retries: 1 });
  const { id } = q.enqueue({ run: async () => Promise.reject(offline()) });
  await flush();
  assert.equal(q.get(id).state, "failed");
  q.retry(id);
  assert.equal(q.get(id).state, "pending");
  await flush();
  assert.equal(q.get(id).state, "failed");
  assert.equal(q.get(id).attempts, 4);
  assert.equal(delays.length, 2);
});

test("a thrown non-network error fails at once (no automatic retry) with its message", async () => {
  const { q, delays } = queue();
  const { id } = q.enqueue({ run: async () => Promise.reject(new Error("Server Action unavailable")) });
  await flush();
  assert.equal(q.get(id).state, "failed");
  assert.equal(q.get(id).error, "Server Action unavailable");
  assert.equal(q.get(id).attempts, 1);
  assert.deepEqual(delays, []);
});

test("discard() rolls a failed item back and settles it as discarded", async () => {
  const { q } = queue({ retries: 0 });
  const log = [];
  const { id, done } = q.enqueue({ apply: () => log.push("apply"), rollback: () => log.push("rollback"), run: async () => Promise.reject(offline()) });
  await flush();
  assert.equal(q.discard("nope"), false);
  assert.equal(q.discard(id), true);
  assert.deepEqual(await done, { ok: false, error: NETWORK_ERROR_MESSAGE, discarded: true });
  assert.deepEqual(log, ["apply", "rollback"]);
  assert.equal(q.count(), 0);
  assert.equal(q.discard(id), false);
});

test("retry/discard refuse items that are still pending", async () => {
  const { q } = queue();
  const server = deferred();
  const { id } = q.enqueue({ run: () => server.promise });
  assert.equal(q.retry(id), false);
  assert.equal(q.discard(id), false);
  server.resolve({ ok: true });
});

test("actions on the same key reach the server one at a time in enqueue order", async () => {
  const { q } = queue();
  const started = [];
  const gates = [deferred(), deferred(), deferred()];
  const dones = ["rename", "status", "comment"].map((label, i) =>
    q.enqueue({ key: "task-1", label, run: () => (started.push(label), gates[i].promise) }).done,
  );
  await flush();
  assert.deepEqual(started, ["rename"], "second waits for the first");
  gates[0].resolve({ ok: true });
  await flush();
  assert.deepEqual(started, ["rename", "status"]);
  gates[1].resolve({ ok: false, error: "nope" });
  await flush();
  assert.deepEqual(started, ["rename", "status", "comment"], "a refusal doesn't stop the chain");
  gates[2].resolve({ ok: true });
  const results = await Promise.all(dones);
  assert.deepEqual(results.map((r) => r.ok), [true, false, true]);
});

test("different keys run in parallel", async () => {
  const { q } = queue();
  const started = [];
  const a = deferred();
  q.enqueue({ key: "a", run: () => (started.push("a"), a.promise) });
  q.enqueue({ key: "b", run: () => (started.push("b"), Promise.resolve({ ok: true })) });
  await flush();
  assert.deepEqual(started, ["a", "b"]);
  a.resolve({ ok: true });
});

test("a failed item holds back later actions on its key until retried; discard lets them go on", async () => {
  const { q } = queue({ retries: 0 });
  const started = [];
  let online = false;
  const first = q.enqueue({ key: "t", label: "one", run: async () => (started.push("one"), online ? { ok: true } : Promise.reject(offline())) });
  const second = q.enqueue({ key: "t", label: "two", run: async () => (started.push("two"), { ok: true }) });
  await flush();
  assert.equal(q.get(first.id).state, "failed");
  assert.equal(q.get(second.id).state, "pending", "queued behind the failed one, not sent out of order");
  assert.deepEqual(started, ["one"]);
  online = true;
  q.retry(first.id);
  await Promise.all([first.done, second.done]);
  assert.deepEqual(started, ["one", "one", "two"]);

  const third = q.enqueue({ key: "t", label: "three", run: async () => (started.push("three"), Promise.reject(offline())) });
  const fourth = q.enqueue({ key: "t", label: "four", run: async () => (started.push("four"), { ok: true }) });
  await flush();
  q.discard(third.id);
  assert.equal((await fourth.done).ok, true);
  assert.deepEqual(started.slice(3), ["three", "four"]);
});

test("items() is a stable snapshot that changes identity on every change; subscribe notifies", async () => {
  const { q } = queue();
  let n = 0;
  const off = q.subscribe(() => n++);
  const before = q.items();
  assert.equal(q.items(), before);
  const { done } = q.enqueue({ run: async () => ({ ok: true }) });
  assert.notEqual(q.items(), before);
  await done;
  assert.ok(n >= 2);
  off();
  const m = n;
  await q.enqueue({ run: async () => ({ ok: true }) }).done;
  assert.equal(n, m);
});

test("a throwing callback doesn't strand the queue", async () => {
  const { q } = queue();
  const orig = console.error;
  console.error = () => {};
  try {
    const a = q.enqueue({ key: "k", run: async () => ({ ok: true }), onSuccess: () => { throw new Error("boom"); } });
    const b = q.enqueue({ key: "k", run: async () => ({ ok: true, data: 2 }) });
    assert.equal((await a.done).ok, true);
    assert.deepEqual(await b.done, { ok: true, data: 2 });
  } finally {
    console.error = orig;
  }
});

test("retryAll retries every failed item", async () => {
  const { q } = queue({ retries: 0 });
  let online = false;
  const run = async () => (online ? { ok: true } : Promise.reject(offline()));
  const a = q.enqueue({ key: "a", run });
  const b = q.enqueue({ key: "b", run });
  await flush();
  assert.equal(q.items().filter((i) => i.state === "failed").length, 2);
  online = true;
  q.retryAll();
  await Promise.all([a.done, b.done]);
  assert.equal(q.count(), 0);
});

test("beforeunload listener is attached only while something is pending, and asks when it fires", async () => {
  const target = new EventTarget();
  const registry = createPendingRegistry();
  const { q } = queue({ retries: 0 });
  const unbind = bindBeforeUnload(target, registry);
  const unhold = holdWhilePending(q, registry, "actions");
  const fire = () => {
    const e = new Event("beforeunload", { cancelable: true });
    target.dispatchEvent(e);
    return e.defaultPrevented;
  };
  assert.equal(fire(), false, "nothing pending: leaving doesn't ask");

  const server = deferred();
  const { done } = q.enqueue({ run: () => server.promise });
  assert.equal(registry.count(), 1);
  assert.equal(fire(), true, "pending: leaving asks");
  server.resolve({ ok: true });
  await done;
  assert.equal(registry.count(), 0);
  assert.equal(fire(), false, "settled: listener removed");

  const failing = q.enqueue({ run: async () => Promise.reject(offline()) });
  await flush();
  assert.equal(fire(), true, "a failed (unsent) item still asks");
  q.discard(failing.id);
  await failing.done;
  assert.equal(fire(), false);

  const other = registry.hold("uploads");
  assert.equal(fire(), true, "any source holds it");
  other();
  other();
  assert.equal(registry.count(), 0, "double release is harmless");
  assert.equal(fire(), false);

  q.enqueue({ run: () => new Promise(() => {}) });
  unhold();
  unbind();
  assert.equal(fire(), false, "unbind removes the listener");
});

test("onUnfailed: a failed item that's retried (e.g. on reconnect) or discarded clears its failure notice", async () => {
  const events = [];
  const { q } = queue({ retries: 0, onFailed: (item) => events.push(["failed", item.id]), onUnfailed: (item) => events.push(["unfailed", item.id]) });
  let online = false;
  const a = q.enqueue({ run: async () => (online ? { ok: true, data: 1 } : Promise.reject(offline())) });
  const b = q.enqueue({ run: async () => Promise.reject(offline()) });
  await flush();
  assert.deepEqual(events, [["failed", a.id], ["failed", b.id]]);
  online = true;
  q.retryAll();
  await flush();
  assert.deepEqual(events.slice(2, 4), [["unfailed", a.id], ["unfailed", b.id]]);
  assert.deepEqual(await a.done, { ok: true, data: 1 });
  assert.deepEqual(events[4], ["failed", b.id], "failing again notifies again");
  q.discard(b.id);
  assert.deepEqual(events[5], ["unfailed", b.id]);
  assert.equal(q.retry(a.id), false);
  assert.equal(events.length, 6, "nothing for an item that isn't failed");
});
