"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useOrg } from "@/components/org-provider";
import { Kbd, MemberAvatar, PriorityIcon, ProjectDot, StatusRing, UnassignedAvatar } from "@/components/bits";
import {
  Picker,
  PRIORITY_OPTIONS,
  TYPE_OPTIONS,
  useAssigneeOptions,
  useProjectOptions,
  useStatusOptions,
} from "@/components/pickers";
import { RichEditor } from "@/components/rich-editor";
import { createTask } from "@/app/actions/tasks";
import { PRIORITY_LABELS } from "@/lib/format";
import type { Priority, Task, TaskType } from "@/lib/types";

export interface NewTaskDefaults {
  projectId?: string;
  statusId?: string;
  assigneeId?: string | null;
  type?: TaskType;
}

/** Local echo so the creator's list updates even before the real-time event lands. */
export function emitLocalTask(task: Task) {
  window.dispatchEvent(new CustomEvent<Task>("vector:task", { detail: task }));
}

const chip =
  "inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent";

export function NewTaskDialog({ defaults, onClose }: { defaults: NewTaskDefaults | null; onClose: () => void }) {
  const { org, projects, statuses, statusById, memberById, projectById } = useOrg();
  const router = useRouter();
  const open = defaults !== null;
  const firstOpen = statuses.find((s) => s.category === "unstarted") ?? statuses[0];

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState("");
  const [statusId, setStatusId] = useState("");
  const [assigneeId, setAssigneeId] = useState<string | null>(null);
  const [priority, setPriority] = useState<Priority>(0);
  const [type, setType] = useState<TaskType>("issue");
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  const [editorKey, setEditorKey] = useState(0);

  useEffect(() => {
    if (!defaults) return;
    setTitle("");
    setDescription("");
    setProjectId(defaults.projectId ?? projects[0]?.id ?? "");
    setStatusId(defaults.statusId ?? firstOpen?.id ?? "");
    setAssigneeId(defaults.assigneeId ?? null);
    setPriority(0);
    setType(defaults.type ?? "issue");
    setError(undefined);
    setEditorKey((k) => k + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaults]);

  const statusOptions = useStatusOptions();
  const assigneeOptions = useAssigneeOptions();
  const projectOptions = useProjectOptions();
  const project = projectById.get(projectId);
  const status = statusById.get(statusId);
  const assignee = assigneeId ? memberById.get(assigneeId) : undefined;

  const submit = () => {
    if (!title.trim()) return setError("Give the task a title.");
    start(async () => {
      const r = await createTask(org.slug, { title, description, projectId, statusId, assigneeId, priority, type });
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
        <DialogDescription className="sr-only">Capture an issue or feature request.</DialogDescription>
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
          <Picker label="Status" value={statusId} options={statusOptions} onChange={setStatusId} searchable={false}>
            <button className={chip}>
              <StatusRing status={status} statuses={statuses} size={14} />
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
              <span className={type === "issue" ? "size-2 rounded-[2px] bg-[#e5484d]" : "size-2 rounded-[2px] bg-[#30a46c]"} />
              {type === "issue" ? "Issue" : "Feature request"}
            </button>
          </Picker>
          <Picker label="Project" value={projectId} options={projectOptions} onChange={setProjectId} placeholder="Move to project…">
            <button className={chip}>
              {project && <ProjectDot color={project.color} />}
              {project?.name ?? "Project"}
            </button>
          </Picker>
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
