"use server";

import { headers } from "next/headers";
import { billingOn } from "@/lib/billing";
import { guard, UserError, type Result } from "@/lib/result";
import { requireOrg } from "@/lib/session";
import { createCheckoutSession, createPortalSession } from "@/lib/stripe";

/** Origin for Stripe's return URLs: the browser's Origin header (server actions always send it), else the host. */
async function requestOrigin(): Promise<string> {
  const h = await headers();
  const origin = h.get("origin");
  if (origin) return origin;
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) throw new Error("Can't tell this site's address for the Stripe return URL.");
  return `${h.get("x-forwarded-proto") ?? "http"}://${host}`;
}

async function assertBillingOn() {
  if (!(await billingOn())) throw new UserError("Billing is turned off on this deployment.");
}

/** Admins: a Stripe Checkout URL to subscribe the org to Pro (US$4.95 per user/month, quantity = seats). */
export async function startCheckout(slug: string): Promise<Result<{ url: string }>> {
  return guard(async () => {
    await assertBillingOn();
    const { org } = await requireOrg(slug, { admin: true });
    return { url: await createCheckoutSession(org, await requestOrigin()) };
  });
}

/** Admins: a Stripe Customer Portal URL (change card, invoices, cancel). */
export async function openBillingPortal(slug: string): Promise<Result<{ url: string }>> {
  return guard(async () => {
    await assertBillingOn();
    const { org } = await requireOrg(slug, { admin: true });
    return { url: await createPortalSession(org, await requestOrigin()) };
  });
}
