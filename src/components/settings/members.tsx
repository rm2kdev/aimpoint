"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CopyIcon, Trash2Icon, UserPlusIcon } from "lucide-react";
import { toast } from "sonner";
import { useOrg } from "@/components/org-provider";
import { UserAvatar } from "@/components/bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DetailHeader, EntityList, EntityRow, SettingsRow, Tag, useAction, WorkList } from "@/components/settings/ui";
import { createInvite, removeMember, revokeInvite, setMemberRole } from "@/app/actions/org";
import { formatDay } from "@/lib/dates";
import type { Role, Task } from "@/lib/types";
import type { InviteRow } from "@/components/settings/org-settings";
import { orgPath } from "@/lib/paths";

export interface MemberStats {
  assigned: number;
  created: number;
  joinedAt: string;
}

const roleLabel = (r: Role) => (r === "admin" ? "Admin" : "Member");

/* ---------------- list ---------------- */

export function MembersSettings({ invites, stats }: { invites: InviteRow[]; stats: Record<string, MemberStats> }) {
  const { org, members, me, isAdmin } = useOrg();
  const people = members.filter((m) => m.kind === "user");
  return (
    <>
      <SettingsRow
        title="Members"
        desc={
          <>
            People in {org.name}. Admins manage members, bots, projects and statuses; members create and work on tasks. Open someone to change
            their role or remove them.
          </>
        }
      >
        <EntityList>
          {people.map((m) => (
            <EntityRow
              key={m.id}
              href={orgPath(org.slug, "settings", "members", m.id)}
              avatar={<UserAvatar id={m.id} name={m.name} size={32} />}
              name={m.name}
              tags={
                <>
                  {m.id === me.id && <Tag tone="faint">you</Tag>}
                  {m.role === "admin" && <Tag>Admin</Tag>}
                </>
              }
              subtitle={m.email}
              meta={
                stats[m.id] && (
                  <>
                    <div>{stats[m.id].assigned} assigned · {stats[m.id].created} created</div>
                    <div className="mt-0.5">Joined {formatDay(stats[m.id].joinedAt)}</div>
                  </>
                )
              }
            />
          ))}
        </EntityList>
      </SettingsRow>
      {isAdmin && <InviteRows invites={invites} />}
    </>
  );
}

function InviteRows({ invites }: { invites: InviteRow[] }) {
  const { org } = useOrg();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [link, setLink] = useState<string>();
  const { pending, run } = useAction();
  const copy = (path: string) => {
    navigator.clipboard.writeText(`${location.origin}${path}`);
    toast.success("Invite link copied");
  };
  return (
    <SettingsRow title="Invite people" desc="Creates a link that works once and expires in 14 days. Send it however you like.">
      <form
        className="flex max-w-lg flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const r = await createInvite(org.slug, email, role);
            if (r.ok && r.data) {
              setLink(r.data.url);
              setEmail("");
              copy(r.data.url);
            }
            return r;
          });
        }}
      >
        <Input type="email" placeholder="teammate@company.com" value={email} onChange={(e) => setEmail(e.target.value)} className="min-w-56 flex-1" aria-label="Email" />
        <Select value={role} onValueChange={(v) => setRole(v as Role)}>
          <SelectTrigger className="w-28" aria-label="Role">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="member">Member</SelectItem>
            <SelectItem value="admin">Admin</SelectItem>
          </SelectContent>
        </Select>
        <Button type="submit" disabled={pending || !email.trim()} className="gap-2">
          <UserPlusIcon className="size-3.5" /> Create invite
        </Button>
      </form>
      {link && (
        <p className="mt-3 flex items-center gap-2 text-[12.5px] text-muted-foreground">
          Link copied: <span className="truncate font-mono text-foreground">{link}</span>
        </p>
      )}
      {invites.length > 0 && (
        <ul className="mt-5 divide-y divide-border rounded-[10px] border border-border">
          {invites.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-3 px-3.5 py-2">
              <span className="min-w-0 flex-1 truncate text-[13px]">{i.email}</span>
              <span className="text-[12px] text-faint">{roleLabel(i.role)} · pending</span>
              <Button variant="ghost" size="icon-sm" aria-label={`Copy invite link for ${i.email}`} onClick={() => copy(`/invite/${i.token}`)}>
                <CopyIcon />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label={`Revoke invite for ${i.email}`} onClick={() => run(() => revokeInvite(org.slug, i.id), "Invite revoked")}>
                <Trash2Icon />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SettingsRow>
  );
}

/* ---------------- detail ---------------- */

export function MemberDetail({
  member,
  stats,
  assigned,
}: {
  member: { id: string; name: string; email: string; role: Role };
  stats: MemberStats;
  assigned: Task[];
}) {
  const { org, me, isAdmin } = useOrg();
  const router = useRouter();
  const { pending, run } = useAction();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const self = member.id === me.id;
  const back = orgPath(org.slug, "settings", "members");

  return (
    <>
      <DetailHeader
        back={{ href: back, label: "Members" }}
        avatar={<UserAvatar id={member.id} name={member.name} size={44} />}
        name={member.name}
        tags={
          <>
            {self && <Tag tone="faint">you</Tag>}
            <Tag>{roleLabel(member.role)}</Tag>
          </>
        }
        subtitle={member.email}
      />

      <SettingsRow title="Profile" desc={<>How {self ? "you appear" : `${member.name.split(" ")[0]} appears`} on tasks, in the assignee picker and in activity.</>}>
        <dl className="grid max-w-xl grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-[13px]">
          <dt className="text-faint">Name</dt>
          <dd>{member.name}</dd>
          <dt className="text-faint">Email</dt>
          <dd className="truncate">{member.email}</dd>
          <dt className="text-faint">Joined</dt>
          <dd>{formatDay(stats.joinedAt)}</dd>
          <dt className="text-faint">Tasks</dt>
          <dd className="tabular">
            {stats.assigned} assigned · {stats.created} created
          </dd>
        </dl>
      </SettingsRow>

      <SettingsRow title="Role" desc="Admins manage members, bots, projects and statuses. An organisation always keeps at least one admin.">
        {isAdmin ? (
          <Select value={member.role} disabled={pending} onValueChange={(v) => run(() => setMemberRole(org.slug, member.id, v as Role), "Role updated")}>
            <SelectTrigger className="w-36" aria-label={`Role for ${member.name}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="admin">Admin</SelectItem>
              <SelectItem value="member">Member</SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <p className="text-[13px]">{roleLabel(member.role)}</p>
        )}
      </SettingsRow>

      <SettingsRow title="Work" desc={`Open tasks assigned to ${self ? "you" : member.name.split(" ")[0]}.`}>
        <WorkList tasks={assigned} emptyText={`Nothing is assigned to ${self ? "you" : member.name.split(" ")[0]} right now.`} />
      </SettingsRow>

      {(isAdmin || self) && (
        <SettingsRow
          title={self ? "Leave organisation" : "Remove member"}
          desc={
            self
              ? "You'll lose access to its tasks. Tasks assigned to you become unassigned."
              : "They lose access straight away and their tasks become unassigned. Tasks and comments they wrote stay."
          }
        >
          <Button variant="destructive" onClick={() => setConfirmRemove(true)}>
            <Trash2Icon /> {self ? `Leave ${org.name}` : `Remove ${member.name}`}
          </Button>
        </SettingsRow>
      )}

      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{self ? `Leave ${org.name}?` : `Remove ${member.name}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {self
                ? "You'll need a new invite to come back."
                : `${member.name} loses access to ${org.name}${stats.assigned ? ` and ${stats.assigned} task${stats.assigned === 1 ? "" : "s"} become unassigned` : ""}.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() =>
                run(
                  () => removeMember(org.slug, member.id),
                  self ? `You left ${org.name}` : `Removed ${member.name}`,
                  () => router.push(self ? "/" : back),
                )
              }
            >
              {self ? "Leave" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
