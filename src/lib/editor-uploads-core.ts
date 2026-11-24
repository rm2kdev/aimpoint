/**
 * Editor images that show at once (VEC-455, part of VEC-452). Pure string helpers over the HTML a `RichEditor` emits,
 * tested in `editor-uploads.test.mjs`; the browser side is `components/editor-uploads.ts`.
 *
 * While an image uploads, the editor shows it from a local `blob:` preview. A `blob:` URL means nothing outside this
 * tab, so no save path may send one: `resolvePreviewImages` swaps each preview for its stored URL and drops any
 * preview image that has none (failed, or unknown to this tab), so the saved text never carries a broken image.
 */

export type PreviewLookup = (preview: string) => string | null;

const IMG_TAG = /<img\b[^>]*>/gi;
const SRC_ATTR = /\ssrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

const srcOf = (tag: string) => {
  const m = SRC_ATTR.exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4] ?? "") : null;
};

export const isPreviewUrl = (src: string | null | undefined): boolean => !!src && /^blob:/i.test(src.trim());

/** The `blob:` preview URLs of the images in `html`, in order, without repeats. */
export function previewImages(html: string): string[] {
  const out: string[] = [];
  for (const tag of html.match(IMG_TAG) ?? []) {
    const src = srcOf(tag);
    if (src && isPreviewUrl(src) && !out.includes(src)) out.push(src);
  }
  return out;
}

export const hasPreviewImages = (html: string | null | undefined) => !!html && previewImages(html).length > 0;

/**
 * `html` with each preview image's `src` replaced by `lookup(preview)`; preview images with no stored URL are
 * removed (with the empty paragraph they leave behind). Non-preview images are untouched.
 */
export function resolvePreviewImages(html: string, lookup: PreviewLookup): string {
  if (!hasPreviewImages(html)) return html;
  const out = html.replace(IMG_TAG, (tag) => {
    const src = srcOf(tag);
    if (!src || !isPreviewUrl(src)) return tag;
    const url = lookup(src);
    if (!url || isPreviewUrl(url)) return "";
    return tag.replace(SRC_ATTR, () => ` src="${url.replace(/"/g, "&quot;")}"`);
  });
  // An image that was last leaves the empty paragraph the editor put after it.
  return out === html ? out : out.replace(/(?:<p>\s*<\/p>\s*)+$/, "");
}

/** `html` without its preview images: what can be saved before any upload has finished. */
export const withoutPreviewImages = (html: string) => resolvePreviewImages(html, () => null);
