"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PlusIcon } from "lucide-react";
import { useOrg } from "@/components/org-provider";
import { EntityList, EntityRow, SettingsRow, Tag } from "@/components/settings/ui";
import { BotAvatar } from "@/components/bits";
import { AvatarPicker, randomAvatar } from "@/components/bots/avatar-picker";
import { AgentMark } from "@/components/bots/connect-wizard";
import { backendLabel } from "@/lib/bot-connect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { createBot } from "@/app/actions/bots";
import { timeAgo } from "@/lib/format";
import type { Bot, BotAvatar as BotAvatarData } from "@/lib/types";
import { orgPath } from "@/lib/paths";
import { UpgradeNote } from "@/components/upgrade-note";
import { atLimit, limitReason } from "@/lib/billing-view";

export function BotsSettings({
  bots,
  stats,
  roleNames,
}: {
  bots: Bot[];
  stats: Record<string, { assigned: number; created: number }>;
  roleNames: Record<string, string>;
}) {
  const { org, isAdmin, billing } = useOrg();
  const botsFull = atLimit(billing, "bots");
  const [creating, setCreating] = useState(false);

  return (
    <>
      <SettingsRow
        title="Bots"
        desc={
          <>
            Automations and AI agents that work in {org.name} over MCP or the API. They pick up tasks assigned to them, answer @mentions,
            comment, move and assign work and create tasks. Open one to edit it, manage its key or give it a role.
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
                href={orgPath(org.slug, "settings", "bots", b.id)}
                avatar={<BotAvatar avatar={b.avatar} name={b.name} size={32} />}
                name={b.name}
                tags={
                  <>
                    <Tag>Bot</Tag>
                    {b.roleId && <Tag tone="faint">{roleNames[b.roleId] ?? "Missing role"}</Tag>}
                    {b.connection?.lastDelivery && !b.connection.lastDelivery.ok && (
                      <span className="shrink-0 rounded-[4px] bg-destructive/10 px-1.5 py-px text-[11.5px] font-medium text-destructive">Last run failed</span>
                    )}
                  </>
                }
                subtitle={b.description || "No description"}
                meta={
                  <>
                    <div>
                      {stats[b.id]?.assigned ?? 0} assigned · {stats[b.id]?.created ?? 0} created
                    </div>
                    <div className="mt-0.5 flex items-center justify-end gap-1.5">
                      {b.connection ? (
                        <>
                          <AgentMark agent={b.connection.agent} size={16} />
                          {backendLabel(b.connection)}
                        </>
                      ) : b.lastUsedAt ? (
                        "No backend · uses MCP"
                      ) : (
                        "No backend"
                      )}
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
        <SettingsRow title="Add a bot" desc="Each bot gets its own name, avatar and API key. Next you'll choose its backend: Claude, OpenAI or Hermes.">
          <Button onClick={() => setCreating(true)} className="gap-2" disabled={botsFull}>
            <PlusIcon className="size-3.5" /> New bot
          </Button>
          {botsFull && <UpgradeNote reason={limitReason(billing, "bots")} className="mt-2" />}
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
  const [pending, start] = useTransition();

  const reset = () => {
    setName("");
    setDescription("");
    setAvatar(randomAvatar());
    setError(undefined);
  };
  const close = () => {
    onClose();
    setTimeout(reset, 200);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="gap-0 p-0 sm:max-w-[520px]">
        <form
            onSubmit={(e) => {
              e.preventDefault();
              start(async () => {
                const r = await createBot(org.slug, { name, description, avatar });
                if (!r.ok) return setError(r.error);
                // Hand the one-time key to the bot page, where the connect wizard puts it into the setup steps.
                sessionStorage.setItem(`vector:new-bot-key:${r.data!.bot.id}`, r.data!.key);
                onClose();
                setTimeout(reset, 200);
                router.push(orgPath(org.slug, "settings", "bots", r.data!.bot.id));
              });
            }}
          >
            <div className="px-5 pt-5">
              <DialogTitle className="text-[15px] font-semibold">New bot</DialogTitle>
              <DialogDescription className="mt-1 text-[13px] text-muted-foreground">Give it a face, a name and a job description. Then you&rsquo;ll choose the backend that runs it.</DialogDescription>
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
      </DialogContent>
    </Dialog>
  );
}
