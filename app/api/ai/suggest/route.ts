/**
 * Copy suggestions, as a route handler rather than a server action.
 *
 * The difference is cancellation. A server action gives the browser no way to
 * withdraw a request in flight, and these run for tens of seconds — long enough
 * that a reviewer routinely realises they asked the wrong thing. A fetch can be
 * aborted, `request.signal` fires when it is, and that signal reaches the model
 * call itself, so stopping actually stops the work rather than just hiding it.
 */
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { AiMode, ReasoningLevel } from "@/db/schema";
import { cropToBlocks } from "@/lib/ai/crop";
import { loadSettings } from "@/lib/ai/openrouter";
import { describeAiError, generateSuggestions } from "@/lib/ai/suggest";
import { resolveBrandVoice } from "@/lib/ai/voices";
import { requireUser } from "@/lib/session";
import { readDataFile } from "@/lib/storage";

export const dynamic = "force-dynamic";

export interface SuggestRequest {
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
  allModels: boolean;
  brandVoiceId?: string | null;
  customBrandVoice?: string | null;
}

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

function fail(error: string, status = 200) {
  return Response.json({ error }, { status });
}

export async function POST(request: Request) {
  await requireUser();
  const input = (await request.json()) as SuggestRequest;

  const settings = await loadSettings();
  if (!settings?.openrouterKeyEncrypted) {
    return fail("No OpenRouter API key configured. Add one in Settings.");
  }

  const version = await db.query.versions.findFirst({
    where: eq(schema.versions.id, input.versionId),
  });
  if (!version) return fail("Version not found.");

  const page = await db.query.pages.findFirst({
    where: eq(schema.pages.id, version.pageId),
  });
  const snapshot = await db.query.snapshots.findFirst({
    where: eq(schema.snapshots.id, version.snapshotId),
  });
  if (!page || !snapshot) return fail("Page or snapshot missing.");

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
  const user = await requireUser();

  try {
    const { options, modelId } = await generateSuggestions({
      modelId: input.model,
      models: settings.models,
      allModels: input.allModels,
      fallbackModels: settings.fallbackModels,
      reasoningLevel,
      webSearch: input.webSearch,
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
      abortSignal: request.signal,
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
        allModels: input.allModels,
        scope: { kind: input.scopeKind, blockIds: input.scopeBlockIds },
        instructions: input.instructions,
        brandVoice,
        options: options.map((o) => ({
          label: o.label,
          rationale: o.rationale,
          ops: o.ops,
          model: o.model,
        })),
        createdBy: user.id,
      })
      .returning();

    return Response.json({ runId: run.id, options });
  } catch (error) {
    // A cancelled request has no result worth recording and nobody left to
    // read an error — the reviewer already knows, they pressed Stop.
    if (request.signal.aborted) return fail("Cancelled.");

    const message = describeAiError(error);
    await db.insert(schema.aiRuns).values({
      versionId: input.versionId,
      model: input.model,
      mode: input.mode,
      shape: input.shape,
      reasoningLevel,
      webSearch: input.webSearch,
      allModels: input.allModels,
      instructions: input.instructions,
      brandVoice,
      error: message,
      createdBy: user.id,
    });
    return fail(message);
  }
}
