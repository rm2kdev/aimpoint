import { z } from "zod";

/** Password rule shared by signup and change-password (client-safe, no server imports). */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters for your password.`)
  .max(PASSWORD_MAX, `Keep your password to ${PASSWORD_MAX} characters or fewer.`);

/** bcrypt cost used for every stored password hash. */
export const PASSWORD_HASH_COST = 11;
