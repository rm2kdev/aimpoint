// Run with `pnpm test` (node --test; Node strips the TypeScript types of form-rich-core.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { publicSanitize, htmlText, imageSources, prepareRichDescription, FORM_HTML_MAX, FORM_IMAGES_MAX, PUBLIC_LINK_REL } from "./form-rich-core.ts";

const OWN = "/api/uploads/6af98310a81f713925ea19bc-AbCdEfGhIjKlMnOp.png";
const own = (src) => src === OWN;
const clean = (html, allowImages = true) => publicSanitize(html, { allowImages, imageAllowed: own });

test("keeps ordinary formatting", () => {
  const html = "<h2>Steps</h2><p><strong>Bold</strong> <em>it</em> <s>x</s> <u>u</u> <code>c</code></p><ul><li>a</li></ul><ol><li>b</li></ol><blockquote>q</blockquote><pre><code>x</code></pre><hr>";
  assert.equal(clean(html), html.replace("<hr>", "<hr />"));
});

test("strips script, style and event handlers", () => {
  assert.equal(clean('<p>hi<script>alert(1)</script></p>'), "<p>hi</p>");
  assert.equal(clean("<style>p{color:red}</style><p>x</p>"), "<p>x</p>");
  assert.equal(clean('<p onclick="alert(1)" style="color:red" class="x">x</p>'), "<p>x</p>");
  assert.equal(clean(`<img src="${OWN}" onerror="alert(1)">`), `<img src="${OWN}" />`);
  assert.equal(clean('<img src="x" onerror="alert(1)">'), "");
  assert.equal(clean('<iframe src="https://evil.test"></iframe><p>ok</p>'), "<p>ok</p>");
  assert.equal(clean("<svg><script>alert(1)</script></svg><p>ok</p>"), "<p>ok</p>");
  assert.equal(clean('<pre class="language-js"><code class="language-js">x</code></pre>'), "<pre><code>x</code></pre>");
});

test("links: javascript:/data: removed, nofollow added", () => {
  assert.equal(clean('<a href="javascript:alert(1)">x</a>'), `<a target="_blank" rel="${PUBLIC_LINK_REL}">x</a>`);
  assert.equal(clean('<a href="JaVaScRiPt:alert(1)">x</a>'), `<a target="_blank" rel="${PUBLIC_LINK_REL}">x</a>`);
  assert.equal(clean('<a href="data:text/html,<script>alert(1)</script>">x</a>'), `<a target="_blank" rel="${PUBLIC_LINK_REL}">x</a>`);
  assert.equal(clean('<a href="https://ok.test/a" rel="opener" target="_self">x</a>'), `<a href="https://ok.test/a" rel="${PUBLIC_LINK_REL}" target="_blank">x</a>`);
  assert.equal(clean('<a href="//evil.test">x</a>'), `<a target="_blank" rel="${PUBLIC_LINK_REL}">x</a>`);
});

test("images: only the form's own pending uploads survive", () => {
  assert.equal(clean(`<p>see <img src="${OWN}" alt="shot" width="9999" style="x"></p>`), `<p>see <img src="${OWN}" alt="shot" /></p>`);
  assert.equal(clean('<p><img src="https://tracker.test/pixel.gif"></p>'), "<p></p>");
  assert.equal(clean('<img src="data:image/png;base64,iVBORw0KGgo=">'), "");
  assert.equal(clean('<img src="javascript:alert(1)">'), "");
  assert.equal(clean('<img src="//tracker.test/p.gif">'), "");
  // Another form's or org's upload is a foreign src too.
  assert.equal(clean('<img src="/api/uploads/aaaaaaaaaaaaaaaaaaaaaaaa-AbCdEfGhIjKlMnOp.png">'), "");
  // Images off: even the form's own upload is dropped.
  assert.equal(clean(`<p>a<img src="${OWN}">b</p>`, false), "<p>ab</p>");
});

test("text length and image sources", () => {
  assert.equal(htmlText("<p>a &amp; b</p><p>c&lt;d&#33;&#x21;</p>"), "a & b\nc<d!!");
  assert.equal(htmlText(`<p><img src="${OWN}" /></p>`), "");
  assert.deepEqual(imageSources(clean(`<p><img src="${OWN}" alt="a"><img alt="b" src="${OWN}"></p>`)), [OWN, OWN]);
});

test("prepareRichDescription limits", () => {
  const ok = prepareRichDescription(`<p>hi</p><img src="${OWN}"><img src="https://x.test/a.png">`, true, 100);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.sources, [OWN, "https://x.test/a.png"]);
  assert.equal(ok.textLength, 2);
  // Text measured, not markup: lots of tags around little text is fine (each paragraph counts its text + a line break).
  assert.equal(prepareRichDescription("<p><strong><em>x</em></strong></p>".repeat(200), true, 400).ok, true);
  const long = prepareRichDescription(`<p>${"x".repeat(101)}</p>`, true, 100);
  assert.equal(long.ok, false);
  assert.match(long.error, /under 100 characters \(it's 101\)/);
  const raw = prepareRichDescription("<p>" + "a".repeat(FORM_HTML_MAX) + "</p>", true, 10_000_000);
  assert.equal(raw.ok, false);
  assert.match(raw.error, /too much formatting/);
  const many = prepareRichDescription(`<img src="${OWN}">`.repeat(FORM_IMAGES_MAX + 1), true, 100);
  assert.equal(many.ok, false);
  assert.match(many.error, new RegExp(`at most ${FORM_IMAGES_MAX} images`));
  assert.equal(prepareRichDescription(`<img src="${OWN}">`.repeat(FORM_IMAGES_MAX), true, 100).ok, true);
  // Images off: none counted, none kept.
  const off = prepareRichDescription(`<img src="${OWN}">`.repeat(20) + "<p>x</p>", false, 100);
  assert.equal(off.ok, true);
  assert.deepEqual(off.sources, []);
  assert.equal(off.html, "<p>x</p>");
});
