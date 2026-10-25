#!/usr/bin/env python3
"""Sinkronisasi otomatis history MT5 -> Google Sheets (Jalur A, MT5API.dev).

Prinsip: read-only, anti-dobel (kunci = Position ID / ticket), watermark agar
run berikutnya mengejar data yang tertinggal bila ada jeda/restart.

Bagian yang SUDAH pasti: state/watermark, pemetaan posisi -> baris Jurnal,
penambahan baris ke Google Sheets via hatch_gws_cli.
Bagian yang dilengkapi saat API key tersedia: Mt5ApiClient (endpoint persis
mengikuti dokumentasi MT5API.dev) + kredensial via konektor custom.mt5api.
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_PATH = os.path.join(HERE, "state.json")
SHEETS_CLI = "/opt/hatch/bin/hatch_gws_cli"
SPREADSHEET_NAME = "Jurnal Trading Bos Archell"  # ID di-resolve saat aktivasi

HARI_ID = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu", "Minggu"]


def load_state():
    if os.path.exists(STATE_PATH):
        with open(STATE_PATH) as f:
            return json.load(f)
    return {"watermark_close_time": None, "seen_tickets": [], "spreadsheet_id": None}


def save_state(state):
    with open(STATE_PATH, "w") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)


class Mt5ApiClient:
    """STUB — dilengkapi saat API key MT5API.dev tersedia (konektor custom.mt5api).

    Kontrak yang harus dipenuhi implementasi asli:
    - get_closed_positions_since(iso_time) -> list[dict] posisi tertutup dengan
      field: position_id, open_time, close_time, symbol, type (buy/sell),
      volume, open_price, close_price, sl, tp, commission, swap, profit,
      close_reason / comment.
    - get_balance_operations_since(iso_time) -> list[dict] deposit/withdrawal.
    Hanya endpoint BACA yang boleh dipakai.
    """

    def __init__(self, api_key, account_id):
        self.api_key = api_key
        self.account_id = account_id

    def get_closed_positions_since(self, iso_time):
        raise NotImplementedError("Aktif setelah API key MT5API tersedia")


def map_position(p):
    """Posisi tertutup (dict ala kontrak di atas) -> baris Jurnal (urutan kolom A..AJ).

    Logika mengikuti impor manual terverifikasi: untung/rugi bersih memakai
    profit + komisi + swap; RR dihitung dari jarak SL/TP terhadap harga open.
    Mengembalikan (ticket, row_dict) — row_dict memakai nama kolom header Jurnal.
    """
    open_dt = datetime.fromisoformat(p["open_time"])
    close_dt = datetime.fromisoformat(p["close_time"])
    net = round(p["profit"] + p.get("commission", 0.0) + p.get("swap", 0.0), 2)
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
    row = {
        "Ticket / Order ID": str(p["position_id"]),
        "Tanggal Open": open_dt.strftime("%Y-%m-%d"),
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
        "SL %": sl_pct if sl_pct is not None else "",
        "TP %": tp_pct if tp_pct is not None else "",
        "Komisi ($)": p.get("commission", 0.0),
        "Swap ($)": p.get("swap", 0.0),
        "Profit Bersih ($)": net,
        "Hasil": hasil,
        "RR (angka)": round(rr, 4) if rr else "",
    }
    return str(p["position_id"]), row


def sheets_append(spreadsheet_id, sheet_title, values):
    params = {
        "spreadsheetId": spreadsheet_id,
        "range": f"{sheet_title}!A:AJ",
        "valueInputOption": "USER_ENTERED",
    }
    cmd = [
        SHEETS_CLI, "sheets", "spreadsheets", "values", "append",
        "--params", json.dumps(params),
        "--json", json.dumps({"values": values}),
    ]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def main():
    state = load_state()
    api_key = os.environ.get("MT5API_KEY")
    account_id = os.environ.get("MT5API_ACCOUNT_ID")
    if not api_key or not account_id or not state.get("spreadsheet_id"):
        print("BELUM AKTIF: butuh MT5API_KEY, MT5API_ACCOUNT_ID, dan spreadsheet_id di state.json")
        return 2
    client = Mt5ApiClient(api_key, account_id)
    positions = client.get_closed_positions_since(state["watermark_close_time"])
    seen = set(state["seen_tickets"])
    new_rows, newest_close = [], state["watermark_close_time"]
    for p in sorted(positions, key=lambda x: x["close_time"]):
        ticket, row = map_position(p)
        if ticket in seen:
            continue
        seen.add(ticket)
        new_rows.append([row.get(k, "") for k in row])
        newest_close = max(newest_close or "", p["close_time"])
    if new_rows:
        sheets_append(state["spreadsheet_id"], "Jurnal", new_rows)
    state["seen_tickets"] = sorted(seen)
    state["watermark_close_time"] = newest_close
    state["last_run_utc"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    save_state(state)
    print(f"OK: {len(new_rows)} posisi baru masuk Jurnal")
    return 0


if __name__ == "__main__":
    sys.exit(main())
