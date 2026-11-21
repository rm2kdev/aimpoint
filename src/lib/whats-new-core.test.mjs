// Run with `pnpm test` (node --test). "What's new" pop-up helpers (VEC-374): slide clamp, key stepping, the
// milestone's lightbox gallery, the release date line and the slide announcement; history rows (VEC-377).
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// whats-new-core imports changelog-core with the app's extensionless specifier; let node resolve it to the .ts file.
// Registered before the dynamic import below (a static import would be hoisted above the hook).
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (err) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context);
      throw err;
    }
  },
});
const {
  changeCountLabel,
  clampSlide,
  historyRows,
  milestoneGallery,
  parseWhatsNewParam,
  releaseDateLabel,
  rowForKey,
  slideAnnouncement,
  slideForKey,
  WHATS_NEW_PARAM,
  whatsNewBadge,
  whatsNewBadgeLabel,
  withoutWhatsNewParam,
} = await import("./whats-new-core.ts");

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

const ms = (id, entries, extra = {}) => ({ id, title: `Release ${id}`, releasedAt: `${id.slice(0, 10)}T09:00:00+08:00`, entries, ...extra });

test("historyRows lists every milestone newest first, whatever the input order", () => {
  const a = ms("2026-10-01", [{ title: "A", body: "a" }]);
  const b = ms("2026-11-21", [{ title: "B1", body: "b" }, { title: "B2", body: "b", image: { src: "/changelog/2026-11-21/x.webp", alt: "X" } }]);
  const c = ms("2026-11-21-hotfix", [{ title: "C", body: "c" }], { releasedAt: "2026-11-21T15:00:00+08:00", summary: "  Fixes.  " });
  const rows = historyRows([a, c, b], "en-AU");
  assert.deepEqual(rows.map((r) => r.id), ["2026-11-21-hotfix", "2026-11-21", "2026-10-01"]);
  assert.equal(rows[1].entryCount, 2);
  assert.equal(rows[1].countLabel, "2 changes");
  assert.equal(rows[1].date, "21 November 2026");
  // The first screenshot in entry order is the thumbnail; none = null.
  assert.deepEqual(rows[1].thumbnail, { src: "/changelog/2026-11-21/x.webp", alt: "X" });
  assert.equal(rows[0].thumbnail, null);
  // The summary when there is one (trimmed), otherwise the entry titles.
  assert.equal(rows[0].blurb, "Fixes.");
  assert.equal(rows[1].blurb, "B1 · B2");
});

test("historyRows with one milestone gives one row, and none gives none", () => {
  const rows = historyRows([ms("2026-11-21", [{ title: "Only", body: "x" }])]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].countLabel, "1 change");
  assert.deepEqual(historyRows([]), []);
});

test("changeCountLabel and rowForKey", () => {
  assert.equal(changeCountLabel(0), "0 changes");
  assert.equal(changeCountLabel(1), "1 change");
  assert.equal(changeCountLabel(7), "7 changes");
  assert.equal(rowForKey("ArrowDown", 0, 3), 1);
  assert.equal(rowForKey("ArrowUp", 2, 3), 1);
  assert.equal(rowForKey("Home", 2, 3), 0);
  assert.equal(rowForKey("End", 0, 3), 2);
  assert.equal(rowForKey("ArrowDown", 2, 3), null);
  assert.equal(rowForKey("ArrowUp", 0, 3), null);
  assert.equal(rowForKey("ArrowDown", 0, 1), null);
  assert.equal(rowForKey("Enter", 0, 3), null);
});

test("parseWhatsNewParam: all opens the list, a shipped id its tour, anything else falls back to the list", () => {
  const ids = ["2026-11-21", "2026-11-14-forms"];
  assert.equal(WHATS_NEW_PARAM, "whats-new");
  assert.deepEqual(parseWhatsNewParam("all", ids), { view: "history" });
  assert.deepEqual(parseWhatsNewParam("ALL", ids), { view: "history" });
  assert.deepEqual(parseWhatsNewParam("", ids), { view: "history" });
  assert.deepEqual(parseWhatsNewParam("2026-11-21", ids), { view: "tour", id: "2026-11-21" });
  assert.deepEqual(parseWhatsNewParam(" 2026-11-14-forms ", ids), { view: "tour", id: "2026-11-14-forms" });
  assert.deepEqual(parseWhatsNewParam("2020-01-01", ids), { view: "history" });
  assert.deepEqual(parseWhatsNewParam("<script>", ids), { view: "history" });
  // No parameter, or nothing shipped: nothing to open.
  assert.equal(parseWhatsNewParam(null, ids), null);
  assert.equal(parseWhatsNewParam(undefined, ids), null);
  assert.equal(parseWhatsNewParam("all", []), null);
});

test("withoutWhatsNewParam strips only the deep link and keeps the rest in order", () => {
  assert.equal(withoutWhatsNewParam("?whats-new=all"), "");
  assert.equal(withoutWhatsNewParam("whats-new=all"), "");
  assert.equal(withoutWhatsNewParam(""), "");
  assert.equal(withoutWhatsNewParam("?task=VEC-1&whats-new=2026-11-21&view=list"), "?task=VEC-1&view=list");
  assert.equal(withoutWhatsNewParam("?whats-new=all&whats-new=x&q=a+b"), "?q=a+b");
  assert.equal(withoutWhatsNewParam("?task=VEC-1"), "?task=VEC-1");
});

test("whatsNewBadge: nothing for 0, New for 1, the number up to 9, 9+ above (VEC-388)", () => {
  assert.equal(whatsNewBadge(0), null);
  assert.equal(whatsNewBadge(1), "New");
  assert.equal(whatsNewBadge(2), "2");
  assert.equal(whatsNewBadge(9), "9");
  assert.equal(whatsNewBadge(10), "9+");
  assert.equal(whatsNewBadge(-3), null);
  assert.equal(whatsNewBadge(Number.NaN), null);
});

test("whatsNewBadgeLabel: singular, plural with the real count, null for 0 (VEC-388)", () => {
  assert.equal(whatsNewBadgeLabel(0), null);
  assert.equal(whatsNewBadgeLabel(1), "1 new update");
  assert.equal(whatsNewBadgeLabel(2), "2 new updates");
  assert.equal(whatsNewBadgeLabel(9), "9 new updates");
  assert.equal(whatsNewBadgeLabel(10), "10 new updates");
});
