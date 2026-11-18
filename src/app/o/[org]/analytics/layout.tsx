import { notFound } from "next/navigation";
import { requireOrgPage } from "@/lib/session";
import { featureLockMessage } from "@/lib/billing-limits";
import { PlanLocked } from "@/components/plan-locked";
import { billingPath } from "@/lib/paths";

/**
 * Admins only (VEC-134). The check sits in a layout, above loading.tsx, so a member gets a real 404 status
 * before anything streams; the page and loadAnalytics check again. For an unpaid (locked) org (VEC-224/262) admins get the
 * lock message instead of the screen; computeAnalytics refuses too, so the CSV, REST and MCP paths match.
 */
export default async function AnalyticsLayout({ params, children }: LayoutProps<"/o/[org]/analytics">) {
  const { org } = await params;
  const { isAdmin, org: doc } = await requireOrgPage(org);
  if (!isAdmin) notFound();
  const locked = featureLockMessage(doc, "analytics");
  if (locked) return <PlanLocked title="Analytics" message={locked} billingHref={billingPath(org)} />;
  return children;
}
