"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PreviewFrameApi } from "@/lib/preview/use-preview-frame";

export type Device = "desktop" | "mobile" | "both";

/** The width the frame is really rendered at, so the page's own media queries fire. */
const WIDTHS: Record<Exclude<Device, "both">, number> = { desktop: 1440, mobile: 390 };
const HEIGHTS: Record<Exclude<Device, "both">, number> = { desktop: 900, mobile: 844 };

/** Zoom levels offered for the phone. 1 is life size. */
export const PHONE_ZOOMS = [0.5, 0.75, 1, 1.25, 1.5] as const;

/** Width the phone pane needs at a given zoom: the frame plus its bezel and padding. */
export function phonePaneWidth(zoom: number): number {
  return Math.round(WIDTHS.mobile * zoom) + 60;
}

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
  zoom = 1,
  loading,
}: {
  frame: PreviewFrameApi;
  snapshotId: string;
  /** Content hash of the injected preview runtime; see the src below. */
  runtimeVersion: string;
  /** A single frame is always one real device; "both" is two of these. */
  device: Exclude<Device, "both">;
  /** Largest scale to draw at. Fitting the pane can still force it smaller. */
  zoom?: number;
  loading?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const available = container.clientWidth - 32;
    // Never larger than asked for, and never wider than the pane. Automatic
    // enlargement is still wrong — a phone blown up to fill a wide pane looks
    // nothing like a phone — but zoom is a deliberate choice, so it may.
    const next = Math.min(zoom, available / WIDTHS[device]);
    setScale((current) =>
      // Ignore hairline differences. Scale decides the content's size, and the
      // content's size decides whether a scrollbar appears, which changes the
      // width this is measured from — so reacting to every pixel lets the two
      // chase each other around a render loop.
      Math.abs(current - next) < 0.005 ? current : next,
    );
  }, [device, zoom]);

  /*
   * Measured after every render, not only when the pane itself resizes.
   *
   * A ResizeObserver alone left the desktop frame at whatever scale it had when
   * the phone appeared beside it: the pane narrowed, but the frame stayed 983px
   * wide inside 565px of pane and simply overflowed. Re-measuring on render
   * costs one clientWidth read and catches every cause — a sibling appearing,
   * the zoom changing, the panel toggling — rather than the one the observer
   * happens to see. setScale with an unchanged value is a no-op in React.
   */
  useLayoutEffect(measure);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [measure]);

  const width = WIDTHS[device];
  const height = HEIGHTS[device];

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

      {/* Height as well as width. A CSS transform does not change the layout
          box, so scaling only the width left the frame's full unscaled height
          reserved underneath it — a 1440x900 desktop frame at half size sat in
          900px of layout, trailing 450px of empty pane below the page. */}
      <div
        className="mx-auto"
        style={{ width: width * scale, height: height * scale }}
      >
        <div
          style={{
            width,
            height,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
          }}
          className={
            device === "mobile"
              ? // Rounded at the bottom only. A phone's screen curves at every
                // corner, but the web page does not sit in the whole screen —
                // in Safari it starts below the address bar against a straight
                // edge, so rounding the top corners crops copy that a visitor
                // would actually see square.
                "overflow-hidden rounded-b-[1.75rem] border-[10px] border-[var(--color-ink)] bg-white shadow-xl"
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
            height={height}
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
