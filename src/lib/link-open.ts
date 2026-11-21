// AIM-6: when a link inside a rich-text editor opens, and which links may open at all.
// Pure (no DOM), so `node --test` covers it; rich-editor.tsx wires it into the editor's events.

/** Schemes a click may navigate to. Everything else (javascript:, data:, vbscript:, file:, ...) never opens. */
export const OPENABLE_PROTOCOLS = ["http:", "https:", "mailto:"] as const;

/**
 * The absolute URL to open for an `href`, or null when it must not navigate.
 * Relative hrefs resolve against `base` (the page URL). Parsed with WHATWG URL, the same parser the
 * browser uses, so tab/newline/case tricks like "java\tscript:" or " JavaScript:" are caught.
 */
export function openableHref(href: string | null | undefined, base?: string): string | null {
  if (typeof href !== "string") return null;
  const raw = href.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }
  return (OPENABLE_PROTOCOLS as readonly string[]).includes(url.protocol) ? url.href : null;
}

export type LinkPointer = {
  /** MouseEvent.button: 0 primary, 1 middle. */
  button: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
};

/**
 * What a pointer press/click on a link should do:
 * - "open": we open it in a new tab (editable editor + Cmd/Ctrl or middle button),
 * - "native": leave it to the browser (read-only editor: the anchor has target=_blank + rel),
 * - "edit": let the editor place the caret (plain click in an editable editor),
 * - "ignore": anything else (right click, other buttons).
 * `editable` must be read at event time (view.editable): the editor's editability changes at runtime.
 */
export function linkClickAction(editable: boolean, e: LinkPointer): "open" | "native" | "edit" | "ignore" {
  if (e.button !== 0 && e.button !== 1) return "ignore";
  if (!editable) return "native";
  if (e.button === 1 || e.metaKey || e.ctrlKey) return "open";
  return "edit";
}

/** Apple keyboards open with Cmd; everything else with Ctrl. */
export function isApplePlatform(platform: string | undefined, userAgent?: string): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(platform || userAgent || "");
}

/** Tooltip on links in an editable editor. */
export function openLinkHint(apple: boolean): string {
  return `${apple ? "⌘" : "Ctrl"}-click to open link`;
}
