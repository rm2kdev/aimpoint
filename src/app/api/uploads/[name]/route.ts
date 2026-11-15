import { ObjectId } from "mongodb";
import { requireOrgById, currentUser } from "@/lib/session";
import { cols } from "@/lib/db";
import { AVATAR_NAME, readLocalImage } from "@/lib/storage";

const notFound = () => new Response("Not found", { status: 404 });

/** Profile pictures: readable by their owner and by anyone who shares an organisation with them. */
async function canReadAvatar(ownerId: string): Promise<boolean> {
  const user = await currentUser();
  if (!user) return false;
  if (user._id.toHexString() === ownerId) return true;
  const c = await cols();
  const mine = await c.memberships.find({ userId: user._id }, { projection: { orgId: 1 } }).toArray();
  if (!mine.length) return false;
  const shared = await c.memberships.findOne({ userId: new ObjectId(ownerId), orgId: { $in: mine.map((m) => m.orgId) } }, { projection: { _id: 1 } });
  return !!shared;
}

/** Serves locally stored uploads (development driver). Only members of the owning org can read them. */
export async function GET(_: Request, ctx: RouteContext<"/api/uploads/[name]">) {
  const { name } = await ctx.params;
  const avatarOwner = name.match(AVATAR_NAME)?.[1];
  if (avatarOwner) {
    if (!(await canReadAvatar(avatarOwner))) return notFound();
  } else {
    try {
      await requireOrgById(name.slice(0, 24));
    } catch {
      return notFound();
    }
  }
  const img = await readLocalImage(name);
  if (!img) return notFound();
  return new Response(new Uint8Array(img.data), {
    headers: { "Content-Type": img.type, "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" },
  });
}
