"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  deleteBrandVoiceAction,
  saveBrandVoiceAction,
  setDefaultBrandVoiceAction,
} from "@/app/actions/voices";
import { ConfirmDeleteButton } from "@/components/confirm-delete-button";

export interface BrandVoiceItem {
  id: string;
  name: string;
  body: string;
  isDefault: boolean;
}

/**
 * Manage the team's brand voices.
 *
 * These are the house style, reusable across pages — kept separate from a
 * page's brief, which is about that page's audience and goal. The default is
 * what the suggest panel preselects, so it should be the one that fits most
 * work rather than the most specialised.
 */
export function BrandVoices({ voices }: { voices: BrandVoiceItem[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | "new" | null>(null);

  return (
    <section className="mt-10">
      <h2 className="text-sm font-semibold">Brand voices</h2>
      <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
        How the company sounds. Picked per request in the suggest panel, where
        the default below is preselected and anyone can override it for a
        one-off.
      </p>

      <div className="mt-3 space-y-2">
        {voices.length === 0 && editing !== "new" ? (
          <div className="panel p-4 text-sm text-[var(--color-ink-faint)]">
            No voices yet. Without one, suggestions match whatever voice the page
            already uses.
          </div>
        ) : null}

        {voices.map((voice) =>
          editing === voice.id ? (
            <VoiceForm
              key={voice.id}
              voice={voice}
              onDone={() => {
                setEditing(null);
                router.refresh();
              }}
            />
          ) : (
            <article key={voice.id} className="panel p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{voice.name}</span>
                {voice.isDefault ? (
                  <span className="chip bg-[var(--color-added-soft)] text-[var(--color-added)]">
                    default
                  </span>
                ) : null}
                <span className="ml-auto flex items-center gap-3">
                  {voice.isDefault ? null : (
                    <MakeDefault id={voice.id} />
                  )}
                  <button
                    type="button"
                    onClick={() => setEditing(voice.id)}
                    className="text-[11px] text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
                  >
                    Edit
                  </button>
                  <ConfirmDeleteButton
                    quiet
                    confirmText={`Delete the "${voice.name}" voice?`}
                    onConfirm={deleteBrandVoiceAction.bind(null, voice.id)}
                  />
                </span>
              </div>
              <p className="mt-1.5 whitespace-pre-wrap text-xs text-[var(--color-ink-soft)]">
                {voice.body}
              </p>
            </article>
          ),
        )}

        {editing === "new" ? (
          <VoiceForm
            voice={null}
            onDone={() => {
              setEditing(null);
              router.refresh();
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing("new")}
            className="btn"
          >
            Add a voice
          </button>
        )}
      </div>
    </section>
  );
}

function MakeDefault({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await setDefaultBrandVoiceAction(id);
          router.refresh();
        })
      }
      className="text-[11px] text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
    >
      {pending ? "Setting…" : "Make default"}
    </button>
  );
}

function VoiceForm({
  voice,
  onDone,
}: {
  voice: BrandVoiceItem | null;
  onDone: () => void;
}) {
  const [name, setName] = useState(voice?.name ?? "");
  const [body, setBody] = useState(voice?.body ?? "");
  const [isDefault, setIsDefault] = useState(voice?.isDefault ?? false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="panel space-y-2 p-4">
      <input
        autoFocus
        className="field text-sm"
        placeholder="Name — e.g. Waveform house voice"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <textarea
        rows={5}
        className="field resize-y text-sm"
        placeholder={
          "Plain and specific. Short sentences. We explain the physics rather " +
          "than making claims, never say “revolutionary”, and we would rather " +
          "sound useful than clever."
        }
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--color-ink-soft)]">
        <input
          type="checkbox"
          checked={isDefault}
          onChange={(e) => setIsDefault(e.target.checked)}
          className="accent-[var(--color-accent)]"
        />
        Use this by default
      </label>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn btn-primary"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const result = await saveBrandVoiceAction({
                id: voice?.id ?? null,
                name,
                body,
                isDefault,
              });
              if (result.error) setError(result.error);
              else onDone();
            })
          }
        >
          {pending ? "Saving…" : "Save voice"}
        </button>
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
        {error ? (
          <span className="text-[11px] text-[var(--color-removed)]">{error}</span>
        ) : null}
      </div>
    </div>
  );
}
