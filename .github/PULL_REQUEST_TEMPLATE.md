## What

<!-- One or two sentences. Imperative mood: "Add wifi scan characteristic". -->

## Why

<!-- The problem this solves. Link the issue with "Closes #123". -->



## Branch

- [ ] Targets `dev` (feature work)
- [ ] Targets `main` (a `dev` → `main` promotion; only tick this in the promotion PR)

## Type

- [ ] `firmware` — Rust, ESP32-S3
- [ ] `web` — Cloudflare Worker / D1 / browser app
- [ ] `ci` — workflows, templates, tooling
- [ ] `docs`

## Protocol changes

<!-- Delete this section if the protocol is untouched. -->

- [ ] I changed `firmware/src/gatt.rs` **and** `web/src/protocol.js`
- [ ] I changed `firmware/src/protocol.rs` **and** `web/src/protocol.js`
- [ ] I documented the grammar change in both files

Grammar / verbs before and after:

```
```

## Schema changes

<!-- Delete this section if `web/src/schema.ts` is untouched. -->

- [ ] I **added** a new entry to `MIGRATIONS` (never edited a shipped one)
- [ ] The new DDL uses `IF NOT EXISTS`
- [ ] I bumped `SCHEMA_VERSION`

## How it was tested

<!-- Be concrete. CI runs fmt, tsc, a build and an API smoke test — say what you
     ran beyond that. -->

- [ ] `npm run check` passes
- [ ] `npm run build` passes
- [ ] `python3 scripts/smoke_api.py <base-url>` passes
- [ ] `cargo build --release` passes
- [ ] Flashed and booted on real hardware
- [ ] Verified on https://esp.virt.cc.cd

Steps:

```
1.
2.
```

## Screenshots / serial output

<!-- If it is a UI change, paste a screenshot. If it is firmware, paste the log. -->

## Checklist

- [ ] No secrets, tokens, Wi-Fi passwords or credentials in the diff
- [ ] Followed the conventions in `CONTRIBUTING.md`
- [ ] Commit messages are imperative, ≤ 72 chars
- [ ] I have read the "Security notes" section of the README
