"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { ChevronLeftIcon, HistoryIcon, ImageOffIcon, Maximize2Icon, SparklesIcon } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ImageLightbox } from "@/components/image-lightbox";
import { cn } from "@/lib/utils";
import { markdownToHtml } from "@/lib/markdown-core";
import { latestMilestone, type ChangelogMilestone } from "@/lib/changelog-core";
import { MILESTONES } from "@/content/changelog";
import { useOrg } from "@/components/org-provider";
import {
  changeCountLabel,
  historyRows,
  milestoneGallery,
  releaseDateLabel,
  rowForKey,
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
   * What the dialog shows. `view` ("tour") is the change list of `milestone` or the "All updates" list (VEC-377; `milestone`
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
  /** A row in the list: that milestone's change list in the same dialog. Seeing the unseen one counts; older ones don't. */
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
 * "What's new" pop-up (VEC-374, list layout VEC-392): a centred panel about 70% of the viewport with the
 * milestone's header (title, date, summary, All updates / Back) fixed on top and every entry stacked below it in
 * one vertically scrolling list (screenshot above title and short Markdown body), then a footer with Got it.
 * A screenshot (or its expand button) opens the ImageLightbox over all of the milestone's screenshots. Every way
 * of closing (X, Esc, backdrop, Got it) goes through `onOpenChange(false)`, so the caller dismisses once. Keep
 * `milestone` set while closing so the exit animation still has content. Phones get a full-height sheet that
 * scrolls the same way. Rules: docs/changelog.md.
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
  /** `milestone`'s list of changes, or the "All updates" list of every milestone (VEC-377). */
  view?: "tour" | "history";
  /** The tour was opened from the list: its header shows a Back to the list instead of the "All updates" link. */
  fromHistory?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens the list (the tour's "All updates" link and Back). Without it the tour shows no link. */
  onShowHistory?: () => void;
  onPick?: (milestone: ChangelogMilestone) => void;
}) {
  // The focus target on open and on switching views: the scrolling change list, or the current row in the list.
  const primaryRef = useRef<HTMLElement>(null);
  const rows = useMemo(() => historyRows(MILESTONES), []);
  // Index and origin stay set after closing: the exit animation needs the image and focus goes back to `from`.
  const [lightbox, setLightbox] = useState<{ open: boolean; index: number; from: HTMLElement | null }>({ open: false, index: 0, from: null });
  const gallery = useMemo(() => (milestone ? milestoneGallery(milestone) : null), [milestone]);
  // Counts openings, so each one starts scrolled to the top while a closing dialog keeps its place through the exit.
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
            // Start on the change list (Arrow/Page keys scroll it) or the current row; Esc still closes.
            e.preventDefault();
            primaryRef.current?.focus({ preventScroll: true });
          }}
          className={cn(
            "flex flex-col gap-0 overflow-hidden p-0",
            // Desktop: a centred panel about 70% of the viewport (VEC-392), never full screen; the body scrolls.
            // The All updates list keeps the width but only grows as tall as its rows (up to the same height).
            "sm:w-[70vw] sm:max-w-[min(1120px,calc(100%-2rem))] sm:min-w-[min(600px,calc(100%-2rem))]",
            history ? "sm:max-h-[78vh]" : "sm:h-[78vh]",
            // Phones: a full-height sheet (no centring transform), clear of the notch and the home indicator.
            "max-sm:inset-0 max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-h-none max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:ring-0",
            "max-sm:pt-[env(safe-area-inset-top)] max-sm:pr-[env(safe-area-inset-right)] max-sm:pb-[env(safe-area-inset-bottom)] max-sm:pl-[env(safe-area-inset-left)]",
          )}
        >
          {history ? (
            <History rows={rows} currentId={milestone?.id ?? null} focusRef={primaryRef as React.RefObject<HTMLButtonElement | null>} onPick={onPick!} />
          ) : (
            <Tour
              // Back to the top every time it opens, and for each milestone picked.
              key={`${milestone!.id}:${session.n}`}
              milestone={milestone!}
              date={date}
              indexOf={gallery!.indexOf}
              focusRef={primaryRef}
              fromHistory={fromHistory}
              onShowHistory={onPick ? onShowHistory : undefined}
              onDone={() => onOpenChange(false)}
              onExpand={(index, from) => setLightbox({ open: true, index, from })}
            />
          )}
        </DialogContent>
      </Dialog>
      {/* A sibling, not a child of the content: the lightbox's own keys must not bubble into the list's handler. */}
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
  focusRef,
  fromHistory,
  onShowHistory,
  onDone,
  onExpand,
}: {
  milestone: ChangelogMilestone;
  date: string;
  indexOf: number[];
  focusRef: React.RefObject<HTMLElement | null>;
  fromHistory: boolean;
  onShowHistory?: () => void;
  onDone: () => void;
  onExpand: (galleryIndex: number, from: HTMLElement | null) => void;
}) {
  const entries = milestone.entries;
  const n = entries.length;
  // Switching in from the list: its row is gone, so focus the change list (on open, onOpenAutoFocus does this).
  useEffect(() => focusRef.current?.focus({ preventScroll: true }), [focusRef]);

  // Arrows, Page Up/Down, Home/End and Space scroll the list natively; keep them from the task list's j/k/arrow
  // shortcuts, which listen on window.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (SCROLL_KEYS.has(e.key)) e.stopPropagation();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 border-b px-5 pt-5 pr-12 pb-4 sm:px-14">
        {/* Same column as the entries below, so the header lines up with them. */}
        <div className="mx-auto w-full max-w-[760px]">
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
          <DialogTitle className="text-[16px] leading-snug font-semibold tracking-[-0.01em] text-balance">{milestone.title}</DialogTitle>
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
        </div>
      </header>

      {/* The one scrolling part: header and footer stay put. Focusable (no ring: it's the whole body) so the
          keyboard scrolls it. */}
      <div
        ref={focusRef as React.RefObject<HTMLDivElement | null>}
        tabIndex={0}
        role="region"
        aria-label="Changes in this release"
        data-whats-new-scroll=""
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain outline-none"
      >
        <ol className="mx-auto flex max-w-[calc(760px+7rem)] flex-col px-5 sm:px-14">
          {entries.map((entry, i) => (
            <Entry key={i} entry={entry} first={i === 0} eager={i < 2} galleryIndex={indexOf[i]} onExpand={onExpand} />
          ))}
        </ol>
      </div>

      <footer className="flex shrink-0 items-center gap-3 border-t px-5 py-3 sm:px-7">
        <span className="text-[12px] text-faint">{changeCountLabel(n)}</span>
        <Button size="sm" data-whats-new-primary="" onClick={onDone} className="ml-auto min-w-20">
          Got it
        </Button>
      </footer>
    </div>
  );
}

/** Keys that scroll the change list; they stay inside the dialog. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

/** One change in the list: screenshot (capped height, expandable) above its title and Markdown body. */
function Entry({
  entry,
  first,
  eager,
  galleryIndex,
  onExpand,
}: {
  entry: ChangelogMilestone["entries"][number];
  first: boolean;
  eager: boolean;
  galleryIndex: number;
  onExpand: (galleryIndex: number, from: HTMLElement | null) => void;
}) {
  const html = useMemo(() => markdownToHtml(entry.body), [entry.body]);
  const [failed, setFailed] = useState(false);
  const expandRef = useRef<HTMLButtonElement>(null);
  return (
    <li data-whats-new-entry="" className={cn("py-6", !first && "border-t")}>
      {entry.image && (
        // 16:10 box, as wide as the column but never taller than ~50% of the viewport (short windows).
        <figure className="aimpoint-image relative aspect-[16/10] w-full max-w-[min(100%,calc(50vh*1.6))] overflow-hidden rounded-[10px] bg-chip ring-1 ring-border">
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
                loading={eager ? "eager" : "lazy"}
                onError={() => setFailed(true)}
                onClick={() => galleryIndex >= 0 && onExpand(galleryIndex, expandRef.current)}
                className="absolute inset-0 block size-full cursor-zoom-in object-contain select-none"
              />
              {galleryIndex >= 0 && (
                <button
                  ref={expandRef}
                  type="button"
                  aria-label={`Expand screenshot: ${entry.title}`}
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
      <h3 className={cn("text-[14.5px] leading-snug font-semibold", entry.image && "mt-4")}>{entry.title}</h3>
      {/* Repo-authored Markdown (src/content/changelog), rendered by the same converter as agent descriptions. */}
      <div className="prose-aimpoint mt-1.5" dangerouslySetInnerHTML={{ __html: html }} />
    </li>
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
