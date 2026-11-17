"use server";

import { billingOn } from "@/lib/billing";
import { guard, UserError, type Result } from "@/lib/result";
import { requireOrg } from "@/lib/session";
import { requestOrigin } from "@/lib/request-origin";
import { createCheckoutSession, createPortalSession, type CheckoutReturn } from "@/lib/stripe";

async function assertBillingOn() {
  if (!(await billingOn())) throw new UserError("Billing is turned off on this deployment.");
}

/**
 * Admins: a Stripe Checkout URL to subscribe the org to Pro (US$4.95 per user/month, quantity = seats). `returnTo`
 * "app" (the Subscribe to continue screen, VEC-264) comes back to the org's My tasks; the default is Settings > Billing.
 */
export async function startCheckout(slug: string, returnTo: CheckoutReturn = "billing"): Promise<Result<{ url: string }>> {
  return guard(async () => {
    await assertBillingOn();
    const { org } = await requireOrg(slug, { admin: true, locked: "allow" });
    return { url: await createCheckoutSession(org, await requestOrigin(), returnTo === "app" ? "app" : "billing") };
  });
}

/** Admins: a Stripe Customer Portal URL (change card, invoices, cancel). */
export async function openBillingPortal(slug: string): Promise<Result<{ url: string }>> {
  return guard(async () => {
    await assertBillingOn();
    const { org } = await requireOrg(slug, { admin: true, locked: "allow" });
    return { url: await createPortalSession(org, await requestOrigin()) };
  });
}
