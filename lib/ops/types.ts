/**
 * Pure types and constants for the ops engine.
 *
 * Deliberately free of zod (or any runtime dependency beyond plain constants):
 * this module is imported by the capture stamper and the preview runtime, which
 * are bundled into every stored snapshot. Pulling a validation library in here
 * added ~330 KB to each one. Runtime validation lives in `schema.ts`.
 */

/**
 * Attribute carrying a block's stable identity inside a snapshot.
 * Every element in <body> gets one so that structural ops can reference
 * containers, not just the text-bearing elements surfaced as blocks.
 */
export const ID_ATTR = "data-cu-id";
/** Marks spans we introduced to wrap loose text nodes. See stampIds(). */
export const WRAP_ATTR = "data-cu-wrap";
/** Marks <style> elements contributed by addStyle ops. */
export const STYLE_ATTR = "data-cu-style";

export const BLOCK_ROLES = [
  "heading",
  "paragraph",
  "link",
  "button",
  "listitem",
  "quote",
  "label",
  /**
   * A picture, which is copy in the sense that matters here: someone has to be
   * able to point at it and say it is the wrong one. The image itself is the
   * designer's job — what this tool owns is the note attached to it and the alt
   * text, which is the only wording an image carries.
   */
  "image",
  "other",
] as const;
export type BlockRole = (typeof BLOCK_ROLES)[number];

export interface BlockBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Block {
  /** data-cu-id: structural path, or `new:<nanoid>` for inserted elements. */
  id: string;
  tag: string;
  role: BlockRole;
  /**
   * An image's alt text, which is the only wording a picture carries.
   *
   * Kept on the block because a bare `<img>` is a void element: its innerHTML
   * is empty, so there is nowhere else for the inspector to read it back from.
   */
  alt?: string;
  /** Inline HTML content of the element (its innerHTML). */
  html: string;
  /** Flattened text, used for diffing and AI context. */
  text: string;
  /** Document order within the resolved state. */
  order: number;
  /** Nearest preceding heading, for grouping in the outline. */
  sectionLabel: string | null;
  classes: string[];
  /** Viewport rect at capture time; used to crop screenshots for AI vision. */
  box: BlockBox | null;
}

export interface PageMeta {
  title: string | null;
  description: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  canonical: string | null;
}

export const EMPTY_META: PageMeta = {
  title: null,
  description: null,
  ogTitle: null,
  ogDescription: null,
  canonical: null,
};

/** The materialised result of applying an op list to a snapshot. */
/**
 * Which build of the extractor produced a stored `resolved`.
 *
 * `resolved` is derived data cached on the row, and a version keeps whatever
 * the extractor produced on its last save — potentially for months. Change what
 * counts as a block and the two sides of a diff stop agreeing: making images
 * blocks meant a freshly-resolved snapshot had 81 the stored version did not,
 * so every image on the page read as removed copy in versions nobody had
 * touched.
 *
 * Bump this whenever extraction changes what it emits. Anything stamped with an
 * older number is rebuilt at start-up, so the fix needs no manual step and no
 * one has to remember this paragraph exists.
 */
export const EXTRACTOR_VERSION = 2;

export interface Resolved {
  blocks: Block[];
  meta: PageMeta;
  /** CSS contributed by addStyle ops, in application order. */
  styles: string[];
  /** EXTRACTOR_VERSION at the time this was produced; absent means ancient. */
  v?: number;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export type InsertPosition = "before" | "after" | "firstChild" | "lastChild";

export interface SetTextOp {
  t: "setText";
  id: string;
  html: string;
}

export interface SetMetaOp {
  t: "setMeta";
  title?: string | null;
  description?: string | null;
  ogTitle?: string | null;
  ogDescription?: string | null;
}

export interface InsertOp {
  t: "insert";
  refId: string;
  pos: InsertPosition;
  html: string;
}

export interface RemoveOp {
  t: "remove";
  id: string;
}

export interface MoveOp {
  t: "move";
  id: string;
  refId: string;
  pos: InsertPosition;
}

export interface ReplaceElementOp {
  t: "replaceElement";
  id: string;
  html: string;
}

export interface SetAttrOp {
  t: "setAttr";
  id: string;
  name: string;
  /** null removes the attribute. */
  value: string | null;
}

export interface AddStyleOp {
  t: "addStyle";
  css: string;
}

export type Op =
  | SetTextOp
  | SetMetaOp
  | InsertOp
  | RemoveOp
  | MoveOp
  | ReplaceElementOp
  | SetAttrOp
  | AddStyleOp;

export type OpType = Op["t"];

/** Ops a copy-mode AI request is permitted to emit. */
export const COPY_MODE_OPS: OpType[] = ["setText", "setMeta"];
/** Ops a layout-mode AI request is permitted to emit. */
export const LAYOUT_MODE_OPS: OpType[] = [
  "setText",
  "setMeta",
  "insert",
  "remove",
  "move",
  "replaceElement",
  "setAttr",
  "addStyle",
];

/** Reported when an op could not be applied, rather than silently dropped. */
export interface OpFailure {
  index: number;
  op: Op;
  reason: string;
}

export interface ApplyResult {
  applied: number;
  failures: OpFailure[];
}
