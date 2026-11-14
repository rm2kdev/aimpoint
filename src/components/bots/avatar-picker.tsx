"use client";

import { useRef, useState } from "react";
import { ImageUpIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { BotAvatar, BotShapeGlyph } from "@/components/bits";
import { uploadImage } from "@/components/rich-editor";
import type { BotAvatar as BotAvatarData, BotShape } from "@/lib/types";

export const SHAPES: BotShape[] = ["blob", "ghost", "star", "heart", "flower", "cloud", "moon", "bolt"];
export const COLORS = ["#2f6fed", "#30a46c", "#e5a00d", "#8b5cf6", "#e5484d", "#0ea5b7", "#d6409f", "#525252"];

export function randomAvatar(): BotAvatarData {
  return { kind: "shape", shape: SHAPES[Math.floor(Math.random() * SHAPES.length)], color: COLORS[Math.floor(Math.random() * COLORS.length)] };
}

/** Pick a cute shape + colour, or upload a picture. */
export function AvatarPicker({
  orgSlug,
  value,
  onChange,
  name,
  disabled,
}: {
  orgSlug: string;
  value: BotAvatarData;
  onChange: (a: BotAvatarData) => void;
  name: string;
  disabled?: boolean;
}) {
  const file = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const shape = value.kind === "shape" ? value : null;
  const color = shape?.color ?? COLORS[0];

  const upload = async (f: File | undefined) => {
    if (!f) return;
    setUploading(true);
    try {
      onChange({ kind: "image", url: await uploadImage(orgSlug, f) });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="flex flex-wrap items-start gap-5">
      <BotAvatar avatar={value} name={name || "New bot"} size={72} className={cn(uploading && "opacity-50")} />
      <div className="grid min-w-0 gap-3">
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Shape">
          {SHAPES.map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={shape?.shape === s}
              aria-label={s}
              title={s}
              disabled={disabled}
              onClick={() => onChange({ kind: "shape", shape: s, color })}
              className={cn(
                "grid size-9 place-items-center rounded-[10px] border border-transparent transition-colors hover:bg-accent disabled:pointer-events-none",
                shape?.shape === s && "border-input bg-accent",
              )}
            >
              <span className="grid size-6 place-items-center rounded-[7px]" style={{ background: color }}>
                <BotShapeGlyph shape={s} bg={color} className="size-[72%]" />
              </span>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Colour">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={shape?.color === c}
              aria-label={`Colour ${c}`}
              disabled={disabled}
              onClick={() => onChange({ kind: "shape", shape: shape?.shape ?? "blob", color: c })}
              className={cn(
                "grid size-7 place-items-center rounded-full transition-transform hover:scale-110 disabled:pointer-events-none",
                shape?.color === c && "ring-2 ring-ring ring-offset-2 ring-offset-background",
              )}
            >
              <span className="size-5 rounded-full" style={{ background: c }} />
            </button>
          ))}
          <span className="mx-1 h-5 w-px bg-border" aria-hidden />
          <button
            type="button"
            disabled={disabled || uploading}
            onClick={() => file.current?.click()}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-md border border-input px-2 text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50",
              value.kind === "image" && "border-ring text-foreground",
            )}
          >
            <ImageUpIcon className="size-3.5" />
            {uploading ? "Uploading…" : value.kind === "image" ? "Change picture" : "Upload picture"}
          </button>
          <input
            ref={file}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
            hidden
            onChange={(e) => {
              upload(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>
      </div>
    </div>
  );
}
