/**
 * Rebuilds the `resolved` cache of versions produced by an older extractor.
 *
 * Runs at container start, before the server accepts traffic. `resolved` is
 * derived data — the ops are the source of truth — but it is *stored*, so a
 * version keeps whatever the extractor produced on its last save. When
 * extraction changes what counts as a block, the stored copy and a freshly
 * resolved snapshot stop agreeing, and the difference shows up as changes
 * nobody made: making images blocks meant every image on a page read as
 * removed copy in versions that had not been touched in months.
 *
 * Guarded by the stamp rather than run unconditionally, so this costs one query
 * on every boot after the one that needs it. A thousand-block page takes ~4s to
 * resolve, and doing that for every version on every restart would put minutes
 * into each deploy for no reason.
 *
 * Never fails the boot. A version that cannot be rebuilt is one version showing
 * a stale diff; a container that will not start is the whole tool down.
 *
 *   npx tsx scripts/rebuild-stale.ts
 */
import { db, schema } from "@/db";
import { EXTRACTOR_VERSION } from "@/lib/ops/types";
import { rebuildResolved } from "@/lib/versions";

async function main() {
  const versions = await db
    .select({
      id: schema.versions.id,
      label: schema.versions.label,
      resolved: schema.versions.resolved,
    })
    .from(schema.versions);

  const stale = versions.filter((v) => (v.resolved?.v ?? 0) < EXTRACTOR_VERSION);
  if (stale.length === 0) {
    console.log(`[rebuild-stale] all ${versions.length} version(s) at extractor v${EXTRACTOR_VERSION}`);
    return;
  }

  console.log(`[rebuild-stale] rebuilding ${stale.length} of ${versions.length} version(s)`);
  let done = 0;
  for (const version of stale) {
    try {
      await rebuildResolved(version.id);
      done += 1;
    } catch (error) {
      console.log(
        `[rebuild-stale]   ✗ ${version.label}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  console.log(`[rebuild-stale] rebuilt ${done}/${stale.length}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    // Deliberately exit 0: a stale diff is recoverable, a container that will
    // not boot is not.
    console.error("[rebuild-stale] skipped:", error);
    process.exit(0);
  });
