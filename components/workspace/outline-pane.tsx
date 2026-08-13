"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  groupIntoSections,
  isVisible,
  sectionBlocks,
  type DerivedBlock,
  type Section,
} from "@/lib/workspace/derive";
import { isNewId } from "@/lib/ops/ids";

export interface SectionTemplate {
  id: string;
  label: string;
  hint: string;
  html: string;
  /** Text of every block the template should resolve into, in document order. */
  blockTexts: string[];
}

/**
 * Markup for the sections a copywriter can add without going through the AI.
 *
 * Deliberately plain semantic tags carrying no classes. Every snapshot brings
 * its own stylesheet, so a class lifted from one site — `.faq-item`, `.btn` —
 * means nothing on the next and renders as an unstyled surprise. Plain
 * elements inherit the page's base typography, which is the most a fixed
 * template can honestly promise across arbitrary sites. Matching the
 * surrounding design is a job for layout mode, which works from the real
 * markup and can copy the classes actually in use.
 *
 * Each text-bearing element becomes its own block once the insert resolves, so
 * every question and answer is separately editable, diffable and commentable —
 * which is the reason for splitting them into elements rather than emitting one
 * paragraph of prose. `blockTexts` states that expectation so a test can hold
 * the templates to it.
 */
export const SECTION_TEMPLATES: SectionTemplate[] = [
  {
    id: "faq",
    label: "FAQ section",
    hint: "Heading and three question/answer pairs",
    html:
      "<section>" +
      "<h2>Frequently asked questions</h2>" +
      "<div><h3>First question?</h3><p>The answer to the first question.</p></div>" +
      "<div><h3>Second question?</h3><p>The answer to the second question.</p></div>" +
      "<div><h3>Third question?</h3><p>The answer to the third question.</p></div>" +
      "</section>",
    blockTexts: [
      "Frequently asked questions",
      "First question?",
      "The answer to the first question.",
      "Second question?",
      "The answer to the second question.",
      "Third question?",
      "The answer to the third question.",
    ],
  },
  {
    id: "faq-item",
    label: "One FAQ question",
    hint: "A single question/answer pair, to extend an FAQ",
    html: "<div><h3>Another question?</h3><p>The answer to it.</p></div>",
    blockTexts: ["Another question?", "The answer to it."],
  },
  {
    id: "heading-text",
    label: "Heading and paragraph",
    hint: "The plainest new section there is",
    html: "<section><h2>Section heading</h2><p>The opening paragraph of this section.</p></section>",
    blockTexts: ["Section heading", "The opening paragraph of this section."],
  },
  {
    id: "bullets",
    label: "Bullet list",
    hint: "Heading and three bullets",
    html:
      "<section><h2>Section heading</h2>" +
      "<ul><li>First point.</li><li>Second point.</li><li>Third point.</li></ul>" +
      "</section>",
    blockTexts: ["Section heading", "First point.", "Second point.", "Third point."],
  },
  {
    id: "cta",
    label: "Call to action",
    hint: "Heading, a line of copy and a link",
    html:
      "<section><h2>Ready to talk?</h2><p>A line of copy that earns the click.</p>" +
      '<p><a href="#">Get a free estimate</a></p></section>',
    blockTexts: ["Ready to talk?", "A line of copy that earns the click.", "Get a free estimate"],
  },
];

/**
 * The "+" on a section header.
 *
 * Anchored to the end of the section it sits on rather than to a block the
 * reader has to select first: "add a section after this one" is the thing
 * someone wants, and making them hunt for the last block of a section to
 * insert after is asking them to know the document structure.
 */
function AddSectionButton({
  sectionLabel,
  onAdd,
}: {
  sectionLabel: string;
  /** Called with the chosen template's markup, before ids or sanitising. */
  onAdd: (html: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement | null>(null);

  // A menu that only closes on its own button strands itself open behind the
  // next click, which in a three-pane layout is usually somewhere else.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (wrapper.current && !wrapper.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={wrapper} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`Add a section after ${sectionLabel}`}
        title={`Add a section after "${sectionLabel}"`}
        className="rounded px-1 py-1 text-[11px] leading-none text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-added)]"
      >
        +
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-1 w-60 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] p-1 shadow-lg"
        >
          <p className="px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--color-ink-faint)]">
            Add after &ldquo;{sectionLabel}&rdquo;
          </p>
          {SECTION_TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              role="menuitem"
              onClick={() => {
                onAdd(template.html);
                setOpen(false);
              }}
              className="block w-full rounded px-2 py-1.5 text-left transition-colors hover:bg-[var(--color-sunken)]"
            >
              <span className="block text-xs font-medium">{template.label}</span>
              <span className="block text-[10px] text-[var(--color-ink-faint)]">
                {template.hint}
              </span>
            </button>
          ))}
          <p className="border-t border-[var(--color-line)] px-2 pt-1.5 pb-1 text-[10px] leading-snug text-[var(--color-ink-faint)]">
            Added copy uses the page&rsquo;s base styling, not the section&rsquo;s own. Edit the
            wording in place once it lands.
          </p>
        </div>
      ) : null}
    </div>
  );
}

const ROLE_LABEL: Record<string, string> = {
  heading: "H",
  paragraph: "P",
  link: "A",
  button: "B",
  listitem: "LI",
  quote: "Q",
  label: "L",
  other: "·",
};

export function OutlinePane({
  blocks,
  selectedId,
  onSelect,
  metaChanged,
  onSelectMeta,
  onSelectSection,
  onRevertSection,
  onAddSection,
  structuralCount,
  commentCounts,
}: {
  blocks: DerivedBlock[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  metaChanged: boolean;
  onSelectMeta: () => void;
  /** Selects the section's first block, which is what section scope keys off. */
  onSelectSection: (firstBlockId: string) => void;
  /** Drop every op touching these blocks, putting the section back as captured. */
  onRevertSection: (blockIds: string[]) => void;
  /** Insert a template's markup directly after the block ending a section. */
  onAddSection: (afterBlockId: string, html: string) => void;
  structuralCount: number;
  /** Unresolved comments per block id. */
  commentCounts: Record<string, number>;
}) {
  const [changedOnly, setChangedOnly] = useState(false);
  const [commentedOnly, setCommentedOnly] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [query, setQuery] = useState("");

  /**
   * Group the whole page, then filter what is shown — not the other way round.
   *
   * Grouping the filtered list looks equivalent and is not. Furniture is
   * recognised by how little of a container was ever on screen, so hiding the
   * hidden blocks first destroys the evidence: waveform.com's 224-block menu
   * arrived as the nine items that are always visible, scored 100% visible, and
   * came through as a page section called "Antennas & Routers" — a nav
   * subtitle — while "Navigation & header" shrank to the four blocks that
   * happen to sit in a literal <header> tag.
   */
  const sections = useMemo(() => groupIntoSections(blocks), [blocks]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (d: DerivedBlock) => {
      if (changedOnly && !d.changed) return false;
      if (commentedOnly && !commentCounts[d.block.id]) return false;
      // A commented block stays listed even when hidden: the comment is the
      // only way anyone will find it again.
      if (!showHidden && !isVisible(d.block) && !commentCounts[d.block.id]) return false;
      if (needle && !d.text.toLowerCase().includes(needle)) return false;
      return true;
    };
  }, [changedOnly, commentedOnly, commentCounts, showHidden, query]);

  /**
   * Sections start collapsed so the outline is a scannable list of headings
   * rather than a thousand rows. Explicit toggles are remembered; everything
   * else follows context — the section holding the selection opens, and a
   * search or filter opens what survived it, because the list is already short.
   */
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const narrowed = query.trim() !== "" || changedOnly || commentedOnly;

  /**
   * Every section on the path to the selection, so a block inside a subsection
   * opens its parents too rather than staying hidden behind a closed ancestor.
   */
  const openForSelection = useMemo(() => {
    const ids = new Set<string>();
    const mark = (section: Section): boolean => {
      const here = section.blocks.some((b) => b.block.id === selectedId);
      const below = section.children.map(mark).some(Boolean);
      if (here || below) ids.add(section.id);
      return here || below;
    };
    sections.forEach(mark);
    return ids;
  }, [sections, selectedId]);

  const isOpen = (section: Section) => {
    const explicit = toggled[section.id];
    if (explicit !== undefined) return explicit;
    if (narrowed) return true;
    return openForSelection.has(section.id);
  };

  const toggle = (id: string) =>
    setToggled((current) => ({
      ...current,
      [id]: !(current[id] ?? (narrowed || openForSelection.has(id))),
    }));

  /**
   * Keep the list in step with the preview. Clicking copy in the page selects
   * it here, and with a thousand blocks the row is usually far off-screen —
   * highlighting something nobody can see is not feedback.
   */
  const selectedRowRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedId, sections]);
  const hiddenCount = blocks.filter((d) => !isVisible(d.block)).length;
  const changedCount = blocks.filter((d) => d.changed).length;
  const totalComments = Object.values(commentCounts).reduce((a, b) => a + b, 0);

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-[var(--color-line)] p-3">
        <input
          className="field text-xs"
          placeholder="Filter copy…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setChangedOnly((v) => !v)}
            className={`chip border ${
              changedOnly
                ? "border-transparent bg-[var(--color-accent)] text-white"
                : "border-[var(--color-line-strong)] text-[var(--color-ink-soft)]"
            }`}
          >
            Changed {changedCount > 0 ? changedCount : ""}
          </button>
          {totalComments > 0 ? (
            <button
              type="button"
              onClick={() => setCommentedOnly((v) => !v)}
              title="Blocks with unresolved comments"
              className={`chip border ${
                commentedOnly
                  ? "border-transparent bg-[var(--color-comment)] text-white"
                  : "border-[var(--color-line-strong)] text-[var(--color-ink-soft)]"
              }`}
            >
              💬 {totalComments}
            </button>
          ) : null}
          {hiddenCount > 0 ? (
            <button
              type="button"
              onClick={() => setShowHidden((v) => !v)}
              title="Copy inside collapsed menus and off-screen drawers"
              className={`chip border ${
                showHidden
                  ? "border-transparent bg-[var(--color-accent)] text-white"
                  : "border-[var(--color-line-strong)] text-[var(--color-ink-soft)]"
              }`}
            >
              Hidden {hiddenCount}
            </button>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <button
          type="button"
          onClick={onSelectMeta}
          className={`mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--color-sunken)] ${
            selectedId === "__meta__" ? "bg-[var(--color-accent-soft)]" : ""
          }`}
        >
          <span className="font-mono text-[10px] text-[var(--color-ink-faint)]">SEO</span>
          <span className="font-medium">Meta title &amp; description</span>
          {metaChanged ? (
            <span className="ml-auto h-1.5 w-1.5 rounded-full bg-[var(--color-changed)]" />
          ) : null}
        </button>

        {structuralCount > 0 ? (
          <p className="mb-2 rounded-md bg-[var(--color-moved-soft)] px-2 py-1.5 text-[11px] text-[var(--color-ink-soft)]">
            {structuralCount} structural change{structuralCount === 1 ? "" : "s"} — added and moved
            blocks are marked in the preview. A removed block is gone from both the
            page and this list; the export still records it.
          </p>
        ) : null}

        {sections.map((section) => renderSection(section, 0))}

        {sections.every((s) => sectionBlocks(s).filter(matches).length === 0) ? (
          <p className="px-2 py-6 text-center text-xs text-[var(--color-ink-faint)]">
            Nothing matches.
          </p>
        ) : null}
      </div>
    </div>
  );

  function renderSection(section: Section, depth: number) {
    const open = isOpen(section);
    // Counts cover the subtree: a collapsed parent must still show that
    // something changed inside one of its subsections.
    const all = sectionBlocks(section);
    const changedHere = all.filter((d) => d.changed).length;
    /*
     * Insertions count as something to undo, even though they are not edits.
     *
     * An inserted block has nothing to diff against, so it is never `changed`
     * — which left a layout suggestion that only adds copy with no revert
     * control at all, and no way back short of deleting the version.
     */
    const addedHere = all.filter((d) => isNewId(d.block.id)).length;
    const undoableHere = changedHere + addedHere;
    const commentsHere = all.filter((d) => commentCounts[d.block.id]).length;

    // A section the filters emptied is not shown at all — but it was still
    // grouped, which is what kept the menu recognisable as furniture.
    const shownHere = all.filter(matches);
    if (shownHere.length === 0) return null;
    const rows = section.blocks.filter(matches);

    return (
          <div
            key={section.id}
            className="mb-1.5"
            style={depth > 0 ? { marginLeft: depth * 10 } : undefined}
          >
            <div className="flex items-center gap-0.5">
              {/* Chevron toggles; the label navigates. Separating them means
                  opening a section does not also move the preview, and jumping
                  to a section does not collapse what you were reading. */}
              <button
                type="button"
                onClick={() => toggle(section.id)}
                aria-expanded={open}
                aria-label={open ? `Collapse ${section.label}` : `Expand ${section.label}`}
                className="shrink-0 rounded px-1 py-1 text-[10px] text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-ink)]"
              >
                <span className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}>
                  ▸
                </span>
              </button>
              <button
                type="button"
                onClick={() => onSelectSection(section.blocks[0].block.id)}
                title={`Jump to this section (${all.length} blocks) — then choose Section scope to rewrite it as a whole`}
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1 text-left text-[10px] font-semibold uppercase tracking-wide text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-sunken)] hover:text-[var(--color-ink)]"
              >
                <span className="truncate">{section.label}</span>
                <span className="shrink-0 font-normal normal-case opacity-70">
                  {shownHere.length}
                </span>
                {!open && changedHere > 0 ? (
                  <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-changed)]" />
                ) : null}
                {!open && commentsHere > 0 ? (
                  <span className="shrink-0 text-[10px] text-[var(--color-comment)]">💬</span>
                ) : null}
              </button>
              {/* Anchored to the last block of the whole subtree, not of this
                  section's own copy: a section with subsections ends after the
                  last of them, and inserting before that would drop the new
                  copy into the middle of the section it was meant to follow. */}
              {all.length > 0 ? (
                <AddSectionButton
                  sectionLabel={section.label}
                  onAdd={(html) => onAddSection(all[all.length - 1].block.id, html)}
                />
              ) : null}
              {/* Only where there is something to undo. Reverting a section a
                  block at a time meant a trip through the inspector for each
                  one, with no way at all to undo an inserted element. */}
              {undoableHere > 0 ? (
                <button
                  type="button"
                  onClick={() => onRevertSection(all.map((d) => d.block.id))}
                  title={`Discard all ${undoableHere} change${undoableHere === 1 ? "" : "s"} in this section`}
                  className="shrink-0 rounded px-1 py-1 text-[10px] text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-removed)]"
                >
                  ↺
                </button>
              ) : null}
            </div>
            {open ? rows.map((derived) => (
              <button
                key={derived.block.id}
                type="button"
                ref={selectedId === derived.block.id ? selectedRowRef : undefined}
                onClick={() => onSelect(derived.block.id)}
                className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--color-sunken)] ${
                  selectedId === derived.block.id ? "bg-[var(--color-accent-soft)]" : ""
                }`}
              >
                <span className="mt-px w-4 shrink-0 font-mono text-[10px] text-[var(--color-ink-faint)]">
                  {ROLE_LABEL[derived.block.role] ?? "·"}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs">{derived.text}</span>
                {derived.layoutRisk ? (
                  <span
                    title="Grew enough to be worth checking on mobile"
                    className="mt-0.5 shrink-0 text-[10px] text-[var(--color-changed)]"
                  >
                    ↕
                  </span>
                ) : null}
                {commentCounts[derived.block.id] ? (
                  <span
                    title={`${commentCounts[derived.block.id]} unresolved comment${commentCounts[derived.block.id] === 1 ? "" : "s"}`}
                    className="shrink-0 text-[10px] leading-4 text-[var(--color-comment)]"
                  >
                    💬{commentCounts[derived.block.id] > 1 ? commentCounts[derived.block.id] : ""}
                  </span>
                ) : null}
                {derived.changed ? (
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-changed)]" />
                ) : null}
              </button>
            )) : null}
            {/* Subsections after this section's own copy, which is the order
                they appear in on the page. */}
            {open ? section.children.map((child) => renderSection(child, depth + 1)) : null}
          </div>
    );
  }
}

