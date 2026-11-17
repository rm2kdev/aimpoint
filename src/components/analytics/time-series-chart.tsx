"use client"

import * as React from "react"
import { Area, AreaChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"
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
  SERIES_STROKE,
  valueAxisWidth,
  type Series,
  type ValueFormatter,
} from "./chart-frame"
import { formatCompact, formatExact, formatNumber, formatTick, spanOf, type Granularity, type TimeValue } from "./format"

export type TimePoint = { t: TimeValue } & Record<string, number | TimeValue | null | undefined>

export interface TimeSeriesChartProps {
  title: string
  description?: React.ReactNode
  /** One datum per bucket, oldest first; `t` is the bucket start. */
  data: TimePoint[]
  series: Series[]
  /** "line" (default) or "area". `stacked` always draws areas. */
  variant?: "line" | "area"
  stacked?: boolean
  granularity?: Granularity
  valueFormatter?: ValueFormatter
  loading?: boolean
  emptyMessage?: string
  summary?: string
  height?: number
  className?: string
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0)

/**
 * One fill for every area (plain or stacked), and straight segments: these are integer counts per
 * bucket, and a smoothed curve invents humps and dips between buckets that the bars don't show.
 */
const AREA_FILL_OPACITY = 0.2
const CURVE = "linear" as const

export function TimeSeriesChart({
  title,
  description,
  data,
  series,
  variant = "line",
  stacked = false,
  granularity = "day",
  valueFormatter = formatNumber,
  loading,
  emptyMessage,
  summary,
  height = 220,
  className,
}: TimeSeriesChartProps) {
  const config = React.useMemo(() => seriesConfig(series), [series])
  const rows = React.useMemo(() => data.map((d, i) => ({ ...d, __i: i })), [data])
  const span = React.useMemo(() => spanOf(data, (d) => d.t), [data])
  const empty = !data.length || !series.length
  const area = stacked || variant === "area"
  // A lone bucket has no line to draw, so always show dots on short series.
  const dots = data.length <= 2 ? { r: 3, strokeWidth: 0, fill: undefined } : false

  const text = summary ?? describe(title, data, series, granularity, valueFormatter, stacked)
  const yWidth = React.useMemo(() => {
    let max = 0
    for (const d of data) {
      const vals = series.map((s) => num(d[s.key]))
      max = Math.max(max, stacked ? vals.reduce((a, b) => a + b, 0) : Math.max(0, ...vals))
    }
    return valueAxisWidth(max, formatCompact)
  }, [data, series, stacked])

  const table = () => (
    <DataTable
      caption={title}
      rows={data}
      columns={[
        { label: granularity === "hour" ? "Time" : "Date", cell: (d) => formatExact(d.t, granularity) },
        ...series.map((s, i) => ({ label: s.label, numeric: true, color: chartColor(i, s.color), cell: (d: TimePoint) => valueFormatter(num(d[s.key])) })),
        ...(stacked && series.length > 1
          ? [{ label: "Total", numeric: true, cell: (d: TimePoint) => valueFormatter(series.reduce((n, s) => n + num(d[s.key]), 0)) }]
          : []),
      ]}
    />
  )

  const common = (
    <>
      <CartesianGrid vertical={false} stroke="var(--border)" />
      <XAxis
        dataKey="__i"
        type="category"
        tickLine={false}
        axisLine={false}
        tickMargin={8}
        minTickGap={28}
        interval="preserveStartEnd"
        tick={AXIS_TICK}
        tickFormatter={(i: number) => (rows[i] ? formatTick(rows[i].t, granularity, span) : "")}
      />
      <YAxis
        tickLine={false}
        axisLine={false}
        width={yWidth}
        tickMargin={4}
        allowDecimals={false}
        tick={AXIS_TICK}
        tickFormatter={(v: number) => formatCompact(v)}
      />
      <ChartTooltip
        isAnimationActive={false}
        cursor={{ stroke: "var(--input)" }}
        content={(p) => (
          <KitTooltip
            {...p}
            total={stacked}
            format={valueFormatter}
            heading={(d) => formatExact(d.t as TimeValue, granularity)}
          />
        )}
      />
    </>
  )

  return (
    <ChartFrame
      title={title}
      description={description}
      summary={text}
      loading={loading}
      empty={empty}
      emptyMessage={emptyMessage}
      height={height}
      table={table}
      className={className}
      shape={area ? "area" : "line"}
      legend={<SeriesLegend items={series.map((s, i) => ({ label: s.label, color: chartColor(i, s.color) }))} />}
    >
      <ChartContainer config={config} className="aspect-auto h-full w-full">
        {area ? (
          <AreaChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            {common}
            {series.map((s, i) => (
              <Area
                key={s.key}
                dataKey={s.key}
                name={s.label}
                type={CURVE}
                stackId={stacked ? "stack" : undefined}
                stroke={seriesVar(i)}
                strokeWidth={SERIES_STROKE}
                fill={seriesVar(i)}
                fillOpacity={AREA_FILL_OPACITY}
                dot={dots ? { ...dots, fill: seriesVar(i) } : false}
                activeDot={{ r: 3.5, strokeWidth: 0 }}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        ) : (
          <LineChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            {common}
            {series.map((s, i) => (
              <Line
                key={s.key}
                dataKey={s.key}
                name={s.label}
                type={CURVE}
                stroke={seriesVar(i)}
                strokeWidth={SERIES_STROKE}
                dot={dots ? { ...dots, fill: seriesVar(i) } : false}
                activeDot={{ r: 3.5, strokeWidth: 0 }}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        )}
      </ChartContainer>
    </ChartFrame>
  )
}

function describe(
  title: string,
  data: TimePoint[],
  series: Series[],
  g: Granularity,
  fmt: ValueFormatter,
  stacked: boolean,
): string {
  if (!data.length) return `${title}: no data`
  const range =
    data.length === 1
      ? formatExact(data[0].t, g)
      : `${formatExact(data[0].t, g)} to ${formatExact(data[data.length - 1].t, g)}`
  const parts = series.map((s) => {
    let total = 0
    let peak = -Infinity
    let peakAt: TimeValue = data[0].t
    for (const d of data) {
      const v = num(d[s.key])
      total += v
      if (v > peak) {
        peak = v
        peakAt = d.t
      }
    }
    const peakText = `peak ${fmt(peak)} on ${formatExact(peakAt, g)}`
    if (s.summary === "level") {
      const first = num(data[0][s.key])
      const last = num(data[data.length - 1][s.key])
      return data.length === 1
        ? `${s.label} ${fmt(first)}`
        : `${s.label} from ${fmt(first)} to ${fmt(last)}, ${peakText}`
    }
    return `${s.label} total ${fmt(total)}, ${peakText}`
  })
  const kind = stacked ? "Stacked area chart" : "Chart"
  return `${kind} of ${title}, ${data.length} ${data.length === 1 ? "point" : "points"}, ${range}. ${parts.join("; ")}.`
}
