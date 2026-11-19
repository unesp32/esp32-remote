.PHONY: all test-ble test-api build-web deploy-web build-firmware flash-firmware verify-all clean help

PORT ?= /dev/cu.usbmodem11201
SITE ?= https://esp.virt.cc.cd
TOOLCHAIN_ENV ?= /Users/amit/export-esp.sh

help:
	@echo "esp32-remote Developer & Agent Automation"
	@echo ""
	@echo "Targets:"
	@echo "  make test-ble        - Run end-to-end BLE over-the-air test"
	@echo "  make test-api        - Run Cloudflare D1 JSON API smoke test"
	@echo "  make build-web       - Typecheck and build Vinext + Kumo web app"
	@echo "  make deploy-web      - Deploy web app and Worker using Cloudflare 'cf' CLI"
	@echo "  make build-firmware  - Build Rust no_std firmware for ESP32-S3 (Xtensa)"
	@echo "  make flash-firmware  - Flash release firmware to ESP32-S3 on $(PORT)"
	@echo "  make verify-all      - Run all tests (API, BLE, and web checks)"
	@echo ""

test-ble:
	python3 scripts/ble_test.py

test-api:
	python3 scripts/smoke_api.py $(SITE)

build-web:
	cd web && npm run check && npm run build

deploy-web:
	cd web && cf deploy

build-firmware:
	@if [ -f "$(TOOLCHAIN_ENV)" ]; then . $(TOOLCHAIN_ENV); fi; \
	unset RUSTUP_TOOLCHAIN; \
	cd firmware && cargo build --release

flash-firmware:
	espflash flash --port $(PORT) firmware/target/xtensa-esp32s3-none-elf/release/esp32-remote-firmware
	@python3 -m esptool --port $(PORT) run 2>/dev/null || true

verify-all: test-api test-ble build-web
	@echo "\n>>> ALL CHECKS PASSED SUCCESSFULLY! <<<\n"
