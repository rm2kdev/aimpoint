import sanitizeHtml from "sanitize-html";

/**
 * Task intake core (VEC-356): the input rules every task-creation surface shares (in-app New task dialog, public
 * project submit, project forms). See docs/task-creation.md for the capability matrix and the differences kept on
 * purpose. Pure (no server-only imports, nothing from other app modules at runtime) so `task-intake-core.test.mjs`
 * runs it under plain `node --test`, and client components can import the limits and messages.
 *
 * Every helper returns `{ok: true, ...} | {ok: false, error}`; server callers wrap the error in a UserError. The
 * stored description always passes `sanitizeDescription` (lib/data.ts) inside createTaskAs as well, so the public
 * allow-list below is a stricter layer on top of it, never instead of it.
 */

/* ---------------- limits ---------------- */

/** Longest task title, on every surface (and for edits). */
export const TASK_TITLE_MAX = 300;
/** Longest description a public surface (public project, form) takes, in visible text characters. */
export const TASK_DESCRIPTION_MAX = 10_000;
/** Largest raw rich-text HTML taken from a public surface (the text inside is still capped at TASK_DESCRIPTION_MAX). */
export const DESCRIPTION_HTML_MAX = 96 * 1024;
/** Most images one public submission's description may contain. */
export const DESCRIPTION_IMAGES_MAX = 10;
/** Longest submitter name (form field, or a public project account's display name). */
export const SUBMITTER_NAME_MAX = 100;
/** Longest submitter email (form field). */
export const SUBMITTER_EMAIL_MAX = 200;

export const INTAKE_LIMITS = {
  title: TASK_TITLE_MAX,
  description: TASK_DESCRIPTION_MAX,
  descriptionHtml: DESCRIPTION_HTML_MAX,
  images: DESCRIPTION_IMAGES_MAX,
  name: SUBMITTER_NAME_MAX,
  email: SUBMITTER_EMAIL_MAX,
} as const;

/* ---------------- messages ---------------- */

const n = (v: number) => v.toLocaleString("en-US");

/** The one text for each input failure, on the server and in the clients. */
export const INTAKE_ERRORS = {
  titleMissing: "Give it a title.",
  titleTooLong: (length: number) => `Keep the title under ${TASK_TITLE_MAX} characters (it's ${n(length)}).`,
  descriptionNotText: "The description wasn't text. Reload the page and try again.",
  descriptionTooLong: (length: number) => `Keep the description under ${n(TASK_DESCRIPTION_MAX)} characters (it's ${n(length)}).`,
  descriptionTooMuchFormatting: `That description has too much formatting to send (over ${DESCRIPTION_HTML_MAX / 1024} KB). Shorten it and try again.`,
  tooManyImages: (count: number) => `Add at most ${DESCRIPTION_IMAGES_MAX} images (there are ${count}).`,
  typeNotAllowed: "Pick one of the listed types.",
  statusNotAllowed: "Pick one of the listed statuses.",
  notTakingTickets: "This project isn't taking new tickets.",
  nameTooLong: `Keep your name under ${SUBMITTER_NAME_MAX} characters.`,
  emailTooLong: `Keep your email under ${SUBMITTER_EMAIL_MAX} characters.`,
  emailInvalid: "That email address doesn't look right.",
} as const;

export type Intake<T> = ({ ok: true } & T) | { ok: false; error: string };

/* ---------------- title ---------------- */

/** Trims the title and checks it's there and at most TASK_TITLE_MAX characters. Non-strings count as empty. */
export function normalizeTitle(raw: unknown): Intake<{ title: string }> {
  const title = typeof raw === "string" ? raw.trim() : "";
  if (!title) return { ok: false, error: INTAKE_ERRORS.titleMissing };
  if (title.length > TASK_TITLE_MAX) return { ok: false, error: INTAKE_ERRORS.titleTooLong(title.length) };
  return { ok: true, title };
}

/* ---------------- type / status ---------------- */

const empty = (v: unknown) => v === undefined || v === null || v === "";

/**
 * The task type: `fallback` when nothing was picked, the input when it's one of `allowed`, else a refusal (never a
 * silent rewrite to another type).
 */
export function resolveType<T extends string>(input: unknown, allowed: readonly T[], fallback: T): Intake<{ type: T }> {
  if (empty(input)) return { ok: true, type: fallback };
  if (typeof input !== "string" || !(allowed as readonly string[]).includes(input)) return { ok: false, error: INTAKE_ERRORS.typeNotAllowed };
  return { ok: true, type: input as T };
}

/**
 * The status id among `allowed` (ordered; the first is the default when nothing was picked). An empty list means the
 * destination takes nothing.
 */
export function resolveStatus(input: unknown, allowed: readonly string[]): Intake<{ id: string }> {
  if (!allowed.length) return { ok: false, error: INTAKE_ERRORS.notTakingTickets };
  if (empty(input)) return { ok: true, id: allowed[0] };
  if (typeof input !== "string" || !allowed.includes(input)) return { ok: false, error: INTAKE_ERRORS.statusNotAllowed };
  return { ok: true, id: input };
}

/* ---------------- submitter (forms) ---------------- */

/** A form submitter's optional name and email: trimmed, email lowercased, null when blank. */
export function normalizeSubmitter(name: unknown, email: unknown): Intake<{ name: string | null; email: string | null }> {
  const nm = typeof name === "string" ? name.trim() : "";
  if (nm.length > SUBMITTER_NAME_MAX) return { ok: false, error: INTAKE_ERRORS.nameTooLong };
  const em = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (em.length > SUBMITTER_EMAIL_MAX) return { ok: false, error: INTAKE_ERRORS.emailTooLong };
  if (em && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return { ok: false, error: INTAKE_ERRORS.emailInvalid };
  return { ok: true, name: nm || null, email: em || null };
}

/* ---------------- public rich-text allow-list (moved from form-rich-core.ts, VEC-234) ---------------- */

/**
 * A subset of sanitizeDescription's allow-list. Left out for the public: every attribute other than link href and
 * image src/alt (no class on code/pre, no image width/height), protocol-relative URLs, and images entirely unless
 * the surface allows them and the source passes `imageAllowed` (its own pending uploads).
 */
const PUBLIC_TAGS = ["p", "br", "strong", "em", "s", "u", "code", "pre", "blockquote", "ul", "ol", "li", "h1", "h2", "h3", "a", "hr"];
export const PUBLIC_LINK_REL = "noopener noreferrer nofollow";

export interface PublicSanitizeOptions {
  allowImages: boolean;
  /** Which image sources survive. Called only when images are allowed; anything it rejects is dropped with its tag. */
  imageAllowed?: (src: string) => boolean;
}

/**
 * Markdown image syntax typed into a public surface (`![x](https://...)`, `![image]()`) is removed (VEC-243): a public
 * submitter can't attach images by text. Agents also see description text escaped (lib/markdown-core.ts), so this is
 * the public-side layer on top of that. Works on plain text and on sanitised HTML text runs alike.
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
      // No src left (a javascript:/data: one was removed by the scheme check) or one that isn't an allowed upload.
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

/** The visible text of already-sanitised HTML, entities decoded. What TASK_DESCRIPTION_MAX is measured on. */
export function htmlText(cleanHtml: string): string {
  const text = sanitizeHtml(cleanHtml.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|li|h[1-3]|blockquote|pre)>/gi, "$&\n"), { allowedTags: [], allowedAttributes: {} });
  return text
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const v = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(v) && v >= 0 && v <= 0x10ffff ? String.fromCodePoint(v) : m;
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
 * Size checks for a rich description before anything touches the database: raw HTML at most DESCRIPTION_HTML_MAX,
 * text at most `textMax` characters, at most DESCRIPTION_IMAGES_MAX images. Returns the first-pass cleaned HTML (any
 * image source still allowed) and the image sources to look up as the surface's pending uploads.
 */
export function prepareRichDescription(raw: string, allowImages: boolean, textMax: number = TASK_DESCRIPTION_MAX): RichPrep {
  if (raw.length > DESCRIPTION_HTML_MAX) return { ok: false, error: INTAKE_ERRORS.descriptionTooMuchFormatting };
  const html = publicSanitize(raw, { allowImages });
  const textLength = htmlText(html).length;
  if (textLength > textMax) return { ok: false, error: `Keep the description under ${n(textMax)} characters (it's ${n(textLength)}).` };
  const sources = allowImages ? imageSources(html) : [];
  if (sources.length > DESCRIPTION_IMAGES_MAX) return { ok: false, error: INTAKE_ERRORS.tooManyImages(sources.length) };
  return { ok: true, html, sources, textLength };
}

/* ---------------- description ---------------- */

export interface DescriptionOptions {
  /** The input is rich-editor HTML; otherwise plain text. */
  rich: boolean;
  /** Images may stay in a rich description (only ones `imageAllowed` accepts, when given). */
  allowImages?: boolean;
  /**
   * Which image sources survive (the surface's own pending uploads). Leave it out for the first, database-free pass:
   * the result then lists `sources` to look up, and `keepImages(html, imageAllowed)` finishes the job.
   */
  imageAllowed?: (src: string) => boolean;
}

export type PreparedDescription =
  | { ok: true; rich: true; html: string; sources: string[]; textLength: number }
  | { ok: true; rich: false; text: string; textLength: number }
  | { ok: false; error: string };

/**
 * A public surface's description: blank/missing is an empty one, anything but a string is refused, line endings are
 * normalised, and the size limits apply (TASK_DESCRIPTION_MAX text, plus DESCRIPTION_HTML_MAX / DESCRIPTION_IMAGES_MAX
 * for rich input). Rich input goes through the public allow-list; with `imageAllowed`, only those image sources stay.
 * Plain text comes back as text (the caller turns it into paragraphs).
 */
export function prepareDescription(raw: unknown, opts: DescriptionOptions): PreparedDescription {
  if (raw === undefined || raw === null) raw = "";
  if (typeof raw !== "string") return { ok: false, error: INTAKE_ERRORS.descriptionNotText };
  const d = raw.replace(/\r\n?/g, "\n");
  if (!opts.rich) {
    if (d.length > TASK_DESCRIPTION_MAX) return { ok: false, error: INTAKE_ERRORS.descriptionTooLong(d.length) };
    return { ok: true, rich: false, text: d, textLength: d.length };
  }
  const allowImages = !!opts.allowImages;
  const prep = prepareRichDescription(d, allowImages);
  if (!prep.ok) return prep;
  if (!opts.imageAllowed) return { ok: true, rich: true, html: prep.html, sources: prep.sources, textLength: prep.textLength };
  const html = allowImages ? keepImages(prep.html, opts.imageAllowed) : prep.html;
  return { ok: true, rich: true, html, sources: imageSources(html), textLength: prep.textLength };
}

/** Second pass over a prepared rich description: only the images `imageAllowed` accepts stay (the rest drop with their tag). */
export function keepImages(html: string, imageAllowed: (src: string) => boolean): string {
  return publicSanitize(html, { allowImages: true, imageAllowed });
}
