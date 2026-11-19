/**
 * Server actions — the write path for every form and live device event in the UI.
 *
 * ## Why these delegate to `handleApi`
 *
 * `/api/*` is the site's public contract: it owns validation, MAC
 * normalisation, field limits and the JSON error envelope, and
 * `scripts/smoke_api.py` verifies all of it on every deploy. Re-implementing
 * that per form would let the UI and the API drift apart — so an action is a
 * *transport* over the same router, not a second implementation of it.
 *
 * Reads are deliberately **not** here: server components query D1 directly
 * through `getRequestContext()` in `src/server.ts`.
 *
 * Every file-level export must be an async function — that is a hard
 * requirement of `"use server"` — so shared types live in `src/db.ts`.
 */
"use server";

import { revalidatePath } from "next/cache";
import { handleApi } from "../src/api.js";
import type { Device, HistoryEntry, HistoryInput, WifiProfile } from "../src/db.js";
import { getRequestContext } from "../src/server.js";

/** JSON body shapes accepted by the API. Mirrors the `*Body` types in `api.ts`. */
export interface DevicePayload {
  mac: string;
  name: string;
  chip?: string | null;
  firmware?: string | null;
  notes?: string;
}

export interface WifiProfilePayload {
  ssid: string;
  password?: string;
  security?: string;
  channel?: string | null;
  band?: string | null;
  hidden?: boolean;
}

/** Every response body the API returns, as parsed JSON. */
type ApiBody = Record<string, unknown>;

/**
 * Run one API request in-process and return its parsed body.
 *
 * The synthetic `Request` never touches the network: `handleApi` only reads
 * the method, the URL path and the JSON body.
 */
async function call(method: string, path: string, body?: unknown): Promise<ApiBody> {
  const { store, identity } = await getRequestContext();

  const url = new URL(path, "https://esp.virt.cc.cd");
  const request = new Request(url, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });

  const response = await handleApi({
    req: request,
    url,
    store,
    identity,
    authName: "anonymous",
  });

  const text = await response.text();
  const payload: ApiBody = text ? (JSON.parse(text) as ApiBody) : {};

  if (!response.ok) {
    const error = payload.error as { message?: string } | undefined;
    throw new Error(error?.message ?? `Request failed (${response.status}).`);
  }
  return payload;
}

/** Pages read from D1, so every write invalidates them. */
function refreshAll(): void {
  revalidatePath("/", "layout");
}

/* ------------------------------------------------------------------ devices */

/** Insert or update a device — the API upserts on `(owner, mac)`. */
export async function saveDevice(input: DevicePayload): Promise<Device> {
  const body = await call("POST", "/api/devices", input);
  refreshAll();
  return body.device as Device;
}

export async function deleteDevice(id: string): Promise<void> {
  await call("DELETE", `/api/devices/${encodeURIComponent(id)}`);
  refreshAll();
}

/* -------------------------------------------------------------- wifi profiles */

export async function saveWifiProfile(
  input: WifiProfilePayload,
  id?: string,
): Promise<WifiProfile> {
  const path = id ? `/api/wifi-profiles/${encodeURIComponent(id)}` : "/api/wifi-profiles";
  const body = await call(id ? "PUT" : "POST", path, input);
  refreshAll();
  return body.wifiProfile as WifiProfile;
}

export async function deleteWifiProfile(id: string): Promise<void> {
  await call("DELETE", `/api/wifi-profiles/${encodeURIComponent(id)}`);
  refreshAll();
}

/** Bump the use counter after the board actually joined a network. */
export async function markWifiProfileUsed(id: string): Promise<void> {
  await call("POST", `/api/wifi-profiles/${encodeURIComponent(id)}/used`);
  refreshAll();
}

/* ------------------------------------------------------------------- history */

/**
 * Append one control-history row.
 *
 * Called from the Bluetooth client after every command, so history survives
 * reloads even though the radio link does not.
 */
export async function recordHistory(entry: HistoryInput): Promise<HistoryEntry> {
  const body = await call("POST", "/api/history", entry);
  return body.historyEntry as HistoryEntry;
}

export async function clearHistory(deviceId?: string): Promise<number> {
  const query = deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : "";
  const body = await call("DELETE", `/api/history${query}`);
  refreshAll();
  return Number(body.deleted ?? 0);
}

/* ------------------------------------------------------------------ settings */

/** Merge a settings patch; `null` deletes a key (handled by the API). */
export async function updateSettings(
  patch: Record<string, string | null>,
): Promise<Record<string, string>> {
  const body = await call("PUT", "/api/settings", patch);
  refreshAll();
  return (body.settings as Record<string, string>) ?? {};
}

/* ------------------------------------------------------------- kv + workspace */

export async function putKv(key: string, value: string, namespace = "ui"): Promise<void> {
  await call("PUT", "/api/data", { namespace, key, value });
  refreshAll();
}

/**
 * Erase everything this workspace remembers: history, devices, saved networks
 * and settings. Uses the store directly because it is a bulk delete with no
 * input to validate.
 */
export async function resetWorkspace(): Promise<void> {
  const { store, identity } = await getRequestContext();
  const owner = identity.id;

  await store.clearHistory(owner);
  for (const device of await store.listDevices(owner)) {
    await store.deleteDevice(owner, device.id);
  }
  for (const profile of await store.listWifiProfiles(owner)) {
    await store.deleteWifiProfile(owner, profile.id);
  }

  const settings = await store.getSettings(owner);
  if (Object.keys(settings).length) {
    await store.putSettings(
      owner,
      Object.fromEntries(Object.keys(settings).map((key) => [key, null])),
    );
  }

  refreshAll();
}

/* ------------------------------------------------------------- network tools */

export interface DnsAnswer {
  name: string;
  type: number;
  TTL: number;
  data: string;
}

export interface DnsLookupResult {
  status: number;
  statusName: string;
  domain: string;
  type: string;
  elapsedMs: number;
  resolver: string;
  answers: DnsAnswer[];
  raw: any;
}

export async function performDnsLookup(domain: string, type = "A"): Promise<DnsLookupResult> {
  const cleanDomain = domain.trim().replace(/^https?:\/\//, "").split("/")[0] ?? "virt.cc.cd";
  const start = Date.now();
  const res = await fetch(
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(cleanDomain)}&type=${encodeURIComponent(type)}`,
    {
      headers: { Accept: "application/dns-json" },
      cache: "no-store",
    },
  );
  const elapsedMs = Date.now() - start;
  const data = (await res.json()) as any;

  const STATUS_MAP: Record<number, string> = {
    0: "NOERROR",
    1: "FORMERR",
    2: "SERVFAIL",
    3: "NXDOMAIN",
    4: "NOTIMP",
    5: "REFUSED",
  };

  return {
    status: data.Status ?? 0,
    statusName: STATUS_MAP[data.Status] || `STATUS_${data.Status}`,
    domain: cleanDomain,
    type,
    elapsedMs,
    resolver: "1.1.1.1 (Cloudflare DoH)",
    answers: (data.Answer as DnsAnswer[]) || [],
    raw: data,
  };
}

export interface IpLookupResult {
  ip: string;
  type: string;
  asn?: string;
  org?: string;
  isp?: string;
  country?: string;
  countryCode?: string;
  city?: string;
  region?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  elapsedMs: number;
}

export async function performIpLookup(query: string): Promise<IpLookupResult> {
  const cleanQuery = (query.trim().replace(/^https?:\/\//, "").split("/")[0] ?? "").split(":")[0] ?? "1.1.1.1";
  const start = Date.now();
  const res = await fetch(`https://ipwhois.app/json/${encodeURIComponent(cleanQuery)}`, {
    cache: "no-store",
  });
  const elapsedMs = Date.now() - start;
  const data = (await res.json()) as any;

  return {
    ip: data.ip || cleanQuery,
    type: data.type || "IPv4",
    asn: data.asn || "—",
    org: data.org || "—",
    isp: data.isp || "—",
    country: data.country || "—",
    countryCode: data.country_code || "—",
    city: data.city || "—",
    region: data.region || "—",
    latitude: data.latitude,
    longitude: data.longitude,
    timezone: data.timezone || "—",
    elapsedMs,
  };
}

export interface HttpCheckResult {
  url: string;
  status: number;
  statusText: string;
  elapsedMs: number;
  headers: Record<string, string>;
  protocol: string;
  bodyPreview: string;
  contentLength?: number;
}

export async function performHttpCheck(targetUrl: string, method = "GET"): Promise<HttpCheckResult> {
  let url = targetUrl.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }

  const start = Date.now();
  const res = await fetch(url, {
    method: method.toUpperCase(),
    headers: {
      "User-Agent": "ESP32-Remote-Prober/1.0 (+https://esp.virt.cc.cd)",
    },
    redirect: "follow",
    cache: "no-store",
  });
  const elapsedMs = Date.now() - start;

  const headers: Record<string, string> = {};
  res.headers.forEach((val, key) => {
    headers[key] = val;
  });

  const text = await res.text();
  const preview = text.slice(0, 1500);

  return {
    url,
    status: res.status,
    statusText: res.statusText || (res.status === 200 ? "OK" : ""),
    elapsedMs,
    headers,
    protocol: res.url.startsWith("https") ? "HTTPS (TLS)" : "HTTP",
    bodyPreview: preview,
    contentLength: text.length,
  };
}

export interface EdgeStorageStats {
  devicesCount: number;
  profilesCount: number;
  historyCount: number;
  settingsCount: number;
  database: string;
  schemaVersion: number;
  ownerId: string;
}

export async function getEdgeStorageStats(): Promise<EdgeStorageStats> {
  const { store, identity } = await getRequestContext();
  const stats = await store.stats(identity.id);
  return {
    devicesCount: stats.devices,
    profilesCount: stats.wifiProfiles,
    historyCount: stats.historyEntries,
    settingsCount: stats.settings,
    database: "esp32-remote (Cloudflare D1 SQLite)",
    schemaVersion: 1,
    ownerId: identity.id,
  };
}
