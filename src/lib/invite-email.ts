/**
 * The invitation email (VEC-296): pure content, so it can be unit-tested without a server. `createInvite` in
 * `app/actions/org.ts` renders it with `renderEmail` and sends it through `sendEmail` (`lib/email.ts`).
 */
import type { EmailLayout } from "./email-core";

export interface InviteEmailInput {
  /** Invitee address (the invite's email). */
  to: string;
  orgName: string;
  inviterName: string;
  inviterEmail: string;
  role: "admin" | "member";
  /** Absolute accept link, `<base>/invite/<token>`. */
  url: string;
  /** Days until the link expires. */
  expiresInDays: number;
}

export interface InviteEmail {
  subject: string;
  layout: EmailLayout;
  replyTo: string;
}

export function inviteEmail(i: InviteEmailInput): InviteEmail {
  const role = i.role === "admin" ? "an admin" : "a member";
  return {
    subject: `${i.inviterName} invited you to ${i.orgName} on Aimpoint`,
    replyTo: i.inviterEmail,
    layout: {
      preheader: `Join ${i.orgName} as ${role}. The link expires in ${i.expiresInDays} days.`,
      heading: `Join ${i.orgName} on Aimpoint`,
      paragraphs: [
        `${i.inviterName} (${i.inviterEmail}) invited you to join ${i.orgName} as ${role}.`,
        "Open the invite to accept it. You'll sign in, or create an account if you don't have one yet.",
        `The link works once and expires in ${i.expiresInDays} days.`,
      ],
      action: { label: "Accept invite", url: i.url },
      footer: `This invite was sent to ${i.to}. If you weren't expecting it, you can ignore this email. Replies go to ${i.inviterName}.`,
    },
  };
}

/** Joins a base URL (origin, possibly with a trailing slash) and an app path into one absolute link. */
export function absoluteUrl(base: string, path: string): string {
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}
