"use server";

import { ObjectId } from "mongodb";
import { requireOrg } from "@/lib/session";
import { guard, type Result } from "@/lib/result";
import { loadNotifications, markRead, unreadCount } from "@/lib/notifications";
import type { Notification } from "@/lib/types";

export async function listNotifications(slug: string): Promise<Result<Notification[]>> {
  return guard(async () => {
    const { org, user } = await requireOrg(slug);
    return loadNotifications(org._id, user._id);
  });
}

export async function getUnreadCount(slug: string): Promise<Result<number>> {
  return guard(async () => {
    const { org, user } = await requireOrg(slug);
    return unreadCount(org._id, user._id);
  });
}

/** Marks the given notifications (or all of them) read for the signed-in person. */
export async function markNotificationsRead(slug: string, ids: string[] | "all"): Promise<Result> {
  return guard(async () => {
    const { org, user } = await requireOrg(slug);
    await markRead(org._id, user._id, ids === "all" ? "all" : ids.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id)));
  });
}
