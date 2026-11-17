/**
 * Client-safe billing summary for the UI (VEC-226): the Settings > Billing page and the upgrade prompts at
 * each Free limit. Built on the server by `loadBillingSummary` (lib/billing-summary.ts) in the org layout, so
 * it refreshes with every org.changed (a Stripe webhook publishes one when the plan changes). The rules stay
 * in billing-core; this only describes the result. With billing off (`enabled: false`) every check here
 * passes and the UI shows no Billing entry and no prompts.
 */
import { PLAN_LABEL, PRO_PRICE_LABEL, PRO_SEAT_PRICE_CENTS, proMonthlyCents, seatTotalLabel, usd, type Limit, type Plan } from "./billing-core";
import type { BillingStatus } from "./types";

export { PLAN_LABEL, PRO_PRICE_LABEL, PRO_SEAT_PRICE_CENTS, proMonthlyCents, seatTotalLabel, usd };
export type { Plan };

export type CountKind = "members" | "bots" | "projects";

export interface BillingSummary {
  /** BILLING_ENABLED on this deployment. Off = self-hosted: no Billing page, no prompts, everything on. */
  enabled: boolean;
  plan: Plan;
  /** Stripe subscription status, null when the org never subscribed. */
  status: BillingStatus | null;
  /** ISO dates. */
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** When a canceled subscription ended (never in the future), else null. */
  endedAt: string | null;
  pastDueSince: string | null;
  /** When a past_due org drops to Free (pastDueSince + grace), else null. */
  graceEndsAt: string | null;
  /** A Stripe customer exists, so the Customer Portal can open. */
  hasCustomer: boolean;
  /** A subscription Stripe still bills (active, trialing, past_due, unpaid, paused): Checkout is refused then. */
  liveSubscription: boolean;
  /** The plan's limits (null = unlimited). */
  limits: Record<CountKind, Limit> & { concurrentBotTasks: Limit };
  features: { analytics: boolean; publicForms: boolean };
  /** What the org has, counted the way VEC-224 enforces it (people include pending invites, projects include archived). */
  usage: Record<CountKind, number> & { pendingInvites: number; archivedProjects: number };
  /** Billable seats now (VEC-238): human members; bots and pending invites aren't seats. */
  seats: number;
  /** Seats on the Stripe subscription as last reported by the webhook (null before one arrived). */
  subscribedSeats: number | null;
}

/** Billing off: what the self-hosted UI sees (nothing limited). */
export const UNLIMITED_SUMMARY: BillingSummary = {
  enabled: false,
  plan: "unlimited",
  status: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  endedAt: null,
  pastDueSince: null,
  graceEndsAt: null,
  hasCustomer: false,
  liveSubscription: false,
  limits: { members: null, bots: null, projects: null, concurrentBotTasks: null },
  features: { analytics: true, publicForms: true },
  usage: { members: 0, bots: 0, projects: 0, pendingInvites: 0, archivedProjects: 0 },
  seats: 0,
  subscribedSeats: null,
};

const NOUN: Record<CountKind, [string, string]> = {
  members: ["person", "people"],
  bots: ["bot", "bots"],
  projects: ["project", "projects"],
};

export const countNoun = (kind: CountKind, n: number) => (n === 1 ? NOUN[kind][0] : NOUN[kind][1]);

/** True when adding one more `kind` would pass the plan's limit. */
export function atLimit(b: BillingSummary, kind: CountKind): boolean {
  const limit = b.limits[kind];
  return limit !== null && b.usage[kind] + 1 > limit;
}

/** Short reason for a disabled action, e.g. "The Free plan includes 1 bot." */
export function limitReason(b: BillingSummary, kind: CountKind): string {
  const limit = b.limits[kind] ?? 0;
  return `The ${PLAN_LABEL[b.plan]} plan includes ${limit} ${countNoun(kind, limit)}.`;
}

export const FEATURE_LABEL = { analytics: "Analytics", publicForms: "Public forms" } as const;
export type FeatureKind = keyof typeof FEATURE_LABEL;

/** What each plan includes, for the comparison on the Billing page. */
export const PLAN_INCLUDES: Record<"free" | "pro", string[]> = {
  free: ["1 person", "1 bot", "1 project", "Bots work on 1 task at a time", "No Analytics", "No Public forms"],
  pro: ["Unlimited people", "Unlimited bots", "Unlimited projects", "Bots work on several tasks at once", "Analytics", "Public forms"],
};
