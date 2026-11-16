import { REQUIRED_STAGES, STATUS_STAGES, type Status, type StatusCategory } from "@/lib/types";

/**
 * Status stages for people (VEC-117). Stages are fixed and shared by every project; each project names its own
 * statuses on top of them. Client-safe: settings, cross-project list headings and stage filters use it.
 */
export const STAGE_LABELS: Record<StatusCategory, string> = {
  backlog: "Backlog",
  triage: "Triage",
  unstarted: "Not started",
  started: "In progress",
  done: "Done",
  cancelled: "Cancelled",
};

/** Colours for stage headings in cross-project views (the default statuses' colours). */
const STAGE_COLORS: Record<StatusCategory, string> = {
  backlog: "#a3a3a3",
  triage: "#d6409f",
  unstarted: "#737373",
  started: "#e5a00d",
  done: "#2f6fed",
  cancelled: "#a3a3a3",
};

/**
 * A stand-in status for a stage, so a stage heading can draw a StatusRing. The in-progress ring sits half full.
 * `STAGE_RING_LIST` is the matching list to pass as `statuses`.
 */
export const stageStatus = (stage: StatusCategory): Status => ({
  id: `stage:${stage}`,
  projectId: "",
  name: STAGE_LABELS[stage],
  color: STAGE_COLORS[stage],
  category: stage,
  order: STATUS_STAGES.indexOf(stage),
});
export const STAGE_RING_LIST: Status[] = [stageStatus("unstarted"), stageStatus("started"), { ...stageStatus("started"), id: "stage:started-2", order: 99 }];

/** "Done" / "a Done" style label for the required-stage hint: "needs a Not started status". */
export function requiredStageHint(missing: StatusCategory[]): string {
  if (!missing.length) return "";
  const names = missing.map((s) => STAGE_LABELS[s]);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Every project keeps at least one ${list} status${missing.length > 1 ? " each" : ""}.`;
}

export const isRequiredStage = (s: StatusCategory) => REQUIRED_STAGES.includes(s);
