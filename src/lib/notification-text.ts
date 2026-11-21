import type { Notification } from "@/lib/types";

/**
 * VEC-394: the stalled headline follows the stored reason. Rows from before VEC-394 have no reason: the unfinished
 * notice was the only one sent with an actor (the bot), so an actor means unfinished and none means unassigned.
 */
function stalledWhy(n: Notification, actorName: string | null) {
  const reason = n.reason ?? (n.actorId ? "unfinished" : "unassigned");
  const bot = actorName ?? "its bot";
  switch (reason) {
    case "unassigned":
    case "needs_owner":
      return "nobody is assigned to it";
    case "unfinished":
      return `${bot} left it unfinished`;
    case "finished":
      return `${bot} finished but left it open`;
    case "undelivered":
      return `it never reached ${bot}`;
  }
}

/** One line saying what happened, for the inbox row and the live toast. */
export function notificationHeadline(n: Notification, actorName: string | null) {
  switch (n.kind) {
    case "assigned":
      return `${actorName ?? "Someone"} assigned you ${n.taskKey}`;
    case "mentioned":
      return `${actorName ?? "Someone"} mentioned you on ${n.taskKey}`;
    case "ready":
      return `${n.taskKey} is ready to work on`;
    case "review":
      return `${actorName ?? "Someone"} needs your review on ${n.taskKey}`;
    case "undelivered":
      return `${n.taskKey} never reached ${actorName ?? "its bot"}`;
    case "stalled":
      return `${n.taskKey} is stalled: ${stalledWhy(n, actorName)}`;
    case "waiting":
      return `${n.taskKey} is still waiting`;
  }
}
