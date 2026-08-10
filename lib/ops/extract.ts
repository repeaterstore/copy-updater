/**
 * Snapshot normalisation and block extraction.
 *
 * Isomorphic: only standard DOM APIs, so this runs inside the Playwright page
 * at capture time, inside the preview iframe, and under jsdom on the server.
 */
import {
  ID_ATTR,
  WRAP_ATTR,
  STYLE_ATTR,
  type Block,
  type BlockRole,
  type PageMeta,
} from "./types";

/** Tags that may appear inside a single editable block without splitting it. */
const INLINE_TAGS = new Set([
  "A", "ABBR", "B", "BDI", "BDO", "BR", "CITE", "CODE", "DATA", "DFN", "EM",
  "I", "IMG", "KBD", "MARK", "PICTURE", "Q", "RP", "RT", "RUBY", "S", "SAMP",
  "SMALL", "SPAN", "STRONG", "SUB", "SUP", "TIME", "U", "VAR", "WBR",
]);

/** Never descended into, never treated as copy. */
const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "VIDEO",
  "AUDIO", "IFRAME", "OBJECT", "EMBED", "SELECT", "TEXTAREA", "HEAD",
]);

const ROLE_BY_TAG: Record<string, BlockRole> = {
  H1: "heading", H2: "heading", H3: "heading", H4: "heading",
  H5: "heading", H6: "heading",
  P: "paragraph",
  A: "link",
  BUTTON: "button",
  LI: "listitem",
  BLOCKQUOTE: "quote", Q: "quote",
  LABEL: "label",
};

function roleFor(el: Element): BlockRole {
  const tag = el.tagName.toUpperCase();
  if (ROLE_BY_TAG[tag]) return ROLE_BY_TAG[tag];
  // Anchors and buttons styled as CTAs are common; catch role="button" too.
  const role = el.getAttribute("role");
  if (role === "button") return "button";
  if (role === "heading") return "heading";
  return "other";
}

/**
 * True when the element's entire subtree is inline markup, so its innerHTML can
 * be edited as one field without destroying nested structure.
 */
export function isBlockCandidate(el: Element): boolean {
  const tag = el.tagName.toUpperCase();
  if (SKIP_TAGS.has(tag)) return false;
  if (!el.textContent || el.textContent.trim() === "") return false;
  for (const desc of Array.from(el.getElementsByTagName("*"))) {
    if (!INLINE_TAGS.has(desc.tagName.toUpperCase())) return false;
  }
  return true;
}

/**
 * Structural path used as a block's stable id: `body/div:2/section:3/h1:1`,
 * where the number is the 1-based index among same-tag siblings.
 *
 * Deterministic, so re-capturing an unchanged page yields identical ids — the
 * basis for re-anchoring a newer snapshot onto existing versions.
 *
 * The separator is "/" rather than ">" so ids stay safe to embed in HTML
 * attributes, CSS attribute selectors and regexes without escaping.
 */
export function structuralPath(el: Element): string {
  const segments: string[] = [];
  let node: Element | null = el;
  while (node && node.tagName.toUpperCase() !== "BODY") {
    const parent: Element | null = node.parentElement;
    if (!parent) break;
    const tag = node.tagName.toLowerCase();
    let index = 0;
    for (const sib of Array.from(parent.children)) {
      if (sib.tagName.toLowerCase() === tag) {
        index += 1;
        if (sib === node) break;
      }
    }
    segments.unshift(`${tag}:${index}`);
    node = parent;
  }
  return ["body", ...segments].join("/");
}

/**
 * Normalise the document then stamp every element with a stable id.
 *
 * Loose text nodes in mixed-content containers get wrapped in an inline span so
 * they become addressable blocks; without this, text like the "text" in
 * `<div>text<div>nested</div></div>` would be uneditable, and editing the outer
 * div would blow away the nested one.
 *
 * Runs exactly once, at capture. Ids are opaque afterwards — later inserts
 * shift structural paths but must never renumber existing ids.
 */
export function stampIds(doc: Document): void {
  const body = doc.body;
  if (!body) return;

  // Pass 1: collect loose text nodes needing a wrapper. Wrapping in an inline
  // span is layout-neutral and does not change any ancestor's candidacy.
  const toWrap: Text[] = [];
  const walker = doc.createTreeWalker(body, 4 /* SHOW_TEXT */);
  let current = walker.nextNode();
  while (current) {
    const textNode = current as Text;
    const parent = textNode.parentElement;
    if (
      parent &&
      textNode.nodeValue &&
      textNode.nodeValue.trim() !== "" &&
      !SKIP_TAGS.has(parent.tagName.toUpperCase()) &&
      !isBlockCandidate(parent)
    ) {
      toWrap.push(textNode);
    }
    current = walker.nextNode();
  }
  for (const textNode of toWrap) {
    const span = doc.createElement("span");
    span.setAttribute(WRAP_ATTR, "");
    textNode.parentNode?.replaceChild(span, textNode);
    span.appendChild(textNode);
  }

  // Pass 2: assign ids. Existing ids win so this is safe to re-run.
  for (const el of Array.from(body.querySelectorAll("*"))) {
    if (!el.hasAttribute(ID_ATTR)) {
      el.setAttribute(ID_ATTR, structuralPath(el));
    }
  }
  if (!body.hasAttribute(ID_ATTR)) body.setAttribute(ID_ATTR, "body");
}

export interface ExtractOptions {
  /** Measure bounding boxes. Only meaningful in a real browser. */
  measure?: boolean;
}

/**
 * Walk the document and emit the editable blocks in document order.
 */
export function extractBlocks(
  doc: Document,
  options: ExtractOptions = {},
): Block[] {
  const body = doc.body;
  if (!body) return [];

  const blocks: Block[] = [];
  let sectionLabel: string | null = null;
  let order = 0;

  const visit = (el: Element): void => {
    const tag = el.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag)) return;
    if (el.hasAttribute(STYLE_ATTR)) return;

    if (isBlockCandidate(el)) {
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text !== "") {
        const role = roleFor(el);
        // A heading names its own section. Assigning before the push (rather
        // than after) stops each heading being filed under the previous one,
        // which put the hero H1 under whatever mega-menu heading happened to
        // come earlier in the DOM.
        if (role === "heading") sectionLabel = text;
        let box = null;
        if (options.measure && typeof (el as HTMLElement).getBoundingClientRect === "function") {
          const r = (el as HTMLElement).getBoundingClientRect();
          box = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
        }
        blocks.push({
          id: el.getAttribute(ID_ATTR) ?? structuralPath(el),
          tag: el.tagName.toLowerCase(),
          role,
          html: el.innerHTML,
          text,
          order: order++,
          sectionLabel,
          classes: Array.from(el.classList ?? []),
          box,
        });
      }
      // A candidate is a leaf for our purposes: never descend into it.
      return;
    }

    for (const child of Array.from(el.children)) visit(child);
  };

  for (const child of Array.from(body.children)) visit(child);
  return blocks;
}

function metaContent(doc: Document, selector: string): string | null {
  const el = doc.querySelector(selector);
  const value = el?.getAttribute("content") ?? null;
  return value && value.trim() !== "" ? value : null;
}

export function extractMeta(doc: Document): PageMeta {
  const title = doc.querySelector("title")?.textContent ?? null;
  return {
    title: title && title.trim() !== "" ? title : null,
    description: metaContent(doc, 'meta[name="description" i]'),
    ogTitle: metaContent(doc, 'meta[property="og:title" i]'),
    ogDescription: metaContent(doc, 'meta[property="og:description" i]'),
    canonical: doc.querySelector('link[rel="canonical" i]')?.getAttribute("href") ?? null,
  };
}

/**
 * Map each block to the class names on it and its ancestors, so AI prompts can
 * show which of the site's existing design-system classes are in play and reuse
 * them rather than inventing new ones.
 */
export function buildCssIndex(doc: Document, blocks: Block[]): Record<string, string[]> {
  const index: Record<string, string[]> = {};
  for (const block of blocks) {
    const el = doc.querySelector(`[${ID_ATTR}="${cssEscape(block.id)}"]`);
    if (!el) continue;
    const classes = new Set<string>();
    let node: Element | null = el;
    let depth = 0;
    while (node && depth < 4) {
      for (const c of Array.from(node.classList ?? [])) classes.add(c);
      node = node.parentElement;
      depth += 1;
    }
    index[block.id] = Array.from(classes).slice(0, 24);
  }
  return index;
}

/** Escape a value for use inside an attribute selector. */
export function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
