import type { FeedItem, Notification, Task, WorkloadSnapshot } from "@/lib/types";

export type RealtimeEvent =
  /** `task.workingBotIds` is filled in by publish(). `workingOnly`: only which bots are working on it changed. */
  | { type: "task.upsert"; actorId: string; task: Task; descriptionChanged?: boolean; workingOnly?: boolean }
  | { type: "task.delete"; actorId: string; taskId: string }
  | { type: "feed.add"; actorId: string; taskId: string; item: FeedItem }
  | { type: "org.changed"; actorId: string; projectId?: string } // statuses, projects or members changed (projectId: that project's statuses)
  | { type: "notification"; userId: string; notification: Notification } // for one person; others ignore it
  | { type: "notifications.read"; userId: string; ids: string[] | "all" } // keeps that person's other tabs in step
  | { type: "presence"; userIds: string[] } // who has the org open (local driver)
  | { type: "projects.order"; userId: string; projectIds: string[]; at: number } // one person's sidebar order; others ignore it
  | ({ type: "bots.workload" } & WorkloadSnapshot); // per-bot active task counts, sent by publish() after task/org events
