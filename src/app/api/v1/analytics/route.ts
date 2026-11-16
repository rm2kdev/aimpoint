import { botRoute } from "@/lib/bot-api";
import { computeAnalytics } from "@/lib/analytics";
import { resolveAnalyticsExport } from "@/lib/analytics-export";

/**
 * GET /api/v1/analytics?from&to&granularity&project&person|bot&tz (VEC-136): the organisation's analytics report
 * (AnalyticsReport JSON, the same data as the Analytics screen). Only for bots whose role switches on the
 * opt-in `get_analytics` tool (403 otherwise); bad params -> 400. Params: see ANALYTICS_PARAM_DOCS.
 */
export const GET = botRoute(async (req, { org }) => {
  const sp = new URL(req.url).searchParams;
  const { query, project } = await resolveAnalyticsExport(org._id, {
    from: sp.get("from") ?? undefined,
    to: sp.get("to") ?? undefined,
    granularity: sp.get("granularity") ?? undefined,
    project: sp.get("project") ?? undefined,
    tz: sp.get("tz") ?? undefined,
    person: sp.get("person") ?? undefined,
    bot: sp.get("bot") ?? undefined,
  });
  const report = await computeAnalytics(org._id, query);
  return { project: project ? { id: project._id.toHexString(), key: project.key, name: project.name } : null, report };
}, "get_analytics");
