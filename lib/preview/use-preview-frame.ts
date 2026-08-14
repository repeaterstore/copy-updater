"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Op } from "@/lib/ops/types";
import {
  PREVIEW_CHANNEL,
  isFrameMessage,
  type DiffHighlights,
  type HostMessage,
} from "./protocol";

/** The markup of something on the page, and the element it came from. */
export interface ReadMarkupResult {
  html: string;
  anchorId: string;
}

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
  /**
   * The real markup of a block, or of the section enclosing it.
   *
   * Resolves to null when the frame cannot find it, or does not answer within
   * a couple of seconds — a duplicate that never resolves would leave the
   * button spinning with nothing to say.
   */
  readMarkup: (id: string, enclosing: boolean) => Promise<ReadMarkupResult | null>;
}

export interface PreviewFrameHandlers {
  onBlockClicked?: (id: string) => void;
  onBlockEdited?: (id: string, html: string) => void;
  /** Enter was pressed mid-block: it becomes two. See the protocol. */
  onBlockSplit?: (id: string, before: string, after: string) => void;
  /** Which responsive convention the page's own CSS defines, if any. */
  onResponsive?: (recipeId: string | null, inlineDesktopOnly: string[] | null) => void;
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
  /** Resolvers for in-flight readMarkup calls, keyed by request id. */
  const markupWaiters = useRef(new Map<string, (result: ReadMarkupResult | null) => void>());
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  /**
   * The window we have seen announce itself, not a boolean.
   *
   * An iframe that unmounts and comes back — the mobile companion, every time
   * the device toggle leaves "both" and returns — gets a brand new document.
   * A boolean stayed true across that, so messages went out to a document that
   * had not yet installed its listener and were silently dropped: the phone sat
   * there showing the untouched page while the desktop frame showed the edits.
   */
  const readyWindow = useRef<Window | null>(null);

  const send = useCallback((message: HostMessage) => {
    const target = ref.current?.contentWindow ?? null;
    if (!target || readyWindow.current !== target) {
      // Every message carries complete state — the whole op list, the whole
      // highlight set — so a queued one is worth nothing once a newer one of
      // the same kind arrives. Replacing rather than appending keeps the queue
      // at one entry per kind; appending meant a frame that never became ready
      // accumulated a full op list per keystroke.
      const superseded = queue.current.findIndex((m) => m.type === message.type);
      if (superseded === -1) queue.current.push(message);
      else queue.current[superseded] = message;
      return;
    }
    target.postMessage(message, "*");
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
    const target = ref.current?.contentWindow ?? null;
    if (!target || readyWindow.current === target) return;
    readyWindow.current = target;
    setReady(true);
    const pending = queue.current;
    queue.current = [];
    for (const queued of pending) target.postMessage(queued, "*");
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
        case "blockSplit":
          handlersRef.current.onBlockSplit?.(message.id, message.before, message.after);
          break;
        case "responsive":
          handlersRef.current.onResponsive?.(message.recipeId, message.inlineDesktopOnly);
          break;
        case "applied":
          if (message.failures.length) {
            handlersRef.current.onApplyFailures?.(message.failures);
          }
          break;
        case "markup": {
          const pending = markupWaiters.current.get(message.requestId);
          if (pending) {
            markupWaiters.current.delete(message.requestId);
            pending(
              message.html && message.anchorId
                ? { html: message.html, anchorId: message.anchorId }
                : null,
            );
          }
          break;
        }
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

  const readMarkup = useCallback(
    (id: string, enclosing: boolean) =>
      new Promise<ReadMarkupResult | null>((resolve) => {
        const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        markupWaiters.current.set(requestId, resolve);
        // The frame is sandboxed third-party markup that could in principle
        // never reply; a caller waiting forever is worse than a caller told no.
        setTimeout(() => {
          if (markupWaiters.current.delete(requestId)) resolve(null);
        }, 2000);
        send({ channel: PREVIEW_CHANNEL, type: "readMarkup", requestId, id, enclosing });
      }),
    [send],
  );

  // Stable identity. Returning a fresh object each render makes this API an
  // ever-changing effect dependency in the workspace, so the debounced
  // "apply ops to the preview" effect tears down and rebuilds its timer on
  // every render instead of firing.
  return useMemo(
    () => ({
      ref, ready, onLoad: markReady, applyOps, setDiffMode, setEditable,
      selectBlock, scrollToBlock, readMarkup,
    }),
    [ready, markReady, applyOps, setDiffMode, setEditable, selectBlock, scrollToBlock, readMarkup],
  );
}
