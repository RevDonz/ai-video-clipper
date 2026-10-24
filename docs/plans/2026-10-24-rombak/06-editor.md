# 06 · Editor

- **Status:** Rancangan — belum diimplementasi
- **Tanggal:** 2026-10-24
- **Dokumen lain:** [00-README.md](00-README.md) · [01-arsitektur-data.md](01-arsitektur-data.md) · [02-multiuser-keamanan.md](02-multiuser-keamanan.md) · [03-sosmed-performa.md](03-sosmed-performa.md) · [04-reframe-unduhan.md](04-reframe-unduhan.md) · [05-ui-dashboard.md](05-ui-dashboard.md) · **06-editor.md (ini)** · [07-i18n.md](07-i18n.md) · [08-fase-test-deploy.md](08-fase-test-deploy.md)
- **Sumber:** roadmap induk (Koreksi akhir KA1–KA26, X1–X15, Fase 10–11, Q1–Q12), rencana editor 03 (koreksi #1–#24), i18n §5, dashboard 02. Kalau bertentangan, koreksi akhir roadmap induk yang berlaku.
- **Clean-room:** repo SupoClip (AGPL) hanya dibaca untuk perilaku (09 §1). Kode, markup, string, konstanta, dan nama modul SupoClip tidak disalin. Nama fitur mereka ("Combine", "Edit script") tidak dipakai di UI.
- Path relatif terhadap root repo. **(baru)** = berkas belum ada. Nomor baris dicek 2026-10-24.
- **Pemilik definisi (kalau berbeda, dokumen pemilik yang berlaku; dokumen ini hanya merujuk):** skema DB, migrasi, `job.json` → 01; guard route (`secureRoute`, kepemilikan, body 404, matriks route), kuota storage per user, drain → 02; API sosmed, state `publish_runs`, kode `social_*` → 03; `layout.ranges` (§5.63), shot plan, command per shot → 04; layar dashboard, `PublishDrawer` (UI), cookie `ui-prefs`, `uiFeatures` → 05; katalog, penamaan kunci, peta kode error → 07; fase, estimasi, gate deploy → 08. Dokumen ini pemilik: UX editor, perubahan `edit_v2`, klip turunan, CONTRACTS §5.66–§5.69.
- Berkas yang di tabel hanya ditulis dengan namanya ada di lokasi berikut (dicek 2026-10-24):

| Nama | Path |
|---|---|
| `shell-model.mjs`, `export-flow.mjs`, `framing-model.mjs`, `split-model.mjs`, `ExportDialog.jsx`, `ChecksPanel.jsx`, `ConflictDialog.jsx`, `ReadOnlyBanner.jsx`, `StageBadge.jsx`, `StageControls.jsx`, `FramingDialog.jsx`, `SplitDialog.jsx`, `TopBar.jsx`, `ViewSwitch.jsx`, `EditorApp.jsx` | `web/components/editor/` |
| `selection.mjs`, `word-toolbar.mjs`, `cleanup-model.mjs`, `model.mjs`, `RemovalChip.jsx`, `CleanupReview.jsx`, `WordEditor.jsx`, `TranscriptPanel.jsx` | `web/components/editor/transcript/` |
| `caption-model.mjs`, `hook-model.mjs`, `layout-model.mjs`, `layout-analysis.mjs`, `music-model.mjs`, `music-upload.mjs`, `pack-images.js`, `TextPanel.jsx`, `LayoutPanel.jsx`, `MusicPanel.jsx`, `LogoPanel.jsx`, `WatermarkSection.jsx`, `ColdOpenPanel.jsx`, `ColdOpenSuggestions.jsx`, `TransitionSection.jsx` | `web/components/editor/panels/` |
| `logo-upload.mjs`, `FrameGizmo.jsx`, `SplitGizmo.jsx`, `CaptionGizmo.jsx`, `LogoGizmo.jsx` | `web/components/editor/gizmos/` |
| `commands.mjs`, `doc-model.mjs`, `history.mjs`, `rebase.mjs`, `timemap.mjs`, `caption-lines.mjs`, `clip-nav.mjs`, `shortcuts.mjs`, `api-client.mjs`, `apply-all.mjs` | `web/lib/editor/` |
| `doc.py`, `api.py`, `seed.py`, `store.py`, `clip_id.py`, `janitor.py`, `verify.py`, `timemap.py`, `compile_ffmpeg.py`, `execute.py`, `captions.py`, `plates.py`, `apply_all.py`, `hook_toggle.py`, `errors.py`, `plan.py` (`render_key`) | `src/ai_clipper/edit_v2/` |
| `render_queue.py` | `src/ai_clipper/` |
| Belum ada, dibuat dokumen lain: `shot_cuts.py`, `shots.py` (04 RF-M1, `src/ai_clipper/edit_v2/`), `web/lib/editor/shots.mjs` (04 F4b data), `web/components/PublishDrawer.jsx`, `web/lib/post-registry.mjs`, `listJobClips` di `web/lib/jobs.mjs` (03 SOS-M3a), `web/lib/ui-prefs.mjs` (05 Fase 1), `web/messages/<code>/*.json` (07 M0) | **(baru)** |

---

## 0. Ringkasan

- Mode **Cepat/Lengkap dihapus**. Editor punya **satu layout**.
- **Bukan berarti semua alat tampil sekaligus.** Alat dibuka bertahap (§2):
  - Pratinjau dan transkrip selalu tampil.
  - Di kanan hanya **satu panel** yang terbuka. Ada lima tab: **Teks · Tata letak · Audio · Logo · Cold open**.
  - Di tiap panel, pilihan dasar tampil langsung. Kontrol halus ada di lipatan **Lanjutan** yang tertutup, dan judul lipatannya menampilkan ringkasan nilainya.
  - Tugas umum selesai dalam ≤ 3 klik.
- **Yang baru:**
  - segmen: pisah, duplikat, urutkan, hapus;
  - klip turunan: gabung, jadikan klip baru, duplikat klip (lewat registri `derived-clips.json`);
  - edit caption per baris (Kata | Baris);
  - mode per shot yang menimpa Otomatis;
  - ukuran ekspor Asli/720p;
  - Ekspor semua;
  - **Terbitkan** langsung dari editor;
  - saklar pintasan satu tombol;
  - UI dalam dua bahasa (ID dan EN).
- **Jadwal:** Fase 10 (Editor I, ≈ 31 hari-dev) dan Fase 11 (Editor II + rilis English, ≈ 64,5 hari-dev). Bagian editor sendiri ≈ 81 hari-dev.

## 1. Keputusan yang dipakai

| # | Keputusan | Status |
|---|---|---|
| Q1 | DESIGN.md §Pola tata letak (Editor) dan AGENTS.md diamandemen. Mode Cepat/Lengkap dihapus. Istilah publikasi: **Terbitkan / Terbit**. Satu "Ekspor tetap" menggantikan centang per peringatan (amendemen CONTRACTS §3.7) | Final |
| Q2 | Node 24 + `node:sqlite`, `@heroui/react@3.2.6` + Tailwind v4, `use-intl@4.14.9`, `@babel/parser` (dev). Untuk `GridList`, `FileTrigger`, dan DnD dipakai `react-aria-components` langsung (dependensi eksplisit di `web/package.json`, dipin persis ke versi yang ditarik `@heroui/react@3.2.6`; dicek dengan `npm ls react-aria-components` di F0 supaya tidak ada dua salinan RAC) | Final |
| Q9 | Bahasa EN dirilis bersama fase editor (opsi b, i18n M9 di akhir Fase 11). Pratinjau `POTONGIN_LOCALES=id,en` hanya sebelum ada anggota | Final |
| Q10 | Otomatis opt-in sampai PF-PIPELINE. Override pengguna 3 mode. "Pakai di semua klip" untuk tata letak mengantrekan analisis | (default, bisa diubah) |
| Q12 | Gabung hanya untuk klip dari job yang sama dengan rentang sumber ≤ 20 menit. Kehadiran + rebase per bagian, tanpa kunci. Efek warna ditunda ke Fase 12 | (default, bisa diubah) |
| Q7 | File default untuk Terbitkan = ekspor terbaru yang selesai, ada pilihan lain di drawer | (default, bisa diubah) |
| Q8 | Format jam 24 jam di semua locale. Zona = zona perangkat, namanya ditampilkan | (default, bisa diubah) |
| Q3–Q6, Q11 | Tidak memengaruhi editor secara langsung. Default roadmap induk berlaku | (default, bisa diubah) |
| — | Pra-centang kata pengisi di Rapikan tetap **mati** (HANDOFF §2). Default `cleanup-model.mjs`: hanya `gap_silent` yang `defaultOn` | Tetap |

## 2. Pengungkapan bertahap (jawaban "tanpa mode ≠ semua alat sekaligus")

### 2.1 Empat tingkat

| Tingkat | Isi | Kapan terlihat |
|---|---|---|
| **T0: selalu** | Top bar, pratinjau + transport, strip Segmen, transkrip, daftar Klip | Selalu |
| **T1: satu panel** | Isi **dasar** dari satu tab kanan | Satu tab aktif; tab Teks saat editor dibuka. Klik tab yang sedang aktif tidak menutup panel |
| **T2: Lanjutan** | Kontrol halus di dalam `Disclosure` "Lanjutan" per kelompok | Tertutup secara default. Judulnya selalu menampilkan ringkasan, misalnya `Lanjutan · Pop · 2 kata` |
| **T3: menu dan laci** | Menu ⋯, Linimasa detail (terlipat), Drawer Rapikan/Ejaan, Drawer Terbitkan, Modal Ekspor | Dibuka dengan 1 klik |

### 2.2 Aturan penempatan (wajib untuk setiap kontrol baru)

1. Sebuah kontrol masuk **dasar** kalau memenuhi salah satu:
   - dipakai di ≥ 20% sesi;
   - mengubah hasil secara besar (gaya, mode, on/off).
   Kontrol lain masuk Lanjutan.
2. Isi Lanjutan **tidak boleh** menjadi satu-satunya cara memperbaiki error ekspor. Tombol **Perbaiki** dari daftar cek membuka tab dan Lanjutan yang tepat, lalu memfokuskan kontrolnya.
3. Ringkasan Lanjutan diambil dari fungsi murni `advancedSummary(group, doc, seed)` di `web/lib/editor/disclosure.mjs` **(baru)**, yang mengembalikan data, bukan teks: `{items: [{key, values}]}` (maks. 3 item, urutan tetap per kelompok), hanya untuk nilai yang **berbeda dari seed**. Teks dibentuk di komponen sesuai 07-i18n.md (yang berlaku untuk soal bahasa):
   - `editor.advanced.summary` = `"{items}"`, dengan `items` = `useFormatter().list(labels, {type: "unit"})`; separator ` · ` ditetapkan sekali di `web/lib/i18n/format.mjs`;
   - label tiap item memakai kunci `editor.<tab>.summary.<key>`;
   - kalau `items` kosong, judul menampilkan `editor.advanced.default` ("Bawaan" / "Default").
   Contoh ringkasan di bawah (`Lanjutan · Pop · 2 kata`) adalah keluaran `id`.
4. Keadaan buka/tutup Lanjutan per kelompok disimpan di `localStorage` dengan kunci `potongin-editor-disclosure`. Ini hanya kenyamanan per penampil: setiap akses dibungkus try/catch, dan kalau gagal, defaultnya tertutup.
5. Tidak ada kontrol yang tampil ganda di dua tab, **kecuali** "Edit per baris" (tab Teks), yang hanya melompat ke transkrip mode Baris.
6. Kalau mode aktif tidak mendukung sebuah kontrol, kontrol itu disembunyikan, tidak dinonaktifkan. Contoh: Zona aman pada 1:1, strip shot pada Layar terbagi. Pengecualian: tombol yang alasannya perlu diketahui (Hapus segmen saat tinggal 1) tetap tampil nonaktif, dengan alasan di `aria-describedby`.

### 2.3 Batas klik

- Dihitung dari editor yang terbuka di tab Teks, termasuk dialog OS dan klik membuka `Select`.
- Tugas umum ≤ 3 klik, tugas lanjutan ≤ 5 klik. Terbitkan ≥ 5 klik dan dikecualikan (alurnya multi-field).
- Klik di pratinjau untuk seret (gizmo) dihitung 1. Mengetik tidak dihitung.
- **Tugas lanjutan** (boleh 4–5 klik) ditetapkan tertutup: §10 #38 Gabungkan klip, #54 Override per shot, #61 Tambah musik (termasuk dialog OS + Setuju), #65 detail musik. Baris §10 lain wajib ≤ 3. Menambah baris ke daftar ini butuh perubahan dokumen ini.
- Penguji: `web/e2e/editor-click-budget.spec.mjs` **(baru)** membaca tabel `web/e2e/support/click-budget.mjs` **(baru)**: satu entri per baris §10 `{row, steps: [locator…], budget}`. Helper `clickStep` menghitung setiap `click`/`dblclick`/`selectOption`; tes gagal kalau jumlah > `budget` atau kontrol terakhir tidak terlihat/fokus. Dialog OS diganti `setInputFiles` dan dihitung 1.
- Jumlah kontrol diukur di Fase 10 F1 lewat snapshot DOM `button, [role=button], [role=tab], [role=switch], [role=radio], input, select, textarea`, sebelum dan sesudah, per tab, disimpan di `docs/editor/evidence/control-count.json` **(baru)**. Tidak ada klaim angka sebelum diukur.

## 3. Layout

### 3.1 Breakpoint

| Lebar | Susunan |
|---|---|
| ≥ 1440 px | Kolom Klip (240) \| Pratinjau ‖ Transkrip berdampingan \| Panel kanan (380) |
| 1280–1439 px | Kolom Klip (240) \| Pratinjau di atas Transkrip \| Panel kanan (360) |
| 1024–1279 px | Kolom Klip dilipat menjadi rel ikon (56, tombol "Klip" membuka `Drawer` daftar) \| tengah \| Panel kanan (340) |
| 768–1023 px (tablet, F9) | Satu kolom: Pratinjau → Segmen → Transkrip. Bar tab bawah membuka panel dalam `Drawer` bawah (60% tinggi). Linimasa detail tetap ada, terlipat |
| < 768 px (ponsel, F9, terakhir) | Hanya tinjau, edit kata, gaya caption (6 kartu), Cold open on/off, Terbitkan. Tanpa gizmo, Linimasa, dan strip Segmen. Syarat: PF-PLAY dan PF-SEEK lolos di satu ponsel kelas menengah |

Uji screenshot wajib: 1366×768 dan 1920×1080 (Fase 10), lalu 768×1024 dan 375×812 (F9). Pada 1366×768 tidak boleh ada scroll halaman. Kolom tengah dan panel kanan punya scroll sendiri.

### 3.2 Wireframe desktop ≥ 1440 px

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ ← Proyek │ Klip 3/8 ‹ › │ Judul klip │ ● Tersimpan │ ↶ ↷ │ [Perlu dicek 2] [⇣1] [⋯] │ [Ekspor][▾] │
├───────────┬─────────────────────────────────────────────────┬──────────────────────────────┤
│ KLIP (8)  │ PRATINJAU 9:16 (dari doc.output)  │ TRANSKRIP     │[Teks][Tata letak][Audio][Logo][Cold open]
│ ☐ #1 0:42 │ ┌───────────┐                     │ [Kata|Baris]  │ Caption            [on]      │
│ ☑ #2 0:31 │ │           │ (i) Sesuai hasil    │ [Rapikan 4]   │ (6 kartu gaya)               │
│ ☐ #3 0:28 │ │  video    │                     │ [Ejaan 2]     │ Ukuran ○○●  Posisi ○○●       │
│ ☐ T1 0:55 │ │           │                     │ ── Segmen 1 ──│ Warna sorot ●●●●●●           │
│  (turunan)│ └───────────┘                     │ kata kata ... │ ▸ Lanjutan · Pop · 2 kata    │
│ …         │ ▶ 00:12,3 / 00:41,0  ‹ ›          │ ── Segmen 2 ──│ ─────────────                │
│           │ di sumber 21:04 · Zona aman ☐     │ kata kata ... │ Hook               [on]      │
│[Gabungkan │ Frame akhir ☐ · Lihat sumber      │               │ [teks hook……… 42/90]         │
│  2 klip]  │ SEGMEN [1][2][+] Pisah Duplikat ← → Hapus ⋯        │ Saran hook ▸                 │
│           │ ▸ Linimasa detail                                 │ ▸ Lanjutan · Bar · 3 dtk     │
│           │                                                   │ [Edit per baris]             │
│           │                                                   │ [Pakai di semua klip]        │
└───────────┴───────────────────────────────────────────────────┴──────────────────────────────┘
```

- "Lihat sumber" hanya tampil saat tab Tata letak aktif dan mode mendukung (Ikuti wajah dengan bingkai manual, atau Layar terbagi).
- "Lanjutan" dan "Linimasa detail" tertutup secara default.

### 3.3 Wireframe 1280–1439 px dan 1024–1279 px

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ top bar (sama; ⇣n dan avatar disembunyikan di < 1280 dan masuk ⋯)            │
├──┬─────────────────────────────────────────────┬─────────────────────────────┤
│▤ │ PRATINJAU                                   │ [Teks][Tata letak][Audio]…  │
│K │ transport · di sumber · Zona aman · Frame   │ isi tab (scroll sendiri)    │
│l │ SEGMEN [1][2][+] Pisah Duplikat ← → Hapus ⋯ │                             │
│i │ TRANSKRIP [Kata|Baris] [Rapikan n][Ejaan n] │                             │
│p │ … (scroll sendiri, min 220 px)              │                             │
│  │ ▸ Linimasa detail                           │                             │
└──┴─────────────────────────────────────────────┴─────────────────────────────┘
 (▤ Klip = rel ikon di 1024–1279; di 1280–1439 kolom Klip penuh 240 px)
```

### 3.4 Wireframe tablet dan ponsel

```
Tablet 768–1023                 Ponsel < 768
┌──────────────────────────┐    ┌────────────────────┐
│ ← │ Klip 3/8 ‹ › │ Ekspor▾│    │ ← │ 3/8 ‹ › │ ⋯    │
│ PRATINJAU                │    │ PRATINJAU          │
│ transport                │    │ ▶ waktu            │
│ SEGMEN chip …            │    │ TRANSKRIP (Kata)   │
│ TRANSKRIP                │    │ kata kata …        │
│ ▸ Linimasa detail        │    │                    │
├──────────────────────────┤    ├────────────────────┤
│Teks│Tata│Audio│Logo│Cold │    │ Gaya │ Cold open │ Terbitkan │
└──────────────────────────┘    └────────────────────┘
 tab bawah → Drawer bawah 60%    Gaya = 6 kartu caption saja
```

### 3.5 Berkas shell

| Berkas | Isi |
|---|---|
| `web/components/editor/EditorApp.jsx` (ubah) | Hapus cabang view Cepat/Lengkap, pasang `EditorShell` |
| `web/components/editor/shell/EditorShell.jsx` **(baru)** | Grid area `clips`, `stage`, `segments`, `transcript`, `panel`, `timeline` menurut breakpoint (CSS Module `shell/editor-shell.module.css` **(baru)**) |
| `web/components/editor/shell/ClipList.jsx` **(baru)** | Daftar Klip + multi-pilih + Gabungkan (RAC `GridList`) |
| `web/components/editor/shell/PanelTabs.jsx` **(baru)** | Lima tab (HeroUI `Tabs`), memuat panel secara lazy dari `panels/index.mjs` |
| `web/components/editor/shell/Advanced.jsx` **(baru)** | `Disclosure` "Lanjutan" + ringkasan |
| `web/components/editor/segments/SegmentStrip.jsx` **(baru)** | Strip Segmen (§7) |
| `web/components/editor/TopBar.jsx` (ubah) | §4 |
| `web/components/editor/panels/index.mjs` (ubah) | Hapus entri `transcript`; `music` → id `audio`, label `Audio`; urutan text, layout, audio, logo, coldopen; hapus metadata `wave`/`owner` (F10) |
| `web/lib/editor/view-mode.mjs`, `web/components/editor/ViewSwitch.jsx`, `web/components/editor/quick/*`, `web/components/editor/rail/*` | Dihapus di F10 (bersih-bersih). `quick/CaptionLinesCard.jsx` dipindah ke `transcript/LinesView.jsx` **(baru)** |
| `web/lib/editor/url-state.mjs` **(baru)** | Membaca `?panel=`, mengalihkan `?mode=`/`?card=` (§3.6) |

### 3.6 URL

| Param lama | Perilaku baru |
|---|---|
| `?mode=cepat\|lengkap` | Diabaikan. `history.replaceState` menghapusnya |
| `?card=hook\|caption` | → `?panel=text` |
| `?card=lines` | → panel `text` + transkrip mode Baris |
| `?card=coldopen` | → `?panel=coldopen` |
| `?card=layout` | → `?panel=layout` |
| `?card=extras` | → `?panel=logo` |
| `?panel=transcript` | → `?panel=text` (transkrip selalu tampil) |
| `?panel=music` | → `?panel=audio` |
| `?panel=text\|layout\|audio\|logo\|coldopen` | Membuka tab itu |
| Kunci `localStorage` `potongin-editor-view` | Dihapus saat dibaca pertama kali (try/catch) |

## 4. Top bar

Urutan kiri → kanan (komponen HeroUI kecuali disebut lain):

| # | Kontrol | Perilaku | Kondisi |
|---|---|---|---|
| 1 | `← Proyek` | `<a href="/projects/:id">`, pemuatan penuh (tanpa RouterProvider) | Selalu |
| 2 | `Klip 3/8 ‹ ›` | Seperti sekarang (`TopBar.jsx` clipNav, `clip-nav.mjs`). Simpan dulu, lalu buka tetangga. Ctrl+Shift+←/→. Klip turunan ikut urutan daftar Klip | Kalau > 1 klip |
| 3 | Judul | Teks saja (`h1`), terpotong dengan `title`. Ubah judul tetap di halaman proyek (§5.38) | Selalu |
| 4 | Status simpan | `saveStatusView` (`shell-model.mjs`). Ada "Coba simpan lagi" kalau gagal, dan "Terbuka di tab lain" | Selalu |
| 5 | ↶ ↷ | Urungkan/Ulangi | Selalu |
| 6 | **Perlu dicek n** / **Catatan n** | Label "Perlu dicek n" kalau ada cek warning/error; "Catatan n" kalau hanya info (`no_face_blur`, area aman K5). Tidak tampil kalau keduanya 0. Membuka `Popover` daftar cek (Perbaiki · Lihat). Kalau tombol hilang saat sedang fokus, fokus pindah ke tombol Ekspor | Kondisional (ubah perilaku `TopBar.jsx`: sekarang selalu tampil) |
| 7 | Antrean `⇣n` | `Popover` daftar ekspor yang berjalan untuk job ini (progres, Batal). Data: `GET /api/jobs/:id/renders` (§11.8a), di-poll tiap 2 dtk selama n > 0 dan tab terlihat | n > 0 |
| 8 | Avatar | `AvatarGroup` sesi lain di klip ini (heartbeat, §11.9). Selama 02-multiuser-keamanan.md tidak punya berbagi proyek, isinya hanya tab/perangkat lain milik pengguna yang sama | Setelah fitur akun (Fase 4–6) dan ada sesi lain |
| 9 | ⋯ Lainnya | `Dropdown`: Kembali ke versi AI (`AlertDialog`), Pintasan keyboard | Selalu |
| 10 | **Ekspor** + ▾ | Satu-satunya tombol lime. ▾ = `Dropdown`: **Ekspor semua…**, **Terbitkan…** | Selalu. Item **Terbitkan…** hanya ada kalau `uiFeatures(user).social` (`web/lib/ui-features.mjs`, 05-ui-dashboard.md; nilai flag `POTONGIN_SOCIAL` = `off`\|`admin`\|`on` milik 03-sosmed-performa.md §3 dan gerbang route §9). Halaman edit (server) menghitungnya dan mengirim prop `socialEnabled` ke `EditorApp` |

Tidak ada pemilih Cepat/Lengkap dan tidak ada pemilih bahasa di editor. Ganti bahasa dilakukan di menu akun lalu muat ulang penuh.

## 5. Pratinjau dan panggung "Lihat sumber"

### 5.1 Kontrol pratinjau (dasar)

| Kontrol | Sumber sekarang | Catatan |
|---|---|---|
| Label rasio `PRATINJAU 9:16` / `1:1` | baru | Dari `doc.output`, bukan teks tetap |
| Badge "Sesuai hasil akhir" + (i) | `StageBadge.jsx` | Bantuan tampil di `Popover` dari tombol (i). `Tooltip` hanya mengulang label |
| Putar/jeda, frame ‹ ›, waktu, "di sumber mm:ss" | `StageControls.jsx`, CONTRACTS §5.55 | — |
| Scrubber + tanda | `scrubber/Scrubber.jsx` | Tetap kustom |
| Zona aman | `StageControls.jsx` | Disembunyikan pada 1:1 (§5.54) |
| Frame akhir | `StageControls.jsx` | `ToggleButton` |
| Gizmo caption (seret) | `gizmos/CaptionGizmo.jsx` | Selalu |
| Gizmo logo | `gizmos/LogoGizmo.jsx` | Saat tab Logo aktif |
| **Lihat sumber** | baru; memakai ulang `gizmos/FrameGizmo.jsx`, `gizmos/SplitGizmo.jsx` | §5.2 |

### 5.2 Mesin keadaan panggung

`stage.view ∈ {output, source}`, disimpan di store UI (bukan dokumen). Reducer di `web/lib/editor/stage-view.mjs` **(baru)**.

```
output ──[Lihat sumber]──▶ source
   ▲                         │
   ├──[Kembali ke hasil | Esc | pindah tab selain Tata letak | ganti mode ke yang tak mendukung]─┘
   └── (putar ditekan saat source → kembali ke output lalu putar)
```

- **`source` diizinkan kalau:**
  - `layout.default.mode === "camera"` (bingkai manual / keyframe, §5.44), atau
  - `layout.default.mode === "split"` (dua potongan, §5.45), atau
  - shot terpilih di strip shot ber-mode `camera`, **hanya kalau** aturan V8 di 04-reframe-unduhan.md §A6 (`layout.keyframes` + `ranges` → `range_invalid`) sudah dilonggarkan untuk range `camera` di F4b. Sebelum itu, saat `ranges` ada, tombol disembunyikan.
  Selain itu tombol disembunyikan.
- **`source` + camera:**
  - Still sumber pada frame sumber playhead.
  - `FrameGizmo` menggambar kotak 9:16. Seret = `SetKeyframe` (gabung riwayat per seret).
  - `Popover` titik: Perpindahan Potong/Geser (`SetKeyframeMove`), Hapus titik (`RemoveKeyframe`).
- **`source` + split:** `SplitGizmo` dengan dua kotak; seret = `SetSplitCrop`.
- `FramingDialog.jsx`, `SplitDialog.jsx`, `framing.module.css`, `split-dialog.module.css` dihapus setelah F4a. `framing-model.mjs` dan `split-model.mjs` dipertahankan (logika murni).
- Fokus saat masuk `source` pindah ke gizmo; saat keluar, kembali ke tombol "Lihat sumber".
- Live region: "Sumber" / "Hasil".

## 6. Transkrip (Kata | Baris)

- Selalu tampil (bukan tab). Berkas: `transcript/TranscriptPanel.jsx` (ubah), `transcript/LinesView.jsx` **(baru)**, `ToggleButtonGroup` Kata | Baris.
- **Urutan tampil = urutan keluaran:**
  - Pemisah per segmen ("Cold open", "Segmen 1", "Segmen 2", …).
  - Kata dari segmen duplikat tampil sekali per salinan.
  - Pilihan menyimpan `seg` (`web/components/editor/transcript/selection.mjs` ubah: `{seg, fromWordId, toWordId}`). Pilihan tidak bisa melintasi segmen; Shift+klik di segmen lain memotong pilihan di batas segmen.

| Fitur | Dasar/Lanjutan | Klik |
|---|---|---|
| Seek (klik kata), pilih (seret / Shift / panah) | Dasar | 1 |
| Toolbar kata: Hapus · Pulihkan · Perpanjang ke sini · Edit · Mulai di sini · Akhiri di sini · ⋯ (Kata kunci, Sembunyikan dari caption, Jadikan cold open) | Dasar; ⋯ = menu | 2 / 3 |
| Ctrl+klik = Kata kunci (§5.55) | Dasar | 1 |
| Chip Pulihkan (`RemovalChip.jsx`) | Dasar | 1 |
| ＋3 kalimat (perpanjang jendela) | Dasar | 1 |
| **Rapikan n** → `Drawer` tab "Rapikan" (`CleanupReview.jsx`). n = jumlah temuan. Default: jeda senyap tercentang, pengisi tidak. **Terapkan (n)** = 1 urungkan | Dasar → Drawer | 3 |
| **Ejaan n** → `Drawer` yang sama, tab "Ejaan" (`spelling/SpellingReview.jsx`) | Dasar → Drawer | 3 |
| **Baris:** satu `TextField` per baris caption (`caption-lines.mjs` `captionRows`, `lineEdit`, `commitLine`). Enter/blur = 1 urungkan per baris. Kata yang dihapus di Baris hanya disembunyikan dari caption (suara tetap), dengan label tetap "Disembunyikan" di baris itu | Dasar | 1 + ketik |

- Modal "Edit naskah" dan modul diff baru **tidak dibuat**. Baris sudah setara.
- `RemoveWords`, `EditWordText`, `SetWordHidden`, `SetWordEmphasis` membawa `seg`.
- `word_edits` berlaku untuk semua salinan kata (preseden cold open). Mengedit kata di salinan kedua mengubah keduanya, dan toast pertama kali menyebut "Berlaku di 2 salinan".

## 7. Strip Segmen

```
SEGMEN  [Cold open] [1 · 0:18] [2 · 0:12] [3 · 0:08]   Pisah · Duplikat · ← → · Hapus · ⋯
```

- Komponen: RAC `GridList` horizontal, satu baris per segmen, `dragAndDropHooks` untuk mengurutkan. Ada tombol ← → untuk keyboard dan pengguna non-seret, ditambah live region "Segmen 2 dipindah ke posisi 1".
- Chip cold open tampil kalau ada, tidak bisa dipindah, dan selalu pertama.
- Klik chip = pilih + seek ke awal segmen.

| Aksi | Command | Syarat | Klik |
|---|---|---|---|
| Pisah | `SplitSegment {seg, atSf}` | Playhead di dalam body, ≥ 1 detik dari tiap ujung, dan jumlah body < `MAX_BODIES` | 2 (seek + Pisah) |
| Duplikat | `DuplicateSegment {seg}` | Body < `MAX_BODIES` dan total keluaran **setelah** duplikasi ≤ 300 dtk | 2 |
| Urutkan | `MoveSegment {seg, toIndex}` | ≥ 2 body | 2 (pilih + ←/→) atau 1 seret |
| Hapus | `RemoveSegment {seg}` | ≥ 2 body; tombol nonaktif dengan alasan "Minimal 1 segmen" | 2 |
| Jadikan klip baru | op `derive_clip` (§11.6) | Dokumen tersimpan | 3 (chip → ⋯ → Jadikan klip baru) |
| Mulai / Akhiri di sini | `TrimStart`/`TrimEnd` dengan `seg` | — | 2 (dari toolbar kata) |

`MAX_BODIES` = 8 (diekspor dari `web/lib/editor/doc-model.mjs` dan `edit_v2/doc.py`). Nilainya hanya boleh naik setelah PF-SEG (§13).

## 8. Panel kanan: lima tab

Setiap tab = satu berkas di `web/components/editor/panels/`. Isi dasar tampil langsung; isi Lanjutan ada di `Advanced` dengan ringkasan.

### 8.1 Teks (`TextPanel.jsx`, menyerap `quick/CaptionCard.jsx` dan `quick/HookCard.jsx`)

| Kelompok | Dasar | Lanjutan (ringkasan) |
|---|---|---|
| Caption | Switch on/off; 6 kartu paket bergambar (Klasik, Karaoke, Bold, Box, Sorot, Sinar; `RadioGroup` + `Card`); Ukuran 3 pil; Posisi 3 pil (dan seret di pratinjau); Warna sorot (`ColorSwatchPicker`); "Geser dari wajah" (kondisional, §5.50) | Ukuran halus (`Slider`), posisi halus, Kata per baris 1–4, Animasi masuk (Tidak ada/Pudar/Pop/Blur), Huruf besar, Warna kata kunci. Contoh ringkasan: `Lanjutan · Pop · 2 kata` |
| Hook | Switch on/off; `TextArea` dengan hitungan n/90 dan "Akan terpotong"; Saran hook (`ListBox`: Perbarui, Pakai) | Desain hook (Bar, Kicker, Blok, Kotak kata), durasi, posisi. Ringkasan: `Lanjutan · Bar · 3 dtk` |
| — | **Edit per baris** (lompat ke transkrip mode Baris); **Pakai di semua klip** (grup `captions`) | — |

### 8.2 Tata letak (`LayoutPanel.jsx`, menyerap `quick/LayoutCard.jsx`)

| Kelompok | Dasar | Lanjutan |
|---|---|---|
| Mode | 4–5 kartu bergambar: Otomatis (kalau `POTONGIN_AUTO_REFRAME` aktif), Ikuti wajah, Potong tengah, Latar blur, Layar terbagi. Label dari `web/lib/layout-names.mjs`. Ada progres analisis dan Coba lagi | — |
| Strip shot (F4b) | Hanya kalau mode ≠ Layar terbagi dan ada ≥ 2 shot. Strip = RAC `GridList` horizontal (`ShotStrip.jsx`); kotak per shot berisi thumbnail, mode efektif, dan tanda "Tanpa wajah" / "Diubah". Klik = seek ke shot dan membuka `ShotPopover` berisi `Select` mode (Ikuti wajah, Potong tengah, Latar blur) dan tombol **Otomatis** (hapus override) | **Kembali ke otomatis** (semua shot, `ResetAllShots`). Ringkasan: `Lanjutan · 2 shot diubah`, item `shotsChanged` dengan label `editor.layout.summary.shotsChanged` (`{count, plural, …}`) mengikuti aturan §2.2 butir 3 |
| Ikuti wajah | Bagian tanpa wajah: Latar blur / Dipusatkan (`RadioGroup`); **Lihat sumber** | Kembali ke otomatis (hapus keyframes), Zoom 100–150%. Ringkasan: `Lanjutan · 2 titik · 110%` |
| Layar terbagi | Pembagian (`SPLIT_RATIOS` di `split-model.mjs`: **30/70 · 50/50**; `ToggleButtonGroup`; `top_pm` 300/500/700, dengan 700 hasil Tukar), Tukar atas dan bawah, **Lihat sumber** (menggantikan tombol "Atur potongan") | Perbesar per bagian (`SetSplitCrop.zoom_pm`, `SPLIT_ZOOM_RANGE` 100–500%). Ringkasan: `Lanjutan · Atas 120% · Bawah 100%` |
| — | **Pakai di semua klip** (grup `layout`). Isi yang disalin dan penanganan target tanpa shot plan (`pending_analysis`, bukan "dilewati"; analisis diantrekan lewat `prepare`) **milik** 04-reframe-unduhan.md §A6 "Apply-all": seluruh `layout` kecuali `keyframes` dan `ranges` (`split_xy` ikut terbuang karena hanya ada di `ranges`; `layout.split` tetap disalin). Panel hanya menampilkan hasil batch (Q10 default) | — |

### 8.3 Audio (`MusicPanel.jsx` → `AudioPanel.jsx`, id `audio`)

| Kelompok | Dasar | Lanjutan |
|---|---|---|
| Musik | **Tambah musik** (RAC `FileTrigger` → `AlertDialog` hak cipta); Ganti / Hapus; Volume musik + reset; Kecilkan saat bicara on + kekuatan (Halus/Sedang/Kuat, `DUCK_PRESETS`) | 4 detail ducking (kedalaman, attack, release, hold), Mulai dari, Ulangi, Fade masuk/keluar. Ringkasan: `Lanjutan · Ulangi · Fade 1 dtk` |
| Suara asli | Volume suara asli; Samakan kenyaringan (Switch) | — |

### 8.4 Logo (`LogoPanel.jsx`, menyerap `quick/ExtrasCard.jsx` bagian logo; `WatermarkSection.jsx`)

| Kelompok | Dasar | Lanjutan |
|---|---|---|
| Logo | **Tambah logo** (`FileTrigger`); Ganti / Hapus; 4 sudut (`ToggleButtonGroup`); seret dan ubah ukuran di pratinjau; "Geser ke area aman" (kondisional) | Ukuran, opasitas. Ringkasan: `Lanjutan · 12% · 90%` |
| Teks watermark | Teks (`TextField`) | Posisi, ukuran, opasitas |
| — | **Pakai di semua klip** (grup `logo`) | — |

### 8.5 Cold open (`ColdOpenPanel.jsx`, menyerap `quick/ColdOpenCard.jsx`)

| Kelompok | Dasar | Lanjutan |
|---|---|---|
| Cold open | Switch on/off, Putar, Hapus; Saran (`ListBox`: Putar, Pakai); Awal ±kata, Akhir ±kata (`NumberField`) | ±0,1 dtk per ujung. Ringkasan: `Lanjutan · +0,2 dtk` |
| Transisi | Potong langsung / Kilat putih / Gelap sebentar (`ToggleButtonGroup`); whoosh (Switch); Putar transisi | — |

### 8.6 Linimasa detail (T3, terlipat)

- `timeline/Timeline.jsx` dan lanes tetap CSS Modules.
- Isi: 6 jalur, pegangan trim per segmen (← → ke celah kata; Shift = 0,1 dtk; `NudgeEdge`), Zoom −/+, Paskan, serta saklar penanda tawa, jeda, dan potongan adegan.
- Gelombang suara dan jalur musik hanya ada di sini.
- Dibuka/ditutup dengan 1 klik. Keadaannya diingat di `localStorage` (try/catch).

## 9. Daftar Klip dan gabung klip

- **Berkas:** `shell/ClipList.jsx` **(baru)**. Sumber data: `GET /api/jobs/:id/clips`, yang mulai Fase 11 juga memuat klip turunan (§11.6).
- **Isi satu baris:**
  - checkbox (mode pilih);
  - `#index`;
  - durasi;
  - chip asal: Gabungan / Potongan / Salinan untuk klip turunan;
  - status edit (titik "Diubah");
  - menu ⋯ berisi Duplikat klip, Hapus klip (hanya klip turunan).
- **Klik baris** (bukan checkbox): simpan dulu, lalu buka klip itu (sama dengan ‹ ›).
- **Gabungkan n klip:**
  - Tombol muncul kalau ≥ 2 klip dicentang. Urutan centang = urutan awal.
  - Tombol membuka `Modal`: daftar urutan (← → dan seret), teks "Gaya dari #k" (klip pertama), dan tombol **Buat klip**.
  - Klik dihitung: 2 centang + Gabungkan + Buat klip = **4**.
- **Tolak sebelum request** (dicek klien, lalu dicek ulang di server):
  - klip > 8 → "Maks. 8 klip";
  - total > 300 dtk → "Terlalu panjang";
  - rentang sumber > 20 menit → "Terlalu jauh untuk digabung".
- **Setelah berhasil:** Toast "Klip #12 dibuat" + **Buka**. Klip asli tidak berubah.
- **Hapus klip turunan:** `AlertDialog` "Hapus klip #12?". Kalau ada jadwal terbit untuk klip itu, dialog menambah baris "Jadwal terbit ikut dibatalkan (n)". Hasilnya Toast tanpa Urungkan. Klip yang terhapus dipulihkan dengan membuatnya ulang.

## 10. Peta fitur lengkap

**Keterangan kolom:**
- **Letak:**
  - TB = top bar;
  - P = pratinjau;
  - S = strip Segmen;
  - Tr = transkrip;
  - K = daftar Klip;
  - Tx/TL/Au/Lo/CO = tab;
  - L = Lanjutan;
  - Lin = Linimasa detail;
  - M = modal/drawer.
- **Klik:** dihitung dari editor terbuka di tab Teks (§2.3).
- **Status:** A = ada sekarang (dipindah), B = baru.

| # | Fitur | Status | Sumber sekarang | Letak | Komponen | Klik |
|---|---|---|---|---|---|---|
| 1 | Kembali ke proyek | A | `TopBar.jsx` | TB | `<a>` | 1 |
| 2 | Pindah klip ‹ › / Ctrl+Shift+←/→ | A | `TopBar.jsx`, `clip-nav.mjs` | TB, K | `Button`, `GridList` | 1 |
| 3 | Status simpan, Coba simpan lagi, Terbuka di tab lain | A | `TopBar.jsx`, `shell-model.mjs` | TB | teks + `Button` | 0–1 |
| 4 | Urungkan / Ulangi | A | `TopBar.jsx`, `history.mjs` | TB | `Button` | 1 |
| 5 | Perlu dicek n / Catatan n, Perbaiki, Lihat | A (ubah) | `ChecksPanel.jsx` | TB → `Popover` | `Button`, `Popover` | 1–2 |
| 6 | Kembali ke versi AI | A | `TopBar.jsx` (Lainnya) | TB ⋯ | `Dropdown` + `AlertDialog` | 3 |
| 7 | Pintasan keyboard + saklar Pintasan satu tombol | A + B | `TopBar.jsx`, `shortcuts.mjs` | TB ⋯ | `Modal`, `Kbd`, `Switch` | 2 / 3 |
| 8 | Mode Cepat / Lengkap | **Dihapus** | `ViewSwitch.jsx`, `view-mode.mjs` | — | — | — |
| 9 | Menyiapkan klip (layar tunggu) | A | `EditorApp.jsx` | layar | `ProgressBar`, `Skeleton` | 0 |
| 10 | Baca-saja, Mulai dari versi AI | A | `ReadOnlyBanner.jsx` | atas | `Alert` | 1 |
| 11 | Konflik per bagian (+ nama pengguna setelah akun) | A | `ConflictDialog.jsx`, `rebase.mjs` | M | `Modal` + `RadioGroup` | 2–3 |
| 12 | Putar/jeda, frame ‹ ›, waktu, "di sumber mm:ss" | A | `StageControls.jsx` | P | `Toolbar` | 1 |
| 13 | Scrubber + tanda | A | `scrubber/Scrubber.jsx` | P | kustom | 1 |
| 14 | Badge Sesuai hasil akhir + bantuan | A | `StageBadge.jsx` | P | `Chip`, `Popover` | 0–1 |
| 15 | Frame akhir | A | `StageControls.jsx` | P | `ToggleButton` | 1 |
| 16 | Zona aman (bukan 1:1) | A | `StageControls.jsx` | P | `ToggleButton` | 1 |
| 17 | Gizmo caption (seret) | A | `gizmos/CaptionGizmo.jsx` | P | kustom | 1 seret |
| 18 | Gizmo logo | A | `gizmos/LogoGizmo.jsx` | P (tab Logo) | kustom | 2 (tab + seret) |
| 19 | Lihat sumber: bingkai manual | A (dipindah dari dialog) | `FramingDialog.jsx` → `FrameGizmo.jsx` | P (tab TL) | gizmo | 3 (tab + Lihat sumber + seret) |
| 20 | Lihat sumber: potongan Layar terbagi | A (dipindah) | `SplitDialog.jsx` → `SplitGizmo.jsx` | P (tab TL) | gizmo | 3 |
| 21 | Seek dan pilih kata | A | `TranscriptPanel.jsx`, `selection.mjs` | Tr | kustom (grid) | 1 |
| 22 | Hapus / Pulihkan / Perpanjang ke sini | A | `word-toolbar.mjs` | Tr toolbar | `Toolbar` | 2 |
| 23 | Edit kata (Enter, dobel klik) | A | `WordEditor.jsx` | Tr | inline | 2 |
| 24 | **Edit caption per baris (Baris)** | A (dipindah) + diperluas | `quick/CaptionLinesCard.jsx`, `caption-lines.mjs` | Tr | `ToggleButtonGroup`, `TextField` | 1 + ketik |
| 25 | Mulai / Akhiri di sini (I/O) | A | `word-toolbar.mjs` | Tr toolbar | `Button` | 2 |
| 26 | Kata kunci (Ctrl+E, Ctrl+klik) | A | `word-toolbar.mjs`, §5.55 | Tr ⋯ / Ctrl+klik | `Dropdown` | 3 / 1 |
| 27 | Sembunyikan dari caption | A | `word-toolbar.mjs` | Tr ⋯ | `Dropdown` | 3 |
| 28 | Jadikan cold open | A | `word-toolbar.mjs` | Tr ⋯ | `Dropdown` | 3 |
| 29 | Chip Pulihkan | A | `RemovalChip.jsx` | Tr | `Chip` | 1 |
| 30 | ＋3 kalimat | A | `TranscriptPanel.jsx` | Tr | `Button` | 1 |
| 31 | Rapikan n (Drawer, Terapkan) | A | `CleanupReview.jsx`, `cleanup-model.mjs` | Tr → M | `Drawer`, `CheckboxGroup` | 3 |
| 32 | Cek ejaan | A | `spelling/SpellingReview.jsx` | Tr → M (tab 2) | `Drawer`, `Tabs` | 3 |
| 33 | **Pisah segmen di playhead** | B | — | S | `Button` | 2 |
| 34 | **Duplikat segmen** | B | — | S | `Button` | 2 |
| 35 | **Urutkan segmen** | B | — | S | RAC `GridList` + DnD | 2 (atau 1 seret) |
| 36 | **Hapus segmen** | B | — | S | `Button` | 2 |
| 37 | **Jadikan klip baru (dari segmen)** | B | — | S ⋯ | `Dropdown` | 3 |
| 38 | **Gabungkan klip** | B | — | K → M | RAC `GridList` multi, `Modal` | 4 |
| 39 | **Duplikat klip** | B | — | K ⋯ | `Dropdown` | 2 |
| 40 | **Hapus klip turunan** | B | — | K ⋯ | `Dropdown` + `AlertDialog` | 3 |
| 41 | Caption on/off | A | `TextPanel.jsx`, `caption-model.mjs` | Tx | `Switch` | 1 |
| 42 | 6 paket caption | A | `TextPanel.jsx`, `pack-images.js` | Tx | `RadioGroup` + `Card` | 1 |
| 43 | Ukuran / posisi (3 pil) | A | `TextPanel.jsx` | Tx | `ToggleButtonGroup` | 1 |
| 44 | Ukuran / posisi halus | A | `TextPanel.jsx` | Tx L | `Slider` | 3 |
| 45 | Geser dari wajah | A | §5.50 | Tx (kondisional) | `Button` | 1 |
| 46 | Warna sorot | A | `TextPanel.jsx` | Tx | `ColorSwatchPicker` | 1 |
| 47 | Kata per baris, Animasi masuk, Huruf besar, Warna kata kunci | A | `TextPanel.jsx` | Tx L | `ToggleButtonGroup`, `Switch` | 2–3 |
| 48 | Hook on/off, teks n/90 | A | `quick/HookCard.jsx`, `hook-model.mjs` | Tx | `Switch`, `TextArea` | 1–2 |
| 49 | Saran hook (Perbarui, Pakai) | A | `suggestions/*` | Tx | `ListBox` | 2 |
| 50 | Desain hook, durasi, posisi | A | `TextPanel.jsx` | Tx L | `RadioGroup`, `Slider` | 3 |
| 51 | Pakai di semua klip (Caption / Tata letak / Logo) | A | `apply-all/ApplyAll.jsx` | Tx/TL/Lo | `Button` → `AlertDialog` → `Toast` Urungkan | 2 (+1 kalau di tab lain) |
| 52 | Mode tata letak (kartu) | A | `LayoutPanel.jsx`, `layout-model.mjs` | TL | `RadioGroup` kartu | 2 |
| 53 | Otomatis (seluruh klip) | A (Fase 7 RF-M5a) | — | TL | kartu | 2 |
| 54 | **Override per shot (menimpa Otomatis)** | B | — | TL strip shot → `ShotPopover` | RAC `GridList` + `Select` | 4 (tab + shot + Select + opsi); lanjutan ≤ 5 |
| 55 | **Kembalikan shot ke Otomatis** | B | — | `ShotPopover` | `Button` | 3 |
| 56 | Progres analisis, Coba lagi | A | `layout-analysis.mjs` | TL | `ProgressBar` | 0–1 |
| 57 | Bagian tanpa wajah | A | `LayoutPanel.jsx` | TL | `RadioGroup` | 2 |
| 58 | Kembali ke otomatis (hapus titik bingkai) | A | `ClearKeyframes` | TL L | `Button` | 3 |
| 59 | Zoom 100–150% | A | `SetZoom` | TL L | `Slider` | 3 |
| 60 | Layar terbagi: pembagian, tukar, perbesar | A | `SetSplitRatio`, `SwapSplit`, `SetSplitCrop` | TL / TL L | `ToggleButtonGroup`, `Slider` | 2 / 3 |
| 61 | Tambah musik + hak cipta | A | `MusicPanel.jsx`, `music-upload.mjs` | Au | RAC `FileTrigger` + `AlertDialog` | 4 (tab + Tambah + pilih file OS + Setuju) |
| 62 | Ganti / Hapus musik | A | `MusicPanel.jsx` | Au | `Button` | 2 |
| 63 | Volume musik | A | `SetMusicGain` | Au | `Slider` | 2 |
| 64 | Kecilkan saat bicara + kekuatan | A | `SetDuck` | Au | `Switch`, `ToggleButtonGroup` | 2 |
| 65 | Detail ducking, Mulai dari, Ulangi, Fade | A | `SetDuck`, `SetMusicOffset`, `SetMusicLoop`, `SetMusicFades` | Au L | `Slider`, `NumberField`, `Switch` | 3–4 |
| 66 | Volume suara asli, Samakan kenyaringan | A | `SetSourceGain`, `SetLoudness` | Au | `Slider`, `Switch` | 2 |
| 67 | Tambah logo | A | `LogoPanel.jsx`, `logo-upload.mjs` | Lo | `FileTrigger` | 3 (tab + Tambah + file OS) |
| 68 | Ganti / Hapus logo | A | `LogoPanel.jsx` | Lo | `Button` | 2 |
| 69 | 4 sudut | A | `MoveLogo` | Lo | `ToggleButtonGroup` | 2 |
| 70 | Ukuran, opasitas logo | A | `ResizeLogo`, `SetLogoOpacity` | Lo L | `Slider` | 3 |
| 71 | Geser ke area aman | A | `SnapLogo` | Lo (kondisional) | `Button` | 2 |
| 72 | Teks watermark (teks; posisi/ukuran/opasitas) | A | `WatermarkSection.jsx` | Lo / Lo L | `TextField`, `RadioGroup`, `Slider` | 2 / 3 |
| 73 | Cold open on/off, Putar, Hapus | A | `ColdOpenPanel.jsx` | CO | `Switch`, `Button` | 2 |
| 74 | Saran cold open | A | `ColdOpenSuggestions.jsx` | CO | `ListBox` | 3 |
| 75 | Awal/akhir ±kata | A | `NudgeColdOpen` | CO | `NumberField` | 2 |
| 76 | ±0,1 dtk | A | `NudgeColdOpen` | CO L | `NumberField` | 3 |
| 77 | Transisi, whoosh, Putar transisi | A | `TransitionSection.jsx` | CO | `ToggleButtonGroup`, `Switch` | 2 |
| 78 | Linimasa detail: jalur, trim per segmen, zoom, penanda | A | `timeline/*` | Lin | kustom | 1 buka + aksi |
| 79 | Ekspor klip ini (Ctrl+Shift+E) | A | `ExportDialog.jsx`, `export-flow.mjs` | TB → M | `Modal` | 2 |
| 80 | **Ukuran Asli · 720p** (dokumen 1080 saja) | B | — | M | `RadioGroup` | 3 |
| 81 | Cek di ekspor: Perbaiki/Lihat + satu **Ekspor tetap** | A (ubah, §15) | `ExportDialog.jsx` | M | `Alert`, `Button` | +1 |
| 82 | Progres, Batal, Coba lagi | A | `ExportDialog.jsx` | M + `⇣n` | `ProgressBar` | 1 |
| 83 | Unduh MP4 / SRT; Salin judul, deskripsi, hashtag | A | `ExportDialog.jsx` | M | `Button`, `Dropdown` | 1 |
| 84 | Ekspor sebelumnya | A | `ExportDialog.jsx` | M L | `Table` | 3 |
| 85 | **Antrean ekspor `⇣n`** | B (UI; antrean server sudah ada) | `render_queue.py` | TB | `Popover` | 1 |
| 86 | **Ekspor semua** | B | — | TB ▾ → M | `Dropdown`, `Modal`, `CheckboxGroup` | 3 |
| 87 | **Terbitkan / Jadwalkan dari editor** | B | `components/PublishDrawer.jsx` (Fase 8) | TB ▾ atau setelah ekspor → `Drawer` | `Drawer`, `Select`, `TextArea`, `DatePicker` | ≥ 5 |
| 88 | **Kehadiran (avatar)** | B | — | TB | `AvatarGroup` | 0 |
| 89 | Hapus teks watermark | A | `RemoveWatermark`, `watermark-model.mjs` | Lo | `Button` | 2 |
| 90 | Progres unggahan + Batalkan unggahan (musik, logo) | A | `MusicPanel.jsx`, `LogoPanel.jsx` | Au / Lo | `ProgressBar`, `Button` | 1 |
| 91 | Dengarkan transisi / saran cold open (audisi) | A | `use-audition.js`, `TransitionSection.jsx`, `ColdOpenSuggestions.jsx` | CO | `Button` | 2 |
| 92 | Penanda jeda Rapikan di transkrip (`gap_silent`/`gap_voiced`) | A | `TranscriptPanel.jsx` | Tr | kustom | 0 |

Catatan hitungan per shot (#54): 04-reframe-unduhan.md §A8.3 menulis "3 klik" karena menghitung dari tab Tata letak yang sudah terbuka (shot → `Select` → opsi). Dokumen ini menghitung dari tab Teks (+1 tab) sesuai §2.3, jadi 4. Keduanya konsisten.

**Ditunda:**
- Efek warna (kecerahan, kontras, saturasi, hue, blur) ditunda ke Fase 12. Fitur ini butuh gate S-COLOR/P-COLOR baru.
- "Bisukan suara asli" tidak dibuat sebagai kontrol sendiri. Cukup Volume suara asli di −24 dB.
- Mode ponsel hanya sebagian (§3.1).

## 11. Backend dan `edit_v2`

### 11.1 Daftar amendemen minor-0 (CONTRACTS §3.8)

Semua amendemen bersifat aditif di bawah `schema_minor: 0`. Dokumen lama tetap valid dengan makna yang sama, dan **plan-nya byte-sama** (golden). Kalau editor dan server lama berbeda versi, server lama menolak lewat jalur validasi yang sudah ada:

| Amendemen | Bagian CONTRACTS | Penolakan oleh server lama |
|---|---|---|
| > 1 body di `main.segments` (≤ `MAX_BODIES`) | §5.66 **(baru)** | `op_disabled` (index ≥ 2, `doc.py` `segments_rule`) / `range_invalid` (body ke-2) |
| `layout.ranges` dengan `origin:user` (skema di §5.63, Fase 0) | §5.63 | `unknown_key` |
| `base.origin.kind: "derived"` + `parents`, `derived_kind` | §5.67 **(baru)** | `unknown_key` / `range_invalid` (`choices={"v3_clip"}`, `doc.py:813`) |
| Render request `size: "720p"` | §5.68 **(baru)** | Body route lama menolak dengan 400 `invalid_request` (regex `clip-renders.mjs:297`); queue lama: `value["size"] != "output"` (`render_queue.py:560`) |

Nomor §5.66–§5.69 dialokasikan di PR kontrak Fase 10. §5.59–§5.65 sudah dipakai rencana lain. §5.69 **(baru)** = "Editor satu tata letak" (UI: §2–§9 dokumen ini) dan **menggantikan** §5.27 "Editor views: Mode Cepat and Mode Lengkap". Bagian §5.27 yang bukan soal tampilan (kunci baris caption `<seg>:<firstWordId>`, bentuk `captionRows`) tetap berlaku dan dirujuk dari §5.69.

### 11.2 Segmen ganda: dokumen

```json
"main": {
  "cut_fade_ms": 8,
  "segments": [
    {"id": "co", "role": "cold_open", "in_sf": 1200, "out_sf": 1290},
    {"id": "s1", "role": "body", "in_sf": 900,  "out_sf": 1500},
    {"id": "s2", "role": "body", "in_sf": 300,  "out_sf": 620},
    {"id": "s3", "role": "body", "in_sf": 900,  "out_sf": 1100}
  ],
  "removals": [{"id": "r1", "seg": "s2", "in_sf": 400, "out_sf": 420, "words": [], "reason": "user", "origin": "user"}],
  "joins": [{"after": "co", "style": "cut", "audio_fade_ms": 0}]
}
```

- **Urutan array = urutan keluaran.** Cold open (opsional) selalu di index 0.
- Body boleh mundur dan boleh tumpang tindih di sumber (s3 menduplikasi sebagian s1).
- `joins` tetap hanya untuk `after` = cold open. Batas antar-body memakai `cut_fade_ms` (G-CLICK).
- Id segmen dibuat klien: `s` + base36 counter, unik per dokumen. Counter = 1 + nilai base36 terbesar di antara id berpola `^s[0-9a-z]+$` yang ada di dokumen (id seed lain tidak diubah), sehingga deterministik untuk undo/redo dan rebase.

### 11.3 Validator (`src/ai_clipper/edit_v2/doc.py`)

| Aturan | Sekarang | Baru |
|---|---|---|
| Jumlah segmen | `index >= 2` → `op_disabled` (`segments_rule`) | Body > `MAX_BODIES` (8) → `range_invalid` pada `/main/segments/<i>`. Cold open > 1 atau bukan index 0 → `cold_open_invalid` (tetap) |
| Body ganda | Body ke-2 → `range_invalid` | Diizinkan. `self.body_index` diganti `self.body_indices: list[int]`, dan `self.first_body` = body pertama dalam urutan keluaran |
| Id unik | `segment_index.setdefault` (id ganda tidak ditolak di `segments_rule`) | Id ganda → `range_invalid` pada `/main/segments/<i>` kedua |
| `op_disabled` untuk index ≥ 2 | `segments_rule` | Dihapus; diganti batas `MAX_BODIES` |
| Durasi 3–300 dtk | Per body tunggal (`doc.py` sekitar :1124–1128) | **Jumlah** frame keluaran semua body setelah removals (`tm.total_frames` tanpa cold open) → `duration_out_of_bounds` di `/main/segments` |
| Aturan cold open | Terhadap body tunggal (sekitar :1136–1148) | Terhadap `first_body` |
| Removals | `removal_outside_segment` | Tetap, per `seg` |
| `outside_window` | Per segmen | Tetap |
| Tumpang tindih body | — | Diizinkan |

**Tes:** `tests/test_edit_v2_doc.py` ditambah kasus untuk 2, 8, dan 9 body; body mundur; body tumpang tindih; id ganda; durasi jumlah 2,9 dtk dan 300,1 dtk; cold open terhadap body pertama.

### 11.4 Timemap, kompiler, caption, plate

- **Timemap:**
  - `timemap.py` `pieces` dan `web/lib/editor/timemap.mjs` sudah menghasilkan potongan berurutan per segmen. Tidak ada perubahan logika.
  - Tambah vektor di `tests/fixtures/edit_v2/timemap-vectors.json`: urutan mundur, duplikat, 8 body.
  - Golden JS dan Python harus sama (`tests/test_edit_v2_timemap.py`, `web/tests/editor-timemap.test.mjs`).
- **Kompiler (`compile_ffmpeg.py`):**
  - Tidak ada jalur graf baru. `decoder_runs` (R2) sudah membuka run baru untuk lompatan mundur atau jarak ≥ 10 dtk, dan `picture()` menggabung run dengan `concat`.
  - Setiap run = satu input `-ss` dengan decoder sendiri di bawah `RLIMIT_AS` 3 GiB (`execute.py:53`). Risiko ini diukur lewat PF-SEG (§13).
  - Tes: `tests/test_edit_v2_compile.py` mengecek bahwa graf untuk 1 body byte-sama dengan golden, dan untuk 3 body mundur menghasilkan 3 run + `concat=n=3`.
- **Caption (`captions.py`):**
  - Cue tidak boleh melintasi batas segmen.
  - Kunci baris caption tetap `<seg>:<firstWordId>` (§5.27).
  - `word_edits` berlaku di semua salinan.
  - Tes: ASS golden untuk dokumen duplikat.
- **Plate (`plates.py`, `web/lib/editor/player/plate-source.mjs`):**
  - Sel plate dikunci per sel sumber, sehingga duplikat memakai cache yang sama.
  - `presenter.mjs` menangani lompatan mundur antar-potongan (seek plate baru).
  - Tes: `web/tests/editor-player-plate.test.mjs` dan `editor-player-presenter.test.mjs` ditambah kasus mundur dan duplikat.

### 11.5 Override per shot (`layout.ranges`, F4b)

- **Skema, aturan validasi V1–V9, kanonisasi, `merge_user_ranges`, apply-all, command, dan kode error** milik 04-reframe-unduhan.md §A6 (CONTRACTS §5.63, Fase 0). Bagian ini tidak mendefinisikan ulang; editor hanya memakai:
  - command `SetShotMode` (dari `ShotPopover` `Select`), `ResetShot` (tombol **Otomatis** di `ShotPopover`), `ResetAllShots` ("Kembali ke otomatis" di Lanjutan Tata letak);
  - kode tolak `shot_not_found`, `shot_mode_invalid` (kunci `errors.editor.<code>`, 07-i18n.md §10.2).
- **Aturan sisi editor:**
  - Klien hanya menulis range `origin:"user"` dengan `mode ∈ {camera, fill_center, fit_blur}`; range `origin:"auto"` (termasuk `split` dari engine) tidak pernah ditulis klien.
  - Strip shot disembunyikan untuk `layout.default.mode = split` (V5 melarang `ranges` di sana).
  - Batas shot di strip dibaca dari shot plan (`base.shots`), bukan dihitung klien.
- **Graf:** saklar per frame pola §5.40 (`if(lt(n,K))`), diperluas ke `fill_center`.
- **Gate:** P-FRAME dan P-PLATE dengan 2 dan 3 range campuran, S-COLOR, pengukuran memori.
- **Tes:**
  - `tests/test_edit_v2_layout_switch.py` (ditambah kasus);
  - `tests/test_edit_v2_apply_all.py` (ranges tidak disalin);
  - `web/tests/editor-shots.test.mjs` **(baru)**.

### 11.6 Klip turunan (gabung, jadikan klip baru, duplikat klip; F7)

**Registri `JOBS_ROOT/<job>/analysis/derived-clips.json` (baru).** Tetap file, bukan tabel DB (01-arsitektur-data.md §3.1, §6.4). Berkas kanonis 0600. Penulisan memakai `flock` di `analysis/.derived-clips.lock` dan pola tulis atomik `store.py`.

```json
{
  "schema": "potongin.derived-clips/1",
  "next_seq": 3,
  "clips": [
    {
      "clip_id": "clip_<24 hex>",
      "seq": 1,
      "kind": "merge",
      "parents": ["clip_a…", "clip_b…"],
      "parent_revisions": [4, 0],
      "ranges_ms": [[61200, 83400], [12000, 30500]],
      "window_ms": [0, 143400],
      "created_at_ms": 1761300000000,
      "created_by": "<principal.id (users.id, UUID)>",
      "idempotency_key": "<uuid>",
      "dropped_edits": 0,
      "state": "active",
      "deleted_at_ms": null
    }
  ]
}
```

- **`clip_id`:**
  - Rumus: `"clip_" + sha256("potongin-clip-derived-v1\0" ‖ source_content_sha256 ‖ "\0" ‖ kind ‖ "\0" ‖ ranges "a-b,c-d" ‖ "\0" ‖ parents "," ‖ "\0" ‖ idempotency_key)[:24]`.
  - Polanya tetap `CLIP_ID_PATTERN` (`clip_id.py`), jadi `isClipId` di `web/lib/clip-edit.mjs` tidak berubah.
  - Fungsinya `derived_clip_id(...)` **(baru)** di `clip_id.py`.
- **Jendela:**
  - Bentang sumber = `max(ranges.out) − min(ranges.in)`. Kalau bentang > 1 200 000 ms (20 menit, Q12) → `merge_too_far`. Ini angka yang sama dengan cek klien di §9.
  - Jendela = `[min − 60 000, max + 60 000]`, dipotong ke `[0, durasi sumber]` (jadi lebar jendela maks. 22 menit).
  - Gabung hanya untuk klip dari job yang sama; klip lain tidak bisa dipilih karena daftar Klip per job.
- **Seed** dibangun dengan fungsi `seed.py` yang sama seperti prepare, dengan jendela di atas. Artefak kata, peaks, dan source baru disimpan di `analysis/clips/<clip_id>/`.
- **Isi seed turunan:**
  - **Sumber induk:** dokumen tersimpan terkini tiap induk (atau seed kalau belum diedit), dibaca di bawah lock registri. Revisi yang dipakai dicatat di entri registri sebagai `parent_revisions: [int…]` (sejajar `parents`).
  - **Merge:** body = semua body setiap induk dalam urutan pilihan (induk yang sudah punya > 1 body menyumbang semuanya). Jumlah body > `MAX_BODIES` → `too_many_segments`; total keluaran < 3 dtk atau > 300 dtk → `duration_out_of_bounds`. **Cold open induk dibuang** (klip gabungan tanpa cold open; pengguna bisa menambahkannya lagi). `removals` dan `layout.keyframes` dibawa per segmen. `captions`, `layout.default`, `tracks`, `watermark`, `audio` diambil dari induk #1. `word_edits` dipetakan lewat waktu sumber kata ke id kata artefak baru; kata yang tidak terpetakan dibuang dan dihitung di `dropped_edits`.
  - **Extract** (Jadikan klip baru): satu body = segmen terpilih dari dokumen tersimpan induk.
  - **Duplicate:** salinan dokumen tersimpan induk, termasuk cold open.
  - **Kamera:** plan kamera dibawa hanya kalau analisis induk mencakup jendela. Kalau tidak, mode Ikuti wajah ditolak dengan cek `camera_missing` (pesan "Tanpa data wajah") dan mode jatuh ke Latar blur.
- **`base.origin` turunan:** `{"kind": "derived", "derived_kind": "merge|extract|duplicate", "parents": [...]}`. `selection_artifact_sha256`, `rank_at_seed`, `hook_unit_id` tidak ada. Di registri posting klip ini disimpan dengan `posts.clip_kind = 'derived'`, `selection_keys_json = NULL`, `excluded_reason = 'derived'` (01-arsitektur-data.md §4.5), sehingga dikeluarkan dari profil performa (X6).

**Op Python di `edit_v2/api.py`.** Ditambahkan ke `OPS` dan `_FIELDS`:

| Op | Field (persis) | Hasil (stdout) | Kode error |
|---|---|---|---|
| `merge_clips` | `jobId, clipIds, idempotencyKey` | `{clipId, seq, droppedEdits}` | `not_found`, `merge_too_far`, `too_many_segments`, `duration_out_of_bounds`, `analysis_missing`, `idempotency_conflict` |
| `derive_clip` | `jobId, clipId, etag, segIds, idempotencyKey` (`segIds: []` = duplikat seluruh klip) | sama | `not_found`, `revision_conflict`, `range_invalid`, `idempotency_conflict` |
| `delete_derived_clip` | `jobId, clipId` | `{clipId, deleted: true}` | `not_found`, `not_derived` |

- `delete_derived_clip` = soft delete (`state:"deleted"`).
- `janitor.py` ditambah satu langkah: direktori `analysis/clips/<id>/` milik turunan yang terhapus > 30 hari dihapus. Ekspor di `output/edits/<clip_id>/` ikut kebijakan retensi yang ada.
- Kode error baru masuk `edit_v2/errors.py` `_MESSAGES` dan `web/messages/<code>/errors.json` untuk **setiap** locale (`errors.edit.merge_too_far`, `errors.edit.not_derived`, `errors.edit.too_many_segments`, `errors.edit.size_unsupported`). Teks `id` harus sama persis dengan `_MESSAGES` (`i18n-error-codes.test.mjs`, 07-i18n.md §10.2, §14). Kode yang diberi entri Bantuan juga mendapat `hints.edit.<code>` di semua locale (07-i18n.md §10.4).
- **Etag untuk extract/duplicate:** klien mengirim `edit.etag` dari entri daftar klip (`_attach_edit` di `api.py` sudah mengisi `edit: {state, revision, etag, updatedAtMs}`); klip tanpa `edit` (belum di-prepare) tidak bisa diduplikat (`not_found`).

**Route HTTP (baru).** Aturan umum (guard milik 02-multiuser-keamanan.md §7.2–§7.4):
- semua route memakai `secureRoute(handler, {params, owner: "job", notFound, limit: "api"})`; langkah `readOwnedJob` membuat 404 identik untuk "tidak ada" dan "milik orang lain"; mutasi melewati `sameOriginMutation` (403 `csrf_rejected`);
- `Idempotency-Key` UUID wajib untuk POST;
- route yang menulis byte atau render request menjalankan admission storage global (`storage_full`) dan kuota per user (507 `user_storage_quota`, 02-multiuser-keamanan.md §10.4) sebelum menulis;
- saat drain deploy (02-multiuser-keamanan.md §10.5) route tetap menerima request; render request tetap `queued` sampai render-worker mengklaim lagi.

Entri matriks route (format 02-multiuser-keamanan.md §8, juga masuk `scripts/security/route_policy.json`, 08-fase-test-deploy.md):

| Route | Method | Auth | Peran | Pemilik | `notFound` | Fase |
|---|---|---|---|---|---|---|
| `/api/jobs/[id]/derived-clips` | POST | ses | M | job | `job` | 11 F7 |
| `/api/jobs/[id]/derived-clips/[clipId]` | DELETE | ses | M | job | `job` | 11 F7 |
| `/api/jobs/[id]/renders` | GET | ses | M | job | `job` | 11 F8 |
| `/api/jobs/[id]/renders/batch` | POST | ses | M | job | `job` | 11 F8 |
| `/api/jobs/[id]/clips/[clipId]/presence` | POST | ses | M | job | `edit` | 11 (setelah Fase 6) |
| `/api/jobs/[id]/clips/[clipId]/renders` (ada, #33) | GET, POST | tidak berubah | | | `renderError` (tetap) | 11 F8 (body `size`) |

| Method dan path | Body | Sukses | Error |
|---|---|---|---|
| `POST /api/jobs/:id/derived-clips` → `web/app/api/jobs/[id]/derived-clips/route.js` **(baru)**, lib `web/lib/derived-clips.mjs` **(baru)** | ≤ 4 KiB, tepat salah satu: `{"kind":"merge","clipIds":[2..8]}` · `{"kind":"extract","clipId","editEtag","segIds":[1..8]}` · `{"kind":"duplicate","clipId","editEtag"}` | `201 {clipId, seq, droppedEdits, editorHref}`; ulangan kunci yang sama → `200` dengan isi sama | 400 `invalid_request`; 404 `not_found`; 409 `revision_conflict`, `idempotency_conflict`, `merge_too_far`, `analysis_missing`; 413 `payload_too_large`; 422 `too_many_segments`, `duration_out_of_bounds`; 503 `backend_unavailable`; 507 `storage_full` / `user_storage_quota` |
| `DELETE /api/jobs/:id/derived-clips/:clipId` → `.../derived-clips/[clipId]/route.js` **(baru)** | — | `200 {clipId, deleted: true, cancelledPosts: n}` | 404 `not_found`; 409 `not_derived`; 503 |

Sebelum memanggil `delete_derived_clip`, lib JS membatalkan render antre milik klip itu (`render_queue cancel`) lalu run terbit klip itu dengan aturan yang sama seperti hapus job (03-sosmed-performa.md §6.5–§6.6, transisi T10): run `scheduled` → `cancelled`, run `claimed`/`uploading` diberi `cancelRequested`. Fungsinya varian per klip dari `cancelRunsForJob`, yaitu `cancelRunsForClip(ownerId, jobId, clipId)` dengan `error_code='social_clip_deleted'` (harus ditambahkan di 03). `cancelledPosts` = jumlah run yang dibatalkan. Posting yang sudah terbit tetap menyimpan snapshot `packaging_json`.

**Pembaca daftar klip.** Satu fungsi di tiap bahasa, dengan tes paritas:
- Python `_clips` (`api.py`; sekarang membangun entri dari `selection.clips`, atau `_manifest_entries` untuk job non-v3) dan JS `listJobClips(job)` di `web/lib/jobs.mjs` (dibuat SOS-M3a, diperluas di sini) menambahkan entri turunan aktif **setelah** entri pipeline. Turunan hanya ada untuk job v3 (butuh `clipId`).
- Field entri: `index` = (index pipeline terbesar) + `seq`, ditambah `derived: {kind, parents, seq}` (`null` untuk klip pipeline). `title` = judul induk #1 + ` (n)` untuk semua jenis, dengan `n` = `seq + 1` (netral bahasa, celah 5). `durationMs` dan `edit` diisi `_attach_edit` seperti klip pipeline.
- **Deteksi turunan di registri posting:** `clipId` turunan tidak bisa dikenali dari bentuknya (hash, pola sama). Sesuai 01-arsitektur-data.md §4.5, `createPost` memakai `listJobClips(job)`: `entry.derived !== null` → `clip_kind = 'derived'`. 03 §13.2 dan 08 Fase 11 F7 memakai aturan yang sama (namespace `potongin-clip-derived-v1` hanya domain hash `clip_id`, bukan cara deteksi).
- Konsumen yang ikut diperbarui:
  - halaman proyek `web/app/projects/[id]/page.jsx`;
  - Riwayat/Proyek `web/app/projects/page.jsx` + `web/lib/clip-library.mjs` (§5.32);
  - ZIP `web/lib/clips-zip.mjs` (§5.28);
  - saklar hook `edit_v2/hook_toggle.py` (§5.57);
  - judul/deskripsi (§5.38; turunan memakai judul induk #1 + ` (n)`, lihat di atas);
  - registri posting.
- Tes paritas: `web/tests/list-job-clips-parity.test.mjs` (dibuat SOS-M3a untuk fixture manifest, 03-sosmed-performa.md) diperluas: membandingkan keluaran subproses Python `_clips` dengan `listJobClips` pada fixture `tests/fixtures/edit_v2/derived/` **(baru)**.

### 11.7 Ekspor: ukuran Asli · 720p

- **Body route** `POST /api/jobs/:id/clips/:clipId/renders` (`web/lib/clip-renders.mjs`):
  - Regex body tunggal (baris 297) diganti parser JSON ketat dengan kunci ⊆ `{editEtag, size}` dan `size ∈ {"output", "720p"}` (default `output`).
  - Body tanpa `size` tetap valid.
- **Queue (`src/ai_clipper/render_queue.py`):**
  - `_V3_OPS` (sekitar baris 1456): `size` ditambahkan ke **kunci opsional** `create` dan `estimate` (tanpa `size` = `"output"`, jadi envelope lama tetap valid). `_V3_ARG_PATTERNS` mendapat `size: ^(output|720p)$`.
  - Validasi request file baris 560 menjadi `value["size"] not in {"output", "720p"}`.
  - `720p` hanya diterima kalau sisi pendek `doc.output` = 1080. Selain itu 422 `size_unsupported` (kode baru, `errors.edit.size_unsupported`).
  - Ukuran target = sisi pendek 720 dengan rasio sama (1080×1920 → 720×1280, 1080×1080 → 720×720).
  - `render_key(plan, size=(w, h), …)` (`edit_v2/plan.py:454`) sudah menerima ukuran sebagai tuple; dipanggil dengan ukuran target (sekarang `render_queue.py:1150–1152` memakai `doc.output`). R10 (`content_equals_seed`) hanya berlaku untuk `size == "output"`.
  - `predicted_render_ms` memakai entri `RENDER_COST_PERMILLE[(layout, (720, 1280))]` / `(720, 720)` yang sudah ada.
- **Kompiler:**
  - `scale=w:h:flags=lanczos` ditambahkan di akhir rantai, setelah ASS dan logo, sebelum `format` BT.709.
  - ASS dan grafik dirender pada ukuran dokumen, sehingga pratinjau tidak berubah.
- **`verify.py`:** `verify_output(..., size=<ukuran diminta>)` (dipanggil di `render_queue.py:960`, sekarang `size=plan.output`).
- **Gate:** P-ENC mendapat fixture skala turun (`scripts/parity/enc_check.py`). P-TXT tidak terdampak.
- **UI:**
  - `RadioGroup` "Ukuran: Asli · 720p" di Lanjutan modal Ekspor, hanya untuk dokumen 1080.
  - Ringkasan modal menampilkan resolusi hasil dan perkiraan ukuran berkas.

### 11.8 Ekspor semua

- **Route:** `POST /api/jobs/:id/renders/batch` → `web/app/api/jobs/[id]/renders/batch/route.js` **(baru)**.
- **Request:**
  - `Idempotency-Key` wajib.
  - Body ≤ 8 KiB: `{"clipIds": [1..50], "size": "output"|"720p"}`.
- **Proses** (di JS, tanpa op Python baru):
  - Daftar klip dibaca sekali lewat `listJobClips(job)`. Untuk setiap `clipId` di body: entri tanpa `edit` → `skipped/not_openable`; selain itu panggil `render_queue create` dengan `editEtag = entry.edit.etag`, `size`, dan kunci idempotensi `uuidv5(batchKey, clipId)` (namespace = `Idempotency-Key` request).
  - Klip diproses berurutan (bukan paralel) supaya admission storage menghitung reservasi satu per satu; `storage_full` atau `user_storage_quota` (02-multiuser-keamanan.md §10.4) pada satu klip menandai klip itu dan semua klip sesudahnya `skipped` dengan kode itu.
  - Klip seed dengan `output` → R10, yang menghasilkan `state:"completed"` langsung.
- **Respons:** `202 {batchId, items: [{clipId, state: "queued"|"completed"|"skipped", renderId|null, reason|null}]}`.
  - `reason ∈ {not_openable, size_unsupported, storage_full, user_storage_quota, backend_unavailable}`.
  - Satu klip yang gagal tidak menggagalkan batch.
- **Error tingkat request:** 400, 404, 409 `idempotency_conflict`, 413, 503.
- **Unduh semua:** memakai route ZIP yang sudah ada (§5.28).
- **UI:**
  - Ekspor ▾ → **Ekspor semua…** membuka `Modal` berisi `CheckboxGroup` (semua klip tercentang; yang tidak bisa dibuka nonaktif beserta alasannya), Ukuran, lalu **Ekspor n klip**.
  - Progres per klip tampil di Popover `⇣n`.
- Next memilih segmen statis `renders/batch` di atas `renders/[renderId]` yang sudah ada; `batch` bukan UUID, jadi `[renderId]` tidak pernah menerimanya (validasi `ROUTE_PARAMS`).

### 11.8a Daftar render aktif (untuk `⇣n`)

| Method dan path | Auth | Respons | Error |
|---|---|---|---|
| `GET /api/jobs/:id/renders` → `web/app/api/jobs/[id]/renders/route.js` **(baru)** | `secureRoute({params: ["id"], owner: "job", notFound: "job", limit: "api"})` | `200 {items: [dto…]}` hanya request yang belum final (bukan `completed`/`failed`/`canceled`), urut waktu dibuat; `Cache-Control: no-store` | 404 `not_found` (identik); 503 `backend_unavailable` |

Implementasi: fungsi baru `activeRenders(jobId, jobsRoot)` di `web/lib/clip-renders.mjs`, yang memakai `v3Requests` yang sudah ada (dipakai `latestRenders`, baris 255; `latestRenders` sendiri hanya memberi satu render terbaru per klip, jadi tidak cukup) dan `latestRenderDto(jobId, request)` per item. Batal per item memakai `DELETE /api/jobs/:id/renders/:renderId` yang sudah ada (`renders/[renderId]/route.js`). Tes: `web/tests/renders-list-route.test.mjs` **(baru)**.

### 11.9 Kehadiran dan konflik (bergantung Fase 6, akun)

- **Route:** `POST /api/jobs/:id/clips/:clipId/presence` **(baru)**.
- **Request:** body `{"tabId": "<uuid>"}`, dikirim tiap 20 dtk dan saat `visibilitychange`.
- **Guard:** `secureRoute({params: ["id", "clipId"], owner: "job", notFound: "edit", limit: "api"})` (02-multiuser-keamanan.md §7.2). Karena pemilik = pemilik job (admin tidak dikecualikan), `others` hanya berisi tab lain milik pengguna yang sama sampai ada berbagi proyek; nama = `users.display_name` (01-arsitektur-data.md §4.1).
- **Respons:** `200 {others: [{userId, name}]}`, `Cache-Control: no-store`.
- **Error:** 400 `invalid_request` (body bukan `{tabId: uuid}` atau > 1 KiB); 403 `csrf_rejected`; 404 `not_found` keluarga `edit`; 429.
- **Penyimpanan:** map dalam memori app dengan TTL 45 dtk; tidak masuk DB.
- Id pengguna dicatat di receipt simpan (`store.py`), bukan di `audit.editor` (`commands.mjs`).
- `ConflictDialog.jsx` menyebut nama pengguna dari receipt.
- Tidak ada CRDT dan tidak ada kunci (Q12 default).

### 11.10 Terbitkan dari editor

- Memakai ulang `components/PublishDrawer.jsx` dari Fase 8 (rencana sosmed). Editor tidak membuat UI publikasi sendiri.
- **Titik masuk:**
  - Ekspor ▾ → **Terbitkan…**;
  - tombol **Terbitkan** di modal Ekspor setelah selesai.
- **Pilihan file:**
  - Default = ekspor `completed` terbaru dari revisi saat ini (Q7).
  - Kalau revisi saat ini belum diekspor, drawer menampilkan baris "Belum diekspor" dan tombol utama berubah menjadi **Ekspor lalu terbitkan**. Tombol ini menyimpan dulu (autosave flush), membuat render `size:"output"` (§11.7) lewat alur `export-flow.mjs` yang sama dengan modal Ekspor, menunggu `completed`, lalu memanggil submit drawer dengan `renderId` itu. Kalau render `failed`/`canceled`, drawer menampilkan errornya dan tidak mengirim.
- API terbit **milik** 03-sosmed-performa.md §9.1 (`POST /api/social/posts`, header `Idempotency-Key`, body `{jobId, clipId, media: {kind: "export", renderId}, text, when, targets}`), aturan media §6.7, dan kode error §8 (mis. 409 `social_media_unavailable` dengan `params.needsExport`). Dokumen ini tidak mendefinisikan ulang bentuknya. Hanya `renderId` `completed` yang lolos `verify.py` (atau R10) diterima; tidak ada media `auto`.
- **Pemanggil API = `PublishDrawer`** (UI milik 05-ui-dashboard.md §6.5), bukan editor. Editor hanya memberi props `{jobId, clipId, renderId | null, onRequestExport}`. `onRequestExport()` mengembalikan `Promise<renderId>` dari alur "Ekspor lalu terbitkan" editor (flush autosave dulu, supaya yang diekspor revisi terbaru), dan dipakai drawer **menggantikan** jalur ekspor bawaan 03 §6.7 butir 3 (yang membaca ETag dokumen tersimpan dan bisa melewatkan edit yang belum tersimpan). Di luar editor prop ini tidak diisi dan drawer memakai jalur bawaan. `api-client.mjs` editor **tidak** mendapat fungsi `publish`.
- Perubahan di sisi editor: `ExportDialog.jsx` (tombol Terbitkan setelah selesai), `TopBar.jsx` (▾), `EditorShell.jsx` (memasang drawer secara lazy, hanya kalau `socialEnabled`).

### 11.11 Command klien (`web/lib/editor/commands.mjs`)

- **Command baru** ditambahkan di **akhir** `COMMANDS`, supaya urutan dan kunci merge riwayat lama tidak bergeser:
  - `SplitSegment {seg, atSf}`;
  - `DuplicateSegment {seg}`;
  - `MoveSegment {seg, toIndex}`;
  - `RemoveSegment {seg}`;
  - (`SetShotMode`, `ResetShot`, `ResetAllShots` ditambahkan oleh F4b sesuai 04-reframe-unduhan.md §A6, bukan oleh F6.)
- **Command lama yang berubah argumen:**
  - `TrimStart`, `TrimEnd`, `NudgeEdge` menerima `seg` (default: body pertama/terakhir untuk pemanggil lama);
  - `RemoveWords`, `EditWordText`, `SetWordHidden`, `SetWordEmphasis` menerima `seg`.
- **Semantik command segmen** (semua murni, satu langkah undo, `mergeKey: null`; validasi gagal → `need(…)` melempar `CommandRejected` dengan kode di bawah, dokumen tidak berubah):

| Command | Efek pada `main` | Kode tolak |
|---|---|---|
| `SplitSegment {seg, atSf}` | `atSf` = frame sumber playhead (`segmentAt(doc, outFrame)` → `{seg, sf}`). Kalau `atSf` jatuh di dalam removal, dipakai `in_sf` removal itu. Body `seg` jadi `[in, atSf)` (id lama) + `[atSf, out)` (id baru) tepat sesudahnya. Removal dibagi menurut posisi: yang seluruhnya ≥ `atSf` pindah ke id baru; yang melintasi `atSf` tidak mungkin (aturan sebelumnya) | `segment_limit` (body = `MAX_BODIES`), `segment_too_short` (salah satu bagian < 1 dtk keluaran), `segment_cold_open_fixed` (`seg` = cold open) |
| `DuplicateSegment {seg}` | Salinan body (id baru) disisipkan tepat sesudah `seg`; removals `seg` disalin dengan id removal baru dan `seg` baru. `word_edits` tidak disalin (berlaku untuk semua salinan) | `segment_limit`, `duration_out_of_bounds` (total > 300 dtk), `segment_cold_open_fixed` |
| `MoveSegment {seg, toIndex}` | `toIndex` = posisi di antara **body saja** (0 = body pertama); cold open tetap di index 0 array | `segment_cold_open_fixed`, `invalid_args` (`toIndex` di luar `[0, nBody−1]`) |
| `RemoveSegment {seg}` | Body dan removals-nya dihapus | `segment_last` (tinggal 1 body), `segment_cold_open_fixed` (cold open dihapus lewat `SetColdOpen` yang ada) |
| `TrimStart`/`TrimEnd`/`NudgeEdge` `{…, seg}` | Mengubah `in_sf`/`out_sf` body `seg`; tanpa `seg` = body pertama (Start) / terakhir (End) | yang ada + `duration_out_of_bounds` (jumlah keluaran) |

- **Kode `COMMAND_MESSAGES` baru** (messageId `editor.<code>`, kunci katalog `errors.editor.<code>` sesuai 07-i18n.md): `segment_limit`, `segment_too_short`, `segment_last`, `segment_cold_open_fixed`, `duration_out_of_bounds`.
- **`web/lib/editor/rebase.mjs`:** `PARTS` sekarang memuat `"trim"`, `"removals:cold_open"`, `"removals:body"`. Aturan baru: kalau `base`, `mine`, atau `theirs` punya > 1 body, ketiga bagian `trim` + `removals:body` diganti satu bagian **`segments`** (`main.segments` body + `main.removals` body; `GROUP_LABELS.segments = "Segmen"`), yang dibandingkan dan dipilih utuh di `ConflictDialog`. Dokumen 1 body tetap memakai bagian lama (rebase dokumen lama tidak berubah; kasus golden di `editor-rebase.test.mjs`). `coldopen` dan `removals:cold_open` tetap terpisah.
- **`web/lib/editor/doc-model.mjs`:** ekspor `MAX_BODIES = 8`, `bodies(doc)`, dan `segmentAt(doc, outFrame)`.
- **Tes:** `web/tests/editor-commands.test.mjs`, `editor-history.test.mjs`, `editor-rebase.test.mjs` (kasus baru), `editor-segments.test.mjs` **(baru)**.

## 12. Alur utama (langkah demi langkah)

| # | Alur | Langkah | Klik | Target stopwatch |
|---|---|---|---|---|
| A1 | Buka dan putar | Edit klip dari proyek → frame pertama → Spasi | 1 | PF-OPEN tetap |
| A2 | Trim lewat transkrip | Pilih kata → **Hapus** (Delete) → chip Pulihkan muncul. Untuk membuang awal/akhir: klik kata → **Mulai di sini** / **Akhiri di sini** (I/O). Opsional: **Rapikan n** → tinjau → **Terapkan (n)** (satu urungkan) | 2–3 | ≤ 20 dtk |
| A3 | Ganti gaya caption | Kartu **Karaoke**. Opsional: pil Ukuran/Posisi atau seret caption. **Pakai di semua klip** → konfirmasi → Toast "Diterapkan ke 7 · 1 dilewati" + Urungkan | 1 / 3 | ≤ 10 dtk |
| A4 | Edit kata caption | Dobel klik kata → ketik → Enter (waktu kata tidak berubah). Kalau banyak: **Baris** → edit field per baris → Enter (1 urungkan per baris) | 2 / 1 + ketik | ≤ 20 dtk (= U8) |
| A5 | Musik dan logo | Tab **Audio** → **Tambah musik** → file → **Setuju** (Kecilkan saat bicara aktif, Sedang). Tab **Logo** → **Tambah logo** → file → sudut | 4 + 4 | ≤ 60 dtk |
| A6 | Framing per shot | Tab **Tata letak** → klik shot (playhead melompat) → `Select` mode → shot ditandai "Diubah". Opsional: **Lihat sumber** → seret bingkai. **Otomatis** di popover mengembalikan shot | 4 | ≤ 30 dtk |
| A7 | Cold open | Tab **Cold open** → Saran → **Pakai** → transisi | 3–4 | ≤ 20 dtk |
| A8 | Segmen | **Pisah:** seek → **Pisah**. **Duplikat:** chip → **Duplikat**. **Urutkan:** seret, atau chip → ←/→. **Hapus:** chip → **Hapus**. **Jadikan klip baru:** chip → ⋯ → item | 2 / 2 / 2 / 2 / 3 | ≤ 15 dtk per aksi |
| A9 | Gabung klip | Centang ≥ 2 klip → **Gabungkan n klip** → atur urutan → **Buat klip** → Toast **Buka** | 4 (+1 buka) | ≤ 30 dtk |
| A10 | Ekspor semua | Ekspor ▾ → **Ekspor semua…** → **Ekspor n klip** → `⇣n` → unduh ZIP di proyek | 3 | ≤ 15 dtk sampai antre |
| A11 | Ekspor dan terbit | **Ekspor** → **Mulai ekspor** (atau **Ekspor tetap**) → selesai → **Terbitkan** → akun, judul, deskripsi, hashtag → **Terbitkan sekarang** / **Jadwalkan** + tanggal | ≥ 5 | — |

Alur A1–A11 di atas adalah peta desain (diuji e2e + click budget). **Stopwatch** memakai tugas U di `docs/editor/UJI-PENERIMAAN.md`, yang nomornya sudah dipakai: U1 kata pertama terpotong (20 dtk), U2 buang omongan lewat transkrip (20 dtk), U3 ganti cold open (45 dtk), U4 saran hook + gaya caption (30 dtk), U5 logo + musik mengecil (60 dtk), U6 ekspor dan unduh (durasi + 30 dtk), U7 muat ulang lalu kembali ke versi AI (20 dtk), U8 betulkan satu kata caption (20 dtk). Dokumen ini **menambah** U9 = A9 gabung klip (30 dtk) dan U10 = A10 ekspor semua (15 dtk sampai antre). U1–U10 diukur pemilik di F10 (bersih-bersih); U1–U8 tidak boleh lebih lambat dari angka shell lama yang tercatat di dokumen itu.

## 13. Gate paritas

Semua gate dijalankan di GitHub Actions (`gh workflow run editor-gates.yml -f ref=<branch> -f suite=full|e2e|player`), tidak di PC pemilik. Smoke tetap berjalan di setiap PR lewat `ci-cd.yml`. Ambang tidak boleh dilonggarkan.

| Gate | Berlaku untuk | Syarat lulus |
|---|---|---|
| **Golden plan dokumen lama** | Semua amendemen | Hash plan, ASS, dan `render_key` semua fixture `tests/fixtures/edit_v2/docs/` (§5.11) byte-sama dengan sebelum perubahan |
| **PF-SEG (baru, di `docs/editor/GATES.md`)** | F6 sebelum strip Segmen dibuka | Klip 60 dtk 1080×1920, 8 body semua mundur (urutan terbalik) + 1 cold open, di bawah `prlimit --as=3 GiB`: render selesai tanpa `render_failed`; puncak VmPeak tercatat ≤ 2,6 GiB; waktu ≤ 1,6× klip yang sama dengan 1 body. Kalau gagal: `MAX_BODIES` diturunkan ke nilai terbesar yang lulus (minimal 4), lalu dicatat di GATES.md |
| P-FRAME | F6, F4b | ≥ 2.000 frame untuk urutan mundur dan duplikat; 2 dan 3 range per shot campuran |
| P-TIME | F6 | Vektor timemap baru, JS = Py |
| G-CLICK | F6 | Batas antar-body dengan `cut_fade_ms` tanpa klik |
| P-PLATE | F4a, F4b, F6 | Plate dari sel bersama untuk duplikat; plate per shot |
| S-COLOR | F4b | Saklar mode per shot tanpa pergeseran warna |
| P-ENC | F8 | Fixture skala turun 720p |
| P-TXT / `parity-text.spec.mjs` | F3 dan semua fase UI | Tidak berubah (hanya locale `id`) |
| P-LOGO, P-JOIN, G-WHOOSH, P-AUD | F5 | Tidak berubah |
| PF-PLAY, PF-SEEK | F1, F9 | Tidak memburuk; F9 di satu ponsel kelas menengah |
| PF-OPEN, PF-SAVE | F1, F7 | Tidak memburuk dengan registri turunan |

## 14. Pintasan

- Peta tetap `web/lib/editor/shortcuts.mjs`.
- **Pintasan satu tombol** (tombol karakter, WCAG 2.1.4): `K`, `I`, `O`, `'`, `?`.
  - Semuanya bisa dimatikan lewat saklar "Pintasan satu tombol" di modal Pintasan keyboard.
  - Preferensinya **satu**, dipakai bersama dashboard (X15): cookie per perangkat `potongin_shortcuts` (`on`/`off`, default `on`), dibaca dan ditulis lewat `readShortcutPref`/`writeShortcutPref` di `web/lib/ui-prefs.mjs` (dibuat di Fase 1 dashboard, 05-ui-dashboard.md).
  - Signature baru: `shortcutFor(event, {singleKey = true} = {})` (sekarang `shortcutFor(event)`, `shortcuts.mjs:69`; pemanggil lama tetap valid). Kalau `singleKey === false`, fungsi mengembalikan `null` untuk `?`, `'`, `i`, `o`, dan `k` (cabang `name === "k"` dipisah dari cabang Spasi, jadi Spasi tetap `playPause`). Tombol dan menu yang setara tetap tersedia. `SHORTCUTS` mendapat field `singleKey: true` pada entri `playPause` (hanya kunci `K`), `trimStart`, `trimEnd`, `safeZone`, `help`, supaya modal Pintasan menandai "nonaktif" saat saklar mati.
  - **Render pertama:** halaman editor (`web/app/projects/[id]/clips/[clipId]/edit/page.jsx`, server) membaca cookie lewat `cookies()` + `readShortcutPref`, lalu mengirim prop `singleKeyShortcuts` ke `EditorApp`, jadi tidak ada kedipan default. Saklar di modal memanggil `writeShortcutPref(on)` dan memperbarui state klien; tidak ada muat ulang.
- `Spasi`, panah, `Delete`/`Backspace`, `Enter`, `Home`/`End`, `PageUp`/`PageDown` bukan tombol karakter dan tetap aktif. `Delete`, `Backspace`, dan `Enter` hanya bekerja saat transkrip fokus.

| Aksi | Tombol | Cakupan | Satu tombol? |
|---|---|---|---|
| Putar / jeda | Spasi, K | global | K: ya |
| Frame ‹ › / 1 dtk | ← → / Shift+← → | global | tidak |
| Klip sebelumnya / berikutnya | Ctrl+Shift+← / → | global | tidak |
| Urungkan / Ulangi | Ctrl+Z / Ctrl+Shift+Z, Ctrl+Y | global | tidak |
| Hapus kata | Delete, Backspace | transkrip | tidak |
| Edit kata | Enter | transkrip | tidak |
| Mulai / Akhiri di sini | I / O | global | ya |
| Jadikan cold open | Ctrl+Shift+H | transkrip | tidak |
| Kata kunci | Ctrl+E, Ctrl+klik | transkrip | tidak |
| Sembunyikan dari caption | Ctrl+Shift+X | transkrip | tidak |
| Zona aman | ' | global | ya |
| Frame akhir | Ctrl+Shift+R | global | tidak |
| **Ekspor** | Ctrl+Shift+E (sudah ada di peta dan `aria-keyshortcuts` `TopBar.jsx`) | global | tidak |
| Bantuan pintasan | ? | global | ya |
| Trim di Linimasa | ← → / Shift+← → | pegangan trim | tidak |
| Scrubber | Home/End, PageUp/PageDown | scrubber | tidak |
| Urutkan segmen | ← → saat chip segmen fokus (tombol) | strip Segmen | tidak |
| **Pisah segmen** | **Belum ada** di rilis pertama | — | — |

- Pintasan untuk Pisah baru dipilih setelah uji bentrok di Chrome, Firefox, dan Edge. Ctrl+Shift+S tidak boleh dipakai karena dipakai tangkapan layar Firefox.
- Tidak ada pintasan satu tombol baru.
- **Tes:** `web/tests/editor-shortcuts.test.mjs`. Kasus baru: saklar mati → K/I/O/'/? = `null`; Spasi tetap `playPause`.

## 15. Dialog ekspor: perubahan konfirmasi (amendemen CONTRACTS §3.7)

- **Sekarang** (`ExportDialog.jsx` sekitar :126–140): setiap peringatan punya checkbox "Tandai setiap hal…". Mulai ekspor baru aktif kalau semuanya dicentang.
- **Baru:**
  - **Error blocking:** daftar "Perbaiki dulu" dengan tombol **Perbaiki** per item. Mulai ekspor nonaktif dengan alasan di `aria-describedby`.
  - **Peringatan** (warning §3.7):
    - daftar baris berisi pesan, waktu, **Perbaiki** (tutup modal → buka tab, buka Lanjutan yang tepat, fokus kontrol), dan **Lihat** (tutup modal → seek);
    - tombol utama berubah dari "Mulai ekspor" menjadi **Ekspor tetap**, dan satu klik itu dianggap konfirmasi untuk semua peringatan;
    - `export-flow.mjs`: state `acked: Set` diganti `acknowledged: boolean`, yang di-reset saat daftar peringatan berubah.
  - **Catatan** (info, misalnya `no_face_blur`): ditampilkan sebagai catatan, tidak memerlukan konfirmasi.
- **Teks amendemen §3.7**, kolom Effect untuk warning: "Save allowed; export asks for one acknowledgement (**Ekspor tetap**) for the listed warnings; each row offers Perbaiki and Lihat". Disetujui pemilik (Q1).
- **Ringkasan modal:** resolusi hasil, durasi, audio, perkiraan ukuran berkas, dan Ukuran (Lanjutan).
- **Tes:**
  - `web/tests/editor-export-flow.test.mjs` diperbarui: tanpa centang; Ekspor tetap; reset saat peringatan berubah.
  - `web/e2e/editor-export.spec.mjs` **(baru)**, berisi alur yang sekarang ada di `editor-flow.spec.mjs` bagian ekspor + 720p.

## 16. Bahasa UI (ID dan EN) di editor

- **Provider** (07-i18n.md berlaku): `web/app/projects/[id]/clips/[clipId]/edit/layout.jsx` **(baru)** memasang `IntlProvider` (use-intl) dengan pesan **gabungan** dari `messagesFor(locale, [...])`: inti + `editor` + `errors.edit` + `errors.editor` + `errors.editor_ai` + `hints.edit` + `hints.editor` + `hints.editor_ai`. Katalog = `web/messages/<code>/editor.json`, `errors.json`, `hints.json`, dan `aria.json` (inti) (struktur folder per locale, 07-i18n.md §2.2; daftar namespace segmen editor 07-i18n.md §8.2).
  - `I18nProvider` React Aria hanya dipasang di kit editor (KA7).
- **Namespace** `editor` (sub-objek di `editor.json`): daftar 07-i18n.md (`shell, transcript, text, layout, audio, logo, coldOpen, segments, export, publish, checks, shortcuts, advanced`) **ditambah** `clips` (daftar Klip, gabung) dan `stage` (pratinjau, Lihat sumber). 07-i18n.md §7.1 dan §15 (M8a/M8b) belum memuat keduanya; harus ditambahkan di sana (§20). Catatan: `stage.*` tingkat atas (kode tahap pipeline) berbeda dari `editor.stage.*`.
- **Kunci:** penamaan mengikuti 07-i18n.md §7.2 (camelCase; segmen kode error persis kodenya). Daftar kunci `editor.*` per tab dan `aria.editor.*` ditetapkan di PR M8a/M8b (07-i18n.md §19 butir 8); ringkasan Lanjutan memakai `editor.advanced.summary` + `editor.<tab>.summary.<key>` (§2.2 butir 3).
- **Milestone (07-i18n.md §15):** M8a Editor I (Fase 10, 4 hari: `editor.{shell,transcript,text,layout,audio,logo,coldOpen,advanced}`, `aria.editor.*`, `errors.editor.*`), M8b Editor II (Fase 11, 5 hari: `editor.{segments,export,publish,checks,shortcuts}` + `clips`/`stage`), M9 rilis `en` (Fase 11, 0,5 hari).
- **Teks konten tidak pernah diterjemahkan:** caption, kata transkrip, hook, judul, deskripsi, hashtag, saran LLM, dan bahasa ejaan. Dokumen, ASS, plan, dan `render_key` identik antar-locale (`content-language-isolation`).
- **Format:** angka dan detik (`TranscriptPanel`, `TextPanel`, `CleanupReview`, `transcript/model.mjs`) serta jam (`ExportDialog`) memakai `useFormatter` sesuai locale UI, dengan jam 24 jam (Q8).
- **Label bawaan React Aria/HeroUI** ("Close" dan sejenisnya) ditimpa wrapper dengan kunci `aria.*`.
- **Ratchet:** 0 literal UI di `web/components/editor/**` di akhir Fase 11 (kecuali allowlist `components/editor/__dev__/**`). Guard `@babel/parser` = `web/tests/i18n-hardcoded.test.mjs` dengan baseline `web/tests/i18n-hardcoded.baseline.json` (keduanya milik 07-i18n.md); setiap PR editor menurunkan angka berkas yang disentuh dan memperbarui baseline. Kunci yang dipakai dicek `i18n-usage.test.mjs`.
- **Rilis:**
  - Editor `en` dirilis bersama Fase 11 (Q9 b), lewat i18n M9: `POTONGIN_LOCALES=id,en` di produksi, dan `en-smoke` (buka editor + ekspor) masuk `run_read_only_e2e`.
  - Sebelum itu editor jatuh ke Indonesia.
- `parity-text` dan screenshot editor hanya di `id`. Screenshot `en` 1366×768 ditambahkan sebagai pemeriksaan teks terpotong (label EN lebih panjang): tidak boleh ada `text-overflow` pada label tab dan tombol top bar.

## 17. Migrasi per panel dan fase

**Aturan:**
- Store, commands, history, autosave, rebase, dan player (`web/lib/editor/`) tidak berubah di fase UI murni (F0–F5).
- Shell baru dipasang di balik flag server `POTONGIN_EDITOR_SHELL` (`legacy` | `v2`, default `legacy` sampai fase lulus; sama dengan 08-fase-test-deploy.md). Flag dibaca di `readEditorFlags` (`web/lib/editor/flags.mjs:17`, field baru `shell: "legacy" | "v2"`, nilai lain = `legacy`) dan diteruskan `page.jsx` ke `EditorApp` sebagai prop; tetap di bawah gerbang `POTONGIN_EDITOR_V3`. Flag ini dimasukkan ke `compose.yaml` service `app`, `.env.example`, dan `deploy-env-contract`; tes: kasus baru di `web/tests/editor-store.test.mjs` (yang sekarang menguji `readEditorFlags`).
- Tidak ada pilihan shell di layar (aturan "latest only").
- Shell lama dihapus di F10 (bersih-bersih).
- Setiap fitur backend datang bersama amendemen CONTRACTS dan GATES di PR yang sama, dengan tes ditulis lebih dulu.

| Fase | Isi | Berkas utama | Tes / gate | Hari |
|---|---|---|---|---|
| **F0** kit | Pemilik setujui DESIGN.md §Editor (teks di §18.1). HeroUI v3 + Tailwind v4 tanpa preflight, `@layer` di bawah CSS Modules editor; entri CSS editor sendiri; amandemen `ui-foundation` (X10, tetap tanpa RouterProvider). Port forced-colors (`ui/ui.module.css` garis bawah terpilih). RAC `GridList`/`FileTrigger`. Kit `ui/*` (`PillGroup`, `PillToggle`, `Switch`, `Swatches`, `MenuButton`, `AccordionCard`) dibungkus ulang dengan API props yang sama | `web/components/editor/ui/*`, `web/app/editor.css` **(baru)** | `editor-ui-kit.test.mjs`, `editor-css-collisions.test.mjs`, `focus.spec.mjs`, kontras, forced-colors per komponen | 5 |
| **F1** shell | `EditorShell`, top bar §4, `ClipList`, `PanelTabs` (5 tab; Musik → Audio), `url-state.mjs`, saklar pintasan, hitungan kontrol | §3.5 | `editor-shell`, `editor-views` → diganti `editor-layout-shell.spec.mjs` **(baru)**, `editor-clip-nav`, `read-only`, `editor-first-frame`, `editor-shortcuts`; PF-PLAY/SEEK | 5 |
| **F2** transkrip | Transkrip di tengah, toolbar kata, Kata \| Baris (`LinesView.jsx`), Drawer Rapikan + Ejaan, Linimasa terlipat | `transcript/*`, `spelling/*`, `timeline/*` | `editor-transcript`, `editor-cleanup`, `editor-spelling`, `editor-quick-lines` → `editor-lines.spec.mjs`, `editor-scrubber`, `editor-markers`, `editor-acceptance` | 5 |
| **F3** Teks | Tab Teks menyerap `CaptionCard`, `HookCard`, Lanjutan | `panels/TextPanel.jsx` | `editor-quick` → dilebur, `editor-caption-gizmo`, `editor-apply-all`, `parity-text` | 4 |
| **F4a** Tata letak | Tab + Lihat sumber; `FramingDialog`/`SplitDialog` dihapus | `panels/LayoutPanel.jsx`, `stage-view.mjs` | `editor-framing`, `editor-split`, `editor-layout`, `editor-zoom`, P-PLATE | 4 |
| **F5** Audio, Logo, Cold open | `AudioPanel.jsx` (ganti nama dari `MusicPanel.jsx`), `LogoPanel`, `ColdOpenPanel`, Lanjutan | `panels/*` | `editor-music`, `editor-logo`, `editor-nudge`, `editor-transition`, P-LOGO, P-JOIN, G-WHOOSH, P-AUD | 4 |
| i18n M8a (07 §15) | Provider editor, `aria.editor.*`, kunci `editor.*` untuk area F1–F5, `errors.editor.*` | `web/messages/{id,en}/{editor,errors,hints,aria}.json`, `web/app/projects/[id]/clips/[clipId]/edit/layout.jsx` **(baru)** | `i18n-error-codes`, ratchet per area | ≈ 4 |
| **F4b** per shot | Strip shot, `ShotPopover`, `SetShotMode`/`ResetShot`/`ResetAllShots` | `web/components/editor/panels/ShotStrip.jsx` **(baru)**, `web/components/editor/panels/ShotPopover.jsx` **(baru)**, `web/lib/editor/shots.mjs` (**(baru)**, data milik 04 F4b) | P-FRAME, P-PLATE, S-COLOR full, uji apply-all dan analisis ulang | ≈ 15 |
| **F6** segmen | §11.2–§11.4, strip Segmen | `doc.py`, `doc-model.mjs`, `commands.mjs`, `rebase.mjs`, `SegmentStrip.jsx` | golden timemap, P-FRAME, P-TIME, G-CLICK, **PF-SEG**, `editor-segments.spec.mjs` **(baru)** | 12 |
| **F7** turunan | §11.6 | `api.py`, `clip_id.py`, `seed.py`, `derived-clips.mjs`, `jobs.mjs`, konsumen daftar klip | `tests/test_edit_v2_derived.py` **(baru)**, `list-job-clips-parity.test.mjs`, `editor-merge.spec.mjs` **(baru)**, proyek/Riwayat/ZIP | 12 |
| **F8** ekspor + terbit | 720p, Ekspor semua, `⇣n` (5); Terbitkan (3, setelah Fase 8 sosmed) | §11.7, §11.8, §11.10, §15 | `editor-export-flow.test.mjs`, P-ENC, `editor-export.spec.mjs`, `editor-publish.spec.mjs` **(baru)** | 8 |
| **F9** tablet + ponsel | §3.1 | `EditorShell`, CSS | e2e 768/375, antislop layoutmobile | 8 |
| **F10** bersih-bersih | Hapus `quick/`, `rail/`, `ViewSwitch.jsx`, `view-mode.mjs`, `FramingDialog.jsx`, `SplitDialog.jsx`, metadata `wave`/`owner`; flag `POTONGIN_EDITOR_SHELL` dihapus; PANDUAN-EDITOR; stopwatch U1–U10 | — | Semua e2e editor, `run_all.sh full` | 4 |
| i18n M8b + M9 (07 §15) | Kunci F4b–F9 (5), rilis `en` (0,5) | — | ratchet 0, `en-smoke` | ≈ 5,5 |

- Fase 10 = F0–F5 + M8a (≈ 31). Fase 11 = sisanya (≈ 64,5). Angka hari-dev, dependensi, kriteria terima, dan rollback per fase milik 08-fase-test-deploy.md §4 (Fase 10, Fase 11); tabel ini hanya merinci isi per sub-fase editor.
- F3, F4a, dan F5 bisa paralel setelah F1. F4b → F6 → F7 berurutan (semuanya menyentuh `doc.py` dan kompiler).

## 18. Perubahan dokumen dan tes

### 18.1 Dokumen

- **`DESIGN.md` §Pola tata letak, butir Editor:** diganti dengan teks berikut. "**Editor:** satu tata letak. Daftar klip di kiri, pratinjau dan transkrip di tengah, satu panel alat di kanan (Teks, Tata letak, Audio, Logo, Cold open). Pilihan dasar terlihat, kontrol halus di lipatan Lanjutan dengan ringkasan pilihannya. Linimasa detail terlipat di bawah."
- **`AGENTS.md`:**
  - aturan clean-room;
  - aturan copy dari katalog `web/messages/<locale>/<namespace>.json` dengan entri di setiap locale;
  - "UI copy is Indonesian" diamandemen sesuai 07-i18n.md §17 (teks amandemen milik dokumen itu).
- **`docs/HANDOFF.md`:** baris "Mode Cepat bawaan" dihapus.
- **`docs/editor/CONTRACTS.md`:**
  - §3.7 (§15);
  - §3.8 (empat amendemen §11.1);
  - §5.66–§5.69 baru;
  - §5.27 diberi tanda "tampilan digantikan oleh §5.69; kunci baris caption tetap berlaku".
- **`docs/editor/GATES.md`:** PF-SEG, P-ENC skala turun, G-FAIL ("kode tetap + pesan Indonesia + entri di setiap locale").
- **`docs/editor/PANDUAN-EDITOR.md` dan `docs/editor/UJI-PENERIMAAN.md`:** U9 (gabung) dan U10 (ekspor semua) ditambahkan.

### 18.2 Tes unit (web/tests)

- **Dihapus/diganti:** `editor-view-mode.test.mjs`, `editor-mode-cepat-scaffold.test.mjs`, `editor-quick-model.test.mjs` (dilebur ke tes panel).
- **Diubah:** `editor-shell-model.test.mjs` (Perlu dicek/Catatan kondisional), `editor-shortcuts.test.mjs`, `editor-export-flow.test.mjs`, `editor-commands.test.mjs`, `editor-history.test.mjs`, `editor-rebase.test.mjs`, `editor-timemap.test.mjs`, `editor-caption-lines.test.mjs` (`seg`), `editor-player-plate.test.mjs`, `editor-player-presenter.test.mjs`, `editor-ui-kit.test.mjs`, `editor-css-collisions.test.mjs`, `apply-all-api.test.mjs`.
- **Baru:**
  - `editor-disclosure.test.mjs` (`advancedSummary` per kelompok: ≤ 3 item, hanya nilai yang beda dari seed, `items` kosong untuk seed);
  - `editor-url-state.test.mjs` (tabel §3.6);
  - `editor-stage-view.test.mjs` (mesin keadaan §5.2);
  - `editor-segments.test.mjs`;
  - `editor-shots.test.mjs` (dibuat 04 F4b data; editor menambah kasus `ShotStrip`/popover model);
  - `derived-clips-route.test.mjs` (body, idempotensi, kode error, 404 identik);
  - `renders-batch-route.test.mjs`;
  - `renders-list-route.test.mjs` (§11.8a).
- **Diperluas (berkas milik dokumen lain):** `list-job-clips-parity.test.mjs` (03, fixture turunan), `editor-store.test.mjs` (`readEditorFlags.shell`), `ui-prefs.test.mjs` (05, dipakai editor).

### 18.3 Tes Python (tests/)

- **Diubah:**
  - `test_edit_v2_doc.py` (§11.3);
  - `test_edit_v2_compile.py` (N body, golden 1 body, skala 720p);
  - `test_edit_v2_timemap.py`;
  - `test_edit_v2_captions.py` (cue tidak melintasi segmen, duplikat);
  - `test_edit_v2_plates.py`;
  - `test_edit_v2_api.py` (op baru di `OPS`/`_FIELDS`);
  - `test_edit_v2_apply_all.py` (ranges tidak disalin);
  - `test_edit_v2_janitor.py` (turunan terhapus > 30 hari);
  - `test_edit_v2_clip_id.py` (`derived_clip_id`, domain berbeda);
  - `test_edit_v2_verify.py` (ukuran diminta);
  - `test_render_queue.py` (`size`, R10 hanya `output`, `size_unsupported`).
- **Baru:** `test_edit_v2_derived.py` (registri, flock, jendela, `merge_too_far`, pemetaan `word_edits`, `dropped_edits`, soft delete, `_clips`).

### 18.4 E2E (web/e2e)

- **Selector tab:**
  - 66 pemanggilan `getByRole("tab")` di 19 spec.
  - Hanya "Musik" → "Audio" yang berganti nama, dan tab "Transkrip" hilang (transkrip selalu tampil).
  - Helper `openPanel(page, id)` di `web/e2e/support/editor-panels.mjs` **(baru)** dipakai di semua spec. `web/e2e/support/editor-cards.mjs` (helper kartu Mode Cepat) dihapus di F10 setelah spec terakhir pindah.
- **Ditulis ulang:** `editor-views.spec.mjs` → `editor-layout-shell.spec.mjs`; `editor-lengkap.spec.mjs` → dilebur; `editor-quick.spec.mjs` dan `editor-quick-lines.spec.mjs` → dilebur ke spec per tab dan `editor-lines.spec.mjs`.
- **Baru:**
  - `editor-segments.spec.mjs` (pisah, duplikat, urutkan dengan keyboard dan seret, hapus, batas 8);
  - `editor-merge.spec.mjs` (gabung, buka, hapus, tampil di proyek/Riwayat/ZIP);
  - `editor-shots.spec.mjs`;
  - `editor-export.spec.mjs` (Ekspor tetap, 720p, Ekspor semua);
  - `editor-publish.spec.mjs` (Ekspor lalu terbitkan, dengan provider palsu);
  - `editor-disclosure.spec.mjs` (Lanjutan tertutup secara default, ringkasan berubah setelah edit, Perbaiki membuka Lanjutan yang tepat dan memfokuskan kontrol);
  - `editor-control-count.spec.mjs` (snapshot jumlah kontrol per tab saat dibuka pertama vs baseline `docs/editor/evidence/control-count.json`; gagal kalau naik tanpa baseline diperbarui; juga memastikan tepat satu `tabpanel` terlihat);
  - `editor-click-budget.spec.mjs` (§2.3).
- **Screenshot:** 1366×768 dan 1920×1080 (`editor-screens.spec.mjs`), ditambah 768 dan 375 di F9.

## 19. Kriteria penerimaan

1. Tidak ada pemilih Cepat/Lengkap. `?mode=`/`?card=` dialihkan sesuai §3.6, dan tidak ada error konsol.
2. Saat editor dibuka: satu panel kanan (Teks) terbuka, semua Lanjutan tertutup, Linimasa terlipat. Pada 1366×768 tidak ada scroll halaman.
3. Setiap fitur di §10 bisa dijangkau dengan jumlah klik ≤ angka di tabel (diuji `editor-click-budget.spec.mjs`); jumlah kontrol per tab tidak naik dari baseline F1 (`editor-control-count.spec.mjs`).
4. Setiap Lanjutan menampilkan ringkasan yang berubah setelah nilai diubah.
5. Dokumen lama: plan, ASS, dan `render_key` byte-sama (golden).
6. Segmen: 8 body mundur dan duplikat lolos PF-SEG, P-FRAME ≥ 2.000 frame, dan G-CLICK. Server lama menolak dokumen multi-body dengan `op_disabled`/`range_invalid`.
7. Klip turunan muncul di editor, proyek, Riwayat, ZIP, dan posting, tetapi tidak di profil performa. `listJobClips` = `_clips` (tes paritas).
8. Ekspor 720p hanya untuk dokumen 1080, lolos P-ENC dan `verify.py`. R10 tidak dipakai untuk 720p.
9. Terbitkan hanya memakai `renderId` yang `completed` dan terverifikasi.
10. Saklar pintasan satu tombol mematikan K/I/O/'/? di editor dan dashboard sekaligus.
11. `en`: ratchet 0 di `components/editor/**`, `en-smoke` hijau, pemilik menyetujui copy. `parity-text` dan screenshot `id` tidak berubah.
12. Stopwatch: U1–U8 tidak lebih lambat dari angka shell lama di `UJI-PENERIMAAN.md`; U9 ≤ 30 dtk, U10 ≤ 15 dtk sampai antre.

## 20. Risiko dan celah yang belum tertutup

| Risiko | Mitigasi |
|---|---|
| Banyak decoder run melewati 3 GiB | PF-SEG sebelum UI segmen dibuka; `MAX_BODIES` mengikuti hasil ukur |
| Saklar mode per shot salah piksel | 3 mode, pola §5.40; P-FRAME/P-PLATE per kombinasi |
| Focus/forced-colors HeroUI belum terbukti di editor | Audit per komponen di F0; gizmo, transkrip, lane, dan scrubber tetap CSS Modules |
| Klip turunan tidak muncul di salah satu halaman | Satu fungsi daftar per bahasa + tes paritas + e2e |
| Pengguna tidak menemukan kontrol di Lanjutan | Ringkasan di judul; Perbaiki membuka Lanjutan yang tepat; stopwatch |
| Override shot hilang saat analisis ulang | `origin:user` dilindungi dan diuji |

**Celah yang masih terbuka (diputuskan saat implementasi, bukan oleh pemilik):**
1. Tombol pintasan untuk **Pisah** belum dipilih; menunggu uji bentrok di Chrome, Firefox, dan Edge (§14).
2. Ambang PF-SEG (2,6 GiB, 1,6×) adalah usulan awal dan dikunci setelah pengukuran CI pertama di Fase 11 F6 (sama dengan 08-fase-test-deploy.md §11 butir 4). Setelah dikunci tidak boleh dilonggarkan.
3. Pelonggaran V8 (`layout.keyframes` + `ranges`) untuk range `camera`: default 04-reframe-unduhan.md §A6 = tetap dilarang di v1 (pelonggaran butuh amandemen §5.63 sendiri). Selama itu, "Lihat sumber" disembunyikan saat `ranges` ada (§5.2).
4. Nama sub-komponen HeroUI v3 (`Disclosure.*`, `Tabs.*`, `Dropdown.*`, `Toast.Provider`) diverifikasi ulang terhadap `@heroui/react@3.2.6` yang terpasang di F0. Komponen tingkat atas sudah dicek di katalog HeroUI v3; `GridList` dan `FileTrigger` dipakai dari RAC.
5. Kehadiran (§11.9) hanya berguna lintas pengguna kalau ada berbagi proyek; 02-multiuser-keamanan.md tidak punya fitur itu, jadi sekarang `others` = sesi lain milik pengguna yang sama.

**Penyelarasan dokumen pemilik:** selesai pada pemeriksaan silang akhir 2026-10-24 ([00-README.md](00-README.md) §8): 03 §13.2/§6.6 memakai `listJobClips().derived` dan `cancelRunsForClip`; `onRequestExport` tercatat di 05 §6.5 dan 03 §6.7; body terbit = `media:{kind:"export", renderId}` (03 §9.1); route editor ada di 02 §8.2; 04 §A8.3 memakai `editor.layout.summary.shotsChanged`; 07 §7.1/§7.2 memuat `editor.clips`, `editor.stage`, contoh `editor.advanced.summary`; 08 Fase 11 F7 memakai `clip_kind='derived'`.
