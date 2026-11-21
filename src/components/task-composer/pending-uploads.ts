"use client";

import { useEffect, useRef, useState } from "react";
import type { ImageUploader } from "@/components/rich-editor";

/**
 * Pending image uploads for the public surfaces (VEC-358): project forms post to `/api/forms/<publicId>/uploads`,
 * public projects to `/api/public/<org>/<KEY>/uploads` (both answer `{url}` or `{error}`, 429 with Retry-After). The
 * stored file is only readable by the team until a task claims it, so the submitter's editor shows a local preview
 * (an object URL) and `resolve` swaps each preview for its stored URL when sending.
 */
export function usePendingUploads(endpoint: string) {
  const urls = useRef(new Map<string, string>());
  const [uploading, setUploading] = useState(0);
  useEffect(() => {
    const map = urls.current;
    return () => map.forEach((_url, preview) => URL.revokeObjectURL(preview));
  }, []);

  /** Uploads one image; returns its local preview URL. Throws with a message for the submitter. */
  const upload: ImageUploader = async (file) => {
    setUploading((n) => n + 1);
    try {
      const body = new FormData();
      body.set("file", file);
      let res: Response;
      try {
        res = await fetch(endpoint, { method: "POST", body });
      } catch {
        throw new Error("Couldn't reach the server to upload the image. Check your connection and try again.");
      }
      const json = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!res.ok || !json?.url) {
        if (json?.error) throw new Error(json.error);
        if (res.status === 413) throw new Error("That image is too large. Images can be up to 5 MB.");
        if (res.status === 429) {
          const wait = Math.ceil(Number(res.headers.get("Retry-After")) / 60) || 0;
          throw new Error(`Too many uploads from here. Try again in ${wait > 1 ? `${wait} minutes` : "a minute"}.`);
        }
        throw new Error("The image didn't upload. Try again.");
      }
      const preview = URL.createObjectURL(file);
      urls.current.set(preview, json.url);
      return preview;
    } finally {
      setUploading((n) => n - 1);
    }
  };

  /** `html` with every preview URL replaced by its stored URL. */
  const resolve = (html: string) => {
    let out = html;
    urls.current.forEach((url, preview) => (out = out.split(preview).join(url)));
    return out;
  };
  /** The stored URL behind a preview (screenshot fields send these). */
  const stored = (preview: string) => urls.current.get(preview) ?? null;
  /** Drops one upload the submitter removed (the stored file stays pending and expires unclaimed). */
  const forget = (preview: string) => {
    URL.revokeObjectURL(preview);
    urls.current.delete(preview);
  };
  const reset = () => {
    urls.current.forEach((_url, preview) => URL.revokeObjectURL(preview));
    urls.current.clear();
  };
  return { upload, uploading, resolve, stored, forget, reset };
}
