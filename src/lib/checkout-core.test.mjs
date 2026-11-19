// Run with `pnpm test` (node --test; Node strips the TypeScript types of checkout-core.ts).
// VEC-311: Pro Checkout accepts Stripe promotion codes; the rest of the session is unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkoutSessionParams } from "./checkout-core.ts";

const input = {
  customer: "cus_1",
  orgId: "org1",
  priceId: "price_seat",
  quantity: 3,
  successUrl: "https://app.example/o/acme/settings/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}",
  cancelUrl: "https://app.example/o/acme/settings/billing?checkout=cancelled",
};

test("Checkout session allows promotion codes", () => {
  assert.equal(checkoutSessionParams(input).allow_promotion_codes, true);
});

test("Checkout session keeps seats, metadata and return URLs", () => {
  assert.deepEqual(checkoutSessionParams(input), {
    mode: "subscription",
    customer: "cus_1",
    client_reference_id: "org1",
    line_items: [{ price: "price_seat", quantity: 3 }],
    allow_promotion_codes: true,
    metadata: { orgId: "org1" },
    subscription_data: { metadata: { orgId: "org1" } },
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  });
});
