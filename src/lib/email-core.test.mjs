// Run with `pnpm test` (node --test; Node strips the TypeScript types of email-core.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import {
  resolveEmailConfig,
  prepareEmail,
  sesSendInput,
  deliverEmail,
  renderEmail,
  bareAddress,
  EmailInputError,
  LOG_FROM,
} from "./email-core.ts";

const SES = {
  EMAIL_FROM: "Aimpoint <noreply@aimpoint.dev>",
  SES_REGION: "us-east-1",
  SES_CONFIGURATION_SET: "aimpoint-dev",
  SES_ACCESS_KEY_ID: "AKIAFAKE",
  SES_SECRET_ACCESS_KEY: "secret",
};
const MSG = { to: "mia@example.com", subject: "Hello", text: "Hi Mia", html: "<p>Hi Mia</p>" };

/** Fake SDK: records the commands sent and never touches the network. */
function fakeDeps() {
  const sent = [];
  const logs = [];
  const clients = [];
  return {
    sent,
    logs,
    clients,
    deps: {
      sesClient(config) {
        clients.push(config);
        return { send: async (command) => (sent.push(command), { MessageId: "msg-1" }) };
      },
      sendCommand: (input) => new SendEmailCommand(input),
      log: (line) => logs.push(line),
    },
  };
}

test("transport: log when SES vars are missing outside production", () => {
  const r = resolveEmailConfig({ NODE_ENV: "development" });
  assert.equal(r.ok, true);
  assert.equal(r.config.transport, "log");
  assert.equal(r.config.from, LOG_FROM);
  assert.match(r.config.reason, /SES_REGION/);
  // a partial setup is still log in dev, and says what's missing
  const partial = resolveEmailConfig({ ...SES, SES_SECRET_ACCESS_KEY: "", NODE_ENV: "development" });
  assert.equal(partial.config.transport, "log");
  assert.match(partial.config.reason, /SES_SECRET_ACCESS_KEY/);
  assert.equal(resolveEmailConfig({}).config.transport, "log");
});

test("transport: ses when every SES var is set", () => {
  const r = resolveEmailConfig({ ...SES, NODE_ENV: "production" });
  assert.deepEqual(r, {
    ok: true,
    config: {
      transport: "ses",
      from: "Aimpoint <noreply@aimpoint.dev>",
      region: "us-east-1",
      configurationSet: "aimpoint-dev",
      accessKeyId: "AKIAFAKE",
      secretAccessKey: "secret",
      devRedirect: null,
    },
  });
  assert.equal(resolveEmailConfig({ ...SES, EMAIL_TRANSPORT: "SES" }).config.transport, "ses");
});

test("transport: explicit log wins even with SES configured, and in production", () => {
  const r = resolveEmailConfig({ ...SES, EMAIL_TRANSPORT: "log", NODE_ENV: "production" });
  assert.equal(r.config.transport, "log");
  assert.equal(r.config.from, SES.EMAIL_FROM);
});

test("transport: missing config in production is an error naming the vars, not a crash", () => {
  const r = resolveEmailConfig({ NODE_ENV: "production", EMAIL_FROM: SES.EMAIL_FROM, SES_REGION: "us-east-1" });
  assert.equal(r.ok, false);
  assert.match(r.error, /Email isn't configured/);
  assert.match(r.error, /SES_CONFIGURATION_SET, SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY/);
  assert.doesNotMatch(r.error, /EMAIL_FROM/);
  const forced = resolveEmailConfig({ EMAIL_TRANSPORT: "ses", NODE_ENV: "development" });
  assert.equal(forced.ok, false);
  assert.match(forced.error, /EMAIL_TRANSPORT=ses needs EMAIL_FROM/);
});

test("transport: bad values are errors", () => {
  assert.match(resolveEmailConfig({ EMAIL_TRANSPORT: "smtp" }).error, /must be "ses" or "log"/);
  assert.match(resolveEmailConfig({ ...SES, EMAIL_FROM: "nope" }).error, /EMAIL_FROM isn't an email address/);
  assert.match(resolveEmailConfig({ EMAIL_DEV_REDIRECT: "nope" }).error, /EMAIL_DEV_REDIRECT/);
});

test("deliverEmail throws the config error at send time and never calls SES", async () => {
  const f = fakeDeps();
  await assert.rejects(deliverEmail({ NODE_ENV: "production" }, MSG, f.deps), /Email isn't configured/);
  assert.equal(f.sent.length, 0);
  assert.equal(f.clients.length, 0);
});

test("log transport prints the message and never builds an SES client", async () => {
  const f = fakeDeps();
  const out = await deliverEmail({ NODE_ENV: "development" }, { ...MSG, tag: "invite" }, f.deps);
  assert.deepEqual(out, { transport: "log", messageId: null, to: ["mia@example.com"], redirectedFrom: null });
  assert.equal(f.clients.length, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(f.logs.length, 1);
  assert.match(f.logs[0], /To: mia@example.com/);
  assert.match(f.logs[0], /Subject: Hello/);
  assert.match(f.logs[0], /Tag: invite/);
  assert.match(f.logs[0], /\| Hi Mia/);
});

test("SES request shape: SendEmailCommand with config set, simple content, reply-to and tags", async () => {
  const f = fakeDeps();
  const out = await deliverEmail(
    SES,
    { to: ["mia@example.com", "Sofia <sofia@example.com>"], subject: "Line\r\nbreak", text: "t", html: "<p>h</p>", replyTo: "ryan@example.com", tag: "invite" },
    f.deps,
  );
  assert.equal(out.transport, "ses");
  assert.equal(out.messageId, "msg-1");
  assert.equal(f.clients[0].region, "us-east-1");
  assert.equal(f.clients[0].accessKeyId, "AKIAFAKE");
  assert.equal(f.sent.length, 1);
  assert.ok(f.sent[0] instanceof SendEmailCommand);
  assert.deepEqual(f.sent[0].input, {
    FromEmailAddress: "Aimpoint <noreply@aimpoint.dev>",
    Destination: { ToAddresses: ["mia@example.com", "Sofia <sofia@example.com>"] },
    ReplyToAddresses: ["ryan@example.com"],
    Content: {
      Simple: {
        Subject: { Data: "Line break", Charset: "UTF-8" },
        Body: { Text: { Data: "t", Charset: "UTF-8" }, Html: { Data: "<p>h</p>", Charset: "UTF-8" } },
      },
    },
    ConfigurationSetName: "aimpoint-dev",
    EmailTags: [
      { Name: "app", Value: "aimpoint" },
      { Name: "type", Value: "invite" },
    ],
  });
});

test("SES request shape: no reply-to key when none given, tag sanitised", () => {
  const config = resolveEmailConfig(SES).config;
  const input = sesSendInput(config, prepareEmail(config, { ...MSG, tag: "an invite!" }));
  assert.equal("ReplyToAddresses" in input, false);
  assert.deepEqual(input.EmailTags[1], { Name: "type", Value: "an_invite_" });
});

test("dev redirect rewrites every recipient to one address and keeps the originals visible", async () => {
  const f = fakeDeps();
  const env = { ...SES, EMAIL_DEV_REDIRECT: "Ryan <dev@aimpoint.dev>" };
  const out = await deliverEmail(env, { ...MSG, to: ["mia@example.com", "Sofia <sofia@example.com>"] }, f.deps);
  assert.deepEqual(out.to, ["dev@aimpoint.dev"]);
  assert.deepEqual(out.redirectedFrom, ["mia@example.com", "sofia@example.com"]);
  const input = f.sent[0].input;
  assert.deepEqual(input.Destination, { ToAddresses: ["dev@aimpoint.dev"] });
  assert.equal(input.Content.Simple.Subject.Data, "[dev to mia@example.com, sofia@example.com] Hello");
  assert.match(input.Content.Simple.Body.Text.Data, /^\[dev redirect: originally to mia@example.com, sofia@example.com\]\n\nHi Mia$/);
  assert.match(input.Content.Simple.Body.Html.Data, /originally to mia@example.com.*<p>Hi Mia<\/p>$/s);
  // the log transport redirects too
  const g = fakeDeps();
  await deliverEmail({ EMAIL_DEV_REDIRECT: "dev@aimpoint.dev" }, MSG, g.deps);
  assert.match(g.logs[0], /To: dev@aimpoint.dev \(redirected from mia@example.com\)/);
});

test("bad messages are refused before sending", async () => {
  const config = resolveEmailConfig(SES).config;
  assert.throws(() => prepareEmail(config, { ...MSG, to: [] }), EmailInputError);
  assert.throws(() => prepareEmail(config, { ...MSG, to: "not-an-address" }), /Not an email address/);
  assert.throws(() => prepareEmail(config, { ...MSG, replyTo: "x" }), /Not an email address/);
  assert.throws(() => prepareEmail(config, { ...MSG, subject: " \n " }), /needs a subject/);
  const f = fakeDeps();
  await assert.rejects(deliverEmail(SES, { ...MSG, to: "bad" }, f.deps), EmailInputError);
  assert.equal(f.sent.length, 0);
});

test("bareAddress accepts plain and display-name forms", () => {
  assert.equal(bareAddress("a@b.co"), "a@b.co");
  assert.equal(bareAddress("Aimpoint <noreply@aimpoint.dev>"), "noreply@aimpoint.dev");
  assert.equal(bareAddress('"Ryan L" <r@x.io>'), "r@x.io");
  assert.equal(bareAddress("a@b"), null);
  assert.equal(bareAddress("a b@c.d"), null);
});

test("renderEmail: escaped branded HTML and a matching text body", () => {
  const { html, text } = renderEmail({
    preheader: "Join <Northwind>",
    heading: "You're invited to Northwind & co",
    paragraphs: ["Ryan invited you.", "  ", "<b>not bold</b>"],
    action: { label: "Accept invite", url: "https://app.aimpoint.dev/invite/abc?x=1&y=2" },
    footer: "You got this because someone invited you.",
  });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, />Aimpoint</);
  assert.match(html, /You&#39;re invited to Northwind &amp; co/);
  assert.match(html, /&lt;b&gt;not bold&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>not bold/);
  assert.match(html, /href="https:\/\/app.aimpoint.dev\/invite\/abc\?x=1&amp;y=2"/);
  assert.match(html, /Join &lt;Northwind&gt;/);
  assert.doesNotMatch(html, /<style/);
  assert.equal(
    text,
    [
      "You're invited to Northwind & co",
      "",
      "Ryan invited you.",
      "",
      "<b>not bold</b>",
      "",
      "Accept invite: https://app.aimpoint.dev/invite/abc?x=1&y=2",
      "",
      "--",
      "You got this because someone invited you.",
      "",
      "Aimpoint",
    ].join("\n"),
  );
  const bare = renderEmail({ heading: "Hi", paragraphs: ["One"] });
  assert.doesNotMatch(bare.html, /<a /);
  assert.equal(bare.text, "Hi\n\nOne\n\nAimpoint");
});
