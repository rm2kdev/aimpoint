// Run with `pnpm test` (node --test). The bot enabled/disabled helpers (VEC-343).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isBotEnabled,
  enabledBots,
  botEnabledUpdate,
  botEnabledFlipFilter,
  ENABLED_BOT_FILTER,
  DISABLED_BOT_FILTER,
  disabledKeyMessage,
  disabledAssigneeMessage,
  disabledWakeMessage,
  listedToAgents,
  triageOrder,
  BOT_ENABLED_HISTORY_MAX,
  newlyDisabledStepOwners,
  disabledStepOwnerMessage,
  disabledRetryWhy,
  disabledResumeNote,
  heldMentionsOf,
} from "./bot-enabled.ts";

test("a bot doc without disabledAt (created before VEC-343) reads as enabled", () => {
  assert.equal(isBotEnabled({ name: "Old bot" }), true);
  assert.equal(isBotEnabled({ disabledAt: undefined }), true);
  assert.equal(isBotEnabled({ disabledAt: null }), true);
});

test("a bot doc with disabledAt is disabled (Date or ISO string)", () => {
  assert.equal(isBotEnabled({ disabledAt: new Date() }), false);
  assert.equal(isBotEnabled({ disabledAt: "2026-11-21T01:00:00.000Z" }), false);
});

test("the client Bot view's enabled flag wins", () => {
  assert.equal(isBotEnabled({ enabled: true, disabledAt: null }), true);
  assert.equal(isBotEnabled({ enabled: false, disabledAt: "2026-11-21T01:00:00.000Z" }), false);
});

test("a missing bot is never enabled", () => {
  assert.equal(isBotEnabled(null), false);
  assert.equal(isBotEnabled(undefined), false);
});

test("enabledBots keeps order and drops disabled ones", () => {
  const list = [{ id: "a" }, { id: "b", disabledAt: new Date() }, { id: "c", disabledAt: null }, { id: "d", enabled: false }];
  assert.deepEqual(enabledBots(list).map((b) => b.id), ["a", "c"]);
});

test("Mongo fragments: null matches missing and null; the complement is $ne null", () => {
  assert.deepEqual(ENABLED_BOT_FILTER, { disabledAt: null });
  assert.deepEqual(DISABLED_BOT_FILTER, { disabledAt: { $ne: null } });
});

test("botEnabledUpdate stamps on disable and clears on enable", () => {
  const now = new Date("2026-11-21T01:00:00.000Z");
  assert.deepEqual(botEnabledUpdate(false, "admin-1", now).$set, { disabledAt: now, disabledBy: "admin-1" });
  assert.deepEqual(botEnabledUpdate(true, "admin-1", now).$set, { disabledAt: null, disabledBy: null });
});

test("a flip only matches a bot in the other state", () => {
  assert.deepEqual(botEnabledFlipFilter(false), ENABLED_BOT_FILTER);
  assert.deepEqual(botEnabledFlipFilter(true), DISABLED_BOT_FILTER);
});

/* ---------------- enforcement helpers (VEC-344) ---------------- */

// Stand-in for an ObjectId: only `equals` is used.
const id = (s) => ({ s, equals: (o) => !!o && o.s === s });

test("a disabled key gets the org-named message", () => {
  assert.equal(disabledKeyMessage("Northwind Labs"), "This bot is disabled in Northwind Labs; an admin can re-enable it in Settings > Bots.");
});

test("assigning a disabled bot names the bot and the org", () => {
  const m = disabledAssigneeMessage("Triage Bot", "Northwind Labs");
  assert.match(m, /^Triage Bot is disabled in Northwind Labs, so it can't be assigned tasks\./);
  assert.match(disabledWakeMessage("Hermes"), /^Hermes is disabled/);
});

test("agents aren't listed disabled bots; people and enabled bots stay, order kept", () => {
  const people = [
    { id: "u1", kind: "user", name: "Mia" },
    { id: "b1", kind: "bot", name: "Hermes" },
    { id: "b2", kind: "bot", name: "Old bot", disabled: true },
    { id: "u2", kind: "user", name: "Sofia", disabled: true }, // only bots are filtered
  ];
  assert.deepEqual(listedToAgents(people).map((p) => p.id), ["u1", "b1", "u2"]);
  assert.deepEqual(listedToAgents([]), []);
});

test("triage skips disabled triagers and goes to the next enabled one", () => {
  const a = { _id: id("a"), disabledAt: new Date() };
  const b = { _id: id("b"), disabledAt: null };
  const c = { _id: id("c") };
  const r = triageOrder([a, b, c]);
  assert.deepEqual(r.order.map((x) => x._id.s), ["b", "c"]);
  assert.equal(r.waiting, false);
});

test("triage: the preferred (resumed) triager goes first only while enabled", () => {
  const a = { _id: id("a") };
  const b = { _id: id("b") };
  assert.deepEqual(triageOrder([a, b], { prefer: id("b") }).order.map((x) => x._id.s), ["b", "a"]);
  const bOff = { _id: id("b"), disabledAt: new Date() };
  assert.deepEqual(triageOrder([a, bOff], { prefer: id("b") }).order.map((x) => x._id.s), ["a"]);
});

test("triage: only disabled triagers left means the task waits; none at all is not 'waiting'", () => {
  const off = { _id: id("a"), disabledAt: new Date() };
  assert.deepEqual(triageOrder([off]), { order: [], waiting: true });
  assert.deepEqual(triageOrder([]), { order: [], waiting: false });
  // The creator is excluded first: an enabled creator doesn't count as an available triager.
  const creator = { _id: id("me") };
  assert.deepEqual(triageOrder([creator, off], { exclude: id("me") }), { order: [], waiting: true });
  assert.deepEqual(triageOrder([creator], { exclude: id("me") }), { order: [], waiting: false });
});

/* ---------------- server gaps (VEC-352) ---------------- */

test("every toggle appends {enabled, at, by} to enabledHistory, capped at the last 20", () => {
  const now = new Date("2026-11-21T02:00:00.000Z");
  assert.equal(BOT_ENABLED_HISTORY_MAX, 20);
  assert.deepEqual(botEnabledUpdate(false, "admin-1", now).$push, { enabledHistory: { $each: [{ enabled: false, at: now, by: "admin-1" }], $slice: -20 } });
  assert.deepEqual(botEnabledUpdate(true, "admin-2", now).$push, { enabledHistory: { $each: [{ enabled: true, at: now, by: "admin-2" }], $slice: -20 } });
});

test("$slice -20 keeps the newest 20 toggles (simulated push)", () => {
  let history = [];
  for (let i = 0; i < 25; i++) {
    const { $push } = botEnabledUpdate(i % 2 === 1, `a${i}`, new Date(Date.UTC(2026, 10, 21, 0, i)));
    history = [...history, ...$push.enabledHistory.$each].slice($push.enabledHistory.$slice);
  }
  assert.equal(history.length, 20);
  assert.equal(history[0].by, "a5");
  assert.equal(history[19].by, "a24");
});

const off = new Map([["bot-off", "Old Bot"]]);
const step = (id, owner, name = id) => ({ id, name, owner });

test("a step newly given a disabled bot is reported; one that already had it is not", () => {
  const prev = [step("build", { kind: "bot", id: "bot-off" }, "Build"), step("review", { kind: "keep" }, "Review")];
  // unchanged: kept
  assert.deepEqual(newlyDisabledStepOwners(prev, prev, off), []);
  // renamed + reordered: still the same step id, kept
  assert.deepEqual(newlyDisabledStepOwners(prev, [step("review", { kind: "keep" }), step("build", { kind: "bot", id: "bot-off" }, "Make it")], off), []);
  // review newly owned by the disabled bot: refused
  assert.deepEqual(newlyDisabledStepOwners(prev, [prev[0], step("review", { kind: "bot", id: "bot-off" }, "Review")], off), [
    { index: 1, step: "Review", botId: "bot-off", bot: "Old Bot" },
  ]);
  // a brand-new step (new id) with it: refused, unnamed falls back to its position
  assert.deepEqual(newlyDisabledStepOwners(prev, [...prev, step("new1", { kind: "bot", id: "bot-off" }, "  ")], off), [
    { index: 2, step: "Step 3", botId: "bot-off", bot: "Old Bot" },
  ]);
  // an enabled bot or another owner kind is never reported
  assert.deepEqual(newlyDisabledStepOwners([], [step("x", { kind: "bot", id: "bot-on" }), step("y", { kind: "person", id: "bot-off" })], off), []);
});

test("disabled step owner / retry / resume messages name the bot", () => {
  assert.equal(
    disabledStepOwnerMessage("Review", "Old Bot", "Northwind Labs"),
    "Review: Old Bot is disabled in Northwind Labs, so it can't own flow steps. An admin can re-enable it in Settings > Bots.",
  );
  assert.match(disabledRetryWhy("Old Bot"), /^Old Bot is disabled, so it can't be handed work/);
  assert.match(disabledResumeNote("Old Bot", "assigned"), /^Old Bot is disabled, so it won't be woken until it's enabled/);
  assert.match(disabledResumeNote("Old Bot", "triage"), /next enabled triage bot/);
});

test("heldMentionsOf lists only the disabled bots, by id and name", () => {
  const bots = [
    { _id: "b1", name: "On", disabledAt: null },
    { _id: "b2", name: "Off", disabledAt: new Date() },
    { _id: "b3", name: "Legacy" },
  ];
  assert.deepEqual(heldMentionsOf(bots, (b) => b._id), [{ id: "b2", name: "Off" }]);
  assert.deepEqual(heldMentionsOf([], (b) => b._id), []);
});
