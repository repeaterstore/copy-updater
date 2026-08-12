"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PreviewFrameApi } from "@/lib/preview/use-preview-frame";

export type Device = "desktop" | "mobile" | "both";

/**
 * A size the frame is really rendered at, so the page's own media queries fire.
 *
 * Breakpoints are the reason this is a list rather than one desktop width. A
 * page that reads well at 1440 can collapse into a mess at 1024 — the width
 * where two columns become one is exactly where copy that fitted stops
 * fitting — and that is invisible until you look at it.
 */
export interface Viewport {
  id: string;
  label: string;
  /** Shown next to the label; the number is what a reviewer recognises. */
  width: number;
  height: number;
}

export const WIDE_VIEWPORTS: Viewport[] = [
  { id: "desktop", label: "Desktop", width: 1440, height: 900 },
  { id: "laptop", label: "Laptop", width: 1280, height: 800 },
  { id: "tablet", label: "Tablet", width: 1024, height: 768 },
  { id: "tablet-portrait", label: "Tablet portrait", width: 768, height: 1024 },
];

export const MOBILE_VIEWPORT: Viewport = {
  id: "mobile",
  label: "Phone",
  width: 390,
  height: 844,
};

export const DEFAULT_WIDE_VIEWPORT = WIDE_VIEWPORTS[0];

export function wideViewport(id: string): Viewport {
  return WIDE_VIEWPORTS.find((v) => v.id === id) ?? DEFAULT_WIDE_VIEWPORT;
}

/** Zoom levels offered for the phone. 1 is life size. */
export const PHONE_ZOOMS = [0.5, 0.75, 1, 1.25, 1.5] as const;

/** Width the phone pane wants at a given zoom: the frame plus its bezel and padding. */
export function phonePaneWidth(zoom: number): number {
  return Math.round(MOBILE_VIEWPORT.width * zoom) + 60;
}

/**
 * Narrowest either pane may be squeezed to before it stops being useful.
 *
 * Below roughly this the frame is scaled so far down that the copy is no
 * longer legible, which defeats the point of showing it at all — better to let
 * the two stack than to shrink both into illegibility.
 */
export const MIN_PANE_WIDTH = 260;

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
  viewport,
  phone = false,
  zoom = 1,
  fit = false,
  loading,
}: {
  frame: PreviewFrameApi;
  snapshotId: string;
  /** Content hash of the injected preview runtime; see the src below. */
  runtimeVersion: string;
  /** The size to render at; "both" is two of these panes. */
  viewport: Viewport;
  /** Draw the phone bezel rather than a browser-window border. */
  phone?: boolean;
  /** Largest scale to draw at. Fitting the pane can still force it smaller. */
  zoom?: number;
  /**
   * Take only the height the scaled frame needs, rather than filling the pane.
   *
   * Stacked, two full-height panes would each scroll inside themselves inside
   * a scrolling column — three scrollbars for two frames. Sized to content,
   * there is one.
   */
  fit?: boolean;
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
    const next = Math.min(zoom, available / viewport.width);
    setScale((current) =>
      // Ignore hairline differences. Scale decides the content's size, and the
      // content's size decides whether a scrollbar appears, which changes the
      // width this is measured from — so reacting to every pixel lets the two
      // chase each other around a render loop.
      Math.abs(current - next) < 0.005 ? current : next,
    );
  }, [viewport.width, zoom]);

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

  const { width, height } = viewport;

  return (
    <div
      ref={containerRef}
      className={`relative bg-[var(--color-sunken)] p-4 ${
        fit ? "overflow-x-auto" : "h-full overflow-auto"
      }`}
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
            phone
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
  desktop: "The wide viewport only, at the width chosen beside this",
  mobile: "The phone only, 390px",
  both: "Both at once — side by side, or stacked when the pane is narrow",
};

/** Width picker for the wide frame: desktop, laptop, tablet, tablet portrait. */
export function ViewportSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-[var(--color-ink-soft)]">
      <span className="sr-only">Width</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        title="Width the wide frame is rendered at, so the page's own breakpoints fire"
        className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-1.5 py-1 text-xs text-[var(--color-ink)]"
      >
        {WIDE_VIEWPORTS.map((v) => (
          <option key={v.id} value={v.id}>
            {v.label} · {v.width}
          </option>
        ))}
      </select>
    </label>
  );
}

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
