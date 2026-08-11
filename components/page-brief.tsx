"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updatePageBriefAction } from "@/app/actions/pages";

/**
 * The page brief — brand voice, keywords, audience — feeds every AI request
 * for this page, so it has to be editable after capture, not just at it.
 */
export function PageBriefEditor({
  pageId,
  brief,
}: {
  pageId: string;
  brief: string | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(brief ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!editing) {
    return (
      <div className="panel mt-2 p-4">
        {brief ? (
          <p className="whitespace-pre-wrap text-sm text-[var(--color-ink-soft)]">{brief}</p>
        ) : (
          <p className="text-sm text-[var(--color-ink-faint)]">
            No brief yet. Brand voice, target keywords and audience notes here are
            given to the AI as context on every request for this page.
          </p>
        )}
        <button
          type="button"
          onClick={() => {
            setDraft(brief ?? "");
            setEditing(true);
          }}
          className="mt-2 text-[11px] text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
        >
          {brief ? "Edit brief" : "Add a brief"}
        </button>
      </div>
    );
  }

  return (
    <div className="panel mt-2 p-4">
      <textarea
        autoFocus
        rows={5}
        className="field resize-y text-sm"
        placeholder="Brand voice, target keywords, audience. Given to the AI as context on every request."
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          className="btn btn-primary"
          disabled={pending}
          onClick={() =>
            start(async () => {
              try {
                await updatePageBriefAction(pageId, draft);
                setEditing(false);
                router.refresh();
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            })
          }
        >
          {pending ? "Saving…" : "Save brief"}
        </button>
        <button type="button" className="btn" onClick={() => setEditing(false)}>
          Cancel
        </button>
        {error ? (
          <span className="text-[11px] text-[var(--color-removed)]">{error}</span>
        ) : null}
      </div>
    </div>
  );
}
