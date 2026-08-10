import Link from "next/link";
import { createPageAction } from "@/app/actions/pages";
import { AppHeader } from "@/components/app-header";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function NewPage() {
  const user = await requireUser();

  return (
    <div className="min-h-screen">
      <AppHeader user={user} />

      <main className="mx-auto max-w-xl px-6 py-10">
        <Link href="/" className="text-xs text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]">
          ← Pages
        </Link>
        <h1 className="mt-3 text-xl font-semibold tracking-tight">Capture a page</h1>
        <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
          Copy Updater loads the page in a real browser and freezes a self-contained copy
          — layout, fonts and images included — to propose changes against.
        </p>

        <form action={createPageAction} className="panel mt-6 space-y-4 p-5">
          <div>
            <label htmlFor="url" className="mb-1 block text-xs font-medium">
              Page URL
            </label>
            <input
              id="url"
              name="url"
              required
              placeholder="https://www.waveform.com/products/..."
              className="field"
            />
          </div>

          <div>
            <label htmlFor="name" className="mb-1 block text-xs font-medium">
              Name <span className="text-[var(--color-ink-faint)]">(optional)</span>
            </label>
            <input id="name" name="name" placeholder="Derived from the URL" className="field" />
          </div>

          <div>
            <label htmlFor="brief" className="mb-1 block text-xs font-medium">
              Brief <span className="text-[var(--color-ink-faint)]">(optional)</span>
            </label>
            <textarea
              id="brief"
              name="brief"
              rows={4}
              placeholder="Brand voice, target keywords, audience. Given to the AI as context on every request."
              className="field resize-y"
            />
          </div>

          <div className="flex items-center justify-between pt-1">
            <p className="text-[11px] text-[var(--color-ink-faint)]">
              Capture usually takes 30–60 seconds.
            </p>
            <button type="submit" className="btn btn-primary">
              Capture
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}
