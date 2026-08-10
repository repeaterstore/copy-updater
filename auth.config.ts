import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";

/**
 * Auth configuration with no database imports, so it can be pulled into
 * `proxy.ts` without dragging the Postgres driver into the request-interception
 * path. User rows are created lazily by `getCurrentUser()` instead of in a
 * callback here.
 */

function allowedDomains(): string[] {
  const raw = process.env.ALLOWED_EMAIL_DOMAINS ?? "waveform.com,rsrf.com";
  return raw
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d !== "");
}

export function isAllowedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const at = email.lastIndexOf("@");
  if (at === -1) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return allowedDomains().includes(domain);
}

export const authConfig = {
  providers: [Google],
  pages: {
    signIn: "/signin",
    error: "/signin",
  },
  session: { strategy: "jwt" },
  callbacks: {
    signIn({ profile }) {
      // Google sets email_verified; an unverified address must not be trusted
      // to prove domain membership.
      if (profile && profile.email_verified === false) return false;
      return isAllowedEmail(profile?.email);
    },
    jwt({ token, profile }) {
      if (profile) {
        token.email = profile.email;
        token.name = profile.name ?? token.name;
        token.picture = (profile.picture as string | undefined) ?? token.picture;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.email = (token.email as string) ?? session.user.email;
        session.user.name = (token.name as string | null) ?? session.user.name;
        session.user.image = (token.picture as string | null) ?? session.user.image;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
