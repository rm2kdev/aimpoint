/**
 * The Pro Checkout session parameters (VEC-311), pure so `checkout-core.test.mjs` runs them under plain
 * `node --test`. `createCheckoutSession` in lib/stripe.ts does the I/O (customer, seat count, Stripe call).
 */
import type Stripe from "stripe";

export interface CheckoutInput {
  customer: string;
  orgId: string;
  priceId: string;
  /** Billable seats now (min 1, seatQuantity). */
  quantity: number;
  successUrl: string;
  cancelUrl: string;
}

/**
 * A subscription-mode session for Pro: one item on the per-seat price with quantity = seats, the org id on the
 * session and the subscription, and the "Add promotion code" field (coupons are managed in the Stripe dashboard,
 * docs/billing.md > Coupons).
 */
export function checkoutSessionParams(i: CheckoutInput): Stripe.Checkout.SessionCreateParams {
  return {
    mode: "subscription",
    customer: i.customer,
    client_reference_id: i.orgId,
    line_items: [{ price: i.priceId, quantity: i.quantity }],
    allow_promotion_codes: true,
    metadata: { orgId: i.orgId },
    subscription_data: { metadata: { orgId: i.orgId } },
    success_url: i.successUrl,
    cancel_url: i.cancelUrl,
  };
}
