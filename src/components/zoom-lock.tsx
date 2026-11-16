"use client";

import { useEffect } from "react";

/**
 * Keeps the page at scale 1 on touch devices (VEC-154). iOS Safari ignores `user-scalable=no` in a
 * browser tab, so pinch is blocked here: Safari's own `gesture*` events, plus any touchmove with two
 * or more fingers. Single-finger touches are never touched, so scrolling, text selection and the
 * drag provider's touch drags behave as before. Double-tap zoom is handled by
 * `touch-action: manipulation` on <html> (globals.css), input-focus zoom by the 16px rule there.
 */
export function ZoomLock() {
  useEffect(() => {
    const stop = (e: Event) => {
      if (e.cancelable) e.preventDefault();
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length > 1 && e.cancelable) e.preventDefault();
    };
    const opts = { passive: false } as const;
    document.addEventListener("gesturestart", stop, opts);
    document.addEventListener("gesturechange", stop, opts);
    document.addEventListener("gestureend", stop, opts);
    document.addEventListener("touchmove", onTouchMove, opts);
    return () => {
      document.removeEventListener("gesturestart", stop);
      document.removeEventListener("gesturechange", stop);
      document.removeEventListener("gestureend", stop);
      document.removeEventListener("touchmove", onTouchMove);
    };
  }, []);
  return null;
}
