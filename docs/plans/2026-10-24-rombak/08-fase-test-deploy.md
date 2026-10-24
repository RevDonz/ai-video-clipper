# 08 · Fase, test & deploy

- **Status:** Rancangan — belum diimplementasi
- **Tanggal:** 2026-10-24
- **Indeks:** [00-README.md](00-README.md) · [01-arsitektur-data.md](01-arsitektur-data.md) · [02-multiuser-keamanan.md](02-multiuser-keamanan.md) · [03-sosmed-performa.md](03-sosmed-performa.md) · [04-reframe-unduhan.md](04-reframe-unduhan.md) · [05-ui-dashboard.md](05-ui-dashboard.md) · [06-editor.md](06-editor.md) · [07-i18n.md](07-i18n.md) · **08 (dokumen ini)**
- **Sumber:** roadmap induk (Koreksi akhir KA1–KA26 berlaku di atas semua sumber), roadmap fitur 01 + review #1–#16, dashboard 02 (K1–K31), editor 03 (#1–#24), i18n 04 (K1–K23).
- **Lingkup dokumen:** urutan fase G0 dan Fase 0–12, kriteria terima per fase, estimasi, critical path, tenggat keputusan, strategi gate dan tes, perubahan deploy, risiko, dan keputusan pemilik (final).
- **Kepemilikan detail (dokumen pemilik menang bila berbeda; di sini hanya dirujuk):** DDL, nomor migrasi `0001`–`0007`, volume `/control`, field `job.json` (`ownerId`, `fairnessKey`), backup/restore, boot `start-app.mjs`, Node 24 → **01**; auth/sesi/peran, API identitas & admin, matriks route, `secureRoute`, hardening input, drain/pause admission, rahasia per user → **02**; API sosmed & analitik, state `publish_runs`, `social-worker`, profil performa → **03**; skema `layout.ranges` (§5.63), shot plan, command per shot, fetch/cache/kode error sumber → **04**; layar, nav, fondasi UI, cookie preferensi UI, kata status → **05**; UX editor, amendemen `edit_v2`, klip turunan, CONTRACTS §5.66–§5.69 → **06**; katalog `web/messages/<locale>/<namespace>.json`, kontrak `/api/locale`, penamaan kunci, peta kode error → pesan, locale/zona → **07**. Dokumen ini memiliki: urutan fase, estimasi, gate, dan perubahan skrip deploy.
- Path relatif terhadap root repo `ai-video-clipper/`. File bertanda **(baru)** belum ada di repo hari ini; semua path lain sudah dicek ada.
- Clean-room: tidak ada kode, markup, string, konstanta, atau nama modul SupoClip. Repo SupoClip hanya dibaca untuk perilaku (09 §1). Setiap PR menulis baris `Rujukan: rencana 2026-10-24-rombak + kode Potongin` (dan catatan perilaku SupoClip bila dipakai) di deskripsinya.

---

## 1. Keputusan pemilik (FINAL)

Jawaban yang ditandai **(default, bisa diubah)** diadopsi dari rekomendasi roadmap induk. Pemilik boleh menggantinya paling lambat di kolom "Tenggat"; setelah tenggat lewat, perubahan dianggap perubahan lingkup dan diestimasi ulang.

| # | Pertanyaan | Jawaban | Status | Tenggat terakhir untuk mengubah |
|---|---|---|---|---|
| Q1 | Amandemen DESIGN.md/AGENTS.md; label "Riwayat"→"Proyek", "Konteks Tren"→"Tren", "Menunggu"→"Antre"; `?klip=N` sebagai dialog; editor tanpa Mode Cepat/Lengkap; satu "Ekspor tetap" (amandemen CONTRACTS §3.7); istilah publikasi | **Disetujui semua.** Istilah publikasi: **Terbitkan** (aksi) / **Terbit** (status). Lihat klarifikasi editor di bawah tabel. | Final | — |
| Q2 | Dependensi | **Disetujui:** Node 24 + `node:sqlite`; `@heroui/react@3.2.6` + Tailwind v4; `use-intl@4.14.9` (pin persis); `@babel/parser` (devDependency, untuk `i18n-hardcoded`). | Final | — |
| Q3 | Akses | Admin tidak membuka proyek orang lain (hanya transfer/hapus yang diaudit); pendaftaran hanya lewat undangan; `APP_USERNAME/APP_PASSWORD` tetap sebagai login darurat (break-glass); user smoke `E2E_SMOKE_*`; tanpa SMTP, tautan undangan/reset disalin manual. **(default, bisa diubah)** | Default | Sebelum Fase 4 |
| Q4 | Berbagi sumber daya | Diatur admin per anggota; rantai LLM gratis dibagi dengan cap 200 unit/hari per anggota (`llm_share`, `llm_daily_cap`, dok 02 §3.3); key LLM dari env tidak pernah dibagi; cookie YouTube global milik admin; tren instans-wide + switch per anggota; cache video publik + transkrip lintas user ya, hanya untuk unduhan tanpa cookie. **(default, bisa diubah)** | Default | Sebelum Fase 5 |
| Q5 | Kapasitas | `PRIMARY_WORKER_CONCURRENCY=1` sampai diukur; per anggota maks 3 job aktif, 1 job berjalan, 30 job/jam (`instance_settings.member_*`, dok 02 §3.3; admin tidak kena batas per user); durasi sumber maks 4 jam (`POTONGIN_MAX_SOURCE_SECONDS=14400`); kuota storage per anggota **kosong = tidak dibatasi** (`member_storage_quota_bytes = null`) sampai admin mengisinya setelah jumlah pengguna diketahui. **(default, bisa diubah)** | Default | Sebelum Fase 6 |
| Q6 | Paket penghapusan otomatis di luar `/data/jobs` (audit > 180 hari, sesi/undangan/reset kedaluwarsa, backup DB > 14, cache unduhan 4 GiB/3 hari, pin sosmed 1 jam/7 hari, aturan 30 hari YouTube) | Disetujui sebagai satu paket. **(default, bisa diubah)** | Default | Sebelum Fase 4 |
| Q7 | Sosmed | App milik pemilik (satu per platform); verifikasi/audit dijalani; mulai YouTube; mode `admin` sampai audit lolos; TikTok `FILE_UPLOAD`; batch belakangan; cap per user 100 terjadwal + 20/jam; kuota YouTube = jatah harian per user; hapus job membatalkan jadwal; file default = ekspor terbaru yang `completed`, dengan pilihan di drawer; social-worker container sendiri (0,5 CPU). Penulis `/privasi`/`/ketentuan`: implementer menulis draf, pemilik menyetujui. **(default, bisa diubah)** | Default | Sebelum Fase 8; pendaftaran app mulai G0 |
| Q8 | Waktu | Format jam **24 jam di semua locale** (`Intl` `hourCycle: "h23"`; DatePicker/TimeField RA `hourCycle={24}`); zona = zona perangkat (dikirim sekali, disimpan di `users.time_zone`), nama zona pendek selalu ditampilkan; fallback `Asia/Jakarta`. **(default, bisa diubah)** | Default | Format jam: G0; zona: sebelum Fase 8 |
| Q9 | Bahasa | Pemilik fleksibel soal kapan, asal akhirnya ada ID **dan** EN → **opsi (b): `en` dirilis bersama fase editor (Fase 11, i18n M9).** Pratinjau `POTONGIN_LOCALES=id,en` boleh di produksi hanya sebelum ada anggota; dikembalikan ke `id` di checklist undangan pertama (Fase 6). Copy `en`: implementer menulis draf dari katalog `web/messages/id/` + glosarium, pemilik mereview per fase. Bahasa awal pengguna baru: Accept-Language. Undangan: bahasa pilihan admin (default bahasa admin). Default "Bahasa video" tidak berubah untuk UI `en`. `/privasi`, `/ketentuan`, landing `/`: ada versi `en`. **(waktu rilis: final; detail lain: default, bisa diubah)** | Final (b) | Detail: akhir Fase 3 |
| Q10 | Otomatis | Opt-in sampai PF-PIPELINE diukur; override per shot 3 mode (`camera`/`fill_center`/`fit_blur`), `split` hanya `origin:auto` atau seluruh klip; "Pakai di semua klip" mengantrekan analisis; pemilik melabeli 20 jendela test split dan menilai 10 klip split. **(default, bisa diubah)** | Default | Sebelum Fase 5 (skema dikunci di Fase 0) |
| Q11 | Unduhan & performa | Range-only dilewati; tanpa proxy berbayar; bgutil opt-in; Kick eksperimen mati; metrik = views 7 hari; ambang awal (20 posting/14 hari, n ≥ 5 per grup, cap +0,2, gabungan 0,4); toggle mati sampai retro dibaca; klip yang diedit > 20% dikeluarkan dari profil; data performa privat per user; "tidak ada efek" diterima, FB-M7 tetap opsional. **(default, bisa diubah)** | Default | Unduhan: sebelum Fase 7; performa: sebelum Fase 9 |
| Q12 | Editor | Gabung klip hanya dalam job yang sama dan rentang sumber ≤ 20 menit; kehadiran + rebase per bagian tanpa kunci per klip; efek warna ditunda ke Fase 12. **(default, bisa diubah)** | Default | Sebelum Fase 10 |

### 1.1 Klarifikasi Q1 untuk pemilik: "tanpa mode" ≠ "semua alat tampil sekaligus"

Menghapus Mode Cepat/Lengkap berarti editor hanya punya **satu layout**, bukan layar penuh kontrol. Aturan yang dikunci sebagai kriteria terima Fase 10–11 (rinci: `06-editor.md` §2, empat tingkat T0–T3):

1. **Pratinjau dulu (T0, selalu terlihat):** top bar, pratinjau + transport, strip Segmen, transkrip, daftar Klip. Tidak ada rel alat kiri (`components/editor/rail/` dihapus di F10). "Linimasa detail" terlipat default, dibuka dengan tombolnya sendiri (T3).
2. **Satu panel kanan terbuka sekaligus (T1).** Tab: **Teks · Tata letak · Audio · Logo · Cold open**. Teks terbuka saat editor dibuka. Membuka tab lain menutup yang sebelumnya; klik tab yang sedang aktif **tidak** menutup panel.
3. **Pilihan dasar terlihat, kontrol halus terlipat (T2).** Di setiap tab, pilihan dasar (paket caption, mode tata letak, tambah/hapus musik, tambah/hapus logo, cold open on/off) tampil; kontrol halus ada di `Disclosure` **Lanjutan** yang default tertutup, dengan ringkasan ≤ 3 nilai di judulnya dari `advancedSummary(group, doc)` (`web/lib/editor/disclosure.mjs` **(baru)**), contoh `Lanjutan · Pop · 2 kata`. Tombol **Perbaiki** di daftar cek membuka tab + Lanjutan yang tepat dan memfokuskan kontrolnya.
4. **Tugas umum ≤ 3 klik, lanjutan ≤ 5** (aturan dan daftar tertutup tugas lanjutan: `06-editor.md` §2.3; per fitur: tabel `06-editor.md` §10; Terbitkan dikecualikan karena multi-field).
5. Tes yang mengunci (rinci `06-editor.md` §2.3, §18.4): snapshot hitungan kontrol per tab di `docs/editor/evidence/control-count.json` **(baru)** (Fase 10 F1) dijaga `editor-control-count.spec.mjs` **(baru)**; `editor-click-budget.spec.mjs` **(baru)** untuk setiap baris §10; `editor-layout-shell.spec.mjs` **(baru)** memastikan tepat satu `tabpanel` terlihat; `editor-disclosure.spec.mjs` **(baru)** memastikan Lanjutan tertutup default dan ringkasan berubah setelah edit; stopwatch (`06-editor.md` §12, §19 butir 12): U1–U8 tidak lebih lambat dari baseline shell lama di `docs/editor/UJI-PENERIMAAN.md`, U9 ≤ 30 dtk, U10 ≤ 15 dtk sampai antre (Fase 11 F10).

### 1.2 Yang tetap butuh tindakan pemilik di G0 walau Q1/Q2/Q9 final

- ~~Merge PR `feat/ux-redesign-workspace` ke `main`~~: selesai lewat #30.
- Menyetujui **teks** amandemen (PR docs-only, §4 G0) — persetujuan arah sudah ada, teks finalnya tetap direview.
- Mendaftarkan app Google, TikTok, Meta dalam mode testing (kalender 2–6+ minggu).

---

## 2. Aturan lintas fase

1. **Satu milestone = satu PR**, di-rebase ke `main`, tes ditulis lebih dulu. Ambang tidak pernah dilemahkan (AGENTS.md).
2. **Di PC pemilik hanya tes yang ditargetkan:** `node --test web/tests/<file>`, `uv run pytest tests/<file>`. Suite penuh, image, FFmpeg/parity, Playwright di GitHub Actions:
   - `ci-cd.yml` di setiap PR (termasuk `scripts/parity/run_all.sh smoke`).
   - `gh workflow run editor-gates.yml -f ref=<branch> -f suite=full|image|command|e2e|player` untuk PR yang menyentuh CSS, UI, render, Python engine, atau deploy.
   - `run_all.sh toolchain` wajib untuk perubahan toolchain (Node 24, pin JASSUB): `gh workflow run ci-cd.yml --ref <branch> -f suite=toolchain`, lalu commit `docs/editor/evidence/toolchain/record.json` dari artifact run itu.
3. **gitleaks** dengan config `main` sebelum setiap push.
4. **Migrasi hanya aditif.** Kolom/tabel baru, field JSON baru opsional. "Contract" (menghapus) hanya di rilis terpisah dan dicatat di matriks rollback. Penomoran (`0001`–`0007`, urut merge), lint aditif, dan DDL: `01-arsitektur-data.md` §3–§4; dokumen lain tidak menulis DDL sendiri.
5. **Expand lalu enable.** Fitur besar masuk di balik flag env default mati (§9.8), dinyalakan di rilis berikutnya.
6. **Copy:** ditulis di katalog `web/messages/id/<namespace>.json` (sumber); `web/messages/en/` memuat set file yang sama dan jatuh ke `id` lewat deep-merge (`07-i18n.md` §2.2, §7.4); kunci `namespace.area.item` (§7.2); label, bukan kalimat; kunci yang hilang = tes gagal (sejak Fase 1).
7. **Satu pemilik per file per fase** untuk hotspot: `web/proxy.js`, `web/lib/jobs.mjs`, `web/lib/primary-job-queue.mjs`, `web/scripts/run-job.mjs`, `src/ai_clipper/pipeline.py`, `web/lib/app-nav.mjs`, `web/app/settings/page.jsx`, `compose.yaml`, `deploy/production.sh`.
8. **Checklist PR (template):** milestone id; flag yang dipakai; migrasi (aditif? id); tes baru; workflow CI yang dijalankan + link run; baris matriks rollback yang terdampak; baris "Rujukan" clean-room; "sumber copy en: katalog `id` + glosarium" kalau PR menyentuh `web/messages/en/`.

---

## 3. Peta dependensi

```
G0 ──► F0 ──► F1 ──► F2 ──► F3 ─────────────────────────────┐
        │      │                                             │
        │      └──► F4 ──► F5 ──► F6 ──► F7 ──► F8 ──► F9    │
        │                  ‖RF-M1/M2 ‖RF-M3/M4  ‖RF-M5a/M6   │
        │                            ‖SOS-M1                 │
        │                                                    ▼
        └── (kalender platform mulai G0) ──► F8 ──► F12(SOS-M7)
                                         F1 + F7(RF-M5a) ──► F10 ──► F11 (+F8 untuk Terbit)
```

- Fase 4 butuh Fase 3 (UI Pengaturan/login sudah baru) — boleh dipercepat paralel dengan Fase 2–3 bila ada dua agen, dengan aturan satu pemilik per file (§6).
- Fase 10 butuh Fase 1 (fondasi CSS/i18n) dan RF-M5a (Fase 7). Fase 11 F8 bagian Terbit butuh Fase 8 (`PublishDrawer`).
- **Undangan anggota pertama dilarang** sebelum MU-M4b (Fase 6 langkah 1) hijau.

---

## 4. Fase terpadu

Format setiap fase: **Isi** (milestone id, hari-dev, file utama) → **Dependensi** → **Kriteria terima** (semua wajib) → **Tes** → **Pengguna merasakan** → **Rollback**. "‖" = jalur paralel (Python/worker) yang bisa dikerjakan agen lain. Angka hari-dev = satu developer.

### G0 · Gerbang (0 hari-dev, kerja pemilik)

**Isi**
- PR `feat/ux-redesign-workspace` di-merge ke `main` (selesai, #30).
- PR docs-only "amandemen G0" (ditulis implementer, disetujui pemilik), mengubah:
  - `DESIGN.md`: kepala halaman = judul + aksi tanpa kalimat; sidebar datar dengan item per peran/flag; Buat klip = chip bernilai (menggantikan tiga lipatan); HeroUI v3 di atas token Potongin; dua set kata status (proses, postingan); keadaan terpilih tanpa lime; bagian **Bahasa** (pemilih, slug netral, glosarium); **§Editor** = satu layout, pratinjau dulu, satu panel kanan, Lanjutan terlipat (§1.1), Mode Cepat/Lengkap dihapus (teks persis: `06-editor.md` §18.1; dashboard: `05-ui-dashboard.md` §9.1); label Proyek/Tren/Antre; istilah Terbitkan/Terbit.
  - `AGENTS.md`: baris "UI copy is Indonesian" → copy dari katalog `web/messages/id/` (sumber) dan diterjemahkan ke setiap locale di registry, label pendek di semua bahasa, bahasa konten mengikuti `videoLanguage` (teks amandemen: `07-i18n.md` §17); protokol clean-room (SupoClip boleh dibaca untuk perilaku, dilarang menyalin kode/string/markup/nama; katalog `en` dari katalog `id` + glosarium); migrasi hanya aditif; guard auth wajib sinkron.
  - `docs/glosarium.md` **(baru)**: istilah tetap ID↔EN (Hook, Cold open, Logo, Audio, Klip, Proyek, Tren, Terbitkan/Publish, Antre/Queued, Tata letak/Layout, Otomatis/Auto, Ikuti wajah/Follow face, Potong tengah/Center crop, Latar blur/Blur background, Layar terbagi/Split screen).
- Pemilik mulai pendaftaran app Google, TikTok, Meta (mode testing).

**Kriteria terima**
- [x] PR UX ada di `main` (#30).
- [ ] PR amandemen G0 di-merge dengan approval pemilik.
- [ ] Q1, Q2, Q9 tercatat final (§1); Q8 format jam tercatat (default 24 jam).
- [ ] Tiket pendaftaran app ketiga platform sudah dibuat (tanggal dicatat di `docs/operations/SOSMED.md` saat Fase 0).

**Pengguna merasakan:** tidak ada. **Rollback:** revert PR docs.

### Fase 0 · Runtime, kontrak, pengukuran (15,5)

**Isi**
| Milestone | Hari | Isi | File |
|---|---|---|---|
| MU-M0 Node 24 | 2,5 | Rinci `01-arsitektur-data.md` §8: digest `NODE_IMAGE` `node:24-bookworm-slim@sha256:…` di `Dockerfile:9`; `node-version: "24"` di tiga workflow; `engines` di `web/package.json`; bukti toolchain baru: `gh workflow run ci-cd.yml --ref <branch> -f suite=toolchain`, lalu isi artifact `toolchain-evidence` disalin ke `docs/editor/evidence/toolchain/` dan `record.json` yang tercap di-commit di PR yang sama (`docs/editor/OPERASIONAL.md` §3); tanpa itu job `toolchain-guard` di `ci-cd.yml` gagal pada pin Node 24; aturan stderr `node:sqlite` (01 §8.3: modul yang stderr-nya di-parse tidak mengimpor `web/lib/db/*`; bila peringatan muncul, `NODE_OPTIONS=--disable-warning=ExperimentalWarning` hanya di app/primary/social dan dibuang dari env anak). | `Dockerfile`, `web/package.json`, `.github/workflows/{ci-cd,editor-gates,ytdlp-update}.yml`, `scripts/parity/toolchain_guard.py`, `docs/editor/evidence/toolchain/record.json` |
| FB-M0 | 2 | `rules.v1.json` dibekukan (bucket, hookForm, `LIFT_FULL=0.25`, cap); kontrak snapshot v1; kontrak registry posting; minta contoh CSV ke pemilik. | `resources/performance/rules.v1.json` (baru) |
| SOS-M0 | 3 | Batas platform + kewajiban retensi dengan sumber resmi; `FILE_UPLOAD` TikTok jalur utama; checklist verifikasi domain; pembolehan agregat 30 hari YouTube; cek resumable upload Instagram. | `docs/operations/SOSMED.md` (baru) |
| FETCH-M0 | 3 | Ukur di CI (`editor-gates.yml suite=command`): audio asli vs `ba` (Opus/AAC), waktu sampai seleksi, bgutil ±proxy, proxy lewat config tidak muncul di `/proc/*/cmdline`, Kick ±curl_cffi, data range-only. Go/no-go tertulis. | `docs/evaluation/UNDUHAN_M0.md` (baru) |
| RF-M0 | 4 | Harness eval reframe; ±40 jendela berlisensi terbuka di registry; label cut pada grid doc; gate ditulis **sebelum** test split dijalankan. | `scripts/eval/auto_reframe.py` (baru), `docs/evaluation/AUTO_REFRAME.md` (baru), `docs/evaluation/TRAINING_SOURCE_REGISTRY.json` |
| PR kontrak | 1 | Alokasi CONTRACTS §5.59 multi-user (termasuk `job.json` `ownerId` + `fairnessKey`, penyimpangan dok 01 §6.2), §5.60 posting, §5.61 registry+snapshot, §5.62 performa (DDL tetap di dok 01 §4.3/§4.5/§4.7), §5.63 reframe/shot-plan **termasuk skema `layout.ranges`**, §5.64 sumber link + cache, §5.65 i18n; nama clean-room (`social_connections`, `publish_runs`, `oauth_pending`, `readPostStats`, `/data/cache-unduhan`). §5.66–§5.69 (editor) dialokasikan terpisah di PR kontrak Fase 10 (`06-editor.md` §11.1). | `docs/editor/CONTRACTS.md` |

Skema `layout.ranges` yang dikunci di §5.63 (KA6) **dimiliki `04-reframe-unduhan.md` §A6** (tabel path, validator V1–V9, kanonisasi, `merge_user_ranges`, apply-all) dan tidak didefinisikan ulang di sini. Ringkasnya: `layout.default.mode` mendapat nilai `auto`; `layout.ranges` = 1–200 `{in_sf, out_sf, mode, origin: "auto"|"user", split_xy?}` yang mempartisi jendela klip; `origin:"user"` hanya `camera|fill_center|fit_blur`; `split` di range hanya `origin:"auto"` **dan** `AUTO_SPLIT` (spike RF-M2); `layout.default.mode = split` + `ranges` → `range_invalid`; `base.shots` wajib untuk `auto`.

**Dependensi:** G0.

**Kriteria terima**
- [ ] `ci-cd.yml` dan `editor-gates.yml suite=full` hijau di Node 24; `run_all.sh toolchain` (lewat `gh workflow run ci-cd.yml --ref <branch> -f suite=toolchain`) lolos P-TIME, P-TXT, P-ENC, P-COLOR, P-RT dengan ambang tidak berubah (01 §8.4), dan `record.json` tercap dari run itu di-commit.
- [ ] Invalidasi plate/render key tercatat (01 §8.2, §8.4; ringkasan di `docs/editor/OPERASIONAL.md` §3): byte cache plate sebelum/sesudah diukur di produksi-like volume; klip yang tidak diubah tetap memakai file otomatis R10 (`reused="auto_file"`) tanpa render ulang.
- [ ] stderr pipeline bersih dari peringatan `node:sqlite`.
- [ ] `UNDUHAN_M0.md` berisi go/no-go Kick, bgutil, range-only.
- [ ] Baseline reframe (camera hari ini) dilaporkan di dev split.
- [ ] PR kontrak di-merge.
- [ ] Disk produksi diukur (baseline 81%) dan dicatat di `SOSMED.md`/`UNDUHAN_M0.md` untuk cap cache/pin.

**Tes:** `ci-cd.yml` (Node 24) + `editor-gates.yml -f suite=full` dan `-f suite=image`; `scripts/parity/run_all.sh toolchain` (P-TIME, P-TXT matriks penuh, P-ENC, P-RT, R10) lewat `gh workflow run ci-cd.yml --ref <branch> -f suite=toolchain`, lalu `docs/editor/evidence/toolchain/record.json` dari artifact `toolchain-evidence` di-commit (dicek `scripts/parity/toolchain_guard.py check`); diubah `tests/test_edit_v2_toolchain.py` (pin Node 24); baru `web/tests/node-sqlite-stderr.test.mjs` (spawn `node -e 'import("node:sqlite")'` dengan env compose → stderr kosong, 01 §8.3; varian `import("./lib/db/index.mjs")` ditambahkan di Fase 4 saat `web/lib/db/` dibuat) dan `web/tests/sqlite-import-boundary.test.mjs` (01 §8.3); `tests/test_parity_ci_gates.py` tetap hijau tanpa diubah; `scripts/eval/auto_reframe.py --split dev` (baseline camera).

**Pengguna merasakan:** tidak ada (runtime baru). **Rollback:** image sebelumnya (`rollback-<sha>`); plate cache baru boleh dibuang.

### Fase 1 · Fondasi UI + i18n + shell + pemilih bahasa (20,5–23,5)

**Isi**
- **Dashboard F0 (7–9):** fondasi UI rinci di `05-ui-dashboard.md` §3 (dokumen itu yang berlaku). Ringkas: baris pertama `web/app/globals.css` = `@layer theme, base, components, utilities;`; aturan elemen + `.btn/.panel/.notice` ke `@layer base`; token `:root` dan reduced-motion di luar layer. `web/app/ui.css` **(baru)** diimpor hanya dari `web/components/AppShell.jsx` dan `web/components/ui/PublicCard.jsx` **(baru)** (kartu tanpa shell untuk `/login`, lalu `/undangan/[token]` dan `/atur-ulang-sandi/[token]` di Fase 6): impor `@heroui/styles` selektif (daftar file 05 §3.3) + `tw-animate-css`, tanpa preflight, `@source not "../components/editor"`, `@theme{--color-*:initial}`, alias penuh variabel HeroUI → token Potongin (05 §3.4), override komponen (05 §3.5). `web/postcss.config.mjs` **(baru)**. `components/ui/Providers.jsx` **(baru)** dengan `I18nProvider` React Aria, **tanpa** `RouterProvider`. `data-theme="dark"` di `<html>`. `.chip`→`.statusPill`; `.table/.tableWrap` dihapus. Lisensi di `/licenses` (test-first). Spike: diff CSS editor hasil build, baseline ukuran bundle per rute.
- **i18n M0 (6):** rinci `07-i18n.md` §2, §15. `use-intl@4.14.9`; `web/lib/i18n/{locales,resolve,catalog,server,format,errors,cookie}.mjs` + `client.jsx` **(baru)**; `web/lib/content-text.mjs` **(baru)**; katalog per folder `web/messages/{id,en}/<namespace>.json` **(baru)** untuk namespace inti; root `web/app/layout.jsx` hanya `IntlProvider`; `SegmentI18n` per segment; `generateMetadata` (12 `metadata` + `global-error`) dengan kunci `meta.<rute>.title` + `meta.<rute>.description` (07 §8.4); migrasi 18 file `Intl` + 3 file konten; `POTONGIN_LOCALES: ${POTONGIN_LOCALES:-id}` di service `app` (`compose.yaml`) + `.env.example`; HTML `Cache-Control: private, no-store`; TTFB `/`, `/dashboard`, `/login` sebelum/sesudah; `deploy/VM_NGINX_CLOUDFLARE.md` (HTML tidak di-cache edge).
- **Dashboard F1 (3–4):** `NavList` datar, Drawer < 1024 px, menu akun, logout via form tersembunyi + `requestSubmit()`, saklar "Pintasan satu tombol" di menu akun (cookie `potongin_shortcuts=on|off`, default `on`, lewat `web/lib/ui-prefs.mjs` **(baru)**; kontrak cookie: `05-ui-dashboard.md` §3.9; dibaca dashboard dan editor).
- **i18n M1 (3):** `POST /api/locale` publik (`web/app/api/locale/route.js` **(baru)**): kontrak lengkap di `07-i18n.md` §9.2 (dokumen itu yang berlaku). Ringkas: hanya `POST` (lain → 405 `Allow: POST`); urutan cek method → `sameOriginMutation` (403 `csrf_rejected`) → rate limit `TokenBucketLimiter` 20/menit per hash IP (`web/lib/rate-limit.mjs`; 429 `rate_limited` + `Retry-After`) → body ≤ 1 KiB (413 `request_too_large`); body form `locale`, `next?` (jalur utama) atau JSON `{locale}`; `locale` ∉ locale aktif → 400 `locale_unsupported`; body rusak → 400 `invalid_request`. Efek `Set-Cookie: potongin_locale=<kode>` (tidak HttpOnly, selalu `Secure`, 07 §5.2). Respons form `303` ke `next` (bila `safeNextPath(next) === next`) → `Referer` same-origin → `/`; error form juga `303` dengan `?bahasa=gagal`; respons JSON `200 {locale}`. Dikecualikan di matcher `web/proxy.js` (`api/locale/?$`) dan diuji di `proxy-matcher.test.mjs`; `web/tests/route-guard-coverage.test.mjs` **(baru)** dibuat di Fase 1 dengan allowlist awal beralasan (termasuk `locale`) dan diperketat penuh di Fase 5 MU-M3 (dok 02 §13.1, dok 07 §9.3). Pemilih di menu akun (`Dropdown.Section selectionMode="single"` → form tersembunyi + `requestSubmit()`) dan `/login` (form native, jalan tanpa JS). Restyle `/login` (field `name` sama, `role="alert"`). not-found, error, global-error.
- **ui-guards** menolak copy "Selection V3", `engine_fallback`, label versi, palet Tailwind (`bg-red-500`, `-[#`) di `className`.
- **Migrasi tes (1,5).**

**Dependensi:** Fase 0 (Node 24).

**Kriteria terima**
- [ ] `next build` hijau.
- [ ] CSS editor hasil build **identik** byte; kenaikan JS rute editor ≤ ukuran use-intl dan tercatat di PR.
- [ ] e2e editor, `parity-text`, dan screenshot editor tanpa diff.
- [ ] Halaman uji (Button, Modal, Table, DatePicker, Switch) sesuai palet, target 44 px, tanpa lime selain `variant="primary"`.
- [ ] Tes alias variabel membaca `node_modules/@heroui/styles/dist/themes/default/variables.css` dan semua variabel ter-alias.
- [ ] Setiap `<Button` menulis `variant`; ≤ 1 `primary` per file halaman.
- [ ] Ganti bahasa ≤ 2 klik, bertahan setelah reload, jalan tanpa JS di `/login`; pengunjung tanpa cookie mengikuti Accept-Language (`in` = `id`).
- [ ] Shell: fokus kembali ke tombol Menu, latar inert saat Drawer, `aria-current`, kelas `.jobBadge/.jobBadgeDot/.jobBadgeText/.brandName` tetap.
- [ ] Pintasan satu tombol bisa dimatikan sejak rilis (WCAG 2.1.4).
- [ ] `en-smoke` (shell + login) hijau di CI dengan `POTONGIN_LOCALES=id,en`.
- [ ] Ratchet `i18n-hardcoded` = 0 di `AppShell`, `login`, `not-found`, `error`.
- [ ] TTFB tercatat; `VM_NGINX_CLOUDFLARE.md` diperbarui.

**Tes:** diubah `app-shell`, `ui-guards`, `licenses`, `entry-pages`, `help-page`, `help-guide`, `job-badge`, `proxy-matcher`; baru `ui-foundation`, `heroui-variables`, `heroui-default-labels`, `i18n-catalog`, `i18n-usage`, `i18n-hardcoded`, `i18n-intl-literal`, `i18n-registry`, `i18n-resolve`, `i18n-rsc-boundary`, `content-language-isolation`, `locale-route`, `route-guard-coverage` (allowlist awal), `ui-prefs`, `app-nav`, `app-shortcuts` (05 §8.1); e2e `app-shell` (+ proyek mobile), `header-badge`, `smoke`, `read-only`, `aria-names` (baru). `web/playwright.config.mjs`: `use.locale:"id-ID"` di semua proyek, proyek baru `en-smoke`; `web/e2e/support/harness.mjs` memasang cookie `potongin_locale=id`.

**Pengguna merasakan:** shell baru dan pemilih bahasa. Produksi tetap `id`; pemilik boleh menyalakan `id,en` sebagai pratinjau selama belum ada anggota.
**Rollback:** image. Image lama mengabaikan cookie `potongin_locale` dan tampil Indonesia.

### Fase 2 · Buat klip + Detail proyek + kode error/progres (25,5–27,5)

**Isi** (urutan wajib: M5 → F3)
- **Dashboard F2 (6–7):** composer chip bernilai (`8 klip`, `9:16`, `30–60 dtk`, `Karaoke`); chip **Tata letak**: Ikuti wajah / Potong tengah / Latar blur (dari `web/lib/layout-names.mjs`; Layar terbagi tidak ada di sini); redirect ke `/projects/[id]` setelah submit.
- **i18n M5 (3):** `stage_code`/`stage_params` di `report()` `src/ai_clipper/pipeline.py`; `stageCode` di `web/scripts/run-job.mjs` dan `web/lib/primary-job-queue.mjs`; `reason_codes`/`warning_codes` (+params) aditif di manifest dari `selection_v3.py`, `ranking.py`, `features.py`, `pipeline.py`; namespace `stage`, `reason`. Peringatan `pipeline.py` ikut berkode.
- **Dashboard F3 (6–7):** stepper progres, grid klip, penampil `Modal` `?klip=N` (N = nomor, bukan id), `←/→` pindah klip, "Edit klip" sebagai `<a>` (pemuatan penuh, COEP), copy + gambar landing (`web/app/page.jsx`, `web/public/landing/editor.webp`).
- **i18n M2 (6):** `web/lib/error-codes.mjs` **(baru)** (domain `web.*`), `web/lib/api-error.mjs` **(baru)** (normalisasi string/datar/bersarang → `{code,messageId,params,legacyText}`); `code`/`messageId`/`params?` aditif di 49 route `web/app/api/**/route.js`; 33 pembaca klien; peta pesan menjadi daftar kode + `legacyMessage(code)` server; amandemen G-FAIL di `docs/editor/GATES.md` dan CONTRACTS §5.65.
- **i18n M3 bagian (3)** untuk layar F2/F3. **Migrasi tes (1,5).**

**Dependensi:** Fase 1.

**Kriteria terima**
- [ ] `i18n-error-codes` hijau: setiap kode di `download-errors`, `STORAGE_ERROR_CODES`, `llm.py ERROR_CODES` (20), `edit_v2/errors.py` (70), `COMMAND_MESSAGES`, `editor-ai`, `error-codes.mjs` punya `errors.<messageId>` di semua locale; teks `errors.edit.*` di `web/messages/id/errors.json` sama persis dengan `_MESSAGES` Python (subproses).
- [ ] Tidak ada respons error tanpa `code` di `app/api` (ratchet 0). String `error` Indonesia tetap ada.
- [ ] Tes route dan kontrak lama hijau **tanpa diubah**; agen tren (`/api/ingest/trends`) tidak terdampak.
- [ ] Gold seleksi (7 episode, `docs/evaluation/gold/*.gold.json`): klip terpilih, urutan, dan skor identik; manifest hanya bertambah field.
- [ ] Job lama (tanpa `stage_code`/`reason_codes`) tetap tampil apa adanya (`old-jobs.test.mjs`).
- [ ] Enter di composer → `/projects/[id]`; error validasi memfokuskan field salah dengan popover terbuka; tanpa paragraf.
- [ ] Klip tampil bertahap; editor dibuka dengan header COOP/COEP (e2e `editor-flow`).
- [ ] Screenshot `en` 360 px tanpa scroll horizontal.

**Tes:** `dashboard-view`, `dashboard-choices`, `clip-limits`, `subtitle-upload`, `time-ranges`, `selection-v3`, `source-language`, `look-preview`, `layout-names`, `storage-status-ui`, `focus`, `project-view`, `project-workspace`, `stage-summary`, `job-cancel-view`, `clip-failures`, `clip-text`, `clip-hook`, `jobs`, `entry-pages`; Python `tests/test_pipeline*`, `tests/test_selection_v3*`; e2e `dashboard` (field di popover), `focus`, `read-only`, `project-workspace`, `cancel-job`, `clip-text`, `clip-hook`, `editor-flow`, `editor-clip-nav`.

**Pengguna merasakan:** Buat klip ringkas, hasil langsung di halaman proyek, error dan progres dalam bahasa aktif.
**Rollback:** image (semua aditif).

### Fase 3 · Proyek, Pengaturan, Tren, Bantuan (22–25)

**Isi**
- **Dashboard F4 (3–4):** `/projects` Table, filter + hitungan, batch hapus (AlertDialog + toast sebagian), tab Klip.
- **Dashboard F5 (6–7):** Pengaturan dengan Tabs hash (AI, Transkripsi, Tampilan, YouTube, Sistem; **tanpa** tab Akun), panel tetap ter-mount (`shouldForceMount` milik RAC `TabPanel`; dokumentasi `Tabs.Panel` HeroUI v3 hanya mencantumkan `id`/`className`/`render`, jadi spike Fase 1 F0 memastikan prop ini diteruskan — bila tidak, panel nonaktif dirender sendiri dengan atribut `hidden`), satu bar simpan, saklar pintasan di Tampilan (preferensi yang sama dengan menu akun).
- **Dashboard F6 (3–4):** Tren dengan Modal dan tab Agen.
- **Dashboard F10 (3):** Bantuan dengan anchor tetap (deep link `/bantuan#<kode>` tetap), tanpa JS; `Disclosure` hanya untuk Panduan (item yang cocok hash dibuka otomatis); CSS mati dihapus; `.btn` minimal tetap untuk `global-error`.
- **i18n M3 sisa (3), M4 (3):** `help.*`, indeks pencarian dari teks `shown` semua locale + kode.
- **Migrasi tes (1):** `selectOption` → role (`trends.spec` 4, `settings-watermark.spec` 1); `checkbox` → `switch`.

**Dependensi:** Fase 2.

**Kriteria terima**
- [ ] Hash lama Pengaturan membuka tab yang benar; perubahan belum simpan tidak hilang saat pindah tab.
- [ ] Pesan `id` yang ditempel di UI `en` tetap ditemukan di Bantuan; `help-page.test` (tanpa JS) hijau di dua bahasa.
- [ ] Ratchet `i18n-hardcoded` = 0 di semua rute dashboard yang ada.
- [ ] Token Tren tampil sekali; selector e2e berbasis role.
- [ ] Tanpa CSS mati; `global-error` tetap bergaya.

**Tes:** `clip-library-view`, `clip-library`, `job-deletion`, `settings-trends-ui`, `system-info`, `transcription-settings`, `default-logo`, `default-watermark`, `youtube-cookies`, `llm-settings`, `llm-settings-view`, `llm-settings-routes`, `trend-view`, `help-page`, `help-catalog`, `ui-guards`; e2e `history-clips`, `smoke`, `settings-*`, `trends`, `bantuan`.

**Pengguna merasakan:** seluruh dashboard baru. UI `en` lengkap kecuali editor (fallback Indonesia) — hanya terlihat bila pratinjau `id,en` dinyalakan.
**Rollback:** image.

### Fase 4 · Fondasi identitas (12–14)

**Isi**
- **MU-M1 + MU-M2 (10–12) + migrasi settings (≈1):** daftar file dan kriteria rinci di `02-multiuser-keamanan.md` §15 (baris MU-M1 + MU-M2); data/DB di `01-arsitektur-data.md` §2–§5, §7, §10.
  - `web/lib/db/{index,migrate,prune,settings-move}.mjs` **(baru)**; migrasi `web/lib/db/migrations/0001-identity.sql` **(baru)** — isi tabel (`meta`, `users` termasuk `locale` dan kolom batas per user, `sessions`, `invites`, `password_resets`, `api_tokens`, `instance_settings`, `audit_events`, `process_heartbeats`) dan pragma: lihat 01 §3.1, §4.1, §2.2.
  - Volume `potongin_control:/control` di service `app` dan `primary-worker` (social-worker menyusul di R1, Fase 6); `POTONGIN_DB_PATH=/control/potongin.sqlite`, `POTONGIN_SETTINGS_DIR=/control/settings`; `/data/settings` **disalin** ke `/control/settings` dengan sha256 + penanda `.migrated-from-data`, salinan lama dibekukan untuk image rollback (01 §5.2; bukan symlink).
  - `web/scripts/{start-app,db-backup,db-restore,admin-reset}.mjs` **(baru)**; `Dockerfile` `CMD ["node","scripts/start-app.mjs"]`, `HEALTHCHECK --start-period` 60s (01 §2.1, §10).
  - `web/lib/{passwords,sessions,users,audit,instance-settings}.mjs` **(baru)**; sesi, cookie, upgrade v1 → s2, `currentUser`/`requireUser` sinkron, `sessionFromCookieStore`, pembaca nama cookie + `rateKeyOf()`: dok 02 §4.
  - Bootstrap admin dari `APP_*` dan user smoke dari `E2E_SMOKE_*` oleh `start-app.mjs` (01 §10 langkah 4–5).
  - Rate limit login per username **dan** per IP; `sameOriginMutation` di route baru (dok 02 §7.1).
  - Draft editor (`web/lib/editor/draft-store.mjs`) dikunci hash user, dibersihkan saat logout.
  - Deploy: backup DB + kredensial smoke (§9).
- **i18n M6a (1):** kolom `users.locale` sudah ada di `0001` (01 §3.1; tidak ada migrasi `users-locale` terpisah); login menyalin `users.locale` ke cookie; `/api/locale` dengan sesi valid juga menulis `users.locale` (07 §9.4).

**Dependensi:** Fase 3 (atau paralel dengan Fase 2–3, §6).

**Kriteria terima**
- [ ] Migrasi idempoten (dua kali jalan = no-op); skema lebih baru diterima kode lama (`db-migrations.test`).
- [ ] Backup `VACUUM INTO` lolos `PRAGMA integrity_check`; restore offline (`db-restore.mjs`) diuji.
- [ ] Settings pindah dengan sha cocok; render-worker tidak bisa membuka `/control` (01 §11.2).
- [ ] Cookie v1 pemilik di-upgrade sekali; logout mencabut sesi di server (request berikutnya 401/redirect).
- [ ] `authorize-sync-contract` hijau (tidak ada guard async).
- [ ] Spec `read-only` + `smoke` lolos memakai **anggota smoke** berproyek kosong.
- [ ] `deploy-env-contract` memastikan `E2E_SMOKE_*` dipakai `run_read_only_e2e` dan memeriksa **mount** `/control` (ada di app/primary, tidak ada di render-worker).
- [ ] Perangkat kedua memakai bahasa dari DB.
- [ ] Ambang `login-rate-limit` tidak dilonggarkan; kunci per username+IP diuji.
- [ ] gitleaks bersih.

**Tes:** baru `web/tests/{passwords,sessions,users,db-migrations,db-schema,db-index,db-backup,db-restore,settings-move,authorize-sync-contract,deploy-env-contract,security-auth-fuzz}.test.mjs` (01 §11.1, 02 §13); diubah `proxy-matcher`, `login-rate-limit`, `env-example`, `security-child-env`, `editor-draft`, `parity-fixtures-route`, `entry-pages`; Python `tests/test_control_plane_isolation.py` (baru), `tests/test_deploy_guard.py` (backup + smoke cred).

**Pengguna merasakan:** login sama; logout benar-benar mencabut sesi; bahasa ikut akun.
**Rollback:** image lama mengabaikan DB; `APP_*` tetap valid; image lama + compose baru membaca `/control/settings` lewat `POTONGIN_SETTINGS_DIR`, image lama + compose lama membaca salinan beku `/data/settings` (perubahan setting setelah Fase 4 hilang; 01 §5.2).

### Fase 5 · Kepemilikan dan rahasia per user (17–19 ‖ 14)

**Isi**
- **MU-M3 (11–13):** rinci dok 02 §7, §8, §15. `ownerId` **dan** `fairnessKey` (`fk1_<16 hex>`, rumus dok 01 §6.1) ditulis ke `job.json` saat create; `web/lib/job-ownership.mjs` **(baru)**; `secureRoute({owner:'job', role})`; migrasi 49 route + 18 lib route + **5** route self-auth (upload jobs, assets, logo, youtube-cookies, `/api/locale`); listing difilter per owner; `serializePublicJob` membuang `ownerId` dan `fairnessKey`; `ownership-matrix` **(baru)** atas seluruh `app/api` dan `route-guard-coverage` (dibuat Fase 1) diperketat penuh (allowlist beralasan dok 02 §13.1; `/api/locale` hanya menulis `users.locale` milik sesi sendiri); `web/e2e/multiuser-isolation.spec.mjs` **(baru)**.
- **MU-M4 (6):** rinci dok 02 §9. `web/lib/sealing.mjs` v2 **(baru)** (AAD per user + purpose); `web/lib/owner-env.mjs` **(baru)** (env anak menurut `POTONGIN_OWNER_POLICY` dari primary-worker; anggota tidak pernah jatuh ke key LLM env); `run-job.mjs`, `python-cli.mjs`, `editor-ai.mjs`, `clip-text-api.mjs` me-resolve env menurut pemilik job; `POTONGIN_SETTINGS_SECRET` wajib; Pengaturan Pribadi/Instans dipetakan ke tab Fase 3 sesuai peran; "Tentang sistem", status storage global, health rinci (`/api/admin/health`) hanya admin, `/api/health` tetap minimal; cap harian LLM bersama di `shared_llm_usage` (migrasi `0002-shared-llm-usage.sql`, dok 01 §4.2).
- **‖ RF-M1 (6):** scan bersama di `face_window.py` (`scan_window(frame_diff=)`, `detect_window(scan=)`) dan `edit_v2/camera.py` (`build_camera_plan(scan=)`), dok 04 §A2–§A4; `src/ai_clipper/shot_context.py` **(baru)**; `src/ai_clipper/edit_v2/{shot_cuts,shots}.py` **(baru)**; `prepare_auto` memakai ulang camera plan.
- **‖ RF-M2 (8):** spike graf dulu (`scripts/parity/auto_graph_spike.py` **(baru)**: fallback chain + satu split chain overlay/streamselect/maskedmerge vs concat K chain pada 1, 8, 48 run); lalu validator V1–V9, `shot_frames`, `Compiler.layout` cabang auto, `plate_key`, `shots_for`; **kompiler mengompilasi `layout.ranges`** (§5.63; dok 04 §A6–§A7).

**Dependensi:** Fase 4.

**Kriteria terima**
- [ ] Setiap route × method: user B memakai id milik A → **404 identik** (status, body termasuk `code`/`messageId` = `errors.web.not_found`, header) dengan "tidak ada", dan **nol spawn Python**. Admin tanpa opt-in juga 404.
- [ ] Anggota dengan berbagi mati mendapat env anak tanpa key LLM/Groq walau `GROQ_API_KEY` ada di env; job tetap selesai dengan heuristik.
- [ ] Kotak tersegel lintas user atau lintas purpose gagal dibuka; kotak v1 tetap terbaca.
- [ ] `multiuser-isolation.spec` hijau.
- [ ] Reframe:
  - byte camera plan tidak berubah di semua fixture dan `camera_real`;
  - cut di dev split P ≥ 0,95 dan R ≥ 0,90 pada ±1 frame grid (termasuk VFR, 59,94→29,97, 60→30) — cadangan dipakai bila perlu, ambang tidak turun;
  - scan CI ≤ 15 dtk + 0,5 dtk/cut;
  - graf terpilih < 3 GiB `RLIMIT_AS`, jumlah konteks filter tidak tumbuh;
  - md5 frame = pure chain;
  - semua graf, plan sha, plate key non-auto dipin tidak berubah;
  - `RENDER_SEMANTICS` tetap 2.

**Tes:** baru `ownership-matrix`, `job-ownership`, `sealing-v2`, `owner-env`; diperketat `route-guard-coverage`; diubah `web/tests/security-support.mjs` (helper, `routeFiles` seluruh tree), `security-child-env`, `security-routes`, `request-security`, `system-info`; Python baru `tests/test_edit_v2_{shots,shot_cuts}.py`, `tests/test_shot_context.py`; diubah `tests/test_edit_v2_{compile,plates,doc,seed,camera,face_zone}.py`, fixture `tests/fixtures/edit_v2/shot-vectors.json` (baru).

**Pengguna merasakan:** Pengaturan Pribadi/Instans. Belum ada anggota.
**Rollback:** image; job lama terlihat oleh login env; `ownerId`/`fairnessKey` diabaikan image lama.

### Fase 6 · Siap untuk anggota (34–35 ‖ 8 ‖ 5)

**Isi** (urutan wajib, keamanan dulu)
1. **MU-M4b keamanan (4):** aturan, kode error, dan daftar file dimiliki dok 02 §11 + §15 (baris MU-M4b); bagian sumber link dirinci dok 04 §B3. Ringkas:
   - `web/lib/media-probe.mjs` **(baru)** + `src/ai_clipper/media_probe.py` **(baru)** (02 §11.2): ekstensi + magic bytes + ffprobe dengan whitelist format; ditolak sebelum job dipublikasikan ke antrean dengan 400 `source_rejected_format` / `source_rejected_codec` / `source_rejected_duration`; `pipeline.py` menjalankan probe yang sama di awal untuk semua sumber, termasuk hasil unduhan.
   - `-protocol_whitelist file,pipe` di **semua** argv ffmpeg/ffprobe `src/ai_clipper/**` (daftar file yang diubah: 02 §11.3), demuxer eksplisit untuk input sumber, audio Whisper lewat WAV ber-whitelist, OpenCV lewat `OPENCV_FFMPEG_CAPTURE_OPTIONS`.
   - Inti `web/lib/source-url.mjs` **(baru)** + `src/ai_clipper/fetch/platforms.py` **(baru)** (02 §11.4): allowlist YouTube saja, fixture bersama `tests/fixtures/fetch/urls.json` **(baru)**; kode `source_host_not_allowed` / `source_rejected_kind` / `source_private_address`; argv yt-dlp + `--ignore-config --use-extractors youtube --max-filesize`.
   - Diubah: `scripts/security/{route_matrix,make_upload_fuzz}.py` (fuzz kind `source`, semua route); baru `scripts/security/route_policy.json` (tambahan dokumen ini, §8.5); tes baru `tests/test_security_protocol_whitelist.py`, `tests/test_security_media_probe.py`, `tests/test_fetch_platforms.py`, `web/tests/source-url.test.mjs` (02 §13.1).
2. **MU-M5 + dashboard F7 (≈ 7–8, dedupe X1):** API dan alur: dok 02 §6, §8.2; layar: dok 05 §6.11–§6.12. `/admin/pengguna`, `/admin/pengguna/[userId]` ("Pindahkan proyek ke…", "Hapus proyek pengguna ini", nonaktifkan, ubah peran), `/admin/job`, `/akun`, `/akun/kata-sandi`, `/undangan/[token]`, `/atur-ulang-sandi/[token]` (dengan pemilih bahasa); login pertama akun buatan admin wajib ganti sandi; audit; kode Bantuan; re-auth (`POST /api/auth/reauth`, dok 02 §6.7) untuk transfer/hapus/reset sandi; rate limit + anti-enumerasi untuk invite/reset; tautan `/akun` di Pengaturan.
3. **i18n M6b (0,5):** field Bahasa di `/akun`. **M7a (1,5):** namespace `admin`, `account`; `audit_events` menyimpan `code` + `params` sejak baris pertama; tautan undangan/reset dalam bahasa pilihan admin.
4. **MU-M6 (2,5):** token API per user (`ptk_…`, hash di DB); impor `ingest-tokens.json` (`web/lib/ingest-tokens.mjs` membaca impor); tren instans-wide + switch per anggota.
5. **MU-M7 (4):** rinci dok 02 §10.2–§10.3. Fairness primary `lastServedAt` dari `queue.firstClaimedAt` (policy terinjeksi ke `claimNextJob`, modul antrean tetap bebas DB); reservation v3 (R1 baca v1/v2/v3 tulis v2, lalu R2 tulis v3 = kunci v2 + `ownerId`); `src/ai_clipper/render_worker.py` round-robin per `job.json` `fairnessKey` (ditulis MU-M3; tidak cocok `^fk1_[0-9a-f]{16}$`/tidak ada = `legacy`) — kunci **tidak** ditaruh di file request render karena `_V3_FIELDS` menolak kunci tambahan (dok 01 §6.2); posisi antrean `queue.position` + `queue.etaSeconds` di halaman proyek.
6. **MU-M7b drain (3):** kontrak dok 02 §10.5, sisi `production.sh` di §9.3 dokumen ini; penanda `JOBS_ROOT/.potongin-maintenance`, `web/scripts/maintenance.mjs` + `web/lib/maintenance-mode.mjs` **(baru)**; status "Antre · Pemeliharaan" (`queue.held:"maintenance"`); runbook di `docs/operations/PENGGUNA.md`.
7. **MU-M8 (3,5):** kuota storage per user (dok 02 §10.4; `web/lib/user-storage-usage.mjs` **(baru)**, admission di `web/lib/storage-admission.mjs`).
8. **MU-M9 (4):** `web/scripts/multiuser-migrate.mjs` **(baru)** `--dry-run|--apply` (mengisi `ownerId` + `fairnessKey` job terminal); impor `ingest-tokens.json` + salin default logo/watermark saat boot (01 §10 langkah 6); `docs/operations/PENGGUNA.md` **(baru)**; drill lama→baru→lama di CI termasuk restore (`db-restore.mjs`).
9. **Cadangan (4).**
- **‖ RF-M3 (4):** seed, pipeline, CLI auto; pemetaan legacy auto→fit-blur lewat `engine_fallback` (tidak tampil di UI); flag `POTONGIN_AUTO_REFRAME=off`; `scripts/ops/auto_layout_downgrade.py` **(baru)**. Dirilis sebagai **release 1 = rollback floor** (flag mati).
- **‖ RF-M4 (4):** penyetelan split dan group framing di dev split, lalu satu run test split.
- **‖ SOS-M1 Release A (5):** rinci dok 03 §6.8, §12.2. `web/lib/social/{store,errors,redact,http,scheduler,apps}.mjs` **(baru)** di atas DB + `sealing.mjs`; migrasi `0003-social-base.sql` (dok 01 §4.3); `web/scripts/{social-worker,check-social-worker-health}.mjs` **(baru)**; worker hanya heartbeat selama `POTONGIN_SOCIAL=off`; gate fake-origin tiga lapis; `SocialAppsCard` di Pengaturan → Sistem (admin). Rilis **R0** (image saja) lalu **R1** (service di compose) — §9.4.

**Dependensi:** Fase 5. Undangan **dilarang** sebelum langkah 1 hijau.

**Checklist sebelum undangan pertama** (ditandatangani pemilik di PR MU-M9)
- [ ] `POTONGIN_LOCALES` kembali ke `id` (Q9 final = b).
- [ ] Sandi pemilik sudah diganti dari nilai `APP_*` awal; deploy berikutnya tetap hijau karena e2e memakai user smoke.
- [ ] `POTONGIN_SETTINGS_SECRET` terisi dan berbeda dari `APP_SESSION_SECRET` *atau* disalin sesuai runbook.
- [ ] Backup DB terakhir < 24 jam lolos `integrity_check`.
- [ ] `node scripts/admin-reset.mjs --purge-legacy-settings` sudah dijalankan (01 §5.2).
- [ ] `route_matrix.py`, `ownership-matrix`, dan `multiuser-isolation.spec` hijau di `main`.

**Kriteria terima**
- [ ] `queue-fairness`: A mengantrekan 10 job, B 1 job belakangan; B menjadi klaim ke-2 pada concurrency 1; render: B klaim ke-2 (`test_render_worker_fairness.py`).
- [ ] Dengan kuota storage uji diisi admin, melewati kuota → 507 `user_storage_quota` (`errors.web.user_storage_quota`, dok 02 §10.4) sebelum ada byte atau render request tertulis; kuota `null` (default) tidak pernah menolak.
- [ ] CLI render-worker berjalan tanpa `POTONGIN_DB_PATH`.
- [ ] Deploy dengan job aktif masuk mode drain dan selesai tanpa intervensi (§9.3).
- [ ] Drill lama→baru→lama hijau, termasuk compose baru + image lama.
- [ ] Release A: `social-worker` healthy, restart count 0.
- [ ] e2e produksi lolos dengan kredensial smoke setelah pemilik mengganti sandi.
- [ ] Non-admin mendapat 404 di `/admin/*`; tambah/ubah peran/nonaktifkan bekerja; login pertama wajib ganti sandi.
- [ ] Reframe: agreement test split ≥ 85%; multi SPEAKER_FRAMING ≤ 21,7%; pemilik menerima ≥ 8/10 klip split.
- [ ] Format media berbahaya (HLS/concat dalam `.mp4`) ditolak di upload dan tidak pernah mencapai Whisper/pipeline.

**Tes:** baru `queue-fairness`, `reservation-v3`, `invites`, `password-resets`, `api-tokens`, `user-storage-usage`, `maintenance-mode`, `social-store`, `social-fake-origin-gate`; e2e `admin`, `account` (baru); fuzz `make_upload_fuzz.py` kind `source` + `route_matrix.py` lewat `editor-gates.yml suite=command`; Python `tests/test_render_worker_fairness.py` (baru), `tests/test_auto_layout_downgrade.py` (baru), `tests/test_deploy_guard.py` (drain, social health, rollback R0/R1).

**Pengguna merasakan:** pemilik bisa mengundang anggota; ada Akun, Kelola pengguna, antrean adil dengan posisi.
**Rollback:** image, dengan batasan: jangan melewati migrasi contract; melewati R1 ke image tanpa label social-worker ditangani otomatis dengan `--scale social-worker=0` (§9.4); reservation v3 hidup melarang rollback ke sebelum R1 selama ≤ 60 menit (dok 02 §10.2); di bawah reframe floor pakai `auto_layout_downgrade.py`.

### Fase 7 · Unduhan sumber + Otomatis menyala (≈ 40, +2 bila Kick go)

**Isi**
Milestone, file, kode error sumber, dan gate dimiliki `04-reframe-unduhan.md` (§A2, §B2, §B13, §B15, Bagian C); daftar di bawah hanya urutan dan estimasi.
- **FETCH-M1 (4):** memperluas inti M4b dengan Twitch (dan Kick bila go); `isLinkSource()` di semua pembaca, termasuk `web/lib/primary-job-queue.mjs:816` (publikasi `input/` hari ini hanya untuk `type === "youtube"`); preflight `-J` + `src/ai_clipper/fetch/probe.py` **(baru)**; guard CI terhadap literal `type === "youtube"`.
- **FETCH-M2 (5):** `/data/cache-unduhan`, `web/lib/media-cache.mjs` **(baru)**, amandemen `docs/operations/STORAGE_RETENTION.md`.
- **FETCH-M3 (6):** engine `--analyze-audio/--media-duration`, handshake source-ready, video penuh diunduh paralel dengan audio yang sama, cache transkrip.
- **FETCH-M4 Twitch (3), FETCH-M5 Kick (2, hanya bila go), FETCH-M6 proxy tersegel + bgutil (5), FETCH-M7 ledger per user (3; migrasi `0004-download-ledger.sql`, dok 01 §4.4), FETCH-M8 workflow yt-dlp mingguan (2), FETCH-M10 rollout + drill (3).**
- Kode error sumber baru (`source_platform_off`, `source_live`, `source_duration_unknown`; tabel lengkap dok 04 §B13) dalam `id` dan `en` + entri Bantuan.
- **RF-M5a (≈ 4):** kartu Otomatis (editor lama), command, `draft-store`, apply-all menyalin mode (tanpa ranges).
- **RF-M6 gate (5):** P-FRAME, P-PLATE, P-JOIN-B, G-DET, PF-RENDER, PF-PIPELINE; Release 2 menyalakan flag setelah pemilik setuju (default tetap opt-in, Q10).
- Chip Tata letak di Buat klip menambah **Otomatis**.

**Dependensi:** Fase 6 (MU-M7 round-robin, MU-M4b).

**Kriteria terima**
- [ ] Dengan semua flag `POTONGIN_FETCH_*` mati, argv yt-dlp identik dengan hari ini (snapshot).
- [ ] Job Twitch mempublikasikan `input/` dan `sourcePath` ditulis ulang.
- [ ] Dua proses nyata yang mengunduh video sama hanya mengunduh sekali.
- [ ] Sweep cache menolak path di bawah `JOBS_ROOT`; cache tidak pernah menjadi satu-satunya pemilik byte job (hard link).
- [ ] Episode eval menghasilkan klip sama dengan batas ≤ 200 ms; gold `SELECTION_BENCHMARK.md` tidak berubah, atau dijalankan ulang dan dilaporkan sebelum merge.
- [ ] Waktu sampai seleksi membaik pada sumber ≥ 30 menit (angka sebelum/sesudah di PR).
- [ ] Render `POTONGIN_RENDER_ENGINE` edit-v2 dan legacy tidak berubah.
- [ ] Proxy tidak muncul di `/proc/<pid>/cmdline`, env, log, `job.json`, maupun respons.
- [ ] Reframe: P-FRAME 0 mismatch, P-PLATE crop x 0 px, G-DET 0 beda, PF-RENDER auto p50 ≤ 0,4× real time; RSS < 3 GiB pada CPU 1 dan 4.
- [ ] Siaran langsung dan video > `POTONGIN_MAX_SOURCE_SECONDS` ditolak sebelum unduh.

**Tes** (daftar lengkap dok 04 §A10, §B15): Python `tests/test_fetch_*.py` (baru), e2e `web/e2e/create-from-link.spec.mjs` (baru), paritas fixture `tests/fixtures/fetch/urls.json` (JS+Py); cache: dua proses, holder di-SIGKILL, cancel saat menunggu, EXDEV, symlink tanam; `scripts/parity/{frame_identity,plate_gates,join_gates}.py` + kasus auto (`cfr_30_auto`, `cfr_2997_auto`, `auto_keyframes`, `auto_zoom_content`, `auto_split`).

**Pengguna merasakan:** field "Link video" (YouTube/Twitch); penolakan cepat; seleksi lebih cepat; Otomatis (opt-in).
**Rollback:** flag `POTONGIN_FETCH_*`, `POTONGIN_MEDIA_CACHE`, `POTONGIN_AUTO_REFRAME` → `off` lalu recreate. YouTube tetap ditulis `{type:'youtube'}`; `{type:'link'}` hanya untuk platform baru, ditulis setelah ada rilis yang bisa membacanya.

### Fase 8 · Posting dan jadwal sosmed (29–30 + kalender audit)

**Isi**
API, state machine `publish_runs`, kode error, dan gate dimiliki `03-sosmed-performa.md` (§6, §8, §9, §15–§17); layar `05-ui-dashboard.md` §6.5–§6.6.
- **SOS-M2 (5):** connect, refresh dua fase (tanpa transaksi terbuka selama I/O), disconnect + purge, callback Meta.
- **SOS-M3a (6):** tabel `posts` + `publish_runs` (migrasi `0005-posts.sql`, DDL dok 01 §4.5; aturan pakai dok 03 §4); `web/lib/post-registry.mjs` **(baru)**; `listJobClips(job)` di `web/lib/jobs.mjs` (manifest saja); `rangeFileResponse` dipecah dari `web/lib/final-files.mjs`; `web/lib/social/{media,publisher,post-text}.mjs` **(baru)** (hanya ekspor `completed` yang lolos `verify.py`); `cancelRunsForJob` dipanggil dari `DELETE` di `web/app/api/jobs/[id]/route.js` dan `/api/admin/jobs/[id]` sebelum `requestJobDeletion` (hapus job → batalkan jadwal; `web/lib/job-deletion.mjs` tidak berubah, dok 03 §6.6).
- **SOS-M3b (6):** TikTok `FILE_UPLOAD`, Instagram resumable.
- **SOS-M4 + dashboard F8 (≈ 8–9, dedupe X3):** `/sosial?tab=jadwal|akun`, `?hasil=terhubung|ditolak|gagal` (dok 03 §7.1), `web/components/PublishDrawer.jsx` **(baru)** (satu-satunya komponen terbit, dipakai ulang editor), `ClipPosts`; kata status postingan dari `status.post.*` (dok 05 §5): Terjadwal, Mengunggah, Terbit, Gagal, Dibatalkan (tersembunyi default); "Hubungkan ulang akun"/"Menunggu kuota" dan "Perlu dicek" (`maybe_sent`) hanya detail, bukan status keenam.
- **SOS-M6 (2):** `deploy/VM_NGINX_CLOUDFLARE.md` (callback OAuth, `/privasi`, `/ketentuan`, media publik, ukuran body/timeout unggah); rollout `POTONGIN_SOCIAL=admin` lalu `on`.
- **i18n M7b (2):** namespace `social`; `users.time_zone` (migrasi `0006-user-time-zone.sql`, dok 01 §4.6) + `PATCH /api/account/preferences` + Zona di `/akun` (dok 07 §13.2); DatePicker `ZonedDateTime` (disimpan ISO UTC + zona asal; `hourCycle={24}`, `granularity="minute"`, nama zona pendek tampil, tanpa `hideTimeZone`); status posting berbasis kode; `email.*` bila SMTP ada.

**Dependensi:** Fase 6 (Release A), SOS-M0; kalender platform (G0).

**Kriteria terima**
- [ ] Crash matrix per provider × checkpoint: tepat satu posting remote, atau `maybe_sent` yang disengaja.
- [ ] Error `deferred` tidak menghabiskan percobaan.
- [ ] Ekspor `queued`/`failed` tidak pernah dipilih; tes `final-files` tidak berubah dan hijau.
- [ ] `social-publish.spec` lolos di dua locale melawan fake platform.
- [ ] Produksi mode `admin`: satu posting privat per platform + satu terjadwal berhasil.
- [ ] Jadwal dibuat di `en` zona X tampil benar di `id` zona Y; scheduler dengan jam manual melintasi DST Pacific.
- [ ] Drill `POTONGIN_SOCIAL=off`: route 404, UI tersembunyi, data tetap.
- [ ] Redaksi: tidak ada token OAuth/`ptk_` di log, argv, `job.json`, respons.
- [ ] Cap per user 100 run aktif / 20 per jendela jadwal 1 jam ditegakkan (429 `social_cap_scheduled` / `social_cap_hourly`, dok 03 §10.1).

**Tes** (daftar lengkap `03-sosmed-performa.md` §16): baru `web/tests/support/fake-social-platform.mjs`; unit `social-store`, `social-scheduler` (jam manual `web/tests/support/manual-clock.mjs`, DST Pacific), `social-tokens`, `social-oauth`, `social-provider-contract`, `social-{youtube,tiktok,instagram}`, `social-media`, `social-quota`, `social-caps`, `social-post-text`, `social-redact`, `social-meta-callbacks`, `social-routes`, `social-job-delete`, `social-mp4-duration`, `social-schema`, `post-registry`, `db-owner-scope` (dok 01 §11.1), `list-job-clips-parity` (JS `listJobClips` = Python `_clips` lewat subproses), `social-crash-matrix`; e2e `social-publish` (di `id` dan `en`), `multiuser-isolation` diperluas; `ownership-matrix` dan `route-guard-coverage` diperluas ke `app/api/social/**`; tes `final-files` tidak diubah.

**Pengguna merasakan:** **Terbitkan** dari halaman proyek; halaman Sosial (Jadwal, Akun). Unggahan privat/tester sampai audit lolos.
**Rollback:** `POTONGIN_SOCIAL=off` + recreate, tanpa rebuild.

### Fase 9 · Umpan balik performa dan Analitik (26–27)

**Isi**
Rumus profil, API analitik, dan Gate 1–3 dimiliki `03-sosmed-performa.md` §9.2–§9.3, §13, §15.2; layar `05-ui-dashboard.md` §6.7.
- **FB-M1 (5,5):** `web/lib/json-store.mjs` **(baru, ekstraksi)**, `web/lib/performance-store.mjs` **(baru)** (append-only), migrasi `0007-performance.sql` (dok 01 §4.7), impor CSV + "Cocokkan", "Catat angka", DELETE metrik.
- **FB-M2 (3,5):** `src/ai_clipper/performance_profile.py` **(baru)**, `web/lib/{performance-keys,performance-profile}.mjs` **(baru)**, `preparePerformanceProfile` di `web/scripts/primary-worker.mjs` sebelum spawn `run-job.mjs` (dok 03 §13.4; `run-job.mjs` tidak membuka DB), argumen `--performance-profile` di `run-job.mjs`.
- **FB-M3 (5):** `order_boost` terpisah di `selection_v3.py` (`_focus_floors` tetap hanya boost tren); `SelectorContext.performance`; `scripts/eval/performance_gate.py` **(baru)**.
- **FB-M4 + SOS-M5 (4):** `web/lib/metrics-refresh.mjs` **(baru)** di social-worker, adapter `readPostStats` per provider, `social/{retention,outcomes}.mjs`.
- **FB-M5 + dashboard F9 (≈ 5–6, dedupe):** `/analitik` (tile, chart SVG dengan ringkasan teks, tabel, baris Umpan balik tanpa tab); Switch "Pakai di pemilihan klip" (`analytics.useInSelection`, default mati; layar dok 05 §6.7).
- **i18n M7c (0,5):** namespace `analytics`. **FB-M6 (2,5):** laporan retro leave-future-out + bootstrap CI.

**Dependensi:** Fase 8 (registry, adapter). Basis Gate 1 = commit `main` setelah Fase 7.

**Kriteria terima**
- [ ] Gate 1: tanpa profil, 7 episode heuristik + 5 replay cache byte-identik (termasuk semua request sha256) terhadap basis.
- [ ] Gate 2: profil yang tidak cocok tidak mengubah apa pun.
- [ ] Gate 3: Hits@5/10 turun ≤ 1; Trap@10 tidak naik; floor fokus identik; ukuran efek dilaporkan (bar ≥ 20% episode berubah ≥ 1 pick dengan profil "favour archetype X"; bila tidak, ditulis "tidak ada efek").
- [ ] Paritas kunci Python/JS (tabel kasus `rules.v1.json`).
- [ ] Nilai mentah YouTube > 30 hari tanpa refresh diciutkan ke agregat.
- [ ] Pemilik membaca laporan retro sebelum toggle boleh dinyalakan.
- [ ] Held-out dijalankan **sekali** di akhir.

**Tes:** unit `metrics-refresh`, `metric-horizons`, `performance-profile`, `performance-keys-parity` (fixture bersama `tests/fixtures/performance/keys.json` **(baru)**), `metrics-csv`, `analytics-view`, `performance-routes`; Python `tests/test_performance_profile.py`, `tests/test_selection_v3_performance.py`, `tests/test_edit_distance.py` (semua baru); e2e `web/e2e/analytics.spec.mjs` **(baru)**; gate `scripts/eval/performance_gate.py` lewat `editor-gates.yml -f suite=command` (bukan di PC pemilik).

**Pengguna merasakan:** Analitik, impor CSV, toggle seleksi (default mati).
**Rollback:** toggle per user atau `POTONGIN_PERFORMANCE=off`; tanpa profil output byte-identik.

### Fase 10 · Editor I: shell dan tab (≈ 31)

**Isi** (rinci per sub-fase: `06-editor.md` §17; amendemen CONTRACTS §5.66–§5.69 dialokasikan di PR kontrak fase ini, 06 §11.1)
- **Editor F0 (5):** kit HeroUI/RAC untuk editor (entri CSS sendiri, Tailwind v4 tanpa preflight, `@layer` di bawah CSS Modules); `react-aria-components` eksplisit untuk GridList/FileTrigger; port forced-colors (`ui/ui.module.css:478`); amandemen guard `ui-foundation` (X10) — larangan `RouterProvider` tetap.
- **Editor F1 (5):** shell satu layout (§1.1), top bar, daftar Klip, **5 tab** Teks · Tata letak · Audio · Logo · Cold open (hanya "Musik"→"Audio"), `?mode=`/`?card=` lama dialihkan ke tab setara, saklar pintasan di modal Pintasan (preferensi bersama cookie `potongin_shortcuts`, `web/lib/ui-prefs.mjs`), hitungan kontrol diukur (snapshot DOM sebelum/sesudah → `docs/editor/evidence/control-count.json` **(baru)**); file shell baru di `web/components/editor/shell/` (termasuk `Advanced.jsx` **(baru)** = `Disclosure` Lanjutan) dan `web/lib/editor/disclosure.mjs` **(baru)** (`06-editor.md` §2, §3.5).
- **Editor F2 (5):** transkrip tengah, toolbar kata, Kata | Baris, Rapikan + Ejaan dalam satu Drawer, Linimasa terlipat.
- **Editor F3 (4):** tab Teks. **F4a (4):** tab Tata letak + "Lihat sumber" (FrameGizmo/SplitGizmo dipakai ulang, dialog dihapus). **F5 (4):** Audio, Logo, Cold open.
- **i18n M8a (4):** provider editor (+ `I18nProvider` RA), `aria.editor.*`, `editor.{shell,transcript,text,layout,audio,logo,coldOpen,advanced}`, `errors.editor.*` (07 §15).
- Semua di balik `POTONGIN_EDITOR_SHELL=legacy|v2` (default `legacy` sampai fase lulus).

**Dependensi:** Fase 1, RF-M5a (Fase 7). F3, F4a, F5 paralel setelah F1.

**Kriteria terima**
- [ ] Tepat satu `tabpanel` terlihat; Teks terbuka saat editor dibuka; Lanjutan default tertutup dengan ringkasan di judul.
- [ ] Hitungan kontrol per tab tercatat di `docs/editor/evidence/control-count.json` (`editor-control-count.spec.mjs`); tugas umum ≤ 3 klik, lanjutan ≤ 5 (tabel `06-editor.md` §10, diuji `editor-click-budget.spec.mjs`); klik tab aktif tidak menutup panel.
- [ ] Tidak ada pemilih Cepat/Lengkap di layar shell `v2`; `?mode=`/`?card=` dialihkan tanpa error konsol; pada 1366×768 tidak ada scroll halaman saat editor dibuka.
- [ ] Gate per sub-fase: F0 `editor-ui-kit`, `editor-css-collisions`, `focus.spec`, kontras, forced-colors per komponen; F1 `editor-shell`, `editor-views.spec` → `editor-layout-shell.spec.mjs` **(baru)**, `editor-disclosure.spec.mjs` **(baru)**, `editor-control-count.spec.mjs` **(baru)**, `editor-click-budget.spec.mjs` **(baru)**, unit `editor-disclosure`, `editor-url-state`, `editor-store` (`readEditorFlags.shell`), `editor-clip-nav`, `read-only`, `editor-first-frame`, `editor-shortcuts`, PF-PLAY (0 drop di cut; ≤ 1 per 10 dtk), PF-SEEK (≤ 50 ms p95), ambang `docs/editor/GATES.md`; F2 `editor-transcript`, `editor-cleanup`, `editor-spelling`, `editor-quick-lines.spec` → `editor-lines.spec.mjs` **(baru)**, `editor-scrubber`, `editor-markers`, `editor-acceptance`; F3 `editor-quick.spec` dilebur ke spec per tab, `editor-caption-gizmo`, `editor-apply-all`, `parity-text`; F4a `editor-framing`, `editor-split`, `editor-layout`, `editor-zoom`, P-PLATE; F5 `editor-music`, `editor-logo`, `editor-nudge`, `editor-transition`, P-LOGO, P-JOIN, G-WHOOSH, P-AUD.
- [ ] `parity-text` dan screenshot `id` tidak berubah; `content-language-isolation` hijau.
- [ ] Screenshot 1366×768 dan 1920×1080; di ≥ 1440 px transkrip di samping pratinjau, di bawahnya ditumpuk; label rasio mengikuti `doc.output`.
- [ ] Pindah tab lewat keyboard; fokus kembali ke pemicu setelah Popover/Drawer.

**Pengguna merasakan:** editor satu layout di balik flag (pemilik dulu).
**Rollback:** `POTONGIN_EDITOR_SHELL=legacy`.

### Fase 11 · Editor II + rilis English (≈ 64,5)

**Isi**
- **F4b (≈ 15):** UI `layout.ranges` (skema dok 04 §A6), strip shot, `ShotPopover`, command `SetShotMode`/`ResetShot`/`ResetAllShots`, override `origin:user` (3 mode); apply-all grup layout mengecualikan `ranges`.
- **F6 segmen ganda (12):** N body awal 8, ditetapkan PF-SEG; antar-body `cut_fade_ms`; durasi 3–300 dtk untuk jumlah body; aturan cold open terhadap body pertama keluaran.
- **F7 klip turunan (12):** rinci `06-editor.md` §11.6: registri `analysis/derived-clips.json`, id dari `derived_clip_id` (`clip_id.py`), op `delete_derived_clip` (membatalkan render antre dan run terbit klip itu), `_clips` (Python, `src/ai_clipper/edit_v2/api.py:384`) dan `listJobClips` (JS) diperluas dengan tes paritas; di registri posting turunan dikenali lewat `listJobClips().derived` → `clip_kind='derived'`, `selection_keys_json = NULL` (dok 01 §4.5), sehingga dikeluarkan dari profil performa.
- **F8 (8):** ukuran "Asli · 720p" (skala di akhir rantai, ASS tidak berubah, tanpa R10), ekspor semua, Popover antrean; **Terbitkan** lewat `PublishDrawer` (hanya `render_id` yang lolos `verify.py`, ekspor `completed`).
- **F9 tablet + ponsel (8):** tablet 768–1023; ponsel tinjau setelah PF di ponsel (JASSUB).
- **F10 (4):** hapus `web/components/editor/quick/`, `web/components/editor/rail/`, `ViewSwitch.jsx`, `FramingDialog.jsx`, `SplitDialog.jsx` (bila belum di F4a), `web/lib/editor/view-mode.mjs`; hapus/tulis ulang tes yang mengunci kode itu (`web/tests/editor-view-mode.test.mjs`, `editor-quick-model.test.mjs`, `editor-mode-cepat-scaffold.test.mjs`, `web/e2e/editor-lengkap.spec.mjs` dilebur); hapus flag `POTONGIN_EDITOR_SHELL` dari `compose.yaml`, `.env.example`, `deploy-env-contract`; perbarui `docs/editor/PANDUAN-EDITOR.md`; stopwatch pemilik U1–U10.
- **i18n M8b (5); M9 (0,5):** `POTONGIN_LOCALES=id,en` di produksi, proyek `en-smoke` masuk `run_read_only_e2e`.

**Dependensi:** Fase 10; Fase 8 untuk bagian Terbit; Fase 9 untuk tes "turunan tidak masuk profil".

**Kriteria terima**
- [ ] Golden plan semua fixture dokumen lama byte-sama (CONTRACTS §5.11 fixture).
- [ ] P-FRAME ≥ 2.000 frame untuk urutan mundur dan duplikat; P-TIME 0 mismatch; G-CLICK < −40 dBFS; PF-SEG (RSS < 3 GiB, waktu) menentukan N.
- [ ] P-ENC dengan fixture skala turun (720p) lolos ambang §8.3.
- [ ] Klip turunan muncul di proyek, Proyek → Klip, ZIP, dan posting; **tidak** di profil performa (`clip_kind='derived'`, `selection_keys_json = NULL`).
- [ ] Override `origin:user` bertahan setelah apply-all dan analisis ulang.
- [ ] Ratchet `i18n-hardcoded` = 0 di `components/editor/**`; `en-smoke` membuka editor dan ekspor.
- [ ] Stopwatch: U1–U8 tidak lebih lambat dari angka shell lama di `UJI-PENERIMAAN.md`; U9 ≤ 30 dtk, U10 ≤ 15 dtk sampai antre (06 §19).
- [ ] e2e 768 dan 375 px; antislop layoutmobile.
- [ ] Pemilik menyetujui copy `en` (tanda tangan di PR M9).
- [ ] `run_all.sh full` hijau.

**Tes:** `editor-commands`, `editor-history`, `editor-rebase`, `editor-export-flow`, `editor-timemap`; baru `editor-segments`, `editor-shots`, `derived-clips-route`, `renders-batch-route`, `renders-list-route` (unit, 06 §18.2), `editor-segments.spec`, `editor-merge.spec`, `editor-shots.spec`, `editor-export.spec`, `editor-publish.spec` (provider palsu `web/tests/support/fake-social-platform.mjs`), `tests/test_edit_v2_derived.py`, `web/tests/list-job-clips-parity.test.mjs` (dibuat Fase 8, diperluas dengan `derived-clips.json`); screenshot 768/375 di `editor-screens.spec.mjs`.

**Pengguna merasakan:** editor baru untuk semua; segmen ganda, gabung klip, 720p, ekspor semua, Terbitkan dari editor; **UI English tersedia untuk semua pengguna.**
**Rollback:** `POTONGIN_EDITOR_SHELL=legacy` (sampai F10 menghapus shell lama — setelah itu image); fitur dokumen adalah amandemen minor-0, server lama menolak dengan `range_invalid`/`unknown_key`; `POTONGIN_LOCALES=id` mematikan `en` tanpa rebuild.

### Fase 12 · Opsional (≈ 23 + kalender)

| Item | Hari | Syarat |
|---|---|---|
| SOS-M7 audit platform (verifikasi Google, audit TikTok Direct Post, Meta App Review + verifikasi bisnis) | 3 + kalender | Q7 |
| FB-M7 eksperimen angka di prompt rerank | 3 | Lolos gate FB-M3 + persetujuan pemilik |
| RF-M7 mode stage + caption per run | 5 | — |
| FETCH-M9 range-only | 12 | Hanya bila M0 go **dan** Q11 berubah (default: dilewati) |
| Efek warna editor | belum diestimasi | Gate S-COLOR/P-COLOR baru; Q12 |

---

## 5. Total estimasi

| Fase | Isi singkat | Hari-dev | Kalender kumulatif (1 dev, ≈ 20 hari-dev/bulan) |
|---|---|---|---|
| G0 | Gerbang pemilik | 0 (kalender) | — |
| 0 | Runtime, kontrak, pengukuran | 15,5 | ≈ 0,8 bln |
| 1 | Fondasi UI + i18n + shell | 20,5–23,5 | ≈ 1,8–2,0 |
| 2 | Buat klip, Detail, kode error/progres | 25,5–27,5 | ≈ 3,1–3,3 |
| 3 | Proyek, Pengaturan, Tren, Bantuan | 22–25 | ≈ 4,2–4,6 |
| 4 | Identitas | 12–14 | ≈ 4,8–5,3 |
| 5 | Kepemilikan ‖ reframe Python | 17–19 ‖ 14 | ≈ 6,3–6,9 (paralel dikerjakan sendiri) |
| 6 | Siap anggota ‖ reframe floor ‖ sosmed R0/R1 | 34–35 ‖ 8 ‖ 5 | ≈ 8,7–9,3 |
| 7 | Unduhan + Otomatis | 40 (+2 Kick) | ≈ 10,7–11,3 |
| 8 | Sosmed | 29–30 | ≈ 12,1–12,8 |
| 9 | Performa/Analitik | 26–27 | ≈ 13,4–14,2 |
| 10 | Editor I | ≈ 31 | ≈ 15,0–15,7 |
| 11 | Editor II + rilis `en` | ≈ 64,5 | ≈ 18,2–19,0 |
| — | Cadangan integrasi lintas fase | 20 | ≈ 19,2–20,0 |
| **Total inti** | | **≈ 384–399 (+2 Kick)** | **≈ 19–20 bulan** |
| 12 | Opsional | ≈ 23 + kalender | — |

**Rincian per sumber (cocok dengan jumlah tabel di atas):**

| Sumber | Hari-dev |
|---|---|
| Roadmap fitur (sesudah review, tanpa cadangan, termasuk +1 migrasi settings) | 195,5–199,5 |
| Cadangan integrasi | 20 |
| Dashboard (F0–F10) | 50–61 |
| Editor | 81 |
| i18n (jumlah tabel milestone) | 46 |
| Dedupe: X1 −2, X3 −4, Fase 9 −2,5, X5 0 | −8,5 |
| **Total** | **384–399** |

Catatan: MU-M3, FETCH-M3, RF-M2 historis bisa meleset 30–50%; cadangan 20 hari dipakai di sana dulu, dan pemakaiannya dicatat di PR.

---

## 6. Critical path

1. **Anggota bisa diundang** (G0 → 0 → 1 → 2 → 3 → 4 → 5 → 6):
   - satu developer, termasuk jalur paralel RF-M1/M2 (14), RF-M3/M4 (8), SOS-M1 (5): **≈ 174–187 hari-dev (≈ 8,5–9,5 bulan)**;
   - jalur Python/sosmed dikerjakan agen paralel: **≈ 147–160 hari-dev (≈ 7–8 bulan)**;
   - lebih pendek lagi bila Fase 4–5 paralel dengan Fase 2–3. File tabrakan: `web/proxy.js`, `web/app/login/page.jsx`, `web/app/settings/page.jsx`, `web/lib/app-nav.mjs`, 49 route (`code`/`messageId` M2 lalu `secureRoute` MU-M3). Aturan: M2 merge dulu per route, MU-M3 rebase di atasnya; satu pemilik per file per fase.
2. **Posting publik:** kalender review platform (mulai G0) → Fase 8 → SOS-M7 (Fase 12). Tanpa audit, sosmed tetap privat/tester.
3. **Editor:** F4b → F6 → F7 berurutan (semuanya menyentuh `src/ai_clipper/edit_v2/doc.py` dan kompiler). Dengan 2–3 agen ≈ 45–50 hari untuk Fase 10–11.
4. **Rilis English (Q9 = b):** M0 (Fase 1) → M2/M3 (Fase 2–3) → M8 (Fase 10–11) → M9 di akhir Fase 11. Tidak ada di critical path anggota.
5. **Hotspot merge:** `web/lib/jobs.mjs`, `web/lib/primary-job-queue.mjs`, `web/scripts/run-job.mjs`, `src/ai_clipper/pipeline.py` (M5, FETCH-M3, FB-M3), `compose.yaml`, `deploy/production.sh`.

---

## 7. Tenggat keputusan

| Tenggat | Keputusan yang harus sudah ada | Status per 2026-10-24 |
|---|---|---|
| G0 | Q1 (amandemen, istilah), Q2 (dependensi), Q8 format jam, Q9 penulis copy `en` + bahasa awal | Q1, Q2, Q9 **final**; Q8 jam = default 24 jam |
| Sebelum Fase 4 | Q3 (akses, smoke, SMTP), Q6 (paket penghapusan) | default |
| Sebelum Fase 5 | Q4 (berbagi, cap LLM, cache lintas user), Q10 (Otomatis; skema sudah dikunci Fase 0) | default |
| Akhir Fase 3 | Q9 detail (landing/privasi/ketentuan `en`, default Bahasa video) | default; waktu rilis final = (b) |
| Sebelum Fase 6 | Q5 (kapasitas, kuota) | default |
| Sebelum Fase 7 | Q11 bagian unduhan (range-only, proxy, bgutil, Kick) | default |
| Sebelum Fase 8 | Q7 (sosmed), Q8 zona | default |
| Sebelum Fase 9 | Q11 bagian performa | default |
| Sebelum Fase 10 | Q12 (editor) | default |

Bila pemilik mengubah default setelah tenggat, implementer menulis delta estimasi di PR berikutnya sebelum mengerjakannya.

---

## 8. Gate dan strategi tes

### 8.1 Aturan umum

- Tes dulu; ambang tidak pernah dilemahkan; asersi regex atas source diganti asersi setara (view module atau role e2e), tidak dihapus.
- Lokal: hanya tes yang ditargetkan. CI: `ci-cd.yml` (setiap PR: lint, unit Node + pytest, build, `run_all.sh smoke`, e2e smoke), `editor-gates.yml` (`full` nightly/PR berisiko, `image`, `command`, `e2e`, `player`).
- Bukti gate (JSON angka saja) dilampirkan ke PR dari `$OUT/evidence/CI-<gate>.json`.

### 8.2 Gold benchmark (seleksi)

| Kapan | Apa | Cara | Lulus bila |
|---|---|---|---|
| Fase 2 (i18n M5) | Tambah `reason_codes`/`warning_codes`/`stage_code` | `python -m ai_clipper.benchmark --compare --selector v3-heuristic --json <out>` atas 7 pasangan gold (`docs/evaluation/gold/*.gold.json`) + transkrip (`artifacts/eval/<id>/yt/transcript.json`, pola `docs/evaluation/SELECTION_BENCHMARK.md`), sekali di basis `main` dan sekali di branch; dua JSON dibandingkan oleh `scripts/eval/compare_benchmark_runs.py` **(baru)** (CLI hari ini tidak punya mode sebelum/sesudah) | Klip terpilih, urutan, skor identik; manifest hanya bertambah field |
| Fase 7 (FETCH-M3) | Audio asli (AAC/Opus) dan paralel | Episode eval + benchmark | Klip sama dengan batas ≤ 200 ms; gold tidak berubah, atau dijalankan ulang dan dilaporkan di `SELECTION_BENCHMARK.md` sebelum merge |
| Fase 9 (FB-M3) | `order_boost` performa | `scripts/eval/performance_gate.py` (baru, di-commit) | Gate 1 byte-identik (7 episode + 5 replay, request sha256) vs `main` setelah Fase 7; Gate 2; Gate 3 (Hits@5/10 −≤1, Trap@10 tidak naik, floor fokus identik, efek dilaporkan, bar ≥ 20%); held-out sekali |
| Setiap perubahan seleksi setelah Fase 9 | — | Jalankan ulang Gate 1 | Sama |

### 8.3 Parity render

Ambang diambil dari `docs/editor/GATES.md` dan **tidak diubah**:

| Gate | Ambang | Dijalankan |
|---|---|---|
| P-TIME (FFmpeg + sisi JASSUB) | 0 mismatch transisi | Fase 0 (toolchain), setiap PR (smoke), Fase 10–11 |
| P-TXT (server dan browser/JASSUB) | SSIM ≥ 0,999, PSNR ≥ 45 dB, max ≤ 16, 0 px > 16 | Fase 0, 10 (F3 tab Teks), 11 |
| P-COLOR | \|Δ\| ≤ 4 | Fase 0; efek warna (Fase 12) butuh gate baru |
| S-COLOR | aturan `cheapest_passing` (`scripts/parity/s_color.py`) tetap memilih `gbrp` yang lolos P-TXT, P-COLOR, P-ENC | Fase 11 F4b dengan 2–3 `layout.ranges`; efek warna (Fase 12) |
| P-ENC | SSIM whole ≥ 0,990, text ≥ 0,980; turun > 0,002 dari baseline = gagal | Fase 0 (Node 24); Fase 11 F8 dengan fixture skala turun 720p |
| P-RT / R10 | framemd5 + PCM md5 identik; R10 100% hard link | Fase 0; setiap perubahan render |
| P-FRAME | 0 mismatch, ≥ 2.000 frame | Fase 5–7 (kasus auto), Fase 11 (urutan mundur, duplikat) |
| P-PLATE | plate SSIM ≥ final − 0,002; crop x 0 px | Fase 5–7, Fase 10 F4a, Fase 11 F4b |
| P-JOIN / P-JOIN-B, G-WHOOSH, G-CLICK (< −40 dBFS) | per GATES.md | Fase 7, Fase 10 F5, Fase 11 F6 |
| P-AUD, P-LOGO (max ≤ 8 di area logo) | per GATES.md | Fase 10 F5 |
| G-DET | 0 beda digest plan/ASS/graf; preview ASS = export ASS | Fase 5–7 (CPU 1 dan 4), 11 |
| PF-RENDER | p50 ≤ 0,4×, p95 ≤ 0,6× real time | Fase 7 (auto), 11 |
| PF-PIPELINE | fit-blur/center ≤ 1,35×, face-track ≤ 1,6× (per job, `scripts/parity/look_report.py`) | Fase 7, sebelum keputusan default Otomatis. **Status hari ini: gagal** (`docs/editor/GATES.md`: center-crop dan face-track di atas anggaran), karena itu Otomatis tetap opt-in (Q10) dan RF-M6 melaporkan angka ini tanpa melonggarkan ambang |
| PF-SEG (baru) | RSS < 3 GiB `RLIMIT_AS`; waktu dicatat; menentukan N body | Fase 11 F6 |
| Pin non-auto | camera plan byte, graf/plan sha/plate key, `RENDER_SEMANTICS` 2 | Fase 5–7 |
| `content-language-isolation` | plan, ASS, `render_key`, argv/env anak identik sesi `id` vs `en` | Fase 1 → 11 (setiap PR) |
| `parity-text` | hanya di locale `id` | Fase 1 → 11 |

### 8.4 a11y

| Cek | Alat | Sejak |
|---|---|---|
| Token, kontras AA (teks 4,5:1, kontrol 3:1), tanpa kata versi/"Selection V3"/`engine_fallback`, palet Tailwind ditolak | `web/tests/ui-guards.test.mjs` | Fase 1 |
| Target 44 px (`.button`, tab, item menu/listbox, close) | `ui-foundation` + e2e | Fase 1 |
| forced-colors | `editor-ui-kit`, e2e emulasi `forced-colors: active` | Fase 1, 10 |
| Skip link, live region (progres, toast), `role="alert"` login | e2e `app-shell`, `focus` | Fase 1–2 |
| Nama aksesibel: di `id` tolak "Close", "Clear search", "Dismiss", "Select all", "Previous", "Next", "Calendar", "Remove", "Loading"; di `en` tolak kata Indonesia umum; glosarium di allowlist | e2e `aria-names.spec.mjs` (baru) + `heroui-default-labels` | Fase 1 |
| Pintasan satu tombol bisa dimatikan; aktif hanya bila fokus bukan di field dan tanpa overlay | `editor-shortcuts`, e2e `app-shell` | Fase 1, 10 |
| Fokus kembali ke pemicu (Menu, Modal `?klip=N`, Drawer, Popover) | e2e | Fase 1, 2, 10 |
| 360 px tanpa scroll horizontal (`id` dan `en`); editor 1366×768 | e2e screenshot | Fase 2, 10 |

### 8.5 Matriks route keamanan

Matriks route (peran, guard, kepemilikan per route) dimiliki dok 02 §8; bagian ini hanya menetapkan cara mengujinya.

**Statis — `scripts/security/route_matrix.py` (sudah ada, diperluas di Fase 6 MU-M4b):**
- Memindai `web/app/api/**/route.js`, mengambil method yang diekspor dan penanda guard (`secureRoute(...)`, `requireUser`, `sameOriginMutation`, `selfAuth`).
- Membandingkan dengan `scripts/security/route_policy.json` (baru; isinya diturunkan dari tabel dok 02 §8.1–§8.2), satu entri per route: `{path, methods[], auth: "public"|"session"|"self"|"token", owner: "job"|"user"|"none", role: "any"|"admin", sameOrigin: true|false, reason?}`. `reason` wajib untuk `public` dan `self`.
- Gagal bila: route tanpa entri; method tanpa guard; `public` di luar daftar matcher `web/proxy.js`; route mutasi tanpa `sameOrigin`.
- Route publik/self-auth yang diharapkan: `api/health`, `api/auth/login`, `api/locale` (public); `api/jobs` (upload), `api/jobs/[id]/assets`, `api/settings/logo`, `api/settings/youtube-cookies` (self); `api/ingest/trends` (token). Ditambah sejak Fase 6: `api/auth/invite/accept`, `api/auth/reset/complete` (public, token di body, rate limit + anti-enumerasi; tautan reset dibuat admin lewat `POST /api/admin/users/[userId]/reset-link`, dok 02 §6.4/§8.2); Fase 8: callback OAuth (public, state `oauth_pending`), media publik bertanda tangan (token).
- Mencakup `/api/settings/download-network` (Fase 7) dan `app/api/social/**` (Fase 8).

**Dinamis — `web/tests/ownership-matrix.test.mjs` (baru, Fase 5):**
- Dimensi: setiap route × method × aktor {anonim, pemilik, anggota lain, admin tanpa opt-in, user smoke} × sumber daya {milik sendiri, milik orang lain, tidak ada}.
- Harapan: milik orang lain ≡ tidak ada → **404 identik** (status, seluruh body termasuk `code`/`messageId`, header kecuali `Date`); anonim → 401 (API) / redirect (halaman); nol spawn Python (spy `python-cli`); admin tidak punya akses implisit.
- Baris peran: "Tentang sistem", storage global, `/api/health` rinci → hanya admin.

**Lainnya:** `route-guard-coverage` (gerbang statis Node, allowlist beralasan; dibuat Fase 1, penuh Fase 5), `authorize-sync-contract`, `security-routes`, `request-security`, `proxy-matcher` (exclusion + halaman publik exact-path, termasuk `/api/locale` sejak Fase 1), `security-child-env` + `owner-env` (tanpa key LLM env/secret/`POTONGIN_DB_PATH` di env anak anggota), `deploy-env-contract` (env **dan** mount), `social-fake-origin-gate`, redaksi token/proxy/`ptk_`, `security-auth-fuzz`, Python `tests/test_security_media_probe.py`, `tests/test_security_protocol_whitelist.py`, `tests/test_fetch_platforms.py` + `web/tests/source-url.test.mjs` (baru, dok 02 §13.1: HLS/concat dalam `.mp4` ditolak; setiap argv ffmpeg/ffprobe di `src/ai_clipper/` memuat `-protocol_whitelist file,pipe`; URL privat ditolak, JS = Python).

### 8.6 Tes deploy dan rollback

| Tes | Isi | Fase |
|---|---|---|
| `tests/test_deploy_guard.py` (diperluas) | Kasus lama `active_jobs` tetap. Baru: (a) `running_jobs()` heredoc: job `queued` + request `queued` **tidak** dihitung, lease hidup/`running`/`claimed`/`rendering` dihitung, file tak terbaca tetap memblokir; (b) `rollback()` memuat `wait_social_health \|\| true`, dan `trap 'drain_off' EXIT` terpasang sebelum `wait_drained`; `drain_off` berupa `rm -f /data/jobs/.potongin-maintenance`; (c) `db-backup` (image baru, `compose run`) dipanggil setelah `wait_drained` dan sebelum `up -d`, `DB_BACKUP=` tercetak, gagal → berhenti sebelum container diganti; tidak ada `require_quiescent`/`require_no_running` sebelum `drain_on` (sejak Fase 6); (d) `run_read_only_e2e` memakai `E2E_SMOKE_USERNAME/PASSWORD`, bukan `APP_*`; (e) rollback dengan compose R1 + image tanpa label `potongin.social-worker` memakai `--scale social-worker=0`; compose baru + image ≥ R0 → rollback sukses, `wait_social_health \|\| true` tidak menggagalkan rollback; (f) rollback compose baru + image pra-Fase 4 (dok 01 §5.2); (g) `verify_runtime_identity` gagal bila salah satu dari empat container restart > 0 | 4, 6 |
| `web/tests/deploy-env-contract.test.mjs` (baru) | Setiap flag di `.env.example` ada di service yang benar di `compose.yaml`; `POTONGIN_DB_PATH` dan mount `potongin_control` hanya di app/primary/social; render-worker tanpa `/control`; social-worker me-mount `clipper_data` hanya lewat `subpath: social` dan env-nya cocok allowlist dok 03 §3; `POTONGIN_SETTINGS_SECRET` `:?`; `pot-provider` tanpa `ports:` dan tidak tersambung ke app/render; `E2E_SMOKE_*` dipakai deploy (rinci dok 01 §11.1) | 4+ |
| `web/tests/env-example.test.mjs` (diperluas) | Semua flag baru §9.8 terdaftar | 1+ |
| Drill lama→baru→lama (CI, `editor-gates.yml suite=command`) | Volume fixture: image N−1 → N (migrasi + bootstrap) → N−1 (login `APP_*`, job lama terlihat) → N; termasuk compose baru + image lama | 6 (MU-M9) |
| Restore backup | `db-backup.mjs` → `db-restore.mjs` offline (dok 01 §7.3) → `integrity_check` = `ok` → app boot dengannya; `web/tests/db-restore.test.mjs` | 4 |
| Drain | Job `running` + job `queued` → `drain_on` → `running_jobs` kosong setelah selesai, `queued` tetap, UI "Antre · Pemeliharaan"; timeout → deploy berhenti **sebelum** `up -d`, pause dicabut | 6 |
| Social-worker R0/R1 | R0: compose tanpa service, `wait_social_health` = 0; R1: healthy ≤ 90 dtk, restart 0; rollback R1 → image pra-R0: scale 0 | 6 |
| Per flag | `POTONGIN_SOCIAL=off`, `POTONGIN_FETCH_*=off`, `POTONGIN_MEDIA_CACHE=off`, `POTONGIN_AUTO_REFRAME=off`, `POTONGIN_PERFORMANCE=off`, `POTONGIN_EDITOR_SHELL=legacy`, `POTONGIN_LOCALES=id` | 7–11 |
| `auto_layout_downgrade.py` | dry-run default; `--apply` menulis fit_blur; file auto R10 tetap | 6 |
| Reservation v2/v3 | dua arah (R1 baca v2/v3 tulis v2; R2 tulis v3; image R1 membaca v3) | 6 |
| `en-smoke` pasca-deploy | hanya setelah M9 | 11 |

### 8.7 Cek i18n

Definisi lengkap: `07-i18n.md` §14 (dokumen itu yang berlaku); tabel ini hanya peta fase.

| Tes | Gagal bila |
|---|---|
| `i18n-catalog` | Set file atau kunci beda antar-locale; pesan kosong; ICU gagal di-parse; argumen `{x}` beda; kategori plural salah; `.` di dalam segmen; kunci yatim |
| `i18n-usage` | `t("…")` tidak ada di katalog `id`; kunci dinamis di luar helper kode |
| `i18n-hardcoded` (ratchet, `@babel/parser`) | Teks JSX, `aria-label`/`placeholder`/`title`/`alt`/`label` literal, `toast("…")`, kalimat di view module; baseline per file hanya boleh turun |
| `i18n-intl-literal` | Locale literal di `Intl.*`/`toLocale*`/`localeCompare` di luar `web/lib/i18n/` dan `web/lib/content-text.mjs` |
| `i18n-registry` | `LOCALES` ≠ folder `web/messages/*`; default bukan `id`; flag memuat kode tak dikenal |
| `i18n-resolve` | Urutan `users.locale` > cookie > Accept-Language > `id` dilanggar; `in`≠`id`; q-value salah |
| `i18n-rsc-boundary` | `useTranslations` di file tanpa `"use client"` |
| `i18n-error-codes` | Kode tanpa `errors.<messageId>` di semua locale; `errors.edit.*` di `web/messages/id/errors.json` ≠ `_MESSAGES` |
| `locale-route` | Kontrak `POST /api/locale` (07 §9.2) dilanggar |
| `heroui-default-labels` | Literal `"aria-label": "…"` di `@heroui/react/dist` milik komponen terpakai tanpa wrapper |
| `content-language-isolation` | §8.3 |
| `help-catalog` | Kode baru (MU/sosmed/unduhan) tanpa entri Bantuan di semua locale |
| e2e `en-smoke` | `smoke`, `read-only`, `app-shell`, `aria-names`, Buat klip → `/projects/[id]`, buka editor, `editor-first-frame`; CI sejak Fase 1, pasca-deploy sejak M9 |

Pseudo-locale `qps` hanya di dev. Proyek `en-smoke` didefinisikan di `web/playwright.config.mjs` hanya bila `E2E_EN_SMOKE=1`.

### 8.8 UI, bundle, konkurensi

- `ui-foundation`: tidak ada `RouterProvider`; semua `editorHref(...)` dirender `<a>`; `ui.css` hanya diimpor dari `AppShell.jsx` + `components/ui/PublicCard.jsx` (05 §8.1); CSS editor hasil build identik (sampai Fase 10 mengamandemen).
- `licenses`: HeroUI, RAC, `@internationalized/date`, `tailwind-variants`, `tw-animate-css`, Tailwind, use-intl, `intl-messageformat`, `@formatjs/*`, `icu-minify`, `@schummar/icu-type-parser`.
- Bundle per rute vs baseline Fase 1 (editor: kenaikan hanya use-intl sampai Fase 10).
- Konkurensi: `queue-fairness`; crash matrix sosmed; scheduler jam manual (DST Pacific); cache dua proses, SIGKILL, EXDEV, symlink tanam; lease/cancel/delete/janitor/upload yang ada tidak berubah.

---

## 9. Perubahan deploy

Semua perubahan ada di `deploy/production.sh`, `compose.yaml`, `Dockerfile`, `.env.example`, dan dijaga `tests/test_deploy_guard.py` + `web/tests/deploy-env-contract.test.mjs` (baru). Fungsi yang sudah ada dan dipakai ulang: `active_jobs`, `require_quiescent`, `wait_http_health`, `wait_primary_health`, `verify_runtime_identity`, `run_read_only_e2e`, `rollback`. Isi compose per service (volume, env) dimiliki dok 01 §5.1, dok 02 §12.1, dok 03 §3/§6.8, dok 04 §0.2; dokumen ini memiliki urutan dan fungsi skrip deploy.

### 9.1 Alur `production.sh` akhir (setelah Fase 6)

```bash
# variabel baru
SOCIAL_CONTAINER=${SOCIAL_CONTAINER:-ai-video-clipper-social-worker}
DRAIN_TIMEOUT_SECONDS=${DRAIN_TIMEOUT_SECONDS:-1800}

compose_has_service() { docker compose -p "$COMPOSE_PROJECT" config --services | grep -qx "$1"; }

# preflight yang sudah ada (DEPLOY_SHA, checkout bersih, .env, compose config) tetap
# TIDAK ada cek "harus kosong" di awal: job yang sedang berjalan ditunggu oleh drain, bukan menolak deploy
previous_image=…; docker tag … "ai-video-clipper:${rollback_tag}"
IMAGE_TAG="$DEPLOY_SHA" docker compose … build app   # build di luar pause: admission tidak tertahan selama build
drain_on                      # Fase 6: tulis penanda (container lama)
trap 'drain_off' EXIT         # penanda selalu dihapus, sukses atau gagal
wait_drained                  # gagal (timeout) → exit 1 SEBELUM up -d (tidak perlu rollback)
backup_control_db             # Fase 4 (dok 01 §7.1): image baru, setelah drain; gagal → exit 1 sebelum up -d
deployed=1; trap rollback ERR
IMAGE_TAG="$DEPLOY_SHA" docker compose … up -d --no-build --remove-orphans
wait_http_health
wait_primary_health
wait_social_health            # Fase 6 R0: no-op bila service belum ada
verify_runtime_identity       # 3 atau 4 container + cek mount /control (§9.6)
run_read_only_e2e             # kredensial smoke (Fase 4); + en-smoke (M9)
require_no_running            # penanda masih ada, jadi tidak ada klaim baru; e2e read-only tidak boleh memulai kerja
trap - ERR; deployed=0        # lalu EXIT → drain_off
```

Sebelum Fase 6, `require_quiescent` lama tetap dipakai di awal dan akhir (tanpa drain); `backup_control_db` (Fase 4) dijalankan setelah `require_quiescent` awal, sebelum `up -d`. Urutan ini sama dengan dok 02 §12.2 (build → drain → backup → up → health → e2e → `drain_off`).

### 9.2 Backup DB (Fase 4)

Kontrak `web/scripts/db-backup.mjs` (argumen, pola nama `potongin-<ts>-<reason>.sqlite` + `settings-<ts>-<reason>.tar`, retensi 14 per reason, exit code, `db-restore.mjs` offline) dimiliki dok 01 §7. Sisi `production.sh`:

```bash
backup_control_db() {
  IMAGE_TAG="$DEPLOY_SHA" docker compose -p "$COMPOSE_PROJECT" run --rm --no-deps --entrypoint node app \
    scripts/db-backup.mjs --reason deploy      # mencetak DB_BACKUP=<path>|none dan SETTINGS_BACKUP=<path>
}
```

Exit ≠ 0 (DB tidak terbuka, `integrity_check` gagal, ruang kosong kurang) → deploy berhenti sebelum container diganti; `drain_off` jalan lewat trap EXIT. Restore hanya lewat `db-restore.mjs` dengan app/primary/social berhenti (runbook dok 01 §7.3).

### 9.3 Mode drain (Fase 6, MU-M7b)

Kontrak (penanda `JOBS_ROOT/.potongin-maintenance` berisi `{"version":1,"since","reason":"deploy"|"manual","sha"}`, batas umur 6 jam, `POTONGIN_ADMISSION_PAUSE` di app + primary-worker + render-worker, `web/lib/maintenance-mode.mjs`, `web/scripts/maintenance.mjs on|off|status`, state machine `normal → draining → drained → normal`, perilaku tiap komponen selama pause, `queue.held:"maintenance"` → "Antre · Pemeliharaan") dimiliki `02-multiuser-keamanan.md` §10.5 dan tidak diulang di sini. Bagian ini hanya merinci sisi `production.sh`. Penanda ada di volume `clipper_data` (`/data/jobs/.potongin-maintenance`), jadi terlihat render-worker yang tanpa `/control`; `active_jobs()` hari ini melewati entri non-direktori, jadi aman. Tes: `web/tests/maintenance-mode.test.mjs` **(baru)**, kasus di `tests/test_render_worker.py`, `tests/test_deploy_guard.py`.

**Fungsi di `production.sh`:**
```bash
running_jobs() { docker exec -i "$APP_CONTAINER" python - <<'PY'
# salinan active_jobs(), dibatasi ke pekerjaan berjalan:
#   job dihitung bila queue.lease masih hidup (expiresAt > now) atau status running;
#   request render dihitung bila state claimed/rendering;
#   job/request queued TIDAK dihitung (tahan restart);
#   job.json / request yang tak terbaca tetap dihitung (memblokir), seperti hari ini.
PY
}
require_no_running() { local s; s=$(running_jobs); printf 'DURABLE_RUNNING=%s\n' "$s"; [ "$s" = "[]" ]; }
drain_on() {
  if docker exec "$APP_CONTAINER" test -f scripts/maintenance.mjs; then
    docker exec "$APP_CONTAINER" node scripts/maintenance.mjs on --reason deploy --sha "${DEPLOY_SHA:0:12}"
  else
    require_quiescent          # deploy pertama yang membawa MU-M7b: image lama belum punya skrip
  fi
}
drain_off() { docker exec "$APP_CONTAINER" rm -f /data/jobs/.potongin-maintenance || true; }   # rm polos: jalan di image mana pun
wait_drained() { local end=$((SECONDS + DRAIN_TIMEOUT_SECONDS));
  until require_no_running; do [ $SECONDS -ge $end ] && { echo "Drain timed out" >&2; return 1; }; sleep 10; done; }
```
Catatan:
- `drain_on` memakai container **lama** (image N−1); `drain_off` memakai container yang sedang hidup (baru, atau image rollback). Karena `drain_off` hanya `rm -f`, ia tetap bekerja setelah rollback ke image yang belum mengenal penanda.
- Build dikerjakan **sebelum** `drain_on` supaya admission tidak tertahan selama build (sama dengan dok 02 §10.5/§12.2).

### 9.4 `social-worker` R0/R1 (Fase 6, SOS-M1)

Isi rilis, service compose (`cpus: 0.5`, `mem_limit: 512m`, `read_only`, mount `potongin_control:/control` + `clipper_data` **subpath `social`** → `/data/social`, env allowlist, healthcheck), dan heartbeat dimiliki dok 03 §3, §6.8, §12.2 (mount juga dok 01 §5.1). Perubahan `production.sh`, label `Dockerfile`, dan kasus `test_deploy_guard.py` dimiliki dokumen ini (dirujuk dok 02 §12.2 dan dok 03 §12.2/§12.5):

| Rilis | Image | Compose | `production.sh` |
|---|---|---|---|
| **R0** | Berisi `web/scripts/social-worker.mjs` + `check-social-worker-health.mjs` + migrasi `0003-social-base.sql`; `Dockerfile` menambah `LABEL potongin.social-worker="1"` | Tanpa service | `SOCIAL_CONTAINER`, `wait_social_health` (no-op bila service tidak ada), `rollback()` memanggil `wait_social_health \|\| true` |
| **R1** (≥ 1 deploy setelah R0 sukses) | Sama | Service `social-worker` (dok 03 §6.8) | `verify_runtime_identity` memeriksa 4 container; cek versi Docker Compose ≥ 2.23 dan Engine ≥ 26 untuk `volume.subpath`, dan `/data/social/media` dibuat app sebelum R1 (dok 01 §5.1); rollback ke image tanpa label → `--scale social-worker=0` (di bawah) |

```bash
wait_social_health() {
  compose_has_service social-worker || return 0
  local attempt status
  for attempt in $(seq 1 45); do
    status=$(docker inspect "$SOCIAL_CONTAINER" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' 2>/dev/null || echo missing)
    [ "$status" = healthy ] && return 0
    [ "$status" = unhealthy ] && { echo "Social worker became unhealthy" >&2; return 1; }
    sleep 2
  done
  echo "Social worker health check timed out" >&2; return 1
}
```
- Health: baris `process_heartbeats` role `social` + file `/tmp/social-worker-health.json` tiap 10 dtk, juga saat `POTONGIN_SOCIAL=off`; aturan sehat di dok 03 §6.8.
- `rollback()`: bila compose punya `social-worker` dan `docker image inspect ai-video-clipper:${rollback_tag} --format '{{index .Config.Labels "potongin.social-worker"}}'` ≠ `1` → `up -d --no-build --remove-orphans --scale social-worker=0`; selain itu `up -d --no-build --remove-orphans` biasa; lalu `wait_http_health || true; wait_primary_health || true; wait_social_health || true`; `drain_off` jalan lewat trap EXIT setelah `exit`. Run `scheduled` tetap di DB dan diproses lagi setelah maju (dok 03 §12.5).
- Pola sama untuk `pot-provider` (Fase 7): profil `pot`, tidak aktif default, jadi aman.

### 9.5 E2E pasca-deploy

- **Fase 4:** `run_read_only_e2e` memakai `-e E2E_USERNAME="${E2E_SMOKE_USERNAME:?}" -e E2E_PASSWORD="${E2E_SMOKE_PASSWORD:?}"`. `E2E_SMOKE_*` juga masuk env service `app`, sehingga `start-app.mjs` membuat/memverifikasi user smoke saat boot (01 §10 langkah 5, logika sama dengan `admin-reset.mjs --ensure-smoke-user`; user `is_smoke`, peran member, proyek kosong). `deploy-env-contract` menolak `APP_USERNAME` di fungsi itu.
- **Fase 11 (M9):** `-e E2E_EN_SMOKE=1` sehingga proyek `en-smoke` ikut jalan. Sebelum M9 tidak boleh (produksi `id` → rollback palsu).

### 9.6 `verify_runtime_identity`

- Tetap: volume `/data` = `${COMPOSE_PROJECT}_clipper_data`; restart count 0.
- Baru (Fase 4): app dan primary-worker punya mount `/control` = `${COMPOSE_PROJECT}_potongin_control`; render-worker **tidak** punya `/control` (dok 01 §5.1). Fase 6 R1: social-worker punya `/control` dan `/data/social` (subpath), tidak punya `/data/jobs`, restart 0. Cetak `CONTROL_VOLUME=…` dan `RESTART_COUNTS=0,0,0[,0]`.

### 9.7 `compose.yaml` per fase

| Fase | Perubahan |
|---|---|
| 1 | `app.environment.POTONGIN_LOCALES: ${POTONGIN_LOCALES:-id}` |
| 4 | Rinci dok 01 §5.1 + dok 02 §12.1: volume `potongin_control`; mount `/control` di `app`, `primary-worker`; env `POTONGIN_DB_PATH=/control/potongin.sqlite`, `POTONGIN_SETTINGS_DIR=/control/settings`, `POTONGIN_SETTINGS_SECRET` (wajib, `${…:?}`), `E2E_SMOKE_*` (app, dibaca `start-app.mjs`; juga dibaca deploy), `AUTH_TRUSTED_CLIENT_IP_HEADER`; `Dockerfile` `CMD` → `scripts/start-app.mjs`, `HEALTHCHECK --start-period=60s` |
| 6 | `POTONGIN_ADMISSION_PAUSE: ${POTONGIN_ADMISSION_PAUSE:-0}` di app + primary-worker + render-worker (dok 02 §10.5); `POTONGIN_MAX_SOURCE_SECONDS` di app (MU-M4b); `POTONGIN_PUBLIC_URL` di app (tautan undangan/reset); `PRIMARY_WORKER_CONCURRENCY` tetap; R1: service `social-worker` (dok 03 §6.8) |
| 7 | Flag unduhan/reframe per service menurut dok 04 §0.2; service `pot-provider` (profil `pot`, bridge sendiri, tanpa `ports:`, `read_only`, `cap_drop: [ALL]`, hanya tersambung ke primary-worker) |
| 8 | `POTONGIN_SOCIAL` di app + social-worker; `POTONGIN_PUBLIC_URL` dan `SOCIAL_*` di social-worker (dok 03 §3) |
| 9 | `POTONGIN_PERFORMANCE`, `POTONGIN_PERF_MIN_POSTS`, `POTONGIN_PERF_HORIZON` hanya di app + primary-worker; social-worker tidak menerima flag performa (allowlist dok 03 §3) |
| 10 | `POTONGIN_EDITOR_SHELL` di app |

### 9.8 Flag env

Ringkasan per fase untuk `env-example` dan `deploy-env-contract`; arti dan nilai sah tiap flag dimiliki dokumen yang disebut di kolom terakhir.

| Flag | Service | Default | Fase | Pemilik |
|---|---|---|---|---|
| `POTONGIN_LOCALES` | app | `id` | 1 | 07 §3 |
| `POTONGIN_DB_PATH` | app, primary, social | `/control/potongin.sqlite` | 4 | 01 §5.1 |
| `POTONGIN_SETTINGS_DIR` | app, primary, social | `/control/settings` | 4 | 01 §5.1 |
| `POTONGIN_SETTINGS_SECRET` | app, primary, social | wajib | 4–5 | 01 §5.1, 02 §9.2 |
| `E2E_SMOKE_USERNAME/PASSWORD` | app (+ deploy) | wajib | 4 | 02 §12.1 |
| `AUTH_TRUSTED_CLIENT_IP_HEADER` | app | kosong | 4 | 02 §12.1 |
| `PRIMARY_WORKER_CONCURRENCY` | app, primary | `1` | ada | Q5 |
| `POTONGIN_ADMISSION_PAUSE` | app, primary, render | `0` | 6 | 02 §10.5 |
| `POTONGIN_PUBLIC_URL` | app (Fase 6), social (Fase 8) | kosong (wajib bila sosmed ≠ `off`) | 6/8 | 02 §12.1, 03 §3 |
| `POTONGIN_MAX_SOURCE_SECONDS` | app, primary | `14400` | 6 | 02 §11.2, 04 §0.2 |
| `POTONGIN_SOCIAL` | app, social | `off` | 6/8 | 03 §3 |
| `SOCIAL_PIN_KEEP_DAYS`, `SOCIAL_UPLOAD_CONCURRENCY`, `SOCIAL_YT_DAILY_UNITS`, `SOCIAL_YT_METRICS_UNITS` | social | `7` / `2` / `10000` / `1000` | 8 | 03 §3 |
| `POTONGIN_AUTO_REFRAME` | app, primary, render | `off` (release 1), `on` (release 2, setelah pemilik setuju) | 6/7 | 04 §0.2 |
| `POTONGIN_FETCH_AUDIO_FIRST`, `_SECTIONS` | primary | `off` | 7 | 04 §0.2 |
| `POTONGIN_FETCH_TWITCH`, `_KICK` | app, primary | `off` | 7 | 04 §0.2 |
| `POTONGIN_MEDIA_CACHE` / `_BYTES` / `_TTL_DAYS` | app, primary | `off` / `4294967296` / `3` | 7 | 04 §0.2 |
| `POTONGIN_POT_PROVIDER_URL` | primary | kosong | 7 | 04 §0.2 |
| `POTONGIN_PERFORMANCE` / `_PERF_MIN_POSTS` / `_PERF_HORIZON` | app, primary | `off` / `20` / `7d` | 9 | 03 §3 |
| `POTONGIN_EDITOR_SHELL` | app | `legacy` → `v2`, dihapus di F10 | 10–11 | 06 §17 |

### 9.9 Boot pertama image multi-user (Fase 4) dan urutan migrasi

Urutan resmi = dok 01 §10 (`scripts/start-app.mjs`) dan dok 02 §14; ringkasnya:

1. `production.sh` menjalankan backup (`DB_BACKUP=<path>` atau `none`).
2. App boot: validasi env → pindah settings (01 §5.2) → migrasi (idempoten, satu transaksi per file; `0001` di Fase 4).
3. Bila `users` kosong: admin dari `APP_USERNAME/APP_PASSWORD` (`is_bootstrap=1`), `meta.bootstrap_owner_id` diisi.
4. User smoke dibuat atau diverifikasi bila `E2E_SMOKE_*` ada.
5. Sejak Fase 6: impor `ingest-tokens.json` beserta hash; logo/watermark default disalin ke `users/<bootstrap>/`.
6. Tidak ada `job.json` yang ditulis ulang. Job tanpa `ownerId` dimiliki `bootstrap_owner_id`.
7. Opsional: `web/scripts/multiuser-migrate.mjs --dry-run|--apply` mengisi `ownerId` + `fairnessKey` job terminal di bawah queue lock.

Hanya `app` yang menjalankan migrasi; primary-worker dan social-worker memanggil `requireSchema` (coba ulang tiap 2 dtk, maks 60 dtk, lalu exit 78 → healthcheck gagal → rollback; 01 §2.4).

### 9.10 Matriks rollback

| Lapisan | Mekanisme | Catatan |
|---|---|---|
| Image multi-user → single-user | Image lama mengabaikan DB, `ownerId`, `fairnessKey`, penanda maintenance | Semua job terlihat login env; `APP_*` tetap valid |
| Skema DB | Hanya aditif | Jangan rollback melewati migrasi contract |
| Settings | Salin ke `/control/settings` + penanda; `/data/settings` beku sampai `--purge-legacy-settings` (01 §5.2) | Image lama + compose baru membaca `/control/settings`; image lama + compose lama membaca salinan beku; setelah purge, image pra-Fase 4 hanya dengan compose baru |
| Reservation | v3 lewat R1 lalu R2 | Diuji dua arah; rollback ke sebelum R1 dilarang selama reservation v3 hidup (≤ 60 menit, 02 §10.2) |
| Cookie sesi | Proxy menerima v1 dan s2 | Break-glass `admin-reset.mjs --admin` |
| Sealing | Kotak v1 tetap terbaca | Ganti secret → akun sosmed status reauth |
| Drain | `drain_off` di trap EXIT (`rm -f`, jalan di image mana pun); penanda > 6 jam diabaikan | Manual: `node scripts/maintenance.mjs off` atau hapus `/data/jobs/.potongin-maintenance` |
| Sosmed | `POTONGIN_SOCIAL=off` + `up -d`; R1 → image pra-R0 otomatis `--scale social-worker=0` | Matriks lengkap dok 03 §12.5 |
| Reframe | `POTONGIN_AUTO_REFRAME=off` | Di bawah floor: `auto_layout_downgrade.py` |
| Unduhan | `POTONGIN_FETCH_*`/`POTONGIN_MEDIA_CACHE=off` | `link` hanya platform baru; cache bukan pemilik tunggal byte |
| Performa | Toggle / `POTONGIN_PERFORMANCE=off` | Tanpa profil byte-identik |
| i18n | `POTONGIN_LOCALES=id`; image lama mengabaikan cookie dan `users.locale` | Error aditif, `error` string tetap |
| Editor | `POTONGIN_EDITOR_SHELL=legacy` | Amandemen minor-0 ditolak server lama |
| Backup DB | `VACUUM INTO` + tar settings, simpan 14 per reason (01 §7.1); restore offline `db-restore.mjs` | `integrity_check` di drill |

### 9.11 Runbook deploy multi-user (`docs/operations/PENGGUNA.md`, baru)

Isi runbook dimiliki dok 02 §12.3 (dan dok 01 §7.3 untuk restore); ringkas:

1. Isi `POTONGIN_SETTINGS_SECRET` (salin dari `APP_SESSION_SECRET` **sebelum** deploy Fase 4; kotak v1 tetap terbaca).
2. Isi `E2E_SMOKE_USERNAME/PASSWORD` (sandi acak ≥ 20 karakter) dan `AUTH_TRUSTED_CLIENT_IP_HEADER`.
3. Merge ke `main` → deploy otomatis (build → drain → backup → up → health → e2e smoke → `drain_off`).
4. Verifikasi: login pemilik, cookie v1 ter-upgrade, `DB_BACKUP=` tercetak, `CONTROL_VOLUME=` benar.
5. Cek manual pemilik; ganti sandi pemilik; `admin-reset.mjs --purge-legacy-settings`; jalankan checklist undangan pertama (Fase 6).
6. Penghapusan pengguna: hanya user nonaktif tanpa proyek; kosongkan proyek lewat transfer (tulis ulang `ownerId` di bawah queue lock) atau hapus per proyek (`job-deletion.mjs`, konfirmasi ketik), satu baris audit per proyek; hook menjalankan `disconnectAll`, purge sosmed, hapus data performa.

---

## 10. Risiko teratas

| # | Risiko | Mitigasi | Fase |
|---|---|---|---|
| 1 | Input anggota tak tepercaya (HLS/concat dalam `.mp4`, yt-dlp ke host internal) dan IDOR di 49+ route | MU-M4b **sebelum** undangan; `route_matrix.py`; `ownership-matrix`; `secureRoute owner:'job'` default | 5–6 |
| 2 | Layering CSS/HeroUI merusak editor; navigasi klien tanpa COEP | `@layer` di Fase 1, tanpa `RouterProvider`, CSS editor identik, parity + screenshot | 1, 10 |
| 3 | Rollback otomatis gagal (social-worker, kredensial smoke, `en-smoke`) | R0/R1 + label image + `--scale 0`; `wait_social_health`; smoke user Fase 4; `en-smoke` pasca-deploy baru M9; drill | 4, 6, 11 |
| 4 | Deploy terblokir job aktif begitu ada anggota | Drain §9.3 + runbook | 6 |
| 5 | Guard auth jadi async → semua route 503 | `authorize-sync-contract`, driver DB sinkron | 4 |
| 6 | Graf render > 3 GiB (Otomatis, N body, saklar per shot) | Spike RF-M2; satu skema `layout.ranges` sejak Fase 0; PF-SEG; override 3 mode | 5, 11 |
| 7 | Disk produksi 81% (cache, pin, backup, plate baru Node 24) | Ukur di Fase 0; cap 4 GiB; admission ruang kosong; pin yatim dihitung; backup 14 | 0, 4, 7, 8 |
| 8 | Review platform dan kuota YouTube | SOS-M0 + pendaftaran sejak G0; mode `admin`; `FILE_UPLOAD`; jatah per user; pesan jujur | G0, 8 |
| 9 | i18n: locale bocor ke konten, error mematahkan klien/agen, churn ±1.400 literal, bundle editor | Error aditif; `content-language-isolation`; kunci dibuat saat layar ditulis ulang; ratchet; root hanya `IntlProvider` | 1–11 |
| 10 | Kebocoran key LLM env ke anggota | `owner-env`, `security-child-env`, cap harian | 5 |
| 11 | Satu secret menyegel semua token | AAD per akun+purpose, file 0600, self-check, runbook ganti secret | 5, 8 |
| 12 | Kontaminasi AGPL | Nama clean-room §5.59–§5.69; katalog `en` dari katalog `id` + glosarium; spot-check reviewer di `web/lib/social/providers/*`, `edit_v2/shots.py`, `fetch/*`, `web/messages/en/**` | semua |
| 13 | "Satu layout" disalahartikan jadi semua alat tampil | §1.1 dikunci sebagai kriteria terima + hitungan kontrol + stopwatch U1–U10 | 10–11 |
| 14 | Skala ≈ 400 hari-dev, bentrok merge | Tiap fase bisa dikirim/rollback sendiri; satu pemilik per file; cadangan 20; opsional dipisah | semua |

---

## 11. Celah yang belum terselesaikan

Hanya item yang benar-benar masih terbuka. Perbedaan lama yang sudah ditutup (drain build-sebelum-`drain_on`/penanda 6 jam/pause di render-worker — kini di dok 02 §10.5; kunci fairness — kini `job.json` `fairnessKey`; katalog dan kontrak `/api/locale` — kini mengikuti dok 07; cookie pintasan `on|off`; `layout.ranges` `{in_sf, out_sf}`; kode kuota `user_storage_quota`; backup sesudah `wait_drained` lewat `compose run`; settings salin + penanda; mount subpath social-worker; nama tes MU-M4b) tidak dicantumkan lagi.

1. **Kalender audit platform** (2–6+ minggu per platform) di luar kendali; posting publik tidak dijanjikan dalam total hari-dev.
2. **Kick** (+2 hari) bergantung go/no-go FETCH-M0; **efek warna editor** belum diestimasi (Fase 12).
3. **Kuota storage** (Q5) default kosong = tidak dibatasi; sampai admin mengisi, satu-satunya rem disk adalah admission ruang kosong global (`web/lib/storage-admission.mjs`).
4. **Ambang PF-SEG** (selain RSS < 3 GiB) belum ada di `docs/editor/GATES.md`; usulan dok 06 §13 (VmPeak ≤ 2,6 GiB, waktu ≤ 1,6×) dikunci setelah pengukuran CI pertama di PR Fase 11 F6, lalu tidak boleh dilonggarkan.
5. **Gold benchmark butuh transkrip yang tidak ada di git.** Gold label ada di `docs/evaluation/gold/` (7 file), tetapi transkrip/sound-events (`artifacts/eval/<id>/…`) di-ignore. Sebelum Fase 2 M5: pemilik menyediakan artefak itu ke runner (artifact CI terenkripsi atau volume self-hosted), atau benchmark dijalankan di mesin yang memilikinya dengan selector heuristik saja. Gate 1 Fase 9 (5 replay cache) punya kebutuhan sama.
6. **`volume.subpath` social-worker** butuh Docker Engine ≥ 26 / Compose ≥ 2.23 di VM; versi VM belum diverifikasi (dok 01 §12 butir 6). Bila kurang, R1 butuh keputusan pemilik soal mount penuh.
7. *(ditutup)* `scripts/security/route_policy.json` sudah tercantum di dok 02 §13.1 (MU-M4b).
8. **Selisih lintas dokumen:** tidak ada yang diketahui setelah pemeriksaan silang akhir 2026-10-24 ([00-README.md](00-README.md) §8); daftar "harus diubah" di 01–07 sudah dihapus. Bila dokumen pemilik berubah, dokumen pemilik yang berlaku dan bagian yang merujuknya di sini diperbarui di PR fase terkait.
9. **`shouldForceMount` di `Tabs.Panel` HeroUI v3** tidak tercantum di dokumentasi komponen; diverifikasi di spike Fase 1 F0, dengan cadangan render `hidden` (§4 Fase 3). Nama kelas/file HeroUI lain diverifikasi ulang terhadap 3.2.6 di spike yang sama (dok 05 G2).
