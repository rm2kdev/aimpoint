/**
 * Email rules (VEC-295), pure so `email-core.test.mjs` runs them under plain `node --test`.
 * Server code sends through `@/lib/email` (`sendEmail`); this module decides the transport from the environment,
 * applies the dev redirect, builds the SES v2 SendEmail request and renders the shared branded layout. No AWS calls.
 *
 * Transports:
 * - `ses`: Amazon SES v2 with the app's own `SES_*` credentials and a configuration set (always passed: IAM can't
 *   force one, and bounce/complaint events only flow through it).
 * - `log`: prints the message to the server log and never calls AWS. The default when SES isn't configured outside
 *   production (plain local dev). In production a missing setup is an error at send time, unless `EMAIL_TRANSPORT=log`
 *   is set on purpose.
 */
import { z } from "zod";

export type EmailTransport = "ses" | "log";

export interface EmailMessage {
  /** One address or several. Plain `a@b.c` or `Name <a@b.c>`. */
  to: string | string[];
  subject: string;
  text: string;
  html: string;
  replyTo?: string | string[];
  /** Short category for SES event tags and logs, e.g. `invite`. Letters, digits, `_` and `-`. */
  tag?: string;
}

export interface SesConfig {
  transport: "ses";
  from: string;
  region: string;
  configurationSet: string;
  accessKeyId: string;
  secretAccessKey: string;
  devRedirect: string | null;
}

export interface LogConfig {
  transport: "log";
  from: string;
  devRedirect: string | null;
  /** Why log was picked, for the log line. */
  reason: string;
}

export type EmailConfig = SesConfig | LogConfig;

export type EmailConfigResult = { ok: true; config: EmailConfig } | { ok: false; error: string };

export const SES_ENV = ["EMAIL_FROM", "SES_REGION", "SES_CONFIGURATION_SET", "SES_ACCESS_KEY_ID", "SES_SECRET_ACCESS_KEY"] as const;

/** Sender used by the log transport when EMAIL_FROM is unset. Never sent anywhere. */
export const LOG_FROM = "Aimpoint <noreply@localhost>";

const ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

/** Accepts `a@b.c` or `Display Name <a@b.c>`; returns the bare address, or null when it isn't one. */
export function bareAddress(value: string): string | null {
  const v = value.trim();
  const m = /^(?:"?([^"<>\r\n]*)"?\s*)?<([^<>\s]+)>$/.exec(v);
  const addr = m ? m[2] : v;
  return ADDRESS.test(addr) ? addr : null;
}

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const envSchema = z.object({
  EMAIL_TRANSPORT: optional,
  EMAIL_FROM: optional,
  EMAIL_DEV_REDIRECT: optional,
  SES_REGION: optional,
  SES_CONFIGURATION_SET: optional,
  SES_ACCESS_KEY_ID: optional,
  SES_SECRET_ACCESS_KEY: optional,
  NODE_ENV: optional,
});

type Env = Record<string, string | undefined>;

/**
 * Picks the transport from the environment. Never throws: a bad setup comes back as `{ok:false, error}` so the
 * caller can fail at send time with a clear message instead of crashing the module at import.
 */
export function resolveEmailConfig(env: Env): EmailConfigResult {
  const e = envSchema.parse(env);
  const wanted = e.EMAIL_TRANSPORT?.toLowerCase();
  if (wanted && wanted !== "ses" && wanted !== "log") {
    return { ok: false, error: `EMAIL_TRANSPORT must be "ses" or "log", not "${e.EMAIL_TRANSPORT}".` };
  }

  let devRedirect: string | null = null;
  if (e.EMAIL_DEV_REDIRECT) {
    devRedirect = bareAddress(e.EMAIL_DEV_REDIRECT);
    if (!devRedirect) return { ok: false, error: `EMAIL_DEV_REDIRECT isn't an email address: "${e.EMAIL_DEV_REDIRECT}".` };
  }
  if (e.EMAIL_FROM && !bareAddress(e.EMAIL_FROM)) {
    return { ok: false, error: `EMAIL_FROM isn't an email address: "${e.EMAIL_FROM}" (use "Aimpoint <noreply@aimpoint.dev>").` };
  }

  const missing = SES_ENV.filter((k) => !e[k]);
  const production = e.NODE_ENV === "production";

  if (wanted === "log") {
    return { ok: true, config: { transport: "log", from: e.EMAIL_FROM ?? LOG_FROM, devRedirect, reason: "EMAIL_TRANSPORT=log" } };
  }
  if (missing.length === 0) {
    return {
      ok: true,
      config: {
        transport: "ses",
        from: e.EMAIL_FROM!,
        region: e.SES_REGION!,
        configurationSet: e.SES_CONFIGURATION_SET!,
        accessKeyId: e.SES_ACCESS_KEY_ID!,
        secretAccessKey: e.SES_SECRET_ACCESS_KEY!,
        devRedirect,
      },
    };
  }
  if (wanted === "ses") {
    return { ok: false, error: `Email isn't configured: EMAIL_TRANSPORT=ses needs ${missing.join(", ")}.` };
  }
  if (production) {
    return {
      ok: false,
      error: `Email isn't configured: set ${missing.join(", ")} (or EMAIL_TRANSPORT=log to only log messages).`,
    };
  }
  return {
    ok: true,
    config: { transport: "log", from: e.EMAIL_FROM ?? LOG_FROM, devRedirect, reason: `SES not configured (${missing.join(", ")} unset)` },
  };
}

export interface PreparedEmail {
  from: string;
  to: string[];
  replyTo: string[];
  subject: string;
  text: string;
  html: string;
  tag: string | null;
  /** The recipients asked for, when EMAIL_DEV_REDIRECT rewrote them. */
  redirectedFrom: string[] | null;
}

function list(v: string | string[] | undefined): string[] {
  return (Array.isArray(v) ? v : v ? [v] : []).map((s) => s.trim()).filter(Boolean);
}

/** Thrown for a message the caller built wrong (no recipient, bad address, empty subject). */
export class EmailInputError extends Error {}

/** Validates the message and applies the dev redirect. Throws EmailInputError on bad input. */
export function prepareEmail(config: EmailConfig, msg: EmailMessage): PreparedEmail {
  const to = list(msg.to);
  if (to.length === 0) throw new EmailInputError("An email needs at least one recipient.");
  if (to.length > 50) throw new EmailInputError("An email can have at most 50 recipients.");
  for (const a of [...to, ...list(msg.replyTo)]) {
    if (!bareAddress(a)) throw new EmailInputError(`Not an email address: "${a}".`);
  }
  const subject = msg.subject.replace(/[\r\n]+/g, " ").trim();
  if (!subject) throw new EmailInputError("An email needs a subject.");
  const tag = msg.tag ? msg.tag.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256) : null;

  if (config.devRedirect) {
    const original = to.map((a) => bareAddress(a)!);
    const note = `[dev redirect: originally to ${original.join(", ")}]`;
    return {
      from: config.from,
      to: [config.devRedirect],
      replyTo: list(msg.replyTo),
      subject: `[dev to ${original.join(", ")}] ${subject}`,
      text: `${note}\n\n${msg.text}`,
      html: `<p style="font:12px/1.4 sans-serif;color:#8a6d00;background:#fff8db;padding:8px 12px;margin:0 0 12px">${escapeHtml(note)}</p>${msg.html}`,
      tag,
      redirectedFrom: original,
    };
  }
  return { from: config.from, to, replyTo: list(msg.replyTo), subject, text: msg.text, html: msg.html, tag, redirectedFrom: null };
}

/** The SES v2 SendEmailCommand input (shape of `SendEmailCommandInput`, kept structural so this file needs no SDK). */
export function sesSendInput(config: SesConfig, email: PreparedEmail) {
  const tags = [{ Name: "app", Value: "aimpoint" }];
  if (email.tag) tags.push({ Name: "type", Value: email.tag });
  return {
    FromEmailAddress: email.from,
    Destination: { ToAddresses: email.to },
    ...(email.replyTo.length ? { ReplyToAddresses: email.replyTo } : {}),
    Content: {
      Simple: {
        Subject: { Data: email.subject, Charset: "UTF-8" },
        Body: { Text: { Data: email.text, Charset: "UTF-8" }, Html: { Data: email.html, Charset: "UTF-8" } },
      },
    },
    ConfigurationSetName: config.configurationSet,
    EmailTags: tags,
  };
}

/** The log transport's output: one readable block, no secrets. */
export function logLine(config: LogConfig, email: PreparedEmail): string {
  return [
    `[email] log transport (${config.reason}); not sent`,
    `  From: ${email.from}`,
    `  To: ${email.to.join(", ")}${email.redirectedFrom ? ` (redirected from ${email.redirectedFrom.join(", ")})` : ""}`,
    ...(email.replyTo.length ? [`  Reply-To: ${email.replyTo.join(", ")}`] : []),
    `  Subject: ${email.subject}`,
    ...(email.tag ? [`  Tag: ${email.tag}`] : []),
    "",
    email.text
      .split("\n")
      .map((l) => `  | ${l}`)
      .join("\n"),
  ].join("\n");
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export interface EmailLayout {
  /** Preview text some clients show next to the subject. */
  preheader?: string;
  heading: string;
  /** Plain-text paragraphs (escaped; a blank line is not needed between them). */
  paragraphs: string[];
  /** One call-to-action button, also printed as a link in the text body. */
  action?: { label: string; url: string };
  /** Small print under the content, e.g. why they got it. */
  footer?: string;
}

/**
 * The one branded layout for app email: a plain white card, the Aimpoint wordmark, a heading, paragraphs and an
 * optional button. Inline styles only (email clients drop <style>), no images, no template dependency.
 * Returns both bodies so `sendEmail({ ...renderEmail(layout), to, subject })` is all a caller needs.
 */
export function renderEmail(layout: EmailLayout): { html: string; text: string } {
  const p = layout.paragraphs.map((t) => t.trim()).filter(Boolean);
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const button = layout.action
    ? `<p style="margin:24px 0"><a href="${escapeHtml(layout.action.url)}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:6px">${escapeHtml(layout.action.label)}</a></p>` +
      `<p style="margin:0 0 16px;font-size:12px;line-height:1.5;color:#71717a">Or open this link: <a href="${escapeHtml(layout.action.url)}" style="color:#52525b;word-break:break-all">${escapeHtml(layout.action.url)}</a></p>`
    : "";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(layout.heading)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5">
${layout.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(layout.preheader)}</div>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e4e4e7;border-radius:8px"><tr><td style="padding:28px 32px;font-family:${font};color:#18181b">
<p style="margin:0 0 20px;font-size:13px;font-weight:700;letter-spacing:0.02em;color:#18181b">Aimpoint</p>
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;font-weight:600">${escapeHtml(layout.heading)}</h1>
${p.map((t) => `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#3f3f46">${escapeHtml(t)}</p>`).join("\n")}
${button}
</td></tr></table>
${layout.footer ? `<p style="max-width:520px;margin:16px auto 0;font-family:${font};font-size:12px;line-height:1.5;color:#a1a1aa">${escapeHtml(layout.footer)}</p>` : ""}
</td></tr></table>
</body></html>`;

  const text = [
    layout.heading,
    "",
    ...p.flatMap((t) => [t, ""]),
    ...(layout.action ? [`${layout.action.label}: ${layout.action.url}`, ""] : []),
    ...(layout.footer ? ["--", layout.footer, ""] : []),
    "Aimpoint",
  ].join("\n");
  return { html, text };
}

export interface SentEmail {
  transport: EmailTransport;
  /** SES MessageId; null for the log transport. */
  messageId: string | null;
  to: string[];
  redirectedFrom: string[] | null;
}

/** What `deliverEmail` needs from the outside world; `@/lib/email` passes the real SES SDK, tests pass fakes. */
export interface MailerDeps<C = unknown> {
  sesClient(config: SesConfig): { send(command: C): Promise<{ MessageId?: string }> };
  sendCommand(input: ReturnType<typeof sesSendInput>): C;
  log(line: string): void;
}

/** Resolves the transport, prepares the message and sends it. Throws a clear Error when email isn't configured. */
export async function deliverEmail<C>(env: Env, msg: EmailMessage, deps: MailerDeps<C>): Promise<SentEmail> {
  const resolved = resolveEmailConfig(env);
  if (!resolved.ok) throw new Error(resolved.error);
  const { config } = resolved;
  const email = prepareEmail(config, msg);
  if (config.transport === "log") {
    deps.log(logLine(config, email));
    return { transport: "log", messageId: null, to: email.to, redirectedFrom: email.redirectedFrom };
  }
  const out = await deps.sesClient(config).send(deps.sendCommand(sesSendInput(config, email)));
  return { transport: "ses", messageId: out.MessageId ?? null, to: email.to, redirectedFrom: email.redirectedFrom };
}
