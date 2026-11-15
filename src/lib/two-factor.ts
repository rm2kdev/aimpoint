import "server-only";
import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";
import { ObjectId } from "mongodb";
import QRCode from "qrcode";
import { cols } from "@/lib/db";
import { seal, unseal } from "@/lib/secrets";
import { matchTotp, newTotpSecret, otpauthUri } from "@/lib/totp";
import type { UserDoc } from "@/lib/types";

/**
 * Two-factor authentication (TOTP + single-use recovery codes). Used by the account page actions
 * (enable / disable / regenerate) and by the credentials provider in src/auth.ts (second sign-in step).
 * Errors are TwoFactorError (readable message + reason); callers map them to UserError or a sign-in code.
 */

export const RECOVERY_CODE_COUNT = 10;
/** A setup secret must be confirmed within this long. */
const PENDING_TTL_MS = 15 * 60_000;
/** The password step of a sign-in stays valid this long while the code is entered. */
export const LOGIN_CHALLENGE_TTL_MS = 5 * 60_000;
/** Wrong codes allowed per sign-in challenge before it must start over. */
const CHALLENGE_ATTEMPTS = 5;
/** Per-user lock across challenges and account actions: 5 free tries, then 30 s doubling to 15 min. */
const FREE_ATTEMPTS = 5;
const BASE_LOCK_MS = 30_000;
const MAX_LOCK_MS = 15 * 60_000;

export type TwoFactorReason = "invalid" | "locked" | "expired" | "not_enabled";

export class TwoFactorError extends Error {
  constructor(
    message: string,
    readonly reason: TwoFactorReason,
  ) {
    super(message);
  }
}

export interface TwoFactorStatus {
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodesLeft: number;
}

export function twoFactorStatus(user: Pick<UserDoc, "twoFactor">): TwoFactorStatus {
  const t = user.twoFactor;
  return { enabled: !!t, enabledAt: t?.enabledAt.toISOString() ?? null, recoveryCodesLeft: t?.recoveryHashes.length ?? 0 };
}

export const hasTwoFactor = (user: Pick<UserDoc, "twoFactor">) => !!user.twoFactor;

/* ---------------- recovery codes ---------------- */

// No 0/o/1/l/i, so codes read back without ambiguity.
const RC_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function recoveryKey() {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  return createHash("sha256").update(`vector:recovery-codes:${secret}`).digest();
}

const normaliseRecovery = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** Keyed hash, so a database leak alone can't be brute-forced offline. */
const hashRecovery = (s: string) => createHmac("sha256", recoveryKey()).update(normaliseRecovery(s)).digest("base64url");

function newRecoveryCodes() {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    let s = "";
    for (let i = 0; i < 10; i++) s += RC_ALPHABET[randomInt(RC_ALPHABET.length)];
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
  return { codes, hashes: codes.map(hashRecovery) };
}

/* ---------------- attempt lock ---------------- */

function waitText(ms: number) {
  const s = Math.ceil(ms / 1000);
  return s < 60 ? `${s} seconds` : `${Math.ceil(s / 60)} minute${s > 60 ? "s" : ""}`;
}

async function assertNotLocked(user: Pick<UserDoc, "twoFactorAttempts">) {
  const until = user.twoFactorAttempts?.lockedUntil?.getTime() ?? 0;
  if (until > Date.now()) {
    throw new TwoFactorError(`Too many wrong codes. Try again in ${waitText(until - Date.now())}.`, "locked");
  }
}

async function recordFailure(userId: ObjectId): Promise<never> {
  const { users } = await cols();
  const u = await users.findOneAndUpdate(
    { _id: userId },
    { $inc: { "twoFactorAttempts.failures": 1 } },
    { returnDocument: "after", projection: { twoFactorAttempts: 1 } },
  );
  const failures = u?.twoFactorAttempts?.failures ?? 1;
  if (failures >= FREE_ATTEMPTS) {
    const ms = Math.min(BASE_LOCK_MS * 2 ** (failures - FREE_ATTEMPTS), MAX_LOCK_MS);
    await users.updateOne({ _id: userId }, { $set: { "twoFactorAttempts.lockedUntil": new Date(Date.now() + ms) } });
    throw new TwoFactorError(`That code isn't right. Too many wrong codes, so try again in ${waitText(ms)}.`, "locked");
  }
  throw new TwoFactorError("That code isn't right.", "invalid");
}

/* ---------------- verification ---------------- */

/**
 * Check a second factor for a user with 2FA on: a 6-digit authenticator code (±1 step of clock skew,
 * never a step at or before the last accepted one) or an unused recovery code (consumed). Throws
 * TwoFactorError when wrong or locked; a success clears the failure counter.
 */
export async function verifySecondFactor(userId: ObjectId, input: string): Promise<"totp" | "recovery"> {
  const { users } = await cols();
  const user = await users.findOne({ _id: userId }, { projection: { twoFactor: 1, twoFactorAttempts: 1 } });
  if (!user?.twoFactor) throw new TwoFactorError("Two-factor authentication isn't on for this account.", "not_enabled");
  await assertNotLocked(user);
  const code = String(input ?? "").replace(/\s/g, "");
  let kind: "totp" | "recovery" | null = null;

  if (/^\d{6}$/.test(code)) {
    const secret = unseal(user.twoFactor.secret);
    const step = secret ? matchTotp(secret, code) : null;
    if (step !== null) {
      // Atomic replay guard: only one request can advance lastStep past this step.
      const r = await users.updateOne(
        { _id: userId, "twoFactor.lastStep": { $lt: step } },
        { $set: { "twoFactor.lastStep": step } },
      );
      if (r.modifiedCount === 1) kind = "totp";
    }
  } else if (normaliseRecovery(code).length === 10) {
    const h = hashRecovery(code);
    // Atomic single use: the $pull only succeeds for the request that still finds the hash.
    const r = await users.updateOne(
      { _id: userId, "twoFactor.recoveryHashes": h },
      { $pull: { "twoFactor.recoveryHashes": h } },
    );
    if (r.modifiedCount === 1) kind = "recovery";
  }

  if (!kind) return recordFailure(userId);
  if (user.twoFactorAttempts) await users.updateOne({ _id: userId }, { $unset: { twoFactorAttempts: "" } });
  return kind;
}

/* ---------------- setup / disable / regenerate ---------------- */

/** Start setup: a fresh secret kept sealed as pending until confirmed. The only time the secret leaves the server. */
export async function beginSetup(user: Pick<UserDoc, "_id" | "email" | "twoFactor">) {
  if (user.twoFactor) throw new TwoFactorError("Two-factor authentication is already on.", "invalid");
  const secret = newTotpSecret();
  const { users } = await cols();
  await users.updateOne({ _id: user._id }, { $set: { twoFactorPending: { secret: seal(secret), createdAt: new Date() } } });
  const uri = otpauthUri(secret, user.email);
  const qrSvg = await QRCode.toString(uri, { type: "svg", errorCorrectionLevel: "M", margin: 1 });
  return { secret, uri, qrSvg };
}

/** Confirm setup with a code from the app. Switches 2FA on and returns the recovery codes (shown once). */
export async function confirmSetup(userId: ObjectId, code: string): Promise<string[]> {
  const { users } = await cols();
  const user = await users.findOne({ _id: userId }, { projection: { twoFactor: 1, twoFactorPending: 1, twoFactorAttempts: 1 } });
  if (!user) throw new TwoFactorError("Your account couldn't be found. Sign in again.", "invalid");
  if (user.twoFactor) throw new TwoFactorError("Two-factor authentication is already on.", "invalid");
  const p = user.twoFactorPending;
  const secret = p && p.createdAt.getTime() + PENDING_TTL_MS > Date.now() ? unseal(p.secret) : null;
  if (!secret) throw new TwoFactorError("This setup expired. Start again to get a new QR code.", "expired");
  await assertNotLocked(user);
  const step = matchTotp(secret, String(code ?? "").replace(/\s/g, ""));
  if (step === null) return recordFailure(userId);
  const { codes, hashes } = newRecoveryCodes();
  const r = await users.updateOne(
    { _id: userId, twoFactor: { $in: [null] }, "twoFactorPending.secret": p!.secret },
    {
      $set: { twoFactor: { secret: p!.secret, enabledAt: new Date(), lastStep: step, recoveryHashes: hashes } },
      $unset: { twoFactorPending: "", twoFactorAttempts: "" },
    },
  );
  if (r.modifiedCount !== 1) throw new TwoFactorError("This setup changed in another window. Start again.", "expired");
  return codes;
}

export async function disableTwoFactor(userId: ObjectId) {
  const { users } = await cols();
  await users.updateOne({ _id: userId }, { $set: { twoFactor: null }, $unset: { twoFactorPending: "", twoFactorAttempts: "" } });
}

/** Replace every recovery code (old ones stop working). Returns the new codes, shown once. */
export async function regenerateRecoveryCodes(userId: ObjectId): Promise<string[]> {
  const { users } = await cols();
  const { codes, hashes } = newRecoveryCodes();
  const r = await users.updateOne({ _id: userId, twoFactor: { $ne: null } }, { $set: { "twoFactor.recoveryHashes": hashes } });
  if (r.matchedCount !== 1) throw new TwoFactorError("Two-factor authentication isn't on for this account.", "not_enabled");
  return codes;
}

/* ---------------- sign-in challenge ---------------- */

const hashToken = (t: string) => createHash("sha256").update(t).digest("base64url");

/** After a correct password for a 2FA user: a short-lived token that stands in for the password in step two. */
export async function createLoginChallenge(userId: ObjectId): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const { loginChallenges } = await cols();
  await loginChallenges.insertOne({
    _id: new ObjectId(),
    tokenHash: hashToken(token),
    userId,
    attempts: 0,
    expiresAt: new Date(Date.now() + LOGIN_CHALLENGE_TTL_MS),
  });
  return token;
}

/**
 * Step two of sign-in: resolve the challenge, check the code, and consume the challenge on success.
 * Returns the user id the session is issued for.
 */
export async function completeLoginChallenge(token: string, code: string): Promise<ObjectId> {
  const { loginChallenges } = await cols();
  const tokenHash = hashToken(String(token ?? ""));
  const ch = await loginChallenges.findOne({ tokenHash });
  if (!ch || ch.expiresAt.getTime() < Date.now()) {
    throw new TwoFactorError("This sign-in expired. Enter your email and password again.", "expired");
  }
  try {
    await verifySecondFactor(ch.userId, code);
  } catch (e) {
    const after = await loginChallenges.findOneAndUpdate({ _id: ch._id }, { $inc: { attempts: 1 } }, { returnDocument: "after" });
    if ((after?.attempts ?? CHALLENGE_ATTEMPTS) >= CHALLENGE_ATTEMPTS) await loginChallenges.deleteOne({ _id: ch._id });
    throw e;
  }
  // Single use: only the request that deletes it gets the session.
  const del = await loginChallenges.deleteOne({ _id: ch._id });
  if (del.deletedCount !== 1) throw new TwoFactorError("This sign-in expired. Enter your email and password again.", "expired");
  return ch.userId;
}
