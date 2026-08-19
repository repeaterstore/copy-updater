/**
 * Rebuilds the `resolved` cache of versions produced by an older extractor.
 *
 * A manual entry point. The server does this for itself at start-up, from
 * instrumentation.ts — running it as a separate process against the standalone
 * build fails to resolve the app's own imports. This exists for running it by
 * hand against a database, and calls exactly the same function.
 *
 * `resolved` is
 * derived data — the ops are the source of truth — but it is *stored*, so a
 * version keeps whatever the extractor produced on its last save. When
 * extraction changes what counts as a block, the stored copy and a freshly
 * resolved snapshot stop agreeing, and the difference shows up as changes
 * nobody made: making images blocks meant every image on a page read as
 * removed copy in versions that had not been touched in months.
 *
 *   npx tsx scripts/rebuild-stale.ts
 */
import { rebuildStaleVersions } from "@/lib/versions";

rebuildStaleVersions()
  .then(() => process.exit(0))
  .catch((error) => {
    // Exit 0 deliberately: a stale cache is recoverable, and this is also run
    // from places where failing loudly would stop something more important.
    console.error("[rebuild-stale] skipped:", error);
    process.exit(0);
  });
