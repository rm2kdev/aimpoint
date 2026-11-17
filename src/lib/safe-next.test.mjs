// Run with `pnpm test` (node --test; Node strips the TypeScript types of safe-next.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeNext } from "./safe-next.ts";

test("keeps same-origin paths", () => {
  for (const p of ["/", "/o/northwind/all", "/p/northwind/VEC?submit=1", "/p/a%20b/K?task=VEC-1&view=mine", "/a\\b", "/#x"]) {
    assert.equal(safeNext(p), p);
  }
});

test("refuses other hosts and odd values", () => {
  const bad = [
    undefined,
    null,
    "",
    "//evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "\\/evil.example",
    "https://evil.example",
    "http:evil.example",
    "javascript:alert(1)",
    "evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "/\r\n/evil.example",
    " //evil.example",
    "/%0A/x\u0000",
  ];
  for (const v of bad) assert.equal(safeNext(v), "/", JSON.stringify(v));
});
