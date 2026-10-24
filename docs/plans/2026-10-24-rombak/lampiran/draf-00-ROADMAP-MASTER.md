## Koreksi akhir

Yang dicek: rencana 01 + review (16 poin), 02 (K1–K31), 03 (1–24), dan rencana i18n (K1–K23). Saya juga mengecek ulang ke kode Potongin: `web/proxy.js:38`, `compose.yaml` (`clipper_data:/data` di tiga service), `web/lib/layout-names.mjs`, `web/lib/dashboard-choices.mjs`, dan `app/layout.jsx:23`. Hasilnya: `web/lib/source-url.mjs`, `web/lib/status-words.mjs`, dan `web/app/akun` belum ada. `-protocol_whitelist` baru dipakai di 6 file Python. Jumlah per fase dan per rencana sumber dihitung ulang dengan tangan.

| # | Severity | Masalah | Perbaikan |
|---|---|---|---|
| KA1 | **Tinggi** | Rincian total di §1 tidak cocok dengan jumlahnya: 205–215 + 50–61 + 81 + 46 − 15 = 367–388, padahal tertulis 385–400. Ada tiga sebab. (1) Angka "205–215" dari review sudah termasuk cadangan, lalu §4 menambah baris cadangan 20 lagi. (2) Dedupe yang diklaim 15, padahal yang nyata hanya 8,5: X1 −2, X3 −4, Fase 9 −2,5, dan X5 0, karena RF-M5a 4 + F4b 15 = RF-M5 9 + F4b 10. (3) Label *(perkiraan dedupe)* di X5 menyesatkan. | Rincian yang benar: roadmap fitur tanpa cadangan **195,5–199,5** (termasuk +1 migrasi settings) + cadangan integrasi **20** + dashboard **50–61** + editor **81** + i18n **46** − dedupe **8,5** = **384–399** (+2 kalau Kick go). Angka ini cocok dengan jumlah tabel fase. X5 diberi tanda dedupe 0. |
| KA2 | **Tinggi** | Critical path "anggota bisa diundang ≈ 150 hari-dev (±7–8 bulan)" tidak menghitung jalur paralel. Untuk **satu developer**, RF-M1/M2 (14), RF-M3/M4 (8), dan SOS-M1 (5) tetap harus dikerjakan sendiri. | Satu developer: **≈ 174–187 hari-dev (≈ 8,5–9,5 bulan)**. Kalau jalur paralel dikerjakan agen lain: ≈ 147–160 hari-dev (≈ 7–8 bulan). |
| KA3 | **Tinggi** | Urutan dependensi salah. MU-M4b (Fase 6) memakai `--use-extractors` allowlist "dari `source-url.mjs`", padahal file itu baru dibuat di FETCH-M1 (Fase 7) dan belum ada di repo. | Inti `web/lib/source-url.mjs` + `fetch/platforms.py` (allowlist YouTube saja, fixture `tests/fixtures/fetch/urls.json`) dipindah ke MU-M4b (+1). FETCH-M1 turun 5 → 4 dan menambah Twitch/Kick. |
| KA4 | **Tinggi** | i18n M7 seluruhnya ada di Fase 8, padahal ia mencakup namespace `admin` dan audit berbasis kode. Halaman admin dibangun di Fase 6, dan `audit_events` mulai ditulis di Fase 4–6. Akibatnya halaman admin lahir tanpa kunci, dan baris audit berisi prosa lalu butuh migrasi. Selain itu namespace `analytics` dijadwalkan di Fase 8, padahal Analitik baru dibangun di Fase 9. | M7 dipecah: **M7a** (1,5) di Fase 6: `admin`, `account`, audit `code+params` sejak baris pertama, undangan/reset. **M7b** (2) di Fase 8: `social`, `users.time_zone`, DatePicker berzona, status posting, `email.*`. **M7c** (0,5) di Fase 9: `analytics`. |
| KA5 | **Tinggi** | i18n M6 (Fase 4) menulis "Bahasa di `/akun`", padahal `/akun` baru dibangun di Fase 6 (MU-M5). | **M6a** (1) di Fase 4: kolom, sinkron login ↔ cookie, `/api/locale` menulis DB. **M6b** (0,5) di Fase 6: field Bahasa di `/akun`. |
| KA6 | **Tinggi** | Model per shot bertentangan. X5 membolehkan "Layar terbagi per shot dari engine", sedangkan editor 03 §5.5 menyimpan `layout.ranges` `origin: auto\|user` dengan 3 mode dan menolak split bersama ranges. Skemanya juga baru ditetapkan di Fase 11, padahal kompiler auto (RF-M2, Fase 5) dan RF-M5a (Fase 7) sudah membangun data modelnya. Akibatnya kompiler harus dirombak dua kali. | Skema `layout.ranges` ditetapkan di §5.63 pada PR kontrak Fase 0. Aturannya: `split` boleh muncul di range hanya kalau `origin:auto` dan hanya kalau spike RF-M2 lolos. Override pengguna (`origin:user`) hanya camera/fill_center/fit_blur. `layout.mode: split` (seluruh klip) tidak boleh dipakai bersama ranges. RF-M2 mengompilasi ranges. Editor 4b hanya UI + override. |
| KA7 | Sedang | Root layout memasang `<I18n>` = `IntlProvider` + `I18nProvider` React Aria. Ini memasukkan use-intl dan react-aria ke bundle rute editor sejak Fase 1, sehingga bertentangan dengan kriteria "bundle editor tidak berubah" dan dengan semangat `ui-foundation`. | Root hanya memasang `IntlProvider` (use-intl). `I18nProvider` React Aria tinggal di `components/ui/Providers.jsx` (AppShell/login) dan di kit editor sejak Fase 10. Kriteria Fase 1 diubah menjadi: CSS editor identik, kenaikan JS editor ≤ ukuran use-intl dan tercatat. |
| KA8 | Sedang | G0 meminta pemilik menjawab "Q1–Q5". Padahal Q9 (bahasa awal, penulis copy `en`) dan format jam dari Q8 dibutuhkan M0/M1 di Fase 1. Sebaliknya Q5 (kapasitas) baru dibutuhkan di Fase 6. Pertanyaan lain juga belum diberi tenggat. | Ditambahkan tabel tenggat keputusan per fase (§7). |
| KA9 | Sedang | Banyak kriteria selesai dari roadmap 01 hilang. **F4:** skema baru diterima kode lama; read-only/smoke dengan anggota smoke berproyek kosong; `sessionFromCookieStore` untuk 3 halaman server + `parity-fixtures`. **F5:** admin tanpa opt-in tetap 404; job anggota selesai dengan heuristik; scan ≤ 15 dtk + 0,5 dtk/cut; md5 frame = pure chain; konteks filter tidak tumbuh; `multiuser-isolation.spec`. **F6:** CLI render-worker tanpa `POTONGIN_DB_PATH`; reframe agreement ≥ 85%; SPEAKER_FRAMING ≤ 21,7%; ≥ 8/10 klip split. **F7:** Twitch mempublikasikan `input/`; dua proses mengunduh sekali; sweep menolak path di bawah `JOBS_ROOT`; waktu sampai seleksi membaik untuk sumber ≥ 30 menit; render edit-v2/legacy tidak berubah. **F8:** `deferred` tidak menghabiskan percobaan; tes `final-files` tidak berubah; drill `POTONGIN_SOCIAL=off`. **F9:** floor fokus identik; paritas kunci Py/JS; bar efek ≥ 20%. | Semuanya dipulihkan di §3. |
| KA10 | Sedang | Beberapa pertanyaan pemilik hilang. Dari roadmap: Q3 (cache video publik lintas user), Q8 (klip yang diedit jauh, privasi data performa, sikap kalau "tidak ada efek"), Q9 ("Pakai di semua klip" mengantrekan analisis), Q10 (cap 100 terjadwal / 20 per jam, pembagian kuota YouTube, hapus job membatalkan jadwal, file default). Dari i18n: Q3 (bahasa undangan). | Dipulihkan di Q4, Q7, Q9, Q10, dan Q11. |
| KA11 | Sedang | X12 mendaftar mode "Ikuti pembicara". Mode itu tidak ada: `layout-names.mjs` hanya punya Latar blur, Ikuti wajah, Potong tengah, dan Layar terbagi, sedangkan `RENDER_MODE_LAYOUTS` tidak memuat split. Layar terbagi tidak bisa dipilih saat Buat klip. | Pilihan di Buat klip: Ikuti wajah, Potong tengah, Latar blur, ditambah Otomatis sejak Fase 7. Layar terbagi hanya di editor. "Ikuti pembicara" dihapus (framing pembicara adalah bagian dari Otomatis). |
| KA12 | Sedang | `/api/locale` dikecualikan di `proxy.js`, tetapi belum masuk allowlist `route-guard-coverage` dan daftar route self-auth MU-M3 (4 → 5). Sejak M6a route ini menulis DB dan wajib memeriksa sesinya sendiri. Baris gate keamanan di §5 juga baru berlaku mulai Fase 4. | Ditambahkan ke MU-M3 dan gate. `proxy-matcher` berlaku sejak Fase 1. |
| KA13 | Sedang | M2 (Fase 2) menambah `code`/`messageId` sebelum MU-M3 (Fase 5). "404 identik" belum mengunci body error baru. | `ownership-matrix` membandingkan seluruh body dan header, termasuk `code`/`messageId` (`errors.web.not_found`), untuk "tidak ada" dan "milik orang lain". |
| KA14 | Sedang | `_clips` adalah fungsi Python (`api.py`), sedangkan `post-registry.mjs` berbahasa JS. Fase 8 belum punya registry turunan. Pengecualian klip turunan dari profil performa juga belum diuji, karena FB rilis di Fase 9 dan turunan baru ada di Fase 11. | Fungsi JS `listJobClips(job)` di `web/lib/jobs.mjs` dibuat di SOS-M3a (manifest saja), lalu diperluas di editor F7 dengan tes paritas terhadap `_clips`. Fase 11 menambah tes "turunan tidak masuk profil/`selectionKeys=null`". |
| KA15 | Sedang | Pratinjau `POTONGIN_LOCALES=id,en` di produksi berlaku untuk seluruh instans, jadi tidak ada mekanisme "hanya admin". | Checklist sebelum undangan pertama (Fase 6): flag kembali ke `id`, kecuali pemilik memilih Q9 (a). `en-smoke` tetap di luar pasca-deploy sampai M9. |
| KA16 | Rendah | §2.2-E masih menulis "Fase 1 multi-user menambah backup DB" (penomoran lama). | Diganti menjadi Fase 4. |
| KA17 | Rendah | Daftar flag kurang `POTONGIN_SETTINGS_SECRET`, `POTONGIN_MAX_SOURCE_SECONDS`, `POTONGIN_POT_PROVIDER_URL`, `POTONGIN_PERF_MIN_POSTS`, `POTONGIN_PERF_HORIZON`, dan `POTONGIN_FETCH_SECTIONS`. | Ditambahkan. |
| KA18 | Rendah | Pembaruan `VM_NGINX_CLOUDFLARE.md` untuk HTML `private, no-store` (i18n K6) tidak ada di isi Fase 1. | Ditambahkan ke M0. |
| KA19 | Rendah | Isi Fase 2 menghilangkan peringatan dari `pipeline.py` di M5. Urutan M5 sebelum dashboard F3 belum tertulis. "Byte-identik" ambigu karena manifest memang bertambah field. | Ditambahkan. Kriterianya menjadi: klip terpilih, urutan, dan skor identik; manifest hanya bertambah field. |
| KA20 | Rendah | Pintasan satu tombol sudah dikirim di Fase 1, tetapi saklarnya baru ada di Pengaturan → Tampilan (Fase 3), sehingga WCAG 2.1.4 terlanggar selama dua fase. Editor juga punya saklar sendiri. | Saklar dipasang di menu akun sejak Fase 1. Satu preferensi bersama dashboard dan editor (cookie per perangkat). |
| KA21 | Rendah | Status drain "Menunggu pemeliharaan" (review #2) belum masuk set status dashboard. | `status.proses`: Antre + detail "Pemeliharaan". |
| KA22 | Rendah | Guard copy "Selection V3"/`engine_fallback` baru dipasang di Fase 5, padahal copy dashboard ditulis di Fase 1–3. | Dipindah ke `ui-guards` di Fase 1. |
| KA23 | Rendah | § CONTRACTS untuk i18n belum bernomor. | §5.65 dialokasikan di PR kontrak Fase 0. |
| KA24 | Rendah | Tab Pengaturan "Akun" antara Fase 3 dan 6 tidak punya isi, karena login masih env. | Tab Akun tidak dibangun di Fase 3. Tautan ke `/akun` mulai Fase 6, dan Zona mulai Fase 8. |
| KA25 | Rendah | Matriks rollback dan urutan boot migrasi dari roadmap 01 §6 tidak ada di dokumen induk. | Ditambahkan sebagai §6 ringkas, termasuk baris i18n. |
| KA26 | Info | Sudah diverifikasi benar: dashboard 50–61 (jumlah tabel), editor 81, i18n 46 (tabelnya sendiri; teks 42–45 keliru), dan semua subtotal fase. Koreksi review #1–#16, K1–K31, 03 #1–24, dan i18n K1–K23 lainnya sudah terbawa dengan benar. | Tetap. |

---

# Roadmap Induk Potongin (revisi akhir): multi-user, sosmed, performa, reframe, unduhan, dashboard HeroUI, i18n ID/EN, editor

Dokumen ini hanya rencana. Belum ada file yang diubah, dibangun, dipasang, atau dijalankan. Path ditulis relatif terhadap ``.

Sumbernya empat rencana, dan semua koreksinya sudah diterapkan bersama KA1–KA25:
- roadmap fitur 01 + review #1–#16;
- dashboard 02 (K1–K31);
- editor 03 (#1–#24);
- i18n (K1–K23).

Angka bertanda *(dedupe)* adalah hasil penggabungan pekerjaan yang sama dari dua rencana.

---

## 1. Ringkasan eksekutif

- **Yang berubah:** Potongin menjadi layanan multi-user dengan peran admin/member. Fitur barunya:
  - posting dan jadwal sosmed (YouTube, TikTok, Instagram);
  - umpan balik performa;
  - tata letak Otomatis per shot;
  - unduhan sumber yang lebih tangguh (Twitch, cache).
- **Dashboard:** ditulis ulang di atas HeroUI v3 + Tailwind v4, dengan copy berupa label pendek.
- **Bahasa:** UI tersedia dalam Bahasa Indonesia dan English, dengan pemilih bahasa. Bahasa baru cukup ditambah dengan satu JSON dan satu baris registry.
- **Editor:** dirombak paling akhir. Satu layout, lima tab, segmen ganda, gabung klip.
- **Urutan:**
  1. Dashboard dan fondasi i18n (Fase 1–3).
  2. Identitas dan isolasi (Fase 4–6). Hardening keamanan dikerjakan **sebelum** undangan pertama.
  3. Unduhan (Fase 7), sosmed (Fase 8), performa (Fase 9).
  4. Editor (Fase 10–11).
- **Total inti: ≈ 384–399 hari-dev** (+2 kalau Kick go).
  - Rinciannya: roadmap fitur 195,5–199,5 + cadangan integrasi 20 + dashboard 50–61 + editor 81 + i18n 46 − dedupe 8,5.
  - Opsional: ≈ 23 hari, ditambah waktu kalender.
- **Satu developer:** sekitar 19–20 bulan, memakai rasio review (≈ 20 hari-dev per bulan).
  - Anggota bisa diundang setelah Fase 6: ≈ 174–187 hari-dev (≈ 8,5–9,5 bulan).
  - Kalau jalur Python/sosmed dikerjakan agen paralel: ≈ 147–160 hari-dev.
- **Kalender di luar kendali:** verifikasi Google, audit TikTok Direct Post, serta Meta App Review dan verifikasi bisnis butuh 2–6+ minggu. Pendaftaran app dimulai di G0/Fase 0. Sampai audit lolos, posting tetap privat atau hanya untuk tester.
- **Rollback:** setiap fase bisa dikirim dan di-rollback sendiri lewat image dan flag env. Migrasi hanya aditif. Fitur besar dirilis expand-lalu-enable.

---

## 2. Keputusan

### 2.1 Sudah diputuskan pemilik

| # | Keputusan | Akibat langsung |
|---|---|---|
| D1 | Clean-room rewrite. SupoClip (AGPL) hanya dipakai sebagai catatan perilaku dan IA. | Implementer tidak membuka repo SupoClip dan tidak menyalin string, markup, konstanta, nama modul, atau tangkapan layar. Setiap PR mencatat sumber rujukannya. Reviewer melakukan spot-check di `web/lib/social/providers/*`, `edit_v2/shots.py`, `fetch/*`, dan `messages/en.json` (sumber copy en = `id.json` + glosarium). |
| D2 | Multi-user dengan peran `admin`/`member`. | SQLite control plane dan sesi server (§2.2-A/B). |
| D3 | HeroUI v3 + Tailwind v4. | Fondasi UI (§2.2-F). |
| D4 | UI sangat sederhana: label, bukan kalimat, tanpa teks pengisi AI. Berlaku untuk **semua** bahasa. | Amandemen DESIGN.md dan AGENTS.md di G0. |
| D5 | Editor lengkap tetapi semudah SupoClip. | Rencana editor 03. |
| D6 | Dashboard dikerjakan dulu, UI editor belakangan. | Editor masuk Fase 10–11. |
| D7 | UI English **dan** Indonesia dengan pemilih bahasa; bahasa lain bisa ditambah. | Fondasi i18n di Fase 1. |

### 2.2 Keputusan arsitektur lintas rencana

**A. Persistence**
- **Lokasi:** satu SQLite (`node:sqlite` DatabaseSync, WAL, `busy_timeout` 5000, FK ON) di volume terpisah `potongin_control:/control`.
  - `POTONGIN_DB_PATH=/control/potongin.sqlite`, mode 0600.
  - Backup (`VACUUM INTO`, disimpan 14) dan settings tersegel ada di volume yang sama.
- **Siapa yang me-mount:** render-worker dan proses Python tidak me-mount `/control`. `deploy-env-contract` memeriksa **mount**, bukan hanya env.
- **Pemindahan settings:** `/data/settings` dipindah dengan kompatibilitas image lama (symlink, atau kedua path dibaca). Kalau memakai `volume.subpath`, compose minimal 2.23.
- **Job tetap file:** `JOBS_ROOT/<uuid>/job.json` + `ownerId`. Tidak ada tabel job.
- **Proses yang boleh membuka DB:** `app`, `primary-worker`, `social-worker`.

**B. Auth dan sesi**
- Cookie `__Host-potongin_session = s2.<sid>.<secret>`, hash di DB, umur absolut 30 hari, dicabut saat logout. Password memakai scrypt.
- `currentUser`/`requireUser` sinkron, dijaga `authorize-sync-contract`.
- Akses lintas pemilik dijawab 404 yang identik (body dan header, termasuk `code`/`messageId`). Admin tidak punya akses implisit.
- Rate limit login per username **dan** per IP. Ada rate limit dan anti-enumerasi untuk invite/reset.
- Re-auth untuk aksi admin. `sameOriginMutation` di semua route baru.
- "Keluar dari semua perangkat" baru ada setelah sesi DB tersedia.

**C. Python tidak tahu pemilik.** App menulis `fairnessKey` (hash buram) ke `analysis/render-requests/<id>.json`. `render_worker.py` hanya membaca kunci itu, dan kunci kosong dianggap `legacy` (§5.59).

**D. Nama gaya Potongin (clean-room),** ditetapkan di PR kontrak Fase 0:

| Draf | Final |
|---|---|
| `social_accounts` | `social_connections` |
| `social_posts` | `publish_runs` |
| `oauth_states` | `oauth_pending` |
| `fetchMetrics` | `readPostStats` |
| `/data/media-cache` | `/data/cache-unduhan` |

**E. Deploy**
- **Fase 4 (multi-user):** backup DB dan kredensial smoke `E2E_SMOKE_*` di `run_read_only_e2e`.
- **`social-worker` dirilis dua kali:**
  - **R0:** image saja.
  - **R1:** service ditambahkan ke compose.
  - `rollback()` memanggil `wait_social_health || true`. Ada kasus baru di `tests/test_deploy_guard.py`.
- **Mode drain:** `POTONGIN_ADMISSION_PAUSE` (MU-M7b) menggantikan blokir quiescence begitu ada anggota.
- **Flag baru** masuk `.env.example` dan `compose.yaml` service yang bersangkutan, dijaga `env-example.test`:
  - multi-user dan deploy: `POTONGIN_DB_PATH`, `POTONGIN_SETTINGS_SECRET` (wajib), `E2E_SMOKE_*`, `PRIMARY_WORKER_CONCURRENCY`, `POTONGIN_ADMISSION_PAUSE`;
  - sosmed: `POTONGIN_SOCIAL`, `SOCIAL_PIN_KEEP_DAYS`;
  - performa: `POTONGIN_PERFORMANCE`, `POTONGIN_PERF_MIN_POSTS`, `POTONGIN_PERF_HORIZON`;
  - reframe: `POTONGIN_AUTO_REFRAME`;
  - unduhan: `POTONGIN_FETCH_AUDIO_FIRST`, `POTONGIN_FETCH_TWITCH`, `POTONGIN_FETCH_KICK`, `POTONGIN_FETCH_SECTIONS`, `POTONGIN_MEDIA_CACHE`, `POTONGIN_MEDIA_CACHE_BYTES`, `POTONGIN_MEDIA_CACHE_TTL_DAYS`, `POTONGIN_POT_PROVIDER_URL`, `POTONGIN_MAX_SOURCE_SECONDS`;
  - UI: `POTONGIN_LOCALES`, `POTONGIN_EDITOR_SHELL`.

**F. Fondasi UI (dashboard)**
- **Layer CSS:** baris pertama `globals.css` adalah `@layer theme, base, components, utilities;`. Aturan elemen dan blok dasar (`.btn`, `.panel`, `.notice`) masuk `@layer base`. Token `:root` dan reduced-motion tetap di luar layer.
- **`app/ui.css`:**
  - diimpor hanya dari `AppShell.jsx` dan `login/page.jsx`;
  - tanpa preflight, dengan `@source not "../components/editor"` dan `@theme{--color-*:initial}`;
  - CSS editor hasil build harus identik.
- **Tanpa `RouterProvider`.** Semua `editorHref` dirender sebagai `<a>` dengan pemuatan penuh (COOP/COEP).
- **Alias token penuh,** dengan tes yang membaca `@heroui/styles/dist/themes/default/variables.css`.
- **Override komponen:**
  - 44 px dan `--radius-m` untuk `.button`;
  - keadaan terpilih memakai `--text`/`--surface-3`;
  - `.button--outline` memakai `--border-strong`;
  - `variant` wajib ditulis, dan paling banyak satu `primary` per halaman.
- **Kelas:** `.chip` → `.statusPill`. `.table`/`.tableWrap` dihapus. `.btn` minimal untuk `global-error`. Tema memakai `data-theme="dark"`.
- **Lisensi** (test-first, `/licenses`): HeroUI, RAC, `@internationalized/date`, `tailwind-variants`, `tw-animate-css`, Tailwind, use-intl, `intl-messageformat`, `@formatjs/*`, `icu-minify`, `@schummar/icu-type-parser`.

**G. Fondasi i18n**
- **Library:** `use-intl@4.14.9` dipin persis, **bukan** `next-intl`.
  - Glue di `web/lib/i18n/{locales,resolve,server,client,format,errors}`.
  - `lib/content-text.mjs` untuk operasi bahasa konten.
- **Katalog:** `web/messages/{id,en}.json`. `id` adalah sumber kebenaran, dan `en` di-deep-merge di atasnya. Kunci yang hilang tampil Indonesia di produksi, tetapi membuat tes gagal.
- **URL tanpa prefix locale.** Slug, nama file unduhan, anchor `#kode`, dan `Content-Disposition` netral bahasa.
- **Urutan resolusi:** `users.locale` → cookie `potongin_locale` (tidak HttpOnly, Secure di produksi) → `Accept-Language` (`in` dianggap `id`) → `id`. Proxy tidak membaca DB.
- **Provider:**
  - Server component memakai `getT(locale)`; client component memakai `useTranslations`.
  - Root layout **hanya** memasang `IntlProvider` dengan namespace inti.
  - Segment layout memasang provider dengan pesan **gabungan**, karena provider bersarang mengganti, bukan menggabungkan.
  - `I18nProvider` React Aria hanya ada di `components/ui/Providers.jsx` dan kit editor (KA7).
- **Rute jadi dynamic** karena `cookies()` di root. Ini diterima: HTML diberi `private, no-store`, TTFB diukur, dan `VM_NGINX_CLOUDFLARE.md` diperbarui.
- **Error API aditif.** Bentuk datar dan bersarang dipertahankan sesuai CONTRACTS. Field `code`, `messageId`, dan `params?` ditambahkan. String `error` Indonesia tetap ada untuk log, agen Hermes, dan image lama.
- **Kunci error** = `errors.` + `messageId` apa adanya. Detail setelah `:` menjadi `{detail}`.
- **Label bawaan:** wrapper `components/ui/*` menimpa label React Aria (tidak ada locale `id`) dan label hardcode HeroUI ("Close").
- **Bahasa UI ≠ bahasa konten.** Caption, transkrip, hook, judul, hashtag, prompt LLM, dan ASS mengikuti `videoLanguage`. `content-language-isolation` mengunci plan, ASS, dan `render_key` agar identik antara `id` dan `en`.

**H. Kontrak bersama**
- **Field pemilik** `ownerId`. Tabel `posts` + `web/lib/post-registry.mjs` adalah registry bersama sosmed dan feedback. Kunci join metrik `(ownerId, jobId, clipId)`.
- **Ekspor `web/lib/jobs.mjs`:** `servedClipText`, `snapshotClipPackaging`, dan `listJobClips(job)` (mirror JS dari `_clips` Python, KA14).
- **Nomor CONTRACTS** (dialokasikan di PR kontrak Fase 0):
  - §5.59 multi-user;
  - §5.60 posting;
  - §5.61 registry + snapshot;
  - §5.62 performa;
  - §5.63 reframe/shot-plan **termasuk skema `layout.ranges`** (KA6);
  - §5.64 sumber link + cache;
  - §5.65 i18n (`messageId`/`params` aditif, `stage_code`, `reason_codes`).

### 2.3 Konflik antar-rencana dan resolusinya

| # | Konflik | Resolusi |
|---|---|---|
| X1 | Layar admin dan visibilitas per peran butuh `users`/`sessions`, sedangkan MU-M5 juga membangun halaman admin/akun. | Dashboard F0–F6 dan F10 tidak butuh peran, jadi dikerjakan di Fase 1–3. Halaman admin, `/akun`, `/akun/kata-sandi`, `/undangan`, dan `/atur-ulang-sandi` dibangun **sekali** di Fase 6 (MU-M5 + dashboard F7, *dedupe −2*). Restyle `/login` dan pemilih bahasa dikerjakan di Fase 1. |
| X2 | Rute ganda: `/jadwal` dan `/performa` (roadmap) vs `/sosial` dan `/analitik` (dashboard). | Dipakai IA dashboard: `/sosial?tab=jadwal\|akun`, `/analitik` (termasuk "Umpan balik"), dan `navLinks(pathname,{role,features})` datar. `/akun` menjadi satu tempat untuk profil, sandi, Bahasa, sesi, token, dan Zona (sejak Fase 8). Pengaturan tidak punya tab Akun, cukup tautan sejak Fase 6. `SocialAppsCard` ada di Pengaturan → Sistem (admin). |
| X3 | Komponen publikasi dibuat tiga kali dengan tiga istilah. | Satu `components/PublishDrawer.jsx` di Fase 8 (*dedupe −4*), dipakai ulang di editor Fase 11. Istilahnya **Terbitkan / Terbit** (Q1). |
| X4 | Terbit dari editor bergantung pada sosmed. | Editor F8 bagian terbit dikerjakan setelah Fase 8. API hanya menerima `render_id` yang lolos `verify.py` dan ekspor **completed**. |
| X5 | Model per shot: RF-M5 di editor lama vs `layout.ranges` editor 4b. | **Satu model, ditetapkan di §5.63 pada Fase 0 (KA6):** <br>• `layout.mode: auto` memakai shot-plan engine; hasilnya diturunkan ke `layout.ranges` dengan `origin:auto`. <br>• Override pengguna: `origin:user`, dengan mode camera, fill_center, atau fit_blur (saklar §5.40). <br>• `split` di range hanya untuk `origin:auto`, dan hanya kalau spike RF-M2 lolos. <br>• `layout.mode: split` untuk seluruh klip tidak boleh dipakai bersama ranges. <br>• Batas shot: `shot_cuts.py`, lalu `scene_cuts_ms`, lalu satu shot. <br>• RF-M2 mengompilasi ranges. RF-M5a (Fase 7) membangun kartu Otomatis, command, draft-store, dan apply-all (tanpa ranges). Strip shot dan `ShotPopover` hanya di editor 4b. *Dedupe 0.* |
| X6 | `derived-clips.json` tidak ada di manifest. | `listJobClips` (JS) dan `_clips` (Py), dengan tes paritas: manifest saja di Fase 8, ditambah registry turunan di Fase 11. Klip turunan memakai `clipId` namespace `potongin-clip-derived-v1`, `selectionKeys=null`, dan dikeluarkan dari profil performa (diuji di Fase 11). Menghapusnya membatalkan jadwal. Posting yang sudah terbit menyimpan snapshot. |
| X7 | Preferensi bahasa sudah dibutuhkan sebelum ada tabel users. | `POST /api/locale` publik (cookie): dikecualikan di `proxy.js` dan tercatat di `proxy-matcher.test` serta allowlist `route-guard-coverage`. Setelah MU-M2: kolom `users.locale` (M6a) disalin ke cookie saat login, dan `/api/locale` menulis DB kalau sesi valid. `/api/account/preferences` hanya untuk Zona (M7b). `prefs.json` tidak dipakai untuk locale/zona. |
| X8 | Dashboard menulis `I18nProvider locale="id-ID"`, `aria-label` literal, `Intl…("id-ID")`, dan `status-words.mjs`. | `registry.intl`, label dari `aria.*`, `useFormatter`, dan namespace `status` (dua set: proses dan postingan; proses mencakup detail "Pemeliharaan" untuk drain). |
| X9 | DatePicker `hideTimeZone` vs zona ditampilkan. | Nama zona pendek ditampilkan. `ZonedDateTime` disimpan sebagai ISO UTC + zona asal. `hourCycle` mengikuti Q8. |
| X10 | Guard `ui-foundation` melarang HeroUI di editor. | Diamandemen di Fase 10. Editor mendapat entri CSS sendiri dengan `@layer` di bawah CSS Modules. Larangan `RouterProvider` tetap. |
| X11 | Copy wajib Indonesia (AGENTS.md:19, roadmap §2.9, dashboard §1.8, G-FAIL, editor). | Diamandemen di G0: copy dari `messages/id.json` (sumber), diterjemahkan ke tiap locale. G-FAIL menjadi "kode tetap + pesan Indonesia + entri di setiap locale". |
| X12 | Nama mode tata letak berbeda-beda. | Label chip di Buat klip: **Tata letak**. Sumbernya satu, `lib/layout-names.mjs`: Otomatis (Fase 7), Ikuti wajah, Potong tengah, Latar blur, Layar terbagi (hanya di editor). "Ikuti pembicara" dihapus (KA11). |
| X13 | `draft-store` bisa bocor antar-user. | Dikunci hash user dan dibersihkan saat logout (Fase 4). |
| X14 | Basis Gate 1 performa. | `main` setelah **Fase 7**. M5 i18n (Fase 2): klip terpilih, urutan, dan skor identik di gold benchmark. |
| X15 | Pintasan satu tombol: dashboard dan editor punya saklar terpisah, dan saklar dashboard terlambat. | Satu preferensi (cookie per perangkat). Saklar di menu akun sejak Fase 1, di Pengaturan → Tampilan sejak Fase 3, dan di modal Pintasan editor sejak Fase 10 (KA20). |

---

## 3. Fase terpadu

"‖" menandai jalur paralel (Python/worker). Setiap milestone = satu PR, tes ditulis lebih dulu. Perubahan CSS, UI, atau render menjalankan `editor-gates.yml` (full/e2e/player). Smoke berjalan di setiap PR lewat `ci-cd.yml`.

### G0. Gerbang (kerja pemilik, 0 hari-dev)
- **Isi:**
  - PR `feat/ux-redesign-workspace` di-merge ke `main`.
  - Pemilik menyetujui amandemen DESIGN.md (termasuk §Editor), AGENTS.md (clean-room, migrasi aditif, guard sinkron, aturan copy i18n), dan glosarium.
  - Pemilik menjawab **Q1, Q2, Q8 (format jam), dan Q9 (bahasa awal, penulis copy en)**.
  - Pemilik mulai mendaftarkan app Google, TikTok, dan Meta dalam mode testing.
- **Selesai bila:** persetujuan tertulis ada dan PR UX sudah di `main`.

### Fase 0. Runtime, kontrak, pengukuran (15,5)
- **Isi:**
  - **MU-M0 Node 24 (2,5):** digest `Dockerfile:9`; `.github/workflows/{ci-cd,editor-gates,ytdlp-update}.yml`; stamp toolchain; stabilitas `node:sqlite` (stderr bersih).
  - **FB-M0 (2):** `resources/performance/rules.v1.json`, kontrak snapshot v1, kontrak registry posting, contoh CSV.
  - **SOS-M0 (3):** `docs/operations/SOSMED.md` dengan sumber; `FILE_UPLOAD` TikTok sebagai jalur utama; verifikasi domain; pembolehan agregat 30 hari YouTube.
  - **FETCH-M0 (3):** `docs/evaluation/UNDUHAN_M0.md`.
  - **RF-M0 (4):** `scripts/eval/auto_reframe.py`, `docs/evaluation/AUTO_REFRAME.md`, sekitar 40 jendela berlisensi.
  - **PR kontrak (1):** alokasi §5.59–§5.65, skema `layout.ranges` di §5.63, nama clean-room, dan protokol clean-room di AGENTS.md.
- **Dependensi:** G0.
- **Selesai bila:**
  - ci-cd dan editor-gates hijau di Node 24 (P-TIME/P-TXT/P-ENC/P-COLOR/P-RT, ambang tidak diubah).
  - Invalidasi plate dan render key tercatat: byte cache plate sebelum/sesudah diukur, dan klip yang tidak diubah tetap memakai file otomatis tanpa render ulang.
  - Go/no-go untuk Kick, bgutil, dan range-only tertulis.
  - Baseline reframe dilaporkan.
  - PR kontrak di-merge.
- **Pengguna merasakan:** tidak ada perubahan.
- **Rollback:** image.

### Fase 1. Fondasi UI + i18n + Shell + pemilih bahasa (20,5–23,5)
- **Isi:**
  - **Dashboard F0 (7–9):**
    - fondasi §2.2-F;
    - spike: diff CSS editor, ukuran bundle per rute (baseline), `ui-foundation.test`, lisensi, `data-theme`;
    - `ui-guards` juga menolak copy "Selection V3"/`engine_fallback` dan label versi.
  - **i18n M0 (6):**
    - `use-intl`, `lib/i18n/*`, `lib/content-text.mjs`, `messages` inti;
    - `IntlProvider` di root, provider segment, `generateMetadata` (12 `metadata` + `global-error`);
    - migrasi 18 file `Intl` + 3 file konten;
    - tes `i18n-*` dengan baseline ratchet, `heroui-default-labels`, `content-language-isolation`;
    - Playwright `locale:"id-ID"` + cookie `id`;
    - `POTONGIN_LOCALES` di `compose.yaml` service `app`, `.env.example`, `deploy-env-contract`;
    - TTFB `/`, `/dashboard`, `/login` diukur sebelum/sesudah; HTML `private, no-store`; `deploy/VM_NGINX_CLOUDFLARE.md` diperbarui.
  - **Dashboard F1 (3–4):** `NavList` datar, Drawer, menu akun, logout lewat form tersembunyi dengan `requestSubmit()`, pintasan + saklar di menu akun (X15).
  - **i18n M1 (3):**
    - `POST /api/locale` publik (+ matcher, `proxy-matcher.test`, allowlist `route-guard-coverage`);
    - pemilih bahasa di menu akun dan `/login`;
    - restyle `/login` (form POST native, `name` sama, `role="alert"`);
    - not-found, error, global-error.
  - **Migrasi tes (1,5).**
- **Dependensi:** Fase 0 (Node 24).
- **Selesai bila:**
  - `next build` hijau. CSS editor identik, kenaikan JS editor ≤ ukuran use-intl dan tercatat. Editor, parity, dan screenshot editor tanpa diff.
  - Ganti bahasa ≤ 2 klik, bertahan setelah reload, dan jalan tanpa JS di `/login`. Pengunjung tanpa cookie mengikuti Accept-Language.
  - `en-smoke` shell dan login hijau di CI (`POTONGIN_LOCALES=id,en`).
  - Ratchet 0 di AppShell, login, not-found, dan error.
- **Pengguna merasakan:** shell baru dan pemilih bahasa. Produksi tetap `id`. Pemilik boleh menyalakan `id,en` sebagai pratinjau selama belum ada anggota.
- **Rollback:** image. Image lama mengabaikan cookie dan tampil Indonesia.

### Fase 2. Buat klip + Detail proyek + kode error/progres (25,5–27,5)
- **Isi** (urutan di dalam fase: M5 → F3):
  - **Dashboard F2 (6–7):** composer chip bernilai (Tata letak: Ikuti wajah / Potong tengah / Latar blur), redirect ke `/projects/[id]`.
  - **i18n M5 (3):**
    - `stage_code`/`stage_params` di `pipeline.py report()`;
    - `stageCode` di `run-job.mjs`/`primary-job-queue.mjs`;
    - `reason_codes`/`warning_codes` di `selection_v3.py`, `ranking.py`, `features.py`, `pipeline.py`;
    - namespace `stage`/`reason`.
  - **Dashboard F3 (6–7):** stepper, penampil `Modal` `?klip=N`, Edit klip sebagai `<a>`, copy dan gambar landing (`app/page.jsx`, `public/landing/editor.webp`).
  - **i18n M2 (6):**
    - `lib/error-codes.mjs`, `lib/api-error.mjs`;
    - `code`/`messageId` aditif di 49 route;
    - 33 pembaca klien;
    - peta pesan menjadi daftar kode + `legacyMessage(code)`;
    - amandemen G-FAIL dan CONTRACTS §5.65.
  - **i18n M3 bagian (3).**
  - **Migrasi tes (1,5).**
- **Dependensi:** Fase 1.
- **Selesai bila:**
  - `i18n-error-codes` hijau (teks `errors.edit.*` = `_MESSAGES` Python). Tes route dan kontrak lama hijau tanpa diubah. Agen tren tidak terdampak.
  - Gold seleksi: klip, urutan, dan skor identik; manifest hanya bertambah field. Job lama tetap tampil.
  - Klip tampil bertahap, dan editor dibuka dengan COEP.
  - Screenshot `en` 360 px tanpa scroll horizontal.
- **Pengguna merasakan:** Buat klip lebih ringkas, hasil langsung di halaman proyek, error dan progres dalam bahasa aktif.
- **Rollback:** image (semua perubahan aditif).

### Fase 3. Proyek, Pengaturan, Tren, Bantuan (22–25)
- **Isi:**
  - **Dashboard F4 (3–4):** Table, batch hapus, tab Klip.
  - **Dashboard F5 (6–7):** Tabs hash (AI, Transkripsi, Tampilan, YouTube, Sistem; tanpa tab Akun), `shouldForceMount`, satu bar simpan, saklar pintasan di Tampilan.
  - **Dashboard F6 (3–4):** Tren dengan Modal dan tab Agen.
  - **Dashboard F10 (3):** Bantuan dengan anchor tetap dan tanpa JS; `Disclosure` hanya untuk Panduan; CSS mati dihapus.
  - **i18n M3 sisa (3).**
  - **i18n M4 (3):** `help.*`, indeks pencarian dari semua locale.
  - **Migrasi tes (1).**
- **Selesai bila:**
  - Hash lama membuka tab yang benar, dan perubahan tidak hilang saat pindah tab.
  - Pesan `id` yang ditempel di UI `en` tetap ketemu di Bantuan.
  - Ratchet 0 di semua rute dashboard yang ada.
  - `selectOption` dan checkbox di e2e sudah dimigrasi ke role.
- **Pengguna merasakan:** seluruh dashboard baru, dua bahasa lengkap kecuali editor (editor jatuh ke Indonesia). Ini titik keputusan Q9 opsi (a).
- **Rollback:** image.

### Fase 4. Fondasi identitas (12–14)
- **Isi:**
  - **MU-M1 + MU-M2 (10–12) + migrasi settings (≈1):**
    - DB, `0001`, volume `potongin_control`, backup di `production.sh`;
    - sesi s2 dengan proxy yang menerima dua bentuk cookie;
    - bootstrap admin dari `APP_*`;
    - `sessionFromCookieStore` untuk 3 halaman server + `parity-fixtures`;
    - `admin-reset.mjs --admin/--ensure-smoke-user`;
    - `E2E_SMOKE_*` di `run_read_only_e2e`;
    - kontrol auth (rate limit per username+IP, `sameOriginMutation`);
    - draft editor dikunci hash user dan dibersihkan saat logout.
  - **i18n M6a (1):** `users.locale`, sinkron login ↔ cookie, `/api/locale` menulis DB kalau ada sesi.
- **Selesai bila:**
  - Migrasi idempoten, dan skema baru diterima kode lama.
  - Backup lolos `integrity_check`.
  - Cookie v1 di-upgrade sekali, dan logout mencabut sesi di server.
  - `authorize-sync-contract` hijau.
  - read-only/smoke lolos dengan anggota smoke berproyek kosong. `deploy-env-contract` memastikan `E2E_SMOKE_*` dipakai dan memeriksa mount `/control`.
  - Perangkat kedua memakai bahasa dari DB.
  - gitleaks bersih.
- **Pengguna merasakan:** login sama seperti sebelumnya, logout benar-benar mencabut sesi, bahasa ikut akun.
- **Rollback:** image lama mengabaikan DB. `APP_*` tetap valid.

### Fase 5. Kepemilikan dan rahasia per user (17–19 ‖ 14)
- **Isi:**
  - **MU-M3 (11–13):**
    - `ownerId`, `web/lib/job-ownership.mjs`, `secureRoute owner:'job'`;
    - 49 route, 18 lib route, dan 5 route self-auth (upload jobs, assets, logo, youtube-cookies, `/api/locale`);
    - `ownership-matrix` (seluruh body/header) dan `route-guard-coverage` di seluruh `app/api`;
    - `web/e2e/multiuser-isolation.spec.mjs`.
  - **MU-M4 (6):**
    - `sealing.mjs` v2, `owner-env.mjs`, `POTONGIN_SETTINGS_SECRET` wajib;
    - Pengaturan Pribadi/Instans dipetakan ke tab Fase 3 sesuai peran;
    - "Tentang sistem", status storage global, dan `/api/health` rinci hanya untuk admin;
    - cap harian LLM bersama.
  - **‖ RF-M1 (6) dan RF-M2 (8, spike graf lebih dulu; mengompilasi `layout.ranges` §5.63).**
- **Selesai bila:**
  - Setiap route dan method lintas user mendapat 404 identik dengan nol spawn Python. Admin tanpa opt-in juga 404.
  - Anggota dengan berbagi mati tidak mendapat key LLM/Groq env, dan job tetap selesai dengan heuristik.
  - Kotak tersegel lintas user atau lintas purpose gagal dibuka.
  - **Reframe:**
    - byte camera plan tetap;
    - P ≥ 0,95 / R ≥ 0,90 pada ±1 frame grid (cadangan dipakai kalau perlu);
    - scan CI ≤ 15 dtk + 0,5 dtk/cut;
    - graf < 3 GiB dengan konteks filter yang tidak tumbuh;
    - md5 frame = pure chain;
    - graf, plan sha, dan plate key non-auto dipin;
    - `RENDER_SEMANTICS` 2.
- **Pengguna merasakan:** Pengaturan Pribadi/Instans. Belum ada anggota.
- **Rollback:** image. Job lama terlihat oleh login env.

### Fase 6. Siap untuk anggota (34–35 ‖ 8 ‖ 5)
- **Isi (urutan wajib, keamanan dulu):**
  1. **MU-M4b keamanan (4):**
     - ffprobe `format_name` di allowlist (mov/mp4/matroska/webm), dengan hls, concat, dan image2 ditolak;
     - `-protocol_whitelist file,pipe` di semua ffmpeg/ffprobe `src/ai_clipper/*`;
     - **inti `web/lib/source-url.mjs` + `fetch/platforms.py` (YouTube, fixture bersama)**, yt-dlp `--use-extractors`, `--no-playlist`, penolakan IP privat;
     - `scripts/security/route_matrix.py`, `tests/test_security_*`.
  2. **MU-M5 + dashboard F7 (≈ 7–8, *dedupe*):** `/admin/pengguna[/<id>]`, `/admin/job`, `/akun`, `/akun/kata-sandi`, `/undangan/[token]`, `/atur-ulang-sandi/[token]` (dengan pemilih bahasa), audit, kode Bantuan, re-auth admin, tautan `/akun` di Pengaturan.
  3. **i18n M6b (0,5)** Bahasa di `/akun`, dan **M7a (1,5):** `admin`, `account`, audit `code+params` sejak baris pertama, email/tautan undangan dalam bahasa pilihan admin.
  4. **MU-M6 (2,5):** token API per user, impor `ingest-tokens.json`, tren instans-wide dengan switch per anggota.
  5. **MU-M7 (4):** fairness `lastServedAt`, reservation v3 (R1 lalu R2), round-robin `fairnessKey` di render-worker, posisi antrean dan perkiraan tunggu di halaman proyek.
  6. **MU-M7b drain (3):** `POTONGIN_ADMISSION_PAUSE`, status "Antre · Pemeliharaan", runbook.
  7. **MU-M8 (3,5):** kuota storage.
  8. **MU-M9 (4):** `multiuser-migrate.mjs`, `docs/operations/PENGGUNA.md`, drill.
  9. **Cadangan (4).**
  - **‖ RF-M3 (4,** release 1 dengan flag mati = floor) + **RF-M4 (4).**
  - **‖ SOS-M1 Release A (5):** R0 image saja, lalu R1 service compose.
- **Dependensi:** Fase 5. Undangan **dilarang** sebelum MU-M4b hijau.
- **Checklist sebelum undangan pertama:** `POTONGIN_LOCALES` kembali ke `id`, kecuali Q9 (a). Sandi pemilik sudah diganti, dan e2e smoke lolos.
- **Selesai bila:**
  - `queue-fairness`: B menjadi klaim ke-2 pada concurrency 1.
  - Melewati kuota dijawab 507 sebelum ada byte atau render request tertulis.
  - CLI render-worker berjalan tanpa `POTONGIN_DB_PATH`.
  - Deploy dengan job aktif masuk mode drain.
  - Drill lama→baru→lama hijau, termasuk compose baru dengan image lama.
  - Worker sosmed healthy dengan restart 0.
  - Reframe: agreement test split ≥ 85%, multi SPEAKER_FRAMING ≤ 21,7%, pemilik menerima ≥ 8 dari 10 klip split.
- **Pengguna merasakan:** pemilik bisa mengundang anggota. Ada Akun, Kelola pengguna, dan antrean adil dengan posisi.
- **Rollback:** image, dengan batasan:
  - jangan rollback melewati migrasi contract;
  - melewati R1 butuh compose yang cocok;
  - di bawah floor reframe memakai `auto_layout_downgrade.py`.

### Fase 7. Unduhan sumber + Otomatis menyala (≈ 40, +2 bila Kick go)
- **Isi:**
  - **FETCH-M1 (4, memperluas inti dari M4b)** sampai M8 dan M10 (31 total):
    - `isLinkSource()` di semua pembaca, termasuk `primary-job-queue.mjs:816`;
    - cache `/data/cache-unduhan`, audio-first, Twitch, proxy tersegel dan bgutil, ledger, workflow yt-dlp;
    - `errors.download.*` dalam id dan en, beserta entri Bantuan.
  - **RF-M5a (≈ 4):** kartu Otomatis, command, draft-store, apply-all mode.
  - **RF-M6 gate (5).**
- **Dependensi:** Fase 6 (MU-M7 round-robin, MU-M4b).
- **Selesai bila:**
  - Dengan flag mati, argv yt-dlp identik (snapshot).
  - Twitch mempublikasikan `input/`, dan `sourcePath` ditulis ulang.
  - Dua proses yang mengunduh video yang sama hanya mengunduh sekali.
  - Sweep cache menolak path di bawah `JOBS_ROOT`.
  - Episode eval ≤ 200 ms, dan gold `SELECTION_BENCHMARK` tidak berubah (atau dijalankan ulang dan dilaporkan).
  - Waktu sampai seleksi membaik pada sumber ≥ 30 menit.
  - Render edit-v2 dan legacy tidak berubah.
  - Proxy tidak muncul di `/proc` cmdline, env, log, job.json, maupun response.
  - P-FRAME 0 mismatch, P-PLATE 0 px, G-DET 0 beda, PF-RENDER auto p50 ≤ 0,4× real time.
- **Pengguna merasakan:** field "Link video" (YouTube/Twitch), penolakan siaran langsung atau video terlalu panjang sebelum mengunduh, seleksi lebih cepat, dan Otomatis (opt-in).
- **Rollback:**
  - flag `POTONGIN_FETCH_*`, `POTONGIN_MEDIA_CACHE`, `POTONGIN_AUTO_REFRAME` → `off`;
  - YouTube tetap ditulis `{type:'youtube'}`, sedangkan `{type:'link'}` hanya untuk platform baru setelah ada rilis yang bisa membacanya.

### Fase 8. Posting dan jadwal sosmed (29–30, ditambah kalender audit)
- **Isi:**
  - **SOS-M2 (5):** connect, refresh dua fase, disconnect dengan purge, callback Meta.
  - **SOS-M3a (6):** tabel `posts`, `post-registry.mjs`, `listJobClips` (manifest), `rangeFileResponse`, `media.mjs` (ekspor completed), `publisher.mjs`.
  - **SOS-M3b (6):** TikTok `FILE_UPLOAD` sebagai jalur utama, Instagram resumable.
  - **SOS-M4 + dashboard F8 (≈ 8–9, *dedupe*):** `/sosial`, `?hasil=`, `PublishDrawer`, `ClipPosts`.
  - **SOS-M6 (2):** `deploy/VM_NGINX_CLOUDFLARE.md` (OAuth, `/privasi`, `/ketentuan`, media publik, body/timeout), rollout `admin` lalu `on`.
  - **i18n M7b (2):** `social`, `users.time_zone` + Zona di `/akun`, DatePicker berzona, status posting berbasis kode, `email.*` kalau SMTP ada.
- **Selesai bila:**
  - Crash matrix menghasilkan exactly-once atau `maybe_sent` yang disengaja. `deferred` tidak menghabiskan percobaan.
  - Ekspor queued atau failed tidak pernah dipilih. Tes `final-files` tidak berubah.
  - `social-publish.spec` lolos di dua locale.
  - Satu posting privat per platform dan satu terjadwal berhasil di mode `admin`.
  - Jadwal yang dibuat di `en` zona X tampil benar di `id` zona Y.
  - Drill `POTONGIN_SOCIAL=off`: route 404, UI tersembunyi, data tetap.
- **Pengguna merasakan:** Terbitkan dari halaman proyek, halaman Sosial (Jadwal, Akun). Unggahan privat atau tester sampai audit lolos.
- **Rollback:** `POTONGIN_SOCIAL=off`, tanpa rebuild.

### Fase 9. Umpan balik performa dan Analitik (26–27)
- **Isi:**
  - FB-M1 (5,5), FB-M2 (3,5).
  - FB-M3 (5): `order_boost`, `scripts/eval/performance_gate.py`.
  - FB-M4 + SOS-M5 (4): `metrics-refresh.mjs` dengan adapter `readPostStats`.
  - FB-M5 + dashboard F9 (≈ 5–6, *dedupe*): `/analitik`.
  - i18n M7c (0,5): `analytics`.
  - FB-M6 (2,5): laporan retro.
- **Selesai bila:**
  - Gate 1 byte-identik terhadap `main` setelah Fase 7.
  - Gate 2: profil yang tidak cocok tidak mengubah apa pun.
  - Gate 3:
    - Hits@5/10 turun paling banyak 1;
    - Trap@10 tidak naik;
    - floor fokus identik;
    - ukuran efek dilaporkan (bar ≥ 20% episode berubah; kalau tidak tercapai, dicatat "tidak ada efek").
  - Paritas kunci Python/JS lolos.
  - Nilai mentah YouTube > 30 hari tanpa refresh diciutkan.
  - Pemilik sudah membaca laporan retro.
- **Pengguna merasakan:** Analitik, impor CSV, toggle seleksi (default mati).
- **Rollback:** toggle atau `POTONGIN_PERFORMANCE=off`.

### Fase 10. Editor I: shell dan tab (≈ 31)
- **Isi:**
  - **Editor F0 (5):** kit HeroUI/RAC, CSS di bawah CSS Modules, forced-colors, amandemen `ui-foundation` (X10).
  - **Editor F1 (5):** shell, top bar, daftar Klip, 5 tab (Teks · Tata letak · Audio · Logo · Cold open), `?mode=`/`?card=` dialihkan, saklar pintasan (preferensi bersama), hitungan kontrol diukur.
  - **Editor F2 (5):** transkrip Kata | Baris.
  - **Editor F3 (4):** tab Teks.
  - **Editor F4a (4):** Lihat sumber.
  - **Editor F5 (4):** Audio, Logo, Cold open.
  - **i18n M8 bagian (≈ 4):** provider editor (+ `I18nProvider` RA) dan `aria.*`.
- **Dependensi:** Fase 1 dan Fase 7 (RF-M5a). F3, F4a, dan F5 bisa paralel setelah F1.
- **Selesai bila:**
  - Gate per fase sesuai 03 §6.
  - `parity-text` dan screenshot `id` tidak berubah.
  - Tes isolasi hijau.
  - Screenshot 1366×768 dan 1920×1080.
- **Pengguna merasakan:** editor satu layout di balik `POTONGIN_EDITOR_SHELL`.
- **Rollback:** flag ke shell lama.

### Fase 11. Editor II + rilis English (≈ 64,5)
- **Isi:**
  - **F4b (≈ 15):** UI `layout.ranges`, strip shot, `ShotPopover`, override `origin:user`.
  - **F6 segmen ganda (12):** N awal 8, ditentukan PF-SEG.
  - **F7 klip turunan (12):** `derived-clips.json`, `delete_derived_clip`, `_clips`/`listJobClips` diperluas dengan tes paritas, turunan dikeluarkan dari profil.
  - **F8 (8):** 720p, ekspor semua, antrean; terbit lewat `PublishDrawer`.
  - **F9 tablet dan ponsel (8).**
  - **F10 (4):** bersih-bersih dan stopwatch U1–U10.
  - **i18n M8 sisa (≈ 5).**
  - **i18n M9 (0,5):** `POTONGIN_LOCALES=id,en` di produksi, `en-smoke` masuk `run_read_only_e2e`.
- **Selesai bila:**
  - Golden plan dokumen lama byte-sama.
  - P-FRAME ≥ 2.000 frame untuk urutan mundur dan duplikat.
  - P-ENC dengan fixture skala turun.
  - Klip turunan muncul di proyek, Riwayat, ZIP, dan posting, tetapi tidak di profil performa.
  - Ratchet 0 di `components/editor/**`.
  - Pemilik menyetujui copy `en`.
- **Rollback:** flag shell. Fitur dokumen adalah amandemen minor-0, jadi server lama menolak dengan `range_invalid`/`unknown_key`.

### Fase 12. Opsional (≈ 23, ditambah kalender)
- SOS-M7 audit platform (3 + kalender).
- FB-M7 eksperimen prompt (3).
- RF-M7 mode stage (5).
- FETCH-M9 range-only (12, hanya kalau M0 go dan Q11).
- Efek warna editor (belum diestimasi; butuh gate S-COLOR/P-COLOR).

---

## 4. Total estimasi

| Fase | Isi singkat | Hari-dev |
|---|---|---|
| G0 | Gerbang pemilik | 0 (kalender) |
| 0 | Runtime, kontrak, pengukuran | 15,5 |
| 1 | Fondasi UI + i18n + shell | 20,5–23,5 |
| 2 | Buat klip, Detail, kode error/progres | 25,5–27,5 |
| 3 | Proyek, Pengaturan, Tren, Bantuan | 22–25 |
| 4 | Identitas | 12–14 |
| 5 | Kepemilikan ‖ reframe Python | 17–19 ‖ 14 |
| 6 | Siap anggota ‖ reframe floor ‖ sosmed R0/R1 | 34–35 ‖ 8 ‖ 5 |
| 7 | Unduhan + Otomatis | 40 (+2) |
| 8 | Sosmed | 29–30 |
| 9 | Performa/Analitik | 26–27 |
| 10 | Editor I | ≈ 31 |
| 11 | Editor II + rilis `en` | ≈ 64,5 |
| — | Cadangan integrasi lintas fase | 20 |
| **Total inti** | | **≈ 384–399 (+2 Kick)** |
| 12 | Opsional | ≈ 23 + kalender |

**Rincian per sumber:**

| Sumber | Hari-dev |
|---|---|
| Roadmap fitur (sesudah review, tanpa cadangan, termasuk +1 migrasi settings) | 195,5–199,5 |
| Cadangan integrasi | 20 |
| Dashboard (jumlah tabel F0–F10) | 50–61 |
| Editor | 81 |
| i18n (jumlah tabel; teks "42–45" di rencana i18n keliru) | 46 |
| Dedupe: X1 −2, X3 −4, Fase 9 −2,5, X5 0 | −8,5 |
| **Total** | **384–399** |

**Critical path:**
1. **Anggota bisa diundang (G0 → 0 … 6):**
   - satu developer: ≈ 174–187 hari-dev (≈ 8,5–9,5 bulan);
   - dengan agen paralel untuk RF/SOS: ≈ 147–160 hari-dev;
   - bisa dipendekkan lagi dengan mengerjakan Fase 4–5 paralel dengan Fase 2–3. Titik tabrakannya `proxy.js`, `/login`, `settings/page.jsx`, `app-nav.mjs`, dan 49 route (M2 lalu MU-M3), jadi tiap file dipegang satu pemilik per fase.
2. **Posting publik:** kalender review platform (mulai G0) → Fase 8 → SOS-M7.
3. **Editor:** F4b → F6 → F7 berurutan karena semuanya menyentuh `doc.py` dan kompiler. Dengan 2–3 agen sekitar 45–50 hari.
4. **Hotspot merge:** `web/lib/jobs.mjs`, `primary-job-queue.mjs`, `run-job.mjs`, `pipeline.py` (M5, FETCH-M3, FB-M3), `compose.yaml`, `production.sh`.

---

## 5. Gate dan strategi tes

**Aturan umum:**
- Tes ditulis lebih dulu, dan ambang tidak pernah dilemahkan.
- Di PC pemilik hanya tes yang ditargetkan.
- Suite penuh, image, FFmpeg/parity, dan Playwright berjalan di GitHub Actions.
- gitleaks dijalankan sebelum push.

| Area | Gate | Fase |
|---|---|---|
| Gold benchmark | **Gate performa:** Gate 1 byte-identik tanpa profil (7 episode + 5 replay, basis `main` setelah Fase 7); Gate 2; Gate 3 (Hits, Trap, floor fokus, ukuran efek); held-out dijalankan sekali | 9 |
| | **M5 i18n:** klip, urutan, dan skor identik. **FETCH-M3:** gold tidak berubah atau dijalankan ulang dan dilaporkan; eval ≤ 200 ms | 2, 7 |
| Parity render | Node 24: P-TIME/P-TXT/P-ENC/P-COLOR/P-RT, ditambah invalidasi plate | 0 |
| | Pin camera plan, graf/plan sha/plate key non-auto, `RENDER_SEMANTICS` 2; P-FRAME, P-PLATE, P-JOIN-B, G-DET di CPU 1 dan 4; RSS < 3 GiB; PF-RENDER, PF-PIPELINE | 5–7 |
| | P-ENC fixture skala turun; `verify.py` pada ukuran yang diminta; R10 hanya `output` | 11 |
| | `content-language-isolation`: ASS, plan, dan `render_key` identik antara `id` dan `en`; `parity-text` hanya di `id` | 1→11 |
| | Editor: golden plan dokumen lama; P-FRAME ≥ 2.000; PF-SEG; S-COLOR dengan 2–3 range; G-CLICK, G-WHOOSH, P-AUD, P-LOGO | 10–11 |
| a11y | `ui-guards` (token, AA, tanpa kata versi/"Selection V3", palet Tailwind ditolak); 44 px; forced-colors; skip link; live region | 1+ |
| | e2e `aria-names` (di `id` menolak label Inggris, di `en` menolak kata Indonesia); `heroui-default-labels` | 1+ |
| | Pintasan bisa dimatikan sejak dirilis; 360 px; editor 1366×768; fokus kembali ke pemicu | 1, 10 |
| Keamanan | `proxy-matcher` (termasuk `/api/locale`) dan allowlist `route-guard-coverage` | 1+ |
| | `ownership-matrix` (seluruh `app/api` × method × peran; body/header identik termasuk `code`/`messageId`; nol spawn); `authorize-sync-contract`; `security-routes`; `request-security`; `security-child-env`; `owner-env`; `deploy-env-contract` (env **dan** mount); `route_matrix.py`; `tests/test_security_*`; `social-fake-origin-gate`; redaksi token/proxy/`ptk_` | 4–8 |
| Deploy dan rollback | Drill lama→baru→lama; `test_deploy_guard.py`; restore backup; drain; drill per flag; `auto_layout_downgrade.py`; reservation v2/v3 dua arah; `en-smoke` pasca-deploy baru di M9 | 4–11 |
| i18n | `i18n-catalog`, `-usage`, `-hardcoded` (ratchet), `-intl-literal`, `-registry`, `-resolve`, `-rsc-boundary`, `-error-codes` (Python `_MESSAGES` lewat subproses); kunci hilang = tes gagal; `en-smoke` di CI; `qps` hanya di dev; setiap kode baru (MU/sosmed/unduhan) punya `errors.*` di semua locale dan entri Bantuan | 1+ |
| UI | `ui-foundation`; `licenses`; bundle per rute terhadap baseline Fase 1 (editor: kenaikan hanya use-intl) | 1+ |
| Konkurensi | `queue-fairness`; crash matrix sosmed; scheduler dengan jam manual (DST Pacific); cache dua proses, SIGKILL, EXDEV, symlink tanam | 6–8 |

---

## 6. Migrasi dan rollback (ringkas)

**Boot pertama image multi-user (Fase 4):**
1. Backup (`DB_BACKUP=<path>`).
2. Migrasi `0001` dalam satu transaksi.
3. Bootstrap admin dari `APP_*`.
4. Smoke user dibuat atau diverifikasi.
5. Sejak Fase 6: impor `ingest-tokens.json`, salin logo/watermark default ke `users/<owner>/`.
6. Tidak ada job.json yang ditulis ulang. Job tanpa `ownerId` dimiliki `bootstrap_owner_id`.
7. `multiuser-migrate.mjs --dry-run|--apply` bersifat opsional.

| Lapisan | Mekanisme | Catatan |
|---|---|---|
| Image multi-user → single-user | Image lama mengabaikan DB dan `ownerId` | Semua job terlihat oleh login env. `APP_*` tetap valid. |
| Skema DB | Hanya aditif | Jangan rollback melewati migrasi contract. |
| Reservation | v3 lewat R1, lalu R2 | Diuji dua arah. |
| Cookie sesi | Proxy menerima dua bentuk | Break-glass: `admin-reset.mjs --admin`. |
| Sealing | Kotak v1 tetap terbaca | Mengganti secret membuat akun sosmed masuk status reauth. |
| Sosmed | `POTONGIN_SOCIAL=off` | Melewati R1 butuh compose yang cocok. |
| Reframe | `POTONGIN_AUTO_REFRAME=off` | Di bawah floor: `auto_layout_downgrade.py`. |
| Unduhan | `POTONGIN_FETCH_*`/`POTONGIN_MEDIA_CACHE=off` | `link` hanya untuk platform baru. Cache tidak pernah menjadi satu-satunya pemilik byte job. |
| Performa | Toggle / `POTONGIN_PERFORMANCE=off` | Tanpa profil, output byte-identik. |
| i18n | Image lama mengabaikan cookie dan `users.locale` | Error aditif; string `error` tetap ada. |
| Editor | `POTONGIN_EDITOR_SHELL` | Amandemen minor-0 ditolak server lama. |
| Backup DB | `VACUUM INTO`, simpan 14 | `integrity_check` di drill. |

**Penghapusan pengguna:**
- Hanya untuk user nonaktif tanpa proyek.
- Proyek dikosongkan lewat transfer admin atau hapus per proyek, dengan satu baris audit per proyek.
- Hook penghapusan juga menjalankan `disconnectAll`, purge sosmed, dan hapus data performa.

---

## 7. Risiko teratas

| # | Risiko | Mitigasi |
|---|---|---|
| 1 | Input anggota tak tepercaya dan IDOR di 49+ route | MU-M4b (termasuk inti `source-url.mjs`) **sebelum** undangan; `ownership-matrix`; `secureRoute owner:'job'` default |
| 2 | Layering CSS atau HeroUI merusak editor; navigasi klien tanpa COEP | Layer di Fase 1, tanpa RouterProvider, CSS editor identik, parity dan screenshot |
| 3 | Rollback otomatis gagal (`social-worker`, kredensial smoke, `en-smoke`) | R0/R1, `wait_social_health`, smoke user di Fase 4, `en-smoke` baru di M9, drill |
| 4 | Deploy terblokir job aktif | MU-M7b drain + runbook |
| 5 | Graf render > 3 GiB (Otomatis, N body, saklar per shot) | Spike RF-M2, satu skema `layout.ranges` sejak Fase 0, PF-SEG, override 3 mode |
| 6 | Disk produksi 81% | Ukur di Fase 0; cap 4 GiB; admission ruang kosong; pin yatim dihitung |
| 7 | Review platform dan kuota YouTube | SOS-M0 dimulai lebih awal; mode `admin`; `FILE_UPLOAD`; pesan jujur |
| 8 | i18n: locale bocor ke konten, error mematahkan klien, churn sekitar 1.400 literal, bundle editor | Error aditif; isolasi; kunci dibuat saat layar ditulis ulang; ratchet; root hanya `IntlProvider` |
| 9 | Kontaminasi AGPL | Nama §2.2-D; `en.json` dari `id.json` + glosarium; spot-check |
| 10 | Skala ≈ 400 hari-dev, bentrok merge | Tiap fase bisa dikirim sendiri; satu pemilik per file per fase; cadangan 20; opsional dipisah |

---

## 8. Keputusan yang dibutuhkan dari pemilik

| # | Keputusan | Default yang direkomendasikan | Tenggat |
|---|---|---|---|
| Q1 | Amandemen DESIGN.md/AGENTS.md (kepala halaman tanpa kalimat, chip bernilai, dua set status, HeroUI di atas token, copy dari katalog); label "Riwayat"→"Proyek", "Konteks Tren"→"Tren", "Menunggu"→"Antre"; `?klip=N` sebagai dialog; editor tanpa Mode Cepat/Lengkap; satu "Ekspor tetap" (§3.7); istilah publikasi | Setuju semua; **Terbitkan / Terbit** | G0 |
| Q2 | Dependensi: Node 24 + `node:sqlite`; HeroUI/RAC/Tailwind; `use-intl`; `@babel/parser` (dev) | Setuju. Cadangan: `better-sqlite3`, kamus sendiri berformat ICU, heuristik regex | G0 |
| Q3 | Akses: admin tidak membuka proyek orang lain; undangan saja; `APP_*` sebagai break-glass; user smoke; SMTP atau tautan manual | Ya; undangan; break-glass; smoke; tautan manual | Sebelum Fase 4 |
| Q4 | Berbagi: rantai AI, Groq, cookies YouTube, tren, token Hermes; cap LLM; **pemakaian ulang video publik dan transkrip lintas user lewat cache** | Diatur admin; berbagi dengan cap 200/hari; key env tidak dibagi; cookie global admin; tren instans + switch per anggota; cache `umum` lintas user ya, tanpa cookie | Sebelum Fase 5 |
| Q5 | Kapasitas: jumlah pengguna/job; kuota storage, job aktif/berjalan/per jam; concurrency/CPU; durasi maksimum | Concurrency 1 sampai diukur; 30 job/jam; 4 jam; kuota setelah angka pengguna ada | Sebelum Fase 6 |
| Q6 | Paket penghapusan otomatis di luar `/data/jobs` | Setuju sebagai satu paket | Sebelum Fase 4 |
| Q7 | Sosmed: app milik pemilik; verifikasi dan audit; penulis `/privasi`/`/ketentuan` dan email kontak; Instagram Login + fallback URL; platform pertama; batch; **cap per user (100 terjadwal, 20/jam); kuota YouTube siapa cepat atau jatah; hapus job membatalkan jadwal; file default = ekspor terbaru yang selesai** | Ya; mulai YouTube; `admin` sampai audit; `FILE_UPLOAD`; batch belakangan; cap 100/20; jatah harian per user; batalkan; ekspor terbaru + pilihan | Sebelum Fase 8 (pendaftaran app di G0) |
| Q8 | Waktu: zona jadwal dan format jam | Zona perangkat dengan nama zona ditampilkan; 24 jam di semua locale | Format jam di G0, zona sebelum Fase 8 |
| Q9 | Bahasa: kapan `en` dinyalakan ((a) setelah dashboard, (b) setelah editor, (c) ekstraksi cepat +5); penulis copy `en`; landing, `/privasi`, dan `/ketentuan` dalam `en`; bahasa awal pengguna baru; **bahasa undangan**; default "Bahasa video" untuk UI `en` | (b); pratinjau `id,en` hanya sebelum ada anggota; implementer menulis draf dan pemilik mereview per fase; Accept-Language; undangan memakai bahasa pilihan admin; Bahasa video tetap seperti sekarang | Penulis copy dan bahasa awal di G0; (a)/(b) di akhir Fase 3 |
| Q10 | Otomatis: default atau opt-in; dua pembicara di shot lebar; override 3 mode (split hanya `origin:auto` atau seluruh klip); **"Pakai di semua klip" mengantrekan analisis atau melewati dengan catatan**; label 20 jendela dan penilaian 10 klip | Opt-in sampai PF-PIPELINE; setuju 3 mode; mengantrekan analisis; pemilik melabeli | Sebelum Fase 5 (skema di Fase 0) |
| Q11 | Unduhan dan performa: range-only; proxy residensial; bgutil; Kick; metrik; ambang awal; toggle; contoh CSV; **klip yang diedit > 20% dikeluarkan; data performa privat atau agregat untuk admin; sikap kalau "tidak ada efek"** | Range-only dilewati; tanpa proxy berbayar; bgutil opt-in; Kick eksperimen mati; views 7 hari; toggle mati sampai retro; edit jauh dikeluarkan; privat per user; "tidak ada efek" diterima, M7 opsional | Unduhan sebelum Fase 7, performa sebelum Fase 9 |
| Q12 | Editor: batas gabung (job sama, ≤ 20 menit); kehadiran + rebase tanpa kunci; efek warna | Setuju; tanpa kunci; efek warna ditunda ke Fase 12 | Sebelum Fase 10 |