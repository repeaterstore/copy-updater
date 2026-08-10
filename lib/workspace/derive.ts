/**
 * Client-side derivation of what a version currently says.
 *
 * The authoritative resolved state is rebuilt on the server on every save. This
 * covers the gap in between: while someone is typing, the outline and inspector
 * need to show the edit and its word diff immediately, without a round trip.
 *
 * Text edits are derived exactly. Structural ops cannot be resolved without a
 * DOM, so they are surfaced as pending items instead of being silently ignored.
 */
import { diffWords } from "diff";
import type { Block, Op, PageMeta } from "@/lib/ops/types";
import type { WordPart } from "@/lib/ops/diff";

export interface DerivedBlock {
  block: Block;
  /** Current html, including unsaved edits. */
  html: string;
  text: string;
  changed: boolean;
  words: WordPart[] | null;
  growth: number | null;
  layoutRisk: boolean;
}

export const LAYOUT_RISK_RATIO = 1.3;

const TAG = /<[^>]*>/g;

export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(TAG, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** The last setText op wins, matching how applyOps replays the list. */
export function textOverrides(ops: Op[]): Map<string, string> {
  const overrides = new Map<string, string>();
  for (const op of ops) {
    if (op.t === "setText") overrides.set(op.id, op.html);
  }
  return overrides;
}

export function metaOverrides(ops: Op[]): Partial<PageMeta> {
  const meta: Partial<PageMeta> = {};
  for (const op of ops) {
    if (op.t !== "setMeta") continue;
    if (typeof op.title === "string") meta.title = op.title;
    if (typeof op.description === "string") meta.description = op.description;
    if (typeof op.ogTitle === "string") meta.ogTitle = op.ogTitle;
    if (typeof op.ogDescription === "string") meta.ogDescription = op.ogDescription;
  }
  return meta;
}

/**
 * Compare markup ignoring differences that carry no meaning.
 *
 * An op's html is the raw string that was authored; the baseline's html has
 * been through a parse/serialise round trip on the server. They can differ in
 * whitespace and attribute order while describing exactly the same content.
 * Comparing them literally makes a freshly forked version show every inherited
 * edit as a change the moment it opens.
 */
function sameMarkup(a: string, b: string): boolean {
  if (a === b) return true;
  const normalize = (html: string) =>
    html
      .replace(/\s+/g, " ")
      .replace(/\s*=\s*/g, "=")
      .replace(/>\s+</g, "><")
      .trim();
  if (normalize(a) === normalize(b)) return true;
  // Fall back to text: markup that differs only in attribute order still reads
  // as the same copy to a reviewer.
  return htmlToText(a) === htmlToText(b);
}

export function deriveBlocks(baseline: Block[], ops: Op[]): DerivedBlock[] {
  const overrides = textOverrides(ops);
  const removed = new Set(ops.filter((o) => o.t === "remove").map((o) => o.id));

  return baseline
    .filter((block) => !removed.has(block.id))
    .map((block) => {
      const html = overrides.get(block.id) ?? block.html;
      const text = overrides.has(block.id) ? htmlToText(html) : block.text;
      const changed = !sameMarkup(html, block.html);
      const growth = block.text.length > 0 ? text.length / block.text.length : null;

      return {
        block,
        html,
        text,
        changed,
        words: changed ? toWordParts(block.text, text) : null,
        growth,
        layoutRisk: changed && growth !== null && growth >= LAYOUT_RISK_RATIO,
      };
    });
}

function toWordParts(before: string, after: string): WordPart[] {
  return diffWords(before, after).map((p) => ({
    value: p.value,
    added: p.added || undefined,
    removed: p.removed || undefined,
  }));
}

/** Ops that change structure and therefore need a save to render accurately. */
export function structuralOps(ops: Op[]): Op[] {
  return ops.filter(
    (op) => op.t !== "setText" && op.t !== "setMeta",
  );
}

export type ChromeKind = "nav" | "footer";

/**
 * Site furniture, identified from the block's structural path.
 *
 * Ids look like `body/header:1/div:2/a:1`, so the ancestry is readable without
 * the DOM. Header and nav copy is real copy, but on waveform.com it is 144
 * blocks of menu before the first heading — grouping it under one collapsed
 * heading is the difference between an outline you can scan and a wall.
 */
export function chromeKindOf(block: Block): ChromeKind | null {
  if (/(^|\/)footer:\d+/.test(block.id)) return "footer";
  if (/(^|\/)(header|nav):\d+/.test(block.id)) return "nav";
  // Anything before the first heading is furniture: announcement bars, search,
  // account links, mega-menus. Tag names alone are not enough — plenty of sites
  // build a header out of plain divs, and on those the run reaches 140 blocks
  // and swamps the outline.
  if (block.sectionLabel === null) return "nav";
  return null;
}

const CHROME_LABEL: Record<ChromeKind, string> = {
  nav: "Navigation & header",
  footer: "Footer",
};

export interface Section {
  /**
   * Unique key for rendering. Cannot be the label: real pages repeat headings
   * (a product name appearing in several sections), and grouping is by
   * contiguous run, so the same label legitimately produces several sections.
   * Keying by label collides and React duplicates or drops rows.
   */
  id: string;
  label: string;
  blocks: DerivedBlock[];
  /** Set for site furniture, which the outline collapses by default. */
  chrome: ChromeKind | null;
}

/**
 * Group blocks for the outline: site furniture into one section each, and
 * everything else under the heading that precedes it.
 */
export function groupIntoSections(blocks: DerivedBlock[]): Section[] {
  const sections: Section[] = [];

  for (const derived of blocks) {
    const chrome = chromeKindOf(derived.block);
    const label = chrome ? CHROME_LABEL[chrome] : derived.block.sectionLabel!;

    const last = sections.at(-1);
    // Chrome merges by kind even when not contiguous — a header split across
    // wrappers should still read as one thing.
    const merges = last && (chrome ? last.chrome === chrome : last.label === label && !last.chrome);

    if (merges) last!.blocks.push(derived);
    else sections.push({ id: derived.block.id, label, blocks: [derived], chrome });
  }

  return sections;
}

/**
 * Hidden blocks (collapsed menus, off-screen drawers) are real copy but there
 * can be hundreds of them, and surfacing them by default buries the copy that
 * is actually on the page.
 */
export function isVisible(block: Block): boolean {
  return !block.box || (block.box.w > 0 && block.box.h > 0);
}

/**
 * Above this, a section is too much to rewrite coherently in one request.
 *
 * Real pages have outliers: on waveform.com the median section is 19 blocks but
 * a product grid reaches 158. Sending that produces mush and costs a fortune,
 * so the scope is trimmed and the UI says so rather than silently truncating.
 */
export const MAX_SCOPE_BLOCKS = 60;

export interface SectionScope {
  label: string;
  blockIds: string[];
  /** Blocks dropped because the section exceeded MAX_SCOPE_BLOCKS. */
  trimmed: number;
}

/**
 * The section containing a block, as the AI should see it.
 *
 * Hidden blocks are excluded: the run before the first heading is mostly nav
 * and collapsed mega-menu items — 144 blocks on waveform.com — and rewriting
 * copy nobody can see is not what "this section" means.
 */
export function sectionScopeFor(
  blocks: DerivedBlock[],
  blockId: string | null,
): SectionScope | null {
  if (!blockId) return null;

  const sections = groupIntoSections(blocks);
  const section = sections.find((s) => s.blocks.some((b) => b.block.id === blockId));
  if (!section) return null;

  const visible = section.blocks.filter((d) => isVisible(d.block));
  const usable = visible.length > 0 ? visible : section.blocks;

  return {
    label: section.label,
    blockIds: usable.slice(0, MAX_SCOPE_BLOCKS).map((d) => d.block.id),
    trimmed: Math.max(0, usable.length - MAX_SCOPE_BLOCKS),
  };
}
