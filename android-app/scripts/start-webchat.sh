#!/data/data/com.termux/files/usr/bin/bash
# Jalankan di Termux (bukan di dalam proot). Menyalakan wake-lock lalu menjalankan server di proot.
# Pakai:  bash ~/start-webchat.sh [folder-project-di-dalam-proot]
# Ganti distro:  DISTRO=ubuntu bash ~/start-webchat.sh
DISTRO="${DISTRO:-debian}"
PROJECT="${1:-~}"
PORT="${OMP_WEBCHAT_PORT:-7788}"
SERVER="${OMP_WEBCHAT_SERVER:-/root/.omp/plugins/node_modules/omp-webchat/src/server.ts}"

termux-wake-lock 2>/dev/null || echo "(termux-wake-lock tidak tersedia; pasang paket termux-api bila perlu)"
echo "Server di http://127.0.0.1:${PORT}  (distro: ${DISTRO}). Tekan Ctrl+C untuk berhenti."
exec proot-distro login "$DISTRO" -- bash -lc \
  "BUN_BE_BUN=1 omp run '$SERVER' --cwd $PROJECT --port $PORT"
