import { Fragment } from "react";
import { linkify } from "@/lib/linkify";

/** Link styling shared by comment links, matching description links (`.prose-aimpoint a`). */
export const TEXT_LINK_CLASS = "text-brand underline decoration-1 underline-offset-[3px] hover:opacity-80";

/**
 * Plain text with its http(s) URLs and Markdown `[text](url)` links as real anchors (AIM-7). Built from React
 * elements only, so the text can never inject markup; other schemes stay text (see lib/linkify.ts).
 */
export function LinkedText({ text }: { text: string }) {
  return (
    <>
      {linkify(text).map((p, i) =>
        p.kind === "text" ? (
          <Fragment key={i}>{p.text}</Fragment>
        ) : (
          <a key={i} href={p.href} target="_blank" rel="noopener noreferrer nofollow ugc" title={p.href} className={TEXT_LINK_CLASS}>
            {p.text}
          </a>
        ),
      )}
    </>
  );
}
