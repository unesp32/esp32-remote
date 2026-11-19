/**
 * Cloudflare Worker entry point.
 *
 * Responsibilities, in order:
 *   1. Resolve the caller's {@link Identity} (`auth.ts`).
 *   2. Make sure the D1 schema exists (once per isolate).
 *   3. Hand `/api/*` to the router in `api.ts`.
 *   4. Delegate everything else to the static asset bundle.
 *
 * The identity cookie is attached here — after the route has produced its
 * response — so route handlers never need to know about it.
 */
import { handleApi } from "./api.js";
import { getAuthModule, type AuthResult } from "./auth.js";
import { createStore } from "./db.js";
import { ensureSchema } from "./schema.js";

/**
 * Schema bootstrap is cached per isolate.
 *
 * `ensureSchema` already short-circuits when the schema exists, but caching
 * removes that probe from the steady-state request path entirely. A failure
 * clears the cache so the next request retries.
 */
let schemaReady: Promise<void> | null = null;

function ensureSchemaOnce(db: D1Database): Promise<void> {
  schemaReady ??= ensureSchema(db).catch((error: unknown) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

/** Methods the API answers to; anything else on `/api/*` is a 405. */
const API_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

const handler = {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // Static assets are routed to this Worker only when they miss, or when a
    // non-API path somehow gets here — serve them rather than 404ing.
    if (!url.pathname.startsWith("/api")) {
      return serveAsset(req, env);
    }

    const method = req.method.toUpperCase();
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { allow: "GET, POST, PUT, PATCH, DELETE" },
      });
    }
    if (!API_METHODS.has(method)) {
      return jsonResponse({ error: { message: "method not allowed", code: "method_not_allowed" } }, 405);
    }

    const store = createStore(env.DB);
    const auth = getAuthModule(store);

    let result: AuthResult;
    try {
      await ensureSchemaOnce(env.DB);
      result = await auth.identify(req, {});
    } catch (error) {
      // Full detail goes to logs only — never to the client.
      console.error("identity resolution failed", error);
      return jsonResponse({ error: { message: "identity unavailable", code: "identity" } }, 503);
    }

    const res = await handleApi({
      req,
      url,
      store,
      identity: result.identity,
      authName: auth.name,
    });

    // Persist a freshly minted identity so the next request is recognised.
    return result.minted ? auth.remember(result.identity, res) : res;
  },
} satisfies ExportedHandler<Env>;

/** Serve the Vite-built static bundle; fall back to the SPA shell. */
async function serveAsset(req: Request, env: Env): Promise<Response> {
  const assets = (env as Env & { ASSETS?: { fetch(req: Request): Promise<Response> } }).ASSETS;
  if (!assets) {
    return jsonResponse({ error: { message: "not found", code: "not_found" } }, 404);
  }

  const res = await assets.fetch(req);
  // Unknown non-API paths get the SPA shell so deep links keep working.
  if (res.status === 404 && new URL(req.url).pathname !== "/") {
    const shell = await assets.fetch(new Request(new URL("/", req.url)));
    if (shell.ok) return shell;
  }
  return res;
}

function jsonResponse(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export default handler;
