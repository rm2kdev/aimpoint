import { requireOrgById } from "@/lib/session";
import { readLocalImage } from "@/lib/storage";

/** Serves locally stored uploads (development driver). Only members of the owning org can read them. */
export async function GET(_: Request, ctx: RouteContext<"/api/uploads/[name]">) {
  const { name } = await ctx.params;
  try {
    await requireOrgById(name.slice(0, 24));
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const img = await readLocalImage(name);
  if (!img) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(img.data), {
    headers: { "Content-Type": img.type, "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" },
  });
}
