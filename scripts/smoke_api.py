#!/usr/bin/env python3
"""End-to-end smoke test of the esp32-remote JSON API.

Exercises every route the browser app uses and asserts that data written in
one request is read back in another — i.e. that D1 actually persists.
"""
import json
import sys
import urllib.error
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5173"
JAR: dict[str, str] = {}
FAILURES: list[str] = []

# Cloudflare's browser-integrity check rejects Python's default UA with 1010.
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"


def request(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{BASE}/api{path}", data=data, method=method)
    req.add_header("content-type", "application/json")
    req.add_header("user-agent", UA)
    if JAR:
        req.add_header("cookie", "; ".join(f"{k}={v}" for k, v in JAR.items()))
    return req


def call_cookie(method, path, body=None, expect=200):
    """Perform a request, record failures, and capture any `Set-Cookie` sent."""
    req = request(method, path, body)
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor())
    try:
        with opener.open(req, timeout=30) as res:
            status, raw_body = res.status, res.read()
            raw = res.headers.get_all("Set-Cookie") or []
    except urllib.error.HTTPError as err:
        status, raw_body = err.code, err.read()
        raw = err.headers.get_all("Set-Cookie") or []

    # Cloudflare may answer non-JSON (e.g. a challenge page) — never crash on it.
    try:
        payload = json.loads(raw_body or b"{}")
    except ValueError:
        payload = {"_raw": raw_body[:200].decode("utf-8", "replace")}

    for cookie in raw:
        pair = cookie.split(";")[0]
        if "=" in pair:
            k, v = pair.split("=", 1)
            JAR[k.strip()] = v.strip()

    if status != expect:
        FAILURES.append(f"{method} {path} -> {status} (want {expect}): {payload}")
    return status, payload


def check(label, condition, detail=""):
    print(("  ok   " if condition else "  FAIL ") + label + (f"  {detail}" if detail else ""))
    if not condition:
        FAILURES.append(f"{label} {detail}")


print(f"API smoke test against {BASE}\n")

print("health / bootstrap")
_, health = call_cookie("GET", "/health")
check("health.ok", health.get("ok") is True, str(health.get("code", "")))
check("identity cookie captured", bool(JAR), str(JAR))

_, boot = call_cookie("GET", "/bootstrap")
check("bootstrap has identity", bool(boot.get("identity", {}).get("id")))
owner = boot["identity"]["id"]

print("\ndevices")
_, created = call_cookie(
    "POST",
    "/devices",
    {"mac": "e0:72:a1:f6:10:0c", "name": "Workshop board", "chip": "esp32s3", "firmware": "0.1.0"},
    expect=201,
)
device = created.get("device", {})
check("device created", bool(device.get("id")))
check("mac normalised", device.get("mac") == "e0:72:a1:f6:10:0c", device.get("mac", ""))

_, dup = call_cookie(
    "POST", "/devices", {"mac": "E0-72-A1-F6-10-0C", "name": "Renamed"}, expect=201
)
check("upsert on mac (no duplicate)", dup.get("device", {}).get("id") == device.get("id"))
check("name updated by upsert", dup.get("device", {}).get("name") == "Renamed")

_, listed = call_cookie("GET", "/devices")
check("device listed once", len(listed.get("devices", [])) == 1, str(listed.get("devices")))

_, seen = call_cookie("POST", f"/devices/{device['id']}/seen")
check("touch sets lastSeenAt", bool(seen.get("device", {}).get("lastSeenAt")))

print("\nwi-fi profiles")
_, wifi = call_cookie(
    "POST",
    "/wifi-profiles",
    {"ssid": "My Home WiFi", "password": "hunter2 hunter2", "security": "WPA2", "band": "2.4"},
    expect=201,
)
profile = wifi.get("wifiProfile", {})
check("profile created", bool(profile.get("id")))
check("ssid with spaces preserved", profile.get("ssid") == "My Home WiFi", profile.get("ssid"))
check("password stored", profile.get("password") == "hunter2 hunter2")

_, used = call_cookie("POST", f"/wifi-profiles/{profile['id']}/used")
check("use counter increments", used.get("wifiProfile", {}).get("useCount") == 1)

_, edited = call_cookie(
    "PUT", f"/wifi-profiles/{profile['id']}", {"password": "newpass", "channel": 6}
)
check("profile updated", edited.get("wifiProfile", {}).get("channel") == 6)

print("\nhistory")
for i, cmd in enumerate(["PING", "STATUS", "LED ON"]):
    call_cookie(
        "POST",
        "/history",
        {"deviceId": device["id"], "direction": "tx", "command": cmd,
         "response": f"OK {cmd}", "ok": True},
        expect=201,
    )
call_cookie(
    "POST",
    "/history",
    {"direction": "tx", "command": "JOIN ssid=x", "response": "ERR JOIN timeout", "ok": False},
    expect=201,
)

_, hist = call_cookie("GET", "/history?limit=10")
check("history rows stored", len(hist.get("history", [])) == 4, str(len(hist.get("history", []))))
# Newest first: index 0 is the failing JOIN, the successful PING is last.
rows = hist.get("history", [])
check("newest first", rows[0]["command"].startswith("JOIN"), rows[0]["command"])
check("ok flag round-trips", rows[-1]["ok"] is True, str(rows[-1]))
check("failure recorded", any(h["ok"] is False for h in rows))

_, filtered = call_cookie("GET", f"/history?deviceId={device['id']}")
check("device filter works", len(filtered.get("history", [])) == 3, str(len(filtered.get("history", []))))

print("\nsettings")
_, put = call_cookie("PUT", "/settings", {"theme": "light", "showTimestamps": True})
check("settings written", put.get("settings", {}).get("theme") == "light")
check("non-string values JSON-encoded", put.get("settings", {}).get("showTimestamps") == "true")

_, got = call_cookie("GET", "/settings")
check("settings persist", got.get("settings", {}).get("theme") == "light")

_, cleared = call_cookie("PUT", "/settings", {"theme": None})
check("null deletes a key", "theme" not in cleared.get("settings", {}), str(cleared.get("settings")))

print("\ngeneric key/value")
_, kv = call_cookie("PUT", "/data", {"key": "dashboard/layout", "value": "grid"}, expect=201)
check("kv written", kv.get("entry", {}).get("value") == "grid")

call_cookie("PUT", "/data", {"key": "dashboard/rows", "value": 12}, expect=201)
_, kvs = call_cookie("GET", "/data?namespace=default&prefix=dashboard/")
check("prefix listing works", len(kvs.get("data", [])) == 2, str(len(kvs.get("data", []))))

_, one = call_cookie("GET", "/data/dashboard/layout")
check("single key read", one.get("entry", {}).get("value") == "grid")

_, delkv = call_cookie("DELETE", "/data/dashboard/layout")
check("kv deleted", delkv.get("deleted") is True)

print("\nidentity isolation")
# A fresh client (no cookie) must get its own, empty workspace.
fresh = urllib.request.Request(f"{BASE}/api/bootstrap")
fresh.add_header("user-agent", UA)
with urllib.request.urlopen(fresh, timeout=30) as res:
    other = json.loads(res.read())
check("other client gets different id", other["identity"]["id"] != owner)
check("other client sees no devices", other["devices"] == [])

print("\nerror handling")
call_cookie("GET", "/nope", expect=404)
call_cookie("POST", "/devices", {"name": "x"}, expect=400)
call_cookie("DELETE", "/devices/does-not-exist", expect=404)
call_cookie("GET", "/settings", expect=200)
check("bad method rejected", call_cookie("DELETE", "/settings", expect=405)[0] == 405)

print("\n" + ("ALL CHECKS PASSED" if not FAILURES else f"{len(FAILURES)} FAILURE(S):"))
for failure in FAILURES:
    print("  -", failure)
sys.exit(1 if FAILURES else 0)
