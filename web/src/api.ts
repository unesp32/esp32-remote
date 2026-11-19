/**
 * The JSON API.
 *
 * Every handler is owner-scoped: `ctx.identity.id` is the `owner_id` passed to
 * the store, so a caller can only ever see their own rows — which today is a
 * formality (identity is anonymous) and tomorrow is the security boundary.
 *
 * Route matching is a hand-rolled segment walk rather than a router
 * dependency: there are ~20 routes and the project ships zero runtime deps.
 */
import type { Identity } from "./auth.js";
import type { Device, HistoryEntry, KvEntry, Store, WifiProfile } from "./db.js";
import {
  HttpError,
  errorBody,
  intParam,
  json,
  notFound,
  now,
  optStr,
  readJson,
  segments,
  str,
} from "./http.js";
import { SCHEMA_VERSION } from "./schema.js";

/** Everything a route handler is allowed to reach for. */
export interface ApiContext {
  req: Request;
  url: URL;
  store: Store;
  identity: Identity;
  /** Name of the active auth strategy, reported by `/api/health`. */
  authName: string;
}

/** Fields a device accepts from the client. */
interface DeviceBody {
  mac?: unknown;
  name?: unknown;
  chip?: unknown;
  firmware?: unknown;
  notes?: unknown;
}

interface WifiBody {
  ssid?: unknown;
  password?: unknown;
  security?: unknown;
  channel?: unknown;
  bssid?: unknown;
  band?: unknown;
  hidden?: unknown;
  deviceId?: unknown;
}

interface HistoryBody {
  deviceId?: unknown;
  direction?: unknown;
  command?: unknown;
  response?: unknown;
  ok?: unknown;
}

/**
 * Dispatch `req` to a route, converting any thrown {@link HttpError} into the
 * standard JSON error envelope.
 */
export async function handleApi(ctx: ApiContext): Promise<Response> {
  const path = segments(ctx.url);
  const method = ctx.req.method.toUpperCase();

  try {
    const response = await route(ctx, method, path);
    // Let the auth module attach its identity cookie to successful replies.
    return response;
  } catch (error) {
    if (error instanceof HttpError) return json(errorBody(error), { status: error.status });
    console.error("api error", error);
    return json(errorBody(error), { status: 500 });
  }
}

async function route(ctx: ApiContext, method: string, path: string[]): Promise<Response> {
  const [head, id, tail] = path;

  if (head === undefined) return health(ctx, method);

  switch (head) {
    case "health":
      return health(ctx, method);

    case "bootstrap":
      return method === "GET" ? bootstrap(ctx) : methodNotAllowed();

    case "devices":
      return devices(ctx, method, id, tail);

    case "wifi-profiles":
      return wifiProfiles(ctx, method, id, tail);

    case "history":
      return history(ctx, method, id);

    case "settings":
      return settings(ctx, method);

    case "data":
      return data(ctx, method, id, tail);

    default:
      throw notFound("endpoint");
  }
}

function methodNotAllowed(): never {
  throw new HttpError(405, "method not allowed", "method_not_allowed");
}

function requireId(id: string | undefined): string {
  if (!id) throw notFound("resource");
  return id;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function health(ctx: ApiContext, method: string): Promise<Response> {
  if (method !== "GET") return methodNotAllowed();
  const stats = await ctx.store.stats(ctx.identity.id);

  return json({
    ok: true,
    service: "esp32-remote",
    auth: ctx.authName,
    anonymous: ctx.identity.anonymous,
    identitySource: ctx.identity.source,
    schemaVersion: SCHEMA_VERSION,
    time: now(),
    stats,
  });
}

/**
 * One round trip that hydrates the whole UI.
 *
 * The site is a single page that always needs the same four collections, so
 * fetching them together avoids a four-request waterfall on load.
 */
async function bootstrap(ctx: ApiContext): Promise<Response> {
  const owner = ctx.identity.id;

  const [devices, wifiProfiles, history, settings, stats] = await Promise.all([
    ctx.store.listDevices(owner),
    ctx.store.listWifiProfiles(owner),
    ctx.store.listHistory(owner, { limit: 200 }),
    ctx.store.getSettings(owner),
    ctx.store.stats(owner),
  ]);

  return json({
    identity: {
      id: owner,
      anonymous: ctx.identity.anonymous,
      source: ctx.identity.source,
    },
    auth: ctx.authName,
    schemaVersion: SCHEMA_VERSION,
    serverTime: now(),
    settings,
    devices,
    wifiProfiles,
    history,
    stats,
  });
}

async function devices(
  ctx: ApiContext,
  method: string,
  id?: string,
  tail?: string,
): Promise<Response> {
  const owner = ctx.identity.id;

  // /api/devices
  if (id === undefined) {
    if (method === "GET") return json({ devices: await ctx.store.listDevices(owner) });
    if (method === "POST") {
      const body = await readJson<DeviceBody>(ctx.req);
      const device = await ctx.store.insertDevice(owner, {
        mac: normalizeMac(str(body.mac, "mac", 32)),
        name: str(body.name, "name", 64, str(body.mac, "mac", 32)),
        chip: optStr(body.chip, "chip", 32),
        firmware: optStr(body.firmware, "firmware", 32),
        notes: optStr(body.notes, "notes", 2000) ?? "",
      });
      return json({ device }, { status: 201 });
    }
    return methodNotAllowed();
  }

  // /api/devices/:id/seen
  if (tail === "seen") {
    if (method !== "POST") return methodNotAllowed();
    const found = await ctx.store.getDevice(owner, requireId(id));
    if (!found) throw notFound("device");
    await ctx.store.touchDevice(owner, found.id);
    return json({ device: await ctx.store.getDevice(owner, found.id) });
  }

  if (tail) throw notFound("endpoint");

  if (method === "GET") {
    const device = await ctx.store.getDevice(owner, id);
    if (!device) throw notFound("device");
    return json({ device });
  }

  if (method === "PUT" || method === "PATCH") {
    const body = await readJson<DeviceBody>(ctx.req);
    const patch: Partial<{ name: string; chip: string | null; firmware: string | null; notes: string }> = {};
    if (body.name !== undefined) patch.name = str(body.name, "name", 64);
    if (body.chip !== undefined) patch.chip = optStr(body.chip, "chip", 32);
    if (body.firmware !== undefined) patch.firmware = optStr(body.firmware, "firmware", 32);
    if (body.notes !== undefined) patch.notes = optStr(body.notes, "notes", 2000) ?? "";

    const device = await ctx.store.updateDevice(owner, id, patch);
    if (!device) throw notFound("device");
    return json({ device });
  }

  if (method === "DELETE") {
    const deleted = await ctx.store.deleteDevice(owner, id);
    if (!deleted) throw notFound("device");
    return json({ deleted: true });
  }

  return methodNotAllowed();
}

async function wifiProfiles(
  ctx: ApiContext,
  method: string,
  id?: string,
  tail?: string,
): Promise<Response> {
  const owner = ctx.identity.id;

  if (id === undefined) {
    const deviceId = ctx.url.searchParams.get("deviceId") ?? undefined;

    if (method === "GET") {
      return json({ wifiProfiles: await ctx.store.listWifiProfiles(owner, deviceId) });
    }

    if (method === "POST") {
      const body = await readJson<WifiBody>(ctx.req);
      const profile = await ctx.store.insertWifiProfile(owner, {
        ssid: str(body.ssid, "ssid", 32),
        password: typeof body.password === "string" ? body.password : "",
        security: optStr(body.security, "security", 32) ?? "unknown",
        channel: numberOrNull(body.channel, "channel"),
        bssid: optStr(body.bssid, "bssid", 24),
        band: optStr(body.band, "band", 8),
        hidden: body.hidden === true,
        deviceId: optStr(body.deviceId, "deviceId", 64),
      });
      return json({ wifiProfile: profile }, { status: 201 });
    }

    return methodNotAllowed();
  }

  // /api/wifi-profiles/:id/used
  if (tail === "used") {
    if (method !== "POST") return methodNotAllowed();
    const found = await ctx.store.getWifiProfile(owner, requireId(id));
    if (!found) throw notFound("wifi profile");
    await ctx.store.markWifiProfileUsed(owner, found.id);
    return json({ wifiProfile: await ctx.store.getWifiProfile(owner, found.id) });
  }

  if (tail) throw notFound("endpoint");

  if (method === "GET") {
    const profile = await ctx.store.getWifiProfile(owner, id);
    if (!profile) throw notFound("wifi profile");
    return json({ wifiProfile: profile });
  }

  if (method === "PUT" || method === "PATCH") {
    const body = await readJson<WifiBody>(ctx.req);
    const patch: Partial<WifiProfile> = {};
    if (body.ssid !== undefined) patch.ssid = str(body.ssid, "ssid", 32);
    if (body.password !== undefined) {
      patch.password = typeof body.password === "string" ? body.password : "";
    }
    if (body.security !== undefined) patch.security = optStr(body.security, "security", 32) ?? "unknown";
    if (body.channel !== undefined) patch.channel = numberOrNull(body.channel, "channel");
    if (body.bssid !== undefined) patch.bssid = optStr(body.bssid, "bssid", 24);
    if (body.band !== undefined) patch.band = optStr(body.band, "band", 8);
    if (body.hidden !== undefined) patch.hidden = body.hidden === true;
    if (body.deviceId !== undefined) patch.deviceId = optStr(body.deviceId, "deviceId", 64);

    const profile = await ctx.store.updateWifiProfile(owner, id, patch);
    if (!profile) throw notFound("wifi profile");
    return json({ wifiProfile: profile });
  }

  if (method === "DELETE") {
    const deleted = await ctx.store.deleteWifiProfile(owner, id);
    if (!deleted) throw notFound("wifi profile");
    return json({ deleted: true });
  }

  return methodNotAllowed();
}

async function history(ctx: ApiContext, method: string, id?: string): Promise<Response> {
  const owner = ctx.identity.id;

  if (method === "GET") {
    const deviceId = ctx.url.searchParams.get("deviceId") ?? undefined;
    const limit = intParam(ctx.url, "limit", 200, 1, 500);
    const entries = await ctx.store.listHistory(owner, { deviceId, limit });
    return json({ history: entries });
  }

  if (method === "POST") {
    if (id) throw notFound("endpoint");
    const body = await readJson<HistoryBody>(ctx.req);

    const direction = body.direction;
    if (direction !== "tx" && direction !== "rx" && direction !== "event") {
      throw new HttpError(400, "direction must be tx, rx or event", "invalid_field");
    }

    const entry = await ctx.store.insertHistory(owner, {
      deviceId: optStr(body.deviceId, "deviceId", 64),
      direction,
      command: str(body.command, "command", 1000),
      response: optStr(body.response, "response", 4000),
      ok: body.ok !== false,
    });
    return json({ historyEntry: entry }, { status: 201 });
  }

  if (method === "DELETE") {
    const deviceId = ctx.url.searchParams.get("deviceId") ?? undefined;
    const deleted = await ctx.store.clearHistory(owner, deviceId);
    return json({ deleted });
  }

  return methodNotAllowed();
}

async function settings(ctx: ApiContext, method: string): Promise<Response> {
  const owner = ctx.identity.id;

  if (method === "GET") {
    return json({ settings: await ctx.store.getSettings(owner) });
  }

  if (method === "PUT" || method === "PATCH") {
    const body = await readJson<Record<string, unknown>>(ctx.req);
    const patch: Record<string, string | null> = {};

    for (const [key, value] of Object.entries(body)) {
      if (!/^[a-z0-9_.:-]{1,64}$/i.test(key)) {
        throw new HttpError(400, `invalid setting key: ${key}`, "invalid_key");
      }
      if (value === null) {
        patch[key] = null;
      } else if (typeof value === "string") {
        if (value.length > 4096) {
          throw new HttpError(400, `${key} must be at most 4096 characters`, "field_too_long");
        }
        patch[key] = value;
      } else {
        // Non-strings are stored as JSON so the client can round-trip objects.
        patch[key] = JSON.stringify(value);
      }
    }

    return json({ settings: await ctx.store.putSettings(owner, patch) });
  }

  return methodNotAllowed();
}

async function data(ctx: ApiContext, method: string, id?: string, tail?: string): Promise<Response> {
  const owner = ctx.identity.id;
  const namespace = ctx.url.searchParams.get("namespace") ?? "default";

  if (!/^[a-z0-9_.:-]{1,64}$/i.test(namespace)) {
    throw new HttpError(400, "invalid namespace", "invalid_namespace");
  }

  // /api/data — collection
  if (id === undefined) {
    if (method === "GET") {
      const prefix = ctx.url.searchParams.get("prefix") ?? undefined;
      return json({ data: await ctx.store.listKv(owner, namespace, prefix) });
    }

    if (method === "PUT") {
      const body = await readJson<{ key?: unknown; value?: unknown }>(ctx.req);
      const key = str(body.key, "key", 256);
      const value =
        typeof body.value === "string" ? body.value : JSON.stringify(body.value ?? null);
      if (value.length > 128 * 1024) {
        throw new HttpError(400, "value must be at most 128KB", "field_too_long");
      }
      const entry = await ctx.store.putKv(owner, namespace, key, value);
      return json({ entry }, { status: 201 });
    }

    return methodNotAllowed();
  }

  // /api/data/:key — single entry (keys may themselves contain slashes)
  const key = id + (tail ? `/${tail}` : "");
  const decodedKey = decodeURIComponent(key);

  if (method === "GET") {
    const [entry] = await ctx.store.listKv(owner, namespace, decodedKey);
    if (!entry || entry.key !== decodedKey) throw notFound("entry");
    return json({ entry });
  }

  if (method === "DELETE") {
    const deleted = await ctx.store.deleteKv(owner, namespace, decodedKey);
    if (!deleted) throw notFound("entry");
    return json({ deleted: true });
  }

  return methodNotAllowed();
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Accept `aa:bb:cc:dd:ee:ff`, `aa-bb-…` or `aabbccddeeff`; store colon form. */
function normalizeMac(raw: string): string {
  const hex = raw.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  if (hex.length !== 12) return raw.toLowerCase();
  return hex.match(/.{2}/g)!.join(":");
}

function numberOrNull(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed)) {
    throw new HttpError(400, `${field} must be a number`, "invalid_field");
  }
  return parsed;
}

/** Re-exported so `index.ts` can build a device-shaped payload without duplication. */
export type { Device, HistoryEntry, KvEntry, WifiProfile };
