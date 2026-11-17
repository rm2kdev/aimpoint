import { NextResponse } from "next/server";
import { clientIp } from "@/lib/form-submit";
import { uploadFormImage } from "@/lib/form-uploads";

/**
 * Public image upload for external forms (VEC-233). No session: anyone with the form's link may post, when the form
 * has images on. Multipart with the image in `file`; the body is capped before it is read (lib/form-uploads.ts).
 *   200 {url}  400 not an image / bad request  403 images off, or org unpaid/locked (VEC-224/262)
 *   404 unknown/disabled form  413 too large  429 rate limited (Retry-After)
 * The URL is all it returns: no ids or anything about the org. The image stays pending until a submission uses it.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(req: Request, ctx: RouteContext<"/api/forms/[publicId]/uploads">) {
  const { publicId } = await ctx.params;
  const r = await uploadFormImage(publicId, req, clientIp(req.headers));
  const headers: Record<string, string> = { ...NO_STORE };
  if (!r.ok && r.retryAfter) headers["Retry-After"] = String(r.retryAfter);
  return NextResponse.json(r.ok ? { url: r.url } : { error: r.error }, { status: r.status, headers });
}

export function GET() {
  return NextResponse.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
}
