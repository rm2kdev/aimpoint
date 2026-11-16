"use client"

import * as React from "react"
import { Cell, Pie, PieChart } from "recharts"
import { ChartContainer, ChartTooltip } from "@/components/ui/chart"
import {
  ChartFrame,
  DataTable,
  KitTooltip,
  SeriesLegend,
  chartColor,
  type ChartColor,
  type ValueFormatter,
} from "./chart-frame"
import { formatNumber, formatPercent } from "./format"

export interface DonutSlice {
  key: string
  label: string
  value: number
  color?: ChartColor
}

export interface DonutChartProps {
  title: string
  description?: React.ReactNode
  data: DonutSlice[]
  /** Small caption under the total in the hole (e.g. "tickets"). */
  centerLabel?: string
  valueFormatter?: ValueFormatter
  loading?: boolean
  emptyMessage?: string
  summary?: string
  height?: number
  className?: string
}

export function DonutChart({
  title,
  description,
  data,
  centerLabel = "Total",
  valueFormatter = formatNumber,
  loading,
  emptyMessage,
  summary,
  height = 200,
  className,
}: DonutChartProps) {
  const slices = React.useMemo(
    () =>
      data
        .filter((d) => Number.isFinite(d.value) && d.value > 0)
        .map((d, i) => ({ ...d, fill: chartColor(i, d.color) })),
    [data],
  )
  const config = React.useMemo(
    () => Object.fromEntries(slices.map((s) => [s.key, { label: s.label, color: s.fill }])),
    [slices],
  )
  const total = slices.reduce((n, s) => n + s.value, 0)
  const empty = total <= 0
  const share = (v: number) => (total > 0 ? formatPercent(v / total) : "0%")

  const text =
    summary ??
    (empty
      ? `${title}: no data`
      : `Donut chart of ${title}, total ${valueFormatter(total)}. ${slices
          .map((s) => `${s.label} ${valueFormatter(s.value)} (${share(s.value)})`)
          .join(", ")}.`)

  const table = () => (
    <DataTable
      caption={title}
      rows={[...slices, { key: "__total", label: "Total", value: total, fill: "" }]}
      columns={[
        { label: "Segment", cell: (s) => s.label },
        { label: "Value", numeric: true, cell: (s) => valueFormatter(s.value) },
        { label: "Share", numeric: true, cell: (s) => share(s.value) },
      ]}
    />
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
        <SeriesLegend
          items={slices.map((s) => ({ label: s.label, color: s.fill, value: share(s.value) }))}
        />
      }
    >
      <div className="relative h-full">
      <ChartContainer config={config} className="aspect-auto h-full w-full">
        <PieChart>
          <ChartTooltip
            isAnimationActive={false}
            content={(p) => (
              <KitTooltip
                {...p}
                format={(v) => `${valueFormatter(v)} · ${share(v)}`}
                heading={() => title}
              />
            )}
          />
          <Pie
            data={slices}
            dataKey="value"
            nameKey="label"
            innerRadius="62%"
            outerRadius="92%"
            paddingAngle={slices.length > 1 ? 1.5 : 0}
            stroke="var(--background)"
            strokeWidth={slices.length > 1 ? 1 : 0}
            isAnimationActive={false}
          >
            {slices.map((s) => (
              <Cell key={s.key} fill={s.fill} />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>
      {/* The total sits in the hole; HTML rather than an SVG label so it uses the type scale. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-mono text-[18px] leading-tight font-semibold tabular-nums">{valueFormatter(total)}</span>
        <span className="text-[11px] text-faint">{centerLabel}</span>
      </div>
      </div>
    </ChartFrame>
  )
}
