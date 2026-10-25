# Portofolio — Archell

Kumpulan project yang dibangun 22–25 Oktober 2026, diarahkan oleh Archell
dan dibantu asisten AI (Manager Killua). Kode di sini adalah kode kerja
nyata, bukan contoh tutorial — tapi data nyata sengaja **tidak** ikut.

## Isi repo

| Folder | Isi |
|---|---|
| `mission-control/` | Dashboard pemantau tim AI + kantor virtual 3D (Node murni, tanpa framework; frontend satu file + Three.js). Server `server.js`, frontend `index.html`, `watchdog.sh`, dan README aslinya. |
| `jurnal-mt5-sync/` | Pipa jurnal trading MT5: tarik history via API (`sync.py`) dan pemroses webhook posisi tertutup ke Google Sheets (`webhook_process.py`). API key dibaca dari environment, tidak pernah ditulis di kode. |
| `news-alerts/` | Pengecek gabungan tiap 5 menit: peringatan news High USD/EUR dari Forex Factory + alert TradingView, dengan dedupe. |
| `trading-system/` | Strategi Pine Script v5 (ICT + Fibonacci) untuk EUR/USD di TradingView. |

## Yang sengaja TIDAK ada di repo ini

- Folder `data/` Mission Control (ledger kerja, event webhook, kurva equity) — data kerja nyata.
- `PUBLIC_URL.txt`, token Dev Tunnels, dan `webhook-token.txt` — kredensial / alamat akses.
- File Excel jurnal trading asli — isi trade, saldo, dan profit/loss nyata (data keuangan pribadi).
- `vendor/three.min.js` — library Three.js r128, unduh sendiri ke `mission-control/vendor/` bila ingin menjalankan kantor 3D-nya.

## Menjalankan (contoh)

```bash
cd mission-control
node server.js   # http://127.0.0.1:3001
```

Tiap folder punya README-nya sendiri. Project baru ditambahkan ke repo ini
setelah dibersihkan dari data dan secret — bukan semua file kerja langsung
di-push.
