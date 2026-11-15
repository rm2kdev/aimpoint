"use client";

import { cloneElement, isValidElement, useState } from "react";
import { CheckIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useOrg, useOrgBase } from "@/components/org-provider";
import { BotAvatar, PriorityIcon, ProjectDot, StatusRing, TypeSquare, UnassignedAvatar, UserAvatar } from "@/components/bits";
import { PRIORITY_LABELS, TYPE_NAMES } from "@/lib/format";
import { TASK_TYPES, type Priority, type TaskType } from "@/lib/types";

export interface Option<V extends string> {
  value: V;
  label: string;
  icon?: React.ReactNode;
  hint?: string;
  group?: string;
}

export function Picker<V extends string>({
  value,
  options,
  onChange,
  children,
  placeholder = "Search…",
  align = "start",
  searchable = true,
  label,
  disabled,
}: {
  value: V | null;
  options: Option<V>[];
  onChange: (v: V) => void;
  children: React.ReactNode;
  placeholder?: string;
  align?: "start" | "end" | "center";
  searchable?: boolean;
  label: string;
  /** Read-only: render the trigger as a disabled button with no menu. */
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (disabled) {
    return isValidElement<{ disabled?: boolean; "aria-label"?: string }>(children)
      ? cloneElement(children, { disabled: true, "aria-label": label })
      : <>{children}</>;
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild aria-label={label}>
        {children}
      </PopoverTrigger>
      <PopoverContent align={align} className="w-60 p-0" onClick={(e) => e.stopPropagation()}>
        <Command>
          {searchable && <CommandInput placeholder={placeholder} />}
          <CommandList>
            <CommandEmpty>No matches</CommandEmpty>
            {[...new Set(options.map((o) => o.group))].map((g) => (
            <CommandGroup key={g ?? "_"} heading={g}>
              {options.filter((o) => o.group === g).map((o) => (
                <CommandItem
                  key={o.value}
                  value={`${o.label} ${o.hint ?? ""}`}
                  onSelect={() => {
                    setOpen(false);
                    if (o.value !== value) onChange(o.value);
                  }}
                  className="gap-2.5"
                >
                  {o.icon}
                  <span className="truncate">{o.label}</span>
                  {o.value === value && <CheckIcon className="ml-auto size-3.5 text-brand" />}
                </CommandItem>
              ))}
            </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function useStatusOptions(): Option<string>[] {
  const { statuses } = useOrgBase();
  return statuses.map((s) => ({ value: s.id, label: s.name, icon: <StatusRing status={s} statuses={statuses} size={15} /> }));
}

export function useAssigneeOptions(): Option<string>[] {
  const { members, me } = useOrgBase();
  const people = members.filter((m) => m.kind === "user").sort((a, b) => (a.id === me.id ? -1 : b.id === me.id ? 1 : 0));
  const bots = members.filter((m) => m.kind === "bot");
  return [
    { value: "none", label: "Unassigned", icon: <UnassignedAvatar size={18} /> },
    ...people.map((m) => ({
      value: m.id,
      label: m.id === me.id ? `${m.name} (you)` : m.name,
      hint: m.email,
      group: bots.length ? "People" : undefined,
      icon: <UserAvatar id={m.id} name={m.name} image={m.image} size={18} />,
    })),
    ...bots.map((m) => ({
      value: m.id,
      label: m.name,
      hint: "bot",
      group: "Bots",
      icon: <BotAvatar avatar={m.avatar} name={m.name} size={18} />,
    })),
  ];
}

export const PRIORITY_OPTIONS: Option<`${Priority}`>[] = ([3, 2, 1, 0] as Priority[]).map((p) => ({
  value: `${p}`,
  label: PRIORITY_LABELS[p],
  icon: <PriorityIcon priority={p} />,
}));

export const TYPE_OPTIONS: Option<TaskType>[] = TASK_TYPES.map((t) => ({
  value: t,
  label: TYPE_NAMES[t],
  icon: <TypeSquare type={t} className="ml-0.5" />,
}));

/** Projects that take tasks. An archived `current` stays listed so a task already in it still shows its project. */
export function useProjectOptions(current?: string): Option<string>[] {
  const { projects } = useOrg();
  return projects
    .filter((p) => !p.archived || p.id === current)
    .map((p) => ({ value: p.id, label: p.archived ? `${p.name} (archived)` : p.name, hint: p.key, icon: <ProjectDot color={p.color} /> }));
}
