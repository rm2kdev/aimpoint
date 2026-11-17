"use server";

import { redirect } from "next/navigation";
import { AuthError as NextAuthError } from "next-auth";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { signIn, signOut, TwoFactorFailed, TwoFactorRequired } from "@/auth";
import { createLoginChallenge } from "@/lib/two-factor";
import { cols } from "@/lib/db";
import { PASSWORD_HASH_COST, passwordSchema } from "@/lib/password";
import { safeNext } from "@/lib/safe-next";

export type FormState =
  | {
      error?: string;
      fields?: Record<string, string>;
      /** Set when the password was right and the account has 2FA on: the form switches to the code step. */
      challenge?: string;
    }
  | undefined;

const signupSchema = z.object({
  name: z.string().trim().min(1, "Enter your name.").max(80),
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  password: passwordSchema,
  next: z.string().optional(),
});

export async function signupAction(_: FormState, form: FormData): Promise<FormState> {
  const raw = Object.fromEntries(form) as Record<string, string>;
  const parsed = signupSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0].message, fields: { name: raw.name, email: raw.email } };
  const { name, email, password } = parsed.data;
  const { users } = await cols();
  if (await users.findOne({ email })) {
    return { error: "An account with that email already exists. Sign in instead.", fields: { name, email } };
  }
  const { ObjectId } = await import("mongodb");
  await users.insertOne({
    _id: new ObjectId(),
    email,
    name,
    passwordHash: await bcrypt.hash(password, PASSWORD_HASH_COST),
    createdAt: new Date(),
  });
  await signIn("credentials", { email, password, redirect: false });
  redirect(safeNext(parsed.data.next));
}

export async function loginAction(_: FormState, form: FormData): Promise<FormState> {
  const email = String(form.get("email") ?? "");
  const challenge = form.get("challenge");
  if (typeof challenge === "string" && challenge) return loginCodeStep(challenge, email, form);
  try {
    await signIn("credentials", {
      email,
      password: String(form.get("password") ?? ""),
      redirect: false,
    });
  } catch (err) {
    if (err instanceof TwoFactorRequired) {
      // The password was right (authorize checked it). Hand the form a short-lived challenge for the code step,
      // so the password isn't sent again.
      const { users } = await cols();
      const user = await users.findOne({ email: email.trim().toLowerCase() }, { projection: { _id: 1 } });
      if (user) return { challenge: await createLoginChallenge(user._id), fields: { email } };
    }
    if (err instanceof NextAuthError) return { error: "That email and password don't match an account.", fields: { email } };
    throw err;
  }
  redirect(safeNext(form.get("next") as string | null));
}

/** Second sign-in step: the challenge from the password step plus an authenticator or recovery code. */
async function loginCodeStep(challenge: string, email: string, form: FormData): Promise<FormState> {
  try {
    await signIn("credentials", { challenge, code: String(form.get("code") ?? ""), redirect: false });
  } catch (err) {
    if (err instanceof TwoFactorFailed) {
      // An expired or used-up challenge goes back to the password step.
      if (err.reason === "expired") return { error: err.userMessage, fields: { email } };
      return { error: err.userMessage, challenge, fields: { email } };
    }
    if (err instanceof NextAuthError) return { error: "That code isn't right.", challenge, fields: { email } };
    throw err;
  }
  redirect(safeNext(form.get("next") as string | null));
}

export async function logoutAction() {
  await signOut({ redirectTo: "/login" });
}
