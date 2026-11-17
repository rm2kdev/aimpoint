// Run with `pnpm test` (node --test; Node strips the TypeScript types of billing-core.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planFor,
  entitlementsFor,
  billingEnabledIn,
  missingStripeEnv,
  billingConfigError,
  limitMessage,
  featureMessage,
  limitOf,
  PAST_DUE_GRACE_DAYS,
  PRO_PRICE_LABEL,
  PRO_SEAT_PRICE_CENTS,
  billableSeats,
  seatQuantity,
  proMonthlyCents,
  seatTotalLabel,
  usd,
} from "./billing-core.ts";

const NOW = new Date("2026-11-18T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (days) => new Date(NOW.getTime() - days * DAY);

const FREE = { maxMembers: 1, maxBots: 1, maxProjects: 1, maxConcurrentBotTasks: 1, analytics: false, publicForms: false };
const ALL = { maxMembers: null, maxBots: null, maxProjects: null, maxConcurrentBotTasks: null, analytics: true, publicForms: true };

test("billing disabled: every org is unlimited, whatever its billing state", () => {
  for (const billing of [undefined, null, {}, { status: "canceled" }, { status: "past_due", pastDueSince: ago(90) }, { status: "active" }]) {
    assert.equal(planFor(billing, false, NOW), "unlimited");
  }
  assert.deepEqual(entitlementsFor("unlimited"), ALL);
});

test("billing enabled, no subscription: Free with the Free numbers", () => {
  assert.equal(planFor(undefined, true, NOW), "free");
  assert.equal(planFor({}, true, NOW), "free");
  assert.equal(planFor({ stripeCustomerId: "cus_1", status: null }, true, NOW), "free");
  assert.deepEqual(entitlementsFor("free"), FREE);
});

test("active and trialing are Pro (incl. cancel at period end until Stripe cancels)", () => {
  assert.equal(planFor({ status: "active", currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY) }, true, NOW), "pro");
  assert.equal(planFor({ status: "active", cancelAtPeriodEnd: true }, true, NOW), "pro");
  assert.equal(planFor({ status: "trialing" }, true, NOW), "pro");
  assert.deepEqual(entitlementsFor("pro"), ALL);
});

test("past_due keeps Pro within the grace period, then Free", () => {
  assert.equal(planFor({ status: "past_due", pastDueSince: ago(1) }, true, NOW), "pro");
  assert.equal(planFor({ status: "past_due", pastDueSince: ago(PAST_DUE_GRACE_DAYS) }, true, NOW), "pro");
  assert.equal(planFor({ status: "past_due", pastDueSince: ago(PAST_DUE_GRACE_DAYS + 0.01) }, true, NOW), "free");
  // No pastDueSince: counts from currentPeriodEnd.
  assert.equal(planFor({ status: "past_due", currentPeriodEnd: ago(2) }, true, NOW), "pro");
  assert.equal(planFor({ status: "past_due", currentPeriodEnd: ago(30) }, true, NOW), "free");
  // Dates may arrive as strings (JSON); still resolved.
  assert.equal(planFor({ status: "past_due", pastDueSince: ago(1).toISOString() }, true, NOW), "pro");
});

test("cancelled and other ended statuses are Free", () => {
  for (const status of ["canceled", "unpaid", "incomplete", "incomplete_expired", "paused"]) {
    assert.equal(planFor({ status, currentPeriodEnd: new Date(NOW.getTime() + 5 * DAY) }, true, NOW), "free", status);
  }
});

test("entitlementsFor returns a copy", () => {
  const e = entitlementsFor("free");
  e.maxBots = 99;
  assert.equal(entitlementsFor("free").maxBots, 1);
});

test("BILLING_ENABLED parsing: unset/false = self-hosted", () => {
  for (const v of [undefined, "", "0", "false", "no", "off", "nope"]) assert.equal(billingEnabledIn({ BILLING_ENABLED: v }), false, String(v));
  for (const v of ["1", "true", "TRUE", " yes ", "on"]) assert.equal(billingEnabledIn({ BILLING_ENABLED: v }), true, v);
});

test("Stripe env: required only when billing is on, missing vars named", () => {
  assert.deepEqual(missingStripeEnv({}), []);
  assert.deepEqual(missingStripeEnv({ BILLING_ENABLED: "false" }), []);
  assert.deepEqual(missingStripeEnv({ BILLING_ENABLED: "true" }), ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_ID"]);
  assert.deepEqual(
    missingStripeEnv({ BILLING_ENABLED: "true", STRIPE_SECRET_KEY: "sk_x", STRIPE_WEBHOOK_SECRET: " ", STRIPE_PRICE_ID: "price_x" }),
    ["STRIPE_WEBHOOK_SECRET"],
  );
  assert.deepEqual(missingStripeEnv({ BILLING_ENABLED: "1", STRIPE_SECRET_KEY: "a", STRIPE_WEBHOOK_SECRET: "b", STRIPE_PRICE_ID: "c" }), []);
  const msg = billingConfigError(["STRIPE_SECRET_KEY", "STRIPE_PRICE_ID"]);
  assert.match(msg, /STRIPE_SECRET_KEY, STRIPE_PRICE_ID are not set/);
  assert.match(msg, /BILLING_ENABLED/);
});

test("limit messages: Free blocks the second one, Pro and unlimited never block", () => {
  assert.equal(limitMessage("free", "projects", 0), null);
  assert.match(limitMessage("free", "projects", 1), /Free plan includes 1 project\..*upgrade to Pro \(US\$4\.95 per user\/month\).*unlimited projects/);
  assert.match(limitMessage("free", "members", 1), /1 person/);
  assert.match(limitMessage("free", "bots", 3), /1 bot\b/);
  assert.match(limitMessage("free", "concurrentBotTasks", 1), /a bot works on 1 task at a time/);
  for (const plan of ["pro", "unlimited"]) {
    for (const kind of ["members", "bots", "projects", "concurrentBotTasks"]) assert.equal(limitMessage(plan, kind, 10_000), null);
  }
  assert.equal(limitOf(entitlementsFor("free"), "concurrentBotTasks"), 1);
  assert.equal(limitOf(entitlementsFor("pro"), "members"), null);
});

test("feature messages: Free lacks Analytics and Public forms", () => {
  assert.match(featureMessage("free", "analytics"), /Analytics isn't included in the Free plan/);
  assert.match(featureMessage("free", "publicForms"), /Public forms isn't included/);
  assert.equal(featureMessage("pro", "analytics"), null);
  assert.equal(featureMessage("unlimited", "publicForms"), null);
});

test("per-seat price (VEC-238): US$4.95 per user per month", () => {
  assert.equal(PRO_SEAT_PRICE_CENTS, 495);
  assert.equal(PRO_PRICE_LABEL, "US$4.95 per user/month");
  assert.equal(usd(495), "US$4.95");
  assert.equal(usd(1485), "US$14.85");
  assert.equal(usd(0), "US$0.00");
  assert.equal(proMonthlyCents(3), 1485);
  assert.equal(proMonthlyCents(0), 495, "billed for at least one seat");
  assert.equal(seatTotalLabel(1), "1 seat x US$4.95 = US$4.95/month");
  assert.equal(seatTotalLabel(12), "12 seats x US$4.95 = US$59.40/month");
});

test("billable seats: human memberships only, each person once", () => {
  const u = (id) => ({ toString: () => id });
  assert.equal(billableSeats([]), 0);
  assert.equal(billableSeats([{ userId: u("a") }]), 1);
  assert.equal(billableSeats([{ userId: u("a") }, { userId: u("b") }, { userId: "c" }]), 3);
  // A duplicate membership row for one person is still one seat.
  assert.equal(billableSeats([{ userId: u("a") }, { userId: "a" }]), 1);
  // Bots and pending invites are not memberships, so callers never pass them: only the membership list counts.
});

test("seat quantity for Stripe: at least 1, whole numbers", () => {
  assert.equal(seatQuantity(0), 1);
  assert.equal(seatQuantity(-3), 1);
  assert.equal(seatQuantity(1), 1);
  assert.equal(seatQuantity(7), 7);
  assert.equal(seatQuantity(2.9), 2);
  assert.equal(seatQuantity(NaN), 1);
});

test("Free plan limits unchanged by per-seat pricing", () => {
  assert.equal(entitlementsFor("free").maxMembers, 1);
  assert.equal(entitlementsFor("free").maxBots, 1);
  assert.equal(entitlementsFor("free").maxProjects, 1);
  assert.equal(entitlementsFor("pro").maxMembers, null);
});
