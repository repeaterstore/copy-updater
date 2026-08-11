/**
 * Version reads and writes.
 *
 * `ops` is the authored source of truth; `resolved` is a cache rebuilt from it
 * on every write. Everything downstream — the diff, the outline, the export,
 * the AI context — reads `resolved`, so it must never be set by hand.
 */
import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { diffResolved, type ResolvedDiff } from "@/lib/ops/diff";
import { resolveVersion } from "@/lib/ops/resolve.server";
import type { Block, Op, OpFailure, Resolved } from "@/lib/ops/types";
import { readDataText } from "@/lib/storage";

export type VersionRow = typeof schema.versions.$inferSelect;
export type SnapshotRow = typeof schema.snapshots.$inferSelect;

const EMPTY_RESOLVED: Resolved = {
  blocks: [],
  meta: {
    title: null,
    description: null,
    ogTitle: null,
    ogDescription: null,
    canonical: null,
  },
  styles: [],
};

/** Skeletons are immutable per snapshot, so cache them for the process. */
const skeletonCache = new Map<string, string>();

export async function loadSkeleton(snapshot: SnapshotRow): Promise<string> {
  if (!snapshot.skeletonPath) {
    throw new Error("Snapshot has no skeleton; it may still be capturing.");
  }
  const cached = skeletonCache.get(snapshot.id);
  if (cached) return cached;

  const text = await readDataText(snapshot.skeletonPath);
  skeletonCache.set(snapshot.id, text);
  return text;
}

/**
 * Recompute a version's resolved state from its ops and persist it.
 */
export async function rebuildResolved(
  versionId: string,
): Promise<{ resolved: Resolved; failures: OpFailure[] }> {
  const version = await db.query.versions.findFirst({
    where: eq(schema.versions.id, versionId),
  });
  if (!version) throw new Error("Version not found.");

  const snapshot = await db.query.snapshots.findFirst({
    where: eq(schema.snapshots.id, version.snapshotId),
  });
  if (!snapshot) throw new Error("Snapshot not found.");

  const skeleton = await loadSkeleton(snapshot);
  const { resolved, failures } = resolveVersion(skeleton, version.ops);

  const withBoxes = { ...resolved, blocks: carryBoxes(resolved.blocks, snapshot) };

  await db
    .update(schema.versions)
    .set({ resolved: withBoxes, updatedAt: new Date() })
    .where(eq(schema.versions.id, versionId));

  return { resolved: withBoxes, failures };
}

/**
 * Re-attach capture-time bounding boxes to resolved blocks.
 *
 * Resolving replays ops against the skeleton under jsdom, which has no layout
 * engine, so every box comes back null. Downstream that silently breaks
 * anything geometric — screenshot cropping quietly fell back to sending the
 * whole 4 MB page image for every request. Boxes are a property of the capture,
 * not of the edit, so copying them across by id is correct; blocks inserted by
 * an op legitimately have none until the page is captured again.
 */
function carryBoxes(blocks: Block[], snapshot: SnapshotRow): Block[] {
  const boxes = new Map(snapshot.blocks.map((b) => [b.id, b.box]));
  return blocks.map((block) =>
    block.box ? block : { ...block, box: boxes.get(block.id) ?? null },
  );
}

export async function setVersionOps(
  versionId: string,
  ops: Op[],
): Promise<{ resolved: Resolved; failures: OpFailure[] }> {
  await db
    .update(schema.versions)
    .set({ ops, updatedAt: new Date() })
    .where(eq(schema.versions.id, versionId));
  return rebuildResolved(versionId);
}

/**
 * The baseline a version is compared against: its parent's resolved state, or
 * the untouched snapshot for a root version.
 */
export async function baselineFor(version: VersionRow): Promise<Resolved> {
  if (version.parentVersionId) {
    const parent = await db.query.versions.findFirst({
      where: eq(schema.versions.id, version.parentVersionId),
    });
    if (parent?.resolved) return parent.resolved;
  }
  return snapshotBaseline(version.snapshotId);
}

/**
 * Resolved snapshots, cached like skeletons and for the same reason.
 *
 * Resolving is a jsdom parse of the whole page: 0.4s for a 400-block page and
 * 3.7s for a 1,000-block one. Every root version's workspace needs it, so
 * without this every open of every root version paid that again for a result
 * that cannot have changed — a snapshot is immutable and the op list is empty.
 *
 * Bounded because the container also runs Chromium during capture, and a
 * resolved 1,000-block page is a few megabytes.
 */
const baselineCache = new Map<string, Resolved>();
const BASELINE_CACHE_LIMIT = 8;

/** The snapshot with no ops applied — what the page says today. */
export async function snapshotBaseline(snapshotId: string): Promise<Resolved> {
  const cached = baselineCache.get(snapshotId);
  if (cached) return cached;

  const snapshot = await db.query.snapshots.findFirst({
    where: eq(schema.snapshots.id, snapshotId),
  });
  if (!snapshot) return EMPTY_RESOLVED;
  const skeleton = await loadSkeleton(snapshot);
  const resolved = resolveVersion(skeleton, []).resolved;

  // Boxes matter here as much as they do for an edited version: they are what
  // tells the outline a mega-menu is collapsed and what lets a screenshot be
  // cropped. Resolving under jsdom returns none, so a root version's workspace
  // used to see every block as visible.
  const withBoxes: Resolved = { ...resolved, blocks: carryBoxes(resolved.blocks, snapshot) };

  if (baselineCache.size >= BASELINE_CACHE_LIMIT) {
    const oldest = baselineCache.keys().next().value;
    if (oldest) baselineCache.delete(oldest);
  }
  baselineCache.set(snapshotId, withBoxes);
  return withBoxes;
}

export async function diffVersions(
  beforeVersionId: string | null,
  afterVersionId: string,
): Promise<ResolvedDiff> {
  const after = await db.query.versions.findFirst({
    where: eq(schema.versions.id, afterVersionId),
  });
  if (!after) throw new Error("Version not found.");

  const afterResolved = after.resolved ?? (await rebuildResolved(after.id)).resolved;

  let beforeResolved: Resolved;
  if (beforeVersionId) {
    const before = await db.query.versions.findFirst({
      where: eq(schema.versions.id, beforeVersionId),
    });
    if (!before) throw new Error("Comparison version not found.");
    beforeResolved = before.resolved ?? (await rebuildResolved(before.id)).resolved;
  } else {
    beforeResolved = await snapshotBaseline(after.snapshotId);
  }

  return diffResolved(beforeResolved, afterResolved);
}

export async function listVersions(pageId: string): Promise<VersionRow[]> {
  return db.query.versions.findMany({
    where: eq(schema.versions.pageId, pageId),
    orderBy: asc(schema.versions.createdAt),
  });
}

export async function latestReadySnapshot(
  pageId: string,
): Promise<SnapshotRow | undefined> {
  return db.query.snapshots.findFirst({
    where: and(
      eq(schema.snapshots.pageId, pageId),
      eq(schema.snapshots.status, "ready"),
    ),
    orderBy: (s, { desc }) => [desc(s.capturedAt)],
  });
}
