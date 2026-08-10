/**
 * Rebuilds every version's `resolved` cache from its ops.
 *
 * `resolved` is derived data — ops are the source of truth — so this is safe to
 * run at any time and is idempotent. Needed after any change to extraction or
 * op-application logic, since existing rows still hold output from the old
 * code until their next save.
 *
 *   npx tsx scripts/rebuild-resolved.ts
 */
import { db, schema } from "@/db";
import { rebuildResolved } from "@/lib/versions";

async function main() {
  const versions = await db
    .select({ id: schema.versions.id, label: schema.versions.label })
    .from(schema.versions);

  if (versions.length === 0) {
    console.log("No versions to rebuild.");
    return;
  }

  let rebuilt = 0;
  for (const version of versions) {
    try {
      const { failures } = await rebuildResolved(version.id);
      rebuilt += 1;
      const note = failures.length ? ` (${failures.length} op(s) failed to apply)` : "";
      console.log(`  ✓ ${version.label}${note}`);
      for (const failure of failures) console.log(`      ${failure.reason}`);
    } catch (error) {
      console.log(
        `  ✗ ${version.label}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  console.log(`\nRebuilt ${rebuilt}/${versions.length} versions.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
