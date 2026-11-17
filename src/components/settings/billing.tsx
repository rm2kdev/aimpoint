"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangleIcon, CheckIcon, CreditCardIcon, ExternalLinkIcon, LoaderIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { useOrg } from "@/components/org-provider";
import { SettingsRow, Tag } from "@/components/settings/ui";
import { Button } from "@/components/ui/button";
import { openBillingPortal, startCheckout } from "@/app/actions/billing";
import { countNoun, PLAN_INCLUDES, PLAN_LABEL, PRO_PRICE_LABEL, proMonthlyCents, seatTotalLabel, usd, type BillingSummary, type CountKind } from "@/lib/billing-view";
import { billingPath } from "@/lib/paths";
import { cn } from "@/lib/utils";

type Checkout = "success" | "cancelled" | null;

/** "18 December 2026" in the viewer's analytics timezone (the server passes it, so SSR and hydration agree). */
function formatDate(iso: string | null, tz: string): string | null {
  if (!iso) return null;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: tz }).format(new Date(iso));
}

/** The one-line state of the subscription under the plan name, plus whether it is a warning. */
function describe(b: BillingSummary, tz: string): { text: string; warn?: boolean } {
  const end = formatDate(b.currentPeriodEnd, tz);
  switch (b.status) {
    case "active":
      if (b.cancelAtPeriodEnd)
        return { text: `Cancels on ${end ?? "the end of the billing period"}. The organisation moves to Free then; nothing is deleted.` };
      return { text: end ? `Renews on ${end}.` : "Active." };
    case "trialing":
      return { text: end ? `Trial ends on ${end}.` : "On a trial." };
    case "past_due": {
      if (b.plan === "pro") {
        const grace = formatDate(b.graceEndsAt, tz);
        return {
          warn: true,
          text: `The last payment failed. Pro stays on${grace ? ` until ${grace}` : ""} while Stripe retries; update the card in Manage billing to keep it.`,
        };
      }
      return { warn: true, text: "Payment is overdue, so the organisation is on Free until it's paid. Update the card in Manage billing." };
    }
    case "unpaid":
      return { warn: true, text: "The subscription is unpaid, so the organisation is on Free. Pay the open invoice in Manage billing." };
    case "paused":
      return { text: "The subscription is paused, so the organisation is on Free. Resume it in Manage billing." };
    case "incomplete":
      return { warn: true, text: "The first payment didn't go through. Subscribe again to finish upgrading." };
    case "canceled": {
      // endedAt, not the period end: an immediate cancel keeps a period end a month out (VEC-231).
      const ended = formatDate(b.endedAt, tz);
      return { text: ended ? `The Pro subscription ended on ${ended}.` : "The Pro subscription has ended." };
    }
    default:
      return { text: `Free for 1 person, 1 bot and 1 project. Upgrade to Pro for ${PRO_PRICE_LABEL}.` };
  }
}

/** After Checkout: "confirming" until the webhook makes the org Pro (org.changed refreshes it), then "thanks". */
function CheckoutBanner({ checkout, pro }: { checkout: Exclude<Checkout, null>; pro: boolean }) {
  const { org } = useOrg();
  const router = useRouter();
  const waiting = checkout === "success" && !pro;
  // The webhook's org.changed refreshes the page live; also re-check now and then in case that event was missed.
  useEffect(() => {
    if (!waiting) return;
    let n = 0;
    const t = setInterval(() => {
      if (++n > 15) return clearInterval(t);
      router.refresh();
    }, 4000);
    return () => clearInterval(t);
  }, [waiting, router]);
  const dismiss = () => router.replace(billingPath(org.slug), { scroll: false });
  const text =
    checkout === "cancelled"
      ? "Checkout was cancelled. Nothing was charged."
      : pro
        ? "You're on Pro. Thanks for subscribing."
        : "Payment received. Confirming it with Stripe; this page updates by itself.";
  return (
    <div
      role="status"
      data-checkout-banner={checkout === "cancelled" ? "cancelled" : pro ? "done" : "waiting"}
      className="mb-6 flex items-center gap-2.5 rounded-lg border border-border bg-sidebar px-3.5 py-2.5 text-[13px]"
    >
      {waiting ? (
        <LoaderIcon className="size-3.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
      ) : checkout === "success" ? (
        <CheckIcon className="size-3.5 shrink-0" />
      ) : null}
      <span className="min-w-0 flex-1">{text}</span>
      <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={dismiss}>
        <XIcon />
      </Button>
    </div>
  );
}

function UsageRow({ kind, b, label }: { kind: CountKind; b: BillingSummary; label: string }) {
  const used = b.usage[kind];
  const limit = b.limits[kind];
  const over = limit !== null && used > limit;
  const full = limit !== null && used >= limit;
  const extra =
    kind === "members" && b.usage.pendingInvites
      ? `incl. ${b.usage.pendingInvites} pending invite${b.usage.pendingInvites === 1 ? "" : "s"}`
      : kind === "projects" && b.usage.archivedProjects
        ? `incl. ${b.usage.archivedProjects} archived`
        : null;
  return (
    <li className="flex items-center gap-3 px-3.5 py-2.5" data-usage={kind}>
      <span className="min-w-0 flex-1 text-[13.5px]">
        {label}
        {extra && <span className="ml-1.5 text-[12.5px] text-faint">{extra}</span>}
      </span>
      {limit !== null && (
        <span className="hidden h-1.5 w-24 overflow-hidden rounded-full bg-chip sm:block" aria-hidden>
          <span className={cn("block h-full rounded-full", over ? "bg-destructive" : "bg-foreground/70")} style={{ width: `${Math.min(100, (used / limit) * 100)}%` }} />
        </span>
      )}
      <span className={cn("tabular w-28 text-right text-[13px]", over ? "text-destructive" : full ? "text-foreground" : "text-muted-foreground")}>
        {limit === null ? `${used} ${countNoun(kind, used)}` : `${used} of ${limit}`}
      </span>
    </li>
  );
}

/** Seats x price = monthly total, and that the bill follows the member count (VEC-238). */
function SeatsNote({ b, pro, billedSeats }: { b: BillingSummary; pro: boolean; billedSeats: number }) {
  const people = `${b.seats} ${b.seats === 1 ? "person" : "people"}`;
  const syncing = pro && b.liveSubscription && b.subscribedSeats !== null && b.subscribedSeats !== Math.max(1, b.seats);
  return (
    <p className="mt-1.5 text-[13px] text-muted-foreground" data-billing-seats={billedSeats}>
      <span className="tabular text-foreground">{seatTotalLabel(billedSeats)}</span>
      {pro
        ? ". Adding or removing people changes the bill; Stripe prorates the difference."
        : `, for the ${people} in this organisation now. Adding people later changes the bill.`}
      {syncing && <span className="block text-[12.5px] text-faint">Updating Stripe to {seatTotalLabel(b.seats)}.</span>}
    </p>
  );
}

function PlanCard({ plan, current }: { plan: "free" | "pro"; current: boolean }) {
  return (
    <div className={cn("rounded-[10px] border px-4 py-3.5", current ? "border-foreground/40" : "border-border")} data-plan-card={plan}>
      <div className="flex items-center gap-2">
        <h3 className="text-[13.5px] font-semibold">{PLAN_LABEL[plan]}</h3>
        {current && <Tag>Current</Tag>}
        <span className="ml-auto text-[13px] text-muted-foreground">{plan === "pro" ? PRO_PRICE_LABEL : "US$0"}</span>
      </div>
      <ul className="mt-2.5 grid gap-1.5 text-[13px]">
        {PLAN_INCLUDES[plan].map((line) => {
          const missing = line.startsWith("No ");
          return (
            <li key={line} className={cn("flex items-center gap-2", missing ? "text-faint" : "text-muted-foreground")}>
              {missing ? <XIcon className="size-3.5 shrink-0" /> : <CheckIcon className="size-3.5 shrink-0" />}
              {line}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Settings > Billing (VEC-226). Reads the plan from the org context, so a webhook's org.changed updates it live. */
export function BillingSettings({ checkout, tz }: { checkout: Checkout; tz: string }) {
  const { org, isAdmin, billing: b } = useOrg();
  const [pending, start] = useTransition();
  const [going, setGoing] = useState<"checkout" | "portal" | null>(null);
  const pro = b.plan === "pro";
  const state = describe(b, tz);
  // On Pro, the quantity Stripe bills (from the webhook); before that, or on Free, the people in the org now.
  const billedSeats = pro && b.subscribedSeats !== null ? b.subscribedSeats : b.seats;
  const over = (["members", "bots", "projects"] as const).some((k) => b.limits[k] !== null && b.usage[k] > b.limits[k]!);

  const go = (which: "checkout" | "portal") =>
    start(async () => {
      setGoing(which);
      const r = await (which === "checkout" ? startCheckout(org.slug) : openBillingPortal(org.slug));
      if (!r.ok || !r.data) {
        setGoing(null);
        return void toast.error(!r.ok ? r.error : "Couldn't reach Stripe. Try again.");
      }
      window.location.assign(r.data.url);
    });

  return (
    <>
      {checkout && <CheckoutBanner checkout={checkout} pro={pro} />}
      <div>
        <SettingsRow
          title="Plan"
          desc={
            <>
              Pro is {PRO_PRICE_LABEL}, billed per organisation: each person in it is a seat (bots and pending invites aren&rsquo;t). Payments, invoices and cancelling go through Stripe.
            </>
          }
        >
          <div className="grid max-w-2xl gap-3" data-billing-plan={b.plan} data-billing-status={b.status ?? "none"}>
            <div className="rounded-[10px] border border-border px-4 py-3.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[15px] font-semibold">{PLAN_LABEL[b.plan]}</span>
                {pro && b.cancelAtPeriodEnd && <Tag>Cancelling</Tag>}
                {b.status === "past_due" && (
                  <span className="rounded-[4px] bg-destructive/10 px-1.5 py-px text-[11.5px] font-medium text-destructive-ink">Payment failed</span>
                )}
                <span className="tabular ml-auto text-[13px] text-muted-foreground" data-billing-total>{pro ? `${usd(proMonthlyCents(billedSeats))}/month` : "US$0"}</span>
              </div>
              <p
                data-billing-note={state.warn ? "warning" : "info"}
                className={cn(
                  "mt-1.5 text-[13px]",
                  state.warn ? "flex items-start gap-2 rounded-md bg-destructive/10 px-2.5 py-2 text-destructive-ink" : "text-muted-foreground",
                )}
              >
                {state.warn && <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />}
                {state.text}
              </p>
              <SeatsNote b={b} pro={pro} billedSeats={billedSeats} />
              {isAdmin ? (
                <div className="mt-3.5 flex flex-wrap gap-2">
                  {/* Hidden while a finished Checkout waits for its webhook, so nobody pays twice. */}
                  {!b.liveSubscription && !(checkout === "success" && !pro) && (
                    <Button onClick={() => go("checkout")} disabled={pending} className="gap-2" data-billing-action="checkout">
                      {going === "checkout" ? <LoaderIcon className="size-3.5 animate-spin" /> : <CreditCardIcon className="size-3.5" />}
                      {b.status === "canceled" ? "Subscribe again" : `Upgrade to Pro, ${PRO_PRICE_LABEL}`}
                    </Button>
                  )}
                  {b.hasCustomer && (
                    <Button variant={b.liveSubscription ? "default" : "outline"} onClick={() => go("portal")} disabled={pending} className="gap-2" data-billing-action="portal">
                      {going === "portal" ? <LoaderIcon className="size-3.5 animate-spin" /> : <ExternalLinkIcon className="size-3.5" />}
                      Manage billing
                    </Button>
                  )}
                </div>
              ) : (
                <p className="mt-3 text-[12.5px] text-faint">Only an admin can change the plan or billing details.</p>
              )}
            </div>
          </div>
        </SettingsRow>

        <SettingsRow
          title="Usage"
          desc={pro ? "Pro has no limits on people, bots or projects." : "What this organisation has against the Free plan's limits. Pending invites and archived projects count."}
        >
          <ul className="max-w-2xl divide-y divide-border rounded-[10px] border border-border" aria-label="Usage">
            <UsageRow kind="members" b={b} label="People" />
            <UsageRow kind="bots" b={b} label="Bots" />
            <UsageRow kind="projects" b={b} label="Projects" />
          </ul>
          {over && (
            <p className="mt-2 max-w-2xl text-[12.5px] text-muted-foreground" data-over-limit>
              This organisation has more than Free includes. Everything it already has stays, but nothing more can be added until it&rsquo;s within the limits or on Pro.
            </p>
          )}
        </SettingsRow>

        <SettingsRow title="Plans" desc="Every organisation starts on Free. Pro unlocks everything for the whole organisation.">
          <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
            <PlanCard plan="free" current={b.plan === "free"} />
            <PlanCard plan="pro" current={pro} />
          </div>
        </SettingsRow>
      </div>
    </>
  );
}
