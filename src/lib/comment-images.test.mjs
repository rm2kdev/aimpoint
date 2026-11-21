// Run with `pnpm test` (node --test). Comment images (VEC-335): only this org's uploads become images,
// everything else stays literal text (VEC-243 rule), and the thread gallery orders description then comments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { commentImages, galleryDescription, imageToken, insertBlock, isOrgUploadUrl, splitCommentBody, threadGallery } from "./comment-images.ts";
import { collectImages } from "./image-lightbox-core.ts";

const ORG = "6af98310a81f713925ea19bc";
const OTHER = "6af98310a81f713925ea19bd";
const up = (n = "abcDEF123_-xyz09", ext = "png") => `/api/uploads/${ORG}-${n}.${ext}`;
const text = (body) => splitCommentBody(body, ORG).map((p) => (p.kind === "text" ? p.text : `[img ${p.src}]`)).join("|");

test("this org's upload URLs are recognised, nothing else", () => {
  assert.equal(isOrgUploadUrl(up(), ORG), true);
  assert.equal(isOrgUploadUrl(up("x", "jpg"), ORG), true);
  assert.equal(isOrgUploadUrl(`https://abc123.public.blob.vercel-storage.com/uploads/${ORG}-k.webp`, ORG), true);
  for (const bad of [
    `/api/uploads/${OTHER}-abc.png`, // another org's upload
    `/api/uploads/avatar-${ORG}-abc.png`,
    `/api/uploads/${ORG}-abc.svg`,
    `/api/uploads/${ORG}-../secret.png`,
    `/api/uploads/${ORG}-abc.png?x=1`,
    `/api/uploads/${ORG}-abc.png/../x`,
    `https://evil.example/api/uploads/${ORG}-abc.png`,
    `//evil.example/api/uploads/${ORG}-abc.png`,
    `javascript:alert(1)`,
    `https://abc.public.blob.vercel-storage.com.evil.example/uploads/${ORG}-k.png`,
  ]) {
    assert.equal(isOrgUploadUrl(bad, ORG), false, bad);
  }
  assert.equal(isOrgUploadUrl(up(), "not-an-id"), false);
});

test("an upload token becomes an image part; text and mentions around it stay", () => {
  const body = `Before <@${OTHER}>\n![shot.png](${up()})\nafter`;
  const parts = splitCommentBody(body, ORG);
  assert.deepEqual(parts, [
    { kind: "text", text: `Before <@${OTHER}>` },
    { kind: "image", src: up(), alt: "shot.png", index: 0 },
    { kind: "text", text: "after" },
  ]);
});

test("non-upload URLs, <img> tags and escaped image syntax stay literal text", () => {
  for (const body of [
    "![x](https://evil.example/t.png)",
    `![x](/api/uploads/${OTHER}-abc.png)`,
    `<img src="${up()}">`,
    '<img src="https://evil.example/t.png" onerror="alert(1)">',
    `\\![x](${up()})`,
    `\\\\\\![x](${up()})`,
    `![x](${up()} "title")`,
    `![x](<${up()}>)`,
    `![a\nb](${up()})`,
    `[x](${up()})`,
    "![image]()",
  ]) {
    assert.deepEqual(splitCommentBody(body, ORG), [{ kind: "text", text: body }], body);
    assert.deepEqual(commentImages(body, ORG), [], body);
  }
});

test("an escaped backslash before the image doesn't escape it", () => {
  assert.equal(text(`\\\\![x](${up()})`), `\\\\|[img ${up()}]`);
});

test("several images keep their order and indexes", () => {
  const a = up("aaaa");
  const b = up("bbbb", "gif");
  const parts = splitCommentBody(`![a](${a})![b](${b}) and ![no](https://x.test/y.png)`, ORG);
  assert.deepEqual(
    parts.map((p) => (p.kind === "image" ? `${p.index}:${p.src}` : p.text)),
    [`0:${a}`, `1:${b}`, " and ![no](https://x.test/y.png)"],
  );
  assert.deepEqual(commentImages(`x ![a](${a}) y ![b](${b})`, ORG), [{ src: a, alt: "a" }, { src: b, alt: "b" }]);
});

test("plain comments are untouched", () => {
  for (const body of ["", "hello", `hi <@${ORG}>\n\nline two`, "a ! [b] (c)"]) {
    assert.deepEqual(splitCommentBody(body, ORG), body ? [{ kind: "text", text: body }] : []);
  }
});

test("imageToken makes a token the parser reads back", () => {
  const t = imageToken("my [weird] (file)\nname.png", up());
  assert.equal(t, `![my weird filename.png](${up()})`);
  assert.deepEqual(commentImages(t, ORG), [{ src: up(), alt: "my weird filename.png" }]);
  assert.equal(imageToken("", up()), `![image](${up()})`);
});

test("insertBlock puts the token on its own line", () => {
  assert.deepEqual(insertBlock("", 0, 0, "T"), { text: "T\n", caret: 2 });
  assert.deepEqual(insertBlock("hello", 5, 5, "T"), { text: "hello\nT\n", caret: 8 });
  assert.deepEqual(insertBlock("ab", 1, 1, "T"), { text: "a\nT\nb", caret: 4 });
  assert.deepEqual(insertBlock("a\n\nb", 2, 2, "T"), { text: "a\nT\nb", caret: 3 });
  assert.deepEqual(insertBlock("a XX b", 2, 4, "T"), { text: "a \nT\n b", caret: 5 });
});

test("thread gallery: description images first, then comment images oldest first", () => {
  const d = [{ src: "/d1", alt: "d1" }, { src: "/d2", alt: "d2" }];
  const c1 = up("c1c1");
  const c2 = up("c2c2");
  const g = threadGallery(
    d,
    [
      { id: "a", body: `first ![c1](${c1})` },
      { id: "b", body: "no images ![x](https://evil.example/x.png)" },
      { id: "c", body: `![c2](${c2})` },
    ],
    ORG,
  );
  assert.deepEqual(g.images.map((i) => i.src), ["/d1", "/d2", c1, c2]);
  // Opening comment image 1 lands on 3 / 4.
  assert.equal(g.offsets.get("a") + 0 + 1, 3);
  assert.equal(g.offsets.get("c"), 3);
  assert.equal(g.offsets.has("b"), false);
});

test("a comment-opened gallery includes description images just added in the pane (VEC-370)", () => {
  const d1 = up("desc1aaaaaaaaaaa");
  const d2 = up("desc2aaaaaaaaaaa");
  const c1 = up("comm1aaaaaaaaaaa");
  const stored = `<p>spec</p><img src="${d1}" alt="one">`;
  const edited = `${stored}<img src="${d2}" alt="two">`;
  const comments = [{ id: "a", body: `see ![c1](${c1})` }];
  const gallery = (html) => threadGallery(collectImages(html), comments, ORG);
  // No local edit yet: the stored description.
  assert.equal(galleryDescription(stored, null), stored);
  assert.deepEqual(gallery(galleryDescription(stored, null)).images.map((i) => i.src), [d1, c1]);
  // After adding an image in the pane (task.description not yet updated): 3 images, the comment's is 3 / 3.
  const g = gallery(galleryDescription(stored, edited));
  assert.deepEqual(g.images.map((i) => i.src), [d1, d2, c1]);
  assert.equal(g.offsets.get("a") + 1, 3);
  // An edit that removed every image wins over the stored html too.
  assert.deepEqual(collectImages(galleryDescription(stored, "<p>spec</p>")), []);
});
