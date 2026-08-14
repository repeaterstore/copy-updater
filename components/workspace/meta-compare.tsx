"use client";

import type { PageMeta } from "@/lib/ops/types";

/**
 * Before and after for the title and description, above the page itself.
 *
 * Meta copy is the one thing a version can change that the preview cannot
 * show: it is not on the page. It was editable in the inspector and visible
 * nowhere else, so the only way to compare a proposed title with the current
 * one was to remember what the current one said.
 *
 * Drawn as a search result rather than as two labelled fields, because that is
 * the thing being written. A title is not "60 characters of copy", it is the
 * blue line someone chooses between competitors, and it is judged next to the
 * description under it and truncated where the page it appears on truncates.
 */
const LIMITS = { title: 60, description: 155 };

/** What Google shows: the hostname and path, breadcrumbed. */
function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/$/, "").split("/").filter(Boolean);
    return [parsed.hostname.replace(/^www\./, ""), ...path].join(" › ");
  } catch {
    return url;
  }
}

function truncate(value: string, limit: number): { shown: string; cut: boolean } {
  if (value.length <= limit) return { shown: value, cut: false };
  // Google cuts to the word, not the character.
  const clipped = value.slice(0, limit);
  const lastSpace = clipped.lastIndexOf(" ");
  return { shown: (lastSpace > limit * 0.6 ? clipped.slice(0, lastSpace) : clipped), cut: true };
}

function Result({
  meta,
  url,
  muted,
}: {
  meta: PageMeta;
  url: string;
  /** The baseline copy, drawn back so the proposed version reads as the answer. */
  muted?: boolean;
}) {
  const title = truncate(meta.title ?? "", LIMITS.title);
  const description = truncate(meta.description ?? "", LIMITS.description);

  return (
    <div className={`min-w-0 ${muted ? "opacity-70" : ""}`}>
      <p className="truncate text-[11px] text-[var(--color-ink-faint)]">{displayUrl(url)}</p>
      <p
        className={`mt-0.5 truncate text-[13px] font-medium ${
          muted ? "text-[var(--color-ink-soft)]" : "text-[var(--color-accent)]"
        }`}
        title={meta.title ?? ""}
      >
        {title.shown || <span className="italic text-[var(--color-ink-faint)]">No title</span>}
        {title.cut ? <span className="text-[var(--color-ink-faint)]">…</span> : null}
      </p>
      <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-[var(--color-ink-soft)]">
        {description.shown || (
          <span className="italic text-[var(--color-ink-faint)]">No description</span>
        )}
        {description.cut ? <span className="text-[var(--color-ink-faint)]">…</span> : null}
      </p>
    </div>
  );
}

export function MetaCompare({
  meta,
  baseline,
  url,
  baselineName,
}: {
  meta: PageMeta;
  baseline: PageMeta;
  url: string;
  /** What the left-hand column is, named — the live page, or a parent version. */
  baselineName: string;
}) {
  const titleChanged = (meta.title ?? "") !== (baseline.title ?? "");
  const descriptionChanged = (meta.description ?? "") !== (baseline.description ?? "");
  const changed = titleChanged || descriptionChanged;

  return (
    <div className="border-b border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3">
      <div className="mb-2 flex items-baseline gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">
          Search result
        </p>
        <p className="text-[10px] text-[var(--color-ink-faint)]">
          {changed
            ? `${[titleChanged ? "Title" : null, descriptionChanged ? "Description" : null]
                .filter(Boolean)
                .join(" and ")} changed`
            : "Unchanged so far — edit it in the panel on the right"}
        </p>
      </div>

      {/* Side by side while there is room, stacked when there is not: this sits
          above a preview that is itself already fighting for width. */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="min-w-0">
          <p className="mb-1 truncate text-[10px] uppercase tracking-wide text-[var(--color-ink-faint)]">
            {baselineName}
          </p>
          <Result meta={baseline} url={url} muted />
        </div>
        <div className="min-w-0">
          <p className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-ink-faint)]">
            Proposed
            {changed ? (
              <span className="ml-1.5 text-[var(--color-changed)]">●</span>
            ) : null}
          </p>
          <Result meta={meta} url={url} />
        </div>
      </div>
    </div>
  );
}
