// Run with `pnpm test` (node --test). Disabled bots in pickers and on tasks (VEC-345).
import { test } from "node:test";
import assert from "node:assert/strict";
import { isBotDisabled, botPickerEntries, disabledBotNote, DISABLED_BOT_HINT } from "./bot-picker.ts";

test("member shape: only disabled: true is disabled", () => {
  assert.equal(isBotDisabled({ id: "a", name: "A" }), false);
  assert.equal(isBotDisabled({ id: "a", name: "A", disabled: false }), false);
  assert.equal(isBotDisabled({ id: "a", name: "A", disabled: true }), true);
});

test("bot view shape: enabled wins", () => {
  assert.equal(isBotDisabled({ id: "a", name: "A", enabled: true }), false);
  assert.equal(isBotDisabled({ id: "a", name: "A", enabled: false }), true);
  assert.equal(isBotDisabled({ id: "a", name: "A", enabled: true, disabled: true }), false);
});

test("missing bot is not disabled", () => {
  assert.equal(isBotDisabled(undefined), false);
  assert.equal(isBotDisabled(null), false);
});

test("entries list enabled bots first, keeping order, and flag disabled ones", () => {
  const bots = [
    { id: "1", name: "Zed", disabled: true },
    { id: "2", name: "Hermes" },
    { id: "3", name: "Ava", disabled: true },
    { id: "4", name: "Bolt" },
  ];
  const out = botPickerEntries(bots);
  assert.deepEqual(out.map((e) => [e.bot.id, e.disabled]), [["2", false], ["4", false], ["1", true], ["3", true]]);
});

test("entries sort each part when asked, without mixing them", () => {
  const bots = [
    { id: "1", name: "Zed", disabled: true },
    { id: "2", name: "Hermes" },
    { id: "3", name: "Ava", disabled: true },
    { id: "4", name: "Bolt" },
  ];
  const out = botPickerEntries(bots, (a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(out.map((e) => e.bot.name), ["Bolt", "Hermes", "Ava", "Zed"]);
  assert.equal(bots[0].name, "Zed", "input not mutated");
});

test("note and hint name the bot", () => {
  assert.match(disabledBotNote("Triage Bot"), /^Triage Bot is disabled\./);
  assert.equal(DISABLED_BOT_HINT, "Disabled");
});
