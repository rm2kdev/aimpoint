import { format, isSameDay } from "date-fns"

/** How finely a time axis is bucketed; picks axis tick and tooltip date formats. */
export type Granularity = "hour" | "day" | "week" | "month"

/** A point in time as the data layer hands it over (epoch ms, ISO string or Date). */
export type TimeValue = number | string | Date

export function toDate(t: TimeValue): Date {
  return t instanceof Date ? t : new Date(t)
}

/** First and last bucket of a series, so hourly ticks know whether the axis crosses a day. */
export type TickSpan = { first: TimeValue; last: TimeValue }

/** The span of a series given its time values (oldest first). */
export function spanOf<T>(data: T[], t: (d: T) => unknown): TickSpan | undefined {
  if (!data.length) return undefined
  return { first: t(data[0]) as TimeValue, last: t(data[data.length - 1]) as TimeValue }
}

/** Whether the span covers more than one local calendar day. */
export function spansDays(span: TickSpan | undefined): boolean {
  if (!span) return false
  const a = toDate(span.first)
  const b = toDate(span.last)
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return false
  return !isSameDay(a, b)
}

/**
 * Short tick label for an axis. Hourly ticks are HH:mm within one day; when the
 * series spans several days the axis only shows every Nth hour, so each tick
 * carries its day ("d MMM" at local midnight, "d MMM HH:mm" otherwise).
 */
export function formatTick(t: TimeValue, g: Granularity, span?: TickSpan): string {
  const d = toDate(t)
  if (Number.isNaN(d.getTime())) return String(t)
  switch (g) {
    case "hour":
      if (!spansDays(span)) return format(d, "HH:mm")
      return d.getHours() === 0 && d.getMinutes() === 0 ? format(d, "d MMM") : format(d, "d MMM HH:mm")
    case "month":
      return format(d, "MMM yyyy")
    default:
      return format(d, "d MMM")
  }
}

/** Exact label for a tooltip or table row: the full date, and the time for hourly buckets. */
export function formatExact(t: TimeValue, g: Granularity): string {
  const d = toDate(t)
  if (Number.isNaN(d.getTime())) return String(t)
  switch (g) {
    case "hour":
      return format(d, "EEE d MMM yyyy, HH:mm")
    case "week":
      return `Week of ${format(d, "EEE d MMM yyyy")}`
    case "month":
      return format(d, "MMMM yyyy")
    default:
      return format(d, "EEE d MMM yyyy")
  }
}

export function formatNumber(n: number): string {
  return n.toLocaleString("en", { maximumFractionDigits: 2 })
}

/** Compact axis numbers: 1.2k, 3.4M. */
export function formatCompact(n: number): string {
  return n.toLocaleString("en", { notation: "compact", maximumFractionDigits: 1 })
}

export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toLocaleString("en", { maximumFractionDigits: 1 })}%`
}
