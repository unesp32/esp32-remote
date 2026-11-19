/**
 * Request identity, resolved once per request for the whole app.
 *
 * ## Why a proxy
 *
 * The product ships **without authentication** (a deliberate v0 decision), so
 * every caller gets an anonymous workspace id partitioned by `owner_id`.
 * Server components cannot set cookies while rendering, so the id is resolved
 * here instead:
 *
 *   1. prefer `x-esp-identity` (a client that already told us who it is),
 *   2. then the `esp_id` cookie,
 *   3. otherwise mint one and set the cookie on the way out.
 *
 * The resolved id is forwarded downstream as a *request* header, so server
 * components, server actions and the API route handler all read the same value
 * through one function in `src/server.ts`. Swapping in real auth later means
 * changing this file and that function — no page or schema changes.
 */
import { NextResponse, type NextRequest } from "next/server";
import { IDENTITY_COOKIE, IDENTITY_HEADER, IDENTITY_NEW_HEADER, isValidIdentity } from "./src/auth";

export function proxy(request: NextRequest): Response {
  const fromHeader = request.headers.get(IDENTITY_HEADER)?.trim();
  const fromCookie = request.cookies.get(IDENTITY_COOKIE)?.value;

  const existing = isValidIdentity(fromHeader)
    ? fromHeader
    : isValidIdentity(fromCookie)
      ? fromCookie
      : null;

  const resolved = existing ?? crypto.randomUUID();
  const minted = existing === null;

  const headers = new Headers(request.headers);
  headers.set(IDENTITY_HEADER, resolved);
  // Tells downstream "this id has never been recorded" so exactly one layer
  // pays for the `owners` insert.
  if (minted) headers.set(IDENTITY_NEW_HEADER, "1");
  else headers.delete(IDENTITY_NEW_HEADER);

  const response = NextResponse.next({ request: { headers } });

  if (minted) {
    response.cookies.set(IDENTITY_COOKIE, resolved, {
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
      sameSite: "lax",
      // Deliberately not `secure`: that would break plain-HTTP development on
      // localhost. The production zone is HTTPS-only anyway.
      httpOnly: true,
    });
  }

  return response;
}

/**
 * Everything except the build output — `/_next/static` is served straight from
 * Workers Static Assets and never reaches the Worker. `/api/*` is included on
 * purpose: the API answers with the same identity cookie as the pages.
 */
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|manifest\\.webmanifest|sw\\.js|icons).*)"],
};
