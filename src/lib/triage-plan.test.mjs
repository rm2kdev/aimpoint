// Run with `pnpm test`. VEC-402: a triager writes a plan instead of replacing the reporter's description, and every
// description/plan change keeps the text it replaced.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ASSIGNEE_REFUSAL, TRIAGE_ARCHIVE_REFUSAL, TRIAGE_DESCRIPTION_REFUSAL, TRIAGE_FIELDS, refusePatch, taskAccess } from "./access.ts";
import { HISTORY_COALESCE_MS, HISTORY_TEXT_MAX, continuesEdit, keptText, normalizePlan } from "./text-history.ts";

test("a triaging bot is refused on description, with the guidance message", () => {
  const r = refusePatch({ description: "<p>my plan</p>" }, true);
  assert.deepEqual(r, { blocked: ["description"], error: TRIAGE_DESCRIPTION_REFUSAL });
  assert.match(TRIAGE_DESCRIPTION_REFUSAL, /can't replace the reporter's description; put your plan in `plan` instead/);
  // Sent together with allowed fields, it's still refused (and the description wins over archive wording).
  assert.equal(refusePatch({ triagePlan: "<p>x</p>", description: "<p>y</p>", archived: true }, true)?.error, TRIAGE_DESCRIPTION_REFUSAL);
});

test("a triaging bot may set the plan and everything else it could before", () => {
  assert.equal(refusePatch({ triagePlan: "<p>plan</p>" }, true), null);
  assert.equal(refusePatch({ triagePlan: null }, true), null);
  assert.equal(refusePatch({ title: "t", projectId: "p", dependsOn: [], statusId: "s", assigneeId: null, priority: 2, type: "task", dueDate: null }, true), null);
  assert.ok(!TRIAGE_FIELDS.includes("description"));
  assert.ok(TRIAGE_FIELDS.includes("triagePlan"));
  // Undefined keys don't count (MCP/REST patches carry every field).
  assert.equal(refusePatch({ triagePlan: "<p>x</p>", description: undefined, archived: undefined }, true), null);
  assert.equal(refusePatch({ archived: true }, true)?.error, TRIAGE_ARCHIVE_REFUSAL);
});

test("an assignee can't set the plan or the description", () => {
  assert.deepEqual(refusePatch({ triagePlan: "<p>x</p>" }, false), { blocked: ["triagePlan"], error: ASSIGNEE_REFUSAL });
  assert.equal(refusePatch({ description: "<p>x</p>" }, false)?.error, ASSIGNEE_REFUSAL);
  assert.equal(refusePatch({ statusId: "s", priority: 1 }, false), null);
});

test("creator and admin keep full access (description and plan never go through refusePatch)", () => {
  assert.equal(taskAccess({ createdBy: "u1", assigneeId: null }, "u1", false), "full");
  assert.equal(taskAccess({ createdBy: "u1", assigneeId: null }, "admin", true), "full");
  // A bot triaging a task it created is its creator: full access, description edits allowed.
  assert.equal(taskAccess({ createdBy: "bot", assigneeId: null }, "bot", false), "full");
  assert.equal(taskAccess({ createdBy: "u1", assigneeId: null }, "bot", false), "comment");
});

test("history keeps the replaced text whole up to the description cap", () => {
  assert.equal(keptText("<p>original report</p>"), "<p>original report</p>");
  assert.equal(keptText(""), "");
  assert.equal(keptText(null), null);
  assert.equal(keptText(undefined), null);
  const big = "a".repeat(HISTORY_TEXT_MAX + 10);
  assert.equal(keptText(big).length, HISTORY_TEXT_MAX);
  assert.equal(HISTORY_TEXT_MAX, 200_000);
});

test("a burst of edits by one actor keeps one entry; anything else starts a new one", () => {
  const now = new Date("2026-11-21T08:00:00Z");
  const at = (ms) => new Date(now.getTime() - ms);
  assert.equal(continuesEdit({ kind: "description", actorId: "u1", createdAt: at(60_000) }, "description", "u1", now), true);
  assert.equal(continuesEdit({ kind: "description", actorId: "u1", createdAt: at(HISTORY_COALESCE_MS) }, "description", "u1", now), false);
  assert.equal(continuesEdit({ kind: "description", actorId: "u2", createdAt: at(1000) }, "description", "u1", now), false);
  assert.equal(continuesEdit({ kind: "plan", actorId: "u1", createdAt: at(1000) }, "description", "u1", now), false);
  assert.equal(continuesEdit({ kind: "status", actorId: "u1", createdAt: at(1000) }, "description", "u1", now), false);
  assert.equal(continuesEdit(null, "plan", "u1", now), false);
});

test("an empty plan clears it", () => {
  assert.equal(normalizePlan(""), null);
  assert.equal(normalizePlan("<p></p>"), null);
  assert.equal(normalizePlan("<p> &nbsp; </p><p><br /></p>"), null);
  assert.equal(normalizePlan("<p>Split into 3 tasks</p>"), "<p>Split into 3 tasks</p>");
  assert.equal(normalizePlan('<p><img src="https://x/y.png" /></p>'), '<p><img src="https://x/y.png" /></p>');
});
