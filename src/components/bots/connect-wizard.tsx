"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowUpRightIcon,
  AsteriskIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CopyIcon,
  FeatherIcon,
  HexagonIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  PlugIcon,
  ZapIcon,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useOrg } from "@/components/org-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { checkBotKey, disconnectBot, getBotPulse, rerollBotKey, saveBotConnection, testBotConnection } from "@/app/actions/bots";
import { BACKENDS, backendFor, type Backend } from "@/lib/bot-connect";
import { timeAgo } from "@/lib/format";
import type { Bot, BotAgent, BotMethod } from "@/lib/types";

/* ---------------- small parts ---------------- */

const AGENT_ICON: Record<BotAgent, typeof FeatherIcon> = { claude: AsteriskIcon, openai: HexagonIcon, hermes: FeatherIcon, other: PlugIcon };

export function AgentMark({ agent, size = 32 }: { agent: BotAgent; size?: number }) {
  const Icon = AGENT_ICON[agent];
  return (
    <span className="grid shrink-0 place-items-center rounded-[9px] border border-border bg-sidebar text-foreground" style={{ width: size, height: size }} aria-hidden>
      <Icon style={{ width: size * 0.5, height: size * 0.5 }} strokeWidth={1.75} />
    </span>
  );
}

export function CopyBlock({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={cn("relative max-w-full", className)}>
      <pre className="max-w-full overflow-x-auto rounded-[10px] border border-border bg-sidebar px-3.5 py-2.5 pr-12 font-mono text-[12px] leading-relaxed whitespace-pre text-foreground">{text}</pre>
      <Button
        size="icon-sm"
        variant="ghost"
        className="absolute top-1.5 right-1.5 bg-sidebar text-muted-foreground"
        aria-label={copied ? "Copied" : "Copy"}
        onClick={() => {
          navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
}

function randomSecret(prefix: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return prefix + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const isPublicHttps = (origin: string) => {
  try {
    const u = new URL(origin);
    return u.protocol === "https:" && !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname);
  } catch {
    return false;
  }
};

function useOrigin() {
  const [origin, setOrigin] = useState("https://your-vector-host");
  useEffect(() => setOrigin(window.location.origin), []);
  return origin;
}

/* ---------------- the Connection row ---------------- */

type Step = "backend" | "settings" | "test";
const STEPS: { id: Step; label: string }[] = [
  { id: "backend", label: "Backend" },
  { id: "settings", label: "Settings" },
  { id: "test", label: "Test" },
];

/**
 * The bot's backend: a summary when one is set, otherwise (or on edit) the setup flow.
 * `apiKey` is the bot's Vector key when this page has it in hand (just created or rerolled).
 */
export function BotConnection({ bot, setBot, apiKey, setApiKey }: { bot: Bot; setBot: (b: Bot) => void; apiKey: string | null; setApiKey: (k: string) => void }) {
  const { isAdmin } = useOrg();
  const [open, setOpen] = useState<null | { step: Step; method?: BotMethod }>(() =>
    // New bots go straight into setup.
    bot.connection || bot.lastUsedAt || !isAdmin ? null : { step: "backend" },
  );

  if (open && isAdmin) {
    return <Setup key={`${open.step}-${open.method}`} bot={bot} setBot={setBot} apiKey={apiKey} setApiKey={setApiKey} initial={open} onClose={() => setOpen(null)} />;
  }
  if (!bot.connection) {
    return (
      <div className="max-w-[640px] rounded-[10px] border border-dashed border-input px-4 py-3.5">
        <p className="text-[13px] text-muted-foreground">
          {bot.lastUsedAt
            ? `No backend is set, so Vector can't start ${bot.name} when work arrives. It has called Vector over MCP or the API itself (last ${timeAgo(bot.lastUsedAt)}).`
            : `No backend yet. Pick Claude, OpenAI or Hermes to run ${bot.name}.`}
        </p>
        {isAdmin ? (
          <Button size="sm" className="mt-3" onClick={() => setOpen({ step: "backend" })}>
            Choose a backend
          </Button>
        ) : (
          <p className="mt-1 text-[12.5px] text-faint">Ask an admin to set one.</p>
        )}
      </div>
    );
  }
  return <Summary bot={bot} setBot={setBot} onEdit={() => setOpen({ step: "settings", method: bot.connection!.method })} onChange={() => setOpen({ step: "backend" })} />;
}

/* ---------------- summary ---------------- */

function Summary({ bot, setBot, onEdit, onChange }: { bot: Bot; setBot: (b: Bot) => void; onEdit: () => void; onChange: () => void }) {
  const { org, isAdmin } = useOrg();
  const router = useRouter();
  const conn = bot.connection!;
  const b = backendFor(conn.method);
  const [pending, start] = useTransition();
  const last = conn.lastDelivery;

  const rows: [string, React.ReactNode][] = [];
  if (conn.url) rows.push([b.url?.label ?? "URL", <span key="u" className="font-mono text-[12px]">{conn.url}</span>]);
  if (conn.model) rows.push(["Model", <span key="m" className="font-mono text-[12px]">{conn.model}</span>]);
  if (conn.secretHint && b.secret) rows.push([b.secret.label, <span key="s" className="font-mono text-[12px]">{conn.secretHint}</span>]);
  if (b.push)
    rows.push([
      "Last run",
      last ? (
        <span key="l" className={cn("inline-flex items-center gap-1.5", !last.ok && "text-destructive")}>
          {last.ok ? <CircleCheckIcon className="size-3.5 text-[#30a46c]" /> : <CircleAlertIcon className="size-3.5" />}
          {last.ok ? "Sent" : "Failed"} · {last.reason} · {timeAgo(last.at)}
        </span>
      ) : (
        <span key="l" className="text-muted-foreground">
          Not yet. It runs when {bot.name} is assigned a task or mentioned.
        </span>
      ),
    ]);
  rows.push(["Last call to Vector", <span key="c" className="text-muted-foreground">{bot.lastUsedAt ? timeAgo(bot.lastUsedAt) : "Never"}</span>]);

  return (
    <div className="max-w-[640px] rounded-[10px] border border-border">
      <div className="flex items-center gap-3 px-4 py-3.5">
        <AgentMark agent={conn.agent} size={36} />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="text-[14px] font-medium">{b.title}</div>
          <div className="mt-1 text-[12.5px] text-muted-foreground">{b.push ? `Vector starts ${bot.name} when work arrives` : `${bot.name} checks Vector on its own schedule`}</div>
        </div>
      </div>
      <dl className="grid grid-cols-[148px_minmax(0,1fr)] gap-x-4 gap-y-2 border-t border-border px-4 py-3.5 text-[13px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-faint">{k}</dt>
            <dd className="min-w-0 truncate">{v}</dd>
          </div>
        ))}
      </dl>
      {last && !last.ok && last.error && <p className="mx-4 mb-3.5 rounded-lg bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">{last.error}</p>}
      {isAdmin && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
          {b.push && (
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await testBotConnection(org.slug, bot.id);
                  if (!r.ok) return void toast.error(r.error);
                  setBot(r.data!);
                  const d = r.data!.connection?.lastDelivery;
                  if (d?.ok) toast.success(`Test sent to ${b.title}`);
                  else toast.error(d?.error ?? "The test didn't go through.");
                })
              }
            >
              {pending ? <LoaderCircleIcon className="animate-spin" /> : <ZapIcon />} Send a test
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={onEdit}>
            Edit settings
          </Button>
          <Button size="sm" variant="ghost" onClick={onChange}>
            Change backend
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-muted-foreground hover:text-destructive"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await disconnectBot(org.slug, bot.id);
                if (!r.ok) return void toast.error(r.error);
                setBot({ ...bot, connection: null });
                toast.success(`Removed ${bot.name}'s backend`);
                router.refresh();
              })
            }
          >
            Remove
          </Button>
        </div>
      )}
    </div>
  );
}

/* ---------------- setup flow ---------------- */

function Stepper({ step }: { step: Step }) {
  const at = STEPS.findIndex((s) => s.id === step);
  return (
    <ol className="flex items-center gap-1.5 text-[12.5px]" aria-label="Setup progress">
      {STEPS.map((s, i) => (
        <li key={s.id} className="flex items-center gap-1.5" aria-current={i === at ? "step" : undefined}>
          <span
            className={cn(
              "tabular grid size-[18px] place-items-center rounded-full font-mono text-[11px]",
              i < at ? "bg-foreground text-background" : i === at ? "border border-foreground text-foreground" : "border border-input text-faint",
            )}
          >
            {i < at ? <CheckIcon className="size-2.5" strokeWidth={3} /> : i + 1}
          </span>
          <span className={cn("whitespace-nowrap", i === at ? "font-medium text-foreground" : i < at ? "text-muted-foreground" : "text-faint")}>{s.label}</span>
          {i < STEPS.length - 1 && <span className="mx-0.5 h-px w-3 bg-input sm:mx-1 sm:w-6" aria-hidden />}
        </li>
      ))}
    </ol>
  );
}

function Choice({ onClick, children, compact }: { onClick: () => void; children: React.ReactNode; compact?: boolean }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "group flex w-full items-center gap-3 rounded-[10px] border border-border px-3.5 text-left transition-colors hover:border-input hover:bg-accent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
          compact ? "py-2.5" : "py-3",
        )}
      >
        {children}
        <ChevronRightIcon className="size-4 shrink-0 text-faint transition-transform group-hover:translate-x-0.5" />
      </button>
    </li>
  );
}

function Footer({ onBack, backLabel = "Back", children }: { onBack?: () => void; backLabel?: string; children?: React.ReactNode }) {
  return (
    <div className="mt-6 flex items-center gap-2 border-t border-border pt-4">
      {onBack && (
        <Button variant="ghost" onClick={onBack} className="-ml-2.5">
          {backLabel === "Back" && <ChevronLeftIcon />} {backLabel}
        </Button>
      )}
      <div className="ml-auto flex items-center gap-2">{children}</div>
    </div>
  );
}

function Setup({
  bot,
  setBot,
  apiKey,
  setApiKey,
  initial,
  onClose,
}: {
  bot: Bot;
  setBot: (b: Bot) => void;
  apiKey: string | null;
  setApiKey: (k: string) => void;
  initial: { step: Step; method?: BotMethod };
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>(initial.step);
  const [method, setMethod] = useState<BotMethod | undefined>(initial.method);
  const main = BACKENDS.filter((b) => !b.advanced);
  const advanced = BACKENDS.filter((b) => b.advanced);

  return (
    <div className="max-w-[720px]">
      <div className="flex items-center justify-between gap-3">
        <Stepper step={step} />
        {bot.connection && step !== "test" && (
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        )}
      </div>

      <div className="mt-5">
        {step === "backend" && (
          <section aria-labelledby="bk-title">
            <h3 id="bk-title" className="text-[15px] font-semibold tracking-[-0.01em]">
              Which backend runs {bot.name}?
            </h3>
            <p className="mt-1 max-w-[68ch] text-[13px] text-muted-foreground">
              When {bot.name} is assigned a task or mentioned, Vector sends the task and its thread to this backend. The agent works on the ticket through Vector&rsquo;s tools.
            </p>
            <ul className="mt-4 grid gap-1.5">
              {main.map((b) => (
                <Choice
                  key={b.method}
                  onClick={() => {
                    setMethod(b.method);
                    setStep("settings");
                  }}
                >
                  <AgentMark agent={b.agent} />
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className="flex items-center gap-2 text-[13.5px] font-medium">
                      {b.title}
                      {bot.connection?.method === b.method && <span className="text-[12px] font-normal text-faint">Current</span>}
                    </span>
                    <span className="mt-0.5 block text-[12.5px] text-muted-foreground">{b.summary}</span>
                  </span>
                </Choice>
              ))}
            </ul>
            <h4 className="mt-6 text-[12.5px] font-semibold text-muted-foreground">Your own agent</h4>
            <ul className="mt-2 grid gap-1.5">
              {advanced.map((b) => (
                <Choice
                  key={b.method}
                  compact
                  onClick={() => {
                    setMethod(b.method);
                    setStep("settings");
                  }}
                >
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className="flex items-center gap-2 text-[13px] font-medium">
                      {b.title}
                      {bot.connection?.method === b.method && <span className="text-[12px] font-normal text-faint">Current</span>}
                    </span>
                    <span className="mt-0.5 block text-[12.5px] text-muted-foreground">{b.summary}</span>
                  </span>
                </Choice>
              ))}
            </ul>
          </section>
        )}

        {step === "settings" && method && (
          <Settings
            bot={bot}
            setBot={setBot}
            backend={backendFor(method)}
            apiKey={apiKey}
            setApiKey={setApiKey}
            onBack={() => (initial.step === "settings" ? onClose() : setStep("backend"))}
            backLabel={initial.step === "settings" ? "Cancel" : "Back"}
            onSaved={() => setStep("test")}
          />
        )}

        {step === "test" && method && <Test bot={bot} setBot={setBot} backend={backendFor(method)} onDone={onClose} />}
      </div>
    </div>
  );
}

/* ---------------- step 2: settings ---------------- */

function Settings({
  bot,
  setBot,
  backend: b,
  apiKey,
  setApiKey,
  onBack,
  backLabel,
  onSaved,
}: {
  bot: Bot;
  setBot: (b: Bot) => void;
  backend: Backend;
  apiKey: string | null;
  setApiKey: (k: string) => void;
  onBack: () => void;
  backLabel: string;
  onSaved: () => void;
}) {
  const { org } = useOrg();
  const router = useRouter();
  const origin = useOrigin();
  const prev = bot.connection?.method === b.method ? bot.connection : null;

  const [url, setUrl] = useState(prev?.url ?? "");
  const [model, setModel] = useState(prev?.model ?? b.model?.default ?? "");
  const [secret, setSecret] = useState("");
  const [generated, setGenerated] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();

  const mcpUrl = `${origin}/api/mcp`;
  const offline = b.needsVectorKey && !isPublicHttps(origin);
  // Claude and OpenAI get a key of their own for calling back into Vector. Without one in hand, saving issues a new key.
  const rotates = Boolean(b.needsVectorKey && !apiKey && !prev);
  const canSave = (!b.url || url.trim()) && (!b.model || model.trim()) && (!b.secret || secret.trim() || prev?.secretHint);

  const save = () =>
    start(async () => {
      setError(undefined);
      const r = await saveBotConnection(org.slug, bot.id, {
        agent: b.agent,
        method: b.method,
        url,
        model,
        secret: secret.trim() || undefined,
        vectorKey: b.needsVectorKey ? (apiKey ?? undefined) : undefined,
        rotateKey: rotates,
        vectorUrl: origin,
      });
      if (!r.ok) return setError(r.error);
      setBot(r.data!.bot);
      if (r.data!.key) setApiKey(r.data!.key);
      router.refresh();
      onSaved();
    });

  return (
    <section aria-labelledby="st-title">
      <div className="flex items-center gap-3">
        <AgentMark agent={b.agent} />
        <h3 id="st-title" className="text-[15px] font-semibold tracking-[-0.01em]">
          {b.title} settings
        </h3>
      </div>

      <p className="mt-4 max-w-[68ch] text-[13px] text-muted-foreground">
        {b.requires}
        {b.keyHelp && (
          <>
            {" "}
            <a href={b.keyHelp.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-foreground underline underline-offset-2">
              {b.keyHelp.label}
              <ArrowUpRightIcon className="size-3" />
            </a>
          </>
        )}
      </p>

      {offline && (
        <p className="mt-3 flex max-w-xl gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
          <CircleAlertIcon className="mt-px size-3.5 shrink-0" />
          You&rsquo;re on {origin}, which {b.title} can&rsquo;t reach. Saving works once Vector is on a public https:// address.
        </p>
      )}

      <div className="mt-5 grid max-w-xl gap-4">
        {b.url && (
          <div className="grid gap-1.5">
            <Label htmlFor="st-url">{b.url.label}</Label>
            <Input id="st-url" className="font-mono text-[13px]" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={b.url.placeholder} spellCheck={false} inputMode="url" />
            {b.url.help && <p className="text-[12px] text-faint">{b.url.help}</p>}
          </div>
        )}
        {b.secret && (
          <div className="grid gap-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <Label htmlFor="st-secret">{b.secret.label}</Label>
              {b.secret.canGenerate && !generated && (
                <button
                  type="button"
                  className="text-[12.5px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
                  onClick={() => {
                    const s = randomSecret(b.secret!.canGenerate!.prefix);
                    setGenerated(s);
                    setSecret(s);
                  }}
                >
                  Make one for me
                </button>
              )}
            </div>
            <Input
              id="st-secret"
              type={generated && secret === generated ? "text" : "password"}
              autoComplete="off"
              className="font-mono text-[13px]"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={prev?.secretHint ? `Saved, ends ${prev.secretHint}. Leave empty to keep it.` : b.secret.placeholder}
            />
            {generated && secret === generated && (
              <p className="text-[12px] text-faint">
                {b.method === "hermes-api" ? "Put this in Hermes's .env as API_SERVER_KEY and restart the gateway:" : "Use this secret to check X-Vector-Signature:"}
              </p>
            )}
            {generated && secret === generated && b.method === "hermes-api" && <CopyBlock text={`API_SERVER_ENABLED=true\nAPI_SERVER_KEY=${generated}`} />}
          </div>
        )}
        {b.model && (
          <div className="grid gap-1.5">
            <Label htmlFor="st-model">{b.model.label}</Label>
            <Input id="st-model" className="font-mono text-[13px]" value={model} onChange={(e) => setModel(e.target.value)} placeholder={b.model.placeholder} spellCheck={false} />
            {b.model.help && <p className="text-[12px] text-faint">{b.model.help}</p>}
          </div>
        )}
      </div>

      {(b.method === "hermes-api" || b.method === "webhook" || b.method === "mcp") && (
        <div className="mt-6 max-w-xl rounded-[10px] border border-border bg-sidebar px-4 py-3.5">
          <p className="text-[13px] font-medium">{b.method === "hermes-api" ? "Vector's MCP server, for Hermes" : "Vector's MCP server"}</p>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            {b.method === "hermes-api"
              ? `Hermes acts on tickets through this server. Install it in Hermes under the name “vector”, with ${bot.name}'s key as a Bearer token.`
              : `Your agent acts on tickets through this server (or the REST API at ${origin}/api/v1) with ${bot.name}'s key as a Bearer token.`}
          </p>
          <div className="mt-3 grid gap-2">
            <CopyField label="URL" value={mcpUrl} />
            <KeyField bot={bot} setBot={setBot} apiKey={apiKey} setApiKey={setApiKey} />
          </div>
        </div>
      )}

      {rotates && bot.lastUsedAt && (
        <p className="mt-4 max-w-xl text-[12.5px] text-muted-foreground">
          Saving gives {bot.name} a new key for {b.title} to call Vector with. Anything else using {bot.keyHint} stops working.
        </p>
      )}

      <p role="alert" aria-live="polite" className={cn("max-w-xl text-[13px] text-destructive", error && "mt-4 flex gap-2 rounded-lg bg-destructive/10 px-3 py-2")}>
        {error && <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />}
        {error}
      </p>
      <Footer onBack={onBack} backLabel={backLabel}>
        <Button onClick={save} disabled={pending || !canSave}>
          {pending && <LoaderCircleIcon className="animate-spin" />}
          {pending ? (b.push ? `Checking ${b.title}…` : "Saving…") : b.push ? "Save and test" : "Save"}
        </Button>
      </Footer>
    </section>
  );
}

function CopyField({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 shrink-0 text-[12px] text-faint">{label}</span>
      <code className={cn("min-w-0 flex-1 truncate rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[12.5px]", secret && "select-all")}>{value}</code>
      <Button
        size="icon-sm"
        variant="outline"
        aria-label={`Copy ${label}`}
        onClick={() => {
          navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
}

/** The bot's Vector key: copyable when this page has it, otherwise paste it back or make a new one. */
function KeyField({ bot, setBot, apiKey, setApiKey }: { bot: Bot; setBot: (b: Bot) => void; apiKey: string | null; setApiKey: (k: string) => void }) {
  const { org } = useOrg();
  const [paste, setPaste] = useState("");
  const [confirmNew, setConfirmNew] = useState(false);
  const [err, setErr] = useState<string>();
  const [pending, start] = useTransition();

  if (apiKey) {
    return (
      <>
        <CopyField label="Key" value={apiKey} secret />
        <p className="pl-12 text-[12px] text-faint">Shown while you&rsquo;re on this page. Vector only stores a hash.</p>
      </>
    );
  }

  const makeNew = () =>
    start(async () => {
      const r = await rerollBotKey(org.slug, bot.id);
      if (!r.ok) return setErr(r.error);
      setBot({ ...r.data!.bot, connection: bot.connection });
      setApiKey(r.data!.key);
    });

  return (
    <div className="grid gap-1.5">
      <div className="flex items-center gap-2">
        <span className="w-10 shrink-0 text-[12px] text-faint">Key</span>
        <form
          className="flex min-w-0 flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              setErr(undefined);
              const r = await checkBotKey(org.slug, bot.id, paste);
              if (!r.ok) return setErr(r.error);
              if (!r.data) return setErr(`That isn't ${bot.name}'s current key.`);
              setApiKey(paste.trim());
            });
          }}
        >
          <Input value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={`${bot.keyHint} (paste to show it here)`} type="password" autoComplete="off" className="h-8 bg-background font-mono text-[12.5px]" aria-label="Bot key" />
          <Button type="submit" size="sm" variant="outline" className="h-8" disabled={pending || !paste.trim()}>
            Use
          </Button>
        </form>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-12 text-[12px]">
        <KeyRoundIcon className="size-3 text-faint" />
        {confirmNew ? (
          <>
            <span className="text-muted-foreground">Anything using {bot.keyHint} stops working.</span>
            <Button size="xs" variant="outline" disabled={pending} onClick={makeNew}>
              Make a new key
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setConfirmNew(false)}>
              Keep it
            </Button>
          </>
        ) : (
          <button type="button" className="text-muted-foreground underline underline-offset-2 hover:text-foreground" disabled={pending} onClick={() => (bot.lastUsedAt ? setConfirmNew(true) : makeNew())}>
            Don&rsquo;t have it? Make a new key
          </button>
        )}
      </div>
      {err && (
        <p role="alert" className="pl-12 text-[12px] text-destructive">
          {err}
        </p>
      )}
    </div>
  );
}

/* ---------------- step 3: test ---------------- */

function Test({ bot, setBot, backend: b, onDone }: { bot: Bot; setBot: (b: Bot) => void; backend: Backend; onDone: () => void }) {
  const { org } = useOrg();
  const router = useRouter();
  const [since] = useState(() => Date.now());
  const [checkedIn, setCheckedIn] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<NonNullable<Bot["connection"]>["lastDelivery"]>(null);
  const [pending, start] = useTransition();

  // Watch for the bot's first call into Vector after this step opened.
  useEffect(() => {
    if (checkedIn) return;
    const t = setInterval(async () => {
      const r = await getBotPulse(org.slug, bot.id);
      if (r.ok && r.data?.lastUsedAt && Date.parse(r.data.lastUsedAt) >= since - 1000) {
        setCheckedIn(r.data.lastUsedAt);
        setBot({ ...bot, lastUsedAt: r.data.lastUsedAt, connection: r.data.connection });
        router.refresh();
      }
    }, 3000);
    return () => clearInterval(t);
  }, [checkedIn, org.slug, bot, setBot, since, router]);

  const sendTest = () =>
    start(async () => {
      const r = await testBotConnection(org.slug, bot.id);
      if (!r.ok) return void toast.error(r.error);
      setBot(r.data!);
      setDelivery(r.data!.connection?.lastDelivery ?? null);
    });

  const slow = b.method === "claude-api" || b.method === "openai-api";

  return (
    <section aria-labelledby="ts-title">
      <h3 id="ts-title" className="text-[15px] font-semibold tracking-[-0.01em]">
        Test {bot.name}
      </h3>
      <p className="mt-1 max-w-[68ch] text-[13px] text-muted-foreground">
        {b.push
          ? `Saved. The test asks ${b.title} to read your workspace through Vector's tools without changing anything, which proves both directions work.`
          : `Saved. Point your agent at the MCP server and run it once; this turns green when it calls Vector.`}
      </p>

      <ul className="mt-5 grid max-w-xl gap-1.5">
        {b.push && (
          <li className="flex items-center gap-3 rounded-[10px] border border-border px-3.5 py-3">
            <StatusDot state={pending ? "wait" : delivery ? (delivery.ok ? "ok" : "fail") : "idle"} />
            <div className="min-w-0 flex-1 leading-tight">
              <div className="text-[13.5px] font-medium">Vector reaches {b.title}</div>
              <div className={cn("mt-0.5 text-[12.5px]", delivery && !delivery.ok ? "text-destructive" : "text-muted-foreground")}>
                {pending ? (slow ? `${b.title} is running the test. This can take a minute…` : "Sending…") : delivery ? (delivery.ok ? "Sent" : (delivery.error ?? "Failed")) : "Not sent yet"}
              </div>
            </div>
            <Button size="sm" variant={delivery?.ok ? "outline" : "default"} disabled={pending} onClick={sendTest}>
              <ZapIcon /> {delivery ? "Send again" : "Send a test"}
            </Button>
          </li>
        )}
        <li className="flex items-center gap-3 rounded-[10px] border border-border px-3.5 py-3" aria-live="polite">
          <StatusDot state={checkedIn ? "ok" : b.push && !delivery ? "idle" : "wait"} />
          <div className="min-w-0 flex-1 leading-tight">
            <div className="text-[13.5px] font-medium">{b.push ? `${b.title} uses Vector's tools` : `${bot.name} calls Vector`}</div>
            <div className="mt-0.5 text-[12.5px] text-muted-foreground">{checkedIn ? `Called Vector ${timeAgo(checkedIn)}` : b.push && !delivery ? "After the test is sent" : "Waiting for the first call…"}</div>
          </div>
        </li>
      </ul>
      {b.method === "hermes-api" && delivery?.ok && !checkedIn && (
        <p className="mt-3 max-w-[68ch] text-[12.5px] text-faint">Hermes took the run. If this doesn&rsquo;t turn green within a minute or two, check that Vector&rsquo;s MCP server is installed in Hermes with this bot&rsquo;s key.</p>
      )}

      <Footer>
        <Button variant={checkedIn || delivery?.ok ? "default" : "outline"} onClick={onDone}>
          Done
        </Button>
      </Footer>
    </section>
  );
}

function StatusDot({ state }: { state: "idle" | "wait" | "ok" | "fail" }) {
  if (state === "ok") return <CircleCheckIcon className="size-[18px] shrink-0 text-[#30a46c]" aria-label="Done" />;
  if (state === "fail") return <CircleAlertIcon className="size-[18px] shrink-0 text-destructive" aria-label="Failed" />;
  if (state === "wait") return <LoaderCircleIcon className="size-[18px] shrink-0 animate-spin text-faint motion-reduce:animate-none" aria-label="Waiting" />;
  return <span className="size-[18px] shrink-0 rounded-full border border-dashed border-faint" aria-hidden />;
}
