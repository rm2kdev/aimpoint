import sanitizeHtml from "sanitize-html";

/**
 * Rich-text descriptions on public forms (VEC-234). Pure (no server-only imports) so `form-rich-core.test.mjs` runs
 * it under plain `node --test`. The submit path is `lib/form-submit.ts`: `prepareRichDescription` on the raw HTML
 * (shape and size checks, no database), then `publicSanitize` again with only this form's pending uploads
 * (`pendingFormUploads`) allowed as image sources. The stored task description then also goes through the normal
 * `sanitizeDescription` (lib/data.ts) in createTaskAs, so this is a stricter layer on top of it, never instead of it.
 */

/** Largest raw HTML description taken from a public form (the text inside is still capped at FORM_DESCRIPTION_MAX). */
export const FORM_HTML_MAX = 96 * 1024;
/** Most images one submission may contain. */
export const FORM_IMAGES_MAX = 10;

/**
 * A subset of sanitizeDescription's allow-list. Left out for the public: every attribute other than link href and
 * image src/alt (no class on code/pre, no image width/height), protocol-relative URLs, and images entirely unless
 * the form allows them and the source is one of the form's own uploads.
 */
const PUBLIC_TAGS = ["p", "br", "strong", "em", "s", "u", "code", "pre", "blockquote", "ul", "ol", "li", "h1", "h2", "h3", "a", "hr"];
export const PUBLIC_LINK_REL = "noopener noreferrer nofollow";

export interface PublicSanitizeOptions {
  allowImages: boolean;
  /** Which image sources survive. Called only when images are allowed; anything it rejects is dropped with its tag. */
  imageAllowed?: (src: string) => boolean;
}

/**
 * Markdown image syntax typed into a public form (`![x](https://...)`, `![image]()`) is removed (VEC-243): a public
 * submitter can't attach images by text. Agents also see description text escaped (lib/markdown-core.ts), so this is
 * the form-side layer on top of that. Works on plain text and on sanitised HTML text runs alike.
 */
export function stripMarkdownImages(text: string): string {
  return text.replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, "");
}

export function publicSanitize(html: string, opts: PublicSanitizeOptions): string {
  const allowImages = opts.allowImages;
  const imageAllowed = opts.imageAllowed ?? (() => true);
  const clean = sanitizeHtml(html, {
    allowedTags: allowImages ? [...PUBLIC_TAGS, "img"] : PUBLIC_TAGS,
    allowedAttributes: { a: ["href", "target", "rel"], img: ["src", "alt"] },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["http", "https"] },
    allowProtocolRelative: false,
    // Script/style/textarea bodies are dropped with their tag, never kept as text.
    nonTextTags: ["script", "style", "textarea", "option", "noscript", "iframe", "object", "embed", "svg", "math", "template"],
    transformTags: { a: sanitizeHtml.simpleTransform("a", { target: "_blank", rel: PUBLIC_LINK_REL }) },
    exclusiveFilter: (frame) => {
      if (frame.tag !== "img") return false;
      const src = frame.attribs.src;
      // No src left (a javascript:/data: one was removed by the scheme check) or one that isn't the form's own upload.
      return !src || !imageAllowed(src);
    },
  });
  // Per text run of the output, not sanitize-html's textFilter: the parser splits text at entities (`&amp;`), so a
  // filter would see `![x](https://a?b=1` and `&amp;c=2)` separately and miss the image.
  // Code is left as typed: it reads as code to agents too, never as an image.
  let code = 0;
  return clean.replace(/<[^>]*>|[^<]+/g, (part) => {
    if (part[0] !== "<") return code ? part : stripMarkdownImages(part);
    const m = /^<(\/?)(pre|code)\b/i.exec(part);
    if (m) code = Math.max(0, code + (m[1] ? -1 : 1));
    return part;
  });
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** The visible text of already-sanitised HTML, entities decoded. What FORM_DESCRIPTION_MAX is measured on. */
export function htmlText(cleanHtml: string): string {
  const text = sanitizeHtml(cleanHtml.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|li|h[1-3]|blockquote|pre)>/gi, "$&\n"), { allowedTags: [], allowedAttributes: {} });
  return text
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .trim();
}

/** The `src` of every image in already-sanitised HTML (sanitize-html always writes attributes double-quoted). */
export function imageSources(cleanHtml: string): string[] {
  const out: string[] = [];
  for (const m of cleanHtml.matchAll(/<img\b[^>]*?\ssrc="([^"]*)"/gi)) out.push(m[1].replace(/&amp;/g, "&"));
  return out;
}

export type RichPrep = { ok: true; html: string; sources: string[]; textLength: number } | { ok: false; error: string };

/**
 * Size checks for a rich description before anything touches the database: raw HTML at most FORM_HTML_MAX, text at
 * most `textMax` characters, at most FORM_IMAGES_MAX images. Returns the first-pass cleaned HTML (any image source
 * still allowed) and the image sources to look up as this form's pending uploads.
 */
export function prepareRichDescription(raw: string, allowImages: boolean, textMax: number): RichPrep {
  if (raw.length > FORM_HTML_MAX) return { ok: false, error: `That description has too much formatting to send (over ${FORM_HTML_MAX / 1024} KB). Shorten it and try again.` };
  const html = publicSanitize(raw, { allowImages });
  const textLength = htmlText(html).length;
  if (textLength > textMax) return { ok: false, error: `Keep the description under ${textMax.toLocaleString()} characters (it's ${textLength.toLocaleString()}).` };
  const sources = allowImages ? imageSources(html) : [];
  if (sources.length > FORM_IMAGES_MAX) return { ok: false, error: `Add at most ${FORM_IMAGES_MAX} images (there are ${sources.length}).` };
  return { ok: true, html, sources, textLength };
}
