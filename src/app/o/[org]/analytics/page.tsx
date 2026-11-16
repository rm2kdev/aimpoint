import { notFound } from "next/navigation";
import { requireOrgPage } from "@/lib/session";
import { loadAnalyticsView } from "@/lib/analytics-view";
import { AnalyticsScreen } from "@/components/analytics-screen";

export const metadata = { title: "Analytics" };

/** Admin analytics (VEC-134). Members get a 404 here, server-side; the data layer re-checks admin too. */
export default async function AnalyticsPage({ params, searchParams }: PageProps<"/o/[org]/analytics">) {
  const { org: slug } = await params;
  const { isAdmin } = await requireOrgPage(slug);
  if (!isAdmin) notFound();
  const { report, view, note } = await loadAnalyticsView(slug, await searchParams);
  return <AnalyticsScreen report={report} view={view} note={note} />;
}
