"use client";

import { useEffect, useState } from "react";
import type { PageMeta } from "@/lib/ops/types";
import type { DerivedBlock } from "@/lib/workspace/derive";
import { WordDiff } from "./word-diff";

/** Google truncates around these lengths; shown as guidance, never enforced. */
const META_GUIDE = { title: 60, description: 155 };

function CharCount({ value, guide }: { value: number; guide?: number }) {
  const over = guide !== undefined && value > guide;
  return (
    <span
      className={`text-[11px] tabular-nums ${
        over ? "text-[var(--color-changed)]" : "text-[var(--color-ink-faint)]"
      }`}
      title={guide ? `Around ${guide} characters is the usual display limit` : undefined}
    >
      {value}
      {guide ? ` / ~${guide}` : ""}
    </span>
  );
}

export function InspectorPane({
  selected,
  meta,
  metaBaseline,
  onChangeBlock,
  onChangeMeta,
  onRevertBlock,
  readOnly,
  aiSlot,
  commentSlot,
}: {
  selected: DerivedBlock | null;
  meta: PageMeta;
  metaBaseline: PageMeta;
  onChangeBlock: (id: string, html: string) => void;
  onChangeMeta: (patch: Partial<PageMeta>) => void;
  onRevertBlock: (id: string) => void;
  readOnly: boolean;
  aiSlot?: React.ReactNode;
  commentSlot?: React.ReactNode;
}) {
  if (selected === null) {
    return (
      <MetaEditor
        meta={meta}
        baseline={metaBaseline}
        onChange={onChangeMeta}
        readOnly={readOnly}
        aiSlot={aiSlot}
        commentSlot={commentSlot}
      />
    );
  }

  return (
    <BlockEditor
      key={selected.block.id}
      derived={selected}
      onChange={onChangeBlock}
      onRevert={onRevertBlock}
      readOnly={readOnly}
      aiSlot={aiSlot}
      commentSlot={commentSlot}
    />
  );
}

function BlockEditor({
  derived,
  onChange,
  onRevert,
  readOnly,
  aiSlot,
  commentSlot,
}: {
  derived: DerivedBlock;
  onChange: (id: string, html: string) => void;
  onRevert: (id: string) => void;
  readOnly: boolean;
  aiSlot?: React.ReactNode;
  commentSlot?: React.ReactNode;
}) {
  const [draft, setDraft] = useState(derived.html);
  const [showHtml, setShowHtml] = useState(false);

  // Adopt external changes (an applied AI option, an inline edit in the
  // preview) without clobbering what is being typed here.
  useEffect(() => {
    setDraft(derived.html);
  }, [derived.html]);

  const hasMarkup = /<[a-z][^>]*>/i.test(derived.block.html);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[var(--color-line)] p-3">
        <div className="flex items-center gap-2">
          <span className="chip bg-[var(--color-sunken)] text-[var(--color-ink-soft)]">
            {derived.block.tag} · {derived.block.role}
          </span>
          {derived.changed ? (
            <span className="chip bg-[var(--color-changed-soft)] text-[var(--color-changed)]">
              edited
            </span>
          ) : null}
          {derived.layoutRisk ? (
            <span
              className="chip bg-[var(--color-changed-soft)] text-[var(--color-changed)]"
              title="Noticeably longer than the original — worth checking on mobile"
            >
              check layout
            </span>
          ) : null}
        </div>
        {derived.block.sectionLabel ? (
          <p className="mt-1.5 truncate text-[11px] text-[var(--color-ink-faint)]">
            in “{derived.block.sectionLabel}”
          </p>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        <section>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">
            Currently on the page
          </p>
          <p className="rounded-md bg-[var(--color-sunken)] px-2.5 py-2 text-sm text-[var(--color-ink-soft)]">
            {derived.block.text}
          </p>
        </section>

        <section>
          <div className="mb-1 flex items-center justify-between">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">
              Proposed
            </p>
            <div className="flex items-center gap-2">
              <CharCount value={derived.text.length} />
              {hasMarkup ? (
                <button
                  type="button"
                  onClick={() => setShowHtml((v) => !v)}
                  className="text-[11px] text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
                  title="This block contains links or emphasis — edit the markup directly"
                >
                  {showHtml ? "Hide HTML" : "Edit HTML"}
                </button>
              ) : null}
            </div>
          </div>

          <textarea
            className="field min-h-24 resize-y font-sans text-sm"
            style={showHtml ? { fontFamily: "var(--font-mono)", fontSize: "0.75rem" } : undefined}
            value={draft}
            readOnly={readOnly}
            onChange={(e) => {
              setDraft(e.target.value);
              onChange(derived.block.id, e.target.value);
            }}
          />

          {derived.changed && !readOnly ? (
            <button
              type="button"
              onClick={() => onRevert(derived.block.id)}
              className="mt-1.5 text-[11px] text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
            >
              Revert to original
            </button>
          ) : null}
        </section>

        {derived.words ? (
          <section>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">
              What changed
            </p>
            <div className="rounded-md border border-[var(--color-line)] px-2.5 py-2">
              <WordDiff parts={derived.words} />
            </div>
            {derived.growth !== null ? (
              <p className="mt-1 text-[11px] text-[var(--color-ink-faint)]">
                {derived.growth >= 1
                  ? `${Math.round((derived.growth - 1) * 100)}% longer`
                  : `${Math.round((1 - derived.growth) * 100)}% shorter`}{" "}
                than the original
              </p>
            ) : null}
          </section>
        ) : null}

        {aiSlot}
        {commentSlot}
      </div>
    </div>
  );
}

function MetaEditor({
  meta,
  baseline,
  onChange,
  readOnly,
  aiSlot,
  commentSlot,
}: {
  meta: PageMeta;
  baseline: PageMeta;
  onChange: (patch: Partial<PageMeta>) => void;
  readOnly: boolean;
  aiSlot?: React.ReactNode;
  commentSlot?: React.ReactNode;
}) {
  const fields: { key: keyof PageMeta; label: string; guide?: number; rows: number }[] = [
    { key: "title", label: "Meta title", guide: META_GUIDE.title, rows: 2 },
    { key: "description", label: "Meta description", guide: META_GUIDE.description, rows: 4 },
    { key: "ogTitle", label: "Open Graph title", rows: 2 },
    { key: "ogDescription", label: "Open Graph description", rows: 3 },
  ];

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[var(--color-line)] p-3">
        <span className="chip bg-[var(--color-sunken)] text-[var(--color-ink-soft)]">SEO</span>
        <p className="mt-1.5 text-[11px] text-[var(--color-ink-faint)]">
          Character guides show where search results usually truncate. Nothing is enforced.
        </p>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {fields.map((field) => {
          const value = meta[field.key] ?? "";
          const original = baseline[field.key] ?? "";
          const changed = value !== original;

          return (
            <section key={field.key}>
              <div className="mb-1 flex items-center justify-between">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">
                  {field.label}
                </p>
                <CharCount value={value.length} guide={field.guide} />
              </div>
              {changed && original ? (
                <p className="mb-1 rounded-md bg-[var(--color-sunken)] px-2.5 py-1.5 text-xs text-[var(--color-ink-soft)]">
                  {original}
                </p>
              ) : null}
              <textarea
                rows={field.rows}
                className="field resize-y text-sm"
                value={value}
                readOnly={readOnly}
                onChange={(e) => onChange({ [field.key]: e.target.value })}
              />
            </section>
          );
        })}

        {meta.canonical ? (
          <p className="text-[11px] text-[var(--color-ink-faint)]">
            Canonical: {meta.canonical}
          </p>
        ) : null}

        {aiSlot}
        {commentSlot}
      </div>
    </div>
  );
}
