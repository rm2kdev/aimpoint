import "server-only";
import { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { UserError } from "@/lib/result";
import { autoGranularity } from "@/lib/analytics-range";
import { isTimeZone, isoWithOffset, nextBucketStart, zonedParts, zonedTime } from "@/lib/analytics-time";
import { STAGE_LABELS } from "@/lib/stages";
import { PRIORITY_LABELS, TYPE_LABELS } from "@/lib/format";
import type { ZipEntry } from "@/lib/zip";
import {
  ANALYTICS_GRANULARITIES,
  DEFAULT_ANALYTICS_TZ,
  STATUS_STAGES,
  isAnalyticsGranularity,
  type AnalyticsCount,
  type AnalyticsDuration,
  type AnalyticsQuery,
  type AnalyticsReport,
  type AnalyticsSplitCount,
  type ProjectDoc,
} from "@/lib/types";

/**
 * Reporting export (VEC-136): the params shared by the CSV download, `GET /api/v1/analytics` and the MCP
 * `get_analytics` tool, and the CSV rendering of an AnalyticsReport. Every number comes from VEC-132's
 * `computeAnalytics`; nothing here recomputes a metric.
 */

const DAY = 86_400_000;
/** Longest period an export or API call may cover, the same as the screen's custom range. */
export const MAX_EXPORT_DAYS = 3660;
const DEFAULT_DAYS = 30;

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/i;

/** Raw params as they arrive from a query string or MCP arguments. */
export interface AnalyticsExportParams {
  from?: unknown;
  to?: unknown;
  granularity?: unknown;
  project?: unknown;
  /** A person's or bot's id: limit the report to them (VEC-135's contributor filter). */
  person?: unknown;
  bot?: unknown;
  tz?: unknown;
}

/** Shared description of the params (MCP schema + REST docs). */
export const ANALYTICS_PARAM_DOCS = {
  from: "Start of the period, inclusive: an ISO 8601 date-time with an offset (2026-11-01T00:00:00+08:00, or Z) or a date (2026-11-01 = midnight in `tz`). Default: 30 days before `to`.",
  to: "End of the period, exclusive for a date-time; a date (2026-11-30) includes that whole day. Default: now.",
  granularity: "Bucket size for the series: hour, day, week (Monday start) or month. Default: picked from the period's length (hour up to 2 days, day up to 100 days, week up to 200 days, then month). At most 3000 buckets.",
  project: "Limit the report to one project, by key (WEB) or id. Default: all projects.",
  person: "Limit the report to one person, by user id (from get_workspace): tasks they opened and closed, their comments and interactions; backlog, open-task age and tasks-right-now count tasks assigned to them.",
  bot: "Limit the report to one bot, by id, the same way as `person`. Use one of `person` / `bot`.",
  tz: "IANA timezone the buckets are cut in, e.g. Australia/Perth (the default) or Europe/London.",
} as const;

const text = (v: unknown, name: string): string | null => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw new UserError(`\`${name}\` must be a string.`);
  return v.trim() || null;
};

function parseInstant(raw: string, name: "from" | "to", tz: string): Date {
  const d = DATE_ONLY.exec(raw);
  if (d) {
    const [y, mo, day] = [+d[1], +d[2], +d[3]];
    const check = new Date(Date.UTC(y, mo - 1, day));
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== day) throw new UserError(`\`${name}\` "${raw}" isn't a real date.`);
    // A date-only `to` means the whole of that day, so the period ends at the next local midnight.
    return zonedTime(y, mo, day + (name === "to" ? 1 : 0), 0, tz);
  }
  if (DATE_TIME.test(raw)) {
    const t = new Date(raw);
    if (!Number.isNaN(t.getTime())) return t;
  }
  throw new UserError(`\`${name}\` "${raw}" isn't a valid ISO 8601 date (2026-11-01) or date-time with an offset (2026-11-01T00:00:00+08:00).`);
}

/**
 * Validates export/API params into a query for `computeAnalytics`. Bad input is a UserError with a readable
 * message (REST 400, MCP tool error): unknown project, from >= to, range over MAX_EXPORT_DAYS, unknown
 * granularity or timezone, unparseable dates. Too many buckets is refused by the data layer the same way.
 */
export async function resolveAnalyticsExport(orgId: ObjectId, raw: AnalyticsExportParams, now: Date = new Date()): Promise<{ query: AnalyticsQuery; project: ProjectDoc | null }> {
  const tz = text(raw.tz, "tz") ?? DEFAULT_ANALYTICS_TZ;
  if (!isTimeZone(tz)) throw new UserError(`Unknown timezone "${tz}": use an IANA name such as Australia/Perth.`);

  const toRaw = text(raw.to, "to");
  const fromRaw = text(raw.from, "from");
  const to = toRaw ? parseInstant(toRaw, "to", tz) : now;
  const from = fromRaw ? parseInstant(fromRaw, "from", tz) : new Date(to.getTime() - DEFAULT_DAYS * DAY);
  if (!(from < to)) throw new UserError(`\`from\` (${from.toISOString()}) must be before \`to\` (${to.toISOString()}).`);
  if (to.getTime() - from.getTime() > MAX_EXPORT_DAYS * DAY) throw new UserError(`That range is too long: at most ${MAX_EXPORT_DAYS} days (10 years).`);

  const g = text(raw.granularity, "granularity");
  if (g && !isAnalyticsGranularity(g)) throw new UserError(`Unknown granularity "${g}": use ${ANALYTICS_GRANULARITIES.join(", ")}.`);
  const granularity = g && isAnalyticsGranularity(g) ? g : autoGranularity(from, to);

  let project: ProjectDoc | null = null;
  const ref = text(raw.project, "project");
  if (ref) {
    const c = await cols();
    project = /^[0-9a-f]{24}$/i.test(ref)
      ? await c.projects.findOne({ orgId, _id: new ObjectId(ref) })
      : await c.projects.findOne({ orgId, key: ref.toUpperCase() });
    if (!project) {
      const all = await c.projects.find({ orgId }, { projection: { key: 1 } }).sort({ createdAt: 1 }).toArray();
      throw new UserError(`Unknown project "${ref}". Projects: ${all.map((p) => p.key).join(", ")}.`);
    }
  }
  const person = text(raw.person, "person");
  const bot = text(raw.bot, "bot");
  if (person && bot) throw new UserError("Pass either `person` or `bot`, not both.");
  let contributorId: string | null = null;
  if (person || bot) {
    const id = (person ?? bot)!;
    const c = await cols();
    const oid = /^[0-9a-f]{24}$/i.test(id) ? new ObjectId(id) : null;
    const known = !oid
      ? false
      : person
        ? (await c.memberships.countDocuments({ orgId, userId: oid }, { limit: 1 })) > 0 || (await c.deletedUsers.countDocuments({ _id: oid, orgIds: orgId }, { limit: 1 })) > 0
        : (await c.bots.countDocuments({ orgId, _id: oid }, { limit: 1 })) > 0;
    if (!known) throw new UserError(person ? `Unknown person "${id}": use a member's user id.` : `Unknown bot "${id}": use a bot's id.`);
    contributorId = oid!.toHexString();
  }
  return { query: { from, to, granularity, tz, projectId: project?._id.toHexString() ?? null, contributorId }, project };
}

/* ---------------- CSV ---------------- */

/** One CSV cell: numbers as-is, text quoted when needed and guarded against spreadsheet formula injection. */
function cell(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "true" : "false";
  let s = v;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** UTF-8 BOM so Excel reads names as UTF-8; CRLF line ends per RFC 4180. */
const csv = (header: string[], rows: (string | number | boolean | null | undefined)[][]) =>
  "\uFEFF" + [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";

const hours = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : Math.round((ms / 3_600_000) * 100) / 100);

/** Local calendar date (YYYY-MM-DD) of an instant in `tz`, for file names. */
function localDate(d: Date, tz: string) {
  const p = zonedParts(d, tz);
  return `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

export function exportFileName(slug: string, report: AnalyticsReport, projectKey: string | null) {
  const tz = report.period.tz;
  const from = localDate(new Date(report.period.from), tz);
  const last = localDate(new Date(new Date(report.period.to).getTime() - 1), tz);
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "-");
  return `vector-analytics-${safe(slug)}-${from}_${last}${projectKey ? `-${safe(projectKey)}` : ""}.zip`;
}

const SUMMARY_HEADER = ["metric", "unit", "total", "people", "bots", "previous", "previous_people", "previous_bots"];
const split = (metric: string, c: AnalyticsSplitCount) => [metric, "count", c.total, c.people.total, c.bots.total, c.previous, c.people.previous, c.bots.previous];
const plain = (metric: string, c: AnalyticsCount) => [metric, "count", c.total, null, null, c.previous, null, null];
const dur = (metric: string, d: AnalyticsDuration & { previous: AnalyticsDuration }) => [
  [`${metric}_median`, "hours", hours(d.medianMs), null, null, hours(d.previous.medianMs), null, null],
  [`${metric}_p90`, "hours", hours(d.p90Ms), null, null, hours(d.previous.p90Ms), null, null],
  [`${metric}_count`, "tasks", d.count, null, null, d.previous.count, null, null],
];

const README = `Vector analytics export
=======================

Generated by Vector from the same report the Analytics screen shows for this filter (period, granularity,
project, timezone). Times are ISO 8601 with the timezone's offset. Counts follow the Analytics rules: archived
tasks are left out, "closed" means moved into a done or cancelled stage, people vs bots is who did it.

period.csv        key,value: the filter (from inclusive, to exclusive), timezone, granularity, project, contributor
                  (user:<id> / bot:<id> when limited to one person or bot, else everyone), previous period.
summary.csv       One row per metric for the whole period.
                  metric, unit (count | tasks | hours), total, people, bots, previous (the equal-length period
                  right before), previous_people, previous_bots. people/bots are blank where the metric isn't split.
                  Metrics: tickets_opened, tickets_closed, tickets_done, tickets_cancelled, tickets_reopened,
                  comments, interactions (sum of the next four plus bot pickups and completions), status_changes,
                  assignments, mentions, dependency_edits, bot_pickups, bot_completions, bots_mentioned,
                  backlog_start / backlog_end (open tasks at the start / end; previous = at the previous start),
                  cycle_time_median/_p90/_count (created -> closed, closes in the period),
                  open_age_median/_p90/_count (age of the tasks open at the end; previous = at the start).
timeseries.csv    One row per bucket: bucket_start, bucket_end (the first bucket can start before the period;
                  only events inside the period are counted), then the per-bucket value of each metric above
                  (_people / _bots splits where they exist), backlog_end = open at the bucket's end, and
                  cycle/open-age median and p90 in hours (blank = nothing to measure). Column sums equal the
                  summary totals.
projects.csv      One row per project in the filter: project_key, project_name, archived, opened, closed, done,
                  cancelled, comments, interactions (each with a _previous column), backlog_start, backlog_end,
                  cycle_time_median_hours, cycle_time_p90_hours, open_age_median_hours, open_age_p90_hours,
                  then open tasks now per stage (stage_backlog ... stage_cancelled = all tasks by stage now).
breakdown.csv     dimension (stage | priority | type), key, label, open (open now; for stage: every task in that
                  stage now), opened, closed (in the period; blank for stage).
contributors.csv  kind (user | bot), id, name, tasks_closed, done, cancelled, comments, interactions
                  (top 50 people and top 50 bots, ranked like the screen).
`;

/** The export's files: README.txt plus one CSV per report section. */
export function analyticsCsvFiles(report: AnalyticsReport, projectKey: string | null): ZipEntry[] {
  const tz = report.period.tz;
  const at = (iso: string) => isoWithOffset(new Date(iso), tz);
  const { tickets: t, messages: m, interactions: x } = report;

  const period = csv(
    ["key", "value"],
    [
      ["from", at(report.period.from)],
      ["to", at(report.period.to)],
      ["timezone", tz],
      ["granularity", report.period.granularity],
      ["project", projectKey ?? "all"],
      ["contributor", report.period.contributor ? `${report.period.contributor.kind}:${report.period.contributor.id}` : "everyone"],
      ["contributor_name", report.period.contributor?.name ?? null],
      ["previous_from", at(report.previous.from)],
      ["previous_to", at(report.previous.to)],
      ["generated_at", at(report.generatedAt)],
    ],
  );

  const summary = csv(SUMMARY_HEADER, [
    split("tickets_opened", t.opened),
    split("tickets_closed", t.closed),
    split("tickets_done", t.done),
    split("tickets_cancelled", t.cancelled),
    plain("tickets_reopened", t.reopened),
    split("comments", m.comments),
    split("interactions", x.total),
    split("status_changes", x.statusChanges),
    split("assignments", x.assignments),
    split("mentions", x.mentions),
    split("dependency_edits", x.dependencyEdits),
    plain("bot_pickups", x.botPickups),
    plain("bot_completions", x.botCompletions),
    plain("bots_mentioned", x.botsMentioned),
    ["backlog_start", "tasks", t.backlog.start, null, null, t.backlog.previousStart, null, null],
    ["backlog_end", "tasks", t.backlog.end, null, null, t.backlog.start, null, null],
    ...dur("cycle_time", t.cycleTime),
    ...dur("open_age", t.openAge),
  ]);

  const series: [string, number[] | (number | null)[]][] = [
    ["opened", t.opened.series],
    ["opened_people", t.opened.people.series],
    ["opened_bots", t.opened.bots.series],
    ["closed", t.closed.series],
    ["closed_people", t.closed.people.series],
    ["closed_bots", t.closed.bots.series],
    ["done", t.done.series],
    ["cancelled", t.cancelled.series],
    ["reopened", t.reopened.series],
    ["backlog_end", t.backlog.series],
    ["comments", m.comments.series],
    ["comments_people", m.comments.people.series],
    ["comments_bots", m.comments.bots.series],
    ["interactions", x.total.series],
    ["interactions_people", x.total.people.series],
    ["interactions_bots", x.total.bots.series],
    ["status_changes", x.statusChanges.series],
    ["assignments", x.assignments.series],
    ["mentions", x.mentions.series],
    ["dependency_edits", x.dependencyEdits.series],
    ["bot_pickups", x.botPickups.series],
    ["bot_completions", x.botCompletions.series],
    ["bots_mentioned", x.botsMentioned.series],
    ["cycle_time_median_hours", t.cycleTime.series.map(hours)],
    ["cycle_time_p90_hours", t.cycleTime.p90Series.map(hours)],
    ["open_age_median_hours", t.openAge.series.map(hours)],
    ["open_age_p90_hours", t.openAge.p90Series.map(hours)],
  ];
  const to = new Date(report.period.to);
  const timeseries = csv(
    ["bucket_start", "bucket_end", ...series.map(([k]) => k)],
    report.buckets.map((b, i) => {
      const start = new Date(b);
      const next = report.buckets[i + 1];
      const end = next ? new Date(next) : new Date(Math.min(nextBucketStart(start, report.period.granularity, tz).getTime(), to.getTime()));
      return [isoWithOffset(start, tz), isoWithOffset(end, tz), ...series.map(([, s]) => s[i] ?? null)];
    }),
  );

  const projects = csv(
    [
      "project_key",
      "project_name",
      "archived",
      ...["opened", "closed", "done", "cancelled", "comments", "interactions"].flatMap((k) => [k, `${k}_previous`]),
      "backlog_start",
      "backlog_end",
      "cycle_time_median_hours",
      "cycle_time_p90_hours",
      "open_age_median_hours",
      "open_age_p90_hours",
      ...STATUS_STAGES.map((s) => `stage_${s}`),
    ],
    report.projects.map((p) => [
      p.project.key,
      p.project.name,
      p.project.archived,
      ...[p.opened, p.closed, p.done, p.cancelled, p.comments, p.interactions].flatMap((c) => [c.total, c.previous]),
      p.backlog.start,
      p.backlog.end,
      hours(p.cycleTime.medianMs),
      hours(p.cycleTime.p90Ms),
      hours(p.openAge.medianMs),
      hours(p.openAge.p90Ms),
      ...STATUS_STAGES.map((s) => p.breakdown.byStage[s] ?? 0),
    ]),
  );

  const b = report.breakdown;
  const breakdown = csv(
    ["dimension", "key", "label", "open", "opened", "closed"],
    [
      ...STATUS_STAGES.map((s) => ["stage", s, STAGE_LABELS[s], b.byStage[s] ?? 0, null, null]),
      ...b.byPriority.map((r) => ["priority", r.key, PRIORITY_LABELS[r.key], r.open, r.opened, r.closed]),
      ...b.byType.map((r) => ["type", r.key, TYPE_LABELS[r.key], r.open, r.opened, r.closed]),
    ],
  );

  const contributors = csv(
    ["kind", "id", "name", "tasks_closed", "done", "cancelled", "comments", "interactions"],
    [...report.contributors.people, ...report.contributors.bots].map((c) => [c.kind, c.id, c.name, c.tasksClosed, c.done, c.cancelled, c.comments, c.interactions]),
  );

  return [
    { name: "README.txt", data: README.replace(/\n/g, "\r\n") },
    { name: "period.csv", data: period },
    { name: "summary.csv", data: summary },
    { name: "timeseries.csv", data: timeseries },
    { name: "projects.csv", data: projects },
    { name: "breakdown.csv", data: breakdown },
    { name: "contributors.csv", data: contributors },
  ];
}
