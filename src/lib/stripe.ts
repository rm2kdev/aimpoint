/**
 * Stripe for managed hosting (VEC-223): the API client, Checkout / Customer Portal sessions, and the
 * webhook that keeps `OrgDoc.billing` in step. Plan rules live in billing-core.ts; the pure
 * Stripe -> billing mapping in stripe-sync.ts. Everything here throws unless BILLING_ENABLED is on
 * (callers check `billingEnabled()` first so routes 404 and actions refuse when billing is off).
 *
 * Webhook rules:
 * - Idempotent: each event id is recorded in `stripeEvents` (claimed before handling, `processedAt` after);
 *   a redelivery of a processed event is acknowledged without touching the org. A failed handler drops the
 *   claim so Stripe's retry runs it again.
 * - Ordered: `billing.lastEventAt` holds the `created` time of the newest event applied; an older event
 *   that arrives late is skipped, so a delayed `subscription.updated` can't undo a later cancel.
 * - Writes are compare-and-set on `billing.updatedAt` (retried), then `org.changed` refreshes open tabs.
 */
import "server-only";
import Stripe from "stripe";
import { ObjectId } from "mongodb";
import { cols, getDb } from "@/lib/db";
import { stripeConfig } from "@/lib/billing";
import { seatQuantity } from "@/lib/billing-core";
import { orgPath } from "@/lib/paths";
import { publish } from "@/lib/realtime/server";
import { UserError } from "@/lib/result";
import type { OrgBilling, OrgDoc } from "@/lib/types";
import {
  hasLiveSubscription,
  invoiceSubscriptionId,
  mergeBilling,
  refId,
  subscriptionPatch,
  type InvoiceLike,
  type SubscriptionLike,
} from "@/lib/stripe-sync";

/** actorId on the realtime events the webhook publishes (no person or bot made the change). */
export const STRIPE_ACTOR = "stripe";

let client: { key: string; stripe: Stripe } | null = null;

/**
 * The Stripe client for the configured secret key. `STRIPE_API_BASE` (optional, e.g.
 * `http://localhost:12111` for stripe-mock) points it at another API host for local tests.
 */
export function stripe(): Stripe {
  const { secretKey } = stripeConfig();
  if (client?.key === secretKey) return client.stripe;
  const base = process.env.STRIPE_API_BASE?.trim();
  const opts: Stripe.StripeConfig = { appInfo: { name: "Aimpoint" }, maxNetworkRetries: 2 };
  if (base) {
    const u = new URL(base);
    opts.host = u.hostname;
    opts.port = u.port || (u.protocol === "http:" ? 80 : 443);
    opts.protocol = u.protocol === "http:" ? "http" : "https";
  }
  client = { key: secretKey, stripe: new Stripe(secretKey, opts) };
  return client.stripe;
}

const billingUrl = (origin: string, slug: string, query = "") =>
  `${origin.replace(/\/$/, "")}${orgPath(slug, "settings", "billing")}${query}`;

/** Where Checkout returns: Settings > Billing, or the app itself (onboarding and the Subscribe to continue screen, VEC-264). */
export type CheckoutReturn = "billing" | "app";

const checkoutReturnUrl = (origin: string, slug: string, to: CheckoutReturn, query: string) =>
  to === "app" ? `${origin.replace(/\/$/, "")}${orgPath(slug, "my")}${query}` : billingUrl(origin, slug, query);

/** The org's Stripe customer, created on first use (idempotency key per org) and stored on the org. */
export async function ensureCustomer(org: OrgDoc): Promise<string> {
  const { orgs } = await cols();
  const existing = org.billing?.stripeCustomerId;
  if (existing) return existing;
  const orgId = org._id.toHexString();
  const customer = await stripe().customers.create(
    { name: org.name, metadata: { orgId, orgSlug: org.slug } },
    { idempotencyKey: `aimpoint-org-customer-${orgId}` },
  );
  const res = await orgs.updateOne(
    { _id: org._id, $or: [{ "billing.stripeCustomerId": { $exists: false } }, { "billing.stripeCustomerId": null }] },
    { $set: { "billing.stripeCustomerId": customer.id, "billing.updatedAt": new Date() } },
  );
  if (res.modifiedCount) return customer.id;
  // Someone else stored one first: use theirs.
  const fresh = await orgs.findOne({ _id: org._id }, { projection: { billing: 1 } });
  return fresh?.billing?.stripeCustomerId ?? customer.id;
}

/**
 * A subscription-mode Checkout session for Pro at US$4.95 per user per month (STRIPE_PRICE_ID is the per-seat
 * price), with quantity = the org's billable seats now (min 1, VEC-238). Refused while a subscription is live.
 */
export async function createCheckoutSession(org: OrgDoc, origin: string, returnTo: CheckoutReturn = "billing"): Promise<string> {
  if (hasLiveSubscription(org.billing))
    throw new UserError("This organisation already has a subscription. Manage it from the billing portal.");
  const { priceId } = stripeConfig();
  const customer = await ensureCustomer(org);
  const orgId = org._id.toHexString();
  const { countBillableSeats } = await import("@/lib/seat-sync");
  const quantity = seatQuantity(await countBillableSeats(org._id));
  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    customer,
    client_reference_id: orgId,
    line_items: [{ price: priceId, quantity }],
    metadata: { orgId },
    subscription_data: { metadata: { orgId } },
    success_url: checkoutReturnUrl(origin, org.slug, returnTo, "?checkout=success&session_id={CHECKOUT_SESSION_ID}"),
    cancel_url: checkoutReturnUrl(origin, org.slug, returnTo, "?checkout=cancelled"),
  });
  if (!session.url) throw new Error("Stripe returned a Checkout session without a URL.");
  return session.url;
}

/** A Customer Portal session for the org's Stripe customer. */
export async function createPortalSession(org: OrgDoc, origin: string): Promise<string> {
  const customer = org.billing?.stripeCustomerId;
  if (!customer) throw new UserError("This organisation has no billing account yet. Subscribe to Pro first.");
  const session = await stripe().billingPortal.sessions.create({ customer, return_url: billingUrl(origin, org.slug) });
  return session.url;
}

// ---------------------------------------------------------------------------------------------------
// Webhook

export interface StripeEventDoc {
  _id: string; // Stripe event id
  type: string;
  orgId: ObjectId | null;
  outcome: string | null;
  receivedAt: Date;
  processedAt: Date | null;
}

/** How long an unfinished claim blocks a redelivery before another attempt may take it over. */
const CLAIM_STALE_MS = 2 * 60 * 1000;

async function eventsCol() {
  return (await getDb()).collection<StripeEventDoc>("stripeEvents");
}

/** Verifies the `Stripe-Signature` header against STRIPE_WEBHOOK_SECRET; throws on a bad or stale signature. */
export function verifyEvent(payload: string, signature: string | null): Stripe.Event {
  if (!signature) throw new Error("Missing Stripe-Signature header.");
  return stripe().webhooks.constructEvent(payload, signature, stripeConfig().webhookSecret);
}

type Claim = "claimed" | "duplicate" | "busy";

async function claimEvent(event: Stripe.Event): Promise<Claim> {
  const col = await eventsCol();
  const now = new Date();
  try {
    await col.insertOne({ _id: event.id, type: event.type, orgId: null, outcome: null, receivedAt: now, processedAt: null });
    return "claimed";
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
  }
  const prev = await col.findOne({ _id: event.id });
  if (!prev) return claimEvent(event);
  if (prev.processedAt) return "duplicate";
  if (now.getTime() - prev.receivedAt.getTime() < CLAIM_STALE_MS) return "busy";
  const took = await col.updateOne({ _id: event.id, processedAt: null, receivedAt: prev.receivedAt }, { $set: { receivedAt: now } });
  return took.modifiedCount ? "claimed" : "busy";
}

export type WebhookResult = { status: "processed" | "duplicate" | "busy"; outcome?: string };

/** Handles a verified event once. Throws (after dropping the claim) when handling fails, so Stripe retries. */
export async function processEvent(event: Stripe.Event): Promise<WebhookResult> {
  const claim = await claimEvent(event);
  if (claim !== "claimed") return { status: claim };
  const col = await eventsCol();
  try {
    const { orgId, outcome } = await handleEvent(event);
    await col.updateOne({ _id: event.id }, { $set: { processedAt: new Date(), orgId, outcome } });
    return { status: "processed", outcome };
  } catch (err) {
    await col.deleteOne({ _id: event.id, processedAt: null });
    throw err;
  }
}

const SUBSCRIPTION_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

async function handleEvent(event: Stripe.Event): Promise<{ orgId: ObjectId | null; outcome: string }> {
  const at = new Date(event.created * 1000);
  if (event.type === "checkout.session.completed") {
    const s = event.data.object as Stripe.Checkout.Session;
    if (s.mode !== "subscription") return { orgId: null, outcome: "ignored: not a subscription checkout" };
    const subId = refId(s.subscription);
    const customer = refId(s.customer);
    const org = await findOrg(s.client_reference_id ?? s.metadata?.orgId, { customer });
    if (!org) return { orgId: null, outcome: "ignored: no matching organisation" };
    const paid = s.payment_status === "paid" || s.payment_status === "no_payment_required";
    return apply(org, at, (prev) => {
      const known = prev?.subscriptionId === subId && prev?.status;
      return {
        stripeCustomerId: customer ?? prev?.stripeCustomerId ?? null,
        subscriptionId: subId,
        // The subscription events carry the real status; until one lands, a paid checkout is Pro.
        status: known ? prev!.status : paid ? "active" : "incomplete",
      };
    });
  }
  if (SUBSCRIPTION_EVENTS.has(event.type)) {
    const sub = event.data.object as unknown as SubscriptionLike;
    const deleted = event.type === "customer.subscription.deleted";
    const org = await findOrg(sub.metadata?.orgId, { customer: refId(sub.customer), subscription: sub.id });
    if (!org) return { orgId: null, outcome: "ignored: no matching organisation" };
    const patch = subscriptionPatch(sub, deleted);
    const result = await apply(org, at, (prev) => {
      // An event about another subscription doesn't override the org's live one (e.g. a stale second checkout).
      if (prev?.subscriptionId && prev.subscriptionId !== sub.id && hasLiveSubscription(prev) && !hasLiveSubscription(patch))
        return null;
      return patch;
    });
    // Seats (VEC-238): people may have joined or left between Checkout and now, or the quantity was edited in
    // Stripe. Reconcile in the background when the stored quantity differs from the member count.
    if (result.outcome.startsWith("applied") && hasLiveSubscription(patch)) {
      const { countBillableSeats, syncSeatsSoon } = await import("@/lib/seat-sync");
      if (patch.seats !== seatQuantity(await countBillableSeats(org._id))) syncSeatsSoon(org._id, event.type);
    }
    return result;
  }
  if (event.type === "invoice.payment_failed") {
    const inv = event.data.object as unknown as InvoiceLike;
    const subId = invoiceSubscriptionId(inv);
    if (!subId) return { orgId: null, outcome: "ignored: invoice has no subscription" };
    const org = await findOrg(inv.parent?.subscription_details?.metadata?.orgId, { customer: refId(inv.customer), subscription: subId });
    if (!org) return { orgId: null, outcome: "ignored: no matching organisation" };
    return apply(org, at, (prev) => {
      if (prev?.subscriptionId !== subId) return null;
      if (prev.status !== "active" && prev.status !== "trialing") return null;
      return { status: "past_due" };
    });
  }
  return { orgId: null, outcome: `ignored: ${event.type}` };
}

/** The org an event belongs to: by the org id we put in metadata, else by its Stripe customer/subscription. */
async function findOrg(orgId: string | null | undefined, by: { customer?: string | null; subscription?: string | null }) {
  const { orgs } = await cols();
  if (orgId && ObjectId.isValid(orgId)) {
    const org = await orgs.findOne({ _id: new ObjectId(orgId) });
    if (org) return org;
  }
  if (by.subscription) {
    const org = await orgs.findOne({ "billing.subscriptionId": by.subscription });
    if (org) return org;
  }
  if (by.customer) return orgs.findOne({ "billing.stripeCustomerId": by.customer });
  return null;
}

/**
 * Applies `build(prev)` to the org's billing unless a newer event was already applied (skip) or build
 * returns null (ignored). Compare-and-set on billing.updatedAt, re-read and retried on a lost race.
 */
async function apply(
  org: OrgDoc,
  at: Date,
  build: (prev: OrgBilling | undefined) => OrgBilling | null,
): Promise<{ orgId: ObjectId; outcome: string }> {
  const { orgs } = await cols();
  let current: OrgDoc | null = org;
  for (let attempt = 0; attempt < 5 && current; attempt++) {
    const prev = current.billing;
    if (prev?.lastEventAt && new Date(prev.lastEventAt).getTime() > at.getTime())
      return { orgId: org._id, outcome: "skipped: older than the last applied event" };
    const patch = build(prev);
    if (!patch) return { orgId: org._id, outcome: "ignored: not this organisation's current subscription" };
    const now = new Date();
    const next = { ...mergeBilling(prev, patch, now), lastEventAt: at };
    const res = await orgs.updateOne(
      { _id: org._id, "billing.updatedAt": prev?.updatedAt ?? { $exists: false } },
      { $set: { billing: next } },
    );
    if (res.matchedCount) {
      await publish(org._id.toHexString(), { type: "org.changed", actorId: STRIPE_ACTOR });
      return { orgId: org._id, outcome: `applied: ${next.status ?? "no status"}` };
    }
    current = await orgs.findOne({ _id: org._id });
  }
  throw new Error(`Couldn't update billing for org ${org._id.toHexString()} (concurrent writes).`);
}
