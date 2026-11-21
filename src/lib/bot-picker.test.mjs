// Run with `pnpm test` (node --test). Disabled bots in pickers and on tasks (VEC-345).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isBotDisabled,
  botPickerEntries,
  disabledBotNote,
  DISABLED_BOT_HINT,
  stepPickable,
  typedDisabledMentions,
  mergeHeldMentions,
  heldMentionsToast,
  enabledHistoryNewestFirst,
} from "./bot-picker.ts";
import { tasksBecomeUnassigned } from "./format.ts";

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

// VEC-353
test("stepPickable skips disabled entries and wraps", () => {
  const d = [false, true, false, true];
  assert.equal(stepPickable(d, -1, 1), 0);
  assert.equal(stepPickable(d, 0, 1), 2);
  assert.equal(stepPickable(d, 2, 1), 0);
  assert.equal(stepPickable(d, 0, -1), 2);
  assert.equal(stepPickable(d, -1, -1), 2);
  assert.equal(stepPickable([true, true], -1, 1), -1);
  assert.equal(stepPickable([], -1, 1), -1);
  assert.equal(stepPickable([false], 0, 1), 0);
});

test("typedDisabledMentions finds hand-typed names of disabled bots only", () => {
  const bots = [
    { id: "a", name: "Gap Probe", disabled: true },
    { id: "b", name: "Gap Probe 2", disabled: true },
    { id: "c", name: "Helper", disabled: false },
  ];
  assert.deepEqual(typedDisabledMentions("hey @gap probe 2 look", bots), [{ id: "b", name: "Gap Probe 2" }]);
  assert.deepEqual(typedDisabledMentions("@Gap Probe, and @Gap Probe 2.", bots).map((m) => m.id).sort(), ["a", "b"]);
  assert.deepEqual(typedDisabledMentions("@Helper and email x@Gap Probe", bots), []);
  assert.deepEqual(typedDisabledMentions("@Gap Prober", bots), []);
  assert.deepEqual(typedDisabledMentions("<@0123456789abcdef01234567> only tokens", bots), []);
});

test("mergeHeldMentions dedupes by id, first copy wins", () => {
  assert.deepEqual(mergeHeldMentions([{ id: "a", name: "A" }], [{ id: "a", name: "A2" }, { id: "b", name: "B" }]), [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ]);
});

test("heldMentionsToast wording", () => {
  assert.equal(heldMentionsToast([]), null);
  assert.equal(heldMentionsToast([], []), null);
  const one = heldMentionsToast([{ id: "a", name: "Gap Probe" }]);
  assert.equal(one.title, "Gap Probe is disabled and wasn't notified");
  assert.match(one.description, /hears about it once an admin enables it/);
  const typed = heldMentionsToast([], [{ id: "a", name: "Gap Probe" }]);
  assert.match(typed.description, /it isn't told about it/);
  // a bot both picked and typed counts as held
  assert.match(heldMentionsToast([{ id: "a", name: "A" }], [{ id: "a", name: "A" }]).description, /hears about it/);
  const three = heldMentionsToast([{ id: "a", name: "A" }], [{ id: "b", name: "B" }, { id: "c", name: "C" }]);
  assert.equal(three.title, "A, B and C are disabled and weren't notified");
  assert.match(three.description, /typed by hand never do/);
});

test("enabledHistoryNewestFirst picks the newer copy and sorts newest first", () => {
  const old = [{ enabled: false, at: "2026-11-21T01:00:00Z", by: "u" }];
  const cur = [...old, { enabled: true, at: "2026-11-21T02:00:00Z", by: "v" }];
  assert.deepEqual(enabledHistoryNewestFirst(old, cur).map((h) => h.enabled), [true, false]);
  assert.deepEqual(enabledHistoryNewestFirst(cur, old).map((h) => h.by), ["v", "u"]);
  assert.deepEqual(enabledHistoryNewestFirst(undefined, []), []);
});

test("tasksBecomeUnassigned pluralises the verb", () => {
  assert.equal(tasksBecomeUnassigned(1, "assigned"), "1 assigned task becomes unassigned");
  assert.equal(tasksBecomeUnassigned(2, "assigned"), "2 assigned tasks become unassigned");
  assert.equal(tasksBecomeUnassigned(1), "1 task becomes unassigned");
});
