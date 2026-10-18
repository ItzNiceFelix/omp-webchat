#!/data/data/com.termux/files/usr/bin/bash
# Nyalakan server omp-webchat di dalam proot, supaya APK / browser di HP yang sama bisa
# membukanya di http://127.0.0.1:PORT.
#
# Jalankan di TERMUX (bukan di dalam proot):
#   bash ~/start-webchat.sh                       # project default ~ di dalam proot
#   bash ~/start-webchat.sh /root/Simple-WMS-telegram
#
# Override lewat env (semua opsional):
#   DISTRO=ubuntu                  # alias proot-distro; default: dideteksi otomatis
#   OMP_WEBCHAT_PORT=7789          # default 7788
#   OMP_WEBCHAT_SERVER=/root/.../server.ts
set -u

PORT="${OMP_WEBCHAT_PORT:-7788}"
PROJECT="${1:-~}"
DISTRO="${DISTRO:-}"
SERVER="${OMP_WEBCHAT_SERVER:-}"
ROOTFS_DIR="${PREFIX:-/data/data/com.termux/files/usr}/var/lib/proot-distro/installed-rootfs"
SERVER_CANDIDATES="/root/.omp/plugins/node_modules/omp-webchat/src/server.ts /root/omp-webchat/src/server.ts"

say() { printf '%s\n' "$*"; }
die() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}

# Script ini harus jalan di Termux. Di dalam proot `proot-distro` tetap terlihat (bind), jadi
# yang membedakan adalah kernel release-nya dan tidak adanya rootfs di dalam guest.
case "$(uname -r)" in
*PRoot* | *proot*)
	die "script ini sedang jalan DI DALAM proot (uname: $(uname -r)).
  Keluar dulu ke Termux, lalu: bash ~/start-webchat.sh"
	;;
esac
command -v proot-distro >/dev/null 2>&1 ||
	die "proot-distro tidak ada di PATH — jalankan script ini di Termux (bash ~/start-webchat.sh)."

if [ -z "$DISTRO" ]; then
	installed="$(ls -1 "$ROOTFS_DIR" 2>/dev/null || true)"
	count="$(printf '%s' "$installed" | grep -c . || true)"
	case "$count" in
	0) die "tidak ada rootfs proot-distro di $ROOTFS_DIR.
  pasang dulu (proot-distro install ubuntu), atau set DISTRO=… kalau rootfs-nya di tempat lain." ;;
	1) DISTRO="$installed" ;;
	*)
		# beberapa distro terpasang: pakai yang cocok dengan yang paling umum, kalau tidak ada ambil yang pertama
		if printf '%s\n' "$installed" | grep -qx ubuntu; then DISTRO=ubuntu
		elif printf '%s\n' "$installed" | grep -qx debian; then DISTRO=debian
		else DISTRO="$(printf '%s\n' "$installed" | head -1)"
		fi
		;;
	esac
fi

if [ -z "$SERVER" ]; then
	# rootfs bisa dibaca langsung dari Termux, jadi tidak perlu login untuk mengecek berkasnya
	for candidate in $SERVER_CANDIDATES; do
		if [ -f "$ROOTFS_DIR/$DISTRO$candidate" ]; then
			SERVER="$candidate"
			break
		fi
	done
fi
[ -n "$SERVER" ] || die "server.ts tidak ditemukan di dalam $DISTRO (dicoba: $SERVER_CANDIDATES).
  Pasang pluginnya: proot-distro login $DISTRO -- bash -lc 'omp plugin install github:ItzNiceFelix/omp-webchat'"

if curl -fsS -m 2 "http://127.0.0.1:$PORT/api/info" >/dev/null 2>&1; then
	say "sudah ada server yang jalan di http://127.0.0.1:$PORT — langsung buka app omp-webchat."
	say "(mau port lain? OMP_WEBCHAT_PORT=7789 bash ~/start-webchat.sh)"
	exit 0
fi

termux-wake-lock 2>/dev/null || say "(termux-wake-lock tidak tersedia; pasang paket termux-api kalau perlu)"
say "server   http://127.0.0.1:$PORT"
say "project  $PROJECT   (distro: $DISTRO)"
say "server.ts $SERVER"
say "Buka app omp-webchat sekarang. Jangan tutup sesi Termux ini; Ctrl+C untuk berhenti."

exec proot-distro login "$DISTRO" -- bash -lc \
	"BUN_BE_BUN=1 omp run '$SERVER' --cwd $PROJECT --port $PORT"
