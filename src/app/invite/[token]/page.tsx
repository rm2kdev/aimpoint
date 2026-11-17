import Link from "next/link";
import { cols } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { AcceptInvite } from "./accept";

export const metadata = { title: "Invitation" };

export default async function InvitePage({ params }: PageProps<"/invite/[token]">) {
  const { token } = await params;
  const c = await cols();
  const invite = await c.invites.findOne({ token });
  const valid = invite && !invite.acceptedAt && invite.expiresAt > new Date();
  const org = valid ? await c.orgs.findOne({ _id: invite.orgId }) : null;
  const user = await currentUser();
  const next = `/invite/${token}`;

  return (
    <main className="grid min-h-full place-items-center bg-sidebar px-[calc(1rem+env(safe-area-inset-left))] py-[calc(4rem+env(safe-area-inset-top))]">
      <div className="w-full max-w-[380px]">
        <Logo className="mb-8" />
        {!valid || !org ? (
          <>
            <h1 className="text-[22px] font-semibold tracking-[-0.02em]">This invite has expired</h1>
            <p className="mt-1.5 text-[13.5px] text-muted-foreground">Invite links last 14 days and work once. Ask your admin for a new one.</p>
            <Button asChild variant="outline" className="mt-6 h-9"><Link href="/">Go to Vector</Link></Button>
          </>
        ) : (
          <>
            <h1 className="text-[22px] font-semibold tracking-[-0.02em]">Join {org.name}</h1>
            <p className="mt-1.5 text-[13.5px] text-muted-foreground">
              You&rsquo;ve been invited as {invite.role === "admin" ? "an admin" : "a member"}
              {invite.email ? <> ({invite.email})</> : null}.
            </p>
            {user ? (
              <AcceptInvite token={token} as={user.email} />
            ) : (
              <div className="mt-6 grid gap-2">
                <Button asChild className="h-9"><Link href={`/signup?next=${encodeURIComponent(next)}&email=${encodeURIComponent(invite.email)}`}>Create an account</Link></Button>
                <Button asChild variant="outline" className="h-9"><Link href={`/login?next=${encodeURIComponent(next)}&email=${encodeURIComponent(invite.email)}`}>I already have an account</Link></Button>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
