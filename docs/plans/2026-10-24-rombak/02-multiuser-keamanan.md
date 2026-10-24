# 02 · Multi-user & keamanan

- **Status:** Rancangan — belum diimplementasi
- **Tanggal:** 2026-10-24
- **Dokumen saudara:** [00-README.md](00-README.md) (indeks + roadmap induk) · [01-arsitektur-data.md](01-arsitektur-data.md) · **02 (dokumen ini)** · [03-sosmed-performa.md](03-sosmed-performa.md) · [04-reframe-unduhan.md](04-reframe-unduhan.md) · [05-ui-dashboard.md](05-ui-dashboard.md) · [06-editor.md](06-editor.md) · [07-i18n.md](07-i18n.md) · [08-fase-test-deploy.md](08-fase-test-deploy.md).
- **Yang dimiliki dokumen ini (dokumen lain merujuk ke sini, tidak mendefinisikan ulang):** peran dan sesi, alur auth, API identitas/akun/admin (method, path, body, error), matriks route, `secureRoute` + kepemilikan, hardening input tak tepercaya, drain/jeda admission saat deploy, rahasia dan berbagi per user. **Bukan milik dokumen ini:** DDL, nomor migrasi, backup, boot (dok 01); API sosmed/analitik (dok 03); `source-url` bagian Fase 7 dan kode error unduhan (dok 04); layar dan kata status (dok 05); kontrak `/api/locale`, katalog, dan pemetaan kode → pesan (dok 07); urutan fase dan estimasi (dok 08).
- **Fase roadmap:** Fase 4 (identitas), Fase 5 (kepemilikan + rahasia), Fase 6 (siap anggota). Milestone: MU-M1, MU-M2, MU-M3, MU-M4, MU-M4b, MU-M5 (+ dashboard F7), MU-M6, MU-M7, MU-M7b, MU-M8, MU-M9; i18n M6a/M6b/M7a hanya sejauh menyentuh data akun.
- **Clean-room:** semua desain di sini diturunkan dari rencana Potongin dan kode Potongin. Repo SupoClip (AGPL) hanya dibaca untuk memahami perilaku (09 §1); tidak ada kode, markup, string, atau nama modulnya yang disalin.

Path relatif terhadap root repo ``. File baru ditandai **(baru)**. Semua path lain sudah dicek ada di repo pada 2026-10-24.

---

## 0. Keputusan yang dipakai

| # | Keputusan | Status |
|---|---|---|
| D2 | Dua peran: `admin`, `member` | Final (pemilik) |
| Q1 | DESIGN.md/AGENTS.md diamandemen: Mode Cepat/Lengkap dihapus, diganti satu layout dengan pengungkapan bertahap (disclosure "Lanjutan"); istilah publikasi **Terbitkan / Terbit**. Di dokumen ini hanya menyentuh istilah di baris route sosmed (§8.2) | Final |
| Q2 | Node 24 + `node:sqlite` (DatabaseSync); `@babel/parser` (dev) untuk tes statis; HeroUI v3 + Tailwind v4 + `use-intl` dipakai halaman `/akun`, `/admin/*`, undangan/reset (layar milik dok 05) | Final |
| Q3 | Admin **tidak** pernah membuka isi proyek orang lain (hanya transfer/hapus/batalkan yang diaudit); pendaftaran **hanya lewat undangan**; `APP_USERNAME/APP_PASSWORD` tetap sebagai login darurat (break-glass); user smoke `E2E_SMOKE_*`; tanpa SMTP → tautan undangan/reset disalin manual oleh admin | (default, bisa diubah) |
| Q4 | Berbagi diatur admin di `instance_settings`. Rantai AI instans boleh dipakai anggota dengan cap **200 unit/hari per anggota** (`llm_share=true`, `llm_daily_cap=200`); key LLM/Groq dari env **tidak pernah** dibagi; cookies YouTube satu set global milik admin; tren instans-wide + saklar per anggota; cache unduhan `umum` lintas user tanpa cookie (dok 04 §B6) | (default, bisa diubah) |
| Q5 | `PRIMARY_WORKER_CONCURRENCY=1` sampai diukur; per anggota: maks 3 job aktif, 1 job berjalan, 30 job/jam; durasi sumber maks 4 jam (`POTONGIN_MAX_SOURCE_SECONDS=14400`); kuota storage per user **kosong (tidak dibatasi)** sampai admin mengisi. Admin tidak kena batas per user (hanya batas global) | (default, bisa diubah) |
| Q6 | Penghapusan otomatis di luar `/data/jobs` sebagai satu paket; angka per tabel di dok 01 §9 (audit > 180 hari, sesi > 30 hari setelah kedaluwarsa/dicabut, undangan/reset > 7 hari setelah kedaluwarsa, backup DB > 14 salinan) | (default, bisa diubah) |
| Q9 | EN dirilis bersama fase editor (Fase 11); ID dan EN dua-duanya ada di akhir. Pratinjau `POTONGIN_LOCALES=id,en` hanya sebelum ada anggota (checklist §12.3). Undangan dibuat dalam bahasa pilihan admin (default bahasa admin) | Final (waktu rilis); bahasa undangan (default, bisa diubah) |
| Q10–Q12 | Tidak menyentuh dokumen ini selain hook hapus user (sosmed/performa) | (default, bisa diubah) |

**Pembagian kepemilikan dokumen:** DDL, nomor migrasi, `web/lib/db/*`, boot `web/scripts/start-app.mjs`, pemindahan settings, backup/restore, dan retensi dimiliki **dok 01 (`01-arsitektur-data.md`)** — dokumen ini memakai nama tabel/kolom dari sana dan **tidak** mendefinisikan DDL sendiri. Kebijakan (peran, nilai default `instance_settings`, alur auth, guard, kode error, kode audit tambahan) dimiliki dokumen ini; seed di dok 01 §4.1 wajib memakai nilai §3.3 di sini (penyelarasan yang masih terbuka: §17).

Aturan yang tidak bisa ditawar (gerbang keamanan, §13):
1. Akses lintas pemilik dijawab **404 identik** dengan "tidak ada" (status, body, header — termasuk `code`/`messageId`), tanpa spawn Python.
2. Admin tidak punya akses implisit ke isi proyek.
3. Undangan pertama **dilarang** sebelum MU-M4b (hardening input) hijau.
4. Guard sesi (`requireAuth`/`currentUser`) tetap **sinkron**.
5. Migrasi DB hanya aditif.

---

## 1. Kondisi sekarang (audit kode)

| Area | Fakta di kode | Dampak |
|---|---|---|
| Login | `web/lib/auth.mjs`: satu pengguna dari env (`APP_USERNAME`, `APP_PASSWORD`, `APP_SESSION_SECRET` ≥ 32). Token = `base64url({username,expiresAt}).HMAC`, cookie `potongin_session` (HttpOnly, Secure, SameSite=Lax, 30 hari). | Tidak ada id user, peran, atau pencabutan sesi. Logout (`app/api/auth/logout/route.js`) hanya menghapus cookie; token curian tetap valid 30 hari. |
| Rate limit login | `AuthRateLimiter` + `authRateLimitKeys` di `web/lib/request-security.mjs` (per IP tepercaya **dan** per username, 8/15 menit, env `AUTH_RATE_LIMIT_*`, `AUTH_TRUSTED_CLIENT_IP_HEADER`). | Bisa dipakai ulang. Instansnya lokal di modul route login. |
| Proxy | `web/proxy.js`: `/` dan media landing publik; selain itu `isAuthorized` (HMAC). Matcher mengecualikan `api/health`, `api/auth/login`, `api/jobs` (POST upload), `api/jobs/[id]/assets`, `api/settings/logo`, `api/settings/youtube-cookies`, `api/ingest/trends`, `login`, aset Next. | Lima route self-auth harus ikut dimigrasi. `/api/locale` belum ada. |
| Guard route | `secureRoute()` di `web/lib/security-headers.mjs`: `authorize(request)` **sinkron** → `sameOriginMutation` → pola id (`ROUTE_PARAMS`) → bucket rate limit → handler → redaksi path server → header keamanan. | Titik tunggal untuk menambah peran + pemilik. |
| Route API | 49 file `web/app/api/**/route.js` (matriks lengkap §8). 26 memakai `secureRoute`; sisanya `requireAuth` manual, factory `create*Route({authorize})`, atau tanpa sesi (login, logout, health, ingest token, parity-fixtures). | Tidak ada satu pun cek pemilik. |
| Halaman server yang membaca sesi | `app/projects/[id]/clips/[clipId]/edit/page.jsx`, `app/parity-harness/page.jsx`, `app/parity-harness/player/page.jsx` (memanggil `verifySessionToken` langsung). Halaman lain adalah klien dan mengambil data lewat `/api/*`. | Ketiganya pindah ke `sessionFromCookieStore`. |
| Antrean primary | `claimNextJob()` di `web/lib/primary-job-queue.mjs`: FIFO murni berdasarkan `createdAt` di bawah queue lock; reservation v2 dengan set kunci ketat (`RESERVATION_V2_KEYS`). | Satu anggota dengan 10 job memblokir semua orang. |
| Render-worker | `run_one()` di `src/ai_clipper/render_worker.py` memindai direktori job urut **nama UUID** dan mengklaim request pertama. Request v3 diperiksa ketat: `set(value) != _V3_FIELDS` (`src/ai_clipper/render_queue.py:548`), sama dengan `KEYS` di `web/lib/clip-renders.mjs`. | Fairness tidak bisa ditambahkan sebagai field baru di file request tanpa mematahkan image lama → kunci dibaca dari field aditif `job.json` `fairnessKey` (§10.3, dok 01 §6.2). |
| Rahasia setting | `web/lib/llm-settings.mjs`: AES-256-GCM, HKDF(`POTONGIN_SETTINGS_SECRET` atau `APP_SESSION_SECRET`, salt `potongin-settings`, info `potongin-llm-settings-v1`), file di `POTONGIN_SETTINGS_DIR=/data/settings`. `engineProcessEnv()` membuang `APP_PASSWORD`, `APP_SESSION_SECRET`, `POTONGIN_SETTINGS_SECRET`. | Semua setting milik satu orang. Key LLM env ikut ke anak proses. |
| Token agen | `web/lib/ingest-tokens.mjs`: `ptk_` + 43 base64url, SHA-256 di `ingest-tokens.json`, scope `trends:read`/`trends:write`. | Diimpor ke tabel `api_tokens` (§5.6). |
| Upload sumber | `app/api/jobs/route.js:39` `VIDEO_EXTENSIONS` (cek ekstensi saja). | `.mp4` berisi playlist HLS/concat bisa dibuka FFmpeg/PyAV/OpenCV → baca file lokal / SSRF. |
| `-protocol_whitelist` | Ada di `render_queue.py`, `edit_v2/{compile_ffmpeg,verify,assets,source_info,derive}.py`. **Tidak ada** di `pipeline.py`, `render.py`, `audio_timeline.py`, `media_features.py`, `transcribe_groq.py`, `edit_v2/peaks.py`. `transcribe.py:291` memberi path ke faster-whisper (PyAV); `media_features.py:575` dan `face_window.py:188` memakai `cv2.VideoCapture`. | MU-M4b (§11). |
| yt-dlp | `web/scripts/run-job.mjs` `buildVideoDownload()` / `buildCaptionDownloads()`: `--no-playlist`, `--js-runtimes node`; tanpa `--use-extractors`, tanpa `--ignore-config`. URL dinormalisasi `normalizeYouTubeUrl()` (`web/lib/jobs.mjs`, host `YOUTUBE_HOSTS`). | MU-M4b (§11.4). |
| Deploy | `deploy/production.sh`: `require_quiescent` menolak deploy selama ada job/ekspor aktif (termasuk antre); `run_read_only_e2e` login dengan `APP_*`; `rollback()` menunggu app + primary. | Drain (§10.5) dan kredensial smoke (§12). |
| Volume | `compose.yaml`: `clipper_data:/data` di `app`, `primary-worker`, `render-worker`. | DB + setting dipindah ke volume `potongin_control:/control` yang **tidak** di-mount render-worker. |

---

## 2. Peran dan model izin

### 2.1 Peran

| Kemampuan | member | admin |
|---|---|---|
| Buat klip, Proyek, editor, ekspor, ZIP — **milik sendiri** | ✓ | ✓ |
| Proyek milik orang lain (lihat isi, edit, unduh) | ✗ (404) | ✗ (404) |
| Daftar job semua orang (metadata saja: id, pemilik, status, ukuran, waktu) | ✗ | ✓ `/admin/job` |
| Batalkan / pindahkan / hapus proyek orang lain | ✗ | ✓ (diaudit; hapus & pindah butuh re-auth) |
| Pengaturan Pribadi (AI, Transkripsi, Logo, Watermark, Tampilan) | ✓ | ✓ |
| Pengaturan Instans (rantai AI instans, Groq instans, cookies YouTube, berbagi, batas default, tren instans) | ✗ (404) | ✓ |
| Tren: baca daftar + saklar pribadi | ✓ | ✓ |
| Tren: tambah/ubah/hapus, tab Agen, token `trends:*` | ✗ | ✓ |
| Kelola pengguna, undangan, reset, audit | ✗ (404) | ✓ |
| Tentang sistem, status storage global, health rinci | ✗ (404) | ✓ |
| Akun sendiri (`/akun`: profil, sandi, Bahasa, sesi, token) | ✓ | ✓ |

### 2.2 Prinsip penolakan

- **Belum login** → API 401 `unauthorized`; halaman → redirect `/login?next=…` (perilaku `proxy.js` sekarang).
- **Login, bukan pemilik, atau objek tidak ada** → 404 dengan body keluarga route (§7.4).
- **Member ke route admin** → 404 `not_found` (keluarga `web`), identik dengan admin yang meminta id admin-resource yang tidak ada.
- **Wajib ganti sandi** (`must_change_password=1`) → API 403 `password_change_required` kecuali allowlist §6.5; halaman → redirect `/akun/kata-sandi`.
- **Aksi admin berbahaya tanpa re-auth segar** → 403 `reauth_required`.
- **Mutasi lintas origin** → 403 `csrf_rejected` (sudah ada).

---

## 3. Persistence

### 3.1 Lokasi dan proses (rinci di dok 01 §1–§2, §5, §10)

| Item | Nilai |
|---|---|
| Driver | `node:sqlite` `DatabaseSync` (sinkron), modul `web/lib/db/index.mjs` **(baru, dok 01 §2.2)**: `openDb({role})`, `db()`, `tx(fn)` (fn wajib sinkron), `requireSchema(min)` |
| Path | `POTONGIN_DB_PATH=/control/potongin.sqlite`, mode 0600, dir `/control` 0700 |
| Volume | `potongin_control:/control` (baru) di `app`, `primary-worker` (dan `social-worker` sejak sosmed R1). **Tidak** di `render-worker`. |
| Proses yang boleh membuka | `app` (role `app`), `primary-worker` (role `primary`), `social-worker` (role `social`), CLI `admin-reset`/`db-backup`/`db-restore`/`multiuser-migrate` (role `cli`). **Tidak pernah:** proses Python, `render-worker`, `web/scripts/render-storage-admission.mjs`, dan `web/scripts/run-job.mjs` (anak `primary-worker`, lihat §9.2 — ia menerima keputusan pemilik lewat env dari induknya). |
| Boot | `web/scripts/start-app.mjs` **(baru, dok 01 §10)**: validasi env (path DB di luar `JOBS_ROOT`/`POTONGIN_SETTINGS_DIR`, `POTONGIN_SETTINGS_SECRET` ≥ 32) → pindah settings → `migrate()` → bootstrap admin + smoke (§6.6) → impor token/default (sejak Fase 6) → `server.js`. |
| Proses lain | `primary-worker`/`social-worker`: `requireSchema(REQUIRED_SCHEMA_<ROLE>)`, coba ulang tiap 2 dtk maks 60 dtk, lalu exit 78 (healthcheck gagal → rollback). |
| Kompatibilitas | Kode memeriksa `schema_version >=` minimum. Lint migrasi aditif di dok 01 §3.2. |

### 3.2 Tabel yang dipakai dokumen ini

DDL ada di dok 01 §4.1 (`0001-identity.sql`, Fase 4), §4.2 (`0002-shared-llm-usage.sql`, Fase 5) dan §4.6 (`0006-user-time-zone.sql`, Fase 8, kolom `users.time_zone`). Kolom batas per user dan `users.locale` sudah di `0001` (tidak ada migrasi `users-locale`/`user-limits` terpisah). Penomoran 0001–0007 dan aturan aditif: dok 01 §3. Nama yang dipakai di seluruh dokumen ini:

| Tabel | Kolom penting (nama dok 01) | Dipakai di |
|---|---|---|
| `users` | `id`, `username` (huruf kecil `[a-z0-9._-]`, 3–32, `COLLATE NOCASE`, unik), `display_name` (1–60, wajib; default = username), `role`, `status`, `password_hash` (wajib), `must_change_password`, `is_bootstrap`, `is_smoke`, `locale`, `storage_quota_bytes`, `max_active_jobs`, `max_running_jobs`, `jobs_per_hour`, `max_source_seconds`, `llm_share` (NULL = ikut instans), `trends_enabled` (default 1), `time_zone` (sejak `0006`), `password_changed_at`, `last_login_at`, `created_at`, `updated_at`, `disabled_at`, `created_by` | §2, §5, §6, §9, §10 |
| `sessions` | `id` (sid 22 char), `user_id`, `secret_sha256`, `via`, `created_at`, `expires_at`, `last_seen_at`, `reauth_at`, `revoked_at`, `revoke_reason`, `device_label` | §4 |
| `invites` | `id`, `token_sha256`, `token_prefix` (`piv_`+6), `role`, `locale`, `username_hint`, `note`, `created_by`, `expires_at`, `used_at`, `used_by`, `revoked_at` | §6.3 |
| `password_resets` | `id`, `user_id`, `token_sha256`, `created_by`, `expires_at`, `used_at`, `revoked_at` | §6.4 |
| `api_tokens` | `id`, `user_id`, `label` (1–40), `prefix`, `sha256`, `scopes`, `last_used_at`, `revoked_at`, `imported_from` | §9.4 |
| `instance_settings` | `key`, `value_json`, `updated_at`, `updated_by` | §3.3 |
| `audit_events` | `code`, `actor_kind` (`user`/`token`/`system`/`cli`), `actor_user_id`, `actor_label`, `target_user_id`, `target_label`, `job_id`, `params_json`, `request_id` | §9.7 |
| `shared_llm_usage` | `(day, user_id)`, `calls`, `reserved` | §9.2 |
| `process_heartbeats` | `(role, host)`, `pid`, `image_sha`, `started_at`, `beat_at` | `/api/admin/health` (§8.2) |
| `meta` | kunci `bootstrap_owner_id`, `smoke_user_id`, `settings_migrated_at`, `ingest_tokens_imported_at`, `defaults_copied_at`, `legacy_settings_purged_at` | §6.6, §14 |

Nilai yang divalidasi di JS (bukan `CHECK … IN`): `revoke_reason` ∈ {`logout`,`logout_all`,`password_changed`,`disabled`,`admin_revoked`,`limit`,`deleted`} (`web/lib/sessions.mjs`), kode audit (`web/lib/audit.mjs`).

Prinsip yang ditegakkan di `web/lib/users.mjs` **(baru)** di dalam `tx`: minimal satu admin aktif (`last_admin`); user `is_smoke=1` tidak pernah admin; user `is_bootstrap=1` tidak bisa dihapus.

### 3.3 `instance_settings` (kunci, tipe, default)

| Kunci | Tipe | Default (berlaku) | Dipakai di |
|---|---|---|---|
| `signup_mode` | `"invite"` | `"invite"` (nilai lain ditolak 400) | §6.3 |
| `llm_share` | bool | `true` (Q4; seed dok 01 menulis `false` → diselaraskan, §17) | §9.2 |
| `llm_daily_cap` | int 0–10000 | `200` | §9.2 |
| `groq_share` | bool | `false` (**tambahan** atas seed dok 01) | §9.2 |
| `youtube_cookies_share` | bool | `true` | §9.3 |
| `member_llm_keys_allowed` | bool | `true` (**tambahan** atas seed dok 01) | §9.1 |
| `trends_scope` | `"instance"` | `"instance"` | §9.4 |
| `member_max_active_jobs` | int ≥ 0 | `3` (Q5; seed dok 01 menulis `4` → diselaraskan, §17) | §10.1 |
| `member_max_running_jobs` | int ≥ 0 | `1` | §10.3 |
| `member_jobs_per_hour` | int ≥ 0 | `30` | §10.1 |
| `member_max_source_seconds` | int > 0 | `14400` | §11.2 |
| `member_storage_quota_bytes` | int ≥ 0 \| null | `null` (tidak dibatasi) | §10.4 |
| `invite_ttl_hours` | int 1–720 | `168` | §6.3 |
| `reset_ttl_hours` | int 1–168 | `24` | §6.4 |

Kunci berawalan `social_` (`social_cap_active`, `social_cap_hourly`, `social_yt_daily_overrides`) dimiliki dok 03 §10.1 (di-seed `0005-posts.sql`); tidak tampil di `/api/admin/settings` Fase 6 dan diubah lewat `admin-reset.mjs --set-setting` (§6.6).

Saklar tren instans tetap field `enabled` di `trend-context.json` (perilaku sekarang, ditulis route #8 scope `instance`); tidak ada kunci DB untuk itu.

Batas efektif user = kolom `users.*` bila non-NULL, selain itu `member_*`. Admin: batas per user tidak berlaku (hanya batas global `JOBS_STORAGE_*`, `PRIMARY_MAX_ACTIVE_JOBS`, `POTONGIN_MAX_SOURCE_SECONDS`).

Modul `web/lib/instance-settings.mjs` **(baru)**: `getInstanceSetting(key)` (sinkron, cache per proses 5 dtk), `setInstanceSettings(patch, actor)` (validasi tipe per kunci di atas, satu `tx`, satu baris audit `settings.instance_changed {keys:[…]}` — tanpa nilai).

---
## 4. Sesi

### 4.1 Format dan cookie

| Item | Nilai |
|---|---|
| Token | `s2.<sid>.<secret>`; `sid` = 16 byte acak base64url (22 char), `secret` = 32 byte acak base64url (43 char). Regex: `^s2\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$` |
| Disimpan | Baris `sessions` dengan `secret_sha256 = sha256(secret)` hex. Token mentah tidak pernah disimpan, di-log, atau dikembalikan selain di `Set-Cookie`. |
| Cookie | `__Host-potongin_session=<token>; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000` (tanpa `Domain`). Chromium menerima `Secure`/`__Host-` di `http://localhost`, jadi e2e lokal tetap jalan (cookie sekarang juga sudah `Secure`). |
| Umur | Absolut 30 hari dari `created_at`; tidak diperpanjang. `last_seen_at` ditulis paling sering sekali per menit per sesi (dok 01). |
| Batas per user | 20 sesi aktif; sesi ke-21 mencabut yang `last_seen_at` paling lama (`revoke_reason='limit'`). |
| Valid bila | Baris ada, `revoked_at IS NULL`, `expires_at > now`, `timingSafeEqual(sha256(secret), secret_sha256)`, user `status='active'` (kecuali `via='break_glass'`, §6.6). |

### 4.2 State machine sesi

```
            login / undangan diterima / reset selesai / upgrade v1 / break-glass
                                   │
                                   ▼
                              ┌─────────┐  reauth OK → reauth_at = now (tetap active)
                              │ active  │──────────────────────────────────────────┐
                              └────┬────┘◄─────────────────────────────────────────┘
       logout │ logout_all │ password_changed │ disabled │ admin_revoked │ limit │ deleted
                                   ▼
                              ┌─────────┐
                              │ revoked │  (terminal; baris dihapus 30 hari kemudian, Q6)
                              └─────────┘
              now ≥ expires_at → expired (terminal, tanpa tulis; dihapus 30 hari kemudian)
```

### 4.3 Transisi dari cookie v1

Satu rilis transisi (Fase 4). Rilis berikutnya (Fase 5) menghapus jalur v1.

1. `proxy.js` dan `currentUser()` menerima **dua bentuk**: cookie `__Host-potongin_session` (s2) **atau** cookie lama `potongin_session` yang lolos `verifySessionToken()` (HMAC `APP_SESSION_SECRET`).
2. v1 yang valid dipetakan ke user `meta.bootstrap_owner_id`.
3. Di `proxy()`, kalau hanya v1 yang ada dan valid: buat baris sesi (`via='upgrade_v1'`, `expires_at` = `expiresAt` dari payload v1), lalu `NextResponse.next()` dengan `Set-Cookie` s2 baru **dan** penghapusan `potongin_session`. Request yang sedang berjalan tetap lolos dengan v1.
4. Upgrade hanya sekali: kalau s2 valid sudah ada, v1 diabaikan dan dihapus.
5. Rollback ke image lama: cookie s2 tidak dikenali image lama → login ulang dengan `APP_*` (tetap valid).

### 4.4 API modul sesi

`web/lib/sessions.mjs` **(baru)**, semua sinkron kecuali ditandai:

| Fungsi | Kontrak |
|---|---|
| `createSession(userId, {via, userAgent, now})` | → `{token, session}`. Menegakkan batas 20. |
| `sessionFromToken(token, now)` | → `{session, user}` atau `null`. Tidak melempar untuk input apa pun. |
| `revokeSession(sid, reason)` / `revokeUserSessions(userId, reason, {exceptSid})` | Idempoten. |
| `markReauth(sid, now)` | Mengisi `reauth_at`. |
| `touchSession(sid, now)` | Tulis `last_seen_at` hanya bila selisih ≥ 60 dtk. |
| `sessionCookie(token)` / `clearSessionCookies()` | `clearSessionCookies()` mengembalikan **dua** header `Set-Cookie` (s2 dan v1). |

`web/lib/auth.mjs` (diubah) — permukaan yang dipakai seluruh kode:

| Ekspor | Sinkron | Kontrak |
|---|---|---|
| `currentUser(request)` | ya | → principal `{id, username, role, status, mustChangePassword, isSmoke, sessionId, via, reauthAt}` atau `null`. Hasil di-cache per objek request (`WeakMap`). Membaca s2, lalu v1 (selama transisi). |
| `requireAuth(request)` | ya | Signature lama dipertahankan: `null` atau `Response` 401 (`unauthorized`) / 403 (`password_change_required`, kecuali path di allowlist §6.5). Dipanggil oleh `secureRoute` dan semua call site yang ada tanpa `await`: 7 modul lib selain `security-headers.mjs` (`editor-ai`, `transcription-settings`, `camera-progress`, `clip-edit`, `youtube-cookies`, `preview-lane`, `default-watermark`) dan 18 file route yang mengimpor `requireAuth` langsung atau sebagai default `authorize`. |
| `requireUser(request)` | ya | → principal atau melempar `AuthError(status, code)`; untuk route baru. |
| `sessionFromCookieStore(store)` | ya | Untuk server component (`cookies()` Next): → principal atau `null`. Dipakai 3 halaman server + `parity-fixtures`. |
| `isAuthorized(request)` | ya | Dipertahankan untuk `proxy.js`: `currentUser(request) !== null`. |
| `authenticateCredentials`, `createSessionToken`, `verifySessionToken` | — | Tetap untuk jalur v1 sampai Fase 5, lalu `verifySessionToken` dihapus; `authenticateCredentials` diganti `verifyLogin` (§5). |

Kontrak sinkron dijaga `web/tests/authorize-sync-contract.test.mjs` **(baru)**: parse (`@babel/parser`) `lib/auth.mjs`, `lib/security-headers.mjs`, dan semua call site `authorize(`; gagal bila `currentUser`/`requireAuth`/`requireUser`/`sessionFromCookieStore` dideklarasikan `async`, mengembalikan Promise saat dipanggil dengan request palsu, atau ada `await authorize(`.

### 4.5 Proxy

`web/proxy.js` (diubah). Runtime proxy Next 16 adalah Node.js, sehingga `currentUser()` (DB sinkron) boleh dipanggil di sini.

```
proxy(request):
  path == "/" | landing media | path ∈ PUBLIC_EXACT ("/privasi", "/ketentuan")      → next()
  path cocok PUBLIC_TOKEN_PAGES ("/undangan/<token>", "/atur-ulang-sandi/<token>")  → next() + header no-store, Referrer-Policy: no-referrer
  principal = currentUser(request)            # s2, lalu v1
  principal == null:
     /api/* → 401 {error:"Sesi login diperlukan", code:"unauthorized", messageId:"web.unauthorized"}
     lain   → redirect /login?next=…
  principal.mustChangePassword dan path bukan /akun/kata-sandi dan bukan API allowlist §6.5:
     /api/* → 403 password_change_required ; lain → redirect /akun/kata-sandi
  path mulai "/admin" dan role != admin → rewrite ke halaman 404 (status 404)
  v1 tanpa s2 → upgrade (§4.3)
  → next()
```

Matcher menambah pengecualian (masing-masing dengan alasan di `web/tests/proxy-matcher.test.mjs`): `api/locale` (publik, cookie saja), `api/auth/invite/accept`, `api/auth/reset/complete` (publik, token di body). Halaman token **tidak** dikecualikan dari matcher; dilewatkan oleh cek path di atas, supaya header tetap dipasang.

Catatan matcher yang ada: pola `api/jobs/?$` mengecualikan **semua** method `/api/jobs` (termasuk `GET`), bukan hanya upload; `GET /api/jobs` sudah memanggil `requireAuth` sendiri (`app/api/jobs/route.js:261`) dan tetap begitu.

### 4.6 Pembaca nama cookie dan kunci rate limit

Hari ini lima tempat membaca cookie `SESSION_COOKIE` (`potongin_session`) langsung dari header, bukan lewat `auth.mjs`:

| Tempat | Fungsi | Perubahan |
|---|---|---|
| `web/lib/security-headers.mjs:75` | `sessionTokenOf(request)` → kunci bucket `secureRoute` (`sessionRateKey`) | Diganti `rateKeyOf(request)` **(baru, ekspor modul yang sama)**: `user:<principal.id>` dari `currentUser(request)`; tanpa principal → `"anonymous"`. Bucket per **user**, bukan per cookie, supaya 20 sesi tidak memberi 20× kuota. |
| `web/lib/default-logo.mjs:312` | `sessionTokenOf` untuk bucket `upload` | Pakai `rateKeyOf` |
| `web/lib/asset-upload.mjs:369` | parser cookie sendiri untuk bucket upload | Pakai `rateKeyOf` |
| `web/lib/preview-lane.mjs:909` | parser cookie sendiri untuk bucket pratinjau | Pakai `rateKeyOf` |
| `app/api/parity-fixtures/[...path]/route.js:47` | parser cookie + `verifySessionToken` | `currentUser(request)` |

`createEditorRateLimits().check(kind, {sessionToken, jobId})` (`web/lib/rate-limit.mjs:70`) tidak berubah bentuknya; nilai `sessionToken` sekarang berisi `rateKeyOf()` (tetap di-hash `sessionRateKey`). Tanpa perubahan ini cookie `__Host-potongin_session` tidak dikenali dan **semua** user jatuh ke satu bucket `"anonymous"`. Tes: `web/tests/security-routes.test.mjs` (diperluas) — dua sesi user yang sama berbagi bucket; dua user berbeda tidak. Tes yang memasang cookie dengan `SESSION_COOKIE` + `createSessionToken` (`tests/{parity-fixtures-route,editor-player-harness,preview-lane,clip-media}.test.mjs`) beralih ke helper `web/tests/support/session.mjs` **(baru)**: `sessionCookieFor(user)` yang membuat baris sesi di DB tes.

---

## 5. Kata sandi

`web/lib/passwords.mjs` **(baru)**.

| Item | Nilai |
|---|---|
| Algoritma | `crypto.scrypt` **async** (tidak memblokir event loop), N = 2^15, r = 8, p = 1, keylen 64 (dok 01 §4.1), salt 16 byte, `maxmem` 64 MiB |
| Format | `scrypt$15$8$1$<salt b64url>$<hash b64url>` (log2 N, r, p; sama dengan dok 01 §4.1, `CHECK (password_hash GLOB 'scrypt$*')`). Verifikasi membaca parameter dari string; bila lebih lemah dari parameter sekarang, hash ditulis ulang setelah login sukses. |
| Konkurensi | Semaphore 4 operasi scrypt per proses; antrean penuh (> 16 menunggu) → 429 `rate_limited` dengan `Retry-After: 5`. |
| Username tak dikenal | Tetap menjalankan `scrypt` terhadap `DUMMY_HASH` konstan (dibuat saat modul dimuat) supaya waktu respons sama. |
| Kebijakan | 12–128 code point; ≤ 1024 byte UTF-8; NFC; tidak sama dengan username (case-insensitive); tidak ada di `resources/auth/common-passwords.txt` **(baru)** (daftar 10.000 sandi umum dari sumber berlisensi MIT/CC0, dicatat di `/licenses`). Tanpa aturan komposisi. |
| Kode error | `password_too_short`, `password_too_long`, `password_common`, `password_same_as_username`, `password_wrong` (sandi lama salah) |

Ekspor: `hashPassword(plain) → Promise<string>`, `verifyPassword(plain, stored) → Promise<{ok, needsRehash}>`, `checkPasswordPolicy(plain, username) → code | null`, `verifyLogin(username, password, env) → Promise<{user, via} | null>` (§6.1).

---

## 6. Alur autentikasi

### 6.1 Login — `POST /api/auth/login` (diubah)

- **Auth:** publik (dikecualikan proxy, sudah). `sameOriginMutation` → 403.
- **Request:** form `application/x-www-form-urlencoded` (`readBoundedUrlEncodedForm`, 4 KiB): `username`, `password`, `next`. Nama field tidak berubah (`web/e2e/support/harness.mjs`).
- **Urutan:**
  1. Rate limit: `blocked()` per IP **dan** per username (kunci `authRateLimitKeys`, sudah ada). Diblokir → 303 `/login?error=limit` + `Retry-After`.
  2. `verifyLogin`: `key = username.normalize('NFC').toLowerCase()`; cari `users.username = key`; scrypt (dummy bila tak ada atau `key` tidak lolos pola §6.7). Lalu jalur break-glass (§6.6) bila belum cocok.
  3. Gagal (tidak ada / sandi salah / `status='disabled'`) → `consume()` kedua kunci → 303 `/login?error=1`. Pesan sama untuk semua sebab (tidak ada `account_disabled` yang terlihat; kunci UI dok 05: `?error=1` → `login_invalid`, `?error=limit` → `rate_limited`). Nilai query lama dipertahankan agar image lama/baru dan e2e tetap cocok.
  4. Sukses → `reset()` kedua kunci; `createSession`; `users.last_login_at`; salin `users.locale` ke cookie `potongin_locale` (i18n M6a); bila `users.locale` NULL isi dari cookie/Accept-Language.
  5. Respons 303 ke `safeNextPath(next)`; bila `must_change_password` → 303 `/akun/kata-sandi`. Header: `Set-Cookie` sesi (+ locale), `Cache-Control: no-store`.
- **Audit:** tidak ada baris untuk login biasa (volume). `auth.break_glass` untuk break-glass.

### 6.2 Logout

| Route | Auth | Efek | Respons |
|---|---|---|---|
| `POST /api/auth/logout` (diubah) | sesi (proxy) + `sameOriginMutation` | `revokeSession(sid,'logout')` bila ada sesi s2; hapus cookie s2 **dan** v1 | 303 `/login?keluar=1` |
| `DELETE /api/account/sessions` **(baru)** `?scope=others\|all` | sesi + origin | `others`: semua kecuali sesi ini (`logout_all`); `all`: termasuk sesi ini lalu cookie dihapus | 200 `{revoked:n}` |
| `DELETE /api/account/sessions/[sid]` **(baru)** | sesi + origin; `sid` milik user ini, selain itu 404 | revoke satu | 200 `{revoked:1}` |
| `GET /api/account/sessions` **(baru)** | sesi | — | `{sessions:[{id, deviceLabel, createdAt, lastSeenAt, current, via}]}` |

Draft editor (X13): kunci IndexedDB di `web/lib/editor/draft-store.mjs` diberi prefiks `u:<draftNamespace>:` dengan `draftNamespace = hex(HMAC-SHA256(POTONGIN_SETTINGS_SECRET, "draft\0"+userId))[0:16]`, dikirim server ke editor lewat props halaman edit. Ekspor baru `clearAllDrafts({indexedDB})` **(baru)** di `draft-store.mjs` memanggil `indexedDB.deleteDatabase(DRAFT_DB)` (`DRAFT_DB = "potongin-editor"`); halaman `/login` dengan `?keluar=1` menjalankannya (menghapus seluruh DB draft di perangkat). `draftKey(clipId, tabId)` yang ada menjadi `draftKey(namespace, clipId, tabId)`. (Dok 01 §6.4 menyebut `localStorage`; yang benar IndexedDB, sesuai kode.) Draft milik user lain yang tertinggal tidak pernah dibaca karena prefiks berbeda.

### 6.3 Undangan (tanpa SMTP)

**State machine undangan:** `pending` → (`accept`) `used` · `pending` → (`revoke`) `revoked` · `pending` → (`now ≥ expires_at`) `expired`. Hanya `pending` yang bisa diterima.

| Langkah | Route | Auth | Request | Respons / error |
|---|---|---|---|---|
| Admin membuat | `POST /api/admin/invites` **(baru)** | admin, origin | `{role:"member"\|"admin", locale:<kode di registry locale>, usernameHint?:string (pola §6.7), note?:string≤80}` | 201 `{invite:{id, role, locale, tokenPrefix, expiresAt}, url:"<POTONGIN_PUBLIC_URL>/undangan/<token>"}`; `token = "piv_" + 43 base64url` (32 byte acak), `expires_at = now + invite_ttl_hours`; `url` hanya di respons ini. 400 `invalid_request`, 429. Audit `invite.created {inviteId, role}` |
| Admin melihat | `GET /api/admin/invites` **(baru)** | admin | — | `{invites:[{id, role, locale, usernameHint, note, tokenPrefix, createdBy, createdAt, expiresAt, state:"pending"\|"used"\|"revoked"\|"expired"}]}` (tanpa token/hash) |
| Admin mencabut | `DELETE /api/admin/invites/[inviteId]` **(baru)** | admin, origin | — | 200; 404 `web` bila tidak `pending`. Audit `invite.revoked {inviteId, role}` |
| Calon membuka | halaman `/undangan/[token]` **(baru)** | publik | token di path, regex `^piv_[A-Za-z0-9_-]{43}$` | Server component: hash token → baris `pending`? Form: Nama pengguna (prefill `usernameHint`), Kata sandi, Ulangi, pemilih bahasa (default `invite.locale`). Token tidak valid/kedaluwarsa/terpakai/dicabut → **satu** tampilan "Tautan tidak berlaku" (HTTP 404). `Referrer-Policy: no-referrer`, `Cache-Control: no-store`. |
| Calon menerima | `POST /api/auth/invite/accept` **(baru)** | publik (dikecualikan proxy), origin, rate limit `token_link` | form: `token`, `username`, `password`, `password2`, `locale` (∈ locale aktif; selain itu dipakai `invite.locale`) | `hashPassword` dihitung **sebelum** `tx` (async), lalu dalam satu `tx`: cek ulang undangan `pending`, buat user (role dari undangan, `display_name = username`, `locale` = pilihan form, `created_by = invite.created_by`, `must_change_password=0`), tandai `used`/`used_by`, buat sesi `via='invite'` → 303 `/dashboard`. Error → 303 kembali ke `/undangan/<token>?error=<code>`: `link_invalid` (semua sebab token), `username_invalid` (pola §6.7), `username_taken`, `password_*`, `password_mismatch`, `rate_limited`. Audit `invite.used {inviteId, role}` + `user.created {role}` |

Catatan anti-enumerasi: token 256 bit, dicari lewat hash, semua kegagalan token menghasilkan respons yang sama. `username_taken` hanya bisa dilihat pemegang undangan yang valid.

### 6.4 Reset kata sandi (oleh admin)

Tidak ada "lupa sandi" mandiri tanpa SMTP (Q3 default). Pengguna menghubungi admin.

**State machine reset:** `pending` → `used` / `revoked` / `expired` (`reset_ttl_hours`, default 24). Token `prs_` + 43 base64url, dicari lewat `token_sha256`. Membuat reset baru untuk user yang sama mencabut reset `pending` sebelumnya.

| Langkah | Route | Auth | Respons |
|---|---|---|---|
| Admin membuat tautan | `POST /api/admin/users/[userId]/reset-link` **(baru)** | admin, origin, **re-auth** | 201 `{url, expiresAt}`. 404 user tak ada; 409 `smoke_user_locked` untuk user smoke. Audit `user.password_reset_issued` |
| Pengguna membuka | `/atur-ulang-sandi/[token]` **(baru)** | publik | Form sandi baru + ulangi + pemilih bahasa. Token buruk → "Tautan tidak berlaku" (404). |
| Pengguna menyelesaikan | `POST /api/auth/reset/complete` **(baru)** | publik, origin | form `token`, `password`, `password2` → dalam satu `tx`: set hash, `must_change_password=0`, `revokeUserSessions(userId,'password_changed')`, tandai `used`, buat sesi `via='reset'` → 303 `/dashboard`. Error → 303 `?error=<code>` (`link_invalid`, `password_*`, `password_mismatch`, `rate_limited`). Audit `user.password_changed {via:"reset"}` |

Alternatif admin tanpa tautan: **tidak ada** "kata sandi sementara" yang diketik admin (sandi tidak pernah diketahui admin). Pengecualian satu-satunya: CLI `admin-reset.mjs` (§6.6) yang menyetel `must_change_password=1`.

### 6.5 Ganti sandi dan login pertama

- `POST /api/account/password` **(baru)** — sesi, origin, rate limit `password` (§7.1). Body JSON `{current, next}` (maks 4 KiB). Verifikasi `current` (scrypt); kebijakan `next`; set hash; `revokeUserSessions(userId,'password_changed',{exceptSid})`; rotasi sesi sekarang (sesi baru, yang lama dicabut, `Set-Cookie` baru); `must_change_password=0`. 200 `{ok:true}`. Error 400 `password_*`, 403 `password_wrong` (dihitung ke limiter). Audit `user.password_changed {via:"self"}`.
- Halaman `/akun/kata-sandi` **(baru)**: tiga field, satu tombol [Simpan].
- **Allowlist saat `must_change_password=1`:** `GET /api/account`, `POST /api/account/password`, `POST /api/auth/logout`, `POST /api/locale`, halaman `/akun/kata-sandi`, `/login`, aset statis.

### 6.6 Break-glass `APP_*` dan CLI

**Bootstrap (boot pertama image multi-user, §14, oleh `start-app.mjs`):** kalau `users` kosong, buat admin `is_bootstrap=1` dengan `username = APP_USERNAME.normalize('NFC').toLowerCase()` dan `password_hash = hashPassword(APP_PASSWORD)`; `meta.bootstrap_owner_id = id`. Bila hasil normalisasi tidak lolos pola §6.7 → app tidak start, pesan Indonesia di stderr ("APP_USERNAME harus 3–32 huruf kecil, angka, titik, garis bawah, atau tanda hubung"). Audit `bootstrap.admin_created`.

**Login darurat (default, bisa diubah):** di `verifyLogin`, setelah jalur DB gagal: bila `APP_USERNAME`, `APP_PASSWORD`, `APP_SESSION_SECRET` terkonfigurasi (cek `configured()` yang ada), `APP_PASSWORD` ≠ placeholder `.env.example` (`change-this-before-starting`), dan username + sandi cocok (timing-safe) → sesi `via='break_glass'` untuk user `bootstrap_owner_id`, **walaupun** user itu `disabled` atau sandinya sudah diganti. Audit `auth.break_glass` (kode tambahan, §9.7) di setiap pemakaian. Tetap kena rate limit yang sama. UI menampilkan pita "Masuk darurat" di menu akun selama sesi itu. Re-auth sesi break-glass memakai `APP_PASSWORD`.

**CLI** `web/scripts/admin-reset.mjs` **(baru)** (dijalankan `docker compose exec app node scripts/admin-reset.mjs …`; tidak pernah mencetak hash):

| Perintah | Efek |
|---|---|
| `--admin <username>` | User ada → `role='admin'`, `status='active'`, sandi acak 20 char dicetak **sekali** ke stdout, `must_change_password=1`, semua sesi dicabut. Tidak ada → dibuat. Audit `user.admin_reset` (kode tambahan, `actor_kind='cli'`). |
| `--ensure-smoke-user` | Baca `E2E_SMOKE_USERNAME`/`E2E_SMOKE_PASSWORD`; buat atau perbarui user `role='member'`, `is_smoke=1`, sandi = env, `must_change_password=0`; `meta.smoke_user_id`. Idempoten; audit `smoke.ensured` hanya bila ada perubahan. |
| `--list` | Tabel username, role, status, is_smoke. |
| `--purge-legacy-settings` | Dok 01 §5.2: hapus salinan beku `/data/settings` setelah cek penanda + sha. **Wajib sebelum undangan pertama** (checklist §12.3). |
| `--set-setting <key> <json>` | Ditambahkan di SOS-M3a (dok 03 §10.1). Hanya kunci berawalan `social_`; nilai divalidasi validator kunci di `web/lib/instance-settings.mjs`; satu `tx`; audit `settings.instance_changed {keys:[key]}` dengan `actor_kind='cli'` (tanpa nilai). Kunci lain → exit 64. |

User smoke: tidak bisa dijadikan admin (409 `smoke_user_locked`), tidak bisa direset lewat UI, tampil dengan chip "smoke" di `/admin/pengguna`. **Tidak bisa membuat job**: `--ensure-smoke-user` menyetel `max_active_jobs=0` dan `jobs_per_hour=0` (→ 429 `user_queue_full` di §10.1), dan `PATCH /api/admin/users/[userId]` untuk user smoke → 409 `smoke_user_locked`. Spec `smoke`/`read-only` pasca-deploy hanya membaca.

### 6.7 Re-auth admin

- `POST /api/auth/reauth` **(baru)** — sesi, origin, form/JSON `{password}`; limiter sama dengan login (kunci username sesi + IP). Sukses → `markReauth(sid)` → 200 `{reauthUntil}` (now + 10 menit). Gagal → 403 `password_wrong`.
- `secureRoute({reauth:true})` menolak bila `reauth_at` null atau < now − 10 menit → 403 `reauth_required`. UI menampilkan modal sandi lalu mengulang request.
- Aksi yang butuh re-auth: ubah peran, nonaktifkan/aktifkan, hapus user, buat tautan reset, cabut semua sesi user lain, pindahkan proyek, hapus proyek user lain, ubah `instance_settings` berbagi/batas.

Pola username (undangan, bootstrap, login lookup): input di-`normalize('NFC').toLowerCase()`, lalu wajib cocok `^[a-z0-9](?:[a-z0-9._-]{1,30})[a-z0-9]$` (3–32 char ASCII; sama dengan `CHECK` kolom `users.username` dok 01). Kode `username_invalid`. Nama tampilan bebas Unicode ada di `display_name` (1–60).

---

## 7. Guard route dan kepemilikan

### 7.1 Rate limit

Satu registri limiter per proses di `web/lib/request-security.mjs` (diubah): `sharedAuthLimiter(kind)` memakai `AuthRateLimiter` yang ada (jendela tetap) atau `TokenBucketLimiter` dari `web/lib/rate-limit.mjs`. In-memory (satu container app); restart mengosongkan — diterima.

| Kind | Kunci | Batas | Respons saat penuh |
|---|---|---|---|
| `login` (ada) | IP tepercaya + username | `AUTH_RATE_LIMIT_ATTEMPTS`/`AUTH_RATE_LIMIT_WINDOW_MS` (8 / 15 menit) gagal | 303 `/login?error=limit` + `Retry-After` |
| `reauth` | user + IP | 5 gagal / 15 menit | 429 `rate_limited` |
| `password` | user | 5 gagal / 15 menit | 429 |
| `token_link` (accept/complete) | IP + sha256(token) | 10 / 15 menit per IP, 5 / 15 menit per token | 303 `?error=rate_limited` |
| `token_page` (GET halaman undangan/reset) | IP | 30 / 15 menit | halaman "Terlalu banyak percobaan" 429 |
| `locale` | hash IP | 20 / menit (`TokenBucketLimiter` modul-level di route, dok 07 §9.2) | 429 `rate_limited`; form → 303 `?bahasa=gagal` |
| `admin` (mutasi `/api/admin/*`) | sesi | 30 / menit | 429 |
| `api_token_create` | user | 10 / jam | 429 |
| `jobs_create` | user | `jobs_per_hour` efektif (30) / jam, jendela geser; admin tidak dibatasi | 429 `user_rate_limited` + `Retry-After` |
| Editor (`EDITOR_RATE_LIMITS`) | tetap seperti sekarang (sesi/job) | tidak berubah | 429 `rate_limited` |

Tanpa `AUTH_TRUSTED_CLIENT_IP_HEADER`, kunci IP jatuh ke `untrusted-proxy-client` (perilaku sekarang); runbook mewajibkan `cloudflare` atau `nginx` di produksi, dan `deploy-env-contract` memastikan variabel itu tidak kosong di `.env` produksi.

### 7.2 `secureRoute` diperluas

`web/lib/security-headers.mjs` (diubah). Opsi baru (opsi lama tetap):

```js
secureRoute(handler, {
  params: ["id", "clipId"],          // ada
  limit: "api",                      // ada
  after: null,                       // ada
  role: "member" | "admin",          // baru, default "member" (= user login apa pun)
  owner: "job" | "none",             // baru, WAJIB eksplisit bila params memuat "id"
  notFound: "job" | "edit" | "web",  // baru, keluarga body 404 (§7.4); default "web"
  reauth: false,                     // baru
  auth: "session" | { token: "trends:write" }, // baru, default "session"
})
```

Urutan langkah:
1. `authorize(request)` sinkron (sesi + `password_change_required`) → 401/403. Untuk `auth:{token}`: bearer `ptk_…` lewat `web/lib/api-tokens.mjs`; cookie ditolak (perilaku `ingest/trends` sekarang).
2. Mutasi: `sameOriginMutation` → 403 `csrf_rejected` (dilewati untuk `auth:{token}`).
3. Pola param (`ROUTE_PARAMS`) → 400 `invalid_request`.
4. `role:"admin"` dan principal bukan admin → 404 keluarga `web`.
5. `reauth:true` → 403 `reauth_required`.
6. `owner:"job"` → `readOwnedJob()` (§7.3). Gagal → 404 keluarga `notFound`. **Tidak ada** spawn, baca file klip, atau rate-limit sebelum langkah ini.
7. Bucket rate limit → 429.
8. Handler dipanggil dengan `context.principal` dan `context.ownedJob` (`{job, jobPath}`, job.json sudah dibaca dan divalidasi).
9. Redaksi path server + header keamanan (sudah ada).

### 7.3 `web/lib/job-ownership.mjs` **(baru)**

```js
export function effectiveOwnerId(job, bootstrapOwnerId)
  // typeof job.ownerId === "string" && UUID ? job.ownerId : bootstrapOwnerId

export async function readOwnedJob(jobsRoot, id, principal)
  // → {job, jobPath}; melempar JobOwnershipNotFound bila:
  //   id tidak cocok UUID, job.json tidak ada/tidak terbaca/bukan file biasa (O_NOFOLLOW),
  //   atau effectiveOwnerId(job) !== principal.id   (admin TIDAK dikecualikan)

export function ownsJob(job, principal, bootstrapOwnerId)   // sinkron, untuk filter daftar
export function fairnessKeyFor(ownerId, env)                 // §10.3: "fk1_" + 16 hex (dok 01 §6.1)
export async function transferJob(jobsRoot, id, toUserId, actor)  // §9.5, di bawah withPrimaryQueueLock
```

Penulisan `ownerId`:
- `POST /api/jobs`: `ownerId = principal.id` ditulis bersama job (field baru di job.json; image lama mengabaikannya).
- `serializePublicJob()` (`web/lib/jobs.mjs`) membuang `ownerId` dari respons.
- Job lama tanpa `ownerId` dimiliki `bootstrap_owner_id`; tidak ada job.json yang ditulis ulang saat boot.

Daftar yang difilter per pemilik: `GET /api/jobs` (`app/api/jobs/route.js` `GET`), `GET /api/clips` (`clipLibraryRoute` di `web/lib/clip-library.mjs` menerima `principal`), status storage anggota (§9.6), dan `listJobClips` turunan (dok 06, dipakai dok 03).

Halaman server `app/projects/[id]/clips/[clipId]/edit/page.jsx`: `sessionFromCookieStore(await cookies())` → null → redirect login; lalu `readOwnedJob()` → gagal → `notFound()`. Halaman klien (`/projects/[id]`) tetap mengandalkan API yang menjawab 404.

### 7.4 Body 404 identik

| Keluarga | Body (status 404, `Cache-Control: no-store`, header `API_HEADERS`) | Dipakai di |
|---|---|---|
| `job` | `{"error":"Job tidak ditemukan","code":"not_found","messageId":"web.job_not_found"}` | `/api/jobs/[id]`, `cancel`, `files`, `zip`, `assets*`, `clip-text*`, `renders/[renderId]`, `apply-all/*/undo`, `clips` (list) |
| `edit` | `editorError("not_found", 404)` dari `web/lib/clip-edit.mjs` + `messageId:"edit.not_found"` → `{"error":"Data tidak ditemukan","code":"not_found","messageId":"edit.not_found"}` | `/api/jobs/[id]/clips/[clipId]/**` |
| `web` | `{"error":"Tidak ditemukan","code":"not_found","messageId":"web.not_found"}` | route admin, akun, token, sesi |

Body 404 untuk job yang tidak ada hari ini **berbeda per route** (contoh: `refusal("not_found",404)` di `web/lib/clips-zip.mjs`, `plain(404,"Not found")` di `web/lib/clip-media.mjs`, `errorResponse("File not found",404)` di `app/api/jobs/[id]/files/[...path]/route.js`, `{error:"Job tidak ditemukan"}` di `cancel`). Karena itu `notFound` juga menerima **factory** `() => Response`; tiap route memakai builder yang ia pakai sekarang untuk "tidak ada" (kolom "404" di §8), ditambah `code`/`messageId` secara aditif bila body JSON. Tiga preset di atas dipakai untuk route baru.

"Tidak ada" dan "milik orang lain" sama-sama dihasilkan langkah 6 guard, jadi identik secara konstruksi. Untuk route yang **tidak** ber-`[id]` tetapi menerima id di body (misalnya `transfer`), handler memakai `readOwnedJob` atau `notFoundResponse(family)` yang sama. `ownership-matrix` membandingkan status, body byte-per-byte, dan semua header kecuali `date`.

---
## 8. Matriks route

Legenda — **Auth:** `pub` publik · `ses` sesi · `tok:<scope>` bearer `ptk_` · `ses+flag` sesi + flag env. **Peran:** `M` member atau admin · `A` admin saja (member → 404 `web`). **Pemilik:** `job` = `readOwnedJob` · `self` = objek milik principal (token, sesi) · `list` = daftar difilter per pemilik · `—` tidak ada objek per user. **Proxy:** `ex` = dikecualikan matcher (route mengautentikasi sendiri). **Guard baru:** bentuk implementasi target. Kolom "404" = builder respons "tidak ada" (§7.4).

### 8.1 API yang sudah ada (49 file)

| # | Route | Method | Auth | Peran | Pemilik | Proxy | Guard baru / catatan | 404 |
|---|---|---|---|---|---|---|---|---|
| 1 | `/api/auth/login` | POST | pub | — | — | ex | §6.1 | — |
| 2 | `/api/auth/logout` | POST | ses | M | self | | §6.2; tetap manual (+ origin) | — |
| 3 | `/api/clips` | GET | ses | M | list | | `secureRoute(…, {owner:"none"})`; `clipLibraryRoute` memfilter `ownsJob` | — |
| 4 | `/api/context/tokens` | GET, POST | ses | A | self | | Alias kompatibel ke `api_tokens` milik admin pemanggil, scope `trends:*` saja; dihapus setelah UI pindah ke `/api/account/tokens` (Fase 6+1 rilis) | web |
| 5 | `/api/context/tokens/[id]` | DELETE | ses | A | self | | Token bukan milik pemanggil → 404 | web |
| 6 | `/api/context/trends` | GET / POST | ses | GET M · POST A | — | | Tren instans-wide; menulis hanya admin | — |
| 7 | `/api/context/trends/[id]` | PATCH, DELETE | ses | A | — | | | web |
| 8 | `/api/context/trends/settings` | PUT | ses | M (scope user) · A (scope instance) | self | | Body `{enabled:boolean, scope?:"user"\|"instance"}`; tanpa `scope`: admin → `instance` (kompatibel), member → `user` | — |
| 9 | `/api/health` | GET | pub | — | — | ex | **Tidak berubah**: `{status, service}` saja (dipakai `wait_http_health`). Rincian di `/api/admin/health` | — |
| 10 | `/api/ingest/trends` | GET, POST, PUT, PATCH, DELETE | tok:`trends:read` (GET) / `trends:write` (lainnya) | pemilik token harus admin aktif | — | ex | `api-tokens.mjs` menggantikan `ingest-tokens.mjs`; cookie ditolak; body 256 KiB (tetap) | — |
| 11 | `/api/jobs` | GET | ses | M | list | ex | Self-auth `requireAuth` (sudah, baris 261; matcher mengecualikan seluruh path) + filter `ownsJob` | — |
| 11b | `/api/jobs` | POST | ses | M | menulis `ownerId` | ex | Self-auth (sudah) + admission per user (§10.1) + kuota (§10.4) + probe sumber (§11.2) + `source-url` (§11.4) | — |
| 12 | `/api/jobs/[id]` | GET, DELETE | ses | M | job | | `secureRoute({params:["id"], owner:"job"})` | job (`{error:"Job tidak ditemukan"}`) |
| 13 | `/api/jobs/[id]/cancel` | POST | ses | M | job | | idem; admin membatalkan job orang lain lewat `/api/admin/jobs/[id]/cancel` | job |
| 14 | `/api/jobs/[id]/files/[...path]` | GET, HEAD | ses | M | job | | idem; `[...path]` tetap divalidasi `safeJobFile` | `errorResponse("File not found",404)` |
| 15 | `/api/jobs/[id]/zip` | GET, HEAD | ses | M | job | | | `refusal("not_found",404)` (`clips-zip.mjs`) |
| 16 | `/api/jobs/[id]/assets` | POST | ses | M | job | ex | Self-auth `requireAuth` + `readOwnedJob` **sebelum** body dibaca | `uploadError("not_found",404)` |
| 17 | `/api/jobs/[id]/assets/[sha]` | GET, HEAD | ses | M | job | | | edit |
| 18 | `/api/jobs/[id]/apply-all/[batchId]/undo` | POST | ses | M | job | | | edit |
| 19 | `/api/jobs/[id]/clip-text` | PATCH | ses | M | job | | | `failure("not_found",404)` (`clip-text-api.mjs`) |
| 20 | `/api/jobs/[id]/clip-text/rewrite` | POST | ses | M | job | | LLM: env via `ownerEngineEnv` (§9.2) | idem |
| 21 | `/api/jobs/[id]/clips` | GET, POST | ses | M | job | | | edit |
| 22 | `/api/jobs/[id]/clips/[clipId]/ai` | POST | ses | M | job | | LLM: `ownerEngineEnv`; cap bersama | edit |
| 23 | `/api/jobs/[id]/clips/[clipId]/ai/[taskId]` | GET | ses | M | job | | Task milik job (sudah) | edit |
| 24 | `/api/jobs/[id]/clips/[clipId]/apply-all` | POST | ses | M | job | | | edit |
| 25 | `/api/jobs/[id]/clips/[clipId]/cleanup` | GET | ses | M | job | | | edit |
| 26 | `/api/jobs/[id]/clips/[clipId]/coldopen-suggestions` | GET | ses | M | job | | | edit |
| 27 | `/api/jobs/[id]/clips/[clipId]/edit` | GET, PUT | ses | M | job | | | edit |
| 28 | `/api/jobs/[id]/clips/[clipId]/hook` | POST | ses | M | job | | | edit |
| 29 | `/api/jobs/[id]/clips/[clipId]/media/[kind]/[name]` | GET, HEAD | ses | M | job | | | `plain(404,"Not found")` (`clip-media.mjs`) |
| 30 | `/api/jobs/[id]/clips/[clipId]/prepare` | POST | ses | M | job | | | edit |
| 31 | `/api/jobs/[id]/clips/[clipId]/preview/frame` | POST | ses | M | job | | | edit |
| 32 | `/api/jobs/[id]/clips/[clipId]/preview/plan` | POST | ses | M | job | | | edit |
| 33 | `/api/jobs/[id]/clips/[clipId]/renders` | GET, POST | ses | M | job | | POST: kuota (§10.4). Kunci fairness dibaca render-worker dari `job.json` `fairnessKey` (§10.3), tidak ada tulisan tambahan di sini | `renderError("not_found",404)` |
| 34 | `/api/jobs/[id]/clips/[clipId]/words` | GET | ses | M | job | | | edit |
| 35 | `/api/jobs/[id]/renders/[renderId]` | GET, DELETE | ses | M | job | | | `{error:"Render tidak ditemukan",code:"not_found"}` |
| 36 | `/api/llm/status` | GET | ses | M | self | | Status rantai **efektif** untuk principal (pribadi / instans-bersama + sisa unit / mati) | — |
| 37 | `/api/parity-fixtures/[...path]` | GET, HEAD | ses+flag `POTONGIN_PARITY_HARNESS=1` | M | — | | `sessionFromCookieStore`/`currentUser` menggantikan `verifySessionToken`; tetap 404 tanpa flag | — |
| 38 | `/api/resources/[kind]/[name]` | GET, HEAD | ses | M | — | | Font/paket bersama, tidak per user | — |
| 39 | `/api/settings/llm` | GET, PUT | ses | M (`?scope=user`) · A (`?scope=instance`) | self | | Default scope: `user`. Member ditolak 404 `web` bila `member_llm_keys_allowed=false` pada PUT | web |
| 40 | `/api/settings/llm/import-env` | POST | ses | A | — | | Hanya scope instance (key env milik instans) | web |
| 41 | `/api/settings/llm/models` | POST | ses | M · A(instance) | self | | Memakai key scope yang diminta | web |
| 42 | `/api/settings/llm/test` | POST | ses | M · A(instance) | self | | idem | web |
| 43 | `/api/settings/logo` | GET, POST, DELETE | ses | M | self | ex | Self-auth (sudah); direktori `users/<id>/` | — |
| 44 | `/api/settings/logo/[sha]` | GET, HEAD | ses | M | self | | sha dicari di direktori principal saja → 404 | edit |
| 45 | `/api/settings/system` | GET | ses | A | — | | "Tentang sistem" admin saja | web |
| 46 | `/api/settings/transcription` | GET, PUT | ses | M (`scope=user`) · A (`scope=instance`) | self | | Key Groq pribadi / instans | web |
| 47 | `/api/settings/watermark` | GET, PUT, DELETE | ses | M | self | | `users/<id>/default-watermark.json` | — |
| 48 | `/api/settings/youtube-cookies` | GET, POST, DELETE | ses | A | — | ex | Satu set global (Q4 default); self-auth + cek peran sebelum body dibaca | web |
| 49 | `/api/storage/status` | GET | ses | M | self | | Member: `{used, quota}` miliknya; admin: DTO global yang ada + per user | — |

### 8.2 API baru di dokumen ini

| Route | Method | Auth | Peran | Pemilik | Proxy | Re-auth | Request → Respons | Error |
|---|---|---|---|---|---|---|---|---|
| `/api/locale` | POST | pub (+ sesi bila ada) | — | self (hanya `users.locale` milik sesi) | ex | — | Kontrak lengkap **dok 07 §9.2** (form → 303, JSON → 200 `{locale}`) | dok 07 §9.2: 400 `invalid_request`/`locale_unsupported`, 403 `csrf_rejected`, 405, 413, 429 |
| `/api/auth/invite/accept` | POST | pub | — | — | ex | — | §6.3 | 303 `?error=` `link_invalid`, `username_*`, `password_*`, `password_mismatch`, `rate_limited` |
| `/api/auth/reset/complete` | POST | pub | — | — | ex | — | §6.4 | 303 `?error=` `link_invalid`, `password_*`, `password_mismatch`, `rate_limited` |
| `/api/auth/reauth` | POST | ses | M | self | | — | `{password}` → `{reauthUntil}` | 403 `password_wrong`, 429 |
| `/api/account` | GET | ses | M | self | | — | `{id, username, displayName, role, locale, timeZone, trendsEnabled, mustChangePassword, isSmoke, via, limits:{maxActiveJobs, maxRunningJobs, jobsPerHour, maxSourceSeconds, storageQuotaBytes, llmShare} (efektif; admin: null = tidak dibatasi), usage:{storageBytes, llmUnitsToday}}` | — |
| `/api/account` | PATCH | ses | M | self | | — | `{displayName?: string 1–60}` → akun | 400 |
| `/api/account/password` | POST | ses | M | self | | — | §6.5 | §6.5 |
| `/api/account/sessions` | GET, DELETE | ses | M | self | | — | §6.2 | — |
| `/api/account/sessions/[sid]` | DELETE | ses | M | self | | — | §6.2 | 404 web |
| `/api/account/tokens` | GET | ses | M | self | | — | `{tokens:[{id,label,prefix,scopes,createdAt,lastUsedAt,revokedAt}], maxActive:10, allowedScopes:[…]}` | — |
| `/api/account/tokens` | POST | ses | M | self | | — | `{label 1–40, scopes:[…] ⊆ allowedScopes(role)}` → 201 `{token:"ptk_…", meta}` (nilai token sekali) | 400 `scope_not_allowed`, 409 `token_limit`, 429 |
| `/api/account/tokens/[id]` | DELETE | ses | M | self | | — | 200 | 404 web |
| `/api/account/preferences` | GET, PATCH | ses | M | self | | — | GET → `{trendsEnabled, timeZone}`. PATCH JSON ≤ 1 KiB, patch parsial `{trendsEnabled?:boolean, timeZone?:string}` → 200 preferensi lengkap. `trendsEnabled` sejak MU-M6 (Fase 6); `timeZone` sejak i18n M7b (Fase 8): aturan validasi IANA dan header `X-Potongin-Auto: 1` (tulis hanya bila kolom masih NULL) di dok 07 §13.2–§13.3. Bahasa **tidak** lewat route ini (tetap `/api/locale`) | 400 `invalid_request`, 400 `account.time_zone_invalid`, 403 `csrf_rejected`, 413 `request_too_large` |
| `/api/admin/users` | GET | ses | A | — | | — | `?q=&status=&role=&page=` → `{users:[{id,username,displayName,role,status,isSmoke,createdAt,lastLoginAt,jobCount,storageBytes}], total}` | — |
| `/api/admin/users/[userId]` | GET | ses | A | — | | — | `{user:{…kolom daftar, locale, mustChangePassword, isBootstrap}, limits:{maxActiveJobs, maxRunningJobs, jobsPerHour, maxSourceSeconds, storageQuotaBytes, llmShare}` (nilai kolom; `null` = ikut default instans)`, sessions:[{id, deviceLabel, createdAt, lastSeenAt, via}]}` (tanpa secret) | 404 web |
| `/api/admin/users/[userId]` | PATCH | ses | A | — | | ✓ | `{role?, status?, limits?:{maxActiveJobs?,maxRunningJobs?,jobsPerHour?,maxSourceSeconds?,storageQuotaBytes?,llmShare?}}` (null = ikut default; nama field = kolom dok 01 dalam camelCase). `status:"disabled"` → `revokeUserSessions(…,'disabled')` → 200 bentuk GET | 409 `last_admin`, 409 `self_action_forbidden` (nonaktifkan/turunkan diri sendiri), 409 `smoke_user_locked` (semua PATCH ke user smoke), 400 `invalid_request` |
| `/api/admin/users/[userId]` | DELETE | ses | A | — | | ✓ | Hanya bila `status='disabled'` **dan** 0 job milik user (§9.5) → 200 `{ok:true}`. Hook: hapus `users/<id>/`, token, sesi; dok 03 menambah `disconnectAll` + purge (dok 03 §7.4) | 409 `user_has_projects`, 409 `user_active` |
| `/api/admin/users/[userId]/reset-link` | POST | ses | A | — | | ✓ | §6.4 | 409 `smoke_user_locked` |
| `/api/admin/users/[userId]/sessions` | DELETE | ses | A | — | | ✓ | Cabut semua sesi user → `{revoked:n}` | — |
| `/api/admin/users/[userId]/jobs` | GET | ses | A | — | | — | **Metadata saja**: `{jobs:[{id, status, createdAt, updatedAt, sourceType, clipCount, bytes}]}` — tanpa judul, URL, transkrip, nama file | — |
| `/api/admin/invites` | GET, POST | ses | A | — | | — | §6.3 | 400 `invalid_request`, 429 |
| `/api/admin/invites/[inviteId]` | DELETE | ses | A | — | | — | §6.3 → 200 `{ok:true}` | 404 web |
| `/api/admin/jobs` | GET | ses | A | — | | — | Antrean lintas user (metadata): `{jobs:[{id, ownerId, ownerUsername, status, held:null\|"maintenance"\|"owner_disabled", position, firstClaimedAt, createdAt, bytes}], paused, concurrency}` | — |
| `/api/admin/jobs/[id]/cancel` | POST | ses | A | — (admin) | | — | Memanggil jalur `cancelPrimaryJob` yang sama dengan route #13 → 200 `{ok:true}` | 404 job |
| `/api/admin/jobs/[id]/transfer` | POST | ses | A | — (admin) | | ✓ | `{toUserId}` → §9.5 → 200 `{ok:true}` | 404 job, 404 web (user tujuan), 409 `job_active` |
| `/api/admin/jobs/[id]` | DELETE | ses | A | — (admin) | | ✓ | `{confirm:"<8 char pertama id>"}` → `requestJobDeletion` → 202 | 400 `confirm_mismatch`, 404 job |
| `/api/admin/settings` | GET, PUT | ses | A | — | | ✓ (PUT) | `instance_settings` §3.3 dalam camelCase (`{llmShare, llmDailyCap, groqShare, youtubeCookiesShare, memberLlmKeysAllowed, memberMaxActiveJobs, memberMaxRunningJobs, memberJobsPerHour, memberMaxSourceSeconds, memberStorageQuotaBytes, inviteTtlHours, resetTtlHours}`; PUT patch parsial; kunci `social_*` tidak termasuk) | 400 `invalid_request` |
| `/api/admin/audit` | GET | ses | A | — | | — | `?userId=&code=&before=<id>&limit=` (default 20, maks 100) → `{events:[{id, at, code, params, actorKind, actorUserId, actorLabel, targetUserId, targetLabel, jobId}], next}` (nama = kolom `audit_events` dok 01 §4.1; `actorLabel`/`targetLabel` = snapshot username) | — |
| `/api/admin/health` | GET | ses | A | — | | — | Health rinci: versi, `schema_version`, ukuran DB, backup terakhir, status drain (termasuk penanda > 6 jam yang diabaikan), detak `process_heartbeats` per role, disk | — |

Route dari dokumen lain wajib memakai pola yang sama (gerbang `route-guard-coverage` berlaku untuk mereka); kontrak method/body/error-nya ada di dokumen pemilik:
- **Dok 03 §9 (sosmed/analitik):** `/api/social/**` (ses, M, pemilik = `social_connections.owner_id` / `publish_runs.owner_id`; `POTONGIN_SOCIAL=off` → 404 identik, `admin` → peran A), `/api/jobs/[id]/clips/[clipId]/posts` (ses, M, `owner:"job"`), `/api/social/callback/[provider]` (ses + `oauth_pending`), `/api/social/meta/{deauthorize,data-deletion}` (pub, ex, signed request Meta), `/api/social/media/[token]` (pub, ex, token HMAC 1 jam), `/api/settings/social-apps` (A, PUT re-auth), `/api/analytics/**`, `/api/posts/**`, `/api/settings/performance`, `GET /api/performance/template.csv` (ses, M, pemilik = `posts.owner_id`; `POTONGIN_PERFORMANCE=off` → 404 identik), `/api/performance/import/**` (ses, M; `POST` ex, self-auth upload), `/api/ingest/metrics` (tok:`metrics:write`, ex).
- **Dok 04 (unduhan):** `/api/settings/download-network` (A), `/api/admin/cache-unduhan` dan `/api/admin/cache-unduhan/clear` (`secureRoute({role:"admin", owner:"none"})`), `/api/jobs/[id]/clips/[clipId]/prepare` (sudah ada, #30).
- **Dok 06 (editor):** `/api/jobs/[id]/derived-clips` + `/[clipId]`, `/api/jobs/[id]/renders` (GET daftar), `/api/jobs/[id]/renders/batch`, `/api/jobs/[id]/clips/[clipId]/presence` (semua ses, M, `owner:"job"`, keluarga 404 `edit` kecuali dinyatakan lain).

### 8.3 Halaman

| Halaman | Auth | Peran | Pemilik | Catatan |
|---|---|---|---|---|
| `/` | pub | — | — | tetap |
| `/login` | pub | — | — | `?keluar=1` membersihkan draft (§6.2) |
| `/privasi`, `/ketentuan` | pub (exact path) | — | — | dok 03 |
| `/undangan/[token]`, `/atur-ulang-sandi/[token]` **(baru)** | pub (token) | — | — | §6.3, §6.4 |
| `/dashboard`, `/projects`, `/trends`, `/bantuan`, `/licenses` | ses | M | — | data lewat API ber-guard |
| `/projects/[id]` | ses | M | lewat API | API menjawab 404 → tampilan not-found |
| `/projects/[id]/candidates/[[...rest]]` | ses | M | lewat API | Halaman yang ada (`page.js`); sama seperti `/projects/[id]` |
| `/projects/[id]/clips/[clipId]/edit` | ses | M | job (server) | `readOwnedJob` → `notFound()` (§7.3) |
| `/settings` | ses | M | — | Tab instans hanya dirender untuk admin; data dari API ber-peran |
| `/akun`, `/akun/kata-sandi` **(baru)** | ses | M | self | |
| `/admin/pengguna`, `/admin/pengguna/[userId]`, `/admin/job` **(baru)** | ses | A | — | Layout server `app/admin/layout.jsx` **(baru)** memanggil `sessionFromCookieStore` → bukan admin → `notFound()`; proxy juga menolak (§4.5) |
| `/parity-harness`, `/parity-harness/player` | ses+flag | M | — | `sessionFromCookieStore` |

---
## 9. Rahasia, setting, dan berbagi per user

### 9.1 Tata letak setting

```
/control/settings/                       (POTONGIN_SETTINGS_DIR, 0700; hanya app + primary-worker)
  llm-settings.json                      instans (format v1 tetap → image lama bisa membaca)
  transcription.json                     instans
  youtube-cookies.json                   instans (satu set global)
  trend-context.json                     instans
  ingest-tokens.json                     dibiarkan untuk rollback setelah diimpor ke DB
  users/<userId>/                        (baru, 0700)
    llm-settings.json                    rantai AI pribadi (kotak sealing v2)
    transcription.json                   key Groq pribadi (v2)
    prefs.json                           cadangan preferensi non-rahasia (dok 01 §5.3); tidak dipakai di dokumen ini — saklar tren = kolom users.trends_enabled
    default-watermark.json
    default-logo/                        (nama sama dengan root: DEFAULT_LOGO_DIR, web/lib/default-logo.mjs:43)
```

Modul setting yang ada menerima argumen `scope` (`{kind:"instance"}` atau `{kind:"user", userId}`) yang menentukan direktori dan purpose sealing: `web/lib/llm-settings.mjs`, `web/lib/transcription-settings.mjs`, `web/lib/default-logo.mjs`, `web/lib/default-watermark.mjs`, `web/lib/youtube-cookies.mjs` (instans saja), `web/lib/trend-context.mjs` (instans saja; saklar per anggota = `users.trends_enabled`). Tes lama `llm-settings` untuk scope instans tidak diubah (info/salt/AAD v1 tetap).

`snapshotDefaultLogo` / `snapshotDefaultWatermark` (dipanggil `POST /api/jobs`) membaca dari `users/<ownerId>/`.

### 9.2 Sealing v2 dan env engine per pemilik

`web/lib/sealing.mjs` **(baru)**:

| Item | Nilai |
|---|---|
| Kunci | `HKDF-SHA256(ikm=POTONGIN_SETTINGS_SECRET, salt="potongin-sealing-v2", info=purpose + "\0" + scope)`, 32 byte; `scope` = `instance` atau `user:<userId>` |
| Cipher | AES-256-GCM, IV 12 byte acak, tag 16 byte |
| AAD | `"v2\0" + purpose + "\0" + scope + "\0" + field` (contoh field: nama provider) |
| Kotak | `{"v":2,"p":"<purpose>","iv":"<b64>","tag":"<b64>","ct":"<b64>"}` |
| Purpose | `llm`, `transcription`, `cookies`, `oauth-token` (dok 03), `social-app` (dok 03), `download-network` (dok 04). Purpose baru ditambah lewat PR ke daftar beku di modul. |
| API | `seal({purpose, scope, field}, plaintext) → kotak` dan `open({purpose, scope, field}, kotak) → string` (melempar `KEY_UNREADABLE`). `scope` = `"instance"` atau `"user:<userId>"`; `field` = AAD per nilai (mis. `account:<connectionId>\0access`, dok 03 §7.2). Pemanggil dengan objek `{kind:"user", userId}` (dok 01 §5.3) diubah ke string oleh helper `sealScopeOf(scope)`. |
| Kompatibilitas | Kotak v1 di root dibuka lewat jalur `llm-settings.mjs` yang lama. Kotak v2 lintas user/purpose gagal dibuka (`KEY_UNREADABLE`). |
| Secret | `POTONGIN_SETTINGS_SECRET` **wajib** (`${POTONGIN_SETTINGS_SECRET:?}` di compose `app` dan `primary-worker`). Runbook menyalin nilai `APP_SESSION_SECRET` ke sana agar kotak v1 tetap terbuka (kotak v1 ada di `web/lib/llm-settings.mjs` dan `seal()` `web/lib/youtube-cookies.mjs:69`; keduanya dibuka lewat jalur lama). Startup memperingatkan (Indonesia, stderr) bila kotak v1 contoh gagal dibuka. |

`web/lib/owner-env.mjs` **(baru)** — satu-satunya pembangun env anak proses engine. Dipecah dua karena `web/scripts/run-job.mjs` (anak `primary-worker`, `web/scripts/primary-worker.mjs:41`) **tidak** membuka DB (§3.1):

```js
// Bagian DB — dipanggil oleh proses yang boleh membuka DB (app, primary-worker):
export function ownerPolicy({ ownerId, purpose /* "job"|"editor_ai"|"clip_text" */, now })
// → { ownerId, role, trendsEnabled, llmShare, groqShare, cookiesShare, reservation }
//   llmShare efektif = users.llm_share ?? instance_settings.llm_share
//   reservation = reserveSharedUnits(ownerId, COST[purpose], now) bila owner member, tanpa rantai
//                 pribadi terbaca, dan llmShare; selain itu null.  Gagal cap → {denied:"llm_shared_cap"}

// Bagian tanpa DB — dipanggil run-job.mjs dan app:
export async function ownerEngineEnv({ policy, baseEnv })
// 1. mulai dari engineProcessEnv(baseEnv) (sudah membuang APP_PASSWORD, APP_SESSION_SECRET,
//    POTONGIN_SETTINGS_SECRET), lalu buang juga POTONGIN_DB_PATH, POTONGIN_OWNER_* dan
//    NODE_OPTIONS (daftar env anak yang dilarang: dok 01 §1.3 penegakan 2)
// 2. bila policy.role !== 'admin': buang semua nama isLlmVariable(name) dan GROQ_API_KEY
//    (key env milik instans TIDAK PERNAH dibagi ke anggota; admin tetap seperti sekarang)
// 3. rantai = rantai pribadi owner (users/<id>/llm-settings.json, scope user) bila ada dan terbaca
//    selain itu rantai instans (root llm-settings.json) bila policy.role==='admin'
//                atau policy.reservation berhasil
//    selain itu POTONGIN_LLM=off  (job tetap jalan dengan heuristik)
//    Catatan: buildLlmEnv(settings=null) hari ini mengembalikan env apa adanya (key env ikut,
//    `web/lib/llm-settings.mjs:723`). Untuk scope user dan untuk member, settings null
//    → POTONGIN_LLM=off, bukan env. Hanya admin + scope instans yang boleh jatuh ke env
//    (perilaku "source: env" sekarang).
// 4. Groq transkripsi: pribadi → instans bila admin atau groqShare → tanpa Groq (Whisper lokal)
// 5. OPENCV_FFMPEG_CAPTURE_OPTIONS="protocol_whitelist;file,pipe"   (§11.3)
// → { env, llmSource: "user"|"instance"|"shared"|"off" }
```

Alur job pipeline: `primary-worker` setelah `claimNextJob` → `effectiveOwnerId(job)` → `ownerPolicy({purpose:"job"})` → `runClaim` menambah env anak `POTONGIN_OWNER_POLICY=<JSON policy tanpa rahasia>` → `run-job.mjs` `engineEnvironment(env)` memanggil `ownerEngineEnv({policy: JSON.parse(env.POTONGIN_OWNER_POLICY)})`; tanpa variabel itu (image/worker lama) → perilaku sekarang. `run-job.mjs` juga membaca `policy.trendsEnabled` (§9.4) dan `policy.cookiesShare` (§9.3). Setelah anak keluar, `primary-worker` memanggil `settleSharedUnits(reservation)`. Tugas editor AI dan tulis ulang teks klip berjalan di proses `app`: route memanggil `ownerPolicy` (pemilik = `effectiveOwnerId(context.ownedJob.job)`, bukan principal — keduanya sama karena guard pemilik), lalu `settleSharedUnits` di `finally` setelah anak Python selesai.

Pemanggil yang diganti: `engineEnvironment()` (`web/scripts/run-job.mjs:256`), `web/lib/editor-ai.mjs` (`deps.loadLlmEnv`, baris 246/272), `web/lib/clip-text-api.mjs` (`deps.loadLlmEnv`, baris 155/217), opsi `withLlmEnv`/`loadLlmEnvImpl` di `runPythonCli` (`web/lib/python-cli.mjs:133-145`), dan uji/daftar model di `web/lib/llm-settings-actions.mjs:139` (`buildLlmEnv` untuk scope yang diminta saja; member tidak pernah memakai key env). `readEffectiveLlmStatus` (`web/lib/llm-settings.mjs:807`, dipakai `/api/llm/status`) menerima `policy` dan melaporkan sumber efektif + sisa unit.

**Cap bersama** (tabel `shared_llm_usage` dok 01 §4.2, kolom `calls` + `reserved`): satuan = "unit AI". Biaya `COST` (default, bisa diubah): job pipeline = 20, tugas AI editor = 1, tulis ulang teks klip = 1.
- `reserveSharedUnits(userId, cost, now)` dalam `tx`: baris hari UTC ini; tolak bila `calls + reserved + cost > llm_daily_cap`; selain itu `reserved += cost`. → `{day, cost}` atau `{denied:"llm_shared_cap"}`.
- `settleSharedUnits({day, cost})` dalam `tx`: `reserved -= cost`, `calls += cost` (jumlah panggilan nyata belum dilaporkan Python, §17 butir 1; unit dibebankan penuh, konservatif). Dipanggil juga untuk job gagal/batal.
- Reservasi yatim (worker mati sebelum settle): `prune.mjs` dok 01 memindahkan `reserved` hari < hari ini ke `calls`.
- Admin dan rantai pribadi tidak dihitung. Saat cap habis: job berjalan dengan heuristik dan `stageSummary` mendapat kode peringatan `llm_shared_cap` (katalog `errors`/`stage`); `/api/llm/status` menampilkan sisa unit `llm_daily_cap − calls − reserved`.

### 9.3 Cookies YouTube

Satu set global milik admin (`youtube-cookies.json` instans). `prepareYoutubeCookies` dipakai untuk job anggota bila `youtube_cookies_share=true`; kalau `false`, unduhan anggota tanpa cookie. Anggota tidak pernah bisa membaca/mengunduh file cookie (route #48 admin saja; salinan 0600 per job dihapus setelah yt-dlp selesai, perilaku sekarang). Scope cache unduhan dengan/tanpa cookie diatur dok 04 §B6.

### 9.4 Tren dan token API

- Tren instans-wide. Konteks tren dipakai di job bila `enabled` di `trend-context.json` (saklar instans, sekarang) **dan** `users.trends_enabled` pemilik job (default 1). `run-job.mjs` menerima nilai pemilik lewat env dari `primary-worker` (§9.2), tidak membuka DB.
- `web/lib/api-tokens.mjs` **(baru)**: format `ptk_` + 43 base64url sama; hash SHA-256; maks 10 aktif per user, 50 dicabut tersimpan; `last_used_at` paling sering 1×/menit; verifikasi lookup kolom `sha256` (indeks unik) + `timingSafeEqual`. Scope per peran:

| Scope | member | admin | Dipakai |
|---|---|---|---|
| `trends:read`, `trends:write` | ✗ | ✓ | `/api/ingest/trends` |
| `metrics:write` | ✓ | ✓ | `/api/ingest/metrics` (dok 03 §9, Fase 9) |
| `jobs:read`, `jobs:write`, `posts:write`, `metrics:read` | cadangan — ditolak 400 `scope_not_allowed` sampai ada route-nya | | |

- Impor (boot Fase 6): setiap entri `ingest-tokens.json` → `api_tokens` milik `bootstrap_owner_id` (`imported_from='ingest-tokens.json'`, hash/prefix/scope/waktu disalin). File asli tidak diubah. `meta.ingest_tokens_imported_at`. Audit `token.imported {tokenId, scopes}` per token. Image lama tetap memakai file → token agen tetap jalan saat rollback; token baru/dicabut setelah impor tidak tersinkron ke file (didokumentasikan).

### 9.5 Aksi admin atas proyek

- **Pindahkan** (`transferJob`): di bawah `withPrimaryQueueLock`; tolak 409 `job_active` bila status ∈ `ACTIVE_PRIMARY_STATUSES` atau ada render request non-terminal; tulis ulang `ownerId` **dan** `fairnessKey` di job.json (atomic, `durableWriteJson`); audit `job.transferred {fromLabel,toLabel}` + `job_id`, `target_user_id` = tujuan.
- **Hapus**: `requestJobDeletion()` yang ada (`web/lib/job-deletion.mjs`); audit `job.deleted_by_admin` + `job_id`.
- **Batalkan**: jalur `cancelPrimaryJob` yang ada; audit `job.cancelled_by_admin` (kode tambahan) + `job_id`.
- **Hapus pengguna**: hanya `disabled` + 0 job; proyek dikosongkan dulu lewat pindahkan/hapus (satu baris audit per proyek).

### 9.6 Kebocoran info instans

- `/api/settings/system` dan "Tentang sistem" (`web/lib/system-info.mjs`, `system-info-view.mjs`): admin saja.
- `/api/storage/status` (`web/lib/storage-status-dto.mjs`): member hanya `{usedBytes, quotaBytes|null}` miliknya.
- `/api/health`: tetap minimal; rincian di `/api/admin/health`.
- Respons error tetap melewati `redactServerPaths` (sudah ada).

### 9.7 Kode audit

Semua `code` + `params_json` (tanpa prosa, i18n M7a; dirender di bahasa penonton dari `audit.<code>`). Daftar dasar = tabel kode di dok 01 §4.1 (`bootstrap.admin_created`, `smoke.ensured`, `user.created|enabled|disabled|deleted`, `user.role_changed`, `user.password_changed`, `user.password_reset_issued`, `user.limits_changed`, `invite.created|revoked|used`, `session.revoked_all`, `token.created|revoked|imported`, `job.transferred`, `job.deleted_by_admin`, `settings.instance_changed`). **Kode tambahan** dari dokumen ini (ditambahkan ke daftar beku `web/lib/audit.mjs` lewat PR yang sama):

| `code` | `actor_kind` | `params_json` | Ditulis di |
|---|---|---|---|
| `auth.break_glass` | `user` | `{}` | §6.6 setiap login darurat |
| `user.admin_reset` | `cli` | `{"created":true\|false}` | `admin-reset.mjs --admin` |
| `job.cancelled_by_admin` | `user` | `{}` + `job_id` | `/api/admin/jobs/[id]/cancel` |
| `settings.migrated` | `system` | `{"files":N}` | settings-move (dok 01 §5.2) |
| `settings.defaults_copied` | `system` | `{"logo":true,"watermark":false}` | §14.2 langkah 8 |

`user.password_changed` memakai `{"via":"self"\|"reset"\|"cli"}`; `session.revoked_all` memakai `{"count":n,"scope":"self"\|"admin"}` dengan `target_user_id`. Retensi 180 hari (Q6) oleh `web/lib/db/prune.mjs` (dok 01 §9, dijalankan `app` 1×/24 jam, bukan di jalur request).

---

## 10. Antrean, kuota, dan drain

### 10.1 Admission per user (`POST /api/jobs`)

Urutan di route, sebelum byte upload pertama ditulis:
1. `requireAuth` + origin (ada).
2. `jobs_create` limiter: `jobs_per_hour` efektif → 429 `user_rate_limited`.
3. Hitung job aktif milik user (status `ACTIVE_PRIMARY_STATUSES` + reservation v3 milik user) ≥ `max_active_jobs` → 429 `user_queue_full`.
4. Kuota storage (§10.4) dengan `Content-Length` → 507 `user_storage_quota`.
5. `reserveAdmission(...)` (global, ada) → reservation membawa `ownerId` (v3, §10.2).

Batas efektif = kolom `users.*` bila non-NULL, selain itu `instance_settings.member_*` (§3.3). Admin dilewati di langkah 2–4.

### 10.2 Reservation v3 (expand → contract)

| Rilis | Baca | Tulis |
|---|---|---|
| R1 (Fase 6, MU-M7) | v1, v2, v3 | v2 (seperti sekarang); `ownerId` admission dihitung dari job.json saja |
| R2 (rilis berikutnya) | v1, v2, v3 | v3 = kunci v2 + `ownerId` |

`RESERVATION_V3_KEYS = [...RESERVATION_V2_KEYS, "ownerId"].sort()`. Rollback R2 → R1 aman (R1 membaca v3). Rollback ke sebelum R1 dilarang selama ada reservation v3 hidup (umurnya ≤ `RESERVATION_STALE_MS` = 60 menit; runbook: tunggu 60 menit atau drain).

### 10.3 Fairness

**Primary (`web/lib/primary-job-queue.mjs`):** `claimNextJob({…, policy})` menerima policy terinjeksi; modul tetap bebas DB.

```
policy default (legacy) = FIFO createdAt   (perilaku sekarang, dipakai bila policy tidak diberikan)
policy fair (primary-worker multi-user):
  kandidat = job aktif yang bisa diklaim (tanpa lease hidup, quiescent bila legacy)
  buang kandidat yang owner-nya disabled          → tampil "held: owner_disabled"
  buang owner yang running ≥ max_running_jobs
  lastServedAt(owner) = max(queue.firstClaimedAt) atas job owner yang belum terminal; tidak ada → -∞
  pilih owner dengan lastServedAt terkecil (seri → createdAt job tertua), lalu FIFO di dalam owner
```

`queue.firstClaimedAt` ditulis saat klaim pertama dan dipertahankan sampai terminal (field aditif di `queue` v1; image lama mengabaikan dan menghapusnya saat menulis ulang `queue` — konsekuensinya hanya fairness sementara). `web/scripts/primary-worker.mjs` membangun policy dengan membaca `users` (status, batas) dari DB.

**Posisi antrean:** `GET /api/jobs/[id]` menambah `queue.position` (1-based, menurut policy fair saat ini) dan `queue.etaSeconds` (median durasi 20 job terakhir yang selesai × posisi ÷ concurrency; `null` bila < 5 sampel). Ditampilkan di halaman proyek.

**Render-worker (`src/ai_clipper/render_worker.py`):** file request v3 punya set kunci ketat (`_V3_FIELDS`, `src/ai_clipper/render_queue.py:469`, dicek di :548; `KEYS` di `web/lib/clip-renders.mjs:57`), jadi kunci fairness **tidak** ditaruh di file request (koreksi terhadap roadmap §2.2-C). Sumber kunci = field aditif `job.json` `fairnessKey` (dok 01 §6.1–§6.2):

```
fairnessKey = "fk1_" + hex(HMAC-SHA256(K_fair, ownerId))[0:16]
K_fair      = HKDF-SHA256(POTONGIN_SETTINGS_SECRET, salt "potongin", info "fairness-v1")
```

Ditulis bersama `ownerId` oleh `POST /api/jobs` (dan `failedAdmissionRecord`), ditulis ulang saat transfer; `serializePublicJob` membuang keduanya. `run_one()` (baris 129) diubah persis seperti dok 01 §6.2: kandidat = job dengan `analysis/render-requests/`; `key(job)` = `fairnessKey` bila cocok `^fk1_[0-9a-f]{16}$`, selain itu `"legacy"`; pilih key dengan `last_served` (dict in-memory, `time.monotonic()`) terkecil; di dalam key urut nama job, `claim_next(job)` seperti sekarang. Python tidak membuka DB dan tidak tahu id user.

### 10.4 Kuota storage per user (MU-M8)

`web/lib/user-storage-usage.mjs` **(baru)**: `userUsageBytes(jobsRoot, userId)` = jumlah `scanJobsStorage` per direktori job milik user (cache per job dengan kunci `job.json mtime` + daftar render terakhir, TTL 60 dtk). Dicek di: `POST /api/jobs` (sebelum byte; dan saat recheck upload), `POST /api/jobs/[id]/assets`, `POST …/renders` (perkiraan = `declaredBytes` + `workReserveBytes` yang sudah dihitung `createClipRendersRoute` untuk `reserveRenderStorage`, `web/lib/clip-renders.mjs:301-303`, `web/lib/render-storage-admission.mjs:134`). Melewati → 507 `user_storage_quota` **sebelum** byte atau render request ditulis. `quota = NULL` → tidak dicek (global `JOBS_STORAGE_*` tetap berlaku). CLI render-worker hanya memeriksa batas global (tidak berubah).

### 10.5 Drain untuk deploy (MU-M7b)

Dokumen ini pemilik kontrak drain (nama, penanda, state, perilaku tiap komponen, urutan deploy); dok 08 §9.1/§9.3 hanya merinci fungsi shell-nya dan wajib mengikuti bagian ini.

Penanda: `JOBS_ROOT/.potongin-maintenance` (di `/data`, terlihat ketiga service) berisi `{"version":1,"since":"<ISO>","reason":"deploy"|"manual","sha":"<short>"}`. Penanda dengan `since` > 6 jam **diabaikan** worker (peringatan di log dan `/api/admin/health`) — pengaman bila skrip mati di tengah. `POTONGIN_ADMISSION_PAUSE=1` (env, compose `app`, `primary-worker`, **dan** `render-worker`) memaksa pause untuk operasi manual tanpa batas 6 jam.

Modul: `web/lib/maintenance-mode.mjs` **(baru)** `isMaintenancePaused({env, jobsRoot, now})` (sinkron) dipakai `primary-worker` sebelum klaim dan `GET /api/jobs/[id]`/`/api/admin/jobs` untuk `held`; `render_worker.py` membaca penanda yang sama (stdlib) sebelum klaim. CLI `web/scripts/maintenance.mjs` **(baru)** `on --reason deploy --sha <s>` / `off` / `status`.

**State machine:**

```
 normal ──drain_on──► draining ──(running_jobs kosong)──► drained ──deploy sehat: drain_off──► normal
                         │ timeout DRAIN_TIMEOUT_SECONDS (1800) → drain_off, exit 1 (tanpa up -d)
                         │ gagal setelah up -d → rollback(), lalu drain_off (trap EXIT)
```

"Kerja berjalan" (`running_jobs()` di `production.sh`, rinci dok 08 §9.3): job dengan `queue.lease` hidup atau status `running`; request render `claimed`/`rendering`; job.json/request yang tak terbaca ikut dihitung (memblokir, seperti `active_jobs()` hari ini). Job dan request `queued` **tidak** dihitung.

| Komponen | Saat pause |
|---|---|
| `POST /api/jobs` | Tetap 202; job ditulis `queued` seperti biasa (admission per user tetap berlaku) |
| `primary-worker` `claimNextJob` | Tidak mengklaim job baru; job berjalan diselesaikan |
| `render-worker` | Tidak mengklaim request baru; `claimed`/`rendering` diselesaikan |
| Simpan dokumen editor | Tetap jalan; ekspor masuk antrean |
| API/UI | `queue.held:"maintenance"` → "Antre · Pemeliharaan" (`status.process.queued` + `status.detail.maintenance`, dok 05/07) |

Urutan `deploy/production.sh` sejak Fase 6 (satu-satunya urutan resmi; langkah bernomor di §12.2): build image (di luar pause, supaya admission tidak tertahan selama build) → `drain_on` (container lama; bila image lama belum punya `scripts/maintenance.mjs` → `require_quiescent` seperti sekarang) → `trap 'drain_off' EXIT` → `wait_drained` → `db-backup` (dok 01 §7.1) → `up -d` → health → `run_read_only_e2e` → `require_no_running` (e2e read-only tidak boleh memulai kerja) → keluar (trap menjalankan `drain_off`). `drain_off` = `rm -f /data/jobs/.potongin-maintenance` sehingga jalan di image mana pun, termasuk setelah rollback. Sebelum Fase 6 (image tanpa MU-M7b): `require_quiescent` lama di awal dan akhir, tanpa drain.

## 11. Hardening input tak tepercaya (MU-M4b, wajib sebelum undangan)

### 11.1 Ancaman

Anggota mengontrol: byte file upload (sumber, SRT, logo, musik), URL sumber, teks (fokus, judul, hook), dan nama field form. Yang dilindungi: file lokal di container (`/control`, `/data/settings`, job orang lain), jaringan internal compose (`app:3000`, `pot-provider`), dan rahasia env.

### 11.2 Upload sumber (`POST /api/jobs`)

`web/lib/media-probe.mjs` **(baru)** + `src/ai_clipper/media_probe.py` **(baru)** (stdlib; dipanggil sebagai CLI `python -m ai_clipper.media_probe <path>`), dipakai setelah upload selesai dan **sebelum** job dipublikasikan ke antrean:

| Cek | Aturan | Kode bila gagal (400) |
|---|---|---|
| Ekstensi | `VIDEO_EXTENSIONS` yang ada | `source_rejected_format` |
| Magic bytes | `.mp4/.mov/.m4v`: kotak `ftyp` di offset 4; `.mkv/.webm`: `1A 45 DF A3` di offset 0 | `source_rejected_format` |
| Probe | `ffprobe -v error -protocol_whitelist file,pipe -f <mov\|matroska> [-enable_drefs 0 untuk mov] -show_entries format=format_name,duration:stream=codec_type,codec_name -of json -i /proc/self/fd/<fd>` (pola `_input_args` di `src/ai_clipper/edit_v2/assets.py`), timeout 20 dtk, `prlimit` seperti probe aset | `source_rejected_format` |
| `format_name` | Persis `mov,mp4,m4a,3gp,3g2,mj2` atau `matroska,webm`. Selain itu (termasuk `hls`, `concat`, `image2`, `*_pipe`, `tty`, `lavfi`) ditolak | `source_rejected_format` |
| Stream | ≥ 1 video; codec video ∈ {h264, hevc, vp8, vp9, av1, mpeg4}; audio (opsional) ∈ {aac, mp3, opus, vorbis, flac, ac3, eac3, pcm_*} | `source_rejected_codec` |
| Durasi | `0 < duration ≤ maxSourceSeconds`, dengan `maxSourceSeconds = min(POTONGIN_MAX_SOURCE_SECONDS, batas efektif user)` yang disalin app ke `job.limits.maxSourceSeconds` saat POST (Python tidak membuka DB; dok 04 §B4). Params `{limit}` dalam menit | `source_rejected_duration` |

Hasil probe (`format`, `duration`) disimpan di job.json `source.probe` (aditif). Pipeline menjalankan probe yang sama di awal (`pipeline.py`) untuk **semua** sumber, termasuk hasil unduhan, dan berhenti dengan kode yang sama bila gagal.

SRT (`validateSrt`, sudah), logo/musik (`edit_v2/assets.py`, sudah dengan fuzz) tidak berubah.

### 11.3 `-protocol_whitelist` dan dekoder lain

- Setiap argv `ffmpeg`/`ffprobe` di `src/ai_clipper/**` memuat `-protocol_whitelist file,pipe` sebelum setiap `-i`. File yang harus diubah: `pipeline.py` (`_thumbnail_command` dan lainnya), `render.py` (baris 102, 220, 395, 427, 507), `audio_timeline.py`, `media_features.py`, `transcribe_groq.py`, `edit_v2/peaks.py`. Yang sudah patuh tetap: `render_queue.py`, `edit_v2/{compile_ffmpeg,verify,assets,source_info,derive}.py`.
- Input sumber selalu diberi demuxer eksplisit dari `source.probe.format` (`-f mov` + `-enable_drefs 0`, atau `-f matroska`).
- faster-whisper (`transcribe.py:291` memberi path ke PyAV): audio diekstrak dulu oleh ffmpeg ber-whitelist ke WAV PCM 16 kHz mono sementara (atau array lewat pipe), lalu array/WAV itu yang diberikan ke model.
- OpenCV (`media_features.py:575`, `face_window.py:188`): env anak `OPENCV_FFMPEG_CAPTURE_OPTIONS="protocol_whitelist;file,pipe"` (dipasang `ownerEngineEnv`), ditambah probe gate di awal pipeline.
- Tes statis `tests/test_security_protocol_whitelist.py` **(baru)**: AST-scan semua literal list/tuple berisi `"ffmpeg"`/`"ffprobe"` dan pemanggil `_tool("ffmpeg")` di `src/ai_clipper`; gagal bila tidak ada `-protocol_whitelist` di argv yang sama (allowlist eksplisit dengan alasan untuk perintah tanpa `-i`, mis. `-version`).

### 11.4 URL sumber dan yt-dlp

`web/lib/source-url.mjs` **(baru)** + `src/ai_clipper/fetch/platforms.py` **(baru)** dengan fixture bersama `tests/fixtures/fetch/urls.json` **(baru)**. Inti dibangun di MU-M4b (YouTube saja); API lengkap, aturan per platform, dan perluasan Fase 7 (Twitch/Kick, `/live/`, `isLinkSource`, `sourceKeyOf`) dimiliki **dok 04 §B3**. Bentuk yang dibangun MU-M4b (sama dengan dok 04 §B3.1):

```js
export const PLATFORMS = Object.freeze({ youtube: { hosts: YOUTUBE_HOSTS, extractors: ["youtube"] } })  // MU-M4b
export class SourceUrlError extends Error { code }
export function parseSourceUrl(text, { platforms = ["youtube"] } = {})
//   → { platform, kind: "video", mediaId, url /* kanonik */, sourceKey: "youtube:<id>" } | throw SourceUrlError(code)
export async function assertPublicHost(url, { lookup = dns.promises.lookup } = {})  // semua alamat A/AAAA publik, selain itu throw SourceUrlError("source_private_address")
```

Job YouTube baru tetap menyimpan hasil `normalizeYouTubeUrl` di `source.url` (kompatibilitas image lama, dok 04 §B3.2); `url` kanonik hanya untuk argv yt-dlp.

| Aturan | Kode (400) |
|---|---|
| Skema `https` (http di-upgrade), tanpa userinfo, port kosong/443 | `source_host_not_allowed` |
| Host ∈ allowlist platform (pakai `normalizeYouTubeUrl` yang ada) | `source_host_not_allowed` |
| Resolve DNS: tolak loopback, RFC1918, link-local, CGNAT 100.64/10, ULA fc00::/7, `::ffff:` mapped privat, multicast, 0.0.0.0/8 | `source_private_address` |
| Playlist/channel/live ditolak di parse (`list=` dibuang; `/@…`, `/channel/…`, `/c/…`, `/playlist` ditolak; `/live/` ditolak di MU-M4b dan diterima sejak FETCH-M1 karena preflight dok 04 §B4 menolak siaran yang masih berlangsung dengan `source_live`) | `source_rejected_kind` |

Argv yt-dlp (`buildVideoDownload`, `buildCaptionDownloads` di `web/scripts/run-job.mjs`) menambah: `--ignore-config` (tidak membaca file config sistem/user), `--use-extractors youtube` (generic extractor mati), dan `--max-filesize <MAX_UPLOAD_BYTES>`; `--no-playlist` sudah ada. Opsi eksekusi (`--exec`) tetap tidak pernah dipakai. Snapshot argv diuji (`web/tests/worker-download.test.mjs` diperluas). `job.source.type` tetap `"youtube"` (skema `link` milik dok 04 §B3.3).

`assertPublicHost` dijalankan app saat `POST /api/jobs`; sejak FETCH-M1 diulang di worker tepat sebelum preflight (dok 04 §B3.4). Lapisan jaringan (rekomendasi, bukan syarat): yt-dlp berjalan di `primary-worker` yang satu network dengan `app`; DNS pre-check + extractor allowlist mencegah generic extractor. Pemisahan network compose ditunda ke dok 04.

### 11.5 Fuzz

- `scripts/security/make_upload_fuzz.py` (diubah): kind baru `source` — HLS `.mp4`, concat script `.mov`, image2 pattern, Matroska dengan referensi eksternal, MP4 dengan dref eksternal, polyglot MP4+HTML, file 0 byte, magic benar + isi rusak, durasi berbohong. Mode `http` mengirim `POST /api/jobs`. **Gate:** 100% ditolak 4xx atau diterima aman, 0 respons 5xx, 0 pembukaan protokol selain `file`/`pipe` (recorder ffmpeg/ffprobe dari `route_matrix.py recorders`).
- Fuzz auth (`web/tests/security-auth-fuzz.test.mjs` **(baru)**): cookie v1 palsu, s2 dengan sid acak, s2 dicabut, s2 kedaluwarsa, sid milik A + secret milik B, token terlalu panjang/NUL/unicode, dua cookie sekaligus → semua 401 identik; `ptk_` milik member ke `/api/ingest/trends` → 403/401 sesuai kode route; token undangan/reset (acak, terpakai, dicabut, kedaluwarsa, panjang salah) → respons identik.
- `scripts/security/route_matrix.py` (diubah) + `scripts/security/route_policy.json` **(baru)**: kebijakan per route × method (auth, peran, pemilik, proxy) yang ditulis dari matriks §8; skrip mencakup **semua** route (`app/api/**`), dua user + admin + user smoke, dan gagal bila ada route tanpa entri kebijakan (termasuk route dok 03/04/06 saat dibuat).

---
## 12. Deploy, compose, env

### 12.1 `compose.yaml`

| Service | Perubahan |
|---|---|
| `app` | volume `potongin_control:/control`; env `POTONGIN_DB_PATH=/control/potongin.sqlite`, `POTONGIN_SETTINGS_DIR=/control/settings` (dari `/data/settings`), `POTONGIN_SETTINGS_SECRET: ${POTONGIN_SETTINGS_SECRET:?…}`, `POTONGIN_ADMISSION_PAUSE: ${POTONGIN_ADMISSION_PAUSE:-0}`, `POTONGIN_MAX_SOURCE_SECONDS: ${POTONGIN_MAX_SOURCE_SECONDS:-14400}`, `POTONGIN_PUBLIC_URL` (untuk tautan undangan/reset), `E2E_SMOKE_USERNAME`/`E2E_SMOKE_PASSWORD` (dibaca `start-app.mjs` saat boot, logika sama dengan `admin-reset.mjs --ensure-smoke-user`). `Dockerfile` `CMD` → `node scripts/start-app.mjs` (dok 01 §2.1) |
| `primary-worker` | volume `potongin_control:/control`; `POTONGIN_DB_PATH`, `POTONGIN_SETTINGS_DIR=/control/settings`, `POTONGIN_SETTINGS_SECRET` wajib, `POTONGIN_ADMISSION_PAUSE` |
| `render-worker` | **Tanpa** `/control` dan tanpa `POTONGIN_DB_PATH`/`POTONGIN_SETTINGS_*` (tetap `clipper_data:/data`); tambah `POTONGIN_ADMISSION_PAUSE` (§10.5) |
| `volumes:` | `potongin_control: {}` |

`.env.example` (diubah) menambah semua variabel di atas + `E2E_SMOKE_*` dan `AUTH_TRUSTED_CLIENT_IP_HEADER`; dijaga `web/tests/env-example.test.mjs`.

### 12.2 `deploy/production.sh`

Fungsi shell lengkap: dok 08 §9.1–§9.3. Urutan (Fase 4–5: langkah 2–3 diganti `require_quiescent` di awal, dan langkah 8 diganti `require_quiescent`):

1. Build image baru (`IMAGE_TAG=$DEPLOY_SHA … build app`), tag image lama untuk rollback.
2. `drain_on` + `trap 'drain_off' EXIT` (§10.5).
3. `wait_drained`; timeout → exit 1 **sebelum** container diganti (tidak perlu rollback).
4. `db-backup` dengan image baru (`docker compose run --rm --no-deps --entrypoint node app scripts/db-backup.mjs --reason deploy`, dok 01 §7.1, pemilik backup) → `DB_BACKUP=<path>` (atau `none` sebelum DB ada); gagal → berhenti sebelum container diganti.
5. `trap rollback ERR`; `up -d --no-build --remove-orphans`, `wait_http_health`, `wait_primary_health`, `wait_social_health` (no-op sebelum service ada, dok 08 §9.4), `verify_runtime_identity` (ditambah: mount `/control` ada di app + primary (+ social), **tidak ada** di render-worker).
6. `run_read_only_e2e` memakai `E2E_SMOKE_USERNAME`/`E2E_SMOKE_PASSWORD` (bukan `APP_*`), sehingga pemilik bebas mengganti sandinya tanpa memicu rollback otomatis.
7. `require_no_running` (penanda masih ada; memastikan e2e tidak memulai kerja).
8. Keluar → trap `drain_off`. `rollback()`: `up -d` image lama (aturan `--scale social-worker=0` untuk image tanpa label social-worker: dok 08 §9.4), tunggu health `|| true`, lalu `drain_off` lewat trap.

Tes: `tests/test_deploy_guard.py` (kasus drain timeout sebelum `up -d`, trap `drain_off` terpasang sebelum `wait_drained`, `db-backup` sesudah `wait_drained` dan sebelum `up -d`, e2e memakai smoke) dan `web/tests/deploy-env-contract.test.mjs` **(baru)** (env **dan** mount per service; `E2E_SMOKE_*` dipakai `run_read_only_e2e`; DB hanya di app/primary/social; `POTONGIN_SETTINGS_SECRET` `:?`).

### 12.3 Runbook (`docs/operations/PENGGUNA.md` **(baru)**)

1. Salin nilai `APP_SESSION_SECRET` ke `POTONGIN_SETTINGS_SECRET` di `.env`.
2. Isi `E2E_SMOKE_USERNAME`/`E2E_SMOKE_PASSWORD` (sandi acak ≥ 20 char) dan `AUTH_TRUSTED_CLIENT_IP_HEADER`.
3. Deploy (drain otomatis).
4. Verifikasi: login pemilik (cookie v1 ter-upgrade), `/akun` menampilkan admin, e2e smoke hijau, `DB_BACKUP` tercetak.
5. Sebelum undangan pertama: MU-M4b hijau; `POTONGIN_LOCALES=id` (Q9 final: English dirilis bersama fase editor, pratinjau `id,en` hanya sebelum ada anggota); pemilik mengganti sandinya di `/akun/kata-sandi`; `admin-reset.mjs --purge-legacy-settings` sudah dijalankan (dok 01 §5.2); `multiuser-isolation.spec` hijau di CI.
6. Break-glass: login dengan `APP_*`, atau `docker compose exec app node scripts/admin-reset.mjs --admin <username>`.

---

## 13. Tes

Ditulis lebih dulu; tidak ada ambang yang dilemahkan. Di PC pemilik hanya file yang disentuh (`node --test web/tests/<file>`, `pytest tests/<file>`); suite penuh, Playwright, dan fuzz di GitHub Actions.

### 13.1 Gerbang keamanan

| Tes | Isi | Fase |
|---|---|---|
| `web/tests/ownership-matrix.test.mjs` **(baru)** | Untuk **setiap** `app/api/**/route.js` × method yang diekspor × principal {A member pemilik, B member, Admin, anonim}: job J milik A + id acak tak ada. B→J dan Admin→J harus identik dengan B→acak (status, body byte-per-byte, semua header kecuali `date`), termasuk `code`/`messageId`. Recorder spawn (pola `security-support.mjs`) = 0 untuk B/Admin. A→J tidak 404. Route admin: member→X identik dengan admin→id-tak-ada. Daftar (`/api/jobs`, `/api/clips`, `/api/storage/status`) untuk B tidak memuat id/ukuran milik A. | 5 |
| `web/tests/route-guard-coverage.test.mjs` **(baru)** | `@babel/parser` atas semua file route: setiap method harus `secureRoute(handler, {…})` dengan `owner` eksplisit bila path memuat `[id]`, dan `role` eksplisit di bawah `/api/admin/`; atau masuk `ALLOWLIST` dengan alasan: `auth/login`, `auth/logout`, `auth/invite/accept`, `auth/reset/complete`, `locale`, `health`, `ingest/trends` (token), `jobs` POST, `jobs/[id]/assets` POST, `settings/logo`, `settings/youtube-cookies` (self-auth upload), `parity-fixtures` (flag), plus route publik/self-auth dok 03 (`social/meta/*`, `social/media/[token]`, `performance/import` POST, `ingest/metrics`) saat dibuat. Allowlist baru tanpa alasan → gagal. Tes dibuat di MU-M3; sebelum itu `/api/locale` (Fase 1) hanya didaftarkan di `proxy-matcher` | 5 |
| `web/tests/authorize-sync-contract.test.mjs` **(baru)** | §4.4 | 4 |
| `web/tests/proxy-matcher.test.mjs` (diubah) | Pengecualian baru + alasan; halaman token & `/privasi`/`/ketentuan` exact-path; member ke `/admin/*` → 404 | 1, 4, 6 |
| `web/tests/security-support.mjs` (diubah) | `routeFiles()` memindai seluruh `app/api` (sekarang hanya `app/api/jobs/[id]`, `web/tests/security-support.mjs:133-134`) | 5 |
| `web/tests/security-routes.test.mjs`, `request-security.test.mjs`, `security-headers.test.mjs` (diperluas) | Setiap route baru: 401 tanpa sesi, 403 origin asing, header keamanan, redaksi path | 4–6 |
| `web/tests/security-child-env.test.mjs` (diperluas) + `owner-env.test.mjs` **(baru)** | Anak milik member dengan berbagi mati: tanpa `*_API_KEY`/`GROQ_API_KEY` env walau ada di `process.env`; `POTONGIN_LLM=off`; tidak ada `POTONGIN_DB_PATH`, `POTONGIN_SETTINGS_SECRET`, `APP_*` di env anak mana pun; `OPENCV_FFMPEG_CAPTURE_OPTIONS` ada | 5 |
| `web/tests/security-auth-fuzz.test.mjs` **(baru)** | §11.5 | 4 |
| `tests/test_security_protocol_whitelist.py` **(baru)** | §11.3 | 6 |
| `tests/test_security_media_probe.py` **(baru)** | Tabel §11.2 dengan fixture yang dibuat saat tes (FFmpeg di CI) | 6 |
| `web/tests/source-url.test.mjs` **(baru)** + `tests/test_fetch_platforms.py` **(baru)** | Fixture bersama `tests/fixtures/fetch/urls.json`: hasil JS = Python; resolver palsu untuk setiap rentang IP privat | 6 |
| `scripts/security/make_upload_fuzz.py` kind `source` + `route_matrix.py` semua route | §11.5; dijalankan `editor-gates.yml suite=command` | 6 |
| `web/e2e/multiuser-isolation.spec.mjs` **(baru)** | Dua user nyata di browser: B membuka URL proyek/editor/ZIP/media A → not-found; daftar B kosong; logout lalu tombol Back tidak menampilkan data | 5 |

### 13.2 Fungsional

| Tes | Isi |
|---|---|
| `web/tests/db-migrations.test.mjs` **(baru, milik dok 01 §11)** | Dirujuk saja: idempoten, skema baru diterima kode lama, lint aditif, path DB di dalam `JOBS_ROOT` ditolak |
| `web/tests/users.test.mjs` (bagian bootstrap) | `APP_USERNAME` berhuruf besar → dinormalisasi; tidak lolos pola §6.7 → start gagal; `is_bootstrap` tidak bisa dihapus |
| `web/tests/owner-env.test.mjs` (bagian alur job) | `run-job.mjs` tidak mengimpor `web/lib/db/*` (graf impor statis, pola `sqlite-import-boundary` dok 01); `POTONGIN_OWNER_POLICY` hilang → perilaku lama; `settleSharedUnits` dipanggil untuk job sukses/gagal/batal |
| `web/tests/passwords.test.mjs` **(baru)** | Format, rehash, kebijakan, dummy hash dipanggil untuk user tak dikenal, semaphore 429 |
| `web/tests/sessions.test.mjs` **(baru)** | §4 state machine, batas 20, upgrade v1 sekali, logout mencabut di server (token lama → 401), ganti sandi mencabut sesi lain + rotasi |
| `web/tests/users.test.mjs`, `invites.test.mjs`, `password-resets.test.mjs`, `api-tokens.test.mjs` **(baru)** | State machine §6.3/§6.4; anti-enumerasi; `last_admin`; `self_action_forbidden`; smoke terkunci; impor `ingest-tokens.json` (hash cocok, token lama tetap lolos `/api/ingest/trends`) |
| `web/tests/login-rate-limit.test.mjs` (diubah) | Ambang tidak berubah; kunci IP + username; break-glass ikut dibatasi |
| `web/tests/sealing-v2.test.mjs` **(baru)** | Round-trip; lintas user / lintas purpose / AAD salah gagal; kotak v1 tetap terbuka |
| `web/tests/queue-fairness.test.mjs` **(baru)** | A antre 10, B antre 1 belakangan → B klaim ke-2 pada concurrency 1; `max_running_jobs`; owner disabled ditahan; policy default = FIFO (tes `primary-job-queue` lama tidak diubah) |
| `tests/test_render_worker.py` (diperluas) | Round-robin per `job.json` `fairnessKey`; tidak ada/rusak → `legacy`; tanpa DB (berkas tes baru dok 01: `tests/test_render_worker_fairness.py`) |
| `web/tests/reservation-v3.test.mjs` **(baru)** | R1 membaca v2/v3 menulis v2; R2 menulis v3; dua arah |
| `web/tests/maintenance-mode.test.mjs` **(baru)** + kasus di `tests/test_render_worker.py` + `tests/test_deploy_guard.py` | §10.5, §12.2 (penanda > 6 jam diabaikan; env `POTONGIN_ADMISSION_PAUSE` di ketiga service) |
| `web/tests/user-storage-usage.test.mjs` **(baru)** | 507 sebelum byte/request tertulis; quota NULL tidak dicek |
| `web/tests/deploy-env-contract.test.mjs` **(baru)** | §12.2 |
| e2e `web/e2e/admin.spec.mjs`, `account.spec.mjs` **(baru)** | Undang → terima → login; reset link; nonaktifkan → sesi target mati; re-auth modal; member ke `/admin/pengguna` → 404; login pertama `must_change_password` → `/akun/kata-sandi` |
| `web/e2e/read-only.spec.mjs`, `smoke.spec.mjs` (diubah) | Lulus dengan user smoke (member, proyek kosong, tidak bisa membuat job) |

---

## 14. Migrasi data single-user

### 14.1 Boot pertama image multi-user (Fase 4), oleh `web/scripts/start-app.mjs`

Urutan resmi = dok 01 §10; ringkasan dan bagian milik dokumen ini:

1. (`production.sh`) `db-backup` → `DB_BACKUP=none` pada boot pertama.
2. Validasi env, lalu **pindah settings** `/data/settings` → `/control/settings` (`web/lib/db/settings-move.mjs`, dok 01 §5.2: salin + sha256 + penanda `.migrated-from-data`; `/data/settings` **tidak** dihapus di rilis ini). Audit `settings.migrated {files}` dan `meta.settings_migrated_at` ditulis setelah langkah 3.
3. `openDb({role:"app"})` → `migrate()` (`0001` di Fase 4; `0002` mulai Fase 5).
4. `users` kosong → bootstrap admin dari `APP_*` (§6.6), `is_bootstrap=1`, `meta.bootstrap_owner_id`.
5. `E2E_SMOKE_*` ada → user smoke (§6.6, `smoke.ensured`).
6. Tidak ada job.json yang ditulis ulang. `effectiveOwnerId(job) = job.ownerId ?? meta.bootstrap_owner_id`.

### 14.2 Fase 6 (MU-M9)

7. (boot, sekali, idempoten) Impor `ingest-tokens.json` ke `api_tokens` (§9.4, `INSERT OR IGNORE` by `sha256`).
8. (boot, sekali) Salin `default-logo/` dan `default-watermark.json` root ke `users/<bootstrap>/` (`meta.defaults_copied_at`, audit `settings.defaults_copied`); file root dibiarkan (dibaca image rollback).
9. `web/scripts/multiuser-migrate.mjs` **(baru)**, opsional: `--dry-run` (default) mencetak rencana; `--apply` mengisi `ownerId=<bootstrap>` + `fairnessKey` untuk job **terminal** di bawah `withPrimaryQueueLock` (job aktif dilewati dan dilaporkan). Idempoten. Penghapusan `/data/settings` **bukan** di sini, tetapi `admin-reset.mjs --purge-legacy-settings` (dok 01 §5.2), wajib sebelum undangan pertama.
10. Drill CI lama→baru→lama di volume fixture: image lama setelah boot baru tetap melihat semua job; compose baru + image lama sehat; `DB_BACKUP` dipulihkan lewat `db-restore.mjs` dan lolos `integrity_check`.

### 14.3 Rollback

| Lapisan | Mekanisme | Catatan |
|---|---|---|
| Image → single-user | Image lama mengabaikan DB, `ownerId`, `fairnessKey`, penanda maintenance | Semua job terlihat oleh login `APP_*`. User/token/setting pribadi baru tidak terlihat. |
| Cookie | s2 tidak dikenal image lama | Login ulang dengan `APP_*` |
| Skema | Aditif | Jangan rollback melewati migrasi contract (belum ada di dokumen ini) |
| Reservation | §10.2 | |
| Sealing | Kotak v1 root tetap | Mengganti `POTONGIN_SETTINGS_SECRET` = semua kotak v2 tak terbaca (akun sosmed masuk reauth) |
| Drain | `rollback()` memanggil `drain_off` | |

---

## 15. Milestone, file, dan kriteria selesai

| Milestone (fase, hari-dev) | File utama | Selesai bila |
|---|---|---|
| **MU-M1 + MU-M2 + migrasi setting** (F4, 10–12 + ≈1) | Baru: `web/lib/db/{index,migrate,prune,settings-move}.mjs` + `0001-identity.sql` (dok 01), `web/scripts/{start-app,db-backup,db-restore,admin-reset}.mjs`, `web/lib/{passwords,sessions,users,audit,instance-settings}.mjs`, `resources/auth/common-passwords.txt`, `web/tests/support/session.mjs`. Diubah: `web/lib/auth.mjs`, `web/proxy.js`, `app/api/auth/{login,logout}/route.js`, 3 halaman server + `parity-fixtures`, pembaca cookie §4.6 (`web/lib/{security-headers,default-logo,asset-upload,preview-lane}.mjs`), `web/lib/editor/draft-store.mjs`, `Dockerfile` (CMD), `compose.yaml`, `.env.example`, `deploy/production.sh`, `web/e2e/{read-only,smoke}.spec.mjs` | Migrasi idempoten; skema baru diterima kode lama; backup lolos `integrity_check`; cookie v1 di-upgrade sekali; logout mencabut di server; bucket rate limit per user (§4.6); `authorize-sync-contract` hijau; ambang `login-rate-limit` tetap; read-only/smoke lolos dengan anggota smoke berproyek kosong; `deploy-env-contract` (env + mount `/control`) hijau; perangkat kedua memakai `users.locale`; gitleaks bersih |
| **MU-M3** (F5, 11–13) | Baru: `web/lib/job-ownership.mjs` (termasuk penulisan `ownerId` + `fairnessKey` saat job dibuat), tes §13.1. Diubah: `web/lib/security-headers.mjs`, 49 route (§8.1), 18 lib route (`clip-edit`, `clip-text-api`, `clips-zip`, `final-files`, `clip-media`, `preview-lane`, `preview-source`, `editor-ai`, `camera-progress`, `coldopen-suggestions`, `apply-all`, `job-cancel`, `job-deletion`, `clip-hook-api`, `clip-renders`, `asset-upload`, `llm-settings-http`, `trend-context`), `web/lib/{jobs,clip-library,primary-job-queue}.mjs` (`serializePublicJob`, `failedAdmissionRecord`), `app/api/jobs/route.js` | Setiap route × method lintas user → 404 identik + nol spawn; admin tanpa opt-in 404; `route-guard-coverage` tanpa entri allowlist tanpa alasan; `multiuser-isolation.spec` hijau; jalur v1 cookie dihapus |
| **MU-M4** (F5, 6) | Baru: `web/lib/{sealing,owner-env}.mjs`, `0002-shared-llm-usage.sql` (dok 01 §4.2). Diubah: modul setting §9.1, `web/scripts/{run-job,primary-worker}.mjs`, `web/lib/{python-cli,editor-ai,clip-text-api,llm-settings,llm-settings-actions,llm-status,system-info,storage-status-dto}.mjs`, `app/settings/page.jsx` (tab per peran) | Member dengan berbagi mati: env anak tanpa key LLM/Groq walau ada di env, job selesai heuristik; kotak lintas user/purpose gagal dibuka; Tentang sistem + status storage global + health rinci hanya admin; cap unit ditegakkan |
| **MU-M4b** (F6 langkah 1, 4) | Baru: `web/lib/{media-probe,source-url}.mjs`, `src/ai_clipper/{media_probe,fetch/__init__,fetch/platforms}.py`, `tests/fixtures/fetch/urls.json`, `scripts/security/route_policy.json`, tes §11 (nama file: §13.1). Diubah: `app/api/jobs/route.js`, `web/scripts/run-job.mjs`, 6 file Python §11.3, `transcribe.py`, `scripts/security/{make_upload_fuzz,route_matrix}.py` | Fuzz `source` 100% ditolak/aman, 0 5xx, 0 protokol selain file/pipe; whitelist statis hijau; argv yt-dlp snapshot memuat `--ignore-config --use-extractors youtube`; IP privat ditolak sebelum spawn. **Gerbang undangan.** |
| **MU-M5 + dashboard F7** (F6, ≈7–8) | Baru: halaman `/admin/pengguna[/<id>]`, `/admin/job`, `/akun`, `/akun/kata-sandi`, `/undangan/[token]`, `/atur-ulang-sandi/[token]`, `app/admin/layout.jsx`, `web/lib/{invites,password-resets,account-errors}.mjs`, API `/api/account/*`, `/api/admin/*`, `/api/auth/{invite/accept,reset/complete,reauth}`. Diubah: `web/lib/{app-nav,app-menu,help-catalog}.mjs` | e2e admin/account hijau; re-auth ditegakkan; semua kode error baru punya `errors.*` di id + en dan entri Bantuan |
| **MU-M6** (F6, 2,5) | Baru: `web/lib/api-tokens.mjs`, `app/api/account/preferences/route.js` (GET/PATCH `trendsEnabled`; `timeZone` ditambah i18n M7b, Fase 8). Diubah: `web/lib/ingest-tokens.mjs` (pembaca impor), `app/api/ingest/trends/route.js`, `app/api/context/**` | Token lama tetap lolos setelah impor; member tidak bisa membuat `trends:*`; saklar tren per anggota memengaruhi job anggota itu saja |
| **MU-M7** (F6, 4) | Diubah: `web/lib/primary-job-queue.mjs`, `web/scripts/primary-worker.mjs`, `src/ai_clipper/render_worker.py` (kunci dari `job.json` `fairnessKey`), `app/api/jobs/[id]/route.js` (posisi), tes `tests/test_render_worker_fairness.py` **(baru)** | `queue-fairness` hijau; render round-robin; CLI render-worker jalan tanpa `POTONGIN_DB_PATH`; reservation dua arah |
| **MU-M7b** (F6, 3) | Baru: `web/scripts/maintenance.mjs`, `web/lib/maintenance-mode.mjs`, `web/tests/maintenance-mode.test.mjs`. Diubah: `deploy/production.sh`, `tests/test_deploy_guard.py`, queue + render-worker | Deploy dengan job aktif masuk drain dan selesai; timeout membatalkan deploy dengan penanda terhapus |
| **MU-M8** (F6, 3,5) | Baru: `web/lib/user-storage-usage.mjs`. Diubah: `app/api/jobs/route.js`, `web/lib/{asset-upload,clip-renders,storage-admission}.mjs` | Melewati kuota → 507 sebelum byte/request tertulis |
| **MU-M9** (F6, 4) | Baru: `web/scripts/multiuser-migrate.mjs`, `docs/operations/PENGGUNA.md`. Diubah: `docs/operations/STORAGE_RETENTION.md` (bagian metadata kontrol, Q6) | Drill lama→baru→lama hijau termasuk compose baru + image lama |

---

## 16. Kode error baru (wajib `errors.*` di id + en dan entri Bantuan)

Dokumen ini pemilik daftar kode di bawah; domain `messageId`, kunci katalog, dan pesan mengikuti dok 07 §10 (`errors.<domain>.<code>`). Kode tidak boleh diganti nama di dokumen lain (contoh: kuota storage per user = `user_storage_quota`, bukan `quota_exceeded`).

| Domain (`messageId`) | Registry | Kode |
|---|---|---|
| `web.*` | `web/lib/error-codes.mjs` (dok 07 §10.2) | `unauthorized`, `password_change_required`, `reauth_required`, `not_found`, `job_not_found`, `rate_limited`, `login_invalid` (hanya kunci UI untuk `?error=1`, §6.1), `user_queue_full`, `user_rate_limited`, `user_storage_quota`, `source_rejected_format`, `source_rejected_codec`, `source_rejected_duration`, `source_rejected_kind`, `source_host_not_allowed`, `source_private_address` |
| `account.*` | `web/lib/account-errors.mjs` **(baru, MU-M5)** | `link_invalid`, `username_invalid`, `username_taken`, `password_too_short`, `password_too_long`, `password_common`, `password_same_as_username`, `password_mismatch`, `password_wrong`, `scope_not_allowed`, `token_limit`, `last_admin`, `self_action_forbidden`, `smoke_user_locked`, `user_has_projects`, `user_active`, `job_active`, `confirm_mismatch`, `time_zone_invalid` (dok 07 §13.2) |

Kode peringatan `llm_shared_cap` (katalog `stage`, dok 07); status `held: maintenance | owner_disabled` (kata layar milik dok 05: "Antre · Pemeliharaan", "Antre · Pengguna nonaktif"). Kode sumber milik unduhan (`source_live`, `source_platform_off`, `download_*`) ada di dok 04 §B13.

---

## 17. Celah yang belum tertutup

**Terbuka di dokumen ini**

1. **Biaya unit AI per job (20)** adalah tebakan: pemanggilan LLM di dalam Python tidak dihitung satu per satu. Angka diukur di MU-M4 sebelum cap dinyalakan (dok 01 §12 #5); penghitungan akurat butuh `llm.py` melaporkan jumlah panggilan ke manifest.
2. **Isolasi jaringan** yt-dlp dari `app:3000` hanya lewat DNS pre-check + extractor allowlist; pemisahan network compose diserahkan ke dok 04.
3. **Rate limit in-memory** hilang saat restart container app; diterima untuk satu container, perlu tabel bila app diskalakan (dok 01 §12 #3).
4. **Break-glass mengabaikan status `disabled`** (default, bisa diubah); alternatifnya break-glass hanya via CLI.
5. **`--use-extractors youtube`**: perilaku pencocokan nama extractor yt-dlp (persis vs regex, mis. `youtube:tab`) belum diverifikasi; MU-M4b wajib menambah tes yang menjalankan yt-dlp terpin dengan URL `https://example.com/x.mp4` dan memastikan ditolak sebelum unduh (nama extractor platform lain dikunci di FETCH-M0, dok 04 §B3.4).
**Penyelarasan dokumen lain:** selesai pada pemeriksaan silang akhir 2026-10-24
([00-README.md](00-README.md) §8): seed dan kode audit 01 §4.1 (termasuk `cache.cleared`,
`download_network.changed` dari 04), field `job.json` `limits.maxSourceSeconds` (01 §6.1), draft
editor di IndexedDB, `seal`/`open` dengan `field` di 03 §7.2, tabel API 05 §6.11–§6.12
(`displayName` 1–60, token 1–40, preferensi `GET/PATCH`, `jobsPerHour`/`llmShare`), 07 (`0001`/`0006`,
`user_storage_quota`, preferensi lengkap), dan 08 (`fairnessKey`, backup sesudah `wait_drained`,
settings salin + penanda, nama tes MU-M4b). Bila dokumen lain menyimpang lagi, dokumen ini yang
berlaku untuk topik miliknya.
