"use client";

import { FileInputIcon, GlobeIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TaskSource } from "@/lib/types";

/**
 * Where a task came from when it wasn't created by a member or bot (VEC-208): today only external forms (VEC-205).
 * The form is the task's creator (`createdBy` = form id), so anything that names the creator goes through
 * `creatorLabel` rather than a member lookup, which would read "Former member".
 */

/** "Bug report form", for "Only X or an admin..." notes. A public submission (VEC-255) reads "the public page". */
export const formLabel = (s: TaskSource) => (s.kind === "public" ? "the public project page" : `the ${s.formName} form`);

/** Who submitted it, as one line: name, else email, else null (the form allows both to be blank). */
export const submitterLabel = (s: TaskSource) => (s.kind === "public" ? s.userName : s.submitterName || s.submitterEmail || null);

/** Where it came in, short: the form's name, or "public project" (VEC-256). */
const sourceName = (s: TaskSource) => (s.kind === "public" ? "public project" : s.formName);

/** List row chip: "via Bug report". Nothing for tasks created normally. */
export function FormSourceChip({ source, className }: { source: TaskSource | null | undefined; className?: string }) {
  if (!source) return null;
  const who = submitterLabel(source);
  const label = source.kind === "public" ? `Submitted by ${who} via public project` : `Submitted via the ${source.formName} form${who ? ` by ${who}` : ""}`;
  return (
    <span
      title={label}
      aria-label={label}
      data-task-source={source.kind}
      className={cn("inline-flex h-5 max-w-[160px] items-center gap-1 rounded-[5px] bg-chip px-1.5 text-[12px] whitespace-nowrap text-muted-foreground", className)}
    >
      {source.kind === "public" ? <GlobeIcon aria-hidden className="size-3 shrink-0" /> : <FileInputIcon aria-hidden className="size-3 shrink-0" />}
      <span className="truncate">via {sourceName(source)}</span>
    </span>
  );
}

/** Task pane "Created ... by" value for a form task: the form, with its icon in the avatar slot. */
export function FormCreator({ source }: { source: TaskSource }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5" data-task-source={source.kind}>
      <span aria-hidden className="grid size-4 shrink-0 place-items-center rounded-full bg-chip text-muted-foreground">
        {source.kind === "public" ? <GlobeIcon className="size-2.5" /> : <FileInputIcon className="size-2.5" />}
      </span>
      <span className="truncate" title={source.kind === "public" ? "Submitted through the project's public page" : `Submitted through the ${source.formName} form`}>
        {source.kind === "public" ? "Public project" : `${source.formName} form`}
      </span>
    </span>
  );
}

/** Task pane "Submitted by" value: name and email (a mailto link), or a note that they left both blank. */
export function FormSubmitter({ source }: { source: TaskSource }) {
  // VEC-256: "<name> via public project". The submitter is an Aimpoint account, usually not a member; no email is kept.
  if (source.kind === "public")
    return (
      <span className="flex min-w-0 items-center gap-1.5" data-public-submitter title={`Submitted by ${source.userName} via public project`}>
        <span className="truncate text-foreground">{source.userName}</span>
        <span className="shrink-0 text-faint">via public project</span>
      </span>
    );
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
