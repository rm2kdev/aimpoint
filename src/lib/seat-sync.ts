/**
 * Per-seat billing (VEC-238): keeps a live Pro subscription's quantity equal to the org's billable seats
 * (human members, `billableSeats` in billing-core.ts). Pro is US$4.95 per seat per month, prorated.
 *
 * - `syncSeatsSoon(orgId)` runs after a membership change (invite accepted, member removed or left). It never
 *   blocks or fails the change itself: the sync runs in the background, serialized per org in this process.
 * - Each sync first marks the org pending in `seatSyncs` (rev bumped), counts seats, reads the subscription
 *   item from Stripe and only calls `subscriptions.update` (items quantity, proration_behavior
 *   create_prorations) when the quantity differs. Setting an absolute quantity is idempotent, and the
 *   request carries an idempotency key per (subscription, from, to, pending entry).
 * - Success deletes the pending row (only if no newer change bumped `rev`, else it runs again). Failure logs,
 *   keeps the row and schedules a retry with backoff; the sweeper (every 30 s in a long-running server, and
 *   /api/cron/wakes on Vercel) retries due rows, so a Stripe outage reconciles later.
 * - Billing off, or no live subscription: no Stripe calls, the pending row is dropped.
 */
import "server-only";
import type { ObjectId } from "mongodb";
import { cols, getDb } from "@/lib/db";
import { billingEnabled, stripeConfig } from "@/lib/billing";
import { billableSeats, seatQuantity } from "@/lib/billing-core";
import { stripe } from "@/lib/stripe";
import { hasLiveSubscription } from "@/lib/stripe-sync";

export interface SeatSyncDoc {
  _id: ObjectId; // org id
  /** Bumped by every change that needs a sync; a run only clears the row when rev is unchanged. */
  rev: number;
  pendingSince: Date;
  attempts: number;
  nextAt: Date;
  lastError: string | null;
}

export type SeatSyncOutcome = "skipped" | "unchanged" | "updated";

const BACKOFF_MS = [30_000, 60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];
const SWEEP_MS = 30_000;

async function syncCol() {
  return (await getDb()).collection<SeatSyncDoc>("seatSyncs");
}

/** Billable seats right now: the org's human members (memberships). Bots and pending invites aren't seats. */
export async function countBillableSeats(orgId: ObjectId): Promise<number> {
  const { memberships } = await cols();
  return billableSeats(await memberships.find({ orgId }, { projection: { userId: 1 } }).toArray());
}

async function markPending(orgId: ObjectId): Promise<void> {
  const col = await syncCol();
  const now = new Date();
  await col.updateOne(
    { _id: orgId },
    { $inc: { rev: 1 }, $setOnInsert: { pendingSince: now, attempts: 0, lastError: null }, $set: { nextAt: now } },
    { upsert: true },
  );
}

/**
 * One reconcile of the org's subscription quantity against its seats. Throws on a Stripe failure (the row
 * stays pending with a retry time). Callers outside this module use `syncSeatsSoon`.
 */
async function syncOnce(orgId: ObjectId): Promise<SeatSyncOutcome> {
  const col = await syncCol();
  const row = await col.findOne({ _id: orgId });
  if (!row) return "skipped";
  const { orgs } = await cols();
  const org = await orgs.findOne({ _id: orgId }, { projection: { billing: 1 } });
  const subId = org?.billing?.subscriptionId;
  if (!billingEnabled() || !org || !subId || !hasLiveSubscription(org.billing)) {
    await col.deleteOne({ _id: orgId, rev: row.rev });
    return "skipped";
  }
  try {
    let outcome: SeatSyncOutcome = "unchanged";
    const { priceId } = stripeConfig();
    const sub = await stripe().subscriptions.retrieve(subId);
    const item = sub.items.data.find((i) => i.price?.id === priceId) ?? sub.items.data[0];
    if (!item) throw new Error(`Subscription ${subId} has no items to set a seat quantity on.`);
    const seats = seatQuantity(await countBillableSeats(orgId));
    if (item.quantity !== seats) {
      await stripe().subscriptions.update(
        subId,
        { items: [{ id: item.id, quantity: seats }], proration_behavior: "create_prorations" },
        { idempotencyKey: `aimpoint-seats-${subId}-${item.quantity ?? 0}-${seats}-${row.pendingSince.getTime()}-${row.rev}` },
      );
      outcome = "updated";
      console.info(`[seat sync] org ${orgId.toHexString()}: ${subId} quantity ${item.quantity ?? 0} -> ${seats}`);
    }
    // Clear only if nothing changed meanwhile; otherwise the caller loops and counts again.
    await col.deleteOne({ _id: orgId, rev: row.rev });
    return outcome;
  } catch (err) {
    const attempts = row.attempts + 1;
    const wait = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
    await col.updateOne(
      { _id: orgId },
      { $set: { attempts, lastError: String((err as Error)?.message ?? err).slice(0, 500), nextAt: new Date(Date.now() + wait) } },
    );
    throw err;
  }
}

/** Runs syncs for one org until no newer change is pending (bounded). */
async function syncUntilSettled(orgId: ObjectId): Promise<SeatSyncOutcome> {
  let last: SeatSyncOutcome = "skipped";
  for (let i = 0; i < 4; i++) {
    const out = await syncOnce(orgId);
    if (out !== "skipped") last = out;
    const col = await syncCol();
    if (!(await col.findOne({ _id: orgId }, { projection: { _id: 1 } }))) return last;
  }
  return last;
}

type SeatSyncState = {
  chains: Map<string, Promise<unknown>>;
  timer?: ReturnType<typeof setInterval>;
  running?: boolean;
  run?: () => Promise<unknown>;
};
const g = globalThis as unknown as { __aimpointSeatSync?: SeatSyncState };
const state: SeatSyncState = (g.__aimpointSeatSync ??= { chains: new Map() });

/** Serializes syncs per org in this process so two quick membership changes can't race their Stripe updates. */
function enqueue(orgId: ObjectId): Promise<SeatSyncOutcome> {
  const key = orgId.toHexString();
  const prev = state.chains.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(() => syncUntilSettled(orgId));
  state.chains.set(key, next);
  void next.finally(() => {
    if (state.chains.get(key) === next) state.chains.delete(key);
  }).catch(() => undefined);
  return next;
}

/**
 * Seat count may have changed (member joined, left or was removed; a subscription event disagrees):
 * update the live subscription in the background. Never throws and never blocks the caller. Billing off = no-op.
 */
export function syncSeatsSoon(orgId: ObjectId, reason = "membership"): void {
  if (!billingEnabled()) return;
  void (async () => {
    await markPending(orgId);
    await enqueue(orgId);
  })().catch((err) => console.error(`[seat sync] org ${orgId.toHexString()} (${reason}) failed, will retry:`, err));
}

/** Awaitable variant for tests and the sweeper: marks pending, then syncs. */
export async function syncSeatsNow(orgId: ObjectId): Promise<SeatSyncOutcome> {
  if (!billingEnabled()) return "skipped";
  await markPending(orgId);
  return enqueue(orgId);
}

/** Retries pending syncs that are due (failed earlier, or a server stopped mid-way). Also run by /api/cron/wakes. */
export async function sweepSeatSyncs(): Promise<{ due: number; failed: number }> {
  if (!billingEnabled()) return { due: 0, failed: 0 };
  const col = await syncCol();
  const due = await col.find({ nextAt: { $lte: new Date() } }, { projection: { _id: 1 } }).limit(25).toArray();
  let failed = 0;
  for (const r of due) {
    try {
      await enqueue(r._id);
    } catch (err) {
      failed++;
      console.error(`[seat sync] retry for org ${r._id.toHexString()} failed:`, err);
    }
  }
  return { due: due.length, failed };
}

/** Sweeps every SWEEP_MS in a long-running server (not on Vercel, not during a build, not with billing off). */
function startSeatSweeper() {
  state.run = sweepSeatSyncs;
  if (state.timer || !billingEnabled() || process.env.VERCEL || process.env.NEXT_PHASE === "phase-production-build") return;
  state.timer = setInterval(async () => {
    if (state.running) return;
    state.running = true;
    try {
      await state.run?.();
    } catch (err) {
      console.error("[seat sync sweep]", err);
    } finally {
      state.running = false;
    }
  }, SWEEP_MS);
  state.timer.unref?.();
}

startSeatSweeper();
