"use client"

import * as React from "react"
import { BarChart3, ChartNoAxesColumn, ChartPie, Table2 } from "lucide-react"
import type { TooltipPayloadEntry } from "recharts"
import { Button } from "@/components/ui/button"
import type { ChartConfig } from "@/components/ui/chart"
import { cn } from "@/lib/utils"
import { formatNumber } from "./format"

/** Data colours for series, in the order they're handed out (tokens in globals.css, light + dark). */
export const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
] as const

export type ChartColor = 1 | 2 | 3 | 4 | 5 | 6

export function chartColor(index: number, pick?: ChartColor): string {
  return pick ? CHART_COLORS[pick - 1] : CHART_COLORS[index % CHART_COLORS.length]
}

/**
 * The measure half of the colour map (DESIGN.md \"Analytics charts\"): one measure, one colour on
 * every chart, legend, tooltip and table. Pass these as `Series.color`, never a bare index, so
 * Opened and Closed (or People and Bots) can't swap colours between cards.
 */
export const MEASURE_COLOR = {
  /** Tasks created: teal. */
  opened: 2,
  /** Tasks moved to done or cancelled: indigo, the data echo of the Done ring (not the cobalt). */
  closed: 1,
  /** Open tasks / the backlog level: orange. */
  open: 5,
  /** Work by people: violet. */
  people: 3,
  /** Work by bots: pink. */
  bots: 4,
} as const satisfies Record<string, ChartColor>

/** Width of every line and area edge: 2px, so a thin series still reads as colour at 1x. */
export const SERIES_STROKE = 2

export type ValueFormatter = (value: number) => string

/** One plotted measure: `key` is the field on each datum, `label` what people read. */
export interface Series {
  key: string
  label: string
  color?: ChartColor
  /**
   * How the accessible summary reads the series. "sum" (default) is for flows (opened, closed,
   * comments per bucket) and states a total; "level" is for stocks sampled per bucket (open
   * tasks at the end of each day), where a total means nothing, so it states start and end.
   */
  summary?: "sum" | "level"
}

/**
 * Series keys can be anything the data layer uses, so the CSS custom properties that ChartContainer
 * writes are indexed (`--color-s0`) rather than named after the key.
 */
export function seriesConfig(series: Series[]): ChartConfig {
  return Object.fromEntries(
    series.map((s, i) => [`s${i}`, { label: s.label, color: chartColor(i, s.color) }]),
  )
}

export const seriesVar = (i: number) => `var(--color-s${i})`

/**
 * Analytics type scale and chrome, in one place so the KPI tiles, chart cards, legends, tooltips
 * and tables can't drift apart (DESIGN.md "Analytics charts"). Every size is a ramp step.
 */
export const KIT = {
  /** Card and tile padding: 16px inline, 14px top. */
  cardPad: "px-4 pt-3.5",
  /** Card shell: container radius, hairline, paper. */
  card: "flex min-w-0 flex-col rounded-[10px] border border-border bg-background",
  /** Settings row title step (14/600). */
  title: "truncate text-[14px] leading-[1.4] font-semibold tracking-[-0.01em]",
  /** Body small (13px, Muted Ink). */
  description: "mt-0.5 text-[13px] leading-[1.45] text-muted-foreground",
  /** Label step (11.5px/500): legends, table headers, axis ticks, KPI deltas. */
  label: "text-[11.5px] leading-[1.3] font-medium",
  /** Metric step (24/600, tabular): KPI values. Sans, so units read as words, not code. */
  metric: "text-[24px] leading-[1.25] font-semibold tracking-[-0.02em] tabular-nums",
  /** Headline step (20/600, tabular): the donut total, a metric scaled down for the hole. */
  metricSmall: "text-[20px] leading-[1.3] font-semibold tracking-[-0.02em] tabular-nums",
  /** Swatch used by legends and tooltips alike. */
  swatch: "size-2 shrink-0 rounded-[2px]",
  /** Faint Ink boundary added to the swatch of a quiet tint under 3:1 on the card (colour-map.ts `edge`). */
  swatchEdge: "shadow-[inset_0_0_0_1px_var(--faint)]",
  /** Static skeleton block (no pulse). */
  skeleton: "rounded-sm bg-muted",
} as const

/** Height of one legend line (11.5px label at 1.3 plus breathing room). */
export const LEGEND_ROW = 18

/**
 * Container query (on the chart body) above which the donut legend grid has room for two columns.
 * Below it (a three-up row at 768-1279 px) labels would break mid-word, so the grid drops to one
 * column. Keep the class and the width in step.
 */
export const LEGEND_TWO_COLUMNS = "@[17rem]/chart:grid-cols-2"

export interface AnalyticsCardProps {
  title: string
  description?: React.ReactNode
  /** Header slot to the right of the title (e.g. a total or a Chart/Table toggle). */
  aside?: React.ReactNode
  loading?: boolean
  /** Shown while loading in place of the body (default: five table-row bars). */
  skeleton?: React.ReactNode
  /** Id for the title, so a parent can point aria-labelledby at it (generated when omitted). */
  titleId?: string
  className?: string
  /** Classes for the body below the header (default 16px side padding, 12px bottom). */
  bodyClassName?: string
  /** Data attribute naming the card kind (default "analytics-card"). */
  slot?: string
  children?: React.ReactNode
}

/**
 * The card every analytics panel sits in: title, description, aside slot and a loading state that
 * keeps the header (including a placeholder description line) so the card doesn't change height.
 * ChartFrame builds on it; tables and lists on the analytics screen use it directly.
 */
export function AnalyticsCard({
  title,
  description,
  aside,
  loading,
  skeleton,
  titleId,
  className,
  bodyClassName,
  slot = "analytics-card",
  children,
}: AnalyticsCardProps) {
  const autoId = React.useId()
  const id = titleId ?? autoId
  return (
    <section
      aria-labelledby={id}
      aria-busy={loading || undefined}
      data-slot={slot}
      className={cn(KIT.card, className)}
    >
      <header className={cn("flex items-start gap-3 pb-2", KIT.cardPad)}>
        <div className="min-w-0 flex-1">
          <h3 id={id} className={KIT.title}>
            {title}
          </h3>
          {description ? (
            <p className={KIT.description}>{description}</p>
          ) : loading ? (
            <div aria-hidden className="mt-0.5 flex h-[19px] items-center">
              <div className={cn(KIT.skeleton, "h-3 w-3/5")} />
            </div>
          ) : null}
        </div>
        {aside}
      </header>
      <div className={cn("min-w-0 px-4 pb-3", bodyClassName)}>
        {loading ? (skeleton ?? <RowsSkeleton />) : children}
      </div>
      {loading ? <span className="sr-only">Loading {title}</span> : null}
    </section>
  )
}

export type ChartShape = "bars" | "hbars" | "line" | "area" | "donut" | "rows"

export interface ChartFrameProps {
  title: string
  description?: React.ReactNode
  /** Screen-reader summary of what the chart shows (generated by each chart when omitted). */
  summary: string
  loading?: boolean
  empty?: boolean
  emptyMessage?: string
  /** Height of the plot area in px (also used by the loading and empty states). */
  height: number
  /** Renders the accessible table fallback. */
  table: () => React.ReactNode
  /** Header slot to the right of the title (e.g. a KPI total). */
  aside?: React.ReactNode
  /** Shown under the plot (not in table mode). */
  legend?: React.ReactNode
  /** Height reserved under the plot for the legend, so neighbouring cards line up (default one row). */
  legendHeight?: number
  /**
   * Height reserved for the legend when the card is narrow (body under 17rem, see
   * LEGEND_TWO_COLUMNS), for legends that reflow to more rows there (default legendHeight).
   */
  legendHeightNarrow?: number
  /** Skeleton drawn while loading, matching the chart type. */
  shape?: ChartShape
  className?: string
  children: React.ReactNode
}

/**
 * A chart card: AnalyticsCard plus a Chart / Table toggle (the table is the keyboard and
 * screen-reader fallback for the plot) and the empty state. Plot, empty box, skeleton and table
 * share one height, and the legend slot is reserved in every mode, so switching never jumps.
 */
export function ChartFrame({
  title,
  description,
  summary,
  loading,
  empty,
  emptyMessage = "No data for this period",
  height,
  table,
  aside,
  legend,
  legendHeight = LEGEND_ROW,
  legendHeightNarrow = legendHeight,
  shape = "bars",
  className,
  children,
}: ChartFrameProps) {
  const [asTable, setAsTable] = React.useState(false)
  const EmptyIcon = shape === "donut" ? ChartPie : ChartNoAxesColumn
  const showToggle = !loading && !empty
  // Legend slot: 8px gap plus the reserved rows; kept in table/empty/loading too. The narrow and
  // wide heights are CSS variables picked by a container query on the card body, so every mode
  // reserves the same height at any card width.
  const vars = {
    "--plot": `${height}px`,
    "--slot-n": `${legendHeightNarrow + 8}px`,
    "--slot-w": `${legendHeight + 8}px`,
  } as React.CSSProperties
  const slotH = "h-(--slot-n) @[17rem]/chart:h-(--slot-w)"

  return (
    <AnalyticsCard
      title={title}
      description={description}
      loading={loading}
      slot="analytics-chart"
      className={className}
      bodyClassName="@container/chart px-2"
      skeleton={
        <>
          <ChartSkeleton height={height} shape={shape} />
          <div aria-hidden style={vars} className={slotH} />
        </>
      }
      aside={
        <>
          {aside}
          {showToggle ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-pressed={asTable}
              aria-label={asTable ? `Show ${title} as a chart` : `Show ${title} as a table`}
              title={asTable ? "Show chart" : "Show table"}
              onClick={() => setAsTable((v) => !v)}
              className="-mt-1 -mr-1.5 text-muted-foreground"
            >
              {asTable ? <BarChart3 /> : <Table2 />}
            </Button>
          ) : null}
        </>
      }
    >
      {empty ? (
        <>
          {/* The page EmptyState, scaled to a card: faint thin-stroke icon over one quiet line. */}
          <div
            role="status"
            style={{ height }}
            className="mx-2 flex flex-col items-center justify-center gap-2 text-center text-[13px] text-muted-foreground"
          >
            <EmptyIcon aria-hidden className="size-7 stroke-1 text-faint/60" />
            {emptyMessage}
          </div>
          <div aria-hidden style={vars} className={slotH} />
        </>
      ) : asTable ? (
        <div
          className="mx-2 h-[calc(var(--plot)+var(--slot-n))] overflow-auto @[17rem]/chart:h-[calc(var(--plot)+var(--slot-w))]"
          style={vars}
        >
          {table()}
        </div>
      ) : (
        <>
          <div
            role="figure"
            aria-label={summary}
            style={{ height }}
            className="min-w-0 rounded-md has-[.recharts-surface:focus-visible]:ring-3 has-[.recharts-surface:focus-visible]:ring-ring/50"
          >
            {children}
          </div>
          <div style={vars} className="min-h-(--slot-n) pt-2 @[17rem]/chart:min-h-(--slot-w)">
            {legend}
          </div>
        </>
      )}
    </AnalyticsCard>
  )
}

/** Static skeletons (no pulse: nothing moves on its own), one per chart type. */
export function ChartSkeleton({ height, shape = "bars" }: { height: number; shape?: ChartShape }) {
  if (shape === "donut") {
    const d = Math.min(height * 0.92, 220)
    return (
      <div aria-hidden style={{ height }} className="mx-2 flex items-center justify-center">
        <div
          className="rounded-full border-muted"
          style={{ width: d, height: d, borderWidth: d * 0.15 }}
        />
      </div>
    )
  }
  if (shape === "line" || shape === "area") {
    // A flat polyline over a baseline, in the same stone wash as the bars.
    const pts = [52, 44, 58, 40, 48, 30, 38, 26]
    const path = pts.map((y, i) => `${(i / (pts.length - 1)) * 100},${y}`).join(" ")
    return (
      <div aria-hidden style={{ height }} className="mx-2 px-2 pt-2 pb-6">
        <svg viewBox="0 0 100 64" preserveAspectRatio="none" className="size-full text-muted">
          {shape === "area" ? <polygon points={`0,64 ${path} 100,64`} fill="currentColor" opacity={0.6} /> : null}
          <polyline points={path} fill="none" stroke="currentColor" strokeWidth={3} vectorEffect="non-scaling-stroke" />
        </svg>
      </div>
    )
  }
  if (shape === "hbars") {
    const bars = [82, 64, 52, 40, 30]
    return (
      <div aria-hidden style={{ height }} className="mx-2 flex flex-col justify-around px-2 pb-6">
        {bars.map((w, i) => (
          <div key={i} className={cn(KIT.skeleton, "h-3.5")} style={{ width: `${w}%` }} />
        ))}
      </div>
    )
  }
  if (shape === "rows") return <RowsSkeleton />
  const bars = [46, 62, 38, 74, 58, 82, 66, 52]
  return (
    <div aria-hidden style={{ height }} className="mx-2 flex items-end gap-[6%] px-2 pb-6">
      {bars.map((h, i) => (
        <div key={i} className={cn(KIT.skeleton, "flex-1")} style={{ height: `${h}%` }} />
      ))}
    </div>
  )
}

/** Table-shaped skeleton: rows at the DataTable row height. */
export function RowsSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div aria-hidden className="flex flex-col">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-[31px] items-center border-b border-border last:border-0">
          <div className={cn(KIT.skeleton, "h-3")} style={{ width: `${72 - i * 9}%` }} />
        </div>
      ))}
    </div>
  )
}

export interface DataTableColumn<Row> {
  label: string
  cell: (row: Row) => React.ReactNode
  numeric?: boolean
  /** Series colour shown as a swatch before the header, so the table keys like the legend. */
  color?: string
}

/** The Show table view of every chart (and the analytics screen's own tables). */
export function DataTable<Row>({
  caption,
  columns,
  rows,
}: {
  caption: string
  columns: DataTableColumn<Row>[]
  rows: Row[]
}) {
  return (
    <table className="w-full border-collapse text-[13px]">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className={cn("sticky top-0 border-b border-border bg-background text-left text-faint", KIT.label)}>
          {columns.map((c) => (
            <th key={c.label} scope="col" className={cn("py-1.5 pr-3 font-medium", c.numeric && "text-right")}>
              {c.color ? (
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden className={KIT.swatch} style={{ background: c.color }} />
                  {c.label}
                </span>
              ) : (
                c.label
              )}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-border last:border-0">
            {columns.map((c, j) =>
              j === 0 ? (
                <th key={c.label} scope="row" className="py-1.5 pr-3 text-left font-normal whitespace-nowrap">
                  {c.cell(r)}
                </th>
              ) : (
                <td
                  key={c.label}
                  className={cn("py-1.5 pr-3", c.numeric && "text-right font-mono tabular-nums")}
                >
                  {c.cell(r)}
                </td>
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Tooltip surface shared by every chart: heading on top, then label/value rows. */
export function TooltipShell({ heading, children }: { heading: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid min-w-36 gap-1.5 rounded-lg bg-popover px-2.5 py-1.5 text-[12.5px] text-popover-foreground shadow-md ring-1 ring-foreground/10">
      <div className="font-medium">{heading}</div>
      <div className="grid gap-1">{children}</div>
    </div>
  )
}

export function TooltipRow({
  label,
  value,
  color,
  edge,
  divider,
}: {
  label: React.ReactNode
  value: React.ReactNode
  color?: string
  /** The colour is a quiet tint: draw the swatch's Faint Ink boundary. */
  edge?: boolean
  divider?: boolean
}) {
  return (
    <div className={cn("flex items-center gap-2", divider && "mt-0.5 border-t border-border pt-1")}>
      {color ? <span aria-hidden className={cn(KIT.swatch, edge && KIT.swatchEdge)} style={{ background: color }} /> : null}
      <span className="flex-1 text-muted-foreground">{label}</span>
      <span className="font-mono font-medium text-foreground tabular-nums">{value}</span>
    </div>
  )
}

/** Tooltip body for series charts: exact bucket on top, one row per series with its exact value. */
export function KitTooltip({
  active,
  payload,
  heading,
  format = formatNumber,
  total,
}: {
  active?: boolean
  payload?: ReadonlyArray<TooltipPayloadEntry>
  heading: (datum: Record<string, unknown>) => React.ReactNode
  format?: ValueFormatter
  total?: boolean
}) {
  const items = (payload ?? []).filter((p) => p.type !== "none" && p.value != null)
  if (!active || !items.length) return null
  const datum = (items[0].payload ?? {}) as Record<string, unknown>
  const sum = items.reduce((n, p) => n + (Number(p.value) || 0), 0)
  return (
    <TooltipShell heading={heading(datum)}>
      {items.map((p, i) => (
        <TooltipRow
          key={`${p.dataKey ?? p.name}-${i}`}
          label={p.name}
          value={format(Number(p.value))}
          color={(p.payload as { fill?: string } | undefined)?.fill ?? p.color}
        />
      ))}
      {total && items.length > 1 ? <TooltipRow divider label="Total" value={format(sum)} /> : null}
    </TooltipShell>
  )
}

export interface LegendItem {
  label: string
  color: string
  value?: string
  /** The colour is a quiet tint: draw the swatch's Faint Ink boundary. */
  edge?: boolean
}

/**
 * Legend under every chart (always visible, so colour isn't the only key). "row" wraps items on one
 * line; "grid" is a label / value grid for donuts, two columns when the card body is at least 17rem
 * wide and one below that (labels never truncate), whose height the frame reserves for each layout
 * so side-by-side donuts line up.
 */
export function SeriesLegend({ items, variant = "row" }: { items: LegendItem[]; variant?: "row" | "grid" }) {
  if (variant === "grid") {
    return (
      <ul className={cn("grid grid-cols-1 gap-x-4 px-2 text-muted-foreground", LEGEND_TWO_COLUMNS, KIT.label, "font-normal")}>
        {items.map((it) => (
          <li key={it.label} className="flex min-w-0 items-center gap-1.5" style={{ height: LEGEND_ROW }}>
            <span aria-hidden className={cn(KIT.swatch, it.edge && KIT.swatchEdge)} style={{ background: it.color }} />
            <span className="min-w-0 flex-1 truncate">{it.label}</span>
            {it.value ? <span className="font-mono text-foreground tabular-nums">{it.value}</span> : null}
          </li>
        ))}
      </ul>
    )
  }
  return (
    <ul className={cn("flex flex-wrap items-center gap-x-4 px-2 text-muted-foreground", KIT.label, "font-normal")}>
      {items.map((it) => (
        <li key={it.label} className="flex items-center gap-1.5" style={{ height: LEGEND_ROW }}>
          <span aria-hidden className={cn(KIT.swatch, it.edge && KIT.swatchEdge)} style={{ background: it.color }} />
          {it.label}
          {it.value ? <span className="font-mono text-foreground tabular-nums">{it.value}</span> : null}
        </li>
      ))}
    </ul>
  )
}

/** Axis tick text: the 11.5px label step in Faint Ink, tabular so numbers line up. */
export const AXIS_TICK = { fontSize: 11.5, fill: "var(--faint)", style: { fontVariantNumeric: "tabular-nums" } }

/**
 * Width of a numeric y-axis, from the widest label recharts will draw (the rounded-up maximum),
 * instead of a fixed 40px that clips 4+ digit counts and wastes room on single digits.
 */
export function valueAxisWidth(max: number, format: (v: number) => string): number {
  const m = Math.max(0, max)
  const mag = m > 0 ? 10 ** Math.floor(Math.log10(m)) : 1
  const nice = Math.ceil(m / mag) * mag
  // Tabular digits at 11.5px Geist are ~7px wide; 10px covers the tick margin.
  return Math.max(24, Math.ceil(format(nice).length * 7) + 10)
}

/**
 * Value-axis domain for a chart whose largest value (stacked total or single series) is `max`.
 * When everything is zero, recharts 3 drops a stacked group's [0, 0] domain and, with no data domain
 * left, ignores a user domain too, so the axis draws no ticks and the series vanish. So pin the 0-4
 * scale it gives an all-zero line chart AND draw an invisible `ReferenceLine` at 0 with
 * `ifOverflow="extendDomain"` (the data domain recharts needs). Not `allowDataOverflow`: that clips the
 * series to the plot, which halves a 2px line lying on the zero edge. Otherwise keep the default.
 */
export const ZERO_VALUE_DOMAIN: [number, number] = [0, 4]
export function valueDomain(max: number): [number, number] | undefined {
  return max > 0 ? undefined : ZERO_VALUE_DOMAIN
}

/** Largest plotted value: the per-datum total when stacked, else the largest single value (min 0). */
export function maxPlotted(data: Record<string, unknown>[], series: Series[], stacked: boolean): number {
  let max = 0
  for (const d of data) {
    const vals = series.map((s) => (typeof d[s.key] === "number" && Number.isFinite(d[s.key]) ? (d[s.key] as number) : 0))
    max = Math.max(max, stacked ? vals.reduce((a, b) => a + b, 0) : Math.max(0, ...vals))
  }
  return max
}

/** Text width measurement for axis labels (canvas, so it matches the rendered font). */
let measureCtx: CanvasRenderingContext2D | null | undefined
export function measureText(text: string, fontSize = 11.5): number {
  if (typeof document === "undefined") return text.length * fontSize * 0.6
  if (measureCtx === undefined) measureCtx = document.createElement("canvas").getContext("2d")
  if (!measureCtx) return text.length * fontSize * 0.6
  measureCtx.font = `${fontSize}px ${getComputedStyle(document.body).fontFamily}`
  return measureCtx.measureText(text).width
}

/** Truncates `text` with an ellipsis so it fits `width` px at the tick size. */
export function fitText(text: string, width: number, fontSize = 11.5): string {
  if (measureText(text, fontSize) <= width) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (measureText(`${text.slice(0, mid)}…`, fontSize) <= width) lo = mid
    else hi = mid - 1
  }
  return `${text.slice(0, Math.max(1, lo))}…`
}
