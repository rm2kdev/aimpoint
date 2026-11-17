// Run with `pnpm test` (node --test; Node strips the TypeScript types of flow-model.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FLOW_STEPS, defaultFlowSteps, pinStepsToProject, resolveFlowSteps, resolveStepStatus, validateFlow } from "./flow-model.ts";

const S = (id, name, category, order) => ({ id, name, category, order });
// The standard project status set (lib/data.ts DEFAULT_STATUSES).
const std = [
  S("s0", "Backlog", "backlog", 0),
  S("s1", "Triage", "triage", 1),
  S("s2", "Todo", "unstarted", 2),
  S("s3", "In Progress", "started", 3),
  S("s4", "In Review", "started", 4),
  S("s5", "Done", "done", 5),
  S("s6", "Cancelled", "cancelled", 6),
];
const BOT = "b".repeat(24);
const BOT2 = "c".repeat(24);
const PERSON = "a".repeat(24);
const dir = { bots: new Map([[BOT, "Hermes"], [BOT2, "Testing Verification"]]), people: new Map([[PERSON, "Sofia Ortega"]]) };
const meta = { source: "org", version: 1 };
let n = 0;
const newId = () => `gen${++n}`;

/* ---------------- resolution ---------------- */

test("default flow maps onto a standard project by preferred name", () => {
  const r = resolveFlowSteps(defaultFlowSteps(), std, dir, meta);
  assert.deepEqual(r.steps.map((s) => [s.id, s.status.name, s.owner.kind, s.required]), [
    ["triage", "Triage", "triage", true],
    ["build", "Todo", "keep", true],
    ["review", "In Review", "keep", false],
    ["done", "Done", "none", true],
  ]);
  assert.equal(r.hasIssues, false);
  assert.equal(r.skipped.length, 0);
});

test("default flow on renamed statuses falls back to the stage's first status", () => {
  const renamed = std.map((s) => (s.id === "s4" ? { ...s, name: "QA" } : s.id === "s5" ? { ...s, name: "Shipped" } : s));
  const r = resolveFlowSteps(defaultFlowSteps(), renamed, dir, meta);
  assert.equal(r.steps.find((s) => s.id === "review").status.name, "In Progress");
  assert.equal(r.steps.find((s) => s.id === "done").status.name, "Shipped");
});

test("a project with no started status skips the review step", () => {
  const noStarted = std.filter((s) => s.category !== "started");
  const r = resolveFlowSteps(defaultFlowSteps(), noStarted, dir, meta);
  assert.deepEqual(r.steps.map((s) => s.id), ["triage", "build", "done"]);
  assert.equal(r.skipped[0].id, "review");
  assert.equal(r.skipped[0].issues[0].code, "stage_missing");
  assert.equal(r.hasIssues, true);
});

test("a project step whose status was deleted falls back by stage/name and is flagged", () => {
  const steps = [
    { id: "a", name: "Test", status: { statusId: "gone", stage: "started", name: "Testing" }, owner: { kind: "bot", id: BOT2 }, advance: "complete" },
    { id: "z", name: "Done", status: { statusId: "s5", stage: "done" }, owner: { kind: "none" }, advance: "complete" },
  ];
  const r = resolveFlowSteps(steps, std, dir, { source: "project", version: 3 });
  assert.equal(r.steps[0].status.id, "s3");
  assert.equal(r.steps[0].issues[0].code, "status_deleted");
  assert.match(r.steps[0].issues[0].message, /Testing was deleted; using In Progress/);
  // The stored form after the delete hook (stage + name + deleted flag) resolves the same way.
  const after = resolveFlowSteps([{ ...steps[0], status: { stage: "started", name: "In Review", deleted: true } }, steps[1]], std, dir, meta);
  assert.equal(after.steps[0].status.id, "s4");
  assert.equal(after.steps[0].issues[0].code, "status_deleted");
});

test("a status in another project counts as deleted (never crosses projects)", () => {
  const { status, issue } = resolveStepStatus({ statusId: "other-project-status", stage: "unstarted" }, std);
  assert.equal(status.id, "s2");
  assert.equal(issue.code, "status_deleted");
});

test("removed bots/people become unowned and are flagged; resolvers are dropped", () => {
  const steps = [
    { id: "a", name: "Dev", status: { statusId: "s2", stage: "unstarted" }, owner: { kind: "bot", id: "d".repeat(24) }, advance: "complete" },
    { id: "b", name: "Sign-off", status: { statusId: "s4", stage: "started" }, owner: { kind: "none", removed: { kind: "person", name: "Mia" } }, advance: "manual" },
    { id: "c", name: "Wait", status: { statusId: "s3", stage: "started" }, owner: { kind: "bot", id: BOT }, advance: "wait", wait: { label: "Reply", resolvers: [BOT, "e".repeat(24)], remindAfterDays: 5 } },
    { id: "z", name: "Done", status: { statusId: "s5", stage: "done" }, owner: { kind: "person", id: PERSON }, advance: "complete" },
  ];
  const r = resolveFlowSteps(steps, std, dir, meta);
  assert.deepEqual(r.steps[0].owner, { kind: "none" });
  assert.equal(r.steps[0].issues[0].code, "owner_removed");
  assert.match(r.steps[1].issues[0].message, /Mia was removed/);
  assert.deepEqual(r.steps[2].wait, { label: "Reply", resolvers: [BOT], remindAfterDays: 5 });
  assert.equal(r.steps[2].issues[0].code, "resolver_removed");
  assert.deepEqual(r.steps[3].owner, { kind: "person", id: PERSON });
});

test("resolution never throws on garbage and drops bad jumps / steps after done", () => {
  const junk = [
    null,
    { id: "x", name: "", status: { stage: "nope" }, owner: { kind: "alien" }, advance: "fly", next: "missing" },
    { id: "d", name: "Done", status: { stage: "done" }, owner: { kind: "none" }, advance: "complete", next: "x" },
    { id: "after", name: "After", status: { stage: "started" }, owner: { kind: "keep" }, advance: "complete" },
    { id: "can", name: "Cancel", status: { stage: "cancelled" }, owner: { kind: "keep" }, advance: "complete" },
    { id: "t", name: "Wrong triage", status: { stage: "unstarted" }, owner: { kind: "triage" }, advance: "complete" },
  ];
  const r = resolveFlowSteps(junk, std, dir, meta);
  assert.deepEqual(r.steps.map((s) => s.id), ["x", "d"]);
  assert.equal(r.steps[0].advance, "complete");
  assert.equal(r.steps[0].owner.kind, "none");
  assert.equal(r.steps[0].next, null);
  assert.equal(r.steps[1].next, null);
  assert.deepEqual(r.skipped.map((s) => s.id).sort(), ["after", "can", "t"].sort());
  assert.doesNotThrow(() => resolveFlowSteps(undefined, [], dir, meta));
  assert.deepEqual(resolveFlowSteps(defaultFlowSteps(), [], dir, meta).steps, []);
});

test("triage owner off a triage step resolves as keep", () => {
  const steps = [
    { id: "t", name: "Todo", status: { statusId: "s2", stage: "unstarted" }, owner: { kind: "triage" }, advance: "complete" },
    { id: "z", name: "Done", status: { statusId: "s5", stage: "done" }, owner: { kind: "none" }, advance: "complete" },
  ];
  const r = resolveFlowSteps(steps, std, dir, meta);
  assert.deepEqual(r.steps[0].owner, { kind: "keep" });
  assert.equal(r.steps[0].issues[0].code, "owner_invalid");
});

test("pinStepsToProject copies the resolved default with exact status ids, and that validates as a project flow", () => {
  const pinned = pinStepsToProject(resolveFlowSteps(defaultFlowSteps(), std, dir, meta));
  assert.deepEqual(pinned.map((s) => s.status.statusId), ["s1", "s2", "s4", "s5"]);
  const v = validateFlow(pinned, { level: "project", statuses: std, dir, newId });
  assert.equal(v.ok, true, JSON.stringify(v));
});

/* ---------------- validation ---------------- */

const devFlow = () => [
  { id: "tri", name: "Triage", status: { statusId: "s1" }, owner: { kind: "triage" }, advance: "complete" },
  { id: "dev", name: "Develop", status: { statusId: "s2" }, owner: { kind: "bot", id: BOT }, instructions: "Implement it.", advance: "complete" },
  { id: "test", name: "Test", status: { statusId: "s4" }, owner: { kind: "bot", id: BOT2 }, advance: "complete" },
  { id: "done", name: "Done", status: { statusId: "s5" }, owner: { kind: "none" }, advance: "complete" },
];

test("default flow is valid at org level and unchanged by normalisation", () => {
  const v = validateFlow(structuredClone(DEFAULT_FLOW_STEPS), { level: "org", dir, newId });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.deepEqual(v.steps.map((s) => s.id), ["triage", "build", "review", "done"]);
  assert.equal(v.steps[2].required, false);
});

test("a project dev pipeline validates; stage and name come from the project's status", () => {
  const v = validateFlow(devFlow(), { level: "project", statuses: std, dir, newId });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.deepEqual(v.steps[2].status, { statusId: "s4", stage: "started", name: "In Review" });
  assert.equal(v.steps[1].instructions, "Implement it.");
  assert.equal(v.steps[1].required, true);
});

test("missing ids are generated; duplicates refused", () => {
  const f = devFlow();
  delete f[1].id;
  const v = validateFlow(f, { level: "project", statuses: std, dir, newId });
  assert.equal(v.ok, true);
  assert.match(v.steps[1].id, /^gen\d+$/);
  const dup = devFlow();
  dup[2].id = "dev";
  assert.equal(validateFlow(dup, { level: "project", statuses: std, dir, newId }).ok, false);
});

const errorsOf = (steps, ctx = { level: "project", statuses: std, dir, newId }) => {
  const v = validateFlow(steps, ctx);
  assert.equal(v.ok, false, "expected a refusal");
  return v.errors.join(" | ");
};

test("project steps must use the project's own statuses, never cancelled", () => {
  const f = devFlow();
  f[1].status = { statusId: "other-project" };
  assert.match(errorsOf(f), /Develop: pick one of this project's statuses/);
  const g = devFlow();
  g[2].status = { statusId: "s6" };
  assert.match(errorsOf(g), /Cancelled is a cancelled status/);
});

test("owners must be org bots or members; triage owner only on triage steps", () => {
  const f = devFlow();
  f[1].owner = { kind: "bot", id: "f".repeat(24) };
  f[2].owner = { kind: "person", id: BOT };
  f[3].owner = { kind: "triage" };
  const e = errorsOf(f);
  assert.match(e, /Develop: its bot isn't one of this organisation's bots/);
  assert.match(e, /Test: its owner isn't a member/);
  assert.match(e, /Done: "Any triage bot" can only own a triage step/);
});

test("structure: last step done, nothing after done, at least one and at most 20 steps", () => {
  const f = devFlow();
  f.pop();
  assert.match(errorsOf(f), /last step must be a done step/);
  const g = devFlow();
  g.push({ id: "x", name: "After", status: { statusId: "s3" }, owner: { kind: "keep" }, advance: "complete" });
  assert.match(errorsOf(g), /Done: nothing can come after a done step/);
  assert.match(errorsOf([]), /at least one step/);
  const many = Array.from({ length: 21 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, status: { statusId: "s2" }, owner: { kind: "keep" }, advance: "complete" }));
  assert.match(errorsOf(many), /at most 20 steps/);
  assert.match(errorsOf("nope"), /list of steps/);
});

test("wait settings only on wait steps; labels, resolvers and reminders checked", () => {
  const f = devFlow();
  f[2] = { ...f[2], advance: "wait", wait: { label: "", resolvers: ["f".repeat(24)], remindAfterDays: 0 } };
  const e = errorsOf(f);
  assert.match(e, /Test: a wait step needs a label/);
  assert.match(e, /wait resolver isn't one of this organisation's bots/);
  assert.match(e, /reminders are 1-365 days/);
  const g = devFlow();
  g[1].wait = { label: "x" };
  assert.match(errorsOf(g), /Develop: only a wait step has wait settings/);
  const ok = devFlow();
  ok[2] = { ...ok[2], advance: "wait", wait: { label: "Reply received", resolvers: [BOT, BOT], remindAfterDays: 5 } };
  const v = validateFlow(ok, { level: "project", statuses: std, dir, newId });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.deepEqual(v.steps[2].wait, { label: "Reply received", resolvers: [BOT], remindAfterDays: 5 });
});

test("jumps must point at another existing step; done can't jump", () => {
  const f = devFlow();
  f[1].next = "nowhere";
  f[2].next = "test";
  f[3].next = "dev";
  const e = errorsOf(f);
  assert.match(e, /Develop: its jump target isn't a step/);
  assert.match(e, /Test: can't jump to itself/);
  assert.match(e, /Done: the done step ends the flow/);
  const back = devFlow();
  back[2].next = "dev";
  assert.equal(validateFlow(back, { level: "project", statuses: std, dir, newId }).ok, true);
});

test("consecutive identical steps (same status and owner) are refused", () => {
  const f = devFlow();
  f.splice(2, 0, { id: "dev2", name: "Develop more", status: { statusId: "s2" }, owner: { kind: "bot", id: BOT }, advance: "complete" });
  assert.match(errorsOf(f), /Develop more: has the same status and owner as Develop/);
});

test("org level: stage required, cancelled refused, names length-checked", () => {
  const ctx = { level: "org", dir, newId };
  const f = defaultFlowSteps();
  f[1].status = { stage: "bogus" };
  f[2].status = { stage: "cancelled" };
  f[0].name = "x".repeat(61);
  const e = errorsOf(f, ctx);
  assert.match(e, /Build: pick a stage/);
  assert.match(e, /Review: cancelled can't be a step/);
  assert.match(e, /names are up to 60 characters/);
  const g = defaultFlowSteps();
  g[1].instructions = "y".repeat(4001);
  assert.match(errorsOf(g, ctx), /instructions are up to 4,000 characters/);
});
