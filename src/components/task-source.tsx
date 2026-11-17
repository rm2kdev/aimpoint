"use client";

import { FileInputIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TaskSource } from "@/lib/types";

/**
 * Where a task came from when it wasn't created by a member or bot (VEC-208): today only external forms (VEC-205).
 * The form is the task's creator (`createdBy` = form id), so anything that names the creator goes through
 * `creatorLabel` rather than a member lookup, which would read "Former member".
 */

/** "Bug report form", for "Only X or an admin..." notes. */
export const formLabel = (s: TaskSource) => `the ${s.formName} form`;

/** Who submitted it, as one line: name, else email, else null (the form allows both to be blank). */
export const submitterLabel = (s: TaskSource) => s.submitterName || s.submitterEmail || null;

/** List row chip: "via Bug report". Nothing for tasks created normally. */
export function FormSourceChip({ source, className }: { source: TaskSource | null | undefined; className?: string }) {
  if (!source) return null;
  const who = submitterLabel(source);
  const label = `Submitted via the ${source.formName} form${who ? ` by ${who}` : ""}`;
  return (
    <span
      title={label}
      aria-label={label}
      data-task-source="form"
      className={cn("inline-flex h-5 max-w-[160px] items-center gap-1 rounded-[5px] bg-chip px-1.5 text-[12px] whitespace-nowrap text-muted-foreground", className)}
    >
      <FileInputIcon aria-hidden className="size-3 shrink-0" />
      <span className="truncate">via {source.formName}</span>
    </span>
  );
}

/** Task pane "Created ... by" value for a form task: the form, with its icon in the avatar slot. */
export function FormCreator({ source }: { source: TaskSource }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5" data-task-source="form">
      <span aria-hidden className="grid size-4 shrink-0 place-items-center rounded-full bg-chip text-muted-foreground">
        <FileInputIcon className="size-2.5" />
      </span>
      <span className="truncate" title={`Submitted through the ${source.formName} form`}>
        {source.formName} form
      </span>
    </span>
  );
}

/** Task pane "Submitted by" value: name and email (a mailto link), or a note that they left both blank. */
export function FormSubmitter({ source }: { source: TaskSource }) {
  const { submitterName: name, submitterEmail: email } = source;
  if (!name && !email) return <span className="text-faint">Anonymous (no name or email given)</span>;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {name && <span className="truncate text-foreground">{name}</span>}
      {email && (
        <a href={`mailto:${email}`} className="truncate text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          {email}
        </a>
      )}
    </span>
  );
}
