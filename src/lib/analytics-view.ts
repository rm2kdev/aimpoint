import "server-only";
import { cookies } from "next/headers";
import { ObjectId } from "mongodb";
import { requireOrg } from "@/lib/session";
import { cols } from "@/lib/db";
import { computeAnalytics } from "@/lib/analytics";
import { TZ_COOKIE, parseAnalyticsParams, resolveAnalyticsRange, type AnalyticsParams } from "@/lib/analytics-range";
import { DEFAULT_ANALYTICS_TZ, type AnalyticsReport } from "@/lib/types";

export interface AnalyticsView {
  report: AnalyticsReport;
  /** The URL params with unusable filters dropped. */
  view: AnalyticsParams;
  /** Set when the URL asked for something unusable and a fallback was used. */
  note: string | null;
}

/**
 * Builds the analytics screen's data for URL params (VEC-134/135): resolves the period in the viewer's
 * timezone (vec-tz cookie), the project key and the person/bot filter. Admins only (requireOrg admin), so
 * both the page and the live-refresh action refuse a member, including one demoted while the page was open.
 */
export async function loadAnalyticsView(slug: string, sp: Record<string, string | string[] | undefined> | URLSearchParams): Promise<AnalyticsView> {
  const { org } = await requireOrg(slug, { admin: true });
  const view = parseAnalyticsParams(sp);
  const tz = cookieTz((await cookies()).get(TZ_COOKIE)?.value) ?? DEFAULT_ANALYTICS_TZ;
  const range = resolveAnalyticsRange(view, tz);
  const c = await cols();
  const notes: string[] = range.note ? [range.note] : [];

  let projectId: string | null = null;
  if (view.project) {
    const p = await c.projects.findOne({ orgId: org._id, key: view.project }, { projection: { _id: 1 } });
    if (p) projectId = p._id.toHexString();
    else notes.push(`There's no project ${view.project}, so all projects are shown.`);
  }

  let contributorId: string | null = null;
  if (view.person) {
    const id = new ObjectId(view.person);
    const known = (await c.memberships.countDocuments({ orgId: org._id, userId: id }, { limit: 1 })) || (await c.deletedUsers.countDocuments({ _id: id, orgIds: org._id }, { limit: 1 }));
    if (known) contributorId = view.person;
    else notes.push("That person isn't in this organisation, so everyone is shown.");
  } else if (view.bot) {
    const id = new ObjectId(view.bot);
    if (await c.bots.countDocuments({ orgId: org._id, _id: id }, { limit: 1 })) contributorId = view.bot;
    else notes.push("That bot isn't in this organisation, so everyone is shown.");
  }

  const report = await computeAnalytics(org._id, { from: range.from, to: range.to, granularity: range.granularity, projectId, tz: range.tz, contributorId });
  return {
    report,
    view: {
      ...view,
      project: projectId ? view.project : null,
      person: contributorId && view.person ? view.person : null,
      bot: contributorId && view.bot ? view.bot : null,
    },
    note: notes.length ? notes.join(" ") : null,
  };
}

function cookieTz(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}
