"use client";

import { cn } from "@/lib/utils";
import { useOrg } from "@/components/org-provider";
import { MemberAvatar } from "@/components/bits";
import { CommentBody } from "@/components/mentions";
import { usePendingItem } from "@/lib/pending-actions";
import { commentStore, useCommentUploads, type LocalComment } from "@/lib/pending-comments";
import { timeAgo } from "@/lib/format";

/**
 * A comment shown before the server stored it (VEC-454): the same row as a stored comment, dimmed while it sends,
 * "Not sent" with Retry / Discard when it couldn't be sent. Its images show from their local previews.
 */
export function LocalCommentRow({ local }: { local: LocalComment }) {
  const { memberById, me } = useOrg();
  const item = usePendingItem(local.actionId);
  const uploads = useCommentUploads();
  const actor = memberById.get(local.actorId);
  const failed = item?.state === "failed";
  const sending = !!item && !failed;
  const uploading = sending && uploads.some((u) => local.previews.includes(u.preview) && u.state === "uploading");
  const isLocal = (url: string) => local.previews.includes(url);
  return (
    <li className="flex gap-2.5" data-local-comment={failed ? "failed" : sending ? "pending" : "sent"}>
      <MemberAvatar member={actor} id={local.actorId} size={22} className="mt-px" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px]">
          <span className="font-medium">{actor?.name ?? me.name}</span>
          <time className="ml-2 text-[12px] text-faint" dateTime={local.createdAt} title={new Date(local.createdAt).toLocaleString()}>
            {timeAgo(local.createdAt)}
          </time>
          {sending && (
            <span className="ml-2 text-[12px] text-faint" aria-live="polite">
              {uploading ? "Uploading image…" : "Sending…"}
            </span>
          )}
        </div>
        <div
          className={cn(
            "mt-1 rounded-[10px] border border-border bg-sidebar px-3 py-2 text-[13.5px] leading-relaxed break-words whitespace-pre-wrap transition-opacity",
            sending && "opacity-60",
            failed && "border-destructive/40",
          )}
        >
          <CommentBody body={local.body} localImage={isLocal} />
        </div>
        {failed && (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[12px]" role="alert">
            <span className="font-medium text-destructive">Not sent.</span>
            <span className="text-muted-foreground">{item?.error}</span>
            <button type="button" className="font-medium text-foreground underline-offset-2 hover:underline" onClick={() => commentStore.retry(local)}>
              Retry
            </button>
            <button type="button" className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => commentStore.discard(local)}>
              Discard
            </button>
          </div>
        )}
      </div>
    </li>
  );
}
