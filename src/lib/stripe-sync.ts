/**
 * Pure Stripe -> org billing mapping (VEC-223), kept free of Stripe/Mongo imports so
 * `stripe-sync.test.mjs` runs it under plain `node --test`. `lib/stripe.ts` does the I/O.
 *
 * Inputs are loose shapes of Stripe objects: field placement moved between API versions
 * (current_period_end went from the subscription to its items in 2025-03-31.basil, invoice.subscription
 * to invoice.parent.subscription_details.subscription), so both places are read.
 */
import type { BillingStatus, OrgBilling } from "./types";

type Ref = string | { id: string } | null | undefined;

/** A Stripe id from an expandable field (string id or expanded object). */
export function refId(ref: Ref): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : (ref.id ?? null);
}

export interface SubscriptionLike {
  id: string;
  status: string;
  customer: Ref;
  metadata?: Record<string, string> | null;
  cancel_at_period_end?: boolean | null;
  cancel_at?: number | null;
  current_period_end?: number | null;
  items?: { data?: { current_period_end?: number | null }[] } | null;
}

export interface InvoiceLike {
  customer: Ref;
  subscription?: Ref;
  parent?: { subscription_details?: { subscription?: Ref; metadata?: Record<string, string> | null } | null } | null;
}

const STATUSES: BillingStatus[] = [
  "active",
  "trialing",
  "past_due",
  "canceled",
  "unpaid",
  "incomplete",
  "incomplete_expired",
  "paused",
];

export function toBillingStatus(s: string | null | undefined): BillingStatus | null {
  return STATUSES.includes(s as BillingStatus) ? (s as BillingStatus) : null;
}

/** End of the paid period: the subscription's own field (older API versions) or the latest item's. */
export function periodEnd(sub: SubscriptionLike): Date | null {
  const own = sub.current_period_end;
  const items = (sub.items?.data ?? []).map((i) => i.current_period_end ?? 0).filter(Boolean);
  const secs = own ?? (items.length ? Math.max(...items) : null);
  return secs ? new Date(secs * 1000) : null;
}

export function invoiceSubscriptionId(inv: InvoiceLike): string | null {
  return refId(inv.parent?.subscription_details?.subscription) ?? refId(inv.subscription);
}

/** The org billing fields a subscription event sets (pastDueSince is filled by `mergeBilling`). */
export function subscriptionPatch(sub: SubscriptionLike, deleted = false): OrgBilling {
  return {
    stripeCustomerId: refId(sub.customer),
    subscriptionId: sub.id,
    status: deleted ? "canceled" : toBillingStatus(sub.status),
    currentPeriodEnd: periodEnd(sub),
    // The Customer Portal cancels with cancel_at (newer API versions) or cancel_at_period_end.
    cancelAtPeriodEnd: !deleted && (Boolean(sub.cancel_at_period_end) || Boolean(sub.cancel_at)),
  };
}

/**
 * Next billing state: `patch` over `prev`, with pastDueSince kept while the status stays past_due,
 * stamped `now` when it turns past_due, and cleared when it leaves past_due.
 */
export function mergeBilling(prev: OrgBilling | null | undefined, patch: OrgBilling, now: Date): OrgBilling {
  const next: OrgBilling = { ...(prev ?? {}), ...patch, updatedAt: now };
  if (next.status === "past_due") next.pastDueSince = prev?.status === "past_due" ? (prev.pastDueSince ?? now) : now;
  else next.pastDueSince = null;
  return next;
}

/** Statuses that mean the org already has a live subscription (Checkout refused, use the Portal). */
export function hasLiveSubscription(billing: OrgBilling | null | undefined): boolean {
  const s = billing?.status;
  return s === "active" || s === "trialing" || s === "past_due" || s === "unpaid" || s === "paused";
}
