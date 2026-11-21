"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, ImageOffIcon, XIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  DOUBLE_ZOOM,
  FIT,
  ZOOM_STEP,
  clampPan,
  clampZoom,
  swipeStep,
  wheelZoomFactor,
  wrapIndex,
  zoomAt,
  type LightboxImage,
  type LightboxView,
  type Point,
} from "@/lib/image-lightbox-core";

export type { LightboxImage } from "@/lib/image-lightbox-core";
export { collectImages } from "@/lib/image-lightbox-core";

/**
 * Full-screen image viewer (VEC-334): an ordered list of images opened at `index`, with zoom (buttons, wheel,
 * double-click/tap, pinch), drag-to-pan when zoomed, prev/next (buttons, arrow keys, swipe) and an `n / total`
 * counter. Pinch is handled here with pointer events and a CSS transform (`touch-action: none` on the stage),
 * so ZoomLock keeps the rest of the app at scale 1. Keep `images`/`index` set while closing so the exit
 * animation still has the picture; `returnFocus` gets focus back on close (e.g. the expand button).
 */
export function ImageLightbox({
  images,
  index,
  open,
  onOpenChange,
  returnFocus,
}: {
  images: LightboxImage[];
  index: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocus?: HTMLElement | null;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  return (
    <Dialog open={open && images.length > 0} onOpenChange={onOpenChange}>
      <DialogContent
        ref={contentRef}
        showCloseButton={false}
        aria-describedby={undefined}
        data-image-lightbox=""
        onOpenAutoFocus={(e) => {
          // Focus the viewer itself so arrow/zoom keys work at once, without a focus ring on the first control.
          // Clicks on the image land there too (nearest focusable ancestor), so its key handler keeps working.
          e.preventDefault();
          contentRef.current?.querySelector<HTMLElement>("[data-lightbox-root]")?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(e) => {
          if (!returnFocus?.isConnected) return;
          e.preventDefault();
          returnFocus.focus({ preventScroll: true });
        }}
        className="inset-0 top-0 left-0 block h-dvh w-screen max-w-none translate-x-0 translate-y-0 overflow-hidden overscroll-none rounded-none bg-black/95 p-0 text-white ring-0 select-none sm:max-w-none max-h-none"
      >
        {images.length > 0 && <Viewer images={images} start={index} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

type Gesture =
  | { kind: "pan"; id: number; sx: number; sy: number; x0: number; y0: number; moved: boolean }
  | { kind: "swipe"; id: number; sx: number; sy: number; moved: boolean }
  | { kind: "pinch"; s0: number; x0: number; y0: number; mid0: Point; dist0: number };

const TAP_SLOP = 8;
const DOUBLE_TAP_MS = 300;

function Viewer({ images, start, onClose }: { images: LightboxImage[]; start: number; onClose: () => void }) {
  const n = images.length;
  const [rawIndex, setIndex] = useState(() => wrapIndex(start, n));
  const index = Math.min(rawIndex, n - 1);
  const image = images[index];
  const [view, setView] = useState<LightboxView>(FIT);
  const [animate, setAnimate] = useState(false);
  const [swipeX, setSwipeX] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  });
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const lastPointerType = useRef("mouse");
  const suppressClick = useRef(false);
  /** The last press started on the dark area around the image (not on the image). */
  const downOnBackdrop = useRef(false);

  /** Fitted image size and viewer size, for pan bounds. */
  const measure = () => {
    const img = imgRef.current;
    const stage = stageRef.current;
    if (!img || !stage) return null;
    return { base: { w: img.offsetWidth, h: img.offsetHeight }, stage: { w: stage.clientWidth, h: stage.clientHeight } };
  };
  /** A client point as px from the viewer's centre (where the fitted image is centred). */
  const fromCentre = (clientX: number, clientY: number): Point => {
    const r = stageRef.current?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: clientX - r.left - r.width / 2, y: clientY - r.top - r.height / 2 };
  };

  const zoomTo = (scale: (v: LightboxView) => number, at: Point = { x: 0, y: 0 }, anim = true) => {
    const m = measure();
    if (!m) return;
    setAnimate(anim);
    setView((v) => zoomAt(v, scale(v), at, m.base, m.stage));
  };
  const zoomIn = () => zoomTo((v) => v.scale * ZOOM_STEP);
  const zoomOut = () => zoomTo((v) => v.scale / ZOOM_STEP);
  const reset = () => {
    setAnimate(true);
    setView(FIT);
  };
  const toggleZoom = (at: Point) => zoomTo((v) => (v.scale > 1 ? 1 : DOUBLE_ZOOM), at);
  const go = (step: number) => {
    if (n < 2) return;
    setIndex((i) => wrapIndex(Math.min(i, n - 1) + step, n));
    setAnimate(false);
    setView(FIT);
    setSwipeX(0);
  };

  // Wheel zoom about the cursor. React's onWheel is passive, so it can't stop the page from scrolling.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const img = imgRef.current;
      if (!img) return;
      const r = stage.getBoundingClientRect();
      const at = { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
      const base = { w: img.offsetWidth, h: img.offsetHeight };
      const size = { w: stage.clientWidth, h: stage.clientHeight };
      const f = wheelZoomFactor(e.deltaY, e.deltaMode);
      setAnimate(false);
      setView((v) => zoomAt(v, v.scale * f, at, base, size));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, []);

  // Keep a zoomed image inside its bounds when the window resizes or rotates.
  useEffect(() => {
    const onResize = () => {
      const img = imgRef.current;
      const stage = stageRef.current;
      if (!img || !stage) return;
      setView((v) => clampPan(v, { w: img.offsetWidth, h: img.offsetHeight }, { w: stage.clientWidth, h: stage.clientHeight }));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Warm the neighbours so prev/next shows at once.
  useEffect(() => {
    if (n < 2) return;
    for (const d of [1, -1]) new window.Image().src = images[wrapIndex(index + d, n)].src;
  }, [index, images, n]);

  const pinchStart = () => {
    const [a, b] = [...pointers.current.values()];
    const v = viewRef.current;
    gesture.current = {
      kind: "pinch",
      s0: v.scale,
      x0: v.x,
      y0: v.y,
      mid0: fromCentre((a.x + b.x) / 2, (a.y + b.y) / 2),
      dist0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    };
    setSwipeX(0);
  };
  const singleStart = (id: number, p: Point) => {
    const v = viewRef.current;
    gesture.current =
      v.scale > 1 ? { kind: "pan", id, sx: p.x, sy: p.y, x0: v.x, y0: v.y, moved: false } : { kind: "swipe", id, sx: p.x, sy: p.y, moved: false };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    lastPointerType.current = e.pointerType;
    // Read before capturing: with pointer capture the click's target is the stage, wherever it landed.
    downOnBackdrop.current = e.target !== imgRef.current;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    setAnimate(false);
    if (pointers.current.size === 2) pinchStart();
    else if (pointers.current.size === 1) singleStart(e.pointerId, { x: e.clientX, y: e.clientY });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    const m = measure();
    if (!g || !m) return;
    if (g.kind === "pinch") {
      if (pointers.current.size < 2) return;
      const [a, b] = [...pointers.current.values()];
      const s = clampZoom(g.s0 * (Math.hypot(a.x - b.x, a.y - b.y) / g.dist0), 0.6);
      const mid = fromCentre((a.x + b.x) / 2, (a.y + b.y) / 2);
      // The image point that was under the fingers' midpoint stays under it (also follows a two-finger drag).
      const px = (g.mid0.x - g.x0) / g.s0;
      const py = (g.mid0.y - g.y0) / g.s0;
      const next = { scale: s, x: mid.x - px * s, y: mid.y - py * s };
      setView(s < 1 ? next : clampPan(next, m.base, m.stage));
      return;
    }
    if (e.pointerId !== g.id) return;
    const dx = e.clientX - g.sx;
    const dy = e.clientY - g.sy;
    if (Math.abs(dx) + Math.abs(dy) > TAP_SLOP) g.moved = true;
    if (g.kind === "pan") setView((v) => clampPan({ scale: v.scale, x: g.x0 + dx, y: g.y0 + dy }, m.base, m.stage));
    else if (n > 1 && g.moved) setSwipeX(dx);
  };

  const onPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    const cancelled = e.type === "pointercancel";
    if (g?.kind === "pinch") {
      suppressClick.current = true;
      lastTap.current = null;
      if (pointers.current.size === 1) {
        // One finger left: carry on as a pan from where it is.
        const [[id, p]] = [...pointers.current.entries()];
        singleStart(id, p);
        if (gesture.current && gesture.current.kind !== "pinch") gesture.current.moved = true;
      } else if (pointers.current.size === 0) gesture.current = null;
      if (viewRef.current.scale <= 1.02) reset();
      return;
    }
    if (!g || e.pointerId !== g.id) return;
    gesture.current = null;
    suppressClick.current = g.moved;
    if (g.kind === "swipe") {
      const step = cancelled ? 0 : swipeStep(e.clientX - g.sx, e.clientY - g.sy);
      if (step && n > 1) go(step);
      else if (swipeX !== 0) {
        setAnimate(true);
        setSwipeX(0);
      }
    }
    if (g.moved || cancelled || e.pointerType === "mouse") return;
    // Touch / pen tap: a second tap close by in time and place toggles zoom (dblclick isn't reliable with touch-action: none).
    const now = e.timeStamp;
    const prev = lastTap.current;
    if (prev && now - prev.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 30) {
      lastTap.current = null;
      toggleZoom(fromCentre(e.clientX, e.clientY));
    } else lastTap.current = { t: now, x: e.clientX, y: e.clientY };
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    let handled = true;
    if (k === "ArrowRight" && n > 1) go(1);
    else if (k === "ArrowLeft" && n > 1) go(-1);
    else if (k === "+" || k === "=") zoomIn();
    else if (k === "-" || k === "_") zoomOut();
    else if (k === "0") reset();
    else handled = false;
    if (handled) {
      e.preventDefault();
      // The task list's j/k/arrow shortcuts listen on window.
      e.stopPropagation();
    }
  };

  const zoomed = view.scale > 1.001;
  const pct = Math.round(view.scale * 100);
  const title = `${n > 1 ? `Image ${index + 1} of ${n}` : "Image"}${image.alt ? `: ${image.alt}` : ""}`;

  return (
    <div data-lightbox-root="" tabIndex={-1} className="absolute inset-0 outline-none" onKeyDown={onKeyDown}>
      <DialogTitle className="sr-only">{title}</DialogTitle>
      <div
        ref={stageRef}
        data-lightbox-stage=""
        className={cn("absolute inset-0 touch-none overflow-hidden", zoomed ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in")}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onDoubleClick={(e) => {
          if (lastPointerType.current !== "mouse") return;
          toggleZoom(fromCentre(e.clientX, e.clientY));
        }}
        onClick={() => {
          // A plain click on the dark area around a fitted image closes, like a classic lightbox.
          const drag = suppressClick.current;
          suppressClick.current = false;
          if (drag || zoomed || !downOnBackdrop.current || lastPointerType.current !== "mouse") return;
          onClose();
        }}
      >
        {/* Fit box: the image is fitted inside it and centred on the viewer, which pan bounds rely on. */}
        <div className="absolute inset-0 flex items-center justify-center px-3 py-16 sm:px-16">
          {failed === image.src ? (
            <p className="flex flex-col items-center gap-2 text-[13px] text-white/70">
              <ImageOffIcon className="size-6" aria-hidden />
              Couldn&apos;t load this image.
            </p>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- user uploads of any size/origin; next/image adds nothing here
            <img
              key={image.src}
              ref={imgRef}
              src={image.src}
              alt={image.alt}
              draggable={false}
              data-lightbox-image=""
              onError={() => setFailed(image.src)}
              className={cn(
                "block max-h-full max-w-full object-contain will-change-transform",
                animate && "transition-transform duration-200 ease-out motion-reduce:transition-none",
              )}
              style={{ transform: `translate3d(${view.x + swipeX}px, ${view.y}px, 0) scale(${view.scale})` }}
            />
          )}
        </div>
      </div>

      {/* Top bar: counter left, zoom + close right. The bar itself lets gestures through to the stage. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between gap-2 pt-[calc(env(safe-area-inset-top)+0.75rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] pl-[calc(env(safe-area-inset-left)+0.75rem)] sm:pr-[calc(env(safe-area-inset-right)+1rem)] sm:pl-[calc(env(safe-area-inset-left)+1rem)]">
        <span className="pointer-events-auto min-w-0 rounded-full bg-black/45 px-2.5 py-1 text-[13px] font-medium tabular-nums text-white/90 ring-1 ring-white/15" aria-live="polite" hidden={n < 2}>
          {index + 1} / {n}
        </span>
        <div className="pointer-events-auto ml-auto flex items-center gap-1.5">
          <Control label="Zoom out" onClick={zoomOut} disabled={!zoomed}>
            <ZoomOutIcon />
          </Control>
          <button
            type="button"
            aria-label="Reset zoom to fit"
            title="Reset zoom to fit (0)"
            onClick={reset}
            disabled={!zoomed}
            className={cn(CONTROL, "w-auto min-w-14 px-2.5 text-[12.5px] font-medium tabular-nums")}
          >
            {pct}%
          </button>
          <Control label="Zoom in" onClick={zoomIn} disabled={view.scale >= 8}>
            <ZoomInIcon />
          </Control>
          <DialogClose asChild>
            <button type="button" aria-label="Close" title="Close (Esc)" className={cn(CONTROL, "ml-1.5")}>
              <XIcon />
            </button>
          </DialogClose>
        </div>
      </div>

      {n > 1 && (
        <>
          <Control label="Previous image" onClick={() => go(-1)} className="absolute top-1/2 left-[calc(env(safe-area-inset-left)+0.5rem)] size-11 -translate-y-1/2 sm:left-[calc(env(safe-area-inset-left)+0.75rem)]">
            <ChevronLeftIcon />
          </Control>
          <Control label="Next image" onClick={() => go(1)} className="absolute top-1/2 right-[calc(env(safe-area-inset-right)+0.5rem)] size-11 -translate-y-1/2 sm:right-[calc(env(safe-area-inset-right)+0.75rem)]">
            <ChevronRightIcon />
          </Control>
        </>
      )}

      {image.alt && (
        <p className="pointer-events-none absolute inset-x-0 bottom-0 truncate px-16 pb-[calc(env(safe-area-inset-bottom)+1.1rem)] text-center text-[13px] text-white/70">
          {image.alt}
        </p>
      )}
    </div>
  );
}

const CONTROL =
  "grid size-9 place-items-center rounded-full bg-black/45 text-white/90 ring-1 ring-white/15 backdrop-blur-sm transition-colors hover:bg-white/15 hover:text-white disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white [&_svg]:size-[18px]";

function Control({
  label,
  onClick,
  disabled,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled} className={cn(CONTROL, className)}>
      {children}
    </button>
  );
}
