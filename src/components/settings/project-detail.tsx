"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArchiveIcon, ArchiveRestoreIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { useOrg } from "@/components/org-provider";
import { AnalyticsLink, DetailHeader, SettingsRow, Tag } from "@/components/settings/ui";
import { ColorDots, ProjectTile } from "@/components/settings/org-settings";
import { ProjectStatuses } from "@/components/settings/project-statuses";
import { ProjectFlow } from "@/components/settings/flow-settings";
import type { ProjectFlowSettings } from "@/lib/flows";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { deleteProject, setProjectArchived, updateProject } from "@/app/actions/org";
import type { ProjectDetail as ProjectDetailData, ProjectMetaEntry } from "@/lib/types";
import { analyticsPath, orgPath } from "@/lib/paths";
import { analyticsSearchFor } from "@/lib/analytics-range";

const Row = SettingsRow;

/** Editor rows carry a local id so React keys survive reordering and removal. */
type MetaRow = ProjectMetaEntry & { rid: number };
let ridSeq = 0;
const toRows = (m: ProjectMetaEntry[]): MetaRow[] => m.map((e) => ({ ...e, rid: ++ridSeq }));
const fromRows = (rows: MetaRow[]): ProjectMetaEntry[] => rows.map(({ key, value }) => ({ key: key.trim(), value: value.trim() })).filter((e) => e.key || e.value);
const sameMeta = (a: ProjectMetaEntry[], b: ProjectMetaEntry[]) => JSON.stringify(a) === JSON.stringify(b);

export function ProjectDetail({
  project: initial,
  taskCount,
  archivedTaskCount,
  flow,
  flowCounts,
}: {
  project: ProjectDetailData;
  taskCount: number;
  archivedTaskCount: number;
  flow: ProjectFlowSettings;
  flowCounts: Record<string, number>;
}) {
  const { org, isAdmin, projects, counts } = useOrg();
  const router = useRouter();
  const [project, setProject] = useState(initial);
  const [name, setName] = useState(initial.name);
  const [color, setColor] = useState(initial.color);
  const [rows, setRows] = useState<MetaRow[]>(() => toRows(initial.metadata));
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [typedKey, setTypedKey] = useState("");
  const [pending, start] = useTransition();

  const open = counts.projects[project.id] ?? 0;
  const onlyActive = !project.archived && projects.filter((p) => !p.archived).length <= 1;
  const detailsDirty = name.trim() !== project.name || color !== project.color;
  const metaNow = fromRows(rows);
  const metaDirty = !sameMeta(metaNow, project.metadata);
  const dupes = duplicateKeys(rows);

  const saveDetails = () =>
    start(async () => {
      const r = await updateProject(org.slug, project.id, { name, color });
      if (!r.ok) return void toast.error(r.error);
      setProject((p) => ({ ...p, name: name.trim(), color }));
      setName(name.trim());
      toast.success("Project saved");
      router.refresh();
    });

  const saveMeta = () =>
    start(async () => {
      const r = await updateProject(org.slug, project.id, { metadata: metaNow });
      if (!r.ok) return void toast.error(r.error);
      setProject((p) => ({ ...p, metadata: metaNow }));
      setRows(toRows(metaNow));
      toast.success("Agent context saved");
    });

  const setArchived = (archived: boolean) =>
    start(async () => {
      const r = await setProjectArchived(org.slug, project.id, archived);
      if (!r.ok) return void toast.error(r.error);
      setProject((p) => ({ ...p, archived, archivedAt: archived ? new Date().toISOString() : null }));
      toast.success(archived ? `Archived ${project.name}` : `Restored ${project.name}`);
      router.refresh();
    });

  const update = (rid: number, patch: Partial<ProjectMetaEntry>) => setRows((rs) => rs.map((r) => (r.rid === rid ? { ...r, ...patch } : r)));

  return (
    <>
      <DetailHeader
        back={{ href: orgPath(org.slug, "settings", "projects"), label: "Projects" }}
        avatar={<ProjectTile color={project.color} size={44} />}
        name={project.name}
        tags={
          <>
            <span className="font-mono text-[13px] text-faint">{project.key}</span>
            {project.archived && <Tag>Archived</Tag>}
          </>
        }
        subtitle={
          <>
            {project.archived ? "Archived" : `${open} open`} · {taskCount} task{taskCount === 1 ? "" : "s"} in total ·{" "}
            <Link href={orgPath(org.slug, "p", project.key)} className="underline underline-offset-2 hover:text-foreground">
              View tasks
            </Link>
          </>
        }
        action={isAdmin ? <AnalyticsLink href={analyticsPath(org.slug, analyticsSearchFor({ project: project.key }))} label={`Analytics for ${project.name}`} /> : undefined}
      />

      {project.archived && (
        <p className="mb-2 rounded-lg border border-border bg-sidebar px-3.5 py-2.5 text-[13px] text-muted-foreground">
          This project is archived. Its tasks are still here and can be worked on, but it&rsquo;s
          hidden from the sidebar and doesn&rsquo;t take new tasks.
        </p>
      )}

      <Row title="Details" desc={`The key is permanent: it's in every task ID, like ${project.key}-12.`}>
        <div className="grid max-w-xl gap-5">
          <div className="grid gap-1.5">
            <Label htmlFor="project-name">Name</Label>
            <div className="flex items-center gap-2">
              <ColorDots value={color} onChange={setColor} disabled={!isAdmin} />
              <Input
                id="project-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && detailsDirty && name.trim() && saveDetails()}
                maxLength={60}
                disabled={!isAdmin}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>Key</Label>
            <code className="font-mono text-[13px] text-muted-foreground">{project.key}</code>
          </div>
          {isAdmin && (
            <div className="flex gap-2">
              <Button onClick={saveDetails} disabled={pending || !detailsDirty || !name.trim()}>
                Save changes
              </Button>
              {detailsDirty && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setName(project.name);
                    setColor(project.color);
                  }}
                >
                  Discard
                </Button>
              )}
            </div>
          )}
        </div>
      </Row>

      <ProjectStatuses projectId={project.id} projectName={project.name} />

      <ProjectFlow projectId={project.id} projectName={project.name} flow={flow} counts={flowCounts} />

      <Row
        title="Agent context"
        desc={
          <>
            Key/value notes handed to a bot with every task in {project.name}: when it&rsquo;s assigned or @mentioned, and whenever it reads the task over MCP.
            Use it for repos, branches, environments, docs and conventions. Don&rsquo;t put secrets here; every bot and member can read it.
          </>
        }
      >
        <div className="grid max-w-2xl gap-3">
          {rows.length === 0 ? (
            <div className="rounded-[10px] border border-dashed border-input px-4 py-5 text-[13px] text-muted-foreground">
              No context yet.{isAdmin && " Add entries like repo → github.com/acme/web or test command → pnpm test."}
            </div>
          ) : (
            <div className="grid gap-2">
              <div className="hidden grid-cols-[minmax(0,200px)_minmax(0,1fr)_28px] gap-2 px-0.5 text-[12px] font-medium text-faint sm:grid">
                <span>Key</span>
                <span>Value</span>
              </div>
              {rows.map((r) => (
                <div key={r.rid} className="grid grid-cols-[minmax(0,1fr)_28px] items-start gap-2 sm:grid-cols-[minmax(0,200px)_minmax(0,1fr)_28px]">
                  <Input
                    value={r.key}
                    onChange={(e) => update(r.rid, { key: e.target.value })}
                    placeholder="repo"
                    maxLength={64}
                    disabled={!isAdmin}
                    aria-label="Key"
                    aria-invalid={dupes.has(r.key.trim().toLowerCase()) || (!r.key.trim() && !!r.value.trim()) || undefined}
                    className="h-9 font-mono text-[13px] md:text-[13px]"
                  />
                  <Textarea
                    value={r.value}
                    onChange={(e) => update(r.rid, { value: e.target.value })}
                    placeholder="github.com/acme/web"
                    maxLength={4000}
                    rows={1}
                    disabled={!isAdmin}
                    aria-label={`Value for ${r.key || "new key"}`}
                    className="col-span-1 row-start-2 min-h-9 py-[7px] text-[13px] sm:row-start-auto md:text-[13px]"
                  />
                  {isAdmin && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${r.key || "entry"}`}
                      className="mt-0.5 text-faint hover:text-destructive sm:row-start-auto"
                      onClick={() => setRows((rs) => rs.filter((x) => x.rid !== r.rid))}
                    >
                      <XIcon />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
          {dupes.size > 0 && <p className="text-[12.5px] text-destructive">Each key can only be used once.</p>}
          {isAdmin && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setRows((rs) => [...rs, { key: "", value: "", rid: ++ridSeq }])} disabled={rows.length >= 50}>
                <PlusIcon className="size-3.5" /> Add entry
              </Button>
              <span className="flex-1" />
              {metaDirty && (
                <Button variant="ghost" size="sm" onClick={() => setRows(toRows(project.metadata))}>
                  Discard
                </Button>
              )}
              <Button size="sm" onClick={saveMeta} disabled={pending || !metaDirty || dupes.size > 0}>
                Save context
              </Button>
            </div>
          )}
          {project.metadata.length > 0 && (
            <details className="group text-[12.5px] text-muted-foreground">
              <summary className="cursor-pointer select-none hover:text-foreground">What a bot sees</summary>
              <pre className="mt-2 overflow-x-auto rounded-lg bg-sidebar px-3 py-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-foreground">
                {`Project context for ${project.key} (${project.name}), set by the team. Follow it while you work:\n${project.metadata
                  .map((m) => `- ${m.key}: ${m.value.replace(/\n/g, "\n  ")}`)
                  .join("\n")}`}
              </pre>
            </details>
          )}
        </div>
      </Row>

      {isAdmin && (
        <Row title="Danger zone" desc="Archiving is reversible. Deleting is not.">
          <div className="max-w-2xl divide-y divide-destructive/20 rounded-[10px] border border-destructive/30">
            <div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-medium">{project.archived ? "Restore project" : "Archive project"}</div>
                <p className="mt-0.5 text-[12.5px] text-muted-foreground">
                  {project.archived
                    ? "Puts it back in the sidebar and lets people and bots add tasks to it again."
                    : onlyActive
                      ? "This is the only active project. Create another before archiving it."
                      : "Hides it from the sidebar and stops new tasks. Existing tasks stay and can still be worked on."}
                </p>
              </div>
              {project.archived ? (
                <Button variant="outline" onClick={() => setArchived(false)} disabled={pending}>
                  <ArchiveRestoreIcon /> Restore
                </Button>
              ) : (
                <Button variant="outline" onClick={() => setConfirmArchive(true)} disabled={pending || onlyActive}>
                  <ArchiveIcon /> Archive
                </Button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-medium">Delete project</div>
                <p className="mt-0.5 text-[12.5px] text-muted-foreground">
                  {onlyActive
                    ? "This is the only active project. Create another before deleting it."
                    : taskCount
                      ? `Permanently deletes ${project.name} and its ${taskCount} task${taskCount === 1 ? "" : "s"}, with every comment and all activity.`
                      : `Permanently deletes ${project.name}. It has no tasks.`}
                </p>
              </div>
              <Button
                variant="destructive"
                onClick={() => {
                  setTypedKey("");
                  setConfirmDelete(true);
                }}
                disabled={pending || onlyActive}
              >
                <Trash2Icon /> Delete
              </Button>
            </div>
          </div>
        </Row>
      )}

      <AlertDialog open={confirmArchive} onOpenChange={setConfirmArchive}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {project.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              It leaves the sidebar and stops taking new tasks. Its {taskCount} task{taskCount === 1 ? "" : "s"} stay where they are. You can restore it any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => setArchived(true)}>Archive project</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {project.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {taskCount
                ? `This deletes ${taskCount === 1 ? "its 1 task" : `all ${taskCount} of its tasks`}${archivedTaskCount ? ` (${archivedTaskCount} archived)` : ""}, with every comment and all activity. It can't be undone.`
                : "It has no tasks. This can't be undone."}{" "}
              {!project.archived && "To keep the history, archive it instead."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="confirm-key" className="text-[13px] font-normal text-muted-foreground">
              Type <span className="font-mono font-medium text-foreground">{project.key}</span> to confirm
            </Label>
            <Input
              id="confirm-key"
              value={typedKey}
              onChange={(e) => setTypedKey(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              autoFocus
              className="font-mono uppercase"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep project</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending || typedKey.trim().toUpperCase() !== project.key}
              onClick={(e) => {
                e.preventDefault();
                start(async () => {
                  const r = await deleteProject(org.slug, project.id, typedKey);
                  if (!r.ok) return void toast.error(r.error);
                  setConfirmDelete(false);
                  toast.success(`Deleted ${project.name}`);
                  router.push(orgPath(org.slug, "settings", "projects"));
                });
              }}
            >
              Delete project
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function duplicateKeys(rows: MetaRow[]) {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const r of rows) {
    const k = r.key.trim().toLowerCase();
    if (!k) continue;
    if (seen.has(k)) dupes.add(k);
    seen.add(k);
  }
  return dupes;
}
