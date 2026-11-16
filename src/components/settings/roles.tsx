"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PlusIcon, ShieldCheckIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useOrg } from "@/components/org-provider";
import { DetailHeader, EntityList, EntityRow, SettingsRow, Tag } from "@/components/settings/ui";
import { BotAvatar } from "@/components/bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
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
import { createBotRole, deleteBotRole, updateBotRole } from "@/app/actions/bot-roles";
import { MCP_TOOLS, TOOL_GROUPS } from "@/lib/mcp/catalog";
import { timeAgo } from "@/lib/format";
import type { Bot, BotRole } from "@/lib/types";
import { orgPath, rolePath, rolesPath } from "@/lib/paths";

const allowedCount = (tools: Record<string, boolean>) => MCP_TOOLS.filter((t) => tools[t.name] === true).length;

/** What check_for_triage's job needs besides itself: read the task, create the steps, wire them up, finish. */
const TRIAGE_NEEDS = ["get_workspace", "create_task", "update_task", "complete_task"];
const missingForTriage = (tools: Record<string, boolean>) => TRIAGE_NEEDS.filter((n) => !tools[n]);

export function RoleGlyph({ size = 32 }: { size?: number }) {
  return (
    <span className="grid place-items-center rounded-[9px] border border-border bg-sidebar text-muted-foreground" style={{ width: size, height: size }}>
      <ShieldCheckIcon style={{ width: size * 0.5, height: size * 0.5 }} />
    </span>
  );
}

/* ---------------- list ---------------- */

export function RolesSettings({ roles, usage }: { roles: BotRole[]; usage: Record<string, number> }) {
  const { org, isAdmin } = useOrg();
  const [creating, setCreating] = useState(false);
  return (
    <>
      <SettingsRow
        id="roles"
        title="Roles"
        desc={
          <>
            A role is a list of MCP tools a bot may use. Apply one to a bot on its page; the bot only sees the tools its role allows, over MCP and
            the REST API. Bots without a role can use every tool except triage, which a role has to switch on.
          </>
        }
      >
        {roles.length === 0 ? (
          <div className="flex flex-col items-start rounded-[10px] border border-dashed border-input px-5 py-8">
            <RoleGlyph />
            <h3 className="mt-3.5 text-[14px] font-semibold">No roles yet</h3>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {isAdmin ? "Create one to limit what a bot can do, like a read-only reporter, or to make a triage bot that breaks new Triage tasks into planned work." : "Ask an admin to create one."}
            </p>
          </div>
        ) : (
          <EntityList>
            {roles.map((r) => (
              <EntityRow
                key={r.id}
                href={rolePath(org.slug, r.id)}
                avatar={<RoleGlyph />}
                name={r.name}
                subtitle={r.description || "No description"}
                meta={
                  <>
                    <div>
                      {allowedCount(r.tools)} of {MCP_TOOLS.length} tools
                    </div>
                    <div className="mt-0.5">
                      {usage[r.id] ? `${usage[r.id]} bot${usage[r.id] === 1 ? "" : "s"}` : "No bots"}
                    </div>
                  </>
                }
              />
            ))}
          </EntityList>
        )}
      </SettingsRow>
      {isAdmin && (
        <SettingsRow title="Add a role" desc="New roles start with every tool allowed except triage. Switch off what the bot shouldn't do, or switch triage on to make a triage bot.">
          <Button onClick={() => setCreating(true)} className="gap-2">
            <PlusIcon className="size-3.5" /> New role
          </Button>
        </SettingsRow>
      )}
      <NewRoleDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function NewRoleDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { org } = useOrg();
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  const close = () => {
    onClose();
    setTimeout(() => {
      setName("");
      setDescription("");
      setError(undefined);
    }, 200);
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="gap-0 p-0 sm:max-w-[480px]">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const r = await createBotRole(org.slug, { name, description });
              if (!r.ok) return setError(r.error);
              close();
              router.push(rolePath(org.slug, r.data!.id));
            });
          }}
        >
          <div className="px-5 pt-5">
            <DialogTitle className="text-[15px] font-semibold">New bot role</DialogTitle>
            <DialogDescription className="mt-1 text-[13px] text-muted-foreground">Name it after the job. You&rsquo;ll pick its tools next.</DialogDescription>
          </div>
          <div className="grid gap-5 px-5 py-5">
            <div className="grid gap-1.5">
              <Label htmlFor="role-name">Name</Label>
              <Input id="role-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Triager" maxLength={40} autoFocus />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="role-desc">Description</Label>
              <Textarea
                id="role-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Reads and comments on tasks, moves status. Can't create tasks."
                maxLength={280}
                rows={3}
              />
            </div>
          </div>
          <div className="flex items-center gap-3 border-t border-border px-5 py-3">
            <p role="alert" aria-live="polite" className="min-w-0 flex-1 truncate text-[13px] text-destructive">
              {error}
            </p>
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending ? "Creating…" : "Create role"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- detail ---------------- */

export function RoleDetail({ role: initial, bots }: { role: BotRole; bots: Bot[] }) {
  const { org, isAdmin } = useOrg();
  const router = useRouter();
  const [role, setRole] = useState(initial);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [tools, setTools] = useState<Record<string, boolean>>(() => Object.fromEntries(MCP_TOOLS.map((t) => [t.name, initial.tools[t.name] === true])));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, start] = useTransition();

  const saved = Object.fromEntries(MCP_TOOLS.map((t) => [t.name, role.tools[t.name] === true]));
  const dirty = name !== role.name || description !== role.description || JSON.stringify(tools) !== JSON.stringify(saved);
  const setAll = (names: string[], v: boolean) => setTools((t) => ({ ...t, ...Object.fromEntries(names.map((n) => [n, v])) }));

  const save = () =>
    start(async () => {
      const r = await updateBotRole(org.slug, role.id, { name, description, tools });
      if (!r.ok) return void toast.error(r.error);
      setRole(r.data!);
      toast.success("Role saved");
      router.refresh();
    });

  return (
    <>
      <DetailHeader
        back={{ href: rolesPath(org.slug), label: "Bots" }}
        avatar={<RoleGlyph size={44} />}
        name={role.name}
        tags={<Tag>Role</Tag>}
        subtitle={`${allowedCount(role.tools)} of ${MCP_TOOLS.length} tools allowed · updated ${timeAgo(role.updatedAt)}`}
      />

      <SettingsRow title="Details" desc="Shown on the bot's page and in the role picker.">
        <div className="grid max-w-xl gap-5">
          <div className="grid gap-1.5">
            <Label htmlFor="role-name">Name</Label>
            <Input id="role-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} disabled={!isAdmin} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="role-desc">Description</Label>
            <Textarea id="role-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={280} rows={3} disabled={!isAdmin} />
          </div>
        </div>
      </SettingsRow>

      {TOOL_GROUPS.map((g) => {
        const groupTools = MCP_TOOLS.filter((t) => t.group === g.id);
        const names = groupTools.map((t) => t.name);
        return (
          <SettingsRow
            key={g.id}
            title={g.title}
            desc={
              <>
                {g.desc}
                {isAdmin && (
                  <span className="mt-2 flex gap-3">
                    <button type="button" className="text-[12.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => setAll(names, true)}>
                      Allow all
                    </button>
                    <button type="button" className="text-[12.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => setAll(names, false)}>
                      Deny all
                    </button>
                  </span>
                )}
              </>
            }
          >
            {g.id === "triage" && tools.check_for_triage && missingForTriage(tools).length > 0 && (
              <p className="mb-2.5 rounded-lg bg-sidebar px-3 py-2 text-[12.5px] text-muted-foreground">
                To break tasks down, a triage bot also needs {missingForTriage(tools).map((n) => MCP_TOOLS.find((t) => t.name === n)?.title ?? n).join(", ")}.
              </p>
            )}
            <ul className="divide-y divide-border rounded-[10px] border border-border">
              {groupTools.map((t) => {
                const on = tools[t.name];
                return (
                  <li key={t.name} className="flex items-center gap-4 px-3.5 py-3">
                    <div className="min-w-0 flex-1 leading-tight">
                      <div className="flex items-baseline gap-2">
                        <span className="text-[13.5px] font-medium">{t.title}</span>
                        <code className="font-mono text-[11.5px] text-faint">{t.name}</code>
                      </div>
                      <p className="mt-1 text-[12.5px] text-muted-foreground">{t.summary}</p>
                    </div>
                    <span className={cn("w-12 text-right text-[12px]", on ? "text-foreground" : "text-faint")}>{on ? "Allow" : "Deny"}</span>
                    <Switch
                      checked={on}
                      disabled={!isAdmin}
                      onCheckedChange={(v) => setTools((s) => ({ ...s, [t.name]: v }))}
                      aria-label={`${on ? "Deny" : "Allow"} ${t.title}`}
                    />
                  </li>
                );
              })}
            </ul>
          </SettingsRow>
        );
      })}

      {isAdmin && (
        <div className="sticky bottom-0 -mx-4 flex items-center gap-2 border-t border-border bg-background/95 px-4 py-3 backdrop-blur sm:-mx-7 sm:px-7">
          <Button onClick={save} disabled={pending || !dirty || !name.trim()}>
            {pending ? "Saving…" : "Save changes"}
          </Button>
          {dirty && (
            <Button
              variant="ghost"
              onClick={() => {
                setName(role.name);
                setDescription(role.description);
                setTools(saved);
              }}
            >
              Discard
            </Button>
          )}
          <span className="ml-auto text-[12.5px] text-faint">
            {MCP_TOOLS.filter((t) => tools[t.name]).length} of {MCP_TOOLS.length} allowed
          </span>
        </div>
      )}

      <SettingsRow title="Bots with this role" desc="Change a bot's role on its page.">
        {bots.length ? (
          <ul className="grid gap-1">
            {bots.map((b) => (
              <li key={b.id}>
                <Link href={orgPath(org.slug, "settings", "bots", b.id)} className="-mx-3 flex h-9 items-center gap-3 rounded-[9px] px-3 text-[13.5px] transition-colors hover:bg-accent">
                  <BotAvatar avatar={b.avatar} name={b.name} size={20} />
                  <span className="truncate">{b.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-muted-foreground">No bots use this role yet.</p>
        )}
      </SettingsRow>

      {isAdmin && (
        <SettingsRow title="Delete role" desc={bots.length ? "Give its bots another role first." : "Bots can't be left without their role, so this only works when no bot uses it."}>
          <Button variant="destructive" disabled={bots.length > 0} onClick={() => setConfirmDelete(true)}>
            <Trash2Icon /> Delete {role.name}
          </Button>
        </SettingsRow>
      )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {role.name}?</AlertDialogTitle>
            <AlertDialogDescription>No bot uses it, so nothing else changes.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep role</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                const r = await deleteBotRole(org.slug, role.id);
                if (!r.ok) return void toast.error(r.error);
                toast.success(`Deleted ${role.name}`);
                router.push(rolesPath(org.slug));
              }}
            >
              Delete role
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
