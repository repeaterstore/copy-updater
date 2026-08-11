/**
 * The home page listing: pages with their version count and latest snapshot
 * status.
 *
 * Assembled from plain queries rather than correlated subqueries. Drizzle
 * renders outer-table columns inside a sql`` fragment unqualified, so
 * `where versions.page_id = pages.id` silently became `page_id = id` — the
 * inner table's own id — and every count came back 0 while the page showed
 * "0 versions" for pages that had several.
 */
import { count, desc } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";

/**
 * The driver-agnostic base type, not NodePgDatabase: the tests run this against
 * PGlite, and naming the node-postgres driver would force a cast there that
 * turns off type checking on the one call the test exists to check.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface PageListRow {
  id: string;
  name: string;
  url: string;
  createdAt: Date;
  versionCount: number;
  snapshotStatus: string | null;
}

export async function listPagesWithStats(db: Database): Promise<PageListRow[]> {
  const pages = await db
    .select({
      id: schema.pages.id,
      name: schema.pages.name,
      url: schema.pages.url,
      createdAt: schema.pages.createdAt,
    })
    .from(schema.pages)
    .orderBy(desc(schema.pages.createdAt));

  const counts = await db
    .select({ pageId: schema.versions.pageId, n: count() })
    .from(schema.versions)
    .groupBy(schema.versions.pageId);
  const countByPage = new Map(counts.map((row) => [row.pageId, row.n]));

  // Ordered newest first, so the first row seen per page is the latest capture.
  const snapshots = await db
    .select({
      pageId: schema.snapshots.pageId,
      status: schema.snapshots.status,
    })
    .from(schema.snapshots)
    .orderBy(desc(schema.snapshots.capturedAt));
  const latestStatusByPage = new Map<string, string>();
  for (const snap of snapshots) {
    if (!latestStatusByPage.has(snap.pageId)) {
      latestStatusByPage.set(snap.pageId, snap.status);
    }
  }

  return pages.map((page) => ({
    ...page,
    versionCount: countByPage.get(page.id) ?? 0,
    snapshotStatus: latestStatusByPage.get(page.id) ?? null,
  }));
}
