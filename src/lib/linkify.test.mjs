// Run with `pnpm test` (node --test). Comment linkify (AIM-7): http(s) URLs and Markdown [text](url) become
// link parts, trailing punctuation stays text, every other scheme stays text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isHttpUrl, linkify, trimUrl } from "./linkify.ts";

/** Compact view: links as <href|text>, text as-is. */
const show = (s) => linkify(s).map((p) => (p.kind === "link" ? (p.href === p.text ? `<${p.href}>` : `<${p.href}|${p.text}>`) : p.text)).join("");

test("bare http(s) URLs become links", () => {
  assert.equal(show("see https://example.com/a?b=1#c now"), "see <https://example.com/a?b=1#c> now");
  assert.equal(show("http://localhost:3000/o/x"), "<http://localhost:3000/o/x>");
  assert.equal(show("HTTPS://Example.com"), "<HTTPS://Example.com>");
  assert.equal(show("two: https://a.io and https://b.io"), "two: <https://a.io> and <https://b.io>");
  assert.equal(show("line1\nhttps://a.io\nline3"), "line1\n<https://a.io>\nline3");
});

test("trailing punctuation is not swallowed", () => {
  assert.equal(show("Go to https://example.com."), "Go to <https://example.com>.");
  assert.equal(show("https://a.io/x, then"), "<https://a.io/x>, then");
  assert.equal(show("(see https://a.io/x)"), "(see <https://a.io/x>)");
  assert.equal(show("[https://a.io/x]"), "[<https://a.io/x>]");
  assert.equal(show("really https://a.io/x?!"), "really <https://a.io/x>?!");
  assert.equal(show("**https://a.io/x**"), "**<https://a.io/x>**");
  assert.equal(show("(https://a.io/x)."), "(<https://a.io/x>).");
  assert.equal(show("'https://a.io/x'"), "'<https://a.io/x>'");
  assert.equal(show('"https://a.io/x"'), '"<https://a.io/x>"');
});

test("balanced parens inside a URL are kept", () => {
  assert.equal(show("https://en.wikipedia.org/wiki/Foo_(bar)"), "<https://en.wikipedia.org/wiki/Foo_(bar)>");
  assert.equal(show("(https://en.wikipedia.org/wiki/Foo_(bar))"), "(<https://en.wikipedia.org/wiki/Foo_(bar)>)");
  assert.equal(trimUrl("https://a.io/x)"), "https://a.io/x");
  assert.equal(trimUrl("https://a.io/(x)"), "https://a.io/(x)");
  assert.equal(trimUrl("https://a.io/x]."), "https://a.io/x");
});

test("Markdown links keep their label", () => {
  assert.equal(show("a [the docs](https://example.com/docs) b"), "a <https://example.com/docs|the docs> b");
  assert.equal(show("[Foo](https://en.wikipedia.org/wiki/Foo_(bar))."), "<https://en.wikipedia.org/wiki/Foo_(bar)|Foo>.");
  assert.equal(show("[a](https://a.io) and https://b.io"), "<https://a.io|a> and <https://b.io>");
  // Not links: images, escaped brackets, non-http targets.
  assert.equal(show("![pic](https://a.io/p.png)"), "![pic](<https://a.io/p.png>)");
  assert.equal(show("\\[x](https://a.io)"), "\\[x](<https://a.io>)");
  assert.equal(show("[x](javascript:alert(1))"), "[x](javascript:alert(1))");
  assert.equal(show("[x](/relative/path)"), "[x](/relative/path)");
  assert.equal(show("[x](mailto:a@b.c)"), "[x](mailto:a@b.c)");
});

test("other schemes and lookalikes stay text", () => {
  for (const s of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "mailto:someone@example.com",
    "ftp://example.com/file",
    "file:///etc/passwd",
    "www.example.com",
    "https://",
    "https://.",
    "xhttps://a.io",
    "javascript://https://a.io",
    "plain words only",
    "",
  ]) {
    assert.equal(linkify(s).some((p) => p.kind === "link"), false, s);
    assert.equal(show(s), s);
  }
});

test("mention tokens and HTML stay outside the URL", () => {
  assert.equal(show("https://a.io/x<@6af98310a81f713925ea19bc>"), "<https://a.io/x><@6af98310a81f713925ea19bc>");
  assert.equal(show('<a href="https://a.io">x</a>'), '<a href="<https://a.io>">x</a>');
  const [, link] = linkify('x https://a.io/"><img src=x onerror=alert(1)>');
  assert.equal(link.href, "https://a.io/");
});

test("isHttpUrl", () => {
  assert.equal(isHttpUrl("https://a.io"), true);
  assert.equal(isHttpUrl("http://10.0.0.2:3000/x"), true);
  assert.equal(isHttpUrl("https://"), false);
  assert.equal(isHttpUrl("javascript:alert(1)"), false);
  assert.equal(isHttpUrl("//a.io"), false);
});

test("text parts are merged and order is kept", () => {
  assert.deepEqual(linkify("a [b](https://b.io) c https://c.io d"), [
    { kind: "text", text: "a " },
    { kind: "link", href: "https://b.io", text: "b" },
    { kind: "text", text: " c " },
    { kind: "link", href: "https://c.io", text: "https://c.io" },
    { kind: "text", text: " d" },
  ]);
  assert.deepEqual(linkify("no links"), [{ kind: "text", text: "no links" }]);
  assert.deepEqual(linkify(""), []);
});
