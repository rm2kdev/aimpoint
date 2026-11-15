import { revalidatePath } from "next/cache";
import type { ObjectId } from "mongodb";
import { currentUser } from "@/lib/session";
import { cols } from "@/lib/db";
import { publish } from "@/lib/realtime/server";
import { deleteAvatar, saveAvatar } from "@/lib/storage";
import { ACCOUNT_PATH } from "@/lib/paths";

/*
 * The signed-in user's profile picture. A route handler rather than a server action: server actions cap
 * request bodies at 2 MB, which a 2 MB picture plus multipart overhead would hit with an unreadable error.
 *   POST   multipart `file`  -> { image }   upload or replace (the old file is deleted)
 *   DELETE                    -> { image: null }   remove, falling back to initials
 */

const fail = (error: string, status: number) => Response.json({ error }, { status });

/** Point the user at `image` and tell every org they're in, so open clients re-render their avatar. */
async function setImage(userId: ObjectId, image: string | null) {
  const c = await cols();
  const before = await c.users.findOneAndUpdate({ _id: userId }, { $set: { image } }, { projection: { image: 1 } });
  if (before?.image && before.image !== image) await deleteAvatar(before.image);
  const memberships = await c.memberships.find({ userId }, { projection: { orgId: 1 } }).toArray();
  const actorId = userId.toHexString();
  await Promise.all(memberships.map((m) => publish(m.orgId.toHexString(), { type: "org.changed", actorId })));
  revalidatePath(ACCOUNT_PATH);
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return fail("You are signed out. Sign in and try again.", 401);
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return fail("Choose an image to upload.", 400);
  let image: string;
  try {
    image = await saveAvatar(user._id.toHexString(), file);
  } catch (err) {
    return fail((err as Error).message, 400);
  }
  try {
    await setImage(user._id, image);
  } catch {
    await deleteAvatar(image);
    return fail("Couldn't save your picture. Try again.", 500);
  }
  return Response.json({ image });
}

export async function DELETE() {
  const user = await currentUser();
  if (!user) return fail("You are signed out. Sign in and try again.", 401);
  await setImage(user._id, null);
  return Response.json({ image: null });
}
