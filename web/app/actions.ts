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
