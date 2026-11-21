import Image from "@tiptap/extension-image";

/** Bubbling DOM event an image's expand button dispatches; the editor that owns it opens the lightbox. */
export const EXPAND_IMAGE_EVENT = "aimpoint:expand-image";
/** The image's document position and the expand button that was pressed (focus goes back to it on close). */
export type ExpandImageDetail = { pos: number; button: HTMLButtonElement };

// lucide `maximize-2`, inlined: the node view is plain DOM (no React render per image).
const MAXIMIZE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/><path d="M9 21H3v-6"/></svg>';

const IMG_ATTRS = ["src", "alt", "title", "width", "height"] as const;

/**
 * Tiptap's Image with a node view that overlays an expand button on the image's bottom-right corner
 * (VEC-334). Only the editor's DOM gets the button: saved HTML/Markdown still come from the Image node's
 * renderHTML, so the stored description is unchanged. Events inside the button are kept away from
 * ProseMirror (no selection, drag or caret move); everything on the <img> still goes to ProseMirror, so
 * selecting, dragging and deleting images work as before. The selected-node class goes on the <img>
 * (globals.css draws the VEC-244 ring there).
 */
export function expandableImage() {
  return Image.extend({
    addNodeView() {
      const extra = this.options.HTMLAttributes as Record<string, unknown>;
      return ({ node: initial, getPos }) => {
        let node = initial;
        const dom = document.createElement("div");
        dom.className = "aimpoint-image";
        const img = document.createElement("img");
        const setAttrs = () => {
          for (const [k, v] of Object.entries(extra)) if (v != null) img.setAttribute(k, String(v));
          for (const k of IMG_ATTRS) {
            const v = node.attrs[k];
            if (v == null || v === "") img.removeAttribute(k);
            else img.setAttribute(k, String(v));
          }
        };
        setAttrs();

        const button = document.createElement("button");
        button.type = "button";
        button.className = "aimpoint-image-expand";
        button.contentEditable = "false";
        button.setAttribute("aria-label", "Expand image");
        button.title = "Expand image";
        button.innerHTML = MAXIMIZE_SVG;
        // Keep the editor's selection and focus where they are; the lightbox returns focus to this button.
        button.addEventListener("mousedown", (e) => e.preventDefault());
        button.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const pos = getPos();
          if (typeof pos !== "number") return;
          button.dispatchEvent(new CustomEvent<ExpandImageDetail>(EXPAND_IMAGE_EVENT, { bubbles: true, detail: { pos, button } }));
        });
        dom.append(img, button);

        return {
          dom,
          update(next) {
            if (next.type !== node.type) return false;
            node = next;
            setAttrs();
            return true;
          },
          selectNode() {
            img.classList.add("ProseMirror-selectednode");
            dom.dataset.selected = "";
          },
          deselectNode() {
            img.classList.remove("ProseMirror-selectednode");
            delete dom.dataset.selected;
          },
          stopEvent(event) {
            return event.target instanceof Node && button.contains(event.target);
          },
          // The view owns this DOM; nothing inside it maps back to document content.
          ignoreMutation: () => true,
        };
      };
    },
  });
}
