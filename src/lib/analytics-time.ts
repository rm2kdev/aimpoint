/**
 * Time buckets for analytics (VEC-132), in the viewer's timezone. Pure and client-safe (no imports at runtime),
 * so the UI can label buckets the same way the server built them.
 *
 * Buckets match MongoDB's `$dateTrunc` with `timezone` (and `startOfWeek: "monday"` for weeks): a bucket's
 * key is the UTC instant of its local start, so a task created at 23:30 AWST lands on that AWST day.
 */
import type { AnalyticsGranularity } from "./types";

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** True when `tz` is an IANA timezone this runtime knows (e.g. "Australia/Perth"). */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz.trim()) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface Parts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  /** 0 = Monday ... 6 = Sunday */
  wd: number;
}

/** Wall-clock fields of `date` in `tz`. */
export function zonedParts(date: Date, tz: string): Parts {
  const out: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(date)) out[p.type] = p.value;
  return { y: +out.year, mo: +out.month, d: +out.day, h: +out.hour % 24, mi: +out.minute, s: +out.second, wd: WEEKDAYS.indexOf(out.weekday) };
}

/** Offset of `tz` from UTC at `date`, in ms (AWST = +8h). */
function offsetMs(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  const wall = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return wall - (date.getTime() - date.getUTCMilliseconds());
}

/** The instant whose wall clock in `tz` reads y-mo-d h:00 (fields may overflow, like Date.UTC). */
export function zonedTime(y: number, mo: number, d: number, h: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h);
  const off = offsetMs(new Date(guess), tz);
  let t = guess - off;
  const off2 = offsetMs(new Date(t), tz);
  if (off2 !== off) t = guess - off2;
  return new Date(t);
}

/** Start of the bucket holding `date` (local hour / day / Monday-start week / month in `tz`). */
export function bucketStart(date: Date, unit: AnalyticsGranularity, tz: string): Date {
  const p = zonedParts(date, tz);
  switch (unit) {
    case "hour":
      return zonedTime(p.y, p.mo, p.d, p.h, tz);
    case "day":
      return zonedTime(p.y, p.mo, p.d, 0, tz);
    case "week":
      return zonedTime(p.y, p.mo, p.d - p.wd, 0, tz);
    case "month":
      return zonedTime(p.y, p.mo, 1, 0, tz);
  }
}

/** Start of the bucket after the one starting at `start`. */
export function nextBucketStart(start: Date, unit: AnalyticsGranularity, tz: string): Date {
  if (unit === "hour") return new Date(start.getTime() + 3_600_000);
  const p = zonedParts(start, tz);
  if (unit === "day") return zonedTime(p.y, p.mo, p.d + 1, 0, tz);
  if (unit === "week") return zonedTime(p.y, p.mo, p.d + 7, 0, tz);
  return zonedTime(p.y, p.mo + 1, 1, 0, tz);
}

/** Most buckets one report may have (90 days by hour = 2160). */
export const MAX_ANALYTICS_BUCKETS = 3000;

/**
 * Every bucket start from the one holding `from` up to (not including) `to`, empty ones included, so charts
 * don't skip dates. The first bucket can start before `from`; only events in [from, to) are counted.
 */
export function bucketStarts(from: Date, to: Date, unit: AnalyticsGranularity, tz: string): Date[] {
  const out: Date[] = [];
  for (let b = bucketStart(from, unit, tz); b < to; b = nextBucketStart(b, unit, tz)) {
    out.push(b);
    if (out.length > MAX_ANALYTICS_BUCKETS) throw new RangeError(`More than ${MAX_ANALYTICS_BUCKETS} buckets: pick a coarser granularity or a shorter period.`);
  }
  return out;
}
