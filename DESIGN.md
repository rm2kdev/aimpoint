---
name: Vector
description: Issues and feature requests for small software teams; a calm list that stays live.
colors:
  brand-blue: "#2f6fed"
  selection-wash: "#e8effd"
  selection-ink: "#1d5fd6"
  ink: "#171717"
  ink-inverse: "#fafafa"
  paper: "#ffffff"
  sidebar-paper: "#f7f7f5"
  stone-wash: "#f3f3f1"
  hover-wash: "#f1f1ef"
  sidebar-hover: "#ececea"
  hairline: "#ececea"
  input-stroke: "#e2e2df"
  muted-ink: "#5c5c5c"
  faint-ink: "#737373"
  live-wash: "#fff6d6"
  live-border: "#f0d98a"
  destructive: "#d93036"
  issue-red: "#e5484d"
  feature-green: "#30a46c"
  task-slate: "#8b8d98"
  dark-paper: "#0a0a0a"
  dark-sidebar-paper: "#111111"
  dark-popover: "#141414"
  dark-ink: "#ededed"
  dark-stone-wash: "#1a1a1a"
  dark-hover-wash: "#171717"
  dark-sidebar-hover: "#1c1c1c"
  dark-hairline: "#1f1f1f"
  dark-input-stroke: "#2a2a2a"
  dark-muted-ink: "#a1a1a1"
  dark-faint-ink: "#8a8a8a"
  dark-brand-blue: "#3b7cff"
  dark-selection-wash: "#14233f"
  dark-selection-ink: "#9dbdff"
  dark-live-wash: "#2a2310"
  dark-live-border: "#5c4a14"
  dark-destructive: "#ff6166"
typography:
  headline:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  body-small:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  group-label:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 600
    lineHeight: 1.3
  label:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "11.5px"
    fontWeight: 500
    lineHeight: 1.3
  mono-id:
    fontFamily: "Geist Mono, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.3
    fontFeature: "\"tnum\" 1"
rounded:
  tiny: "4px"
  tag: "5px"
  sm: "5.4px"
  nav: "7px"
  md: "7.2px"
  lg: "9px"
  container: "10px"
  xl: "12.6px"
  full: "9999px"
spacing:
  row-gap: "4px"
  xs: "4px"
  sm: "8px"
  row-inline: "12px"
  md: "16px"
  pane-inline: "24px"
  header-inline: "28px"
  settings-row: "28px"
  header-height: "56px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ink-inverse}"
    rounded: "{rounded.lg}"
    padding: "0 12px"
    height: "30px"
  button-outline:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  input:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "4px 10px"
    height: "32px"
  task-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "0 12px"
    height: "40px"
  task-row-hover:
    backgroundColor: "{colors.hover-wash}"
  task-row-selected:
    backgroundColor: "{colors.selection-wash}"
  task-row-live:
    backgroundColor: "{colors.live-wash}"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.nav}"
    padding: "0 8px"
    height: "30px"
  nav-item-hover:
    backgroundColor: "{colors.sidebar-hover}"
  nav-item-active:
    backgroundColor: "{colors.selection-wash}"
    textColor: "{colors.selection-ink}"
  property-chip:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.muted-ink}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "28px"
  type-tag:
    backgroundColor: "{colors.stone-wash}"
    textColor: "{colors.muted-ink}"
    rounded: "{rounded.tag}"
    padding: "0 6px"
    height: "20px"
  kbd:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.faint-ink}"
    rounded: "{rounded.tiny}"
    padding: "0 4px"
    height: "18px"
  filter-segment-active:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.full}"
    padding: "0 10px"
    height: "22px"
  comment-bubble:
    backgroundColor: "{colors.sidebar-paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.container}"
    padding: "8px 12px"
  detail-pane:
    backgroundColor: "{colors.paper}"
    width: "440px"
  sidebar:
    backgroundColor: "{colors.sidebar-paper}"
    width: "248px"
---

# Design System: Vector

## Overview

**Creative North Star: "The Calm Ledger"**

Vector is a list you can leave open all day. A warm off-white sidebar sits beside a pure white work column; tasks are 40px rows with soft 9px corners and a 2px breath between them, grouped under sticky status headings. The chrome is hairlines and grey type. Almost everything that carries colour is data: the status ring, the project dot, the type tag, the avatar. The interface itself owns one blue (selection and focus), one near-black (the primary action), and one warm yellow that only appears when a teammate changed something you have not looked at yet.

The precision comes from Vercel: Geist Sans for UI, Geist Mono with tabular numerals for task keys and counts, 1px borders, a near-black primary button, and a true #0a0a0a dark mode rather than a grey one. The calm comes from Things 3: generous row height, one list per view, a detail pane that slides in beside the list rather than replacing it, and no visible grid lines between rows. Density is moderate; the list never turns into a table.

Motion is small and causal. Rows glide to their new position when their status changes (FLIP, 380ms), the status ring's arc animates as it fills, and live highlights fade rather than snap. Nothing moves on its own, with two exceptions: a status ring spins while a bot is working on the task, and a sidebar project row blinks before it springs open under a dragged task. Under `prefers-reduced-motion` every transition collapses to near-zero.

**Key Characteristics:**
- Two-tone canvas: warm sidebar paper beside pure white work area; #0a0a0a / #111111 in dark.
- Tasks as 40px rounded rows with a 4px gap, never ruled table lines.
- Colour belongs to data (status, project, type, avatar); chrome is neutral.
- One blue for selection, focus and caret; one near-black for the primary action.
- Geist Mono with tabular numerals for every ID and count.
- The status ring is the signature: a segmented arc across the org's ordered statuses.
- Live changes from teammates hold a soft yellow wash until seen.

## Colors

A neutral, slightly warm stone palette with a single cobalt accent and one signal yellow reserved for live changes.

### Primary
- **Cobalt Selection Blue** (brand-blue / dark-brand-blue): the only interface accent. Focus rings, the text caret, checkmarks in menus, the empty-state ring's filled arc, rich-text links, the drag drop line and drop-zone border. Never used as a large fill.
- **Selection Wash** and **Selection Ink** (selection-wash / selection-ink, dark variants): the selected task row, the active sidebar item, and `::selection`. The wash fills; the ink colours text and icons on top of it.

### Secondary
- **Ledger Near-Black** (ink): primary text and, inverted, the primary button and the active segment of the type filter. In dark mode the roles swap: the primary button becomes dark-ink on dark-paper.

### Tertiary
- **Live Yellow Wash** with **Live Border** (live-wash / live-border, dark variants): a row a teammate changed and you have not seen yet. Drawn as a fill plus a 1px inset ring. Cleared on 700ms hover or on open.

### Neutral
- **Paper** (paper / dark-paper): the work column, detail pane, inputs and the Kbd key face.
- **Sidebar Paper** (sidebar-paper / dark-sidebar-paper): the sidebar, comment bubbles and quiet notice panels. The warm off-white is what separates nav from work without a heavy rule.
- **Stone Wash** (stone-wash / dark-stone-wash): muted fills, skeletons, the type tag and inline `code` backgrounds.
- **Hover Wash** (hover-wash / dark-hover-wash): row and ghost-control hover in the work column.
- **Sidebar Hover** (sidebar-hover / dark-sidebar-hover): nav-item hover inside the sidebar.
- **Hairline** (hairline / dark-hairline): every divider and container border.
- **Input Stroke** (input-stroke / dark-input-stroke): input and segmented-control outlines, the unfilled bars of the priority icon, scrollbar thumbs.
- **Muted Ink** (muted-ink / dark-muted-ink): secondary text, descriptions, tag labels.
- **Faint Ink** (faint-ink / dark-faint-ink): IDs, counts, timestamps, placeholders, property labels in the detail pane, closed task titles.
- **Destructive Red** (destructive / dark-destructive): validation errors and destructive actions, usually at 10–20% tint behind red text.

### Data colours (not chrome)
- **Issue Red** (issue-red), **Feature Green** (feature-green) and **Task Slate** (task-slate): the 6–8px square inside the type tag and type pickers. Task Slate is a neutral cool grey (Radix slate 9) for plain work items that are neither a bug nor a feature; it reads in both themes without competing with the two chromatic types. Every type picks its square from one `TYPE_SWATCH` map in `bits.tsx`, so a new type never falls through a two-way ternary.
- Status colours are per-organisation data shown only inside status rings. The seeded defaults are Backlog #a3a3a3, Todo #737373, In Progress #e5a00d, In Review #8b5cf6, Done #2f6fed, Cancelled #a3a3a3.
- Project dots and avatars draw from fixed eight-colour sets (see the sidecar). Avatars are hashed by user id, so a person keeps the same colour everywhere.

### Named Rules
**The Data Owns Colour Rule.** Chroma on screen belongs to tasks (status rings, project dots, type squares, avatars). Chrome stays neutral, apart from the selection blue and the live yellow.

**The One Blue Rule.** Cobalt means "this is selected or focused". Do not use it for decoration, headings or secondary buttons.

**The Yellow Means Someone Else Rule.** The live wash appears only for changes made by another person and disappears once seen. It is never a generic highlight or warning colour.

## Typography

**Display Font:** none; the app has no display tier.
**Body Font:** Geist Sans (with ui-sans-serif, system-ui), loaded via next/font.
**Label/Mono Font:** Geist Mono (with ui-monospace), always with tabular numerals.

**Character:** a precise grotesk at small sizes, with negative tracking only on the few headings. Mono marks anything machine-shaped: task keys, counts, slugs, keyboard shortcuts.

### Hierarchy
- **Headline** (600, 20px, 1.3, −0.02em): the editable task title in the detail pane. The New Task dialog's title field is a sibling at 18px / −0.015em.
- **Title** (600, 15px, −0.01em): view headers ("My Tasks", "Settings") and empty-state titles. Settings row titles use 600 at 14px.
- **Body** (400, 14px, 1.6): the base size, task row titles, rich-text descriptions (capped at 72ch). Sidebar nav items run at 13.5px.
- **Body Small** (400, 13px): detail-pane property values, settings descriptions, activity feed, chips (12.5px).
- **Group Label** (600, 12.5px): sticky status group headers and the Activity heading.
- **Label** (500, 11.5px, Faint Ink, sentence case): sidebar section labels, role captions, save-state text.
- **Mono ID** (400, 12px, tabular): task keys (`WEB-14`), counts beside headings and nav items (11.5px). Kbd keys use 10.5px.

### Named Rules
**The Tabular Mono Rule.** Every task key and every count is set in Geist Mono with tabular numerals so columns of IDs and counts align. Do not set IDs in the sans.

**The Sentence Case Rule.** Labels are sentence case at 11.5–12.5px. The system has no uppercase tracked eyebrows; a group is named by its heading.

## Layout

A three-column app shell: a fixed 248px sidebar, a flexible list column, and an optional detail pane at 440px (lg), 500px (xl) and 560px (2xl). Below lg (1024px) the sidebar becomes a 272px slide-over drawer and an open task replaces the list rather than sitting beside it.

Every column starts with a 56px header separated by a hairline. The list header holds the view title, a mono count, a pill segmented type filter, the avatars of teammates also viewing, and the New Task button. The list content has 16px side padding (8px on mobile) and 64px of bottom padding so the last row can scroll clear.

Rows sit 4px apart inside their status group, with 16px between groups. Group headers are 32px tall, sticky at the top of the scroll area, on a solid paper background (no blur). Closed statuses (done, cancelled) are collapsed behind a "Show N completed" toggle.

The detail pane uses 24px side padding. Its property list is a two-column grid (88px label, flexible value) with 4px row gaps. Description, activity and composer follow, separated by hairlines with 20–24px padding.

Settings use Vercel-style rows: a 280px title-and-description column beside a flexible controls column, 40px apart, each row 28px top and bottom and separated by hairlines. Content is capped at 1100px. Below md (768px) the row stacks.

Responsive disclosure inside a row: the project label shows from xl, the type tag from md, the task key from sm. Status ring, title, priority and assignee are always visible.

## Elevation & Depth

Flat, tonal and hairline-led. Surfaces are separated by the sidebar/paper tone change and 1px borders, not shadows. Rows, panes, headers and settings containers carry no shadow. Elevation appears only on things that float above the page: menus, popovers, the mobile drawer and toasts. Dialogs use a 1px ring and a dimming overlay (black at 25% light, 55% dark) instead of a cast shadow.

### Shadow Vocabulary
- **Float ring** (`box-shadow: 0 0 0 1px color-mix(in oklab, var(--foreground) 10%, transparent)`): the edge of popovers, menus and dialogs, in both modes.
- **Popover lift** (Tailwind `shadow-md`, `0 4px 6px -1px rgb(0 0 0 / .1), 0 2px 4px -2px rgb(0 0 0 / .1)`): pickers and popovers, combined with the float ring.
- **Menu lift** (Tailwind `shadow-lg`, `0 10px 15px -3px rgb(0 0 0 / .1), 0 4px 6px -4px rgb(0 0 0 / .1)`): dropdown menus and the project colour swatch popover.
- **Drawer lift** (Tailwind `shadow-xl`): the mobile sidebar drawer only.
- **Live inset** (`box-shadow: inset 0 0 0 1px var(--live-border)`): a border drawn as an inset ring so the live row does not shift layout.

### Named Rules
**The Flat Page Rule.** Anything on the page is flat. Shadows are for layers that float above it and close when dismissed.

## Shapes

Soft and consistent. The base radius is 9px (`--radius: 0.5625rem`), shared by task rows, buttons, inputs, the search field and the rich-text toolbar. The scale is derived from it: 5.4px, 7.2px, 9px, 12.6px. Fixed small radii sit beside it: Kbd keys 4px, type tags 5px, sidebar nav items 7px, containers (comment bubbles, settings lists, the composer) 10px, dialogs 12.6px.

Circles are reserved for people and progress: avatars and the status ring. Pills are reserved for the type filter's segmented control. Small data marks use squircle-ish squares: project dots (2–3px radius), type squares (2px). The unassigned avatar is a dashed circle, and the backlog status is a dashed ring. Dashed means "not yet".

## Components

### Buttons
Refined and restrained; a near-black slab for the one thing you came to do, quiet outlines for the rest.
- **Shape:** gently rounded (9px). Default height 32px; the header's New Task button is 30px with 12px side padding. Small 28px, xs 24px.
- **Primary:** Ledger Near-Black fill, inverse text, 500 weight at 14px. It carries its shortcut as an inline Kbd tinted white at 15% (black at 10% in dark).
- **Hover / Focus:** hover drops the fill to 80% opacity. Focus is a 3px ring of the blue at 50% plus a blue border. Pressed buttons nudge down 1px.
- **Outline:** paper fill with a hairline border; hover fills with Stone Wash. Used for secondary actions and empty-state CTAs.
- **Ghost:** no fill until hover (Stone Wash). Used for Cancel and icon buttons (28px square, 7.2px radius) in pane headers.
- **Destructive:** red text on a 10% red tint, 20% on hover. Never a solid red slab.

### Chips
- **Type tag:** 20px tall, 5px radius, Stone Wash fill, 11.5px Muted Ink text, led by a 6px Issue Red, Feature Green or Task Slate square.
- **Property chip** (New Task dialog): 28px tall, 7.2px radius, hairline border on paper, 12.5px Muted Ink text with an icon (ring, avatar, priority bars, type square or project dot). Hover and open state fill with Hover Wash and lift the text to Ink.
- **Type filter:** a pill outline (Input Stroke) holding 22px pill segments. The active segment is solid Ink with paper text; inactive segments are Muted Ink and darken on hover.

### Cards / Containers
- **Corner Style:** 10px for content containers, 12.6px for dialogs.
- **Background:** paper for lists; Sidebar Paper for comment bubbles and notices.
- **Shadow Strategy:** none on page (see Elevation & Depth).
- **Border:** 1px hairline. Settings lists divide their items with internal hairlines.
- **Internal Padding:** 10–14px inline, 8–10px block for list items; 12px × 8px for comment bubbles.

### Inputs / Fields
- **Style:** 32px tall, 9px radius, 1px Input Stroke, transparent fill (Input Stroke at 30% in dark), 14px text, Muted Ink placeholder. The caret is always the brand blue.
- **Focus:** the border turns blue and a 3px blue ring at 50% appears.
- **Error / Disabled:** errors use a destructive border and a 20% ring. Disabled fields drop to 50% opacity on an Input Stroke tint.
- **Inline-edit fields** (status names, project names in settings): transparent borders until hover or focus, so they read as text.
- **Borderless title fields:** the task title (detail pane) and the New Task title are bare text with no border or fill, at headline size.
- **Search trigger:** a 30px paper field in the sidebar with a hairline, faint placeholder text and a ⌘K Kbd at the right.

### Navigation
- **Sidebar:** Sidebar Paper with 10px padding. The org switcher at the top shows a 22px near-black monogram tile. Below it come search, then the view items (My Tasks, All Tasks), then labelled sections (Projects, Organisation). The user, role and theme menu sit at the bottom above a hairline.
- **Nav item:** 30px tall, 7px radius, 13.5px text, 16px icon in Muted Ink, and a mono count at the right in Faint Ink. Hover uses Sidebar Hover. Active uses Selection Wash with Selection Ink text and icon, at weight 500.
- **Section label:** 11.5px / 500 Faint Ink, sentence case. An admin-only "+" action appears on hover.
- **Settings tabs:** 28px text tabs in the header. The active tab gets a Hover Wash fill and weight 500.
- **Mobile:** the sidebar becomes a 272px drawer behind a menu button in each header.

### Task Row (signature list primitive)
A 40px row on a three-track grid (22px ring, flexible title, auto metadata) with 14px gaps, 12px side padding and a 9px radius. The whole row is a link, with a 2px blue focus ring drawn on the full row. The ring button on the left opens a status picker without opening the task; it scales to 1.1 on hover and 0.95 on press. The metadata cluster on the right is project label, type tag, priority bars, a 20px avatar and the 64px right-aligned mono key. States: hover gives Hover Wash; selected gives Selection Wash; live gives Live Yellow Wash plus a 1px inset Live Border, and "Name changed this" replaces the project and type metadata. Closed tasks set their title in Faint Ink. When a row's position changes, it glides from its old offset (380ms, `cubic-bezier(.2,.8,.2,1)`). Background changes fade over 300ms.

### Status Ring (signature mark)
An 18px SVG ring (14–20px depending on context) in the status's own colour.
- **Backlog:** a dashed hairline circle.
- **Unstarted and started:** a 1.6px track with a heavier 3.4px arc. The arc fills to (index + 1) / (active statuses + 1) of the way around, so progress reads across the org's own ordered workflow. The arc animates over 300ms.
- **Done:** a filled disc with a white check.
- **Cancelled:** a filled disc with a white cross.
- **Working (any category, `working` prop):** a short 1.3px arc in the status colour orbits just outside the ring (r 9.3 of the 20-unit box) once every 1.1s, so the ring, its colour and its progress arc stay untouched underneath and the icon keeps its size. Labelled "A bot is working on this". Under `prefers-reduced-motion` the orbit stops and becomes a static faint full halo.

The same ring heads every status group, every status picker and the detail pane title. The empty state reuses it at 44px, with a faint track and a blue quarter arc.

### Drag to Reorder and Move (`SortableList`)
Every user-ordered list (sidebar projects, later statuses, list rows and board columns) drags through one primitive, `SortableList` in `src/components/ui/sortable-list.tsx`, on a session held by `DragProvider` (`src/components/ui/drag-provider.tsx`, mounted once in `AppShell`), with pure helpers (`moveItem`, `transferItem`, gap maths, `pickBox`, `adjacentList`) in `src/lib/reorder.ts`. Call sites never handle pointer or keyboard events themselves, and there is no DnD library.
- **Drop line:** while dragging, a 2px Cobalt Selection Blue line (`bg-brand`, so it follows light/dark) with fully rounded ends spans the full row width, centred in the gap at the exact insertion point of the list under the pointer. It glides between gaps over 100ms. Gaps directly above or below the dragged row in its own list would not change the order, so they show no line.
- **Dragged row:** dims to 45% in place, so no row moves until the drop. Rows under the pointer get no hover wash mid-drag.
- **Linked lists:** lists with the same `group` exchange items; `onMove(id, { fromList, toList, fromIndex, toIndex, ids })` fires on the receiving list (`fromIndex` is -1 once the source list is gone). A list without `group` only reorders itself, and a list without `onMove` never receives items. While an item from its group is dragged, an empty list shows a 36px dashed Input Stroke drop zone ("Drop here", Faint Ink) that turns brand-bordered with a 5% brand wash when it would receive the drop.
- **Floating preview:** reordering within one list keeps the line-only look. Once the pointer is over another list or a drop target, or the source row is gone (after a route change), a copy of the row follows the pointer: popover surface, 1px Border ring, large shadow, 95% opacity, no motion of its own. It hangs just right of the pointer (its left edge at most 12px left of it) and is at most 420px wide, so the target under the pointer stays visible.
- **External drop targets:** `useDropTarget(id, { accepts, onHoverStart, onHoverEnd, onDrop, dwellMs, onDwell, label })` gives any element (a sidebar project row, a trash zone) `{ ref, isOver, canDrop, dwell }`. It is hit-tested by its box, before lists. Style hover with Selection or a brand border, never Live Yellow. Spring-loading uses `dwellMs` + `onDwell`; `onHoverEnd` reports `{ dropped, dwellMs }`. `store.onEnd(fn(item, dropped))` tells a caller when a drag finished or was cancelled.
- **Spring-loaded sidebar projects (VEC-61):** while a task is dragged, each desktop sidebar project row is a drop target (tasks only; a project being reordered never triggers it). Hover = Selection-style brand highlight (10% brand wash, 1px inset brand ring, brand text), as for status headings. After 700ms (`SPRING_DELAY_MS` in `src/lib/task-drag.ts`) the row blinks: `.spring-blink`, two quick flashes of a 22% brand wash over 320ms (on 0-20%, off 25-45%, on 50-70%, off 75-95%, ending on), then the project opens by client navigation while the drag continues. Under `prefers-reduced-motion` there is no flashing: the row holds one static 22% wash until the project opens. Leaving the row before it opens cancels the spring. Releasing on the row moves the task to the top of its status in that project without opening it. Escape (or releasing away from every list) after a spring returns to the page the drag started on, with nothing moved. Archived projects aren't listed, so they're never targets. The mobile drawer's rows are not targets (the drawer covers the list a task would land in).
- **Across navigation:** the session, window listeners and preview live in `DragProvider`, so a drag survives a client-side route change; lists and targets that mount on the new page are picked up under the still pointer.
- **Starting a drag:** mouse and pen need 4px of travel, so plain clicks on row links still navigate (the click that ends a real drag is swallowed). Touch needs a 250ms long-press; moving first scrolls as normal. Pass `handle` to start drags only from a grip.
- **Keyboard:** focus the row's handle element (its link), Space lifts (the line appears as you move), Up/Down/Home/End move, Left/Right move to the previous/next linked list in document order (ignored in an unlinked list), Space or Enter drops, Escape or Tab cancels. Each step is announced in one assertive live region owned by the provider, naming the target list ("Alpha will move to Doing, position 2 of 2."), and focus follows the moved row into its new list.
- **Cancel:** Escape, a pointer cancel, or releasing more than 24px away from every list and target calls nothing (a hovered target gets `onHoverEnd` with `dropped: false`). Dropping in place calls nothing.
- **Auto-scroll:** holding the pointer within 36px of the top or bottom edge of the scrolling container around the list under it scrolls up to 14px a frame, stopping at that list's end.
- Under `prefers-reduced-motion` the line jumps between gaps and the dim and drop-zone colour are instant.

```tsx
<SortableList
  items={projects}
  getId={(p) => p.id}
  getLabel={(p) => p.name}
  onReorder={(ids, { movedId, fromIndex, toIndex }) => saveOrder(ids)}
  renderItem={(p, { handleProps }) => <Link href={p.href} {...handleProps}>{p.name}</Link>}
/>

// A board: one list per column, same group, stable listId
<SortableList listId={col.id} group="board" aria-label={col.name} items={col.tasks}
  getId={(t) => t.id} getLabel={(t) => t.title} getData={(t) => t}
  onReorder={(ids) => reorder(col.id, ids)}
  onMove={(id, { fromList, toList, toIndex }) => move(id, fromList, toList, toIndex)}
  renderItem={...} />
```
`onReorder` gets the complete new id order. Lists keep no order of their own, so update `items` optimistically in the callback (`moveItem(items, fromIndex, toIndex)`, or `transferItem(from, to, fromIndex, toIndex)` for a move). Vertical lists only for now.

### Priority Icon
Three ascending 3px bars in a 14px box. Filled bars are Muted Ink, or Ink at urgent (3); unfilled bars are Input Stroke. No priority is three short faint dashes.

### Avatars and Kbd
- **Avatar:** a circle in a hashed palette colour with white semibold initials at 42% of its size. Sizes are 20px in rows, 22–24px in the feed and sidebar, and 16–18px in chips and properties. Unassigned is a dashed Faint Ink circle.
- **Kbd:** an 18px key with a 4px radius, an Input Stroke border, paper face and 10.5px Faint Ink mono. Shortcuts are shown where they apply (N, ⌘K, ⌘↵).

### Detail Pane
A paper aside with a hairline left edge. Its 56px header holds the mono task key, the actions menu and a close button. Below are the ring and the 20px title, a property grid of borderless 28px picker buttons that fill with Hover Wash on hover, the rich-text editor, the activity feed and the comment composer. The editor toolbar is a hairline-bordered 9px strip at 80% opacity until the editor is hovered or focused. The feed alternates system events (a small Input Stroke dot, Muted Ink sentence with Ink names) and comments (an avatar beside a Sidebar Paper bubble). The composer is a 10px-radius field that reveals its send row only once text exists.

### New Task Dialog
A 640px dialog with no close button, anchored at 14vh from the top and radiused at 12.6px. It reads top to bottom: a faint "Project › New task" breadcrumb, an 18px borderless title, the rich editor, a row of property chips, then a hairline footer holding the error text, Cancel and "Create task ⌘↵". Enter submits from the title; ⌘↵ submits from anywhere.

## Do's and Don'ts

### Do:
- **Do** build lists from 40px rows with a 9px radius and a 4px gap, grouped under sticky 32px status headers.
- **Do** put colour on data (status ring, project dot, type square, avatar) and keep chrome in the neutral stone palette.
- **Do** reserve Cobalt Selection Blue for selection, focus rings, carets, checkmarks and the drag drop line.
- **Do** set every task key and count in Geist Mono with tabular numerals.
- **Do** use the status ring wherever a status appears, in that status's colour.
- **Do** separate surfaces with 1px hairlines and the sidebar/paper tone change. Use shadows only on floating layers.
- **Do** mark a teammate's unseen change with the live wash and inset border, and clear it on hover (700ms) or open.
- **Do** animate list reorders with the 380ms FLIP glide on `cubic-bezier(.2,.8,.2,1)`, and honour `prefers-reduced-motion`.
- **Do** lay settings out as 280px title/description rows beside their controls, divided by hairlines.
- **Do** show the keyboard shortcut as a Kbd next to the action it triggers.

### Don't:
- **Don't** draw ruled table lines or zebra stripes between task rows; spacing and hover washes separate them.
- **Don't** use the live yellow for warnings, badges or your own changes.
- **Don't** add shadows to rows, panes, headers or settings containers.
- **Don't** introduce a second accent hue for buttons or links; secondary actions are outline or ghost.
- **Don't** use uppercase tracked eyebrow labels; section labels are sentence case at 11.5px.
- **Don't** fill destructive buttons with solid red; use the red tint with red text.
- **Don't** set status colours on anything other than rings (and the matching ring in a picker).
