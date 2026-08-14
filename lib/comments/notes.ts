/**
 * The shape of a design note and how the list is ordered.
 *
 * Split from the query so it can be tested without a database — and so a
 * client component can import the type without pulling the server's db handle
 * into the browser bundle.
 */
export interface DesignNote {
  id: string;
  body: string;
  resolved: boolean;
  createdAt: string;
  author: string;
  pageId: string;
  pageName: string;
  pageUrl: string;
  versionId: string;
  versionLabel: string;
  /** Null for a note on the meta fields rather than a block. */
  blockId: string | null;
  /** What the note is attached to, as it currently reads. */
  blockText: string | null;
  blockRole: string | null;
}

export interface DesignNotePage {
  pageId: string;
  pageName: string;
  pageUrl: string;
  notes: DesignNote[];
}

/**
 * Grouped by page, because that is the unit a designer opens.
 *
 * Ordered newest first within a page, and pages with unresolved notes first —
 * a list whose top is already done is a list nobody reads twice.
 */
export function groupByPage(notes: DesignNote[]): DesignNotePage[] {
  const byPage = new Map<string, DesignNotePage>();
  for (const note of notes) {
    const existing = byPage.get(note.pageId);
    if (existing) existing.notes.push(note);
    else {
      byPage.set(note.pageId, {
        pageId: note.pageId,
        pageName: note.pageName,
        pageUrl: note.pageUrl,
        notes: [note],
      });
    }
  }

  const openCount = (p: DesignNotePage) => p.notes.filter((n) => !n.resolved).length;
  return [...byPage.values()].sort((a, b) => {
    const open = openCount(b) - openCount(a);
    return open !== 0 ? open : a.pageName.localeCompare(b.pageName);
  });
}
