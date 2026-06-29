#!/data/data/com.termux/files/usr/bin/bash
# Jalankan bot dengan auto-restart kalau mati
termux-wake-lock 2>/dev/null
while true; do
  echo "=== Menjalankan bot $(date) ==="
  node bot.js
  echo "=== Bot berhenti. Restart dalam 5 detik... ==="
  sleep 5
done
