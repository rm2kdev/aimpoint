"use client";

import { useCallback, useState } from "react";
import { useOrg } from "@/components/org-provider";
import { ImageLightbox, collectImages, type LightboxImage } from "@/components/image-lightbox";
import { threadGallery } from "@/lib/comment-images";
import type { FeedItem } from "@/lib/types";

/** Which image was opened: the n-th of the description (with the editor's live list), or the n-th of a comment. */
export type GalleryTarget = { from: "description"; index: number; images?: LightboxImage[] } | { from: "comment"; id: string; index: number };
export type OpenGallery = (target: GalleryTarget, opener: HTMLElement | null) => void;

/**
 * One lightbox over the whole task thread (VEC-335): description images first, then comment images oldest to
 * newest, so prev/next walks across both. The task pane owns it and hands `open` to the description editor and
 * the comment feed; `lightbox` is the element to render. The list is taken when it opens.
 */
export function useThreadGallery(description: string, feed: FeedItem[]): { open: OpenGallery; lightbox: React.ReactNode } {
  const { org } = useOrg();
  const [state, setState] = useState<{ images: LightboxImage[]; index: number; open: boolean; opener: HTMLElement | null }>({
    images: [],
    index: 0,
    open: false,
    opener: null,
  });
  const open = useCallback<OpenGallery>(
    (target, opener) => {
      const desc = target.from === "description" && target.images ? target.images : collectImages(description);
      const comments = feed.filter((f) => f.kind === "comment").map((f) => ({ id: f.id, body: f.body ?? "" }));
      const { images, offsets } = threadGallery(desc, comments, org.id);
      const index = target.from === "description" ? target.index : (offsets.get(target.id) ?? -1) + target.index;
      if (index < 0 || index >= images.length) return;
      setState({ images, index, open: true, opener });
    },
    [description, feed, org.id],
  );
  const lightbox = (
    <ImageLightbox
      images={state.images}
      index={state.index}
      open={state.open}
      returnFocus={state.opener}
      onOpenChange={(o) => setState((s) => ({ ...s, open: o }))}
    />
  );
  return { open, lightbox };
}
