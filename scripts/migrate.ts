/**
 * Applies pending Drizzle migrations. Runs on container start, before the
 * server boots, so a schema mismatch fails the deploy instead of surfacing as
 * runtime errors.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set; cannot migrate.");
  }

  const pool = new Pool({ connectionString, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
    console.log("migrations applied");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("migration failed:", error);
  process.exit(1);
});
