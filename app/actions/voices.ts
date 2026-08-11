"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireUser } from "@/lib/session";

/** The handle `db.transaction` hands its callback. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Clear whichever row currently holds the default.
 *
 * A partial unique index allows exactly one, so the old default has to be
 * cleared in the same transaction before the new one is set — two updates, not
 * one, because Postgres checks the index per statement.
 */
async function clearDefault(tx: Tx): Promise<void> {
  await tx
    .update(schema.brandVoices)
    .set({ isDefault: false })
    .where(eq(schema.brandVoices.isDefault, true));
}

export async function saveBrandVoiceAction(input: {
  id: string | null;
  name: string;
  body: string;
  isDefault: boolean;
}): Promise<{ error?: string }> {
  const user = await requireUser();

  const name = input.name.trim();
  const body = input.body.trim();
  if (!name) return { error: "Give the voice a name." };
  if (!body) return { error: "A voice needs something to say." };

  await db.transaction(async (tx) => {
    if (input.isDefault) await clearDefault(tx);

    if (input.id) {
      await tx
        .update(schema.brandVoices)
        .set({ name, body, isDefault: input.isDefault, updatedAt: new Date() })
        .where(eq(schema.brandVoices.id, input.id));
      return;
    }

    // The first voice saved becomes the default, since a picker whose only
    // entry is not selected reads as a bug.
    const existing = await tx.select({ id: schema.brandVoices.id }).from(schema.brandVoices);
    await tx.insert(schema.brandVoices).values({
      name,
      body,
      isDefault: input.isDefault || existing.length === 0,
      createdBy: user.id,
    });
  });

  revalidatePath("/settings");
  return {};
}

export async function deleteBrandVoiceAction(id: string): Promise<void> {
  await requireUser();
  await db.delete(schema.brandVoices).where(eq(schema.brandVoices.id, id));
  revalidatePath("/settings");
}

export async function setDefaultBrandVoiceAction(id: string): Promise<void> {
  await requireUser();
  await db.transaction(async (tx) => {
    await clearDefault(tx);
    await tx
      .update(schema.brandVoices)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(schema.brandVoices.id, id));
  });
  revalidatePath("/settings");
}
