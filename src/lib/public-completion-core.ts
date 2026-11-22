/**
 * VEC-423: when a task submitted on a public project page (`source.kind: "public"`) reaches a done-stage status, its
 * submitter is emailed once. Pure, so `public-completion.test.mjs` runs it under plain `node --test`; the server
 * hook is `notifyPublicCompletion` in `lib/public-completion.ts`, the template `lib/public-completion-email.ts`.
 */

/** Stage names as in `StatusCategory` (types.ts), kept structural so this file has no imports. */
type Stage = string | null | undefined;

export interface PublicCompletionCheck {
  /** The task's provenance (`TaskDoc.source`); only `kind: "public"` qualifies. Bots' sub-tasks have none. */
  source: { kind: string } | null | undefined;
  /** Stage of the status the task left. */
  prevStage: Stage;
  /** Stage of the status it moved into. */
  nextStage: Stage;
  archived: boolean;
  /** `TaskDoc.publicCompletionNotifiedAt`: set once the submitter was emailed (or the send was claimed). */
  notifiedAt: Date | string | null | undefined;
  /** The project is still public: `publicAccess.enabled`, not archived, and the org's plan serves public pages. */
  projectPublic: boolean;
}

export type PublicCompletionSkip = "not_public" | "not_done" | "already_done" | "archived" | "notified" | "project_private";

/** Why no email goes out, or null when the submitter should be emailed. Checked cheapest first. */
export function publicCompletionSkip(c: PublicCompletionCheck): PublicCompletionSkip | null {
  if (c.source?.kind !== "public") return "not_public";
  if (c.nextStage !== "done") return "not_done";
  if (c.prevStage === "done") return "already_done";
  if (c.archived) return "archived";
  if (c.notifiedAt) return "notified";
  if (!c.projectPublic) return "project_private";
  return null;
}

export function shouldNotifyPublicCompletion(c: PublicCompletionCheck): boolean {
  return publicCompletionSkip(c) === null;
}

/**
 * The cheap pre-check the status write paths run before any database read: a status move into done of a
 * public-sourced task that wasn't notified yet. Everything else (archived, project still public) is re-checked by
 * the hook against fresh data.
 */
export function mayNotifyPublicCompletion(source: { kind: string } | null | undefined, prevStage: Stage, nextStage: Stage, notifiedAt: unknown): boolean {
  return source?.kind === "public" && nextStage === "done" && prevStage !== "done" && !notifiedAt;
}
