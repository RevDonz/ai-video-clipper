# 03 — Posting sosmed & umpan balik performa

- **Status:** Rancangan — belum diimplementasi
- **Tanggal:** 2026-10-24
- **Dokumen saudara:** [00-README.md](00-README.md) (indeks) · [01-arsitektur-data.md](01-arsitektur-data.md) · [02-multiuser-keamanan.md](02-multiuser-keamanan.md) · [04-reframe-unduhan.md](04-reframe-unduhan.md) · [05-ui-dashboard.md](05-ui-dashboard.md) · [06-editor.md](06-editor.md) · [07-i18n.md](07-i18n.md) · [08-fase-test-deploy.md](08-fase-test-deploy.md)
- **Sumber:** roadmap induk (bagian "Koreksi akhir" + roadmap revisi), roadmap fitur 01 + review #1–#16, dashboard 02, editor 03, i18n 04. Kalau bertentangan, koreksi akhir roadmap induk yang berlaku.
- **Kepemilikan:** dokumen ini **pemilik** API sosmed (`/api/social/**`) dan analitik/performa (`/api/analytics/**`, `/api/performance/**`, `/api/posts/**`, `/api/settings/performance`), state machine `publish_runs` beserta nama state/hold, scheduler dan proses `social-worker`, kode error `social_*`/`performance_*`, serta profil performa. Yang **dirujuk, tidak didefinisikan ulang di sini:** DDL, nomor migrasi, nama kolom, volume (01 §3–§5); auth, peran, `secureRoute`, matriks route, `instance_settings`, re-auth, drain (02 §3.3, §7, §8, §10.5); kata status yang tampil dan layar (05 §5, §6.5–§6.7); katalog pesan dan bentuk error (07 §7, §10); fase, estimasi, gate, dan skrip deploy (08 §4, §5, §8, §9).
- **Fase:** SOS-M0 + FB-M0 (Fase 0), SOS-M1 R0/R1 (Fase 6, jalur paralel; roadmap induk menyebutnya "SOS-M1 Release A" = R0 + R1), SOS-M2…M6 + i18n M7b (Fase 8), FB-M1…M6 + i18n M7c (Fase 9), SOS-M7/FB-M7 (Fase 12, opsional).

Konvensi dokumen ini:
- Path relatif terhadap root repo `ai-video-clipper/`. **(baru)** = file belum ada (sudah dicek dengan `ls`/`grep` pada 2026-10-24). Path tanpa tanda sudah ada.
- Angka batas platform di bawah adalah nilai kerja dari pengetahuan desain. Setiap angka bertanda **[V]** wajib diverifikasi ulang di SOS-M0 dan dikutip di `docs/operations/SOSMED.md` **(baru)** beserta tautan dokumentasi resmi dan tanggal akses. Kalau hasil verifikasi berbeda, angka di SOSMED.md yang berlaku dan konstanta kode mengikutinya.
- Clean-room: implementer boleh membaca SupoClip untuk memahami perilaku (09 §1) tetapi tidak menyalin apa pun. Semua nama, konstanta, taksonomi error, dan struktur modul di sini diturunkan dari kode Potongin dan dokumentasi resmi platform. Nama final mengikuti roadmap induk §2.2-D: `social_connections`, `publish_runs`, `oauth_pending`, `readPostStats`.
- Istilah UI: **Terbitkan** (aksi) / **Terbit** (status). Copy ada di katalog `web/messages/<locale>/<namespace>.json` (07 §2.2, §7.1): namespace `social`, `analytics`, `legal`, dan `errors` (sub `errors.social`, `errors.performance`); `id` sumber, `en` wajib lengkap.

---

## 1. Ringkasan dan cakupan

**Yang dibangun:**
1. Pengguna menyambungkan akun YouTube, TikTok, dan Instagram (akun profesional) miliknya sendiri lewat OAuth. Token disegel per pengguna.
2. Klip diterbitkan sekarang atau dijadwalkan. Unggahan dijalankan `social-worker` (container sendiri) dengan checkpoint, lease ber-fence, dan hasil *exactly-once* atau `maybe_sent` yang disengaja.
3. Metrik (tayangan, suka, komentar, bagikan) ditarik ulang menurut tier umur dalam anggaran kuota, disimpan sebagai snapshot append-only, lalu diringkas per horizon.
4. Profil performa per pengguna (angka saja) memberi dorongan urutan kecil, positif, dan dibatasi ke Selection V3, hanya sebagai penentu seri. Default mati.
5. Impor CSV dan "Catat angka" manual untuk posting yang tidak lewat API.
6. API data Analitik untuk `/analitik`.

**Di luar cakupan dokumen ini** (ada di dokumen saudara): tata letak layar `/sosial`, `/analitik`, dan `PublishDrawer` serta kata status yang tampil (05 §5, §6.5–§6.7), DatePicker berzona dan katalog pesan (07 §13), tombol Terbitkan di editor (06 §11.10). Dokumen ini menetapkan kontrak data/API yang dipakai layar-layar itu; 05 dan 06 wajib memakai bentuk API di §9 persis.

**Bukan tujuan:** posting batch berjarak (ditunda, lihat Q7), penulisan ulang teks per platform lewat LLM (SOS-M7 opsional), eksperimen blok angka di prompt rerank (FB-M7 opsional), metrik watch time/retensi (butuh scope tambahan).

### 1.1 Keputusan pemilik yang dipakai

| # | Keputusan | Status |
|---|---|---|
| Q1 | Amandemen DESIGN.md/AGENTS.md disetujui: mode Cepat/Lengkap editor dihapus, diganti satu tata letak dengan pengungkapan bertahap (satu panel kanan, "Lanjutan" terlipat); istilah **Terbitkan** (aksi) / **Terbit** (status). Untuk dokumen ini: Terbitkan di editor lewat menu Ekspor ▾ → `PublishDrawer` (06 §11.10) | Final |
| Q2 | Node 24 + `node:sqlite` (DatabaseSync), HeroUI v3, Tailwind v4, use-intl, `@babel/parser` (dev) | Final |
| Q7 | Satu app per platform milik pemilik, dipakai semua pengguna; mulai YouTube; `POTONGIN_SOCIAL=admin` sampai audit lolos; TikTok `FILE_UPLOAD`; Instagram Login dengan resumable upload, fallback URL media publik; batch belakangan; cap per pengguna 100 terjadwal dan 20 per jam; kuota YouTube dibagi **jatah harian per pengguna**; hapus job membatalkan jadwal; file default = ekspor terbaru yang selesai, bisa dipilih lain | (default, bisa diubah) |
| Q8 | Jadwal memakai zona perangkat, nama zona ditampilkan; format 24 jam di semua locale | (default, bisa diubah) |
| Q9 | `en` dirilis bersama fase editor (opsi b); pratinjau `id,en` hanya sebelum ada anggota | Final (pemilik fleksibel soal waktu, asalkan akhirnya ID dan EN ada) |
| Q11 | Ukuran = tayangan 7 hari; ambang awal dibekukan (≥ 20 posting terukur, n ≥ 5 per grup, cap +0,2 per dimensi, gabungan 0,4); toggle mati sampai pemilik membaca laporan retro; klip yang diedit jauh (> 20% atau hook ditulis ulang) dikeluarkan dari profil; data performa privat per pengguna (admin tidak melihat); "tidak ada efek" diterima, FB-M7 opsional | (default, bisa diubah) |
| Q6 | Penghapusan otomatis di luar `/data/jobs` sebagai satu paket: pin media sosmed 1 jam setelah terbit, 7 hari untuk gagal/batal/`maybe_sent`; nilai mentah YouTube API > 30 hari tanpa refresh diciutkan; purge saat putus akun | (default, bisa diubah) |

---

## 2. Arsitektur

```
Browser ──► app (Next, node:sqlite) ──────────────┐
  │  /api/social/*  /api/analytics/*  /api/performance/*
  │                                                ▼
  │                                   /control/potongin.sqlite  (WAL)
  │                                                ▲
  │                     social-worker (node:sqlite)┘ ── HTTPS ──► YouTube / TikTok / Instagram
  │                       ├─ scheduler publish_runs
  │                       ├─ refresh token dua fase
  │                       ├─ metrics-refresh (due-list)
  │                       └─ sweep pin + retensi platform
  │
primary-worker (DB) ── menulis analysis/performance-profile.json ──► run-job.mjs (tanpa DB) ──► Python --performance-profile
```

- **Proses yang membuka DB:** `app`, `primary-worker`, `social-worker` (01 §1.3). Python, `run-job.mjs`, dan render-worker tidak pernah membuka DB dan tidak tahu pemilik.
- **App tidak pernah memanggil platform untuk unggah atau refresh token.** App hanya: memulai OAuth, menukar `code` (sekali, di callback), mencabut token saat putus akun, dan membaca DB. Semua refresh token dan unggahan dikerjakan `social-worker`, sehingga hanya ada satu penulis token pada kondisi normal.
- **Tidak ada I/O jaringan di dalam transaksi SQLite.** Setiap langkah: transaksi pendek (klaim/CAS) → I/O jaringan tanpa transaksi → transaksi pendek (CAS hasil).

### 2.1 Peta file

**Fase 6 (SOS-M1, R0/R1):**
- **(baru)** `web/lib/social/store.mjs` — akses tabel sosmed, klaim, lease, CAS.
- **(baru)** `web/lib/social/errors.mjs` — `SocialError {code, class, retryAfterMs?, detail?}` dan tabel §8.
- **(baru)** `web/lib/social/redact.mjs` — redaksi token, `upload_url`, session URI, `code`, `ptk_` dari log/error.
- **(baru)** `web/lib/social/http.mjs` — `fetch` dengan timeout, batas body respons 1 MiB, tanpa redirect otomatis untuk endpoint token, allowlist origin per provider, override `SOCIAL_FAKE_ORIGIN` (§12.4).
- **(baru)** `web/lib/social/scheduler.mjs` — loop klaim, backoff, defer, SIGTERM.
- **(baru)** `web/lib/social/apps.mjs` — kredensial app per platform (tersegel, purpose `social-app`).
- **(baru)** `web/scripts/social-worker.mjs`, `web/scripts/check-social-worker-health.mjs`.
- **(baru)** `web/app/settings/SocialAppsCard.jsx`, `web/app/api/settings/social-apps/route.js`.
- **(baru)** `web/lib/db/migrations/0003-social-base.sql` — DDL dan nomor milik 01 §3.1/§4.3. Bergantung pada `web/lib/db/index.mjs`, `web/lib/db/migrate.mjs`, `web/lib/sealing.mjs` v2 dan `process_heartbeats` — semuanya **(baru, Fase 4–5)** dari dokumen 01/02, belum ada di repo hari ini.
- Diubah: `compose.yaml` (R1: service `social-worker`, §6.8), `deploy/production.sh` (rincian skrip di 08 §9.4), `Dockerfile` (label R0, 08 §9.4), `.env.example`, `tests/test_deploy_guard.py`, `web/tests/env-example.test.mjs`, `web/tests/deploy-env-contract.test.mjs` (dibuat di Fase 4).

**Fase 8 (SOS-M2…M6):**
- **(baru)** `web/lib/social/oauth.mjs`, `tokens.mjs`, `media.mjs`, `post-text.mjs`, `publisher.mjs`, `view.mjs`, `api.mjs`, `quota.mjs`, `retention.mjs`.
- **(baru)** `web/lib/social/providers/{registry,youtube,tiktok,instagram}.mjs`.
- **(baru)** `web/lib/post-registry.mjs` — registry bersama `posts` (dipakai feedback).
- **(baru)** `web/lib/db/migrations/0005-posts.sql` (DDL 01 §4.5; kolom yang dipakai §4.1).
- Diubah: `web/lib/final-files.mjs` (pecah `rangeFileResponse(request, fd, size, headers)` dari `finalFileResponse`, perilaku `finalFileResponse` tidak berubah), `web/lib/jobs.mjs` (ekspor baru `servedClipText`, `snapshotClipPackaging`, `listJobClips` — belum ada hari ini; `servedClipText(job, clip)` = `clipSocialMetadata(withClipTextEdit(clip))` dari fungsi yang sudah ada di file itu, dan `serializePublicJob` memakai fungsi yang sama), `web/app/api/jobs/[id]/route.js` (DELETE memanggil `cancelRunsForJob` sebelum `requestJobDeletion`, §6.6; `web/lib/job-deletion.mjs` tidak berubah), `web/lib/security-headers.mjs` (`ROUTE_PARAMS` hari ini: `id`, `clipId`, `taskId`, `renderId`, `sha`, `idempotencyKey`, `batchId`; ditambah `connectionId`, `runId`, `postId`, `importId` UUID, `snapshotId` `/^[1-9][0-9]{0,17}$/`, `rowNo` `/^[1-9][0-9]{0,3}$/`, `provider` `/^(youtube|tiktok|instagram)$/`), `web/proxy.js` (pengecualian §11.2), `web/lib/storage-status-dto.mjs` + `web/lib/storage-admission.mjs` (pin yatim), `web/lib/app-nav.mjs`, `web/lib/app-icons.mjs`, `web/lib/help-catalog.mjs`.
- **(baru)** route: `web/app/api/social/**` (§9), `web/app/api/jobs/[id]/clips/[clipId]/posts/route.js`, `web/app/sosial/page.jsx`, `web/app/privasi/page.jsx`, `web/app/ketentuan/page.jsx`, `web/app/hapus-data/[code]/page.jsx` (§7.5).
- **(baru)** `web/components/PublishDrawer.jsx`, `web/components/ClipPosts.jsx`, `web/components/SocialIcon.jsx`.
- **(baru)** `src/ai_clipper/edit_v2/edit_distance.py` + op `edit_distance` di `src/ai_clipper/edit_v2/api.py` (§13.3).
- Dokumen: **(baru)** `docs/operations/SOSMED.md`; diubah `deploy/VM_NGINX_CLOUDFLARE.md`, `docs/operations/STORAGE_RETENTION.md`, `docs/editor/CONTRACTS.md` (§5.60, §5.61).
- Tes **(baru)**: `web/tests/support/fake-social-platform.mjs`, `web/e2e/social-publish.spec.mjs`, dan unit test di §16.

**Fase 9 (FB-M1…M6):**
- **(baru)** `src/ai_clipper/performance_profile.py`, `scripts/eval/performance_gate.py`.
- Diubah: `src/ai_clipper/selection_v3.py`, `src/ai_clipper/cli.py` (`--performance-profile`), `src/ai_clipper/pipeline.py` (meneruskan profil), `src/ai_clipper/benchmark.py` (`SelectorContext.performance`).
- **(baru)** `web/lib/json-store.mjs` (ekstraksi dari `web/lib/trend-context.mjs`), `web/lib/performance-store.mjs`, `performance-keys.mjs`, `performance-profile.mjs`, `metrics-csv.mjs`, `metrics-refresh.mjs`, `performance-view.mjs`, `analytics-view.mjs`, `web/lib/social/outcomes.mjs`.
- **(baru)** `web/lib/db/migrations/0007-performance.sql` (DDL 01 §4.7; kolom yang dipakai §4.1).
- Diubah: `web/scripts/primary-worker.mjs` (`preparePerformanceProfile` sebelum spawn `run-job.mjs`, §13.4; `run-job.mjs` tidak membuka DB, 02 §3.1), `web/scripts/run-job.mjs` (argumen `--performance-profile` bila file profil ada), `web/lib/selection-v3-view.mjs`, `web/lib/project-view.mjs`, `web/lib/clip-entry-view.mjs`, `web/lib/ingest-tokens.mjs` (scope `metrics:write`).
- **(baru)** route: `web/app/api/analytics/**`, `web/app/api/performance/**` (termasuk `template.csv/route.js`, §9.3), `web/app/api/posts/**`, `web/app/api/settings/performance/route.js`, opsional `web/app/api/ingest/metrics/route.js`; halaman `web/app/analitik/page.jsx`.
- **(baru)** tes Python `tests/test_performance_profile.py`, `tests/test_selection_v3_performance.py`, `tests/test_edit_distance.py`; fixture `tests/fixtures/performance/keys.json`. `src/ai_clipper/edit_v2/edit_distance.py` wajib stdlib saja (AGENTS.md).
- **(baru)** `resources/performance/rules.v1.json` (dibekukan di FB-M0, Fase 0), `resources/performance/csv-profiles.v1.json`, `resources/performance/template.csv`.
- Dokumen: **(baru)** `docs/operations/PERFORMA.md`; diubah `docs/evaluation/SELECTION_BENCHMARK.md`, `docs/operations/STANDAR_KLIP_AI.md`, `docs/editor/CONTRACTS.md` (§5.62).

Catatan: `src/ai_clipper/post_text.py` **sudah ada** dan dipakai fitur "Tulis ulang" (`web/lib/clip-text-api.mjs`). Teks posting sosmed **tidak** memakai nama itu. Komposisi teks posting ada di `web/lib/social/post-text.mjs` (JS murni, tanpa LLM).

---

## 3. Konfigurasi

| Variabel | Service | Nilai | Keterangan |
|---|---|---|---|
| `POTONGIN_SOCIAL` | app, social-worker | `off` (default) \| `admin` \| `on` | `off`: route `/api/social/**` dan `/sosial` dijawab 404, nav tersembunyi, worker hanya heartbeat, data tetap. `admin`: hanya peran admin. `on`: semua pengguna. |
| `POTONGIN_PUBLIC_URL` (diperkenalkan di Fase 6 untuk tautan undangan/reset, dokumen 02; di sini ditambah ke `social-worker`) | app, social-worker | `https://<host>` tanpa path, tanpa slash akhir | Wajib kalau `POTONGIN_SOCIAL≠off`. Startup menolak `http:` kecuali host `localhost`/`127.0.0.1` dan `NODE_ENV≠production`. Sumber semua redirect URI dan URL media publik. |
| `SOCIAL_PIN_KEEP_DAYS` | social-worker | integer 1–60, default 7 | Retensi pin untuk run `failed`/`cancelled`/`maybe_sent`. |
| `SOCIAL_UPLOAD_CONCURRENCY` **(baru)** | social-worker | 1–4, default 2 | Unggahan paralel global. Per koneksi selalu 1. |
| `SOCIAL_YT_DAILY_UNITS` **(baru)** | social-worker | default 10000 **[V]** | Kuota proyek Google per hari. |
| `SOCIAL_YT_METRICS_UNITS` **(baru)** | social-worker | default 1000 | Bagian kuota YouTube yang dicadangkan untuk baca metrik. |
| `SOCIAL_FAKE_ORIGIN` **(baru)** | test saja | URL | Mengalihkan semua origin provider ke fake platform. Ditolak di env berbentuk produksi (§12.4). |
| `POTONGIN_PERFORMANCE` | app, primary-worker | `off` (default) \| `on` | `off`: route performa 404, profil tidak ditulis, Python tidak menerima `--performance-profile`. |
| `POTONGIN_PERF_MIN_POSTS` | app, primary-worker | integer ≥ 20, default 20 | Lantai statistik. Nilai < 20 ditolak saat startup. Mengubahnya butuh re-gate (§15.4). |
| `POTONGIN_PERF_HORIZON` | app, primary-worker | `7d` (default) \| `1d` \| `30d` | Horizon metrik untuk profil. |

Semua variabel masuk `.env.example` dan blok `environment` service yang bersangkutan di `compose.yaml`, dan dijaga `web/tests/env-example.test.mjs`.

**Env allowlist `social-worker`:** `NODE_ENV`, `TZ`, `POTONGIN_DB_PATH`, `POTONGIN_SETTINGS_SECRET`, `POTONGIN_SETTINGS_DIR`, `POTONGIN_PUBLIC_URL`, `POTONGIN_SOCIAL`, `SOCIAL_*`. Tidak ada env LLM, Groq, engine, `JOBS_ROOT`, `APP_*`, maupun `POTONGIN_PERFORMANCE`/`POTONGIN_PERF_*` (worker menarik metrik selama `POTONGIN_SOCIAL≠off`, terlepas dari flag performa; profil dihitung `app`/`primary-worker`). Dijaga `deploy-env-contract.test.mjs` (env **dan** mount, 01 §1.3).

**Drain deploy** (02 §10.5) tidak berlaku untuk `social-worker`: worker tidak me-mount `/data/jobs` sehingga tidak melihat penanda, dan tidak memakan slot pipeline/render. Penghentian saat deploy ditangani SIGTERM (§6.8 butir 5).

**Kredensial app per platform** disimpan admin lewat Pengaturan → Sistem → kartu "Aplikasi sosial" (`SocialAppsCard`), bukan env:
- File `${POTONGIN_SETTINGS_DIR}/social-apps.json` **(baru)** (= `/control/settings/social-apps.json`, 01 §1.2), mode 0600, disegel `sealing.mjs` v2 purpose `social-app` scope `instance` (02 §9.2).
- Isi per provider: `{ clientId, clientSecretBox, enabled, updatedAt }`. Instagram juga menyimpan `appSecretBox` untuk verifikasi `signed_request` Meta (§7.5).
- Provider tanpa kredensial atau `enabled:false` tidak muncul di UI anggota. Admin melihat label "Belum diatur di server".

---

## 4. Skema data

Semua tabel ada di SQLite control plane (`/control/potongin.sqlite`). **DDL, nomor migrasi, nama/tipe kolom, konvensi (`STRICT`, waktu `*_at` ms epoch UTC, enum yang bisa bertambah divalidasi JS bukan `CHECK … IN`, JSON `*_json`), dan lint aditif dimiliki 01** (§3–§4 di sana). Dokumen ini tidak memuat DDL; bila ada beda, 01 yang berlaku dan dokumen ini yang diubah.

| Migrasi (01 §3.1) | Fase · milestone | Tabel | DDL |
|---|---|---|---|
| `0003-social-base.sql` | Fase 6 · SOS-M1 Release A (R0) | `social_connections`, `oauth_pending`, `social_quota` | 01 §4.3 |
| `0005-posts.sql` | Fase 8 · SOS-M3a | `posts`, `publish_runs` | 01 §4.5 |
| `0006-user-time-zone.sql` | Fase 8 · i18n M7b | `users.time_zone` | 01 §4.6 |
| `0007-performance.sql` | Fase 9 · FB-M1 | `metric_snapshots`, `metric_horizons`, `metric_refresh`, `metric_imports`, `metric_import_rows`, `users.perf_use_in_selection` | 01 §4.7 |

Detak proses memakai tabel bersama `process_heartbeats` role `social` (01 §4.1, §2.2 aturan 6); tidak ada tabel detak khusus sosmed. Retensi/prune tabel-tabel ini: 01 §9.

### 4.1 Kolom yang dipakai dokumen ini (nama 01)

| Tabel | Kolom | Perilaku di |
|---|---|---|
| `social_connections` | `id`, `owner_id`, `provider`, `external_account_id`, `handle`, `display_name`, `avatar_url`, `scopes_json`, `status` (`active`\|`reauth_required`; putus akun = baris dihapus), `access_box`, `refresh_box`, `access_expires_at`, `refresh_expires_at`, `token_generation`, `refresh_lease_token`, `refresh_lease_until`, `last_error_code`, `connected_at`, `updated_at` | §7 |
| `oauth_pending` | `state_sha256`, `owner_id`, `session_sha256`, `provider`, `pkce_verifier_box`, `reconnect_id`, `return_path`, `created_at`, `expires_at` | §7.1 |
| `social_quota` | `provider`, `bucket` (`'instance'` \| `users.id` \| `social_connections.id`), `window_key`, `purpose` (`upload`\|`metrics`), `units_used`, `units_reserved`, `updated_at` | §10.2–§10.3 |
| `posts` | `id`, `owner_id`, `job_id`, `clip_id`, `clip_kind`, `provider`, `connection_id`, `origin` (`publish`\|`csv`\|`manual`\|`agent`), `external_id`, `url`, `posted_at`, `selection_keys_json`, `posted_features_json`, `packaging_json`, `edit_class`, `excluded_reason`, `error_code` (`social_processing_rejected`\|`social_remote_missing`), `source_key`, `created_at`, `updated_at`, `deleted_at` | §13, §14 |
| `publish_runs` | `id`, `owner_id`, `group_id`, `idempotency_key`, `request_sha256`, `connection_id` (NULL setelah putus akun), `connection_label`, `provider`, `job_id`, `clip_id`, `render_id`, `pin_path`, `pin_bytes`, `pin_sha256`, `duration_ms`, `text_json`, `options_json`, `scheduled_at`, `scheduled_tz`, `state`, `hold`, `next_attempt_at`, `attempts`, `defers`, `fence`, `lease_token`, `lease_until`, `checkpoint_json`, `upload_box`, `remote_id`, `post_id`, `error_code`, `error_params_json`, `error_detail`, `created_at`, `updated_at`, `finished_at`, `pin_released_at` | §6 |
| `metric_snapshots` | `id`, `post_id`, `owner_id`, `source` (`api`\|`csv`\|`manual`\|`agent`), `captured_at`, `age_hours`, `views`, `likes`, `comments`, `shares`, `saves`, `import_id`, `collapsed_at`, `aggregate_json` (`{"relViews":…}` setelah ciut), `created_at`, `deleted_at` | §10.4–§10.5, §14 |
| `metric_horizons` | `post_id`, `horizon` (`1d`\|`7d`\|`30d`), `owner_id`, `views`, `rel_views`, `quality` (`exact`\|`interpolated`\|`missing`), `rules_id`, `computed_at` | §10.6 |
| `metric_refresh` | `post_id`, `owner_id`, `next_due_at`, `last_ok_at`, `failures`, `stopped` | §10.4 |
| `metric_imports`, `metric_import_rows` | `id`, `owner_id`, `filename`, `profile`, `rows_total`, `state` (`preview`\|`committed`\|`discarded`), `created_at`, `expires_at`; baris: `import_id`, `row_no`, `provider`, `url`, `external_id`, `posted_at`, `captured_at`, `values_json`, `match_post_id`, `match_job_id`, `match_clip_id`, `status` (`matched`\|`unmatched`\|`invalid`\|`skipped`), `problem` | §14 |
| `users` | `perf_use_in_selection` (0/1, default 0; tidak ada tabel `performance_settings`) | §13.6 |
| `instance_settings` | kunci `social_cap_active`, `social_cap_hourly`, `social_yt_daily_overrides` (tabel kunci 02 §3.3) | §10.1–§10.2 |

### 4.2 Aturan pemakaian (milik dokumen ini)

- Nilai enum di atas = konstanta beku JS di modul pemilik: `RUN_STATES`, `RUN_HOLDS`, `CONNECTION_STATUSES` (`web/lib/social/store.mjs`), `POST_ORIGINS`, `EDIT_CLASSES` (`web/lib/post-registry.mjs`), `SNAPSHOT_SOURCES`, `IMPORT_ROW_STATUSES` (`web/lib/performance-store.mjs`). Setiap modul mendeklarasikan `REQUIRED_SCHEMA` dan memanggil `requireSchema` (01 §3.2).
- Tidak ada kolom `media_kind`: run selalu dari ekspor, `render_id` wajib (01 §4.5, §6.7). API menolak `media.kind` selain `export` (§9.1).
- Sesi unggah (session URI YouTube, `upload_url` TikTok) disimpan tersegel di kolom `publish_runs.upload_box` (purpose `oauth-token`, AAD `run:<runId>\0upload`, 01 §4.5); tidak pernah di `checkpoint_json`.
- `posts` origin `publish` dibuat **saat run menjadi `published`** (atau "Sudah terbit" dari `maybe_sent`), satu run → paling banyak satu `posts` (`post_id UNIQUE`). Run gagal tidak meninggalkan `posts`; "Coba lagi" = run baru (01 §4.5).
- Galat run = `error_code` + `error_params_json` (parameter pesan, opsional, ≤ 1 KiB) + `error_detail` (teks platform yang sudah diredaksi, tidak pernah dikirim ke klien anggota).
- Masalah setelah terbit disimpan di `posts.error_code` (01 §4.5): `social_processing_rejected` (YouTube menolak setelah terbit; run tetap `published`) dan `social_remote_missing` (ditulis saat `metric_refresh.failures` mencapai 3, §10.4).
- Putus akun = **baris `social_connections` dihapus** (purge, 01 §4.3). `posts.connection_id` dan `publish_runs.connection_id` menjadi `NULL` (`ON DELETE SET NULL`); run menyimpan `connection_label` untuk riwayat. Sambung ulang akun yang sama membuat baris baru (§7.4).
- `metric_snapshots` append-only; satu-satunya UPDATE adalah ciut (§10.5) dan soft delete (`deleted_at`), dijaga trigger 01 §4.7.
- Profil performa tidak punya tabel; dihitung deterministik dari `posts` + `metric_horizons` oleh `performance-profile.mjs`, di-cache di memori per `(owner_id, max(metric_snapshots.id))`.
- Klip turunan: `clip_kind='derived'`, `selection_keys_json=NULL`, `excluded_reason='derived'` (dipaksa `CHECK` 01 §4.5).
- Data privat per pengguna: setiap query memfilter `owner_id = ?` (dijaga `db-owner-scope.test.mjs`, 01 §4.7).

### 4.3 File di luar DB

| Path | Penulis | Isi | Retensi |
|---|---|---|---|
| `/data/social/media/<runId>.mp4` | app (saat run dibuat) | hard link ke file ekspor; fallback salin bila `EXDEV` | §6.7 |
| `<job>/analysis/performance-profile.json` | `primary-worker` (`preparePerformanceProfile`, sebelum spawn `run-job.mjs`) | snapshot profil v1 untuk job ini | ikut job |
| `${POTONGIN_SETTINGS_DIR}/social-apps.json` (= `/control/settings/social-apps.json`, 01 §1.2) | app (admin) | kredensial app tersegel | manual |

`/data/social` berada di volume `clipper_data` yang sama dengan `JOBS_ROOT`, sehingga hard link berfungsi. `social-worker` me-mount volume itu **read-write hanya di subpath `social`** (`volume.subpath: social` → `/data/social`; syarat Compose/Engine dan fallback ada di 01 §1.1, §5.1, §12 butir 6). Ia tidak melihat `/data/jobs`.

---

## 5. Antarmuka provider

Satu modul per platform di `web/lib/social/providers/<id>.mjs`, didaftarkan di `registry.mjs`. Modul provider **murni**: semua I/O lewat `http` yang disuntikkan, tanpa akses DB, tanpa jam global (`now` disuntikkan). Penggerak langkah ada di `publisher.mjs`.

### 5.1 Kontrak (JSDoc, dikunci tes `social-provider-contract.test.mjs`)

```js
/**
 * @typedef {'youtube'|'tiktok'|'instagram'} ProviderId
 * @typedef {{accessToken:string, refreshToken?:string, accessExpiresMs?:number,
 *            refreshExpiresMs?:number, scopes:string[]}} TokenSet
 * @typedef {{externalAccountId:string, handle:string, displayName:string, avatarUrl?:string}} AccountInfo
 * @typedef {{maxDurationMs:number, minDurationMs:number, maxBytes:number,
 *            privacyOptions:string[], allowsTitle:boolean, captionMax:number,
 *            hashtagMax:number, remainingPosts?:number, extra?:object}} PublishLimits
 * @typedef {{bytesSent:number, session?:string, remoteId?:string, phase:string}} Checkpoint
 *   // `session` mentah hanya di memori: publisher.mjs menyegelnya ke kolom
 *   // `publish_runs.upload_box` dan menyimpan checkpoint (§6.3) dalam satu CAS.
 * @typedef {{state:'pending', retryAfterMs:number}
 *         | {state:'published', externalId:string, url:string, postedMs:number}
 *         | {state:'failed', error:SocialError}
 *         | {state:'unknown'}} RemoteStatus
 *
 * @typedef {Object} SocialProvider
 * @property {ProviderId} id
 * @property {string[]} scopes                      // scope minimum, §5.2–5.4
 * @property {boolean} pkce
 * @property {(a:{clientId,redirectUri,state,codeChallenge?})=>string} authorizeUrl
 * @property {(a:{app,code,redirectUri,codeVerifier?,http})=>Promise<TokenSet>} exchangeCode
 * @property {(a:{app,tokens,http})=>Promise<TokenSet>} refresh
 * @property {(a:{app,tokens,http})=>Promise<void>} revoke     // best effort
 * @property {(a:{tokens,http})=>Promise<AccountInfo>} describe
 * @property {(a:{tokens,http})=>Promise<PublishLimits>} limits
 * @property {(text, options, media, limits)=>SocialError[]} validate   // murni, dipakai app & worker
 * @property {(ctx)=>Promise<Checkpoint>} begin    // buka sesi unggah / container
 * @property {(ctx)=>Promise<Checkpoint>} send     // kirim byte dari checkpoint.bytesSent
 * @property {(ctx)=>Promise<Checkpoint>} finish   // commit / publish
 * @property {(ctx)=>Promise<RemoteStatus>} poll   // status asinkron di platform
 * @property {(ctx)=>Promise<RemoteStatus>} reconcile  // setelah crash: cari tahu keadaan remote
 * @property {(a:{tokens,externalIds:string[],http})=>Promise<Map<string,Stats>>} readPostStats
 * @property {(externalIds:string[])=>number} statsCost  // unit kuota untuk satu batch
 * @property {number} statsBatch                           // id per panggilan
 */
```

`ctx = { run, checkpoint, tokens, file: {path, bytes, sha256, durationMs}, http, now, signal }`. Setiap fungsi melempar `SocialError` (§8) dan tidak pernah melempar error mentah. `publisher.mjs` menyimpan checkpoint yang dikembalikan **sebelum** memanggil langkah berikutnya.

### 5.2 YouTube (Data API v3, resumable upload)

- **Scope:** `https://www.googleapis.com/auth/youtube.upload`, `https://www.googleapis.com/auth/youtube.readonly` (untuk `channels.list mine=true` dan `videos.list` statistik). PKCE S256, `access_type=offline`, `prompt=consent` (supaya `refresh_token` selalu diberikan).
- **Token:** `POST https://oauth2.googleapis.com/token`. Revoke: `POST https://oauth2.googleapis.com/revoke` dengan `token=<refresh>`. Selama app Google berstatus *Testing*, refresh token kedaluwarsa setelah 7 hari **[V]** → koneksi masuk `reauth_required`; ini diterangkan di SOSMED.md, bukan di UI.
- **describe:** `GET /youtube/v3/channels?part=snippet&mine=true` → `externalAccountId=channel.id`, `handle=snippet.customUrl ?? snippet.title`.
- **limits:** statis: durasi ≤ 180 dtk agar dianggap Shorts **[V]**, `maxBytes` 256 GB **[V]** (praktis dibatasi ekspor), judul wajib ≤ 100 karakter, deskripsi ≤ 5000 byte UTF-8, `privacyOptions = ['public','unlisted','private']`. Klip > 180 dtk tetap boleh diunggah sebagai video biasa; UI menampilkan hint "Lebih dari 3 menit · bukan Shorts".
- **begin:** `POST https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status` dengan header `X-Upload-Content-Length`, `X-Upload-Content-Type: video/mp4`, body `{snippet:{title, description, tags, categoryId:'22'}, status:{privacyStatus, selfDeclaredMadeForKids, containsSyntheticMedia:false}}`. Respons 200 dengan header `Location` = session URI → checkpoint `{phase:'session', bytesSent:0}` + session URI tersegel di `upload_box`. Biaya kuota: **1600 unit [V]** dicatat saat `begin` berhasil.
- **send:** `PUT <session>` per chunk 8 MiB (kelipatan 256 KiB), header `Content-Range: bytes a-b/total`. 308 + header `Range: bytes=0-n` → `bytesSent=n+1`, checkpoint disimpan setiap chunk. Chunk terakhir menjawab 200/201 dengan resource video → `remoteId=video.id`, langsung ke `published`.
- **reconcile (setelah crash di `uploading`):** `PUT <session>` kosong dengan `Content-Range: bytes */total`. 308 → lanjut dari `Range`. 200/201 → video sudah jadi (`published`, ambil `id`). 404/410 (sesi kedaluwarsa, ± 1 minggu **[V]**) dan `bytesSent < total` → mulai ulang dari `begin` (belum ada video). 404/410 dan `bytesSent = total` (chunk terakhir terkirim tapi jawaban hilang) → **`maybe_sent`**.
- **poll:** tidak dipakai untuk status unggah. Setelah `published`, `videos.list part=status,processingDetails` sekali per 5 menit sampai 1 jam untuk menangkap `uploadStatus=rejected|failed` **[V]** → run tetap `published`, `posts.error_code='social_processing_rejected'` untuk ditampilkan (§4.2).
- **readPostStats:** `GET /youtube/v3/videos?part=statistics&id=<≤50 id>` → `viewCount, likeCount, commentCount` (tanpa shares). `statsCost = 1` per panggilan **[V]**, `statsBatch = 50`.
- **URL:** `https://www.youtube.com/shorts/<id>` bila durasi ≤ 180 dtk, selain itu `https://www.youtube.com/watch?v=<id>`.
- **Proyek belum diaudit:** video dari proyek API yang belum lolos audit dipaksa privat **[V]**. Selama itu, `validate` menolak `public`/`unlisted` dengan `social_privacy_unavailable` bila admin menandai `apps.youtube.audited=false` (default). Drawer hanya menampilkan "Privat".

### 5.3 TikTok (Content Posting API, Direct Post, `FILE_UPLOAD`)

- **Scope:** `user.info.basic`, `video.publish`, `video.list` (statistik). PKCE S256 **[V]**.
- **Token:** `POST https://open.tiktokapis.com/v2/oauth/token/`; access ± 24 jam, refresh ± 365 hari, refresh token bisa berganti di setiap refresh **[V]** → selalu simpan yang terbaru. Revoke: `POST /v2/oauth/revoke/`.
- **describe:** `GET /v2/user/info/?fields=open_id,display_name,avatar_url,username` **[V]**.
- **limits:** `POST /v2/post/publish/creator_info/query/` → `privacy_level_options`, `max_video_post_duration_sec`, `comment_disabled`, `duet_disabled`, `stitch_disabled`, `creator_nickname`. Dipanggil **setiap kali drawer dibuka** (lewat `GET /api/social/connections/:id/limits`, cache 60 dtk) dan sekali lagi oleh worker sesaat sebelum `begin`. Caption ≤ 2200 karakter **[V]**, tanpa judul terpisah (`allowsTitle=false`).
- **Syarat UX Direct Post** (syarat audit, **[V]**, wajib di `PublishDrawer` untuk TikTok): nama kreator ditampilkan; privasi dipilih pengguna **tanpa nilai default**; saklar komentar/duet/stitch (disabled bila kreator mematikannya); pengungkapan konten komersial (saklar + pilihan "Merek sendiri"/"Konten bermerek"); kalimat persetujuan musik dengan tautan kebijakan TikTok. Kalimat itu adalah kutipan wajib platform, disimpan di katalog `social.tiktok.consent` per locale.
- **begin:** `POST /v2/post/publish/video/init/` body `{post_info:{title:<caption>, privacy_level, disable_comment, disable_duet, disable_stitch, brand_content_toggle, brand_organic_toggle}, source_info:{source:'FILE_UPLOAD', video_size, chunk_size, total_chunk_count}}` → `publish_id`, `upload_url` (berlaku ± 1 jam **[V]**). Checkpoint `{phase:'session', remoteId:publish_id}` + `upload_url` tersegel di `upload_box` disimpan **sebelum** byte pertama. Chunk 10 MiB; file < 5 MiB dikirim satu chunk; chunk terakhir menampung sisa (≤ 2× chunk) **[V]**.
- **send:** `PUT upload_url` per chunk, `Content-Range: bytes a-b/total`, `Content-Type: video/mp4`. 206 = chunk diterima, 201 = selesai.
- **finish:** tidak ada panggilan; fase → `processing`.
- **poll:** `POST /v2/post/publish/status/fetch/ {publish_id}` → `PROCESSING_UPLOAD|PROCESSING_DOWNLOAD` = pending (ulang 10 dtk, lalu 30 dtk setelah 2 menit); `PUBLISH_COMPLETE` + `publicaly_available_post_id[0]` **[V]** = published; `FAILED` + `fail_reason` = failed (pemetaan §8). Untuk privasi `SELF_ONLY`, id posting publik bisa tidak ada → `externalId = publish_id`, `url = null`, `posts.external_id` = `publish_id` sampai `video.list` menemukannya.
- **reconcile:** kalau `remoteId` ada → `poll`. Status `PROCESSING_UPLOAD` dengan `upload_url` kedaluwarsa → `failed social_upload_expired` (aman diulang: TikTok tidak memposting tanpa unggah lengkap). Kalau `remoteId` tidak ada → belum ada apa pun di remote → ulang `begin`.
- **readPostStats:** `POST /v2/video/query/?fields=id,view_count,like_count,comment_count,share_count` body `{filters:{video_ids:[≤20]}}` **[V]**. `statsCost = 0` (TikTok tidak memakai unit; batas laju per token di §10.3), `statsBatch = 20`.
- **App belum diaudit:** semua posting dipaksa `SELF_ONLY` dan jumlah kreator dibatasi **[V]**. `validate` menolak opsi selain `SELF_ONLY` dengan `social_privacy_unavailable` selama `apps.tiktok.audited=false`.
- **`PULL_FROM_URL` tidak dipakai** (butuh verifikasi prefix domain). Tidak ada kode untuk itu.

### 5.4 Instagram (Instagram API dengan Instagram Login, Reels)

- **Scope:** `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_insights` **[V]**. Tanpa PKCE (`pkce=false`); state tetap wajib.
- **Token:** `POST https://api.instagram.com/oauth/access_token` (short-lived) → `GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token` (long-lived ± 60 hari) **[V]**. Tidak ada refresh token: `refresh` memanggil `GET /refresh_access_token?grant_type=ig_refresh_token` dengan token yang masih berlaku dan berumur ≥ 24 jam **[V]**. Revoke: tidak ada endpoint publik yang andal → `revoke` hanya menghapus lokal; SOSMED.md menjelaskan pencabutan dari pengaturan Instagram.
- **describe:** `GET https://graph.instagram.com/me?fields=user_id,username,name,profile_picture_url` **[V]**.
- **limits:** `GET /<ig-user-id>/content_publishing_limit?fields=quota_usage,config` → `remainingPosts = config.quota_total − quota_usage` (100 per 24 jam bergulir **[V]**). Reels 3 dtk–15 menit **[V]**, caption ≤ 2200 karakter, ≤ 30 hashtag **[V]**, tanpa judul, tanpa pilihan privasi.
- **begin (jalur utama, resumable):** `POST /<ig-user-id>/media` dengan `media_type=REELS&upload_type=resumable&caption=…&share_to_feed=true` → `id` container. Checkpoint `{phase:'session', remoteId:<container id>}` sebelum byte pertama.
- **send:** `POST https://rupload.facebook.com/ig-api-upload/<versi>/<container id>` dengan header `Authorization: OAuth <token>`, `offset: <bytesSent>`, `file_size: <total>`, body byte file. Resume memakai `offset` yang sama **[V]**.
- **begin (fallback URL publik):** dipakai hanya bila SOS-M0 menyatakan resumable tidak tersedia untuk akun itu. `POST /<ig-user-id>/media` dengan `media_type=REELS&video_url=<POTONGIN_PUBLIC_URL>/api/social/media/<token>` (§11.3); tidak ada `send`.
- **poll (container):** `GET /<container id>?fields=status_code,status` → `IN_PROGRESS` pending (ulang 15 dtk), `FINISHED` lanjut ke `finish`, `ERROR`/`EXPIRED` failed.
- **finish:** `POST /<ig-user-id>/media_publish creation_id=<container id>` → `id` media → published; URL dari `GET /<media id>?fields=permalink,timestamp`.
- **reconcile:** `GET /<container id>?fields=status_code` → `PUBLISHED` berarti `media_publish` sudah berhasil tapi id hilang: cari di `GET /<ig-user-id>/media?fields=id,caption,timestamp&limit=10`, cocokkan caption persis dan `timestamp ≥ run.claimed`; ketemu tepat satu → published; selain itu **`maybe_sent`**. `FINISHED` → panggil `finish`. `IN_PROGRESS` → `poll`. Container `EXPIRED` (± 24 jam **[V]**) → mulai ulang dari `begin`.
- **readPostStats:** `GET /<media id>/insights?metric=views,likes,comments,shares,saved` **[V]**, satu panggilan per media. `statsCost = 0`, `statsBatch = 1`, laju dibatasi §10.3.

### 5.5 Teks posting (`post-text.mjs`)

`composePostText({clip, provider, override})`:
1. Default diambil dari `servedClipText(job, clip)` (judul dan deskripsi yang tampil di halaman proyek, termasuk baris hashtag).
2. Hashtag dipisah dari deskripsi: token `#\p{L}[\p{L}\p{N}_]*` di baris terakhir menjadi `hashtags[]` (unik, urutan dipertahankan).
3. Per provider:
   - YouTube: `title` = judul dipotong di batas kata ≤ 100 karakter; `description` = caption + `\n\n` + hashtag dipisah spasi; `tags` = hashtag tanpa `#` (total ≤ 500 karakter).
   - TikTok: `caption` = judul + `\n\n` + caption + hashtag, ≤ 2200.
   - Instagram: `caption` = judul + `\n\n` + caption + hashtag (≤ 30), ≤ 2200.
4. Pemotongan tidak pernah memotong di tengah grapheme (`Intl.Segmenter`). Kalau masih kepanjangan setelah hashtag dikurangi, `validate` mengembalikan `social_text_invalid` dengan `params:{field, max}` dan drawer menampilkan sisa karakter.

Teks konten **tidak** diterjemahkan dan tidak mengikuti locale UI (aturan "bahasa UI ≠ bahasa konten").

---

## 6. Run terbit: state machine, scheduler, idempotensi

### 6.1 State

Transisi sah (selain ini → `IllegalTransition`, diuji tabel lengkap):

| # | Dari | Ke | Pemicu (pelaku) | Efek kolom |
|---|---|---|---|---|
| T1 | — | `scheduled` | create (app); "sekarang" = `scheduled_at = now` | `next_attempt_at = scheduled_at`, `hold = NULL`, `connection_label` = handle koneksi, `render_id` |
| T2 | `scheduled` (`hold IS NULL`, `next_attempt_at ≤ now`) | `claimed` | klaim unggah (worker, §6.2) | `fence+1`, `lease_*` diisi |
| T3 | `claimed` | `uploading` | `begin` sukses, checkpoint `session` tersimpan | `remote_id`, `checkpoint_json`, `upload_box` |
| T4 | `uploading` | `processing` | byte terakhir diterima (TikTok/IG) | `checkpoint.phase='sent'` |
| T5 | `uploading`/`processing` | `published` | platform konfirmasi (YouTube langsung dari `uploading`) | tx: `createPost(origin='publish')`, `post_id`, `finished_at`, lease `NULL` |
| T6 | `claimed`/`uploading`/`processing` | `scheduled` | retryable (`attempts+1 < 5`), deferred (`hold`), reauth (`hold='reauth'`), SIGTERM | `next_attempt_at`, lease `NULL`, checkpoint dipertahankan |
| T7 | `claimed`/`uploading`/`processing` | `failed` | permanent, `attempts` habis | `error_code`, `finished_at`, lease `NULL` |
| T8 | `uploading`/`processing` | `maybe_sent` | `reconcile` tidak bisa memastikan | `error_code='social_unknown_outcome'`, `finished_at` |
| T9 | `scheduled` | `failed` | `hold` atau defer > 7 hari sejak `scheduled_at` (maintenance) | `social_deferred_too_long` / `social_reauth_expired` |
| T10 | `scheduled` | `cancelled` | batal, hapus job, putus akun | `finished_at`, `error_code` alasan |
| T11 | `claimed`/`uploading` | `cancelled` | `checkpoint.cancelRequested` dilihat worker di batas langkah | `finished_at`, lease `NULL` |
| T12 | `maybe_sent` | `published` | pengguna "Sudah terbit" + URL (app) | tx: `createPost`, `post_id` |

Terminal: `published`, `failed`, `cancelled`, `maybe_sent` (kecuali T12). Lease kedaluwarsa tidak mengubah state; run direbut ulang lewat §6.2 dan diteruskan lewat `reconcile`.

| State | Arti | Boleh oleh pengguna | `Run.statusCode` (+ detail) |
|---|---|---|---|
| `scheduled` | Menunggu `next_attempt_at`; `hold` bisa `reauth`/`quota`/`rate` | Ubah teks/jadwal, Batalkan | `post.scheduled` (+ `hold.reauth` / `hold.quota`) |
| `claimed` | Worker memegang lease, sebelum byte pertama | Batalkan (diproses di batas langkah) | `post.uploading` |
| `uploading` | Byte sedang dikirim, checkpoint ada | Batalkan (best effort; lihat §6.5) | `post.uploading` |
| `processing` | Byte lengkap, platform memproses | — | `post.uploading` |
| `published` | Ada `post_id` | Buka | `post.published` |
| `failed` | Gagal permanen atau percobaan habis | Coba lagi (run baru) | `post.failed` |
| `maybe_sent` | Hasil remote tidak bisa dipastikan | "Sudah terbit" (isi URL) / "Unggah ulang" | `post.failed` (+ `detail.check`) |
| `cancelled` | Dibatalkan pengguna, putus akun, atau job dihapus | — | `post.cancelled` |

Kata yang tampil (Terjadwal, Mengunggah, Terbit, Gagal, Dibatalkan, dan detailnya), warna chip, dan penyaringan daftar dimiliki 05 §5 (kunci katalog `status.*`, 07 §7.1); `hold='rate'` memakai detail yang sama dengan `quota`. Kolom kanan di atas adalah kode yang dikirim API (`web/lib/social/view.mjs`), bukan teks.

Transisi hanya lewat fungsi di `store.mjs`, masing-masing sebuah `UPDATE … WHERE id=? AND state IN (…) [AND fence=? AND lease_token=?]` yang memeriksa `changes === 1`. Transisi yang tidak ada di tabel T1–T12 dilempar `IllegalTransition`.

### 6.2 Klaim dan lease ber-fence

Loop `scheduler.mjs`, tick 5 dtk (dengan jitter 0–1 dtk). Lease bebas = `lease_token IS NULL AND lease_until IS NULL` (CHECK berpasangan di 01 §4.5); tidak ada nilai "0".

**Klaim unggah** (slot `SOCIAL_UPLOAD_CONCURRENCY`):

```sql
-- dalam tx BEGIN IMMEDIATE, satu baris per slot kosong
UPDATE publish_runs
   SET state = CASE state WHEN 'scheduled' THEN 'claimed' ELSE state END,
       fence = fence + 1, lease_token = :token, lease_until = :now + 120000,
       updated_at = :now
 WHERE id = (
   SELECT r.id FROM publish_runs r
     JOIN social_connections c ON c.id = r.connection_id AND c.status = 'active'
    WHERE ( (r.state = 'scheduled' AND r.hold IS NULL AND r.next_attempt_at <= :now)
         OR (r.state IN ('claimed','uploading') AND r.lease_until < :now) )
      AND NOT EXISTS (SELECT 1 FROM publish_runs o
                       WHERE o.connection_id = r.connection_id AND o.id <> r.id
                         AND o.state IN ('claimed','uploading') AND o.lease_until >= :now)
    ORDER BY r.next_attempt_at, r.created_at LIMIT 1)
RETURNING id, state, fence, checkpoint_json;
```

Indeks yang dipakai: `publish_runs_due` (`next_attempt_at`, parsial `state='scheduled' AND hold IS NULL`), `publish_runs_leased`, `publish_runs_conn` (01 §4.5).

**Klaim poll** (loop poll, paralel ≤ 8, tidak memakan slot unggah): query yang sama dengan predikat `r.state = 'processing' AND (r.lease_token IS NULL OR r.lease_until < :now) AND r.next_attempt_at <= :now`, tanpa `NOT EXISTS`. Setelah satu `poll` yang masih `pending`, worker menulis `next_attempt_at = now + retryAfterMs` dan melepas lease (keduanya `NULL`) dalam CAS yang sama.

- Per koneksi paling banyak 1 run `claimed|uploading`.
- Lease 120 dtk, diperpanjang setiap 30 dtk dan setelah setiap chunk (`UPDATE … SET lease_until=… WHERE id=? AND fence=? AND lease_token=?`). Perpanjangan gagal (`changes=0`) → worker **langsung berhenti** mengerjakan run itu (fence sudah dipegang proses lain).
- Run tanpa koneksi (`connection_id` NULL setelah putus) atau milik koneksi `reauth_required` tidak pernah cocok dengan JOIN; putus akun sudah membatalkan atau menandainya (§7.4).
- Run yang direbut dari lease kedaluwarsa masuk lewat `reconcile` provider, bukan `begin`.

### 6.3 Checkpoint

`checkpoint_json`: `{ phase: 'none'|'session'|'sent'|'committed', bytesSent, remoteId?, claimedAt, limitsSeen?, cancelRequested? }`. Fase `committed` = `finish`/`media_publish` sudah dikirim.
- Session URI YouTube / `upload_url` TikTok tidak pernah ada di `checkpoint_json`; yang disimpan hanya kolom `upload_box` = kotak `sealing.mjs` v2 purpose `oauth-token`, scope pemilik, AAD `run:<runId>\0upload` (01 §4.5). `GET /api/social/posts*` tidak pernah mengirim `upload_box`.
- Ditulis lewat CAS `WHERE fence=? AND lease_token=?` setelah setiap langkah yang berhasil dan setelah setiap chunk.
- `remote_id` disalin ke kolom sendiri begitu diketahui (dipakai `reconcile`, putus akun, dan UI admin).

### 6.4 Percobaan, backoff, defer

Kelas error ada di §8.
- **retryable:** `attempts += 1`; `attempts < 5` → `state='scheduled'`, `next_attempt_at = now + backoff[attempts]` dengan `backoff = [1, 5, 15, 60, 180]` menit, jitter ±20%; checkpoint dipertahankan. `attempts = 5` → `failed` (`social_attempts_exhausted`; kode terakhir ditulis di `error_detail`).
- **deferred** (kuota habis, laju platform, batas posting harian): `attempts` **tidak** berubah, `defers += 1`, `hold='quota'|'rate'`, `next_attempt_at` = waktu reset yang diketahui (YouTube: tengah malam America/Los_Angeles berikutnya; Instagram: `quota_usage` turun, cek ulang tiap 60 menit; laju: `Retry-After` atau 15 menit). Worker membuka `hold` sendiri saat `next_attempt_at` lewat. Batas: kalau `now − scheduled_at > 7 hari` → `failed social_deferred_too_long`.
- **reauth:** koneksi → `reauth_required`; semua run koneksi itu yang `scheduled` mendapat `hold='reauth'`; run `claimed|uploading|processing` kembali ke `scheduled` (T6) dengan `hold='reauth'` dan checkpoint utuh, sehingga saat diklaim ulang ia lewat `reconcile`. Setelah koneksi aktif lagi (OAuth ulang dengan `reconnect_id`), `hold` dibersihkan dalam transaksi yang sama. Run `hold='reauth'` lebih dari 7 hari setelah `scheduled_at` → `failed social_reauth_expired`.
- **permanent:** langsung `failed`.
- **unknown_outcome:** `maybe_sent` (tidak pernah diulang otomatis).

### 6.5 Batal

`POST /api/social/posts/:runId/cancel`:
- `scheduled` → `cancelled` langsung.
- `claimed|uploading` → set `checkpoint_json.cancelRequested=true` (UPDATE dengan `json_set`, tanpa fence; satu-satunya tulis app ke run yang sedang dipegang worker); worker memeriksanya sebelum `begin`, di antara chunk, dan sebelum `finish`. YouTube: sesi resumable yang ditinggalkan tidak menghasilkan video. TikTok: sesi tanpa chunk lengkap tidak terposting. Instagram: container tanpa `media_publish` kedaluwarsa sendiri. → `cancelled`.
- `processing|published|failed|maybe_sent|cancelled` → 409 `social_not_cancellable`. Menghapus posting yang sudah terbit dilakukan pengguna di platform; Potongin tidak menghapus konten remote.

### 6.6 Idempotensi

- **Klien → app:** `POST /api/social/posts` wajib header `Idempotency-Key: <uuid v4>`. Satu key + satu target = satu run (`publish_runs_idem`). `request_sha256` = sha256 JSON kanonik (kunci diurutkan) dari body tanpa `when.mode='now'` timestamp. Handler pertama-tama `SELECT … WHERE owner_id=? AND idempotency_key=?`: ada dan semua `request_sha256` sama → 200 `{groupId, runs}` yang ada; ada tapi beda → 409 `social_idempotency_conflict`; tidak ada → lanjut create. Key berlaku selamanya (tidak ada TTL; baris run tidak pernah dihapus kecuali hapus pengguna). `PublishDrawer` membuat key saat drawer dibuka dan memakainya untuk semua percobaan submit.
- **Worker → platform:** platform tidak menyediakan idempotency key. Exactly-once dijamin oleh: (a) `remoteId`/session disimpan sebelum byte pertama, (b) `reconcile` sebelum mengulang langkah apa pun, (c) `maybe_sent` bila (b) tidak bisa memastikan. Tidak ada jalur yang memanggil `begin` dua kali untuk run yang checkpoint-nya sudah `sent`/`committed`.
- **Hapus job:** `DELETE` di `web/app/api/jobs/[id]/route.js` (satu-satunya pemanggil `requestJobDeletion` hari ini; `purgeDeletedJobs` di `web/scripts/primary-worker.mjs` hanya membersihkan job yang sudah diminta hapus) memanggil `cancelRunsForJob(ownerId, jobId)` **sebelum** `requestJobDeletion(jobsRoot, id)`. Jalur hapus job baru di masa depan wajib memanggilnya juga (tes `social-job-delete.test.mjs` mencari semua pemanggil `requestJobDeletion`). run `scheduled` → `cancelled` (`error_code='social_job_deleted'`); run yang sedang jalan diberi `cancelRequested`. `posts` yang sudah terbit tetap ada (punya snapshot `packaging_json`), metriknya tetap ditarik. Admin yang menghapus job orang lain (`DELETE /api/admin/jobs/[id]`, 02 §8.2) memanggil `cancelRunsForJob(ownerIdJob, jobId)` dengan cara yang sama.
- **Hapus klip turunan** (`DELETE /api/jobs/:id/derived-clips/:clipId`, 06 §11.6): lib memanggil `cancelRunsForClip(ownerId, jobId, clipId)` (`web/lib/social/store.mjs`, aturan sama dengan `cancelRunsForJob`, `error_code='social_clip_deleted'`) dan mengembalikan jumlahnya sebagai `cancelledPosts`.

### 6.7 Media dan pin

`media.mjs` → `pinMediaForRun({ownerId, jobId, clipId, media})`, dijalankan **app** di dalam handler create, sebelum transaksi insert:
1. Sumber selalu **ekspor** (roadmap induk X4, Q7): `media = {kind:'export', renderId}`; run menyimpan `render_id` (tidak ada kolom `media_kind`, 01 §4.5). `kind` lain (termasuk `'auto'`) → 400 `invalid_request`. Baca dengan `readRenderRequestFile(jobId, renderId, jobsRoot)` (`web/lib/clip-renders.mjs`); wajib `version='render-request-v3'`, `state='completed'`, `clip_id=clipId`, dan `completed_by ∈ {render, seed, key}` (validasi `validateRenderRequestV3` yang sudah ada; `completed` hanya dicapai setelah `verify.py` atau R10). Selain itu → 409 `social_media_unavailable`. File = `<job>/<output_relative>`.
2. Default bila `media` tidak dikirim: ekspor `completed` terbaru klip itu (`listClipRenders(jobId, clipId, jobsRoot)`, urut `completed_at` menurun).
3. **Tidak ada ekspor selesai** → 409 `social_media_unavailable` dengan `params.needsExport=true`. `PublishDrawer` lalu mengekspor sendiri lewat jalur yang sudah dipakai `web/lib/clip-hook.mjs`: `GET /api/jobs/:id/clips/:clipId/edit` (ETag dokumen) → `POST /api/jobs/:id/clips/:clipId/renders {editEtag}`. Klip yang belum diedit selesai seketika (R10: dokumen = seed, file otomatis di-hard-link, 200 `completed`), lalu submit diulang dengan `Idempotency-Key` yang sama. Bila pemanggil memberi prop `onRequestExport` (editor, 06 §11.10; props drawer 05 §6.5), drawer memakai fungsi itu sebagai pengganti jalur ini supaya edit yang belum tersimpan ikut diekspor. Ekspor yang masuk antrean (202) → drawer menampilkan "Mengekspor…" dan submit otomatis saat `GET /api/jobs/:id/renders/:renderId` `completed`. Tidak ada media `auto` di luar ekspor.
4. Buka dengan `O_NOFOLLOW`, cek `isFile`, ukuran > 0, lalu `link()` ke `/data/social/media/<runId>.mp4`; `EXDEV` → salin + `fsync`. Hitung sha256 saat salin/baca. Durasi dibaca dari kotak `moov/mvhd` file itu oleh `web/lib/social/mp4-duration.mjs` **(baru**, JS murni, membaca ≤ 64 KiB per kotak, mvhd v0/v1; gagal → 409 `social_media_unavailable`); tidak ada ffprobe di app.
5. Cek ruang: pin hard link tidak memakan ruang baru, tetapi salinan `EXDEV` lewat `evaluateStorageAdmission` (`web/lib/storage-admission.mjs`).
6. Ekspor yang dihapus pengguna setelah pin dibuat tidak memengaruhi run (hard link); pin dihitung sebagai yatim (di bawah).

Retensi pin (sweep di `social-worker` setiap 10 menit, `retention.mjs`):
- `published` → hapus pin 1 jam setelah `finished_at`.
- `failed|cancelled|maybe_sent` → hapus setelah `SOCIAL_PIN_KEEP_DAYS` hari.
- Sweep hanya menghapus file di `realpath(/data/social/media)` yang namanya `<uuid>.mp4` dan tercatat di `publish_runs.pin_path` dengan `pin_released_at IS NULL` (indeks `publish_runs_pin`, 01 §4.5); setelah file dihapus `pin_released_at` diisi (`pin_path` tetap sebagai catatan). File yatim (tanpa baris) dihapus setelah 24 jam. Path apa pun di bawah `JOBS_ROOT` ditolak (tes negatif).
- "Coba lagi" setelah pin dihapus → membuat pin baru dari sumber; sumber hilang → 409 `social_media_unavailable`.
- Pin yatim (`nlink = 1`, file ekspor sudah dihapus) dihitung di status storage (`storage-status-dto.mjs`) dan admission.

### 6.8 Proses `social-worker`

`web/scripts/social-worker.mjs`:
1. Validasi env allowlist; `POTONGIN_SOCIAL=off` → hanya heartbeat (tidak mengklaim, tidak refresh, tidak sweep), tetap healthy.
2. Buka DB `openDb({role:'social'})` (`web/lib/db/index.mjs`, baru dari 01), `requireSchema(REQUIRED_SCHEMA_SOCIAL)`; skema lebih tua → perilaku 01 §2.4 (coba ulang tiap 2 dtk maks 60 dtk, lalu exit 78 → healthcheck gagal → rollback). Worker tidak pernah memigrasi; hanya role `app` yang boleh.
3. Empat loop independen: **publish** (5 dtk), **poll** (5 dtk), **tokens** (60 dtk: refresh token yang kedaluwarsa ≤ 10 menit lagi; Instagram yang kedaluwarsa ≤ 20 hari lagi), **maintenance** (10 menit: sweep pin, `oauth_pending` kedaluwarsa, penciutan YouTube §10.5, `metrics-refresh` §10).
4. Heartbeat: baris `process_heartbeats` role `social` (01 §2.2) + file `/tmp/social-worker-health.json` `{version:1, pid, heartbeatAt, lastLoopAt:{publish,poll,tokens,maintenance}, mode:'active'|'heartbeat'}` setiap 10 dtk. `check-social-worker-health.mjs` mengikuti pola `web/scripts/check-primary-worker-health.mjs` (buka `O_NOFOLLOW`, ≤ 16 KiB, `process.kill(pid,0)`): sehat bila `heartbeatAt` < 30 dtk dan, di mode `active`, `lastLoopAt.publish` < 60 dtk.
5. SIGTERM: berhenti mengklaim, tunggu langkah aktif selesai paling lama 90 dtk (lebih kecil dari `stop_grace_period: 120s`), simpan checkpoint, lepas lease (T6: `lease_token = NULL, lease_until = NULL`, `next_attempt_at = now`, supaya langsung diklaim ulang). Chunk yang terpotong diulang dari checkpoint.
6. Compose (R1, dokumen ini pemilik definisi service; 08 §9.4/§9.7 menyalinnya): image app, `command: ["node","scripts/social-worker.mjs"]`, `cpus: 0.5`, `mem_limit: 512m`, `stop_grace_period: 120s`, `read_only: true`, `tmpfs: /tmp`, mount `potongin_control:/control` dan `clipper_data` subpath `social` → `/data/social` (01 §1.3), env = allowlist §3, healthcheck `node scripts/check-social-worker-health.mjs` (interval 10s, retries 3, start_period 20s), `restart: unless-stopped`.

---

## 7. OAuth: sambung, refresh, putus

### 7.1 Sambung

1. `POST /api/social/connect/:provider` (form, `sameOriginMutation`) → app membuat `state` 32 byte acak base64url, `code_verifier` 64 byte (bila `pkce`), menyimpan `oauth_pending{state_sha256, owner_id, session_sha256 (= sha256 sid sesi, 02 §4.1), provider, pkce_verifier_box, reconnect_id?, return_path='/sosial?tab=akun', expires_at=now+10 menit}` → **303** ke `authorizeUrl`. `reconnect_id` wajib koneksi milik pengguna yang masih ada. Batas: 5 baris `oauth_pending` belum kedaluwarsa per pengguna. Karena ini form native, error tidak dijawab JSON: batas terlampaui (`social_rate_limited`), provider tanpa kredensial/`enabled:false` atau `POTONGIN_PUBLIC_URL` kosong (`social_provider_unconfigured`) → **303** `/sosial?tab=akun&hasil=gagal` (kode dicatat di log, tidak di URL). Flag mati / peran tidak diizinkan tetap 404 identik.
2. Platform → `GET /api/social/callback/:provider?code&state` (atau `error`). Route ini tetap di belakang `proxy.js` (cookie sesi `SameSite=Lax` ikut pada navigasi GET tingkat atas).
3. Callback: hapus baris `oauth_pending` dengan `state_sha256` itu dalam satu tx (`DELETE … RETURNING`), lalu periksa: ada, belum kedaluwarsa, `owner_id` = pengguna sesi, `session_sha256` = sesi ini, `provider` = `:provider` path. Gagal → 303 ke `/sosial?tab=akun&hasil=gagal` (kode `social_state_invalid`, tanpa membocorkan alasan).
4. `error=access_denied` → 303 `?hasil=ditolak`.
5. Tukar `code` (tanpa tx terbuka) → `describe` → periksa scope yang diberikan ⊇ `provider.scopes` (kurang → `revoke`, 303 `?hasil=gagal`, kode `social_scope_missing`).
6. Tx: cari baris per `(owner_id, provider, external_account_id)` (indeks unik `social_connections_account`, 01 §4.3); kalau ada → perbarui token, `token_generation+1`, `status='active'`, `last_error_code=NULL`, bersihkan `hold='reauth'` run-runnya (`UPDATE publish_runs SET hold=NULL, next_attempt_at=max(next_attempt_at,:now) WHERE connection_id=? AND hold='reauth'`); kalau tidak ada → insert baris baru (akun yang dulu diputus sudah dihapus barisnya, jadi mendapat baris baru). Kalau `reconnect_id` ada tetapi `external_account_id` berbeda (pengguna login akun lain) → koneksi baru dibuat, koneksi lama tetap `reauth_required`, hasil `?hasil=terhubung`. Batas 3 koneksi per provider per pengguna (lebih → `revoke` token baru, 303 `?hasil=gagal`, kode `social_connection_limit`).
7. 303 ke `return_path` + `&hasil=terhubung`. Audit `social.connected {provider}` (01 §4.1).

### 7.2 Penyimpanan token

- `access_box`, `refresh_box`: `seal({purpose:'oauth-token', scope:'user:'+ownerId, field:'account:'+connectionId+'\0access'|'\0refresh'}, value)` (API `seal`/`open`, format kotak dan kunci: 02 §9.2; "AAD" di dokumen ini = `field`).
- Token tidak pernah ada di respons API, log, error, job.json, atau argv. `redact.mjs` menyaring pola `ya29.`, `Bearer `, `access_token=`, `refresh_token=`, `code=`, `upload_id=`, `ptk_`. Tes `social-redact.test.mjs` memakai string palsu yang tidak terdeteksi gitleaks.
- Mengganti `POTONGIN_SETTINGS_SECRET` membuat kotak tak terbuka → `unseal` gagal → koneksi `reauth_required` (`social_token_unreadable`).

### 7.3 Refresh dua fase (hanya `social-worker`)

```
Fase A (tx):  UPDATE social_connections
                 SET refresh_lease_token=:L, refresh_lease_until=:now+60000
               WHERE id=:id AND status='active' AND token_generation=:g
                 AND (refresh_lease_token IS NULL OR refresh_lease_until < :now)
              -- changes=0 → orang lain sedang refresh; pakai token terbaru di tick berikut
              SELECT refresh_box ...   (unseal di luar tx)
Jaringan:     provider.refresh(...)   timeout 20 dtk, tanpa tx
Fase B (tx):  UPDATE social_connections
                 SET access_box=:a, refresh_box=COALESCE(:r, refresh_box),
                     access_expires_at=:e, token_generation=:g+1,
                     refresh_lease_token=NULL, refresh_lease_until=NULL, last_error_code=NULL
               WHERE id=:id AND token_generation=:g AND refresh_lease_token=:L
              -- changes=0 → lease kita sudah lewat dan proses lain menang:
              --   log social_refresh_race_lost, buang hasil kita
```

- Hasil `invalid_grant` / 401 dari endpoint token → Fase B versi gagal: `status='reauth_required'`, `last_error_code='social_reauth_required'`, lepas lease, terapkan `hold='reauth'` (§6.4). Error jaringan/5xx → lepas lease, coba di tick berikut (backoff 1→2→4→… maks 30 menit per koneksi, disimpan di memori).
- Langkah publish yang mendapat 401 dari API data memicu refresh sekali (lewat jalur yang sama), lalu mengulang langkah itu sekali. 401 kedua → reauth.
- Lease 60 dtk > timeout 20 dtk, sehingga dua refresh paralel hanya mungkin bila proses terhenti lebih dari 40 dtk di tengah jalan; kasus itu ditangani CAS `token_generation`.

### 7.4 Putus akun

`DELETE /api/social/connections/:connectionId` (re-auth tidak diperlukan; `sameOriginMutation` wajib):
1. Tx: semua run `scheduled` koneksi itu → `cancelled` (`social_disconnected`); run `claimed|uploading|processing` diberi `cancelRequested` (worker berhenti di batas langkah; token yang sudah dicabut membuat langkah berikutnya gagal → `cancelled`). Buka kotak token yang perlu dicabut (di memori).
2. Tanpa tx: `provider.revoke` (best effort, timeout 10 dtk; gagal hanya dicatat).
3. Tx (purge, aturan 01 §4.3): `DELETE FROM metric_snapshots WHERE source='api' AND post_id IN (posting koneksi itu)` (hard delete, kebijakan platform); `DELETE FROM metric_horizons` dan `metric_refresh` posting itu (horizon dibangun ulang lazily dari snapshot CSV/manual yang tersisa); `DELETE FROM social_quota WHERE bucket=:id`; lalu `DELETE FROM social_connections WHERE id=? AND owner_id=?` (FK `posts.connection_id`/`publish_runs.connection_id` → `NULL`; riwayat Terbit memakai `publish_runs.connection_label`). `posts` tetap; snapshot CSV/manual tidak disentuh.
4. Audit `social.disconnected {provider}` lalu `social.purged {provider}` (01 §4.1). Respons 200 `{cancelledRuns:n}`. UI: AlertDialog "Putuskan @kanal? {n} jadwal dibatalkan." — `n` dari `GET /api/social/connections` (`scheduledCount`).

Penghapusan pengguna (hook `DELETE /api/admin/users/[userId]`, 02 §8.2) memanggil `disconnectAll(ownerId)` (langkah 1–3 per koneksi) lalu baris `social_connections`, `posts`, `publish_runs`, `metric_*` milik pengguna itu hilang lewat `ON DELETE CASCADE` dari `users`, plus file pin `/data/social/media/<runId>.mp4` miliknya dihapus.

### 7.5 Callback Meta (wajib untuk App Review Instagram)

- `POST /api/social/meta/deauthorize` dan `POST /api/social/meta/data-deletion`: publik (dikecualikan di `proxy.js`), body `application/x-www-form-urlencoded` ≤ 16 KiB, field `signed_request`. Verifikasi HMAC-SHA256 dengan `appSecret` Instagram (`timingSafeEqual`), algoritma `HMAC-SHA256`, umur `issued_at` ≤ 1 jam **[V]**. Gagal → 400 tanpa detail.
- Keduanya mencari `social_connections` dengan `provider='instagram'` dan `external_account_id = user_id`, lalu menjalankan putus akun §7.4 (tanpa langkah `provider.revoke`).
- `data-deletion` menjawab `{ url: "<PUBLIC>/hapus-data/<code>", confirmation_code: "<code>" }`; `code` = 16 byte acak (22 karakter base64url), disimpan di `params_json` baris audit `social.data_deleted` (`{"provider":"instagram","code":"<code>"}`, `actor_kind='system'`, 01 §4.1). `GET /hapus-data/[code]` **(baru, publik exact-path)** menampilkan status "Data dihapus" + tanggal, tanpa data pribadi.

---

## 8. Taksonomi error

Dokumen ini pemilik **daftar kode** `social_*` dan `performance_*` (registry `web/lib/social/errors.mjs` dan `web/lib/performance-store.mjs`, didaftarkan ke `web/lib/error-codes.mjs`, 07 §10.2). Bentuk respons dan pemetaan ke teks milik 07 §10.1–§10.3: bentuk datar `{ error: "<pesan Indonesia>", code, messageId, params? }` dengan `messageId = "social.<code>"` atau `"performance.<code>"`; kunci katalog = `"errors." + messageId` tanpa transformasi (mis. `errors.social.social_cap_hourly`) di `web/messages/<locale>/errors.json` untuk **setiap** locale; setiap kode punya entri Bantuan (`web/lib/help-catalog.mjs`). Galat umum memakai kode milik 02/07 apa adanya: 400 `invalid_request`, 401 `unauthorized`, 403 `csrf_rejected`/`reauth_required`, 404 `not_found` (body identik 02 §7.4), 413 `request_too_large`, 429 `rate_limited`.

| Kode | Kelas | HTTP (API) | Sumber |
|---|---|---|---|
| `social_disabled` | — | 404 (`not_found` identik) | flag `off` / peran tidak diizinkan |
| `social_provider_unconfigured` | — | 409 (connect form: 303 `?hasil=gagal`) | app belum diatur admin |
| `social_state_invalid` | — | 303 `?hasil=gagal` | callback OAuth |
| `social_denied` | — | 303 `?hasil=ditolak` | pengguna menolak izin |
| `social_scope_missing` | — | 303 `?hasil=gagal` | scope kurang |
| `social_connection_limit` | — | 409 | > 3 koneksi per provider |
| `social_cap_scheduled` | — | 429 | > 100 run aktif |
| `social_cap_hourly` | — | 429 | > 20 run dalam satu jam jadwal |
| `social_schedule_invalid` | — | 422 | jadwal < sekarang + 2 menit atau > 90 hari (§9.1) |
| `social_time_nonexistent` | — | 422 | waktu lokal jatuh di celah DST zona `tz` (07 §13.4) |
| `social_url_invalid` | — | 422 | URL "Sudah terbit" bukan URL posting provider itu |
| `social_media_unavailable` | — | 409 | tidak ada ekspor selesai / file hilang |
| `social_text_invalid` | permanent | 422 | `validate` (params `field`, `max`) |
| `social_duration_exceeded` | permanent | 422 | `validate` |
| `social_privacy_unavailable` | permanent | 422 | opsi privasi tidak diizinkan |
| `social_idempotency_conflict` | — | 409 | key sama, body beda |
| `social_not_cancellable` | — | 409 | §6.5 |
| `social_reauth_required` | reauth | — (status run) | 401 / `invalid_grant` |
| `social_token_unreadable` | reauth | — | unseal gagal |
| `social_quota_exhausted` | deferred | 429 saat create bila jatah hari ini habis dan jadwal = sekarang | kuota YouTube, batas IG |
| `social_rate_limited` | deferred | 429 | 429 platform / batas laju lokal |
| `social_platform_unavailable` | retryable | — | 5xx, timeout, jaringan |
| `social_upload_expired` | retryable | — | sesi/URL unggah kedaluwarsa sebelum lengkap |
| `social_media_rejected` | permanent | — | platform menolak file (format, durasi, hak cipta) |
| `social_account_unavailable` | permanent | — | akun diblokir / bukan akun profesional |
| `social_processing_rejected` | info | — | YouTube menolak setelah terbit (`error_code` run `published`) |
| `social_remote_missing` | info | — | turunan view: posting tidak ditemukan 3× saat tarik metrik (§4.2) |
| `social_unknown_outcome` | unknown_outcome | — | §6.6 → `maybe_sent` |
| `social_attempts_exhausted` | — | — | percobaan ke-5 |
| `social_deferred_too_long` | — | — | defer > 7 hari |
| `social_reauth_expired` | — | — | reauth > 7 hari |
| `social_job_deleted`, `social_clip_deleted`, `social_disconnected`, `social_cancelled` | — | — | pembatalan |
| `social_fake_origin_forbidden` | — | — (startup gagal) | §12.4 |

**Performa** (§9.3, §14):

| Kode | HTTP | Sumber |
|---|---|---|
| `performance_post_exists` | 409 | `POST /api/posts` untuk URL/`external_id` yang sudah terdaftar |
| `performance_url_invalid` | 422 | URL bukan posting YouTube/TikTok/Instagram |
| `performance_metric_invalid` | 422 | angka negatif/desimal/singkatan (juga kode masalah baris §14.4) |
| `performance_post_not_deletable` | 409 | `DELETE /api/posts/:postId` untuk origin `publish`/`agent` |
| `performance_import_too_large` | 413 | file > 2 MiB atau > 5000 baris |
| `performance_import_invalid` | 422 | bukan CSV UTF-8 / header rusak |
| `performance_import_unknown_columns` | 422 | header tidak cocok template atau profil (`params.columns`) |
| `performance_import_state` | 409 | commit/patch pada impor yang bukan `preview` |
| `performance_profile_collecting` | 422 | toggle dinyalakan saat profil masih `collecting` (§13.6) |
| `performance_row_*` | — (status baris) | §14.4 |

Pemetaan error platform ke kode ini ada di masing-masing modul provider sebagai tabel konstan dan diuji per baris dengan fake platform. Teks error platform hanya masuk `error_detail` setelah `redact`.

---

## 9. API

Aturan umum semua route di bagian ini:
- Guard = `secureRoute` yang diperluas 02 §7.2 (urutan langkah, `sameOriginMutation` → 403 `csrf_rejected`, `ROUTE_PARAMS` → 400 `invalid_request`). Default route bagian ini: `{role:"member", owner:"none", notFound:"web"}`; `/api/jobs/:id/clips/:clipId/posts` memakai `{owner:"job", notFound:"edit"}`; `/api/settings/social-apps` `{role:"admin", reauth:true}` untuk PUT (02 §6.7); `/api/ingest/metrics` `{auth:{token:"metrics:write"}}` (02 §9.4). Baris untuk matriks route 02 §8 dan `route-guard-coverage` diambil dari tabel di bawah. Parameter path: `ROUTE_PARAMS` (UUID; `clipId` = `clip_[0-9a-f]{24}`; tambahan §2.1).
- Gate fitur: `POTONGIN_SOCIAL=off` (atau `admin` dan pengguna bukan admin) → seluruh `/api/social/**` dan `/api/jobs/:id/clips/:clipId/posts` dijawab 404 dengan body/header **identik** dengan 404 "tidak ada" keluarga yang sama (02 §7.4). Sama untuk `POTONGIN_PERFORMANCE=off` pada `/api/performance/**`, `/api/settings/performance`, `/api/posts/**`. `/api/analytics/**` aktif bila salah satu flag aktif.
- Kepemilikan: setiap baris dicari dengan `WHERE owner_id = :principal.id` (kolom `owner_id` di semua tabel, 01 §4). Milik orang lain = 404 identik (`ownership-matrix`). Admin tidak punya akses implisit.
- Respons `Cache-Control: no-store`. Waktu di JSON = ISO 8601 UTC (`…Z`). Angka metrik = integer atau `null`.
- Rate limit (`web/lib/rate-limit.mjs`): mutasi sosmed 30/menit per pengguna; impor CSV 10/jam per pengguna.

### 9.1 Sosmed

| Metode & path | Auth | Request | Respons 2xx | Error |
|---|---|---|---|---|
| `GET /api/social/providers` | user | — | `{providers:[{id, configured, audited, limitsStatic}]}` (yang `configured` saja untuk member) | — |
| `POST /api/social/connect/:provider` | user, form | `reconnectId?` | 303 ke platform | 404 (flag/peran); error lain → 303 `/sosial?tab=akun&hasil=gagal` (§7.1) |
| `GET /api/social/callback/:provider` | user (cookie) | `code`, `state` / `error` | 303 `/sosial?tab=akun&hasil=terhubung\|ditolak\|gagal` | (selalu 303) |
| `GET /api/social/connections` | user | — | `{connections:[{id, provider, handle, displayName, avatarUrl, status:'active'\|'reauth_required', scheduledCount, connectedAt}]}` | — |
| `GET /api/social/connections/:connectionId/limits` | user | — | `PublishLimits` (§5.1) + `creatorNickname?` | 404, 409 `social_reauth_required`, 503 `social_platform_unavailable` |
| `DELETE /api/social/connections/:connectionId` | user | — | `{cancelledRuns}` | 404 |
| `POST /api/social/posts` | user, JSON ≤ 64 KiB, header `Idempotency-Key` | lihat bawah | 201 `{groupId, runs:[Run]}` / 200 (ulang idempoten) | 400 `invalid_request`; 404; 409 `social_reauth_required`, `social_media_unavailable`, `social_idempotency_conflict`; 422 `social_text_invalid`, `social_duration_exceeded`, `social_privacy_unavailable`, `social_schedule_invalid`, `social_time_nonexistent`; 429 `social_cap_scheduled`, `social_cap_hourly`, `social_quota_exhausted`, `social_rate_limited` |
| `GET /api/social/posts` | user | `state?` (csv), `from?`, `to?` (ISO), `jobId?`, `cursor?`, `limit≤100` | `{runs:[Run], counts:{scheduled, published, failed}, nextCursor}` | 400 |
| `GET /api/social/posts/:runId` | user | — | `Run` | 404 |
| `PATCH /api/social/posts/:runId` | user | `{scheduledAt?, scheduleTz?, text?, options?}`; hanya `state='scheduled'` | `Run` | 404, 409 `social_not_cancellable`, 422 `social_schedule_invalid`/`social_time_nonexistent`/`social_text_invalid`, 429 `social_cap_hourly` |
| `POST /api/social/posts/:runId/cancel` | user | — | `Run` | 404, 409 |
| `POST /api/social/posts/:runId/retry` | user, `Idempotency-Key` | `{}`; hanya `failed`/`maybe_sent` | 201 `Run` baru (teks, opsi, media sama; pin baru bila perlu) | 404, 409 |
| `POST /api/social/posts/:runId/mark-published` | user | `{url}`; hanya `maybe_sent` | `Run` (`published`, `posts.origin='publish'`) | 404, 409, 422 `social_url_invalid` |
| `GET /api/jobs/:id/clips/:clipId/posts` | user, `owner:'job'` | — | `{runs:[Run], posts:[{postId, provider, url, postedAt, issueCode:'social_remote_missing'\|'social_processing_rejected'\|null, latest:{views,likes,comments,shares}\|null}]}` | 404 (keluarga `edit`) |
| `GET, PUT /api/settings/social-apps` | admin, PUT re-auth | `{provider, clientId, clientSecret?, appSecret?, enabled, audited}` | `{apps:[{provider, clientId, hasSecret, enabled, audited, redirectUri}]}` | 404 `web` untuk member (02 §7.2 langkah 4), 403 `reauth_required`, 422 |
| `POST /api/social/meta/deauthorize`, `POST /api/social/meta/data-deletion` | publik, `signed_request` | form | 200 / `{url, confirmation_code}` | 400 |
| `GET /api/social/media/:token` | publik, token HMAC | `Range` | 200/206 video (`rangeFileResponse`) | 404 (token salah/kedaluwarsa) |

**Body `POST /api/social/posts`:**

```json
{
  "jobId": "uuid", "clipId": "clip_…",
  "media": {"kind": "export", "renderId": "uuid"},
  "text": {"title": "…", "caption": "…", "hashtags": ["podcast"]},
  "when": {"mode": "now"} ,
  "targets": [
    {"connectionId": "uuid", "options": {"privacy": "private", "madeForKids": false}},
    {"connectionId": "uuid", "options": {"privacy": "SELF_ONLY", "comments": true, "duet": false,
      "stitch": false, "brand": {"own": false, "paid": false}, "consent": true}}
  ]
}
```

- `when` = `{"mode":"now"}` atau `{"mode":"at","at":"2026-10-25T12:00:00Z","tz":"Asia/Jakarta"}`. `at` dibulatkan ke menit; harus ≥ sekarang + 2 menit dan ≤ 90 hari. `now` = `scheduled_at = now`. `tz` (IANA, divalidasi `Intl.supportedValuesOf('timeZone')`) disimpan di `publish_runs.scheduled_tz`; aturan tampil dan DST: 07 §13.4.
- `targets`: 1–3, connection berbeda, semuanya milik pengguna dan `active` (koneksi `reauth_required` → 409 `social_reauth_required`; sudah diputus atau milik orang lain → 404).
- `media` opsional (default §6.7); bila ada, wajib `{"kind":"export","renderId"}`. `text` opsional per field (default `composePostText`); `targets[].text` boleh menimpa per provider.
- Opsi TikTok: `privacy` wajib dan harus ada di `privacy_level_options` terakhir; `consent:true` wajib. Opsi YouTube: `privacy` ∈ `public|unlisted|private`, `madeForKids` wajib boolean.
- Validasi: `provider.validate` untuk setiap target **sebelum** pin dibuat; semua target harus lolos (all-or-nothing). Cap §10.1 dicek dalam tx insert.
- Urutan handler: validasi → cek cap (baca) → pin media (I/O, tanpa tx) → tx: cek cap ulang + insert run + `createPost` belum (posts dibuat saat terbit) → 201. Pin yang dibuat tetapi tx gagal dihapus segera.

**Bentuk `Run`:**

```json
{
  "id": "uuid", "groupId": "uuid", "provider": "youtube",
  "connection": {"id": "uuid", "handle": "@kanal", "status": "active"} ,   // handle dari connection_label; id/status null setelah akun diputus
  "jobId": "uuid", "clipId": "clip_…", "clipTitle": "…",
  "state": "scheduled", "hold": null, "statusCode": "post.scheduled", "detailCode": null,
  "scheduledAt": "…Z", "scheduleTz": "Asia/Jakarta",
  "text": {"title": "…", "caption": "…", "hashtags": []}, "options": {…},
  "progress": {"bytesSent": 0, "bytesTotal": 12345678} ,   // dari checkpoint_json + pin_bytes
  "renderId": "uuid",
  "attempts": 0, "error": null,
  "post": {"id": "uuid", "url": "https://…", "postedAt": "…Z"} ,
  "createdAt": "…Z", "updatedAt": "…Z"
}
```

`error = {code, messageId, params?}` (dari `publish_runs.error_code` + `error_params_json`, §4.2). `statusCode`/`detailCode` dihitung `web/lib/social/view.mjs` menurut tabel §6.1 (`detailCode` ∈ `hold.reauth`, `hold.quota`, `detail.check`, `null`); klien merendernya sebagai `status.<statusCode>` / `status.<detailCode>` (kata dan warna: 05 §5). `upload_box`, token, `error_detail`, dan path pin tidak pernah dikirim.

### 9.2 Analitik

Semua data = milik pengguna sendiri (Q11 default: privat; admin juga hanya melihat miliknya).

| Metode & path | Query | Respons |
|---|---|---|
| `GET /api/analytics/summary` | `range=7d\|30d\|90d` (default 30d), `provider?` | `{range, posts, views, likes, comments, shares, collapsedPosts, updatedAt}` |
| `GET /api/analytics/daily` | `range`, `provider?`, `tz` (IANA, default zona pengguna) | `{days:[{date:'2026-10-24', views}], text:'<ringkasan untuk pembaca layar>'}` |
| `GET /api/analytics/top` | `range`, `provider?`, `sort=views\|likes\|ratio`, `limit≤50` | `{rows:[{postId, provider, url, clipTitle, jobId, clipId, postedAt, views, likes, comments, shares, ratio, n}]}` |
| `GET /api/analytics/feedback` | — | `ProfileStatus` (§13.6) |

Definisi:
- **Posting dalam rentang:** `posts.posted_at ≥ now − range` dan `deleted_at IS NULL`.
- **Nilai per posting:** snapshot terbaru (non-deleted). Snapshot dengan `collapsed_at` terisi tidak menyumbang ke jumlah absolut dan dihitung di `collapsedPosts`.
- **Tayangan per hari:** untuk setiap posting, selisih positif antara snapshot berurutan diberikan ke tanggal lokal (`tz`) dari snapshot yang lebih baru; snapshot pertama diberikan utuh ke tanggal `posted_at`. Selisih negatif (platform mengoreksi) dianggap 0.
- **`ratio`:** `views_h / median akun` pada horizon `POTONGIN_PERF_HORIZON` (dari `metric_horizons.rel_views`), `null` bila belum ada.
- Format angka di UI memakai `useFormatter` (locale aktif, `notation:"compact"`); API tidak memformat.

### 9.3 Performa dan metrik

| Metode & path | Auth | Request | Respons | Error |
|---|---|---|---|---|
| `GET /api/settings/performance` | user | — | `{useInSelection, status: ProfileStatus}` (dari `users.perf_use_in_selection`) | — |
| `PUT /api/settings/performance` | user | `{useInSelection:boolean}` | sama (`UPDATE users SET perf_use_in_selection=?`) | 400 `invalid_request`; 422 `performance_profile_collecting` bila `true` saat state `collecting` |
| `POST /api/posts` | user | `{jobId, clipId, provider, url, postedAt?}` | 201 `{postId}` (origin `manual`) | 404, 409 `performance_post_exists`, 422 `performance_url_invalid` |
| `DELETE /api/posts/:postId` | user | — | 204 (soft delete; hanya origin `csv`/`manual`) | 404, 409 `performance_post_not_deletable` |
| `POST /api/posts/:postId/metrics` | user | `{capturedAt?, views, likes?, comments?, shares?, saves?}` | 201 `{snapshotId}` (source `manual`) | 404, 422 `performance_metric_invalid` |
| `DELETE /api/posts/:postId/metrics/:snapshotId` | user | — | 204 (soft) | 404 |
| `GET /api/performance/template.csv` | user | — | 200 `text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="potongin-metrik.csv"`, isi `resources/performance/template.csv` | 404 (flag mati) |
| `POST /api/performance/import` | user, multipart, file ≤ 2 MiB | `file` | 201 `ImportPreview` | 413 `performance_import_too_large`, 422 `performance_import_invalid` / `performance_import_unknown_columns` |
| `GET /api/performance/import/:importId` | user | `status?`, `cursor?` | `ImportPreview` | 404 |
| `PATCH /api/performance/import/:importId/rows/:rowNo` | user | `{jobId, clipId}` atau `{skip:true}` | baris | 404, 422 |
| `POST /api/performance/import/:importId/commit` | user | — | `{snapshots, postsCreated, skipped}` | 404, 409 `performance_import_state` |
| `DELETE /api/performance/import/:importId` | user | — | 204 (preview dibuang; setelah commit: snapshot impor itu di-soft-delete) | 404 |
| `POST /api/ingest/metrics` (opsional) | Bearer `ptk_` scope `metrics:write`, cookie ditolak | `{items:[{provider, url\|externalId, capturedAt, views, …}]}` ≤ 256 KiB | `{accepted, rejected:[{index, code}]}` | 401, 413, 429 |

`ImportPreview` = `{importId, filename, profile, state:'preview'|'committed'|'discarded', counts:{matched, unmatched, invalid, skipped}, rows:[{rowNo, provider, url, externalId, postedAt, capturedAt, values:{views,likes,comments,shares,saves}, status, problem, match:{postId?, jobId?, clipId?, clipTitle?}|null}], nextCursor, expiresAt}` (baris per halaman ≤ 100; `status` dan `problem` §14.4).

`:rowNo` adalah integer 1–5000; ditambahkan ke `ROUTE_PARAMS` sebagai `rowNo: /^[1-9][0-9]{0,3}$/`. `POST /api/performance/import` dan `/api/ingest/metrics` dikecualikan dari matcher `proxy.js` (unggahan / token mesin) dan memeriksa sesi atau token sendiri, dicatat di `web/tests/proxy-matcher.test.mjs` dan allowlist `route-guard-coverage`.

---

## 10. Kuota, cap, dan refresh metrik

### 10.1 Cap per pengguna (Q7 default, bisa diubah)

Dicek dalam tx insert `POST /api/social/posts` dan `PATCH`:
- **Run aktif** (`scheduled|claimed|uploading|processing`) ≤ 100 per pengguna → selebihnya 429 `social_cap_scheduled`.
- **Per jam jadwal:** run aktif + terbit dengan `scheduled_at` dalam jendela `[t − 30 menit, t + 30 menit)` ≤ 20 → 429 `social_cap_hourly`.
- Nilai disimpan di `instance_settings` (tabel kunci milik 02 §3.3, seed milik 01): `social_cap_active` (int ≥ 0, default `100`), `social_cap_hourly` (int ≥ 0, default `20`), `social_yt_daily_overrides` (objek `{<userId>: n}`, default `{}`). Tidak ada UI khusus di Fase 8; admin mengubahnya lewat `PUT /api/admin/settings` yang sudah ada (02 §8.2: re-auth, validasi tipe `setInstanceSettings`, audit `settings.instance_changed {keys}`). Selama kunci belum ada di DB, `getInstanceSetting` memakai default di atas.

### 10.2 Kuota YouTube (satu buku untuk unggah + metrik)

- Hari kuota = tanggal kalender di `America/Los_Angeles` (DST diikuti lewat `Intl.DateTimeFormat`). Baris `social_quota`: `provider='youtube'`, `window_key='<YYYY-MM-DD>@America/Los_Angeles'`, `bucket='instance'` atau `<userId>`, `purpose='upload'|'metrics'`.
- Anggaran unggah instans = `SOCIAL_YT_DAILY_UNITS − SOCIAL_YT_METRICS_UNITS` (default 9000) → `floor(9000 / 1600) = 5` unggahan/hari **[V]**.
- **Jatah harian per pengguna** (Q7 default): `jatah = max(1, floor(unggahan_instans / pengguna_aktif_youtube))`, `pengguna_aktif_youtube` = jumlah pengguna dengan koneksi YouTube `active`. Admin boleh menimpa per pengguna lewat `instance_settings.social_yt_daily_overrides`.
- Reservasi: worker, sebelum `begin`, dalam tx: `units_reserved += 1600` pada baris instans **dan** baris pengguna, hanya bila `used+reserved+1600 ≤ batas` keduanya. Gagal → defer ke tengah malam Pacific berikutnya (`hold='quota'`). Setelah `begin` sukses → pindahkan reservasi ke `units_used`; gagal sebelum respons → lepas reservasi. 403 `quotaExceeded` dari Google → set `units_used` instans = batas untuk hari itu, defer.
- Create dengan `when.mode='now'` ketika jatah hari ini sudah habis → 429 `social_quota_exhausted` dengan `params.resetAt` (bukan diterima lalu didefer diam-diam). Jadwal di masa depan selalu diterima; defer terjadi di worker.
- Metrik YouTube memakai baris `purpose='metrics'`, batas `SOCIAL_YT_METRICS_UNITS`.

### 10.3 Batas laju TikTok dan Instagram

- **TikTok:** batas posting per kreator per hari **[V]** — `creator_info` dibaca ulang sebelum `begin`; respons `spam_risk_too_many_posts`/`rate_limit_exceeded` **[V]** → defer 60 menit. Metrik: ≤ 1 panggilan `video/query` per koneksi per 10 detik, ≤ 600 per koneksi per hari (nilai kerja; ganti dengan angka SOS-M0).
- **Instagram:** `remainingPosts` dari `content_publishing_limit` dibaca sebelum `begin`; 0 → defer 60 menit. Metrik: ≤ 60 panggilan insights per koneksi per jam (di bawah batas Graph per pengguna **[V]**), baris `social_quota` `provider='instagram'`, `bucket=<connectionId>` (01 §4.3), `window_key='<YYYY-MM-DDTHH>@UTC'`, `purpose='metrics'`. TikTok memakai pola yang sama (`window_key` per hari UTC) untuk batas 600/hari; batas 1/10 dtk ditegakkan di memori worker.
- Header `Retry-After` atau info laju di respons platform selalu didahulukan di atas angka kerja ini.

### 10.4 Due-list refresh metrik (`web/lib/metrics-refresh.mjs`)

Satu due-list untuk semua posting dengan `connection_id` aktif dan `external_id` (origin `publish`, atau CSV/manual yang cocok dengan koneksi aktif berdasarkan `external_id`). Dijalankan loop maintenance `social-worker` setiap 10 menit.

| Umur posting (sejak `posted_at`) | Interval | Alasan |
|---|---|---|
| < 48 jam | 6 jam | menangkap horizon 1d |
| 2–8 hari | 24 jam | horizon 7d (+1 hari toleransi) |
| 8–35 hari | 72 jam | horizon 30d; juga menjaga data YouTube ter-refresh < 30 hari |
| 35–90 hari | 7 hari | tren panjang |
| > 90 hari | berhenti (`stopped=1`) | §10.5 berlaku |

Algoritma per tick:
1. Ambil `metric_refresh` dengan `stopped=0 AND next_due_at ≤ now`, kelompokkan per `(connection_id)`, urutkan per kelompok: tier termuda dulu, lalu `next_due_at` tertua.
2. Untuk setiap koneksi, pecah per `statsBatch`; sebelum setiap panggilan reservasi biaya `statsCost` di `social_quota` (YouTube: baris metrics hari Pacific) atau cek batas laju §10.3. Tidak ada anggaran → sisa kelompok ditunda ke tick berikut (tidak dihitung gagal).
3. Panggil `readPostStats` (tanpa tx). Untuk setiap id yang kembali: tx insert `metric_snapshots(source='api')`, `last_ok_at=now`, `failures=0`, `next_due_at` per tabel. Id yang tidak kembali (dihapus di platform): `failures+1`; `failures ≥ 3` → `stopped=1` dan `posts.error_code='social_remote_missing'` (§4.2).
4. Error reauth → hentikan koneksi ini sampai aktif lagi; 5xx → coba lagi tick berikut.
5. Setelah insert, tandai `metric_horizons` posting itu kotor (hapus barisnya); horizon dihitung ulang lazily (§10.6).

Perkiraan biaya YouTube: 1 unit per ≤ 50 posting per panggilan. Dengan 1000 posting aktif semuanya jatuh tempo bersamaan = 20 unit; anggaran 1000 unit/hari tidak akan mengikat di skala Potongin. Batas itu tetap ada supaya kesalahan loop tidak bisa menghabiskan kuota unggah.

### 10.5 Retensi data platform

- **YouTube (kebijakan API Services, [V]):** nilai mentah yang tidak di-refresh > 30 hari harus di-refresh atau dihapus. Maintenance harian: untuk setiap `metric_snapshots` `source='api'` dari posting YouTube dengan `metric_refresh.last_ok_at < now − 30 hari` dan `collapsed_at IS NULL` → `UPDATE SET aggregate_json = json_object('relViews', views / median_akun), views=NULL, likes=NULL, comments=NULL, shares=NULL, saves=NULL, collapsed_at=:now` (diizinkan trigger `metric_snapshots_collapse_only`, 01 §4.7; `median_akun = 0` atau tidak ada → `{"relViews":null}`). `median_akun` dihitung dari horizon `POTONGIN_PERF_HORIZON` posting akun yang sama sebelum penciutan. Pembolehan agregat turunan ini diverifikasi di SOS-M0; kalau tidak diizinkan, langkahnya menjadi hard delete dan profil hanya memakai `metric_horizons.rel_views` yang dihitung sebelum hapus (disimpan di `metric_horizons`, yang juga dihapus setelah 30 hari bila kebijakan menuntut).
- **TikTok/Instagram:** tidak ada aturan 30 hari yang diketahui **[V]**; purge saat putus akun dan callback Meta tetap berlaku.
- **CSV, manual, agen:** tidak pernah dihapus otomatis.
- Semua aturan ini ditambahkan ke `docs/operations/STORAGE_RETENTION.md` bagian "Metadata kontrol, cache dan data platform" (paket Q6).

### 10.6 Horizon (`metric_horizons`)

Untuk posting `p` dan horizon `h ∈ {1d, 7d, 30d}` (`T = posted_at + h`):
1. Ambil snapshot non-deleted `p` urut `captured_at`.
2. **exact:** ada snapshot di `[T, T + 0,25·h]` → pakai yang paling dekat ke `T`.
3. **interpolated:** ada snapshot `a < T` dan `b > T` dengan `b − a ≤ h` → interpolasi linear `views`.
4. Selain itu **missing** (`views=NULL`). Snapshot ciut hanya menyumbang `aggregate_json.relViews`-nya (horizon itu mendapat `views=NULL`, `rel_views` dari snapshot ciut terdekat dengan aturan exact/interpolated yang sama).
5. `rel_views = views / median(views pada horizon yang sama, posting koneksi yang sama dengan quality≠missing, ≥ 5 posting)`; kurang dari 5 → `NULL`. Untuk CSV/manual tanpa koneksi, "akun" = `(owner_id, provider)`.
6. Dihitung ulang saat dibaca bila tidak ada barisnya (cache), dan seluruhnya bisa dibangun ulang (`performance-store.mjs rebuildHorizons(ownerId)`).

---

## 11. Syarat publik: HTTPS, redirect, halaman hukum, checklist G0

### 11.1 Redirect URI dan URL publik

Diturunkan dari `POTONGIN_PUBLIC_URL` dan ditampilkan admin di kartu "Aplikasi sosial" (untuk disalin ke konsol platform):

| Kegunaan | URL |
|---|---|
| Callback YouTube | `<PUBLIC>/api/social/callback/youtube` |
| Callback TikTok | `<PUBLIC>/api/social/callback/tiktok` |
| Callback Instagram | `<PUBLIC>/api/social/callback/instagram` |
| Meta deauthorize | `<PUBLIC>/api/social/meta/deauthorize` |
| Meta data deletion | `<PUBLIC>/api/social/meta/data-deletion` |
| Kebijakan privasi | `<PUBLIC>/privasi` |
| Ketentuan layanan | `<PUBLIC>/ketentuan` |
| Beranda | `<PUBLIC>/` |
| Media publik (fallback IG) | `<PUBLIC>/api/social/media/<token>` |

Redirect URI dikirim persis sama di `authorizeUrl` dan `exchangeCode` (tanpa query tambahan). Host di `POTONGIN_PUBLIC_URL` harus sama dengan host tempat cookie sesi berlaku, kalau tidak callback kehilangan sesi → `social_state_invalid`.

### 11.2 Perubahan `web/proxy.js`

- Exact-path publik (pola sama dengan `/` dan `isLandingMediaPath`): `/privasi`, `/ketentuan`, `/hapus-data/<code>` (regex `^/hapus-data/[A-Za-z0-9_-]{22}$`).
- Dikecualikan dari `matcher` (route memeriksa sendiri): `api/social/meta/deauthorize`, `api/social/meta/data-deletion`, `api/social/media/[^/]+`, `api/performance/import`, `api/ingest/metrics`. Setiap pengecualian diberi komentar alasan di `proxy.js` dan baris di `proxy-matcher.test.mjs`.
- `/api/social/callback/*` **tidak** dikecualikan.

### 11.3 URL media publik (fallback Instagram saja)

- Token = `base64url(runId ‖ expMs ‖ HMAC-SHA256(key, runId‖expMs))`, `key` = HKDF dari `POTONGIN_SETTINGS_SECRET` purpose `social-media-url`. Berlaku 1 jam, dibuat worker saat `begin` fallback.
- Route menerima hanya bila run `state='uploading'`, `provider='instagram'`, pin masih ada. Menyajikan pin lewat `rangeFileResponse` (Range, `Content-Type: video/mp4`, `Cache-Control: private, no-store`). Setiap akses dicatat (tanpa token) dan dibatasi 20 permintaan per token.

### 11.4 Reverse proxy (`deploy/VM_NGINX_CLOUDFLARE.md`, SOS-M6)

- HTTPS wajib dengan HSTS; redirect `http→https` di edge.
- `/api/social/callback/*`, `/api/social/meta/*`: tanpa cache, tanpa challenge bot Cloudflare (Meta memanggil server-ke-server).
- `/api/social/media/*`: pengecualian WAF/bot fight mode, tanpa cache, `proxy_buffering off`, `proxy_read_timeout 600s`, Range diteruskan.
- `/api/performance/import`: `client_max_body_size 3m`.
- `/privasi`, `/ketentuan`, `/hapus-data/*` bisa diakses tanpa login dari luar.
- Unggahan ke platform keluar dari `social-worker` (egress), jadi tidak ada batas body masuk tambahan.

### 11.5 Halaman `/privasi` dan `/ketentuan`

Server component statis, dua locale (`legal` namespace), tanpa sidebar. Isi minimum (penulis teks = pemilik, Q7; draf disiapkan implementer): data apa yang disimpan (token tersegel, metrik, teks posting), untuk apa, berapa lama (§6.7, §10.5), cara memutus akun dan meminta hapus data, kontak email (dipilih pemilik; repo publik). Tautan Google: kebijakan privasi Google dan YouTube Terms of Service wajib dirujuk **[V]**.

### 11.6 Checklist G0 / SOS-M0 (kerja pemilik, mulai sekarang)

**Umum**
- [ ] Domain publik HTTPS untuk `POTONGIN_PUBLIC_URL` dipastikan dan dicatat (tidak di repo publik).
- [ ] Email kontak publik dipilih.
- [ ] Draf `/privasi` dan `/ketentuan` disetujui.

**Google / YouTube**
- [ ] Proyek Google Cloud + YouTube Data API v3 aktif.
- [ ] OAuth consent screen: nama app, logo, domain terotorisasi, beranda, privasi, ketentuan; status *Testing* dengan test user.
- [ ] Redirect URI §11.1 terdaftar.
- [ ] Ajukan verifikasi OAuth untuk scope sensitif `youtube.upload`, `youtube.readonly` **[V]** (butuh video demo).
- [ ] Ajukan audit YouTube API Services (mencabut paksaan privat + menaikkan kuota bila perlu) **[V]**.

**TikTok**
- [ ] App di TikTok for Developers, produk Login Kit + Content Posting API (Direct Post).
- [ ] Redirect URI, privasi, ketentuan terdaftar; scope `user.info.basic`, `video.publish`, `video.list`.
- [ ] Mode sandbox / tester untuk pengujian.
- [ ] Ajukan audit Direct Post (butuh demo yang memperlihatkan syarat UX §5.3) **[V]**.
- [ ] Verifikasi domain **tidak** diperlukan (`FILE_UPLOAD`).

**Meta / Instagram**
- [ ] App Meta tipe Business + produk Instagram API with Instagram Login.
- [ ] Redirect URI, deauthorize, data deletion, privasi terdaftar.
- [ ] Akun Instagram profesional untuk tester.
- [ ] App Review untuk `instagram_business_content_publish`, `instagram_business_manage_insights` + Business Verification **[V]**.
- [ ] SOS-M0 mengonfirmasi resumable upload tersedia untuk Reels; kalau tidak, pengecualian WAF §11.4 untuk URL media publik wajib dipasang sebelum Instagram diaktifkan.

**Selesai bila:** SOSMED.md berisi setiap angka **[V]** dengan tautan + tanggal akses, status ketiga app (testing/diajukan/disetujui), dan keputusan resumable Instagram.

---

## 12. Rilis, deploy, rollback

### 12.1 Masalah yang diselesaikan R0/R1

`rollback()` di `deploy/production.sh` (baris 144–155 hari ini) menjalankan image lama dengan `compose.yaml` hasil checkout baru dan `--remove-orphans`, lalu hanya menunggu `wait_http_health` dan `wait_primary_health`. Kalau service `social-worker` ditambahkan ke compose bersamaan dengan skripnya, rollback akan menyalakan `social-worker` dari image yang tidak punya `scripts/social-worker.mjs` → crash loop.

### 12.2 Dua rilis

Isi rilis milik dokumen ini; perubahan `deploy/production.sh`, `Dockerfile` (label), dan kasus `tests/test_deploy_guard.py` milik 08 §9.4, §9.6, §8.6 dan tidak didefinisikan ulang di sini.

| Rilis | Isi | Deploy & rollback |
|---|---|---|
| **R0** (Fase 6, PR pertama SOS-M1 Release A) | Image berisi `web/scripts/social-worker.mjs`, `check-social-worker-health.mjs`, `web/lib/social/{store,errors,redact,http,scheduler,apps}.mjs`, migrasi `0003-social-base.sql` (01 §4.3). `compose.yaml` **tidak** berubah. | 08 §9.4 baris R0 (label image `potongin.social-worker`, `wait_social_health` no-op tanpa service) |
| **R1** (PR kedua, setelah R0 berjalan di produksi ≥ 1 deploy) | `compose.yaml` menambah service `social-worker` persis §6.8 butir 6 (mount subpath, env allowlist §3, healthcheck §6.8 butir 4). | 08 §9.4 baris R1: `wait_social_health`, `verify_runtime_identity` 4 container (08 §9.6), rollback ke image tanpa label → `--scale social-worker=0` |

### 12.3 Rollout dan drill

1. R0 → R1 (Fase 6) dengan `POTONGIN_SOCIAL=off`: worker healthy, restart 0, heartbeat ada.
2. Fase 8 deploy dengan `off`, lalu `.env` → `admin`, `docker compose up -d` (tanpa rebuild). Satu posting privat per platform + satu terjadwal oleh pemilik.
3. Setelah audit platform yang relevan lolos dan pemilik setuju → `on`. Platform yang belum lolos tetap privat/`SELF_ONLY` (flag `audited` per app).
4. **Drill `POTONGIN_SOCIAL=off`** (otomatis di CI + sekali di produksi): route 404 identik, nav dan tombol Terbitkan hilang, worker hanya heartbeat, run `scheduled` tidak diklaim dan tetap di DB, nyalakan lagi → run berjalan, tidak ada run yang terlewat diam-diam (run lewat jadwal > 24 jam tetap diproses; UI menampilkan jam terbit aktual).
5. **Drill `POTONGIN_PERFORMANCE=off`:** route 404, `run-job.mjs` tidak menulis profil, output engine byte-identik dengan tanpa profil.

### 12.4 Gerbang fake origin

`SOCIAL_FAKE_ORIGIN` dipakai oleh `web/tests/support/fake-social-platform.mjs` dan `web/e2e/social-publish.spec.mjs`. `web/lib/social/http.mjs` menolaknya (startup gagal, kode `social_fake_origin_forbidden`) bila salah satu benar: `NODE_ENV=production`; host `POTONGIN_PUBLIC_URL` bukan `localhost`/`127.0.0.1`; origin fake bukan loopback. Dijaga `web/tests/social-fake-origin-gate.test.mjs` (tiga lapis: env, URL publik, alamat origin).

### 12.5 Matriks rollback

| Lapisan | Mekanisme | Catatan |
|---|---|---|
| Fitur sosmed | `POTONGIN_SOCIAL=off` + `up -d` | Data tetap; token tetap tersegel |
| Image < Fase 8, ≥ R1 | Image lama tidak punya route sosmed; worker lama hanya heartbeat | Tabel `posts`/`publish_runs` diabaikan |
| Image < R0 dengan compose R1 | `--scale social-worker=0` (08 §9.4) | Run `scheduled` tetap di DB, diproses lagi setelah maju |
| Skema | Migrasi `0003`, `0005`, `0006`, `0007` aditif (lint 01 §3.2) | Kode lama cek `schema_version >=` minimum |
| Secret diganti | Koneksi → `reauth_required` | Run ditahan `hold='reauth'` |
| Performa | Toggle per pengguna, `POTONGIN_PERFORMANCE=off` | Tanpa profil = byte-identik |

---

## 13. Profil performa dan injeksi ke Selection V3

### 13.1 `resources/performance/rules.v1.json` (dibekukan di FB-M0)

```json
{
  "rulesId": "rules.v1",
  "dimensions": ["archetype", "durationBucket", "hookForm"],
  "archetype": ["curiosity_gap","controversial_claim","confession","insider_secret","story_twist",
                "number_proof","conflict","humor","relatable_pain","emotional","practical_tip","other"],
  "durationBuckets": [[0,20,"0-20"],[20,30,"20-30"],[30,45,"30-45"],[45,60,"45-60"],[60,null,"60+"]],
  "hookForm": {
    "order": ["none","question","number","quote","statement"],
    "quoteOpeners": ["\"", "“", "'", "‘", "«"]
  },
  "minPosts": 20, "minGroup": 5, "minAccountPosts": 5, "shrinkK": 5,
  "liftFull": 0.25, "capPerDimension": 0.2, "capTotal": 0.4,
  "windowDays": 180, "staleDays": 14, "editFarOverlap": 0.8
}
```

- Daftar `archetype` sama persis dengan `ARCHETYPES` di `src/ai_clipper/selection_types.py`; tes paritas gagal bila salah satu berubah.
- `durationBucket`: durasi = `sourceEnd − sourceStart` dalam detik (tanpa cold open), interval `[lo, hi)`.
- `hookForm` (urutan menentukan): teks hook di-trim; kosong → `none`; mengandung `?` → `question`; mengandung digit `\p{Nd}` → `number`; diawali salah satu `quoteOpeners` → `quote`; selain itu `statement`.
- `capPerDimension` dan `capTotal` dalam satuan nilai ranking 0–10 milik Selection V3 (skala yang sama dengan `TREND_BOOST / RANK_SCALE_POINTS` = 0,3).

### 13.2 Kunci seleksi (`selection_keys_json`)

- **JS** `web/lib/performance-keys.mjs` → `selectionKeysFor(clip, rules)` membaca field klip yang sudah disajikan `web/lib/jobs.mjs` (`archetype`, `sourceStart`, `sourceEnd`, `hookText` dari engine, bukan teks yang diedit pengguna).
- **Python** `src/ai_clipper/performance_profile.py` → `selection_keys_json(archetype, start, end, hook_text, rules)` dipanggil dari `selection_v3.py` per kandidat (`proposal.archetype`, span, `proposal.hook_text`).
- Tes paritas `web/tests/performance-keys-parity.test.mjs` + `tests/test_performance_profile.py` memakai tabel kasus bersama `tests/fixtures/performance/keys.json` **(baru)**.
- **Drift hook:** teks hook proposal bisa berbeda dari `hookText` final bila packaging tren membangun ulang klip. Tes round-trip pada episode gold menghitung kasus `hookForm(proposal) ≠ hookForm(final)`; batas ≤ 2% (gagal → pindah ke pembacaan dari artefak seleksi, diputuskan di FB-M2). Bila profil aktif dan drift terjadi pada klip terpilih, engine menambah warning `perf_key_drift:<n>`.
- `createPost` menyimpan `selection_keys_json` = `selectionKeysFor(...)`; **`NULL`** bila: klip turunan (`clip_kind='derived'`, `excluded_reason='derived'`), `edit_class='far'` (`excluded_reason='edited_far'`), atau pengguna mengeluarkannya (`manual_exclude`). Klip turunan dikenali dari entri `listJobClips(job)` dengan `entry.derived !== null` (06 §11.6), **bukan** dari bentuk `clipId` (id turunan berpola sama dengan id pipeline).

### 13.3 `posted_features_json`, `packaging`, `edit_class`

- `packaging` = `snapshotClipPackaging(job, clip, source)` (ekspor baru di `web/lib/jobs.mjs`): `{title, hookText, description, hashtags, archetype, sourceStart, sourceEnd, layout?}` saat terbit.
- `posted_features_json` = `{durationMs, layout (dari layout_summary render bila ada), hookOverlay, captionStyle, completedBy, sizes}` — hanya untuk Analitik, tidak pernah masuk profil.
- `edit_class` dihitung saat terbit oleh op Python baru `edit_distance` di `src/ai_clipper/edit_v2/api.py` (dispatch seperti op `clips`, lewat `web/lib/python-cli.mjs`; hanya dipanggil `app`, owner-agnostik):
  - `completed_by='seed'` pada ekspor, atau dokumen render = seed (`content_equals_seed` di `src/ai_clipper/edit_v2/doc.py`) → `none`;
  - selain itu: `overlap = durasi irisan rentang sumber yang dipertahankan dokumen ∩ rentang seed / durasi seed` (dari `pieces` timemap dokumen), `hookChanged = normalisasi(hook dokumen) ≠ normalisasi(hook seed)` (casefold, spasi dirapikan);
  - `overlap < 0,8` **atau** `hookChanged` → `far`; selain itu `light`;
  - op gagal / timeout 10 dtk → `unknown` (tidak dikeluarkan, tetapi dihitung dan dilaporkan di retro).
- Origin `csv`/`manual`: `edit_class='unknown'`.

### 13.4 Perhitungan profil (`web/lib/performance-profile.mjs`)

Input: posting pengguna dengan `deleted_at IS NULL`, `selection_keys_json NOT NULL`, `excluded_reason IS NULL`, `posted_at ≥ now − windowDays`, `metric_horizons(h=POTONGIN_PERF_HORIZON).rel_views NOT NULL`.

1. `E` = posting yang lolos. `|E| < max(minPosts, POTONGIN_PERF_MIN_POSTS)` → status `collecting`, tidak ada profil.
2. Per posting: `l = ln(max(rel_views, 0.01))`.
3. Per dimensi `d`, per nilai `v` dengan `n_v ≥ minGroup`: `μ = Σl / (n_v + shrinkK)` (shrinkage ke 0 = "seperti biasa"); `lift = e^μ − 1`; `boost = round2(capPerDimension × clamp(lift / liftFull, 0, 1))`. Hanya positif; nilai dengan boost 0 tidak ditulis.
4. Profil dianggap **stale** bila snapshot terbaru semua posting `E` > `staleDays` hari → status `stale`, profil tetap dipakai bila toggle aktif (dorongan kecil dan dibatasi), UI menampilkan "Data lama".
5. Untuk tampilan: `ratio_v = e^{mean(l)}` tanpa shrinkage, dengan `n`.

Snapshot yang dikirim ke engine (`<job>/analysis/performance-profile.json`) ditulis `preparePerformanceProfile(job)` di **`web/scripts/primary-worker.mjs`** setelah `claimNextJob` dan sebelum spawn `run-job.mjs` (pola `ownerPolicy`, 02 §9.2: `run-job.mjs` tidak membuka DB). Syarat: `POTONGIN_PERFORMANCE=on` **dan** `users.perf_use_in_selection=1` milik `effectiveOwnerId(job)` **dan** status `ready|stale`. Bila syarat tidak terpenuhi, file lama dihapus (tidak ada profil basi dari klaim sebelumnya). `run-job.mjs` hanya memeriksa keberadaan file itu.

```json
{
  "version": "performance-profile-v1",
  "rulesId": "rules.v1",
  "horizon": "7d",
  "posts": 34,
  "boosts": {
    "archetype": {"humor": 0.2, "practical_tip": 0.08},
    "durationBucket": {"20-30": 0.12},
    "hookForm": {"question": 0.05}
  }
}
```

Tidak ada id pengguna, id posting, URL, atau angka mentah di file ini. `run-job.mjs` menambah argumen `--performance-profile <path absolut>` (pola sama dengan `--trend-context`; isi tidak pernah masuk argv). Profil tidak ada → argumen tidak ditambahkan sama sekali.

### 13.5 Injeksi di `selection_v3.py` (FB-M3)

Perubahan minimal, mengikuti mekanisme `_boosted` yang sudah ada untuk Konteks Tren:

1. `select_clips_v3(..., performance: PerformanceProfile | None = None)`; `cli.py` membaca `--performance-profile` lewat `performance_profile.load_profile(path)` (validasi ketat: kunci persis, `rulesId` cocok dengan file rules yang terpasang, setiap nilai `0 ≤ x ≤ capPerDimension`, jumlah per kandidat tidak dihitung di sini). File tidak valid → profil diabaikan + warning `performance_profile_invalid`; job tetap jalan.
2. `_Candidate` mendapat field `perf: float = 0.0` = `min(capTotal, Σ_d boosts[d][key_d])`, diisi di `build(...)` hanya bila `performance` tidak `None`.
3. `_boosted(candidates, value: Callable[[_Candidate], float] = _trend_boost)` dengan `_trend_boost = lambda c: c.boost`. **Ketiga** pemakaian `.boost` di badan fungsi (`selection_v3.py:590–627`) diganti `value(…)`: pemeriksaan awal `if not any(value(item) …)`, `boosted = item.rank_value + value(item)`, dan `above.rank_value + value(above)`. Aturan "tidak melewati kandidat yang `rank_value`-nya lebih tinggi dari milik sendiri" (`above.rank_value < item.rank_value - _TOLERANCE → break`) tidak berubah, sehingga ekor LLM yang belum di-rerank tetap tidak pernah dilewati. Default = perilaku sekarang (tren saja).
4. `_order_boost = lambda c: c.boost + c.perf` (**`order_boost`**). `_ordered(candidates, focused, value=_trend_boost)` meneruskan `value` ke **kedua** pemanggilan `_boosted` di dalamnya (cabang tanpa fokus, baris 635, dan per `(source, part)`, baris 642). Pemanggil di `select_clips_v3` (baris 1380 dan 1398) memberikan `value=_order_boost` bila `performance` tidak `None`.
5. `_focus_floors(...)` **tetap** memanggil `_boosted` dengan dorongan tren saja, sehingga floor fokus identik dengan tanpa profil.
6. `score`, kelima sub-skor, `reasons`, packaging, dan prompt LLM **tidak berubah**. Kandidat yang naik karena `perf` (indeksnya di `_ordered(…, value=_order_boost)` lebih kecil dari di `_ordered(…, value=_trend_boost)`, dihitung sekali per job) **dan** terpilih mendapat kode alasan `perf_order` di `reason_codes` (i18n M5) dan manifest mendapat blok opsional `performance: {rulesId, horizon, posts, moved:[rank,...]}` — blok ini hanya ditulis bila profil diberikan.
7. Karena dorongan hanya memindahkan kandidat melewati tetangga yang nilainya ada di `[own, own + boost)`, dorongan `perf` maksimum 0,4 (ditambah tren 0,3 yang sudah ada, total ≤ 0,7) pada skala 0–10 hanya mengubah urutan near-tie di dalam satu sumber/part (tie-breaker terbatas); `_rank`, dedupe, dan slot tidak berubah.
8. `SelectorContext` di `src/ai_clipper/benchmark.py` mendapat field `performance: PerformanceProfile | None = None` (default `None` → perilaku benchmark identik).

UI: chip "Didahulukan data performa" di penampil klip untuk klip dengan `perf_order` (`web/lib/clip-entry-view.mjs`), tanpa angka.

### 13.6 `ProfileStatus` dan pengaturan

```json
{
  "state": "off" | "collecting" | "ready" | "stale",
  "useInSelection": false,
  "posts": 12, "needed": 20, "horizon": "7d",
  "excluded": {"editedFar": 3, "derived": 0, "noMetrics": 5},
  "top": [{"dimension": "archetype", "key": "humor", "ratio": 1.4, "n": 7}],
  "updatedAt": "…Z"
}
```

`off` = `POTONGIN_PERFORMANCE=off` (route sendiri 404, tetapi `/api/analytics/feedback` menjawab `off` agar Analitik tetap tampil). `useInSelection` dibaca dari `users.perf_use_in_selection` (01 §4.7). Toggle (label UI "Pakai di pemilihan klip", kunci `analytics.useInSelection`, 05 §6.7) default mati dan **disabled** bila state `collecting` (server menolak dengan `performance_profile_collecting`). Tampilan baris "Umpan balik": 05 §6.7. Pemilik baru menyalakan toggle miliknya setelah membaca laporan retro FB-M6.

---

## 14. Impor CSV, catat manual, agen

### 14.1 Format

- UTF-8 (BOM diterima), ≤ 2 MiB, ≤ 5000 baris data, delimiter `,` atau `;` (dideteksi dari baris header), quoting RFC 4180.
- **Template Potongin** (`resources/performance/template.csv`, diunduh dari dialog impor lewat `GET /api/performance/template.csv`, §9.3): `platform,url,external_id,posted_at,captured_at,views,likes,comments,shares,saves`. `platform` ∈ `youtube|tiktok|instagram`; `posted_at`/`captured_at` ISO 8601 atau `YYYY-MM-DD` (dianggap 00:00 zona pengguna); `captured_at` kosong = waktu impor.
- **Profil ekspor platform** di `resources/performance/csv-profiles.v1.json`: `{id, detect:[header wajib], columns:{views:[alias...], ...}, dateFormat}` untuk YouTube Studio, TikTok Studio, Instagram. Header alias **baru bisa diisi setelah pemilik memberi contoh ekspor** (Q11); sampai itu hanya template Potongin yang didukung, dan file lain → 422 `performance_import_unknown_columns` dengan `params.columns`.
- Angka: integer ≥ 0; pemisah ribuan `.`/`,`/spasi dibuang hanya bila hasilnya tidak ambigu (pola `^\d{1,3}([.,\s]\d{3})+$`); desimal/singkatan ("1,2 rb", "1.2K") ditolak per baris (`performance_metric_invalid`).

### 14.2 Alur

1. `POST /api/performance/import` → parse → `metric_imports(state='preview')` + `metric_import_rows`.
2. Pencocokan per baris (urutan): `posts` milik pengguna dengan `(provider, external_id)` sama → `matched`; URL dinormalisasi (`web/lib/social/view.mjs normalizePostUrl`: hapus query/fragment, `youtu.be/<id>` dan `/shorts/<id>` → id video, TikTok `/video/<id>`, Instagram `/reel/<shortcode>`) sama dengan `posts.url`/external id → `matched`; selain itu `unmatched`.
3. Layar "Cocokkan": baris `unmatched` dipasangkan ke klip (`PATCH …/rows/:rowNo {jobId, clipId}`, klip harus milik pengguna) atau dilewati.
4. `commit`: dalam satu tx — baris `matched` ke posting yang ada → `metric_snapshots(source='csv')`; baris yang dipasangkan manual → `createPost(origin='csv')` lalu snapshot; `unmatched` tersisa → `skipped`. Duplikat (`post_id`, `captured_at`, nilai sama) dilewati.
5. Preview yang tidak di-commit dibuang setelah 7 hari (maintenance).

### 14.3 Catat manual dan agen

- "Catat angka" di penampil klip: `POST /api/posts` (bila belum ada posting untuk URL itu) lalu `POST /api/posts/:postId/metrics`.
- Agen (opsional): token `ptk_` scope `metrics:write` milik pengguna (tabel `api_tokens`, scope per peran 02 §9.4; untuk image lama juga ditambahkan ke `INGEST_SCOPES` `web/lib/ingest-tokens.mjs`). Snapshot ditulis atas nama pemilik token. Hanya mencocokkan ke posting yang sudah ada (tidak membuat posting baru); `source='agent'`.

### 14.4 Kode masalah baris

`performance_row_platform`, `performance_row_url`, `performance_row_date`, `performance_metric_invalid`, `performance_row_duplicate`, `performance_row_unmatched`, `performance_row_foreign` (URL milik posting pengguna lain → diperlakukan `unmatched`, tanpa membocorkan).

---

## 15. Gerbang

### 15.1 Sosmed (Fase 8, selesai bila)

- Crash matrix (§16.2) per provider × checkpoint: setiap kasus berakhir dengan tepat satu posting remote di fake platform, atau `maybe_sent` yang memang diharapkan tabel.
- `deferred` tidak menambah `attempts` (tes jam manual melintasi reset Pacific, termasuk minggu pergantian DST).
- Ekspor `queued`/`failed`/`cancelled` tidak pernah dipin; tes `final-files` yang ada tidak diubah dan tetap hijau setelah `rangeFileResponse` dipecah.
- `social-publish.spec.mjs` lolos di locale `id` dan `en`.
- Jadwal dibuat di `en` zona X, tampil benar di `id` zona Y.
- Produksi mode `admin`: satu posting privat per platform + satu terjadwal sukses.
- Drill `POTONGIN_SOCIAL=off` (§12.3) lulus.
- `ownership-matrix` mencakup semua route §9 × metode × peran; token/sesi unggah tidak muncul di log, respons, `/proc/<pid>/cmdline`.

### 15.2 Performa (Fase 9, selesai bila)

Dijalankan `scripts/eval/performance_gate.py` **(baru, di-commit)** di GitHub Actions (`editor-gates.yml -f suite=command`), bukan di PC pemilik.
- **Gate 1 (identitas):** tanpa profil, 7 episode heuristik + 5 replay cache byte-identik (artefak seleksi, manifest, semua sha256 request LLM) terhadap `main` setelah Fase 7.
- **Gate 2 (profil tak cocok):** profil yang semua kuncinya tidak muncul di kandidat → klip terpilih, urutan, skor, dan semua sha256 request identik; satu-satunya beda yang diizinkan adalah blok manifest `performance` dengan `moved:[]` (dibandingkan setelah blok itu dibuang, dan diuji bahwa hanya blok itu yang beda).
- **Gate 3 (tidak merusak):** dengan profil sintetis "favour archetype X" per arketipe: Hits@5 dan Hits@10 turun paling banyak 1 per episode, Trap@10 tidak naik, floor fokus identik (`_focus_floors` sama persis), ukuran efek dilaporkan: target ≥ 20% episode berubah ≥ 1 pick; kalau tidak tercapai, dicatat "tidak ada efek" (diterima, Q11).
- Paritas kunci Python/JS lolos; drift hook ≤ 2%.
- Nilai mentah YouTube > 30 hari tanpa refresh diciutkan (tes jam manual).
- Laporan retro FB-M6 (leave-future-out, bootstrap CI 95%) dibaca pemilik sebelum toggle miliknya dinyalakan.
- Episode held-out hanya dijalankan sekali, di akhir FB-M3.

### 15.3 Gate yang berlaku seterusnya

Setiap perubahan seleksi sesudah Fase 9 menjalankan ulang Gate 1–3. Gold `SELECTION_BENCHMARK` tidak boleh berubah tanpa profil.

### 15.4 Re-gate

Mengubah `POTONGIN_PERF_MIN_POSTS`, `POTONGIN_PERF_HORIZON`, atau isi `rules.v1.json` (→ `rules.v2.json`, file baru) wajib menjalankan Gate 3 dan mencatat hasilnya di `docs/operations/PERFORMA.md`.

---

## 16. Tes

### 16.1 Unit (Node `node --test`, semua **baru** kecuali disebut)

| File | Menguji |
|---|---|
| `web/tests/social-store.test.mjs` | transisi §6.1 (tabel lengkap legal/ilegal), klaim, fence, perpanjangan lease, 1 run per koneksi |
| `web/tests/social-scheduler.test.mjs` | backoff, defer tanpa `attempts`, `hold`, batas 7 hari, SIGTERM melepas lease, jam manual |
| `web/tests/social-tokens.test.mjs` | refresh dua fase, race (dua proses), `invalid_grant` → reauth, CAS `token_generation` |
| `web/tests/social-oauth.test.mjs` | state sekali pakai, kedaluwarsa, beda sesi, beda pengguna, scope kurang, batas pending |
| `web/tests/social-provider-contract.test.mjs` | setiap provider memenuhi §5.1; tabel pemetaan error |
| `web/tests/social-youtube.test.mjs`, `social-tiktok.test.mjs`, `social-instagram.test.mjs` | langkah, chunking, reconcile, URL, stats terhadap fake platform |
| `web/tests/social-media.test.mjs` | pin hanya ekspor `completed`, `EXDEV`, symlink ditolak, sweep menolak path di bawah `JOBS_ROOT` |
| `web/tests/social-quota.test.mjs` | hari Pacific + DST, jatah per pengguna, reservasi/lepas, `quotaExceeded` |
| `web/tests/social-caps.test.mjs` | 100 aktif, 20 per jam, idempotensi key |
| `web/tests/social-post-text.test.mjs` | batas karakter, grapheme, hashtag |
| `web/tests/social-redact.test.mjs` | pola token tidak lolos ke log/error |
| `web/tests/social-meta-callbacks.test.mjs` | `signed_request` valid/invalid/kedaluwarsa |
| `web/tests/social-fake-origin-gate.test.mjs` | §12.4 |
| `web/tests/social-routes.test.mjs` | setiap route §9.1: body, status, kode error, flag `off`/`admin` |
| `web/tests/post-registry.test.mjs` | `createPost`, `selection_keys_json` NULL untuk turunan/far, unik external id |
| `web/tests/list-job-clips-parity.test.mjs` | `listJobClips` (JS) = `_clips` (Python, subproses) pada fixture manifest |
| `web/tests/metrics-refresh.test.mjs` | tier, batching, anggaran, id hilang 3× → stop |
| `web/tests/metric-horizons.test.mjs` | exact/interpolated/missing, median akun, rebuild |
| `web/tests/performance-profile.test.mjs` | rumus §13.4 dengan angka tangan, cap, `collecting`/`stale` |
| `web/tests/performance-keys-parity.test.mjs` | tabel `keys.json` |
| `web/tests/metrics-csv.test.mjs` | delimiter, BOM, angka, tanggal, duplikat, batas ukuran |
| `web/tests/analytics-view.test.mjs` | ringkasan, harian (delta, tz), top |
| `web/tests/performance-routes.test.mjs` | route §9.2–9.3, flag off |
| `web/tests/social-job-delete.test.mjs` | `DELETE` job membatalkan run `scheduled`, menandai run berjalan; tidak ada pemanggil `requestJobDeletion` lain yang melewatkan `cancelRunsForJob` |
| `web/tests/social-mp4-duration.test.mjs` | `mvhd` v0/v1, file rusak/terpotong ditolak, batas baca |
| `web/tests/social-disconnect.test.mjs` | putus akun §7.4: baris koneksi dihapus, `connection_id` run/posting jadi `NULL` dan `connection_label` tetap, run `scheduled` batal, snapshot `api` hilang, CSV/manual tetap, sambung ulang akun sama membuat baris baru; callback Meta. (DDL, `CHECK`, trigger, dan indeks diuji `db-schema.test.mjs` milik 01 §11.1) |
| `web/tests/social-derived-clip.test.mjs` | `cancelRunsForClip`; `createPost` untuk entri `derived` → `clip_kind='derived'`, `excluded_reason='derived'` |
| `web/tests/performance-profile-prepare.test.mjs` | `preparePerformanceProfile` di primary-worker: tulis bila syarat §13.4, hapus file lama bila tidak; `run-job.mjs` tidak mengimpor modul DB |
| Diubah (ada hari ini): `web/tests/proxy-matcher.test.mjs`, `web/tests/env-example.test.mjs`, `web/tests/help-catalog.test.mjs`. Diubah (dibuat di Fase 4–6 oleh dokumen 01/02, belum ada hari ini): `deploy-env-contract.test.mjs`, `ownership-matrix.test.mjs`, `route-guard-coverage.test.mjs` | pengecualian, flag, mount, matriks |

Python (`pytest tests/<file>`):
- `tests/test_performance_profile.py` — load/validasi, kunci, `order_boost`.
- `tests/test_selection_v3_performance.py` — tanpa profil = identik; profil tak cocok = identik; dorongan hanya melewati near-tie; `_focus_floors` tidak berubah; cap total.
- `tests/test_edit_distance.py` — seed = `none`, overlap < 0,8 = `far`, hook berubah = `far`.
- `tests/test_deploy_guard.py` (diubah) — kasus R0/R1 milik 08 §8.6.

### 16.2 Crash matrix (fake platform, `web/tests/social-crash-matrix.test.mjs`)

Worker dibunuh (SIGKILL simulasi: lease ditinggalkan) di setiap titik, lalu proses baru melanjutkan:

| Provider | Titik crash | Hasil yang diharapkan |
|---|---|---|
| semua | setelah klaim, sebelum `begin` | 1 posting |
| YouTube | setelah `begin`, sebelum checkpoint tersimpan | sesi yatim di fake (tidak jadi video), 1 posting |
| YouTube | tengah chunk | resume dari `Range`, 1 posting |
| YouTube | chunk terakhir terkirim, jawaban hilang, sesi masih ada | `reconcile` 200 → 1 posting |
| YouTube | idem, sesi sudah kedaluwarsa | `maybe_sent`, 0 duplikat |
| TikTok | setelah `init`, sebelum checkpoint | init yatim (tidak terposting), 1 posting |
| TikTok | tengah chunk, `upload_url` masih berlaku | resume, 1 posting |
| TikTok | `upload_url` kedaluwarsa | `failed social_upload_expired` → retry → 1 posting |
| TikTok | setelah chunk terakhir, saat `processing` | poll → 1 posting |
| Instagram | setelah container, sebelum rupload | resume offset, 1 posting |
| Instagram | `media_publish` terkirim, jawaban hilang | `reconcile` cari media → 1 posting |
| Instagram | idem, caption ganda di 10 media terakhir | `maybe_sent` |
| semua | saat refresh token Fase A/B | token konsisten, tidak ada 2 generasi |

### 16.3 E2E (Playwright di CI)

- `web/e2e/social-publish.spec.mjs` — sambung (fake), Terbitkan sekarang, Jadwalkan, ubah jadwal, batal, putus akun (dialog jumlah jadwal), `?hasil=` toast; di `id` dan `en`.
- `web/e2e/analytics.spec.mjs` — kosong, data kurang, rentang, impor CSV + Cocokkan.
- `web/e2e/multiuser-isolation.spec.mjs` (diubah) — pengguna B tidak melihat koneksi/run/posting/metrik A.

---

## 17. Milestone dan estimasi

Ringkasan; angka hari-dev, urutan fase, dan critical path dimiliki 08 §4–§6 (bila berbeda, 08 yang berlaku). Isi teknis tiap milestone = bagian dokumen ini yang dirujuk.

| Milestone | Fase | Isi | Hari | Bergantung |
|---|---|---|---|---|
| SOS-M0 | 0 | `docs/operations/SOSMED.md`, verifikasi semua **[V]**, checklist §11.6 dimulai | 3 | G0 |
| FB-M0 | 0 | `rules.v1.json`, kontrak snapshot v1, kontrak registry, contoh CSV diminta | 2 | G0 |
| SOS-M1 Release A (R0 → R1) | 6 ‖ | §6.8, §12.2, `0003-social-base.sql`, store/scheduler, `SocialAppsCard` | 5 | Fase 4 (DB), MU-M4 (sealing v2) |
| SOS-M2 | 8 | OAuth §7, refresh dua fase, putus + purge, callback Meta | 5 | SOS-M1 |
| SOS-M3a | 8 | `0005-posts.sql`, `post-registry.mjs`, `listJobClips` (manifest), `rangeFileResponse`, `media.mjs`, `publisher.mjs`, YouTube, route §9.1 | 6 | SOS-M2 |
| SOS-M3b | 8 | TikTok `FILE_UPLOAD`, Instagram resumable (+ fallback URL bila M0 menuntut) | 6 | SOS-M3a |
| SOS-M4 + dashboard F8 | 8 | `/sosial`, `?hasil=`, `PublishDrawer`, `ClipPosts` | 8–9 | SOS-M3a |
| SOS-M6 | 8 | `VM_NGINX_CLOUDFLARE.md`, `/privasi`, `/ketentuan`, rollout `admin` → `on` | 2 | SOS-M4 |
| i18n M7b | 8 | `social`, `users.time_zone`, DatePicker berzona, status posting berkode, `email.*` | 2 | M6a |
| FB-M1 | 9 | `json-store.mjs`, `performance-store.mjs`, `0007-performance.sql`, CSV, Catat angka | 5,5 | SOS-M3a |
| FB-M2 | 9 | `performance_profile.py`, `performance-keys.mjs`, `performance-profile.mjs`, `preparePerformanceProfile` (primary-worker), `--performance-profile`, `edit_distance` | 3,5 | FB-M1 |
| FB-M3 | 9 | `selection_v3.py` `order_boost`, `SelectorContext.performance`, `performance_gate.py` | 5 | FB-M2 |
| FB-M4 + SOS-M5 | 9 | `metrics-refresh.mjs`, `readPostStats` per provider, `retention.mjs`, `outcomes.mjs` | 4 | SOS-M3b |
| FB-M5 + dashboard F9 | 9 | `/analitik`, route §9.2, kartu Pengaturan, chip | 5–6 | FB-M4 |
| i18n M7c | 9 | `analytics` | 0,5 | — |
| FB-M6 | 9 | laporan retro, rollout | 2,5 | FB-M3, FB-M5 |
| SOS-M7 | 12 (opsional) | audit platform + perbaikan temuan | 3 + kalender | M0 |
| FB-M7 | 12 (opsional) | eksperimen blok angka di prompt rerank | 3 | Gate FB-M3 |

---

## 18. Kriteria selesai ringkas per pengguna

- Pengguna menyambungkan akun dari `/sosial?tab=akun` dalam ≤ 3 klik (Hubungkan akun → pilih platform → izinkan di platform).
- Dari penampil klip: Terbitkan → (akun sudah terpilih default terakhir) → Terbitkan = ≤ 3 klik untuk terbit sekarang.
- Status posting tampil di klip (`ClipPosts`) dan di `/sosial` tanpa reload (polling 5 dtk selama ada run `claimed|uploading|processing`, berhenti saat tidak ada).
- Analitik menampilkan angka setelah refresh metrik pertama (≤ 6 jam setelah terbit).
- Toggle performa default mati; menyalakannya tidak mengubah skor yang tampil, hanya urutan near-tie.

---

## 19. Celah yang belum terselesaikan

1. **Angka platform [V]** (biaya unit `videos.insert`, batas posting TikTok, scope Instagram, endpoint rupload, kebijakan 30 hari, pembolehan agregat turunan) belum diverifikasi terhadap dokumentasi resmi terkini. SOS-M0 wajib selesai sebelum SOS-M2; konstanta kode mengikuti SOSMED.md.
2. **Header CSV ekspor YouTube Studio / TikTok Studio / Instagram** belum diketahui; `csv-profiles.v1.json` kosong sampai pemilik memberi contoh (Q11). Template Potongin sudah bisa dipakai.
3. **Resumable upload Instagram untuk Reels** belum dipastikan tersedia untuk Instagram Login; kalau tidak, fallback URL publik + pengecualian WAF menjadi jalur utama.
4. **Drift `hookForm`** antara proposal dan `hookText` final belum diukur; ambang 2% adalah nilai kerja, diputuskan di FB-M2.
5. **Field rentang sumber di dokumen editor** untuk `edit_distance` diambil dari `pieces` timemap (`src/ai_clipper/edit_v2/doc.py`); bentuk persis ditetapkan saat implementasi terhadap CONTRACTS yang berlaku saat itu (tidak mengubah skema dokumen).
6. **Batch berjarak** ("Jarak antar posting" di rancangan dashboard) ditunda (Q7 default); API hanya menerima multi-target untuk satu klip.
7. Pembagian kuota YouTube "jatah harian per pengguna" bisa membuat tiap pengguna hanya mendapat 1 unggahan/hari bila pengguna YouTube aktif > 5; menaikkan kuota butuh audit Google (kalender di luar kendali).
8. Penulis teks `/privasi`, `/ketentuan`, dan email kontak publik masih menunggu pemilik (Q7).

**Penyelarasan dokumen saudara:** selesai pada pemeriksaan silang akhir 2026-10-24 ([00-README.md](00-README.md) §8). Dokumen ini sekarang memakai nama kolom 01 §4.3–§4.7 apa adanya (termasuk putus akun = hapus baris, `next_attempt_at`, `scheduled_tz`, `connection_label`, `upload_box`, `error_params_json`, `posts.error_code`, `aggregate_json`, `users.perf_use_in_selection`, audit `social.data_deleted`); 02 §3.3/§8.2 memuat kunci `social_*` dan route performa; 05/06 memakai body `media:{kind:'export', renderId}`, `connection.handle`, dan `social_time_nonexistent`; 07 memakai `errors.performance` dan `scheduled_tz`; 08 memakai subpath `social`, health §6.8, hook hapus job di route, `?hasil=terhubung|ditolak|gagal`, `preparePerformanceProfile` di primary-worker, flag performa hanya di app + primary-worker.
