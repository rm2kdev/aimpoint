import "server-only";
import type { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import type { Member } from "@/lib/types";

/** How a deleted account shows up on the tasks, comments, mentions and activity it left behind (VEC-48). */
export const DELETED_USER_NAME = "Deleted user";

/** Ids of deleted accounts that can still appear in this org (see deleteAccount's tombstone). */
export async function loadDeletedUserIds(orgId: ObjectId): Promise<string[]> {
  const c = await cols();
  const rows = await c.deletedUsers.find({ orgIds: orgId }, { projection: { _id: 1 } }).toArray();
  return rows.map((r) => r._id.toHexString());
}

/**
 * Deleted accounts as name-only placeholders for the client's `memberById` lookup, so every place that
 * resolves a person by id (lists, pane, comments, mentions, inbox) shows "Deleted user" instead of
 * "Former member". They're never in `members`, so pickers can't offer them.
 */
export async function loadDeletedMembers(orgId: ObjectId): Promise<Member[]> {
  return (await loadDeletedUserIds(orgId)).map((id) => ({ id, name: DELETED_USER_NAME, email: "", role: "member", kind: "user" }));
}
