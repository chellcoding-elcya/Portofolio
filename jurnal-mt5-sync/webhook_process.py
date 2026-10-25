#!/usr/bin/env python3
"""Pemroses antrean webhook MetaKit -> baris Jurnal di Google Sheets.

Alur: Mission Control menerima event MetaKit di POST /hooks/metakit/<token>
dan mengantrekannya (mentah) ke ~/workspace/mission-control/data/webhook-events.jsonl.
Script ini membaca antrean itu, mengambil event `position.closed`, memetakannya
ke baris Jurnal (36 kolom A..AJ, urutan = header Jurnal baris ke-3), dan
menulisnya ke Google Sheets "Jurnal Trading Bos Archell" tab Jurnal.

Keamanan & kebenaran data:
- Hanya MEMBACA antrean & MENAMBAH baris jurnal. Tidak ada akses trading.
- Anti-dobel berlapis: (1) watermark jumlah baris antrean yang sudah diproses
  di webhook_state.json, (2) kunci ticket+deal_ticket yang sudah ditambahkan,
  (3) daftar Ticket yang sudah ada di sheet Jurnal dibaca ulang tiap run.
- State hanya disimpan SETELAH append Sheets berhasil (crash-safe).
- Waktu event MetaKit (UTC) dipakai apa adanya agar konsisten dengan 582 baris
  impor manual dari laporan MT5 (basis waktu server yang sama).
- Kolom News (Z..AH) untuk baris otomatis dibiarkan KOSONG = belum dicek
  (bukan "Tidak"); riset news tetap langkah terpisah seperti sebelumnya.
- Penjaga rentang rumus: Dashboard/Rekap membaca Jurnal sampai baris 1003.
  Bila baris terakhir mendekati 1003, run memberi peringatan "range_warning"
  agar rentang rumus diperluas sebelum terlampaui.

Pakai:
  python3 webhook_process.py            # proses & tambahkan ke Sheets
  python3 webhook_process.py --dry-run  # tampilkan baris yang AKAN ditambah
Output terakhir: satu baris JSON ringkasan untuk pemanggil (cron).
"""
import json
import os
import subprocess
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from sync import HARI_ID, SHEETS_CLI  # noqa: E402

QUEUE_PATH = os.path.expanduser("~/workspace/mission-control/data/webhook-events.jsonl")
STATE_PATH = os.path.join(HERE, "webhook_state.json")
SPREADSHEET_ID = "1h4yLvVaD89n4oDFIuP57mirAYFOptBqM7Eo6j52S47k"
SHEET = "Jurnal"
HEADER_ROW = 3
FIRST_DATA_ROW = 4
LAST_FORMULA_ROW = 1003  # Dashboard/Rekap membaca Jurnal sampai baris ini
RANGE_WARN_ROW = 990

# Urutan 36 kolom Jurnal (A..AJ) sesuai header baris ke-3 di Google Sheets.
HEADERS = [
    "No", "Ticket / Order ID", "Tanggal Open", "Hari", "Jam Open",
    "Tanggal Close", "Jam Close", "Pair / Symbol", "BUY / SELL", "Lot Size",
    "Harga Open", "Harga Close", "Stop Loss", "Take Profit", "SL %", "TP %",
    "Profit Kotor ($)", "Komisi ($)", "Swap ($)", "Profit Bersih ($)",
    "Hasil", "Alasan Close", "Setup / Catatan", "Hari Unik (helper)",
    "Equity Kumulatif ($)", "Ada News Hari Itu?", "News Terpenting Hari Itu",
    "Currency News", "Impact News", "Actual", "Forecast", "Previous",
    "Hasil News vs Forecast",
    "Penjelasan: Kenapa Harga Naik / Turun Karena News Ini",
    "RR (Risk : Reward)", "RR (angka)",
]

REASON_MAP = {
    "sl": "SL", "tp": "TP", "stopout": "Stop Out",
    "manual": "Manual", "other": "Lainnya",
}


def load_state():
    if os.path.exists(STATE_PATH):
        with open(STATE_PATH) as f:
            return json.load(f)
    return {"processed_lines": 0, "appended_keys": [], "last_run_utc": None}


def save_state(state):
    with open(STATE_PATH, "w") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)


def sheets_cli(args, payload=None):
    cmd = [SHEETS_CLI, "sheets"] + args
    if payload is not None:
        cmd += ["--json", json.dumps(payload)]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def sheets_values_get(rng):
    cmd = [SHEETS_CLI, "sheets", "spreadsheets", "values", "get",
           "--params", json.dumps({"spreadsheetId": SPREADSHEET_ID, "range": rng})]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return json.loads(out.stdout).get("values", [])


def read_sheet_snapshot():
    """Baca kolom kunci Jurnal: No(A), Ticket(B), Tanggal Open(C), Profit Bersih(T), Equity(Y)."""
    vals = sheets_values_get(f"{SHEET}!A{FIRST_DATA_ROW}:Y{LAST_FORMULA_ROW}")
    tickets, open_dates = set(), set()
    last_no, last_equity, last_row = 0, 0.0, FIRST_DATA_ROW - 1
    for i, r in enumerate(vals):
        row_no = FIRST_DATA_ROW + i
        ticket = (r[1] if len(r) > 1 else "").strip()
        if not ticket:
            continue
        tickets.add(ticket)
        last_row = row_no
        try:
            last_no = int(float(r[0])) if r and r[0] != "" else last_no
        except (ValueError, IndexError):
            pass
        if len(r) > 2 and r[2]:
            open_dates.add(r[2])
        if len(r) > 24 and r[24] not in ("", None):
            try:
                last_equity = float(str(r[24]).replace(".", "").replace(",", ".")) \
                    if isinstance(r[24], str) else float(r[24])
            except ValueError:
                pass
    return tickets, open_dates, last_no, last_equity, last_row


def adapt_event(body):
    """Payload position.closed MetaKit -> dict kontrak map_position di sync.py."""
    d = body.get("data") or {}
    if body.get("event") != "position.closed" or not d:
        return None
    return {
        "position_id": d.get("ticket"),
        "open_time": d.get("time"),
        "close_time": d.get("close_time"),
        "symbol": d.get("symbol"),
        "type": d.get("type"),
        "volume": d.get("volume"),
        "open_price": d.get("priceOpen"),
        "close_price": d.get("close_price"),
        "sl": d.get("sl") or None,
        "tp": d.get("tp") or None,
        "commission": d.get("commission", 0.0) or 0.0,
        "swap": d.get("swap", 0.0) or 0.0,
        "profit": d.get("profit", 0.0) or 0.0,
        "reason": d.get("reason", "other"),
        "deal_ticket": d.get("deal_ticket"),
        "comment": d.get("comment", ""),
    }


def build_row(p, no, equity_before, open_dates_seen):
    """Posisi (kontrak adapt_event) -> baris penuh 36 kolom sesuai HEADERS."""
    open_dt = datetime.fromisoformat(p["open_time"].replace("Z", "+00:00"))
    close_dt = datetime.fromisoformat(p["close_time"].replace("Z", "+00:00"))
    gross = round(float(p["profit"]), 2)
    commission = round(float(p.get("commission", 0.0)), 2)
    swap = round(float(p.get("swap", 0.0)), 2)
    net = round(gross + commission + swap, 2)
    sl_pct = tp_pct = rr = None
    if p.get("sl") and p.get("open_price"):
        risk = abs(p["open_price"] - p["sl"])
        if risk > 0:
            sl_pct = risk / p["open_price"]
            if p.get("tp"):
                reward = abs(p["tp"] - p["open_price"])
                tp_pct = reward / p["open_price"]
                rr = reward / risk
    hasil = "Win" if net > 0 else ("Loss" if net < 0 else "Break Even")
    open_date = open_dt.strftime("%Y-%m-%d")
    hari_unik = 0 if open_date in open_dates_seen else 1
    open_dates_seen.add(open_date)
    rr_text = f"1 : {rr:.2f}".replace(".", ",") if rr else ""
    row_map = {
        "No": no,
        "Ticket / Order ID": str(p["position_id"]),
        "Tanggal Open": open_date,
        "Hari": HARI_ID[open_dt.weekday()],
        "Jam Open": open_dt.strftime("%H:%M"),
        "Tanggal Close": close_dt.strftime("%Y-%m-%d"),
        "Jam Close": close_dt.strftime("%H:%M"),
        "Pair / Symbol": p["symbol"],
        "BUY / SELL": "Buy" if p["type"] == "buy" else "Sell",
        "Lot Size": p["volume"],
        "Harga Open": p["open_price"],
        "Harga Close": p["close_price"],
        "Stop Loss": p.get("sl") or "",
        "Take Profit": p.get("tp") or "",
        "SL %": round(sl_pct, 6) if sl_pct is not None else "",
        "TP %": round(tp_pct, 6) if tp_pct is not None else "",
        "Profit Kotor ($)": gross,
        "Komisi ($)": commission,
        "Swap ($)": swap,
        "Profit Bersih ($)": net,
        "Hasil": hasil,
        "Alasan Close": REASON_MAP.get(p.get("reason", "other"), "Lainnya"),
        "Setup / Catatan": p.get("comment", "") or "",
        "Hari Unik (helper)": hari_unik,
        "Equity Kumulatif ($)": round(equity_before + net, 2),
        "RR (Risk : Reward)": rr_text,
        "RR (angka)": round(rr, 4) if rr else "",
    }
    return [row_map.get(h, "") for h in HEADERS], net


def main():
    dry = "--dry-run" in sys.argv
    queue_path = QUEUE_PATH
    state_path = STATE_PATH
    for i, a in enumerate(sys.argv):
        if a == "--queue":
            queue_path = sys.argv[i + 1]
        if a == "--state":
            state_path = sys.argv[i + 1]
    state = load_state() if state_path == STATE_PATH else (
        json.load(open(state_path)) if os.path.exists(state_path)
        else {"processed_lines": 0, "appended_keys": [], "last_run_utc": None})

    lines = []
    if os.path.exists(queue_path):
        with open(queue_path) as f:
            lines = [ln for ln in f.read().splitlines() if ln.strip()]
    start = min(state.get("processed_lines", 0), len(lines))
    new_records = lines[start:]

    events = []
    for ln in new_records:
        try:
            rec = json.loads(ln)
        except json.JSONDecodeError:
            continue
        body = rec.get("body")
        if isinstance(body, dict):
            p = adapt_event(body)
            if p:
                events.append(p)

    summary = {"appended": 0, "skipped_dupes": 0, "events_seen": len(events),
               "tickets": [], "range_warning": None, "dry_run": dry}
    if not events:
        summary["note"] = "tidak ada event position.closed baru"
        print(json.dumps(summary, ensure_ascii=False))
        return 0

    tickets_sheet, open_dates, last_no, last_equity, last_row = read_sheet_snapshot()
    appended_keys = set(state.get("appended_keys", []))
    rows, keys_new = [], []
    run_keys = set()
    no, equity = last_no, last_equity
    for p in sorted(events, key=lambda x: x["close_time"] or ""):
        key = f"{p['position_id']}:{p.get('deal_ticket')}"
        if key in appended_keys or key in run_keys or str(p["position_id"]) in tickets_sheet:
            summary["skipped_dupes"] += 1
            continue
        run_keys.add(key)
        no += 1
        row, net = build_row(p, no, equity, open_dates)
        equity = round(equity + net, 2)
        rows.append(row)
        keys_new.append(key)
        summary["tickets"].append(str(p["position_id"]))

    if rows and not dry:
        target_row = last_row + 1
        end_row = target_row + len(rows) - 1
        if end_row >= RANGE_WARN_ROW:
            summary["range_warning"] = (
                f"baris Jurnal mendekati batas rumus 1003 (akan menulis s/d {end_row}); "
                "rentang rumus Dashboard/Rekap perlu diperluas")
        sheets_cli(
            ["spreadsheets", "values", "update",
             "--params", json.dumps({
                 "spreadsheetId": SPREADSHEET_ID,
                 "range": f"{SHEET}!A{target_row}:AJ{end_row}",
                 "valueInputOption": "USER_ENTERED"})],
            {"values": rows})
        # Verifikasi: baca balik ticket yang baru ditulis.
        check = sheets_values_get(f"{SHEET}!B{target_row}:B{end_row}")
        written = {r[0].strip() for r in check if r}
        missing = [t for t in summary["tickets"] if t not in written]
        if missing:
            summary["error"] = f"verifikasi gagal, ticket tak terbaca balik: {missing}"
            print(json.dumps(summary, ensure_ascii=False))
            return 1
        state["appended_keys"] = sorted(appended_keys | set(keys_new))

    summary["appended"] = len(rows)
    if not dry:
        state["processed_lines"] = len(lines)
        state["last_run_utc"] = datetime.utcnow().isoformat(timespec="seconds") + "Z"
        if state_path == STATE_PATH:
            save_state(state)
        else:
            with open(state_path, "w") as f:
                json.dump(state, f, indent=2, ensure_ascii=False)
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
