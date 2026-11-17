"use client"

import * as React from "react"
import { Bar, CartesianGrid, BarChart as RBarChart, ReferenceLine, XAxis, YAxis } from "recharts"
import { ChartContainer, ChartTooltip } from "@/components/ui/chart"
import {
  AXIS_TICK,
  ChartFrame,
  DataTable,
  KitTooltip,
  SeriesLegend,
  chartColor,
  fitText,
  measureText,
  seriesConfig,
  seriesVar,
  valueAxisWidth,
  valueDomain,
  maxPlotted,
  type Series,
  type ValueFormatter,
} from "./chart-frame"
import { formatCompact, formatExact, formatNumber, formatTick, spanOf, type Granularity, type TimeValue } from "./format"

export type BarDatum = Record<string, string | number | Date | null | undefined>

export interface BarChartProps {
  title: string
  description?: React.ReactNode
  data: BarDatum[]
  /** Field naming each bar group (a project, a person, or a time bucket). */
  categoryKey: string
  series: Series[]
  /** Set when the category is a time bucket: ticks and tooltips then show dates. */
  granularity?: Granularity
  /** Label for the category column in the table fallback. */
  categoryLabel?: string
  /**
   * Field holding each category's identity colour (a project's dot). Drawn as a dot before the axis
   * label, in the tooltip header and in the table; the bars keep their series colours.
   */
  categoryColorKey?: string
  stacked?: boolean
  horizontal?: boolean
  valueFormatter?: ValueFormatter
  loading?: boolean
  emptyMessage?: string
  summary?: string
  /** Defaults to 220, or 32 px per row (min 120) when horizontal. */
  height?: number
  /** Width of the category labels when horizontal (default 96 px). */
  categoryWidth?: number
  className?: string
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0)

/** True only after hydration, so measured (canvas) tick text never differs from the server render. */
const subscribeNoop = () => () => {}
function useHydrated() {
  return React.useSyncExternalStore(subscribeNoop, () => true, () => false)
}

/**
 * Category tick for horizontal bars: the label is measured and ellipsised to the axis width, and
 * the full name is kept as an SVG <title> so a clipped project name can still be read on hover.
 */
function CategoryTick({
  x,
  y,
  payload,
  width,
  format,
  measured,
  dot,
}: {
  x?: number | string
  y?: number | string
  payload?: { value: unknown }
  width: number
  format: (v: unknown) => string
  measured: boolean
  /** Identity colour: an 8px dot just before the (right-aligned) label, like the ProjectDot in tables. */
  dot?: string
}) {
  const full = format(payload?.value)
  const room = dot ? width - DOT_ROOM : width
  const shown = measured ? fitText(full, room) : full.length > room / 7 ? `${full.slice(0, Math.max(1, Math.floor(room / 7) - 1))}…` : full
  const label = (
    <text
      x={Number(x)}
      y={Number(y)}
      dy="0.355em"
      textAnchor="end"
      fontSize={AXIS_TICK.fontSize}
      fill={AXIS_TICK.fill}
      style={AXIS_TICK.style}
    >
      {shown !== full ? <title>{full}</title> : null}
      {shown}
    </text>
  )
  if (!dot) return label
  const textWidth = measured ? measureText(shown, AXIS_TICK.fontSize) : shown.length * AXIS_TICK.fontSize * 0.6
  return (
    <g>
      <rect x={Number(x) - textWidth - DOT_ROOM} y={Number(y) - 4} width={8} height={8} rx={2.5} fill={dot} aria-hidden />
      {label}
    </g>
  )
}

/** Space a category dot takes before its label: the 8px ProjectDot plus a 6px gap. */
const DOT_ROOM = 14

function CategoryName({ color, children }: { color?: string; children: React.ReactNode }) {
  if (!color) return <>{children}</>
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span aria-hidden className="inline-block size-2 shrink-0 rounded-[3px]" style={{ background: color }} />
      {children}
    </span>
  )
}

export function BarChart({
  title,
  description,
  data,
  categoryKey,
  series,
  granularity,
  categoryLabel,
  categoryColorKey,
  stacked = false,
  horizontal = false,
  valueFormatter = formatNumber,
  loading,
  emptyMessage,
  summary,
  height,
  categoryWidth = 96,
  className,
}: BarChartProps) {
  const config = React.useMemo(() => seriesConfig(series), [series])
  const empty = !data.length || !series.length
  const h = height ?? (horizontal ? Math.max(120, data.length * (stacked ? 28 : 18 + series.length * 10) + 32) : 220)

  const exact = (v: unknown) =>
    granularity ? formatExact(v as TimeValue, granularity) : String(v ?? "")
  const span = granularity === "hour" ? spanOf(data, (d) => d[categoryKey]) : undefined
  const tick = (v: unknown) => (granularity ? formatTick(v as TimeValue, granularity, span) : String(v ?? ""))
  const text = summary ?? describe(title, data, categoryKey, series, exact, valueFormatter)
  const measured = useHydrated()
  const colors = React.useMemo(
    () => new Map(categoryColorKey ? data.map((d) => [String(d[categoryKey] ?? ""), d[categoryColorKey]]) : []),
    [data, categoryKey, categoryColorKey],
  )
  const colorOf = (v: unknown) => {
    const c = colors.get(String(v ?? ""))
    return typeof c === "string" && c ? c : undefined
  }
  const max = React.useMemo(() => maxPlotted(data, series, stacked), [data, series, stacked])
  // All zero still draws a 0-based value axis with ticks (VEC-164).
  const domain = valueDomain(max)
  const valueWidth = valueAxisWidth(domain ? domain[1] : max, formatCompact)

  const table = () => (
    <DataTable
      caption={title}
      rows={data}
      columns={[
        { label: categoryLabel ?? (granularity ? "Date" : "Category"), cell: (d) => <CategoryName color={colorOf(d[categoryKey])}>{exact(d[categoryKey])}</CategoryName> },
        ...series.map((s, i) => ({ label: s.label, numeric: true, color: chartColor(i, s.color), cell: (d: BarDatum) => valueFormatter(num(d[s.key])) })),
        ...(stacked && series.length > 1
          ? [{ label: "Total", numeric: true, cell: (d: BarDatum) => valueFormatter(series.reduce((n, s) => n + num(d[s.key]), 0)) }]
          : []),
      ]}
    />
  )

  const categoryAxis = {
    dataKey: categoryKey,
    type: "category" as const,
    tickLine: false,
    axisLine: false,
    tick: AXIS_TICK,
    tickFormatter: (v: unknown) => clip(tick(v), 12),
  }
  const valueAxis = {
    type: "number" as const,
    tickLine: false,
    axisLine: false,
    allowDecimals: false,
    domain,
    tick: AXIS_TICK,
    tickFormatter: (v: number) => formatCompact(v),
  }
  const radius = 3
  const barRadius = (i: number): [number, number, number, number] => {
    if (stacked && i !== series.length - 1) return [0, 0, 0, 0]
    return horizontal ? [0, radius, radius, 0] : [radius, radius, 0, 0]
  }

  return (
    <ChartFrame
      title={title}
      description={description}
      summary={text}
      loading={loading}
      empty={empty}
      emptyMessage={emptyMessage}
      height={h}
      table={table}
      className={className}
      shape={horizontal ? "hbars" : "bars"}
      legend={<SeriesLegend items={series.map((s, i) => ({ label: s.label, color: chartColor(i, s.color) }))} />}
    >
      <ChartContainer config={config} className="aspect-auto h-full w-full">
        <RBarChart
          data={data}
          layout={horizontal ? "vertical" : "horizontal"}
          margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
          barCategoryGap={data.length === 1 ? "35%" : "20%"}
          maxBarSize={horizontal ? 22 : 48}
        >
          <CartesianGrid vertical={horizontal} horizontal={!horizontal} stroke="var(--border)" />
          {domain && (horizontal ? <ReferenceLine x={0} stroke="none" ifOverflow="extendDomain" /> : <ReferenceLine y={0} stroke="none" ifOverflow="extendDomain" />)}
          {horizontal ? (
            <>
              <XAxis {...valueAxis} tickMargin={6} />
              <YAxis
                {...categoryAxis}
                width={categoryWidth}
                tickMargin={6}
                interval={0}
                tick={(p: { x?: number | string; y?: number | string; payload?: { value: unknown } }) => (
                  <CategoryTick {...p} width={categoryWidth - 8} format={tick} measured={measured} dot={colorOf(p.payload?.value)} />
                )}
              />
            </>
          ) : (
            <>
              <XAxis {...categoryAxis} tickMargin={8} minTickGap={16} interval="preserveStartEnd" />
              <YAxis {...valueAxis} width={valueWidth} tickMargin={4} />
            </>
          )}
          <ChartTooltip
            isAnimationActive={false}
            cursor={{ fill: "var(--muted)" }}
            content={(p) => (
              <KitTooltip {...p} total={stacked} format={valueFormatter} heading={(d) => <CategoryName color={colorOf(d[categoryKey])}>{exact(d[categoryKey])}</CategoryName>} />
            )}
          />
          {series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              fill={seriesVar(i)}
              stackId={stacked ? "stack" : undefined}
              radius={barRadius(i)}
              isAnimationActive={false}
            />
          ))}
        </RBarChart>
      </ChartContainer>
    </ChartFrame>
  )
}

function clip(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

function describe(
  title: string,
  data: BarDatum[],
  categoryKey: string,
  series: Series[],
  exact: (v: unknown) => string,
  fmt: ValueFormatter,
): string {
  if (!data.length) return `${title}: no data`
  const parts = series.map((s) => {
    let best = data[0]
    let total = 0
    for (const d of data) {
      total += num(d[s.key])
      if (num(d[s.key]) > num(best[s.key])) best = d
    }
    return `${s.label} total ${fmt(total)}, highest ${fmt(num(best[s.key]))} for ${exact(best[categoryKey])}`
  })
  return `Bar chart of ${title}, ${data.length} ${data.length === 1 ? "category" : "categories"}. ${parts.join("; ")}.`
}
