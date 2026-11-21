// Pure helpers for the image lightbox (VEC-334): zoom/pan maths and collecting images from stored HTML.
// No DOM or React here, so `pnpm test` (node --test) covers them directly.

/** One image the lightbox can show. */
export type LightboxImage = { src: string; alt: string };

/** Zoom and pan of the shown image. `scale` 1 = fitted to the viewer; `x`/`y` are px offsets of its centre. */
export type LightboxView = { scale: number; x: number; y: number };

export type Size = { w: number; h: number };
export type Point = { x: number; y: number };

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;
/** Factor of one zoom-in / zoom-out step (buttons, + and - keys). */
export const ZOOM_STEP = 1.5;
/** Scale a double-click / double-tap on a fitted image zooms to. */
export const DOUBLE_ZOOM = 2.5;
/** Horizontal travel (px) a swipe needs to change image. */
export const SWIPE_MIN = 50;

export const FIT: LightboxView = { scale: 1, x: 0, y: 0 };

export function clampZoom(scale: number, min = MIN_ZOOM, max = MAX_ZOOM): number {
  if (!Number.isFinite(scale)) return min;
  return Math.min(max, Math.max(min, scale));
}

/**
 * Keeps a zoomed image covering the viewer: it may move only as far as its scaled size overflows `stage`
 * on each axis (centred when it doesn't overflow). `base` is the fitted (scale 1) size of the image.
 */
export function clampPan(view: LightboxView, base: Size, stage: Size): LightboxView {
  const maxX = Math.max(0, (base.w * view.scale - stage.w) / 2);
  const maxY = Math.max(0, (base.h * view.scale - stage.h) / 2);
  const clamp = (v: number, m: number) => (m === 0 ? 0 : Math.min(m, Math.max(-m, v)));
  return { scale: view.scale, x: clamp(view.x, maxX), y: clamp(view.y, maxY) };
}

/**
 * Zooms to `scale` keeping the image point under `at` (px from the viewer's centre) where it is.
 * Zooming back to fit always recentres.
 */
export function zoomAt(view: LightboxView, scale: number, at: Point, base: Size, stage: Size): LightboxView {
  const s = clampZoom(scale);
  if (s <= MIN_ZOOM) return FIT;
  const k = s / view.scale;
  return clampPan({ scale: s, x: at.x - (at.x - view.x) * k, y: at.y - (at.y - view.y) * k }, base, stage);
}

/** Multiplier for one wheel event: smooth for trackpads, about one step per mouse notch. */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(-Math.max(-300, Math.min(300, px)) * 0.002);
}

/** Index `i` wrapped into `0..n-1` (prev from the first image goes to the last). */
export function wrapIndex(i: number, n: number): number {
  if (n <= 0) return 0;
  return ((i % n) + n) % n;
}

/** +1 (next) for a leftward swipe, -1 (previous) for a rightward one, 0 when it's too short or mostly vertical. */
export function swipeStep(dx: number, dy: number, min = SWIPE_MIN): -1 | 0 | 1 {
  if (Math.abs(dx) < min || Math.abs(dx) < Math.abs(dy) * 1.5) return 0;
  return dx < 0 ? 1 : -1;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
  if (!m) return null;
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? "");
}

/** Every `<img>` in `html`, in document order, as lightbox images (images without a src are skipped). */
export function collectImages(html: string): LightboxImage[] {
  const out: LightboxImage[] = [];
  for (const m of (html ?? "").matchAll(/<img\b[^>]*>/gi)) {
    const src = attr(m[0], "src")?.trim();
    if (src) out.push({ src, alt: attr(m[0], "alt") ?? "" });
  }
  return out;
}
