/**
 * Manual task order (VEC-57): fractional index keys. A rank is a short base-62 string, compared with plain
 * string order (`<`, MongoDB's default binary sort); `rankBetween(a, b)` returns a key strictly between two
 * neighbours, so a move rewrites only the moved task. One key space per organisation, so the same order holds
 * in project views and the All view. Smaller rank = higher up the list.
 *
 * Format (the "fractional-indexing" scheme by David Greenspan / rocicorp, CC0): an integer part whose head
 * letter encodes its length (a0..az, b00..bzz, ... upwards; Zz.., Yzzz.. downwards), then an optional fraction
 * that never ends in "0". Appending or prepending only bumps the integer part, so keys at the ends stay short;
 * repeated inserts into one gap grow by about one character per six inserts.
 *
 * Pure and dependency-free: used by the task service, the backfill migration, the seed script, the client
 * (optimistic moves) and `pnpm test` (src/lib/rank.test.mjs).
 */

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO = DIGITS[0];
const SMALLEST_INT = "A" + ZERO.repeat(26);

/** A key strictly between fraction strings `a` and `b` (b null = no upper bound). Neither may end in "0". */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`rank: ${a} >= ${b}`);
  if (a.slice(-1) === ZERO || (b && b.slice(-1) === ZERO)) throw new Error("rank: trailing zero");
  if (b) {
    // Shared prefix: recurse on what follows it.
    let n = 0;
    while ((a[n] || ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0]) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (digitB - digitA > 1) return DIGITS[Math.round((digitA + digitB) / 2)];
  // Adjacent digits: take b's first digit when b is longer, else go one digit deeper after a's.
  if (b && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA] + midpoint(a.slice(1), null);
}

function integerLength(head: string): number {
  if (head >= "a" && head <= "z") return head.charCodeAt(0) - 97 + 2;
  if (head >= "A" && head <= "Z") return 90 - head.charCodeAt(0) + 2;
  throw new Error(`rank: invalid head "${head}"`);
}

function integerPart(key: string): string {
  const len = integerLength(key[0]);
  if (len > key.length) throw new Error(`rank: invalid key "${key}"`);
  return key.slice(0, len);
}

/** Whether `key` is a well-formed rank (for input coming from storage or the client). */
export function isRank(key: unknown): key is string {
  if (typeof key !== "string" || !key || key === SMALLEST_INT) return false;
  try {
    const int = integerPart(key);
    if ([...key].some((ch) => !DIGITS.includes(ch))) return false;
    return key.slice(int.length).slice(-1) !== ZERO;
  } catch {
    return false;
  }
}

function assertRank(key: string) {
  if (!isRank(key)) throw new Error(`rank: invalid key "${key}"`);
}

function increment(int: string): string | null {
  const [head, ...digs] = int.split("");
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]) + 1;
    if (d === DIGITS.length) digs[i] = ZERO;
    else {
      digs[i] = DIGITS[d];
      carry = false;
    }
  }
  if (!carry) return head + digs.join("");
  if (head === "Z") return "a" + ZERO;
  if (head === "z") return null;
  const h = String.fromCharCode(head.charCodeAt(0) + 1);
  if (h > "a") digs.push(ZERO);
  else digs.pop();
  return h + digs.join("");
}

function decrement(int: string): string | null {
  const [head, ...digs] = int.split("");
  let borrow = true;
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]) - 1;
    if (d === -1) digs[i] = DIGITS[DIGITS.length - 1];
    else {
      digs[i] = DIGITS[d];
      borrow = false;
    }
  }
  if (!borrow) return head + digs.join("");
  if (head === "a") return "Z" + DIGITS[DIGITS.length - 1];
  if (head === "A") return null;
  const h = String.fromCharCode(head.charCodeAt(0) - 1);
  if (h < "Z") digs.push(DIGITS[DIGITS.length - 1]);
  else digs.pop();
  return h + digs.join("");
}

/**
 * A rank strictly between `a` and `b`. `null` means "no neighbour on that side": (null, b) is above b,
 * (a, null) is below a, (null, null) is the first key ("a0"). Throws if a >= b or either is malformed.
 */
export function rankBetween(a: string | null | undefined, b: string | null | undefined): string {
  const lo = a ?? null;
  const hi = b ?? null;
  if (lo !== null) assertRank(lo);
  if (hi !== null) assertRank(hi);
  if (lo !== null && hi !== null && lo >= hi) throw new Error(`rank: ${lo} >= ${hi}`);
  if (lo === null) {
    if (hi === null) return "a" + ZERO;
    const ib = integerPart(hi);
    const fb = hi.slice(ib.length);
    if (ib === SMALLEST_INT) return ib + midpoint("", fb);
    if (ib < hi) return ib;
    const res = decrement(ib);
    if (res === null) throw new Error("rank: out of room at the top");
    return res;
  }
  if (hi === null) {
    const ia = integerPart(lo);
    const fa = lo.slice(ia.length);
    const i = increment(ia);
    return i === null ? ia + midpoint(fa, null) : i;
  }
  const ia = integerPart(lo);
  const fa = lo.slice(ia.length);
  const ib = integerPart(hi);
  const fb = hi.slice(ib.length);
  if (ia === ib) return ia + midpoint(fa, fb);
  const i = increment(ia);
  if (i === null) throw new Error("rank: out of room");
  if (i < hi) return i;
  return ia + midpoint(fa, null);
}

/** `n` ascending ranks after `after` (null = from the start), for backfills. */
export function ranksAfter(after: string | null, n: number): string[] {
  const out: string[] = [];
  let prev = after;
  for (let i = 0; i < n; i++) out.push((prev = rankBetween(prev, null)));
  return out;
}

/** Order by rank (missing ranks last), ties broken by id so every member sees the same order. */
export function compareRank(a: { rank?: string | null; id: string }, b: { rank?: string | null; id: string }): number {
  const ra = a.rank || "\uffff";
  const rb = b.rank || "\uffff";
  return ra < rb ? -1 : ra > rb ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
