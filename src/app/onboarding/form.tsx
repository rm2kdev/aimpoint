"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/logo";
import { createOrgAction } from "@/app/actions/org";
import { PER_MEMBER_PRICE_LABEL, SELF_HOST_URL } from "@/lib/billing-view";

/** `billing`: managed hosting (VEC-264), where creating an organisation goes straight on to Stripe Checkout. */
export function OnboardingForm({ firstName, billing }: { firstName: string; billing: boolean }) {
  const [state, action, pending] = useActionState(createOrgAction, undefined);
  return (
    <main className="grid min-h-full place-items-center bg-sidebar px-[calc(1rem+env(safe-area-inset-left))] py-[calc(4rem+env(safe-area-inset-top))]">
      <div className="w-full max-w-[380px]">
        <Logo className="mb-8" />
        <h1 className="text-[22px] font-semibold tracking-[-0.02em]">Welcome, {firstName}</h1>
        <p className="mt-1.5 text-[13.5px] text-muted-foreground">
          Create an organisation for your team. You can invite people and add projects once you&rsquo;re in.
        </p>
        <form action={action} className="mt-7 grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="name">Organisation name</Label>
            <Input id="name" name="name" placeholder="Northwind Labs" required autoFocus className="h-9 bg-background" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="project">First project</Label>
            <Input id="project" name="project" placeholder="Web App" className="h-9 bg-background" />
            <p className="text-xs text-faint">Tasks are grouped by project. Defaults to &ldquo;General&rdquo;.</p>
          </div>
          {billing && (
            <p className="rounded-lg border border-border bg-background px-3 py-2.5 text-[13px] text-muted-foreground" data-onboarding-pricing>
              Hosted Aimpoint is <span className="text-foreground">{PER_MEMBER_PRICE_LABEL}</span>, with no free tier. Next you&rsquo;ll subscribe through Stripe; the total
              follows the member count, so each person you add later raises the bill.
            </p>
          )}
          <p role="alert" aria-live="polite" className="min-h-5 text-[13px] text-destructive">{state?.error}</p>
          <Button type="submit" disabled={pending} className="-mt-2 h-9">
            {pending ? "Creating…" : billing ? "Create and subscribe" : "Create organisation"}
          </Button>
        </form>
        <p className="mt-6 text-[13px] text-muted-foreground">Joining a team? Open the invite link your admin sent you.</p>
        {billing && (
          <p className="mt-2 text-[13px] text-muted-foreground">
            Want it free?{" "}
            <a href={SELF_HOST_URL} target="_blank" rel="noreferrer" className="font-medium text-foreground underline underline-offset-4">
              Self-host Aimpoint
            </a>
            .
          </p>
        )}
      </div>
    </main>
  );
}
