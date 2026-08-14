/**
 * Finding the container a block's section lives in, and copying it cleanly.
 *
 * Isomorphic: standard DOM only, so the same rule runs inside the preview
 * iframe (duplicating a section) and under jsdom on the server (showing a model
 * the markup it should imitate). Two implementations of "which element is the
 * section" would drift, and the two callers would then disagree about what the
 * reviewer just pointed at.
 */
import { ID_ATTR } from "./types";

/** Attributes the tool puts on the page, which must never be copied. */
const TOOL_ATTRS = [
  ID_ATTR,
  "data-cu-diff",
  "data-cu-comment",
  "data-cu-selected",
  "contenteditable",
  "spellcheck",
];

/**
 * The container holding the whole run of copy a block belongs to.
 *
 * Walks up from the block and stops at the first ancestor that has stopped
 * being a section and started being the page. Two signals say so: an explicit
 * `<section>` or `<article>`, which is the author telling us directly; and an
 * ancestor holding more than one heading, which means it now spans several
 * sections rather than one.
 *
 * `body` is never the answer. A page whose sections are undifferentiated divs
 * would otherwise return the whole document, and "duplicate this section" would
 * duplicate the site.
 */
export function enclosingSection(el: Element): Element {
  const doc = el.ownerDocument;
  // Asked about `<body>` itself there is nothing above it worth returning, and
  // walking up would reach `<html>` — a "section" containing the entire page.
  if (el === doc.body || el === doc.documentElement) return el;

  let best: Element = el;
  let node: Element | null = el.parentElement;

  while (node && node !== doc.body) {
    // Checked before adopting the ancestor, so the element that spans several
    // sections is rejected and the one below it — this section — is kept.
    if (node.querySelectorAll("h1, h2, h3, h4, h5, h6").length > 1 && best !== el) break;
    best = node;
    const tag = node.tagName.toUpperCase();
    if (tag === "SECTION" || tag === "ARTICLE") break;
    node = node.parentElement;
  }
  return best;
}

/**
 * A copy of an element with the tool's own attributes taken off.
 *
 * The live DOM carries what the runtime put there — ids, diff badges, the
 * selection outline, contenteditable. Copying those would put a second element
 * on the page answering to an id that already exists, which is the collision
 * every other path takes care to avoid. Fresh ids are minted by the caller,
 * once this markup becomes an op.
 */
export function cleanMarkup(el: Element): string {
  return stripped(el).outerHTML;
}

/**
 * The same, for content that is about to be wrapped in a new element.
 *
 * Splitting a block moves part of it into a new one, and the part that moves
 * routinely contains stamped inline markup — the `<span>` a phrase sits in.
 * Carried over as-is, the new block would hold a second element answering to
 * an id that already exists further up the page.
 */
export function cleanInnerMarkup(el: Element): string {
  return stripped(el).innerHTML;
}

function stripped(el: Element): Element {
  const clone = el.cloneNode(true) as Element;
  for (const node of [clone, ...Array.from(clone.querySelectorAll("*"))]) {
    for (const attr of TOOL_ATTRS) node.removeAttribute(attr);
  }
  return clone;
}
