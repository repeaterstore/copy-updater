"use client";

import { useState, useTransition } from "react";
import { suggestAction, recordChosenOptionAction } from "@/app/actions/ai";
import type { AiMode } from "@/db/schema";
import type { Op } from "@/lib/ops/types";
import type { SuggestOption } from "@/lib/ai/suggest";
import { htmlToText, type SectionScope } from "@/lib/workspace/derive";

type Scope = "block" | "section" | "page";

export interface AiConfig {
  configured: boolean;
  models: string[];
  defaultModel: string | null;
}

export function AiPanel({
  versionId,
  config,
  selectedBlockId,
  visibleBlockIds,
  section,
  describeBlock,
  onApply,
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
  onApply: (ops: Op[]) => void;
  readOnly: boolean;
}) {
  const [model, setModel] = useState(config.defaultModel ?? config.models[0] ?? "");
  const [mode, setMode] = useState<AiMode>("copy");
  const [shape, setShape] = useState<"optimize" | "directives">("optimize");
  const [scope, setScope] = useState<Scope>("block");
  const [instructions, setInstructions] = useState("");
  const [optionCount, setOptionCount] = useState(3);
  const [webSearch, setWebSearch] = useState(false);
  const [distinctOptions, setDistinctOptions] = useState(false);
  const [options, setOptions] = useState<SuggestOption[] | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

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

  const scopeIds =
    scope === "page"
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

  const run = () => {
    setError(null);
    setOptions(null);
    start(async () => {
      const result = await suggestAction({
        versionId,
        model,
        mode,
        shape,
        instructions: instructions.trim() || null,
        optionCount,
        scopeBlockIds: scopeIds,
        scopeKind: metaScope ? "meta" : scope,
        sectionLabel: scope === "section" ? (section?.label ?? null) : null,
        webSearch,
        distinctOptions,
      });
      if ("error" in result) setError(result.error);
      else {
        setOptions(result.options);
        setRunId(result.runId);
      }
    });
  };

  return (
    <section className="border-t border-[var(--color-line)] pt-3">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">
        AI suggestions
      </p>

      <div className="space-y-2">
        <select
          className="field py-1 text-xs"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        >
          {config.models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>

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
        <Segmented
          value={shape}
          onChange={setShape}
          options={[
            { value: "optimize", label: "Optimize" },
            { value: "directives", label: "Apply my list" },
          ]}
        />

        {mode === "layout" ? (
          <p className="rounded-md bg-[var(--color-moved-soft)] px-2 py-1.5 text-[11px] text-[var(--color-ink-soft)]">
            Layout mode may add, remove, reorder and restyle elements — not just rewrite text.
          </p>
        ) : null}

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

        <Toggle
          checked={distinctOptions}
          onChange={setDistinctOptions}
          label="Genuinely different options"
          hint={`One call per option, each given a different angle. Costs ${optionCount}× but stops the options being rewordings of one idea.`}
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
          </label>
          <button
            type="button"
            className="btn btn-primary ml-auto"
            disabled={pending || readOnly || (!metaScope && scopeIds.length === 0)}
            onClick={run}
          >
            {pending ? "Thinking…" : "Suggest"}
          </button>
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
      </div>

      {options ? (
        <div className="mt-3 space-y-2">
          {options.length === 0 ? (
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
                <p className="text-xs font-semibold">{option.label}</p>
                <button
                  type="button"
                  className="btn shrink-0 px-2 py-0.5 text-[11px]"
                  disabled={readOnly || option.ops.length === 0}
                  onClick={() => {
                    onApply(option.ops);
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
