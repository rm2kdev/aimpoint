"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDownIcon, ArrowUpIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useOrg } from "@/components/org-provider";
import { EntityList, EntityRow, SettingsRow, Tag, useAction } from "@/components/settings/ui";
import { ProjectDot, StatusRing } from "@/components/bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  createProject,
  deleteStatus,
  removeMember,
  renameOrg,
  reorderStatuses,
  saveStatus,
} from "@/app/actions/org";
import type { Role, Status, StatusCategory } from "@/lib/types";
import { orgPath } from "@/lib/paths";

export interface InviteRow {
  id: string;
  email: string;
  role: Role;
  token: string;
  expiresAt: string;
}

const Row = SettingsRow;

/* ---------------- General ---------------- */

export function GeneralSettings() {
  const { org, isAdmin, me } = useOrg();
  const [name, setName] = useState(org.name);
  const { pending, run } = useAction();
  const router = useRouter();
  return (
    <>
      <Row title="Organisation name" desc="Shown in the sidebar and on invitations.">
        <form
          className="flex max-w-md gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => renameOrg(org.slug, name), "Organisation renamed");
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!isAdmin} maxLength={60} aria-label="Organisation name" />
          {isAdmin && (
            <Button type="submit" variant="outline" disabled={pending || name.trim() === org.name}>
              Save
            </Button>
          )}
        </form>
        <p className="mt-2 text-[12px] text-faint">
          URL: <span className="font-mono">{orgPath(org.slug)}</span>
        </p>
      </Row>
      <Row title="Leave organisation" desc="You'll lose access to its tasks. An organisation always keeps at least one admin.">
        <Button
          variant="destructive"
          onClick={() => {
            if (!confirm(`Leave ${org.name}?`)) return;
            removeMember(org.slug, me.id).then((r) => (r.ok ? router.push("/") : toast.error(r.error)));
          }}
        >
          Leave {org.name}
        </Button>
      </Row>
    </>
  );
}

/* ---------------- Projects ---------------- */

export function ProjectsSettings({ openNew }: { openNew: boolean }) {
  const { org, projects, isAdmin, counts } = useOrg();
  const router = useRouter();
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [pending, startCreate] = useTransition();
  const suggested = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  const autoKey = suggested.length > 1 ? suggested.map((w) => w[0]).join("").slice(0, 5) : (suggested[0] ?? "").slice(0, 3);
  const ordered = [...projects.filter((p) => !p.archived), ...projects.filter((p) => p.archived)];

  return (
    <>
      <Row
        title="Projects"
        desc="Every task belongs to one project. Task IDs use the project key, like WEB-12. Open a project to rename it, give agents context about it, or archive it."
      >
        <EntityList>
          {ordered.map((p) => (
            <EntityRow
              key={p.id}
              href={orgPath(org.slug, "settings", "projects", p.id)}
              avatar={<ProjectTile color={p.color} />}
              name={p.name}
              tags={
                <>
                  <span className="shrink-0 font-mono text-[12px] font-normal text-faint">{p.key}</span>
                  {p.archived && <Tag>Archived</Tag>}
                </>
              }
              subtitle={p.archived ? "Archived: no new tasks, hidden from the sidebar" : `${counts.projects[p.id] ?? 0} open`}
            />
          ))}
        </EntityList>
      </Row>
      {isAdmin && (
        <Row title="New project" desc="Keys are short and permanent: 2-10 letters or digits.">
          <form
            className="grid max-w-md gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              startCreate(async () => {
                const r = await createProject(org.slug, { name, key: key || autoKey });
                if (!r.ok) return void toast.error(r.error);
                toast.success(`Created ${r.data!.key}`, { description: "Add context for agents, if it needs any." });
                setName("");
                setKey("");
                router.push(orgPath(org.slug, "settings", "projects", r.data!.id));
              });
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="pname">Name</Label>
              <Input id="pname" value={name} onChange={(e) => setName(e.target.value)} placeholder="Mobile App" autoFocus={openNew} maxLength={60} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="pkey">Key</Label>
              <Input
                id="pkey"
                value={key}
                onChange={(e) => setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10))}
                placeholder={autoKey || "MOB"}
                className="w-32 font-mono uppercase"
              />
            </div>
            <div>
              <Button type="submit" disabled={pending || !name.trim()}>
                Create project
              </Button>
            </div>
          </form>
        </Row>
      )}
    </>
  );
}

const SWATCHES = ["#2f6fed", "#30a46c", "#e5a00d", "#8b5cf6", "#e5484d", "#0ea5b7", "#d6409f", "#737373"];

/** Project colour as a 32px tile, the project counterpart of an avatar. */
export function ProjectTile({ color, size = 32 }: { color: string; size?: number }) {
  return (
    <span className="grid shrink-0 place-items-center rounded-lg" style={{ width: size, height: size, background: `${color}1f` }}>
      <ProjectDot color={color} className={size > 36 ? "size-4" : "size-3"} />
    </span>
  );
}

export function ColorDots({ value, onChange, disabled }: { value: string; onChange: (c: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-label="Change colour"
        className="grid size-7 place-items-center rounded-md hover:bg-accent disabled:hover:bg-transparent"
      >
        <ProjectDot color={value} className="size-3" />
      </button>
      {open && (
        <div className="absolute top-8 left-0 z-20 flex gap-1 rounded-lg border border-border bg-popover p-1.5 shadow-lg">
          {SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={c}
              onClick={() => {
                setOpen(false);
                if (c !== value) onChange(c);
              }}
              className={cn("grid size-6 place-items-center rounded-md hover:bg-accent", c === value && "bg-accent")}
            >
              <span className="size-3 rounded-[4px]" style={{ background: c }} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- Statuses ---------------- */

const STAGES: [StatusCategory, string][] = [
  ["backlog", "Backlog"],
  ["triage", "Triage"],
  ["unstarted", "Not started"],
  ["started", "In progress"],
  ["done", "Done"],
  ["cancelled", "Cancelled"],
];

export function StatusesSettings() {
  const { org, statuses, isAdmin } = useOrg();
  const { pending, run } = useAction();
  const [adding, setAdding] = useState(false);

  const move = (i: number, d: -1 | 1) => {
    const ids = statuses.map((s) => s.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    run(() => reorderStatuses(org.slug, ids));
  };

  return (
    <Row
      title="Workflow statuses"
      desc="Tasks are grouped by status in this order. Each status has a stage: the ring fills as tasks move through the not-started and in-progress stages."
    >
      <ul className="divide-y divide-border rounded-[10px] border border-border">
        {statuses.map((s, i) => (
          <StatusEditor
            key={s.id}
            status={s}
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
          <ul className="mt-3 rounded-[10px] border border-border">
            <StatusEditor
              status={{ id: "", name: "", color: "#737373", category: "started", order: 999 }}
              canEdit
              isNew
              onDone={() => setAdding(false)}
              busy={pending}
            />
          </ul>
        ) : (
          <Button variant="outline" className="mt-3" onClick={() => setAdding(true)}>
            Add status
          </Button>
        ))}
    </Row>
  );
}

function StatusEditor({
  status,
  canEdit,
  first,
  last,
  onMove,
  isNew,
  onDone,
  busy,
}: {
  status: Status;
  canEdit: boolean;
  first?: boolean;
  last?: boolean;
  onMove?: (d: -1 | 1) => void;
  isNew?: boolean;
  onDone?: () => void;
  busy: boolean;
}) {
  const { org, statuses } = useOrg();
  const [name, setName] = useState(status.name);
  const [category, setCategory] = useState<StatusCategory>(status.category);
  const [color, setColor] = useState(status.color);
  const [deleting, setDeleting] = useState(false);
  const [moveTo, setMoveTo] = useState("");
  const { run } = useAction();
  useEffect(() => {
    setName(status.name);
    setCategory(status.category);
    setColor(status.color);
  }, [status]);
  const dirty = name !== status.name || category !== status.category || color !== status.color;
  const save = () =>
    run(async () => {
      const r = await saveStatus(org.slug, { id: status.id || undefined, name, color, category });
      if (r.ok) onDone?.();
      return r;
    }, isNew ? "Status added" : "Status saved");
  const preview: Status = { ...status, color, category, id: status.id || "preview" };

  return (
    <li className="px-3.5 py-2.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <StatusRing status={preview} statuses={isNew ? [...statuses, preview] : statuses} size={16} />
        <ColorDots value={color} disabled={!canEdit} onChange={setColor} />
        <Input
          value={name}
          disabled={!canEdit}
          autoFocus={isNew}
          placeholder="Status name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && dirty && name.trim() && save()}
          aria-label="Status name"
          maxLength={40}
          className="h-8 w-44 border-transparent bg-transparent shadow-none hover:border-input focus-visible:border-input dark:bg-transparent"
        />
        <Select value={category} onValueChange={(v) => setCategory(v as StatusCategory)} disabled={!canEdit}>
          <SelectTrigger size="sm" className="w-36" aria-label="Stage">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STAGES.map(([v, l]) => (
              <SelectItem key={v} value={v}>
                {l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {canEdit && (
          <div className="ml-auto flex items-center gap-1">
            {(dirty || isNew) && (
              <>
                {isNew && (
                  <Button size="sm" variant="ghost" onClick={onDone}>
                    Cancel
                  </Button>
                )}
                <Button size="sm" onClick={save} disabled={busy || !name.trim()}>
                  {isNew ? "Add" : "Save"}
                </Button>
              </>
            )}
            {!isNew && (
              <>
                <Button variant="ghost" size="icon-sm" aria-label="Move up" disabled={first || busy} onClick={() => onMove?.(-1)}>
                  <ArrowUpIcon />
                </Button>
                <Button variant="ghost" size="icon-sm" aria-label="Move down" disabled={last || busy} onClick={() => onMove?.(1)}>
                  <ArrowDownIcon />
                </Button>
                <Button variant="ghost" size="icon-sm" aria-label={`Delete ${status.name}`} className="text-faint hover:text-destructive" onClick={() => setDeleting((d) => !d)} disabled={statuses.length <= 1}>
                  <Trash2Icon />
                </Button>
              </>
            )}
          </div>
        )}
      </div>
      {deleting && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-lg bg-sidebar px-3 py-2 text-[13px]">
          Move its tasks to
          <Select value={moveTo} onValueChange={setMoveTo}>
            <SelectTrigger size="sm" className="w-40" aria-label="Move tasks to">
              <SelectValue placeholder="Pick a status" />
            </SelectTrigger>
            <SelectContent>
              {statuses
                .filter((s) => s.id !== status.id)
                .map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="destructive" disabled={!moveTo} onClick={() => run(() => deleteStatus(org.slug, status.id, moveTo), "Status deleted")}>
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

