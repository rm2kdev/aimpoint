# Optimistic actions and background uploads

Aimpoint shows the result of an action the moment someone takes it and does the server work behind the scenes
(VEC-452). Every surface uses the same plumbing so retries, failures and the leave-page warning behave alike.

## The pieces

| What | Where |
| --- | --- |
| Queue rules (pure, unit tested) | `src/lib/pending-actions-core.ts`, `pending-actions.test.mjs` |
| Tab-wide queue, hooks, toasts, `beforeunload` | `src/lib/pending-actions.ts` |
| Upload rules (pure, unit tested) | `src/lib/background-uploads-core.ts`, `background-uploads.test.mjs` |
| Signed-in upload hook for `RichEditor` | `src/components/task-composer/background-uploads.ts` (`useBackgroundUploads`) |
| Editor images (built into `RichEditor`) | `src/components/editor-uploads.ts`, `src/lib/editor-uploads-core.ts`, `editor-uploads.test.mjs` |

## Running an action in the background

```tsx
const { run } = usePendingActions();

function rename(next: string) {
  const prev = title;
  run({
    key: task.id,            // actions with the same key reach the server in order
    label: "Rename",         // shown in "Rename not sent" toasts and failed rows
    apply: () => setTitle(next),       // optimistic result, runs at once
    rollback: () => setTitle(prev),    // on a refusal or a discard
    run: () => updateTask(slug, task.id, { title: next }),  // any action returning Result
    onSuccess: (saved) => upsert(saved!),
  });
}
```

What happens next:

- `{ok: true}`: `onSuccess(data)`, the item leaves the queue.
- `{ok: false, error}`: a server refusal. `rollback` runs and the error is toasted, as screens did before. Never retried.
- A network error (fetch got no answer: offline, server restarting): retried after 1 s, 2 s, 4 s. After that the item
  turns `failed`, the optimistic result stays on screen, and a toast offers Retry. Coming back online retries every
  failed item.
- Any other thrown error: `failed` straight away (no automatic retry).

A failed item holds back later actions on the same key, so a status change made after an unsent rename never
overtakes it. The user resolves it with `retry(id)` or `discard(id)` (rolls back, then the rest of the key's queue
runs). `run()` returns `{id, done}`; `usePendingItem(id)` gives that item's live state for a "Sending..." or
"Not sent. Retry / Discard" line, and `usePendingActions(filter).items` lists unsent work (e.g. one task's).

Write `apply`/`rollback` per field (set this title back), not as whole-record snapshots: a snapshot rollback can
undo a later action that already went through.

Pending work is held in memory only. A reload or a closed tab loses it, which is why leaving asks first.

## Images that show at once

```tsx
const uploads = useBackgroundUploads(orgSlug);

<RichEditor upload={uploads.upload} ... />   // inserts a local preview immediately

async function send(html: string) {
  let body: string;
  try {
    body = await uploads.resolve(html);      // waits for uploads in flight, swaps previews for /api/uploads/... URLs
  } catch (err) {
    if (isUploadsFailed(err)) return toast.error(err.message);  // names the image; never sends a blob: URL
    throw err;
  }
  run({ ..., run: () => addComment(slug, task.id, body) });
  uploads.reset();
}
```

- `upload` returns the preview at once; the upload runs in the background (network errors retry twice on their own).
- A failed upload toasts as it happens and stays in `uploads.failed`; `retry(preview)` tries again and `forget(preview)`
  drops one the user removed. `resolve` only refuses failures whose preview is still in the text.
- `resolve` works on HTML and Markdown alike (plain string replacement of the preview URL).
- The public form and public project uploaders still use `usePendingUploads` (endpoint-specific errors); they can move
  here by passing `{ upload }`.

## Images in rich text (descriptions, plans, new tasks)

`RichEditor` does this itself (VEC-455), so screens don't wire anything for editor images:

- Paste, drop or the toolbar button inserts the image at once from a local `blob:` preview. The node carries an
  editor-only `uploading` attribute (never in the saved HTML): `image-node-view.ts` marks it `data-uploading` and
  globals.css veils it with a still "Uploading..." pill.
- Signed-in uploads go through one tab-wide `createUploadQueue` per org (`components/editor-uploads.ts`,
  `editorUploadQueue`), so an upload keeps going after the pane or dialog that started it closes. When it lands the
  editor swaps `src` for the stored URL (preloaded first, not part of undo history), which fires `onChange` again. A
  failed upload toasts and the image is removed; the text around it stays.
- Custom uploaders (`upload` prop: the public form and public project) get an editor-local queue around them, so their
  images show at once too; the composer still waits for those uploads before sending, as before.
- Every save path runs `await resolveEditorUploads(html)` first (`task-pane.tsx` `flushDesc`, `task-plan.tsx`): it
  waits for the uploads the text uses, swaps previews for stored URLs and drops images with none, so a `blob:` URL is
  never sent. Pure helpers: `lib/editor-uploads-core.ts` (`editor-uploads.test.mjs`).
- Creating a record doesn't wait: create it with `withoutPreviewImages(html)` and call
  `saveWhenUploaded(id, html, save)`, which saves the full text on the action queue once the uploads land
  (`new-task-dialog.tsx`). That second save shows in the task's history as a description edit.

## Leaving with unsent work

`pendingWork` is one registry for the tab. The queue holds it while anything is pending or failed, background uploads
hold it while any upload is in flight, and `useUnsentWork(active)` holds it for anything else. A `beforeunload`
listener is attached only while it is held, so leaving a page with nothing pending never asks (and keeps the
back/forward cache).

## What stays synchronous

Settings, billing, sign-in and invite forms keep waiting for the server: there the confirmation is the point.

## Comments (VEC-454)

The comment box is the first surface on this plumbing. `lib/pending-comments.ts` keeps a tab-wide store of comments
that are shown but not stored yet (so switching tasks keeps them) and one upload queue for composer images:

- `MentionComposer` inserts `![name](blob:…)` at once (`addCommentImage`) with a thumbnail strip under the text, and
  `onSend(body)` clears the box straight away. Comment is never disabled.
- `commentStore.post(...)` shows the comment (`LocalCommentRow`: dimmed "Sending…" / "Uploading image…", then
  "Not sent" with Retry / Discard), waits for its images (`resolve`), then calls `addComment` on queue key
  `comment:<taskId>` (comments stay in order without holding up other edits to the task).
- The feed renders `mergeFeed(feed, locals)`: a local comment drops out as soon as the stored one is in the feed,
  matched by the reply's id or, when the realtime echo wins the race, by author + sent body (one echo per local).
- A refusal rolls back, toasts, and puts the text back in the box (`ComposerHandle.restore`).
