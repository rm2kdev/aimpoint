import "server-only";
import { ObjectId } from "mongodb";
import { cols } from "./db";
import { findOpenForm } from "./project-forms";
import { hasFeature } from "./billing-limits";
import { FORM_UNAVAILABLE, hit, ipKey, waitText } from "./form-submit";
import { deleteImageFile, saveFormImage } from "./storage";
import {
  checkFormImage,
  FORM_IMAGE_MAX_BYTES,
  FORM_UPLOAD_BODY_MAX,
  FORM_UPLOAD_PENDING_MS,
  FORM_UPLOAD_TTL_MS,
  readCapped,
  UPLOAD_RATE_LIMITS,
} from "./form-upload-core";
import type { FormUploadDoc } from "./types";

/**
 * Public image uploads for external forms (VEC-233): what `POST /api/forms/<publicId>/uploads` does. Unauthenticated
 * (no session cookie is read), so it checks everything itself: form open + org has public forms + the form allows
 * images, body capped before reading, rate limits per IP per form and per form, type by magic bytes (never SVG).
 * The stored image is a pending `formUploads` record until a submission of the same form claims it; unclaimed ones
 * are deleted with their file after FORM_UPLOAD_PENDING_MS. Answers with `{ url }` only, never ids or org info.
 */

export type UploadResult =
  | { ok: true; status: 200; url: string }
  | { ok: false; status: 400 | 403 | 404 | 413 | 429; error: string; retryAfter?: number };

const NOT_FOUND = "This form doesn't exist or isn't taking submissions.";
const TOO_BIG = `Images must be ${FORM_IMAGE_MAX_BYTES / 1024 / 1024} MB or smaller.`;

export async function uploadFormImage(publicId: string, req: Request, ip: string): Promise<UploadResult> {
  const form = await findOpenForm(publicId);
  if (!form) return { ok: false, status: 404, error: NOT_FOUND };
  if (!(await hasFeature(form.orgId, "publicForms"))) return { ok: false, status: 403, error: FORM_UNAVAILABLE };
  if (!form.allowImages) return { ok: false, status: 403, error: "This form doesn't take images." };
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("multipart/form-data")) return { ok: false, status: 400, error: "Send the image as a multipart form upload in the field `file`." };
  // A declared oversize body is refused before it spends rate limit or gets read.
  const declared = req.headers.get("content-length");
  if (declared && Number(declared) > FORM_UPLOAD_BODY_MAX) return { ok: false, status: 413, error: TOO_BIG };

  // Every attempt that gets this far counts, valid or not: a stream of junk files is exactly what the limit is for.
  const formKey = form._id.toHexString();
  const ipHash = ipKey(ip);
  const wait = (await hit(`up-ip:${ipHash}:${formKey}`, UPLOAD_RATE_LIMITS.ipForm)) ?? (await hit(`up-form:${formKey}`, UPLOAD_RATE_LIMITS.form));
  if (wait !== null) return { ok: false, status: 429, retryAfter: wait, error: `Too many uploads from here. Try again in ${waitText(wait)}.` };

  const body = await readCapped(req.body, declared, FORM_UPLOAD_BODY_MAX);
  if (body === null) return { ok: false, status: 413, error: TOO_BIG };
  const fd = await new Request("http://form.upload/", { method: "POST", headers: { "content-type": type }, body: body as BodyInit })
    .formData()
    .catch(() => null);
  const file = fd?.get("file");
  if (!(file instanceof File)) return { ok: false, status: 400, error: "Attach an image in the field `file`." };
  const data = new Uint8Array(await file.arrayBuffer());
  const check = checkFormImage(data);
  if (!check.ok) return check;

  void sweepFormUploadsSoon();
  const orgId = form.orgId.toHexString();
  const stored = await saveFormImage(orgId, data, check.type, check.ext);
  const now = new Date();
  const c = await cols();
  try {
    await c.formUploads.insertOne({
      _id: new ObjectId(),
      name: stored.name,
      url: stored.url,
      formId: form._id,
      orgId: form.orgId,
      ipHash,
      type: check.type,
      size: data.byteLength,
      createdAt: now,
      claimedTaskId: null,
      expiresAt: new Date(now.getTime() + FORM_UPLOAD_TTL_MS),
    });
  } catch (err) {
    await deleteImageFile(stored.name, stored.url);
    throw err;
  }
  return { ok: true, status: 200, url: stored.url };
}

/* ---------------- for the submit step (VEC-234) ---------------- */

/** The pending (unclaimed, not yet expired) uploads of `formId` among `urls`. URLs not in the result didn't come from this form. */
export async function pendingFormUploads(formId: ObjectId, urls: string[]): Promise<FormUploadDoc[]> {
  if (!urls.length) return [];
  const c = await cols();
  return c.formUploads
    .find({ formId, url: { $in: [...new Set(urls)] }, claimedTaskId: null, createdAt: { $gt: new Date(Date.now() - FORM_UPLOAD_PENDING_MS) } })
    .toArray();
}

/** Marks the uploads as used by `taskId` (kept from then on: no cleanup, no TTL). Returns how many it claimed. */
export async function claimFormUploads(formId: ObjectId, ids: ObjectId[], taskId: ObjectId): Promise<number> {
  if (!ids.length) return 0;
  const c = await cols();
  const r = await c.formUploads.updateMany({ _id: { $in: ids }, formId, claimedTaskId: null }, { $set: { claimedTaskId: taskId }, $unset: { expiresAt: "" } });
  return r.modifiedCount;
}

/* ---------------- cleanup ---------------- */

/** Deletes unclaimed uploads older than FORM_UPLOAD_PENDING_MS, file first (local or blob), then the record. */
export async function sweepFormUploads(now = Date.now()): Promise<number> {
  const c = await cols();
  const cutoff = new Date(now - FORM_UPLOAD_PENDING_MS);
  let removed = 0;
  for (;;) {
    const batch = await c.formUploads.find({ claimedTaskId: null, createdAt: { $lte: cutoff } }, { projection: { name: 1, url: 1 } }).limit(100).toArray();
    if (!batch.length) return removed;
    for (const u of batch) await deleteImageFile(u.name, u.url);
    // Only ones still unclaimed: a submission may have claimed one while its file was being deleted (it's gone either way).
    removed += (await c.formUploads.deleteMany({ _id: { $in: batch.map((u) => u._id) }, claimedTaskId: null })).deletedCount;
    if (batch.length < 100) return removed;
  }
}

const SWEEP_EVERY_MS = 10 * 60_000;
const g = globalThis as unknown as { __formUploadSweep?: { at: number; running?: Promise<unknown> } };

/** Runs sweepFormUploads at most every SWEEP_EVERY_MS per process (called from uploads and the wake sweeper). */
export function sweepFormUploadsSoon(): Promise<unknown> {
  const st = (g.__formUploadSweep ??= { at: 0 });
  if (st.running || Date.now() - st.at < SWEEP_EVERY_MS) return st.running ?? Promise.resolve();
  st.at = Date.now();
  st.running = sweepFormUploads()
    .catch((err) => console.error("[form uploads sweep]", err))
    .finally(() => (st.running = undefined));
  return st.running;
}
