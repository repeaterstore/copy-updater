"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Op } from "@/lib/ops/types";
import {
  PREVIEW_CHANNEL,
  isFrameMessage,
  type DiffHighlights,
  type HostMessage,
} from "./protocol";

export interface PreviewFrameApi {
  ref: React.RefObject<HTMLIFrameElement | null>;
  ready: boolean;
  /** Attach to the iframe's onLoad. See markReady() for why this is needed. */
  onLoad: () => void;
  applyOps: (ops: Op[]) => void;
  setDiffMode: (on: boolean, highlights: DiffHighlights | null) => void;
  setEditable: (on: boolean) => void;
  selectBlock: (id: string | null) => void;
  scrollToBlock: (id: string) => void;
}

export interface PreviewFrameHandlers {
  onBlockClicked?: (id: string) => void;
  onBlockEdited?: (id: string, html: string) => void;
  onApplyFailures?: (failures: { id: string; reason: string }[]) => void;
}

/**
 * Drives the snapshot iframe.
 *
 * Messages sent before the runtime reports "ready" are queued rather than
 * dropped — the iframe carries megabytes of inlined CSS and routinely finishes
 * loading well after React has decided what to show.
 */
export function usePreviewFrame(handlers: PreviewFrameHandlers): PreviewFrameApi {
  const ref = useRef<HTMLIFrameElement | null>(null);
  const [ready, setReady] = useState(false);
  const queue = useRef<HostMessage[]>([]);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const readyRef = useRef(false);

  const send = useCallback((message: HostMessage) => {
    const frame = ref.current;
    if (!readyRef.current || !frame?.contentWindow) {
      queue.current.push(message);
      return;
    }
    frame.contentWindow.postMessage(message, "*");
  }, []);

  /**
   * Mark the frame live and flush anything queued while it was loading.
   *
   * Called from two places on purpose. Normally the runtime announces itself
   * with a "ready" message. But snapshots are served immutable, so on a remount
   * (any router.refresh, e.g. after a save) the iframe can load from cache and
   * post "ready" before this component's effect has attached its listener — the
   * message is then lost and the preview sits on "Loading snapshot…" forever.
   * The iframe's own load event is the backstop; both paths are idempotent.
   */
  const markReady = useCallback(() => {
    if (readyRef.current) return;
    readyRef.current = true;
    setReady(true);
    const pending = queue.current;
    queue.current = [];
    for (const queued of pending) {
      ref.current?.contentWindow?.postMessage(queued, "*");
    }
  }, []);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!isFrameMessage(event.data)) return;
      // Only trust messages from the frame we own.
      if (ref.current && event.source !== ref.current.contentWindow) return;

      const message = event.data;
      switch (message.type) {
        case "ready":
          markReady();
          break;
        case "blockClicked":
          handlersRef.current.onBlockClicked?.(message.id);
          break;
        case "blockEdited":
          handlersRef.current.onBlockEdited?.(message.id, message.html);
          break;
        case "applied":
          if (message.failures.length) {
            handlersRef.current.onApplyFailures?.(message.failures);
          }
          break;
      }
    }

    window.addEventListener("message", onMessage);

    // The frame may already have loaded and announced itself before this effect
    // ran — check rather than wait for a message that has been and gone.
    if (ref.current?.contentWindow && ref.current.contentDocument?.readyState === "complete") {
      markReady();
    }

    return () => window.removeEventListener("message", onMessage);
  }, [markReady]);

  const applyOps = useCallback(
    (ops: Op[]) => send({ channel: PREVIEW_CHANNEL, type: "applyOps", ops }),
    [send],
  );
  const setDiffMode = useCallback(
    (on: boolean, highlights: DiffHighlights | null) =>
      send({ channel: PREVIEW_CHANNEL, type: "setDiffMode", on, highlights }),
    [send],
  );
  const setEditable = useCallback(
    (on: boolean) => send({ channel: PREVIEW_CHANNEL, type: "setEditable", on }),
    [send],
  );
  const selectBlock = useCallback(
    (id: string | null) => send({ channel: PREVIEW_CHANNEL, type: "selectBlock", id }),
    [send],
  );
  const scrollToBlock = useCallback(
    (id: string) => send({ channel: PREVIEW_CHANNEL, type: "scrollToBlock", id }),
    [send],
  );

  // Stable identity. Returning a fresh object each render makes this API an
  // ever-changing effect dependency in the workspace, so the debounced
  // "apply ops to the preview" effect tears down and rebuilds its timer on
  // every render instead of firing.
  return useMemo(
    () => ({ ref, ready, onLoad: markReady, applyOps, setDiffMode, setEditable, selectBlock, scrollToBlock }),
    [ready, markReady, applyOps, setDiffMode, setEditable, selectBlock, scrollToBlock],
  );
}
