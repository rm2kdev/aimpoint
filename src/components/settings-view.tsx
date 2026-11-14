"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDownIcon, ArrowUpIcon, CopyIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useOrg } from "@/components/org-provider";
import { MobileNavButton } from "@/components/app-shell";
import { ProjectDot, StatusRing, UserAvatar } from "@/components/bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  createInvite,
  createProject,
  deleteProject,
  deleteStatus,
  removeMember,
  renameOrg,
  reorderStatuses,
  revokeInvite,
  saveStatus,
  setMemberRole,
  updateProject,
} from "@/app/actions/org";
import type { Role, Status, StatusCategory } from "@/lib/types";

const TABS = [
  ["general", "General"],
  ["projects", "Projects"],
  ["statuses", "Statuses"],
  ["members", "Members"],
] as const;

export interface InviteRow {
  id: string;
  email: string;
  role: Role;
  token: string;
  expiresAt: string;
}

export function SettingsView({ initialTab, invites, openNewProject }: { initialTab: string; invites: InviteRow[]; openNewProject: boolean }) {
  const [tab, setTab] = useState(TABS.some(([t]) => t === initialTab) ? initialTab : "general");
  useEffect(() => setTab(TABS.some(([t]) => t === initialTab) ? initialTab : "general"), [initialTab]);
  const { isAdmin } = useOrg();

  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label="Settings">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 sm:px-7">
        <MobileNavButton />
        <h1 className="text-[15px] font-semibold tracking-[-0.01em]">Settings</h1>
        <nav className="ml-4 flex items-center gap-1" role="tablist">
          {TABS.map(([t, label]) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => {
                setTab(t);
                history.replaceState(null, "", `?tab=${t}`);
              }}
              className={cn(
                "h-7 rounded-md px-2.5 text-[13px] transition-colors",
                tab === t ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="max-w-[1100px] px-4 py-6 sm:px-7">
          {!isAdmin && (
            <p className="mb-6 rounded-lg border border-border bg-sidebar px-3.5 py-2.5 text-[13px] text-muted-foreground">
              You&rsquo;re a member. Only admins can change organisation settings.
            </p>
          )}
          {tab === "general" && <General />}
          {tab === "projects" && <Projects openNew={openNewProject} />}
          {tab === "statuses" && <Statuses />}
          {tab === "members" && <Members invites={invites} />}
        </div>
      </div>
    </section>
  );
}

function Row({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-4 border-b border-border py-7 first:pt-1 last:border-0 md:grid-cols-[280px_minmax(0,1fr)] md:gap-10">
      <div>
        <h2 className="text-[14px] font-semibold">{title}</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">{desc}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function useAction() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, success?: string) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.error);
      else {
        if (success) toast.success(success);
        router.refresh();
      }
    });
  return { pending, run };
}

/* ---------------- General ---------------- */

function General() {
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
          URL: <span className="font-mono">/{org.slug}</span>
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

function Projects({ openNew }: { openNew: boolean }) {
  const { org, projects, isAdmin, counts } = useOrg();
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const { pending, run } = useAction();
  const suggested = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  const autoKey = suggested.length > 1 ? suggested.map((w) => w[0]).join("").slice(0, 5) : (suggested[0] ?? "").slice(0, 3);

  return (
    <>
      <Row title="Projects" desc="Every task belongs to one project. Task IDs use the project key, like WEB-12.">
        <ul className="divide-y divide-border rounded-[10px] border border-border">
          {projects.map((p) => (
            <ProjectRow key={p.id} id={p.id} name={p.name} pkey={p.key} color={p.color} open={counts.projects[p.id] ?? 0} canEdit={isAdmin} />
          ))}
        </ul>
      </Row>
      {isAdmin && (
        <Row title="New project" desc="Keys are short and permanent: 2-10 letters or digits.">
          <form
            className="grid max-w-md gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                const r = await createProject(org.slug, { name, key: key || autoKey });
                if (r.ok) {
                  setName("");
                  setKey("");
                }
                return r;
              }, "Project created");
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

function ProjectRow({ id, name, pkey, color, open, canEdit }: { id: string; name: string; pkey: string; color: string; open: number; canEdit: boolean }) {
  const { org } = useOrg();
  const [draft, setDraft] = useState(name);
  const { pending, run } = useAction();
  useEffect(() => setDraft(name), [name]);
  return (
    <li className="flex flex-wrap items-center gap-3 px-3.5 py-2.5">
      <ColorDots value={color} disabled={!canEdit} onChange={(c) => run(() => updateProject(org.slug, id, { color: c }))} />
      <Input
        value={draft}
        disabled={!canEdit}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft.trim() && draft !== name && run(() => updateProject(org.slug, id, { name: draft }), "Project renamed")}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        aria-label={`Name of ${pkey}`}
        className="h-8 max-w-[240px] flex-1 border-transparent bg-transparent shadow-none hover:border-input focus-visible:border-input dark:bg-transparent"
      />
      <span className="font-mono text-[12px] text-faint">{pkey}</span>
      <span className="tabular ml-auto text-[12.5px] text-muted-foreground">{open} open</span>
      {canEdit && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Delete ${name}`}
          className="text-faint hover:text-destructive"
          disabled={pending}
          onClick={() => confirm(`Delete project ${name}?`) && run(() => deleteProject(org.slug, id), "Project deleted")}
        >
          <Trash2Icon />
        </Button>
      )}
    </li>
  );
}

function ColorDots({ value, onChange, disabled }: { value: string; onChange: (c: string) => void; disabled?: boolean }) {
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
  ["unstarted", "Not started"],
  ["started", "In progress"],
  ["done", "Done"],
  ["cancelled", "Cancelled"],
];

function Statuses() {
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

/* ---------------- Members ---------------- */

function Members({ invites }: { invites: InviteRow[] }) {
  const { org, members, me, isAdmin } = useOrg();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [link, setLink] = useState<string>();
  const { pending, run } = useAction();

  const copy = (path: string) => {
    navigator.clipboard.writeText(`${location.origin}${path}`);
    toast.success("Invite link copied");
  };

  return (
    <>
      <Row title="Members" desc="Admins manage members, projects and statuses. Members create and work on tasks.">
        <ul className="divide-y divide-border rounded-[10px] border border-border">
          {members.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-3 px-3.5 py-2.5">
              <UserAvatar id={m.id} name={m.name} size={28} />
              <div className="min-w-0 flex-1 leading-tight">
                <div className="truncate text-[13.5px] font-medium">
                  {m.name}
                  {m.id === me.id && <span className="ml-1.5 font-normal text-faint">you</span>}
                </div>
                <div className="truncate text-[12.5px] text-muted-foreground">{m.email}</div>
              </div>
              {isAdmin ? (
                <Select value={m.role} onValueChange={(v) => run(() => setMemberRole(org.slug, m.id, v as Role), "Role updated")}>
                  <SelectTrigger size="sm" className="w-28" aria-label={`Role for ${m.name}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">Admin</SelectItem>
                    <SelectItem value="member">Member</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <span className="text-[12.5px] text-muted-foreground">{m.role === "admin" ? "Admin" : "Member"}</span>
              )}
              {isAdmin && m.id !== me.id && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${m.name}`}
                  className="text-faint hover:text-destructive"
                  onClick={() => confirm(`Remove ${m.name} from ${org.name}?`) && run(() => removeMember(org.slug, m.id), "Member removed")}
                >
                  <Trash2Icon />
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Row>
      {isAdmin && (
        <Row title="Invite people" desc="Creates a link that works once and expires in 14 days. Send it however you like.">
          <form
            className="flex max-w-lg flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                const r = await createInvite(org.slug, email, role);
                if (r.ok && r.data) {
                  setLink(r.data.url);
                  setEmail("");
                  copy(r.data.url);
                }
                return r;
              });
            }}
          >
            <Input type="email" placeholder="teammate@company.com" value={email} onChange={(e) => setEmail(e.target.value)} className="min-w-56 flex-1" aria-label="Email" />
            <Select value={role} onValueChange={(v) => setRole(v as Role)}>
              <SelectTrigger className="w-28" aria-label="Role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">Member</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
            <Button type="submit" disabled={pending || !email.trim()}>
              Create invite
            </Button>
          </form>
          {link && (
            <p className="mt-3 flex items-center gap-2 text-[12.5px] text-muted-foreground">
              Link copied: <span className="truncate font-mono text-foreground">{link}</span>
            </p>
          )}
          {invites.length > 0 && (
            <ul className="mt-5 divide-y divide-border rounded-[10px] border border-border">
              {invites.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-3 px-3.5 py-2">
                  <span className="min-w-0 flex-1 truncate text-[13px]">{i.email}</span>
                  <span className="text-[12px] text-faint">{i.role === "admin" ? "Admin" : "Member"} · pending</span>
                  <Button variant="ghost" size="icon-sm" aria-label={`Copy invite link for ${i.email}`} onClick={() => copy(`/invite/${i.token}`)}>
                    <CopyIcon />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label={`Revoke invite for ${i.email}`} onClick={() => run(() => revokeInvite(org.slug, i.id), "Invite revoked")}>
                    <Trash2Icon />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Row>
      )}
    </>
  );
}
