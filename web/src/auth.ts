/**
 * Identity for API requests.
 *
 * ## Why this file exists
 *
 * The product ships **without authentication** — anyone with the URL can drive
 * any board. That is a deliberate v0 decision, not an oversight. What matters
 * is that the *seams* for real auth already exist:
 *
 *   1. Every request is resolved to an {@link Identity} before any route runs.
 *   2. Every table is partitioned by `owner_id`, which comes from that identity.
 *   3. The {@link AuthModule} interface is the single swap point.
 *
 * Replacing anonymous identity with sessions/OIDC later means implementing one
 * more `AuthModule` and changing a single line in `index.ts` — no route or
 * schema changes.
 *
 * ## The current module
 *
 * {@link createAnonymousAuth} mints a stable opaque id, persisted in an `esp_id`
 * cookie (falling back to the `X-Esp-Identity` header for non-browser
 * clients), and records the owner in the `owners` table on first sight.
 */

/** Cookie/header name carrying the anonymous identity. */
export const IDENTITY_COOKIE = "esp_id";
export const IDENTITY_HEADER = "x-esp-identity";

/** A resolved caller. `anonymous` is `false` once real auth lands. */
export interface Identity {
  /** Stable, opaque, unique per caller. Maps to `owner_id` in every table. */
  id: string;
  /** `true` while we are guessing rather than verifying. */
  anonymous: boolean;
  /** Which mechanism produced the id — useful in logs and debugging. */
  source: "cookie" | "header" | "generated";
}

/** Result of {@link AuthModule.identify}. */
export interface AuthResult {
  identity: Identity;
  /**
   * `true` when this request minted a brand-new identity that should be
   * persisted with {@link AuthModule.remember}.
   */
  minted: boolean;
}

/** Minimum contract any authentication strategy must satisfy. */
export interface AuthModule {
  /** Human-readable strategy name, surfaced by `GET /api/health`. */
  readonly name: string;
  /**
   * Resolve the caller for `req`.
   *
   * Must never throw for an unauthenticated request — return an identity and
   * let routes decide what that identity may do.
   */
  identify(req: Request, ctx: AuthContext): Promise<AuthResult>;
  /**
   * Persist a freshly minted identity onto `res`.
   *
   * Called by the router only when {@link AuthResult.minted} is `true`.
   */
  remember(identity: Identity, res: Response): Response;
}

/** Everything `identify` gets beyond the raw request. */
export interface AuthContext {
  /** Set when the strategy minted a new id; the router checks this. */
  minted?: boolean;
}

/** Owner bookkeeping, satisfied by the D1 wrapper in `db.ts`. */
export interface OwnerStore {
  ensureOwner(id: string, now: string): Promise<void>;
}

/** Opaque id generator — swappable for tests / restricted runtimes. */
export type IdFactory = () => string;

const defaultIdFactory: IdFactory = () => crypto.randomUUID();

/**
 * Build the built-in anonymous strategy.
 *
 * @param store    Persists newly minted owners.
 * @param newId    Injected id generator (defaults to `crypto.randomUUID`).
 */
export function createAnonymousAuth(
  store: OwnerStore,
  newId: IdFactory = defaultIdFactory,
): AuthModule {
  return {
    name: "anonymous",

    async identify(req: Request): Promise<AuthResult> {
      const cookie = readCookie(req.headers.get("cookie"), IDENTITY_COOKIE);
      const header = req.headers.get(IDENTITY_HEADER)?.trim();

      if (cookie) {
        return {
          identity: { id: cookie, anonymous: true, source: "cookie" },
          minted: false,
        };
      }

      if (header && isValidId(header)) {
        return {
          identity: { id: header, anonymous: true, source: "header" },
          minted: false,
        };
      }

      const id = newId();
      await store.ensureOwner(id, new Date().toISOString());
      return {
        identity: { id, anonymous: true, source: "generated" },
        minted: true,
      };
    },

    remember(identity: Identity, res: Response): Response {
      const cookie = [
        `${IDENTITY_COOKIE}=${identity.id}`,
        "Path=/",
        "Max-Age=31536000",
        "SameSite=Lax",
        // Deliberately not `Secure` — that would break plain-HTTP development
        // on localhost. The production zone is HTTPS-only anyway.
        "HttpOnly",
      ].join("; ");

      const headers = new Headers(res.headers);
      headers.append("set-cookie", cookie);

      // Response bodies are single-use; rebuild with the same body so the
      // status line and body survive the header change.
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers,
      });
    },
  };
}

/** The active strategy. Swap this line to change how callers are identified. */
let active: AuthModule | null = null;

/** Install (or replace) the active {@link AuthModule}. */
export function setAuthModule(module: AuthModule): void {
  active = module;
}

/** The active {@link AuthModule}, defaulting to anonymous identity. */
export function getAuthModule(store: OwnerStore): AuthModule {
  active ??= createAnonymousAuth(store);
  return active;
}

/** RFC-6265 `cookie` header parsing — only the one cookie we care about. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return value ? decodeURIComponent(value) : null;
  }
  return null;
}

/** Ids we accept from a client are UUIDs — anything else is treated as absent. */
function isValidId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}
