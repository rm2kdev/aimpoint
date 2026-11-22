"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { RichEditor, uploadImage, type ImageUploader } from "@/components/rich-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Kbd, StatusRing, TypeSquare } from "@/components/bits";
import { Picker, TYPE_OPTIONS } from "@/components/pickers";
import { TYPE_NAMES } from "@/lib/format";
import { INTAKE_ERRORS, TASK_DESCRIPTION_MAX, TASK_TITLE_MAX } from "@/lib/task-intake-core";
import { TASK_TYPES, type Status, type TaskType } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  checkComposer,
  charactersLeft,
  charactersLeftText,
  clearError as without,
  fieldKey,
  firstInvalid,
  hasErrors,
  invalidKeys,
  isPlainEnter,
  isSubmitShortcut,
  offeredTypes,
  serverFieldErrors,
  serverSummary,
  summaryHeading,
  trimEmptyParagraphs,
  typeCopy,
  type ComposerErrorKey,
  type ComposerErrors,
  type ComposerFieldRef,
} from "./task-composer-core";

/**
 * TaskComposer (VEC-357): the one task-creation form behind the in-app New task dialog and (VEC-358) the public
 * project submit and project forms. It owns the common parts (title, rich description with a pluggable uploader,
 * type picker, optional status picker, inline field errors with focus on the first one, the submit button and its
 * pending state, Cmd/Ctrl+Enter) and takes the surface-specific extras as slots: the in-app property row
 * (`properties`), a form's custom/screenshot fields (`fields`), submitter name/email (`submitter`) and a honeypot.
 * Limits and messages come from lib/task-intake-core, so the client check reads the same as the server's.
 *
 * Two layouts: `dialog` (borderless title, chip pickers, sticky footer with Cancel) and `page` (labelled fields,
 * card type picker, error summary box, a real <form> that can post without JavaScript via `action`).
 */

export const COMPOSER_CHIP =
  "inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent";

export interface ComposerValues {
  title: string;
  /** Rich HTML with Tiptap's trailing empty paragraphs removed ("" when empty). */
  description: string;
  /** Visible text length of the description. */
  descriptionLength: number;
  type: string | null;
  statusId: string | null;
  /** Submitter fields ("" when the composer has none). */
  name: string;
  email: string;
  /** The honeypot's value ("" for people). */
  honeypot: string;
}

/** What `onSubmit` reports: nothing / ok = done; an error is mapped onto the field it names (else shown as is). */
export type ComposerResult = { ok: true } | { ok: false; error: string } | void;

/** Handed to the `fields` slot so a surface's own fields join the error state and focus order. */
export interface ComposerFieldContext {
  errors: ComposerErrors;
  clearError: (key: ComposerErrorKey) => void;
  setError: (key: ComposerErrorKey, message: string) => void;
  /** DOM id to give the field's input (focus target). */
  fieldId: (id: string) => string;
  /** DOM id of the field's inline error (`aria-describedby`). */
  errorId: (id: string) => string;
  pending: boolean;
}

export interface ComposerStatusOption {
  id: string;
  name: string;
}

export interface TaskComposerProps {
  layout: "dialog" | "page";
  /** Org whose session upload is used when no `upload` is given (in-app). */
  orgSlug?: string;
  upload?: ImageUploader;
  /** Images in the description (paste, drop, button). Default true. */
  images?: boolean;
  /**
   * The description box: the rich editor (default), a plain textarea (forms with the rich text editor off) or none
   * (forms that ask their own questions instead). `values.description` is HTML, plain text or "" accordingly.
   */
  descriptionMode?: "rich" | "plain" | "none";
  onSubmit: (values: ComposerValues) => Promise<ComposerResult>;
  /** The type picker; leave out for a surface with a fixed type. One offered type shows no picker. */
  type?: { value: string; onChange: (t: TaskType) => void; allowed?: readonly string[] };
  /** The status picker (page layout; the dialog puts status in its property row). Shown with 2+ options. */
  status?: { value: string | null; onChange: (id: string) => void; options: ComposerStatusOption[]; statuses?: Status[] };
  /** In-app property row; gets the type picker to place where it likes. */
  properties?: (parts: { type: React.ReactNode }) => React.ReactNode;
  /** A form's own fields after the description. */
  fields?: (ctx: ComposerFieldContext) => React.ReactNode;
  /** Those fields' ids/labels, for server error mapping and focus order. */
  customFields?: readonly ComposerFieldRef[];
  /** Extra client checks (custom fields). Returns errors by key and an optional general line. */
  validate?: (values: ComposerValues) => { errors?: ComposerErrors; summary?: string | null } | null;
  /** Optional submitter name and email fields (forms). */
  submitter?: { nameMax: number; emailMax: number; emailHelp?: string | null };
  /** Honeypot input name (forms): off screen, out of the tab order. */
  honeypot?: string;
  /** Text cap of the description (public surfaces); none in-app. */
  descriptionMax?: number;
  /** Shows "N characters left" under the description once fewer than this remain. */
  descriptionWarnAt?: number;
  titleLabel?: string;
  titlePlaceholder?: string;
  descriptionLabel?: string;
  descriptionPlaceholder?: string;
  submitLabel?: string;
  pendingLabel?: string;
  /** Keeps the submit button disabled (e.g. no project to create in). */
  submitDisabled?: boolean;
  /** Blocks sending with this message (e.g. the caller's own uploads still running). */
  busy?: string | null;
  /** Dialog layout: a Cancel button. */
  onCancel?: () => void;
  /** Dialog layout: the small heading above the title. */
  header?: React.ReactNode;
  /** Next to the general error line (e.g. a Sign in again link). */
  errorExtra?: React.ReactNode;
  /** Page layout: a short line under the submit button (e.g. what happens after sending). */
  submitNote?: React.ReactNode;
  /** A general error to start with (e.g. back from a no-JavaScript post); page layout shows it in the summary. */
  initialError?: string | null;
  /** Called whenever the general error changes (e.g. to clear a caller's extra state). */
  onError?: (error: string | null) => void;
  /** Page layout: where the <form> posts without JavaScript (adds a plain-text description fallback). */
  action?: string;
  autoFocus?: boolean;
  /** Clear title, description and submitter after a successful send (a page that stays open). */
  resetOnSuccess?: boolean;
  className?: string;
}

export const WAIT_FOR_UPLOADS = "Wait for the images to finish uploading.";
const OFFLINE = "Couldn't reach the server. Check your connection and try again.";
const BAD_EMAIL = "Enter a full email address, like name@example.com, or leave it empty.";

export function ComposerFieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} className="flex items-start gap-1.5 text-[12.5px] text-destructive" data-composer-error>
      <svg viewBox="0 0 16 16" className="mt-0.5 size-3.5 shrink-0" aria-hidden>
        <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 4.75v3.75M8 10.9v.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <span>{message}</span>
    </p>
  );
}

export function TaskComposer(p: TaskComposerProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const ids = {
    title: `${uid}-title`,
    description: `${uid}-description`,
    type: `${uid}-type`,
    status: `${uid}-status`,
    name: `${uid}-name`,
    email: `${uid}-email`,
    field: (id: string) => `${uid}-field-${id}`,
    error: (k: string) => `${uid}-${k.replace(":", "-")}-error`,
  };
  const dialog = p.layout === "dialog";
  const rootRef = useRef<HTMLDivElement & HTMLFormElement>(null);
  const honeypotRef = useRef<HTMLInputElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  const [title, setTitle] = useState("");
  const [html, setHtml] = useState("");
  const [plain, setPlain] = useState("");
  const [textLength, setTextLength] = useState(0);
  const [editorKey, setEditorKey] = useState(0);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [errors, setErrors] = useState<ComposerErrors>({});
  const [summary, setSummary] = useState<string | null>(dialog ? null : (p.initialError ?? null));
  const [error, setErrorState] = useState<string | null>(dialog ? (p.initialError ?? null) : null);
  const [uploading, setUploading] = useState(0);
  const [pending, start] = useTransition();

  const onErrorRef = useRef(p.onError);
  useEffect(() => {
    onErrorRef.current = p.onError;
  });
  const setError = (e: string | null) => {
    setErrorState(e);
    onErrorRef.current?.(e);
  };

  const offered = offeredTypes(TASK_TYPES, p.type?.allowed);
  const statusOptions = p.status?.options ?? [];

  /* uploads: count the ones in flight so sending waits for them */
  const baseUpload: ImageUploader = p.upload ?? ((file) => uploadImage(p.orgSlug ?? "", file));
  const upload: ImageUploader = async (file) => {
    setUploading((n) => n + 1);
    try {
      return await baseUpload(file);
    } finally {
      setUploading((n) => n - 1);
    }
  };

  const clearKey = (k: ComposerErrorKey) => setErrors((cur) => without(cur, k));

  const focusKey = (k: ComposerErrorKey) => {
    const root = rootRef.current;
    if (!root) return;
    if (k === "description") {
      const box = document.getElementById(ids.description);
      return (box?.matches("textarea") ? box : box?.querySelector<HTMLElement>(".ProseMirror"))?.focus();
    }
    const id = k === "type" ? ids.type : k === "status" ? ids.status : k === "title" ? ids.title : k === "name" ? ids.name : k === "email" ? ids.email : ids.field(k.slice(6));
    const el = document.getElementById(id);
    // A fieldset of radios: focus the checked one (else the first).
    const target = el?.matches("fieldset") ? (el.querySelector<HTMLElement>("input:checked") ?? el.querySelector<HTMLElement>("input")) : el;
    target?.focus();
  };

  /** Inline messages (+ the page summary), then focus on the first part that needs attention. */
  const showInvalid = (next: ComposerErrors, text: string | null) => {
    setErrors(next);
    if (dialog) {
      setSummary(null);
      setError(hasErrors(next) ? null : text);
    } else {
      setSummary(text);
      setError(null);
    }
    const first = firstInvalid(next, p.customFields);
    // After the render that puts the messages in, so aria-describedby reads them with the focused field.
    requestAnimationFrame(() => {
      if (first) focusKey(first);
      else if (!dialog) summaryRef.current?.focus();
    });
  };

  const reset = () => {
    setTitle("");
    setHtml("");
    setPlain("");
    setTextLength(0);
    setEditorKey((k) => k + 1);
    setName("");
    setEmail("");
    setErrors({});
    setSummary(null);
    if (honeypotRef.current) honeypotRef.current.value = "";
  };

  const submit = () => {
    if (pending) return;
    if (uploading > 0) return setError(WAIT_FOR_UPLOADS);
    if (p.busy) return setError(p.busy);
    if (p.submitDisabled) return;
    const mode = p.descriptionMode ?? "rich";
    const values: ComposerValues = {
      title,
      description: mode === "rich" ? trimEmptyParagraphs(html) : mode === "plain" ? plain : "",
      descriptionLength: mode === "rich" ? textLength : mode === "plain" ? plain.length : 0,
      type: p.type ? p.type.value : null,
      statusId: p.status ? p.status.value : null,
      name,
      email,
      honeypot: honeypotRef.current?.value ?? "",
    };
    const found = checkComposer(
      values,
      {
        titleMax: TASK_TITLE_MAX,
        descriptionMax: p.descriptionMax,
        allowedTypes: p.type ? offered : undefined,
        allowedStatuses: statusOptions.length > 1 ? statusOptions.map((s) => s.id) : undefined,
      },
      {
        ...INTAKE_ERRORS,
        // The shared text names TASK_DESCRIPTION_MAX; a surface with another cap says its own number.
        descriptionTooLong: (length) =>
          p.descriptionMax === undefined || p.descriptionMax === TASK_DESCRIPTION_MAX
            ? INTAKE_ERRORS.descriptionTooLong(length)
            : `Keep the description under ${p.descriptionMax.toLocaleString("en-US")} characters (it's ${length.toLocaleString("en-US")}).`,
      },
    );
    // The browser's own email check (the server's "doesn't look right" catches the rest).
    const emailInput = p.submitter ? (document.getElementById(ids.email) as HTMLInputElement | null) : null;
    if (emailInput && email.trim() && emailInput.validity.typeMismatch) found.email = BAD_EMAIL;
    const extra = p.validate?.(values);
    const all = { ...found, ...extra?.errors };
    if (hasErrors(all) || extra?.summary) return showInvalid(all, extra?.summary ?? null);
    setErrors({});
    setSummary(null);
    setError(null);
    start(async () => {
      try {
        const r = await p.onSubmit(values);
        if (r && !r.ok) {
          const named = serverFieldErrors(r.error, p.customFields);
          return showInvalid(named, serverSummary(r.error, named));
        }
        if (p.resetOnSuccess) reset();
      } catch {
        setError(OFFLINE);
      }
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isSubmitShortcut({ key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, isComposing: e.nativeEvent.isComposing })) {
      e.preventDefault();
      submit();
    }
  };

  const describedBy = (k: ComposerErrorKey, ...more: (string | false | null | undefined)[]) =>
    [...more, errors[k] && ids.error(k)].filter(Boolean).join(" ") || undefined;

  const descriptionMode = p.descriptionMode ?? "rich";
  const left = charactersLeft(p.descriptionMax, descriptionMode === "plain" ? plain.length : textLength, p.descriptionWarnAt);
  const leftLine = left !== null && <p className={cn("text-xs", left < 0 ? "text-destructive" : "text-faint")}>{charactersLeftText(left)}</p>;
  const uploadingLine = uploading > 0 && (
    <p className="text-xs text-faint" aria-live="polite">
      Uploading {uploading === 1 ? "an image" : `${uploading} images`}…
    </p>
  );
  const images = p.images ?? true;

  /* ---------------- type picker ---------------- */

  const typePicker =
    p.type && offered.length > 1 ? (
      dialog ? (
        <Picker
          label="Type"
          value={p.type.value as TaskType}
          options={TYPE_OPTIONS.filter((o) => offered.includes(o.value))}
          onChange={(t) => {
            p.type!.onChange(t);
            clearKey("type");
          }}
          searchable={false}
        >
          <button type="button" id={ids.type} className={COMPOSER_CHIP} data-invalid={errors.type ? "" : undefined}>
            <TypeSquare type={p.type.value as TaskType} />
            {typeCopyShort(p.type.value)}
          </button>
        </Picker>
      ) : (
        <fieldset id={ids.type} className="grid gap-1.5" aria-describedby={describedBy("type")}>
          <legend className="mb-1.5 text-sm font-medium">What is it?</legend>
          <div className={cn("grid gap-2", offered.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
            {offered.map((t) => {
              const copy = typeCopy(t, TYPE_NAMES);
              return (
                <label
                  key={t}
                  className={cn(
                    "flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors",
                    p.type!.value === t ? "border-foreground/60 bg-chip" : "border-border hover:bg-chip/60",
                  )}
                >
                  <input
                    type="radio"
                    name="type"
                    value={t}
                    checked={p.type!.value === t}
                    onChange={() => {
                      p.type!.onChange(t);
                      clearKey("type");
                    }}
                    className="mt-0.5 accent-foreground"
                  />
                  <span className="grid">
                    <span className="text-[13.5px] font-medium">{copy.label}</span>
                    {copy.hint && <span className="text-[12.5px] text-muted-foreground">{copy.hint}</span>}
                  </span>
                </label>
              );
            })}
          </div>
          <ComposerFieldError id={ids.error("type")} message={errors.type} />
        </fieldset>
      )
    ) : null;

  /* ---------------- status picker (page) ---------------- */

  const statusPicker = p.status && statusOptions.length > 1 && (
    <fieldset id={ids.status} className="grid gap-1.5" aria-describedby={describedBy("status")}>
      <legend className="mb-1.5 text-sm font-medium">Status</legend>
      <div className="flex flex-wrap gap-2">
        {statusOptions.map((s) => (
          <label
            key={s.id}
            className={cn(
              "flex h-8 cursor-pointer items-center gap-2 rounded-lg border px-3 text-[13px] transition-colors has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50",
              p.status!.value === s.id ? "border-foreground/60 bg-chip" : "border-border hover:bg-chip/60",
            )}
          >
            <input
              type="radio"
              name="status"
              value={s.id}
              checked={p.status!.value === s.id}
              onChange={() => {
                p.status!.onChange(s.id);
                clearKey("status");
              }}
              className="sr-only"
            />
            {p.status!.statuses && <StatusRing status={p.status!.statuses.find((x) => x.id === s.id)} statuses={p.status!.statuses} size={14} />}
            {s.name}
          </label>
        ))}
      </div>
      <ComposerFieldError id={ids.error("status")} message={errors.status} />
    </fieldset>
  );

  /* ---------------- description ---------------- */

  const editor = (
    <RichEditor
      key={editorKey}
      orgSlug={p.orgSlug ?? ""}
      value=""
      onChange={(h) => {
        setHtml(h);
        if (errors.description) clearKey("description");
      }}
      onTextChange={(t) => setTextLength(t.trim().length)}
      upload={upload}
      images={images}
      onUploadError={dialog ? undefined : (m) => setError(m)}
      ariaLabel={p.descriptionLabel ?? (dialog ? "Description" : "Details")}
      placeholder={p.descriptionPlaceholder}
      className={
        dialog
          ? "mt-3 max-h-[42vh] overflow-y-auto pb-2 [&_.ProseMirror]:min-h-[5.5rem]"
          : "[&_.ProseMirror]:min-h-24 [&_.prose-aimpoint]:max-w-none [&_[role=toolbar]]:-mx-1.5 [&_[role=toolbar]]:mb-2 [&_[role=toolbar]]:static [&_[role=toolbar]]:border-0 [&_[role=toolbar]]:bg-transparent [&_[role=toolbar]]:p-0"
      }
    />
  );

  const fieldCtx: ComposerFieldContext = {
    errors,
    clearError: clearKey,
    setError: (k, m) => setErrors((cur) => ({ ...cur, [k]: m })),
    fieldId: ids.field,
    errorId: (id) => ids.error(fieldKey(id)),
    pending,
  };

  const submitBusy = pending || uploading > 0;
  const submitText = pending ? (p.pendingLabel ?? (dialog ? "Creating…" : "Sending…")) : uploading > 0 ? "Uploading…" : (p.submitLabel ?? (dialog ? "Create task" : "Send"));

  if (dialog) {
    return (
      <div ref={rootRef} onKeyDown={onKeyDown} className={cn("min-w-0", p.className)} data-task-composer="dialog">
        {p.header && <div className="flex items-center gap-2 px-5 pt-4 text-[12.5px] text-faint">{p.header}</div>}
        <div className="px-5 pt-3">
          <input
            id={ids.title}
            autoFocus={p.autoFocus ?? true}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              clearKey("title");
              if (error) setError(null);
            }}
            onKeyDown={(e) => {
              if (isPlainEnter({ key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing })) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={p.titlePlaceholder ?? "Task title"}
            aria-label={p.titleLabel ?? "Task title"}
            aria-invalid={errors.title ? true : undefined}
            aria-describedby={describedBy("title")}
            maxLength={TASK_TITLE_MAX}
            data-zoom-safe
            className="w-full bg-transparent text-[18px] font-semibold tracking-[-0.015em] outline-none placeholder:text-faint"
          />
          <ComposerFieldError id={ids.error("title")} message={errors.title} />
          <div id={ids.description}>{editor}</div>
          <ComposerFieldError id={ids.error("description")} message={errors.description} />
          {uploadingLine}
          {leftLine}
        </div>
        {p.fields?.(fieldCtx)}
        <div className="flex flex-wrap items-center gap-1.5 px-5 pt-1 pb-4">{p.properties ? p.properties({ type: typePicker }) : typePicker}</div>
        {/* sticky: with the phone keyboard up the dialog fits the visible area and scrolls, Create stays in reach (VEC-165) */}
        <div className="sticky bottom-0 flex items-center gap-3 rounded-b-xl border-t border-border bg-popover px-5 py-3">
          <p role="alert" aria-live="polite" className="line-clamp-2 min-w-0 flex-1 text-[13px] text-destructive">
            {error ?? (errors.type || errors.status ? (errors.type ?? errors.status) : null)}
            {p.errorExtra}
          </p>
          {p.onCancel && (
            <Button type="button" variant="ghost" onClick={p.onCancel}>
              Cancel
            </Button>
          )}
          <Button type="button" onClick={submit} disabled={submitBusy || p.submitDisabled}>
            {submitText}
            <Kbd className="border-transparent bg-white/15 text-current dark:bg-black/10">⌘↵</Kbd>
          </Button>
        </div>
      </div>
    );
  }

  /* ---------------- page layout ---------------- */

  const listed = invalidKeys(errors, p.customFields);
  const labelOf = (k: ComposerErrorKey): string =>
    k === "title"
      ? (p.titleLabel ?? "Title")
      : k === "description"
        ? (p.descriptionLabel ?? "Details")
        : k === "type"
          ? "Type"
          : k === "status"
            ? "Status"
            : k === "name"
              ? "Name"
              : k === "email"
                ? "Email"
                : (p.customFields?.find((f) => fieldKey(f.id) === k)?.label ?? "");
  const required = !!p.customFields?.length;

  return (
    <form
      ref={rootRef}
      action={p.action}
      method={p.action ? "post" : undefined}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={onKeyDown}
      noValidate
      className={cn("grid gap-4", p.className)}
      data-task-composer="page"
    >
      {(listed.length > 0 || summary) && (
        <div
          ref={summaryRef}
          tabIndex={-1}
          role="alert"
          data-form-summary
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-3.5 py-3 text-[13px] outline-none focus-visible:ring-[3px] focus-visible:ring-destructive/30"
        >
          <p className="font-medium text-destructive">{summaryHeading(listed.length)}</p>
          {listed.length > 0 && (
            <ul className="mt-1.5 grid gap-1">
              {listed.map((k) => (
                <li key={k}>
                  <a
                    href={`#${k === "description" ? ids.description : k.startsWith("field:") ? ids.field(k.slice(6)) : (ids as unknown as Record<string, string>)[k]}`}
                    onClick={(e) => {
                      e.preventDefault();
                      focusKey(k);
                    }}
                    className="text-foreground underline decoration-destructive/50 underline-offset-2 hover:decoration-destructive"
                  >
                    <span className="font-medium">{labelOf(k)}</span>: {errors[k]}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {summary && (
            <p className={cn("text-foreground", listed.length > 0 && "mt-1.5")}>
              {summary}
              {p.errorExtra}
            </p>
          )}
        </div>
      )}
      {typePicker}
      <div className="grid gap-1.5">
        <Label htmlFor={ids.title}>
          {p.titleLabel ?? "Title"} {required && <span className="font-normal text-faint">(required)</span>}
        </Label>
        <Input
          id={ids.title}
          name="title"
          required
          autoFocus={p.autoFocus}
          maxLength={TASK_TITLE_MAX}
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            clearKey("title");
            if (error) setError(null);
          }}
          placeholder={p.titlePlaceholder ?? "A short summary"}
          aria-invalid={errors.title ? true : undefined}
          aria-describedby={describedBy("title")}
          className="h-9 bg-background"
        />
        <ComposerFieldError id={ids.error("title")} message={errors.title} />
      </div>
      {descriptionMode === "plain" && (
        <div className="grid gap-1.5">
          <Label htmlFor={ids.description}>{p.descriptionLabel ?? "Details"}</Label>
          <Textarea
            id={ids.description}
            name="description"
            rows={6}
            maxLength={p.descriptionMax}
            value={plain}
            onChange={(e) => {
              setPlain(e.target.value);
              clearKey("description");
            }}
            placeholder={p.descriptionPlaceholder}
            aria-invalid={errors.description ? true : undefined}
            aria-describedby={describedBy("description")}
            className="min-h-32 bg-background"
          />
          <ComposerFieldError id={ids.error("description")} message={errors.description} />
          {leftLine}
        </div>
      )}
      {descriptionMode === "rich" && (
      <div className="grid gap-1.5">
        <Label onClick={() => focusKey("description")}>{p.descriptionLabel ?? "Details"}</Label>
        {/* Shell for the editor (it mounts on the client). With `action` and no JavaScript, the <noscript> textarea
            posts the details as plain text instead. */}
        <div
          id={ids.description}
          data-rich-shell
          aria-invalid={errors.description ? true : undefined}
          className={cn(
            "min-h-32 rounded-md border bg-background px-3 py-2 shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30",
            errors.description ? "border-destructive" : "border-input",
          )}
        >
          {editor}
        </div>
        {p.action && (
          <noscript>
            <style>{"[data-rich-shell]{display:none}"}</style>
            <Textarea name="description" rows={6} maxLength={p.descriptionMax} placeholder={p.descriptionPlaceholder} className="min-h-32 bg-background" />
          </noscript>
        )}
        <ComposerFieldError id={ids.error("description")} message={errors.description} />
        {uploadingLine}
        {leftLine}
      </div>
      )}
      {p.fields?.(fieldCtx)}
      {statusPicker}
      {p.submitter && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid content-start gap-1.5">
            <Label htmlFor={ids.name}>
              Name <span className="font-normal text-faint">(optional)</span>
            </Label>
            <Input
              id={ids.name}
              name="name"
              autoComplete="name"
              maxLength={p.submitter.nameMax}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                clearKey("name");
              }}
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={describedBy("name")}
              className="h-9 bg-background"
            />
            <ComposerFieldError id={ids.error("name")} message={errors.name} />
          </div>
          <div className="grid content-start gap-1.5">
            <Label htmlFor={ids.email}>
              Email <span className="font-normal text-faint">(optional)</span>
            </Label>
            <Input
              id={ids.email}
              name="email"
              type="email"
              autoComplete="email"
              maxLength={p.submitter.emailMax}
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                clearKey("email");
              }}
              aria-invalid={errors.email ? true : undefined}
              aria-describedby={describedBy("email", p.submitter.emailHelp && `${ids.email}-help`)}
              className="h-9 bg-background"
            />
            {p.submitter.emailHelp && (
              <p id={`${ids.email}-help`} className="text-[12.5px] text-muted-foreground">
                {p.submitter.emailHelp}
              </p>
            )}
            <ComposerFieldError id={ids.error("email")} message={errors.email} />
          </div>
        </div>
      )}
      {p.honeypot && (
        // Honeypot: off screen and out of the tab order. People leave it empty; form-filling bots don't.
        <div aria-hidden className="absolute -left-[9999px] h-px w-px overflow-hidden">
          <label htmlFor={`${uid}-hp`}>Leave this empty</label>
          <input ref={honeypotRef} id={`${uid}-hp`} name={p.honeypot} type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
        </div>
      )}
      <p role="alert" aria-live="polite" className="min-h-5 text-[13px] text-destructive">
        {error}
        {!summary && p.errorExtra}
        {/* Not announced again: the summary at the top already was. */}
        {!error && listed.length > 0 && <span aria-hidden>Fix the {listed.length === 1 ? "field" : "fields"} marked above, then send again.</span>}
      </p>
      <Button type="submit" size="lg" disabled={submitBusy || p.submitDisabled} className="-mt-2 h-9">
        {submitText}
      </Button>
      {p.submitNote && (
        <p data-composer-submit-note className="-mt-2 text-[12.5px] text-muted-foreground">
          {p.submitNote}
        </p>
      )}
    </form>
  );
}

const typeCopyShort = (t: string) => (TYPE_NAMES as Record<string, string>)[t] ?? t;
