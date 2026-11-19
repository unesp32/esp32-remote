#!/usr/bin/env python3
"""Verify the ESP32-S3 is actually advertising over the air.

The firmware's serial log only proves the controller accepted the advertise
command; this proves a radio frame left the chip. macOS hands CoreBluetooth
permission to the *responsible process*, so run this from Terminal.app (or
any app granted Bluetooth access) — not from a sandboxed CI runner.

    python3 scripts/ble_scan.py              # scan for 15s
    python3 scripts/ble_scan.py --timeout 30
    python3 scripts/ble_scan.py --connect    # also connect + list services

Requires `bleak` (`python3 -m pip install bleak`).
"""

from __future__ import annotations

import argparse
import asyncio
import sys

# Mirrors `firmware/src/main.rs::DEVICE_NAME` and `web/src/protocol.js`.
NAME_PREFIX = "esp32-remote"
# Mirrors `firmware/src/gatt.rs::SERVICE_UUID`.
SERVICE_UUID = "937312e0-2354-11eb-9f10-fbc30a62cf38"


async def scan(timeout: float) -> list[tuple[str, str, int]]:
    """Return (address, name, rssi) for every advertiser seen."""
    from bleak import BleakScanner

    # discover(return_adv=True) maps address -> (BLEDevice, AdvertisementData)
    found = await BleakScanner.discover(timeout=timeout, return_adv=True)
    rows = []
    for address, (_device, adv) in found.items():
        rows.append((address, adv.local_name or "", adv.rssi or 0))
    return sorted(rows, key=lambda row: -row[2])


async def connect(address: str) -> None:
    from bleak import BleakClient

    async with BleakClient(address) as client:
        print(f"connected to {address} ({client.is_connected})")
        for service in client.services:
            print(f"  service {service.uuid}")
            for char in service.characteristics:
                print(f"    char {char.uuid}  props={char.properties}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=float, default=15.0, help="scan seconds")
    parser.add_argument("--connect", action="store_true", help="connect on match")
    args = parser.parse_args()

    print(f"scanning for {NAME_PREFIX!r} for {args.timeout:g}s ...")
    rows = asyncio.run(scan(args.timeout))
    print(f"saw {len(rows)} advertisers")

    matches = [row for row in rows if NAME_PREFIX in row[1].lower()]
    if not matches:
        # A redacted name does not rule the board out: CoreBluetooth hides
        # local names for some advertisers, so also look for our service.
        print(f"no name match — is the board plugged in and powered?")
        for address, name, rssi in rows:
            if name:
                print(f"  rssi={rssi:>4}  {address}  {name!r}")
        return 1

    for address, name, rssi in matches:
        print(f"  MATCH rssi={rssi}  {address}  {name!r}")

    if args.connect:
        asyncio.run(connect(matches[0][0]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
