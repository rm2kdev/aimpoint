import { publicImageName } from "@/lib/project-public";
import { readLocalImage } from "@/lib/storage";

const notFound = () => new Response("Not found", { status: 404 });

/**
 * Images of a public project's tasks (VEC-255), for anyone. `name` is the stored name without its org prefix. Only
 * local uploads of the project's org that a non-archived task of the (public, available) project references are
 * served; everything else answers 404, so nothing about private projects, other orgs' files or avatars can be read.
 */
export async function GET(_: Request, ctx: RouteContext<"/api/public/[org]/[key]/uploads/[name]">) {
  const p = await ctx.params;
  const name = await publicImageName(p.org, p.key, p.name);
  if (!name) return notFound();
  const img = await readLocalImage(name);
  if (!img) return notFound();
  return new Response(new Uint8Array(img.data), {
    headers: { "Content-Type": img.type, "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" },
  });
}
