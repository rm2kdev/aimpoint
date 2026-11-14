import type { FeedItem, Task } from "@/lib/types";

export type RealtimeEvent =
  | { type: "task.upsert"; actorId: string; task: Task; descriptionChanged?: boolean }
  | { type: "task.delete"; actorId: string; taskId: string }
  | { type: "feed.add"; actorId: string; taskId: string; item: FeedItem }
  | { type: "org.changed"; actorId: string }; // statuses, projects or members changed
