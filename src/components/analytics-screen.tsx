"use client";

import { useEffect, useMemo, useOptimistic, useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { BotIcon, CalendarRangeIcon, ChartNoAxesColumnIcon, UserIcon, XIcon } from "lucide-react";
import { ProjectDot } from "@/components/bits";
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
import { AnalyticsCard, BarChart, DataTable, DonutChart, KpiTile, TimeSeriesChart, formatNumber, type DataTableColumn, type DonutSlice } from "@/components/analytics";
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

  // The controls show the requested filters at once (optimistic) while the server computes the report;
  // the figures on screen stay, dimmed, until the new ones arrive, so nothing collapses into skeletons.
  const [shown, setShown] = useOptimistic(view);
  const go = (patch: Partial<AnalyticsParams>) => {
    const next = { ...shown, ...patch };
    start(() => {
      setShown(next);
      router.push(`${pathname}${analyticsSearch(next)}`, { scroll: false });
    });
  };
  // "Right now" figures only depend on the project and contributor filters, not on the period.
  const scopeChanging = pending && (shown.project !== view.project || shown.person !== view.person || shown.bot !== view.bot);

  const from = new Date(report.period.from);
  const to = new Date(report.period.to);
  const rangeText = formatRange(from, to, tz);
  const prevText = formatRange(new Date(report.previous.from), new Date(report.previous.to), tz);
  const g = report.period.granularity;

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <PageHeader>
        <AnalyticsExportButton report={report} filters={{ project: view.project, person: view.person, bot: view.bot }} />
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto" data-analytics-scroll>
        <div className={PAGE_BODY}>
          <div className="flex flex-col gap-3">
            <Controls view={shown} report={report} go={go} whoName={whoName} />
            <div className="flex flex-col gap-0.5 text-[13px]" aria-live="polite">
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
          </div>
          <Report report={report} compare={view.compare} dim={pending} dimNow={scopeChanging} rangeText={rangeText} go={go} filtered={!!who} />
        </div>
      </div>
    </div>
  );
}

/** Page body: one rhythm for the whole screen (24px between sections, 8px heading to content, 12px in grids). */
const PAGE_BODY = "mx-auto flex max-w-[1400px] flex-col gap-6 px-4 pt-5 pb-16 sm:px-7";

/** The 56px view header every column starts with (same as the task list and settings). */
function PageHeader({ children }: { children?: React.ReactNode }) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 sm:px-7">
      <MobileNavButton />
      <h1 className="truncate text-[15px] font-semibold tracking-[-0.01em]">Analytics</h1>
      <div className="ml-auto flex items-center gap-3">{children}</div>
    </header>
  );
}

/** A named group of cards: a group-label heading (as on status groups) over its grid. */
function Section({ id, title, note, dim, children }: { id: string; title: string; note?: string; dim?: boolean; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} aria-busy={dim || undefined} data-analytics-section={id} className="flex min-w-0 flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h2 id={id} className="text-[12.5px] font-semibold">
          {title}
        </h2>
        {note ? <span className="text-[11.5px] font-medium text-faint">{note}</span> : null}
      </div>
      <div className={cn("flex min-w-0 flex-col gap-3 transition-opacity duration-200", dim && "opacity-55")}>{children}</div>
    </section>
  );
}

/** "14:02:31" in `tz`, for the live-update stamp. */
function formatClock(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

/* ---------------- controls ---------------- */

/** Focus treatment shared with Button, Select and Switch: blue border plus a 3px ring. */
const FOCUS = "outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

function Controls({ view, report, go, whoName }: { view: AnalyticsParams; report: AnalyticsReport; go: (p: Partial<AnalyticsParams>) => void; whoName: string | null }) {
  const { projects } = useOrg();
  const tz = report.period.tz;
  const from = new Date(report.period.from);
  const to = new Date(report.period.to);
  const allowed = allowedGranularities(from, to);
  const listed = projects.filter((p) => !p.archived || p.key === view.project);

  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Report filters" data-analytics-controls>
      <PeriodPicker view={view} from={from} to={to} tz={tz} go={go} />
      <Select value={view.g ? report.period.granularity : "auto"} onValueChange={(v) => go({ g: isAnalyticsGranularity(v) ? v : null })}>
        <SelectTrigger aria-label="Granularity">
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
        <SelectTrigger aria-label="Project" className="max-w-[240px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All projects</SelectItem>
          {listed.map((p) => (
            <SelectItem key={p.id} value={p.key}>
              <ProjectDot color={p.color} />
              {p.name}
              {p.archived ? " (archived)" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {whoName ? (
        <button
          type="button"
          onClick={() => go({ person: null, bot: null })}
          data-analytics-contributor={report.period.contributor?.id}
          className={cn(
            "flex h-7 max-w-full items-center gap-1.5 rounded-[7.2px] border border-border bg-background px-2.5 text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            FOCUS,
          )}
          aria-label={`Showing ${whoName} only. Show everyone`}
          title="Show everyone"
        >
          {report.period.contributor?.kind === "bot" ? <BotIcon className="size-3.5" /> : <UserIcon className="size-3.5" />}
          <span className="max-w-[180px] truncate font-medium text-foreground">{whoName}</span>
          <XIcon className="size-3.5 text-faint" />
        </button>
      ) : null}
      <label className="flex h-8 sm:ml-auto items-center gap-2 text-[13px] whitespace-nowrap text-muted-foreground">
        <Switch checked={view.compare} onCheckedChange={(c) => go({ compare: c })} aria-label="Compare with the previous period" />
        Compare with previous period
      </label>
    </div>
  );
}

const SEGMENT = cn("flex h-[22px] shrink-0 items-center gap-1.5 rounded-full border border-transparent px-2 text-[12.5px] whitespace-nowrap transition-colors", FOCUS);
const segmentState = (active: boolean) => (active ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground");

/**
 * Period presets as the pill segmented control the task list uses for its type filter. One Tab stop
 * (roving tabindex); arrow keys, Home and End move between presets and pick them, as in a radio group.
 * Custom opens its range form instead of applying anything.
 */
function PeriodPicker({ view, from, to, tz, go }: { view: AnalyticsParams; from: Date; to: Date; tz: string; go: (p: Partial<AnalyticsParams>) => void }) {
  const presets = ANALYTICS_PRESETS.filter((p) => p.id !== "custom");
  const ids: AnalyticsPreset[] = [...presets.map((p) => p.id), "custom"];
  const pick = (id: AnalyticsPreset) => go({ range: id, from: null, to: null, g: null });

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
    if (!keys.includes(e.key)) return;
    const current = (e.target as HTMLElement).closest<HTMLElement>("[data-preset]")?.dataset.preset as AnalyticsPreset | undefined;
    const i = current ? ids.indexOf(current) : ids.indexOf(view.range);
    const n = ids.length;
    const next = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i - 1 + n) % n : (i + 1) % n;
    e.preventDefault();
    e.currentTarget.querySelector<HTMLElement>(`[data-preset="${ids[next]}"]`)?.focus();
    if (ids[next] !== "custom") pick(ids[next]);
  };

  return (
    <div className="-m-1 max-w-[calc(100%+0.5rem)] overflow-x-auto p-1 [scrollbar-width:none]">
      <div className="flex w-max items-center rounded-full border border-input p-0.5" role="radiogroup" aria-label="Period" onKeyDown={onKeyDown}>
        {presets.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={view.range === p.id}
            tabIndex={view.range === p.id ? 0 : -1}
            data-preset={p.id}
            onClick={() => pick(p.id)}
            className={cn(SEGMENT, segmentState(view.range === p.id))}
          >
            {p.label}
          </button>
        ))}
        <CustomRange active={view.range === "custom"} from={from} to={to} tz={tz} onApply={(f, t) => go({ range: "custom", from: f.toISOString(), to: t.toISOString(), g: null })} />
      </div>
    </div>
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
        <button type="button" role="radio" aria-checked={active} tabIndex={active ? 0 : -1} data-preset="custom" className={cn(SEGMENT, segmentState(active))}>
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
          <p className={cn("text-[13px]", error ? "text-destructive" : "text-faint")}>{error ?? `Times are in ${tz}.`}</p>
          <Button type="submit" disabled={!!error}>
            Apply range
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/* ---------------- report ---------------- */

const KIND_LABELS = ["Status changes", "Assignments", "Mentions", "Dependency edits", "Bot pickups", "Bot completions"] as const;

/**
 * Every section of the screen. With `report` null it renders the same sections, titles and card sizes as
 * loading placeholders, so the route skeleton (loading.tsx) and the real page share one layout.
 */
function Report({
  report,
  compare = false,
  dim = false,
  dimNow = false,
  rangeText = "",
  go,
  filtered = false,
}: {
  report: AnalyticsReport | null;
  compare?: boolean;
  /** A new report is on its way: keep these figures, dimmed. */
  dim?: boolean;
  /** The project or contributor filter is changing, so the right-now figures are stale too. */
  dimNow?: boolean;
  rangeText?: string;
  go?: (p: Partial<AnalyticsParams>) => void;
  /** Limited to one person or bot. */
  filtered?: boolean;
}) {
  const { projects, members, memberById } = useOrg();
  const loading = !report;
  const g = report?.period.granularity ?? "day";
  const prev = <T,>(v: T) => (compare ? v : undefined);
  const tickets = report?.tickets;
  const messages = report?.messages;
  const interactions = report?.interactions;
  const breakdown = report?.breakdown;
  const net = tickets ? tickets.backlog.end - tickets.backlog.start : null;
  const netPrev = tickets ? tickets.backlog.start - tickets.backlog.previousStart : null;
  const empty =
    !!tickets && !!messages && !!interactions && tickets.opened.total + tickets.closed.total + tickets.reopened.total + messages.comments.total + interactions.total.total === 0;

  const series = useMemo(
    () =>
      report
        ? report.buckets.map((t, i) => ({
            t,
            opened: report.tickets.opened.series[i] ?? 0,
            closed: report.tickets.closed.series[i] ?? 0,
            backlog: report.tickets.backlog.series[i] ?? 0,
            people: report.messages.comments.people.series[i] ?? 0,
            bots: report.messages.comments.bots.series[i] ?? 0,
          }))
        : [],
    [report],
  );

  const kinds = KIND_LABELS.map((kind) => {
    if (!interactions) return { kind, people: 0, bots: 0 };
    const pair = {
      "Status changes": [interactions.statusChanges.people.total, interactions.statusChanges.bots.total],
      Assignments: [interactions.assignments.people.total, interactions.assignments.bots.total],
      Mentions: [interactions.mentions.people.total, interactions.mentions.bots.total],
      "Dependency edits": [interactions.dependencyEdits.people.total, interactions.dependencyEdits.bots.total],
      "Bot pickups": [0, interactions.botPickups.total],
      "Bot completions": [0, interactions.botCompletions.total],
    }[kind];
    return { kind, people: pair[0], bots: pair[1] };
  });

  const stage: DonutSlice[] = breakdown ? STATUS_STAGES.map((s) => ({ key: s, label: STAGE_LABELS[s], value: breakdown.byStage[s] ?? 0 })) : [];
  const priority: DonutSlice[] = breakdown ? breakdown.byPriority.map((r) => ({ key: String(r.key), label: PRIORITY_LABELS[r.key], value: r.open })) : [];
  const type: DonutSlice[] = breakdown ? breakdown.byType.map((r) => ({ key: r.key, label: TYPE_LABELS[r.key], value: r.open })) : [];

  const projectRows = report
    ? report.projects
        .filter((p) => p.opened.total + p.closed.total + p.comments.total + p.interactions.total + p.backlog.end > 0 || report.projects.length === 1)
        .sort((a, b) => b.opened.total + b.closed.total - (a.opened.total + a.closed.total) || a.project.name.localeCompare(b.project.name))
    : [];
  // Skeleton: one placeholder bar per active project, so the card keeps roughly its real height.
  const projectBars = report
    ? projectRows.map((p) => ({ project: p.project.name, opened: p.opened.total, closed: p.closed.total }))
    : projects.filter((p) => !p.archived).map((p) => ({ project: p.name, opened: 0, closed: 0 }));
  const vs = compare ? "vs previous" : undefined;
  const who = report?.period.contributor;

  const projectColumns: DataTableColumn<(typeof projectRows)[number]>[] = [
    { label: "Project", cell: (p) => <ProjectName name={p.project.name} color={p.project.color} /> },
    { label: "Opened", numeric: true, cell: (p) => <Num v={p.opened.total} prev={compare ? p.opened.previous : null} /> },
    { label: "Closed", numeric: true, cell: (p) => <Num v={p.closed.total} prev={compare ? p.closed.previous : null} /> },
    { label: "Open, start → end", numeric: true, cell: (p) => `${formatNumber(p.backlog.start)} → ${formatNumber(p.backlog.end)}` },
    { label: "Median cycle", numeric: true, cell: (p) => (p.cycleTime.medianMs == null ? "–" : formatDuration(p.cycleTime.medianMs)) },
    { label: "Comments", numeric: true, cell: (p) => <Num v={p.comments.total} prev={compare ? p.comments.previous : null} /> },
    { label: "Interactions", numeric: true, cell: (p) => <Num v={p.interactions.total} prev={compare ? p.interactions.previous : null} /> },
  ];
  // Phones get the four columns that fit, without the comparison; the full table needs about 620px.
  const narrowColumns: DataTableColumn<(typeof projectRows)[number]>[] = [
    projectColumns[0],
    { label: "Opened", numeric: true, cell: (p) => formatNumber(p.opened.total) },
    { label: "Closed", numeric: true, cell: (p) => formatNumber(p.closed.total) },
    { label: "Open", numeric: true, cell: (p) => formatNumber(p.backlog.end) },
  ];

  const rightNow = (
    <Section id="analytics-now" title="Right now" note="Current tasks, not limited to the period" dim={dimNow}>
      <div className="grid gap-3 md:grid-cols-3">
        {/* Legends reserve room for the longest dimension (stages) so the three cards line up;
            the empty copy doesn't mention the period, which this section isn't limited to. */}
        <DonutChart title="By stage" description="All unarchived tasks" data={stage} centerLabel="tasks" loading={loading} legendItems={STATUS_STAGES.length} emptyMessage="No tasks right now" />
        <DonutChart title="Open by priority" description="Open tasks" data={priority} centerLabel="open" loading={loading} legendItems={STATUS_STAGES.length} emptyMessage="No open tasks right now" />
        <DonutChart title="Open by type" description="Open tasks" data={type} centerLabel="open" loading={loading} legendItems={STATUS_STAGES.length} emptyMessage="No open tasks right now" />
      </div>
    </Section>
  );

  if (empty && report) {
    return (
      <>
        <Section id="analytics-period" title="This period" dim={dim}>
          <AnalyticsEmpty report={report} rangeText={rangeText} filtered={filtered} go={go} />
        </Section>
        {rightNow}
      </>
    );
  }

  return (
    <>
      <Section id="analytics-period" title="This period" dim={dim}>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" role="group" aria-label="Key figures">
          <KpiTile label="Opened" value={tickets?.opened.total ?? null} previous={prev(tickets?.opened.previous)} goodDirection="neutral" comparisonLabel={vs} loading={loading} />
          <KpiTile label="Closed" value={tickets?.closed.total ?? null} previous={prev(tickets?.closed.previous)} comparisonLabel={vs} loading={loading} />
          <KpiTile label="Net backlog" value={net} previous={prev(netPrev ?? undefined)} goodDirection="down" format={signed} deltaFormat={formatNumber} comparisonLabel={vs} loading={loading} />
          <KpiTile
            label="Median cycle time"
            value={tickets?.cycleTime.medianMs ?? null}
            previous={prev(tickets?.cycleTime.previous.medianMs)}
            goodDirection="down"
            format={formatDuration}
            comparisonLabel={vs}
            loading={loading}
          />
          <KpiTile label="Comments" value={messages?.comments.total ?? null} previous={prev(messages?.comments.previous)} comparisonLabel={vs} loading={loading} />
          <KpiTile label="Interactions" value={interactions?.total.total ?? null} previous={prev(interactions?.total.previous)} goodDirection="neutral" comparisonLabel={vs} loading={loading} />
        </div>
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
            description={
              tickets
                ? `Open tasks at the end of each ${UNIT_WORDS[g]}: ${formatNumber(tickets.backlog.start)} at the start, ${formatNumber(tickets.backlog.end)} at the end`
                : `Open tasks at the end of each ${UNIT_WORDS[g]}`
            }
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
      </Section>

      <Section id="analytics-projects" title="Projects" dim={dim}>
        <BarChart
          title="By project"
          description="Tasks opened and closed in each project"
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
        <Panel title="Project breakdown" subtitle="Tasks opened, closed and open, cycle time, comments and interactions per project" loading={loading} rows={projectBars.length}>
          <div className="max-sm:hidden">
            <div className="min-w-[620px]">
              <DataTable caption={`Project breakdown, ${rangeText}`} rows={projectRows} columns={projectColumns} />
            </div>
          </div>
          <div className="sm:hidden">
            <DataTable caption={`Project breakdown, ${rangeText}`} rows={projectRows} columns={narrowColumns} />
          </div>
        </Panel>
      </Section>

      <Section id="analytics-contributors" title="Contributors" dim={dim}>
        <div className="grid items-start gap-3 lg:grid-cols-2">
          {/* Filtered to one contributor: only their own table (the other would always be empty). */}
          {who?.kind !== "bot" ? (
            <Contributors title="Top people" rows={report?.contributors.people ?? []} rangeText={rangeText} loading={loading} memberById={memberById} skeletonRows={members.filter((m) => m.kind !== "bot").length} />
          ) : null}
          {who?.kind !== "user" ? (
            <Contributors title="Top bots" rows={report?.contributors.bots ?? []} rangeText={rangeText} loading={loading} memberById={memberById} skeletonRows={members.filter((m) => m.kind === "bot").length} />
          ) : null}
        </div>
      </Section>

      {rightNow}
    </>
  );
}

/** Nothing happened in the period: the task list's empty-state treatment, with ways to widen the view. */
function AnalyticsEmpty({ report, rangeText, filtered, go }: { report: AnalyticsReport; rangeText: string; filtered: boolean; go?: (p: Partial<AnalyticsParams>) => void }) {
  return (
    <div role="status" className="mx-auto flex max-w-md flex-col items-center py-14 text-center" data-analytics-empty>
      <ChartNoAxesColumnIcon className="mb-4 size-9 stroke-1 text-faint/60" />
      <h3 className="text-[15px] font-semibold">No activity in this period</h3>
      <p className="mt-1 text-[13.5px] text-muted-foreground">
        Nothing was opened, closed, commented on or changed from {rangeText}. Try a longer period{report.period.projectId ? " or all projects" : ""}
        {filtered ? " or everyone" : ""}.
      </p>
      {go ? (
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Button variant="outline" onClick={() => go({ range: "30d", from: null, to: null, g: null })}>
            Last 30 days
          </Button>
          <Button variant="outline" onClick={() => go({ range: "12m", from: null, to: null, g: null })}>
            Last 12 months
          </Button>
          {report.period.projectId ? (
            <Button variant="outline" onClick={() => go({ project: null })}>
              All projects
            </Button>
          ) : null}
          {filtered ? (
            <Button variant="outline" onClick={() => go({ person: null, bot: null })}>
              Everyone
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** A table card on the shared AnalyticsCard (VEC-144), with a skeleton the height of the table it stands in for. */
function Panel({ title, subtitle, loading, rows = 5, children }: { title: string; subtitle?: string; loading?: boolean; rows?: number; children: React.ReactNode }) {
  return (
    <AnalyticsCard
      title={title}
      description={subtitle}
      loading={loading}
      bodyClassName="overflow-x-auto"
      skeleton={
        // Header row plus body rows at the DataTable's measured heights (27px and 33px).
        <div aria-hidden className="flex flex-col">
          <div className="flex h-[27px] items-center border-b border-border">
            <div className="h-2.5 w-1/3 rounded-sm bg-muted" />
          </div>
          {Array.from({ length: Math.max(1, rows) }, (_, i) => (
            <div key={i} className="flex h-[33px] items-center border-b border-border last:border-0">
              <div className="h-3 rounded-sm bg-muted" style={{ width: `${72 - (i % 5) * 9}%` }} />
            </div>
          ))}
        </div>
      }
    >
      {children}
    </AnalyticsCard>
  );
}

function ProjectName({ name, color }: { name: string; color: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <ProjectDot color={color} />
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

type ContributorRow = AnalyticsContributor & { count?: number };

/** Bots deleted since (no name left) are folded into one "Deleted bots (N)" row at the first one's place. */
function foldDeletedBots(rows: AnalyticsContributor[], known: (id: string) => boolean): ContributorRow[] {
  const out: ContributorRow[] = [];
  let group: ContributorRow | null = null;
  for (const r of rows) {
    if (r.kind === "bot" && !known(r.id) && r.name === "Deleted bot") {
      if (!group) {
        group = { ...r, id: "deleted-bots", count: 0, tasksClosed: 0, done: 0, cancelled: 0, comments: 0, interactions: 0 };
        out.push(group);
      }
      group.count = (group.count ?? 0) + 1;
      group.tasksClosed += r.tasksClosed;
      group.done += r.done;
      group.cancelled += r.cancelled;
      group.comments += r.comments;
      group.interactions += r.interactions;
    } else out.push(r);
  }
  return out;
}

function Contributors({
  title,
  rows,
  rangeText,
  loading,
  memberById,
  skeletonRows,
}: {
  title: string;
  rows: AnalyticsContributor[];
  rangeText: string;
  loading: boolean;
  memberById: ReturnType<typeof useOrg>["memberById"];
  /** Rows the loading placeholder reserves (the org's people or bots, capped like the table). */
  skeletonRows: number;
}) {
  const shown = foldDeletedBots(rows, (id) => memberById.has(id)).slice(0, CONTRIBUTOR_ROWS);
  const columns: DataTableColumn<ContributorRow>[] = [
    { label: "Name", cell: (c) => (c.count != null ? (c.count > 1 ? `Deleted bots (${c.count})` : "Deleted bot") : (memberById.get(c.id)?.name ?? c.name)) },
    { label: "Closed", numeric: true, cell: (c) => formatNumber(c.tasksClosed) },
    { label: "Comments", numeric: true, cell: (c) => formatNumber(c.comments) },
    { label: "Interactions", numeric: true, cell: (c) => formatNumber(c.interactions) },
  ];
  return (
    <Panel title={title} subtitle="Tasks closed, comments and interactions in the period" loading={loading} rows={Math.min(CONTRIBUTOR_ROWS, skeletonRows)}>
      {shown.length ? (
        <DataTable caption={`${title}, ${rangeText}`} rows={shown} columns={columns} />
      ) : (
        <p className="py-6 text-center text-[13px] text-faint">Nobody in this period</p>
      )}
    </Panel>
  );
}

/** Route-level skeleton (loading.tsx): the real header, control row and sections with loading cards. */
export function AnalyticsSkeleton() {
  return (
    <div className="flex min-w-0 flex-1 flex-col" aria-busy>
      <PageHeader>
        <div aria-hidden className="h-[30px] w-[30px] rounded-lg bg-muted sm:w-[116px]" />
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={PAGE_BODY}>
          <div aria-hidden className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="h-7 w-[352px] max-w-full rounded-full bg-muted" />
              <div className="h-8 w-[132px] rounded-lg bg-muted" />
              <div className="h-8 w-[118px] rounded-lg bg-muted" />
              <div className="ml-auto h-8 w-[232px] rounded-lg bg-muted" />
            </div>
            {/* The summary: range line plus the comparison line (Compare is on by default); phones wrap it to four. */}
            <div className="flex flex-col gap-0.5">
              {[
                ["w-[440px]", ""],
                ["w-[300px] max-sm:w-[220px]", ""],
                ["w-[260px]", "sm:hidden"],
                ["w-[180px]", "sm:hidden"],
              ].map(([w, row]) => (
                <div key={w} className={cn("flex h-[19.5px] items-center", row)}>
                  <div className={cn("h-3 max-w-full rounded-sm bg-muted", w)} />
                </div>
              ))}
            </div>
          </div>
          <Report report={null} />
          <span className="sr-only">Loading analytics</span>
        </div>
      </div>
    </div>
  );
}
