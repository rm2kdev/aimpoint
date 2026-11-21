// Run with `pnpm test`. AIM-6: links in rich-text editors open on Cmd/Ctrl/middle-click when editable,
// natively when read-only, and only for http(s)/mailto hrefs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isApplePlatform, linkClickAction, openLinkHint, openableHref } from "./link-open.ts";

const BASE = "https://app.aimpoint.dev/o/rm2kdev/all?task=AIM-6";

test("http(s) and mailto hrefs open, normalised", () => {
  assert.equal(openableHref("https://example.com/a?b=1#c"), "https://example.com/a?b=1#c");
  assert.equal(openableHref("  HTTP://Example.com  "), "http://example.com/");
  assert.equal(openableHref("mailto:ryan@example.com"), "mailto:ryan@example.com");
});

test("relative hrefs resolve against the page", () => {
  assert.equal(openableHref("/o/rm2kdev/all?task=AIM-4", BASE), "https://app.aimpoint.dev/o/rm2kdev/all?task=AIM-4");
  assert.equal(openableHref("//example.com/x", BASE), "https://example.com/x");
  assert.equal(openableHref("/x"), null, "no base: a relative href can't be resolved");
});

test("javascript: and other schemes never open, however they're disguised", () => {
  for (const href of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "\u0001javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "ftp://example.com/",
    "tel:+61400000000",
  ]) {
    assert.equal(openableHref(href, BASE), null, JSON.stringify(href));
  }
});

test("empty and junk hrefs never open", () => {
  for (const href of [undefined, null, "", "   ", "http://", "https://exa mple.com"]) assert.equal(openableHref(href, BASE), null, String(href));
});

test("editable editor: plain click edits, Cmd/Ctrl-click and middle-click open", () => {
  assert.equal(linkClickAction(true, { button: 0 }), "edit");
  assert.equal(linkClickAction(true, { button: 0, metaKey: true }), "open");
  assert.equal(linkClickAction(true, { button: 0, ctrlKey: true }), "open");
  assert.equal(linkClickAction(true, { button: 1 }), "open");
  assert.equal(linkClickAction(true, { button: 2 }), "ignore");
});

test("read-only editor: the browser opens the link itself", () => {
  assert.equal(linkClickAction(false, { button: 0 }), "native");
  assert.equal(linkClickAction(false, { button: 0, metaKey: true }), "native");
  assert.equal(linkClickAction(false, { button: 1 }), "native");
  assert.equal(linkClickAction(false, { button: 2 }), "ignore");
});

test("hint names the platform's modifier", () => {
  assert.equal(isApplePlatform("MacIntel"), true);
  assert.equal(isApplePlatform("iPhone"), true);
  assert.equal(isApplePlatform("Win32"), false);
  assert.equal(isApplePlatform("", "Mozilla/5.0 (X11; Linux x86_64)"), false);
  assert.equal(openLinkHint(true), "⌘-click to open link");
  assert.equal(openLinkHint(false), "Ctrl-click to open link");
});
