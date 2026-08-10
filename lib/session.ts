import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { isAllowedEmail } from "@/auth.config";
import { db, schema } from "@/db";

export interface CurrentUser {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
}

/**
 * The signed-in user, creating their row on first sight.
 *
 * Done here rather than in an auth callback so `auth.config.ts` stays free of
 * database imports and can be used by `proxy.ts`. Every write that records
 * authorship goes through this, so the row always exists by the time it is
 * referenced.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session = await auth();
  const email = session?.user?.email;
  // Re-check the domain on every request: a token minted before the allowlist
  // changed must not keep working.
  if (!email || !isAllowedEmail(email)) return null;

  const name = session.user?.name ?? null;
  const image = session.user?.image ?? null;

  const [row] = await db
    .insert(schema.users)
    .values({ email, name, image })
    .onConflictDoUpdate({
      target: schema.users.email,
      set: { name, image },
    })
    .returning();

  if (row) return { id: row.id, email: row.email, name: row.name, image: row.image };

  const existing = await db.query.users.findFirst({
    where: eq(schema.users.email, email),
  });
  return existing
    ? { id: existing.id, email: existing.email, name: existing.name, image: existing.image }
    : null;
}

/**
 * As above, but throws when unauthenticated. Route handlers and server actions
 * must call this rather than trusting the proxy: a matcher change or a Server
 * Function moving route can silently drop proxy coverage.
 */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

export class UnauthorizedError extends Error {
  constructor() {
    super("Not authenticated");
    this.name = "UnauthorizedError";
  }
}
