import "server-only";
import { mkdir, writeFile, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { del, list, put } from "@vercel/blob";
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

/* ---- profile pictures (user-level, not tied to one org) ---- */

export const AVATAR_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
/** `avatar-<userId>-<random>.<ext>`: the user id says who may read it, the random part makes it unguessable. */
export const AVATAR_NAME = /^avatar-([a-f0-9]{24})-[A-Za-z0-9_-]{21}\.(png|jpg|gif|webp)$/;

/** The real type from the file's first bytes; the browser-supplied MIME type alone can't be trusted. */
function sniffImageType(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

/** Validates (type by MIME and content, size) and stores a profile picture. Throws a readable Error. */
export async function saveAvatar(userId: string, file: File): Promise<string> {
  if (!AVATAR_TYPES[file.type]) throw new Error("Use a PNG, JPEG, WebP or GIF image.");
  if (file.size > MAX_AVATAR_BYTES) throw new Error("Pictures must be 2 MB or smaller.");
  if (file.size === 0) throw new Error("That file is empty.");
  const data = Buffer.from(await file.arrayBuffer());
  const type = sniffImageType(data);
  if (!type || !AVATAR_TYPES[type]) throw new Error("That file isn't a PNG, JPEG, WebP or GIF image.");
  const name = `avatar-${userId}-${nanoid(21)}.${AVATAR_TYPES[type]}`;

  if (storageDriver === "blob") {
    const blob = await put(`avatars/${name}`, data, { access: "public", contentType: type, addRandomSuffix: false });
    return blob.url;
  }
  await mkdir(LOCAL_DIR, { recursive: true });
  await writeFile(path.join(LOCAL_DIR, name), data);
  return `/api/uploads/${name}`;
}

/** Deletes a stored profile picture (best effort: a missing file is fine). Only touches avatar files. */
export async function deleteAvatar(url: string | null | undefined): Promise<void> {
  if (!url) return;
  try {
    const local = url.match(/^\/api\/uploads\/([^/?#]+)$/)?.[1];
    if (local) {
      if (AVATAR_NAME.test(local)) await unlink(path.join(LOCAL_DIR, local));
      return;
    }
    if (storageDriver === "blob" && /\/avatars\/avatar-[a-f0-9]{24}-/.test(url)) await del(url);
  } catch {
    // already gone
  }
}

/** Deletes every task/comment image uploaded to an organisation (`<orgId>-…` files). Best effort. */
export async function deleteOrgImages(orgId: string): Promise<void> {
  if (!/^[a-f0-9]{24}$/.test(orgId)) return;
  try {
    if (storageDriver === "blob") {
      let cursor: string | undefined;
      do {
        const page = await list({ prefix: `uploads/${orgId}-`, cursor });
        if (page.blobs.length) await del(page.blobs.map((b) => b.url));
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return;
    }
    const names = await readdir(LOCAL_DIR).catch(() => [] as string[]);
    await Promise.all(names.filter((n) => n.startsWith(`${orgId}-`) && SAFE_NAME.test(n)).map((n) => unlink(path.join(LOCAL_DIR, n)).catch(() => {})));
  } catch {
    // leftovers are unreachable anyway: /api/uploads checks membership of the org in the name
  }
}

export async function readLocalImage(name: string): Promise<{ data: Buffer; type: string } | null> {
  if (!SAFE_NAME.test(name) && !AVATAR_NAME.test(name)) return null;
  try {
    const data = await readFile(path.join(LOCAL_DIR, name));
    const ext = name.split(".").pop()!;
    const type = Object.entries(IMAGE_TYPES).find(([, e]) => e === ext)?.[0] ?? "application/octet-stream";
    return { data, type };
  } catch {
    return null;
  }
}
