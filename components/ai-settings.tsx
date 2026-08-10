"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { clearApiKeyAction, saveSettingsAction } from "@/app/actions/ai";
import type { ReasoningLevel } from "@/db/schema";

export interface AiSettingsValues {
  hasKey: boolean;
  models: string[];
  fallbackModels: string[];
  reasoningLevel: ReasoningLevel;
}

const REASONING_HELP: Record<ReasoningLevel, string> = {
  low: "Cheapest and fastest. Fine for tightening a single line.",
  medium: "Default. Good balance for most copy work.",
  high: "Slowest and priciest. Best for restructuring and long instruction lists.",
};

export function AiSettings({
  values,
  suggestedModels,
}: {
  values: AiSettingsValues;
  suggestedModels: string[];
}) {
  const router = useRouter();
  const [reasoning, setReasoning] = useState<ReasoningLevel>(values.reasoningLevel);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();

  return (
    <form
      className="panel mt-6 space-y-5 p-5"
      action={(formData) =>
        start(async () => {
          setError(null);
          setSaved(false);
          const result = await saveSettingsAction(formData);
          if (result.error) setError(result.error);
          else {
            setSaved(true);
            router.refresh();
          }
        })
      }
    >
      <div>
        <label className="mb-1 block text-xs font-medium">
          OpenRouter API key
          {values.hasKey ? (
            <span className="ml-2 font-normal text-[var(--color-added)]">saved</span>
          ) : null}
        </label>
        <input
          name="apiKey"
          type="password"
          autoComplete="off"
          placeholder={values.hasKey ? "Leave blank to keep the saved key" : "sk-or-v1-…"}
          className="field font-mono text-xs"
        />
        <p className="mt-1 text-[11px] text-[var(--color-ink-faint)]">
          From{" "}
          <a
            href="https://openrouter.ai/keys"
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2"
          >
            openrouter.ai/keys
          </a>
          . Encrypted before storage and never sent to the browser.
        </p>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium">
          Models{" "}
          <span className="text-[var(--color-ink-faint)]">
            (one per line, in the form vendor/model)
          </span>
        </label>
        <textarea
          name="models"
          rows={4}
          required
          defaultValue={(values.models.length ? values.models : suggestedModels).join("\n")}
          className="field resize-y font-mono text-xs"
        />
        <p className="mt-1 text-[11px] text-[var(--color-ink-faint)]">
          Offered in the suggest panel. The first is the default. Models must support
          structured output — requests are routed only to providers that do.
        </p>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium">
          Fallback models{" "}
          <span className="text-[var(--color-ink-faint)]">(optional)</span>
        </label>
        <textarea
          name="fallbackModels"
          rows={2}
          defaultValue={values.fallbackModels.join("\n")}
          placeholder="anthropic/claude-sonnet-4.5"
          className="field resize-y font-mono text-xs"
        />
        <p className="mt-1 text-[11px] text-[var(--color-ink-faint)]">
          Tried in order if the chosen model is unavailable, so one flaky provider
          doesn&rsquo;t fail a request.
        </p>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium">Reasoning effort</label>
        <div className="flex rounded-lg border border-[var(--color-line-strong)] p-0.5">
          {(["low", "medium", "high"] as ReasoningLevel[]).map((level) => (
            <button
              key={level}
              type="button"
              onClick={() => setReasoning(level)}
              className={`flex-1 rounded-md px-2 py-1 text-xs font-medium capitalize transition-colors ${
                reasoning === level
                  ? "bg-[var(--color-accent)] text-white"
                  : "text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
              }`}
            >
              {level}
            </button>
          ))}
        </div>
        <input type="hidden" name="reasoningLevel" value={reasoning} />
        <p className="mt-1 text-[11px] text-[var(--color-ink-faint)]">
          {REASONING_HELP[reasoning]} Layout and directive requests are raised a step
          automatically, since those have more to work out.
        </p>
      </div>

      {error ? (
        <p className="rounded-md bg-[var(--color-removed-soft)] px-3 py-2 text-xs text-[var(--color-removed)]">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="rounded-md bg-[var(--color-added-soft)] px-3 py-2 text-xs text-[var(--color-added)]">
          Settings saved.
        </p>
      ) : null}

      <div className="flex items-center justify-between">
        {values.hasKey ? (
          <button
            type="button"
            className="text-[11px] text-[var(--color-ink-soft)] hover:text-[var(--color-removed)]"
            onClick={() =>
              start(async () => {
                await clearApiKeyAction();
                router.refresh();
              })
            }
          >
            Remove stored key
          </button>
        ) : (
          <span className="text-[11px] text-[var(--color-ink-faint)]">
            Saving verifies the key with OpenRouter.
          </span>
        )}
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Saving…" : "Save settings"}
        </button>
      </div>
    </form>
  );
}
