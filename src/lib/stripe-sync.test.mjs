// node --test src/lib/stripe-sync.test.mjs (VEC-223: Stripe -> org billing mapping)
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasLiveSubscription, invoiceSubscriptionId, mergeBilling, periodEnd, subscriptionPatch } from "./stripe-sync.ts";

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
