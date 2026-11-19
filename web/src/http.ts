/**
 * HTTP helpers shared by the API routes.
 *
 * Deliberately tiny — this Worker has no framework, so the whole surface is:
 * parse JSON, build JSON, and turn failures into a consistent error shape.
 */

/** Error carrying an HTTP status; the router renders it as a JSON body. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string = "bad_request",
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** `404` with a stable body shape. */
export function notFound(what = "resource"): HttpError {
  return new HttpError(404, `${what} not found`, "not_found");
}

/** Serialise `data` as JSON with sensible caching headers for an API. */
export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json; charset=utf-8");
  }
  // API responses are per-identity and must never be cached by intermediaries.
  headers.set("cache-control", "no-store");

  return new Response(JSON.stringify(data), { ...init, headers });
}

/** Error body shape used for every non-2xx API response. */
export function errorBody(error: unknown): { error: { message: string; code: string } } {
  if (error instanceof HttpError) {
    return { error: { message: error.message, code: error.code } };
  }
  const message = error instanceof Error ? error.message : "internal error";
  return { error: { message, code: "internal" } };
}

/**
 * Read and parse a JSON request body.
 *
 * @throws {HttpError} `400` when the body is missing or malformed.
 */
export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  const text = await req.text();
  if (!text.trim()) {
    throw new HttpError(400, "request body is required", "empty_body");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "request body is not valid JSON", "invalid_json");
  }
}

/** Path segments after `/api/`, with the query string already stripped. */
export function segments(url: URL): string[] {
  const path = url.pathname.replace(/^\/api\/?/, "");
  return path.split("/").filter(Boolean).map(decodeURIComponent);
}

/** Read an integer query parameter with bounds checking. */
export function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Trimmed, length-capped string field. */
export function str(value: unknown, field: string, max: number, fallback = ""): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text && fallback === "") {
    throw new HttpError(400, `${field} is required`, "missing_field");
  }
  if (text.length > max) {
    throw new HttpError(400, `${field} must be at most ${max} characters`, "field_too_long");
  }
  return text || fallback;
}

/** Optional variant of {@link str} — absent/blank becomes `null`. */
export function optStr(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  return str(value, field, max) || null;
}

/** UTC timestamp in the format every table stores (`toISOString()`). */
export function now(): string {
  return new Date().toISOString();
}
