/**
 * Server-side materialisation of a version's resolved state.
 *
 * Runs against the snapshot *skeleton* rather than the full inlined snapshot.
 * The skeleton is the same DOM — identical structure, ids and text — with the
 * megabytes of inlined CSS, fonts and data: URIs stripped out. Parsing the full
 * snapshot in jsdom on every diff or export would cost seconds and hundreds of
 * MB per request; the skeleton parses in milliseconds and carries everything
 * the ops engine actually reads.
 */
import { JSDOM } from "jsdom";
import { applyOps, collectStyles } from "./apply";
import { cssEscape, extractBlocks, extractMeta } from "./extract";
import { enclosingSection } from "./section-scope";
import { serializeSkeleton, stripToSkeleton } from "./skeleton";
import { EXTRACTOR_VERSION, ID_ATTR, type Op, type OpFailure, type Resolved } from "./types";

export interface ResolveResult {
  resolved: Resolved;
  failures: OpFailure[];
}

/**
 * Apply an op list to a snapshot skeleton and extract the resulting state.
 */
export function resolveVersion(skeletonHtml: string, ops: Op[]): ResolveResult {
  const dom = new JSDOM(skeletonHtml);
  const doc = dom.window.document;

  const { failures } = applyOps(doc, ops);

  const resolved: Resolved = {
    blocks: extractBlocks(doc),
    meta: extractMeta(doc),
    styles: collectStyles(ops),
    v: EXTRACTOR_VERSION,
  };

  dom.window.close();
  return { resolved, failures };
}

/**
 * Reduce full snapshot HTML to a skeleton on the server.
 *
 * Capture builds the skeleton in the browser instead, where CSS parsing is
 * native and correct. This exists for tests and for re-deriving a skeleton from
 * an already-stored snapshot, and is only safe on markup jsdom can parse.
 */
export function buildSkeleton(fullHtml: string): string {
  const dom = new JSDOM(fullHtml);
  stripToSkeleton(dom.window.document);
  const html = serializeSkeleton(dom.window.document);
  dom.window.close();
  return html;
}

/**
 * The real markup around a set of blocks, for a model that has to write more of
 * the same.
 *
 * Asking a model to add a section without this is asking it to invent a design
 * system: it sees the copy and a list of class names, but not how they nest, so
 * what comes back is plausible markup that belongs to no particular page. Shown
 * the actual container — wrappers, grid classes, the shape of one card — it can
 * copy the pattern instead of guessing at it.
 *
 * The container is found the same way the preview finds it for duplication:
 * walk up until an ancestor holds more than one heading, which means it has
 * stopped being this section and started being the page.
 */
export function sectionMarkupFor(
  skeletonHtml: string,
  ops: Op[],
  blockIds: string[],
  limit = 12_000,
): string | null {
  if (blockIds.length === 0) return null;
  const dom = new JSDOM(skeletonHtml);
  const doc = dom.window.document;
  try {
    applyOps(doc, ops);

    const first = doc.querySelector(`[${ID_ATTR}="${cssEscape(blockIds[0])}"]`);
    if (!first) return null;

    const best = enclosingSection(first);

    // Truncated rather than dropped: half the markup still shows the nesting
    // and the class names, which is what it is for.
    const html = best.outerHTML;
    return html.length > limit ? `${html.slice(0, limit)}\n<!-- truncated -->` : html;
  } finally {
    dom.window.close();
  }
}
