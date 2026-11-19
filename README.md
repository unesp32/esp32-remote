# esp32-remote

Control an **ESP32-S3** from a website — over **Bluetooth**, no app install needed.

The ESP32-S3 runs **Rust firmware** (`no_std`, `esp-hal` + `esp-radio` + `trouble-host`).
The website runs on **Cloudflare Workers + D1** at **https://esp.virt.cc.cd** and talks to
the board using the browser's **Web Bluetooth** API.

```
┌───────────────────────────────┐        BLE (GATT)        ┌────────────────────┐
│  esp.virt.cc.cd               │ ◄──────────────────────► │  ESP32-S3          │
│  Cloudflare Worker (TypeScript)│   Web Bluetooth API     │  Rust firmware     │
│  + D1 (devices, Wi-Fi, history)│                         │  esp-hal/esp-radio │
└───────────────────────────────┘                          └─────────┬──────────┘
                                                                     │ Wi-Fi (provisioned
                                                                     │ over BLE)
                                                              ┌──────▼──────────┐
                                                              │ Local network   │
                                                              │ + cloud         │
                                                              └─────────────────┘
```

## First feature: Wi-Fi provisioning over BLE

The ESP ships with **no stored Wi-Fi credentials**, so you can take it anywhere:

1. Plug the ESP32-S3 into USB (power + flashing).
2. Open https://esp.virt.cc.cd in **Chrome / Edge / Opera** (Web Bluetooth needs HTTPS).
3. Press **Connect to ESP32** → pick `esp32-remote` in the Bluetooth picker.
4. Open the **Wi-Fi** tab → press **Scan**. The ESP scans and streams back nearby
   networks with signal strength.
5. Pick your network (or type the SSID), enter the password, press
   **Connect ESP to Wi-Fi**.
6. The ESP joins the network and reports its IP address back to the page.

The network is remembered server-side, so next time you just press **Connect** on the
saved profile.

## What the site persists

This is a real application, not a static page. Everything below is stored in **D1**
against an anonymous per-browser workspace id:

| Data             | Table           | Notes                                                     |
| ---------------- | --------------- | --------------------------------------------------------- |
| Devices          | `devices`       | MAC, name, chip, firmware, notes, last-seen               |
| Wi-Fi profiles   | `wifi_profiles` | SSID, password, security, band, use count                 |
| Control history  | `history`       | Every command sent and its response, newest first         |
| Site settings    | `settings`      | Theme, timestamps, auto-reconnect                         |
| Anything else    | `kv`            | Generic namespaced key/value store                        |

Export the whole workspace as JSON (or reset it) from the **Settings** tab.

## Repository layout

| Path            | What it is                                                          |
| --------------- | ------------------------------------------------------------------- |
| `firmware/`     | Rust firmware for the ESP32-S3 (`no_std`, Xtensa target)           |
| `web/`          | Cloudflare Worker + D1 backend and the browser app (Vite bundled)   |
| `scripts/`      | Verification tools: API smoke test and BLE over-the-air scan        |
| `.github/`      | Issue templates, PR template, CI and deploy workflows               |

## Branch model

| Branch       | Purpose                                                          |
| ------------ | ---------------------------------------------------------------- |
| `main`       | Always deployable. CI runs here and the site deploys from here.  |
| `dev`        | Integration branch — merge feature branches here first.          |
| `feat/*`     | One branch per piece of work.                                    |
| `fix/*`      | One branch per bug fix.                                          |

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow.

## Firmware quickstart

Prerequisites: [espup](https://github.com/esp-rs/espup) Xtensa toolchain + `espflash`.

```sh
. ~/export-esp.sh                 # espup toolchain env (add to your shell rc)
cd firmware
cargo build --release
cargo run --release               # espflash flash --monitor
```

`RUSTUP_TOOLCHAIN` (set by some version managers such as mise) overrides
`rust-toolchain.toml`, so unset it if the build picks the wrong toolchain:

```sh
env -u RUSTUP_TOOLCHAIN cargo build --release
```

### Verify the board is really on the air

`cargo run` printing an advertising loop only proves the controller accepted the
command. To prove a frame left the antenna, scan for it:

```sh
python3 -m pip install bleak
python3 scripts/ble_scan.py            # looks for the "esp32-remote" name
python3 scripts/ble_scan.py --connect  # also connects and lists GATT services
```

Run it from **Terminal.app** (or any app granted Bluetooth access): macOS gives
Bluetooth permission to the *responsible process*, so a sandboxed or
permission-less parent process hangs without ever seeing a device. The board
must be plugged in over USB — an unplugged board obviously advertises nothing.

## Website quickstart

```sh
cd web
npm install
npm run dev        # local worker + assets on http://localhost:5173
npm run check      # tsc --noEmit
npm run build      # emit Build Output to .cloudflare/output/v1/
npm run deploy     # build + deploy to Cloudflare
```

The CLI used is **`cf`**, not `wrangler` — it is pinned in `web/package.json`
alongside the matching `@cloudflare/vite-plugin`, because the two must agree on the
Build Output specification version. Keep them in sync when upgrading.

Custom domain `esp.virt.cc.cd` is attached to the Worker on the `virt.cc.cd` zone.

### Environment

| Name               | Where                    | Used for                                   |
| ------------------ | ------------------------ | ------------------------------------------ |
| `CLOUDFLARE_API_TOKEN` | CI secret / your shell | Deploying the Worker and D1                |
| `CLOUDFLARE_ACCOUNT_ID` | CI secret / your shell | The account the Worker and D1 live in      |

Both are set as repository secrets, so the `Deploy` workflow runs without any
local login. The token is scoped to Workers Scripts/Editor, D1, Workers
Observability and Workers Routes (zone `virt.cc.cd`) — nothing else.

D1 database `esp32-remote` is declared in `web/cloudflare.config.ts` and provisioned
automatically on first deploy; the binding is `env.DB`.

## Browser support

Web Bluetooth works in **Chrome / Edge / Opera** on desktop and Android.
**Firefox and Safari do not support it** (iOS Safari included). The site detects this
and shows a friendly message.

## Security notes

- **No authentication yet — by design.** Every table carries an `owner_id` and every
  route is already scoped to it, so real auth can be slotted in later by swapping one
  `AuthModule` in `web/src/auth.ts` (see the comments there).
- **Wi-Fi passwords are stored in D1 in plaintext in v0.** They must be readable to be
  re-sent to a board. Before exposing this to untrusted users, add auth and encrypt at
  rest.
- Credentials travel **browser → ESP over BLE** (an encrypted link) and are written to
  the device's NVS flash only when you press Connect.

## License

[MIT](LICENSE) — see [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.
