"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useOrg } from "@/components/org-provider";
import { MemberAvatar, PriorityIcon, ProjectDot, StatusRing, UnassignedAvatar } from "@/components/bits";
import { Picker, PRIORITY_OPTIONS, useAssigneeOptions, useProjectOptions, useStatusOptions } from "@/components/pickers";
import { DueBadge, DuePicker } from "@/components/due-date";
import { CalendarIcon, CornerLeftUpIcon, HourglassIcon, XIcon } from "lucide-react";
import { createTask } from "@/app/actions/tasks";
import { PRIORITY_LABELS } from "@/lib/format";
import { matchStatus, newTaskStatusIn, type Priority, type Status, type StatusCategory, type Task, type TaskRef, type TaskType } from "@/lib/types";
import { TaskSearchPicker, toRef } from "@/components/dependencies";
import { parkedPickerNote, useParkedIn } from "@/components/parked";
import { COMPOSER_CHIP as chip, TaskComposer } from "@/components/task-composer";

export interface NewTaskDefaults {
  projectId?: string;
  /** An explicit status (e.g. a project view's status group). Wins over `stage` and the org default. */
  statusId?: string;
  /** Start in the chosen project's status of this stage (a cross-project view's stage group). */
  stage?: StatusCategory;
  assigneeId?: string | null;
  type?: TaskType;
  /** Start with these dependencies (e.g. "Next task" from a task's pane). */
  dependsOn?: TaskRef[];
  /** VEC-428: create it as a sub-task of this task (the pane's "New sub-task"). Shown as a removable chip. */
  parent?: TaskRef;
}

/** Local echo so the creator's list updates even before the real-time event lands. */
export function emitLocalTask(task: Task) {
  window.dispatchEvent(new CustomEvent<Task>("aimpoint:task", { detail: task }));
}

export function NewTaskDialog({ defaults, onClose }: { defaults: NewTaskDefaults | null; onClose: () => void }) {
  const { org, projects, statusById, statusesByProject, memberById, projectById, defaults: orgDefaults } = useOrg();
  const router = useRouter();
  const open = defaults !== null;

  const [projectId, setProjectId] = useState("");
  // "" = nothing explicit: the status follows the project and the stage (the caller's, else the org default).
  const [statusId, setStatusId] = useState("");
  const [stage, setStage] = useState<StatusCategory | null>(null);
  const [assigneeId, setAssigneeId] = useState<string | null>(null);
  const [priority, setPriority] = useState<Priority>(0);
  const [type, setType] = useState<TaskType>("issue");
  const [dueDate, setDueDate] = useState<string | null>(null);
  const [deps, setDeps] = useState<TaskRef[]>([]);
  const [parent, setParent] = useState<TaskRef | null>(null);
  // Remounts the composer on every open: empty title, fresh editor, no errors (VEC-357).
  const [composerKey, setComposerKey] = useState(0);

  useEffect(() => {
    if (!defaults) return;
    const active = projects.filter((p) => !p.archived);
    setProjectId(active.find((p) => p.id === defaults.projectId)?.id ?? active[0]?.id ?? "");
    setStatusId(defaults.statusId ?? "");
    setStage(defaults.stage ?? null);
    setAssigneeId(defaults.assigneeId ?? null);
    setPriority(0);
    setType(defaults.type ?? "issue");
    setDueDate(null);
    setDeps(defaults.dependsOn ?? []);
    setParent(defaults.parent ?? null);
    setComposerKey((k) => k + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaults]);

  const statusOptions = useStatusOptions(projectId);
  const assigneeOptions = useAssigneeOptions();
  const projectOptions = useProjectOptions();
  const project = projectById.get(projectId);
  // Statuses are per project (VEC-115): a status picked for (or defaulted from) another project maps to this one's counterpart.
  // The picker lists only the chosen project's statuses and follows a project change (VEC-117).
  const projectStatuses = statusesByProject.get(projectId) ?? [];
  const picked = statusById.get(statusId);
  // With no explicit status, preselect the caller's stage (a stage group), else the project's own new-task status
  // (VEC-191), else its first status of the org default stage (VEC-129), the same rule the server applies. Derived
  // at render, so a project change or a teammate's change to either setting (org.changed) re-picks it live until
  // the person picks one.
  const byStage = (c: StatusCategory): Status | undefined => projectStatuses.find((s) => s.category === c);
  const status =
    picked?.projectId === projectId
      ? picked
      : ((picked && matchStatus(projectStatuses, picked)) ??
        (stage ? byStage(stage) : undefined) ??
        newTaskStatusIn(projectStatuses, project?.newTaskStatusId, orgDefaults.newTaskStage, (s) => s.id).status ??
        undefined);
  const assignee = assigneeId ? memberById.get(assigneeId) : undefined;
  // VEC-276: creating it in Backlog with a bot assignee parks it; the bot starts when it leaves Backlog.
  const parkedIn = useParkedIn(projectId, status?.id);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent showCloseButton={false} className="top-[14vh] translate-y-0 gap-0 p-0 sm:max-w-[640px]">
        <DialogTitle className="sr-only">New task</DialogTitle>
        <DialogDescription className="sr-only">Capture an issue, feature request or task.</DialogDescription>
        <TaskComposer
          key={composerKey}
          layout="dialog"
          orgSlug={org.slug}
          header={<span>{parent ? "New sub-task" : "New task"}</span>}
          onCancel={onClose}
          submitDisabled={!projectId}
          type={{ value: type, onChange: setType }}
          onSubmit={async (v) => {
            const r = await createTask(org.slug, {
              title: v.title,
              description: v.description,
              projectId,
              statusId: status?.id,
              assigneeId,
              priority,
              type,
              dueDate,
              dependsOn: deps.map((d) => d.id),
              ...(parent ? { parentId: parent.id } : {}),
            });
            if (!r.ok) return { ok: false, error: r.error ?? "That didn't go through. Try again." };
            const t = r.data!;
            emitLocalTask(t);
            onClose();
            toast.success(`Created ${t.key}`, {
              description: t.title,
              action: { label: "Open", onClick: () => router.push(`${window.location.pathname}?task=${t.key}`, { scroll: false }) },
            });
          }}
          properties={({ type: typePicker }) => (
            <>
              <Picker label="Status" value={status?.id ?? null} options={statusOptions} onChange={setStatusId} searchable={false}>
                <button type="button" className={chip}>
                  <StatusRing status={status} statuses={projectStatuses} size={14} />
                  {status?.name ?? "Status"}
                </button>
              </Picker>
              <Picker label="Assignee" value={assigneeId ?? "none"} options={assigneeOptions} onChange={(v) => setAssigneeId(v === "none" ? null : v)} placeholder="Assign to…" footer={parkedIn && parkedPickerNote(parkedIn)}>
                <button type="button" className={chip}>
                  {assignee ? <MemberAvatar member={assignee} id={assignee.id} size={16} /> : <UnassignedAvatar size={14} />}
                  {assignee?.name ?? "Assignee"}
                </button>
              </Picker>
              <Picker label="Priority" value={`${priority}`} options={PRIORITY_OPTIONS} onChange={(v) => setPriority(Number(v) as Priority)} searchable={false}>
                <button type="button" className={chip}>
                  <PriorityIcon priority={priority} />
                  {priority ? PRIORITY_LABELS[priority] : "Priority"}
                </button>
              </Picker>
              {typePicker}
              <Picker label="Project" value={projectId} options={projectOptions} onChange={setProjectId} placeholder="Move to project…">
                <button type="button" className={chip}>
                  {project && <ProjectDot color={project.color} />}
                  {project?.name ?? "Project"}
                </button>
              </Picker>
              <DuePicker value={dueDate} onChange={setDueDate}>
                <button type="button" className={chip}>
                  {dueDate ? (
                    <DueBadge due={dueDate} className="text-[12.5px]" />
                  ) : (
                    <>
                      <CalendarIcon className="size-3.5" /> Due date
                    </>
                  )}
                </button>
              </DuePicker>
              {parent && (
                <span className={`${chip} gap-1 pr-1 text-foreground`} title={`Sub-task of ${parent.key}: ${parent.title}`} data-new-subtask-of={parent.key}>
                  <CornerLeftUpIcon className="size-3.5 text-faint" />
                  <span className="max-w-[180px] truncate">
                    Sub-task of <span className="tabular font-mono text-[11.5px]">{parent.key}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setParent(null)}
                    aria-label={`Don't make it a sub-task of ${parent.key}`}
                    className="grid size-5 place-items-center rounded text-faint hover:bg-accent hover:text-foreground"
                  >
                    <XIcon className="size-3" />
                  </button>
                </span>
              )}
              {deps.map((d) => (
                <span key={d.id} className={`${chip} gap-1 pr-1 text-foreground`} title={`Depends on ${d.key}: ${d.title}`}>
                  <HourglassIcon className="size-3.5 text-faint" />
                  <span className="max-w-[180px] truncate">
                    <span className="tabular font-mono text-[11.5px] text-faint">{d.key}</span> {d.title}
                  </span>
                  <button
                    type="button"
                    onClick={() => setDeps((list) => list.filter((x) => x.id !== d.id))}
                    aria-label={`Remove dependency on ${d.key}`}
                    className="grid size-5 place-items-center rounded text-faint hover:bg-accent hover:text-foreground"
                  >
                    <XIcon className="size-3" />
                  </button>
                </span>
              ))}
              <TaskSearchPicker exclude={deps.map((d) => d.id)} onPick={(t) => setDeps((list) => [...list, toRef(t)])}>
                <button type="button" className={chip}>
                  <HourglassIcon className="size-3.5" /> {deps.length ? "Add" : "Depends on"}
                </button>
              </TaskSearchPicker>
            </>
          )}
        />
      </DialogContent>
    </Dialog>
  );
}
