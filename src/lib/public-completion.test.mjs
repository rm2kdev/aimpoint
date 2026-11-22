// Run with `pnpm test` (node --test; Node strips the TypeScript types).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mayNotifyPublicCompletion, publicCompletionSkip, shouldNotifyPublicCompletion } from "./public-completion-core.ts";
import { PUBLIC_COMPLETION_TAG, SUBJECT_TITLE_MAX, publicCompletionEmail } from "./public-completion-email.ts";
import { renderEmail } from "./email-core.ts";
import { absoluteUrl } from "./invite-email.ts";
import { publicPageHref } from "../app/p/[org]/[key]/href.ts";

const ok = { source: { kind: "public" }, prevStage: "started", nextStage: "done", archived: false, notifiedAt: null, projectPublic: true };

test("a public submission moving into done from an open status is emailed", () => {
  assert.equal(publicCompletionSkip(ok), null);
  assert.equal(shouldNotifyPublicCompletion(ok), true);
  for (const prevStage of ["backlog", "triage", "unstarted", "started", "cancelled", null, undefined]) {
    assert.equal(shouldNotifyPublicCompletion({ ...ok, prevStage }), true, String(prevStage));
  }
});

test("only public submissions: member-created, bot sub-tasks and form tasks send nothing", () => {
  assert.equal(publicCompletionSkip({ ...ok, source: null }), "not_public");
  assert.equal(publicCompletionSkip({ ...ok, source: undefined }), "not_public");
  assert.equal(publicCompletionSkip({ ...ok, source: { kind: "form" } }), "not_public");
});

test("only done: cancelled or open statuses send nothing", () => {
  for (const nextStage of ["cancelled", "started", "unstarted", "backlog", "triage", null]) {
    assert.equal(publicCompletionSkip({ ...ok, nextStage }), "not_done", String(nextStage));
  }
});

test("done to done, archived, already notified and no-longer-public projects send nothing", () => {
  assert.equal(publicCompletionSkip({ ...ok, prevStage: "done" }), "already_done");
  assert.equal(publicCompletionSkip({ ...ok, archived: true }), "archived");
  assert.equal(publicCompletionSkip({ ...ok, notifiedAt: new Date() }), "notified");
  assert.equal(publicCompletionSkip({ ...ok, notifiedAt: "2026-11-22T00:00:00Z" }), "notified");
  assert.equal(publicCompletionSkip({ ...ok, projectPublic: false }), "project_private");
});

test("the write-path pre-check matches the rule's cheap parts", () => {
  assert.equal(mayNotifyPublicCompletion({ kind: "public" }, "started", "done", null), true);
  assert.equal(mayNotifyPublicCompletion({ kind: "public" }, "started", "done", undefined), true);
  assert.equal(mayNotifyPublicCompletion({ kind: "public" }, "done", "done", null), false);
  assert.equal(mayNotifyPublicCompletion({ kind: "public" }, "started", "cancelled", null), false);
  assert.equal(mayNotifyPublicCompletion({ kind: "public" }, "started", "done", new Date()), false);
  assert.equal(mayNotifyPublicCompletion({ kind: "form" }, "started", "done", null), false);
  assert.equal(mayNotifyPublicCompletion(null, "started", "done", null), false);
});

const input = {
  taskKey: "WEB-12",
  taskTitle: "Export <script>alert(1)</script> & \"CSV\"",
  orgName: "Northwind <Labs>",
  projectName: "Web & App",
  statusName: "Shipped",
  submitterName: "Sam O'Neil",
  url: absoluteUrl("https://app.aimpoint.dev", publicPageHref("northwind", "WEB", { task: "WEB-12" })),
};

test("completion email: subject, link, status, org and project in both bodies", () => {
  const mail = publicCompletionEmail(input);
  assert.equal(mail.subject, `Your request WEB-12 is done: ${input.taskTitle}`);
  assert.equal(input.url, "https://app.aimpoint.dev/p/northwind/WEB?task=WEB-12");
  assert.deepEqual(mail.layout.action, { label: "View your request", url: input.url });
  const { html, text } = renderEmail(mail.layout);
  for (const body of [text]) {
    assert.ok(body.includes("Northwind <Labs>"));
    assert.ok(body.includes("Web & App"));
    assert.ok(body.includes("Shipped"));
    assert.ok(body.includes(input.taskTitle));
    assert.ok(body.includes(`View your request: ${input.url}`));
  }
  assert.ok(html.includes(`href="https://app.aimpoint.dev/p/northwind/WEB?task=WEB-12"`));
  assert.ok(html.includes("Shipped"));
});

test("completion email escapes the title and names in HTML", () => {
  const { html } = renderEmail(publicCompletionEmail(input).layout);
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("Export &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;CSV&quot;"));
  assert.ok(html.includes("Northwind &lt;Labs&gt;"));
  assert.ok(html.includes("Web &amp; App"));
  assert.ok(html.includes("Sam O&#39;Neil"));
});

test("completion email: long titles are clipped in the subject only, whitespace collapsed, no name falls back", () => {
  const long = "x".repeat(300);
  const mail = publicCompletionEmail({ ...input, taskTitle: `  ${long}\n`, submitterName: " " });
  const subjectTitle = mail.subject.slice("Your request WEB-12 is done: ".length);
  assert.equal(subjectTitle.length, SUBJECT_TITLE_MAX);
  assert.ok(subjectTitle.endsWith("…"));
  assert.ok(mail.layout.paragraphs[1].includes(long));
  assert.equal(mail.layout.paragraphs[0], "Hi,");
  assert.equal(publicCompletionEmail({ ...input, taskTitle: "a\n\n b" }).subject, "Your request WEB-12 is done: a b");
  assert.equal(PUBLIC_COMPLETION_TAG, "public-completion");
});
