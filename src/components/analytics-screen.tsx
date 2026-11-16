"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { BotIcon, CalendarRangeIcon, ChartNoAxesColumnIcon, UserIcon, XIcon } from "lucide-react";
import { MobileNavButton } from "@/components/app-shell";
import { AnalyticsExportButton } from "@/components/analytics-export-button";
import { useOrg, useOrgEvents } from "@/components/org-provider";
import { refreshAnalytics } from "@/app/actions/analytics";
import type { AnalyticsView } from "@/lib/analytics-view";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { BarChart, DonutChart, KpiTile, TimeSeriesChart, formatNumber, type DonutSlice } from "@/components/analytics";
import { DataTable, type DataTableColumn } from "@/components/analytics/chart-frame";
import {
  ANALYTICS_PRESETS,
  GRANULARITY_LABELS,
  TZ_COOKIE,
  allowedGranularities,
  autoGranularity,
  analyticsSearch,
  formatRange,
  fromLocalInput,
  inclusiveEnd,
  toLocalInput,
  type AnalyticsParams,
  type AnalyticsPreset,
} from "@/lib/analytics-range";
import { STAGE_LABELS } from "@/lib/stages";
import { PRIORITY_LABELS, TYPE_LABELS } from "@/lib/format";
import { ANALYTICS_GRANULARITIES, STATUS_STAGES, isAnalyticsGranularity, type AnalyticsContributor, type AnalyticsGranularity, type AnalyticsReport } from "@/lib/types";
import { cn } from "@/lib/utils";

const UNIT_WORDS: Record<AnalyticsGranularity, string> = { hour: "hour", day: "day", week: "week", month: "month" };

/** "45 min", "5.2 h", "3.4 d" */
export function formatDuration(ms: number): string {
  const min = ms / 60_000;
  if (min < 60) return `${Math.max(0, Math.round(min))} min`;
  const h = min / 60;
  if (h < 48) return `${h.toLocaleString("en", { maximumFractionDigits: 1 })} h`;
  return `${(h / 24).toLocaleString("en", { maximumFractionDigits: 1 })} d`;
}
/** Live refresh (VEC-135): wait this long after the first task/comment event so a burst lands in one refresh... */
const LIVE_SETTLE_MS = 1_500;
/** ...and refresh at most once per this interval while events keep coming. */
const LIVE_INTERVAL_MS = 10_000;

const signed = (n: number) => (n > 0 ? `+${formatNumber(n)}` : n < 0 ? `−${formatNumber(-n)}` : "0");

/** Analytics screen (VEC-134): period controls in the URL, KPI row, charts and tables over one AnalyticsReport. */
export function AnalyticsScreen(props: AnalyticsView) {
  const router = useRouter();
  const pathname = usePathname();
  const { org, memberById } = useOrg();
  const [pending, start] = useTransition();

  // Live refresh (VEC-135): task and comment events on the org channel recompute the report for the current
  // URL through an admin-only server action, throttled, so only this screen re-renders (no route refresh).
  // A live result is used while it belongs to the current URL and is newer than the server render.
  const search = analyticsSearch(props.view);
  const [live, setLive] = useState<{ search: string; data: AnalyticsView } | null>(null);
  const { report, view, note } = live && live.search === search && live.data.report.generatedAt > props.report.generatedAt ? live.data : props;
  const searchRef = useRef(search);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRun = useRef(0);
  useEffect(() => {
    searchRef.current = search;
  }, [search]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  useOrgEvents((e) => {
    if (e.type !== "task.upsert" && e.type !== "task.delete" && e.type !== "feed.add") return;
    if (timer.current) return; // a refresh is already scheduled and will include this event
    const wait = Math.max(LIVE_SETTLE_MS, lastRun.current + LIVE_INTERVAL_MS - Date.now());
    timer.current = setTimeout(async () => {
      timer.current = null;
      lastRun.current = Date.now();
      const s = searchRef.current;
      const res = await refreshAnalytics(org.slug, s);
      if (res.ok && res.data) setLive({ search: s, data: res.data });
    }, wait);
  });

  const tz = report.period.tz;
  const who = report.period.contributor;
  const whoName = who ? (memberById.get(who.id)?.name ?? who.name) : null;

  // Ranges are cut in the viewer's timezone: hand the browser's zone to the server once, then re-render.
  useEffect(() => {
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!browserTz || browserTz === tz) return;
    const current = document.cookie.split("; ").find((c) => c.startsWith(`${TZ_COOKIE}=`));
    if (current && decodeURIComponent(current.slice(TZ_COOKIE.length + 1)) === browserTz) return; // server didn't accept it
    document.cookie = `${TZ_COOKIE}=${encodeURIComponent(browserTz)}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  }, [tz, router]);

  const go = (patch: Partial<AnalyticsParams>) => {
    const next = { ...view, ...patch };
    start(() => router.push(`${pathname}${analyticsSearch(next)}`, { scroll: false }));
  };

  const from = new Date(report.period.from);
  const to = new Date(report.period.to);
  const rangeText = formatRange(from, to, tz);
  const prevText = formatRange(new Date(report.previous.from), new Date(report.previous.to), tz);
  const g = report.period.granularity;

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 sm:px-7">
        <MobileNavButton />
        <h1 className="truncate text-[15px] font-semibold tracking-[-0.01em]">Analytics</h1>
        <AnalyticsExportButton report={report} filters={{ project: view.project, person: view.person, bot: view.bot }} />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto" data-analytics-scroll>
        <div className="mx-auto flex max-w-[1400px] flex-col gap-4 px-4 pt-4 pb-16 sm:px-7">
          <Controls view={view} report={report} go={go} whoName={whoName} />
          <div className="-mt-1 flex flex-col gap-0.5 text-[12.5px]" aria-live="polite">
            <p>
              <span className="text-muted-foreground">Showing </span>
              <time className="font-medium" dateTime={`${report.period.from}/${inclusiveEnd(to).toISOString()}`} data-analytics-range>
                {rangeText}
              </time>
              <span className="text-muted-foreground">
                , by {UNIT_WORDS[g]}
                {report.period.projectId ? ` in ${report.projects[0]?.project.name ?? view.project}` : ", all projects"}
                {whoName ? ` for ${whoName}` : ""}
              </span>
              {pending ? (
                <span className="ml-2 text-faint">Updating…</span>
              ) : (
                <span className="ml-2 text-faint" data-analytics-updated={report.generatedAt} title="Refreshes on its own as tasks and comments change">
                  · Live, updated {formatClock(report.generatedAt, tz)}
                </span>
              )}
            </p>
            {whoName ? (
              <p className="text-faint">
                Tasks {whoName} opened and closed, their comments and interactions. Backlog, open-task age and tasks right now count tasks assigned to {whoName}.
              </p>
            ) : null}
            {view.compare ? <p className="text-faint">Compared with {prevText}</p> : null}
            {note ? <p className="text-destructive">{note}</p> : null}
          </div>
          <Report report={report} compare={view.compare} loading={pending} rangeText={rangeText} go={go} filtered={!!who} />
        </div>
      </div>
    </div>
  );
}

/** "14:02:31" in `tz`, for the live-update stamp. */
function formatClock(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

/* ---------------- controls ---------------- */

function Controls({ view, report, go, whoName }: { view: AnalyticsParams; report: AnalyticsReport; go: (p: Partial<AnalyticsParams>) => void; whoName: string | null }) {
  const { projects } = useOrg();
  const tz = report.period.tz;
  const from = new Date(report.period.from);
  const to = new Date(report.period.to);
  const allowed = allowedGranularities(from, to);
  const listed = projects.filter((p) => !p.archived || p.key === view.project);

  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Report period">
      <div className="flex max-w-full flex-wrap rounded-[8px] border border-border p-0.5" role="radiogroup" aria-label="Period">
        {ANALYTICS_PRESETS.filter((p) => p.id !== "custom").map((p) => (
          <PresetButton key={p.id} id={p.id} label={p.label} active={view.range === p.id} onSelect={() => go({ range: p.id, from: null, to: null, g: null })} />
        ))}
        <CustomRange active={view.range === "custom"} from={from} to={to} tz={tz} onApply={(f, t) => go({ range: "custom", from: f.toISOString(), to: t.toISOString(), g: null })} />
      </div>
      <Select
        value={view.g ? report.period.granularity : "auto"}
        onValueChange={(v) => go({ g: isAnalyticsGranularity(v) ? v : null })}
      >
        <SelectTrigger className="h-[32px] w-[150px] text-[13px]" aria-label="Granularity">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="auto">Auto (by {GRANULARITY_LABELS[autoGranularity(from, to)].toLowerCase()})</SelectItem>
          {ANALYTICS_GRANULARITIES.map((x) => (
            <SelectItem key={x} value={x} disabled={!allowed.includes(x)}>
              By {GRANULARITY_LABELS[x].toLowerCase()}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={view.project ?? "all"} onValueChange={(v) => go({ project: v === "all" ? null : v })}>
        <SelectTrigger className="h-[32px] w-[190px] text-[13px]" aria-label="Project">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All projects</SelectItem>
          {listed.map((p) => (
            <SelectItem key={p.id} value={p.key}>
              <span className="size-2 shrink-0 rounded-full" style={{ background: p.color }} aria-hidden />
              {p.name}
              {p.archived ? " (archived)" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <label className="ml-1 flex h-[32px] items-center gap-2 text-[13px] text-muted-foreground">
        <Switch checked={view.compare} onCheckedChange={(c) => go({ compare: c })} aria-label="Compare with the previous period" />
        Compare with previous period
      </label>
      {whoName ? (
        <button
          type="button"
          onClick={() => go({ person: null, bot: null })}
          data-analytics-contributor={report.period.contributor?.id}
          className="flex h-[32px] items-center gap-1.5 rounded-[8px] border border-border bg-chip px-2.5 text-[13px] outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
          aria-label={`Showing ${whoName} only. Show everyone`}
          title="Show everyone"
        >
          {report.period.contributor?.kind === "bot" ? <BotIcon className="size-3.5 text-muted-foreground" /> : <UserIcon className="size-3.5 text-muted-foreground" />}
          <span className="max-w-[180px] truncate font-medium">{whoName}</span>
          <XIcon className="size-3.5 text-faint" />
        </button>
      ) : null}
    </div>
  );
}

function PresetButton({ id, label, active, onSelect }: { id: AnalyticsPreset; label: string; active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      data-preset={id}
      onClick={onSelect}
      className={cn(
        "h-[28px] shrink-0 rounded-[6px] px-2.5 text-[13px] whitespace-nowrap text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
        active && "bg-chip font-medium text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function CustomRange({ active, from, to, tz, onApply }: { active: boolean; from: Date; to: Date; tz: string; onApply: (from: Date, to: Date) => void }) {
  const [open, setOpen] = useState(false);
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const start = fromLocalInput(a, tz);
  const endIncl = fromLocalInput(b, tz);
  const end = endIncl ? new Date(endIncl.getTime() + 60_000) : null;
  const error = !start || !end ? "Pick a start and an end." : start >= end ? "The end must be after the start." : null;

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (o) {
          setA(toLocalInput(from, tz));
          setB(toLocalInput(inclusiveEnd(to), tz));
        }
        setOpen(o);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          role="radio"
          aria-checked={active}
          data-preset="custom"
          className={cn(
            "flex h-[28px] shrink-0 items-center gap-1.5 rounded-[6px] px-2.5 text-[13px] whitespace-nowrap text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
            active && "bg-chip font-medium text-foreground",
          )}
        >
          <CalendarRangeIcon className="size-3.5" /> Custom
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[300px]">
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (error || !start || !end) return;
            setOpen(false);
            onApply(start, end);
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="analytics-from">From</Label>
            <Input id="analytics-from" type="datetime-local" value={a} onChange={(e) => setA(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="analytics-to">To (inclusive)</Label>
            <Input id="analytics-to" type="datetime-local" value={b} onChange={(e) => setB(e.target.value)} />
          </div>
          <p className={cn("text-[12px]", error ? "text-destructive" : "text-faint")}>{error ?? `Times are in ${tz}.`}</p>
          <Button type="submit" size="sm" disabled={!!error}>
            Apply range
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/* ---------------- report ---------------- */

function Report({
  report,
  compare,
  loading,
  rangeText,
  go,
  filtered,
}: {
  report: AnalyticsReport;
  compare: boolean;
  loading: boolean;
  rangeText: string;
  go: (p: Partial<AnalyticsParams>) => void;
  /** Limited to one person or bot. */
  filtered: boolean;
}) {
  const { tickets, messages, interactions, breakdown } = report;
  const g = report.period.granularity;
  const prev = <T,>(v: T) => (compare ? v : undefined);
  const net = tickets.backlog.end - tickets.backlog.start;
  const netPrev = tickets.backlog.start - tickets.backlog.previousStart;
  const empty = tickets.opened.total + tickets.closed.total + tickets.reopened.total + messages.comments.total + interactions.total.total === 0;

  const series = useMemo(
    () =>
      report.buckets.map((t, i) => ({
        t,
        opened: tickets.opened.series[i] ?? 0,
        closed: tickets.closed.series[i] ?? 0,
        backlog: tickets.backlog.series[i] ?? 0,
        people: messages.comments.people.series[i] ?? 0,
        bots: messages.comments.bots.series[i] ?? 0,
      })),
    [report.buckets, tickets, messages],
  );

  const kinds = [
    { kind: "Status changes", people: interactions.statusChanges.people.total, bots: interactions.statusChanges.bots.total },
    { kind: "Assignments", people: interactions.assignments.people.total, bots: interactions.assignments.bots.total },
    { kind: "Mentions", people: interactions.mentions.people.total, bots: interactions.mentions.bots.total },
    { kind: "Dependency edits", people: interactions.dependencyEdits.people.total, bots: interactions.dependencyEdits.bots.total },
    { kind: "Bot pickups", people: 0, bots: interactions.botPickups.total },
    { kind: "Bot completions", people: 0, bots: interactions.botCompletions.total },
  ];

  const stage: DonutSlice[] = STATUS_STAGES.map((s) => ({ key: s, label: STAGE_LABELS[s], value: breakdown.byStage[s] ?? 0 }));
  const priority: DonutSlice[] = breakdown.byPriority.map((r) => ({ key: String(r.key), label: PRIORITY_LABELS[r.key], value: r.open }));
  const type: DonutSlice[] = breakdown.byType.map((r) => ({ key: r.key, label: TYPE_LABELS[r.key], value: r.open }));

  const projectRows = report.projects
    .filter((p) => p.opened.total + p.closed.total + p.comments.total + p.interactions.total + p.backlog.end > 0 || report.projects.length === 1)
    .sort((a, b) => b.opened.total + b.closed.total - (a.opened.total + a.closed.total) || a.project.name.localeCompare(b.project.name));
  const projectBars = projectRows.map((p) => ({ project: p.project.name, opened: p.opened.total, closed: p.closed.total }));
  const vs = compare ? "vs previous" : undefined;

  return (
    <>
      <section aria-label="Key figures" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiTile label="Opened" value={tickets.opened.total} previous={prev(tickets.opened.previous)} goodDirection="neutral" comparisonLabel={vs} loading={loading} />
        <KpiTile label="Closed" value={tickets.closed.total} previous={prev(tickets.closed.previous)} comparisonLabel={vs} loading={loading} />
        <KpiTile label="Net backlog" value={net} previous={prev(netPrev)} goodDirection="down" format={signed} deltaFormat={formatNumber} comparisonLabel={vs} loading={loading} />
        <KpiTile
          label="Median cycle time"
          value={tickets.cycleTime.medianMs}
          previous={prev(tickets.cycleTime.previous.medianMs)}
          goodDirection="down"
          format={formatDuration}
          comparisonLabel={vs}
          loading={loading}
        />
        <KpiTile label="Comments" value={messages.comments.total} previous={prev(messages.comments.previous)} comparisonLabel={vs} loading={loading} />
        <KpiTile label="Interactions" value={interactions.total.total} previous={prev(interactions.total.previous)} goodDirection="neutral" comparisonLabel={vs} loading={loading} />
      </section>

      {empty && !loading ? (
        <div role="status" className="flex flex-col items-center rounded-[10px] border border-dashed border-input px-6 py-12 text-center" data-analytics-empty>
          <ChartNoAxesColumnIcon className="mb-3 size-8 stroke-1 text-faint/70" />
          <h2 className="text-[15px] font-semibold">No activity in this period</h2>
          <p className="mt-1 max-w-md text-[13px] text-muted-foreground">
            Nothing was opened, closed, commented on or changed from {rangeText}. Try a longer period{report.period.projectId ? " or all projects" : ""}
            {filtered ? " or everyone" : ""}.
          </p>
          <div className="mt-4 flex gap-2">
            <Button variant="outline" size="sm" onClick={() => go({ range: "30d", from: null, to: null, g: null })}>
              Last 30 days
            </Button>
            <Button variant="outline" size="sm" onClick={() => go({ range: "12m", from: null, to: null, g: null })}>
              Last 12 months
            </Button>
            {report.period.projectId ? (
              <Button variant="outline" size="sm" onClick={() => go({ project: null })}>
                All projects
              </Button>
            ) : null}
            {filtered ? (
              <Button variant="outline" size="sm" onClick={() => go({ person: null, bot: null })}>
                Everyone
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <>
          <div className="grid gap-3 lg:grid-cols-2">
            <TimeSeriesChart
              title="Opened vs closed"
              description={`Tasks created and tasks moved to done or cancelled, per ${UNIT_WORDS[g]}`}
              data={series}
              series={[
                { key: "opened", label: "Opened", color: 1 },
                { key: "closed", label: "Closed", color: 2 },
              ]}
              granularity={g}
              loading={loading}
            />
            <TimeSeriesChart
              title="Backlog"
              description={`Open tasks at the end of each ${UNIT_WORDS[g]}: ${formatNumber(tickets.backlog.start)} at the start, ${formatNumber(tickets.backlog.end)} at the end`}
              data={series}
              series={[{ key: "backlog", label: "Open tasks", color: 3, summary: "level" }]}
              variant="area"
              granularity={g}
              loading={loading}
            />
            <TimeSeriesChart
              title="Messages"
              description={`Comments per ${UNIT_WORDS[g]} by people and bots`}
              data={series}
              series={[
                { key: "people", label: "People", color: 1 },
                { key: "bots", label: "Bots", color: 4 },
              ]}
              stacked
              granularity={g}
              loading={loading}
            />
            <BarChart
              title="Interactions by kind"
              description="Status changes, assignments, mentions, dependency edits and bot work"
              data={kinds}
              categoryKey="kind"
              categoryLabel="Kind"
              series={[
                { key: "people", label: "People", color: 1 },
                { key: "bots", label: "Bots", color: 4 },
              ]}
              stacked
              horizontal
              categoryWidth={124}
              loading={loading}
            />
          </div>

          <section aria-labelledby="analytics-projects" className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <BarChart
              title="By project"
              description="Opened and closed in the period"
              data={projectBars}
              categoryKey="project"
              categoryLabel="Project"
              series={[
                { key: "opened", label: "Opened", color: 1 },
                { key: "closed", label: "Closed", color: 2 },
              ]}
              horizontal
              categoryWidth={124}
              loading={loading}
            />
            <Panel id="analytics-projects" title="Project breakdown" subtitle={rangeText} loading={loading}>
              <div className="min-w-[620px]">
                <DataTable
                  caption={`Project breakdown, ${rangeText}`}
                  rows={projectRows}
                  columns={[
                    { label: "Project", cell: (p) => <ProjectName name={p.project.name} color={p.project.color} /> },
                    { label: "Opened", numeric: true, cell: (p) => <Num v={p.opened.total} prev={compare ? p.opened.previous : null} /> },
                    { label: "Closed", numeric: true, cell: (p) => <Num v={p.closed.total} prev={compare ? p.closed.previous : null} /> },
                    { label: "Open at end", numeric: true, cell: (p) => <Num v={p.backlog.end} prev={compare ? p.backlog.start : null} /> },
                    { label: "Median cycle", numeric: true, cell: (p) => (p.cycleTime.medianMs == null ? "–" : formatDuration(p.cycleTime.medianMs)) },
                    { label: "Comments", numeric: true, cell: (p) => <Num v={p.comments.total} prev={compare ? p.comments.previous : null} /> },
                    { label: "Interactions", numeric: true, cell: (p) => <Num v={p.interactions.total} prev={compare ? p.interactions.previous : null} /> },
                  ]}
                />
              </div>
            </Panel>
          </section>

          <section aria-label="Contributors" className="grid gap-3 lg:grid-cols-2">
            {/* Filtered to one contributor: only their own table (the other would always be empty). */}
            {report.period.contributor?.kind !== "bot" ? <Contributors title="Top people" rows={report.contributors.people} rangeText={rangeText} loading={loading} /> : null}
            {report.period.contributor?.kind !== "user" ? <Contributors title="Top bots" rows={report.contributors.bots} rangeText={rangeText} loading={loading} /> : null}
          </section>
        </>
      )}

      <section aria-label="Tasks right now" className="grid gap-3 md:grid-cols-3">
        <DonutChart title="By stage" description="All unarchived tasks right now" data={stage} centerLabel="tasks" loading={loading} />
        <DonutChart title="Open by priority" description="Open tasks right now" data={priority} centerLabel="open" loading={loading} />
        <DonutChart title="Open by type" description="Open tasks right now" data={type} centerLabel="open" loading={loading} />
      </section>
    </>
  );
}

function Panel({ id, title, subtitle, loading, children }: { id?: string; title: string; subtitle?: string; loading?: boolean; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} aria-busy={loading || undefined} className="flex min-w-0 flex-col rounded-[10px] border border-border bg-background">
      <header className="px-4 pt-3.5 pb-2">
        <h3 id={id} className="truncate text-[13.5px] font-semibold tracking-[-0.01em]">
          {title}
        </h3>
        {subtitle ? <p className="mt-0.5 text-[12.5px] text-muted-foreground">{subtitle}</p> : null}
      </header>
      <div className="min-w-0 overflow-x-auto px-4 pb-3">
        {loading ? (
          <div aria-hidden className="flex flex-col gap-2 py-1">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="h-5 rounded-[4px] bg-muted" />
            ))}
          </div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

function ProjectName({ name, color }: { name: string; color: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="size-2 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
      {name}
    </span>
  );
}

function Num({ v, prev }: { v: number; prev: number | null }) {
  return (
    <span className="whitespace-nowrap">
      {formatNumber(v)}
      {prev != null ? <span className="ml-1.5 text-faint">was {formatNumber(prev)}</span> : null}
    </span>
  );
}

const CONTRIBUTOR_ROWS = 10;

function Contributors({ title, rows, rangeText, loading }: { title: string; rows: AnalyticsContributor[]; rangeText: string; loading: boolean }) {
  const { memberById } = useOrg();
  const columns: DataTableColumn<AnalyticsContributor>[] = [
    { label: "Name", cell: (c) => memberById.get(c.id)?.name ?? c.name },
    { label: "Closed", numeric: true, cell: (c) => formatNumber(c.tasksClosed) },
    { label: "Comments", numeric: true, cell: (c) => formatNumber(c.comments) },
    { label: "Interactions", numeric: true, cell: (c) => formatNumber(c.interactions) },
  ];
  return (
    <Panel id={`analytics-${title.replace(/\s+/g, "-").toLowerCase()}`} title={title} subtitle={rangeText} loading={loading}>
      {rows.length ? (
        <DataTable caption={`${title}, ${rangeText}`} rows={rows.slice(0, CONTRIBUTOR_ROWS)} columns={columns} />
      ) : (
        <p className="py-6 text-center text-[13px] text-faint">Nobody in this period</p>
      )}
    </Panel>
  );
}

/** Route-level skeleton (loading.tsx) in the same layout as the screen. */
export function AnalyticsSkeleton() {
  return (
    <div className="flex min-w-0 flex-1 flex-col" aria-busy>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 sm:px-7">
        <MobileNavButton />
        <h1 className="truncate text-[15px] font-semibold tracking-[-0.01em]">Analytics</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-4 px-4 pt-4 pb-16 sm:px-7">
          <div aria-hidden className="flex flex-wrap gap-2">
            <div className="h-[32px] w-[420px] max-w-full rounded-[8px] bg-muted" />
            <div className="h-[32px] w-[150px] rounded-[8px] bg-muted" />
            <div className="h-[32px] w-[190px] rounded-[8px] bg-muted" />
          </div>
          <div aria-hidden className="h-4 w-80 max-w-full rounded-[4px] bg-muted" />
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {["Opened", "Closed", "Net backlog", "Median cycle time", "Comments", "Interactions"].map((l) => (
              <KpiTile key={l} label={l} value={null} loading />
            ))}
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            {["Opened vs closed", "Backlog", "Messages", "Interactions by kind"].map((t) => (
              <TimeSeriesChart key={t} title={t} data={[]} series={[]} loading />
            ))}
          </div>
          <span className="sr-only">Loading analytics</span>
        </div>
      </div>
    </div>
  );
}
