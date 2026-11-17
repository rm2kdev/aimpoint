"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronRightIcon, Trash2Icon, WorkflowIcon } from "lucide-react";
import { toast } from "sonner";
import { useOrg } from "@/components/org-provider";
import { AnalyticsLink, DetailHeader, SettingsRow, Tag, WorkList } from "@/components/settings/ui";
import { BotAvatar } from "@/components/bits";
import { AvatarPicker } from "@/components/bots/avatar-picker";
import { BotConnection } from "@/components/bots/connect-wizard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
import { deleteBot, setBotMaxTasks, updateBot } from "@/app/actions/bots";
import { setBotRole } from "@/app/actions/bot-roles";
import { MCP_TOOLS } from "@/lib/mcp/catalog";
import { timeAgo } from "@/lib/format";
import { BOT_MAX_TASKS_MAX, BOT_MAX_TASKS_MIN } from "@/lib/types";
import type { Bot, BotAvatar as BotAvatarData, BotRole, Task } from "@/lib/types";
import { analyticsPath, flowsPath, orgPath, projectFlowPath, rolesPath } from "@/lib/paths";
import { ProjectTile } from "@/components/settings/org-settings";
import type { BotFlowPlace } from "@/lib/flows";
import { analyticsSearchFor } from "@/lib/analytics-range";

const Row = SettingsRow;

export function BotDetail({
  bot: initial,
  assigned,
  createdCount,
  roles,
  pickedUp,
  flowPlaces,
}: {
  bot: Bot;
  assigned: Task[];
  createdCount: number;
  roles: BotRole[];
  /** Ids of assigned tasks the bot has picked up over MCP. */
  pickedUp: string[];
  /** Flow steps it owns, resolves or triages (VEC-187), edited in the flows. */
  flowPlaces: BotFlowPlace[];
}) {
  const { org, isAdmin, memberById } = useOrg();
  const router = useRouter();
  const [bot, setBot] = useState(initial);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [avatar, setAvatar] = useState<BotAvatarData>(initial.avatar);
  // The bot's key, when this page has it in hand: just created (handed over by the New bot dialog) or made in the connection setup.
  const [newKey, setNewKey] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [maxTasks, setMaxTasks] = useState(String(initial.maxTasks));
  const [pending, start] = useTransition();
  useEffect(() => {
    const k = `vector:new-bot-key:${initial.id}`;
    const key = sessionStorage.getItem(k);
    if (key) {
      sessionStorage.removeItem(k);
      setNewKey(key);
    }
  }, [initial.id]);

  const dirty = name !== bot.name || description !== bot.description || JSON.stringify(avatar) !== JSON.stringify(bot.avatar);
  const creator = memberById.get(bot.createdBy);
  const role = roles.find((r) => r.id === bot.roleId);
  const picked = new Set(pickedUp);

  const maxNum = Number(maxTasks);
  const maxValid = maxTasks.trim() !== "" && Number.isInteger(maxNum) && maxNum >= BOT_MAX_TASKS_MIN && maxNum <= BOT_MAX_TASKS_MAX;
  const maxDirty = maxTasks !== String(bot.maxTasks);
  const saveMax = () =>
    start(async () => {
      const r = await setBotMaxTasks(org.slug, bot.id, maxNum);
      if (!r.ok) return void toast.error(r.error);
      setBot(r.data!);
      setMaxTasks(String(r.data!.maxTasks));
      toast.success(`${bot.name} takes up to ${r.data!.maxTasks} task${r.data!.maxTasks === 1 ? "" : "s"} at once`);
      router.refresh();
    });

  const save = () =>
    start(async () => {
      const r = await updateBot(org.slug, bot.id, { name, description, avatar });
      if (!r.ok) return void toast.error(r.error);
      setBot(r.data!);
      toast.success("Bot saved");
      router.refresh();
    });

  return (
    <>
      <DetailHeader
        back={{ href: orgPath(org.slug, "settings", "bots"), label: "Bots" }}
        avatar={<BotAvatar avatar={bot.avatar} name={bot.name} size={44} />}
        name={bot.name}
        tags={<Tag>Bot</Tag>}
        subtitle={bot.description || "No description"}
        action={isAdmin ? <AnalyticsLink href={analyticsPath(org.slug, analyticsSearchFor({ bot: bot.id }))} label={`Analytics for ${bot.name}`} /> : undefined}
      />

          <Row
            title="Backend"
            desc={
              <>
                What runs {bot.name}. When it&rsquo;s assigned a task or @mentioned, Aimpoint sends the task and its thread to this backend, and the agent works on
                the ticket through Aimpoint&rsquo;s tools.
              </>
            }
          >
            <BotConnection bot={bot} setBot={setBot} apiKey={newKey} setApiKey={(k) => setNewKey(k)} />
          </Row>

          <Row
            title="Profile"
            desc={
              <>
                How {bot.name} appears on tasks, in the assignee picker and in activity. Created by {creator?.name ?? "a former member"}{" "}
                {timeAgo(bot.createdAt)}.
              </>
            }
          >
            <div className="grid max-w-xl gap-5">
              <AvatarPicker orgSlug={org.slug} value={avatar} onChange={setAvatar} name={name} disabled={!isAdmin} />
              <div className="grid gap-1.5">
                <Label htmlFor="bot-name">Name</Label>
                <Input id="bot-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} disabled={!isAdmin} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="bot-desc">Description</Label>
                <Textarea id="bot-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={280} rows={3} disabled={!isAdmin} />
              </div>
              {isAdmin && (
                <div className="flex gap-2">
                  <Button onClick={save} disabled={pending || !dirty || !name.trim()}>
                    {pending ? "Saving…" : "Save changes"}
                  </Button>
                  {dirty && (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setName(bot.name);
                        setDescription(bot.description);
                        setAvatar(bot.avatar);
                      }}
                    >
                      Discard
                    </Button>
                  )}
                </div>
              )}
            </div>
          </Row>

          <Row
            title="Role"
            desc={
              <>
                Which MCP tools {bot.name} can use. Without a role it can use all of them except triage; give it a role with Check for triage on to make it a triage bot.{" "}
                <Link href={rolesPath(org.slug)} className="underline underline-offset-2 hover:text-foreground">
                  Manage roles
                </Link>
              </>
            }
          >
            <div className="grid max-w-xl gap-2">
              <Select
                value={bot.roleId ?? "none"}
                disabled={!isAdmin || pending}
                onValueChange={(v) =>
                  start(async () => {
                    const roleId = v === "none" ? null : v;
                    const r = await setBotRole(org.slug, bot.id, roleId);
                    if (!r.ok) return void toast.error(r.error);
                    setBot((b) => ({ ...b, roleId }));
                    toast.success(roleId ? `${bot.name} is now ${roles.find((x) => x.id === roleId)?.name}` : `${bot.name} can use every tool except triage`);
                    router.refresh();
                  })
                }
              >
                <SelectTrigger className="w-full max-w-xs" aria-label="Bot role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No role (every tool except triage)</SelectItem>
                  {roles.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[12.5px] text-faint">
                {role
                  ? `${MCP_TOOLS.filter((t) => role.tools[t.name]).length} of ${MCP_TOOLS.length} tools: ${MCP_TOOLS.filter((t) => role.tools[t.name]).map((t) => t.title.toLowerCase()).join(", ") || "none"}.`
                  : `${MCP_TOOLS.filter((t) => !t.optIn).length} of ${MCP_TOOLS.length} tools: everything except triage.`}
              </p>
            </div>
          </Row>

          <Row
            title="Max concurrent tasks"
            desc={`How many tasks ${bot.name} works on at once (${BOT_MAX_TASKS_MIN}-${BOT_MAX_TASKS_MAX}). Shown in the bot status tray; Aimpoint doesn't hold work back when it's reached yet.`}
          >
            <form
              className="flex max-w-xl items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (maxValid && maxDirty) saveMax();
              }}
            >
              <Input
                type="number"
                inputMode="numeric"
                min={BOT_MAX_TASKS_MIN}
                max={BOT_MAX_TASKS_MAX}
                step={1}
                value={maxTasks}
                onChange={(e) => setMaxTasks(e.target.value)}
                disabled={!isAdmin || pending}
                aria-label="Max concurrent tasks"
                aria-invalid={!maxValid || undefined}
                className="w-24 tabular-nums"
              />
              {isAdmin && maxDirty && (
                <>
                  <Button type="submit" disabled={pending || !maxValid}>
                    Save
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setMaxTasks(String(bot.maxTasks))}>
                    Discard
                  </Button>
                </>
              )}
              {!isAdmin && <span className="text-[12.5px] text-faint">Only admins can change this.</span>}
            </form>
            {isAdmin && maxDirty && !maxValid && (
              <p className="mt-1.5 text-[12.5px] text-destructive">Use a whole number from {BOT_MAX_TASKS_MIN} to {BOT_MAX_TASKS_MAX}.</p>
            )}
          </Row>

          <Row
            id="flows"
            title="Where it works"
            desc={
              <>
                The flow steps {bot.name} owns, can mark received, or picks up as a triage bot. Change them in the{" "}
                <Link href={flowsPath(org.slug)} className="underline underline-offset-2 hover:text-foreground">
                  default flow
                </Link>{" "}
                or on a project&rsquo;s Flow row. Each project&rsquo;s agent context goes to it with the task.
              </>
            }
          >
            {flowPlaces.length === 0 ? (
              <div className="max-w-3xl rounded-[10px] border border-dashed border-input px-4 py-5 text-[13px] text-muted-foreground">
                No flow step names {bot.name} yet. It works on tasks someone assigns or @mentions it on.
              </div>
            ) : (
              <ul className="max-w-3xl divide-y divide-border rounded-[10px] border border-border" aria-label={`Flows ${bot.name} works in`}>
                {flowPlaces.map((f) => (
                  <li key={f.project?.id ?? "org"}>
                    <Link
                      href={f.project ? projectFlowPath(org.slug, f.project.id) : flowsPath(org.slug)}
                      className="group flex items-center gap-3 px-3.5 py-2.5 transition-colors first:rounded-t-[10px] last:rounded-b-[10px] hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                    >
                      {f.project ? (
                        <ProjectTile color={f.project.color} size={22} />
                      ) : (
                        <span className="grid size-[22px] shrink-0 place-items-center rounded-md bg-chip text-muted-foreground" aria-hidden>
                          <WorkflowIcon className="size-3.5" />
                        </span>
                      )}
                      <span className="min-w-0 flex-1 leading-tight">
                        <span className="flex items-center gap-1.5 text-[13.5px] font-medium">
                          <span className="truncate">{f.project ? f.project.name : "Default flow"}</span>
                          {f.project && <span className="font-mono text-[12px] font-normal text-faint">{f.project.key}</span>}
                        </span>
                        <span className="mt-0.5 block truncate text-[12.5px] text-muted-foreground">
                          {f.steps.map((s) => `${s.name} (${s.as.map((a) => (a === "owner" ? "owner" : a === "triage" ? "as a triage bot" : "can mark received")).join(", ")})`).join(" · ")}
                        </span>
                      </span>
                      <span className="shrink-0 text-[12px] text-faint">
                        {f.project ? "Own flow" : `${f.followedBy} project${f.followedBy === 1 ? "" : "s"}`}
                      </span>
                      <ChevronRightIcon className="size-4 shrink-0 text-faint transition-transform group-hover:translate-x-0.5" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Row>

          <Row title="Work" desc={`Open tasks assigned to ${bot.name}. It has created ${createdCount} task${createdCount === 1 ? "" : "s"}.`}>
            <WorkList tasks={assigned} emptyText={`Nothing is assigned to ${bot.name} right now.`} note={(t) => (picked.has(t.id) ? "Picked up" : undefined)} />
          </Row>

          {isAdmin && (
            <Row title="Delete bot" desc="Its key stops working and its tasks become unassigned. Tasks and comments it created stay.">
              <Button variant="destructive" onClick={() => setConfirmDelete(true)}>
                <Trash2Icon /> Delete {bot.name}
              </Button>
            </Row>
          )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {bot.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its API key stops working and {assigned.length ? `${assigned.length} assigned task${assigned.length === 1 ? "" : "s"} become` : "its tasks become"} unassigned.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep bot</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                const r = await deleteBot(org.slug, bot.id);
                if (!r.ok) return void toast.error(r.error);
                toast.success(`Deleted ${bot.name}`);
                router.push(orgPath(org.slug, "settings", "bots"));
              }}
            >
              Delete bot
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
