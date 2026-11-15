"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/bits";

const TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_BYTES = 2 * 1024 * 1024;

/** Upload, replace or remove the signed-in user's profile picture. The server re-checks type and size. */
export function PictureForm({ id, name, image }: { id: string; name: string; image: string | null }) {
  const [preview, setPreview] = useState<{ file: File; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const clearPreview = () => {
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview(null);
    if (input.current) input.current.value = "";
  };

  const send = (init: RequestInit, done: string) =>
    start(async () => {
      const res = await fetch("/api/account/avatar", init).catch(() => null);
      const body = (await res?.json().catch(() => null)) as { error?: string } | null;
      if (!res?.ok) {
        setError(body?.error ?? "Couldn't reach the server. Try again.");
        return;
      }
      setError(null);
      clearPreview();
      toast.success(done);
      router.refresh();
    });

  return (
    <div className="grid max-w-md gap-3">
      <div className="flex items-center gap-4">
        <UserAvatar id={id} name={name} image={preview?.url ?? image} size={64} />
        <div className="flex flex-wrap gap-2">
          {preview ? (
            <>
              <Button
                type="button"
                disabled={pending}
                onClick={() => {
                  const form = new FormData();
                  form.append("file", preview.file);
                  send({ method: "POST", body: form }, image ? "Picture replaced" : "Picture added");
                }}
              >
                {pending ? "Saving…" : "Save picture"}
              </Button>
              <Button type="button" variant="ghost" disabled={pending} onClick={() => (clearPreview(), setError(null))}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="outline" disabled={pending} onClick={() => input.current?.click()}>
                {image ? "Replace picture" : "Upload picture"}
              </Button>
              {image && (
                <Button type="button" variant="ghost" disabled={pending} onClick={() => send({ method: "DELETE" }, "Picture removed")}>
                  {pending ? "Removing…" : "Remove"}
                </Button>
              )}
            </>
          )}
        </div>
        <input
          ref={input}
          type="file"
          accept={TYPES.join(",")}
          className="hidden"
          aria-label="Profile picture file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            if (!TYPES.includes(file.type)) {
              setError("Use a PNG, JPEG, WebP or GIF image.");
              e.target.value = "";
              return;
            }
            if (file.size > MAX_BYTES) {
              setError("Pictures must be 2 MB or smaller.");
              e.target.value = "";
              return;
            }
            setError(null);
            if (preview) URL.revokeObjectURL(preview.url);
            setPreview({ file, url: URL.createObjectURL(file) });
          }}
        />
      </div>
      {error ? (
        <p role="alert" className="text-[12.5px] text-destructive">
          {error}
        </p>
      ) : (
        <p className="text-[12px] text-faint">{preview ? "Preview. Save to show it to everyone." : "PNG, JPEG, WebP or GIF, up to 2 MB. Without one, your initials are shown."}</p>
      )}
    </div>
  );
}
