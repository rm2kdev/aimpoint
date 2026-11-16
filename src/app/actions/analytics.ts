"use server";

import { guard, type Result } from "@/lib/result";
import { loadAnalyticsView, type AnalyticsView } from "@/lib/analytics-view";

/**
 * Live refresh for the analytics screen (VEC-135): the report for the screen's current URL query, recomputed.
 * Admins only (loadAnalyticsView), so a demoted admin's open page stops getting numbers.
 */
export async function refreshAnalytics(slug: string, search: string): Promise<Result<AnalyticsView>> {
  return guard(() => loadAnalyticsView(slug, new URLSearchParams(search)));
}
