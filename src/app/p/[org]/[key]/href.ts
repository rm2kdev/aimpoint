/**
 * URLs of the public project page (VEC-257): `/p/<slug>/<KEY>` plus its query (`task`, `view=mine`, `submit=1`,
 * `created`). Pure, so the server page and the client screen build the same links.
 */
export interface PublicPageQuery {
  task?: string | null;
  view?: "mine" | null;
  submit?: boolean;
  created?: string | null;
}

export function publicPageHref(slug: string, key: string, q: PublicPageQuery = {}): string {
  const base = `/p/${encodeURIComponent(slug)}/${encodeURIComponent(key)}`;
  const qs = new URLSearchParams();
  if (q.view) qs.set("view", q.view);
  if (q.task) qs.set("task", q.task);
  if (q.submit) qs.set("submit", "1");
  if (q.created) qs.set("created", q.created);
  const s = qs.toString();
  return s ? `${base}?${s}` : base;
}

/** Sign-in link that comes back to `next` (same-origin paths only, see safeNext in lib/safe-next.ts). */
export const loginHref = (next: string) => `/login?next=${encodeURIComponent(next)}`;
export const signupHref = (next: string) => `/signup?next=${encodeURIComponent(next)}`;
