#!/data/data/com.termux/files/usr/bin/bash
# Nyalakan server omp-webchat di dalam proot, supaya APK / browser di HP yang sama bisa
# membukanya di http://127.0.0.1:PORT.
#
# Jalankan di TERMUX (bukan di dalam proot):
#   bash ~/start-webchat.sh                       # project default ~ di dalam proot
#   bash ~/start-webchat.sh /root/Simple-WMS-telegram
#
# Override lewat env (semua opsional):
#   OMP_WEBCHAT_DRY_RUN=1          # cetak perintahnya saja, tidak dijalankan
#   OMP_WEBCHAT_LOGIN='proot-distro login ubuntu -- bash -lc'
#                                  # prefix perintah login; script menambahkan perintah server
#                                  # sebagai argumen terakhir. Isi ini kalau rootfs-mu dijalankan
#                                  # dengan cara sendiri. Harus berakhir dengan shell "-lc <cmd>".
#   DISTRO=ubuntu                  # alias proot-distro; default: dideteksi otomatis
#   OMP_WEBCHAT_PORT=7789          # default 7788
#   OMP_WEBCHAT_SERVER=/root/.../server.ts
#   OMP_WEBCHAT_PROJECT=/root/xyz  # sama dengan argumen pertama
set -u

PORT="${OMP_WEBCHAT_PORT:-7788}"
PROJECT="${1:-${OMP_WEBCHAT_PROJECT:-~}}"
DISTRO="${DISTRO:-}"
SERVER="${OMP_WEBCHAT_SERVER:-}"
LOGIN="${OMP_WEBCHAT_LOGIN:-}"
PREFIX_DIR="${PREFIX:-/data/data/com.termux/files/usr}"
PD_DIR="$PREFIX_DIR/var/lib/proot-distro"
LEGACY_DIR="$PD_DIR/installed-rootfs" # layout lama: <alias>/ adalah rootfs-nya
CONTAINER_DIR="$PD_DIR/containers"    # layout baru: <alias>/rootfs adalah rootfs-nya
SERVER_CANDIDATES="/root/.omp/plugins/node_modules/omp-webchat/src/server.ts /root/omp-webchat/src/server.ts"

say() { printf '%s\n' "$*"; }
die() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}

installed_aliases() {
	{
		ls -1 "$LEGACY_DIR" 2>/dev/null
		ls -1 "$CONTAINER_DIR" 2>/dev/null
	} | grep -v '^$' | sort -u
}

rootfs_path_for() {
	for candidate in "$LEGACY_DIR/$1" "$CONTAINER_DIR/$1/rootfs"; do
		[ -d "$candidate" ] && printf '%s\n' "$candidate" && return 0
	done
	return 1
}

diagnose() {
	say ""
	say "-- apa yang ditemukan --"
	say "proot-distro dir : $PD_DIR"
	say "  isi            : $(ls -1 "$PD_DIR" 2>/dev/null | tr '\n' ' ' || echo '(tidak ada)')"
	say "  installed-rootfs: $(ls -1 "$LEGACY_DIR" 2>/dev/null | tr '\n' ' ' || echo '(tidak ada)')"
	say "  containers      : $(ls -1 "$CONTAINER_DIR" 2>/dev/null | tr '\n' ' ' || echo '(tidak ada)')"
	say "kandidat login   : $(ls -1 "$HOME"/*.sh 2>/dev/null | tr '\n' ' ' || echo '(tidak ada *.sh di ~)')"
	say "proot di rc      : $(grep -ih -m3 -e proot "$HOME/.bashrc" "$HOME/.profile" "$HOME/.zshrc" 2>/dev/null | tr '\n' ' ' | cut -c1-300 || echo '(tidak ada)')"
	say ""
	say "Kalau distro-mu dijalankan dengan cara sendiri (bukan proot-distro), set prefix login-nya:"
	say "  OMP_WEBCHAT_LOGIN='bash ~/namawrapper.sh -- bash -lc' bash ~/start-webchat.sh"
}

# Script ini harus jalan di Termux. Di dalam proot proot-distro terlihat (bind) tapi menolak
# dijalankan, jadi yang membedakan adalah kernel release-nya.
case "$(uname -r)" in
*PRoot* | *proot*) die "script ini sedang jalan DI DALAM proot (uname: $(uname -r)).
  Keluar dulu ke Termux, lalu: bash ~/start-webchat.sh" ;;
esac

ALIASES="$(installed_aliases)"
if [ -z "$DISTRO" ] && [ -z "$LOGIN" ]; then
	count="$(printf '%s' "$ALIASES" | grep -c . || true)"
	case "$count" in
	0)
		say "error: tidak ada distro proot-distro di $PD_DIR"
		diagnose
		exit 1
		;;
	1) DISTRO="$ALIASES" ;;
	*)
		if printf '%s\n' "$ALIASES" | grep -qx ubuntu; then DISTRO=ubuntu
		elif printf '%s\n' "$ALIASES" | grep -qx debian; then DISTRO=debian
		else DISTRO="$(printf '%s\n' "$ALIASES" | head -1)"
		fi
		;;
	esac
fi

ROOTFS=""
[ -n "$DISTRO" ] && ROOTFS="$(rootfs_path_for "$DISTRO" || true)"

if [ -z "$SERVER" ] && [ -n "$ROOTFS" ]; then
	# rootfs bisa dibaca langsung dari Termux, jadi tidak perlu login hanya untuk mengecek berkas
	for candidate in $SERVER_CANDIDATES; do
		if [ -f "$ROOTFS$candidate" ]; then
			SERVER="$candidate"
			break
		fi
	done
fi
[ -n "$SERVER" ] || SERVER="/root/.omp/plugins/node_modules/omp-webchat/src/server.ts"
[ -n "$LOGIN" ] || LOGIN="proot-distro login $DISTRO -- bash -lc"
CMD="BUN_BE_BUN=1 omp run '$SERVER' --cwd $PROJECT --port $PORT"

if [ -n "${OMP_WEBCHAT_DRY_RUN:-}" ]; then
	say "project  $PROJECT"
	say "rootfs   ${ROOTFS:-'(tidak ditemukan)'}"
	say "login    $LOGIN"
	say "server   $SERVER"
	say "perintah: $LOGIN \"$CMD\""
	exit 0
fi

if curl -fsS -m 2 "http://127.0.0.1:$PORT/api/info" >/dev/null 2>&1; then
	say "sudah ada server yang jalan di http://127.0.0.1:$PORT — langsung buka app omp-webchat."
	say "(mau port lain? OMP_WEBCHAT_PORT=7789 bash ~/start-webchat.sh)"
	exit 0
fi

termux-wake-lock 2>/dev/null || say "(termux-wake-lock tidak tersedia; pasang paket termux-api kalau perlu)"
say "server   http://127.0.0.1:$PORT"
say "project  $PROJECT"
say "login    $LOGIN"
say "server.ts $SERVER"
say "Buka app omp-webchat sekarang. Jangan tutup sesi Termux ini; Ctrl+C untuk berhenti."

# LOGIN berakhir dengan shell yang menerima "-lc <cmd>", jadi perintah server jadi argumen terakhir.
exec $LOGIN "$CMD"
