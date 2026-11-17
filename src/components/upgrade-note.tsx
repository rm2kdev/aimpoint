"use client";

import Link from "next/link";
import { useOrg } from "@/components/org-provider";
import { billingPath } from "@/lib/paths";
import { cn } from "@/lib/utils";

/**
 * Upgrade prompts (VEC-226): where a Free limit bites, the action is disabled and this line says why, with a
 * link to Settings > Billing. Admins are told to upgrade; members to ask an admin. Render it only when the
 * limit applies (`atLimit` / `billing.features`), which is never with billing off.
 */
/** `gain` ends the sentence: "Upgrade to Pro for <gain>." */
export function UpgradeNote({ reason, gain = "unlimited", className }: { reason: string; gain?: string; className?: string }) {
  const { org, isAdmin } = useOrg();
  const link = (text: string) => (
    <Link href={billingPath(org.slug)} className="font-medium text-foreground underline underline-offset-2 hover:decoration-2">
      {text}
    </Link>
  );
  return (
    <p data-upgrade-prompt className={cn("mt-1.5 text-[12.5px] text-muted-foreground", className)}>
      {reason} {isAdmin ? <>{link("Upgrade to Pro")} for {gain}.</> : <>An admin can {link("upgrade to Pro")} for {gain}.</>}
    </p>
  );
}

/** Small neutral "Pro" chip after a nav entry the Free plan doesn't include. */
export function ProTag({ className }: { className?: string }) {
  return (
    <span
      data-pro-tag
      title="Included with Pro"
      className={cn("ml-auto shrink-0 rounded-[4px] bg-chip px-1.5 py-px text-[11px] font-medium leading-4 text-muted-foreground", className)}
    >
      Pro
    </span>
  );
}
