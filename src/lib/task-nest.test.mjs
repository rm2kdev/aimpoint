// Run with `pnpm test`. VEC-448: dwell-to-nest plumbing. The nest zone on a sortable row (nestZoneAt, nestGap in
// reorder.ts), the shared timings (task-drag.ts), the client-side nest rule (canNestOnto in parent-link-core.ts,
// mirroring the server's planParentChange / checkParentLink and taskAccess "full"), and the provider call sites.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NEST_BAND, nestGap, nestZoneAt } from "./reorder.ts";
import { NEST_BLINK_MS, NEST_DWELL_MS, NEST_ZONE_BAND, SPRING_BLINK_MS, SPRING_DELAY_MS } from "./task-drag.ts";
import { canNestOnto, planParentChange } from "./parent-link-core.ts";
import { taskAccess } from "./access.ts";

// Three 40 px rows with 2 px between them.
const rows = [
  { start: 0, end: 40 },
  { start: 42, end: 82 },
  { start: 84, end: 124 },
];

test("nestZoneAt with zone(i): the band applies to the row's zone part, asked only for the row under pos (VEC-449)", () => {
  // Row 0 is an expanded parent: 40 px parent row + two 36 px sub-task rows in one 120 px item.
  const group = [{ start: 0, end: 120 }, { start: 122, end: 162 }];
  const asked = [];
  const zone = (i) => (asked.push(i), i === 0 ? { start: 0, end: 40 } : group[i]);
  assert.equal(nestZoneAt(group, 20, 0.5, -1, zone), 0); // middle of the parent row
  assert.equal(nestZoneAt(group, 60, 0.5, -1, zone), -1); // the whole item's middle is a sub-task row: no zone
  assert.equal(nestZoneAt(group, 5, 0.5, -1, zone), -1); // parent row's top edge
  assert.equal(nestZoneAt(group, 142, 0.5, -1, zone), 1); // plain row: its own span
  assert.equal(nestZoneAt(group, 142, 0.5, 1, zone), -1); // skipped (lifted)
  assert.deepEqual([...new Set(asked)].sort(), [0, 1]); // never asked for rows away from pos
  asked.length = 0;
  nestZoneAt(group, 20, 0.5, -1, zone);
  assert.deepEqual(asked, [0]);
});

test("nestZoneAt: the middle half of a row is its nest zone, the edges are not", () => {
  assert.equal(nestZoneAt(rows, 20), 0);
  assert.equal(nestZoneAt(rows, 10), 0); // inset 10: zone is [10, 30]
  assert.equal(nestZoneAt(rows, 30), 0);
  assert.equal(nestZoneAt(rows, 9.9), -1); // top edge: reorder
  assert.equal(nestZoneAt(rows, 30.1), -1); // bottom edge: reorder
  assert.equal(nestZoneAt(rows, 41), -1); // between rows
  assert.equal(nestZoneAt(rows, 62), 1);
  assert.equal(nestZoneAt(rows, 104), 2);
  assert.equal(nestZoneAt(rows, -5), -1);
  assert.equal(nestZoneAt(rows, 200), -1);
  assert.equal(nestZoneAt([], 10), -1);
});

test("nestZoneAt: band widens or narrows the zone; 0 turns it off, 1 is the whole row", () => {
  assert.equal(nestZoneAt(rows, 5, 0.8), 0); // inset 4
  assert.equal(nestZoneAt(rows, 3, 0.8), -1);
  assert.equal(nestZoneAt(rows, 20, 0), -1);
  assert.equal(nestZoneAt(rows, 0, 1), 0);
  assert.equal(nestZoneAt(rows, 40, 1), 0);
  assert.equal(nestZoneAt(rows, 20, 7), 0); // clamped to 1
  assert.equal(nestZoneAt(rows, 20, -1), -1); // clamped to 0
});

test("nestZoneAt: the lifted row is skipped, and shifted spans are used as given", () => {
  assert.equal(nestZoneAt(rows, 62, NEST_BAND, 1), -1);
  assert.equal(nestZoneAt(rows, 20, NEST_BAND, 1), 0);
  // Row 1 shown 42 px lower (a gap opened above it): its zone moves with it.
  const shifted = [rows[0], { start: 84, end: 124 }, { start: 126, end: 166 }];
  assert.equal(nestZoneAt(shifted, 62), -1);
  assert.equal(nestZoneAt(shifted, 104), 1);
  // A zero-height row never matches.
  assert.equal(nestZoneAt([{ start: 10, end: 10 }], 10), -1);
});

test("nestGap: the gap on a nest zone keeps the last gap on the list, or opens right after the row", () => {
  // Already on this list: whatever gap put the row where the pointer found it stays (crossing the middle flips nothing).
  assert.equal(nestGap({ gap: 1 }, 1), 1);
  assert.equal(nestGap({ gap: 2 }, 1), 2);
  assert.equal(nestGap({ gap: 0 }, 3), 0);
  // From another list or a target: right after the row.
  assert.equal(nestGap(null, 0), 1);
  assert.equal(nestGap(null, 4), 5);
});

// The provider's row shifts for a gap (applyGaps' want()), to prove nestGap never moves the target row.
const shiftFor = (i, from, gap, H = 44) => {
  if (from < 0) return gap !== null && i >= gap ? H : 0;
  if (gap === null) return i > from ? -H : 0;
  if (gap === from || gap === from + 1) return 0;
  if (i >= gap && i < from) return H;
  if (i > from && i < gap) return -H;
  return 0;
};

test("nestGap: entering from elsewhere leaves the target row where it shows, in its own list or another", () => {
  for (const from of [-1, 0, 2, 5]) {
    for (let row = 0; row < 6; row++) {
      if (row === from) continue;
      // Before: card elsewhere (foreign list: no gap; own list: the slot closed up).
      const before = shiftFor(row, from, null);
      const after = shiftFor(row, from, nestGap(null, row));
      assert.equal(after, before, `from ${from} row ${row}`);
    }
  }
});

test("task-drag: nest timings reuse the spring-loading ones; the zone is the middle half", () => {
  assert.equal(NEST_DWELL_MS, SPRING_DELAY_MS);
  assert.equal(NEST_BLINK_MS, SPRING_BLINK_MS);
  assert.equal(NEST_ZONE_BAND, 0.5);
  assert.equal(NEST_ZONE_BAND, NEST_BAND);
});

// ---- canNestOnto ---------------------------------------------------------------------------

const ME = { id: "me", isAdmin: false };
const ADMIN = { id: "boss", isAdmin: true };
const dragged = (over = {}) => ({ id: "d", key: "VEC-1", parentId: null, parentKey: null, hasChildren: false, archived: false, createdBy: "me", ...over });
const top = (id, key = id.toUpperCase(), over = {}) => ({ id, key, parentId: null, parentKey: null, archived: false, ...over });
const sub = (id, parentId, key = id.toUpperCase(), parentKey = parentId.toUpperCase()) => ({ id, key, parentId, parentKey, archived: false });

test("canNestOnto: a top-level task onto a top-level task", () => {
  assert.deepEqual(canNestOnto(dragged(), top("p", "VEC-10"), ME), { ok: true, parentId: "p", parentKey: "VEC-10" });
});

test("canNestOnto: only the creator or an admin, the same rule as taskAccess full", () => {
  assert.deepEqual(canNestOnto(dragged({ createdBy: "someone" }), top("p"), ME).reason, "no-access");
  assert.equal(canNestOnto(dragged({ createdBy: "someone" }), top("p"), ADMIN).ok, true);
  for (const [createdBy, actor] of [["me", ME], ["x", ME], ["x", ADMIN], ["boss", { id: "boss", isAdmin: false }]]) {
    const full = taskAccess({ createdBy, assigneeId: actor.id }, actor.id, actor.isAdmin) === "full";
    assert.equal(canNestOnto(dragged({ createdBy }), top("p"), actor).ok, full, `${createdBy} by ${actor.id}`);
  }
});

test("canNestOnto: refuses itself, an archived task, and its own sub-task", () => {
  assert.equal(canNestOnto(dragged(), top("d", "VEC-1"), ME).reason, "self");
  assert.equal(canNestOnto(dragged({ archived: true }), top("p"), ME).reason, "archived");
  const own = canNestOnto(dragged({ hasChildren: true }), sub("c", "d", "VEC-2", "VEC-1"), ME);
  assert.equal(own.ok, false);
  assert.equal(own.reason, "cycle");
});

test("canNestOnto: onto its current parent, or a sibling (which flattens there), is a no-op", () => {
  const d = dragged({ parentId: "p", parentKey: "VEC-10" });
  const r = canNestOnto(d, top("p", "VEC-10"), ME);
  assert.equal(r.reason, "current-parent");
  assert.match(r.error, /already a sub-task of VEC-10/);
  assert.equal(canNestOnto(d, sub("s", "p", "VEC-11", "VEC-10"), ME).reason, "current-parent");
  // Server agrees: no change.
  assert.deepEqual(planParentChange({ id: "d", key: "VEC-1", parentId: "p", hasChildren: false }, { id: "p", key: "VEC-10", parentId: null, archived: false }), { ok: true, change: null });
});

test("canNestOnto: a sub-task under another parent moves", () => {
  const d = dragged({ parentId: "p", parentKey: "VEC-10" });
  assert.deepEqual(canNestOnto(d, top("q", "VEC-20"), ME), { ok: true, parentId: "q", parentKey: "VEC-20" });
});

test("canNestOnto: a task with sub-tasks of its own can't become one", () => {
  const r = canNestOnto(dragged({ hasChildren: true }), top("p", "VEC-10"), ME);
  assert.equal(r.reason, "has-children");
  assert.match(r.error, /has sub-tasks of its own/);
});

test("canNestOnto: an archived target (or flattened parent) is refused", () => {
  assert.equal(canNestOnto(dragged(), top("p", "VEC-10", { archived: true }), ME).reason, "target-archived");
  const r = canNestOnto(dragged(), sub("s", "p", "VEC-11", "VEC-10"), ME, top("p", "VEC-10", { archived: true }));
  assert.equal(r.reason, "target-archived");
});

test("canNestOnto: a sub-task target flattens to its parent, as the server does", () => {
  const target = sub("s", "p", "VEC-11", "VEC-10");
  const r = canNestOnto(dragged(), target, ME);
  assert.deepEqual(r, { ok: true, parentId: "p", parentKey: "VEC-10", flattenedFrom: "VEC-11" });
  // Same as planParentChange with the root.
  const server = planParentChange(
    { id: "d", key: "VEC-1", parentId: null, hasChildren: false },
    { id: "s", key: "VEC-11", parentId: "p", parentKey: "VEC-10", archived: false },
    { id: "p", key: "VEC-10", parentId: null, archived: false },
  );
  assert.deepEqual(server, { ok: true, change: { from: null, to: "p", flattenedFrom: "VEC-11" } });
  // A root passed for another task is ignored; its key comes from the target.
  assert.deepEqual(canNestOnto(dragged(), target, ME, top("zz", "VEC-99")), { ok: true, parentId: "p", parentKey: "VEC-10", flattenedFrom: "VEC-11" });
});

test("canNestOnto agrees with planParentChange across a grid of cases", () => {
  const tasks = {
    p: top("p", "VEC-10"),
    q: top("q", "VEC-20"),
    a: top("a", "VEC-30", { archived: true }),
    s: sub("s", "p", "VEC-11", "VEC-10"),
    t: sub("t", "q", "VEC-21", "VEC-20"),
  };
  const draggeds = [dragged(), dragged({ parentId: "p", parentKey: "VEC-10" }), dragged({ hasChildren: true })];
  for (const d of draggeds) {
    for (const t of Object.values(tasks)) {
      const root = t.parentId ? tasks[t.parentId] : null;
      const mine = canNestOnto(d, t, ME, root);
      const server = planParentChange({ id: d.id, key: d.key, parentId: d.parentId, hasChildren: d.hasChildren }, t, root);
      const serverMoves = server.ok && server.change !== null;
      assert.equal(mine.ok, serverMoves, `${d.parentId ?? "top"}/${d.hasChildren} onto ${t.key}`);
      if (mine.ok) assert.equal(mine.parentId, server.change.to);
    }
  }
});

// ---- Provider call sites ---------------------------------------------------------------------

const provider = readFileSync(new URL("../components/ui/drag-provider.tsx", import.meta.url), "utf8");
const sortable = readFileSync(new URL("../components/ui/sortable-list.tsx", import.meta.url), "utf8");

test("provider: only an armed nest drops onto the row; an unarmed one is a plain move", () => {
  assert.match(provider, /if \(over\.nest && over\.nestArmed && reg\.nest\) \{[\s\S]*?reg\.nest\.onNest\(item, over\.nest\)/);
});

test("provider: the nest dwell is the generic hover keyed per row, so leaving the zone clears its timer", () => {
  assert.match(provider, /key: `nest:\$\{over\.listId\}:\$\{over\.nest\}`/);
  assert.match(provider, /if \(prevSpot\?\.key !== nextSpot\?\.key && prev\) \{\s*endHover\(prev\.item, false\)/);
  assert.match(provider, /if \(h\.timer\) clearTimeout\(h\.timer\)/);
});

test("provider: the zone is hit-tested on shifted rows with the lifted row skipped, and sticks the gap", () => {
  assert.match(provider, /nestZoneAt\(shown, pos, opts\.band, from, zone\)/);
  assert.match(provider, /nestGap\(prev, nest\.index\)/);
});

test("sortable-list: nest is opt-in and passed through to the registration", () => {
  assert.match(sortable, /nest\?: NestOptions/);
  assert.match(sortable, /nest: p\.nest,/);
});
