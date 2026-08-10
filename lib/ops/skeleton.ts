/**
 * Reduces a captured document to a skeleton: identical structure, ids and text,
 * with none of the weight.
 *
 * Two jobs:
 *
 *  1. Size. A snapshot is megabytes of inlined CSS, fonts and data: URIs. The
 *     ops engine reads none of it, and parsing that on every diff or export
 *     would cost seconds per request.
 *
 *  2. Making the result safe for jsdom. jsdom eagerly parses `style` attributes
 *     when a document is constructed, and its CSS shorthand handling throws on
 *     values real sites genuinely use. Renaming the attribute keeps the
 *     information without ever handing it to that parser.
 *
 * Isomorphic: runs natively in the capture page and under jsdom in tests.
 */
export const STYLE_ATTR_BACKUP = "data-cu-style-attr";

export function stripToSkeleton(doc: Document): void {
  for (const el of Array.from(doc.querySelectorAll("style, script, link, noscript"))) {
    el.remove();
  }

  for (const el of Array.from(doc.querySelectorAll("*"))) {
    const style = el.getAttribute("style");
    if (style !== null) {
      el.removeAttribute("style");
      el.setAttribute(STYLE_ATTR_BACKUP, style);
    }

    for (const attr of ["src", "srcset", "href", "poster"]) {
      const value = el.getAttribute(attr);
      if (value && value.startsWith("data:")) {
        el.setAttribute(attr, "data:stripped");
      }
    }
  }
}

/** Serialise a document that has already been reduced. */
export function serializeSkeleton(doc: Document): string {
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}
