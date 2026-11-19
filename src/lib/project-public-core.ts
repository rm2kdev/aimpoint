import type { FORM_DESTINATION_STAGES, Priority, PublicComment, PublicStatus, PublicTask, StatusCategory, TaskType } from "./types";

/**
 * Public projects (VEC-255): the pure rules, free of server-only imports so `project-public-core.test.mjs` runs them
 * under plain `node --test`. The server side (settings, loaders, submit) is lib/project-public.ts.
 */

/** Stages a public submission may file into: the same rule as external forms (FORM_DESTINATION_STAGES). */
export const PUBLIC_SUBMIT_STAGES = ["backlog", "triage", "unstarted"] as const satisfies readonly StatusCategory[];
// Compile-time guard that the two lists stay the same set (types.ts can't be imported at runtime by node --test).
type FormStage = (typeof FORM_DESTINATION_STAGES)[number];
type PublicStage = (typeof PUBLIC_SUBMIT_STAGES)[number];
const sameStages: [FormStage, PublicStage] extends [PublicStage, FormStage] ? true : never = true;
void sameStages;

export const isPublicSubmitStage = (v: unknown): v is PublicStage => typeof v === "string" && (PUBLIC_SUBMIT_STAGES as readonly string[]).includes(v);

/** Submissions allowed per signed-in account per public project, and per project from everyone, in each window. */
export const PUBLIC_RATE_LIMITS = {
  userProject: { max: 5, windowMs: 10 * 60_000 },
  project: { max: 60, windowMs: 60 * 60_000 },
} as const;

/** Tasks returned by one public project load (newest activity first). */
export const PUBLIC_TASKS_MAX = 500;
/** Comments returned per task in the public view. */
export const PUBLIC_COMMENTS_MAX = 200;

/** What a public project says while its org is unpaid (locked). Nothing about the plan or the org. */
export const PUBLIC_UNAVAILABLE = "This project's public page is unavailable right now. Please try again later or contact the team that shared it.";

export interface StatusLike {
  id: string;
  name: string;
  category: StatusCategory;
}

const STAGE_WORDS = "Backlog, Triage or a not-started status";

/**
 * Validates the admin's list of submit statuses against the project's own statuses: a list of ids, each one of this
 * project's statuses in a submit stage. Duplicates collapse, order is kept (the first is the default destination).
 */
export function resolveSubmitStatuses(requested: unknown, statuses: readonly StatusLike[]): { ok: true; ids: string[] } | { ok: false; error: string } {
  if (!Array.isArray(requested)) return { ok: false, error: "Pick the statuses people can submit tickets into (a list, which may be empty)." };
  const byId = new Map(statuses.map((s) => [s.id, s]));
  const ids: string[] = [];
  for (const raw of requested) {
    const id = typeof raw === "string" ? raw : "";
    const status = byId.get(id);
    if (!status) return { ok: false, error: "One of those statuses isn't one of this project's statuses. Reload and try again." };
    if (!isPublicSubmitStage(status.category)) return { ok: false, error: `Public tickets can only go into ${STAGE_WORDS}, not "${status.name}".` };
    if (!ids.includes(id)) ids.push(id);
  }
  return { ok: true, ids };
}

/** The saved list with anything that's no longer an own status in a submit stage removed (status hooks, reads). */
export function pruneSubmitStatuses(ids: readonly string[], statuses: readonly StatusLike[]): string[] {
  const byId = new Map(statuses.map((s) => [s.id, s]));
  return ids.filter((id, i) => ids.indexOf(id) === i && isPublicSubmitStage(byId.get(id)?.category));
}

/**
 * Submit statuses for a project being switched public (AIM-2): the saved list when there is one, else the project's
 * new-task status (`newTaskStatusId`, lib/project-defaults) when it's in a submit stage, so public tickets start
 * where people's new tasks do (e.g. Triage, where a triage bot picks them up). Empty when it isn't (read-only).
 */
export function initialSubmitStatuses(saved: readonly string[], newTaskStatusId: string | null | undefined, statuses: readonly StatusLike[]): string[] {
  if (saved.length) return [...saved];
  const status = newTaskStatusId ? statuses.find((s) => s.id === newTaskStatusId) : undefined;
  return status && isPublicSubmitStage(status.category) ? [status.id] : [];
}

/**
 * The project's new-task status when the default public destination isn't it (AIM-2), for the settings warning that
 * public tickets skip it; null when they match, nobody can submit, or the new-task status can't take submissions.
 */
export function intakeSkips<S extends StatusLike>(allowed: readonly string[], newTaskStatusId: string | null | undefined, statuses: readonly S[]): S | null {
  if (!allowed.length || !newTaskStatusId || allowed[0] === newTaskStatusId) return null;
  const status = statuses.find((s) => s.id === newTaskStatusId);
  return status && isPublicSubmitStage(status.category) ? status : null;
}

/** The status a submission goes into: the requested one when allowed, the first allowed one when none was asked for. */
export function pickSubmitStatus(requested: unknown, allowed: readonly string[]): { ok: true; id: string } | { ok: false; error: string } {
  if (!allowed.length) return { ok: false, error: "This project isn't taking new tickets." };
  if (requested === undefined || requested === null || requested === "") return { ok: true, id: allowed[0] };
  if (typeof requested !== "string" || !allowed.includes(requested)) return { ok: false, error: "Pick one of the listed statuses." };
  return { ok: true, id: requested };
}

/* ---------------- public view shaping ---------------- */

/**
 * URL the public view uses for a local upload of a public project's task. `file` is the stored name without its
 * `<orgId>-` prefix (PUBLIC_UPLOAD_FILE), so the public never sees the org's id; the route puts it back.
 */
export function publicImagePath(slug: string, key: string, file: string): string {
  return `/api/public/${encodeURIComponent(slug)}/${encodeURIComponent(key)}/uploads/${encodeURIComponent(file)}`;
}

/** A stored task image name (`<orgId>-<random16>.<ext>`, lib/storage.ts). Avatars never match. */
export const UPLOAD_NAME = /^([a-f0-9]{24})-([A-Za-z0-9_-]{16}\.(png|jpg|gif|webp|avif))$/;
/** The public part of an upload name (no org id). */
export const PUBLIC_UPLOAD_FILE = /^[A-Za-z0-9_-]{16}\.(png|jpg|gif|webp|avif)$/;
const LOCAL_SRC = /^\/api\/uploads\/([^/?#"]+)$/;

export interface ImageContext {
  orgId: string;
  slug: string;
  key: string;
}

/**
 * Rewrites the images of already-sanitised description HTML for the public: this org's local uploads go through the
 * public image route, any other local `/api/uploads/...` source (another org's file, an avatar) is dropped with its
 * tag, and absolute http(s) sources (Blob storage, already public) are kept. sanitize-html writes attributes
 * double-quoted, which the pattern relies on.
 */
export function rewritePublicImages(cleanHtml: string, ctx: ImageContext): string {
  return cleanHtml.replace(/<img\b[^>]*>/gi, (tag) => {
    const m = /\ssrc="([^"]*)"/i.exec(tag);
    if (!m) return "";
    const src = m[1].replace(/&amp;/g, "&");
    const local = LOCAL_SRC.exec(src);
    if (!local) return /^https?:\/\//i.test(src) ? tag : "";
    const name = local[1];
    const own = UPLOAD_NAME.exec(name);
    if (!own || own[1] !== ctx.orgId) return "";
    return tag.replace(m[0], ` src="${publicImagePath(ctx.slug, ctx.key, own[2])}"`);
  });
}

/** Local upload names referenced by stored (member-side) description HTML. */
export function localUploadNames(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<img\b[^>]*?\ssrc="\/api\/uploads\/([^"/?#]+)"/gi)) out.add(m[1]);
  return [...out];
}

/** A comment's plain-text body with `<@id>` mention tokens shown as @Name (names only, never ids). */
export function publicCommentBody(body: string, nameOf: (id: string) => string | undefined): string {
  return body.replace(/<@([a-f0-9]{24})>/g, (_, id: string) => `@${nameOf(id) ?? "someone"}`);
}

export interface TaskLike {
  number: number;
  title: string;
  type: TaskType;
  statusId: { toString(): string } | string;
  priority: Priority;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One task for the public: a fixed allow-list of fields, whatever else the stored task carries (assignee, creator,
 * source, flow, claims, dependencies are never copied). `description` must already be public-sanitised.
 */
export function shapePublicTask(t: TaskLike, projectKey: string, statuses: ReadonlyMap<string, PublicStatus>, description: string): PublicTask {
  const status = statuses.get(String(t.statusId)) ?? null;
  return {
    key: `${projectKey}-${t.number}`,
    title: t.title,
    type: t.type,
    status: status ? { ...status } : null,
    priority: t.priority,
    description,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

export function shapePublicComment(c: { authorId: { toString(): string } | string; body: string; createdAt: Date }, nameOf: (id: string) => string | undefined): PublicComment {
  return {
    author: nameOf(String(c.authorId)) ?? "Former member",
    body: publicCommentBody(c.body, nameOf),
    createdAt: c.createdAt.toISOString(),
  };
}

/** Org slug + project key from a URL, normalised; null when they can't be one. */
export function parsePublicRef(slug: unknown, key: unknown): { slug: string; key: string } | null {
  if (typeof slug !== "string" || typeof key !== "string") return null;
  const s = slug.trim().toLowerCase();
  const k = key.trim().toUpperCase();
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(s) || !/^[A-Z][A-Z0-9]{1,9}$/.test(k)) return null;
  return { slug: s, key: k };
}
