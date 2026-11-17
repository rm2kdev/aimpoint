/**
 * Billing rules (VEC-222), pure so `billing-core.test.mjs` runs them under plain `node --test`.
 * Server code imports `@/lib/billing` (UserError wrappers, env checks); this module holds the numbers
 * and the plan logic in one place. No Stripe calls here.
 *
 * Plans: "unlimited" when billing is off (self-hosted), "pro" for a paying org (US$5/month, everything
 * unlimited), "free" otherwise (1 person, 1 bot, 1 project, bots on 1 task at a time, no Analytics,
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

export const PRO_PRICE_LABEL = "US$5/month";

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
