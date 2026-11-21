// Run with `pnpm test` (node --test). Image lightbox helpers (VEC-334): zoom clamp, zoom about a point, pan bounds,
// wheel factor, index wrap, swipe direction and collecting images from stored description/comment HTML.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FIT,
  MAX_ZOOM,
  clampPan,
  clampZoom,
  collectImages,
  swipeStep,
  wheelZoomFactor,
  wrapIndex,
  zoomAt,
} from "./image-lightbox-core.ts";

const base = { w: 400, h: 300 }; // fitted image size
const stage = { w: 800, h: 600 }; // viewer size

test("clampZoom keeps the scale between fit and the maximum", () => {
  assert.equal(clampZoom(0.2), 1);
  assert.equal(clampZoom(1), 1);
  assert.equal(clampZoom(3.5), 3.5);
  assert.equal(clampZoom(100), MAX_ZOOM);
  assert.equal(clampZoom(Number.NaN), 1);
  assert.equal(clampZoom(Infinity), 1);
});

test("clampPan centres an image that doesn't overflow and bounds one that does", () => {
  assert.deepEqual(clampPan({ scale: 1.5, x: 120, y: -80 }, base, stage), { scale: 1.5, x: 0, y: 0 }); // 600x450 fits in 800x600
  // 1200x900 overflows by 400x300 -> may move 200 / 150 each way.
  assert.deepEqual(clampPan({ scale: 3, x: 500, y: -500 }, base, stage), { scale: 3, x: 200, y: -150 });
  assert.deepEqual(clampPan({ scale: 3, x: -50, y: 20 }, base, stage), { scale: 3, x: -50, y: 20 });
});

test("zoomAt keeps the point under the cursor in place", () => {
  const at = { x: 100, y: 50 }; // px from the viewer's centre
  const v = zoomAt(FIT, 4, at, base, stage);
  assert.equal(v.scale, 4);
  // Image point under the cursor before: (at - pan) / scale; after it must map back to `at`.
  const before = { x: (at.x - FIT.x) / FIT.scale, y: (at.y - FIT.y) / FIT.scale };
  assert.equal(v.x + before.x * v.scale, at.x);
  assert.equal(v.y + before.y * v.scale, at.y);
  // Zooming further from there still keeps it.
  const w = zoomAt(v, 6, at, base, stage);
  assert.ok(Math.abs(w.x + ((at.x - v.x) / v.scale) * w.scale - at.x) < 1e-9);
});

test("zoomAt clamps the scale and recentres at fit", () => {
  assert.deepEqual(zoomAt({ scale: 3, x: 150, y: -100 }, 0.5, { x: 300, y: 0 }, base, stage), FIT);
  assert.equal(zoomAt(FIT, 50, { x: 0, y: 0 }, base, stage).scale, MAX_ZOOM);
  // A point near the edge can't drag the image off screen.
  const v = zoomAt(FIT, 3, { x: 390, y: 290 }, base, stage);
  assert.ok(Math.abs(v.x) <= 200 && Math.abs(v.y) <= 150);
});

test("wheelZoomFactor zooms in on scroll up and out on scroll down, bounded per event", () => {
  assert.ok(wheelZoomFactor(-100) > 1);
  assert.ok(wheelZoomFactor(100) < 1);
  assert.equal(wheelZoomFactor(0), 1);
  assert.equal(wheelZoomFactor(-10_000), wheelZoomFactor(-300));
  assert.equal(wheelZoomFactor(-3, 1), wheelZoomFactor(-48)); // line mode
});

test("wrapIndex cycles both ways", () => {
  assert.equal(wrapIndex(-1, 3), 2);
  assert.equal(wrapIndex(3, 3), 0);
  assert.equal(wrapIndex(1, 3), 1);
  assert.equal(wrapIndex(-7, 3), 2);
  assert.equal(wrapIndex(5, 0), 0);
});

test("swipeStep needs a long, mostly horizontal swipe", () => {
  assert.equal(swipeStep(-80, 10), 1); // swipe left -> next
  assert.equal(swipeStep(80, -5), -1); // swipe right -> previous
  assert.equal(swipeStep(-30, 0), 0); // too short
  assert.equal(swipeStep(-80, 70), 0); // too vertical
});

test("collectImages lists every <img> in order with decoded src and alt", () => {
  const html =
    '<p>Intro</p><img src="/api/uploads/a.png" alt="First &amp; best"><p>x <img alt=\'second\' src=\'/b.webp?x=1&amp;y=2\' /></p>' +
    '<IMG SRC=/c.gif><img alt="no src"><img src="" alt="empty"><img data-src="/lazy.png" src="/d.jpg" srcset="/d2.jpg 2x">';
  assert.deepEqual(collectImages(html), [
    { src: "/api/uploads/a.png", alt: "First & best" },
    { src: "/b.webp?x=1&y=2", alt: "second" },
    { src: "/c.gif", alt: "" },
    { src: "/d.jpg", alt: "" },
  ]);
  assert.deepEqual(collectImages(""), []);
  assert.deepEqual(collectImages("<p>no images</p>"), []);
  assert.deepEqual(collectImages('<img src="/e.png" alt="&#8220;quoted&#x201D; &lt;b&gt;">'), [{ src: "/e.png", alt: "\u201cquoted\u201d <b>" }]);
});
