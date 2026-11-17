"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { LogoMark } from "@/components/logo";
import { TYPE_NAMES } from "@/lib/format";
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
  limits: { title: number; description: number; name: number; email: number; body: number };
  honeypot: string;
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

export function PublicForm(p: PublicFormProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [sent, setSent] = useState(p.sent);
  const [error, setError] = useState<string | null>(p.error);
  const [pending, setPending] = useState(false);
  const [type, setType] = useState(p.allowedTypes.includes(p.type) ? p.type : (p.allowedTypes[0] ?? p.type));
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  useReportHeight(rootRef, p.embed);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const fd = new FormData(e.currentTarget);
    const body = Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)]));
    if (!String(body.title ?? "").trim()) {
      setError("Give it a title.");
      e.currentTarget.querySelector<HTMLInputElement>("#form-title")?.focus();
      return;
    }
    setPending(true);
    setError(null);
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
      } else if (res.status === 404) {
        setError("This form isn't taking submissions any more.");
      } else {
        setError(data?.error ?? "That didn't go through. Try again in a moment.");
      }
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  const descLeft = p.limits.description - description.length;

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
                  <Label htmlFor="form-title">Title</Label>
                  <Input
                    id="form-title"
                    name="title"
                    required
                    maxLength={p.limits.title}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="A short summary"
                    className="h-9 bg-background"
                  />
                </div>
                <div className="grid gap-1.5">
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
                  {descLeft < 500 && (
                    <p className={cn("text-xs", descLeft < 0 ? "text-destructive" : "text-faint")}>{descLeft.toLocaleString()} characters left</p>
                  )}
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label htmlFor="form-name">
                      Name <span className="font-normal text-faint">(optional)</span>
                    </Label>
                    <Input id="form-name" name="name" autoComplete="name" maxLength={p.limits.name} className="h-9 bg-background" />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="form-email">
                      Email <span className="font-normal text-faint">(optional)</span>
                    </Label>
                    <Input id="form-email" name="email" type="email" autoComplete="email" maxLength={p.limits.email} className="h-9 bg-background" />
                  </div>
                </div>
                {/* Honeypot: off screen and out of the tab order. People leave it empty; form-filling bots don't. */}
                <div aria-hidden className="absolute -left-[9999px] h-px w-px overflow-hidden">
                  <label htmlFor="form-hp">Leave this empty</label>
                  <input id="form-hp" name={p.honeypot} type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
                </div>
                <p role="alert" aria-live="polite" className="min-h-5 text-[13px] text-destructive">
                  {error}
                </p>
                <Button type="submit" size="lg" disabled={pending} className="-mt-2 h-9">
                  {pending ? "Sending…" : "Send"}
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
