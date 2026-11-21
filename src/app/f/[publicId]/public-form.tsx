"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { LogoMark } from "@/components/logo";
import { ComposerFieldError, TaskComposer, WAIT_FOR_UPLOADS, charactersLeftText, fieldKey, requiredText, usePendingUploads, type ComposerErrors } from "@/components/task-composer";
import type { FormField } from "@/lib/form-fields-core";
import { cn } from "@/lib/utils";

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

function Marker({ required }: { required: boolean }) {
  return <span className="font-normal text-faint">{required ? "(required)" : "(optional)"}</span>;
}

/** A screenshot field (TPA-400): Add image button (or drop), previews with Remove, uploads through `send`. */
function ScreenshotField({
  field,
  buttonId,
  previews,
  busy,
  max,
  error,
  describedBy,
  onFiles,
  onRemove,
}: {
  field: FormField;
  buttonId: string;
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
          id={buttonId}
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

/**
 * A project's external form (VEC-207) on the shared TaskComposer (VEC-358). The composer owns title, details, type,
 * submitter, honeypot, errors and sending; this adds the form's own questions (text and screenshot fields), the
 * thank-you state, the no-JavaScript post and the embed height report.
 */
export function PublicForm(p: PublicFormProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [sent, setSent] = useState(p.sent);
  const [type, setType] = useState(p.allowedTypes.includes(p.type) ? p.type : (p.allowedTypes[0] ?? p.type));
  const uploads = usePendingUploads(`/api/forms/${encodeURIComponent(p.publicId)}/uploads`);
  // TPA-400: custom field values (text by field id), screenshot previews per field and uploads in flight per field.
  const [values, setValues] = useState<Record<string, string>>({});
  const [shots, setShots] = useState<Record<string, string[]>>({});
  const [shotBusy, setShotBusy] = useState<Record<string, number>>({});
  useReportHeight(rootRef, p.embed);
  const shotsUploading = Object.values(shotBusy).some((n) => n > 0);

  /** Required fields and the shared text budget across them (the server checks the same again, TPA-399). */
  const validate = () => {
    const errors: ComposerErrors = {};
    let text = 0;
    for (const f of p.fields) {
      const empty = f.kind === "screenshot" ? !shots[f.id]?.length : !(values[f.id] ?? "").trim();
      if (f.kind !== "screenshot") text += (values[f.id] ?? "").trim().length;
      if (f.required && empty) errors[fieldKey(f.id)] = requiredText(f);
    }
    const summary =
      text > p.limits.fieldsText
        ? `That's too much text in one go (${text.toLocaleString()} characters across the fields, the most is ${p.limits.fieldsText.toLocaleString()}). Shorten some answers.`
        : null;
    return { errors, summary };
  };

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
              <Button type="button" variant="outline" className="mt-6 h-9" onClick={() => setSent(false)}>
                Send another
              </Button>
            </div>
          ) : (
            <>
              <h1 className="text-[20px] font-semibold tracking-[-0.02em] break-words">{p.name}</h1>
              {p.intro && <p className="mt-2 text-[13.5px] whitespace-pre-line break-words text-muted-foreground">{p.intro}</p>}
              <TaskComposer
                layout="page"
                className="mt-6"
                action={`/api/forms/${encodeURIComponent(p.publicId)}`}
                initialError={p.error}
                descriptionMode={p.hideDescription ? "none" : p.richText ? "rich" : "plain"}
                images={p.allowImages}
                upload={uploads.upload}
                descriptionMax={p.limits.description}
                descriptionPlaceholder={
                  p.allowImages ? "What happened, what you expected, steps to reproduce… Paste or drop screenshots." : "What happened, what you expected, steps to reproduce…"
                }
                type={p.typeMode === "choose" && p.allowedTypes.length > 0 ? { value: type, onChange: setType, allowed: p.allowedTypes } : undefined}
                submitter={{ nameMax: p.limits.name, emailMax: p.limits.email, emailHelp: p.emailHelp }}
                honeypot={p.honeypot}
                customFields={p.fields}
                validate={validate}
                busy={shotsUploading ? WAIT_FOR_UPLOADS : null}
                fields={(ctx) =>
                  p.fields.map((f) => {
                    const key = fieldKey(f.id);
                    const id = ctx.fieldId(f.id);
                    const message = ctx.errors[key];
                    const describedBy = [f.help && `${id}-help`, message && ctx.errorId(f.id)].filter(Boolean).join(" ") || undefined;
                    const value = values[f.id] ?? "";
                    const max = f.kind === "long" ? p.limits.long : p.limits.short;
                    const left = max - value.length;
                    const onText = (v: string) => {
                      setValues((cur) => ({ ...cur, [f.id]: v }));
                      ctx.clearError(key);
                    };
                    const addShots = async (files: File[]) => {
                      const room = p.limits.screenshots - (shots[f.id]?.length ?? 0) - (shotBusy[f.id] ?? 0);
                      const take = files.slice(0, Math.max(0, room));
                      if (!take.length) return;
                      ctx.clearError(key);
                      setShotBusy((b) => ({ ...b, [f.id]: (b[f.id] ?? 0) + take.length }));
                      await Promise.all(
                        take.map(async (file) => {
                          try {
                            const preview = await uploads.upload(file);
                            setShots((cur) => ({ ...cur, [f.id]: [...(cur[f.id] ?? []), preview] }));
                          } catch (err) {
                            ctx.setError(key, (err as Error).message);
                          } finally {
                            setShotBusy((b) => ({ ...b, [f.id]: (b[f.id] ?? 1) - 1 }));
                          }
                        }),
                      );
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
                            buttonId={id}
                            previews={shots[f.id] ?? []}
                            busy={shotBusy[f.id] ?? 0}
                            max={p.limits.screenshots}
                            error={message}
                            describedBy={[`${id}-label`, describedBy].filter(Boolean).join(" ")}
                            onFiles={(files) => void addShots(files)}
                            onRemove={(preview) => {
                              uploads.forget(preview);
                              setShots((cur) => ({ ...cur, [f.id]: (cur[f.id] ?? []).filter((s) => s !== preview) }));
                            }}
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
                        <ComposerFieldError id={ctx.errorId(f.id)} message={message} />
                        {f.kind === "long" && left < 300 && (
                          <p className={cn("text-xs", left <= 0 ? "text-destructive" : "text-faint")}>{charactersLeftText(left)}</p>
                        )}
                      </div>
                    );
                  })
                }
                onSubmit={async (v) => {
                  const body: Record<string, unknown> = { title: v.title, name: v.name, email: v.email, [p.honeypot]: v.honeypot };
                  if (p.typeMode === "choose") body.type = v.type;
                  if (p.fields.length) {
                    const out: Record<string, string | string[]> = {};
                    for (const f of p.fields) {
                      if (f.kind === "screenshot") out[f.id] = (shots[f.id] ?? []).map(uploads.stored).filter((u): u is string => !!u);
                      else out[f.id] = values[f.id] ?? "";
                    }
                    body.fields = out;
                  }
                  if (!p.hideDescription) {
                    body.description = p.richText ? uploads.resolve(v.description) : v.description;
                    if (p.richText) body.descriptionFormat = "html";
                  }
                  const res = await fetch(`/api/forms/${encodeURIComponent(p.publicId)}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Accept: "application/json" },
                    body: JSON.stringify(body),
                  });
                  const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
                  if (res.ok && data?.ok) {
                    setValues({});
                    setShots({});
                    uploads.reset();
                    setSent(true);
                    return { ok: true };
                  }
                  if (res.status === 404) return { ok: false, error: "This form isn't taking submissions any more." };
                  return { ok: false, error: data?.error ?? "That didn't go through. Try again in a moment." };
                }}
              />
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
