import "server-only";
import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { getDb } from "./db";
import { findOpenForm, type OpenForm } from "./project-forms";
import { createTaskFromForm } from "./task-service";
import { UserError } from "./result";
import { hasFeature } from "./billing-limits";
import { rateWindow, retryAfter } from "./form-upload-core";
import { INTAKE_ERRORS, SUBMITTER_EMAIL_MAX, SUBMITTER_NAME_MAX, TASK_TITLE_MAX, imageSources, keepImages, normalizeTitle, prepareDescription, resolveType } from "./task-intake-core";
import { claimFormUploads, pendingFormUploads } from "./form-uploads";
import { composeFormDescription, plainTextToHtml, readFieldValues, screenshotUrls, type FormFieldValues } from "./form-fields-core";

/**
 * The public side of external forms (VEC-207): what `POST /api/forms/<publicId>` does with a submission.
 * Unauthenticated, so it checks everything itself (form open, honeypot, sizes, rate limits) before handing a
 * clean submission to createTaskFromForm, and only ever answers with a short message: never a task key, ids or
 * anything about the org.
 */

/**
 * Largest request body taken, in bytes. A full description (10,000 chars) of multi-byte text fits, and so does a rich
 * one up to FORM_HTML_MAX of HTML (VEC-234, lib/form-rich-core.ts) plus the other fields, custom fields included
 * (TPA-399, FORM_FIELDS_TEXT_MAX); anything bigger is refused unread.
 */
export const FORM_BODY_MAX = 160 * 1024;
/** The shared title limit (VEC-356, lib/task-intake-core.ts); old name kept for imports until VEC-358. */
export const FORM_TITLE_MAX = TASK_TITLE_MAX;
/** Name of the hidden field people never see or fill in. Anything in it marks the submission as a bot's. */
export const HONEYPOT_FIELD = "website";

/** Submissions allowed per client IP per form, and per form from everyone, in each window. */
export const RATE_LIMITS = {
  ipForm: { max: 5, windowMs: 10 * 60_000 },
  form: { max: 60, windowMs: 60 * 60_000 },
} as const;

/** What a public form says while its org is unpaid (locked, VEC-224/262). Nothing about plans or the org leaks to the public. */
export const FORM_UNAVAILABLE = "This form is unavailable right now. Please try again later or contact the team that shared it.";

export type SubmitResult =
  | { ok: true; status: 200 }
  | { ok: false; status: 400 | 403 | 404 | 413 | 429; error: string; retryAfter?: number };

export interface RawSubmission {
  title?: unknown;
  description?: unknown;
  /** `"html"`: `description` is the rich editor's HTML (VEC-234). Only honoured when the form has rich text on; otherwise plain text. */
  descriptionFormat?: unknown;
  type?: unknown;
  name?: unknown;
  email?: unknown;
  /** TPA-399: custom field values by field id (text, or upload URL(s) for a screenshot). Plain posts send `field_<id>` keys. */
  fields?: unknown;
  [HONEYPOT_FIELD]?: unknown;
  [key: `field_${string}`]: unknown;
}

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : null);

interface ValidSubmission {
  title: string;
  description: string;
  /** A rich description after the first sanitising pass (any image source still in), and the image sources to check. */
  rich: { html: string; sources: string[] } | null;
  type: string | null;
  name: string;
  email: string;
  /** TPA-399: custom field values (empty ones left out). */
  values: FormFieldValues;
}

/**
 * Shape and size checks that need no database, so bad input never uses up the submitter's rate limit. Title,
 * description, submitter and type rules are the shared intake core (VEC-356, lib/task-intake-core.ts).
 */
function validate(raw: RawSubmission, form: Pick<OpenForm, "richText" | "allowImages" | "fields" | "hideDescription" | "typeMode" | "allowedTypes" | "type">): ValidSubmission | string {
  // A form without the description box (TPA-399) takes none, whatever is posted.
  const description = form.hideDescription ? "" : str(raw.description);
  const type = str(raw.type);
  const name = str(raw.name);
  const email = str(raw.email);
  if (str(raw.title) === null || description === null || type === null || name === null || email === null) return "Something in the form wasn't text. Reload the page and try again.";
  const title = normalizeTitle(raw.title);
  if (!title.ok) return title.error;
  // Rich text only when the form has it on AND the client says it sent HTML: a no-JS post on a rich form stays plain text.
  const prep = prepareDescription(description, { rich: form.richText && raw.descriptionFormat === "html", allowImages: form.allowImages });
  if (!prep.ok) return prep.error;
  const rich: ValidSubmission["rich"] = prep.rich ? { html: prep.html, sources: prep.sources } : null;
  const d = prep.rich ? description.replace(/\r\n?/g, "\n") : prep.text;
  // Length only here (format is checked once the submission is filed, as before).
  if (name.trim().length > SUBMITTER_NAME_MAX) return INTAKE_ERRORS.nameTooLong;
  if (email.trim().length > SUBMITTER_EMAIL_MAX) return INTAKE_ERRORS.emailTooLong;
  // A choose form's type is checked up front too, so a bad pick never spends rate limit. A fixed form ignores it.
  let picked: string | null = null;
  if (form.typeMode === "choose") {
    const t = resolveType(type, form.allowedTypes, form.type);
    if (!t.ok) return t.error;
    picked = type ? t.type : null;
  }
  const fields = readFieldValues(form.fields, raw as Record<string, unknown>);
  if ("error" in fields) return fields.error;
  return { title: title.title, description: d, rich, type: picked, name: name.trim(), email: email.trim(), values: fields.values };
}

/* ---------------- rate limiting ---------------- */

interface RateDoc {
  _id: string;
  count: number;
  expiresAt: Date;
}

const g = globalThis as unknown as { __formRateIndex?: Promise<unknown> };

async function rateCol() {
  const db = await getDb();
  const col = db.collection<RateDoc>("formRateLimits");
  // Windows clean themselves up (TTL). Created once per process; harmless if it already exists.
  g.__formRateIndex ??= col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => (g.__formRateIndex = undefined));
  await g.__formRateIndex;
  return col;
}

/** Raw IPs are never stored: only a keyed hash, enough to count per client. */
export function ipKey(ip: string) {
  return createHash("sha256").update(`aimpoint:form-ip:${process.env.AUTH_SECRET ?? ""}:${ip}`).digest("base64url").slice(0, 22);
}

/** Count one submission (or public upload, VEC-233) against a fixed window; returns seconds to wait when it's over the limit. */
export async function hit(key: string, limit: { max: number; windowMs: number }): Promise<number | null> {
  const col = await rateCol();
  const now = Date.now();
  const w = rateWindow(now, limit);
  const _id = `${key}:${w.start}`;
  const doc = await col.findOneAndUpdate({ _id }, { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(w.end) } }, { upsert: true, returnDocument: "after" });
  return doc ? retryAfter(doc.count, now, limit) : null;
}

export function waitText(seconds: number) {
  const m = Math.ceil(seconds / 60);
  return m <= 1 ? "a minute" : `${m} minutes`;
}

/* ---------------- submit ---------------- */

export async function submitPublicForm(publicId: string, raw: RawSubmission, ip: string): Promise<SubmitResult> {
  const form = await findOpenForm(publicId);
  if (!form) return { ok: false, status: 404, error: "This form doesn't exist or isn't taking submissions." };
  // The org is unpaid (locked, VEC-224/262): the form is kept but unavailable until it subscribes.
  if (!(await hasFeature(form.orgId, "publicForms"))) return { ok: false, status: 403, error: FORM_UNAVAILABLE };
  const input = validate(raw, form);
  if (typeof input === "string") return { ok: false, status: 400, error: input };
  const formKey = form._id.toHexString();
  const wait = (await hit(`ip:${ipKey(ip)}:${formKey}`, RATE_LIMITS.ipForm)) ?? (await hit(`form:${formKey}`, RATE_LIMITS.form));
  if (wait !== null) {
    return { ok: false, status: 429, retryAfter: wait, error: `Too many submissions from here. Try again in ${waitText(wait)}.` };
  }
  // Bots fill every field. Look like a success so they move on, but file nothing (after the rate limit, so it still counts).
  const honey = raw[HONEYPOT_FIELD];
  if (typeof honey === "string" ? honey.trim() !== "" : honey != null) return { ok: true, status: 200 };
  // Images survive only when they're this form's own pending uploads (VEC-233); every other source is dropped.
  // Screenshot fields (TPA-399) use the same pending uploads, whether or not the description takes images.
  let descriptionHtml: string | null = null;
  const shots = screenshotUrls(form.fields, input.values);
  const sources = [...(input.rich && form.allowImages ? input.rich.sources : []), ...shots];
  const pending = sources.length ? await pendingFormUploads(form._id, sources) : [];
  const byUrl = new Map(pending.map((u) => [u.url, u._id]));
  const used: string[] = [];
  if (input.rich) {
    descriptionHtml = form.allowImages ? keepImages(input.rich.html, (src) => byUrl.has(src)) : input.rich.html;
    used.push(...imageSources(descriptionHtml));
  }
  const missingShot = form.fields.find((f) => f.kind === "screenshot" && f.required && !screenshotUrls([f], input.values).some((u) => byUrl.has(u)));
  if (missingShot) return { ok: false, status: 400, error: `The image for "${missingShot.label}" didn't upload or has expired. Add it again.` };
  if (form.fields.length) {
    descriptionHtml = composeFormDescription(descriptionHtml ?? plainTextToHtml(input.description), form.fields, input.values, (u) => byUrl.has(u));
    used.push(...shots.filter((u) => byUrl.has(u)));
  }
  const claim = [...new Set(used)].map((u) => byUrl.get(u)).filter((id): id is ObjectId => !!id);
  let taskId: string;
  try {
    const task = await createTaskFromForm(form, {
      title: input.title,
      description: input.description,
      descriptionHtml,
      type: input.type,
      submitterName: input.name || null,
      submitterEmail: input.email || null,
    });
    taskId = task.id;
  } catch (err) {
    if (err instanceof UserError) {
      // The form was switched off between the lookup and the create: same answer as a missing form.
      if (/isn't taking submissions/.test(err.message)) return { ok: false, status: 404, error: "This form doesn't exist or isn't taking submissions." };
      return { ok: false, status: 400, error: err.message };
    }
    throw err;
  }
  // The task exists: its images are kept from now on (no cleanup). Unreferenced uploads stay pending and expire.
  if (claim.length) {
    await claimFormUploads(form._id, claim, new ObjectId(taskId)).catch((err) => console.error("[form submit] claiming uploads", err));
  }
  return { ok: true, status: 200 };
}

/** The client IP behind the proxy (Vercel / a local reverse proxy set x-forwarded-for); "local" when there's none. */
export function clientIp(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || headers.get("x-real-ip")?.trim() || "local";
}
