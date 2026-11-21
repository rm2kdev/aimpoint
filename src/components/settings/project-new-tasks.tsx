"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { RotateCcwIcon } from "lucide-react";
import { toast } from "sonner";
import { useOrg } from "@/components/org-provider";
import { SettingsRow } from "@/components/settings/ui";
import { StatusRing } from "@/components/bits";
import { projectStatuses } from "@/components/pickers";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { saveProjectNewTaskStatus } from "@/app/actions/defaults";
import { STAGE_LABELS } from "@/lib/stages";
import { isDefaultStage, newTaskStatusIn, type Status } from "@/lib/types";
import { newTasksPath } from "@/lib/paths";

/** Select value for "inherit the organisation default"; never a status id. */
const INHERIT = "org-default";

/**
 * "New tasks start in" on a project's settings page (VEC-191): the project's own override of where people's new
 * tasks land (VEC-190), or the organisation default. Same inherit-vs-own pattern as the Flow row. Admins edit;
 * members see it read-only. Reads the live project from OrgBase, so org.changed updates it for every open client.
 */
export function ProjectNewTasks({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { org, isAdmin, projectById, statusesByProject, defaults } = useOrg();
  const router = useRouter();
  const [pending, start] = useTransition();
  // Optimistic value while a save is in flight (INHERIT or a status id); the server value wins otherwise.
  const [saving, setSaving] = useState<string | null>(null);
  const statuses = projectStatuses(statusesByProject, projectId);
  const open = statuses.filter((s) => isDefaultStage(s.category));
  const project = projectById.get(projectId);
  const stored = project?.newTaskStatusId ?? null;
  // An override the resolver would ignore (not one of this project's open statuses) counts as inheriting.
  const own = stored && open.some((s) => s.id === stored) ? stored : null;
  const inherited = newTaskStatusIn(statuses, null, defaults.newTaskStage, (s) => s.id);
  const value = saving ?? own ?? INHERIT;
  const orgStage = STAGE_LABELS[defaults.newTaskStage];

  const save = (v: string) => {
    if (v === (own ?? INHERIT) || pending) return;
    setSaving(v);
    start(async () => {
      const r = await saveProjectNewTaskStatus(org.slug, projectId, v === INHERIT ? null : v);
      if (!r.ok) toast.error(r.error);
      else if (v === INHERIT) toast.success(`${projectName} uses the organisation default`);
      else toast.success(`New ${projectName} tasks start in ${statuses.find((s) => s.id === v)?.name ?? "that status"}`);
      router.refresh();
      setSaving(null);
    });
  };

  const orgLink = (
    <Link href={newTasksPath(org.slug)} className="underline underline-offset-2 hover:text-foreground">
      organisation default
    </Link>
  );
  const ring = (s: Status | null | undefined) => s && <StatusRing status={s} statuses={statuses} size={14} />;

  return (
    <SettingsRow
      id="new-tasks"
      title="New tasks start in"
      desc={
        <>
          The status a task created in {projectName} from the New task dialog starts in when nobody picks one. Projects use the {orgLink} ({orgStage})
          until you choose one of their own statuses. Bots and the API still start tasks in the first not-started status; public tickets and external
          forms land in the statuses set under Public access and External forms.
        </>
      }
    >
      <div className="grid max-w-xl grid-cols-1 gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={value} disabled={!isAdmin || pending} onValueChange={save}>
            <SelectTrigger className="w-full max-w-xs" aria-label={`Status new ${projectName} tasks start in`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={INHERIT}>
                {ring(inherited.status)}
                <span className="truncate">Use organisation default ({orgStage})</span>
              </SelectItem>
              <SelectSeparator />
              {open.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {ring(s)}
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {isAdmin && own && (
            <Button size="sm" variant="ghost" className="gap-1.5 text-muted-foreground" disabled={pending} onClick={() => save(INHERIT)}>
              <RotateCcwIcon className="size-3.5" /> Reset to default
            </Button>
          )}
        </div>
        <p className="text-[12.5px] text-muted-foreground">
          {value === INHERIT
            ? `Inherited: new tasks start in ${inherited.status?.name ?? "the first status"}${inherited.source === "fallback" ? ` (${projectName} has no ${orgStage} status)` : ""}.`
            : "Set for this project. Other projects keep the organisation default."}
        </p>
        {!isAdmin && <p className="text-[12.5px] text-faint">Only an admin can change this.</p>}
      </div>
    </SettingsRow>
  );
}
