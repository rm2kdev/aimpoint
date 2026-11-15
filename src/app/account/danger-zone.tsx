"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { deleteMyAccount, type DeleteAccountField } from "@/app/actions/account";

export interface DangerZonePlan {
  /** Orgs where the user is the only admin and others are still members: deletion is refused. */
  blocked: { id: string; name: string }[];
  /** Orgs where the user is the only member: deleted with the account (opt-in). */
  soleOrgs: { id: string; name: string }[];
}

const EMPTY = { email: "", password: "", code: "" };

const list = (names: string[]) => (names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** Danger zone on the account page: delete the account after typing the email, password and 2FA code. */
export function DangerZone({ email, twoFactor, plan }: { email: string; twoFactor: boolean; plan: DangerZonePlan }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState(EMPTY);
  const [withOrgs, setWithOrgs] = useState(false);
  const [error, setError] = useState<{ message: string; field?: DeleteAccountField } | null>(null);
  const [pending, start] = useTransition();
  const blocked = plan.blocked.length > 0;
  const sole = plan.soleOrgs.map((o) => o.name);
  const ready =
    values.email.trim().toLowerCase() === email && !!values.password && (!twoFactor || !!values.code.trim()) && (!sole.length || withOrgs);

  const field = (key: DeleteAccountField, label: React.ReactNode, props: React.ComponentProps<typeof Input>, hint?: string) => {
    const id = `delete-${key}`;
    const invalid = error?.field === key;
    return (
      <div className="grid gap-1.5">
        <Label htmlFor={id} className="text-[13px] font-normal text-muted-foreground">{label}</Label>
        <Input
          id={id}
          value={values[key]}
          onChange={(e) => {
            setValues((v) => ({ ...v, [key]: e.target.value }));
            if (error) setError(null);
          }}
          aria-invalid={invalid}
          aria-describedby={invalid ? "delete-error" : hint ? `${id}-hint` : undefined}
          {...props}
        />
        {hint && !invalid && <p id={`${id}-hint`} className="text-[12px] text-faint">{hint}</p>}
      </div>
    );
  };

  return (
    <>
      <div className="max-w-2xl rounded-[10px] border border-destructive/30">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-medium">Delete account</div>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">
              {blocked
                ? `You're the only admin of ${list(plan.blocked.map((o) => o.name))}, which still ${plan.blocked.length === 1 ? "has" : "have"} other members. Promote someone else to admin there (or delete the organisation) first.`
                : `Permanently deletes your account and signs you out everywhere. Tasks and comments you wrote stay and show as "Deleted user".${sole.length ? ` ${list(sole)} ${sole.length === 1 ? "has" : "have"} no other members and will be deleted too.` : ""}`}
            </p>
          </div>
          <Button
            variant="destructive"
            disabled={blocked}
            onClick={() => {
              setValues(EMPTY);
              setWithOrgs(false);
              setError(null);
              setOpen(true);
            }}
          >
            <Trash2Icon /> Delete account
          </Button>
        </div>
      </div>

      <AlertDialog open={open} onOpenChange={(v) => !pending && setOpen(v)}>
        <AlertDialogContent>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!ready || pending) return;
              start(async () => {
                const r = await deleteMyAccount({ ...values, deleteSoleOrgs: withOrgs }).catch(() => null);
                if (!r) return setError({ message: "Couldn't reach the server. Try again." });
                if (!r.ok) return setError({ message: r.error, field: r.field });
                // Every session is gone, this one included.
                router.replace("/login?deleted=1");
              });
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>Delete your account?</AlertDialogTitle>
              <AlertDialogDescription>
                This can&rsquo;t be undone. You&rsquo;ll leave every organisation, your open tasks become unassigned, and your
                picture and notifications are deleted. Tasks, comments and activity you wrote stay and show as &ldquo;Deleted user&rdquo;.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {field(
              "email",
              <>
                Type <span className="font-medium text-foreground">{email}</span> to confirm
              </>,
              { autoComplete: "off", spellCheck: false, autoFocus: true, maxLength: 254 },
            )}
            {field("password", "Current password", { type: "password", autoComplete: "current-password", maxLength: 200 })}
            {twoFactor &&
              field(
                "code",
                "Authentication code",
                { autoComplete: "one-time-code", maxLength: 64, spellCheck: false },
                "A 6-digit code from your authenticator app, or a recovery code.",
              )}
            {sole.length > 0 && (
              <label className="flex items-start gap-2.5 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-[12.5px]">
                <input
                  type="checkbox"
                  checked={withOrgs}
                  onChange={(e) => {
                    setWithOrgs(e.target.checked);
                    if (error) setError(null);
                  }}
                  className="mt-0.5 size-3.5 accent-[var(--destructive)]"
                />
                <span>
                  Also delete <span className="font-medium">{list(sole)}</span>, where I&rsquo;m the only member, with all
                  {sole.length === 1 ? " its" : " their"} projects, tasks and bots.
                </span>
              </label>
            )}
            {error && (
              <p id="delete-error" role="alert" className="text-[12.5px] text-destructive">
                {error.message}
              </p>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel type="button" disabled={pending}>
                Keep account
              </AlertDialogCancel>
              {/* A plain submit button: AlertDialogAction would close the dialog before a refusal could show. */}
              <Button type="submit" variant="destructive" disabled={pending || !ready}>
                {pending ? "Deleting…" : "Delete account"}
              </Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
