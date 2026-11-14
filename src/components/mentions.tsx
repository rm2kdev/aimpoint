"use client";

import { Fragment, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useOrg } from "@/components/org-provider";
import { BotAvatar, Kbd, UserAvatar } from "@/components/bits";
import { Button } from "@/components/ui/button";
import type { Member } from "@/lib/types";

const TOKEN = /<@([a-f0-9]{24})>/g;
const QUERY = /(?:^|\s)@([\p{L}\p{N}._'-]*)$/u;

/* ---------- Rendering: <@id> tokens become chips ---------- */

export function CommentBody({ body }: { body: string }) {
  const { memberById, me } = useOrg();
  const parts = body.split(TOKEN); // [text, id, text, id, ...]
  return (
    <>
      {parts.map((p, i) => {
        if (i % 2 === 0) return <Fragment key={i}>{p}</Fragment>;
        const m = memberById.get(p);
        if (!m) return <span key={i} className="text-faint">@former member</span>;
        return <MentionChip key={i} member={m} isMe={m.id === me.id} />;
      })}
    </>
  );
}

function MentionChip({ member, isMe }: { member: Member; isMe: boolean }) {
  if (member.kind === "bot") {
    return (
      <span
        className="mx-px inline-flex translate-y-[2px] items-center gap-1 rounded-[6px] border border-border bg-background py-px pr-1.5 pl-0.5 align-baseline text-[12.5px] leading-[18px] font-medium"
        title={`${member.name} (bot)`}
      >
        <BotAvatar avatar={member.avatar} name={member.name} size={15} />
        {member.name}
      </span>
    );
  }
  return (
    <span
      className={cn(
        "rounded-[4px] px-0.5 font-medium text-selected-foreground",
        isMe && "bg-selected px-1",
      )}
      title={member.email}
    >
      @{member.name}
    </span>
  );
}

/* ---------- Composer with @ autocomplete ---------- */

export function MentionComposer({ onSend }: { onSend: (body: string) => Promise<boolean> }) {
  const { members, me } = useOrg();
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<Member[]>([]);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  const options = useMemo(() => {
    if (query === null) return [];
    const q = query.toLowerCase();
    const match = (m: Member) => !q || m.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || m.name.toLowerCase().startsWith(q);
    const people = members.filter((m) => m.kind === "user" && match(m)).sort((a, b) => (a.id === me.id ? 1 : b.id === me.id ? -1 : 0));
    const bots = members.filter((m) => m.kind === "bot" && match(m));
    return [...people.slice(0, 6), ...bots.slice(0, 5)];
  }, [query, members, me.id]);
  const open = query !== null && options.length > 0;

  const autosize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  };

  const detect = (el: HTMLTextAreaElement | null = ref.current) => {
    if (!el) return;
    const m = QUERY.exec(el.value.slice(0, el.selectionStart));
    setQuery(m ? m[1] : null);
    setActive(0);
  };

  const pick = (m: Member) => {
    const el = ref.current;
    if (!el) return;
    const caret = el.selectionStart;
    const before = el.value.slice(0, caret).replace(/@([\p{L}\p{N}._'-]*)$/u, `@${m.name} `);
    const next = before + el.value.slice(caret);
    setText(next);
    setPicked((p) => (p.some((x) => x.id === m.id) ? p : [...p, m]));
    setQuery(null);
    setTimeout(() => {
      el.focus();
      el.setSelectionRange(before.length, before.length);
      autosize();
    }, 0);
  };

  /** Turn the picked "@Name" strings back into stable <@id> tokens. */
  const encode = (s: string) =>
    [...picked]
      .sort((a, b) => b.name.length - a.name.length)
      .reduce((acc, m) => acc.split(`@${m.name}`).join(`<@${m.id}>`), s);

  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    if (await onSend(encode(text))) {
      setText("");
      setPicked([]);
      setTimeout(autosize, 0);
    }
    setSending(false);
  };

  const people = options.filter((o) => o.kind === "user");
  const bots = options.filter((o) => o.kind === "bot");

  return (
    <div className="relative mt-4">
      {open && (
        <div
          id="mention-list"
          role="listbox"
          aria-label="Mention someone"
          className="absolute bottom-full left-0 z-30 mb-1.5 w-[300px] overflow-hidden rounded-[10px] border border-border bg-popover p-1 text-popover-foreground shadow-[0_8px_24px_-8px_rgba(0,0,0,0.18),0_1px_2px_rgba(0,0,0,0.06)]"
          onMouseDown={(e) => e.preventDefault()}
        >
          {people.length > 0 && <GroupLabel>People</GroupLabel>}
          {people.map((m) => (
            <Option key={m.id} m={m} idx={options.indexOf(m)} active={active} setActive={setActive} onPick={pick} isMe={m.id === me.id} />
          ))}
          {bots.length > 0 && <GroupLabel className={people.length ? "mt-1 border-t border-border pt-1.5" : ""}>Bots</GroupLabel>}
          {bots.map((m) => (
            <Option key={m.id} m={m} idx={options.indexOf(m)} active={active} setActive={setActive} onPick={pick} isMe={false} />
          ))}
        </div>
      )}
      <div className="rounded-[10px] border border-input bg-background transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
        <textarea
          ref={ref}
          value={text}
          rows={1}
          placeholder="Leave a comment… Type @ to mention someone"
          aria-label="Comment"
          aria-autocomplete="list"
          aria-controls={open ? "mention-list" : undefined}
          aria-expanded={open}
          aria-activedescendant={open ? `mention-${options[active]?.id}` : undefined}
          onChange={(e) => {
            setText(e.target.value);
            autosize();
            detect(e.target);
          }}
          onClick={() => detect()}
          onBlur={() => setTimeout(() => setQuery(null), 120)}
          onKeyDown={(e) => {
            if (open) {
              if (e.key === "ArrowDown") return (e.preventDefault(), setActive((a) => (a + 1) % options.length));
              if (e.key === "ArrowUp") return (e.preventDefault(), setActive((a) => (a - 1 + options.length) % options.length));
              if (e.key === "Enter" || e.key === "Tab") return (e.preventDefault(), pick(options[active]));
              if (e.key === "Escape") return (e.preventDefault(), e.stopPropagation(), setQuery(null));
            }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          onKeyUp={(e) => ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key) && detect()}
          className="block min-h-[40px] w-full resize-none bg-transparent px-3 pt-2.5 text-[13.5px] outline-none placeholder:text-faint"
        />
        <div className={cn("flex items-center justify-end gap-2 px-2 pb-2", !text.trim() && "hidden")}>
          <Kbd>⌘↵</Kbd>
          <Button size="sm" onClick={send} disabled={sending}>
            {sending ? "Sending…" : "Comment"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function GroupLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("px-2 pt-1 pb-1 text-[11.5px] font-medium text-faint", className)}>{children}</div>;
}

function Option({
  m,
  idx,
  active,
  setActive,
  onPick,
  isMe,
}: {
  m: Member;
  idx: number;
  active: number;
  setActive: (i: number) => void;
  onPick: (m: Member) => void;
  isMe: boolean;
}) {
  const bot = m.kind === "bot";
  return (
    <div
      id={`mention-${m.id}`}
      role="option"
      aria-selected={idx === active}
      onMouseEnter={() => setActive(idx)}
      onClick={() => onPick(m)}
      className={cn("flex cursor-default items-center gap-2.5 rounded-[7px] px-2 py-1.5", idx === active && "bg-accent")}
    >
      {bot ? <BotAvatar avatar={m.avatar} name={m.name} size={24} /> : <UserAvatar id={m.id} name={m.name} size={24} />}
      <div className="min-w-0 flex-1 leading-tight">
        <div className="flex items-center gap-1.5 text-[13px]">
          <span className="truncate font-medium">{m.name}</span>
          {isMe && <span className="text-[11.5px] text-faint">you</span>}
          {bot && (
            <span className="rounded-[4px] bg-chip px-1.5 text-[11.5px] font-medium text-muted-foreground">Bot</span>
          )}
        </div>
        <div className="truncate text-[11.5px] text-faint">{bot ? m.description || "Automation" : m.email}</div>
      </div>
    </div>
  );
}
