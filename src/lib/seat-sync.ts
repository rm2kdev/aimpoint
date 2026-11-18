/**
 * Per-seat billing (VEC-238): keeps a live Pro subscription's quantity equal to the org's billable seats
 * (human members, `billableSeats` in billing-core.ts). Pro is US$4.95 per seat per month, prorated.
 *
 * - `syncSeatsSoon(orgId)` runs after a membership change (invite accepted, member removed or left). It never
 *   blocks or fails the change itself: the sync runs after the response (`after`, so Vercel doesn't freeze it
 *   mid-way), serialized per org in this process.
 * - Each sync first marks the org pending in `seatSyncs` (rev bumped), counts seats, reads the subscription
 *   item from Stripe and only calls `subscriptions.update` (items quantity, proration_behavior
 *   create_prorations) when the quantity differs. Setting an absolute quantity is idempotent, and the
 *   request carries an idempotency key per (subscription, from, to, pending entry).
 * - Success deletes the pending row (only if no newer change bumped `rev`, else it runs again). Failure logs,
 *   keeps the row and schedules a retry with backoff; the sweeper (every 30 s in a long-running server, and
 *   /api/cron/wakes on Vercel, scheduled in vercel.json) retries due rows, so a Stripe outage reconciles later.
 *   Vercel Hobby runs that cron once a day, so `sweepSeatSyncsSoon()` also retries due rows after org page loads
 *   and Stripe webhooks (at most once a minute per instance, VEC-303).
 * - The logic lives in `seat-sync-core.ts` (unit tested with fakes); this module wires Mongo, Stripe and after().
 * - Billing off, or no live subscription: no Stripe calls, the pending row is dropped.
 */
import "server-only";
import type { ObjectId } from "mongodb";
import { after } from "next/server";
import { cols, getDb } from "@/lib/db";
import { billingEnabled, billingEnvEnabled, stripeConfig } from "@/lib/billing";
import { billingDebugAvailable } from "@/lib/billing-mode";
import { billableSeats, seatQuantity } from "@/lib/billing-core";
import { stripe } from "@/lib/stripe";
import { hasLiveSubscription } from "@/lib/stripe-sync";
import { createSeatSync, type SeatSyncOutcome, type SeatSyncStore } from "@/lib/seat-sync-core";

export type { SeatSyncOutcome } from "@/lib/seat-sync-core";

export interface SeatSyncDoc {
  _id: ObjectId; // org id
  /** Bumped by every change that needs a sync; a run only clears the row when rev is unchanged. */
  rev: number;
  pendingSince: Date;
  attempts: number;
  nextAt: Date;
  lastError: string | null;
}

const SWEEP_MS = 30_000;

async function syncCol() {
  return (await getDb()).collection<SeatSyncDoc>("seatSyncs");
}

/** Billable seats right now: the org's human members (memberships). Bots and pending invites aren't seats. */
export async function countBillableSeats(orgId: ObjectId): Promise<number> {
  const { memberships } = await cols();
  return billableSeats(await memberships.find({ orgId }, { projection: { userId: 1 } }).toArray());
}

const store: SeatSyncStore<ObjectId> = {
  async markPending(orgId, now) {
    await (await syncCol()).updateOne(
      { _id: orgId },
      { $inc: { rev: 1 }, $setOnInsert: { pendingSince: now, attempts: 0, lastError: null }, $set: { nextAt: now } },
      { upsert: true },
    );
  },
  async get(orgId) {
    return (await syncCol()).findOne({ _id: orgId });
  },
  async clear(orgId, rev) {
    await (await syncCol()).deleteOne({ _id: orgId, rev });
  },
  async fail(orgId, patch) {
    await (await syncCol()).updateOne({ _id: orgId }, { $set: patch });
  },
  async due(now, limit) {
    const rows = await (await syncCol()).find({ nextAt: { $lte: now } }, { projection: { _id: 1 } }).limit(limit).toArray();
    return rows.map((r) => r._id);
  },
};

function defer(job: () => Promise<void>) {
  // VEC-291: on Vercel a detached promise can be frozen once the response is sent, so the Stripe update
  // may never run; after() keeps the function alive until it finishes.
  try {
    after(job);
  } catch {
    // Outside a request (scripts, the sweeper): run detached.
    void job();
  }
}

type SeatSyncState = {
  core?: ReturnType<typeof createSeatSync<ObjectId>>;
  timer?: ReturnType<typeof setInterval>;
  running?: boolean;
  run?: () => Promise<unknown>;
};
const g = globalThis as unknown as { __aimpointSeatSync?: SeatSyncState };
const state: SeatSyncState = (g.__aimpointSeatSync ??= {});
// One instance per process (survives dev HMR) so per-org serialization and the sweep throttle are shared.
const core = (state.core ??= createSeatSync<ObjectId>({
  store,
  key: (id) => id.toHexString(),
  enabled: billingEnabled,
  async liveSubscription(orgId) {
    const { orgs } = await cols();
    const org = await orgs.findOne({ _id: orgId }, { projection: { billing: 1 } });
    const subId = org?.billing?.subscriptionId;
    return subId && hasLiveSubscription(org.billing) ? subId : null;
  },
  quantity: async (orgId) => seatQuantity(await countBillableSeats(orgId)),
  priceId: () => stripeConfig().priceId,
  stripe: () => {
    const s = stripe();
    return {
      retrieve: (id) => s.subscriptions.retrieve(id),
      update: (id, params, opts) => s.subscriptions.update(id, params, opts),
    };
  },
  defer,
}));

/**
 * Seat count may have changed (member joined, left or was removed; a subscription event disagrees):
 * update the live subscription in the background. Never throws and never blocks the caller. Billing off = no-op.
 */
export function syncSeatsSoon(orgId: ObjectId, reason = "membership"): void {
  core.syncSoon(orgId, reason);
}

/** Awaitable variant for scripts: marks pending, then syncs. */
export async function syncSeatsNow(orgId: ObjectId): Promise<SeatSyncOutcome> {
  return core.syncNow(orgId);
}

/** Retries pending syncs that are due (failed earlier, or a server stopped mid-way). Also run by /api/cron/wakes. */
export async function sweepSeatSyncs(): Promise<{ due: number; failed: number }> {
  return core.sweep();
}

/**
 * Cheap retry trigger for production, where the cron is daily (VEC-303): sweeps due rows after the response,
 * at most once a minute per instance. Called from org page loads and the Stripe webhook. Never throws.
 */
export function sweepSeatSyncsSoon(reason = "page"): void {
  try {
    core.sweepSoon(reason);
  } catch (err) {
    console.error("[seat sync] sweepSoon failed:", err);
  }
}

/**
 * Sweeps every SWEEP_MS in a long-running server (not on Vercel, not during a build, not when billing can't turn on).
 * With the VEC-240 debug toggle available the timer runs and each sweep checks billingEnabled() itself.
 */
function startSeatSweeper() {
  state.run = sweepSeatSyncs;
  if (state.timer || !(billingEnvEnabled() || billingDebugAvailable()) || process.env.VERCEL || process.env.NEXT_PHASE === "phase-production-build") return;
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
