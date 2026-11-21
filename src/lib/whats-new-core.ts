// Pure helpers for the "What's new" pop-up (VEC-374): slide stepping, the milestone's lightbox gallery, the
// release date line and the screen-reader announcement. No DOM or React, so `pnpm test` (node --test) covers it.
// The milestone model and who-sees-what rules live in lib/changelog-core.ts (VEC-373); docs/changelog.md.

import type { ChangelogMilestone } from "./changelog-core";
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
