// Run with `pnpm test` (node --test; Node strips the TypeScript types of form-fields-core.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanFormFields,
  cleanEmailHelp,
  checkHideDescription,
  readFieldValues,
  screenshotUrls,
  composeFormDescription,
  plainTextToHtml,
  FORM_FIELDS_MAX,
  FORM_FIELD_LABEL_MAX,
  FORM_FIELD_HELP_MAX,
  FORM_FIELD_VALUE_MAX,
  FORM_FIELD_SCREENSHOTS_MAX,
  FORM_FIELDS_TEXT_MAX,
  FORM_EMAIL_HELP_MAX,
} from "./form-fields-core.ts";
import { htmlToMarkdown } from "./markdown-core.ts";

let n = 0;
const ids = () => `gen${++n}`;
const ok = (v) => {
  assert.ok(Array.isArray(v), `expected a list, got ${JSON.stringify(v)}`);
  return v;
};

const FIELDS = ok(
  cleanFormFields(
    [
      { id: "steps", label: "Steps to reproduce", kind: "long", required: true, help: "What did you do?" },
      { id: "expected", label: "What did you expect", kind: "short" },
      { id: "shot", label: "Screenshot", kind: "screenshot", required: true },
      { id: "browser", label: "Browser", kind: "short", required: false },
    ],
    ids,
  ),
);
const OWN = "/api/uploads/6af98310a81f713925ea19bc-AbCdEfGhIjKlMnOp.png";

/* ---------------- field validation ---------------- */

test("missing or null fields read as none", () => {
  assert.deepEqual(cleanFormFields(undefined), []);
  assert.deepEqual(cleanFormFields(null), []);
  assert.deepEqual(cleanFormFields([]), []);
});

test("cleans a valid list, keeping order, ids, help and required", () => {
  assert.deepEqual(FIELDS, [
    { id: "steps", label: "Steps to reproduce", help: "What did you do?", kind: "long", required: true },
    { id: "expected", label: "What did you expect", help: null, kind: "short", required: false },
    { id: "shot", label: "Screenshot", help: null, kind: "screenshot", required: true },
    { id: "browser", label: "Browser", help: null, kind: "short", required: false },
  ]);
});

test("trims labels and makes ids for new, bad or repeated ones", () => {
  const out = ok(cleanFormFields([{ label: "  A   b ", kind: "short" }, { id: "has space", label: "B", kind: "long" }, { id: "x", label: "C", kind: "short" }, { id: "x", label: "D", kind: "short" }], ids));
  assert.equal(out[0].label, "A b");
  assert.match(out[0].id, /^gen\d+$/);
  assert.match(out[1].id, /^gen\d+$/);
  assert.equal(out[2].id, "x");
  assert.notEqual(out[3].id, "x");
  assert.equal(new Set(out.map((f) => f.id)).size, 4);
});

test("default id generator gives distinct safe ids", () => {
  const out = ok(cleanFormFields([{ label: "A", kind: "short" }, { label: "B", kind: "short" }]));
  assert.match(out[0].id, /^[A-Za-z0-9_-]{1,32}$/);
  assert.notEqual(out[0].id, out[1].id);
});

test("refuses bad field lists with readable messages", () => {
  assert.equal(cleanFormFields("nope"), "Fields must be a list.");
  assert.match(cleanFormFields(Array.from({ length: FORM_FIELDS_MAX + 1 }, (_, i) => ({ label: `F${i}`, kind: "short" }))), /at most 12 extra fields/);
  assert.equal(cleanFormFields([null]), "Field 1 isn't a field.");
  assert.equal(cleanFormFields([{ label: "  ", kind: "short" }]), "Field 1 needs a label.");
  assert.equal(cleanFormFields([{ label: 5, kind: "short" }]), "Field 1's label must be text.");
  assert.match(cleanFormFields([{ label: "x".repeat(FORM_FIELD_LABEL_MAX + 1), kind: "short" }]), /under 80 characters/);
  assert.equal(cleanFormFields([{ label: "Steps", kind: "short" }, { label: "steps", kind: "long" }]), 'Two fields are labelled "steps". Give each field its own label.');
  assert.match(cleanFormFields([{ label: "A", kind: "video" }]), /unknown kind "video"\. Kinds are: short/);
  assert.match(cleanFormFields([{ label: "A" }]), /unknown kind ""/);
  assert.match(cleanFormFields([{ label: "A", kind: "short", help: "h".repeat(FORM_FIELD_HELP_MAX + 1) }]), /help text of "A" under 300/);
  assert.match(cleanFormFields([{ label: "A", kind: "short", help: 3 }]), /help text must be text/);
  assert.match(cleanFormFields([{ label: "A", kind: "short", required: "yes" }]), /required is true or false/);
});

test("email note and hide-description rules", () => {
  assert.equal(cleanEmailHelp(undefined), null);
  assert.equal(cleanEmailHelp("  "), null);
  assert.equal(cleanEmailHelp(" Only used to ask\nyou follow-up questions "), "Only used to ask you follow-up questions");
  assert.deepEqual(cleanEmailHelp("x".repeat(FORM_EMAIL_HELP_MAX + 1)), { error: "Keep the email note under 200 characters." });
  assert.deepEqual(cleanEmailHelp(1), { error: "The email note must be text." });
  assert.equal(checkHideDescription(false, []), null);
  assert.match(checkHideDescription(true, []), /Add at least one text field/);
  assert.match(checkHideDescription(true, [FIELDS[2]]), /Add at least one text field/);
  assert.equal(checkHideDescription(true, FIELDS), null);
});

/* ---------------- submitted values ---------------- */

test("no fields: nothing read, nothing required", () => {
  assert.deepEqual(readFieldValues([], { fields: { steps: "x" } }), { values: {} });
});

test("reads JSON values and plain-post field_<id> keys, dropping empty optionals", () => {
  const r = readFieldValues(FIELDS, { fields: { steps: " 1. open\r\n2. click ", shot: OWN, unknown: "ignored" }, field_expected: "  it\n works ", field_browser: "" });
  assert.deepEqual(r, { values: { steps: "1. open\n2. click", expected: "it works", shot: [OWN] } });
  const list = readFieldValues(FIELDS, { fields: { steps: "s", shot: [OWN, OWN, " "] } });
  assert.deepEqual(list.values.shot, [OWN]);
});

test("rejects missing required fields, naming them in form order", () => {
  assert.deepEqual(readFieldValues(FIELDS, {}), { error: 'Fill in the required fields: "Steps to reproduce", "Screenshot".' });
  assert.deepEqual(readFieldValues(FIELDS, { fields: { steps: "   ", shot: [] } }), { error: 'Fill in the required fields: "Steps to reproduce", "Screenshot".' });
  assert.deepEqual(readFieldValues(FIELDS, { fields: { steps: "did a thing" } }), { error: 'Fill in "Screenshot".' });
});

test("rejects wrong shapes and caps lengths", () => {
  assert.match(readFieldValues(FIELDS, { fields: "x" }).error, /wasn't right/);
  assert.match(readFieldValues(FIELDS, { fields: ["x"] }).error, /wasn't right/);
  assert.equal(readFieldValues(FIELDS, { fields: { steps: 5, shot: OWN } }).error, '"Steps to reproduce" must be text.');
  assert.match(readFieldValues(FIELDS, { fields: { steps: "s", shot: [1] } }).error, /"Screenshot" wasn't an uploaded image/);
  assert.match(readFieldValues(FIELDS, { fields: { steps: "s", shot: Array.from({ length: FORM_FIELD_SCREENSHOTS_MAX + 1 }, (_, i) => `/api/uploads/a${i}.png`) } }).error, /at most 5 images to "Screenshot"/);
  assert.match(readFieldValues(FIELDS, { fields: { steps: "s", shot: OWN, expected: "x".repeat(FORM_FIELD_VALUE_MAX.short + 1) } }).error, /Keep "What did you expect" under 300 characters \(it's 301\)/);
  assert.match(readFieldValues(FIELDS, { fields: { steps: "x".repeat(FORM_FIELD_VALUE_MAX.long + 1), shot: OWN } }).error, /under 5,000 characters/);
  const many = ok(cleanFormFields(Array.from({ length: 4 }, (_, i) => ({ id: `l${i}`, label: `L${i}`, kind: "long" }))));
  const big = Object.fromEntries(many.map((f) => [f.id, "y".repeat(FORM_FIELD_VALUE_MAX.long)]));
  assert.ok(4 * FORM_FIELD_VALUE_MAX.long > FORM_FIELDS_TEXT_MAX);
  assert.match(readFieldValues(many, { fields: big }).error, /too much text/);
});

test("screenshotUrls lists only screenshot values", () => {
  assert.deepEqual(screenshotUrls(FIELDS, { steps: "s", shot: [OWN, "/api/uploads/b.png"] }), [OWN, "/api/uploads/b.png"]);
});

/* ---------------- task description ---------------- */

test("composes labelled sections in form order after the description, empty optionals omitted", () => {
  const { values } = readFieldValues(FIELDS, { fields: { steps: "1. open\n2. click\n\nthen it broke", shot: OWN, browser: "Safari 18" } });
  const html = composeFormDescription("<p>It's broken</p>", FIELDS, values, (u) => u === OWN);
  assert.equal(
    html,
    `<p>It's broken</p><h3>Steps to reproduce</h3><p>1. open<br>2. click</p><p>then it broke</p><h3>Screenshot</h3><p><img src="${OWN}" alt="Screenshot"></p><h3>Browser</h3><p>Safari 18</p>`,
  );
  assert.ok(!html.includes("What did you expect"));
  // Agents read it as Markdown sections.
  const md = htmlToMarkdown(html);
  assert.match(md, /^### Steps to reproduce$/m);
  assert.match(md, /^### Screenshot$/m);
  assert.ok(md.includes(`![Screenshot](${OWN})`));
  assert.ok(md.indexOf("### Steps") < md.indexOf("### Screenshot") && md.indexOf("### Screenshot") < md.indexOf("### Browser"));
});

test("escapes typed markup and drops images that aren't the form's own uploads", () => {
  const f = ok(cleanFormFields([{ id: "a", label: "<b>Label</b>", kind: "short" }, { id: "s", label: "Shot", kind: "screenshot" }]));
  const html = composeFormDescription("", f, { a: '<img src=x onerror=alert(1)> ![x](https://evil/x.png) ok', s: ["https://evil/x.png"] }, (u) => u === OWN);
  assert.equal(html, "<h3>&lt;b&gt;Label&lt;/b&gt;</h3><p>&lt;img src=x onerror=alert(1)&gt;  ok</p>");
  assert.doesNotMatch(html, /<img/);
});

test("description alone is unchanged when no field has a value", () => {
  assert.equal(composeFormDescription("<p>x</p>", FIELDS, {}), "<p>x</p>");
  assert.equal(plainTextToHtml("a\nb\n\n\nc"), "<p>a<br>b</p><p>c</p>");
});
