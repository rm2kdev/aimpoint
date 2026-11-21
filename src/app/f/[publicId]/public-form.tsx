"use client";

import { useEffect, useRef, useState } from "react";
import { RichEditor, type ImageUploader } from "@/components/rich-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { LogoMark } from "@/components/logo";
import { TYPE_NAMES } from "@/lib/format";
import type { FormField } from "@/lib/form-fields-core";
import { cn } from "@/lib/utils";
import { INTAKE_ERRORS } from "@/lib/task-intake-core";

export interface PublicFormProps {
  publicId: string;
  name: string;
  intro: string | null;
  typeMode: "fixed" | "choose";
  type: string;
  allowedTypes: string[];
  embed: boolean;
  /** Back from a no-JavaScript post: show the thank-you / an error straight away. */
  sent: boolean;
  error: string | null;
  /** `short`/`long`/`fieldsText`/`screenshots`: custom field caps (TPA-399, lib/form-fields-core.ts). */
  limits: { title: number; description: number; name: number; email: number; body: number; short: number; long: number; fieldsText: number; screenshots: number };
  honeypot: string;
  /** VEC-235: the details use the rich text editor (sent as HTML with `descriptionFormat: "html"`). */
  richText: boolean;
  /** Images may be added (uploaded first to `/api/forms/<publicId>/uploads`). Only with `richText`. */
  allowImages: boolean;
  /** TPA-400: the form's own questions after Details, in order. Empty on forms without custom fields. */
  fields: FormField[];
  /** Note shown under the Email field, when the admin set one. */
  emailHelp: string | null;
  /** The Details box is left out (the form asks its own questions instead). */
  hideDescription: boolean;
}

/**
 * Uploads through the public form endpoint. Uploaded images are only readable by the team, so the submitter's
 * editor shows a local preview (an object URL) and `urls` maps it to the stored URL, swapped in when sending.
 */
function usePublicUploads(publicId: string, onError: (message: string) => void) {
  const urls = useRef(new Map<string, string>());
  const [uploading, setUploading] = useState(0);
  useEffect(() => {
    const map = urls.current;
    return () => map.forEach((_url, preview) => URL.revokeObjectURL(preview));
  }, []);
  /** Uploads one image; returns its local preview URL. Throws with a message for the submitter, reporting nothing itself. */
  const send = async (file: File): Promise<string> => {
    setUploading((n) => n + 1);
    try {
      const body = new FormData();
      body.set("file", file);
      let res: Response;
      try {
        res = await fetch(`/api/forms/${encodeURIComponent(publicId)}/uploads`, { method: "POST", body });
      } catch {
        throw new Error("Couldn't reach the server to upload the image. Check your connection and try again.");
      }
      const json = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!res.ok || !json?.url) {
        if (json?.error) throw new Error(json.error);
        if (res.status === 413) throw new Error("That image is too large. Images can be up to 5 MB.");
        if (res.status === 429) {
          const wait = Math.ceil(Number(res.headers.get("Retry-After")) / 60) || 0;
          throw new Error(`Too many uploads from here. Try again in ${wait > 1 ? `${wait} minutes` : "a minute"}.`);
        }
        throw new Error("The image didn't upload. Try again.");
      }
      const preview = URL.createObjectURL(file);
      urls.current.set(preview, json.url);
      return preview;
    } finally {
      setUploading((n) => n - 1);
    }
  };
  /** The rich editor's uploader: like `send`, and the error goes to the form's message line too. */
  const upload: ImageUploader = async (file) => {
    try {
      return await send(file);
    } catch (e) {
      onError((e as Error).message);
      throw e;
    }
  };
  /** The editor's HTML with every preview URL replaced by its stored URL. */
  const resolve = (html: string) => {
    let out = html;
    urls.current.forEach((url, preview) => (out = out.split(preview).join(url)));
    return out;
  };
  const reset = () => {
    urls.current.forEach((_url, preview) => URL.revokeObjectURL(preview));
    urls.current.clear();
  };
  /** The stored URL behind a preview (screenshot fields send these). */
  const stored = (preview: string) => urls.current.get(preview) ?? null;
  /** Drops one upload the submitter removed (the stored file stays pending and expires unclaimed). */
  const forget = (preview: string) => {
    URL.revokeObjectURL(preview);
    urls.current.delete(preview);
  };
  return { send, upload, uploading, resolve, reset, stored, forget };
}

/** What each type means to someone outside the team. Types without an entry fall back to their usual name. */
const TYPE_HINTS: Record<string, { label: string; hint: string }> = {
  issue: { label: "Bug report", hint: "Something isn't working" },
  feature: { label: "Feature request", hint: "An idea or something missing" },
  task: { label: "Task", hint: "Something that needs doing" },
  question: { label: "Question", hint: "Something you'd like to know" },
};
const typeCopy = (t: string) =>
  TYPE_HINTS[t] ?? { label: (TYPE_NAMES as Record<string, string>)[t] ?? t.charAt(0).toUpperCase() + t.slice(1), hint: "" };

/** Tell an embedding page how tall the form is, so it can size its iframe (message `aimpoint:form:height`). */
function useReportHeight(ref: React.RefObject<HTMLElement | null>, embed: boolean) {
  useEffect(() => {
    const el = ref.current;
    if (!el || window.parent === window) return;
    // The card's bottom edge plus the page's bottom padding: the iframe height that shows it all without scrolling.
    const send = () => {
      const pad = parseFloat(getComputedStyle(el.closest("main") ?? el).paddingBottom) || 0;
      window.parent.postMessage({ type: "aimpoint:form:height", height: Math.ceil(el.getBoundingClientRect().bottom + window.scrollY + pad) }, "*");
    };
    const ro = new ResizeObserver(send);
    ro.observe(el);
    send();
    return () => ro.disconnect();
  }, [ref, embed]);
}

/** Keys of the things that can be marked invalid: the title, the email and each custom field (by its id). */
type ErrorKey = "title" | "email" | `field:${string}`;
const fieldKey = (id: string): ErrorKey => `field:${id}`;
/** The element to focus for a key: the input, the textarea, or a screenshot field's Add button. */
const domId = (k: ErrorKey) => (k === "title" ? "form-title" : k === "email" ? "form-email" : `form-field-${k.slice(6)}`);
const requiredText = (f: FormField) => (f.kind === "screenshot" ? "Add at least one image." : "Fill this in.");

/**
 * Which fields a server 400 is about (TPA-399 names them in quotes, e.g. `Fill in the required fields: "A", "B".`),
 * with the inline message for each. A message naming no field returns nothing and is shown in the summary only.
 */
function serverFieldErrors(message: string, fields: FormField[]): Partial<Record<ErrorKey, string>> {
  const out: Partial<Record<ErrorKey, string>> = {};
  if (message === INTAKE_ERRORS.titleMissing || /^Keep the title\b/.test(message)) out.title = message;
  if (/^Keep your email\b/.test(message)) out.email = message;
  const missing = /^Fill in\b/.test(message);
  for (const f of fields) {
    if (message.includes(`"${f.label}"`)) out[fieldKey(f.id)] = missing ? requiredText(f) : message;
  }
  return out;
}

function Marker({ required }: { required: boolean }) {
  return <span className="font-normal text-faint">{required ? "(required)" : "(optional)"}</span>;
}

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} className="flex items-start gap-1.5 text-[12.5px] text-destructive">
      <svg viewBox="0 0 16 16" className="mt-0.5 size-3.5 shrink-0" aria-hidden>
        <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 4.75v3.75M8 10.9v.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <span>{message}</span>
    </p>
  );
}

/** A screenshot field (TPA-400): Add image button (or drop), previews with Remove, uploads through `send`. */
function ScreenshotField({
  field,
  previews,
  busy,
  max,
  error,
  describedBy,
  onFiles,
  onRemove,
}: {
  field: FormField;
  previews: string[];
  busy: number;
  max: number;
  error: string | undefined;
  describedBy: string | undefined;
  onFiles: (files: File[]) => void;
  onRemove: (preview: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [over, setOver] = useState(false);
  const full = previews.length + busy >= max;
  const pick = (list: FileList | null) => {
    const files = [...(list ?? [])].filter((f) => f.type.startsWith("image/"));
    if (files.length) onFiles(files);
  };
  return (
    <div
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        pick(e.dataTransfer.files);
      }}
      className={cn(
        "rounded-md border border-dashed bg-background p-2.5 transition-colors",
        error ? "border-destructive" : over ? "border-foreground/60 bg-chip" : "border-input",
      )}
    >
      {previews.length > 0 && (
        <ul className="mb-2.5 grid grid-cols-3 gap-2 sm:grid-cols-4" aria-label={`${field.label} images`}>
          {previews.map((src, i) => (
            <li key={src} className="group relative aspect-[4/3] overflow-hidden rounded-md border border-border bg-chip">
              {/* eslint-disable-next-line @next/next/no-img-element -- a local object URL preview, nothing to optimise */}
              <img src={src} alt={`${field.label}, image ${i + 1}`} className="size-full object-cover" />
              <button
                type="button"
                onClick={() => {
                  onRemove(src);
                  buttonRef.current?.focus();
                }}
                aria-label={`Remove image ${i + 1} from ${field.label}`}
                className="absolute top-1 right-1 grid size-6 place-items-center rounded-full bg-background/90 text-foreground shadow-sm ring-1 ring-border outline-none hover:bg-background focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
                  <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Button
          ref={buttonRef}
          id={`form-field-${field.id}`}
          type="button"
          variant="outline"
          size="sm"
          className="h-8"
          disabled={full}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onClick={() => inputRef.current?.click()}
        >
          <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
            <rect x="2" y="3" width="12" height="10" rx="1.75" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <circle cx="5.75" cy="6.5" r="1.1" fill="currentColor" />
            <path d="M2.75 11.5 6.5 8.25l2.5 2.25 1.75-1.5 2.5 2.25" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          </svg>
          {previews.length ? "Add another image" : "Add image"}
        </Button>
        <span className="text-[12px] text-faint" aria-live="polite">
          {busy > 0 ? `Uploading ${busy === 1 ? "an image" : `${busy} images`}…` : full ? `Up to ${max} images` : "or drop one here, up to 5 MB"}
        </span>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
        multiple
        tabIndex={-1}
        aria-hidden
        className="sr-only"
        onChange={(e) => {
          pick(e.currentTarget.files);
          e.currentTarget.value = "";
        }}
      />
      <noscript>
        <p className="mt-1.5 text-[12px] text-muted-foreground">Adding images needs JavaScript turned on in your browser.</p>
      </noscript>
    </div>
  );
}

export function PublicForm(p: PublicFormProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [sent, setSent] = useState(p.sent);
  const [error, setError] = useState<string | null>(p.error);
  const [pending, setPending] = useState(false);
  const [type, setType] = useState(p.allowedTypes.includes(p.type) ? p.type : (p.allowedTypes[0] ?? p.type));
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  // Rich forms: the editor's HTML, its plain text (what the limit counts) and a key that remounts it empty.
  const [html, setHtml] = useState("");
  const [richTextLength, setRichTextLength] = useState(0);
  const [editorKey, setEditorKey] = useState(0);
  const uploads = usePublicUploads(p.publicId, setError);
  // TPA-400: custom field values (text by field id), screenshot previews per field and uploads in flight per field.
  const [values, setValues] = useState<Record<string, string>>({});
  const [shots, setShots] = useState<Record<string, string[]>>({});
  const [shotBusy, setShotBusy] = useState<Record<string, number>>({});
  // What's wrong, by field (inline messages + the summary list), and a summary line that names no field.
  const [invalid, setInvalid] = useState<Partial<Record<ErrorKey, string>>>({});
  const [summaryText, setSummaryText] = useState<string | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  useReportHeight(rootRef, p.embed);

  /** Every key in page order, so the summary lists them and focus lands on the first one top to bottom. */
  const order: ErrorKey[] = ["title", ...p.fields.map((f) => fieldKey(f.id)), "email"];
  const labelOf = (k: ErrorKey) => (k === "title" ? "Title" : k === "email" ? "Email" : (p.fields.find((f) => fieldKey(f.id) === k)?.label ?? ""));
  const invalidKeys = order.filter((k) => invalid[k]);
  const hasFields = p.fields.length > 0;

  const clearInvalid = (k: ErrorKey) => {
    if (!invalid[k]) return;
    setInvalid((cur) => {
      const next = { ...cur };
      delete next[k];
      return next;
    });
  };
  const focusKey = (k: ErrorKey) => document.getElementById(domId(k))?.focus();
  /** Inline messages + summary, then focus on the first field that needs attention. */
  const showInvalid = (errors: Partial<Record<ErrorKey, string>>, text: string | null) => {
    setInvalid(errors);
    setSummaryText(text);
    setError(null);
    const first = order.find((k) => errors[k]);
    // After the render that puts the messages in (aria-describedby then reads them out with the focused field).
    requestAnimationFrame(() => {
      if (first) focusKey(first);
      else summaryRef.current?.focus();
    });
  };

  async function addShots(f: FormField, files: File[]) {
    const room = p.limits.screenshots - (shots[f.id]?.length ?? 0) - (shotBusy[f.id] ?? 0);
    const take = files.slice(0, Math.max(0, room));
    if (!take.length) return;
    clearInvalid(fieldKey(f.id));
    setShotBusy((b) => ({ ...b, [f.id]: (b[f.id] ?? 0) + take.length }));
    await Promise.all(
      take.map(async (file) => {
        try {
          const preview = await uploads.send(file);
          setShots((cur) => ({ ...cur, [f.id]: [...(cur[f.id] ?? []), preview] }));
        } catch (err) {
          setInvalid((cur) => ({ ...cur, [fieldKey(f.id)]: (err as Error).message }));
        } finally {
          setShotBusy((b) => ({ ...b, [f.id]: (b[f.id] ?? 1) - 1 }));
        }
      }),
    );
  }
  const removeShot = (f: FormField, preview: string) => {
    uploads.forget(preview);
    setShots((cur) => ({ ...cur, [f.id]: (cur[f.id] ?? []).filter((s) => s !== preview) }));
  };

  /** The browser-side check before anything is sent (the server checks the same again, TPA-399). */
  function check(form: HTMLFormElement): { errors: Partial<Record<ErrorKey, string>>; text: string | null } {
    const errors: Partial<Record<ErrorKey, string>> = {};
    if (!title.trim()) errors.title = INTAKE_ERRORS.titleMissing;
    const email = form.querySelector<HTMLInputElement>("#form-email");
    if (email?.value.trim() && email.validity.typeMismatch) errors.email = "Enter a full email address, like name@example.com, or leave it empty.";
    let text = 0;
    for (const f of p.fields) {
      const empty = f.kind === "screenshot" ? !(shots[f.id]?.length) : !(values[f.id] ?? "").trim();
      if (f.kind !== "screenshot") text += (values[f.id] ?? "").trim().length;
      if (f.required && empty) errors[fieldKey(f.id)] = requiredText(f);
    }
    const over = text > p.limits.fieldsText;
    return {
      errors,
      text: over ? `That's too much text in one go (${text.toLocaleString()} characters across the fields, the most is ${p.limits.fieldsText.toLocaleString()}). Shorten some answers.` : null,
    };
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const fd = new FormData(e.currentTarget);
    const body: Record<string, unknown> = Object.fromEntries(
      [...fd.entries()].filter(([k]) => !k.startsWith("field_")).map(([k, v]) => [k, String(v)]),
    );
    if (uploads.uploading > 0) {
      setError("Wait for the images to finish uploading.");
      return;
    }
    const found = check(e.currentTarget);
    if (Object.keys(found.errors).length || found.text) {
      showInvalid(found.errors, found.text);
      return;
    }
    if (hasFields) {
      const out: Record<string, string | string[]> = {};
      for (const f of p.fields) {
        if (f.kind === "screenshot") out[f.id] = (shots[f.id] ?? []).map(uploads.stored).filter((u): u is string => !!u);
        else out[f.id] = values[f.id] ?? "";
      }
      body.fields = out;
    }
    if (p.hideDescription) delete body.description;
    else if (p.richText) {
      if (uploads.uploading > 0) {
        setError("Wait for the images to finish uploading.");
        return;
      }
      // Tiptap keeps an empty paragraph after a trailing image; it isn't content.
      body.description = html ? uploads.resolve(html).replace(/(<p><\/p>)+$/, "") : "";
      body.descriptionFormat = "html";
    }
    setPending(true);
    setError(null);
    setInvalid({});
    setSummaryText(null);
    try {
      const res = await fetch(`/api/forms/${encodeURIComponent(p.publicId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (res.ok && data?.ok) {
        setSent(true);
        formRef.current?.reset();
        setTitle("");
        setDescription("");
        setHtml("");
        setRichTextLength(0);
        setEditorKey((k) => k + 1);
        setValues({});
        setShots({});
        uploads.reset();
      } else if (res.status === 404) {
        setError("This form isn't taking submissions any more.");
      } else if (res.status === 400 && data?.error) {
        // The server's own check (TPA-399): mark the fields it names and show its message in the summary.
        const named = serverFieldErrors(data.error, p.fields);
        showInvalid(named, Object.keys(named).length && /^Fill in\b/.test(data.error) ? null : data.error);
      } else {
        setError(data?.error ?? "That didn't go through. Try again in a moment.");
      }
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  const descLeft = p.limits.description - (p.richText ? richTextLength : description.length);

  return (
    <main
      className={cn(
        "min-h-full",
        p.embed
          ? "bg-background px-4 py-4"
          : "flex flex-col items-center bg-sidebar px-[calc(1rem+env(safe-area-inset-left))] pt-[calc(2.5rem+env(safe-area-inset-top))] pb-[calc(2.5rem+env(safe-area-inset-bottom))] sm:justify-center",
      )}
    >
      <div className="w-full">
        <div
          ref={rootRef}
          className={cn("mx-auto w-full", p.embed ? "max-w-[560px]" : "max-w-[520px] rounded-xl border border-border bg-background p-5 shadow-sm sm:p-7")}
        >
          {sent ? (
            <div role="status" aria-live="polite" className="py-6 text-center">
              <div className="mx-auto grid size-10 place-items-center rounded-full bg-chip text-foreground">
                <svg viewBox="0 0 20 20" className="size-5" aria-hidden>
                  <path d="M5 10.5 8.5 14 15 6.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <h1 className="mt-4 text-[18px] font-semibold tracking-[-0.01em]">Thanks, we got it</h1>
              <p className="mt-1.5 text-[13.5px] text-muted-foreground">Your submission was sent to the team.</p>
              <Button type="button" variant="outline" className="mt-6 h-9" onClick={() => { setSent(false); setError(null); }}>
                Send another
              </Button>
            </div>
          ) : (
            <>
              <h1 className="text-[20px] font-semibold tracking-[-0.02em] break-words">{p.name}</h1>
              {p.intro && <p className="mt-2 text-[13.5px] whitespace-pre-line break-words text-muted-foreground">{p.intro}</p>}
              <form
                ref={formRef}
                action={`/api/forms/${encodeURIComponent(p.publicId)}`}
                method="post"
                onSubmit={onSubmit}
                noValidate
                className="mt-6 grid gap-4"
              >
                {(invalidKeys.length > 0 || summaryText) && (
                  <div
                    ref={summaryRef}
                    tabIndex={-1}
                    role="alert"
                    data-form-summary
                    className="rounded-lg border border-destructive/40 bg-destructive/10 px-3.5 py-3 text-[13px] outline-none focus-visible:ring-[3px] focus-visible:ring-destructive/30"
                  >
                    <p className="font-medium text-destructive">
                      {invalidKeys.length === 0
                        ? "That didn't go through."
                        : invalidKeys.length === 1
                          ? "One thing needs fixing before you send:"
                          : `${invalidKeys.length} things need fixing before you send:`}
                    </p>
                    {invalidKeys.length > 0 && (
                      <ul className="mt-1.5 grid gap-1">
                        {invalidKeys.map((k) => (
                          <li key={k}>
                            <a
                              href={`#${domId(k)}`}
                              onClick={(e) => {
                                e.preventDefault();
                                focusKey(k);
                              }}
                              className="text-foreground underline decoration-destructive/50 underline-offset-2 hover:decoration-destructive"
                            >
                              <span className="font-medium">{labelOf(k)}</span>: {invalid[k]}
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                    {summaryText && <p className={cn("text-foreground", invalidKeys.length > 0 && "mt-1.5")}>{summaryText}</p>}
                  </div>
                )}
                {p.typeMode === "choose" && p.allowedTypes.length > 0 && (
                  <fieldset className="grid gap-1.5">
                    <legend className="mb-1.5 text-sm font-medium">What is it?</legend>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {p.allowedTypes.map((t) => {
                        const copy = typeCopy(t);
                        return (
                          <label
                            key={t}
                            className={cn(
                              "flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors",
                              type === t ? "border-foreground/60 bg-chip" : "border-border hover:bg-chip/60",
                            )}
                          >
                            <input
                              type="radio"
                              name="type"
                              value={t}
                              checked={type === t}
                              onChange={() => setType(t)}
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
                  </fieldset>
                )}
                <div className="grid gap-1.5">
                  <Label htmlFor="form-title">
                    Title {hasFields && <Marker required />}
                  </Label>
                  <Input
                    id="form-title"
                    name="title"
                    required
                    maxLength={p.limits.title}
                    value={title}
                    onChange={(e) => {
                      setTitle(e.target.value);
                      clearInvalid("title");
                    }}
                    placeholder="A short summary"
                    aria-invalid={invalid.title ? true : undefined}
                    aria-describedby={invalid.title ? "form-title-error" : undefined}
                    className="h-9 bg-background"
                  />
                  <FieldError id="form-title-error" message={invalid.title} />
                </div>
                {!p.hideDescription && <div className="grid gap-1.5">
                  {p.richText ? (
                    <>
                      <Label id="form-description-label" onClick={() => rootRef.current?.querySelector<HTMLElement>(".ProseMirror")?.focus()}>
                        Details
                      </Label>
                      {/* Shell for the editor (which mounts on the client). Without JavaScript it's hidden and the
                          plain textarea in <noscript> posts the details as text instead. */}
                      <div
                        data-rich-shell
                        className="min-h-32 rounded-md border border-input bg-background px-3 py-2 shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30"
                      >
                        <RichEditor
                          key={editorKey}
                          orgSlug=""
                          value=""
                          onChange={setHtml}
                          onTextChange={(t) => setRichTextLength(t.trim().length)}
                          upload={uploads.upload}
                          images={p.allowImages}
                          ariaLabel="Details"
                          placeholder={
                            p.allowImages
                              ? "What happened, what you expected, steps to reproduce… Paste or drop screenshots."
                              : "What happened, what you expected, steps to reproduce…"
                          }
                          className="[&_.ProseMirror]:min-h-24 [&_.prose-aimpoint]:max-w-none [&_[role=toolbar]]:-mx-1.5 [&_[role=toolbar]]:mb-2 [&_[role=toolbar]]:static [&_[role=toolbar]]:border-0 [&_[role=toolbar]]:bg-transparent [&_[role=toolbar]]:p-0"
                        />
                      </div>
                      <noscript>
                        <style>{"[data-rich-shell]{display:none}"}</style>
                        <Textarea
                          id="form-description"
                          name="description"
                          rows={6}
                          maxLength={p.limits.description}
                          placeholder="What happened, what you expected, steps to reproduce…"
                          className="min-h-32 bg-background"
                        />
                      </noscript>
                      {uploads.uploading > 0 && (
                        <p className="text-xs text-faint" aria-live="polite">
                          Uploading {uploads.uploading === 1 ? "an image" : `${uploads.uploading} images`}…
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      <Label htmlFor="form-description">Details</Label>
                      <Textarea
                        id="form-description"
                        name="description"
                        rows={6}
                        maxLength={p.limits.description}
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        placeholder="What happened, what you expected, steps to reproduce…"
                        className="min-h-32 bg-background"
                      />
                    </>
                  )}
                  {descLeft < 500 && (
                    <p className={cn("text-xs", descLeft < 0 ? "text-destructive" : "text-faint")}>{descLeft.toLocaleString()} characters left</p>
                  )}
                </div>}
                {p.fields.map((f) => {
                  const key = fieldKey(f.id);
                  const id = `form-field-${f.id}`;
                  const message = invalid[key];
                  const describedBy = [f.help && `${id}-help`, message && `${id}-error`].filter(Boolean).join(" ") || undefined;
                  const value = values[f.id] ?? "";
                  const max = f.kind === "long" ? p.limits.long : p.limits.short;
                  const left = max - value.length;
                  const onText = (v: string) => {
                    setValues((cur) => ({ ...cur, [f.id]: v }));
                    clearInvalid(key);
                  };
                  const label = (
                    <>
                      {f.label} <Marker required={f.required} />
                    </>
                  );
                  return (
                    <div key={f.id} className="grid gap-1.5" data-form-field={f.kind}>
                      {f.kind === "screenshot" ? (
                        <Label asChild>
                          <span id={`${id}-label`}>{label}</span>
                        </Label>
                      ) : (
                        <Label htmlFor={id}>{label}</Label>
                      )}
                      {f.help && (
                        <p id={`${id}-help`} className="-mt-0.5 text-[12.5px] whitespace-pre-line text-muted-foreground">
                          {f.help}
                        </p>
                      )}
                      {f.kind === "screenshot" ? (
                        <ScreenshotField
                          field={f}
                          previews={shots[f.id] ?? []}
                          busy={shotBusy[f.id] ?? 0}
                          max={p.limits.screenshots}
                          error={message}
                          describedBy={[`${id}-label`, describedBy].filter(Boolean).join(" ")}
                          onFiles={(files) => void addShots(f, files)}
                          onRemove={(preview) => removeShot(f, preview)}
                        />
                      ) : f.kind === "long" ? (
                        <Textarea
                          id={id}
                          name={`field_${f.id}`}
                          rows={4}
                          maxLength={max}
                          value={value}
                          onChange={(e) => onText(e.target.value)}
                          aria-invalid={message ? true : undefined}
                          aria-describedby={describedBy}
                          aria-required={f.required || undefined}
                          className="min-h-24 bg-background"
                        />
                      ) : (
                        <Input
                          id={id}
                          name={`field_${f.id}`}
                          maxLength={max}
                          value={value}
                          onChange={(e) => onText(e.target.value)}
                          aria-invalid={message ? true : undefined}
                          aria-describedby={describedBy}
                          aria-required={f.required || undefined}
                          className="h-9 bg-background"
                        />
                      )}
                      <FieldError id={`${id}-error`} message={message} />
                      {f.kind === "long" && left < 300 && (
                        <p className={cn("text-xs", left <= 0 ? "text-destructive" : "text-faint")}>{left.toLocaleString()} characters left</p>
                      )}
                    </div>
                  );
                })}
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid content-start gap-1.5">
                    <Label htmlFor="form-name">
                      Name <span className="font-normal text-faint">(optional)</span>
                    </Label>
                    <Input id="form-name" name="name" autoComplete="name" maxLength={p.limits.name} className="h-9 bg-background" />
                  </div>
                  <div className="grid content-start gap-1.5">
                    <Label htmlFor="form-email">
                      Email <span className="font-normal text-faint">(optional)</span>
                    </Label>
                    <Input
                      id="form-email"
                      name="email"
                      type="email"
                      autoComplete="email"
                      maxLength={p.limits.email}
                      onChange={() => clearInvalid("email")}
                      aria-invalid={invalid.email ? true : undefined}
                      aria-describedby={[p.emailHelp && "form-email-help", invalid.email && "form-email-error"].filter(Boolean).join(" ") || undefined}
                      className="h-9 bg-background"
                    />
                    {p.emailHelp && (
                      <p id="form-email-help" className="text-[12.5px] text-muted-foreground">
                        {p.emailHelp}
                      </p>
                    )}
                    <FieldError id="form-email-error" message={invalid.email} />
                  </div>
                </div>
                {/* Honeypot: off screen and out of the tab order. People leave it empty; form-filling bots don't. */}
                <div aria-hidden className="absolute -left-[9999px] h-px w-px overflow-hidden">
                  <label htmlFor="form-hp">Leave this empty</label>
                  <input id="form-hp" name={p.honeypot} type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
                </div>
                <p role="alert" aria-live="polite" className="min-h-5 text-[13px] text-destructive">
                  {error}
                  {/* Not announced again: the summary at the top already was. */}
                  {!error && invalidKeys.length > 0 && <span aria-hidden>Fix the {invalidKeys.length === 1 ? "field" : "fields"} marked above, then send again.</span>}
                </p>
                <Button type="submit" size="lg" disabled={pending || uploads.uploading > 0} className="-mt-2 h-9">
                  {pending ? "Sending…" : uploads.uploading > 0 ? "Uploading…" : "Send"}
                </Button>
              </form>
            </>
          )}
        </div>
        {!p.embed && (
          <p className="mx-auto mt-4 flex items-center justify-center gap-1.5 text-[12px] text-faint">
            <LogoMark className="size-3.5" /> Powered by Aimpoint
          </p>
        )}
      </div>
    </main>
  );
}
