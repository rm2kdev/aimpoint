"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AtSignIcon, CheckCheckIcon, CircleCheckIcon, EyeIcon, HourglassIcon, InboxIcon, UnplugIcon, UserPlusIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useOrg, useOrgEvents } from "@/components/org-provider";
import { MobileNavButton } from "@/components/app-shell";
import { MemberAvatar } from "@/components/bits";
import { TaskPane } from "@/components/task-pane";
import { Button } from "@/components/ui/button";
import { timeAgo } from "@/lib/format";
import { notificationHeadline } from "@/lib/notification-text";
import { markNotificationsRead } from "@/app/actions/notifications";
import type { Notification } from "@/lib/types";

const KIND_ICON = {
  assigned: UserPlusIcon,
  mentioned: AtSignIcon,
  ready: CircleCheckIcon,
  review: EyeIcon,
  undelivered: UnplugIcon,
} as const;

export function Inbox({ initial }: { initial: Notification[] }) {
  const { org, memberById, setUnread, me } = useOrg();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const selectedKey = params.get("task");
  const [items, setItems] = useState(initial);
  // Read here (or in another tab) since the server rendered `initial`. Opening a task refreshes the page,
  // and that render can predate the read: never let it bring the unread dot back.
  const readIds = useRef(new Set<string>());
  const allRead = useRef<number>(0);
  useEffect(() => {
    setItems((prev) => {
      const fresh = initial.map((n) => (readIds.current.has(n.id) || Date.parse(n.createdAt) <= allRead.current ? { ...n, read: true } : n));
      const live = prev.filter((p) => !fresh.some((n) => n.id === p.id) && Date.parse(p.createdAt) > Date.parse(fresh[0]?.createdAt ?? "0"));
      return [...live, ...fresh];
    });
  }, [initial]);

  useOrgEvents((e) => {
    if (e.type === "notification" && e.userId === me.id) {
      setItems((list) => (list.some((x) => x.id === e.notification.id) ? list : [e.notification, ...list]));
    } else if (e.type === "notifications.read" && e.userId === me.id) {
      if (e.ids === "all") allRead.current = Date.now();
      else e.ids.forEach((id) => readIds.current.add(id));
      setItems((list) => list.map((x) => (e.ids === "all" || e.ids.includes(x.id) ? { ...x, read: true } : x)));
    } else if (e.type === "task.upsert") {
      // Keep keys and titles current (a task can be renamed or move project).
      setItems((list) =>
        list.some((x) => x.taskId === e.task.id)
          ? list.map((x) => (x.taskId === e.task.id ? { ...x, taskKey: e.task.key, taskTitle: e.task.title, taskArchived: !!e.task.archivedAt } : x))
          : list,
      );
    } else if (e.type === "task.delete") {
      setItems((list) => list.filter((x) => x.taskId !== e.taskId));
    }
  });

  const open = useCallback(
    (key: string | null) => router.replace(key ? `${pathname}?task=${encodeURIComponent(key)}` : pathname, { scroll: false }),
    [pathname, router],
  );

  const markRead = async (ids: string[] | "all") => {
    const unreadIds = items.filter((x) => !x.read && (ids === "all" || ids.includes(x.id))).map((x) => x.id);
    if (!unreadIds.length) return;
    unreadIds.forEach((id) => readIds.current.add(id));
    setItems((list) => list.map((x) => (unreadIds.includes(x.id) ? { ...x, read: true } : x)));
    setUnread((n) => n - unreadIds.length);
    const r = await markNotificationsRead(org.slug, ids === "all" ? "all" : unreadIds);
    if (!r.ok) toast.error(r.error);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || e.metaKey || e.ctrlKey) return;
      if (document.querySelector("[role=dialog],[data-radix-popper-content-wrapper]")) return;
      if (e.key === "Escape" && selectedKey) open(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedKey, open]);

  const unread = items.filter((x) => !x.read).length;
  // Several notifications can point at one task: highlight the newest of them.
  const selectedId = items.find((x) => x.taskKey === selectedKey)?.id;

  return (
    <div className="flex min-w-0 flex-1">
      <section className={cn("flex min-w-0 flex-1 flex-col", selectedKey && "max-lg:hidden")} aria-label="Inbox">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 sm:px-7">
          <MobileNavButton />
          <h1 className="truncate text-[15px] font-semibold tracking-[-0.01em]">Inbox</h1>
          <span className="tabular font-mono text-[12px] text-faint">{unread || ""}</span>
          <div className="ml-auto">
            <Button variant="ghost" className="h-[30px] gap-2 px-2.5 text-[13px]" disabled={!unread} onClick={() => markRead("all")}>
              <CheckCheckIcon className="size-3.5" /> Mark all read
            </Button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-16 sm:px-4">
          {items.length === 0 ? (
            <div className="mx-auto flex max-w-sm flex-col items-center py-[18vh] text-center">
              <InboxIcon className="mb-4 size-9 stroke-1 text-faint/60" />
              <h2 className="text-[15px] font-semibold">Nothing here yet</h2>
              <p className="mt-1 text-[13.5px] text-muted-foreground">
                You&rsquo;ll hear about tasks assigned to you, comments that mention you, and tasks of yours that become ready once what they depend on is done.
              </p>
            </div>
          ) : (
            <ul className="mt-1 flex flex-col gap-1">
              {items.map((n) => {
                const actor = n.actorId ? memberById.get(n.actorId) : undefined;
                const Icon = KIND_ICON[n.kind];
                const selected = n.id === selectedId;
                return (
                  <li key={n.id}>
                    <button
                      onClick={() => {
                        open(n.taskKey);
                        // Opening the task catches you up on everything about it.
                        markRead(items.filter((x) => x.taskId === n.taskId).map((x) => x.id));
                      }}
                      aria-current={selected ? "true" : undefined}
                      className={cn(
                        "grid w-full grid-cols-[10px_28px_minmax(0,1fr)_auto] items-start gap-3 rounded-[9px] px-3 py-2.5 text-left transition-colors",
                        selected ? "bg-selected" : "hover:bg-accent",
                      )}
                    >
                      <span className="mt-[9px] flex justify-center">{!n.read && <span className="size-2 rounded-full bg-brand" aria-label="Unread" />}</span>
                      <span className="relative mt-0.5">
                        {actor ? (
                          <MemberAvatar member={actor} id={actor.id} size={24} />
                        ) : (
                          <span className="grid size-6 place-items-center rounded-full bg-chip text-muted-foreground">
                            <Icon className="size-3.5" />
                          </span>
                        )}
                        {actor && (
                          <span className="absolute -right-1.5 -bottom-1 grid size-4 place-items-center rounded-full bg-background text-muted-foreground ring-1 ring-border">
                            <Icon className="size-2.5" />
                          </span>
                        )}
                      </span>
                      <span className="min-w-0">
                        <span className={cn("block truncate text-[13.5px]", n.read ? "text-muted-foreground" : "font-medium")}>
                          {notificationHeadline(n, actor?.name ?? null)}
                        </span>
                        <span className="block truncate text-[13px] text-muted-foreground">
                          {n.taskTitle}
                          {n.taskArchived && <span className="ml-2 rounded-[4px] bg-chip px-1.5 text-[11.5px]">Archived</span>}
                        </span>
                        {n.detail && (
                          <span className="mt-0.5 flex items-center gap-1.5 truncate text-[12.5px] text-faint">
                            {n.kind === "assigned" && n.detail.startsWith("Waiting") && <HourglassIcon className="size-3 shrink-0" />}
                            <span className="truncate">{n.kind === "mentioned" ? `“${n.detail}”` : n.kind === "ready" && actor ? `${n.detail} (${actor.name})` : n.detail}</span>
                          </span>
                        )}
                      </span>
                      <time className="mt-0.5 text-[12px] whitespace-nowrap text-faint" dateTime={n.createdAt} title={new Date(n.createdAt).toLocaleString()}>
                        {timeAgo(n.createdAt)}
                      </time>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
      {selectedKey && <TaskPane key={selectedKey} taskKey={selectedKey} onClose={() => open(null)} onTask={() => {}} />}
    </div>
  );
}
