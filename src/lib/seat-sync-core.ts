/**
 * Per-seat sync logic (VEC-238, VEC-291, VEC-303), free of Mongo/Stripe/Next imports so
 * `seat-sync-core.test.mjs` runs it under plain `node --test` with fakes. `lib/seat-sync.ts` wires the real
 * store (Mongo `seatSyncs`), Stripe client and `after()`.
 *
 * - `syncSoon(orgId)`: a membership change. Marks the org pending (rev bumped) and, deferred past the response,
 *   reads the subscription item and calls `subscriptions.update` (items quantity, proration_behavior
 *   create_prorations) only when the quantity differs. Never throws.
 * - Success clears the pending row (only if no newer change bumped `rev`, else it runs again). Failure keeps the
 *   row with `lastError` and a backoff `nextAt`; `sweep()` retries due rows.
 * - `sweepSoon()`: a throttled, deferred sweep for cheap triggers (org page loads, Stripe webhooks), so a failed
 *   update in production is retried within minutes instead of waiting for the daily cron (VEC-303).
 */

export interface SeatSyncRow {
  rev: number;
  pendingSince: Date;
  attempts: number;
  nextAt: Date;
  lastError: string | null;
}

/** Storage for pending rows, one per org. */
export interface SeatSyncStore<Id> {
  /** Upsert: bump rev, set nextAt = now, keep pendingSince/attempts/lastError of an existing row. */
  markPending(orgId: Id, now: Date): Promise<void>;
  get(orgId: Id): Promise<SeatSyncRow | null>;
  /** Delete the row only if its rev is still `rev`. */
  clear(orgId: Id, rev: number): Promise<void>;
  fail(orgId: Id, patch: { attempts: number; lastError: string; nextAt: Date }): Promise<void>;
  /** Org ids whose row is due (nextAt <= now). */
  due(now: Date, limit: number): Promise<Id[]>;
}

export interface SubscriptionItemLike {
  id: string;
  quantity?: number | null;
  price?: { id: string } | null;
}

export interface SeatStripe {
  retrieve(subId: string): Promise<{ items: { data: SubscriptionItemLike[] } }>;
  update(
    subId: string,
    params: { items: { id: string; quantity: number }[]; proration_behavior: "create_prorations" },
    opts: { idempotencyKey: string },
  ): Promise<unknown>;
}

export interface SeatSyncDeps<Id> {
  store: SeatSyncStore<Id>;
  key(orgId: Id): string;
  /** Billing on for this instance. */
  enabled(): boolean;
  /** The org's live subscription id, or null (no org, no subscription, or not live). */
  liveSubscription(orgId: Id): Promise<string | null>;
  /** Quantity the subscription should have now (seatQuantity of the billable members). */
  quantity(orgId: Id): Promise<number>;
  priceId(): string;
  stripe(): SeatStripe;
  /** Run a job after the response (Next `after()`), or detached outside a request. */
  defer(job: () => Promise<void>): void;
  log?: { info(msg: string): void; error(msg: string, err?: unknown): void };
  now?: () => number;
}

export type SeatSyncOutcome = "skipped" | "unchanged" | "updated";

export const SEAT_BACKOFF_MS = [30_000, 60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];
/** Gap between two cheap-trigger sweeps in one process. */
export const SWEEP_SOON_GAP_MS = 60_000;

export function createSeatSync<Id>(deps: SeatSyncDeps<Id>) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? { info: (m: string) => console.info(m), error: (m: string, e?: unknown) => console.error(m, e) };
  const chains = new Map<string, Promise<unknown>>();
  let lastSweepSoon = 0;

  async function syncOnce(orgId: Id): Promise<SeatSyncOutcome> {
    const row = await deps.store.get(orgId);
    if (!row) return "skipped";
    const subId = deps.enabled() ? await deps.liveSubscription(orgId) : null;
    if (!subId) {
      await deps.store.clear(orgId, row.rev);
      return "skipped";
    }
    try {
      let outcome: SeatSyncOutcome = "unchanged";
      const sub = await deps.stripe().retrieve(subId);
      const priceId = deps.priceId();
      const item = sub.items.data.find((i) => i.price?.id === priceId) ?? sub.items.data[0];
      if (!item) throw new Error(`Subscription ${subId} has no items to set a seat quantity on.`);
      const seats = await deps.quantity(orgId);
      if (item.quantity !== seats) {
        await deps.stripe().update(
          subId,
          { items: [{ id: item.id, quantity: seats }], proration_behavior: "create_prorations" },
          { idempotencyKey: `aimpoint-seats-${subId}-${item.quantity ?? 0}-${seats}-${row.pendingSince.getTime()}-${row.rev}` },
        );
        outcome = "updated";
        log.info(`[seat sync] org ${deps.key(orgId)}: ${subId} quantity ${item.quantity ?? 0} -> ${seats}`);
      }
      // Clear only if nothing changed meanwhile; otherwise the caller loops and counts again.
      await deps.store.clear(orgId, row.rev);
      return outcome;
    } catch (err) {
      const attempts = row.attempts + 1;
      const wait = SEAT_BACKOFF_MS[Math.min(attempts - 1, SEAT_BACKOFF_MS.length - 1)];
      await deps.store.fail(orgId, {
        attempts,
        lastError: String((err as Error)?.message ?? err).slice(0, 500),
        nextAt: new Date(now() + wait),
      });
      throw err;
    }
  }

  /** Runs syncs for one org until no newer change is pending (bounded). */
  async function syncUntilSettled(orgId: Id): Promise<SeatSyncOutcome> {
    let last: SeatSyncOutcome = "skipped";
    for (let i = 0; i < 4; i++) {
      const out = await syncOnce(orgId);
      if (out !== "skipped") last = out;
      if (!(await deps.store.get(orgId))) return last;
    }
    return last;
  }

  /** Serializes syncs per org in this process so two quick membership changes can't race their Stripe updates. */
  function enqueue(orgId: Id): Promise<SeatSyncOutcome> {
    const key = deps.key(orgId);
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => syncUntilSettled(orgId));
    chains.set(key, next);
    void next
      .finally(() => {
        if (chains.get(key) === next) chains.delete(key);
      })
      .catch(() => undefined);
    return next;
  }

  /** Seat count may have changed: update the live subscription after the response. Never throws. */
  function syncSoon(orgId: Id, reason = "membership"): void {
    if (!deps.enabled()) return;
    deps.defer(() =>
      (async () => {
        await deps.store.markPending(orgId, new Date(now()));
        await enqueue(orgId);
      })().catch((err) => log.error(`[seat sync] org ${deps.key(orgId)} (${reason}) failed, will retry:`, err)),
    );
  }

  /** Awaitable variant for scripts and tests: marks pending, then syncs. */
  async function syncNow(orgId: Id): Promise<SeatSyncOutcome> {
    if (!deps.enabled()) return "skipped";
    await deps.store.markPending(orgId, new Date(now()));
    return enqueue(orgId);
  }

  /** Retries pending syncs that are due (failed earlier, or a server stopped mid-way). */
  async function sweep(): Promise<{ due: number; failed: number }> {
    if (!deps.enabled()) return { due: 0, failed: 0 };
    const due = await deps.store.due(new Date(now()), 25);
    let failed = 0;
    for (const id of due) {
      try {
        await enqueue(id);
      } catch (err) {
        failed++;
        log.error(`[seat sync] retry for org ${deps.key(id)} failed:`, err);
      }
    }
    return { due: due.length, failed };
  }

  /**
   * Cheap retry trigger (VEC-303): sweeps due rows after the response, at most once per SWEEP_SOON_GAP_MS in this
   * process. Returns whether a sweep was scheduled. Never throws.
   */
  function sweepSoon(reason = "page"): boolean {
    if (!deps.enabled()) return false;
    const t = now();
    if (t - lastSweepSoon < SWEEP_SOON_GAP_MS) return false;
    lastSweepSoon = t;
    deps.defer(() =>
      sweep().then(
        () => undefined,
        (err) => log.error(`[seat sync] sweep (${reason}) failed:`, err),
      ),
    );
    return true;
  }

  return { syncOnce, syncSoon, syncNow, sweep, sweepSoon };
}

export interface MembershipUpserter<Doc> {
  updateOne(
    filter: Record<string, unknown>,
    update: { $setOnInsert: Doc },
    opts: { upsert: true },
  ): Promise<{ upsertedCount: number }>;
}

/**
 * Joins a user to an org from an invite (VEC-238). Only a new membership is a new seat: it calls `onNewSeat`
 * (seat sync); re-accepting while already a member changes nothing. Returns whether the membership was created.
 */
export async function joinMembership<Id, Doc extends { orgId: Id; userId: Id }>(
  memberships: MembershipUpserter<Doc>,
  doc: Doc,
  onNewSeat: () => void,
): Promise<boolean> {
  const res = await memberships.updateOne({ orgId: doc.orgId, userId: doc.userId }, { $setOnInsert: doc }, { upsert: true });
  if (!res.upsertedCount) return false;
  onNewSeat();
  return true;
}
