"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { AiMode, ReasoningLevel } from "@/db/schema";
import { describeAiError, generateSuggestions, type SuggestOption } from "@/lib/ai/suggest";
import { cropToBlocks } from "@/lib/ai/crop";
import { loadSettings, SETTINGS_ID, verifyKey } from "@/lib/ai/openrouter";
import { resolveBrandVoice } from "@/lib/ai/voices";
import { encryptSecret } from "@/lib/crypto";
import { OpListSchema } from "@/lib/ops/schema";
import type { Op } from "@/lib/ops/types";
import { requireUser } from "@/lib/session";
import { readDataFile } from "@/lib/storage";

/**
 * Reasoning level for a request.
 *
 * Rewriting one headline does not need a reasoning budget; restructuring a
 * section against a list of constraints does. Layout and directives work is
 * therefore raised a step, but never above what the team configured — if
 * someone has deliberately set "low" to keep costs down, that stands.
 */
function reasoningFor(
  configured: ReasoningLevel,
  mode: AiMode,
  shape: string,
): ReasoningLevel {
  const demanding = mode === "layout" || shape === "directives";
  if (!demanding) return configured;
  if (configured === "low") return "low";
  return "high";
}

export async function suggestAction(input: {
  versionId: string;
  model: string;
  mode: AiMode;
  shape: "optimize" | "directives";
  instructions: string | null;
  optionCount: number;
  scopeBlockIds: string[];
  scopeKind: "block" | "section" | "page" | "meta";
  sectionLabel?: string | null;
  webSearch: boolean;
  distinctOptions: boolean;
  /** A saved voice, looked up server-side. Null when using custom text. */
  brandVoiceId?: string | null;
  /** One-off voice typed into the panel, used only when no id is given. */
  customBrandVoice?: string | null;
}): Promise<{ runId: string; options: SuggestOption[] } | { error: string }> {
  const user = await requireUser();

  const settings = await loadSettings();
  if (!settings?.openrouterKeyEncrypted) {
    return { error: "No OpenRouter API key configured. Add one in Settings." };
  }

  const version = await db.query.versions.findFirst({
    where: eq(schema.versions.id, input.versionId),
  });
  if (!version) return { error: "Version not found." };

  const page = await db.query.pages.findFirst({
    where: eq(schema.pages.id, version.pageId),
  });
  const snapshot = await db.query.snapshots.findFirst({
    where: eq(schema.snapshots.id, version.snapshotId),
  });
  if (!page || !snapshot) return { error: "Page or snapshot missing." };

  // Suggest against what this version currently says, not the original page —
  // otherwise the model rewrites edits that were already made.
  const blocks = version.resolved?.blocks ?? snapshot.blocks;
  const meta = version.resolved?.meta ??
    snapshot.meta ?? {
      title: null, description: null, ogTitle: null, ogDescription: null, canonical: null,
    };

  // Crop to the copy in question. The stored screenshot is the whole page —
  // several megabytes and thousands of pixels tall — which is expensive to send
  // and nearly useless as context for rewriting one part of it.
  let screenshot: Buffer | null = null;
  if (snapshot.screenshotPath) {
    const full = await readDataFile(snapshot.screenshotPath).catch(() => null);
    if (full) {
      // Null when the region has no measured box (a collapsed menu item, say);
      // the request then goes without a picture rather than with a useless one.
      //
      // A meta request has no blocks in scope at all, but "what is this page"
      // is precisely what a title and description have to answer — so it gets
      // the top of the page, which is what a search result competes to sum up.
      const region =
        input.scopeKind === "meta"
          ? blocks.slice(0, 10)
          : blocks.filter((b) => input.scopeBlockIds.includes(b.id));
      screenshot = region.length ? await cropToBlocks(full, region) : null;
    }
  }

  const reasoningLevel = reasoningFor(settings.reasoningLevel, input.mode, input.shape);
  const brandVoice = await resolveBrandVoice({
    brandVoiceId: input.brandVoiceId ?? null,
    customBrandVoice: input.customBrandVoice ?? null,
  });

  try {
    const { options, modelId } = await generateSuggestions({
      modelId: input.model,
      fallbackModels: settings.fallbackModels,
      reasoningLevel,
      webSearch: input.webSearch,
      distinctOptions: input.distinctOptions,
      mode: input.mode,
      shape: input.shape,
      instructions: input.instructions,
      optionCount: Math.min(Math.max(input.optionCount, 1), 5),
      pageUrl: page.url,
      pageName: page.name,
      brief: page.brief,
      brandVoice,
      allBlocks: blocks,
      scopeBlockIds: input.scopeBlockIds,
      scopeKind: input.scopeKind,
      sectionLabel: input.sectionLabel,
      meta,
      cssIndex: snapshot.cssIndex,
      screenshot,
    });

    const [run] = await db
      .insert(schema.aiRuns)
      .values({
        versionId: input.versionId,
        model: modelId,
        mode: input.mode,
        shape: input.shape,
        reasoningLevel,
        webSearch: input.webSearch,
        distinctOptions: input.distinctOptions,
        scope: { kind: input.scopeKind, blockIds: input.scopeBlockIds },
        instructions: input.instructions,
        brandVoice,
        options: options.map((o) => ({ label: o.label, rationale: o.rationale, ops: o.ops })),
        createdBy: user.id,
      })
      .returning();

    return { runId: run.id, options };
  } catch (error) {
    const message = describeAiError(error);
    await db.insert(schema.aiRuns).values({
      versionId: input.versionId,
      model: input.model,
      mode: input.mode,
      shape: input.shape,
      reasoningLevel,
      webSearch: input.webSearch,
      distinctOptions: input.distinctOptions,
      instructions: input.instructions,
      brandVoice,
      error: message,
      createdBy: user.id,
    });
    return { error: message };
  }
}

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
