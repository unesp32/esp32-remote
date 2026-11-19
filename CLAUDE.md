# CLAUDE.md & AGENT ENTRYPOINT

See [AGENT.md](./AGENT.md) for the comprehensive system architecture, BLE protocol specifications, hardware setup, and runbooks.

## Essential Commands

- **Run BLE Hardware Test**: `make test-ble` (or `python3 scripts/ble_test.py`)
- **Run Cloudflare API Test**: `make test-api` (or `python3 scripts/smoke_api.py https://esp.virt.cc.cd`)
- **Typecheck & Build Web**: `make build-web` (or `cd web && npm run check && npm run build`)
- **Deploy Site to Production**: `make deploy-web` (or `cd web && cf deploy`)
- **Build Firmware**: `make build-firmware`
- **Flash Firmware**: `make flash-firmware`
