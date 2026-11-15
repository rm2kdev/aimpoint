"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { updateSession } from "@/auth";
import { cols } from "@/lib/db";
import { AuthError, currentUser } from "@/lib/session";
import { guard, UserError, type Result } from "@/lib/result";
import { publish } from "@/lib/realtime/server";
import { ACCOUNT_PATH } from "@/lib/paths";
import { passwordSchema } from "@/lib/password";
import { hashPassword, reauthenticate, revokeSessions } from "@/lib/security";

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
