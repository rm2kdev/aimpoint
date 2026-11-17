/**
 * Instance-level debug toggle that turns billing on for testing on a self-hosted instance (VEC-240).
 *
 * Stored in the `instanceSettings` collection as `{_id: "billingDebug", enabled, by, at}`. It only counts while
 * `AIMPOINT_DEBUG` is on and `BILLING_ENABLED` is off (`debugToggleAvailableIn`); managed hosting never reads it.
 *
 * `billingEnabled()` (lib/billing.ts) stays synchronous because plan checks run in sync code paths, so the toggle
 * lives in a cache on globalThis: refreshed every REFRESH_MS in the background, awaited by request entry points
 * that must be exact (org layout, Billing page, billing actions, webhook route) via `refreshBillingDebug()`,
 * and set at once by `setBillingDebug` so the switch applies without a restart. Other server instances see a
 * change within REFRESH_MS.
 */
import "server-only";
import { getDb } from "@/lib/db";
import { debugToggleAvailableIn } from "@/lib/billing-core";

const REFRESH_MS = 5_000;
const DOC_ID = "billingDebug";

export interface BillingDebugState {
  enabled: boolean;
  /** User id that last changed it, and when. */
  by: string | null;
  at: Date | null;
}

interface BillingDebugDoc {
  _id: string;
  enabled: boolean;
  by: string | null;
  at: Date;
}

type Cache = { state: BillingDebugState; loadedAt: number; loading?: Promise<BillingDebugState>; timer?: ReturnType<typeof setInterval> };
const g = globalThis as unknown as { __aimpointBillingDebug?: Cache };
const cache: Cache = (g.__aimpointBillingDebug ??= { state: { enabled: false, by: null, at: null }, loadedAt: 0 });

const OFF: BillingDebugState = { enabled: false, by: null, at: null };

/** The debug toggle can apply on this instance (AIMPOINT_DEBUG on, BILLING_ENABLED off). */
export function billingDebugAvailable(): boolean {
  return debugToggleAvailableIn(process.env);
}

async function settings() {
  return (await getDb()).collection<BillingDebugDoc>("instanceSettings");
}

async function load(): Promise<BillingDebugState> {
  const doc = await (await settings()).findOne({ _id: DOC_ID });
  const state: BillingDebugState = doc ? { enabled: !!doc.enabled, by: doc.by ?? null, at: doc.at ?? null } : OFF;
  cache.state = state;
  cache.loadedAt = Date.now();
  return state;
}

/** Re-reads the toggle when the cached copy is older than REFRESH_MS (or always with `force`). Never throws. */
export async function refreshBillingDebug(force = false): Promise<BillingDebugState> {
  if (!billingDebugAvailable()) return OFF;
  startWatcher();
  if (!force && Date.now() - cache.loadedAt < REFRESH_MS) return cache.state;
  cache.loading ??= load()
    .catch((err) => {
      console.error("[billing debug] reading instanceSettings failed; keeping the last value", err);
      return cache.state;
    })
    .finally(() => (cache.loading = undefined));
  return cache.loading;
}

/** Cached toggle value (sync). False whenever the toggle isn't available on this instance. */
export function billingDebugOn(): boolean {
  if (!billingDebugAvailable()) return false;
  if (Date.now() - cache.loadedAt >= REFRESH_MS) void refreshBillingDebug();
  return cache.state.enabled;
}

export function billingDebugState(): BillingDebugState {
  return billingDebugAvailable() ? cache.state : OFF;
}

/** Writes the toggle and updates this server's cache at once. Callers check availability and admin rights. */
export async function setBillingDebug(enabled: boolean, by: string): Promise<BillingDebugState> {
  const at = new Date();
  await (await settings()).updateOne({ _id: DOC_ID }, { $set: { enabled, by, at } }, { upsert: true });
  cache.state = { enabled, by, at };
  cache.loadedAt = Date.now();
  return cache.state;
}

function startWatcher() {
  if (cache.timer || process.env.NEXT_PHASE === "phase-production-build") return;
  cache.timer = setInterval(() => void refreshBillingDebug(true), REFRESH_MS);
  cache.timer.unref?.();
}

if (billingDebugAvailable() && process.env.NEXT_PHASE !== "phase-production-build") void refreshBillingDebug();
