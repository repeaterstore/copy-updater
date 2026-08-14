/**
 * Every comment addressed to the designer, with enough around it to act on.
 *
 * A note saying "this photo is the wrong building" is useless on its own: the
 * designer needs the page, the version it was written against, and the copy it
 * was attached to. Gathered here rather than in the page component so the shape
 * is testable and the query lives next to the tag rule that defines it.
 */
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { isForDesigner, withoutDesignTag } from "./tags";
import type { DesignNote } from "./notes";

export type { DesignNote, DesignNotePage } from "./notes";
export { groupByPage } from "./notes";

export async function listDesignNotes(): Promise<DesignNote[]> {
  const rows = await db
    .select({
      id: schema.comments.id,
      body: schema.comments.body,
      resolved: schema.comments.resolved,
      createdAt: schema.comments.createdAt,
      blockId: schema.comments.blockId,
      authorName: schema.users.name,
      authorEmail: schema.users.email,
      versionId: schema.versions.id,
      versionLabel: schema.versions.label,
      resolvedState: schema.versions.resolved,
      pageId: schema.pages.id,
      pageName: schema.pages.name,
      pageUrl: schema.pages.url,
    })
    .from(schema.comments)
    .innerJoin(schema.versions, eq(schema.comments.versionId, schema.versions.id))
    .innerJoin(schema.pages, eq(schema.versions.pageId, schema.pages.id))
    .leftJoin(schema.users, eq(schema.comments.authorId, schema.users.id))
    .orderBy(desc(schema.comments.createdAt));

  // Filtered in memory rather than with a LIKE: the rule for what counts as a
  // design note is a regex with word boundaries — `sam@design.com` is not one —
  // and duplicating that in SQL would let the two definitions drift.
  return rows
    .filter((row) => isForDesigner(row.body))
    .map((row) => {
      const block = row.blockId
        ? row.resolvedState?.blocks?.find((b) => b.id === row.blockId)
        : null;
      return {
        id: row.id,
        body: withoutDesignTag(row.body),
        resolved: row.resolved,
        createdAt: row.createdAt.toISOString(),
        author: row.authorName ?? row.authorEmail ?? "Someone",
        pageId: row.pageId,
        pageName: row.pageName,
        pageUrl: row.pageUrl,
        versionId: row.versionId,
        versionLabel: row.versionLabel,
        blockId: row.blockId,
        blockText: block?.text ?? null,
        blockRole: block?.role ?? null,
      };
    });
}
