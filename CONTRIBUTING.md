# Contributing to esp32-remote

Thanks for helping out. This project is deliberately small and strict so it stays easy
to reason about: **Rust firmware**, **a Cloudflare Worker + D1 backend**, **a
dependency-light browser app**.

## Ground rules

1. **Everything is Rust in the firmware.** No C, no Arduino, no PlatformIO.
2. **One board: ESP32-S3.** The Xtensa target is `xtensa-esp32s3-none-elf`.
3. **No secrets in the repo.** Wi-Fi passwords live in D1 behind the API and in NVS on
   the device. Cloudflare tokens belong in your shell or CI secrets, never in files.
4. **Public repo.** Everything pushed here is public.

## Branch model

```
feat/*  ──►  dev  ──►  main
fix/*   ──►  dev  ──►  main
```

| Branch   | Purpose                                                            |
| -------- | ------------------------------------------------------------------ |
| `main`   | Always deployable. CI runs on every push; the site deploys from here. |
| `dev`    | Integration branch. Merge your feature branch here first and verify. |
| `feat/*` | One branch per feature.                                            |
| `fix/*`  | One branch per bug fix.                                            |

### Workflow

1. Branch from the latest `dev`:
   ```sh
   git fetch origin
   git checkout -b feat/short-name origin/dev
   ```
2. Make your change.
3. Run the checks below.
4. Open a PR **into `dev`**, using the PR template.
5. Once `dev` is green and reviewed, a maintainer opens a PR **`dev` → `main`**.
   Merging to `main` deploys the site.

Branch names: `feat/<short-kebab-name>`, `fix/<short-kebab-name>`.

## Checks before you open a PR

CI runs all of these, so running them locally saves a round trip.

### Firmware

```sh
. ~/export-esp.sh
cd firmware
env -u RUSTUP_TOOLCHAIN cargo fmt --check
env -u RUSTUP_TOOLCHAIN cargo build --release   # must target xtensa-esp32s3-none-elf
```

`cargo fmt` uses the `esp` toolchain's rustfmt; run `cargo fmt` once to normalise.

> `RUSTUP_TOOLCHAIN` (set by mise and some other version managers) overrides
> `rust-toolchain.toml`, hence the `env -u`.

### Website

```sh
cd web
npm install
npm run check     # tsc --noEmit — must be clean
npm run build     # cf build — must emit .cloudflare/output/v1/
node --check src/app.js
node --check src/protocol.js
```

### End-to-end

Local worker + API smoke test:

```sh
cd web && npm run dev          # http://localhost:5173
python3 scripts/smoke_api.py http://localhost:5173
```

Then verify on https://esp.virt.cc.cd that:

- the **Connect** button pairs with the ESP,
- Wi-Fi scanning and provisioning still work,
- history and settings survive a reload.

With the board plugged in, confirm it is actually advertising:

```sh
python3 scripts/ble_scan.py            # run from Terminal.app (Bluetooth permission)
```

## Protocol contract

The line protocol and the GATT surface are shared between firmware and browser.
**Change all three places together** or the link silently breaks:

| What                | Firmware                     | Browser                      |
| ------------------- | ---------------------------- | ---------------------------- |
| GATT service UUIDs  | `firmware/src/gatt.rs`       | `web/src/protocol.js`        |
| Line grammar        | `firmware/src/protocol.rs`   | `web/src/protocol.js`        |

Rules:

- Every message is **one line of printable ASCII** ending in `\n`.
- The firmware truncates at **240 bytes** to fit a 255-byte ATT MTU.
- `key=value` fields may contain spaces; a field ends at the next `key=`.
- Responses start with `OK`, `PONG`, `ERR`, or a verb like `AP` / `STATUS`.
- Document grammar changes in both files and in the PR description.

Current verbs: `PING`, `INFO`, `STATUS`, `SCAN`, `JOIN ssid=… pass=…`,
`LED ON|OFF|TOGGLE`, `GPIO <pin> <0|1>`.

## Firmware conventions

- `#![no_std]`, no `unsafe` unless justified in a comment.
- All async work runs on the `esp-rtos` / embassy executor. Never block it.
- Log with `info!` / `warn!`; the serial output is the primary debugging tool.

## Website conventions

- **Backend (`web/src/*.ts`)** — zero runtime dependencies. Routes live in `api.ts`,
  SQL lives in `db.ts`, schema in `schema.ts`, identity in `auth.ts`. Keep it that way:
  the owner-scoping rule is enforced in `db.ts` only, so do not write ad-hoc queries
  elsewhere.
- **Frontend (`web/src/app.js`, `protocol.js`)** — vanilla ES modules, no framework.
- **Migrations are append-only.** Never edit a shipped entry in `schema.ts`; add a new
  one. DDL must use `IF NOT EXISTS`.
- **Statements are executed one at a time.** D1's `db.exec()` rejects our multi-statement
  DDL (`incomplete input`), so `ensureSchema` splits with `splitStatements()`.
- Use `TextEncoder` / `TextDecoder` for GATT payloads.
- Handle Bluetooth errors gracefully (permission denied, device out of range).

## Commit messages

Imperative subject line, ≤ 72 chars, optionally scoped:

```
firmware: restart advertising after a dropped central
web: show rssi bars in the network list
ci: run cargo fmt --check on pull requests
```

## Reporting bugs

Use the bug report template and include: firmware commit, `espflash` / `espup` version,
your OS, the serial monitor output around the failure, and — if it is a site bug — the
browser's console output and the workspace id from the top bar.

## License

By contributing you agree your changes are licensed under the [MIT License](LICENSE).
