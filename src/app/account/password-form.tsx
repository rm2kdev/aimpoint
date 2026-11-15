"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { changePassword, type ChangePasswordField } from "@/app/actions/account";
import { PASSWORD_MIN } from "@/lib/password";

const EMPTY = { current: "", next: "", confirm: "" };

const FIELDS: { key: ChangePasswordField; label: string; autoComplete: string; hint?: string }[] = [
  { key: "current", label: "Current password", autoComplete: "current-password" },
  { key: "next", label: "New password", autoComplete: "new-password", hint: `At least ${PASSWORD_MIN} characters.` },
  { key: "confirm", label: "Confirm new password", autoComplete: "new-password" },
];

/** Change password. The server re-validates everything and signs out the user's other sessions. */
export function PasswordForm() {
  const [values, setValues] = useState(EMPTY);
  const [error, setError] = useState<{ message: string; field?: ChangePasswordField } | null>(null);
  const [pending, start] = useTransition();
  const filled = values.current && values.next && values.confirm;

  return (
    <form
      className="grid max-w-md gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await changePassword(values).catch(() => null);
          if (!r) {
            setError({ message: "Couldn't reach the server. Try again." });
            return;
          }
          if (!r.ok) {
            setError({ message: r.error, field: r.field });
            return;
          }
          setError(null);
          setValues(EMPTY);
          toast.success("Password changed. Your other sessions were signed out.");
        });
      }}
    >
      {FIELDS.map((f) => {
        const id = `password-${f.key}`;
        const invalid = error?.field === f.key;
        return (
          <div key={f.key} className="grid gap-1.5">
            <Label htmlFor={id} className="text-[13px]">{f.label}</Label>
            <Input
              id={id}
              type="password"
              value={values[f.key]}
              onChange={(e) => {
                setValues((v) => ({ ...v, [f.key]: e.target.value }));
                if (error) setError(null);
              }}
              autoComplete={f.autoComplete}
              maxLength={200}
              aria-invalid={invalid}
              aria-describedby={invalid ? "password-error" : f.hint ? `${id}-hint` : undefined}
            />
            {f.hint && !invalid && (
              <p id={`${id}-hint`} className="text-[12px] text-faint">{f.hint}</p>
            )}
          </div>
        );
      })}
      {error && (
        <p id="password-error" role="alert" className="text-[12.5px] text-destructive">
          {error.message}
        </p>
      )}
      <div>
        <Button type="submit" variant="outline" disabled={pending || !filled}>
          {pending ? "Changing…" : "Change password"}
        </Button>
      </div>
    </form>
  );
}
