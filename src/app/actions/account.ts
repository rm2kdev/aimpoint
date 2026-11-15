"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ObjectId } from "mongodb";
import { signOut, updateSession } from "@/auth";
import { cols } from "@/lib/db";
import { AuthError, currentUser } from "@/lib/session";
import { guard, UserError, type Result } from "@/lib/result";
import { publish } from "@/lib/realtime/server";
import { ACCOUNT_PATH } from "@/lib/paths";
import { removeMembership } from "@/lib/membership";
import { deleteAccount as deleteAccountData } from "@/lib/account-deletion";
import { passwordSchema } from "@/lib/password";
import { hashPassword, reauthenticate, revokeSessions } from "@/lib/security";
import {
  beginSetup,
  confirmSetup,
  disableTwoFactor,
  hasTwoFactor,
  regenerateRecoveryCodes,
  TwoFactorError,
  verifySecondFactor,
} from "@/lib/two-factor";

const DISPLAY_NAME_MAX = 80;

const nameSchema = z
  .string({ message: "Enter a name." })
  .trim()
  .min(1, "Your name can't be empty.")
  .max(DISPLAY_NAME_MAX, `Keep your name to ${DISPLAY_NAME_MAX} characters or fewer.`);

/** Change the signed-in user's display name everywhere: database, session token, and every org they belong to. */
export async function updateDisplayName(raw: string): Promise<Result<{ name: string }>> {
  return guard(async () => {
    const user = await currentUser();
    if (!user) throw new AuthError("You are signed out. Sign in and try again.");
    const parsed = nameSchema.safeParse(raw);
    if (!parsed.success) throw new UserError(parsed.error.issues[0].message);
    const name = parsed.data;
    if (name === user.name) return { name };

    const c = await cols();
    await c.users.updateOne({ _id: user._id }, { $set: { name } });
    // Refresh the Auth.js JWT so the session's name matches without signing in again.
    await updateSession({ user: { name } });

    // Members, assignee pickers, comment authors and mentions resolve names from the org's member list,
    // which every open client reloads on org.changed.
    const memberships = await c.memberships.find({ userId: user._id }, { projection: { orgId: 1 } }).toArray();
    const actorId = user._id.toHexString();
    await Promise.all(memberships.map((m) => publish(m.orgId.toHexString(), { type: "org.changed", actorId })));

    revalidatePath(ACCOUNT_PATH);
    return { name };
  });
}

const changePasswordSchema = z
  .object({
    current: z.string().min(1, "Enter your current password."),
    next: passwordSchema,
    confirm: z.string(),
  })
  .refine((v) => v.next === v.confirm, { message: "The new passwords don't match.", path: ["confirm"] })
  .refine((v) => v.next !== v.current, { message: "Choose a new password that's different from your current one.", path: ["next"] });

export type ChangePasswordField = "current" | "next" | "confirm";

/**
 * Change the signed-in user's password after checking the current one (rate-limited). Keeps this session
 * signed in and signs out every other session on its next request.
 */
export async function changePassword(input: {
  current: string;
  next: string;
  confirm: string;
}): Promise<Result<void> & { field?: ChangePasswordField }> {
  const parsed = changePasswordSchema.safeParse({
    current: typeof input?.current === "string" ? input.current : "",
    next: typeof input?.next === "string" ? input.next : "",
    confirm: typeof input?.confirm === "string" ? input.confirm : "",
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue.message, field: issue.path[0] as ChangePasswordField };
  }
  let wrongCurrent = false;
  const r = await guard(async () => {
    const user = await currentUser();
    if (!user) throw new AuthError("You are signed out. Sign in and try again.");
    try {
      await reauthenticate(user._id, parsed.data.current);
    } catch (e) {
      wrongCurrent = true;
      throw e;
    }
    // New hash and session-version bump in one write, so no window where the password changed but old sessions live on.
    await revokeSessions(user._id, { set: { passwordHash: await hashPassword(parsed.data.next) } });
  });
  return !r.ok && wrongCurrent ? { ...r, field: "current" } : r;
}

/* ---------------- two-factor authentication ---------------- */

async function twoFactorStep<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof TwoFactorError) throw new UserError(e.message);
    throw e;
  }
}

async function signedInUser() {
  const user = await currentUser();
  if (!user) throw new AuthError("You are signed out. Sign in and try again.");
  return user;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * Step one of turning on 2FA: re-check the password, then return a fresh secret (QR code + manual key).
 * Nothing is switched on until confirmTwoFactorSetup gets a valid code for it.
 */
export async function beginTwoFactorSetup(password: string): Promise<Result<{ secret: string; qrSvg: string; uri: string }>> {
  return guard(async () => {
    const user = await signedInUser();
    if (!str(password)) throw new UserError("Enter your current password.");
    await reauthenticate(user._id, str(password));
    return twoFactorStep(() => beginSetup(user));
  });
}

/** Step two: a valid code from the app switches 2FA on. Returns the recovery codes (shown once). */
export async function confirmTwoFactorSetup(code: string): Promise<Result<{ recoveryCodes: string[] }>> {
  return guard(async () => {
    const user = await signedInUser();
    if (!/^\d{6}$/.test(str(code).replace(/\s/g, ""))) throw new UserError("Enter the 6-digit code from your authenticator app.");
    const recoveryCodes = await twoFactorStep(() => confirmSetup(user._id, str(code)));
    // Sessions signed in with the password alone are signed out; this one stays. No revalidatePath here: the
    // action's re-render would still see the pre-revoke cookie and bounce through /login, losing the recovery
    // codes on screen. The client refreshes once they've been saved.
    await revokeSessions(user._id);
    return { recoveryCodes };
  });
}

/** Turn 2FA off: needs the password and a current authenticator code (or an unused recovery code). */
export async function turnOffTwoFactor(input: { password: string; code: string }): Promise<Result<void>> {
  return guard(async () => {
    const user = await signedInUser();
    if (!user.twoFactor) throw new UserError("Two-factor authentication is already off.");
    if (!str(input?.password)) throw new UserError("Enter your current password.");
    if (!str(input?.code).trim()) throw new UserError("Enter a code from your authenticator app or a recovery code.");
    await reauthenticate(user._id, str(input.password));
    await twoFactorStep(() => verifySecondFactor(user._id, str(input.code)));
    await disableTwoFactor(user._id);
    revalidatePath(ACCOUNT_PATH);
  });
}

/** New recovery codes (old ones stop working): needs the password or an authenticator code. */
export async function regenerateTwoFactorRecoveryCodes(input: {
  password?: string;
  code?: string;
}): Promise<Result<{ recoveryCodes: string[] }>> {
  return guard(async () => {
    const user = await signedInUser();
    if (!user.twoFactor) throw new UserError("Two-factor authentication isn't on.");
    const code = str(input?.code).replace(/\s/g, "");
    if (str(input?.password)) await reauthenticate(user._id, str(input?.password));
    else if (/^\d{6}$/.test(code)) await twoFactorStep(() => verifySecondFactor(user._id, code));
    else throw new UserError("Enter your password or the 6-digit code from your authenticator app.");
    const recoveryCodes = await twoFactorStep(() => regenerateRecoveryCodes(user._id));
    revalidatePath(ACCOUNT_PATH);
    return { recoveryCodes };
  });
}

/* ---------------- email ---------------- */

const emailSchema = z.string().trim().toLowerCase().max(254, "That email is too long.").email("Enter a valid email address.");

export type ChangeEmailField = "email" | "password" | "code";

/**
 * Change the sign-in email after re-authentication (password, plus an authenticator or recovery code when
 * 2FA is on). Normalised like signup/login (trimmed, lower-case) and unique: the users.email index refuses a
 * clash. There's no mailer, so the address isn't verified. The old address stops working at once.
 */
export async function changeEmail(input: {
  email: string;
  password: string;
  code?: string;
}): Promise<Result<{ email: string }> & { field?: ChangeEmailField }> {
  const parsed = emailSchema.safeParse(str(input?.email));
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message, field: "email" };
  const email = parsed.data;
  let field: ChangeEmailField | undefined;
  const r = await guard(async () => {
    const user = await signedInUser();
    if (email === user.email) {
      field = "email";
      throw new UserError("That's already your email.");
    }
    if (!str(input?.password)) {
      field = "password";
      throw new UserError("Enter your current password.");
    }
    const twoFactor = hasTwoFactor(user);
    if (twoFactor && !str(input?.code).trim()) {
      field = "code";
      throw new UserError("Enter a code from your authenticator app or a recovery code.");
    }
    field = "password";
    await reauthenticate(user._id, str(input.password));
    if (twoFactor) {
      field = "code";
      await twoFactorStep(() => verifySecondFactor(user._id, str(input.code)));
    }
    field = "email";
    const c = await cols();
    try {
      await c.users.updateOne({ _id: user._id }, { $set: { email } });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw new UserError("Another account already uses that email.");
      throw e;
    }
    field = undefined;
    // The jwt callback re-reads name/email from the database on update.
    await updateSession({});
    // Member lists show emails: refresh every org this user is in.
    const memberships = await c.memberships.find({ userId: user._id }, { projection: { orgId: 1 } }).toArray();
    const actorId = user._id.toHexString();
    await Promise.all(memberships.map((m) => publish(m.orgId.toHexString(), { type: "org.changed", actorId })));
    revalidatePath(ACCOUNT_PATH);
    return { email };
  });
  return !r.ok && field ? { ...r, field } : r;
}

/* ---------------- sessions ---------------- */

/** Sign out every other browser and device. This session stays signed in (see revokeSessions). */
export async function signOutOtherSessions(): Promise<Result<void>> {
  return guard(async () => {
    const user = await signedInUser();
    // No revalidatePath: nothing on the page changes, and a re-render in this request would still carry
    // the pre-revoke cookie.
    await revokeSessions(user._id);
  });
}

/* ---------------- organisations ---------------- */

/** Leave an organisation from the account page. Refused for its last admin; open tasks become unassigned. */
export async function leaveOrganisation(orgId: string): Promise<Result<{ name: string }>> {
  return guard(async () => {
    const user = await signedInUser();
    if (!ObjectId.isValid(str(orgId))) throw new UserError("You aren't a member of that organisation.");
    const c = await cols();
    const org = await c.orgs.findOne({ _id: new ObjectId(orgId) });
    if (!org || !(await c.memberships.findOne({ orgId: org._id, userId: user._id }))) {
      throw new UserError("You aren't a member of that organisation.");
    }
    await removeMembership(org._id, user._id, user._id);
    revalidatePath(ACCOUNT_PATH);
    return { name: org.name };
  });
}

/* ---------------- delete account ---------------- */

export type DeleteAccountField = "email" | "password" | "code";

/**
 * Delete the signed-in account for good. The user types their email and current password (plus a 2FA code
 * when it's on), all re-checked here. Refused while they're the only admin of an org with other members;
 * orgs where they're the only member are deleted too, but only with `deleteSoleOrgs`. Ends every session
 * (this one included): the client then goes to /login.
 */
export async function deleteMyAccount(input: {
  email: string;
  password: string;
  code?: string;
  deleteSoleOrgs?: boolean;
}): Promise<Result<{ deletedOrgs: string[] }> & { field?: DeleteAccountField }> {
  let field: DeleteAccountField | undefined;
  const r = await guard(async () => {
    const user = await signedInUser();
    field = "email";
    if (str(input?.email).trim().toLowerCase() !== user.email) throw new UserError("Type your email address exactly as shown.");
    field = "password";
    if (!str(input?.password)) throw new UserError("Enter your current password.");
    const twoFactor = hasTwoFactor(user);
    if (twoFactor && !str(input?.code).trim()) {
      field = "code";
      throw new UserError("Enter a code from your authenticator app or a recovery code.");
    }
    await reauthenticate(user._id, str(input.password));
    if (twoFactor) {
      field = "code";
      await twoFactorStep(() => verifySecondFactor(user._id, str(input.code)));
    }
    field = undefined;
    const out = await deleteAccountData(user._id, { deleteSoleOrgs: input?.deleteSoleOrgs === true });
    // The user doc is gone, so every token is already refused; clear this browser's cookie too.
    await signOut({ redirect: false });
    return out;
  });
  return !r.ok && field ? { ...r, field } : r;
}
