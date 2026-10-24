## Koreksi

| # | Severity | Masalah | Perbaikan |
|---|---|---|---|
| 1 | Kritis | §5.2 menyebut `derive.py` sebagai tempat logika gabung klip. Isi file itu pembuatan bitmap logo (`src/ai_clipper/edit_v2/derive.py:1-8`). Rencana juga menulis "undo gabung = soft delete lewat `janitor.py`". Itu tidak mungkin: janitor tidak pernah menghapus seed atau klip (`janitor.py:8-10`). Selain itu, `clip_id` dihitung dari sha sumber + start/end (CONTRACTS §3.5), `base.origin.kind` = `v3_clip`, dan daftar klip berasal dari manifes pipeline (`api.py:325 _manifest_entries`). Manifes itu dibaca halaman proyek, Riwayat (§5.32), ZIP (§5.28), saklar hook (§5.57) dan judul/deskripsi (§5.38). | Buat registri klip turunan sendiri (`analysis/derived-clips.json`) dengan namespace id baru dan `origin.kind` baru (amendemen). Tambah op `delete_derived_clip`. Semua pembaca daftar klip ikut diperbarui. Estimasi fase 7 naik dari 6 ke 12 hari. |
| 2 | Tinggi | §5.1 salah membaca kompiler. Rencana bilang `select` tidak bisa mengurutkan ulang, jadi butuh jalur `trim`+`concat` baru. Kenyataannya R2 sudah memecah lompatan mundur menjadi decoder run terpisah lalu digabung dengan `concat`; cold open sudah memakai jalur ini (`compile_ffmpeg.py:293-304`, `:509-513`). `timemap.pieces` juga sudah menangani N segmen berurutan (`timemap.py:97-126`), dan `removals.seg` sudah ada. Risiko yang sebenarnya ada dua. Pertama, setiap body yang mundur atau berjarak ≥ 10 dtk menambah satu input `-ss` dengan decoder sendiri di bawah `RLIMIT_AS` 3 GiB (`execute.py:53`). Kedua, validator mengasumsikan tepat satu body (`doc.py:927-975`, `:1097-1144`): `body_index`, durasi 3–300 dtk per body, dan aturan cold open terhadap body. | Tidak perlu jalur graf baru. Batasi jumlah body lewat pengukuran: mulai dari 8, tambah PF-SEG (memori dan waktu dengan 8 body mundur). Antar-body tidak memakai `joins`; cukup `cut_fade_ms`. Aturan durasi berlaku untuk jumlah semua body. Aturan cold open dihitung terhadap body pertama di keluaran. |
| 3 | Tinggi | Pertanyaan terbuka 1 (id kata ganda) sudah punya preseden. Kata di cold open dan body sudah muncul dua kali: `speech_spans` memetakan per segmen (`timemap.py:236-258`) dan kunci baris caption sudah `<seg>:<firstWordId>` (CONTRACTS §5.27, caption-lines). Yang belum ada: pilihan di transkrip untuk segmen duplikat. | Putuskan: `word_edits` berlaku di semua salinan (sama dengan cold open). Pilihan dan `RemoveWords` membawa `seg`. Transkrip ditampilkan per segmen dalam urutan keluaran, dan kata yang terduplikat tampil dua kali. Pertanyaan 1 dihapus. |
| 4 | Tinggi | Preset ekspor: | Platform preset dihapus. Untuk dokumen 1080 saja ditambah satu pilihan "Ukuran: Asli · 720p" (skala di akhir rantai, ASS tidak berubah). Field `size` di render request sudah dicadangkan (CONTRACTS §5.17: `size "output"`, `quality "standar"`). Ekspor 720p tidak memakai R10. P-ENC ditambah fixture skala turun. Pertanyaan 3 dihapus; rasio tetap terkunci di seed. |
| | | • Rencananya bertentangan dengan dirinya sendiri: "skala di akhir rantai" sekaligus "ASS dirender ulang pada ukuran itu". | |
| | | • Job 720 mengunduh sumber maksimal 720p (§5.54), jadi 1080 hanya upscale. | |
| | | • R10 (file otomatis) hanya berlaku pada ukuran dokumen. | |
| | | • Preset SupoClip hanya beda bitrate (12M lawan 10M), jadi label TikTok/Reels/Shorts kosmetik. | |
| 5 | Tinggi | "Bingkai pindah ke pratinjau" tidak cocok dengan cara kerja gizmo. `FrameGizmo` menggambar kotak 9:16 di atas still **sumber**, dan setiap keyframe meminta plate baru (`gizmos/FrameGizmo.jsx:3-11`). Pratinjau menampilkan keluaran, sehingga bagian sumber di luar potongan tidak terlihat saat menyeret. | Pertahankan tampilan sumber, tapi bukan sebagai modal. Tombol "Lihat sumber" di pratinjau mengganti stage ke still sumber + gizmo. `FrameGizmo` dan `SplitGizmo` dipakai ulang. Estimasi 4a turun ke 4 hari. |
| 6 | Tinggi | Per shot (`layout.ranges`): R4 memasang satu rantai layout setelah semua potongan digabung. Pergantian mode per frame baru terbukti untuk ikuti wajah ↔ latar blur (§5.40, saklar `if(lt(n,K))`). Potong tengah ↔ layar terbagi belum terbukti, dan rantai per potongan pernah gagal di 3 GiB. `scene_cuts_ms` bisa kosong pada job lama (§3.6). `apply_all` grup layout harus mengecualikan ranges, seperti keyframes (§5.53). | Mode per shot dibatasi ke Ikuti wajah, Potong tengah dan Latar blur, dengan teknik saklar §5.40. Layar terbagi hanya untuk seluruh klip. `keyframes` tetap di root (berbasis frame sumber). Job tanpa potongan adegan = satu shot. Grup layout di apply-all mengecualikan `ranges`. |
| 7 | Sedang | Rencana memakai `schema_minor: 1`. Minor baru membuat editor lama mendapat 426 "muat ulang editor" (§3.3), padahal semua fitur sejak 2026-10-02 masuk sebagai amendemen minor-0 aditif (§3.8). | Segmen ganda, ranges dan klip turunan masuk sebagai amendemen minor-0 opsional. Server lama menolak dengan `range_invalid`/`unknown_key`. |
| 8 | Tinggi | Nama tab baru membingungkan. "Bingkai" bertabrakan dengan "Atur bingkai". "Pembuka" mengganti "Cold open", yang dipakai di toolbar kata, U3 dan Bantuan. Dashboard memakai Layout / Tata letak (DESIGN.md). Selain itu ada 66 pemanggilan `getByRole("tab")` di 19 spec, bukan sekitar 15. | Nama tab: **Teks · Tata letak · Audio · Logo · Cold open** (hanya "Musik" yang berganti jadi "Audio"). |
| 9 | Tinggi | DESIGN.md (Pola tata letak) menetapkan Mode Lengkap/Cepat, dan HANDOFF §1 menyatakan Mode Cepat bawaan. Menghapusnya mengubah arah desain milik pemilik. | Fase 0 memperbarui DESIGN.md §Editor dengan persetujuan pemilik sebelum kode dimulai. |
| 10 | Sedang | Klaim jumlah klik dan kontrol: | Tabel klik dikoreksi (§3). Klaim 190→70 diganti hitungan nyata di fase 1 (snapshot DOM `button, [role]` sebelum/sesudah). |
| | | • Top bar "10→7" tidak benar. "Kembali ke versi AI" dan "Pintasan" sudah ada di menu Lainnya (`TopBar.jsx:35-38`). Rencana justru menambah ▾ judul, avatar, antrean dan split button. | |
| | | • Musik/logo bukan 2 klik (ada pemilih file OS dan catatan hak cipta). | |
| | | • Per shot bukan 2 (Select = 2 klik). | |
| | | • Gabung bukan "3 + konfirmasi" (= 4). | |
| | | • Terbit bukan 3–4 (≥ 5). | |
| | | • Pisah bukan 1 (seek dulu). | |
| | | • "Mulai/Akhiri di sini" tidak konsisten: 3c menulis B/2, 3d menulis Lainnya/3. | |
| | | • "190→70" tidak diukur. | |
| 11 | Sedang | Pintasan: | Pisah tanpa pintasan global baru di rilis pertama; pintasan dipilih setelah uji bentrok di Chrome, Firefox dan Edge. Tambah saklar "Pintasan satu tombol" di modal Pintasan. Ctrl+Shift+E dicatat di peta. |
| | | • Ctrl+Shift+S dipakai Firefox untuk tangkapan layar. | |
| | | • Pintasan satu tombol yang ada (K, I, O, `'`, `?`, Delete, Enter; `shortcuts.mjs:11-31`) tetap melanggar WCAG 2.1.4 tanpa cara mematikan. | |
| | | • Ctrl+Shift+E (Ekspor) tidak masuk peta. | |
| 12 | Sedang | Mengganti centang per peringatan (`ExportDialog.jsx:126-140`) dengan satu "Ekspor tetap" mengubah kontrak §3.7 ("export asks for acknowledgement"). Menyembunyikan "Perlu dicek" saat n = 0 membuat Catatan (severity info: `no_face_blur`, area aman K5) kehilangan tempat, dan fokus bisa hilang saat tombol lenyap. | Butuh amendemen §3.7 dengan izin pemilik, dan `editor-export-flow.test.mjs` diperbarui. Tombol bernama "Perlu dicek n" kalau ada cek, "Catatan n" kalau hanya catatan, dan tidak tampil kalau keduanya 0. Kalau tombol yang sedang fokus hilang, fokus pindah ke Ekspor. |
| 13 | Sedang | "Edit naskah" + `script-diff.mjs` menduplikasi `caption-lines.mjs`, yang sudah punya LCS: token tambahan menumpang ke kata induk dan kata yang dihapus disembunyikan (§5.27). Menghapus kata di naskah hanya menyembunyikannya dari caption, bukan memotong, sehingga mudah disalahpahami. | Modal Edit naskah dihapus. Tampilan "Baris" di transkrip memakai `lineEdit`/`commitLine` dan sudah setara edit naskah. |
| 14 | Sedang | HeroUI v3: | Pakai `react-aria-components` langsung untuk ketiganya (dijadikan dependensi eksplisit). Port aturan forced-colors yang ada ke komponen HeroUI. Tailwind v4 diimpor tanpa preflight, dengan `@layer` di bawah CSS Modules editor. |
| | | • Dokumentasi `ListBox` tidak menyebut drag-and-drop maupun orientasi horizontal. | |
| | | • `GridList` dan `FileTrigger` tidak ada di HeroUI v3 React. | |
| | | • Dokumentasi `ToggleButtonGroup` tidak menyinggung forced-colors, padahal editor memakai garis bawah untuk keadaan terpilih (`ui/ui.module.css:478-482`). | |
| | | • Preflight Tailwind v4 me-reset gaya global yang dipakai CSS Modules. | |
| 15 | Sedang | Bantuan badge dan pengajaran pintasan hanya lewat `Tooltip`. Tooltip tidak bisa dipakai di layar sentuh dan tidak bisa ditemukan pembaca layar sebagai konten. | Bantuan badge memakai `Popover` dari tombol (i). Tooltip hanya mengulang label. |
| 16 | Sedang | Multi-user: login sekarang satu akun (`web/lib/auth.mjs`, `APP_USERNAME`). `audit.editor` berisi id editor (`commands.mjs:1150`), bukan pengguna. | Id pengguna disimpan di receipt simpan (`store.py`), bukan di dokumen. Fitur kehadiran bergantung pada rencana akun paralel. |
| 17 | Rendah | "Antrean ekspor tetap berjalan saat tab ditutup" disebut fitur baru. Render sudah berjalan di server lewat `render_queue`. | Yang baru hanya Popover antrean. |
| 18 | Sedang | "Rapikan 4" bisa terbaca sebagai pra-centang. Pra-centang kata pengisi tetap mati sampai pemilik setuju (HANDOFF §2). | Angka = jumlah temuan. Default tetap: jeda senyap tercentang, pengisi tidak (`cleanup-model.mjs:38-48`). |
| 19 | Sedang | Fitur yang hilang atau tidak jelas di peta: | Ditambahkan di §3; efek warna ditunda (§8). |
| | | • "di sumber mm:ss" dan Ctrl+klik Kata kunci (§5.55). | |
| | | • Ctrl+Shift+E. | |
| | | • Catatan (info). | |
| | | • Format `Judul klip ▾` tidak didefinisikan; Ubah/Tulis ulang judul ada di halaman proyek (§5.38). | |
| | | • Efek SupoClip (kecerahan, kontras, saturasi, blur, hue, bisu) tidak dibahas. | |
| 20 | Sedang | Tinggi layar 1366×768: pratinjau, transport, segmen dan transkrip ditumpuk di kolom tengah. Label "PRATINJAU 9:16" juga salah untuk klip 1:1, yang tidak punya Zona aman (§5.54). | Di lebar ≥ 1440 px transkrip berada di samping pratinjau; di bawah itu ditumpuk. Uji screenshot pada 1366×768. Label rasio mengikuti `doc.output`. |
| 21 | Rendah | Rencana menulis smoke dijalankan di `editor-gates.yml`. Smoke berjalan di setiap PR lewat `ci-cd.yml`, full nightly; `editor-gates.yml` hanya dispatch manual (`run_all.sh:9-20`). | Teks diperbaiki. |
| 22 | Sedang | Estimasi melewatkan beberapa pekerjaan: | Total direvisi ke sekitar 81 hari (§6). |
| | | • Amendemen CONTRACTS dan GATES per fitur. | |
| | | • Stopwatch pemilik untuk U1–U10. | |
| | | • Fase 0 (HeroUI + Tailwind berdampingan, audit forced-colors) terlalu kecil. | |
| | | • Fase 7 terlalu kecil (lihat #1). | |
| | | • Fase 9: performa player dan JASSUB di ponsel belum pernah diukur. | |
| 23 | Rendah | Clean-room: dokumen produk mengutip file internal SupoClip (`social_service.py`) dan klaim "menerbitkan file asli" belum terverifikasi (kode mereka memakai `file_path` klip). | Kutipan internal SupoClip dihapus dari dokumen Potongin. Nama fitur SupoClip ("Combine", "Edit script") tidak dipakai di UI. |
| 24 | Rendah | Copy masih berbentuk kalimat: "Kata caption: lihat transkrip" dan "Terlalu berbeda, edit per kata". | Diganti tombol "Edit per baris". Pesan kedua hilang bersama Edit naskah. |

---

# Rancangan ulang editor Potongin: lengkap tapi semudah SupoClip (revisi)

Disusun tanpa mengubah, memasang, membangun atau menjalankan apa pun. Path relatif terhadap `root repo`.

**Sumber yang dicek:**
- `AGENTS.md`, `DESIGN.md`, `docs/HANDOFF.md`
- `docs/editor/CONTRACTS.md` (§3, §3.8, §5.17, §5.27, §5.40, §5.44, §5.53, §5.54, §5.55)
- `docs/editor/UJI-PENERIMAAN.md`
- `src/ai_clipper/edit_v2/{doc,timemap,compile_ffmpeg,derive,janitor,api,execute}.py`
- `web/lib/editor/{commands,shortcuts,history,caption-lines,view-mode}.mjs`
- `web/components/editor/*`
- `scripts/parity/run_all.sh`
- Dokumentasi HeroUI v3 (`llms.txt`, ListBox, ToggleButtonGroup)

**Aturan:**
- Clean-room: hanya alur SupoClip yang dipelajari.
- Teks layar berbahasa Indonesia dan berupa label.
- "Latest only".
- DESIGN.md §Editor diperbarui dengan persetujuan pemilik **sebelum** fase 1.

## 1. Prinsip

1. **Satu layout, pengungkapan bertahap.** Cepat dan Lengkap dihapus. Pratinjau dan transkrip selalu terlihat.
2. **Satu panel kanan terbuka sekaligus.** Lima tab: **Teks · Tata letak · Audio · Logo · Cold open**. Teks terbuka saat editor dibuka.
3. **Pilih gaya dulu, detail kemudian.** Kartu pilihan di atas, kontrol halus di `Disclosure` **Lanjutan** dengan ringkasan pilihan di judulnya.
4. **Tugas umum ≤ 3 klik, lanjutan ≤ 5.** Klik dihitung termasuk dialog OS dan Select (§3).
5. **Peringatan sebagai daftar** dengan Perbaiki dan Lihat. Tombol top bar hanya tampil kalau ada cek atau catatan.
6. **Label, bukan kalimat.** Penjelasan teknis masuk log. Bantuan penting memakai `Popover` dari tombol (i), bukan hanya `Tooltip`.
7. **Manipulasi langsung, dengan padanan keyboard.**
   - Tidak ada pintasan satu tombol yang baru.
   - Pintasan satu tombol yang sudah ada bisa dimatikan (WCAG 2.1.4).
8. **Semua bisa diurungkan, dan pratinjau = hasil akhir.**
   - Gabung dan pisah jadi klip membuat klip baru, yang bisa dihapus.
   - Gate paritas tidak boleh turun mutunya.
   - Dokumen lama harus menghasilkan plan dengan byte yang sama.

## 2. Layout

### Desktop

- **≥ 1440 px:** kolom Klip | (Pratinjau ‖ Transkrip) | Panel.
- **1280–1439 px:** Pratinjau di atas Transkrip.
- **1024–1279 px:** kolom Klip dilipat jadi ikon.
- **Uji wajib:** screenshot 1366×768 dan 1920×1080.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ ← Proyek │ Klip 3/8 ‹ › Judul │ ● Tersimpan ↶ ↷ │ [Perlu dicek 2] [⇣1] ⋯ │ [Ekspor][▾] │
├──────────┬───────────────────────────────┬──────────────────────────────────────┤
│ KLIP (8) │ PRATINJAU (rasio doc.output)  │ [Teks][Tata letak][Audio][Logo][Cold open] │
│ ☐ #1 0:42│  ▶ 00:12,3/00:41,0 ‹ ›        │ Gaya caption (6 kartu)                │
│ ☐ #2 0:31│  di sumber 21:04 · Zona aman ☐│ Ukuran ○○● Posisi ○○●                 │
│ …        │  Frame akhir ☐ · Lihat sumber │ Warna sorot ●●●●●●                    │
│          │ SEGMEN [1][2] ＋ Pisah Duplikat│ ▸ Lanjutan · Pop · 2 kata             │
│[Gabungkan│ TRANSKRIP [Rapikan 4][Ejaan 2]│ Hook [on] [teks 42/90]                │
│  2 klip] │  [Kata | Baris]               │ ▸ Lanjutan · Bar · 3 dtk              │
│          │ ▸ Linimasa detail             │ [Pakai di semua klip]                 │
└──────────┴───────────────────────────────┴──────────────────────────────────────┘
```

**Top bar (11 kontrol):**
- ← Proyek, klip ‹ ›, judul (teks saja; ubah judul tetap di halaman proyek)
- Status simpan, ↶ ↷
- Perlu dicek / Catatan, kondisional
- Antrean ⇣n, kondisional
- Menu ⋯: Kembali ke versi AI, Pintasan keyboard
- Ekspor + ▾: Ekspor semua, Terbitkan
- Avatar pengguna lain, hanya kalau ada

Tidak ada pilihan Cepat/Lengkap.

### Tablet (768–1023 px)

- Pratinjau, Segmen dan Transkrip ditumpuk.
- Bar tab bawah membuka `Drawer`.
- Linimasa detail tetap tersedia dalam keadaan terlipat.

### Ponsel (< 768 px), fase terakhir

- Hanya **Tinjau, edit kata, gaya caption, Cold open on/off, Terbitkan**.
- Tanpa gizmo, Linimasa dan segmen.
- Syarat: PF-PLAY dan PF-SEEK lolos di satu ponsel kelas menengah.

## 3. Peta fitur

**Keterangan kolom:**
- **Letak:** B = dasar; L = Lanjutan atau Linimasa detail.
- **Klik:** dihitung dari editor terbuka di tab Teks.
- **RAC:** `react-aria-components` langsung, karena tidak ada di HeroUI v3.

### 3a. Shell dan top bar

| Fitur | Sumber | Letak | Komponen | Klik |
|---|---|---|---|---|
| ← Proyek | `TopBar.jsx:41` | B | `Link` | 1 |
| Pindah klip ‹ ›, Ctrl+Shift+←/→ | `TopBar.jsx:42-57` | B + daftar Klip | `Button`, `ListBox` | 1 |
| Status simpan, Coba simpan lagi | `TopBar.jsx:58-65` | B | `Chip` | 0–1 |
| Tab lain / kehadiran | `TopBar.jsx` | B (avatar setelah ada akun) | `AvatarGroup` | 0 |
| Urungkan / Ulangi | `TopBar.jsx` | B | `ButtonGroup` | 1 |
| Perlu dicek n / Catatan n | `ChecksPanel.jsx`, `shell-model.mjs` | B, kondisional; fokus pindah ke Ekspor kalau tombol hilang | `Button` + `Popover` | 1 |
| Kembali ke versi AI | Lainnya (sudah) | ⋯ | `Dropdown` + `AlertDialog` | 3 |
| Pintasan keyboard; saklar "Pintasan satu tombol" | Lainnya, `?` | ⋯ | `Modal` + `Kbd` + `Switch` | 2 |
| Cepat / Lengkap | `ViewSwitch.jsx`, `view-mode.mjs` | Dihapus. `?mode=`, `?card=` dialihkan, `?panel=` dipetakan | – | – |
| Menyiapkan klip | `EditorApp.jsx` | Layar tunggu | `ProgressBar`, `Skeleton` | 0 |
| Baca-saja, Mulai dari versi AI | `ReadOnlyBanner.jsx` | B | `Alert` | 1 |
| Konflik per bagian | `ConflictDialog.jsx`, `rebase.mjs` | Tetap | `Modal` + `RadioGroup` | 2–3 |
| Ekspor (Ctrl+Shift+E) | `TopBar.jsx` | B | `Button` | 1 |

### 3b. Pratinjau

| Fitur | Sumber | Letak | Komponen | Klik |
|---|---|---|---|---|
| Badge Sesuai hasil akhir + bantuan | `StageBadge.jsx` | B; bantuan di `Popover` (i) | `Chip`, `Popover` | 0–1 |
| Frame akhir (Ctrl+Shift+R) | `StageControls.jsx` | B | `ToggleButton` | 1 |
| Zona aman (`'`), tidak ada di 1:1 | `StageControls.jsx` | B | `ToggleButton` | 1 |
| Putar/jeda, frame ‹ ›, waktu, "di sumber mm:ss" | `StageControls.jsx`, §5.55 | B | `Toolbar` | 1 |
| Scrubber + tanda | `scrubber/Scrubber.jsx` | B | Kustom (Slider HeroUI tidak menggambar penanda) | 1 |
| Gizmo caption | `gizmos/CaptionGizmo.jsx` | B | Kustom | 1 seret |
| Gizmo logo | `gizmos/LogoGizmo.jsx` | B saat tab Logo aktif | Kustom | 1 seret |
| **Lihat sumber** (stage ganti ke still sumber + kotak bingkai / dua potongan) | `FrameGizmo.jsx`, `SplitGizmo.jsx` (pindah dari dialog) | B di tab Tata letak, kalau mode mendukung | Kustom + `ToggleButton` | 2 |

### 3c. Segmen dan klip

| Fitur | Status | Letak | Komponen | Klik |
|---|---|---|---|---|
| Mulai / Akhiri di sini, I/O | Ada | Toolbar kata, B | `Toolbar` | 2 |
| Pegangan trim, ±0,1 dtk | Ada | Linimasa, L | Kustom + `NumberField` | 3 |
| Pisah di playhead | Baru | Strip Segmen, B; tanpa pintasan dulu | `Button` | 2 (seek + Pisah) |
| Duplikat segmen | Baru | B | `Button` | 2 |
| Urutkan segmen (← → dan seret) | Baru | B | RAC `GridList` horizontal + DnD, tombol ← → + live region | 2 |
| Hapus segmen (nonaktif kalau tinggal 1) | Baru | B | `Button` | 2 |
| Jadikan klip baru | Baru | Menu chip, L | `Dropdown` | 3 |
| Gabungkan klip | Baru | Daftar Klip, B | RAC `GridList` multi-select, `Modal` | 4 |
| Duplikat klip, Hapus klip turunan | Baru | Menu baris klip | `Dropdown` + `AlertDialog` | 2–3 |

### 3d. Transkrip

| Fitur | Sumber | Letak | Komponen | Klik |
|---|---|---|---|---|
| Seek, pilih (seret / Shift / panah) | `TranscriptPanel.jsx`, `selection.mjs` | B, per segmen dalam urutan keluaran | Kustom (pola grid) | 1 |
| Hapus / Pulihkan / Perpanjang ke sini | `word-toolbar.mjs` | Toolbar, B | `Toolbar` | 2 |
| Edit kata (Enter, dobel klik) | `WordEditor.jsx` | Toolbar, B | Inline | 2 |
| Mulai / Akhiri di sini | `word-toolbar.mjs` | Toolbar, B | `Button` | 2 |
| Kata kunci (Ctrl+E, Ctrl+klik) | §5.55 | Toolbar → Lainnya; Ctrl+klik | `Dropdown` | 3 / 1 |
| Sembunyikan dari caption (Ctrl+Shift+X) | Ada | Lainnya | `Dropdown` | 3 |
| Jadikan cold open (Ctrl+Shift+H) | Ada | Lainnya | `Dropdown` | 3 |
| Chip Pulihkan | `RemovalChip.jsx` | B | `Chip` | 1 |
| ＋3 kalimat | `TranscriptPanel.jsx` | B | `Button` | 1 |
| Rapikan (default: jeda senyap tercentang, pengisi tidak) | `CleanupReview.jsx` | B → `Drawer` | `Drawer`, `CheckboxGroup` | 3 |
| Cek ejaan | `spelling/` | Drawer yang sama, tab 2 | `Tabs` | 3 |
| **Kata \| Baris** (Baris = edit naskah per baris caption, satu urungkan per baris) | `caption-lines.mjs` (dipindah dari `quick/CaptionLinesCard.jsx`) | B | `ToggleButtonGroup` | 1 + ketik |

### 3e. Tab Teks

| Fitur | Letak | Komponen | Klik |
|---|---|---|---|
| Caption on/off | B | `Switch` | 1 |
| 6 paket (Klasik, Karaoke, Bold, Box, Sorot, Sinar) | B, kartu bergambar | `RadioGroup` + `Card` | 1 |
| Ukuran / Posisi: 3 pil + seret | B; slider halus di L | `ToggleButtonGroup`, `Slider` | 1 / 2 |
| Geser dari wajah | B, kondisional | `Button` | 1 |
| Warna sorot | B | `ColorSwatchPicker` | 1 |
| Kata per baris, Animasi masuk, Huruf besar, Warna kata kunci | L | `ToggleButtonGroup`, `Switch`, `ColorSwatchPicker` | 2 |
| Hook on/off, teks n/90, "Akan terpotong" | B | `Switch`, `TextArea` | 1–2 |
| Saran hook (Perbarui, Pakai) | B | `ListBox` | 2 |
| Desain hook, durasi, posisi | L | `RadioGroup`, `Slider` | 2 |
| Edit per baris (lompat ke transkrip mode Baris) | B | `Button` | 1 |
| Pakai di semua klip (Caption) | B | `Button` → `AlertDialog` → `Toast` Urungkan | 2 |

### 3f. Tab Tata letak

| Fitur | Letak | Komponen | Klik |
|---|---|---|---|
| 4 mode bergambar | B | `RadioGroup` kartu | 1 |
| Progres analisis, Coba lagi | B | `ProgressBar` | 0–1 |
| **Strip shot** (mode otomatis per shot; ganti ke Ikuti wajah / Potong tengah / Latar blur; tanda "Tanpa wajah", "Diubah") | B; hanya kalau mode bukan Layar terbagi dan ada potongan adegan | RAC `GridList` + `Select` | 3 |
| Otomatis (per shot) | B pada shot yang diubah | `Button` | 1 |
| Lihat sumber → seret bingkai; Perpindahan (Potong/Geser) di Popover titik | L | Gizmo + `Popover` | 3 |
| Kembali ke otomatis (seluruh klip) | L | `Button` | 2 |
| Zoom 100–150 % | L | `Slider` | 2 |
| Layar terbagi: pembagian, tukar (B); potongan lewat Lihat sumber; perbesar (L) | B/L | `ToggleButtonGroup`, `Slider` | 1–3 |
| Bagian tanpa wajah: Latar blur / Dipusatkan | B saat Ikuti wajah | `RadioGroup` | 1 |
| Pakai di semua klip (tanpa keyframes dan shot) | B | `Button` + `AlertDialog` | 2 |

### 3g. Tab Audio

| Fitur | Letak | Komponen | Klik |
|---|---|---|---|
| Tambah musik (pilih file + hak cipta) | B | RAC `FileTrigger`, `AlertDialog` | 3–4 |
| Ganti / Hapus musik | B | `Button` | 2 |
| Volume musik, reset | B | `Slider` | 1 |
| Kecilkan saat bicara: on + kekuatan | B | `Switch`, `ToggleButtonGroup` | 1 |
| Detail ducking ×4, Mulai dari, Ulangi, Fade | L | `Slider`, `NumberField`, `Switch` | 2–3 |
| Volume suara asli; Samakan kenyaringan | B | `Slider`, `Switch` | 1 |
| Gelombang suara, jalur musik | Linimasa, L | Kustom | – |

### 3h. Tab Logo

| Fitur | Letak | Komponen | Klik |
|---|---|---|---|
| Tambah logo (file) | B | RAC `FileTrigger` | 3 |
| Ganti / Hapus | B | `Button` | 2 |
| 4 sudut, seret dan ubah ukuran | B | `ToggleButtonGroup`, gizmo | 1 |
| Ukuran, opasitas | L | `Slider` | 2 |
| Geser ke area aman | B, kondisional | `Button` | 1 |
| Teks watermark: teks (B); posisi, ukuran, opasitas (L) | B/L | `TextField`, `RadioGroup`, `Slider` | 2 |
| Pakai di semua klip | B | `Button` + `AlertDialog` | 2 |

### 3i. Tab Cold open

| Fitur | Letak | Komponen | Klik |
|---|---|---|---|
| On/off, Putar, Hapus | B | `Switch`, `Button` | 1 |
| Saran (Putar, Pakai) | B | `ListBox` | 2 |
| Awal ±kata, Akhir ±kata | B | `NumberField` | 1 |
| ±0,1 dtk | L | `NumberField` | 2 |
| Transisi (Potong langsung, Kilat putih, Gelap sebentar), whoosh, Putar transisi | B | `ToggleButtonGroup`, `Switch` | 1 |

### 3j. Linimasa detail (L, terlipat)

- 6 jalur dan pegangan trim, dengan ← → (celah kata) dan Shift (0,1 dtk).
- Zoom −/+ dan Paskan.
- Saklar penanda tawa, jeda dan potongan adegan.
- Membukanya 1 klik.

### 3k. Ekspor dan terbit

| Fitur | Letak | Komponen | Klik |
|---|---|---|---|
| Ekspor klip ini | Ekspor → `Modal` → Mulai ekspor | `Modal` | 2 |
| Ringkasan (ukuran, durasi, audio, perkiraan berkas) | Modal, B | `Card` | 0 |
| **Ukuran: Asli · 720p**, hanya untuk dokumen 1080 | Modal, L | `RadioGroup` | 3 |
| Cek di ekspor: error memblokir; peringatan sebagai daftar Perbaiki/Lihat + satu "Ekspor tetap" (perlu amendemen §3.7) | Modal | `Alert` | +1 |
| Progres, batal, coba lagi | Modal + Popover antrean | `ProgressBar` | 1 |
| Unduh MP4 / SRT; Salin judul, deskripsi, hashtag | Setelah selesai | `Button`, `Dropdown` | 1 |
| Ekspor sebelumnya | L | `Table` | 3 |
| Ekspor semua (semua tercentang) | Ekspor ▾ | `Dropdown`, `Modal`, `CheckboxGroup` | 3 |
| Terbitkan / Jadwalkan | Ekspor ▾ atau setelah selesai | `Drawer`, `Select`, `TextArea`, `DatePicker`, `TimeField` | ≥ 5 |

**Ditunda dengan alasan:**
- Efek warna (kecerahan, kontras, saturasi, hue, blur) ala SupoClip butuh gate paritas warna baru (S-COLOR / P-COLOR) di browser dan FFmpeg.
- "Bisukan suara asli" cukup dengan Volume suara asli di −24 dB.

**Hitungan kontrol** sebelum dan sesudah diukur di fase 1 lewat snapshot DOM, bukan perkiraan.

## 4. Alur utama

1. **Trim lewat transkrip.**
   - Pilih kata → **Hapus** (atau Delete). Muncul chip Pulihkan.
   - Untuk membuang awal/akhir: kata → **Mulai di sini** / **Akhiri di sini** (I/O).
   - **Rapikan n** → tinjau di Drawer → **Terapkan (n)**. Semuanya satu urungkan.
   - Target U2 ≤ 20 dtk.
2. **Ganti gaya caption.**
   - Kartu **Karaoke**, lalu opsional pil Ukuran/Posisi atau seret caption.
   - **Pakai di semua klip** → konfirmasi → Toast "Diterapkan ke 7 · 1 dilewati" dengan Urungkan.
3. **Edit kata caption.**
   - Dobel klik atau Enter → ketik → Enter. Waktu kata tidak berubah.
   - Banyak kesalahan: **Baris** → edit satu baris per field, satu urungkan per baris.
   - Kata yang dihapus di Baris hanya disembunyikan dari caption; suaranya tetap.
   - Target U8 ≤ 20 dtk.
4. **Framing per shot.**
   - Tab Tata letak → klik shot (playhead melompat ke shot itu) → `Select` mode → shot ditandai "Diubah".
   - Opsional: **Lihat sumber**, lalu seret bingkai.
   - **Otomatis** mengembalikan shot ke mode otomatis.
5. **Musik dan logo.**
   - Audio → **Tambah musik** → file → hak cipta. Kecilkan saat bicara aktif (Sedang).
   - Logo → **Tambah logo** → file → sudut.
   - Target U5 ≤ 60 dtk.
6. **Segmen.**
   - **Pisah:** seek → **Pisah**.
   - **Duplikat:** pilih chip → **Duplikat**.
   - **Urutkan:** seret, atau pilih chip lalu ← →.
   - **Hapus:** pilih chip → **Hapus**.
   - **Jadikan klip baru:** chip → ⋯ → **Jadikan klip baru**.
7. **Gabung klip.**
   - Centang ≥ 2 klip (urutan centang = urutan) → **Gabungkan n klip**.
   - Modal urutan; gaya diambil dari klip #1 → **Buat klip**.
   - Hasilnya klip baru; klip asli tetap. Bisa dihapus lewat ⋯ → **Hapus klip**.
8. **Ekspor dan terbit.**
   - **Ekspor** → **Mulai ekspor** → **Unduh** atau **Terbitkan**.
   - Drawer Terbitkan: akun, judul, deskripsi, hashtag, lalu Sekarang atau Jadwalkan.
   - Kalau Terbitkan dipilih sebelum ekspor, ekspor berjalan dulu.
   - API terbit hanya menerima `render_id` yang lolos `verify.py`.
9. **Ekspor semua.**
   - Ekspor ▾ → centang klip → **Ekspor n klip**.
   - Klip tanpa perubahan memakai file otomatis (R10).
   - Unduh ZIP lewat route yang ada (§5.28).

## 5. Backend

Semuanya **amendemen minor-0 aditif** (pola §3.8). Dokumen lama tetap valid dan menghasilkan plan dengan byte yang sama (golden).

### 5.1 Segmen ganda

**Dokumen:**
- `main.segments`: opsional `cold_open` pertama, lalu 1–N `body`. N awal 8; naik hanya setelah pengukuran PF-SEG.
- Body boleh tumpang tindih di sumber (duplikat).
- `removals.seg` sudah ada.
- Tidak ada `joins` antar-body; batas antar-body memakai `cut_fade_ms` (G-CLICK).

**Validator (`doc.py:927-1144`):**
- Satu body menjadi banyak body.
- Durasi 3–300 dtk dihitung dari **jumlah** body.
- Aturan cold open dihitung terhadap body pertama di keluaran.
- Id segmen unik.

**Timemap:** `pieces` sudah generik. Tambah golden JS/Py untuk urutan mundur dan duplikat (`timemap.py`, `web/lib/editor/timemap.mjs`).

**Kompiler:**
- Tidak ada jalur graf baru. R2 sudah membuka decoder run baru untuk lompatan mundur, lalu menggabung run dengan `concat`.
- Ukur memori untuk N decoder di bawah 3 GiB (PF-SEG). Hasilnya menentukan batas N.

**Captions:**
- Kata yang tampil di beberapa salinan memakai `word_edits` yang sama (preseden cold open).
- Cue tidak melintasi batas segmen.

**Plate:** dibagi per sel sumber; duplikat memakai cache yang sama.

**Klien:**
- Perintah baru `SplitSegment`, `MoveSegment`, `DuplicateSegment`, `RemoveSegment`.
- `TrimStart`/`TrimEnd` per segmen; `RemoveWords` membawa `seg`.
- `rebase.mjs` mendapat bagian `segments`.
- Player (`plate-source.mjs`, `presenter.mjs`) menangani lompatan mundur.

### 5.2 Klip turunan (gabung, jadikan klip baru, duplikat klip)

**Registri:**
- `analysis/derived-clips.json` (kanonis, flock), terpisah dari manifes pipeline.
- `clip_id` memakai namespace `potongin-clip-derived-v1` dengan daftar rentang berurutan.
- `base.origin.kind` = `derived`, dengan `parents`.

**Jendela:**
- Satu jendela gabungan `[min − 60 s, max + 60 s]`, dibatasi 20 menit sumber.
- Seed, words, peaks dan source dibangun dengan fungsi yang sama seperti prepare (`seed.py`).
- Plan kamera hanya ada kalau analisis mencakup jendela; kalau tidak, mode Ikuti wajah ditolak dengan pesan "Tanpa data wajah".
- Klip yang lebih jauh dari batas ditolak: "Klip terlalu jauh untuk digabung".
- Gabung hanya untuk klip dari job yang sama.

**Isi:**
- Caption, layout, track dan watermark diambil dari klip #1.
- `word_edits`, `removals` dan keyframe dibawa per segmen.

**API (`api.py` `_dispatch`):** op `derive_clip`, `merge_clips` dan `delete_derived_clip` (soft delete di registri; janitor membersihkan sisanya setelah 30 hari).

**Pembaca daftar klip:** `_clips`, halaman proyek, Riwayat (§5.32), ZIP (§5.28), saklar hook (§5.57) dan judul (§5.38).

### 5.3 Edit kata

- Tanpa perubahan model.
- Tampilan Baris memakai `caption-lines.mjs` (`lineEdit`, `commitLine`).
- Tidak ada modul diff baru.

### 5.4 Ekspor

**Render request:**
- `size` ∈ {`output`, `720p`}; `720p` hanya berlaku untuk dokumen 1080.
- Skala Lanczos di akhir rantai, setelah ASS dan logo; grafik pratinjau tidak berubah.
- `quality` tetap `standar`.
- `render_key` memuat ukuran. R10 hanya untuk `output`.

**Gate dan verifikasi:**
- `verify.py` memverifikasi pada ukuran yang diminta.
- P-ENC mendapat fixture skala turun.
- P-TXT tidak terdampak.

**Ekspor semua:** op `export_batch` mengantrekan render per klip dari dokumen tersimpan (idempotency per batch).

### 5.5 Per shot

**Dokumen:**
- `layout.ranges: [{in_sf, out_sf, mode ∈ {camera, fill_center, fit_blur}, origin: auto|user}]`.
- Batas range = `scene_cuts_ms`.
- `layout.keyframes` tetap di root.

**Aturan:**
- Analisis ulang tidak menimpa range dengan `origin: user`.
- Apply-all grup layout tidak menyalin `ranges`.

**Graf:**
- Saklar per frame dengan pola §5.40, diperluas ke `fill_center`.
- Split tidak boleh dipakai bersama ranges (`range_invalid`).

**Gate:** P-FRAME dan P-PLATE dengan 2 dan 3 range campuran, S-COLOR, plus pengukuran memori.

### 5.6 Multi-user (bergantung rencana akun)

- Id pengguna dicatat di receipt simpan (`store.py`), bukan di `audit.editor`.
- Kehadiran lewat heartbeat per klip.
- Dialog konflik menyebut nama pengguna.
- Tidak ada CRDT.

### 5.7 Terbit

- Editor memanggil API terbit milik rencana sosial dengan `render_id`.
- Perubahan sisi editor: `ExportDialog` dan `api-client.mjs`.

## 6. Migrasi

**Aturan:**
- `web/lib/editor/` (store, commands, history, autosave, rebase, player) tidak berubah di fase UI.
- Shell baru dipasang di balik flag server `POTONGIN_EDITOR_SHELL`, tanpa pilihan di layar. Shell lama dihapus setelah fase lulus.
- Smoke berjalan di setiap PR (`ci-cd.yml`). Fase yang menyentuh render menjalankan `editor-gates.yml -f suite=full`. Tes berat tidak dijalankan di PC pemilik.
- Setiap fitur backend datang bersama amendemen CONTRACTS dan GATES di PR yang sama.

| Fase | Isi | Gate dan tes | Hari |
|---|---|---|---|
| 0 | Pemilik setujui DESIGN.md §Editor. HeroUI v3 + Tailwind v4 tanpa preflight, `@layer` di bawah CSS Modules (ikut fondasi rencana dashboard). Tema dari token gelap. Port forced-colors (`ui.module.css:478`). RAC untuk GridList dan FileTrigger. Kit `ui/*` dibungkus ulang dengan API props yang sama | `editor-ui-kit.test.mjs`, `editor-css-collisions.test.mjs`, `focus.spec.mjs`, kontras, forced-colors per komponen | 5 |
| 1 | Shell, top bar, daftar Klip, tab kanan (nama lama kecuali Audio), `?mode=`/`?card=` dialihkan, saklar pintasan satu tombol, hitung kontrol | `editor-shell`, `editor-views` (diganti), `editor-clip-nav`, `read-only`, `editor-first-frame`, `editor-shortcuts`; PF-PLAY/SEEK | 5 |
| 2 | Transkrip di tengah, toolbar kata, Kata \| Baris, Rapikan + Ejaan dalam satu Drawer, Linimasa terlipat | `editor-transcript`, `editor-cleanup`, `editor-spelling`, `editor-quick-lines`, `editor-scrubber`, `editor-markers`, `editor-acceptance` | 5 |
| 3 | Tab Teks | `editor-quick`, `editor-caption-gizmo`, `editor-apply-all`, `parity-text.spec.mjs` | 4 |
| 4a | Tab Tata letak + Lihat sumber (gizmo dipakai ulang), dialog dihapus | `editor-framing`, `editor-split`, `editor-layout`, `editor-zoom`, P-PLATE | 4 |
| 4b | `layout.ranges` dan strip shot | Fixture baru, P-FRAME, P-PLATE, S-COLOR full, uji apply-all dan analisis ulang | 10 |
| 5 | Audio, Logo, Cold open | `editor-music`, `editor-logo`, `editor-nudge`, `editor-transition`, P-LOGO, P-JOIN, G-WHOOSH, P-AUD | 4 |
| 6 | Segmen ganda (§5.1) + strip Segmen | Golden timemap, P-FRAME ≥ 2.000 frame urutan mundur dan duplikat, P-TIME, G-CLICK, PF-SEG, `editor-commands`, `editor-history`, `editor-rebase`, `editor-segments.spec.mjs` | 12 |
| 7 | Klip turunan (§5.2) | `test_edit_v2_derived.py`, `editor-merge.spec.mjs`, halaman proyek, Riwayat, ZIP | 12 |
| 8 | Ukuran 720p, ekspor semua, antrean (5); terbit (3, setelah rencana sosial) | `editor-export-flow.test.mjs`, P-ENC, `editor-export.spec.mjs`, `editor-publish.spec.mjs` | 8 |
| 9 | Tablet (4); ponsel tinjau (4, setelah PF di ponsel) | e2e 768/375, antislop layoutmobile | 8 |
| 10 | Hapus `quick/`, `ViewSwitch.jsx`, `view-mode.mjs`, metadata wave/owner; PANDUAN; stopwatch pemilik U1–U10 (U9 pisah/gabung, U10 ekspor semua) | Semua e2e editor, `run_all.sh full` | 4 |

**Total sekitar 81 hari kerja satu orang.**
- Fase 3, 4a dan 5 bisa paralel setelah fase 1.
- Fase 4b, 6 dan 7 berurutan (semuanya menyentuh `doc.py` dan kompiler).
- Jalur kritis dengan 2–3 agen sekitar 45–50 hari.

**Tes yang terdampak:**
- 66 `getByRole("tab")` di 19 spec. Hanya "Musik" yang berganti menjadi "Audio", ditambah tab Transkrip yang dihapus.
- `editor-views.spec.mjs` dan `editor-lengkap.spec.mjs` ditulis ulang.
- `editor-quick*.spec.mjs` dilebur ke spec per tab.

## 7. Risiko

| Risiko | Mitigasi |
|---|---|
| Banyak decoder run melewati 3 GiB | PF-SEG sebelum UI segmen dibuka; batas N dari hasil ukur |
| Plan dokumen lama berubah | Golden plan dan hash byte-equal untuk semua fixture §5.11 |
| Saklar mode per shot salah piksel | Hanya 3 mode dengan pola §5.40; P-FRAME dan P-PLATE per kombinasi |
| Forced-colors / fokus HeroUI belum terbukti | Audit per komponen di fase 0; gizmo, transkrip dan lane tetap CSS Modules |
| Klip turunan tidak muncul di halaman lain | Satu fungsi daftar klip (`_clips`) membaca manifes + registri; e2e di proyek, Riwayat, ZIP |
| Penyederhanaan menyembunyikan fitur | Ringkasan di judul Lanjutan; stopwatch U1–U10 tidak boleh naik |
| Terbit memakai file yang salah | Hanya `render_id` yang lolos verify |
| Override shot hilang | `origin: user` dilindungi; diuji di apply-all dan analisis ulang |

## 8. Keputusan untuk pemilik (5)

1. Setuju menghapus Mode Cepat/Lengkap dan memperbarui DESIGN.md §Editor?
2. Setuju mengganti centang per peringatan di ekspor dengan satu "Ekspor tetap" (amendemen §3.7)?
3. Batas gabung: job yang sama dan rentang sumber ≤ 20 menit. Cukup?
4. Multi-user: cukup kehadiran + rebase per bagian, atau perlu kunci per klip?
5. Efek warna ala SupoClip: ditunda (butuh gate paritas warna baru) atau dijadwalkan sesudah fase 10?