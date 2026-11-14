"use client";

import { useState } from "react";
import { CalendarIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { addDays, dueState, formatDue, fromISODate, toISODate, today } from "@/lib/dates";

/** Small calendar glyph + date; red when overdue, blue when due today. Quiet otherwise. */
export function DueBadge({ due, closed, long, className }: { due: string; closed?: boolean; long?: boolean; className?: string }) {
  const state = closed ? "later" : dueState(due);
  return (
    <span
      title={`Due ${formatDue(due, true)}`}
      className={cn(
        "tabular inline-flex items-center gap-1 text-[12px] whitespace-nowrap",
        state === "overdue" ? "text-destructive" : state === "today" ? "font-medium text-selected-foreground" : "text-muted-foreground",
        className,
      )}
    >
      <CalendarIcon className="size-3.5 shrink-0" />
      {formatDue(due, long)}
    </span>
  );
}

function nextMonday() {
  const t = today();
  return addDays(t, ((8 - t.getDay()) % 7) || 7);
}

/** Popover with quick picks and a month calendar. `children` is the trigger. */
export function DuePicker({
  value,
  onChange,
  children,
  disabled,
  align = "start",
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  children: React.ReactElement;
  disabled?: boolean;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  if (disabled) return children;
  const set = (v: string | null) => {
    setOpen(false);
    if (v !== value) onChange(v);
  };
  const quick: [string, Date][] = [
    ["Today", today()],
    ["Tomorrow", addDays(today(), 1)],
    ["Next week", nextMonday()],
  ];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild aria-label="Due date">
        {children}
      </PopoverTrigger>
      <PopoverContent align={align} className="w-auto p-0" onClick={(e) => e.stopPropagation()}>
        <div className="flex gap-1 border-b border-border p-1.5">
          {quick.map(([label, d]) => (
            <button
              key={label}
              onClick={() => set(toISODate(d))}
              className="h-7 flex-1 rounded-md px-2 text-[12.5px] whitespace-nowrap text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {label}
            </button>
          ))}
        </div>
        <Calendar
          mode="single"
          weekStartsOn={1}
          selected={value ? fromISODate(value) : undefined}
          defaultMonth={value ? fromISODate(value) : undefined}
          onSelect={(d) => set(d ? toISODate(d) : null)}
          className="p-2.5"
        />
        {value && (
          <div className="border-t border-border p-1.5">
            <button
              onClick={() => set(null)}
              className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-[12.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <XIcon className="size-3.5" /> Clear due date
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
