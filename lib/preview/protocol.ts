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
  /**
   * Still on the page while the diff is on, so it can be seen and put back —
   * the host holds `remove` ops back rather than applying them.
   */
  removed: string[];
  moved: string[];
  /** Recoloured, reclassed or hidden on one device: changed without rewording. */
  restyled: string[];
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
  /**
   * Which responsive-visibility convention this page's own CSS defines.
   *
   * Reported by the frame because only the frame has the stylesheets: the
   * skeleton the server works from has them stripped out, and the snapshot is
   * megabytes of inlined CSS that nothing else needs to parse.
   */
  | { channel: typeof PREVIEW_CHANNEL; type: "responsive"; recipeId: string | null }
  | { channel: typeof PREVIEW_CHANNEL; type: "blockClicked"; id: string }
  | { channel: typeof PREVIEW_CHANNEL; type: "blockEdited"; id: string; html: string }
  /**
   * Enter was pressed inside a block: it becomes two.
   *
   * A paragraph break is a structural change, not a character. Left to the
   * browser, Enter inside a contenteditable `<p>` injects a `<div>` or a `<br>`
   * into it, and that markup is what gets saved — a paragraph containing
   * paragraphs, which is neither valid nor editable afterwards. The frame does
   * the split against the real DOM, where the caret is; the host turns it into
   * the two ops that describe it.
   */
  | {
      channel: typeof PREVIEW_CHANNEL;
      type: "blockSplit";
      id: string;
      /** What stays in the original block, as inner markup. */
      before: string;
      /**
       * What moves into the new block, also as inner markup.
       *
       * Inner, not a complete element: the host knows the block's tag and its
       * current classes — including any this version has already changed — and
       * building the sibling in one place keeps the two editors from disagreeing
       * about what a new block is made of.
       */
      after: string;
    }
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
