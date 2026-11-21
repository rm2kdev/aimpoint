// Run with `pnpm test` (node --test; Node strips the TypeScript types of task-intake-core.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INTAKE_ERRORS,
  INTAKE_LIMITS,
  TASK_TITLE_MAX,
  TASK_DESCRIPTION_MAX,
  DESCRIPTION_HTML_MAX,
  DESCRIPTION_IMAGES_MAX,
  normalizeTitle,
  normalizeSubmitter,
  resolveType,
  resolveStatus,
  prepareDescription,
  keepImages,
} from "./task-intake-core.ts";

const TYPES = ["issue", "feature", "task"];

test("one set of limits", () => {
  assert.equal(TASK_TITLE_MAX, 300);
  assert.equal(TASK_DESCRIPTION_MAX, 10_000);
  assert.deepEqual(INTAKE_LIMITS, { title: 300, description: 10_000, descriptionHtml: DESCRIPTION_HTML_MAX, images: DESCRIPTION_IMAGES_MAX, name: 100, email: 200 });
});

test("normalizeTitle trims, requires and caps", () => {
  assert.deepEqual(normalizeTitle("  Fix login  "), { ok: true, title: "Fix login" });
  for (const bad of ["", "   ", undefined, null, 42, {}]) assert.deepEqual(normalizeTitle(bad), { ok: false, error: "Give it a title." });
  assert.deepEqual(normalizeTitle("x".repeat(300)), { ok: true, title: "x".repeat(300) });
  assert.deepEqual(normalizeTitle(" " + "x".repeat(301) + " "), { ok: false, error: "Keep the title under 300 characters (it's 301)." });
  assert.equal(INTAKE_ERRORS.titleTooLong(1234), "Keep the title under 300 characters (it's 1,234).");
});

test("resolveType: fallback when empty, allowed only, never rewritten", () => {
  assert.deepEqual(resolveType(undefined, TYPES, "issue"), { ok: true, type: "issue" });
  assert.deepEqual(resolveType(null, TYPES, "feature"), { ok: true, type: "feature" });
  assert.deepEqual(resolveType("", TYPES, "task"), { ok: true, type: "task" });
  assert.deepEqual(resolveType("feature", TYPES, "issue"), { ok: true, type: "feature" });
  assert.deepEqual(resolveType("bug", TYPES, "issue"), { ok: false, error: "Pick one of the listed types." });
  assert.deepEqual(resolveType(["issue"], TYPES, "issue"), { ok: false, error: "Pick one of the listed types." });
  // A choose form allowing only some types.
  assert.deepEqual(resolveType("task", ["issue", "feature"], "issue"), { ok: false, error: "Pick one of the listed types." });
});

test("resolveStatus: first is the default, others must be allowed", () => {
  const allowed = ["a1", "b2"];
  assert.deepEqual(resolveStatus(undefined, allowed), { ok: true, id: "a1" });
  assert.deepEqual(resolveStatus("", allowed), { ok: true, id: "a1" });
  assert.deepEqual(resolveStatus("b2", allowed), { ok: true, id: "b2" });
  assert.deepEqual(resolveStatus("zz", allowed), { ok: false, error: "Pick one of the listed statuses." });
  assert.deepEqual(resolveStatus(7, allowed), { ok: false, error: "Pick one of the listed statuses." });
  assert.deepEqual(resolveStatus("a1", []), { ok: false, error: "This project isn't taking new tickets." });
});

test("normalizeSubmitter trims, lowercases and checks", () => {
  assert.deepEqual(normalizeSubmitter("  Ana ", " Ana@Example.COM "), { ok: true, name: "Ana", email: "ana@example.com" });
  assert.deepEqual(normalizeSubmitter("", null), { ok: true, name: null, email: null });
  assert.deepEqual(normalizeSubmitter("x".repeat(101), ""), { ok: false, error: "Keep your name under 100 characters." });
  assert.deepEqual(normalizeSubmitter("", "a@b." + "c".repeat(200)), { ok: false, error: "Keep your email under 200 characters." });
  assert.deepEqual(normalizeSubmitter("", "not-an-email"), { ok: false, error: "That email address doesn't look right." });
});

test("prepareDescription plain text: normalised line endings, capped", () => {
  assert.deepEqual(prepareDescription("a\r\nb\rc", { rich: false }), { ok: true, rich: false, text: "a\nb\nc", textLength: 5 });
  assert.deepEqual(prepareDescription(undefined, { rich: false }), { ok: true, rich: false, text: "", textLength: 0 });
  assert.equal(prepareDescription("x".repeat(10_000), { rich: false }).ok, true);
  assert.deepEqual(prepareDescription("x".repeat(10_001), { rich: false }), { ok: false, error: "Keep the description under 10,000 characters (it's 10,001)." });
  assert.deepEqual(prepareDescription(5, { rich: false }), { ok: false, error: INTAKE_ERRORS.descriptionNotText });
  assert.deepEqual(prepareDescription({}, { rich: true }), { ok: false, error: INTAKE_ERRORS.descriptionNotText });
});

test("prepareDescription rich: public allow-list, images only when allowed", () => {
  const raw = '<p onclick="x()">Hi <script>evil()</script><img src="/api/uploads/a.png"><a href="https://x.dev">l</a></p>';
  const noImg = prepareDescription(raw, { rich: true });
  assert.equal(noImg.ok && noImg.rich, true);
  assert.doesNotMatch(noImg.html, /<img|script|onclick/);
  assert.match(noImg.html, /rel="noopener noreferrer nofollow"/);
  assert.deepEqual(noImg.sources, []);
  // First pass with images on: sources listed for the pending-upload lookup.
  const first = prepareDescription(raw, { rich: true, allowImages: true });
  assert.deepEqual(first.sources, ["/api/uploads/a.png"]);
  assert.match(first.html, /<img src="\/api\/uploads\/a.png" \/>/);
  // With imageAllowed: only accepted sources stay.
  const own = prepareDescription(raw + '<img src="https://evil.example/x.png">', { rich: true, allowImages: true, imageAllowed: (s) => s === "/api/uploads/a.png" });
  assert.deepEqual(own.sources, ["/api/uploads/a.png"]);
  assert.doesNotMatch(own.html, /<img[^>]*evil/);
  // keepImages is the same second pass for the two-step (form) flow.
  assert.equal(keepImages(first.html, () => false).includes("<img"), false);
});

test("prepareDescription rich: size limits", () => {
  const huge = "<p>" + "x".repeat(DESCRIPTION_HTML_MAX) + "</p>";
  assert.deepEqual(prepareDescription(huge, { rich: true }), { ok: false, error: INTAKE_ERRORS.descriptionTooMuchFormatting });
  const long = "<p>" + "y".repeat(10_001) + "</p>";
  assert.deepEqual(prepareDescription(long, { rich: true }), { ok: false, error: "Keep the description under 10,000 characters (it's 10,001)." });
  const imgs = Array.from({ length: 11 }, (_, i) => `<img src="https://a.dev/${i}.png">`).join("");
  assert.deepEqual(prepareDescription(imgs, { rich: true, allowImages: true }), { ok: false, error: "Add at most 10 images (there are 11)." });
  // Without images allowed the same input is fine (they're dropped).
  assert.equal(prepareDescription(imgs, { rich: true }).ok, true);
  // Markdown images typed as text are removed.
  const md = prepareDescription("<p>see ![x](https://evil.example/a.png) here</p>", { rich: true });
  assert.doesNotMatch(md.html, /evil/);
});
