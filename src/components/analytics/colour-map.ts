import type { Priority, StatusCategory, TaskType } from "@/lib/types"

/**
 * Semantic slice colours for the categorical charts (DESIGN.md > Analytics charts > Colour map,
 * VEC-147, VEC-162). A slice's colour comes from what it is, never its rank, so a stage keeps its
 * colour when another one is zero and the same measure reads the same on every card.
 *
 * Contrast (VEC-162): every fill is at least 3:1 against the card in light and dark, except the quiet
 * tints marked `edge`, which carry a 1px Faint Ink boundary (4.7:1 light, 5.7:1 dark) on the slice and
 * on every swatch. Within one donut every pair stays at least 10 apart (OKLab x100) under a
 * deuteranopia simulation in both themes, so lightness carries the difference where hue can't.
 */

type ChartToken = 1 | 2 | 3 | 4 | 5 | 6

/** A tint of a chart token towards the card surface (`--background`, the fill of `AnalyticsCard`). */
export const chartTint = (n: ChartToken, pct = 100): string =>
  pct >= 100 ? `var(--chart-${n})` : `color-mix(in oklab, var(--chart-${n}) ${pct}%, var(--background))`

/** A chart token pushed towards Ink: darker in light, lighter in dark, so always stronger on the card. */
export const chartDeep = (n: ChartToken, pct: number): string =>
  `color-mix(in oklab, var(--chart-${n}) ${pct}%, var(--foreground))`

/** A slice colour: an SVG fill and a CSS background alike, so swatches equal slices. */
export interface SliceColour {
  color: string
  /** Under 3:1 against the card: the slice and its swatches carry the Faint Ink boundary. */
  edge?: boolean
}

/** Boundary for `edge` slices and swatches: Faint Ink, at least 3:1 on the card in both themes. */
export const SLICE_EDGE = "var(--faint)"

/**
 * By stage: Done = Closed indigo, In progress = Open orange, Triage pink, Not started the neutral
 * pushed towards Ink (clear of Triage's lightness, which reads grey under deuteranopia), parked and
 * cancelled work the quietest tints of the neutral.
 */
export const STAGE_FILL: Record<StatusCategory, SliceColour> = {
  done: { color: chartTint(1) },
  started: { color: chartTint(5) },
  triage: { color: chartTint(4) },
  unstarted: { color: chartDeep(6, 40) },
  backlog: { color: chartTint(6, 60), edge: true },
  cancelled: { color: chartTint(6, 20), edge: true },
}

/**
 * Open by priority: one ordered ramp of chart-5 by contrast with the card (index = Priority): High
 * pushed towards Ink, Medium the token, Low a tint; No priority is the faintest neutral tint.
 */
export const PRIORITY_FILL: Record<Priority, SliceColour> = {
  3: { color: chartDeep(5, 50) },
  2: { color: chartTint(5) },
  1: { color: chartTint(5, 55), edge: true },
  0: { color: chartTint(6, 10), edge: true },
}

/** Open by type: the type tokens, shared with the TypeSquare (TYPE_SWATCH) so tag and slice can't drift. */
export const TYPE_FILL: Record<TaskType, SliceColour> = {
  issue: { color: "var(--type-issue)" },
  feature: { color: "var(--type-feature)" },
  task: { color: "var(--type-task)" },
}
