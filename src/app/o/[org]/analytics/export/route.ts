import { computeAnalytics } from "@/lib/analytics";
import { analyticsCsvFiles, exportFileName, resolveAnalyticsExport } from "@/lib/analytics-export";
import { UserError } from "@/lib/result";
import { AuthError, currentUser, requireOrg } from "@/lib/session";
import { zip } from "@/lib/zip";
import { PlanLimitError } from "@/lib/billing-limits";

/**
 * GET /o/<slug>/analytics/export?from&to&granularity&project&person|bot&tz (VEC-136): the analytics report for that
 * filter as a zip of CSVs (README.txt documents the columns). Admins only: signed out -> 401, a member or
 * someone outside the org -> 403, bad params -> 400. The screen's Export CSV button passes its resolved
 * period, so the files match what's on screen.
 */
export async function GET(req: Request, ctx: RouteContext<"/o/[org]/analytics/export">) {
  const { org: slug } = await ctx.params;
  if (!(await currentUser())) return Response.json({ error: "You are signed out. Sign in and try again." }, { status: 401 });
  let orgId;
  try {
    orgId = (await requireOrg(slug, { admin: true })).org._id;
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: "Only admins of this organisation can export analytics." }, { status: 403 });
    throw err;
  }
  const sp = new URL(req.url).searchParams;
  try {
    const { query, project } = await resolveAnalyticsExport(orgId, {
      from: sp.get("from") ?? undefined,
      to: sp.get("to") ?? undefined,
      granularity: sp.get("granularity") ?? sp.get("g") ?? undefined,
      project: sp.get("project") ?? undefined,
      tz: sp.get("tz") ?? undefined,
      person: sp.get("person") ?? undefined,
      bot: sp.get("bot") ?? undefined,
    });
    const report = await computeAnalytics(orgId, query);
    const key = project?.key ?? null;
    const body = zip(analyticsCsvFiles(report, key), new Date(report.generatedAt));
    return new Response(new Blob([body as BlobPart], { type: "application/zip" }), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${exportFileName(slug, report, key)}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof PlanLimitError) return Response.json({ error: err.message, locked: true }, { status: 402 });
    if (err instanceof UserError) return Response.json({ error: err.message }, { status: 400 });
    throw err;
  }
}
