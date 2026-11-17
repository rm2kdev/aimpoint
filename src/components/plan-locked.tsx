import Link from "next/link";
import { CreditCardIcon } from "lucide-react";

/**
 * A page an unpaid (locked) org can't use (VEC-224, paid-only since VEC-262), shown in its place with the lock message
 * from lib/billing and a link to Settings > Billing (VEC-226). Server component.
 */
export function PlanLocked({ title, message, billingHref }: { title: string; message: string; billingHref: string }) {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center px-6 py-[18vh] text-center" data-plan-locked data-upgrade-prompt>
      <p className="mb-3 font-mono text-[13px] text-faint">No subscription</p>
      <h1 className="text-[15px] font-semibold">{title} isn&apos;t available</h1>
      <p className="mt-1 text-[13.5px] text-muted-foreground">{message}</p>
      <Link
        href={billingHref}
        className="mt-5 inline-flex h-8 items-center gap-2 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
      >
        <CreditCardIcon className="size-3.5" /> Go to Billing
      </Link>
    </div>
  );
}
