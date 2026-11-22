"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CreditCardIcon, ExternalLinkIcon, LoaderIcon, LockIcon, LogOutIcon } from "lucide-react";
import { toast } from "sonner";
import { useOrg } from "@/components/org-provider";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/logo";
import { logoutAction } from "@/app/actions/auth";
import { openBillingPortal, startCheckout } from "@/app/actions/billing";
import { PER_MEMBER_PRICE_LABEL, seatTotalLabel, SELF_HOST_URL, type BillingSummary } from "@/lib/billing-view";
import { billingPath, orgPath } from "@/lib/paths";

/** Why the org is locked, one sentence (the Billing page has the full state). */
function lockReason(b: BillingSummary, org: string): string {
  switch (b.status) {
    case "canceled":
      return `The Pro subscription for ${org} has ended.`;
    case "past_due":
    case "unpaid":
      return `The last payment for ${org} failed.`;
    case "paused":
      return `The subscription for ${org} is paused.`;
    case "incomplete":
    case "incomplete_expired":
      return `The first payment for ${org} didn't go through.`;
    default:
      return `${org} doesn't have a subscription yet.`;
  }
}

/**
 * Paid-only hosting (VEC-264): an org with no live subscription sees this full-page screen in place of the app.
 * Settings > Billing (and Settings > Debug where the debug billing toggle lives) stay reachable inside the normal
 * shell. Billing off (self-hosted) is never locked, so this never renders there. `?checkout=success|cancelled`
 * is Stripe Checkout's return from onboarding or this screen.
 */
export function SubscribeGate({ children }: { children: React.ReactNode }) {
  const { org, billing } = useOrg();
  const pathname = usePathname();
  const open =
    !billing.locked ||
    pathname.startsWith(billingPath(org.slug)) ||
    (billing.debugAvailable && pathname.startsWith(orgPath(org.slug, "settings", "debug")));
  return (
    <>
      <CheckoutReturned locked={billing.locked} />
      {open ? children : <SubscribeScreen />}
    </>
  );
}

/** Back from a Checkout that unlocked the org (or was unlocked by the time it returned): say so once, drop the query. */
function CheckoutReturned({ locked }: { locked: boolean }) {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const done = !locked && params.get("checkout") === "success" && !pathname.includes("/settings/billing");
  useEffect(() => {
    if (!done) return;
    // Fixed id: the effect can run twice before the query is dropped (dev Strict Mode), which stacked two toasts.
    toast.success("You're on Pro. Thanks for subscribing.", { id: "checkout-success" });
    router.replace(pathname, { scroll: false });
  }, [done, pathname, router]);
  return null;
}

function SubscribeScreen() {
  const { org, orgs, isAdmin, members, billing: b } = useOrg();
  const router = useRouter();
  const params = useSearchParams();
  const checkout = params.get("checkout");
  const [pending, start] = useTransition();
  const [going, setGoing] = useState(false);
  // Back from a paid Checkout: the webhook unlocks the org (org.changed refreshes the layout); re-check now and
  // then in case that event was missed.
  const waiting = checkout === "success";
  useEffect(() => {
    if (!waiting) return;
    let n = 0;
    const t = setInterval(() => {
      if (++n > 15) return clearInterval(t);
      router.refresh();
    }, 4000);
    return () => clearInterval(t);
  }, [waiting, router]);

  // A subscription Stripe still bills (past_due after the grace, unpaid, paused) is fixed, not started (VEC-270).
  const fix = b.liveSubscription;
  const admins = members.filter((m) => m.kind === "user" && m.role === "admin").map((m) => m.name);
  const others = orgs.filter((o) => o.id !== org.id);

  const subscribe = () =>
    start(async () => {
      setGoing(true);
      // A subscription Stripe still bills (unpaid, paused, past_due after the grace) is fixed in the portal; Checkout refuses it.
      const r = b.liveSubscription ? await openBillingPortal(org.slug) : await startCheckout(org.slug, "app");
      if (!r.ok || !r.data) {
        setGoing(false);
        return void toast.error(!r.ok ? r.error : "Couldn't reach Stripe. Try again.");
      }
      window.location.assign(r.data.url);
    });

  return (
    <main
      data-subscribe-screen
      data-upgrade-prompt
      className="flex min-h-dvh flex-col bg-sidebar px-[calc(1rem+env(safe-area-inset-left))] pt-[calc(1rem+env(safe-area-inset-top))] pb-[calc(1rem+env(safe-area-inset-bottom))]"
    >
      <header className="flex items-center gap-3 sm:px-2">
        <Logo />
        <Button variant="ghost" size="sm" className="ml-auto gap-2 text-muted-foreground" onClick={() => logoutAction()}>
          <LogOutIcon className="size-3.5" /> Sign out
        </Button>
      </header>

      <div className="mx-auto flex w-full max-w-[420px] flex-1 flex-col justify-center py-12">
        <p className="mb-3 flex items-center gap-1.5 font-mono text-[12.5px] text-faint">
          <LockIcon className="size-3.5" /> {org.name} is locked
        </p>
        <h1 className="text-[22px] font-semibold tracking-[-0.02em]">{fix ? "Fix billing to continue" : "Subscribe to continue"}</h1>
        <p className="mt-2 text-[13.5px] text-muted-foreground">
          {lockReason(b, org.name)} Hosted Aimpoint is {PER_MEMBER_PRICE_LABEL}, with no free tier. Your tasks, projects and bots are all kept and unlock as soon as{" "}
          {fix ? (b.status === "paused" ? "the subscription is resumed." : "the subscription is paid.") : "the subscription starts."}
        </p>

        {checkout === "cancelled" && !waiting && (
          <p role="status" data-checkout-banner="cancelled" className="mt-5 rounded-lg border border-border bg-background px-3.5 py-2.5 text-[13px]">
            Checkout was cancelled. Nothing was charged; subscribe whenever you&rsquo;re ready.
          </p>
        )}

        {waiting ? (
          <p role="status" data-checkout-banner="waiting" className="mt-6 flex items-center gap-2.5 rounded-lg border border-border bg-background px-3.5 py-2.5 text-[13px]">
            <LoaderIcon className="size-3.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
            Payment received. Confirming it with Stripe; this page unlocks by itself.
          </p>
        ) : isAdmin ? (
          <div className="mt-6 rounded-[10px] border border-border bg-background px-4 py-3.5">
            <p className="tabular text-[13px] text-muted-foreground" data-billing-seats={b.seats}>
              <span className="text-foreground">{seatTotalLabel(fix && b.subscribedSeats !== null ? b.subscribedSeats : b.seats)}</span>.
            </p>
            <p className="mt-1.5 text-[12.5px] text-muted-foreground" data-seat-rules="subscribe">
              That&rsquo;s {PER_MEMBER_PRICE_LABEL} for each human member; bots and pending invites are free until an invite is accepted. The total follows the member count:
              adding a member raises the bill with a prorated charge, and removing one lowers it.
            </p>
            <div className="mt-3.5 flex flex-wrap items-center gap-2">
              <Button onClick={subscribe} disabled={pending} className="gap-2" data-billing-action={b.liveSubscription ? "portal" : "checkout"}>
                {going ? <LoaderIcon className="size-3.5 animate-spin" /> : b.liveSubscription ? <ExternalLinkIcon className="size-3.5" /> : <CreditCardIcon className="size-3.5" />}
                {b.liveSubscription ? "Fix billing in Stripe" : b.status === "canceled" ? "Subscribe again" : "Subscribe"}
              </Button>
              <Button variant="ghost" asChild className="text-muted-foreground">
                <Link href={billingPath(org.slug)}>Billing settings</Link>
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-6 rounded-[10px] border border-border bg-background px-4 py-3.5 text-[13px]">
            <p>
              {fix ? "Only an admin can fix billing." : "Only an admin can subscribe."}{" "}
              {admins.length ? (
                <>
                  Ask <span className="font-medium">{listNames(admins)}</span>.
                </>
              ) : (
                "Ask an admin of this organisation."
              )}
            </p>
            <Link href={billingPath(org.slug)} className="mt-2 inline-block text-muted-foreground underline underline-offset-2 hover:text-foreground">
              See billing details
            </Link>
          </div>
        )}

        {others.length > 0 && (
          <div className="mt-6 text-[13px] text-muted-foreground">
            <p className="text-[12px] text-faint">Your other organisations</p>
            <ul className="mt-1.5 grid gap-1">
              {others.map((o) => (
                <li key={o.id}>
                  <Link href={orgPath(o.slug, "my")} className="text-foreground underline-offset-2 hover:underline">
                    {o.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="mt-8 text-[12.5px] text-faint">
          Want to run Aimpoint for free?{" "}
          <a href={SELF_HOST_URL} target="_blank" rel="noreferrer" className="text-muted-foreground underline underline-offset-2 hover:text-foreground">
            Self-host it
          </a>
          .
        </p>
      </div>
    </main>
  );
}

function listNames(names: string[]): string {
  if (names.length <= 2) return names.join(" or ");
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}
