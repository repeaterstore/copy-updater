import Link from "next/link";
import { db } from "@/db";
import { listPagesWithStats } from "@/lib/pages";
import { requireUser } from "@/lib/session";
import { AppHeader } from "@/components/app-header";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await requireUser();
  const rows = await listPagesWithStats(db);

  return (
    <div className="min-h-screen">
      <AppHeader user={user} />

      <main className="mx-auto max-w-5xl px-6 py-10">
        <div className="flex items-end justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Pages</h1>
            <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
              Capture a page, then propose copy against the snapshot.
            </p>
          </div>
          <Link href="/pages/new" className="btn btn-primary">
            Capture a page
          </Link>
        </div>

        {rows.length === 0 ? (
          <div className="panel mt-8 p-10 text-center">
            <p className="text-sm font-medium">No pages captured yet</p>
            <p className="mx-auto mt-1.5 max-w-sm text-sm text-[var(--color-ink-soft)]">
              Paste a URL and Copy Updater freezes a pixel-faithful copy of the page
              to propose changes against.
            </p>
            <Link href="/pages/new" className="btn btn-primary mt-5">
              Capture your first page
            </Link>
          </div>
        ) : (
          <ul className="mt-6 space-y-2">
            {rows.map((page) => (
              <li key={page.id}>
                <Link
                  href={`/pages/${page.id}`}
                  className="panel flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:border-[var(--color-line-strong)]"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{page.name}</p>
                    <p className="truncate text-xs text-[var(--color-ink-faint)]">{page.url}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3 text-xs text-[var(--color-ink-soft)]">
                    {page.snapshotStatus === "pending" ? (
                      <span className="chip bg-[var(--color-changed-soft)] text-[var(--color-changed)]">
                        capturing
                      </span>
                    ) : page.snapshotStatus === "failed" ? (
                      <span className="chip bg-[var(--color-removed-soft)] text-[var(--color-removed)]">
                        capture failed
                      </span>
                    ) : null}
                    <span>
                      {page.versionCount} version{Number(page.versionCount) === 1 ? "" : "s"}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
