"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PlusIcon } from "lucide-react";
import { useOrg } from "@/components/org-provider";
import { EntityList, EntityRow, SettingsRow, Tag } from "@/components/settings/ui";
import { BotAvatar } from "@/components/bits";
import { AvatarPicker, randomAvatar } from "@/components/bots/avatar-picker";
import { KeyReveal } from "@/components/bots/key-reveal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { createBot } from "@/app/actions/bots";
import { timeAgo } from "@/lib/format";
import type { Bot, BotAvatar as BotAvatarData } from "@/lib/types";

export function BotsSettings({ bots, stats }: { bots: Bot[]; stats: Record<string, { assigned: number; created: number }> }) {
  const { org, isAdmin } = useOrg();
  const [creating, setCreating] = useState(false);

  return (
    <>
      <SettingsRow
        title="Bots"
        desc={
          <>
            Automations and AI agents that work in {org.name} through the API. They can create tasks, be assigned work, update the tasks they
            created and comment. Open one to edit it or manage its key.
          </>
        }
      >
        {bots.length === 0 ? (
          <div className="flex flex-col items-start rounded-[10px] border border-dashed border-input px-5 py-8">
            <div className="flex -space-x-1.5">
              {(["ghost", "blob", "star"] as const).map((s, i) => (
                <BotAvatar key={s} avatar={{ kind: "shape", shape: s, color: ["#8b5cf6", "#30a46c", "#e5a00d"][i] }} name={s} size={32} className="ring-2 ring-background" />
              ))}
            </div>
            <h3 className="mt-3.5 text-[14px] font-semibold">No bots yet</h3>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {isAdmin ? "Create one to give a script, CI job or agent its own identity and key." : "Ask an admin to create one."}
            </p>
          </div>
        ) : (
          <EntityList>
            {bots.map((b) => (
              <EntityRow
                key={b.id}
                href={`/${org.slug}/settings/bots/${b.id}`}
                avatar={<BotAvatar avatar={b.avatar} name={b.name} size={32} />}
                name={b.name}
                tags={<Tag>Bot</Tag>}
                subtitle={b.description || "No description"}
                meta={
                  <>
                    <div>
                      {stats[b.id]?.assigned ?? 0} assigned · {stats[b.id]?.created ?? 0} created
                    </div>
                    <div className="mt-0.5">{b.lastUsedAt ? `Active ${timeAgo(b.lastUsedAt)}` : "Never used"}</div>
                  </>
                }
              />
            ))}
          </EntityList>
        )}
      </SettingsRow>
      {isAdmin && (
        <SettingsRow title="Add a bot" desc="Each bot gets its own name, avatar and API key. You'll see the key once, right after creating it.">
          <Button onClick={() => setCreating(true)} className="gap-2">
            <PlusIcon className="size-3.5" /> New bot
          </Button>
        </SettingsRow>
      )}
      <NewBotDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function NewBotDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { org } = useOrg();
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [avatar, setAvatar] = useState<BotAvatarData>(() => randomAvatar());
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<{ bot: Bot; key: string } | null>(null);
  const [pending, start] = useTransition();

  const reset = () => {
    setName("");
    setDescription("");
    setAvatar(randomAvatar());
    setError(undefined);
    setCreated(null);
  };
  const close = () => {
    if (created) router.push(`/${org.slug}/settings/bots/${created.bot.id}`);
    onClose();
    setTimeout(reset, 200);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="gap-0 p-0 sm:max-w-[520px]">
        {created ? (
          <div className="p-5">
            <div className="flex items-center gap-3">
              <BotAvatar avatar={created.bot.avatar} name={created.bot.name} size={40} />
              <div>
                <DialogTitle className="text-[15px] font-semibold">{created.bot.name} is ready</DialogTitle>
                <DialogDescription className="text-[13px] text-muted-foreground">Use this key to call the Vector API as {created.bot.name}.</DialogDescription>
              </div>
            </div>
            <div className="mt-5">
              <KeyReveal apiKey={created.key} />
            </div>
            <div className="mt-5 flex justify-end">
              <Button onClick={close}>Done</Button>
            </div>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              start(async () => {
                const r = await createBot(org.slug, { name, description, avatar });
                if (!r.ok) return setError(r.error);
                setCreated(r.data!);
                router.refresh();
              });
            }}
          >
            <div className="px-5 pt-5">
              <DialogTitle className="text-[15px] font-semibold">New bot</DialogTitle>
              <DialogDescription className="mt-1 text-[13px] text-muted-foreground">Give it a face, a name and a job description.</DialogDescription>
            </div>
            <div className="grid gap-5 px-5 py-5">
              <AvatarPicker orgSlug={org.slug} value={avatar} onChange={setAvatar} name={name} />
              <div className="grid gap-1.5">
                <Label htmlFor="bot-name">Name</Label>
                <Input id="bot-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Triage Bot" maxLength={40} autoFocus />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="bot-desc">Description</Label>
                <Textarea
                  id="bot-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Files crash reports from Sentry and labels new issues."
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
                {pending ? "Creating…" : "Create bot"}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
