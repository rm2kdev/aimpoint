---
version: 1
slug: "src-app"
primary_target: "src/app"
related_targets: []
---

# App shell and task workspace

Scope: the signed-in app (sidebar shell, task lists, task detail pane, settings). Mode: Operate. Build path: code-led.

Audience/job: small dev teams capturing, assigning and moving issues and feature requests through their org's statuses, scoped per project, all day beside their editor.

Approved preview: `.impeccable/mocks/direction.html` (user approved; feedback: add per-project scoping, add vertical gap between list rows so selected/highlighted rows never touch).

## Direction contract

THESIS: A Things 3 calm list held to Vercel precision; tasks are the content and the chrome recedes. Refuses the dense Jira grid and the card-board-first tracker.

OWN-WORLD: Warm off-white sidebar (#f7f7f5) beside a pure white work area; true #0a0a0a dark. Geist Sans for UI, Geist Mono for IDs and counts with tabular numerals. 1px hairlines, 9px row radius, one blue accent for selection, near-black primary button. Per-org status colours appear only in rings.

STORY: Open the app, see My Tasks grouped by status, press N to capture, click a row to open its detail pane, edit inline, watch teammates' changes arrive live.

FIRST VIEWPORT: 248px sidebar (org switcher, search, views, projects, org links, user + theme), list column with 56px header (title, count, filters, presence, New task), right detail pane 440px when a task is open.

FORM: Things-style sidebar list app, candidate 1 of my ordered list (brief-pinned). Signature move: the status ring fills in segments across the org's ordered statuses; live-changed rows hold a soft highlight until seen. seed: c63874e0 (direction roll, translated under pinned brief)

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
