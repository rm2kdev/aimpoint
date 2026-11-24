/**
 * Background image uploads with an instant local preview (VEC-453, part of VEC-452). Pure and framework-free so
 * `background-uploads.test.mjs` runs it under `node --test`; the React hook is
 * `components/task-composer/background-uploads.ts` (`useBackgroundUploads`). Pattern doc: `docs/optimistic-actions.md`.
 *
 * `add(file)` returns a preview URL (an object URL in the browser) at once and starts the upload. The editor shows
 * the preview straight away. When the text is sent, `resolve(text)` waits for every upload still in flight, then
 * swaps each preview for its stored `/api/uploads/...` URL. A preview whose upload failed is never silently dropped
 * or sent as a `blob:` URL: `resolve` throws `UploadsFailedError` naming it, and `retry(preview)` / `forget(preview)`
 * let the user fix it. Network errors retry with backoff on their own first.
 */
import { backoffDelay, isNetworkError, NETWORK_ERROR_MESSAGE } from "./pending-actions-core";

export type UploadState = "uploading" | "done" | "failed";

export interface UploadEntry {
  /** The local URL shown in the editor until the text is sent. */
  preview: string;
  name: string;
  state: UploadState;
  /** Stored URL once done. */
  url: string | null;
  error: string | null;
  attempts: number;
}

export class UploadsFailedError extends Error {
  failed: UploadEntry[];
  constructor(failed: UploadEntry[]) {
    const names = failed.map((f) => f.name || "image");
    super(
      failed.length === 1
        ? `${names[0]} didn't upload (${failed[0].error ?? "upload failed"}). Retry it or remove it, then send again.`
        : `${failed.length} images didn't upload (${names.join(", ")}). Retry them or remove them, then send again.`,
    );
    this.name = "UploadsFailedError";
    this.failed = failed;
  }
}

export interface UploadQueueOptions {
  /** Stores one file and resolves to its URL (signed in: `uploadImage(orgSlug, file)`). Rejects with a readable message. */
  upload: (file: File) => Promise<string>;
  /** Local preview for a file. Browser: `URL.createObjectURL`. */
  preview: (file: File) => string;
  /** Frees a preview. Browser: `URL.revokeObjectURL`. */
  revoke?: (preview: string) => void;
  /** Automatic retries after a network error. Default 2. */
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** An upload failed for good (after automatic retries). The hook toasts here. */
  onError?: (entry: UploadEntry, message: string) => void;
}

interface Slot {
  entry: UploadEntry;
  file: File;
  /** Settles (never rejects) when the current attempt chain ends. */
  running: Promise<void> | null;
}

export type UploadQueue = ReturnType<typeof createUploadQueue>;

export function createUploadQueue(opts: UploadQueueOptions) {
  const retries = opts.retries ?? 2;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const slots = new Map<string, Slot>();
  const listeners = new Set<() => void>();
  let snapshot: readonly UploadEntry[] = [];
  const emit = () => {
    snapshot = [...slots.values()].map((s) => s.entry);
    listeners.forEach((l) => l());
  };
  const update = (slot: Slot, patch: Partial<UploadEntry>) => {
    slot.entry = { ...slot.entry, ...patch };
    emit();
  };

  async function attempt(slot: Slot) {
    for (let auto = 0; ; auto++) {
      if (!slots.has(slot.entry.preview)) return; // forgotten mid-upload
      update(slot, { state: "uploading", error: null, attempts: slot.entry.attempts + 1 });
      try {
        const url = await opts.upload(slot.file);
        if (slots.get(slot.entry.preview) === slot) update(slot, { state: "done", url });
        return;
      } catch (err) {
        if (isNetworkError(err) && auto < retries) {
          await sleep(backoffDelay(auto + 1, opts.baseDelayMs, opts.maxDelayMs));
          continue;
        }
        const message = isNetworkError(err) ? NETWORK_ERROR_MESSAGE : (err as Error)?.message || "The image didn't upload. Try again.";
        if (slots.get(slot.entry.preview) !== slot) return;
        update(slot, { state: "failed", error: message });
        try {
          opts.onError?.(slot.entry, message);
        } catch (e) {
          console.error(e);
        }
        return;
      }
    }
  }

  const start = (slot: Slot) => {
    const run = attempt(slot).finally(() => {
      if (slot.running === run) slot.running = null;
    });
    slot.running = run;
  };

  /** Starts uploading `file` and returns its preview URL right away (usable as an `ImageUploader`'s result). */
  function add(file: File): string {
    const preview = opts.preview(file);
    const slot: Slot = { entry: { preview, name: file.name, state: "uploading", url: null, error: null, attempts: 0 }, file, running: null };
    slots.set(preview, slot);
    emit();
    start(slot);
    return preview;
  }

  /** Waits for every upload in flight (including ones started while waiting). */
  async function settled() {
    for (;;) {
      const running = [...slots.values()].map((s) => s.running).filter((p): p is Promise<void> => !!p);
      if (!running.length) return;
      await Promise.all(running);
    }
  }

  /**
   * `text` (HTML or Markdown) with every preview swapped for its stored URL, once in-flight uploads finish. Throws
   * `UploadsFailedError` if a preview still in `text` failed. Previews no longer in `text` are ignored.
   */
  async function resolve(text: string): Promise<string> {
    await settled();
    const used = [...slots.values()].filter((s) => text.includes(s.entry.preview));
    const failed = used.filter((s) => s.entry.state !== "done" || !s.entry.url).map((s) => s.entry);
    if (failed.length) throw new UploadsFailedError(failed);
    let out = text;
    for (const s of used) out = out.split(s.entry.preview).join(s.entry.url!);
    return out;
  }

  /** Uploads a failed image again. Resolves when that attempt ends; false if there was nothing to retry. */
  async function retry(preview: string) {
    const slot = slots.get(preview);
    if (!slot || slot.entry.state !== "failed") return false;
    start(slot);
    await slot.running;
    return true;
  }

  /** Drops an image the user removed (an upload in flight finishes, but its result is ignored). */
  function forget(preview: string) {
    if (!slots.delete(preview)) return;
    opts.revoke?.(preview);
    emit();
  }

  /** Drops everything, e.g. after the text was sent or the draft discarded. */
  function reset() {
    slots.forEach((_s, preview) => opts.revoke?.(preview));
    slots.clear();
    emit();
  }

  return {
    add,
    resolve,
    settled,
    retry,
    forget,
    reset,
    /** The stored URL behind a preview, null until it's done. */
    stored: (preview: string) => slots.get(preview)?.entry.url ?? null,
    get: (preview: string) => slots.get(preview)?.entry ?? null,
    entries: () => snapshot,
    /** Uploads still in flight (what `beforeunload` warns about). */
    count: () => snapshot.filter((e) => e.state === "uploading").length,
    failed: () => snapshot.filter((e) => e.state === "failed"),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
