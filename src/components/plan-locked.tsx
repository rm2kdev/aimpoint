/**
 * A feature the org's plan doesn't include (VEC-224): shown in place of the page, with the upgrade message from
 * lib/billing. Server component; the Billing page task styles the upgrade prompts further.
 */
export function PlanLocked({ title, message }: { title: string; message: string }) {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center px-6 py-[18vh] text-center" data-plan-locked>
      <p className="mb-3 font-mono text-[13px] text-faint">Free plan</p>
      <h1 className="text-[15px] font-semibold">{title} isn&apos;t included</h1>
      <p className="mt-1 text-[13.5px] text-muted-foreground">{message}</p>
    </div>
  );
}
