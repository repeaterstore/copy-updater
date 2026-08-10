/**
 * Applies an op list to a Document.
 *
 * Isomorphic: standard DOM APIs only, so the same code drives the preview
 * iframe in the browser and jsdom on the server when materialising a version's
 * resolved state.
 *
 * Ops that cannot be applied are reported in the result rather than dropped, so
 * a version built against a stale snapshot fails loudly.
 */
import { parseFragment, sanitizeCss } from "./sanitize";
import { cssEscape } from "./extract";
import {
  ID_ATTR,
  STYLE_ATTR,
  type ApplyResult,
  type InsertPosition,
  type Op,
  type OpFailure,
} from "./types";

function findById(doc: Document, id: string): Element | null {
  if (id === "body") return doc.body;
  return doc.querySelector(`[${ID_ATTR}="${cssEscape(id)}"]`);
}

function place(target: Element, node: Node, pos: InsertPosition): void {
  switch (pos) {
    case "before":
      target.parentNode?.insertBefore(node, target);
      break;
    case "after":
      target.parentNode?.insertBefore(node, target.nextSibling);
      break;
    case "firstChild":
      target.insertBefore(node, target.firstChild);
      break;
    case "lastChild":
      target.appendChild(node);
      break;
  }
}

function upsertMeta(
  doc: Document,
  selector: string,
  create: () => Element,
  value: string,
): void {
  let el = doc.querySelector(selector);
  if (!el) {
    el = create();
    doc.head?.appendChild(el);
  }
  el.setAttribute("content", value);
}

function applyOne(doc: Document, op: Op): string | null {
  switch (op.t) {
    case "setText": {
      const el = findById(doc, op.id);
      if (!el) return `no element with id "${op.id}"`;
      const frag = parseFragment(doc, op.html);
      el.replaceChildren(frag);
      return null;
    }

    case "setMeta": {
      if (typeof op.title === "string") {
        let titleEl = doc.querySelector("title");
        if (!titleEl) {
          titleEl = doc.createElement("title");
          doc.head?.appendChild(titleEl);
        }
        titleEl.textContent = op.title;
      }
      if (typeof op.description === "string") {
        upsertMeta(doc, 'meta[name="description" i]', () => {
          const m = doc.createElement("meta");
          m.setAttribute("name", "description");
          return m;
        }, op.description);
      }
      if (typeof op.ogTitle === "string") {
        upsertMeta(doc, 'meta[property="og:title" i]', () => {
          const m = doc.createElement("meta");
          m.setAttribute("property", "og:title");
          return m;
        }, op.ogTitle);
      }
      if (typeof op.ogDescription === "string") {
        upsertMeta(doc, 'meta[property="og:description" i]', () => {
          const m = doc.createElement("meta");
          m.setAttribute("property", "og:description");
          return m;
        }, op.ogDescription);
      }
      return null;
    }

    case "insert": {
      const ref = findById(doc, op.refId);
      if (!ref) return `no reference element with id "${op.refId}"`;
      if ((op.pos === "before" || op.pos === "after") && !ref.parentNode) {
        return `reference "${op.refId}" has no parent to insert alongside`;
      }
      place(ref, parseFragment(doc, op.html), op.pos);
      return null;
    }

    case "remove": {
      const el = findById(doc, op.id);
      if (!el) return `no element with id "${op.id}"`;
      el.remove();
      return null;
    }

    case "move": {
      const el = findById(doc, op.id);
      if (!el) return `no element with id "${op.id}"`;
      const ref = findById(doc, op.refId);
      if (!ref) return `no reference element with id "${op.refId}"`;
      if (el === ref) return "cannot move an element relative to itself";
      if (el.contains(ref)) return `"${op.refId}" is inside "${op.id}"`;
      place(ref, el, op.pos);
      return null;
    }

    case "replaceElement": {
      const el = findById(doc, op.id);
      if (!el) return `no element with id "${op.id}"`;
      if (!el.parentNode) return `"${op.id}" has no parent`;
      el.parentNode.replaceChild(parseFragment(doc, op.html), el);
      return null;
    }

    case "setAttr": {
      const el = findById(doc, op.id);
      if (!el) return `no element with id "${op.id}"`;
      const name = op.name.toLowerCase();
      // Never let an op rewrite identity or smuggle in a handler.
      if (name === ID_ATTR || name.startsWith("on")) {
        return `attribute "${op.name}" is not writable`;
      }
      if (op.value === null) el.removeAttribute(op.name);
      else el.setAttribute(op.name, op.value);
      return null;
    }

    case "addStyle": {
      const style = doc.createElement("style");
      style.setAttribute(STYLE_ATTR, "");
      style.textContent = sanitizeCss(op.css);
      (doc.head ?? doc.body)?.appendChild(style);
      return null;
    }
  }
}

export function applyOps(doc: Document, ops: Op[]): ApplyResult {
  const failures: OpFailure[] = [];
  let applied = 0;

  ops.forEach((op, index) => {
    try {
      const reason = applyOne(doc, op);
      if (reason) failures.push({ index, op, reason });
      else applied += 1;
    } catch (error) {
      failures.push({
        index,
        op,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return { applied, failures };
}

/** CSS contributed by addStyle ops, in order. */
export function collectStyles(ops: Op[]): string[] {
  return ops.filter((op) => op.t === "addStyle").map((op) => sanitizeCss(op.css));
}
