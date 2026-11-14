"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCwIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { useOrg } from "@/components/org-provider";
import { DetailHeader, SettingsRow, Tag, WorkList } from "@/components/settings/ui";
import { BotAvatar } from "@/components/bits";
import { AvatarPicker } from "@/components/bots/avatar-picker";
import { KeyReveal } from "@/components/bots/key-reveal";
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
import { deleteBot, rerollBotKey, updateBot } from "@/app/actions/bots";
import { timeAgo } from "@/lib/format";
import type { Bot, BotAvatar as BotAvatarData, Task } from "@/lib/types";

const Row = SettingsRow;

export function BotDetail({ bot: initial, assigned, createdCount }: { bot: Bot; assigned: Task[]; createdCount: number }) {
  const { org, isAdmin, memberById, projects } = useOrg();
  const router = useRouter();
  const [bot, setBot] = useState(initial);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [avatar, setAvatar] = useState<BotAvatarData>(initial.avatar);
  const [newKey, setNewKey] = useState<string>();
  const [confirmReroll, setConfirmReroll] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [origin, setOrigin] = useState("https://your-vector-host");
  const [pending, start] = useTransition();
  useEffect(() => setOrigin(window.location.origin), []);

  const dirty = name !== bot.name || description !== bot.description || JSON.stringify(avatar) !== JSON.stringify(bot.avatar);
  const creator = memberById.get(bot.createdBy);
  const sampleProject = projects[0]?.key ?? "WEB";

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
        back={{ href: `/${org.slug}/settings/bots`, label: "Bots" }}
        avatar={<BotAvatar avatar={bot.avatar} name={bot.name} size={44} />}
        name={bot.name}
        tags={<Tag>Bot</Tag>}
        subtitle={bot.description || "No description"}
      />

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
            title="API key"
            desc="Send it as a Bearer token. Rerolling creates a new key and stops the old one immediately."
          >
            <div className="grid max-w-xl gap-3">
              <div className="flex flex-wrap items-center gap-3 rounded-[10px] border border-border px-3.5 py-2.5">
                <code className="font-mono text-[13px]">{bot.keyHint}</code>
                <span className="text-[12.5px] text-faint">
                  Issued {timeAgo(bot.keyRotatedAt)} · {bot.lastUsedAt ? `last used ${timeAgo(bot.lastUsedAt)}` : "never used"}
                </span>
                {isAdmin && (
                  <Button variant="outline" size="sm" className="ml-auto" onClick={() => setConfirmReroll(true)}>
                    <RefreshCwIcon /> Reroll key
                  </Button>
                )}
              </div>
              {newKey && <KeyReveal apiKey={newKey} />}
            </div>
          </Row>

          <Row title="Using the API" desc={<>Bots can create tasks, update the tasks they created, comment on any task and be assigned work.</>}>
            <pre className="max-w-full overflow-x-auto rounded-[10px] border border-border bg-sidebar px-4 py-3 font-mono text-[12px] leading-relaxed text-foreground">
              {`curl ${origin}/api/v1/tasks \\
  -H "Authorization: Bearer ${newKey ?? "vec_…"}" \\
  -H "Content-Type: application/json" \\
  -d '{"project":"${sampleProject}","title":"Checkout fails on Safari","type":"issue","assignee":"me"}'`}
            </pre>
            <ul className="mt-3 grid gap-1 font-mono text-[12px] text-muted-foreground">
              <li>GET /api/v1/me · /projects · /statuses · /members</li>
              <li>GET /api/v1/tasks?project=WEB&amp;assignee=me&amp;status=Todo</li>
              <li>POST /api/v1/tasks · GET|PATCH /api/v1/tasks/WEB-12</li>
              <li>POST /api/v1/tasks/WEB-12/comments</li>
            </ul>
          </Row>

          <Row title="Work" desc={`Open tasks assigned to ${bot.name}. It has created ${createdCount} task${createdCount === 1 ? "" : "s"}.`}>
            <WorkList tasks={assigned} emptyText={`Nothing is assigned to ${bot.name} right now.`} />
          </Row>

          {isAdmin && (
            <Row title="Delete bot" desc="Its key stops working and its tasks become unassigned. Tasks and comments it created stay.">
              <Button variant="destructive" onClick={() => setConfirmDelete(true)}>
                <Trash2Icon /> Delete {bot.name}
              </Button>
            </Row>
          )}

      <AlertDialog open={confirmReroll} onOpenChange={setConfirmReroll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reroll {bot.name}&rsquo;s key?</AlertDialogTitle>
            <AlertDialogDescription>
              Anything using {bot.keyHint} stops working immediately. You&rsquo;ll see the new key once.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep current key</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                const r = await rerollBotKey(org.slug, bot.id);
                if (!r.ok) return void toast.error(r.error);
                setBot(r.data!.bot);
                setNewKey(r.data!.key);
              }}
            >
              Reroll key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
                router.push(`/${org.slug}/settings/bots`);
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
