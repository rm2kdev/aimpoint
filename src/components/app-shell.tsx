"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { MenuIcon } from "lucide-react";
import { toast } from "sonner";
import { useOrg, useOrgEvents } from "@/components/org-provider";
import { notificationHeadline } from "@/lib/notification-text";
import { markNotificationsRead } from "@/app/actions/notifications";
import { Sidebar } from "@/components/sidebar";
import { CommandMenu } from "@/components/command-menu";
import { BotStatusTray } from "@/components/bot-status-tray";
import { NewTaskDialog, type NewTaskDefaults } from "@/components/new-task-dialog";
import { cn } from "@/lib/utils";
import { DragProvider } from "@/components/ui/drag-provider";
import { InstallPrompt } from "@/components/install-prompt";
import { orgPath, taskPath } from "@/lib/paths";

interface ShellCtx {
  newTask: (defaults?: NewTaskDefaults) => void;
  /** The current view registers what a new task should default to (e.g. its project). */
  setViewDefaults: (d: NewTaskDefaults) => void;
  openSearch: () => void;
  openNav: () => void;
}
const Ctx = createContext<ShellCtx | null>(null);
export const useShell = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error("useShell outside AppShell");
  return c;
};

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [search, setSearch] = useState(false);
  const [creating, setCreating] = useState<NewTaskDefaults | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  // The drawer's sidebar copy is mounted the first time the drawer opens, then kept (so it slides out with
  // its content). On desktop it never opens, so there's only one sidebar rendering, subscribing to drags
  // and re-rendering on count refreshes (VEC-74).
  const [drawerMounted, setDrawerMounted] = useState(false);
  if (navOpen && !drawerMounted) setDrawerMounted(true);
  const closeNav = useCallback(() => setNavOpen(false), []);
  const openSearch = useCallback(() => setSearch(true), []);
  const pathname = usePathname();
  useEffect(() => setNavOpen(false), [pathname]);

  const viewDefaults = useRef<NewTaskDefaults>({});
  const setViewDefaults = useCallback((d: NewTaskDefaults) => void (viewDefaults.current = d), []);
  const newTask = useCallback((d?: NewTaskDefaults) => setCreating({ ...viewDefaults.current, ...d }), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearch((s) => !s);
        return;
      }
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector("[role=dialog]")) return;
      if (e.key === "n" || e.key === "c") {
        e.preventDefault();
        newTask();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newTask]);

  return (
    <Ctx.Provider value={{ newTask, setViewDefaults, openSearch: () => setSearch(true), openNav: () => setNavOpen(true) }}>
      {/* Drag sessions live above the page so a drag survives client-side navigation. */}
      <DragProvider>
      {/* Column: the app row fills what's left above the bot status tray, so every scroll area and the task pane end above it. */}
      <div className="flex h-dvh flex-col overflow-hidden">
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          {/* desktop sidebar */}
          <aside className="hidden w-[248px] shrink-0 border-r border-sidebar-border lg:block">
            <Sidebar onSearch={openSearch} />
          </aside>
          {/* mobile drawer */}
          <div
            className={cn("fixed inset-0 z-40 bg-black/30 transition-opacity lg:hidden", navOpen ? "opacity-100" : "pointer-events-none opacity-0")}
            onClick={() => setNavOpen(false)}
            aria-hidden
          />
          <aside
            className={cn(
              "fixed inset-y-0 left-0 z-50 w-[272px] border-r border-sidebar-border shadow-xl transition-transform duration-200 ease-out lg:hidden",
              navOpen ? "translate-x-0" : "pointer-events-none -translate-x-full",
            )}
            aria-hidden={!navOpen}
            inert={!navOpen}
          >
            {drawerMounted && <Sidebar onSearch={openSearch} onNavigate={closeNav} />}
          </aside>
          <div className="flex min-w-0 flex-1">{children}</div>
          {/* Add to Home Screen (VEC-157): floats over the content, above the bot tray, clear of the desktop sidebar. */}
          <div className="pointer-events-none absolute inset-x-3 bottom-3 z-30 flex justify-center sm:inset-x-auto sm:left-4 lg:left-[264px]">
            <InstallPrompt />
          </div>
        </div>
        <BotStatusTray />
      </div>
      <NotificationToasts />
      <CommandMenu open={search} onOpenChange={setSearch} />
      <NewTaskDialog defaults={creating} onClose={() => setCreating(null)} />
      </DragProvider>
    </Ctx.Provider>
  );
}

/** A live toast for each new notification, unless the inbox is already on screen. */
function NotificationToasts() {
  const { org, me, memberById, setUnread } = useOrg();
  const router = useRouter();
  const pathname = usePathname();
  useOrgEvents((e) => {
    if (e.type !== "notification" || e.userId !== me.id || pathname === orgPath(org.slug, "inbox")) return;
    const n = e.notification;
    const actor = n.actorId ? memberById.get(n.actorId) : undefined;
    toast(notificationHeadline(n, actor?.name ?? null), {
      description: n.detail && n.kind !== "mentioned" ? `${n.taskTitle} · ${n.detail}` : n.taskTitle,
      action: {
        label: "Open",
        onClick: () => {
          setUnread((c) => c - 1);
          void markNotificationsRead(org.slug, [n.id]);
          router.push(taskPath(org.slug, n.taskKey, "inbox"));
        },
      },
    });
  });
  return null;
}

export function MobileNavButton() {
  const { openNav } = useShell();
  return (
    <button
      onClick={openNav}
      aria-label="Open navigation"
      className="-ml-1.5 grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent lg:hidden"
    >
      <MenuIcon className="size-[18px]" />
    </button>
  );
}
