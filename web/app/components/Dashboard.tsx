"use client";

import "@cloudflare/kumo/styles/standalone";
import "../globals.css";

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  CloudflareLogo,
  Badge,
  Button,
  Input,
  Banner,
} from "@cloudflare/kumo";
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
  SlidersHorizontal,
  MagnifyingGlass,
  ArrowSquareOut,
  Bell,
  Question,
  UserCircle,
  CaretDown,
  Sun,
  Moon,
  Desktop,
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
  // --- Theme State & System Sync ---
  const [theme, setTheme] = useState<"system" | "light" | "dark">("dark");
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("dark");

  useEffect(() => {
    const stored = localStorage.getItem("color-scheme") as "light" | "dark" | null;
    if (stored === "light" || stored === "dark") {
      setTheme(stored);
      setResolvedTheme(stored);
      document.documentElement.setAttribute("data-theme", stored);
    } else {
      setTheme("system");
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      setResolvedTheme(prefersDark ? "dark" : "light");
      document.documentElement.setAttribute("data-theme", prefersDark ? "dark" : "light");
    }

    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handleMqlChange = (e: MediaQueryListEvent) => {
      const currentStored = localStorage.getItem("color-scheme");
      if (!currentStored) {
        const next = e.matches ? "dark" : "light";
        setResolvedTheme(next);
        document.documentElement.setAttribute("data-theme", next);
      }
    };
    mql.addEventListener("change", handleMqlChange);

    const handleStorage = (e: StorageEvent) => {
      if (e.key === "color-scheme") {
        const val = e.newValue as "light" | "dark" | null;
        if (val) {
          setTheme(val);
          setResolvedTheme(val);
          document.documentElement.setAttribute("data-theme", val);
        } else {
          setTheme("system");
          const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
          const next = prefersDark ? "dark" : "light";
          setResolvedTheme(next);
          document.documentElement.setAttribute("data-theme", next);
        }
      }
    };
    window.addEventListener("storage", handleStorage);

    return () => {
      mql.removeEventListener("change", handleMqlChange);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const toggleTheme = (target?: "light" | "dark" | "system") => {
    let next: "light" | "dark" | "system";
    if (target) {
      next = target;
    } else {
      next = resolvedTheme === "dark" ? "light" : "dark";
    }

    setTheme(next);
    const meta = document.querySelector('meta[name="color-scheme"]') as HTMLMetaElement | null;

    if (next === "system") {
      localStorage.removeItem("color-scheme");
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      const res = prefersDark ? "dark" : "light";
      setResolvedTheme(res);
      document.documentElement.setAttribute("data-theme", res);
      if (meta) meta.content = "light dark";
    } else {
      localStorage.setItem("color-scheme", next);
      setResolvedTheme(next);
      document.documentElement.setAttribute("data-theme", next);
      if (meta) meta.content = next;
    }
  };

  // --- Navigation & Core State ---
  const [activeTab, setActiveTab] = useState<
    "overview" | "console" | "gpio" | "wifi" | "profiles" | "devices" | "history" | "settings"
  >("overview");
  const [bluetoothSupported, setBluetoothSupported] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [acceptAllDevices, setAcceptAllDevices] = useState(false);

  // Device & Telemetry State
  const [deviceInfo, setDeviceInfo] = useState({
    name: "esp32-remote",
    chip: "esp32s3",
    fw: "v0.1.0",
    mac: "—",
    wifi: "down",
    ip: "—",
    ssid: "",
    rssi: "—",
    led: "0",
  });

  // Pin Output State (GPIO pins 2, 4, 18, 19, 21, 22, 23)
  const [pinStates, setPinStates] = useState<Record<number, boolean>>({
    2: false,
    4: false,
    18: false,
    19: false,
    21: false,
    22: false,
    23: false,
  });
  const [customPin, setCustomPin] = useState("2");
  const [customLevel, setCustomLevel] = useState("1");

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
      text: "Cloudflare Web Bluetooth dashboard initialized. Ready to connect to ESP32-S3.",
    },
  ]);
  const [commandInput, setCommandInput] = useState("");
  const [logFilter, setLogFilter] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
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
  const [historySearch, setHistorySearch] = useState("");

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
    if (autoScroll) {
      consoleBottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs, autoScroll]);

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

      // Handle GPIO state update
      if (parsed.verb === "OK" && parsed.tail.startsWith("GPIO")) {
        const parts = parsed.tail.split(/\s+/);
        const pin = Number(parts[1]);
        const lvl = parts[2] === "1";
        if (!isNaN(pin)) {
          setPinStates((prev) => ({ ...prev, [pin]: lvl }));
        }
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
      addLog("sys", "Accessing primary GATT service 937312e0...");
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
      addLog("sys", "Connected! Bi-directional GATT session active.");

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

  const handleSetGpio = async (pin: number, level: boolean) => {
    try {
      await sendBleCommand(commands.gpio(pin, level));
      setPinStates((prev) => ({ ...prev, [pin]: level }));
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

      // Persist to Saved Profiles in D1
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

  const filteredLogs = useMemo(() => {
    if (!logFilter.trim()) return logs;
    const q = logFilter.toLowerCase();
    return logs.filter((l) => l.text.toLowerCase().includes(q) || l.dir.includes(q));
  }, [logs, logFilter]);

  const filteredHistory = useMemo(() => {
    if (!historySearch.trim()) return history;
    const q = historySearch.toLowerCase();
    return history.filter(
      (h) =>
        h.command.toLowerCase().includes(q) ||
        (h.response && h.response.toLowerCase().includes(q)),
    );
  }, [history, historySearch]);

  return (
    <div className="min-h-screen bg-[var(--cf-bg)] text-[var(--cf-text)] flex flex-col">
      {/* ====================================================================
          1. Cloudflare Global Header Navbar
          ==================================================================== */}
      <header className="cf-global-nav">
        <div className="cf-logo-wrapper">
          <div className="flex items-center gap-2 cursor-pointer">
            <CloudflareLogo variant="full" className="h-5 text-[var(--cf-text-strong)]" />
          </div>

          <span className="text-[var(--cf-border-strong)]">|</span>

          <div className="cf-account-pill">
            <span>unesp32&#39;s Account</span>
            <CaretDown size={12} className="text-[var(--cf-text-muted)]" />
          </div>
        </div>

        {/* Global Search Bar (Cloudflare ⌘K) */}
        <div className="cf-search-box">
          <MagnifyingGlass size={15} />
          <span>Search or jump to...</span>
          <span className="cf-search-kbd">⌘K</span>
        </div>

        {/* System Status & Profile Avatar */}
        <div className="flex items-center gap-4">
          <a
            href="https://www.cloudflarestatus.com"
            target="_blank"
            rel="noreferrer"
            className="hidden sm:flex items-center gap-2 text-xs text-[var(--cf-text-muted)] hover:text-white transition-colors"
          >
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span>All Systems Operational</span>
          </a>

          <div className="flex items-center gap-2 text-[var(--cf-text-muted)]">
            <button
              onClick={() => toggleTheme()}
              className="p-1.5 hover:text-[var(--cf-text-strong)] hover:bg-[var(--cf-inset)] rounded transition-all text-[var(--cf-text-muted)]"
              title={`Switch to ${resolvedTheme === "dark" ? "light" : "dark"} theme (currently ${theme})`}
              aria-label={`Switch theme (currently ${theme})`}
            >
              {resolvedTheme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <button
              className="p-1.5 hover:text-[var(--cf-text-strong)] hover:bg-[var(--cf-inset)] rounded transition-all"
              title="Documentation"
            >
              <Question size={18} />
            </button>
            <button
              className="p-1.5 hover:text-[var(--cf-text-strong)] hover:bg-[var(--cf-inset)] rounded transition-all relative"
              title="Notifications"
            >
              <Bell size={18} />
              <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-[var(--cf-orange)]" />
            </button>
            <div
              className="w-7 h-7 rounded-full bg-[var(--cf-border-strong)] flex items-center justify-center font-bold text-xs text-[var(--cf-text-strong)] border border-[var(--cf-border)]"
              title="User Amit"
            >
              AM
            </div>
          </div>
        </div>
      </header>

      {/* ====================================================================
          2. Cloudflare Zone / Worker Sub-Header
          ==================================================================== */}
      <section className="cf-sub-nav">
        {/* Breadcrumb Trail */}
        <div className="cf-breadcrumbs">
          <a href="#" className="cf-breadcrumb-link">
            Home
          </a>
          <span>/</span>
          <a href="#" className="cf-breadcrumb-link">
            Workers &amp; Pages
          </a>
          <span>/</span>
          <span className="text-[var(--cf-text-strong)] font-semibold">esp32-remote</span>
          <span>/</span>
          <span className="text-[var(--cf-text-muted)]">Dashboard</span>
        </div>

        {/* Project Header Row */}
        <div className="cf-project-header">
          <div className="cf-project-title-row">
            <div className="cf-product-icon">
              <Cpu size={24} weight="fill" />
            </div>

            <div>
              <h1 className="cf-project-title">
                esp32-remote
                <Badge variant="neutral" className="text-xs font-mono">
                  v0.2.0-kumo
                </Badge>
              </h1>
              <a
                href="https://esp.virt.cc.cd"
                target="_blank"
                rel="noreferrer"
                className="cf-domain-link"
              >
                <span>esp.virt.cc.cd</span>
                <ArrowSquareOut size={12} />
              </a>
            </div>

            <div className="hidden lg:flex items-center gap-2 ml-4">
              <Badge variant="success" appearance="dot">
                Production
              </Badge>
              <Badge variant="neutral">ESP32-S3</Badge>
              <Badge variant="neutral">Cloudflare D1</Badge>
            </div>
          </div>

          {/* Connect Action Controls */}
          <div className="flex items-center gap-3 flex-wrap">
            <Badge
              variant={connected ? "success" : connecting ? "warning" : "neutral"}
              appearance="dot"
              className="font-mono text-xs"
            >
              {connected
                ? `Connected · ${deviceInfo.name}`
                : connecting
                  ? "Pairing..."
                  : "Disconnected"}
            </Badge>

            <label className="inline-flex items-center gap-1.5 cursor-pointer text-xs text-[var(--cf-text-muted)] hover:text-white">
              <input
                type="checkbox"
                checked={acceptAllDevices}
                onChange={(e) => setAcceptAllDevices(e.target.checked)}
                className="rounded accent-[var(--cf-orange)]"
              />
              <span>Show all devices</span>
            </label>

            <Button
              onClick={handleConnect}
              disabled={connecting || !bluetoothSupported}
              className={
                connected
                  ? "!bg-red-600 hover:!bg-red-700 !text-white !font-semibold"
                  : "cf-btn-orange"
              }
            >
              <Bluetooth size={16} weight="bold" className="mr-1.5" />
              {connected ? "Disconnect" : connecting ? "Pairing..." : "Connect ESP32"}
            </Button>
          </div>
        </div>

        {/* Horizontal Navigation Tabs */}
        <nav className="cf-tabs-container">
          <button
            onClick={() => setActiveTab("overview")}
            className={`cf-tab-button ${activeTab === "overview" ? "active" : ""}`}
          >
            <Broadcast size={15} />
            <span>Overview</span>
          </button>

          <button
            onClick={() => setActiveTab("console")}
            className={`cf-tab-button ${activeTab === "console" ? "active" : ""}`}
          >
            <Terminal size={15} />
            <span>Real-time Logs</span>
            <span className="cf-tab-count">{logs.length}</span>
          </button>

          <button
            onClick={() => setActiveTab("gpio")}
            className={`cf-tab-button ${activeTab === "gpio" ? "active" : ""}`}
          >
            <SlidersHorizontal size={15} />
            <span>Control &amp; GPIO</span>
          </button>

          <button
            onClick={() => setActiveTab("wifi")}
            className={`cf-tab-button ${activeTab === "wifi" ? "active" : ""}`}
          >
            <WifiHigh size={15} />
            <span>Wi-Fi Provisioning</span>
            {scanResults.length > 0 && <span className="cf-tab-count">{scanResults.length}</span>}
          </button>

          <button
            onClick={() => setActiveTab("profiles")}
            className={`cf-tab-button ${activeTab === "profiles" ? "active" : ""}`}
          >
            <HardDrives size={15} />
            <span>Saved Profiles</span>
            <span className="cf-tab-count">{profiles.length}</span>
          </button>

          <button
            onClick={() => setActiveTab("devices")}
            className={`cf-tab-button ${activeTab === "devices" ? "active" : ""}`}
          >
            <Cpu size={15} />
            <span>Devices</span>
            <span className="cf-tab-count">{devices.length}</span>
          </button>

          <button
            onClick={() => setActiveTab("history")}
            className={`cf-tab-button ${activeTab === "history" ? "active" : ""}`}
          >
            <ClockCounterClockwise size={15} />
            <span>Audit History</span>
            <span className="cf-tab-count">{history.length}</span>
          </button>

          <button
            onClick={() => setActiveTab("settings")}
            className={`cf-tab-button ${activeTab === "settings" ? "active" : ""}`}
          >
            <Gear size={15} />
            <span>Settings</span>
          </button>
        </nav>
      </section>

      {/* ====================================================================
          3. Main Content Body
          ==================================================================== */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6">
        {/* Browser Warning */}
        {!bluetoothSupported && (
          <div className="mb-6">
            <Banner variant="error" title="Web Bluetooth Unsupported">
              Web Bluetooth is not supported in this browser. Please open this page in Google
              Chrome, Microsoft Edge, or Opera on macOS, Windows, Linux, or Android. (Note that iOS
              Safari does not support Web Bluetooth).
            </Banner>
          </div>
        )}

        {/* ==================================================================
            TAB 1: Overview
            ================================================================== */}
        {activeTab === "overview" && (
          <div className="space-y-6">
            {/* Cloudflare Analytics Metric Cards */}
            <div className="cf-metrics-grid">
              <div className={`cf-metric-card ${connected ? "highlight" : ""}`}>
                <div className="cf-metric-label">
                  <Bluetooth size={14} className="text-[var(--cf-orange)]" />
                  <span>BLE Link</span>
                </div>
                <div className="cf-metric-value">
                  {connected ? (
                    <span className="text-emerald-400">CONNECTED</span>
                  ) : (
                    <span className="text-[var(--cf-text-faint)]">OFFLINE</span>
                  )}
                </div>
                <div className="cf-metric-subtext">MTU 240B · Unbonded GATT</div>
              </div>

              <div className="cf-metric-card">
                <div className="cf-metric-label">
                  <Broadcast size={14} className="text-sky-400" />
                  <span>Signal (RSSI)</span>
                </div>
                <div className="cf-metric-value flex items-center gap-1.5">
                  {connected && deviceInfo.rssi !== "—" ? (
                    <>
                      {renderRssiBars(Number(deviceInfo.rssi))}
                      <span>{deviceInfo.rssi} dBm</span>
                    </>
                  ) : (
                    <span>—</span>
                  )}
                </div>
                <div className="cf-metric-subtext">Direct 2.4GHz Radio Link</div>
              </div>

              <div className="cf-metric-card">
                <div className="cf-metric-label">
                  <WifiHigh size={14} className="text-emerald-400" />
                  <span>Wi-Fi Link</span>
                </div>
                <div className="cf-metric-value">
                  {deviceInfo.wifi === "up" ? (
                    <span className="text-emerald-400 text-sm">{deviceInfo.ip}</span>
                  ) : (
                    <span className="text-[var(--cf-text-muted)]">STANDBY</span>
                  )}
                </div>
                <div className="cf-metric-subtext truncate">
                  {deviceInfo.wifi === "up" ? `SSID: ${deviceInfo.ssid}` : "Station mode ready"}
                </div>
              </div>

              <div className="cf-metric-card">
                <div className="cf-metric-label">
                  <Cpu size={14} className="text-purple-400" />
                  <span>Hardware</span>
                </div>
                <div className="cf-metric-value">{deviceInfo.chip.toUpperCase()}</div>
                <div className="cf-metric-subtext">Xtensa Dual-Core · 16MB Flash</div>
              </div>

              <div className="cf-metric-card">
                <div className="cf-metric-label">
                  <ShieldCheck size={14} className="text-amber-400" />
                  <span>Firmware</span>
                </div>
                <div className="cf-metric-value">{deviceInfo.fw}</div>
                <div className="cf-metric-subtext">Embassy + Trouble BLE</div>
              </div>

              <div className="cf-metric-card">
                <div className="cf-metric-label">
                  <HardDrives size={14} className="text-cyan-400" />
                  <span>Edge D1 Logs</span>
                </div>
                <div className="cf-metric-value">{history.length}</div>
                <div className="cf-metric-subtext">Synced to Cloudflare edge</div>
              </div>
            </div>

            {/* Status Guidance Banner */}
            {!connected ? (
              <Banner variant="secondary" title="Web Bluetooth Connection Guide">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs">
                  <span>
                    Click the <strong>Connect ESP32</strong> button in the top navigation bar,
                    select <code>esp32-remote</code> in the browser popup, and click Pair. Your
                    browser will communicate directly with the ESP32-S3 over low-energy GATT without
                    any native app install.
                  </span>
                  <Button
                    onClick={handleConnect}
                    size="sm"
                    className="cf-btn-orange shrink-0 text-xs"
                  >
                    Connect Now
                  </Button>
                </div>
              </Banner>
            ) : (
              <Banner variant="default" title="Active GATT Session">
                <div className="text-xs">
                  Connected to peripheral <strong>{deviceInfo.name}</strong> (MAC:{" "}
                  <code>{deviceInfo.mac}</code>). Bi-directional ASCII line-protocol channel
                  established over characteristic <code>937312e1</code>.
                </div>
              </Banner>
            )}

            {/* Quick Actions Card */}
            <div className="cf-card">
              <div className="cf-card-header">
                <div>
                  <div className="cf-card-title">
                    <Lightning size={16} className="text-[var(--cf-orange)]" />
                    <span>Quick Diagnostics &amp; Controls</span>
                  </div>
                  <div className="cf-card-desc">
                    Send one-touch telemetry probes and peripheral toggles over Bluetooth.
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleStatus}
                    disabled={!connected}
                    className="cf-btn-ghost"
                  >
                    <ArrowClockwise size={13} className="mr-1" /> Refresh
                  </Button>
                </div>
              </div>

              <div className="cf-card-body flex flex-wrap gap-2.5">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePing}
                  disabled={!connected}
                  className="cf-btn-ghost"
                >
                  <Lightning size={14} className="text-amber-400 mr-1.5" /> PING
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleInfo}
                  disabled={!connected}
                  className="cf-btn-ghost"
                >
                  <Cpu size={14} className="text-sky-400 mr-1.5" /> INFO
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleStatus}
                  disabled={!connected}
                  className="cf-btn-ghost"
                >
                  <Broadcast size={14} className="text-emerald-400 mr-1.5" /> STATUS
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleToggleLed}
                  disabled={!connected}
                  className="cf-btn-ghost"
                >
                  <Power size={14} className="text-purple-400 mr-1.5" /> Toggle Status LED
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleScanWifi}
                  disabled={!connected || scanning}
                  className="cf-btn-ghost"
                >
                  <WifiHigh size={14} className="text-cyan-400 mr-1.5" />
                  {scanning ? "Scanning APs..." : "Scan Wi-Fi"}
                </Button>
              </div>
            </div>

            {/* Hardware & Cloudflare Edge Details */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="cf-card">
                <div className="cf-card-header">
                  <div className="cf-card-title">
                    <Broadcast size={16} className="text-[var(--cf-orange)]" />
                    <span>BLE GATT Specification</span>
                  </div>
                </div>
                <div className="cf-card-body p-0">
                  <table className="cf-table">
                    <tbody>
                      <tr>
                        <td className="font-semibold text-xs text-[var(--cf-text-faint)]">
                          Service UUID
                        </td>
                        <td className="font-mono text-xs text-sky-400">{SERVICE_UUID}</td>
                      </tr>
                      <tr>
                        <td className="font-semibold text-xs text-[var(--cf-text-faint)]">
                          Control Characteristic
                        </td>
                        <td className="font-mono text-xs text-emerald-400">{CONTROL_UUID}</td>
                      </tr>
                      <tr>
                        <td className="font-semibold text-xs text-[var(--cf-text-faint)]">
                          Status Characteristic
                        </td>
                        <td className="font-mono text-xs text-purple-400">{STATUS_UUID}</td>
                      </tr>
                      <tr>
                        <td className="font-semibold text-xs text-[var(--cf-text-faint)]">
                          Device Name Filter
                        </td>
                        <td className="font-mono text-xs">{DEVICE_NAME_PREFIX}*</td>
                      </tr>
                      <tr>
                        <td className="font-semibold text-xs text-[var(--cf-text-faint)]">
                          Max ATT Line Length
                        </td>
                        <td className="font-mono text-xs">240 bytes</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="cf-card">
                <div className="cf-card-header">
                  <div className="cf-card-title">
                    <CloudflareLogo variant="glyph" className="h-4 text-[var(--cf-orange)]" />
                    <span>Cloudflare Edge Context</span>
                  </div>
                </div>
                <div className="cf-card-body p-0">
                  <table className="cf-table">
                    <tbody>
                      <tr>
                        <td className="font-semibold text-xs text-[var(--cf-text-faint)]">
                          Runtime Engine
                        </td>
                        <td className="text-xs">Cloudflare Workers + Vinext RSC</td>
                      </tr>
                      <tr>
                        <td className="font-semibold text-xs text-[var(--cf-text-faint)]">
                          D1 Binding
                        </td>
                        <td className="font-mono text-xs text-emerald-400">env.DB</td>
                      </tr>
                      <tr>
                        <td className="font-semibold text-xs text-[var(--cf-text-faint)]">
                          Client Identity
                        </td>
                        <td className="font-mono text-xs truncate max-w-[200px]">
                          {identity.id}
                        </td>
                      </tr>
                      <tr>
                        <td className="font-semibold text-xs text-[var(--cf-text-faint)]">
                          Identity Cookie
                        </td>
                        <td className="font-mono text-xs">esp_id (HttpOnly, Secure)</td>
                      </tr>
                      <tr>
                        <td className="font-semibold text-xs text-[var(--cf-text-faint)]">
                          Custom Domain
                        </td>
                        <td className="font-mono text-xs text-sky-400">esp.virt.cc.cd</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ==================================================================
            TAB 2: Real-time Logs (Cloudflare Workers Tail style)
            ================================================================== */}
        {activeTab === "console" && (
          <div className="cf-card">
            <div className="cf-card-header">
              <div>
                <div className="cf-card-title">
                  <Terminal size={16} className="text-[var(--cf-orange)]" />
                  <span>Real-time Execution &amp; GATT Stream</span>
                </div>
                <div className="cf-card-desc">
                  Cloudflare Workers Tail streaming protocol window · 240-byte MTU frame
                </div>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <div className="relative">
                  <input
                    type="text"
                    value={logFilter}
                    onChange={(e) => setLogFilter(e.target.value)}
                    placeholder="Filter logs..."
                    className="bg-[var(--cf-inset)] border border-[var(--cf-border)] rounded px-2.5 py-1 text-xs text-[var(--cf-text)] placeholder-[var(--cf-text-faint)] w-40 focus:outline-none focus:border-[var(--cf-orange)]"
                  />
                  {logFilter && (
                    <button
                      onClick={() => setLogFilter("")}
                      className="absolute right-2 top-1.5 text-xs text-[var(--cf-text-faint)] hover:text-white"
                    >
                      ×
                    </button>
                  )}
                </div>

                <label className="inline-flex items-center gap-1.5 text-xs text-[var(--cf-text-muted)] cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={autoScroll}
                    onChange={(e) => setAutoScroll(e.target.checked)}
                    className="rounded accent-[var(--cf-orange)]"
                  />
                  <span>Autoscroll</span>
                </label>

                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setLogs([])}
                  className="cf-btn-ghost text-xs"
                >
                  <Trash size={13} className="mr-1" /> Clear
                </Button>
              </div>
            </div>

            <div className="cf-tail-terminal">
              <div className="cf-tail-header">
                <span>
                  STREAMING LOGS ({filteredLogs.length} events
                  {logFilter ? ` matching "${logFilter}"` : ""})
                </span>
                <span className="text-[var(--cf-text-faint)]">PROTOCOL: ASCII \n TERMINATED</span>
              </div>

              <div className="cf-tail-scroll">
                {filteredLogs.map((log) => (
                  <div key={log.id} className="cf-log-row">
                    <span className="cf-log-time">[{log.time}]</span>
                    {log.dir === "tx" && <span className="cf-tag cf-tag-tx">TX</span>}
                    {log.dir === "rx" && <span className="cf-tag cf-tag-rx">RX</span>}
                    {log.dir === "sys" && <span className="cf-tag cf-tag-sys">SYS</span>}
                    {log.dir === "err" && <span className="cf-tag cf-tag-err">ERR</span>}
                    <span className="cf-log-msg">{log.text}</span>
                  </div>
                ))}
                <div ref={consoleBottomRef} />
              </div>
            </div>

            {/* Command Prompt Bar */}
            <form onSubmit={handleManualCommandSubmit} className="cf-card-footer gap-3">
              <div className="flex-1 relative">
                <input
                  type="text"
                  value={commandInput}
                  onChange={(e) => setCommandInput(e.target.value)}
                  placeholder={
                    connected
                      ? "Send command (e.g. PING, INFO, STATUS, LED TOGGLE, GPIO 2 1)..."
                      : "Connect Bluetooth to send commands..."
                  }
                  disabled={!connected}
                  className="w-full bg-[var(--cf-card-bg)] border border-[var(--cf-border-strong)] rounded-lg px-3 py-2 text-xs font-mono text-white placeholder-[var(--cf-text-faint)] focus:outline-none focus:border-[var(--cf-orange)]"
                />
              </div>
              <Button
                type="submit"
                disabled={!connected || !commandInput.trim()}
                className="cf-btn-orange text-xs"
              >
                <PaperPlaneRight size={14} className="mr-1" /> Send
              </Button>
            </form>
          </div>
        )}

        {/* ==================================================================
            TAB 3: Control & GPIO Peripherals
            ================================================================== */}
        {activeTab === "gpio" && (
          <div className="space-y-6">
            {/* Status LED Card */}
            <div className="cf-card">
              <div className="cf-card-header">
                <div>
                  <div className="cf-card-title">
                    <Power size={16} className="text-purple-400" />
                    <span>Onboard Status LED (GPIO 48)</span>
                  </div>
                  <div className="cf-card-desc">
                    Hardware status indicator running on the ESP32-S3 microcontroller.
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <Badge variant={deviceInfo.led === "1" ? "success" : "neutral"}>
                    {deviceInfo.led === "1" ? "STATE: ON" : "STATE: OFF"}
                  </Badge>
                  <Button
                    onClick={handleToggleLed}
                    disabled={!connected}
                    className="cf-btn-orange text-xs"
                  >
                    Toggle LED
                  </Button>
                </div>
              </div>
            </div>

            {/* Configurable Digital Outputs */}
            <div className="cf-card">
              <div className="cf-card-header">
                <div>
                  <div className="cf-card-title">
                    <SlidersHorizontal size={16} className="text-[var(--cf-orange)]" />
                    <span>Digital Output Pins (GPIO)</span>
                  </div>
                  <div className="cf-card-desc">
                    Trigger logic levels on physical ESP32 header pins over GATT line protocol.
                  </div>
                </div>
              </div>

              <div className="cf-card-body">
                <div className="cf-gpio-grid">
                  {[2, 4, 18, 19, 21, 22, 23].map((pin) => {
                    const isHigh = pinStates[pin] || false;
                    return (
                      <div
                        key={pin}
                        className={`cf-gpio-card ${isHigh ? "active" : ""}`}
                      >
                        <div>
                          <div className="font-mono font-bold text-sm text-white">
                            GPIO {pin}
                          </div>
                          <div className="text-xs text-[var(--cf-text-muted)] mt-0.5">
                            Status:{" "}
                            <span
                              className={`font-mono font-semibold ${
                                isHigh ? "text-emerald-400" : "text-[var(--cf-text-faint)]"
                              }`}
                            >
                              {isHigh ? "HIGH (3.3V)" : "LOW (0V)"}
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => handleSetGpio(pin, true)}
                            disabled={!connected}
                            className={`px-2.5 py-1 rounded text-xs font-semibold transition-all ${
                              isHigh
                                ? "bg-emerald-600 text-white"
                                : "bg-white/5 hover:bg-white/10 text-neutral-300"
                            } disabled:opacity-40`}
                          >
                            HIGH
                          </button>
                          <button
                            onClick={() => handleSetGpio(pin, false)}
                            disabled={!connected}
                            className={`px-2.5 py-1 rounded text-xs font-semibold transition-all ${
                              !isHigh
                                ? "bg-neutral-700 text-white"
                                : "bg-white/5 hover:bg-white/10 text-neutral-300"
                            } disabled:opacity-40`}
                          >
                            LOW
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Custom Pin Writer */}
                <div className="mt-6 pt-5 border-t border-[var(--cf-border)] flex flex-wrap items-center gap-3">
                  <span className="text-xs font-semibold text-[var(--cf-text-muted)]">
                    Direct Pin Command:
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-[var(--cf-text-faint)]">Pin #</span>
                    <input
                      type="number"
                      min="0"
                      max="48"
                      value={customPin}
                      onChange={(e) => setCustomPin(e.target.value)}
                      className="w-16 bg-[var(--cf-inset)] border border-[var(--cf-border)] rounded px-2 py-1 text-xs font-mono text-white text-center"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-[var(--cf-text-faint)]">Level</span>
                    <select
                      value={customLevel}
                      onChange={(e) => setCustomLevel(e.target.value)}
                      className="bg-[var(--cf-inset)] border border-[var(--cf-border)] rounded px-2 py-1 text-xs text-white"
                    >
                      <option value="1">1 (HIGH)</option>
                      <option value="0">0 (LOW)</option>
                    </select>
                  </div>
                  <Button
                    onClick={() => handleSetGpio(Number(customPin), customLevel === "1")}
                    disabled={!connected}
                    size="sm"
                    className="cf-btn-orange text-xs"
                  >
                    Execute GPIO Write
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ==================================================================
            TAB 4: Wi-Fi Provisioning
            ================================================================== */}
        {activeTab === "wifi" && (
          <div className="space-y-6">
            <div className="cf-card">
              <div className="cf-card-header">
                <div>
                  <div className="cf-card-title">
                    <WifiHigh size={16} className="text-sky-400" />
                    <span>Over-the-Air Wi-Fi Scanner</span>
                  </div>
                  <div className="cf-card-desc">
                    Scan for 2.4 GHz access points visible to the ESP32 radio antenna.
                  </div>
                </div>

                <Button
                  onClick={handleScanWifi}
                  disabled={!connected || scanning}
                  className="cf-btn-orange text-xs"
                >
                  <ArrowClockwise size={14} className={scanning ? "animate-spin mr-1.5" : "mr-1.5"} />
                  {scanning ? "Scanning Airwaves..." : "Scan Networks"}
                </Button>
              </div>

              <div className="cf-card-body">
                {scanResults.length === 0 ? (
                  <div className="text-center py-10 text-[var(--cf-text-faint)] text-xs">
                    {scanning
                      ? "Listening for beacon frames across 2.4GHz channels..."
                      : "No access points scanned yet. Click 'Scan Networks' to start."}
                  </div>
                ) : (
                  <div className="cf-table-wrapper">
                    <table className="cf-table">
                      <thead>
                        <tr>
                          <th>SSID</th>
                          <th>Signal Strength</th>
                          <th>Channel</th>
                          <th>Security</th>
                          <th className="text-right">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {scanResults.map((ap, i) => (
                          <tr key={i}>
                            <td className="font-semibold">{ap.ssid || "<Hidden SSID>"}</td>
                            <td>
                              <div className="flex items-center gap-1.5">
                                {renderRssiBars(ap.rssi)}
                                <span className="font-mono text-xs">{ap.rssi} dBm</span>
                              </div>
                            </td>
                            <td className="font-mono text-xs">{ap.channel}</td>
                            <td>
                              <Badge variant="neutral" className="text-xs">
                                {ap.auth}
                              </Badge>
                            </td>
                            <td className="text-right">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setJoinSsid(ap.ssid)}
                                className="cf-btn-ghost text-xs"
                              >
                                Select
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            {/* Credential Provisioning Card */}
            <div className="cf-card">
              <div className="cf-card-header">
                <div className="cf-card-title">
                  <ShieldCheck size={16} className="text-emerald-400" />
                  <span>Provision Wi-Fi Credentials</span>
                </div>
              </div>

              <div className="cf-card-body max-w-lg space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-[var(--cf-text-muted)] mb-1">
                    Network SSID
                  </label>
                  <input
                    type="text"
                    value={joinSsid}
                    onChange={(e) => setJoinSsid(e.target.value)}
                    placeholder="Enter SSID..."
                    className="w-full bg-[var(--cf-inset)] border border-[var(--cf-border)] rounded-lg px-3 py-2 text-xs text-white placeholder-[var(--cf-text-faint)] focus:outline-none focus:border-[var(--cf-orange)]"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-[var(--cf-text-muted)] mb-1">
                    WPA2 / WPA3 Pre-Shared Key (Password)
                  </label>
                  <div className="relative">
                    <input
                      type={showPass ? "text" : "password"}
                      value={joinPass}
                      onChange={(e) => setJoinPass(e.target.value)}
                      placeholder="Enter Wi-Fi password..."
                      className="w-full bg-[var(--cf-inset)] border border-[var(--cf-border)] rounded-lg px-3 py-2 text-xs text-white placeholder-[var(--cf-text-faint)] focus:outline-none focus:border-[var(--cf-orange)] pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPass(!showPass)}
                      className="absolute right-3 top-2.5 text-[var(--cf-text-faint)] hover:text-white"
                    >
                      {showPass ? <EyeSlash size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>

                <Button
                  onClick={handleJoinWifi}
                  disabled={!connected || !joinSsid || joining}
                  className="cf-btn-orange w-full text-xs"
                >
                  <PaperPlaneRight size={14} className="mr-1.5" />
                  {joining ? "Provisioning..." : "Connect ESP32 to Wi-Fi"}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ==================================================================
            TAB 5: Saved Profiles (Cloudflare D1)
            ================================================================== */}
        {activeTab === "profiles" && (
          <div className="space-y-6">
            <div className="cf-card">
              <div className="cf-card-header">
                <div>
                  <div className="cf-card-title">
                    <HardDrives size={16} className="text-cyan-400" />
                    <span>Cloudflare D1 Wi-Fi Profiles</span>
                  </div>
                  <div className="cf-card-desc">
                    Saved networks securely stored in your Cloudflare D1 database.
                  </div>
                </div>
              </div>

              <div className="cf-card-body">
                {profiles.length === 0 ? (
                  <div className="text-center py-8 text-[var(--cf-text-faint)] text-xs">
                    No Wi-Fi profiles stored in D1 yet.
                  </div>
                ) : (
                  <div className="cf-table-wrapper">
                    <table className="cf-table">
                      <thead>
                        <tr>
                          <th>SSID</th>
                          <th>Use Counter</th>
                          <th>Created</th>
                          <th className="text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {profiles.map((p) => (
                          <tr key={p.id}>
                            <td className="font-semibold">{p.ssid}</td>
                            <td className="font-mono text-xs">{p.useCount} times</td>
                            <td className="text-xs text-[var(--cf-text-faint)]">
                              {new Date(p.createdAt).toLocaleDateString()}
                            </td>
                            <td className="text-right flex items-center justify-end gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  setJoinSsid(p.ssid);
                                  setActiveTab("wifi");
                                }}
                                className="cf-btn-ghost text-xs"
                              >
                                Select
                              </Button>
                              <Button
                                variant="destructive"
                                size="sm"
                                onClick={async () => {
                                  await deleteWifiProfile(p.id);
                                  setProfiles((prev) => prev.filter((x) => x.id !== p.id));
                                }}
                                className="!bg-red-500/20 !border-red-500/30 !text-red-300 hover:!bg-red-500/30 text-xs"
                              >
                                <Trash size={13} />
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            {/* Add Profile Card */}
            <div className="cf-card">
              <div className="cf-card-header">
                <div className="cf-card-title">
                  <Plus size={16} className="text-[var(--cf-orange)]" />
                  <span>Add New Wi-Fi Profile</span>
                </div>
              </div>

              <div className="cf-card-body max-w-lg space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-[var(--cf-text-muted)] mb-1">
                    SSID
                  </label>
                  <input
                    type="text"
                    value={newSsid}
                    onChange={(e) => setNewSsid(e.target.value)}
                    placeholder="Enter network name..."
                    className="w-full bg-[var(--cf-inset)] border border-[var(--cf-border)] rounded-lg px-3 py-2 text-xs text-white placeholder-[var(--cf-text-faint)] focus:outline-none focus:border-[var(--cf-orange)]"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-[var(--cf-text-muted)] mb-1">
                    Password
                  </label>
                  <input
                    type="password"
                    value={newPass}
                    onChange={(e) => setNewPass(e.target.value)}
                    placeholder="Enter password..."
                    className="w-full bg-[var(--cf-inset)] border border-[var(--cf-border)] rounded-lg px-3 py-2 text-xs text-white placeholder-[var(--cf-text-faint)] focus:outline-none focus:border-[var(--cf-orange)]"
                  />
                </div>

                <Button
                  onClick={async () => {
                    if (!newSsid) return;
                    await saveWifiProfile({ ssid: newSsid, password: newPass });
                    const res: any = await fetch("/api/wifi-profiles").then((r) => r.json());
                    if (res?.wifiProfiles) setProfiles(res.wifiProfiles);
                    setNewSsid("");
                    setNewPass("");
                  }}
                  disabled={!newSsid}
                  className="cf-btn-orange text-xs"
                >
                  <Plus size={14} className="mr-1" /> Save Profile to D1
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ==================================================================
            TAB 6: Devices (Cloudflare D1)
            ================================================================== */}
        {activeTab === "devices" && (
          <div className="cf-card">
            <div className="cf-card-header">
              <div>
                <div className="cf-card-title">
                  <Cpu size={16} className="text-[var(--cf-orange)]" />
                  <span>Registered Hardware Peripherals</span>
                </div>
                <div className="cf-card-desc">
                  Devices upserted and tracked in Cloudflare D1 edge database.
                </div>
              </div>
            </div>

            <div className="cf-card-body">
              {devices.length === 0 ? (
                <div className="text-center py-8 text-[var(--cf-text-faint)] text-xs">
                  No devices recorded yet. Connect to an ESP32 to register it automatically.
                </div>
              ) : (
                <div className="cf-table-wrapper">
                  <table className="cf-table">
                    <thead>
                      <tr>
                        <th>Device Name</th>
                        <th>MAC Address</th>
                        <th>Chip Architecture</th>
                        <th>Firmware</th>
                        <th>Last Seen</th>
                        <th className="text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {devices.map((d) => (
                        <tr key={d.id}>
                          <td className="font-semibold">{d.name}</td>
                          <td className="font-mono text-xs text-sky-400">{d.mac}</td>
                          <td>
                            <Badge variant="neutral" className="text-xs">
                              {d.chip || "esp32s3"}
                            </Badge>
                          </td>
                          <td className="font-mono text-xs">{d.firmware || "v0.1.0"}</td>
                          <td className="text-xs text-[var(--cf-text-faint)]">
                            {d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : "—"}
                          </td>
                          <td className="text-right">
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={async () => {
                                await deleteDevice(d.id);
                                setDevices((prev) => prev.filter((x) => x.id !== d.id));
                              }}
                              className="!bg-red-500/20 !border-red-500/30 !text-red-300 hover:!bg-red-500/30 text-xs"
                            >
                              <Trash size={13} />
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ==================================================================
            TAB 7: Audit History (Cloudflare D1)
            ================================================================== */}
        {activeTab === "history" && (
          <div className="cf-card">
            <div className="cf-card-header">
              <div>
                <div className="cf-card-title">
                  <ClockCounterClockwise size={16} className="text-[var(--cf-orange)]" />
                  <span>Command Audit Trail</span>
                </div>
                <div className="cf-card-desc">
                  Immutable record of GATT operations persisted into Cloudflare D1.
                </div>
              </div>

              <div className="flex items-center gap-3">
                <input
                  type="text"
                  value={historySearch}
                  onChange={(e) => setHistorySearch(e.target.value)}
                  placeholder="Search commands..."
                  className="bg-[var(--cf-inset)] border border-[var(--cf-border)] rounded px-2.5 py-1 text-xs text-[var(--cf-text)] placeholder-[var(--cf-text-faint)] w-48 focus:outline-none focus:border-[var(--cf-orange)]"
                />

                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    await clearHistory();
                    setHistory([]);
                  }}
                  disabled={history.length === 0}
                  className="cf-btn-ghost text-xs"
                >
                  <Trash size={13} className="mr-1" /> Clear History
                </Button>
              </div>
            </div>

            <div className="cf-card-body">
              {filteredHistory.length === 0 ? (
                <div className="text-center py-8 text-[var(--cf-text-faint)] text-xs">
                  No command history records found.
                </div>
              ) : (
                <div className="cf-table-wrapper">
                  <table className="cf-table">
                    <thead>
                      <tr>
                        <th>Timestamp</th>
                        <th>Direction</th>
                        <th>Command Sent</th>
                        <th>GATT Response</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredHistory.map((h) => (
                        <tr key={h.id}>
                          <td className="text-xs font-mono text-[var(--cf-text-faint)] whitespace-nowrap">
                            {new Date(h.createdAt).toLocaleTimeString()}
                          </td>
                          <td>
                            <span className="cf-tag cf-tag-tx">
                              {h.direction.toUpperCase()}
                            </span>
                          </td>
                          <td className="font-mono text-xs font-semibold">{h.command}</td>
                          <td className="font-mono text-xs text-[var(--cf-text-muted)] truncate max-w-xs">
                            {h.response || "—"}
                          </td>
                          <td>
                            <Badge variant={h.ok ? "success" : "red"} className="text-xs">
                              {h.ok ? "OK" : "ERROR"}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ==================================================================
            TAB 8: Settings & Documentation
            ================================================================== */}
        {activeTab === "settings" && (
          <div className="space-y-6">
            <div className="cf-card">
              <div className="cf-card-header">
                <div className="cf-card-title">
                  <Gear size={16} className="text-[var(--cf-orange)]" />
                  <span>Application Settings &amp; Edge State</span>
                </div>
              </div>

              <div className="cf-card-body space-y-6">
                <div>
                  <h3 className="text-xs font-bold text-[var(--cf-text-strong)] uppercase tracking-wider mb-2">
                    Interface Theme &amp; Color Scheme
                  </h3>
                  <div className="flex items-center gap-2 p-1.5 rounded-lg bg-[var(--cf-inset)] border border-[var(--cf-border)] w-fit flex-wrap">
                    <button
                      type="button"
                      onClick={() => toggleTheme("light")}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                        theme === "light"
                          ? "bg-[var(--cf-card-bg)] text-[var(--cf-text-strong)] shadow-xs border border-[var(--cf-border)]"
                          : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text-strong)]"
                      }`}
                    >
                      <Sun size={15} className="text-amber-500" /> Light
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleTheme("dark")}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                        theme === "dark"
                          ? "bg-[var(--cf-card-bg)] text-[var(--cf-text-strong)] shadow-xs border border-[var(--cf-border)]"
                          : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text-strong)]"
                      }`}
                    >
                      <Moon size={15} className="text-sky-400" /> Dark
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleTheme("system")}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                        theme === "system"
                          ? "bg-[var(--cf-card-bg)] text-[var(--cf-text-strong)] shadow-xs border border-[var(--cf-border)]"
                          : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text-strong)]"
                      }`}
                    >
                      <Desktop size={15} /> System ({resolvedTheme})
                    </button>
                  </div>
                  <p className="text-xs text-[var(--cf-text-faint)] mt-2">
                    Override color scheme manually or automatically track your operating system theme preference.
                  </p>
                </div>

                <div className="pt-4 border-t border-[var(--cf-border)]">
                  <h3 className="text-xs font-bold text-[var(--cf-text-strong)] uppercase tracking-wider mb-2">
                    Client Identity UUID
                  </h3>
                  <div className="p-3 rounded bg-[var(--cf-inset)] border border-[var(--cf-border)] font-mono text-xs flex items-center justify-between">
                    <span className="text-sky-400">{identity.id}</span>
                    <Badge variant="neutral">Cookie: esp_id</Badge>
                  </div>
                  <p className="text-xs text-[var(--cf-text-faint)] mt-1.5">
                    Isolated client token. Each unique browser receives its own partitioned D1 device
                    list and Wi-Fi profile database.
                  </p>
                </div>

                <div className="pt-4 border-t border-[var(--cf-border)]">
                  <h3 className="text-xs font-bold text-red-400 uppercase tracking-wider mb-2">
                    Danger Zone
                  </h3>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={async () => {
                      if (confirm("Reset all stored devices, Wi-Fi profiles and history?")) {
                        await resetWorkspace();
                        setDevices([]);
                        setProfiles([]);
                        setHistory([]);
                      }
                    }}
                    className="!bg-red-600 hover:!bg-red-700 !text-white text-xs font-semibold"
                  >
                    Reset Workspace Data
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* ====================================================================
          4. Cloudflare Global Footer
          ==================================================================== */}
      <footer className="mt-auto border-t border-[var(--cf-border)] bg-[var(--cf-nav-bg)] py-5 px-6">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-[var(--cf-text-faint)]">
          <div className="flex items-center gap-2">
            <CloudflareLogo variant="glyph" className="h-4 text-[var(--cf-orange)]" />
            <span>Powered by Cloudflare Workers, Pages, D1 Database, and Kumo Design System.</span>
          </div>

          <div className="flex items-center gap-4">
            <a
              href="https://github.com/unesp32/esp32-remote"
              target="_blank"
              rel="noreferrer"
              className="hover:text-[var(--cf-text-strong)] transition-colors"
            >
              GitHub Repository
            </a>
            <a
              href="https://www.cloudflarestatus.com"
              target="_blank"
              rel="noreferrer"
              className="hover:text-[var(--cf-text-strong)] transition-colors"
            >
              Cloudflare Status
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
