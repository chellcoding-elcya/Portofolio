# Pipa Otomatisasi MT5 → Google Sheets (Jalur A: MT5API.dev)

Status: KERANGKA SIAP — menunggu (1) akun MT5API.dev milik Bos, (2) investor password MT5, (3) API key (dimasukkan via tautan aman, disimpan sebagai konektor custom).

## Alur
1. `sync.py` dipanggil terjadwal (cron, tiap 30 menit pada jam pasar) oleh Manager Killua.
2. Membaca `state.json` → watermark (waktu close terakhir + daftar ticket yang sudah masuk).
3. Menarik deals/posisi baru dari MT5API (REST) sejak watermark.
4. Memetakan ke format Jurnal (lihat `map_position()` di sync.py — logika sama dengan impor manual yang sudah terverifikasi: net = profit + komisi + swap; alasan close dari order reason/komentar `[so]` = Stop Out).
5. Menambah baris baru ke Google Sheets "Jurnal Trading Bos Archell" (anti-dobel: ticket yang sudah ada dilewati), deposit/withdrawal baru ke sheet Deposit.
6. Menyimpan watermark baru. Kegagalan di tengah jalan aman: run berikutnya mengejar dari watermark lama.

## Keamanan
- Hanya INVESTOR password (read-only) yang dipakai jembatan — tidak bisa trading.
- API key MT5API disimpan lewat Secure Vault sebagai konektor custom `custom.mt5api` (seperti Gemini/Claude), tidak pernah di chat / file biasa.
- Script ini TIDAK PERNAH memanggil endpoint tulis (order/close) — hanya baca.

## Yang belum pasti (verifikasi saat API key tersedia)
- Bentuk persis endpoint & field response MT5API.dev (dokumentasi API mereka) — sesuaikan `Mt5ApiClient`.
- Zona waktu server Exness vs WIB untuk kolom Hari/Jam (impor manual memakai waktu server MT5; pertahankan konsisten).
