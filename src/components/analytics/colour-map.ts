import type { Priority, StatusCategory, TaskType } from "@/lib/types"

/**
 * Semantic slice colours for the categorical charts (DESIGN.md > Analytics charts > Colour map,
 * VEC-147). A slice's colour comes from what it is, never its rank, so a stage keeps its colour
 * when another one is zero and the same measure reads the same on every card.
 */

/** A theme-aware tint of a chart token: an SVG fill and a CSS background alike, so swatches equal slices. */
export const chartTint = (n: 1 | 2 | 3 | 4 | 5 | 6, pct = 100): string =>
  pct >= 100 ? `var(--chart-${n})` : `color-mix(in oklab, var(--chart-${n}) ${pct}%, var(--card))`

/** By stage: Done = Closed indigo, In progress = Open orange, Triage pink, parked work quietest. */
export const STAGE_FILL: Record<StatusCategory, string> = {
  done: chartTint(1),
  started: chartTint(5),
  triage: chartTint(4),
  unstarted: chartTint(6),
  backlog: chartTint(6, 60),
  cancelled: chartTint(6, 30),
}

/** Open by priority: one ordered ramp of chart-5, lightness carrying the order (index = Priority). */
export const PRIORITY_FILL: Record<Priority, string> = {
  3: chartTint(5),
  2: chartTint(5, 65),
  1: chartTint(5, 35),
  0: chartTint(6, 45),
}

/** Open by type: the type tokens, shared with the TypeSquare (TYPE_SWATCH) so tag and slice can't drift. */
export const TYPE_FILL: Record<TaskType, string> = {
  issue: "var(--type-issue)",
  feature: "var(--type-feature)",
  task: "var(--type-task)",
}
