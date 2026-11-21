/**
 * TaskComposer core (VEC-357): the pure state rules behind `components/task-composer` (validation, server error ->
 * field mapping, focus order, keyboard shortcut). No runtime imports, so `task-composer-core.test.mjs` runs it under
 * plain `node --test`; the limits and message texts come in from `lib/task-intake-core.ts` through the component (and
 * the test checks every intake message maps to the field it's about, so the patterns below can't drift unnoticed).
 */

/**
 * The parts of a composer that can be marked invalid, in no particular order: the built-in fields and each custom
 * field of a form (`field:<id>`).
 */
export type ComposerErrorKey = "type" | "title" | "description" | "status" | "name" | "email" | `field:${string}`;
export type ComposerErrors = Partial<Record<ComposerErrorKey, string>>;

export const fieldKey = (id: string): ComposerErrorKey => `field:${id}`;

/** A form's custom field as far as error mapping cares: its id, label and whether it takes images. */
export interface ComposerFieldRef {
  id: string;
  label: string;
  kind?: string;
}

/** Top-to-bottom order of a composer's parts: focus goes to the first invalid one and a summary lists them so. */
export function errorOrder(fields: readonly ComposerFieldRef[] = []): ComposerErrorKey[] {
  return ["type", "title", "description", ...fields.map((f) => fieldKey(f.id)), "name", "email", "status"];
}

/** The invalid keys of `errors` in page order. */
export function invalidKeys(errors: ComposerErrors, fields: readonly ComposerFieldRef[] = []): ComposerErrorKey[] {
  return errorOrder(fields).filter((k) => errors[k]);
}

/** The first invalid key top to bottom (what gets focus), or null. */
export function firstInvalid(errors: ComposerErrors, fields: readonly ComposerFieldRef[] = []): ComposerErrorKey | null {
  return invalidKeys(errors, fields)[0] ?? null;
}

/** `errors` without `key` (the same object when there was nothing to clear, so a state setter can bail out). */
export function clearError(errors: ComposerErrors, key: ComposerErrorKey): ComposerErrors {
  if (!errors[key]) return errors;
  const next = { ...errors };
  delete next[key];
  return next;
}

export const hasErrors = (errors: ComposerErrors) => Object.values(errors).some(Boolean);

/** The messages the client check uses (the component passes `INTAKE_ERRORS` from lib/task-intake-core). */
export interface ComposerMessages {
  titleMissing: string;
  titleTooLong: (length: number) => string;
  descriptionTooLong: (length: number) => string;
  typeNotAllowed: string;
  statusNotAllowed: string;
}

export interface ComposerInput {
  title: string;
  /** Visible text length of the description (what the limit counts). */
  descriptionLength: number;
  type?: string | null;
  statusId?: string | null;
}

export interface ComposerRules {
  titleMax: number;
  /** No cap when left out (the in-app dialog, see docs/task-creation.md "Differences kept on purpose"). */
  descriptionMax?: number;
  /** The types on offer; when given, the picked type must be one of them. */
  allowedTypes?: readonly string[];
  /** The statuses on offer; when given (and non-empty), the picked status must be one of them. */
  allowedStatuses?: readonly string[];
}

/** The browser-side check before sending, mirroring the server's intake rules (normalizeTitle, resolveType, ...). */
export function checkComposer(input: ComposerInput, rules: ComposerRules, messages: ComposerMessages): ComposerErrors {
  const errors: ComposerErrors = {};
  const title = input.title.trim();
  if (!title) errors.title = messages.titleMissing;
  else if (title.length > rules.titleMax) errors.title = messages.titleTooLong(title.length);
  if (rules.descriptionMax !== undefined && input.descriptionLength > rules.descriptionMax) {
    errors.description = messages.descriptionTooLong(input.descriptionLength);
  }
  if (rules.allowedTypes && input.type && !rules.allowedTypes.includes(input.type)) errors.type = messages.typeNotAllowed;
  if (rules.allowedStatuses?.length && input.statusId && !rules.allowedStatuses.includes(input.statusId)) {
    errors.status = messages.statusNotAllowed;
  }
  return errors;
}

const requiredText = (f: ComposerFieldRef) => (f.kind === "screenshot" ? "Add at least one image." : "Fill this in.");

/**
 * Which part of the composer a server error is about, with the inline message for it. Generalises the form's
 * TPA-399 mapping to every intake message (lib/task-intake-core `INTAKE_ERRORS`): title, description (length, HTML
 * size, image count, not text), type, status, submitter name/email, and custom fields named in quotes
 * (`Fill in the required fields: "A", "B".`). A message naming nothing returns `{}`: show it as a general error.
 */
export function serverFieldErrors(message: string, fields: readonly ComposerFieldRef[] = []): ComposerErrors {
  const out: ComposerErrors = {};
  if (/^Give (it|the task) a title\b/.test(message) || /^Keep the title\b/.test(message)) out.title = message;
  if (/^(Keep the description\b|That description\b|The description\b|Add at most \d+ images?\b)/.test(message)) out.description = message;
  if (/^Pick one of(?: the listed types\b|:)/.test(message)) out.type = message;
  if (/^Pick one of the listed statuses\b/.test(message)) out.status = message;
  if (/^Keep your name\b/.test(message)) out.name = message;
  if (/^(Keep your email\b|That email address\b|Enter a full email address\b)/.test(message)) out.email = message;
  const missing = /^Fill in\b/.test(message);
  for (const f of fields) {
    if (message.includes(`"${f.label}"`)) out[fieldKey(f.id)] = missing ? requiredText(f) : message;
  }
  return out;
}

/**
 * The general line to show for a server error once its fields are marked: nothing when the inline messages already
 * say it (a "Fill in ..." list, or a field showing the message itself), else the message.
 */
export function serverSummary(message: string, named: ComposerErrors): string | null {
  if (!hasErrors(named)) return message;
  return /^Fill in\b/.test(message) || Object.values(named).includes(message) ? null : message;
}

/** Cmd+Enter / Ctrl+Enter, except while an IME is composing text. */
export function isSubmitShortcut(e: { key: string; metaKey?: boolean; ctrlKey?: boolean; isComposing?: boolean }): boolean {
  return e.key === "Enter" && !!(e.metaKey || e.ctrlKey) && !e.isComposing;
}

/** Plain Enter (no modifier, not composing): submits from a single-line title in the compact dialog layout. */
export function isPlainEnter(e: { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; isComposing?: boolean }): boolean {
  return e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.isComposing;
}

/** Tiptap leaves an empty paragraph after a trailing image or on an empty document; it isn't content. */
export function trimEmptyParagraphs(html: string): string {
  const out = html.replace(/(<p><\/p>)+$/, "");
  return out === "<p></p>" ? "" : out;
}

/** The types to offer: `allowed` in TASK_TYPES order (unknown ones dropped), or every type when `allowed` is empty. */
export function offeredTypes<T extends string>(all: readonly T[], allowed?: readonly string[] | null): T[] {
  if (!allowed?.length) return [...all];
  const list = all.filter((t) => allowed.includes(t));
  return list.length ? list : [...all];
}

/** A starting type that is on offer: `wanted` when offered, else the first offered one. */
export function startingType<T extends string>(offered: readonly T[], wanted?: string | null): T {
  return (offered as readonly string[]).includes(wanted ?? "") ? (wanted as T) : offered[0];
}

/** "N characters left" shows once fewer than `warnAt` remain; negative = over the limit. */
export function charactersLeft(max: number | undefined, length: number, warnAt = 500): number | null {
  if (max === undefined) return null;
  const left = max - length;
  return left < warnAt ? left : null;
}

/** Summary heading for the page layout's error box. */
export function summaryHeading(count: number): string {
  return count === 0 ? "That didn't go through." : count === 1 ? "One thing needs fixing before you send:" : `${count} things need fixing before you send:`;
}
