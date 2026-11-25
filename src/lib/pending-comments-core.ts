/**
 * Comments that post instantly (VEC-454, part of VEC-452). Pressing Comment shows the comment in the feed at once as a
 * local item; the server work (waiting for the comment's images to upload, then `addComment`) runs in the background
 * on VEC-453's action queue. Pure and framework-free so `pending-comments.test.mjs` runs it under `node --test`; the
 * browser wiring (tab-wide store, uploadImage, toasts) is `lib/pending-comments.ts`.
 *
 * Merge rules (`mergeFeed`): the server feed is the truth. A local comment disappears as soon as the server's copy is
 * in the feed, whichever arrives first: the action reply (matched by id) or the realtime `feed.add` echo (matched by
 * author + sent body, each server comment standing in for at most one local one, oldest first). So it never shows
 * twice and never blinks out. A comment with images keeps its local row (with the previews) in the server copy's place
 * until the stored images have loaded (`warming`), so the image doesn't blank out while it downloads (VEC-452).
 */
import type { ActionQueue, ActionResult } from "./pending-actions-core";
import type { UploadQueue } from "./background-uploads-core";

/** The fields of a feed item this module reads (`FeedItem` in types.ts). */
export interface FeedLike {
  id: string;
  kind: string;
  actorId: string;
  body?: string;
  createdAt: string;
}

export interface LocalComment {
  /** `local_…`, the row key until the server's copy replaces it. */
  localId: string;
  taskId: string;
  actorId: string;
  /** What the composer sent: mention tokens, image tokens still pointing at local previews. */
  body: string;
  /** The body as sent to the server (previews swapped for stored URLs), once known. */
  sent: string | null;
  /** The server comment's id once the reply came back. */
  realId: string | null;
  /** The queue item behind it (`usePendingItem` gives pending/failed + error). */
  actionId: string | null;
  /** Local previews this comment's body uses (shown as images until it's sent). */
  previews: string[];
  createdAt: string;
  /** Its stored images are still loading: the local row stands in for the server copy until they're in the cache. */
  warming?: boolean;
}

/** A local comment rendered in the feed. */
export type FeedRow<F extends FeedLike> = { kind: "server"; item: F } | { kind: "local"; local: LocalComment };

/** Same normalisation as the server (`addCommentAs` trims). */
const norm = (s: string | null | undefined) => String(s ?? "").trim();

/** How far a server comment's time may sit before the local one's (clock skew between this browser and the server). */
const SKEW_MS = 5 * 60_000;

/**
 * For each local comment, the server comment that stands for it (if it's in `feed` yet). By id first, then by author
 * and sent body for the realtime echo that beat the reply. Each server comment matches at most one local one.
 */
export function matchLocals<F extends FeedLike>(feed: readonly F[], locals: readonly LocalComment[]): Map<string, F> {
  const out = new Map<string, F>();
  const claimed = new Set<string>();
  const byId = new Map(feed.map((f) => [f.id, f]));
  for (const l of locals) {
    const f = l.realId ? byId.get(l.realId) : undefined;
    if (f) {
      out.set(l.localId, f);
      claimed.add(f.id);
    }
  }
  const ordered = [...locals].filter((l) => !out.has(l.localId) && l.sent != null).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const l of ordered) {
    const since = Date.parse(l.createdAt) - SKEW_MS;
    const f = feed.find(
      (x) => !claimed.has(x.id) && x.kind === "comment" && x.actorId === l.actorId && norm(x.body) === norm(l.sent) && !(Date.parse(x.createdAt) < since),
    );
    if (f) {
      out.set(l.localId, f);
      claimed.add(f.id);
    }
  }
  return out;
}

/**
 * The feed with this task's unsent comments after it (newest last), minus any the server copy already stands for. A
 * local comment whose stored images are still loading takes its server copy's place instead.
 */
export function mergeFeed<F extends FeedLike>(feed: readonly F[], locals: readonly LocalComment[]): FeedRow<F>[] {
  const matched = matchLocals(feed, locals);
  const standIn = new Map<string, LocalComment>();
  for (const l of locals) {
    const f = matched.get(l.localId);
    if (f && l.warming) standIn.set(f.id, l);
  }
  return [
    ...feed.map((item): FeedRow<F> => {
      const local = standIn.get(item.id);
      return local ? { kind: "local", local } : { kind: "server", item };
    }),
    ...locals.filter((l) => !matched.has(l.localId)).map((local) => ({ kind: "local" as const, local })),
  ];
}

/** Adds a server item to a feed unless it's already there (the reply and the realtime echo both bring it). */
export function addOnce<F extends FeedLike>(feed: readonly F[], item: F): F[] {
  return feed.some((f) => f.id === item.id) ? [...feed] : [...feed, item];
}

export interface PostInput<R> {
  slug: string;
  taskId: string;
  actorId: string;
  /** Encoded body (mention tokens, image tokens with local previews). */
  body: string;
  /** The stored comment came back (add it to the feed; toast held mentions). */
  onPosted?: (result: R, local: LocalComment) => void;
  /** A refusal: the comment was rolled back (the queue toasts the error). The body is handed back so it isn't lost. */
  onRefused?: (body: string, error: string) => void;
}

export interface CommentStoreDeps<R extends { id: string }> {
  queue: ActionQueue;
  uploads: Pick<UploadQueue, "resolve" | "retry" | "forget" | "get">;
  addComment: (slug: string, taskId: string, body: string) => Promise<ActionResult<R>>;
  now?: () => Date;
  newId?: () => string;
  /** Runs `fn` once the stored comment surely reached the feed (prunes a posted local copy). Default 30 s timer. */
  later?: (fn: () => void) => void;
  /** Loads the stored image URLs into the browser cache; resolves when done or given up (never rejects). Default: at once. */
  warm?: (urls: string[]) => Promise<void>;
}

/** Image URLs in a comment body (`![name](url)` tokens). */
const imageUrls = (body: string) => [...body.matchAll(/!\[[^\]]*\]\(([^\s()<>]+)\)/g)].map((m) => m[1]);

export type CommentStore = ReturnType<typeof createCommentStore>;

/** Local comments for every task in the tab, posted through `deps.queue`. */
export function createCommentStore<R extends { id: string }>(deps: CommentStoreDeps<R>) {
  let seq = 0;
  const newId = deps.newId ?? (() => `local_${Date.now().toString(36)}_${(seq++).toString(36)}`);
  const now = deps.now ?? (() => new Date());
  const later = deps.later ?? ((fn: () => void) => void setTimeout(fn, 30_000));
  const warm = deps.warm ?? (async () => {});
  let locals: readonly LocalComment[] = [];
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());
  const set = (next: readonly LocalComment[]) => {
    locals = next;
    emit();
  };
  const patch = (localId: string, p: Partial<LocalComment>) => set(locals.map((l) => (l.localId === localId ? { ...l, ...p } : l)));
  const remove = (localId: string) => set(locals.filter((l) => l.localId !== localId));
  const forgetPreviews = (l: LocalComment | undefined) => l?.previews.forEach((p) => deps.uploads.forget(p));
  const find = (localId: string) => locals.find((l) => l.localId === localId);

  /** Shows the comment at once and sends it in the background. Returns the local comment. */
  function post(input: PostInput<R>): LocalComment {
    const previews = [...new Set([...input.body.matchAll(/\]\(([^\s()<>]+)\)/g)].map((m) => m[1]).filter((u) => deps.uploads.get(u)))];
    const local: LocalComment = {
      localId: newId(),
      taskId: input.taskId,
      actorId: input.actorId,
      body: input.body,
      sent: null,
      realId: null,
      actionId: null,
      previews,
      createdAt: now().toISOString(),
    };
    let refused = false;
    // The stored images are fetched while addComment runs; the previews are freed once both are done.
    let warmed = previews.length === 0;
    let posted = false;
    let warming: Promise<void> | null = null;
    const { id } = deps.queue.enqueue<R>({
      key: `comment:${input.taskId}`,
      label: "Comment",
      apply: () => set([...locals, local]),
      rollback: () => {
        const l = find(local.localId);
        remove(local.localId);
        // A refused comment goes back to the composer with its previews; a discarded one is dropped for good.
        if (!refused) forgetPreviews(l);
      },
      run: async () => {
        // A retry also retries the comment's images that failed.
        for (const p of previews) if (deps.uploads.get(p)?.state === "failed") await deps.uploads.retry(p);
        const sent = await deps.uploads.resolve(input.body);
        if (find(local.localId)?.sent !== sent) patch(local.localId, { sent });
        if (!warmed && !warming) {
          const stored = imageUrls(sent).filter((u) => !previews.includes(u));
          patch(local.localId, { warming: true });
          warming = warm(stored)
            .catch(() => {})
            .then(() => {
              warmed = true;
              warming = null;
              patch(local.localId, { warming: false });
              if (posted) forgetPreviews(find(local.localId) ?? local);
            });
        }
        const r = await deps.addComment(input.slug, input.taskId, sent);
        // Known before the queue rolls back, so the rollback keeps the previews for the restored draft.
        if (!r.ok) refused = true;
        return r;
      },
      onSuccess: (data) => {
        const l = find(local.localId) ?? local;
        if (data) {
          // The local copy stays (hidden by mergeFeed once the stored one is in the feed) and is pruned later, so the
          // row never blinks out between this store's update and the feed's.
          patch(local.localId, { realId: data.id });
          input.onPosted?.(data, { ...l, realId: data.id });
          later(() => remove(local.localId));
        } else remove(local.localId);
        posted = true;
        // Still loading the stored images: the local row (and its previews) stays in place until they're cached.
        if (warmed || !data) forgetPreviews(l);
      },
      onRefused: (error) => input.onRefused?.(input.body, error),
    });
    patch(local.localId, { actionId: id });
    return find(local.localId) ?? local;
  }

  return {
    post,
    /** Sends a failed comment again. */
    retry: (local: LocalComment) => (local.actionId ? deps.queue.retry(local.actionId) : false),
    /** Drops a failed comment (and its images). */
    discard: (local: LocalComment) => (local.actionId ? deps.queue.discard(local.actionId) : false),
    all: () => locals,
    forTask: (taskId: string) => locals.filter((l) => l.taskId === taskId),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
