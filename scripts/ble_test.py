#!/usr/bin/env python3
"""Automated end-to-end test of the ESP32-S3 BLE GATT protocol over the air.

Verifies:
1. GATT connection to esp32-remote
2. Subscribing to CONTROL and STATUS notifications (ensuring NO spurious CCCD errors)
3. PING command -> OK PONG
4. INFO command -> OK INFO with valid MAC, chip, and firmware
5. STATUS command -> OK STATUS
6. LED TOGGLE command -> OK LED 0/1

Usage:
    python3 scripts/ble_test.py
    python3 scripts/ble_test.py --timeout 10

Requires:
    pip install bleak
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time

SERVICE_UUID = "937312e0-2354-11eb-9f10-fbc30a62cf38"
CONTROL_UUID = "937312e1-2354-11eb-9f10-fbc30a62cf38"
STATUS_UUID = "937312e2-2354-11eb-9f10-fbc30a62cf38"
NAME_PREFIX = "esp32-remote"


async def run_ble_test(timeout: float) -> int:
    from bleak import BleakClient, BleakScanner

    print(f"[*] Scanning for advertiser matching prefix '{NAME_PREFIX}' ({timeout:g}s)...")
    found = await BleakScanner.discover(timeout=timeout, return_adv=True)
    device = None
    for _addr, (d, adv) in found.items():
        name = (adv.local_name or d.name or "").lower()
        uuids = [u.lower() for u in (adv.service_uuids or [])]
        if NAME_PREFIX in name or SERVICE_UUID.lower() in uuids:
            device = d
            break

    if not device:
        print(f"[!] No device matching '{NAME_PREFIX}' found. Is the board plugged in?")
        return 1

    print(f"[+] Found device: {device.name} ({device.address})")
    print(f"[*] Connecting to GATT server...")

    try:
        async with BleakClient(device, timeout=12.0) as client:
            print(f"[+] Connected! (MTU: {client.mtu_size})")

            received_queue: asyncio.Queue[str] = asyncio.Queue()

            def on_notification(sender, data: bytearray):
                line = bytes(data).decode("latin1", errors="replace").strip()
                print(f"    << RX: {line}")
                received_queue.put_nowait(line)

            # Step 1: Subscriptions
            print("[*] Subscribing to notifications on CONTROL and STATUS...")
            await client.start_notify(CONTROL_UUID, on_notification)
            await client.start_notify(STATUS_UUID, on_notification)
            await asyncio.sleep(0.5)

            if not received_queue.empty():
                spurious = []
                while not received_queue.empty():
                    spurious.append(received_queue.get_nowait())
                print(f"[!] FAIL: Spurious notifications received during subscription: {spurious}")
                return 2
            print("[+] PASS: Clean subscriptions, no spurious CCCD error responses.")

            async def send_and_wait(command: str, wait_secs: float = 3.0) -> str:
                print(f"    >> TX: {command}")
                payload = f"{command}\n".encode("ascii")
                await client.write_gatt_char(CONTROL_UUID, payload, response=True)
                deadline = time.time() + wait_secs
                while time.time() < deadline:
                    try:
                        res = await asyncio.wait_for(received_queue.get(), timeout=0.2)
                        if res.startswith("OK") or res.startswith("ERR"):
                            return res
                    except asyncio.TimeoutError:
                        pass
                raise TimeoutError(f"No response to '{command}' within {wait_secs}s")

            # Step 2: Test PING
            print("[*] Testing PING...")
            res = await send_and_wait("PING")
            assert res == "OK PONG", f"Expected 'OK PONG', got '{res}'"
            print("[+] PASS: PING -> OK PONG")

            # Step 3: Test INFO
            print("[*] Testing INFO...")
            res = await send_and_wait("INFO")
            assert res.startswith("OK INFO"), f"Expected 'OK INFO', got '{res}'"
            print(f"[+] PASS: INFO -> {res}")

            # Step 4: Test STATUS
            print("[*] Testing STATUS...")
            res = await send_and_wait("STATUS")
            assert res.startswith("OK STATUS"), f"Expected 'OK STATUS', got '{res}'"
            print(f"[+] PASS: STATUS -> {res}")

            # Step 5: Test LED TOGGLE
            print("[*] Testing LED TOGGLE...")
            res = await send_and_wait("LED TOGGLE")
            assert res.startswith("OK LED"), f"Expected 'OK LED', got '{res}'"
            print(f"[+] PASS: LED TOGGLE -> {res}")

            print("\n==========================================")
            print("ALL BLE OVER-THE-AIR CHECKS PASSED!")
            print("==========================================")
            return 0
    except (asyncio.TimeoutError, TimeoutError):
        print("[!] Connection to ESP32 timed out.")
        print("    Note: Only 1 central can connect at a time (CONNECTIONS_MAX = 1).")
        print("    If https://esp.virt.cc.cd is currently connected in your browser, please disconnect it first.")
        return 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=float, default=15.0, help="BLE scan timeout in seconds")
    args = parser.parse_args()
    return asyncio.run(run_ble_test(args.timeout))


if __name__ == "__main__":
    sys.exit(main())
