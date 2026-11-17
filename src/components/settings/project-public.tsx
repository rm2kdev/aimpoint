"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckIcon, CopyIcon, ExternalLinkIcon, GlobeIcon, TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";
import { useOrg } from "@/components/org-provider";
import { SettingsRow, Tag } from "@/components/settings/ui";
import { StatusRing } from "@/components/bits";
import { projectStatuses } from "@/components/pickers";
import { useCopy, useOrigin } from "@/components/settings/project-forms";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
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
import { setProjectPublicAccess } from "@/app/actions/project-public";
import { STAGE_LABELS } from "@/lib/stages";
import { publicProjectPath } from "@/lib/paths";
import { UpgradeNote } from "@/components/upgrade-note";
import { isFormDestinationStage, type ProjectPublicAccess, type Status } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Public access (VEC-256) on a project's settings page, under External forms. Admins switch the project public,
 * pick the statuses signed-in accounts may submit into (this project's backlog / triage / not-started statuses; the
 * first is the default) and whether comments show publicly. Members see the same state read-only. `access` comes
 * from the server render; every save refreshes it, and other admins' saves arrive through org.changed.
 */

type Patch = { enabled?: boolean; submitStatusIds?: string[]; showComments?: boolean };

/** Allowed statuses in saved order: the default first, the rest in the project's status order. */
function ordered(ids: string[], destinations: Status[]): string[] {
  const set = new Set(ids);
  const first = ids.find((id) => destinations.some((s) => s.id === id));
  const rest = destinations.filter((s) => set.has(s.id) && s.id !== first).map((s) => s.id);
  return first ? [first, ...rest] : [];
}

export function ProjectPublic({
  projectId,
  projectKey,
  projectName,
  archived,
  access,
}: {
  projectId: string;
  projectKey: string;
  projectName: string;
  archived: boolean;
  access: ProjectPublicAccess;
}) {
  const { org, isAdmin, statusesByProject, billing, memberById } = useOrg();
  const locked = !billing.features.publicForms;
  const router = useRouter();
  const origin = useOrigin();
  const { copied, copy } = useCopy();
  const [pending, start] = useTransition();
  // Optimistic values while a save is in flight; the server render takes over once it refreshes.
  const [draft, setDraft] = useState<Patch | null>(null);
  const [confirming, setConfirming] = useState(false);

  const statuses = projectStatuses(statusesByProject, projectId);
  const destinations = statuses.filter((s) => isFormDestinationStage(s.category));
  const statusById = new Map(statuses.map((s) => [s.id, s]));

  const enabled = draft?.enabled ?? access.enabled;
  const showComments = draft?.showComments ?? access.showComments;
  const allowed = ordered(draft?.submitStatusIds ?? access.submitStatusIds, destinations);
  const path = publicProjectPath(org.slug, projectKey);
  const url = `${origin}${path}`;
  const updatedBy = access.updatedBy ? memberById.get(access.updatedBy)?.name : null;

  const save = (patch: Patch, success: string) => {
    setDraft((d) => ({ ...d, ...patch }));
    start(async () => {
      const r = await setProjectPublicAccess(org.slug, projectId, patch);
      if (!r.ok) toast.error(r.error);
      else toast.success(success);
      router.refresh();
      setDraft(null);
    });
  };

  const setAllowed = (ids: string[]) => {
    const next = ordered(ids, destinations);
    save({ submitStatusIds: next }, next.length ? "Submit statuses saved" : "Public submissions switched off");
  };
  const toggleStatus = (s: Status, on: boolean) => setAllowed(on ? [...allowed, s.id] : allowed.filter((id) => id !== s.id));
  const makeDefault = (s: Status) => setAllowed([s.id, ...allowed.filter((id) => id !== s.id)]);

  const desc = (
    <>
      Make {projectName} readable by anyone with the link, and let any signed-in Aimpoint account, not only members of {org.name}, submit tickets into
      it. Submitted tickets show who sent them.
    </>
  );

  const warning = (
    <p
      data-public-warning
      className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-[13px] text-foreground"
      role="note"
    >
      <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-destructive" />
      <span>
        Everything in {projectName} becomes readable by anyone on the internet, signed in or not: every ticket&rsquo;s title, description, type, status and
        images{showComments ? ", and its comments" : ""}. Archived tickets stay hidden. Don&rsquo;t make it public if it holds anything private.
      </span>
    </p>
  );

  const link = (
    <div className="flex items-center gap-1.5">
      <code className="min-w-0 flex-1 truncate rounded-md bg-sidebar px-2 py-1.5 font-mono text-[12px] text-muted-foreground" title={url} data-public-url>
        {url || path}
      </code>
      <Button variant="outline" size="sm" className="gap-1.5" onClick={() => copy("public-link", url, "Link")} aria-label={`Copy the public link to ${projectName}`}>
        {copied === "public-link" ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />} Copy link
      </Button>
      <Button variant="ghost" size="icon-sm" asChild>
        <a href={path} target="_blank" rel="noopener noreferrer" aria-label={`Open the public page of ${projectName}`} title="Open the public page">
          <ExternalLinkIcon />
        </a>
      </Button>
    </div>
  );

  const lockedNote = locked && enabled && (
    <p data-public-locked className="rounded-lg border border-border bg-sidebar px-3.5 py-2.5 text-[13px] text-muted-foreground">
      Without a Pro subscription the public page shows &ldquo;unavailable&rdquo; to visitors and nobody can submit. Settings are kept.
    </p>
  );

  // Members: the same facts, read-only.
  if (!isAdmin) {
    return (
      <SettingsRow id="public" title="Public access" desc={desc}>
        <div className="grid max-w-2xl gap-3" data-public-readonly>
          <p className="flex items-center gap-2 text-[13px]">
            {enabled ? <PublicBadge /> : <Tag>Private</Tag>}
            <span className="text-muted-foreground">{enabled ? `${projectName} is public.` : `${projectName} is visible to members only.`}</span>
          </p>
          {lockedNote}
          {enabled && (
            <>
              {link}
              <dl className="grid grid-cols-[150px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
                <dt className="text-faint">Submissions into</dt>
                <dd className="text-muted-foreground">
                  {allowed.length ? allowed.map((id, i) => `${statusById.get(id)?.name ?? "Unknown status"}${i === 0 && allowed.length > 1 ? " (default)" : ""}`).join(", ") : "Nobody can submit (read-only)"}
                </dd>
                <dt className="text-faint">Comments</dt>
                <dd className="text-muted-foreground">{showComments ? "Shown publicly" : "Hidden"}</dd>
              </dl>
            </>
          )}
          <p className="text-[12.5px] text-faint">Only an admin can change this.</p>
        </div>
      </SettingsRow>
    );
  }

  const canEnable = !archived && !locked;

  return (
    <SettingsRow id="public" title="Public access" desc={desc}>
      <div className="grid max-w-2xl gap-4" data-public-settings>
        {warning}
        {lockedNote}

        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[13.5px] font-medium">
              Public project {enabled && <PublicBadge />}
            </div>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">
              {enabled ? "Anyone with the link can read it." : "Off: only members of this organisation can see it."}
              {enabled && updatedBy && access.updatedAt && <> Last changed by {updatedBy}.</>}
            </p>
          </div>
          <Switch
            checked={enabled}
            disabled={pending || (!enabled && !canEnable)}
            onCheckedChange={(v) => (v ? setConfirming(true) : save({ enabled: false }, `${projectName} is private again`))}
            aria-label={enabled ? `Make ${projectName} private` : `Make ${projectName} public`}
          />
        </div>
        {!enabled && locked && <UpgradeNote className="-mt-2" reason="Public projects need a Pro subscription." gain="public projects" />}
        {!enabled && archived && <p className="-mt-2 text-[12.5px] text-faint">Restore the project to make it public.</p>}

        {enabled && link}

        <fieldset className={cn("grid gap-2", !enabled && "opacity-60")} disabled={pending}>
          <legend className="text-[13.5px] font-medium">Who can submit tickets</legend>
          <p className="-mt-1 text-[12.5px] text-muted-foreground">
            Any signed-in Aimpoint account can submit into the statuses you tick. The default is where a ticket lands unless the submitter picks another.
            Tick none to keep the project read-only.
          </p>
          {destinations.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">{projectName} has no backlog, triage or not-started statuses to submit into.</p>
          ) : (
            <ul className="divide-y divide-border rounded-[10px] border border-border" aria-label="Statuses people can submit into">
              {destinations.map((s) => {
                const on = allowed.includes(s.id);
                const isDefault = allowed[0] === s.id;
                return (
                  <li key={s.id} className="flex h-10 items-center gap-2.5 px-3.5" data-submit-status={s.id}>
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-[13px]">
                      <input type="checkbox" checked={on} onChange={(e) => toggleStatus(s, e.target.checked)} className="size-3.5 accent-primary" />
                      <StatusRing status={s} statuses={statuses} size={12} />
                      <span className="truncate">{s.name}</span>
                      {STAGE_LABELS[s.category] !== s.name && <span className="text-[12px] text-faint">{STAGE_LABELS[s.category]}</span>}
                    </label>
                    {isDefault ? (
                      <Tag>Default</Tag>
                    ) : (
                      on && (
                        <Button variant="ghost" size="sm" className="h-7 text-[12.5px]" onClick={() => makeDefault(s)}>
                          Make default
                        </Button>
                      )
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>

        <div className={cn("flex items-start gap-3", !enabled && "opacity-60")}>
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-medium">Show comments publicly</div>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">Comments appear on the public page with the author&rsquo;s display name only.</p>
          </div>
          <Switch
            checked={showComments}
            disabled={pending}
            onCheckedChange={(v) => save({ showComments: v }, v ? "Comments are shown publicly" : "Comments are hidden from the public page")}
            aria-label="Show comments publicly"
          />
        </div>
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Make {projectName} public?</AlertDialogTitle>
            <AlertDialogDescription>
              Anyone with the link, signed in or not, can read every ticket in {projectName}: titles, descriptions, statuses and images
              {showComments ? ", and comments" : ""}. Search engines may find it. You can make it private again at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep private</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={() => {
                setConfirming(false);
                save({ enabled: true }, `${projectName} is public`);
              }}
            >
              Make public
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsRow>
  );
}

/** Small neutral "Public" chip for a public project (settings, project header). */
export function PublicBadge({ className }: { className?: string }) {
  return (
    <span
      data-public-badge
      title="Public project: anyone with the link can read it"
      className={cn("inline-flex h-5 shrink-0 items-center gap-1 rounded-[5px] bg-chip px-1.5 text-[11.5px] font-medium text-muted-foreground", className)}
    >
      <GlobeIcon aria-hidden className="size-3" />
      Public
    </span>
  );
}
