/**
 * Ordering versions by lineage.
 *
 * Versions form a shallow forest rather than a chain: every "New version"
 * starts a root, and forks hang off whatever they were made from. Listed flat,
 * a page shows three entries with no indication that one descends from another
 * and the third is unrelated — which is exactly the information you need to
 * read a diff.
 *
 * Pure data in, pure data out, so the same ordering drives the server-rendered
 * page list and the client-side compare selector.
 */

/**
 * Compare against the page as captured, whatever this version descends from.
 *
 * Not a version id, so it needs a sentinel. A fork's default baseline is its
 * parent, which answers "what did I change" — but the question a reviewer
 * usually asks last is "what does this do to the live page", and every
 * intermediate version sat between them with no way to skip past it.
 */
export const SNAPSHOT_BASELINE = "__snapshot__";

export interface LineageInput {
  id: string;
  parentVersionId: string | null;
  createdAt: string;
}

export interface LineageRow<T> {
  version: T;
  /** 0 for a root, 1 for a fork of a root, and so on. */
  depth: number;
  /** The version this one is diffed against by default, if any. */
  parent: T | null;
}

export function orderByLineage<T extends LineageInput>(versions: T[]): LineageRow<T>[] {
  const byId = new Map(versions.map((v) => [v.id, v]));
  const children = new Map<string | null, T[]>();

  for (const version of versions) {
    // A parent outside this list (deleted, or another page) makes the version a
    // root rather than an orphan that never gets rendered.
    const key =
      version.parentVersionId && byId.has(version.parentVersionId)
        ? version.parentVersionId
        : null;
    const bucket = children.get(key) ?? [];
    bucket.push(version);
    children.set(key, bucket);
  }

  for (const bucket of children.values()) {
    bucket.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  const rows: LineageRow<T>[] = [];
  const seen = new Set<string>();

  const walk = (parentId: string | null, depth: number): void => {
    for (const version of children.get(parentId) ?? []) {
      // Guards against a cycle introduced by bad data; without it a loop would
      // hang the render rather than showing a slightly wrong tree.
      if (seen.has(version.id)) continue;
      seen.add(version.id);

      rows.push({
        version,
        depth,
        parent: version.parentVersionId ? (byId.get(version.parentVersionId) ?? null) : null,
      });
      walk(version.id, depth + 1);
    }
  };

  walk(null, 0);

  // Anything left over (part of a cycle) still deserves to be listed.
  for (const version of versions) {
    if (!seen.has(version.id)) rows.push({ version, depth: 0, parent: null });
  }

  return rows;
}

/** What a version is compared against by default, in words. */
export function baselineLabelFor(parentLabel: string | null): string {
  return parentLabel ? `${parentLabel} (parent)` : "Live page (as captured)";
}
