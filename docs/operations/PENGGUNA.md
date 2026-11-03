# Pengguna: deploy dan pemulihan

Runbook data kontrol (rombak `01-arsitektur-data.md` §5, §7; `02-multiuser-keamanan.md` §12.3). Fase 4 memasang fondasi: akun, sesi di server, volume `potongin_control`. Undangan dan halaman admin datang di Fase 6. Bagian undangan runbook ini ditulis saat itu.

## Sebelum deploy pertama yang memuat Fase 4

Isi di `.env` produksi. `deploy/production.sh` berhenti sebelum build kalau salah satunya kosong; container lama tetap jalan.

1. `POTONGIN_SETTINGS_SECRET`. Kalau `.env` belum punya baris ini, salin nilai `APP_SESSION_SECRET` apa adanya. Kalau sudah ada, biarkan. Nilai lain membuat key LLM dan cookie YouTube tersimpan tidak terbuka; `start-app` hanya memberi peringatan di log, app tetap jalan dengan pemilih heuristik. Panjang minimal 32 karakter.
2. `E2E_SMOKE_USERNAME` dan `E2E_SMOKE_PASSWORD`: pengguna baca-saja untuk pemeriksaan pasca-deploy. Nama 3-32 huruf kecil, angka, titik, garis bawah, atau tanda hubung, dan bukan nama pemilik. Sandi acak minimal 20 karakter.
3. `AUTH_TRUSTED_CLIENT_IP_HEADER`: `cloudflare` atau `nginx`, sesuai yang ada di depan app.

Periksa juga `APP_USERNAME`: harus lolos pola nama yang sama (huruf besar dinormalkan ke huruf kecil). Kalau tidak, deploy berhenti sebelum container diganti.

## Yang terjadi saat deploy

1. Build image baru.
2. `db-backup.mjs --reason deploy` (image baru): `DB_BACKUP=none` pada deploy pertama, `SETTINGS_BACKUP=` tercetak.
3. `start-app.mjs --prepare-settings` (image baru): `/data/settings` disalin ke `/control/settings` dengan cek sha256 dan penanda `.migrated-from-data`. `/data/settings` tidak disentuh. Pengaturan yang disimpan di app lama dalam detik antara langkah ini dan langkah 4 tidak ikut.
4. `up -d`: app memigrasi DB, membuat admin dari `APP_*` dan user smoke, primary-worker menunggu skema (maksimal 60 detik).
5. Pemeriksaan: health, mount `/control` (`CONTROL_VOLUME=` tercetak), e2e baca-saja dengan user smoke.

Gagal di langkah 2-3: berhenti, container lama tetap jalan. Gagal setelah langkah 4: rollback otomatis ke image lama.

## Sesudah deploy

- Login pemilik tetap sama. Cookie lama berubah sekali menjadi sesi baru, tanpa perlu login ulang.
- Keluar kini mencabut sesi di server, termasuk salinan cookie lama itu.
- Ganti sandi pemilik: buka `/akun/kata-sandi` (sandi awal = `APP_PASSWORD`). `APP_PASSWORD` tetap berlaku sebagai login darurat, dan pemakaiannya dicatat di audit.

## Masuk darurat

- Login dengan `APP_USERNAME` dan `APP_PASSWORD`. Berlaku walau sandi akun sudah diganti atau akun dinonaktifkan.
- Tanpa login: `docker compose exec app node scripts/admin-reset.mjs --admin <nama>` mencetak sandi sementara sekali; wajib diganti saat masuk.
- Daftar akun: `docker compose exec app node scripts/admin-reset.mjs --list`.

## Pulihkan cadangan

1. `docker compose stop app primary-worker` (render-worker boleh jalan).
2. `docker compose run --rm --no-deps --entrypoint node app scripts/db-restore.mjs --from /control/backups/potongin-<ts>-<alasan>.sqlite [--settings /control/backups/settings-<ts>-<alasan>.tar] --yes`
3. `docker compose up -d`. Sesi yang dibuat sesudah cadangan hilang; pengguna login ulang. Skema yang lebih tua dimigrasi saat start.

Kode keluar: 3 sumber rusak, 5 DB masih dipakai, 6 cadangan butuh image lebih baru, 64 argumen salah. Tidak ada yang ditulis sebelum semua pemeriksaan lolos. `settings.pre-restore-<ts>` dihapus manual sesudah yakin.

`POTONGIN_SETTINGS_SECRET` tidak ikut cadangan; simpan salinannya di luar server. Tanpa itu kotak tersegel di cadangan tidak terbaca.

## Rollback

| Kombinasi | Hasil |
|---|---|
| Image lama + compose baru | Membaca `/control/settings` lewat `POTONGIN_SETTINGS_DIR`; mengabaikan DB. Login `APP_*`; cookie s2 tidak dikenal, jadi login ulang. Ini yang dipakai rollback otomatis. |
| Image lama + compose lama | Membaca salinan beku `/data/settings`. Perubahan setting setelah Fase 4 tidak terlihat. |
| Image baru lagi | DB dan penanda tetap; migrasi tidak berbuat apa-apa; sesi lama masih berlaku bila belum kedaluwarsa. |

Setelah `--purge-legacy-settings` (wajib sebelum undangan pertama, Fase 6), image pra-Fase 4 hanya boleh dengan compose baru.
