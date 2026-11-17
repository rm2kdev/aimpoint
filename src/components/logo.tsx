import { cn } from "@/lib/utils";

/**
 * Vector mark: a small constellation. Dots joined by thin lines trace a "V"
 * with a branch off it, like a vector diagram; one loose dot sits apart.
 * Keep in sync with src/app/icon.svg.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("size-6", className)} aria-hidden>
      <rect width="24" height="24" rx="6.5" className="fill-foreground" />
      <path
        d="M5.5 7 10.5 17.5 14 11 18.5 6M14 11l4.5 4.5"
        fill="none"
        className="stroke-background"
        strokeOpacity="0.6"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <g className="fill-background">
        <circle cx="5.5" cy="7" r="1.5" />
        <circle cx="10.5" cy="17.5" r="2.1" />
        <circle cx="14" cy="11" r="1.8" />
        <circle cx="18.5" cy="6" r="1.5" />
        <circle cx="18.5" cy="15.5" r="1.2" />
        <circle cx="6" cy="16" r="0.8" fillOpacity="0.5" />
      </g>
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <LogoMark />
      <span className="text-[15px] font-semibold tracking-[-0.01em]">Aimpoint</span>
    </div>
  );
}
