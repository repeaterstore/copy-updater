"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  groupIntoSections,
  isVisible,
  sectionBlocks,
  type DerivedBlock,
  type Section,
} from "@/lib/workspace/derive";

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
  structuralCount: number;
  /** Unresolved comments per block id. */
  commentCounts: Record<string, number>;
}) {
  const [changedOnly, setChangedOnly] = useState(false);
  const [commentedOnly, setCommentedOnly] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return blocks.filter((d) => {
      if (changedOnly && !d.changed) return false;
      if (commentedOnly && !commentCounts[d.block.id]) return false;
      // A commented block stays listed even when hidden: the comment is the
      // only way anyone will find it again.
      if (!showHidden && !isVisible(d.block) && !commentCounts[d.block.id]) return false;
      if (needle && !d.text.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [blocks, changedOnly, commentedOnly, commentCounts, showHidden, query]);

  const sections = useMemo(() => groupIntoSections(filtered), [filtered]);

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
            {structuralCount} structural change{structuralCount === 1 ? "" : "s"} pending —
            save to see them in the preview.
          </p>
        ) : null}

        {sections.map((section) => renderSection(section, 0))}

        {sections.length === 0 ? (
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
    const commentsHere = all.filter((d) => commentCounts[d.block.id]).length;

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
                  {all.length}
                </span>
                {!open && changedHere > 0 ? (
                  <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-changed)]" />
                ) : null}
                {!open && commentsHere > 0 ? (
                  <span className="shrink-0 text-[10px] text-[var(--color-comment)]">💬</span>
                ) : null}
              </button>
            </div>
            {open ? section.blocks.map((derived) => (
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
