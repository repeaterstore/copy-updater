"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { recaptureAction } from "@/app/actions/pages";

/**
 * Capture runs detached from the request that started it, so the page polls
 * until the snapshot row settles.
 */
export function CaptureStatus({
  pageId,
  status,
  error,
  blockCount,
  capturedAt,
}: {
  pageId: string;
  status: string;
  error: string | null;
  blockCount: number;
  capturedAt: string | null;
}) {
  const router = useRouter();

  useEffect(() => {
    if (status !== "pending") return;
    const timer = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(timer);
  }, [status, router]);

  if (status === "pending") {
    return (
      <div className="panel mt-6 flex items-center gap-3 p-4">
        <span className="h-3 w-3 animate-pulse rounded-full bg-[var(--color-changed)]" />
        <div>
          <p className="text-sm font-medium">Capturing the page…</p>
          <p className="text-xs text-[var(--color-ink-soft)]">
            Loading it in a real browser and inlining every asset. Usually 30–60 seconds.
          </p>
        </div>
      </div>
    );
  }

  if (status === "failed") {
    return (
      <div className="panel mt-6 border-[var(--color-removed)] p-4">
        <p className="text-sm font-medium">Capture failed</p>
        <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
          {error ?? "Unknown error."}
        </p>
        <form
          className="mt-3"
          action={async () => {
            await recaptureAction(pageId);
          }}
        >
          <button type="submit" className="btn">
            Try again
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="mt-6 flex flex-wrap items-center gap-3 text-xs text-[var(--color-ink-soft)]">
      <span>
        {blockCount} copy blocks captured
        {capturedAt ? ` · ${new Date(capturedAt).toLocaleString()}` : ""}
      </span>
      <form
        action={async () => {
          await recaptureAction(pageId);
        }}
      >
        <button
          type="submit"
          className="text-[var(--color-ink-soft)] underline underline-offset-2 hover:text-[var(--color-ink)]"
          title="Capture the live page again. Existing versions keep their original snapshot."
        >
          Re-capture
        </button>
      </form>
    </div>
  );
}
