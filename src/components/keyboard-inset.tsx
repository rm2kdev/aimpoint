"use client";

import { useEffect } from "react";

/** A visible area this much shorter than the layout viewport means an on-screen keyboard (not a toolbar wobble). */
const KEYBOARD_MIN = 120;

function editable(el: Element | null) {
  if (!el) return false;
  if ((el as HTMLElement).isContentEditable) return true;
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  return el.tagName === "INPUT" && !/^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/i.test((el as HTMLInputElement).type);
}

/**
 * On-screen keyboard tracking for phones (VEC-165). iOS (Safari and home-screen web apps alike) doesn't
 * resize the layout viewport for the keyboard: 100dvh, env(safe-area-inset-bottom) and fixed/centred
 * dialogs all keep sizing to the full screen, while only the visual viewport shrinks and pans. So the
 * bot tray kept its 34pt home-indicator inset above the keyboard, and the focused composer / dialog
 * footer ended up under the tray or the keyboard.
 *
 * While a keyboard is up this sets `data-keyboard` on <html> plus `--vv-height` / `--vv-top` (the
 * visible area's height and its offset in the layout viewport), which globals.css uses to drop the
 * tray's bottom inset and fit open dialogs to what's visible. Composers marked `data-keyboard-reveal`
 * are scrolled fully into view. Nothing is set on desktop or with a hardware keyboard, since the
 * visual viewport never shrinks there.
 */
export function KeyboardInset() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    let frame = 0;
    let open = false;

    const update = () => {
      frame = 0;
      // innerHeight follows the visual viewport on iOS; the layout viewport (clientHeight) keeps the full height.
      const covered = root.clientHeight - vv.height * vv.scale;
      const next = covered > KEYBOARD_MIN && editable(document.activeElement);
      if (next) {
        root.style.setProperty("--vv-height", `${vv.height}px`);
        root.style.setProperty("--vv-top", `${vv.offsetTop}px`);
      }
      if (next !== open) {
        open = next;
        if (open) root.setAttribute("data-keyboard", "");
        else {
          root.removeAttribute("data-keyboard");
          root.style.removeProperty("--vv-height");
          root.style.removeProperty("--vv-top");
        }
        if (open) reveal();
      }
    };
    // iOS scrolls only the caret into view, so a growing composer's footer (the Comment button) ended up
    // clipped at the bottom of its scroller. Reveal the whole marked box (or the field) once the layout
    // has settled, on open and as typing grows it.
    let revealFrame = 0;
    const reveal = () => {
      cancelAnimationFrame(revealFrame);
      revealFrame = requestAnimationFrame(() => {
        if (!open) return;
        const el = document.activeElement;
        if (!editable(el)) return;
        (el!.closest<HTMLElement>("[data-keyboard-reveal]") ?? (el as HTMLElement)).scrollIntoView({ block: "nearest" });
      });
    };
    const onInput = () => open && reveal();
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };

    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
    document.addEventListener("focusin", schedule);
    document.addEventListener("focusout", schedule);
    document.addEventListener("input", onInput);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(revealFrame);
      vv.removeEventListener("resize", schedule);
      vv.removeEventListener("scroll", schedule);
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("focusout", schedule);
      document.removeEventListener("input", onInput);
      root.removeAttribute("data-keyboard");
    };
  }, []);
  return null;
}
