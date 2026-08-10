import { redirect } from "next/navigation";
import { signIn } from "@/auth";
import { getCurrentUser } from "@/lib/session";

const ERROR_COPY: Record<string, string> = {
  AccessDenied:
    "That account isn't on an allowed domain. Sign in with your waveform.com or rsrf.com address.",
  Configuration:
    "Google sign-in isn't configured yet. Check AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET.",
  Verification: "That sign-in link has expired. Try again.",
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
}) {
  const { callbackUrl, error } = await searchParams;

  const user = await getCurrentUser();
  if (user) redirect(callbackUrl ?? "/");

  return (
    <main className="grid min-h-screen place-items-center p-6">
      <div className="panel w-full max-w-sm p-8">
        <h1 className="text-lg font-semibold tracking-tight">Copy Updater</h1>
        <p className="mt-1.5 text-sm text-[var(--color-ink-soft)]">
          Propose and review page copy against a real snapshot.
        </p>

        {error ? (
          <p className="mt-5 rounded-lg border border-[var(--color-removed)] bg-[var(--color-removed-soft)] px-3 py-2 text-sm">
            {ERROR_COPY[error] ?? "Sign-in failed. Try again."}
          </p>
        ) : null}

        <form
          className="mt-6"
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: callbackUrl ?? "/" });
          }}
        >
          <button type="submit" className="btn btn-primary w-full justify-center py-2">
            Continue with Google
          </button>
        </form>

        <p className="mt-4 text-xs text-[var(--color-ink-faint)]">
          Restricted to waveform.com and rsrf.com accounts.
        </p>
      </div>
    </main>
  );
}
