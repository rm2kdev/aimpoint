/**
 * Who may change a task. The same rule applies to people and bots (bots are never admins):
 *  - "full":     the creator or an org admin: everything, including title, description, project, archive and delete
 *  - "assignee": whoever it's assigned to: status, assignee, priority, type and due date
 *  - "comment":  everyone else in the organisation: read and comment
 */
export type TaskAccess = "full" | "assignee" | "comment";

export const ASSIGNEE_FIELDS = ["statusId", "assigneeId", "priority", "type", "dueDate"] as const;

/**
 * A bot triaging a task (it took it with check_for_triage and hasn't called complete_task or release_task yet)
 * may reshape it like its creator, short of archiving it.
 */
export const TRIAGE_FIELDS = [...ASSIGNEE_FIELDS, "title", "description", "projectId", "dependsOn"] as const;

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
