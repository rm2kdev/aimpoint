# Billing: Stripe environments

Aimpoint Pro is US$4.95 per user per month, billed per organisation. The Stripe subscription has one
item on the price below, with quantity = billable seats (human members; bots and pending invites don't
count). The app changes the quantity itself as people join or leave (`src/lib/seat-sync.ts`), so the
Customer Portal does not let customers edit it.

Billing is off unless `BILLING_ENABLED=true`. Self-hosted instances leave it unset and need no Stripe.

No secrets live in this file or anywhere in the repo. Secret keys and webhook signing secrets go only
into the deployment's environment variables.

Set up through the Stripe MCP on 2026-11-18 (VEC-239).

## Staging (Stripe sandbox, test mode)

| Object | Id |
| --- | --- |
| Account | `acct_1Ud2KoBCR0YJ1Rig` ("Aimpoint sandbox") |
| Product "Aimpoint Pro" | `prod_VeQVjZRNfseHh2` |
| Price (495 USD / month per seat, licensed, lookup key `aimpoint_pro_seat_monthly`) | `price_1Ud7eDBCR0YJ1Rig69Ka9fir` |
| Customer Portal configuration (account default) | `bpc_1Ud7eWBCR0YJ1RigELr7Mq9e` |
| Webhook endpoint | not created yet: no staging deployment exists (see below) |

## Production (Stripe live mode)

| Object | Id |
| --- | --- |
| Account | `acct_1Ud6YGPkMccAD7nR` ("Aimpoint") |
| Product "Aimpoint Pro" | `prod_VeQVNfCBhrBm0v` |
| Price (495 USD / month per seat, licensed, lookup key `aimpoint_pro_seat_monthly`) | `price_1Ud7eDPkMccAD7nRtmuQvbBM` |
| Customer Portal configuration (account default) | `bpc_1Ud7edPkMccAD7nRPkadm64D` |
| Webhook endpoint | not created yet: no production deployment exists (see below) |

Both prices use `tax_behavior: exclusive` (tax, if Stripe Tax is ever turned on, is added on top of
US$4.95).

## Customer Portal

Same configuration in both accounts, and it is the account default, so `billingPortal.sessions.create`
in `src/lib/stripe.ts` uses it without passing a `configuration` id:

- update payment method: on
- invoice history: on
- cancel subscription: on, at period end, no prorations
- update subscription (plan or quantity): off, the app manages seat quantity
- update customer details: off

## Webhook endpoint (to do once a deployment exists)

When a staging or production URL exists, create an endpoint in the matching account:

- URL: `<base>/api/stripe/webhook`
- events: `checkout.session.completed`, `customer.subscription.created`,
  `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`

Its signing secret (`whsec_...`) is shown once on creation and goes into `STRIPE_WEBHOOK_SECRET` for
that environment. Record the endpoint id and URL in the tables above.

As of VEC-239 there is no Aimpoint project on Vercel (checked both teams through the Vercel MCP) and
`aimpoint.dev` does not resolve, so no endpoint was created and no Vercel env vars were set.

## Environment variables

| Variable | Staging (Vercel Preview) | Production (Vercel Production) |
| --- | --- | --- |
| `BILLING_ENABLED` | `true` | `true` |
| `STRIPE_PRICE_ID` | `price_1Ud7eDBCR0YJ1Rig69Ka9fir` | `price_1Ud7eDPkMccAD7nRtmuQvbBM` |
| `STRIPE_SECRET_KEY` | sandbox secret key `sk_test_...` (Stripe Dashboard, Aimpoint sandbox, Developers > API keys) | live secret key `sk_live_...` (Stripe Dashboard, Aimpoint, Developers > API keys) |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` of the staging webhook endpoint | `whsec_...` of the production webhook endpoint |

The Stripe MCP cannot reveal secret keys, so `STRIPE_SECRET_KEY` has to be pasted from the Dashboard
by hand. With `BILLING_ENABLED=true` the server refuses to start
until all three `STRIPE_*` variables are set.

For local testing against the sandbox, put the staging values in `.env.local` and forward events with
`stripe listen --forward-to localhost:3200/api/stripe/webhook` (its printed `whsec_...` is the local
`STRIPE_WEBHOOK_SECRET`).

## Test billing on a self-hosted instance (debug toggle)

To try billing on a self-hosted instance without redeploying (VEC-240):

1. Leave `BILLING_ENABLED` unset and set `AIMPOINT_DEBUG=1`.
2. Set the three `STRIPE_*` variables with the **staging** (sandbox) values above. Only test-mode keys
   (`sk_test_` / `rk_test_`) are accepted; a live key is refused. `STRIPE_API_BASE` can point at
   stripe-mock instead of Stripe.
3. Restart once so the server sees the env, then as an org admin open Settings > Debug and switch
   **Test billing** on.

It applies to the whole instance straight away (stored in MongoDB `instanceSettings`, re-read every
5 s): plans, limits, Checkout, the Customer Portal and `POST /api/stripe/webhook` behave as with
`BILLING_ENABLED`, at US$4.95 per user/month, and Settings > Billing shows a "Test billing (debug)"
banner. A missing variable or a non-test key never stops startup: the Debug tab lists it, the toggle
refuses to turn on, and if it is already on, Checkout/Portal refuse with the reason and the webhook
answers 503. Switching it off returns every organisation to unlimited at once (Billing tab and webhook
404, no Stripe calls); their billing data is kept. The Debug tab is absent (404) for members, without
`AIMPOINT_DEBUG`, and whenever `BILLING_ENABLED` is set, and a stored toggle is ignored then.
