/**
 * Routing a comment to whoever has to act on it.
 *
 * A copywriter reviewing a page notices things that are not copy: the wrong
 * photo, a button that reads as disabled, two headings the same size. Those are
 * not edits this tool can make — the deliverable for them is a note to the
 * designer — and left mixed in with the copy comments they are found only by
 * someone reading every version of every page.
 *
 * Written as a tag inside the comment rather than a field beside it, because
 * that is how people already write them and because it survives being copied
 * into Slack or a ticket. `@design` anywhere in the body is enough.
 */
export const DESIGN_TAG = "@design";

/**
 * `@designer` counts; `hello@design.com` does not, and neither does
 * `@design-system` — a word boundary is satisfied by a hyphen, so `\b` alone
 * put every mention of a design system into the designer's queue and then
 * displayed it mangled as "-system".
 */
const DESIGN_PATTERN = /(^|[^\w@.])@design(er)?(?![\w-])/i;

export function isForDesigner(body: string): boolean {
  return DESIGN_PATTERN.test(body);
}

/**
 * The comment with its tag taken out, for display in a list that is already
 * entirely design notes. Collapses the space the tag leaves behind.
 */
export function withoutDesignTag(body: string): string {
  return body.replace(/(^|[^\w@.])@design(er)?(?![\w-])/gi, "$1").replace(/\s{2,}/g, " ").trim();
}
