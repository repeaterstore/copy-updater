/**
 * Diffing two resolved states.
 *
 * Structure is diffed as a sequence of block ids (catching inserts, removals
 * and reorders), then text is diffed word-by-word within the blocks that exist
 * on both sides. Doing it against the materialised state rather than against
 * the op lists is what makes "compare any two versions" work regardless of how
 * either one was authored.
 */
import { diffArrays, diffWords } from "diff";
import type { Block, PageMeta, Resolved } from "./types";

export type ChangeKind = "added" | "removed" | "changed" | "moved" | "unchanged";

export interface WordPart {
  value: string;
  added?: boolean;
  removed?: boolean;
}

export interface BlockChange {
  id: string;
  kind: ChangeKind;
  before: Block | null;
  after: Block | null;
  /** Word-level diff of the plain text. Present when kind is "changed". */
  words: WordPart[] | null;
  /** after.text.length / before.text.length. Present when both sides exist. */
  growth: number | null;
  /** Set when the block also moved position. */
  alsoMoved: boolean;
}

export interface MetaChange {
  field: keyof PageMeta;
  before: string | null;
  after: string | null;
  words: WordPart[] | null;
}

export interface ResolvedDiff {
  blocks: BlockChange[];
  meta: MetaChange[];
  stylesAdded: string[];
  counts: Record<Exclude<ChangeKind, "unchanged">, number> & { total: number };
  /** Ids whose text grew enough to be worth eyeballing on mobile. */
  layoutRisk: string[];
}

/** Growth ratio past which a block is flagged for a layout check. */
export const LAYOUT_RISK_RATIO = 1.3;

function words(before: string, after: string): WordPart[] {
  return diffWords(before, after).map((part) => ({
    value: part.value,
    added: part.added || undefined,
    removed: part.removed || undefined,
  }));
}

export function diffResolved(a: Resolved, b: Resolved): ResolvedDiff {
  const beforeById = new Map(a.blocks.map((x) => [x.id, x]));
  const afterById = new Map(b.blocks.map((x) => [x.id, x]));
  const idsA = a.blocks.map((x) => x.id);
  const idsB = b.blocks.map((x) => x.id);

  // A reorder shows up as a remove plus an add of the same id. Ids present on
  // both sides but appearing in a changed run therefore mean "moved", not
  // "added"/"removed" — without this, moving a section reads as deleting and
  // recreating it.
  const movedIds = new Set<string>();
  const addedIds = new Set<string>();
  const removedIds = new Set<string>();

  for (const part of diffArrays(idsA, idsB)) {
    if (!part.added && !part.removed) continue;
    for (const id of part.value) {
      const inA = beforeById.has(id);
      const inB = afterById.has(id);
      if (inA && inB) movedIds.add(id);
      else if (part.added) addedIds.add(id);
      else removedIds.add(id);
    }
  }

  const changes: BlockChange[] = [];

  for (const block of a.blocks) {
    if (!afterById.has(block.id)) {
      changes.push({
        id: block.id,
        kind: "removed",
        before: block,
        after: null,
        words: null,
        growth: null,
        alsoMoved: false,
      });
    }
  }

  for (const after of b.blocks) {
    const before = beforeById.get(after.id);
    if (!before) {
      changes.push({
        id: after.id,
        kind: "added",
        before: null,
        after,
        words: null,
        growth: null,
        alsoMoved: false,
      });
      continue;
    }
    const textChanged = before.text !== after.text;
    const htmlChanged = before.html !== after.html;
    const moved = movedIds.has(after.id);
    const growth =
      before.text.length > 0 ? after.text.length / before.text.length : null;

    if (!textChanged && !htmlChanged && !moved) {
      changes.push({
        id: after.id,
        kind: "unchanged",
        before,
        after,
        words: null,
        growth,
        alsoMoved: false,
      });
      continue;
    }

    changes.push({
      id: after.id,
      kind: textChanged || htmlChanged ? "changed" : "moved",
      before,
      after,
      words: textChanged ? words(before.text, after.text) : null,
      growth,
      alsoMoved: moved && (textChanged || htmlChanged),
    });
  }

  // Present in the order the reviewer reads the page.
  const positionById = new Map(b.blocks.map((x, i) => [x.id, i]));
  changes.sort((x, y) => {
    const px = positionById.get(x.id) ?? Number.MAX_SAFE_INTEGER;
    const py = positionById.get(y.id) ?? Number.MAX_SAFE_INTEGER;
    return px - py;
  });

  const metaFields: (keyof PageMeta)[] = [
    "title",
    "description",
    "ogTitle",
    "ogDescription",
    "canonical",
  ];
  const meta: MetaChange[] = [];
  for (const field of metaFields) {
    const before = a.meta[field];
    const after = b.meta[field];
    if (before === after) continue;
    meta.push({
      field,
      before,
      after,
      words: before && after ? words(before, after) : null,
    });
  }

  const counts = { added: 0, removed: 0, changed: 0, moved: 0, total: 0 };
  for (const change of changes) {
    if (change.kind === "unchanged") continue;
    counts[change.kind] += 1;
    counts.total += 1;
  }

  const layoutRisk = changes
    .filter((c) => c.growth !== null && c.growth >= LAYOUT_RISK_RATIO)
    .map((c) => c.id);

  const beforeStyles = new Set(a.styles);
  return {
    blocks: changes,
    meta,
    stylesAdded: b.styles.filter((css) => !beforeStyles.has(css)),
    counts,
    layoutRisk,
  };
}

/** Ids the preview should highlight, keyed by how to highlight them. */
export function highlightSets(diff: ResolvedDiff): {
  changed: string[];
  added: string[];
  removed: string[];
  moved: string[];
} {
  return {
    changed: diff.blocks.filter((c) => c.kind === "changed").map((c) => c.id),
    added: diff.blocks.filter((c) => c.kind === "added").map((c) => c.id),
    removed: diff.blocks.filter((c) => c.kind === "removed").map((c) => c.id),
    moved: diff.blocks
      .filter((c) => c.kind === "moved" || c.alsoMoved)
      .map((c) => c.id),
  };
}
