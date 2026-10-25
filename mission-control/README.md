# Mission Control — Dashboard Tim AI

Pusat kendali untuk memantau agent bekerja secara real-time. **Semua angka data nyata** —
dari ledger kerja, `/proc`, file cron, dan live-check tunnel. Tidak ada simulasi/placeholder angka.

## Menjalankan

```bash
cd ~/workspace/mission-control
node server.js            # http://127.0.0.1:3001
```

Verifikasi: `node --check server.js` lalu `curl -s http://127.0.0.1:3001/api/state | head -c 500`

## Akses publik (Microsoft Dev Tunnels + watchdog)

Mesin tunnel final: **Microsoft Dev Tunnels** (tunnel `mission-control`, port 3001, akses anonim,
kedaluwarsa 30 hari sejak dibuat 22 Okt 2026 → perpanjang dengan `devtunnel create` ulang / `devtunnel renew`).
bore terbukti mustahil dari VM ini (TCP mentah black-hole di gateway) dan Cloudflare quick tunnel
diblokir 403 oleh WAF Cloudflare untuk IP egress ini — keduanya didokumentasikan agar tidak dicoba ulang.

```bash
./bin/devtunnel user login -g -d   # prasyarat SATU KALI: login GitHub via kode perangkat
./start-tunnel.sh         # naikkan host tunnel, tulis PUBLIC_URL.txt SETELAH live-check 200
cat PUBLIC_URL.txt        # SELALU baca file ini + live-check HTTP 200 sebelum membagikan link
./watchdog.sh             # satu kali cek & perbaiki server/tunnel
```

Dua jebakan teknis yang sudah ditangani di skrip & server — jangan diutak-atik tanpa membaca ini:
1. Relay devtunnels (`wss://*.rel.tunnels...`) harus **direct, bukan lewat egress proxy** — lewat proxy
   header WebSocket-nya dirusak ("Connection: close"). `start-tunnel.sh` menambahkan domain relay ke `NO_PROXY`.
2. devtunnel meneruskan koneksi ke `localhost` yang bisa berarti **::1** — `server.js` karena itu
   listen di 127.0.0.1 *dan* ::1 (keduanya loopback, tidak terekspos keluar).

Watchdog via cron sistem (tiap 5 menit):

```
*/5 * * * * /home/hatch/workspace/mission-control/watchdog.sh
```

Setiap perubahan URL dicatat di `watchdog-history.jsonl` dan `data/watchdog-notify.txt`
agar mudah dilaporkan. URL tunnel bisa berubah bila tunnel dibuat ulang — jangan hafalkan, baca file-nya.

## Mencatat kerja agent ke ledger (PENTING — ini yang membuat dashboard hidup)

Append satu baris JSON per event ke `data/tasks.jsonl`:

- Setiap delegasi kerja → `started` dengan `task_id` yang **stabil** (slug yang sama dipakai sampai selesai).
- Selama berjalan boleh `progress`.
- Selesai → `done`, gagal → `failed` (task_id yang sama).

```json
{"ts":"2026-10-22T21:00:00+07:00","task_id":"bangun-mission-control","agent":"dani","subagent":"","title":"Bangun Mission Control","status":"started","detail":"server.js + index.html"}
```

Virtual Office sejak 24 Okt 2026 berbentuk kantor perusahaan (papan nama "KANTOR PUSAT TIM ARCHELL", 6 zona tim,
resepsi, meja rapat) dengan 24 robot: 6 pemimpin + 18 anak buah yang berjalan, duduk-kerja, dan
berkumpul di lobi saat pause. Menu "Portofolio Tim" menampilkan tugas `done` tiap karakter dari ledger.

Field `agent` HARUS id roster: `anca` (PM), `mu` (desain), `cipu` (video), `jaka` (QC visual),
`tono` (riset), `dani` (coding). Sejak 24 Okt 2026 setiap agent inti punya **3 anak buah tetap**
(id `<agent>-1/2/3`, roster & peran di `STRUKTUR-TIM.md`) — pekerjaan anak buah dicatat dengan
field `subagent` diisi id anak buah itu. Status terakhir per `task_id` menentukan agent tampil
working (duduk & mengetik/menggambar di Virtual Office) atau idle (berdiri di barisan belakang);
task yang berakhir `done` memicu animasi cheer hop robotnya.

File data lain:

| File | Isi |
|---|---|
| `data/queue.jsonl` | Antrean quick task `{"ts","prompt","agent","status":"queued\|done"}` — ditulis dari menu Task Queue (`POST /api/queue`) |
| `data/dispatch.json` | `{"paused":false}` — diubah tombol PAUSE/RESUME (`POST /api/dispatch`) |
| `data/agent_state.json` | Pause per-agent — diubah dengan klik robot di 3D / tombol di kartu agent (`POST /api/agent-pause`) |

## API

- `GET  /api/state` — agents, queue, tasks, system (/proc), vps, schedules, token, dispatch_paused, log
- `GET  /api/health` — `{ok:true}` (dipakai watchdog & live-check tunnel)
- `POST /api/queue` `{prompt, agent}` • `POST /api/dispatch` `{paused}` • `POST /api/agent-pause` `{agent, paused}`

## Menu Tugas Terjadwal

Backend membaca rekursif file `.md` ber-frontmatter YAML di `~/workspace/cron.d/` dan
`~/workspace/goals/*/crons/` (parser YAML mini tanpa library; file rusak di-skip).
`is_system:true` bila `metadata.created_by: system`, owner berawalan `system`, atau id bawaan sistem
(`heartbeat`, `agentic-feature-tour`). Label & jadwal berikutnya dihitung dalam zona file itu sendiri (umumnya WIB).

## Kartu Memory (VPS)

Kartu **MEMORY (CONTAINER)** menampilkan jumlah RSS semua proses yang terlihat di `/proc/<pid>/statm`
(kolom resident × page size) — BUKAN MemTotal host dari `/proc/meminfo` yang menyesatkan di dalam container.
Angka host hanya ditampilkan sebagai subteks "di luar kendali".

## Token Status

Backend menjalankan `subscription-status status` (cache 60 detik) dan mem-parse persen pemakaian
+ waktu reset. Jika perintah itu tidak ada/gagal, menu menampilkan placeholder jujur tanpa angka palsu.

## Struktur

```
server.js          backend Node murni (http/fs/path/os/child_process)
index.html         frontend satu file + Three.js lokal
vendor/three.min.js  Three.js r128 (vendored, tanpa CDN)
data/              ledger JSONL/JSON di atas
start-tunnel.sh    Dev Tunnels host → PUBLIC_URL.txt (setelah live-check 200)
watchdog.sh        cek 5-menitan: server + tunnel, catat watchdog-history.jsonl
PUBLIC_URL.txt     URL publik terakhir (sumber kebenaran untuk link)
```
