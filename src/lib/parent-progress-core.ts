// VEC-419: a parent task follows its sub-tasks' activity. Pure rules (no "server-only", no path aliases), so node tests
// import this file directly. The server side (lib/parent-progress.ts) loads the stages and does the conditional write.
//
// Rule: once any sub-task has activity (it moves into a started or done stage status, by any path), a parent that sits
// in a not-started (unstarted-stage) status is moved to the first started status of its own project. Nothing else
// moves: a parked Backlog parent, one in Triage, one already started, done or cancelled stays put, and a parent is never
// moved backwards (sub-tasks going back to Todo, or being cancelled, change nothing).

/** Status stages (lib/types.ts StatusCategory), repeated here so this module stays import-free. */
export type Stage = "backlog" | "triage" | "unstarted" | "started" | "done" | "cancelled";

/** Sub-task stages that count as activity on its parent. Cancelled alone isn't work being done. */
export const ACTIVITY_STAGES: readonly Stage[] = ["started", "done"];

export interface ParentProgressInput {
  /** The parent's current status stage. */
  parentStage: Stage | null | undefined;
  /** The sub-task's status stage after the write. */
  subtaskTo: Stage | null | undefined;
  /** The parent is archived. */
  parentArchived?: boolean;
  /** A person stopped the bot's work on the parent (VEC-215): auto-starting it would undo their stop. */
  parentStopped?: boolean;
}

export type ParentProgressReason = "started" | "done";

/**
 * Should the parent move to its project's first started status? Returns why ("started" / "done": the stage the
 * sub-task just entered, for the activity line) or null to leave it alone. Only a change of the sub-task's status
 * counts, and only into a started or done stage; the parent must be in a not-started status.
 */
export function parentProgress(input: ParentProgressInput): ParentProgressReason | null {
  const { parentStage, subtaskTo } = input;
  if (input.parentArchived || input.parentStopped) return null;
  if (parentStage !== "unstarted") return null;
  // Any status change into a started or done stage counts (In Progress -> In Review too), so a parent someone put
  // back to Todo while its sub-tasks are worked on restarts on the next sub-task move. Callers only ask on a real
  // status change (or a sub-task created straight into such a status).
  if (subtaskTo !== "started" && subtaskTo !== "done") return null;
  return subtaskTo;
}

/**
 * The status a parent moves to: the flow's working status for its current step when the parent has an active flow
 * (pickup rules, lib/flow-engine pickupTarget: "move" = that status, "stay" = the step forbids leaving its status,
 * "legacy" = no flow in charge), else the first started-stage status of the parent's own project in workflow order.
 * Returns null when nothing qualifies (the project has no started status, or the flow keeps it where it is).
 */
export function parentTarget<S extends { id: string; stage: Stage; order: number }>(
  statuses: readonly S[],
  flow: { kind: "legacy" } | { kind: "stay" } | { kind: "move"; statusId: string },
): S | null {
  if (flow.kind === "stay") return null;
  if (flow.kind === "move") {
    const s = statuses.find((x) => x.id === flow.statusId);
    // A flow's working status is a started one; anything else would skip a step, so leave the parent alone.
    return s && s.stage === "started" ? s : null;
  }
  return [...statuses].sort((a, b) => a.order - b.order).find((s) => s.stage === "started") ?? null;
}

/**
 * VEC-444: a parent's own status was just written into a not-started status (triage close-out Triage -> Todo, a
 * manual move, a flow step). Which of its current non-archived sub-tasks counts as the activity that starts it, as if
 * that sub-task had just entered its status: the most recently changed started one (work is under way), else the most
 * recently changed done one, else none (nothing to do). The VEC-420 backfill asks the same question per stuck parent.
 * Feed the result's stage to parentProgress as `subtaskTo`.
 */
export function pickActiveSubtask<T extends { stage: Stage | null | undefined; updatedAt: Date | string | number }>(subs: readonly T[]): T | null {
  const at = (t: T) => new Date(t.updatedAt).getTime();
  const newest = (list: T[]) => (list.length ? list.reduce((a, b) => (at(b) > at(a) ? b : a)) : null);
  return newest(subs.filter((s) => s.stage === "started")) ?? newest(subs.filter((s) => s.stage === "done"));
}

/**
 * Activity notes of the parent's move. Written in the actor's name on the PARENT, though the actor worked on the
 * sub-task: checks for "has this bot acted on this task" (wake landed, run quiet, retry busy) must skip them.
 */
export const PARENT_PROGRESS_NOTES = ["subtask_started", "subtask_done"] as const;

/** Activity wording: "moved from Todo to In Progress (sub-task VEC-12 started)". */
export function parentProgressText(reason: ParentProgressReason | null | undefined, subtaskKey: string | null | undefined): string {
  const which = subtaskKey ? `sub-task ${subtaskKey}` : "a sub-task";
  return reason === "done" ? ` (${which} is done)` : ` (${which} started)`;
}
