"use client";

import { useEffect, useState } from "react";
import { RotateCcwIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { discardTaskWrites, retryTaskWrites, useUnsentState } from "@/lib/task-writes";

/**
 * VEC-456: a task's unsent writes (lib/task-writes). "Not sent" with Retry / Discard once a write needs the person
 * (the network gave up); with `saving`, a quiet "Saving…" while one is on its way, shown only if it takes a moment,
 * so quick saves never flash it. Nothing at all otherwise. `compact` (list rows, VEC-459): in a row under 20rem the
 * words go and only the Retry icon and the x stay, named for screen readers and in the tooltip.
 */
export function UnsentMarker({ taskId, saving = false, compact = false, className }: { taskId: string; saving?: boolean; compact?: boolean; className?: string }) {
  const words = compact ? "@max-[20rem]/row:sr-only" : undefined;
  const state = useUnsentState(taskId);
  const slow = useLater(saving && state === "sending", 600);
  if (state === "failed") {
    return (
      <span role="status" data-unsent="failed" title={compact ? "Not sent" : undefined} className={cn("inline-flex shrink-0 items-center gap-0.5 text-[12px] text-destructive", className)}>
        <span className={cn("pr-1", words)}>Not sent</span>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            retryTaskWrites(taskId);
          }}
          className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 font-medium hover:bg-destructive/10"
        >
          <RotateCcwIcon className="size-3" /> <span className={words}>Retry</span>
        </button>
        <button
          type="button"
          aria-label="Discard unsent changes"
          title="Discard unsent changes"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            discardTaskWrites(taskId);
          }}
          className="grid size-6 place-items-center rounded-md hover:bg-destructive/10"
        >
          <XIcon className="size-3" />
        </button>
      </span>
    );
  }
  if (slow) {
    return (
      <span role="status" data-unsent="sending" className={cn("shrink-0 text-[12px] text-faint", className)}>
        Saving…
      </span>
    );
  }
  return null;
}

/** `on`, but only after it has stayed true for `ms`. */
function useLater(on: boolean, ms: number) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!on) return;
    const t = window.setTimeout(() => setLate(true), ms);
    return () => {
      window.clearTimeout(t);
      setLate(false);
    };
  }, [on, ms]);
  return on && late;
}
