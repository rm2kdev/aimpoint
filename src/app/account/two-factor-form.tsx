"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckIcon, CopyIcon, DownloadIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  beginTwoFactorSetup,
  confirmTwoFactorSetup,
  regenerateTwoFactorRecoveryCodes,
  turnOffTwoFactor,
} from "@/app/actions/account";

type Stage =
  | { kind: "idle" }
  | { kind: "password" }
  | { kind: "scan"; secret: string; qrSvg: string }
  | { kind: "codes"; codes: string[]; fresh: boolean }
  | { kind: "regenerate" }
  | { kind: "disable" };

/** Two-factor authentication: status, setup (password -> QR -> confirm code -> recovery codes), regenerate, turn off. */
export function TwoFactorForm({
  enabled,
  enabledLabel,
  recoveryCodesLeft,
  total,
}: {
  enabled: boolean;
  enabledLabel: string | null;
  recoveryCodesLeft: number;
  total: number;
}) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const reset = () => {
    setError(null);
    setStage({ kind: "idle" });
  };
  const run = <T,>(fn: () => Promise<{ ok: true; data?: T } | { ok: false; error: string }>, done: (data: T) => void) =>
    start(async () => {
      const r = await fn().catch(() => null);
      if (!r) return setError("Couldn't reach the server. Try again.");
      if (!r.ok) return setError(r.error);
      setError(null);
      done(r.data as T);
    });

  if (stage.kind === "codes") {
    return (
      <RecoveryCodes
        codes={stage.codes}
        fresh={stage.fresh}
        onDone={() => {
          reset();
          router.refresh();
        }}
      />
    );
  }

  return (
    <div className="grid max-w-md gap-4">
      <div className="flex items-center gap-2.5">
        <StatusPill on={enabled} />
        <p className="text-[13px] text-muted-foreground">
          {enabled
            ? `Turned on ${enabledLabel}. ${recoveryCodesLeft} of ${total} recovery codes left.`
            : "Signing in needs only your password."}
        </p>
      </div>
      {enabled && recoveryCodesLeft <= 2 && stage.kind === "idle" && (
        <p className="text-[12.5px] text-destructive">
          {recoveryCodesLeft === 0 ? "You have no recovery codes left." : "You're running low on recovery codes."} Regenerate them so you
          can still sign in if you lose your phone.
        </p>
      )}

      {stage.kind === "idle" &&
        (enabled ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setStage({ kind: "regenerate" })}>
              Regenerate recovery codes
            </Button>
            <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setStage({ kind: "disable" })}>
              Turn off
            </Button>
          </div>
        ) : (
          <div>
            <Button variant="outline" onClick={() => setStage({ kind: "password" })}>
              Set up two-factor authentication
            </Button>
          </div>
        ))}

      {stage.kind === "password" && (
        <PasswordStep
          pending={pending}
          error={error}
          onCancel={reset}
          onSubmit={(password) => run(() => beginTwoFactorSetup(password), (d) => setStage({ kind: "scan", secret: d.secret, qrSvg: d.qrSvg }))}
        />
      )}

      {stage.kind === "scan" && (
        <ScanStep
          secret={stage.secret}
          qrSvg={stage.qrSvg}
          pending={pending}
          error={error}
          onCancel={reset}
          onSubmit={(code) =>
            run(
              () => confirmTwoFactorSetup(code),
              (d) => {
                toast.success("Two-factor authentication is on. Your other sessions were signed out.");
                setStage({ kind: "codes", codes: d.recoveryCodes, fresh: true });
              },
            )
          }
        />
      )}

      {stage.kind === "regenerate" && (
        <RegenerateStep
          pending={pending}
          error={error}
          onCancel={reset}
          onSubmit={(v) =>
            run(
              () => regenerateTwoFactorRecoveryCodes(v),
              (d) => {
                toast.success("New recovery codes created. The old ones no longer work.");
                setStage({ kind: "codes", codes: d.recoveryCodes, fresh: false });
              },
            )
          }
        />
      )}

      {stage.kind === "disable" && (
        <DisableStep
          pending={pending}
          error={error}
          onCancel={reset}
          onSubmit={(v) =>
            run(
              () => turnOffTwoFactor(v),
              () => {
                toast.success("Two-factor authentication is off.");
                reset();
                router.refresh();
              },
            )
          }
        />
      )}
    </div>
  );
}

function StatusPill({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border px-2 text-[12px] font-medium",
        on ? "border-transparent bg-foreground text-background" : "border-border text-muted-foreground",
      )}
    >
      <span className={cn("size-1.5 rounded-full", on ? "bg-background" : "bg-faint")} aria-hidden />
      {on ? "On" : "Off"}
    </span>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-[12.5px] text-destructive">
      {error}
    </p>
  );
}

function Actions({ pending, label, pendingLabel, onCancel, disabled }: { pending: boolean; label: string; pendingLabel: string; onCancel: () => void; disabled?: boolean }) {
  return (
    <div className="flex gap-2">
      <Button type="submit" variant="outline" disabled={pending || disabled}>
        {pending ? pendingLabel : label}
      </Button>
      <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
        Cancel
      </Button>
    </div>
  );
}

function PasswordStep({ pending, error, onCancel, onSubmit }: { pending: boolean; error: string | null; onCancel: () => void; onSubmit: (p: string) => void }) {
  const [password, setPassword] = useState("");
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(password);
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="tfa-password" className="text-[13px]">Current password</Label>
        <Input id="tfa-password" type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={!!error} />
      </div>
      <ErrorLine error={error} />
      <Actions pending={pending} label="Continue" pendingLabel="Checking…" onCancel={onCancel} disabled={!password} />
    </form>
  );
}

function ScanStep({
  secret,
  qrSvg,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  secret: string;
  qrSvg: string;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (code: string) => void;
}) {
  const [code, setCode] = useState("");
  const grouped = secret.match(/.{1,4}/g)?.join(" ") ?? secret;
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(code);
      }}
    >
      <ol className="grid gap-1 text-[13px] text-muted-foreground">
        <li>1. Scan this QR code with an authenticator app (1Password, Google Authenticator, Authy…).</li>
        <li>2. Enter the 6-digit code it shows to finish.</li>
      </ol>
      <div className="flex flex-wrap items-start gap-4">
        <div
          className="size-[168px] shrink-0 rounded-lg border border-border bg-white p-2 [&>svg]:size-full"
          role="img"
          aria-label="QR code for your authenticator app"
          dangerouslySetInnerHTML={{ __html: qrSvg }}
        />
        <div className="grid min-w-0 flex-1 gap-1.5">
          <span className="text-[12px] text-faint">Can&rsquo;t scan it? Enter this key instead:</span>
          <code className="rounded-md border border-border bg-sidebar px-2 py-1.5 font-mono text-[12.5px] leading-relaxed break-words select-all">
            {grouped}
          </code>
          <CopyButton text={secret} label="Copy key" />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="tfa-code" className="text-[13px]">Code from the app</Label>
        <Input
          id="tfa-code"
          autoFocus
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="123456"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          className="w-40 font-mono tracking-[0.12em]"
          aria-invalid={!!error}
        />
      </div>
      <ErrorLine error={error} />
      <Actions pending={pending} label="Turn on" pendingLabel="Verifying…" onCancel={onCancel} disabled={code.length !== 6} />
    </form>
  );
}

function RegenerateStep({
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (v: { password?: string; code?: string }) => void;
}) {
  const [useCode, setUseCode] = useState(false);
  const [value, setValue] = useState("");
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(useCode ? { code: value } : { password: value });
      }}
    >
      <p className="text-[13px] text-muted-foreground">Your current recovery codes stop working as soon as new ones are created.</p>
      <div className="grid gap-1.5">
        <Label htmlFor="tfa-regen" className="text-[13px]">{useCode ? "Code from your authenticator app" : "Current password"}</Label>
        <Input
          key={useCode ? "code" : "password"}
          id="tfa-regen"
          autoFocus
          type={useCode ? "text" : "password"}
          inputMode={useCode ? "numeric" : undefined}
          autoComplete={useCode ? "one-time-code" : "current-password"}
          maxLength={useCode ? 6 : 200}
          value={value}
          onChange={(e) => setValue(useCode ? e.target.value.replace(/\D/g, "") : e.target.value)}
          className={cn(useCode && "w-40 font-mono tracking-[0.12em]")}
          aria-invalid={!!error}
        />
        <button
          type="button"
          className="w-fit text-[12px] text-muted-foreground underline underline-offset-4 hover:text-foreground"
          onClick={() => {
            setUseCode((u) => !u);
            setValue("");
          }}
        >
          {useCode ? "Use your password instead" : "Use an authenticator code instead"}
        </button>
      </div>
      <ErrorLine error={error} />
      <Actions pending={pending} label="Create new codes" pendingLabel="Creating…" onCancel={onCancel} disabled={useCode ? value.length !== 6 : !value} />
    </form>
  );
}

function DisableStep({
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (v: { password: string; code: string }) => void;
}) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ password, code });
      }}
    >
      <p className="text-[13px] text-muted-foreground">Signing in will need only your password again.</p>
      <div className="grid gap-1.5">
        <Label htmlFor="tfa-off-password" className="text-[13px]">Current password</Label>
        <Input id="tfa-off-password" type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="tfa-off-code" className="text-[13px]">Authenticator code or recovery code</Label>
        <Input id="tfa-off-code" autoComplete="one-time-code" maxLength={11} spellCheck={false} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} className="w-48 font-mono tracking-[0.08em]" />
      </div>
      <ErrorLine error={error} />
      <Actions pending={pending} label="Turn off two-factor" pendingLabel="Turning off…" onCancel={onCancel} disabled={!password || !code.trim()} />
    </form>
  );
}

function RecoveryCodes({ codes, fresh, onDone }: { codes: string[]; fresh: boolean; onDone: () => void }) {
  const text = codes.join("\n");
  return (
    <div className="grid max-w-md gap-4">
      <div className="grid gap-1">
        <p className="text-[13.5px] font-medium">{fresh ? "Two-factor authentication is on. Save your recovery codes." : "Your new recovery codes"}</p>
        <p className="text-[13px] text-muted-foreground">
          Each code signs you in once if you lose access to your authenticator app. They won&rsquo;t be shown again, so keep them somewhere safe.
        </p>
      </div>
      <ul className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-lg border border-border bg-sidebar px-4 py-3 font-mono text-[13px]" aria-label="Recovery codes">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <CopyButton text={text} label="Copy codes" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            const url = URL.createObjectURL(new Blob([`Vector recovery codes\n\n${text}\n`], { type: "text/plain" }));
            const a = Object.assign(document.createElement("a"), { href: url, download: "vector-recovery-codes.txt" });
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          <DownloadIcon /> Download
        </Button>
      </div>
      <div>
        <Button variant="outline" onClick={onDone}>
          I&rsquo;ve saved them
        </Button>
      </div>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="w-fit"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => toast.error("Couldn't copy. Select the text and copy it instead."),
        );
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />} {copied ? "Copied" : label}
    </Button>
  );
}
