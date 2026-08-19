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
import { withoutOrphans } from "@/lib/ops/prune";
import { EXTRACTOR_VERSION, type Block, type Op, type OpFailure, type Resolved } from "@/lib/ops/types";
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

/**
 * Skeletons are immutable per snapshot, so cache them for the process.
 *
 * Bounded for the same reason as the resolved cache below: a skeleton runs to
 * well over a megabyte, and a long-lived container that has served every page
 * on the site should not be holding all of them.
 */
const skeletonCache = new Map<string, string>();
const SKELETON_CACHE_LIMIT = 8;

export async function loadSkeleton(snapshot: SnapshotRow): Promise<string> {
  if (!snapshot.skeletonPath) {
    throw new Error("Snapshot has no skeleton; it may still be capturing.");
  }
  const cached = skeletonCache.get(snapshot.id);
  if (cached) return cached;

  const text = await readDataText(snapshot.skeletonPath);
  if (skeletonCache.size >= SKELETON_CACHE_LIMIT) {
    const oldest = skeletonCache.keys().next().value;
    if (oldest) skeletonCache.delete(oldest);
  }
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

  /*
   * Ops that can never apply are dropped here as well as on save.
   *
   * A version left holding them reports the same failure on every save and has
   * no way to shed them, because a reviewer cannot see or select a block that
   * does not exist. Cleaning during the rebuild means the versions that already
   * have them are repaired at start-up rather than needing someone to find and
   * re-save each one.
   */
  const cleaned = withoutOrphans(version.ops);
  const { resolved, failures } = resolveVersion(skeleton, cleaned);

  const withBoxes = { ...resolved, blocks: carryBoxes(resolved.blocks, snapshot) };

  await db
    .update(schema.versions)
    .set({
      resolved: withBoxes,
      ...(cleaned.length === version.ops.length ? {} : { ops: cleaned }),
      updatedAt: new Date(),
    })
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
  /*
   * Cleaned on the way in, so a list cannot carry ops that can never apply.
   *
   * An op against a `new:` id no insert creates is not a change anyone can see
   * — the block does not exist — but it does report a failure on every save
   * from then on, and nothing else would ever remove it. Versions already
   * carrying them heal the next time they are saved.
   */
  const cleaned = withoutOrphans(ops);
  await db
    .update(schema.versions)
    .set({ ops: cleaned, updatedAt: new Date() })
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

/**
 * Bring versions saved by an older extractor up to date.
 *
 * `resolved` is derived data cached on the row, so a version keeps whatever
 * extraction produced at its last save — potentially for months. Change what
 * counts as a block and the two sides of a diff stop agreeing. Rebuilding also
 * drops ops that can never apply, which is how versions already carrying
 * orphaned edits repair themselves.
 *
 * Guarded by the stamp, so this costs one query on every boot after the one
 * that needed it. Never throws: a stale cache is recoverable, and nothing about
 * it should stop the server serving.
 */
export async function rebuildStaleVersions(): Promise<void> {
  const versions = await db
    .select({
      id: schema.versions.id,
      label: schema.versions.label,
      resolved: schema.versions.resolved,
    })
    .from(schema.versions);

  const stale = versions.filter((v) => (v.resolved?.v ?? 0) < EXTRACTOR_VERSION);
  if (stale.length === 0) {
    console.log(`[startup] all ${versions.length} version(s) at extractor v${EXTRACTOR_VERSION}`);
    return;
  }

  console.log(`[startup] rebuilding ${stale.length} of ${versions.length} version(s)`);
  let done = 0;
  for (const version of stale) {
    try {
      const { failures } = await rebuildResolved(version.id);
      done += 1;
      if (failures.length > 0) {
        console.log(`[startup]   ! ${version.label}: ${failures.length} op(s) no longer apply`);
      }
    } catch (error) {
      console.log(
        `[startup]   ✗ ${version.label}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  console.log(`[startup] rebuilt ${done}/${stale.length}`);
}
