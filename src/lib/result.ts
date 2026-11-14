import "server-only";
import { AuthError } from "@/lib/session";

export type Result<T = void> = { ok: true; data?: T } | { ok: false; error: string };

export class UserError extends Error {}

export async function guard<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    if (err instanceof AuthError || err instanceof UserError) return { ok: false, error: err.message };
    if ((err as { code?: number }).code === 11000) return { ok: false, error: "That name or key is already taken." };
    console.error(err);
    return { ok: false, error: "Something went wrong. Try again." };
  }
}

export function deriveKey(name: string) {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, "").split(/\s+/).filter(Boolean);
  const key = words.length > 1 ? words.map((w) => w[0]).join("") : (words[0] ?? "PRJ").slice(0, 3);
  const k = /^[A-Z]/.test(key) ? key.slice(0, 5) : `P${key}`.slice(0, 5);
  return k.length >= 2 ? k : `${k}X`;
}
