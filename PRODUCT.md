# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Next.js (App Router, TypeScript), MongoDB, shadcn/ui (Tailwind). Auth.js with self-hosted email + password; organisations and roles modelled in MongoDB. Deploy target: Vercel as a SaaS, with a fully local development mode. Infrastructure behind adapters:

- Real-time: Pusher-compatible provider on Vercel; in-process SSE locally.
- Image uploads: Vercel Blob on Vercel; local disk locally.

## Users

Small software teams (2-20 people) who want an issue and feature-request tracker lighter than Linear or Jira. They log bugs and ideas, assign them, and move them through their own workflow during the working day, often with the app open in a window beside their editor.

## Product Purpose

Aimpoint is a place to store and track issues and feature requests for a team. Success: capturing a task takes seconds, the whole team sees changes live without refreshing, and the list never feels heavier than the work it describes.

## Positioning

Deliberately small: the essentials of a team tracker (orgs, roles, assignment, rich descriptions with images, custom statuses, live updates) without the configuration surface of Linear/Jira.

## Operating Context

- Multi-user, multi-organisation. A user can belong to several organisations and switch between them; all data is scoped to an organisation.
- Roles: admin (manage members, invites, statuses, org settings) and member (create and work tasks).
- Sidebar-driven workflow: navigation between views and organisations lives in a persistent sidebar.
- Teams keep it open all day; real-time updates matter more than notifications.

## Capabilities and Constraints

- Tasks: title, rich-text (WYSIWYG) description with image upload, type (issue / feature request), status, assignee, priority, comments.
- Statuses are customisable per organisation (admins add, rename, reorder, remove).
- Light and dark modes.
- Real-time updates for task lists, task detail and comments.
- Undecided: billing/plans, notifications/email, integrations.

## Brand Commitments

- Name: Aimpoint (renamed from Vector, VEC-196).
- Binding visual references from the user: the calm, clean style of Things 3 (macOS) and Vercel. Sidebar-based workflow.

## Evidence on Hand

None yet. No customers, testimonials or metrics; do not fabricate any.

## Product Principles

1. Capture first: creating a task is always one keystroke or click away.
2. Quiet by default: the interface recedes so the tasks are the content.
3. Live, not stale: every view reflects teammates' changes without reload.
4. Small surface: add a setting only when a team genuinely differs.
