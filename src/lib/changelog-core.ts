// Pure changelog rules (VEC-373): which "What's new" milestone a person should see, and what a valid milestone
// looks like. No DB, React or Next imports, so `pnpm test` (node --test) covers it and client code can import it.
//
// Milestones are product-level (every org gets the same release) and authored in the repo under
// src/content/changelog/ (see docs/changelog.md). A person's seen marker is `UserDoc.changelogSeen`: the id of
// the newest milestone they dismissed.

/** One change in a milestone: a short title, a short Markdown body and an optional screenshot. */
export type ChangelogEntry = {
  title: string;
  /** Short Markdown (a sentence or two). */
  body: string;
  /** A screenshot under public/changelog/<milestone-id>/, referenced as `/changelog/<milestone-id>/<file>`. */
  image?: { src: string; alt: string };
};

/** A release's worth of changes, shown together in one pop-up. */
export type ChangelogMilestone = {
  /** `YYYY-MM-DD`, optionally with a `-<slug>` suffix for a second release on one day. Sorts like releasedAt. */
  id: string;
  title: string;
  /** ISO 8601 timestamp of the release (e.g. `2026-11-21T00:00:00+08:00`). */
  releasedAt: string;
  summary?: string;
  /** Shown in this order. At least one. */
  entries: ChangelogEntry[];
};

/** Milestone ids: a date, optionally `-lowercase-slug` (e.g. `2026-11-21`, `2026-11-21-hotfix`). */
export const MILESTONE_ID = /^\d{4}-\d{2}-\d{2}(-[a-z0-9]+(?:-[a-z0-9]+)*)?$/;
/** Where screenshots live: public/changelog/<id>/... is served as /changelog/<id>/... */
export const IMAGE_PREFIX = "/changelog/";
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif)$/i;

const time = (iso: string) => Date.parse(iso);

/** Newest first: by releasedAt, then id. Returns a new array. */
export function sortMilestones(all: readonly ChangelogMilestone[]): ChangelogMilestone[] {
  return [...all].sort((a, b) => time(b.releasedAt) - time(a.releasedAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** The newest milestone, or null when none has shipped. */
export function latestMilestone(all: readonly ChangelogMilestone[]): ChangelogMilestone | null {
  return sortMilestones(all)[0] ?? null;
}

/**
 * Milestones this person hasn't seen, newest first.
 *
 * - `seen` (UserDoc.changelogSeen) is the newest milestone they dismissed: only ids that sort after it count.
 *   Ids are date-first and validated to sort like releasedAt, so this holds even if that milestone was removed.
 *   Missing/null = nothing dismissed yet.
 * - `userCreatedAt`: milestones released before the account existed are never shown, so a new signup isn't
 *   greeted with old news. Existing accounts (created before a milestone shipped) see it once.
 */
export function unseenMilestones(
  all: readonly ChangelogMilestone[],
  seen: string | null | undefined,
  userCreatedAt: Date | string | number | null | undefined,
): ChangelogMilestone[] {
  const joined = userCreatedAt == null ? -Infinity : new Date(userCreatedAt).getTime();
  return sortMilestones(all).filter(
    (m) => (!seen || m.id > seen) && !(Number.isFinite(joined) && time(m.releasedAt) < joined),
  );
}

/** The milestone the pop-up should show (the newest unseen one), or null for no pop-up. */
export function shouldShowChangelog(
  all: readonly ChangelogMilestone[],
  seen: string | null | undefined,
  userCreatedAt: Date | string | number | null | undefined,
): ChangelogMilestone | null {
  return unseenMilestones(all, seen, userCreatedAt)[0] ?? null;
}

/**
 * The seen marker after dismissing `id`: moves forward only. Unknown ids and ids at or before the current marker
 * leave it as it is (returns the current value), so dismissing twice or with an older id is a no-op.
 */
export function nextSeenMarker(
  all: readonly ChangelogMilestone[],
  current: string | null | undefined,
  id: string,
): string | null {
  const now = current ?? null;
  if (!all.some((m) => m.id === id)) return now;
  return now && id <= now ? now : id;
}

/** Problems with one milestone (empty = valid). */
export function validateMilestone(m: ChangelogMilestone): string[] {
  const where = `Milestone ${JSON.stringify(m?.id)}`;
  const errors: string[] = [];
  if (typeof m?.id !== "string" || !MILESTONE_ID.test(m.id)) errors.push(`${where}: id must look like YYYY-MM-DD or YYYY-MM-DD-slug.`);
  if (typeof m?.title !== "string" || !m.title.trim()) errors.push(`${where}: title is empty.`);
  if (typeof m?.releasedAt !== "string" || !Number.isFinite(time(m.releasedAt))) {
    errors.push(`${where}: releasedAt is not an ISO date.`);
  } else if (typeof m.id === "string" && MILESTONE_ID.test(m.id) && m.releasedAt.slice(0, 10) !== m.id.slice(0, 10)) {
    // Not fatal for ordering on its own, but keeping the dates in step is what makes id order = release order.
    errors.push(`${where}: releasedAt (${m.releasedAt}) should start with the id's date ${m.id.slice(0, 10)}.`);
  }
  if (m?.summary !== undefined && (typeof m.summary !== "string" || !m.summary.trim())) errors.push(`${where}: summary is empty (leave it out instead).`);
  if (!Array.isArray(m?.entries) || m.entries.length === 0) {
    errors.push(`${where}: needs at least one entry.`);
    return errors;
  }
  m.entries.forEach((e, i) => {
    const at = `${where} entry ${i + 1}`;
    if (typeof e?.title !== "string" || !e.title.trim()) errors.push(`${at}: title is empty.`);
    if (typeof e?.body !== "string" || !e.body.trim()) errors.push(`${at}: body is empty.`);
    if (e?.image !== undefined) {
      const { src, alt } = e.image ?? ({} as { src?: string; alt?: string });
      const dir = `${IMAGE_PREFIX}${m.id}/`;
      if (typeof src !== "string" || !src.startsWith(dir) || src.length === dir.length || src.includes("..") || /[?#\s]/.test(src)) {
        errors.push(`${at}: image src must be a file under ${dir} (public/changelog/${m.id}/).`);
      } else if (!IMAGE_EXT.test(src)) {
        errors.push(`${at}: image src must be a png, jpg, webp, gif or avif file.`);
      }
      if (typeof alt !== "string" || !alt.trim()) errors.push(`${at}: image alt text is missing.`);
    }
  });
  return errors;
}

/** Problems with the whole list as exported by the index (empty = valid): each milestone, unique ids, newest first. */
export function validateMilestones(all: readonly ChangelogMilestone[]): string[] {
  const errors = all.flatMap(validateMilestone);
  const ids = new Set<string>();
  for (const m of all) {
    if (ids.has(m.id)) errors.push(`Milestone ${JSON.stringify(m.id)} is listed twice.`);
    ids.add(m.id);
  }
  for (let i = 1; i < all.length; i++) {
    const [a, b] = [all[i - 1], all[i]];
    if (!(a.id > b.id) || time(a.releasedAt) < time(b.releasedAt)) {
      errors.push(`Milestones must be listed newest first: ${JSON.stringify(a.id)} comes before ${JSON.stringify(b.id)}.`);
    }
  }
  return errors;
}

/** Every image path the milestones reference (for the "file exists in public/" check). */
export function milestoneImages(all: readonly ChangelogMilestone[]): string[] {
  return all.flatMap((m) => m.entries.flatMap((e) => (e.image ? [e.image.src] : [])));
}
