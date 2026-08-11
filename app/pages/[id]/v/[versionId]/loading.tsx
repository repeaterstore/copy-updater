/**
 * Shown the instant a version is clicked, while the workspace loads.
 *
 * Opening a version is genuinely slow work — the snapshot is resolved, the
 * version list and comments are read, and a page's worth of blocks is sent to
 * the browser. Without this, the click did nothing visible for seconds and the
 * natural reaction was to click again.
 *
 * It mirrors the three-pane layout rather than showing a spinner, so the
 * workspace appears to fill in rather than replace something.
 */
export default function Loading() {
  return (
    <div className="flex h-[calc(100vh-3rem)] animate-pulse flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-2">
        <div className="h-4 w-40 rounded bg-[var(--color-sunken)]" />
        <div className="h-4 w-14 rounded bg-[var(--color-sunken)]" />
        <div className="ml-auto h-4 w-28 rounded bg-[var(--color-sunken)]" />
      </div>

      {/* Same grid and the same breakpoint as the workspace itself, so the real
          panes land exactly where the placeholders were rather than jumping. */}
      <div className="grid min-h-0 flex-1 xl:grid-cols-[17rem_minmax(0,1fr)_22rem]">
        <div className="hidden space-y-2 border-r border-[var(--color-line)] p-3 xl:block">
          <div className="h-7 rounded bg-[var(--color-sunken)]" />
          {Array.from({ length: 9 }, (_, i) => (
            <div
              key={i}
              className="h-4 rounded bg-[var(--color-sunken)]"
              // Uneven widths read as a list of headings rather than a barcode.
              style={{ width: `${90 - ((i * 13) % 45)}%` }}
            />
          ))}
        </div>

        <div className="flex items-center justify-center p-6">
          <div className="h-full w-full max-w-3xl rounded-lg bg-[var(--color-sunken)]" />
        </div>

        <div className="hidden space-y-3 border-l border-[var(--color-line)] p-3 xl:block">
          <div className="h-3 w-24 rounded bg-[var(--color-sunken)]" />
          <div className="h-16 rounded bg-[var(--color-sunken)]" />
          <div className="h-3 w-20 rounded bg-[var(--color-sunken)]" />
          <div className="h-24 rounded bg-[var(--color-sunken)]" />
        </div>
      </div>
    </div>
  );
}
