import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { AppHeader } from "@/components/app-header";
import { CaptureStatus } from "@/components/capture-status";
import { NewVersionButton } from "@/components/new-version-button";
import { reapStaleCaptures } from "@/lib/capture/jobs";
import { requireUser } from "@/lib/session";
import { orderByLineage } from "@/lib/version-tree";

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<string, string> = {
  draft: "bg-[var(--color-sunken)] text-[var(--color-ink-soft)]",
  proposed: "bg-[var(--color-changed-soft)] text-[var(--color-changed)]",
  approved: "bg-[var(--color-added-soft)] text-[var(--color-added)]",
  rejected: "bg-[var(--color-removed-soft)] text-[var(--color-removed)]",
};

export default async function PageDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;

  await reapStaleCaptures();

  const page = await db.query.pages.findFirst({ where: eq(schema.pages.id, id) });
  if (!page) notFound();

  const snapshots = await db.query.snapshots.findMany({
    where: eq(schema.snapshots.pageId, id),
    orderBy: desc(schema.snapshots.capturedAt),
  });
  const latest = snapshots[0];

  const versions = await db
    .select({
      id: schema.versions.id,
      label: schema.versions.label,
      status: schema.versions.status,
      createdAt: schema.versions.createdAt,
      parentVersionId: schema.versions.parentVersionId,
      authorName: schema.users.name,
      authorEmail: schema.users.email,
    })
    .from(schema.versions)
    .leftJoin(schema.users, eq(schema.versions.authorId, schema.users.id))
    .where(eq(schema.versions.pageId, id))
    .orderBy(desc(schema.versions.createdAt));


  const ready = latest?.status === "ready";

  return (
    <div className="min-h-screen">
      <AppHeader user={user} />

      <main className="mx-auto max-w-4xl px-6 py-8">
        <Link href="/" className="text-xs text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]">
          ← Pages
        </Link>

        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">{page.name}</h1>
            <a
              href={page.url}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-0.5 block truncate text-xs text-[var(--color-ink-faint)] hover:underline"
            >
              {page.url}
            </a>
          </div>
          {ready ? (
            <NewVersionButton
              pageId={page.id}
              parentVersionId={null}
              bases={versions.map((v) => ({
                id: v.id,
                label: v.label,
                status: v.status,
                authorName: v.authorName ?? v.authorEmail ?? null,
              }))}
            />
          ) : null}
        </div>

        <CaptureStatus
          pageId={page.id}
          status={latest?.status ?? "pending"}
          error={latest?.error ?? null}
          blockCount={latest?.blocks.length ?? 0}
          capturedAt={latest?.capturedAt?.toISOString() ?? null}
        />

        {ready ? (
          <section className="mt-8">
            <h2 className="text-sm font-semibold">Versions</h2>
            {versions.length === 0 ? (
              <div className="panel mt-3 p-8 text-center">
                <p className="text-sm font-medium">No versions yet</p>
                <p className="mx-auto mt-1 max-w-sm text-sm text-[var(--color-ink-soft)]">
                  Create one to start proposing copy against this snapshot.
                </p>
                <div className="mt-4 flex justify-center">
                  <NewVersionButton pageId={page.id} parentVersionId={null} />
                </div>
              </div>
            ) : (
              <ul className="mt-3 space-y-2">
                {/* Indented by lineage: a page can hold several independent
                    roots plus forks of each, and read flat there is nothing to
                    say which is a revision of which. */}
                {orderByLineage(
                  versions.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() })),
                ).map(({ version, depth, parent }) => (
                  <li key={version.id} style={{ marginLeft: depth * 24 }}>
                    <Link
                      href={`/pages/${page.id}/v/${version.id}`}
                      className="panel flex items-center gap-3 px-4 py-3 transition-colors hover:border-[var(--color-line-strong)]"
                    >
                      {depth > 0 ? (
                        <span className="shrink-0 text-xs text-[var(--color-ink-faint)]">↳</span>
                      ) : null}
                      <span className={`chip ${STATUS_STYLE[version.status]}`}>
                        {version.status}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {version.label}
                        </span>
                        <span className="block truncate text-[11px] text-[var(--color-ink-faint)]">
                          compared against {parent ? parent.label : "the live page"}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-[var(--color-ink-faint)]">
                        {version.authorName ?? version.authorEmail ?? "unknown"} ·{" "}
                        {new Date(version.createdAt).toLocaleDateString()}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        {page.brief ? (
          <section className="mt-8">
            <h2 className="text-sm font-semibold">Brief</h2>
            <p className="panel mt-2 whitespace-pre-wrap p-4 text-sm text-[var(--color-ink-soft)]">
              {page.brief}
            </p>
          </section>
        ) : null}
      </main>
    </div>
  );
}
