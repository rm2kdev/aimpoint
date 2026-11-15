import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import {
  completeLoginChallenge,
  hasTwoFactor,
  TwoFactorError,
  verifySecondFactor,
  type TwoFactorReason,
} from "@/lib/two-factor";

const creds = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
  /** Authenticator or recovery code, required when the account has two-factor authentication on. */
  code: z.string().max(64).optional(),
});
/** Second sign-in step from the login form: the password step's challenge token plus the code. */
const challengeCreds = z.object({ challenge: z.string().min(1).max(200), code: z.string().max(64) });

class InvalidLogin extends CredentialsSignin {
  code = "invalid_credentials";
}
/** Right password, but the account has 2FA on and no code was sent: no session. */
export class TwoFactorRequired extends CredentialsSignin {
  code = "two_factor_required";
}
/** Wrong, reused or locked-out second factor, or an expired challenge. */
export class TwoFactorFailed extends CredentialsSignin {
  constructor(
    readonly reason: TwoFactorReason,
    readonly userMessage: string,
  ) {
    super(userMessage);
    this.code = reason === "locked" ? "two_factor_locked" : reason === "expired" ? "two_factor_expired" : "invalid_code";
  }
}

async function secondFactor<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof TwoFactorError) throw new TwoFactorFailed(e.reason, e.message);
    throw e;
  }
}

export const { handlers, auth, signIn, signOut, unstable_update: updateSession } = NextAuth({
  trustHost: true,
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 30 },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: { email: {}, password: {}, code: {}, challenge: {} },
      async authorize(raw) {
        const { users } = await cols();
        const viaChallenge = challengeCreds.safeParse(raw);
        if (viaChallenge.success) {
          const userId = await secondFactor(() => completeLoginChallenge(viaChallenge.data.challenge, viaChallenge.data.code));
          const user = await users.findOne({ _id: userId });
          if (!user) throw new InvalidLogin();
          return { id: user._id.toHexString(), email: user.email, name: user.name };
        }
        const parsed = creds.safeParse(raw);
        if (!parsed.success) throw new InvalidLogin();
        const user = await users.findOne({ email: parsed.data.email });
        if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
          throw new InvalidLogin();
        }
        // Two-factor accounts: the password alone never yields a session.
        if (hasTwoFactor(user)) {
          const code = parsed.data.code?.trim();
          if (!code) throw new TwoFactorRequired();
          await secondFactor(() => verifySecondFactor(user._id, code));
        }
        return { id: user._id.toHexString(), email: user.email, name: user.name };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger, session }) {
      if (user?.id) token.uid = user.id;
      if (typeof token.uid !== "string" || !ObjectId.isValid(token.uid)) return token;
      const { users } = await cols();
      const _id = new ObjectId(token.uid);
      const u = await users.findOne(
        { _id },
        { projection: { name: 1, email: 1, sessionVersion: 1, sessionReissue: 1 } },
      );
      // Deleted account: sign out.
      if (!u) return null;
      const version = u.sessionVersion ?? 0;
      // New sign-in: stamp the token with the current session version.
      if (user?.id) token.sv = version;
      if ((token.sv ?? 0) !== version) {
        // Revoked (password change, sign out everywhere...). The session that made the change presents the
        // one-time nonce from revokeSessions() through updateSession() and is moved to the new version.
        const nonce = trigger === "update" ? (session as { reissue?: unknown } | undefined)?.reissue : undefined;
        const r = u.sessionReissue;
        if (typeof nonce !== "string" || !r || r.nonce !== nonce || r.expiresAt.getTime() < Date.now()) return null;
        const used = await users.updateOne(
          { _id, "sessionReissue.nonce": nonce },
          { $set: { sessionReissue: null } },
        );
        if (used.modifiedCount !== 1) return null;
        token.sv = version;
      }
      // Profile edits (e.g. display name): re-read from the database rather than trusting the update payload.
      if (trigger === "update") {
        token.name = u.name;
        token.email = u.email;
      }
      return token;
    },
    session({ session, token }) {
      if (token.uid && session.user) session.user.id = token.uid as string;
      return session;
    },
  },
});
