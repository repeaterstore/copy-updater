"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addCommentAction,
  deleteCommentAction,
  editCommentAction,
  resolveCommentAction,
} from "@/app/actions/versions";
import { DESIGN_TAG, isForDesigner } from "@/lib/comments/tags";
import { ConfirmDeleteButton } from "@/components/confirm-delete-button";

export interface CommentItem {
  id: string;
  blockId: string | null;
  body: string;
  resolved: boolean;
  createdAt: string;
  author: string;
  /** Whether the signed-in reader wrote it, and so may edit or delete it. */
  isMine: boolean;
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
  const forDesigner = isForDesigner(body);

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
            <CommentRow key={comment.id} comment={comment} />
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

      {/* The tag is the whole routing mechanism, so it cannot be folklore.
          Clicking it writes the tag rather than explaining it. */}
      <div className="mt-1 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setBody((current) => (isForDesigner(current) ? current : `${DESIGN_TAG} ${current}`.trim()))}
          title="Address this to the designer — it appears in the design list, not the copy review"
          className={`chip border ${
            forDesigner
              ? "border-transparent bg-[var(--color-comment)] text-white"
              : "border-[var(--color-line-strong)] text-[var(--color-ink-soft)]"
          }`}
        >
          {DESIGN_TAG}
        </button>
        {forDesigner ? (
          <span className="text-[10px] text-[var(--color-ink-faint)]">
            Goes to the designer’s list
          </span>
        ) : null}
      </div>
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

/**
 * One comment, and what its author may do with it.
 *
 * Edit and delete are offered only on your own, and the server checks the same
 * thing — the panel not showing a button is not the same as the server
 * refusing the call. Resolve stays open to everyone: that is a statement about
 * whether the work has been done, not about the note.
 */
function CommentRow({ comment }: { comment: CommentItem }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [error, setError] = useState<string | null>(null);

  const run = (action: () => Promise<{ error?: string } | void>) =>
    start(async () => {
      const result = await action();
      if (result && "error" in result && result.error) {
        setError(result.error);
        return;
      }
      setError(null);
      setEditing(false);
      router.refresh();
    });

  return (
    <li
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
          {isForDesigner(comment.body) ? (
            <span
              className="ml-1.5 rounded px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-[var(--color-comment)] ring-1 ring-[var(--color-comment)]"
              title="Listed for the designer, not for the copy review"
            >
              design
            </span>
          ) : null}
        </span>
        <button
          type="button"
          className="shrink-0 text-[10px] text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
          onClick={() => run(() => resolveCommentAction(comment.id, !comment.resolved))}
        >
          {comment.resolved ? "Reopen" : "Resolve"}
        </button>
      </div>

      {editing ? (
        <div className="mt-1">
          <textarea
            rows={3}
            autoFocus
            className="field resize-y text-xs"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              disabled={pending || draft.trim() === ""}
              className="btn px-2 py-0.5 text-[11px]"
              onClick={() => run(() => editCommentAction(comment.id, draft))}
            >
              {pending ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="text-[11px] text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
              onClick={() => {
                setDraft(comment.body);
                setEditing(false);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="mt-1 whitespace-pre-wrap text-[var(--color-ink-soft)]">{comment.body}</p>
          {comment.isMine ? (
            <div className="mt-1 flex items-center gap-2">
              <button
                type="button"
                className="text-[10px] text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
                onClick={() => {
                  setDraft(comment.body);
                  setEditing(true);
                }}
              >
                Edit
              </button>
              <ConfirmDeleteButton
                quiet
                label="Delete"
                confirmText="Delete this comment?"
                onConfirm={async () => {
                  const result = await deleteCommentAction(comment.id);
                  if (result.error) throw new Error(result.error);
                }}
              />
            </div>
          ) : null}
        </>
      )}

      {error ? (
        <p className="mt-1 text-[10px] text-[var(--color-removed)]">{error}</p>
      ) : null}
    </li>
  );
}
