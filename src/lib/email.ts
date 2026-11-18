/**
 * The one place the app sends email from (VEC-295). Rules (transport choice, dev redirect, request shape, layout)
 * live in `email-core.ts`; this module wires them to the SES v2 SDK. Env vars: `.env.example` (Email) and README.
 *
 *   import { sendEmail, renderEmail } from "@/lib/email";
 *   await sendEmail({ to, subject, ...renderEmail({ heading, paragraphs, action }), tag: "invite" });
 *
 * Nothing is read at import: a missing or bad setup throws a clear Error from `sendEmail`, so callers inside
 * `guard()` log it and show the generic error instead of the page crashing.
 */
import "server-only";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { deliverEmail, type EmailMessage, type SentEmail, type SesConfig } from "@/lib/email-core";

export { renderEmail, EmailInputError, type EmailMessage, type EmailLayout, type SentEmail } from "@/lib/email-core";

const g = globalThis as unknown as { __aimpointSes?: { key: string; client: SESv2Client } };

function sesClient(config: SesConfig): SESv2Client {
  const key = `${config.region}:${config.accessKeyId}`;
  if (g.__aimpointSes?.key !== key) {
    g.__aimpointSes = {
      key,
      client: new SESv2Client({
        region: config.region,
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      }),
    };
  }
  return g.__aimpointSes.client;
}

/** Sends one email through the configured transport (SES, or the server log in plain local dev). */
export async function sendEmail(msg: EmailMessage): Promise<SentEmail> {
  const sent = await deliverEmail<SendEmailCommand>(process.env, msg, {
    sesClient: (config) => {
      const client = sesClient(config);
      return { send: (command) => client.send(command) };
    },
    sendCommand: (input) => new SendEmailCommand(input),
    log: (line) => console.info(line),
  });
  if (sent.transport === "ses") {
    console.info(`[email] sent ${msg.tag ?? "email"} via SES to ${sent.to.join(", ")}: ${sent.messageId}`);
  }
  return sent;
}
