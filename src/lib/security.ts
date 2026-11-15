import "server-only";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { ObjectId } from "mongodb";
import { updateSession } from "@/auth";
import { cols } from "@/lib/db";
import { UserError } from "@/lib/result";
import { PASSWORD_HASH_COST } from "@/lib/password";
import type { UserDoc } from "@/lib/types";

/**
 * Account security helpers shared by every sensitive action (change password, 2FA, sign out everywhere,
 * account deletion). Sessions are Auth.js JWTs, so revocation works through `users.sessionVersion`:
 * every token carries the version it was issued under (`token.sv`) and the jwt callback in `src/auth.ts`
 * drops any token whose version no longer matches.
 */

/** Wrong-password attempts allowed before reauthentication is locked for a while. */
const FREE_ATTEMPTS = 5;
const BASE_LOCK_MS = 30_000;
const MAX_LOCK_MS = 15 * 60_000;
/** How long the one-time re-issue nonce for the acting session stays valid. */
const REISSUE_TTL_MS = 60_000;

function lockMs(failures: number) {
  return Math.min(BASE_LOCK_MS * 2 ** (failures - FREE_ATTEMPTS), MAX_LOCK_MS);
}

function waitText(ms: number) {
  const s = Math.ceil(ms / 1000);
  return s < 60 ? `${s} seconds` : `${Math.ceil(s / 60)} minute${s > 60 ? "s" : ""}`;
}

/**
 * Check the signed-in user's password before a sensitive action. Throws a readable UserError when it's
 * wrong or when too many wrong attempts were made recently (locks grow from 30 s to 15 min). A correct
 * password clears the counter.
 */
export async function reauthenticate(userId: ObjectId, password: string): Promise<void> {
  const { users } = await cols();
  const user = await users.findOne({ _id: userId }, { projection: { passwordHash: 1, reauth: 1 } });
  if (!user) throw new UserError("Your account couldn't be found. Sign in again.");
  const now = Date.now();
  const lockedUntil = user.reauth?.lockedUntil?.getTime() ?? 0;
  if (lockedUntil > now) {
    throw new UserError(`Too many wrong attempts. Try again in ${waitText(lockedUntil - now)}.`);
  }
  if (password && (await bcrypt.compare(password, user.passwordHash))) {
    if (user.reauth) await users.updateOne({ _id: userId }, { $unset: { reauth: "" } });
    return;
  }
  const failures = (user.reauth?.failures ?? 0) + 1;
  const locked = failures >= FREE_ATTEMPTS ? new Date(now + lockMs(failures)) : null;
  await users.updateOne({ _id: userId }, { $set: { reauth: { failures, lockedUntil: locked } } });
  throw new UserError(
    locked
      ? `Your current password is incorrect. Too many wrong attempts, so try again in ${waitText(locked.getTime() - now)}.`
      : "Your current password is incorrect.",
  );
}

/**
 * Sign out every other session of this user while keeping the calling one signed in. Call only from a
 * server action or route handler of the acting session (it rewrites that session's cookie).
 * Pass `{ keepCurrent: false }` to sign out everywhere, including here.
 */
export async function revokeSessions(
  userId: ObjectId,
  { keepCurrent = true, set = {} }: { keepCurrent?: boolean; /** Extra fields written in the same update (e.g. a new password hash). */ set?: Partial<UserDoc> } = {},
) {
  const { users } = await cols();
  const nonce = keepCurrent ? randomBytes(24).toString("base64url") : null;
  await users.updateOne(
    { _id: userId },
    {
      $inc: { sessionVersion: 1 },
      $set: { ...set, sessionReissue: nonce ? { nonce, expiresAt: new Date(Date.now() + REISSUE_TTL_MS) } : null },
    },
  );
  // The jwt callback accepts this one nonce once and moves the current token to the new version.
  if (nonce) await updateSession({ reissue: nonce } as Parameters<typeof updateSession>[0]);
}

/** Hash a password for storage (same cost as signup). */
export function hashPassword(password: string) {
  return bcrypt.hash(password, PASSWORD_HASH_COST);
}
