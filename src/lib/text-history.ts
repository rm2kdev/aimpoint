/**
 * VEC-402: every description or triage-plan change leaves an activity entry (kind "description" / "plan") whose
 * `from` holds the text it replaced, so an overwrite can be recovered. Pure helpers, importable by node tests.
 */

/** Most characters of replaced text an entry keeps: the stored description's own cap (sanitizeDescription), so a stored
 * description always fits whole. */
export const HISTORY_TEXT_MAX = 200_000;

/** A burst of autosaves by one actor within this window keeps one entry (the text before the burst), not one per save. */
export const HISTORY_COALESCE_MS = 10 * 60_000;

export type TextHistoryKind = "description" | "plan";

/** The replaced text as kept on the entry: null stays null (there was none), long text is cut at HISTORY_TEXT_MAX. */
export function keptText(prev: string | null | undefined): string | null {
  if (prev === null || prev === undefined) return null;
  return prev.length > HISTORY_TEXT_MAX ? prev.slice(0, HISTORY_TEXT_MAX) : prev;
}

/**
 * Whether this change is part of the same actor's ongoing edit: the task's latest activity is already a `kind` entry
 * by the same actor, less than HISTORY_COALESCE_MS old. Then that entry's `from` (the text before the burst) is the one
 * worth keeping and no new entry is written. Anything else in between (another actor, another kind of change) starts
 * a new entry.
 */
export function continuesEdit(
  last: { kind: string; actorId: string; createdAt: Date } | null | undefined,
  kind: TextHistoryKind,
  actorId: string,
  now: Date,
): boolean {
  if (!last || last.kind !== kind || last.actorId !== actorId) return false;
  const age = now.getTime() - last.createdAt.getTime();
  return age >= 0 && age < HISTORY_COALESCE_MS;
}

/** A plan that sanitises to nothing visible (empty, whitespace, empty paragraphs) clears it: stored as null. */
export function normalizePlan(sanitized: string): string | null {
  const visible = sanitized
    .replace(/<img\b[^>]*>/gi, "x")
    .replace(/<hr\b[^>]*>/gi, "x")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|\s/g, "");
  return visible ? sanitized : null;
}
