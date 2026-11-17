"use client";

import { useEffect, useRef } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { NodeSelection, Selection, TextSelection, type Transaction } from "@tiptap/pm/state";
import { GapCursor } from "@tiptap/pm/gapcursor";
import type { Node as PMNode, ResolvedPos } from "@tiptap/pm/model";
import {
  BoldIcon,
  CodeIcon,
  Heading2Icon,
  ImageIcon,
  ItalicIcon,
  ListIcon,
  ListOrderedIcon,
  QuoteIcon,
  StrikethroughIcon,
  LinkIcon,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export async function uploadImage(orgSlug: string, file: File): Promise<string> {
  const body = new FormData();
  body.set("file", file);
  body.set("org", orgSlug);
  const res = await fetch("/api/uploads", { method: "POST", body });
  const json = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!res.ok || !json.url) throw new Error(json.error ?? "Upload failed. Try again.");
  return json.url;
}

/** Uploads one image and resolves to the URL to put in `src`; rejects with a message people can read. */
export type ImageUploader = (file: File) => Promise<string>;

/**
 * Inserts an image at `pos` (drops), or else at the selection, and leaves the cursor after it.
 * An image that's still selected (NodeSelection, right after an upload) is kept: the new one goes
 * after it instead of replacing it (VEC-244).
 */
// GapCursor.valid exists at runtime but isn't in prosemirror-gapcursor's typings.
const gapCursorFits = ($pos: ResolvedPos) => (GapCursor as unknown as { valid($pos: ResolvedPos): boolean }).valid($pos);

function insertImageNode(tr: Transaction, node: PMNode, pos?: number) {
  const sel = tr.selection;
  let [from, to] = pos !== undefined ? [pos, pos] : sel instanceof NodeSelection ? [sel.to, sel.to] : [sel.from, sel.to];
  // Like Tiptap's insertContent: an image put into an empty paragraph replaces the paragraph.
  const $from = tr.doc.resolve(from);
  if (from === to && $from.parent.isTextblock && !$from.parent.type.spec.code && !$from.parent.childCount && $from.depth > 0) {
    from = $from.before();
    to = $from.after();
  }
  tr.replaceRangeWith(from, to, node);
  // End of what was inserted, in the new doc (replaceRangeWith may move the point out of a paragraph or split it).
  let end = tr.mapping.map(to, 1);
  tr.steps[tr.steps.length - 1]?.getMap().forEach((_os, _oe, _ns, newEnd) => (end = newEnd));
  const $end = tr.doc.resolve(end);
  const paragraph = node.type.schema.nodes.paragraph;
  if ($end.parent.inlineContent) tr.setSelection(TextSelection.create(tr.doc, end));
  else if ($end.nodeAfter?.isTextblock) tr.setSelection(TextSelection.create(tr.doc, end + 1));
  else if (paragraph && $end.parent.canReplaceWith($end.index(), $end.index(), paragraph)) {
    // Nothing to type into after the image (it's last): add an empty paragraph, as the trailing node would.
    // A gap cursor here gets replaced by that trailing paragraph and the next keystroke lands at the top.
    tr.insert(end, paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, end + 1));
  } else if (gapCursorFits($end)) tr.setSelection(new GapCursor($end));
  else tr.setSelection(Selection.near($end));
  tr.scrollIntoView();
  return true;
}

function insertImages(editor: Editor, upload: ImageUploader, files: File[], pos?: number, onError?: (message: string) => void) {
  const images = files.filter((f) => f.type.startsWith("image/"));
  if (!images.length) return false;
  for (const file of images) {
    const id = toast.loading(`Uploading ${file.name || "image"}…`);
    upload(file)
      .then((src) => {
        editor
          .chain()
          .focus()
          .command(({ tr, state }) => insertImageNode(tr, state.schema.nodes.image.create({ src, alt: file.name }), pos))
          .run();
        // Chrome can keep a stale native caret when the cursor lands in a paragraph whose DOM node
        // ProseMirror reused: the state says "after the image" but typing lands where the cursor was.
        // Re-place the caret once Tiptap's own (deferred) focus has run.
        requestAnimationFrame(() => {
          if (editor.isDestroyed || !editor.view.hasFocus()) return;
          editor.view.dom.ownerDocument.getSelection()?.removeAllRanges();
          editor.view.focus();
        });
        toast.success("Image added", { id, duration: 1500 });
      })
      .catch((e: Error) => {
        toast.error(e.message, { id });
        onError?.(e.message);
      });
  }
  return true;
}

/** Drops <img> from pasted HTML, for editors that don't take images. */
const stripImages = (html: string) => html.replace(/<img\b[^>]*>/gi, "");

export function RichEditor({
  orgSlug,
  value,
  onChange,
  placeholder = "Add a description…",
  className,
  autofocus,
  syncKey,
  editable = true,
  upload,
  images = true,
  onUploadError,
  onTextChange,
  ariaLabel = "Description",
}: {
  /** Org whose session upload (`POST /api/uploads`) is used when no `upload` is given. */
  orgSlug: string;
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  className?: string;
  autofocus?: boolean;
  /** Changes when a remote update should replace the content (ignored while focused). */
  syncKey?: string | number;
  editable?: boolean;
  /** Replaces the default `uploadImage(orgSlug, file)`, e.g. the public form upload endpoint (VEC-235). */
  upload?: ImageUploader;
  /** False: no image button, and pasted or dropped images (files and <img> in pasted HTML) are ignored. */
  images?: boolean;
  /** Called with the message of a failed upload, after the error toast. */
  onUploadError?: (message: string) => void;
  /** Plain text of the content on every change (for counters that count text, not HTML). */
  onTextChange?: (text: string) => void;
  ariaLabel?: string;
}) {
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });
  // Read at upload time, so the editor (created once) always uses the current props.
  const uploadRef = useRef<{ upload: ImageUploader; images: boolean; onError?: (m: string) => void; onText?: (t: string) => void }>(null!);
  useEffect(() => {
    uploadRef.current = { upload: upload ?? ((file) => uploadImage(orgSlug, file)), images, onError: onUploadError, onText: onTextChange };
  });
  const doUpload: ImageUploader = (file) => uploadRef.current.upload(file);

  const editor = useEditor({
    immediatelyRender: false,
    editable,
    autofocus: autofocus ? "end" : false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" } },
      }),
      // Without the Image node the schema itself drops images from pasted HTML and setContent.
      ...(images ? [Image.configure({ inline: false, allowBase64: false })] : []),
      Placeholder.configure({ placeholder }),
    ],
    content: value,
    editorProps: {
      attributes: { class: "prose-aimpoint", "aria-label": ariaLabel, role: "textbox", "aria-multiline": "true" },
      transformPastedHTML: (html) => (uploadRef.current?.images === false ? stripImages(html) : html),
      // Handle paste and drop ourselves and return true so the browser/ProseMirror
      // default never inserts a second copy.
      handlePaste(view, event) {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (!files.some((f) => f.type.startsWith("image/"))) return false;
        event.preventDefault();
        // Images off: swallow the file so nothing (not even a file name) is inserted.
        if (!uploadRef.current.images) return true;
        return insertImages(editorRef.current!, doUpload, files, undefined, uploadRef.current.onError);
      },
      handleDrop(view, event, _slice, moved) {
        if (moved) return false;
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (!files.some((f) => f.type.startsWith("image/"))) return false;
        event.preventDefault();
        if (!uploadRef.current.images) return true;
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        return insertImages(editorRef.current!, doUpload, files, pos, uploadRef.current.onError);
      },
    },
    onUpdate: ({ editor }) => {
      onChangeRef.current(editor.isEmpty ? "" : editor.getHTML());
      uploadRef.current.onText?.(editor.getText({ blockSeparator: "\n" }));
    },
  });
  const editorRef = useRef<Editor | null>(null);
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  // Apply remote changes when the user isn't editing.
  useEffect(() => {
    if (!editor || editor.isFocused) return;
    if (editor.getHTML() !== value && !(editor.isEmpty && !value)) editor.commands.setContent(value, { emitUpdate: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncKey, editor]);

  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable);
  }, [editor, editable]);

  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <div className={cn("group/editor", className)}>
      {editor && editable && (
        <div
          role="toolbar"
          aria-label="Formatting"
          className="sticky top-0 z-10 mb-3 flex w-max max-w-full flex-wrap items-center gap-0.5 rounded-lg border border-border bg-background p-0.5 opacity-80 transition-opacity group-focus-within/editor:opacity-100 group-hover/editor:opacity-100"
        >
          <Tool label="Bold" shortcut="⌘B" active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}>
            <BoldIcon />
          </Tool>
          <Tool label="Italic" shortcut="⌘I" active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}>
            <ItalicIcon />
          </Tool>
          <Tool label="Strikethrough" active={editor.isActive("strike")} onClick={() => editor.chain().focus().toggleStrike().run()}>
            <StrikethroughIcon />
          </Tool>
          <Tool label="Inline code" active={editor.isActive("code")} onClick={() => editor.chain().focus().toggleCode().run()}>
            <CodeIcon />
          </Tool>
          <Sep />
          <Tool label="Heading" active={editor.isActive("heading", { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
            <Heading2Icon />
          </Tool>
          <Tool label="Bulleted list" active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}>
            <ListIcon />
          </Tool>
          <Tool label="Numbered list" active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
            <ListOrderedIcon />
          </Tool>
          <Tool label="Quote" active={editor.isActive("blockquote")} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
            <QuoteIcon />
          </Tool>
          <Tool
            label="Link"
            active={editor.isActive("link")}
            onClick={() => {
              if (editor.isActive("link")) return void editor.chain().focus().unsetLink().run();
              const url = window.prompt("Link URL");
              if (url && /^(https?:\/\/|mailto:)/i.test(url.trim())) editor.chain().focus().extendMarkRange("link").setLink({ href: url.trim() }).run();
            }}
          >
            <LinkIcon />
          </Tool>
          {images && (
            <>
              <Sep />
              <Tool label="Upload image" onClick={() => fileInput.current?.click()}>
                <ImageIcon />
              </Tool>
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
                multiple
                hidden
                onChange={(e) => {
                  insertImages(editor, doUpload, Array.from(e.target.files ?? []), undefined, onUploadError);
                  e.target.value = "";
                }}
              />
            </>
          )}
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}

function Tool({
  label,
  shortcut,
  active,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={active}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClick}
          className={cn(
            "grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-[15px]",
            active && "bg-accent text-foreground",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {label}
        {shortcut && <span className="ml-1.5 opacity-60">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

const Sep = () => <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />;
