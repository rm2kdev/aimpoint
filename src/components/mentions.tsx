"use client";

import { Fragment, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ImagePlusIcon, Maximize2Icon, RotateCwIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useOrg } from "@/components/org-provider";
import { BotAvatar, Kbd, UserAvatar } from "@/components/bits";
import { botPickerEntries, disabledBotNote, DISABLED_BOT_HINT, isBotDisabled, stepPickable } from "@/lib/bot-picker";
import { Button } from "@/components/ui/button";
import { imageToken, insertBlock, splitCommentBody } from "@/lib/comment-images";
import { addCommentImage, commentUploads, useCommentUploads } from "@/lib/pending-comments";
import { LinkedText } from "@/components/linked-text";
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
 * A comment: plain text with http(s) links (AIM-7), <@id> mention chips, and `![alt](url)` thumbnails for this org's uploads only (VEC-335;
 * any other URL, <img> tag or escaped `\![...]` stays text). `onExpandImage(n, opener)` opens the n-th image of
 * this comment in the thread gallery.
 */
export function CommentBody({ body, onExpandImage, localImage }: { body: string; onExpandImage?: (index: number, opener: HTMLElement) => void; localImage?: (url: string) => boolean }) {
  const { memberById, me, org } = useOrg();
  // `localImage`: an unsent comment's own image previews (VEC-454) render as images too.
  const blocks = useMemo(() => splitCommentBody(body, org.id, localImage), [body, org.id, localImage]);
  return (
    <>
      {blocks.map((b, j) =>
        b.kind === "image" ? (
          <CommentImage key={j} src={b.src} alt={b.alt} onExpand={onExpandImage && ((el) => onExpandImage(b.index, el))} />
        ) : (
          <Fragment key={j}>
            {b.text.split(TOKEN).map((p, i) => {
              // [text, id, text, id, ...]
              if (i % 2 === 0) return <LinkedText key={i} text={p} />;
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

/** Puts a comment's text back in the composer (a refused comment, VEC-454): `<@id>` tokens become picked @Names again. */
export interface ComposerHandle {
  restore(body: string): void;
}

/**
 * The comment box. Sending is instant (VEC-454): `onSend(body)` gets the encoded text (mention tokens, image tokens
 * that may still point at local previews) and the composer clears at once; the caller shows the comment and sends it
 * in the background. Images show as soon as they're attached and upload behind the scenes.
 */
export function MentionComposer({ onSend, handle }: { onSend: (body: string) => void; handle?: React.Ref<ComposerHandle> }) {
  const { members, memberById, me, org } = useOrg();
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<Member[]>([]);
  const [token, setToken] = useState<Token | null>(null);
  const query = token?.query ?? null;
  const [active, setActive] = useState(0);
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
    // VEC-353: disabled bots are listed last, grayed and can't be picked (botPickerEntries keeps the order otherwise).
    const bots = botPickerEntries(members.filter((m) => m.kind === "bot" && match(m))).map((e) => e.bot);
    return [...people.slice(0, 6), ...bots.slice(0, 5)];
  }, [query, members, me.id]);
  const open = query !== null && options.length > 0;
  const unpickable = useMemo(() => options.map((m) => isBotDisabled(m)), [options]);
  // The highlighted option, moved off a disabled bot onto the first pickable one (-1 when only disabled bots match).
  const current = unpickable[active] === false ? active : stepPickable(unpickable, -1, 1);

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
    if (open) document.getElementById(`mention-${options[current]?.id}`)?.scrollIntoView({ block: "nearest" });
  }, [open, current, options]);

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

  const pick = (m: Member | undefined) => {
    const el = ref.current;
    if (!el || !m || isBotDisabled(m)) return;
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
   * Images (paste, drop or the attach button) go in at once as a `![name](preview)` token on its own line at the caret
   * (VEC-335) and upload in the background (VEC-454); the preview is swapped for the stored URL when the comment is
   * sent, so Comment never waits for an upload.
   */
  const attach = (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) return false;
    const el = ref.current;
    let value = el?.value ?? text;
    // A blurred textarea keeps its selection, so this is where the caret was (end of the text by default).
    let from = el?.selectionStart ?? value.length;
    let to = el?.selectionEnd ?? value.length;
    for (const file of imgs) {
      const next = insertBlock(value, from, to, imageToken(file.name, addCommentImage(org.slug, file)));
      value = next.text;
      from = to = next.caret;
    }
    setText(value);
    setTimeout(() => {
      el?.focus();
      el?.setSelectionRange(from, from);
      autosize();
    }, 0);
    return true;
  };

  const send = () => {
    if (!text.trim()) return;
    onSend(encode(text));
    setText("");
    setPicked([]);
    setToken(null);
    setTimeout(autosize, 0);
  };

  useImperativeHandle(handle, () => ({
    restore(body: string) {
      const back: Member[] = [];
      const plain = body.replace(TOKEN, (all, id: string) => {
        const m = memberById.get(id);
        if (!m) return all;
        if (!back.includes(m)) back.push(m);
        return `@${m.name}`;
      });
      // Don't overwrite something typed since: put the refused text first.
      setText((t) => (t.trim() ? `${plain}\n${t}` : plain));
      setPicked((p) => [...p, ...back.filter((m) => !p.includes(m))]);
      setTimeout(autosize, 0);
    },
  }));

  // This draft's images (by preview URL in the text) with their upload state, shown under the text.
  const uploads = useCommentUploads();
  const drafts = useMemo(() => uploads.filter((u) => text.includes(u.preview)), [uploads, text]);
  const removeImage = (preview: string) => {
    // Drops the image's `![name](preview)` token (and the line break after it) from the text.
    setText((t) => t.split("\n").filter((line) => !(line.startsWith("![") && line.endsWith(`](${preview})`))).join("\n"));
    commentUploads.forget(preview);
    setTimeout(autosize, 0);
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
              <Option key={m.id} m={m} idx={options.indexOf(m)} active={current} setActive={setActive} onPick={pick} isMe={m.id === me.id} />
            ))}
            {bots.length > 0 && <GroupLabel className={people.length ? "mt-1 border-t border-border pt-1.5" : ""}>Bots</GroupLabel>}
            {bots.map((m) => (
              <Option key={m.id} m={m} idx={options.indexOf(m)} active={current} setActive={setActive} onPick={pick} isMe={false} />
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
          aria-activedescendant={open && current >= 0 ? `mention-${options[current]?.id}` : undefined}
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
              if (e.key === "ArrowDown") return (e.preventDefault(), current >= 0 && setActive(stepPickable(unpickable, current, 1)));
              if (e.key === "ArrowUp") return (e.preventDefault(), current >= 0 && setActive(stepPickable(unpickable, current, -1)));
              // Only disabled bots match: nothing to pick, so the key types as usual.
              if (current >= 0 && (e.key === "Enter" || e.key === "Tab" || (e.key === " " && query))) return (e.preventDefault(), pick(options[current]));
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
        {drafts.length > 0 && (
          <ul className="flex flex-wrap gap-2 px-3 pb-1" aria-label="Attached images">
            {drafts.map((u) => (
              <li key={u.preview} className="relative" data-composer-image={u.state}>
                {/* eslint-disable-next-line @next/next/no-img-element -- a local preview of the attached file */}
                <img
                  src={u.preview}
                  alt={u.name}
                  title={u.state === "uploading" ? `${u.name}: uploading…` : u.state === "failed" ? `${u.name}: ${u.error ?? "didn't upload"}` : u.name}
                  className={cn("size-14 rounded-md border border-border object-cover", u.state === "uploading" && "opacity-60", u.state === "failed" && "border-destructive opacity-60")}
                />
                {u.state === "uploading" && <span className="absolute inset-x-1 bottom-1 h-0.5 animate-pulse rounded-full bg-brand" aria-label="Uploading" />}
                {u.state === "failed" && (
                  <button
                    type="button"
                    aria-label={`Retry uploading ${u.name}`}
                    title="Retry upload"
                    onClick={() => void commentUploads.retry(u.preview)}
                    className="absolute inset-0 m-auto grid size-7 place-items-center rounded-full bg-background/90 text-destructive shadow-sm"
                  >
                    <RotateCwIcon className="size-3.5" aria-hidden />
                  </button>
                )}
                <button
                  type="button"
                  aria-label={`Remove ${u.name}`}
                  title="Remove image"
                  onClick={() => removeImage(u.preview)}
                  className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full border border-border bg-background text-muted-foreground shadow-sm hover:text-foreground"
                >
                  <XIcon className="size-3" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className={cn("flex items-center justify-end gap-2 px-2 pb-2", !text.trim() && "hidden")}>
          <Kbd>⌘↵</Kbd>
          <Button size="sm" onClick={send}>
            Comment
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
  const off = bot && isBotDisabled(m);
  return (
    <div
      id={`mention-${m.id}`}
      role="option"
      aria-selected={idx === active}
      aria-disabled={off || undefined}
      title={off ? disabledBotNote(m.name) : undefined}
      onMouseEnter={() => !off && setActive(idx)}
      onClick={() => !off && onPick(m)}
      className={cn("flex cursor-default items-center gap-2.5 rounded-[7px] px-2 py-1.5", idx === active && "bg-accent", off && "text-muted-foreground")}
    >
      {bot ? <BotAvatar avatar={m.avatar} name={m.name} size={24} disabled={off} /> : <UserAvatar id={m.id} name={m.name} image={m.image} size={24} />}
      <div className="min-w-0 flex-1 leading-tight">
        <div className="flex items-center gap-1.5 text-[13px]">
          <span className="truncate font-medium">{m.name}</span>
          {isMe && <span className="text-[11.5px] text-faint">you</span>}
          {bot && (
            <span className="rounded-[4px] bg-chip px-1.5 text-[11.5px] font-medium text-muted-foreground">Bot</span>
          )}
          {off && <span className="ml-auto shrink-0 text-[11.5px] text-muted-foreground">{DISABLED_BOT_HINT}</span>}
        </div>
        <div className="truncate text-[11.5px] text-faint">{bot ? m.description || "Automation" : m.email}</div>
      </div>
    </div>
  );
}
