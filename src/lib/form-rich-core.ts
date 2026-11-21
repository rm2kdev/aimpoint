/**
 * Rich-text descriptions on public surfaces (VEC-234). Moved into the task intake core (VEC-356,
 * lib/task-intake-core.ts); this module only keeps the old names for existing imports until VEC-358 removes them.
 */
export {
  publicSanitize,
  stripMarkdownImages,
  htmlText,
  imageSources,
  prepareRichDescription,
  PUBLIC_LINK_REL,
  DESCRIPTION_HTML_MAX as FORM_HTML_MAX,
  DESCRIPTION_IMAGES_MAX as FORM_IMAGES_MAX,
  type PublicSanitizeOptions,
  type RichPrep,
} from "./task-intake-core";
