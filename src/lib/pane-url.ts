"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { createElement, useSyncExternalStore, type ComponentProps } from "react";

/**
 * The task pane's `?task=KEY` without a router navigation (VEC-458).
 *
 * Opening, switching (j/k) and closing a pane used to be `router.replace(?task=...)`: a full RSC navigation (the
 * list pages don't read `task`), and Next keeps router updates in transitions behind server actions still on their
 * way, so on a slow network the pane opened or closed seconds after the click. Now the pane key is read from the
 * address bar itself and written with history.replaceState:
 *
 * - `null` state, not `window.history.state`: that carries Next's `__NA` flag and Next's patched replaceState skips
 *   syncing such calls (VEC-400). With `null` Next copies its tree and restores its router URL too, so later
 *   router commits (HistoryUpdater) write this URL back, not the old `?task=`.
 * - The pane doesn't wait for that router sync: `usePaneTask` reads `location`, re-read on our own change event and
 *   on popstate. Back/forward between pages, deep links and `router.push(?task=)` from elsewhere (command menu,
 *   toasts) still arrive through useSearchParams, which re-renders the caller.
 */
const EVENT = "aimpoint:pane-task";

function subscribe(onChange: () => void) {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("popstate", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("popstate", onChange);
  };
}

/** The address with `?task=` set to `key` (or removed), other parameters and the hash kept. */
export function paneHref(key: string | null, at: { pathname: string; search: string; hash?: string } = window.location) {
  const q = new URLSearchParams(at.search);
  if (key) q.set("task", key);
  else q.delete("task");
  const s = q.toString();
  return `${at.pathname}${s ? `?${s}` : ""}${at.hash ?? ""}`;
}

/**
 * Open (or with null, close) the pane for `key` on this page. Instant: no navigation, no server round trip.
 * Replaces the history entry like the list rows always did; `push` adds one (the command menu's jump).
 */
export function setPaneTask(key: string | null, { push = false }: { push?: boolean } = {}) {
  const href = paneHref(key);
  const { pathname, search, hash } = window.location;
  if (href === `${pathname}${search}${hash}`) return;
  if (push) window.history.pushState(null, "", href);
  else window.history.replaceState(null, "", href);
  window.dispatchEvent(new Event(EVENT));
}

/** For an href that only changes `?task=` on this page: the key it opens (null = closes); otherwise undefined. */
export function sameTaskPage(href: string): string | null | undefined {
  const url = new URL(href, window.location.href);
  if (url.origin !== window.location.origin || url.pathname !== window.location.pathname) return undefined;
  const a = new URLSearchParams(url.search);
  const b = new URLSearchParams(window.location.search);
  const key = a.get("task");
  a.delete("task");
  b.delete("task");
  a.sort();
  b.sort();
  return a.toString() === b.toString() ? key : undefined;
}

/**
 * A link that opens a task in this page's pane (`href` = `<this path>?task=KEY`). A plain click opens it through
 * `setPaneTask`; cmd/ctrl/shift/middle clicks, a new tab and "Copy link" still get the real href.
 */
export function PaneLink({ onNavigate, ...props }: ComponentProps<typeof Link>) {
  return createElement(Link, {
    replace: true,
    scroll: false,
    ...props,
    onNavigate: (e: { preventDefault: () => void }) => {
      onNavigate?.(e);
      const key = sameTaskPage(typeof props.href === "string" ? props.href : String(props.href));
      if (key === undefined) return;
      e.preventDefault();
      setPaneTask(key);
    },
  });
}

/** The open task's key, current the moment `setPaneTask` (or back/forward) changes it. */
export function usePaneTask(): string | null {
  const pathname = usePathname();
  const fromRouter = useSearchParams().get("task");
  return useSyncExternalStore(
    subscribe,
    // Mid-navigation to another page the router's value leads (the address bar is written at commit).
    () => (decodeURI(window.location.pathname) === pathname ? new URLSearchParams(window.location.search).get("task") : fromRouter),
    () => fromRouter,
  );
}
