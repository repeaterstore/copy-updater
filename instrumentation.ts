/**
 * Work that has to happen once, when the server starts.
 *
 * Next calls `register()` on start-up, in the server's own process — which is
 * the point. The same job ran as a separate `tsx scripts/rebuild-stale.ts` step
 * in the start command and failed on every boot with "Cannot find module
 * 'diff'": the image ships Next's standalone output, whose node_modules holds
 * what the *build* traced, and a script run outside the server resolves its
 * imports against a tree that does not have everything the app's own modules
 * expect. In here, every import is one the build already traced.
 */
export async function register() {
  // Only the Node runtime has a database; the edge copy of this must do nothing.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { rebuildStaleVersions } = await import("@/lib/versions");

  /*
   * Deliberately not awaited.
   *
   * Rebuilding a thousand-block version takes seconds, and this runs before
   * the server accepts traffic — blocking here would put minutes into a deploy
   * and risk the health check. Nothing depends on it finishing: a version not
   * yet rebuilt simply serves what it served before.
   */
  void rebuildStaleVersions().catch((error) => {
    console.error("[startup] rebuilding stale versions failed:", error);
  });
}
