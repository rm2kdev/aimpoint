/**
 * Who may change a task. The same rule applies to people and bots (bots are never admins):
 *  - "full":     the creator or an org admin: everything, including title, description, triage plan, project, archive and delete
 *  - "assignee": whoever it's assigned to: status, assignee, priority, type and due date
 *  - "comment":  everyone else in the organisation: read and comment
 */
export type TaskAccess = "full" | "assignee" | "comment";

export const ASSIGNEE_FIELDS = ["statusId", "assigneeId", "priority", "type", "dueDate"] as const;

/**
 * A bot triaging a task (it took it with check_for_triage and hasn't called complete_task or release_task yet)
 * may reshape it like its creator, short of archiving it and replacing the reporter's description (VEC-402): its
 * write-up goes in the separate triage plan (`triagePlan`) instead, so the original report is never lost.
 */
export const TRIAGE_FIELDS = [...ASSIGNEE_FIELDS, "title", "triagePlan", "projectId", "dependsOn"] as const;

/** Refusal for a triaging bot (not the creator or an admin) that sent `description` (VEC-402). */
export const TRIAGE_DESCRIPTION_REFUSAL = "While triaging you can't replace the reporter's description; put your plan in `plan` instead.";
/** Refusal for a triaging bot that tried anything else outside TRIAGE_FIELDS (archiving). */
export const TRIAGE_ARCHIVE_REFUSAL = "While triaging you can change everything except archiving. Only the task's creator or an admin can archive it.";
export const ASSIGNEE_REFUSAL =
  "Only the task's creator or an admin can change its title, description, plan, project or dependencies, or archive it. As the assignee you can change status, assignee, priority, type and due date.";

/**
 * The patch fields a non-full actor may not set (undefined values don't count), and why, or null when the patch is
 * allowed. `triaging` picks TRIAGE_FIELDS, otherwise ASSIGNEE_FIELDS. Creators and admins ("full") never reach this.
 */
export function refusePatch(patch: Record<string, unknown>, triaging: boolean): { blocked: string[]; error: string } | null {
  const allowed = new Set<string>(triaging ? TRIAGE_FIELDS : ASSIGNEE_FIELDS);
  const blocked = Object.keys(patch).filter((k) => patch[k] !== undefined && !allowed.has(k));
  if (!blocked.length) return null;
  if (!triaging) return { blocked, error: ASSIGNEE_REFUSAL };
  return { blocked, error: blocked.includes("description") ? TRIAGE_DESCRIPTION_REFUSAL : TRIAGE_ARCHIVE_REFUSAL };
}

/**
 * The bot that triaged a task (TaskDoc.triagedBy) may close it out once it's ready: comment, and move it to
 * a closing status. Nothing else.
 */
export const CLOSE_OUT_FIELDS = ["statusId"] as const;

/**
 * Statuses a triager may close a task out to: any done or cancelled stage, plus review-like started
 * statuses (started-stage statuses after the first one in the workflow, e.g. "In Review" after "In Progress").
 */
export function closeOutStatuses<S extends { category: string; order: number }>(statuses: S[]): S[] {
  const sorted = [...statuses].sort((a, b) => a.order - b.order);
  const firstStarted = sorted.find((s) => s.category === "started");
  return sorted.filter(
    (s) => s.category === "done" || s.category === "cancelled" || (s.category === "started" && !!firstStarted && s !== firstStarted && s.order > firstStarted.order),
  );
}

export function taskAccess(task: { createdBy: string; assigneeId: string | null }, actorId: string, isAdmin: boolean): TaskAccess {
  if (isAdmin || task.createdBy === actorId) return "full";
  if (task.assigneeId && task.assigneeId === actorId) return "assignee";
  return "comment";
}
