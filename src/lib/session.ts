import "server-only";
import { cache } from "react";
import { redirect, notFound } from "next/navigation";
import { ObjectId } from "mongodb";
import { auth } from "@/auth";
import { cols } from "@/lib/db";
import type { MembershipDoc, OrgDoc, UserDoc } from "@/lib/types";

export class AuthError extends Error {}

/** Current signed-in user (or null). Cached per request. */
export const currentUser = cache(async (): Promise<UserDoc | null> => {
  const session = await auth();
  const id = session?.user?.id;
  if (!id || !ObjectId.isValid(id)) return null;
  const { users } = await cols();
  return users.findOne({ _id: new ObjectId(id) });
});

export async function requireUser(): Promise<UserDoc> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

export interface OrgContext {
  user: UserDoc;
  org: OrgDoc;
  membership: MembershipDoc;
  isAdmin: boolean;
}

/** For pages: resolves org by slug and verifies membership, else 404/redirect. */
export const requireOrgPage = cache(async (slug: string): Promise<OrgContext> => {
  const user = await requireUser();
  const ctx = await orgFor(user, slug);
  if (!ctx) notFound();
  return ctx;
});

/** For actions / route handlers: throws instead of redirecting. */
export async function requireOrg(slug: string, opts: { admin?: boolean } = {}): Promise<OrgContext> {
  const user = await currentUser();
  if (!user) throw new AuthError("You are signed out. Sign in and try again.");
  const ctx = await orgFor(user, slug);
  if (!ctx) throw new AuthError("You are not a member of this organisation.");
  if (opts.admin && !ctx.isAdmin) throw new AuthError("Only admins can do that.");
  return ctx;
}

export async function requireOrgById(orgId: string): Promise<OrgContext> {
  const user = await currentUser();
  if (!user) throw new AuthError("Signed out");
  if (!ObjectId.isValid(orgId)) throw new AuthError("Unknown organisation");
  const { orgs, memberships } = await cols();
  const org = await orgs.findOne({ _id: new ObjectId(orgId) });
  if (!org) throw new AuthError("Unknown organisation");
  const membership = await memberships.findOne({ orgId: org._id, userId: user._id });
  if (!membership) throw new AuthError("Not a member");
  return { user, org, membership, isAdmin: membership.role === "admin" };
}

async function orgFor(user: UserDoc, slug: string): Promise<OrgContext | null> {
  const { orgs, memberships } = await cols();
  const org = await orgs.findOne({ slug });
  if (!org) return null;
  const membership = await memberships.findOne({ orgId: org._id, userId: user._id });
  if (!membership) return null;
  return { user, org, membership, isAdmin: membership.role === "admin" };
}
