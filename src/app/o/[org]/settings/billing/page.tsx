import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { billingOn } from "@/lib/billing";
import { TZ_COOKIE } from "@/lib/analytics-range";
import { DEFAULT_ANALYTICS_TZ } from "@/lib/types";
import { BillingSettings } from "@/components/settings/billing";

export const metadata = { title: "Billing · Settings" };

function cookieTz(raw: string | undefined): string {
  if (!raw) return DEFAULT_ANALYTICS_TZ;
  try {
    const tz = decodeURIComponent(raw);
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_ANALYTICS_TZ;
  }
}

/**
 * Settings > Billing (VEC-226). Absent (404) when billing is off: self-hosted deployments have no plans. Everyone
 * in the org can read it; only admins get the Subscribe / Manage billing buttons (the actions check too).
 * `?checkout=success|cancelled` is Stripe Checkout's return (lib/stripe.ts).
 */
export default async function BillingPage({ searchParams }: PageProps<"/o/[org]/settings/billing">) {
  if (!(await billingOn())) notFound();
  const { checkout } = await searchParams;
  const tz = cookieTz((await cookies()).get(TZ_COOKIE)?.value);
  return <BillingSettings checkout={checkout === "success" ? "success" : checkout === "cancelled" ? "cancelled" : null} tz={tz} />;
}
