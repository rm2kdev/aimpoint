// Run with `pnpm test` (node --test). Changelog core (VEC-373): ordering, who sees which milestone, the forward-only
// seen marker, milestone validation, and validation of the milestones actually shipped in src/content/changelog/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import {
  latestMilestone,
  milestoneImages,
  nextSeenMarker,
  shouldShowChangelog,
  sortMilestones,
  unseenMilestones,
  validateMilestone,
  validateMilestones,
} from "./changelog-core.ts";

// The content modules use the app's extensionless imports (`./2026-11-21`); let node resolve them to .ts files.
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

const entry = (title, image) => ({ title, body: `${title} body.`, ...(image ? { image } : {}) });
const m = (id, releasedAt = `${id.slice(0, 10)}T09:00:00+08:00`, extra = {}) => ({
  id,
  title: `Release ${id}`,
  releasedAt,
  entries: [entry("One")],
  ...extra,
});

const nov = m("2026-11-21");
const dec = m("2026-12-05");
const decHotfix = m("2026-12-05-hotfix", "2026-12-05T15:00:00+08:00");
const all = [decHotfix, dec, nov];

test("sortMilestones and latestMilestone: newest first by releasedAt, then id", () => {
  assert.deepEqual(sortMilestones([nov, decHotfix, dec]).map((x) => x.id), ["2026-12-05-hotfix", "2026-12-05", "2026-11-21"]);
  assert.equal(latestMilestone([nov, dec]).id, "2026-12-05");
  assert.equal(latestMilestone([]), null);
  const sameTime = [m("2026-12-05", "2026-12-05T09:00:00+08:00"), m("2026-12-05-b", "2026-12-05T09:00:00+08:00")];
  assert.equal(latestMilestone(sameTime).id, "2026-12-05-b");
});

test("existing accounts with no marker see the newest milestone once", () => {
  const before = new Date("2026-01-01T00:00:00Z");
  assert.deepEqual(unseenMilestones(all, undefined, before).map((x) => x.id), ["2026-12-05-hotfix", "2026-12-05", "2026-11-21"]);
  assert.equal(shouldShowChangelog(all, null, before).id, "2026-12-05-hotfix");
  assert.equal(shouldShowChangelog([nov], undefined, before).id, "2026-11-21");
  // After dismissing the newest, nothing is left (older ones are covered by the marker).
  assert.equal(shouldShowChangelog(all, "2026-12-05-hotfix", before), null);
  assert.deepEqual(unseenMilestones(all, "2026-11-21", before).map((x) => x.id), ["2026-12-05-hotfix", "2026-12-05"]);
});

test("new signups never get milestones released before they joined", () => {
  const joined = new Date("2026-11-25T00:00:00Z");
  assert.deepEqual(unseenMilestones(all, null, joined).map((x) => x.id), ["2026-12-05-hotfix", "2026-12-05"]);
  assert.equal(shouldShowChangelog([nov], null, joined), null);
  // Joined the same day, after the release time: still old news.
  assert.equal(shouldShowChangelog([nov], null, "2026-11-21T10:00:00+08:00"), null);
  assert.equal(shouldShowChangelog([nov], null, "2026-11-21T08:00:00+08:00").id, "2026-11-21");
  // Stamped at signup (changelogSeen = latest then): a later release still shows.
  assert.equal(shouldShowChangelog(all, "2026-11-21", joined).id, "2026-12-05-hotfix");
  // No usable createdAt = no signup filter.
  assert.equal(shouldShowChangelog([nov], null, null).id, "2026-11-21");
  assert.equal(shouldShowChangelog([nov], null, "not a date").id, "2026-11-21");
});

test("a marker for a milestone that was since removed still hides everything at or before it", () => {
  assert.deepEqual(unseenMilestones([dec, nov], "2026-11-30", null).map((x) => x.id), ["2026-12-05"]);
});

test("nextSeenMarker moves forward only and ignores unknown ids", () => {
  assert.equal(nextSeenMarker(all, undefined, "2026-11-21"), "2026-11-21");
  assert.equal(nextSeenMarker(all, "2026-11-21", "2026-12-05"), "2026-12-05");
  assert.equal(nextSeenMarker(all, "2026-12-05", "2026-12-05"), "2026-12-05"); // twice = no-op
  assert.equal(nextSeenMarker(all, "2026-12-05", "2026-11-21"), "2026-12-05"); // older = no-op
  assert.equal(nextSeenMarker(all, "2026-12-05", "2026-12-05-hotfix"), "2026-12-05-hotfix");
  assert.equal(nextSeenMarker(all, "2026-11-21", "2099-01-01"), "2026-11-21"); // unknown = no-op
  assert.equal(nextSeenMarker(all, null, "nope"), null);
});

test("validateMilestone accepts a well-formed milestone", () => {
  const ok = m("2026-11-21", undefined, {
    summary: "Short summary.",
    entries: [entry("A", { src: "/changelog/2026-11-21/a.png", alt: "The new pane" }), entry("B")],
  });
  assert.deepEqual(validateMilestone(ok), []);
  assert.deepEqual(validateMilestones(all), []);
  assert.deepEqual(validateMilestones([]), []);
});

test("validateMilestone rejects bad ids, titles, dates and empty entries", () => {
  const has = (x, re) => assert.ok(validateMilestone(x).some((e) => re.test(e)), `${JSON.stringify(x)} -> ${validateMilestone(x)}`);
  has(m("21-11-2026", "2026-11-21T00:00:00Z"), /id must look like/);
  has(m("2026-11-21-Big Release", "2026-11-21T00:00:00Z"), /id must look like/);
  has({ ...nov, title: " " }, /title is empty/);
  has({ ...nov, releasedAt: "soon" }, /releasedAt is not an ISO date/);
  has({ ...nov, releasedAt: "2026-11-22T00:00:00+08:00" }, /should start with the id's date/);
  has({ ...nov, summary: "" }, /summary is empty/);
  has({ ...nov, entries: [] }, /at least one entry/);
  has({ ...nov, entries: undefined }, /at least one entry/);
  has({ ...nov, entries: [{ title: "", body: "x" }] }, /entry 1: title is empty/);
  has({ ...nov, entries: [entry("A"), { title: "B", body: "" }] }, /entry 2: body is empty/);
});

test("validateMilestone rejects images outside the milestone's folder and images without alt text", () => {
  const img = (src, alt = "Alt") => ({ ...nov, entries: [entry("A", { src, alt })] });
  const bad = (x, re) => assert.ok(validateMilestone(x).some((e) => re.test(e)), `${JSON.stringify(x.entries)} -> ${validateMilestone(x)}`);
  bad(img("/images/a.png"), /under \/changelog\/2026-11-21\//);
  bad(img("https://example.com/a.png"), /under \/changelog\/2026-11-21\//);
  bad(img("/changelog/2026-12-05/a.png"), /under \/changelog\/2026-11-21\//); // another milestone's folder
  bad(img("/changelog/2026-11-21/"), /under/);
  bad(img("/changelog/2026-11-21/../x.png"), /under/);
  bad(img("/changelog/2026-11-21/a.png?v=2"), /under/);
  bad(img("/changelog/2026-11-21/a.svg"), /png, jpg, webp, gif or avif/);
  bad(img("/changelog/2026-11-21/a.png", ""), /alt text is missing/);
  bad(img("/changelog/2026-11-21/a.png", "  "), /alt text is missing/);
  bad({ ...nov, entries: [{ title: "A", body: "B", image: { src: "/changelog/2026-11-21/a.png" } }] }, /alt text is missing/);
});

test("validateMilestones rejects duplicate ids and a list that isn't newest first", () => {
  assert.ok(validateMilestones([nov, nov]).some((e) => /listed twice/.test(e)));
  assert.ok(validateMilestones([nov, dec]).some((e) => /newest first/.test(e)));
  assert.ok(validateMilestones([dec, decHotfix]).some((e) => /newest first/.test(e)));
  // id order and releasedAt order must agree.
  const early = m("2026-12-05-b", "2026-12-05T01:00:00+08:00");
  assert.ok(validateMilestones([early, dec]).some((e) => /newest first/.test(e)));
});

test("shipped milestones (src/content/changelog) are valid and their screenshots exist", async () => {
  const { MILESTONES } = await import("../content/changelog/index.ts");
  assert.ok(Array.isArray(MILESTONES));
  assert.deepEqual(validateMilestones(MILESTONES), []);
  const publicDir = fileURLToPath(new URL("../../public", import.meta.url));
  for (const src of milestoneImages(MILESTONES)) {
    assert.ok(existsSync(`${publicDir}${decodeURI(src)}`), `missing screenshot public${src}`);
  }
  // Every milestone module in the folder is listed in the index (a forgotten import would never ship).
  const dir = fileURLToPath(new URL("../content/changelog/", import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "index.ts").map((f) => f.replace(/\.ts$/, ""));
  assert.deepEqual(files.sort(), MILESTONES.map((x) => x.id).sort(), "each src/content/changelog/<id>.ts must be listed in index.ts (and named after its id)");
});
