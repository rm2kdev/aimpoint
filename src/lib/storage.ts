import "server-only";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { put } from "@vercel/blob";
import { nanoid } from "nanoid";

/**
 * Image storage adapter.
 *  - "blob": Vercel Blob when BLOB_READ_WRITE_TOKEN is set (Vercel / production)
 *  - "local": files under .data/uploads, served by /api/uploads/[name]
 */
export const storageDriver: "blob" | "local" = process.env.BLOB_READ_WRITE_TOKEN ? "blob" : "local";

export const IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
};
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const LOCAL_DIR = path.join(process.cwd(), ".data", "uploads");

export async function saveImage(orgId: string, file: File): Promise<string> {
  const ext = IMAGE_TYPES[file.type];
  if (!ext) throw new Error("Only PNG, JPEG, GIF, WebP or AVIF images can be uploaded.");
  if (file.size > MAX_IMAGE_BYTES) throw new Error("Images must be 10 MB or smaller.");
  const name = `${orgId}-${nanoid(16)}.${ext}`;

  if (storageDriver === "blob") {
    const blob = await put(`uploads/${name}`, file, { access: "public", contentType: file.type, addRandomSuffix: false });
    return blob.url;
  }
  await mkdir(LOCAL_DIR, { recursive: true });
  await writeFile(path.join(LOCAL_DIR, name), Buffer.from(await file.arrayBuffer()));
  return `/api/uploads/${name}`;
}

const SAFE_NAME = /^[a-f0-9]{24}-[A-Za-z0-9_-]{16}\.(png|jpg|gif|webp|avif)$/;

export async function readLocalImage(name: string): Promise<{ data: Buffer; type: string } | null> {
  if (!SAFE_NAME.test(name)) return null;
  try {
    const data = await readFile(path.join(LOCAL_DIR, name));
    const ext = name.split(".").pop()!;
    const type = Object.entries(IMAGE_TYPES).find(([, e]) => e === ext)?.[0] ?? "application/octet-stream";
    return { data, type };
  } catch {
    return null;
  }
}
