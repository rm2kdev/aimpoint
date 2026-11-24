"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { uploadImage, type ImageUploader } from "@/components/rich-editor";
import { createUploadQueue, UploadsFailedError, type UploadEntry } from "@/lib/background-uploads-core";
import { holdWhilePending } from "@/lib/pending-actions-core";
import { pendingWork } from "@/lib/pending-actions";

export { UploadsFailedError, type UploadEntry } from "@/lib/background-uploads-core";

const noEntries: readonly UploadEntry[] = [];

/**
 * Signed-in image uploads that show at once (VEC-453): `upload` is an `ImageUploader` for `RichEditor` that returns
 * a local object-URL preview immediately and stores the file through `uploadImage(orgSlug, file)` in the background.
 * Before sending, `await resolve(html)` waits for uploads still in flight and swaps previews for stored
 * `/api/uploads/...` URLs; it throws `UploadsFailedError` (message ready for a toast) if an image in the text failed,
 * so a `blob:` URL never reaches the server. Failures also toast as they happen. Uploads in flight hold the
 * leave-page warning. Call `reset()` after a successful send (frees the previews).
 *
 * `options.upload` swaps the transport (the public form/project endpoints use `usePendingUploads` today and could
 * move here with their own uploader).
 */
export function useBackgroundUploads(orgSlug: string, options: { upload?: (file: File) => Promise<string>; onError?: (entry: UploadEntry, message: string) => void } = {}) {
  // The queue lives as long as the component; it reads the latest props, handed over after each render.
  const [{ queue, setLatest }] = useState(() => {
    const latest = { options, orgSlug };
    const queue = createUploadQueue({
      upload: (file) => (latest.options.upload ?? ((f: File) => uploadImage(latest.orgSlug, f)))(file),
      preview: (file) => URL.createObjectURL(file),
      revoke: (preview) => URL.revokeObjectURL(preview),
      onError: (entry, message) => {
        toast.error(`${entry.name || "Image"} didn't upload. ${message}`, { id: `upload-failed-${entry.preview}` });
        latest.options.onError?.(entry, message);
      },
    });
    const setLatest = (o: typeof options, slug: string) => {
      latest.options = o;
      latest.orgSlug = slug;
    };
    return { queue, setLatest };
  });
  useEffect(() => setLatest(options, orgSlug));
  useEffect(() => {
    const off = holdWhilePending(queue, pendingWork, "uploads");
    return () => {
      off();
      queue.reset();
    };
  }, [queue]);
  const entries = useSyncExternalStore(queue.subscribe, queue.entries, () => noEntries);
  const upload: ImageUploader = async (file) => queue.add(file);
  return {
    upload,
    resolve: queue.resolve,
    retry: queue.retry,
    forget: queue.forget,
    reset: queue.reset,
    stored: queue.stored,
    entries,
    uploading: entries.filter((e) => e.state === "uploading").length,
    failed: entries.filter((e) => e.state === "failed"),
  };
}

/** True for the error `resolve` throws when an image in the text didn't upload. */
export const isUploadsFailed = (err: unknown): err is UploadsFailedError => err instanceof UploadsFailedError;
