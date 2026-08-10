"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createVersionAction } from "@/app/actions/versions";

export interface VersionBase {
  id: string;
  label: string;
  status: string;
  authorName: string | null;
}

export function NewVersionButton({
  pageId,
  parentVersionId,
  label = "New version",
  seedLabel,
  bases,
}: {
  pageId: string;
  /** Fixed parent (the workspace Fork button). Omit to let the user choose. */
  parentVersionId: string | null;
  label?: string;
  seedLabel?: string;
  /**
   * Versions offered as a starting point. When present the user is asked what
   * to base the new version on, instead of silently starting from the live
   * page — which produced unrelated roots on the same page and diffs that
   * ignored a proposal already in flight.
   */
  bases?: VersionBase[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(seedLabel ?? "");
  const [base, setBase] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const asksForBase = !parentVersionId && (bases?.length ?? 0) > 0;

  if (!open) {
    return (
      <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  }

  const create = () =>
    start(async () => {
      try {
        const { id } = await createVersionAction({
          pageId,
          parentVersionId: parentVersionId ?? (base || null),
          label: name,
        });
        router.push(`/pages/${pageId}/v/${id}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });

  return (
    <div className="panel flex flex-wrap items-center gap-2 p-2">
      {asksForBase ? (
        <label className="flex items-center gap-1.5 text-[11px] text-[var(--color-ink-soft)]">
          Start from
          <select
            className="field w-auto py-1 text-xs"
            value={base}
            onChange={(e) => setBase(e.target.value)}
          >
            <option value="">The live page (as captured)</option>
            {bases!.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
                {b.authorName ? ` — ${b.authorName}` : ""} ({b.status})
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <input
        autoFocus
        className="field w-56 py-1 text-xs"
        placeholder={parentVersionId ? "Forked from…" : "e.g. Hero rewrite"}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
          if (e.key === "Enter") create();
        }}
      />
      <button type="button" className="btn btn-primary" disabled={pending} onClick={create}>
        {pending ? "Creating…" : "Create"}
      </button>
      <button type="button" className="btn" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {asksForBase ? (
        <p className="w-full text-[11px] text-[var(--color-ink-faint)]">
          {base
            ? "Inherits that version's edits, and changes are shown against it."
            : "Starts from the page as captured, ignoring any proposals in flight."}
        </p>
      ) : null}
      {error ? <p className="w-full text-xs text-[var(--color-removed)]">{error}</p> : null}
    </div>
  );
}
