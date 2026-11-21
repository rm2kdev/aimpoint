"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { ChartNoAxesColumnIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useOrg } from "@/components/org-provider";
import { TaskStatusRing } from "@/components/task-status-ring";
import { useLiveTasks } from "@/components/live-tasks";
import type { Task } from "@/lib/types";
import { MobileNavButton } from "@/components/app-shell";
import { orgPath, taskPath } from "@/lib/paths";

/* ---------------- shell ---------------- */

export const SETTINGS_TABS = [
  ["general", "General"],
  ["members", "Members"],
  ["bots", "Bots"],
  ["projects", "Projects"],
  ["flows", "Flows"],
  ["billing", "Billing"],
  ["debug", "Debug"],
] as const;

/** Header + tab bar shared by every settings page. Tabs are real routes, so detail pages keep their tab lit. */
/** Room kept between the active tab and an edge fade when it's scrolled into view. */
const TAB_FADE = 24;

/**
 * The settings tab strip. On phones it's wider than the header, so it scrolls
 * sideways: the active tab is scrolled into view (the nav only, never the page)
 * and an edge fades out on each side that has more tabs.
 */
function SettingsTabs() {
  const { org, billing, isAdmin } = useOrg();
  const pathname = usePathname();
  const navRef = useRef<HTMLElement>(null);
  const placed = useRef(false);
  const [edges, setEdges] = useState({ left: false, right: false });

  // Bring the active tab fully into view, clear of the fades.
  useEffect(() => {
    const nav = navRef.current;
    const link = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !link) return;
    const start = link.offsetLeft;
    const end = start + link.offsetWidth;
    const pad = nav.scrollWidth > nav.clientWidth ? TAB_FADE : 0;
    let left = nav.scrollLeft;
    if (start - pad < left) left = start - pad;
    else if (end + pad > left + nav.clientWidth) left = end + pad - nav.clientWidth;
    if (left !== nav.scrollLeft) nav.scrollTo({ left: Math.max(0, left), behavior: placed.current ? "smooth" : "instant" });
    placed.current = true;
  }, [pathname]);

  // Track which sides have more tabs, for the fades.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const measure = () => {
      const max = nav.scrollWidth - nav.clientWidth;
      const left = nav.scrollLeft > 1;
      const right = max - nav.scrollLeft > 1;
      setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(nav);
    nav.addEventListener("scroll", measure, { passive: true });
    return () => {
      ro.disconnect();
      nav.removeEventListener("scroll", measure);
    };
  }, []);

  const fade = (on: boolean) => (on ? `transparent, black ${TAB_FADE}px` : "black, black");
  const mask = edges.left || edges.right ? `linear-gradient(to right, ${fade(edges.left)}, black calc(100% - ${TAB_FADE}px), ${edges.right ? "transparent" : "black"})` : undefined;

  return (
    <nav
      ref={navRef}
      className="relative ml-4 flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
      aria-label="Settings sections"
      data-overflow-left={edges.left || undefined}
      data-overflow-right={edges.right || undefined}
    >
      {SETTINGS_TABS.filter(([t]) => (t !== "billing" || billing.enabled) && (t !== "debug" || (billing.debugAvailable && isAdmin))).map(([t, label]) => {
        const href = orgPath(org.slug, "settings", t);
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={t}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex h-7 shrink-0 items-center rounded-md px-2.5 text-[13px] transition-colors",
              active ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

export function SettingsFrame({ children }: { children: React.ReactNode }) {
  const { isAdmin } = useOrg();
  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label="Settings">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 sm:px-7">
        <MobileNavButton />
        <h1 className="text-[15px] font-semibold tracking-[-0.01em]">Settings</h1>
        <SettingsTabs />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="max-w-[1100px] px-4 py-6 sm:px-7">
          {!isAdmin && (
            <p className="mb-6 rounded-lg border border-border bg-sidebar px-3.5 py-2.5 text-[13px] text-muted-foreground">
              You&rsquo;re a member. Only admins can change organisation settings.
            </p>
          )}
          {children}
        </div>
      </div>
    </section>
  );
}

/* ---------------- sections ---------------- */

/** Title + explanation on the left, controls on the right. */
export function SettingsRow({ id, title, desc, children }: { id?: string; title: string; desc: React.ReactNode; children: React.ReactNode }) {
  return (
    <div id={id} className="scroll-mt-4 grid gap-4 border-b border-border py-7 first:pt-1 last:border-0 md:grid-cols-[280px_minmax(0,1fr)] md:gap-10">
      <div>
        <h2 className="text-[14px] font-semibold">{title}</h2>
        <div className="mt-1 text-[13px] text-muted-foreground">{desc}</div>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/* ---------------- people & bots: list ---------------- */

export function EntityList({ children }: { children: React.ReactNode }) {
  return <ul className="divide-y divide-border rounded-[10px] border border-border">{children}</ul>;
}

/** One clickable row in the Members or Bots list. Same anatomy for both. */
export function EntityRow({
  href,
  avatar,
  name,
  tags,
  subtitle,
  meta,
  dimmed,
}: {
  href: string;
  avatar: React.ReactNode;
  name: string;
  tags?: React.ReactNode;
  subtitle: React.ReactNode;
  meta?: React.ReactNode;
  /** Grays the name, subtitle and meta (a disabled bot, VEC-345); the row still opens. */
  dimmed?: boolean;
}) {
  return (
    <li data-dimmed={dimmed || undefined}>
      <Link
        href={href}
        className="group flex items-center gap-3 px-3.5 py-2.5 transition-colors first:rounded-t-[10px] last:rounded-b-[10px] hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
      >
        <span className="shrink-0">{avatar}</span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="flex items-center gap-1.5 text-[13.5px] font-medium">
            <span className={cn("truncate", dimmed && "text-muted-foreground")}>{name}</span>
            {tags}
          </span>
          <span className={cn("mt-0.5 block truncate text-[12.5px] text-muted-foreground", dimmed && "opacity-70")}>{subtitle}</span>
        </span>
        {meta && <span className={cn("tabular hidden shrink-0 text-right text-[12px] leading-tight text-faint sm:block", dimmed && "opacity-70")}>{meta}</span>}
        <ChevronRightIcon className="size-4 shrink-0 text-faint transition-transform group-hover:translate-x-0.5" />
      </Link>
    </li>
  );
}

export function Tag({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "faint" }) {
  return tone === "faint" ? (
    <span className="shrink-0 font-normal text-faint">{children}</span>
  ) : (
    <span className="shrink-0 rounded-[4px] bg-chip px-1.5 py-px text-[11.5px] font-medium text-muted-foreground">{children}</span>
  );
}

/** The "Disabled" badge on a switched-off bot (VEC-345), in the list and on its page. */
export function DisabledTag() {
  return <span className="shrink-0 rounded-[4px] border border-border px-1.5 py-px text-[11.5px] font-medium text-muted-foreground">Disabled</span>;
}

/* ---------------- people & bots: detail ---------------- */

/** Back link + identity block at the top of a member or bot page. */
export function DetailHeader({
  back,
  avatar,
  name,
  tags,
  subtitle,
  action,
}: {
  back: { href: string; label: string };
  avatar: React.ReactNode;
  name: string;
  tags?: React.ReactNode;
  subtitle: React.ReactNode;
  /** Shown at the right of the identity row (e.g. AnalyticsLink). */
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-6">
      <Link href={back.href} className="-ml-1 inline-flex h-7 items-center gap-0.5 rounded-md pr-2 pl-1 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground">
        <ChevronLeftIcon className="size-4" /> {back.label}
      </Link>
      <div className="mt-4 flex items-center gap-3.5">
        {avatar}
        <div className="min-w-0 leading-tight">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[18px] font-semibold tracking-[-0.015em]">{name}</h2>
            {tags}
          </div>
          <div className="mt-1 truncate text-[13px] text-muted-foreground">{subtitle}</div>
        </div>
        {action ? <div className="ml-auto shrink-0">{action}</div> : null}
      </div>
    </div>
  );
}

/** Open tasks assigned to a person or bot. */
export function WorkList({ tasks: initial, emptyText, note }: { tasks: Task[]; emptyText: string; note?: (t: Task) => string | undefined }) {
  const { org } = useOrg();
  const tasks = useLiveTasks(initial); // rings follow live updates (VEC-381)
  if (!tasks.length) return <p className="text-[13px] text-muted-foreground">{emptyText}</p>;
  return (
    <ul className="grid gap-1">
      {tasks.map((t) => (
        <li key={t.id}>
          <Link
            href={taskPath(org.slug, t.key, t.archivedAt ? "archived" : "all")}
            className="-mx-3 flex h-9 items-center gap-3 rounded-[9px] px-3 text-[13.5px] transition-colors hover:bg-accent"
          >
            <TaskStatusRing task={t} size={16} />
            <span className="truncate">{t.title}</span>
            {note?.(t) && <span className="shrink-0 rounded-[4px] bg-chip px-1.5 py-px text-[11.5px] font-medium text-muted-foreground">{note(t)}</span>}
            <span className="tabular ml-auto font-mono text-[12px] text-faint">{t.key}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/* ---------------- actions ---------------- */

export function useAction() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, success?: string, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.error);
      else {
        if (success) toast.success(success);
        if (after) after();
        else router.refresh();
      }
    });
  return { pending, run };
}

/** "Analytics" link from a detail page to the analytics screen with that entity's filter (VEC-135). Render it for admins only. */
export function AnalyticsLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      aria-label={label}
      title={label}
      data-analytics-link
      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <ChartNoAxesColumnIcon className="size-3.5" /> Analytics
    </Link>
  );
}
