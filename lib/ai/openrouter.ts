/**
 * Model construction, routed entirely through OpenRouter.
 *
 * One key and one endpoint for every model, which also normalises reasoning and
 * web search across vendors — the reason this replaced a provider row per
 * vendor plus per-provider capability probing.
 */
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { ReasoningLevel } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";

export type SettingsRow = typeof schema.settings.$inferSelect;

export const SETTINGS_ID = "singleton";

export async function loadSettings(): Promise<SettingsRow | undefined> {
  return db.query.settings.findFirst({
    where: eq(schema.settings.id, SETTINGS_ID),
  });
}

export async function hasApiKey(): Promise<boolean> {
  const row = await loadSettings();
  return Boolean(row?.openrouterKeyEncrypted);
}

/**
 * Reasoning is not one parameter: OpenAI and Grok take an effort level, while
 * Anthropic and Gemini take a token budget. Sending the wrong one is ignored,
 * so the level is translated per model family rather than passed through.
 */
type ReasoningConfig =
  | { effort: "high" | "medium" | "low" }
  | { max_tokens: number };

const BUDGET_BY_LEVEL: Record<ReasoningLevel, number> = {
  // Anthropic requires at least 1024.
  low: 1500,
  medium: 4000,
  high: 12000,
};

function usesTokenBudget(modelId: string): boolean {
  return /^(anthropic|google)\//i.test(modelId);
}

export function reasoningFor(modelId: string, level: ReasoningLevel): ReasoningConfig {
  return usesTokenBudget(modelId)
    ? { max_tokens: BUDGET_BY_LEVEL[level] }
    : { effort: level };
}

export interface ModelRequest {
  modelId: string;
  fallbackModels?: string[];
  reasoningLevel: ReasoningLevel;
  /** Let the model search the web for market and competitor language. */
  webSearch?: boolean;
  /** Provider slugs to skip; see structuredOutputCulprit(). */
  ignoreProviders?: string[];
}

/**
 * The provider to blame for a structured-output failure, if the error names one.
 *
 * `require_parameters` filters on what a provider *declares*, which is not the
 * same as what a given account may actually use. A model like
 * anthropic/claude-opus-5 can be served through Azure, whose workspaces gate
 * structured outputs separately — the request is accepted by routing and then
 * rejected with "[Azure] structured_outputs not supported in your workspace."
 * Naming the provider lets the request be retried without it instead of failing
 * in front of a copywriter.
 */
function errorHaystack(error: unknown): string {
  const parts: string[] = [error instanceof Error ? error.message : String(error)];
  const data = (error as { data?: unknown }).data;
  if (data) parts.push(JSON.stringify(data));
  return parts.join(" ");
}

/**
 * Whether the request failed because of the parameters rather than the content.
 *
 * Two shapes mean the same thing. A provider may accept routing and then refuse
 * the schema ("structured_outputs not supported in your workspace"), or routing
 * may find nothing at all ("No endpoints found that can handle the requested
 * parameters") because `require_parameters` plus a parameter like temperature
 * leaves no eligible endpoint. Both are worth retrying with less asked for;
 * neither is worth showing to a copywriter.
 */
export function isParameterRoutingError(error: unknown): boolean {
  return /structured_output|structured outputs|response_format|json_schema|'oneOf'|maxItems|no endpoints found/i.test(
    errorHaystack(error),
  );
}

export function structuredOutputCulprit(error: unknown): string | null {
  const haystack = errorHaystack(error);
  if (!isParameterRoutingError(error)) return null;

  // OpenRouter prefixes the message with the provider, e.g. "[Azure] …", and
  // also reports provider_name in the error metadata.
  const bracketed = haystack.match(/\[([A-Za-z0-9 ._-]+)\]/);
  const named = haystack.match(/"provider_name"\s*:\s*"([^"]+)"/);
  const provider = bracketed?.[1] ?? named?.[1];
  return provider ? provider.trim().toLowerCase().replace(/\s+/g, "-") : null;
}

/**
 * Guides the search toward language research rather than product facts.
 *
 * Search results are the one input that can put confident, well-sourced claims
 * about *some other company's product* in front of a model being asked to write
 * about yours. Framing it this way, plus the existing rule against inventing
 * specs, keeps it to positioning and phrasing.
 */
export const SEARCH_PROMPT =
  "Search for how competitors and buyers in this market describe these products: " +
  "the phrasing, benefits and objections that appear in listings, reviews and forums. " +
  "Treat everything you find as evidence about language and positioning only. " +
  "Never take a specification, price, compatibility or guarantee from a search result " +
  "and apply it to the product on this page.";

export async function buildModel(request: ModelRequest): Promise<LanguageModel> {
  const settings = await loadSettings();
  if (!settings?.openrouterKeyEncrypted) {
    throw new Error("No OpenRouter API key configured. Add one in Settings.");
  }

  const openrouter = createOpenRouter({
    apiKey: decryptSecret(settings.openrouterKeyEncrypted),
  });

  return openrouter(request.modelId, {
    reasoning: reasoningFor(request.modelId, request.reasoningLevel),
    // Tried in order if the chosen model is unavailable, so one flaky provider
    // does not fail a copywriter's request.
    models: request.fallbackModels?.length ? request.fallbackModels : undefined,
    provider: {
      // Load-bearing. The whole pipeline depends on schema-valid ops, and
      // without this OpenRouter may route to a provider that silently ignores
      // response_format and returns prose instead.
      require_parameters: true,
      ignore: request.ignoreProviders?.length ? request.ignoreProviders : undefined,
    },
    plugins: request.webSearch
      ? [
          {
            id: "web",
            max_results: 5,
            search_prompt: SEARCH_PROMPT,
            // `engine` deliberately unset: OpenRouter then uses the provider's
            // native search where it exists (OpenAI, Anthropic, Google,
            // Perplexity) and falls back to Exa elsewhere. There is no "auto"
            // value — omission is how you ask for that behaviour.
          },
        ]
      : undefined,
  }) as LanguageModel;
}

/**
 * Sensible starting list. Editable in Settings; OpenRouter ids are
 * `vendor/model`.
 */
export const SUGGESTED_MODELS = [
  "anthropic/claude-opus-4.5",
  "anthropic/claude-sonnet-4.5",
  "openai/gpt-5.1",
  "google/gemini-3.1-pro-preview",
];

/** Cheap credential check: OpenRouter exposes the key's own metadata. */
export async function verifyKey(apiKey: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (response.ok) return { ok: true };
    if (response.status === 401) return { ok: false, error: "OpenRouter rejected that key." };
    return { ok: false, error: `OpenRouter returned HTTP ${response.status}.` };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
