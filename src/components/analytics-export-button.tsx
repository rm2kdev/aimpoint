"use client";

import { DownloadIcon } from "lucide-react";
import { useOrg } from "@/components/org-provider";
import { Button } from "@/components/ui/button";
import { orgPath } from "@/lib/paths";
import type { AnalyticsReport } from "@/lib/types";

/**
 * "Export CSV" for the analytics screen (VEC-136): downloads a zip of CSVs for exactly the period, granularity,
 * timezone and filters the screen is showing (the resolved instants, not the preset, so a report exported
 * just after midnight still matches). Served by the admin-only `/o/<slug>/analytics/export` route.
 */
export function AnalyticsExportButton({ report, filters }: { report: AnalyticsReport; filters: Record<string, string | null | undefined> }) {
  const slug = useOrg().org.slug;
  const q = new URLSearchParams({ from: report.period.from, to: report.period.to, granularity: report.period.granularity, tz: report.period.tz });
  for (const [k, v] of Object.entries(filters)) if (v) q.set(k, v);
  return (
    <Button asChild variant="outline" className="h-[30px] gap-2 rounded-lg px-3 max-sm:w-[30px] max-sm:px-0">
      <a
        href={`${orgPath(slug, "analytics", "export")}?${q}`}
        download
        data-analytics-export
        aria-label="Export CSV"
        title="Download this report as CSV files (zip)"
      >
        <DownloadIcon className="size-3.5" />
        <span className="max-sm:hidden">Export CSV</span>
      </a>
    </Button>
  );
}
