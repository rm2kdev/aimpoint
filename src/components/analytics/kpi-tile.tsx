import * as React from "react"
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react"
import { cn } from "@/lib/utils"
import { KIT } from "./chart-frame"
import { formatNumber, formatPercent } from "./format"

export interface KpiTileProps {
  label: string
  /** Current-period value; null shows a dash placeholder and "No data". */
  value: number | null
  /**
   * Same measure over the previous period of equal length. Omit (undefined) to hide the delta row's
   * content; null means there is nothing earlier to compare with ("No earlier data").
   */
  previous?: number | null
  /** Which way is good: "up" (default) for counts like closed tickets, "down" for e.g. open bugs, "neutral" to never colour. */
  goodDirection?: "up" | "down" | "neutral"
  format?: (value: number) => string
  /** Formats the absolute change when it can't be a percentage (default `format`); use when `format` adds a sign. */
  deltaFormat?: (value: number) => string
  /** Shown after the delta, e.g. "vs previous 30 days". */
  comparisonLabel?: string
  /**
   * Colour of the one series this tile sums up (e.g. `var(--chart-2)` for Opened), drawn as the
   * legend swatch before the label so the tile matches its chart. Omit when no single series plots
   * the measure; the tile then stays neutral (DESIGN.md "Analytics charts" colour map).
   */
  color?: string
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
  color,
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
        "@container/kpi flex min-w-0 flex-col gap-1 rounded-[10px] border border-border bg-background px-4 py-3.5",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-[13px] leading-[1.45] text-muted-foreground">
        {color ? <span aria-hidden data-slot="kpi-swatch" className={KIT.swatch} style={{ background: color }} /> : null}
        <span className="truncate">{label}</span>
      </div>
      {loading ? (
        <>
          {/* Same line boxes as the loaded tile (30px value, 20px delta row), so nothing jumps. */}
          <div aria-hidden className="flex h-7.5 items-center">
            <div className={cn(KIT.skeleton, "h-6 w-20")} />
          </div>
          <div aria-hidden className="flex h-5 items-center">
            <div className={cn(KIT.skeleton, "h-3.5 w-32")} />
          </div>
          <span className="sr-only">Loading {label}</span>
        </>
      ) : (
        <>
          <div className={cn("h-7.5 truncate", KIT.metric)}>
            {value == null ? <span className="text-faint">–</span> : format(value)}
            {value == null ? <span className="sr-only">No data</span> : null}
          </div>
          <div className={cn("flex h-5 min-w-0 items-center gap-1.5 whitespace-nowrap", KIT.label)}>
            {deltaText ? (
              <>
                <span
                  aria-hidden
                  className={cn(
                    "inline-flex h-5 shrink-0 items-center gap-0.5 rounded-[5px] px-1.5 tabular-nums",
                    tone === "good" && "bg-positive/10 text-positive-ink",
                    tone === "bad" && "bg-destructive/10 text-destructive-ink",
                    tone === "neutral" && "bg-chip text-muted-foreground",
                  )}
                >
                  <Icon className="size-3.5" />
                  {deltaText}
                </span>
                {/* Only when the tile has room for chip and suffix (e.g. not in the six-up row at
                    1280); the chip and the spoken sentence carry the change either way. */}
                <span aria-hidden className="hidden min-w-0 truncate font-normal text-faint @[8.5rem]/kpi:block">
                  {comparisonLabel}
                </span>
                <span className="sr-only">{spoken}</span>
              </>
            ) : value == null ? (
              <span className="truncate font-normal text-faint">No data for this period</span>
            ) : previous === null ? (
              <span className="inline-flex h-5 shrink-0 items-center rounded-[5px] bg-chip px-1.5 text-muted-foreground">
                No earlier data
              </span>
            ) : null}
          </div>
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
