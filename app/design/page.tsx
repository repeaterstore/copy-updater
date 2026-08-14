import Link from "next/link";
import { groupByPage, listDesignNotes } from "@/lib/comments/design-notes";
import { requireUser } from "@/lib/session";
import { AppHeader } from "@/components/app-header";
import { DesignNoteRow } from "@/components/design/design-note-row";

export const dynamic = "force-dynamic";

/**
 * Everything the copywriters have asked the designer for, in one list.
 *
 * A designer has no reason to open a copy-review tool, read every version of
 * every page and pick out the notes meant for them. This is the page they can
 * be sent instead: what is wrong, where it is, and a link that opens the page
 * with that element already selected.
 *
 * Open notes first and resolved ones behind a fold, because the useful question
 * is "what is left", and a list whose top is finished work stops being read.
 */
export default async function DesignPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>;
}) {
  const user = await requireUser();
  const { show } = await searchParams;
  const showResolved = show === "all";

  const all = await listDesignNotes();
  const notes = showResolved ? all : all.filter((n) => !n.resolved);
  const pages = groupByPage(notes);
  const openTotal = all.filter((n) => !n.resolved).length;
  const resolvedTotal = all.length - openTotal;

  return (
    <div className="min-h-screen">
      <AppHeader user={user} />

      <main className="mx-auto max-w-4xl px-6 py-10">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">For the designer</h1>
            <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
              Comments tagged <code className="text-[var(--color-ink)]">@design</code> across every
              page — the things a copy change cannot fix.
            </p>
          </div>
          <Link
            href={showResolved ? "/design" : "/design?show=all"}
            className="shrink-0 text-xs text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
          >
            {showResolved
              ? `Hide ${resolvedTotal} done`
              : resolvedTotal > 0
                ? `Show ${resolvedTotal} done`
                : ""}
          </Link>
        </div>

        {pages.length === 0 ? (
          <div className="mt-8 rounded-lg border border-dashed border-[var(--color-line-strong)] px-6 py-10 text-center">
            <p className="text-sm text-[var(--color-ink-soft)]">
              {openTotal === 0 && resolvedTotal > 0
                ? "Nothing outstanding — every design note has been marked done."
                : "No design notes yet."}
            </p>
            <p className="mt-2 text-xs text-[var(--color-ink-faint)]">
              Reviewers put one here by writing <code>@design</code> in a comment on any block.
            </p>
          </div>
        ) : (
          <div className="mt-8 space-y-8">
            {pages.map((page) => (
              <section key={page.pageId}>
                <div className="mb-2 flex items-baseline gap-2">
                  <Link
                    href={`/pages/${page.pageId}`}
                    className="text-sm font-semibold hover:underline"
                  >
                    {page.pageName}
                  </Link>
                  <span className="truncate text-[11px] text-[var(--color-ink-faint)]">
                    {page.pageUrl}
                  </span>
                  <span className="ml-auto shrink-0 text-[11px] text-[var(--color-ink-faint)]">
                    {page.notes.filter((n) => !n.resolved).length} open
                  </span>
                </div>

                <ul className="space-y-2">
                  {page.notes.map((note) => (
                    <DesignNoteRow key={note.id} note={note} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
