// Run with `pnpm test` (node --test; Node strips the TypeScript types of the .ts modules).
import { test } from "node:test";
import assert from "node:assert/strict";
import { INTAKE_ERRORS, TASK_TITLE_MAX, TASK_DESCRIPTION_MAX } from "../../lib/task-intake-core.ts";
import {
  PUBLIC_TYPE_COPY,
  requiredText,
  typeCopy,
  checkComposer,
  charactersLeft,
  charactersLeftText,
  clearError,
  errorOrder,
  fieldKey,
  firstInvalid,
  hasErrors,
  invalidKeys,
  isPlainEnter,
  isSubmitShortcut,
  offeredTypes,
  serverFieldErrors,
  serverSummary,
  startingType,
  summaryHeading,
  trimEmptyParagraphs,
} from "./task-composer-core.ts";

const FIELDS = [
  { id: "a1", label: "Steps", kind: "long" },
  { id: "b2", label: "Screens", kind: "screenshot" },
];

test("checkComposer mirrors the intake rules with the shared messages", () => {
  const rules = { titleMax: TASK_TITLE_MAX };
  assert.deepEqual(checkComposer({ title: "  ", descriptionLength: 0 }, rules, INTAKE_ERRORS), { title: INTAKE_ERRORS.titleMissing });
  assert.deepEqual(checkComposer({ title: "x".repeat(301), descriptionLength: 0 }, rules, INTAKE_ERRORS), { title: INTAKE_ERRORS.titleTooLong(301) });
  assert.deepEqual(checkComposer({ title: " ok ", descriptionLength: 99_999 }, rules, INTAKE_ERRORS), {}, "no description cap unless one is given");
  const pub = { titleMax: TASK_TITLE_MAX, descriptionMax: TASK_DESCRIPTION_MAX, allowedTypes: ["issue", "feature"], allowedStatuses: ["s1", "s2"] };
  assert.deepEqual(checkComposer({ title: "t", descriptionLength: 10_001, type: "task", statusId: "s9" }, pub, INTAKE_ERRORS), {
    description: INTAKE_ERRORS.descriptionTooLong(10_001),
    type: INTAKE_ERRORS.typeNotAllowed,
    status: INTAKE_ERRORS.statusNotAllowed,
  });
  assert.deepEqual(checkComposer({ title: "t", descriptionLength: 10_000, type: "feature", statusId: "s2" }, pub, INTAKE_ERRORS), {});
  assert.deepEqual(checkComposer({ title: "t", descriptionLength: 0, statusId: "x" }, { titleMax: 300, allowedStatuses: [] }, INTAKE_ERRORS), {}, "empty status list = no status choice");
});

test("serverFieldErrors maps every intake message to its field", () => {
  const cases = [
    [INTAKE_ERRORS.titleMissing, "title"],
    [INTAKE_ERRORS.titleTooLong(400), "title"],
    ["Give the task a title.", "title"],
    [INTAKE_ERRORS.descriptionNotText, "description"],
    [INTAKE_ERRORS.descriptionTooLong(12_000), "description"],
    [INTAKE_ERRORS.descriptionTooMuchFormatting, "description"],
    [INTAKE_ERRORS.tooManyImages(12), "description"],
    [INTAKE_ERRORS.typeNotAllowed, "type"],
    ["Pick one of: issue, feature.", "type"],
    [INTAKE_ERRORS.statusNotAllowed, "status"],
    [INTAKE_ERRORS.nameTooLong, "name"],
    [INTAKE_ERRORS.emailTooLong, "email"],
    [INTAKE_ERRORS.emailInvalid, "email"],
  ];
  for (const [message, key] of cases) assert.deepEqual(serverFieldErrors(message), { [key]: message }, message);
  // General errors name nothing.
  assert.deepEqual(serverFieldErrors(INTAKE_ERRORS.notTakingTickets), {});
  assert.deepEqual(serverFieldErrors("Too many tickets from you. Try again in 10 minutes."), {});
});

test("serverFieldErrors marks custom fields named in quotes", () => {
  const m = 'Fill in the required fields: "Steps", "Screens".';
  assert.deepEqual(serverFieldErrors(m, FIELDS), { [fieldKey("a1")]: "Fill this in.", [fieldKey("b2")]: "Add at least one image." });
  assert.equal(serverSummary(m, serverFieldErrors(m, FIELDS)), null, "a Fill in list is said inline");
  const long = '"Steps" is too long.';
  assert.deepEqual(serverFieldErrors(long, FIELDS), { [fieldKey("a1")]: long });
  assert.equal(serverSummary(long, serverFieldErrors(long, FIELDS)), null, "the field already shows the message");
  assert.equal(serverSummary(INTAKE_ERRORS.emailInvalid, serverFieldErrors(INTAKE_ERRORS.emailInvalid)), null);
  assert.equal(serverSummary("Nope.", {}), "Nope.");
  assert.equal(serverSummary("Nope.", { title: "Other" }), "Nope.");
});

test("focus order, invalid keys and clearing", () => {
  assert.deepEqual(errorOrder(FIELDS), ["type", "title", "description", "field:a1", "field:b2", "name", "email", "status"]);
  const errors = { email: "e", [fieldKey("b2")]: "s", title: "t" };
  assert.deepEqual(invalidKeys(errors, FIELDS), ["title", "field:b2", "email"]);
  assert.equal(firstInvalid(errors, FIELDS), "title");
  assert.equal(firstInvalid({}, FIELDS), null);
  assert.equal(firstInvalid({ [fieldKey("zz")]: "x" }, FIELDS), null, "unknown field keys aren't focused");
  const same = { title: "t" };
  assert.equal(clearError(same, "email"), same, "nothing to clear returns the same object");
  assert.deepEqual(clearError(same, "title"), {});
  assert.equal(hasErrors({ title: undefined }), false);
  assert.equal(hasErrors({ title: "x" }), true);
});

test("keyboard: Cmd/Ctrl+Enter submits, plain Enter only without modifiers, never while composing", () => {
  assert.equal(isSubmitShortcut({ key: "Enter", metaKey: true }), true);
  assert.equal(isSubmitShortcut({ key: "Enter", ctrlKey: true }), true);
  assert.equal(isSubmitShortcut({ key: "Enter" }), false);
  assert.equal(isSubmitShortcut({ key: "Enter", metaKey: true, isComposing: true }), false);
  assert.equal(isSubmitShortcut({ key: "a", metaKey: true }), false);
  assert.equal(isPlainEnter({ key: "Enter" }), true);
  assert.equal(isPlainEnter({ key: "Enter", shiftKey: true }), false);
  assert.equal(isPlainEnter({ key: "Enter", metaKey: true }), false);
  assert.equal(isPlainEnter({ key: "Enter", isComposing: true }), false);
});

test("types on offer and the starting type", () => {
  const all = ["issue", "feature", "task"];
  assert.deepEqual(offeredTypes(all), all);
  assert.deepEqual(offeredTypes(all, []), all);
  assert.deepEqual(offeredTypes(all, ["task", "issue"]), ["issue", "task"], "kept in the canonical order");
  assert.deepEqual(offeredTypes(all, ["bogus"]), all, "nothing valid left falls back to every type");
  assert.equal(startingType(["issue", "task"], "task"), "task");
  assert.equal(startingType(["issue", "task"], "feature"), "issue");
  assert.equal(startingType(["feature"], null), "feature");
});

test("description helpers", () => {
  assert.equal(trimEmptyParagraphs("<p>a</p><p></p><p></p>"), "<p>a</p>");
  assert.equal(trimEmptyParagraphs("<p></p>"), "");
  assert.equal(trimEmptyParagraphs(""), "");
  assert.equal(charactersLeft(undefined, 5), null);
  assert.equal(charactersLeft(10_000, 100), null);
  assert.equal(charactersLeft(10_000, 9_600), 400);
  assert.equal(charactersLeft(10_000, 10_010), -10);
  assert.equal(charactersLeftText(400), "400 characters left");
  assert.equal(charactersLeftText(1), "1 character left");
  assert.equal(charactersLeftText(0), "0 characters left");
  assert.equal(charactersLeftText(-1), "1 character over");
  assert.equal(charactersLeftText(-12), "12 characters over");
  assert.equal(charactersLeftText(-1_234), "1,234 characters over");
  assert.equal(summaryHeading(0), "That didn't go through.");
  assert.equal(summaryHeading(1), "One thing needs fixing before you send:");
  assert.equal(summaryHeading(3), "3 things need fixing before you send:");
});

test("public type words cover every task type; required-field text by kind", async () => {
  const { TASK_TYPES } = await import("../../lib/types.ts");
  for (const t of TASK_TYPES) assert.ok(PUBLIC_TYPE_COPY[t]?.label, t);
  assert.deepEqual(typeCopy("issue"), { label: "Bug report", hint: "Something isn't working" });
  assert.deepEqual(typeCopy("chore", { chore: "Chore" }), { label: "Chore", hint: "" });
  assert.equal(typeCopy("x").label, "x");
  assert.equal(requiredText({ id: "a", label: "A", kind: "screenshot" }), "Add at least one image.");
  assert.equal(requiredText({ id: "a", label: "A", kind: "short" }), "Fill this in.");
});
