"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ArchiveIcon, BotIcon, ChartNoAxesColumnIcon, CircleUserIcon, UsersIcon, LayersIcon, PlusIcon, SettingsIcon, ShieldCheckIcon, SlidersHorizontalIcon, UserIcon, WorkflowIcon } from "lucide-react";
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
import { searchTasks } from "@/app/actions/tasks";
import type { Task } from "@/lib/types";
import { accountPath, analyticsPath, newTasksPath, orgPath, projectPath, rolesPath, taskPath, withTask } from "@/lib/paths";

export function CommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { org, projects, isAdmin } = useOrg();
  const { newTask } = useShell();
  const router = useRouter();
  const pathname = usePathname();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Task[]>([]);
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
              </CommandGroup>
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
