// Run with `pnpm test` (node --test; Node strips the TypeScript types of seat-sync-core.ts / billing-core.ts).
// VEC-303: accepting an invite schedules a seat sync that updates the Stripe quantity with prorations; re-accepting
// doesn't; a failed update stays pending and is retried by the cheap sweep trigger.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSeatSync, joinMembership, SWEEP_SOON_GAP_MS } from "./seat-sync-core.ts";
import { billedSeatsFor, seatQuantity, seatsUpdatingTo } from "./billing-core.ts";

const ORG = "org1";
const PRICE = "price_seat";

/** In-memory world: memberships, seatSyncs rows, a fake Stripe subscription and deferred jobs. */
function world({ members = ["ryan"], quantity = 1, failUpdates = 0 } = {}) {
  const memberships = new Map(members.map((u) => [`${ORG}:${u}`, { orgId: ORG, userId: u }]));
  const rows = new Map();
  const sub = { id: "sub_1", items: { data: [{ id: "si_1", quantity, price: { id: PRICE } }] } };
  const updates = [];
  const jobs = [];
  let clock = Date.parse("2026-11-19T04:00:00Z");
  let failing = failUpdates;
  const store = {
    async markPending(orgId, now) {
      const r = rows.get(orgId);
      if (r) Object.assign(r, { rev: r.rev + 1, nextAt: now });
      else rows.set(orgId, { rev: 1, pendingSince: now, attempts: 0, lastError: null, nextAt: now });
    },
    async get(orgId) {
      const r = rows.get(orgId);
      return r ? { ...r } : null;
    },
    async clear(orgId, rev) {
      if (rows.get(orgId)?.rev === rev) rows.delete(orgId);
    },
    async fail(orgId, patch) {
      Object.assign(rows.get(orgId), patch);
    },
    async due(now, limit) {
      return [...rows].filter(([, r]) => r.nextAt <= now).slice(0, limit).map(([id]) => id);
    },
  };
  const stripe = {
    async retrieve(subId) {
      assert.equal(subId, sub.id);
      return structuredClone(sub);
    },
    async update(subId, params, opts) {
      if (failing > 0) {
        failing--;
        throw new Error("Stripe is down");
      }
      updates.push({ subId, params, opts });
      sub.items.data[0].quantity = params.items[0].quantity;
    },
  };
  const membershipCol = {
    async updateOne(filter, update, opts) {
      assert.equal(opts.upsert, true);
      const k = `${filter.orgId}:${filter.userId}`;
      if (memberships.has(k)) return { upsertedCount: 0 };
      memberships.set(k, update.$setOnInsert);
      return { upsertedCount: 1 };
    },
  };
  const logs = [];
  const seats = createSeatSync({
    store,
    key: (id) => id,
    enabled: () => true,
    liveSubscription: async () => sub.id,
    quantity: async (orgId) => seatQuantity([...memberships.values()].filter((m) => m.orgId === orgId).length),
    priceId: () => PRICE,
    stripe: () => stripe,
    defer: (job) => jobs.push(job),
    log: { info: (m) => logs.push(m), error: (m) => logs.push(m) },
    now: () => clock,
  });
  /** Runs the after() jobs, like Next does once the response is sent. */
  const flush = async () => {
    while (jobs.length) await jobs.shift()();
  };
  const accept = (userId) =>
    joinMembership(membershipCol, { orgId: ORG, userId, role: "member" }, () => seats.syncSoon(ORG, "invite accepted"));
  return { seats, rows, sub, updates, jobs, flush, accept, logs, tick: (ms) => (clock += ms) };
}

test("accepting an invite (new membership) schedules a sync that sets the new quantity with prorations", async () => {
  const w = world();
  assert.equal(await w.accept("mia"), true);
  assert.equal(w.jobs.length, 1, "the sync is deferred past the response (after())");
  assert.equal(w.updates.length, 0, "nothing reaches Stripe before the response is sent");
  await w.flush();
  assert.equal(w.updates.length, 1);
  const [u] = w.updates;
  assert.equal(u.subId, "sub_1");
  assert.deepEqual(u.params, { items: [{ id: "si_1", quantity: 2 }], proration_behavior: "create_prorations" });
  assert.match(u.opts.idempotencyKey, /^aimpoint-seats-sub_1-1-2-/);
  assert.equal(w.rows.size, 0, "the pending row is cleared after success");
  assert.ok(w.logs.some((l) => l.includes("quantity 1 -> 2")));
});

test("re-accepting an existing membership schedules nothing and doesn't touch Stripe", async () => {
  const w = world({ members: ["ryan", "mia"], quantity: 2 });
  assert.equal(await w.accept("mia"), false);
  assert.equal(w.jobs.length, 0);
  await w.flush();
  assert.equal(w.updates.length, 0);
  assert.equal(w.rows.size, 0);
});

test("a sync whose quantity already matches makes no update", async () => {
  const w = world({ members: ["ryan", "mia"], quantity: 2 });
  assert.equal(await w.seats.syncNow(ORG), "unchanged");
  assert.equal(w.updates.length, 0);
  assert.equal(w.rows.size, 0);
});

test("a failed update stays in seatSyncs and the throttled sweep retries it", async () => {
  const w = world({ failUpdates: 1 });
  await w.accept("mia");
  await w.flush();
  assert.equal(w.updates.length, 0);
  const row = w.rows.get(ORG);
  assert.ok(row, "row kept after the failure");
  assert.equal(row.attempts, 1);
  assert.equal(row.lastError, "Stripe is down");
  assert.ok(w.logs.some((l) => l.includes("failed, will retry")));

  // Not due yet (30 s backoff): a sweep does nothing.
  assert.equal(w.seats.sweepSoon("page"), true);
  await w.flush();
  assert.equal(w.updates.length, 0);

  // A page load within the gap doesn't sweep again; after the gap (and the backoff) it does and the update lands.
  w.tick(10_000);
  assert.equal(w.seats.sweepSoon("page"), false);
  w.tick(SWEEP_SOON_GAP_MS);
  assert.equal(w.seats.sweepSoon("webhook"), true);
  await w.flush();
  assert.equal(w.updates.length, 1);
  assert.equal(w.updates[0].params.items[0].quantity, 2);
  assert.equal(w.updates[0].params.proration_behavior, "create_prorations");
  assert.equal(w.rows.size, 0);
});

test("billing off: no sync, no sweep", async () => {
  const jobs = [];
  const seats = createSeatSync({
    store: {},
    key: (id) => id,
    enabled: () => false,
    liveSubscription: async () => null,
    quantity: async () => 1,
    priceId: () => PRICE,
    stripe: () => assert.fail("no Stripe with billing off"),
    defer: (job) => jobs.push(job),
  });
  seats.syncSoon(ORG);
  assert.equal(seats.sweepSoon(), false);
  assert.equal(jobs.length, 0);
  assert.equal(await seats.syncNow(ORG), "skipped");
});

test("Billing seat line: 'Updating Stripe to N' until the webhook stores N, then N x", () => {
  // Joined (2 members), Stripe not confirmed yet: plan line still bills 1, note says updating to 2.
  const before = { pro: true, liveSubscription: true, seats: 2, subscribedSeats: 1 };
  assert.equal(billedSeatsFor(before), 1);
  assert.equal(seatsUpdatingTo(before), 2);
  // subscription.updated stored billing.seats = 2: 2 x, no note.
  const after = { ...before, subscribedSeats: 2 };
  assert.equal(billedSeatsFor(after), 2);
  assert.equal(seatsUpdatingTo(after), null);
  // No webhook yet at all (seats unknown): member count, no note.
  assert.equal(billedSeatsFor({ ...before, subscribedSeats: null }), 2);
  assert.equal(seatsUpdatingTo({ ...before, subscribedSeats: null }), null);
  // Not subscribed: member count, no note.
  assert.equal(seatsUpdatingTo({ pro: false, liveSubscription: false, seats: 3, subscribedSeats: 1 }), null);
  // Empty org still bills one seat.
  assert.equal(seatsUpdatingTo({ pro: true, liveSubscription: true, seats: 0, subscribedSeats: 1 }), null);
});
