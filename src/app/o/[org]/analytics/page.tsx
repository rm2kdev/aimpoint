import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { requireOrgPage } from "@/lib/session";
import { cols } from "@/lib/db";
import { loadAnalytics } from "@/lib/analytics";
import { TZ_COOKIE, parseAnalyticsParams, resolveAnalyticsRange } from "@/lib/analytics-range";
import { DEFAULT_ANALYTICS_TZ } from "@/lib/types";
import { AnalyticsScreen } from "@/components/analytics-screen";

export const metadata = { title: "Analytics" };

/** Admin analytics (VEC-134). Members get a 404 here, server-side; the data layer re-checks admin too. */
export default async function AnalyticsPage({ params, searchParams }: PageProps<"/o/[org]/analytics">) {
  const { org: slug } = await params;
  const { org, isAdmin } = await requireOrgPage(slug);
  if (!isAdmin) notFound();

  const [sp, jar] = await Promise.all([searchParams, cookies()]);
  const view = parseAnalyticsParams(sp);
  const tz = cookieTz(jar.get(TZ_COOKIE)?.value) ?? DEFAULT_ANALYTICS_TZ;
  const range = resolveAnalyticsRange(view, tz);

  let note = range.note;
  let projectId: string | null = null;
  if (view.project) {
    const { projects } = await cols();
    const p = await projects.findOne({ orgId: org._id, key: view.project }, { projection: { _id: 1 } });
    if (p) projectId = p._id.toHexString();
    else note = `There's no project ${view.project}, so all projects are shown.`;
  }

  const report = await loadAnalytics(slug, {
    from: range.from,
    to: range.to,
    granularity: range.granularity,
    projectId,
    tz: range.tz,
  });

  return (
    <AnalyticsScreen
      report={report}
      view={{ ...view, project: projectId ? view.project : null }}
      note={note}
    />
  );
}

function cookieTz(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}
