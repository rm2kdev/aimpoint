/**
 * Per-form custom fields on external forms (TPA-399): an ordered list of extra questions beyond title/description,
 * each a short text, a long text or a screenshot (public image upload). Pure (no server-only imports) so
 * `form-fields-core.test.mjs` runs it under plain `node --test`. Used by `lib/project-forms.ts` (admin create/patch
 * validation), `lib/form-submit.ts` (submitted values, required-field check, task description) and the upload route
 * (`lib/form-uploads.ts`: a form with a screenshot field takes uploads even with images off for the description).
 */

export const FORM_FIELD_KINDS = ["short", "long", "screenshot"] as const;
export type FormFieldKind = (typeof FORM_FIELD_KINDS)[number];
export const isFormFieldKind = (v: unknown): v is FormFieldKind => typeof v === "string" && (FORM_FIELD_KINDS as readonly string[]).includes(v);

/** One extra question on a form. `id` is stable across edits (submissions send values keyed by it). */
export interface FormField {
  id: string;
  label: string;
  /** Plain text shown under the label. */
  help: string | null;
  kind: FormFieldKind;
  required: boolean;
}

/** Most fields one form may have. */
export const FORM_FIELDS_MAX = 12;
export const FORM_FIELD_LABEL_MAX = 80;
export const FORM_FIELD_HELP_MAX = 300;
/** Help text under the optional Email field. */
export const FORM_EMAIL_HELP_MAX = 200;
/** Longest value per kind, in characters, and all text field values of one submission together. */
export const FORM_FIELD_VALUE_MAX = { short: 300, long: 5_000 } as const;
export const FORM_FIELDS_TEXT_MAX = 15_000;
/** Most images one screenshot field takes. */
export const FORM_FIELD_SCREENSHOTS_MAX = 5;

const KIND_WORDS = "short (one line of text), long (a paragraph) or screenshot (an image upload)";
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

const newId = () => "f" + globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 11);

/**
 * Validates an admin's field list as a whole. Returns the clean list (form order kept) or the first error as a
 * sentence for a UserError. A field's `id` is kept when it's a known shape and not repeated, otherwise a new one is
 * made, so editing a label never orphans the values in flight. `null`/`undefined` = no fields.
 */
export function cleanFormFields(input: unknown, makeId: () => string = newId): FormField[] | string {
  if (input === null || input === undefined) return [];
  if (!Array.isArray(input)) return "Fields must be a list.";
  if (input.length > FORM_FIELDS_MAX) return `A form can have at most ${FORM_FIELDS_MAX} extra fields (this one has ${input.length}).`;
  const out: FormField[] = [];
  const labels = new Set<string>();
  const ids = new Set<string>();
  for (const [i, raw] of input.entries()) {
    const n = i + 1;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `Field ${n} isn't a field.`;
    const f = raw as Record<string, unknown>;
    if (f.label !== undefined && typeof f.label !== "string") return `Field ${n}'s label must be text.`;
    const label = String(f.label ?? "").replace(/\s+/g, " ").trim();
    if (!label) return `Field ${n} needs a label.`;
    if (label.length > FORM_FIELD_LABEL_MAX) return `Keep field labels under ${FORM_FIELD_LABEL_MAX} characters ("${label.slice(0, 30)}..." is ${label.length}).`;
    const key = label.toLowerCase();
    if (labels.has(key)) return `Two fields are labelled "${label}". Give each field its own label.`;
    labels.add(key);
    if (!isFormFieldKind(f.kind)) return `Field "${label}" has an unknown kind "${String(f.kind ?? "")}". Kinds are: ${KIND_WORDS}.`;
    if (f.help !== undefined && f.help !== null && typeof f.help !== "string") return `Field "${label}"'s help text must be text.`;
    const help = String(f.help ?? "").replace(/\r\n?/g, "\n").trim();
    if (help.length > FORM_FIELD_HELP_MAX) return `Keep the help text of "${label}" under ${FORM_FIELD_HELP_MAX} characters.`;
    if (f.required !== undefined && typeof f.required !== "boolean") return `Field "${label}": required is true or false.`;
    let id = typeof f.id === "string" && ID_RE.test(f.id) && !ids.has(f.id) ? f.id : "";
    while (!id || ids.has(id)) id = makeId();
    ids.add(id);
    out.push({ id, label, help: help || null, kind: f.kind, required: f.required === true });
  }
  return out;
}

/** Help text under the Email field: plain text, one paragraph, null when empty. */
export function cleanEmailHelp(v: unknown): string | null | { error: string } {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return { error: "The email note must be text." };
  const s = v.replace(/\s+/g, " ").trim();
  if (s.length > FORM_EMAIL_HELP_MAX) return { error: `Keep the email note under ${FORM_EMAIL_HELP_MAX} characters.` };
  return s || null;
}

/** Hiding the generic description box only makes sense when the form asks something else instead. */
export function checkHideDescription(hide: boolean, fields: FormField[]): string | null {
  return hide && !fields.some((f) => f.kind !== "screenshot") ? "Add at least one text field before hiding the description box." : null;
}

/** A submitted value: text for short/long, a list of upload URLs for screenshot. */
export type FormFieldValue = string | string[];
export type FormFieldValues = Record<string, FormFieldValue>;

/**
 * Collects a submission's field values: JSON `fields: {<id>: value}` and/or plain form posts' `field_<id>` keys.
 * Unknown ids are ignored. Text is trimmed with line endings normalised; a screenshot takes one URL or a list.
 * Returns the values (empty ones left out) or an error sentence: wrong shapes, too long, and every required field
 * left empty, named in form order.
 */
export function readFieldValues(fields: FormField[], raw: Record<string, unknown>): { values: FormFieldValues } | { error: string } {
  if (!fields.length) return { values: {} };
  const bag = raw.fields;
  if (bag !== undefined && bag !== null && (typeof bag !== "object" || Array.isArray(bag))) return { error: "Something in the form wasn't right. Reload the page and try again." };
  const from = (bag ?? {}) as Record<string, unknown>;
  const values: FormFieldValues = {};
  const missing: string[] = [];
  let text = 0;
  for (const f of fields) {
    const v = Object.hasOwn(from, f.id) ? from[f.id] : raw[`field_${f.id}`];
    if (f.kind === "screenshot") {
      const list = v === undefined || v === null || v === "" ? [] : Array.isArray(v) ? v : [v];
      if (!list.every((u) => typeof u === "string")) return { error: `"${f.label}" wasn't an uploaded image. Remove it and add it again.` };
      const urls = [...new Set((list as string[]).map((u) => u.trim()).filter(Boolean))];
      if (urls.length > FORM_FIELD_SCREENSHOTS_MAX) return { error: `Add at most ${FORM_FIELD_SCREENSHOTS_MAX} images to "${f.label}".` };
      if (urls.some((u) => u.length > 2048)) return { error: `"${f.label}" wasn't an uploaded image. Remove it and add it again.` };
      if (urls.length) values[f.id] = urls;
      else if (f.required) missing.push(f.label);
      continue;
    }
    if (v !== undefined && v !== null && typeof v !== "string") return { error: `"${f.label}" must be text.` };
    const s = String(v ?? "").replace(/\r\n?/g, "\n").trim();
    const max = FORM_FIELD_VALUE_MAX[f.kind];
    if (s.length > max) return { error: `Keep "${f.label}" under ${max.toLocaleString()} characters (it's ${s.length.toLocaleString()}).` };
    text += s.length;
    if (s) values[f.id] = f.kind === "short" ? s.replace(/\s*\n\s*/g, " ") : s;
    else if (f.required) missing.push(f.label);
  }
  if (missing.length) return { error: missing.length === 1 ? `Fill in "${missing[0]}".` : `Fill in the required fields: ${missing.map((m) => `"${m}"`).join(", ")}.` };
  if (text > FORM_FIELDS_TEXT_MAX) return { error: `That's too much text in one go (${text.toLocaleString()} characters across the fields, the most is ${FORM_FIELDS_TEXT_MAX.toLocaleString()}).` };
  return { values };
}

/** Every screenshot URL among the values, to look up as this form's pending uploads. */
export function screenshotUrls(fields: FormField[], values: FormFieldValues): string[] {
  return fields.flatMap((f) => (f.kind === "screenshot" && Array.isArray(values[f.id]) ? (values[f.id] as string[]) : []));
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Markdown image syntax typed by the public is removed (VEC-243; same rule as task-intake-core's stripMarkdownImages). */
const stripMarkdownImages = (text: string) => text.replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, "");

/** Plain text -> editor HTML: blank lines split paragraphs, single newlines become <br>. Nothing typed is markup. */
export function plainTextToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => stripMarkdownImages(p).trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/**
 * The created task's description: the submitter's own description (already HTML) first, then every provided field
 * as an `<h3>label</h3>` section in form order (agents read it as `### label` Markdown, lib/markdown-core.ts).
 * Screenshots are embedded as images, only those `imageOk` accepts (the form's own pending uploads); a field left
 * with none, and every empty optional field, is omitted.
 */
export function composeFormDescription(descriptionHtml: string, fields: FormField[], values: FormFieldValues, imageOk: (url: string) => boolean = () => true): string {
  const parts = [descriptionHtml.trim()];
  for (const f of fields) {
    const v = values[f.id];
    if (v === undefined) continue;
    let body: string;
    if (f.kind === "screenshot") {
      const urls = (Array.isArray(v) ? v : [v]).filter(imageOk);
      if (!urls.length) continue;
      body = urls.map((u) => `<p><img src="${escapeHtml(u)}" alt="${escapeHtml(f.label)}"></p>`).join("");
    } else {
      body = plainTextToHtml(String(v));
      if (!body) continue;
    }
    parts.push(`<h3>${escapeHtml(f.label)}</h3>${body}`);
  }
  return parts.filter(Boolean).join("");
}
