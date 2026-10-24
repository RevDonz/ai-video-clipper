## Celah & koreksi

Saya cek klaim roadmap terhadap kode Potongin: `deploy/production.sh`, `compose.yaml`, `Dockerfile`, `web/proxy.js`, `web/lib/*`, `web/app/api/jobs/route.js`, `AGENTS.md`, `docs/HANDOFF.md` dan `docs/operations/STORAGE_RETENTION.md`. Untuk poin clean-room, saya hanya mencocokkan nama identifier lewat grep di SupoClip. Tidak ada kode SupoClip yang dikutip di sini.

### Tinggi

1. **Rollback otomatis tidak cocok dengan social-worker.** `rollback()` di `deploy/production.sh:144-153` memakai `compose.yaml` hasil checkout baru, lalu menjalankan image lama dengan `--remove-orphans`. Kalau deploy Release A gagal, service `social-worker` akan dijalankan dengan image lama yang belum punya `web/scripts/social-worker.mjs`, sehingga container itu crash-loop. Selain itu `rollback()` hanya menunggu `wait_http_health` dan `wait_primary_health`. Roadmap baru menulis "butuh compose.yaml yang cocok" sebagai catatan manual.
   - **Perbaikan:** pecah Fase 3 menjadi dua rilis. R0 hanya image: skrip `social-worker` sudah ada, tetapi service belum ada di compose. R1 baru menambah service di compose. Alternatif lain, pakai `profiles: [social]` dan beri command fallback yang tidak gagal saat skrip tidak ada.
   - `rollback()` juga harus memanggil `wait_social_health || true`.
   - Tambah kasus "rollback dengan compose baru dan image lama" ke `tests/test_deploy_guard.py`.
   - Pola yang sama berlaku untuk `pot-provider`. Karena ia memakai profil, aman selama profil itu tidak diaktifkan default.

2. **Gate quiescence deploy bentrok dengan multi-user.** `require_quiescent` (`deploy/production.sh:70-75`) menolak deploy selama masih ada job aktif. Deploy terjadi otomatis di setiap merge ke `main`. `PRIMARY_WORKER_CONCURRENCY` default 1 (`compose.yaml:28`). Dengan beberapa anggota, deploy akan sering terblokir atau gagal. Roadmap tidak membahas ini sama sekali.
   - **Perbaikan:** tambah milestone MU-M7b (sekitar 3 hari). Isinya mode drain `POTONGIN_ADMISSION_PAUSE` atau berkas penanda: job baru diterima tetapi ditahan dengan status "Menunggu pemeliharaan".
   - `production.sh` menyalakan drain, lalu menunggu sampai batas waktu, dan baru melanjutkan.
   - Tulis runbook di `PENGGUNA.md`. Uji bersama `deploy-env-contract`.

3. **Input dari anggota menjadi input tak tepercaya, tetapi hardening-nya belum ada di roadmap.**
   - Upload hanya dicek berdasarkan ekstensi (`web/app/api/jobs/route.js:39`, `VIDEO_EXTENSIONS`). `-protocol_whitelist file,pipe` hanya dipakai di jalur edit_v2 dan render_queue. Berkas `.mp4` yang isinya playlist HLS atau concat bisa merujuk file lokal lain (LFI/SSRF lewat FFmpeg) di pipeline utama atau Whisper.
   - yt-dlp yang menerima URL dari anggota bisa diarahkan ke extractor generik, ke host internal (`pot-provider`, `app:3000`), atau mengikuti redirect.
   - **Perbaikan:** tambah milestone keamanan MU-M4b (sekitar 3 hari) sebelum "siap untuk anggota":
     - ffprobe `format_name` harus masuk allowlist (mov/mp4/matroska/webm), dengan demuxer hls, concat dan image2 ditolak;
     - `-protocol_whitelist file,pipe` di semua pemanggilan ffmpeg/ffprobe di `src/ai_clipper/*`;
     - yt-dlp memakai `--use-extractors` allowlist dari `source-url.mjs` dan `--no-playlist`, dengan host resolve yang menolak IP privat;
     - tes `scripts/security/route_matrix.py` dan `tests/test_security_*`.

4. **Kontrol "hanya app, primary dan social-worker yang membuka DB" baru sebatas konvensi.** Ketiga service, termasuk `render-worker`, me-mount seluruh `clipper_data:/data` (`compose.yaml:117,226,265`). Akibatnya SQLite, backup DB dan `/data/settings` tetap bisa dibaca oleh proses Python dan render-worker. Tes `deploy-env-contract` hanya memeriksa env.
   - **Perbaikan:** taruh DB, backup dan settings di volume bernama terpisah (misalnya `potongin_control:/control`), yang tidak di-mount ke render-worker. Kalau memakai `volume.subpath`, wajib compose ≥ 2.23.
   - `deploy-env-contract` harus memeriksa mount, bukan hanya env.
   - Rencanakan migrasi pemindahan `/data/settings` beserta kompatibilitas image lama: symlink, atau kedua path dibaca.

### Sedang

5. **Kontradiksi "Python tidak tahu pemilik" dengan round-robin `ownerId` di `render_worker.py`.** Saat ini `render_worker.py` tidak membaca owner sama sekali.
   - **Perbaikan:** app menulis `fairnessKey` (hash buram, bukan id user) ke `analysis/render-requests/<id>.json`. Python hanya membaca kunci itu. Kunci yang kosong dianggap `legacy`.
   - Catat kontraknya di §5.59, sertakan tes paritas, dan revisi kalimat di §2.1.

6. **Node 24 mengubah `toolchain.json` sehingga semua plate key dan render key berubah** (`src/ai_clipper/edit_v2/plates.py:66-94`; komentar `Dockerfile:3-8`). Fase 0 tidak menyebut dampaknya: cache plate dan receipt idempotensi tidak valid lagi, ekspor bisa dirender ulang, dan muncul lonjakan disk di server yang sudah 81% terisi.
   - **Perbaikan:** kriteria selesai Fase 0 mencantumkan invalidasi yang diharapkan, pengukuran byte cache plate sebelum dan sesudah, serta konfirmasi bahwa klip yang tidak diubah tetap mengekspor file otomatis tanpa render ulang.
   - Perlu juga dicatat bahwa Node 20 sudah EOL (April 2026). Itu menjadi alasan tambahan pindah versi, bukan risiko baru.

7. **Kapasitas antrean belum direncanakan.** Dengan concurrency 1 dan `cpus: 6`, `max_running` per owner tidak berpengaruh, dan anggota bisa menunggu lama tanpa tahu sebabnya.
   - **Perbaikan:** MU-M7 menambah posisi antrean dan perkiraan tunggu di halaman proyek (copy Indonesia), ditambah pengukuran beban.
   - Q4 pemilik juga harus mencakup keputusan concurrency dan kuota CPU, bukan hanya jumlah pengguna.

8. **Kontrol auth untuk endpoint baru kurang lengkap.** Ambang `login-rate-limit` "tidak berubah", padahal kuncinya sekarang perlu per username ditambah per IP. Rate limit `api/auth/invite` dan `api/auth/reset` serta anti-enumerasi untuk token undangan dan reset belum ada. Aksi admin (transfer, hapus, reset sandi) belum memakai re-auth. `sameOriginMutation` di semua route baru juga belum disebut.
   - **Perbaikan:** tambahkan ke MU-M2 dan MU-M5, beserta tes `security-routes` dan `request-security` untuk setiap route baru.

9. **Kebocoran informasi instans ke anggota.** "Tentang sistem" (`web/lib/system-info.mjs`, `system-info-view.mjs`) menampilkan versi, disk dan ukuran cache, dan roadmap justru menambah isinya. Pengaturan Instans dan `/api/health` belum diberi aturan peran.
   - **Perbaikan:** "Tentang sistem" dan status storage global hanya untuk admin. Anggota hanya melihat kuotanya sendiri. Tambahkan baris ke `ownership-matrix` dengan dimensi peran.

10. **Estimasi terlalu optimistis.**
    - Fase 1 (7,5 hari) mencakup DB, migrasi, sesi s2, transisi cookie dua bentuk, bootstrap, smoke user dan perubahan deploy. Lebih realistis 10–12 hari.
    - MU-M3 (8 hari) mencakup 49 route, 18 lib route dan 4 route self-auth yang dikecualikan proxy (`web/proxy.js:38`: upload jobs, assets, logo, youtube-cookies). Lebih realistis 11–13 hari.
    - RF-M1 dengan P ≥ 0,95 / R ≥ 0,90 dalam 6 hari terlalu ketat.
    - **Perbaikan:** naikkan total ke sekitar 205–215 hari-dev, atau naikkan cadangan dari 8 ke ≥ 20 hari.
    - Tambahkan peta kalender. Dengan satu developer, ini sekitar 10–11 bulan, dan Fase 5–6 jatuh di 2027.

11. **Identifier yang sama persis dengan SupoClip (clean-room).** Grep nama saja di repo SupoClip menemukan:
    - `social_posts`, `social_accounts` dan `oauth_states` di `backend/src/repositories/social_repository.py` dan tes;
    - `fetch_metrics` di `backend/src/social/*`, yang serupa dengan adapter `fetchMetrics`;
    - `media-cache` di 5 file.

    Nama-nama ini generik, tetapi justru jenis temuan yang dicari reviewer spot-check menurut §1.
    - **Perbaikan:** ganti dengan nama gaya Potongin, misalnya `social_connections`, `publish_runs`, `oauth_pending`, adapter `readPostStats`, dan direktori `/data/cache-unduhan`. Tetapkan nama ini di PR kontrak Fase 0.

### Rendah

12. **Aturan pemilik "Selalu terbaru"** (AGENTS.md, Owner rules). Pemetaan `auto→fit-blur` dan `engine_fallback` tidak boleh muncul sebagai pilihan mode di UI. Prosa roadmap menulis "Selection V3"; pastikan istilah itu tidak bocor ke copy. **Perbaikan:** tambahkan ke `ui-guards`.

13. **Draft editor tersimpan di browser per `jobId`** (`web/lib/editor/draft-store.mjs`). Di perangkat bersama, draft bisa terlihat setelah orang lain login. **Perbaikan:** kunci draft dengan hash user, dan bersihkan saat logout.

14. **TikTok `PULL_FROM_URL` mewajibkan verifikasi prefix domain**, begitu juga fallback URL publik untuk Instagram. Ini belum disebut di SOS-M0 atau di Q4. **Perbaikan:** jadikan `FILE_UPLOAD` jalur utama, dan masukkan verifikasi domain ke checklist pemilik serta ke `docs/operations/SOSMED.md` (berkas baru).

15. **Dokumen operasional.** `deploy/VM_NGINX_CLOUDFLARE.md` belum masuk peta file. Padahal callback OAuth, halaman `/privasi` dan `/ketentuan`, rute media publik, serta timeout dan ukuran body untuk unggahan sosmed perlu tercantum di sana. Perbarui di Fase 5.

16. **`PRIMARY_WORKER_CONCURRENCY` dan flag baru belum disebut di `.env.example`.** Tambahkan juga `POTONGIN_DB_PATH`, `E2E_SMOKE_*` dan `SOCIAL_PIN_KEEP_DAYS` ke daftar flag di §2.5, yang dijaga `web/tests/env-example.test.mjs`.