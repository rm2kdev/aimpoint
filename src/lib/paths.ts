/**
 * Single source of truth for in-app org URLs. Every org-scoped page lives
 * under `/o/[org]`; build hrefs, redirects and `revalidatePath` targets with
 * these helpers so server and client code can't drift apart.
 *
 * Pure string helpers: safe to import from server components, server actions,
 * route handlers and client components alike.
 */

/** Route prefix that all org-scoped pages live under. */
export const ORG_ROUTE_PREFIX = "/o";

type Segment = string | number | null | undefined | false;

/**
 * `orgPath("northwind")` -> `/o/northwind`
 * `orgPath("northwind", "settings", "bots", id)` -> `/o/northwind/settings/bots/<id>`
 *
 * Each segment is URI-encoded; pass path parts as separate arguments rather
 * than pre-joined with "/". Falsy segments are skipped.
 */
export function orgPath(slug: string, ...segments: Segment[]): string {
  const parts = [slug, ...segments].filter((s): s is string | number => s !== null && s !== undefined && s !== false && s !== "");
  return `${ORG_ROUTE_PREFIX}/${parts.map((p) => encodeURIComponent(String(p))).join("/")}`;
}

/** `/o/<slug>/p/<key>` */
export const projectPath = (slug: string, projectKey: string) => orgPath(slug, "p", projectKey);

/** Task views that can host the `?task=` side pane. */
export type TaskView = "all" | "my" | "inbox" | "archived";

/** `/o/<slug>/<view>?task=<key>` (defaults to the All tasks view). */
export const taskPath = (slug: string, taskKey: string, view: TaskView = "all") =>
  withTask(orgPath(slug, view), taskKey);

/** Absolute task link, e.g. for bots and notifications. */
export const taskUrl = (origin: string, slug: string, taskKey: string, view: TaskView = "all") =>
  `${origin.replace(/\/+$/, "")}${taskPath(slug, taskKey, view)}`;

/** Append/replace the `?task=` pane param on any in-app path. */
export function withTask(path: string, taskKey: string): string {
  return `${path.split("?")[0]}?task=${encodeURIComponent(taskKey)}`;
}

/** User-level account page (not org-scoped). */
export const ACCOUNT_PATH = "/account";

/** `/account?from=<slug>`: remembers which org to go back to. */
export const accountPath = (fromSlug?: string | null) =>
  fromSlug ? `${ACCOUNT_PATH}?from=${encodeURIComponent(fromSlug)}` : ACCOUNT_PATH;
