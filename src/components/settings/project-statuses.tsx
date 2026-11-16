"use client";

import { useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, Trash2Icon } from "lucide-react";
import { useOrg } from "@/components/org-provider";
import { SettingsRow, useAction } from "@/components/settings/ui";
import { ColorDots } from "@/components/settings/org-settings";
import { StatusRing } from "@/components/bits";
import { projectStatuses } from "@/components/pickers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { deleteStatus, reorderStatuses, saveStatus } from "@/app/actions/org";
import { missingStages, STATUS_STAGES, type Status, type StatusCategory } from "@/lib/types";
import { requiredStageHint, STAGE_LABELS } from "@/lib/stages";

/**
 * One project's workflow statuses (VEC-117), on the project's settings page. Every project names its own
 * statuses over the fixed stages; edits here never touch another project. Admins edit, members read.
 */
export function ProjectStatuses({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { org, statusesByProject, isAdmin } = useOrg();
  const statuses = projectStatuses(statusesByProject, projectId);
  const { pending, run } = useAction();
  const [adding, setAdding] = useState(false);

  const move = (i: number, d: -1 | 1) => {
    const ids = statuses.map((s) => s.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    run(() => reorderStatuses(org.slug, projectId, ids));
  };

  return (
    <SettingsRow
      title="Statuses"
      desc={
        <>
          The statuses {projectName}&rsquo;s tasks move through, in this order. Each one sits in a stage; bots, readiness and
          cross-project views work by stage, so every project keeps at least one Backlog, Triage, Not started, Done and Cancelled
          status. Other projects aren&rsquo;t affected.
        </>
      }
    >
      <ul className="max-w-2xl divide-y divide-border rounded-[10px] border border-border" aria-label={`${projectName} statuses`}>
        {statuses.map((s, i) => (
          <StatusEditor
            key={s.id}
            status={s}
            statuses={statuses}
            canEdit={isAdmin}
            first={i === 0}
            last={i === statuses.length - 1}
            onMove={(d) => move(i, d)}
            busy={pending}
          />
        ))}
      </ul>
      {isAdmin &&
        (adding ? (
          <ul className="mt-3 max-w-2xl rounded-[10px] border border-border">
            <StatusEditor
              status={{ id: "", projectId, name: "", color: "#737373", category: "started", order: 999 }}
              statuses={statuses}
              canEdit
              isNew
              onDone={() => setAdding(false)}
              busy={pending}
            />
          </ul>
        ) : (
          <Button variant="outline" size="sm" className="mt-3" onClick={() => setAdding(true)}>
            Add status
          </Button>
        ))}
    </SettingsRow>
  );
}

function StatusEditor({
  status,
  statuses,
  canEdit,
  first,
  last,
  onMove,
  isNew,
  onDone,
  busy,
}: {
  status: Status;
  /** The project's statuses (this one included unless it's new). */
  statuses: Status[];
  canEdit: boolean;
  first?: boolean;
  last?: boolean;
  onMove?: (d: -1 | 1) => void;
  isNew?: boolean;
  onDone?: () => void;
  busy: boolean;
}) {
  const { org } = useOrg();
  // Edits start from the saved status; a live change by another admin resets an untouched editor (keyed by `status`).
  const [draft, setDraft] = useState({ of: status, name: status.name, category: status.category, color: status.color });
  if (draft.of !== status) setDraft({ of: status, name: status.name, category: status.category, color: status.color });
  const { name, category, color } = draft;
  const set = (patch: Partial<typeof draft>) => setDraft((d) => ({ ...d, ...patch }));
  const [deleting, setDeleting] = useState(false);
  const [moveTo, setMoveTo] = useState("");
  const { run } = useAction();

  const dirty = name !== status.name || category !== status.category || color !== status.color;
  const others = statuses.filter((s) => s.id !== status.id);
  // The required-stage rule, checked here so the reason shows before saving; the server enforces it too.
  const stageGap = isNew ? [] : missingStages([...others, { category }]);
  const deleteGap = isNew ? [] : missingStages(others);
  const save = () =>
    run(async () => {
      const r = await saveStatus(org.slug, { id: status.id || undefined, projectId: status.projectId, name, color, category });
      if (r.ok) onDone?.();
      return r;
    }, isNew ? "Status added" : "Status saved");
  const preview: Status = { ...status, color, category, id: status.id || "preview" };

  return (
    <li className="px-3.5 py-2.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <StatusRing status={preview} statuses={isNew ? [...statuses, preview] : statuses} size={16} />
        <ColorDots value={color} disabled={!canEdit} onChange={(c) => set({ color: c })} />
        <Input
          value={name}
          disabled={!canEdit}
          autoFocus={isNew}
          placeholder="Status name"
          onChange={(e) => set({ name: e.target.value })}
          onKeyDown={(e) => e.key === "Enter" && dirty && name.trim() && !stageGap.length && save()}
          aria-label="Status name"
          maxLength={40}
          className="h-8 w-44 border-transparent bg-transparent shadow-none hover:border-input focus-visible:border-input dark:bg-transparent"
        />
        <Select value={category} onValueChange={(v) => set({ category: v as StatusCategory })} disabled={!canEdit}>
          <SelectTrigger size="sm" className="w-36" aria-label="Stage">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_STAGES.map((v) => (
              <SelectItem key={v} value={v}>
                {STAGE_LABELS[v]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {canEdit && (
          <div className="ml-auto flex items-center gap-1">
            {(dirty || isNew) && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => (isNew ? onDone?.() : setDraft({ of: status, name: status.name, category: status.category, color: status.color }))}
                >
                  {isNew ? "Cancel" : "Discard"}
                </Button>
                <Button size="sm" onClick={save} disabled={busy || !name.trim() || stageGap.length > 0}>
                  {isNew ? "Add" : "Save"}
                </Button>
              </>
            )}
            {!isNew && (
              <>
                <Button variant="ghost" size="icon-sm" aria-label={`Move ${status.name} up`} disabled={first || busy} onClick={() => onMove?.(-1)}>
                  <ArrowUpIcon />
                </Button>
                <Button variant="ghost" size="icon-sm" aria-label={`Move ${status.name} down`} disabled={last || busy} onClick={() => onMove?.(1)}>
                  <ArrowDownIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${status.name}`}
                  title={deleteGap.length ? requiredStageHint(deleteGap) : undefined}
                  className="text-faint hover:text-destructive"
                  onClick={() => setDeleting((d) => !d)}
                  disabled={deleteGap.length > 0}
                >
                  <Trash2Icon />
                </Button>
              </>
            )}
          </div>
        )}
      </div>
      {canEdit && dirty && stageGap.length > 0 && (
        <p role="alert" className="mt-1.5 text-[12.5px] text-destructive">
          {status.name} is the project&rsquo;s only {STAGE_LABELS[status.category]} status. {requiredStageHint(stageGap)}
        </p>
      )}
      {deleting && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-lg bg-sidebar px-3 py-2 text-[13px]">
          Move its tasks to
          <Select value={moveTo} onValueChange={setMoveTo}>
            <SelectTrigger size="sm" className="w-40" aria-label="Move tasks to">
              <SelectValue placeholder="Pick a status" />
            </SelectTrigger>
            <SelectContent>
              {others.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="destructive" disabled={!moveTo} onClick={() => run(() => deleteStatus(org.slug, status.projectId, status.id, moveTo), "Status deleted")}>
            Delete {status.name}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDeleting(false)}>
            Cancel
          </Button>
        </div>
      )}
    </li>
  );
}
