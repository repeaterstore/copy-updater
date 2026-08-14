"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { resolveCommentAction } from "@/app/actions/versions";
import type { DesignNote } from "@/lib/comments/notes";

/**
 * One design note, with the two things a designer does with it: read what it is
 * attached to, and mark it done.
 *
 * The link carries the block id, so opening it selects that element and scrolls
 * the preview to it — a note about "the wrong building" is unactionable if
 * finding the building is the designer's problem.
 */
export function DesignNoteRow({ note }: { note: DesignNote }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  // Optimistic: the round trip is a revalidation, and a checkbox that waits for
  // the server to agree feels broken on a list you are working through.
  const [resolved, setResolved] = useState(note.resolved);

  const href = note.blockId
    ? `/pages/${note.pageId}/v/${note.versionId}?block=${encodeURIComponent(note.blockId)}`
    : `/pages/${note.pageId}/v/${note.versionId}`;

  return (
    <li
      className={`rounded-lg border border-[var(--color-line)] px-3 py-2.5 transition-opacity ${
        resolved ? "opacity-55" : ""
      }`}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={resolved}
          disabled={pending}
          aria-label={resolved ? "Mark as still to do" : "Mark as done"}
          onChange={(event) => {
            const next = event.target.checked;
            setResolved(next);
            start(async () => {
              await resolveCommentAction(note.id, next);
              router.refresh();
            });
          }}
          className="mt-0.5 shrink-0"
        />

        <div className="min-w-0 flex-1">
          <p className={`text-sm ${resolved ? "line-through" : ""}`}>{note.body}</p>

          {note.blockRole === "image" ? (
            // Checked before the text, because an image has none — testing text
            // first filed every image note under the page title.
            <p className="mt-1 text-[11px] text-[var(--color-ink-faint)]">on an image</p>
          ) : note.blockText ? (
            <p className="mt-1 truncate text-[11px] text-[var(--color-ink-faint)]">
              on “{note.blockText}”
            </p>
          ) : note.blockId ? (
            <p className="mt-1 text-[11px] text-[var(--color-ink-faint)]">
              on a block that is no longer on the page
            </p>
          ) : (
            <p className="mt-1 text-[11px] text-[var(--color-ink-faint)]">
              on the page title and description
            </p>
          )}

          <p className="mt-1 text-[11px] text-[var(--color-ink-faint)]">
            {note.author} · {note.versionLabel} ·{" "}
            <Link href={href} className="hover:text-[var(--color-ink)] hover:underline">
              open in the page
            </Link>
          </p>
        </div>
      </div>
    </li>
  );
}
