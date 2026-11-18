// Run with `pnpm test` (node --test; Node strips the TypeScript types of billing-core.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planFor,
  entitlementsFor,
  billingEnabledIn,
  debugToggleAvailableIn,
  stripeKeyMode,
  debugStripeProblems,
  debugBillingError,
  missingStripeEnv,
  billingConfigError,
  featureMessage,
  orgAccessMessage,
  planActive,
  unpaidReason,
  PLAN_LABEL,
  planHeading,
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

const NONE = { analytics: false, publicForms: false };
const ALL = { analytics: true, publicForms: true };


test("billing disabled (self-hosted): every org is unlimited and usable, whatever its billing state", () => {
  for (const billing of [undefined, null, {}, { status: "canceled" }, { status: "past_due", pastDueSince: ago(90) }, { status: "active" }]) {
    assert.equal(planFor(billing, false, NOW), "unlimited");
  }
  assert.deepEqual(entitlementsFor("unlimited"), ALL);
  assert.equal(planActive("unlimited"), true);
  assert.equal(orgAccessMessage("unlimited", false), null);
});

test("billing enabled, no subscription: unpaid (locked), no free tier", () => {
  assert.equal(planFor(undefined, true, NOW), "unpaid");
  assert.equal(planFor(null, true, NOW), "unpaid");
  assert.equal(planFor({}, true, NOW), "unpaid");
  assert.equal(planFor({ stripeCustomerId: "cus_1", status: null }, true, NOW), "unpaid");
  assert.deepEqual(entitlementsFor("unpaid"), NONE);
  assert.equal(planActive("unpaid"), false);
});

test("active and trialing are Pro (incl. cancel at period end until Stripe cancels)", () => {
  assert.equal(planFor({ status: "active", currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY) }, true, NOW), "pro");
  assert.equal(planFor({ status: "active", cancelAtPeriodEnd: true }, true, NOW), "pro");
  assert.equal(planFor({ status: "trialing" }, true, NOW), "pro");
  assert.deepEqual(entitlementsFor("pro"), ALL);
  assert.equal(planActive("pro"), true);
  assert.equal(orgAccessMessage("pro", true), null);
});

test("past_due keeps Pro within the 7-day grace period, then locks", () => {
  assert.equal(PAST_DUE_GRACE_DAYS, 7);
  assert.equal(planFor({ status: "past_due", pastDueSince: ago(1) }, true, NOW), "pro");
  assert.equal(planFor({ status: "past_due", pastDueSince: ago(PAST_DUE_GRACE_DAYS) }, true, NOW), "pro");
  assert.equal(planFor({ status: "past_due", pastDueSince: ago(PAST_DUE_GRACE_DAYS + 0.01) }, true, NOW), "unpaid");
  // No pastDueSince: counts from currentPeriodEnd; neither date: still Pro (the webhook hasn't stamped it yet).
  assert.equal(planFor({ status: "past_due", currentPeriodEnd: ago(2) }, true, NOW), "pro");
  assert.equal(planFor({ status: "past_due", currentPeriodEnd: ago(30) }, true, NOW), "unpaid");
  assert.equal(planFor({ status: "past_due" }, true, NOW), "pro");
  // Dates may arrive as strings (JSON); still resolved.
  assert.equal(planFor({ status: "past_due", pastDueSince: ago(1).toISOString() }, true, NOW), "pro");
  assert.equal(planFor({ status: "past_due", pastDueSince: ago(8).toISOString() }, true, NOW), "unpaid");
});

test("canceled, unpaid, incomplete, paused are unpaid (locked)", () => {
  for (const status of ["canceled", "unpaid", "incomplete", "incomplete_expired", "paused"]) {
    assert.equal(planFor({ status, currentPeriodEnd: new Date(NOW.getTime() + 5 * DAY) }, true, NOW), "unpaid", status);
  }
});

test("entitlementsFor returns a copy", () => {
  const e = entitlementsFor("pro");
  e.analytics = false;
  assert.equal(entitlementsFor("pro").analytics, true);
});

test("no Free plan anywhere", () => {
  assert.deepEqual(Object.keys(PLAN_LABEL).sort(), ["pro", "unlimited", "unpaid"]);
  for (const plan of ["pro", "unpaid", "unlimited"]) {
    for (const feature of ["analytics", "publicForms"]) assert.doesNotMatch(featureMessage(plan, feature) ?? "", /\bFree\b/);
    for (const admin of [true, false]) assert.doesNotMatch(orgAccessMessage(plan, admin) ?? "", /\bFree\b/);
  }
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

test("lock message: admins subscribe in Settings > Billing, members ask an admin", () => {
  const admin = orgAccessMessage("unpaid", true);
  assert.match(admin, /^This organisation is locked\./);
  assert.match(admin, /Pro subscription \(US\$4\.95 per user\/month plus tax\)/);
  assert.match(admin, /Subscribe in Settings > Billing to unlock it; nothing has been deleted\./);
  const member = orgAccessMessage("unpaid", false);
  assert.match(member, /Ask an admin to subscribe in Settings > Billing/);
  assert.doesNotMatch(member, /^.*Subscribe in Settings/);
  // The billing state sharpens the reason.
  assert.match(orgAccessMessage("unpaid", true, null), /It has no subscription,/);
  assert.match(orgAccessMessage("unpaid", true, { status: "canceled" }), /Its subscription has ended,/);
  assert.match(orgAccessMessage("unpaid", true, { status: "past_due", pastDueSince: ago(9) }), /Its last payment failed,/);
  assert.match(orgAccessMessage("unpaid", false, { status: "unpaid" }), /Its last payment failed,/);
  assert.match(orgAccessMessage("unpaid", true, { status: "paused" }), /paused/);
  assert.match(orgAccessMessage("unpaid", true, { status: "incomplete_expired" }), /first payment didn't go through/);
  assert.equal(unpaidReason(undefined), "It has no subscription");
});

test("feature messages: only an unpaid org lacks Analytics and Public forms, with the lock message", () => {
  assert.match(featureMessage("unpaid", "analytics"), /^Analytics isn't available\. This organisation is locked\..*Subscribe in Settings > Billing/);
  assert.match(featureMessage("unpaid", "publicForms", false), /^Public forms and public projects aren't available\..*Ask an admin/);
  for (const plan of ["pro", "unlimited"]) {
    assert.equal(featureMessage(plan, "analytics"), null);
    assert.equal(featureMessage(plan, "publicForms"), null);
  }
});

test("per-seat price (VEC-238): US$4.95 per user per month", () => {
  assert.equal(PRO_SEAT_PRICE_CENTS, 495);
  assert.equal(PRO_PRICE_LABEL, "US$4.95 per user/month plus tax");
  assert.equal(usd(495), "US$4.95");
  assert.equal(usd(1485), "US$14.85");
  assert.equal(usd(0), "US$0.00");
  assert.equal(proMonthlyCents(3), 1485);
  assert.equal(proMonthlyCents(0), 495, "billed for at least one seat");
  assert.equal(seatTotalLabel(1), "1 seat x US$4.95 = US$4.95/month plus tax");
  assert.equal(seatTotalLabel(12), "12 seats x US$4.95 = US$59.40/month plus tax");
});

test("plan heading (VEC-270): a locked org with a live subscription isn't 'No subscription'", () => {
  assert.equal(planHeading("pro", "active"), "Pro");
  assert.equal(planHeading("pro", "past_due"), "Pro");
  assert.equal(planHeading("unlimited", null), "Self-hosted");
  assert.equal(planHeading("unpaid", "past_due"), "Pro, payment overdue");
  assert.equal(planHeading("unpaid", "unpaid"), "Pro, payment overdue");
  assert.equal(planHeading("unpaid", "paused"), "Pro, paused");
  for (const s of [null, undefined, "canceled", "incomplete", "incomplete_expired"]) assert.equal(planHeading("unpaid", s), "No subscription", String(s));
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

test("debug toggle (VEC-240) only exists with AIMPOINT_DEBUG on and BILLING_ENABLED off", () => {
  assert.equal(debugToggleAvailableIn({}), false);
  assert.equal(debugToggleAvailableIn({ AIMPOINT_DEBUG: "0" }), false);
  for (const v of ["1", "true", " yes ", "ON"]) assert.equal(debugToggleAvailableIn({ AIMPOINT_DEBUG: v }), true, v);
  assert.equal(debugToggleAvailableIn({ AIMPOINT_DEBUG: "1", BILLING_ENABLED: "true" }), false);
  assert.equal(debugToggleAvailableIn({ AIMPOINT_DEBUG: "1", BILLING_ENABLED: "false" }), true);
  // Debug never makes the startup check demand Stripe vars.
  assert.deepEqual(missingStripeEnv({ AIMPOINT_DEBUG: "1" }), []);
});

test("Stripe key modes", () => {
  assert.equal(stripeKeyMode("sk_test_abc"), "test");
  assert.equal(stripeKeyMode(" rk_test_abc "), "test");
  assert.equal(stripeKeyMode("sk_live_abc"), "live");
  assert.equal(stripeKeyMode("rk_live_abc"), "live");
  assert.equal(stripeKeyMode("pk_test_abc"), "unknown");
  assert.equal(stripeKeyMode(""), "unknown");
  assert.equal(stripeKeyMode(undefined), "unknown");
});

test("debug billing accepts only a complete test-mode Stripe setup", () => {
  const ok = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", STRIPE_PRICE_ID: "price_x" };
  assert.deepEqual(debugStripeProblems(ok), []);
  assert.deepEqual(debugStripeProblems({ ...ok, STRIPE_SECRET_KEY: "rk_test_x" }), []);
  const live = debugStripeProblems({ ...ok, STRIPE_SECRET_KEY: "sk_live_x" });
  assert.equal(live.length, 1);
  assert.match(live[0], /live key/);
  assert.match(debugStripeProblems({ ...ok, STRIPE_SECRET_KEY: "pk_test_x" })[0], /test-mode/);
  const missing = debugStripeProblems({ STRIPE_SECRET_KEY: "sk_test_x" });
  assert.deepEqual(missing, ["STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID are not set."]);
  assert.match(debugStripeProblems({})[0], /STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID are not set/);
  assert.match(debugBillingError(live), /^Test billing \(debug\) can't use this Stripe setup: STRIPE_SECRET_KEY is a live key/);
});
