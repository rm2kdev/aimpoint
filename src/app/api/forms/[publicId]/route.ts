import { NextResponse } from "next/server";
import { clientIp, FORM_BODY_MAX, submitPublicForm, type RawSubmission } from "@/lib/form-submit";

/**
 * Public submission endpoint for external forms (VEC-207). No session: anyone with the form's link may post.
 * Takes JSON (the form page's fetch) or a plain urlencoded/multipart form post (no JavaScript, or someone's own
 * HTML form), caps the body at FORM_BODY_MAX, and answers with a short message only:
 *   200 {ok:true}  400 bad input  403 unavailable (org on the Free plan, VEC-224)  404 unknown/disabled form  413 too large
 *   429 rate limited (Retry-After).
 * A plain form post is redirected back to the page (303) with `?sent=1` or `?error=<message>`.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

async function readBody(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > FORM_BODY_MAX) return null;
  if (!req.body) return "";
  // Read at most FORM_BODY_MAX bytes even when content-length is missing or wrong (chunked uploads).
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > FORM_BODY_MAX) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function parse(type: string, body: string): RawSubmission | null {
  if (type.includes("application/json")) {
    try {
      const v = JSON.parse(body || "{}");
      return v && typeof v === "object" && !Array.isArray(v) ? (v as RawSubmission) : null;
    } catch {
      return null;
    }
  }
  if (type.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(body));
  return null;
}

export async function POST(req: Request, ctx: RouteContext<"/api/forms/[publicId]">) {
  const { publicId } = await ctx.params;
  const type = req.headers.get("content-type") ?? "";
  const plainPost = !type.includes("application/json");
  let raw: RawSubmission | null;
  if (type.includes("multipart/form-data")) {
    const declared = Number(req.headers.get("content-length") ?? "");
    if (!Number.isFinite(declared) || declared > FORM_BODY_MAX) raw = null;
    else {
      const fd = await req.formData().catch(() => null);
      raw = fd ? Object.fromEntries([...fd.entries()].map(([k, v]) => [k, typeof v === "string" ? v : null])) : null;
    }
    if (raw === null) return reply(req, publicId, plainPost, { ok: false, status: 413, error: "That's too much to send in one go. Shorten the description and try again." });
  } else {
    const body = await readBody(req);
    if (body === null) return reply(req, publicId, plainPost, { ok: false, status: 413, error: "That's too much to send in one go. Shorten the description and try again." });
    raw = parse(type, body);
  }
  if (!raw) return reply(req, publicId, plainPost, { ok: false, status: 400, error: "Send the form as JSON or a regular form post." });
  const result = await submitPublicForm(publicId, raw, clientIp(req.headers));
  return reply(req, publicId, plainPost, result);
}

function reply(req: Request, publicId: string, plainPost: boolean, r: Awaited<ReturnType<typeof submitPublicForm>>) {
  const headers: Record<string, string> = { ...NO_STORE };
  if (!r.ok && r.retryAfter) headers["Retry-After"] = String(r.retryAfter);
  if (plainPost && r.status !== 404) {
    const url = new URL(`/f/${encodeURIComponent(publicId)}`, req.url);
    if (r.ok) url.searchParams.set("sent", "1");
    // A code, not the message: the page maps it to its own text, so a crafted link can't put words on the page.
    else url.searchParams.set("error", r.status === 429 ? "rate" : r.status === 413 ? "size" : r.status === 403 ? "unavailable" : "input");
    return NextResponse.redirect(url, { status: 303, headers });
  }
  return NextResponse.json(r.ok ? { ok: true } : { ok: false, error: r.error }, { status: r.status, headers });
}

export function GET() {
  return NextResponse.json({ ok: false, error: "Not found." }, { status: 404, headers: NO_STORE });
}
