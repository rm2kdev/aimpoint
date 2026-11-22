/**
 * The "your request is done" email for public project submitters (VEC-423): pure content, so it can be unit-tested
 * without a server. `notifyPublicCompletion` (`lib/public-completion.ts`) renders it with `renderEmail` and sends it
 * through `sendEmail` with tag `public-completion`. `renderEmail` escapes every string, so titles and names here
 * stay raw text.
 */
import type { EmailLayout } from "./email-core";

export const PUBLIC_COMPLETION_TAG = "public-completion";

export interface PublicCompletionEmailInput {
  /** Task key, e.g. `WEB-12`. */
  taskKey: string;
  taskTitle: string;
  orgName: string;
  projectName: string;
  /** Name of the done-stage status it moved into (e.g. "Done", "Shipped"). */
  statusName: string;
  /** The submitter's display name, for the greeting. */
  submitterName: string;
  /** Absolute public task link, `<base>/p/<org>/<KEY>?task=<TASK-KEY>`. */
  url: string;
}

export interface PublicCompletionEmail {
  subject: string;
  layout: EmailLayout;
}

/** Subjects stay readable in an inbox list: very long titles are cut with an ellipsis (the body has the full one). */
export const SUBJECT_TITLE_MAX = 120;

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

export function publicCompletionEmail(i: PublicCompletionEmailInput): PublicCompletionEmail {
  const title = i.taskTitle.replace(/\s+/g, " ").trim();
  const name = i.submitterName.trim();
  return {
    subject: `Your request ${i.taskKey} is done: ${clip(title, SUBJECT_TITLE_MAX)}`,
    layout: {
      preheader: `${i.orgName} moved ${i.taskKey} to ${i.statusName}.`,
      heading: `Your request ${i.taskKey} is done`,
      paragraphs: [
        name ? `Hi ${name},` : "Hi,",
        `${i.orgName} finished the request you submitted to ${i.projectName}: "${title}". It's now ${i.statusName}.`,
        "Open it to see the outcome and any updates the team left.",
      ],
      action: { label: "View your request", url: i.url },
      footer: `You're getting this because you submitted ${i.taskKey} on ${i.orgName}'s public ${i.projectName} page. It's sent once per request.`,
    },
  };
}
