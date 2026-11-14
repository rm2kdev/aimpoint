import { requireOrg } from "@/lib/session";
import { saveImage } from "@/lib/storage";

export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  const slug = String(form?.get("org") ?? "");
  if (!(file instanceof File)) return Response.json({ error: "Attach an image file." }, { status: 400 });
  let orgId: string;
  try {
    orgId = (await requireOrg(slug)).org._id.toHexString();
  } catch {
    return Response.json({ error: "You don't have access to this organisation." }, { status: 403 });
  }
  try {
    const url = await saveImage(orgId, file);
    return Response.json({ url });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
