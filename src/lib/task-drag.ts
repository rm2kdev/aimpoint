/**
 * Shared by the task list (status groups) and the sidebar's spring-loaded project rows (VEC-60/61).
 * No server imports, so client components on both sides can use it.
 */

/** Every status group's list shares this drag group, so a task can be dropped into another status or project. */
export const TASK_DRAG_GROUP = "tasks";

/** Hover a dragged task this long over a sidebar project row and the project opens (Finder's spring-loaded folders). */
export const SPRING_DELAY_MS = 700;

/** The row's blink (two quick flashes) before the project opens. Matches `.spring-blink` in globals.css. */
export const SPRING_BLINK_MS = 320;

/**
 * Dwell-to-nest (VEC-447/448): hold a dragged task over the middle of another task's row this long and it arms;
 * releasing then files it as a sub-task. Same timing and blink as spring-loading, so both read as one gesture.
 */
export const NEST_DWELL_MS = SPRING_DELAY_MS;

/** The armed row's blink. Reuses `.spring-blink` (globals.css). */
export const NEST_BLINK_MS = SPRING_BLINK_MS;

/**
 * The central share of a task row's height that counts as onto the row (the nest zone). The edges above and below
 * stay reorder insertion points, so a task row is both a sortable item and a nest target (see `nestZoneAt` in
 * `@/lib/reorder`). A 36 px row: 18 px nest zone, 9 px reorder edge on each side.
 */
export const NEST_ZONE_BAND = 0.5;
