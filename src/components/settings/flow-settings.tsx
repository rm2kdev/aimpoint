"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRightIcon, RotateCcwIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useOrg } from "@/components/org-provider";
import { SettingsRow } from "@/components/settings/ui";
import { ProjectTile } from "@/components/settings/org-settings";
import { FlowEditor, FlowPreview } from "@/components/settings/flow-editor";
import { projectStatuses } from "@/components/pickers";
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
import { resetOrgFlow, resetProjectFlow, saveOrgFlow, saveProjectFlow, setProjectFlowMode } from "@/app/actions/flows";
import { orgPath } from "@/lib/paths";
import type { FlowMode, FlowStep } from "@/lib/flow-model";
import type { OrgFlowSettings as OrgFlowData, ProjectFlowSettings, ProjectFlowSummary } from "@/lib/flows";

/** Flow settings screens (VEC-177): Settings > Flows (org default) and the Flow row on a project's settings page. */

const MODE_LABELS: Record<FlowMode, string> = { inherit: "Org default", custom: "Custom", off: "Off" };

function ResetDialog({
  open,
  onOpenChange,
  title,
  body,
  action,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  body: string;
  action: string;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{action}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/* ---------------- org default ---------------- */

export function OrgFlowSettings({ flow, projects, counts }: { flow: OrgFlowData; projects: ProjectFlowSummary[]; counts: Record<string, number> }) {
  const { org, isAdmin } = useOrg();
  const router = useRouter();
  const [confirmReset, setConfirmReset] = useState(false);
  const [pending, start] = useTransition();

  const skippedIn: Record<string, string[]> = {};
  for (const p of projects) for (const id of p.skipped) (skippedIn[id] ??= []).push(p.key);
  const inheriting = projects.filter((p) => p.mode === "inherit");

  const save = async (steps: FlowStep[]) => {
    const r = await saveOrgFlow(org.slug, steps);
    if (r.ok) router.refresh();
    return r;
  };

  return (
    <>
      <SettingsRow
        id="default-flow"
        title="Default flow"
        desc={
          <>
            The steps a task goes through and who owns each one. When a step is finished, Vector moves the task to the next step&rsquo;s status and hands it to
            that step&rsquo;s owner, with its instructions. Steps name a stage, so every project uses its own status of that stage. Projects follow this flow unless
            they have their own.
          </>
        }
      >
        <FlowEditor
          label="Default flow"
          level="org"
          steps={flow.steps}
          version={flow.version}
          counts={counts}
          skippedIn={skippedIn}
          canEdit={isAdmin}
          onSave={save}
          footer={
            <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" disabled={pending} onClick={() => setConfirmReset(true)}>
              <RotateCcwIcon className="size-3.5" /> Reset to the standard flow
            </Button>
          }
        />
        {!isAdmin && <p className="mt-2 text-[12.5px] text-faint">Only an admin can change the flow.</p>}
      </SettingsRow>

      <SettingsRow
        title="Projects"
        desc={
          <>
            {inheriting.length === projects.length
              ? "Every project follows the default flow."
              : `${inheriting.length} of ${projects.length} projects follow the default flow.`}{" "}
            Give a project its own flow, or switch flows off, on its settings page.
          </>
        }
      >
        <ul className="max-w-3xl divide-y divide-border rounded-[10px] border border-border">
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                href={`${orgPath(org.slug, "settings", "projects", p.id)}#flow`}
                className="group flex items-center gap-3 px-3.5 py-2.5 transition-colors first:rounded-t-[10px] last:rounded-b-[10px] hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              >
                <ProjectTile color={p.color} size={22} />
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="flex items-center gap-1.5 text-[13.5px] font-medium">
                    <span className="truncate">{p.name}</span>
                    <span className="font-mono text-[12px] font-normal text-faint">{p.key}</span>
                  </span>
                  {p.skipped.length > 0 && (
                    <span className="mt-0.5 block truncate text-[12.5px] text-muted-foreground">
                      Skips {p.skipped.map((id) => flow.steps.find((s) => s.id === id)?.name ?? id).join(", ")}
                    </span>
                  )}
                </span>
                <span className={cn("shrink-0 rounded-[4px] px-1.5 py-px text-[11.5px] font-medium", p.mode === "inherit" ? "text-faint" : "bg-chip text-muted-foreground")}>
                  {p.mode === "inherit" ? "Default flow" : p.mode === "custom" ? "Own flow" : "Flows off"}
                </span>
                <ChevronRightIcon className="size-4 shrink-0 text-faint transition-transform group-hover:translate-x-0.5" />
              </Link>
            </li>
          ))}
        </ul>
      </SettingsRow>

      <ResetDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="Reset the default flow?"
        body="This puts back the standard flow: Triage (any triage bot), Build and an optional Review that keep the assignee, then Done. Owners and instructions you set here are lost. Projects with their own flow aren't affected."
        action="Reset flow"
        onConfirm={() =>
          start(async () => {
            const r = await resetOrgFlow(org.slug);
            if (!r.ok) return void toast.error(r.error);
            toast.success("Default flow reset");
            router.refresh();
          })
        }
      />
    </>
  );
}

/* ---------------- project ---------------- */

export function ProjectFlow({ projectId, projectName, flow, counts }: { projectId: string; projectName: string; flow: ProjectFlowSettings; counts: Record<string, number> }) {
  const { org, isAdmin, statusesByProject } = useOrg();
  const statuses = projectStatuses(statusesByProject, projectId);
  const router = useRouter();
  const [pending, start] = useTransition();
  // Optimistic mode while the switch is saving; the server value (refreshed on org.changed) wins after.
  const [switching, setSwitching] = useState<FlowMode | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const mode = switching ?? flow.mode;

  const setMode = (m: FlowMode) => {
    if (m === flow.mode || pending) return;
    setSwitching(m);
    start(async () => {
      const r = await setProjectFlowMode(org.slug, projectId, m);
      if (!r.ok) toast.error(r.error);
      else toast.success(m === "custom" ? `${projectName} has its own flow` : m === "off" ? `Flows are off for ${projectName}` : `${projectName} follows the default flow`);
      router.refresh();
      setSwitching(null);
    });
  };
  const save = async (steps: FlowStep[]) => {
    const r = await saveProjectFlow(org.slug, projectId, steps);
    if (r.ok) router.refresh();
    return r;
  };
  const reset = () =>
    start(async () => {
      const r = await resetProjectFlow(org.slug, projectId);
      if (!r.ok) return void toast.error(r.error);
      toast.success(`${projectName} follows the default flow`);
      router.refresh();
    });
  const defaultLink = (
    <Link href={`${orgPath(org.slug, "settings", "flows")}#default-flow`} className="underline underline-offset-2 hover:text-foreground">
      default flow
    </Link>
  );

  return (
    <SettingsRow
      id="flow"
      title="Flow"
      desc={
        <>
          The steps {projectName}&rsquo;s tasks go through and who owns each. Projects follow the organisation&rsquo;s {defaultLink} until you customise it; a custom
          flow uses {projectName}&rsquo;s own statuses. With flows off, tasks move only when someone moves them.
        </>
      }
    >
      <div className="grid max-w-3xl grid-cols-1 gap-4">
        <div role="radiogroup" aria-label={`${projectName} flow`} className="inline-flex w-fit max-w-full rounded-lg border border-border p-0.5">
          {(["inherit", "custom", "off"] as FlowMode[]).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              disabled={!isAdmin || pending}
              onClick={() => setMode(m)}
              className={cn(
                "h-7 rounded-md px-3 text-[13px] transition-colors disabled:cursor-not-allowed",
                mode === m ? "bg-accent font-medium text-foreground" : "text-muted-foreground enabled:hover:text-foreground",
              )}
            >
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>

        {mode === "inherit" && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
              <span className="min-w-0 flex-1">
                Using the org default.
                {flow.hasOwn && " Its own flow is kept: choose Custom to use it again."}
              </span>
              {isAdmin && (
                <Button size="sm" variant="outline" disabled={pending} onClick={() => setMode("custom")}>
                  {flow.hasOwn ? "Use its own flow" : "Customise for this project"}
                </Button>
              )}
              {isAdmin && flow.hasOwn && (
                <Button size="sm" variant="ghost" className="gap-1.5" disabled={pending} onClick={() => setConfirmReset(true)}>
                  <RotateCcwIcon className="size-3.5" /> Delete its own flow
                </Button>
              )}
            </div>
            {flow.resolved && <FlowPreview flow={flow.resolved} statuses={statuses} label={`${projectName} flow (org default)`} />}
          </>
        )}

        {mode === "custom" && flow.mode === "custom" && flow.steps && (
          <FlowEditor
            label={`${projectName} flow`}
            level="project"
            steps={flow.steps}
            version={flow.version ?? 0}
            statuses={statuses}
            counts={counts}
            canEdit={isAdmin}
            onSave={save}
            footer={
              <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" disabled={pending} onClick={() => setConfirmReset(true)}>
                <RotateCcwIcon className="size-3.5" /> Reset to default
              </Button>
            }
          />
        )}
        {mode === "custom" && flow.mode !== "custom" && <p className="text-[13px] text-muted-foreground">Copying the default flow onto {projectName}&rsquo;s statuses…</p>}

        {mode === "off" && (
          <p className="rounded-lg border border-border bg-sidebar px-3.5 py-2.5 text-[13px] text-muted-foreground">
            Flows are off for {projectName}. Finishing a task doesn&rsquo;t hand it to anyone; people and bots move it themselves.
          </p>
        )}
        {!isAdmin && <p className="text-[12.5px] text-faint">Only an admin can change the flow.</p>}
      </div>

      <ResetDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title={`Reset ${projectName} to the default flow?`}
        body={`This deletes ${projectName}'s own flow, with its owners and instructions, and the project follows the organisation's default flow again.`}
        action="Reset to default"
        onConfirm={reset}
      />
    </SettingsRow>
  );
}
