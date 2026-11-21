"use client";

import { Fragment, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ImagePlusIcon, Maximize2Icon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useOrg } from "@/components/org-provider";
import { BotAvatar, Kbd, UserAvatar } from "@/components/bits";
import { Button } from "@/components/ui/button";
import { uploadImage } from "@/components/rich-editor";
import { imageToken, insertBlock, splitCommentBody } from "@/lib/comment-images";
import type { Member } from "@/lib/types";

/** Same types as the description editor's upload button (the server accepts these). */
const IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/avif";

const TOKEN = /<@([a-f0-9]{24})>/g;

/** Does a member match what's been typed after "@"? Multi-word queries match the full name's prefix. */
function matches(m: Member, q: string) {
  const name = m.name.toLowerCase();
  if (!q) return true;
  if (name.startsWith(q)) return true;
  return !/\s/.test(q) && name.split(/\s+/).some((w) => w.startsWith(q));
}

/** The @token being typed or edited: from the "@" to the caret, then on to the end of that word. */
interface Token {
  query: string;
  start: number;
  end: number;
}

/* ---------- Rendering: <@id> tokens become chips, this org's upload images become thumbnails ---------- */

/**
 * A comment: plain text, <@id> mention chips, and `![alt](url)` thumbnails for this org's uploads only (VEC-335;
 * any other URL, <img> tag or escaped `\![...]` stays text). `onExpandImage(n, opener)` opens the n-th image of
 * this comment in the thread gallery.
 */
export function CommentBody({ body, onExpandImage }: { body: string; onExpandImage?: (index: number, opener: HTMLElement) => void }) {
  const { memberById, me, org } = useOrg();
  const blocks = useMemo(() => splitCommentBody(body, org.id), [body, org.id]);
  return (
    <>
      {blocks.map((b, j) =>
        b.kind === "image" ? (
          <CommentImage key={j} src={b.src} alt={b.alt} onExpand={onExpandImage && ((el) => onExpandImage(b.index, el))} />
        ) : (
          <Fragment key={j}>
            {b.text.split(TOKEN).map((p, i) => {
              // [text, id, text, id, ...]
              if (i % 2 === 0) return <Fragment key={i}>{p}</Fragment>;
              const m = memberById.get(p);
              if (!m) return <span key={i} className="text-faint">@former member</span>;
              return <MentionChip key={i} member={m} isMe={m.id === me.id} />;
            })}
          </Fragment>
        ),
      )}
    </>
  );
}

/** A comment image: a lazy thumbnail with the same bottom-right expand button as description images (VEC-334). */
function CommentImage({ src, alt, onExpand }: { src: string; alt: string; onExpand?: (opener: HTMLElement) => void }) {
  return (
    <span className="aimpoint-image relative my-1.5 block w-fit max-w-full" data-comment-image="">
      {/* eslint-disable-next-line @next/next/no-img-element -- user uploads of any size, served by our own route */}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onClick={onExpand && ((e) => onExpand(e.currentTarget.nextElementSibling as HTMLElement))}
        className={cn("block max-h-60 max-w-full rounded-lg border border-border bg-background object-contain", onExpand && "cursor-zoom-in")}
      />
      {onExpand && (
        <button type="button" className="aimpoint-image-expand" aria-label={alt ? `Expand image: ${alt}` : "Expand image"} title="Expand image" onClick={(e) => onExpand(e.currentTarget)}>
          <Maximize2Icon aria-hidden />
        </button>
      )}
    </span>
  );
}

function MentionChip({ member, isMe }: { member: Member; isMe: boolean }) {
  if (member.kind === "bot") {
    // Reads like a person mention (accent text in the line), with the bot's face standing in for the "@".
    return (
      <span className="rounded-[4px] px-0.5 font-medium whitespace-nowrap text-selected-foreground" title={`${member.name} (bot)`}>
        <BotAvatar avatar={member.avatar} name={member.name} size={14} className="mr-1 -translate-y-px align-middle" />
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
  const { members, me, org } = useOrg();
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<Member[]>([]);
  const [token, setToken] = useState<Token | null>(null);
  const query = token?.query ?? null;
  const [active, setActive] = useState(0);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<React.CSSProperties | null>(null);

  const options = useMemo(() => {
    if (query === null) return [];
    const q = query.toLowerCase();
    const match = (m: Member) => matches(m, q);
    const people = members.filter((m) => m.kind === "user" && match(m)).sort((a, b) => (a.id === me.id ? 1 : b.id === me.id ? -1 : 0));
    const bots = members.filter((m) => m.kind === "bot" && match(m));
    return [...people.slice(0, 6), ...bots.slice(0, 5)];
  }, [query, members, me.id]);
  const open = query !== null && options.length > 0;

  // Float the list in a portal, above the composer when there's room, otherwise below it,
  // so it never covers what you're typing and isn't clipped by the scrolling pane.
  useLayoutEffect(() => {
    if (!open) return setPos(null);
    const place = () => {
      const box = boxRef.current?.getBoundingClientRect();
      if (!box) return;
      const h = listRef.current?.scrollHeight ?? 260;
      const width = Math.min(320, box.width);
      const left = Math.min(box.left, window.innerWidth - width - 8);
      const above = box.top - 14;
      const below = window.innerHeight - box.bottom - 14;
      // Prefer above; go below if only that fits; otherwise use the roomier side and scroll the list.
      const useAbove = h <= above || (h > below && above >= below);
      const maxHeight = Math.max(120, useAbove ? above : below);
      setPos(
        useAbove
          ? { left, width, maxHeight, bottom: window.innerHeight - box.top + 6 }
          : { left, width, maxHeight, top: box.bottom + 6 },
      );
    };
    place();
    const id = requestAnimationFrame(place); // re-measure once the list has rendered
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, options.length]);

  useLayoutEffect(() => {
    if (open) document.getElementById(`mention-${options[active]?.id}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, options]);

  const autosize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  };

  /**
   * Find the @token at the caret. Works for a fresh "@mi", and for editing or backspacing into an
   * existing mention ("@Mia Kowalsk", "@Mia Kxowalski"): the query is everything from "@" to the
   * caret, shortened word by word until someone matches. `editing` is true when the text just
   * changed; moving the caret onto an intact, already-picked mention doesn't reopen the list.
   */
  const detect = (el: HTMLTextAreaElement | null = ref.current, editing = false) => {
    if (!el) return;
    const value = el.value;
    const caret = el.selectionStart;
    if (caret !== el.selectionEnd) return setToken(null);
    const before = value.slice(0, caret);
    const at = before.lastIndexOf("@");
    const raw = at >= 0 ? before.slice(at + 1) : "";
    const valid =
      at >= 0 &&
      (at === 0 || /\s/.test(value[at - 1])) &&
      raw.length <= 60 &&
      !raw.includes("\n") &&
      !raw.includes("@") &&
      !/\s$/.test(raw); // a trailing space means the token is finished
    if (!valid) return setToken(null);

    const end = caret + (/^[^\s@]*/.exec(value.slice(caret))?.[0].length ?? 0);
    // An intact picked mention is finished: caret inside it, at its end or in the words typed after it.
    if (picked.some((m) => value.startsWith(`@${m.name}`, at))) return setToken(null);

    const q0 = raw.toLowerCase();
    let q: string | null = null;
    if (!q0.includes(" ") || members.some((m) => matches(m, q0))) {
      q = q0; // "@mi", "@mia kow": a name still being typed
    } else if (editing) {
      // Editing inside a broken mention ("@Mia Kx|owalski"): retry without the word under the caret,
      // but only that one word, so ordinary text typed after "@Mia" never reopens the list.
      const shorter = q0.split(/\s+/).slice(0, -1).join(" ");
      if (shorter && /^[^\s@]/.test(value.slice(caret)) && members.some((m) => matches(m, shorter))) q = shorter;
    }
    setToken(q === null ? null : { query: q, start: at, end });
    setActive(0);
  };

  const pick = (m: Member) => {
    const el = ref.current;
    if (!el) return;
    const value = el.value;
    const t = token ?? { start: value.lastIndexOf("@", el.selectionStart), end: el.selectionStart, query: "" };
    // Swallow leftover words of the old mention ("@Mxia| Kowalski" -> "@Mia Kowalski", not "... Kowalski Kowalski").
    let rest = value.slice(t.end);
    for (const w of m.name.split(/\s+/).slice(1)) {
      if (rest.startsWith(` ${w}`)) rest = rest.slice(w.length + 1);
    }
    const before = value.slice(0, t.start) + `@${m.name}` + (/^\s/.test(rest) ? "" : " ");
    const next = before + rest;
    setText(next);
    setPicked((p) => (p.some((x) => x.id === m.id) ? p : [...p, m]));
    setToken(null);
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

  /**
   * Uploads images (paste, drop or the attach button) with the description editor's upload and toasts, and puts
   * a `![name](url)` token on its own line at the caret once each one is stored (VEC-335).
   */
  const attach = (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) return false;
    for (const file of imgs) {
      const id = toast.loading(`Uploading ${file.name || "image"}…`);
      setUploading((n) => n + 1);
      uploadImage(org.slug, file)
        .then((url) => {
          const el = ref.current;
          const value = el?.value ?? "";
          // A blurred textarea keeps its selection, so this is where the caret was (end of the text by default).
          const from = el?.selectionStart ?? value.length;
          const to = el?.selectionEnd ?? value.length;
          const next = insertBlock(value, from, to, imageToken(file.name, url));
          setText(next.text);
          setTimeout(() => {
            el?.focus();
            el?.setSelectionRange(next.caret, next.caret);
            autosize();
          }, 0);
          toast.success("Image added", { id, duration: 1500 });
        })
        .catch((e: Error) => toast.error(e.message, { id }))
        .finally(() => setUploading((n) => n - 1));
    }
    return true;
  };

  const send = async () => {
    if (!text.trim() || sending || uploading) return;
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

  const backdrop = useRef<HTMLDivElement>(null);
  const segments = useMemo(() => highlightSegments(text, picked), [text, picked]);

  return (
    <div className="relative mt-4">
      {open &&
        createPortal(
          <div
            ref={listRef}
            id="mention-list"
            role="listbox"
            aria-label="Mention someone"
            style={{ position: "fixed", ...(pos ?? { left: -9999, top: 0, width: 320 }) }}
            className="z-50 overflow-y-auto overscroll-contain rounded-[10px] border border-border bg-popover p-1 text-popover-foreground shadow-[0_8px_24px_-8px_rgba(0,0,0,0.18),0_1px_2px_rgba(0,0,0,0.06)]"
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
          </div>,
          document.body,
        )}
      <div
        ref={boxRef}
        data-keyboard-reveal
        className={cn(
          "scroll-mb-3 rounded-[10px] border border-input bg-background transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20",
          dragOver && "border-ring ring-2 ring-ring/20",
        )}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDragOver(true);
        }}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDragOver(false)}
        onDrop={(e) => {
          setDragOver(false);
          if (attach(Array.from(e.dataTransfer.files))) e.preventDefault();
        }}
      >
        {/* The textarea's own text is transparent; this mirror draws the same text underneath with the
            picked @mentions highlighted. Both share font, padding, line height and wrapping exactly. */}
        <div className="relative">
          <div
            ref={backdrop}
            aria-hidden
            className={cn(MIRROR, "pointer-events-none absolute inset-0 overflow-hidden text-foreground")}
          >
            {segments.map((seg, i) =>
              seg.member ? (
                <span
                  key={i}
                  className={cn(
                    "rounded-[4px]",
                    seg.member.kind === "bot"
                      ? "bg-chip shadow-[inset_0_0_0_1px_var(--input)]"
                      : "bg-selected text-selected-foreground",
                  )}
                >
                  {seg.text}
                </span>
              ) : (
                <Fragment key={i}>{seg.text}</Fragment>
              ),
            )}
            {/* keeps a trailing newline's height */}
            {"\u200b"}
          </div>
        <textarea
          ref={ref}
          value={text}
          rows={1}
          placeholder="Leave a comment… Type @ to mention someone"
          aria-label="Comment"
          role="combobox"
          aria-autocomplete="list"
          aria-controls={open ? "mention-list" : undefined}
          aria-expanded={open}
          aria-activedescendant={open ? `mention-${options[active]?.id}` : undefined}
          onChange={(e) => {
            setText(e.target.value);
            autosize();
            detect(e.target, true);
          }}
          onClick={() => detect()}
          onPaste={(e) => {
            if (attach(Array.from(e.clipboardData.files))) e.preventDefault();
          }}
          onBlur={() => setTimeout(() => setToken(null), 120)}
          onKeyDown={(e) => {
            if (open) {
              if (e.key === "ArrowDown") return (e.preventDefault(), setActive((a) => (a + 1) % options.length));
              if (e.key === "ArrowUp") return (e.preventDefault(), setActive((a) => (a - 1 + options.length) % options.length));
              if (e.key === "Enter" || e.key === "Tab" || (e.key === " " && query)) return (e.preventDefault(), pick(options[active]));
              if (e.key === "Escape") return (e.preventDefault(), e.stopPropagation(), setToken(null));
            }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          onKeyUp={(e) => ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key) && detect()}
          onScroll={(e) => backdrop.current && (backdrop.current.scrollTop = e.currentTarget.scrollTop)}
          className={cn(
            MIRROR,
            "relative block min-h-[40px] w-full resize-none bg-transparent text-transparent caret-foreground outline-none placeholder:text-faint",
            // at the 16px touch size (VEC-154) the placeholder would wrap into a clipped second line
            "pointer-coarse:placeholder:overflow-hidden pointer-coarse:placeholder:text-ellipsis pointer-coarse:placeholder:whitespace-nowrap",
            // a translucent selection so the mirrored text stays readable while selected
            "selection:bg-[color-mix(in_srgb,var(--brand)_28%,transparent)] selection:text-transparent",
          )}
        />
          <button
            type="button"
            aria-label="Attach image"
            title="Attach image"
            onClick={() => fileInput.current?.click()}
            className="absolute top-1.5 right-1.5 grid size-7 place-items-center rounded-md text-faint transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
          >
            <ImagePlusIcon className="size-4" aria-hidden />
          </button>
          <input
            ref={fileInput}
            type="file"
            accept={IMAGE_ACCEPT}
            multiple
            hidden
            onChange={(e) => {
              attach(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
        </div>
        <div className={cn("flex items-center justify-end gap-2 px-2 pb-2", !text.trim() && !uploading && "hidden")}>
          <Kbd>⌘↵</Kbd>
          <Button size="sm" onClick={send} disabled={sending || uploading > 0}>
            {sending ? "Sending…" : uploading ? "Uploading…" : "Comment"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Typography shared by the textarea and its highlight mirror; any drift misaligns the highlight. */
const MIRROR = "pl-3 pr-10 pt-2.5 pb-2.5 font-sans text-[13.5px] pointer-coarse:text-[16px] leading-[20px] tracking-normal whitespace-pre-wrap break-words [overflow-wrap:anywhere]";

function highlightSegments(text: string, picked: Member[]) {
  const names = [...picked].sort((a, b) => b.name.length - a.name.length);
  const out: { text: string; member?: Member }[] = [];
  let i = 0;
  let plain = "";
  while (i < text.length) {
    const m = text[i] === "@" ? names.find((n) => text.startsWith(`@${n.name}`, i)) : undefined;
    if (m) {
      if (plain) out.push({ text: plain });
      plain = "";
      out.push({ text: `@${m.name}`, member: m });
      i += m.name.length + 1;
    } else {
      plain += text[i++];
    }
  }
  if (plain) out.push({ text: plain });
  return out;
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
      {bot ? <BotAvatar avatar={m.avatar} name={m.name} size={24} /> : <UserAvatar id={m.id} name={m.name} image={m.image} size={24} />}
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
