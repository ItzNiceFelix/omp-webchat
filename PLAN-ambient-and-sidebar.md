# Rencana: ambient per status + collapse sidebar

Status: **belum disetujui**. Belum ada perubahan pada repo untuk kedua item di bawah.

---

## 1. Ambient per status (regresi dari `12c0ee0`)

### Masalah

Commit `20e36ca` punya 6 animasi ambient berbeda, satu per status:

| status | layer lama | gerak |
| --- | --- | --- |
| think | `.l-think` 3 orb | drift `mk-d1/d2/d3` 9/11/13s |
| tool | `.l-tool` | grid 28px + beam turun + orb |
| write | `.l-write` | 2 pita `mk-fl1/fl2` |
| retry / compact | `.l-wait` | drift amber |
| error | `.l-err` | vignette `errp` |
| done | `.l-done` | wash + ripple |

Commit `12c0ee0` mengganti **semuanya** dengan satu field F (veil + yin-yang). Akibatnya keenam status hanya berbeda warna dan kecerahan — bentuk geraknya identik. Itu regresi, bukan penyederhanaan.

### Keputusan

Dua tingkat, bukan enam layer penuh yang cross-fade.

**Tingkat 1 — basis, `animation-name` tidak pernah berubah.** Veil + orb yin-yang selalu terpasang dan berjalan. Status hanya menggeser nilai terdaftar:

| properti | transisi | efek |
| --- | --- | --- |
| `--ya` | 620ms linear | warna utama |
| `--yb` | 620ms linear | warna kedua |
| `--dim` | 420ms ease | opasitas veil |
| `--orb` | 480ms ease | opasitas orb |

Karena nama animasi tetap, tidak ada restart. Flip di tengah transisi melanjutkan dari frame yang tampil.

**Tingkat 2 — cue, satu per status.** Punya `animation-name` sendiri; hanya `opacity` yang cross-fade (200ms).

| status | cue | gerak | keyframes |
| --- | --- | --- | --- |
| idle | — | basis saja | — |
| think | `.motes` | 3 mote mengorbit, radius & kecepatan beda | `spin` 17s/26s/11s |
| tool | `.scan` | grid 28px diagonal + beam turun | `grid`, `beam` |
| write | `.flow` | 2 pita mengalir horizontal | `flowA`, `flowB` |
| retry / compact | `.rings` | 3 cincin keluar dari pusat | `ring` stagger 0.85s |
| error | `.vign` | vignette merah berdenyut | `beat` |
| done | `.rip` | wash 1.8s + ripple 1.6s | `wash`, `ripple` |

Kunci: `.cue, .cue *, .cue::before, .cue::after { animation-play-state: paused }`, hanya cue aktif yang `running`. Cue tersembunyi tidak memakan CPU dan melanjutkan dari frame terakhir saat statusnya kembali.

### Berkas yang disentuh

- `web/src/App.tsx` — tambah 6 elemen cue di dalam `.amb`, hapus komentar "one field for every phase" yang sekarang salah.
- `web/src/styles.css` — blok ambient: tambah `.cue` + keyframes + aturan `animation-play-state`; ubah `.vign` agar `beat` pindah ke `::after`.

### Jebakan yang sudah terbukti di simulasi

1. `animation: beat` menulis `opacity` di keyframes → menimpa `opacity: 0` milik `.cue`, vignette menyala di semua status. Pindahkan ke `::after`.
2. `.amb > i { display: block }` (0,1,1) mengalahkan `.vign { display: none }` di media query (0,1,0) — kelas bug yang sama dengan orb. Pakai `.amb > i.vign`.
3. `@media (prefers-reduced-motion)` dengan `.amb *` saja **tidak** mematikan `::before`/`::after`, padahal di situ letak grid, beam, dan beat. Harus `.amb *::before, .amb *::after`.

### Verifikasi yang akan dijalankan

- Invariant basis: baca `transform` `.yy` sebelum & sesudah flip dalam task yang sama (tanpa frame) selama 40 flip → harus `0`.
- Hammer 40 flip @35ms → mendarat di satu cue saja, tanpa tumpang tindih.
- Sapuan 8 status → tiap status tepat satu cue, animasi sesuai tabel.
- `LayoutDuration` tetap 0ms, `TaskDuration` < 1ms per status.
- Reduced motion: tidak ada animasi hidup (termasuk pseudo), veil 0.7×.

### Simulasi

`C:\Users\Hanaa\Downloads\omp-ambient-per-status.html` — sudah diverifikasi: 8 status, tiap status satu cue, invariant basis `0`, hammer bersih, reduced motion bersih.

---

## 2. Sidebar chat list tidak bisa collapse

### Temuan: bukan regresi, fitur itu tidak pernah ada

Sudah dicek menyeluruh, hasilnya negatif di semua tempat:

| yang dicek | hasil |
| --- | --- |
| `web/src/components/Sidebar.tsx` (HEAD) | tidak ada `collapse`/`collapsed`/`aria-expanded`/`<details>` |
| Riwayat file, semua commit (`git log --all`) | `Sidebar.tsx` tidak pernah punya logika collapse |
| `git log --all -S "collapse"` / `-S "collapsed"` | yang cocok hanya `border-collapse` (CSS tabel) dan komentar |
| `git log --all -S "<details"` | tidak ada |
| Mockup `omp webchat_ mockup gabungan.html` | tidak ada collapse |

Jadi **bukan hilang saat update**, dan **bukan hanya di HP**. Fitur itu memang belum pernah dibuat.

Yang ada sekarang: grup (`today` / `yesterday` / `previous 7 days` / `older`) dirender sebagai `<div className="group">` statis — teks saja, tidak bisa diklik. Di PC sidebar memang selalu terlihat (grid `288px`), di bawah 1100px jadi slide-over. Jadi tidak ada yang bisa dilipat di mana pun.

Satu-satunya elemen yang bisa dibuka-tutup di sidebar adalah kartu-kartu di bawah daftar (session, todos, queue, status, files) — dan itu pun tidak punya kontrol collapse; mereka muncul/hilang berdasarkan ada tidaknya data.

### Usulan

**Minimum, sesuai permintaan:** grup tanggal bisa dilipat.

- Ubah `<div className="group">` jadi `<button className="group" aria-expanded={...}>` dengan chevron.
- State per-label disimpan di `store.ts` (`collapsedGroups: Set<string>`), bukan di komponen, supaya tidak reset saat daftar di-reload atau chat berpindah.
- Default: semua terbuka. Grup yang berisi chat aktif tidak boleh tertutup otomatis.
- Baris di dalam grup yang tertutup tidak dirender sama sekali (bukan `display: none`), supaya tidak ada 200 baris tersembunyi yang tetap di DOM.
- Hitungan di label saat tertutup: `today · 4`.

Kenapa state di store, bukan `useState`: sidebar di-unmount saat `sidebarOpen` jadi false di bawah 1100px, dan daftar chat di-reload berkala. `useState` akan mengembalikan semua grup ke terbuka setiap kali.

**Opsional, kalau mau sekalian:** lipat juga kartu `session` / `todos` / `queue` / `status` / `files` dengan pola yang sama. Ini menambah nilai di layar pendek, tapi bukan yang kamu tanyakan — saya tidak akan menyentuhnya tanpa persetujuan.

### Berkas yang disentuh

- `web/src/store.ts` — `collapsedGroups: Set<string>` + `toggleGroup(label)`.
- `web/src/components/Sidebar.tsx` — `ChatRowView` menerima `collapsed`; grup jadi tombol; filter baris.
- `web/src/styles.css` — `.group` jadi tombol penuh lebar dengan chevron, target ≥ 40px saat `data-touch="true"`.

### Verifikasi yang akan dijalankan

- PC 1440px: klik grup → baris hilang, chevron berputar, `aria-expanded` berubah.
- HP 412px: sama, target sentuh ≥ 40px.
- Ganti chat saat sebuah grup tertutup → status lipat bertahan.
- Reload daftar chat (`RefreshCw`) → status lipat bertahan.
- Keyboard: `Tab` ke header grup, `Enter`/`Space` melipat.

---

## Yang tidak termasuk

- Tidak menyentuh `--orb` / `--dim` (sudah disetujui sebelumnya).
- Tidak mengubah warna fase, kontras, atau posisi orb.
- Tidak menambah dependency.
