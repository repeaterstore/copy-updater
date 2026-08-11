import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { AppHeader } from "@/components/app-header";
import { NewVersionButton } from "@/components/new-version-button";
import { Workspace, type WorkspaceVersion } from "@/components/workspace/workspace";
import { loadSettings } from "@/lib/ai/openrouter";
import { listBrandVoices } from "@/lib/ai/voices";
import { browserScriptHash } from "@/lib/browser/bundle";
import { requireUser } from "@/lib/session";
import { SNAPSHOT_BASELINE } from "@/lib/version-tree";
import { baselineFor, listVersions, snapshotBaseline } from "@/lib/versions";

export const dynamic = "force-dynamic";

export default async function VersionWorkspace({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; versionId: string }>;
  searchParams: Promise<{ compare?: string }>;
}) {
  const user = await requireUser();
  const { id: pageId, versionId } = await params;
  const { compare } = await searchParams;

  const page = await db.query.pages.findFirst({ where: eq(schema.pages.id, pageId) });
  const version = await db.query.versions.findFirst({
    where: eq(schema.versions.id, versionId),
  });
  if (!page || !version || version.pageId !== pageId) notFound();

  const snapshot = await db.query.snapshots.findFirst({
    where: eq(schema.snapshots.id, version.snapshotId),
  });
  if (!snapshot || snapshot.status !== "ready") notFound();

  // The baseline this version is shown against: the page as captured, an
  // explicitly chosen version, otherwise its parent, otherwise the capture.
  const compareId = compare && compare !== "" ? compare : null;
  let baseline;
  if (compareId === SNAPSHOT_BASELINE) {
    baseline = await snapshotBaseline(version.snapshotId);
  } else if (compareId) {
    const other = await db.query.versions.findFirst({
      where: eq(schema.versions.id, compareId),
    });
    baseline = other?.resolved ?? (await baselineFor(version));
  } else {
    baseline = await baselineFor(version);
  }

  const rows = await listVersions(pageId);
  const authors = await db.select().from(schema.users);
  const authorName = (authorId: string | null) =>
    authors.find((a) => a.id === authorId)?.name ??
    authors.find((a) => a.id === authorId)?.email ??
    null;

  const versions: WorkspaceVersion[] = rows.map((row) => ({
    id: row.id,
    label: row.label,
    status: row.status,
    authorName: authorName(row.authorId),
    isMine: row.authorId === user.id,
    parentVersionId: row.parentVersionId,
    createdAt: row.createdAt.toISOString(),
  }));
  const current = versions.find((v) => v.id === version.id)!;

  const settings = await loadSettings();
  const voices = await listBrandVoices();

  const comments = await db
    .select({
      id: schema.comments.id,
      blockId: schema.comments.blockId,
      body: schema.comments.body,
      resolved: schema.comments.resolved,
      createdAt: schema.comments.createdAt,
      authorName: schema.users.name,
      authorEmail: schema.users.email,
    })
    .from(schema.comments)
    .leftJoin(schema.users, eq(schema.comments.authorId, schema.users.id))
    .where(eq(schema.comments.versionId, versionId));

  return (
    <div className="h-screen overflow-hidden">
      <AppHeader user={user}>
        <div className="flex min-w-0 items-center gap-2 text-xs text-[var(--color-ink-soft)]">
          <Link href={`/pages/${pageId}`} className="truncate hover:text-[var(--color-ink)]">
            {page.name}
          </Link>
          <NewVersionButton
            pageId={pageId}
            parentVersionId={version.id}
            label="Fork"
            seedLabel={`${version.label} — revision`}
          />
        </div>
      </AppHeader>

      <Workspace
        pageId={pageId}
        snapshotId={snapshot.id}
        runtimeVersion={await browserScriptHash("preview")}
        version={current}
        versions={versions}
        initialOps={version.ops}
        baselineBlocks={baseline.blocks}
        baselineMeta={baseline.meta}
        compareVersionId={compareId}
        aiConfig={{
          configured: Boolean(settings?.openrouterKeyEncrypted),
          models: settings?.models ?? [],
          defaultModel: settings?.defaultModel ?? null,
          brandVoices: voices.map((v) => ({
            id: v.id,
            name: v.name,
            isDefault: v.isDefault,
          })),
        }}
        comments={comments.map((c) => ({
          id: c.id,
          blockId: c.blockId,
          body: c.body,
          resolved: c.resolved,
          createdAt: c.createdAt.toISOString(),
          author: c.authorName ?? c.authorEmail ?? "unknown",
        }))}
      />
    </div>
  );
}
