/**
 * postMessage contract between the workspace and the snapshot iframe.
 *
 * Shared by both sides so the message shapes cannot drift.
 */
import type { Op } from "../ops/types";

/** Guards against reacting to unrelated messages on the window. */
export const PREVIEW_CHANNEL = "copy-updater/preview";

export interface DiffHighlights {
  changed: string[];
  added: string[];
  removed: string[];
  moved: string[];
  /** Blocks whose text grew enough to be worth checking on mobile. */
  layoutRisk: string[];
  /**
   * Unresolved comment count per block id.
   *
   * Kept separate from the change kinds rather than folded into them: a block
   * can be both edited and commented on, and a comment on otherwise-untouched
   * copy is the case most worth surfacing — there is nothing else on the page
   * to show it.
   */
  comments: Record<string, number>;
}

export type HostMessage =
  | { channel: typeof PREVIEW_CHANNEL; type: "applyOps"; ops: Op[] }
  | { channel: typeof PREVIEW_CHANNEL; type: "setDiffMode"; on: boolean; highlights: DiffHighlights | null }
  | { channel: typeof PREVIEW_CHANNEL; type: "setEditable"; on: boolean }
  | { channel: typeof PREVIEW_CHANNEL; type: "selectBlock"; id: string | null }
  | { channel: typeof PREVIEW_CHANNEL; type: "scrollToBlock"; id: string }
  | { channel: typeof PREVIEW_CHANNEL; type: "measure"; ids: string[] }
  /**
   * Read real markup back out of the page.
   *
   * The workspace holds a flat list of text blocks, not a tree, so it cannot
   * reconstruct the markup of anything larger than one block — and duplicating
   * a section means copying a subtree with all its wrappers, classes and
   * nesting intact. The frame has the actual DOM, so it is asked.
   *
   * `enclosing` walks up from the block to the container that holds the whole
   * run of them, which is what "this section" means to a reviewer.
   */
  | { channel: typeof PREVIEW_CHANNEL; type: "readMarkup"; requestId: string; id: string; enclosing: boolean };

export type FrameMessage =
  | { channel: typeof PREVIEW_CHANNEL; type: "ready" }
  | { channel: typeof PREVIEW_CHANNEL; type: "blockClicked"; id: string }
  | { channel: typeof PREVIEW_CHANNEL; type: "blockEdited"; id: string; html: string }
  | { channel: typeof PREVIEW_CHANNEL; type: "applied"; failures: { id: string; reason: string }[] }
  | { channel: typeof PREVIEW_CHANNEL; type: "measured"; boxes: Record<string, { x: number; y: number; w: number; h: number }> }
  /**
   * `anchorId` is the id of the element the markup was read from, which is
   * what a duplicate must be inserted after to land as its sibling. Every
   * element in a snapshot is stamped, not only the text blocks, so a section
   * container has one even though it is not a block.
   */
  | {
      channel: typeof PREVIEW_CHANNEL;
      type: "markup";
      requestId: string;
      html: string | null;
      anchorId: string | null;
    };

export function isFrameMessage(value: unknown): value is FrameMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { channel?: unknown }).channel === PREVIEW_CHANNEL
  );
}
