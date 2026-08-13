"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Block, Op, PageMeta } from "@/lib/ops/types";
import { assignNewIds } from "@/lib/ops/ids";
import { sanitizeHtml } from "@/lib/ops/sanitize";
import { usePreviewFrame } from "@/lib/preview/use-preview-frame";
import {
  deriveBlocks,
  metaOverrides,
  sectionScopeFor,
  structuralHighlights,
  structuralOps,
  type DerivedBlock,
} from "@/lib/workspace/derive";
import {
  createVersionAction,
  renameVersionAction,
  saveOpsAction,
  setVersionStatusAction,
} from "@/app/actions/versions";
import type { VersionStatus } from "@/db/schema";
import { orderByLineage, SNAPSHOT_BASELINE, type LineageRow } from "@/lib/version-tree";
import { AiPanel, type AiConfig } from "./ai-panel";
import { CommentPanel, type CommentItem } from "./comment-panel";
import {
  DEFAULT_WIDE_VIEWPORT,
  DeviceToggle,
  MIN_PANE_WIDTH,
  MOBILE_VIEWPORT,
  PHONE_ZOOMS,
  phonePaneWidth,
  PreviewPane,
  ViewportSelect,
  wideViewport,
  type Device,
} from "./preview-pane";
import { InspectorPane } from "./inspector-pane";
import { OutlinePane } from "./outline-pane";

export interface WorkspaceVersion {
  id: string;
  label: string;
  status: VersionStatus;
  authorName: string | null;
  /** False when someone else authored it; drives the fork prompt. */
  isMine: boolean;
  parentVersionId: string | null;
  createdAt: string;
}

type Pane = "outline" | "preview" | "inspector";

export function Workspace({
  pageId,
  snapshotId,
  runtimeVersion,
  version,
  versions,
  initialOps,
  baselineBlocks,
  baselineMeta,
  compareVersionId,
  baselineOps,
  aiConfig,
  comments,
}: {
  pageId: string;
  snapshotId: string;
  runtimeVersion: string;
  version: WorkspaceVersion;
  versions: WorkspaceVersion[];
  initialOps: Op[];
  baselineBlocks: Block[];
  baselineMeta: PageMeta;
  compareVersionId: string | null;
  /** Ops that turn the snapshot into the baseline; replayed while Before is held. */
  baselineOps: Op[];
  aiConfig: AiConfig;
  // Plain data, not a render prop: functions cannot cross the server/client
  // boundary, so the panels are composed here rather than passed in.
  comments: CommentItem[];
}) {
  const router = useRouter();
  const [ops, setOps] = useState<Op[]>(initialOps);
  const [savedOps, setSavedOps] = useState<Op[]>(initialOps);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [device, setDevice] = useState<Device>("desktop");
  const [diffMode, setDiffMode] = useState(true);
  const [editMode, setEditMode] = useState(true);
  const [pane, setPane] = useState<Pane>("preview");
  const [problems, setProblems] = useState<string[]>([]);
  const [isSaving, startSaving] = useTransition();

  const readOnly = version.status === "approved";
  const dirty = useMemo(
    () => JSON.stringify(ops) !== JSON.stringify(savedOps),
    [ops, savedOps],
  );

  const derived = useMemo(
    () => deriveBlocks(baselineBlocks, ops),
    [baselineBlocks, ops],
  );
  const derivedById = useMemo(
    () => new Map(derived.map((d) => [d.block.id, d])),
    [derived],
  );
  const meta = useMemo<PageMeta>(
    () => ({ ...baselineMeta, ...metaOverrides(ops) }),
    [baselineMeta, ops],
  );
  const metaChanged = useMemo(
    () => JSON.stringify(meta) !== JSON.stringify(baselineMeta),
    [meta, baselineMeta],
  );
  const pending = useMemo(() => structuralOps(ops), [ops]);

  const lineage = useMemo(() => orderByLineage(versions), [versions]);
  const parentLabel = useMemo(
    () => versions.find((v) => v.id === version.parentVersionId)?.label ?? null,
    [versions, version.parentVersionId],
  );

  /** The section the current selection sits in, for section-scoped requests. */
  const section = useMemo(
    () => sectionScopeFor(derived, selectedId),
    [derived, selectedId],
  );

  const describeBlock = useCallback(
    (id: string) => {
      const found = derivedById.get(id);
      return found ? { text: found.text, role: found.block.role } : null;
    },
    [derivedById],
  );

  // The frame's click handler is created once, so it needs a live view of the
  // block map rather than the value captured at first render.
  const derivedByIdRef = useRef(derivedById);
  derivedByIdRef.current = derivedById;

  const frame = usePreviewFrame({
    onBlockClicked: (id) => {
      // Every element in the snapshot carries an id, but only some are editable
      // blocks. Selecting an unknown one used to leave the inspector with
      // nothing to show, so it fell back to the meta editor — which read as the
      // click having done nothing. Keep the current selection instead.
      if (!derivedByIdRef.current.has(id)) return;
      setSelectedId(id);
      setPane("inspector");
    },
    onBlockEdited: (id, html) => upsertText(id, html),
    onApplyFailures: (failures) =>
      setProblems(failures.map((f) => `${f.id || "(unknown)"}: ${f.reason}`)),
  });

  /**
   * The phone shown beside the desktop frame.
   *
   * It takes the same handlers, so copy can be clicked and typed on either
   * frame. Only the focused frame receives key events, so only it reports an
   * edit; the other simply has the resulting op applied to it like any other
   * change. Each hook ignores messages that did not come from its own window.
   */
  const companion = usePreviewFrame({
    onBlockClicked: (id) => {
      if (!derivedByIdRef.current.has(id)) return;
      setSelectedId(id);
      setPane("inspector");
    },
    onBlockEdited: (id, html) => upsertText(id, html),
    onApplyFailures: (failures) =>
      setProblems(failures.map((f) => `${f.id || "(unknown)"}: ${f.reason}`)),
  });
  const showCompanion = device === "both";
  /** Life size by default; the pane widens and narrows with this. */
  const [phoneZoom, setPhoneZoom] = useState(1);
  /** Which width the wide frame renders at — desktop, laptop or tablet. */
  const [wideId, setWideId] = useState(DEFAULT_WIDE_VIEWPORT.id);
  const wide = wideViewport(wideId);

  /**
   * Side by side until there is not enough room, then stacked.
   *
   * Measured from the preview area rather than the window, because the two
   * side panels are what actually take the space away: the same window is
   * roomy with the inspector closed and cramped with it open. Below the
   * threshold both frames would be scaled past legibility, and one above the
   * other — each at the full width of the pane — reads better than two
   * illegible columns.
   */
  const previewRef = useRef<HTMLElement | null>(null);
  const [stacked, setStacked] = useState(false);
  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      // Hysteresis: switching back exactly at the threshold would flip modes
      // on every pixel of a drag, because the layout it switches to changes
      // the width being measured.
      setStacked((was) => (was ? width < MIN_PANE_WIDTH * 2 + 80 : width < MIN_PANE_WIDTH * 2));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /**
   * Once the phone has been asked for, keep it mounted and just hide it.
   *
   * Unmounting it would throw away a loaded snapshot that can run to tens of
   * megabytes, so every trip through the device toggle would re-download and
   * re-parse the whole page.
   */
  const [companionMounted, setCompanionMounted] = useState(false);
  useEffect(() => {
    if (showCompanion) setCompanionMounted(true);
  }, [showCompanion]);

  const [showingBefore, setShowingBefore] = useState(false);

  // Releasing outside the button, or losing the window mid-hold, must not leave
  // the preview stuck showing the old copy.
  useEffect(() => {
    if (!showingBefore) return;
    const release = () => setShowingBefore(false);
    window.addEventListener("pointerup", release);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("blur", release);
    };
  }, [showingBefore]);

  // Push the current op list into the preview. Debounced: typing produces an op
  // per keystroke and each apply replays the whole list against the snapshot.
  // Keyed on frame.ready as well as ops, so the list is (re)sent once the
  // snapshot finishes loading — a 20 MB page can take tens of seconds, by which
  // time the initial send has long since happened.
  //
  // Applying rewrites the edited element, so the runtime saves and restores the
  // caret around it; see preserveCaret in lib/browser/preview-entry.ts. Holding
  // the echo back here instead looks tempting and is wrong: the typed text
  // would then exist only in the frame's DOM, with no undo entry, and "Revert
  // to original" would clear the op while leaving the text on screen.
  const applyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // Holding "Before" should feel like a light switch, so it skips the debounce
    // that exists to stop every keystroke replaying the list.
    const list = showingBefore ? baselineOps : ops;
    const delay = showingBefore ? 0 : 180;
    if (applyTimer.current) clearTimeout(applyTimer.current);
    applyTimer.current = setTimeout(() => {
      frame.applyOps(list);
      if (showCompanion) companion.applyOps(list);
    }, delay);
    return () => {
      if (applyTimer.current) clearTimeout(applyTimer.current);
    };
  }, [
    ops, baselineOps, showingBefore, frame, frame.ready,
    companion, companion.ready, showCompanion,
  ]);

  useEffect(() => {
    // Never editable while the previous wording is on screen: a keystroke there
    // would be recorded as an edit to text this version had already replaced.
    const on = editMode && !readOnly && !showingBefore;
    frame.setEditable(on);
    if (showCompanion) companion.setEditable(on);
  }, [editMode, readOnly, showingBefore, frame, companion, showCompanion]);

  /** Unresolved comments per block. Resolved ones are deliberately excluded. */
  const commentCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const comment of comments) {
      if (comment.resolved || !comment.blockId) continue;
      counts[comment.blockId] = (counts[comment.blockId] ?? 0) + 1;
    }
    return counts;
  }, [comments]);

  useEffect(() => {
    if (!diffMode) {
      frame.setDiffMode(false, null);
      if (showCompanion) companion.setDiffMode(false, null);
      return;
    }
    const changed = derived.filter((d) => d.changed).map((d) => d.block.id);
    const risk = derived.filter((d) => d.layoutRisk).map((d) => d.block.id);
    // Straight from the ops. The preview has already applied them, so an
    // inserted element is in its DOM waiting to be marked — these were empty
    // arrays, which is why layout mode's work arrived unannounced.
    const { added, moved } = structuralHighlights(ops);
    const highlights = {
      changed,
      added,
      // Nothing to paint: a removed element is no longer in the page.
      removed: [],
      moved,
      layoutRisk: risk,
      comments: commentCounts,
    };
    frame.setDiffMode(true, highlights);
    if (showCompanion) companion.setDiffMode(true, highlights);
  }, [diffMode, derived, ops, commentCounts, frame, companion, showCompanion]);

  useEffect(() => {
    // Both frames follow the selection. Picking a section and then hunting for
    // it in the other frame is the manual work this is here to remove — the
    // point of showing two widths is seeing the same copy in both at once.
    frame.selectBlock(selectedId);
    if (selectedId) frame.scrollToBlock(selectedId);
    if (showCompanion) {
      companion.selectBlock(selectedId);
      if (selectedId) companion.scrollToBlock(selectedId);
    }
  }, [selectedId, frame, companion, showCompanion]);

  const upsertText = useCallback(
    (id: string, html: string) => {
      setOps((current) => {
        const baseline = baselineBlocks.find((b) => b.id === id);
        const withoutThis = current.filter((op) => !(op.t === "setText" && op.id === id));
        // Typing a value back to the original should remove the op entirely,
        // not record a no-op edit that shows up as a change forever.
        if (baseline && baseline.html === html) return withoutThis;
        return [...withoutThis, { t: "setText", id, html }];
      });
    },
    [baselineBlocks],
  );

  const revertBlock = useCallback((id: string) => {
    setOps((current) => current.filter((op) => !(op.t === "setText" && op.id === id)));
  }, []);

  /**
   * Put a whole section back the way it was.
   *
   * Reverting a section one block at a time meant fifteen trips through the
   * inspector to undo one suggestion, and no way at all to undo the structural
   * part of it. This drops every op that touches the section — the rewrites and
   * anything inserted, moved or removed against it.
   */
  const revertBlocks = useCallback((ids: string[]) => {
    const inSection = new Set(ids);
    setOps((current) =>
      current.filter((op) => {
        if ("id" in op && typeof op.id === "string" && inSection.has(op.id)) return false;
        // An insert or move names its anchor rather than itself, so a bullet
        // added to this section would otherwise survive the revert.
        if ("refId" in op && typeof op.refId === "string" && inSection.has(op.refId)) return false;
        return true;
      }),
    );
  }, []);

  /**
   * Fold a suggestion's ops into the current list.
   *
   * A setText for a block that already has one replaces it rather than stacking
   * — applyOps takes the last write, so leaving both would work but would make
   * the op list grow without bound and the history impossible to read.
   */
  /**
   * Fold a suggestion's ops into the list, replacing the one it supersedes.
   *
   * `replacing` is what the panel applied last from the same request. Without
   * it, trying three options in turn stacked all three: setText is keyed by
   * block so it overwrites, but an insert has nowhere to collide, so every
   * apply added another copy — a section read back with the same line four
   * times over. Compared by reference, which holds because these are the very
   * objects the panel was handed.
   */
  const mergeOps = useCallback((incoming: Op[], replacing: Op[] = []) => {
    setOps((current) => {
      const superseded = new Set<Op>(replacing);
      let next = current.filter((op) => !superseded.has(op));
      for (const op of incoming) {
        if (op.t === "setText") {
          next = next.filter((existing) => !(existing.t === "setText" && existing.id === op.id));
          next.push(op);
        } else if (op.t === "setMeta") {
          const previous = next.find((existing) => existing.t === "setMeta");
          next = next.filter((existing) => existing.t !== "setMeta");
          next.push({ ...(previous ?? {}), ...op, t: "setMeta" });
        } else {
          next.push(op);
        }
      }
      return next;
    });
  }, []);

  /**
   * Add a template's markup to the page, directly after `afterBlockId`.
   *
   * Sanitised and stamped here, at op-creation time, exactly as the AI path
   * does it in `lib/ai/suggest.ts` — the ids are baked into the op's html so
   * replaying the list gives the same blocks the same ids every time. Minting
   * on apply instead would rename them on every reload and detach comments
   * from the copy they were left against.
   *
   * The templates are ours rather than a model's, but they still go through
   * `sanitizeHtml`: it is also what strips the editor's own attributes, and
   * routing every insert through one path means a future template cannot
   * quietly become the exception.
   */
  const addSection = useCallback(
    (afterBlockId: string, html: string) => {
      const stamped = assignNewIds(document, sanitizeHtml(document, html));
      mergeOps([{ t: "insert", refId: afterBlockId, pos: "after", html: stamped }]);
    },
    [mergeOps],
  );

  const changeMeta = useCallback(
    (patch: Partial<PageMeta>) => {
      setOps((current) => {
        const existing = current.find((op) => op.t === "setMeta");
        const merged = {
          ...(existing ?? {}),
          ...patch,
          t: "setMeta" as const,
        };
        const rest = current.filter((op) => op.t !== "setMeta");
        return [...rest, merged];
      });
    },
    [],
  );

  /**
   * The op list autosave last attempted, so a save the server rejects is not
   * retried every two seconds forever. Cleared on success: left set, returning
   * to a state that had already been autosaved once — reverting a block,
   * un-applying a suggestion — would silently stop autosaving that content.
   */
  const lastAutosaveAttempt = useRef<string | null>(null);

  const runSave = useCallback(
    (refresh: boolean) => {
      setProblems([]);
      const snapshot = ops;
      startSaving(async () => {
        try {
          const result = await saveOpsAction(version.id, snapshot);
          // The save was refused. Leave the ops unsaved and the autosave guard
          // set, so the same rejected list is not retried every two seconds.
          if (result.error) {
            setProblems([result.error]);
            return;
          }
          setSavedOps(snapshot);
          lastAutosaveAttempt.current = null;
          if (result.failures.length) {
            setProblems(result.failures.map((f) => f.reason));
          }
          // Autosave skips the refresh. It would re-render the route — every
          // baseline block back down the wire — a couple of seconds after each
          // pause in typing, and nothing the editor displays comes from the
          // server response anyway. saveOpsAction still revalidates, so the
          // next navigation is fresh.
          if (refresh) router.refresh();
        } catch (error) {
          // Only unexpected throws reach here, and their message has been
          // stripped in production — printing it shows React's minified-error
          // boilerplate rather than anything useful. Say what the reader can
          // act on instead, and put the real error where an admin can find it.
          console.error("saveOpsAction failed", error);
          setProblems([
            "Saving failed unexpectedly. Your changes are still on screen — try again, and if it keeps happening the details are in the server log.",
          ]);
        }
      });
    },
    [ops, version.id, router],
  );

  const save = useCallback(() => runSave(true), [runSave]);

  // Warn before losing unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  /**
   * Autosave, two seconds after the last change.
   *
   * Two deliberate exclusions:
   *  - Someone else's version. Saving there rewrites their proposal, which is
   *    what the fork prompt exists to prevent — it must stay a deliberate act.
   *  - An op list a save has already failed on, so a server-side rejection
   *    does not retry every two seconds forever.
   */
  useEffect(() => {
    if (!dirty || readOnly || isSaving || !version.isMine) return;
    const key = JSON.stringify(ops);
    if (lastAutosaveAttempt.current === key) return;
    const timer = setTimeout(() => {
      lastAutosaveAttempt.current = key;
      runSave(false);
    }, 2000);
    return () => clearTimeout(timer);
  }, [dirty, ops, readOnly, isSaving, version.isMine, runSave]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "s") {
        event.preventDefault();
        if (dirty && !readOnly) save();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [dirty, readOnly, save]);

  const selected: DerivedBlock | null = selectedId
    ? derivedById.get(selectedId) ?? null
    : null;
  const changedCount = derived.filter((d) => d.changed).length + (metaChanged ? 1 : 0);
  /** Something to compare: reworded copy, or structure this version adds. */
  const hasBefore = changedCount > 0 || pending.length > 0;

  return (
    <div className="flex h-[calc(100vh-3rem)] flex-col">
      <Toolbar
        version={version}
        versions={versions}
        lineage={lineage}
        parentLabel={parentLabel}
        compareVersionId={compareVersionId}
        changedCount={changedCount}
        commentCount={Object.values(commentCounts).reduce((a, b) => a + b, 0)}
        dirty={dirty}
        isSaving={isSaving}
        readOnly={readOnly}
        diffMode={diffMode}
        editMode={editMode}
        device={device}
        onDevice={setDevice}
        phoneZoom={phoneZoom}
        onPhoneZoom={setPhoneZoom}
        wideId={wideId}
        onWideId={setWideId}
        hasBefore={hasBefore}
        showingBefore={showingBefore}
        onShowBefore={setShowingBefore}
        baselineName={parentLabel ?? "the live page"}
        onDiffMode={setDiffMode}
        onEditMode={setEditMode}
        onSave={save}
        onStatus={(status) =>
          startSaving(async () => {
            // Commit any pending edit first. Autosave runs two seconds after
            // the last keystroke, and approving inside that window used to
            // freeze the previous wording: the version became read-only, which
            // stopped autosave, and the edit was gone on the next load.
            const snapshot = ops;
            if (dirty) {
              const result = await saveOpsAction(version.id, snapshot);
              // A refused save used to throw and abort the approval. Now that
              // it returns instead, stop here explicitly — approving a version
              // whose last edits never saved would freeze the wrong wording.
              if (result.error) {
                setProblems([result.error]);
                return;
              }
              setSavedOps(snapshot);
            }
            await setVersionStatusAction(version.id, status);
            router.refresh();
          })
        }
      />

      {dirty && !version.isMine && !readOnly ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-changed)] bg-[var(--color-changed-soft)] px-4 py-2 text-xs">
          <span>
            You&rsquo;re editing{" "}
            <strong>{version.authorName ?? "someone else"}&rsquo;s</strong> version.
            Saving changes their proposal rather than making your own.
          </span>
          <span className="ml-auto flex items-center gap-2">
            <ForkPrompt pageId={pageId} versionId={version.id} label={version.label} ops={ops} />
          </span>
        </div>
      ) : null}

      {problems.length > 0 ? (
        <div className="border-b border-[var(--color-removed)] bg-[var(--color-removed-soft)] px-4 py-2 text-xs">
          <span className="font-semibold">Some changes could not be applied:</span>{" "}
          {problems.slice(0, 3).join(" · ")}
          {problems.length > 3 ? ` (+${problems.length - 3} more)` : ""}
        </div>
      ) : null}

      {/* Narrow screens collapse to one pane at a time. */}
      <div className="flex shrink-0 border-b border-[var(--color-line)] xl:hidden">
        {(["outline", "preview", "inspector"] as Pane[]).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setPane(option)}
            className={`flex-1 py-2 text-xs font-medium capitalize ${
              pane === option
                ? "border-b-2 border-[var(--color-accent)] text-[var(--color-ink)]"
                : "text-[var(--color-ink-soft)]"
            }`}
          >
            {option}
          </button>
        ))}
      </div>

      {/*
        min-w-0 on every column is load-bearing, not cosmetic. Grid items
        default to min-width:auto, so the 1440px-wide preview iframe sets a
        min-content floor on the centre column: it refuses to shrink, the track
        list overflows the container, and the inspector is pushed off-screen
        with no scrollbar to reach it.
      */}
      <div className="grid min-h-0 flex-1 xl:grid-cols-[17rem_minmax(0,1fr)_22rem]">
        <aside
          className={`min-h-0 min-w-0 border-r border-[var(--color-line)] bg-[var(--color-surface)] ${
            pane === "outline" ? "" : "hidden xl:block"
          }`}
        >
          <OutlinePane
            blocks={derived}
            selectedId={selectedId ?? "__meta__"}
            onSelect={(id) => {
              setSelectedId(id);
              setPane("inspector");
            }}
            metaChanged={metaChanged}
            onRevertSection={revertBlocks}
            onAddSection={addSection}
            onSelectSection={(firstBlockId) => {
              setSelectedId(firstBlockId);
              setPane("inspector");
            }}
            onSelectMeta={() => {
              setSelectedId(null);
              setPane("inspector");
            }}
            structuralCount={pending.length}
            commentCounts={commentCounts}
          />
        </aside>

        <main
          ref={previewRef}
          className={`min-h-0 min-w-0 ${pane === "preview" ? "" : "hidden xl:block"}`}
        >
          {/* The primary frame keeps its place in the tree whatever the device
              is, so switching modes never remounts it — a remount means
              re-downloading a snapshot that can run to tens of megabytes. */}
          <div
            className={`flex h-full min-h-0 min-w-0 ${
              stacked && showCompanion ? "flex-col overflow-auto" : "flex-row"
            }`}
          >
            <div
              // shrink-0 stacked: the panes are sized to their content there,
              // and a flex column would otherwise squeeze both to fit the
              // height it has, giving each its own scrollbar inside the
              // column's — which is the arrangement `fit` exists to avoid.
              className={stacked && showCompanion ? "min-w-0 shrink-0" : "min-h-0 min-w-0"}
              // Grows into whatever the phone leaves, and shrinks in proportion
              // to its own width rather than absorbing the whole squeeze: with
              // the phone pinned to a fixed pixel width, narrowing the window
              // used to shrink this frame alone until it was unreadable while
              // the phone sat there unchanged.
              style={
                stacked && showCompanion
                  ? undefined
                  : { flex: `1 1 ${wide.width}px`, minWidth: MIN_PANE_WIDTH }
              }
            >
              <PreviewPane
                frame={frame}
                snapshotId={snapshotId}
                runtimeVersion={runtimeVersion}
                viewport={device === "mobile" ? MOBILE_VIEWPORT : wide}
                phone={device === "mobile"}
                zoom={device === "mobile" ? phoneZoom : 1}
                fit={stacked && showCompanion}
                loading={!frame.ready}
              />
            </div>
            {companionMounted ? (
              <div
                className={`min-w-0 ${showCompanion ? "" : "hidden"} ${
                  stacked && showCompanion
                    ? "shrink-0 border-t border-[var(--color-line)]"
                    : "h-full min-h-0 border-l border-[var(--color-line)]"
                }`}
                // Its natural width when there is room — the zoom control is
                // what trades width between the two frames — and no smaller
                // than legible once there is not.
                style={
                  stacked && showCompanion
                    ? undefined
                    : {
                        flex: `0 1 ${phonePaneWidth(phoneZoom)}px`,
                        minWidth: Math.min(MIN_PANE_WIDTH, phonePaneWidth(phoneZoom)),
                      }
                }
              >
                <PreviewPane
                  frame={companion}
                  snapshotId={snapshotId}
                  runtimeVersion={runtimeVersion}
                  viewport={MOBILE_VIEWPORT}
                  phone
                  zoom={phoneZoom}
                  fit={stacked && showCompanion}
                  loading={!companion.ready}
                />
              </div>
            ) : null}
          </div>
        </main>

        <aside
          className={`min-h-0 min-w-0 overflow-hidden border-l border-[var(--color-line)] bg-[var(--color-surface)] ${
            pane === "inspector" ? "" : "hidden xl:block"
          }`}
        >
          <InspectorPane
            selected={selected}
            meta={meta}
            metaBaseline={baselineMeta}
            onChangeBlock={upsertText}
            onChangeMeta={changeMeta}
            onRevertBlock={revertBlock}
            readOnly={readOnly}
            aiSlot={
              <AiPanel
                versionId={version.id}
                config={aiConfig}
                selectedBlockId={selectedId}
                visibleBlockIds={derived.map((d) => d.block.id)}
                section={section}
                describeBlock={describeBlock}
                onApply={mergeOps}
                readOnly={readOnly}
              />
            }
            commentSlot={
              <CommentPanel
                versionId={version.id}
                blockId={selectedId}
                comments={comments}
              />
            }
          />
        </aside>
      </div>
    </div>
  );
}

function ExportMenu({
  versionId,
  compareVersionId,
}: {
  versionId: string;
  compareVersionId: string | null;
}) {
  const query = compareVersionId
    ? `&compare=${encodeURIComponent(compareVersionId)}`
    : "";
  return (
    <div className="flex items-center gap-1 text-xs">
      <span className="text-[var(--color-ink-faint)]">Export</span>
      {(["md", "csv", "json"] as const).map((format) => (
        <a
          key={format}
          href={`/api/versions/${versionId}/export?format=${format}${query}`}
          className="rounded px-1.5 py-0.5 uppercase text-[var(--color-ink-soft)] hover:bg-[var(--color-sunken)] hover:text-[var(--color-ink)]"
        >
          {format}
        </a>
      ))}
    </div>
  );
}

/**
 * Moves in-progress edits onto a version of your own.
 *
 * Editing is in place, so without this the natural thing to do — open a
 * colleague's proposal and start typing — silently rewrites the thing they
 * asked you to review. Forking mid-edit keeps the work and leaves their version
 * untouched.
 */
function ForkPrompt({
  pageId,
  versionId,
  label,
  ops,
}: {
  pageId: string;
  versionId: string;
  label: string;
  ops: Op[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      {error ? <span className="text-[var(--color-removed)]">{error}</span> : null}
      <button
        type="button"
        className="btn btn-primary py-0.5 text-[11px]"
        disabled={pending}
        onClick={() =>
          start(async () => {
            try {
              const { id } = await createVersionAction({
                pageId,
                parentVersionId: versionId,
                label: `${label} — my edits`,
                ops,
              });
              router.push(`/pages/${pageId}/v/${id}`);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          })
        }
      >
        {pending ? "Forking…" : "Fork with my edits"}
      </button>
    </>
  );
}

/**
 * Click-to-rename for the version label. Names like "Test 2" are only wrong
 * when you are staring at them, so the rename lives in the toolbar rather
 * than back on the page listing.
 */
function EditableLabel({ versionId, label }: { versionId: string; label: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  const [pending, start] = useTransition();

  if (!editing) {
    return (
      <button
        type="button"
        title="Rename this version"
        onClick={() => {
          setDraft(label);
          setEditing(true);
        }}
        className="rounded text-sm font-medium hover:bg-[var(--color-sunken)]"
      >
        {label}
      </button>
    );
  }

  const commit = () => {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === label) return;
    start(async () => {
      await renameVersionAction(versionId, next);
      router.refresh();
    });
  };

  return (
    <input
      autoFocus
      disabled={pending}
      className="field w-56 py-0.5 text-sm"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Escape") setEditing(false);
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      onBlur={commit}
    />
  );
}

/**
 * Hold to see the copy this version replaced.
 *
 * A press-and-hold rather than a toggle on purpose: the comparison people
 * actually make is a flick back and forth, and a toggle turns that into two
 * clicks and a question about which state you are currently looking at. While
 * it is down the preview shows the baseline, and it always comes back up —
 * releasing anywhere on the page, or leaving the window, ends the hold.
 */
function BeforeButton({
  active,
  onChange,
  baselineName,
}: {
  active: boolean;
  onChange: (on: boolean) => void;
  baselineName: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      title={`Hold to see this copy as it reads in ${baselineName}`}
      onPointerDown={(e) => {
        e.preventDefault();
        onChange(true);
      }}
      onPointerUp={() => onChange(false)}
      onPointerLeave={() => onChange(false)}
      onPointerCancel={() => onChange(false)}
      // Keyboard equivalent: hold space or enter. Repeat events fire while a key
      // is held, so the guard keeps this to one state change per press.
      onKeyDown={(e) => {
        if ((e.key === " " || e.key === "Enter") && !e.repeat) {
          e.preventDefault();
          onChange(true);
        }
      }}
      onKeyUp={(e) => {
        if (e.key === " " || e.key === "Enter") onChange(false);
      }}
      onBlur={() => onChange(false)}
      className={`btn select-none ${
        active ? "border-[var(--color-removed)] text-[var(--color-removed)]" : ""
      }`}
    >
      {active ? "Before ↩" : "Before"}
    </button>
  );
}

function Toolbar({
  version,
  versions,
  lineage,
  parentLabel,
  compareVersionId,
  changedCount,
  commentCount,
  dirty,
  isSaving,
  readOnly,
  diffMode,
  editMode,
  hasBefore,
  showingBefore,
  onShowBefore,
  baselineName,
  device,
  onDevice,
  phoneZoom,
  onPhoneZoom,
  wideId,
  onWideId,
  onDiffMode,
  onEditMode,
  onSave,
  onStatus,
}: {
  version: WorkspaceVersion;
  versions: WorkspaceVersion[];
  lineage: LineageRow<WorkspaceVersion>[];
  parentLabel: string | null;
  compareVersionId: string | null;
  changedCount: number;
  commentCount: number;
  dirty: boolean;
  isSaving: boolean;
  readOnly: boolean;
  diffMode: boolean;
  editMode: boolean;
  hasBefore: boolean;
  showingBefore: boolean;
  onShowBefore: (on: boolean) => void;
  /** What the diff is against, named, for the Before button's tooltip. */
  baselineName: string;
  device: Device;
  onDevice: (d: Device) => void;
  phoneZoom: number;
  onPhoneZoom: (zoom: number) => void;
  wideId: string;
  onWideId: (id: string) => void;
  onDiffMode: (on: boolean) => void;
  onEditMode: (on: boolean) => void;
  onSave: () => void;
  onStatus: (status: VersionStatus) => void;
}) {
  const router = useRouter();

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-2">
      <EditableLabel versionId={version.id} label={version.label} />
      <span
        className={`chip ${
          version.status === "approved"
            ? "bg-[var(--color-added-soft)] text-[var(--color-added)]"
            : version.status === "proposed"
              ? "bg-[var(--color-changed-soft)] text-[var(--color-changed)]"
              : version.status === "rejected"
                ? "bg-[var(--color-removed-soft)] text-[var(--color-removed)]"
                : "bg-[var(--color-sunken)] text-[var(--color-ink-soft)]"
        }`}
      >
        {version.status}
      </span>

      <label className="ml-2 flex items-center gap-1.5 text-xs text-[var(--color-ink-soft)]">
        vs
        <select
          className="field w-auto py-1 text-xs"
          value={compareVersionId ?? ""}
          onChange={(e) => {
            const value = e.target.value;
            router.push(
              `?compare=${encodeURIComponent(value)}`,
              { scroll: false },
            );
          }}
        >
          {/*
            Naming the baseline is not cosmetic: "2 changes" means nothing if
            you cannot see what those 2 changes are measured against.
          */}
          <option value="">
            {parentLabel ? `${parentLabel} (parent)` : "Live page (as captured)"}
          </option>
          {/*
            A root version's default baseline already is the capture, so the
            option would be a duplicate. On a fork it is the only way to see the
            proposal against what is actually published, rather than against
            whichever draft it happened to be forked from.
          */}
          {parentLabel ? (
            <option value={SNAPSHOT_BASELINE}>Live page (as captured)</option>
          ) : null}
          {lineage
            .filter((row) => row.version.id !== version.id)
            .map((row) => (
              <option key={row.version.id} value={row.version.id}>
                {/* Indentation shows which versions descend from which. */}
                {"\u00A0\u00A0".repeat(row.depth)}
                {row.depth > 0 ? "↳ " : ""}
                {row.version.label}
                {row.version.authorName ? ` — ${row.version.authorName}` : ""}
              </option>
            ))}
        </select>
      </label>

      <span className="text-xs text-[var(--color-ink-faint)]">
        {changedCount} change{changedCount === 1 ? "" : "s"}
      </span>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onDiffMode(!diffMode)}
          className={`btn ${diffMode ? "border-[var(--color-accent)] text-[var(--color-accent)]" : ""}`}
          title="Outline edited blocks, and mark blocks with unresolved comments"
        >
          Changes &amp; comments
          {commentCount > 0 ? (
            <span className="chip bg-[var(--color-comment-soft)] text-[var(--color-comment)]">
              💬 {commentCount}
            </span>
          ) : null}
        </button>
        {!readOnly ? (
          <button
            type="button"
            onClick={() => onEditMode(!editMode)}
            className={`btn ${editMode ? "border-[var(--color-accent)] text-[var(--color-accent)]" : ""}`}
            title="Click any text in the preview to edit it in place"
          >
            Edit on page
          </button>
        ) : null}
        {hasBefore ? (
          <BeforeButton
            active={showingBefore}
            onChange={onShowBefore}
            baselineName={baselineName}
          />
        ) : null}
        <DeviceToggle device={device} onChange={onDevice} />
        {device === "mobile" ? null : (
          <ViewportSelect value={wideId} onChange={onWideId} />
        )}
        {device === "desktop" ? null : (
          <label
            className="flex items-center gap-1 text-[11px] text-[var(--color-ink-soft)]"
            title="How large to draw the phone. Smaller leaves more room for the desktop frame beside it."
          >
            Phone
            <select
              className="field w-auto py-0.5 text-xs"
              value={phoneZoom}
              onChange={(e) => onPhoneZoom(Number(e.target.value))}
            >
              {PHONE_ZOOMS.map((z) => (
                <option key={z} value={z}>
                  {Math.round(z * 100)}%
                </option>
              ))}
            </select>
          </label>
        )}

        <ExportMenu versionId={version.id} compareVersionId={compareVersionId} />

        {readOnly ? (
          <span className="text-xs text-[var(--color-ink-faint)]">
            Approved — fork to make changes
          </span>
        ) : (
          <>
            <button
              type="button"
              className="btn"
              disabled={!dirty || isSaving}
              onClick={onSave}
              title="Changes autosave a couple of seconds after you stop editing — this saves now (⌘S)"
            >
              {isSaving ? "Saving…" : dirty ? "Save" : "Saved"}
            </button>
            {version.status === "draft" ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={isSaving}
                onClick={() => onStatus("proposed")}
              >
                Propose
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={isSaving}
                onClick={() => onStatus("approved")}
              >
                Approve
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

