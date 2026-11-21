/**
 * Pure rules for external-form rich text and public image uploads (VEC-233), kept free of server-only imports so
 * `form-upload-core.test.mjs` runs them under plain `node --test`. Server code: `lib/form-uploads.ts` (store,
 * rate limit, cleanup), `lib/project-forms.ts` (form options), `app/api/forms/[publicId]/uploads/route.ts`.
 */

/** Largest image a public form takes. Smaller than the 10 MB members get (storage.ts MAX_IMAGE_BYTES). */
export const FORM_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** Largest request body read for one upload: the image plus room for the multipart headers. Anything bigger is refused unread. */
export const FORM_UPLOAD_BODY_MAX = FORM_IMAGE_MAX_BYTES + 16 * 1024;

/** Uploads allowed per client IP per form, and per form from everyone, in each window. Separate keys from submissions. */
export const UPLOAD_RATE_LIMITS = {
  ipForm: { max: 20, windowMs: 10 * 60_000 },
  form: { max: 200, windowMs: 60 * 60_000 },
} as const;

/** Uploads allowed per signed-in account per public project, and per public project from everyone (VEC-356). */
export const PUBLIC_UPLOAD_RATE_LIMITS = {
  userProject: { max: 20, windowMs: 10 * 60_000 },
  project: { max: 200, windowMs: 60 * 60_000 },
} as const;

/** An upload no submission claimed within this long is deleted, file and all. */
export const FORM_UPLOAD_PENDING_MS = 24 * 60 * 60_000;
/** Backstop TTL on unclaimed records, in case the cleanup sweep never ran (claiming unsets it). */
export const FORM_UPLOAD_TTL_MS = 7 * 24 * 60 * 60_000;

/** Image types a public form accepts, by sniffed type. Never SVG (scriptable) or anything sniffing can't confirm. */
export const FORM_IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
};

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
const AVIF_BRANDS = new Set(["avif", "avis"]);

/** The real type from a file's first bytes; the browser-supplied MIME type alone can't be trusted. Null when unknown. */
export function sniffImageType(b: Uint8Array): string | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length >= 8 && png.every((v, i) => b[i] === v)) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && /^GIF8[79]a$/.test(ascii(b, 0, 6))) return "image/gif";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "image/webp";
  // ISO-BMFF: [size][ftyp][major brand][minor version][compatible brands...]; AVIF names avif/avis among the brands.
  if (b.length >= 16 && ascii(b, 4, 8) === "ftyp") {
    const size = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
    const end = Math.min(b.length, size >= 16 ? size : 16);
    if (AVIF_BRANDS.has(ascii(b, 8, 12))) return "image/avif";
    for (let i = 16; i + 4 <= end; i += 4) if (AVIF_BRANDS.has(ascii(b, i, i + 4))) return "image/avif";
  }
  return null;
}

export type FileCheck = { ok: true; type: string; ext: string } | { ok: false; status: 400 | 413; error: string };

/** Size and content checks for one public upload. The declared MIME type is ignored: only the bytes decide. */
export function checkFormImage(data: Uint8Array): FileCheck {
  if (data.byteLength === 0) return { ok: false, status: 400, error: "That file is empty." };
  if (data.byteLength > FORM_IMAGE_MAX_BYTES) return { ok: false, status: 413, error: `Images must be ${FORM_IMAGE_MAX_BYTES / 1024 / 1024} MB or smaller.` };
  const type = sniffImageType(data);
  const ext = type ? FORM_IMAGE_TYPES[type] : undefined;
  if (!type || !ext) return { ok: false, status: 400, error: "That file isn't a PNG, JPEG, GIF, WebP or AVIF image." };
  return { ok: true, type, ext };
}

/**
 * Reads a request body up to `max` bytes. Null when the declared length or the bytes actually sent go over, without
 * reading the rest (content-length can be missing or wrong on chunked uploads).
 */
export async function readCapped(body: ReadableStream<Uint8Array> | null, declared: string | null, max: number): Promise<Uint8Array | null> {
  const n = Number(declared ?? "");
  if (declared && Number.isFinite(n) && n > max) return null;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export interface RateLimit {
  max: number;
  windowMs: number;
}

/** The fixed window `now` falls in: its start (part of the counter key) and when it ends. */
export function rateWindow(now: number, limit: RateLimit): { start: number; end: number } {
  const start = Math.floor(now / limit.windowMs) * limit.windowMs;
  return { start, end: start + limit.windowMs };
}

/** Seconds to wait (Retry-After, at least 1) once `count` is over the limit; null while within it. */
export function retryAfter(count: number, now: number, limit: RateLimit): number | null {
  if (count <= limit.max) return null;
  return Math.max(1, Math.ceil((rateWindow(now, limit).end - now) / 1000));
}

export interface FormOptions {
  richText: boolean;
  allowImages: boolean;
}

/**
 * Validates the per-form editor options against the saved ones. Images need rich text: switching rich text off also
 * switches images off, and turning images on for a plain-text form is refused. Returns an error message when bad.
 */
export function resolveFormOptions(patch: { richText?: unknown; allowImages?: unknown }, kept: Partial<FormOptions> = {}): FormOptions | string {
  if (patch.richText !== undefined && typeof patch.richText !== "boolean") return "`richText` is true or false.";
  if (patch.allowImages !== undefined && typeof patch.allowImages !== "boolean") return "`allowImages` is true or false.";
  const richText = (patch.richText as boolean | undefined) ?? kept.richText ?? false;
  if (patch.allowImages === true && !richText) return "Images need rich text. Turn on rich text to let submitters add images.";
  const allowImages = richText && ((patch.allowImages as boolean | undefined) ?? kept.allowImages ?? false);
  return { richText, allowImages };
}

/** A stored form image name (`<orgId>-<16 random>.<ext>`, the shape /api/uploads/[name] serves) from its URL, or null. */
export function formImageName(url: string): string | null {
  const name = url.split(/[?#]/)[0].split("/").pop() ?? "";
  return /^[a-f0-9]{24}-[A-Za-z0-9_-]{16}\.(png|jpg|gif|webp|avif)$/.test(name) ? name : null;
}
