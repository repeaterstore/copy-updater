import Link from "next/link";
import { signOut } from "@/auth";
import type { CurrentUser } from "@/lib/session";

export function AppHeader({
  user,
  children,
}: {
  user: CurrentUser;
  children?: React.ReactNode;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-[var(--color-line)] bg-[var(--color-surface)]/85 backdrop-blur">
      {/* min-w-0 + shrink-0 on the controls keeps Settings and Sign out
          reachable when the title and page name run long on a narrow screen. */}
      <div className="flex h-12 items-center gap-3 px-4">
        <Link
          href="/"
          className="shrink-0 text-sm font-semibold tracking-tight whitespace-nowrap"
        >
          Copy Updater
        </Link>

        <div className="min-w-0 flex-1">{children}</div>

        <Link
          href="/design"
          title="Comments tagged @design, across every page"
          className="shrink-0 text-xs text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
        >
          Design
        </Link>

        <Link
          href="/settings"
          className="shrink-0 text-xs text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
        >
          Settings
        </Link>

        <form
          className="shrink-0"
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/signin" });
          }}
        >
          <button
            type="submit"
            title={user.email}
            className="text-xs text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
          >
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
