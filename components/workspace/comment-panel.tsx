"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addCommentAction, resolveCommentAction } from "@/app/actions/versions";

export interface CommentItem {
  id: string;
  blockId: string | null;
  body: string;
  resolved: boolean;
  createdAt: string;
  author: string;
}

export function CommentPanel({
  versionId,
  blockId,
  comments,
}: {
  versionId: string;
  blockId: string | null;
  comments: CommentItem[];
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [pending, start] = useTransition();

  const scoped = comments.filter((c) => c.blockId === blockId);

  return (
    <section className="border-t border-[var(--color-line)] pt-3">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">
        Comments {blockId ? "on this block" : "on the meta fields"}
      </p>

      {scoped.length === 0 ? (
        <p className="mb-2 text-xs text-[var(--color-ink-faint)]">None yet.</p>
      ) : (
        <ul className="mb-2 space-y-2">
          {scoped.map((comment) => (
            <li
              key={comment.id}
              className={`rounded-md border border-[var(--color-line)] p-2 text-xs ${
                comment.resolved ? "opacity-55" : ""
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{comment.author}</span>
                <button
                  type="button"
                  className="text-[10px] text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
                  onClick={() =>
                    start(async () => {
                      await resolveCommentAction(comment.id, !comment.resolved);
                      router.refresh();
                    })
                  }
                >
                  {comment.resolved ? "Reopen" : "Resolve"}
                </button>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-[var(--color-ink-soft)]">
                {comment.body}
              </p>
            </li>
          ))}
        </ul>
      )}

      <textarea
        rows={2}
        className="field resize-y text-xs"
        placeholder="Leave a note for whoever reviews this…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <button
        type="button"
        className="btn mt-1.5 w-full justify-center"
        disabled={pending || body.trim() === ""}
        onClick={() =>
          start(async () => {
            await addCommentAction({ versionId, blockId, body });
            setBody("");
            router.refresh();
          })
        }
      >
        {pending ? "Posting…" : "Comment"}
      </button>
    </section>
  );
}
