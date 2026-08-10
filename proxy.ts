import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authConfig } from "./auth.config";

// Next 16 renamed `middleware` to `proxy`. This instance is built from the
// DB-free config so request interception stays lightweight.
const { auth } = NextAuth(authConfig);

const PUBLIC_PREFIXES = ["/signin", "/api/auth", "/api/health"];

export default auth((request: NextRequest & { auth: unknown }) => {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }

  if (request.auth) return NextResponse.next();

  // API routes get a 401 they can act on; pages get sent to sign-in.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const signInUrl = new URL("/signin", request.nextUrl.origin);
  signInUrl.searchParams.set("callbackUrl", pathname + request.nextUrl.search);
  return NextResponse.redirect(signInUrl);
});

export const config = {
  // Everything except Next's own assets. Snapshot HTML is served from /api and
  // is deliberately covered.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
