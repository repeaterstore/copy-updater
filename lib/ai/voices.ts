/**
 * Brand voices: the house style, written once and picked per request.
 *
 * A page's brief and a brand voice answer different questions — the brief is
 * "who is this page for and what must it do", the voice is "how do we sound".
 * They are sent to the model as separate sections for the same reason, so a
 * voice can be reused across every page without dragging one page's audience
 * notes along with it.
 */
import { asc, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";

export type BrandVoiceRow = typeof schema.brandVoices.$inferSelect;

/** Default first, then alphabetical — the order the picker shows them in. */
export async function listBrandVoices(): Promise<BrandVoiceRow[]> {
  return db
    .select()
    .from(schema.brandVoices)
    .orderBy(desc(schema.brandVoices.isDefault), asc(schema.brandVoices.name));
}

export async function defaultBrandVoice(): Promise<BrandVoiceRow | undefined> {
  return db.query.brandVoices.findFirst({
    where: eq(schema.brandVoices.isDefault, true),
  });
}

/**
 * The voice text for a request.
 *
 * A saved voice is looked up rather than trusted from the client, so editing a
 * voice takes effect everywhere immediately and nobody can post arbitrary text
 * under a saved voice's name. Custom text is passed through as typed.
 */
export async function resolveBrandVoice(input: {
  brandVoiceId: string | null;
  customBrandVoice: string | null;
}): Promise<string | null> {
  if (input.brandVoiceId) {
    const row = await db.query.brandVoices.findFirst({
      where: eq(schema.brandVoices.id, input.brandVoiceId),
    });
    return row?.body.trim() || null;
  }
  return input.customBrandVoice?.trim() || null;
}
