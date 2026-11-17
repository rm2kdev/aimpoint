/**
 * Billing for managed hosting (VEC-222). The rules and numbers live in `billing-core.ts`; this module
 * reads the deployment flag and gives server code getPlan / getEntitlements plus the assert helpers the
 * enforcement paths call. With `BILLING_ENABLED` off (the default) every org is "unlimited" and no
 * Stripe env is needed. With it on, missing Stripe env is a hard error (checked at startup in
 * `src/instrumentation.ts` and again on first use).
 *
 * Debug billing (VEC-240): on a self-hosted instance with AIMPOINT_DEBUG on, an admin can switch billing on in
 * Settings > Debug (lib/billing-mode.ts). Effective billing = BILLING_ENABLED or that toggle. While the toggle is the
 * reason, a bad Stripe setup never fails startup or plan checks; Stripe calls refuse with a clear message instead,
 * and only test-mode keys are accepted.
 */
import "server-only";
import { UserError } from "@/lib/result";
import type { OrgDoc } from "@/lib/types";
import { billingDebugOn, refreshBillingDebug } from "@/lib/billing-mode";
import {
  billingConfigError,
  billingEnabledIn,
  debugBillingError,
  debugStripeProblems,
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

/** BILLING_ENABLED on this deployment (managed hosting). */
export function billingEnvEnabled(): boolean {
  return billingEnabledIn(process.env);
}

/** Billing on the debug toggle alone (self-hosted, AIMPOINT_DEBUG on, Settings > Debug switch on). */
export function billingDebugActive(): boolean {
  return !billingEnvEnabled() && billingDebugOn();
}

/** Effective billing: BILLING_ENABLED, or the debug toggle (cached, so it can be called from sync code). */
export function billingEnabled(): boolean {
  return billingEnvEnabled() || billingDebugOn();
}

/** Effective billing after re-reading the debug toggle if its cache is stale: use at request entry points. */
export async function billingOn(): Promise<boolean> {
  if (billingEnvEnabled()) return true;
  await refreshBillingDebug();
  return billingDebugOn();
}

/** Why debug billing can't reach Stripe right now (missing vars, a live key), or null. Null when not in debug mode. */
export function billingDebugProblem(): string | null {
  if (!billingDebugActive()) return null;
  const problems = debugStripeProblems(process.env);
  return problems.length ? debugBillingError(problems) : null;
}

let checked = false;
/** Throws BillingConfigError naming the missing vars when billing is on without Stripe config; no-op when off. */
export function assertBillingConfig(): void {
  if (checked) return;
  const missing = missingStripeEnv(process.env);
  if (missing.length) throw new BillingConfigError(missing);
  checked = true;
}

/**
 * Stripe settings for the Stripe tasks to use; throws when billing is off or config is missing. In debug mode a
 * missing var or a non-test key is a UserError (shown as-is in the Billing page and by the webhook route).
 */
export function stripeConfig(): { secretKey: string; webhookSecret: string; priceId: string } {
  if (!billingEnabled()) throw new Error("Billing is disabled (BILLING_ENABLED is not set).");
  if (billingEnvEnabled()) assertBillingConfig();
  else {
    const problem = billingDebugProblem();
    if (problem) throw new UserError(problem);
  }
  return {
    secretKey: process.env.STRIPE_SECRET_KEY!,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
    priceId: process.env.STRIPE_PRICE_ID!,
  };
}

type OrgLike = Pick<OrgDoc, "billing">;

export function getPlan(org: OrgLike, now: Date = new Date()): Plan {
  const enabled = billingEnabled();
  if (billingEnvEnabled()) assertBillingConfig();
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
