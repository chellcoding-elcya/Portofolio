#!/usr/bin/env bash
# watchdog.sh — cek tunnel Mission Control; jalankan via cron tiap 5 menit:
#   */5 * * * *  /home/hatch/workspace/mission-control/watchdog.sh
# Jika URL berubah / tunnel mati / server lokal mati:
#   - restart yang mati, update PUBLIC_URL.txt, catat ke watchdog-history.jsonl
#   - URL baru juga ditulis ke data/watchdog-notify.txt (dibaca Muse untuk dilaporkan ke user)
set -u
cd "$(dirname "$0")"
TS=$(TZ=Asia/Jakarta date +%Y-%m-%dT%H:%M:%S+07:00)
OLD_URL=$(tr -d '[:space:]' < PUBLIC_URL.txt 2>/dev/null || echo "")
log_event() { # $1=event $2=url
  printf '{"ts":"%s","event":"%s","url":"%s"}\n' "$TS" "$1" "$2" >> watchdog-history.jsonl
}
http_ok() { [ -n "$1" ] && curl -fsS --max-time 8 -o /dev/null "$1/api/health"; }
local_ok() { curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:3001/api/health"; }

# 1) server lokal mati? hidupkan lagi.
if ! local_ok; then
  nohup node server.js >> server.log 2>&1 &
  sleep 2
  log_event "server-restart" "$OLD_URL"
fi
# 2) tunnel sehat?
if http_ok "$OLD_URL"; then
  log_event "ok" "$OLD_URL"
  exit 0
fi
# 3) tunnel mati/URL basi → restart tunnel (mesin: Microsoft Dev Tunnels, lihat start-tunnel.sh)
./start-tunnel.sh >> watchdog.log 2>&1
NEW_URL=$(tr -d '[:space:]' < PUBLIC_URL.txt 2>/dev/null || echo "")
if http_ok "$NEW_URL"; then
  if [ "$NEW_URL" != "$OLD_URL" ]; then
    log_event "url-changed" "$NEW_URL"
    printf '%s %s\n' "$TS" "$NEW_URL" > data/watchdog-notify.txt
    echo "URL BARU: $NEW_URL"
  else
    log_event "tunnel-restart" "$NEW_URL"
  fi
else
  log_event "tunnel-failed" "$NEW_URL"
  echo "Tunnel masih gagal setelah restart. Cek devtunnel.log" >&2
  exit 1
fi
