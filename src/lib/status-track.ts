// The steps the task pane's status bar draws (VEC-329): one track for every task, so the flow stepper look is the
// default. Pure and client-safe (no value imports), unit tested in status-track.test.mjs.
import type { StatusCategory } from "./types";

export interface TrackStatusLike {
  id: string;
  name: string;
  category: StatusCategory;
  order: number;
}

export interface TrackFlowStep {
  id: string;
  name: string;
  status: TrackStatusLike;
}

export type TrackState = "done" | "current" | "upcoming" | "skipped";

export interface TrackStep {
  id: string;
  name: string;
  /** The status the step stands for (the flow step's status, or the status itself). */
  statusName: string;
  category: StatusCategory;
  state: TrackState;
}

/**
 * Why the track looks the way it does:
 * - `flow`: the task is at one of its flow's steps (the flow's own steps are drawn);
 * - `no_flow`: the project has no flow, so its statuses are the steps;
 * - `paused`: the flow is paused, so it doesn't apply right now (statuses drawn);
 * - `off_flow`: its status is none of the flow's steps, e.g. Cancelled or a status the flow skips (statuses drawn).
 */
export type TrackReason = "flow" | "no_flow" | "paused" | "off_flow";

export interface StatusTrack {
  source: "flow" | "statuses";
  reason: TrackReason;
  steps: TrackStep[];
  /** Index of the current step, -1 when the task's status isn't known. */
  index: number;
  /** At a done-stage step (flow finished / Done), or Cancelled. */
  finished: boolean;
  /** Accessible summary, e.g. "Step 2 of 4: Build" or "Status 3 of 5: In Progress". */
  label: string;
}

export interface StatusTrackInput {
  /** The project's statuses (any order; sorted by `order` here). */
  statuses: readonly TrackStatusLike[];
  /** The task's status id. */
  statusId: string;
  /** The project's flow, when it has one. */
  flow?: { steps: readonly TrackFlowStep[] } | null;
  /** Index into `flow.steps` of the step the task is at (lib/flow-engine-core `locateStep`), -1 when none fits. */
  stepIndex?: number;
  /** The task's flow is paused (`task.flow.paused`). */
  paused?: boolean;
}

const closedCategory = (c: StatusCategory | undefined) => c === "done" || c === "cancelled";

/**
 * The ordered steps of a task's status bar plus which is done / current / upcoming.
 * At a flow step (flow present, not paused, step located): the flow's steps, earlier ones done, a finished flow's
 * last step done too. Otherwise the project's own statuses in `order`, with triage-stage and cancelled statuses left
 * out unless the task is in one (then it's the current step). Statuses before the current one count as done; on a
 * Cancelled task nothing else does (it never got there), so every other step is `skipped`.
 */
export function statusTrack({ statuses, statusId, flow, stepIndex = -1, paused = false }: StatusTrackInput): StatusTrack {
  if (flow && !paused && stepIndex >= 0 && stepIndex < flow.steps.length) {
    const current = flow.steps[stepIndex];
    const finished = current.status.category === "done";
    const steps = flow.steps.map((s, i): TrackStep => ({
      id: s.id,
      name: s.name,
      statusName: s.status.name,
      category: s.status.category,
      state: i < stepIndex || (finished && i === stepIndex) ? "done" : i === stepIndex ? "current" : "upcoming",
    }));
    const label = finished ? `Flow finished at ${current.name}` : `Step ${stepIndex + 1} of ${steps.length}: ${current.name}`;
    return { source: "flow", reason: "flow", steps, index: stepIndex, finished, label };
  }

  const reason: TrackReason = !flow ? "no_flow" : paused ? "paused" : "off_flow";
  const shown = [...statuses].sort((a, b) => a.order - b.order).filter((s) => s.id === statusId || (s.category !== "triage" && s.category !== "cancelled"));
  const index = shown.findIndex((s) => s.id === statusId);
  const current = index >= 0 ? shown[index] : null;
  const cancelled = current?.category === "cancelled";
  const steps = shown.map((s, i): TrackStep => ({
    id: s.id,
    name: s.name,
    statusName: s.name,
    category: s.category,
    state: i === index ? "current" : cancelled ? "skipped" : index >= 0 && i < index ? "done" : "upcoming",
  }));
  const label = current ? `Status ${index + 1} of ${steps.length}: ${current.name}` : "Status unknown";
  return { source: "statuses", reason, steps, index, finished: closedCategory(current?.category), label };
}
