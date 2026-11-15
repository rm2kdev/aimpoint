"use client";

import { StatusRing, STATUS_RING_WORKING_LABEL } from "@/components/bits";
import { useOrgBase } from "@/components/org-provider";
import type { Member } from "@/lib/types";

/** "Hermes is working on this", "Hermes and Kev are working on this", "Hermes, Kev and 2 others are working on this". */
export function workingLabel(botIds: string[], memberById: Map<string, Member>): string {
  const names = botIds.map((id) => memberById.get(id)?.name).filter((n): n is string => !!n);
  if (!names.length) return STATUS_RING_WORKING_LABEL;
  if (names.length === 1) return `${names[0]} is working on this`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are working on this`;
  const rest = names.length - 2;
  return `${names[0]}, ${names[1]} and ${rest} other${rest === 1 ? "" : "s"} are working on this`;
}

/**
 * The status icon for a specific task: spins while a bot is working on it (live, via task.upsert).
 * Status pickers, group headers and settings previews describe a status, not a task, so they use StatusRing.
 */
export function TaskStatusRing({
  task,
  size,
  className,
}: {
  task: { statusId: string; workingBotIds?: string[] };
  size?: number;
  className?: string;
}) {
  const { statuses, statusById, memberById } = useOrgBase();
  const botIds = task.workingBotIds ?? [];
  const working = botIds.length > 0;
  return (
    <StatusRing
      status={statusById.get(task.statusId)}
      statuses={statuses}
      size={size}
      className={className}
      working={working}
      workingLabel={working ? workingLabel(botIds, memberById) : undefined}
    />
  );
}
