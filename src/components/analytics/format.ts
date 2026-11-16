import { format } from "date-fns"

/** How finely a time axis is bucketed; picks axis tick and tooltip date formats. */
export type Granularity = "hour" | "day" | "week" | "month"

/** A point in time as the data layer hands it over (epoch ms, ISO string or Date). */
export type TimeValue = number | string | Date

export function toDate(t: TimeValue): Date {
  return t instanceof Date ? t : new Date(t)
}

/** Short tick label for an axis. */
export function formatTick(t: TimeValue, g: Granularity): string {
  const d = toDate(t)
  if (Number.isNaN(d.getTime())) return String(t)
  switch (g) {
    case "hour":
      return format(d, "HH:mm")
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
