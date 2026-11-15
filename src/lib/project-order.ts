/**
 * Per-user sidebar project order (VEC-53). Each member keeps their own order on their membership
 * (`memberships.projectOrder`), so reordering never changes a teammate's sidebar.
 *
 * Pure helpers, no server-only imports: the server sorts the shell data with this and the client re-sorts
 * after a reorder in this tab or another tab of the same person.
 */

/** The order a person saved, with the server time it was saved (ms). `at` is 0 when they never reordered. */
export interface ProjectOrder {
  ids: string[];
  at: number;
}

/**
 * Sort `projects` by `order`. Projects in the list come first, in list order; the rest (new projects, or
 * ones never placed) follow in their incoming order, which is `createdAt` from the loaders. Ids in the
 * list that match no project (deleted) are ignored, so deleting a project needs no cleanup.
 */
export function sortByProjectOrder<T extends { id: string }>(projects: T[], order: readonly string[]): T[] {
  if (!order.length) return projects;
  const rank = new Map<string, number>();
  order.forEach((id, i) => {
    if (!rank.has(id)) rank.set(id, i);
  });
  const placed = projects.filter((p) => rank.has(p.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  const rest = projects.filter((p) => !rank.has(p.id));
  return [...placed, ...rest];
}
