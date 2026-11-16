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
  type Series,
  type ValueFormatter,
} from "./chart-frame"
import { formatCompact, formatExact, formatNumber, formatTick, type Granularity, type TimeValue } from "./format"

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
  const empty = !data.length || !series.length
  const area = stacked || variant === "area"
  // A lone bucket has no line to draw, so always show dots on short series.
  const dots = data.length <= 2 ? { r: 3, strokeWidth: 0, fill: undefined } : false

  const text = summary ?? describe(title, data, series, granularity, valueFormatter, stacked)

  const table = () => (
    <DataTable
      caption={title}
      rows={data}
      columns={[
        { label: granularity === "hour" ? "Time" : "Date", cell: (d) => formatExact(d.t, granularity) },
        ...series.map((s) => ({ label: s.label, numeric: true, cell: (d: TimePoint) => valueFormatter(num(d[s.key])) })),
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
        tickFormatter={(i: number) => (rows[i] ? formatTick(rows[i].t, granularity) : "")}
      />
      <YAxis
        tickLine={false}
        axisLine={false}
        width={40}
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
      legend={
        series.length > 1 ? (
          <SeriesLegend items={series.map((s, i) => ({ label: s.label, color: chartColor(i, s.color) }))} />
        ) : null
      }
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
                type="monotone"
                stackId={stacked ? "stack" : undefined}
                stroke={seriesVar(i)}
                strokeWidth={1.75}
                fill={seriesVar(i)}
                fillOpacity={stacked ? 0.35 : 0.14}
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
                type="monotone"
                stroke={seriesVar(i)}
                strokeWidth={1.75}
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
    return `${s.label} total ${fmt(total)}, peak ${fmt(peak)} on ${formatExact(peakAt, g)}`
  })
  const kind = stacked ? "Stacked area chart" : "Chart"
  return `${kind} of ${title}, ${data.length} ${data.length === 1 ? "point" : "points"}, ${range}. ${parts.join("; ")}.`
}
