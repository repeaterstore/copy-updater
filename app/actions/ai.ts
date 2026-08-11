"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { ReasoningLevel } from "@/db/schema";
import { loadSettings, SETTINGS_ID, verifyKey } from "@/lib/ai/openrouter";
import { encryptSecret } from "@/lib/crypto";
import { OpListSchema } from "@/lib/ops/schema";
import type { Op } from "@/lib/ops/types";
import { requireUser } from "@/lib/session";

export async function recordChosenOptionAction(
  runId: string,
  optionIndex: number,
): Promise<void> {
  await requireUser();
  await db
    .update(schema.aiRuns)
    .set({ chosenOption: optionIndex })
    .where(eq(schema.aiRuns.id, runId));
}

export async function saveSettingsAction(formData: FormData): Promise<{ error?: string }> {
  await requireUser();

  const apiKey = String(formData.get("apiKey") ?? "").trim();
  const models = String(formData.get("models") ?? "")
    .split(/[\n,]/)
    .map((m) => m.trim())
    .filter(Boolean);
  const fallbackModels = String(formData.get("fallbackModels") ?? "")
    .split(/[\n,]/)
    .map((m) => m.trim())
    .filter(Boolean);
  const reasoningLevel = String(formData.get("reasoningLevel") ?? "medium") as ReasoningLevel;

  if (models.length === 0) return { error: "List at least one model id." };

  const existing = await loadSettings();
  if (!apiKey && !existing?.openrouterKeyEncrypted) {
    return { error: "An OpenRouter API key is required." };
  }

  // Only verify when a new key was supplied; leaving the field blank keeps the
  // stored one rather than wiping it.
  if (apiKey) {
    const check = await verifyKey(apiKey);
    if (!check.ok) return { error: check.error ?? "Could not verify that key." };
  }

  const values = {
    id: SETTINGS_ID,
    models,
    fallbackModels,
    reasoningLevel,
    defaultModel: models[0],
    updatedAt: new Date(),
    ...(apiKey ? { openrouterKeyEncrypted: encryptSecret(apiKey) } : {}),
  };

  await db
    .insert(schema.settings)
    .values(values)
    .onConflictDoUpdate({ target: schema.settings.id, set: values });

  revalidatePath("/settings");
  return {};
}

export async function clearApiKeyAction(): Promise<void> {
  await requireUser();
  await db
    .update(schema.settings)
    .set({ openrouterKeyEncrypted: null, updatedAt: new Date() })
    .where(eq(schema.settings.id, SETTINGS_ID));
  revalidatePath("/settings");
}

/** Merge a chosen option's ops into a version's op list. */
export async function applyOptionAction(
  versionId: string,
  ops: unknown,
): Promise<{ ops: Op[] }> {
  await requireUser();

  const parsed = OpListSchema.safeParse(ops);
  if (!parsed.success) throw new Error("The suggestion contained invalid operations.");

  const version = await db.query.versions.findFirst({
    where: eq(schema.versions.id, versionId),
  });
  if (!version) throw new Error("Version not found.");

  return { ops: parsed.data };
}
