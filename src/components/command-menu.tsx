"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ArchiveIcon, BotIcon, ChartNoAxesColumnIcon, CircleUserIcon, CreditCardIcon, HistoryIcon, UsersIcon, LayersIcon, PlusIcon, SettingsIcon, ShieldCheckIcon, SlidersHorizontalIcon, SparklesIcon, UserIcon, WorkflowIcon } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Command } from "@/components/ui/command";
import { useOrg } from "@/components/org-provider";
import { useShell } from "@/components/app-shell";
import { ProjectDot } from "@/components/bits";
import { TaskStatusRing } from "@/components/task-status-ring";
import { useLiveTasks } from "@/components/live-tasks";
import { searchTasks } from "@/app/actions/tasks";
import type { Task } from "@/lib/types";
import { accountPath, analyticsPath, billingPath, newTasksPath, orgPath, projectPath, projectSettingsPath, rolesPath, taskPath, withTask } from "@/lib/paths";
import { useOpenWhatsNew } from "@/components/whats-new-dialog";

export function CommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { org, projects, isAdmin, billing } = useOrg();
  const openWhatsNew = useOpenWhatsNew();
  const { newTask } = useShell();
  const router = useRouter();
  const pathname = usePathname();
  const [q, setQ] = useState("");
  const [fetched, setResults] = useState<Task[]>([]);
  // Rings in the results follow live task.upsert events (VEC-381).
  const results = useLiveTasks(fetched);
  const seq = useRef(0);

  useEffect(() => {
    if (!open) setQ("");
  }, [open]);

  useEffect(() => {
    const term = q.trim();
    if (!term) return setResults([]);
    const id = ++seq.current;
    const t = setTimeout(async () => {
      const r = await searchTasks(org.slug, term);
      if (id === seq.current && r.ok) setResults(r.data ?? []);
    }, 140);
    return () => clearTimeout(t);
  }, [q, org.slug]);

  const go = (href: string) => {
    onOpenChange(false);
    router.push(href);
  };
  const base = orgPath(org.slug);
  // On a single project's page (`/o/<slug>/p/<key>`), offer a jump to that project's settings (VEC-212).
  const pageKey = pathname.startsWith(`${base}/p/`) ? decodeURIComponent(pathname.slice(base.length + 3).split("/")[0] ?? "").toUpperCase() : "";
  const pageProject = pageKey ? projects.find((p) => p.key === pageKey) : undefined;

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Search" description="Search tasks or jump to a view" className="sm:max-w-[560px]">
      <Command shouldFilter={false}>
        <CommandInput value={q} onValueChange={setQ} placeholder="Search tasks by title or key, e.g. WEB-12" />
        <CommandList className="max-h-[360px]">
          {q.trim() ? (
            <>
              <CommandEmpty>No tasks match &ldquo;{q.trim()}&rdquo;</CommandEmpty>
              {results.length > 0 && (
                <CommandGroup heading="Tasks">
                  {results.map((t) => (
                    <CommandItem key={t.id} value={t.id} onSelect={() => go(t.archivedAt ? taskPath(org.slug, t.key, "archived") : pathname.startsWith(base) && !pathname.includes("/settings") && !pathname.endsWith("/archived") ? withTask(pathname, t.key) : taskPath(org.slug, t.key))} className="gap-2.5">
                      <TaskStatusRing task={t} size={15} />
                      <span className="truncate">{t.title}</span>
                      {t.archivedAt && <span className="shrink-0 rounded-[4px] bg-chip px-1.5 text-[11.5px] text-muted-foreground">Archived</span>}
                      <span className="tabular ml-auto font-mono text-[11.5px] text-faint">{t.key}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </>
          ) : (
            <>
              <CommandGroup heading="Actions">
                <CommandItem
                  onSelect={() => {
                    onOpenChange(false);
                    newTask();
                  }}
                  className="gap-2.5"
                >
                  <PlusIcon /> New task <span className="ml-auto font-mono text-[11px] text-faint">N</span>
                </CommandItem>
                {/* The changelog pop-up (VEC-374) and its "All updates" list (VEC-377); neither moves the seen marker. */}
                {openWhatsNew && (
                  <>
                    <CommandItem
                      data-nav="whats-new"
                      onSelect={() => {
                        onOpenChange(false);
                        openWhatsNew.latest();
                      }}
                      className="gap-2.5"
                    >
                      <SparklesIcon /> What&apos;s new
                    </CommandItem>
                    <CommandItem
                      data-nav="all-updates"
                      onSelect={() => {
                        onOpenChange(false);
                        openWhatsNew.history();
                      }}
                      className="gap-2.5"
                    >
                      <HistoryIcon /> All updates <span className="ml-auto text-[11px] text-faint">What&apos;s new</span>
                    </CommandItem>
                  </>
                )}
              </CommandGroup>
              {pageProject && (
                <CommandGroup heading="This project">
                  <CommandItem onSelect={() => go(projectSettingsPath(org.slug, pageProject.id))} className="gap-2.5" data-nav="project-settings">
                    <SettingsIcon /> {isAdmin ? "Project settings" : "View project settings"}
                    <span className="ml-auto flex min-w-0 items-center gap-1.5 text-[11px] text-faint">
                      <ProjectDot color={pageProject.color} /> <span className="truncate">{pageProject.name}</span>
                    </span>
                  </CommandItem>
                </CommandGroup>
              )}
              <CommandGroup heading="Go to">
                <CommandItem onSelect={() => go(orgPath(org.slug, "my"))} className="gap-2.5">
                  <UserIcon /> My Tasks
                </CommandItem>
                <CommandItem onSelect={() => go(orgPath(org.slug, "all"))} className="gap-2.5">
                  <LayersIcon /> All Tasks
                </CommandItem>
                {projects.filter((p) => !p.archived).map((p) => (
                  <CommandItem key={p.id} onSelect={() => go(projectPath(org.slug, p.key))} className="gap-2.5">
                    <ProjectDot color={p.color} className="mx-1" /> {p.name}
                    <span className="ml-auto font-mono text-[11px] text-faint">{p.key}</span>
                  </CommandItem>
                ))}
                <CommandItem onSelect={() => go(orgPath(org.slug, "archived"))} className="gap-2.5">
                  <ArchiveIcon /> Archive
                </CommandItem>
                {isAdmin && (
                  <CommandItem onSelect={() => go(analyticsPath(org.slug))} className="gap-2.5" data-nav="analytics">
                    <ChartNoAxesColumnIcon /> Analytics
                  </CommandItem>
                )}
                <CommandItem onSelect={() => go(orgPath(org.slug, "settings", "members"))} className="gap-2.5">
                  <UsersIcon /> Members
                </CommandItem>
                <CommandItem onSelect={() => go(orgPath(org.slug, "settings", "bots"))} className="gap-2.5">
                  <BotIcon /> Bots
                </CommandItem>
                <CommandItem onSelect={() => go(rolesPath(org.slug))} className="gap-2.5">
                  <ShieldCheckIcon /> Bot roles <span className="ml-auto text-[11px] text-faint">Bots</span>
                </CommandItem>
                <CommandItem onSelect={() => go(orgPath(org.slug, "settings", "general"))} className="gap-2.5">
                  <SettingsIcon /> Settings
                </CommandItem>
                <CommandItem onSelect={() => go(orgPath(org.slug, "settings", "flows"))} className="gap-2.5">
                  <WorkflowIcon /> Flows <span className="ml-auto text-[11px] text-faint">Settings</span>
                </CommandItem>
                <CommandItem onSelect={() => go(newTasksPath(org.slug))} className="gap-2.5">
                  <SlidersHorizontalIcon /> New task defaults <span className="ml-auto text-[11px] text-faint">Flows</span>
                </CommandItem>
                {billing.enabled && (
                  <CommandItem onSelect={() => go(billingPath(org.slug))} className="gap-2.5" data-nav="billing">
                    <CreditCardIcon /> Billing <span className="ml-auto text-[11px] text-faint">Settings</span>
                  </CommandItem>
                )}
                <CommandItem onSelect={() => go(accountPath(org.slug))} className="gap-2.5">
                  <CircleUserIcon /> Account settings
                </CommandItem>
              </CommandGroup>
            </>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
