/**
 * Runs inside the Playwright page at capture time.
 *
 * Normalises the DOM and stamps stable ids *before* SingleFile inlines the
 * page, so the ids are baked into the stored snapshot. Extraction happens here
 * because bounding boxes only exist in a real browser, and the skeleton is
 * built here because the browser parses real-world CSS correctly where jsdom
 * throws on it.
 */
import {
  buildCssIndex,
  extractBlocks,
  extractMeta,
  stampIds,
} from "../ops/extract";
import { serializeSkeleton, stripToSkeleton } from "../ops/skeleton";
import type { Block, PageMeta } from "../ops/types";

export interface CaptureExtraction {
  blocks: Block[];
  meta: PageMeta;
  cssIndex: Record<string, string[]>;
}

declare global {
  interface Window {
    __copyUpdaterCapture: () => CaptureExtraction;
    __copyUpdaterSkeleton: () => string;
    __copyUpdaterStripScripts: () => number;
  }
}

window.__copyUpdaterCapture = function capture(): CaptureExtraction {
  stampIds(document);
  const blocks = extractBlocks(document, { measure: true });
  return {
    blocks,
    meta: extractMeta(document),
    cssIndex: buildCssIndex(document, blocks),
  };
};

/**
 * Build the skeleton from a detached clone so the live page — which SingleFile
 * is about to serialise — is left untouched.
 */
window.__copyUpdaterSkeleton = function skeleton(): string {
  const clone = document.cloneNode(true) as Document;
  stripToSkeleton(clone);
  return serializeSkeleton(clone);
};

/**
 * Remove every script element before SingleFile serialises the page.
 *
 * Doing it here rather than post-hoc keeps SingleFile from embedding its own
 * ~900 KB bundle (which we injected as a script tag) into the output, and stops
 * the site's own JavaScript from shipping inside the snapshot, where a
 * framework rehydrating would rebuild the DOM and destroy the stamped ids.
 *
 * Removing a script element does not undefine what it already declared, so the
 * `singlefile` global survives.
 */
window.__copyUpdaterStripScripts = function stripScripts(): number {
  let removed = 0;

  // querySelectorAll does not descend into template content or shadow roots, so
  // a flat sweep leaves scripts behind in exactly the places modern sites keep
  // their widgets. Those then run inside the preview.
  const sweep = (root: ParentNode): void => {
    for (const script of Array.from(root.querySelectorAll("script"))) {
      script.remove();
      removed += 1;
    }
    for (const template of Array.from(root.querySelectorAll("template"))) {
      sweep((template as HTMLTemplateElement).content);
    }
    for (const el of Array.from(root.querySelectorAll("*"))) {
      const shadow = (el as Element).shadowRoot;
      if (shadow) sweep(shadow);
    }
  };

  sweep(document);
  return removed;
};
