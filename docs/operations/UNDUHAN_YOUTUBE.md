# Unduhan YouTube: link yang diterima, kode galat, dan penjaga unduhan macet

Terakhir diperbarui: 2026-10-20.

Worker (`web/scripts/run-job.mjs`) mengunduh video sumber dengan `yt-dlp`. Dokumen ini
menjelaskan link apa yang diterima, apa yang tersimpan di job kalau unduhan gagal, dan kapan
unduhan dihentikan karena macet.

## Link yang diterima

- Hanya `https://` dari `youtu.be`, `youtube.com`, `www.youtube.com`, `m.youtube.com`, dan
  `music.youtube.com` (`YOUTUBE_HOSTS` di `web/lib/jobs.mjs`; form dashboard memeriksa daftar
  yang sama di `web/lib/dashboard-view.mjs`). Host lain ditolak.
- Link `m.youtube.com` dan `music.youtube.com` disimpan di job dengan host `www.youtube.com`;
  path dan query tetap. Link dari tiga host pertama disimpan apa adanya.

## Kode galat unduhan

Kalau `yt-dlp` gagal, worker membaca ujung stderr-nya (paling banyak 32 KiB, di memori) dan
memetakan baris `ERROR:` ke satu kode tetap (`web/lib/download-errors.mjs`). Baris `WARNING:`
tidak pernah menentukan kode. Baris `ERROR:` pertama yang dikenali menang; kalau tidak ada yang
dikenali, kodenya `download_failed`.

Kode ini stabil dan menjadi jangkar halaman bantuan (`/bantuan#<kode>`, lihat
[`BANTUAN.md`](BANTUAN.md)). Pesan gagal yang punya kode di Buat Klip dan di halaman proyek
menautkan ke entrinya lewat "Cara memperbaiki".

| Kode | Pesan di layar | Saran di layar | Contoh isi baris `ERROR:` |
|---|---|---|---|
| `download_private` | Video ini privat. | Pakai video yang bisa ditonton tanpa login. | `Private video` |
| `download_unavailable` | Video ini sudah dihapus atau tidak tersedia. | Periksa link-nya di YouTube. | `Video unavailable`, `has been removed`, `Incomplete YouTube ID` |
| `download_age_restricted` | YouTube meminta login karena video ini dibatasi usia. | Unggah file videonya langsung. | `Sign in to confirm your age` |
| `download_members_only` | Video ini khusus member atau berbayar. | Unggah file videonya langsung. | `members-only`, `requires payment` |
| `download_geo_blocked` | Video ini tidak tersedia di wilayah server. | Unggah file videonya langsung. | `not made this video available in your country`, `geo restriction` |
| `download_bot_check` | YouTube sedang menahan unduhan dari server ini. | Unggah file videonya langsung. | `confirm you're not a bot`, `rate-limited`, `HTTP Error 429` |
| `download_ytdlp_outdated` | Pengunduh YouTube di server perlu diperbarui. | Sementara itu, unggah file videonya langsung. | `Requested format is not available`, `Unable to extract`, `please report this issue`, `HTTP Error 403` |
| `download_stalled` | Unduhan macet. | Buat ulang proyek ini beberapa menit lagi. | (bukan dari stderr; lihat bagian berikut) |
| `download_failed` | Video YouTube gagal diunduh. | Periksa link-nya, lalu buat ulang proyek ini. | baris lain, atau tidak ada baris `ERROR:` |

Tindakan operator:

- `download_ytdlp_outdated` yang muncul di banyak video berarti `yt-dlp` di image sudah
  tertinggal dari perubahan YouTube. Versinya dikunci di `uv.lock`; naikkan lewat PR dengan
  langkah "YouTube rusak: naikkan yt-dlp" (`docs/editor/OPERASIONAL.md` §8).
- `download_bot_check` biasanya soal reputasi IP server. Belum ada dukungan cookies; pengguna
  bisa mengunggah file videonya langsung.

## Yang tersimpan di job

Job yang gagal saat unduhan menyimpan:

- `errorCode`: kode di atas. Job yang gagal karena hal lain menyimpan `errorCode: null`.
- `stageDetail`: pesan Indonesia kode itu.
- `error`: satu baris teknis pendek (paling banyak 240 karakter), yaitu baris `ERROR:` tanpa
  awalan `ERROR:` dan tanpa saran bawaan `yt-dlp` soal cookies atau laporan bug. URL dipotong
  sampai host, nilai yang mirip cookie, token, atau key diganti `…`, dan path server dipotong
  sampai nama file. Tanpa baris `ERROR:`, isinya `yt-dlp gagal (exit N)`.

Dashboard dan halaman proyek membaca pesan dan saran dari kodenya, jadi job lama ikut memakai
teks terbaru. Baris teknisnya tampil di "Detail teknis" (dashboard) dan "Pesan dari server"
(halaman proyek). Stderr `yt-dlp` tetap diteruskan utuh ke log worker.

## Penjaga unduhan macet

- `yt-dlp` dijalankan dengan `--newline` dan `--progress-template`, jadi setiap pembaruan
  progres menjadi satu baris `[download-progress] <status> <byte terunduh>/<total>`
  (`web/lib/download-monitor.mjs`).
- Progres dianggap bergerak kalau status atau jumlah byte berubah. Baris ekstraksi
  (`[youtube] …`, `[info] …`, `[download] Destination: …`) juga dihitung aktivitas. Pemberitahuan
  retry (`Got error`, `Retrying`, `Sleeping`) tidak.
- Kalau tidak ada aktivitas selama `POTONGIN_DOWNLOAD_STALL_MS` (bawaan 120000 ms, rentang
  100–3600000; nilai kosong atau tidak valid memakai bawaan), worker menghentikan grup proses
  `yt-dlp` dengan cara yang sama seperti saat lease hilang (SIGTERM, lalu SIGKILL setelah 5
  detik). Job gagal dengan kode `download_stalled` dan pesan "Unduhan macet.".
- Tahap post-processing (`[Merger]`, `[ExtractAudio]`, `[Fixup…]`, `[ffmpeg]`, `Deleting
  original file`, dan sejenisnya) tidak dihitung macet. Penjaga aktif lagi begitu ada baris
  progres baru.
- Log worker mendapat semua baris `yt-dlp` kecuali baris progres yang dibatasi menjadi satu per
  10 detik (ditambah setiap perubahan status).
