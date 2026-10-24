## Koreksi

Diperiksa terhadap kode di `web`, `AGENTS.md`, `DESIGN.md`, `docs/design/TOKENS.md`, `docs/HANDOFF.md`, dan dokumentasi HeroUI v3.2.6. Dokumentasi dibaca dari `https://heroui.com/react/llms-full.txt` dan `unpkg.com/@heroui/styles@3.2.6` (`package.json`, `dist/index.css`, `dist/base/base.css`, `dist/themes/default/variables.css`, `dist/themes/shared/theme.css`, `dist/components/button.css`). Tidak ada file proyek yang diubah. Satu poin belum terverifikasi (K11) dan diberi tanda.

| # | Severity | Masalah | Perbaikan |
|---|---|---|---|
| K1 | **Kritis** | Aturan dasar di `app/globals.css` tidak berada di layer mana pun, misalnya `:where(input…){border;background;border-radius}`, `:focus-visible{outline}`, `:where(a){color}`, `body`, dan `.btn`. HeroUI memuat semua stylesnya di dalam `@layer` (`dist/index.css`: `@layer theme, base, components, utilities`). CSS yang tidak berada di layer selalu menang atas CSS di dalam layer, apa pun spesifisitasnya. Akibatnya Input/TextField/Select HeroUI tetap mendapat border dan latar Potongin, dan cincin fokusnya dobel. Rencana menganggap "base Potongin tetap berlaku" itu aman, padahal tidak. | Fase 0: deklarasikan `@layer theme, base, components, utilities;` di baris pertama `globals.css`. Pindahkan aturan elemen dan blok dasar (`.btn`, `.panel`, `.notice`, dst.) ke `@layer base`. Token `:root` dan blok reduced-motion tetap di luar layer, karena `app-shell.test.mjs` dan `rootColourTokens` di `tests/support/ui-guards.mjs` hanya membaca `:root` yang tidak berada di layer. Langkah ini juga memengaruhi editor, jadi wajib lolos e2e editor + parity + screenshot tanpa diff. |
| K2 | **Kritis** | `RouterProvider (router.push)` di §4.8 membuat setiap `href` di komponen React Aria (Link, Button, Dropdown.Item, baris Table) berpindah halaman lewat navigasi klien. Tautan "Edit klip" di menu `⋯` baris Proyek akan membuka editor tanpa header COOP/COEP (`next.config.mjs`: header itu hanya ada pada pemuatan dokumen) dan dengan `ui.css` masih terpasang. Tes `ui-foundation` usulan rencana hanya memeriksa `next/link`. | Jangan pasang `RouterProvider`. Shell sekarang sudah murni `<a>` (`components/AppShell.jsx`). Kalau nanti tetap dipasang, `navigate` wajib memakai `window.location.assign` untuk path `/edit`. Tes juga harus menolak `RouterProvider` atau mewajibkan pengecualian itu, dan memastikan semua `editorHref(...)` dirender sebagai `<a>` biasa. |
| K3 | **Tinggi** | Klaim "sudah multi-user di sisi backend" salah. `lib/auth.mjs` hanya mengenal satu pengguna dari env (`APP_USERNAME`/`APP_PASSWORD`), dengan token HMAC tanpa id dan tanpa peran. "Keluar dari semua perangkat" tidak mungkin tanpa penyimpanan sesi. Penjaga `/admin` di server juga belum punya data peran. | Tandai Fase 7 dan seluruh visibilitas per peran sebagai **terblokir oleh backend** (tabel pengguna, sesi dengan id+peran, `proxy.js` membaca peran). "Keluar dari semua perangkat" dihapus dari lingkup sampai ada penyimpanan sesi. |
| K4 | **Tinggi** | Rename `.chip`→`.badge` bentrok dengan kelas BEM `.badge` milik komponen `Badge` HeroUI. `.table` dan `.tableWrap` tidak dipakai di JSX mana pun (0 pemakaian), jadi rename ke `.dataTable` hanya kerja sia-sia. | `.chip`→`.statusPill`, atau langsung ganti ke `Chip` per layar. `.table`/`.tableWrap` dihapus. `.card` digabung ke `.panel`. |
| K5 | **Tinggi** | Klaim "`size="md"` = 44 px" salah. `button.css` HeroUI: dasar/`md` `h-10 md:h-9` (40/36 px), `sm` `h-9 md:h-8`, `lg` `h-11 md:h-10`. Bentuknya `rounded-3xl` (pil), padahal TOKENS.md membatasi pil untuk chip/status saja. Varian bawaan Button adalah `primary`, artinya lime, sehingga setiap `<Button>` tanpa `variant` jadi lime. | Di `ui.css` (`@layer components`): `.button, .tabs__tab, menu/listbox item, .close-button, …{min-height:44px}` dan `.button{border-radius:var(--radius-m)}`. Tes baru: setiap `<Button` wajib menulis `variant`, dan paling banyak satu `variant="primary"` per file halaman. |
| K6 | **Tinggi** | Lime bocor ke keadaan "terpilih". HeroUI memakai `--accent`/`--accent-soft*` untuk Switch aktif, Checkbox, Radio, Chip/Alert berwarna accent, dan lainnya. Ini melanggar TOKENS.md "Pilihan aktif memakai tepi terang dan `--surface-3`, bukan lime". Contohnya Pengaturan dan drawer publikasi akan penuh switch lime. | Override di `ui.css`: Switch, Checkbox, Radio, dan ToggleButton yang terpilih memakai `--text`/`--surface-3`. `--accent-soft*` dipetakan ke netral. Varian `accent` tidak boleh dipakai di Chip/Alert. |
| K7 | **Tinggi** | Arti `--border` berbeda. Di Potongin `--border` hanya hiasan (1,31:1, TOKENS.md). Di HeroUI, `.button--outline` memakai `border-border` dan `base.css` memasang `*{border-color:var(--border)}`. Chip pilihan di rencana memakai varian `outline`, sehingga tepi kontrolnya cuma 1,31:1 dan gagal WCAG 1.4.11. | `.button--outline{border-color:var(--border-strong)}`, atau pakai `secondary`. Klaim "arti `--border` sama" dihapus. |
| K8 | **Tinggi** | Pemetaan token belum lengkap. Variabel HeroUI berikut tidak dipetakan: `--surface-secondary(-foreground)`, `--surface-tertiary(-foreground)`, `--surface-hover`, `--segment(-foreground)`, `--backdrop`, `--scrollbar*`, `--default-hover`, `--default-soft*`, `--accent-soft*`, `--danger-soft*`, `--warning-soft*`, `--success-soft*`, `--field-hover`, `--field-focus`, `--field-border-hover`, `--field-border-focus`, `--background-secondary/-tertiary/-inverse`, `--border-secondary/-tertiary`, `--separator-secondary/-tertiary`, `--surface-shadow`, `--overlay-shadow`, `--field-shadow`. Variabel yang tidak dipetakan memakai nilai oklch HeroUI dari `node_modules`. `ui-guards` hanya memindai `app/` dan `components/`, jadi warna di luar token ini lolos tanpa cek kontras. | Semua variabel diberi alias ke token Potongin. Tes baru membaca daftar variabel di `node_modules/@heroui/styles/dist/themes/default/variables.css` dan gagal kalau ada yang belum diberi alias. Tes ini juga menangkap variabel baru setelah upgrade. |
| K9 | Sedang | `--radius-xl: 20px` milik Potongin (tidak di layer) menimpa `--radius-xl: calc(var(--radius)*1.5)` milik HeroUI/Tailwind (`themes/shared/theme.css`). `--ease-out`/`--ease-in-out` Potongin juga menimpa kurva Tailwind. | Tidak perlu rename (editor memakai token itu). Cukup dicatat di TOKENS.md: `rounded-xl` = 20 px dan `ease-out` mengikuti Potongin. Pilih `--radius` supaya `rounded-lg` = `--radius-m`. |
| K10 | Sedang | Klaim "impor granular belum didokumentasikan" salah: dokumentasi punya bagian "Selective Imports". Daftar impor di rencana juga kurang. `@heroui/styles/base` dibutuhkan (isinya bukan preflight: `--z-index-overlay`, susunan Toast di atas Modal). Yang juga dibutuhkan: `tw-animate-css`, `@heroui/styles/utilities` (`no-highlight`, dll.), dan `@heroui/styles/variants` (`motion-reduce` yang juga membaca `data-reduce-motion`). | Pakai daftar impor yang benar (§4.2). Semua path ini sudah dicocokkan dengan `exports` di `package.json` 3.2.6. |
| K11 | Sedang | (Perlu diverifikasi di spike) Sepertinya React Aria tidak menyertakan terjemahan Indonesia. Dengan `I18nProvider locale="id-ID"`, tanggal dan angka akan berformat id-ID, tetapi label tersembunyi kemungkinan tetap Inggris: "Clear search", "Dismiss", "Select all", label segmen tanggal, tutup Toast, Pagination. | Beri `aria-label` Indonesia secara eksplisit di setiap bagian itu. Tambah e2e yang memindai nama aksesibel dan menolak kata Inggris yang umum. |
| K12 | Sedang | Logout lewat POST form di dalam `Dropdown.Item` tidak valid. Item menu ber-role `menuitem`, sehingga Enter memicu `onAction` dan bukan submit. Sementara itu `app-shell.test.mjs:121` mengunci `<form method="post" action="/api/auth/logout">` di AppShell. | Form logout tetap ada di AppShell (disembunyikan, dengan ref). `Dropdown.Item onAction` memanggil `form.requestSubmit()`. |
| K13 | Sedang | Pintasan satu tombol (`N`, `/`, `j`/`k`) melanggar WCAG 2.1.4 kalau tidak bisa dimatikan. Pindah klip di editor memakai `Ctrl+Shift+←/→` (`components/editor/TopBar.jsx`), jadi `j`/`k` tidak konsisten. | Pintasan hanya aktif kalau fokus tidak sedang di field dan tidak ada overlay terbuka. Tambah Switch "Pintasan satu tombol" di Pengaturan → Tampilan. Penampil klip memakai `←/→`, `j`/`k` dibuang. |
| K14 | Sedang | Klaim "halaman error tanpa shell" salah: `app/not-found.jsx`, `app/error.jsx`, dan `app/licenses/page.jsx` memakai AppShell. 404 di rute editor juga merender `not-found` ber-shell. `.btn` masih dipakai di `app/global-error.jsx`, yang punya `<html>` sendiri tanpa `ui.css`, serta di `NotFoundActions.jsx`, `ClipText.jsx`, `ClipLibrary.jsx`, dan `CancelJob.jsx`. Penghapusan `.btn` di Fase 10 akan merusaknya. | `/licenses` ditambahkan ke daftar rute. `.btn` minimal dipertahankan untuk `global-error`. Tes `ui-foundation` mengecualikan 404 dengan sadar. |
| K15 | Sedang | Halaman lisensi terlewat. `/licenses` (`app/licenses/notices.mjs`, `public/licenses/`, `tests/licenses.test.mjs`) harus mencantumkan `@heroui/react` dan `@heroui/styles` (MIT), `react-aria` dan `react-aria-components` (Apache-2.0), `@internationalized/date`, `tailwind-variants`, `tw-animate-css`, serta `tailwindcss` (CSS keluarannya ikut dikirim). | Dikerjakan di Fase 0, test-first. |
| K16 | Sedang | Inventaris kata status belum lengkap. Selain "Berjalan" (`lib/project-view.mjs:120`), masih ada "Menunggu", "Sedang diproses", dan "Dibatalkan sebelum selesai" (`lib/project-view.mjs`, `lib/primary-job-queue.mjs`), serta "Menunggu giliran diproses." (`lib/dashboard-view.mjs`). Rencana juga bertentangan dengan dirinya sendiri: copy tinggal di `lib/*-view.mjs`, padahal §4.11 menyebut file itu "tidak berubah". | Buat satu sumber `lib/status-words.mjs`. Aturannya jadi: logika view tetap, copy di view module ikut diganti beserta tesnya. Status postingan memakai set terpisah. |
| K17 | Sedang | Dampak ke tes diremehkan. Ada sekitar 600 baris selector di e2e non-editor, bukan 470. `selectOption` di `trends.spec` (4) dan `settings-watermark.spec` (1) rusak karena Select React Aria bukan `<select>`. `getByRole("checkbox")` berubah menjadi `switch`. Field di dalam popover chip tidak ada di DOM sampai popover dibuka (`dashboard.spec.mjs:131-142` `getByLabel("Jumlah klip")`). Helper login `e2e/support/harness.mjs:22-27` bergantung pada `input[name="username"]`, `input[name="password"]`, dan `button[type="submit"]`. `header-badge.spec` memakai `.appSide .jobBadge`, `.jobBadgeDot`, `.jobBadgeText`, `.brandName`. Proyek `mobile-chromium` hanya menjalankan `read-only` dan `smoke`. `tests/login-view.test.mjs` tidak ada: login diuji di `entry-pages.test.mjs` dan `login-rate-limit.test.mjs`. Daftar tes unit juga belum memuat `storage-status-ui`, `look-preview`, `layout-names`, `llm-settings-view`, `focus`, `help-catalog`/`help-guide`, dan `licenses`. | Daftar tes per fase diperbaiki (§5). Login tetap form POST native dengan `name` yang sama. Kelas yang dipakai header-badge dipertahankan. Tambah proyek mobile untuk `app-shell.spec`. |
| K18 | Sedang | `Accordion` di Bantuan memutus deep link error seperti `/bantuan#download_bot_check` dan `#llm_quota_exhausted` (`lib/help-catalog.mjs`). `help-page.test.mjs` juga mewajibkan halaman ini "works without JS". | Entri error tetap berupa anchor yang selalu dirender. Hanya Panduan yang memakai `Disclosure`, dan item yang cocok dengan hash dibuka otomatis. |
| K19 | Sedang | `?klip=` yang sudah ada berisi nomor klip N, bukan id (`app/projects/[id]/page.jsx:441,622`, dipakai grid Riwayat). | Format `?klip=N` dipertahankan. |
| K20 | Sedang | DESIGN.md sekarang mewajibkan `.pageHead` + satu kalimat fungsi dan tiga lipatan, dan AGENTS.md mewajibkan DESIGN.md diikuti. Fase 0 rencana "mengubah DESIGN.md" sebelum ada persetujuan owner. Selain itu `feat/ux-redesign-workspace` belum di-merge (`docs/HANDOFF.md` §9). | Gerbang G0 ditaruh sebelum Fase 0: owner menyetujui amandemen dan PR redesign sudah masuk `main`. |
| K21 | Sedang | Halaman depan menyebut "panel Hasil" (`app/page.jsx:15,146,155,162`) dan memakai tangkapan `public/landing/editor.webp`. Keduanya basi kalau aside Hasil dan panel samping dihapus. | Tambah tugas copy dan gambar halaman depan di Fase 3, dengan `entry-pages.test`. |
| K22 | Sedang | `web/postcss.config.mjs` menggantikan pipeline PostCSS bawaan Next untuk SEMUA CSS, termasuk modul editor. Deteksi sumber otomatis Tailwind juga memindai `components/editor`. | Di spike, bandingkan CSS editor hasil build sebelum dan sesudah. Tambah `@source not "../components/editor"`. |
| K23 | Sedang | Estimasi 33–34 hari tidak realistis. Fase 0 sekarang mencakup layering globals (K1), alias penuh (K8), override komponen (K5–K7), dan lisensi. Ukuran halaman: `dashboard/page.jsx` 972 baris, `settings/page.jsx` 905, `projects/[id]/page.jsx` 783. Setiap fase butuh run CI `editor-gates.yml`. | Sekitar 52–66 hari kerja untuk UI (§5). Fase 7–9 menunggu backend. |
| K24 | Sedang | Tabs Pengaturan dengan bar simpan "untuk tab aktif": panel React Aria yang tidak aktif di-unmount, sehingga perubahan yang belum disimpan hilang saat pindah tab. | Panel tetap terpasang (`shouldForceMount`), atau pindah tab ditahan dengan dialog "Simpan perubahan?". |
| K25 | Sedang | Ada layar yang belum ada: ganti kata sandi pertama untuk akun buatan admin; hasil kembali dari OAuth sosial (berhasil, ditolak, kedaluwarsa); keadaan pengguna baru tanpa AI ("AI belum diatur · hubungi admin"); lokasi pengaturan global admin; status bingkai/reframe per klip di penampil; antrean dan unggah ulang ingest. | Ditambahkan di §2–§3. |
| K26 | Rendah | Copy masih bertele-tele atau berjargon: "Pemilihan klip memakai 24 hasil terukur." ; "Membuat job…" (kata Inggris) ; "[Ubah fokus dan proses ulang]" ; "Grafik muncul setelah 7 hari data" ; "Gagal: akun perlu dihubungkan ulang" ; "Lepas untuk mengunggah" ; "Tidak ada yang cocok dengan "x"" ; baris "AI: OpenRouter · aktif [Atur]" yang selalu tampil, melanggar prinsip 6. | Masing-masing jadi: "Umpan balik: 24 klip" ; "Menyiapkan…" ; [Proses ulang] ; "Data belum cukup" ; "Akun perlu dihubungkan ulang" ; "Lepas di sini" ; "Tidak ditemukan" ; status AI hanya tampil kalau ada masalah. |
| K27 | Rendah | Prinsip "lima kata status tetap" bertabrakan dengan status postingan (Terjadwal, Terbit, …). | Pisahkan dua set: status proses dan status postingan. |
| K28 | Rendah | Kelas palet bawaan Tailwind (`bg-red-500`, `text-white`) tidak tertangkap guard. Guard JS hanya menangkap string yang seluruhnya berupa warna. | Di `ui.css`: `@theme { --color-*: initial; }`. Guard juga menolak `-[#` dan nama palet Tailwind di `className`. |
| K29 | Rendah | Catatan API (sudah dicek di dokumentasi). Benar: `Toast.Provider placement="bottom end"`, `toast()`, `Table.ScrollContainer > Table.Content`, `Table.LoadMore` + `Table.LoadMoreContent`, `Drawer.Backdrop > Drawer.Content placement="left" > Drawer.Dialog`, `Dropdown.Trigger/Popover/Menu/Item` (`variant="danger"`), `Kbd.Content`, `Avatar.Fallback`, `linkVariants()`/`buttonVariants()` dari `@heroui/styles`, DatePicker `granularity`/`hourCycle`/`hideTimeZone`, peer `react-aria@^3.52.1`, `react-aria-components@^1.21.1`, `@internationalized/date@^3.12.4`. Yang meleset: `TagGroup` hanya menampilkan tag (input hashtag butuh `TextField` + `TagGroup`), dan role `Alert` belum pasti. | Di login, tulis `role="alert"` secara eksplisit. Komposisi hashtag disebut terang-terangan. |
| K30 | Rendah | `html className="dark"` mengubah regex yang dikunci `app-shell.test.mjs:252` (`<html lang="id" className={dmSans.variable}>`). Karena token Potongin tidak di layer dan selalu menang, `.dark` hanya berguna untuk varian `dark:`. | Cukup `data-theme="dark"`. Tes diperbarui di Fase 0. |
| K31 | Rendah | Proses clean-room belum tertulis. | Tambah: catatan IA tertulis saja, tanpa menempel tangkapan layar SupoClip, tanpa menyalin string/markup/struktur komponen (SupoClip memakai Radix/shadcn), dan setiap PR mencatat "rujukan: catatan IA, bukan kode". |

---

# Rencana Overhaul UI Dashboard Potongin (HeroUI v3), revisi

Rencana read-only. Path relatif ke ``.

## 0. Gerbang sebelum mulai

- **G0a.** PR `feat/ux-redesign-workspace` sudah masuk `main` (`docs/HANDOFF.md` §9). Overhaul dimulai dari situ.
- **G0b.** Owner menyetujui amandemen DESIGN.md (§5, akhir) sebelum fase layar pertama.
- **G0c.** Kontrak API backend untuk multi-user, sosial, dan analitik tersedia. Sebelum itu, Fase 7–9 hanya berupa UI di atas `page.route` e2e, tersembunyi di balik flag.

Temuan teknis dasar:

- Shell dan masuk ke editor sudah memakai `<a>` (`components/AppShell.jsx`, `EditorEntry` di `app/projects/[id]/page.jsx:140-152`, `TopBar.jsx:41`). COOP/COEP hanya berlaku pada pemuatan dokumen (`next.config.mjs`). CSS HeroUI bisa dibatasi ke halaman ber-shell, **asalkan tidak ada router klien** (K2).
- Semua CSS HeroUI berada di dalam layer. Base `globals.css` yang tidak di layer akan selalu menang, jadi base itu harus dipindah ke layer (K1).

## 1. Prinsip UI

1. Satu aksi lime per layar (`variant="primary"`). `Button` lain wajib menulis `variant` (`secondary`, `tertiary`, atau `ghost`), atau masuk ke menu `⋯`.
2. Label, bukan kalimat. Kepala halaman berisi judul + aksi. Hint paling banyak 6 kata, hanya kalau mencegah salah input. Error ditulis sebagai masalah + perbaikan.
3. Default tampil sebagai chip dengan nilainya: `8 klip`, `9:16`, `30–60 dtk`, `Karaoke`.
4. Hasil muncul di tempat kerja. Setelah Buat klip, pengguna dibawa ke `/projects/[id]`.
5. **Status proses:** Antre, Diproses, Selesai, Gagal, Dibatalkan. **Status postingan:** Terjadwal, Mengunggah, Terbit, Gagal. Keduanya bersumber dari satu file `lib/status-words.mjs`.
6. Sembunyikan, jangan matikan. Status AI, penyimpanan, dan cookies hanya tampil kalau ada masalah.
7. State seragam:
   - Memuat: skeleton.
   - Kosong: judul + 1 tombol.
   - Hasil saring kosong: "Tidak ditemukan".
   - Gagal memuat: pesan + [Coba lagi].
   - Hasil aksi: toast.
8. A11y tidak boleh turun:
   - Target 44 px dipasang di CSS, bukan lewat prop `size`.
   - Cincin `--focus`, skip link, live region.
   - Reduced motion dan `forced-colors`.
   - `aria-label` Indonesia untuk label bawaan React Aria.
   - Pintasan satu tombol bisa dimatikan.
   - Tanpa label versi ("Latest only").
9. Keadaan terpilih memakai `--text`/`--surface-3`, tidak pernah lime. Tepi kontrol memakai `--border-strong`.

## 2. Arsitektur informasi

### 2.1 Sidebar (≥1024 px, 232 px)

```
▣ Potongin
[ + Buat klip ]                 tombol netral kuat
● 1 diproses · 42%              JobBadge (.jobBadge tetap)
▤ Proyek
⇪ Sosial                        flag publikasi
▲ Analitik                      flag publikasi
✦ Tren
⚙ Pengaturan
⛨ Admin                         peran admin
? Bantuan
(AS) andi ⌄                     Dropdown: Akun · Keluar
```

- **Di bawah 1024 px:** bar atas berisi Brand, JobBadge pendek, dan [Menu], yang membuka `Drawer` dari kiri.
  - Escape atau Tutup menutupnya, fokus kembali ke Menu, dan halaman di belakangnya tidak bisa diakses selama drawer terbuka.
  - Daftar menu dirender oleh satu komponen `NavList` (satu `<nav aria-label="Menu utama">` di source).
  - Menu memakai `<a>` biasa.
- **Keluar:** form `POST /api/auth/logout` tetap ada di AppShell (tersembunyi). `Dropdown.Item onAction` memanggil `requestSubmit()`.
- **Pintasan** (bisa dimatikan di Pengaturan → Tampilan; aktif hanya di luar field dan overlay):
  - `N` ke Buat klip.
  - `/` ke kolom cari.
  - `←/→` di penampil klip.

  Semua pintasan dicatat di `lib/help-guide.mjs` (`GUIDE_SHORTCUTS`).
- **Data menu:** `lib/app-nav.mjs` menjadi `NAV_LINKS` datar dengan `{role, feature}`, dan `navLinks(pathname, {role, features})`. `lib/app-menu.mjs` (`MENU_BREAKPOINT_PX`, `MENU_QUERY`) tetap dipakai.

### 2.2 Rute

| Lama | Baru | Label | Catatan |
|---|---|---|---|
| `/dashboard` | tetap | Buat klip | Aside "Hasil" dihapus, redirect ke proyek |
| `/projects` | tetap, `?tab=klip` | Proyek | Dulu "Riwayat" |
| `/projects/[id]` | tetap, `?klip=N` | — | Format N lama dipertahankan |
| `/projects/[id]/clips/[clipId]/edit` | tidak berubah | — | `<a>` + pemuatan penuh, tanpa `ui.css` |
| `/trends` | tetap | Tren | Dulu "Konteks Tren" |
| `/settings` | `#ai\|transkripsi\|tampilan\|youtube\|akun\|sistem` | Pengaturan | Id anchor sudah ada di `settings/page.jsx:773-882` |
| `/bantuan` | tetap | Bantuan | Anchor `#<kode>` tetap |
| `/licenses` | tetap, di shell | (tautan di Bantuan dan Sistem) | Notice dependensi baru |
| `/login` | tetap | — | Form POST native dengan `name` sama |
| — | `/akun/kata-sandi` | — | Ganti kata sandi pertama (setelah backend) |
| — | `/sosial` (`?tab=akun`, `?hasil=terhubung\|ditolak\|gagal`) | Sosial | Kembali dari OAuth |
| — | `/analitik` | Analitik | |
| — | `/admin/pengguna`, `/admin/job` | Admin | 404 untuk non-admin |

### 2.3 Peran (setelah backend menyediakan sesi dengan id dan peran)

| Area | User | Admin |
|---|---|---|
| Buat klip, Proyek, Tren (daftar), Bantuan | ✓ (milik sendiri) | ✓ |
| Sosial, Analitik | ✓ kalau flag aktif | ✓ |
| Pengaturan: Tampilan, Akun | ✓ | ✓ |
| Pengaturan: AI, Transkripsi, YouTube, Sistem | sesuai Pertanyaan 1; kalau global: tidak tampil, Buat klip menampilkan "AI belum diatur · hubungi admin" bila perlu | ✓ |
| Tren: Agen | ✗ | ✓ |
| Admin | 404 | ✓ |

Penjagaan admin ada di server, lewat layout server + API + `proxy.js`.

## 3. Per layar

Komponen yang disebut adalah komponen HeroUI v3. Ikon tetap `AppIcon`.

### 3.1 Shell (`components/AppShell.jsx`)

- **Komponen:**
  - Menu: `<a>` + `linkVariants()`.
  - Penataan: `Separator`.
  - Menu akun: `Avatar` (+`Avatar.Fallback`) dan `Dropdown`.
  - Menu sempit: `Drawer` (`Drawer.Backdrop > Drawer.Content placement="left" > Drawer.Dialog`).
  - Hint: `Kbd`.
- **Dipertahankan:**
  - `.skipLink` → `#konten`, `<main id="konten">`, `aria-current="page"`.
  - Kelas `.appSide`, `.jobBadge`, `.jobBadgeDot`, `.jobBadgeText`, `.brandName` (dipakai `e2e/header-badge.spec.mjs`).
- **Dihapus:**
  - Label kelompok.
  - `.appScrim` dan scroll-lock buatan sendiri (`globals.css:422-453`).
  - Reducer drawer. Asersinya dipindah ke e2e: fokus kembali ke Menu, latar inert, Escape.

### 3.2 Buat klip (`/dashboard`)

**Aksi utama:** Buat klip.

```
Buat klip
🔗 [ Link YouTube                      ] [ Buat klip ]
   atau [Pilih file]  + .srt
(8 klip ▾)(9:16 ▾)(30–60 dtk ▾)(Bingkai: Ikuti wajah ▾)
(Subtitle: Karaoke ▾)(Hook ▾)(Fokus ▾)(ID · 1080p ▾)
⚠ YouTube minta login · [Pasang cookies]     ← hanya kalau ada masalah
Terbaru                                     Semua proyek →
```

- **Komponen:**
  - Sumber: `TextField`. Area file tetap custom dengan overlay "Lepas di sini".
  - Chip: `Button variant="secondary"` + `Popover`. Isi popover:
    - Jumlah: `NumberField`.
    - Rasio: `ToggleButtonGroup`.
    - Durasi: `RadioGroup` + 2× `NumberField`.
    - Bingkai: `RadioGroup` (Ikuti wajah, Ikuti pembicara, Tengah, Blur).
    - Subtitle: `ListBox` + `LookPreview`.
    - Hook: `Switch` ×2.
    - Fokus: `TagGroup` + `TextArea`.
    - Bahasa dan resolusi: `Select` ×2.
  - Masalah: `Alert`.
  - Terbaru: `Card` + `Chip`.
- **State:**
  - Terbaru kosong: tidak dirender. Memuat: 4 `Skeleton`.
  - Submit: `isPending` dengan status "Mengunggah 42%" → "Memeriksa video…" → "Menyiapkan…".
  - Antre: "Antre · urutan 2".
  - Unggah putus: [Coba lagi].
  - Gagal: error di bawah field (`aria-describedby`). Fokus dipindah ke field itu; kalau field ada di dalam chip, popover chip dibuka dulu (perilaku `dashboard/page.jsx:342-350` dipertahankan).
- **Dihapus:**
  - Kalimat kepala halaman (`:598`) dan paragraf bantuan.
  - Deskripsi di `lib/dashboard-choices.mjs:15-29` (cukup label + glyph).
  - Aside Hasil dan tiga `<details>`.
- **Copy:** "Link YouTube", "Pilih file", "Ganti file", "Link tidak dikenali", "File maks 2 MB", "Semua proyek".

### 3.3 Proyek (`/projects`)

Tidak ada tombol lime. Di layar sempit ada [Buat klip] `secondary`.

```
Proyek                                  [🔍 Cari]
[Proyek | Klip]
(Semua 12)(Diproses 2)(Selesai 9)(Gagal 1)
▢ ▮ Judul video   Selesai   8 klip   2 jam lalu   ⋯
```

- **Komponen:**
  - Navigasi dan saring: `Tabs`, `SearchField` (dengan `aria-label` tombol hapus), `ToggleButtonGroup`.
  - Tabel: `Table.ScrollContainer > Table.Content` (`selectionMode="multiple"`), `Table.LoadMore`.
  - Status dan aksi: `Chip`, `Dropdown` (Buka · Edit klip · Hapus).
  - Edit klip: dirender sebagai `<a href>` lewat `Dropdown.Item href`. Ini aman karena tidak ada RouterProvider, dan dikunci tes.
  - Konfirmasi dan hasil: `AlertDialog`, `toast()`.
- **Tab Klip:** grid `ClipPoster`, filter "Skor 8+" dan "Minggu ini", plus [Muat lagi].
- **State:**
  - Kosong: "Belum ada proyek" + [Buat klip].
  - Hasil saring kosong: "Tidak ditemukan".
  - Gagal: "Gagal memuat" + [Coba lagi].
- **Copy:** "Hapus 2 proyek?" [Hapus] [Batal]; toast "2 dihapus" atau "1 dihapus, 1 gagal".
- **Dihapus:** `projects/page.jsx:196, :240`, tombol Muat ulang (diganti refresh saat tab kembali fokus), dan judul ganda.

### 3.4 Detail proyek dan penampil klip (`/projects/[id]`)

**Aksi utama:** saat Selesai, [Unduh semua].

```
← Proyek
Podcast ep 12                         [Unduh semua] [⋯]
YouTube · 2 jam lalu · 8 klip · 6:40
┌ Diproses 42% ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┐
│ ✓ Unduh  ✓ Transkrip  ● Pilih momen  ○ Render        │
│ 3 klip siap                              [Batalkan]  │
└──────────────────────────────────────────────────────┘
[Terbaik | Urutan video] (Semua 8)(Di luar fokus 2)  [Pilih]
```

- **Penampil klip:** `Modal`, layar penuh di bawah 768 px, dengan `?klip=N` dan navigasi `←/→`.
  - Isi: video, "Klip 2 dari 8", judul [Salin], skor (`Meter`), Hook di video (`Switch`), Caption [Ubah] [Tulis ulang] [Salin], tag, `Disclosure` "Kenapa dipilih", rentang `12:04–12:46`, Bingkai: "Ikuti wajah", dan Postingan (YT · Terbit · 1,2 rb tayangan).
  - Footer: [Unduh MP4] (lime; pindah ke Publikasikan kalau sudah ada akun sosial), [Edit klip] sebagai `<a>`, [⋯ SRT · Hapus].
- **Komponen:**
  - Kepala: `Link` dan `Breadcrumbs`.
  - Progres: `ProgressBar` dan stepper custom (`lib/stage-summary.mjs`).
  - Grid dan saring: `Tabs`, `ToggleButtonGroup`.
  - Aksi: `Dropdown`, `AlertDialog` "Batalkan proses ini?" dengan [Lanjutkan proses] sebagai fokus default.
  - Bar pilih: [Unduh (n)] [Jadwalkan (n)].
- **State:**
  - Antre.
  - Gagal: "Proses gagal" + kode + [Bantuan] [Proses ulang].
  - Dibatalkan: [Proses ulang].
  - Selesai tanpa klip: "Tidak ada momen yang lolos" + [Proses ulang].
  - Tile gagal (`lib/clip-status.mjs`).
- **Dipertahankan:** roving tabindex, `role=status`, `aria-valuenow`, klip tampil bertahap.
- **Dihapus:** `:576`, `:308`, kalimat di `components/CancelJob.jsx:70`, dan `<details>` "Catatan pemilihan".
- **Ikut diubah:** copy dan gambar halaman depan yang menyebut "panel Hasil" (`app/page.jsx:15,146,155,162`, `public/landing/editor.webp`).

### 3.5 Drawer Publikasikan / Jadwalkan

```
Publikasikan klip 2                         ✕
Akun        [▶ YouTube · @kanal ▾]
Judul       [                    ]
Caption     [                    ]
Hashtag     [#tag ✕][#tag ✕]  [ketik + Enter]
Visibilitas (•) Publik ( ) Tidak publik ( ) Privat
Jadwalkan   (Switch)  [24/10/2026 19:00]
            Jarak antar posting [3 jam ▾]   ← hanya batch
                         [Batal] [Publikasikan | Jadwalkan]
```

- **Komponen:** `Drawer placement="right"`, `Form`, `Select`, `TextField`, `TextArea`, `TagGroup` + `TextField`, `RadioGroup`, `Switch`, `DatePicker` (`granularity="minute"`, `hourCycle={24}`, `hideTimeZone`, di-lazy-load), `Button isPending`.
- **Aturan platform:** hint satu baris, misalnya "TikTok tanpa judul".
- **Akun:**
  - Belum ada akun: "Belum ada akun sosial" + [Hubungkan akun].
  - Akun bermasalah: "· hubungkan ulang".
- **Setelah submit:** drawer tertutup, lalu `toast()` "Mengunggah ke YouTube…" → "Terbit di YouTube" [Buka], atau "Akun perlu dihubungkan ulang" [Hubungkan].

### 3.6 Sosial (`/sosial`)

**Aksi utama:** di tab Akun, [Hubungkan akun].

```
Sosial                 [Jadwal | Akun]
(Terjadwal 5)(Terbit 12)(Gagal 1)
Hari ini
 19:00 ▶ Judul klip   @kanal · 3 jam lagi   Terjadwal  ⋯
── Akun ──
 (AS) @kanal  Terhubung              [Hubungkan ulang][Putuskan]
```

- **Komponen:** `Tabs`, `ToggleButtonGroup`, daftar `Card`/`Separator`, `Chip`, `Dropdown` (aksi sesuai status), `Avatar`, `AlertDialog` ("Putuskan @kanal? 3 jadwal dibatalkan.").
- **Kembali dari OAuth** (`?hasil=`): toast "Akun terhubung", "Izin ditolak", atau "Gagal menghubungkan" [Coba lagi].
- **Kosong:** "Belum ada jadwal" + [Buka proyek].
- **Platform belum diatur:** disembunyikan. Admin melihat "Belum diatur di server".

### 3.7 Analitik (`/analitik`)

Hanya baca, dengan pemilih rentang.

```
Analitik                         [7 hari | 30 hari | 90 hari]
[Klip terbit 24][Tayangan 18,2 rb][Suka 1,1 rb][Komentar 96]
Tayangan per hari  ▁▂▃▅▃▂▆▇▅▃
Umpan balik: 24 klip
Klip teratas        Rincian [Platform ▾]
```

- **Komponen:** `Card`, `ToggleButtonGroup`, `Select`, `Table`, chart SVG sendiri (ikuti skill dataviz; ringkasan teks untuk pembaca layar), `Skeleton`, `Intl.NumberFormat("id-ID", {notation:"compact"})`.
- **State:**
  - Kosong: "Belum ada klip terbit" + [Buka Sosial].
  - Data kurang: "Data belum cukup".
  - Gagal: [Coba lagi].

### 3.8 Tren (`/trends`)

**Aksi utama:** [Tambah tren].

```
Tren       Pakai di pemilihan klip (Switch)      [Tambah tren]
12 aktif · 3 nonaktif · 2 kedaluwarsa
[Daftar | Agen]            ← Agen khusus admin
[🔍 Cari][Jenis ▾][Status ▾]
```

- **Komponen:** `Switch`, `Tabs`, `SearchField`, `Select`, `Table` atau daftar per jenis, `Modal` + `Form` (menggantikan `details.trAdd` dan form Ubah), `AlertDialog`, `toast()` "Disalin".
- **Tab Agen:** endpoint + [Salin], [Buat token]. Token baru tampil di `Modal` dengan "Hanya tampil sekali". Daftar token punya [Cabut].
- **Kosong:** "Belum ada tren" + [Tambah tren].
- **Dihapus:** `trends/page.jsx:170-173, 206-207, 219-222, 230, 296`, `TrendAgentPanel.jsx:139`, `TrendItemCard.jsx:179`. Catatan keamanan dipindah ke Bantuan.
- **e2e:** ganti `article.trItem` dan `details.trAdd` dengan role. `selectOption` (4×) diganti klik `Select` + `option`.

### 3.9 Pengaturan (`/settings`)

**Aksi utama:** [Simpan] di bar mengambang yang hanya muncul kalau ada perubahan.

```
Pengaturan
[AI | Transkripsi | Tampilan | YouTube | Akun | Sistem]
AI aktif · OpenRouter
Aktifkan AI (Switch)   Hanya model gratis (Switch)
Urutan penyedia                              [Tambah penyedia]
 1 OpenRouter  x:free  Key tersimpan  [Uji] ⋯
                    ┌ ● Belum disimpan [Batalkan] [Simpan] ┐
```

- **Satu model simpan.** `Tabs` disinkronkan dengan hash. Panel memakai `shouldForceMount` supaya perubahan tidak hilang saat pindah tab. Kalau perubahan tetap ada di tab lain, label tab diberi "●" dan bar simpan berlaku untuk semuanya. Unggahan (logo, cookies.txt) langsung tersimpan begitu dipilih, lalu menampilkan toast.
- **Komponen:** `Card` per penyedia, `Disclosure` "Lanjutan", `Switch`, `TextField type="password"`, `Select`/`ComboBox` model, `Modal` + `ListBox` preset, `Alert`, `toast()` ("Tersimpan", "Uji berhasil · 820 ms").
- **Isi tiap tab:**
  - Transkripsi: Switch "Transkrip lewat Groq" + "API key Groq".
  - Tampilan: Logo, Watermark, Switch "Pintasan satu tombol".
  - YouTube: cookies.txt + `Chip` status.
  - Akun: nama tampilan, kata sandi. ("Keluar dari semua perangkat" baru ada setelah backend punya penyimpanan sesi.)
  - Sistem: daftar versi komponen + [Salin] + tautan Lisensi.
- **Dihapus:**
  - `settings/page.jsx:505, 766, 787, 792-795, 812, 821, 825, 829, 836, 837`, dan copy kartu di `lib/*-view.mjs`.
  - Deskripsi preset di `lib/llm-presets.mjs:36-152` dipotong jadi satu label.
  - Peringatan ToS 9Router tetap, satu baris.
- **e2e:** `selectOption` di `settings-watermark.spec`. `check()`/`getByRole("checkbox")` di `settings-transcription` (5), `settings-logo` (2), dan `settings-youtube-cookies` (3) diganti ke role `switch`.

### 3.10 Admin (`/admin/pengguna`, `/admin/job`)

Terblokir oleh backend (K3). **Aksi utama:** [Tambah pengguna].

- **Komponen:** `Tabs`, `SearchField`, `Table` + `Pagination` (`aria-label` Indonesia), `Chip`, `Avatar`, `Dropdown` (Ubah peran · Atur ulang kata sandi · Nonaktifkan · Hapus), `Modal` + `Form` (Nama pengguna, Kata sandi sementara, Peran), `AlertDialog`, `ProgressBar`.
- **Login pertama dengan kata sandi sementara:** diarahkan ke `/akun/kata-sandi` ("Ganti kata sandi" → [Simpan]).
- **Non-admin:** 404.

### 3.11 Login (`/login`)

**Aksi utama:** [Masuk].

- Tetap form `method="post" action="/api/auth/login"` dengan `name="username"`, `name="password"`, dan `type="submit"` (helper `e2e/support/harness.mjs`).
- Pakai `TextField`/`Input` + `Button variant="primary"`. Pesan error di `<p role="alert">` dari `loginErrorMessage`, dipersingkat menjadi "Terlalu banyak percobaan. Coba lagi nanti." dan `entry-pages.test.mjs:85` diperbarui.
- **Dihapus:** tagline `:22`, catatan `:30`, aside poster `:36-37`.

### 3.12 Bantuan, error, lisensi, editor

- **Bantuan:** `SearchField` "Pesan error".
  - Entri error tetap berupa anchor yang selalu dirender dan tetap jalan tanpa JS (`help-page.test.mjs`).
  - Panduan memakai `Disclosure`; item yang cocok dengan hash dibuka otomatis.
  - Tabel pintasan memakai `Table`.
  - Kalimat `bantuan/page.jsx:105` dihapus.
- **`not-found`, `error`, `licenses`:** tetap di shell, ikut bergaya baru. `global-error` tetap memakai `status-page.css` + `.btn` minimal.
- **Editor:** tidak disentuh. Label "← Proyek" (`TopBar.jsx:41`) sudah cocok.

## 4. Fondasi teknis

1. **Dependensi.**
   - `dependencies`: `@heroui/react@3.2.6`, `@heroui/styles@3.2.6`, `react-aria@3.52.1`, `react-aria-components@1.21.1`, `@internationalized/date@^3.12.4`. Semua dikunci persis.
   - `devDependencies`: `tailwindcss`, `@tailwindcss/postcss`, `postcss`, plus `web/postcss.config.mjs`.
   - Tidak menambah library ikon, chart, atau TanStack.
   - Notice dan teks lisensi ditambahkan ke `app/licenses/notices.mjs` + `public/licenses/`, test-first di `tests/licenses.test.mjs`.

2. **Layer dan CSS.**
   - **`globals.css`:**
     - Baris pertama: `@layer theme, base, components, utilities;`.
     - Base elemen dan blok dasar dipindah ke `@layer base`.
     - Token `:root` dan reduced-motion tetap di luar layer.
   - **`app/ui.css`:** diimpor hanya dari `components/AppShell.jsx` dan `app/login/page.jsx`.

     ```css
     @import "tailwindcss/theme.css" layer(theme);
     @import "tailwindcss/utilities.css" layer(utilities);
     @import "tw-animate-css";
     @import "@heroui/styles/base" layer(base);
     @import "@heroui/styles/themes/default" layer(theme);
     @import "@heroui/styles/components/button.css" layer(components); /* dst. per komponen */
     @import "@heroui/styles/utilities";
     @import "@heroui/styles/variants";
     @source not "../components/editor";
     @theme { --color-*: initial; --font-sans: var(--font); }
     ```

     - Tanpa preflight Tailwind.
     - Cadangan kalau impor granular gagal: `@import "@heroui/styles"` penuh dengan regresi per layar dicatat. Preflight tetap tidak dipakai.
   - **Override** di `@layer components` dalam `ui.css`:
     - `min-height: 44px` dan `border-radius: var(--radius-m)` untuk `.button`.
     - Target 44 px untuk tab, item menu/listbox, dan close-button.
     - `.button--outline` memakai `--border-strong`.
     - Keadaan terpilih Switch/Checkbox/Radio/ToggleButton memakai `--text`/`--surface-3`, bukan lime.
   - **Spike Fase 0** mendiff CSS hasil build untuk rute editor sebelum dan sesudah (target: identik). Pipeline PostCSS bawaan Next diganti, jadi bagian ini wajib.

3. **Alias token** di `:root` `globals.css`, semua memakai `var()`. Daftarnya dicocokkan otomatis dengan `variables.css` HeroUI:

   ```css
   --background: var(--bg); --foreground: var(--text);
   --surface-foreground: var(--text);
   --surface-secondary: var(--surface-2); --surface-secondary-foreground: var(--text);
   --surface-tertiary: var(--surface-3); --surface-tertiary-foreground: var(--text);
   --surface-hover: var(--surface-3);
   --overlay: var(--surface-2); --overlay-foreground: var(--text);
   --default: var(--surface-2); --default-foreground: var(--text); --default-hover: var(--surface-3);
   --default-soft: var(--surface-2); --default-soft-foreground: var(--text); --default-soft-hover: var(--surface-3);
   --accent-foreground: var(--accent-ink);
   --accent-soft: var(--surface-3); --accent-soft-foreground: var(--text); --accent-soft-hover: var(--surface-3);
   --danger-foreground: var(--danger-ink); --danger-soft: var(--danger-bg); --danger-soft-foreground: var(--danger); --danger-soft-hover: var(--danger-bg);
   --success-foreground: var(--accent-ink); --success-soft: var(--success-bg); --success-soft-foreground: var(--success); --success-soft-hover: var(--success-bg);
   --warning-foreground: var(--accent-ink); --warning-soft: var(--warning-bg); --warning-soft-foreground: var(--warning); --warning-soft-hover: var(--warning-bg);
   --field-background: var(--surface-2); --field-foreground: var(--text); --field-placeholder: var(--text-muted);
   --field-border: var(--border-strong); --field-border-hover: var(--text-muted); --field-border-focus: var(--focus);
   --field-hover: var(--surface-3); --field-focus: var(--surface-2);
   --segment: var(--surface-3); --segment-foreground: var(--text);
   --separator: var(--border); --separator-secondary: var(--border); --separator-tertiary: var(--border);
   --border-secondary: var(--border); --border-tertiary: var(--border);
   --background-secondary: var(--surface); --background-tertiary: var(--surface-2); --background-inverse: var(--text);
   --backdrop: var(--shadow); --link: var(--info);
   --scrollbar: var(--border-strong);
   --radius: var(--radius-m); --field-radius: var(--radius-s);
   ```

   - Variabel bayangan (`--surface-shadow`, `--overlay-shadow`, `--field-shadow`) dibuat `none` atau dari `--shadow`. Nilai persisnya ditetapkan di spike.
   - `--muted` (alias lama ke `--text-muted`) artinya sama di kedua sistem dan sudah dikunci `app-shell.test.mjs:206`.
   - Pasangan kontras baru dicatat di TOKENS.md (`--warning-foreground`/`--success-foreground` di atas latarnya) dan dicek ulang dengan `contrast-check.py`.
   - `rounded-xl` = 20 px dan `ease-out` mengikuti Potongin; keduanya dicatat.

4. **Kelas global.**
   - `.card` digabung ke `.panel`.
   - `.chip` → `.statusPill` (atau langsung ganti ke `Chip`). **Bukan** `.badge`.
   - `.table`/`.tableWrap` dihapus karena tidak dipakai.
   - `.btn`, `.notice`, `.segmented` dihapus per layar; `.btn` minimal dipertahankan untuk `global-error`.

5. **Tema:** `<html lang="id" className={dmSans.variable} data-theme="dark">`. Regex di `app-shell.test.mjs:252` diperbarui.

6. **Font:** `--font-sans: var(--font)` lewat `@theme`, dari `next/font` (same-origin, aman untuk COEP).

7. **Gerak:** durasi `--dur-*` jadi 0 saat reduced motion; `motion-reduce:` HeroUI ikut berlaku; `--skeleton-animation: pulse`.

8. **Provider:** `components/ui/Providers.jsx` (`"use client"`) berisi `I18nProvider locale="id-ID"` dan `<Toast.Provider placement="bottom end" />`. **Tanpa RouterProvider.** Dipasang di AppShell dan login.

9. **Label a11y bawaan:** `aria-label` Indonesia ditulis eksplisit untuk tombol hapus SearchField, tutup Modal/Drawer/Toast, select-all di Table, hapus Tag, Pagination, dan segmen DatePicker. Spike memverifikasi apakah React Aria punya terjemahan `id`.

10. **Ikon:** `AppIcon` + `lib/app-icons.mjs`, ditambah sosial, analitik, admin, kalender, pengguna, dan glyph platform sederhana tanpa warna merek.

11. **JS, bukan TS.** Kalau perlu, pakai `// @ts-check` + JSDoc.

12. **Aturan penulisan:**
    - Utility Tailwind hanya untuk tata letak.
    - Warna hanya lewat kelas semantik atau token.
    - Guard menolak `-[#` dan nama palet Tailwind di `className`.
    - `<Button` wajib menulis `variant`; paling banyak satu `primary` per halaman.
    - CSS Modules untuk poster, stepper, dan chart.
    - Logika `lib/*-view.mjs` tetap; copy di dalamnya boleh berubah bersama tesnya.

13. **`tests/ui-foundation.test.mjs`** (baru):
    - `globals.css` tidak mengimpor tailwind/heroui, dan tokennya tetap di luar layer.
    - `components/editor/**`, rute edit, dan `app/parity-harness/**` tidak mengimpor `ui.css` atau `@heroui/*`.
    - Tidak ada `RouterProvider`.
    - Setiap `editorHref` dirender sebagai `<a>`.
    - Setiap variabel di `variables.css` HeroUI punya alias.
    - Override 44 px dan radius ada di `ui.css`.

14. **forced-colors:** blok `@media (forced-colors: active)` di `ui.css` untuk fokus, Chip, ProgressBar, Switch, dan tombol terpilih.

## 5. Migrasi bertahap

**Aturan untuk semua fase:**

- Satu PR per fase, di-rebase.
- Tes diperbarui dulu. Asersi regex atas source diganti asersi setara di view module atau e2e role, tidak dihapus.
- Run CI wajib: `gh workflow run editor-gates.yml -f suite=full` plus `suite=e2e` dan `suite=player`, termasuk `editor-*` dan `parity-text`, dengan screenshot editor tanpa diff.
- Umumkan `antislop active: during (project setting).` sebelum edit pertama.

| Fase | Isi | Kriteria terima | Tes | Estimasi |
|---|---|---|---|---|
| G0 | PR redesign merge, persetujuan amandemen DESIGN.md, kontrak API | Disetujui owner | — | — |
| 0 Fondasi + spike | Paket, PostCSS, layering `globals.css`, `ui.css`, alias penuh, override komponen, lisensi, Providers, `data-theme`, status-words, DESIGN.md/TOKENS.md | `next build` hijau; halaman uji (Button, Modal, Table, DatePicker, Switch) sesuai palet, 44 px, tanpa lime selain primary; CSS editor identik; editor + parity hijau; baseline ukuran bundle | `app-shell`, `ui-guards`, `licenses`, `entry-pages`, baru `ui-foundation` | 7–9 hari |
| 1 Shell | NavList datar, Drawer, menu akun, logout `requestSubmit`, pintasan + switch | Fokus kembali ke Menu, latar inert, `aria-current`, 44 px, kelas badge tetap | `app-shell`, `help-page`, `help-guide`, `job-badge`; e2e `app-shell` (+ proyek mobile), `header-badge`, `smoke`, `read-only` | 3–4 hari |
| 2 Buat klip | Composer, chip/popover, Terbaru, redirect | Enter → `/projects/[id]`; fokus ke field salah dengan popover terbuka; tanpa paragraf | `dashboard-view`, `dashboard-choices`, `clip-limits`, `subtitle-upload`, `time-ranges`, `selection-v3`, `source-language`, `look-preview`, `layout-names`, `storage-status-ui`, `focus`; e2e `dashboard` (field popover), `focus`, `read-only` | 6–7 hari |
| 3 Detail + penampil | Stepper, grid, Modal `?klip=N`, bar pilih, copy halaman depan | Klip bertahap; `←/→`; Edit klip `<a>` dan editor ber-COEP | `project-view`, `project-workspace`, `stage-summary`, `job-cancel-view`, `clip-failures`, `clip-text`, `clip-hook`, `jobs`, `entry-pages`; e2e `project-workspace`, `cancel-job`, `clip-text`, `clip-hook`, `editor-flow`, `editor-clip-nav` | 6–7 hari |
| 4 Daftar proyek | Table, filter, batch hapus, tab Klip | AlertDialog + toast sebagian; hitungan filter | `clip-library-view`, `clip-library`, `job-deletion`; e2e `history-clips`, `smoke` | 3–4 hari |
| 5 Pengaturan | Tabs hash, force-mount, satu bar simpan | Hash lama membuka tab yang benar; perubahan tidak hilang saat pindah tab | `settings-trends-ui`, `system-info`, `transcription-settings`, `default-logo`, `default-watermark`, `youtube-cookies`, `llm-settings`, `llm-settings-view`, `llm-settings-routes`; e2e `settings-*` (switch, Select) | 6–7 hari |
| 6 Tren | Switch kepala, Modal, tab Agen | Token tampil sekali; selector berbasis role | `trend-view`, `settings-trends-ui`; e2e `trends` (sekitar 108 selector) | 3–4 hari |
| 7 Login + Admin + ganti kata sandi | Setelah backend multi-user | Non-admin dapat 404; tambah, ubah peran, nonaktifkan; login pertama wajib ganti kata sandi | `entry-pages`, `login-rate-limit`, `proxy-matcher`; e2e baru `admin` | 4–5 hari (terblokir) |
| 8 Sosial + publikasi | `/sosial`, OAuth `?hasil=`, Drawer, batch, Postingan | Dikelompokkan per hari; toast progres; DatePicker tanpa hydration mismatch | Unit view baru; e2e `social`, `publish` | 6–7 hari (terblokir) |
| 9 Analitik | Tile, chart SVG, tabel | id-ID; ringkasan teks chart; state kosong | Unit view baru; e2e `analytics` | 3–4 hari (terblokir) |
| 10 Bantuan, error, bersih-bersih | Bantuan (anchor tetap), error/404/lisensi, hapus CSS mati | Tanpa CSS mati; `global-error` tetap bergaya; teks pengisi hilang | `help-page`, `help-catalog`, `ui-guards`; e2e `bantuan` | 3 hari |
| **Total** | | | | **sekitar 52–66 hari kerja** (Fase 7–9 menunggu backend) |

Editor dikerjakan sesudah Fase 10.

**Amandemen DESIGN.md** (G0b):

- Kepala halaman: judul + aksi, tanpa kalimat.
- Sidebar datar dengan item per peran/flag.
- Opsi Buat klip berupa chip bernilai, menggantikan tiga lipatan.
- HeroUI v3 dipakai di atas token Potongin.
- Dua set kata status.
- Keadaan terpilih tidak memakai lime.

**Clean-room:** tim hanya memakai catatan IA tertulis dari SupoClip (alur, kepadatan, nada). Tidak ada kode, markup, style, atau string yang disalin, dan tangkapan layar SupoClip tidak ditempel di desain. Setiap PR mencatat sumber rujukannya.

## 6. Risiko dan mitigasi

| Risiko | Mitigasi |
|---|---|
| Base `globals.css` di luar layer menimpa HeroUI, atau layering mengubah editor | Layering di Fase 0 + e2e editor + parity + screenshot tanpa diff |
| Navigasi klien ke editor (tanpa COEP) | Tanpa RouterProvider; tes `ui-foundation` |
| Warna HeroUI di luar token atau lime bocor | Alias penuh + tes daftar variabel; override keadaan terpilih; guard `className` |
| Tepi kontrol di bawah 3:1 | `--border-strong` untuk outline/field; guard kontras |
| Target di bawah 44 px | Override CSS global + tes |
| Label bawaan berbahasa Inggris | `aria-label` eksplisit + e2e pindai nama aksesibel |
| Bundle membengkak | CSS per komponen, DatePicker lazy, diukur per rute di CI terhadap baseline Fase 0 |
| Sekitar 600 selector e2e (`selectOption`, checkbox→switch, field di popover) | Migrasi per layar, tes lebih dulu, diganti dengan role |
| Backend multi-user/sosial/analitik belum ada | Flag + `page.route` e2e; Fase 7–9 terblokir secara eksplisit |
| Hydration tanggal/angka | Locale sama di server dan klien; waktu relatif dirender di klien |
| Kembali ke teks pengisi | Checklist antislop-copywriting; guard menolak `<p>` di kepala halaman |
| Lisensi tidak lengkap | `licenses.test.mjs` diperluas di Fase 0 |

## 7. Pertanyaan untuk owner

1. Rantai AI, key Groq, dan cookies YouTube: global (diatur admin) atau per pengguna?
2. Akun dibuat admin saja, atau ada daftar mandiri dan lupa kata sandi?
3. Platform publikasi pertama: YouTube, TikTok, atau Instagram? Jadwal batch perlu sejak awal?
4. Tren dan token Hermes: dipakai bersama atau per pengguna?
5. Setuju detail klip berubah dari panel samping menjadi dialog (`?klip=N`), serta label "Riwayat"→"Proyek" dan "Konteks Tren"→"Tren"?
6. Setuju status "Menunggu" diganti "Antre", dan pintasan satu tombol bisa dimatikan di Pengaturan?