/**
 * Billing rules (VEC-222), pure so `billing-core.test.mjs` runs them under plain `node --test`.
 * Server code imports `@/lib/billing` (UserError wrappers, env checks); this module holds the numbers
 * and the plan logic in one place. No Stripe calls here.
 *
 * Plans (VEC-262): "unlimited" when billing is off (self-hosted), "pro" for a paying org (US$4.95 per user per month,
 * billed per org with the seat count as the Stripe quantity; everything included, no count limits), "unpaid" otherwise.
 * There is no free tier on managed hosting: an unpaid org is locked, not deleted. Members can still sign in and see
 * Settings > Billing, an admin can subscribe there, and everything else is refused (orgAccessMessage). Its data stays
 * and it unlocks the moment a subscription is live.
 */
import type { OrgBilling } from "./types";

export type Plan = "unlimited" | "pro" | "unpaid";

/**
 * What a plan includes. Pro and self-hosted include everything; an unpaid org includes nothing (it's locked), which
 * also keeps its public forms and public project pages unavailable until it subscribes.
 */
export interface Entitlements {
  analytics: boolean;
  publicForms: boolean;
}

export type Feature = "analytics" | "publicForms";

/** Pro's price per seat (a human member) per month, in US cents (VEC-238). */
export const PRO_SEAT_PRICE_CENTS = 495;
/** Prices are pre-tax: Checkout adds the customer's local tax on top (docs/billing.md), so every shown price says so (VEC-270). */
export const TAX_NOTE = "plus tax";
export const PRO_PRICE_LABEL = `US$4.95 per user/month ${TAX_NOTE}`;
/** "US$4.95 per member per month plus tax": the seat price on Settings > Billing, the subscribe screen and onboarding (VEC-416). */
export const PER_MEMBER_PRICE_LABEL = `${usd(PRO_SEAT_PRICE_CENTS)} per member per month ${TAX_NOTE}`;

/** "US$4.95", "US$14.85": a US-cent amount as shown in the UI. */
export function usd(cents: number): string {
  return `US$${(Math.round(cents) / 100).toFixed(2)}`;
}

/**
 * Billable seats (VEC-238): the org's human members, one per distinct userId among its memberships. Bots are
 * not seats (they aren't memberships) and pending invites aren't either until accepted (an accepted invite
 * becomes a membership). Pass the org's membership docs (or just their userIds).
 */
export function billableSeats(memberships: readonly { userId: { toString(): string } | string }[]): number {
  return new Set(memberships.map((m) => String(m.userId))).size;
}

/** The Stripe subscription quantity for `seats`: never below 1 (an org always has its admin). */
export function seatQuantity(seats: number): number {
  return Math.max(1, Math.floor(Number.isFinite(seats) ? seats : 1));
}

/** Monthly Pro total for `seats` seats, in US cents. */
export function proMonthlyCents(seats: number): number {
  return seatQuantity(seats) * PRO_SEAT_PRICE_CENTS;
}

/** "3 seats x US$4.95 = US$14.85/month plus tax". */
export function seatTotalLabel(seats: number): string {
  const n = seatQuantity(seats);
  return `${n} ${n === 1 ? "seat" : "seats"} x ${usd(PRO_SEAT_PRICE_CENTS)} = ${usd(proMonthlyCents(n))}/month ${TAX_NOTE}`;
}

const seatsWord = (n: number) => `${n} ${n === 1 ? "seat" : "seats"}`;

/** What adding or removing people does to the Pro bill (VEC-414), for the invite and remove-member UI. */
export interface SeatChangeCost {
  /** Seats asked to change: +1 for an invite accepted, -1 for a removal. */
  delta: number;
  /** Billed seats before and after the change (both through seatQuantity, so never below 1). */
  currentSeats: number;
  newSeats: number;
  /** Monthly Pro totals before and after, in US cents (pre-tax). */
  currentMonthlyCents: number;
  newMonthlyCents: number;
  /** newMonthlyCents - currentMonthlyCents (negative for a removal, 0 at the 1-seat floor). */
  differenceCents: number;
  /** "US$14.85/month plus tax", "US$19.80/month plus tax". */
  currentLabel: string;
  newLabel: string;
  /** "Adds 1 seat: US$14.85 -> US$19.80/month plus tax, prorated from the day they join". */
  label: string;
}

/**
 * The cost of changing an org from `seats` billed seats by `delta` (VEC-414). Pure: the caller passes the seats Stripe
 * bills now (billedSeatsFor). Stripe prorates quantity changes (`create_prorations`, seat-sync-core), so an added seat
 * is charged from the day the person joins and a removed one is credited from the day they leave. The plan never
 * drops below 1 seat (seatQuantity), so a removal at the floor costs nothing and says so.
 */
export function seatChangeCost({ seats, delta }: { seats: number; delta: number }): SeatChangeCost {
  const d = Math.trunc(Number.isFinite(delta) ? delta : 0);
  const currentSeats = seatQuantity(seats);
  const newSeats = seatQuantity(currentSeats + d);
  const currentMonthlyCents = proMonthlyCents(currentSeats);
  const newMonthlyCents = proMonthlyCents(newSeats);
  const month = (cents: number) => `${usd(cents)}/month ${TAX_NOTE}`;
  const change = `${usd(currentMonthlyCents)} -> ${month(newMonthlyCents)}`;
  let label: string;
  if (newSeats === currentSeats) {
    label = d < 0 ? `Removes ${seatsWord(-d)}: stays ${month(currentMonthlyCents)} (the plan's 1-seat minimum)` : `No change: ${month(currentMonthlyCents)}`;
  } else if (d > 0) {
    label = `Adds ${seatsWord(d)}: ${change}, prorated from the day ${d === 1 ? "they join" : "each person joins"}`;
  } else {
    label = `Removes ${seatsWord(-d)}: ${change}, credited from the day they leave`;
  }
  return {
    delta: d,
    currentSeats,
    newSeats,
    currentMonthlyCents,
    newMonthlyCents,
    differenceCents: newMonthlyCents - currentMonthlyCents,
    currentLabel: month(currentMonthlyCents),
    newLabel: month(newMonthlyCents),
    label,
  };
}

/** Pending invites priced separately (VEC-414): not billed until accepted, so this is what they would add. */
export interface PendingInvitesCost {
  pending: number;
  /** Monthly increase if every pending invite is accepted, in US cents (pre-tax). */
  addCents: number;
  /** "2 pending invites would add US$9.90/month plus tax once accepted", or null with none pending. */
  label: string | null;
}

/**
 * Seat billing for Settings > Members (VEC-414; loaded by `loadMemberBilling`, lib/billing-summary.ts). Null when
 * billing is off (self-hosted, including the VEC-240 Debug toggle switched off), so the invite flow shows no cost.
 * Feed `billedSeats` to seatChangeCost / pendingInvitesCost.
 */
export interface MemberBilling {
  /** Seats Stripe bills now (billedSeatsFor: the webhook's quantity on a live subscription, else the members now). */
  billedSeats: number;
  /** Open (unaccepted, unexpired) invites: not seats until accepted. */
  pendingInvites: number;
  /** A subscription Stripe still bills (active, trialing, past_due, unpaid, paused). False = no charge happens now. */
  liveSubscription: boolean;
}

/** The pure part of loadMemberBilling: null with billing off, else the billed seats and pending invites. */
export function memberBillingFor(input: {
  enabled: boolean;
  plan: Plan;
  liveSubscription: boolean;
  /** Members now (billableSeats). */
  seats: number;
  subscribedSeats: number | null;
  pendingInvites: number;
}): MemberBilling | null {
  if (!input.enabled) return null;
  return {
    billedSeats: billedSeatsFor({ pro: input.plan === "pro", liveSubscription: input.liveSubscription, seats: input.seats, subscribedSeats: input.subscribedSeats }),
    pendingInvites: Math.max(0, Math.floor(input.pendingInvites)),
    liveSubscription: input.liveSubscription,
  };
}

export function pendingInvitesCost({ seats, pending }: { seats: number; pending: number }): PendingInvitesCost {
  const n = Math.max(0, Math.floor(Number.isFinite(pending) ? pending : 0));
  const addCents = seatChangeCost({ seats, delta: n }).differenceCents;
  return {
    pending: n,
    addCents,
    label: n ? `${n} pending ${n === 1 ? "invite" : "invites"} would add ${usd(addCents)}/month ${TAX_NOTE} once accepted` : null,
  };
}

/** A subscription discount as Settings > Billing sees it (VEC-311; OrgBilling.discount with an ISO end date). */
export interface DiscountInfo {
  code: string | null;
  name: string | null;
  percentOff: number | null;
  amountOffCents: number | null;
  currency: string | null;
  duration: string | null;
  durationInMonths: number | null;
  endsAt: string | Date | null;
}

/** Still applies at `now`: no end date, or one in the future. */
export function discountActive(d: DiscountInfo | null | undefined, now: Date): d is DiscountInfo {
  return !!d && (!d.endsAt || new Date(d.endsAt).getTime() > now.getTime());
}

/**
 * The monthly total after a discount that recurs (repeating or forever), in US cents: the percent-off amount rounded
 * like Stripe (50% of US$4.95 takes US$2.48 off, leaving US$2.47), a US-dollar amount off floored at 0. A once coupon only takes one invoice down (Checkout's first, which
 * removes it), and an amount in another currency can't be converted here, so both leave the total as is.
 */
export function discountedMonthlyCents(cents: number, d: DiscountInfo | null | undefined): number {
  if (!d || d.duration === "once") return cents;
  if (d.percentOff) return cents - Math.round((cents * d.percentOff) / 100);
  if (d.amountOffCents && (!d.currency || d.currency.toLowerCase() === "usd")) return Math.max(0, cents - d.amountOffCents);
  return cents;
}

/** "AIMPOINTTEST50: 50% off for 3 months", "US$1.00 off forever", "Launch: 20% off one invoice". */
export function discountLabel(d: DiscountInfo): string {
  const off = d.percentOff
    ? `${d.percentOff}% off`
    : d.amountOffCents
      ? `${!d.currency || d.currency.toLowerCase() === "usd" ? usd(d.amountOffCents) : `${(d.amountOffCents / 100).toFixed(2)} ${d.currency.toUpperCase()}`} off`
      : "discount";
  const span =
    d.duration === "once"
      ? "one invoice"
      : d.duration === "repeating" && d.durationInMonths
        ? `for ${d.durationInMonths} ${d.durationInMonths === 1 ? "month" : "months"}`
        : d.duration === "forever"
          ? "forever"
          : "";
  const who = d.code ?? d.name;
  return `${who ? `${who}: ` : ""}${off}${span ? ` ${span}` : ""}`;
}

/** What Settings > Billing needs to show the seat line (VEC-238, VEC-303). */
export interface SeatLineInput {
  pro: boolean;
  liveSubscription: boolean;
  /** Members now. */
  seats: number;
  /** Quantity Stripe confirmed (stored by the subscription webhook), or null before one landed. */
  subscribedSeats: number | null;
}

/**
 * Seats on the plan line: with a live subscription the quantity Stripe bills (from the webhook); before that, or
 * with none, the people in the org now.
 */
export function billedSeatsFor(b: SeatLineInput): number {
  return (b.pro || b.liveSubscription) && b.subscribedSeats !== null ? b.subscribedSeats : b.seats;
}

/** The seat count Stripe is being updated to ("Updating Stripe to N seats"), or null when Stripe already agrees. */
export function seatsUpdatingTo(b: SeatLineInput): number | null {
  const want = seatQuantity(b.seats);
  return b.pro && b.liveSubscription && b.subscribedSeats !== null && b.subscribedSeats !== want ? want : null;
}

/** How long a past_due subscription keeps Pro while Stripe retries the payment. */
export const PAST_DUE_GRACE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const EVERYTHING: Entitlements = { analytics: true, publicForms: true };
const NOTHING: Entitlements = { analytics: false, publicForms: false };

export const PLAN_ENTITLEMENTS: Record<Plan, Entitlements> = { unlimited: EVERYTHING, pro: EVERYTHING, unpaid: NOTHING };

export const PLAN_LABEL: Record<Plan, string> = { unlimited: "Self-hosted", pro: "Pro", unpaid: "No subscription" };

/**
 * The plan heading on Settings > Billing (VEC-270). A locked org whose Stripe subscription still exists (past_due
 * beyond the grace, unpaid, paused) says what is wrong with that subscription instead of "No subscription".
 */
export function planHeading(plan: Plan, status: OrgBilling["status"] | null | undefined): string {
  if (plan === "unpaid") {
    if (status === "past_due" || status === "unpaid") return "Pro, payment overdue";
    if (status === "paused") return "Pro, paused";
  }
  return PLAN_LABEL[plan];
}

export const STRIPE_ENV_VARS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_ID"] as const;

type Env = Record<string, string | undefined>;

/** `BILLING_ENABLED` on = managed hosting. Unset, empty or anything but 1/true/yes/on = self-hosted, billing off. */
export function billingEnabledIn(env: Env): boolean {
  return ["1", "true", "yes", "on"].includes((env.BILLING_ENABLED ?? "").trim().toLowerCase());
}

/** Stripe vars that must be set when billing is on (empty when billing is off: self-hosters need none). */
export function missingStripeEnv(env: Env): string[] {
  if (!billingEnabledIn(env)) return [];
  return STRIPE_ENV_VARS.filter((name) => !(env[name] ?? "").trim());
}

/**
 * `AIMPOINT_DEBUG` on (1/true/yes/on) AND `BILLING_ENABLED` off = a self-hosted instance where the Settings > Debug
 * billing toggle (VEC-240) exists. With BILLING_ENABLED on (managed hosting) the toggle never applies.
 */
export function debugToggleAvailableIn(env: Env): boolean {
  return ["1", "true", "yes", "on"].includes((env.AIMPOINT_DEBUG ?? "").trim().toLowerCase()) && !billingEnabledIn(env);
}

export type StripeKeyMode = "test" | "live" | "unknown";

/** Test-mode keys start sk_test_ / rk_test_, live ones sk_live_ / rk_live_. */
export function stripeKeyMode(key: string | undefined): StripeKeyMode {
  const k = (key ?? "").trim();
  if (/^(sk|rk)_test_/.test(k)) return "test";
  if (/^(sk|rk)_live_/.test(k)) return "live";
  return "unknown";
}

/**
 * Why debug billing can't use this Stripe config (empty = fine): missing STRIPE_* vars, and any key that isn't a
 * test-mode key, since debug billing must never charge real cards.
 */
export function debugStripeProblems(env: Env): string[] {
  const problems: string[] = [];
  const missing = STRIPE_ENV_VARS.filter((name) => !(env[name] ?? "").trim());
  if (missing.length) problems.push(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set.`);
  if ((env.STRIPE_SECRET_KEY ?? "").trim()) {
    const mode = stripeKeyMode(env.STRIPE_SECRET_KEY);
    if (mode === "live") problems.push("STRIPE_SECRET_KEY is a live key. Debug billing only accepts test-mode keys (sk_test_ or rk_test_).");
    else if (mode === "unknown") problems.push("STRIPE_SECRET_KEY isn't a Stripe test-mode key (sk_test_ or rk_test_).");
  }
  return problems;
}

export function debugBillingError(problems: string[]): string {
  return `Test billing (debug) can't use this Stripe setup: ${problems.join(" ")}`;
}

export function billingConfigError(missing: string[]): string {
  return (
    `Billing is enabled (BILLING_ENABLED) but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set. ` +
    "Set them (see .env.example), or unset BILLING_ENABLED to run self-hosted with every feature on."
  );
}

/**
 * Plan for an org's billing state. Pro while the subscription is active or trialing, and while it is
 * past_due for up to PAST_DUE_GRACE_DAYS (from `pastDueSince`, else from `currentPeriodEnd`). Anything
 * else (no subscription, canceled, unpaid, incomplete, paused, grace over) is "unpaid": the org is locked.
 */
export function planFor(billing: OrgBilling | null | undefined, enabled: boolean, now: Date = new Date()): Plan {
  if (!enabled) return "unlimited";
  const status = billing?.status;
  if (status === "active" || status === "trialing") return "pro";
  if (status === "past_due") {
    const since = billing?.pastDueSince ?? billing?.currentPeriodEnd ?? null;
    if (!since) return "pro";
    return now.getTime() - new Date(since).getTime() <= PAST_DUE_GRACE_DAYS * DAY_MS ? "pro" : "unpaid";
  }
  return "unpaid";
}

/** Whether an org on `plan` can be used at all (everything but Settings > Billing is refused when not). */
export function planActive(plan: Plan): boolean {
  return plan !== "unpaid";
}

export function entitlementsFor(plan: Plan): Entitlements {
  return { ...PLAN_ENTITLEMENTS[plan] };
}

/** Why an unpaid org is locked, as the opening clause of the lock message (from its Stripe subscription status). */
export function unpaidReason(billing: OrgBilling | null | undefined): string {
  switch (billing?.status) {
    case "past_due":
    case "unpaid":
      return "Its last payment failed";
    case "canceled":
      return "Its subscription has ended";
    case "paused":
      return "Its subscription is paused";
    case "incomplete":
    case "incomplete_expired":
      return "Its first payment didn't go through";
    default:
      return "It has no subscription";
  }
}

/**
 * The one answer to "is this org usable" (VEC-262): null when it is, else the message every refused path shows (REST
 * answers 402 with it). Admins are pointed at Settings > Billing to subscribe; members are told to ask an admin.
 * `billing` only sharpens the reason (ended, payment failed); without it the message is generic.
 */
export function orgAccessMessage(plan: Plan, isAdmin: boolean, billing?: OrgBilling | null): string | null {
  if (planActive(plan)) return null;
  const why = billing === undefined ? "It has no active subscription" : unpaidReason(billing);
  const head = `This organisation is locked. ${why}, and Aimpoint's hosted service needs a Pro subscription (${PRO_PRICE_LABEL}).`;
  const tail = isAdmin
    ? "Subscribe in Settings > Billing to unlock it; nothing has been deleted."
    : "Ask an admin to subscribe in Settings > Billing; nothing has been deleted.";
  return `${head} ${tail}`;
}

const FEATURE_NAME: Record<Feature, string> = { analytics: "Analytics isn't", publicForms: "Public forms and public projects aren't" };

/**
 * Message when the plan doesn't include `feature`, or null when it does. Only an unpaid (locked) org lacks a feature,
 * so this is the lock message naming the feature.
 */
export function featureMessage(plan: Plan, feature: Feature, isAdmin = true): string | null {
  if (entitlementsFor(plan)[feature]) return null;
  return `${FEATURE_NAME[feature]} available. ${orgAccessMessage(plan, isAdmin)}`;
}
