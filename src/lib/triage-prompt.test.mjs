// Run with `pnpm test`. VEC-403: the triage guidance (wake-up steps, check_for_triage, update_task, server
// instructions) tells a triager to write its plan in `plan` and never tells it to rewrite the description.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dispatch = readFileSync(new URL("./bot-dispatch.ts", import.meta.url), "utf8");
const server = readFileSync(new URL("./mcp/server.ts", import.meta.url), "utf8");
const block = (src, start, end) => src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)));

const triageSteps = block(dispatch, "export const TRIAGE_STEPS", "export const CLOSEOUT_STEPS");
const closeout = block(dispatch, "export const CLOSEOUT_STEPS", "export const PROGRESS_HINT");
const checkForTriage = block(server, "  check_for_triage: {", "inputSchema");
const updateTask = block(server, "  update_task: {", "  create_task: {");
const instructions = block(server, "export const SERVER_INSTRUCTIONS", "`;");

test("TRIAGE_STEPS step 4 sets depends_on and plan and leaves the description alone", () => {
  const step4 = triageSteps.split("\n").find((l) => l.includes("4. Turn"));
  assert.ok(step4, "step 4 exists");
  assert.match(step4, /\\?`depends_on\\?`/);
  assert.match(step4, /\\?`plan\\?` summarising the plan/);
  assert.match(step4, /Leave the description as the reporter wrote it/);
  assert.doesNotMatch(step4, /a description summarising/);
});

test("the editable-fields line no longer lists description for a triager", () => {
  const line = triageSteps.split("\n").find((l) => l.includes("Until you call complete_task"));
  assert.ok(line);
  const fields = line.slice(line.indexOf(":") + 1);
  assert.doesNotMatch(fields.split(".")[0], /description/);
  assert.match(line, /except its description/);
  assert.match(fields, /plan/);
});

test("no triage or close-out text tells a triager to write or rewrite the description", () => {
  for (const [name, text] of [["TRIAGE_STEPS", triageSteps], ["CLOSEOUT_STEPS", closeout], ["check_for_triage", checkForTriage], ["SERVER_INSTRUCTIONS", instructions]]) {
    // The pre-VEC-403 wordings that sent triagers to the description.
    assert.doesNotMatch(text, /a description summarising|so it can rewrite it|like its creator: title, description|like its creator \(not archive it\)/i, name);
  }
  assert.match(checkForTriage, /update_task \\?`plan\\?`/);
  assert.match(instructions, /\\?`plan\\?` \(update_task; never rewrite its description/);
});

test("update_task exposes plan, maps it to triagePlan and says triagers use it", () => {
  assert.match(updateTask, /plan: \{ type: \["string", "null"\]/);
  assert.match(updateTask, /triagePlan: args\.plan === undefined/);
  assert.match(updateTask, /While you're triaging a task, set `plan`, not `description`/);
});
