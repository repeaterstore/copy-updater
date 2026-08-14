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
import { cropToBlocks, prepareReferenceImage } from "@/lib/ai/crop";
import { loadSettings } from "@/lib/ai/openrouter";
import { describeAiError, generateSuggestions, type SuggestOption } from "@/lib/ai/suggest";
import { resolveBrandVoice } from "@/lib/ai/voices";
import { sectionMarkupFor } from "@/lib/ops/resolve.server";
import { requireUser } from "@/lib/session";
import { loadSkeleton } from "@/lib/versions";
import { readDataFile } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * How long a suggestion may take before it is called a failure.
 *
 * Scaled to what was asked for, because a flat ceiling is wrong in both
 * directions. Rewriting one headline should not be allowed to hang for four
 * minutes; writing three complete sections of markup legitimately takes longer
 * than that, and a fixed four minutes killed it just short of the finish.
 *
 * Measured, not guessed: a three-option add against waveform.com's DAS page —
 * Opus at high reasoning, writing three full sections with the page's own
 * classes — completed in 201 seconds. The old ceiling gave it 240, so a clean
 * run scraped through and any retry at all went over.
 *
 * The per-option allowance dominates because output is what costs time here:
 * each option is a complete section of HTML, not a sentence.
 */
const DEADLINE_BASE_MS = 90_000;
const DEADLINE_PER_OPTION_MS = 75_000;
/** Nothing is worth waiting longer than this, whatever was asked for. */
const DEADLINE_CEILING_MS = 10 * 60_000;

function deadlineFor(optionCount: number, structural: boolean): number {
  const perOption = structural ? DEADLINE_PER_OPTION_MS : DEADLINE_PER_OPTION_MS / 3;
  return Math.min(
    DEADLINE_CEILING_MS,
    DEADLINE_BASE_MS + perOption * Math.max(1, optionCount),
  );
}

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
  /** Adding a section after this block, rather than rewriting what is in scope. */
  addAfterBlockId?: string | null;
  brandVoiceId?: string | null;
  customBrandVoice?: string | null;
  /**
   * A pasted picture of a section someone wants, as a `data:image/…;base64,…`
   * URL. Used for this request and never written anywhere: what persists is
   * the markup the model returns, saved as ops like any other change.
   */
  referenceImage?: string | null;
}

/**
 * Ceiling on the encoded reference image, before decoding.
 *
 * The browser downscales on paste, so anything arriving near this came from
 * somewhere other than the panel. Refusing it costs a copywriter nothing and
 * keeps an ordinary request body from being a way to hand the server 40 MB.
 * Base64 runs about a third larger than the bytes it encodes, hence the margin
 * over what `prepareReferenceImage` will actually forward.
 */
const MAX_REFERENCE_CHARS = 12_000_000;

/**
 * Decode a pasted data URL, or return null.
 *
 * Null every time rather than an error: an unreadable picture should cost the
 * picture, not the request behind it. The one thing worth refusing outright is
 * a payload large enough to be a problem in itself.
 */
async function decodeReferenceImage(value: string | null | undefined) {
  if (!value) return null;
  if (value.length > MAX_REFERENCE_CHARS) return null;

  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(value.trim());
  if (!match) return null;

  try {
    return await prepareReferenceImage(Buffer.from(match[2], "base64"));
  } catch {
    return null;
  }
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

/**
 * An early failure, in the same shape as everything else the client reads.
 *
 * Plain JSON was silently discarded: the reader parses completed lines and
 * throws away the remainder, so a single unterminated object — which is what
 * `Response.json` writes — was never parsed at all. "No OpenRouter API key
 * configured" reached the browser and vanished, leaving Suggest to click and
 * do nothing.
 */
function fail(message: string) {
  const frame: Frame = { type: "error", message };
  return new Response(JSON.stringify(frame) + "\n", {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * One JSON object per line, flushed as it is produced.
 *
 * Not JSON: a single document cannot be read until it is complete, which is the
 * thing being fixed. Newline-delimited JSON is trivially parseable a line at a
 * time and needs no framing library on either end.
 */
type Frame =
  | { type: "option"; model: string; option: SuggestOption }
  | { type: "modelFailed"; model: string; message: string }
  | { type: "done"; runId: string }
  | { type: "error"; message: string };

export async function POST(request: Request) {
  const user = await requireUser();
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

  const referenceImage = await decodeReferenceImage(input.referenceImage);

  /*
   * The markup of the section in question, for layout work.
   *
   * Only for layout mode, and only when something is in scope: a copy rewrite
   * does not need it, and sending it anyway would be several thousand tokens of
   * markup on every request to reword a headline. Failures are non-fatal —
   * a suggestion without the markup is the behaviour that existed before it.
   */
  let sectionHtml: string | null = null;
  // Always fetched for an add: the surrounding markup is not context there, it
  // is the pattern the new section has to match.
  if ((input.mode === "layout" || input.addAfterBlockId) && input.scopeBlockIds.length > 0) {
    sectionHtml = await loadSkeleton(snapshot)
      .then((skeleton) => sectionMarkupFor(skeleton, version.ops ?? [], input.scopeBlockIds))
      .catch(() => null);
  }

  // Adding a section is structural whatever the panel's mode says, and copy
  // mode's schema has no insert op to return.
  const mode: AiMode = input.addAfterBlockId ? "layout" : input.mode;
  const reasoningLevel = reasoningFor(settings.reasoningLevel, mode, input.shape);
  const brandVoice = await resolveBrandVoice({
    brandVoiceId: input.brandVoiceId ?? null,
    customBrandVoice: input.customBrandVoice ?? null,
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (frame: Frame) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(frame) + "\n"));
        } catch {
          // Reader gone — cancelled, or the tab closed. Nothing to report to.
          open = false;
        }
      };

      /*
       * The options in the order the reviewer sees them.
       *
       * With several models asked, they finish out of order, and the generator
       * returns them grouped by model. The panel lists them as they arrive and
       * records which one was applied by its position in that list — so the
       * stored array has to be the streamed order, or "chosen option 1" names
       * a suggestion nobody picked.
       */
      const streamed: SuggestOption[] = [];

      // Composed rather than either alone: Stop must still be instant, and a
      // provider that never answers must still end.
      const deadlineMs = deadlineFor(
        Math.min(Math.max(input.optionCount, 1), 5),
        mode === "layout",
      );
      const deadline = AbortSignal.timeout(deadlineMs);
      const signal = AbortSignal.any([request.signal, deadline]);

      try {
        const { modelId } = await generateSuggestions({
          modelId: input.model,
          models: settings.models,
          allModels: input.allModels,
          fallbackModels: settings.fallbackModels,
          reasoningLevel,
          webSearch: input.webSearch,
          mode,
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
          sectionHtml,
          addAfterBlockId: input.addAfterBlockId ?? null,
          screenshot,
          referenceImage,
          abortSignal: signal,
          // The point of the stream: an option goes out the moment it is
          // complete, rather than when its siblings and the other models are.
          onOption: (model, option) => {
            streamed.push(option);
            send({ type: "option", model, option });
          },
          onModelFailed: (model, message) => send({ type: "modelFailed", model, message }),
        });

        // Stopped between the last model answering and the row being written:
        // there is nobody to hand a run id to, and a run the reviewer withdrew
        // should not turn up in the history as though it completed.
        if (request.signal.aborted) return;

        const [run] = await db
          .insert(schema.aiRuns)
          .values({
            versionId: input.versionId,
            model: modelId,
            mode,
            shape: input.shape,
            reasoningLevel,
            webSearch: input.webSearch,
            allModels: input.allModels,
            scope: { kind: input.scopeKind, blockIds: input.scopeBlockIds },
            instructions: input.instructions,
            brandVoice,
            options: streamed.map((o) => ({
              label: o.label,
              rationale: o.rationale,
              ops: o.ops,
              model: o.model,
            })),
            createdBy: user.id,
          })
          .returning();

        // Last, because the run id only exists once every model has reported.
        send({ type: "done", runId: run.id });
      } catch (error) {
        // A cancelled request has no result worth recording and nobody left to
        // read an error — the reviewer already knows, they pressed Stop.
        if (!request.signal.aborted) {
          const message = deadline.aborted
            ? `No answer after ${Math.round(deadlineMs / 60_000)} minutes, so the ` +
              "request was stopped. Writing whole sections is the slowest thing " +
              "this asks for — try fewer options, or a faster model."
            : describeAiError(error);
          await db.insert(schema.aiRuns).values({
            versionId: input.versionId,
            model: input.model,
            mode,
            shape: input.shape,
            reasoningLevel,
            webSearch: input.webSearch,
            allModels: input.allModels,
            instructions: input.instructions,
            brandVoice,
            error: message,
            createdBy: user.id,
          });
          send({ type: "error", message });
        }
      } finally {
        open = false;
        try {
          controller.close();
        } catch {
          // Already closed by the client going away.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      // Proxies that buffer would defeat the whole exercise.
      "x-accel-buffering": "no",
    },
  });
}

