/**
 * Pure Stripe -> org billing mapping (VEC-223), kept free of Stripe/Mongo imports so
 * `stripe-sync.test.mjs` runs it under plain `node --test`. `lib/stripe.ts` does the I/O.
 *
 * Inputs are loose shapes of Stripe objects: field placement moved between API versions
 * (current_period_end went from the subscription to its items in 2025-03-31.basil, invoice.subscription
 * to invoice.parent.subscription_details.subscription), so both places are read.
 */
import type { BillingDiscount, BillingStatus, OrgBilling } from "./types";

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
  /** When the subscription ended (set once it is canceled); canceled_at is when the cancel was requested. */
  ended_at?: number | null;
  canceled_at?: number | null;
  items?: { data?: { id?: string; quantity?: number | null; current_period_end?: number | null }[] } | null;
  /** Discount ids in webhook payloads; Discount objects when retrieved with expand (VEC-311). */
  discounts?: (string | DiscountLike)[] | null;
}

export interface CouponLike {
  id?: string;
  name?: string | null;
  percent_off?: number | null;
  amount_off?: number | null;
  currency?: string | null;
  duration?: string | null;
  duration_in_months?: number | null;
}

/** A Stripe Discount: the coupon sits in `source.coupon` since 2025-09-30.clover, in `coupon` before. */
export interface DiscountLike {
  id?: string;
  end?: number | null;
  promotion_code?: string | { id: string; code?: string | null } | null;
  source?: { coupon?: string | CouponLike | null } | null;
  coupon?: CouponLike | null;
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

/** Seats billed (VEC-238): the subscription's item quantity (summed over items; Aimpoint uses one). Null when absent. */
export function subscriptionSeats(sub: SubscriptionLike): number | null {
  const items = sub.items?.data ?? [];
  const q = items.map((i) => i.quantity).filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  return q.length ? q.reduce((a, b) => a + b, 0) : null;
}

/**
 * The subscription's discount (VEC-311): null when it has none, undefined when its discounts are only ids (webhook
 * payloads), so the caller retrieves the subscription with them expanded first. Checkout takes one promotion code,
 * so only the first discount is kept.
 */
export function subscriptionDiscount(sub: SubscriptionLike): BillingDiscount | null | undefined {
  const list = sub.discounts;
  if (list === undefined) return undefined;
  if (!list || !list.length) return null;
  const d = list[0];
  if (typeof d === "string") return undefined;
  const c = d.source?.coupon && typeof d.source.coupon === "object" ? d.source.coupon : (d.coupon ?? null);
  if (!c) return undefined;
  const promo = d.promotion_code;
  return {
    code: promo && typeof promo === "object" ? (promo.code ?? null) : null,
    name: c.name ?? null,
    percentOff: c.percent_off ?? null,
    amountOffCents: c.amount_off ?? null,
    currency: c.currency ?? null,
    duration: c.duration ?? null,
    durationInMonths: c.duration_in_months ?? null,
    endsAt: d.end ? new Date(d.end * 1000) : null,
  };
}

/** Discounts are present as bare ids: retrieve the subscription with `discounts.source.coupon` expanded. */
export function needsDiscountExpand(sub: SubscriptionLike): boolean {
  return Array.isArray(sub.discounts) && sub.discounts.length > 0 && subscriptionDiscount(sub) === undefined;
}

/** The org billing fields a subscription event sets (pastDueSince is filled by `mergeBilling`). */
export function subscriptionPatch(sub: SubscriptionLike, deleted = false): OrgBilling {
  // Unknown (not expanded) leaves the stored discount as it was.
  const discount = deleted ? null : subscriptionDiscount(sub);
  return {
    ...(discount !== undefined && { discount }),
    stripeCustomerId: refId(sub.customer),
    subscriptionId: sub.id,
    status: deleted ? "canceled" : toBillingStatus(sub.status),
    currentPeriodEnd: periodEnd(sub),
    // The Customer Portal cancels with cancel_at (newer API versions) or cancel_at_period_end.
    cancelAtPeriodEnd: !deleted && (Boolean(sub.cancel_at_period_end) || Boolean(sub.cancel_at)),
    // A deleted subscription keeps the current_period_end it had, a month out after an immediate cancel (VEC-231).
    endedAt: endedAt(sub, deleted),
    seats: subscriptionSeats(sub),
  };
}

/** When a canceled subscription ended: ended_at, else canceled_at for a deleted event; null while it is live. */
function endedAt(sub: SubscriptionLike, deleted: boolean): Date | null {
  const secs = sub.ended_at ?? (deleted ? sub.canceled_at : null);
  return secs ? new Date(secs * 1000) : null;
}

/**
 * The "ended on" date for a canceled subscription: endedAt, else (billing stored before VEC-231) the period end
 * only when it has passed. Never a future date: an immediate cancel's period end is still a month away.
 */
export function canceledEndDate(billing: OrgBilling | null | undefined, now: Date): Date | null {
  if (billing?.status !== "canceled") return null;
  const d = billing.endedAt ?? billing.currentPeriodEnd ?? null;
  return d && new Date(d).getTime() <= now.getTime() ? new Date(d) : null;
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
