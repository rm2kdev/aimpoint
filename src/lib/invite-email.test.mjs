// Run with `pnpm test` (node --test; Node strips the TypeScript types).
import { test } from "node:test";
import assert from "node:assert/strict";
import { inviteEmail, absoluteUrl } from "./invite-email.ts";
import { renderEmail } from "./email-core.ts";

const base = {
  to: "sam@example.com",
  orgName: "Northwind <Labs>",
  inviterName: "Ryan",
  inviterEmail: "ryan@example.com",
  role: "member",
  url: "https://app.aimpoint.dev/invite/tok_123",
  expiresInDays: 14,
};

test("invite email names the org, inviter, role and link in both bodies", () => {
  const mail = inviteEmail(base);
  assert.equal(mail.subject, "Ryan invited you to Northwind <Labs> on Aimpoint");
  assert.equal(mail.replyTo, "ryan@example.com");
  const { text, html } = renderEmail(mail.layout);
  assert.match(text, /Ryan \(ryan@example\.com\) invited you to join Northwind <Labs> as a member\./);
  assert.match(text, /Accept invite: https:\/\/app\.aimpoint\.dev\/invite\/tok_123/);
  assert.match(text, /expires in 14 days/);
  assert.match(html, /href="https:\/\/app\.aimpoint\.dev\/invite\/tok_123"/);
  assert.match(html, /Northwind &lt;Labs&gt;/, "org name is escaped in HTML");
  assert.doesNotMatch(html, /Northwind <Labs>/);
});

test("admin role reads 'an admin'", () => {
  const { text } = renderEmail(inviteEmail({ ...base, role: "admin" }).layout);
  assert.match(text, /as an admin\./);
});

test("absoluteUrl joins origins with or without a trailing slash", () => {
  assert.equal(absoluteUrl("https://app.aimpoint.dev", "/invite/x"), "https://app.aimpoint.dev/invite/x");
  assert.equal(absoluteUrl("https://app.aimpoint.dev/", "/invite/x"), "https://app.aimpoint.dev/invite/x");
  assert.equal(absoluteUrl("http://10.0.0.2:3200", "/invite/x"), "http://10.0.0.2:3200/invite/x");
});
