"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ArchiveIcon, BotIcon, UsersIcon, LayersIcon, PlusIcon, SettingsIcon, UserIcon } from "lucide-react";
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
import { ProjectDot, StatusRing } from "@/components/bits";
import { searchTasks } from "@/app/actions/tasks";
import type { Task } from "@/lib/types";

export function CommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { org, projects, statuses, statusById } = useOrg();
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
  const base = `/${org.slug}`;

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
                    <CommandItem key={t.id} value={t.id} onSelect={() => go(`${t.archivedAt ? `${base}/archived` : pathname.startsWith(base) && !pathname.includes("/settings") && !pathname.endsWith("/archived") ? pathname : `${base}/all`}?task=${t.key}`)} className="gap-2.5">
                      <StatusRing status={statusById.get(t.statusId)} statuses={statuses} size={15} />
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
                <CommandItem onSelect={() => go(`${base}/my`)} className="gap-2.5">
                  <UserIcon /> My Tasks
                </CommandItem>
                <CommandItem onSelect={() => go(`${base}/all`)} className="gap-2.5">
                  <LayersIcon /> All Tasks
                </CommandItem>
                {projects.map((p) => (
                  <CommandItem key={p.id} onSelect={() => go(`${base}/p/${p.key}`)} className="gap-2.5">
                    <ProjectDot color={p.color} className="mx-1" /> {p.name}
                    <span className="ml-auto font-mono text-[11px] text-faint">{p.key}</span>
                  </CommandItem>
                ))}
                <CommandItem onSelect={() => go(`${base}/archived`)} className="gap-2.5">
                  <ArchiveIcon /> Archive
                </CommandItem>
                <CommandItem onSelect={() => go(`${base}/settings/members`)} className="gap-2.5">
                  <UsersIcon /> Members
                </CommandItem>
                <CommandItem onSelect={() => go(`${base}/settings/bots`)} className="gap-2.5">
                  <BotIcon /> Bots
                </CommandItem>
                <CommandItem onSelect={() => go(`${base}/settings/general`)} className="gap-2.5">
                  <SettingsIcon /> Settings
                </CommandItem>
              </CommandGroup>
            </>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
