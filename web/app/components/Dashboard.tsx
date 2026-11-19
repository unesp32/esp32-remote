"use client";

import "@cloudflare/kumo/styles/standalone";
import "../globals.css";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { Input } from "@cloudflare/kumo/components/input";
import { Table } from "@cloudflare/kumo/components/table";
import { Banner } from "@cloudflare/kumo/components/banner";
import {
  Bluetooth,
  WifiHigh,
  Terminal,
  Cpu,
  HardDrives,
  ClockCounterClockwise,
  Gear,
  Trash,
  Plus,
  ArrowClockwise,
  Lightning,
  Eye,
  EyeSlash,
  PaperPlaneRight,
  ShieldCheck,
  Broadcast,
  CheckCircle,
  Warning,
  Power,
} from "@phosphor-icons/react";

import {
  SERVICE_UUID,
  CONTROL_UUID,
  STATUS_UUID,
  DEVICE_NAME_PREFIX,
  commands,
  encodeCommand,
  decodeValue,
  parseLine,
  classify,
  type ParsedLine,
} from "../../src/protocol";

import type { Device, WifiProfile, HistoryEntry } from "../../src/db";
import {
  saveDevice,
  deleteDevice,
  saveWifiProfile,
  deleteWifiProfile,
  recordHistory,
  clearHistory,
  resetWorkspace,
} from "../actions";

interface DashboardProps {
  identity: { id: string; anonymous: boolean; source: string };
  initialDevices: Device[];
  initialProfiles: WifiProfile[];
  initialHistory: HistoryEntry[];
  initialSettings: Record<string, string>;
}

interface LogEntry {
  id: string;
  time: string;
  dir: "tx" | "rx" | "sys" | "err";
  text: string;
}

interface DiscoveredAp {
  ssid: string;
  rssi: number;
  channel: string;
  auth: string;
}

export function Dashboard({
  identity,
  initialDevices,
  initialProfiles,
  initialHistory,
}: DashboardProps) {
  // --- Bluetooth State ---
  const [bluetoothSupported, setBluetoothSupported] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [activeTab, setActiveTab] = useState("console");
  const [acceptAllDevices, setAcceptAllDevices] = useState(false);

  // Device & Telemetry State
  const [deviceInfo, setDeviceInfo] = useState({
    name: "esp32-remote",
    chip: "esp32s3",
    fw: "—",
    mac: "—",
    wifi: "down",
    ip: "—",
    ssid: "",
    rssi: "—",
    led: "0",
  });

  // GATT Refs
  const deviceRef = useRef<any>(null);
  const controlCharRef = useRef<any>(null);
  const statusCharRef = useRef<any>(null);

  // In-flight command tracking
  const pendingCommandRef = useRef<{
    command: string;
    resolve: (res: ParsedLine) => void;
    reject: (err: Error) => void;
    timer: any;
  } | null>(null);

  // Console Logs
  const [logs, setLogs] = useState<LogEntry[]>([
    {
      id: "init",
      time: new Date().toLocaleTimeString(),
      dir: "sys",
      text: "esp32-remote control dashboard ready. Click 'Connect ESP32' to begin.",
    },
  ]);
  const [commandInput, setCommandInput] = useState("");
  const consoleBottomRef = useRef<HTMLDivElement>(null);

  // Wi-Fi Scanner & Provisioning
  const [scanning, setScanning] = useState(false);
  const [scanResults, setScanResults] = useState<DiscoveredAp[]>([]);
  const [joinSsid, setJoinSsid] = useState("");
  const [joinPass, setJoinPass] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [joining, setJoining] = useState(false);

  // Saved Data
  const [devices, setDevices] = useState<Device[]>(initialDevices);
  const [profiles, setProfiles] = useState<WifiProfile[]>(initialProfiles);
  const [history, setHistory] = useState<HistoryEntry[]>(initialHistory);

  // New Profile Form
  const [newSsid, setNewSsid] = useState("");
  const [newPass, setNewPass] = useState("");

  // Check browser capability on mount
  useEffect(() => {
    if (typeof navigator === "undefined" || !("bluetooth" in navigator)) {
      setBluetoothSupported(false);
    }
  }, []);

  // Auto-scroll console
  useEffect(() => {
    consoleBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const addLog = useCallback((dir: "tx" | "rx" | "sys" | "err", text: string) => {
    const entry: LogEntry = {
      id: Math.random().toString(36).substring(2, 9),
      time: new Date().toLocaleTimeString(),
      dir,
      text,
    };
    setLogs((prev) => [...prev.slice(-300), entry]);
  }, []);

  // Format MAC address with colons if needed
  const formatMac = (raw: string) => {
    const clean = raw.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
    if (clean.length === 12) {
      return clean.match(/.{1,2}/g)?.join(":") || raw;
    }
    return raw;
  };

  // --- Line Parser & Event Dispatcher ---
  const handleIncomingLine = useCallback(
    (raw: string) => {
      const parsed = parseLine(raw);
      if (!parsed) return;

      const kind = classify(parsed);

      if (parsed.verb !== "AP") {
        addLog(parsed.verb === "ERR" ? "err" : "rx", parsed.raw);
      }

      // Resolve pending command promise
      if (pendingCommandRef.current) {
        const { command, resolve, timer } = pendingCommandRef.current;
        const isFinal =
          parsed.verb === "ERR" ||
          (command === "SCAN"
            ? parsed.verb === "OK" && parsed.tail.startsWith("SCAN_DONE")
            : parsed.verb === "OK");

        if (isFinal) {
          clearTimeout(timer);
          pendingCommandRef.current = null;
          resolve(parsed);
        }
      }

      // Handle INFO response
      if (parsed.verb === "OK" && parsed.tail.startsWith("INFO")) {
        setDeviceInfo((prev) => ({
          ...prev,
          name: parsed.fields.name || prev.name,
          chip: parsed.fields.chip || prev.chip,
          fw: parsed.fields.fw || prev.fw,
          mac: parsed.fields.mac ? formatMac(parsed.fields.mac) : prev.mac,
        }));

        if (parsed.fields.mac) {
          void saveDevice({
            mac: parsed.fields.mac,
            name: parsed.fields.name || "esp32-remote",
            chip: parsed.fields.chip,
            firmware: parsed.fields.fw,
          }).then((saved) => {
            setDevices((prev) => {
              const filtered = prev.filter((d) => d.mac !== saved.mac);
              return [saved, ...filtered];
            });
          });
        }
      }

      // Handle STATUS response
      if (parsed.verb === "OK" && parsed.tail.startsWith("STATUS")) {
        setDeviceInfo((prev) => ({
          ...prev,
          wifi: parsed.fields.wifi || prev.wifi,
          ip: parsed.fields.ip || prev.ip,
          ssid: parsed.fields.ssid || prev.ssid,
          rssi: parsed.fields.rssi || prev.rssi,
          led: parsed.fields.led !== undefined ? parsed.fields.led : prev.led,
        }));
      }

      // Handle LED state update
      if (parsed.verb === "OK" && parsed.tail.startsWith("LED")) {
        const val = parsed.tail.replace("LED ", "").trim();
        setDeviceInfo((prev) => ({ ...prev, led: val }));
      }

      // Handle Wi-Fi Access Point scan result
      if (kind === "scan-result") {
        const ap: DiscoveredAp = {
          ssid: parsed.fields.ssid || parsed.tail.replace(/^ssid=/, ""),
          rssi: Number(parsed.fields.rssi || -100),
          channel: parsed.fields.channel || "—",
          auth: parsed.fields.auth ? parsed.fields.auth.replace(/^Some\(|\)$/g, "") : "Open",
        };
        setScanResults((prev) => {
          if (prev.some((x) => x.ssid === ap.ssid)) return prev;
          return [...prev, ap].sort((a, b) => b.rssi - a.rssi);
        });
      }

      if (kind === "scan-done") {
        setScanning(false);
        addLog("sys", `Wi-Fi scan completed. Discovered ${scanResults.length} access point(s).`);
      }
    },
    [addLog, scanResults.length],
  );

  // --- Send Command Over BLE ---
  const sendBleCommand = useCallback(
    async (commandStr: string, timeoutMs = 8000): Promise<ParsedLine> => {
      if (!controlCharRef.current) {
        throw new Error("Not connected to ESP32.");
      }

      const payload = encodeCommand(commandStr);
      addLog("tx", commandStr);

      const promise = new Promise<ParsedLine>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pendingCommandRef.current?.command === commandStr) {
            pendingCommandRef.current = null;
          }
          reject(new Error(`Timed out waiting for response to '${commandStr}'`));
        }, timeoutMs);

        pendingCommandRef.current = { command: commandStr, resolve, reject, timer };
      });

      try {
        if (typeof controlCharRef.current.writeValueWithResponse === "function") {
          await controlCharRef.current.writeValueWithResponse(payload);
        } else {
          await controlCharRef.current.writeValue(payload);
        }
      } catch (err: any) {
        if (pendingCommandRef.current?.command === commandStr) {
          clearTimeout(pendingCommandRef.current.timer);
          pendingCommandRef.current = null;
        }
        throw err;
      }

      const res = await promise;

      // Persist to Cloudflare D1
      void recordHistory({
        command: commandStr,
        response: res.raw,
        direction: "tx",
        ok: !res.isError,
      }).then((rec) => {
        setHistory((prev) => [rec, ...prev.slice(0, 99)]);
      });

      return res;
    },
    [addLog],
  );

  // --- Bluetooth Connect / Disconnect ---
  const handleConnect = async () => {
    if (connected) {
      if (deviceRef.current?.gatt?.connected) {
        deviceRef.current.gatt.disconnect();
      }
      setConnected(false);
      controlCharRef.current = null;
      statusCharRef.current = null;
      addLog("sys", "Disconnected from ESP32.");
      return;
    }

    setConnecting(true);
    addLog("sys", "Opening Web Bluetooth device chooser...");

    try {
      const requestOptions: any = acceptAllDevices
        ? { acceptAllDevices: true, optionalServices: [SERVICE_UUID] }
        : {
            filters: [
              { namePrefix: DEVICE_NAME_PREFIX },
              { namePrefix: "esp32" },
              { namePrefix: "ESP32" },
              { services: [SERVICE_UUID] },
            ],
            optionalServices: [SERVICE_UUID],
          };

      const device = await (navigator as any).bluetooth.requestDevice(requestOptions);

      addLog("sys", `Connecting to GATT server on '${device.name || "ESP32"}'...`);
      device.addEventListener("gattserverdisconnected", () => {
        setConnected(false);
        controlCharRef.current = null;
        statusCharRef.current = null;
        addLog("sys", "ESP32 disconnected.");
      });

      const server = await device.gatt.connect();
      addLog("sys", "Accessing primary GATT service...");
      const service = await server.getPrimaryService(SERVICE_UUID);

      const control = await service.getCharacteristic(CONTROL_UUID);
      let statusChar: any = null;
      try {
        statusChar = await service.getCharacteristic(STATUS_UUID);
      } catch (e) {
        console.warn("Status characteristic not present or skipped", e);
      }

      const onNotify = (event: any) => {
        const val = event.target.value;
        if (!val) return;
        const text = decodeValue(val);
        for (const line of text.split("\n")) {
          if (line.trim()) handleIncomingLine(line);
        }
      };

      control.addEventListener("characteristicvaluechanged", onNotify);
      await control.startNotifications().catch((e: any) => {
        addLog("err", `Notification setup warning: ${e.message}`);
      });

      if (statusChar) {
        statusChar.addEventListener("characteristicvaluechanged", onNotify);
        await statusChar.startNotifications().catch(() => {});
      }

      deviceRef.current = device;
      controlCharRef.current = control;
      statusCharRef.current = statusChar;
      setConnected(true);
      addLog("sys", "Connected! Handshake established.");

      // Safe initial telemetry queries
      try {
        await sendBleCommand(commands.info(), 3000);
      } catch (e) {
        console.warn("Initial info query timeout", e);
      }
      try {
        await sendBleCommand(commands.status(), 3000);
      } catch (e) {
        console.warn("Initial status query timeout", e);
      }
    } catch (err: any) {
      if (err.name !== "NotFoundError") {
        addLog("err", `Connection failed: ${err.message}`);
      } else {
        addLog("sys", "Bluetooth device selection cancelled.");
      }
    } finally {
      setConnecting(false);
    }
  };

  // --- Quick Actions ---
  const handlePing = async () => {
    try {
      await sendBleCommand(commands.ping());
    } catch (e: any) {
      addLog("err", e.message);
    }
  };

  const handleInfo = async () => {
    try {
      await sendBleCommand(commands.info());
    } catch (e: any) {
      addLog("err", e.message);
    }
  };

  const handleStatus = async () => {
    try {
      await sendBleCommand(commands.status());
    } catch (e: any) {
      addLog("err", e.message);
    }
  };

  const handleToggleLed = async () => {
    try {
      await sendBleCommand(commands.led("TOGGLE"));
    } catch (e: any) {
      addLog("err", e.message);
    }
  };

  const handleScanWifi = async () => {
    setScanning(true);
    setScanResults([]);
    try {
      await sendBleCommand(commands.scan(), 20000);
    } catch (e: any) {
      setScanning(false);
      addLog("err", e.message);
    }
  };

  const handleJoinWifi = async () => {
    if (!joinSsid) return;
    setJoining(true);
    try {
      addLog("sys", `Provisioning ESP32 with Wi-Fi network '${joinSsid}'...`);
      await sendBleCommand(commands.join(joinSsid, joinPass), 25000);
      await sendBleCommand(commands.status());
      addLog("sys", `Wi-Fi join sequence complete.`);

      // Persist to Saved Profiles
      await saveWifiProfile({ ssid: joinSsid, password: joinPass });
      const updatedProfiles: any = await fetch("/api/wifi-profiles").then((r) => r.json());
      if (updatedProfiles?.wifiProfiles) setProfiles(updatedProfiles.wifiProfiles);
    } catch (e: any) {
      addLog("err", `Join failed: ${e.message}`);
    } finally {
      setJoining(false);
    }
  };

  const handleManualCommandSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!commandInput.trim()) return;
    const cmd = commandInput.trim();
    setCommandInput("");
    try {
      await sendBleCommand(cmd);
    } catch (e: any) {
      addLog("err", e.message);
    }
  };

  const renderRssiBars = (rssi: number) => {
    const bars = rssi > -55 ? 4 : rssi > -70 ? 3 : rssi > -82 ? 2 : 1;
    return (
      <span className="signal-bars" title={`${rssi} dBm`}>
        <span className={`signal-bar bar-1 ${bars >= 1 ? "active" : ""}`} />
        <span className={`signal-bar bar-2 ${bars >= 2 ? "active" : ""}`} />
        <span className={`signal-bar bar-3 ${bars >= 3 ? "active" : ""}`} />
        <span className={`signal-bar bar-4 ${bars >= 4 ? "active" : ""}`} />
      </span>
    );
  };

  return (
    <div className="app-container">
      {/* Top Navbar */}
      <header className="app-header">
        <div className="brand-wrapper">
          <div className="brand-icon shadow-sm">
            <Cpu size={26} weight="duotone" />
          </div>
          <div>
            <h1 className="brand-title">
              esp32-remote
              <Badge variant="outline">v0.2.0-kumo</Badge>
            </h1>
            <p className="brand-subtitle">
              Web Bluetooth remote control &amp; Wi-Fi provisioning powered by Cloudflare
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <Badge
            variant={connected ? "success" : connecting ? "warning" : "neutral"}
            appearance="dot"
            className="font-mono text-xs"
          >
            {connected
              ? `Connected · ${deviceInfo.name}`
              : connecting
                ? "Connecting..."
                : "Disconnected"}
          </Badge>

          <Button
            variant={connected ? "destructive" : "primary"}
            onClick={handleConnect}
            disabled={connecting || !bluetoothSupported}
            className="flex items-center gap-2"
          >
            <Bluetooth size={16} weight="bold" />
            {connected ? "Disconnect" : connecting ? "Pairing..." : "Connect ESP32"}
          </Button>
        </div>
      </header>

      {/* Browser Warning */}
      {!bluetoothSupported && (
        <div className="mb-4">
          <Banner variant="error">
            Web Bluetooth is not supported in this browser. Please open this page in Google Chrome,
            Microsoft Edge, or Opera on macOS, Linux, Windows, or Android. Note that iOS Safari does
            not support Web Bluetooth.
          </Banner>
        </div>
      )}

      {/* Guidance Banner */}
      <div className="mb-5">
        <Banner variant="secondary">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 text-xs">
            <span>
              💡 <strong>How to connect:</strong> Click <strong>Connect ESP32</strong> above, choose{" "}
              <code>esp32-remote</code> in the browser popup, and click Pair. Do <em>not</em> pair in
              macOS System Settings.
            </span>
            <label className="inline-flex items-center gap-1.5 cursor-pointer select-none text-xs text-kumo-subtle shrink-0">
              <input
                type="checkbox"
                checked={acceptAllDevices}
                onChange={(e) => setAcceptAllDevices(e.target.checked)}
                className="rounded border-kumo-hairline"
              />
              Show all Bluetooth devices
            </label>
          </div>
        </Banner>
      </div>

      {/* Telemetry Card */}
      <section className="telemetry-card">
        <div className="card-header">
          <div className="card-title">
            <Broadcast size={16} className="text-kumo-link" />
            Hardware Telemetry
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleStatus}
            disabled={!connected}
            className="flex items-center gap-1.5"
          >
            <ArrowClockwise size={13} /> Refresh
          </Button>
        </div>

        <div className="telemetry-grid">
          <div className="stat-item">
            <span className="stat-label">Device Name</span>
            <span className="stat-value truncate">{deviceInfo.name}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">Chip / Target</span>
            <span className="stat-value">{deviceInfo.chip}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">Firmware</span>
            <span className="stat-value">{deviceInfo.fw}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">MAC Address</span>
            <span className="stat-value text-kumo-link">{deviceInfo.mac}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">Wi-Fi Status</span>
            <div className="flex items-center gap-1.5">
              <span
                className={`w-2 h-2 rounded-full ${
                  deviceInfo.wifi === "up" ? "bg-emerald-500 animate-pulse" : "bg-neutral-600"
                }`}
              />
              <span className="stat-value">
                {deviceInfo.wifi === "up" ? deviceInfo.ip : "Disconnected"}
              </span>
            </div>
          </div>
          <div className="stat-item">
            <span className="stat-label">Status LED</span>
            <Badge variant={deviceInfo.led === "1" ? "success" : "neutral"}>
              {deviceInfo.led === "1" ? "ON (GPIO48)" : "OFF"}
            </Badge>
          </div>
        </div>

        {/* Quick Actions Toolbar */}
        <div className="actions-toolbar">
          <span className="text-xs font-semibold text-kumo-subtle mr-1">Quick Actions:</span>
          <Button variant="outline" size="sm" onClick={handlePing} disabled={!connected}>
            <Lightning size={14} className="mr-1 text-amber-400" /> PING
          </Button>
          <Button variant="outline" size="sm" onClick={handleInfo} disabled={!connected}>
            INFO
          </Button>
          <Button variant="outline" size="sm" onClick={handleStatus} disabled={!connected}>
            STATUS
          </Button>
          <Button variant="outline" size="sm" onClick={handleToggleLed} disabled={!connected}>
            <Power size={14} className="mr-1 text-emerald-400" /> Toggle LED
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleScanWifi}
            disabled={!connected || scanning}
          >
            <WifiHigh size={14} className="mr-1 text-sky-400" />
            {scanning ? "Scanning APs..." : "Scan Wi-Fi"}
          </Button>
        </div>
      </section>

      {/* Main Tabbed Panel */}
      <section className="panel-card">
        <div className="panel-tabs-bar">
          <Tabs
            variant="segmented"
            tabs={[
              {
                value: "console",
                label: (
                  <span className="flex items-center gap-1.5">
                    <Terminal size={15} /> Console
                  </span>
                ),
              },
              {
                value: "wifi",
                label: (
                  <span className="flex items-center gap-1.5">
                    <WifiHigh size={15} /> Wi-Fi Setup
                  </span>
                ),
              },
              {
                value: "profiles",
                label: (
                  <span className="flex items-center gap-1.5">
                    <HardDrives size={15} /> Saved Profiles ({profiles.length})
                  </span>
                ),
              },
              {
                value: "devices",
                label: (
                  <span className="flex items-center gap-1.5">
                    <Cpu size={15} /> Devices ({devices.length})
                  </span>
                ),
              },
              {
                value: "history",
                label: (
                  <span className="flex items-center gap-1.5">
                    <ClockCounterClockwise size={15} /> History ({history.length})
                  </span>
                ),
              },
              {
                value: "settings",
                label: (
                  <span className="flex items-center gap-1.5">
                    <Gear size={15} /> Settings &amp; Help
                  </span>
                ),
              },
            ]}
            value={activeTab}
            onValueChange={setActiveTab}
          />
        </div>

        {/* Tab 1: Terminal Console */}
        {activeTab === "console" && (
          <div className="panel-body space-y-4">
            <div className="flex items-center justify-between text-xs text-kumo-subtle">
              <span>GATT Line Protocol Session · 240-byte MTU frame</span>
              <Button variant="ghost" size="xs" onClick={() => setLogs([])}>
                Clear Console
              </Button>
            </div>

            <div className="terminal-window">
              {logs.map((log) => (
                <div key={log.id} className="terminal-line">
                  <span className="terminal-time">[{log.time}]</span>
                  {log.dir === "tx" && <span className="terminal-prefix-tx">&gt;&gt;</span>}
                  {log.dir === "rx" && <span className="terminal-prefix-rx">&lt;&lt;</span>}
                  {log.dir === "sys" && <span className="terminal-prefix-sys">##</span>}
                  {log.dir === "err" && <span className="terminal-prefix-err">!!</span>}
                  <span className={`terminal-text-${log.dir}`}>{log.text}</span>
                </div>
              ))}
              <div ref={consoleBottomRef} />
            </div>

            <form onSubmit={handleManualCommandSubmit} className="flex gap-2">
              <Input
                value={commandInput}
                onChange={(e) => setCommandInput(e.target.value)}
                placeholder="Type command (e.g. PING, INFO, STATUS, LED ON, GPIO 48 1)..."
                className="font-mono text-sm flex-1"
                disabled={!connected}
              />
              <Button
                type="submit"
                variant="primary"
                disabled={!connected || !commandInput.trim()}
              >
                <PaperPlaneRight size={16} className="mr-1" /> Send
              </Button>
            </form>

            <div className="flex items-center gap-2 flex-wrap text-xs text-kumo-subtle pt-1">
              <span>Quick hints:</span>
              <button
                type="button"
                className="hover:text-kumo-default underline font-mono"
                onClick={() => setCommandInput("PING")}
              >
                PING
              </button>
              <button
                type="button"
                className="hover:text-kumo-default underline font-mono"
                onClick={() => setCommandInput("INFO")}
              >
                INFO
              </button>
              <button
                type="button"
                className="hover:text-kumo-default underline font-mono"
                onClick={() => setCommandInput("STATUS")}
              >
                STATUS
              </button>
              <button
                type="button"
                className="hover:text-kumo-default underline font-mono"
                onClick={() => setCommandInput("LED TOGGLE")}
              >
                LED TOGGLE
              </button>
              <button
                type="button"
                className="hover:text-kumo-default underline font-mono"
                onClick={() => setCommandInput("SCAN")}
              >
                SCAN
              </button>
            </div>
          </div>
        )}

        {/* Tab 2: Wi-Fi Setup */}
        {activeTab === "wifi" && (
          <div className="panel-body space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold">Over-The-Air Wi-Fi Provisioning</h3>
                <p className="text-xs text-kumo-subtle">
                  Scan for 2.4 GHz access points around the ESP32 and send credentials securely over
                  BLE.
                </p>
              </div>
              <Button
                variant="primary"
                onClick={handleScanWifi}
                disabled={!connected || scanning}
                className="flex items-center gap-1.5 shrink-0"
              >
                <ArrowClockwise size={16} className={scanning ? "animate-spin" : ""} />
                {scanning ? "Scanning Airwaves..." : "Scan Networks"}
              </Button>
            </div>

            {/* APs Table */}
            <div className="border border-kumo-hairline rounded-lg overflow-hidden">
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.Head>SSID</Table.Head>
                    <Table.Head>Signal (RSSI)</Table.Head>
                    <Table.Head>Channel</Table.Head>
                    <Table.Head>Security</Table.Head>
                    <Table.Head className="text-right">Action</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {scanResults.length === 0 ? (
                    <Table.Row>
                      <Table.Cell colSpan={5} className="text-center py-6 text-kumo-subtle">
                        {scanning
                          ? "Scanning for wireless networks around the ESP32..."
                          : "No networks scanned yet. Click 'Scan Networks' to discover nearby APs."}
                      </Table.Cell>
                    </Table.Row>
                  ) : (
                    scanResults.map((ap) => (
                      <Table.Row key={`${ap.ssid}-${ap.channel}`}>
                        <Table.Cell className="font-medium">
                          {ap.ssid || "<Hidden SSID>"}
                        </Table.Cell>
                        <Table.Cell className="font-mono text-xs">
                          {renderRssiBars(ap.rssi)}
                          {ap.rssi} dBm
                        </Table.Cell>
                        <Table.Cell className="font-mono text-xs">{ap.channel}</Table.Cell>
                        <Table.Cell className="text-xs">{ap.auth}</Table.Cell>
                        <Table.Cell className="text-right">
                          <Button
                            variant="outline"
                            size="xs"
                            onClick={() => {
                              setJoinSsid(ap.ssid);
                              addLog("sys", `Selected SSID '${ap.ssid}' in join form.`);
                            }}
                          >
                            Use SSID
                          </Button>
                        </Table.Cell>
                      </Table.Row>
                    ))
                  )}
                </Table.Body>
              </Table>
            </div>

            {/* Provision Form */}
            <div className="bg-kumo-base p-5 rounded-lg border border-kumo-hairline space-y-4">
              <h4 className="text-sm font-semibold flex items-center gap-2">
                <WifiHigh size={16} className="text-kumo-link" /> Join Wi-Fi Network
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs text-kumo-subtle">Network SSID</label>
                  <Input
                    value={joinSsid}
                    onChange={(e) => setJoinSsid(e.target.value)}
                    placeholder="Enter or select Wi-Fi SSID"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-kumo-subtle">Password</label>
                  <div className="flex gap-2">
                    <Input
                      type={showPass ? "text" : "password"}
                      value={joinPass}
                      onChange={(e) => setJoinPass(e.target.value)}
                      placeholder="WPA2/WPA3 pre-shared key"
                      className="flex-1"
                    />
                    <Button
                      variant="ghost"
                      type="button"
                      onClick={() => setShowPass(!showPass)}
                      className="px-2"
                    >
                      {showPass ? <EyeSlash size={16} /> : <Eye size={16} />}
                    </Button>
                  </div>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button
                  variant="primary"
                  onClick={handleJoinWifi}
                  disabled={!connected || !joinSsid || joining}
                >
                  <WifiHigh size={16} className="mr-1" />
                  {joining ? "Provisioning..." : "Provision & Connect"}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Tab 3: Saved Profiles (Stored in D1) */}
        {activeTab === "profiles" && (
          <div className="panel-body space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold">Cloudflare D1 Saved Profiles</h3>
                <p className="text-xs text-kumo-subtle">
                  Wi-Fi credentials saved in your anonymous Cloudflare D1 workspace.
                </p>
              </div>
            </div>

            <div className="border border-kumo-hairline rounded-lg overflow-hidden">
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.Head>SSID</Table.Head>
                    <Table.Head>Security</Table.Head>
                    <Table.Head>Usage Count</Table.Head>
                    <Table.Head>Last Used</Table.Head>
                    <Table.Head className="text-right">Actions</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {profiles.length === 0 ? (
                    <Table.Row>
                      <Table.Cell colSpan={5} className="text-center py-6 text-kumo-subtle">
                        No saved profiles in D1 yet. Add one below or join a network.
                      </Table.Cell>
                    </Table.Row>
                  ) : (
                    profiles.map((p) => (
                      <Table.Row key={p.id}>
                        <Table.Cell className="font-semibold">{p.ssid}</Table.Cell>
                        <Table.Cell className="text-xs">{p.security || "wpa2"}</Table.Cell>
                        <Table.Cell className="font-mono text-xs">{p.useCount}</Table.Cell>
                        <Table.Cell className="text-xs text-kumo-subtle">
                          {p.lastUsedAt ? new Date(p.lastUsedAt).toLocaleString() : "Never"}
                        </Table.Cell>
                        <Table.Cell className="text-right space-x-2">
                          <Button
                            variant="outline"
                            size="xs"
                            onClick={() => {
                              setJoinSsid(p.ssid);
                              setActiveTab("wifi");
                            }}
                          >
                            Apply to ESP32
                          </Button>
                          <Button
                            variant="destructive"
                            size="xs"
                            onClick={async () => {
                              await deleteWifiProfile(p.id);
                              setProfiles((prev) => prev.filter((x) => x.id !== p.id));
                            }}
                          >
                            <Trash size={12} />
                          </Button>
                        </Table.Cell>
                      </Table.Row>
                    ))
                  )}
                </Table.Body>
              </Table>
            </div>

            {/* Quick Add Profile */}
            <div className="bg-kumo-base p-4 rounded-lg border border-kumo-hairline space-y-3">
              <h4 className="text-sm font-semibold flex items-center gap-1">
                <Plus size={14} /> Add Network to Cloudflare D1
              </h4>
              <div className="flex flex-col sm:flex-row gap-3">
                <Input
                  value={newSsid}
                  onChange={(e) => setNewSsid(e.target.value)}
                  placeholder="SSID"
                  className="flex-1"
                />
                <Input
                  type="password"
                  value={newPass}
                  onChange={(e) => setNewPass(e.target.value)}
                  placeholder="Password"
                  className="flex-1"
                />
                <Button
                  variant="primary"
                  onClick={async () => {
                    if (!newSsid) return;
                    const saved = await saveWifiProfile({ ssid: newSsid, password: newPass });
                    setProfiles((prev) => [saved, ...prev]);
                    setNewSsid("");
                    setNewPass("");
                  }}
                  disabled={!newSsid}
                >
                  Save Profile
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Tab 4: Known Devices */}
        {activeTab === "devices" && (
          <div className="panel-body space-y-4">
            <h3 className="text-base font-semibold">Registered ESP32 Hardware</h3>
            <p className="text-xs text-kumo-subtle">
              Every connected board registers its MAC address and hardware specifications to D1.
            </p>

            <div className="border border-kumo-hairline rounded-lg overflow-hidden">
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.Head>Name</Table.Head>
                    <Table.Head>MAC Address</Table.Head>
                    <Table.Head>Chip</Table.Head>
                    <Table.Head>Firmware</Table.Head>
                    <Table.Head>Last Seen</Table.Head>
                    <Table.Head className="text-right">Action</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {devices.length === 0 ? (
                    <Table.Row>
                      <Table.Cell colSpan={6} className="text-center py-6 text-kumo-subtle">
                        No devices discovered yet. Connect an ESP32 over BLE to register it.
                      </Table.Cell>
                    </Table.Row>
                  ) : (
                    devices.map((d) => (
                      <Table.Row key={d.id}>
                        <Table.Cell className="font-medium">{d.name}</Table.Cell>
                        <Table.Cell className="font-mono text-xs text-kumo-link">{d.mac}</Table.Cell>
                        <Table.Cell className="font-mono text-xs">{d.chip || "esp32s3"}</Table.Cell>
                        <Table.Cell className="font-mono text-xs">{d.firmware || "0.1.0"}</Table.Cell>
                        <Table.Cell className="text-xs text-kumo-subtle">
                          {d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : "—"}
                        </Table.Cell>
                        <Table.Cell className="text-right">
                          <Button
                            variant="destructive"
                            size="xs"
                            onClick={async () => {
                              await deleteDevice(d.id);
                              setDevices((prev) => prev.filter((x) => x.id !== d.id));
                            }}
                          >
                            <Trash size={12} />
                          </Button>
                        </Table.Cell>
                      </Table.Row>
                    ))
                  )}
                </Table.Body>
              </Table>
            </div>
          </div>
        )}

        {/* Tab 5: Command History */}
        {activeTab === "history" && (
          <div className="panel-body space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold">Command Audit History</h3>
                <p className="text-xs text-kumo-subtle">
                  Persistent audit log of commands sent to hardware, backed by Cloudflare D1.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  await clearHistory();
                  setHistory([]);
                }}
                disabled={history.length === 0}
              >
                Clear History
              </Button>
            </div>

            <div className="border border-kumo-hairline rounded-lg overflow-hidden max-h-96 overflow-y-auto">
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.Head>Time</Table.Head>
                    <Table.Head>Direction</Table.Head>
                    <Table.Head>Command</Table.Head>
                    <Table.Head>Response</Table.Head>
                    <Table.Head className="text-right">Status</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {history.length === 0 ? (
                    <Table.Row>
                      <Table.Cell colSpan={5} className="text-center py-6 text-kumo-subtle">
                        No history entries recorded yet.
                      </Table.Cell>
                    </Table.Row>
                  ) : (
                    history.map((h) => (
                      <Table.Row key={h.id}>
                        <Table.Cell className="text-xs text-kumo-subtle">
                          {new Date(h.createdAt).toLocaleTimeString()}
                        </Table.Cell>
                        <Table.Cell>
                          <Badge variant="outline">{h.direction}</Badge>
                        </Table.Cell>
                        <Table.Cell className="font-mono text-xs text-cyan-400">
                          {h.command}
                        </Table.Cell>
                        <Table.Cell className="font-mono text-xs truncate max-w-xs">
                          {h.response || "—"}
                        </Table.Cell>
                        <Table.Cell className="text-right">
                          <Badge variant={h.ok ? "success" : "error"}>
                            {h.ok ? "OK" : "ERR"}
                          </Badge>
                        </Table.Cell>
                      </Table.Row>
                    ))
                  )}
                </Table.Body>
              </Table>
            </div>
          </div>
        )}

        {/* Tab 6: Settings & Help */}
        {activeTab === "settings" && (
          <div className="panel-body space-y-6">
            <h3 className="text-base font-semibold">Workspace Settings &amp; Troubleshooting</h3>

            <div className="bg-kumo-base p-4 rounded-lg border border-kumo-hairline space-y-2">
              <span className="text-xs text-kumo-subtle">Your Anonymous Workspace Identity</span>
              <p className="font-mono text-xs text-kumo-link break-all">{identity.id}</p>
              <p className="text-xs text-kumo-subtle">
                Every D1 database record is automatically partitioned by this UUID.
              </p>
            </div>

            <div className="bg-kumo-base p-4 rounded-lg border border-kumo-hairline space-y-3">
              <h4 className="text-sm font-semibold flex items-center gap-1.5">
                <ShieldCheck size={16} className="text-kumo-link" /> Web Bluetooth Troubleshooting
              </h4>
              <ul className="text-xs text-kumo-subtle space-y-1.5 list-disc list-inside">
                <li>
                  <strong>Supported Browsers:</strong> Google Chrome, Microsoft Edge, Opera on macOS,
                  Linux, Windows, and Android. Safari (iOS/macOS) does <em>not</em> implement Web
                  Bluetooth.
                </li>
                <li>
                  <strong>No OS Pairing:</strong> Do not use macOS System Settings to pair. Standard
                  BLE GATT servers only connect through browser tabs.
                </li>
                <li>
                  <strong>One Central at a Time:</strong> The ESP32 allows only 1 simultaneous
                  Bluetooth connection. Ensure no other script or tab is connected.
                </li>
                <li>
                  <strong>Device Discovery:</strong> If <code>esp32-remote</code> is not visible in
                  the chooser, check the <em>&quot;Show all Bluetooth devices&quot;</em> toggle above.
                </li>
              </ul>
            </div>

            <div className="pt-4 border-t border-kumo-hairline">
              <h4 className="text-sm font-semibold text-rose-400 mb-2">Danger Zone</h4>
              <p className="text-xs text-kumo-subtle mb-3">
                Wipe all saved devices, Wi-Fi profiles, and command history in this workspace.
              </p>
              <Button
                variant="destructive"
                onClick={async () => {
                  if (confirm("Are you sure you want to erase all data in this workspace?")) {
                    await resetWorkspace();
                    setDevices([]);
                    setProfiles([]);
                    setHistory([]);
                  }
                }}
              >
                Reset Workspace Data
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
