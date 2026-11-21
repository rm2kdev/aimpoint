"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { ChevronLeftIcon, ChevronRightIcon, HistoryIcon, ImageOffIcon, Maximize2Icon, SparklesIcon } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ImageLightbox } from "@/components/image-lightbox";
import { cn } from "@/lib/utils";
import { markdownToHtml } from "@/lib/markdown-core";
import { swipeStep } from "@/lib/image-lightbox-core";
import { latestMilestone, type ChangelogMilestone } from "@/lib/changelog-core";
import { MILESTONES } from "@/content/changelog";
import { useOrg } from "@/components/org-provider";
import {
  clampSlide,
  historyRows,
  milestoneGallery,
  releaseDateLabel,
  rowForKey,
  slideAnnouncement,
  slideForKey,
  parseWhatsNewParam,
  WHATS_NEW_PARAM,
  withoutWhatsNewParam,
  type HistoryRow,
  type WhatsNewLink,
} from "@/lib/whats-new-core";

/**
 * The user menu's "What's new" / "All updates" entries and the command menu read this (null = no milestone shipped,
 * hide the entries). `latest` opens the newest milestone, `history` the "All updates" list (VEC-377). AppShell
 * provides it; a context of its own keeps the sidebar from importing app-shell (which imports the sidebar).
 */
export type OpenWhatsNew = { latest: () => void; history: () => void };
export const OpenWhatsNewContext = createContext<OpenWhatsNew | null>(null);
export const useOpenWhatsNew = () => useContext(OpenWhatsNewContext);

/** Wait after first load before the pop-up opens, so the page has settled under it. */
const AUTO_OPEN_DELAY_MS = 600;
/** While another dialog (search, new task, a lightbox) is open, check again this often. */
const BUSY_RETRY_MS = 700;

/**
 * The shell's side of the pop-up (VEC-374). Opens it once per tab when the org layout reports an unseen milestone
 * (useOrg().changelog), after first load and never on top of another dialog; closing it dismisses that milestone
 * once (optimistic: the provider hides it at once, a failed save shows a toast and doesn't reopen it). `openLatest`
 * (null when no milestone has shipped) reopens the newest milestone from the user menu without touching the seen
 * marker, unless it is the unseen one, in which case closing it counts as seeing it. `holdOthers` is true while the
 * pop-up is open or about to open, so first-load UI like the install banner waits instead of stacking.
 */
export function useWhatsNew() {
  const { changelog, dismissChangelog } = useOrg();
  /**
   * What the dialog shows. `view` is the slide tour of `milestone` or the "All updates" list (VEC-377; `milestone`
   * then is the one last opened from it, or null, so Back lands on its row). `fromHistory`: the tour was opened
   * from the list, so it shows a Back to the list. `dismisses`: this opening showed the person's unseen milestone,
   * so closing it (from either view) counts as seeing it. Browsing other milestones never sets it.
   */
  const [shown, setShown] = useState<{
    milestone: ChangelogMilestone | null;
    view: "tour" | "history";
    fromHistory: boolean;
    dismisses: boolean;
  } | null>(null);
  const [open, setOpen] = useState(false);
  /** The unseen milestone id this tab already opened (or chose not to), so it opens at most once. */
  const [handled, setHandled] = useState<string | null>(null);
  const pending = !!changelog && handled !== changelog.id;

  useEffect(() => {
    if (!changelog || handled === changelog.id) return;
    let timer = 0;
    const tryOpen = () => {
      if (document.querySelector("[role=dialog], [role=alertdialog]")) {
        timer = window.setTimeout(tryOpen, BUSY_RETRY_MS);
        return;
      }
      setHandled(changelog.id);
      setShown({ milestone: changelog, view: "tour", fromHistory: false, dismisses: true });
      setOpen(true);
    };
    timer = window.setTimeout(tryOpen, AUTO_OPEN_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [changelog, handled]);

  const onOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      // `dismisses` is only set when this opening showed the unseen milestone (never for browsing older ones).
      if (next || !shown?.dismisses || !changelog) return;
      // The provider hides it in this tab at once; changelog turns null, so this runs once per milestone.
      void dismissChangelog().then((r) => {
        if (!r.ok) toast.error(r.error);
      });
    },
    [shown, changelog, dismissChangelog],
  );

  const latest = latestMilestone(MILESTONES);
  // Opening it by hand also counts as this tab's auto-open, so the pop-up never re-triggers on top of browsing.
  const openFromMenu = useMemo(
    () =>
      latest
        ? {
            latest: () => {
              if (changelog) setHandled(changelog.id);
              setShown({ milestone: latest, view: "tour", fromHistory: false, dismisses: changelog?.id === latest.id });
              setOpen(true);
            },
            history: () => {
              if (changelog) setHandled(changelog.id);
              setShown({ milestone: null, view: "history", fromHistory: false, dismisses: false });
              setOpen(true);
            },
          }
        : null,
    [latest, changelog],
  );

  /**
   * A `?whats-new=` link (VEC-384): the list, or one milestone's tour. Counts as the tab's auto-open like the menu
   * entries, and dismisses only when the milestone it shows is the person's unseen one.
   */
  const openLink = useCallback(
    (link: WhatsNewLink) => {
      if (changelog) setHandled(changelog.id);
      const m = link.view === "tour" ? MILESTONES.find((x) => x.id === link.id) : undefined;
      if (m) setShown({ milestone: m, view: "tour", fromHistory: false, dismisses: changelog?.id === m.id });
      else setShown({ milestone: null, view: "history", fromHistory: false, dismisses: false });
      setOpen(true);
    },
    [changelog],
  );

  /** "All updates" from the tour's header, and Back from a milestone opened from the list. */
  const showHistory = useCallback(() => setShown((s) => (s ? { ...s, view: "history" } : s)), []);
  /** A row in the list: that milestone in the same slide viewer. Seeing the unseen one counts; older ones don't. */
  const pickMilestone = useCallback(
    (m: ChangelogMilestone) =>
      setShown((s) => ({
        milestone: m,
        view: "tour",
        fromHistory: true,
        dismisses: (s?.dismisses ?? false) || changelog?.id === m.id,
      })),
    [changelog],
  );

  return {
    milestone: shown?.milestone ?? null,
    view: shown?.view ?? "tour",
    fromHistory: shown?.fromHistory ?? false,
    open,
    onOpenChange,
    openFromMenu,
    openLink,
    showHistory,
    pickMilestone,
    holdOthers: open || pending,
  };
}

/**
 * Opens the dialog from a link (VEC-384): `?whats-new=all` on any org page shows the "All updates" list,
 * `?whats-new=<milestone id>` that milestone's tour (an unknown id falls back to the list), then the parameter is
 * taken out of the address bar with history.replaceState (no navigation or server round trip), so a reload or a
 * shared copy of the URL doesn't open it again. Renders nothing; its own component so search-param changes (every
 * `?task=` open) re-render only this, not the shell.
 */
export function WhatsNewDeepLink({ onOpen }: { onOpen: (link: WhatsNewLink) => void }) {
  const value = useSearchParams().get(WHATS_NEW_PARAM);
  useEffect(() => {
    if (value === null) return;
    const link = parseWhatsNewParam(value, MILESTONES.map((m) => m.id));
    const { pathname, search, hash } = window.location;
    window.history.replaceState(window.history.state, "", `${pathname}${withoutWhatsNewParam(search)}${hash}`);
    if (link) onOpen(link);
  }, [value, onOpen]);
  return null;
}

/**
 * "What's new" pop-up (VEC-374): one milestone's entries as slides (screenshot, title, short Markdown body), moved
 * with Prev/Next, the dots, Left/Right/Home/End and a touch swipe. A screenshot's expand button opens the
 * ImageLightbox over all of the milestone's screenshots. Every way of closing (X, Esc, backdrop, "Got it" on the
 * last slide) goes through `onOpenChange(false)`, so the caller dismisses once. Keep `milestone` set while
 * closing so the exit animation still has content. Phones get a full-height sheet. Rules: docs/changelog.md.
 */
export function WhatsNewDialog({
  milestone,
  view = "tour",
  fromHistory = false,
  open,
  onOpenChange,
  onShowHistory,
  onPick,
}: {
  milestone: ChangelogMilestone | null;
  /** The slide tour of `milestone`, or the "All updates" list of every milestone (VEC-377). */
  view?: "tour" | "history";
  /** The tour was opened from the list: its header shows a Back to the list instead of the "All updates" link. */
  fromHistory?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens the list (the tour's "All updates" link and Back). Without it the tour shows no link. */
  onShowHistory?: () => void;
  onPick?: (milestone: ChangelogMilestone) => void;
}) {
  // The focus target on open and on switching views: Next / Got it in the tour, the current row in the list.
  const primaryRef = useRef<HTMLButtonElement>(null);
  const rows = useMemo(() => historyRows(MILESTONES), []);
  // Index and origin stay set after closing: the exit animation needs the image and focus goes back to `from`.
  const [lightbox, setLightbox] = useState<{ open: boolean; index: number; from: HTMLElement | null }>({ open: false, index: 0, from: null });
  const gallery = useMemo(() => (milestone ? milestoneGallery(milestone) : null), [milestone]);
  // Counts openings, so each one starts a fresh tour while a closing dialog keeps its slide through the exit.
  const [session, setSession] = useState({ open, n: 0 });
  if (session.open !== open) setSession({ open, n: open ? session.n + 1 : session.n });
  const history = view === "history" && !!onPick;
  if (!history && (!milestone || !gallery)) return null;
  const date = milestone ? releaseDateLabel(milestone) : "";
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          data-whats-new={history ? "history" : milestone!.id}
          // With a summary Radix wires it up as the description; without one there is nothing to describe.
          {...(history || milestone!.summary ? {} : { "aria-describedby": undefined })}
          onOpenAutoFocus={(e) => {
            // Start on the primary action (Next / Got it), so Enter walks the tour and Esc still closes.
            e.preventDefault();
            primaryRef.current?.focus({ preventScroll: true });
          }}
          className={cn(
            "flex flex-col gap-0 overflow-hidden p-0 sm:max-w-[600px]",
            // Phones: a full-height sheet (no centring transform), clear of the notch and the home indicator.
            "max-sm:inset-0 max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-h-none max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:ring-0",
            "max-sm:pt-[env(safe-area-inset-top)] max-sm:pr-[env(safe-area-inset-right)] max-sm:pb-[env(safe-area-inset-bottom)] max-sm:pl-[env(safe-area-inset-left)]",
          )}
        >
          {history ? (
            <History rows={rows} currentId={milestone?.id ?? null} focusRef={primaryRef} onPick={onPick!} />
          ) : (
            <Tour
              // A fresh tour (back to the first slide) every time it opens, and for each milestone picked.
              key={`${milestone!.id}:${session.n}`}
              milestone={milestone!}
              date={date}
              indexOf={gallery!.indexOf}
              primaryRef={primaryRef}
              fromHistory={fromHistory}
              onShowHistory={onPick ? onShowHistory : undefined}
              onDone={() => onOpenChange(false)}
              onExpand={(index, from) => setLightbox({ open: true, index, from })}
            />
          )}
        </DialogContent>
      </Dialog>
      {/* A sibling, not a child of the content: the lightbox's own keys must not bubble into the tour's handler. */}
      <ImageLightbox
        images={gallery?.images ?? []}
        index={lightbox.index}
        open={lightbox.open && open && !history}
        onOpenChange={(o) => !o && setLightbox((l) => ({ ...l, open: false }))}
        returnFocus={lightbox.from}
      />
    </>
  );
}

function Tour({
  milestone,
  date,
  indexOf,
  primaryRef,
  fromHistory,
  onShowHistory,
  onDone,
  onExpand,
}: {
  milestone: ChangelogMilestone;
  date: string;
  indexOf: number[];
  primaryRef: React.RefObject<HTMLButtonElement | null>;
  fromHistory: boolean;
  onShowHistory?: () => void;
  onDone: () => void;
  onExpand: (galleryIndex: number, from: HTMLElement | null) => void;
}) {
  const entries = milestone.entries;
  const n = entries.length;
  const [rawIndex, setIndex] = useState(0);
  const index = clampSlide(rawIndex, n);
  const last = index === n - 1;
  // Announced only after a move: on open the dialog's title is read, and the first slide follows it.
  const [announce, setAnnounce] = useState("");
  const [drag, setDrag] = useState(0);
  const swipe = useRef<{ id: number; x: number; y: number; dx: number; dy: number; lock: "x" | "y" | null } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const regionRef = useRef<HTMLDivElement>(null);
  /** Focus was inside the slide being left (expand button, a link): it goes inert, so carry focus over. */
  const refocus = useRef(false);
  // Switching in from the list: its row is gone, so start on Next / Got it (on open, onOpenAutoFocus does this).
  useEffect(() => primaryRef.current?.focus({ preventScroll: true }), [primaryRef]);
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    const region = regionRef.current;
    const target = region?.querySelector<HTMLElement>("[data-whats-new-slide][data-current] .aimpoint-image-expand") ?? region;
    target?.focus({ preventScroll: true });
  }, [index]);

  const go = (to: number) => {
    const next = clampSlide(to, n);
    if (next === index) return;
    refocus.current = !!regionRef.current?.contains(document.activeElement);
    setIndex(next);
    setAnnounce(slideAnnouncement(next, n, entries[next].title));
    bodyRef.current?.scrollTo({ top: 0 });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const to = slideForKey(e.key, index, n);
    if (to === null) return;
    e.preventDefault();
    // The task list's j/k/arrow shortcuts listen on window.
    e.stopPropagation();
    go(to);
  };

  // Touch swipe: the track follows the finger sideways; a vertical drag stays a scroll (touch-action: pan-y).
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" || n < 2) return;
    swipe.current = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, dy: 0, lock: null };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const s = swipe.current;
    if (!s || s.id !== e.pointerId) return;
    s.dx = e.clientX - s.x;
    s.dy = e.clientY - s.y;
    if (!s.lock && Math.abs(s.dx) + Math.abs(s.dy) > 8) s.lock = Math.abs(s.dx) > Math.abs(s.dy) ? "x" : "y";
    if (s.lock !== "x") return;
    // Resist past the ends: there's nothing before the first slide or after the last.
    const edge = (s.dx > 0 && index === 0) || (s.dx < 0 && last);
    setDrag(edge ? s.dx / 3 : s.dx);
  };
  const onPointerEnd = (e: React.PointerEvent) => {
    const s = swipe.current;
    if (!s || s.id !== e.pointerId) return;
    swipe.current = null;
    setDrag(0);
    if (e.type === "pointercancel" || s.lock !== "x") return;
    const step = swipeStep(s.dx, s.dy);
    if (step) go(index + step);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <header className="shrink-0 px-5 pt-5 pr-12 pb-3">
        {fromHistory && onShowHistory && (
          <button
            type="button"
            data-whats-new-back=""
            onClick={onShowHistory}
            className="-mt-1 -ml-1.5 mb-1.5 inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-[12.5px] font-medium text-muted-foreground outline-none hover:bg-chip hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronLeftIcon className="size-3.5" aria-hidden /> All updates
          </button>
        )}
        <DialogTitle className="text-[15px] leading-snug font-semibold tracking-[-0.01em] text-balance">{milestone.title}</DialogTitle>
        <p className="mt-1 text-[12.5px] text-faint">
          What&apos;s new{date && <> · <time dateTime={milestone.releasedAt}>{date}</time></>}
          {!fromHistory && onShowHistory && (
            <>
              {" · "}
              <button
                type="button"
                data-whats-new-history=""
                onClick={onShowHistory}
                className="rounded-sm font-medium text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                All updates
              </button>
            </>
          )}
        </p>
        {milestone.summary && <DialogDescription className="mt-2 text-[13px] leading-5">{milestone.summary}</DialogDescription>}
      </header>

      <div ref={bodyRef} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
        <div
          ref={regionRef}
          tabIndex={-1}
          role="region"
          aria-roledescription="carousel"
          aria-label="Changes in this release"
          className="touch-pan-y overflow-hidden outline-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
        >
          <div
            data-whats-new-track=""
            className={cn("flex", drag === 0 && "transition-transform duration-300 ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none")}
            style={{ transform: `translateX(calc(${-index * 100}% + ${drag}px))` }}
          >
            {entries.map((entry, i) => (
              <Slide
                key={i}
                entry={entry}
                current={i === index}
                label={`${i + 1} of ${n}`}
                galleryIndex={indexOf[i]}
                onExpand={onExpand}
              />
            ))}
          </div>
        </div>
      </div>

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announce}
      </p>

      <footer className="flex shrink-0 items-center gap-3 border-t px-5 py-3">
        {n > 1 && (
          <div className="flex min-w-0 items-center gap-2">
            {n <= 10 && (
              <div role="group" aria-label="Go to a change" className="-ml-1.5 flex items-center">
                {entries.map((e, i) => (
                  <button
                    key={i}
                    type="button"
                    data-whats-new-dot={i}
                    aria-label={`Change ${i + 1}: ${e.title}`}
                    aria-current={i === index ? "step" : undefined}
                    onClick={() => go(i)}
                    className="group grid h-7 w-5 place-items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span
                      className={cn(
                        "block h-1.5 rounded-full transition-[width,background-color] duration-200 motion-reduce:transition-none",
                        i === index ? "w-3.5 bg-foreground" : "w-1.5 bg-input group-hover:bg-faint",
                      )}
                    />
                  </button>
                ))}
              </div>
            )}
            <span className="font-mono text-[12px] text-faint tabular-nums" aria-hidden>
              {index + 1} / {n}
            </span>
          </div>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {n > 1 && (
            <Button
              variant="ghost"
              size="sm"
              // aria-disabled, not disabled: a disabled button drops focus out of the dialog on the first slide.
              aria-disabled={index === 0}
              onClick={() => go(index - 1)}
              className="aria-disabled:pointer-events-none aria-disabled:opacity-40"
            >
              <ChevronLeftIcon data-icon="inline-start" /> Back
            </Button>
          )}
          {/* One button for Next and Got it, so focus stays put when the last slide turns it into Got it. */}
          <Button ref={primaryRef} size="sm" data-whats-new-primary="" onClick={() => (last ? onDone() : go(index + 1))} className="min-w-20">
            {last ? (
              "Got it"
            ) : (
              <>
                Next <ChevronRightIcon data-icon="inline-end" />
              </>
            )}
          </Button>
        </div>
      </footer>
    </div>
  );
}

function Slide({
  entry,
  current,
  label,
  galleryIndex,
  onExpand,
}: {
  entry: ChangelogMilestone["entries"][number];
  current: boolean;
  label: string;
  galleryIndex: number;
  onExpand: (galleryIndex: number, from: HTMLElement | null) => void;
}) {
  const html = useMemo(() => markdownToHtml(entry.body), [entry.body]);
  const [failed, setFailed] = useState(false);
  const expandRef = useRef<HTMLButtonElement>(null);
  return (
    <section
      role="group"
      aria-roledescription="slide"
      aria-label={`${label}: ${entry.title}`}
      aria-hidden={!current}
      inert={!current}
      data-whats-new-slide=""
      data-current={current ? "" : undefined}
      className="w-full shrink-0 px-5 pt-1 pb-5"
    >
      {entry.image && (
        <figure className="aimpoint-image relative aspect-[16/10] w-full max-w-none overflow-hidden rounded-[10px] bg-chip ring-1 ring-border">
          {failed ? (
            <p className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-muted-foreground">
              <ImageOffIcon className="size-5" aria-hidden />
              Couldn&apos;t load this screenshot.
            </p>
          ) : (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element -- static screenshot from public/changelog; fitted by CSS */}
              <img
                src={entry.image.src}
                alt={entry.image.alt}
                draggable={false}
                decoding="async"
                onError={() => setFailed(true)}
                onClick={() => galleryIndex >= 0 && onExpand(galleryIndex, expandRef.current)}
                className="block size-full cursor-zoom-in object-contain select-none"
              />
              {galleryIndex >= 0 && (
                <button
                  ref={expandRef}
                  type="button"
                  aria-label="Expand screenshot"
                  title="Expand screenshot"
                  className="aimpoint-image-expand"
                  onClick={() => onExpand(galleryIndex, expandRef.current)}
                >
                  <Maximize2Icon aria-hidden />
                </button>
              )}
            </>
          )}
        </figure>
      )}
      <h3 className={cn("text-[14px] leading-snug font-semibold", entry.image && "mt-4")}>{entry.title}</h3>
      {/* Repo-authored Markdown (src/content/changelog), rendered by the same converter as agent descriptions. */}
      <div className="prose-aimpoint mt-1.5" dangerouslySetInnerHTML={{ __html: html }} />
    </section>
  );
}

/**
 * "All updates" (VEC-377): every milestone, newest first, as one button per row (thumbnail, title, date, change
 * count, summary). A row opens that milestone in the tour. Up/Down/Home/End move between rows. Focus starts on the
 * row last opened (coming Back) or the newest. Nothing here touches the seen marker.
 */
function History({
  rows,
  currentId,
  focusRef,
  onPick,
}: {
  rows: HistoryRow[];
  currentId: string | null;
  focusRef: React.RefObject<HTMLButtonElement | null>;
  onPick: (milestone: ChangelogMilestone) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const start = Math.max(0, rows.findIndex((r) => r.id === currentId));
  // Switching in from a tour (its button is gone): land on the row it came from. On open, onOpenAutoFocus does it.
  useEffect(() => {
    const el = focusRef.current;
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "nearest" });
  }, [focusRef]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-whats-new-row]") ?? [])];
    const to = rowForKey(e.key, buttons.indexOf(document.activeElement as HTMLButtonElement), buttons.length);
    if (to === null) return;
    e.preventDefault();
    // The task list's j/k/arrow shortcuts listen on window.
    e.stopPropagation();
    buttons[to]?.focus();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 px-5 pt-5 pr-12 pb-3">
        <DialogTitle className="text-[15px] leading-snug font-semibold tracking-[-0.01em]">All updates</DialogTitle>
        <DialogDescription className="mt-1 text-[12.5px] text-faint">Every What&apos;s new release, newest first.</DialogDescription>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t">
        <ul ref={listRef} aria-label="Releases" className="flex flex-col p-2" onKeyDown={onKeyDown}>
          {rows.map((row, i) => {
            const milestone = MILESTONES.find((m) => m.id === row.id)!;
            return (
              <li key={row.id}>
                <button
                  ref={i === start ? focusRef : undefined}
                  type="button"
                  data-whats-new-row={row.id}
                  onClick={() => onPick(milestone)}
                  className="flex w-full items-start gap-3 rounded-[10px] p-2.5 text-left outline-none hover:bg-chip focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="grid aspect-[16/10] w-[88px] shrink-0 place-items-center overflow-hidden rounded-md bg-chip ring-1 ring-border max-sm:w-[72px]">
                    {row.thumbnail ? (
                      // eslint-disable-next-line @next/next/no-img-element -- static screenshot from public/changelog
                      <img src={row.thumbnail.src} alt="" loading="lazy" decoding="async" draggable={false} className="size-full object-cover" />
                    ) : (
                      <SparklesIcon className="size-4 text-faint" aria-hidden />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 truncate text-[13.5px] leading-snug font-semibold">{row.title}</span>
                      {i === 0 && (
                        <span className="shrink-0 rounded-full bg-chip px-1.5 py-px text-[11px] font-medium text-muted-foreground">Latest</span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-[12px] text-faint">
                      {row.date && (
                        <>
                          <time dateTime={row.releasedAt}>{row.date}</time>
                          {" · "}
                        </>
                      )}
                      {row.countLabel}
                    </span>
                    <span className="mt-1 line-clamp-2 block text-[12.5px] leading-[1.45] text-muted-foreground">{row.blurb}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <p className="flex shrink-0 items-center gap-1.5 border-t px-5 py-3 text-[12px] text-faint">
        <HistoryIcon className="size-3.5" aria-hidden />
        {rows.length === 1 ? "1 update so far" : `${rows.length} updates`}
      </p>
    </div>
  );
}
