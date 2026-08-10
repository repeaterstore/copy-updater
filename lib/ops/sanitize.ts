/**
 * HTML sanitiser for content arriving from AI output or the inline editor.
 *
 * Deliberately permissive: arbitrary tags, classes and inline styles are the
 * point of layout mode. It strips only what could execute or exfiltrate —
 * scripts, event handlers, and javascript:/data: URLs in navigable attributes.
 *
 * Isomorphic: takes the Document it should parse against, so the same code runs
 * under jsdom on the server and natively inside the preview iframe.
 */

const FORBIDDEN_TAGS = new Set([
  "SCRIPT",
  "NOSCRIPT",
  "OBJECT",
  "EMBED",
  "APPLET",
  "BASE",
  "META",
  "TITLE",
  "LINK",
  "FORM",
]);

const URL_ATTRS = new Set(["href", "src", "action", "formaction", "xlink:href"]);

/**
 * Editor and diff state that must never be persisted into a version.
 *
 * The inline editor reads `innerHTML` straight off the live DOM, which by then
 * carries the attributes the preview runtime added. Without this, saved copy
 * ships `contenteditable="true"` on every nested element and diff markers leak
 * into the export.
 */
const EDITOR_ATTRS = new Set([
  "contenteditable",
  "spellcheck",
  "data-cu-diff",
  "data-cu-selected",
]);

/** Schemes permitted in navigable attributes. Everything else is dropped. */
const SAFE_SCHEME = /^(https?:|mailto:|tel:|#|\/|\.\/|\.\.\/)/i;

function isSafeUrl(value: string): boolean {
  const v = value.trim();
  if (v === "") return true;
  // data: URIs are allowed for images only, and the snapshot is full of them.
  if (/^data:image\//i.test(v)) return true;
  return SAFE_SCHEME.test(v);
}

function scrubElement(el: Element): void {
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (name.startsWith("on") || EDITOR_ATTRS.has(name)) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (URL_ATTRS.has(name) && !isSafeUrl(attr.value)) {
      el.removeAttribute(attr.name);
      continue;
    }
    // srcset can smuggle a javascript: candidate past the href check.
    if (name === "srcset") {
      const safe = attr.value
        .split(",")
        .map((c) => c.trim())
        .filter((c) => c !== "" && isSafeUrl(c.split(/\s+/)[0]));
      if (safe.length === 0) el.removeAttribute(attr.name);
      else el.setAttribute(attr.name, safe.join(", "));
    }
  }
}

function scrubTree(root: ParentNode): void {
  for (const el of Array.from(root.querySelectorAll("*"))) {
    if (FORBIDDEN_TAGS.has(el.tagName.toUpperCase())) {
      el.remove();
      continue;
    }
    scrubElement(el);
  }
}

/**
 * Sanitise an HTML fragment. Returns the cleaned markup.
 */
export function sanitizeHtml(doc: Document, html: string): string {
  const tpl = doc.createElement("template");
  tpl.innerHTML = html;
  scrubTree(tpl.content);
  return tpl.innerHTML;
}

/**
 * Parse a sanitised fragment into nodes ready for insertion.
 */
export function parseFragment(doc: Document, html: string): DocumentFragment {
  const tpl = doc.createElement("template");
  tpl.innerHTML = html;
  scrubTree(tpl.content);
  return tpl.content;
}

/**
 * CSS from addStyle ops. Blocks the two constructs that can pull in or execute
 * remote content from a stylesheet; everything else is allowed.
 */
export function sanitizeCss(css: string): string {
  return css
    .replace(/@import[^;]*;/gi, "")
    .replace(/expression\s*\(/gi, "(")
    .replace(/javascript\s*:/gi, "");
}
