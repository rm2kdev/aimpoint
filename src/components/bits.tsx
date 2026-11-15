"use client";

import { cn } from "@/lib/utils";
import { avatarColor, initials, PRIORITY_LABELS } from "@/lib/format";
import type { BotAvatar as BotAvatarData, BotShape, Member, Priority, Status, TaskType } from "@/lib/types";

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

/**
 * "Working" overlay: a short arc orbiting just outside the ring (r 9.3, clear of the
 * 8.3 outer edge of the track/arc and inside the 20-unit viewBox), so the status colour
 * and progress arc stay readable and the icon never changes size. Spins via
 * `.status-ring-working` in globals.css; reduced motion swaps it for a static faint halo.
 */
function WorkingOrbit({ color }: { color: string }) {
  return (
    <g className="status-ring-working">
      <circle cx="10" cy="10" r="9.3" fill="none" stroke={color} strokeWidth="1.3" strokeLinecap="round" strokeDasharray="14.6 58.4" />
    </g>
  );
}

export const STATUS_RING_WORKING_LABEL = "A bot is working on this";

export function StatusRing({
  status,
  statuses,
  size = 18,
  className,
  working = false,
  workingLabel = STATUS_RING_WORKING_LABEL,
}: {
  status: Status | undefined;
  statuses: Status[];
  size?: number;
  className?: string;
  /** Show the orbiting "a bot is working on this" indicator. */
  working?: boolean;
  workingLabel?: string;
}) {
  const color = status?.color ?? "var(--faint)";
  const cat = status?.category ?? "unstarted";
  const common = working
    ? { width: size, height: size, viewBox: "0 0 20 20", className: cn("shrink-0", className), role: "img", "aria-label": workingLabel }
    : { width: size, height: size, viewBox: "0 0 20 20", className: cn("shrink-0", className), "aria-hidden": true };
  const extra = working ? (
    <>
      <title>{workingLabel}</title>
      <WorkingOrbit color={color} />
    </>
  ) : null;
  if (cat === "done") {
    return (
      <svg {...common}>
        {extra}
        <circle cx="10" cy="10" r="8.5" fill={color} />
        <path d="m6.4 10.3 2.5 2.4 4.7-4.9" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (cat === "cancelled") {
    return (
      <svg {...common}>
        {extra}
        <circle cx="10" cy="10" r="8.5" fill={color} opacity="0.9" />
        <path d="m7.2 7.2 5.6 5.6m0-5.6-5.6 5.6" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    );
  }
  if (cat === "backlog" || cat === "triage") {
    // Dashed = not yet. Triage adds a centre dot: not yet, and waiting to be broken down.
    return (
      <svg {...common}>
        {extra}
        <circle cx="10" cy="10" r="7.5" fill="none" stroke={color} strokeWidth="1.6" strokeDasharray="2.6 2.3" />
        {cat === "triage" && <circle cx="10" cy="10" r="2.6" fill={color} />}
      </svg>
    );
  }
  const p = status ? ringProgress(status, statuses) : 0;
  return (
    <svg {...common}>
      {extra}
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

/* ---------- Bot avatars: a cute shape on colour, or an uploaded picture, in a squircle ---------- */

export function BotShapeGlyph({ shape, bg, className }: { shape: BotShape; bg: string; className?: string }) {
  const eyes = (y: number, gap = 3.2) => (
    <>
      <circle cx={12 - gap} cy={y} r="1.25" fill={bg} />
      <circle cx={12 + gap} cy={y} r="1.25" fill={bg} />
    </>
  );
  const body: Record<BotShape, React.ReactNode> = {
    star: (
      <>
        <path d="M12 2.8l2.75 5.6 6.15.9-4.45 4.33 1.05 6.12L12 16.86l-5.5 2.89 1.05-6.12L3.1 9.3l6.15-.9z" fill="#fff" strokeLinejoin="round" stroke="#fff" strokeWidth="1.2" />
        {eyes(11.2, 2.2)}
      </>
    ),
    heart: (
      <>
        <path d="M12 20.2s-7.6-4.6-7.6-10.4A4.3 4.3 0 0 1 12 7.1a4.3 4.3 0 0 1 7.6 2.7c0 5.8-7.6 10.4-7.6 10.4z" fill="#fff" />
        {eyes(11.4, 2.6)}
      </>
    ),
    flower: (
      <>
        {[0, 72, 144, 216, 288].map((a) => (
          <circle key={a} cx={12 + 4.6 * Math.sin((a * Math.PI) / 180)} cy={12 - 4.6 * Math.cos((a * Math.PI) / 180)} r="3.9" fill="#fff" />
        ))}
        <circle cx="12" cy="12" r="3.4" fill="#fff" />
        {eyes(11.6, 1.6)}
      </>
    ),
    cloud: (
      <>
        <path d="M7.2 18.6a4.3 4.3 0 0 1-.5-8.57 5.6 5.6 0 0 1 10.8-1.13A4.85 4.85 0 0 1 17.1 18.6z" fill="#fff" />
        {eyes(13.2, 2.8)}
      </>
    ),
    bolt: <path d="M13.6 2.4 4.9 13.7h6.3l-1.3 7.9 9.2-11.6h-6.5z" fill="#fff" strokeLinejoin="round" stroke="#fff" strokeWidth="1" />,
    moon: (
      <>
        <path d="M19.8 14.9A8.3 8.3 0 1 1 9.1 4.2a6.6 6.6 0 0 0 10.7 10.7z" fill="#fff" />
        <circle cx="8.6" cy="12.6" r="1.2" fill={bg} />
        <circle cx="12.4" cy="15.2" r="1.2" fill={bg} />
      </>
    ),
    blob: (
      <>
        <path d="M12 3.6c4 0 7.6 2.5 7.6 7 0 4.8-3.3 9.6-8 9.6-4.4 0-7.2-3.5-7.2-7.6 0-5 3.7-9 7.6-9z" fill="#fff" />
        {eyes(11.3, 2.7)}
        <path d="M10.4 14.4q1.6 1.3 3.2 0" stroke={bg} strokeWidth="1.2" fill="none" strokeLinecap="round" />
      </>
    ),
    ghost: (
      <>
        <path d="M12 3.2a7 7 0 0 1 7 7v10.3l-2.33-1.6-2.33 1.6L12 18.9l-2.33 1.6-2.33-1.6L5 20.5V10.2a7 7 0 0 1 7-7z" fill="#fff" />
        {eyes(10.4, 2.6)}
      </>
    ),
  };
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      {body[shape]}
    </svg>
  );
}

export function BotAvatar({ avatar, name, size = 22, className }: { avatar?: BotAvatarData; name: string; size?: number; className?: string }) {
  const radius = Math.round(size * 0.3);
  if (avatar?.kind === "image") {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatar.url}
        alt=""
        title={name}
        width={size}
        height={size}
        className={cn("inline-block shrink-0 object-cover", className)}
        style={{ width: size, height: size, borderRadius: radius }}
      />
    );
  }
  const shape = avatar?.kind === "shape" ? avatar : { shape: "blob" as BotShape, color: "#525252" };
  return (
    <span
      title={name}
      className={cn("inline-grid shrink-0 place-items-center", className)}
      style={{ width: size, height: size, borderRadius: radius, background: shape.color }}
    >
      <BotShapeGlyph shape={shape.shape} bg={shape.color} className="size-[72%]" />
    </span>
  );
}

/** Avatar for anyone who can own or be assigned a task: a person or a bot. */
export function MemberAvatar({ member, id, size = 22, className }: { member?: Member; id: string; size?: number; className?: string }) {
  if (member?.kind === "bot") return <BotAvatar avatar={member.avatar} name={member.name} size={size} className={className} />;
  return <UserAvatar id={id} name={member?.name ?? "?"} size={size} className={className} />;
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
