#!/usr/bin/env python3
"""Pemeriksa gabungan untuk Bos Archell (dijalankan cron tiap 5 menit).

1. News: tarik ekspor JSON mingguan Forex Factory, saring event High
   untuk USD/EUR, beri peringatan bila event dimulai dalam 0-35 menit
   ke depan (jendela 35 menit menutup granularity polling 5 menit) dan
   belum pernah diperingatkan (dedupe via state).
2. Alert TradingView: cari email alert baru di Gmail yang terhubung
   (query 'tradingview'), dedupe via ID pesan Gmail.
3. Cetak SATU baris JSON ringkasan di stdout; cron yang memutuskan
   apa yang disampaikan ke user (diam bila kosong & tanpa error).

Jangan mengubah file antrean/state lain. Jangan pernah mengarang event.
"""
import json
import os
import subprocess
import urllib.request
from datetime import datetime, timedelta, timezone

BASE = os.path.expanduser("~/workspace/news-tv-alerts")
STATE = os.path.join(BASE, "state")
os.makedirs(STATE, exist_ok=True)

FF_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"
GWS = "/opt/hatch/bin/hatch_gws_cli"
WIB = timezone(timedelta(hours=7))
WARN_WINDOW_MIN = 35


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def save_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def main():
    out = {
        "news_warnings": [],
        "new_alerts": [],
        "next_high_usd_eur": None,
        "error": None,
    }

    # ---- 1. Kalender Forex Factory ----
    events = None
    try:
        req = urllib.request.Request(
            FF_URL, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=25) as r:
            events = json.load(r)
    except Exception as e:  # noqa: BLE001 - dilaporkan ke cron, bukan disembunyikan
        out["error"] = "Gagal mengambil kalender Forex Factory: %s: %s" % (
            type(e).__name__, e)

    now = datetime.now(WIB)
    if events is not None:
        warned = set(load_json(os.path.join(STATE, "warned_events.json"), []))
        upcoming = []
        for e in events:
            if e.get("country") not in ("USD", "EUR"):
                continue
            if e.get("impact") != "High":
                continue
            try:
                dt = datetime.fromisoformat(e["date"])
            except Exception:
                continue
            upcoming.append((dt.astimezone(WIB), e))
        upcoming.sort(key=lambda x: x[0])
        future = [(t, e) for t, e in upcoming if t > now]
        if future:
            t0, e0 = future[0]
            out["next_high_usd_eur"] = {
                "title": e0["title"],
                "country": e0["country"],
                "time_wib": t0.strftime("%Y-%m-%d %H:%M WIB"),
            }
        for t, e in upcoming:
            mins = (t - now).total_seconds() / 60.0
            key = "%s|%s|%s" % (e["date"], e["country"], e["title"])
            if 0 < mins <= WARN_WINDOW_MIN and key not in warned:
                out["news_warnings"].append({
                    "title": e["title"],
                    "country": e["country"],
                    "time_wib": t.strftime("%Y-%m-%d %H:%M WIB"),
                    "minutes_away": round(mins),
                })
                warned.add(key)
        # Pangkas state: buang kunci event yang sudah lewat > 2 hari.
        kept = []
        for k in warned:
            try:
                d = datetime.fromisoformat(k.split("|")[0]).astimezone(WIB)
                if d > now - timedelta(days=2):
                    kept.append(k)
            except Exception:
                pass
        save_json(os.path.join(STATE, "warned_events.json"), kept[-1000:])

    # ---- 2. Email alert TradingView di Gmail ----
    seen = set(load_json(os.path.join(STATE, "seen_alerts.json"), []))
    try:
        r = subprocess.run(
            [GWS, "gmail", "users", "messages", "list", "--params",
             json.dumps({"userId": "me", "q": "tradingview newer_than:7d",
                         "maxResults": 50})],
            capture_output=True, text=True, timeout=120)
        ids = []
        for line in r.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                page = json.loads(line)
            except Exception:
                continue
            for m in page.get("messages", []) or []:
                if m.get("id"):
                    ids.append(m["id"])
        for mid in ids:
            if mid in seen:
                continue
            g = subprocess.run(
                [GWS, "gmail", "users", "messages", "get", "--params",
                 json.dumps({"userId": "me", "id": mid, "format": "metadata",
                             "metadataHeaders": ["From", "Subject", "Date"]})],
                capture_output=True, text=True, timeout=120)
            try:
                msg = json.loads(g.stdout.strip().splitlines()[0])
            except Exception:
                continue
            headers = {h["name"]: h["value"]
                       for h in msg.get("payload", {}).get("headers", [])}
            out["new_alerts"].append({
                "id": mid,
                "from": headers.get("From", ""),
                "subject": headers.get("Subject", ""),
                "date": headers.get("Date", ""),
                "snippet": msg.get("snippet", ""),
            })
            seen.add(mid)
        save_json(os.path.join(STATE, "seen_alerts.json"), sorted(seen))
    except Exception as e:  # noqa: BLE001
        prev = out["error"]
        out["error"] = ((prev + " | ") if prev else "") + \
            "Gagal membaca Gmail: %s: %s" % (type(e).__name__, e)

    # Supaya cron 5 menit tidak meng-spam error yang sama berulang-ulang:
    # laporkan error hanya saat pertama kali muncul / berubah.
    err_state = load_json(os.path.join(STATE, "error_state.json"), {})
    last_err = err_state.get("last_error")
    out["error_repeat"] = bool(out["error"] and out["error"] == last_err)
    save_json(os.path.join(STATE, "error_state.json"),
              {"last_error": out["error"]})

    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
