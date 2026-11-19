/**
 * Server-side request context: who is calling, and the D1 store scoped to them.
 *
 * Every server component, server action and route handler goes through
 * {@link getRequestContext}. It is the only place that knows about the
 * identity headers injected by `middleware.ts`, the per-isolate schema
 * bootstrap, and the owner-scoped {@link Store}.
 */
import { env } from "cloudflare:workers";
import { headers } from "next/headers";
import {
  IDENTITY_HEADER,
  IDENTITY_NEW_HEADER,
  isValidIdentity,
  type Identity,
} from "./auth.js";
import { createStore, type Store } from "./db.js";
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

/** A caller resolved to a stable anonymous workspace. */
export interface Caller {
  identity: Identity;
  /** `true` when this request minted the id, so the owner row is missing. */
  minted: boolean;
}

/**
 * Read the identity `middleware.ts` injected into the request headers.
 *
 * Falls back to a fresh id when middleware did not run (a direct module call
 * in a test, say) — never to another caller's id.
 */
async function resolveCaller(): Promise<Caller> {
  const h = await headers();
  const raw = h.get(IDENTITY_HEADER)?.trim();
  const minted = h.get(IDENTITY_NEW_HEADER) === "1";
  const source = minted ? "generated" : "cookie";

  const identity: Identity = isValidIdentity(raw)
    ? { id: raw, anonymous: true, source }
    : { id: crypto.randomUUID(), anonymous: true, source: "generated" };

  return { identity, minted };
}

/** Everything a request needs to read or write per-owner data. */
export interface RequestContext {
  store: Store;
  identity: Identity;
}

/**
 * Resolve the caller and hand back a store scoped to them.
 *
 * `authName` is deliberately not here: the anonymous strategy is a property of
 * `auth.ts`, and hard-coding it in pages would make the future auth swap
 * silently inconsistent.
 */
export async function getRequestContext(): Promise<RequestContext> {
  const db = env.DB;
  await ensureSchemaOnce(db);

  const { identity, minted } = await resolveCaller();
  const store = createStore(db);

  // Only the request that minted the id pays for the `owners` insert; every
  // later request carries a cookie and skips it.
  if (minted) await store.ensureOwner(identity.id);

  return { store, identity };
}
