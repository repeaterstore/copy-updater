import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { bundleBrowserScript } from "@/lib/browser/bundle";
import { injectRuntime } from "@/lib/preview/inject";
import { requireUser } from "@/lib/session";
import { readDataText } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * Serves snapshot HTML to the preview iframe.
 *
 * Same-origin on purpose: the preview runtime is scripted over postMessage and
 * a cross-origin frame could not be driven. Auth is re-checked here rather than
 * relying on the proxy alone.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  await requireUser();
  const { id } = await params;

  const snapshot = await db.query.snapshots.findFirst({
    where: eq(schema.snapshots.id, id),
  });

  if (!snapshot || snapshot.status !== "ready" || !snapshot.htmlPath) {
    return new Response("Snapshot not available", { status: 404 });
  }

  // The runtime is injected here rather than stored, so preview fixes reach
  // every existing snapshot without re-capturing.
  const [stored, runtime] = await Promise.all([
    readDataText(snapshot.htmlPath),
    bundleBrowserScript("preview"),
  ]);
  const html = injectRuntime(stored, runtime);

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The captured page is immutable, but the runtime injected into it is
      // not, so this must be revalidated rather than cached indefinitely.
      "cache-control": "private, no-cache",
      // The snapshot is untrusted third-party markup. It needs to run our
      // inlined runtime, so 'unsafe-inline' is unavoidable, but it must not be
      // able to reach the network or be embedded anywhere but our own app.
      "content-security-policy": [
        "default-src 'self' data: blob:",
        "img-src 'self' data: blob: https: http:",
        "style-src 'self' 'unsafe-inline' data:",
        "font-src 'self' data:",
        "script-src 'unsafe-inline'",
        "frame-ancestors 'self'",
        "form-action 'none'",
      ].join("; "),
      "x-content-type-options": "nosniff",
    },
  });
}
