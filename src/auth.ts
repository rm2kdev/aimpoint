import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { cols } from "@/lib/db";

const creds = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

class InvalidLogin extends CredentialsSignin {
  code = "invalid_credentials";
}

export const { handlers, auth, signIn, signOut } = NextAuth({
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
    jwt({ token, user }) {
      if (user?.id) token.uid = user.id;
      return token;
    },
    session({ session, token }) {
      if (token.uid && session.user) session.user.id = token.uid as string;
      return session;
    },
  },
});
