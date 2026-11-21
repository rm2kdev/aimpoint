// Pure helpers for the "What's new" pop-up (VEC-374): slide stepping, the milestone's lightbox gallery, the
// release date line, the screen-reader announcement and the "All updates" history rows (VEC-377). No DOM or React, so `pnpm test` (node --test) covers it.
// The milestone model and who-sees-what rules live in lib/changelog-core.ts (VEC-373); docs/changelog.md.

import { sortMilestones, type ChangelogMilestone } from "./changelog-core";
import type { LightboxImage } from "./image-lightbox-core";

/** Slide `i` clamped into `0..n-1`. A tour doesn't wrap: Prev stops at the first slide, the last says "Got it". */
export function clampSlide(i: number, n: number): number {
  if (n <= 0 || !Number.isFinite(i)) return 0;
  return Math.min(n - 1, Math.max(0, Math.trunc(i)));
}

/**
 * The slide a key moves to from `i` of `n`, or null when the key isn't a slide key (or wouldn't move).
 * ArrowLeft/ArrowRight step, Home/End jump to the ends.
 */
export function slideForKey(key: string, i: number, n: number): number | null {
  if (n < 2) return null;
  const to =
    key === "ArrowRight" ? i + 1 : key === "ArrowLeft" ? i - 1 : key === "Home" ? 0 : key === "End" ? n - 1 : null;
  if (to === null) return null;
  const next = clampSlide(to, n);
  return next === i ? null : next;
}

/**
 * Every screenshot in the milestone, in entry order, for the lightbox, plus where each entry's screenshot sits in
 * that list (`indexOf[entry]`, -1 for an entry without one), so expand opens the lightbox on the right image.
 */
export function milestoneGallery(m: Pick<ChangelogMilestone, "entries">): { images: LightboxImage[]; indexOf: number[] } {
  const images: LightboxImage[] = [];
  const indexOf = m.entries.map((e) => {
    if (!e.image) return -1;
    images.push({ src: e.image.src, alt: e.image.alt });
    return images.length - 1;
  });
  return { images, indexOf };
}

/**
 * The release date as people read it ("21 November 2026" in en-AU), taken from the milestone id's date so it is
 * the same day everywhere, whatever the reader's time zone.
 */
export function releaseDateLabel(m: Pick<ChangelogMilestone, "id" | "releasedAt">, locale?: string): string {
  const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(m.id) ?? /^(\d{4})-(\d{2})-(\d{2})/.exec(m.releasedAt);
  if (!d) return "";
  const at = new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3])));
  if (!Number.isFinite(at.getTime())) return "";
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(at);
}

/** What a screen reader hears when the slide changes: "Change 2 of 5: <entry title>". */
export function slideAnnouncement(i: number, n: number, title: string): string {
  return n > 1 ? `Change ${i + 1} of ${n}: ${title}` : title;
}

/** One row of the "All updates" list (VEC-377). */
export type HistoryRow = {
  id: string;
  title: string;
  releasedAt: string;
  /** releaseDateLabel, e.g. "21 November 2026". */
  date: string;
  entryCount: number;
  /** "1 change" / "7 changes". */
  countLabel: string;
  /** The milestone's summary, or its entry titles joined, so every row says what's in it. */
  blurb: string;
  /** The first screenshot in entry order, or null when the milestone has none. */
  thumbnail: { src: string; alt: string } | null;
};

/** `n` changes as people read it. */
export function changeCountLabel(n: number): string {
  return `${n} ${n === 1 ? "change" : "changes"}`;
}

/**
 * The "All updates" list: every milestone, newest first (sortMilestones, so the list never depends on how the
 * index is ordered), with what each row shows. One milestone gives one row.
 */
export function historyRows(all: readonly ChangelogMilestone[], locale?: string): HistoryRow[] {
  return sortMilestones(all).map((m) => {
    const image = m.entries.find((e) => e.image)?.image;
    return {
      id: m.id,
      title: m.title,
      releasedAt: m.releasedAt,
      date: releaseDateLabel(m, locale),
      entryCount: m.entries.length,
      countLabel: changeCountLabel(m.entries.length),
      blurb: m.summary?.trim() || m.entries.map((e) => e.title).join(" · "),
      thumbnail: image ? { src: image.src, alt: image.alt } : null,
    };
  });
}

/** The row Up/Down/Home/End moves focus to from `i` of `n` (no wrap), or null when the key doesn't move it. */
export function rowForKey(key: string, i: number, n: number): number | null {
  if (n < 2) return null;
  const to = key === "ArrowDown" ? i + 1 : key === "ArrowUp" ? i - 1 : key === "Home" ? 0 : key === "End" ? n - 1 : null;
  if (to === null) return null;
  const next = clampSlide(to, n);
  return next === i ? null : next;
}
