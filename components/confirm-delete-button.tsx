"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Two-step delete: the first click arms it and shows what is about to go, the
 * second actually deletes. No modal — the confirm copy sits right where the
 * button was, so there is no doubt about what "Delete" refers to.
 */
export function ConfirmDeleteButton({
  label = "Delete",
  confirmText,
  onConfirm,
  quiet = false,
}: {
  label?: string;
  /** Shown between arming and confirming, e.g. 'Delete "Hero rewrite"?' */
  confirmText: string;
  onConfirm: () => Promise<void>;
  /** Renders the armed button as a plain text link rather than a boxed button. */
  quiet?: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className={
          quiet
            ? "text-[11px] text-[var(--color-ink-faint)] hover:text-[var(--color-removed)]"
            : "btn"
        }
      >
        {label}
      </button>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="text-[11px] text-[var(--color-ink-soft)]">{confirmText}</span>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            try {
              await onConfirm();
              router.refresh();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
              setConfirming(false);
            }
          })
        }
        className="btn border-[var(--color-removed)] py-0.5 text-[11px] text-[var(--color-removed)]"
      >
        {pending ? "Deleting…" : "Yes, delete"}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="text-[11px] text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
      >
        Cancel
      </button>
      {error ? (
        <span className="text-[11px] text-[var(--color-removed)]">{error}</span>
      ) : null}
    </span>
  );
}
