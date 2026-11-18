"use client";

import { cloneElement, isValidElement, useId, useRef, useState } from "react";
import { CheckIcon } from "lucide-react";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useOrg, useOrgBase } from "@/components/org-provider";
import { BotAvatar, PriorityIcon, ProjectDot, StatusRing, TypeSquare, UnassignedAvatar, UserAvatar } from "@/components/bits";
import { PRIORITY_LABELS, TYPE_NAMES } from "@/lib/format";
import { TASK_TYPES, type Priority, type Status, type TaskType } from "@/lib/types";

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
  footer,
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
  /** One line of help under the options (e.g. the parked-Backlog note on an assignee picker, VEC-276). */
  footer?: string | null;
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
      <PickerContent
        value={value}
        options={options}
        onChange={onChange}
        onClose={() => setOpen(false)}
        placeholder={placeholder}
        align={align}
        searchable={searchable}
        footer={footer}
      />
    </Popover>
  );
}

function PickerContent<V extends string>({
  value,
  options,
  onChange,
  onClose,
  placeholder,
  align,
  searchable,
  footer,
  ...props
}: {
  value: V | null;
  options: Option<V>[];
  onChange: (v: V) => void;
  onClose: () => void;
  placeholder: string;
  align: "start" | "end" | "center";
  searchable: boolean;
  footer?: string | null;
} & Pick<React.ComponentProps<typeof PopoverContent>, "id" | "onInteractOutside" | "onCloseAutoFocus">) {
  return (
    <PopoverContent {...props} align={align} className="w-60 p-0" onClick={(e) => e.stopPropagation()}>
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
                  onClose();
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
        {footer && <p className="border-t px-3 py-2 text-[12px] text-muted-foreground">{footer}</p>}
      </Command>
    </PopoverContent>
  );
}

/**
 * A Picker for list rows (VEC-81): the trigger is the plain button, and the Radix popover (and its options)
 * mounts only the first time it opens, anchored to that button. A Picker per row mounted a popover tree for
 * every row, which made opening a long list (a spring-loaded project mid-drag) one long task.
 * `children` must be a single button element.
 */
export function LazyPicker<V extends string>({
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
  children: React.ReactElement<React.ComponentProps<"button">>;
  placeholder?: string;
  align?: "start" | "end" | "center";
  searchable?: boolean;
  label: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const outside = useRef(false);
  const id = useId();
  if (disabled) return cloneElement(children, { disabled: true, "aria-label": label });
  return (
    <>
      {cloneElement(children, {
        ref: button,
        type: "button",
        "aria-label": label,
        "aria-haspopup": "dialog",
        "aria-expanded": open,
        "aria-controls": open ? id : undefined,
        "data-state": open ? "open" : "closed",
        onClick: (e: React.MouseEvent<HTMLButtonElement>) => {
          children.props.onClick?.(e);
          if (e.defaultPrevented) return;
          setMounted(true);
          setOpen((o) => !o);
        },
      } as React.ComponentProps<"button">)}
      {mounted && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverAnchor virtualRef={button as React.RefObject<HTMLButtonElement>} />
          <PickerContent
            id={id}
            value={value}
            options={options}
            onChange={onChange}
            onClose={() => setOpen(false)}
            placeholder={placeholder}
            align={align}
            searchable={searchable}
            // What PopoverTrigger does: a press on the button itself toggles instead of dismissing and reopening,
            // and focus returns to the button unless the popover closed because of a click elsewhere.
            onInteractOutside={(e) => {
              if (button.current?.contains(e.target as Node)) e.preventDefault();
              else outside.current = true;
            }}
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              if (!outside.current) button.current?.focus();
              outside.current = false;
            }}
          />
        </Popover>
      )}
    </>
  );
}


const NO_STATUSES: Status[] = [];
/** One project's statuses in workflow order (empty for an unknown or missing project). */
export function projectStatuses(byProject: Map<string, Status[]>, projectId: string | null | undefined): Status[] {
  return (projectId && byProject.get(projectId)) || NO_STATUSES;
}

/** Status picker options: only the project's own statuses, since a task only takes its own project's (VEC-115/117). */
export function useStatusOptions(projectId: string | null | undefined): Option<string>[] {
  const { statusesByProject } = useOrgBase();
  const statuses = projectStatuses(statusesByProject, projectId);
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
