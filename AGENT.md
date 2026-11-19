# AGENT HANDOFF & ARCHITECTURE MANUAL

> **Status**: Production Live (`https://esp.virt.cc.cd`)  
> **Firmware**: Flashed & Active on ESP32-S3 (`e0:72:a1:f6:10:0c`)  
> **Latest Stack**: ESP32-S3 Rust (`no_std`) + Cloudflare Workers / D1 + `vinext` + `@cloudflare/kumo`

This document is the single source of truth for any AI agent or engineer picking up this codebase. It documents the complete system architecture, hardware configuration, protocol specifics, operational runbooks, and known traps.

---

## 1. System Overview

```
┌────────────────────────────────────────────────────────┐
│                   ESP32-S3 Hardware                    │
│  - esp-hal + esp-radio + trouble-host (GATT Server)    │
│  - MAC: e0:72:a1:f6:10:0c                              │
│  - Serial: /dev/cu.usbmodem11201                       │
│  - Line protocol: PING, INFO, STATUS, LED, SCAN, JOIN  │
└───────────────────────────▲────────────────────────────┘
                            │ Web Bluetooth (BLE GATT)
                            │ Service: 937312e0-2354-11eb-9f10-fbc30a62cf38
┌───────────────────────────▼────────────────────────────┐
│         Frontend: Kumo UI + Vinext (React 19)          │
│  - App Router on Vite (`vinext`), Cloudflare Build     │
│  - Design system: `@cloudflare/kumo` + Phosphor Icons  │
│  - Web Bluetooth API (navigator.bluetooth)             │
│  - Anonymous workspace identity cookie (`esp_id`)      │
└───────────────────────────▲────────────────────────────┘
                            │ Server Actions / API (/api/*)
┌───────────────────────────▼────────────────────────────┐
│         Backend: Cloudflare Workers + D1               │
│  - Domain: https://esp.virt.cc.cd                      │
│  - D1 Database: `esp32-remote` (binding: `env.DB`)     │
│  - Schema: owners, devices, wifi_profiles, history, kv │
│  - Owner-partitioned for seamless future auth swap     │
└────────────────────────────────────────────────────────┘
```

---

## 2. Quick Command Reference

| Action | Command | Purpose |
| :--- | :--- | :--- |
| **Test BLE Over The Air** | `make test-ble` (or `python3 scripts/ble_test.py`) | Runs full OTA BLE handshake, subscriptions, PING, INFO, STATUS, LED |
| **Test API & D1 Database** | `make test-api` (or `python3 scripts/smoke_api.py https://esp.virt.cc.cd`) | Exercises every D1 REST endpoint, identity isolation, and persistence |
| **Build Web Application** | `make build-web` (or `cd web && npm run check && npm run build`) | Runs TypeScript typecheck and bundles Vinext + Kumo into Cloudflare format |
| **Deploy Site to Production** | `make deploy-web` (or `cd web && cf deploy`) | Deploys Worker + Static Assets to `esp.virt.cc.cd` using Cloudflare `cf` CLI |
| **Build Firmware** | `make build-firmware` | Builds Xtensa Rust `no_std` release ELF using `esp` toolchain |
| **Flash Firmware to ESP32** | `make flash-firmware` | Flashes release binary to `/dev/cu.usbmodem11201` via `espflash` |
| **Verify Everything** | `make verify-all` | Runs API smoke test, BLE hardware OTA test, and typecheck |

---

## 3. Bluetooth LE Architecture & Known Pitfalls

### GATT Surface
- **Primary Service UUID**: `937312e0-2354-11eb-9f10-fbc30a62cf38`
- **Control Characteristic UUID**: `937312e1-2354-11eb-9f10-fbc30a62cf38` (`Write with response`, `Read`, `Notify`)
- **Status Characteristic UUID**: `937312e2-2354-11eb-9f10-fbc30a62cf38` (`Read`, `Notify`)
- **Device Local Name Prefix**: `esp32-remote`

### Critical Gotchas (MUST READ)
1. **OS Pairing vs Web Bluetooth**:
   - The ESP32 firmware implements an **unbonded, unencrypted LE GATT server**.
   - **DO NOT attempt to pair the ESP32 in macOS System Settings or Windows Bluetooth Settings**. The OS will report pairing failure because it has no HID or cryptographic bonding.
   - Web Bluetooth connects directly inside Chrome/Edge via `navigator.bluetooth.requestDevice`.
2. **`CONNECTIONS_MAX = 1`**:
   - `firmware/src/gatt.rs` sets `CONNECTIONS_MAX: usize = 1`.
   - The ESP32 only allows **one central at a time**. If a Python test or browser tab holds the connection, other centrals cannot connect. Always disconnect after tests.
3. **CCCD Descriptor Writes in `trouble-host`**:
   - When a client subscribes to notifications (`startNotifications()` or `start_notify()`), it writes `\x01\x00` to the Client Characteristic Configuration Descriptor (CCCD, handles 10 and 13).
   - In `trouble-host`, `GattEvent::Write` fires for both characteristic and descriptor writes.
   - **Crucial Fix in `firmware/src/main.rs`**: The write handler checks `write.handle() == server.remote.control.handle`. If it does not match (e.g. CCCD write), it accepts the event but **does not** parse it as a command. Without this check, the firmware responds with `ERR unknown command \x01\x00` on subscription.

---

## 4. Line Protocol Specification

All communication occurs over the `CONTROL` characteristic as printable ASCII terminated by `\n` (max 240 bytes).

| Direction | Format | Description / Example |
| :--- | :--- | :--- |
| **TX** | `PING` | Health check |
| **RX** | `OK PONG` | Health acknowledgement |
| **TX** | `INFO` | Request hardware metadata |
| **RX** | `OK INFO name=esp32-remote chip=esp32s3 fw=0.1.0 mac=e072a1f6100c` | Board identity |
| **TX** | `STATUS` | Request Wi-Fi & telemetry status |
| **RX** | `OK STATUS wifi=down ip=- ssid= rssi=- led=0` | Current network & LED status |
| **TX** | `LED <ON\|OFF\|TOGGLE>` | Control onboard RGB LED (GPIO 48) |
| **RX** | `OK LED <0\|1>` | Updated LED state |
| **TX** | `GPIO <pin> <0\|1>` | Drive general-purpose output pin |
| **RX** | `OK GPIO <pin> <0\|1>` | Confirmation of pin level |
| **TX** | `SCAN` | Trigger 2.4GHz Wi-Fi scan |
| **RX (Async)** | `OK AP ssid=<name> rssi=<dBm> chan=<ch> auth=<type>` | Discovered access point |
| **RX (Final)** | `OK SCAN_DONE count=<N>` | Scan complete |
| **TX** | `JOIN ssid=<SSID> pass=<PASSWORD>` | Provision Wi-Fi credentials |
| **RX** | `OK JOIN connected ip=<IP>` or `ERR JOIN failed` | Provisioning outcome |

---

## 5. Web & Backend Architecture

### Tech Stack
- **Framework**: `vinext` (Next.js App Router compatible, running on Vite)
- **UI Components**: `@cloudflare/kumo` (Cloudflare Design System) + `@phosphor-icons/react`
- **Host Runtime**: Cloudflare Workers + D1 database binding (`env.DB`)
- **Deployment**: Cloudflare `cf` CLI (`cf deploy` configured via `cloudflare.config.ts`)

### File Structure
- `web/app/`: Next.js App Router pages and layout.
  - `page.tsx`: Server Component, queries D1 for caller data, renders `Dashboard`.
  - `layout.tsx`: Root layout with `@cloudflare/kumo/styles/standalone` and dark theme.
  - `actions.ts`: `"use server"` actions providing typed mutations for devices, Wi-Fi profiles, and history.
  - `components/Dashboard.tsx`: Rich client component handling Web Bluetooth, console, Wi-Fi scanner, and D1 management.
  - `api/[[...path]]/route.ts`: Public JSON API router (`/api/*`), verified by `scripts/smoke_api.py`.
- `web/proxy.ts`: Identity proxy / middleware that mints and verifies the `esp_id` cookie and `x-esp-identity` header.
- `web/src/server.ts`: Server-side request context (`getRequestContext`), isolate-level schema bootstrap, and D1 store accessor.
- `web/src/db.ts`: Owner-partitioned database queries (`listDevices`, `listWifiProfiles`, `listHistory`, etc.).
- `web/src/schema.ts`: D1 SQLite schema definition and migration manager.
- `web/src/protocol.ts`: TypeScript mirror of the GATT UUIDs, line protocol parser, and command builders.

---

## 6. Firmware Architecture

### Tech Stack
- **Toolchain**: Xtensa Rust (`esp` channel from `espup`)
- **Target**: `xtensa-esp32s3-none-elf`
- **Frameworks**:
  - `esp-hal`: Bare-metal hardware abstraction layer for ESP32-S3
  - `esp-radio`: Native Wi-Fi and Bluetooth controller
  - `trouble-host`: Pure-Rust `no_std` Bluetooth Low Energy host stack
  - `embassy-executor` + `embassy-net`: Async task executor and network stack

### File Structure
- `firmware/src/main.rs`: Entry point, BLE task, Wi-Fi task, GATT event loop, command dispatcher.
- `firmware/src/gatt.rs`: BLE GATT service definition (`RemoteService`, characteristics, UUIDs).
- `firmware/src/protocol.rs`: Zero-allocation line protocol parser and command types.
- `firmware/rust-toolchain.toml`: Configures `channel = "esp"`.
- `firmware/.cargo/config.toml`: Target configuration and runner (`espflash`).

### Flashing Instructions
```bash
# In repo root:
source /Users/amit/export-esp.sh
unset RUSTUP_TOOLCHAIN
cd firmware
cargo build --release
espflash flash --port /dev/cu.usbmodem11201 target/xtensa-esp32s3-none-elf/release/esp32-remote-firmware
```

---

## 7. Current Project State & Completed Work

| Component | Status | Details |
| :--- | :--- | :--- |
| **ESP32 BLE GATT Server** | **WORKING** | Fixed CCCD handle check; verified zero spurious errors on subscription. |
| **ESP32 Wi-Fi & NVS** | **WORKING** | Supports scanning and joining networks; credentials stored in NVS. |
| **ESP32 Hardware** | **FLASHED** | Running on physical ESP32-S3 (`e0:72:a1:f6:10:0c`). |
| **Kumo UI + Vinext** | **WORKING** | Complete dashboard with telemetry, console, Wi-Fi scanner, D1 profiles. |
| **Cloudflare Worker & D1**| **DEPLOYED** | Live at `https://esp.virt.cc.cd` with 100% passing smoke tests. |
| **Automated BLE Test** | **WORKING** | `scripts/ble_test.py` tests full handshake and command responses OTA. |
| **CI / CD Workflows** | **CONFIGURED**| `.github/workflows/ci.yml` and `deploy.yml` validate types, build, and deploy. |

---

## 8. Next Milestones for Future Agents

1. **Auto-Reconnect on Disconnect**: Implement exponential-backoff BLE reconnection in `Dashboard.tsx` if link drops unexpectedly.
2. **Direct ESP32 WebSocket / MQTT Backhaul**: Once the ESP32 joins Wi-Fi, establish a direct WebSocket connection from the ESP32 to the Cloudflare Worker so control can switch seamlessly from Bluetooth to Internet.
3. **Multi-device Picker**: Support managing multiple ESP32 boards simultaneously in the UI.
4. **Cloudflare Zero Trust Authentication**: When real user auth is desired, swap `web/proxy.ts` to inspect Cloudflare Access JWTs (`Cf-Access-Jwt-Assertion`) instead of anonymous UUID cookies.
