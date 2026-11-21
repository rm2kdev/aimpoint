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
