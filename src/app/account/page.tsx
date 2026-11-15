import Link from "next/link";
import { ChevronLeftIcon } from "lucide-react";
import { requireUser } from "@/lib/session";
import { cols } from "@/lib/db";
import { orgPath } from "@/lib/paths";
import { SettingsRow } from "@/components/settings/ui";
import { UserAvatar } from "@/components/bits";
import { ProfileForm } from "./profile-form";
import { PictureForm } from "./picture-form";
import { PasswordForm } from "./password-form";
import { TwoFactorForm } from "./two-factor-form";
import { EmailForm } from "./email-form";
import { SessionsForm } from "./sessions-form";
import { OrganisationsList, type AccountOrg } from "./organisations-list";
import { isClosedCategory } from "@/lib/types";
import { RECOVERY_CODE_COUNT, twoFactorStatus } from "@/lib/two-factor";
import { format } from "date-fns";

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
  const tfa = twoFactorStatus(user);
  const orgIds = memberships.map((m) => m.orgId);
  const [admins, openStatuses] = await Promise.all([
    c.memberships.aggregate<{ _id: typeof orgIds[number]; n: number }>([
      { $match: { orgId: { $in: orgIds }, role: "admin" } },
      { $group: { _id: "$orgId", n: { $sum: 1 } } },
    ]).toArray(),
    c.statuses.find({ orgId: { $in: orgIds } }, { projection: { category: 1 } }).toArray(),
  ]);
  const assigned = await c.tasks
    .aggregate<{ _id: typeof orgIds[number]; n: number }>([
      {
        $match: {
          orgId: { $in: orgIds },
          assigneeId: user._id,
          statusId: { $in: openStatuses.filter((s) => !isClosedCategory(s.category)).map((s) => s._id) },
        },
      },
      { $group: { _id: "$orgId", n: { $sum: 1 } } },
    ])
    .toArray();
  const count = (rows: { _id: typeof orgIds[number]; n: number }[], id: typeof orgIds[number]) => rows.find((r) => r._id.equals(id))?.n ?? 0;
  const accountOrgs: AccountOrg[] = memberships.flatMap((m) => {
    const o = orgs.find((x) => x._id.equals(m.orgId));
    if (!o) return [];
    return [{
      id: o._id.toHexString(),
      name: o.name,
      slug: o.slug,
      role: m.role,
      lastAdmin: m.role === "admin" && count(admins, o._id) <= 1,
      openAssigned: count(assigned, o._id),
    }];
  });

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
          <UserAvatar id={id} name={user.name} image={user.image} size={40} />
          <div className="min-w-0 leading-tight">
            <h2 className="truncate text-[18px] font-semibold tracking-[-0.015em]">{user.name}</h2>
            <div className="mt-1 truncate text-[13px] text-muted-foreground">{user.email}</div>
          </div>
        </div>
        <SettingsRow title="Profile" desc="Your name is shown to everyone in your organisations: on tasks, comments, mentions and member lists.">
          <ProfileForm name={user.name} />
        </SettingsRow>
        <SettingsRow title="Picture" desc="Shown next to your name on tasks, comments, mentions and member lists in every organisation you belong to.">
          <PictureForm key={user.image ?? "none"} id={id} name={user.name} image={user.image ?? null} />
        </SettingsRow>
        <SettingsRow
          title="Email"
          desc={
            tfa.enabled
              ? "The address you sign in with. Changing it needs your password and a two-factor code."
              : "The address you sign in with. Changing it needs your password."
          }
        >
          <EmailForm key={user.email} email={user.email} twoFactor={tfa.enabled} />
        </SettingsRow>
        <SettingsRow title="Password" desc="Changing your password keeps you signed in here and signs you out on every other browser and device.">
          <PasswordForm />
        </SettingsRow>
        <SettingsRow
          title="Two-factor authentication"
          desc="Ask for a code from an authenticator app as well as your password when you sign in. Recovery codes get you in if you lose your phone."
        >
          <TwoFactorForm
            enabled={tfa.enabled}
            enabledLabel={tfa.enabledAt ? format(new Date(tfa.enabledAt), "d MMM yyyy") : null}
            recoveryCodesLeft={tfa.recoveryCodesLeft}
            total={RECOVERY_CODE_COUNT}
          />
        </SettingsRow>
        <SettingsRow
          title="Sessions"
          desc="Signed in somewhere you no longer use? Sign out every other browser and device. You stay signed in here."
        >
          <SessionsForm />
        </SettingsRow>
        <SettingsRow
          title="Organisations"
          desc="Organisations you belong to and your role in each. Leaving unassigns your open tasks there. An organisation always keeps at least one admin."
        >
          <OrganisationsList orgs={accountOrgs} />
        </SettingsRow>
      </div>
    </main>
  );
}
