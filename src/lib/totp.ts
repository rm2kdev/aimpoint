import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** RFC 6238 TOTP (HMAC-SHA1, 30 s steps, 6 digits): the defaults every authenticator app uses. */

export const TOTP_PERIOD = 30;
export const TOTP_DIGITS = 6;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("Invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32 (what authenticator apps expect). */
export const newTotpSecret = () => base32Encode(randomBytes(20));

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / TOTP_PERIOD);

/** HOTP value for one time step (RFC 4226 dynamic truncation). */
export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const off = h[h.length - 1] & 0xf;
  const n = (h.readUInt32BE(off) & 0x7fffffff) % 10 ** TOTP_DIGITS;
  return String(n).padStart(TOTP_DIGITS, "0");
}

/**
 * The time step a code matches, allowing `skew` steps either side for clock drift, or null.
 * Callers reject steps at or before the last accepted one (replay).
 */
export function matchTotp(secret: string, code: string, { skew = 1, now = Date.now() } = {}): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const want = Buffer.from(code);
  const now0 = currentStep(now);
  let hit: number | null = null;
  // Check every candidate (no early exit) so timing doesn't reveal which window matched.
  for (let d = -skew; d <= skew; d++) {
    const got = Buffer.from(totpAt(secret, now0 + d));
    if (timingSafeEqual(got, want) && hit === null) hit = now0 + d;
  }
  return hit;
}

/** otpauth:// URI for the QR code. */
export function otpauthUri(secret: string, account: string, issuer = "Vector") {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: String(TOTP_DIGITS), period: String(TOTP_PERIOD) });
  return `otpauth://totp/${label}?${q}`;
}
