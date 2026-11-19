/**
 * D1 schema for esp32-remote.
 *
 * Everything the site remembers lives here: devices, Wi-Fi profiles, control
 * history, site settings and a generic key/value store for anything else.
 *
 * ## Design notes
 *
 * * **Every table carries `owner_id`.** Authentication is intentionally absent
 *   for now (see `auth.ts`), but the column means real auth can be slotted in
 *   later without a migration rewrite — the anonymous identity simply becomes
 *   a verified one.
 * * **Migrations are append-only and idempotent.** {@link ensureSchema}
 *   replays the whole list against `IF NOT EXISTS` DDL, so a fresh database
 *   and an existing one converge on the same shape.
 */

/** Bump when adding an entry to {@link MIGRATIONS}. */
export const SCHEMA_VERSION = 1;

/**
 * Ordered, append-only migrations. Never edit a shipped entry — add a new one.
 *
 * DDL uses `IF NOT EXISTS` throughout so replaying is harmless.
 */
export const MIGRATIONS: readonly string[] = [
  // 001 — initial schema
  `
  CREATE TABLE IF NOT EXISTS owners (
    id         TEXT PRIMARY KEY,
    label      TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS devices (
    id           TEXT PRIMARY KEY,
    owner_id     TEXT NOT NULL,
    mac          TEXT NOT NULL,
    name         TEXT NOT NULL,
    chip         TEXT,
    firmware     TEXT,
    notes        TEXT NOT NULL DEFAULT '',
    last_seen_at TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    UNIQUE (owner_id, mac)
  );

  CREATE TABLE IF NOT EXISTS wifi_profiles (
    id           TEXT PRIMARY KEY,
    owner_id     TEXT NOT NULL,
    device_id    TEXT,
    ssid         TEXT NOT NULL,
    password     TEXT NOT NULL DEFAULT '',
    security     TEXT NOT NULL DEFAULT 'unknown',
    channel      INTEGER,
    bssid        TEXT,
    band         TEXT,
    hidden       INTEGER NOT NULL DEFAULT 0,
    use_count    INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id   TEXT NOT NULL,
    device_id  TEXT,
    direction  TEXT NOT NULL CHECK (direction IN ('tx', 'rx', 'event')),
    command    TEXT NOT NULL,
    response   TEXT,
    ok         INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    owner_id   TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, key)
  );

  CREATE TABLE IF NOT EXISTS kv (
    owner_id   TEXT NOT NULL,
    namespace  TEXT NOT NULL DEFAULT 'default',
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, namespace, key)
  );

  CREATE INDEX IF NOT EXISTS idx_devices_owner   ON devices (owner_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_wifi_owner      ON wifi_profiles (owner_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_wifi_device     ON wifi_profiles (device_id);
  CREATE INDEX IF NOT EXISTS idx_history_owner   ON history (owner_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_history_device  ON history (device_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_kv_owner_ns     ON kv (owner_id, namespace, updated_at DESC);
  `,
];

/**
 * Create any missing tables and indexes.
 *
 * Idempotent and cheap: we probe for one table and replay only when it is
 * absent, so steady-state requests pay a single indexed lookup.
 *
 * Statements are executed one at a time rather than through `db.exec()`.
 * `exec()` hands the whole script to SQLite's multi-statement runner, which
 * rejects our DDL with `incomplete input` as soon as it meets the first
 * `CREATE TABLE ... (` — splitting here keeps every statement whole.
 */
export async function ensureSchema(db: D1Database): Promise<void> {
  const probe = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'owners'")
    .first<{ name: string }>();

  if (probe) return;

  for (const migration of MIGRATIONS) {
    for (const statement of splitStatements(migration)) {
      await db.prepare(statement).run();
    }
  }
}

/**
 * Split a script into individual statements.
 *
 * Aware of single-quoted strings and `--` comments so a semicolon inside
 * either is not mistaken for a terminator. Our schema does not currently use
 * either, but a future migration might.
 */
export function splitStatements(script: string): string[] {
  const out: string[] = [];
  let current = "";
  let inString = false;

  for (let i = 0; i < script.length; i++) {
    const char = script[i];
    const next = script[i + 1];

    if (inString) {
      current += char;
      if (char === "'") {
        // `''` is an escaped quote, not a terminator.
        if (next === "'") {
          current += next;
          i++;
        } else {
          inString = false;
        }
      }
      continue;
    }

    if (char === "'") {
      inString = true;
      current += char;
      continue;
    }

    if (char === "-" && next === "-") {
      // Skip the rest of the line comment.
      while (i < script.length && script[i] !== "\n") i++;
      current += "\n";
      continue;
    }

    if (char === ";") {
      if (current.trim()) out.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) out.push(current.trim());
  return out;
}
