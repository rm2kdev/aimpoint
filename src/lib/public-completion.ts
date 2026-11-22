/**
 * VEC-423: email a public project submitter once their task reaches a done-stage status. Rules in
 * `public-completion-core.ts`, email content in `public-completion-email.ts`, docs in docs/task-creation.md
 * ("Completion email for public submitters").
 *
 * Called from the status write paths that can move a task into done: `updateTaskAs` (which moveTask, the flow engine's
 * advances, MCP set_status / complete_task, REST and the pane all go through) and `deleteStatus` (tasks of a deleted
 * status moved into a done one). Fire-and-forget: the work runs in `after()` (detached outside a request), and any
 * failure is logged, never thrown, so the status change is neither failed nor slowed.
 */
import "server-only";
import { after } from "next/server";
import { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { appBaseUrl } from "@/lib/app-url";
import { sendEmail, renderEmail } from "@/lib/email";
import { absoluteUrl } from "@/lib/invite-email";
import { hasFeature } from "@/lib/billing-limits";
import { publicPageHref } from "@/app/p/[org]/[key]/href";
import { mayNotifyPublicCompletion, publicCompletionSkip } from "@/lib/public-completion-core";
import { PUBLIC_COMPLETION_TAG, publicCompletionEmail } from "@/lib/public-completion-email";
import type { StatusDoc, TaskDoc } from "@/lib/types";

type Moved = Pick<TaskDoc, "_id" | "source" | "publicCompletionNotifiedAt">;

/**
 * A status write just moved `tasks` from a `prevStage` status into `status`. Returns at once; tasks that may qualify
 * (public source, into done from not done, not notified) are handled after the response.
 */
export function notifyPublicCompletion(orgId: ObjectId, tasks: Moved[], prevStage: string | null | undefined, status: Pick<StatusDoc, "_id" | "category">): void {
  const due = tasks.filter((t) => mayNotifyPublicCompletion(t.source, prevStage, status.category, t.publicCompletionNotifiedAt));
  if (!due.length) return;
  // Read inside the request: the origin comes from its headers when AUTH_URL isn't set.
  const base = appBaseUrl().catch(() => null);
  const job = async () => {
    for (const t of due) {
      try {
        await sendOne(orgId, t._id, status._id, prevStage, await base);
      } catch (err) {
        console.error(`[public-completion] task ${t._id.toHexString()}:`, err);
      }
    }
  };
  try {
    after(job);
  } catch {
    // Outside a request (scripts): run detached.
    void job();
  }
}

async function sendOne(orgId: ObjectId, taskId: ObjectId, statusId: ObjectId, prevStage: string | null | undefined, base: string | null) {
  const c = await cols();
  const task = await c.tasks.findOne({ _id: taskId, orgId });
  if (!task || task.source?.kind !== "public") return;
  const [project, org, status] = await Promise.all([
    c.projects.findOne({ _id: task.projectId, orgId }),
    c.orgs.findOne({ _id: orgId }),
    c.statuses.findOne({ _id: statusId, orgId }),
  ]);
  if (!project || !org || !status) return;
  const projectPublic = !!project.publicAccess?.enabled && !project.archivedAt && (await hasFeature(orgId, "publicForms"));
  const skip = publicCompletionSkip({
    source: task.source,
    prevStage,
    // Still in that status: a quick move on (back out, or to another done status) after this write wins.
    nextStage: task.statusId.equals(statusId) ? status.category : null,
    archived: !!task.archivedAt,
    notifiedAt: task.publicCompletionNotifiedAt,
    projectPublic,
  });
  if (skip) return;
  if (!base) {
    console.warn(`[public-completion] ${project.key}-${task.number}: no base URL for the link (set AUTH_URL); not sent.`);
    return;
  }
  // Recipient: the submitter's current address. A deleted account (or one without an email) gets nothing.
  const user = await c.users.findOne({ _id: task.source.userId }, { projection: { email: 1, name: 1 } });
  if (!user?.email) return;

  // Claim the send: only one concurrent or repeated done move gets past this, and reopening + closing again finds it set.
  const now = new Date();
  const claimed = await c.tasks.updateOne(
    { _id: taskId, orgId, "source.kind": "public", archivedAt: null, statusId, publicCompletionNotifiedAt: null },
    { $set: { publicCompletionNotifiedAt: now } },
  );
  if (!claimed.modifiedCount) return;

  const key = `${project.key}-${task.number}`;
  const mail = publicCompletionEmail({
    taskKey: key,
    taskTitle: task.title,
    orgName: org.name,
    projectName: project.name,
    statusName: status.name,
    submitterName: user.name ?? task.source.userName,
    url: absoluteUrl(base, publicPageHref(org.slug, project.key, { task: key })),
  });
  try {
    await sendEmail({ to: user.email, subject: mail.subject, ...renderEmail(mail.layout), tag: PUBLIC_COMPLETION_TAG });
  } catch (err) {
    // Not sent: drop the claim so a later move into done can try again.
    await c.tasks.updateOne({ _id: taskId, publicCompletionNotifiedAt: now }, { $set: { publicCompletionNotifiedAt: null } });
    throw err;
  }
}
