"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { recordChosenOptionAction } from "@/app/actions/ai";
import type { AiMode } from "@/db/schema";
import type { Op } from "@/lib/ops/types";
import type { SuggestOption } from "@/lib/ai/suggest";
import { htmlToText, type SectionScope } from "@/lib/workspace/derive";

type Scope = "block" | "section" | "page";

export interface BrandVoiceOption {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface AiConfig {
  configured: boolean;
  models: string[];
  defaultModel: string | null;
  brandVoices: BrandVoiceOption[];
}

/** Sentinel values for the voice picker; neither can collide with a uuid. */
const VOICE_NONE = "";
const VOICE_CUSTOM = "custom";

export function AiPanel({
  versionId,
  config,
  selectedBlockId,
  visibleBlockIds,
  section,
  describeBlock,
  onApply,
  addRequest,
  onClearAddRequest,
  readOnly,
}: {
  versionId: string;
  config: AiConfig;
  selectedBlockId: string | null;
  /** Everything currently listed in the outline, for whole-page scope. */
  visibleBlockIds: string[];
  /** The section containing the selection, if any. */
  section: SectionScope | null;
  /** Current text of a block, for showing before/after inside an option. */
  describeBlock: (id: string) => { text: string; role: string } | null;
  /** `replacing` is the option applied before it, which this one supersedes. */
  onApply: (ops: Op[], replacing?: Op[]) => void;
  /**
   * Set when the outline's "+" asked for a section, naming what it goes after.
   *
   * The panel switches into adding rather than rewriting: the request carries
   * the anchor, the model is told to return one insert, and the surrounding
   * markup goes along as the pattern to match.
   */
  addRequest: { afterBlockId: string; sectionLabel: string } | null;
  onClearAddRequest: () => void;
  readOnly: boolean;
}) {
  const [model, setModel] = useState(config.defaultModel ?? config.models[0] ?? "");
  const [mode, setMode] = useState<AiMode>("copy");
  const [shape, setShape] = useState<"optimize" | "directives">("optimize");
  const [scope, setScope] = useState<Scope>("block");
  const [instructions, setInstructions] = useState("");
  // The team's default is preselected; "None" is still reachable, for pages
  // whose existing voice is the thing being preserved.
  const [voiceId, setVoiceId] = useState(
    config.brandVoices.find((v) => v.isDefault)?.id ?? VOICE_NONE,
  );
  const [customVoice, setCustomVoice] = useState("");
  const [optionCount, setOptionCount] = useState(3);
  const [webSearch, setWebSearch] = useState(false);
  const [allModels, setAllModels] = useState(false);
  const [options, setOptions] = useState<SuggestOption[] | null>(null);
  /** Models that failed while others succeeded — worth naming, not worth failing for. */
  const [modelErrors, setModelErrors] = useState<string[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  /**
   * Seconds since the request went out.
   *
   * A suggestion can legitimately run for two minutes, and for those two
   * minutes the panel said "Thinking…" and nothing else — indistinguishable
   * from a request that had died. The server gives up at four minutes; this is
   * what shows the wait is real until then.
   */
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!pending) return;
    setElapsed(0);
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [pending]);

  /**
   * A picture of the section someone wants, held for this request only.
   *
   * Deliberately not persisted. What survives is the markup the model writes
   * from it, saved as ops like any other change — so a colleague opening the
   * version sees the section, just not the screenshot it came from.
   */
  const [reference, setReference] = useState<{ dataUrl: string; label: string } | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  /**
   * Downscale before the image ever reaches the request body.
   *
   * A screenshot off a 4K monitor is around 3840px wide and several megabytes,
   * which is bytes spent on detail no model needs to read a headline. The
   * server caps it again on arrival — this is about not sending it twice over
   * a connection someone is waiting on.
   */
  const loadReference = (file: File) => {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const MAX_EDGE = 1600;
        const scale = Math.min(1, MAX_EDGE / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        setReference({
          // PNG rather than JPEG: the model has to read the words in this, and
          // JPEG artefacts land hardest on small text against flat colour,
          // which is most of what a marketing section is.
          dataUrl: canvas.toDataURL("image/png"),
          label: file.name || `Pasted image · ${canvas.width}×${canvas.height}`,
        });
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  };

  /**
   * Paste anywhere in the panel, without stealing an ordinary text paste.
   *
   * The instructions box lives inside this element, so this fires for text too.
   * It acts only when the clipboard actually carries an image and never calls
   * preventDefault otherwise, which leaves pasting a list of directives exactly
   * as it was.
   */
  const onPaste = (event: React.ClipboardEvent) => {
    const item = Array.from(event.clipboardData?.items ?? []).find((i) =>
      i.type.startsWith("image/"),
    );
    if (!item) return;
    const file = item.getAsFile();
    if (!file) return;
    event.preventDefault();
    loadReference(file);
  };

  if (!config.configured) {
    return (
      <section className="border-t border-[var(--color-line)] pt-3">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">
          AI suggestions
        </p>
        <p className="mt-1.5 text-xs text-[var(--color-ink-soft)]">
          No OpenRouter key configured.{" "}
          <a href="/settings" className="underline underline-offset-2">
            Add one in Settings
          </a>{" "}
          to generate copy.
        </p>
      </section>
    );
  }

  /*
   * Adding is always scoped to the section it follows.
   *
   * The scope is what the model is shown and what an op is allowed to name, and
   * an insert has to be anchored to something in it. Leaving that to whatever
   * the scope toggle happened to be set to meant the anchor could be out of
   * scope and every option rejected on arrival.
   */
  const scopeIds = addRequest
    ? (section?.blockIds?.length ? section.blockIds : [addRequest.afterBlockId])
    : scope === "page"
      ? visibleBlockIds
      : scope === "section"
        ? (section?.blockIds ?? [])
        : selectedBlockId
          ? [selectedBlockId]
          : [];

  // "Block" scope with nothing selected means the meta fields are showing in
  // the inspector — a meta-only request. setMeta is all it may produce, which
  // the server enforces; here we just have to let the button be clickable.
  const metaScope = scope === "block" && !selectedBlockId;

  /**
   * Held so Stop can abort the request.
   *
   * The suggestion runs over fetch rather than as a server action precisely so
   * it can be withdrawn: aborting here closes the connection, which fires
   * request.signal on the server, which is passed down to the model call. The
   * work actually stops rather than finishing unwatched and being billed for.
   */
  const inFlight = useRef<AbortController | null>(null);
  /**
   * The option applied from this request, if any.
   *
   * Trying option two after option one should replace it, not add to it. Reset
   * per request, so applying a suggestion for one section never undoes a
   * suggestion already applied to a different one.
   */
  const applied = useRef<Op[]>([]);

  const run = () => {
    setError(null);
    setOptions(null);
    setModelErrors([]);
    // Not the previous request's run. Applying the first option of a new one
    // before it finishes would otherwise be recorded against the old run,
    // naming a suggestion from a request nobody is looking at any more.
    setRunId(null);
    applied.current = [];
    const controller = new AbortController();
    inFlight.current = controller;

    start(async () => {
      try {
        const response = await fetch("/api/ai/suggest", {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            versionId,
            model,
            mode,
            shape,
            instructions: instructions.trim() || null,
            optionCount,
            scopeBlockIds: scopeIds,
            scopeKind: metaScope ? "meta" : scope,
            sectionLabel: scope === "section" ? (section?.label ?? null) : null,
            addAfterBlockId: addRequest?.afterBlockId ?? null,
            webSearch,
            allModels,
            brandVoiceId: voiceId === VOICE_CUSTOM || voiceId === VOICE_NONE ? null : voiceId,
            customBrandVoice: voiceId === VOICE_CUSTOM ? customVoice.trim() || null : null,
            referenceImage: reference?.dataUrl ?? null,
          }),
        });
        /*
         * Newline-delimited JSON, read as it arrives.
         *
         * Each completed option is its own line, so the first suggestion is on
         * screen while the rest are still being written — and with several
         * models asked, a fast model's answers do not wait behind a slow one's.
         */
        const reader = response.body?.getReader();
        if (!reader) throw new Error("The response could not be read.");
        const decoder = new TextDecoder();
        let buffer = "";

        const handle = (line: string) => {
          if (!line.trim()) return;
          const frame = JSON.parse(line);
          if (frame.type === "option") {
            setOptions((current) => [...(current ?? []), frame.option]);
          } else if (frame.type === "modelFailed") {
            setModelErrors((current) => [...current, `${frame.model}: ${frame.message}`]);
          } else if (frame.type === "done") {
            setRunId(frame.runId);
          } else if (frame.type === "error") {
            setError(frame.message);
          }
        };

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // The last piece may be a partial line; leave it for the next chunk.
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) handle(line);
        }

        // Whatever arrived without a closing newline. A request that fails
        // before the stream starts is one short object and nothing else, so
        // dropping the remainder here is dropping the entire explanation.
        handle(buffer);
      } catch (error) {
        // Aborting is a choice the reviewer just made, not news to report.
        if ((error as Error)?.name !== "AbortError") {
          setError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        inFlight.current = null;
      }
    });
  };

  const stop = () => inFlight.current?.abort();

  return (
    <section className="border-t border-[var(--color-line)] pt-3" onPaste={onPaste}>
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">
        AI suggestions
      </p>

      <div className="space-y-2">
        <select
          className="field py-1 text-xs disabled:opacity-50"
          value={model}
          disabled={allModels}
          title={allModels ? "Every model is being asked, so this is not used" : undefined}
          onChange={(e) => setModel(e.target.value)}
        >
          {config.models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>

        {/* Scope, mode and shape all describe rewriting copy that exists. None
            of them mean anything for a section that does not yet, and leaving
            them on screen invited someone to set a scope the request then
            ignores. */}
        {addRequest ? null : (
          <>
        <Segmented
          value={scope}
          onChange={setScope}
          options={[
            { value: "block", label: selectedBlockId ? "Block" : "Meta" },
            { value: "section", label: "Section" },
            { value: "page", label: "Page" },
          ]}
        />

        {scope === "section" ? (
          section ? (
            <p className="text-[11px] text-[var(--color-ink-soft)]">
              {section.blockIds.length} blocks in{" "}
              <span className="font-medium">{section.label}</span>
              {section.trimmed > 0 ? (
                <span className="text-[var(--color-changed)]">
                  {" "}
                  · {section.trimmed} more trimmed to keep the request coherent
                </span>
              ) : null}
            </p>
          ) : (
            <p className="text-[11px] text-[var(--color-ink-faint)]">
              Select a block first — the section is the one it sits in.
            </p>
          )
        ) : null}

        {scope === "page" && visibleBlockIds.length > 120 ? (
          <p className="rounded-md bg-[var(--color-changed-soft)] px-2 py-1.5 text-[11px] text-[var(--color-ink-soft)]">
            {visibleBlockIds.length} blocks is a lot for one request — results get vague.
            Section scope usually works better on a page this size.
          </p>
        ) : null}
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: "copy", label: "Copy only" },
            { value: "layout", label: "Copy + layout" },
          ]}
        />
          </>
        )}

        {addRequest ? null : (
        <Segmented
          value={shape}
          onChange={setShape}
          options={[
            { value: "optimize", label: "Optimize" },
            { value: "directives", label: "Apply my list" },
          ]}
        />
        )}

        {mode === "layout" ? (
          <p className="rounded-md bg-[var(--color-moved-soft)] px-2 py-1.5 text-[11px] text-[var(--color-ink-soft)]">
            Layout mode may add, remove, reorder and restyle elements — not just rewrite text.
          </p>
        ) : null}

        <label className="block">
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">
            Brand voice
          </span>
          <select
            className="field py-1 text-xs"
            value={voiceId}
            onChange={(e) => setVoiceId(e.target.value)}
          >
            <option value={VOICE_NONE}>None — match the page</option>
            {config.brandVoices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.isDefault ? " (default)" : ""}
              </option>
            ))}
            <option value={VOICE_CUSTOM}>Custom…</option>
          </select>
        </label>

        {voiceId === VOICE_CUSTOM ? (
          <textarea
            rows={3}
            className="field resize-y text-xs"
            placeholder="How this should sound, just for this request. Save it in Settings if you want it again."
            value={customVoice}
            onChange={(e) => setCustomVoice(e.target.value)}
          />
        ) : null}

        {config.brandVoices.length === 0 && voiceId !== VOICE_CUSTOM ? (
          <p className="text-[10px] text-[var(--color-ink-faint)]">
            No saved voices —{" "}
            <a href="/settings" className="underline underline-offset-2">
              add one in Settings
            </a>{" "}
            to reuse a house style across pages.
          </p>
        ) : null}

        {/* Above the instructions box, because the picture is the direction on
            a request that has one, and the typed note is the qualifier. */}
        <div>
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">
            Reference image
          </span>

          {reference ? (
            <div className="flex items-start gap-2 rounded-md border border-[var(--color-line)] p-2">
              {/* eslint-disable-next-line @next/next/no-img-element -- a data URL
                  held in memory for one request; next/image wants a real src. */}
              <img
                src={reference.dataUrl}
                alt="The section you want added"
                className="h-14 w-20 shrink-0 rounded border border-[var(--color-line)] object-cover"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11px]">{reference.label}</p>
                <p className="mt-0.5 text-[10px] leading-snug text-[var(--color-ink-faint)]">
                  Sent with this request only. Not saved.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setReference(null)}
                className="shrink-0 rounded px-1 py-0.5 text-[10px] text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-removed)]"
              >
                Remove
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className="w-full rounded-md border border-dashed border-[var(--color-line-strong)] px-2 py-2.5 text-[11px] text-[var(--color-ink-faint)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-ink)]"
            >
              Paste a screenshot (Ctrl+V), or click to choose a file
            </button>
          )}

          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) loadReference(file);
              // Cleared so choosing the same file twice fires onChange again.
              e.target.value = "";
            }}
          />

          {/* Copy mode permits setText and setMeta and nothing else, so a
              request built around adding a section cannot produce one. Said
              here rather than switching automatically, which would quietly
              widen what the model is allowed to do to the page. */}
          {reference && mode === "copy" ? (
            <p className="mt-1.5 rounded-md bg-[var(--color-changed-soft)] px-2 py-1.5 text-[10px] leading-snug text-[var(--color-ink-soft)]">
              Copy only mode can reword what is already there, not add anything.{" "}
              <button
                type="button"
                onClick={() => setMode("layout")}
                className="underline underline-offset-2"
              >
                Switch to Copy + layout
              </button>{" "}
              to add this as a section.
            </p>
          ) : null}
        </div>

        {/* An add request replaces the panel's usual framing rather than sitting
            beside it: the scope toggles, the mode and the shape all describe
            rewriting copy that exists, and none of them apply to writing a
            section that does not. */}
        {addRequest ? (
          <div className="rounded-md border border-[var(--color-accent)] bg-[var(--color-accent-soft)] p-2">
            <div className="mb-1.5 flex items-baseline justify-between gap-2">
              <p className="text-[11px] font-semibold">
                New section after “{addRequest.sectionLabel}”
              </p>
              <button
                type="button"
                onClick={onClearAddRequest}
                className="shrink-0 text-[11px] text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
              >
                Cancel
              </button>
            </div>
            <textarea
              rows={3}
              autoFocus
              className="field resize-y text-xs"
              placeholder={
                "What should it say? For example:\n" +
                "An FAQ answering the three questions we get most.\n" +
                "Something like the testimonials block further up."
              }
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
            <p className="mt-1 text-[10px] leading-snug text-[var(--color-ink-faint)]">
              The markup around it goes with the request, so what comes back uses
              this page&rsquo;s own classes. Apply an option to see it in place —
              trying another replaces it.
            </p>
          </div>
        ) : (
          <textarea
            rows={shape === "directives" ? 5 : 2}
            className="field resize-y text-xs"
            placeholder={
              shape === "directives"
                ? "Change the H1 to lead with speed.\nSwap “buy now” for “check coverage”.\nAdd a bullet about the 2-year warranty."
                : "Optional direction — e.g. more urgency, lead with the warranty"
            }
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
        )}

        <Toggle
          checked={allModels}
          onChange={setAllModels}
          label="Ask all the AIs"
          hint={
            config.models.length > 1
              ? `Puts the request to all ${config.models.length} models instead of one, ${optionCount} options each. Costs ${config.models.length}× and takes as long as the slowest, but different models do not anchor on the same idea the way one model asked for three options does.`
              : "Only one model is configured, so this asks the same one. Add more in Settings."
          }
        />
        <Toggle
          checked={webSearch}
          onChange={setWebSearch}
          label="Let it search the web"
          hint="For competitor and market language only — it is told never to take specs, prices or guarantees from results. Adds cost and latency."
        />

        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-[var(--color-ink-soft)]">
            Options
            <select
              className="field w-auto py-0.5 text-xs"
              value={optionCount}
              onChange={(e) => setOptionCount(Number(e.target.value))}
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            {/* Per model, not in total — worth spelling out, since four models
                at three options each is twelve suggestions to read. */}
            {allModels && config.models.length > 1 ? (
              <span className="text-[var(--color-ink-faint)]">
                each × {config.models.length} = {optionCount * config.models.length}
              </span>
            ) : null}
          </label>
          {pending ? (
            <button
              type="button"
              className="btn ml-auto border-[var(--color-removed)] text-[var(--color-removed)]"
              onClick={stop}
              title="Stop this request. It really stops — the models are told to abandon it."
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary ml-auto"
              disabled={readOnly || (!metaScope && scopeIds.length === 0)}
              onClick={run}
            >
              Suggest
            </button>
          )}
        </div>

        {metaScope ? (
          <p className="text-[11px] text-[var(--color-ink-faint)]">
            Rewrites only the meta title and description — the fields above.
          </p>
        ) : null}

        {error ? (
          <p className="rounded-md bg-[var(--color-removed-soft)] px-2 py-1.5 text-xs text-[var(--color-removed)]">
            {error}
          </p>
        ) : null}

        {/* A model that failed while others answered. Named rather than
            swallowed: a model quietly returning nothing every time looks like
            it is working until someone counts the options. */}
        {modelErrors.map((message) => (
          <p
            key={message}
            className="rounded-md bg-[var(--color-changed-soft)] px-2 py-1.5 text-[11px] text-[var(--color-ink-soft)]"
          >
            {message}
          </p>
        ))}
      </div>

      {options ? (
        <div className="mt-3 space-y-2">
          {/* Only once the stream has ended. Mid-request the list is empty
              because nothing has landed yet, not because nothing will. */}
          {options.length === 0 && !pending ? (
            <p className="text-xs text-[var(--color-ink-faint)]">
              The model returned no usable changes.
            </p>
          ) : null}
          {options.map((option, index) => (
            <article
              key={index}
              className="rounded-md border border-[var(--color-line)] p-2"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 text-xs font-semibold">
                  {option.label}
                  {/* Which model wrote it. Only set when several were asked, so
                      it stays out of the way on an ordinary request. */}
                  {option.model ? (
                    <span className="ml-1.5 font-normal text-[10px] text-[var(--color-ink-faint)]">
                      {option.model.split("/").pop()}
                    </span>
                  ) : null}
                </p>
                <button
                  type="button"
                  className="btn shrink-0 px-2 py-0.5 text-[11px]"
                  disabled={readOnly || option.ops.length === 0}
                  onClick={() => {
                    onApply(option.ops, applied.current);
                    applied.current = option.ops;
                    if (runId) void recordChosenOptionAction(runId, index);
                  }}
                >
                  Apply
                </button>
              </div>
              <p className="mt-1 text-[11px] text-[var(--color-ink-soft)]">
                {option.rationale}
              </p>

              <OptionChanges option={option} describeBlock={describeBlock} />

              <p className="mt-1 text-[10px] text-[var(--color-ink-faint)]">
                {option.ops.length} change{option.ops.length === 1 ? "" : "s"}
                {option.rejected.length
                  ? ` · ${option.rejected.length} discarded (out of scope)`
                  : ""}
              </p>
            </article>
          ))}

          {pending ? (
            <p className="text-[11px] text-[var(--color-ink-faint)]">
              {options.length > 0 ? "Still writing…" : "Thinking…"} {elapsed}s
              {/* A minute of silence and a stalled request look identical
                  without this. Layout work at high reasoning really does take
                  this long; the count is what says so. */}
              {elapsed > 90 ? " — long, but still going" : ""}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Per-block before → after inside an option.
 *
 * A section option touches a dozen blocks, and "12 changes" tells a reviewer
 * nothing about whether the section now reads well. Listing what each block
 * becomes is what makes a whole-section proposal judgeable before applying it.
 */
function OptionChanges({
  option,
  describeBlock,
}: {
  option: SuggestOption;
  describeBlock: (id: string) => { text: string; role: string } | null;
}) {
  const [expanded, setExpanded] = useState(false);

  const rows = option.ops.flatMap((op) => {
    if (op.t === "setText") {
      const before = describeBlock(op.id);
      return [
        {
          key: op.id,
          role: before?.role ?? "block",
          before: before?.text ?? "",
          after: htmlToText(op.html),
        },
      ];
    }
    if (op.t === "setMeta") {
      return (
        [
          ["Meta title", op.title],
          ["Meta description", op.description],
        ] as const
      )
        .filter(([, value]) => typeof value === "string")
        .map(([label, value]) => ({
          key: `meta:${label}`,
          role: label,
          before: "",
          after: String(value),
        }));
    }
    // Structural ops have no simple before/after; the count line covers them.
    return [];
  });

  if (rows.length === 0) return null;

  const shown = expanded ? rows : rows.slice(0, 3);

  return (
    <div className="mt-1.5 space-y-1.5">
      {shown.map((row) => (
        <div key={row.key} className="rounded border border-[var(--color-line)] px-1.5 py-1">
          <p className="text-[9px] font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">
            {row.role}
          </p>
          {row.before ? (
            <p className="text-[10px] leading-snug text-[var(--color-ink-faint)] line-through">
              {row.before.slice(0, 120)}
            </p>
          ) : null}
          <p className="text-[11px] leading-snug">{row.after}</p>
        </div>
      ))}
      {rows.length > 3 ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-[10px] text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
        >
          {expanded ? "Show less" : `Show all ${rows.length}`}
        </button>
      ) : null}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1 hover:bg-[var(--color-sunken)]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-[var(--color-accent)]"
      />
      <span className="min-w-0">
        <span className="block text-[11px] font-medium">{label}</span>
        <span className="block text-[10px] leading-snug text-[var(--color-ink-faint)]">
          {hint}
        </span>
      </span>
    </label>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="flex rounded-lg border border-[var(--color-line-strong)] p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={`flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
            value === option.value
              ? "bg-[var(--color-accent)] text-white"
              : "text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

