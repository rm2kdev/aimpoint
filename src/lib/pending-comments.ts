"use client";

/**
 * Browser side of instant comments (VEC-454): one tab-wide store of comments that are shown but not stored yet, and
 * the upload queue for images attached in the comment composer. Both outlive the task pane, so switching tasks while
 * a comment is still sending (or failed) loses nothing. Rules + tests: `pending-comments-core.ts`. Pattern doc:
 * `docs/optimistic-actions.md`.
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { addComment } from "@/app/actions/tasks";
import { uploadImage } from "@/components/rich-editor";
import { createUploadQueue, type UploadEntry } from "./background-uploads-core";
import { holdWhilePending } from "./pending-actions-core";
import { pendingActions, pendingWork } from "./pending-actions";
import { createCommentStore, type LocalComment } from "./pending-comments-core";
import type { CommentResult } from "./types";

export { mergeFeed, addOnce, type FeedRow, type LocalComment } from "./pending-comments-core";

/** Which org each attached file goes to (the queue's uploader only gets the file). */
const slugOf = new WeakMap<File, string>();

/** Images attached in comment composers: a local preview at once, stored in the background. */
export const commentUploads = createUploadQueue({
  upload: (file) => uploadImage(slugOf.get(file) ?? "", file),
  preview: (file) => URL.createObjectURL(file),
  revoke: (preview) => URL.revokeObjectURL(preview),
  onError: (entry, message) => toast.error(`${entry.name || "Image"} didn't upload. ${message}`, { id: `upload-failed-${entry.preview}` }),
});

/** Fetches stored images into the browser cache (they're served immutable), giving up after 15 s. */
function warmImages(urls: string[]): Promise<void> {
  return Promise.all(
    urls.map(
      (url) =>
        new Promise<void>((done) => {
          const img = new Image();
          const timer = setTimeout(done, 15_000);
          img.onload = img.onerror = () => {
            clearTimeout(timer);
            done();
          };
          img.src = url;
        }),
    ),
  ).then(() => {});
}

export const commentStore = createCommentStore<CommentResult>({ queue: pendingActions, uploads: commentUploads, addComment, warm: warmImages });

let wired = false;
function wire() {
  if (wired || typeof window === "undefined") return;
  wired = true;
  holdWhilePending(commentUploads, pendingWork, "comment-uploads");
}

/** Starts storing an image for org `slug`; returns its preview URL right away. */
export function addCommentImage(slug: string, file: File): string {
  wire();
  slugOf.set(file, slug);
  return commentUploads.add(file);
}

const none: readonly LocalComment[] = [];
const noUploads: readonly UploadEntry[] = [];

/** This task's comments that are shown but not stored yet (pending, failed, or just posted). */
export function useLocalComments(taskId: string | null | undefined): LocalComment[] {
  useEffect(wire, []);
  const all = useSyncExternalStore(commentStore.subscribe, commentStore.all, () => none);
  return useMemo(() => (taskId ? all.filter((l) => l.taskId === taskId) : []), [all, taskId]);
}

/** Live state of the composer's images (by preview URL). */
export function useCommentUploads(): readonly UploadEntry[] {
  return useSyncExternalStore(commentUploads.subscribe, commentUploads.entries, () => noUploads);
}
