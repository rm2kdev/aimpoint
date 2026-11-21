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
  assert.deepEqual(botEnabledUpdate(false, "admin-1", now), { $set: { disabledAt: now, disabledBy: "admin-1" } });
  assert.deepEqual(botEnabledUpdate(true, "admin-1", now), { $set: { disabledAt: null, disabledBy: null } });
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
