/**
 * Billing for managed hosting (VEC-222). The rules and numbers live in `billing-core.ts`; this module
 * reads the deployment flag and gives server code getPlan / getEntitlements plus the assert helpers the
 * enforcement paths call. With `BILLING_ENABLED` off (the default) every org is "unlimited" and no
 * Stripe env is needed. With it on, missing Stripe env is a hard error (checked at startup in
 * `src/instrumentation.ts` and again on first use).
 */
import "server-only";
import { UserError } from "@/lib/result";
import type { OrgDoc } from "@/lib/types";
import {
  billingConfigError,
  billingEnabledIn,
  entitlementsFor,
  featureMessage,
  limitMessage,
  missingStripeEnv,
  planFor,
  type Entitlements,
  type Feature,
  type LimitKind,
  type Plan,
} from "@/lib/billing-core";

export type { Entitlements, Feature, LimitKind, Plan } from "@/lib/billing-core";
export { PLAN_LABEL, PRO_PRICE_LABEL, limitOf } from "@/lib/billing-core";

/** Thrown when billing is on but Stripe isn't configured. Not a UserError: it must not read as a user mistake. */
export class BillingConfigError extends Error {
  constructor(readonly missing: string[]) {
    super(billingConfigError(missing));
    this.name = "BillingConfigError";
  }
}

export function billingEnabled(): boolean {
  return billingEnabledIn(process.env);
}

let checked = false;
/** Throws BillingConfigError naming the missing vars when billing is on without Stripe config; no-op when off. */
export function assertBillingConfig(): void {
  if (checked) return;
  const missing = missingStripeEnv(process.env);
  if (missing.length) throw new BillingConfigError(missing);
  checked = true;
}

/** Stripe settings for the Stripe tasks to use; throws when billing is off or config is missing. */
export function stripeConfig(): { secretKey: string; webhookSecret: string; priceId: string } {
  if (!billingEnabled()) throw new Error("Billing is disabled (BILLING_ENABLED is not set).");
  assertBillingConfig();
  return {
    secretKey: process.env.STRIPE_SECRET_KEY!,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
    priceId: process.env.STRIPE_PRICE_ID!,
  };
}

type OrgLike = Pick<OrgDoc, "billing">;

export function getPlan(org: OrgLike, now: Date = new Date()): Plan {
  const enabled = billingEnabled();
  if (enabled) assertBillingConfig();
  return planFor(org.billing, enabled, now);
}

export function getEntitlements(org: OrgLike, now?: Date): Entitlements {
  return entitlementsFor(getPlan(org, now));
}

/** Throws a UserError with an upgrade message when the org's plan lacks `feature`. */
export function assertEntitlement(org: OrgLike, feature: Feature): void {
  const msg = featureMessage(getPlan(org), feature);
  if (msg) throw new UserError(msg);
}

/**
 * Throws a UserError with an upgrade message when adding one more `kind` would pass the plan's limit.
 * `current` = how many the org has now (people, bots, projects), or for concurrentBotTasks the tasks the
 * bot is already working on.
 */
export function assertWithinLimit(org: OrgLike, kind: LimitKind, current: number): void {
  const msg = limitMessage(getPlan(org), kind, current);
  if (msg) throw new UserError(msg);
}
