"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { changeEmail, type ChangeEmailField } from "@/app/actions/account";

const EMPTY = { email: "", password: "", code: "" };

/** Current sign-in email, and a change form that asks for the password (and a 2FA code when it's on). */
export function EmailForm({ email: current, twoFactor }: { email: string; twoFactor: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState(EMPTY);
  const [error, setError] = useState<{ message: string; field?: ChangeEmailField } | null>(null);
  const [pending, start] = useTransition();
  const filled = values.email.trim() && values.password && (!twoFactor || values.code.trim());
  const close = () => {
    setOpen(false);
    setValues(EMPTY);
    setError(null);
  };

  if (!open) {
    return (
      <div className="grid max-w-md gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="account-email" className="text-[13px]">Email</Label>
          <Input id="account-email" value={current} readOnly disabled />
        </div>
        <div>
          <Button variant="outline" onClick={() => setOpen(true)}>
            Change email
          </Button>
        </div>
      </div>
    );
  }

  const field = (key: ChangeEmailField, label: string, props: React.ComponentProps<typeof Input>, hint?: string) => {
    const id = `email-${key}`;
    const invalid = error?.field === key;
    return (
      <div className="grid gap-1.5">
        <Label htmlFor={id} className="text-[13px]">{label}</Label>
        <Input
          id={id}
          value={values[key]}
          onChange={(e) => {
            setValues((v) => ({ ...v, [key]: e.target.value }));
            if (error) setError(null);
          }}
          aria-invalid={invalid}
          aria-describedby={invalid ? "email-error" : hint ? `${id}-hint` : undefined}
          {...props}
        />
        {hint && !invalid && <p id={`${id}-hint`} className="text-[12px] text-faint">{hint}</p>}
      </div>
    );
  };

  return (
    <form
      className="grid max-w-md gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await changeEmail(values).catch(() => null);
          if (!r) return setError({ message: "Couldn't reach the server. Try again." });
          if (!r.ok) return setError({ message: r.error, field: r.field });
          close();
          toast.success(`Email changed. Sign in with ${r.data?.email ?? "your new email"} from now on.`);
          router.refresh();
        });
      }}
    >
      <p className="text-[13px] text-muted-foreground">
        Currently <span className="font-medium text-foreground">{current}</span>
      </p>
      {field("email", "New email", { type: "email", autoComplete: "email", maxLength: 254, autoFocus: true }, "You'll sign in with this address. Your current one stops working straight away.")}
      {field("password", "Current password", { type: "password", autoComplete: "current-password", maxLength: 200 })}
      {twoFactor &&
        field(
          "code",
          "Authentication code",
          { autoComplete: "one-time-code", maxLength: 64, spellCheck: false },
          "A 6-digit code from your authenticator app, or a recovery code.",
        )}
      {error && (
        <p id="email-error" role="alert" className="text-[12.5px] text-destructive">
          {error.message}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" variant="outline" disabled={pending || !filled}>
          {pending ? "Changing…" : "Change email"}
        </Button>
        <Button type="button" variant="ghost" onClick={close} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
