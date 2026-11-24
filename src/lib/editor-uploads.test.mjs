// Run with `pnpm test` (node --test). Editor images that show at once: no blob: preview is ever saved (VEC-455).
import { test } from "node:test";
import assert from "node:assert/strict";

const { previewImages, hasPreviewImages, resolvePreviewImages, withoutPreviewImages, isPreviewUrl } = await import("./editor-uploads-core.ts");

const A = "blob:http://10.0.0.2:3000/1b9a8c2e-0000-4000-8000-000000000001";
const B = "blob:http://10.0.0.2:3000/1b9a8c2e-0000-4000-8000-000000000002";
const stored = { [A]: "/api/uploads/org-a.png", [B]: "/api/uploads/org-b.png" };

test("finds preview images, in order, once each", () => {
  const html = `<p>x</p><img src="${A}" alt="a.png"><img src="/api/uploads/old.png"><img alt="b" src='${B}'><img src="${A}">`;
  assert.deepEqual(previewImages(html), [A, B]);
  assert.equal(hasPreviewImages(html), true);
  assert.equal(hasPreviewImages("<p>no images</p><img src=\"/api/uploads/x.png\">"), false);
  assert.equal(hasPreviewImages(""), false);
  assert.equal(hasPreviewImages(null), false);
  assert.equal(isPreviewUrl(" BLOB:http://x/y"), true);
  assert.equal(isPreviewUrl("https://x/blob:y"), false);
});

test("text with no preview images comes back unchanged", () => {
  const html = "<p>hello</p><img src=\"/api/uploads/x.png\" alt=\"x\"><p></p>";
  assert.equal(resolvePreviewImages(html, () => "/nope"), html);
  assert.equal(withoutPreviewImages(html), html);
});

test("swaps every preview for its stored URL, keeping the other attributes", () => {
  const html = `<p>Before</p><img src="${A}" alt="a.png"><p>mid</p><img alt="b.png" src="${B}"><p>after</p>`;
  const out = resolvePreviewImages(html, (p) => stored[p] ?? null);
  assert.equal(out, `<p>Before</p><img src="/api/uploads/org-a.png" alt="a.png"><p>mid</p><img alt="b.png" src="/api/uploads/org-b.png"><p>after</p>`);
  assert.equal(hasPreviewImages(out), false);
});

test("a failed or unknown preview is dropped, never sent as blob:", () => {
  const html = `<p>t</p><img src="${A}" alt="a.png"><img src="${B}" alt="b.png"><p>end</p>`;
  const out = resolvePreviewImages(html, (p) => (p === A ? stored[A] : null));
  assert.equal(out, `<p>t</p><img src="/api/uploads/org-a.png" alt="a.png"><p>end</p>`);
  assert.ok(!out.includes("blob:"));
});

test("a lookup that answers with another blob: URL still never leaks one", () => {
  const out = resolvePreviewImages(`<img src="${A}">`, () => B);
  assert.equal(out, "");
});

test("withoutPreviewImages: what a new task is created with before uploads land", () => {
  const html = `<p>Steps</p><img src="${A}" alt="shot.png"><p></p>`;
  assert.equal(withoutPreviewImages(html), "<p>Steps</p>");
  assert.equal(withoutPreviewImages(`<img src="${A}"><p></p>`), "");
  // Stored images and the user's own empty lines in the middle stay.
  assert.equal(withoutPreviewImages(`<p>a</p><p></p><img src="/api/uploads/k.png"><img src="${B}"><p>b</p>`), `<p>a</p><p></p><img src="/api/uploads/k.png"><p>b</p>`);
});

test("stored URLs with quotes are escaped in the src attribute", () => {
  const out = resolvePreviewImages(`<img src="${A}">`, () => '/api/uploads/a"b.png');
  assert.equal(out, '<img src="/api/uploads/a&quot;b.png">');
});
