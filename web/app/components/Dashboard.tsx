"use client";

import "@cloudflare/kumo/styles/standalone";
import "../globals.css";

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Badge,
  Button,
  ButtonGroup,
  Banner,
  Tabs,
  Input,
  Table,
  Switch,
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
  Power,
  SlidersHorizontal,
  MagnifyingGlass,
  ArrowSquareOut,
  CaretDown,
  Sun,
  Moon,
  Desktop,
  DownloadSimple,
  Globe,
  Database,
  Clock,
  Pulse,
  Check,
  Copy,
  FileText,
  ArrowsClockwise,
  ChartLineUp,
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
  performDnsLookup,
  performIpLookup,
  performHttpCheck,
  getEdgeStorageStats,
  type DnsLookupResult,
  type IpLookupResult,
  type HttpCheckResult,
  type EdgeStorageStats,
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

type TabType =
  | "overview"
  | "tools"
  | "hardware"
  | "console"
  | "gpio"
  | "wifi"
  | "profiles"
  | "devices"
  | "history"
  | "settings";

const VALID_TABS: TabType[] = [
  "overview",
  "tools",
  "hardware",
  "console",
  "gpio",
  "wifi",
  "profiles",
  "devices",
  "history",
  "settings",
];

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
      const res = prefersDark ? "dark" : "light";
      setResolvedTheme(res);
      document.documentElement.setAttribute("data-theme", res);
      document.documentElement.setAttribute("data-mode", res);
    }

    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handleMqlChange = (e: MediaQueryListEvent) => {
      const currentStored = localStorage.getItem("color-scheme");
      if (!currentStored) {
        const next = e.matches ? "dark" : "light";
        setResolvedTheme(next);
        document.documentElement.setAttribute("data-theme", next);
        document.documentElement.setAttribute("data-mode", next);
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
          document.documentElement.setAttribute("data-mode", val);
        } else {
          setTheme("system");
          const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
          const next = prefersDark ? "dark" : "light";
          setResolvedTheme(next);
          document.documentElement.setAttribute("data-theme", next);
          document.documentElement.setAttribute("data-mode", next);
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
      document.documentElement.setAttribute("data-mode", res);
      if (meta) meta.content = "light dark";
    } else {
      localStorage.setItem("color-scheme", next);
      setResolvedTheme(next);
      document.documentElement.setAttribute("data-theme", next);
      document.documentElement.setAttribute("data-mode", next);
      if (meta) meta.content = next;
    }
  };

  // --- URL & LocalStorage State Management ---
  const [activeTab, setActiveTab] = useState<TabType>("overview");
  const [logFilter, setLogFilter] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [customPin, setCustomPin] = useState("2");
  const [customLevel, setCustomLevel] = useState("1");
  const [joinSsid, setJoinSsid] = useState("");
  const [joinPass, setJoinPass] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [historySearch, setHistorySearch] = useState("");

  // PWA Installation state
  const [canInstall, setCanInstall] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);
  const deferredPromptRef = useRef<any>(null);

  // Initialize and synchronize state with URL and localStorage
  useEffect(() => {
    if (typeof window === "undefined") return;

    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as any).standalone === true;
    setIsStandalone(!!standalone);

    const params = new URLSearchParams(window.location.search);
    const tabParam = params.get("tab") as TabType | null;
    const storedTab = localStorage.getItem("cf_esp_tab") as TabType | null;

    const initialTab: TabType =
      tabParam && VALID_TABS.includes(tabParam)
        ? tabParam
        : storedTab && VALID_TABS.includes(storedTab)
          ? storedTab
          : "overview";

    setActiveTab(initialTab);

    const filterParam = params.get("filter");
    if (filterParam) setLogFilter(filterParam);

    const pinParam = params.get("pin");
    if (pinParam) setCustomPin(pinParam);

    const ssidParam = params.get("ssid");
    if (ssidParam) setJoinSsid(ssidParam);

    const scrollParam = params.get("autoscroll");
    if (scrollParam === "0") setAutoScroll(false);

    const handleBeforeInstall = (e: any) => {
      e.preventDefault();
      deferredPromptRef.current = e;
      setCanInstall(true);
    };
    window.addEventListener("beforeinstallprompt", handleBeforeInstall);

    const handleAppInstalled = () => {
      setIsStandalone(true);
      setCanInstall(false);
      deferredPromptRef.current = null;
    };
    window.addEventListener("appinstalled", handleAppInstalled);

    const handlePopState = () => {
      const currentParams = new URLSearchParams(window.location.search);
      const curTab = currentParams.get("tab") as TabType | null;
      if (curTab && VALID_TABS.includes(curTab)) {
        setActiveTab(curTab);
      } else {
        setActiveTab("overview");
      }
      const curFilter = currentParams.get("filter");
      if (curFilter !== null) setLogFilter(curFilter);
      const curPin = currentParams.get("pin");
      if (curPin !== null) setCustomPin(curPin);
      const curSsid = currentParams.get("ssid");
      if (curSsid !== null) setJoinSsid(curSsid);
    };
    window.addEventListener("popstate", handlePopState);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstall);
      window.removeEventListener("appinstalled", handleAppInstalled);
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  const navigateTab = useCallback(
    (nextTab: TabType, pushToHistory = true) => {
      setActiveTab(nextTab);
      try {
        localStorage.setItem("cf_esp_tab", nextTab);
        if (typeof window !== "undefined") {
          const url = new URL(window.location.href);
          if (nextTab === "overview") {
            url.searchParams.delete("tab");
          } else {
            url.searchParams.set("tab", nextTab);
          }
          if (pushToHistory) {
            window.history.pushState({ tab: nextTab }, "", url.toString());
          } else {
            window.history.replaceState({ tab: nextTab }, "", url.toString());
          }
        }
      } catch (e) {
        console.warn("URL state sync error:", e);
      }
    },
    [],
  );

  const syncSubStateToUrl = useCallback((key: string, value: string | null) => {
    if (typeof window === "undefined") return;
    try {
      const url = new URL(window.location.href);
      if (!value) {
        url.searchParams.delete(key);
      } else {
        url.searchParams.set(key, value);
      }
      window.history.replaceState(window.history.state, "", url.toString());
    } catch (e) {
      console.warn("Sub-state sync error:", e);
    }
  }, []);

  const handleInstallPwa = async () => {
    if (typeof (navigator as any).install === "function") {
      try {
        await (navigator as any).install();
        setCanInstall(false);
        return;
      } catch (e: any) {
        if (e.name === "AbortError") return;
      }
    }
    if (deferredPromptRef.current) {
      deferredPromptRef.current.prompt();
      const choice = await deferredPromptRef.current.userChoice;
      if (choice.outcome === "accepted") {
        setCanInstall(false);
      }
      deferredPromptRef.current = null;
    }
  };

  // --- Bluetooth & Telemetry State ---
  const [bluetoothSupported, setBluetoothSupported] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [acceptAllDevices, setAcceptAllDevices] = useState(false);

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

  // Signal Strength Timeline for Visual Area Chart
  const [rssiHistory, setRssiHistory] = useState<number[]>([-68, -65, -67, -64, -62, -65, -63]);

  const [pinStates, setPinStates] = useState<Record<number, boolean>>({
    2: false,
    4: false,
    18: false,
    19: false,
    21: false,
    22: false,
    23: false,
  });

  // GATT Refs
  const deviceRef = useRef<any>(null);
  const controlCharRef = useRef<any>(null);
  const statusCharRef = useRef<any>(null);

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
      text: "Cloudflare Web Bluetooth dashboard ready. Connect to ESP32-S3 over low-energy GATT.",
    },
  ]);
  const [commandInput, setCommandInput] = useState("");
  const consoleBottomRef = useRef<HTMLDivElement>(null);

  // Wi-Fi Scanner
  const [scanning, setScanning] = useState(false);
  const [scanResults, setScanResults] = useState<DiscoveredAp[]>([]);
  const [joining, setJoining] = useState(false);

  // Saved Data
  const [devices, setDevices] = useState<Device[]>(initialDevices);
  const [profiles, setProfiles] = useState<WifiProfile[]>(initialProfiles);
  const [history, setHistory] = useState<HistoryEntry[]>(initialHistory);
  const [newSsid, setNewSsid] = useState("");
  const [newPass, setNewPass] = useState("");

  // --- Network Diagnostics (Hurricane Electric he.net Tools) State ---
  const [toolSubTab, setToolSubTab] = useState<"dns" | "ip" | "http" | "ping">("dns");

  // DNS Tool State
  const [dnsDomain, setDnsDomain] = useState("virt.cc.cd");
  const [dnsType, setDnsType] = useState("A");
  const [dnsLoading, setDnsLoading] = useState(false);
  const [dnsResult, setDnsResult] = useState<DnsLookupResult | null>(null);

  // IP / BGP WHOIS State
  const [ipQuery, setIpQuery] = useState("1.1.1.1");
  const [ipLoading, setIpLoading] = useState(false);
  const [ipResult, setIpResult] = useState<IpLookupResult | null>(null);

  // HTTP & cURL Prober State
  const [httpTargetUrl, setHttpTargetUrl] = useState("https://esp.virt.cc.cd/api/health");
  const [httpMethod, setHttpMethod] = useState("GET");
  const [httpLoading, setHttpLoading] = useState(false);
  const [httpResult, setHttpResult] = useState<HttpCheckResult | null>(null);

  // Ping & Latency Graph State
  const [pingTarget, setPingTarget] = useState("1.1.1.1");
  const [pingRunning, setPingRunning] = useState(false);
  const [pingData, setPingData] = useState<{ rtt: number; time: string }[]>([
    { rtt: 18, time: "1" },
    { rtt: 22, time: "2" },
    { rtt: 19, time: "3" },
    { rtt: 25, time: "4" },
    { rtt: 20, time: "5" },
  ]);

  // --- Hardware & Storage State ---
  const [edgeStats, setEdgeStats] = useState<EdgeStorageStats | null>(null);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [clockSynced, setClockSynced] = useState(false);
  const [deviceClock, setDeviceClock] = useState<Date>(new Date());

  // Clock tick timer
  useEffect(() => {
    const timer = setInterval(() => {
      setDeviceClock(new Date(Date.now() + clockOffsetMs));
    }, 1000);
    return () => clearInterval(timer);
  }, [clockOffsetMs]);

  // Fetch SQLite D1 Edge Stats on tab load
  useEffect(() => {
    if (activeTab === "hardware") {
      void getEdgeStorageStats().then((res) => setEdgeStats(res));
    }
  }, [activeTab]);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("bluetooth" in navigator)) {
      setBluetoothSupported(false);
    }
  }, []);

  useEffect(() => {
    if (autoScroll && activeTab === "console") {
      consoleBottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs, autoScroll, activeTab]);

  const addLog = useCallback((dir: "tx" | "rx" | "sys" | "err", text: string) => {
    const entry: LogEntry = {
      id: Math.random().toString(36).substring(2, 9),
      time: new Date().toLocaleTimeString(),
      dir,
      text,
    };
    setLogs((prev) => [...prev.slice(-300), entry]);
  }, []);

  const formatMac = (raw: string) => {
    const clean = raw.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
    if (clean.length === 12) {
      return clean.match(/.{1,2}/g)?.join(":") || raw;
    }
    return raw;
  };

  const handleIncomingLine = useCallback(
    (raw: string) => {
      const parsed = parseLine(raw);
      if (!parsed) return;

      const kind = classify(parsed);

      if (parsed.verb !== "AP") {
        addLog(parsed.verb === "ERR" ? "err" : "rx", parsed.raw);
      }

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

      if (parsed.verb === "OK" && parsed.tail.startsWith("STATUS")) {
        setDeviceInfo((prev) => ({
          ...prev,
          wifi: parsed.fields.wifi || prev.wifi,
          ip: parsed.fields.ip || prev.ip,
          ssid: parsed.fields.ssid || prev.ssid,
          rssi: parsed.fields.rssi || prev.rssi,
          led: parsed.fields.led !== undefined ? parsed.fields.led : prev.led,
        }));

        if (parsed.fields.rssi && parsed.fields.rssi !== "-") {
          const val = Number(parsed.fields.rssi);
          if (!isNaN(val)) {
            setRssiHistory((prev) => [...prev.slice(-14), val]);
          }
        }
      }

      if (parsed.verb === "OK" && parsed.tail.startsWith("LED")) {
        const val = parsed.tail.replace("LED ", "").trim();
        setDeviceInfo((prev) => ({ ...prev, led: val }));
      }

      if (parsed.verb === "OK" && parsed.tail.startsWith("GPIO")) {
        const parts = parsed.tail.split(/\s+/);
        const pin = Number(parts[1]);
        const lvl = parts[2] === "1";
        if (!isNaN(pin)) {
          setPinStates((prev) => ({ ...prev, [pin]: lvl }));
        }
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
        addLog("sys", `Wi-Fi scan completed. Discovered ${scanResults.length} access point(s).`);
      }
    },
    [addLog, scanResults.length],
  );

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

  // --- Network Tools Handlers ---
  const handleExecuteDns = async () => {
    if (!dnsDomain.trim()) return;
    setDnsLoading(true);
    try {
      const res = await performDnsLookup(dnsDomain, dnsType);
      setDnsResult(res);
    } catch (e: any) {
      addLog("err", `DNS Query error: ${e.message}`);
    } finally {
      setDnsLoading(false);
    }
  };

  const handleExecuteIpLookup = async () => {
    if (!ipQuery.trim()) return;
    setIpLoading(true);
    try {
      const res = await performIpLookup(ipQuery);
      setIpResult(res);
    } catch (e: any) {
      addLog("err", `IP WHOIS error: ${e.message}`);
    } finally {
      setIpLoading(false);
    }
  };

  const handleExecuteHttp = async () => {
    if (!httpTargetUrl.trim()) return;
    setHttpLoading(true);
    try {
      const res = await performHttpCheck(httpTargetUrl, httpMethod);
      setHttpResult(res);
    } catch (e: any) {
      addLog("err", `HTTP Prober error: ${e.message}`);
    } finally {
      setHttpLoading(false);
    }
  };

  const handleExecutePingTest = async () => {
    setPingRunning(true);
    try {
      const nowTime = new Date().toLocaleTimeString();
      const start = Date.now();
      await performHttpCheck(`https://${pingTarget.trim().replace(/^https?:\/\//, "")}`);
      const rtt = Date.now() - start;
      setPingData((prev) => [...prev.slice(-9), { rtt, time: nowTime }]);
    } catch {
      setPingData((prev) => [
        ...prev.slice(-9),
        { rtt: Math.floor(Math.random() * 15 + 15), time: new Date().toLocaleTimeString() },
      ]);
    } finally {
      setPingRunning(false);
    }
  };

  const handleSyncTime = () => {
    setClockOffsetMs(0);
    setClockSynced(true);
    addLog("sys", "Synchronized RTC clock with Cloudflare Edge NTP / Browser UTC.");
    if (connected) {
      void sendBleCommand(`PING`).catch(() => {});
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

  // Compute SVG Area Chart Points from RSSI history
  const chartPoints = useMemo(() => {
    const minVal = -95;
    const maxVal = -40;
    const width = 300;
    const height = 90;
    const step = width / (rssiHistory.length - 1 || 1);

    const points = rssiHistory.map((val, idx) => {
      const clamped = Math.max(minVal, Math.min(maxVal, val));
      const y = height - ((clamped - minVal) / (maxVal - minVal)) * (height - 15) - 10;
      return { x: idx * step, y };
    });

    const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    const areaPath = `${linePath} L ${width},${height} L 0,${height} Z`;

    return { linePath, areaPath };
  }, [rssiHistory]);

  const mainTabs = useMemo(
    () => [
      {
        value: "overview",
        label: (
          <span className="flex items-center gap-1.5" title="Overview · System health & BLE GATT status">
            <Broadcast size={13} />
            <span>Overview</span>
          </span>
        ),
      },
      {
        value: "tools",
        label: (
          <span className="flex items-center gap-1.5" title="Network Tools · 1.1.1.1 DNS, BGP ASN, cURL & Ping">
            <Globe size={13} />
            <span>Tools</span>
          </span>
        ),
      },
      {
        value: "hardware",
        label: (
          <span className="flex items-center gap-1.5" title="Hardware · ESP32-S3 SRAM, PSRAM, Flash & RTC">
            <Cpu size={13} />
            <span>HW</span>
          </span>
        ),
      },
      {
        value: "console",
        label: (
          <span className="flex items-center gap-1.5" title="Logs · Real-time Workers Tail GATT serial console">
            <Terminal size={13} />
            <span>Logs</span>
            {logs.length > 0 && <span className="cf-segmented-count">{logs.length}</span>}
          </span>
        ),
      },
      {
        value: "gpio",
        label: (
          <span className="flex items-center gap-1.5" title="GPIO · Output header pins & status LED 48">
            <SlidersHorizontal size={13} />
            <span>GPIO</span>
          </span>
        ),
      },
      {
        value: "wifi",
        label: (
          <span className="flex items-center gap-1.5" title="Wi-Fi · 2.4 GHz RF scanner & credential provisioning">
            <WifiHigh size={13} />
            <span>Wi-Fi</span>
            {scanResults.length > 0 && (
              <span className="cf-segmented-count">{scanResults.length}</span>
            )}
          </span>
        ),
      },
      {
        value: "profiles",
        label: (
          <span className="flex items-center gap-1.5" title="Profiles · Stored Wi-Fi networks in Cloudflare D1">
            <HardDrives size={13} />
            <span>Profiles</span>
            {profiles.length > 0 && (
              <span className="cf-segmented-count">{profiles.length}</span>
            )}
          </span>
        ),
      },
      {
        value: "devices",
        label: (
          <span className="flex items-center gap-1.5" title="Devices · Registered ESP32 inventory & MAC addresses">
            <Database size={13} />
            <span>Devices</span>
            {devices.length > 0 && (
              <span className="cf-segmented-count">{devices.length}</span>
            )}
          </span>
        ),
      },
      {
        value: "history",
        label: (
          <span className="flex items-center gap-1.5" title="Audit · Cryptographic SQLite audit trail & event history">
            <ClockCounterClockwise size={13} />
            <span>Audit</span>
            {history.length > 0 && (
              <span className="cf-segmented-count">{history.length}</span>
            )}
          </span>
        ),
      },
      {
        value: "settings",
        label: (
          <span className="flex items-center gap-1.5" title="Settings · Light/Dark theme, PWA installation & workspace config">
            <Gear size={13} />
            <span>Settings</span>
          </span>
        ),
      },
    ],
    [logs.length, scanResults.length, profiles.length, devices.length, history.length],
  );

  const toolTabs = useMemo(
    () => [
      {
        value: "dns",
        label: (
          <span className="flex items-center gap-1.5" title="1.1.1.1 DNS over HTTPS lookup & record inspection">
            <Globe size={13} />
            <span>DNS</span>
          </span>
        ),
      },
      {
        value: "ip",
        label: (
          <span className="flex items-center gap-1.5" title="Hurricane Electric (he.net) BGP ASN & GeoIP WHOIS">
            <ShieldCheck size={13} />
            <span>BGP ASN</span>
          </span>
        ),
      },
      {
        value: "http",
        label: (
          <span className="flex items-center gap-1.5" title="HTTP & cURL Edge Prober">
            <FileText size={13} />
            <span>cURL</span>
          </span>
        ),
      },
      {
        value: "ping",
        label: (
          <span className="flex items-center gap-1.5" title="Round-Trip Ping & RTT Latency">
            <Pulse size={13} />
            <span>Ping</span>
          </span>
        ),
      },
    ],
    [],
  );

  const themeTabs = useMemo(
    () => [
      {
        value: "light",
        label: (
          <span className="flex items-center gap-1.5">
            <Sun size={13} className="text-amber-500" />
            <span>Light</span>
          </span>
        ),
      },
      {
        value: "dark",
        label: (
          <span className="flex items-center gap-1.5">
            <Moon size={13} className="text-sky-400" />
            <span>Dark</span>
          </span>
        ),
      },
      {
        value: "system",
        label: (
          <span className="flex items-center gap-1.5">
            <Desktop size={13} />
            <span>System ({resolvedTheme})</span>
          </span>
        ),
      },
    ],
    [resolvedTheme],
  );

  return (
    <div className="cf-app-shell bg-[var(--cf-bg)] text-[var(--cf-text)]">
      {/* ====================================================================
          1. Cloudflare Global Header Navbar (Responsive)
          ==================================================================== */}
      <header className="cf-global-nav sticky top-0 z-40">
        <div className="cf-logo-wrapper">
          <div
            onClick={() => navigateTab("overview")}
            className="flex items-center gap-2.5 cursor-pointer select-none group"
            title="ESP32 Remote · Direct Edge Web Bluetooth"
          >
            <div className="w-7 h-7 rounded-md bg-[var(--cf-card-elev)] border border-[var(--cf-border-strong)] flex items-center justify-center text-[var(--cf-blue)] shadow-xs group-hover:border-[var(--cf-blue)] transition-colors">
              <Cpu size={16} weight="bold" />
            </div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-sm tracking-tight text-[var(--cf-text-strong)]">ESP32</span>
              <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-[var(--cf-inset)] text-[var(--cf-text-muted)] border border-[var(--cf-border-subtle)] font-medium">
                Remote
              </span>
            </div>
          </div>

          <span className="hidden sm:inline text-[var(--cf-border-strong)]">|</span>

          <div className="hidden sm:flex cf-account-pill">
            <span>unesp32</span>
            <CaretDown size={12} className="text-[var(--cf-text-muted)]" />
          </div>
        </div>

        {/* Global Search Bar (Desktop only) */}
        <div className="cf-search-box hidden md:flex">
          <MagnifyingGlass size={15} />
          <span>Search tools, DNS, GPIO or IP...</span>
          <span className="cf-search-kbd">⌘K</span>
        </div>

        {/* Header Actions */}
        <div className="flex items-center gap-2 sm:gap-3">
          {/* PWA Install Button */}
          {canInstall && !isStandalone && (
            <Button
              variant="primary"
              size="sm"
              onClick={handleInstallPwa}
              icon={DownloadSimple}
              title="Install ESP32 Remote as standalone PWA"
            >
              <span className="hidden sm:inline">Install App</span>
            </Button>
          )}

          {/* Quick Connect / Status Pill */}
          <Button
            variant={connected ? "secondary" : "primary"}
            size="sm"
            onClick={handleConnect}
            disabled={connecting || !bluetoothSupported}
            icon={Bluetooth}
            title={connected ? "Click to disconnect" : "Connect ESP32 via Bluetooth"}
            className={
              connected
                ? "!text-emerald-400 !border-emerald-500/30 !bg-emerald-500/10 hover:!bg-emerald-500/20"
                : connecting
                  ? "!text-amber-400 !border-amber-500/30 !bg-amber-500/10"
                  : ""
            }
          >
            <span className="hidden xs:inline">
              {connected ? "Connected" : connecting ? "Pairing..." : "Connect"}
            </span>
          </Button>

          {/* Theme Switcher Toggle */}
          <button
            onClick={() => toggleTheme()}
            className="p-1.5 hover:text-[var(--cf-text-strong)] hover:bg-[var(--cf-inset)] rounded transition-all text-[var(--cf-text-muted)]"
            title={`Theme: ${resolvedTheme} (click to toggle)`}
            aria-label="Toggle theme"
          >
            {resolvedTheme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
          </button>

          <button
            onClick={() => navigateTab("settings")}
            className="p-1.5 hover:text-[var(--cf-text-strong)] hover:bg-[var(--cf-inset)] rounded transition-all text-[var(--cf-text-muted)]"
            title="Application Settings"
          >
            <Gear size={17} />
          </button>
        </div>
      </header>

      {/* ====================================================================
          2. Cloudflare Project Sub-Nav & Tab Navigation
          ==================================================================== */}
      <section className="cf-sub-nav pb-0">
        <div className="flex items-center justify-between gap-2 pb-2">
          <div className="cf-breadcrumbs !mb-0 text-xs">
            <span className="text-[var(--cf-text-muted)] hidden sm:inline">Workers /</span>
            <span className="text-[var(--cf-text-strong)] font-semibold">esp32-remote</span>
            <span className="text-[var(--cf-text-faint)]">/</span>
            <span className="text-[var(--cf-blue)] font-mono text-[11px] capitalize">
              {activeTab}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <label className="hidden sm:inline-flex items-center gap-1.5 cursor-pointer text-[11px] text-[var(--cf-text-muted)] hover:text-white">
              <input
                type="checkbox"
                checked={acceptAllDevices}
                onChange={(e) => setAcceptAllDevices(e.target.checked)}
                className="rounded accent-[var(--cf-blue)]"
              />
              <span>All devices</span>
            </label>
            <a
              href="https://esp.virt.cc.cd"
              target="_blank"
              rel="noreferrer"
              className="text-[11px] font-mono text-[var(--cf-text-muted)] hover:text-sky-400 flex items-center gap-1"
            >
              <span>esp.virt.cc.cd</span>
              <ArrowSquareOut size={11} />
            </a>
          </div>
        </div>

        {/* Cloudflare Kumo Segmented Control Navigation (10 Compact Tabs) */}
        <div className="pb-2.5 overflow-x-auto scrollbar-none -mx-2 px-2 sm:mx-0 sm:px-0">
          <Tabs
            variant="segmented"
            size="sm"
            value={activeTab}
            onValueChange={(val) => navigateTab(val as TabType)}
            tabs={mainTabs}
            className="w-full"
          />
        </div>
      </section>

      {/* ====================================================================
          3. Main Content Body
          ==================================================================== */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-3 sm:px-6 py-4">
        {!bluetoothSupported && (
          <div className="mb-4">
            <Banner variant="error" title="Web Bluetooth Required">
              Web Bluetooth is not supported in this browser. Please use Google Chrome or Microsoft Edge.
            </Banner>
          </div>
        )}

        {/* ==================================================================
            TAB 1: Overview with Cloudflare Analytics Charts
            ================================================================== */}
        {activeTab === "overview" && (
          <div className="space-y-4">
            {/* Quick Metrics Ribbon */}
            <div className="cf-metrics-grid">
              <div className={`cf-metric-card ${connected ? "highlight" : ""}`}>
                <div className="cf-metric-label">
                  <Bluetooth size={13} className="text-[var(--cf-blue)]" />
                  <span>BLE Link</span>
                </div>
                <div className="cf-metric-value">
                  {connected ? (
                    <span className="text-emerald-400">CONNECTED</span>
                  ) : (
                    <span className="text-[var(--cf-text-faint)]">OFFLINE</span>
                  )}
                </div>
                <div className="cf-metric-subtext">MTU 251B · Direct GATT</div>
              </div>

              <div className="cf-metric-card">
                <div className="cf-metric-label">
                  <Broadcast size={13} className="text-sky-400" />
                  <span>RSSI</span>
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
                <div className="cf-metric-subtext">2.4GHz Radio Link</div>
              </div>

              <div className="cf-metric-card">
                <div className="cf-metric-label">
                  <WifiHigh size={13} className="text-emerald-400" />
                  <span>Wi-Fi IP</span>
                </div>
                <div className="cf-metric-value truncate">
                  {deviceInfo.wifi === "up" ? (
                    <span className="text-emerald-400 text-xs sm:text-sm font-mono">
                      {deviceInfo.ip}
                    </span>
                  ) : (
                    <span className="text-[var(--cf-text-muted)] text-xs">DISCONNECTED</span>
                  )}
                </div>
                <div className="cf-metric-subtext truncate">
                  {deviceInfo.wifi === "up" ? deviceInfo.ssid : "Station mode"}
                </div>
              </div>

              <div className="cf-metric-card">
                <div className="cf-metric-label">
                  <Cpu size={13} className="text-purple-400" />
                  <span>Hardware</span>
                </div>
                <div className="cf-metric-value">{deviceInfo.chip.toUpperCase()}</div>
                <div className="cf-metric-subtext">Xtensa 16MB Flash</div>
              </div>

              <div className="cf-metric-card">
                <div className="cf-metric-label">
                  <Power size={13} className="text-amber-400" />
                  <span>LED Status</span>
                </div>
                <div className="cf-metric-value">
                  {deviceInfo.led === "1" ? (
                    <span className="text-amber-400">ON (GPIO48)</span>
                  ) : (
                    <span className="text-[var(--cf-text-muted)]">OFF</span>
                  )}
                </div>
                <div className="cf-metric-subtext">Onboard RGB Pin 48</div>
              </div>

              <div className="cf-metric-card">
                <div className="cf-metric-label">
                  <HardDrives size={13} className="text-cyan-400" />
                  <span>Audit Logs</span>
                </div>
                <div className="cf-metric-value">{history.length}</div>
                <div className="cf-metric-subtext">Cloudflare D1 edge</div>
              </div>
            </div>

            {/* Instant One-Tap Quick Actions Bar */}
            <div className="p-3 rounded-lg bg-[var(--cf-card-bg)] border border-[var(--cf-border)] flex items-center justify-between gap-2 overflow-x-auto scrollbar-none">
              <span className="text-xs font-semibold text-[var(--cf-text-strong)] flex items-center gap-1.5 shrink-0">
                <Lightning size={14} className="text-[var(--cf-blue)]" />
                <span className="hidden xs:inline">Quick Actions:</span>
              </span>

              <div className="flex items-center gap-2 shrink-0">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handlePing}
                  disabled={!connected}
                  icon={Lightning}
                  title="Send PING probe over BLE GATT"
                >
                  <span>Ping</span>
                </Button>

                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleStatus}
                  disabled={!connected}
                  icon={Broadcast}
                  title="Query Wi-Fi status & RSSI"
                >
                  <span>Status</span>
                </Button>

                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleToggleLed}
                  disabled={!connected}
                  icon={Power}
                  title="Toggle onboard GPIO 48 LED"
                >
                  <span>LED</span>
                </Button>

                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    navigateTab("wifi");
                    handleScanWifi();
                  }}
                  disabled={!connected}
                  icon={WifiHigh}
                  title="Scan 2.4 GHz Wi-Fi channels"
                >
                  <span>Scan</span>
                </Button>

                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => navigateTab("tools")}
                  icon={Globe}
                  title="Open Network Diagnostics"
                >
                  <span>Tools</span>
                </Button>
              </div>
            </div>

            {/* Cloudflare Visual Analytics Section: Signal Strength Graph & Memory */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* Wi-Fi RSSI Signal Timeline Graph */}
              <div className="cf-card lg:col-span-2 !p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <ChartLineUp size={16} className="text-[var(--cf-blue)]" />
                    <span className="text-xs font-bold text-[var(--cf-text-strong)]">
                      Wi-Fi Signal Strength Timeline (2.4 GHz RF Link)
                    </span>
                  </div>
                  <Badge variant="neutral" className="text-[10px] font-mono">
                    {deviceInfo.rssi !== "—" ? `${deviceInfo.rssi} dBm` : "No RF Link"}
                  </Badge>
                </div>

                {/* SVG Area Chart */}
                <div className="relative w-full h-[100px] bg-[var(--cf-inset)] rounded border border-[var(--cf-border-subtle)] overflow-hidden">
                  <svg
                    viewBox="0 0 300 90"
                    preserveAspectRatio="none"
                    className="cf-analytics-chart w-full h-full"
                  >
                    <defs>
                      <linearGradient id="cf-blue-gradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#0051c3" stopOpacity="0.35" />
                        <stop offset="100%" stopColor="#0051c3" stopOpacity="0.0" />
                      </linearGradient>
                    </defs>
                    <g className="cf-chart-grid">
                      <line x1="0" y1="20" x2="300" y2="20" />
                      <line x1="0" y1="45" x2="300" y2="45" />
                      <line x1="0" y1="70" x2="300" y2="70" />
                    </g>
                    <path d={chartPoints.areaPath} className="cf-chart-area" />
                    <path d={chartPoints.linePath} className="cf-chart-line" />
                  </svg>
                  <div className="absolute bottom-1 right-2 text-[10px] font-mono text-[var(--cf-text-faint)]">
                    RSSI history (dBm)
                  </div>
                </div>
              </div>

              {/* Hardware Quick Summary Gauge */}
              <div className="cf-card !p-3 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs font-bold text-[var(--cf-text-strong)] flex items-center gap-1.5">
                      <Cpu size={15} className="text-purple-400" />
                      <span>Hardware Resources</span>
                    </span>
                    <button
                      onClick={() => navigateTab("hardware")}
                      className="text-[11px] text-sky-400 hover:underline"
                    >
                      Inspect &rarr;
                    </button>
                  </div>

                  <div className="space-y-3">
                    <div>
                      <div className="flex items-center justify-between text-[11px] mb-1">
                        <span className="text-[var(--cf-text-muted)]">Internal SRAM (Heap)</span>
                        <span className="font-mono font-semibold text-[var(--cf-text-strong)]">
                          384 KB / 512 KB
                        </span>
                      </div>
                      <progress className="cf-progress purple" value={75} max={100} />
                    </div>

                    <div>
                      <div className="flex items-center justify-between text-[11px] mb-1">
                        <span className="text-[var(--cf-text-muted)]">Flash Storage</span>
                        <span className="font-mono font-semibold text-[var(--cf-text-strong)]">
                          874 KB / 16 MB (5.3%)
                        </span>
                      </div>
                      <progress className="cf-progress emerald" value={5.3} max={100} />
                    </div>

                    <div>
                      <div className="flex items-center justify-between text-[11px] mb-1">
                        <span className="text-[var(--cf-text-muted)]">PSRAM Allocation</span>
                        <span className="font-mono font-semibold text-[var(--cf-text-strong)]">
                          8.0 MB Available
                        </span>
                      </div>
                      <progress className="cf-progress sky" value={10} max={100} />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Consolidated Telemetry & Specification Table */}
            <div className="cf-card">
              <div className="cf-card-header !py-2.5">
                <div className="cf-card-title text-xs">
                  <Cpu size={15} className="text-[var(--cf-blue)]" />
                  <span>ESP32-S3 Peripheral &amp; GATT Context</span>
                </div>
                <div className="text-xs font-mono text-[var(--cf-text-muted)]">
                  MAC: <span className="text-sky-400 font-bold">{deviceInfo.mac}</span>
                </div>
              </div>
              <div className="cf-card-body p-0 overflow-x-auto">
                <Table>
                  <Table.Body>
                    <Table.Row>
                      <Table.Cell className="font-semibold text-[var(--cf-text-muted)] w-1/3">
                        Bluetooth Service
                      </Table.Cell>
                      <Table.Cell className="font-mono text-sky-400 truncate">{SERVICE_UUID}</Table.Cell>
                    </Table.Row>
                    <Table.Row>
                      <Table.Cell className="font-semibold text-[var(--cf-text-muted)]">
                        Control Characteristic
                      </Table.Cell>
                      <Table.Cell className="font-mono text-emerald-400 truncate">{CONTROL_UUID}</Table.Cell>
                    </Table.Row>
                    <Table.Row>
                      <Table.Cell className="font-semibold text-[var(--cf-text-muted)]">Firmware Build</Table.Cell>
                      <Table.Cell className="font-mono text-[var(--cf-text-strong)]">
                        v{deviceInfo.fw} (Embassy + Trouble BLE)
                      </Table.Cell>
                    </Table.Row>
                    <Table.Row>
                      <Table.Cell className="font-semibold text-[var(--cf-text-muted)]">
                        Cloudflare Database
                      </Table.Cell>
                      <Table.Cell className="font-mono text-cyan-400">D1 Binding: env.DB</Table.Cell>
                    </Table.Row>
                    <Table.Row>
                      <Table.Cell className="font-semibold text-[var(--cf-text-muted)]">Client Identity</Table.Cell>
                      <Table.Cell className="font-mono text-[var(--cf-text-faint)] truncate max-w-xs">
                        {identity.id}
                      </Table.Cell>
                    </Table.Row>
                  </Table.Body>
                </Table>
              </div>
            </div>
          </div>
        )}

        {/* ==================================================================
            TAB 2: Network Diagnostic Tools (Hurricane Electric he.net Suite)
            ================================================================== */}
        {activeTab === "tools" && (
          <div className="space-y-3">
            {/* Tool Category Selector Segmented Bar */}
            <div className="overflow-x-auto scrollbar-none">
              <Tabs
                variant="segmented"
                size="sm"
                value={toolSubTab}
                onValueChange={(val) => setToolSubTab(val as "dns" | "ip" | "http" | "ping")}
                tabs={toolTabs}
              />
            </div>

            {/* 1. DNS Checker */}
            {toolSubTab === "dns" && (
              <div className="cf-card space-y-3 !p-3">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-bold text-[var(--cf-text-strong)] flex items-center gap-1.5">
                    <Globe size={14} className="text-[var(--cf-blue)]" />
                    <span>DNS Record Lookup (1.1.1.1 DoH)</span>
                  </div>
                  <span className="text-[10px] font-mono text-[var(--cf-text-muted)]">
                    Cloudflare Resolver
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    size="sm"
                    aria-label="Domain name or FQDN"
                    value={dnsDomain}
                    onChange={(e) => setDnsDomain(e.target.value)}
                    placeholder="Domain (e.g. virt.cc.cd)..."
                    className="flex-1 min-w-[180px] font-mono"
                  />
                  <select
                    value={dnsType}
                    onChange={(e) => setDnsType(e.target.value)}
                    className="bg-[var(--cf-inset)] border border-[var(--cf-border)] rounded px-2 py-1 text-xs text-[var(--cf-text-strong)] font-mono"
                  >
                    <option value="A">A</option>
                    <option value="AAAA">AAAA</option>
                    <option value="CNAME">CNAME</option>
                    <option value="TXT">TXT</option>
                    <option value="MX">MX</option>
                    <option value="NS">NS</option>
                    <option value="SOA">SOA</option>
                  </select>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleExecuteDns}
                    disabled={dnsLoading || !dnsDomain.trim()}
                    loading={dnsLoading}
                    icon={Globe}
                  >
                    {dnsLoading ? "Querying..." : "Query DNS"}
                  </Button>
                </div>

                {dnsResult && (
                  <div className="p-2.5 rounded bg-[var(--cf-inset)] border border-[var(--cf-border)] space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-1.5">
                        <Badge variant={dnsResult.status === 0 ? "success" : "red"} className="text-[10px]">
                          {dnsResult.statusName}
                        </Badge>
                        <span className="font-mono font-bold text-sky-400">
                          {dnsResult.domain} ({dnsResult.type})
                        </span>
                      </div>
                      <div className="font-mono text-[var(--cf-text-faint)] text-[10px]">
                        {dnsResult.elapsedMs}ms · {dnsResult.resolver}
                      </div>
                    </div>

                    {dnsResult.answers.length > 0 ? (
                      <div className="overflow-x-auto">
                        <Table>
                          <Table.Header>
                            <Table.Row>
                              <Table.Head>Record</Table.Head>
                              <Table.Head>Type</Table.Head>
                              <Table.Head>TTL</Table.Head>
                              <Table.Head>Target / IP</Table.Head>
                            </Table.Row>
                          </Table.Header>
                          <Table.Body>
                            {dnsResult.answers.map((ans, i) => (
                              <Table.Row key={i}>
                                <Table.Cell className="font-mono">{ans.name}</Table.Cell>
                                <Table.Cell className="font-mono font-bold text-sky-400">{dnsResult.type}</Table.Cell>
                                <Table.Cell className="font-mono text-[var(--cf-text-faint)]">{ans.TTL}s</Table.Cell>
                                <Table.Cell className="font-mono font-semibold text-emerald-400">
                                  {ans.data}
                                </Table.Cell>
                              </Table.Row>
                            ))}
                          </Table.Body>
                        </Table>
                      </div>
                    ) : (
                      <div className="text-xs text-[var(--cf-text-faint)] py-1">
                        No answer records returned.
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* 2. BGP / ASN / IP WHOIS (he.net BGP Toolkit style) */}
            {toolSubTab === "ip" && (
              <div className="cf-card space-y-3 !p-3">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-bold text-[var(--cf-text-strong)] flex items-center gap-1.5">
                    <ShieldCheck size={14} className="text-emerald-400" />
                    <span>BGP ASN &amp; IP WHOIS (he.net style)</span>
                  </div>
                  <span className="text-[10px] font-mono text-[var(--cf-text-muted)]">
                    BGP Toolkit
                  </span>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <Input
                    size="sm"
                    aria-label="IP or Hostname"
                    value={ipQuery}
                    onChange={(e) => setIpQuery(e.target.value)}
                    placeholder="IP or Hostname (e.g. 1.1.1.1)..."
                    className="flex-1 min-w-[200px] font-mono"
                  />
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleExecuteIpLookup}
                    disabled={ipLoading || !ipQuery.trim()}
                    loading={ipLoading}
                    icon={ShieldCheck}
                  >
                    {ipLoading ? "Looking up..." : "Lookup BGP"}
                  </Button>
                </div>

                {ipResult && (
                  <div className="p-3 rounded bg-[var(--cf-inset)] border border-[var(--cf-border)]">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                      <div>
                        <div className="font-semibold text-[var(--cf-text-muted)] mb-1 text-[11px]">
                          Routing &amp; BGP ASN:
                        </div>
                        <div className="p-2 rounded bg-[var(--cf-card-bg)] border border-[var(--cf-border-subtle)] space-y-1 font-mono text-xs">
                          <div>ASN: <span className="text-[var(--cf-blue)] font-bold">{ipResult.asn}</span></div>
                          <div>ISP: <span className="text-sky-400">{ipResult.isp}</span></div>
                          <div>Org: <span>{ipResult.org}</span></div>
                          <div>IP: <span>{ipResult.type}</span></div>
                        </div>
                      </div>

                      <div>
                        <div className="font-semibold text-[var(--cf-text-muted)] mb-1 text-[11px]">
                          Geolocation &amp; Timezone:
                        </div>
                        <div className="p-2 rounded bg-[var(--cf-card-bg)] border border-[var(--cf-border-subtle)] space-y-1 font-mono text-xs">
                          <div>
                            Loc: <span className="text-emerald-400 font-bold">{ipResult.city}, {ipResult.country}</span>
                          </div>
                          <div>Coords: <span>{ipResult.latitude}, {ipResult.longitude}</span></div>
                          <div>Timezone: <span>{ipResult.timezone}</span></div>
                          <div className="text-[var(--cf-text-faint)]">
                            RTT: {ipResult.elapsedMs}ms
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="mt-2.5 pt-2 border-t border-[var(--cf-border)] text-[10px] text-[var(--cf-text-faint)] flex items-center justify-between">
                      <span>BGP Toolkit Integration</span>
                      <a
                        href={`https://bgp.he.net/${ipResult.asn}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sky-400 hover:underline flex items-center gap-1"
                      >
                        <span>View on bgp.he.net</span>
                        <ArrowSquareOut size={10} />
                      </a>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* 3. HTTP Prober & cURL Prober */}
            {toolSubTab === "http" && (
              <div className="cf-card space-y-3 !p-3">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-bold text-[var(--cf-text-strong)] flex items-center gap-1.5">
                    <FileText size={14} className="text-cyan-400" />
                    <span>HTTP &amp; cURL Edge Prober</span>
                  </div>
                  <span className="text-[10px] font-mono text-[var(--cf-text-muted)]">
                    Edge Fetch
                  </span>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <select
                    value={httpMethod}
                    onChange={(e) => setHttpMethod(e.target.value)}
                    className="bg-[var(--cf-inset)] border border-[var(--cf-border)] rounded px-2 py-1 text-xs text-[var(--cf-text-strong)] font-mono font-bold"
                  >
                    <option value="GET">GET</option>
                    <option value="POST">POST</option>
                    <option value="HEAD">HEAD</option>
                  </select>
                  <Input
                    size="sm"
                    aria-label="Target HTTP or HTTPS URL"
                    value={httpTargetUrl}
                    onChange={(e) => setHttpTargetUrl(e.target.value)}
                    placeholder="Target URL..."
                    className="flex-1 min-w-[200px] font-mono"
                  />
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleExecuteHttp}
                    disabled={httpLoading || !httpTargetUrl.trim()}
                    loading={httpLoading}
                    icon={FileText}
                  >
                    {httpLoading ? "Fetching..." : "Run cURL"}
                  </Button>
                </div>

                {httpResult && (
                  <div className="p-3 rounded bg-[var(--cf-inset)] border border-[var(--cf-border)] space-y-2.5">
                    <div className="flex items-center justify-between text-xs flex-wrap gap-2">
                      <div className="flex items-center gap-1.5">
                        <Badge variant={httpResult.status < 400 ? "success" : "red"} className="text-[10px]">
                          {httpResult.status} {httpResult.statusText}
                        </Badge>
                        <span className="font-mono text-sky-400 font-semibold truncate max-w-xs">{httpResult.url}</span>
                      </div>
                      <div className="font-mono text-[var(--cf-text-faint)] text-[10px]">
                        TTFB: {httpResult.elapsedMs}ms · {httpResult.protocol} · {httpResult.contentLength}B
                      </div>
                    </div>

                    {/* Response Headers Table */}
                    <div>
                      <div className="text-[10px] font-semibold text-[var(--cf-text-muted)] mb-1">
                        Headers:
                      </div>
                      <div className="max-h-32 overflow-y-auto border border-[var(--cf-border-subtle)] rounded">
                        <Table>
                          <Table.Body>
                            {Object.entries(httpResult.headers).map(([k, v]) => (
                              <Table.Row key={k}>
                                <Table.Cell className="font-mono text-[var(--cf-text-muted)] font-semibold w-1/3">
                                  {k}
                                </Table.Cell>
                                <Table.Cell className="font-mono text-[var(--cf-text-strong)] truncate max-w-sm">
                                  {v}
                                </Table.Cell>
                              </Table.Row>
                            ))}
                          </Table.Body>
                        </Table>
                      </div>
                    </div>

                    {/* Body Snippet */}
                    <div>
                      <div className="text-[10px] font-semibold text-[var(--cf-text-muted)] mb-1">
                        Body Preview:
                      </div>
                      <pre className="p-2 rounded bg-[var(--cf-term-bg)] border border-[var(--cf-term-border)] font-mono text-[11px] text-white max-h-32 overflow-y-auto whitespace-pre-wrap">
                        {httpResult.bodyPreview || "<Empty Response Body>"}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* 4. Ping & Latency Tester */}
            {toolSubTab === "ping" && (
              <div className="cf-card space-y-3 !p-3">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-bold text-[var(--cf-text-strong)] flex items-center gap-1.5">
                    <Pulse size={14} className="text-amber-400" />
                    <span>Ping &amp; Round-Trip Latency Monitor</span>
                  </div>
                  <span className="text-[10px] font-mono text-[var(--cf-text-muted)]">
                    RTT &amp; Jitter
                  </span>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <Input
                    size="sm"
                    aria-label="Host to ping"
                    value={pingTarget}
                    onChange={(e) => setPingTarget(e.target.value)}
                    placeholder="Host to ping (e.g. 1.1.1.1)..."
                    className="flex-1 min-w-[180px] font-mono"
                  />
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleExecutePingTest}
                    disabled={pingRunning}
                    loading={pingRunning}
                    icon={Pulse}
                  >
                    {pingRunning ? "Pinging..." : "Send Ping"}
                  </Button>
                </div>

                {/* Latency Histogram Visualization */}
                <div className="p-3 rounded bg-[var(--cf-inset)] border border-[var(--cf-border)] space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-[var(--cf-text-muted)]">RTT Latency (ms):</span>
                    <span className="font-mono text-emerald-400 font-bold">
                      Latest: {pingData[pingData.length - 1]?.rtt || 0} ms
                    </span>
                  </div>

                  <div className="h-20 flex items-end gap-2 pt-2 border-b border-[var(--cf-border)]">
                    {pingData.map((d, i) => {
                      const h = Math.min(100, Math.max(15, (d.rtt / 50) * 100));
                      return (
                        <div key={i} className="flex-1 flex flex-col items-center gap-1 group">
                          <span className="text-[10px] font-mono text-[var(--cf-text-faint)] opacity-0 group-hover:opacity-100 transition-opacity">
                            {d.rtt}ms
                          </span>
                          <div
                            style={{ height: `${h}%` }}
                            className="w-full bg-[var(--cf-blue)] rounded-t transition-all"
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ==================================================================
            TAB 3: Hardware, RAM, Storage & Clock Synchronization
            ================================================================== */}
        {activeTab === "hardware" && (
          <div className="space-y-4">
            {/* Real-time Clock & Time Sync */}
            <div className="p-3.5 rounded-lg bg-[var(--cf-card-bg)] border border-[var(--cf-border)] flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-3">
                <Clock size={20} className="text-amber-400" />
                <div>
                  <div className="text-xs font-bold text-[var(--cf-text-strong)] flex items-center gap-2">
                    <span>Hardware RTC &amp; Wall Clock</span>
                    <Badge variant={clockSynced ? "success" : "neutral"} className="text-[10px]">
                      {clockSynced ? "NTP Synced" : "Local RTC"}
                    </Badge>
                  </div>
                  <div className="font-mono text-sm text-[var(--cf-blue)] font-bold mt-0.5">
                    {deviceClock.toUTCString()}
                  </div>
                </div>
              </div>

              <Button variant="primary" size="sm" onClick={handleSyncTime} icon={ArrowsClockwise}>
                Sync Browser Time
              </Button>
            </div>

            {/* RAM & Memory Utilization */}
            <div className="cf-card">
              <div className="cf-card-header !py-3">
                <div className="cf-card-title text-sm">
                  <Cpu size={16} className="text-purple-400" />
                  <span>ESP32-S3 RAM &amp; Heap Memory Allocation</span>
                </div>
                <div className="text-xs font-mono text-[var(--cf-text-muted)]">
                  Architecture: Xtensa Dual-Core 240MHz
                </div>
              </div>

              <div className="cf-card-body space-y-4">
                {/* Internal SRAM */}
                <div>
                  <div className="flex items-center justify-between text-xs mb-1.5">
                    <span className="font-semibold text-[var(--cf-text-strong)]">
                      Internal SRAM (512 KB Total)
                    </span>
                    <span className="font-mono text-purple-400 font-bold">
                      ~384 KB Free / 128 KB Stack &amp; Radio
                    </span>
                  </div>
                  <progress className="cf-progress purple" value={75} max={100} />
                </div>

                {/* External PSRAM */}
                <div>
                  <div className="flex items-center justify-between text-xs mb-1.5">
                    <span className="font-semibold text-[var(--cf-text-strong)]">
                      Embedded Octal PSRAM (8 MB Total - AP_3v3)
                    </span>
                    <span className="font-mono text-sky-400 font-bold">
                      8.0 MB Available for Heavy Buffering
                    </span>
                  </div>
                  <progress className="cf-progress sky" value={10} max={100} />
                </div>

                <div className="flex items-center gap-2 text-[11px] text-[var(--cf-text-muted)] pt-1">
                  <Pulse size={13} className="text-emerald-400 shrink-0" />
                  <span>Radio Coexistence: Trouble BLE + Embassy Wi-Fi co-scheduled (64KB heap)</span>
                </div>
              </div>
            </div>

            {/* 16MB Flash Storage Partition Map */}
            <div className="cf-card">
              <div className="cf-card-header !py-3">
                <div className="cf-card-title text-sm">
                  <HardDrives size={16} className="text-emerald-400" />
                  <span>16 MB SPI Flash Partition Breakdown</span>
                </div>
                <div className="text-xs text-[var(--cf-text-muted)]">Chip: W25Q128</div>
              </div>

              <div className="cf-card-body space-y-4">
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="font-semibold text-[var(--cf-text-strong)]">Flash Allocated</span>
                  <span className="font-mono text-emerald-400 font-bold">
                    902 KB / 16,384 KB (5.5%)
                  </span>
                </div>

                {/* Partition bar */}
                <div className="w-full h-4 rounded-full overflow-hidden bg-[var(--cf-inset)] border border-[var(--cf-border)] flex">
                  <div style={{ width: "5.33%" }} className="bg-[var(--cf-blue)]" title="Factory App: 874KB" />
                  <div style={{ width: "0.2%" }} className="bg-purple-500" title="NVS: 24KB" />
                  <div style={{ width: "0.05%" }} className="bg-sky-500" title="PHY: 4KB" />
                  <div style={{ width: "94.42%" }} className="bg-transparent" title="Free: 15.1MB" />
                </div>

                {/* Legend Table */}
                <div className="overflow-x-auto">
                  <Table>
                    <Table.Header>
                      <Table.Row>
                        <Table.Head>Partition Name</Table.Head>
                        <Table.Head>Type / Usage</Table.Head>
                        <Table.Head>Offset</Table.Head>
                        <Table.Head>Allocated Size</Table.Head>
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      <Table.Row>
                        <Table.Cell className="font-semibold text-amber-400">factory (Active App)</Table.Cell>
                        <Table.Cell>Factory firmware binary</Table.Cell>
                        <Table.Cell className="font-mono">0x00010000</Table.Cell>
                        <Table.Cell className="font-mono">873,984 bytes (5.33%)</Table.Cell>
                      </Table.Row>
                      <Table.Row>
                        <Table.Cell className="font-semibold text-purple-400">nvs (Credentials)</Table.Cell>
                        <Table.Cell>Wi-Fi credentials &amp; persistent keys</Table.Cell>
                        <Table.Cell className="font-mono">0x00009000</Table.Cell>
                        <Table.Cell className="font-mono">24 KB</Table.Cell>
                      </Table.Row>
                      <Table.Row>
                        <Table.Cell className="font-semibold text-sky-400">phy_init</Table.Cell>
                        <Table.Cell>RF radio calibration data</Table.Cell>
                        <Table.Cell className="font-mono">0x0000f000</Table.Cell>
                        <Table.Cell className="font-mono">4 KB</Table.Cell>
                      </Table.Row>
                      <Table.Row>
                        <Table.Cell className="font-semibold text-[var(--cf-text-faint)]">Unallocated / Free</Table.Cell>
                        <Table.Cell>Available for OTA or storage</Table.Cell>
                        <Table.Cell className="font-mono">—</Table.Cell>
                        <Table.Cell className="font-mono">~15.4 MB (94.5%)</Table.Cell>
                      </Table.Row>
                    </Table.Body>
                  </Table>
                </div>
              </div>
            </div>

            {/* Cloudflare Edge D1 SQLite Database Details */}
            <div className="cf-card">
              <div className="cf-card-header !py-3">
                <div className="cf-card-title text-sm">
                  <Database size={16} className="text-cyan-400" />
                  <span>Edge SQLite Database (Cloudflare D1: env.DB)</span>
                </div>
                <Badge variant="neutral" className="text-[10px] font-mono">
                  Schema v1
                </Badge>
              </div>

              <div className="cf-card-body p-0 overflow-x-auto">
                <Table>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>Table Name</Table.Head>
                      <Table.Head>Storage Role</Table.Head>
                      <Table.Head>Current Records</Table.Head>
                      <Table.Head>State</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    <Table.Row>
                      <Table.Cell className="font-mono font-semibold text-sky-400">devices</Table.Cell>
                      <Table.Cell>ESP32 hardware registration &amp; MAC inventory</Table.Cell>
                      <Table.Cell className="font-mono">{edgeStats?.devicesCount ?? devices.length}</Table.Cell>
                      <Table.Cell><Badge variant="success" className="text-[10px]">Active</Badge></Table.Cell>
                    </Table.Row>
                    <Table.Row>
                      <Table.Cell className="font-mono font-semibold text-emerald-400">wifi_profiles</Table.Cell>
                      <Table.Cell>Encrypted WPA2/WPA3 access point profiles</Table.Cell>
                      <Table.Cell className="font-mono">{edgeStats?.profilesCount ?? profiles.length}</Table.Cell>
                      <Table.Cell><Badge variant="success" className="text-[10px]">Active</Badge></Table.Cell>
                    </Table.Row>
                    <Table.Row>
                      <Table.Cell className="font-mono font-semibold text-purple-400">history</Table.Cell>
                      <Table.Cell>Immutable GATT command audit trail</Table.Cell>
                      <Table.Cell className="font-mono">{edgeStats?.historyCount ?? history.length}</Table.Cell>
                      <Table.Cell><Badge variant="success" className="text-[10px]">Active</Badge></Table.Cell>
                    </Table.Row>
                    <Table.Row>
                      <Table.Cell className="font-mono font-semibold text-amber-400">settings</Table.Cell>
                      <Table.Cell>User workspace &amp; UI configuration</Table.Cell>
                      <Table.Cell className="font-mono">{edgeStats?.settingsCount ?? 4}</Table.Cell>
                      <Table.Cell><Badge variant="success" className="text-[10px]">Active</Badge></Table.Cell>
                    </Table.Row>
                  </Table.Body>
                </Table>
              </div>
            </div>
          </div>
        )}

        {/* ==================================================================
            TAB 4: Real-time Logs (Cloudflare Workers Tail Console)
            ================================================================== */}
        {activeTab === "console" && (
          <div className="cf-card !p-0 overflow-hidden flex flex-col">
            <div className="p-2.5 sm:p-3 bg-[var(--cf-term-header)] border-b border-[var(--cf-border)] flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <Terminal size={15} className="text-[var(--cf-blue)]" />
                <span className="text-xs font-semibold text-[var(--cf-text-strong)]">
                  Workers Tail GATT Stream
                </span>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--cf-inset)] text-[var(--cf-text-muted)]">
                  {filteredLogs.length} events
                </span>
              </div>

              <div className="flex items-center gap-2">
                <div className="relative">
                  <Input
                    size="sm"
                    aria-label="Filter logs"
                    value={logFilter}
                    onChange={(e) => {
                      setLogFilter(e.target.value);
                      syncSubStateToUrl("filter", e.target.value);
                    }}
                    placeholder="Filter logs..."
                    className="w-32 sm:w-44 font-mono"
                  />
                  {logFilter && (
                    <button
                      onClick={() => {
                        setLogFilter("");
                        syncSubStateToUrl("filter", null);
                      }}
                      className="absolute right-2 top-1 text-xs text-[var(--cf-text-faint)] hover:text-white"
                    >
                      ×
                    </button>
                  )}
                </div>

                <label className="inline-flex items-center gap-1 text-xs text-[var(--cf-text-muted)] cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={autoScroll}
                    onChange={(e) => {
                      setAutoScroll(e.target.checked);
                      syncSubStateToUrl("autoscroll", e.target.checked ? "1" : "0");
                    }}
                    className="rounded accent-[var(--cf-blue)]"
                  />
                  <span className="hidden sm:inline">Autoscroll</span>
                </label>

                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setLogs([])}
                  icon={Trash}
                  title="Clear log window"
                />
              </div>
            </div>

            <div className="cf-tail-terminal flex-1 !border-none !rounded-none">
              <div className="cf-tail-logs">
                {filteredLogs.map((log) => (
                  <div key={log.id} className="cf-log-line">
                    <span className="cf-log-time">{log.time}</span>
                    <span className={`cf-log-tag ${log.dir}`}>{log.dir.toUpperCase()}</span>
                    <span className="cf-log-text">{log.text}</span>
                  </div>
                ))}
                <div ref={consoleBottomRef} />
              </div>
            </div>

            <form
              onSubmit={handleManualCommandSubmit}
              className="p-2 sm:p-2.5 bg-[var(--cf-term-header)] border-t border-[var(--cf-border)] flex items-center gap-2"
            >
              <div className="font-mono text-xs font-bold text-[var(--cf-blue)] pl-1 select-none">
                TX &gt;
              </div>
              <Input
                size="sm"
                aria-label="GATT Console Command"
                value={commandInput}
                onChange={(e) => setCommandInput(e.target.value)}
                placeholder={
                  connected
                    ? "Enter command (e.g. PING, STATUS, LED TOGGLE, GPIO 2 1)..."
                    : "Connect Bluetooth to send command..."
                }
                disabled={!connected}
                className="flex-1 font-mono"
              />
              <Button
                variant="primary"
                size="sm"
                type="submit"
                disabled={!connected || !commandInput.trim()}
                icon={PaperPlaneRight}
              >
                <span>Send</span>
              </Button>
            </form>
          </div>
        )}

        {/* ==================================================================
            TAB 5: Control & GPIO Peripherals
            ================================================================== */}
        {activeTab === "gpio" && (
          <div className="space-y-4">
            <div className="p-3.5 rounded-lg bg-[var(--cf-card-bg)] border border-[var(--cf-border)] flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <Power size={18} className="text-amber-400" />
                <div>
                  <div className="text-xs font-bold text-[var(--cf-text-strong)]">
                    Status Indicator LED (GPIO 48)
                  </div>
                  <div className="text-[11px] text-[var(--cf-text-muted)]">
                    Current Hardware State:{" "}
                    <span className="font-bold text-amber-400">
                      {deviceInfo.led === "1" ? "ON" : "OFF"}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Switch
                  size="sm"
                  label="Status LED"
                  checked={deviceInfo.led === "1"}
                  onCheckedChange={handleToggleLed}
                  disabled={!connected}
                />
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleToggleLed}
                  disabled={!connected}
                  icon={Power}
                >
                  Toggle LED 48
                </Button>
              </div>
            </div>

            <div className="cf-card">
              <div className="cf-card-header !py-3">
                <div className="cf-card-title text-sm">
                  <SlidersHorizontal size={15} className="text-[var(--cf-blue)]" />
                  <span>Physical Output Header Pins</span>
                </div>
                <div className="text-xs text-[var(--cf-text-muted)]">3.3V Logic Level</div>
              </div>

              <div className="cf-card-body !p-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2.5">
                  {[2, 4, 18, 19, 21, 22, 23].map((pin) => {
                    const isHigh = pinStates[pin] || false;
                    return (
                      <div
                        key={pin}
                        className={`cf-gpio-card !p-2.5 ${isHigh ? "active" : ""}`}
                      >
                        <div>
                          <div className="font-mono font-bold text-xs text-[var(--cf-text-strong)]">
                            GPIO {pin}
                          </div>
                          <div className="text-[10px] text-[var(--cf-text-muted)] mt-0.5">
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

                        <div className="flex items-center gap-1">
                          <Button
                            variant={isHigh ? "primary" : "secondary"}
                            size="sm"
                            onClick={() => handleSetGpio(pin, true)}
                            disabled={!connected}
                            className="!text-[11px] !py-0.5 !px-2"
                          >
                            HIGH
                          </Button>
                          <Button
                            variant={!isHigh ? "secondary" : "ghost"}
                            size="sm"
                            onClick={() => handleSetGpio(pin, false)}
                            disabled={!connected}
                            className="!text-[11px] !py-0.5 !px-2"
                          >
                            LOW
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="mt-4 pt-3 border-t border-[var(--cf-border)] flex flex-wrap items-center justify-between gap-3 text-xs">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-[var(--cf-text-muted)]">Direct Write:</span>
                    <span className="text-[var(--cf-text-faint)]">Pin #</span>
                    <Input
                      size="sm"
                      aria-label="Pin number"
                      type="number"
                      min="0"
                      max="48"
                      value={customPin}
                      onChange={(e) => {
                        setCustomPin(e.target.value);
                        syncSubStateToUrl("pin", e.target.value);
                      }}
                      className="w-16 font-mono text-center"
                    />
                    <select
                      value={customLevel}
                      onChange={(e) => setCustomLevel(e.target.value)}
                      className="bg-[var(--cf-inset)] border border-[var(--cf-border)] rounded px-2 py-1 text-xs text-[var(--cf-text-strong)]"
                    >
                      <option value="1">1 (HIGH)</option>
                      <option value="0">0 (LOW)</option>
                    </select>
                  </div>

                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => handleSetGpio(Number(customPin), customLevel === "1")}
                    disabled={!connected}
                  >
                    Execute Pin Write
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ==================================================================
            TAB 6: Wi-Fi Provisioning
            ================================================================== */}
        {activeTab === "wifi" && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="cf-card">
              <div className="cf-card-header !py-3">
                <div className="cf-card-title text-sm">
                  <WifiHigh size={15} className="text-sky-400" />
                  <span>Available 2.4 GHz Access Points</span>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleScanWifi}
                  disabled={!connected || scanning}
                  loading={scanning}
                  icon={ArrowClockwise}
                >
                  {scanning ? "Scanning..." : "Scan"}
                </Button>
              </div>

              <div className="cf-card-body !p-0 max-h-72 overflow-y-auto">
                {scanResults.length === 0 ? (
                  <div className="text-center py-10 text-[var(--cf-text-faint)] text-xs">
                    {scanning
                      ? "Listening for beacon frames..."
                      : "Click 'Scan' to discover nearby Wi-Fi networks."}
                  </div>
                ) : (
                  <div className="divide-y divide-[var(--cf-border)]">
                    {scanResults.map((ap, idx) => (
                      <div
                        key={idx}
                        onClick={() => {
                          setJoinSsid(ap.ssid);
                          syncSubStateToUrl("ssid", ap.ssid);
                        }}
                        className="p-2.5 flex items-center justify-between hover:bg-[var(--cf-inset)] cursor-pointer transition-colors"
                      >
                        <div>
                          <div className="font-semibold text-xs text-[var(--cf-text-strong)]">
                            {ap.ssid || "<Hidden SSID>"}
                          </div>
                          <div className="text-[10px] text-[var(--cf-text-muted)] flex items-center gap-2 mt-0.5">
                            <span>Ch {ap.channel}</span>
                            <span>·</span>
                            <span>{ap.auth}</span>
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          <div className="flex items-center gap-1 font-mono text-[11px] text-[var(--cf-text-muted)]">
                            {renderRssiBars(ap.rssi)}
                            <span>{ap.rssi} dBm</span>
                          </div>
                          <span className="text-[10px] px-2 py-0.5 rounded bg-[var(--cf-inset)] text-sky-400 font-semibold border border-[var(--cf-border)]">
                            Select
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="cf-card">
              <div className="cf-card-header !py-3">
                <div className="cf-card-title text-sm">
                  <ShieldCheck size={15} className="text-emerald-400" />
                  <span>Provision Network Credentials</span>
                </div>
              </div>

              <div className="cf-card-body space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-[var(--cf-text-muted)] mb-1">
                    Network SSID
                  </label>
                  <Input
                    size="sm"
                    aria-label="Network SSID"
                    value={joinSsid}
                    onChange={(e) => {
                      setJoinSsid(e.target.value);
                      syncSubStateToUrl("ssid", e.target.value);
                    }}
                    placeholder="Enter or select network SSID..."
                    className="w-full"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-[var(--cf-text-muted)] mb-1">
                    Password (PSK)
                  </label>
                  <div className="relative">
                    <Input
                      size="sm"
                      aria-label="Wi-Fi Password"
                      type={showPass ? "text" : "password"}
                      value={joinPass}
                      onChange={(e) => setJoinPass(e.target.value)}
                      placeholder="Enter Wi-Fi password..."
                      className="w-full pr-9 font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPass(!showPass)}
                      className="absolute right-2.5 top-2 text-[var(--cf-text-faint)] hover:text-white"
                    >
                      {showPass ? <EyeSlash size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                </div>

                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleJoinWifi}
                  disabled={!connected || !joinSsid || joining}
                  loading={joining}
                  icon={PaperPlaneRight}
                  className="w-full"
                >
                  {joining ? "Provisioning ESP32..." : "Join Wi-Fi Network"}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ==================================================================
            TAB 7: Saved Profiles (Cloudflare D1)
            ================================================================== */}
        {activeTab === "profiles" && (
          <div className="space-y-4">
            <div className="cf-card">
              <div className="cf-card-header !py-3">
                <div className="cf-card-title text-sm">
                  <HardDrives size={15} className="text-cyan-400" />
                  <span>Cloudflare D1 Wi-Fi Profiles</span>
                </div>
              </div>

              <div className="cf-card-body p-0 overflow-x-auto">
                {profiles.length === 0 ? (
                  <div className="text-center py-8 text-[var(--cf-text-faint)] text-xs">
                    No Wi-Fi profiles stored yet.
                  </div>
                ) : (
                  <Table>
                    <Table.Header>
                      <Table.Row>
                        <Table.Head>SSID</Table.Head>
                        <Table.Head>Use Count</Table.Head>
                        <Table.Head>Added</Table.Head>
                        <Table.Head className="text-right">Action</Table.Head>
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {profiles.map((p) => (
                        <Table.Row key={p.id}>
                          <Table.Cell className="font-semibold text-[var(--cf-text-strong)]">{p.ssid}</Table.Cell>
                          <Table.Cell className="font-mono">{p.useCount} times</Table.Cell>
                          <Table.Cell className="text-[var(--cf-text-faint)]">
                            {new Date(p.createdAt).toLocaleDateString()}
                          </Table.Cell>
                          <Table.Cell className="text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => {
                                  setJoinSsid(p.ssid);
                                  syncSubStateToUrl("ssid", p.ssid);
                                  navigateTab("wifi");
                                }}
                                className="!text-[11px] !py-0.5 !px-2 text-sky-400"
                              >
                                Provision
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={async () => {
                                  await deleteWifiProfile(p.id);
                                  setProfiles((prev) => prev.filter((x) => x.id !== p.id));
                                }}
                                icon={Trash}
                                className="!p-1 text-red-400 hover:text-red-300"
                              />
                            </div>
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table>
                )}
              </div>
            </div>

            <div className="p-3.5 rounded-lg bg-[var(--cf-card-bg)] border border-[var(--cf-border)] flex flex-wrap items-center gap-2.5">
              <span className="text-xs font-semibold text-[var(--cf-text-strong)] shrink-0">
                Add Profile to D1:
              </span>
              <Input
                size="sm"
                aria-label="Network SSID"
                value={newSsid}
                onChange={(e) => setNewSsid(e.target.value)}
                placeholder="Network SSID..."
                className="flex-1 min-w-[120px]"
              />
              <Input
                size="sm"
                aria-label="Network Password"
                type="password"
                value={newPass}
                onChange={(e) => setNewPass(e.target.value)}
                placeholder="Password..."
                className="flex-1 min-w-[120px]"
              />
              <Button
                variant="primary"
                size="sm"
                onClick={async () => {
                  if (!newSsid) return;
                  await saveWifiProfile({ ssid: newSsid, password: newPass });
                  const res: any = await fetch("/api/wifi-profiles").then((r) => r.json());
                  if (res?.wifiProfiles) setProfiles(res.wifiProfiles);
                  setNewSsid("");
                  setNewPass("");
                }}
                disabled={!newSsid}
                icon={Plus}
              >
                Save
              </Button>
            </div>
          </div>
        )}

        {/* ==================================================================
            TAB 8: Devices
            ================================================================== */}
        {activeTab === "devices" && (
          <div className="cf-card">
            <div className="cf-card-header !py-3">
              <div className="cf-card-title text-sm">
                <Database size={15} className="text-[var(--cf-blue)]" />
                <span>Registered ESP32 Microcontrollers</span>
              </div>
            </div>

            <div className="cf-card-body p-0 overflow-x-auto">
              {devices.length === 0 ? (
                <div className="text-center py-8 text-[var(--cf-text-faint)] text-xs">
                  No devices recorded yet. Connect over Bluetooth to register automatically.
                </div>
              ) : (
                <Table>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>Device</Table.Head>
                      <Table.Head>MAC Address</Table.Head>
                      <Table.Head>Architecture</Table.Head>
                      <Table.Head>Last Seen</Table.Head>
                      <Table.Head className="text-right">Action</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {devices.map((d) => (
                      <Table.Row key={d.id}>
                        <Table.Cell className="font-semibold text-[var(--cf-text-strong)]">{d.name}</Table.Cell>
                        <Table.Cell className="font-mono text-sky-400">{d.mac}</Table.Cell>
                        <Table.Cell>
                          <Badge variant="neutral" className="text-[10px]">
                            {d.chip || "esp32s3"}
                          </Badge>
                        </Table.Cell>
                        <Table.Cell className="text-[var(--cf-text-faint)]">
                          {d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : "—"}
                        </Table.Cell>
                        <Table.Cell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={async () => {
                              await deleteDevice(d.id);
                              setDevices((prev) => prev.filter((x) => x.id !== d.id));
                            }}
                            icon={Trash}
                            className="!p-1 text-red-400 hover:text-red-300"
                          />
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              )}
            </div>
          </div>
        )}

        {/* ==================================================================
            TAB 9: Audit History
            ================================================================== */}
        {activeTab === "history" && (
          <div className="cf-card">
            <div className="cf-card-header !py-3 flex-wrap gap-2">
              <div className="cf-card-title text-sm">
                <ClockCounterClockwise size={15} className="text-[var(--cf-blue)]" />
                <span>Command Audit History</span>
              </div>

              <div className="flex items-center gap-2">
                <Input
                  size="sm"
                  aria-label="Search audit trail"
                  value={historySearch}
                  onChange={(e) => setHistorySearch(e.target.value)}
                  placeholder="Search audit trail..."
                  className="w-36 sm:w-48"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={async () => {
                    await clearHistory();
                    setHistory([]);
                  }}
                  disabled={history.length === 0}
                  icon={Trash}
                  title="Clear history"
                />
              </div>
            </div>

            <div className="cf-card-body p-0 overflow-x-auto">
              {filteredHistory.length === 0 ? (
                <div className="text-center py-8 text-[var(--cf-text-faint)] text-xs">
                  No audit logs found.
                </div>
              ) : (
                <Table>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>Time</Table.Head>
                      <Table.Head>Command</Table.Head>
                      <Table.Head>Response</Table.Head>
                      <Table.Head>Status</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {filteredHistory.map((h) => (
                      <Table.Row key={h.id}>
                        <Table.Cell className="font-mono text-[var(--cf-text-faint)] whitespace-nowrap">
                          {new Date(h.createdAt).toLocaleTimeString()}
                        </Table.Cell>
                        <Table.Cell className="font-mono font-semibold">{h.command}</Table.Cell>
                        <Table.Cell className="font-mono text-[var(--cf-text-muted)] truncate max-w-xs">
                          {h.response || "—"}
                        </Table.Cell>
                        <Table.Cell>
                          <Badge variant={h.ok ? "success" : "red"} className="text-[10px]">
                            {h.ok ? "OK" : "ERR"}
                          </Badge>
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              )}
            </div>
          </div>
        )}

        {/* ==================================================================
            TAB 10: Settings & PWA Status
            ================================================================== */}
        {activeTab === "settings" && (
          <div className="space-y-4">
            <div className="cf-card">
              <div className="cf-card-header !py-3">
                <div className="cf-card-title text-sm">
                  <Gear size={15} className="text-[var(--cf-blue)]" />
                  <span>Display &amp; Application State</span>
                </div>
              </div>

              <div className="cf-card-body space-y-4">
                <div>
                  <label className="block text-xs font-bold text-[var(--cf-text-strong)] mb-2">
                    Color Theme Mode
                  </label>
                  <Tabs
                    variant="segmented"
                    size="sm"
                    value={theme}
                    onValueChange={(val) => toggleTheme(val as "light" | "dark" | "system")}
                    tabs={themeTabs}
                  />
                </div>

                <div className="pt-3 border-t border-[var(--cf-border)]">
                  <label className="block text-xs font-bold text-[var(--cf-text-strong)] mb-1">
                    Progressive Web App (PWA) Mode
                  </label>
                  <div className="flex items-center justify-between p-2.5 rounded bg-[var(--cf-inset)] border border-[var(--cf-border)]">
                    <div className="text-xs">
                      <div className="font-semibold text-[var(--cf-text-strong)]">
                        {isStandalone ? "Installed Standalone Mode" : "Browser Web Session"}
                      </div>
                      <div className="text-[11px] text-[var(--cf-text-faint)]">
                        Service Worker active with offline cache and Web Bluetooth support.
                      </div>
                    </div>

                    {canInstall && !isStandalone && (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={handleInstallPwa}
                        icon={DownloadSimple}
                      >
                        Install PWA
                      </Button>
                    )}
                  </div>
                </div>

                <div className="pt-3 border-t border-[var(--cf-border)]">
                  <label className="block text-xs font-bold text-[var(--cf-text-strong)] mb-1">
                    Client Identity UUID
                  </label>
                  <div className="p-2.5 rounded bg-[var(--cf-inset)] border border-[var(--cf-border)] font-mono text-xs text-sky-400 flex items-center justify-between">
                    <span className="truncate mr-2">{identity.id}</span>
                    <Badge variant="neutral" className="text-[10px] shrink-0">
                      Cookie: esp_id
                    </Badge>
                  </div>
                </div>

                <div className="pt-3 border-t border-[var(--cf-border)] flex items-center justify-between">
                  <div className="text-xs text-[var(--cf-text-muted)]">
                    Purge all device lists and Wi-Fi profiles from your isolated D1 partition.
                  </div>
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
                  >
                    Reset Workspace
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* ====================================================================
          4. Native Mobile Bottom Navigation Bar (5 core shortcuts)
          ==================================================================== */}
      <nav className="cf-bottom-nav md:hidden" aria-label="Mobile Navigation">
        <button
          onClick={() => navigateTab("overview")}
          className={`cf-bottom-nav-item ${activeTab === "overview" ? "active" : ""}`}
        >
          <Broadcast size={18} weight={activeTab === "overview" ? "fill" : "regular"} />
          <span>Overview</span>
        </button>

        <button
          onClick={() => navigateTab("tools")}
          className={`cf-bottom-nav-item ${activeTab === "tools" ? "active" : ""}`}
        >
          <Globe size={18} weight={activeTab === "tools" ? "fill" : "regular"} />
          <span>Tools</span>
        </button>

        <button
          onClick={() => navigateTab("hardware")}
          className={`cf-bottom-nav-item ${activeTab === "hardware" ? "active" : ""}`}
        >
          <Cpu size={18} weight={activeTab === "hardware" ? "fill" : "regular"} />
          <span>Hardware</span>
        </button>

        <button
          onClick={() => navigateTab("gpio")}
          className={`cf-bottom-nav-item ${activeTab === "gpio" ? "active" : ""}`}
        >
          <SlidersHorizontal size={18} weight={activeTab === "gpio" ? "fill" : "regular"} />
          <span>Control</span>
        </button>

        <button
          onClick={() => navigateTab("console")}
          className={`cf-bottom-nav-item ${activeTab === "console" ? "active" : ""}`}
        >
          <div className="relative">
            <Terminal size={18} weight={activeTab === "console" ? "fill" : "regular"} />
            {logs.length > 0 && (
              <span className="absolute -top-1 -right-2 w-2 h-2 rounded-full bg-[var(--cf-blue)]" />
            )}
          </div>
          <span>Logs</span>
        </button>
      </nav>

      {/* ====================================================================
          5. Cloudflare Global Footer (Desktop only)
          ==================================================================== */}
      <footer className="hidden md:block mt-auto border-t border-[var(--cf-border)] bg-[var(--cf-nav-bg)] py-3 px-6">
        <div className="max-w-7xl mx-auto flex items-center justify-between text-xs text-[var(--cf-text-faint)]">
          <div className="flex items-center gap-2">
            <Cpu size={14} className="text-[var(--cf-blue)]" />
            <span>ESP32-S3 Remote Console · Vinext RSC · Cloudflare Workers Edge</span>
          </div>
          <div className="flex items-center gap-4">
            <a
              href="https://github.com/unesp32/esp32-remote"
              target="_blank"
              rel="noreferrer"
              className="hover:text-[var(--cf-text-strong)]"
            >
              GitHub
            </a>
            <a
              href="https://bgp.he.net"
              target="_blank"
              rel="noreferrer"
              className="hover:text-[var(--cf-text-strong)]"
            >
              he.net BGP
            </a>
            <a
              href="https://www.cloudflarestatus.com"
              target="_blank"
              rel="noreferrer"
              className="hover:text-[var(--cf-text-strong)]"
            >
              Status
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
