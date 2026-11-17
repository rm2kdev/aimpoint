"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useOrg } from "@/components/org-provider";
import { EntityList, EntityRow, SettingsRow, Tag, useAction } from "@/components/settings/ui";
import { ProjectDot } from "@/components/bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createProject,
  removeMember,
  renameOrg,
} from "@/app/actions/org";
import type { Role } from "@/lib/types";
import { orgPath, projectSettingsPath } from "@/lib/paths";
import { UpgradeNote } from "@/components/upgrade-note";
import { atLimit, limitReason } from "@/lib/billing-view";

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
  const { org, projects, isAdmin, counts, billing } = useOrg();
  // Free plan (VEC-226): archived projects count too, matching the server check.
  const projectsFull = atLimit(billing, "projects");
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
              href={projectSettingsPath(org.slug, p.id)}
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
                router.push(projectSettingsPath(org.slug, r.data!.id));
              });
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="pname">Name</Label>
              <Input id="pname" value={name} onChange={(e) => setName(e.target.value)} placeholder="Mobile App" autoFocus={openNew && !projectsFull} maxLength={60} disabled={projectsFull} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="pkey">Key</Label>
              <Input
                id="pkey"
                value={key}
                onChange={(e) => setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10))}
                placeholder={autoKey || "MOB"}
                disabled={projectsFull}
                className="w-32 font-mono uppercase"
              />
            </div>
            <div>
              <Button type="submit" disabled={pending || projectsFull || !name.trim()}>
                Create project
              </Button>
              {projectsFull && (
                <UpgradeNote reason={`${limitReason(billing, "projects")}${billing.usage.archivedProjects ? " Archived projects count." : ""}`} />
              )}
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
