"use client";

import type { ReactNode } from "react";
import { CheckIcon } from "lucide-react";
import type { StatusTrack } from "@/lib/status-track";
import { cn } from "@/lib/utils";

/**
 * The one renderer for a task's status bar (VEC-329/330): the steps of a `statusTrack()` in order, done ones ticked,
 * the current one filled, steps a Cancelled task never reached struck through. No org context, so it works on the
 * public project page too. The task pane's `TaskStatusBar` (task-flow.tsx) passes its Now/Next rows, step action and
 * notes as `children`; the public page passes nothing (read-only, no owners).
 */
export function StatusTrackBar({ track, className, children }: { track: StatusTrack; className?: string; children?: ReactNode }) {
  if (!track.steps.length) return null;
  return (
    <section aria-label="Status" data-status-track={track.source} data-track-reason={track.reason} className={cn("rounded-lg border border-border px-3 py-2.5 text-[12.5px]", className)}>
      <ol aria-label={track.label} className="flex flex-wrap items-center gap-x-1 gap-y-1">
        {track.steps.map((s, i) => {
          const state = s.state;
          return (
            <li key={s.id} className="flex min-w-0 items-center gap-1" aria-current={state === "current" ? "step" : undefined}>
              {i > 0 && <span aria-hidden className={cn("h-px w-2.5 shrink-0", state === "done" || state === "current" ? "bg-muted-foreground/60" : "bg-border")} />}
              <span
                title={`${s.name}${track.source === "flow" ? ` (${s.statusName})` : ""}${state === "done" ? ", done" : state === "current" ? (track.source === "flow" ? ", current step" : ", current status") : state === "skipped" ? ", not reached" : ""}`}
                className={cn(
                  "inline-flex h-5 max-w-[140px] items-center gap-1 rounded-[5px] px-1.5 whitespace-nowrap",
                  state === "current" ? "bg-foreground font-medium text-background" : state === "done" ? "bg-chip text-muted-foreground" : "text-faint",
                )}
              >
                {state === "done" ? (
                  <CheckIcon aria-hidden className="size-3 shrink-0" />
                ) : (
                  <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", state === "current" ? "bg-background" : "border border-faint")} />
                )}
                <span className={cn("truncate", state === "skipped" && "line-through decoration-faint/60")}>{s.name}</span>
                <span className="sr-only">{state === "done" ? " (done)" : state === "current" ? " (current)" : state === "skipped" ? " (not reached)" : ""}</span>
              </span>
            </li>
          );
        })}
      </ol>
      {children}
    </section>
  );
}
