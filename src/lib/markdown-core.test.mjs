// Run with `pnpm test` (node --test; Node strips the TypeScript types of markdown-core.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToMarkdown, markdownToHtml, escapeMarkdownText } from "./markdown-core.ts";

const OWN = "/api/uploads/6af98310a81f713925ea19bc-AbCdEfGhIjKlMnOp.png";
const roundTrip = (html) => markdownToHtml(htmlToMarkdown(html));
const hasImg = (html) => /<img\b/i.test(html);

test("typed markdown image text is escaped for agents", () => {
  assert.equal(htmlToMarkdown("<p>![x](https://evil.example/t.png)</p>"), "!\\[x\\](https://evil.example/t.png)");
  assert.equal(htmlToMarkdown("<p>![image]()</p>"), "!\\[image\\]()");
  assert.equal(htmlToMarkdown("<p>[click](https://evil.example)</p>"), "\\[click\\](https://evil.example)");
});

test("round-trip of typed markup stays text, no image or link", () => {
  for (const text of ["![x](https://evil.example/t.png)", "![image]()", "see ![a](/api/uploads/x.png) now", "[c](https://evil.example)"]) {
    const html = roundTrip(`<p>${text}</p>`);
    assert.ok(!hasImg(html), html);
    assert.ok(!/<a\b/.test(html), html);
    assert.equal(html, `<p>${text}</p>`);
  }
});

test("typed HTML tags stay text through the round-trip", () => {
  const stored = '<p>&lt;img src="https://evil.example/t.png"&gt;</p>';
  const md = htmlToMarkdown(stored);
  assert.equal(md, '\\<img src="https://evil.example/t.png">');
  assert.equal(markdownToHtml(md), '<p>&lt;img src=&quot;https://evil.example/t.png&quot;&gt;</p>');
});

test("numeric entities can't smuggle brackets past the escaping", () => {
  const html = roundTrip("<p>&#33;&#91;x&#93;(https://evil.example/t.png)</p>");
  assert.ok(!hasImg(html), html);
});

test("real images and links still round-trip", () => {
  assert.equal(htmlToMarkdown(`<p><img src="${OWN}" alt="shot"></p>`), `![shot](${OWN})`);
  assert.equal(roundTrip(`<p><img src="${OWN}" alt="shot"></p>`), `<p><img src="${OWN}" alt="shot"></p>`);
  assert.equal(roundTrip(`<p><img src="${OWN}"></p>`), `<p><img src="${OWN}" alt="image"></p>`);
  assert.equal(roundTrip('<p>go <a href="https://ok.test/a">here</a></p>'), '<p>go <a href="https://ok.test/a">here</a></p>');
});

test("an image alt can't break out of its brackets", () => {
  const md = htmlToMarkdown(`<p><img src="${OWN}" alt="a](https://evil.example/t.png) ![b"></p>`);
  const html = markdownToHtml(md);
  assert.equal([...html.matchAll(/<img\b[^>]*src="([^"]+)"/g)].map((m) => m[1]).join(), OWN);
});

test("formatting still round-trips", () => {
  const html = "<h2>Steps</h2><p><strong>Bold</strong> <em>it</em> <s>gone</s> <code>a[0]*b</code></p><ul><li><p>one</p></li></ul><ol><li><p>two</p></li></ol>";
  assert.equal(roundTrip(html), html);
  assert.equal(roundTrip('<pre><code class="language-js">const a = arr[0] * 2; // ![x](y)</code></pre>'), '<pre><code class="language-js">const a = arr[0] * 2; // ![x](y)</code></pre>');
});

test("code keeps its text verbatim for agents", () => {
  assert.equal(htmlToMarkdown("<p><code>![x](u)</code></p>"), "`![x](u)`");
  assert.equal(htmlToMarkdown("<pre><code>a &lt;b&gt; &amp;lt;</code></pre>"), "```\na <b> &lt;\n```");
});

test("typed emphasis/strike/backslashes stay literal", () => {
  for (const text of ["5 * 3 * 2", "**not bold**", "~~not struck~~", "_not em_", "C:\\Users\\[x]", "a \\* b", "snake_case_name ~5 min", "a < b > c"]) {
    const md = htmlToMarkdown(`<p>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`);
    assert.equal(markdownToHtml(md), `<p>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`, md);
  }
});

test("ordinary prose isn't littered with escapes", () => {
  assert.equal(escapeMarkdownText("snake_case at ~5 min, a < b, C:\\Users, 50% off!"), "snake_case at ~5 min, a < b, C:\\Users, 50% off!");
});

test("agent-written backslash escapes read as the plain character", () => {
  assert.equal(markdownToHtml("\\[x\\] and \\`tick\\`"), "<p>[x] and `tick`</p>");
  assert.equal(markdownToHtml("`code \\[kept\\]`"), "<p><code>code \\[kept\\]</code></p>");
});
