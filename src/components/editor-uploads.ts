"use client";

/**
 * Signed-in editor images that show at once (VEC-455). `RichEditor` inserts a pasted, dropped or attached image
 * straight away from a local preview and stores it through `uploadImage` in the background; the queue is VEC-453's
 * `createUploadQueue`, one per org for the whole tab, so an upload keeps going (and still lands) after the pane or
 * dialog that started it has closed. Uploads in flight hold the leave-page warning.
 *
 * Every save path runs its HTML through `resolveEditorUploads` first: it waits for the uploads the text uses, swaps
 * previews for stored `/api/uploads/...` URLs and drops images that didn't upload, so a `blob:` URL is never sent.
 * Pattern doc: `docs/optimistic-actions.md`.
 */
import { toast } from "sonner";
import { uploadImage } from "@/components/rich-editor";
import { createUploadQueue, type UploadQueue } from "@/lib/background-uploads-core";
import { hasPreviewImages, previewImages, resolvePreviewImages, withoutPreviewImages } from "@/lib/editor-uploads-core";
import { holdWhilePending } from "@/lib/pending-actions-core";
import { ensureLeaveWarning, pendingActions, pendingWork, type ActionResult } from "@/lib/pending-actions";

export { hasPreviewImages, withoutPreviewImages } from "@/lib/editor-uploads-core";

/** How long a finished preview stays resolvable (a save started before the swap can still map it). */
const KEEP_DONE_MS = 30 * 60_000;

const queues = new Map<string, UploadQueue>();

/** Every editor upload queue this tab has (the org ones and editors' own, for custom uploaders). */
const allQueues = new Set<UploadQueue>();

/** Registers a queue so `resolveEditorUploads` can find its previews; returns an unregister function. */
export function trackUploadQueue(queue: UploadQueue) {
  allQueues.add(queue);
  return () => void allQueues.delete(queue);
}

/** The tab-wide queue for signed-in uploads to `orgSlug`. */
export function editorUploadQueue(orgSlug: string): UploadQueue {
  const existing = queues.get(orgSlug);
  if (existing) return existing;
  const created = createUploadQueue({
    upload: (file) => uploadImage(orgSlug, file),
    preview: (file) => URL.createObjectURL(file),
    revoke: (preview) => URL.revokeObjectURL(preview),
    onError: (entry, message) => toast.error(`${entry.name || "The image"} didn't upload. ${message}`, { id: `upload-failed-${entry.preview}` }),
  });
  // Free finished previews after a while (the editor has swapped them for the stored URL long before).
  const scheduled = new Set<string>();
  created.subscribe(() => {
    for (const e of created.entries()) {
      if (e.state === "uploading" || scheduled.has(e.preview)) continue;
      scheduled.add(e.preview);
      setTimeout(() => {
        scheduled.delete(e.preview);
        created.forget(e.preview);
      }, KEEP_DONE_MS);
    }
  });
  ensureLeaveWarning();
  holdWhilePending(created, pendingWork, `uploads:${orgSlug}`);
  queues.set(orgSlug, created);
  trackUploadQueue(created);
  return created;
}

const owner = (preview: string) => [...allQueues].find((q) => q.get(preview)) ?? null;

/**
 * `html` ready to save: waits for the uploads its images still need, swaps their previews for stored URLs and drops
 * images that didn't upload (the editor has already toasted and removed them) or that this tab doesn't know.
 * Text without preview images comes back as is, at once.
 */
export async function resolveEditorUploads(html: string): Promise<string> {
  if (!hasPreviewImages(html)) return html;
  const used = previewImages(html);
  await Promise.all([...new Set(used.map(owner).filter((q): q is UploadQueue => !!q))].map((q) => q.settled()));
  return resolvePreviewImages(html, (preview) => owner(preview)?.stored(preview) ?? null);
}

/**
 * For a record created before its images finished uploading (VEC-455: a new task is created at once, with
 * `withoutPreviewImages(html)`): once the uploads land, saves the full text through `save` on the tab's action
 * queue (network retries, leave-page warning). Does nothing when `html` has no preview images or none uploaded.
 */
export function saveWhenUploaded<T>(key: string, html: string, save: (html: string) => Promise<ActionResult<T>>, onSuccess?: (data: T | undefined) => void) {
  if (!hasPreviewImages(html)) return;
  const saved = withoutPreviewImages(html);
  const release = pendingWork.hold(`images:${key}`);
  void resolveEditorUploads(html)
    .then((full) => {
      if (full === saved) return;
      ensureLeaveWarning();
      pendingActions.enqueue({ key, label: "Adding the images", run: () => save(full), onSuccess });
    })
    .finally(release);
}
