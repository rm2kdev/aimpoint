"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LinkIcon, LockIcon, MoreHorizontalIcon, Trash2Icon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useOrg, useOrgEvents } from "@/components/org-provider";
import { MemberAvatar, PriorityIcon, ProjectDot, StatusRing, UnassignedAvatar } from "@/components/bits";
import {
  Picker,
  PRIORITY_OPTIONS,
  TYPE_OPTIONS,
  useAssigneeOptions,
  useProjectOptions,
  useStatusOptions,
} from "@/components/pickers";
import { RichEditor } from "@/components/rich-editor";
import { CommentBody, MentionComposer } from "@/components/mentions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { addComment, deleteTask, getTaskDetail, updateTask, type TaskPatch } from "@/app/actions/tasks";
import { PRIORITY_LABELS, timeAgo } from "@/lib/format";
import type { FeedItem, Priority, Task, TaskDetail } from "@/lib/types";

const propBtn =
  "-ml-2 flex h-7 min-w-0 items-center gap-2 rounded-md px-2 text-[13px] transition-colors hover:bg-accent data-[state=open]:bg-accent disabled:cursor-default disabled:hover:bg-transparent";

export function TaskPane({ taskKey, onClose, onTask }: { taskKey: string; onClose: () => void; onTask: (t: Task) => void }) {
  const { org, me, isAdmin, statuses, statusById, memberById, projectById } = useOrg();
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [error, setError] = useState<string>();
  const [deleted, setDeleted] = useState(false);
  const [descSync, setDescSync] = useState(0);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    const r = await getTaskDetail(org.slug, taskKey);
    if (!r.ok) return setError(r.error);
    setTask(r.data!.task);
    setFeed(r.data!.feed);
    setDescSync((n) => n + 1);
  }, [org.slug, taskKey]);

  useEffect(() => {
    load();
  }, [load]);

  useOrgEvents((e) => {
    if (!task) return;
    if (e.type === "task.upsert" && e.task.id === task.id) {
      setTask((t) => (t ? { ...t, ...e.task } : t));
      if (e.descriptionChanged && e.actorId !== me.id) {
        getTaskDetail(org.slug, e.task.key).then((r) => {
          if (r.ok) {
            setTask((t) => (t ? { ...t, description: r.data!.task.description } : t));
            setDescSync((n) => n + 1);
          }
        });
      }
    } else if (e.type === "feed.add" && e.taskId === task.id) {
      setFeed((f) => (f.some((x) => x.id === e.item.id) ? f : [...f, e.item]));
    } else if (e.type === "task.delete" && e.taskId === task.id) {
      setDeleted(true);
    }
  });

  const patch = async (p: TaskPatch) => {
    if (!task) return;
    const before = task;
    setTask({ ...task, ...(p as Partial<TaskDetail>) });
    const r = await updateTask(org.slug, task.id, p);
    if (!r.ok) {
      setTask(before);
      toast.error(r.error);
      return;
    }
    if (r.data) {
      onTask(r.data);
      setTask((t) => (t ? { ...t, ...r.data } : t));
    }
  };

  /* description autosave */
  const descTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pendingDesc = useRef<string | null>(null);
  const flushDesc = useCallback(async () => {
    clearTimeout(descTimer.current);
    if (pendingDesc.current === null || !task) return;
    const html = pendingDesc.current;
    pendingDesc.current = null;
    setSaveState("saving");
    const r = await updateTask(org.slug, task.id, { description: html });
    if (!r.ok) {
      toast.error(r.error);
      setSaveState("idle");
    } else setSaveState("saved");
  }, [org.slug, task]);
  useEffect(() => () => void flushDesc(), [flushDesc]);

  const statusOptions = useStatusOptions();
  const assigneeOptions = useAssigneeOptions();
  const projectOptions = useProjectOptions();

  const shell = (children: React.ReactNode) => (
    <aside
      aria-label="Task details"
      className="flex w-full min-w-0 flex-col border-l border-border bg-background lg:w-[440px] lg:shrink-0 xl:w-[500px] 2xl:w-[560px]"
    >
      {children}
    </aside>
  );

  if (error || deleted) {
    return shell(
      <>
        <PaneHeader taskKey={taskKey} onClose={onClose} />
        <div className="grid flex-1 place-items-center px-8 text-center">
          <div>
            <p className="text-[15px] font-semibold">{deleted ? "This task was deleted" : "Couldn't open this task"}</p>
            <p className="mt-1 text-[13.5px] text-muted-foreground">{deleted ? "Someone on your team removed it." : error}</p>
            <Button variant="outline" className="mt-5" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </>,
    );
  }

  if (!task) {
    return shell(
      <>
        <PaneHeader taskKey={taskKey} onClose={onClose} />
        <div className="space-y-3 px-6 py-6" aria-busy>
          <div className="h-6 w-3/4 animate-pulse rounded bg-muted" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
          <div className="mt-8 h-24 animate-pulse rounded bg-muted" />
        </div>
      </>,
    );
  }

  const status = statusById.get(task.statusId);
  const assignee = task.assigneeId ? memberById.get(task.assigneeId) : undefined;
  const project = projectById.get(task.projectId);
  const canEdit = isAdmin || task.createdBy === me.id;
  const creator = memberById.get(task.createdBy);

  return shell(
    <>
      <PaneHeader taskKey={task.key} onClose={onClose}>
        <DropdownMenu>
          <DropdownMenuTrigger aria-label="Task actions" className="grid size-7 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <MoreHorizontalIcon className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem
              className="gap-2.5"
              onSelect={() => {
                navigator.clipboard.writeText(`${location.origin}${location.pathname}?task=${task.key}`);
                toast.success(`Copied link to ${task.key}`);
              }}
            >
              <LinkIcon className="size-4" /> Copy link
            </DropdownMenuItem>
            {canEdit && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" className="gap-2.5" onSelect={() => setConfirmDelete(true)}>
                  <Trash2Icon className="size-4" /> Delete task
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </PaneHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-6 pt-5 pb-10">
          <div className="flex items-start gap-3">
            <Picker disabled={!canEdit} label={`Status: ${status?.name}`} value={task.statusId} options={statusOptions} onChange={(statusId) => patch({ statusId })} searchable={false}>
              <button className="-m-1 mt-0.5 grid size-7 shrink-0 place-items-center rounded-full transition-transform enabled:hover:scale-110">
                <StatusRing status={status} statuses={statuses} size={20} />
              </button>
            </Picker>
            <TitleField value={task.title} readOnly={!canEdit} onSave={(title) => patch({ title })} />
          </div>
          {!canEdit && (
            <p className="mt-3 flex items-center gap-2 rounded-lg bg-sidebar px-3 py-2 text-[12.5px] text-muted-foreground">
              <LockIcon className="size-3.5 shrink-0" />
              Only {creator?.name ?? "the creator"} or an admin can edit this task. You can still comment.
            </p>
          )}

          <dl className="mt-5 grid grid-cols-[88px_minmax(0,1fr)] items-center gap-x-3 gap-y-1 text-[13px]">
            <dt className="text-faint">Status</dt>
            <dd>
              <Picker disabled={!canEdit} label="Status" value={task.statusId} options={statusOptions} onChange={(statusId) => patch({ statusId })} searchable={false}>
                <button className={propBtn}>
                  <StatusRing status={status} statuses={statuses} size={14} />
                  {status?.name ?? "No status"}
                </button>
              </Picker>
            </dd>
            <dt className="text-faint">Assignee</dt>
            <dd>
              <Picker
                disabled={!canEdit}
                label="Assignee"
                value={task.assigneeId ?? "none"}
                options={assigneeOptions}
                onChange={(v) => patch({ assigneeId: v === "none" ? null : v })}
                placeholder="Assign to…"
              >
                <button className={propBtn}>
                  {assignee ? <MemberAvatar member={assignee} id={assignee.id} size={18} /> : <UnassignedAvatar size={16} />}
                  <span className={cn("truncate", !assignee && "text-muted-foreground")}>{assignee?.name ?? "Unassigned"}</span>
                </button>
              </Picker>
            </dd>
            <dt className="text-faint">Priority</dt>
            <dd>
              <Picker disabled={!canEdit} label="Priority" value={`${task.priority}`} options={PRIORITY_OPTIONS} onChange={(v) => patch({ priority: Number(v) as Priority })} searchable={false}>
                <button className={propBtn}>
                  <PriorityIcon priority={task.priority} />
                  <span className={cn(!task.priority && "text-muted-foreground")}>{PRIORITY_LABELS[task.priority]}</span>
                </button>
              </Picker>
            </dd>
            <dt className="text-faint">Type</dt>
            <dd>
              <Picker disabled={!canEdit} label="Type" value={task.type} options={TYPE_OPTIONS} onChange={(type) => patch({ type })} searchable={false}>
                <button className={propBtn}>
                  <span className={cn("size-2 rounded-[2px]", task.type === "issue" ? "bg-[#e5484d]" : "bg-[#30a46c]")} />
                  {task.type === "issue" ? "Issue" : "Feature request"}
                </button>
              </Picker>
            </dd>
            <dt className="text-faint">Project</dt>
            <dd>
              <Picker disabled={!canEdit} label="Project" value={task.projectId} options={projectOptions} onChange={(projectId) => patch({ projectId })} placeholder="Move to project…">
                <button className={propBtn}>
                  {project && <ProjectDot color={project.color} />}
                  <span className="truncate">{project?.name}</span>
                </button>
              </Picker>
            </dd>
          </dl>

          <div className="mt-6 border-t border-border pt-5">
            <RichEditor
              orgSlug={org.slug}
              editable={canEdit}
              placeholder={canEdit ? "Add a description…" : "No description"}
              value={task.description}
              syncKey={descSync}
              onChange={(html) => {
                pendingDesc.current = html;
                setSaveState("idle");
                clearTimeout(descTimer.current);
                descTimer.current = setTimeout(flushDesc, 700);
              }}
            />
            <p className="mt-2 h-4 text-[11.5px] text-faint" aria-live="polite">
              {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : ""}
            </p>
          </div>

          <Feed feed={feed} />
          <MentionComposer
            onSend={async (body) => {
              const r = await addComment(org.slug, task.id, body);
              if (!r.ok) {
                toast.error(r.error);
                return false;
              }
              setFeed((f) => (f.some((x) => x.id === r.data!.id) ? f : [...f, r.data!]));
              return true;
            }}
          />
        </div>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {task.key}?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{task.title}&rdquo; and its comments will be removed for everyone. This can&rsquo;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep task</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                const r = await deleteTask(org.slug, task.id);
                if (!r.ok) return void toast.error(r.error);
                toast.success(`Deleted ${task.key}`);
                onClose();
              }}
            >
              Delete task
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>,
  );
}

function PaneHeader({ taskKey, onClose, children }: { taskKey: string; onClose: () => void; children?: React.ReactNode }) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-1 border-b border-border px-4">
      <span className="tabular pl-2 font-mono text-[12px] text-faint">{taskKey}</span>
      <div className="ml-auto flex items-center gap-1">
        {children}
        <button
          onClick={onClose}
          aria-label="Close task (Esc)"
          title="Close (Esc)"
          className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <XIcon className="size-4" />
        </button>
      </div>
    </div>
  );
}

function TitleField({ value, onSave, readOnly }: { value: string; onSave: (v: string) => void; readOnly?: boolean }) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (document.activeElement !== ref.current) setDraft(value);
  }, [value]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);
  const commit = () => {
    const t = draft.trim();
    if (!t) return setDraft(value);
    if (t !== value) onSave(t);
  };
  return (
    <textarea
      ref={ref}
      rows={1}
      value={draft}
      readOnly={readOnly}
      maxLength={300}
      aria-label="Title"
      onChange={(e) => setDraft(e.target.value.replace(/\n/g, " "))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        }
        if (e.key === "Escape") {
          setDraft(value);
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
      className="min-w-0 flex-1 resize-none bg-transparent text-[20px] leading-[1.3] font-semibold tracking-[-0.02em] outline-none"
    />
  );
}

function Feed({ feed }: { feed: FeedItem[] }) {
  const { memberById, statusById, projectById, me } = useOrg();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  if (!feed.length) return null;
  const name = (id: string | null | undefined) => (id ? memberById.get(id)?.name ?? "a former member" : "nobody");

  const describe = (f: FeedItem) => {
    switch (f.kind) {
      case "created":
        return "created this task";
      case "status":
        return (
          <>
            moved from <b className="font-medium text-foreground">{statusById.get(f.from ?? "")?.name ?? "a removed status"}</b> to{" "}
            <b className="font-medium text-foreground">{statusById.get(f.to ?? "")?.name ?? "a removed status"}</b>
          </>
        );
      case "assignee":
        if (!f.to) return <>unassigned {name(f.from)}</>;
        if (f.to === f.actorId) return "took this task";
        return (
          <>
            assigned this to <b className="font-medium text-foreground">{name(f.to)}</b>
          </>
        );
      case "priority":
        return <>set priority to {PRIORITY_LABELS[Number(f.to) as Priority].toLowerCase()}</>;
      case "type":
        return <>changed the type to {f.to === "feature" ? "feature request" : "issue"}</>;
      case "title":
        return "renamed this task";
      case "project":
        return (
          <>
            moved this to <b className="font-medium text-foreground">{projectById.get(f.to ?? "")?.name ?? "another project"}</b>
          </>
        );
      default:
        return null;
    }
  };

  return (
    <section className="mt-6 border-t border-border pt-5" aria-label="Activity">
      <h3 className="mb-3 text-[12.5px] font-semibold">Activity</h3>
      <ol className="space-y-3">
        {feed.map((f) => {
          const actor = memberById.get(f.actorId);
          return f.kind === "comment" ? (
            <li key={f.id} className="flex gap-2.5">
              <MemberAvatar member={actor} id={f.actorId} size={22} className="mt-px" />
              <div className="min-w-0 flex-1">
                <div className="text-[13px]">
                  <span className="font-medium">{actor?.name ?? "Former member"}</span>
                  <time className="ml-2 text-[12px] text-faint" dateTime={f.createdAt} title={new Date(f.createdAt).toLocaleString()}>
                    {timeAgo(f.createdAt)}
                  </time>
                </div>
                <div
                  className={cn(
                    "mt-1 rounded-[10px] border border-border bg-sidebar px-3 py-2 text-[13.5px] leading-relaxed break-words whitespace-pre-wrap",
                    f.mentions?.includes(me.id) && "border-selected-foreground/25",
                  )}
                >
                  <CommentBody body={f.body ?? ""} />
                </div>
              </div>
            </li>
          ) : (
            <li key={f.id} className="flex items-center gap-2.5 text-[13px] text-muted-foreground">
              <span className="grid w-[22px] place-items-center">
                <span className="size-1.5 rounded-full bg-input" />
              </span>
              <span className="min-w-0">
                <span className="font-medium text-foreground">{actor?.name ?? "Former member"}</span> {describe(f)}
                <time className="ml-2 text-[12px] text-faint" dateTime={f.createdAt} title={new Date(f.createdAt).toLocaleString()}>
                  {timeAgo(f.createdAt)}
                </time>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
