"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useState } from "react";
import {
  ArchiveIcon,
  BotIcon,
  CheckIcon,
  CircleUserIcon,
  ChevronsUpDownIcon,
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
import { SortableList, type SortableHandleProps } from "@/components/ui/sortable-list";
import { toast } from "sonner";
import { logoutAction } from "@/app/actions/auth";
import { accountPath, orgPath, projectPath } from "@/lib/paths";

export function Sidebar({ onSearch, onNavigate }: { onSearch: () => void; onNavigate?: () => void }) {
  const { org, orgs, counts, isAdmin, unread } = useOrg();
  const pathname = usePathname();

  return (
    <nav aria-label="Main" className="flex h-full flex-col bg-sidebar px-2.5 pt-3 pb-2">
      <Link
        href={orgPath(org.slug, "my")}
        onClick={onNavigate}
        aria-label="Vector home"
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
        <NavItem href={orgPath(org.slug, "settings", "members")} active={pathname.startsWith(orgPath(org.slug, "settings", "members"))} icon={<UsersIcon />} onNavigate={onNavigate}>
          Members
        </NavItem>
        <NavItem href={orgPath(org.slug, "settings", "bots")} active={pathname.startsWith(orgPath(org.slug, "settings", "bots")) || pathname.startsWith(orgPath(org.slug, "settings", "roles"))} icon={<BotIcon />} onNavigate={onNavigate}>
          Bots
        </NavItem>
        <NavItem
          href={orgPath(org.slug, "settings", "general")}
          active={["general", "projects", "statuses"].some((t) => pathname.startsWith(orgPath(org.slug, "settings", t)))}
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
}

/** Active projects in the person's own order; drag (or Space + arrows) to reorder (VEC-54). */
function SidebarProjects({ onNavigate }: { onNavigate?: () => void }) {
  const { org, projects, counts, reorderProjects } = useOrg();
  const pathname = usePathname();
  const active = useMemo(() => projects.filter((p) => !p.archived), [projects]);
  return (
    <SortableList
      items={active}
      getId={(p) => p.id}
      getLabel={(p) => p.name}
      aria-label="Projects"
      onReorder={(ids) => {
        // Applied at once by the provider; it rolls back itself if the server refuses.
        void reorderProjects(ids).then((r) => {
          if (!r.ok) toast.error(r.error || "Couldn't save the project order.");
        });
      }}
      renderItem={(p, { handleProps, isDragging }) => {
        const href = projectPath(org.slug, p.key);
        return (
          <NavItem
            href={href}
            active={pathname === href}
            icon={<ProjectDot color={p.color} className="mx-[4px] size-2.5" />}
            count={counts.projects[p.id] ?? 0}
            onNavigate={onNavigate}
            handleProps={handleProps}
            dragging={isDragging}
          >
            {p.name}
          </NavItem>
        );
      }}
    />
  );
}

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
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      {...handleProps}
      className={cn(
        "group mb-px flex h-[30px] shrink-0 items-center gap-2.5 rounded-[7px] px-2 text-[13.5px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [&_svg]:size-4 [&_svg]:shrink-0",
        active ? "bg-selected font-medium text-selected-foreground" : "text-sidebar-foreground hover:bg-sidebar-accent",
        dragging && "cursor-grabbing",
      )}
    >
      <span className={cn("flex", active ? "text-selected-foreground" : "text-muted-foreground")}>{icon}</span>
      <span className="truncate">{children}</span>
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
