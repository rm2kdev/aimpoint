"use client";

/**
 * VEC-404: the triager's plan, shown apart from the reporter's original description, and the description/plan history
 * rows of the activity feed (VEC-402 keeps the replaced text on each entry's `from`).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRightIcon, ListChecksIcon, RotateCcwIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useOrg } from "@/components/org-provider";
import { MemberAvatar } from "@/components/bits";
import { RichEditor } from "@/components/rich-editor";
import { resolveEditorUploads } from "@/components/editor-uploads";
import { getTaskDetail, updateTask } from "@/app/actions/tasks";
import { timeAgo } from "@/lib/format";
import type { FeedItem, TaskDetail } from "@/lib/types";

export type PlanFields = Pick<TaskDetail, "triagePlan" | "triagePlanBy" | "triagePlanAt">;

/** Text-only check, mirroring normalizePlan on the server: empty paragraphs and whitespace are no text at all. */
export function hasVisibleText(html: string | null | undefined): boolean {
  if (!html) return false;
  return !!html
    .replace(/<(img|hr)\b[^>]*>/gi, "x")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|\s/g, "");
}

/**
 * Same rich text apart from empty paragraphs at the end. The editor's trailing-node rule appends an empty paragraph after
 * a closing list or heading the first time it handles a transaction (a remount, a sync), and that alone must not save
 * the text again: with VEC-402 every save of a changed text leaves a history entry.
 */
export function sameRichText(a: string | null | undefined, b: string | null | undefined): boolean {
  const trim = (h: string | null | undefined) => (h ?? "").replace(/(<p>(\s|&nbsp;|<br\s*\/?>)*<\/p>)+$/i, "").trim();
  return trim(a) === trim(b);
}

/**
 * The Plan card. Hidden when the task has no plan; the creator or an admin edits it in place (autosave, like the
 * description), everyone else reads it. Clearing it while editing keeps the card until the pane reloads.
 */
export function PlanSection({
  task,
  canEdit,
  syncKey,
  onSaved,
}: {
  task: TaskDetail;
  canEdit: boolean;
  syncKey: number;
  onSaved: (fields: PlanFields) => void;
}) {
  const { org, memberById } = useOrg();
  const [touched, setTouched] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pending = useRef<string | null>(null);
  const taskId = task.id;

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    if (pending.current === null) return;
    const raw = pending.current;
    pending.current = null;
    setSaveState("saving");
    // VEC-455: images still uploading are saved once they land (never as blob: previews).
    const html = await resolveEditorUploads(raw);
    const r = await updateTask(org.slug, taskId, { triagePlan: hasVisibleText(html) ? html : null });
    if (!r.ok) {
      toast.error(r.error);
      setSaveState("idle");
      return;
    }
    setSaveState("saved");
    // The server sanitises and stamps who/when: take its copy of the plan fields (the editor keeps its own content).
    const d = await getTaskDetail(org.slug, r.data?.key ?? task.key);
    if (d.ok) onSaved({ triagePlan: d.data!.task.triagePlan, triagePlanBy: d.data!.task.triagePlanBy, triagePlanAt: d.data!.task.triagePlanAt });
  }, [org.slug, taskId, task.key, onSaved]);
  useEffect(() => () => void flush(), [flush]);

  if (!task.triagePlan && !touched) return null;
  const by = task.triagePlanBy ? memberById.get(task.triagePlanBy) : undefined;

  return (
    <section aria-label="Plan" className="mt-6 rounded-[10px] border border-border bg-sidebar px-3.5 pt-3 pb-1">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
        <h3 className="flex items-center gap-1.5 font-semibold">
          <ListChecksIcon className="size-3.5 text-muted-foreground" /> Plan
        </h3>
        {task.triagePlanBy && (
          <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
            <span className="text-faint">by</span>
            <MemberAvatar member={by} id={task.triagePlanBy} size={16} />
            <span className="truncate">{by?.name ?? "a former member"}</span>
          </span>
        )}
        {task.triagePlanAt && (
          <time className="text-[12px] text-faint" dateTime={task.triagePlanAt} title={new Date(task.triagePlanAt).toLocaleString()}>
            {timeAgo(task.triagePlanAt)}
          </time>
        )}
      </div>
      <RichEditor
        orgSlug={org.slug}
        ariaLabel="Plan"
        className="mt-2"
        editable={canEdit}
        placeholder={canEdit ? "Write the plan…" : "No plan"}
        value={task.triagePlan ?? ""}
        syncKey={syncKey}
        onChange={(html) => {
          if (sameRichText(html, task.triagePlan)) {
            // Back to what's stored (or only a trailing empty paragraph was added): nothing to save.
            clearTimeout(timer.current);
            pending.current = null;
            return;
          }
          pending.current = html;
          setTouched(true);
          setSaveState("idle");
          clearTimeout(timer.current);
          timer.current = setTimeout(flush, 700);
        }}
      />
      <p className="mt-2 h-4 text-[11.5px] text-faint" aria-live="polite">
        {saveState === "saving" ? "Saving…" : saveState === "saved" ? (task.triagePlan ? "Saved" : "Plan cleared") : ""}
      </p>
    </section>
  );
}

/**
 * One description/plan history row: "Ryan edited the description" with the replaced text behind a toggle, and a
 * Restore button for those who may edit the task.
 */
export function TextHistoryRow({
  item,
  actorName,
  cleared,
  canRestore,
  onRestore,
}: {
  item: FeedItem;
  actorName: string;
  /** The latest plan entry while the task has no plan: the change cleared it. */
  cleared: boolean;
  canRestore: boolean;
  onRestore: (kind: "description" | "plan", html: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const kind = item.kind === "plan" ? "plan" : "description";
  const prev = item.from ?? null;
  const hadText = hasVisibleText(prev);
  const what =
    kind === "plan"
      ? !hadText
        ? "added a plan"
        : cleared
          ? "cleared the plan"
          : "edited the plan"
      : hadText
        ? "edited the description"
        : "wrote the description";
  const label = kind === "plan" ? "previous plan" : "previous description";

  return (
    <li className="text-[13px] text-muted-foreground">
      {/* Top-aligned dot: at 390px the toggle wraps under the line, and the dot stays on the first line. */}
      <div className="flex items-start gap-2.5">
        <span className="grid h-5 w-[22px] shrink-0 place-items-center">
          <span className="size-1.5 rounded-full bg-input" />
        </span>
        <span className="min-w-0 leading-5">
          <span className="font-medium text-foreground">{actorName}</span> {what}
          <time className="ml-2 text-[12px] text-faint" dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString()}>
            {timeAgo(item.createdAt)}
          </time>
          {hadText && (
            <button
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              className="ml-2 inline-flex items-center gap-0.5 rounded text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
              {open ? `Hide ${label}` : `View ${label}`}
            </button>
          )}
        </span>
      </div>
      {open && prev && (
        <div className="mt-2 ml-[32px] rounded-[10px] border border-border bg-sidebar px-3 py-2">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-[11.5px] font-medium text-faint">{kind === "plan" ? "Plan before this change" : "Description before this change"}</span>
            {canRestore && (
              <button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  await onRestore(kind, prev);
                  setBusy(false);
                }}
                title={`Make this the ${kind === "plan" ? "plan" : "description"} again`}
                className="ml-auto inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                <RotateCcwIcon className="size-3" /> Restore
              </button>
            )}
          </div>
          <div className="prose-aimpoint max-h-[320px] overflow-y-auto text-[13.5px] break-words" dangerouslySetInnerHTML={{ __html: prev }} />
        </div>
      )}
    </li>
  );
}
