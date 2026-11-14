"use client";

import { cn } from "@/lib/utils";
import { avatarColor, initials, PRIORITY_LABELS } from "@/lib/format";
import type { Priority, Status, TaskType } from "@/lib/types";

/* ---------- Status ring (signature move) ---------- */

/** Fraction of the way through the org's active statuses, 0..1. */
export function ringProgress(status: Status, statuses: Status[]) {
  const active = statuses.filter((s) => s.category === "unstarted" || s.category === "started");
  const i = active.findIndex((s) => s.id === status.id);
  return i < 0 ? 0 : (i + 1) / (active.length + 1);
}

function arc(fraction: number, r: number, c: number) {
  if (fraction <= 0) return "";
  const f = Math.min(fraction, 0.9999);
  const a = f * 2 * Math.PI - Math.PI / 2;
  const x = c + r * Math.cos(a);
  const y = c + r * Math.sin(a);
  return `M ${c} ${c - r} A ${r} ${r} 0 ${f > 0.5 ? 1 : 0} 1 ${x.toFixed(3)} ${y.toFixed(3)}`;
}

export function StatusRing({
  status,
  statuses,
  size = 18,
  className,
}: {
  status: Status | undefined;
  statuses: Status[];
  size?: number;
  className?: string;
}) {
  const color = status?.color ?? "var(--faint)";
  const cat = status?.category ?? "unstarted";
  const common = { width: size, height: size, viewBox: "0 0 20 20", className: cn("shrink-0", className), "aria-hidden": true };
  if (cat === "done") {
    return (
      <svg {...common}>
        <circle cx="10" cy="10" r="8.5" fill={color} />
        <path d="m6.4 10.3 2.5 2.4 4.7-4.9" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (cat === "cancelled") {
    return (
      <svg {...common}>
        <circle cx="10" cy="10" r="8.5" fill={color} opacity="0.9" />
        <path d="m7.2 7.2 5.6 5.6m0-5.6-5.6 5.6" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    );
  }
  if (cat === "backlog") {
    return (
      <svg {...common}>
        <circle cx="10" cy="10" r="7.5" fill="none" stroke={color} strokeWidth="1.6" strokeDasharray="2.6 2.3" />
      </svg>
    );
  }
  const p = status ? ringProgress(status, statuses) : 0;
  return (
    <svg {...common}>
      <circle cx="10" cy="10" r="7.5" fill="none" stroke={color} strokeWidth="1.6" />
      <path d={arc(p, 7.5, 10)} fill="none" stroke={color} strokeWidth="3.4" style={{ transition: "d 300ms cubic-bezier(.2,.8,.2,1)" }} />
    </svg>
  );
}

/* ---------- Avatar ---------- */

export function UserAvatar({ id, name, size = 22, className }: { id: string; name: string; size?: number; className?: string }) {
  return (
    <span
      title={name}
      className={cn("inline-grid shrink-0 place-items-center rounded-full font-semibold text-white select-none", className)}
      style={{ width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.42)), background: avatarColor(id) }}
    >
      {initials(name)}
    </span>
  );
}

export function UnassignedAvatar({ size = 22 }: { size?: number }) {
  return (
    <span
      className="inline-block shrink-0 rounded-full border border-dashed border-faint/70"
      style={{ width: size, height: size }}
      aria-label="Unassigned"
    />
  );
}

/* ---------- Priority ---------- */

export function PriorityIcon({ priority, className }: { priority: Priority; className?: string }) {
  if (priority === 0) {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" className={cn("shrink-0 text-faint", className)} aria-label={PRIORITY_LABELS[0]}>
        <path d="M2 7h2.2M5.9 7h2.2M9.8 7H12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className={cn("shrink-0", className)} aria-label={PRIORITY_LABELS[priority]}>
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          x={1.5 + i * 4}
          y={9 - i * 3}
          width="3"
          height={4 + i * 3}
          rx="0.8"
          fill="currentColor"
          className={i < priority ? (priority === 3 ? "text-foreground" : "text-muted-foreground") : "text-input"}
        />
      ))}
    </svg>
  );
}

/* ---------- Type tag ---------- */

export function TypeTag({ type, className }: { type: TaskType; className?: string }) {
  return (
    <span className={cn("inline-flex h-5 items-center gap-1.5 rounded-[5px] bg-chip px-1.5 text-[11.5px] text-muted-foreground", className)}>
      <span className={cn("size-1.5 rounded-[2px]", type === "issue" ? "bg-[#e5484d]" : "bg-[#30a46c]")} />
      {type === "issue" ? "Issue" : "Feature"}
    </span>
  );
}

export function ProjectDot({ color, className }: { color: string; className?: string }) {
  return <span className={cn("inline-block size-2 shrink-0 rounded-[3px]", className)} style={{ background: color }} />;
}

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border border-input bg-background px-1 font-mono text-[10.5px] text-faint",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
