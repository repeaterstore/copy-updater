/**
 * Bundles browser-side entry points to standalone IIFE strings.
 *
 * The capture stamper and the preview runtime both need to run inside a page —
 * the Playwright page during capture, the snapshot iframe during review — while
 * sharing the exact same ops code the server uses. Bundling on demand keeps one
 * source of truth instead of a hand-maintained plain-JS copy that would drift.
 *
 * esbuild takes a few milliseconds and the result is cached for the process
 * lifetime, so this costs nothing after the first capture.
 */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import path from "node:path";

const cache = new Map<string, string>();
const hashes = new Map<string, string>();

export type BrowserEntry = "capture" | "preview";

const ENTRY_FILES: Record<BrowserEntry, string> = {
  capture: "lib/browser/capture-entry.ts",
  preview: "lib/browser/preview-entry.ts",
};

/**
 * Caching is a production optimisation only.
 *
 * These caches live for the life of the process. Next's dev server hot-reloads
 * modules but keeps module state, so a cached bundle survives edits to the
 * browser entry points — the preview iframe then silently runs stale code until
 * the server is restarted, which looks exactly like the fix not working.
 */
const shouldCache = process.env.NODE_ENV === "production";

export async function bundleBrowserScript(entry: BrowserEntry): Promise<string> {
  const cached = shouldCache ? cache.get(entry) : undefined;
  if (cached) return cached;

  const result = await build({
    entryPoints: [path.resolve(process.cwd(), ENTRY_FILES[entry])],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: ["chrome110"],
    minify: true,
    legalComments: "none",
  });

  const code = result.outputFiles?.[0]?.text;
  if (!code) throw new Error(`Failed to bundle browser entry "${entry}".`);

  cache.set(entry, code);
  return code;
}

/**
 * Short content hash of a bundle, for cache-busting.
 *
 * Snapshot HTML is served with the current runtime injected, so the response
 * body changes whenever the runtime changes. Putting this hash in the iframe
 * URL means the browser fetches a genuinely new resource instead of reusing a
 * cached copy — including copies stored under the long-lived immutable header
 * earlier builds sent.
 */
export async function browserScriptHash(entry: BrowserEntry): Promise<string> {
  const existing = shouldCache ? hashes.get(entry) : undefined;
  if (existing) return existing;

  const code = await bundleBrowserScript(entry);
  const hash = createHash("sha256").update(code).digest("hex").slice(0, 12);
  hashes.set(entry, hash);
  return hash;
}
