// Renders the PWA / home-screen PNG icons from src/app/icon.svg (VEC-153).
// Run: node scripts/pwa-icons.mjs   (re-run after changing icon.svg)
//
// Outputs (PNGs go in the public root, not public/icons: a /icons/... URL hits the legacy /:org redirect in next.config.ts):
//   public/icon-192.png, icon-512.png   "any" icons (the rounded tile as drawn in icon.svg)
//   public/icon-maskable-512.png        full-bleed tile, glyph scaled into the 80% safe zone
//   src/app/apple-icon.png                    180x180, full-bleed and opaque (iOS masks it itself, ignores SVG)
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// sharp ships with Next (image optimisation); resolve it from next's own install.
const require = createRequire(join(root, "package.json"));
const sharp = require(require.resolve("sharp", { paths: [dirname(require.resolve("next/package.json"))] }));

const svg = readFileSync(join(root, "src/app/icon.svg"), "utf8");
const TILE = "#171717";

// Pull the glyph (everything after the tile <rect>) out of icon.svg so the variants stay in step with it.
const inner = svg.replace(/^[\s\S]*?<rect[^>]*\/>/, "").replace(/<\/svg>\s*$/, "");
const fullBleed = (scale) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="${TILE}"/>` +
  `<g transform="translate(12 12) scale(${scale}) translate(-12 -12)">${inner}</g></svg>`;

const out = [
  { file: "public/icon-192.png", src: svg, size: 192 },
  { file: "public/icon-512.png", src: svg, size: 512 },
  // Maskable: safe zone is a centred circle of radius 40%; the glyph reaches 10.35 of the 12 half-size (top-right dot), so 0.78 keeps it at ~8.1 < 9.6.
  { file: "public/icon-maskable-512.png", src: fullBleed(0.78), size: 512 },
  { file: "src/app/apple-icon.png", src: fullBleed(1), size: 180, opaque: true },
];

for (const { file, src, size, opaque } of out) {
  let img = sharp(Buffer.from(src), { density: (72 * size) / 24 }).resize(size, size);
  if (opaque) img = img.flatten({ background: TILE }).removeAlpha();
  await img.png().toFile(join(root, file));
  console.log("wrote", file);
}
