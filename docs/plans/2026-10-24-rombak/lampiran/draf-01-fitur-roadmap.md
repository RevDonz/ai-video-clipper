# Roadmap Rombak Potongin: menyerap fitur SupoClip (clean-room)

Dokumen ini menggabungkan lima desain workstream yang sudah dikritik dan direvisi: multi-user, posting sosmed, feedback loop performa, auto-reframe, dan unduhan sumber. Hasilnya satu roadmap bertahap. Isinya rencana saja; belum ada yang diubah, di-build, atau dijalankan di kedua repo.

---

## 1. Ringkasan

### Apa yang berubah
Potongin berubah dari alat satu pemilik menjadi layanan **multi-user** dengan empat kemampuan baru:

1. **Posting & jadwal sosmed.** Tiap pengguna menyambungkan akun YouTube, TikTok dan Instagram (profesional) miliknya sendiri. Klip bisa diposting sekarang atau dijadwalkan, lalu metriknya (views, likes, comments, shares) ditarik kembali.
2. **Feedback loop performa.** Hasil posting menjadi profil per pengguna, berbentuk angka saja. Profil ini memberi dorongan kecil, positif dan dibatasi, pada pemilihan momen Selection V3, dan hanya bekerja sebagai penentu seri.
3. **Auto-reframe per shot ("Otomatis").** Tiap shot ditampilkan sebagai Ikuti wajah, Latar blur atau Layar terbagi. Graf render-nya punya jumlah konteks filter yang tetap.
4. **Unduhan sumber yang lebih tangguh.** Rinciannya:
   - preflight metadata sebelum byte media pertama;
   - analisis audio-first sementara video penuh diunduh paralel;
   - cache media lintas job, ditambah cache transkrip;
   - Twitch, dan Kick secara eksperimental;
   - opsional: PO token bgutil dan proxy sticky.

   Unduhan per rentang (range-only) **ditunda** ke milestone terpisah yang punya gerbang keputusan (§3, Fase 7).

### Kenapa
- Pemilik ingin satu instans dipakai beberapa orang. Multi-user menjadi fondasi isolasi data, kunci, kuota dan antrean untuk tiga fitur lainnya.
- ROADMAP.md §1 masih mencatat "data retensi nyata (YouTube/TikTok analytics)" sebagai kekurangan. Posting dan metrik menutup lubang itu. STANDAR_KLIP_AI.md juga menyebut data retensi nyata lebih diutamakan daripada gold proksi.

### Bentuk arsitektur yang dipertahankan
- `JOBS_ROOT/<uuid>/job.json` tetap menjadi sumber kebenaran job. Ia hanya mendapat `ownerId`. Tidak ada tabel job dan tidak ada dual-write.
- Data kontrol baru (identitas, sosmed, registry posting, metrik, ledger unduhan) disimpan di **satu SQLite** di `/data`.
- Python tetap tidak tahu pemilik dan tidak pernah membuka DB.
- Rollback tetap berbasis image. Migrasi hanya boleh aditif. Fitur besar dirilis expand-then-enable di balik flag.

### Prinsip clean-room (wajib untuk semua fase)
- **Implementer tidak membuka repo SupoClip.** Mereka bekerja hanya dari dokumen ini, kode Potongin, CONTRACTS.md dan dokumentasi resmi platform. Bacaan SupoClip berhenti di tahap desain ini dan hanya dipakai sebagai catatan perilaku dan daftar edge case.
- Setiap konstanta harus diturunkan sendiri:
  - ambang reframe dari sweep dev-split Potongin, dicatat di AUTO_REFRAME.md;
  - batas refresh metrik dari anggaran kuota YouTube (10k unit/hari, `videos.list` 1 unit per 50 id), bukan angka 200;
  - ambang A/V unduhan = 1 frame pada fps sumber, diukur di M0;
  - angka platform dikutip di SOSMED.md beserta tautan dan tanggal akses.
- Penamaan memakai idiom Potongin: `sources/`, `pieces[]`, `tracks{}`, placeholder `{sesi}`, kode alasan reframe Potongin. Taksonomi error sosmed diturunkan dari state machine checkpoint Potongin sendiri. Nama tes ditulis dari kontrak CONTRACTS.md, bukan dari nama tes SupoClip.
- Setiap PR menyatakan bahwa SupoClip hanya dipakai sebagai catatan perilaku. Reviewer memeriksa sampel kode untuk identifier, konstanta, struktur modul atau string yang mirip SupoClip. Fokus utamanya `web/lib/social/providers/*`, `src/ai_clipper/edit_v2/shots.py` dan `src/ai_clipper/fetch/*`.
- Tidak ada kode SupoClip yang ditempel di dokumen, PR, komentar atau fixture.

### Skala
- Inti: sekitar **191 hari-developer**. Rinciannya: multi-user 47, sosmed ~34 (36 dikurangi 2 karena metrik digabung), feedback 26, reframe 40, unduhan 37, ditambah ~8 hari cadangan integrasi lintas fase.
- Opsional: sekitar 23 hari (range-only 12, stage layout 5, eksperimen prompt 3, perbaikan audit 3).
- Waktu kalender untuk review platform (Google, TikTok, Meta) terpisah, kira-kira 2–6 minggu atau lebih.

---

## 2. Keputusan arsitektur lintas-workstream

### 2.1 Persistence: satu SQLite control plane, job tetap file
- **Lokasi dan setelan.** SQLite di `POTONGIN_DB_PATH` (default `/data/potongin.sqlite`, mode 0600), di luar `JOBS_ROOT` dan `POTONGIN_SETTINGS_DIR`; startup menolak jika path ada di dalam salah satunya. Pragma: WAL, `busy_timeout` 5000, `foreign_keys` ON. Driver: `node:sqlite` DatabaseSync, yang sinkron dan menjadi dasar kontrak guard sinkron di §2.2.
- **Modul.** `web/lib/db/index.mjs` (singleton plus `tx(fn)` dengan BEGIN IMMEDIATE) dan `web/lib/db/migrations/NNNN-*.sql`. Migrasi hanya aditif dan dijaga lint test. Kode cukup memeriksa `schema_version >=` minimum, sehingga image lama tetap jalan di skema baru.
- **Pemilik tabel:**

  | Migrasi | Pemilik | Tabel |
  |---|---|---|
  | 0001 | multi-user | users, sessions, invites, password_resets, api_tokens, instance_settings, audit_events, meta |
  | 00xx | sosmed | social_accounts, oauth_states, social_posts (lifecycle publish), social_quota |
  | 00xx | registry bersama | `posts` (lihat §2.7) |
  | 00xx | feedback | metric_snapshots (append-only), metric_horizons (cache yang bisa dibangun ulang) |
  | 00xx | unduhan | download_ledger (M7) |
  | 00xx | multi-user | shared_llm_usage (cap harian) |

- **Proses yang boleh membuka DB:** hanya `app`, `primary-worker` dan `social-worker`. Render-worker, CLI `web/scripts/render-storage-admission.mjs` dan semua proses Python tidak pernah membukanya. Ini dijaga oleh `deploy-env-contract.test.mjs`.
- **Konflik 1.** Desain sosmed memakai file SocialStore dengan satu `.social.lock` global. Desain multi-user hanya mengizinkan app dan primary-worker membuka DB. **Resolusi:**
  - SocialStore diimplementasikan langsung di SQLite: klaim memakai conditional UPDATE, lease ber-fence sebagai kolom. Implementasi file hanya dipertahankan sebagai double di tes, atau dihapus.
  - `social-worker` ditambahkan ke daftar proses yang boleh membuka DB.
  - Aturan "tidak ada I/O jaringan di dalam transaksi" tetap berlaku, termasuk refresh token dua fase (lease, panggil platform tanpa tx, lalu CAS `tokenGeneration`).
- **Konflik 2.** Feedback ingin `/data/performance/<uid>/*.jsonl` bila tidak ada DB. **Resolusi:** DB sudah ada, jadi metrik masuk tabel. Ekstraksi `web/lib/json-store.mjs` dari `web/lib/trend-context.mjs` tetap dikerjakan (setting dan cache masih file), tetapi tidak lagi menjadi jalur penyimpanan metrik.
- **Yang tetap file:** job.json, setting tersegel per user (`POTONGIN_SETTINGS_DIR/users/<id>/`), setting instans di root (bisa dibaca image rollback), shot/camera plan di dir klip, pin media sosmed, dan cache media (Python membutuhkannya).
- **Backup.** `web/scripts/db-backup.mjs` menjalankan `VACUUM INTO /data/backups/potongin-<utc>.sqlite` (0600, simpan 14). `deploy/production.sh` menjalankannya sebelum `up -d` dan mencetak `DB_BACKUP=<path>`. Salinan mentah DB yang sedang hidup dilarang.

### 2.2 Auth dan otorisasi
- **Peran dan login.** Dua peran (`admin`, `member`). Sesi `__Host-potongin_session = s2.<sid>.<secret>` dengan hash di DB, absolut 30 hari, dan revoke saat logout, ganti sandi, nonaktif, atau "Keluar dari semua perangkat". Password memakai scrypt dan dummy hash untuk username tak dikenal.
- **Kontrak sinkron.** `currentUser`, `requireUser` dan `requireAuth` sinkron. Alasannya, `web/lib/security-headers.mjs:147` dan 9 call site di lib (editor-ai, clip-edit, clip-renders, asset-upload, default-logo, youtube-cookies, llm-settings-http, trend-context) memanggil `authorize` tanpa `await`. Dijaga oleh `authorize-sync-contract.test.mjs`.
- **Akses lintas pemilik.** Job atau klip milik orang lain dijawab **404 yang identik** dengan job yang tidak ada, tanpa spawn Python. Admin tidak punya akses implisit. Transfer dan hapus proyek pengguna lain hanya lewat aksi admin yang diaudit.
- **Seam principal sosmed dihapus.** Desain sosmed membuat `web/lib/social/principal.mjs` dengan userId `'owner'` sementara. Karena multi-user dikerjakan lebih dulu (Fase 1–3), sosmed memakai `requireUser` langsung dan semua record dikunci `users.id` asli sejak record pertama. `POTONGIN_SOCIAL=admin` berarti hanya peran admin; `on` berarti semua pengguna.
- **Jalur yang mengautentikasi dirinya sendiri** dicantumkan di `web/tests/proxy-matcher.test.mjs`, masing-masing dengan alasan:
  - `api/auth/invite`, `api/auth/reset`;
  - halaman `undangan` dan `atur-ulang-sandi`;
  - `api/performance/import`, opsional `api/ingest/metrics`;
  - `api/social/meta/{deauthorize,data-deletion}`, dan fallback `api/social/media/[token]` bila dipakai.

  Halaman publik `/privasi` dan `/ketentuan` memakai cek exact-path di `proxy()`, mengikuti pola `/` dan landing media.
- **Token API.** `web/lib/api-tokens.mjs` berbasis DB dengan format `ptk_` yang sama. Scope: `trends:read`, `trends:write` (admin), `metrics:write` (feedback), dan cadangan `jobs:read`, `jobs:write`, `posts:write`, `metrics:read`. File `ingest-tokens.json` diimpor beserta hash-nya, dan file aslinya dibiarkan untuk rollback.

### 2.3 Antrean dan worker
- **Antrean primary.** `web/lib/primary-job-queue.mjs` menerima policy klaim lewat injeksi, sehingga modulnya tetap bebas DB. Owner yang dipilih adalah yang punya `lastServedAt` tertua, dari `queue.firstClaimedAt` yang dipertahankan sampai status terminal. Di dalam satu owner berlaku FIFO, dengan `max_running` per owner. Admission per owner ditolak dengan 429 `user_queue_full`. Reservation v3 dirilis dua kali (expand, lalu contract).
- **Render-worker.** `src/ai_clipper/render_worker.py` memakai round-robin per `ownerId` (yang kosong dianggap `legacy`). Ini **harus masuk sebelum** reframe Otomatis dinyalakan.
- **Social-worker.** Container sendiri (cpus 0.5, mem 512m, `stop_grace_period: 120s`, healthcheck heartbeat) yang menampung scheduler posting **dan** due-list refresh metrik feedback. **Konflik 3:** desain sosmed punya `metrics.mjs` dengan jadwal tetap +1 jam…+30 hari, sedangkan feedback punya `metrics-refresh.mjs` dengan tier umur sampai 90 hari. **Resolusi:**
  - Satu due-list saja, yaitu `web/lib/metrics-refresh.mjs` dengan tier milik feedback.
  - Provider sosmed hanya menyediakan adapter `fetchMetrics(account, externalIds[])`.
  - Kuota YouTube untuk upload dan baca metrik dihitung dalam satu `social_quota`.
- **Unduhan.** Unduhan tetap berjalan di primary-worker di bawah `runFencedProcess`. Untuk analisis Otomatis, `prepare_auto` berjalan di jalur pipeline dan render, menunggu handshake source-ready.
- **Deploy.** Deploy tidak di-gate oleh pekerjaan sosmed. Social-worker berhenti mengklaim saat SIGTERM, lalu melanjutkan dari checkpoint.

### 2.4 Storage dan retensi
- **Data job tetap tidak pernah dihapus otomatis.** Pengecualian baru semuanya berada **di luar** `JOBS_ROOT`, dicantumkan di bagian baru STORAGE_RETENTION.md ("Metadata kontrol, cache dan data platform"), dan butuh persetujuan pemilik (Q5):
  - **Audit dan metadata:** audit >180 hari; sesi, undangan dan reset yang kedaluwarsa; backup DB lebih dari 14.
  - **Cache media** `/data/media-cache`: default cap 4 GiB, TTL 3 hari; dibuat saat runtime (bukan di Dockerfile); `st_dev` harus sama dengan JOBS_ROOT; isinya di-hard-link ke job, sehingga job tetap memegang byte-nya sendiri.
  - **Pin sosmed** `/data/social/media/<postId>.mp4`: dibuang 1 jam setelah published; untuk posting failed, cancelled atau maybe_sent disimpan sampai dihapus atau `SOCIAL_PIN_KEEP_DAYS` (7).
  - **Data platform yang diwajibkan kebijakan:** nilai mentah YouTube API yang lebih dari 30 hari tanpa refresh diciutkan menjadi agregat turunan; purge saat disconnect; callback deauthorize dan data-deletion Meta.
- **Konflik 4.** Feedback ingin snapshot mentah append-only yang tidak pernah dipadatkan, sedangkan kebijakan YouTube API mewajibkan refresh atau hapus dalam 30 hari. **Resolusi:**
  - Snapshot CSV, manual dan agen tidak pernah dihapus otomatis.
  - Snapshot bersumber API mengikuti aturan platform. Tier feedback (mingguan sampai 90 hari) menjaga data tetap ter-refresh selama jendela aktif.
  - Setelah berhenti di-refresh, nilai mentah YouTube diciutkan menjadi agregat yang disepakati, misalnya persentil d7 relatif median akun. Pembolehan agregat ini diverifikasi di M0 sosmed.
  - Horizons tetap menjadi cache yang bisa dibangun ulang.
- **Akuntansi storage:**
  - kuota per user dihitung oleh `web/lib/user-storage-usage.mjs`, dicek di app saat POST `/api/jobs`, recheck upload, dan saat ekspor dibuat di `web/lib/clip-renders.mjs`;
  - CLI render-worker hanya memeriksa batas global;
  - pin yatim (link count 1) masuk status storage dan admission;
  - ukuran cache ditampilkan di Tentang sistem;
  - penulisan cache hanya diizinkan bila ruang kosong > `JOBS_STORAGE_MIN_FREE_BYTES + JOBS_STORAGE_ACTIVE_RESERVE_BYTES + perkiraan`. Ingat, disk produksi sudah 81% terisi dan dipakai aplikasi lain.
- **Scope cache.** Analisis scan reframe disimpan di dir klip, dan cache scan apa pun dikunci `(owner_id, source sha, window, grid fps, rules_id)`. Cache media memakai scope `umum` (tanpa kredensial) atau `u-<ownerId>` (dengan cookie). Berbagi `umum` lintas user menunggu Q3.

### 2.5 Konfigurasi
- **Flag operator di env** mengikuti pola `POTONGIN_AUTO_PAUSE_TRIM`: rilis `off`, lalu canary, lalu `on`. Mengubah flag cukup dengan `docker compose up -d`, tanpa rebuild. Daftar flag:
  - `POTONGIN_SOCIAL=off|admin|on`
  - `POTONGIN_PERFORMANCE`
  - `POTONGIN_AUTO_REFRAME`
  - `POTONGIN_FETCH_AUDIO_FIRST`, `POTONGIN_MEDIA_CACHE`, `POTONGIN_MEDIA_CACHE_BYTES`, `POTONGIN_MEDIA_CACHE_TTL_DAYS`
  - `POTONGIN_FETCH_TWITCH`, `POTONGIN_FETCH_KICK`
  - `POTONGIN_POT_PROVIDER_URL`
  - `POTONGIN_MAX_SOURCE_SECONDS`
  - `POTONGIN_FETCH_SECTIONS` (fase opsional)

  Semua masuk `.env.example` dan dijaga `web/tests/env-example.test.mjs`.
- **Ambang statistik** hanya diatur operator: `POTONGIN_PERF_MIN_POSTS` (lantai 20) dan `POTONGIN_PERF_HORIZON`. Mengubahnya butuh re-gate yang terdokumentasi. Pengguna hanya punya toggle `useInSelection`.
- **Setting instans** (`signup_mode`, saklar berbagi LLM dan cookie, cap harian LLM bersama) disimpan di tabel `instance_settings`. Preferensi per user disimpan di `users/<id>/prefs.json`.
- **Batas durasi sumber** = min(`POTONGIN_MAX_SOURCE_SECONDS` global, `users.max_source_seconds`). Dicek di preflight unduhan sebelum byte pertama. **Konflik 5:** multi-user dan unduhan sama-sama mendefinisikan cek ini. Diresolusi menjadi satu cek di preflight `fetch`.
- **Runtime: Node 24 LTS** `bookworm-slim`, di-pin dengan digest, termasuk di CI. Desain sosmed menyebut Node 20 `fetch duplex:'half'`; itu ikut berpindah ke Node 24.

### 2.6 Secrets
- **Satu helper `web/lib/sealing.mjs`** (v2, HKDF dengan purpose dan scope `userId|instance`). **Konflik 6:** sosmed dan setting jaringan unduhan masing-masing merencanakan helper sealing sendiri. Diresolusi menjadi satu helper dengan purpose `llm`, `cookies`, `transcription`, `oauth-token` (AAD `account:<id>\0<access|refresh|upload>`), `social-app` dan `download-network`. Kotak v1 di root tetap terbaca lewat jalur lama. `llm-settings.mjs` mempertahankan info, salt dan AAD lamanya, dan tesnya tidak diubah.
- `POTONGIN_SETTINGS_SECRET` menjadi wajib (`:?`). Runbook menyalin nilai `APP_SESSION_SECRET` ke sana. Self-check saat startup memberi peringatan berbahasa Indonesia jika tidak cocok.
- **Env engine per pemilik job** (`web/lib/owner-env.mjs`):
  - semua key LLM dan Groq dari env dibuang;
  - rantai milik owner ditambahkan, atau rantai instans hanya untuk admin atau bila berbagi aktif;
  - jika tidak ada keduanya, `POTONGIN_LLM=off`.
- Proxy unduhan ditulis ke file config temp (0600) yang dilewatkan dengan `--config-locations`. Proxy tidak pernah muncul di argv, env, log, job.json atau response. Cookie default tidak lewat proxy.
- Social-worker memakai allowlist env: secret setting, `POTONGIN_PUBLIC_URL`, `SOCIAL_*`. Tidak ada env LLM atau engine.

### 2.7 Kontrak bersama
- **Nama field pemilik: `ownerId`.** Desain sosmed menulis `ownerUserId`; diseragamkan menjadi `ownerId`.
- **Registry posting.** **Konflik 7:** sosmed merasa memiliki PostRecord, sementara feedback juga membuat PostRecord lewat CSV. **Resolusi:**
  - Tabel `posts` dan modul `web/lib/post-registry.mjs` adalah kontrak bersama.
  - Fase 5 (sosmed) yang membuatnya.
  - `createPost({ownerId, jobId, clipId, provider, url|externalId, origin})` menghitung `selectionKeys` di sisi server dari manifest.
  - `social_posts` menyimpan lifecycle publish dengan FK ke `posts`.
  - Feedback hanya memiliki metrik.
- **Kunci seleksi.** `selectionKeys` adalah fitur pada saat seleksi (archetype, bucket durasi `[0,20)…[60,∞)`, hookStyle), dihitung oleh satu aturan: Python sebagai referensi dan JS mirror di `web/lib/performance-keys.mjs`, dijaga tes paritas. Fitur posting (`postedFeatures`) hanya untuk analitik. Teks hook kanonik (hook proposal sebelum packaging, atau `selection_keys` yang ditulis engine ke manifest) diputuskan di kontrak Fase 0 dan dikunci oleh round-trip test.
- **Snapshot packaging.** `snapshotClipPackaging(job, clip, source)` dan `servedClipText(job, clip)` adalah ekspor di `web/lib/jobs.mjs`. `serializePublicJob` dan composer posting memakai fungsi yang sama.
- **Kunci join metrik** = `(ownerId, jobId, clipId)`. `sourceKey` = kunci video kanonik unduhan (`platform:mediaId`), bukan hash konten.
- **Layout.** Reframe mengeluarkan `layout_summary` di metadata render klip. Field ini dipakai sebagai `postedFeatures.layout`.
- **Namespace unduhan** memakai `fetch`/"Unduhan sumber" (`src/ai_clipper/fetch/`, `web/lib/fetch-*.mjs`, `/api/settings/download-network`), supaya tidak bentrok dengan `ingest` milik API tren.
- **Nomor CONTRACTS.md.** **Konflik 8:** sosmed dan reframe sama-sama mengklaim §5.59. **Alokasi tentatif:** §5.59 multi-user (kepemilikan, guard sinkron); §5.60 posting sosmed; §5.61 registry posting dan snapshot packaging; §5.62 profil performa v1; §5.63 auto-reframe / shot-plan; §5.64 skema sumber link dan cache media. Nomor final ditetapkan saat merge.

### 2.8 Deploy dan compose
- **Layanan.** `app`, `primary-worker`, `render-worker`, ditambah `social-worker` sejak Release A sosmed (Fase 3), ditambah `pot-provider` di profil `pot`. `pot-provider` ada di bridge `pot` miliknya sendiri (tidak `internal`, karena butuh egress HTTPS), tanpa `ports:`, `read_only`, `cap_drop ALL`, dan hanya tersambung ke primary-worker.
- **Urutan perubahan `deploy/production.sh`:**
  - Fase 1: backup DB dan kredensial smoke `E2E_SMOKE_USERNAME/PASSWORD` di `run_read_only_e2e`.
  - Fase 3: `SOCIAL_CONTAINER`, `wait_social_health`, `verify_runtime_identity` untuk empat container.
  - Fase 3 juga: catatan bahwa rollback melewati Release A butuh checkout `compose.yaml` yang cocok.

  Setiap perubahan dijaga tes skrip deploy (`deploy-env-contract.test.mjs` / `tests/test_deploy_guard.py`).
- **Konflik 9: pemicu rollback otomatis.** Jika e2e pasca-deploy tetap login dengan `APP_*`, deploy akan rollback otomatis begitu pemilik mengganti sandi. Diresolusi di Fase 1, bukan di akhir.

### 2.9 Prasyarat lintas semua UI
- Pekerjaan UI multi-user (Pengaturan Pribadi/Instans, `/admin/pengguna`, `/akun`), nav sosmed dan nav performa baru dimulai setelah PR **Redesign UX** (`feat/ux-redesign-workspace`) di-merge. PR itu menyentuh `web/lib/app-nav.mjs`, `web/lib/app-menu.mjs`, `web/app/settings/page.jsx` dan `.pageHead`.
- Nav dinamis memakai `navGroups(pathname, {social, performance})` dengan sumber runtime `GET /api/social/providers` dan status performa.
- Semua copy berbahasa Indonesia, mengikuti DESIGN.md, memakai antislop mode during, tanpa label versi atau kata "baru".

---

## 3. Urutan fase

Fase dirilis berurutan, tetapi jalur Python reframe berjalan paralel karena hampir tidak menyentuh file web multi-user. Setiap fase bisa dikirim dan di-rollback sendiri.

| Fase | Isi | Hari-dev (inti) | Bergantung pada |
|---|---|---|---|
| 0 | Persiapan, kontrak, Node 24, pengukuran | 15,5 | merge PR Redesign UX (untuk UI) |
| 1 | Fondasi identitas | 7,5 | F0 (Node 24) |
| 2 | Kepemilikan dan rahasia per user, ditambah reframe analisis/compiler (paralel) | 14 + 14 paralel | F1 |
| 3 | Multi-user siap untuk anggota, ditambah reframe rollback floor, ditambah sosmed Release A (gelap) | 23 + 8 + 5 | F2 |
| 4 | Unduhan sumber tahap A, ditambah Otomatis menyala (paralel) | 32 (+2 Kick) + 14 | F3 (M7 multi-user) |
| 5 | Posting dan jadwal sosmed | 25 | F3, M0 sosmed |
| 6 | Feedback loop performa | 25 | F5 (registry, adapter) |
| 7 | Opsional dan audit platform | ~23 + kalender | per item |
| — | Cadangan integrasi lintas fase | ~8 | — |

### Fase 0: Persiapan, kontrak, runtime (≈15,5 hari, sebagian paralel)
**Tujuan.** Mengunci kontrak dan angka sebelum kode fitur ditulis. Pindah ke Node 24. Pemilik mulai mendaftarkan aplikasi platform sekarang, karena review platform memakan waktu kalender.

**Milestone:**
- MU-M0 Node 24 LTS (2,5): ganti digest `NODE_IMAGE` di Dockerfile:9; `node-version` 24 di `.github/workflows/{ci-cd,editor-gates,ytdlp-update}.yml`; toolchain stamp baru; verifikasi stabilitas `node:sqlite` dan bahwa peringatannya tidak mencemari stderr yang di-parse.
- FB-M0 spesifikasi (2): `resources/performance/rules.v1.json` dibekukan (bucket, hookForm, `LIFT_FULL=0.25`, cap); kontrak snapshot v1; kontrak registry posting yang disetujui sosmed dan multi-user; minta contoh header ekspor CSV dari pemilik.
- SOS-M0 (3, ditambah pekerjaan pemilik): verifikasi setiap batas platform dan kewajiban retensi data; cek ketersediaan resumable upload Instagram; tulis SOSMED.md lengkap dengan sumber; pemilik mendaftarkan app Google, TikTok dan Meta dalam mode testing.
- FETCH-M0 (3): pengukuran di CI (`editor-gates.yml suite=command`). Yang diukur: pilihan audio asli versus `ba` (Opus vs AAC), waktu sampai seleksi, minting bgutil dengan dan tanpa proxy, proxy lewat file config tidak muncul di `/proc` cmdline, Kick dengan/tanpa curl_cffi, dan data awal untuk range-only.
- RF-M0 (4): `scripts/eval/auto_reframe.py`, sekitar 40 jendela berlisensi terbuka di `TRAINING_SOURCE_REGISTRY.json`, label cut pada grid doc, dan gerbang ditulis di AUTO_REFRAME.md sebelum test split dijalankan.
- Alokasi nomor CONTRACTS.md (§2.7) dan protokol clean-room di AGENTS.md (1).

**Kriteria selesai:**
- ci-cd dan editor-gates full hijau di Node 24, dengan bukti toolchain P-TIME/P-TXT/P-ENC/P-COLOR/P-RT dan tanpa ambang yang diubah.
- PR kontrak (docs-only) di-merge.
- `docs/evaluation/UNDUHAN_M0.md` berisi keputusan go/no-go untuk Kick, bgutil dan range-only.
- Baseline reframe (camera hari ini) dilaporkan di dev split.
- Pemilik menjawab pertanyaan di §8 yang memblokir Fase 1–3.

**Yang dirasakan pengguna:** tidak ada perubahan, hanya runtime baru. **Rollback:** image sebelumnya.

### Fase 1: Fondasi identitas (≈7,5 hari)
**Tujuan.** Ada DB, akun dan sesi di server, tanpa mengubah perilaku untuk pemilik.

**Milestone:** MU-M1 (DB, migrasi 0001, backup di production.sh) dan MU-M2 (passwords, sessions s2, transisi cookie v1 ke s2 dengan proxy menerima dua bentuk cookie, bootstrap admin dari `APP_*`, `currentUser`/`requireUser` sinkron, `sessionFromCookieStore` untuk 3 halaman server dan `parity-fixtures`, `admin-reset.mjs --admin/--ensure-smoke-user`, kredensial smoke di `run_read_only_e2e`).

**Kriteria selesai:**
- Migrasi idempoten, dan skema yang lebih baru diterima kode lama.
- Backup lolos `integrity_check`.
- Cookie v1 pemilik di-upgrade sekali.
- Logout me-revoke di server.
- `authorize-sync-contract` hijau. Ambang `login-rate-limit` tidak berubah.
- Spec read-only dan smoke lolos dengan anggota smoke yang daftar proyeknya kosong.
- `deploy-env-contract` memastikan `E2E_SMOKE_*` dipakai.
- gitleaks bersih.

**Yang dirasakan pengguna:** login sama seperti sebelumnya. Logout benar-benar mencabut sesi. **Rollback:** image lama mengabaikan DB; `APP_USERNAME/APP_PASSWORD` tetap valid di `.env`.

### Fase 2: Kepemilikan dan rahasia per user (≈14 hari), plus jalur paralel reframe Python (≈14 hari)
**Tujuan.** Setiap route, halaman dan proses engine tunduk pada pemilik. Ini **syarat mutlak sebelum ada anggota non-tepercaya.**

**Milestone multi-user:**
- MU-M3 (8): `ownerId` saat create; `web/lib/job-ownership.mjs`; `secureRoute` dengan opsi `owner: 'job'` dan `role`; migrasi 49 route, lib route dan 4 consumer cookie langsung; listing yang difilter per owner; `serializePublicJob` membuang `ownerId`; `route-guard-coverage` dan `ownership-matrix` diterapkan ke seluruh tree `app/api`; `web/e2e/multiuser-isolation.spec.mjs`.
- MU-M4 (6): `sealing.mjs` v2; argumen `scope` di modul setting; `owner-env.mjs` dengan pembuangan key LLM env; `run-job.mjs`, `python-cli.mjs`, `editor-ai.mjs` dan `clip-text-api.mjs` me-resolve env menurut pemilik job; `POTONGIN_SETTINGS_SECRET` wajib; Pengaturan Pribadi/Instans setelah UX PR; cap harian LLM bersama.

**Milestone reframe (paralel, Python saja, tanpa perubahan render):**
- RF-M1 (6): evidence mode di `face_window.py` (diff stride di semua interval, termasuk tanpa wajah); `shot_context.py`; `edit_v2/shot_cuts.py` (refinement FFmpeg di grid render); `edit_v2/shots.py`; `prepare_auto` yang memakai ulang camera plan hari ini.
- RF-M2 (8): **spike graf terlebih dahulu** (`scripts/parity/auto_graph_spike.py`: fallback chain plus satu split chain lewat overlay/streamselect/maskedmerge, dibandingkan concat K chain pada 1, 8 dan 48 run). Setelah itu: validator, `shot_frames`, `Compiler.layout` cabang auto, `plate_key` dan `shots_for`.

**Kriteria selesai:**
- Untuk setiap route dan method, user B memakai id milik A mendapat 404 yang identik, tanpa spawn Python palsu. Admin tanpa opt-in juga mendapat 404.
- Anggota dengan berbagi mati mendapat env anak tanpa key LLM/Groq meskipun `GROQ_API_KEY` ada di env, dan job selesai dengan heuristik.
- Kotak tersegel lintas user atau lintas purpose gagal dibuka.
- Reframe:
  - byte camera plan tidak berubah di semua fixture dan `camera_real`;
  - cut di dev split P ≥ 0,95 dan R ≥ 0,90 pada ±1 frame grid (termasuk VFR, 59,94→29,97 dan 60→30);
  - scan di CI ≤ 15 detik + 0,5 detik per cut;
  - graf terpilih < 3 GiB `RLIMIT_AS` dengan jumlah konteks yang tidak tumbuh;
  - frame md5 identik dengan pure chain;
  - semua graf, plan sha dan plate key non-auto dipin tidak berubah;
  - `RENDER_SEMANTICS` tetap 2.

**Yang dirasakan pengguna:** Pengaturan terbagi Pribadi/Instans, belum ada anggota. **Rollback:** image. Job lama terlihat oleh login env, dan `ownerId` diabaikan. Validator reframe yang sudah meluas ini menjadi bagian dari "rollback floor" reframe.

### Fase 3: Multi-user siap untuk anggota (≈23 hari), plus reframe floor (≈8 hari), plus sosmed Release A (≈5 hari)
**Tujuan.** Pemilik bisa mengundang anggota dengan aman: kuota, antrean adil, token, admin dan runbook migrasi.

**Milestone multi-user:**
- MU-M5 (5): `/admin/pengguna` dan `/admin/pengguna/<id>` (dengan "Pindahkan proyek ke…" dan "Hapus proyek pengguna ini"), `/akun`, `/undangan/[token]`, `/atur-ulang-sandi/[token]`, audit, kode Bantuan.
- MU-M6 (2,5): token API per user; impor `ingest-tokens.json`; tren berlaku instans-wide dengan switch per anggota.
- MU-M7 (4): fairness `lastServedAt`, reservation v3 (R1 lalu R2), bucket 30 job per jam, round-robin di render-worker.
- MU-M8 (3,5): kuota storage per user.
- MU-M9 (4): `multiuser-migrate.mjs`, `docs/operations/PENGGUNA.md`, drill rollback di CI.
- Cadangan (4).

**Milestone paralel:**
- RF-M3 (4): seed, pipeline dan CLI auto; pemetaan legacy auto→fit-blur lewat `engine_fallback`; flag `POTONGIN_AUTO_REFRAME=off`; `scripts/ops/auto_layout_downgrade.py`. Dirilis sebagai **release 1 dengan flag mati = rollback floor**.
- RF-M4 (4): penyetelan split dan group framing di dev split, lalu satu kali run test split.
- SOS-M1 Release A (5): `web/lib/social/{store,errors,redact,http,scheduler,apps}.mjs` di atas DB dan `sealing.mjs`; layanan `social-worker` yang hanya heartbeat selama `POTONGIN_SOCIAL=off`; perubahan production.sh untuk empat container; gerbang fake-origin tiga lapis.

**Kriteria selesai:**
- `queue-fairness`: A mengantrekan 10 job, B mengantrekan 1 belakangan, dan B menjadi klaim ke-2 pada concurrency 1.
- Pengguna yang melewati kuota mendapat 507 sebelum ada byte atau render request ditulis.
- CLI render-worker berjalan tanpa `POTONGIN_DB_PATH`.
- Drill CI lama→baru→lama hijau.
- e2e produksi lolos dengan kredensial smoke setelah pemilik mengganti sandinya.
- Release A ter-deploy dengan worker healthy dan restart count 0.
- Reframe: test split agreement ≥ 85%, multi SPEAKER_FRAMING ≤ 21,7%, dan pemilik menerima ≥ 8 dari 10 klip split.

**Yang dirasakan pengguna:** pemilik bisa mengundang anggota. Ada halaman Akun dan Kelola pengguna. Antrean adil per orang. Otomatis belum terlihat. **Rollback:** image, dalam batas ini:
- jangan rollback melewati migrasi contract;
- reservation v3 aman karena R1 membaca v2 dan v3;
- rollback melewati Release A sosmed butuh `compose.yaml` yang cocok;
- rollback di bawah reframe floor butuh skrip downgrade.

### Fase 4: Unduhan sumber tahap A (≈32 hari, +2 bila Kick go), plus Otomatis menyala (paralel ≈14 hari)
**Tujuan.** Unduhan lebih cepat dan lebih tahan gagal tanpa risiko timeline. Mode Otomatis dirilis ke pengguna.

**Milestone unduhan:**
- FETCH-M1 (5): `web/lib/source-url.mjs` dan `src/ai_clipper/fetch/platforms.py` dengan fixture bersama; `isLinkSource()` di **semua** pembaca, termasuk `web/lib/primary-job-queue.mjs:816` (publikasi `input/`); preflight `-J` dan `fetch/probe.py`; kode error baru; guard CI terhadap `type === "youtube"`.
- FETCH-M2 (5): cache media dan amandemen retensi.
- FETCH-M3 (6): engine `--analyze-audio/--media-duration`, handshake source-ready, video penuh diunduh paralel dengan audio yang sama (`bv*[height<=H]+<idAudio>`), cache transkrip.
- FETCH-M4 (3): Twitch.
- FETCH-M5 (2): Kick, hanya jika M0 go.
- FETCH-M6 (5): proxy tersegel dan bgutil.
- FETCH-M7 (3): ledger per user. Sudah tidak terblokir karena multi-user selesai.
- FETCH-M8 (2): workflow yt-dlp mingguan.
- FETCH-M10 (3): rollout dan drill.

**Milestone reframe:**
- RF-M5 (9): editor. Kartu Otomatis, segmen VideoLane, `ShotPopover`, command, `apply-all` hanya menyalin mode, draft-store.
- RF-M6 (5): gerbang P-FRAME, P-PLATE, P-JOIN-B, PF-RENDER dan PF-PIPELINE. Release 2 menyalakan flag setelah pemilik setuju.

**Kriteria selesai:**
- Dengan flag mati, argv yt-dlp identik dengan hari ini (snapshot test).
- Job berbentuk Twitch mempublikasikan `input/` dan `sourcePath` ditulis ulang.
- Dua proses yang mengunduh video yang sama hanya mengunduh sekali.
- Penyapuan cache menolak path di bawah `JOBS_ROOT`.
- Episode eval menghasilkan klip yang sama dengan batas ≤ 200 ms.
- Waktu sampai seleksi membaik pada sumber ≥ 30 menit.
- Render pada `POTONGIN_RENDER_ENGINE` edit-v2 dan legacy tidak berubah.
- Proxy tidak muncul di `/proc` cmdline, env, log, job.json atau response.
- Reframe: P-FRAME 0 mismatch, P-PLATE crop x 0 px, G-DET 0 beda, PF-RENDER auto p50 ≤ 0,4× real time.

**Yang dirasakan pengguna:** field "Link video" (YouTube atau Twitch); penolakan siaran langsung atau video terlalu panjang sebelum mengunduh; seleksi lebih cepat; tata letak "Otomatis" di Buat klip dan editor (opt-in sampai pemilik memutuskan default).

**Rollback dan risiko skema sumber.** Image lama hanya mempublikasikan `input/` bila `type === 'youtube'`. Karena itu Release 1 menulis bentuk `{type:'youtube'}` untuk YouTube dan membaca kedua bentuk. Bentuk `{type:'link'}` baru ditulis pada rilis berikutnya, hanya untuk Twitch/Kick (di balik flag). Selebihnya per flag (`POTONGIN_FETCH_*=off`, `POTONGIN_MEDIA_CACHE=off`, `POTONGIN_AUTO_REFRAME=off`), cukup ubah `.env` lalu recreate.

### Fase 5: Posting dan jadwal sosmed (≈25 hari, plus kalender audit)
**Tujuan.** Pengguna memposting atau menjadwalkan klip ke tiga platform, mulai di mode `admin`.

**Milestone:**
- SOS-M2 (5): connect, refresh dua fase, disconnect dengan purge, callback Meta.
- SOS-M3a (6): `post-text.mjs` dengan `servedClipText`; `media.mjs` (memilih ekspor **completed** via `listClipRenders`, pin hard-link, preflight, retensi pin); pemecahan `rangeFileResponse` dari `web/lib/final-files.mjs`; `publisher.mjs`; langkah YouTube; API posts; integrasi `job-deletion.mjs`; **pembuatan tabel `posts` dan `web/lib/post-registry.mjs`** sesuai kontrak F0.
- SOS-M3b (6): TikTok dan Instagram (resumable sebagai jalur utama bila tersedia).
- SOS-M4 (6): `PublishDialog`, `ClipPosts`, `/jadwal`, nav.
- SOS-M6 (2): hardening, dokumen, rollout `admin`, lalu `on`.

**Kriteria selesai:**
- Crash matrix per provider dan checkpoint menghasilkan tepat satu posting remote, atau `maybe_sent` yang disengaja.
- Error `deferred` tidak menghabiskan percobaan.
- Ekspor queued atau failed tidak pernah dipilih.
- Tes `final-files` tidak berubah dan tetap hijau.
- `social-publish.spec.mjs` lolos melawan fake platform.
- Di produksi mode `admin`: satu posting privat per platform plus satu terjadwal berhasil.
- Rollback `POTONGIN_SOCIAL=off` diuji (route 404, UI tersembunyi, data tetap ada).

**Yang dirasakan pengguna:** tombol "Posting" di kartu klip, halaman Jadwal, kartu "Akun sosmed". Unggahan tetap privat atau hanya untuk tester sampai audit platform lolos (SOS-M7 di Fase 7, kalender pemilik). **Rollback:** flag `off` tanpa rebuild. Image rollback aman karena Release A sudah ada sejak Fase 3.

### Fase 6: Feedback loop performa (≈25 hari)
**Tujuan.** Metrik masuk ke registry, menghasilkan profil per user, lalu menjadi penentu seri di seleksi, di balik toggle yang default mati.

**Milestone:**
- FB-M1 (5,5): ekstraksi `web/lib/json-store.mjs`; `performance-store.mjs` (tabel DB, append-only); impor CSV, commit dan "Cocokkan"; "Catat angka"; DELETE metrik.
- FB-M2 (3,5): `src/ai_clipper/performance_profile.py`, `performance-keys.mjs`, `performance-profile.mjs`, `preparePerformanceProfile` di `run-job.mjs`, `--performance-profile`.
- FB-M3 (5): `selection_v3.py` dengan `order_boost` terpisah (`_focus_floors` tetap memakai boost tren saja); `SelectorContext.performance`; `scripts/eval/performance_gate.py` di-commit.
- FB-M4 + SOS-M5 digabung (≈4): `metrics-refresh.mjs` (tier umur, cap dari anggaran kuota) di social-worker; adapter metrik per provider; `retention.mjs`; `outcomes.mjs`.
- FB-M5 (4,5): halaman `/performa`, kartu Pengaturan, chip "Didahulukan data performa".
- FB-M6 (2,5): laporan retro leave-future-out dengan bootstrap CI, lalu rollout.

**Kriteria selesai:**
- Gate 1: tanpa profil, 7 episode heuristik dan 5 replay cache byte-identik, termasuk semua request sha256. Basis commit = `main` setelah Fase 4.
- Gate 2: profil yang tidak cocok tidak mengubah apa pun.
- Gate 3: Hits@5/10 turun paling banyak 1, Trap@10 tidak naik, floor fokus identik, dan **ukuran efek dilaporkan** (bar minimum: ≥ 20% episode berubah ≥ 1 pick dengan profil "favour archetype X"; bila tidak tercapai, dicatat jujur sebagai "tidak ada efek").
- Paritas kunci Python dan JS lolos.
- Nilai mentah YouTube yang lebih dari 30 hari tanpa refresh dibuang dan agregatnya tetap ada.
- Pemilik membaca laporan retro sebelum toggle dinyalakan.

**Yang dirasakan pengguna:** halaman Performa (rasio "1,4× dari biasanya" dan n), impor CSV, toggle "Pakai data performa saat memilih klip" (default mati). **Rollback:** toggle atau `POTONGIN_PERFORMANCE=off` tanpa rebuild. Tanpa profil, output byte-identik.

### Fase 7: Opsional dan audit (tidak dijadwalkan sebelum diputuskan)
- **SOS-M7** (3 hari dev plus kalender): verifikasi Google, audit TikTok Direct Post, Meta App Review dan verifikasi bisnis. Opsional: tulis ulang teks per platform lewat rantai LLM gratis.
- **FB-M7** (3): eksperimen blok angka di prompt rerank. Diadopsi hanya jika lolos gerbang M3 dan pemilik setuju.
- **RF-M7** (5): mode "stage" dan penempatan caption per run.
- **FETCH-M9 range-only** (12): **hanya** jika M0 merekomendasikan go **dan** pemilik menjawab soal koeksistensi dengan rerank (Q6). Jika dibangun: artefak kanonik ditulis dalam waktu kompak, salinan waktu-asli di `analysis/original/`, span ditentukan oleh PTS video yang benar-benar diambil, gerbang A/V ≤ 1 frame, dan fallback ke unduhan penuh.

---

## 4. Peta file utama per fase

Path mengikuti input workstream. Tanda "BARU" berarti file baru; selebihnya file yang diubah.

**Fase 0**
- `Dockerfile` (NODE_IMAGE node:24-bookworm-slim@digest), `.github/workflows/{ci-cd,editor-gates,ytdlp-update}.yml`
- BARU `resources/performance/rules.v1.json`, `docs/plans/2026-11-xx-umpan-balik-performa.md`, `docs/plans/2026-10-24-posting-jadwal-sosmed.md`, `docs/plans/2026-10-xx-multi-user.md`, `docs/plans/2026-10-xx-unduhan-sumber.md`
- BARU `docs/operations/SOSMED.md`, `docs/evaluation/UNDUHAN_M0.md`, `docs/evaluation/AUTO_REFRAME.md`, `scripts/eval/auto_reframe.py`
- `docs/editor/CONTRACTS.md` (alokasi §5.59–§5.64), `AGENTS.md` (clean-room, migrasi aditif, guard sinkron), `docs/evaluation/TRAINING_SOURCE_REGISTRY.json`

**Fase 1**
- BARU `web/lib/db/{index,migrate}.mjs`, `web/lib/db/migrations/0001-identity.sql`, `web/lib/{passwords,sessions,users,audit,instance-settings}.mjs`, `resources/auth/common-passwords.txt`
- BARU `web/scripts/{db-backup,admin-reset}.mjs`
- `web/lib/auth.mjs`, `web/proxy.js`, `app/api/auth/{login,logout}/route.js`, `app/projects/[id]/clips/[clipId]/edit/page.jsx`, `app/parity-harness/page.jsx`, `app/parity-harness/player/page.jsx`, `app/api/parity-fixtures/[...path]/route.js`
- `compose.yaml` (POTONGIN_DB_PATH untuk app dan primary-worker, E2E_SMOKE_*), `.env.example`, `deploy/production.sh`, `web/e2e/{read-only,smoke}.spec.mjs`
- BARU tes `web/tests/{passwords,sessions,users,db-migrations,authorize-sync-contract,deploy-env-contract}.test.mjs`. Diubah: `proxy-matcher`, `login-rate-limit`.

**Fase 2**
- BARU `web/lib/{job-ownership,sealing,owner-env}.mjs`
- `web/lib/security-headers.mjs`, `rate-limit.mjs`, `request-security.mjs`; semua `web/app/api/**/route.js`; lib route `web/lib/{clip-edit,clip-text-api,clips-zip,final-files,clip-media,preview-lane,preview-source,editor-ai,camera-progress,coldopen-suggestions,apply-all,job-cancel,job-deletion,clip-hook-api,clip-renders,asset-upload,llm-settings-http,trend-context}.mjs`
- `web/lib/{llm-settings,youtube-cookies,transcription-settings,default-logo,default-watermark,llm-status,system-info,jobs,clip-library}.mjs`, `web/lib/python-cli.mjs`, `web/scripts/run-job.mjs`, `web/app/settings/page.jsx`
- Tes `route-guard-coverage`, `ownership-matrix`, `sealing-v2`, `owner-env`, `security-support` (routeFiles seluruh tree), `security-child-env`, `web/e2e/multiuser-isolation.spec.mjs`
- Reframe:
  - `src/ai_clipper/face_window.py`, `speaker_track.py`;
  - BARU `src/ai_clipper/shot_context.py`, `src/ai_clipper/edit_v2/{shot_cuts,shots}.py`;
  - `src/ai_clipper/edit_v2/{__init__,layouts,compile_ffmpeg,doc,plan,errors,plates,camera,seed,preview_cli,face_zone}.py`;
  - BARU `scripts/parity/auto_graph_spike.py`;
  - tes `tests/test_edit_v2_{shots,shot_cuts,compile,plates,doc,seed,camera,face_zone}.py`, `tests/test_shot_context.py`, `tests/fixtures/edit_v2/shot-vectors.json`.

**Fase 3**
- BARU `web/lib/{invites,password-resets,api-tokens,user-storage-usage}.mjs`, `web/scripts/multiuser-migrate.mjs`
- BARU halaman `web/app/{akun,admin/pengguna,admin/pengguna/[userId],undangan/[token],atur-ulang-sandi/[token]}/page.jsx`
- BARU API `app/api/account/*`, `app/api/admin/*`, `app/api/auth/{invite,reset}`
- `web/lib/{app-nav,app-menu,help-catalog}.mjs`, `web/lib/primary-job-queue.mjs`, `web/scripts/primary-worker.mjs`, `web/lib/{storage-admission,shared-storage-accounting}.mjs`, `src/ai_clipper/render_worker.py`, `web/lib/ingest-tokens.mjs` (pembaca impor)
- Reframe floor: `src/ai_clipper/{pipeline,cli}.py`, `edit_v2/render_edit.py`, `render_queue.py`, `web/lib/{jobs,dashboard-choices,layout-names,look-preview}.mjs`, `web/lib/editor/flags.mjs`, BARU `scripts/ops/auto_layout_downgrade.py`, `docs/editor/OPERASIONAL.md`
- Sosmed Release A: BARU `web/lib/social/{store,errors,redact,http,scheduler,apps}.mjs`, `web/scripts/{social-worker,check-social-worker-health}.mjs`, `web/app/settings/SocialAppsCard.jsx`, `web/app/api/settings/social-apps/route.js`, migrasi tabel sosmed; `compose.yaml` (social-worker, DB path), `deploy/production.sh`
- Dokumen: BARU `docs/operations/PENGGUNA.md`; diubah `docs/operations/STORAGE_RETENTION.md` (metadata kontrol), README, HANDOFF, ROADMAP

**Fase 4**
- BARU `web/lib/{source-url,fetch-args,fetch-plan,media-cache,download-network-settings,download-network-view}.mjs`, `web/app/api/settings/download-network/route.js`
- BARU `src/ai_clipper/fetch/{__init__,__main__,platforms,probe,cache}.py`
- `web/lib/primary-job-queue.mjs` (baris 816), `web/lib/{jobs,clip-library,source-language,project-view,dashboard-view,stage-summary,download-errors,help-catalog,system-info,system-info-view}.mjs`, `web/app/projects/[id]/page.jsx`, `web/app/dashboard/page.jsx`, `web/app/api/jobs/route.js`, `web/scripts/{run-job,primary-worker}.mjs`
- `src/ai_clipper/{cli,pipeline,transcribe,transcribe_groq,youtube_captions}.py`, `pyproject.toml` dan `uv.lock` (plugin bgutil), `compose.yaml` (pot-provider), `scripts/ytdlp/ytdlp_smoke.py`, `.github/workflows/ytdlp-update.yml`
- Dokumen: `docs/operations/UNDUHAN_YOUTUBE.md` diganti nama menjadi `UNDUHAN_SUMBER.md`, plus TRANSCRIPTION.md, PROGRES_JOB.md, BANTUAN.md
- Reframe editor:
  - BARU `web/lib/editor/shots.mjs`, `web/components/editor/{ShotPopover.jsx,shot-model.mjs,shot-popover.module.css}`;
  - `web/lib/editor/{doc-model,commands,rebase,apply-all,draft-store}.mjs`;
  - `panels/{LayoutPanel.jsx,layout-model.mjs,layout-analysis.mjs}`, `quick/LayoutCard.jsx`, `timeline/VideoLane.jsx`, `SplitDialog.jsx`, `FramingDialog.jsx`;
  - `scripts/parity/{frame_identity,plate_gates,player_fixtures,camera_real,join_gates}.py`, `run_all.sh`;
  - `docs/editor/{GATES,PANDUAN-EDITOR}.md`.

**Fase 5**
- BARU `web/lib/social/{oauth,tokens,media,post-text,publisher,view,api}.mjs`, `web/lib/social/providers/{registry,youtube,tiktok,instagram}.mjs`, `web/lib/post-registry.mjs`
- `web/lib/final-files.mjs` (`rangeFileResponse`), `web/lib/jobs.mjs` (`servedClipText`, `snapshotClipPackaging`), `web/lib/{storage-status-dto,storage-admission,job-deletion}.mjs`
- BARU `web/app/api/social/**`, `web/app/{jadwal,privasi,ketentuan}/page.jsx`, `web/components/{PublishDialog,ClipPosts,SocialIcon}.jsx`, `web/app/settings/SocialAccountsCard.jsx`
- `web/app/projects/[id]/page.jsx`, `web/components/AppShell.jsx`, `web/lib/{app-nav,app-icons}.mjs`, `web/proxy.js`
- BARU `web/tests/support/fake-social-platform.mjs`, `web/e2e/social-publish.spec.mjs`

**Fase 6**
- BARU `src/ai_clipper/performance_profile.py`, `scripts/eval/performance_gate.py`
- `src/ai_clipper/{selection_v3,selection_types,pipeline,cli,benchmark}.py`
- BARU `web/lib/{json-store,performance-store,performance-profile,performance-keys,metrics-csv,metrics-refresh,performance-view}.mjs`, `web/lib/social/{retention,outcomes}.mjs`
- `web/lib/trend-context.mjs` (memakai json-store), `web/scripts/run-job.mjs`, `web/lib/{selection-v3-view,project-view,clip-entry-view,ingest-tokens}.mjs`
- BARU `web/app/performa/page.jsx`, `web/app/api/performance/**`, `web/app/api/posts/[id]/metrics/**`, `web/app/api/settings/performance/route.js`, opsional `web/app/api/ingest/metrics/route.js`
- Dokumen: BARU `docs/operations/PERFORMA.md`; diubah `docs/evaluation/SELECTION_BENCHMARK.md`, `docs/operations/STANDAR_KLIP_AI.md`

**Fase 7 (bila jalan)**
- `src/ai_clipper/post_text.py`
- `src/ai_clipper/source_timeline.py`, `src/ai_clipper/fetch/pieces.py`, `web/lib/source-timeline.mjs`, `scripts/fetch/av_alignment_report.py`, `tests/support/hls_server.py`

---

## 5. Strategi test dan gerbang

**Aturan umum (AGENTS.md):**
- Tes ditulis lebih dulu dan ambang tidak pernah dilemahkan.
- Di PC pemilik hanya dijalankan tes yang ditargetkan (`node --test web/tests/<file>`, `pytest tests/<file>`).
- Suite penuh, build image, FFmpeg/parity dan Playwright dijalankan di GitHub Actions: `gh workflow run editor-gates.yml -f ref=<branch> -f suite=full|image|command`.
- gitleaks dengan config `main` dijalankan sebelum setiap push. Fixture palsu memakai bentuk yang tidak dianggap rahasia. Allowlist berdasarkan path dan baris persis.

**Gerbang keamanan (tidak pernah dilonggarkan):**
- `ownership-matrix.test.mjs` atas seluruh `app/api`: lintas user mendapat 404 identik dan nol spawn Python. Ini juga berlaku untuk setiap route baru di Fase 4–6.
- `route-guard-coverage.test.mjs` sebagai gerbang statis, dengan allowlist yang mencantumkan alasan.
- `authorize-sync-contract.test.mjs`.
- `security-routes`, `request-security`, `proxy-matcher` (exclusion baru dan halaman publik exact-path).
- `security-child-env` dan `owner-env`: tidak ada key LLM env di anak milik anggota; tidak ada secret dashboard atau path DB di env anak.
- `deploy-env-contract`:
  - `E2E_SMOKE_*` dipakai;
  - DB hanya untuk app, primary-worker dan social-worker;
  - `pot-provider` tanpa ports dan tidak tersambung ke app atau render-worker.
- Redaksi log: tidak ada token OAuth, proxy, `ptk_` atau secret di log, argv (`/proc/<pid>/cmdline`), job.json maupun response.
- Fake-origin sosmed ditolak di env berbentuk produksi (`social-fake-origin-gate.test.mjs`).
- `scripts/security/route_matrix.py` mencakup `/api/settings/download-network`.

**Gold benchmark dan seleksi:**
- Feedback Gate 1–3 (§3 Fase 6) lewat `scripts/eval/performance_gate.py`, yang di-commit, tidak lagi skrip scratchpad. Episode held-out hanya dijalankan sekali di akhir.
- FETCH-M3 mengubah format audio (Opus ke AAC asli). Episode eval wajib menghasilkan klip yang sama dengan batas ≤ 200 ms, dan unit test exact-equality memakai file audio yang sama. M3 juga harus memastikan bahwa benchmark gold di `SELECTION_BENCHMARK.md` tidak terpengaruh. Jika ternyata terpengaruh, benchmark dijalankan ulang dan dilaporkan sebelum merge.
- Basis byte-identity Gate 1 feedback adalah commit `main` setelah Fase 4. Setiap perubahan seleksi lain sesudahnya harus menjalankan ulang gerbang itu.

**Parity dan render:**
- Pin: byte camera plan, semua graf/plan sha/plate key non-auto, dan `RENDER_SEMANTICS` 2.
- P-FRAME (`cfr_30_auto`, `cfr_2997_auto`, `auto_keyframes`, `auto_zoom_content`, `auto_split`), P-PLATE, P-JOIN-B dan G-DET pada CPU 1 dan 4. RSS < 3 GiB pada cap run.
- PF-RENDER dan PF-PIPELINE (delta CPU job) sebelum keputusan default Otomatis.
- Jalur fallback render engine: audio-first (dan job sections bila Fase 7 jalan) harus lolos di `edit-v2` dan `legacy`.
- Toolchain evidence hanya disentuh di Fase 0 (Node 24).

**Ketahanan dan konkurensi:**
- Antrean: `queue-fairness`, tes lease/cancel/delete/janitor/upload yang ada tetap tidak berubah, dan reservation v2/v3 diuji dua arah.
- Sosmed: crash matrix per provider dan checkpoint (exactly-once atau `maybe_sent`), scheduler dengan jam manual (termasuk reset Pacific melintasi DST), refresh dua fase tanpa transaksi terbuka selama I/O jaringan.
- Cache media: dua proses nyata, holder di-SIGKILL, cancel saat menunggu, fallback copy EXDEV, symlink tanam ditolak.
- Paritas lintas bahasa: `tests/fixtures/fetch/urls.json` (JS dan Python), tabel kasus `rules.v1.json` (kunci performa), `shot-vectors.json` (editor).

**UI:** `ui-guards` (token, kontras AA, tanpa kata versi), `help-catalog` (setiap kode baru punya entri Bantuan), `app-shell` (nav dengan dan tanpa flag), Playwright di CI, layar 360 px tanpa scroll horizontal, review antislop copywriting/human/layoutmobile.

**Deploy dan rollback:**
- Drill CI lama→baru→lama di volume fixture (Fase 3).
- Tes skrip deploy untuk empat container.
- Drill per flag (Fase 4 dan 5).
- Tes skrip `auto_layout_downgrade.py`.

---

## 6. Migrasi data single-user ke multi-user, dan rencana rollback

### Boot pertama image multi-user (Fase 1)
1. `db-backup.mjs` berjalan di production.sh sebelum `up -d` (`DB_BACKUP=<path>`).
2. Migrasi 0001 dijalankan dalam satu transaksi.
3. Jika tabel `users` kosong, admin dibuat dari `APP_USERNAME/APP_PASSWORD` dan `meta.bootstrap_owner_id` diisi.
4. Sejak Fase 3, `ingest-tokens.json` diimpor beserta hash-nya. Logo dan watermark default di root disalin ke `users/<owner>/`. User smoke (`is_smoke`) dibuat atau diverifikasi. **Tidak ada job.json yang ditulis ulang.** Job tanpa `ownerId` dimiliki `effectiveOwner = bootstrap_owner_id`.
5. Langkah opsional: `web/scripts/multiuser-migrate.mjs --dry-run|--apply` mengisi `ownerId` untuk job terminal di bawah queue lock.

### Runbook deploy (docs/operations/PENGGUNA.md)
1. Salin `APP_SESSION_SECRET` ke `POTONGIN_SETTINGS_SECRET`.
2. Isi `E2E_SMOKE_*`.
3. Pastikan sistem quiescent.
4. Deploy.
5. Verifikasi: login pemilik, cookie v1 ter-upgrade, e2e smoke.
6. Pemilik melakukan cek manual.

### Matriks rollback

| Lapisan | Mekanisme | Catatan |
|---|---|---|
| Image multi-user ke single-user | Image lama mengabaikan DB dan `ownerId` | Semua job terlihat oleh login env (diterima dan didokumentasikan). User, token dan setting per user yang dibuat belakangan tidak terlihat. `.env` tetap menyimpan `APP_*` yang valid. |
| Skema DB | Hanya aditif, versi minimum per kode | Jangan pernah rollback melewati migrasi contract. |
| Reservation | v3 lewat R1 (baca v2/v3, tulis v2), lalu R2 | Quiescence tidak mencakup `.primary-reservations`. |
| Cookie sesi | Proxy menerima dua bentuk selama rilis transisi | v1 dibuang di rilis berikutnya. Break-glass: `admin-reset.mjs --admin`. |
| Sealing | Kotak v1 di root tetap terbaca | Mengganti `POTONGIN_SETTINGS_SECRET` membuat semua kotak (termasuk token sosmed) tak terbaca: akun sosmed masuk status reauth, dan self-check memberi peringatan. |
| Sosmed | `POTONGIN_SOCIAL=off` lalu `up -d` | Image rollback aman setelah Release A. Melewati Release A butuh `compose.yaml` yang cocok. |
| Reframe | `POTONGIN_AUTO_REFRAME=off` | Image rollback aman sampai release 1 (floor). Di bawah floor: `auto_layout_downgrade.py` (dry-run default, fit_blur, file auto R10 tetap ada). |
| Unduhan | `POTONGIN_FETCH_*`/`POTONGIN_MEDIA_CACHE=off` | Skema sumber: `link` hanya untuk platform baru, ditulis setelah rilis yang bisa membacanya. Cache tidak pernah menjadi satu-satunya pemilik byte job (hard link). |
| Performa | Toggle per user atau `POTONGIN_PERFORMANCE=off` | Tanpa profil, output byte-identik. |
| Backup DB | `VACUUM INTO`, simpan 14 | Restore lolos `integrity_check` dan diuji di drill. |

### Penghapusan pengguna
- Hanya untuk user yang dinonaktifkan dan tidak punya proyek.
- Proyek dikosongkan lewat transfer admin (menulis ulang `ownerId` di bawah queue lock) atau hapus per proyek lewat `job-deletion.mjs` dengan konfirmasi ketik.
- Ada satu baris audit per proyek.
- Hook penghapusan juga memanggil `disconnectAll` dan purge sosmed, serta menghapus data performa user itu.

---

## 7. Risiko utama dan mitigasi

1. **Regresi IDOR di 49+ route dan route baru dari empat workstream lain.** Mitigasi: ownership-matrix seluruh tree, route-guard-coverage statis, `secureRoute owner:'job'` sebagai default. Fase 2 wajib selesai sebelum ada anggota.
2. **Guard tak sengaja menjadi async**, sehingga semua `secureRoute` membalas 503. Mitigasi: tes kontrak sinkron dan driver DB yang sinkron.
3. **Kebocoran key LLM env ke anggota**, yang menguras kuota gratis pemilik. Mitigasi: `owner-env` membuang key, ada tes, cap harian, dan saklar berbagi.
4. **Deploy rollback otomatis karena kredensial smoke.** Mitigasi: `--ensure-smoke-user` saat boot, `deploy-env-contract`, langkah runbook. Semuanya di Fase 1.
5. **Review platform di luar kendali.** Unggahan bisa tetap privat selamanya, dan kuota YouTube instans mungkin hanya cukup untuk beberapa upload per hari untuk semua user. Mitigasi: rilis bertahap `admin` lalu `on`, penghitung kuota dan deferral, pesan UI yang jujur, `SOS-M0` dimulai di Fase 0.
6. **Blast radius satu secret setting**, yang menyegel token semua akun sosmed dan kunci LLM. Mitigasi: AAD per akun dan purpose, file 0600, scope minimal, tanpa logging, self-check.
7. **Graf render Otomatis tidak bit-exact atau melewati 3 GiB.** Mitigasi: spike RF-M2 sebelum desain dikunci (overlay, streamselect atau maskedmerge); concat K chain hanya jika terukur aman.
8. **Lonjakan CPU** dari Otomatis (scan pada job yang dulu fit-blur), audio paralel dengan Whisper di `cpus: 6`, dan render sosmed/editor. Mitigasi: Otomatis opt-in sampai angka PF-PIPELINE ada; round-robin render; pengukuran M0 unduhan; batas laju yt-dlp opsional.
9. **Disk produksi 81%, dipakai bersama aplikasi lain**: cache media, pin sosmed, backup DB. Mitigasi: cap kecil (4 GiB), admission ruang kosong, pin yatim dihitung, ukuran ditampilkan di Tentang sistem, persetujuan pemilik.
10. **Jalur penghapusan otomatis baru** (cache, prune metadata, retensi platform) bisa menyentuh data job jika path salah. Mitigasi: root terpisah, containment realpath, penolakan path di bawah `JOBS_ROOT`, tes negatif, hard link.
11. **Drift kunci performa** antara hook proposal dan hook final di manifest, ditambah bias seleksi dan efek yang hampir nol. Mitigasi: aturan kunci tunggal dengan tes round-trip, laporan ukuran efek, CI bootstrap, default mati, mix arketipe ditampilkan.
12. **Bentrok merge** di `web/lib/jobs.mjs`, `primary-job-queue.mjs`, `run-job.mjs`, `app-nav.mjs`, `compose.yaml` dan `production.sh` antar workstream dan dengan PR Redesign UX. Mitigasi: urutan fase di atas (unduhan setelah MU-M7; UI setelah UX PR), satu pemilik per file per fase, cadangan integrasi.
13. **Supply chain**: plugin bgutil, sidecar, kemungkinan curl_cffi. Mitigasi: pin digest, co-bump smoke mingguan, profil opt-in, persetujuan pemilik untuk dependency.
14. **Kontaminasi AGPL**, karena API publik yang sama membuat nama endpoint dan field mirip. Mitigasi: implementer tidak membuka SupoClip, desain berbasis kutipan dokumen resmi, spot-check reviewer, konstanta diturunkan sendiri.
15. **Skala SQLite dan scan file.** Pemindaian `JOBS_ROOT` per owner bisa mengenai batas `JOBS_STORAGE_SCAN_*` saat user bertambah, dan admission jadi fail-closed. Mitigasi: cache per job, ukur ulang kapasitas setelah angka pengguna diketahui (Q4).
16. **Estimasi**: sekitar 191 hari-developer. Erratum tipikal: MU-M3, FETCH-M3 dan RF-M2 bisa meleset 30–50%. Mitigasi: setiap fase bisa dikirim sendiri, dan fitur opsional dipisah ke Fase 7.

---

## 8. Pertanyaan terbuka untuk pemilik (urut dari yang paling memblokir)

1. **Fondasi teknis dan akses.**
   - Setuju pindah ke Node 24 LTS (bukti toolchain dijalankan ulang) dengan SQLite bawaan Node? Jika tidak, bolehkah menambah `better-sqlite3`?
   - Admin **tidak pernah** bisa membuka proyek pengguna lain, hanya transfer atau hapus yang diaudit. Setuju?
   - `APP_USERNAME/APP_PASSWORD` dipertahankan sebagai login darurat permanen, atau dihapus setelah transisi dan diganti `admin-reset.mjs`? Anggota smoke khusus (`E2E_SMOKE_*`) untuk cek deploy bisa diterima?
2. **Siapa yang boleh masuk dan berapa batasnya.**
   - Pendaftaran cukup lewat undangan (tanpa mode "open")?
   - Perkiraan jumlah pengguna dan job dalam 6–12 bulan?
   - Batas default anggota: kuota storage, job aktif, job berjalan, job per jam, durasi sumber maksimum (usulan global 4 jam)?
   - Ada layanan SMTP untuk undangan dan reset, atau tautan disalin manual?
3. **Berbagi sumber daya pemilik ke anggota.**
   - Apakah anggota memakai rantai LLM gratis dan cookie YouTube milikmu secara default, dengan cap harian berapa (usulan 200 panggilan)? Key LLM dari env tidak pernah dibagi.
   - Cookie YouTube tetap global milik admin atau per user?
   - Bolehkah video publik (diunduh tanpa cookie) dan transkripnya dipakai ulang lintas user lewat cache?
4. **Aplikasi platform sosmed.**
   - Satu app per platform milikmu yang dipakai semua user?
   - Bersedia menjalani verifikasi Google, audit TikTok, dan Meta App Review plus verifikasi bisnis? Jika tidak, sosmed tetap admin-only dan privat.
   - Siapa yang menulis `/privasi` dan `/ketentuan`, dan email kontak mana yang boleh dipublikasikan (repo publik)?
   - Setuju Instagram lewat Instagram Login, dengan fallback URL media publik (pengecualian WAF Cloudflare) bila resumable upload tidak tersedia?
5. **Pengecualian aturan "tidak ada hapus otomatis"**, semuanya di luar `/data/jobs` dan tidak pernah menyentuh proyek. Disetujui sebagai satu paket?
   - prune audit >180 hari, sesi, undangan dan reset kedaluwarsa, backup DB >14;
   - cache media 4 GiB / 3 hari, atau hanya dikosongkan lewat tombol di Pengaturan;
   - pin sosmed 1 jam setelah terposting, 7 hari untuk yang gagal;
   - aturan 30 hari YouTube API: nilai mentah diciutkan menjadi agregat turunan, dan data dipurge saat akun diputus.
6. **Unduhan per rentang (range-only).** Penghematannya hanya terasa di video ≥ ~40 menit. Fitur ini mempersulit pemilihan ulang klip dan editor ±60 detik di luar jendela, dan mengubah identitas klip jika sumber diperluas. Dibangun nanti (Fase 7) atau dilewati, dengan unduhan penuh tetap berjalan paralel dengan analisis?
7. **Jaringan unduhan.**
   - Mau proxy residensial berbayar? Jika ya: penyedia, anggaran GB per bulan, dan bolehkah cookie YouTube lewat proxy (usulan: tidak)?
   - Setuju menjalankan container bgutil (opt-in, tidak terekspos) dan menambah plugin yt-dlp-nya?
   - Kick dirilis sebagai eksperimen (mati default, mungkin butuh curl_cffi) atau ditunda?
8. **Feedback loop.**
   - Ukurannya views 7 hari (usulan), engagement, atau watch time (butuh scope OAuth tambahan)?
   - Ambang awal yang dibekukan sebelum tuning bisa diterima: 20 posting terukur dalam 14 hari, n ≥ 5 per grup, cap +0,2, gabungan 0,4?
   - Toggle tetap mati sampai kamu membaca laporan retro?
   - Klip yang diedit jauh (>20% panjang atau hook ditulis ulang) dikeluarkan dari profil?
   - Data performa privat per user, atau admin boleh melihat agregat?
   - Bisa menyediakan satu contoh ekspor CSV dari YouTube Studio, TikTok Studio dan Instagram?
   - Jika gerbang menunjukkan "tidak ada efek", hasil itu diterima, atau eksperimen prompt (M7) direncanakan?
9. **Tata letak Otomatis.**
   - Setelah gerbang lolos dan biaya CPU per job terlihat, apakah Otomatis menggantikan Latar blur sebagai default atau tetap opt-in?
   - Dua orang di shot lebar yang sama-sama bicara: Layar terbagi atau Ikuti wajah yang berpindah?
   - Satu pembagian dan zoom split per klip (hanya posisi yang bisa diubah per run) bisa diterima?
   - "Pakai di semua klip" mengantrekan analisis atau melewati klip dengan catatan?
   - Bisa melabeli 20 jendela test split (sekitar 60–90 menit) dan menilai 10 klip split?
10. **Detail operasi sosmed.**
    - Cap per user 100 terjadwal dan 20 per jam?
    - Kuota YouTube instans dibagi siapa cepat dia dapat, atau jatah harian per user?
    - Jadwal memakai zona waktu perangkat (usulan) atau selalu WIB?
    - Menghapus job yang punya posting terjadwal akan membatalkannya (usulan)?
    - File default adalah ekspor editor terbaru yang sudah selesai, dengan pilihan di dialog?
    - Social-worker sebagai container sendiri (usulan, 0,5 CPU) atau digabung ke primary-worker?