import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { ObjectId } from "mongodb";
import { cols } from "@/lib/db";

const creds = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

class InvalidLogin extends CredentialsSignin {
  code = "invalid_credentials";
}

export const { handlers, auth, signIn, signOut, unstable_update: updateSession } = NextAuth({
  trustHost: true,
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 30 },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(raw) {
        const parsed = creds.safeParse(raw);
        if (!parsed.success) throw new InvalidLogin();
        const { users } = await cols();
        const user = await users.findOne({ email: parsed.data.email });
        if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
          throw new InvalidLogin();
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
