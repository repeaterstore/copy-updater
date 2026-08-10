import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { toCsv, toJson, toMarkdown, type ExportContext } from "@/lib/export";
import { requireUser } from "@/lib/session";
import { diffVersions } from "@/lib/versions";

export const dynamic = "force-dynamic";

const FORMATS = {
  md: { fn: toMarkdown, type: "text/markdown; charset=utf-8", ext: "md" },
  csv: { fn: toCsv, type: "text/csv; charset=utf-8", ext: "csv" },
  json: { fn: toJson, type: "application/json; charset=utf-8", ext: "json" },
} as const;

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "export";
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ versionId: string }> },
) {
  await requireUser();
  const { versionId } = await params;

  const url = new URL(request.url);
  const format = (url.searchParams.get("format") ?? "md") as keyof typeof FORMATS;
  const compare = url.searchParams.get("compare");
  const spec = FORMATS[format];
  if (!spec) return new Response("Unknown format", { status: 400 });

  const version = await db.query.versions.findFirst({
    where: eq(schema.versions.id, versionId),
  });
  if (!version) return new Response("Not found", { status: 404 });

  const page = await db.query.pages.findFirst({
    where: eq(schema.pages.id, version.pageId),
  });
  const author = version.authorId
    ? await db.query.users.findFirst({ where: eq(schema.users.id, version.authorId) })
    : null;

  // Default to the parent, so the report shows what this version changed rather
  // than everything that has ever changed on the page.
  const baselineId = compare && compare !== "" ? compare : version.parentVersionId;
  const diff = await diffVersions(baselineId, versionId);

  const context: ExportContext = {
    pageName: page?.name ?? "Page",
    pageUrl: page?.url ?? "",
    versionLabel: version.label,
    versionStatus: version.status,
    author: author?.name ?? author?.email ?? null,
    generatedAt: new Date().toISOString(),
  };

  const body = spec.fn(diff, context);
  const filename = `${slug(context.pageName)}-${slug(version.label)}.${spec.ext}`;

  return new Response(body, {
    headers: {
      "content-type": spec.type,
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}
