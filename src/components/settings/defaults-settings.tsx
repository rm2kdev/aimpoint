"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useOrg } from "@/components/org-provider";
import { projectStatuses } from "@/components/pickers";
import { SettingsRow } from "@/components/settings/ui";
import { ProjectDot, StatusRing } from "@/components/bits";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { saveDefaults } from "@/app/actions/defaults";
import { STAGE_LABELS, stageStatus } from "@/lib/stages";
import { DEFAULT_STAGES, isDefaultStage, newTaskStatusIn, type DefaultStage } from "@/lib/types";
import { projectNewTasksPath, rolesPath } from "@/lib/paths";

const STAGE_RINGS = DEFAULT_STAGES.map(stageStatus);

/** Settings > Flows > New tasks (VEC-127/129; the Defaults tab until VEC-187): where new tasks start. Admins edit; members see it read-only. */
export function DefaultsSettings() {
  const { org, isAdmin, defaults, projects, statusesByProject } = useOrg();
  const router = useRouter();
  const [pending, start] = useTransition();
  // Optimistic value while a save is in flight; the server value (refreshed on org.changed) wins otherwise.
  const [saving, setSaving] = useState<DefaultStage | null>(null);
  const stage = saving ?? defaults.newTaskStage;
  // Projects with their own setting (VEC-191), resolved the same way as the server so a stale id never lists.
  const overrides = projects.flatMap((p) => {
    if (p.archived || !p.newTaskStatusId) return [];
    const list = projectStatuses(statusesByProject, p.id);
    const r = newTaskStatusIn(list, p.newTaskStatusId, defaults.newTaskStage, (s) => s.id);
    return r.source === "project" && r.status ? [{ project: p, status: r.status, list }] : [];
  });

  const change = (v: string) => {
    if (!isDefaultStage(v) || v === defaults.newTaskStage) return;
    setSaving(v);
    start(async () => {
      const r = await saveDefaults(org.slug, { newTaskStage: v });
      if (!r.ok) toast.error(r.error);
      else toast.success(`New tasks start in ${STAGE_LABELS[v]}`);
      router.refresh();
      setSaving(null);
    });
  };

  return (
    <SettingsRow
      id="new-tasks"
      title="New tasks"
      desc={
        <>
          Where a task starts when someone creates it without picking a status, in every project without its own setting. Each project uses its own
          status of this stage. Triage hands new
          tasks to{" "}
          <Link href={rolesPath(org.slug)} className="underline underline-offset-2 hover:text-foreground">
            triage bots
          </Link>
          , which is the first step of the flow below.
        </>
      }
    >
      <div className="grid max-w-xl gap-2">
        <Select value={stage} disabled={!isAdmin || pending} onValueChange={change}>
          <SelectTrigger className="w-full max-w-xs" aria-label="Default status for new tasks">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DEFAULT_STAGES.map((s) => (
              <SelectItem key={s} value={s}>
                <StatusRing status={stageStatus(s)} statuses={STAGE_RINGS} size={14} />
                {STAGE_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!isAdmin && <p className="text-[12.5px] text-faint">Only an admin can change this.</p>}
        <div className="mt-2 grid grid-cols-1 gap-1.5">
          <p className="text-[12.5px] text-muted-foreground">
            {overrides.length === 0
              ? `No project overrides this.${isAdmin ? " Set one on a project's settings page." : ""}`
              : `${overrides.length === 1 ? "1 project has its" : `${overrides.length} projects have their`} own setting:`}
          </p>
          {overrides.length > 0 && (
            <ul className="divide-y divide-border rounded-[10px] border border-border">
              {overrides.map(({ project, status, list }) => (
                <li key={project.id}>
                  <Link
                    href={projectNewTasksPath(org.slug, project.id)}
                    className="flex min-w-0 items-center gap-2.5 px-3.5 py-2 text-[13px] transition-colors hover:bg-accent"
                  >
                    <ProjectDot color={project.color} />
                    <span className="min-w-0 truncate font-medium">{project.name}</span>
                    <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-muted-foreground">
                      <StatusRing status={status} statuses={list} size={14} />
                      {status.name}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </SettingsRow>
  );
}
