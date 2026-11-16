// Run with `pnpm test` (node --test; Node strips the TypeScript types of analytics-time.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { bucketStart, bucketStarts, nextBucketStart, isTimeZone, MAX_ANALYTICS_BUCKETS } from "./analytics-time.ts";

const iso = (d) => d.toISOString();

test("a task created 23:30 AWST lands on that AWST day", () => {
  // 2026-11-16 23:30 AWST = 2026-11-16 15:30 UTC
  const at = new Date("2026-11-16T15:30:00Z");
  assert.equal(iso(bucketStart(at, "day", "Australia/Perth")), "2026-11-15T16:00:00.000Z"); // 16 Nov 00:00 AWST
  // ... and 00:30 AWST the next day is the next bucket
  assert.equal(iso(bucketStart(new Date("2026-11-16T16:30:00Z"), "day", "Australia/Perth")), "2026-11-16T16:00:00.000Z");
  // In UTC the same instant would be on the 16th too, but 01:00 AWST on the 17th is the 16th in UTC
  assert.equal(iso(bucketStart(new Date("2026-11-16T17:00:00Z"), "day", "UTC")), "2026-11-16T00:00:00.000Z");
});

test("weeks start on Monday, months on the 1st, local time", () => {
  // Wed 18 Nov 2026 10:00 AWST
  const at = new Date("2026-11-18T02:00:00Z");
  assert.equal(iso(bucketStart(at, "week", "Australia/Perth")), "2026-11-15T16:00:00.000Z"); // Mon 16 Nov 00:00 AWST
  // Sunday 22 Nov 23:59 AWST still in that week
  assert.equal(iso(bucketStart(new Date("2026-11-22T15:59:00Z"), "week", "Australia/Perth")), "2026-11-15T16:00:00.000Z");
  assert.equal(iso(bucketStart(at, "month", "Australia/Perth")), "2026-10-31T16:00:00.000Z"); // 1 Nov 00:00 AWST
  assert.equal(iso(nextBucketStart(new Date("2026-12-31T16:00:00Z"), "month", "Australia/Perth")), "2027-01-31T16:00:00.000Z");
  assert.equal(iso(bucketStart(at, "hour", "Australia/Perth")), "2026-11-18T02:00:00.000Z");
});

test("DST zones: days stay local midnight across the change", () => {
  // Sydney moves to AEDT (+11) on Sun 4 Oct 2026 at 02:00
  const days = bucketStarts(new Date("2026-10-02T14:00:00Z"), new Date("2026-10-05T13:00:00Z"), "day", "Australia/Sydney");
  assert.deepEqual(days.map(iso), ["2026-10-02T14:00:00.000Z", "2026-10-03T14:00:00.000Z", "2026-10-04T13:00:00.000Z"]);
});

test("empty buckets are filled and the first bucket covers `from`", () => {
  const b = bucketStarts(new Date("2026-11-10T05:00:00Z"), new Date("2026-11-17T05:00:00Z"), "day", "Australia/Perth");
  assert.equal(b.length, 8); // 10 Nov 13:00 AWST .. 17 Nov 13:00 AWST touches 8 local days
  assert.equal(iso(b[0]), "2026-11-09T16:00:00.000Z");
  for (let i = 1; i < b.length; i++) assert.equal(b[i] - b[i - 1], 86_400_000);
  assert.equal(bucketStarts(new Date("2026-08-19T16:00:00Z"), new Date("2026-11-17T16:00:00Z"), "hour", "Australia/Perth").length, 90 * 24);
  assert.throws(() => bucketStarts(new Date("2020-01-01Z"), new Date("2026-01-01Z"), "hour", "UTC"), RangeError);
  assert.ok(MAX_ANALYTICS_BUCKETS >= 90 * 24);
});

test("timezone validation", () => {
  assert.equal(isTimeZone("Australia/Perth"), true);
  assert.equal(isTimeZone("Mars/Olympus"), false);
  assert.equal(isTimeZone(""), false);
});
