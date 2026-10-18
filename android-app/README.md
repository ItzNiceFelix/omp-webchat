# omp-webchat Android (Capacitor)

WebView yang membuka server omp-webchat (default `http://127.0.0.1:7788`).
Server tetap jalan di Termux/proot atau di mesin lain; app ini hanya layarnya.

APK ini **tidak** membundel UI: WebView memuat `web/dist` yang disajikan oleh bridge
(`src/server.ts`), jadi perubahan UI tidak perlu rebuild APK — cukup layar koneksi ini yang
ikut berubah.

## Build APK (GitHub Actions)
1. `.github/` dan `android-app/` sudah ada di root repo ini; tidak ada yang perlu disalin.
2. Tab **Actions → Build Android APK → Run workflow** (juga otomatis saat push yang menyentuh
   `android-app/**` atau workflow-nya).
3. Unduh artifact `omp-webchat-debug-apk`, ekstrak, install `app-debug.apk`.

## Pakai
1. Salin `scripts/start-webchat.sh` ke `~/` di Termux, lalu `bash ~/start-webchat.sh`.
2. Buka app. Kalau server hidup, langsung terhubung.
3. Ganti alamat: tekan Back dari UI chat untuk kembali ke layar alamat.
