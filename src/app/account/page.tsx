import Link from "next/link";
import { ChevronLeftIcon } from "lucide-react";
import { requireUser } from "@/lib/session";
import { cols } from "@/lib/db";
import { orgPath } from "@/lib/paths";
import { SettingsRow } from "@/components/settings/ui";
import { UserAvatar } from "@/components/bits";
import { ProfileForm } from "./profile-form";

export const metadata = { title: "Account" };

export default async function AccountPage({ searchParams }: PageProps<"/account">) {
  const user = await requireUser();
  const { from } = await searchParams;
  const c = await cols();
  const memberships = await c.memberships.find({ userId: user._id }).sort({ createdAt: 1 }).toArray();
  const orgs = await c.orgs.find({ _id: { $in: memberships.map((m) => m.orgId) } }).toArray();
  // Back to the org the user came from (if they're a member), else their first org.
  const back = orgs.find((o) => o.slug === from) ?? orgs.find((o) => o._id.equals(memberships[0]?.orgId));
  const id = user._id.toHexString();

  return (
    <main className="flex min-h-dvh flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 sm:px-7">
        <Link
          href={back ? orgPath(back.slug, "my") : "/onboarding"}
          className="-ml-1 inline-flex h-7 items-center gap-0.5 rounded-md pr-2 pl-1 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronLeftIcon className="size-4" /> {back ? back.name : "New organisation"}
        </Link>
        <span className="h-4 w-px bg-border" aria-hidden />
        <h1 className="text-[15px] font-semibold tracking-[-0.01em]">Account</h1>
      </header>
      <div className="max-w-[1100px] px-4 py-6 sm:px-7">
        <div className="mb-6 flex items-center gap-3.5">
          <UserAvatar id={id} name={user.name} size={40} />
          <div className="min-w-0 leading-tight">
            <h2 className="truncate text-[18px] font-semibold tracking-[-0.015em]">{user.name}</h2>
            <div className="mt-1 truncate text-[13px] text-muted-foreground">{user.email}</div>
          </div>
        </div>
        <SettingsRow title="Profile" desc="Your name is shown to everyone in your organisations: on tasks, comments, mentions and member lists.">
          <ProfileForm name={user.name} email={user.email} />
        </SettingsRow>
      </div>
    </main>
  );
}
