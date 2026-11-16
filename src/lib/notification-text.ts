import type { Notification } from "@/lib/types";

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
  }
}
