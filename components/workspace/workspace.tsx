"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Block, Op, PageMeta } from "@/lib/ops/types";
import { usePreviewFrame } from "@/lib/preview/use-preview-frame";
import {
  deriveBlocks,
  metaOverrides,
  sectionScopeFor,
  structuralOps,
  type DerivedBlock,
} from "@/lib/workspace/derive";
import {
  createVersionAction,
  saveOpsAction,
  setVersionStatusAction,
} from "@/app/actions/versions";
import type { VersionStatus } from "@/db/schema";
import { orderByLineage, type LineageRow } from "@/lib/version-tree";
import { AiPanel, type AiConfig } from "./ai-panel";
import { CommentPanel, type CommentItem } from "./comment-panel";
import { DeviceToggle, PreviewPane, type Device } from "./preview-pane";
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

  // Push the current op list into the preview. Debounced: typing produces an op
  // per keystroke and each apply replays the whole list against the snapshot.
  // Keyed on frame.ready as well as ops, so the list is (re)sent once the
  // snapshot finishes loading — a 20 MB page can take tens of seconds, by which
  // time the initial send has long since happened.
  const applyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (applyTimer.current) clearTimeout(applyTimer.current);
    applyTimer.current = setTimeout(() => frame.applyOps(ops), 180);
    return () => {
      if (applyTimer.current) clearTimeout(applyTimer.current);
    };
  }, [ops, frame, frame.ready]);

  useEffect(() => {
    frame.setEditable(editMode && !readOnly);
  }, [editMode, readOnly, frame]);

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
      return;
    }
    const changed = derived.filter((d) => d.changed).map((d) => d.block.id);
    const risk = derived.filter((d) => d.layoutRisk).map((d) => d.block.id);
    frame.setDiffMode(true, {
      changed,
      added: [],
      removed: [],
      moved: [],
      layoutRisk: risk,
      comments: commentCounts,
    });
  }, [diffMode, derived, commentCounts, frame]);

  useEffect(() => {
    frame.selectBlock(selectedId);
    if (selectedId) frame.scrollToBlock(selectedId);
  }, [selectedId, frame]);

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
   * Fold a suggestion's ops into the current list.
   *
   * A setText for a block that already has one replaces it rather than stacking
   * — applyOps takes the last write, so leaving both would work but would make
   * the op list grow without bound and the history impossible to read.
   */
  const mergeOps = useCallback((incoming: Op[]) => {
    setOps((current) => {
      let next = [...current];
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

  const save = useCallback(() => {
    setProblems([]);
    const snapshot = ops;
    startSaving(async () => {
      try {
        const result = await saveOpsAction(version.id, snapshot);
        setSavedOps(snapshot);
        if (result.failures.length) {
          setProblems(result.failures.map((f) => f.reason));
        }
        router.refresh();
      } catch (error) {
        setProblems([error instanceof Error ? error.message : String(error)]);
      }
    });
  }, [ops, version.id, router]);

  // Warn before losing unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

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
        onDiffMode={setDiffMode}
        onEditMode={setEditMode}
        onSave={save}
        onStatus={(status) =>
          startSaving(async () => {
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

        <main className={`min-h-0 min-w-0 ${pane === "preview" ? "" : "hidden xl:block"}`}>
          <PreviewPane
            frame={frame}
            snapshotId={snapshotId}
            runtimeVersion={runtimeVersion}
            device={device}
            loading={!frame.ready}
          />
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
  device,
  onDevice,
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
  device: Device;
  onDevice: (d: Device) => void;
  onDiffMode: (on: boolean) => void;
  onEditMode: (on: boolean) => void;
  onSave: () => void;
  onStatus: (status: VersionStatus) => void;
}) {
  const router = useRouter();

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-2">
      <span className="text-sm font-medium">{version.label}</span>
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
        <DeviceToggle device={device} onChange={onDevice} />

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
