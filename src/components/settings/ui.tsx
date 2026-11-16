"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useOrg } from "@/components/org-provider";
import { TaskStatusRing } from "@/components/task-status-ring";
import type { Task } from "@/lib/types";
import { MobileNavButton } from "@/components/app-shell";
import { orgPath, taskPath } from "@/lib/paths";

/* ---------------- shell ---------------- */

export const SETTINGS_TABS = [
  ["general", "General"],
  ["projects", "Projects"],
  ["members", "Members"],
  ["bots", "Bots"],
  ["roles", "Bot roles"],
] as const;

/** Header + tab bar shared by every settings page. Tabs are real routes, so detail pages keep their tab lit. */
export function SettingsFrame({ children }: { children: React.ReactNode }) {
  const { org, isAdmin } = useOrg();
  const pathname = usePathname();
  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label="Settings">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 sm:px-7">
        <MobileNavButton />
        <h1 className="text-[15px] font-semibold tracking-[-0.01em]">Settings</h1>
        <nav className="ml-4 flex min-w-0 items-center gap-1 overflow-x-auto" aria-label="Settings sections">
          {SETTINGS_TABS.map(([t, label]) => {
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
export function SettingsRow({ title, desc, children }: { title: string; desc: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid gap-4 border-b border-border py-7 first:pt-1 last:border-0 md:grid-cols-[280px_minmax(0,1fr)] md:gap-10">
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
}: {
  href: string;
  avatar: React.ReactNode;
  name: string;
  tags?: React.ReactNode;
  subtitle: React.ReactNode;
  meta?: React.ReactNode;
}) {
  return (
    <li>
      <Link
        href={href}
        className="group flex items-center gap-3 px-3.5 py-2.5 transition-colors first:rounded-t-[10px] last:rounded-b-[10px] hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
      >
        <span className="shrink-0">{avatar}</span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="flex items-center gap-1.5 text-[13.5px] font-medium">
            <span className="truncate">{name}</span>
            {tags}
          </span>
          <span className="mt-0.5 block truncate text-[12.5px] text-muted-foreground">{subtitle}</span>
        </span>
        {meta && <span className="tabular hidden shrink-0 text-right text-[12px] leading-tight text-faint sm:block">{meta}</span>}
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

/* ---------------- people & bots: detail ---------------- */

/** Back link + identity block at the top of a member or bot page. */
export function DetailHeader({
  back,
  avatar,
  name,
  tags,
  subtitle,
}: {
  back: { href: string; label: string };
  avatar: React.ReactNode;
  name: string;
  tags?: React.ReactNode;
  subtitle: React.ReactNode;
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
      </div>
    </div>
  );
}

/** Open tasks assigned to a person or bot. */
export function WorkList({ tasks, emptyText, note }: { tasks: Task[]; emptyText: string; note?: (t: Task) => string | undefined }) {
  const { org } = useOrg();
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
