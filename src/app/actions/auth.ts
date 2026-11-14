"use server";

import { redirect } from "next/navigation";
import { AuthError as NextAuthError } from "next-auth";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { signIn, signOut } from "@/auth";
import { cols } from "@/lib/db";

export type FormState = { error?: string; fields?: Record<string, string> } | undefined;

const signupSchema = z.object({
  name: z.string().trim().min(1, "Enter your name.").max(80),
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  password: z.string().min(8, "Use at least 8 characters for your password.").max(200),
  next: z.string().optional(),
});

function safeNext(next: string | undefined | null) {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

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
    passwordHash: await bcrypt.hash(password, 11),
    createdAt: new Date(),
  });
  await signIn("credentials", { email, password, redirect: false });
  redirect(safeNext(parsed.data.next));
}

export async function loginAction(_: FormState, form: FormData): Promise<FormState> {
  const email = String(form.get("email") ?? "");
  try {
    await signIn("credentials", {
      email,
      password: String(form.get("password") ?? ""),
      redirect: false,
    });
  } catch (err) {
    if (err instanceof NextAuthError) return { error: "That email and password don't match an account.", fields: { email } };
    throw err;
  }
  redirect(safeNext(form.get("next") as string | null));
}

export async function logoutAction() {
  await signOut({ redirectTo: "/login" });
}
