# 00 · Rombak Potongin: indeks rencana

- **Status:** Rancangan, belum diimplementasi
- **Tanggal:** 2026-10-24
- **Isi folder:** `00-README.md` (dokumen ini), spesifikasi `01`–`08`, referensi
  [09-referensi-supoclip.md](09-referensi-supoclip.md), dan `lampiran/` (draf perencanaan asli).

## 1. Tujuan

Rencana ini merombak Potongin dari alat satu pengguna menjadi aplikasi multi-pengguna yang
siap diundang. Isinya:

- akun, peran, dan rahasia per pengguna;
- dashboard baru (HeroUI v3, Tailwind v4);
- dua bahasa, ID dan EN;
- unduhan sumber dari link dan cache bersama;
- framing otomatis per shot ("Otomatis");
- posting dan jadwal ke YouTube, TikTok, dan Instagram;
- umpan balik performa ke pemilihan klip;
- editor satu tata letak.

Dokumen `01`–`08` adalah spesifikasi yang dipakai implementer. Draf di `lampiran/` hanya catatan
sejarah.

## 2. Status

| Hal | Keadaan per 2026-10-24 |
|---|---|
| Spesifikasi 01–08 | Rancangan lengkap, sudah diselaraskan satu sama lain (§8) |
| Kode | Belum ada yang diimplementasi |
| Keputusan pemilik | Q1, Q2, Q9 final; Q3–Q8, Q10–Q12 memakai default yang bisa diubah sampai tenggatnya (08 §7) |
| Langkah berikutnya | G0 (kerja pemilik), lalu Fase 0 (§9) |

## 3. Keputusan pemilik

Rincian dan tenggat perubahan ada di 08 §1 dan §7. "Default" = **(default, bisa diubah)**.

| # | Topik | Jawaban | Status |
|---|---|---|---|
| Q1 | Amandemen dan istilah | DESIGN.md/AGENTS.md diamandemen. Mode Cepat/Lengkap editor dihapus dan diganti pengungkapan bertahap (§4). Label Riwayat→Proyek, Konteks Tren→Tren, Menunggu→Antre. Satu "Ekspor tetap". Istilah publikasi **Terbitkan** (aksi) / **Terbit** (status) | **Final** |
| Q2 | Dependensi | Node 24 + `node:sqlite`; `@heroui/react@3.2.6` + Tailwind v4; `use-intl@4.14.9`; `@babel/parser` (dev) | **Final** |
| Q3 | Akses | Admin tidak membuka proyek orang lain; akun hanya lewat undangan; `APP_*` tetap sebagai login darurat; ada user smoke; tanpa SMTP, tautan disalin manual | Default |
| Q4 | Berbagi | Rantai LLM instans dibagi (`llm_share=true`), cap 200 unit AI/hari per anggota; key LLM env tidak dibagi; cookie YouTube global milik admin; tren instans + switch per anggota; cache unduhan `umum` lintas user hanya untuk unduhan tanpa cookie | Default |
| Q5 | Kapasitas | Concurrency 1 sampai diukur; per anggota 3 job aktif, 1 berjalan, 30 job/jam; sumber maks 4 jam; kuota storage kosong = tidak dibatasi | Default |
| Q6 | Hapus otomatis di luar `/data/jobs` | Satu paket: audit > 180 hari, sesi/undangan/reset kedaluwarsa, backup > 14, cache 4 GiB/3 hari, pin sosmed 1 jam/7 hari, aturan 30 hari YouTube | Default |
| Q7 | Sosmed | App milik pemilik per platform; mulai YouTube; mode `admin` sampai audit lolos; TikTok `FILE_UPLOAD`; batch ditunda; cap 100 aktif + 20/jam per user; kuota YouTube = jatah harian per user; hapus job membatalkan jadwal; file default = ekspor terbaru | Default |
| Q8 | Waktu | 24 jam di semua locale; zona perangkat disimpan di `users.time_zone`, nama zona ditampilkan; fallback `Asia/Jakarta` | Default |
| Q9 | Bahasa | `en` dirilis bersama fase editor (Fase 11, i18n M9); akhirnya ID **dan** EN; pratinjau `id,en` hanya sebelum ada anggota | **Final** (waktu rilis); detail lain default |
| Q10 | Otomatis | Opt-in sampai PF-PIPELINE diukur; override per shot 3 mode; "Pakai di semua klip" mengantrekan analisis | Default |
| Q11 | Unduhan dan performa | Range-only dilewati; tanpa proxy berbayar; bgutil opt-in; Kick mati; metrik = views 7 hari; toggle performa mati sampai retro dibaca; data performa privat per user | Default |
| Q12 | Editor | Gabung klip hanya dalam job yang sama, ≤ 20 menit; kehadiran tanpa kunci per klip; efek warna ditunda | Default |

## 4. Editor: tanpa mode, dengan pengungkapan bertahap

Q1 menghapus Mode Cepat/Lengkap. Itu **tidak** berarti semua alat tampil sekaligus. Editor punya
satu tata letak dengan aturan berikut (rinci di 06 §2, dikunci di 08 §1.1):

1. **Pratinjau dulu.** Yang selalu terlihat: top bar, pratinjau + transport, strip Segmen,
   transkrip, dan daftar Klip. Rel alat kiri dihapus. Linimasa detail terlipat.
2. **Satu panel kanan terbuka.** Tab Teks · Tata letak · Audio · Logo · Cold open; membuka satu tab
   menutup yang lain.
3. **"Lanjutan" terlipat.** Setiap tab menampilkan pilihan dasar. Kontrol halus ada di
   **Lanjutan**, tertutup secara default, dengan ringkasan ≤ 3 nilai di judulnya.
4. **≤ 3 klik untuk tugas umum, ≤ 5 untuk tugas lanjutan.** Dijaga tes hitungan kontrol, tes
   anggaran klik, dan stopwatch (06 §2.3, §10, §12).

## 5. Urutan baca

1. **00-README** (dokumen ini): keputusan, kepemilikan, fase.
2. **08 · Fase, test & deploy:** urutan kerja, kriteria terima, gate.
3. **01 · Arsitektur & data:** service, volume, DDL, migrasi, `job.json`.
4. **02 · Multi-user & keamanan:** syarat sebelum anggota pertama diundang.
5. **05 · UI dashboard** dan **07 · i18n:** fondasi UI dan bahasa, dikerjakan sejak Fase 1.
6. **04 · Reframe & unduhan**, **03 · Sosmed & performa**, **06 · Editor:** baca sesuai fase yang
   dikerjakan.
7. **09 · Referensi SupoClip:** baca setelah §10 di bawah.

## 6. Kepemilikan dokumen

Kalau dua dokumen berbeda, **dokumen pemilik yang berlaku**. Dokumen lain merujuk bagian pemilik
dan tidak mendefinisikan ulang.

| Dokumen | Pemilik dari |
|---|---|
| [01-arsitektur-data.md](01-arsitektur-data.md) | **Semua DDL SQL**; penomoran migrasi `0001`–`0007`; nama dan tipe kolom (waktu `*_at` INTEGER ms UTC); volume `potongin_control` → `/control`; field `job.json` (`ownerId`, `fairnessKey`, `limits.maxSourceSeconds`, …); backup/restore; urutan boot; runtime Node 24 |
| [02-multiuser-keamanan.md](02-multiuser-keamanan.md) | Auth, sesi, peran; API identitas dan admin (method, path, body, error); matriks route; `secureRoute` dan kepemilikan; hardening input tak tepercaya; drain mode dan jeda admission saat deploy; rahasia per user (`seal`/`open`) dan berbagi |
| [03-sosmed-performa.md](03-sosmed-performa.md) | API sosmed dan analitik/performa; state machine `publish_runs` dan nama state; scheduler dan `social-worker`; kode `social_*`/`performance_*`; profil performa |
| [04-reframe-unduhan.md](04-reframe-unduhan.md) | Skema `layout.ranges` (CONTRACTS §5.63); shot plan; command editor per shot (`SetShotMode`, `ResetShot`, `ResetAllShots`); fetch/cache/`source-url`; kode error unduhan |
| [05-ui-dashboard.md](05-ui-dashboard.md) | Layar, navigasi, fondasi UI (CSS layers, alias HeroUI); cookie preferensi UI; kata status yang tampil. Memakai API 02/03 persis |
| [06-editor.md](06-editor.md) | UX editor; perubahan `edit_v2`; klip turunan; CONTRACTS §5.66–§5.69 |
| [07-i18n.md](07-i18n.md) | Katalog `web/messages/<locale>/<namespace>.json`; kontrak `POST /api/locale`; penamaan kunci (`meta.<rute>.title`/`.description`); pemetaan kode error → `messageId` → teks; locale dan zona waktu |
| [08-fase-test-deploy.md](08-fase-test-deploy.md) | Urutan fase, estimasi, gate, dan perubahan skrip deploy; detail lain merujuk pemilik di atas |

## 7. Ringkasan fase dan estimasi

Angka = hari-dev satu developer (08 §5). "‖" = jalur paralel yang bisa dikerjakan agen lain.

| Fase | Isi singkat | Hari-dev | Kalender kumulatif (≈ 20 hari-dev/bulan) |
|---|---|---|---|
| G0 | Gerbang pemilik: merge PR UX, amandemen dokumen, daftar app platform | 0 (kalender) | — |
| 0 | Runtime Node 24, kontrak, pengukuran | 15,5 | ≈ 0,8 bulan |
| 1 | Fondasi UI + i18n + shell + pemilih bahasa | 20,5–23,5 | ≈ 1,8–2,0 |
| 2 | Buat klip, Detail proyek, kode error/progres | 25,5–27,5 | ≈ 3,1–3,3 |
| 3 | Proyek, Pengaturan, Tren, Bantuan | 22–25 | ≈ 4,2–4,6 |
| 4 | Fondasi identitas (DB, login, settings pindah) | 12–14 | ≈ 4,8–5,3 |
| 5 | Kepemilikan dan rahasia per user ‖ reframe Python | 17–19 ‖ 14 | ≈ 6,3–6,9 |
| 6 | Siap untuk anggota ‖ reframe floor ‖ sosmed R0/R1 | 34–35 ‖ 8 ‖ 5 | ≈ 8,7–9,3 |
| 7 | Unduhan sumber + Otomatis menyala | ≈ 40 (+2 bila Kick) | ≈ 10,7–11,3 |
| 8 | Posting dan jadwal sosmed | 29–30 + kalender audit | ≈ 12,1–12,8 |
| 9 | Umpan balik performa dan Analitik | 26–27 | ≈ 13,4–14,2 |
| 10 | Editor I: shell dan tab | ≈ 31 | ≈ 15,0–15,7 |
| 11 | Editor II + rilis English | ≈ 64,5 | ≈ 18,2–19,0 |
| — | Cadangan integrasi lintas fase | 20 | ≈ 19,2–20,0 |
| **Total inti** | | **≈ 384–399 (+2 Kick)** | **≈ 19–20 bulan** |
| 12 | Opsional (audit platform, efek warna, eksperimen) | ≈ 23 + kalender | — |

Critical path (08 §6):

- **Anggota pertama bisa diundang** setelah Fase 6: ≈ 174–187 hari-dev untuk satu developer,
  atau ≈ 147–160 bila jalur Python/sosmed dikerjakan paralel.
- **Undangan dilarang** sebelum MU-M4b (hardening input, Fase 6 langkah 1) hijau.

## 8. Pemeriksaan silang akhir (2026-10-24)

Setelah tiap dokumen diselaraskan sendiri, kedelapan dokumen diperiksa bersama. Yang dicek:

- DDL di luar 01;
- nama tabel dan kolom, timestamp `*_ms` di SQL, nomor migrasi;
- path dan method API;
- nama state posting, kode error, format path katalog;
- nomor CONTRACTS §5.6x;
- id fase/milestone dan total estimasi.

Hasilnya:

- **03 kembali mengikuti DDL 01.** Pemeriksaan sebelumnya mengubah 01 dan 03 bersamaan sehingga
  keduanya bertukar nama. Nama yang berlaku adalah milik 01:
  - kolom `publish_runs`: `next_attempt_at`, `scheduled_tz`, `connection_label`, `upload_box` (sesi
    unggah tersegel) dan `error_params_json`;
  - `posts.error_code`;
  - `metric_snapshots.age_hours` dan `aggregate_json`;
  - `users.perf_use_in_selection`;
  - `pkce_verifier_box`;
  - bucket kuota = id koneksi;
  - putus akun = **baris koneksi dihapus** (bukan status `revoked`);
  - audit callback Meta = `social.data_deleted`.
- **API dan kode:**
  - body terbit `media:{kind:'export', renderId}` di 05 dan 06 (milik 03 §9.1);
  - preferensi akun = satu route `GET/PATCH` dengan `trendsEnabled?`/`timeZone?` (02 §8.2);
  - form terima undangan memuat `locale` (02 §6.3);
  - error form connect sosmed = 303 `?hasil=gagal` (03 §7.1);
  - kode DST `social_time_nonexistent` (03 §8) di 05 dan 07;
  - `GET /api/performance/template.csv` masuk 02 §8.2;
  - prop `onRequestExport` untuk `PublishDrawer` tercatat di 03 §6.7 dan 05 §6.5.
- **Tambahan ke 01:**
  - kode audit `cache.cleared` dan `download_network.changed` (dari 04);
  - field `job.json` `limits.maxSourceSeconds`, `fetch` dan `source.type="link"`.
- **i18n:**
  - namespace `layout` dan kode tahap `stage.reframe`/`stage.fetch_*` masuk 07 §7.1;
  - `status.detail.ownerDisabled` (dari 05 §5) masuk 07;
  - kolom zona jadwal `scheduled_tz`;
  - "Needs review" untuk `status.detail.check`.
- **08:**
  - `preparePerformanceProfile` dipindah ke `primary-worker.mjs`;
  - flag performa tidak lagi di `social-worker`;
  - hook hapus job ditaruh di route, bukan di `job-deletion.mjs`.
- **Daftar "dokumen lain harus diubah"** di 01 §12, 02 §17, 03 §19, 04 Bagian D, 05 §10.2, 06 §20,
  07 §19.2 dan 08 §11 diganti catatan "selesai". Yang tersisa di sana hanya isu terbuka (§11).

Hal yang sudah konsisten di semua dokumen:

- tidak ada `CREATE TABLE`/`ALTER TABLE` di luar 01;
- satu-satunya kolom `*_ms` adalah durasi (`duration_ms`);
- nama migrasi `0001-identity` … `0007-performance` sama di mana pun;
- CONTRACTS §5.59–§5.65 dialokasikan di PR kontrak Fase 0 dan §5.66–§5.69 di PR kontrak Fase 10;
- total 08 (≈ 384–399) cocok dengan rincian per sumber.

## 9. Memulai Fase 0 di PC lain

### 9.1 Ambil rencana

```bash
git clone <url-repo-potongin> ai-video-clipper   # atau git fetch di clone yang ada
cd ai-video-clipper
git fetch origin
git checkout docs/rombak-spec
```

Rencana ada di `docs/plans/2026-10-24-rombak/`. Baca `AGENTS.md`, `DESIGN.md`, dan
`docs/HANDOFF.md` dulu.

### 9.2 Prasyarat

| Alat | Versi / catatan |
|---|---|
| Node.js | **24** (Q2; MU-M0 memindah image dan CI ke Node 24) |
| Docker + Compose | Engine **≥ 26** / Compose ≥ 2.23 supaya `volume.subpath` untuk `social-worker` bisa diuji (01 §5.1) |
| uv | untuk Python 3.11 (`uv run pytest tests/<file>`) |
| ffmpeg / ffprobe | untuk tes yang ditargetkan dan pengukuran lokal ringan |
| gh CLI | untuk menjalankan `editor-gates.yml` di GitHub Actions |
| gitleaks | scan dengan config `main` sebelum setiap push |

Di PC pemilik hanya tes yang ditargetkan. Suite penuh, build image, FFmpeg/parity, dan Playwright
dijalankan di GitHub Actions (`gh workflow run editor-gates.yml -f ref=<branch> -f suite=…`).

### 9.3 G0 (kerja pemilik, sebelum Fase 0)

- [x] PR `feat/ux-redesign-workspace` di-merge ke `main` (#30).
- [ ] PR docs-only "amandemen G0" disetujui. PR ini mengubah:
  - `DESIGN.md`: editor satu tata letak, kata status, bagian Bahasa;
  - `AGENTS.md`: copy dari katalog, protokol clean-room, migrasi aditif;
  - `docs/glosarium.md` (baru).

  Teks persisnya ada di 06 §18.1, 05 §9.1 dan 07 §17.
- [ ] Q1, Q2, Q9 tercatat final; Q8 format 24 jam tercatat.
- [ ] **Daftarkan app Google (YouTube Data API), TikTok (Login Kit + Content Posting API), dan Meta
  (Instagram API with Instagram Login) dalam mode testing sekarang.** Verifikasi dan audit platform
  makan 2–6+ minggu dan ada di jalur kritis posting publik. Checklist lengkap: 03 §11.6.
- [ ] Pilih domain HTTPS publik dan email kontak publik (tidak ditulis di repo).

### 9.4 Fase 0 (15,5 hari-dev, rinci 08 §4)

| Milestone | Hari | Isi |
|---|---|---|
| MU-M0 Node 24 | 2,5 | Pin `node:24-bookworm-slim@sha256`, CI ke Node 24, `engines`, stamp toolchain (`ci-cd.yml -f suite=toolchain` + `record.json` di-commit), aturan stderr `node:sqlite` (01 §8) |
| FB-M0 | 2 | Bekukan `resources/performance/rules.v1.json`; minta contoh CSV ke pemilik |
| SOS-M0 | 3 | `docs/operations/SOSMED.md`: verifikasi semua angka **[V]** platform beserta sumber resmi |
| FETCH-M0 | 3 | `docs/evaluation/UNDUHAN_M0.md`: ukur audio-first, bgutil, proxy, Kick; go/no-go |
| RF-M0 | 4 | Harness eval reframe, ±40 jendela berlisensi, gate ditulis sebelum test split |
| PR kontrak | 1 | CONTRACTS §5.59–§5.65 (termasuk `fairnessKey` dan `layout.ranges` dari 04 §A6) |

Fase 0 selesai bila:

- `ci-cd.yml` dan `editor-gates.yml suite=full` hijau di Node 24, dan `run_all.sh toolchain`
  (lewat `ci-cd.yml -f suite=toolchain`) lolos tanpa melonggarkan ambang, dengan `record.json`
  baru di-commit;
- invalidasi plate/render key tercatat dan R10 terbukti (klip tanpa edit tidak dirender ulang);
- stderr pipeline bersih dari peringatan `node:sqlite`;
- go/no-go FETCH-M0 tertulis;
- baseline reframe dilaporkan;
- PR kontrak di-merge (termasuk persetujuan pemilik untuk `fairnessKey`, §11 #1);
- disk produksi diukur dan dicatat (baseline 81%).

## 10. Aturan clean-room

SupoClip berlisensi AGPL-3.0. Potongin tetap bebas dari AGPL selama tidak ada kode SupoClip yang
masuk. Aturannya:

- **Dilarang:**
  - menyalin atau memparafrase dekat kode, markup, CSS, string UI, nama modul, atau konstanta
    SupoClip;
  - memakai screenshot SupoClip sebagai aset;
  - membuka file SupoClip berdampingan dengan file Potongin saat mengetik.
- Semua nama di rencana ini ditulis dari kontrak Potongin (`social_connections`, `publish_runs`,
  `oauth_pending`, `readPostStats`, `/data/cache-unduhan`).
- Katalog `en` diterjemahkan dari katalog `id` + glosarium, bukan dari teks pihak lain.
- Setiap PR mencantumkan baris `Rujukan: rencana 2026-10-24-rombak + kode Potongin`. PR yang
  menyentuh `web/messages/en/` juga mencantumkan "Sumber copy: messages/id + glosarium".
- Keputusan pemilik (2026-10-24): docs, screenshot, dan kode SupoClip **boleh dibaca untuk memahami
  perilaku** (09 §1): baca → tutup → tulis catatan perilaku dengan kata sendiri → implementasi dari
  spec dan kode Potongin. Menyalin atau memparafrase dekat kode, markup, string, konstanta, nama
  modul, atau screenshot tetap dilarang. Amandemen AGENTS.md di G0 memakai aturan ini.

## 11. Isu terbuka

Isu yang benar-benar masih terbuka di semua dokumen, sudah digabung bila duplikat. **Pemilik** =
butuh jawaban atau tindakan pemilik. Yang lain diputuskan lewat pengukuran atau saat implementasi.

| # | Isu | Dokumen | Diputuskan di |
|---|---|---|---|
| 1 | Penyimpangan lokasi `fairnessKey` (di `job.json`, bukan render request) perlu disetujui | 01 §6.2, §12 | **Pemilik**, di PR kontrak Fase 0 |
| 2 | Apakah `node:sqlite` mencetak peringatan di stderr Node 24 terpin (Fase 0 menguji `import "node:sqlite"` polos; varian `web/lib/db/index.mjs` di Fase 4) | 01 §8.3, 08 Fase 0 | MU-M0 |
| 3 | Rate limit login/undangan/reset in-memory; butuh tabel bila `app` lebih dari satu replika | 01 §12, 02 §17 | Saat app diskalakan |
| 4 | Biaya 20 unit AI per job masih tebakan | 01 §12, 02 §17 | MU-M4, sebelum cap menyala |
| 5 | Docker Engine VM produksi ≥ 26 untuk `volume.subpath`; bila kurang, mount `/data` penuh butuh persetujuan **pemilik** | 01 §12, 08 §11 | Sebelum R1 (Fase 6) |
| 6 | Isolasi jaringan yt-dlp dari `app:3000` hanya lewat DNS pre-check + allowlist extractor | 02 §17 | 04 / FETCH |
| 7 | Login darurat mengabaikan status `disabled` (alternatif: hanya lewat CLI) | 02 §17 | **Pemilik**, sebelum Fase 4 |
| 8 | Nama extractor yt-dlp, perilaku `--use-extractors` (tes nyata: URL non-platform ditolak sebelum unduh), plugin bgutil, digest `pot-provider`, codec audio-first | 02 §17, 04 D | MU-M4b, FETCH-M0 |
| 9 | Angka platform **[V]** (unit `videos.insert`, batas TikTok, scope Instagram, endpoint rupload, aturan 30 hari dan agregat turunan YouTube) | 03 §19, 01 §12 | SOS-M0 |
| 10 | Header CSV ekspor YouTube/TikTok/Instagram Studio belum diketahui | 03 §19 | **Pemilik** memberi contoh |
| 11 | Resumable upload Instagram untuk Reels; bila tidak ada, URL publik + pengecualian WAF | 03 §19 | SOS-M0 |
| 12 | Drift `hookForm` proposal vs hook final (ambang 2%) | 03 §19 | FB-M2 |
| 13 | Field rentang sumber dokumen editor untuk `edit_distance` | 03 §19 | Implementasi FB-M2 |
| 14 | Batch posting berjarak ditunda | 03 §19 | Q7, fase berikut |
| 15 | Jatah YouTube per user bisa jadi 1 unggahan/hari bila pengguna YouTube aktif > 5 | 03 §19 | Audit kuota Google |
| 16 | Teks `/privasi`, `/ketentuan`, email kontak publik | 03 §19 | **Pemilik**, sebelum Fase 8 |
| 17 | Scope cache unduhan vs cookie YouTube global (scope `umum` jarang terisi) | 04 D | **Pemilik**, sebelum Fase 7 |
| 18 | Kesetaraan `fill_center` dengan crop camera ber-x tengah | 04 D | Spike RF-M2 |
| 19 | Nama kelas/sub-komponen/path HeroUI dan `Tabs.Panel shouldForceMount` diverifikasi terhadap 3.2.6 | 05 G2, 06 §20, 07 §19.1, 08 §11 | Spike F0 (Fase 1) |
| 20 | Nilai `--overlay-shadow` dan `--disabled-opacity` yang lolos kontras | 05 G5 | Spike F0 |
| 21 | Teks persetujuan musik TikTok (kutipan wajib platform) | 05 G12 | SOS-M0 |
| 22 | Tombol pintasan **Pisah** | 06 §20 | Uji bentrok browser |
| 23 | Ambang PF-SEG (VmPeak ≤ 2,6 GiB, waktu ≤ 1,6×) | 06 §20, 08 §11 | CI pertama Fase 11 F6 |
| 24 | Pelonggaran V8 (`keyframes` + `ranges`); default tetap dilarang | 06 §20, 04 §A6 | Amandemen §5.63 tersendiri |
| 25 | Kehadiran hanya per pengguna (tidak ada berbagi proyek) | 06 §20 | Bila berbagi proyek ditambahkan |
| 26 | Jumlah 33 pembaca `body.error` dan 49 route belum dihitung ulang | 07 §19.1 | PR M2 |
| 27 | Daftar lengkap `stage_code`/`reason_codes` | 07 §19.1 | PR M5 |
| 28 | Default "Bahasa video" untuk UI `en` | 07 §19.1 | **Pemilik** (default: tidak berubah) |
| 29 | Kunci `aria.editor.*` dan kunci `editor.*` per tab | 07 §19.1 | PR M8a |
| 30 | Kalender audit platform 2–6+ minggu; posting publik tidak dijanjikan | 08 §11, 03 §11.6 | Kalender platform |
| 31 | Go/no-go Kick (+2 hari); efek warna editor belum diestimasi | 08 §11 | FETCH-M0; Fase 12 |
| 32 | Kuota storage default kosong; satu-satunya rem disk = admission ruang global | 08 §11 | **Pemilik**, setelah jumlah user diketahui |
| 33 | Transkrip gold benchmark tidak ada di git | 08 §11 | **Pemilik** menyediakan artefak, sebelum Fase 2 M5 |

**Jumlah: 33 isu terbuka**, 9 di antaranya menunggu pemilik: #1, #5, #7, #10, #16, #17, #28, #32, #33.
Isu clean-room (dulu #34) sudah diputuskan: lihat §clean-room dan 09 §1.

## 12. Lampiran

`lampiran/` berisi draf perencanaan asli:

- `draf-00-ROADMAP-MASTER.md`: roadmap induk + Koreksi akhir KA1–KA26;
- `draf-01-fitur-roadmap.md` dan `draf-01-fitur-review.md`;
- `draf-02-ui-dashboard.md`;
- `draf-03-editor.md`;
- `draf-04-i18n.md`.

Semua draf itu **sudah digantikan** oleh 01–08. Simpan hanya sebagai jejak asal keputusan. Bila
sebuah draf berbeda dengan 01–08, yang berlaku adalah 01–08.
