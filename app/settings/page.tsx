import Link from "next/link";
import { AppHeader } from "@/components/app-header";
import { AiSettings } from "@/components/ai-settings";
import { BrandVoices } from "@/components/brand-voices";
import { loadSettings, SUGGESTED_MODELS } from "@/lib/ai/openrouter";
import { listBrandVoices } from "@/lib/ai/voices";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await requireUser();
  const settings = await loadSettings();
  const voices = await listBrandVoices();

  return (
    <div className="min-h-screen">
      <AppHeader user={user} />

      <main className="mx-auto max-w-2xl px-6 py-8">
        <Link href="/" className="text-xs text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]">
          ← Pages
        </Link>
        <h1 className="mt-3 text-xl font-semibold tracking-tight">AI</h1>
        <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
          Copy suggestions run through OpenRouter, so one key covers every model.
          Shared by everyone on the team.
        </p>

        <AiSettings
          suggestedModels={SUGGESTED_MODELS}
          values={{
            hasKey: Boolean(settings?.openrouterKeyEncrypted),
            models: settings?.models ?? [],
            fallbackModels: settings?.fallbackModels ?? [],
            reasoningLevel: settings?.reasoningLevel ?? "medium",
          }}
        />

        <BrandVoices
          voices={voices.map((v) => ({
            id: v.id,
            name: v.name,
            body: v.body,
            isDefault: v.isDefault,
          }))}
        />
      </main>
    </div>
  );
}
