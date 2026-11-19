/**
 * `/api/*` — the JSON API, unchanged in shape from the hand-written Worker.
 *
 * vinext routes `app/api/**` here, so this file is the replacement for the old
 * `src/index.ts` dispatch: same method gate, same router, same error envelope.
 * The only thing that moved is *identity* — `middleware.ts` has already
 * resolved the caller and injected it into these request headers, so there is
 * no cookie minting or schema probing left to do in the request path.
 *
 * Keeping the API as a real route (rather than folding it into server
 * actions) preserves the public contract `scripts/smoke_api.py` verifies on
 * every deploy.
 */
import { handleApi } from "../../../src/api.js";
import { getAuthModule } from "../../../src/auth.js";
import { getRequestContext } from "../../../src/server.js";

/** Methods the API answers to; anything else on `/api/*` is a 405. */
const API_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

async function dispatch(req: Request): Promise<Response> {
  const method = req.method.toUpperCase();

  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { allow: "GET, POST, PUT, PATCH, DELETE" },
    });
  }

  if (!API_METHODS.has(method)) {
    return jsonResponse(
      { error: { message: "method not allowed", code: "method_not_allowed" } },
      405,
    );
  }

  const { store, identity } = await getRequestContext();

  return handleApi({
    req,
    url: new URL(req.url),
    store,
    identity,
    authName: getAuthModule(store).name,
  });
}

function jsonResponse(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export const GET = dispatch;
export const POST = dispatch;
export const PUT = dispatch;
export const PATCH = dispatch;
export const DELETE = dispatch;
export const OPTIONS = dispatch;
// Deliberately no `HEAD`: vinext derives it from `GET`, and `api.ts` decides
// per route whether HEAD is allowed (it is not, for `/health`) — the same
// behaviour the hand-written Worker had.
