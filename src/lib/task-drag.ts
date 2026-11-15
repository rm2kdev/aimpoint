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
