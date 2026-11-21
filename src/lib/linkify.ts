// Links in comment text (AIM-7). Comments are plain text, so URLs used to render as dead text. This splits a
// text fragment into text and link parts; the caller builds React anchors from them (never HTML strings).
// Only http(s) URLs become links: bare `https://...` and Markdown `[text](https://...)`. Every other scheme
// (javascript:, data:, mailto:, ...) stays literal text. Pure, so `pnpm test` covers it.

export type LinkPart = { kind: "text"; text: string } | { kind: "link"; href: string; text: string };

/** URL characters: no whitespace, angle brackets (mention tokens `<@id>` stop a URL) or quotes. */
const URL_CHARS = "[^\\s<>\"'`]";

/** `[text](http-url)`: one-line text without brackets, url without spaces; balanced parens allowed once deep. */
const MD_LINK = /\[([^[\]\n]{1,300})\]\((https?:\/\/(?:[^\s()<>"'`]|\([^\s()<>"'`]*\))+)\)/gi;

/** A bare http(s) URL not glued to a preceding word character (so `xhttps://` and `a.https://` stay text). */
const BARE_URL = new RegExp(`(?<![\\w@/.:-])https?://${URL_CHARS}+`, "gi");

/** Trailing characters that read as sentence punctuation or Markdown emphasis, not part of the URL. */
const TRAILING = /[.,;:!?*_~]/;
const PAIRS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

const count = (s: string, ch: string) => s.split(ch).length - 1;

/** `url` without trailing punctuation and unbalanced closing brackets (`(see https://x.y/a_(b))` keeps `(b)`). */
export function trimUrl(url: string): string {
  let u = url;
  for (;;) {
    const last = u[u.length - 1];
    if (last && TRAILING.test(last)) {
      u = u.slice(0, -1);
      continue;
    }
    const open = last && PAIRS[last];
    if (open && count(u, last) > count(u, open)) {
      u = u.slice(0, -1);
      continue;
    }
    return u;
  }
}

/** True for an absolute http(s) URL with a host; the only kind ever linked. */
export function isHttpUrl(url: string): boolean {
  if (!/^https?:\/\/[^\s/?#]/i.test(url)) return false;
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname;
  } catch {
    return false;
  }
}

/** Odd number of backslashes right before `i`: the character there is escaped. */
function escapedAt(s: string, i: number): boolean {
  let n = 0;
  while (i - 1 - n >= 0 && s[i - 1 - n] === "\\") n++;
  return n % 2 === 1;
}

function pushText(out: LinkPart[], text: string) {
  if (!text) return;
  const prev = out[out.length - 1];
  if (prev?.kind === "text") prev.text += text;
  else out.push({ kind: "text", text });
}

/** Bare URLs in `text` become links; everything else stays text. */
function linkBare(text: string, out: LinkPart[]) {
  let at = 0;
  for (const m of text.matchAll(BARE_URL)) {
    const start = m.index!;
    const url = trimUrl(m[0]);
    if (!isHttpUrl(url)) continue;
    pushText(out, text.slice(at, start));
    out.push({ kind: "link", href: url, text: url });
    at = start + url.length;
  }
  pushText(out, text.slice(at));
}

/**
 * Splits plain comment text into text and link parts, in order. Markdown links (not images `![..](..)`, not
 * escaped `\[..](..)`) keep their label; bare http(s) URLs show themselves. Adjacent text parts are merged.
 */
export function linkify(text: string): LinkPart[] {
  const out: LinkPart[] = [];
  const s = text ?? "";
  let at = 0;
  for (const m of s.matchAll(MD_LINK)) {
    const start = m.index!;
    if (s[start - 1] === "!" || escapedAt(s, start) || !isHttpUrl(m[2])) continue;
    linkBare(s.slice(at, start), out);
    const label = m[1].trim();
    out.push({ kind: "link", href: m[2], text: label || m[2] });
    at = start + m[0].length;
  }
  linkBare(s.slice(at), out);
  return out;
}
