/**
 * Client-safe billing summary for the UI (VEC-226, paid-only since VEC-262): the Settings > Billing page and the
 * locked state of an org with no live subscription. Built on the server by `loadBillingSummary` (lib/billing-summary.ts) in the org layout, so
 * it refreshes with every org.changed (a Stripe webhook publishes one when the plan changes). The rules stay
 * in billing-core; this only describes the result. With billing off (`enabled: false`) every check here
 * passes and the UI shows no Billing entry and no prompts.
 */
import { orgAccessMessage, PLAN_LABEL, planHeading, PRO_PRICE_LABEL, PRO_SEAT_PRICE_CENTS, proMonthlyCents, seatTotalLabel, TAX_NOTE, usd, type Plan } from "./billing-core";
import type { BillingStatus } from "./types";

export { orgAccessMessage, PLAN_LABEL, planHeading, PRO_PRICE_LABEL, PRO_SEAT_PRICE_CENTS, proMonthlyCents, seatTotalLabel, TAX_NOTE, usd };
export type { Plan };

export type CountKind = "members" | "bots" | "projects";

export interface BillingSummary {
  /** BILLING_ENABLED on this deployment. Off = self-hosted: no Billing page, no prompts, everything on. */
  enabled: boolean;
  /** Billing is on only through the Settings > Debug toggle (VEC-240): test mode, show the banner. */
  debug: boolean;
  /** This instance shows Settings > Debug to admins (AIMPOINT_DEBUG on, BILLING_ENABLED off). */
  debugAvailable: boolean;
  /** Debug billing can't reach Stripe (missing vars, a non-test key): the message, else null. */
  debugProblem: string | null;
  plan: Plan;
  /** No live subscription (plan "unpaid"): the org is locked until an admin subscribes in Settings > Billing. */
  locked: boolean;
  /** Stripe subscription status, null when the org never subscribed. */
  status: BillingStatus | null;
  /** ISO dates. */
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** When a canceled subscription ended (never in the future), else null. */
  endedAt: string | null;
  pastDueSince: string | null;
  /** When a past_due org locks (pastDueSince + grace), else null. */
  graceEndsAt: string | null;
  /** A Stripe customer exists, so the Customer Portal can open. */
  hasCustomer: boolean;
  /** A subscription Stripe still bills (active, trialing, past_due, unpaid, paused): Checkout is refused then. */
  liveSubscription: boolean;
  features: { analytics: boolean; publicForms: boolean };
  /** What the org has (people include pending invites, projects include archived). There are no count limits. */
  usage: Record<CountKind, number> & { pendingInvites: number; archivedProjects: number };
  /** Billable seats now (VEC-238): human members; bots and pending invites aren't seats. */
  seats: number;
  /** Seats on the Stripe subscription as last reported by the webhook (null before one arrived). */
  subscribedSeats: number | null;
}

/** Billing off: what the self-hosted UI sees (nothing limited). */
export const UNLIMITED_SUMMARY: BillingSummary = {
  enabled: false,
  debug: false,
  debugAvailable: false,
  debugProblem: null,
  plan: "unlimited",
  locked: false,
  status: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  endedAt: null,
  pastDueSince: null,
  graceEndsAt: null,
  hasCustomer: false,
  liveSubscription: false,
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

export const FEATURE_LABEL = { analytics: "Analytics", publicForms: "Public forms and public projects" } as const;
export type FeatureKind = keyof typeof FEATURE_LABEL;

/** Where self-hosting is documented: the free way to run Aimpoint, since hosted has no free tier (VEC-264). */
export const SELF_HOST_URL = "https://github.com/rm2kdev/aimpoint#run-locally";

/** What Pro includes, for the Billing page. Hosted Aimpoint has no other plan (self-hosted is free and unlimited). */
export const PRO_INCLUDES: string[] = ["Unlimited people", "Unlimited bots", "Unlimited projects", "Bots work on any number of tasks at once", "Analytics", "Public forms and public projects"];
