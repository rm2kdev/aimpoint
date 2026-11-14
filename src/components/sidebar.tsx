"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import {
  CheckIcon,
  ChevronsUpDownIcon,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { logoutAction } from "@/app/actions/auth";

export function Sidebar({ onSearch, onNavigate }: { onSearch: () => void; onNavigate?: () => void }) {
  const { org, orgs, me, projects, counts, isAdmin } = useOrg();
  const pathname = usePathname();
  const base = `/${org.slug}`;

  return (
    <nav aria-label="Main" className="flex h-full flex-col bg-sidebar px-2.5 pt-3 pb-2">
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
        <NavItem href={`${base}/my`} active={pathname === `${base}/my`} icon={<UserIcon />} count={counts.my} onNavigate={onNavigate}>
          My Tasks
        </NavItem>
        <NavItem href={`${base}/all`} active={pathname === `${base}/all`} icon={<LayersIcon />} count={counts.all} onNavigate={onNavigate}>
          All Tasks
        </NavItem>

        <SectionLabel action={isAdmin ? { href: `${base}/settings?tab=projects&new=1`, label: "New project" } : undefined}>Projects</SectionLabel>
        {projects.map((p) => {
          const href = `${base}/p/${p.key}`;
          return (
            <NavItem
              key={p.id}
              href={href}
              active={pathname === href}
              icon={<ProjectDot color={p.color} className="mx-[4px] size-2.5" />}
              count={counts.projects[p.id] ?? 0}
              onNavigate={onNavigate}
            >
              {p.name}
            </NavItem>
          );
        })}

        <SectionLabel>{orgs.length > 1 ? org.name : "Organisation"}</SectionLabel>
        <NavItem href={`${base}/settings?tab=members`} active={false} icon={<UsersIcon />} onNavigate={onNavigate}>
          Members
        </NavItem>
        <NavItem href={`${base}/settings`} active={pathname === `${base}/settings`} icon={<SettingsIcon />} onNavigate={onNavigate}>
          Settings
        </NavItem>
      </div>

      <div className="mt-2 flex items-center gap-2.5 border-t border-sidebar-border px-1.5 pt-2.5">
        <UserAvatar id={me.id} name={me.name} size={24} />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-[13px] font-medium">{me.name}</div>
          <div className="text-[11.5px] text-faint">{me.role === "admin" ? "Admin" : "Member"}</div>
        </div>
        <ThemeMenu />
      </div>
    </nav>
  );
}

function NavItem({
  href,
  active,
  icon,
  count,
  children,
  onNavigate,
}: {
  href: string;
  active: boolean;
  icon: React.ReactNode;
  count?: number;
  children: React.ReactNode;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group mb-px flex h-[30px] shrink-0 items-center gap-2.5 rounded-[7px] px-2 text-[13.5px] transition-colors [&_svg]:size-4 [&_svg]:shrink-0",
        active ? "bg-selected font-medium text-selected-foreground" : "text-sidebar-foreground hover:bg-sidebar-accent",
      )}
    >
      <span className={cn("flex", active ? "text-selected-foreground" : "text-muted-foreground")}>{icon}</span>
      <span className="truncate">{children}</span>
      {count !== undefined && count > 0 && (
        <span className={cn("tabular ml-auto font-mono text-[11.5px]", active ? "text-selected-foreground/80" : "text-faint")}>{count}</span>
      )}
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
        <span className="grid size-[22px] shrink-0 place-items-center rounded-md bg-foreground text-[11.5px] font-semibold text-background">
          {org.name[0]?.toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">{org.name}</span>
        <ChevronsUpDownIcon className="size-3.5 text-faint" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel className="text-xs font-normal text-faint">Organisations</DropdownMenuLabel>
        {orgs.map((o) => (
          <DropdownMenuItem key={o.id} onSelect={() => router.push(`/${o.slug}/my`)} className="gap-2.5">
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
