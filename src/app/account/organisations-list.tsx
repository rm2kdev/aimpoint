"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
import { Tag } from "@/components/settings/ui";
import { leaveOrganisation } from "@/app/actions/account";
import { orgPath } from "@/lib/paths";
import type { Role } from "@/lib/types";

export interface AccountOrg {
  id: string;
  name: string;
  slug: string;
  role: Role;
  /** The user is its only admin, so leaving is refused until they promote someone. */
  lastAdmin: boolean;
  /** Open tasks assigned to the user there (they become unassigned on leave). */
  openAssigned: number;
}

/** Organisations the user belongs to, with their role, a link to each, and Leave (confirmed). */
export function OrganisationsList({ orgs }: { orgs: AccountOrg[] }) {
  const router = useRouter();
  const [leaving, setLeaving] = useState<AccountOrg | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!orgs.length) {
    return (
      <p className="text-[13px] text-muted-foreground">
        You aren&rsquo;t in any organisation. <Link href="/onboarding" className="underline underline-offset-2">Create one</Link> or ask for an invite.
      </p>
    );
  }

  return (
    <>
      <ul className="divide-y divide-border rounded-[10px] border border-border">
        {orgs.map((o) => (
          <li key={o.id} className="flex items-center gap-3 px-3.5 py-2.5">
            <span
              aria-hidden
              className="grid size-7 shrink-0 place-items-center rounded-md bg-chip text-[12.5px] font-semibold text-muted-foreground"
            >
              {o.name.trim().charAt(0).toUpperCase() || "?"}
            </span>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="flex items-center gap-1.5 text-[13.5px] font-medium">
                <Link href={orgPath(o.slug, "my")} className="truncate hover:underline hover:underline-offset-2">
                  {o.name}
                </Link>
                <Tag>{o.role === "admin" ? "Admin" : "Member"}</Tag>
              </span>
              <span className="mt-0.5 block truncate text-[12.5px] text-muted-foreground">
                {o.lastAdmin ? "You're its only admin. Promote someone else to admin before you leave." : orgPath(o.slug)}
              </span>
            </span>
            <Button variant="ghost" size="sm" asChild>
              <Link href={orgPath(o.slug, "my")}>Open</Link>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => {
                setError(null);
                setLeaving(o);
              }}
            >
              Leave
            </Button>
          </li>
        ))}
      </ul>

      <AlertDialog open={!!leaving} onOpenChange={(v) => !v && !pending && setLeaving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave {leaving?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              You&rsquo;ll lose access to its tasks straight away and need a new invite to come back.
              {leaving?.openAssigned
                ? ` ${leaving.openAssigned} open task${leaving.openAssigned === 1 ? "" : "s"} assigned to you will become unassigned.`
                : ""}{" "}
              Tasks and comments you wrote stay.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p role="alert" className="text-[12.5px] text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={(e) => {
                // Keep the dialog open so a refusal (e.g. last admin) is shown here.
                e.preventDefault();
                const org = leaving;
                if (!org) return;
                start(async () => {
                  const r = await leaveOrganisation(org.id).catch(() => null);
                  if (!r) return setError("Couldn't reach the server. Try again.");
                  if (!r.ok) return setError(r.error);
                  setLeaving(null);
                  toast.success(`You left ${org.name}.`);
                  router.refresh();
                });
              }}
            >
              {pending ? "Leaving…" : "Leave"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
