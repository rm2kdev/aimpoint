"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArchiveIcon,
  BotIcon,
  ChartNoAxesColumnIcon,
  CheckIcon,
  CircleUserIcon,
  ChevronsUpDownIcon,
  DownloadIcon,
  InboxIcon,
  LayersIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SunIcon,
  UserIcon,
  UsersIcon,
  GlobeIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useOrg } from "@/components/org-provider";
import { Kbd, ProjectDot, UserAvatar } from "@/components/bits";
import { Logo } from "@/components/logo";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SortableList, useDropTarget, type SortableHandleProps, type SortableItemState } from "@/components/ui/sortable-list";
import { useDragStore } from "@/components/ui/drag-provider";
import { toast } from "sonner";
import { logoutAction } from "@/app/actions/auth";
import { moveTaskAction } from "@/app/actions/tasks";
import { startInstall, useInstallState } from "@/components/install-prompt";
import { accountPath, analyticsPath, orgPath, projectPath, withTask } from "@/lib/paths";
import { SPRING_BLINK_MS, SPRING_DELAY_MS, TASK_DRAG_GROUP } from "@/lib/task-drag";
import { matchStatus, type Project, type Task } from "@/lib/types";
import { ProTag } from "@/components/upgrade-note";

/** Memoised: the shell re-rendering (search, new-task dialog, drawer) doesn't re-render the sidebar. */
export const Sidebar = memo(function Sidebar({ onSearch, onNavigate }: { onSearch: () => void; onNavigate?: () => void }) {
  const { org, orgs, counts, isAdmin, unread, billing } = useOrg();
  const pathname = usePathname();

  return (
    <nav aria-label="Main" className="flex h-full flex-col bg-sidebar px-2.5 pt-3 pb-2">
      <Link
        href={orgPath(org.slug, "my")}
        onClick={onNavigate}
        aria-label="Aimpoint home"
        className="mb-1.5 flex h-9 items-center rounded-lg px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Logo />
      </Link>
      <OrgSwitcher />
      <button
        onClick={onSearch}
        className="mx-0.5 mt-2.5 mb-3.5 flex h-[30px] items-center gap-2 rounded-lg border border-input bg-background px-2.5 text-[13px] text-faint transition-colors hover:border-faint/50"
      >
        <SearchIcon className="size-3.5" />
        Search tasks
        <Kbd className="ml-auto">⌘K</Kbd>
      </button>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <NavItem href={orgPath(org.slug, "inbox")} active={pathname === orgPath(org.slug, "inbox")} icon={<InboxIcon />} count={unread} badge onNavigate={onNavigate}>
          Inbox
        </NavItem>
        <NavItem href={orgPath(org.slug, "my")} active={pathname === orgPath(org.slug, "my")} icon={<UserIcon />} count={counts.my} onNavigate={onNavigate}>
          My Tasks
        </NavItem>
        <NavItem href={orgPath(org.slug, "all")} active={pathname === orgPath(org.slug, "all")} icon={<LayersIcon />} count={counts.all} onNavigate={onNavigate}>
          All Tasks
        </NavItem>

        <SectionLabel action={isAdmin ? { href: `${orgPath(org.slug, "settings", "projects")}?new=1`, label: "New project" } : undefined}>Projects</SectionLabel>
        <SidebarProjects onNavigate={onNavigate} />

        <div className="mt-3">
          <NavItem href={orgPath(org.slug, "archived")} active={pathname === orgPath(org.slug, "archived")} icon={<ArchiveIcon />} count={counts.archived} quiet onNavigate={onNavigate}>
            Archive
          </NavItem>
        </div>

        <SectionLabel>{orgs.length > 1 ? org.name : "Organisation"}</SectionLabel>
        {isAdmin && (
          <NavItem href={analyticsPath(org.slug)} active={pathname === analyticsPath(org.slug)} icon={<ChartNoAxesColumnIcon />} onNavigate={onNavigate} tag={billing.features.analytics ? undefined : <ProTag />}>
            Analytics
          </NavItem>
        )}
        <NavItem href={orgPath(org.slug, "settings", "members")} active={pathname.startsWith(orgPath(org.slug, "settings", "members"))} icon={<UsersIcon />} onNavigate={onNavigate}>
          Members
        </NavItem>
        <NavItem href={orgPath(org.slug, "settings", "bots")} active={pathname.startsWith(orgPath(org.slug, "settings", "bots"))} icon={<BotIcon />} onNavigate={onNavigate}>
          Bots
        </NavItem>
        <NavItem
          href={orgPath(org.slug, "settings", "general")}
          active={["general", "projects", "statuses", "billing"].some((t) => pathname.startsWith(orgPath(org.slug, "settings", t)))}
          icon={<SettingsIcon />}
          onNavigate={onNavigate}
        >
          Settings
        </NavItem>
      </div>

      <div className="mt-2 flex items-center gap-1 border-t border-sidebar-border pt-2">
        <UserMenu onNavigate={onNavigate} />
        <ThemeMenu />
      </div>
    </nav>
  );
});

/**
 * Active projects in the person's own order; drag (or Space + arrows) to reorder (VEC-54). On the desktop
 * sidebar each row is also a spring-loaded drop target for a dragged task (VEC-61): hover it and the row
 * blinks and the project opens mid-drag, so the task can be dropped anywhere in that project's list;
 * release on the row itself to move the task to the top of its status there. Archived projects aren't listed,
 * so they're never targets.
 */
function SidebarProjects({ onNavigate }: { onNavigate?: () => void }) {
  const { org, projects, counts, reorderProjects, statusById, statusesByProject, billing } = useOrg();
  // VEC-256: public projects get a globe after the name (an unpaid org keeps their pages unavailable, so no badge there).
  const publicOn = billing.features.publicForms;
  const pathname = usePathname();
  const router = useRouter();
  const store = useDragStore();
  const active = useMemo(() => projects.filter((p) => !p.archived), [projects]);
  // The mobile drawer's copy (the one with onNavigate) stays mounted off-screen; only the desktop rows take
  // task drops. Spring-loading in the drawer isn't supported: it covers the list a task would be dropped into.
  const springs = !onNavigate;

  // The page a drag started on, recorded when its first spring opens a project. A cancelled drag (Escape,
  // release away from every list) goes back there, so nothing is left half-moved on another page.
  const origin = useRef<string | null>(null);
  useEffect(() => {
    if (!springs || !store) return;
    return store.onEnd((_item, dropped) => {
      const back = origin.current;
      origin.current = null;
      if (!dropped && back && back !== location.pathname + location.search) router.push(back, { scroll: false });
    });
  }, [springs, store, router]);

  // One stable object for every row (VEC-74): with stable props the memoised ProjectRow skips re-rendering
  // when only another row's count, the active page or the order changed.
  const actions = useMemo<ProjectRowActions>(
    () => ({
      // Hovering a task over a closed project: fetch its page now so the dwell hides the request (prod only;
      // the dev router doesn't prefetch).
      prefetch: (p) => router.prefetch(projectPath(org.slug, p.key)),
      spring: (p, task) => {
        if (origin.current === null) origin.current = location.pathname + location.search;
        // Keep the task's pane open if it was; it follows the task to its new key on drop.
        const paneOpen = new URLSearchParams(location.search).get("task") === task.key;
        const href = projectPath(org.slug, p.key);
        router.push(paneOpen ? withTask(href, task.key) : href, { scroll: false });
      },
      /** Released on the row without waiting: top of the same status in that project, one write. */
      quickDrop: async (p, task) => {
        const echo = (t: Task) => window.dispatchEvent(new CustomEvent<Task>("vector:task", { detail: t }));
        const same = task.projectId === p.id;
        // Optimistically keep the stage in the new project, as the server does (VEC-115/117).
        const from = statusById.get(task.statusId);
        const mapped = !same && from ? matchStatus(statusesByProject.get(p.id) ?? [], from)?.id : undefined;
        echo({ ...task, projectId: p.id, statusId: mapped ?? task.statusId });
        const r = await moveTaskAction(org.slug, task.key, { project: same ? undefined : p.id, toTop: true });
        if (!r.ok) {
          echo(task);
          return void toast.error(r.error);
        }
        const moved = r.data ?? task;
        if (r.data) echo(r.data);
        const q = new URLSearchParams(location.search);
        if (q.get("task") === task.key && moved.key !== task.key) {
          q.set("task", moved.key);
          router.replace(`${location.pathname}?${q}`, { scroll: false });
        }
        toast.success(same ? `Moved ${task.key} to the top` : `Moved ${task.key} to ${p.name} as ${moved.key}`, {
          description: task.title,
          action: { label: "Open", onClick: () => router.push(withTask(projectPath(org.slug, p.key), moved.key)) },
        });
      },
    }),
    [org.slug, router, statusById, statusesByProject],
  );

  const projectCounts = counts.projects;
  const renderItem = useCallback(
    (p: Project, { handleProps, isDragging }: SortableItemState) => {
      const href = projectPath(org.slug, p.key);
      return (
        <ProjectRow
          project={p}
          href={href}
          active={pathname === href}
          count={projectCounts[p.id] ?? 0}
          isPublic={p.public && publicOn}
          onNavigate={onNavigate}
          handleProps={handleProps}
          dragging={isDragging}
          springs={springs}
          actions={actions}
        />
      );
    },
    [org.slug, pathname, projectCounts, publicOn, onNavigate, springs, actions],
  );

  return (
    <SortableList
      items={active}
      getId={projectId}
      getLabel={projectName}
      aria-label="Projects"
      onReorder={(ids) => {
        // Applied at once by the provider; it rolls back itself if the server refuses.
        void reorderProjects(ids).then((r) => {
          if (!r.ok) toast.error(r.error || "Couldn't save the project order.");
        });
      }}
      renderItem={renderItem}
    />
  );
}

const projectId = (p: Project) => p.id;
const projectName = (p: Project) => p.name;

interface ProjectRowActions {
  prefetch: (p: Project) => void;
  spring: (p: Project, task: Task) => void;
  quickDrop: (p: Project, task: Task) => Promise<void>;
}

/** Memoised (VEC-74): a count refresh or a reorder re-renders only the rows whose own props changed. */
const ProjectRow = memo(function ProjectRow({
  project: p,
  href,
  active,
  count,
  isPublic,
  onNavigate,
  handleProps,
  dragging,
  springs,
  actions,
}: {
  project: Project;
  href: string;
  active: boolean;
  count: number;
  isPublic: boolean;
  onNavigate?: () => void;
  handleProps?: SortableHandleProps;
  dragging?: boolean;
  springs: boolean;
  actions: ProjectRowActions;
}) {
  const store = useDragStore();
  const [blink, setBlink] = useState(false);
  const blinkTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(blinkTimer.current), []);
  const stopBlink = () => {
    clearTimeout(blinkTimer.current);
    setBlink(false);
  };
  // Both sidebar copies are mounted: give the drawer's (disabled) targets their own ids so they don't replace the desktop ones.
  const targetId = `sidebar-project:${p.id}${springs ? "" : ":drawer"}`;
  const target = useDropTarget<HTMLAnchorElement>(targetId, {
    label: p.name,
    disabled: !springs,
    // Tasks only: a project being reordered (its own list group) never lands here.
    accepts: (item) => item.group === TASK_DRAG_GROUP && !!item.data,
    dwellMs: SPRING_DELAY_MS,
    onHoverStart: () => {
      if (!active) actions.prefetch(p);
    },
    onDwell: (item) => {
      if (active) return; // already open
      setBlink(true);
      blinkTimer.current = setTimeout(() => {
        setBlink(false);
        // Still the same drag, still over this row (moving off cancels the timer through onHoverEnd).
        const snap = store?.get();
        if (snap?.item.id === item.id && snap.over?.kind === "target" && snap.over.id === targetId) actions.spring(p, item.data as Task);
      }, SPRING_BLINK_MS);
    },
    onHoverEnd: stopBlink,
    onDrop: (item) => {
      stopBlink();
      void actions.quickDrop(p, item.data as Task);
    },
  });
  const over = target.isOver && target.canDrop;
  return (
    <NavItem
      href={href}
      active={active}
      icon={<ProjectDot color={p.color} className="mx-[4px] size-2.5" />}
      count={count}
      onNavigate={onNavigate}
      handleProps={handleProps}
      dragging={dragging}
      targetRef={target.ref}
      dropState={blink ? "spring" : over ? "over" : undefined}
      tag={
        isPublic ? (
          <span data-public-badge title="Public project" aria-label="Public" role="img" className="-ml-1 flex shrink-0 text-faint">
            <GlobeIcon className="!size-3" />
          </span>
        ) : undefined
      }
    >
      {p.name}
    </NavItem>
  );
});

function NavItem({
  href,
  active,
  icon,
  count,
  quiet,
  badge,
  children,
  onNavigate,
  handleProps,
  dragging,
  targetRef,
  dropState,
  tag,
}: {
  href: string;
  active: boolean;
  icon: React.ReactNode;
  count?: number;
  /** count is informational, not "to do": render it fainter */
  quiet?: boolean;
  /** count is unread: render it as a brand pill */
  badge?: boolean;
  children: React.ReactNode;
  onNavigate?: () => void;
  /** Row is reorderable: spread the SortableList handle props on the link. */
  handleProps?: SortableHandleProps;
  /** Lifted with the keyboard or dragged: keep a focus ring on it. */
  dragging?: boolean;
  /** Drop target (spring-loaded project row). */
  targetRef?: React.Ref<HTMLAnchorElement>;
  /** A dragged task is over the row ("over"), or it's blinking before the project opens ("spring"). */
  dropState?: "over" | "spring";
  /** Shown after the label in place of a count, e.g. the "Pro" tag on a feature the plan lacks (VEC-226). */
  tag?: React.ReactNode;
}) {
  return (
    <Link
      ref={targetRef}
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      data-drop-over={dropState ? dropState : undefined}
      {...handleProps}
      className={cn(
        "group mb-px flex h-[30px] shrink-0 items-center gap-2.5 rounded-[7px] px-2 text-[13.5px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [&_svg]:size-4 [&_svg]:shrink-0",
        active ? "bg-selected font-medium text-selected-foreground" : "text-sidebar-foreground hover:bg-sidebar-accent",
        dragging && "cursor-grabbing",
        dropState && "bg-brand/10 text-brand shadow-[inset_0_0_0_1px_var(--color-brand)] hover:bg-brand/10",
        dropState === "spring" && "spring-blink",
      )}
    >
      <span className={cn("flex", active ? "text-selected-foreground" : "text-muted-foreground")}>{icon}</span>
      <span className="truncate">{children}</span>
      {tag}
      {count !== undefined && count > 0 && badge ? (
        <span className="tabular ml-auto grid h-[18px] min-w-[18px] place-items-center rounded-full bg-brand px-1.5 font-mono text-[11px] font-medium text-white" aria-label={`${count} unread`}>
          {count > 99 ? "99+" : count}
        </span>
      ) : count !== undefined && count > 0 ? (
        <span className={cn("tabular ml-auto font-mono text-[11.5px]", active ? "text-selected-foreground/80" : quiet ? "text-faint/70" : "text-faint")}>{count}</span>
      ) : null}
    </Link>
  );
}

function SectionLabel({ children, action }: { children: React.ReactNode; action?: { href: string; label: string } }) {
  return (
    <div className="group/sec mt-4 mb-1 flex h-6 items-center px-2">
      <span className="truncate text-[11.5px] font-medium text-faint">{children}</span>
      {action && (
        <Link
          href={action.href}
          aria-label={action.label}
          title={action.label}
          className="ml-auto grid size-5 place-items-center rounded text-faint opacity-0 transition-opacity group-hover/sec:opacity-100 hover:bg-sidebar-accent hover:text-foreground focus-visible:opacity-100"
        >
          <PlusIcon className="size-3.5" />
        </Link>
      )}
    </div>
  );
}

function OrgSwitcher() {
  const { org, orgs } = useOrg();
  const router = useRouter();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-left transition-colors outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring">
        <span className="grid size-5 shrink-0 place-items-center rounded-[5px] border border-sidebar-border bg-background text-[11px] font-semibold text-foreground">
          {org.name[0]?.toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{org.name}</span>
        <ChevronsUpDownIcon className="size-3.5 text-faint" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel className="text-xs font-normal text-faint">Organisations</DropdownMenuLabel>
        {orgs.map((o) => (
          <DropdownMenuItem key={o.id} onSelect={() => router.push(orgPath(o.slug, "my"))} className="gap-2.5">
            <span className="grid size-5 place-items-center rounded-[5px] bg-foreground text-[10.5px] font-semibold text-background">
              {o.name[0]?.toUpperCase()}
            </span>
            <span className="truncate">{o.name}</span>
            {o.id === org.id && <CheckIcon className="ml-auto size-3.5 text-brand" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => router.push("/onboarding")} className="gap-2.5">
          <PlusIcon className="size-4" /> New organisation
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => logoutAction()} className="gap-2.5">
          <LogOutIcon className="size-4" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UserMenu({ onNavigate }: { onNavigate?: () => void }) {
  const { org, me } = useOrg();
  const router = useRouter();
  const install = useInstallState();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Account menu"
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1.5 py-1 text-left transition-colors outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        <UserAvatar id={me.id} name={me.name} image={me.image} size={24} />
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-[13px] font-medium">{me.name}</span>
          <span className="block text-[11.5px] text-faint">{me.role === "admin" ? "Admin" : "Member"}</span>
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-60">
        <DropdownMenuLabel className="min-w-0 font-normal leading-tight">
          <span className="block truncate text-[13px] font-medium">{me.name}</span>
          <span className="block truncate text-xs text-faint">{me.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            onNavigate?.();
            router.push(accountPath(org.slug));
          }}
          className="gap-2.5"
        >
          <CircleUserIcon className="size-4" /> Account settings
        </DropdownMenuItem>
        {/* Find the install prompt again after dismissing it (VEC-157); absent once installed or where unsupported. */}
        {install.mode && (
          <DropdownMenuItem
            onSelect={() => {
              onNavigate?.();
              startInstall();
            }}
            className="gap-2.5"
          >
            <DownloadIcon className="size-4" /> Install app
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => logoutAction()} className="gap-2.5">
          <LogOutIcon className="size-4" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ThemeMenu() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const Icon = !mounted ? MonitorIcon : resolvedTheme === "dark" ? MoonIcon : SunIcon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Theme"
        className="grid size-7 place-items-center rounded-md text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-40">
        {(
          [
            ["light", "Light", SunIcon],
            ["dark", "Dark", MoonIcon],
            ["system", "System", MonitorIcon],
          ] as const
        ).map(([v, label, I]) => (
          <DropdownMenuItem key={v} onSelect={() => setTheme(v)} className="gap-2.5">
            <I className="size-4" /> {label}
            {mounted && theme === v && <CheckIcon className="ml-auto size-3.5 text-brand" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
