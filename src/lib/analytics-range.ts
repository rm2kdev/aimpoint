/**
 * Analytics screen period state (VEC-134): presets, custom range, granularity, project filter and the
 * previous-period toggle, all kept in the URL query so a report is shareable and survives reload.
 * Pure and client-safe; the server page and the client controls resolve ranges the same way.
 *
 * Presets are relative to "now" in the viewer's timezone (the `vec-tz` cookie, AWST by default); a custom
 * range is stored as absolute instants, so a shared link shows the same period to everyone.
 */
import { bucketStart, isTimeZone, zonedParts, zonedTime } from "./analytics-time";
import { ANALYTICS_GRANULARITIES, isAnalyticsGranularity, type AnalyticsGranularity } from "./types";

export const ANALYTICS_PRESETS = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "90d", label: "90 days" },
  { id: "12m", label: "12 months" },
  { id: "custom", label: "Custom" },
] as const;
export type AnalyticsPreset = (typeof ANALYTICS_PRESETS)[number]["id"];
const isPreset = (v: unknown): v is AnalyticsPreset => ANALYTICS_PRESETS.some((p) => p.id === v);

export const DEFAULT_PRESET: AnalyticsPreset = "30d";
/** Cookie holding the viewer's IANA timezone, written by the analytics screen from the browser. */
export const TZ_COOKIE = "vec-tz";
/** Most points a chart gets; finer granularities than this are disabled for the range. */
export const MAX_CHART_BUCKETS = 400;

export const GRANULARITY_LABELS: Record<AnalyticsGranularity, string> = { hour: "Hour", day: "Day", week: "Week", month: "Month" };

/** What the URL says (only what differs from the defaults is written back). */
export interface AnalyticsParams {
  range: AnalyticsPreset;
  /** Custom range only: ISO instants, `to` exclusive. */
  from: string | null;
  to: string | null;
  /** null = auto for the range. */
  g: AnalyticsGranularity | null;
  /** Project key, null = all projects. */
  project: string | null;
  /** Limit to one person / one bot (VEC-135), by id; `person` wins when both are set. */
  person: string | null;
  bot: string | null;
  compare: boolean;
}

type SearchParams = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;
const objectId = (v: string | null) => (v && /^[0-9a-f]{24}$/i.test(v.trim()) ? v.trim().toLowerCase() : null);

export function parseAnalyticsParams(sp: SearchParams | URLSearchParams): AnalyticsParams {
  const get = (k: string) => (sp instanceof URLSearchParams ? sp.get(k) : one(sp[k]));
  const range = get("range");
  const g = get("g");
  const project = get("project")?.trim().toUpperCase() || null;
  const person = objectId(get("person"));
  return {
    range: isPreset(range) ? range : DEFAULT_PRESET,
    from: get("from"),
    to: get("to"),
    g: isAnalyticsGranularity(g) ? g : null,
    project,
    person,
    bot: person ? null : objectId(get("bot")),
    compare: get("compare") !== "0",
  };
}

/** `?range=...` for a params object, leaving out defaults (empty string when everything is default). */
export function analyticsSearch(p: AnalyticsParams): string {
  const q = new URLSearchParams();
  if (p.range !== DEFAULT_PRESET) q.set("range", p.range);
  if (p.range === "custom") {
    if (p.from) q.set("from", p.from);
    if (p.to) q.set("to", p.to);
  }
  if (p.g) q.set("g", p.g);
  if (p.project) q.set("project", p.project);
  if (p.person) q.set("person", p.person);
  else if (p.bot) q.set("bot", p.bot);
  if (!p.compare) q.set("compare", "0");
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** `?project=WEB`, `?person=<id>`, `?bot=<id>`: a deep link into the default period with filters set (VEC-135). */
export const analyticsSearchFor = (filters: Partial<AnalyticsParams>) => analyticsSearch({ ...parseAnalyticsParams(new URLSearchParams()), ...filters });

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const UNIT_MS: Record<AnalyticsGranularity, number> = { hour: HOUR, day: DAY, week: 7 * DAY, month: 30.44 * DAY };

/** Rough number of buckets a range has at a granularity (enough to decide what to offer). */
export const bucketEstimate = (from: Date, to: Date, g: AnalyticsGranularity) =>
  Math.ceil((to.getTime() - bucketStart(from, g, "UTC").getTime()) / UNIT_MS[g]);

/** Granularities that give a readable chart for the range (1 to MAX_CHART_BUCKETS points). */
export function allowedGranularities(from: Date, to: Date): AnalyticsGranularity[] {
  const ok = ANALYTICS_GRANULARITIES.filter((g) => bucketEstimate(from, to, g) <= MAX_CHART_BUCKETS);
  return ok.length ? ok : ["month"];
}

/** The granularity picked when the URL doesn't set one. */
export function autoGranularity(from: Date, to: Date): AnalyticsGranularity {
  const span = to.getTime() - from.getTime();
  if (span <= 2 * DAY) return "hour";
  if (span <= 100 * DAY) return "day";
  if (span <= 200 * DAY) return "week";
  return "month";
}

/** Longest custom range accepted (monthly buckets stay well under the data layer's cap). */
const MAX_SPAN = 10 * 366 * DAY;

export interface ResolvedRange {
  from: Date;
  to: Date;
  granularity: AnalyticsGranularity;
  /** Granularity is the range's automatic choice. */
  auto: boolean;
  tz: string;
  /** Set when the URL asked for something unusable and a fallback was used. */
  note: string | null;
}

/** Turns URL params into the concrete period for `now` in `tz`. */
export function resolveAnalyticsRange(p: AnalyticsParams, tz: string, now: Date = new Date()): ResolvedRange {
  const zone = isTimeZone(tz) ? tz : "Australia/Perth";
  const n = zonedParts(now, zone);
  const tomorrow = zonedTime(n.y, n.mo, n.d + 1, 0, zone);
  const daysBack = (days: number) => zonedTime(n.y, n.mo, n.d - (days - 1), 0, zone);
  let note: string | null = null;
  let from: Date;
  let to: Date = tomorrow;
  switch (p.range) {
    case "today":
      from = daysBack(1);
      break;
    case "7d":
      from = daysBack(7);
      break;
    case "90d":
      from = daysBack(90);
      break;
    case "12m":
      from = zonedTime(n.y, n.mo - 12, n.d + 1, 0, zone);
      break;
    case "custom": {
      const f = p.from ? new Date(p.from) : null;
      const t = p.to ? new Date(p.to) : null;
      if (f && t && !Number.isNaN(f.getTime()) && !Number.isNaN(t.getTime()) && f < t && t.getTime() - f.getTime() <= MAX_SPAN) {
        from = f;
        to = t;
      } else {
        note = "That custom range isn't valid (the end must be after the start, within 10 years), so the last 30 days are shown.";
        from = daysBack(30);
      }
      break;
    }
    default:
      from = daysBack(30);
  }
  const allowed = allowedGranularities(from, to);
  const auto = autoGranularity(from, to);
  let granularity = auto;
  if (p.g) {
    if (allowed.includes(p.g)) granularity = p.g;
    else note = `${GRANULARITY_LABELS[p.g]} would be too many points for this range, so ${GRANULARITY_LABELS[auto].toLowerCase()} is used.`;
  }
  return { from, to, granularity, auto: granularity === auto && !p.g, tz: zone, note };
}

/* ---------------- display ---------------- */

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string, opts: Intl.DateTimeFormatOptions, locale = "en-GB") {
  const k = `${locale}|${tz}|${JSON.stringify(opts)}`;
  let f = fmtCache.get(k);
  if (!f) fmtCache.set(k, (f = new Intl.DateTimeFormat(locale, { timeZone: tz, ...opts })));
  return f;
}

/** "AWST", "GMT", "EST" (whichever English locale has a name for it), else "GMT+9". */
export function tzAbbrev(tz: string, at: Date): string {
  let fallback = tz;
  for (const locale of ["en-AU", "en-GB", "en-US"]) {
    const name = fmt(tz, { timeZoneName: "short" }, locale).formatToParts(at).find((x) => x.type === "timeZoneName")?.value;
    if (!name) continue;
    if (!/^GMT[+-]/.test(name)) return name;
    if (fallback === tz) fallback = name;
  }
  return fallback;
}

/** "1 Nov 2026 00:00" in `tz`. */
export function formatDateTime(d: Date, tz: string): string {
  const parts = Object.fromEntries(
    fmt(tz, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${parts.day} ${parts.month} ${parts.year} ${parts.hour}:${parts.minute}`;
}

/** Inclusive end shown to people: the last minute before an exclusive `to`. */
export const inclusiveEnd = (to: Date) => new Date(to.getTime() - 60_000);

/** "1 Nov 2026 00:00 to 17 Nov 2026 23:59 AWST" */
export function formatRange(from: Date, to: Date, tz: string): string {
  const end = inclusiveEnd(to);
  const a = tzAbbrev(tz, from);
  const b = tzAbbrev(tz, end);
  // Across a daylight-saving change, name the zone at each end.
  return a === b ? `${formatDateTime(from, tz)} to ${formatDateTime(end, tz)} ${b}` : `${formatDateTime(from, tz)} ${a} to ${formatDateTime(end, tz)} ${b}`;
}

/** `YYYY-MM-DDTHH:mm` wall clock in `tz`, for a datetime-local input. */
export function toLocalInput(d: Date, tz: string): string {
  const p = zonedParts(d, tz);
  const z = (n: number) => String(n).padStart(2, "0");
  return `${p.y}-${z(p.mo)}-${z(p.d)}T${z(p.h)}:${z(p.mi)}`;
}

/** Parses a datetime-local value as wall clock in `tz` (null when malformed). */
export function fromLocalInput(v: string, tz: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v);
  if (!m) return null;
  const hourStart = zonedTime(+m[1], +m[2], +m[3], +m[4], tz);
  return new Date(hourStart.getTime() + +m[5] * 60_000);
}
