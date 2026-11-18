/**
 * Moving a task into or out of Backlog while a bot is assigned (VEC-275, follows VEC-274's parking rule). Pure and
 * client-safe so `node --test` covers the decisions; lib/task-service.ts (updateTaskAs) turns them into writes. Every
 * status write goes through updateTaskAs: MCP set_status / update_task / complete_task, REST PATCH, the board drag
 * (moveTask) and the task page (updateTask action), so these rules cover all of them.
 *
 * - Unpark: the task was parked (lib/flow-engine isParked) and isn't any more. Its assigned bot gets the same
 *   `assigned` wake-up as a fresh assignment, once, if the task is ready, unarchived, not stopped and now in a not-started or started status (not Triage, Done or Cancelled).
 * - Park: the task wasn't parked and now is. Bots working on it (in-progress, non-triage claims) are released and,
 *   unless the bot made the move itself, told to stop (signalStop, the Stop path's run cancel / task.stopped event).
 *   Their other non-triage claims go too, so leaving Backlog later hands the task over afresh.
 */

export type BacklogMove = "park" | "unpark" | null;

/** Whether this write parked or unparked the task. */
export function backlogMove(wasParked: boolean, nowParked: boolean): BacklogMove {
  if (wasParked === nowParked) return null;
  return nowParked ? "park" : "unpark";
}

/**
 * Which one hand-off a write makes after its broadcast. At most one per write, so a status change and an assignee
 * change in the same write wake the bot once: a new assignee is told through the assignment (which already covers
 * leaving Backlog), a same-owner flow step through its hand-off, a last dependency removed through the ready
 * hand-off, and only otherwise an unpark.
 */
export type WriteHandOff = "assignment" | "same_owner" | "ready" | "unpark" | null;

export function writeHandOff(w: { assigneeSet: boolean; sameOwnerHandoff: boolean; nowReady: boolean; move: BacklogMove }): WriteHandOff {
  if (w.assigneeSet) return "assignment";
  if (w.sameOwnerHandoff) return "same_owner";
  if (w.nowReady) return "ready";
  if (w.move === "unpark") return "unpark";
  return null;
}

/** The unparked task's state, as the assigned wake-up sees it. */
export interface UnparkState {
  assigneeIsBot: boolean;
  /** The assignee already holds a claim (a flow step that owns the Backlog status handed it over already). */
  assigneeHasClaim: boolean;
  archived: boolean;
  /** The stage of the status it moved to: only a not-started (Todo) or started one is work to hand out. */
  stage: string | null;
  /** Open dependencies left: the ready hand-off releases it later. */
  waiting: boolean;
  /** A person stopped the bot's work on it (VEC-215): Resume hands it back. */
  stopped: boolean;
  /** Still parked (moved to another Backlog status, say). */
  parked: boolean;
}

/** Whether leaving Backlog wakes the assigned bot. */
export function unparkWakes(s: UnparkState): boolean {
  const work = s.stage === "unstarted" || s.stage === "started";
  return work && s.assigneeIsBot && !s.assigneeHasClaim && !s.archived && !s.waiting && !s.stopped && !s.parked;
}

export interface ParkClaim {
  id: string;
  botId: string;
  kind?: "assigned" | "triage" | null;
  state: "in_progress" | "done" | "stopped";
}

/**
 * What parking does to the task's claims. `release`: non-triage claims to delete (triage claims stay with the
 * triage flow; a stopped task keeps everything, its Resume owns those). `signal`: bots to tell to stop, the ones
 * that were working on it (in-progress), except the bot that moved it into Backlog itself.
 */
export function parkRelease(claims: ParkClaim[], opts: { actorId: string; stopped: boolean }): { release: string[]; signal: string[] } {
  if (opts.stopped) return { release: [], signal: [] };
  const work = claims.filter((c) => c.kind !== "triage" && c.state !== "stopped");
  const signal = [...new Set(work.filter((c) => c.state === "in_progress" && c.botId !== opts.actorId).map((c) => c.botId))];
  return { release: work.map((c) => c.id), signal };
}
