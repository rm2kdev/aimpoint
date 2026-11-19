# Billing: Stripe environments

Aimpoint Pro is US$4.95 per user per month, billed per organisation, with tax added on top. Managed hosting
is paid only: there is no free tier and no trial, and Pro includes everything (unlimited people, bots and
projects, concurrent bot work, Analytics, public forms and public projects). An organisation without a live
subscription (none, cancelled, unpaid, incomplete, paused, or past due for more than 7 days) is locked, not
deleted: members can sign in and see Settings > Billing, admins can subscribe, and everything else is
refused. Rules: `planFor` and `PAST_DUE_GRACE_DAYS` in `src/lib/billing-core.ts`, the lock (`isOrgActive`,
`OrgLockedError`) in `src/lib/billing.ts`.

The Stripe subscription has one
item on the price below, with quantity = billable seats (human members; bots and pending invites don't
count). The app changes the quantity itself as people join or leave (`src/lib/seat-sync.ts`), so the
Customer Portal does not let customers edit it.

Billing is off unless `BILLING_ENABLED=true`. Self-hosted instances leave it unset: free, everything on, no
billing prompts and no Stripe.

No secrets live in this file or anywhere in the repo. Secret keys and webhook signing secrets go only
into the deployment's environment variables.

Set up through the Stripe MCP on 2026-11-18 (VEC-239).

## Staging (Stripe sandbox, test mode)

Staging is https://dev.aimpoint.dev: the `development` branch of rm2kdev/aimpoint on the Vercel project
`aimpoint` (team ryan-s-projects-335ad04d), env vars scoped to Preview + git branch `development`.
Production (https://app.aimpoint.dev, branch `main`) has billing on since 19 Nov 2026 (VEC-259), on the live
Stripe account below (see Production go-live).

| Object | Id |
| --- | --- |
| Account | `acct_1Ud2KoBCR0YJ1Rig` ("Aimpoint sandbox") |
| Product "Aimpoint Pro" | `prod_VeQVjZRNfseHh2` |
| Price (495 USD / month per seat, licensed, lookup key `aimpoint_pro_seat_monthly`) | `price_1Ud7eDBCR0YJ1Rig69Ka9fir` |
| Customer Portal configuration (account default) | `bpc_1Ud7eWBCR0YJ1RigELr7Mq9e` |
| Webhook endpoint (`https://dev.aimpoint.dev/api/stripe/webhook`, created in VEC-251) | `we_1Ud8gbBCR0YJ1Rig007M4JMX` |

## Production (Stripe live mode)

| Object | Id |
| --- | --- |
| Account | `acct_1Ud6YGPkMccAD7nR` ("Aimpoint") |
| Product "Aimpoint Pro" | `prod_VeQVNfCBhrBm0v` |
| Price (495 USD / month per seat, licensed, lookup key `aimpoint_pro_seat_monthly`) | `price_1Ud7eDPkMccAD7nRtmuQvbBM` |
| Customer Portal configuration (account default) | `bpc_1Ud7edPkMccAD7nRPkadm64D` |
| Webhook endpoint (`https://app.aimpoint.dev/api/stripe/webhook`, created in VEC-259) | `we_1UdIRJPkMccAD7nRzXU70IVO` |

Both prices use `tax_behavior: exclusive`, so tax is added on top of US$4.95.

## Tax and Stripe Managed Payments

Stripe Managed Payments (Stripe as merchant of record) is on by default (confirmed in the sandbox) and is
kept on (decided by Ryan in VEC-245). It requires a product tax code, or Checkout refuses to create a
session ("the product tax code is missing"). Both "Aimpoint Pro" products use
`tax_code = txcd_10103001` (Software as a service, business use):

| Environment | Product | Tax code |
| --- | --- | --- |
| Staging (sandbox) | `prod_VeQVjZRNfseHh2` | `txcd_10103001` (set in VEC-241) |
| Production (live) | `prod_VeQVNfCBhrBm0v` | `txcd_10103001` (set in VEC-245) |

Managed Payments adds the customer's local tax on top at Checkout (for example 10% GST for an
Australian address), so the Customer Portal and invoices show the tax-inclusive amount while Aimpoint
shows the pre-tax price marked "plus tax" (`TAX_NOTE` in `src/lib/billing-core.ts`, VEC-270). Any new product must get the same tax code.

## Coupons

Pro Checkout accepts Stripe promotion codes (VEC-311): `checkoutSessionParams` in `src/lib/checkout-core.ts`
sets `allow_promotion_codes: true`, so the Checkout page shows an "Add promotion code" field and Stripe applies
the discount to the subscription. Aimpoint has no coupon admin of its own: coupons and their promotion codes are
created and retired in the Stripe dashboard (Product catalog > Coupons), in the live account for production.
Bots create test coupons in the sandbox only.

Settings > Billing shows the subscription's discount. The subscription webhook stores it on `billing.discount`
(payloads only carry discount ids, so the handler retrieves the subscription with `discounts.source.coupon`
expanded) and a repeating or forever coupon shows as a Discount line with the discounted monthly total. A
`once` coupon only takes the first invoice down: Checkout's first invoice uses it and Stripe removes it from the
subscription, so Billing goes on showing the full price, which is what the next invoice charges.

Sandbox test code (staging, dev.aimpoint.dev, created in VEC-311):

| Object | Id |
| --- | --- |
| Coupon "Aimpoint test 50% (sandbox)" (50% off, duration once) | `HPksd5RM` |
| Promotion code `AIMPOINTTEST50` (active) | `promo_1UdPFLBCR0YJ1Rigv89SdmBJ` |

Use `AIMPOINTTEST50` with test card 4242 4242 4242 4242: the first invoice is US$2.47 plus tax (Stripe rounds the
50% off US$4.95 to US$2.48), then US$4.95 a month.

## Customer Portal

Same configuration in both accounts, and it is the account default, so `billingPortal.sessions.create`
in `src/lib/stripe.ts` uses it without passing a `configuration` id:

- update payment method: on
- invoice history: on
- cancel subscription: on, at period end, no prorations
- update subscription (plan or quantity): off, the app manages seat quantity
- update customer details: off

## Webhook endpoint

Staging and production each have one (VEC-251 and VEC-259, tables above). Any new environment needs its own,
in the matching account:

- URL: `<base>/api/stripe/webhook`
- events: `checkout.session.completed`, `customer.subscription.created`,
  `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`

Its signing secret (`whsec_...`) is shown once on creation and goes into `STRIPE_WEBHOOK_SECRET` for
that environment. Record the endpoint id and URL in the tables above.

app.aimpoint.dev is a production custom domain, so Vercel Deployment Protection doesn't cover it and Stripe
reaches the route directly. dev.aimpoint.dev is a Vercel preview deployment. If Vercel Deployment Protection covers it, Stripe's
deliveries get Vercel's 401/302 instead of reaching the app, so protection has to be off for it or the
endpoint URL has to carry a protection-bypass secret.

## Deleting an organisation

An organisation is only deleted when its sole member deletes their account (`deleteAccount` in
`src/lib/account-deletion.ts`). With billing on, its Stripe subscription is cancelled first, immediately,
with no proration or refund for the period already paid (`cancelSubscriptionForDeletion` in
`src/lib/stripe.ts`, VEC-259): once the org is gone nobody can reach the Customer Portal, so a subscription
left running would keep charging. If Stripe refuses the cancel, the whole account deletion is refused
before anything is removed, so the user can retry. A subscription Stripe no longer has counts as cancelled.
The Stripe customer and its invoices are kept. The `customer.subscription.deleted` event that follows finds
no organisation and is acknowledged as ignored.

## Production go-live (VEC-259)

Done on 19 Nov 2026:

1. Live webhook endpoint `we_1UdIRJPkMccAD7nRzXU70IVO`; its secret went straight into Vercel Production
   `STRIPE_WEBHOOK_SECRET`.
2. `STRIPE_PRICE_ID=price_1Ud7eDPkMccAD7nRtmuQvbBM` in Vercel Production.
3. `STRIPE_SECRET_KEY` = a live key created and pasted by Ryan in the Stripe Dashboard (VEC-279).
4. `BILLING_ENABLED=true` in Vercel Production, `main` redeployed (`dpl_5ZbuwJLesr5BRVUMMT9TvcpSFUWM`).
5. Checked: `POST /api/stripe/webhook` answers 400 to a bad or missing signature and 200 to an event signed
   with the endpoint secret (404 would mean billing is off); Settings > Billing shows US$4.95 per user/month
   plus tax; creating an organisation opens a live (`cs_live_`) Checkout page for Aimpoint Pro at $4.95/month.

To check again later, sign up a throwaway account, create an org (onboarding goes straight to Checkout),
then delete the account from /account. Its Stripe customer is left behind in the live account (the Stripe
MCP can't delete customers); delete it in the Dashboard if it matters.

Turning billing on locks every production organisation without a subscription until an admin subscribes
(nothing is deleted). Vercel's Hobby plan is for non-commercial use only, so the project should move to a
Pro team before it takes payments.

## Environment variables

| Variable | Staging (Vercel Preview, branch `development`) | Production (Vercel Production) |
| --- | --- | --- |
| `BILLING_ENABLED` | `true` | `true` |
| `STRIPE_PRICE_ID` | `price_1Ud7eDBCR0YJ1Rig69Ka9fir` | `price_1Ud7eDPkMccAD7nRtmuQvbBM` |
| `STRIPE_SECRET_KEY` | sandbox secret key `sk_test_...` (Stripe Dashboard, Aimpoint sandbox, Developers > API keys) | live secret key `sk_live_...` (Stripe Dashboard, Aimpoint, Developers > API keys) |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` of the staging webhook endpoint | `whsec_...` of the production webhook endpoint |

Seat sync on Vercel (VEC-291): a join or leave updates the subscription quantity right after the response
(`after()` in `syncSeatsSoon`); a failed update stays in `seatSyncs` and is retried by `/api/cron/wakes`,
which `vercel.json` schedules once a day (the Hobby plan's limit; on a Pro team it can run every few
minutes). The route needs `CRON_SECRET` (set in Production and Preview); without it the route is off.

Because a daily cron could leave a failed update stuck for up to a day, failed rows are also retried by
cheap triggers (VEC-303): every org page load (the `/o/<slug>` layout) and every Stripe webhook call
`sweepSeatSyncsSoon()`, which, after the response and at most once a minute per server instance, retries
the `seatSyncs` rows whose backoff is due (30 s, 1, 2, 5, 15, then every 30 min). So in practice a
failed update is retried within minutes of anyone using the app. With billing off it does nothing. A
row's `lastError` holds the last Stripe error and `[seat sync]` lines in the logs show each attempt
(`quantity 1 -> 2` on success, `failed, will retry` on failure). The logic is in
`src/lib/seat-sync-core.ts`, unit tested in `seat-sync-core.test.mjs` (`pnpm test`).

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
5 s): the paid-only rules (unsubscribed orgs are locked), Checkout, the Customer Portal and `POST /api/stripe/webhook` behave as with
`BILLING_ENABLED`, at US$4.95 per user/month, and Settings > Billing shows a "Test billing (debug)"
banner. A missing variable or a non-test key never stops startup: the Debug tab lists it, the toggle
refuses to turn on, and if it is already on, Checkout/Portal refuse with the reason and the webhook
answers 503. Switching it off returns every organisation to self-hosted (everything on) at once (Billing tab and webhook
404, no Stripe calls); their billing data is kept. The Debug tab is absent (404) for members, without
`AIMPOINT_DEBUG`, and whenever `BILLING_ENABLED` is set, and a stored toggle is ignored then.
