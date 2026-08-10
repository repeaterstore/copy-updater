import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireUser } from "@/lib/session";
import { readDataFile } from "@/lib/storage";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  await requireUser();
  const { id } = await params;

  const snapshot = await db.query.snapshots.findFirst({
    where: eq(schema.snapshots.id, id),
  });
  if (!snapshot?.screenshotPath) {
    return new Response("Not found", { status: 404 });
  }

  const png = await readDataFile(snapshot.screenshotPath);
  return new Response(new Uint8Array(png), {
    headers: {
      "content-type": "image/png",
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}
