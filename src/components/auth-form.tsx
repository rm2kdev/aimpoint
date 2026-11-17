"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/logo";
import type { FormState } from "@/app/actions/auth";

type Mode = "login" | "signup";

export function AuthForm({
  mode,
  action,
  next,
  email,
  notice,
}: {
  mode: Mode;
  action: (s: FormState, f: FormData) => Promise<FormState>;
  next?: string;
  email?: string;
  /** One-line message above the form, e.g. after deleting an account. */
  notice?: string;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const nextQs = next ? `?next=${encodeURIComponent(next)}` : "";
  if (mode === "login" && state?.challenge) {
    return <CodeStep state={state} formAction={formAction} pending={pending} next={next} />;
  }
  return (
    <main className="grid min-h-full place-items-center bg-sidebar px-[calc(1rem+env(safe-area-inset-left))] py-[calc(4rem+env(safe-area-inset-top))]">
      <div className="w-full max-w-[360px]">
        <Logo className="mb-8" />
        <h1 className="text-[22px] font-semibold tracking-[-0.02em]">
          {mode === "login" ? "Sign in to Aimpoint" : "Create your account"}
        </h1>
        <p className="mt-1.5 text-[13.5px] text-muted-foreground">
          {mode === "login" ? "Pick up where your team left off." : "Then create an organisation or accept an invite."}
        </p>
        {notice && (
          <p role="status" className="mt-5 rounded-md border border-border bg-background px-3 py-2 text-[13px]">
            {notice}
          </p>
        )}
        <form action={formAction} className="mt-7 grid gap-4" noValidate>
          {next && <input type="hidden" name="next" value={next} />}
          {mode === "signup" && (
            <div className="grid gap-1.5">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" autoComplete="name" defaultValue={state?.fields?.name} required className="h-9 bg-background" />
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              defaultValue={state?.fields?.email ?? email}
              required
              className="h-9 bg-background"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              required
              minLength={mode === "signup" ? 8 : undefined}
              className="h-9 bg-background"
            />
            {mode === "signup" && <p className="text-xs text-faint">At least 8 characters.</p>}
          </div>
          <p role="alert" aria-live="polite" className="min-h-5 text-[13px] text-destructive">
            {state?.error}
          </p>
          <Button type="submit" size="lg" disabled={pending} className="-mt-2 h-9">
            {pending ? (mode === "login" ? "Signing in…" : "Creating account…") : mode === "login" ? "Sign in" : "Create account"}
          </Button>
        </form>
        <p className="mt-6 text-[13px] text-muted-foreground">
          {mode === "login" ? (
            <>
              New to Aimpoint?{" "}
              <Link className="font-medium text-foreground underline underline-offset-4" href={`/signup${nextQs}`}>
                Create an account
              </Link>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <Link className="font-medium text-foreground underline underline-offset-4" href={`/login${nextQs}`}>
                Sign in
              </Link>
            </>
          )}
        </p>
      </div>
    </main>
  );
}

/** Second sign-in step for accounts with two-factor authentication on. */
function CodeStep({
  state,
  formAction,
  pending,
  next,
}: {
  state: NonNullable<FormState>;
  formAction: (f: FormData) => void;
  pending: boolean;
  next?: string;
}) {
  const [recovery, setRecovery] = useState(false);
  const email = state.fields?.email ?? "";
  const restart = `/login?${new URLSearchParams({ ...(email ? { email } : {}), ...(next ? { next } : {}) })}`;
  return (
    <main className="grid min-h-full place-items-center bg-sidebar px-[calc(1rem+env(safe-area-inset-left))] py-[calc(4rem+env(safe-area-inset-top))]">
      <div className="w-full max-w-[360px]">
        <Logo className="mb-8" />
        <h1 className="text-[22px] font-semibold tracking-[-0.02em]">Two-factor authentication</h1>
        <p className="mt-1.5 text-[13.5px] text-muted-foreground">
          {recovery
            ? "Enter one of the recovery codes you saved when you turned on two-factor authentication. Each code works once."
            : "Enter the 6-digit code from your authenticator app."}
        </p>
        <form action={formAction} className="mt-7 grid gap-4" noValidate>
          <input type="hidden" name="challenge" value={state.challenge} />
          <input type="hidden" name="email" value={email} />
          {next && <input type="hidden" name="next" value={next} />}
          <div className="grid gap-1.5">
            <Label htmlFor="code">{recovery ? "Recovery code" : "Authentication code"}</Label>
            <Input
              key={recovery ? "recovery" : "totp"}
              id="code"
              name="code"
              autoFocus
              required
              autoComplete={recovery ? "off" : "one-time-code"}
              inputMode={recovery ? "text" : "numeric"}
              pattern={recovery ? undefined : "[0-9]*"}
              maxLength={recovery ? 11 : 6}
              placeholder={recovery ? "xxxxx-xxxxx" : "123456"}
              spellCheck={false}
              className="h-9 bg-background font-mono tracking-[0.12em]"
            />
          </div>
          <p role="alert" aria-live="polite" className="min-h-5 text-[13px] text-destructive">
            {state.error}
          </p>
          <Button type="submit" size="lg" disabled={pending} className="-mt-2 h-9">
            {pending ? "Verifying…" : "Verify"}
          </Button>
        </form>
        <div className="mt-6 flex items-center justify-between text-[13px] text-muted-foreground">
          <button type="button" className="font-medium text-foreground underline underline-offset-4" onClick={() => setRecovery((r) => !r)}>
            {recovery ? "Use your authenticator app" : "Use a recovery code"}
          </button>
          <a className="hover:text-foreground" href={restart}>
            Start over
          </a>
        </div>
      </div>
    </main>
  );
}
