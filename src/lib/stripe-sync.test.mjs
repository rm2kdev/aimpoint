// node --test src/lib/stripe-sync.test.mjs (VEC-223: Stripe -> org billing mapping)
import { test } from "node:test";
import assert from "node:assert/strict";
import { canceledEndDate, hasLiveSubscription, invoiceSubscriptionId, mergeBilling, periodEnd, subscriptionPatch, subscriptionSeats } from "./stripe-sync.ts";

const T = 1_800_000_000;
const sub = (over = {}) => ({ id: "sub_1", status: "active", customer: "cus_1", items: { data: [{ current_period_end: T }] }, ...over });

test("period end comes from the subscription (old API) or its latest item (basil+)", () => {
  assert.equal(periodEnd(sub()).getTime(), T * 1000);
  assert.equal(periodEnd(sub({ current_period_end: T + 5, items: null })).getTime(), (T + 5) * 1000);
  assert.equal(periodEnd(sub({ items: { data: [{ current_period_end: T }, { current_period_end: T + 9 }] } })).getTime(), (T + 9) * 1000);
  assert.equal(periodEnd(sub({ items: { data: [] } })), null);
});

test("subscription patch maps status, customer, cancel flags; deleted reads canceled", () => {
  const p = subscriptionPatch(sub({ customer: { id: "cus_9" }, cancel_at: T }));
  assert.deepEqual([p.status, p.stripeCustomerId, p.subscriptionId, p.cancelAtPeriodEnd], ["active", "cus_9", "sub_1", true]);
  const d = subscriptionPatch(sub({ cancel_at_period_end: true }), true);
  assert.deepEqual([d.status, d.cancelAtPeriodEnd], ["canceled", false]);
  assert.equal(subscriptionPatch(sub({ status: "weird" })).status, null);
});

test("deleted subscription stores ended_at, not the period end it kept (VEC-231)", () => {
  const now = T - 30 * 86_400; // immediate cancel: ended now, period end a month later
  const d = subscriptionPatch(sub({ status: "canceled", ended_at: now, canceled_at: now }), true);
  assert.equal(d.endedAt.getTime(), now * 1000);
  assert.equal(d.currentPeriodEnd.getTime(), T * 1000);
  const shown = canceledEndDate(d, new Date(now * 1000 + 60_000));
  assert.equal(shown.getTime(), now * 1000);
  // No ended_at: canceled_at stands in on a deleted event.
  assert.equal(subscriptionPatch(sub({ canceled_at: now }), true).endedAt.getTime(), now * 1000);
  // A live subscription has no endedAt (clears it after a resubscribe).
  assert.equal(subscriptionPatch(sub()).endedAt, null);
});

test("cancel at period end shows the period-end date; a future date is never shown", () => {
  const p = subscriptionPatch(sub({ status: "canceled", ended_at: T, canceled_at: T - 86_400 * 20 }), true);
  assert.equal(canceledEndDate(p, new Date(T * 1000 + 1000)).getTime(), T * 1000);
  // Stored before VEC-231 (no endedAt): a past period end is shown, a future one is not.
  const old = { status: "canceled", currentPeriodEnd: new Date(T * 1000) };
  assert.equal(canceledEndDate(old, new Date(T * 1000 + 1000)).getTime(), T * 1000);
  assert.equal(canceledEndDate(old, new Date(T * 1000 - 86_400_000)), null);
  assert.equal(canceledEndDate({ status: "active", currentPeriodEnd: new Date(0) }, new Date()), null);
});

test("pastDueSince is stamped on entry, kept while past_due, cleared after", () => {
  const t1 = new Date(1000), t2 = new Date(2000);
  const a = mergeBilling({ status: "active", stripeCustomerId: "cus_1" }, { status: "past_due" }, t1);
  assert.equal(a.pastDueSince, t1);
  assert.equal(a.stripeCustomerId, "cus_1");
  assert.equal(mergeBilling(a, { status: "past_due" }, t2).pastDueSince, t1);
  assert.equal(mergeBilling(a, { status: "active" }, t2).pastDueSince, null);
});

test("invoice subscription id from parent.subscription_details or the old field", () => {
  assert.equal(invoiceSubscriptionId({ customer: "c", parent: { subscription_details: { subscription: "sub_2" } } }), "sub_2");
  assert.equal(invoiceSubscriptionId({ customer: "c", subscription: { id: "sub_3" } }), "sub_3");
  assert.equal(invoiceSubscriptionId({ customer: "c" }), null);
});

test("live subscription statuses block a second checkout", () => {
  for (const s of ["active", "trialing", "past_due", "unpaid", "paused"]) assert.equal(hasLiveSubscription({ status: s }), true);
  for (const s of ["canceled", "incomplete", "incomplete_expired", null]) assert.equal(hasLiveSubscription({ status: s }), false);
  assert.equal(hasLiveSubscription(undefined), false);
});

test("seats come from the subscription item quantity (VEC-238)", () => {
  assert.equal(subscriptionPatch(sub({ items: { data: [{ id: "si_1", quantity: 4, current_period_end: T }] } })).seats, 4);
  assert.equal(subscriptionSeats(sub({ items: { data: [{ quantity: 2 }, { quantity: 3 }] } })), 5);
  assert.equal(subscriptionSeats(sub()), null, "no quantity on the item");
  assert.equal(subscriptionSeats(sub({ items: null })), null);
  assert.equal(mergeBilling({ seats: 2, status: "active" }, subscriptionPatch(sub({ items: { data: [{ quantity: 3 }] } })), new Date()).seats, 3);
});
