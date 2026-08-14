"use client";

import { useEffect, useState } from "react";
import type { PageMeta } from "@/lib/ops/types";
import type { DerivedBlock } from "@/lib/workspace/derive";
import { RichText } from "./rich-text";
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

/** Which devices a block is shown on. Mirrors the marker classes in Workspace. */
export type Visibility = "both" | "desktop" | "mobile";

/** Read a block's current setting back off the classes it is carrying. */
export function visibilityOf(classes: string[]): Visibility {
  if (classes.includes("cu-only-desktop")) return "desktop";
  if (classes.includes("cu-only-mobile")) return "mobile";
  return "both";
}

export function InspectorPane({
  selected,
  meta,
  metaBaseline,
  onChangeBlock,
  onChangeMeta,
  onRevertBlock,
  onSplit,
  onSetVisibility,
  visibility,
  responsiveLabel,
  altText,
  onSetAlt,
  sectionBlockIds,
  sectionLabel,
  onSetSectionVisibility,
  readOnly,
  aiSlot,
  commentSlot,
}: {
  selected: DerivedBlock | null;
  meta: PageMeta;
  metaBaseline: PageMeta;
  onChangeBlock: (id: string, html: string) => void;
  /** Enter mid-block: the tail becomes a new sibling block. */
  onSplit?: (id: string, before: string, after: string) => void;
  /** Restrict a block to one device, or put it back on both. */
  onSetVisibility: (id: string, mode: Visibility) => void;
  /**
   * Read from the op list by Workspace, not from the block.
   *
   * `block.classes` describes the captured page until a save round-trips, so
   * deriving this here would leave the control reporting "Both" however many
   * times someone had changed it.
   */
  visibility: Visibility;
  /** Null when the page defines no responsive convention; the control hides. */
  responsiveLabel: string | null;
  /** The selected image's alt text, resolved from the ops. */
  altText: string;
  onSetAlt: (id: string, value: string) => void;
  /** Every block of the section the selection sits in, for the whole-card case. */
  sectionBlockIds: string[] | null;
  sectionLabel: string | null;
  onSetSectionVisibility: (ids: string[], mode: Visibility) => void;
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
      onSplit={onSplit}
      onSetVisibility={onSetVisibility}
      visibility={visibility}
      responsiveLabel={responsiveLabel}
      altText={altText}
      onSetAlt={onSetAlt}
      sectionBlockIds={sectionBlockIds}
      sectionLabel={sectionLabel}
      onSetSectionVisibility={onSetSectionVisibility}
      readOnly={readOnly}
      aiSlot={aiSlot}
      commentSlot={commentSlot}
    />
  );
}

/**
 * The block's markup with the source page's own line breaks and indentation
 * taken out.
 *
 * A captured block keeps the whitespace it was written with — a heading is
 * routinely `"\n              Turn-Key DAS Solutions v3\n            "` — and
 * a browser collapses all of that when it renders, which is why the block
 * reads tight on the page and in "Currently on the page". A textarea does not:
 * it shows every character, so the copy appeared two blank lines down and
 * fourteen spaces in, with the box mostly empty around it.
 *
 * Collapsing runs of whitespace is what the renderer does anyway, so nothing
 * about the block changes — except inside `<pre>`, where the whitespace is the
 * content, so that is left exactly as captured.
 */
function tidy(html: string): string {
  if (/<pre[\s>]/i.test(html)) return html;
  return html.replace(/\s+/g, " ").trim();
}

function BlockEditor({
  derived,
  onChange,
  onRevert,
  onSplit,
  onSetVisibility,
  visibility,
  responsiveLabel,
  altText,
  onSetAlt,
  sectionBlockIds,
  sectionLabel,
  onSetSectionVisibility,
  readOnly,
  aiSlot,
  commentSlot,
}: {
  derived: DerivedBlock;
  onChange: (id: string, html: string) => void;
  onRevert: (id: string) => void;
  onSplit?: (id: string, before: string, after: string) => void;
  onSetVisibility: (id: string, mode: Visibility) => void;
  visibility: Visibility;
  /**
   * How this page says "hide on mobile", named — or null when its stylesheet
   * has no such convention, in which case the control is not offered. A button
   * that writes a class the site does not define does nothing and says nothing.
   */
  responsiveLabel: string | null;
  /** Read from the op list, for the same reason `visibility` is. */
  altText: string;
  onSetAlt: (id: string, value: string) => void;
  sectionBlockIds: string[] | null;
  sectionLabel: string | null;
  onSetSectionVisibility: (ids: string[], mode: Visibility) => void;
  readOnly: boolean;
  aiSlot?: React.ReactNode;
  commentSlot?: React.ReactNode;
}) {
  const [showHtml, setShowHtml] = useState(false);
  const [draft, setDraft] = useState(() => tidy(derived.html));

  // Adopt external changes (an applied AI option, an inline edit in the
  // preview) without clobbering what is being typed here.
  useEffect(() => {
    setDraft(showHtml ? derived.html : tidy(derived.html));
  }, [derived.html, showHtml]);

  const hasMarkup = /<[a-z][^>]*>/i.test(derived.block.html);
  const isImage = derived.block.role === "image";

  /**
   * The alt text as it stands, from the op list first and the captured markup
   * second — the same reason `visibility` is read from the ops rather than the
   * block: setAttr is resolved on the server, so the block still describes the
   * captured page until a save round-trips.
   */
  const [alt, setAlt] = useState(altText);
  useEffect(() => setAlt(altText), [altText]);
  const [imageError, setImageError] = useState<string | null>(null);

  /**
   * Paste a picture into a block, most often one of the gaps a reference-image
   * suggestion leaves behind.
   *
   * The image is inlined as a data URL rather than uploaded, which is what lets
   * this exist at all: it rides along in the block's html, saved as an ordinary
   * setText op, so it survives, forks, diffs and reaches whoever opens the
   * version next. Nothing new stores anything.
   *
   * That is also why it is downscaled hard first. The bytes end up in the
   * version's op list, replayed on every resolve and sent down the wire on
   * every open — so this trades resolution, which a copy review does not need,
   * for a payload that stays reasonable. JPEG rather than PNG for the same
   * reason: a photograph is several times smaller as JPEG, and this path is
   * for photographs.
   */
  const MAX_IMAGE_EDGE = 1200;
  const MAX_ENCODED_CHARS = 600_000;

  const pasteImage = (file: File) => {
    setImageError(null);
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.82);

        if (dataUrl.length > MAX_ENCODED_CHARS) {
          setImageError(
            "That image is too large to embed even after resizing. Crop it, or save it at a smaller size.",
          );
          return;
        }

        // Replaces the gap rather than sitting inside it: a placeholder is a
        // labelled hole, and keeping its wording next to the picture that fills
        // it reads as a caption nobody wrote.
        const html =
          `<img src="${dataUrl}" alt="" ` +
          `style="display:block;max-width:100%;height:auto" />`;
        setDraft(html);
        onChange(derived.block.id, html);
      };
      image.onerror = () => setImageError("That file could not be read as an image.");
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  };

  const onPaste = (event: React.ClipboardEvent) => {
    if (readOnly) return;
    const item = Array.from(event.clipboardData?.items ?? []).find((i) =>
      i.type.startsWith("image/"),
    );
    if (!item) return;
    const file = item.getAsFile();
    if (!file) return;
    // Only when the clipboard really holds a picture, so pasting text into the
    // editor behaves exactly as it always has.
    event.preventDefault();
    pasteImage(file);
  };

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
        {isImage ? (
          /*
           * A picture has no copy to rewrite, so the editor would be a text box
           * that does nothing. What it does have is alt text — which is copy,
           * and the only wording an image carries — and a place to say it is
           * the wrong picture. Choosing the right one is the designer's job,
           * and this tool does not pretend to do it.
           */
          <section>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">
              Alt text
            </p>
            <textarea
              className="field min-h-16 resize-y font-sans text-sm"
              value={alt}
              readOnly={readOnly}
              placeholder="What this picture shows, for a screen reader"
              onChange={(e) => {
                setAlt(e.target.value);
                onSetAlt(derived.block.id, e.target.value);
              }}
            />
            <p className="mt-1.5 text-[11px] leading-snug text-[var(--color-ink-faint)]">
              To ask for a different picture, leave a comment below — it goes to
              whoever picks the image.
            </p>
          </section>
        ) : null}

        {isImage ? null : (
        <section>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">
            Currently on the page
          </p>
          <p className="rounded-md bg-[var(--color-sunken)] px-2.5 py-2 text-sm text-[var(--color-ink-soft)]">
            {derived.block.text}
          </p>
        </section>
        )}

        {isImage ? null : (
        <section>
          <div className="mb-1 flex items-center justify-between">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">
              Proposed
            </p>
            <div className="flex items-center gap-2">
              <CharCount value={derived.text.length} />
              {/* Always offered, not only where markup already exists. A block
                  of plain text is exactly the one you might want to put a link
                  or a line break into by hand, and hiding the toggle there left
                  no way to do it at all. */}
              <button
                type="button"
                onClick={() => setShowHtml((v) => !v)}
                className="text-[11px] text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
                title={
                  hasMarkup
                    ? "This block contains links or emphasis — edit the markup directly"
                    : "Edit the markup directly"
                }
              >
                {showHtml ? "Hide HTML" : "Edit HTML"}
              </button>
            </div>
          </div>

          {/* The markup view stays a plain field: it is markup, and a rich
              editor would render the tags someone opened it to read. */}
          {derived.removed ? (
            /* The one thing left to do with copy on its way out is keep it.
               Offering an editor would produce a setText the server applies
               after the remove and then fails. */
            <p className="rounded-md border border-dashed border-[var(--color-removed)] px-2.5 py-2 text-xs text-[var(--color-ink-soft)]">
              This block is marked for deletion. Revert it to edit it again.
            </p>
          ) : showHtml ? (
            <textarea
              className="field min-h-24 resize-y"
              style={{ fontFamily: "var(--font-mono)", fontSize: "0.75rem" }}
              value={draft}
              readOnly={readOnly}
              onPaste={onPaste}
              onChange={(e) => {
                setDraft(e.target.value);
                onChange(derived.block.id, e.target.value);
              }}
            />
          ) : (
            <RichText
              value={draft}
              readOnly={readOnly}
              className="text-sm"
              onPaste={onPaste}
              onChange={(html) => {
                setDraft(html);
                onChange(derived.block.id, html);
              }}
              onSplit={(before, after) => onSplit?.(derived.block.id, before, after)}
            />
          )}

          {!readOnly ? (
            <p className="mt-1 text-[10px] text-[var(--color-ink-faint)]">
              Paste an image here (Ctrl+V) to drop a picture into this block.
            </p>
          ) : null}

          {imageError ? (
            <p className="mt-1 rounded-md bg-[var(--color-removed-soft)] px-2 py-1.5 text-[10px] leading-snug text-[var(--color-removed)]">
              {imageError}
            </p>
          ) : null}

          {(derived.changed || derived.restyled || derived.removed) && !readOnly ? (
            <button
              type="button"
              onClick={() => onRevert(derived.block.id)}
              title="Put this block back exactly as the page has it — wording, styling and all"
              className="mt-1.5 text-[11px] text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
            >
              {derived.changed ? "Revert to original" : "Revert styling to original"}
            </button>
          ) : null}
        </section>
        )}

        {/* Offered only where the page has a convention for it. A site with no
            responsive utilities cannot be told to hide something on mobile
            without inventing classes it does not define — which exports as a
            change a developer has to translate before they can implement it. */}
        {!readOnly && responsiveLabel ? (
          <section className="border-b border-[var(--color-line)] p-3">
            <p className="mb-1.5 flex items-baseline gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">
              Shows on
              <span
                className="font-normal normal-case tracking-normal opacity-80"
                title="The classes this page already uses for it, so the change is one a developer can implement as written"
              >
                {responsiveLabel}
              </span>
            </p>
            <div className="flex overflow-hidden rounded-lg border border-[var(--color-line-strong)]">
              {(
                [
                  ["both", "Both"],
                  ["desktop", "Desktop only"],
                  ["mobile", "Mobile only"],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => onSetVisibility(derived.block.id, mode)}
                  aria-pressed={visibility === mode}
                  className={`flex-1 px-2 py-1.5 text-[11px] transition-colors ${
                    visibility === mode
                      ? "bg-[var(--color-accent)] text-white"
                      : "text-[var(--color-ink-soft)] hover:bg-[var(--color-sunken)]"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {/* The whole-card case, which is what people actually reach for.
                A card is six or seven blocks, and restricting one of them takes
                a line out of the middle and leaves the rest on screen. */}
            {sectionBlockIds && sectionBlockIds.length > 1 ? (
              <p className="mt-1.5 text-[10px] leading-snug text-[var(--color-ink-faint)]">
                Applies to this block only.{" "}
                <button
                  type="button"
                  onClick={() => onSetSectionVisibility(sectionBlockIds, visibility)}
                  className="underline underline-offset-2 hover:text-[var(--color-ink)]"
                >
                  Apply to all {sectionBlockIds.length} blocks
                </button>{" "}
                in {sectionLabel ? `“${sectionLabel}”` : "this section"} to hide the whole thing.
              </p>
            ) : null}

            {/* One sentence about the state it is actually in. Describing both
                rules at once read as a puzzle, and someone reading the buttons
                rather than the heading above them picked the opposite of what
                they wanted. */}
            {visibility !== "both" ? (
              <p className="mt-1.5 rounded-md bg-[var(--color-moved-soft)] px-2 py-1.5 text-[11px] leading-snug text-[var(--color-ink-soft)]">
                <strong>
                  {visibility === "desktop"
                    ? "Hidden on mobile. Visible on desktop."
                    : "Hidden on desktop. Visible on mobile."}
                </strong>{" "}
                The switch is at 768px wide. Check it with the Mobile and Desktop toggles above the
                preview. The rule travels with the version and appears in the export.
              </p>
            ) : null}
          </section>
        ) : null}

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

