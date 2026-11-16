import { notFound } from "next/navigation";
import { requireOrgPage } from "@/lib/session";

/**
 * Admins only (VEC-134). The check sits in a layout, above loading.tsx, so a member gets a real 404 status
 * before anything streams; the page and loadAnalytics check again.
 */
export default async function AnalyticsLayout({ params, children }: LayoutProps<"/o/[org]/analytics">) {
  const { org } = await params;
  const { isAdmin } = await requireOrgPage(org);
  if (!isAdmin) notFound();
  return children;
}
