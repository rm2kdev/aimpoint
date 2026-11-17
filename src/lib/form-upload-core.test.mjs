// Run with `pnpm test` (node --test; Node strips the TypeScript types of form-upload-core.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sniffImageType,
  checkFormImage,
  readCapped,
  rateWindow,
  retryAfter,
  resolveFormOptions,
  formImageName,
  FORM_IMAGE_MAX_BYTES,
  FORM_UPLOAD_BODY_MAX,
  UPLOAD_RATE_LIMITS,
} from "./form-upload-core.ts";

const bytes = (...parts) => {
  const out = [];
  for (const p of parts) out.push(...(typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p));
  return new Uint8Array(out);
};
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 13], "IHDR");
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0, 0, 16], "JFIF");
const GIF = bytes("GIF89a", [1, 0, 1, 0]);
const WEBP = bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 ");
const AVIF = bytes([0, 0, 0, 0x1c], "ftyp", "avif", [0, 0, 0, 0], "avifmif1miaf");
const AVIF_COMPAT = bytes([0, 0, 0, 0x18], "ftyp", "mif1", [0, 0, 0, 0], "miafavis");
const HEIC = bytes([0, 0, 0, 0x18], "ftyp", "heic", [0, 0, 0, 0], "mif1heic");
const SVG = bytes('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = bytes("<!doctype html><script>alert(1)</script>");

test("sniffImageType reads magic bytes", () => {
  assert.equal(sniffImageType(PNG), "image/png");
  assert.equal(sniffImageType(JPEG), "image/jpeg");
  assert.equal(sniffImageType(GIF), "image/gif");
  assert.equal(sniffImageType(WEBP), "image/webp");
  assert.equal(sniffImageType(AVIF), "image/avif");
  assert.equal(sniffImageType(AVIF_COMPAT), "image/avif");
});

test("sniffImageType refuses SVG, HTML, HEIC, truncated headers and empty input", () => {
  assert.equal(sniffImageType(SVG), null);
  assert.equal(sniffImageType(HTML), null);
  assert.equal(sniffImageType(HEIC), null);
  assert.equal(sniffImageType(PNG.subarray(0, 7)), null);
  assert.equal(sniffImageType(new Uint8Array(0)), null);
});

test("sniffImageType accepts a Node Buffer too", () => {
  assert.equal(sniffImageType(Buffer.from(PNG)), "image/png");
});

test("checkFormImage: type from bytes only, size capped, empty refused", () => {
  assert.deepEqual(checkFormImage(PNG), { ok: true, type: "image/png", ext: "png" });
  assert.deepEqual(checkFormImage(AVIF), { ok: true, type: "image/avif", ext: "avif" });
  assert.equal(checkFormImage(new Uint8Array(0)).status, 400);
  const svg = checkFormImage(SVG);
  assert.equal(svg.ok, false);
  assert.equal(svg.status, 400);
  const big = new Uint8Array(FORM_IMAGE_MAX_BYTES + 1);
  big.set(PNG);
  assert.equal(checkFormImage(big).status, 413);
  const edge = new Uint8Array(FORM_IMAGE_MAX_BYTES);
  edge.set(PNG);
  assert.equal(checkFormImage(edge).ok, true);
});

test("public limits are smaller than the 10 MB member limit and leave room for multipart headers", () => {
  assert.ok(FORM_IMAGE_MAX_BYTES < 10 * 1024 * 1024);
  assert.ok(FORM_UPLOAD_BODY_MAX > FORM_IMAGE_MAX_BYTES);
  assert.ok(FORM_UPLOAD_BODY_MAX - FORM_IMAGE_MAX_BYTES <= 64 * 1024);
});

const stream = (chunks) => {
  let pulled = 0;
  let cancelled = false;
  const s = new ReadableStream({
    pull(ctrl) {
      if (pulled < chunks.length) ctrl.enqueue(chunks[pulled++]);
      else ctrl.close();
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { s, pulled: () => pulled, cancelled: () => cancelled };
};

test("readCapped returns the whole body within the cap", async () => {
  const { s } = stream([new Uint8Array([1, 2]), new Uint8Array([3])]);
  assert.deepEqual([...(await readCapped(s, null, 3))], [1, 2, 3]);
  assert.deepEqual([...(await readCapped(null, null, 3))], []);
});

test("readCapped refuses a declared oversize body without reading", async () => {
  const st = stream([new Uint8Array(1)]);
  assert.equal(await readCapped(st.s, "11", 10), null);
  assert.equal(st.pulled(), 0);
});

test("readCapped stops and cancels once the bytes sent pass the cap, whatever content-length said", async () => {
  const st = stream([new Uint8Array(6), new Uint8Array(6), new Uint8Array(6)]);
  assert.equal(await readCapped(st.s, "4", 10), null);
  assert.equal(st.cancelled(), true);
  assert.ok(st.pulled() < 3);
});

test("rateWindow and retryAfter: fixed windows, Retry-After at least 1 s and never past the window", () => {
  const lim = UPLOAD_RATE_LIMITS.ipForm;
  assert.equal(lim.max, 20);
  assert.equal(lim.windowMs, 10 * 60_000);
  assert.equal(UPLOAD_RATE_LIMITS.form.max, 200);
  assert.equal(UPLOAD_RATE_LIMITS.form.windowMs, 60 * 60_000);
  const now = Date.UTC(2026, 10, 18, 12, 3, 30);
  const w = rateWindow(now, lim);
  assert.equal(w.start, Date.UTC(2026, 10, 18, 12, 0, 0));
  assert.equal(w.end, Date.UTC(2026, 10, 18, 12, 10, 0));
  assert.equal(retryAfter(20, now, lim), null);
  assert.equal(retryAfter(21, now, lim), 390);
  assert.equal(retryAfter(21, w.end - 1, lim), 1);
});

test("resolveFormOptions: both default false, images need rich text", () => {
  assert.deepEqual(resolveFormOptions({}), { richText: false, allowImages: false });
  assert.deepEqual(resolveFormOptions({ richText: true }), { richText: true, allowImages: false });
  assert.deepEqual(resolveFormOptions({ richText: true, allowImages: true }), { richText: true, allowImages: true });
  assert.match(resolveFormOptions({ allowImages: true }), /need rich text/);
  assert.match(resolveFormOptions({ richText: false, allowImages: true }, { richText: true, allowImages: true }), /need rich text/);
});

test("resolveFormOptions: left-out fields keep saved values; rich text off drops images", () => {
  const saved = { richText: true, allowImages: true };
  assert.deepEqual(resolveFormOptions({}, saved), saved);
  assert.deepEqual(resolveFormOptions({ allowImages: false }, saved), { richText: true, allowImages: false });
  assert.deepEqual(resolveFormOptions({ richText: false }, saved), { richText: false, allowImages: false });
  assert.deepEqual(resolveFormOptions({ allowImages: true }, { richText: true, allowImages: false }), saved);
});

test("resolveFormOptions refuses non-booleans", () => {
  assert.match(resolveFormOptions({ richText: "yes" }), /richText/);
  assert.match(resolveFormOptions({ allowImages: 1 }), /allowImages/);
  assert.match(resolveFormOptions({ richText: null }), /richText/);
});

test("formImageName keeps the SAFE_NAME shape and rejects anything else", () => {
  const name = "6af98310a81f713925ea19bc-AbCdEfGh_jKlMn-1.png";
  assert.equal(formImageName(`/api/uploads/${name}`), name);
  assert.equal(formImageName(`https://x.public.blob.vercel-storage.com/uploads/${name}?v=1`), name);
  assert.equal(formImageName("/api/uploads/avatar-6af98310a81f713925ea19bc-aaaaaaaaaaaaaaaaaaaaa.png"), null);
  assert.equal(formImageName("/api/uploads/6af98310a81f713925ea19bc-AbCdEfGh_jKlMn-1.svg"), null);
  assert.equal(formImageName("/api/uploads/../../etc/passwd"), null);
});
