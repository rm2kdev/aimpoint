import { cn } from "@/lib/utils";

/** Vector mark: a filled status ring heading off on a vector. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("size-6", className)} aria-hidden>
      <rect width="24" height="24" rx="6.5" className="fill-foreground" />
      <circle cx="10.5" cy="13.5" r="4.6" fill="none" className="stroke-background" strokeWidth="1.6" />
      <path d="M10.5 8.9a4.6 4.6 0 0 1 4.6 4.6" fill="none" className="stroke-background" strokeWidth="3" />
      <path d="M14.2 9.8 18 6m0 0h-3m3 0v3" fill="none" className="stroke-background" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <LogoMark />
      <span className="text-[15px] font-semibold tracking-[-0.01em]">Vector</span>
    </div>
  );
}
