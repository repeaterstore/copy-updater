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

/** "just now" / "5m ago" / "3h ago" / "2d ago" / a date beyond a week. */
function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const days = hours / 24;
  if (days < 7) return `${Math.floor(days)}d ago`;
  return new Date(iso).toLocaleDateString();
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
                <span className="min-w-0">
                  <span className="font-medium">{comment.author}</span>
                  <span
                    className="ml-1.5 text-[10px] text-[var(--color-ink-faint)]"
                    title={new Date(comment.createdAt).toLocaleString()}
                  >
                    {timeAgo(comment.createdAt)}
                  </span>
                </span>
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
