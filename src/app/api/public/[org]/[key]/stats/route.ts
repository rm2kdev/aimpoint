import { NextResponse } from "next/server";
import { clientIp } from "@/lib/form-submit";
import { loadPublicStats } from "@/lib/project-public";
import { PUBLIC_STATS_CACHE } from "@/lib/project-public-core";

/**
 * Public task counts of a project (VEC-363), for README badges and dashboards. No session; the project must be
 * public with Project settings > Public access > statistics on (`publicAccess.showStats`). Counts are by status
 * stage over non-archived tasks, overall and per type; see docs/public-stats.md.
 *   200 {project: {key, name}, total, open, inProgress, done, cancelled, byType: {issue, feature, task}}
 *   404 not public / stats off / archived / org locked / unknown (no detail)   429 rate limited (Retry-After)
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(req: Request, ctx: RouteContext<"/api/public/[org]/[key]/stats">) {
  const p = await ctx.params;
  const r = await loadPublicStats(p.org, p.key, clientIp(req.headers));
  if (!r.ok) {
    if (r.status === 429) return NextResponse.json({ error: "Too many requests." }, { status: 429, headers: { ...NO_STORE, "Retry-After": String(r.retryAfter) } });
    return NextResponse.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
  }
  return NextResponse.json(
    { project: r.project, ...r.stats },
    { headers: { "Cache-Control": PUBLIC_STATS_CACHE, "Access-Control-Allow-Origin": "*" } },
  );
}
