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
  /**
   * For an inserted block, the block it was inserted next to.
   *
   * An inserted id is `new:<nanoid>` with no structural path, so nothing about
   * it says where on the page it belongs. Its anchor does.
   */
  anchorId?: string;
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

  const kept = baseline
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

  return withInserts(kept, ops);
}

/**
 * Put inserted blocks into the list, next to what they were inserted against.
 *
 * They are on the page — the preview applies insert ops like any other — but
 * derived from the baseline alone they were missing from the outline, so an
 * added bullet appeared in the preview and nowhere in the list beside it.
 *
 * Placed adjacent to the anchor rather than exactly where the DOM puts them:
 * firstChild and lastChild land inside a container whose position in a flat
 * list of text blocks is not defined. Adjacent is right for reading order,
 * which is what the outline is for.
 */
function withInserts(blocks: DerivedBlock[], ops: Op[]): DerivedBlock[] {
  const inserts = ops.filter((op) => op.t === "insert");
  if (inserts.length === 0) return blocks;

  const next = [...blocks];
  for (const op of inserts) {
    if (op.t !== "insert") continue;
    const id = insertedId(op);
    if (!id || next.some((d) => d.block.id === id)) continue;

    const text = htmlToText(op.html);
    const derived: DerivedBlock = {
      block: {
        id,
        tag: "div",
        role: "other",
        // The text, not the fragment's markup. Every other block's html is its
        // innerHTML, and the inspector edits that field directly — handed the
        // outer markup it showed the reviewer a <p> tag to edit.
        html: text,
        text,
        order: 0,
        sectionLabel: null,
        classes: [],
        // No capture-time geometry: it did not exist when the page was frozen.
        box: null,
      },
      html: text,
      text,
      // Added, not edited. The word diff has nothing to compare it against.
      changed: false,
      words: null,
      growth: null,
      layoutRisk: false,
      anchorId: op.refId,
    };

    const anchor = next.findIndex((d) => d.block.id === op.refId);
    if (anchor === -1) next.push(derived);
    else next.splice(op.pos === "before" ? anchor : anchor + 1, 0, derived);
  }
  return next;
}

function toWordParts(before: string, after: string): WordPart[] {
  return diffWords(before, after).map((p) => ({
    value: p.value,
    added: p.added || undefined,
    removed: p.removed || undefined,
  }));
}

/** Ops that change structure rather than wording. */
export function structuralOps(ops: Op[]): Op[] {
  return ops.filter(
    (op) => op.t !== "setText" && op.t !== "setMeta",
  );
}

/**
 * An inserted fragment's own id, read out of its markup.
 *
 * An insert op has no id field: ids are minted when the op is created and baked
 * into the html string, so that replaying the list hands the same element the
 * same id every time. The first one is the fragment's outermost element, which
 * is the thing worth naming and marking.
 */
const FIRST_ID = /data-cu-id="([^"]+)"/;

export function insertedId(op: Op): string | null {
  if (op.t !== "insert") return null;
  return FIRST_ID.exec(op.html)?.[1] ?? null;
}

/**
 * Ids for the preview's diff colouring, taken straight from the ops.
 *
 * No resolution needed: the preview applies the same op list, so an inserted
 * element is already in its DOM under the id baked into the op. Removals are
 * deliberately absent — the element is gone from the page, so there is nothing
 * left to paint. They show as a strikethrough row in the outline instead.
 */
export function structuralHighlights(ops: Op[]): { added: string[]; moved: string[] } {
  const added: string[] = [];
  const moved: string[] = [];
  for (const op of ops) {
    if (op.t === "insert") {
      const id = insertedId(op);
      if (id) added.push(id);
    } else if (op.t === "move") {
      moved.push(op.id);
    }
  }
  return { added, moved };
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
  return null;
}

const CHROME_LABEL: Record<ChromeKind, string> = {
  nav: "Navigation & header",
  footer: "Footer",
};

/** Content that precedes every heading, so there is nothing to name it after. */
const UNTITLED = "Page content";

export interface Section {
  /**
   * Unique key for rendering. Cannot be the label: real pages repeat headings
   * (a product name appearing in several sections), and grouping is by
   * contiguous run, so the same label legitimately produces several sections.
   * Keying by label collides and React duplicates or drops rows.
   */
  id: string;
  label: string;
  /** Ancestor labels then this one, for a scope the AI can place on the page. */
  path: string[];
  /** Heading level that opened it: 2 for h2, 3 for h3. Chrome sits at 2. */
  level: number;
  /** Blocks directly in this section — not those belonging to its children. */
  blocks: DerivedBlock[];
  children: Section[];
  /** Set for site furniture, which the outline collapses by default. */
  chrome: ChromeKind | null;
}

/** h2 → 2, h3 → 3. Anything else reporting as a heading is treated as an h2. */
function headingLevel(block: Block): number {
  const match = /^h([1-6])$/.exec(block.tag);
  return match ? Number(match[1]) : 2;
}

/** Every block in a section and everything nested beneath it. */
export function sectionBlocks(section: Section): DerivedBlock[] {
  return [...section.blocks, ...section.children.flatMap(sectionBlocks)];
}

export function eachSection(sections: Section[], fn: (s: Section) => void): void {
  for (const section of sections) {
    fn(section);
    eachSection(section.children, fn);
  }
}

/**
 * A container is furniture when almost nothing in it was on screen.
 *
 * Mega-menus, drawers and modals are built as one container holding hundreds of
 * blocks with a handful of always-visible triggers. On waveform.com the menu
 * container is 224 blocks with 9 visible; the leanest real content band is 57%
 * visible, so the two do not come close to overlapping.
 */
const CHROME_VISIBLE_RATIO = 0.25;

/**
 * Split a container into its own children once it holds more than this.
 *
 * Pages disagree about where their sections live. On one waveform.com page each
 * band is a direct child of body; on another the whole page is a single
 * `<main>` of 483 blocks. Descending until the groups are a usable size finds
 * the band level on both without hard-coding either shape.
 */
const SPLIT_ABOVE = 60;

/** How deep the descent may go before it stops carving the page up. */
const MAX_SPLIT_DEPTH = 4;

/**
 * A container whose children number more than this is a list, not a run of
 * bands. Descending into a 90-item `<ul>` yields 90 groups of one row each,
 * which is not an outline — it is the block list with extra headers.
 */
const MAX_BANDS_PER_CONTAINER = 12;

/** `body/div:3/div:1/p:2` at depth 1 is `body/div:3`. */
function containerAt(block: Block, depth: number): string {
  return block.id.split("/").slice(0, depth + 1).join("/");
}

interface Group {
  key: string;
  depth: number;
  blocks: DerivedBlock[];
}

function splitInto(blocks: DerivedBlock[], depth: number): Group[] {
  /*
   * Where each block belongs, keyed by id, so an inserted block can be given
   * the band of the block it was inserted against.
   *
   * Built first, in full, because an insert positioned "before" something sits
   * ahead of its anchor in this list — and the anchor is precisely the block
   * that opens the band it should join. Taking the running group instead put
   * a heading inserted at the top of a section under the *previous* section,
   * which is where a copywriter would then go looking for it in vain.
   */
  const keyOf = new Map<string, string>();
  for (const derived of blocks) {
    if (derived.block.id.includes("/")) {
      keyOf.set(derived.block.id, containerAt(derived.block, depth));
    }
  }

  const byId = new Map(blocks.map((d) => [d.block.id, d]));

  /** An insert may be anchored to another insert; follow the chain. */
  const anchorKey = (derived: DerivedBlock): string | undefined => {
    let current: DerivedBlock | undefined = derived;
    for (let hop = 0; current && hop < 10; hop += 1) {
      const key = keyOf.get(current.block.id);
      if (key) return key;
      current = current.anchorId ? byId.get(current.anchorId) : undefined;
    }
    return undefined;
  };

  const groups: Group[] = [];
  for (const derived of blocks) {
    const last = groups[groups.length - 1];
    // A block inserted by an op is identified as `new:<id>` and has no
    // structural path, so there is no container to group it by. It belongs
    // with the band it was inserted into, not as a band of its own, which is
    // what one group per inserted bullet would look like.
    const key =
      keyOf.get(derived.block.id) ??
      anchorKey(derived) ??
      last?.key ??
      derived.block.id;

    if (last && last.key === key) last.blocks.push(derived);
    else groups.push({ key, depth, blocks: [derived] });
  }
  return groups;
}

function chromeOf(group: Group): ChromeKind | null {
  const tagged = group.blocks[0] ? chromeKindOf(group.blocks[0].block) : null;
  if (tagged) return tagged;
  const visible = group.blocks.filter((d) => isVisible(d.block)).length;
  return visible / group.blocks.length < CHROME_VISIBLE_RATIO ? "nav" : null;
}

/**
 * The page's content bands, found by descending until the groups are usable.
 *
 * Chrome is never split — a 224-block menu is one thing, not four — and neither
 * is a group with nothing to split into.
 */
function bandsOf(blocks: DerivedBlock[]): { group: Group; chrome: ChromeKind | null }[] {
  let groups = splitInto(blocks, 1);

  for (let depth = 1; depth < MAX_SPLIT_DEPTH; depth += 1) {
    const next: Group[] = [];
    let changed = false;
    for (const group of groups) {
      const splittable = group.blocks.length > SPLIT_ABOVE && chromeOf(group) === null;
      const parts = splittable ? splitInto(group.blocks, group.depth + 1) : [group];
      const useful = parts.length > 1 && parts.length <= MAX_BANDS_PER_CONTAINER;
      if (useful) {
        changed = true;
        next.push(...parts);
      } else {
        next.push(group);
      }
    }
    groups = next;
    if (!changed) break;
  }

  const bands = groups.map((group) => ({ group, chrome: chromeOf(group) }));

  // A band that is nothing but a heading names the band after it. Pages
  // regularly put a section title and its content in sibling containers, and
  // read as two groups — one of them a single row — that is just noise.
  for (let i = 0; i < bands.length - 1; i += 1) {
    const here = bands[i];
    const next = bands[i + 1];
    if (here.chrome || next.chrome) continue;
    if (here.group.blocks.length !== 1) continue;
    if (here.group.blocks[0].block.role !== "heading") continue;
    next.group.blocks.unshift(here.group.blocks[0]);
    bands.splice(i, 1);
    i -= 1;
  }

  return bands;
}

/**
 * The heading that names a band, or its opening line if it has no heading.
 *
 * Returns which block supplied the name as well, because that block must not
 * then open a subsection of the band it just named — a band whose heading is
 * preceded by an eyebrow line read as "Heading > Heading".
 */
function labelFor(group: Group): { label: string; fromId: string | null } {
  const visible = group.blocks.filter((d) => isVisible(d.block));
  const usable = visible.length > 0 ? visible : group.blocks;

  const heading = usable.find((d) => d.block.role === "heading");
  if (heading) {
    return { label: heading.text || heading.block.text, fromId: heading.block.id };
  }

  // Most marketing bands have no heading element at all — the eyebrow or lead
  // line is styled as one. It names the band better than "Section 4" does.
  const lead = usable.find((d) => d.text.trim().length > 12) ?? usable[0];
  const text = lead?.text.trim() ?? "";
  const label = text ? (text.length > 48 ? `${text.slice(0, 47)}…` : text) : UNTITLED;
  return { label, fromId: null };
}

/**
 * Group blocks for the outline.
 *
 * Three signals do the work, and all come free with the capture.
 *
 * **Structure** decides where sections begin. Headings looked like the obvious
 * answer and are not: of eleven bands on waveform.com's custom-solutions page,
 * two have a heading element. The rest open with a styled div. Grouping by
 * heading therefore filed 150 blocks of page content — most of the page — under
 * "Private 5G Design & Deployment", which is a link inside a dropdown.
 *
 * **Visibility** decides what is furniture. Tag names are not enough, since
 * plenty of sites build a header out of plain divs, and the menu container here
 * is 4% visible against 57% for the leanest real band.
 *
 * **Heading level** decides nesting inside a band, so an h3 becomes a child of
 * the h2 above it instead of a sibling that truncates it.
 */
export function groupIntoSections(blocks: DerivedBlock[]): Section[] {
  const roots: Section[] = [];
  const chromeSections = new Map<ChromeKind, Section>();

  const makeSection = (
    derived: DerivedBlock,
    label: string,
    level: number,
    parentPath: string[],
    chrome: ChromeKind | null,
  ): Section => ({
    id: derived.block.id,
    label,
    path: [...parentPath, label],
    level,
    blocks: [derived],
    children: [],
    chrome,
  });

  const bands = bandsOf(blocks);
  const firstContent = bands.findIndex((b) => b.chrome === null);

  bands.forEach(({ group, chrome }, index) => {
    // Furniture merges into one group per kind, but only where furniture
    // actually lives: the run at the top of the document, and anything tagged
    // <footer>. A hidden drawer halfway down the page is not the header, and
    // calling it that made "Navigation & header" 816 blocks of the homepage.
    const leading = firstContent === -1 || index < firstContent;
    const merge = chrome === "footer" || (chrome === "nav" && leading);

    if (merge && chrome) {
      const existing = chromeSections.get(chrome);
      if (existing) existing.blocks.push(...group.blocks);
      else {
        const section = makeSection(group.blocks[0], CHROME_LABEL[chrome], 2, [], chrome);
        section.blocks.push(...group.blocks.slice(1));
        chromeSections.set(chrome, section);
        roots.push(section);
      }
      return;
    }

    const named = labelFor(group);
    const band = makeSection(group.blocks[0], named.label, 2, [], chrome);
    roots.push(band);

    // Subsections within the band. Whichever block supplied the band's name is
    // skipped, so it does not open a child section repeating that name.
    const stack: Section[] = [band];
    for (const derived of group.blocks.slice(1)) {
      const opens =
        derived.block.role === "heading" &&
        isVisible(derived.block) &&
        derived.block.id !== named.fromId;
      if (opens) {
        const level = Math.max(headingLevel(derived.block), band.level + 1);
        while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
        const parent = stack[stack.length - 1];
        const child = makeSection(
          derived,
          derived.text || derived.block.text,
          level,
          parent.path,
          null,
        );
        parent.children.push(child);
        stack.push(child);
        continue;
      }
      stack[stack.length - 1].blocks.push(derived);
    }
  });

  return roots;
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
  /** "Why Enterprises Choose Waveform › Coverage" for a nested section. */
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

  // The section that directly holds the block, not an ancestor: selecting a
  // paragraph inside a subsection should scope to that subsection, which is
  // what "rewrite this section" means to whoever clicked it.
  let section: Section | null = null;
  eachSection(groupIntoSections(blocks), (candidate) => {
    if (candidate.blocks.some((b) => b.block.id === blockId)) section = candidate;
  });
  if (!section) return null;
  const found: Section = section;

  // Subsections included. The outline counts a section's whole subtree and the
  // heading names all of it, so scoping to the parent's own paragraphs and
  // silently dropping its children rewrote a fraction of what was asked for.
  const all = sectionBlocks(found);
  const visible = all.filter((d) => isVisible(d.block));
  const usable = visible.length > 0 ? visible : all;

  return {
    label: found.path.join(" › "),
    blockIds: usable.slice(0, MAX_SCOPE_BLOCKS).map((d) => d.block.id),
    trimmed: Math.max(0, usable.length - MAX_SCOPE_BLOCKS),
  };
}
