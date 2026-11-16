"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useOrg } from "@/components/org-provider";
import { Kbd, MemberAvatar, PriorityIcon, ProjectDot, StatusRing, TypeSquare, UnassignedAvatar } from "@/components/bits";
import {
  Picker,
  PRIORITY_OPTIONS,
  TYPE_OPTIONS,
  useAssigneeOptions,
  useProjectOptions,
  useStatusOptions,
} from "@/components/pickers";
import { RichEditor } from "@/components/rich-editor";
import { DueBadge, DuePicker } from "@/components/due-date";
import { CalendarIcon, HourglassIcon, XIcon } from "lucide-react";
import { createTask } from "@/app/actions/tasks";
import { PRIORITY_LABELS, TYPE_NAMES } from "@/lib/format";
import { matchStatus, type Priority, type Status, type StatusCategory, type Task, type TaskRef, type TaskType } from "@/lib/types";
import { TaskSearchPicker, toRef } from "@/components/dependencies";

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
}

/** Local echo so the creator's list updates even before the real-time event lands. */
export function emitLocalTask(task: Task) {
  window.dispatchEvent(new CustomEvent<Task>("vector:task", { detail: task }));
}

const chip =
  "inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent";

export function NewTaskDialog({ defaults, onClose }: { defaults: NewTaskDefaults | null; onClose: () => void }) {
  const { org, projects, statusById, statusesByProject, memberById, projectById, defaults: orgDefaults } = useOrg();
  const router = useRouter();
  const open = defaults !== null;

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState("");
  // "" = nothing explicit: the status follows the project and the stage (the caller's, else the org default).
  const [statusId, setStatusId] = useState("");
  const [stage, setStage] = useState<StatusCategory | null>(null);
  const [assigneeId, setAssigneeId] = useState<string | null>(null);
  const [priority, setPriority] = useState<Priority>(0);
  const [type, setType] = useState<TaskType>("issue");
  const [dueDate, setDueDate] = useState<string | null>(null);
  const [deps, setDeps] = useState<TaskRef[]>([]);
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  const [editorKey, setEditorKey] = useState(0);

  useEffect(() => {
    if (!defaults) return;
    setTitle("");
    setDescription("");
    const active = projects.filter((p) => !p.archived);
    setProjectId(active.find((p) => p.id === defaults.projectId)?.id ?? active[0]?.id ?? "");
    setStatusId(defaults.statusId ?? "");
    setStage(defaults.stage ?? null);
    setAssigneeId(defaults.assigneeId ?? null);
    setPriority(0);
    setType(defaults.type ?? "issue");
    setDueDate(null);
    setDeps(defaults.dependsOn ?? []);
    setError(undefined);
    setEditorKey((k) => k + 1);
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
  // With no explicit status, preselect the project's first status of the stage (VEC-129): live, so a project
  // change or a teammate's change to the org default (org.changed) re-picks it until the person picks one.
  const byStage = (c: StatusCategory): Status | undefined => projectStatuses.find((s) => s.category === c);
  const status =
    picked?.projectId === projectId
      ? picked
      : ((picked && matchStatus(projectStatuses, picked)) ??
        byStage(stage ?? orgDefaults.newTaskStage) ??
        byStage("unstarted") ??
        projectStatuses[0]);
  const assignee = assigneeId ? memberById.get(assigneeId) : undefined;

  const submit = () => {
    if (!title.trim()) return setError("Give the task a title.");
    start(async () => {
      const r = await createTask(org.slug, { title, description, projectId, statusId: status?.id, assigneeId, priority, type, dueDate, dependsOn: deps.map((d) => d.id) });
      if (!r.ok) return setError(r.error);
      const t = r.data!;
      emitLocalTask(t);
      onClose();
      toast.success(`Created ${t.key}`, {
        description: t.title,
        action: { label: "Open", onClick: () => router.push(`${window.location.pathname}?task=${t.key}`, { scroll: false }) },
      });
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="top-[14vh] translate-y-0 gap-0 p-0 sm:max-w-[640px]"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
      >
        <DialogTitle className="sr-only">New task</DialogTitle>
        <DialogDescription className="sr-only">Capture an issue, feature request or task.</DialogDescription>
        <div className="flex items-center gap-2 px-5 pt-4 text-[12.5px] text-faint">
          <span>New task</span>
        </div>
        <div className="px-5 pt-3">
          <input
            autoFocus
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              setError(undefined);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Task title"
            aria-label="Task title"
            maxLength={300}
            data-zoom-safe
            className="w-full bg-transparent text-[18px] font-semibold tracking-[-0.015em] outline-none placeholder:text-faint"
          />
          <RichEditor
            key={editorKey}
            orgSlug={org.slug}
            value=""
            onChange={setDescription}
            className="mt-3 max-h-[42vh] overflow-y-auto pb-2 [&_.ProseMirror]:min-h-[5.5rem]"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5 px-5 pt-1 pb-4">
          <Picker label="Status" value={status?.id ?? null} options={statusOptions} onChange={setStatusId} searchable={false}>
            <button className={chip}>
              <StatusRing status={status} statuses={projectStatuses} size={14} />
              {status?.name ?? "Status"}
            </button>
          </Picker>
          <Picker label="Assignee" value={assigneeId ?? "none"} options={assigneeOptions} onChange={(v) => setAssigneeId(v === "none" ? null : v)} placeholder="Assign to…">
            <button className={chip}>
              {assignee ? <MemberAvatar member={assignee} id={assignee.id} size={16} /> : <UnassignedAvatar size={14} />}
              {assignee?.name ?? "Assignee"}
            </button>
          </Picker>
          <Picker label="Priority" value={`${priority}`} options={PRIORITY_OPTIONS} onChange={(v) => setPriority(Number(v) as Priority)} searchable={false}>
            <button className={chip}>
              <PriorityIcon priority={priority} />
              {priority ? PRIORITY_LABELS[priority] : "Priority"}
            </button>
          </Picker>
          <Picker label="Type" value={type} options={TYPE_OPTIONS} onChange={setType} searchable={false}>
            <button className={chip}>
              <TypeSquare type={type} />
              {TYPE_NAMES[type]}
            </button>
          </Picker>
          <Picker label="Project" value={projectId} options={projectOptions} onChange={setProjectId} placeholder="Move to project…">
            <button className={chip}>
              {project && <ProjectDot color={project.color} />}
              {project?.name ?? "Project"}
            </button>
          </Picker>
          <DuePicker value={dueDate} onChange={setDueDate}>
            <button className={chip}>
              {dueDate ? (
                <DueBadge due={dueDate} className="text-[12.5px]" />
              ) : (
                <>
                  <CalendarIcon className="size-3.5" /> Due date
                </>
              )}
            </button>
          </DuePicker>
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
            <button className={chip}>
              <HourglassIcon className="size-3.5" /> {deps.length ? "Add" : "Depends on"}
            </button>
          </TaskSearchPicker>
        </div>
        <div className="flex items-center gap-3 border-t border-border px-5 py-3">
          <p role="alert" aria-live="polite" className="min-w-0 flex-1 truncate text-[13px] text-destructive">
            {error}
          </p>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || !projectId}>
            {pending ? "Creating…" : "Create task"}
            <Kbd className="border-transparent bg-white/15 text-current dark:bg-black/10">⌘↵</Kbd>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
