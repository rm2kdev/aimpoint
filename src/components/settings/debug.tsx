"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangleIcon, CheckIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { useOrg } from "@/components/org-provider";
import { SettingsRow, Tag } from "@/components/settings/ui";
import { Switch } from "@/components/ui/switch";
import { setBillingDebugAction } from "@/app/actions/debug";
import { PRO_PRICE_LABEL } from "@/lib/billing-view";
import type { StripeKeyMode } from "@/lib/billing-core";
import { billingPath } from "@/lib/paths";

export interface DebugView {
  toggle: { enabled: boolean; byName: string | null; at: string | null };
  /** Effective billing right now (BILLING_ENABLED can't be on here, so this is the toggle). */
  billingOn: boolean;
  debugActive: boolean;
  /** Why Stripe calls refuse while test billing is on, else null. */
  problem: string | null;
  /** What would stop the toggle from turning on (missing vars, a non-test key). */
  setupProblems: string[];
  env: { name: string; set: boolean }[];
  keyMode: StripeKeyMode | null;
  apiBase: boolean;
}

const KEY_MODE: Record<StripeKeyMode, string> = { test: "test mode", live: "live key, refused", unknown: "not a Stripe test key" };

/** Settings > Debug (VEC-240): the instance-wide test billing switch and the Stripe env it would use. Admins only. */
export function DebugSettings({ view }: { view: DebugView }) {
  const { org } = useOrg();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const on = optimistic ?? view.toggle.enabled;

  const change = (next: boolean) => {
    setOptimistic(next);
    start(async () => {
      const r = await setBillingDebugAction(org.slug, next);
      if (!r.ok) toast.error(r.error);
      else toast.success(next ? "Test billing is on for this instance" : "Test billing is off. Every organisation is unlocked again, with everything on.");
      router.refresh();
      setOptimistic(null);
    });
  };

  const changed = view.toggle.at
    ? `Last turned ${view.toggle.enabled ? "on" : "off"}${view.toggle.byName ? ` by ${view.toggle.byName}` : ""} on ${new Date(view.toggle.at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}.`
    : "Never turned on.";

  return (
    <>
      <p className="mb-2 flex items-start gap-2 rounded-lg border border-border bg-sidebar px-3.5 py-2.5 text-[13px] text-muted-foreground" data-debug-note>
        <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
        <span>
          Debug settings show because AIMPOINT_DEBUG is set on this self-hosted instance. They apply to every organisation here. Unset AIMPOINT_DEBUG to hide them; that also
          turns test billing off.
        </span>
      </p>
      <SettingsRow
        id="test-billing"
        title="Test billing"
        desc={
          <>
            Turns billing on for this instance without redeploying, as if BILLING_ENABLED were set: Pro at {PRO_PRICE_LABEL}, organisations without a subscription locked, Checkout
            and the Stripe webhook. Only Stripe test-mode keys are accepted. Turning it off unlocks every organisation again at once with everything on; billing data is kept.
          </>
        }
      >
        <div className="grid max-w-xl gap-3">
          <label className="flex items-center gap-3 text-[13.5px]">
            <Switch checked={on} disabled={pending} onCheckedChange={change} aria-label="Test billing" data-debug-billing-toggle />
            <span className="font-medium">{on ? "On" : "Off"}</span>
            {view.debugActive && (
              <a href={billingPath(org.slug)} className="text-[12.5px] text-muted-foreground underline underline-offset-2 hover:text-foreground">
                Open Billing
              </a>
            )}
          </label>
          <p className="text-[12.5px] text-faint" suppressHydrationWarning>
            {changed}
          </p>
          {view.problem && (
            <p className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive-ink" data-debug-problem>
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
              {view.problem} Checkout and the webhook refuse until it&rsquo;s fixed.
            </p>
          )}
          {!on && view.setupProblems.length > 0 && (
            <p className="text-[12.5px] text-muted-foreground" data-debug-setup>
              Can&rsquo;t turn on yet: {view.setupProblems.join(" ")}
            </p>
          )}
        </div>
      </SettingsRow>
      <SettingsRow id="stripe-env" title="Stripe setup" desc="The environment variables test billing uses (values are never shown). Set them and restart the server, then switch it on.">
        <ul className="grid max-w-xl gap-1.5 text-[13px]" data-debug-env>
          {view.env.map((v) => (
            <li key={v.name} className="flex items-center gap-2">
              {v.set ? <CheckIcon className="size-3.5 text-muted-foreground" /> : <XIcon className="size-3.5 text-destructive" />}
              <code className="text-[12.5px]">{v.name}</code>
              <Tag tone="faint">
                {v.set ? (v.name === "STRIPE_SECRET_KEY" && view.keyMode ? KEY_MODE[view.keyMode] : "set") : "missing"}
              </Tag>
            </li>
          ))}
          <li className="flex items-center gap-2">
            <span className="size-3.5" />
            <code className="text-[12.5px]">STRIPE_API_BASE</code>
            <Tag tone="faint">{view.apiBase ? "set (another Stripe host, e.g. stripe-mock)" : "unset (api.stripe.com)"}</Tag>
          </li>
        </ul>
      </SettingsRow>
    </>
  );
}
