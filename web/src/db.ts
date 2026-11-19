/**
 * Data access layer.
 *
 * All SQL lives here so the routes in `api.ts` stay declarative, and so the
 * `owner_id` scoping rule is enforced in one place instead of being repeated
 * (and forgotten) per handler.
 *
 * Every method takes an explicit `owner` — nothing here will ever read or
 * write a row that belongs to someone else.
 */
import type { OwnerStore } from "./auth.js";
import { now } from "./http.js";

// ---------------------------------------------------------------------------
// Row shapes (snake_case, straight from D1)
// ---------------------------------------------------------------------------

export interface DeviceRow {
  id: string;
  owner_id: string;
  mac: string;
  name: string;
  chip: string | null;
  firmware: string | null;
  notes: string;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WifiProfileRow {
  id: string;
  owner_id: string;
  device_id: string | null;
  ssid: string;
  password: string;
  security: string;
  channel: number | null;
  bssid: string | null;
  band: string | null;
  hidden: number;
  use_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface HistoryRow {
  id: number;
  owner_id: string;
  device_id: string | null;
  direction: "tx" | "rx" | "event";
  command: string;
  response: string | null;
  ok: number;
  created_at: string;
}

export interface KvRow {
  owner_id: string;
  namespace: string;
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// API shapes (camelCase, ready to serialise)
// ---------------------------------------------------------------------------

export interface Device {
  id: string;
  mac: string;
  name: string;
  chip: string | null;
  firmware: string | null;
  notes: string;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WifiProfile {
  id: string;
  deviceId: string | null;
  ssid: string;
  /** Stored in plaintext in v0 — see the "Security notes" section of the README. */
  password: string;
  security: string;
  channel: number | null;
  bssid: string | null;
  band: string | null;
  hidden: boolean;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HistoryEntry {
  id: number;
  deviceId: string | null;
  direction: "tx" | "rx" | "event";
  command: string;
  response: string | null;
  ok: boolean;
  createdAt: string;
}

export interface KvEntry {
  namespace: string;
  key: string;
  value: string;
  createdAt: string;
  updatedAt: string;
}

export interface Stats {
  devices: number;
  wifiProfiles: number;
  historyEntries: number;
  settings: number;
}

export interface DeviceInput {
  mac: string;
  name: string;
  chip?: string | null;
  firmware?: string | null;
  notes?: string;
}

export interface WifiProfileInput {
  ssid: string;
  password: string;
  security?: string;
  channel?: number | null;
  bssid?: string | null;
  band?: string | null;
  hidden?: boolean;
  deviceId?: string | null;
}

export interface HistoryInput {
  deviceId?: string | null;
  direction: "tx" | "rx" | "event";
  command: string;
  response?: string | null;
  ok?: boolean;
}

export interface HistoryFilter {
  deviceId?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

export const toDevice = (row: DeviceRow): Device => ({
  id: row.id,
  mac: row.mac,
  name: row.name,
  chip: row.chip,
  firmware: row.firmware,
  notes: row.notes,
  lastSeenAt: row.last_seen_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const toWifiProfile = (row: WifiProfileRow): WifiProfile => ({
  id: row.id,
  deviceId: row.device_id,
  ssid: row.ssid,
  password: row.password,
  security: row.security,
  channel: row.channel,
  bssid: row.bssid,
  band: row.band,
  hidden: row.hidden === 1,
  useCount: row.use_count,
  lastUsedAt: row.last_used_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const toHistoryEntry = (row: HistoryRow): HistoryEntry => ({
  id: row.id,
  deviceId: row.device_id,
  direction: row.direction,
  command: row.command,
  response: row.response,
  ok: row.ok === 1,
  createdAt: row.created_at,
});

export const toKvEntry = (row: KvRow): KvEntry => ({
  namespace: row.namespace,
  key: row.key,
  value: row.value,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Identity bookkeeping required by `auth.ts`, plus every owner-scoped query. */
export interface Store extends OwnerStore {
  readonly db: D1Database;
  ensureOwner(owner: string, timestamp?: string): Promise<void>;

  listDevices(owner: string): Promise<Device[]>;
  getDevice(owner: string, id: string): Promise<Device | null>;
  insertDevice(owner: string, input: DeviceInput): Promise<Device>;
  updateDevice(owner: string, id: string, patch: Partial<DeviceInput>): Promise<Device | null>;
  touchDevice(owner: string, id: string, timestamp?: string): Promise<void>;
  deleteDevice(owner: string, id: string): Promise<boolean>;

  listWifiProfiles(owner: string, deviceId?: string): Promise<WifiProfile[]>;
  getWifiProfile(owner: string, id: string): Promise<WifiProfile | null>;
  insertWifiProfile(owner: string, input: WifiProfileInput): Promise<WifiProfile>;
  updateWifiProfile(
    owner: string,
    id: string,
    patch: Partial<WifiProfileInput>,
  ): Promise<WifiProfile | null>;
  markWifiProfileUsed(owner: string, id: string): Promise<void>;
  deleteWifiProfile(owner: string, id: string): Promise<boolean>;

  listHistory(owner: string, filter?: HistoryFilter): Promise<HistoryEntry[]>;
  insertHistory(owner: string, input: HistoryInput): Promise<HistoryEntry>;
  clearHistory(owner: string, deviceId?: string): Promise<number>;

  getSettings(owner: string): Promise<Record<string, string>>;
  putSettings(owner: string, patch: Record<string, string | null>): Promise<Record<string, string>>;

  listKv(owner: string, namespace?: string, prefix?: string): Promise<KvEntry[]>;
  putKv(owner: string, namespace: string, key: string, value: string): Promise<KvEntry>;
  deleteKv(owner: string, namespace: string, key: string): Promise<boolean>;

  stats(owner: string): Promise<Stats>;
}

/** Owner row used by every table's `owner_id` foreign key-ish column. */
export const SYSTEM_OWNER = "__system__";

/** Bound how many history rows a single owner may accumulate. */
const HISTORY_KEEP = 2000;

/**
 * Wrap a D1 binding with the owner-scoped operations the API needs.
 *
 * Returns a plain object of closures rather than a class so the `db` handle
 * is captured once and cannot be swapped out later.
 */
export function createStore(db: D1Database): Store {
  const stmt = (sql: string) => db.prepare(sql);

  const pruneHistory = async (owner: string): Promise<void> => {
    await stmt(
      `DELETE FROM history
        WHERE owner_id = ?
          AND id NOT IN (
            SELECT id FROM history WHERE owner_id = ? ORDER BY id DESC LIMIT ?
          )`,
    )
      .bind(owner, owner, HISTORY_KEEP)
      .run();
  };

  return {
    db,

    async ensureOwner(owner: string, timestamp = now()): Promise<void> {
      await stmt(
        "INSERT INTO owners (id, label, created_at) VALUES (?, NULL, ?) ON CONFLICT (id) DO NOTHING",
      )
        .bind(owner, timestamp)
        .run();
    },

    // --- devices ----------------------------------------------------------

    async listDevices(owner) {
      const res = await stmt(
        "SELECT * FROM devices WHERE owner_id = ? ORDER BY updated_at DESC",
      )
        .bind(owner)
        .all<DeviceRow>();
      return res.results.map(toDevice);
    },

    async getDevice(owner, id) {
      const row = await stmt("SELECT * FROM devices WHERE owner_id = ? AND id = ?")
        .bind(owner, id)
        .first<DeviceRow>();
      return row ? toDevice(row) : null;
    },

    async insertDevice(owner, input) {
      const timestamp = now();
      const row = await stmt(
        `INSERT INTO devices (id, owner_id, mac, name, chip, firmware, notes, last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (owner_id, mac) DO UPDATE SET
           name       = excluded.name,
           chip       = COALESCE(excluded.chip, devices.chip),
           firmware   = COALESCE(excluded.firmware, devices.firmware),
           notes      = excluded.notes,
           updated_at = excluded.updated_at
         RETURNING *`,
      )
        .bind(
          crypto.randomUUID(),
          owner,
          input.mac,
          input.name,
          input.chip ?? null,
          input.firmware ?? null,
          input.notes ?? "",
          timestamp,
          timestamp,
          timestamp,
        )
        .first<DeviceRow>();

      if (!row) throw new Error("failed to persist device");
      return toDevice(row);
    },

    async updateDevice(owner, id, patch) {
      const existing = await this.getDevice(owner, id);
      if (!existing) return null;

      const row = await stmt(
        `UPDATE devices SET name = ?, chip = ?, firmware = ?, notes = ?, updated_at = ?
         WHERE owner_id = ? AND id = ?
         RETURNING *`,
      )
        .bind(
          patch.name ?? existing.name,
          patch.chip === undefined ? existing.chip : patch.chip,
          patch.firmware === undefined ? existing.firmware : patch.firmware,
          patch.notes ?? existing.notes,
          now(),
          owner,
          id,
        )
        .first<DeviceRow>();

      return row ? toDevice(row) : null;
    },

    async touchDevice(owner, id, timestamp = now()) {
      await stmt("UPDATE devices SET last_seen_at = ?, updated_at = ? WHERE owner_id = ? AND id = ?")
        .bind(timestamp, timestamp, owner, id)
        .run();
    },

    async deleteDevice(owner, id) {
      // History survives device deletion on purpose: the log is the audit trail.
      const res = await stmt("DELETE FROM devices WHERE owner_id = ? AND id = ?")
        .bind(owner, id)
        .run();
      return (res.meta.changes ?? 0) > 0;
    },

    // --- Wi-Fi profiles ---------------------------------------------------

    async listWifiProfiles(owner, deviceId) {
      const rows = await (deviceId
        ? stmt(
            `SELECT * FROM wifi_profiles
              WHERE owner_id = ? AND (device_id = ? OR device_id IS NULL)
              ORDER BY updated_at DESC`,
          )
            .bind(owner, deviceId)
            .all<WifiProfileRow>()
        : stmt("SELECT * FROM wifi_profiles WHERE owner_id = ? ORDER BY updated_at DESC")
            .bind(owner)
            .all<WifiProfileRow>());

      return rows.results.map(toWifiProfile);
    },

    async getWifiProfile(owner, id) {
      const row = await stmt("SELECT * FROM wifi_profiles WHERE owner_id = ? AND id = ?")
        .bind(owner, id)
        .first<WifiProfileRow>();
      return row ? toWifiProfile(row) : null;
    },

    async insertWifiProfile(owner, input) {
      const timestamp = now();
      const row = await stmt(
        `INSERT INTO wifi_profiles (
           id, owner_id, device_id, ssid, password, security, channel, bssid, band,
           hidden, use_count, last_used_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
         RETURNING *`,
      )
        .bind(
          crypto.randomUUID(),
          owner,
          input.deviceId ?? null,
          input.ssid,
          input.password,
          input.security ?? "unknown",
          input.channel ?? null,
          input.bssid ?? null,
          input.band ?? null,
          input.hidden ? 1 : 0,
          timestamp,
          timestamp,
        )
        .first<WifiProfileRow>();

      if (!row) throw new Error("failed to persist Wi-Fi profile");
      return toWifiProfile(row);
    },

    async updateWifiProfile(owner, id, patch) {
      const existing = await this.getWifiProfile(owner, id);
      if (!existing) return null;

      const row = await stmt(
        `UPDATE wifi_profiles SET
           ssid = ?, password = ?, security = ?, channel = ?, bssid = ?, band = ?,
           hidden = ?, device_id = ?, updated_at = ?
         WHERE owner_id = ? AND id = ?
         RETURNING *`,
      )
        .bind(
          patch.ssid ?? existing.ssid,
          patch.password ?? existing.password,
          patch.security ?? existing.security,
          patch.channel === undefined ? existing.channel : patch.channel,
          patch.bssid === undefined ? existing.bssid : patch.bssid,
          patch.band === undefined ? existing.band : patch.band,
          (patch.hidden ?? existing.hidden) ? 1 : 0,
          patch.deviceId === undefined ? existing.deviceId : patch.deviceId,
          now(),
          owner,
          id,
        )
        .first<WifiProfileRow>();

      return row ? toWifiProfile(row) : null;
    },

    async markWifiProfileUsed(owner, id) {
      const timestamp = now();
      await stmt(
        `UPDATE wifi_profiles
           SET use_count = use_count + 1, last_used_at = ?, updated_at = ?
         WHERE owner_id = ? AND id = ?`,
      )
        .bind(timestamp, timestamp, owner, id)
        .run();
    },

    async deleteWifiProfile(owner, id) {
      const res = await stmt("DELETE FROM wifi_profiles WHERE owner_id = ? AND id = ?")
        .bind(owner, id)
        .run();
      return (res.meta.changes ?? 0) > 0;
    },

    // --- history ----------------------------------------------------------

    async listHistory(owner, filter = {}) {
      const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
      const rows = await (filter.deviceId
        ? stmt(
            "SELECT * FROM history WHERE owner_id = ? AND device_id = ? ORDER BY id DESC LIMIT ?",
          )
            .bind(owner, filter.deviceId, limit)
            .all<HistoryRow>()
        : stmt("SELECT * FROM history WHERE owner_id = ? ORDER BY id DESC LIMIT ?")
            .bind(owner, limit)
            .all<HistoryRow>());

      return rows.results.map(toHistoryEntry);
    },

    async insertHistory(owner, input) {
      const row = await stmt(
        `INSERT INTO history (owner_id, device_id, direction, command, response, ok, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
        .bind(
          owner,
          input.deviceId ?? null,
          input.direction,
          input.command,
          input.response ?? null,
          input.ok === false ? 0 : 1,
          now(),
        )
        .first<HistoryRow>();

      if (!row) throw new Error("failed to persist history entry");
      await pruneHistory(owner);
      return toHistoryEntry(row);
    },

    async clearHistory(owner, deviceId) {
      const res = await (deviceId
        ? stmt("DELETE FROM history WHERE owner_id = ? AND device_id = ?").bind(owner, deviceId).run()
        : stmt("DELETE FROM history WHERE owner_id = ?").bind(owner).run());
      return res.meta.changes ?? 0;
    },

    // --- settings ---------------------------------------------------------

    async getSettings(owner) {
      const res = await stmt(
        "SELECT key, value, updated_at FROM settings WHERE owner_id = ? ORDER BY key",
      )
        .bind(owner)
        .all<{ key: string; value: string; updated_at: string }>();

      const out: Record<string, string> = {};
      for (const row of res.results) out[row.key] = row.value;
      return out;
    },

    async putSettings(owner, patch) {
      const timestamp = now();
      const statements: D1PreparedStatement[] = [];

      for (const [key, value] of Object.entries(patch)) {
        statements.push(
          value === null
            ? stmt("DELETE FROM settings WHERE owner_id = ? AND key = ?").bind(owner, key)
            : stmt(
                `INSERT INTO settings (owner_id, key, value, updated_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT (owner_id, key) DO UPDATE SET
                   value = excluded.value, updated_at = excluded.updated_at`,
              ).bind(owner, key, value, timestamp),
        );
      }

      if (statements.length) await db.batch(statements);
      return this.getSettings(owner);
    },

    // --- generic key/value ------------------------------------------------

    async listKv(owner, namespace = "default", prefix) {
      const rows = await (prefix
        ? stmt(
            `SELECT * FROM kv
              WHERE owner_id = ? AND namespace = ? AND key LIKE ?
              ORDER BY updated_at DESC`,
          )
            .bind(owner, namespace, `${prefix}%`)
            .all<KvRow>()
        : stmt(
            "SELECT * FROM kv WHERE owner_id = ? AND namespace = ? ORDER BY updated_at DESC",
          )
            .bind(owner, namespace)
            .all<KvRow>());

      return rows.results.map(toKvEntry);
    },

    async putKv(owner, namespace, key, value) {
      const timestamp = now();
      const row = await stmt(
        `INSERT INTO kv (owner_id, namespace, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (owner_id, namespace, key) DO UPDATE SET
           value = excluded.value, updated_at = excluded.updated_at
         RETURNING *`,
      )
        .bind(owner, namespace, key, value, timestamp, timestamp)
        .first<KvRow>();

      if (!row) throw new Error("failed to persist value");
      return toKvEntry(row);
    },

    async deleteKv(owner, namespace, key) {
      const res = await stmt(
        "DELETE FROM kv WHERE owner_id = ? AND namespace = ? AND key = ?",
      )
        .bind(owner, namespace, key)
        .run();
      return (res.meta.changes ?? 0) > 0;
    },

    // --- stats ------------------------------------------------------------

    async stats(owner) {
      const row = await stmt(
        `SELECT
           (SELECT COUNT(*) FROM devices       WHERE owner_id = ?) AS devices,
           (SELECT COUNT(*) FROM wifi_profiles WHERE owner_id = ?) AS wifiProfiles,
           (SELECT COUNT(*) FROM history       WHERE owner_id = ?) AS historyEntries,
           (SELECT COUNT(*) FROM settings      WHERE owner_id = ?) AS settings`,
      )
        .bind(owner, owner, owner, owner)
        .first<Stats>();

      return row ?? { devices: 0, wifiProfiles: 0, historyEntries: 0, settings: 0 };
    },
  };
}
