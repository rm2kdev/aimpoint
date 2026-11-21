import { NextResponse } from "next/server";
import { clientIp } from "@/lib/form-submit";
import { uploadPublicProjectImage } from "@/lib/project-public";
import { currentUser } from "@/lib/session";

/**
 * Image upload for a public project's submit form (VEC-356). Needs a signed-in Aimpoint account (any, membership not
 * needed). Multipart with the image in `file`; the body is capped before it is read (lib/form-uploads.ts).
 *   200 {url}  400 not an image / bad request  401 signed out  403 org unpaid/locked
 *   404 unknown or non-public project  413 too large  429 rate limited (Retry-After)
 * The URL is all it returns. The image stays pending until the same account's submission to this project uses it.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(req: Request, ctx: RouteContext<"/api/public/[org]/[key]/uploads">) {
  const p = await ctx.params;
  const r = await uploadPublicProjectImage(await currentUser(), p.org, p.key, req, clientIp(req.headers));
  const headers: Record<string, string> = { ...NO_STORE };
  if (!r.ok && "retryAfter" in r && r.retryAfter) headers["Retry-After"] = String(r.retryAfter);
  return NextResponse.json(r.ok ? { url: r.url } : { error: r.error }, { status: r.status, headers });
}
