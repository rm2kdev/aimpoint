import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Seals third-party credentials (a Hermes API key, a webhook signing secret, a provider API key) at rest.
 * AES-256-GCM with a key derived from AUTH_SECRET, so rotating AUTH_SECRET invalidates sealed values.
 */

/**
 * KDF context for the sealing key. Keeps the pre-rename "vector" bytes on purpose (VEC-321): every sealed value in
 * the database (bot connection secrets and Aimpoint keys, 2FA TOTP secrets) was sealed under it, and changing it
 * would make them all unreadable. Never rename it; a change needs a re-seal migration of every sealed field.
 */
const LEGACY_KDF_CONTEXT = "vector:bot-secrets:";

function key() {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  return createHash("sha256").update(`${LEGACY_KDF_CONTEXT}${secret}`).digest();
}

/** "v1.<iv>.<tag>.<ciphertext>", all base64url. */
export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function unseal(sealed: string): string | null {
  const [v, iv, tag, body] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !body) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Last four characters only. */
export const secretHint = (s: string) => `…${s.slice(-4)}`;

export const randomSecret = (prefix: string) => `${prefix}${randomBytes(24).toString("base64url")}`;
