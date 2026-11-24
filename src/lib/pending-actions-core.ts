/**
 * Background actions with an optimistic local result (VEC-453, part of VEC-452 "make actions happen immediately").
 * Pure and framework-free so `pending-actions.test.mjs` runs it under plain `node --test`; the React side
 * (singleton queue, hooks, toasts, beforeunload) is `lib/pending-actions.ts`. Pattern doc: `docs/optimistic-actions.md`.
 *
 * An action is enqueued with `apply` (the optimistic change, run at once), `run` (the server action, run in the
 * background) and `rollback`. Actions sharing a `key` (e.g. a task id) run one at a time in enqueue order, so a
 * rename followed by a status change reaches the server in that order. Outcomes:
 * - `{ok: true}`: done, `onSuccess(data)`, the item leaves the queue.
 * - `{ok: false, error}` (a server refusal): `rollback`, `onRefused(error)` (and the queue's), the item leaves.
 * - a network error (fetch never got an answer): retried with backoff up to `retries` times, then `failed`.
 * - any other thrown error: `failed` straight away (retrying a bug won't help, but the work isn't thrown away).
 * A failed item keeps the optimistic result on screen and holds back later actions on the same key, until the
 * user calls `retry(id)` (runs it again) or `discard(id)` (rolls it back and lets the rest go on).
 */

/** What every server action in `src/app/actions` returns (`lib/result.ts`, which is server-only). */
export type ActionResult<T = unknown> = { ok: true; data?: T } | { ok: false; error: string };

export type PendingState = "pending" | "failed";

export interface PendingItem {
  id: string;
  /** Queue key: actions with the same key run in order. */
  key: string;
  /** What the action does, for UI ("Comment", "Rename"). */
  label: string;
  /** `pending` while queued, running or waiting to retry; `failed` once it needs the user. */
  state: PendingState;
  /** Why it failed, for the "Not sent" line. */
  error: string | null;
  /** Server calls made so far. */
  attempts: number;
  createdAt: number;
}

export interface ActionSpec<T = unknown> {
  key?: string;
  label?: string;
  /** The server work. Called once per attempt. */
  run: () => Promise<ActionResult<T>>;
  /** Optimistic local result, applied synchronously when the action is enqueued. */
  apply?: () => void;
  /** Undoes `apply`: on a server refusal and on discard. */
  rollback?: () => void;
  onSuccess?: (data: T | undefined) => void;
  onRefused?: (error: string) => void;
}

/** How an enqueued action ended. `discarded` = the user gave up on a failed item. */
export type Settled<T = unknown> = { ok: true; data?: T } | { ok: false; error: string; discarded?: true };

export interface QueueOptions {
  /** Automatic retries after a network error before the item turns `failed`. Default 3. */
  retries?: number;
  /** First retry delay; doubles per attempt up to `maxDelayMs`. Defaults 1000 / 15000. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injectable timer (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Every refusal, after the item's own `onRefused` (the React side toasts here). */
  onRefused?: (item: PendingItem, error: string) => void;
  /** An item turned `failed`. */
  onFailed?: (item: PendingItem, error: string) => void;
  newId?: () => string;
}

export const NETWORK_ERROR_MESSAGE = "Couldn't reach the server. Check your connection.";

/**
 * True for errors that mean the request never got an answer: fetch's TypeError ("Failed to fetch" in Chrome,
 * "Load failed" in Safari, "NetworkError when attempting to fetch resource." in Firefox), aborts and timeouts, or
 * anything flagged `network: true`. Server refusals are results, not errors, so they never land here.
 */
export function isNetworkError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; message?: string; network?: boolean };
  if (e.network === true) return true;
  if (e.name === "AbortError" || e.name === "TimeoutError") return true;
  if (e.name === "TypeError") return /failed to fetch|load failed|networkerror|network request failed|fetch failed/i.test(e.message ?? "");
  return false;
}

/** Delay before automatic retry number `attempt` (1-based): base, 2x base, 4x base ... capped. */
export function backoffDelay(attempt: number, baseDelayMs = 1000, maxDelayMs = 15_000): number {
  return Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
}

/** Runs a caller's callback without letting it break the queue (a throwing onSuccess must not strand the chain). */
function safe(fn: (() => void) | undefined) {
  try {
    fn?.();
  } catch (err) {
    console.error(err);
  }
}

const errorText = (err: unknown) => (isNetworkError(err) ? NETWORK_ERROR_MESSAGE : (err as Error)?.message || "Something went wrong. Try again.");

interface Entry {
  item: PendingItem;
  spec: ActionSpec<unknown>;
  settle: (s: Settled<unknown>) => void;
  /** Set while failed: resolves with "retry" or "discard". */
  decide: ((d: "retry" | "discard") => void) | null;
}

export type ActionQueue = ReturnType<typeof createActionQueue>;

export function createActionQueue(opts: QueueOptions = {}) {
  const retries = opts.retries ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let seq = 0;
  const newId = opts.newId ?? (() => `pa_${Date.now().toString(36)}_${(seq++).toString(36)}`);
  const entries = new Map<string, Entry>();
  /** Tail of each key's chain: the next action on the key starts when this settles. */
  const tails = new Map<string, Promise<void>>();
  const listeners = new Set<() => void>();
  let snapshot: readonly PendingItem[] = [];

  const emit = () => {
    snapshot = [...entries.values()].map((e) => e.item);
    listeners.forEach((l) => l());
  };
  const update = (entry: Entry, patch: Partial<PendingItem>) => {
    entry.item = { ...entry.item, ...patch };
    emit();
  };

  async function process(entry: Entry) {
    let auto = 0;
    for (;;) {
      update(entry, { state: "pending", error: null, attempts: entry.item.attempts + 1 });
      let result: ActionResult<unknown> | null = null;
      let thrown: unknown = null;
      try {
        result = await entry.spec.run();
      } catch (err) {
        thrown = err;
      }
      if (result && result.ok) {
        const data = result.data;
        entries.delete(entry.item.id);
        emit();
        safe(() => entry.spec.onSuccess?.(data));
        return entry.settle({ ok: true, data });
      }
      if (result && !result.ok) {
        entries.delete(entry.item.id);
        emit();
        const error = result.error;
        safe(entry.spec.rollback);
        safe(() => entry.spec.onRefused?.(error));
        safe(() => opts.onRefused?.(entry.item, error));
        return entry.settle({ ok: false, error: result.error });
      }
      if (isNetworkError(thrown) && auto < retries) {
        auto++;
        await sleep(backoffDelay(auto, opts.baseDelayMs, opts.maxDelayMs));
        continue;
      }
      const error = errorText(thrown);
      const decision = new Promise<"retry" | "discard">((r) => (entry.decide = r));
      update(entry, { state: "failed", error });
      safe(() => opts.onFailed?.(entry.item, error));
      const d = await decision;
      entry.decide = null;
      if (d === "discard") {
        entries.delete(entry.item.id);
        emit();
        safe(entry.spec.rollback);
        return entry.settle({ ok: false, error, discarded: true });
      }
      auto = 0;
    }
  }

  /** Applies the optimistic result now and queues the server work. Resolves when the action settles for good. */
  function enqueue<T>(spec: ActionSpec<T>): { id: string; done: Promise<Settled<T>> } {
    const id = newId();
    const key = spec.key ?? id;
    let settle!: (s: Settled<unknown>) => void;
    const done = new Promise<Settled<unknown>>((r) => (settle = r));
    const entry: Entry = {
      item: { id, key, label: spec.label ?? "Change", state: "pending", error: null, attempts: 0, createdAt: Date.now() },
      spec: spec as ActionSpec<unknown>,
      settle,
      decide: null,
    };
    entries.set(id, entry);
    emit();
    safe(spec.apply);
    const prev = tails.get(key) ?? Promise.resolve();
    const tail = prev.then(() => process(entry)).catch(() => {});
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return { id, done: done as Promise<Settled<T>> };
  }

  /** Runs a failed item again. False if it isn't failed (any more). */
  function retry(id: string) {
    const e = entries.get(id);
    if (!e?.decide || e.item.state !== "failed") return false;
    update(e, { state: "pending", error: null }); // shows as sending again at once, not after a microtask
    e.decide("retry");
    return true;
  }

  /** Gives up on a failed item: rolls it back and lets later actions on its key run. */
  function discard(id: string) {
    const e = entries.get(id);
    if (!e?.decide || e.item.state !== "failed") return false;
    e.decide("discard");
    return true;
  }

  return {
    enqueue,
    retry,
    discard,
    /** Retries every failed item (e.g. when the browser comes back online). */
    retryAll: () => [...entries.values()].filter((e) => e.item.state === "failed").forEach((e) => retry(e.item.id)),
    /** Stable snapshot (new array on every change), for useSyncExternalStore. */
    items: () => snapshot,
    get: (id: string) => entries.get(id)?.item ?? null,
    /** Unsent work: pending plus failed. */
    count: () => entries.size,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/**
 * Counts unsent work from every source (action queue, background uploads) so one `beforeunload` warning covers
 * them all. `hold()` returns its release; releasing twice is harmless.
 */
export function createPendingRegistry() {
  const holds = new Map<symbol, string>();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());
  return {
    hold(reason = "work") {
      const token = Symbol(reason);
      holds.set(token, reason);
      emit();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds.delete(token);
        emit();
      };
    },
    count: () => holds.size,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
export type PendingRegistry = ReturnType<typeof createPendingRegistry>;

/** Mirrors a count of unsent work into a registry hold (held while `count() > 0`). Returns the unsubscribe. */
export function holdWhilePending(source: { count(): number; subscribe(l: () => void): () => void }, registry: PendingRegistry, reason: string) {
  let release: (() => void) | null = null;
  const sync = () => {
    if (source.count() > 0 && !release) release = registry.hold(reason);
    else if (source.count() === 0 && release) {
      release();
      release = null;
    }
  };
  sync();
  const off = source.subscribe(sync);
  return () => {
    off();
    release?.();
    release = null;
  };
}

type UnloadTarget = { addEventListener(t: "beforeunload", l: (e: Event) => void): void; removeEventListener(t: "beforeunload", l: (e: Event) => void): void };

/**
 * Keeps a `beforeunload` listener on `target` only while the registry holds anything, so leaving with unsent work
 * asks first and leaving with nothing pending never does (a listener that's always attached also costs the page its
 * back/forward cache). Returns the unbind.
 */
export function bindBeforeUnload(target: UnloadTarget, registry: PendingRegistry) {
  const onUnload = (e: Event) => {
    e.preventDefault();
    // Chrome < 119 and older Safari need returnValue set; the text is ignored by every current browser.
    (e as unknown as { returnValue: string }).returnValue = "You have changes that haven't been sent yet.";
  };
  let bound = false;
  const sync = () => {
    const want = registry.count() > 0;
    if (want && !bound) target.addEventListener("beforeunload", onUnload);
    if (!want && bound) target.removeEventListener("beforeunload", onUnload);
    bound = want;
  };
  sync();
  const off = registry.subscribe(sync);
  return () => {
    off();
    if (bound) target.removeEventListener("beforeunload", onUnload);
    bound = false;
  };
}
