/* ==========================================================================
   esp32-remote — browser app
   --------------------------------------------------------------------------
   Vanilla ES modules, no framework. Two halves:

     1. Persistence  — a small REST client over the Cloudflare Worker + D1
                       backend that stores devices, Wi-Fi profiles, history,
                       settings and arbitrary key/value data.
     2. Device link  — a Web Bluetooth session that speaks the line protocol
                       shared with the firmware (see ./protocol.js).

   The two never mix except in one place: commands the user fires are written
   to the device *and* logged to the backend, so history survives reloads.
   ========================================================================== */

import {
  CONTROL_UUID,
  DEVICE_NAME_PREFIX,
  SERVICE_UUID,
  STATUS_UUID,
  classify,
  commands,
  decodeValue,
  encodeCommand,
  formatMac,
  parseLine,
  rssiBars,
} from "./protocol.js";

/* ------------------------------------------------------------------ utils */

const $ = (id) => document.getElementById(id);

const state = {
  /** Server-side bootstrap payload (identity, settings, collections). */
  server: null,
  settings: {},

  // --- device link ---
  device: null,
  gatt: null,
  control: null,
  statusChar: null,
  connected: false,
  scanning: false,
  scanResults: [],
  /** Serialises GATT writes: the stack only accepts one in flight. */
  writeChain: Promise.resolve(),
  /** Resolver for the command currently awaiting its final response. */
  pending: null,

  // --- UI ---
  history: [],
  devices: [],
  profiles: [],
};

/** Timeouts per command class, in ms. Scans and joins are slow by nature. */
const TIMEOUTS = { SCAN: 25_000, JOIN: 35_000, DEFAULT: 10_000 };

function toast(message, kind = "info", ms = 3200) {
  const host = $("toasts");
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value ?? "—";
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return state.settings.showTimestamps === "true"
    ? d.toLocaleString()
    : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/* ------------------------------------------------------------- persistence */

/** Call the site's JSON API. Throws `Error` with the server's message. */
async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });

  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body — handled below */
  }

  if (!res.ok) {
    const message = body?.error?.message ?? `${res.status} ${res.statusText}`;
    throw new Error(message);
  }
  return body;
}

/** Replace the cached bootstrap payload and re-render every panel. */
function applyServer(payload) {
  state.server = payload;
  state.settings = { ...(payload.settings || {}) };
  state.devices = payload.devices || [];
  state.profiles = payload.wifiProfiles || [];
  state.history = payload.history || [];

  const owner = payload.identity?.id ?? "—";
  setText("identity-pill", `ws ${owner.slice(0, 8)}`);
  $("identity-pill").title = `Workspace id: ${owner}`;

  renderDevices();
  renderProfiles();
  renderHistory();
  renderStats();
  renderSettings();
}

async function reload() {
  applyServer(await api("/bootstrap"));
}

/** Fire-and-forget write; failures surface as a toast but never break the UI. */
async function persist(path, options, failureMessage) {
  try {
    const body = await api(path, options);
    return body;
  } catch (error) {
    toast(failureMessage ?? error.message, "err");
    return null;
  }
}

/** Append one row to the server-side control log. */
async function logHistory(entry) {
  if (!entry?.command) return;
  // Optimistic local append keeps the History tab live without a round trip.
  state.history.unshift({
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    deviceId: state.settings.lastDeviceId ?? null,
    direction: entry.direction,
    command: entry.command,
    response: entry.response ?? null,
    ok: entry.ok !== false,
    createdAt: new Date().toISOString(),
  });
  renderHistory();

  const saved = await persist(
    "/history",
    { method: "POST", body: JSON.stringify(entry) },
    "Command ran, but could not be logged.",
  );
  if (saved?.historyEntry) {
    const index = state.history.findIndex((h) => h.id.startsWith("local-"));
    if (index !== -1) state.history[index] = saved.historyEntry;
    renderHistory();
  }
}

/* ----------------------------------------------------------------- theme */

function resolveTheme(value) {
  if (value === "system" || !value) {
    return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return value;
}

function applyTheme(value) {
  document.documentElement.dataset.theme = resolveTheme(value);
  document.querySelectorAll("#theme-options .btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.themeValue === (value || "dark"));
  });
}

async function setTheme(value) {
  state.settings.theme = value;
  applyTheme(value);
  await persist(
    "/settings",
    { method: "PUT", body: JSON.stringify({ theme: value }) },
    "Theme not saved.",
  );
}

/* ------------------------------------------------------------------- tabs */

function initTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const name = tab.dataset.tab;

      document.querySelectorAll(".tab").forEach((other) => {
        const active = other === tab;
        other.classList.toggle("is-active", active);
        other.setAttribute("aria-selected", String(active));
      });

      document.querySelectorAll(".panel").forEach((panel) => {
        const active = panel.id === `panel-${name}`;
        panel.classList.toggle("is-active", active);
        panel.hidden = !active;
      });

      if (name === "history") renderHistory();
    });
  });
}

/* --------------------------------------------------------------- console */

function consoleLine(kind, text) {
  const box = $("console");
  const empty = box.querySelector(".console-empty");
  if (empty) empty.remove();

  const line = document.createElement("div");
  line.className = `line line-${kind}`;

  if (state.settings.showTimestamps === "true") {
    const time = document.createElement("span");
    time.className = "line-time";
    time.textContent = new Date().toLocaleTimeString();
    line.appendChild(time);
  }

  line.appendChild(document.createTextNode(text));
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;

  // Bound the DOM: the console is a live view, not the archive (that's History).
  while (box.children.length > 500) box.firstElementChild.remove();
}

function clearConsole() {
  $("console").innerHTML = '<div class="console-empty">No traffic yet.</div>';
}

/* ------------------------------------------------------------ BLE session */

function setConnectionState(mode, label) {
  const pill = $("conn-pill");
  pill.className = `pill pill-${mode}`;
  pill.textContent = label;

  const online = mode === "on";
  [
    "btn-status",
    "btn-ping",
    "btn-disconnect",
    "led-on",
    "led-off",
    "led-toggle",
    "gpio-set",
    "console-send",
    "btn-scan",
    "btn-join",
  ].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = !online;
  });

  $("console-input").disabled = !online;
  document.querySelectorAll(".quick-actions .chip").forEach((el) => {
    el.disabled = !online;
  });
}

function updateDeviceSummary(parsed) {
  $("device-summary").hidden = false;

  if (parsed.fields.name) setText("d-name", parsed.fields.name);
  if (parsed.fields.chip) setText("d-chip", parsed.fields.chip);
  if (parsed.fields.fw) setText("d-fw", parsed.fields.fw);
  if (parsed.fields.mac) setText("d-mac", formatMac(parsed.fields.mac));

  if (parsed.fields.wifi) {
    setText("d-wifi", parsed.fields.wifi === "up" ? "connected" : "not connected");
  }
  if (parsed.fields.ip) setText("d-ip", parsed.fields.ip);

  if (parsed.fields.rssi && parsed.fields.rssi !== "-") {
    const rssi = Number(parsed.fields.rssi);
    setText("d-rssi", `${rssi} dBm`);
    const bars = rssiBars(rssi);
    $("d-rssi").innerHTML = `<span class="signal" title="${rssi} dBm">${[0, 1, 2, 3]
      .map((i) => `<i class="${i < bars ? "on" : ""}"></i>`)
      .join("")}</span> ${rssi} dBm`;
  }

  if (parsed.fields.led !== undefined) {
    setText("d-led", parsed.fields.led === "1" ? "on" : "off");
  }
}

/** Whether `parsed` completes the in-flight `command`. */
function isFinalResponse(command, parsed) {
  if (parsed.verb === "ERR") return true;
  if (command === "SCAN") {
    return parsed.verb === "OK" && parsed.tail.startsWith("SCAN_DONE");
  }
  return parsed.verb === "OK";
}

function handleLine(raw, source) {
  const parsed = parseLine(raw);
  if (!parsed) return;

  const kind = classify(parsed);

  // Scan rows are table data, not console noise.
  if (kind !== "scan-result") {
    consoleLine(parsed.verb === "ERR" ? "err" : source === "tx" ? "tx" : "rx", parsed.raw);
  }

  if (kind === "status") {
    updateDeviceSummary(parsed);
  }

  // `OK INFO …` is the device introducing itself — record it in the Devices
  // tab so a board shows up without the user ever visiting that panel.
  if (parsed.verb === "OK" && parsed.tail.startsWith("INFO")) {
    void upsertDeviceFromInfo(parsed.fields);
  }

  if (kind === "scan-result") {
    state.scanResults.push({
      ssid: parsed.fields.ssid ?? parsed.tail.replace(/^ssid=/, ""),
      rssi: Number(parsed.fields.rssi ?? -100),
      channel: parsed.fields.channel ?? "—",
      auth: parsed.fields.auth ?? "—",
    });
    return;
  }

  if (kind === "scan-done") {
    state.scanning = false;
    renderScan();
    toast(`Found ${state.scanResults.length} network(s)`, "ok");
  }

  const pending = state.pending;
  if (pending && isFinalResponse(pending.command, parsed)) {
    state.pending = null;
    clearTimeout(pending.timer);
    pending.resolve(parsed);
  }
}

function characteristicHandler(source) {
  return (event) => {
    const value = event.target.value;
    if (!value) return;
    // A single notification may carry several newline-delimited lines.
    for (const line of decodeValue(value).split("\n")) {
      if (line.trim()) handleLine(line, source);
    }
  };
}

/**
 * Send one command and wait for its final response.
 *
 * Writes are chained on `state.writeChain` because a GATT server rejects a
 * second write while one is still in flight.
 */
function sendCommand(command, { timeout } = {}) {
  if (!state.connected || !state.control) {
    return Promise.reject(new Error("Not connected to a device."));
  }

  const ms = timeout ?? TIMEOUTS[command.split(" ")[0]] ?? TIMEOUTS.DEFAULT;

  const run = async () => {
    const payload = encodeCommand(command);
    if (payload.length > 240) throw new Error("Command too long (max 240 bytes).");

    const waiter = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (state.pending?.command === command) state.pending = null;
        reject(new Error(`Timed out waiting for a response to “${command}”.`));
      }, ms);
      state.pending = { command, resolve, timer };
    });

    try {
      if (typeof state.control.writeValueWithResponse === "function") {
        await state.control.writeValueWithResponse(payload);
      } else {
        await state.control.writeValue(payload);
      }
      consoleLine("tx", command);
      return await waiter;
    } catch (error) {
      if (state.pending?.command === command) {
        clearTimeout(state.pending.timer);
        state.pending = null;
      }
      throw error;
    }
  };

  const result = state.writeChain.then(run, run);
  state.writeChain = result.catch(() => {});
  return result;
}

/** Run `command`, log it to the server, and surface failures as toasts. */
async function runCommand(command, { label } = {}) {
  try {
    const response = await sendCommand(command);
    await logHistory({
      direction: "tx",
      command,
      response: response.raw,
      ok: !response.isError,
    });
    return response;
  } catch (error) {
    consoleLine("err", `! ${error.message}`);
    await logHistory({ direction: "tx", command, response: error.message, ok: false });
    toast(error.message, "err");
    return null;
  }
}

async function connectBle() {
  if (!("bluetooth" in navigator)) {
    toast("Web Bluetooth is not supported in this browser.", "err");
    return;
  }

  const btn = $("btn-connect");
  btn.disabled = true;
  setConnectionState("busy", "connecting…");

  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: DEVICE_NAME_PREFIX }],
      optionalServices: [SERVICE_UUID],
    });

    device.addEventListener("gattserverdisconnected", onDisconnected);

    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    const control = await service.getCharacteristic(CONTROL_UUID);
    const statusChar = await service.getCharacteristic(STATUS_UUID);

    control.addEventListener("characteristicvaluechanged", characteristicHandler("rx"));
    statusChar.addEventListener("characteristicvaluechanged", characteristicHandler("rx"));
    await control.startNotifications().catch(() => {});
    await statusChar.startNotifications().catch(() => {});

    state.device = device;
    state.gatt = server;
    state.control = control;
    state.statusChar = statusChar;
    state.connected = true;

    setConnectionState("on", `connected · ${device.name || DEVICE_NAME_PREFIX}`);
    clearConsole();
    consoleLine("sys", `Connected to ${device.name || "esp32-remote"}.`);

    // Learn who we just talked to, then pull live state.
    await runCommand(commands.info());
    await runCommand(commands.status());

    if (state.settings.autoReconnect === "true") {
      await persist(
        "/settings",
        { method: "PUT", body: JSON.stringify({ lastDeviceName: device.name || "" }) },
        null,
      );
    }
  } catch (error) {
    if (error.name !== "NotFoundError") {
      toast(error.message, "err");
      consoleLine("err", `! ${error.message}`);
    }
    setConnectionState("off", "disconnected");
  } finally {
    btn.disabled = false;
  }
}

function onDisconnected() {
  if (!state.connected) return;
  state.connected = false;
  state.control = null;
  state.statusChar = null;
  state.device = null;
  if (state.pending) {
    clearTimeout(state.pending.timer);
    state.pending.reject(new Error("Device disconnected."));
    state.pending = null;
  }
  setConnectionState("off", "disconnected");
  consoleLine("sys", "Disconnected.");
  logHistory({ direction: "event", command: "DISCONNECT", response: "link lost", ok: false });
}

function disconnectBle() {
  state.device?.gatt?.disconnect();
}

/* ------------------------------------------------------------------ scan */

function renderScan() {
  const body = $("scan-table").querySelector("tbody");

  if (state.scanning) {
    body.innerHTML = '<tr class="empty"><td colspan="5">Scanning…</td></tr>';
    return;
  }

  if (!state.scanResults.length) {
    body.innerHTML = '<tr class="empty"><td colspan="5">No networks found.</td></tr>';
    return;
  }

  const rows = [...state.scanResults]
    .sort((a, b) => b.rssi - a.rssi)
    .map((ap) => {
      const bars = rssiBars(ap.rssi);
      return `<tr>
        <td>${escapeHtml(ap.ssid || "<hidden>")}</td>
        <td class="mono">
          <span class="signal">${[0, 1, 2, 3]
            .map((i) => `<i class="${i < bars ? "on" : ""}"></i>`)
            .join("")}</span>
          ${ap.rssi} dBm
        </td>
        <td class="mono">${escapeHtml(ap.channel)}</td>
        <td class="mono">${escapeHtml(String(ap.auth).replace(/^Some\(|\)$/g, ""))}</td>
        <td><div class="row-actions">
          <button class="btn btn-ghost" data-use-ssid="${escapeHtml(ap.ssid)}">Use</button>
        </div></td>
      </tr>`;
    });

  body.innerHTML = rows.join("");

  body.querySelectorAll("[data-use-ssid]").forEach((btn) => {
    btn.addEventListener("click", () => {
      $("join-ssid").value = btn.dataset.useSsid ?? "";
      $("join-pass").focus();
      toast("SSID copied into the join form.", "info");
    });
  });
}

async function startScan() {
  state.scanResults = [];
  state.scanning = true;
  renderScan();
  $("btn-scan").disabled = true;

  const response = await runCommand(commands.scan());
  if (!response) state.scanning = false;
  $("btn-scan").disabled = !state.connected;
}

/* --------------------------------------------------------------- profiles */

function renderProfiles() {
  const host = $("profile-list");
  if (!state.profiles.length) {
    host.innerHTML = '<p class="empty">No saved networks yet.</p>';
    return;
  }

  host.innerHTML = state.profiles
    .map(
      (profile) => `<div class="list-item" data-profile="${profile.id}">
      <div class="list-item-main">
        <span class="list-item-title">${escapeHtml(profile.ssid)}</span>
        <span class="list-item-sub">
          ${escapeHtml(profile.security)}
          ${profile.band ? ` · ${escapeHtml(profile.band)} GHz` : ""}
          ${profile.channel ? ` · ch ${profile.channel}` : ""}
          · used ${profile.useCount}×
          ${profile.lastUsedAt ? `· last ${fmtTime(profile.lastUsedAt)}` : ""}
        </span>
      </div>
      <div class="row-actions">
        <button class="btn btn-ghost" data-act="connect">Connect</button>
        <button class="btn btn-ghost" data-act="edit">Edit</button>
        <button class="btn btn-ghost btn-danger" data-act="delete">Forget</button>
      </div>
    </div>`,
    )
    .join("");

  host.querySelectorAll("[data-profile]").forEach((row) => {
    const id = row.dataset.profile;
    const profile = state.profiles.find((p) => p.id === id);
    if (!profile) return;

    row.querySelector('[data-act="connect"]').addEventListener("click", async () => {
      $("join-ssid").value = profile.ssid;
      $("join-pass").value = profile.password;
      await joinNetwork(profile);
    });

    row.querySelector('[data-act="edit"]').addEventListener("click", () => {
      $("pf-ssid").value = profile.ssid;
      $("pf-pass").value = profile.password;
      $("pf-band").value = profile.band ?? "";
      $("profile-form").hidden = false;
      $("profile-form").dataset.editing = id;
      $("pf-ssid").focus();
    });

    row.querySelector('[data-act="delete"]').addEventListener("click", async () => {
      const result = await persist(
        `/wifi-profiles/${id}`,
        { method: "DELETE" },
        "Could not forget that network.",
      );
      if (result) {
        state.profiles = state.profiles.filter((p) => p.id !== id);
        renderProfiles();
        renderStats();
        toast("Network forgotten.", "ok");
      }
    });
  });
}

/** Push a network to the device; optionally remember it server-side first. */
async function joinNetwork(profile) {
  if (!state.connected) {
    toast("Connect to the ESP32 first.", "err");
    return null;
  }

  let stored = profile;
  if (!profile.id) {
    stored = await persist(
      "/wifi-profiles",
      {
        method: "POST",
        body: JSON.stringify({
          ssid: profile.ssid,
          password: profile.password ?? "",
          security: profile.security,
          channel: profile.channel ?? null,
          band: profile.band ?? null,
          hidden: profile.hidden ?? false,
        }),
      },
      "Could not save the network.",
    );
    if (!stored?.wifiProfile) return null;
    stored = stored.wifiProfile;
    state.profiles.unshift(stored);
    renderProfiles();
    renderStats();
  }

  const response = await runCommand(commands.join(stored.ssid, stored.password));
  if (response && !response.isError) {
    await persist(`/wifi-profiles/${stored.id}/used`, { method: "POST" }, null);
    const refreshed = state.profiles.find((p) => p.id === stored.id);
    if (refreshed) refreshed.useCount += 1;
    renderProfiles();
    toast(`ESP32 joined “${stored.ssid}”.`, "ok");
    await runCommand(commands.status());
  }
  return response;
}

/* ---------------------------------------------------------------- devices */

function renderDevices() {
  const host = $("device-list");
  if (!state.devices.length) {
    host.innerHTML = '<p class="empty">No devices recorded yet.</p>';
  } else {
    host.innerHTML = state.devices
      .map(
        (device) => `<div class="list-item" data-device="${device.id}">
        <div class="list-item-main">
          <span class="list-item-title">${escapeHtml(device.name)}</span>
          <span class="list-item-sub">
            ${escapeHtml(device.mac)}
            ${device.chip ? ` · ${escapeHtml(device.chip)}` : ""}
            ${device.firmware ? ` · fw ${escapeHtml(device.firmware)}` : ""}
            ${device.lastSeenAt ? ` · seen ${fmtTime(device.lastSeenAt)}` : ""}
          </span>
          ${device.notes ? `<span class="list-item-sub">${escapeHtml(device.notes)}</span>` : ""}
        </div>
        <div class="row-actions">
          <button class="btn btn-ghost" data-act="edit">Edit</button>
          <button class="btn btn-ghost btn-danger" data-act="delete">Delete</button>
        </div>
      </div>`,
      )
      .join("");
  }

  // History filter needs the same list.
  const filter = $("history-filter");
  const current = filter.value;
  filter.innerHTML =
    '<option value="">All devices</option>' +
    state.devices.map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join("");
  filter.value = state.devices.some((d) => d.id === current) ? current : "";
}

async function upsertDeviceFromInfo(fields) {
  if (!fields.mac) return;

  const payload = await persist(
    "/devices",
    {
      method: "POST",
      body: JSON.stringify({
        mac: formatMac(fields.mac),
        name: fields.name || formatMac(fields.mac),
        chip: fields.chip ?? null,
        firmware: fields.fw ?? null,
      }),
    },
    null,
  );

  if (payload?.device) {
    const existing = state.devices.findIndex((d) => d.id === payload.device.id);
    if (existing === -1) state.devices.unshift(payload.device);
    else state.devices[existing] = payload.device;

    state.settings.lastDeviceId = payload.device.id;
    renderDevices();
    renderStats();
    renderHistory();
  }
}

function renderStats() {
  setText("s-devices", String(state.devices.length));
  setText("s-networks", String(state.profiles.length));
  setText("s-history", String(state.history.length));
  setText("s-owner", state.server?.identity?.id?.slice(0, 8) ?? "—");
}

/* ---------------------------------------------------------------- history */

function renderHistory() {
  const body = $("history-table").querySelector("tbody");
  const filter = $("history-filter")?.value ?? "";
  const rows = state.history.filter((entry) => !filter || entry.deviceId === filter);

  if (!rows.length) {
    body.innerHTML = '<tr class="empty"><td colspan="5">Nothing logged yet.</td></tr>';
    return;
  }

  body.innerHTML = rows
    .slice(0, 300)
    .map(
      (entry) => `<tr>
      <td class="mono">${escapeHtml(fmtTime(entry.createdAt))}</td>
      <td><span class="badge badge-${escapeHtml(entry.direction)}">${escapeHtml(entry.direction)}</span></td>
      <td class="mono">${escapeHtml(entry.command)}</td>
      <td class="mono">${escapeHtml(entry.response ?? "")}</td>
      <td>${
        entry.ok === false
          ? '<span class="badge" style="color:var(--danger)">err</span>'
          : '<span class="badge badge-rx">ok</span>'
      }</td>
    </tr>`,
    )
    .join("");
}

/* --------------------------------------------------------------- settings */

function renderSettings() {
  applyTheme(state.settings.theme || "dark");
  $("opt-timestamps").checked = state.settings.showTimestamps === "true";
  $("auto-reconnect").checked = state.settings.autoReconnect === "true";
}

/* --------------------------------------------------------------- wiring */

function wireEvents() {
  $("btn-connect").addEventListener("click", connectBle);
  $("btn-disconnect").addEventListener("click", disconnectBle);

  $("btn-ping").addEventListener("click", () => runCommand(commands.ping()));
  $("btn-status").addEventListener("click", () => runCommand(commands.status()));

  $("led-on").addEventListener("click", () => runCommand(commands.led("ON")));
  $("led-off").addEventListener("click", () => runCommand(commands.led("OFF")));
  $("led-toggle").addEventListener("click", () => runCommand(commands.led("TOGGLE")));

  $("gpio-set").addEventListener("click", () => {
    const pin = Number.parseInt($("gpio-pin").value, 10);
    const level = Number($("gpio-level").value);
    if (Number.isNaN(pin)) return toast("Enter a pin number.", "err");
    runCommand(commands.gpio(pin, level));
  });

  $("console-clear").addEventListener("click", clearConsole);

  $("console-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("console-input");
    const command = input.value.trim();
    if (!command) return;
    input.value = "";
    runCommand(command);
  });

  document.querySelectorAll(".quick-actions .chip").forEach((chip) => {
    chip.addEventListener("click", () => runCommand(chip.dataset.cmd));
  });

  $("btn-scan").addEventListener("click", startScan);

  $("join-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const ssid = $("join-ssid").value.trim();
    if (!ssid) return;

    const profile = {
      ssid,
      password: $("join-pass").value,
      security: "unknown",
    };

    if ($("join-save").checked) {
      await joinNetwork(profile);
    } else if (!state.connected) {
      toast("Connect to the ESP32 first.", "err");
    } else {
      const response = await runCommand(commands.join(ssid, profile.password));
      if (response && !response.isError) {
        toast(`ESP32 joined “${ssid}”.`, "ok");
        await runCommand(commands.status());
      }
    }
  });

  $("btn-add-profile").addEventListener("click", () => {
    const form = $("profile-form");
    form.hidden = !form.hidden;
    delete form.dataset.editing;
    if (!form.hidden) $("pf-ssid").focus();
  });

  $("pf-cancel").addEventListener("click", () => {
    $("profile-form").hidden = true;
    delete $("profile-form").dataset.editing;
    $("profile-form").reset();
  });

  $("profile-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const body = {
      ssid: $("pf-ssid").value.trim(),
      password: $("pf-pass").value,
      band: $("pf-band").value || null,
      security: "unknown",
    };
    if (!body.ssid) return;

    const editing = form.dataset.editing;
    const result = await persist(
      editing ? `/wifi-profiles/${editing}` : "/wifi-profiles",
      { method: editing ? "PUT" : "POST", body: JSON.stringify(body) },
      "Could not save the network.",
    );

    if (result?.wifiProfile) {
      const index = state.profiles.findIndex((p) => p.id === result.wifiProfile.id);
      if (index === -1) state.profiles.unshift(result.wifiProfile);
      else state.profiles[index] = result.wifiProfile;
      renderProfiles();
      renderStats();
      form.reset();
      form.hidden = true;
      delete form.dataset.editing;
      toast(editing ? "Network updated." : "Network saved.", "ok");
    }
  });

  $("btn-add-device").addEventListener("click", () => {
    const form = $("device-form");
    form.hidden = !form.hidden;
    if (!form.hidden) $("dv-mac").focus();
  });

  $("dv-cancel").addEventListener("click", () => {
    $("device-form").hidden = true;
    $("device-form").reset();
  });

  $("device-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = await persist(
      "/devices",
      {
        method: "POST",
        body: JSON.stringify({
          mac: $("dv-mac").value.trim(),
          name: $("dv-name").value.trim(),
          notes: $("dv-notes").value.trim(),
        }),
      },
      "Could not save the device.",
    );

    if (result?.device) {
      const index = state.devices.findIndex((d) => d.id === result.device.id);
      if (index === -1) state.devices.unshift(result.device);
      else state.devices[index] = result.device;
      renderDevices();
      renderStats();
      event.currentTarget.reset();
      event.currentTarget.hidden = true;
      toast("Device saved.", "ok");
    }
  });

  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-device] [data-act]");
    if (!button) return;

    const row = button.closest("[data-device]");
    const id = row?.dataset.device;
    const device = state.devices.find((d) => d.id === id);
    if (!device) return;

    if (button.dataset.act === "delete") {
      const result = await persist(
        `/devices/${id}`,
        { method: "DELETE" },
        "Could not delete that device.",
      );
      if (result) {
        state.devices = state.devices.filter((d) => d.id !== id);
        renderDevices();
        renderStats();
        toast("Device deleted.", "ok");
      }
      return;
    }

    if (button.dataset.act === "edit") {
      $("dv-mac").value = device.mac;
      $("dv-name").value = device.name;
      $("dv-notes").value = device.notes ?? "";
      $("device-form").hidden = false;
      $("dv-name").focus();
      // Editing reuses POST because the store upserts on (owner, mac).
      toast("Adjust the fields and save — MAC identifies the device.", "info", 4200);
    }
  });

  $("btn-history-refresh").addEventListener("click", async () => {
    try {
      const body = await api(`/history?limit=300${historyQuery()}`);
      state.history = body.history || [];
      renderHistory();
    } catch (error) {
      toast(error.message, "err");
    }
  });

  $("history-filter").addEventListener("change", renderHistory);

  $("btn-history-clear").addEventListener("click", async () => {
    if (!confirm("Delete the stored control history for this workspace?")) return;

    const query = historyQuery();
    const result = await persist(
      `/history${query}`,
      { method: "DELETE" },
      "Could not clear history.",
    );
    if (result) {
      // Refetch rather than guessing locally: the filter may be a device id
      // that still has rows if the query string changed underneath us.
      try {
        const body = await api(`/history?limit=300${query}`);
        state.history = body.history || [];
      } catch {
        state.history = [];
      }
      renderHistory();
      renderStats();
      toast(`Cleared ${result.deleted} row(s).`, "ok");
    }
  });

  $("theme-toggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    setTheme(next);
  });

  document.querySelectorAll("#theme-options .btn").forEach((btn) => {
    btn.addEventListener("click", () => setTheme(btn.dataset.themeValue));
  });

  $("opt-timestamps").addEventListener("change", (event) => {
    const value = String(event.target.checked);
    state.settings.showTimestamps = value;
    persist("/settings", { method: "PUT", body: JSON.stringify({ showTimestamps: value }) }, null);
    clearConsole();
    renderHistory();
    renderDevices();
    renderProfiles();
  });

  $("auto-reconnect").addEventListener("change", async (event) => {
    const value = String(event.target.checked);
    state.settings.autoReconnect = value;
    await persist("/settings", { method: "PUT", body: JSON.stringify({ autoReconnect: value }) }, null);
  });

  $("btn-export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state.server, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `esp32-remote-${(state.server?.identity?.id ?? "workspace").slice(0, 8)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  });

  $("btn-reset").addEventListener("click", async () => {
    if (!confirm("Erase every device, network, history row and setting for this workspace?")) {
      return;
    }

    await persist("/history", { method: "DELETE" }, null);
    for (const device of state.devices) {
      await persist(`/devices/${device.id}`, { method: "DELETE" }, null);
    }
    for (const profile of state.profiles) {
      await persist(`/wifi-profiles/${profile.id}`, { method: "DELETE" }, null);
    }

    const settingsPatch = Object.fromEntries(
      Object.keys(state.settings).map((key) => [key, null]),
    );
    if (Object.keys(settingsPatch).length) {
      await persist("/settings", { method: "PUT", body: JSON.stringify(settingsPatch) }, null);
    }

    await reload();
    clearConsole();
    toast("Workspace reset.", "ok");
  });
}

function historyQuery() {
  const device = $("history-filter")?.value;
  return device ? `&deviceId=${encodeURIComponent(device)}` : "";
}

/* ------------------------------------------------------------------ init */

async function init() {
  initTabs();
  clearConsole();
  wireEvents();

  if (!("bluetooth" in navigator)) {
    $("bt-support").hidden = false;
    $("btn-connect").disabled = true;
  }

  setConnectionState("off", "disconnected");

  try {
    await reload();
  } catch (error) {
    toast(`Could not reach the backend: ${error.message}`, "err", 6000);
    consoleLine("err", `backend unavailable: ${error.message}`);
  }

  // A device that drops mid-session must not leave the UI stuck "connected".
  window.addEventListener("beforeunload", () => {
    if (state.connected) state.device?.gatt?.disconnect();
  });

  // The system theme only matters while the user has chosen "system".
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (!state.settings.theme || state.settings.theme === "system") {
      applyTheme(state.settings.theme ?? "system");
    }
  });
}

init();
