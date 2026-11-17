import "server-only";
import { createHash } from "node:crypto";
import { getDb } from "./db";
import { findOpenForm } from "./project-forms";
import {
  createTaskFromForm,
  FORM_DESCRIPTION_MAX,
  FORM_SUBMITTER_EMAIL_MAX,
  FORM_SUBMITTER_NAME_MAX,
} from "./task-service";
import { UserError } from "./result";
import { hasFeature } from "./billing-limits";
import { rateWindow, retryAfter } from "./form-upload-core";

/**
 * The public side of external forms (VEC-207): what `POST /api/forms/<publicId>` does with a submission.
 * Unauthenticated, so it checks everything itself (form open, honeypot, sizes, rate limits) before handing a
 * clean submission to createTaskFromForm, and only ever answers with a short message: never a task key, ids or
 * anything about the org.
 */

/** Largest request body taken, in bytes. A full description (10,000 chars) of multi-byte text fits; anything bigger is refused unread. */
export const FORM_BODY_MAX = 64 * 1024;
export const FORM_TITLE_MAX = 300;
/** Name of the hidden field people never see or fill in. Anything in it marks the submission as a bot's. */
export const HONEYPOT_FIELD = "website";

/** Submissions allowed per client IP per form, and per form from everyone, in each window. */
export const RATE_LIMITS = {
  ipForm: { max: 5, windowMs: 10 * 60_000 },
  form: { max: 60, windowMs: 60 * 60_000 },
} as const;

/** What a public form says while its org is on the Free plan (VEC-224). Nothing about plans or the org leaks to the public. */
export const FORM_UNAVAILABLE = "This form is unavailable right now. Please try again later or contact the team that shared it.";

export type SubmitResult =
  | { ok: true; status: 200 }
  | { ok: false; status: 400 | 403 | 404 | 413 | 429; error: string; retryAfter?: number };

export interface RawSubmission {
  title?: unknown;
  description?: unknown;
  type?: unknown;
  name?: unknown;
  email?: unknown;
  [HONEYPOT_FIELD]?: unknown;
}

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : null);

/** Shape and size checks that need no database, so bad input never uses up the submitter's rate limit. */
function validate(raw: RawSubmission): { title: string; description: string; type: string | null; name: string; email: string } | string {
  const title = str(raw.title);
  const description = str(raw.description);
  const type = str(raw.type);
  const name = str(raw.name);
  const email = str(raw.email);
  if (title === null || description === null || type === null || name === null || email === null) return "Something in the form wasn't text. Reload the page and try again.";
  const t = title.trim();
  if (!t) return "Give it a title.";
  if (t.length > FORM_TITLE_MAX) return `Keep the title under ${FORM_TITLE_MAX} characters (it's ${t.length.toLocaleString()}).`;
  const d = description.replace(/\r\n?/g, "\n");
  if (d.length > FORM_DESCRIPTION_MAX) return `Keep the description under ${FORM_DESCRIPTION_MAX.toLocaleString()} characters (it's ${d.length.toLocaleString()}).`;
  if (name.trim().length > FORM_SUBMITTER_NAME_MAX) return `Keep your name under ${FORM_SUBMITTER_NAME_MAX} characters.`;
  if (email.trim().length > FORM_SUBMITTER_EMAIL_MAX) return `Keep your email under ${FORM_SUBMITTER_EMAIL_MAX} characters.`;
  return { title: t, description: d, type: type || null, name: name.trim(), email: email.trim() };
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
  // The org is on the Free plan (VEC-224): the form is kept but unavailable until it upgrades.
  if (!(await hasFeature(form.orgId, "publicForms"))) return { ok: false, status: 403, error: FORM_UNAVAILABLE };
  const input = validate(raw);
  if (typeof input === "string") return { ok: false, status: 400, error: input };
  // A choose form's type is checked up front too, so a bad pick never spends rate limit. A fixed form ignores it.
  if (form.typeMode === "choose" && input.type && !form.allowedTypes.includes(input.type as never)) {
    return { ok: false, status: 400, error: "Pick one of the listed types." };
  }
  const formKey = form._id.toHexString();
  const wait = (await hit(`ip:${ipKey(ip)}:${formKey}`, RATE_LIMITS.ipForm)) ?? (await hit(`form:${formKey}`, RATE_LIMITS.form));
  if (wait !== null) {
    return { ok: false, status: 429, retryAfter: wait, error: `Too many submissions from here. Try again in ${waitText(wait)}.` };
  }
  // Bots fill every field. Look like a success so they move on, but file nothing (after the rate limit, so it still counts).
  const honey = raw[HONEYPOT_FIELD];
  if (typeof honey === "string" ? honey.trim() !== "" : honey != null) return { ok: true, status: 200 };
  try {
    await createTaskFromForm(form, {
      title: input.title,
      description: input.description,
      type: form.typeMode === "choose" ? input.type : null,
      submitterName: input.name || null,
      submitterEmail: input.email || null,
    });
  } catch (err) {
    if (err instanceof UserError) {
      // The form was switched off between the lookup and the create: same answer as a missing form.
      if (/isn't taking submissions/.test(err.message)) return { ok: false, status: 404, error: "This form doesn't exist or isn't taking submissions." };
      return { ok: false, status: 400, error: err.message };
    }
    throw err;
  }
  return { ok: true, status: 200 };
}

/** The client IP behind the proxy (Vercel / a local reverse proxy set x-forwarded-for); "local" when there's none. */
export function clientIp(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || headers.get("x-real-ip")?.trim() || "local";
}
