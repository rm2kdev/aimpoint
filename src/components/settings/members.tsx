"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CopyIcon, CreditCardIcon, Trash2Icon, UserPlusIcon } from "lucide-react";
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
import { AnalyticsLink, DetailHeader, EntityList, EntityRow, SettingsRow, Tag, useAction, WorkList } from "@/components/settings/ui";
import { createInvite, removeMember, revokeInvite, setMemberRole } from "@/app/actions/org";
import { formatDay } from "@/lib/dates";
import type { Role, Task } from "@/lib/types";
import type { InviteRow } from "@/components/settings/org-settings";
import { pendingInvitesCost, PRO_SEAT_PRICE_CENTS, seatChangeCost, TAX_NOTE, usd, type MemberBilling } from "@/lib/billing-view";
import { analyticsPath, orgPath } from "@/lib/paths";
import { analyticsSearchFor } from "@/lib/analytics-range";
import { tasksBecomeUnassigned } from "@/lib/format";

export interface MemberStats {
  assigned: number;
  created: number;
  joinedAt: string;
}

const roleLabel = (r: Role) => (r === "admin" ? "Admin" : "Member");

/* ---------------- list ---------------- */

export function MembersSettings({
  invites,
  stats,
  memberBilling = null,
}: {
  invites: InviteRow[];
  stats: Record<string, MemberStats>;
  /** VEC-414: seat cost data for the invite / remove flows (null with billing off, so nothing about cost renders). */
  memberBilling?: MemberBilling | null;
}) {
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
              avatar={<UserAvatar id={m.id} name={m.name} image={m.image} size={32} />}
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
      {isAdmin && <InviteRows invites={invites} billing={memberBilling} />}
    </>
  );
}

const seatsWord = (n: number) => `${n} ${n === 1 ? "seat" : "seats"}`;

/**
 * VEC-415: what seats cost, shown above the invite form on a paid org. Billing off (self-hosted) renders nothing.
 * An org with no live subscription is locked (Members sits behind the subscribe screen), but say "once you subscribe" anyway.
 */
function SeatNote({ billing }: { billing: MemberBilling }) {
  const now = seatChangeCost({ seats: billing.billedSeats, delta: 0 });
  return (
    <div className="mb-4 flex max-w-lg gap-2.5 rounded-[10px] border border-border bg-muted/40 px-3.5 py-2.5 text-[12.5px] text-muted-foreground" data-seat-note>
      <CreditCardIcon className="mt-0.5 size-3.5 shrink-0 text-foreground" aria-hidden />
      <p>
        <span className="font-medium text-foreground">Each person who joins is a paid seat</span> at {usd(PRO_SEAT_PRICE_CENTS)}/month {TAX_NOTE}
        {billing.liveSubscription ? "" : " once you subscribe"}. Bots are free.{" "}
        {billing.liveSubscription && (
          <>
            You&apos;re billed for <span className="tabular text-foreground">{seatsWord(now.currentSeats)}</span>:{" "}
            <span className="tabular text-foreground">{now.currentLabel}</span>.
          </>
        )}
      </p>
    </div>
  );
}

function InviteRows({ invites, billing }: { invites: InviteRow[]; billing: MemberBilling | null }) {
  const { org } = useOrg();
  // VEC-415: on a live subscription, Send invite asks first (the bill goes up once they accept).
  const [confirming, setConfirming] = useState(false);
  const sendRef = useRef<HTMLButtonElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const charge = billing?.liveSubscription ? seatChangeCost({ seats: billing.billedSeats, delta: 1 }) : null;
  const pendingCost = billing?.liveSubscription && invites.length ? pendingInvitesCost({ seats: billing.billedSeats, pending: invites.length }) : null;
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  // The last invite created here: whether it was emailed, and its link for copying either way (VEC-296).
  const [sent, setSent] = useState<{ email: string; url: string; emailed: boolean }>();
  const { pending, run } = useAction();
  const copy = (path: string, quiet = false) => {
    navigator.clipboard.writeText(`${location.origin}${path}`).catch(() => {});
    if (!quiet) toast.success("Invite link copied");
  };
  const send = () =>
    run(async () => {
      const r = await createInvite(org.slug, email, role);
      if (r.ok && r.data) {
        setSent(r.data);
        setEmail("");
        if (r.data.emailed) toast.success(`Invite sent to ${r.data.email}`);
        else {
          copy(r.data.url, true);
          toast.warning(`Couldn't email ${r.data.email}, copy the link`, { description: "The invite was created; its link is on your clipboard." });
        }
      }
      return r;
    });
  return (
    <SettingsRow title="Invite people" desc="Emails a link that works once and expires in 14 days. You can also copy the link and send it however you like.">
      {billing && <SeatNote billing={billing} />}
      <form
        className="flex max-w-lg flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (charge) setConfirming(true);
          else send();
        }}
      >
        <Input ref={emailRef} type="email" placeholder="teammate@company.com" value={email} onChange={(e) => setEmail(e.target.value)} className="min-w-56 flex-1" aria-label="Email" />
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
          <UserPlusIcon className="size-3.5" /> Send invite
        </Button>
      </form>
      {sent && (
        <p className="mt-3 flex min-w-0 items-center gap-2 text-[12.5px] text-muted-foreground" role="status">
          {sent.emailed ? (
            <span className="truncate">
              Invite sent to <span className="text-foreground">{sent.email}</span>
            </span>
          ) : (
            <span className="truncate">
              Couldn&apos;t email <span className="text-foreground">{sent.email}</span>, copy the link: <span className="font-mono text-foreground">{`${location.origin}${sent.url}`}</span>
            </span>
          )}
          <Button variant="ghost" size="icon-sm" aria-label={`Copy invite link for ${sent.email}`} onClick={() => copy(sent.url)}>
            <CopyIcon />
          </Button>
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
      {pendingCost?.label && (
        <p className="mt-2 text-[12px] text-faint" data-pending-cost>
          Not billed until accepted. If {pendingCost.pending === 1 ? "it is" : pendingCost.pending === 2 ? "both are" : `all ${pendingCost.pending} are`}, the bill goes from{" "}
          <span className="tabular">{usd(charge!.currentMonthlyCents)}</span> to{" "}
          <span className="tabular">{usd(charge!.currentMonthlyCents + pendingCost.addCents)}/month {TAX_NOTE}</span> (+{usd(pendingCost.addCents)}).
        </p>
      )}
      {charge && (
        <AlertDialog open={confirming} onOpenChange={setConfirming}>
          <AlertDialogContent
            data-seat-confirm
            onOpenAutoFocus={(e) => {
              // Enter, Enter sends: focus the confirm button, not Cancel.
              e.preventDefault();
              sendRef.current?.focus();
            }}
            onCloseAutoFocus={(e) => {
              // Opened from the form, not a trigger: hand focus back to the email field.
              e.preventDefault();
              emailRef.current?.focus();
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>Add a paid seat?</AlertDialogTitle>
              <AlertDialogDescription>
                When <span className="text-foreground">{email.trim()}</span> accepts, {org.name} is billed for {seatsWord(charge.newSeats)}: your bill goes from{" "}
                <span className="tabular text-foreground">{usd(charge.currentMonthlyCents)}</span> to{" "}
                <span className="tabular text-foreground">{charge.newLabel}</span>, prorated from the day they join. Nothing is charged if they don&apos;t accept.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction ref={sendRef} onClick={send}>
                Send invite
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </SettingsRow>
  );
}

/* ---------------- detail ---------------- */

export function MemberDetail({
  member,
  stats,
  assigned,
  memberBilling = null,
}: {
  member: { id: string; name: string; email: string; role: Role; image?: string | null };
  stats: MemberStats;
  assigned: Task[];
  /** VEC-415: seat billing for the remove dialog; loaded for admins only, null with billing off. */
  memberBilling?: MemberBilling | null;
}) {
  const { org, me, isAdmin } = useOrg();
  const router = useRouter();
  const { pending, run } = useAction();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const self = member.id === me.id;
  const back = orgPath(org.slug, "settings", "members");
  const drop = isAdmin && memberBilling?.liveSubscription ? seatChangeCost({ seats: memberBilling.billedSeats, delta: -1 }) : null;

  return (
    <>
      <DetailHeader
        back={{ href: back, label: "Members" }}
        avatar={<UserAvatar id={member.id} name={member.name} image={member.image} size={44} />}
        name={member.name}
        tags={
          <>
            {self && <Tag tone="faint">you</Tag>}
            <Tag>{roleLabel(member.role)}</Tag>
          </>
        }
        subtitle={member.email}
        action={isAdmin ? <AnalyticsLink href={analyticsPath(org.slug, analyticsSearchFor({ person: member.id }))} label={`Analytics for ${member.name}`} /> : undefined}
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
                : `${member.name} loses access to ${org.name}${stats.assigned ? ` and ${tasksBecomeUnassigned(stats.assigned)}` : ""}.`}
            </AlertDialogDescription>
            {drop && (
              <p className="text-center text-[13px] text-muted-foreground sm:text-left" data-seat-drop>
                {drop.newSeats < drop.currentSeats ? (
                  <>
                    Your bill drops by one seat: <span className="tabular text-foreground">{usd(drop.currentMonthlyCents)}</span> to{" "}
                    <span className="tabular text-foreground">{drop.newLabel}</span>, credited from the day {self ? "you leave" : "they leave"}.
                  </>
                ) : (
                  <>
                    Your bill stays at <span className="tabular text-foreground">{drop.currentLabel}</span>: the plan&apos;s minimum is 1 seat.
                  </>
                )}
              </p>
            )}
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
