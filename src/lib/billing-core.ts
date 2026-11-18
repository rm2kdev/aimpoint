/**
 * Billing rules (VEC-222), pure so `billing-core.test.mjs` runs them under plain `node --test`.
 * Server code imports `@/lib/billing` (UserError wrappers, env checks); this module holds the numbers
 * and the plan logic in one place. No Stripe calls here.
 *
 * Plans (VEC-262): "unlimited" when billing is off (self-hosted), "pro" for a paying org (US$4.95 per user per month,
 * billed per org with the seat count as the Stripe quantity; everything included, no count limits), "unpaid" otherwise.
 * There is no free tier on managed hosting: an unpaid org is locked, not deleted. Members can still sign in and see
 * Settings > Billing, an admin can subscribe there, and everything else is refused (orgAccessMessage). Its data stays
 * and it unlocks the moment a subscription is live.
 */
import type { OrgBilling } from "./types";

export type Plan = "unlimited" | "pro" | "unpaid";

/**
 * What a plan includes. Pro and self-hosted include everything; an unpaid org includes nothing (it's locked), which
 * also keeps its public forms and public project pages unavailable until it subscribes.
 */
export interface Entitlements {
  analytics: boolean;
  publicForms: boolean;
}

export type Feature = "analytics" | "publicForms";

/** Pro's price per seat (a human member) per month, in US cents (VEC-238). */
export const PRO_SEAT_PRICE_CENTS = 495;
export const PRO_PRICE_LABEL = "US$4.95 per user/month";

/** "US$4.95", "US$14.85": a US-cent amount as shown in the UI. */
export function usd(cents: number): string {
  return `US$${(Math.round(cents) / 100).toFixed(2)}`;
}

/**
 * Billable seats (VEC-238): the org's human members, one per distinct userId among its memberships. Bots are
 * not seats (they aren't memberships) and pending invites aren't either until accepted (an accepted invite
 * becomes a membership). Pass the org's membership docs (or just their userIds).
 */
export function billableSeats(memberships: readonly { userId: { toString(): string } | string }[]): number {
  return new Set(memberships.map((m) => String(m.userId))).size;
}

/** The Stripe subscription quantity for `seats`: never below 1 (an org always has its admin). */
export function seatQuantity(seats: number): number {
  return Math.max(1, Math.floor(Number.isFinite(seats) ? seats : 1));
}

/** Monthly Pro total for `seats` seats, in US cents. */
export function proMonthlyCents(seats: number): number {
  return seatQuantity(seats) * PRO_SEAT_PRICE_CENTS;
}

/** "3 seats x US$4.95 = US$14.85/month". */
export function seatTotalLabel(seats: number): string {
  const n = seatQuantity(seats);
  return `${n} ${n === 1 ? "seat" : "seats"} x ${usd(PRO_SEAT_PRICE_CENTS)} = ${usd(proMonthlyCents(n))}/month`;
}

/** How long a past_due subscription keeps Pro while Stripe retries the payment. */
export const PAST_DUE_GRACE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const EVERYTHING: Entitlements = { analytics: true, publicForms: true };
const NOTHING: Entitlements = { analytics: false, publicForms: false };

export const PLAN_ENTITLEMENTS: Record<Plan, Entitlements> = { unlimited: EVERYTHING, pro: EVERYTHING, unpaid: NOTHING };

export const PLAN_LABEL: Record<Plan, string> = { unlimited: "Self-hosted", pro: "Pro", unpaid: "No subscription" };

export const STRIPE_ENV_VARS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_ID"] as const;

type Env = Record<string, string | undefined>;

/** `BILLING_ENABLED` on = managed hosting. Unset, empty or anything but 1/true/yes/on = self-hosted, billing off. */
export function billingEnabledIn(env: Env): boolean {
  return ["1", "true", "yes", "on"].includes((env.BILLING_ENABLED ?? "").trim().toLowerCase());
}

/** Stripe vars that must be set when billing is on (empty when billing is off: self-hosters need none). */
export function missingStripeEnv(env: Env): string[] {
  if (!billingEnabledIn(env)) return [];
  return STRIPE_ENV_VARS.filter((name) => !(env[name] ?? "").trim());
}

/**
 * `AIMPOINT_DEBUG` on (1/true/yes/on) AND `BILLING_ENABLED` off = a self-hosted instance where the Settings > Debug
 * billing toggle (VEC-240) exists. With BILLING_ENABLED on (managed hosting) the toggle never applies.
 */
export function debugToggleAvailableIn(env: Env): boolean {
  return ["1", "true", "yes", "on"].includes((env.AIMPOINT_DEBUG ?? "").trim().toLowerCase()) && !billingEnabledIn(env);
}

export type StripeKeyMode = "test" | "live" | "unknown";

/** Test-mode keys start sk_test_ / rk_test_, live ones sk_live_ / rk_live_. */
export function stripeKeyMode(key: string | undefined): StripeKeyMode {
  const k = (key ?? "").trim();
  if (/^(sk|rk)_test_/.test(k)) return "test";
  if (/^(sk|rk)_live_/.test(k)) return "live";
  return "unknown";
}

/**
 * Why debug billing can't use this Stripe config (empty = fine): missing STRIPE_* vars, and any key that isn't a
 * test-mode key, since debug billing must never charge real cards.
 */
export function debugStripeProblems(env: Env): string[] {
  const problems: string[] = [];
  const missing = STRIPE_ENV_VARS.filter((name) => !(env[name] ?? "").trim());
  if (missing.length) problems.push(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set.`);
  if ((env.STRIPE_SECRET_KEY ?? "").trim()) {
    const mode = stripeKeyMode(env.STRIPE_SECRET_KEY);
    if (mode === "live") problems.push("STRIPE_SECRET_KEY is a live key. Debug billing only accepts test-mode keys (sk_test_ or rk_test_).");
    else if (mode === "unknown") problems.push("STRIPE_SECRET_KEY isn't a Stripe test-mode key (sk_test_ or rk_test_).");
  }
  return problems;
}

export function debugBillingError(problems: string[]): string {
  return `Test billing (debug) can't use this Stripe setup: ${problems.join(" ")}`;
}

export function billingConfigError(missing: string[]): string {
  return (
    `Billing is enabled (BILLING_ENABLED) but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set. ` +
    "Set them (see .env.example), or unset BILLING_ENABLED to run self-hosted with every feature on."
  );
}

/**
 * Plan for an org's billing state. Pro while the subscription is active or trialing, and while it is
 * past_due for up to PAST_DUE_GRACE_DAYS (from `pastDueSince`, else from `currentPeriodEnd`). Anything
 * else (no subscription, canceled, unpaid, incomplete, paused, grace over) is "unpaid": the org is locked.
 */
export function planFor(billing: OrgBilling | null | undefined, enabled: boolean, now: Date = new Date()): Plan {
  if (!enabled) return "unlimited";
  const status = billing?.status;
  if (status === "active" || status === "trialing") return "pro";
  if (status === "past_due") {
    const since = billing?.pastDueSince ?? billing?.currentPeriodEnd ?? null;
    if (!since) return "pro";
    return now.getTime() - new Date(since).getTime() <= PAST_DUE_GRACE_DAYS * DAY_MS ? "pro" : "unpaid";
  }
  return "unpaid";
}

/** Whether an org on `plan` can be used at all (everything but Settings > Billing is refused when not). */
export function planActive(plan: Plan): boolean {
  return plan !== "unpaid";
}

export function entitlementsFor(plan: Plan): Entitlements {
  return { ...PLAN_ENTITLEMENTS[plan] };
}

/** Why an unpaid org is locked, as the opening clause of the lock message (from its Stripe subscription status). */
export function unpaidReason(billing: OrgBilling | null | undefined): string {
  switch (billing?.status) {
    case "past_due":
    case "unpaid":
      return "Its last payment failed";
    case "canceled":
      return "Its subscription has ended";
    case "paused":
      return "Its subscription is paused";
    case "incomplete":
    case "incomplete_expired":
      return "Its first payment didn't go through";
    default:
      return "It has no subscription";
  }
}

/**
 * The one answer to "is this org usable" (VEC-262): null when it is, else the message every refused path shows (REST
 * answers 402 with it). Admins are pointed at Settings > Billing to subscribe; members are told to ask an admin.
 * `billing` only sharpens the reason (ended, payment failed); without it the message is generic.
 */
export function orgAccessMessage(plan: Plan, isAdmin: boolean, billing?: OrgBilling | null): string | null {
  if (planActive(plan)) return null;
  const why = billing === undefined ? "It has no active subscription" : unpaidReason(billing);
  const head = `This organisation is locked. ${why}, and Aimpoint's hosted service needs a Pro subscription (${PRO_PRICE_LABEL}).`;
  const tail = isAdmin
    ? "Subscribe in Settings > Billing to unlock it; nothing has been deleted."
    : "Ask an admin to subscribe in Settings > Billing; nothing has been deleted.";
  return `${head} ${tail}`;
}

const FEATURE_NAME: Record<Feature, string> = { analytics: "Analytics isn't", publicForms: "Public forms and public projects aren't" };

/**
 * Message when the plan doesn't include `feature`, or null when it does. Only an unpaid (locked) org lacks a feature,
 * so this is the lock message naming the feature.
 */
export function featureMessage(plan: Plan, feature: Feature, isAdmin = true): string | null {
  if (entitlementsFor(plan)[feature]) return null;
  return `${FEATURE_NAME[feature]} available. ${orgAccessMessage(plan, isAdmin)}`;
}
