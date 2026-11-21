// Run with `pnpm test` (node --test). "What's new" pop-up helpers (VEC-374): slide clamp, key stepping, the
// milestone's lightbox gallery, the release date line and the slide announcement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clampSlide, milestoneGallery, releaseDateLabel, slideAnnouncement, slideForKey } from "./whats-new-core.ts";

test("clampSlide keeps the slide inside the tour and never wraps", () => {
  assert.equal(clampSlide(-1, 4), 0);
  assert.equal(clampSlide(0, 4), 0);
  assert.equal(clampSlide(3, 4), 3);
  assert.equal(clampSlide(4, 4), 3);
  assert.equal(clampSlide(9, 4), 3);
  assert.equal(clampSlide(2.7, 4), 2);
  assert.equal(clampSlide(NaN, 4), 0);
  assert.equal(clampSlide(3, 0), 0);
});

test("slideForKey steps with the arrows, jumps with Home/End and ignores other keys", () => {
  assert.equal(slideForKey("ArrowRight", 0, 3), 1);
  assert.equal(slideForKey("ArrowLeft", 2, 3), 1);
  assert.equal(slideForKey("Home", 2, 3), 0);
  assert.equal(slideForKey("End", 0, 3), 2);
  // At the ends nothing moves (so the key isn't swallowed for nothing).
  assert.equal(slideForKey("ArrowRight", 2, 3), null);
  assert.equal(slideForKey("ArrowLeft", 0, 3), null);
  assert.equal(slideForKey("Home", 0, 3), null);
  assert.equal(slideForKey("End", 2, 3), null);
  // One slide, or a key that isn't a slide key.
  assert.equal(slideForKey("ArrowRight", 0, 1), null);
  assert.equal(slideForKey("Enter", 0, 3), null);
  assert.equal(slideForKey("j", 0, 3), null);
});

test("milestoneGallery lists screenshots in entry order and maps each entry to its image", () => {
  const g = milestoneGallery({
    entries: [
      { title: "A", body: "a", image: { src: "/changelog/x/a.png", alt: "Alpha" } },
      { title: "B", body: "b" },
      { title: "C", body: "c", image: { src: "/changelog/x/c.webp", alt: "Gamma" } },
    ],
  });
  assert.deepEqual(g.images, [
    { src: "/changelog/x/a.png", alt: "Alpha" },
    { src: "/changelog/x/c.webp", alt: "Gamma" },
  ]);
  assert.deepEqual(g.indexOf, [0, -1, 1]);
  assert.deepEqual(milestoneGallery({ entries: [{ title: "T", body: "t" }] }), { images: [], indexOf: [-1] });
});

test("releaseDateLabel reads the id's date, the same day in every time zone", () => {
  const m = { id: "2026-11-21", releasedAt: "2026-11-21T00:30:00+08:00" }; // 20 Nov in UTC
  assert.equal(releaseDateLabel(m, "en-AU"), "21 November 2026");
  assert.equal(releaseDateLabel({ id: "2026-01-05-hotfix", releasedAt: "2026-01-05T09:00:00+08:00" }, "en-US"), "January 5, 2026");
  assert.equal(releaseDateLabel({ id: "nope", releasedAt: "also nope" }, "en-AU"), "");
});

test("slideAnnouncement names the position and the entry", () => {
  assert.equal(slideAnnouncement(1, 5, "Zoom into images"), "Change 2 of 5: Zoom into images");
  assert.equal(slideAnnouncement(0, 1, "Only one"), "Only one");
});
