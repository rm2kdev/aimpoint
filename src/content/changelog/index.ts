// "What's new" milestones (VEC-373), newest first. Add one module per release next to this file and list it at
// the top of MILESTONES; screenshots go in public/changelog/<milestone-id>/. How-to: docs/changelog.md.
// `pnpm test` validates this list (src/lib/changelog-core.test.mjs), so a bad milestone fails the tests.
import type { ChangelogMilestone } from "@/lib/changelog-core";
import m20261121 from "./2026-11-21";

export const MILESTONES: readonly ChangelogMilestone[] = [m20261121];
