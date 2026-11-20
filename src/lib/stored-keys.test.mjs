// Run with `pnpm test` (node --test; Node strips the TypeScript types of stored-keys.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { adoptLegacyKey, storageKey } from "./stored-keys.ts";

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
  };
}

test("storageKey uses the aimpoint: prefix", () => {
  assert.equal(storageKey("view:/o/x/all"), "aimpoint:view:/o/x/all");
});

test("moves a legacy value to the new key and removes the old one", () => {
  const s = fakeStorage({ "vector:view:/o/northwind/all": '{"sort":"due","v":2}' });
  adoptLegacyKey(s, "aimpoint:view:/o/northwind/all");
  assert.equal(s.getItem("aimpoint:view:/o/northwind/all"), '{"sort":"due","v":2}');
  assert.equal(s.getItem("vector:view:/o/northwind/all"), null);
});

test("keeps an existing new value and still drops the legacy key", () => {
  const s = fakeStorage({ "vector:collapsed:/p": '{"a":true}', "aimpoint:collapsed:/p": '{"b":true}' });
  adoptLegacyKey(s, "aimpoint:collapsed:/p");
  assert.equal(s.getItem("aimpoint:collapsed:/p"), '{"b":true}');
  assert.equal(s.getItem("vector:collapsed:/p"), null);
});

test("idempotent: a second call changes nothing", () => {
  const s = fakeStorage({ "vector:install-dismissed": "1700000000000" });
  adoptLegacyKey(s, "aimpoint:install-dismissed");
  adoptLegacyKey(s, "aimpoint:install-dismissed");
  assert.deepEqual([...s.m.entries()], [["aimpoint:install-dismissed", "1700000000000"]]);
});

test("no legacy value: nothing written", () => {
  const s = fakeStorage();
  adoptLegacyKey(s, "aimpoint:new-bot-key:abc");
  assert.equal(s.m.size, 0);
});

test("ignores keys outside the aimpoint: namespace", () => {
  const s = fakeStorage({ "vector:x": "1" });
  adoptLegacyKey(s, "other:x");
  assert.equal(s.getItem("vector:x"), "1");
});

test("never throws when storage is blocked", () => {
  const blocked = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("x"); }, removeItem() { throw new Error("x"); } };
  assert.doesNotThrow(() => adoptLegacyKey(blocked, "aimpoint:view:/"));
});
