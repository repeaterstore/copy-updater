/**
 * Applying ops with a recorded inverse for each one.
 *
 * The preview replays a whole op list every time the list changes. The obvious
 * implementation — keep a pristine clone of the body and restore it before each
 * replay — silently destroys web components:
 *
 *   cloneNode() does not clone shadow roots, and a declarative shadow root
 *   (`<template shadowrootmode="open">`) is consumed by the parser, so it is not
 *   in the DOM to be cloned either. Restoring from a clone therefore drops every
 *   shadow root on the page. On waveform.com that silently deleted the gold star
 *   rating: it rendered on load, then disappeared the moment any edit applied.
 *
 * Recording an inverse per op instead means untouched DOM is never replaced, so
 * shadow roots, canvas state, and iframe content all survive.
 */
import { applyOps } from "./apply";
import { STYLE_ATTR, type ApplyResult, type Op, type OpFailure } from "./types";
import { cssEscape } from "./extract";
import { ID_ATTR } from "./types";

export type UndoEntry = () => void;

function findById(doc: Document, id: string): Element | null {
  if (id === "body") return doc.body;
  return doc.querySelector(`[${ID_ATTR}="${cssEscape(id)}"]`);
}

/**
 * Capture how to reverse `op`, given the document state before it runs.
 * Returns null when the op cannot be reversed, in which case it is not applied.
 */
function captureUndo(doc: Document, op: Op): UndoEntry | null {
  switch (op.t) {
    case "setText": {
      const el = findById(doc, op.id);
      if (!el) return null;
      const previous = el.innerHTML;
      return () => {
        el.innerHTML = previous;
      };
    }

    case "setMeta": {
      const title = doc.querySelector("title");
      const previousTitle = title?.textContent ?? null;
      const metas: [Element, string | null][] = [];
      for (const selector of [
        'meta[name="description" i]',
        'meta[property="og:title" i]',
        'meta[property="og:description" i]',
      ]) {
        const el = doc.querySelector(selector);
        if (el) metas.push([el, el.getAttribute("content")]);
      }
      return () => {
        if (title && previousTitle !== null) title.textContent = previousTitle;
        for (const [el, value] of metas) {
          if (value === null) el.removeAttribute("content");
          else el.setAttribute("content", value);
        }
      };
    }

    case "remove": {
      const el = findById(doc, op.id);
      if (!el) return null;
      const parent = el.parentNode;
      const next = el.nextSibling;
      if (!parent) return null;
      return () => {
        parent.insertBefore(el, next);
      };
    }

    case "move": {
      const el = findById(doc, op.id);
      if (!el) return null;
      const parent = el.parentNode;
      const next = el.nextSibling;
      if (!parent) return null;
      return () => {
        parent.insertBefore(el, next);
      };
    }

    case "setAttr": {
      const el = findById(doc, op.id);
      if (!el) return null;
      const had = el.hasAttribute(op.name);
      const previous = el.getAttribute(op.name);
      return () => {
        if (had && previous !== null) el.setAttribute(op.name, previous);
        else el.removeAttribute(op.name);
      };
    }

    // insert, replaceElement and addStyle add nodes, so their inverse depends on
    // what ends up in the DOM. Handled after the fact in applyWithUndo.
    case "insert":
    case "replaceElement":
    case "addStyle":
      return null;
  }
}

/** Nodes present under `parent` that were not there before. */
function newChildrenOf(parent: Node, before: Set<Node>): Node[] {
  return Array.from(parent.childNodes).filter((n) => !before.has(n));
}

export interface ApplyWithUndoResult extends ApplyResult {
  undo: UndoEntry[];
}

/**
 * Apply ops one at a time, recording how to reverse each.
 *
 * Run the returned entries in reverse order to restore the document.
 */
export function applyWithUndo(doc: Document, ops: Op[]): ApplyWithUndoResult {
  const undo: UndoEntry[] = [];
  const failures: OpFailure[] = [];
  let applied = 0;

  ops.forEach((op, index) => {
    // Node-adding ops: diff the parent's children around the apply so the
    // inverse can remove exactly what was introduced.
    if (op.t === "insert" || op.t === "replaceElement" || op.t === "addStyle") {
      const target =
        op.t === "addStyle"
          ? doc.head ?? doc.body
          : findById(doc, op.t === "insert" ? op.refId : op.id)?.parentNode ?? null;

      if (!target) {
        failures.push({ index, op, reason: `target for "${op.t}" not found` });
        return;
      }

      // For replaceElement the original node is removed, so keep a way back.
      const original = op.t === "replaceElement" ? findById(doc, op.id) : null;
      const originalNext = original?.nextSibling ?? null;

      const before = new Set(Array.from(target.childNodes));
      const result = applyOps(doc, [op]);
      if (result.failures.length) {
        failures.push({ ...result.failures[0], index });
        return;
      }

      const added = newChildrenOf(target, before);
      undo.push(() => {
        for (const node of added) node.parentNode?.removeChild(node);
        if (original) target.insertBefore(original, originalNext);
      });
      applied += 1;
      return;
    }

    const entry = captureUndo(doc, op);
    if (!entry) {
      failures.push({ index, op, reason: `could not resolve target for "${op.t}"` });
      return;
    }

    const result = applyOps(doc, [op]);
    if (result.failures.length) {
      failures.push({ ...result.failures[0], index });
      return;
    }

    undo.push(entry);
    applied += 1;
  });

  return { applied, failures, undo };
}

/** Reverse a recorded journal, most recent first. */
export function runUndo(journal: UndoEntry[]): void {
  for (let i = journal.length - 1; i >= 0; i -= 1) {
    try {
      journal[i]();
    } catch {
      // A node may already be detached; keep unwinding the rest.
    }
  }
}

/** Remove style elements contributed by addStyle ops. */
export function clearInjectedStyles(doc: Document): void {
  for (const el of Array.from(doc.querySelectorAll(`[${STYLE_ATTR}]`))) {
    el.remove();
  }
}
