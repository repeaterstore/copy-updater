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
import { extractBlocks, extractMeta } from "./extract";
import { serializeSkeleton, stripToSkeleton } from "./skeleton";
import type { Op, OpFailure, Resolved } from "./types";

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
