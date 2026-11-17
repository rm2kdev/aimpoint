import "server-only";
import { cache } from "react";
import { redirect, notFound } from "next/navigation";
import { cookies, headers } from "next/headers";
import { decode } from "next-auth/jwt";
import { ObjectId } from "mongodb";
import { auth } from "@/auth";
import { cols } from "@/lib/db";
import type { MembershipDoc, OrgDoc, UserDoc } from "@/lib/types";

export class AuthError extends Error {}

/** Current signed-in user (or null). Cached per request. */
export const currentUser = cache(async (): Promise<UserDoc | null> => {
  const session = await auth();
  const id = session?.user?.id ?? (await reissuedSessionUserId());
  if (!id || !ObjectId.isValid(id)) return null;
  const { users } = await cols();
  return users.findOne({ _id: new ObjectId(id) });
});

const SESSION_COOKIES = ["__Secure-authjs.session-token", "authjs.session-token"];

/**
 * A server action that revokes sessions (revokeSessions in lib/security.ts) re-issues the acting session's
 * cookie, and Next then re-renders the page in the same request. `auth()` reads the request's Cookie
 * header, which still holds the pre-revoke token, so without this the page would redirect to /login and
 * the user would be bounced away mid-flow. `cookies()` reflects the re-issued value: when it differs from
 * the header, validate it the same way the jwt callback does (decrypt + current sessionVersion).
 */
async function reissuedSessionUserId(): Promise<string | null> {
  const [jar, hdrs] = await Promise.all([cookies(), headers()]);
  const raw = hdrs.get("cookie") ?? "";
  for (const name of SESSION_COOKIES) {
    const value = jar.get(name)?.value;
    if (!value || raw.includes(`${name}=${value}`)) continue;
    const secret = process.env.AUTH_SECRET;
    if (!secret) return null;
    const token = await decode({ token: value, secret, salt: name }).catch(() => null);
    const uid = token?.uid;
    if (typeof uid !== "string" || !ObjectId.isValid(uid)) return null;
    const { users } = await cols();
    const u = await users.findOne({ _id: new ObjectId(uid) }, { projection: { sessionVersion: 1 } });
    return u && (token?.sv ?? 0) === (u.sessionVersion ?? 0) ? uid : null;
  }
  return null;
}

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

export interface RequireOrgOptions {
  admin?: boolean;
  /**
   * VEC-263: by default a locked org (hosted, no live subscription) is refused with OrgLockedError (a UserError, so
   * guard() shows the lock message and REST answers 402). Only the paths a locked org must keep (Settings > Billing,
   * the debug billing switch, your own notifications) pass `locked: "allow"`.
   */
  locked?: "allow";
}

/** Refuses a locked org (VEC-263). Imported lazily: lib/billing -> lib/result -> this module is an import cycle. */
async function assertActive(ctx: OrgContext, opts: RequireOrgOptions) {
  if (opts.locked === "allow") return;
  const { assertOrgActive, billingOn } = await import("@/lib/billing");
  await billingOn();
  assertOrgActive(ctx.org, { isAdmin: ctx.isAdmin });
}

/** For actions / route handlers: throws instead of redirecting. */
export async function requireOrg(slug: string, opts: RequireOrgOptions = {}): Promise<OrgContext> {
  const user = await currentUser();
  if (!user) throw new AuthError("You are signed out. Sign in and try again.");
  const ctx = await orgFor(user, slug);
  if (!ctx) throw new AuthError("You are not a member of this organisation.");
  if (opts.admin && !ctx.isAdmin) throw new AuthError("Only admins can do that.");
  await assertActive(ctx, opts);
  return ctx;
}

export async function requireOrgById(orgId: string, opts: RequireOrgOptions = {}): Promise<OrgContext> {
  const user = await currentUser();
  if (!user) throw new AuthError("Signed out");
  if (!ObjectId.isValid(orgId)) throw new AuthError("Unknown organisation");
  const { orgs, memberships } = await cols();
  const org = await orgs.findOne({ _id: new ObjectId(orgId) });
  if (!org) throw new AuthError("Unknown organisation");
  const membership = await memberships.findOne({ orgId: org._id, userId: user._id });
  if (!membership) throw new AuthError("Not a member");
  const ctx = { user, org, membership, isAdmin: membership.role === "admin" };
  if (opts.admin && !ctx.isAdmin) throw new AuthError("Only admins can do that.");
  await assertActive(ctx, opts);
  return ctx;
}

async function orgFor(user: UserDoc, slug: string): Promise<OrgContext | null> {
  const { orgs, memberships } = await cols();
  const org = await orgs.findOne({ slug });
  if (!org) return null;
  const membership = await memberships.findOne({ orgId: org._id, userId: user._id });
  if (!membership) return null;
  return { user, org, membership, isAdmin: membership.role === "admin" };
}
