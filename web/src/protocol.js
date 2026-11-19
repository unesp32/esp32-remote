/**
 * Line protocol, browser side.
 *
 * This file is the mirror of `firmware/src/protocol.rs` and of the UUIDs in
 * `firmware/src/gatt.rs`. Change all three together — the grammar is
 * documented in CONTRIBUTING.md.
 *
 * Every message is exactly one line of printable ASCII terminated by `\n`.
 * The firmware truncates at 240 bytes to fit inside a 255-byte ATT MTU, so
 * callers should keep commands well under that.
 */

/** Primary GATT service — mirrors `firmware/src/gatt.rs::SERVICE_UUID`. */
export const SERVICE_UUID = "937312e0-2354-11eb-9f10-fbc30a62cf38";
/** Commands in, responses out — mirrors `CONTROL_UUID`. */
export const CONTROL_UUID = "937312e1-2354-11eb-9f10-fbc30a62cf38";
/** Unsolicited state pushes — mirrors `STATUS_UUID`. */
export const STATUS_UUID = "937312e2-2354-11eb-9f10-fbc30a62cf38";

/** BLE local-name prefix the firmware advertises. */
export const DEVICE_NAME_PREFIX = "esp32-remote";

/** Longest line we will send; matches `protocol.rs::MAX_LINE`. */
export const MAX_LINE = 240;

/** Builders for every command the firmware understands. */
export const commands = {
  ping: () => "PING",
  info: () => "INFO",
  scan: () => "SCAN",
  status: () => "STATUS",
  /** SSIDs may contain spaces; the password is everything after ` pass=`. */
  join: (ssid, password) => `JOIN ssid=${ssid} pass=${password}`,
  /** @param {"ON"|"OFF"|"TOGGLE"} action */
  led: (action) => `LED ${action}`,
  gpio: (pin, level) => `GPIO ${pin} ${level ? 1 : 0}`,
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Encode a command for a GATT write, appending the terminating newline. */
export function encodeCommand(text) {
  const line = text.endsWith("\n") ? text : `${text}\n`;
  return encoder.encode(line);
}

/** Decode a characteristic value into a string. */
export function decodeValue(buffer) {
  return decoder.decode(buffer);
}

/**
 * Field matcher: `key=value` pairs where the value may itself contain spaces.
 *
 * The lookahead stops at the next `key=`, so `ssid=My Home WiFi` at the end of
 * a line survives intact while `rssi=-40` still terminates correctly.
 */
const FIELD_RE = /([A-Za-z_][A-Za-z0-9_]*)=([^]*?)(?=\s+[A-Za-z_][A-Za-z0-9_]*=|$)/g;

/**
 * Split a raw line into its verb, trailing text and `key=value` fields.
 *
 * @param {string} raw
 * @returns {{verb: string, tail: string, fields: Record<string,string>, raw: string, ok: boolean, isError: boolean} | null}
 */
export function parseLine(raw) {
  const line = raw.replace(/\r/g, "").trim();
  if (!line) return null;

  const space = line.indexOf(" ");
  const verb = space === -1 ? line : line.slice(0, space);
  const tail = space === -1 ? "" : line.slice(space + 1);

  const fields = {};
  FIELD_RE.lastIndex = 0;
  let match;
  while ((match = FIELD_RE.exec(line)) !== null) {
    fields[match[1]] = match[2];
  }

  return {
    verb,
    tail,
    fields,
    raw: line,
    ok: verb === "OK" || verb === "PONG",
    isError: verb === "ERR",
  };
}

/**
 * Classify an incoming line so the UI knows where to put it.
 *
 * @returns {"response"|"scan-result"|"scan-start"|"scan-done"|"status"|"error"|"info"}
 */
export function classify(parsed) {
  if (!parsed) return "info";
  if (parsed.verb === "ERR") return "error";
  if (parsed.verb === "AP") return "scan-result";
  if (parsed.verb === "OK" && parsed.tail.startsWith("SCAN_START")) return "scan-start";
  if (parsed.verb === "OK" && parsed.tail.startsWith("SCAN_DONE")) return "scan-done";
  if (parsed.verb === "OK" && parsed.tail.startsWith("STATUS")) return "status";
  return "response";
}

/** Parse a `mac=` field (`aabbccddeeff`) into colon-separated form. */
export function formatMac(raw) {
  if (!raw) return "";
  const hex = raw.replace(/[^0-9a-fA-F]/g, "");
  if (hex.length !== 12) return raw;
  return hex.match(/.{2}/g).join(":");
}

/** Coarse RSSI → bar count (0-4), used by the signal indicator. */
export function rssiBars(rssi) {
  const value = Number(rssi);
  if (Number.isNaN(value)) return 0;
  if (value >= -50) return 4;
  if (value >= -60) return 3;
  if (value >= -70) return 2;
  if (value >= -80) return 1;
  return 0;
}
