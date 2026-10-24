# 05 — UI dashboard (HeroUI v3)

- **Status:** Rancangan — belum diimplementasi
- **Tanggal:** 2026-10-24
- **Dokumen terkait:** [00-README.md](00-README.md) (indeks dan urutan baca) · `01-*.md` s.d. `07-*.md` (daftar lengkap di 00-README.md) · [08-fase-test-deploy.md](08-fase-test-deploy.md)
- **Sumber:** roadmap induk (bagian "Koreksi akhir" KA1–KA26 menang), rencana dashboard 02 (K1–K31), rencana i18n 04 (K1–K23), rencana editor 03, dan roadmap fitur 01 + review.
- **Path** ditulis relatif terhadap root repo ``. File baru ditandai **(baru)**. Semua path lama yang disebut sudah dicek ada di repo per 2026-10-24.

Dokumen ini mencakup semua layar di luar editor: shell, login, Buat klip, Proyek, Detail proyek + penampil klip, drawer Terbitkan/Jadwalkan, Sosial, Analitik, Tren, Pengaturan, Akun, Admin, serta Bantuan/error. Editor (`/projects/[id]/clips/[clipId]/edit`) dibahas di dokumen editor. Di sini editor hanya muncul sebagai tujuan tautan `<a>`.

---

## 0. Keputusan yang dipakai dokumen ini

| # | Keputusan | Status | Dampak ke UI dashboard |
|---|---|---|---|
| Q1 | Amandemen DESIGN.md/AGENTS.md; label "Riwayat"→"Proyek", "Konteks Tren"→"Tren", "Menunggu"→"Antre"; detail klip jadi dialog `?klip=N`; istilah **Terbitkan / Terbit** | **Final** | §2, §5, §6 |
| Q1-editor | Mode Cepat/Lengkap dihapus. Artinya **bukan** semua alat tampil sekaligus: satu layout, pratinjau di depan, **satu panel kanan terbuka** (tab Teks · Tata letak · Audio · Logo · Cold open), pilihan dasar terlihat, kontrol halus di disclosure **Lanjutan** yang tertutup dengan ringkasan di judulnya, tugas umum ≤ 3 klik | **Final** | Pola "Lanjutan" yang sama dipakai di dashboard (P7) |
| Q2 | Node 24 + `node:sqlite`; `@heroui/react@3.2.6` + Tailwind v4; `use-intl`; `@babel/parser` (dev) | **Final** | §3.1 |
| Q3 | Admin tidak membuka proyek orang lain; akun lewat undangan saja; `APP_*` = break-glass; user smoke; tautan undangan disalin manual (tanpa SMTP) | (default, bisa diubah) | §6.11, §6.12 |
| Q4 | Rantai AI instans, Groq instans, cookies YouTube diatur admin; anggota boleh punya rantai AI/key Groq **pribadi** bila `member_llm_keys_allowed` (dok 02 §2.1, §3.3, §9.1); berbagi AI dengan cap 200/hari; tren instans + switch per anggota | (default, bisa diubah) | Tab Pengaturan per peran (§4.4, §6.10), "AI belum diatur" (§6.3) |
| Q5 | Concurrency 1; 30 job/jam; durasi maks 4 jam; kuota storage ditetapkan setelah jumlah pengguna diketahui | (default, bisa diubah) | Posisi antrean (§6.4), pesan kuota 507 |
| Q7 | Platform pertama YouTube; mode `admin` sampai audit; batch jadwal belakangan; cap 100 terjadwal / 20 per jam per user; kuota YouTube = jatah harian per user; hapus job membatalkan jadwal; file default = ekspor terbaru yang selesai | (default, bisa diubah) | §6.5, §6.6 (pesan `errors.social.social_cap_*`, `social_quota_exhausted`) |
| Q8 | Format 24 jam di semua locale; zona = zona perangkat, nama zona pendek ditampilkan | (default, bisa diubah) | DatePicker (§6.5) |
| Q9 | ID dan EN **wajib ada di akhir**. EN dirilis bersama fase editor (opsi b, Fase 11). Pratinjau `id,en` hanya sebelum ada anggota. Draf copy EN ditulis implementer dari `web/messages/id/*.json` + glosarium (dok 07 §2.2), direview pemilik per fase. Pengguna baru: Accept-Language. Undangan memakai bahasa pilihan admin | **Final** (waktu), sisanya (default, bisa diubah) | Semua layar lahir dengan kunci id+en (§6) |
| Q10 | Otomatis opt-in sampai PF-PIPELINE lolos | (default, bisa diubah) | Pilihan "Otomatis" di chip Tata letak sejak Fase 7, bukan default |
| Q11 | Data performa privat per user; toggle "Pakai di pemilihan klip" default mati | (default, bisa diubah) | §6.7 |
| Q6, Q12 | Paket penghapusan otomatis; batas gabung editor | (default, bisa diubah) | Tidak berdampak ke dashboard |

**Clean-room (D1):** implementer boleh membaca SupoClip untuk memahami alur (09 §1) tetapi tidak menyalin kode, markup, struktur komponen, string, atau tangkapan layar. Rujukan: catatan IA di rencana dan 09. Setiap PR UI mencatat "rujukan: catatan IA + kode Potongin; sumber copy en: messages/id + glosarium" (format sama dengan dok 07 D1).

**Aturan kontrak:** tabel API di §6.5–§6.7 dan §6.11–§6.12 adalah **salinan ringkas** untuk UI; pemiliknya [02-multiuser-keamanan.md](02-multiuser-keamanan.md) §6/§8.2 (identitas, admin), [03-sosmed-performa.md](03-sosmed-performa.md) §9 (sosmed, analitik, performa), [04-reframe-unduhan.md](04-reframe-unduhan.md) §B14 (unduhan), dan [07-i18n.md](07-i18n.md) §9.2/§13.2 (`/api/locale`, zona). Kalau berbeda, dokumen pemilik menang dan tabel di sini yang diperbaiki. Pemetaan kode error → teks milik dok 07 §10. Skema DB (kolom `users.*`, `invites.*`, dll.) milik dok 01 §4; dokumen ini tidak memuat DDL.

---

## 1. Lingkup dan fase

Fase, milestone, dan estimasi hari-dev milik [08-fase-test-deploy.md](08-fase-test-deploy.md) §4–§5; kolom Hari hanya kutipan.

| Layar | Fase induk | Milestone | Hari (dok 08) | Terblokir oleh |
|---|---|---|---|---|
| Fondasi UI (§3) | 1 | Dashboard F0 + i18n M0 | 7–9 | Fase 0 (Node 24) |
| Shell + menu akun + pemilih bahasa (§6.1) | 1 | F1 + i18n M1 | 3–4 | F0 |
| Login (§6.2) | 1 | i18n M1 | (di M1) | F0 |
| Buat klip (§6.3) | 2 | F2 | 6–7 | — |
| Detail proyek + penampil (§6.4) | 2 | F3 | 6–7 | i18n M5 (kode tahap) sebelum F3 (dok 07 §15) |
| Proyek (§6.8) | 3 | F4 | 3–4 | — |
| Pengaturan (§6.10) | 3 | F5 | 6–7 | — |
| Tren (§6.9) | 3 | F6 | 3–4 | — |
| Bantuan, error, lisensi (§6.13) | 3 | F10 + i18n M4 | 3 | — |
| Akun, Admin, undangan, reset (§6.11, §6.12) | 6 | MU-M5 + F7 | ≈ 7–8 | DB/sesi (Fase 4), ownership (Fase 5), MU-M4b (gerbang undangan) |
| Sosial + drawer Terbitkan (§6.5, §6.6) | 8 | SOS-M4 + F8 | 8–9 | SOS-M3a (dok 03 §17) |
| Analitik (§6.7) | 9 | FB-M5 + F9 | 5–6 | FB-M4 (dok 03 §17) |

---

## 2. Prinsip desain

| # | Prinsip | Aturan yang bisa dites |
|---|---|---|
| P1 | Satu aksi utama per permukaan | Paling banyak satu `variant="primary"` (lime) per file halaman, dan satu per overlay (Modal/Drawer punya file komponen sendiri). Setiap `<Button` wajib menulis `variant`. Nilai yang ada di HeroUI: `primary`, `secondary`, `tertiary`, `outline`, `ghost`, `danger`, `danger-soft`. Yang **boleh** dipakai: `primary`, `secondary`, `tertiary`, `ghost`, `danger`; `outline` dan `danger-soft` ditolak guard (tepi 1,31:1 / warna merah lembut tanpa pasangan kontras). Dicek `ui-guards`. |
| P2 | Label, bukan kalimat | Kepala halaman = `<h1>` + aksi. Tidak ada `<p>` di `PageHead`. Hint ≤ 6 kata, hanya kalau mencegah salah input. Error = masalah + perbaikan. Berlaku di **semua** locale. Guard menolak `<p>` di dalam `PageHead`. |
| P3 | Default tampil sebagai chip bernilai | `3 klip`, `9:16 · 720p`, `Latar blur`, `Karaoke`. Chip membuka `Popover` berisi kontrol. |
| P4 | Hasil muncul di tempat kerja | Setelah Buat klip → redirect ke `/projects/[id]`. Aside "Hasil" di `/dashboard` dihapus. |
| P5 | Dua set kata status tetap | Proses: Antre · Diproses · Selesai · Gagal · Dibatalkan. Postingan: Terjadwal · Mengunggah · Terbit · Gagal · Dibatalkan. Sumber: namespace `status` (§5). |
| P6 | Sembunyikan, jangan matikan | Status AI, penyimpanan, cookies hanya tampil kalau bermasalah. Fitur dengan flag mati tidak dirender (bukan disabled). Menu per peran tidak dirender untuk peran lain. |
| P7 | Dasar dulu, detail di "Lanjutan" | Pilihan yang sering dipakai selalu terlihat. Kontrol halus di `Disclosure` "Lanjutan" yang **tertutup** secara default, dengan ringkasan nilai di judulnya (`Lanjutan · Model gratis · 2 penyedia`). Satu overlay/panel terbuka pada satu waktu. Tugas umum ≤ 3 klik dari halaman yang relevan (tabel §7.3). |
| P8 | State seragam | Memuat = `Skeleton` sesuai bentuk isi. Kosong = judul + 1 tombol. Hasil saring kosong = "Tidak ditemukan". Gagal memuat = pesan + [Coba lagi]. Hasil aksi = `toast()`. Komponen: `EmptyState`, `LoadError` (baru). |
| P9 | Terpilih tidak pernah lime | Keadaan terpilih memakai `--text` + `--surface-3`. Tepi kontrol memakai `--border-strong` (≥ 3:1). Lime hanya untuk aksi utama dan titik progres. |
| P10 | A11y tidak turun | Target 44 px lewat CSS, cincin `--focus`, skip link, live region, reduced motion, forced-colors, label aksesibel dari katalog, pintasan satu tombol bisa dimatikan sejak hari pertama. |
| P11 | Tanpa label versi | Tidak ada "V3", "Selection V3", "Latest only", "baru", `engine_fallback`. Dicek `ui-guards`. |
| P12 | Navigasi dokumen penuh | Tanpa `RouterProvider`. Setiap tautan ke editor adalah `<a href>` biasa supaya header COOP/COEP dimuat. |

---

## 3. Fondasi UI

### 3.1 Dependensi (`web/package.json`)

Semua dipin persis (tanpa `^`), kecuali yang ditulis lain.

| Paket | Versi | Jenis | Lisensi |
|---|---|---|---|
| `@heroui/react` | 3.2.6 | dependencies | MIT |
| `@heroui/styles` | 3.2.6 | dependencies | MIT |
| `react-aria` | 3.52.1 | dependencies (peer HeroUI) | Apache-2.0 |
| `react-aria-components` | 1.21.1 | dependencies (peer HeroUI) | Apache-2.0 |
| `@internationalized/date` | 3.12.4 | dependencies | Apache-2.0 |
| `use-intl` | 4.14.9 | dependencies | MIT |
| `tailwindcss` | versi 4.x terbaru saat PR, dipin | devDependencies | MIT |
| `@tailwindcss/postcss` | sama dengan `tailwindcss` | devDependencies | MIT |
| `postcss` | dipin | devDependencies | MIT |
| `tw-animate-css` | dipin | dependencies (CSS dikirim) | MIT |
| `@babel/parser` | dipin | devDependencies (tes `i18n-hardcoded`) | MIT |

Transitif yang wajib dicantumkan di `/licenses`: `tailwind-variants`, `intl-messageformat`, `@formatjs/*`, `icu-minify`, `@schummar/icu-type-parser`. Tidak ada library ikon, chart, tabel, atau TanStack baru. Tidak ada `next-intl`.

File:
- `web/postcss.config.mjs` **(baru)**: `export default { plugins: { "@tailwindcss/postcss": {} } };`
- `web/app/licenses/notices.mjs` dan `web/public/licenses/` diperbarui. `web/tests/licenses.test.mjs` diubah **lebih dulu** (test-first).

### 3.2 Migrasi `@layer` di `web/app/globals.css`

Masalahnya: semua CSS HeroUI berada di `@layer`. CSS Potongin yang tidak berada di layer selalu menang, apa pun spesifisitasnya. Akibatnya field HeroUI ikut mendapat border/latar Potongin dan cincin fokusnya jadi dobel.

Langkah, urut:

1. Baris pertama file: `@layer theme, base, components, utilities;`
2. **Tetap di luar layer:**
   - blok `:root { … }` (token, baris 3–63 sekarang) beserta alias HeroUI baru (§3.4);
   - blok `@media (prefers-reduced-motion: reduce)` (baris 65).

   Alasannya, `web/tests/app-shell.test.mjs` dan `rootColourTokens` di `web/tests/support/ui-guards.mjs` membaca `:root` yang tidak berada di layer.
3. **Pindah ke `@layer base { … }`:**
   - reset dan elemen: `*`, `html`, `body`, `::selection`, `:where(a)`, `:where(button, input, select, textarea)`, `:where(img, video)`, `:focus-visible`, aturan field `:where(input…)`, placeholder, `accent-color`;
   - `@keyframes` tetap di tingkat atas (keyframes tidak terpengaruh layer);
   - blok dasar `.btn*`, `.panel`, `.card`, `.chip*`, `.notice*`, `.segmented*`, `.eyebrow`, `.visuallyHidden`, `.shell`, `.brand*`, `.skipLink*`, kelas shell `.app*`, `.jobBadge*`, `footer`, `.pageHead*`, `.compact`, `.message`, `.progress*`, `.pulse`, serta semua media query responsif shell.
4. CSS Modules editor (`components/editor/**/*.module.css`) **tidak disentuh**. CSS yang tidak berada di layer tetap menang atas layer, jadi editor tidak berubah. Ini dibuktikan oleh diff CSS hasil build (§8.1).
5. `.table`/`.tableWrap` dihapus (0 pemakaian di JSX). `.card` digabung ke `.panel`. `.chip` → `.statusPill` (bukan `.badge`, karena bentrok dengan BEM `Badge` HeroUI). `.btn` dipertahankan minimal di `@layer base` untuk `app/global-error.jsx` (yang punya `<html>` sendiri tanpa `ui.css`) dan dihapus dari layar lain per fase.

### 3.3 `web/app/ui.css` (baru)

Diimpor **hanya** dari `web/components/AppShell.jsx` dan `web/components/ui/PublicCard.jsx` **(baru)**: kerangka kartu tunggal tanpa shell untuk `/login` (Fase 1), `/undangan/[token]` dan `/atur-ulang-sandi/[token]` (Fase 6). Halaman itu mengimpor `PublicCard`, bukan `ui.css` langsung. Tidak boleh diimpor dari `globals.css`, `components/editor/**`, rute edit, atau `app/parity-harness/**` sampai amandemen X10 di Fase 10.

```css
/* Tailwind tanpa preflight: base Potongin (globals.css @layer base) tetap jadi reset. */
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities);
@import "tw-animate-css";
@import "@heroui/styles/base" layer(base);
@import "@heroui/styles/themes/default" layer(theme);
/* Per komponen, hanya yang dipakai. Daftar dijaga ui-foundation.test (impor = pemakaian). */
/* Aksi dan navigasi */
@import "@heroui/styles/components/button.css" layer(components);
@import "@heroui/styles/components/close-button.css" layer(components);
@import "@heroui/styles/components/link.css" layer(components);
@import "@heroui/styles/components/toggle-button.css" layer(components);
@import "@heroui/styles/components/toggle-button-group.css" layer(components);
@import "@heroui/styles/components/tabs.css" layer(components);
@import "@heroui/styles/components/pagination.css" layer(components);
/* Overlay; Dropdown = Popover + Menu, jadi menu/menu-item/menu-section ikut */
@import "@heroui/styles/components/popover.css" layer(components);
@import "@heroui/styles/components/dropdown.css" layer(components);
@import "@heroui/styles/components/menu.css" layer(components);
@import "@heroui/styles/components/menu-item.css" layer(components);
@import "@heroui/styles/components/menu-section.css" layer(components);
@import "@heroui/styles/components/drawer.css" layer(components);
@import "@heroui/styles/components/modal.css" layer(components);
@import "@heroui/styles/components/alert-dialog.css" layer(components);
@import "@heroui/styles/components/toast.css" layer(components);
/* Field; TextField/Select/ComboBox merakit label, input, description, field-error */
@import "@heroui/styles/components/label.css" layer(components);
@import "@heroui/styles/components/description.css" layer(components);
@import "@heroui/styles/components/field-error.css" layer(components);
@import "@heroui/styles/components/input.css" layer(components);
@import "@heroui/styles/components/textfield.css" layer(components);
@import "@heroui/styles/components/textarea.css" layer(components);
@import "@heroui/styles/components/search-field.css" layer(components);
@import "@heroui/styles/components/number-field.css" layer(components);
@import "@heroui/styles/components/select.css" layer(components);
@import "@heroui/styles/components/combo-box.css" layer(components);
@import "@heroui/styles/components/list-box.css" layer(components);
@import "@heroui/styles/components/list-box-item.css" layer(components);
@import "@heroui/styles/components/list-box-section.css" layer(components);
@import "@heroui/styles/components/switch.css" layer(components);
@import "@heroui/styles/components/checkbox.css" layer(components);
@import "@heroui/styles/components/checkbox-group.css" layer(components);
@import "@heroui/styles/components/radio.css" layer(components);
@import "@heroui/styles/components/radio-group.css" layer(components);
/* Tampilan data */
@import "@heroui/styles/components/table.css" layer(components);
@import "@heroui/styles/components/chip.css" layer(components);
@import "@heroui/styles/components/tag.css" layer(components);
@import "@heroui/styles/components/tag-group.css" layer(components);
@import "@heroui/styles/components/avatar.css" layer(components);
@import "@heroui/styles/components/card.css" layer(components);
@import "@heroui/styles/components/progress-bar.css" layer(components);
@import "@heroui/styles/components/meter.css" layer(components);
@import "@heroui/styles/components/skeleton.css" layer(components);
@import "@heroui/styles/components/empty-state.css" layer(components);
@import "@heroui/styles/components/alert.css" layer(components);
@import "@heroui/styles/components/disclosure.css" layer(components);
@import "@heroui/styles/components/separator.css" layer(components);
@import "@heroui/styles/components/kbd.css" layer(components);
/* DatePicker (Fase 8) tidak diimpor di sini: date-picker.css, date-field.css,
   date-input-group.css, calendar.css ada di web/components/ui/date-picker.css (baru),
   diimpor hanya oleh DatePicker.jsx yang di-lazy-load. */
@import "@heroui/styles/utilities";
@import "@heroui/styles/variants";

@source not "../components/editor";
@source not "./parity-harness";

@theme {
  --color-*: initial;          /* palet bawaan Tailwind dimatikan: bg-red-500 tidak ada */
  --font-sans: var(--font);
}

@layer components { /* override §3.5 */ }
@media (forced-colors: active) { /* §3.5 */ }
```

**Aturan:**
- Nama file di atas sudah dicocokkan dengan `@heroui/styles@3.1.0/dist/components/*.css` (pola `exports` `"./components/*.css"`); catatan: `textfield.css` (bukan `text-field.css`), dan Dropdown/ListBox/TagGroup/RadioGroup tidak membawa CSS anak (`menu-item`, `list-box-item`, `tag`, `radio`) sehingga diimpor terpisah. Spike F0 mengulang pencocokan terhadap 3.2.6: tes `ui-foundation` me-resolve setiap `@import` di `ui.css` ke file nyata di `node_modules` dan gagal kalau ada yang hilang.
- **Cadangan** kalau impor granular gagal di build: `@import "@heroui/styles" layer(components);` penuh, dengan regresi per layar dicatat di PR. Preflight tetap tidak dipakai.
- `DatePicker` (CSS dan JS) di-lazy-load lewat `next/dynamic` hanya di `PublishDrawer`; CSS-nya di `web/components/ui/date-picker.css` **(baru)** dengan impor `layer(components)` yang sama.
- Komponen yang **bukan** HeroUI dan diimpor langsung dari `react-aria-components`: `GridList`/`GridListItem` (mode pilih kartu) dan `FileTrigger` (impor CSV, cookies.txt, logo). Gayanya di CSS Module halaman, labelnya dari `aria.*`.

### 3.4 Alias token: semua variabel HeroUI → token Potongin

Alias ditaruh di `:root` `globals.css` (di luar layer). Karena itu alias selalu menang atas `[data-theme="dark"]` HeroUI yang berada di `@layer base`. Semua nilai warna memakai `var()` ke token Potongin, tanpa literal baru.

Daftar ini mencakup **seluruh 89 variabel** di `@heroui/styles@3.2.6/dist/themes/default/variables.css` (87 nama di 3.1.0 sudah dicocokkan satu per satu; `--tooltip-delay` dan `--tooltip-close-delay` adalah tambahan 3.2.x). Catatan lapisan: `themes/default/index.css` mengimpor `variables.css` dengan `layer(theme)` dan di dalamnya `@layer base` dengan selector `:root, [data-theme="light"], …` serta blok dark. Alias Potongin di `:root` tanpa layer tetap menang atas keduanya.

| Variabel HeroUI | Nilai di Potongin | Catatan |
|---|---|---|
| `--background` | `var(--bg)` | |
| `--background-secondary` | `var(--surface)` | |
| `--background-tertiary` | `var(--surface-2)` | |
| `--background-inverse` | `var(--text)` | |
| `--foreground` | `var(--text)` | |
| `--muted` | `var(--text-muted)` | sudah ada (alias lama), arti sama; dikunci `app-shell.test.mjs` |
| `--surface` | sudah ada `#11120f` | nama sama, arti sama |
| `--surface-foreground` | `var(--text)` | |
| `--surface-hover` | `var(--surface-3)` | |
| `--surface-secondary` | `var(--surface-2)` | |
| `--surface-secondary-foreground` | `var(--text)` | |
| `--surface-tertiary` | `var(--surface-3)` | |
| `--surface-tertiary-foreground` | `var(--text)` | |
| `--surface-shadow` | `none` | permukaan datar (DESIGN.md) |
| `--overlay` | `var(--surface-2)` | Popover, Modal, menu |
| `--overlay-foreground` | `var(--text)` | |
| `--overlay-shadow` | `0 16px 48px var(--shadow)` | satu-satunya bayangan; nilai final dipilih di spike |
| `--backdrop` | `var(--shadow)` | |
| `--default` | `var(--surface-2)` | Button `secondary`/`tertiary` |
| `--default-foreground` | `var(--text)` | |
| `--default-hover` | `var(--surface-3)` | |
| `--default-soft` | `var(--surface-2)` | |
| `--default-soft-foreground` | `var(--text)` | |
| `--default-soft-hover` | `var(--surface-3)` | |
| `--accent` | sudah ada (lime) | hanya `primary` |
| `--accent-foreground` | `var(--accent-ink)` | |
| `--accent-hover` | sudah ada | |
| `--accent-soft` | `var(--surface-3)` | dinetralkan (P9) |
| `--accent-soft-foreground` | `var(--text)` | |
| `--accent-soft-hover` | `var(--surface-3)` | |
| `--danger` | sudah ada | |
| `--danger-foreground` | `var(--danger-ink)` | |
| `--danger-hover` | `var(--danger)` | tanpa warna baru |
| `--danger-soft` | `var(--danger-bg)` | |
| `--danger-soft-foreground` | `var(--danger)` | |
| `--danger-soft-hover` | `var(--danger-bg)` | |
| `--success` | sudah ada | |
| `--success-foreground` | `var(--accent-ink)` | pasangan kontras baru → TOKENS.md |
| `--success-hover` | `var(--success)` | |
| `--success-soft` | `var(--success-bg)` | |
| `--success-soft-foreground` | `var(--success)` | |
| `--success-soft-hover` | `var(--success-bg)` | |
| `--warning` | sudah ada | |
| `--warning-foreground` | `var(--accent-ink)` | pasangan kontras baru → TOKENS.md |
| `--warning-hover` | `var(--warning)` | |
| `--warning-soft` | `var(--warning-bg)` | |
| `--warning-soft-foreground` | `var(--warning)` | |
| `--warning-soft-hover` | `var(--warning-bg)` | |
| `--border` | sudah ada `#292b25` | **hanya hiasan** (1,31:1); tepi kontrol tidak boleh memakai ini (§3.5) |
| `--border-secondary` | `var(--border)` | |
| `--border-tertiary` | `var(--border)` | |
| `--border-width` | `1px` | |
| `--separator` | `var(--border)` | |
| `--separator-secondary` | `var(--border)` | |
| `--separator-tertiary` | `var(--border)` | |
| `--focus` | sudah ada `#8b9dff` | |
| `--ring-offset-width` | `2px` | sama dengan `outline-offset` Potongin |
| `--link` | `var(--info)` | |
| `--field-background` | `var(--surface-2)` | |
| `--field-foreground` | `var(--text)` | |
| `--field-placeholder` | `var(--text-muted)` | |
| `--field-border` | `var(--border-strong)` | ≥ 3:1 |
| `--field-border-hover` | `var(--text-muted)` | |
| `--field-border-focus` | `var(--focus)` | |
| `--field-border-width` | `1px` | HeroUI default 0 → tepi wajib terlihat |
| `--field-hover` | `var(--surface-3)` | |
| `--field-focus` | `var(--surface-2)` | |
| `--field-radius` | `var(--radius-s)` | |
| `--field-shadow` | `none` | |
| `--segment` | `var(--surface-3)` | indikator tab/segmen terpilih |
| `--segment-foreground` | `var(--text)` | |
| `--radius` | `var(--radius-m)` | sehingga `rounded-lg` = 10 px |
| `--scrollbar` | `var(--border-strong)` | |
| `--scrollbar-thumb` | `var(--border-strong)` | |
| `--scrollbar-track` | `transparent` | |
| `--scrollbar-color` | `var(--scrollbar-thumb) var(--scrollbar-track)` | |
| `--scrollbar-gutter` | `auto` | |
| `--scrollbar-width` | `thin` | |
| `--spacing` | `0.25rem` | sama dengan default |
| `--disabled-opacity` | `0.5` | ditinjau kontras di spike; teks disabled tidak wajib AA |
| `--cursor-interactive` | `pointer` | |
| `--cursor-disabled` | `not-allowed` | |
| `--skeleton-animation` | `pulse` | `none` di dalam blok reduced-motion |
| `--tooltip-delay` | `600ms` | |
| `--tooltip-close-delay` | `200ms` | |
| `--white` | `var(--text)` | primitif HeroUI dinetralkan ke palet |
| `--black` | `var(--accent-ink)` | |
| `--snow` | `var(--text)` | |
| `--eclipse` | `var(--bg)` | |

Catatan:
- `--radius-xl: 20px` dan `--ease-out`/`--ease-in-out` Potongin menimpa nilai Tailwind/HeroUI bernama sama. Ini disengaja dan dicatat di `docs/design/TOKENS.md`: `rounded-xl` = 20 px, dan `ease-out` mengikuti Potongin.
- Pasangan kontras baru (`--success-foreground` di atas `--success`, `--warning-foreground` di atas `--warning`, `--accent-foreground` di atas `--accent`) dicatat di TOKENS.md dan diperiksa `contrast-check.py` serta `ui-guards`.
- **Tes** (bagian `ui-foundation.test.mjs`): baca `node_modules/@heroui/styles/dist/themes/default/variables.css`, ambil semua `--nama:`, lalu gagal kalau ada nama yang tidak punya deklarasi di `:root` `globals.css`. Tes ini menangkap variabel baru setelah upgrade HeroUI.

### 3.5 Override komponen (`ui.css`, `@layer components`)

```css
@layer components {
  /* 44 px dan radius Potongin. HeroUI md = 40/36 px, bentuk pil. */
  .button, .tabs__tab, .menu-item, .list-box-item, .close-button,
  .toggle-button, .pagination__link, .tag__remove-button { min-height: 44px; min-width: 44px; }
  .button { border-radius: var(--radius-m); }
  .button--outline { border-color: var(--border-strong); }
  /* Terpilih tanpa lime */
  .switch[data-selected] .switch__control,
  .checkbox[data-selected] .checkbox__control,
  .radio[data-selected] .radio__control { background: var(--text); border-color: var(--text); }
  .switch[data-selected] .switch__thumb { background: var(--bg); }
  .toggle-button[data-selected], .tabs__tab[data-selected], .list-box-item[data-selected],
  .menu-item[data-selected] { background: var(--surface-3); color: var(--text);
    box-shadow: inset 0 0 0 1px var(--border-strong); }
  /* Chip/Alert tidak punya varian accent */
  .chip--accent, .alert--accent { background: var(--surface-3); color: var(--text); }
}
@media (forced-colors: active) {
  .button, .chip, .switch__control, .toggle-button, .tabs__tab { border: 1px solid ButtonText; }
  .toggle-button[data-selected], .tabs__tab[data-selected], .switch[data-selected] .switch__control
    { background: Highlight; color: HighlightText; forced-color-adjust: none; }
  .progress-bar__fill, .meter__fill { background: Highlight; }
  :focus-visible { outline: 2px solid Highlight; }
}
```

Nama kelas BEM di atas sudah dicocokkan dengan `dist/components/*.css` 3.1.0 (`.button`, `.button--outline`, `.tabs__tab`, `.menu-item`, `.list-box-item`, `.close-button`, `.toggle-button`, `.pagination__link`, `.tag__remove-button`, `.switch__control`, `.switch__thumb`, `.checkbox__control`, `.radio__control`, `.chip--accent`, `.alert--accent`, `.progress-bar__fill`, `.meter__fill`; **tidak ada** `.dropdown__item` maupun `.tag-group__remove`) dan diverifikasi ulang terhadap 3.2.6 saat spike. Kalau berbeda, selector disesuaikan dan tesnya tetap sama: e2e mengukur `boundingBox().height ≥ 44` untuk setiap `button`, `[role=tab]`, `[role=menuitem*]`, dan `[role=option]` yang terlihat di halaman uji, dan memeriksa `getComputedStyle` keadaan terpilih ≠ `--accent`.

### 3.6 Provider dan penempatannya

| File | Isi | Dipasang di |
|---|---|---|
| `web/app/layout.jsx` (diubah) | Server: `getLocale()` → `<html lang={locale} className={dmSans.variable} data-theme="dark">`; `<IntlProvider locale messages={core} timeZone now>` **saja** | Semua rute |
| `web/components/ui/Providers.jsx` **(baru)**, `"use client"` | `<I18nProvider locale={localeEntry(locale).intl}>` (`react-aria-components`) + `<Toast.Provider placement="bottom end" />` + konteks `UiPrefs` (pintasan). **Tanpa `RouterProvider`.** | Di dalam `AppShell` dan `PublicCard` (login, undangan, reset) |
| Segment layout (`app/dashboard/layout.jsx`, `app/projects/layout.jsx`, `app/settings/layout.jsx`, `app/trends/layout.jsx` sudah ada; `app/sosial/layout.jsx`, `app/analitik/layout.jsx`, `app/akun/layout.jsx`, `app/admin/layout.jsx`, `app/login/layout.jsx`, `app/undangan/[token]/layout.jsx`, `app/atur-ulang-sandi/[token]/layout.jsx` **(baru)**) | `<SegmentI18n namespaces={[…]}>` (`web/components/SegmentI18n.jsx` **(baru, dok i18n §8.2)**): `IntlProvider` bersarang dengan pesan **gabungan** `CORE` + namespace rute (provider bersarang mengganti, tidak menggabungkan). Daftar namespace per layout = tabel dok i18n [07-i18n.md](07-i18n.md) | Per rute |

- **Rute editor:** `app/projects/layout.jsx` membungkus editor. Provider segmentnya hanya memuat namespace `projects`/`project`, sedangkan `app/projects/[id]/clips/[clipId]/edit/layout.jsx` **(baru, dok i18n)** memasang provider editor sendiri. `ui.css` tidak ikut terbawa karena hanya diimpor `AppShell`, dan halaman edit tidak merender `AppShell`.
- **Larangan `RouterProvider`:** komponen React Aria dengan `href` (`Link`, `Dropdown.Item href`, baris `Table`) merender `<a>` dan memakai navigasi dokumen penuh. Tes `ui-foundation` gagal kalau kata `RouterProvider` muncul di `web/app/**` atau `web/components/**`. Setiap pemanggilan `editorHref(` (`lib/editor/open-clip.mjs:35`) di luar `components/editor` harus berakhir di atribut `href` elemen `<a>` atau di `Dropdown.Item href`.

### 3.7 Wrapper `web/components/ui/*` (baru)

Wrapper ini dibuat karena React Aria tidak punya locale `id` dan HeroUI menulis label Inggris sendiri ("Close"). Setiap wrapper mengisi label dari namespace `aria`.

| Wrapper | Label yang diisi | Kunci |
|---|---|---|
| `SearchField.jsx` | tombol hapus | `aria.clearSearch` |
| `Modal.jsx`, `Drawer.jsx`, `CloseButton.jsx` | tombol tutup | `aria.close` |
| `Table.jsx` | checkbox pilih semua dan pilih baris | `aria.selectAll`, `aria.selectRow` |
| `TagGroup.jsx` | hapus tag | `aria.removeTag` |
| `Pagination.jsx` | sebelumnya, berikutnya, halaman | `aria.prev`, `aria.next`, `aria.page` |
| `DatePicker.jsx` | kalender dan segmen tanggal | `aria.calendar`, `aria.dateSegments.*` |
| `Toast.jsx` | tutup notifikasi, region | `aria.dismiss`, `aria.notifications` |
| `Table.jsx` (lanjutan) | baris "memuat lagi" (`Table.LoadMore`) | `aria.loadingMore` |
| `DatePicker.jsx` (lanjutan) | bulan sebelum/berikut | `aria.prevMonth`, `aria.nextMonth` |
| `ProgressBar`/`Skeleton` pemanggil | status memuat | `aria.loading` |
| `Disclosure.jsx` | (label dari pemanggil) | — |
| `PageHead.jsx` | (bukan wrapper HeroUI) `<header>` + `<h1>` + slot aksi; menolak `children` berupa `<p>` | — |
| `StatusPill.jsx` | (bukan wrapper) `Chip` + teks status dari `status.*` | — |
| `EmptyState.jsx` | membungkus `EmptyState` HeroUI (komponen ini ada di `@heroui/react`, diimpor `as HeroEmptyState`): `<h2>` judul + satu `Button` | — |
| `LoadError.jsx` | (bukan wrapper) pola P8: pesan `common.loadFailed` + [Coba lagi] | `common.retry` |
| `PublicCard.jsx` | (bukan wrapper) kartu tunggal tanpa shell, impor `ui.css` + `Providers` | — |

Struktur compound yang dipakai (dicek di `@heroui/react@3.1.0/dist/components/*/index.d.ts`): `Modal` → `Modal.Backdrop > Modal.Container size placement > Modal.Dialog > Modal.Header/Heading/Body/Footer` (`size` ∈ `xs|sm|md|lg|cover|full`); `Drawer` → `Drawer.Backdrop > Drawer.Content placement > Drawer.Dialog > Drawer.Header/Heading/Body/Footer` (`placement` ∈ `top|bottom|left|right`); `Dropdown` → `Dropdown.Trigger/Popover/Menu/Section/Item/ItemIndicator`; `Table` → `Table.ScrollContainer > Table.Content > Table.Header/Column/Body/Row/Cell`, `Table.LoadMore`; `Disclosure` → `Disclosure.Heading > Disclosure.Trigger + Disclosure.Indicator`, `Disclosure.Content > Disclosure.Body`; `Alert` → `Alert.Indicator/Content/Title/Description` (`status` ∈ `default|accent|success|warning|danger`; merender `div` **tanpa role**, jadi pemanggil menulis `role="alert"`/`"status"` sendiri); `Chip` (`color` ∈ `default|accent|success|warning|danger`, `variant`), `Chip.Label`; `Avatar.Image/Fallback`; `Card.Header/Title/Description/Content/Footer`; `Toast.Provider` + fungsi `toast()`; `Kbd.Content`. Varian `accent` dilarang di `Chip`/`Alert` (guard).

Tes `heroui-default-labels` **(baru)** memindai `node_modules/@heroui/react/dist/**` mencari literal `"aria-label": "`. Tes gagal kalau komponen pemilik literal itu diimpor langsung dari `@heroui/react` di `app/**` atau `components/**` (bukan lewat wrapper).

### 3.8 Konvensi penulisan

- Utility Tailwind hanya untuk tata letak (`flex`, `grid`, `gap-*`, `p-*`, `w-*`). Warna hanya lewat kelas semantik HeroUI atau token `var(--…)`.
- `ui-guards` (diubah) menolak `-[#`, nama palet Tailwind (`red-`, `slate-`, …) di `className`, `<Button` tanpa `variant`, lebih dari satu `variant="primary"` per file halaman, `<p>` di dalam `<PageHead>`, dan kata `V2`/`V3`/`Selection V3`/`engine_fallback`/`Latest only` di copy.
- CSS Modules tetap dipakai untuk poster klip, stepper, dan chart.
- JS, bukan TS. `// @ts-check` + JSDoc kalau perlu.
- Logika `lib/*-view.mjs` tetap; copy di dalamnya diganti deskriptor `{key, values}` (i18n M3) bersama tesnya.

### 3.9 Preferensi UI per perangkat

| Preferensi | Penyimpanan | Nilai | Default | Dibaca oleh |
|---|---|---|---|---|
| Bahasa | cookie `potongin_locale` + `users.locale` sejak Fase 4 (resolusi dan format cookie: dok 07 §5) | kode di registry locale | `users.locale` → cookie → Accept-Language → `id` | server |
| Zona waktu | `users.time_zone` sejak Fase 8 (dok 07 §13.2) | IANA | zona perangkat (dok 07 §13.3) → `Asia/Jakarta` | server |
| Pintasan satu tombol | cookie `potongin_shortcuts` (Path=/, SameSite=Lax, Secure di produksi, 1 tahun, tidak HttpOnly). **Dokumen ini pemilik cookie ini.** | `on` \| `off` (nilai `1`/`0` lama dibaca sebagai `on`/`off`) | `on` | `web/lib/ui-prefs.mjs` **(baru)**: `readShortcutPref(cookieString)`, `writeShortcutPref(on)`; dipakai dashboard sejak Fase 1 dan editor sejak Fase 10 (satu preferensi, KA20; dok 06 §14) |

Pintasan dashboard didefinisikan di `web/lib/app-shortcuts.mjs` **(baru)**:

| Tombol | Aksi | Aktif bila |
|---|---|---|
| `N` | buka `/dashboard` | preferensi `on`, fokus tidak di field (`input`, `textarea`, `select`, `[contenteditable]`, `[role=textbox]`), tidak ada overlay terbuka (`[role=dialog]`, `[role=menu]`, `[role=listbox]`), tanpa modifier |
| `/` | fokus ke `SearchField` halaman (Proyek, Tren, Bantuan, Admin) | sama |
| `←` / `→` | klip sebelumnya/berikutnya | hanya di dalam penampil klip (§6.4); bukan pintasan satu huruf |

Semua pintasan tercantum di `GUIDE_SHORTCUTS` (`web/lib/help-guide.mjs`) dalam kelompok "Dashboard". `j`/`k` tidak dipakai.

---

## 4. Navigasi: sidebar dan rute

### 4.1 Model data (`web/lib/app-nav.mjs`, diubah)

`NAV_GROUPS`, `navGroups()` dan label kelompok ("Kerja", "Sistem") dihapus, diganti daftar datar:

```js
// labelKey: kunci katalog; role: null | "admin"; feature: null | "social" | "analytics" | "admin"
export const NAV_LINKS = Object.freeze([
  { href: "/dashboard", labelKey: "shell.nav.create",    icon: "create",   primary: true },
  { href: "/projects",  labelKey: "shell.nav.projects",  icon: "projects" },
  { href: "/sosial",    labelKey: "shell.nav.social",    icon: "social",    feature: "social" },
  { href: "/analitik",  labelKey: "shell.nav.analytics", icon: "analytics", feature: "analytics" },
  { href: "/trends",    labelKey: "shell.nav.trends",    icon: "trends" },
  { href: "/settings",  labelKey: "shell.nav.settings",  icon: "settings" },
  { href: "/admin/pengguna", labelKey: "shell.nav.admin", icon: "admin",   role: "admin", feature: "admin", match: "/admin" },
  { href: "/bantuan",   labelKey: "shell.nav.help",      icon: "help" },
]);
/** @returns {{href,labelKey,icon,primary?:true,current:boolean}[]} */
export function navLinks(pathname, { role = "admin", features = {} } = {});
```

Aturan `navLinks`:
- Link ber-`role` hanya muncul kalau `role` sama.
- Link ber-`feature` hanya muncul kalau `features[feature] === true`.
- `current` = path sama, atau diawali `match ?? href` + `/`.
- Default `role: "admin"` berlaku untuk mode single-user sebelum Fase 4, karena pemilik env adalah admin. Meski begitu, `/admin` belum ada sebelum Fase 6, jadi link itu juga dijaga flag internal `features.admin`.

`features` dihitung di server oleh `web/lib/ui-features.mjs` **(baru)**: `uiFeatures(user, env = process.env)` → `{ social, performance, analytics, admin }`. Nilai flag mengikuti [03-sosmed-performa.md](03-sosmed-performa.md) §3 (`POTONGIN_SOCIAL` = `off`(default)\|`admin`\|`on`; `POTONGIN_PERFORMANCE` = `off`(default)\|`on`).

| Fitur | Bernilai `true` bila |
|---|---|
| `social` | `POTONGIN_SOCIAL=on`, atau `=admin` dan pengguna admin |
| `performance` | `POTONGIN_PERFORMANCE=on` (impor CSV, switch "Pakai di pemilihan klip") |
| `analytics` | `social` **atau** `performance` (sama dengan gate `/api/analytics/**` di dok 03 §9) |
| `admin` | pengguna admin dan DB multi-user aktif (Fase 6) |

Nilainya dioper sebagai prop ke `AppShell`. `web/lib/app-menu.mjs` tetap dipakai untuk `MENU_BREAKPOINT_PX`/`MENU_QUERY`. `menuReducer` dihapus bersama `.appScrim` karena digantikan `Drawer`, dan asersinya pindah ke e2e.

Ikon baru di `web/lib/app-icons.mjs`: `projects` (mengganti `history`), `social`, `analytics`, `admin`, `account`, `calendar`, `language`, `keyboard`, serta glyph platform `youtube`, `tiktok`, `instagram` (monokrom, tanpa warna merek).

### 4.2 Sidebar

```
Desktop ≥ 1024 px (kolom 232 px)          Mobile < 1024 px
┌──────────────────────────┐             ┌──────────────────────────────────┐
│ ▣ Potongin               │             │ ▣ Potongin  ● 42%      [☰ Menu]  │
│ ● 1 diproses · 42%       │ JobBadge    └──────────────────────────────────┘
│ [ + Buat klip ]          │ appCreate   Menu → Drawer kiri (placement="left"):
│ ▤ Proyek                 │             ┌────────────────────┐
│ ⇪ Sosial          (flag) │             │ Menu           [✕] │
│ ▲ Analitik        (flag) │             │ [ + Buat klip ]    │
│ ✦ Tren                   │             │ ▤ Proyek           │
│ ⚙ Pengaturan             │             │ …                  │
│ ⛨ Admin          (admin) │             │ ─────────────────  │
│ ? Bantuan                │             │ (AS) andi       ⌄  │
│                          │             └────────────────────┘
│ (AS) andi             ⌄  │ AccountMenu
└──────────────────────────┘
```

**Menu akun** (`web/components/AccountMenu.jsx` **(baru)**, `Dropdown`):

| Item | Muncul sejak | Perilaku |
|---|---|---|
| Akun | Fase 6 | `href="/akun"` |
| Bahasa ▸ Bahasa Indonesia / English | Fase 1 (hanya locale yang aktif di `POTONGIN_LOCALES`; disembunyikan kalau hanya satu) | `Dropdown.Section selectionMode="single"`. `onAction` mengisi input tersembunyi lalu `requestSubmit()` form `POST /api/locale`, diikuti muat ulang penuh. Totalnya 2 klik. |
| Pintasan satu tombol | Fase 1 | `Dropdown.Item` dengan `selectionMode="multiple"` (tanda centang); menulis cookie `potongin_shortcuts` |
| Keluar | Fase 1 | `variant="danger"`. `onAction` → `logoutFormRef.current.requestSubmit()` |

Form tersembunyi tetap ada di `AppShell`: `<form method="post" action="/api/auth/logout" hidden>`, sebagai syarat `app-shell.test.mjs:128`.

Sebelum Fase 4, avatar memakai inisial dari `APP_USERNAME`, yang dioper server lewat `currentUser()` versi env.

**Komponen:**
- `web/components/NavList.jsx` **(baru)**: satu `<nav aria-label={t("aria.mainMenu")}>`, `<ul>` berisi `<a className={linkVariants(...)}>` + `aria-current="page"`. Dirender sekali di sidebar dan sekali di Drawer (dua elemen DOM, satu komponen sumber). Saat Drawer terbuka, sidebar desktop tidak dirender.
- Drawer: `Drawer.Backdrop > Drawer.Content placement="left" > Drawer.Dialog`. Escape atau Tutup mengembalikan fokus ke tombol Menu, dan konten di belakangnya inert (bawaan React Aria). Drawer tertutup saat lebar ≥ 1024 px.
- Dipertahankan: `.skipLink` → `#konten`, `<main id="konten">`, kelas `.appSide`, `.jobBadge`, `.jobBadgeDot`, `.jobBadgeText`, `.brandName` (dipakai `e2e/header-badge.spec.mjs`).

**Dihapus dibanding hari ini:** label kelompok "Kerja"/"Sistem", `.appScrim` + scroll-lock buatan sendiri, reducer drawer, dan tombol Keluar yang selalu tampil (pindah ke menu akun).

### 4.3 Rute lama → baru

| Lama | Baru | Label nav | Catatan |
|---|---|---|---|
| `/dashboard` | tetap; `?ulang=<jobId>` (Proses ulang, §6.4) | Buat klip | Aside "Hasil" dihapus; submit → `/projects/[id]` |
| `/projects` | tetap; `?tab=proyek\|klip`, `?status=semua\|diproses\|selesai\|gagal`, `?q=` | Proyek (dulu "Riwayat") | Tab Klip menggantikan grid Riwayat |
| `/projects/[id]` | tetap; `?klip=N` | — | `N` = nomor klip (format lama dipertahankan, `page.jsx:441,622`) |
| `/projects/[id]/clips/[clipId]/edit` | tidak berubah | — | `<a>` + pemuatan penuh; tanpa `ui.css` |
| `/trends` | tetap; `?tab=daftar\|agen` | Tren (dulu "Konteks Tren") | Tab Agen hanya admin |
| `/settings` | tetap; hash `#ai`, `#transkripsi`, `#tampilan`, `#youtube`, `#sistem` | Pengaturan | Hash = id anchor yang sudah ada (`settings/page.jsx:773-882`). Tanpa tab Akun |
| `/bantuan` | tetap; `#<kode>` | Bantuan | Anchor error tetap |
| `/licenses` | tetap, di shell | — | Ditautkan dari Bantuan dan Pengaturan → Sistem |
| `/login` | tetap | — | Form POST native, `name` sama |
| — | `/akun` **(baru, Fase 6)** | menu akun | Profil, Bahasa, sesi, token, Zona (Fase 8) |
| — | `/akun/kata-sandi` **(baru, Fase 6)** | — | Ganti sandi; wajib setelah sandi sementara |
| — | `/undangan/[token]`, `/atur-ulang-sandi/[token]` **(baru, Fase 6)** | — | Publik, dengan pemilih bahasa |
| — | `/admin/pengguna`, `/admin/pengguna/[userId]`, `/admin/job` **(baru, Fase 6)** | Admin | 404 untuk non-admin |
| — | `/sosial` **(baru, Fase 8)**; `?tab=jadwal\|akun`, `?hasil=terhubung\|ditolak\|gagal` (nilai dari callback OAuth, dok 03 §9.1; state kedaluwarsa jatuh ke `gagal`), `?status=semua\|terjadwal\|terbit\|gagal\|dibatalkan` | Sosial | Menggantikan `/jadwal` di roadmap lama |
| — | `/analitik` **(baru, Fase 9)**; `?rentang=7\|30\|90` | Analitik | Menggantikan `/performa` |
| — | `/privasi`, `/ketentuan` (Fase 8, dok sosmed) | — | Publik, tanpa shell |
| `/projects/[id]/candidates/**` | tetap (redirect ke `/projects/[id]`, `app/projects/[id]/candidates/[[...rest]]/page.js`) | — | Tidak disentuh |
| `/` (halaman depan) | tetap | — | Hanya copy "panel Hasil" + `public/landing/editor.webp` diganti (F3, §6.4) |

Penjagaan peran di server ada di tiga tempat: layout segment `app/admin/layout.jsx` (memanggil `notFound()` untuk non-admin), API (`secureRoute role:'admin'`), dan `proxy.js` (sesi saja).

### 4.4 Visibilitas per peran (sejak Fase 5–6)

| Area | Member | Admin |
|---|---|---|
| Buat klip, Proyek, Tren (Daftar), Bantuan | ✓ milik sendiri | ✓ milik sendiri |
| Sosial | ✓ bila `POTONGIN_SOCIAL=on` | ✓ bila `admin`/`on` |
| Analitik | ✓ bila `features.analytics` | ✓ bila `features.analytics` |
| Pengaturan → Tampilan (logo, watermark, pintasan) | ✓ milik sendiri | ✓ milik sendiri |
| Pengaturan → AI | ✓ rantai **pribadi** (`scope=user`), hanya bila `member_llm_keys_allowed=true`; selain itu tab tidak dirender | ✓ pribadi + instans |
| Pengaturan → Transkripsi | ✓ key Groq **pribadi** (`scope=user`) | ✓ pribadi + instans |
| Pengaturan → YouTube, Sistem | ✗, tab tidak dirender | ✓ |
| Tren → tambah/ubah/hapus, tab Agen, switch tren instans | ✗ (member punya switch pribadi "Pakai di pemilihan klip") | ✓ |
| Admin | 404 | ✓ |
| Akun | ✓ | ✓ |

Pembagian ini mengikuti tabel peran dok 02 §2.1 (Pengaturan Pribadi vs Instans); kalau berbeda, dok 02 menang. Kalau Pengaturan member hanya punya satu tab, `Tabs` tidak dirender dan isinya tampil langsung.

---

## 5. Kata status (namespace `status`)

Satu sumber untuk semua layar. Rencana lama memakai `lib/status-words.mjs`; file itu **tidak dibuat**, digantikan namespace katalog `status`. Pemetaan dari status job ada di `web/lib/status-view.mjs` **(baru)**: `processStatus(job) → {key, detailKey?, detailValues?, tone}`.

**Status proses** (menggantikan `STATUS_LABELS` di `lib/project-view.mjs:9` dan `JOB_STATUS_LABELS` di `lib/dashboard-view.mjs:11`):

| `job.status` | Kunci | id | en | Tone `Chip` |
|---|---|---|---|---|
| `queued` | `status.process.queued` | Antre | Queued | `default` |
| `queued` + `queue.held='maintenance'` (drain, dok 02 §10.5) | `status.process.queued` + detail `status.detail.maintenance` | Antre · Pemeliharaan | Queued · Maintenance | `default` |
| `queued` + `held='owner_disabled'` (hanya `/admin/job`, dok 02 §10.3) | `status.process.queued` + detail `status.detail.ownerDisabled` | Antre · Pengguna nonaktif | Queued · User disabled | `default` |
| `preparing`, `downloading`, `processing` | `status.process.running` | Diproses | Processing | `default` + titik lime |
| `completed` | `status.process.completed` | Selesai | Done | `success` |
| `failed` | `status.process.failed` | Gagal | Failed | `danger` |
| `cancelled` | `status.process.cancelled` | Dibatalkan | Cancelled | `default` |
| `deleting` | `status.process.deleting` | Menghapus | Deleting | `default` (transien; baris disembunyikan setelah selesai) |
| tak dikenal | `status.process.unknown` | Tidak dikenal | Unknown | `default` |

Detail tahap (`stage.<code>` dari i18n M5, menggantikan `JOB_STAGE_LABELS`) tampil di sebelah status Diproses, misalnya `Diproses · Membuat transkrip`. Job lama tanpa `stageCode` menampilkan `stageDetail` apa adanya.

**Status postingan** (`publish_runs` + `posts`, dok sosmed):

| Status | Kunci | id | en | Tone |
|---|---|---|---|---|
| `scheduled` (tanpa `hold`) | `status.post.scheduled` | Terjadwal | Scheduled | `default` |
| `scheduled` + `hold='reauth'` | `status.post.scheduled` + detail `status.hold.reauth` | Terjadwal · Hubungkan ulang akun | Scheduled · Reconnect account | `warning` |
| `scheduled` + `hold='quota'`\|`'rate'` | `status.post.scheduled` + detail `status.hold.quota` | Terjadwal · Menunggu kuota | Scheduled · Waiting for quota | `warning` |
| `claimed`, `uploading`, `processing` | `status.post.uploading` | Mengunggah | Uploading | `default` |
| `published` | `status.post.published` | Terbit | Published | `success` |
| `failed` | `status.post.failed` | Gagal | Failed | `danger` |
| `maybe_sent` | `status.post.failed` + detail `status.detail.check` | Gagal · Perlu dicek | Failed · Needs review | `danger` |
| `cancelled` | `status.post.cancelled` | Dibatalkan | Cancelled | `default`; disembunyikan dari daftar default `/sosial`, muncul lewat saring "Dibatalkan" |

Tidak ada kata status ke-6 (P5): `maybe_sent` tampil sebagai Gagal + detail, sesuai tabel state dok 03 §6.1. Nilai `state`/`hold` dan transisinya **milik** `publish_runs` di [03-sosmed-performa.md](03-sosmed-performa.md) §4.2/§6.1; pemetaan dari `Run.statusCode` dipegang `web/lib/social/view.mjs` (dok 03 §9.1), `status-view.mjs` hanya untuk status proses. Kalau nilai di sana berubah, yang diperbarui cukup tabel pemetaan ini dan `status-view.test.mjs`.

**Dokumen ini pemilik kata status yang tampil.** Daftar kunci lengkap namespace `status`: `status.process.{queued,running,completed,failed,cancelled,deleting,unknown}`, `status.post.{scheduled,uploading,published,failed,cancelled}`, `status.detail.{maintenance,ownerDisabled,check}`, `status.hold.{reauth,quota}`. Dok 07 §7.1 hanya merangkum namespace ini.

---

## 6. Per layar

Format setiap layar: file → aksi utama → wireframe → komponen → data/API → state → kunci pesan → dihapus → tes.

Copy `en` adalah draf dari katalog `web/messages/id/*.json` + glosarium (Q9), dan pemilik mereviewnya per fase. Semua kunci memakai nama namespace lengkap.

**Kunci bersama** (`common`, `aria`), dipakai di semua layar:

| Kunci | id | en |
|---|---|---|
| `common.retry` | Coba lagi | Try again |
| `common.loadFailed` | Gagal memuat | Couldn't load |
| `common.notFound` | Tidak ditemukan | No results |
| `common.cancel` | Batal | Cancel |
| `common.save` | Simpan | Save |
| `common.saved` | Tersimpan | Saved |
| `common.delete` | Hapus | Delete |
| `common.copy` | Salin | Copy |
| `common.copied` | Disalin | Copied |
| `common.close` | Tutup | Close |
| `common.open` | Buka | Open |
| `common.more` | Lainnya | More |
| `common.search` | Cari | Search |
| `common.advanced` | Lanjutan | Advanced |
| `common.all` | Semua | All |
| `common.help` | Bantuan | Help |
| `common.clips` | `{count, plural, other {# klip}}` | `{count, plural, one {# clip} other {# clips}}` |
| `aria.mainMenu` | Menu utama | Main menu |
| `aria.close` | Tutup | Close |
| `aria.clearSearch` | Hapus pencarian | Clear search |
| `aria.selectAll` | Pilih semua | Select all |
| `aria.selectRow` | Pilih baris | Select row |
| `aria.removeTag` | Hapus tag | Remove tag |
| `aria.prev` | Sebelumnya | Previous |
| `aria.next` | Berikutnya | Next |
| `aria.page` | Halaman {n} | Page {n} |
| `aria.calendar` | Kalender | Calendar |
| `aria.dismiss` | Tutup notifikasi | Dismiss |
| `aria.loading` | Memuat | Loading |
| `aria.loadingMore` | Memuat lagi | Loading more |
| `aria.notifications` | Notifikasi | Notifications |
| `aria.prevMonth` | Bulan sebelumnya | Previous month |
| `aria.nextMonth` | Bulan berikutnya | Next month |
| `aria.moreActions` | Aksi lain untuk {name} | More actions for {name} |

### 6.1 Shell (`web/components/AppShell.jsx`, diubah)

- **Aksi utama:** tidak ada lime. "Buat klip" di sidebar memakai tombol netral yang kuat (`.appCreate`).
- **Wireframe:** lihat §4.2.
- **Komponen HeroUI:** `Link`/`linkVariants()`, `Separator`, `Avatar` + `Avatar.Fallback`, `Dropdown` (`Trigger`/`Popover`/`Menu`/`Section`/`Item`), `Drawer`, `Kbd`. Ikon tetap memakai `AppIcon`.
- **Props baru:** `AppShell({ current, className, user, features, children })`, dengan `user = { displayName, initials, role }`. Setiap halaman server mengirim props ini; untuk halaman client, nilainya datang lewat layout segment.
- **State:**
  - JobBadge tidak berubah logikanya (`lib/job-badge.mjs`); copy-nya pindah ke `shell.badge.*`.
  - Kalau sesi habis saat polling (`signedOut`), muncul toast `shell.signedOut` + [Masuk].
  - Sejak Fase 8: bila `users.time_zone` masih `NULL`, `AppShell` mengirim zona perangkat sekali per sesi ke `PATCH /api/account/preferences` dengan header `X-Potongin-Auto: 1`, tanpa UI (kontrak dok 07 §13.3).

| Kunci | id | en |
|---|---|---|
| `shell.skip` | Langsung ke isi | Skip to content |
| `shell.nav.create` | Buat klip | Create clips |
| `shell.nav.projects` | Proyek | Projects |
| `shell.nav.social` | Sosial | Social |
| `shell.nav.analytics` | Analitik | Analytics |
| `shell.nav.trends` | Tren | Trends |
| `shell.nav.settings` | Pengaturan | Settings |
| `shell.nav.admin` | Admin | Admin |
| `shell.nav.help` | Bantuan | Help |
| `shell.menu` | Menu | Menu |
| `shell.account.title` | Akun | Account |
| `shell.account.language` | Bahasa | Language |
| `shell.account.shortcuts` | Pintasan satu tombol | Single-key shortcuts |
| `shell.account.logout` | Keluar | Sign out |
| `shell.badge.running` | {count} diproses · {percent} | {count} processing · {percent} |
| `shell.badge.queued` | {count} antre | {count} queued |
| `shell.badge.failed` | {count} gagal | {count} failed |
| `shell.signedOut` | Sesi berakhir | Session ended |

- **Tes:**
  - `tests/app-shell.test.mjs` (diubah): satu `<nav>` berlabel; form logout tersembunyi masih ada; `lang={locale}` dan `data-theme="dark"` menggantikan regex `:257`; `--muted` tetap.
  - `tests/app-nav.test.mjs` **(baru)**: `navLinks` per peran dan fitur, serta `current` untuk `/admin/job` dan `/projects/x`.
  - `tests/ui-prefs.test.mjs` **(baru)**.
  - `tests/app-shortcuts.test.mjs` **(baru)**: pintasan tidak aktif di field, di overlay, saat preferensi `off`, atau dengan modifier.
  - e2e `app-shell.spec.mjs` (diubah, plus proyek `mobile-chromium`): fokus kembali ke Menu, latar inert, Escape, `aria-current`, 44 px, ganti bahasa dalam 2 klik.
  - `header-badge.spec.mjs`: kelas tetap.

### 6.2 Login (`web/app/login/page.jsx`, diubah)

- **Aksi utama:** [Masuk] (`variant="primary"`).

```
Desktop                                   Mobile (360 px)
┌───────────────────────────────┐         ┌──────────────────────┐
│ ▣ Potongin                    │         │ ▣ Potongin           │
│ Masuk                         │         │ Masuk                │
│ Nama pengguna [             ] │         │ Nama pengguna        │
│ Kata sandi    [             ] │         │ [                  ] │
│ ⚠ Nama atau sandi salah       │         │ Kata sandi           │
│ [ Masuk ]                     │         │ [                  ] │
│                               │         │ [ Masuk            ] │
│ Bahasa [Bahasa Indonesia ▾][Simpan]     │ Bahasa [ID ▾][Simpan]│
└───────────────────────────────┘         └──────────────────────┘
```

- **Komponen:**
  - Halaman dibungkus `PublicCard` (§3.7), yang membawa `ui.css` dan `Providers`.
  - Field memakai `TextField` + `Input` dengan `name="username"`/`name="password"` persis; tombol `Button type="submit" variant="primary"`. Bentuknya tetap form native `method="post" action="/api/auth/login"`, dengan `<input type="hidden" name="next">` (`safeNextPath`). Tanpa JS, form tetap jalan.
  - Error ditulis di `<p id="login-error" role="alert">` (bukan `Alert`: `Alert` HeroUI merender `div` tanpa role).
  - Pemilih bahasa adalah form kedua: `LanguageSwitcher variant="form"` (dok 07 §9.1) = `<select name="locale">` native + `<input type="hidden" name="next">` + `<button>` Simpan → `POST /api/locale`. Tidak dirender kalau hanya satu locale aktif.
- **State:** error dari `loginErrorMessage(code)` (`lib/login-view.mjs:9`) diganti `loginErrorKey(code)` → kunci. Kode `?error=` mengikuti route login (dok 02 §6.1): `1` → `errors.web.login_invalid` (sama untuk user tak ada, sandi salah, **dan** akun nonaktif: anti-enumerasi; tidak ada `account_disabled`), `limit` → `errors.web.rate_limited`; kode lain → tidak ada pesan. Domain dan teks kode mengikuti dok 07 §10.2. `?bahasa=gagal` (form `/api/locale` ditolak, dok 07 §9.2) → `auth.locale.failed` di `<p role="alert">`. `?keluar=1` tidak menampilkan pesan (hanya menjalankan `clearAllDrafts()`). `must_change_password` bukan error: route langsung 303 ke `/akun/kata-sandi`.

| Kunci | id | en |
|---|---|---|
| `auth.login.title` | Masuk | Sign in |
| `auth.login.username` | Nama pengguna | Username |
| `auth.login.password` | Kata sandi | Password |
| `auth.login.submit` | Masuk | Sign in |
| `errors.web.login_invalid` | Nama atau sandi salah | Wrong username or password |
| `errors.web.rate_limited` | Terlalu banyak percobaan. Coba lagi nanti. | Too many attempts. Try later. |
| `auth.locale.label` | Bahasa | Language |
| `auth.locale.save` | Simpan | Save |
| `auth.locale.failed` | Bahasa gagal diganti | Couldn't change language |
| `meta.login.title` | Masuk | Sign in |
| `meta.login.description` | Masuk ke Potongin | Sign in to Potongin |

Kunci `meta.*` mengikuti pola dok 07 §8.4 (`meta.<rute>.title` + `.description`) untuk setiap rute di dokumen ini; tabel per layar hanya mencantumkan contoh login.

- **Dihapus:** tagline intro (`<p>` "Buat, pantau, dan unduh…"), catatan "Sesi tersimpan 30 hari…", dan aside poster (`LANDING_MEDIA.sesudah`).
- **Tes:**
  - `tests/entry-pages.test.mjs` (diubah): asersi teks rate limit, tagline hilang, `name` tetap.
  - `tests/login-rate-limit.test.mjs` tidak berubah.
  - `tests/proxy-matcher.test.mjs`: `/api/locale` dikecualikan dengan alasan.
  - e2e `harness.mjs` `login()` tidak berubah.
  - e2e `app-shell.spec`: ganti bahasa di `/login` tanpa JS (`javaScriptEnabled:false`).

### 6.3 Buat klip (`web/app/dashboard/page.jsx`, ditulis ulang)

- **Aksi utama:** [Buat klip].

```
Desktop
┌────────────────────────────────────────────────────────────────────────┐
│ Buat klip                                                              │
│ [🔗 Link YouTube                                      ] [ Buat klip ]  │
│ atau [Pilih file]  [+ .srt]                                            │
│ (3 klip ▾)(Durasi: Otomatis ▾)(9:16 · 720p ▾)(Tata letak: Latar blur ▾)│
│ (Subtitle: Karaoke ▾)(Hook: Cold open · Teks ▾)(Arahkan ▾)(Indonesia ▾)│
│ ⚠ YouTube minta login · [Pasang cookies]   ← hanya kalau bermasalah    │
│ Terbaru                                             Semua proyek →     │
│ [poster][poster][poster][poster]                                       │
└────────────────────────────────────────────────────────────────────────┘
Mobile (360 px)
┌──────────────────────────────┐
│ Buat klip                    │
│ [🔗 Link YouTube           ] │
│ [Pilih file] [+ .srt]        │
│ (3 klip)(Otomatis)(9:16·720p)│  ← chip membungkus ke baris berikut
│ (Latar blur)(Karaoke)(Hook)  │
│ (Arahkan)(Indonesia)         │
│ [ Buat klip                ] │  ← tombol penuh di bawah chip
│ Terbaru →                    │
└──────────────────────────────┘
```

- **Chip → isi Popover:** sumber nilai tetap `web/lib/dashboard-choices.mjs` (`DURATION_PRESETS`, `RATIO_CHOICES`, `RESOLUTION_CHOICES`, `LAYOUT_CHOICES`, `CAPTION_STYLE_CHOICES`, `VIDEO_LANGUAGE_CHOICES`) dan `web/lib/clip-limits.mjs` (`CLIP_LIMITS`).

| Chip (label = nilai) | Isi Popover | Komponen |
|---|---|---|
| `{n} klip` | Jumlah (1–`CLIP_LIMITS`) | `NumberField` |
| Durasi: `{preset}` | `DURATION_PRESETS`; "Atur sendiri" menampilkan 2 field | `RadioGroup` + 2× `NumberField` |
| `{ratio} · {resolution}` | Rasio (`RATIO_CHOICES`), Resolusi (`RESOLUTION_CHOICES`) | 2× `ToggleButtonGroup` |
| Tata letak: `{nama}` | Ikuti wajah, Potong tengah, Latar blur; **Otomatis** sejak Fase 7, hanya bila `POTONGIN_AUTO_REFRAME=on` (opt-in, bukan default; Q10, dok 04 §0.2, §A8.3). Layar terbagi **tidak** ada di sini (KA11) | `RadioGroup` (label saja, tanpa deskripsi) |
| Subtitle: `{gaya}` | gaya (`CAPTION_STYLE_CHOICES`) + `LookPreview`; posisi dan ukuran di `Disclosure` Lanjutan | `ListBox` + 2× `ToggleButtonGroup` |
| Hook: `{ringkasan}` | Cold open, Teks hook | 2× `Switch` |
| Arahkan `{n}` | Fokus (tag + catatan), Rentang waktu | `TextField` + `TagGroup`, `TextArea` |
| `{bahasa video}` | `VIDEO_LANGUAGE_CHOICES` | `RadioGroup` |

- **Komponen lain:**
  - `ChoiceChip.jsx` **(baru)**: `Button variant="secondary"` + `Popover`. `aria-label` = "{label}: {nilai}" dan `aria-expanded`.
  - `TextField` untuk link.
  - Area file tetap custom (drag-drop) dengan overlay "Lepas di sini".
  - `Alert` untuk masalah (AI belum diatur, cookies, storage).
  - `Card` + `StatusPill` untuk Terbaru.
- **Data:**
  - `POST /api/jobs` di Fase 2 tidak berubah (multipart/form-data, field sama: `outputSize`, `hookOverlay`, …). Respons 201/202 `{job:{id}}` → `window.location.assign('/projects/'+id)`. Dipakai `assign`, bukan router, supaya konsisten dengan P12. Perubahan berikutnya milik dokumen lain: admission per user (Fase 6, dok 02 §10.1) dan `sourceUrl` (alias `youtubeUrl`) + `renderMode:"auto"` (Fase 7, dok 04 §B14, §A8.2).
  - Validasi link di klien memakai `parseSourceUrl` (`web/lib/source-url.mjs`, client-safe, dok 04 §B3.1) dengan platform yang flag-nya menyala; kode `SourceUrlError` dirender lewat `errorText` (`errors.web.source_*`, dok 04 §B13). Tidak ada kunci link-invalid khusus dashboard.
  - Terbaru: `GET /api/jobs` (sudah ada), 4 terbaru.
  - AI dan storage: `GET /api/llm/status`, `GET /api/storage/status` (sudah ada), ditampilkan hanya kalau bermasalah.
- **State:**
  - **Memuat Terbaru:** 4 `Skeleton` poster. Kalau kosong, bagian ini tidak dirender.
  - **Submit:** `isPending`, label tombol bergerak `dashboard.submit.uploading` (persen) → `.checking` → `.preparing`.
  - **Unggah putus:** `Alert danger` + [Coba lagi].
  - **Error field:** pesan di bawah field (`aria-describedby`). Fokus dipindah ke field itu; kalau field ada di dalam chip, Popover chip dibuka dulu. Ini perilaku `sectionOfField()` yang dipertahankan.
  - **Error server:** `errorText(t, err)` + tautan `/bantuan#<code>`.
  - **429 `user_queue_full`**, **429 `user_rate_limited`** (+ `Retry-After`) dan **507 `user_storage_quota`** (Fase 6, dok 02 §10.1; kunci `errors.web.<code>`, dok 07 §10.2): `Alert status="warning" role="alert"` + [Proyek] (→ `/projects`).
  - **Sumber ditolak** (Fase 6 MU-M4b, Fase 7 FETCH-M1): 400 `source_host_not_allowed`, `source_rejected_kind`, `source_private_address`, `source_platform_off`, `auto_reframe_off` (dok 04 §B13–§B14) → error di field link. `source_rejected_duration`/`_format`/`_codec`, `source_live`, `source_duration_unknown` datang dari worker sebagai `job.error` dan tampil di Detail proyek (§6.4).
  - **AI belum diatur** (Q4): member dengan `member_llm_keys_allowed=true` → `Alert` `dashboard.ai.missing` + tautan [Atur AI] (`/settings#ai`); bila tidak diizinkan → `dashboard.ai.missingAsk` tanpa tombol.
  - **Proses ulang** (`?ulang=<jobId>`): halaman memanggil `GET /api/jobs/[id]` (sudah ada), lalu mengisi link sumber (kalau sumbernya YouTube) dan semua chip dari opsi job itu lewat `choicesFromJob(job)` **(baru, `lib/dashboard-choices.mjs`)**. Sumber file tidak bisa diisi ulang: area file menampilkan `dashboard.source.reupload`. Job tidak ditemukan/milik orang lain → parameter diabaikan tanpa pesan. Tidak ada API baru; pengguna tetap menekan [Buat klip] (job baru).

| Kunci | id | en |
|---|---|---|
| `dashboard.title` | Buat klip | Create clips |
| `dashboard.source.link` | Link YouTube | YouTube link |
| `dashboard.source.linkAny` (Fase 7) | Link video | Video link |
| `dashboard.source.file` | Pilih file | Choose file |
| `dashboard.source.replace` | Ganti file | Replace file |
| `dashboard.source.srt` | .srt | .srt |
| `dashboard.source.drop` | Lepas di sini | Drop here |
| `dashboard.source.reupload` | Pilih file yang sama lagi | Choose the same file again |
| `dashboard.submit.idle` | Buat klip | Create clips |
| `dashboard.submit.uploading` | Mengunggah {percent} | Uploading {percent} |
| `dashboard.submit.checking` | Memeriksa video… | Checking video… |
| `dashboard.submit.preparing` | Menyiapkan… | Preparing… |
| `dashboard.chip.count` | `{count, plural, other {# klip}}` | `{count, plural, one {# clip} other {# clips}}` |
| `dashboard.chip.duration` | Durasi: {value} | Length: {value} |
| `dashboard.chip.layout` | Tata letak: {value} | Layout: {value} |
| `dashboard.chip.subtitle` | Subtitle: {value} | Captions: {value} |
| `dashboard.chip.hook` | Hook: {value} | Hook: {value} |
| `dashboard.chip.focus` | Arahkan | Guide |
| `dashboard.layout.auto` | Otomatis | Auto |
| `dashboard.layout.camera` | Ikuti wajah | Follow face |
| `dashboard.layout.fillCenter` | Potong tengah | Center crop |
| `dashboard.layout.fitBlur` | Latar blur | Blur fill |
| `dashboard.hook.coldOpen` | Cold open | Cold open |
| `dashboard.hook.text` | Teks hook | Hook text |
| `dashboard.recent` | Terbaru | Recent |
| `dashboard.allProjects` | Semua proyek | All projects |
| `dashboard.error.srtTooLarge` | File maks 2 MB | Max file 2 MB |
| `dashboard.ai.missing` | AI belum diatur | AI not set up |
| `dashboard.ai.setup` | Atur AI | Set up AI |
| `dashboard.ai.missingAsk` | AI belum diatur · hubungi admin | AI not set up · contact admin |
| `dashboard.cookies.needed` | YouTube minta login | YouTube asks to sign in |
| `dashboard.cookies.action` | Pasang cookies | Add cookies |

Nama tata letak tetap bersumber dari `lib/layout-names.mjs`. File itu diubah agar mengembalikan kunci (`layout.names.<mode>`) supaya editor dan dashboard memakai teks yang sama.

- **Dihapus:**
  - kalimat kepala halaman;
  - paragraf bantuan (`format-help`, `resolution-help`, `<small>` di pilihan hook);
  - field `description` di `LAYOUT_CHOICES`/`CAPTION_STYLE_CHOICES` (`lib/dashboard-choices.mjs:14-31`);
  - tiga lipatan `OPTION_SECTIONS`. `openSections` tetap dibaca lalu diabaikan, supaya `normalizeChoices` tetap kompatibel dengan `localStorage` lama;
  - aside "Hasil" (`page.jsx:882` dst.) beserta `<details>` di dalamnya.
- **Tes:**
  - unit `dashboard-view`, `dashboard-choices` (tanpa deskripsi; `openSections` diabaikan; `choicesFromJob` untuk job YouTube, job file, dan opsi lama tak dikenal → default), `clip-limits`, `subtitle-upload`, `time-ranges`, `selection-v3`, `source-language`, `look-preview` (teks contoh dioper sebagai argumen), `layout-names` (kunci), `storage-status-ui`, `focus`, `help-guide` (`LAYOUT_CHOICES` tanpa deskripsi);
  - e2e `dashboard.spec.mjs`: field di dalam Popover dibuka lewat chip sebelum `getByLabel`; Enter → `/projects/[id]`;
  - e2e `focus.spec.mjs` dan `read-only.spec.mjs`.

### 6.4 Detail proyek + penampil klip (`web/app/projects/[id]/page.jsx`, ditulis ulang)

- **Aksi utama:** saat Selesai, [Unduh semua] (ZIP, `GET /api/jobs/[id]/zip`). Saat Diproses, tidak ada lime.

```
Desktop
┌──────────────────────────────────────────────────────────────────────────┐
│ ← Proyek                                                                 │
│ Podcast ep 12                                     [Unduh semua] [⋯]      │
│ YouTube · 2 jam lalu · 8 klip · 6:40                                     │
│ ┌ Diproses · 42% ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┐ │
│ │ ✓ Unduh  ✓ Transkrip  ● Pilih momen  ○ Render                        │ │
│ │ Antre ke-2 · ± 6 mnt   3 klip siap                     [Batalkan]    │ │
│ └──────────────────────────────────────────────────────────────────────┘ │
│ [Terbaik | Urutan video]  (Semua 8)(Di luar fokus 2)            [Pilih]  │
│ [poster 9:16][poster][poster][poster][poster][poster]                    │
│ ── mode pilih: [Unduh (3)]   ← [Terbitkan (n)] menunggu batch (Q7)  ──  │
└──────────────────────────────────────────────────────────────────────────┘
Mobile (360 px)
┌──────────────────────────────┐
│ ← Proyek                 [⋯] │
│ Podcast ep 12                │
│ 8 klip · 6:40                │
│ Diproses · 42% ━━━━━━        │
│ ● Pilih momen   [Batalkan]   │
│ [Terbaik|Urutan]     [Pilih] │
│ [poster][poster]             │  ← 2 kolom
│ [ Unduh semua              ] │  ← sticky bawah saat Selesai
└──────────────────────────────┘
```

**Penampil klip** (`web/components/ClipViewer.jsx` **(baru)**): `Modal.Backdrop > Modal.Container size="lg"` (`size="full"` di bawah 768 px) `> Modal.Dialog`, dikendalikan `?klip=N` lewat `history.replaceState`. `←`/`→` memindah klip, Escape menutup, dan fokus kembali ke poster pemicu.

```
┌ Klip 2 dari 8 ─────────────────────────────────────── [‹] [›] [✕] ┐
│ ┌────────┐  Judul klip yang dibuat AI              [Salin]          │
│ │ video  │  Skor 8,4 ━━━━━━━━━━░░                                   │
│ │  9:16  │  Hook di video (Switch)                                  │
│ │        │  Caption  [Ubah] [Tulis ulang] [Salin]                   │
│ └────────┘  #tag #tag                                               │
│             12:04–12:46 · Tata letak: Ikuti wajah                   │
│             ▸ Kenapa dipilih                                        │
│             Postingan: YT · Terbit · 1,2 rb tayangan  (Fase 8–9)    │
│ [Unduh MP4]  [Edit klip]  [Terbitkan] (Fase 8)  [⋯ Unduh SRT]       │
└─────────────────────────────────────────────────────────────────────┘
```

- **Aksi utama di penampil:**
  - [Unduh MP4] adalah `primary`.
  - Sejak Fase 8, kalau pengguna punya ≥ 1 koneksi sosial aktif, `primary` pindah ke [Terbitkan], dan [Unduh MP4] menjadi `secondary`.
  - [Edit klip] = `<a href={entry.editHref}>` bergaya `buttonVariants({variant:"secondary"})`. Ini menggantikan `EditorEntry` (`page.jsx:140`). `editHref` tetap dari `lib/clip-entry-view.mjs`.
- **Komponen:**
  - `Link` (← Proyek), `PageHead`.
  - Progres: `ProgressBar` + `StageSummary` (komponen sudah ada, CSS Module) dari `lib/stage-summary.mjs`.
  - Grid dan saring: `Tabs` (Terbaik | Urutan video), `ToggleButtonGroup` (saring).
  - Mode pilih: `Button` [Pilih] mengubah grid menjadi `GridList` RAC `selectionMode="multiple"`, dengan bar aksi sticky.
  - Penampil ⋯ hanya berisi [Unduh SRT] (`downloads.srt`, sama dengan tautan hari ini `page.jsx:311`). Tidak ada "Hapus klip": belum ada API hapus klip (hapus klip turunan baru ada di editor F7, Fase 11, dok 06).
  - [Proses ulang] = `<a href="/dashboard?ulang={id}">` bergaya `buttonVariants({variant:"secondary"})` (lihat §6.3); tidak ada API rerun.
  - [Hapus proyek] memakai `DELETE /api/jobs/[id]` (sudah ada) lewat `AlertDialog`, lalu `window.location.assign('/projects')`.
  - Lainnya: `Dropdown` ⋯ (Proses ulang, Hapus proyek), `AlertDialog` batal, `Modal` penampil, `Meter` skor, `Switch` hook (`HookSwitch` diganti), `Disclosure` "Kenapa dipilih", `toast()`.
- **Data:**
  - `loadProjectDetail` (`lib/project-view.mjs:156`) + polling yang sudah ada.
  - `loadClipEntries` (`lib/clip-entry-view.mjs:147`).
  - Posisi antrean (MU-M7, Fase 6): field `queue.position`, `queue.etaSeconds`, `queue.held` di `GET /api/jobs/[id]` (dok 02 §10.3, §10.5).
  - Progres unduhan job link (Fase 7): field `fetch` di `GET /api/jobs/[id]` (dok 04 §B1, §B14); tahap "Unduh" di stepper memakai label `stage.*` (dok 07 §10.4).
  - `ClipPosts` (Fase 8): `GET /api/jobs/[id]/clips/[clipId]/posts` → `{runs, posts:[{postId, provider, url, postedAt, latest:{views,…}|null}]}` (dok 03 §9.1). Satu baris per posting: glyph platform · `StatusPill` · tayangan compact · tautan [Buka].
  - Alasan dari `reason_codes` (M5); job lama menampilkan teks lama.
- **State:**
  - **Antre:** `Antre ke-{n} · ± {eta}` dari `queue.position`/`queue.etaSeconds` (`GET /api/jobs/[id]`, dok 02 §10.3); `etaSeconds = null` → `Antre ke-{n}` saja; `position` tidak ada (sebelum Fase 6) → `Antre`. `queue.held='maintenance'` → `Antre · Pemeliharaan` (§5).
  - **Diproses:** klip muncul bertahap (`aria-live="polite"` mengumumkan "{n} klip siap").
  - **Gagal:** `Alert danger` "Proses gagal" + kode + [Bantuan] (`/bantuan#kode`) + [Proses ulang]. `job.error` mentah ada di `Disclosure` "Detail".
  - **Dibatalkan:** [Proses ulang].
  - **Selesai tanpa klip:** `EmptyState` "Tidak ada momen yang lolos" + [Proses ulang].
  - **Tile gagal:** `lib/clip-status.mjs` `failedClipView`.
  - **Proyek tidak ada atau milik orang lain:** halaman 404 yang sama (`notFound()`).
  - **Batalkan:** `AlertDialog` "Batalkan proses ini?" dengan fokus default pada [Lanjutkan proses].

| Kunci | id | en |
|---|---|---|
| `project.back` | Proyek | Projects |
| `project.downloadAll` | Unduh semua | Download all |
| `project.meta` | {source} · {when} · {clips} · {duration} | {source} · {when} · {clips} · {duration} |
| `project.progress.queuePos` | Antre ke-{n} · ± {eta} | #{n} in queue · ~{eta} |
| `project.progress.queuePosOnly` | Antre ke-{n} | #{n} in queue |
| `project.progress.ready` | `{count, plural, other {# klip siap}}` | `{count, plural, one {# clip ready} other {# clips ready}}` |
| `project.cancel` | Batalkan | Cancel |
| `project.cancel.confirm` | Batalkan proses ini? | Cancel this run? |
| `project.cancel.keep` | Lanjutkan proses | Keep running |
| `project.sort.best` | Terbaik | Best |
| `project.sort.timeline` | Urutan video | Video order |
| `project.filter.outsideFocus` | Di luar fokus | Outside focus |
| `project.select` | Pilih | Select |
| `project.bulk.download` | Unduh ({n}) | Download ({n}) |
| `project.bulk.publish` (tidak dibuat sampai batch diputuskan, Q7) | Terbitkan ({n}) | Publish ({n}) |
| `project.failed` | Proses gagal | Run failed |
| `project.rerun` | Proses ulang | Run again |
| `project.noClips` | Tidak ada momen yang lolos | No moments passed |
| `project.detail` | Detail | Details |
| `viewer.position` | Klip {n} dari {total} | Clip {n} of {total} |
| `viewer.score` | Skor | Score |
| `viewer.hookOnVideo` | Hook di video | Hook on video |
| `viewer.caption` | Caption | Caption |
| `viewer.edit` | Ubah | Edit |
| `viewer.rewrite` | Tulis ulang | Rewrite |
| `viewer.why` | Kenapa dipilih | Why chosen |
| `viewer.layout` | Tata letak: {value} | Layout: {value} |
| `viewer.downloadMp4` | Unduh MP4 | Download MP4 |
| `viewer.editClip` | Edit klip | Edit clip |
| `viewer.publish` | Terbitkan | Publish |
| `viewer.srt` | Unduh SRT | Download SRT |
| `viewer.posts` | Postingan | Posts |

- **Dihapus:**
  - `<details className={styles.notes}>` "Catatan pemilihan" (`page.jsx:608`);
  - kalimat penjelas di `components/CancelJob.jsx` (dialog);
  - panel samping detail klip (diganti Modal);
  - `.btn` di `EditorEntry`, `ClipText.jsx`, `CancelJob.jsx`;
  - copy "panel Hasil" di landing (`app/page.jsx`) beserta gambar `public/landing/editor.webp` (diganti tangkapan baru di F3).
- **Tes:**
  - unit `project-view`, `project-workspace`, `stage-summary`, `job-cancel-view`, `clip-failures`, `clip-text`, `clip-hook`, `jobs`, `entry-pages`, `status-view.test.mjs` **(baru)**;
  - `ui-foundation`: `editorHref` → `<a>`;
  - e2e `project-workspace.spec` (Modal `?klip=N`, `←/→`, fokus kembali), `cancel-job.spec`, `clip-text.spec`, `clip-hook.spec`, `editor-flow.spec` (Edit klip memuat dokumen penuh: `crossOriginIsolated === true`), `editor-clip-nav.spec`, `history-clips.spec` (grid → `?klip=N`).

### 6.5 Drawer Terbitkan / Jadwalkan (`web/components/PublishDrawer.jsx`, baru, Fase 8)

Satu komponen yang dipakai di penampil klip, bar pilih proyek (setelah batch diputuskan), `/sosial` (ubah jadwal), dan editor sejak Fase 11 (X3). Komponen ini tidak dirender kalau `features.social` = false. Kontrak data **milik** [03-sosmed-performa.md](03-sosmed-performa.md) §5, §6, §8, §9.1; dokumen ini hanya menetapkan UI di atasnya.

**Props:** `{jobId, clipId, renderId?, run?, onRequestExport?}`. `run` = mode ubah jadwal dari `/sosial`. `onRequestExport()` (opsional, diisi editor, 06 §11.10) mengembalikan `Promise<renderId>` dan **menggantikan** jalur ekspor bawaan saat API menjawab `social_media_unavailable` + `params.needsExport` (03 §6.7 butir 3); tanpa prop ini drawer memakai jalur bawaan.

- **Aksi utama:** [Terbitkan], yang berubah menjadi [Jadwalkan] kalau switch Jadwalkan menyala.

```
Desktop (Drawer kanan, 440 px)                    Mobile (Drawer bawah, tinggi penuh)
┌ Terbitkan klip 2 ──────────────────── [✕] ┐     ┌ Terbitkan klip 2        [✕] ┐
│ Akun   [☑ ▶ @kanal] [☐ ♪ @akun]           │     │ Akun [☑ ▶ @kanal]           │
│ File   [Ekspor terbaru · 1080p        ▾]  │     │      [☐ ♪ @akun]            │
│ Judul  [                         ] 0/100  │     │ File [Ekspor terbaru     ▾] │
│ Caption[                         ]        │     │ Judul [                    ]│
│ Hashtag[#tag ✕][#tag ✕] [ketik+Enter]     │     │ Caption [                  ]│
│ ▶ YouTube                                 │     │ Hashtag [#tag ✕][        ]  │
│   Visibilitas (•) Publik ( ) Tidak publik │     │ ▶ YouTube                   │
│               ( ) Privat                  │     │  Visibilitas [Publik     ▾] │
│   Untuk anak (Switch)                     │     │  Untuk anak (Switch)        │
│ ♪ TikTok · @nama_kreator                  │     │ ♪ TikTok · @nama_kreator    │
│   Privasi [Pilih…               ▾]        │     │  Privasi [Pilih…        ▾]  │
│   ▸ Lanjutan · Komentar · Duet · Stitch   │     │  ▸ Lanjutan · Komentar …    │
│   Konten komersial (Switch)               │     │  Konten komersial (Switch)  │
│   ☐ Persetujuan musik TikTok [kebijakan]  │     │  ☐ Persetujuan musik        │
│ Jadwalkan (Switch)                        │     │ Jadwalkan (Switch)          │
│          [24/10/2026 19:00  WIB]          │     │ [24/10/2026 19:00 WIB]      │
│                  [Batal] [ Terbitkan ]    │     │ [Batal]  [ Terbitkan ]      │
└───────────────────────────────────────────┘     └─────────────────────────────┘
```

- **Komponen:** `Drawer` (`Drawer.Content placement="right"`, di bawah 768 px `placement="bottom"`), `Form`, `CheckboxGroup` akun (1–3 koneksi aktif, glyph platform; dok 03 §9.1 `targets` 1–3), `Select` file, `TextField` judul (penghitung `{n}/{max}` dari `PublishLimits.captionMax`/batas judul; disembunyikan kalau tidak ada target dengan `allowsTitle`), `TextArea` caption, `TextField` + `TagGroup` hashtag (Enter atau koma menambah tag), satu bagian per target: YouTube = `RadioGroup` visibilitas (`public|unlisted|private`; di bawah 768 px `Select`) + `Switch` "Untuk anak" (`madeForKids`, wajib boolean, default mati); TikTok = nama kreator (`creatorNickname`), `Select` privasi dari `privacyOptions` **tanpa nilai default**, `Disclosure` "Lanjutan" (Switch Komentar/Duet/Stitch; disabled bila kreator mematikannya), `Switch` "Konten komersial" + `RadioGroup` "Merek sendiri"/"Konten bermerek", `Checkbox` persetujuan musik (teks `social.tiktok.consent`, kutipan wajib platform, dok 03 §5.3); Instagram = tanpa judul dan tanpa privasi. Lalu `Switch` Jadwalkan + `DatePicker`/`TimeField` dengan `ZonedDateTime` (`granularity="minute"`, `hourCycle={24}`, nama zona pendek ditampilkan, lazy-load; aturan DST dan penyimpanan `scheduled_at` UTC + `scheduled_tz`: dok 07 §13.4), `Button isPending`.
- **Isi awal** (saat drawer dibuka):
  1. `GET /api/social/connections` → daftar akun; yang tercentang = koneksi terakhir yang dipakai (disimpan per perangkat di `localStorage` `potongin.publish.lastConnection`, dibaca dengan try/catch).
  2. Untuk setiap akun tercentang: `GET /api/social/connections/[connectionId]/limits` → `PublishLimits` + `creatorNickname?` (dibatasi cache 60 dtk di server).
  3. `GET /api/jobs/[id]/clips/[clipId]/renders` (sudah ada, `lib/clip-renders.mjs`) → opsi File = ekspor `completed`, terbaru di atas (Q7 default). Media **selalu ekspor** (dok 03 §6.7; tidak ada media `auto`). Tanpa ekspor selesai → `Select` File diganti teks `publish.file.exportFirst`; saat submit server menjawab 409 `social_media_unavailable` `params.needsExport=true`, lalu drawer mengekspor sendiri (`GET …/edit` ETag → `POST …/renders {editEtag}`), menampilkan `publish.exporting`, dan mengulang submit dengan `Idempotency-Key` yang sama setelah render `completed` (alur persis di dok 03 §6.7 langkah 3).
  4. Judul/caption/hashtag diisi dari data klip yang sudah ada di halaman (`servedClipText(job, clip)`, dok 03/roadmap §2.2-H). Field yang tidak diubah pengguna **tidak dikirim**, sehingga server memakai `composePostText`.
  5. `Idempotency-Key` = `crypto.randomUUID()` dibuat sekali saat drawer dibuka dan dipakai untuk semua percobaan submit (dok 03 §6.6).
- **Validasi klien** (murni, `web/lib/publish-drawer-view.mjs` **(baru)**): panjang teks per `PublishLimits`, ≥ 1 target, TikTok wajib privasi + persetujuan, jadwal ≥ sekarang + 2 menit dan ≤ 90 hari, hint `publish.hint.notShorts` kalau durasi klip > 180 dtk dan ada target YouTube. Server tetap memvalidasi ulang (`provider.validate`).
- **Batch** (bar pilih proyek, n > 1): ditunda (Q7: batch belakangan). Tombol [Terbitkan (n)] di bar pilih **tidak** dirender sampai batch diputuskan.
- **Kontrak yang dipakai UI** (salinan ringkas dok 03 §9.1; kalau berbeda, dok 03 menang):

| Method + path | Auth | Request | Respons sukses | Error yang ditangani UI |
|---|---|---|---|---|
| `GET /api/social/connections` | sesi | — | `200 {connections:[{id, provider, handle, displayName, avatarUrl, status:'active'\|'reauth_required', scheduledCount, connectedAt}]}` | 404 (flag mati/peran) → drawer tidak dirender |
| `GET /api/social/connections/[connectionId]/limits` | sesi | — | `200 PublishLimits + {creatorNickname?}` | 409 `social_reauth_required` → akun diberi akhiran "· hubungkan ulang" dan dicentang-lepas; 503 `social_platform_unavailable` → `Alert` di bagian target itu + [Coba lagi] |
| `GET /api/jobs/[id]/clips/[clipId]/renders` | sesi, pemilik job | — | `200 {renders:[…renderDtoV3]}` | 404 |
| `POST /api/social/posts` | sesi, `sameOriginMutation`, JSON ≤ 64 KiB, header `Idempotency-Key` | `{jobId, clipId, media?:{kind:'export', renderId}, text?:{title?,caption?,hashtags?}, when:{mode:'now'}\|{mode:'at', at:ISO-UTC, tz:IANA}, targets:[{connectionId, options, text?}]}` (`media` tidak dikirim = ekspor `completed` terbaru) | `201 {groupId, runs:[Run]}` / `200` (ulang idempoten) | 409 `social_reauth_required`, `social_media_unavailable` (`params.needsExport` → ekspor otomatis, lihat Isi awal 3), `social_idempotency_conflict`; 422 `social_text_invalid` (`params.field`, `params.max` → error di field itu), `social_duration_exceeded`, `social_privacy_unavailable`, `social_schedule_invalid`, `social_time_nonexistent` (celah DST; kunci `errors.social.social_time_nonexistent`, dok 03 §8, dok 07 §13.4); 429 `social_cap_scheduled`, `social_cap_hourly`, `social_quota_exhausted` (`params.resetAt`), `social_rate_limited`; 400 `errors.web.invalid_request` |
| `GET /api/social/posts/[runId]` | sesi | — | `200 Run` | 404 |
| `PATCH /api/social/posts/[runId]` (ubah jadwal dari `/sosial`) | sesi, same-origin | `{scheduledAt?, scheduleTz?, text?, options?}` (hanya `state='scheduled'`) | `200 Run` | 409 `social_not_cancellable`, 422 |

Semua error dirender `errorText(t, err)` = `errors.social.<code>` (dok i18n §10); error per field memakai `aria-describedby`, error umum memakai `Alert status="danger" role="alert"` di atas footer drawer. Drawer **tidak** tertutup saat error.

- **Setelah submit sukses:**
  1. Drawer tertutup; fokus kembali ke tombol pemicu.
  2. Untuk `when.mode='now'`: satu `toast()` per run "Mengunggah ke {platform}…"; klien mem-poll `GET /api/social/posts/[runId]` setiap 5 dtk (berhenti saat state terminal, tab tersembunyi, atau 10 menit). `published` → "Terbit di {platform}" + [Buka] (`run.post.url`); `failed`/`maybe_sent` → "Gagal di {platform}" + [Detail] → `/sosial?status=gagal`; `hold='reauth'` → "Akun perlu dihubungkan ulang" + [Hubungkan] → `/sosial?tab=akun`.
  3. Untuk jadwal: toast "Terjadwal · {when}" + [Lihat jadwal] → `/sosial`.
- **State:**
  - **Memuat** (koneksi/limits/renders): `Skeleton` per bagian; tombol utama `isDisabled` sampai limits semua target terbaca.
  - **Belum ada akun aktif:** isi drawer diganti `EmptyState` "Belum ada akun sosial" + [Hubungkan akun] → `/sosial?tab=akun`.
  - **Akun `reauth_required`:** checkbox diberi akhiran "· hubungkan ulang" dan `isDisabled`.
  - **Mode `admin`** (`POTONGIN_SOCIAL=admin`): baris info "Unggahan privat sampai audit"; visibilitas YouTube dikunci Privat, TikTok hanya `SELF_ONLY` (opsi lain disembunyikan).
  - **Gagal memuat koneksi:** `LoadError` di dalam drawer.

| Kunci | id | en |
|---|---|---|
| `publish.title` | Terbitkan klip {n} | Publish clip {n} |
| `publish.account` | Akun | Accounts |
| `publish.file` | File | File |
| `publish.file.latest` | Ekspor terbaru · {resolution} | Latest export · {resolution} |
| `publish.file.export` | Ekspor {when} · {resolution} | Export {when} · {resolution} |
| `publish.file.exportFirst` | Diekspor saat terbit | Exported on publish |
| `publish.exporting` | Mengekspor… | Exporting… |
| `publish.postTitle` | Judul | Title |
| `publish.counter` | {count}/{max} | {count}/{max} |
| `publish.caption` | Caption | Caption |
| `publish.hashtags` | Hashtag | Hashtags |
| `publish.hashtags.add` | Ketik lalu Enter | Type, then Enter |
| `publish.visibility` | Visibilitas | Visibility |
| `publish.visibility.public` | Publik | Public |
| `publish.visibility.unlisted` | Tidak publik | Unlisted |
| `publish.visibility.private` | Privat | Private |
| `publish.madeForKids` | Untuk anak | Made for kids |
| `publish.tiktok.privacy` | Privasi | Privacy |
| `publish.tiktok.privacyPick` | Pilih… | Choose… |
| `publish.tiktok.comments` | Komentar | Comments |
| `publish.tiktok.duet` | Duet | Duet |
| `publish.tiktok.stitch` | Stitch | Stitch |
| `publish.tiktok.commercial` | Konten komersial | Commercial content |
| `publish.tiktok.brandOwn` | Merek sendiri | Your brand |
| `publish.tiktok.brandPaid` | Konten bermerek | Branded content |
| `social.tiktok.consent` | (kutipan wajib TikTok, diisi dari SOS-M0) | (TikTok's required wording) |
| `publish.hint.notShorts` | Lebih dari 3 menit · bukan Shorts | Over 3 minutes · not a Short |
| `publish.schedule` | Jadwalkan | Schedule |
| `publish.submit.now` | Terbitkan | Publish |
| `publish.submit.schedule` | Jadwalkan | Schedule |
| `publish.privateUntilAudit` | Unggahan privat sampai audit | Uploads stay private until review |
| `publish.noAccount` | Belum ada akun sosial | No social accounts |
| `publish.connect` | Hubungkan akun | Connect account |
| `publish.reconnectSuffix` | · hubungkan ulang | · reconnect |
| `publish.toast.uploading` | Mengunggah ke {platform}… | Uploading to {platform}… |
| `publish.toast.published` | Terbit di {platform} | Published on {platform} |
| `publish.toast.failed` | Gagal di {platform} | Failed on {platform} |
| `publish.toast.scheduled` | Terjadwal · {when} | Scheduled · {when} |
| `publish.toast.reauth` | Akun perlu dihubungkan ulang | Account needs reconnecting |
| `publish.toast.open` | Buka | Open |
| `publish.toast.viewSchedule` | Lihat jadwal | View schedule |

- **Tes:**
  - `tests/publish-drawer-view.test.mjs` **(baru)**: isi awal (render terbaru completed; tanpa ekspor → `exportFirst`, 409 `needsExport` → ekspor lalu submit ulang dengan key sama), field yang tidak diubah tidak dikirim, aturan per platform (TikTok tanpa default privasi, consent wajib, IG tanpa judul), validasi panjang dari `PublishLimits`, batas jadwal (+2 menit, 90 hari), konversi `ZonedDateTime` → `{at: ISO UTC, tz}`, mode `admin` mengunci privasi, pemetaan kode error → field.
  - e2e: kasus UI ditambahkan ke `web/e2e/social-publish.spec.mjs` **(baru, milik dok 03)**, bukan file e2e terpisah: dua locale, fake platform lewat `SOCIAL_FAKE_ORIGIN` (`web/tests/support/fake-social-platform.mjs`), `Idempotency-Key` sama pada submit ulang, jadwal dibuat di `en` zona X tampil benar di `id` zona Y, error 429 kuota tampil di drawer tanpa menutupnya, tanpa hydration warning di console.

### 6.6 Sosial (`/sosial`, `web/app/sosial/page.jsx`, baru, Fase 8)

- **Aksi utama:** tab Jadwal tidak punya lime; tab Akun punya [Hubungkan akun].

```
Desktop
┌──────────────────────────────────────────────────────────────────────┐
│ Sosial                                                               │
│ [Jadwal | Akun]                                                      │
│ (Semua 18)(Terjadwal 5)(Terbit 12)(Gagal 1)                          │
│ Hari ini                                                             │
│  19:00  ▶ Judul klip      @kanal · 3 jam lagi     Terjadwal     ⋯    │
│  21:00  ♪ Judul klip      @akun                   Terjadwal     ⋯    │
│ Besok                                                                │
│  09:00  ▶ Judul klip      @kanal                  Gagal         ⋯    │
└──────────────────────────────────────────────────────────────────────┘
Tab Akun
│ (AS) ▶ @kanal       Terhubung            [Hubungkan ulang] [Putuskan]│
│ (BK) ♪ @akun        Perlu dihubungkan    [Hubungkan ulang] [Putuskan]│
│                                               [ Hubungkan akun ▾ ]   │
Mobile (360 px)
┌──────────────────────────────┐
│ Sosial                       │
│ [Jadwal | Akun]              │
│ (Terjadwal 5)(Terbit 12) →   │  ← ToggleButtonGroup gulir horizontal
│ Hari ini                     │
│ 19:00 ▶ Judul klip…       ⋯  │
│   @kanal · Terjadwal         │
└──────────────────────────────┘
```

- **Komponen:** `Tabs` (sinkron `?tab=`), `ToggleButtonGroup` saring status (sinkron `?status=`; hitungan dari `counts`), daftar dikelompokkan per hari di zona pengguna (`<section>` + `<h2>` per hari, `Separator`; bila `run.scheduleTz` ≠ zona penonton, waktu asal tampil sebagai teks sekunder `social.schedule.originalTime`, dok 07 §13.4), `StatusPill`, `Dropdown` per baris (`aria-label` = `aria.moreActions`), `Avatar`, `Dropdown` [Hubungkan akun ▾] (YouTube, TikTok, Instagram; hanya provider yang `configured`), `AlertDialog` putuskan/batalkan, `Modal` "Sudah terbit" (`TextField type="url"`), `Table.LoadMore`/[Muat lagi] untuk `nextCursor`.
- **Aksi baris** (sesuai `state`, dok 03 §6.1):

| State | Aksi | Panggilan |
|---|---|---|
| `scheduled` | Ubah jadwal (buka `PublishDrawer` mode ubah), Batalkan (`AlertDialog`) | `PATCH /api/social/posts/[runId]`; `POST /api/social/posts/[runId]/cancel` |
| `claimed`, `uploading` | Batalkan (best effort) | `POST …/cancel` |
| `processing` | — (hanya Buka proyek) | — |
| `published` | Buka di platform (`<a href={run.post.url} target="_blank" rel="noopener">`), Buka proyek | — |
| `failed` | Coba lagi | `POST /api/social/posts/[runId]/retry` + header `Idempotency-Key` (baru per klik) |
| `maybe_sent` | Sudah terbit (isi URL) / Unggah ulang | `POST …/mark-published {url}` (422 `social_url_invalid` → error di field); `POST …/retry` |
| `cancelled` | Buka proyek | — |

"Buka proyek" = `<a href="/projects/{jobId}?klip={n}">` bila nomor klip diketahui, selain itu `/projects/{jobId}`.

- **Data** (salinan ringkas dok 03 §9.1; dok 03 menang):

| Method + path | Request | Respons | Error yang ditangani UI |
|---|---|---|---|
| `GET /api/social/posts` | `state?` (csv), `from?`, `to?` (ISO), `jobId?`, `cursor?`, `limit` (UI mengirim 50; maks 100) | `200 {runs:[Run], counts:{scheduled, published, failed}, nextCursor}` | 404 (flag) → halaman `notFound()` di server; 400 |
| `PATCH /api/social/posts/[runId]` | `{scheduledAt, scheduleTz}` (hanya `state='scheduled'`) | `200 Run` | 404; 409 `social_not_cancellable`; 422 `social_schedule_invalid`; 429 `social_cap_hourly` (cap dicek ulang saat PATCH, dok 03 §10.1) |
| `POST /api/social/posts/[runId]/cancel` | — | `200 Run` | 404; 409 `social_not_cancellable` → toast + muat ulang baris |
| `POST /api/social/posts/[runId]/retry` | `{}` + `Idempotency-Key` (hanya `failed`/`maybe_sent`) | `201 Run` (run baru) | 404; 409 (mis. `social_media_unavailable`) |
| `POST /api/social/posts/[runId]/mark-published` | `{url}` (hanya `maybe_sent`) | `200 Run` | 404; 409; 422 `social_url_invalid` |
| `GET /api/social/connections` | — | `{connections:[…]}` (§6.5) | — |
| `POST /api/social/connect/[provider]` | **form native** (`method="post"`, field tersembunyi `reconnectId` untuk Hubungkan ulang) | `303` ke halaman izin platform | 404 (flag/peran); error lain (`social_provider_unconfigured`, batas `oauth_pending`) → `303 /sosial?tab=akun&hasil=gagal` (dok 03 §7.1); `social_connection_limit` (> 3 per provider) muncul di callback sebagai `?hasil=gagal` |
| `DELETE /api/social/connections/[connectionId]` | — | `200 {cancelledRuns}` | 404 |
| `GET /api/social/providers` | — | `{providers:[{id, configured, audited, limitsStatic}]}` | — |

Item `Dropdown` "Hubungkan akun ▸ YouTube" memanggil `requestSubmit()` pada form tersembunyi per provider (pola sama dengan logout, §4.2), sehingga tidak ada `fetch` + `window.location.assign`.

- **Kembali dari OAuth** (`GET /api/social/callback/[provider]` → `303 /sosial?tab=akun&hasil=…`): `terhubung` → toast "Akun terhubung"; `ditolak` → "Izin ditolak"; `gagal` → "Gagal menghubungkan" [Coba lagi]. Setelah toast tampil, parameter `hasil` dihapus lewat `history.replaceState`.
- **State:**
  - Memuat: 5 baris `Skeleton`.
  - Jadwal kosong: `EmptyState` "Belum ada jadwal" + [Buka proyek] (→ `/projects`).
  - Saring kosong: "Tidak ditemukan".
  - Akun kosong: `EmptyState` "Belum ada akun" + [Hubungkan akun].
  - Gagal memuat: `LoadError`.
  - Provider belum diatur: member tidak melihatnya di menu. Admin melihat baris "Belum diatur di server" + tautan `/settings#sistem` (`SocialAppsCard`).
  - Putuskan: `AlertDialog` `social.disconnect.confirm` dengan `count = connection.scheduledCount`.

| Kunci | id | en |
|---|---|---|
| `social.title` | Sosial | Social |
| `social.tab.schedule` | Jadwal | Schedule |
| `social.tab.accounts` | Akun | Accounts |
| `social.today` | Hari ini | Today |
| `social.tomorrow` | Besok | Tomorrow |
| `social.inTime` | {relative} | {relative} |
| `social.schedule.originalTime` | {time} ({zone}) | {time} ({zone}) |
| `social.action.reschedule` | Ubah jadwal | Reschedule |
| `social.action.cancel` | Batalkan | Cancel |
| `social.action.retry` | Coba lagi | Retry |
| `social.action.openPlatform` | Buka di platform | Open on platform |
| `social.action.openProject` | Buka proyek | Open project |
| `social.action.markPublished` | Sudah terbit | Already published |
| `social.action.reupload` | Unggah ulang | Upload again |
| `social.markPublished.url` | Tautan postingan | Post link |
| `social.cancel.confirm` | Batalkan postingan ini? | Cancel this post? |
| `social.filter.all` | Semua {count} | All {count} |
| `social.filter.scheduled` | Terjadwal {count} | Scheduled {count} |
| `social.filter.published` | Terbit {count} | Published {count} |
| `social.filter.failed` | Gagal {count} | Failed {count} |
| `social.filter.cancelled` | Dibatalkan | Cancelled |
| `social.connect` | Hubungkan akun | Connect account |
| `social.reconnect` | Hubungkan ulang | Reconnect |
| `social.disconnect` | Putuskan | Disconnect |
| `social.disconnect.confirm` | Putuskan {handle}? {count} jadwal dibatalkan. | Disconnect {handle}? {count} scheduled posts cancelled. |
| `social.account.active` | Terhubung | Connected |
| `social.account.reauth` | Perlu dihubungkan | Needs reconnecting |
| `social.result.connected` | Akun terhubung | Account connected |
| `social.result.denied` | Izin ditolak | Permission denied |
| `social.result.failed` | Gagal menghubungkan | Couldn't connect |
| `social.empty.schedule` | Belum ada jadwal | Nothing scheduled |
| `social.empty.accounts` | Belum ada akun | No accounts |
| `social.openProjects` | Buka proyek | Open projects |
| `social.notConfigured` | Belum diatur di server | Not set up on server |

- **Tes:** `tests/social-view.test.mjs` **(baru)** untuk pengelompokan per hari di zona pengguna (termasuk DST), aksi per `state` (tabel di atas, termasuk `maybe_sent`), dan `?hasil=` → kunci toast; e2e `social.spec.mjs` **(baru)**: hubungkan lewat fake platform (form native, tanpa JS juga jalan), batalkan, coba lagi, sudah terbit dengan URL salah → error field; drill `POTONGIN_SOCIAL=off` (nav hilang, `/sosial` 404, data tetap).

### 6.7 Analitik (`/analitik`, `web/app/analitik/page.jsx`, baru, Fase 9)

- **Aksi utama:** tidak ada lime (halaman baca). Aksi sekunder: [Impor CSV] dan Switch "Pakai di pemilihan klip" (Q11: default mati).

```
Desktop
┌──────────────────────────────────────────────────────────────────────┐
│ Analitik                    [7 hari | 30 hari | 90 hari] [Impor CSV] │
│ [Klip terbit 24] [Tayangan 18,2 rb] [Suka 1,1 rb] [Komentar 96]      │
│ Tayangan per hari                                                    │
│ ▁▂▃▅▃▂▆▇▅▃▂▃▅▆                                                       │
│ Umpan balik: 24 klip   Pakai di pemilihan klip (Switch)              │
│ Klip teratas                              [Platform: Semua ▾]        │
│  Judul klip   ▶   1,2 rb   1,4× biasanya   Proyek →                  │
└──────────────────────────────────────────────────────────────────────┘
Mobile (360 px)
┌──────────────────────────────┐
│ Analitik           [Impor ⋯] │
│ [7|30|90 hari]               │
│ [Terbit 24][Tayangan 18,2 rb]│  ← tile 2×2
│ [Suka 1,1 rb][Komentar 96]   │
│ ▁▂▃▅▃▂▆▇ (lebar penuh)       │
│ Klip teratas                 │
│ Judul klip · 1,2 rb   →      │
└──────────────────────────────┘
```

- **Komponen:** `ToggleButtonGroup` rentang (sinkron `?rentang=7|30|90`, dikirim ke API sebagai `range=7d|30d|90d`), `Card` tile (angka `useFormatter().number(v,{notation:"compact"})`; `null` → "—"), chart SVG buatan sendiri (`web/components/analytics/DailyChart.jsx` + CSS Module, mengikuti skill dataviz). Chart diberi `<figure>` + `<figcaption>` berisi `daily.text` dari API (ringkasan untuk pembaca layar) dan tabel tersembunyi `.visuallyHidden`. Komponen lain: `Switch` "Pakai di pemilihan klip" (hanya dirender bila `features.performance`; `isDisabled` bila `ProfileStatus.state='collecting'`), `Select` platform, `Table` klip teratas, `Modal` impor CSV (hanya `features.performance`): `FileTrigger` (RAC) → pratinjau baris (`matched|unmatched|invalid|skipped`) → baris tidak cocok bisa dilewati → [Simpan] = commit; [Template CSV] mengunduh `resources/performance/template.csv` (format dok 03 §14.1; lewat `GET /api/performance/template.csv`, dok 03 §9.3). Baris bermasalah menampilkan kode baris dok 03 §14.4 lewat `errors.performance.<code>`.
- **Data** (salinan ringkas dok 03 §9.2–§9.3; dok 03 menang):

| Method + path | Request | Respons | Error yang ditangani UI |
|---|---|---|---|
| `GET /api/analytics/summary` | `range=7d\|30d\|90d`, `provider?` | `{range, posts, views, likes, comments, shares, collapsedPosts, updatedAt}` | 404 (kedua flag mati) → halaman `notFound()` |
| `GET /api/analytics/daily` | `range`, `provider?`, `tz` (IANA; UI mengirim zona efektif pengguna) | `{days:[{date, views}], text}` | — |
| `GET /api/analytics/top` | `range`, `provider?`, `sort=views` (API juga menerima `likes\|ratio`), `limit=20` (maks 50) | `{rows:[{postId, provider, url, clipTitle, jobId, clipId, postedAt, views, likes, comments, shares, ratio, n}]}` | — |
| `GET /api/analytics/feedback` | — | `ProfileStatus {state:'off'\|'collecting'\|'ready'\|'stale', useInSelection, posts, needed, horizon, excluded, top, updatedAt}` (dok 03 §13.6) | — |
| `PUT /api/settings/performance` | `{useInSelection:boolean}` | `{useInSelection, status: ProfileStatus}` | 422 → Switch kembali + toast |
| `POST /api/performance/import` | multipart `file` (≤ 2 MiB) | `201 ImportPreview` | 413 `performance_import_too_large`, 422 `performance_import_invalid`, `performance_import_unknown_columns` |
| `PATCH /api/performance/import/[importId]/rows/[rowNo]` | `{skip:true}` atau `{jobId, clipId}` | baris | 422 |
| `POST /api/performance/import/[importId]/commit` | — | `{snapshots, postsCreated, skipped}` → toast | 409 `performance_import_state` |
| `DELETE /api/performance/import/[importId]` | — | 204 (Batal di modal) | — |

- **Baris "Umpan balik"** (dari `ProfileStatus`): `off` → baris tidak dirender; `collecting` → `Umpan balik: {posts}/{needed} klip` + Switch disabled; `ready`/`stale` → `Umpan balik: {posts} klip` + Switch aktif.
- **State:**
  - Memuat: 4 tile `Skeleton` + chart `Skeleton`.
  - Belum ada klip terbit (`summary.posts = 0`): `EmptyState` "Belum ada klip terbit" + [Buka Sosial] (hanya bila `features.social`; selain itu + [Impor CSV]).
  - `days` kosong atau semua 0: chart diganti teks "Data belum cukup".
  - Gagal: `LoadError` per bagian (tile, chart, tabel).
- **Privasi** (Q11 default): hanya data milik pengguna sendiri; admin tidak melihat data orang lain.

| Kunci | id | en |
|---|---|---|
| `analytics.title` | Analitik | Analytics |
| `analytics.range` | {days} hari | {days} days |
| `analytics.import` | Impor CSV | Import CSV |
| `analytics.tile.published` | Klip terbit | Clips published |
| `analytics.tile.views` | Tayangan | Views |
| `analytics.tile.likes` | Suka | Likes |
| `analytics.tile.comments` | Komentar | Comments |
| `analytics.chart.daily` | Tayangan per hari | Views per day |
| `analytics.chart.summary` | {total} tayangan, puncak {peak} pada {date} | {total} views, peak {peak} on {date} |
| `analytics.feedback` | Umpan balik: {count} klip | Feedback: {count} clips |
| `analytics.feedbackCollecting` | Umpan balik: {count}/{needed} klip | Feedback: {count}/{needed} clips |
| `analytics.useInSelection` | Pakai di pemilihan klip | Use in clip picking |
| `analytics.top` | Klip teratas | Top clips |
| `analytics.ratio` | {ratio}× biasanya | {ratio}× typical |
| `analytics.platform` | Platform | Platform |
| `analytics.empty` | Belum ada klip terbit | No published clips |
| `analytics.openSocial` | Buka Sosial | Open Social |
| `analytics.notEnough` | Data belum cukup | Not enough data |
| `analytics.import.matched` | Cocok | Matched |
| `analytics.import.unmatched` | Tidak cocok | Not matched |
| `analytics.import.invalid` | Tidak valid | Invalid |
| `analytics.import.skip` | Lewati | Skip |
| `analytics.import.template` | Template CSV | CSV template |
| `analytics.import.done` | {count} data disimpan | {count} rows saved |

- **Tes:** `tests/analytics-view.test.mjs` **(baru)** untuk format compact per locale (`null` → "—"), pemetaan `?rentang=` → `range`, baris Umpan balik per `ProfileStatus.state`, dan chart kosong; e2e `analytics.spec.mjs` **(baru)**: impor CSV (pratinjau → lewati baris → simpan), Switch disabled saat `collecting`, `POTONGIN_PERFORMANCE=off` + `POTONGIN_SOCIAL=off` → nav hilang dan `/analitik` 404.

### 6.8 Proyek (`/projects`, `web/app/projects/page.jsx`, ditulis ulang, Fase 3)

- **Aksi utama:** tidak ada lime. Di layar < 1024 px ada [Buat klip] `secondary` di kepala halaman. Tombol "Buat klip baru" `btn primary` (`page.jsx:198`) dihapus.

```
Desktop                                                           
┌──────────────────────────────────────────────────────────────────┐
│ Proyek                                               [🔍 Cari  ] │
│ [Proyek | Klip]                                                  │
│ (Semua 12)(Diproses 2)(Selesai 9)(Gagal 1)                       │
│ ☐ │ ▮ │ Judul video          │ Selesai  │ 8 klip │ 2 jam lalu │ ⋯ │
│ ☐ │ ▮ │ Podcast ep 11        │ Diproses │ —      │ 5 mnt lalu │ ⋯ │
│ ── 2 dipilih: [Hapus (2)] ──                                      │
│                         [Muat lagi]                               │
└──────────────────────────────────────────────────────────────────┘
Mobile (360 px)
┌──────────────────────────────┐
│ Proyek          [Buat klip]  │
│ [🔍 Cari                   ] │
│ [Proyek | Klip]              │
│ (Semua 12)(Diproses 2) →     │
│ ▮ Judul video             ⋯  │  ← daftar kartu, bukan tabel
│   Selesai · 8 klip · 2 jam   │
└──────────────────────────────┘
```

- **Komponen:**
  - Pencarian dan tab: `SearchField` (`/` fokus ke sini), `Tabs` (sinkron `?tab=`), `ToggleButtonGroup` saring dengan hitungan (sinkron `?status=`).
  - Tabel (≥ 768 px): `Table.ScrollContainer > Table.Content selectionMode="multiple"` + `Table.LoadMore`. Di bawah 768 px tabel diganti daftar kartu (`GridList` RAC, `selectionMode="multiple"` setelah [Pilih]).
  - Lainnya: `StatusPill`, `Dropdown` ⋯ (Buka · Edit klip · Hapus), `AlertDialog`, `toast()`.
  - Item "Edit klip" = `Dropdown.Item href={editorHref(...)}`, yang merender `<a>` (tanpa RouterProvider). Item ini hanya muncul kalau `historyOffersEdit(job, editor)` (`lib/clip-entry-view.mjs:130`) bernilai true.
- **Tab Klip:** grid `ClipPoster` dari `GET /api/clips` (sudah ada, `lib/clip-library.mjs`), dengan saring "Skor 8+" dan "Minggu ini" serta [Muat lagi]. Klik poster → `/projects/[id]?klip=N`.
- **Data:** `GET /api/jobs` dan `DELETE /api/jobs/[id]` (sudah ada; batch = n panggilan paralel, maksimal 4 sekaligus). Refresh otomatis saat tab browser kembali fokus (`visibilitychange`), sehingga tombol Muat ulang dihapus.
- **State:**
  - Memuat: 6 baris `Skeleton`.
  - Kosong: `EmptyState` "Belum ada proyek" + [Buat klip].
  - Saring kosong: "Tidak ditemukan".
  - Gagal: `LoadError`.
  - Hapus sebagian gagal: toast "1 dihapus, 1 gagal".

| Kunci | id | en |
|---|---|---|
| `projects.title` | Proyek | Projects |
| `projects.tab.projects` | Proyek | Projects |
| `projects.tab.clips` | Klip | Clips |
| `projects.filter.all` | Semua {count} | All {count} |
| `projects.filter.running` | Diproses {count} | Processing {count} |
| `projects.filter.done` | Selesai {count} | Done {count} |
| `projects.filter.failed` | Gagal {count} | Failed {count} |
| `projects.col.title` | Judul | Title |
| `projects.col.status` | Status | Status |
| `projects.col.clips` | Klip | Clips |
| `projects.col.created` | Dibuat | Created |
| `projects.action.open` | Buka | Open |
| `projects.action.edit` | Edit klip | Edit clip |
| `projects.delete.confirm` | `{count, plural, other {Hapus # proyek?}}` | `{count, plural, one {Delete # project?} other {Delete # projects?}}` |
| `projects.delete.done` | {count} dihapus | {count} deleted |
| `projects.delete.partial` | {ok} dihapus, {failed} gagal | {ok} deleted, {failed} failed |
| `projects.empty` | Belum ada proyek | No projects yet |
| `projects.loadMore` | Muat lagi | Load more |
| `projects.clips.score8` | Skor 8+ | Score 8+ |
| `projects.clips.thisWeek` | Minggu ini | This week |

- **Dihapus:** judul ganda/kalimat kepala halaman, tombol Muat ulang, label "Riwayat", dan `.btn primary` di kepala halaman.
- **Tes:** unit `clip-library-view`, `clip-library`, `job-deletion`, `project-view` (filter dengan kunci); e2e `history-clips.spec`, `smoke.spec`, plus `projects.spec.mjs` **(baru)** untuk batch hapus dengan `AlertDialog` dan toast sebagian.

### 6.9 Tren (`/trends`, `web/app/trends/page.jsx`, ditulis ulang, Fase 3)

- **Aksi utama:** [Tambah tren].

```
Desktop
┌──────────────────────────────────────────────────────────────────────┐
│ Tren          Pakai di pemilihan klip (Switch)        [Tambah tren]  │
│ 12 aktif · 3 nonaktif · 2 kedaluwarsa                                │
│ [Daftar | Agen]                         ← Agen hanya admin           │
│ [🔍 Cari      ] [Jenis ▾] [Status ▾]                                 │
│ #topik   Topik    Aktif     s.d. 30 Okt                         ⋯    │
└──────────────────────────────────────────────────────────────────────┘
Mobile
┌──────────────────────────────┐
│ Tren            [Tambah]     │
│ Pakai di pemilihan (Switch)  │
│ [Daftar | Agen]              │
│ [🔍 Cari ]                   │
│ [Jenis ▾][Status ▾]          │
│ #topik · Aktif            ⋯  │
└──────────────────────────────┘
```

- **Komponen:** `Switch` di kepala halaman, `Tabs` (sinkron `?tab=`), `SearchField`, 2× `Select`, `Table` (desktop) atau daftar kartu (mobile), `Modal` + `Form` tambah/ubah (menggantikan `details.trAdd` dan form Ubah inline di `TrendItemCard.jsx`), `AlertDialog` hapus, `toast()`.
- **Tab Agen** (admin; `components/trends/TrendAgentPanel.jsx` ditulis ulang): endpoint + [Salin], [Buat token]. Token baru tampil sekali di `Modal` ("Hanya tampil sekali" + [Salin]). Daftar token punya [Cabut].
- **Member** (Q4 default, dok 02 §2.1): switch berlaku untuk dirinya sendiri (switch per anggota, MU-M6); daftar tren instans hanya bisa dibaca. [Tambah tren], ⋯ Ubah/Hapus, dan tab Agen hanya dirender untuk admin; aksi utama member tidak ada.
- **Data:** Fase 3 tidak mengubah API: `/api/context/trends`, `/api/context/trends/[id]`, `/api/context/trends/settings`, `/api/context/tokens`, `/api/context/tokens/[id]` (via `components/trends/trend-api.mjs`). Sejak Fase 6 (MU-M6, dok 02 §API): Switch di kepala halaman untuk **member** memanggil `GET`/`PATCH /api/account/preferences` `{trendsEnabled:boolean}` (kolom `users.trends_enabled`, dok 02 §8.2, §9.4); untuk admin tetap `PUT /api/context/trends/settings` `{enabled, scope:"instance"}` (switch instans, dok 02 §8.1 route #8). Tab Agen memakai `/api/account/tokens` (scope `trends:*`, admin saja) setelah UI pindah; `/api/context/tokens` hanya alias kompatibel (dok 02 §8.1 route #4).
- **State:**
  - Memuat: `Skeleton`.
  - Kosong: `EmptyState` "Belum ada tren" + [Tambah tren].
  - Saring kosong: "Tidak ditemukan".
  - Gagal: `LoadError`.

| Kunci | id | en |
|---|---|---|
| `trends.title` | Tren | Trends |
| `trends.use` | Pakai di pemilihan klip | Use in clip picking |
| `trends.add` | Tambah tren | Add trend |
| `trends.summary` | {active} aktif · {inactive} nonaktif · {expired} kedaluwarsa | {active} active · {inactive} off · {expired} expired |
| `trends.tab.list` | Daftar | List |
| `trends.tab.agent` | Agen | Agent |
| `trends.filter.kind` | Jenis | Type |
| `trends.filter.status` | Status | Status |
| `trends.empty` | Belum ada tren | No trends yet |
| `trends.agent.endpoint` | Endpoint | Endpoint |
| `trends.agent.newToken` | Buat token | Create token |
| `trends.agent.once` | Hanya tampil sekali | Shown once |
| `trends.agent.revoke` | Cabut | Revoke |
| `trends.form.edit` | Ubah tren | Edit trend |

- **Dihapus:** kalimat kepala halaman dan kartu ("Berlaku untuk job berikutnya.", "Endpoint dan token supaya…", `trends/page.jsx:199,296`), `details.trAdd`, dan judul "Integrasi agen (Hermes)". Catatan keamanan token dipindah ke Bantuan.
- **Tes:** unit `trend-view` (`localeCompare` lewat `content-text`), `settings-trends-ui`; e2e `trends.spec.mjs`: `article.trItem`/`details.trAdd` diganti role, dan `selectOption` (4×) diganti klik `Select` → `option`.

### 6.10 Pengaturan (`/settings`, `web/app/settings/page.jsx`, ditulis ulang, Fase 3)

- **Aksi utama:** [Simpan] di bar mengambang, yang hanya muncul kalau ada perubahan belum disimpan.

```
Desktop
┌───────────────────────────────────────────────────────────────────────┐
│ Pengaturan                                                            │
│ [AI ● | Transkripsi | Tampilan | YouTube | Sistem]   ← ● = belum simpan│
│ Aktifkan AI (Switch)                                                  │
│ Urutan penyedia                                     [Tambah penyedia] │
│ ┌ 1 OpenRouter · x:free · Key tersimpan        [Uji] ⋯ ┐              │
│ │ ▸ Lanjutan · Model gratis · timeout 30 dtk           │              │
│ └──────────────────────────────────────────────────────┘              │
│              ┌ ● Belum disimpan     [Batalkan] [ Simpan ] ┐           │
└───────────────────────────────────────────────────────────────────────┘
Mobile
┌──────────────────────────────┐
│ Pengaturan                   │
│ [AI|Transkripsi|Tampilan|…]→ │  ← Tabs gulir horizontal
│ Aktifkan AI (Switch)         │
│ 1 OpenRouter        [Uji] ⋯  │
│ ▸ Lanjutan · gratis          │
│ ┌ ● Belum disimpan [Simpan] ┐│  ← sticky bawah
└──────────────────────────────┘
```

- **Model simpan:**
  - Satu bar simpan untuk semua tab. `Tabs` disinkronkan dengan hash (`#ai|transkripsi|tampilan|youtube|sistem`), dan hash lama tetap membuka tab yang sama.
  - Panel memakai `shouldForceMount`, jadi perubahan tidak hilang saat pindah tab; tab yang punya perubahan diberi "●" (ditambah `aria-label` "{tab}, belum disimpan").
  - [Simpan] memanggil PUT/POST setiap kartu yang kotor secara berurutan, lalu toast "Tersimpan" atau "{n} gagal" + fokus ke kartu pertama yang gagal.
  - Unggahan (logo, cookies.txt) tersimpan langsung saat file dipilih, dengan toast.
  - Navigasi keluar saat masih kotor memicu `beforeunload`.
- **Isi tab:**

| Tab | Isi dasar | Lanjutan (tertutup) | API (sudah ada) | Peran |
|---|---|---|---|---|
| AI | Sejak Fase 5: `ToggleButtonGroup` "Milik saya \| Instans" (Instans hanya admin) di atas isi tab; baris status "AI bersama · {used} unit hari ini" (`usage.llmUnitsToday` dari `GET /api/account`) bila rantai pribadi kosong dan AI bersama dipakai. Switch Aktifkan AI; Switch Hanya model gratis; kartu penyedia (urutan, [Uji], ⋯ Naik/Turun/Hapus); [Tambah penyedia] → `Modal` + `ListBox` preset (`lib/llm-presets.mjs`, satu label per preset) | per penyedia: model (`ComboBox`), base URL, timeout | `/api/settings/llm?scope=user\|instance`, `/api/settings/llm/test`, `/api/settings/llm/models`, `/api/settings/llm/import-env` (instans saja) — dok 02 §8.1 route #39–#42 | admin; member bila `member_llm_keys_allowed` (§4.4) |
| Transkripsi | Pemilih scope yang sama dengan AI. Switch "Transkrip lewat Groq"; API key Groq (`TextField type="password"`) | — | `/api/settings/transcription?scope=user\|instance` (dok 02 route #46) | semua (instans hanya admin) |
| Tampilan | Logo bawaan; Watermark teks; Switch "Pintasan satu tombol" (cookie, §3.9) | posisi/ukuran watermark | `/api/settings/logo`, `/api/settings/watermark` | semua (per user sejak Fase 5) |
| YouTube | cookies.txt (`FileTrigger`) + `StatusPill` status; Switch "Bagikan ke anggota" (`youtube_cookies_share`, Fase 6) | — | `/api/settings/youtube-cookies`; switch lewat `/api/admin/settings` | admin |
| Sistem | Tentang sistem (daftar versi + [Salin]), status penyimpanan global, **Berbagi dan batas** (Fase 6: `llm_share`, `llm_daily_cap`, `groq_share`, `member_llm_keys_allowed`, `member_*`, TTL undangan/reset; `NumberField`/`Switch`, kosong = default dok 02 §3.3), `SocialAppsCard` (Fase 8), Jaringan unduhan (Fase 7), baris **Cache unduhan** (Fase 7: ukuran + jumlah entri, tombol [Kosongkan] dengan `AlertDialog`; dok 04 §B6.7), tautan Lisensi, tautan "Akun" → `/akun` (Fase 6) | batas default (`member_*`, TTL) | `/api/settings/system`, `/api/storage/status`, `GET/PUT /api/admin/settings` (dok 02 §8.2), `/api/settings/social-apps` (dok 03 §9.1), `/api/settings/download-network` (dok 04 §B7.2), `GET /api/admin/cache-unduhan` + `POST /api/admin/cache-unduhan/clear` (dok 04 §B6.7) | admin |

PUT `/api/admin/settings`, `/api/settings/social-apps` dan `/api/settings/download-network` butuh re-auth (dok 02 §6.7, dok 03 §9.1, dok 04 §B7.2): jawaban 403 `reauth_required` membuka `Modal` re-auth yang sama dengan Admin (§6.12), lalu bar simpan mengulang kartu itu sekali.

- **Komponen:** `Tabs`, `Card` per penyedia, `Disclosure` "Lanjutan" dengan ringkasan di judul, `Switch`, `TextField`, `ComboBox`/`Select`, `Modal` + `ListBox`, `Alert` (masalah saja; status AI tidak lagi selalu tampil), `toast()` ("Tersimpan", "Uji berhasil · {ms} ms").
- **State:** memuat = `Skeleton` per tab; gagal muat per tab = `LoadError` di panel itu (tab lain tetap jalan).

| Kunci | id | en |
|---|---|---|
| `settings.title` | Pengaturan | Settings |
| `settings.tab.ai` | AI | AI |
| `settings.tab.transcription` | Transkripsi | Transcription |
| `settings.tab.appearance` | Tampilan | Appearance |
| `settings.tab.youtube` | YouTube | YouTube |
| `settings.tab.system` | Sistem | System |
| `settings.unsavedTab` | {tab}, belum disimpan | {tab}, unsaved |
| `settings.bar.unsaved` | Belum disimpan | Unsaved |
| `settings.bar.discard` | Batalkan | Discard |
| `settings.bar.failed` | {count} gagal | {count} failed |
| `settings.ai.enable` | Aktifkan AI | Enable AI |
| `settings.ai.freeOnly` | Hanya model gratis | Free models only |
| `settings.ai.providers` | Urutan penyedia | Provider order |
| `settings.ai.addProvider` | Tambah penyedia | Add provider |
| `settings.ai.test` | Uji | Test |
| `settings.ai.testOk` | Uji berhasil · {ms} ms | Test passed · {ms} ms |
| `settings.ai.keySaved` | Key tersimpan | Key saved |
| `settings.ai.advancedSummary` | {model} · timeout {seconds} dtk | {model} · timeout {seconds}s |
| `settings.scope.mine` | Milik saya | Mine |
| `settings.scope.instance` | Instans | Instance |
| `settings.ai.shared` | AI bersama · {used} unit hari ini | Shared AI · {used} units today |
| `settings.youtube.share` | Bagikan ke anggota | Share with members |
| `settings.system.sharing` | Berbagi dan batas | Sharing and limits |
| `settings.transcription.groq` | Transkrip lewat Groq | Transcribe with Groq |
| `settings.transcription.key` | API key Groq | Groq API key |
| `settings.appearance.logo` | Logo | Logo |
| `settings.appearance.watermark` | Watermark | Watermark |
| `settings.youtube.cookies` | cookies.txt | cookies.txt |
| `settings.system.about` | Tentang sistem | About system |
| `settings.system.licenses` | Lisensi | Licenses |
| `settings.system.account` | Akun | Account |
| `settings.tos9router` | 9Router: cek ketentuan layanan | 9Router: check terms of service |

- **Dihapus:**
  - semua `<p>` kepala kartu (`settings/page.jsx:505,787,821,836` dan sejenisnya);
  - kartu Status AI yang selalu tampil;
  - deskripsi preset panjang di `lib/llm-presets.mjs` (tinggal satu label);
  - `<details className="providerAdvanced">`/`addProvider` (diganti `Disclosure`/`Modal`);
  - copy kartu di `lib/*-view.mjs` (`llm-settings-view`, `transcription-settings-view`, `youtube-cookies-view`, `default-logo-view`, `default-watermark-view`, `system-info-view`) diganti deskriptor.
- **Tes:**
  - unit `settings-trends-ui`, `system-info`, `transcription-settings`, `default-logo`, `default-watermark`, `youtube-cookies`, `llm-settings`, `llm-settings-view`, `llm-settings-routes`, serta `settings-save-model.test.mjs` **(baru)** untuk kotor per tab, simpan berurutan, dan gagal sebagian;
  - e2e `settings-*.spec`: `selectOption` di `settings-watermark` diganti `Select`; `check()`/`getByRole("checkbox")` di `settings-transcription` (5), `settings-logo` (2), `settings-youtube-cookies` (3) diganti `getByRole("switch")`; plus kasus baru "pindah tab tidak menghilangkan perubahan" dan "hash `#youtube` membuka tab YouTube".

### 6.11 Akun (`/akun`, `/akun/kata-sandi`, `/undangan/[token]`, `/atur-ulang-sandi/[token]`, baru, Fase 6)

- **Aksi utama:** `/akun` tidak punya lime (setiap bagian disimpan sendiri). `/akun/kata-sandi`: [Simpan]. Undangan: [Buat akun]. Reset: [Simpan sandi].

```
/akun desktop                                     /akun mobile
┌─────────────────────────────────────────────┐   ┌───────────────────────────┐
│ Akun                                        │   │ Akun                      │
│ Profil                                      │   │ Profil                    │
│ Nama tampilan [Andi Saputra   ] [Simpan]    │   │ Nama tampilan             │
│ Nama pengguna andi                          │   │ [Andi Saputra           ] │
│ Kata sandi    ••••••••   [Ganti]            │   │ [Simpan]                  │
│ ─────────                                   │   │ Kata sandi    [Ganti]     │
│ Bahasa  [Bahasa Indonesia ▾] [Simpan]       │   │ Bahasa [ID ▾] [Simpan]    │
│ Zona    [Asia/Jakarta (WIB) ▾]   (Fase 8)   │   │ Zona [WIB ▾]              │
│ ─────────                                   │   │ Penyimpanan 3,1/10 GB ━━  │
│ Penyimpanan   3,1 GB dari 10 GB ━━━━░░░     │   │ Sesi [Keluar semua]       │
│ Sesi          [Keluar dari semua perangkat] │   │ Token API ▸               │
│ Token API     2 aktif    [Buat token]       │   └───────────────────────────┘
│  ptk_…a1f  trends:write  [Cabut]            │
└─────────────────────────────────────────────┘

/akun/kata-sandi, /undangan/[token], /atur-ulang-sandi/[token]: kartu tunggal tanpa shell
(kecuali /akun/kata-sandi yang ada di shell), satu kolom di semua lebar:
┌ Buat akun ───────────────────┐
│ Diundang oleh admin          │   ← hanya undangan
│ Nama pengguna [            ] │
│ Kata sandi    [            ] │
│ Ulangi        [            ] │
│ [ Buat akun ]                │
│ Bahasa [ID ▾][Simpan]        │
└──────────────────────────────┘
```

- **Komponen:** `Form` + `TextField`, Bahasa = native `<select name="locale">` + form `POST /api/locale` (jalan tanpa JS; sama dengan login), Zona (Fase 8) = `ComboBox` IANA dengan label pendek, `Meter` (pemakaian penyimpanan; bukan `ProgressBar`, karena bukan progres), `Table` sesi + `Table` token, `AlertDialog` "Keluar dari semua perangkat?", `Modal` token baru ("Hanya tampil sekali" + [Salin]).
- **Bagian `/akun`** (urutan): Profil (Nama tampilan + [Simpan], Nama pengguna baca-saja, Kata sandi [Ganti] → `/akun/kata-sandi`) · Bahasa · Zona (Fase 8) · Penyimpanan (hanya bila `limits.storageQuotaBytes` ≠ null) · Sesi (daftar perangkat, [Cabut] per baris kecuali sesi ini, [Keluar dari semua perangkat]) · Token API (`Disclosure` "Lanjutan" tertutup dengan ringkasan `Token API · {n} aktif`).
- **Form `/undangan/[token]` dan `/atur-ulang-sandi/[token]`:** form POST native (`application/x-www-form-urlencoded`) ke API; error dibaca dari `?error=<code>` dan ditulis di `<p role="alert">`. Bahasa akun baru = field `locale` form terima undangan (`<select>` native, default `invites.locale` yang dipilih admin; nilai di luar locale aktif → `invites.locale`; dok 02 §6.3, dok 07 §9.4), disalin ke `users.locale`. Di halaman reset sandi, pemilih bahasa hanya mengubah cookie tampilan (`/api/locale`). Halaman dilayani tanpa sesi lewat cek path di `proxy.js` (bukan pengecualian matcher; dok 02 §4.5), route API-nya dikecualikan matcher dan tercatat di `proxy-matcher.test`.
- **Kontrak yang dipakai UI** (salinan ringkas dok 02 §6, §8.2 dan dok 07 §9.2, §13.2; pemilik menang):

| Method + path | Auth | Request | Respons | Error ditangani UI (`errors.account.<code>` kecuali disebut lain) |
|---|---|---|---|---|
| `GET /api/account` | sesi | — | `{id, username, displayName, role, locale, mustChangePassword, isSmoke, via, limits:{storageQuotaBytes, …}, usage:{storageBytes, llmUnitsToday}}` | 401 → `/login` |
| `PATCH /api/account` | sesi, same-origin | `{displayName}` (1–60 karakter, `users.display_name` dok 01 §4) | akun | 400 `errors.web.invalid_request` |
| `POST /api/account/password` | sesi, same-origin, rate limit `password` | JSON `{current, next}` | `200 {ok:true}`; sesi lain dicabut, sesi ini dirotasi | 403 `password_wrong` (di field Sandi sekarang); 400 `password_too_short`, `password_too_long`, `password_common`, `password_same_as_username` (di field Sandi baru); `password_mismatch` dicek di klien |
| `GET /api/account/sessions` | sesi | — | `{sessions:[{id, deviceLabel, createdAt, lastSeenAt, current, via}]}` | — |
| `DELETE /api/account/sessions/[sid]` | sesi, same-origin | — | `200 {revoked:1}` | 404 |
| `DELETE /api/account/sessions?scope=all` | sesi, same-origin | — (API juga punya `scope=others`, tidak dipakai UI) | `200 {revoked:n}`; cookie dihapus → klien `window.location.assign('/login')` | — |
| `GET/PATCH /api/account/preferences` (dok 02 §8.2) | sesi, same-origin (PATCH), JSON ≤ 1 KiB | patch parsial `{trendsEnabled?:boolean, timeZone?:string}` (`trendsEnabled` sejak MU-M6; `timeZone` sejak i18n M7b, aturan nilai dok 07 §13.2) | `200` preferensi lengkap `{trendsEnabled, timeZone}` | 400 `errors.web.invalid_request`, 400 `errors.account.time_zone_invalid` |
| `GET /api/account/tokens` | sesi | — | `{tokens:[{id,label,prefix,scopes,createdAt,lastUsedAt,revokedAt}], maxActive:10, allowedScopes}` | — |
| `POST /api/account/tokens` | sesi, same-origin, rate limit `api_token_create` | `{label 1–40, scopes ⊆ allowedScopes}` | `201 {token:"ptk_…", meta}` (sekali) | 400 `scope_not_allowed`, 409 `token_limit`, 429 |
| `DELETE /api/account/tokens/[id]` | sesi, same-origin | — | 200 | 404 |
| `POST /api/locale` | publik (cookie; tulis `users.locale` bila sesi valid) | form `locale`, `next?` | 303 ke `next` aman → `Referer` sama-origin → `/` (dok 07 §9.2) | form: 303 + `?bahasa=gagal` → `auth.locale.failed`; JSON: 400 `locale_unsupported`, 413, 429 |
| `POST /api/auth/invite/accept` | publik, origin, rate limit `token_link` | form `token, username, password, password2, locale` (dok 02 §6.3) | 303 `/dashboard` (sesi baru) | 303 `?error=` `link_invalid` (semua sebab token: anti-enumerasi), `username_invalid`, `username_taken`, `password_*`, `password_mismatch`, `rate_limited` |
| `POST /api/auth/reset/complete` | publik, origin, rate limit `token_link` | form `token, password, password2` | 303 `/dashboard` (sesi baru) | 303 `?error=` `link_invalid`, `password_*`, `password_mismatch`, `rate_limited` |

- **State:**
  - `mustChangePassword` → setiap layout shell memanggil `redirect('/akun/kata-sandi')` di server; `/akun/kata-sandi` hanya menampilkan form (tanpa nav selain Keluar).
  - Token undangan/reset tidak valid → halaman merender kartu "Tautan tidak berlaku" + [Masuk] dengan HTTP 404 (dok 02 §6.3).
  - GET halaman undangan/reset terlalu sering (limiter `token_page`, dok 02 §7.1) → kartu `errors.web.rate_limited` dengan HTTP 429.
  - Kuota `null` → bagian Penyimpanan tidak dirender.
  - Memuat: `Skeleton` per bagian. Gagal: `LoadError` per bagian.
  - Simpan berhasil: `toast()` "Tersimpan". Token baru: `Modal` sekali tampil; menutupnya tanpa [Salin] tetap diizinkan.

| Kunci | id | en |
|---|---|---|
| `account.title` | Akun | Account |
| `account.profile` | Profil | Profile |
| `account.displayName` | Nama tampilan | Display name |
| `account.username` | Nama pengguna | Username |
| `account.password` | Kata sandi | Password |
| `account.password.change` | Ganti | Change |
| `account.password.title` | Ganti kata sandi | Change password |
| `account.password.current` | Sandi sekarang | Current password |
| `account.password.new` | Sandi baru | New password |
| `account.password.repeat` | Ulangi | Repeat |
| `account.password.mismatch` | Sandi tidak sama | Passwords don't match |
| `account.language` | Bahasa | Language |
| `account.timeZone` | Zona | Time zone |
| `account.storage` | Penyimpanan | Storage |
| `account.storage.usage` | {used} dari {quota} | {used} of {quota} |
| `account.sessions` | Sesi | Sessions |
| `account.sessions.revokeAll` | Keluar dari semua perangkat | Sign out everywhere |
| `account.sessions.confirm` | Keluar dari semua perangkat? | Sign out on all devices? |
| `account.tokens` | Token API | API tokens |
| `account.tokens.new` | Buat token | Create token |
| `account.tokens.revoke` | Cabut | Revoke |
| `account.tokens.once` | Hanya tampil sekali | Shown once |
| `account.tokens.label` | Nama token | Token name |
| `account.tokens.summary` | Token API · {count} aktif | API tokens · {count} active |
| `account.sessions.current` | Perangkat ini | This device |
| `account.sessions.revoke` | Cabut | Revoke |
| `account.storage.title` | Penyimpanan | Storage |
| `auth.invite.title` | Buat akun | Create account |
| `auth.invite.by` | Diundang oleh admin | Invited by admin |
| `auth.invite.submit` | Buat akun | Create account |
| `auth.reset.title` | Atur ulang sandi | Reset password |
| `auth.reset.submit` | Simpan sandi | Save password |
| `auth.link.invalid` | Tautan tidak berlaku | Link no longer valid |

- **Tes:** `tests/account-view.test.mjs` **(baru)**: pemetaan `?error=` → kunci + field, bagian Penyimpanan tersembunyi bila kuota null, ringkasan token; e2e `account.spec.mjs` **(baru, bersama dok 02 §13.2)**: ganti sandi mencabut sesi lain, `password_wrong` di field yang benar, undangan dan reset tanpa JS, tautan tidak berlaku = 404 dengan kartu yang sama untuk semua sebab, token sekali tampil, Bahasa tersimpan ke DB (perangkat kedua), login pertama `must_change_password` → `/akun/kata-sandi`; `proxy-matcher.test` (route `invite/accept`, `reset/complete`).

### 6.12 Admin (`/admin/pengguna`, `/admin/pengguna/[userId]`, `/admin/job`, baru, Fase 6)

- **Aksi utama:** [Undang pengguna] di `/admin/pengguna`. Halaman lain tidak punya lime.

```
/admin/pengguna desktop
┌──────────────────────────────────────────────────────────────────────────┐
│ Admin                                                [Undang pengguna]   │
│ [Pengguna | Job]                                                         │
│ [🔍 Cari      ]  (Semua 6)(Aktif 5)(Nonaktif 1)(Undangan 2)              │
│ (AS) andi     Admin    Aktif      3,1 GB   2 jam lalu              ⋯     │
│ (BK) budi     Anggota  Aktif      0,4 GB   kemarin                 ⋯     │
│ ✉ citra       Anggota  Diundang   —        s.d. 31 Okt   [Salin tautan]  │
│                             ‹ 1 2 ›                                      │
└──────────────────────────────────────────────────────────────────────────┘
/admin/job desktop (hanya metadata; admin tidak membuka proyek orang lain, Q3)
[⚠ Pemeliharaan]  Concurrency 1                         ← Alert hanya bila paused
│ Pengguna │ Status                 │ Posisi │ Dibuat    │ Ukuran  │ ⋯ │
│ budi     │ Diproses               │ —      │ 6 mnt lalu│ 1,2 GB  │ ⋯ │
│ citra    │ Antre                  │ 1      │ 1 mnt lalu│ 0,3 GB  │ ⋯ │
│ dodi     │ Antre · Pemeliharaan   │ 2      │ 1 mnt lalu│ 0,1 GB  │ ⋯ │
Mobile: daftar kartu per pengguna/job; ⋯ berisi aksi yang sama; Pagination di bawah.
```

- **Komponen:** `Tabs` (`<a>` ke dua rute, bukan state), `SearchField`, `ToggleButtonGroup` (Semua/Aktif/Nonaktif/Undangan), `Table` + `Pagination` (label `aria.*`), `Avatar`, `StatusPill`, `Dropdown` ⋯ per pengguna (Ubah peran · Atur ulang sandi · Nonaktifkan/Aktifkan · Keluarkan dari semua perangkat · Hapus), `Dropdown` ⋯ per undangan (Cabut), `Modal` + `Form` undang, `AlertDialog` konfirmasi, `Modal` re-auth.
- **Undang** (`Modal`): Peran (`RadioGroup` Anggota/Admin, default Anggota), Bahasa undangan (`Select`, default bahasa admin), Nama pengguna usulan (`TextField`, opsional = `usernameHint`), Catatan (opsional, ≤ 80). [Buat tautan] → hasil: tautan + [Salin] + masa berlaku (tanpa SMTP, Q3). Tautan hanya ada di respons ini; menutup modal = tautan tidak bisa dilihat lagi (buat ulang bila hilang).
- **Re-auth** (dok 02 §6.7): aksi yang butuh re-auth memanggil API langsung; kalau API menjawab 403 `errors.web.reauth_required`, `Modal` "Sandi Anda" dibuka (`TextField type="password"`) → `POST /api/auth/reauth {password}` → sukses: request asli diulang sekali; 403 `password_wrong`: error di field tanpa menutup modal; 429: pesan rate limit. Re-auth berlaku 10 menit (`reauthUntil`), sehingga aksi berikutnya tidak bertanya lagi.
- **`/admin/pengguna/[userId]`:** profil, peran, status, batas (`NumberField`: kuota penyimpanan dalam GB → `storageQuotaBytes`, durasi sumber maks dalam menit → `maxSourceSeconds`, job aktif/berjalan/per jam → `maxActiveJobs`/`maxRunningJobs`/`jobsPerHour`; kosong = `null` = ikut default instans, Q5), switch tiga keadaan "Pakai AI bersama" (`llmShare`: ikut instans / ya / tidak, Q4), sesi aktif + [Keluarkan dari semua perangkat], daftar proyek **metadata saja** (status, dibuat, sumber, jumlah klip, ukuran; tanpa judul/URL, Q3) dengan ⋯ per proyek: Pindahkan ke… (`Select` pengguna tujuan) · Batalkan (bila aktif) · Hapus (`AlertDialog` dengan field "Ketik {8 karakter pertama id}"), dan aktivitas terakhir (`GET /api/admin/audit?userId=`; teks dari `admin.audit.<code>` + `params`, dirender dalam bahasa penonton).
- **`/admin/job`:** polling 5 dtk (berhenti saat tab tersembunyi). Kolom: Pengguna · Status (`StatusPill`; `held` dipetakan lewat §5: `maintenance` → "Antre · Pemeliharaan", `owner_disabled` → "Antre · Pengguna nonaktif") · Posisi · Dibuat · Ukuran. Baris atas: `Alert` "Pemeliharaan" bila `paused`, dan `Concurrency {n}`. ⋯ per baris: Batalkan (`AlertDialog`). Tidak ada tautan ke proyek.
- **Kontrak yang dipakai UI** (salinan ringkas dok 02 §6.3–§6.7, §8.2, §9.5; dok 02 menang). Semua route `role:'admin'`; non-admin → 404 identik.

| Method + path | Re-auth | Request | Respons | Error ditangani UI |
|---|---|---|---|---|
| `GET /api/admin/users?q=&status=&role=&page=` | — | — | `{users:[{id, username, displayName, role, status:'active'\|'disabled', isSmoke, createdAt, lastLoginAt, jobCount, storageBytes}], total}` | — |
| `GET /api/admin/invites` | — | — | `{invites:[{id, role, locale, usernameHint, note, tokenPrefix, createdBy, createdAt, expiresAt, state}]}`; UI menampilkan `state='pending'` sebagai baris "Diundang" | — |
| `POST /api/admin/invites` | — | `{role, locale, usernameHint?, note? ≤ 80}` | `201 {invite:{id, role, locale, tokenPrefix, expiresAt}, url}` (`url` hanya di respons ini) | 400 `errors.web.invalid_request`, 429 |
| `DELETE /api/admin/invites/[inviteId]` | — | — | 200 | 404 (sudah dipakai/kedaluwarsa) → toast + muat ulang |
| `GET /api/admin/users/[userId]` | — | — | user + `limits` + `sessions` | 404 |
| `PATCH /api/admin/users/[userId]` | ✓ | `{role?, status?, limits?:{maxActiveJobs?, maxRunningJobs?, jobsPerHour?, maxSourceSeconds?, storageQuotaBytes?, llmShare?}}` (`null` = default) | user | 409 `last_admin`, `self_action_forbidden`, `smoke_user_locked`; 400 |
| `DELETE /api/admin/users/[userId]` | ✓ | — | 200/204 | 409 `user_has_projects`, `user_active` (menu Hapus hanya aktif bila nonaktif dan `jobCount=0`) |
| `POST /api/admin/users/[userId]/reset-link` | ✓ | — | `201 {url, expiresAt}` → `Modal` tautan + [Salin] | 409 `smoke_user_locked` |
| `DELETE /api/admin/users/[userId]/sessions` | ✓ | — | `{revoked}` | — |
| `GET /api/admin/users/[userId]/jobs` | — | — | `[{id, status, createdAt, updatedAt, sourceType, clipCount, bytes}]` | — |
| `POST /api/admin/jobs/[id]/transfer` | ✓ | `{toUserId}` | 200 | 409 `job_active`, 404 (job atau pengguna tujuan) |
| `POST /api/admin/jobs/[id]/cancel` | — | — | 200 | 404 |
| `DELETE /api/admin/jobs/[id]` | ✓ | `{confirm:"<8 char pertama id>"}` | 202 | 400 `confirm_mismatch`, 404 |
| `GET /api/admin/jobs` | — | — | daftar `[{id, ownerId, ownerUsername, status, held:null\|'maintenance'\|'owner_disabled', position, firstClaimedAt, createdAt, bytes}]` + `{paused, concurrency}`; UI membaca `{jobs, paused, concurrency}` (nama amplop menunggu dok 02, §10) | — |
| `GET /api/admin/audit?userId=&code=&before=&limit=` | — | — (UI mengirim `limit=20`; maks 100) | `{events:[{id, at, actorUserId, actorUsername, actorVia, code, params, targetUserId, targetJobId}], next}` | — |
| `GET/PUT /api/admin/settings` | ✓ (PUT) | patch parsial `instance_settings` (kunci dok 02 §3.3) | pengaturan | 400 |
| `POST /api/auth/reauth` | — | `{password}` | `{reauthUntil}` | 403 `password_wrong`, 429 `rate_limited` |

Error admin dirender dari `errors.account.<code>` (domain multi-user, dok i18n §10.2).

- **State:**
  - Memuat: `Skeleton`.
  - Hanya ada admin sendiri: `EmptyState` "Belum ada anggota" + [Undang pengguna].
  - Saring/cari kosong: "Tidak ditemukan".
  - Gagal: `LoadError`.
  - Aksi berhasil: toast. Re-auth gagal: error di field sandi tanpa menutup modal.
  - Pengguna smoke (`isSmoke`): aksi Ubah peran/Nonaktifkan/Atur ulang sandi tidak dirender (P6).

| Kunci | id | en |
|---|---|---|
| `admin.title` | Admin | Admin |
| `admin.tab.users` | Pengguna | Users |
| `admin.tab.jobs` | Job | Jobs |
| `admin.invite` | Undang pengguna | Invite user |
| `admin.invite.link` | Tautan undangan | Invite link |
| `admin.invite.language` | Bahasa undangan | Invite language |
| `admin.role.admin` | Admin | Admin |
| `admin.role.member` | Anggota | Member |
| `admin.status.active` | Aktif | Active |
| `admin.status.disabled` | Nonaktif | Disabled |
| `admin.status.invited` | Diundang | Invited |
| `admin.action.role` | Ubah peran | Change role |
| `admin.action.reset` | Atur ulang sandi | Reset password |
| `admin.action.disable` | Nonaktifkan | Disable |
| `admin.action.enable` | Aktifkan | Enable |
| `admin.action.transfer` | Pindahkan ke… | Move to… |
| `admin.action.cancelJob` | Batalkan | Cancel |
| `admin.action.deleteJob` | Hapus proyek | Delete project |
| `admin.action.deleteJob.confirm` | Ketik {prefix} untuk menghapus | Type {prefix} to delete |
| `admin.action.signOutAll` | Keluarkan dari semua perangkat | Sign out everywhere |
| `admin.action.delete` | Hapus pengguna | Delete user |
| `admin.action.revokeInvite` | Cabut | Revoke |
| `admin.invite.create` | Buat tautan | Create link |
| `admin.invite.role` | Peran | Role |
| `admin.invite.usernameHint` | Nama pengguna usulan | Suggested username |
| `admin.invite.note` | Catatan | Note |
| `admin.invite.expires` | Berlaku s.d. {when} | Valid until {when} |
| `admin.reset.link` | Tautan atur ulang | Reset link |
| `admin.llmShare` | Pakai AI bersama | Use shared AI |
| `admin.limits.maxActive` | Job aktif maks | Max active jobs |
| `admin.limits.perHour` | Job per jam | Jobs per hour |
| `admin.jobs.position` | Posisi | Position |
| `admin.jobs.concurrency` | Concurrency {count} | Concurrency {count} |
| `admin.reauth` | Sandi Anda | Your password |
| `admin.quota` | Kuota | Quota |
| `admin.maxSource` | Durasi sumber maks | Max source length |
| `admin.audit` | Aktivitas | Activity |
| `admin.empty` | Belum ada anggota | No members yet |
| `admin.jobs.paused` | Pemeliharaan | Maintenance |
| `admin.copyLink` | Salin tautan | Copy link |

- **Tes:** `tests/admin-view.test.mjs` **(baru)**: gabungan users + invites `pending` jadi satu daftar, aksi per status/`isSmoke`/`jobCount`, alur re-auth (403 `reauth_required` → modal → ulang sekali), `held` → kunci status; e2e `admin.spec.mjs` **(baru, bersama dok 02 §13.2)**: non-admin → 404 di ketiga rute, undang → tautan → buat akun, re-auth modal (gagal lalu berhasil), admin terakhir tidak bisa diturunkan, nonaktifkan → sesi target mati, hapus proyek dengan konfirmasi prefix; `ownership-matrix` (dok 02).

### 6.13 Bantuan, error, lisensi (Fase 3)

**Bantuan** (`web/app/bantuan/page.jsx`, server component, `getT`):

```
Desktop                                         Mobile
┌──────────────────────────────────────────┐    ┌──────────────────────────┐
│ Bantuan                                  │    │ Bantuan                  │
│ [🔍 Pesan error                        ] │    │ [🔍 Pesan error        ] │
│ Panduan                                  │    │ Panduan                  │
│ ▸ Buat klip   ▸ Proyek   ▸ Editor  …     │    │ ▸ Buat klip              │
│ Pintasan                                 │    │ Pintasan (tabel gulir)   │
│ │ N │ Buat klip │ …                      │    │ Pesan error              │
│ Pesan error                              │    │ #download_bot_check …    │
│ Unduhan · Penyimpanan · AI · …           │    └──────────────────────────┘
│ #download_bot_check  YouTube minta login │
└──────────────────────────────────────────┘
```

- **Komponen:**
  - `SearchField` "Pesan error" (`app/bantuan/HelpSearch.jsx`). Indeks pencarian memuat teks `shown` dari **semua** locale plus kode (i18n M4), sehingga pesan `id` yang ditempel di UI `en` tetap ketemu.
  - Panduan: `Disclosure` per topik (`GUIDE_TOPICS`); item yang cocok dengan hash dibuka otomatis.
  - Pintasan: `Table` (kelompok Dashboard dari `app-shortcuts.mjs` + editor dari `GUIDE_SHORTCUTS`).
  - Entri error tetap berupa `<section id="<kode>">` yang **selalu dirender**, sehingga tetap jalan tanpa JS (`help-page.test.mjs`). Anchor `helpAnchors(entry)` tidak berubah.
- **Dihapus:** kalimat di kepala halaman (`bantuan/page.jsx` `.pageHead p`).
- **Kunci:** `help.title` Bantuan / Help, `help.search` Pesan error / Error message, `help.guide` Panduan / Guide, `help.shortcuts` Pintasan / Shortcuts, `help.errors` Pesan error / Error messages, `help.noMatch` = `common.notFound`. Isi entri: `help.entries.<kode>.{title,fix}` (i18n M4).

**not-found / error / lisensi** (`app/not-found.jsx`, `app/error.jsx`, `app/licenses/page.jsx`): tetap di shell, ikut gaya baru.

| Layar | Isi | Aksi utama | Kunci |
|---|---|---|---|
| 404 | "Halaman tidak ditemukan" + tautan dari `notFoundLinks(pathname)` (`lib/not-found-view.mjs`) | [Buka proyek] (`secondary`) | `errors.http.s404` (dok 07 §10.2) Halaman tidak ditemukan / Page not found |
| error | "Terjadi masalah" + `digest` kecil + [Coba lagi] (`reset()`) | [Coba lagi] | `errors.http.s500` Terjadi masalah / Something went wrong |
| global-error | `<html>` sendiri, `status-page.css` + `.btn` minimal, bahasa dari `document.cookie` | [Muat ulang] | `errors.global.title`, `errors.global.reload` Muat ulang / Reload |
| Lisensi | daftar notice (`app/licenses/notices.mjs`) termasuk dependensi baru §3.1 | — | `legal.licenses` Lisensi / Licenses |

- **Tes:** `help-page` (tanpa JS, dua locale), `help-catalog` (kunci), `help-guide`, `licenses`, `ui-guards`; e2e `bantuan.spec.mjs` (pencarian lintas locale) dan `aria-names.spec.mjs` **(baru)**.

---

## 7. Aksesibilitas

### 7.1 Persyaratan (semua layar)

| # | Syarat | Bukti |
|---|---|---|
| A1 | Target sentuh ≥ 44×44 px untuk tombol, tab, item menu/listbox, close, pagination, dan hapus tag | override CSS (§3.5) + e2e ukur `boundingBox` di 1280 px dan 360 px |
| A2 | Fokus terlihat: cincin 2 px `--focus`, offset 2 px; tidak ada cincin dobel | screenshot fokus di halaman uji F0 |
| A3 | Skip link `#konten` di semua halaman shell | `app-shell.test` |
| A4 | Satu `<h1>` per halaman; urutan heading tidak melompat | e2e `aria-names` (cek heading) |
| A5 | Live region: progres proyek (`role=status`, `aria-valuenow`), JobBadge, klip bertahap (`aria-live=polite`), toast (bawaan Toast, `aria-live`) | e2e `project-workspace` |
| A6 | Overlay (Modal/Drawer/Popover/AlertDialog): fokus masuk, terkunci, Escape menutup, fokus kembali ke pemicu, latar inert | e2e per overlay |
| A7 | Kontras: teks ≥ 4,5:1; tepi kontrol dan ikon bermakna ≥ 3:1 (`--border-strong`); semua pasangan baru tercatat di TOKENS.md | `ui-guards` + `contrast-check.py` |
| A8 | Status tidak hanya warna: `StatusPill` selalu berisi teks | `status-view.test` |
| A9 | Reduced motion: `--dur-*` = 0, `--skeleton-animation: none`, `motion-reduce:` HeroUI aktif | CSS + e2e `reducedMotion:'reduce'` |
| A10 | Forced colors: fokus, chip, progress, switch, dan item terpilih terlihat | blok `@media (forced-colors: active)` + screenshot `forcedColors:'active'` |
| A11 | Nama aksesibel dari katalog. Di `id` tidak ada "Close", "Clear search", "Dismiss", "Select all", "Previous", "Next", "Calendar", "Remove", "Loading"; di `en` tidak ada kata Indonesia umum. Glosarium (Hook, Cold open, Logo, Audio) di-allowlist | e2e `aria-names.spec` + `heroui-default-labels` |
| A12 | Pintasan satu tombol bisa dimatikan sejak Fase 1 (WCAG 2.1.4) dan tidak aktif di field atau overlay | `app-shortcuts.test` |
| A13 | 360 px tanpa scroll horizontal di kedua locale | screenshot `en` + `id` per fase |
| A14 | Form: label terlihat, error lewat `aria-describedby`, fokus ke field salah pertama, login dengan error `role="alert"` | e2e `dashboard`, `account` |
| A15 | `<html lang>` = locale aktif; konten klip (judul, caption) memakai `lang={videoLanguage}` di elemen pembungkusnya | `app-shell.test`, `project-workspace.spec` |
| A16 | Chart: `<figure>` + ringkasan teks + tabel tersembunyi | `analytics-view.test` |

### 7.2 Keyboard per layar

| Layar | Tombol |
|---|---|
| Shell | Tab urut sidebar → konten; `N`, `/` (kalau aktif) |
| Proyek | `/` → cari; tabel: panah antar sel/baris, Space pilih, Enter buka |
| Penampil klip | `←`/`→` klip, Escape tutup |
| Pengaturan | panah antar tab (Tabs), Enter/Space di Switch |
| Drawer Terbitkan | Enter atau `,` menambah hashtag; Backspace di field kosong menghapus tag terakhir |

### 7.3 Target klik untuk tugas umum (P7, ≤ 3 klik)

| Tugas | Mulai dari | Klik |
|---|---|---|
| Buat klip dari link dengan default | `/dashboard` | 1 (tempel + [Buat klip]) |
| Ganti tata letak sebelum buat | `/dashboard` | 2 (chip → opsi) |
| Unduh semua klip proyek selesai | `/projects/[id]` | 1 |
| Buka klip lalu unduh MP4 | `/projects/[id]` | 2 |
| Terbitkan klip sekarang ke YouTube (isi bawaan) | penampil | 2 ([Terbitkan] → [Terbitkan]); TikTok +1 (privasi tanpa default) +1 (persetujuan) = 4, pengecualian sah karena syarat audit platform |
| Ganti bahasa | mana saja (shell) | 2 |
| Matikan pintasan | mana saja (shell) | 2 |
| Batalkan jadwal | `/sosial` | 3 (⋯ → Batalkan → konfirmasi) |
| Hapus 1 proyek | `/projects` | 3 (⋯ → Hapus → konfirmasi) |

Diukur di e2e `ux-clicks.spec.mjs` **(baru)**: hitung `click()` per skenario, dan tes gagal kalau melebihi tabel.

---

## 8. Tes

### 8.1 Baru

| Tes | Jenis | Isi | Fase |
|---|---|---|---|
| `web/tests/ui-foundation.test.mjs` | unit | `globals.css` tidak mengimpor tailwind/heroui; baris pertama `@layer theme, base, components, utilities;`; `:root` dan reduced-motion di luar layer; `ui.css` hanya diimpor `AppShell.jsx` + `components/ui/PublicCard.jsx`; setiap `@import` di `ui.css` ter-resolve ke file di `node_modules/@heroui/styles`; `components/editor/**`, rute edit, `parity-harness/**` tidak mengimpor `ui.css`/`@heroui/*`; tidak ada `RouterProvider`; `editorHref(` → `<a href`/`Dropdown.Item href`; setiap variabel `variables.css` HeroUI punya alias; override 44 px + radius ada | 1 |
| `web/tests/heroui-default-labels.test.mjs` | unit | §3.7 | 1 |
| `web/tests/app-nav.test.mjs`, `ui-prefs.test.mjs`, `app-shortcuts.test.mjs` | unit | §6.1 | 1 |
| `web/tests/status-view.test.mjs` | unit | §5, setiap status punya kunci di semua locale | 2 |
| `web/tests/settings-save-model.test.mjs` | unit | §6.10 | 3 |
| `web/tests/{publish-drawer-view,social-view}.test.mjs` | unit | §6.5–6.6 | 8 |
| `web/tests/analytics-view.test.mjs` | unit | §6.7 | 9 |
| `web/tests/{account-view,admin-view}.test.mjs` | unit | §6.11–6.12 | 6 |
| `web/e2e/aria-names.spec.mjs` | e2e | A11 di dua locale | 1+ |
| `web/e2e/ux-clicks.spec.mjs` | e2e | §7.3 | 2+ |
| `web/e2e/projects.spec.mjs` | e2e | batch hapus | 3 |
| `web/e2e/{account,admin}.spec.mjs` | e2e | §6.11–6.12 | 6 |
| `web/e2e/social.spec.mjs` + kasus UI di `web/e2e/social-publish.spec.mjs` (file milik dok 03) | e2e | §6.5–6.6, fake platform `SOCIAL_FAKE_ORIGIN` | 8 |
| `web/e2e/analytics.spec.mjs` | e2e | §6.7 | 9 |
| Spike CSS editor | CI | `next build` sebelum/sesudah. CSS yang dipakai rute edit harus identik (diff file `.next/static/css` yang dirujuk HTML rute edit). Ukuran JS per rute dicatat sebagai baseline; kenaikan JS editor ≤ ukuran use-intl | 1 |

### 8.2 Diubah

| Tes | Perubahan |
|---|---|
| `tests/app-shell.test.mjs` | `lang={locale}` + `data-theme="dark"`, nav datar, form logout tersembunyi |
| `tests/ui-guards.test.mjs` + `tests/support/ui-guards.mjs` | aturan §3.8; `rootColourTokens` tetap membaca `:root` di luar layer |
| `tests/licenses.test.mjs` | dependensi §3.1 (test-first) |
| `tests/entry-pages.test.mjs` | login dan landing (copy "panel Hasil" hilang) |
| `tests/proxy-matcher.test.mjs` | `/api/locale` (Fase 1), undangan/reset (Fase 6) |
| `tests/dashboard-choices.test.mjs`, `layout-names`, `look-preview`, `help-guide`, `project-view`, `dashboard-view`, `clip-library-view`, `trend-view`, `llm-settings-view`, `system-info`, `help-page`, `help-catalog` | deskriptor `{key, values}` + satu snapshot teks `id`; asersi setara, tidak dihapus |
| e2e `dashboard`, `focus`, `project-workspace`, `history-clips`, `trends`, `settings-*`, `bantuan`, `app-shell`, `header-badge`, `smoke`, `read-only`, `cancel-job`, `clip-text`, `clip-hook` | selector role + nama lewat helper `e2e/support/i18n.mjs` `L(key)` **(baru)**; `selectOption` → `Select`; checkbox → switch |
| `playwright.config.mjs` | `use.locale:"id-ID"` di semua proyek; proyek `mobile-chromium` ikut menjalankan `app-shell.spec`; proyek `en-smoke` (dok i18n) |

Aturan: setiap fase menjalankan `editor-gates.yml` `suite=full`, `suite=e2e`, `suite=player` di GitHub Actions (editor, parity-text, screenshot editor tanpa diff). Di PC pemilik hanya tes unit yang ditargetkan.

---

## 9. Peta file

**Baru:**
- `web/app/ui.css`, `web/postcss.config.mjs`, `web/components/ui/date-picker.css`
- `web/components/ui/{Providers,PublicCard,SearchField,Modal,Drawer,CloseButton,Table,TagGroup,Pagination,DatePicker,Toast,Disclosure,PageHead,StatusPill,EmptyState,LoadError}.jsx`
- `web/components/{NavList,AccountMenu,ChoiceChip,ClipViewer,PublishDrawer,ClipPosts}.jsx`, `web/components/analytics/DailyChart.jsx` (+ `.module.css`)
- `web/lib/{ui-features,ui-prefs,app-shortcuts,status-view,publish-drawer-view,social-view,analytics-view,account-view,admin-view}.mjs` (view murni untuk tes §8.1; `web/lib/social/view.mjs` milik dok 03)
- `web/app/{sosial,analitik,akun,admin,login}/layout.jsx`, `web/app/undangan/[token]/layout.jsx`, `web/app/atur-ulang-sandi/[token]/layout.jsx` (namespace per dok i18n §8.2) dan halaman: `sosial/page.jsx`, `analitik/page.jsx`, `akun/page.jsx`, `akun/kata-sandi/page.jsx`, `undangan/[token]/page.jsx`, `atur-ulang-sandi/[token]/page.jsx`, `admin/pengguna/page.jsx`, `admin/pengguna/[userId]/page.jsx`, `admin/job/page.jsx`
- tes dan e2e di §8.1

**Diubah:**
- `web/package.json`, `web/app/globals.css`, `web/app/layout.jsx`
- `web/components/AppShell.jsx`, `web/components/JobBadge.jsx` (copy), `web/components/CancelJob.jsx`, `web/components/ClipText.jsx`, `web/components/ClipLibrary.jsx`, `web/components/HookSwitch.jsx` (diganti `Switch`), `web/components/NotFoundActions.jsx`, `web/components/StageSummary.jsx`
- `web/lib/{app-nav,app-icons,dashboard-choices,layout-names,project-view,dashboard-view,login-view,help-guide,llm-presets}.mjs` (`dashboard-choices`: + `choicesFromJob`; `login-view`: `loginErrorMessage` → `loginErrorKey`)
- `web/app/{dashboard,projects,projects/[id],trends,settings,bantuan,login,licenses}/page.jsx`, `web/app/{not-found,error,global-error,page}.jsx`, `web/app/settings/{DefaultLogoCard,DefaultWatermarkCard,TranscriptionCard,YoutubeCookiesCard}.jsx`, `web/components/trends/*.jsx`
- `docs/design/TOKENS.md` (alias, pasangan kontras baru, `rounded-xl`, `ease-out`), `DESIGN.md` (amandemen Q1)

**Dihapus:** `menuReducer`/`menuButtonView` dari `web/lib/app-menu.mjs` (konstanta breakpoint tetap), kelas `.appScrim`, `.table`, `.tableWrap`, `.card`, `.chip*` (→ `.statusPill`), `.notice*`, `.segmented*`, serta `.btn*` kecuali versi minimal untuk `global-error`.

### 9.1 Amandemen DESIGN.md (Q1, final)

Bagian "Pola tata letak" diganti:
- **Navigasi:** sidebar datar tanpa label kelompok (Buat klip, Proyek, Sosial, Analitik, Tren, Pengaturan, Admin, Bantuan), item muncul per peran/flag, dan menu akun (Akun, Bahasa, Pintasan, Keluar) di bawah.
- **Kepala halaman:** judul + aksi, **tanpa kalimat**.
- **Buat klip:** chip bernilai + Popover, menggantikan tiga lipatan.
- **Komponen:** HeroUI v3 di atas token Potongin; terpilih tidak memakai lime; dua set kata status.
- **Editor:** satu layout, pratinjau di depan, satu panel kanan terbuka (5 tab), dan "Lanjutan" tertutup dengan ringkasan. Mode Cepat/Lengkap dihapus.
- **Bahasa:** copy dari katalog (`web/messages/id/*.json` sebagai sumber, dok 07 §2.2), pendek, label di semua locale, dengan glosarium.
- **Istilah:** Terbitkan / Terbit.

---

## 10. Celah yang belum terselesaikan

Hanya butir yang masih terbuka. Keputusan default yang sudah tertulis di badan dokumen (batch Terbitkan ditunda per Q7, §6.5; tren member baca saja per dok 02 §2.1, §6.9; admin hanya melihat metadata per Q3, §6.12; [Proses ulang] = prefill `/dashboard?ulang=`, §6.3; copy `en` direview pemilik per fase per Q9) tidak lagi dicatat di sini.

### 10.1 Terbuka di dokumen ini

| # | Celah | Usulan sementara |
|---|---|---|
| G2 | Nama kelas BEM, nama file CSS komponen, compound API, dan enum prop (§3.3, §3.5, §3.7) diverifikasi terhadap `@heroui/react`/`@heroui/styles` **3.1.0** (salinan lokal), bukan 3.2.6; begitu pula hitungan 89 variabel (§3.4) dan `shouldForceMount` di `Tabs.Panel` (dok 08 §11 butir 9). | Spike F0 mengulang terhadap 3.2.6; `ui-foundation` me-resolve impor; tes e2e berbasis ukuran dan warna tetap berlaku apa pun nama kelasnya |
| G5 | `--overlay-shadow` dan `--disabled-opacity` belum punya nilai yang sudah dicek kontrasnya. | Diputuskan di spike F0 dan dicatat di TOKENS.md |
| G12 | Teks persetujuan musik TikTok (`social.tiktok.consent`) adalah kutipan wajib platform. | Diisi dari hasil SOS-M0 (dok 03 §11.6) |

### 10.2 Konflik dengan dokumen lain

Tidak ada lagi. K1–K12 diselesaikan pada pemeriksaan silang akhir 2026-10-24 ([00-README.md](00-README.md) §8): 08 mengikuti §3.3, §3.9, §5, §6.7 (K1–K4); 07 §7.1/§10.2 memakai lima kata `status.post.*` dan `user_storage_quota` (K5–K6); preferensi = satu route `GET/PATCH` dengan `trendsEnabled?`/`timeZone?` (02 §8.2, K7, tabel §6.11 sudah diubah); form terima undangan memuat `locale` dengan default `invites.locale` (02 §6.3, K8, §6.11 sudah diubah); `GET /api/admin/jobs` = `{jobs, paused, concurrency}` (02 §8.2, K9); error form connect = 303 `?hasil=gagal` (03 §7.1, K10); kode DST `social_time_nonexistent` (03 §8, K11); `GET /api/performance/template.csv` (03 §9.3, K12).
