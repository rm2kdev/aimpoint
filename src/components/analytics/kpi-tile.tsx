import * as React from "react"
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatNumber, formatPercent } from "./format"

export interface KpiTileProps {
  label: string
  /** Current-period value; null shows a dash placeholder and "No data". */
  value: number | null
  /** Same measure over the previous period of equal length; omit to hide the delta. */
  previous?: number | null
  /** Which way is good: "up" (default) for counts like closed tickets, "down" for e.g. open bugs, "neutral" to never colour. */
  goodDirection?: "up" | "down" | "neutral"
  format?: (value: number) => string
  /** Formats the absolute change when it can't be a percentage (default `format`); use when `format` adds a sign. */
  deltaFormat?: (value: number) => string
  /** Shown after the delta, e.g. "vs previous 30 days". */
  comparisonLabel?: string
  loading?: boolean
  className?: string
}

/** One headline number with its change against the previous period. */
export function KpiTile({
  label,
  value,
  previous,
  goodDirection = "up",
  format = formatNumber,
  deltaFormat = format,
  comparisonLabel = "vs previous period",
  loading,
  className,
}: KpiTileProps) {
  const delta = value != null && previous != null ? deltaOf(value, previous) : null
  const tone =
    !delta || delta.direction === "flat" || goodDirection === "neutral"
      ? "neutral"
      : (delta.direction === "up") === (goodDirection === "up")
        ? "good"
        : "bad"
  const Icon = !delta || delta.direction === "flat" ? Minus : delta.direction === "up" ? ArrowUpRight : ArrowDownRight

  const deltaText = delta
    ? delta.direction === "flat"
      ? "No change"
      : delta.ratio == null
        ? `${delta.direction === "up" ? "+" : "−"}${deltaFormat(Math.abs(delta.diff))}`
        : `${delta.direction === "up" ? "+" : "−"}${formatPercent(Math.abs(delta.ratio))}`
    : null
  const spoken = delta
    ? delta.direction === "flat"
      ? `No change ${comparisonLabel}`
      : `${delta.direction === "up" ? "Up" : "Down"} ${
          delta.ratio == null ? deltaFormat(Math.abs(delta.diff)) : formatPercent(Math.abs(delta.ratio))
        } ${comparisonLabel} (was ${format(previous as number)})${
          tone === "good" ? ", an improvement" : tone === "bad" ? ", a decline" : ""
        }`
    : null

  return (
    <div
      role="group"
      aria-label={label}
      aria-busy={loading || undefined}
      data-slot="kpi-tile"
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-[10px] border border-border bg-background px-4 py-3.5",
        className,
      )}
    >
      <div className="truncate text-[12.5px] text-muted-foreground">{label}</div>
      {loading ? (
        <>
          <div aria-hidden className="mt-1 h-7 w-20 rounded-[5px] bg-muted" />
          <div aria-hidden className="mt-1 h-4 w-32 rounded-[4px] bg-muted" />
          <span className="sr-only">Loading {label}</span>
        </>
      ) : (
        <>
          <div className="font-mono text-[26px] leading-[1.2] font-semibold tracking-[-0.02em] tabular-nums">
            {value == null ? <span className="text-faint">–</span> : format(value)}
            {value == null ? <span className="sr-only">No data</span> : null}
          </div>
          {deltaText ? (
            <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px]">
              <span
                aria-hidden
                className={cn(
                  "inline-flex h-5 shrink-0 items-center gap-0.5 rounded-[5px] px-1.5 font-medium",
                  delta?.direction !== "flat" && "font-mono tabular-nums",
                  tone === "good" && "bg-positive/10 text-positive",
                  tone === "bad" && "bg-destructive/10 text-destructive",
                  tone === "neutral" && "bg-chip text-muted-foreground",
                )}
              >
                <Icon className="size-3.5" />
                {deltaText}
              </span>
              <span aria-hidden className="text-faint">
                {comparisonLabel}
              </span>
              <span className="sr-only">{spoken}</span>
            </div>
          ) : (
            <div className="h-5 text-[12px] text-faint">{value == null ? "No data for this period" : ""}</div>
          )}
        </>
      )}
    </div>
  )
}

function deltaOf(value: number, previous: number) {
  const diff = value - previous
  const direction: "up" | "down" | "flat" = diff > 0 ? "up" : diff < 0 ? "down" : "flat"
  // A change from zero has no meaningful percentage; show the absolute difference instead.
  const ratio = previous === 0 ? null : diff / Math.abs(previous)
  return { diff, direction, ratio }
}
