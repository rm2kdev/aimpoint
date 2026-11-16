"use client"

import * as React from "react"
import { Bar, CartesianGrid, BarChart as RBarChart, XAxis, YAxis } from "recharts"
import { ChartContainer, ChartTooltip } from "@/components/ui/chart"
import {
  AXIS_TICK,
  ChartFrame,
  DataTable,
  KitTooltip,
  SeriesLegend,
  chartColor,
  seriesConfig,
  seriesVar,
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

export function BarChart({
  title,
  description,
  data,
  categoryKey,
  series,
  granularity,
  categoryLabel,
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

  const table = () => (
    <DataTable
      caption={title}
      rows={data}
      columns={[
        { label: categoryLabel ?? (granularity ? "Date" : "Category"), cell: (d) => exact(d[categoryKey]) },
        ...series.map((s) => ({ label: s.label, numeric: true, cell: (d: BarDatum) => valueFormatter(num(d[s.key])) })),
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
    tickFormatter: (v: unknown) => clip(tick(v), horizontal ? Math.max(8, Math.floor(categoryWidth / 7)) : 12),
  }
  const valueAxis = {
    type: "number" as const,
    tickLine: false,
    axisLine: false,
    allowDecimals: false,
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
      legend={
        series.length > 1 ? (
          <SeriesLegend items={series.map((s, i) => ({ label: s.label, color: chartColor(i, s.color) }))} />
        ) : null
      }
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
          {horizontal ? (
            <>
              <XAxis {...valueAxis} tickMargin={6} />
              <YAxis {...categoryAxis} width={categoryWidth} tickMargin={6} interval={0} />
            </>
          ) : (
            <>
              <XAxis {...categoryAxis} tickMargin={8} minTickGap={16} interval="preserveStartEnd" />
              <YAxis {...valueAxis} width={40} tickMargin={4} />
            </>
          )}
          <ChartTooltip
            isAnimationActive={false}
            cursor={{ fill: "var(--muted)" }}
            content={(p) => (
              <KitTooltip {...p} total={stacked} format={valueFormatter} heading={(d) => exact(d[categoryKey])} />
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
