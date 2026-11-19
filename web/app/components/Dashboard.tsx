"use client";

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
  CheckCircle,
  XCircle,
  Eye,
  EyeSlash,
  PaperPlaneRight,
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
  type LedAction,
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
  // --- Bluetooth Connection State ---
  const [bluetoothSupported, setBluetoothSupported] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [activeTab, setActiveTab] = useState("console");

  // Device & Live State
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

  // GATT Handles
  const deviceRef = useRef<any>(null);
  const controlCharRef = useRef<any>(null);
  const statusCharRef = useRef<any>(null);

  // Command Waiter
  const pendingCommandRef = useRef<{
    command: string;
    resolve: (res: ParsedLine) => void;
    reject: (err: Error) => void;
    timer: any;
  } | null>(null);

  // --- Console Logs ---
  const [logs, setLogs] = useState<LogEntry[]>([
    {
      id: "init",
      time: new Date().toLocaleTimeString(),
      dir: "sys",
      text: "esp32-remote dashboard ready. Connect via Web Bluetooth above.",
    },
  ]);
  const [commandInput, setCommandInput] = useState("");
  const consoleBottomRef = useRef<HTMLDivElement>(null);

  // --- Wi-Fi Scanner ---
  const [scanning, setScanning] = useState(false);
  const [scanResults, setScanResults] = useState<DiscoveredAp[]>([]);
  const [joinSsid, setJoinSsid] = useState("");
  const [joinPass, setJoinPass] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [joining, setJoining] = useState(false);

  // --- Saved Profiles, Devices, History ---
  const [devices, setDevices] = useState<Device[]>(initialDevices);
  const [profiles, setProfiles] = useState<WifiProfile[]>(initialProfiles);
  const [history, setHistory] = useState<HistoryEntry[]>(initialHistory);

  // New Profile Form
  const [newSsid, setNewSsid] = useState("");
  const [newPass, setNewPass] = useState("");

  // Check Web Bluetooth support on mount
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

  // --- Line Parser & Event Dispatcher ---
  const handleIncomingLine = useCallback(
    (raw: string) => {
      const parsed = parseLine(raw);
      if (!parsed) return;

      const kind = classify(parsed);

      if (parsed.verb !== "AP") {
        addLog(parsed.verb === "ERR" ? "err" : "rx", parsed.raw);
      }

      // Check if this fulfills an in-flight command
      if (pendingCommandRef.current) {
        const { command, resolve, timer } = pendingCommandRef.current;
        const isFinal =
          parsed.verb === "ERR" ||
          (command === "SCAN" ? parsed.verb === "OK" && parsed.tail.startsWith("SCAN_DONE") : parsed.verb === "OK");

        if (isFinal) {
          clearTimeout(timer);
          pendingCommandRef.current = null;
          resolve(parsed);
        }
      }

      // Update state based on messages
      if (parsed.verb === "OK" && parsed.tail.startsWith("INFO")) {
        setDeviceInfo((prev) => ({
          ...prev,
          name: parsed.fields.name || prev.name,
          chip: parsed.fields.chip || prev.chip,
          fw: parsed.fields.fw || prev.fw,
          mac: parsed.fields.mac || prev.mac,
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

      if (parsed.verb === "OK" && parsed.tail.startsWith("LED")) {
        const val = parsed.tail.replace("LED ", "").trim();
        setDeviceInfo((prev) => ({ ...prev, led: val }));
      }

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
        addLog("sys", "Wi-Fi scan completed.");
      }
    },
    [addLog],
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

      // Log to database
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
      addLog("sys", "Disconnected from ESP32.");
      return;
    }

    setConnecting(true);
    addLog("sys", "Requesting Bluetooth device...");

    try {
      const device = await (navigator as any).bluetooth.requestDevice({
        filters: [{ namePrefix: DEVICE_NAME_PREFIX }],
        optionalServices: [SERVICE_UUID],
      });

      addLog("sys", `Connecting to GATT server on ${device.name || "ESP32"}...`);
      device.addEventListener("gattserverdisconnected", () => {
        setConnected(false);
        controlCharRef.current = null;
        statusCharRef.current = null;
        addLog("sys", "ESP32 disconnected.");
      });

      const server = await device.gatt.connect();
      addLog("sys", "Discovering primary service...");
      const service = await server.getPrimaryService(SERVICE_UUID);

      const control = await service.getCharacteristic(CONTROL_UUID);
      const statusChar = await service.getCharacteristic(STATUS_UUID);

      const onNotify = (event: any) => {
        const val = event.target.value;
        if (!val) return;
        const text = decodeValue(val);
        for (const line of text.split("\n")) {
          if (line.trim()) handleIncomingLine(line);
        }
      };

      control.addEventListener("characteristicvaluechanged", onNotify);
      statusChar.addEventListener("characteristicvaluechanged", onNotify);

      await control.startNotifications();
      await statusChar.startNotifications();

      deviceRef.current = device;
      controlCharRef.current = control;
      statusCharRef.current = statusChar;
      setConnected(true);
      addLog("sys", "Connected! Querying device information...");

      // Initial queries
      await sendBleCommand(commands.info());
      await sendBleCommand(commands.status());
    } catch (err: any) {
      if (err.name !== "NotFoundError") {
        addLog("err", `Connection failed: ${err.message}`);
      } else {
        addLog("sys", "Pairing dialog cancelled.");
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
      addLog("sys", `Wi-Fi join sequence completed.`);

      // Also persist to Saved Profiles
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

  return (
    <div className="min-h-screen bg-kumo-base text-kumo-default font-sans antialiased p-4 md:p-8 max-w-7xl mx-auto space-y-6">
      {/* Top Navbar */}
      <header className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-4 border-b border-kumo-fill">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-kumo-elevated border border-kumo-hairline flex items-center justify-center text-kumo-link shadow-sm">
            <Cpu size={24} weight="duotone" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold tracking-tight">esp32-remote</h1>
              <Badge variant="outline" className="text-xs">
                v0.2.0-kumo
              </Badge>
            </div>
            <p className="text-xs text-kumo-subtle">
              Web Bluetooth remote control &amp; Wi-Fi provisioning powered by Cloudflare
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <Badge
            variant={connected ? "success" : connecting ? "warning" : "neutral"}
            appearance="dot"
            className="text-xs font-mono"
          >
            {connected ? `Connected · ${deviceInfo.name}` : connecting ? "Connecting..." : "Disconnected"}
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
        <Banner variant="error">
          Web Bluetooth is not supported in this browser. Please open this page in Google Chrome,
          Microsoft Edge, or Opera on macOS, Linux, Windows, or Android. Note that iOS Safari does
          not support Web Bluetooth.
        </Banner>
      )}

      {/* Status Alert for BLE Pairing Note */}
      <Banner variant="secondary" className="text-xs">
        <strong>Bluetooth Note:</strong> Do NOT pair the ESP32 in macOS System Settings. Web Bluetooth
        connects directly inside this browser tab via the button above. The firmware uses an unbonded LE
        GATT server which requires no OS-level pin or pairing.
      </Banner>

      {/* Live Device Telemetry Card */}
      <section className="bg-kumo-elevated rounded-xl border border-kumo-hairline p-5 shadow-sm space-y-4">
        <div className="flex items-center justify-between border-b border-kumo-hairline pb-3">
          <div className="flex items-center gap-2">
            <Cpu size={18} className="text-kumo-link" />
            <h2 className="text-sm font-semibold uppercase tracking-wider text-kumo-subtle">
              Hardware Telemetry
            </h2>
          </div>
          <div className="flex items-center gap-2">
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
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
          <div className="space-y-1">
            <span className="text-xs text-kumo-subtle">Device Name</span>
            <p className="text-sm font-mono font-medium truncate">{deviceInfo.name}</p>
          </div>
          <div className="space-y-1">
            <span className="text-xs text-kumo-subtle">Chip / Model</span>
            <p className="text-sm font-mono font-medium">{deviceInfo.chip}</p>
          </div>
          <div className="space-y-1">
            <span className="text-xs text-kumo-subtle">Firmware</span>
            <p className="text-sm font-mono font-medium">{deviceInfo.fw}</p>
          </div>
          <div className="space-y-1">
            <span className="text-xs text-kumo-subtle">MAC Address</span>
            <p className="text-sm font-mono font-medium">{deviceInfo.mac}</p>
          </div>
          <div className="space-y-1">
            <span className="text-xs text-kumo-subtle">Wi-Fi Status</span>
            <div className="flex items-center gap-1.5">
              <span
                className={`w-2 h-2 rounded-full ${
                  deviceInfo.wifi === "up" ? "bg-emerald-500 animate-pulse" : "bg-neutral-500"
                }`}
              />
              <span className="text-sm font-mono font-medium">
                {deviceInfo.wifi === "up" ? deviceInfo.ip : "Disconnected"}
              </span>
            </div>
          </div>
          <div className="space-y-1">
            <span className="text-xs text-kumo-subtle">Status LED</span>
            <Badge variant={deviceInfo.led === "1" ? "success" : "neutral"}>
              {deviceInfo.led === "1" ? "ON" : "OFF"}
            </Badge>
          </div>
        </div>

        {/* Quick Actions Row */}
        <div className="pt-2 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-kumo-subtle mr-2">Quick Actions:</span>
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
            Toggle LED
          </Button>
          <Button variant="outline" size="sm" onClick={handleScanWifi} disabled={!connected || scanning}>
            <WifiHigh size={14} className="mr-1 text-sky-400" />
            {scanning ? "Scanning APs..." : "Scan Wi-Fi"}
          </Button>
        </div>
      </section>

      {/* Main Tabs Navigation */}
      <section className="bg-kumo-elevated rounded-xl border border-kumo-hairline overflow-hidden shadow-sm">
        <div className="p-3 border-b border-kumo-hairline bg-kumo-base">
          <Tabs
            variant="segmented"
            tabs={[
              { value: "console", label: <span className="flex items-center gap-1.5"><Terminal size={15} /> Console</span> },
              { value: "wifi", label: <span className="flex items-center gap-1.5"><WifiHigh size={15} /> Wi-Fi Setup</span> },
              { value: "profiles", label: <span className="flex items-center gap-1.5"><HardDrives size={15} /> Saved Profiles ({profiles.length})</span> },
              { value: "devices", label: <span className="flex items-center gap-1.5"><Cpu size={15} /> Devices ({devices.length})</span> },
              { value: "history", label: <span className="flex items-center gap-1.5"><ClockCounterClockwise size={15} /> History ({history.length})</span> },
              { value: "settings", label: <span className="flex items-center gap-1.5"><Gear size={15} /> Settings</span> },
            ]}
            value={activeTab}
            onValueChange={setActiveTab}
          />
        </div>

        {/* Tab 1: Terminal Console */}
        {activeTab === "console" && (
          <div className="p-4 space-y-4">
            <div className="flex items-center justify-between text-xs text-kumo-subtle">
              <span>Interactive GATT Line Protocol Session</span>
              <Button variant="ghost" size="xs" onClick={() => setLogs([])}>
                Clear Console
              </Button>
            </div>

            <div className="bg-neutral-950 text-neutral-100 rounded-lg p-4 font-mono text-xs h-80 overflow-y-auto space-y-1 border border-neutral-800">
              {logs.map((log) => (
                <div key={log.id} className="flex items-start gap-2 leading-relaxed">
                  <span className="text-neutral-500 select-none">[{log.time}]</span>
                  {log.dir === "tx" && <span className="text-cyan-400 font-bold select-none">&gt;&gt;</span>}
                  {log.dir === "rx" && <span className="text-emerald-400 font-bold select-none">&lt;&lt;</span>}
                  {log.dir === "sys" && <span className="text-purple-400 font-bold select-none">##</span>}
                  {log.dir === "err" && <span className="text-rose-400 font-bold select-none">!!</span>}
                  <span
                    className={
                      log.dir === "err"
                        ? "text-rose-300"
                        : log.dir === "tx"
                          ? "text-cyan-200"
                          : log.dir === "rx"
                            ? "text-emerald-200"
                            : "text-neutral-400"
                    }
                  >
                    {log.text}
                  </span>
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
              <Button type="submit" variant="primary" disabled={!connected || !commandInput.trim()}>
                <PaperPlaneRight size={16} className="mr-1" /> Send
              </Button>
            </form>
          </div>
        )}

        {/* Tab 2: Wi-Fi Scanner & Provisioning */}
        {activeTab === "wifi" && (
          <div className="p-5 space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold">Over-The-Air Wi-Fi Provisioning</h3>
                <p className="text-xs text-kumo-subtle">
                  Scan for 2.4 GHz access points around the ESP32 and send credentials securely over BLE.
                </p>
              </div>
              <Button
                variant="primary"
                onClick={handleScanWifi}
                disabled={!connected || scanning}
                className="flex items-center gap-1.5"
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
                        <Table.Cell className="font-medium">{ap.ssid || "<Hidden SSID>"}</Table.Cell>
                        <Table.Cell className="font-mono text-xs">
                          <span
                            className={
                              ap.rssi > -60
                                ? "text-emerald-500"
                                : ap.rssi > -75
                                  ? "text-amber-500"
                                  : "text-rose-500"
                            }
                          >
                            {ap.rssi} dBm
                          </span>
                        </Table.Cell>
                        <Table.Cell className="font-mono text-xs">{ap.channel}</Table.Cell>
                        <Table.Cell className="text-xs">{ap.auth}</Table.Cell>
                        <Table.Cell className="text-right">
                          <Button
                            variant="outline"
                            size="xs"
                            onClick={() => setJoinSsid(ap.ssid)}
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
              <h4 className="text-sm font-semibold">Join Network</h4>
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
          <div className="p-5 space-y-6">
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
          <div className="p-5 space-y-4">
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
          <div className="p-5 space-y-4">
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
                          <Badge variant="outline">
                            {h.direction}
                          </Badge>
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

        {/* Tab 6: Settings */}
        {activeTab === "settings" && (
          <div className="p-5 space-y-6">
            <h3 className="text-base font-semibold">Workspace Settings</h3>

            <div className="bg-kumo-base p-4 rounded-lg border border-kumo-hairline space-y-2">
              <span className="text-xs text-kumo-subtle">Your Anonymous Workspace Identity</span>
              <p className="font-mono text-xs text-kumo-link break-all">{identity.id}</p>
              <p className="text-xs text-kumo-subtle">
                Every D1 database record is automatically partitioned by this UUID.
              </p>
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
