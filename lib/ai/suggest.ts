/**
 * The suggestion pipeline: build context, call the model with a schema, then
 * validate what comes back against the request's scope before it is allowed
 * anywhere near a version.
 */
import { generateObject, NoObjectGeneratedError, type ModelMessage } from "ai";
import { z } from "zod";
import { JSDOM } from "jsdom";
import type { AiMode, ReasoningLevel } from "@/db/schema";
import { assignNewIds } from "@/lib/ops/ids";
import { sanitizeCss, sanitizeHtml } from "@/lib/ops/sanitize";
import { OP_SCHEMA_BY_TYPE } from "@/lib/ops/schema";
import type { Block, Op } from "@/lib/ops/types";
import { buildModel, isParameterRoutingError, structuredOutputCulprit } from "./openrouter";
import {
  buildSystemPrompt,
  buildUserPrompt,
  neighboursFor,
  pageSummaryFor,
  type PromptShape,
} from "./prompt";

export interface SuggestOption {
  label: string;
  rationale: string;
  ops: Op[];
  /** Which model wrote it, when several were asked. */
  model?: string;
  /** Ops the model produced that were rejected, and why. */
  rejected: { reason: string }[];
}

export interface SuggestInput {
  modelId: string;
  fallbackModels?: string[];
  reasoningLevel: ReasoningLevel;
  webSearch: boolean;
  /** Ask every configured model rather than just the chosen one. */
  allModels: boolean;
  /** Every model the team has configured, for allModels. */
  models: string[];
  /** Aborts the in-flight provider calls when the reviewer stops waiting. */
  abortSignal?: AbortSignal;
  /**
   * Called for each option the moment it is complete.
   *
   * A request for three options takes as long as writing three; asking four
   * models takes as long as the slowest. Neither wait is necessary to start
   * reading — an option is useful the instant it exists, and the rest can
   * arrive underneath it.
   */
  onOption?: (modelId: string, option: SuggestOption) => void;
  /** Called when a model fails, so the panel can say which and carry on. */
  onModelFailed?: (modelId: string, message: string) => void;
  mode: AiMode;
  shape: PromptShape;
  instructions: string | null;
  optionCount: number;
  pageUrl: string;
  pageName: string;
  brief: string | null;
  brandVoice: string | null;
  allBlocks: Block[];
  scopeBlockIds: string[];
  scopeKind: "block" | "section" | "page" | "meta";
  sectionLabel?: string | null;
  meta: Parameters<typeof buildUserPrompt>[0]["meta"];
  cssIndex: Record<string, string[]>;
  screenshot?: Buffer | null;
  /**
   * A picture of the section someone wants, pasted in for this request only.
   *
   * Not stored anywhere. It is a brief, not an asset: what survives the request
   * is the markup the model writes from it, saved as ops like any other change.
   */
  referenceImage?: Buffer | null;
}

/**
 * Temperature is set per prompt shape, not globally.
 *
 * Directives mode is asked to apply a specific list of changes faithfully, so
 * sampling widely there produces drift from what was actually asked for.
 * Optimize mode is asked to explore, and a low temperature there returns three
 * near-identical rewordings.
 */
const TEMPERATURE_BY_SHAPE: Record<PromptShape, number> = {
  directives: 0.25,
  optimize: 0.85,
};

/**
 * The largest reasoning budget any request asks for. See BUDGET_BY_LEVEL.
 *
 * Anthropic counts thinking against the same ceiling as the answer, so an
 * output limit at or below this leaves nothing to answer with.
 */
const MAX_REASONING_BUDGET = 12_000;

/** Room for one option's worth of markup, generously. */
const TOKENS_PER_OPTION = 6_000;

/**
 * How much the model is allowed to write.
 *
 * Left unset, this takes the provider's default, and on Anthropic that default
 * sits below the reasoning budget a layout request asks for — the model spends
 * its whole allowance thinking, stops mid-JSON, and the SDK reports only that
 * no object was generated. That is the failure this exists to prevent, and it
 * is why the floor has to clear MAX_REASONING_BUDGET rather than merely be
 * "large": the thinking is charged against this number before a single token of
 * the answer is.
 *
 * A ceiling is not a target. Nothing is billed for room that goes unused, so
 * the cost of being generous here is zero and the cost of being tight is a
 * request that fails after the reviewer has waited for it.
 */
function outputCeilingFor(optionCount: number): number {
  return MAX_REASONING_BUDGET + TOKENS_PER_OPTION * Math.max(1, optionCount);
}

/**
 * Flat wire shape for an op, deliberately not a discriminated union.
 *
 * A union compiles to JSON Schema `oneOf`, and Anthropic's structured output
 * rejects it outright — "Schema type 'oneOf' is not supported". Provider
 * routing cannot save us there: the provider does support `response_format`,
 * just not that construct. One object with a `t` discriminator and optional
 * fields is understood everywhere.
 *
 * Being permissive on the wire costs nothing, because every op is parsed back
 * into its strict per-type schema in validateOption before it can be applied.
 */
const COPY_OP_TYPES = ["setText", "setMeta"] as const;
const LAYOUT_OP_TYPES = [
  "setText", "setMeta", "insert", "remove", "move",
  "replaceElement", "setAttr", "addStyle",
] as const;

/**
 * Every field required, empty string meaning "not applicable", and only the
 * fields the mode can actually use.
 *
 * Field count matters: providers compile a grammar for constrained decoding
 * under a time limit, and carrying all twelve fields in both modes failed with
 * "Grammar compilation timed out". Copy mode gets the four it needs.
 *
 * This shape is dictated by two providers pulling in opposite directions:
 *
 *  - OpenAI's strict structured output demands that `required` list every key
 *    in `properties` — optional fields are rejected outright ("'required' is
 *    required to be supplied and to be an array including every key").
 *  - Anthropic rejects `oneOf`, which is what nullable unions compile to.
 *
 * Required-and-nullable satisfies the first and risks the second, so plain
 * required strings with "" as the empty value is the only shape both accept.
 * The emptiness is stripped in narrowOp before anything is validated.
 */
function flatOpSchema(mode: AiMode) {
  const empty = ' Use "" when not applicable.';
  const common = {
    id: z.string().describe("Block id, for ops that target one." + empty),
    html: z.string().describe("Replacement or inserted inline HTML." + empty),
    title: z.string().describe("New meta title, for setMeta." + empty),
    description: z.string().describe("New meta description, for setMeta." + empty),
  };

  if (mode === "copy") {
    return z.object({ t: z.enum(COPY_OP_TYPES), ...common });
  }

  return z.object({
    t: z.enum(LAYOUT_OP_TYPES),
    ...common,
    refId: z.string().describe("Reference block, for insert and move." + empty),
    pos: z
      .enum(["", "before", "after", "firstChild", "lastChild"])
      .describe('Placement for insert and move. Use "" otherwise.'),
    name: z.string().describe("Attribute name, for setAttr." + empty),
    value: z.string().describe('Attribute value; "" removes it.'),
    css: z.string().describe("CSS to append, for addStyle." + empty),
  });
}

/**
 * Anthropic's structured-output schema subset is narrower than JSON Schema:
 * it rejects `oneOf` and it rejects `maxItems` on arrays. Counts are therefore
 * asked for in the prompt and enforced after the fact rather than expressed in
 * the schema.
 */

/**
 * Superset of both mode shapes. Written by hand rather than inferred, because
 * the per-mode schemas omit fields and narrowing would otherwise fail to
 * compile for ops the mode does not allow.
 */
interface FlatOp {
  t: string;
  id?: string;
  html?: string;
  title?: string;
  description?: string;
  refId?: string;
  pos?: string;
  name?: string;
  value?: string;
  css?: string;
}

/** Parse a flat op back into a strict Op, or explain why it cannot be. */
function narrowOp(flat: FlatOp): { op: Op } | { reason: string } {
  const schema = OP_SCHEMA_BY_TYPE[flat.t as keyof typeof OP_SCHEMA_BY_TYPE];
  if (!schema) return { reason: `unknown operation "${flat.t}"` };

  // Drop the "" placeholders the wire format requires, so the strict schemas
  // see genuinely absent fields.
  const present = Object.fromEntries(
    Object.entries(flat).filter(([, value]) => value !== "" && value !== undefined),
  ) as FlatOp;

  // setAttr distinguishes "no value" (remove the attribute) from absent.
  const candidate =
    flat.t === "setAttr" ? { ...present, value: present.value ?? null } : present;

  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { reason: `${flat.t} was missing ${issue?.path.join(".") || "a required field"}` };
  }
  return { op: parsed.data as Op };
}

/**
 * The schema for one option.
 *
 * How many to return is set by the prompt, not a schema bound: Anthropic's
 * structured output rejects maxItems.
 */
function optionSchema(mode: AiMode) {
  return z.object({
    label: z.string().describe("Short name for this approach, 2-5 words"),
    rationale: z
      .string()
      .describe("Why this version is better, and anything worth flagging"),
    ops: z.array(flatOpSchema(mode)),
  });
}

export async function generateSuggestions(
  input: SuggestInput,
): Promise<{ options: SuggestOption[]; modelId: string }> {
  const scopeIds = new Set(input.scopeBlockIds);
  const scope = input.allBlocks.filter((b) => scopeIds.has(b.id));
  // A meta scope is legitimately empty of blocks: the meta fields are the
  // subject, and validation confines the answer to setMeta ops.
  if (scope.length === 0 && input.shape !== "directives" && input.scopeKind !== "meta") {
    throw new Error("Nothing in scope. Select some copy first.");
  }

  // Providers that turned out not to honour structured output for this account.
  // Accumulated across retries so a later attempt does not rediscover the same
  // dead end.
  const ignoreProviders: string[] = [];

  const buildCurrentModel = (modelId: string) =>
    buildModel({
      modelId,
      fallbackModels: input.fallbackModels,
      reasoningLevel: input.reasoningLevel,
      webSearch: input.webSearch,
      ignoreProviders: [...ignoreProviders],
    });

  const system = buildSystemPrompt(input.mode);
  // Meta requests have no scope to take neighbours around, and asking for a
  // description "faithful to what the page offers" while showing none of the
  // page gets an answer written from the brief and the URL alone.
  const context =
    input.scopeKind === "meta"
      ? pageSummaryFor(input.allBlocks)
      : neighboursFor(input.allBlocks, scope);
  /*
   * A reference image makes the request a faithfulness job, whatever shape it
   * was sent as.
   *
   * Optimize runs at 0.85 to explore, which is right when the ask is "improve
   * this" and wrong when it is "reproduce that". Asked to add a section from a
   * screenshot at exploring temperature, the model returned the structure
   * accurately and rewrote every line of approved copy on the way past —
   * including dropping the product names out of it.
   */
  const temperature = input.referenceImage
    ? TEMPERATURE_BY_SHAPE.directives
    : TEMPERATURE_BY_SHAPE[input.shape];

  const prompt =
    buildUserPrompt({
      pageUrl: input.pageUrl,
      pageName: input.pageName,
      brief: input.brief,
      brandVoice: input.brandVoice,
      mode: input.mode,
      shape: input.shape,
      instructions: input.instructions,
      optionCount: input.optionCount,
      meta: input.meta,
      scope,
      context,
      cssIndex: input.cssIndex,
      webSearch: input.webSearch,
      scopeKind: input.scopeKind,
      sectionLabel: input.sectionLabel,
      hasPageImage: Boolean(input.screenshot),
      hasReferenceImage: Boolean(input.referenceImage),
    });

  const run = async (modelId: string): Promise<SuggestOption[]> => {
    const schema = optionSchema(input.mode);

    /*
     * Degrade toward getting a valid answer rather than failing in front of a
     * copywriter.
     *
     * `require_parameters: true` filters routing to providers that declare
     * support for everything in the request, and temperature is part of that.
     * On anthropic/claude-opus-5 the vendor's own endpoint does not declare it,
     * so asking for a temperature narrows routing to Azure — which then refuses
     * structured output at the workspace level.
     *
     * Dropping temperature is necessary but not sufficient: routing is load
     * balanced, so a retry can land on the same bad provider again. Every
     * failure therefore records the provider that refused, and each subsequent
     * attempt excludes everything recorded so far.
     */
    const attempts: { temperature?: number }[] = [
      { temperature },
      {},
      {},
    ];

    let result;
    let lastError: unknown;
    for (const [index, attempt] of attempts.entries()) {
      try {
        result = await generateObject({
          model: await buildCurrentModel(modelId),
          schema: z.object({ options: z.array(schema) }),
          system,
          messages: buildMessages(prompt, input.screenshot, input.referenceImage),
          maxOutputTokens: outputCeilingFor(input.optionCount),
          abortSignal: input.abortSignal,
          ...(attempt.temperature !== undefined ? { temperature: attempt.temperature } : {}),
        });
        break;
      } catch (error) {
        lastError = error;
        // A cancelled request is not a routing problem; stop rather than
        // burning the remaining attempts on a reviewer who has walked away.
        if (input.abortSignal?.aborted) throw error;
        if (!isParameterRoutingError(error)) throw error;

        // Record on every failure, not just the last — otherwise the exclusion
        // is only known once there are no attempts left to use it.
        const culprit = structuredOutputCulprit(error);
        if (culprit && !ignoreProviders.includes(culprit)) ignoreProviders.push(culprit);

        if (index === attempts.length - 1) throw error;
      }
    }
    if (!result) throw lastError ?? new Error("No result generated.");

    /*
     * Handed over one at a time, even though they arrived together.
     *
     * Streaming the model's own output element by element is the version worth
     * having and is not what this is: `streamObject` with an array output hung
     * against this schema — no options, no error — where a trivial schema
     * streamed fine, so something in the op shape or the provider routing does
     * not survive it. Until that is understood, a hang in the one path every
     * suggestion goes through is a far worse trade than waiting for the call.
     * Emitting here keeps the wire format and the panel ready for it, and is
     * what makes several models arrive one after another rather than together.
     */
    return result.object.options.map((option) => {
      const validated = validateOption(
        option as { label: string; rationale: string; ops: FlatOp[] },
        scopeIds,
        input.mode,
        input.scopeKind,
      );
      const tagged = input.allModels ? { ...validated, model: modelId } : validated;
      input.onOption?.(modelId, tagged);
      return tagged;
    });
  };

  if (!input.allModels) {
    return { modelId: input.modelId, options: await run(input.modelId) };
  }

  /*
   * One call per configured model, in parallel.
   *
   * Asking a single model for several options returns several rewordings of
   * one idea — it anchors on its first thought. Different models do not share
   * that anchor, so this is where genuinely different suggestions come from.
   * A model that fails drops out rather than failing the request: three good
   * options from two models beat an error from the third.
   */
  const models = input.models.length > 0 ? input.models : [input.modelId];
  const settled = await Promise.allSettled(
    models.map((modelId) =>
      run(modelId).then(
        (produced) => produced,
        (error) => {
          input.onModelFailed?.(modelId, describeAiError(error));
          throw error;
        },
      ),
    ),
  );
  const options = settled.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );

  if (options.length === 0) {
    const failure = settled.find((r) => r.status === "rejected");
    throw failure && failure.status === "rejected"
      ? failure.reason
      : new Error("No options were generated.");
  }

  return { modelId: models.join(", "), options };
}

/**
 * Order is load-bearing when there are two images.
 *
 * Nothing labels an image part, so the only thing telling the model which
 * picture is the page and which is the reference is the order they arrive in
 * and the sentence in the prompt that describes that order. The prompt is built
 * from the same two flags, so the two cannot drift apart.
 */
function buildMessages(
  prompt: string,
  screenshot: Buffer | null | undefined,
  referenceImage?: Buffer | null,
): ModelMessage[] {
  const images = [screenshot, referenceImage].filter((b): b is Buffer => Boolean(b));
  if (images.length === 0) {
    return [{ role: "user", content: prompt }];
  }
  return [
    {
      role: "user",
      content: [
        { type: "text", text: prompt },
        // A "file" part, not the deprecated "image" part, which v7 warns about.
        ...images.map((image) => ({
          type: "file" as const,
          mediaType: "image/png",
          data: new Uint8Array(image),
        })),
      ],
    },
  ];
}

/**
 * Enforce the request's boundaries on what came back.
 *
 * Models reference ids they were only shown as context, and occasionally invent
 * them. Applying those would edit copy nobody asked to change, so they are
 * dropped and reported rather than silently passed through.
 */
function validateOption(
  option: { label: string; rationale: string; ops: FlatOp[] },
  scopeIds: Set<string>,
  mode: AiMode,
  scopeKind: SuggestInput["scopeKind"],
): SuggestOption {
  const dom = new JSDOM("<!doctype html><body></body>");
  const doc = dom.window.document;

  const ops: Op[] = [];
  const rejected: { reason: string }[] = [];

  for (const flat of option.ops) {
    if (mode === "copy" && flat.t !== "setText" && flat.t !== "setMeta") {
      rejected.push({ reason: `"${flat.t}" is not allowed in copy mode` });
      continue;
    }
    // A meta request has no blocks in scope, so the id checks below cannot
    // catch anything: addStyle names no block and would otherwise sail through
    // in layout mode, letting "rewrite the title" quietly add page CSS.
    if (scopeKind === "meta" && flat.t !== "setMeta") {
      rejected.push({ reason: `"${flat.t}" is not allowed in a meta-only request` });
      continue;
    }

    const narrowed = narrowOp(flat);
    if ("reason" in narrowed) {
      rejected.push(narrowed);
      continue;
    }
    const op = narrowed.op;

    switch (op.t) {
      case "setText": {
        if (!scopeIds.has(op.id)) {
          rejected.push({ reason: `${op.id} was not in scope` });
          continue;
        }
        ops.push({ ...op, html: sanitizeHtml(doc, op.html) });
        break;
      }
      case "setMeta":
        ops.push(op);
        break;
      case "remove":
      case "move":
      case "setAttr":
      case "replaceElement": {
        if (!scopeIds.has(op.id)) {
          rejected.push({ reason: `${op.id} was not in scope` });
          continue;
        }
        ops.push(
          op.t === "replaceElement"
            ? // The replacement may keep the id of what it replaces — that is
              // the one id it is entitled to — but nothing else it copied.
              { ...op, html: assignNewIds(doc, sanitizeHtml(doc, op.html), op.id) }
            : op,
        );
        break;
      }
      case "insert": {
        if (!scopeIds.has(op.refId)) {
          rejected.push({ reason: `${op.refId} was not in scope` });
          continue;
        }
        // Ids are minted now, not at apply time, so replaying the op list is
        // stable and comments stay attached to what they point at.
        ops.push({ ...op, html: assignNewIds(doc, sanitizeHtml(doc, op.html)) });
        break;
      }
      case "addStyle":
        ops.push({ ...op, css: sanitizeCss(op.css) });
        break;
    }
  }

  dom.window.close();
  return { label: option.label, rationale: option.rationale, ops, rejected };
}

export function describeAiError(error: unknown): string {
  if (NoObjectGeneratedError.isInstance(error)) {
    /*
     * The one failure where the model had something to say and we threw it
     * away.
     *
     * "Did not return a usable result" is true of a refusal, a truncation, a
     * provider ignoring the schema and a model answering in prose, and it sends
     * everyone to guess at which. The SDK hands us the raw text, the finish
     * reason and the usage; none of it was going anywhere before this. The log
     * gets all of it, and the reviewer gets the part they can act on.
     */
    console.error("[ai] model returned no usable object", {
      finishReason: error.finishReason,
      usage: error.usage,
      text: error.text?.slice(0, 2000),
    });

    // Truncation, which reads as gibberish rather than as running out of room.
    if (error.finishReason === "length") {
      return (
        "The model ran out of room before finishing. Ask for fewer options, or " +
        "narrow the scope to a smaller part of the page."
      );
    }

    const said = error.text?.trim();
    if (said) {
      const excerpt = said.length > 240 ? `${said.slice(0, 240)}…` : said;
      return `The model answered in prose instead of changes. It said: ${excerpt}`;
    }

    return "The model returned nothing at all. Try again, or pick a different model.";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/401|unauthor|invalid.*api.?key|no auth/i.test(message)) {
    return "OpenRouter rejected the API key. Check it in Settings.";
  }
  if (/402|credit|insufficient/i.test(message)) {
    return "OpenRouter reports insufficient credit for this request.";
  }
  if (/429|rate.?limit/i.test(message)) {
    return "Rate limited. Wait a moment and try again.";
  }
  if (/no (allowed )?providers|no endpoints/i.test(message)) {
    return (
      "No provider for that model supports structured output. " +
      "Pick a different model in the suggest panel."
    );
  }
  // Order matters: a size complaint also mentions "image", and telling someone
  // their model lacks vision when the picture was simply too big sends them to
  // change the wrong thing.
  if (/exceeds|too large|maximum.*bytes|payload/i.test(message)) {
    return "The page screenshot was too large for this model. Try a smaller scope.";
  }
  if (/image|vision|multimodal/i.test(message)) {
    return "That model cannot accept the page screenshot. Pick a vision-capable model.";
  }
  return message;
}

