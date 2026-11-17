"use client";

import { useSyncExternalStore } from "react";
import { ShareIcon, SquarePlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * "Add to Home Screen" prompt (VEC-157). Two install paths:
 * - Chromium (Android, desktop): the browser fires `beforeinstallprompt`; we keep the event and show an
 *   "Install app" button that calls its `prompt()` (the native install dialog).
 * - iOS (Safari, and Chrome/Edge/Firefox on iOS 16.4+): no install event exists, so the banner explains
 *   Share -> Add to Home Screen. In-app browsers (Facebook, Instagram, ...) have no such menu: nothing shows.
 * Never shown when already running standalone (launched from the home screen / installed app window).
 * Dismissing hides the banner for 30 days (localStorage); the user menu's "Install app" entry reopens it.
 * Only mounted in the signed-in app shell, so login/signup never show it.
 */

type InstallEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export type InstallMode = "ios" | "prompt";

const DISMISS_KEY = "vector:install-dismissed";
const DISMISS_MS = 30 * 24 * 60 * 60 * 1000;

interface InstallState {
  /** How this browser can install, or null when it can't (or already runs installed). */
  mode: InstallMode | null;
  /** Banner visible. */
  open: boolean;
}

const SERVER: InstallState = { mode: null, open: false };

let deferred: InstallEvent | null = null;
let installed = false;
let forced = false;
let state: InstallState | null = null;
const listeners = new Set<() => void>();

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: window-controls-overlay)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** iOS / iPadOS browsers that offer Add to Home Screen in their share menu. */
function iosCanAddToHomeScreen() {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (!ios) return false;
  // In-app browsers (web views) have no share sheet entry for it.
  if (/FBAN|FBAV|Instagram|Line\/|LinkedInApp|Twitter|Snapchat|GSA\/|MicroMessenger|; wv\)/.test(ua)) return false;
  // Other iOS browsers gained Add to Home Screen in iOS 16.4; Safari has always had it.
  if (/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)) {
    const v = /OS (\d+)_(\d+)/.exec(ua);
    return !!v && (Number(v[1]) > 16 || (Number(v[1]) === 16 && Number(v[2]) >= 4));
  }
  // Safari itself (iPadOS desktop mode reports a Mac UA without "Mobile", still Safari).
  return /Safari\//.test(ua);
}

function dismissedRecently() {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY));
    return at > 0 && Date.now() - at < DISMISS_MS;
  } catch {
    return false;
  }
}

function compute(): InstallState {
  if (installed || isStandalone()) return { mode: null, open: false };
  const mode: InstallMode | null = deferred ? "prompt" : iosCanAddToHomeScreen() ? "ios" : null;
  return { mode, open: !!mode && (forced || !dismissedRecently()) };
}

function refresh() {
  const next = compute();
  if (state && next.mode === state.mode && next.open === state.open) return;
  state = next;
  for (const l of listeners) l();
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    // Keep Chrome's own mini-infobar away; we show our button instead.
    e.preventDefault();
    deferred = e as InstallEvent;
    refresh();
  });
  window.addEventListener("appinstalled", () => {
    installed = true;
    deferred = null;
    refresh();
  });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
function getSnapshot() {
  return (state ??= compute());
}
const getServerSnapshot = () => SERVER;

export function useInstallState() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Hide the banner and don't show it again for 30 days. */
export function dismissInstall() {
  forced = false;
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
  } catch {}
  refresh();
}

/** Run the native install dialog (Chromium). Accepting hides everything; cancelling counts as a dismissal. */
async function promptInstall() {
  const e = deferred;
  if (!e) return;
  // An install event can only prompt once.
  deferred = null;
  await e.prompt();
  const { outcome } = await e.userChoice;
  if (outcome === "accepted") installed = true;
  else dismissInstall();
  refresh();
}

/** The user menu entry: native dialog where there is one, otherwise reopen the instructions. */
export function startInstall() {
  if (deferred) return void promptInstall();
  forced = true;
  refresh();
}

export function InstallPrompt({ className }: { className?: string }) {
  const { mode, open } = useInstallState();
  if (!mode || !open) return null;
  return (
    <aside
      aria-label="Install Vector"
      data-install-prompt={mode}
      className={cn(
        "pointer-events-auto flex w-full items-start gap-3 rounded-[10px] bg-popover p-3 text-popover-foreground shadow-lg ring-1 ring-foreground/10 sm:w-[360px]",
        className,
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- static 192px PWA icon from public/ */}
      <img src="/icon-192.png" alt="" width={36} height={36} className="mt-0.5 size-9 shrink-0 rounded-[9px] ring-1 ring-foreground/10" />
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] leading-5 font-medium">Install Vector</p>
        {mode === "ios" ? (
          <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">
            Tap Share
            <ShareIcon aria-label="(the Share icon)" className="mx-1 inline size-3.5 -translate-y-px align-middle text-foreground" />
            then Add to Home Screen
            <SquarePlusIcon aria-hidden className="mx-1 inline size-3.5 -translate-y-px align-middle text-foreground" />
          </p>
        ) : (
          <>
            <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">Open Vector in its own window, straight from your home screen or dock.</p>
            <Button size="sm" className="mt-2.5" onClick={() => void promptInstall()}>
              Install app
            </Button>
          </>
        )}
      </div>
      <Button variant="ghost" size="icon-sm" aria-label="Dismiss" className="-mt-1 -mr-1 text-muted-foreground" onClick={dismissInstall}>
        <XIcon />
      </Button>
    </aside>
  );
}
