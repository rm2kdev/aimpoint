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

## Leaving with unsent work

`pendingWork` is one registry for the tab. The queue holds it while anything is pending or failed, background uploads
hold it while any upload is in flight, and `useUnsentWork(active)` holds it for anything else. A `beforeunload`
listener is attached only while it is held, so leaving a page with nothing pending never asks (and keeps the
back/forward cache).

## What stays synchronous

Settings, billing, sign-in and invite forms keep waiting for the server: there the confirmation is the point.
