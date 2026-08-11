"use client";

import { useEffect, useRef, useState } from "react";
import type { PreviewFrameApi } from "@/lib/preview/use-preview-frame";

export type Device = "desktop" | "mobile" | "both";

/** The width the frame is really rendered at, so the page's own media queries fire. */
const WIDTHS: Record<Exclude<Device, "both">, number> = { desktop: 1440, mobile: 390 };

/**
 * Room for the phone alongside the desktop frame.
 *
 * Fixed rather than a fraction: at 390px plus its bezel the phone renders
 * near 1:1, which is the whole point of looking at it, and the desktop frame
 * takes whatever is left and scales into it.
 */
export const COMPANION_WIDTH = 430;

/**
 * The snapshot iframe, rendered at a real device width and scaled to fit.
 *
 * Scaling rather than resizing matters: the snapshot's own media queries key
 * off the iframe's width, so the frame must genuinely be 390px wide for the
 * mobile layout to appear. A CSS transform then fits that into whatever space
 * the pane has, without touching layout.
 */
export function PreviewPane({
  frame,
  snapshotId,
  runtimeVersion,
  device,
  loading,
}: {
  frame: PreviewFrameApi;
  snapshotId: string;
  /** Content hash of the injected preview runtime; see the src below. */
  runtimeVersion: string;
  /** A single frame is always one real device; "both" is two of these. */
  device: Exclude<Device, "both">;
  loading?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measure = () => {
      const available = container.clientWidth - 32;
      const target = WIDTHS[device];
      // Never scale up: a mobile frame blown up to fill a wide pane looks
      // nothing like a phone.
      setScale(Math.min(1, available / target));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [device]);

  const width = WIDTHS[device];

  return (
    <div
      ref={containerRef}
      className="relative h-full overflow-auto bg-[var(--color-sunken)] p-4"
    >
      {loading ? (
        <div className="absolute inset-0 z-10 grid place-items-center bg-[var(--color-sunken)]/70">
          <span className="text-xs text-[var(--color-ink-soft)]">Loading snapshot…</span>
        </div>
      ) : null}

      <div
        className="mx-auto"
        style={{ width: width * scale }}
      >
        <div
          style={{
            width,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
          }}
          className={
            device === "mobile"
              ? "overflow-hidden rounded-[1.75rem] border-[10px] border-[var(--color-ink)] bg-white shadow-xl"
              : "overflow-hidden rounded-lg border border-[var(--color-line-strong)] bg-white shadow-sm"
          }
        >
          <iframe
            ref={frame.ref}
            title="Page preview"
            onLoad={frame.onLoad}
            // The runtime is injected server-side, so the response body changes
            // when the runtime does. Keying the URL on its hash stops the
            // browser reusing a stale copy — earlier builds served this path as
            // immutable for a year, so those entries need displacing.
            src={`/api/snapshots/${snapshotId}/html?rt=${runtimeVersion}`}
            width={width}
            // Tall enough that the snapshot's own scrolling is what the
            // reviewer uses, rather than a nested scrollbar.
            height={device === "mobile" ? 844 : 900}
            className="block border-0"
            // The snapshot is untrusted third-party markup. It needs
            // allow-scripts for our injected runtime, but deliberately not
            // allow-same-origin: postMessage works across an opaque origin, so
            // withholding it costs nothing and denies the snapshot access to
            // this app's cookies and storage. Granting both together would also
            // let the frame strip its own sandbox.
            sandbox="allow-scripts"
          />
        </div>
      </div>
    </div>
  );
}

const DEVICE_HINT: Record<Device, string> = {
  desktop: "Desktop only, 1440px",
  mobile: "Mobile only, 390px",
  both: "Desktop and mobile side by side — the phone stays near full size",
};

export function DeviceToggle({
  device,
  onChange,
}: {
  device: Device;
  onChange: (device: Device) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-[var(--color-line-strong)] p-0.5">
      {(["desktop", "mobile", "both"] as Device[]).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          title={DEVICE_HINT[option]}
          className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors ${
            device === option
              ? "bg-[var(--color-accent)] text-white"
              : "text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
          }`}
        >
          {option}
        </button>
      ))}
    </div>
  );
}
