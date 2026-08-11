/**
 * Change reports for handing approved copy to whoever applies it.
 *
 * Markdown and CSV are for people; JSON is keyed by block id and structural
 * path so a CMS writer can consume it later without a schema change.
 */
import type { ResolvedDiff } from "@/lib/ops/diff";

export interface ExportContext {
  pageName: string;
  pageUrl: string;
  versionLabel: string;
  versionStatus: string;
  /**
   * What the diff is measured against, in words.
   *
   * A version can be exported against its parent or against the captured page,
   * and the two reports list different changes. Without saying which, the
   * reader has no way to tell them apart.
   */
  baselineLabel: string;
  author: string | null;
  generatedAt: string;
}

const META_LABEL: Record<string, string> = {
  title: "Meta title",
  description: "Meta description",
  ogTitle: "OG title",
  ogDescription: "OG description",
  canonical: "Canonical URL",
};

export function toMarkdown(diff: ResolvedDiff, context: ExportContext): string {
  const lines: string[] = [];

  lines.push(`# Copy changes — ${context.pageName}`);
  lines.push("");
  lines.push(`- **Page:** ${context.pageUrl}`);
  lines.push(`- **Version:** ${context.versionLabel} (${context.versionStatus})`);
  lines.push(`- **Compared against:** ${context.baselineLabel}`);
  if (context.author) lines.push(`- **Author:** ${context.author}`);
  lines.push(`- **Generated:** ${context.generatedAt}`);
  lines.push(
    `- **Changes:** ${diff.counts.changed} edited · ${diff.counts.added} added · ` +
      `${diff.counts.removed} removed · ${diff.counts.moved} moved`,
  );
  lines.push("");

  if (diff.meta.length) {
    lines.push("## Meta");
    lines.push("");
    for (const change of diff.meta) {
      lines.push(`### ${META_LABEL[change.field] ?? change.field}`);
      lines.push("");
      lines.push(`- **Before** (${(change.before ?? "").length} chars): ${change.before ?? "—"}`);
      lines.push(`- **After** (${(change.after ?? "").length} chars): ${change.after ?? "—"}`);
      lines.push("");
    }
  }

  const bySection = new Map<string, typeof diff.blocks>();
  for (const change of diff.blocks) {
    if (change.kind === "unchanged") continue;
    const label = change.after?.sectionLabel ?? change.before?.sectionLabel ?? "Page";
    const list = bySection.get(label) ?? [];
    list.push(change);
    bySection.set(label, list);
  }

  if (bySection.size) {
    lines.push("## Copy");
    lines.push("");
    for (const [section, changes] of bySection) {
      lines.push(`### ${section}`);
      lines.push("");
      for (const change of changes) {
        const role = change.after?.role ?? change.before?.role ?? "block";
        const tag = change.after?.tag ?? change.before?.tag ?? "";
        const flag = diff.layoutRisk.includes(change.id) ? " ⚠︎ check layout" : "";

        switch (change.kind) {
          case "changed":
            lines.push(`**${role} \`<${tag}>\`**${flag}`);
            lines.push("");
            lines.push(`- Before: ${change.before?.text ?? ""}`);
            lines.push(`- After: ${change.after?.text ?? ""}`);
            break;
          case "added":
            lines.push(`**Added ${role} \`<${tag}>\`**`);
            lines.push("");
            lines.push(`- ${change.after?.text ?? ""}`);
            break;
          case "removed":
            lines.push(`**Removed ${role} \`<${tag}>\`**`);
            lines.push("");
            lines.push(`- ~~${change.before?.text ?? ""}~~`);
            break;
          case "moved":
            lines.push(`**Moved ${role} \`<${tag}>\`**`);
            lines.push("");
            lines.push(`- ${change.after?.text ?? ""}`);
            break;
        }
        lines.push("");
        lines.push(`  \`${change.id}\``);
        lines.push("");
      }
    }
  }

  if (diff.stylesAdded.length) {
    lines.push("## CSS added");
    lines.push("");
    lines.push("```css");
    lines.push(diff.stylesAdded.join("\n\n"));
    lines.push("```");
    lines.push("");
  }

  if (diff.counts.total === 0 && diff.meta.length === 0) {
    lines.push("_No changes._");
  }

  return lines.join("\n");
}

function csvCell(value: string | null | undefined): string {
  const text = value ?? "";
  return `"${text.replace(/"/g, '""')}"`;
}

export function toCsv(diff: ResolvedDiff, context: ExportContext): string {
  const rows: string[] = [
    ["section", "kind", "role", "tag", "before", "after", "before_chars", "after_chars", "block_id", "flag"]
      .map(csvCell)
      .join(","),
  ];

  for (const change of diff.meta) {
    rows.push(
      [
        csvCell("Meta"),
        csvCell("changed"),
        csvCell(META_LABEL[change.field] ?? change.field),
        csvCell(""),
        csvCell(change.before),
        csvCell(change.after),
        csvCell(String((change.before ?? "").length)),
        csvCell(String((change.after ?? "").length)),
        csvCell(change.field),
        csvCell(""),
      ].join(","),
    );
  }

  for (const change of diff.blocks) {
    if (change.kind === "unchanged") continue;
    rows.push(
      [
        csvCell(change.after?.sectionLabel ?? change.before?.sectionLabel ?? "Page"),
        csvCell(change.kind),
        csvCell(change.after?.role ?? change.before?.role ?? ""),
        csvCell(change.after?.tag ?? change.before?.tag ?? ""),
        csvCell(change.before?.text ?? ""),
        csvCell(change.after?.text ?? ""),
        csvCell(String((change.before?.text ?? "").length)),
        csvCell(String((change.after?.text ?? "").length)),
        csvCell(change.id),
        csvCell(diff.layoutRisk.includes(change.id) ? "check layout" : ""),
      ].join(","),
    );
  }

  void context;
  return rows.join("\n");
}

export function toJson(diff: ResolvedDiff, context: ExportContext): string {
  return JSON.stringify(
    {
      page: { name: context.pageName, url: context.pageUrl },
      version: {
        label: context.versionLabel,
        status: context.versionStatus,
        author: context.author,
      },
      comparedAgainst: context.baselineLabel,
      generatedAt: context.generatedAt,
      counts: diff.counts,
      meta: diff.meta.map((m) => ({ field: m.field, before: m.before, after: m.after })),
      blocks: diff.blocks
        .filter((c) => c.kind !== "unchanged")
        .map((c) => ({
          id: c.id,
          kind: c.kind,
          role: c.after?.role ?? c.before?.role ?? null,
          tag: c.after?.tag ?? c.before?.tag ?? null,
          section: c.after?.sectionLabel ?? c.before?.sectionLabel ?? null,
          before: c.before ? { text: c.before.text, html: c.before.html } : null,
          after: c.after ? { text: c.after.text, html: c.after.html } : null,
          layoutRisk: diff.layoutRisk.includes(c.id),
        })),
      stylesAdded: diff.stylesAdded,
    },
    null,
    2,
  );
}
