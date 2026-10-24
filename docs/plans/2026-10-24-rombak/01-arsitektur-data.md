# 01 · Arsitektur & data

- **Status:** Rancangan — belum diimplementasi
- **Tanggal:** 2026-10-24
- **Dokumen saudara:** [00-README.md](00-README.md) (indeks) ·
  [02-multiuser-keamanan.md](02-multiuser-keamanan.md) (auth, sesi, peran, matriks route, drain,
  rahasia per user) · [03-sosmed-performa.md](03-sosmed-performa.md) (API sosmed/analitik, state
  machine `publish_runs`, `social-worker`, profil performa) ·
  [04-reframe-unduhan.md](04-reframe-unduhan.md) (`layout.ranges`, unduhan, cache, kode error
  fetch) · [05-ui-dashboard.md](05-ui-dashboard.md) (layar, cookie UI) ·
  [06-editor.md](06-editor.md) (editor, klip turunan) · [07-i18n.md](07-i18n.md) (katalog,
  `/api/locale`, locale/zona) · [08-fase-test-deploy.md](08-fase-test-deploy.md) (fase, estimasi,
  gate, skrip deploy). Dokumen ini hanya memuat **arsitektur, penyimpanan, skema, dan runtime**.
  Perilaku route, layar, dan state machine fitur ada di dokumen pemiliknya di atas; di sini hanya
  bagian yang membentuk skema, dan dirujuk "lihat 0X §Y".
- **Sumber:** roadmap induk (Koreksi akhir KA1–KA26 + roadmap terkoreksi), roadmap fitur 01 +
  review #1–#16, rencana dashboard 02, editor 03, i18n 04. Kalau bertentangan, koreksi akhir
  roadmap induk menang. Penyimpangan dari roadmap induk ditandai **[Penyimpangan]** beserta
  alasannya.
- **Clean-room:** semua nama tabel/kolom/modul di sini ditulis dari kontrak Potongin. Repo SupoClip
  hanya dibaca untuk perilaku (09 §1). Nama clean-room final (§2.2-D roadmap induk) dipakai:
  `social_connections`, `publish_runs`, `oauth_pending`, adapter `readPostStats`,
  `/data/cache-unduhan`. Pemetaan nama draf → final: `social_accounts` → `social_connections`,
  `social_posts` → `publish_runs` (lifecycle unggah) + `posts` (registry), `oauth_states` →
  `oauth_pending`.
- **Pemilik:** dokumen ini adalah **satu-satunya sumber** DDL SQL (nama tabel, kolom, tipe,
  constraint, index, trigger, seed), penomoran migrasi `0001`–`0007`, konvensi waktu `*_at`,
  volume (`potongin_control` → `/control`), field `job.json` (`ownerId`, `fairnessKey`,
  `queue.firstClaimedAt`), backup/restore, dan runtime Node 24. Dokumen lain tidak memuat DDL
  sendiri; mereka merujuk §4 di sini plus daftar kolom singkat bila perlu (02 §3.2 dan 04 §B9
  sudah begitu). Kolom yang dibutuhkan perilaku fitur (terutama 03 §6–§10: putus akun = purge,
  `next_attempt_at`, `connection_label`, `upload_box`, `aggregate_json`) sudah dilebur ke §4.
  Perilaku (state machine, route, loop worker) tetap milik dokumen fiturnya. Sisa penyelarasan
  ada di §12.

Path ditulis relatif terhadap root repo. **(baru)** = file yang belum ada di repo hari ini.
Semua path lain sudah dicek ada (Read/grep, 2026-10-24).

Keputusan pemilik yang dipakai dokumen ini:

| # | Keputusan | Status |
|---|---|---|
| Q1 | Amandemen DESIGN.md/AGENTS.md; editor tanpa Mode Cepat/Lengkap (satu tata letak, pratinjau dulu, satu panel kanan terbuka); istilah **Terbitkan / Terbit** (state `published` di DB, label UI "Terbit") | **Final** (tidak membentuk skema selain nama state) |
| Q2 | Node 24 + `node:sqlite`; HeroUI v3 (`@heroui/react@3.2.6`) + Tailwind v4; `use-intl`; `@babel/parser` (dev) | **Final** |
| Q3 | Admin tidak membuka proyek orang lain; undangan saja; `APP_*` tetap sebagai break-glass; user smoke; tautan undangan/reset disalin manual (tanpa SMTP) | (default, bisa diubah) |
| Q4 | Berbagi rantai LLM diatur admin (awal menyala, `llm_share=true`), cap 200 unit AI/hari per anggota (02 §9.2); key LLM env tidak dibagi; cookie YouTube global milik admin; tren instans + switch per anggota; cache unduhan `umum` lintas user, tanpa cookie | (default, bisa diubah) |
| Q5 | Concurrency 1 sampai diukur; per anggota 3 job aktif, 1 berjalan, 30 job/jam; durasi sumber maks 4 jam; kuota storage kosong = tidak dibatasi sampai admin mengisinya | (default, bisa diubah) |
| Q6 | Paket hapus otomatis di luar `/data/jobs` (audit > 180 hari, sesi/undangan/reset kedaluwarsa, backup > 14, cache 4 GiB/3 hari, pin sosmed, aturan 30 hari YouTube) | (default, bisa diubah) |
| Q7 | Cap 100 run aktif / 20 per jam jadwal per user (definisi di 03 §10.1); kuota YouTube = jatah harian per user; hapus job membatalkan jadwal | (default, bisa diubah) |
| Q8 | Jadwal memakai zona perangkat, nama zona ditampilkan; 24 jam di semua locale | (default, bisa diubah) |
| Q9 | `en` dirilis bersama fase editor (opsi b); pratinjau `id,en` hanya sebelum ada anggota | **Final** (pemilik fleksibel, asal akhirnya ID + EN) |
| Q10 | Otomatis opt-in sampai PF-PIPELINE; override 3 mode; "Pakai di semua klip" mengantrekan analisis (tidak membentuk skema DB; `layout.ranges` = CONTRACTS §5.63, lihat 04 §A6) | (default, bisa diubah) |
| Q11 | Data performa privat per user; klip yang diedit jauh dikeluarkan (`posts.excluded_reason`); range-only dilewati; Kick eksperimen mati | (default, bisa diubah) |
| Q12 | Batas gabung klip (job sama, ≤ 20 menit), tanpa kunci; registri turunan tetap file (§3.1) | (default, bisa diubah) |

---

## 1. Arsitektur setelah rombak

### 1.1 Diagram service, volume, dan jaringan

```
 Pengguna ── Cloudflare ── nginx di VM (deploy/VM_NGINX_CLOUDFLARE.md) ── 127.0.0.1:8100
                                                                             │
┌─────────────────────────────── docker compose (satu project) ─────────────┼───────────────┐
│                                                                            ▼               │
│  ┌────────────────────────────────┐   spawn   ┌──────────────────────────────────────┐    │
│  │ app  (Next.js 16, Node 24)     │──────────►│ python -m ai_clipper.*  (editor api, │    │
│  │ CMD scripts/start-app.mjs      │           │ preview, post_text, …)  env tanpa DB │    │
│  │ • satu-satunya yang MIGRASI DB │           └──────────────────────────────────────┘    │
│  │ • /data rw   • /control rw     │                                                        │
│  └────────────────────────────────┘                                                        │
│  ┌────────────────────────────────┐   spawn   ┌──────────────────────────────────────┐    │
│  │ primary-worker (Node 24)       │──────────►│ run-job.mjs → python pipeline,       │    │
│  │ scripts/primary-worker.mjs     │           │ yt-dlp, ffmpeg, whisper  env tanpa DB│    │
│  │ • /data rw   • /control rw     │           └──────────────────────────────────────┘    │
│  │ • DB: baca user/kuota, tulis   │──── net `pot` (profil pot, Fase 7) ───┐               │
│  │   download_ledger, llm usage   │                                       ▼               │
│  └────────────────────────────────┘                          ┌────────────────────────┐   │
│  ┌────────────────────────────────┐   spawn                  │ pot-provider (opsional)│   │
│  │ render-worker (Python)         │──────────► node scripts/ │ tanpa volume, tanpa    │   │
│  │ python -m ai_clipper.          │  render-storage-         │ ports, read_only,      │   │
│  │ render_worker --watch          │  admission.mjs (tanpa DB)│ cap_drop ALL           │   │
│  │ • /data rw   • TANPA /control  │                          └────────────────────────┘   │
│  │ • round-robin per fairnessKey  │                                                        │
│  └────────────────────────────────┘                                                        │
│  ┌────────────────────────────────┐  egress HTTPS ke YouTube / TikTok / Instagram API      │
│  │ social-worker (Node 24)        │  (Fase 6: R0 image saja, R1 service compose)           │
│  │ scripts/social-worker.mjs      │                                                        │
│  │ • /data/social rw (subpath)    │                                                        │
│  │ • /control rw  • DB rw         │                                                        │
│  │ • env allowlist, tanpa LLM env │                                                        │
│  └────────────────────────────────┘                                                        │
└────────────────────────────────────────────────────────────────────────────────────────────┘

 Volume bernama:
   clipper_data      → /data      (app, primary-worker, render-worker)
   clipper_data      → /data/social  (social-worker, volume.subpath "social", Fase 6 R1)
   potongin_control  → /control   (app, primary-worker, social-worker)   ← BARU
```

### 1.2 Isi volume

```
/data                                   (clipper_data — data job; render-worker ikut me-mount)
├── jobs/                               JOBS_ROOT, tidak pernah dihapus otomatis
│   ├── .potongin-maintenance           penanda drain deploy (Fase 6, MU-M7b; kontrak di 02 §10.5)
│   ├── .primary-queue.lock/            lock antrean primary (primary-job-queue.mjs:15)
│   ├── .primary-reservations/<id>.json reservasi admission, v2 → v3 (+ownerId) §6.3
│   └── <uuid>/
│       ├── job.json                    sumber kebenaran job; +ownerId +fairnessKey (§6)
│       ├── input/  output/  analysis/  preview/  …   (tidak berubah)
│       ├── analysis/render-requests/<render_id>.json   render-request-v3 (tidak berubah)
│       └── analysis/derived-clips.json registri klip turunan (Fase 11, baru)
├── cache-unduhan/                      cache media + transkrip lintas job (Fase 7, baru; rinci 04 §B6.1)
│   ├── umum/<platform>/<mediaId>/<variant>/   tanpa kredensial, boleh lintas user (Q4 default)
│   ├── umum/_transkrip/<sourceKeyHash>/…      cache transkrip (04 §B6.5)
│   ├── k-<fairnessKey>/…               scope pemilik (kunci buram), struktur sama dengan umum/
│   ├── .locks/<lockKey>/owner.json     lock mkdir + lease (04 §B6.4)
│   ├── .tmp/<random>/                  unduhan berjalan, di-rename saat selesai
│   └── .sweep.json                     hasil sweep terakhir (04 §B6.6–§B6.7)
├── social/media/<runId>.mp4            pin hard-link ekspor untuk unggahan (Fase 8, baru; ditulis app, 03 §6.7)
└── settings/                           LAMA — dibekukan setelah dipindah ke /control (§5)

/control                                (potongin_control — data kontrol; BUKAN untuk Python)
├── potongin.sqlite                     DB kontrol, 0600 (+ -wal, -shm)
├── backups/
│   ├── potongin-<YYYYMMDDTHHMMSSZ>-<reason>.sqlite   VACUUM INTO, 0600, simpan 14 per reason (§7.1)
│   └── settings-<YYYYMMDDTHHMMSSZ>-<reason>.tar      salinan pohon settings, 0600
└── settings/                           POTONGIN_SETTINGS_DIR baru, 0700
    ├── llm-settings.json  transcription.json  youtube-cookies.json
    ├── trend-context.json  ingest-tokens.json (beku setelah impor, untuk rollback)
    ├── default-logo/  default-watermark.json  social-apps.json (Fase 6)
    ├── download-network.json (Fase 7)
    ├── .migrated-from-data             penanda pemindahan §5.2
    └── users/<userId>/                 setting per user (Fase 5+)
        ├── llm-settings.json  transcription.json  prefs.json
        └── default-logo/  default-watermark.json
```

Hard link antara `cache-unduhan/`, `social/media/` dan `jobs/` mewajibkan ketiganya di filesystem
yang sama (`st_dev` sama). Karena itu ketiganya ada di `clipper_data`, bukan di `/control`.

### 1.3 Siapa boleh membuka apa

| Proses | Mount `/data` | Mount `/control` | `POTONGIN_DB_PATH` di env | Buka DB | Jalankan migrasi | Settings dir |
|---|---|---|---|---|---|---|
| `app` (Next.js + `scripts/start-app.mjs`) | rw | rw | ya | rw | **ya, satu-satunya** | `/control/settings` |
| `primary-worker` (`scripts/primary-worker.mjs`) | rw | rw | ya | rw | tidak (menunggu versi) | `/control/settings` |
| `social-worker` (`web/scripts/social-worker.mjs` (baru) → `/app/scripts/social-worker.mjs`) | hanya `/data/social` (subpath, rw) | rw | ya | rw | tidak (menunggu versi) | `/control/settings` |
| `render-worker` (Python) | rw | **tidak** | **tidak** | **tidak** | — | tidak ada |
| `web/scripts/render-storage-admission.mjs` → `/app/scripts/render-storage-admission.mjs` (dijalankan render-worker) | rw | tidak | tidak | tidak | — | tidak ada |
| Proses Python anak (pipeline, editor api, preview, yt-dlp, ffmpeg) di app/primary | rw | ter-mount di container induk | **dibuang dari env anak** | **tidak** | — | tidak ada |
| `pot-provider` | tidak | tidak | tidak | tidak | — | — |

Penegakan:
1. **Mount** — `web/tests/deploy-env-contract.test.mjs` (baru) mem-parse `compose.yaml` dan gagal
   bila `potongin_control` di-mount ke service selain `app`, `primary-worker`, `social-worker`,
   bila `POTONGIN_DB_PATH` muncul di service lain, atau bila `social-worker` me-mount
   `clipper_data` tanpa `subpath: social` (review #4: kontrol harus memeriksa mount, bukan hanya
   env).
2. **Env anak** — `web/tests/security-child-env.test.mjs` (ada, diperluas): env anak dari
   `web/scripts/run-job.mjs`, `web/lib/python-cli.mjs`, `web/lib/editor-ai.mjs`,
   `web/lib/clip-text-api.mjs` tidak memuat `POTONGIN_DB_PATH`, `POTONGIN_SETTINGS_SECRET`,
   `APP_SESSION_SECRET`, `NODE_OPTIONS`.
3. **Kode Python** — `tests/test_control_plane_isolation.py` (baru): grep `src/ai_clipper/**`
   untuk `import sqlite3`, `"/control"`, `POTONGIN_DB_PATH`, `potongin.sqlite` → harus nol.
   (Python di container app/primary *secara fisik* bisa melihat `/control`; jaminannya adalah
   env + tes statis ini, bukan mount. Ini dicatat jujur di §5.59 CONTRACTS.)
4. **Render-worker** — tidak punya mount `/control`, jadi tidak bisa membaca DB, backup, maupun
   settings tersegel, sekalipun ada bug.

### 1.4 Prinsip yang dipertahankan

- `JOBS_ROOT/<uuid>/job.json` tetap sumber kebenaran job. **Tidak ada tabel job**, tidak ada
  dual-write. DB hanya menyimpan data kontrol (identitas, sosmed, registry posting, metrik,
  ledger unduhan, pemakaian LLM bersama).
- Python tidak tahu pemilik: Python hanya melihat `fairnessKey` buram (§6.2) dan path cache
  ber-prefix kunci buram.
- Rollback berbasis image. Migrasi DB hanya aditif (§3). Image lama mengabaikan DB dan field baru
  `job.json`.

---

## 2. Modul DB dan runtime SQLite

### 2.1 File

| File | Isi |
|---|---|
| `web/lib/db/index.mjs` (baru) | `openDb()`, `db()`, `tx(fn)`, `requireSchema(min)`, `closeDb()` |
| `web/lib/db/migrate.mjs` (baru) | `migrate(db, dir)`, `pendingMigrations()`, `lintMigrationSql(text)` |
| `web/lib/db/migrations/NNNN-<slug>.sql` (baru) | satu file per migrasi, §3–§4 |
| `web/lib/db/prune.mjs` (baru) | prune harian metadata kedaluwarsa (Q6) |
| `web/lib/db/settings-move.mjs` (baru) | pemindahan `/data/settings` → `/control/settings` (§5.2) |
| `web/scripts/start-app.mjs` (baru) | boot app: cek path → pindah settings (§5.2) → migrasi → bootstrap admin/smoke → `import("../server.js")` |
| `web/scripts/db-backup.mjs` (baru) | `VACUUM INTO` + tar settings + retensi 14 (§7) |
| `web/scripts/db-restore.mjs` (baru) | restore offline dengan `integrity_check` (§7.3) |
| `web/scripts/admin-reset.mjs` (baru) | `--admin` (break-glass), `--ensure-smoke-user` (02 §6.6), `--purge-legacy-settings` (§5.2), `--set-setting <key> <json>` (hanya kunci `social_*`, SOS-M3a, 03 §10.1) |
| `web/scripts/social-worker.mjs` (baru) | proses `social-worker` (perilaku di 03 §6.8); `openDb({role:"social"})` |
| `web/lib/sealing.mjs` (baru, MU-M4) | kotak tersegel v2 (purpose + scope + AAD). Hari ini penyegelan ada di `web/lib/llm-settings.mjs` (bagian "Key sealing", baris 156) dan `seal()` di `web/lib/youtube-cookies.mjs:69`; kotak v1 tetap terbaca |

`Dockerfile` (`CMD ["node", "server.js"]` di baris 94) diubah menjadi
`CMD ["node", "scripts/start-app.mjs"]`. `web/scripts/` disalin ke `/app/scripts` dan `web/lib`
ke `/app/lib` (Dockerfile baris 81–82), jadi file `.sql` tersedia di `/app/lib/db/migrations`.
Direktori migrasi di-resolve dari `path.join(process.cwd(), "lib/db/migrations")` (cwd `/app` di
image, `web/` di dev/tes); tidak lewat bundler Next.

### 2.2 API `web/lib/db/index.mjs`

```js
// Semua sinkron (node:sqlite DatabaseSync). Tidak ada fungsi async di modul ini.
export const DB_ROLES = ["app", "primary", "social", "cli", "test"];
export function openDb({ path = process.env.POTONGIN_DB_PATH, role, readOnly = false } = {}): DatabaseSync
export function db(): DatabaseSync                 // singleton per proses; lempar DbUnavailableError bila belum open
export function tx(fn: (db) => T): T               // BEGIN IMMEDIATE … COMMIT / ROLLBACK
export function requireSchema(min: number): void   // lempar SchemaTooOldError bila meta.schema_version < min
export function schemaVersion(): number
export function closeDb(): void
export class DbUnavailableError extends Error { code = "db_unavailable" }
export class SchemaTooOldError extends Error  { code = "db_schema_old" }
```

Aturan `openDb`:
1. `path` wajib absolut. Ditolak (`DbUnavailableError`, pesan Indonesia di log) bila `realpath`
   path atau direktorinya berada di dalam `JOBS_ROOT` atau di dalam `POTONGIN_SETTINGS_DIR`
   (pola sama dengan cek di `resolveSettingsPaths`, `web/lib/llm-settings.mjs:125-135`).
2. Bila file belum ada, dibuat lebih dulu dengan `fs.openSync(path, "wx", 0o600)` (lalu ditutup)
   sebelum `new DatabaseSync(path)`; SQLite memberi `-wal`/`-shm` mode yang sama dengan file DB.
   File yang ada dengan mode lebih longgar dikoreksi `chmod 0600` sekali dan dicatat di log.
   Direktori induk wajib 0700 dan dimiliki uid proses; selain itu `DbUnavailableError`.
3. Pragma tiap koneksi, urut:
   `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`,
   `trusted_schema=OFF`, `cell_size_check=ON`.
4. `role` disimpan di memori proses (dipakai log dan `process_heartbeats`, §4.1), tidak di `meta`.
   Hanya `role="app"` dan `role="test"` yang boleh memanggil `migrate`; role lain →
   `migrate()` melempar `Error("migrate: role <x> dilarang")`. `role="cli"` dipakai
   `db-backup.mjs`, `db-restore.mjs`, `admin-reset.mjs`, `multiuser-migrate.mjs` dan tidak pernah
   memigrasi (CLI yang butuh skema baru memanggil `requireSchema`).
5. Satu koneksi per proses (singleton). Proses tidak membuka DB bila `POTONGIN_DB_PATH` kosong;
   fungsi pemanggil yang butuh DB lalu gagal tertutup (`db_unavailable`, HTTP 503).
6. Setiap proses ber-role `app`/`primary`/`social` menulis detak ke `process_heartbeats` tiap 10
   detik (`INSERT … ON CONFLICT(role, host) DO UPDATE`), dan menghapus barisnya saat keluar normal.
   Dipakai `db-restore.mjs` (§7.3) dan health `social-worker` (03 §6.8, bersama file health
   `/tmp/social-worker-health.json`).

Aturan `tx(fn)`:
- `fn` **wajib sinkron**. Bila `fn` mengembalikan thenable, `tx` melakukan ROLLBACK lalu melempar
  `TypeError("tx: fungsi async dilarang")`. Ini menegakkan aturan "tidak ada I/O jaringan di dalam
  transaksi" (refresh token dua fase, publish, metrik).
- Bersarang: `tx` di dalam `tx` memakai `SAVEPOINT tx_<n>`.
- `SQLITE_BUSY` setelah `busy_timeout` → `DbBusyError` (`db_busy`, HTTP 503 `retryable: true`).
  Kelas ini diekspor dari `web/lib/db/index.mjs` bersama dua kelas lain.
- Route yang menangkap error DB menjawab bentuk error aditif CONTRACTS (`error` Indonesia +
  `code` + `messageId`): `db_unavailable` → 503 `errors.web.db_unavailable`, `db_busy` → 503
  `errors.web.db_busy` + header `Retry-After: 2`, `db_schema_old` → 503
  `errors.web.db_unavailable`. Tidak ada detail SQL di body maupun log level info.

### 2.3 Kontrak sinkron dengan guard

`currentUser(request)` / `requireUser(request)` / `requireAuth(request)` membaca sesi lewat
`db()` secara sinkron, sehingga `secureRoute` (`web/lib/security-headers.mjs:141`, yang memanggil
`authorize(request)` tanpa `await` di baris 147) tetap benar. Dijaga
`web/tests/authorize-sync-contract.test.mjs` (baru): setiap fungsi authorize yang dipakai route
mengembalikan nilai non-Promise. Detail sesi dan guard: 02 §4 dan §7.2.

### 2.4 Proses non-app saat start

`primary-worker` dan `social-worker` memanggil `openDb({role})` lalu
`requireSchema(REQUIRED_SCHEMA_<ROLE>)`. Bila skema masih lebih tua (app belum selesai migrasi):
coba ulang tiap 2 detik selama maksimal 60 detik, lalu keluar dengan kode 78 sehingga healthcheck
gagal dan `deploy/production.sh` me-rollback. Konstanta `REQUIRED_SCHEMA_PRIMARY` dan
`REQUIRED_SCHEMA_SOCIAL` ada di `web/lib/db/index.mjs` dan hanya boleh naik.

Skema yang **lebih baru** dari yang dikenal kode selalu diterima (kunci rollback image).

---

## 3. Migrasi: penomoran dan aturan aditif

### 3.1 Penomoran dan rencana file

- Nama file: `web/lib/db/migrations/NNNN-<slug>.sql`, `NNNN` 4 digit, mulai `0001`, **berurutan
  tanpa celah**. Slug `[a-z0-9-]+`.
- Nomor ditetapkan saat PR di-merge ke `main`, sesuai urutan merge. Setelah di `main`, isi file
  **tidak boleh berubah** (sha256 dicatat di `schema_migrations`; `migrate()` gagal bila sha file
  yang sudah diterapkan berbeda).
- Satu migrasi = satu transaksi `BEGIN IMMEDIATE`. Isi file dijalankan utuh dengan satu
  `db.exec(text)` (node:sqlite menjalankan banyak statement berurutan; **tidak** dipecah manual di
  `;`, karena badan trigger memuat `;`). Satu statement gagal → ROLLBACK seluruh migrasi itu, app
  tidak start (exit 1).
- Rencana (urut fase; nomor final mengikuti urutan merge):

| No | File | Fase / milestone | Isi |
|---|---|---|---|
| 0001 | `0001-identity.sql` | Fase 4 · MU-M1/M2 + i18n M6a | `meta`, `users` (termasuk `locale`), `sessions`, `invites`, `password_resets`, `api_tokens`, `instance_settings`, `audit_events`, `process_heartbeats` (`schema_migrations` dibuat `migrate.mjs`, bukan file ini) |
| 0002 | `0002-shared-llm-usage.sql` | Fase 5 · MU-M4 | `shared_llm_usage` |
| 0003 | `0003-social-base.sql` | Fase 6 · SOS-M1 Release A | `social_connections`, `oauth_pending`, `social_quota` |
| 0004 | `0004-download-ledger.sql` | Fase 7 · FETCH-M7 | `download_ledger` |
| 0005 | `0005-posts.sql` | Fase 8 · SOS-M3a | `posts`, `publish_runs`, seed `instance_settings` `social_*` |
| 0006 | `0006-user-time-zone.sql` | Fase 8 · i18n M7b | `users.time_zone` |
| 0007 | `0007-performance.sql` | Fase 9 · FB-M1 | `metric_imports`, `metric_import_rows`, `metric_snapshots`, `metric_horizons`, `metric_refresh`, `users.perf_use_in_selection` |

`users.locale` masuk `0001` karena MU-M2 dan i18n M6a dirilis di fase yang sama (Fase 4) dan
`0001` belum pernah ter-deploy; tidak ada image yang melihat `users` tanpa `locale`. Karena itu
**tidak ada** migrasi `users-locale` terpisah (07 §9.4 sudah merujuk `0001`).
Untuk alasan yang sama kolom batas per user (`max_active_jobs` dst.) masuk `0001`. `users.time_zone`
= `0006-user-time-zone.sql` (07 §13.2 merujuk nama ini). `shared_llm_usage` tetap migrasi sendiri (`0002`) karena dirilis Fase 5.

Klip turunan **tidak** punya tabel: registrinya file `analysis/derived-clips.json` (Fase 11,
editor). `posts.clip_id` boleh berisi id klip turunan; untuk itu `posts.selection_keys_json`
bernilai `NULL` (§4.5).

### 3.2 Aturan aditif (dijaga `web/tests/db-migrations.test.mjs`, baru)

**Boleh:**
- `CREATE TABLE …` (wajib `STRICT`), `CREATE INDEX`, `CREATE UNIQUE INDEX` pada tabel baru,
  `CREATE TRIGGER`, `CREATE VIEW`.
- `ALTER TABLE … ADD COLUMN` yang `NULL`-able, atau `NOT NULL DEFAULT <konstanta>`. `CHECK` pada
  kolom baru boleh, asal hanya merujuk kolom itu.
- `INSERT OR IGNORE` baris awal (seed `instance_settings`, `meta`).
- `UPDATE` hanya untuk mengisi kolom yang dibuat di migrasi yang sama (backfill).

**Dilarang** (lint men-tokenisasi file, melewati komentar `--`/`/* */` dan literal string, lalu
menolak case-insensitive):
`DROP`, `RENAME`, `ALTER TABLE … DROP`, `ALTER TABLE … RENAME`, `DELETE FROM` **di level
statement** (di dalam badan trigger boleh), `REPLACE INTO`, `INSERT OR REPLACE`, `PRAGMA` (pragma
hanya di `openDb`), `ATTACH`, `DETACH`, `VACUUM`, `CREATE UNIQUE INDEX` pada tabel yang sudah ada
di migrasi sebelumnya (bisa gagal pada data lama), `IF NOT EXISTS` (menyembunyikan drift), dan
statement transaksi: statement yang diawali `BEGIN`, `COMMIT`, `END`, `ROLLBACK`, `SAVEPOINT`,
`RELEASE`. `BEGIN … END` di dalam `CREATE TRIGGER` tidak termasuk (lint melacak kedalaman
trigger).

**Migrasi contract** (satu-satunya pengecualian): nama `NNNN-contract-<slug>.sql`, butuh
persetujuan pemilik di PR, menaikkan `meta.min_image_schema`, dan dicatat di matriks rollback
("jangan rollback melewati migrasi contract"). Tidak ada migrasi contract yang direncanakan.

**Aturan kode agar image lama aman di skema baru:**
- Tidak ada `SELECT *`; kolom selalu disebut. `INSERT` selalu menyebut kolom.
- Kolom baru di tabel lama selalu `NULL`-able atau ber-`DEFAULT`, sehingga `INSERT` dari image
  lama tetap lolos.
- Enum yang bisa bertambah (status run, provider, kode audit, sumber metrik) **tidak** memakai
  `CHECK … IN (…)` karena menambah nilai butuh rebuild tabel. Validasinya di JS (konstanta beku di
  modul pemilik tabel) dan diuji. `CHECK … IN` hanya untuk set tertutup (`role`, boolean 0/1,
  `actor_kind`).
- Setiap modul pemilik tabel mendeklarasikan `REQUIRED_SCHEMA` dan memanggil `requireSchema` saat
  pertama dipakai.

### 3.3 Algoritme `migrate()`

```
1. tx: CREATE TABLE IF NOT EXISTS schema_migrations (DDL di bawah)   -- di migrate.mjs, bukan file .sql
2. files = readdir(dir) yang cocok /^\d{4}-[a-z0-9-]+\.sql$/, urut nomor
3. tolak bila nomor tidak 1..N berurutan, atau ada nomor ganda
4. applied = SELECT version, sha256 FROM schema_migrations
5. untuk tiap version di applied: sha(file) harus == sha tersimpan, kalau tidak → MigrationTamperedError
6. bila max(applied) > N (DB lebih baru dari image): log "skema lebih baru", lanjut tanpa migrasi
7. untuk tiap file version > max(applied):
     lintMigrationSql(text) wajib lolos
     BEGIN IMMEDIATE
       jalankan statement
       INSERT INTO schema_migrations(version,name,sha256,applied_at)
       INSERT INTO meta(key,value,updated_at) VALUES('schema_version', version, now)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
     COMMIT
8. PRAGMA foreign_key_check → harus kosong; PRAGMA quick_check → "ok"
```
Idempoten: menjalankan `migrate()` dua kali tidak mengubah apa pun (diuji).

DDL bootstrap di `web/lib/db/migrate.mjs` (konstanta `SCHEMA_MIGRATIONS_DDL`, tidak pernah
berubah):

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY CHECK (version >= 1),
  name       TEXT    NOT NULL CHECK (length(name) BETWEEN 6 AND 80),
  sha256     TEXT    NOT NULL CHECK (length(sha256) = 64),
  applied_at INTEGER NOT NULL
) STRICT;
```

Error `migrate()`: `MigrationTamperedError` (sha beda), `MigrationOrderError` (celah/ganda),
`MigrationLintError` (token terlarang; pesan menyebut file + baris). Semua → log + exit 1.

---

## 4. Skema lengkap (DDL)

Konvensi semua tabel:
- `STRICT`. Waktu = `INTEGER` milidetik epoch UTC (`*_at`). Id entitas = `TEXT` UUID v4 huruf
  kecil (`crypto.randomUUID()`), dicek `length(id) = 36`. Log append-only memakai
  `INTEGER PRIMARY KEY AUTOINCREMENT`.
- JSON disimpan sebagai `TEXT` dengan `CHECK (json_valid(x))` dan batas panjang.
- Rahasia tidak pernah disimpan mentah: token → `sha256` hex; token OAuth → kotak tersegel
  `web/lib/sealing.mjs` **(baru, MU-M4)** v2 (purpose + AAD, 02 §9.2).
- Nama waktu: titik waktu = `*_at` (ms epoch UTC); durasi = `*_ms` (mis. `duration_ms`). Kolom
  JSON berakhiran `_json`; kotak tersegel berakhiran `_box`.
- Nama kolom pemilik: `owner_id` (DB) ↔ `ownerId` (JSON/JS).

### 4.1 `0001-identity.sql` (Fase 4)

```sql
CREATE TABLE meta (
  key        TEXT    PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 64 AND key NOT GLOB '*[^a-z0-9_]*'),
  value      TEXT    NOT NULL CHECK (length(value) <= 512),
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE users (
  id                   TEXT    PRIMARY KEY CHECK (length(id) = 36),
  username             TEXT    NOT NULL COLLATE NOCASE
                       CHECK (length(username) BETWEEN 3 AND 32
                              AND username = lower(username)
                              AND username NOT GLOB '*[^a-z0-9._-]*'),
  display_name         TEXT    NOT NULL CHECK (length(display_name) BETWEEN 1 AND 60),
  role                 TEXT    NOT NULL CHECK (role IN ('admin','member')),
  status               TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  password_hash        TEXT    NOT NULL CHECK (password_hash GLOB 'scrypt$*'),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)),
  is_bootstrap         INTEGER NOT NULL DEFAULT 0 CHECK (is_bootstrap IN (0,1)),
  is_smoke             INTEGER NOT NULL DEFAULT 0 CHECK (is_smoke IN (0,1)),
  locale               TEXT    NULL CHECK (locale IS NULL OR (length(locale) BETWEEN 2 AND 16 AND locale GLOB '[a-z]*')),  -- 07 §9.4
  -- NULL = pakai default instans (instance_settings member_*); admin tidak dibatasi
  storage_quota_bytes  INTEGER NULL CHECK (storage_quota_bytes IS NULL OR storage_quota_bytes >= 0),
  max_active_jobs      INTEGER NULL CHECK (max_active_jobs   IS NULL OR max_active_jobs   >= 0),
  max_running_jobs     INTEGER NULL CHECK (max_running_jobs  IS NULL OR max_running_jobs  >= 0),
  jobs_per_hour        INTEGER NULL CHECK (jobs_per_hour     IS NULL OR jobs_per_hour     >= 0),
  max_source_seconds   INTEGER NULL CHECK (max_source_seconds IS NULL OR max_source_seconds > 0),
  llm_share            INTEGER NULL CHECK (llm_share IS NULL OR llm_share IN (0,1)),  -- NULL = ikut instans
  trends_enabled       INTEGER NOT NULL DEFAULT 1 CHECK (trends_enabled IN (0,1)),
  password_changed_at  INTEGER NOT NULL,
  last_login_at        INTEGER NULL,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  disabled_at          INTEGER NULL,
  created_by           TEXT    NULL REFERENCES users(id) ON DELETE SET NULL,
  CHECK ((status = 'disabled') = (disabled_at IS NOT NULL)),
  CHECK (NOT (is_smoke = 1 AND role = 'admin')),
  CHECK (NOT (is_bootstrap = 1 AND is_smoke = 1))
) STRICT;
CREATE UNIQUE INDEX users_username       ON users(username);
CREATE UNIQUE INDEX users_one_bootstrap  ON users(is_bootstrap) WHERE is_bootstrap = 1;
CREATE UNIQUE INDEX users_one_smoke      ON users(is_smoke)     WHERE is_smoke = 1;
CREATE INDEX        users_role_status    ON users(role, status);

CREATE TABLE sessions (
  id               TEXT    PRIMARY KEY CHECK (length(id) = 22),           -- sid, 16 byte base64url
  user_id          TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret_sha256    TEXT    NOT NULL CHECK (length(secret_sha256) = 64),
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,                                      -- created_at + 30 hari, absolut
  last_seen_at     INTEGER NOT NULL,                                      -- ditulis ≤ 1×/menit
  reauth_at        INTEGER NULL,                                          -- re-auth terakhir (aksi admin)
  revoked_at       INTEGER NULL,
  revoke_reason    TEXT    NULL CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 32),
  -- logout|logout_all|password_changed|disabled|admin_revoked|limit|deleted (JS, 02 §4.2)
  device_label     TEXT    NULL CHECK (device_label IS NULL OR length(device_label) <= 120),  -- dari User-Agent
  via              TEXT    NOT NULL CHECK (via IN ('password','break_glass','upgrade_v1','invite','reset')),
  CHECK (expires_at > created_at),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
) STRICT;
CREATE INDEX sessions_user_live ON sessions(user_id, expires_at) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expires   ON sessions(expires_at);

CREATE TABLE invites (
  id            TEXT    PRIMARY KEY CHECK (length(id) = 36),
  token_sha256  TEXT    NOT NULL UNIQUE CHECK (length(token_sha256) = 64),
  token_prefix  TEXT    NOT NULL CHECK (length(token_prefix) = 10),        -- "piv_" + 6, untuk tampilan
  role          TEXT    NOT NULL CHECK (role IN ('admin','member')),
  locale        TEXT    NOT NULL CHECK (length(locale) BETWEEN 2 AND 16),  -- bahasa undangan (Q9)
  username_hint TEXT    NULL CHECK (username_hint IS NULL OR length(username_hint) <= 32),
  note          TEXT    NULL CHECK (note IS NULL OR length(note) <= 80),
  created_by    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  used_at       INTEGER NULL,
  used_by       TEXT    NULL REFERENCES users(id) ON DELETE SET NULL,
  revoked_at    INTEGER NULL,
  CHECK (expires_at > created_at),
  CHECK (used_at IS NULL OR revoked_at IS NULL)
) STRICT;
CREATE INDEX invites_open    ON invites(expires_at) WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX invites_creator ON invites(created_by, created_at);

CREATE TABLE password_resets (
  id           TEXT    PRIMARY KEY CHECK (length(id) = 36),
  user_id      TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_sha256 TEXT    NOT NULL UNIQUE CHECK (length(token_sha256) = 64),
  created_by   TEXT    NULL REFERENCES users(id) ON DELETE SET NULL,       -- NULL = permintaan sendiri (SMTP)
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  used_at      INTEGER NULL,
  revoked_at   INTEGER NULL,
  CHECK (expires_at > created_at),
  CHECK (used_at IS NULL OR revoked_at IS NULL)
) STRICT;
CREATE INDEX password_resets_user_open ON password_resets(user_id) WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX password_resets_expires   ON password_resets(expires_at);

CREATE TABLE api_tokens (
  id            TEXT    PRIMARY KEY CHECK (length(id) = 36),             -- impor memakai id dari file
  user_id       TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label         TEXT    NOT NULL CHECK (length(label) BETWEEN 1 AND 40),
  prefix        TEXT    NOT NULL CHECK (length(prefix) = 10 AND prefix GLOB 'ptk_*'),
  sha256        TEXT    NOT NULL UNIQUE CHECK (length(sha256) = 64),
  scopes        TEXT    NOT NULL CHECK (json_valid(scopes) AND json_type(scopes) = 'array'
                                        AND json_array_length(scopes) BETWEEN 1 AND 8),
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER NULL,                                              -- ditulis ≤ 1×/menit
  revoked_at    INTEGER NULL,
  imported_from TEXT    NULL CHECK (imported_from IS NULL OR imported_from = 'ingest-tokens.json')
) STRICT;
CREATE INDEX api_tokens_user_live ON api_tokens(user_id) WHERE revoked_at IS NULL;

CREATE TABLE instance_settings (
  key        TEXT    PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 64 AND key NOT GLOB '*[^a-z0-9_]*'),
  value_json TEXT    NOT NULL CHECK (json_valid(value_json) AND length(value_json) <= 4096),
  updated_at INTEGER NOT NULL,
  updated_by TEXT    NULL REFERENCES users(id) ON DELETE SET NULL
) STRICT;

CREATE TABLE audit_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  at             INTEGER NOT NULL,
  code           TEXT    NOT NULL CHECK (length(code) BETWEEN 3 AND 64 AND code GLOB '[a-z]*.[a-z]*'),
  actor_kind     TEXT    NOT NULL CHECK (actor_kind IN ('user','token','system','cli')),
  actor_user_id  TEXT    NULL REFERENCES users(id) ON DELETE SET NULL,
  actor_label    TEXT    NULL CHECK (actor_label IS NULL OR length(actor_label) <= 32),   -- snapshot username
  target_user_id TEXT    NULL REFERENCES users(id) ON DELETE SET NULL,
  target_label   TEXT    NULL CHECK (target_label IS NULL OR length(target_label) <= 32),
  job_id         TEXT    NULL CHECK (job_id IS NULL OR length(job_id) = 36),
  params_json    TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(params_json) AND json_type(params_json) = 'object'
                                                      AND length(params_json) <= 2048),
  request_id     TEXT    NULL CHECK (request_id IS NULL OR length(request_id) <= 64)
) STRICT;
CREATE INDEX audit_at     ON audit_events(at);
CREATE INDEX audit_actor  ON audit_events(actor_user_id, at);
CREATE INDEX audit_target ON audit_events(target_user_id, at);
CREATE INDEX audit_job    ON audit_events(job_id) WHERE job_id IS NOT NULL;
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OF at, code, actor_kind, actor_label, target_label, job_id, params_json, request_id
  ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;

-- Detak proses pembuka DB (§2.2 aturan 6). Satu baris per (role, host); host = os.hostname()
-- (id container). Satu-satunya tabel detak (tidak ada tabel detak khusus sosmed).
CREATE TABLE process_heartbeats (
  role       TEXT    NOT NULL CHECK (role IN ('app','primary','social')),
  host       TEXT    NOT NULL CHECK (length(host) BETWEEN 1 AND 64),
  pid        INTEGER NOT NULL CHECK (pid > 0),
  image_sha  TEXT    NULL CHECK (image_sha IS NULL OR length(image_sha) <= 64),   -- POTONGIN_APP_COMMIT
  started_at INTEGER NOT NULL,
  beat_at    INTEGER NOT NULL,
  PRIMARY KEY (role, host)
) STRICT, WITHOUT ROWID;

INSERT OR IGNORE INTO instance_settings(key, value_json, updated_at) VALUES
  ('signup_mode',                '"invite"',   0),
  ('llm_share',                  'true',       0),
  ('llm_daily_cap',              '200',        0),
  ('groq_share',                 'false',      0),
  ('youtube_cookies_share',      'true',       0),
  ('member_llm_keys_allowed',    'true',       0),
  ('trends_scope',               '"instance"', 0),
  ('member_storage_quota_bytes', 'null',       0),
  ('member_max_active_jobs',     '3',          0),
  ('member_max_running_jobs',    '1',          0),
  ('member_jobs_per_hour',       '30',         0),
  ('member_max_source_seconds',  '14400',      0),
  ('invite_ttl_hours',           '168',        0),
  ('reset_ttl_hours',            '24',         0);
```

Catatan `0001`:
- `password_hash` = `scrypt$<logN>$<r>$<p>$<salt b64url>$<hash b64url>`; awal: logN 15, r 8, p 1,
  salt 16 byte, hash 64 byte, `maxmem` 64 MiB. Username tak dikenal tetap menjalankan scrypt pada
  dummy hash (anti-enumerasi, waktu sama).
- Cookie `__Host-potongin_session = s2.<sid>.<secret>`; `secret` 32 byte base64url, hanya
  `sha256(secret)` yang disimpan; dibandingkan dengan `timingSafeEqual`. Cookie v1 hari ini
  (`SESSION_COOKIE = "potongin_session"`, `web/lib/auth.mjs:3`) diterima selama rilis transisi dan
  di-upgrade sekali menjadi baris `sessions` dengan `via = 'upgrade_v1'`. `revoke_reason` tidak
  memakai `CHECK … IN` (set bisa bertambah); nilainya divalidasi `web/lib/sessions.mjs` (baru).
- Token: undangan `piv_` + 43 karakter base64url, reset `prs_` + 43, API `ptk_` + 43 (format yang
  sama dengan `web/lib/ingest-tokens.mjs:28`).
- "Minimal satu admin aktif" ditegakkan di `web/lib/users.mjs` (baru) di dalam `tx` (hitung admin
  aktif sebelum ubah peran/nonaktif/hapus), bukan dengan trigger.
- `meta` diisi saat boot (bukan di migrasi), daftar kunci beku (tambah lewat PR):
  `schema_version` (ditulis `migrate()`), `instance_id` (UUID, sekali), `bootstrap_owner_id` (id
  admin pertama dari `APP_USERNAME`), `smoke_user_id`, `min_image_schema` (`1`),
  `fairness_key_version` (`1`), `created_at`, `settings_migrated_at` (§5.2),
  `ingest_tokens_imported_at` dan `defaults_copied_at` (§10 langkah 6),
  `legacy_settings_purged_at` (§5.2). Nilai angka/waktu disimpan sebagai teks desimal.
- Default `instance_settings` mengikuti Q4/Q5 (default, bisa diubah). Arti, tipe, dan validasi
  tiap kunci milik 02 §3.3 (`web/lib/instance-settings.mjs`); di sini hanya seed. Kunci `social_*`
  di-seed `0005` (§4.5). Kunci baru = `INSERT OR IGNORE` di migrasi berikutnya.

Kode audit awal (`web/lib/audit.mjs`, baru; daftar beku, ditambah lewat PR). `params_json` hanya
berisi nilai, tidak pernah prosa (i18n M7a: dirender dalam bahasa penonton dari `audit.<code>`).
Kapan tiap kode ditulis: 02 §9.7 (identitas) dan 03 §7 (sosmed). Kode di luar tabel ini ditolak
`audit.mjs`:

| `code` | `params_json` |
|---|---|
| `bootstrap.admin_created` | `{}` |
| `smoke.ensured` | `{}` |
| `auth.break_glass` | `{}` (actor `user`) |
| `user.admin_reset` | `{"created":true}` (actor `cli`) |
| `user.created` / `user.enabled` / `user.disabled` / `user.deleted` | `{"role":"member"}` |
| `user.role_changed` | `{"from":"member","to":"admin"}` |
| `user.password_changed` | `{"via":"self"}` (`self`\|`reset`\|`cli`) |
| `user.password_reset_issued` | `{}` |
| `user.limits_changed` | `{"fields":["jobs_per_hour"]}` |
| `invite.created` / `invite.revoked` / `invite.used` | `{"inviteId":"…","role":"member"}` |
| `session.revoked_all` | `{"count":3,"scope":"self"}` (`self`\|`admin`) |
| `token.created` / `token.revoked` / `token.imported` | `{"tokenId":"…","scopes":["trends:write"]}` |
| `job.transferred` | `{"fromLabel":"…","toLabel":"…"}` + `job_id` |
| `job.deleted_by_admin` / `job.cancelled_by_admin` | `{}` + `job_id` |
| `settings.instance_changed` | `{"keys":["llm_share"]}` (juga `admin-reset --set-setting`, actor `cli`) |
| `settings.migrated` | `{"files":12}` (§5.2) |
| `settings.defaults_copied` | `{"logo":true,"watermark":false}` (§10 langkah 6) |
| `social.connected` / `social.disconnected` / `social.purged` (Fase 8) | `{"provider":"youtube"}` |
| `social.data_deleted` (Fase 8, callback Meta 03 §7.5) | `{"provider":"instagram","code":"…"}` |
| `performance.deleted` (Fase 9) | `{"count":12}` |
| `cache.cleared` (Fase 7, 04 §B6.7) | `{"scope":"all","removedEntries":12}` |
| `download_network.changed` (Fase 7, 04 §B7.2) | `{"fields":["proxy.mode"]}` (nama field saja, tidak pernah URL) |

### 4.2 `0002-shared-llm-usage.sql` (Fase 5)

```sql
CREATE TABLE shared_llm_usage (
  day        TEXT    NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),  -- hari UTC
  user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  calls      INTEGER NOT NULL DEFAULT 0 CHECK (calls >= 0),       -- unit AI yang sudah dibebankan (02 §9.2)
  reserved   INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),    -- unit AI dipesan pekerjaan yang sedang jalan
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day, user_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX shared_llm_usage_user ON shared_llm_usage(user_id, day);
```
- Hanya dipakai saat pekerjaan anggota memakai **rantai instans** (berbagi aktif). Rantai milik
  user sendiri dan admin tidak dihitung.
- Satuan = unit AI; biaya, `reserveSharedUnits`/`settleSharedUnits`, dan perilaku saat cap habis
  milik 02 §9.2. Skema hanya menjamin: pesan dan bebankan masing-masing satu `tx`; batas =
  `calls + reserved + cost ≤ llm_daily_cap`. Hari = UTC (reset 07.00 WIB) (default, bisa diubah).
  Penulis: `primary-worker` (pipeline) dan `app` (editor-ai, clip-text-api).
- Reservasi yatim (proses mati sebelum settle): prune (§9) memindahkan `reserved` hari < hari ini
  ke `calls`.

### 4.3 `0003-social-base.sql` (Fase 6, SOS-M1 Release A — tabel ada, fitur mati)

```sql
CREATE TABLE social_connections (
  id                     TEXT    PRIMARY KEY CHECK (length(id) = 36),
  owner_id               TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider               TEXT    NOT NULL CHECK (length(provider) BETWEEN 2 AND 24),   -- youtube|tiktok|instagram (JS)
  external_account_id    TEXT    NOT NULL CHECK (length(external_account_id) BETWEEN 1 AND 128), -- channelId / open_id / ig user id
  handle                 TEXT    NOT NULL CHECK (length(handle) BETWEEN 1 AND 100),    -- @kanal, ditampilkan
  display_name           TEXT    NOT NULL DEFAULT '' CHECK (length(display_name) <= 100),
  avatar_url             TEXT    NULL CHECK (avatar_url IS NULL OR (length(avatar_url) <= 1000 AND avatar_url GLOB 'https://*')),
  scopes_json            TEXT    NOT NULL CHECK (json_valid(scopes_json) AND json_type(scopes_json) = 'array'
                                                 AND length(scopes_json) <= 2048),        -- scope yang benar-benar diberikan
  status                 TEXT    NOT NULL CHECK (length(status) BETWEEN 2 AND 24),     -- active|reauth_required (JS, 03 §7)
  access_box             TEXT    NULL,     -- sealing v2 purpose oauth-token, AAD account:<id>\0access
  refresh_box            TEXT    NULL,     -- AAD account:<id>\0refresh; NULL untuk instagram
  access_expires_at      INTEGER NULL,
  refresh_expires_at     INTEGER NULL,
  token_generation       INTEGER NOT NULL DEFAULT 0 CHECK (token_generation >= 0),     -- CAS refresh dua fase (03 §7.3)
  refresh_lease_token    TEXT    NULL CHECK (refresh_lease_token IS NULL OR length(refresh_lease_token) = 36),
  refresh_lease_until    INTEGER NULL,
  last_error_code        TEXT    NULL CHECK (last_error_code IS NULL OR length(last_error_code) <= 64),
  connected_at           INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  CHECK ((refresh_lease_token IS NULL) = (refresh_lease_until IS NULL))
) STRICT;
CREATE UNIQUE INDEX social_connections_account ON social_connections(owner_id, provider, external_account_id);
CREATE INDEX        social_connections_expiry  ON social_connections(access_expires_at) WHERE status = 'active';
CREATE INDEX        social_connections_owner   ON social_connections(owner_id, provider);

CREATE TABLE oauth_pending (
  state_sha256      TEXT    PRIMARY KEY CHECK (length(state_sha256) = 64),     -- state mentah hanya di URL
  owner_id          TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_sha256    TEXT    NOT NULL CHECK (length(session_sha256) = 64),      -- sha256(sid) sesi yang memulai
  provider          TEXT    NOT NULL CHECK (length(provider) BETWEEN 2 AND 24),
  pkce_verifier_box TEXT    NULL,     -- PKCE code_verifier, sealing v2 oauth-token, AAD pending:<state_sha256>
  reconnect_id      TEXT    NULL CHECK (reconnect_id IS NULL OR length(reconnect_id) = 36),  -- tanpa FK: koneksi bisa sudah dihapus
  return_path       TEXT    NOT NULL DEFAULT '/sosial?tab=akun'
                            CHECK (length(return_path) <= 200 AND return_path GLOB '/*' AND return_path NOT GLOB '//*'),
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,                       -- created_at + 10 menit
  CHECK (expires_at > created_at)
) STRICT;
CREATE INDEX oauth_pending_owner   ON oauth_pending(owner_id, expires_at);
CREATE INDEX oauth_pending_expires ON oauth_pending(expires_at);

CREATE TABLE social_quota (
  provider       TEXT    NOT NULL CHECK (length(provider) BETWEEN 2 AND 24),
  bucket         TEXT    NOT NULL CHECK (bucket = 'instance' OR length(bucket) = 36),  -- 'instance' | users.id | social_connections.id
  window_key     TEXT    NOT NULL CHECK (length(window_key) BETWEEN 10 AND 64),     -- '2026-10-24@America/Los_Angeles' | '2026-10-24T13@UTC'
  purpose        TEXT    NOT NULL CHECK (purpose IN ('upload','metrics')),          -- set tertutup
  units_used     INTEGER NOT NULL DEFAULT 0 CHECK (units_used >= 0),
  units_reserved INTEGER NOT NULL DEFAULT 0 CHECK (units_reserved >= 0),
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (provider, bucket, window_key, purpose)
) STRICT, WITHOUT ROWID;
```
- **Putus akun** (`DELETE /api/social/connections/:connectionId`, urutan langkah milik 03 §7.4): baris
  `social_connections` **dihapus** (purge, kebijakan Meta/Google). Kolom FK yang merujuknya
  (`posts.connection_id`, `publish_runs.connection_id`) `ON DELETE SET NULL`; run menyimpan
  `connection_label` untuk riwayat. Sebelum `DELETE`, dalam `tx` yang sama: snapshot
  `metric_snapshots` `source='api'` posting koneksi itu, `metric_horizons` dan `metric_refresh`-nya,
  serta baris `social_quota` bucket koneksi itu dihapus. `posts` tetap (riwayat Terbit, tanpa angka
  API); snapshot CSV/manual tidak disentuh. Tidak ada status `revoked`.
- `oauth_pending` dikonsumsi dengan `DELETE … RETURNING` di satu `tx` (tidak ada kolom
  `consumed_at`): baris yang dikembalikan wajib belum kedaluwarsa, `owner_id` = user sesi,
  `session_sha256` = sesi ini (03 §7.1).
- `social_quota`: tidak ada `NULL` di PRIMARY KEY, jadi upsert
  `ON CONFLICT(provider,bucket,window_key,purpose) DO UPDATE` aman. Pemakaian bucket/jendela
  (YouTube harian Pasifik instans + jatah per user, `purpose` unggah vs metrik, Instagram per
  koneksi) milik 03 §10.2–§10.3. Pola: `units_reserved += n` di `tx` sebelum I/O; sesudah I/O
  `units_reserved -= n, units_used += terpakai`.
- Kredensial app platform (client id/secret) **bukan** di DB: file tersegel
  `/control/settings/social-apps.json` (purpose `social-app`, scope `instance`).

### 4.4 `0004-download-ledger.sql` (Fase 7, FETCH-M7)

```sql
CREATE TABLE download_ledger (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id      TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id        TEXT    NOT NULL CHECK (length(job_id) = 36),
  platform      TEXT    NOT NULL CHECK (length(platform) BETWEEN 2 AND 16),         -- youtube|twitch|kick (JS)
  source_key    TEXT    NOT NULL CHECK (length(source_key) BETWEEN 3 AND 160),      -- 'platform:mediaId'
  phase         TEXT    NOT NULL CHECK (length(phase) BETWEEN 3 AND 16),            -- preflight|audio|video (JS)
  cache         TEXT    NOT NULL CHECK (length(cache) BETWEEN 2 AND 16),            -- off|hit|miss|stored|skipped (JS, 04 §B9)
  cache_scope   TEXT    NOT NULL CHECK (cache_scope IN ('umum','pemilik','none')),
  proxy         INTEGER NOT NULL DEFAULT 0 CHECK (proxy IN (0,1)),                   -- hanya flag, tidak pernah URL proxy
  bytes         INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  media_seconds INTEGER NULL CHECK (media_seconds IS NULL OR media_seconds >= 0),
  outcome       TEXT    NULL CHECK (outcome IS NULL OR outcome IN ('ok','failed','cancelled')),
  error_code    TEXT    NULL CHECK (error_code IS NULL OR length(error_code) <= 64), -- download_*/source_* (04 §B13)
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER NULL,
  CHECK (finished_at IS NULL OR finished_at >= started_at),
  CHECK ((outcome IS NULL) = (finished_at IS NULL)),
  CHECK (error_code IS NULL OR outcome IN ('failed','cancelled'))
) STRICT;
CREATE INDEX download_ledger_owner  ON download_ledger(owner_id, started_at);
CREATE INDEX download_ledger_job    ON download_ledger(job_id);
CREATE INDEX download_ledger_source ON download_ledger(source_key, started_at);
CREATE INDEX download_ledger_open   ON download_ledger(started_at) WHERE finished_at IS NULL;
```
Penulis: `primary-worker` (unduhan berjalan di bawah `runFencedProcess`, `web/scripts/run-job.mjs:426`):
baris dibuka saat fase mulai, ditutup di akhir fase; gagal tulis ledger hanya log, **tidak**
menggagalkan job. `app` hanya membaca (`/admin/job`, Tentang sistem). Baris terbuka > 24 jam
ditutup `outcome='failed'`, `error_code='abandoned'` oleh prune.

### 4.5 `0005-posts.sql` (Fase 8, SOS-M3a)

`posts` adalah **registry bersama** sosmed dan feedback (kontrak §5.61): satu baris = satu klip
yang tampil di satu platform, dari jalur mana pun. Baris `posts` origin `publish` dibuat **saat run
menjadi `published`** (atau saat pengguna menandai `maybe_sent` "Sudah terbit"); origin
`csv`/`manual`/`agent` dibuat oleh impor/isian. `publish_runs` hanya lifecycle unggahan dari
Potongin; satu run menghasilkan paling banyak satu `posts`. Run gagal tidak meninggalkan baris
`posts`; "Coba lagi" = run baru. Feedback hanya memiliki metrik (§4.7).

```sql
CREATE TABLE posts (
  id                    TEXT    PRIMARY KEY CHECK (length(id) = 36),
  owner_id              TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id                TEXT    NOT NULL CHECK (length(job_id) = 36),
  clip_id               TEXT    NOT NULL CHECK (length(clip_id) BETWEEN 1 AND 80),   -- clip_[0-9a-f]{24} atau id turunan
  clip_kind             TEXT    NOT NULL DEFAULT 'pipeline' CHECK (clip_kind IN ('pipeline','derived')),
  provider              TEXT    NOT NULL CHECK (length(provider) BETWEEN 2 AND 24),
  connection_id         TEXT    NULL REFERENCES social_connections(id) ON DELETE SET NULL,  -- NULL untuk csv/manual atau setelah putus
  origin                TEXT    NOT NULL CHECK (length(origin) BETWEEN 3 AND 16),   -- publish|csv|manual|agent (JS)
  external_id           TEXT    NULL CHECK (external_id IS NULL OR length(external_id) BETWEEN 1 AND 128),
  url                   TEXT    NULL CHECK (url IS NULL OR (length(url) <= 500 AND url GLOB 'https://*')),
  posted_at             INTEGER NULL,                                              -- waktu terbit di platform
  selection_keys_json   TEXT    NULL CHECK (selection_keys_json IS NULL OR (json_valid(selection_keys_json)
                                           AND length(selection_keys_json) <= 1024)),     -- 03 §13.2; NULL = tidak masuk profil
  posted_features_json  TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(posted_features_json)
                                           AND length(posted_features_json) <= 2048),
  packaging_json        TEXT    NOT NULL CHECK (json_valid(packaging_json) AND length(packaging_json) <= 8192),
  edit_class            TEXT    NOT NULL DEFAULT 'unknown' CHECK (edit_class IN ('none','light','far','unknown')),  -- 03 §13.3
  excluded_reason       TEXT    NULL CHECK (excluded_reason IS NULL OR length(excluded_reason) <= 32),  -- edited_far|derived|manual_exclude (JS)
  error_code            TEXT    NULL CHECK (error_code IS NULL OR length(error_code) <= 64),  -- social_processing_rejected|social_remote_missing (03 §8)
  source_key            TEXT    NULL CHECK (source_key IS NULL OR length(source_key) <= 160),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  deleted_at            INTEGER NULL,      -- soft delete (hanya origin csv/manual, 03 §14)
  CHECK (clip_kind = 'pipeline' OR (selection_keys_json IS NULL AND excluded_reason = 'derived'))
) STRICT;
CREATE UNIQUE INDEX posts_external ON posts(owner_id, provider, external_id)
  WHERE external_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX posts_clip   ON posts(owner_id, job_id, clip_id);
CREATE INDEX posts_owner  ON posts(owner_id, posted_at) WHERE deleted_at IS NULL;
CREATE INDEX posts_conn   ON posts(connection_id) WHERE connection_id IS NOT NULL;

CREATE TABLE publish_runs (
  id                TEXT    PRIMARY KEY CHECK (length(id) = 36),
  owner_id          TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id          TEXT    NOT NULL CHECK (length(group_id) = 36),        -- run dari satu submit drawer
  idempotency_key   TEXT    NOT NULL CHECK (length(idempotency_key) = 36), -- header Idempotency-Key
  request_sha256    TEXT    NOT NULL CHECK (length(request_sha256) = 64),  -- body kanonik; key sama + body beda → 409 (03 §6.6)
  connection_id     TEXT    NULL REFERENCES social_connections(id) ON DELETE SET NULL,  -- NULL setelah putus akun
  connection_label  TEXT    NOT NULL CHECK (length(connection_label) BETWEEN 1 AND 100), -- handle saat run dibuat
  provider          TEXT    NOT NULL CHECK (length(provider) BETWEEN 2 AND 24),
  job_id            TEXT    NOT NULL CHECK (length(job_id) = 36),
  clip_id           TEXT    NOT NULL CHECK (length(clip_id) BETWEEN 1 AND 80),
  render_id         TEXT    NOT NULL CHECK (length(render_id) = 36),       -- ekspor v3 completed; tidak ada media `auto` (03 §6.7)
  pin_path          TEXT    NULL CHECK (pin_path IS NULL OR (pin_path GLOB '*.mp4' AND length(pin_path) <= 80)),  -- relatif /data/social/media; NULL setelah sweep
  pin_bytes         INTEGER NOT NULL CHECK (pin_bytes > 0),
  pin_sha256        TEXT    NOT NULL CHECK (length(pin_sha256) = 64),
  duration_ms       INTEGER NOT NULL CHECK (duration_ms > 0),              -- dari mvhd (03 §6.7)
  text_json         TEXT    NOT NULL CHECK (json_valid(text_json) AND length(text_json) <= 8192),     -- {title, caption, hashtags[]}
  options_json      TEXT    NOT NULL CHECK (json_valid(options_json) AND length(options_json) <= 2048), -- privasi dsb. per provider
  scheduled_at      INTEGER NOT NULL,                                       -- UTC; "Terbitkan sekarang" = waktu create
  scheduled_tz      TEXT    NOT NULL CHECK (length(scheduled_tz) BETWEEN 3 AND 64),  -- IANA asal (Q8, 07 §13.2)
  state             TEXT    NOT NULL CHECK (length(state) BETWEEN 6 AND 16),        -- set di 03 §6.1 (JS)
  hold              TEXT    NULL CHECK (hold IS NULL OR length(hold) BETWEEN 4 AND 16),  -- reauth|quota|rate (JS); NULL = tidak ditahan
  next_attempt_at   INTEGER NOT NULL,                                       -- = scheduled_at, digeser backoff/defer
  attempts          INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  defers            INTEGER NOT NULL DEFAULT 0 CHECK (defers >= 0),
  fence             INTEGER NOT NULL DEFAULT 0 CHECK (fence >= 0),          -- naik tiap klaim
  lease_token       TEXT    NULL CHECK (lease_token IS NULL OR length(lease_token) = 36),
  lease_until       INTEGER NULL,
  checkpoint_json   TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(checkpoint_json) AND length(checkpoint_json) <= 4096), -- 03 §6.3, tanpa URL sesi
  upload_box        TEXT    NULL,     -- session URI / upload_url tersegel, AAD run:<id>\0upload
  remote_id         TEXT    NULL CHECK (remote_id IS NULL OR length(remote_id) <= 128),  -- publish_id / container id / videoId
  post_id           TEXT    NULL UNIQUE REFERENCES posts(id) ON DELETE SET NULL,
  error_code        TEXT    NULL CHECK (error_code IS NULL OR length(error_code) <= 64),
  error_params_json TEXT    NULL CHECK (error_params_json IS NULL OR (json_valid(error_params_json) AND length(error_params_json) <= 1024)),
  error_detail      TEXT    NULL CHECK (error_detail IS NULL OR length(error_detail) <= 500),  -- sudah diredaksi
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  finished_at       INTEGER NULL,
  pin_released_at   INTEGER NULL,
  CHECK ((lease_token IS NULL) = (lease_until IS NULL))
) STRICT;
CREATE UNIQUE INDEX publish_runs_idem   ON publish_runs(owner_id, idempotency_key, connection_label, provider);
CREATE INDEX        publish_runs_due    ON publish_runs(next_attempt_at) WHERE state = 'scheduled' AND hold IS NULL;
CREATE INDEX        publish_runs_leased ON publish_runs(lease_until) WHERE lease_token IS NOT NULL;
CREATE INDEX        publish_runs_owner  ON publish_runs(owner_id, state, scheduled_at);
CREATE INDEX        publish_runs_clip   ON publish_runs(owner_id, job_id, clip_id);
CREATE INDEX        publish_runs_conn   ON publish_runs(connection_id) WHERE connection_id IS NOT NULL;
CREATE INDEX        publish_runs_pin    ON publish_runs(finished_at) WHERE pin_released_at IS NULL AND finished_at IS NOT NULL;

INSERT OR IGNORE INTO instance_settings(key, value_json, updated_at) VALUES
  ('social_cap_active',         '100', 0),
  ('social_cap_hourly',         '20',  0),
  ('social_yt_daily_overrides', '{}',  0);
```

Catatan `0005`:
- `posts.packaging_json` = hasil `snapshotClipPackaging(job, clip, source)` (ekspor baru
  `web/lib/jobs.mjs`) saat posting dibuat: judul, deskripsi, hashtag, durasi, `layout_summary`.
  Posting yang sudah terbit tetap valid setelah job/klip turunan dihapus (snapshot).
- `selection_keys_json`, `posted_features_json`, `edit_class`, `excluded_reason` dihitung
  **server** di `createPost()` (`web/lib/post-registry.mjs`, baru) dengan aturan 03 §13.2–§13.3.
  Klip turunan dideteksi lewat `listJobClips(job).derived` (06 §11.6) → `clip_kind='derived'`,
  `selection_keys_json=NULL`, `excluded_reason='derived'` (dijaga `CHECK`), tidak masuk profil.
- `publish_runs_idem` memakai `connection_label`+`provider`, bukan `connection_id`, karena
  `connection_id` bisa menjadi `NULL` setelah putus akun; urutan pencarian idempotensi milik
  03 §6.6.
- **State machine `publish_runs`** (nilai `state`/`hold`, transisi T1–T12, klaim, lease, defer,
  `maybe_sent`) milik 03 §6.1–§6.4. Skema hanya menjamin: kolom `state`/`hold` tanpa
  `CHECK … IN` (state baru tetap aditif; konstanta beku `RUN_STATES`, `RUN_HOLDS` di
  `web/lib/social/store.mjs`, baru), lease berpasangan (`CHECK`), `post_id UNIQUE`. Setiap
  transisi = `UPDATE … WHERE id=? AND state IN (…) [AND fence=? AND lease_token=?]` dengan cek
  `changes === 1`. Tidak ada I/O jaringan di dalam `tx`.
- Transisi ke `published` dalam satu `tx`: insert `posts` (origin `publish`, `connection_id`,
  `external_id`, `url`, `posted_at`) → set `publish_runs.post_id`, `state='published'`,
  `finished_at`, lease kosong.
- Cap per user (`social_cap_active`, `social_cap_hourly`; definisi "run aktif" dan "per jam
  jadwal" di 03 §10.1) diperiksa di `tx` insert memakai indeks `publish_runs_owner`. Arti dan
  pengubahan kunci `social_*` (`admin-reset.mjs --set-setting`) milik 03 §10.1.
- Hapus job → `cancelRunsForJob(ownerId, jobId)` memakai `publish_runs_clip` (03 §6.6).

### 4.6 `0006-user-time-zone.sql` (Fase 8, i18n M7b)

```sql
ALTER TABLE users ADD COLUMN time_zone TEXT NULL
  CHECK (time_zone IS NULL OR (length(time_zone) BETWEEN 3 AND 64 AND time_zone NOT GLOB '*[^A-Za-z0-9/_+-]*'));
```
Nilai divalidasi JS terhadap `Intl.supportedValuesOf('timeZone')` + `"UTC"`. `NULL` → zona
perangkat yang dikirim sekali, lalu `Asia/Jakarta`. API dan perilaku: 07 §13.2–§13.3.

### 4.7 `0007-performance.sql` (Fase 9, FB-M1)

```sql
CREATE TABLE metric_imports (
  id          TEXT    PRIMARY KEY CHECK (length(id) = 36),
  owner_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename    TEXT    NOT NULL CHECK (length(filename) BETWEEN 1 AND 200),
  profile     TEXT    NOT NULL CHECK (length(profile) BETWEEN 1 AND 40),    -- id profil CSV terdeteksi (03 §14.1)
  rows_total  INTEGER NOT NULL CHECK (rows_total BETWEEN 0 AND 5000),
  state       TEXT    NOT NULL CHECK (length(state) BETWEEN 5 AND 16),      -- preview|committed|discarded (JS)
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL                    -- preview dibuang 7 hari setelah dibuat
) STRICT;
CREATE INDEX metric_imports_owner ON metric_imports(owner_id, created_at);

CREATE TABLE metric_import_rows (
  import_id     TEXT    NOT NULL REFERENCES metric_imports(id) ON DELETE CASCADE,
  row_no        INTEGER NOT NULL CHECK (row_no BETWEEN 1 AND 5000),
  provider      TEXT    NULL CHECK (provider IS NULL OR length(provider) BETWEEN 2 AND 24),
  url           TEXT    NULL CHECK (url IS NULL OR length(url) <= 500),
  external_id   TEXT    NULL CHECK (external_id IS NULL OR length(external_id) <= 128),
  posted_at     INTEGER NULL,
  captured_at   INTEGER NOT NULL,
  values_json   TEXT    NOT NULL CHECK (json_valid(values_json) AND length(values_json) <= 512),  -- {views,likes,comments,shares,saves}
  match_post_id TEXT    NULL CHECK (match_post_id IS NULL OR length(match_post_id) = 36),
  match_job_id  TEXT    NULL CHECK (match_job_id IS NULL OR length(match_job_id) = 36),
  match_clip_id TEXT    NULL CHECK (match_clip_id IS NULL OR length(match_clip_id) <= 80),
  status        TEXT    NOT NULL CHECK (length(status) BETWEEN 5 AND 16),   -- matched|unmatched|invalid|skipped (JS)
  problem       TEXT    NULL CHECK (problem IS NULL OR length(problem) <= 64),  -- kode 03 §14.4
  PRIMARY KEY (import_id, row_no)
) STRICT, WITHOUT ROWID;

CREATE TABLE metric_snapshots (                 -- append-only; UPDATE hanya ciut dan soft delete (trigger)
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id         TEXT    NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  owner_id        TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source          TEXT    NOT NULL CHECK (length(source) BETWEEN 3 AND 16),   -- api|csv|manual|agent (JS)
  captured_at     INTEGER NOT NULL,                                          -- kapan angka itu berlaku
  age_hours       INTEGER NOT NULL CHECK (age_hours >= 0),                   -- captured_at − posts.posted_at
  views           INTEGER NULL CHECK (views    IS NULL OR views    >= 0),
  likes           INTEGER NULL CHECK (likes    IS NULL OR likes    >= 0),
  comments        INTEGER NULL CHECK (comments IS NULL OR comments >= 0),
  shares          INTEGER NULL CHECK (shares   IS NULL OR shares   >= 0),
  saves           INTEGER NULL CHECK (saves    IS NULL OR saves    >= 0),
  import_id       TEXT    NULL CHECK (import_id IS NULL OR length(import_id) = 36),  -- metric_imports.id; tanpa FK (impor preview dibuang prune)
  collapsed_at    INTEGER NULL,      -- nilai mentah dibuang (aturan 30 hari YouTube, 03 §10.5)
  aggregate_json  TEXT    NULL CHECK (aggregate_json IS NULL OR (json_valid(aggregate_json) AND length(aggregate_json) <= 512)),  -- {"relViews":1.42}
  created_at      INTEGER NOT NULL,
  deleted_at      INTEGER NULL,      -- soft delete satu snapshot oleh pengguna; disaring di semua query
  CHECK (collapsed_at IS NULL OR (views IS NULL AND likes IS NULL AND comments IS NULL
                                  AND shares IS NULL AND saves IS NULL AND aggregate_json IS NOT NULL)),
  CHECK (collapsed_at IS NULL OR source = 'api')
) STRICT;
CREATE INDEX metric_snapshots_post     ON metric_snapshots(post_id, captured_at);
CREATE INDEX metric_snapshots_owner    ON metric_snapshots(owner_id, captured_at);
CREATE INDEX metric_snapshots_collapse ON metric_snapshots(captured_at) WHERE source = 'api' AND collapsed_at IS NULL;
CREATE INDEX metric_snapshots_import   ON metric_snapshots(import_id) WHERE import_id IS NOT NULL;
CREATE TRIGGER metric_snapshots_append_only
  BEFORE UPDATE OF post_id, owner_id, source, captured_at, age_hours, import_id, created_at ON metric_snapshots
BEGIN SELECT RAISE(ABORT, 'metric_append_only'); END;
CREATE TRIGGER metric_snapshots_collapse_only
  BEFORE UPDATE OF views, likes, comments, shares, saves ON metric_snapshots
  WHEN NEW.collapsed_at IS NULL
BEGIN SELECT RAISE(ABORT, 'metric_append_only'); END;

CREATE TABLE metric_horizons (                  -- cache; boleh DELETE + hitung ulang kapan saja (03 §10.6)
  post_id     TEXT    NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  owner_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  horizon     TEXT    NOT NULL CHECK (horizon IN ('1d','7d','30d')),        -- = nilai POTONGIN_PERF_HORIZON
  views       REAL    NULL,
  rel_views   REAL    NULL,
  quality     TEXT    NOT NULL CHECK (quality IN ('exact','interpolated','missing')),
  rules_id    TEXT    NOT NULL CHECK (length(rules_id) BETWEEN 3 AND 32),    -- 'rules.v1' (resources/performance/rules.v1.json)
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, horizon)
) STRICT, WITHOUT ROWID;
CREATE INDEX metric_horizons_owner ON metric_horizons(owner_id, horizon);

CREATE TABLE metric_refresh (                   -- due-list tarik ulang metrik API per posting (03 §10.4)
  post_id     TEXT    PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  owner_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  next_due_at INTEGER NOT NULL,
  last_ok_at  INTEGER NULL,
  failures    INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
  stopped     INTEGER NOT NULL DEFAULT 0 CHECK (stopped IN (0,1))
) STRICT;
CREATE INDEX metric_refresh_due ON metric_refresh(stopped, next_due_at);

ALTER TABLE users ADD COLUMN perf_use_in_selection INTEGER NOT NULL DEFAULT 0
  CHECK (perf_use_in_selection IN (0,1));
```
- `metric_snapshots` append-only. Tulis yang sah setelah insert: (a) **ciut** (set
  `collapsed_at`, `aggregate_json`, nilai mentah `NULL`) oleh `web/lib/social/retention.mjs`
  (baru), aturan di 03 §10.5; (b) **soft delete** satu snapshot (`deleted_at`) dari UI; (c) **hard
  DELETE** saat putus akun (snapshot `api` posting koneksi itu, §4.3), "Hapus data performa"
  (semua milik user, audit `performance.deleted`), atau cascade hapus user. Snapshot
  `csv`/`manual`/`agent` tidak pernah dihapus otomatis.
- `import_id` sengaja tanpa FK: `ON DELETE SET NULL` akan menulis kolom yang dikunci trigger
  append-only; impor `committed` tidak pernah dihapus prune (§9), jadi rujukan tetap hidup.
- `metric_horizons` cache yang bisa dibangun ulang; aturan exact/interpolated/missing dan
  `rel_views` milik 03 §10.6.
- `users.perf_use_in_selection` = saklar "Pakai di pemilihan klip" (05 §6.7, 03 §13.6);
  tidak ada tabel `performance_settings`.
- Kunci join metrik `(owner_id, job_id, clip_id)` lewat `posts`.
- Profil performa tidak punya tabel: dihitung dari `posts` + `metric_horizons` (03 §13.4).
- Data privat per user (Q11 default): tidak ada query lintas `owner_id` di route anggota maupun
  admin. Tes `web/tests/db-owner-scope.test.mjs` (baru) mem-parse SQL di `web/lib/social/*`,
  `web/lib/post-registry.mjs`, `web/lib/performance*.mjs` dan gagal bila query tabel ber-`owner_id`
  tidak memuat `owner_id = ?` (kecuali daftar putih: loop worker dan prune).

---

## 5. Pemisahan volume `potongin_control`

### 5.1 Perubahan `compose.yaml`

```yaml
services:
  app:
    environment:
      POTONGIN_DB_PATH: /control/potongin.sqlite
      POTONGIN_SETTINGS_DIR: /control/settings          # dulu /data/settings
      POTONGIN_SETTINGS_SECRET: ${POTONGIN_SETTINGS_SECRET:?POTONGIN_SETTINGS_SECRET is required}
      NODE_OPTIONS: --disable-warning=ExperimentalWarning   # hanya bila MU-M0 membuktikan perlu (§8.3)
    volumes:
      - clipper_data:/data
      - potongin_control:/control
  primary-worker:
    environment: { POTONGIN_DB_PATH: …, POTONGIN_SETTINGS_DIR: /control/settings, POTONGIN_SETTINGS_SECRET: … }
    volumes: [clipper_data:/data, potongin_control:/control]
  render-worker:
    volumes: [clipper_data:/data]                       # TIDAK berubah, TANPA /control
  social-worker:                                         # Fase 6 R1
    volumes:
      - type: volume
        source: clipper_data
        target: /data/social
        volume: { subpath: social }                     # hanya pin media, tidak melihat /data/jobs
      - potongin_control:/control
volumes:
  clipper_data:
  potongin_control:
```
- `potongin_control` adalah volume bernama biasa (bukan `volume.subpath`). Satu-satunya
  `volume.subpath` adalah mount `social-worker` (Fase 6 R1, sama dengan 03 §4.4 dan §6.8): butuh
  Docker Compose ≥ 2.23 dan Docker Engine ≥ 26. `deploy/production.sh` memeriksa
  `docker compose version --short` dan `docker version --format '{{.Server.Version}}'` sebelum R1
  dan berhenti dengan pesan jelas bila kurang. Direktori `/data/social/media` dibuat `app` (0700,
  uid node) sebelum service R1 dinyalakan, karena subpath yang belum ada membuat container gagal
  start.
- `POTONGIN_SETTINGS_SECRET` berubah dari `:-` (opsional, `compose.yaml` hari ini) menjadi `:?`
  (wajib). Runbook: salin nilai `APP_SESSION_SECRET` ke sana **sebelum** deploy Fase 4.
- `Dockerfile` baris 83 diganti:
  `RUN mkdir -p /data/jobs /control/settings /control/backups && chown -R node:node /data /control && chmod 700 /control /control/settings /control/backups`.
  Volume bernama yang masih kosong diisi Docker dari isi image saat mount pertama, sehingga
  pemilik/mode benar sejak awal.
- `deploy/production.sh` `verify_runtime_identity()` (baris 99) diperluas: mount `/control` app
  = `${COMPOSE_PROJECT}_potongin_control`, render-worker **tidak** punya mount `/control`.

### 5.2 Pemindahan `/data/settings` → `/control/settings`

**[Penyimpangan]** Roadmap induk §2.2-A menyebut "symlink, atau kedua path dibaca". Dipilih
**salin + penanda + beku**: symlink `/data/settings → /control/settings` menunjuk ke volume lain
(rusak di render-worker dan di image lama dengan compose lama), dan membaca dua path membuat dua
sumber kebenaran untuk kotak tersegel. Salinan sekali jalan memberi satu sumber dan image lama tetap
punya nilai beku untuk rollback.

`web/lib/db/settings-move.mjs` dipanggil `scripts/start-app.mjs` **sebelum** migrasi, di bawah
lock direktori `/control/.settings-move.lock` (`mkdir` atomik + pemilik PID + stale 5 menit, pola
yang sama dengan `withSettingsLock` di `web/lib/trend-context.mjs:824`). `meta.settings_migrated_at`
ditulis di langkah boot berikutnya, setelah migrasi:

```
1. Bila /control/settings/.migrated-from-data ada → selesai.
2. Bila /data/settings tidak ada atau kosong → tulis penanda {"from":null}, selesai.
3. Salin pohon /data/settings → /control/settings.tmp-<pid> (file regular & dir saja; symlink
   ditolak; mode 0600/0700 dipertahankan), fsync, lalu rename ke /control/settings
   (bila /control/settings sudah ada tapi tanpa penanda: salin per file yang belum ada).
4. Bandingkan sha256 tiap file sumber vs tujuan; beda → abort, app tidak start (pesan log).
5. Tulis penanda {"from":"/data/settings","at":…,"files":N,"sha256":<sha daftar>}.
6. /data/settings TIDAK dihapus di rilis ini (rollback ke compose lama tetap membaca nilai lama).
```

Image lama + compose baru tetap jalan: image lama membaca `POTONGIN_SETTINGS_DIR` dari env (yang
kini `/control/settings`) dan me-mount `/control` karena compose baru. Image lama + compose lama
membaca `/data/settings` yang beku (perubahan setting setelah Fase 4 hilang; dicatat di runbook).

**Rollback setelah purge:** image pra-Fase 4 hanya boleh dijalankan dengan compose baru
(`POTONGIN_SETTINGS_DIR=/control/settings`); dengan compose lama ia tidak menemukan setting. Ini
dicatat di matriks rollback (08 §9.10) dan diuji `tests/test_deploy_guard.py`.

**Purge salinan lama** (wajib sebelum undangan pertama, checklist Fase 6):
`node scripts/admin-reset.mjs --purge-legacy-settings` → cek penanda, cek sha, hapus
`/data/settings`. Setelah itu render-worker tidak lagi melihat kotak tersegel apa pun di `/data`.
Audit `settings.instance_changed` dengan `{"keys":["legacy_settings_purged"]}`;
`meta.legacy_settings_purged_at` diisi. Exit: 0 sukses; 2 penanda tidak ada; 3 sha berbeda
(tidak menghapus apa pun).

### 5.3 Settings per user

`POTONGIN_SETTINGS_DIR/users/<userId>/` (0700) memakai nama file yang sama dengan root
(`llm-settings.json` dari `web/lib/llm-settings.mjs:50`, `transcription.json`, `default-logo/`,
`default-watermark.json`) plus `prefs.json` (preferensi non-rahasia; **bukan** locale/zona, X7).
Root = setting instans (dibaca image rollback). Fungsi modul setting menerima argumen
`scope: {kind:'instance'} | {kind:'user', userId}`; scope user memakai sealing v2 dengan scope
`userId`. `youtube-cookies.json` tetap di root (cookie global admin, Q4 default).
`trend-context.json` tetap di root (tren instans-wide).

---

## 6. Perubahan `job.json` dan file antrean

### 6.1 Field baru `job.json`

```jsonc
{
  "id": "6f1c…", "status": "queued", "progress": 0,
  "createdAt": "2026-…Z", "updatedAt": "2026-…Z",
  "source": { … }, "sourcePath": "…", "options": { … }, "clips": [],
  "queue": { "version": 1, "attempts": 0, "firstClaimedAt": "2026-…Z" },  // firstClaimedAt baru
  "ownerId": "0b6c2f1e-…-…",          // baru: users.id, UUID v4
  "fairnessKey": "fk1_<hash-buram>"   // baru: kunci buram untuk Python
}
```

| Field | Tipe | Ditulis oleh | Kapan | Aturan |
|---|---|---|---|---|
| `ownerId` | UUID v4 | `web/app/api/jobs/route.js` (rekaman job baris 323), `failedAdmissionRecord` (`web/lib/primary-job-queue.mjs:325`; signature menjadi `(id, code, now, owner)` dengan `owner = {ownerId, fairnessKey}` dari reservasi v3, atau tanpa field pemilik untuk reservasi v2 → pemilik bootstrap), ingest/agen bila membuat job | saat job dibuat | tidak berubah kecuali transfer admin (di bawah queue lock, audit `job.transferred`) |
| `fairnessKey` | `^fk1_[0-9a-f]{16}$` | penulis yang sama | saat dibuat dan saat transfer | `"fk1_" + hex(HMAC-SHA256(K_fair, ownerId))[0..16]`, `K_fair = HKDF-SHA256(POTONGIN_SETTINGS_SECRET, salt "potongin", info "fairness-v1")` |
| `queue.firstClaimedAt` | ISO UTC ms | `primary-job-queue.mjs` | klaim pertama | dipertahankan sampai status terminal; dasar `lastServedAt` per owner |
| `limits.maxSourceSeconds` | integer > 0 | `web/app/api/jobs/route.js` | saat dibuat (Fase 6, MU-M4b) | batas durasi sumber efektif pemilik saat job dibuat; aturan nilai 02 §11.2, 04 §B4 |
| `fetch` | objek | `primary-worker` (unduhan) | Fase 7 (FETCH-M1+) | status unduhan/cache untuk UI; bentuk milik 04 §B (mis. `fetch.cache`), aditif |
| `source.type = "link"` | `{type:"link", platform, url, mediaId}` | `web/app/api/jobs/route.js` | Fase 7, hanya setelah rilis R2 | Twitch/Kick; YouTube tetap `{type:"youtube"}`; pembaca memakai `isLinkSource()` (04 §B3) |

- Job tanpa `ownerId` (semua job sebelum Fase 5) **tidak ditulis ulang**:
  `effectiveOwnerId(job) = job.ownerId ?? meta.bootstrap_owner_id`
  (`web/lib/job-ownership.mjs`, baru). Opsional: `web/scripts/multiuser-migrate.mjs --dry-run|--apply`
  (baru) mengisi `ownerId`+`fairnessKey` untuk job terminal di bawah queue lock.
- `queue.version` tetap `1`: `validateQueue` (`primary-job-queue.mjs:228-234`) hanya mewajibkan
  `version === 1` dan `attempts`, jadi `firstClaimedAt` aditif dan aman untuk image lama.
- `serializePublicJob` (`web/lib/jobs.mjs`) membuang `ownerId` dan `fairnessKey` dari setiap
  respons; diuji di `web/tests/job-ownership.test.mjs` (baru).
- Python tidak pernah membaca `ownerId`.

### 6.2 `fairnessKey` di render-worker — **[Penyimpangan]**

Roadmap induk §2.2-C menulis `fairnessKey` ke `analysis/render-requests/<id>.json`. Itu **tidak
aditif**: render-request-v3 divalidasi sebagai set kunci persis di dua sisi —
`set(value) != _V3_FIELDS` di `src/ai_clipper/render_queue.py:548` dan konstanta `KEYS` di
`web/lib/clip-renders.mjs:57-66`. Field baru di request akan membuat image lama (rollback) menolak
setiap request baru. Karena itu:

- Kunci dibaca dari **`job.json` `fairnessKey`** (field aditif; pembaca job.json Python seperti
  `render_queue.py:236` tidak memvalidasi set kunci job).
- `src/ai_clipper/render_worker.py`: `run_one` (baris 129–176) hari ini mengambil job pertama
  menurut nama (`_job_directories`, baris 117–127). Diganti dengan:
  ```
  kandidat = job dengan analysis/render-requests/ yang ada (cek yang sama seperti baris 155)
  key(job) = job.json.fairnessKey bila cocok ^fk1_[0-9a-f]{16}$, selain itu "legacy"
             (baca job.json dengan batas MAX_JOB_BYTES 2 MiB; gagal baca → "legacy")
  pilih key dengan last_served[key] terkecil (belum pernah = 0; seri → urut key);
  di dalam key: urut nama job, claim_next(job) seperti sekarang; None → coba job berikut,
  lalu key berikut
  last_served[key] = monotonic() saat klaim berhasil  (in-memory; restart = reset)
  ```
- Kontrak dicatat di CONTRACTS §5.59. Tes `tests/test_render_worker_fairness.py` (baru):
  A punya 10 request, B 1 request belakangan → klaim ke-2 adalah B; job tanpa `fairnessKey` →
  `legacy`; `fairnessKey` rusak → `legacy`; urutan dalam satu key = nama job.

### 6.3 Reservasi admission v3

`.primary-reservations/<id>.json` (`web/lib/primary-job-queue.mjs:16`) mendapat `version: 3` +
`ownerId` untuk admission per owner (MU-M7). Rilis dua langkah: **R1** membaca v2 dan v3, menulis
v2; **R2** menulis v3. Diuji dua arah (`web/tests/primary-job-queue.test.mjs`, diperluas).

### 6.4 File yang tetap file (tidak masuk DB)

| Data | Lokasi | Alasan |
|---|---|---|
| Job, klip, manifest, plan, ekspor | `/data/jobs/<uuid>/…` | sumber kebenaran; dibaca Python |
| Render request | `<job>/analysis/render-requests/<render_id>.json` | protokol render-worker (tidak berubah) |
| Registri klip turunan | `<job>/analysis/derived-clips.json` (Fase 11) | dibaca Python `_clips` dan JS `listJobClips` |
| Shot/camera plan, scan reframe | dir klip | Python |
| Antrean & reservasi | `/data/jobs/.primary-queue.lock`, `.primary-reservations/` | modul antrean bebas DB (policy diinjeksi) |
| Cache media | `/data/cache-unduhan/{umum,k-<fairnessKey>}/…` | Python/yt-dlp membacanya; hard link ke job |
| Pin media sosmed | `/data/social/media/<runId>.mp4` | dibuat `app` saat run dibuat (hard link ekspor `completed`; `EXDEV` → salin + fsync); sweep `social-worker` mengosongkan `publish_runs.pin_path` dan mengisi `pin_released_at`; aturan retensi di 03 §6.7 |
| Setting instans/user (tersegel) | `/control/settings/…` | format yang ada; image rollback membacanya |
| Draft editor | IndexedDB browser (`potongin-editor`), kunci berprefiks namespace buram per user (`web/lib/editor/draft-store.mjs`) | dibersihkan saat logout (X13); rincian 02 §6.2 |
| Preferensi locale | cookie `potongin_locale` + `users.locale` | X7; 07 §9.4 |
| Preferensi pintasan | cookie `potongin_shortcuts` (`on`\|`off`), `web/lib/ui-prefs.mjs` | tanpa DB; 05 §3.9 |

---

## 7. Backup dan restore

### 7.1 `web/scripts/db-backup.mjs` (baru)

```
node scripts/db-backup.mjs [--keep 14] [--reason deploy|daily|manual|pre-restore]
stdout (satu baris per item, di-parse production.sh):
  DB_BACKUP=/control/backups/potongin-20261024T031500Z-deploy.sqlite   | DB_BACKUP=none (DB belum ada)
  SETTINGS_BACKUP=/control/backups/settings-20261024T031500Z-deploy.tar
exit 0 sukses; 2 DB tidak bisa dibuka; 3 integrity_check gagal; 4 ruang kosong kurang; 64 argumen salah
```
Pola nama (regex persis): `^potongin-\d{8}T\d{6}Z-(deploy|daily|manual|pre-restore)\.sqlite$` dan
`^settings-\d{8}T\d{6}Z-(deploy|daily|manual|pre-restore)\.tar$`. Script membuka DB dengan
`openDb({role:"cli", readOnly:true})`, tidak pernah memigrasi, dan bekerja pada skema berapa pun.
1. Cek ruang kosong `/control` ≥ 2 × ukuran DB (+ WAL) + 64 MiB; kalau tidak → exit 4.
2. `VACUUM INTO '<dir>/potongin-<ts>.sqlite.tmp'` (snapshot konsisten dari DB yang hidup; WAL
   tidak perlu disalin). **Salinan mentah file DB yang hidup dilarang.**
3. Buka file tmp read-only → `PRAGMA integrity_check` harus `ok`; `chmod 0600`; fsync; rename.
4. `tar -cf settings-<ts>.tar -C /control settings` (0600), lewat `child_process.execFileSync`
   argv tetap, tanpa shell.
5. Retensi **per reason**: untuk reason yang sedang dijalankan, hapus `potongin-*` dan
   `settings-*` tertua sampai tersisa `--keep` (default 14; `pre-restore` dan `manual` 5)
   masing-masing, sehingga deploy beruntun tidak menggusur cadangan harian. Hanya nama yang cocok
   regex persis di `/control/backups`; symlink dan file lain diabaikan.
6. Tidak pernah mencetak isi, hanya path.

Dipanggil:
- `deploy/production.sh` setelah `wait_drained` dan **sebelum** `up -d` (baris 157), dengan image
  baru (urutan deploy: 02 §10.5; skrip lengkap di 08 §9 wajib mengikuti pemanggilan ini, termasuk
  argumen `--reason`; tidak ada argumen `--out`):
  `IMAGE_TAG="$DEPLOY_SHA" docker compose -p "$COMPOSE_PROJECT" run --rm --no-deps --entrypoint node app scripts/db-backup.mjs --reason deploy`
  → output `DB_BACKUP=…` diteruskan ke log deploy. Gagal → deploy berhenti sebelum container
  diganti. Diuji di `tests/test_deploy_guard.py` (ada, diperluas).
- Harian oleh `app` (timer di `scripts/start-app.mjs`, 03.00 UTC, `--reason daily`).

### 7.2 Yang dicadangkan dan yang tidak

| Data | Dicadangkan oleh | Catatan |
|---|---|---|
| `potongin.sqlite` | `db-backup.mjs` | 14 salinan |
| `/control/settings/**` | `db-backup.mjs` (tar) | kotak tersegel tetap tersegel; butuh `POTONGIN_SETTINGS_SECRET` yang sama |
| `/data/jobs/**`, cache, pin | **tidak** (di luar lingkup, sama seperti hari ini) | `docs/operations/STORAGE_RETENTION.md` |
| `POTONGIN_SETTINGS_SECRET` | pemilik (di luar server) | tanpa secret ini, token sosmed & key LLM tidak terbaca |

### 7.3 `web/scripts/db-restore.mjs` (baru)

```
node scripts/db-restore.mjs --from /control/backups/potongin-<ts>.sqlite [--settings /control/backups/settings-<ts>.tar] --yes
```
Hanya **offline**. Pemeriksaan sebelum menulis apa pun (exit 5 bila gagal):
(a) `process_heartbeats` DB sekarang tidak punya baris dengan `beat_at > now − 30 dtk`;
(b) `PRAGMA wal_checkpoint(TRUNCATE)` dengan `busy_timeout=0` mengembalikan `busy = 0`.
(Catatan: di mode WAL `BEGIN EXCLUSIVE` tidak menolak pembaca lain, jadi tidak dipakai sebagai
bukti.) Exit: 0 sukses; 3 `integrity_check` sumber gagal; 5 DB masih dipakai; 6 `meta.min_image_schema`
di file sumber lebih besar dari nomor migrasi tertinggi yang dikenal image ini; 64 argumen salah. Runbook (`docs/operations/PENGGUNA.md`, baru):
1. `docker compose stop app primary-worker social-worker` (render-worker boleh jalan).
2. `docker compose run --rm --no-deps --entrypoint node app scripts/db-restore.mjs --from … --yes`.
3. Script: `integrity_check` file sumber → salin ke `potongin.sqlite.restore-tmp` (0600) → fsync →
   backup otomatis DB yang sekarang (`--reason pre-restore`) → hapus `-wal`/`-shm` → rename →
   `PRAGMA quick_check` → cetak `RESTORED=<path> SCHEMA=<n>`. Dengan `--settings`: tar diekstrak
   ke `/control/settings.restore-tmp` (anggota tar wajib relatif di bawah `settings/`, tanpa
   symlink/hardlink/`..`), `/control/settings` lama di-rename ke
   `/control/settings.pre-restore-<ts>` (dihapus manual), lalu tmp di-rename ke `/control/settings`.
4. Bila skema backup lebih tua dari image: `start-app.mjs` memigrasi maju saat start (aditif).
5. `docker compose up -d`. Sesi yang dibuat setelah backup hilang (pengguna login ulang).

Drill restore masuk drill lama→baru→lama Fase 6 (MU-M9) dan `web/tests/db-backup.test.mjs` (baru).

---

## 8. Runtime Node 24 dan invalidasi plate/render key

### 8.1 Perubahan (MU-M0, Fase 0)

| File | Sekarang | Menjadi |
|---|---|---|
| `Dockerfile:9` | `ARG NODE_IMAGE=node:20-bookworm-slim@sha256:2cf067cf…` | `node:24-bookworm-slim@sha256:<digest dipin di PR MU-M0>` |
| `.github/workflows/ci-cd.yml:72`, `:177` | `node-version: "20"` | `"24"` |
| `.github/workflows/editor-gates.yml:103` | `node-version: "20"` | `"24"` |
| `.github/workflows/ytdlp-update.yml:57` | `node-version: "20"` | `"24"` |
| `web/package.json` | tanpa `engines` | `"engines": {"node": ">=24 <25"}` |
| `src/ai_clipper/edit_v2/toolchain.py` (stamp, ditulis Dockerfile:74-76) | `--base-image node:20…` | otomatis berubah karena `--base-image "${NODE_IMAGE}"` |
| `docs/editor/evidence/toolchain/record.json` | `base_image` `node:20-bookworm-slim@sha256:2cf067cf…` | dicap ulang lewat `gh workflow run ci-cd.yml --ref <branch> -f suite=toolchain`; isi artifact `toolchain-evidence` disalin ke repo dan di-commit di PR MU-M0 (`docs/editor/OPERASIONAL.md` §3). Tanpa itu job `toolchain-guard` gagal. |

Alasan tambahan: Node 20 sudah EOL (April 2026). `node:sqlite` (DatabaseSync) adalah dasar kontrak
guard sinkron (§2.3). Cadangan bila Q2 dibatalkan: `better-sqlite3` (API sinkron yang sama).

### 8.2 Dampak ke plate key dan render key

`toolchain.json` di-hash ke setiap kunci: `plate_key(... toolchain_sha256=...)`
(`src/ai_clipper/edit_v2/plates.py:66-94`, field `"toolchain"`) dan `render_key`
(`src/ai_clipper/edit_v2/plan.py:454`, memakai `toolchain_sha256` di `plan.py:445`). Base image
tercatat di stamp, jadi **semua** plate key dan render key berubah satu kali.

| Artefak | Akibat | Penanganan |
|---|---|---|
| Sel plate `preview/plates/<key16>-c<k>.mp4` (`plates.py:20`) | tidak cocok lagi; pratinjau membangun sel baru saat klip dibuka → CPU + disk naik sementara | sel lama yatim dibersihkan janitor (`CACHE_DIRS` di `src/ai_clipper/edit_v2/janitor.py:65`) |
| Ekspor editor yang sudah `completed` | file tetap ada dan bisa diunduh; request ekspor **baru** memakai key baru → render ulang untuk klip yang **diedit** | — |
| Klip yang **tidak diedit** | R10 (`src/ai_clipper/edit_v2/render_edit.py:40-48`) memakai file otomatis apa pun versi toolchain-nya → **tanpa render ulang** | dibuktikan di kriteria |
| Klip otomatis pipeline | tidak dirender ulang (job yang sudah selesai tidak diproses lagi) | — |

### 8.3 `node:sqlite` dan stderr

MU-M0 memverifikasi di image Node 24 yang dipin apakah `import "node:sqlite"` mencetak
`ExperimentalWarning`. Aturan apa pun hasilnya:
- Proses yang stderr-nya di-parse proses lain (`web/scripts/render-storage-admission.mjs`, di
  image `/app/scripts/…`, dipanggil render-worker lewat `RENDER_STORAGE_CLI`) **tidak boleh**
  mengimpor `web/lib/db/*` — dijaga
  `web/tests/sqlite-import-boundary.test.mjs` (baru, graf impor statis).
- Bila peringatan muncul: `NODE_OPTIONS=--disable-warning=ExperimentalWarning` hanya di service
  `app`, `primary-worker`, `social-worker`, dan **dibuang** dari env anak (§1.3).
- Tes Fase 0 (`web/tests/node-sqlite-stderr.test.mjs`, baru): spawn `node -e 'import("node:sqlite")'`
  dengan env compose → stderr kosong. `web/lib/db/` belum ada di Fase 0; varian
  `node -e 'import("./lib/db/index.mjs")'` ditambahkan ke tes yang sama di Fase 4.

### 8.4 Kriteria selesai MU-M0

- `ci-cd` dan `editor-gates` (`suite=full`) hijau di Node 24, bukti toolchain P-TIME/P-TXT/P-ENC/
  P-COLOR/P-RT dijalankan ulang lewat `ci-cd.yml -f suite=toolchain` dan `record.json` barunya
  di-commit (§8.1), **ambang tidak diubah**.
- Laporan invalidasi di PR (dan ringkasannya di `docs/editor/OPERASIONAL.md` §3 "Toolchain render
  yang dikunci"): jumlah byte `*/preview/plates` sebelum/sesudah di volume fixture CI; perkiraan
  lonjakan produksi = total byte plate dari job yang dibuka 30 hari terakhir, dibandingkan ruang
  kosong − `JOBS_STORAGE_MIN_FREE_BYTES` (disk produksi 81%).
- Tes R10 di image baru: klip tanpa edit diekspor → hasil `reused="auto_file"`, nol FFmpeg encode.
- stderr bersih (§8.3).

---

## 9. Retensi metadata kontrol (Q6, default, bisa diubah)

`web/lib/db/prune.mjs` (baru), dijalankan `app` sekali per 24 jam (dan saat start), tiap langkah
satu `tx` dengan `LIMIT 5000` per putaran. **Tidak pernah menyentuh `JOBS_ROOT`.**

| Tabel | Dihapus bila |
|---|---|
| `sessions` | `expires_at < now − 30 hari` atau `revoked_at < now − 30 hari` |
| `invites`, `password_resets` | `expires_at < now − 7 hari` (termasuk yang sudah dipakai/dicabut) |
| `oauth_pending` | `expires_at < now − 1 hari` |
| `audit_events` | `at < now − 180 hari` |
| `shared_llm_usage` | `day < hari ini − 90`; sebelum itu, baris `day < hari ini` dengan `reserved > 0` → `calls += reserved, reserved = 0` (reservasi yatim, 02 §9.2) |
| `social_quota` | `updated_at < now − 35 hari` |
| `process_heartbeats` | `beat_at < now − 1 hari` (proses mati tanpa keluar normal) |
| `metric_imports` (+ `metric_import_rows` lewat cascade) | `state IN ('preview','discarded') AND expires_at < now` |
| `metric_snapshots` (`deleted_at` terisi) | `deleted_at < now − 30 hari` (hard delete setelah masa urung) |
| `social_connections` | **tidak di-prune**; hanya hilang lewat putus akun (§4.3) atau cascade hapus user |
| `publish_runs`, `posts` | **tidak dihapus** otomatis (riwayat Terbit; ikut cascade hapus user) |
| `download_ledger` | `started_at < now − 180 hari`; baris terbuka > 24 jam ditutup `abandoned` |
| `metric_snapshots` (`source='api'`, YouTube) | **tidak dihapus** prune: diciutkan oleh `social-worker` bila > 30 hari tanpa refresh (03 §10.5) |
| Backup | > 14 salinan per reason (`db-backup.mjs`, §7.1) |

Dicatat di `docs/operations/STORAGE_RETENTION.md` (bagian baru "Metadata kontrol, cache dan data
platform").

---

## 10. Urutan boot `scripts/start-app.mjs`

```
1. Validasi env: POTONGIN_DB_PATH absolut, di luar JOBS_ROOT & POTONGIN_SETTINGS_DIR;
   POTONGIN_SETTINGS_SECRET ≥ 32 karakter; self-check: bila ≠ APP_SESSION_SECRET dan ada kotak v1
   yang tidak terbuka → peringatan log Indonesia (tanpa nilai).
2. settings-move (§5.2).
3. openDb({role:"app"}) → migrate() (§3.3). Gagal → exit 1 (healthcheck gagal → rollback).
   Lalu, bila penanda §5.2 ada dan kunci belum terisi: tulis meta.settings_migrated_at dan audit
   settings.migrated {files}.
4. Bootstrap (dalam tx), hanya bila users kosong:
   admin dari APP_USERNAME/APP_PASSWORD (scrypt), is_bootstrap=1;
   meta.bootstrap_owner_id, meta.instance_id; audit bootstrap.admin_created.
5. Bila E2E_SMOKE_USERNAME/E2E_SMOKE_PASSWORD ada: buat/verifikasi user smoke (member, is_smoke=1,
   proyek kosong); meta.smoke_user_id; audit smoke.ensured.
6. Sejak Fase 6 (sekali, idempoten): impor ingest-tokens.json → api_tokens (INSERT OR IGNORE by
   sha256, imported_from) → meta.ingest_tokens_imported_at; salin default logo/watermark
   root → users/<bootstrap>/ → meta.defaults_copied_at + audit settings.defaults_copied (02 §14.2).
   Kunci meta yang sudah terisi = langkah dilewati.
7. Mulai detak process_heartbeats (role app, 10 dtk); jadwalkan prune (tiap 24 jam + sekali
   60 dtk setelah start) dan backup harian 03.00 UTC (child process db-backup.mjs, argv tetap).
8. await import("../server.js")   (CMD lama Next standalone)
```
Tidak ada `job.json` yang ditulis ulang saat boot. Langkah 1–7 bisa memakan waktu (salin settings,
migrasi), jadi `HEALTHCHECK --start-period` di `Dockerfile` (baris 92, hari ini `20s`) dinaikkan ke
`60s`. SIGTERM sebelum langkah 8 → tutup DB, hapus baris detak, exit 0.

---

## 11. Tes dan kriteria penerimaan

### 11.1 Tes baru/diubah

| Tes | Isi | Fase |
|---|---|---|
| `web/tests/db-migrations.test.mjs` (baru) | nomor berurutan; lint aditif (token terlarang, `STRICT`, `ADD COLUMN` nullable/default; `BEGIN…END` trigger lolos, `BEGIN;` level statement ditolak); `migrate()` dua kali idempoten; role selain `app`/`test` ditolak; sha file yang sudah diterapkan dikunci; DB dengan versi > kode diterima; `foreign_key_check` kosong | 4+ |
| `web/tests/db-schema.test.mjs` (baru) | tiap `CHECK`/`UNIQUE`/FK menolak contoh buruk; trigger append-only `audit_events` dan `metric_snapshots` (ciut & soft delete lolos, ubah angka tanpa ciut ditolak); `users_one_bootstrap`; putus akun (hapus `social_connections`) mengosongkan `posts.connection_id`/`publish_runs.connection_id` tanpa menghapus riwayat; `publish_runs_idem` tetap unik setelah `connection_id` `NULL`; seed `instance_settings` sama dengan 02 §3.3; satu run → paling banyak satu `posts` (`post_id UNIQUE`); cascade hapus user mengosongkan semua tabel ber-`owner_id` | 4, 5, 6, 7, 8, 9 |
| `web/tests/db-owner-scope.test.mjs` (baru) | §4.7: query tabel ber-`owner_id` selalu memfilter `owner_id` (kecuali daftar putih worker/prune) | 8, 9 |
| `web/tests/db-restore.test.mjs` (baru) | restore ditolak (exit 5) bila ada detak < 30 dtk atau pembaca aktif; `--settings` menolak tar dengan symlink/`..`; `pre-restore` dibuat sebelum ganti | 4 |
| `web/tests/db-index.test.mjs` (baru) | `tx` menolak fungsi async; savepoint bersarang; path di dalam `JOBS_ROOT`/settings ditolak; mode 0600; `requireSchema` | 4 |
| `web/tests/authorize-sync-contract.test.mjs` (baru) | authorize/currentUser mengembalikan non-Promise | 4 |
| `web/tests/deploy-env-contract.test.mjs` (baru) | mount `/control` dan `POTONGIN_DB_PATH` hanya di app/primary/social; render-worker tanpa `/control`; `social-worker` me-mount `clipper_data` hanya lewat `subpath: social` dan env-nya cocok allowlist 03 §3; `POTONGIN_SETTINGS_SECRET` `:?`; `E2E_SMOKE_*` dipakai `run_read_only_e2e`; `pot-provider` tanpa ports | 4, 6, 7 |
| `web/tests/security-child-env.test.mjs` (ada, diperluas) | env anak tanpa `POTONGIN_DB_PATH`, secret, `NODE_OPTIONS` | 4 |
| `tests/test_control_plane_isolation.py` (baru) | `src/ai_clipper/**` tanpa sqlite3/`/control`/`POTONGIN_DB_PATH` | 4 |
| `web/tests/settings-move.test.mjs` (baru) | salin + sha + penanda; idempoten; symlink ditolak; purge hanya dengan penanda | 4 |
| `web/tests/db-backup.test.mjs` (baru) | `VACUUM INTO` saat ada penulis lain; 0600; retensi 14 per reason (deploy beruntun tidak menghapus `daily`); `integrity_check`; nama di luar regex tidak disentuh | 4 |
| `tests/test_deploy_guard.py` (ada, diperluas) | backup sebelum `up -d`; `DB_BACKUP=` tercetak; verifikasi mount `/control`; rollback compose baru + image lama | 4, 6 |
| `web/tests/job-ownership.test.mjs` (baru) | `ownerId`/`fairnessKey` saat create; `effectiveOwnerId` untuk job lama; `serializePublicJob` membuang keduanya; rumus `fairnessKey` stabil | 5 |
| `tests/test_render_worker_fairness.py` (baru) | §6.2 | 6 |
| `web/tests/node-sqlite-stderr.test.mjs` (baru) | §8.3: `import "node:sqlite"` dengan env compose → stderr kosong (Fase 0); varian `web/lib/db/index.mjs` (Fase 4) | 0, 4 |
| `web/tests/sqlite-import-boundary.test.mjs` (baru) | §8.3 | 0/4 |
| `web/tests/env-example.test.mjs` (ada, diperluas) | `POTONGIN_DB_PATH`, `POTONGIN_SETTINGS_SECRET` (wajib), `E2E_SMOKE_*`, `SOCIAL_PIN_KEEP_DAYS` di `.env.example` | 4+ |

### 11.2 Kriteria penerimaan dokumen ini (per fase)

- **Fase 0:** Node 24 hijau dengan ambang tetap; laporan invalidasi plate/render key; R10 terbukti.
- **Fase 4:** `0001` idempoten; image lama jalan di DB baru (drill); `/control` hanya di 3 service;
  backup lolos `integrity_check` dan dicetak di log deploy; settings pindah dengan sha cocok;
  render-worker tidak bisa membuka `/control` (tes kontrak).
- **Fase 5:** setiap job baru punya `ownerId` + `fairnessKey`; job lama terlihat oleh pemilik
  bootstrap; tidak ada field pemilik di respons API.
- **Fase 6:** round-robin render (B klaim ke-2); `/data/settings` sudah dipurge sebelum undangan
  pertama; drill restore hijau; CLI render-worker jalan tanpa `POTONGIN_DB_PATH`.
- **Fase 7–9:** tiap migrasi baru lolos lint aditif; image fase sebelumnya jalan di skema baru
  (drill lama→baru→lama).

---

## 12. Celah yang belum tertutup

1. **[Penyimpangan] lokasi `fairnessKey`** (§6.2): di `job.json`, bukan di render request, karena
   render-request-v3 memakai set kunci persis. 02 §10.3 sudah mengikuti; perlu disetujui di PR
   kontrak Fase 0 (§5.59).
2. **Peringatan `node:sqlite` di Node 24** belum diverifikasi di image yang dipin; §8.3 menetapkan
   aturan untuk dua kemungkinan (MU-M0).
3. **Rate limit login/undangan/reset** tetap in-memory (`web/lib/rate-limit.mjs`) karena `app`
   satu proses. Bila `app` kelak lebih dari satu replika, perlu tabel (migrasi aditif baru).
4. **Ciutan 30 hari YouTube** (`aggregate_json.relViews` menggantikan angka mentah) menunggu
   verifikasi kebijakan di SOS-M0 (`docs/operations/SOSMED.md`, baru); bila agregat turunan tidak
   diizinkan, langkah ciut menjadi hard delete (03 §10.5) tanpa perubahan skema.
5. **Biaya unit AI per job** (`reserved` di `shared_llm_usage`, 20 unit per job di 02 §9.2) masih
   tebakan; diukur di MU-M4 sebelum cap dinyalakan.
6. **`volume.subpath` untuk `social-worker`** butuh Docker Engine ≥ 26 di VM produksi; versi VM
   belum diverifikasi. Bila kurang, R1 memakai mount `clipper_data:/data` penuh dan tes kontrak
   mencatat pengecualian itu (penurunan isolasi, butuh persetujuan pemilik).
7. **Penyelarasan dokumen saudara:** selesai pada pemeriksaan silang akhir 2026-10-24 (lihat
   [00-README.md](00-README.md) §8). 03 tidak lagi memuat SQL dan memakai nama kolom §4.3–§4.7
   (`next_attempt_at`, `scheduled_tz`, `connection_label`, `upload_box`, `error_params_json`,
   `posts.error_code`, `aggregate_json`, `users.perf_use_in_selection`, putus akun = hapus baris);
   07 merujuk `0001`/`0006`; 08 mengikuti §5.2, §7.1, §6.2 dan subpath `social`. Bila ada
   dokumen yang menyimpang lagi, dokumen ini yang berlaku.
