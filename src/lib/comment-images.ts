// Images in comments (VEC-335). Comments stay plain text plus <@id> mention tokens; a Markdown image token
// `![alt](url)` renders as a thumbnail only when the URL is one of this org's own uploads. Everything else
// (external URLs, other orgs' uploads, <img> tags, escaped `\![...]`, odd paths) stays literal text, the same
// rule as VEC-243: crafted markup must never turn into a real image or link. Pure, so `pnpm test` covers it.

export type CommentImage = { src: string; alt: string };
export type CommentPart = { kind: "text"; text: string } | { kind: "image"; src: string; alt: string; index: number };

/** An upload's file name as `saveImage` writes it: `<orgId>-<nanoid>.<ext>`. */
const NAME = "[A-Za-z0-9_-]{1,64}\\.(?:png|jpg|jpeg|gif|webp|avif)";

/** True when `url` is this org's upload: `/api/uploads/<orgId>-…` locally, or its Vercel Blob file in production. */
export function isOrgUploadUrl(url: string, orgId: string): boolean {
  if (!/^[a-f0-9]{24}$/.test(orgId)) return false;
  return (
    new RegExp(`^/api/uploads/${orgId}-${NAME}$`).test(url) ||
    new RegExp(`^https://[a-z0-9-]+\\.public\\.blob\\.vercel-storage\\.com/uploads/${orgId}-${NAME}$`).test(url)
  );
}

/** `![alt](url)`: alt on one line without brackets, url without spaces, parentheses or angle brackets. */
const IMAGE = /!\[([^[\]\n]{0,300})\]\(([^\s()<>]+)\)/g;

/** Odd number of backslashes right before `i`: the `!` there is escaped. */
function escapedAt(s: string, i: number): boolean {
  let n = 0;
  while (i - 1 - n >= 0 && s[i - 1 - n] === "\\") n++;
  return n % 2 === 1;
}

/**
 * Splits a comment body into text and image parts, in order. Text parts still hold mention tokens (the caller
 * renders those). One line break right around an image is dropped, since the thumbnail is its own block.
 */
export function splitCommentBody(body: string, orgId: string): CommentPart[] {
  const out: CommentPart[] = [];
  let at = 0;
  let index = 0;
  let pending = "";
  for (const m of (body ?? "").matchAll(IMAGE)) {
    const start = m.index!;
    if (escapedAt(body, start) || !isOrgUploadUrl(m[2], orgId)) continue;
    pending += body.slice(at, start);
    const text = pending.replace(/\n$/, "");
    if (text) out.push({ kind: "text", text });
    pending = "";
    out.push({ kind: "image", src: m[2], alt: m[1].trim(), index: index++ });
    at = start + m[0].length;
    if (body[at] === "\n") at++;
  }
  pending += (body ?? "").slice(at);
  if (pending) out.push({ kind: "text", text: pending });
  return out;
}

/** The images a comment renders, in order. */
export function commentImages(body: string, orgId: string): CommentImage[] {
  return splitCommentBody(body, orgId).flatMap((p) => (p.kind === "image" ? [{ src: p.src, alt: p.alt }] : []));
}

/** The Markdown token the composer inserts for an upload; the alt is the file name made safe for the token. */
export function imageToken(name: string, url: string): string {
  const alt = (name || "image").replace(/[[\]()\\\n\r<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 120) || "image";
  return `![${alt}](${url})`;
}

/**
 * Text with `token` put at `from..to` on a line of its own, and where the caret goes after it.
 * Adds a line break before it (unless at the start or after one) and after it (unless one follows).
 */
export function insertBlock(text: string, from: number, to: number, token: string): { text: string; caret: number } {
  const before = text.slice(0, from);
  const after = text.slice(to);
  const lead = before && !before.endsWith("\n") ? "\n" : "";
  const trail = after.startsWith("\n") ? "" : "\n";
  const head = before + lead + token + trail;
  return { text: head + after, caret: head.length };
}

/**
 * The description html the thread gallery collects from (VEC-370): the pane's latest local edit when there is
 * one (saved or still debouncing), else the task's stored description. Our own saves aren't echoed back to the
 * pane, so reading only the stored value missed images just added there.
 */
export function galleryDescription(stored: string, edited: string | null | undefined): string {
  return edited ?? stored;
}

/**
 * One gallery over the whole thread (VEC-335): the description's images, then each comment's images, oldest
 * comment first. `offsets` maps a comment id to the gallery index of its first image.
 */
export function threadGallery(
  description: CommentImage[],
  comments: { id: string; body: string }[],
  orgId: string,
): { images: CommentImage[]; offsets: Map<string, number> } {
  const images = [...description];
  const offsets = new Map<string, number>();
  for (const c of comments) {
    const own = commentImages(c.body, orgId);
    if (!own.length) continue;
    offsets.set(c.id, images.length);
    images.push(...own);
  }
  return { images, offsets };
}
