import { NextResponse } from "next/server";
import { clientIp } from "@/lib/form-submit";
import { loadPublicStats } from "@/lib/project-public";
import { PUBLIC_STATS_CACHE, isBadgeMetric, shapeBadge } from "@/lib/project-public-core";

/**
 * shields.io endpoint badge for a public project with statistics on (VEC-363):
 * `https://img.shields.io/endpoint?url=<origin>/api/public/<org>/<KEY>/badge/<metric>`.
 * Metrics: open, in-progress, done, total, bugs (open issues), features (open feature requests).
 *   200 {schemaVersion: 1, label, message, color}
 *   404 unknown metric / not public / stats off / archived / org locked   429 rate limited (Retry-After)
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const notFound = () => NextResponse.json({ error: "Not found." }, { status: 404, headers: NO_STORE });

export async function GET(req: Request, ctx: RouteContext<"/api/public/[org]/[key]/badge/[metric]">) {
  const p = await ctx.params;
  if (!isBadgeMetric(p.metric)) return notFound();
  const r = await loadPublicStats(p.org, p.key, clientIp(req.headers));
  if (!r.ok) {
    if (r.status === 429) return NextResponse.json({ error: "Too many requests." }, { status: 429, headers: { ...NO_STORE, "Retry-After": String(r.retryAfter) } });
    return notFound();
  }
  const badge = shapeBadge(p.metric, r.stats);
  if (!badge) return notFound();
  return NextResponse.json(badge, { headers: { "Cache-Control": PUBLIC_STATS_CACHE, "Access-Control-Allow-Origin": "*" } });
}
