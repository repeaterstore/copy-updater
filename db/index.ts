import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "@/lib/env";
import * as schema from "./schema";

// Next's dev server re-evaluates modules on every change; without a global the
// pool count climbs until Postgres refuses connections.
const globalForDb = globalThis as unknown as { __cuPool?: Pool };

function pool(): Pool {
  if (!globalForDb.__cuPool) {
    globalForDb.__cuPool = new Pool({
      connectionString: env.databaseUrl,
      max: 10,
    });
  }
  return globalForDb.__cuPool;
}

export const db = drizzle(pool(), { schema });
export { schema };
