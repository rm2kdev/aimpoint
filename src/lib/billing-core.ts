/**
 * Billing rules (VEC-222), pure so `billing-core.test.mjs` runs them under plain `node --test`.
 * Server code imports `@/lib/billing` (UserError wrappers, env checks); this module holds the numbers
 * and the plan logic in one place. No Stripe calls here.
 *
 * Plans: "unlimited" when billing is off (self-hosted), "pro" for a paying org (US$4.95 per user per month,
 * billed per org with the seat count as the Stripe quantity; everything unlimited), "free" otherwise (1 person, 1 bot, 1 project, bots on 1 task at a time, no Analytics,
 * no Public forms).
 */
import type { OrgBilling } from "./types";

export type Plan = "unlimited" | "pro" | "free";

/** A count limit: a number, or null for unlimited (null survives JSON, Infinity doesn't). */
export type Limit = number | null;

export interface Entitlements {
  maxMembers: Limit;
  maxBots: Limit;
  maxProjects: Limit;
  /** Tasks one bot may work on at once. */
  maxConcurrentBotTasks: Limit;
  analytics: boolean;
  publicForms: boolean;
}

export type LimitKind = "members" | "bots" | "projects" | "concurrentBotTasks";
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

const FREE: Entitlements = {
  maxMembers: 1,
  maxBots: 1,
  maxProjects: 1,
  maxConcurrentBotTasks: 1,
  analytics: false,
  publicForms: false,
};
const UNLIMITED: Entitlements = {
  maxMembers: null,
  maxBots: null,
  maxProjects: null,
  maxConcurrentBotTasks: null,
  analytics: true,
  publicForms: true,
};

export const PLAN_ENTITLEMENTS: Record<Plan, Entitlements> = { unlimited: UNLIMITED, pro: UNLIMITED, free: FREE };

export const PLAN_LABEL: Record<Plan, string> = { unlimited: "Self-hosted", pro: "Pro", free: "Free" };

const LIMIT_FIELD: Record<LimitKind, keyof Entitlements> = {
  members: "maxMembers",
  bots: "maxBots",
  projects: "maxProjects",
  concurrentBotTasks: "maxConcurrentBotTasks",
};

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
 * else (no subscription, canceled, unpaid, incomplete, paused, grace over) is Free.
 */
export function planFor(billing: OrgBilling | null | undefined, enabled: boolean, now: Date = new Date()): Plan {
  if (!enabled) return "unlimited";
  const status = billing?.status;
  if (status === "active" || status === "trialing") return "pro";
  if (status === "past_due") {
    const since = billing?.pastDueSince ?? billing?.currentPeriodEnd ?? null;
    if (!since) return "pro";
    return now.getTime() - new Date(since).getTime() <= PAST_DUE_GRACE_DAYS * DAY_MS ? "pro" : "free";
  }
  return "free";
}

export function entitlementsFor(plan: Plan): Entitlements {
  return { ...PLAN_ENTITLEMENTS[plan] };
}

export function limitOf(ent: Entitlements, kind: LimitKind): Limit {
  return ent[LIMIT_FIELD[kind]] as Limit;
}

const NOUN: Record<LimitKind, [string, string]> = {
  members: ["person", "people"],
  bots: ["bot", "bots"],
  projects: ["project", "projects"],
  concurrentBotTasks: ["task at a time per bot", "tasks at a time"],
};
const FEATURE_NAME: Record<Feature, string> = { analytics: "Analytics", publicForms: "Public forms" };

const upgrade = (what: string) => `An admin can upgrade to Pro (${PRO_PRICE_LABEL}) in Settings > Billing for ${what}.`;

/**
 * Message when adding one more `kind` would pass the plan's limit (`current` = how many exist now,
 * for concurrentBotTasks: tasks the bot is already working on), or null when it fits.
 */
export function limitMessage(plan: Plan, kind: LimitKind, current: number): string | null {
  const limit = limitOf(entitlementsFor(plan), kind);
  if (limit === null || current + 1 <= limit) return null;
  const [one, many] = NOUN[kind];
  const cap = `${limit} ${limit === 1 ? one : many}`;
  if (kind === "concurrentBotTasks")
    return `On the ${PLAN_LABEL[plan]} plan a bot works on ${cap}. ${upgrade("bots that work on several tasks at once")}`;
  return `The ${PLAN_LABEL[plan]} plan includes ${cap}. ${upgrade(`unlimited ${many}`)}`;
}

/** Message when the plan doesn't include `feature`, or null when it does. */
export function featureMessage(plan: Plan, feature: Feature): string | null {
  if (entitlementsFor(plan)[feature]) return null;
  return `${FEATURE_NAME[feature]} isn't included in the ${PLAN_LABEL[plan]} plan. ${upgrade(FEATURE_NAME[feature])}`;
}
