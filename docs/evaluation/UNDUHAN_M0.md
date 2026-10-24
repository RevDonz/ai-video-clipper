# Pengukuran unduhan (FETCH-M0)

Pengukuran Fase 0 untuk rencana unduhan (`docs/plans/2026-10-24-rombak/04-reframe-unduhan.md`
§B12). Hasilnya dipakai untuk memutuskan Kick, bgutil dan range-only, dan menjadi baseline gate
FETCH-M3.

Skrip: `scripts/fetch/m0_measure.py` (tes bagian murninya: `tests/test_fetch_m0_measure.py`).
Semua angka diukur di GitHub Actions, di dalam image produksi (`editor-gates.yml`
`suite=command`), tidak di PC pemilik. Hasil mentah gabungan:
`docs/evaluation/unduhan-m0/result-2026-10-24.json`; angka turunan (range-only):
`docs/evaluation/unduhan-m0/report-2026-10-24.json`.

## Keputusan

| Hal | Keputusan | Dasar |
|---|---|---|
| Kick | **Bersyarat**: metadata dan manifest jalan tanpa `curl_cffi`; unduhan media belum terbukti. Flag `POTONGIN_FETCH_KICK` tetap `off` (Q11) | 5 dari 5 halaman Kick (3 VOD, 2 klip) terbaca tanpa `curl_cffi`, manifest HLS menjawab 200. Media tidak diunduh (bukan konten berlisensi terbuka), jadi syarat §B8 "unduhan berhasil di CI tanpa `curl_cffi`" belum terpenuhi. FETCH-M5 baru dihitung go setelah satu unduhan Kick berhasil (uji pemilik atau uji produksi). |
| bgutil | **Tidak bisa disimpulkan dari CI**. Default Q11 berlaku: bgutil opt-in, mati (§B7.4) | 20 dari 20 percobaan kena cek bot di ketiga cara, 0 token PO. Server bgutil tidak pernah dimintai token: YouTube menolak IP runner sebelum langkah itu. Cara "dengan proxy" tidak diukur. Pemilik yang memutuskan kalau bgutil mau dibuang dari FETCH-M6. |
| Range-only | **No-go** (FETCH-M9 tetap dilewati, Q11) | Gerbang §B11 butir 1 gagal saat transkripsi Whisper (median −6%), hanya lolos tipis dengan subtitle (median +42%) di host non-YouTube yang lajunya sangat bervariasi. Butir 3 (jawaban pemilik) belum ada. |
| Codec audio-first | **Format yang sama dengan `ba` hari ini** (biasanya Opus 251), dibatasi ke audio bahasa asli; bukan AAC. Diputuskan atas delegasi pemilik, perlu ditinjau pemilik | Ganti codec mengubah pilihan klip: dengan Whisper hanya 7/25 (AAC) dan 9/25 (Opus) klip yang tetap sama. Batas ≤ 200 ms hanya pasti kalau analisis dan mp4 akhir memakai file audio yang sama. Ini disimpulkan dari file uji, bukan diukur di YouTube. |
| Proxy lewat file config (§B7.3) | **Dikonfirmasi** | Proxy dipakai (4 tunnel), tidak pernah muncul di `/proc/*/cmdline` atau `/proc/*/environ` selama 303 pemindaian. Kontrol `--proxy` di argv langsung ketahuan. |
| Nama extractor | `youtube`, `twitch:vod`, `twitch:clips`, `kick:vod`, `kick:clips` | `yt-dlp --list-extractors` versi pin 2026.08.19. |
| Cap cache 4 GiB (Q6) | **Tetap default**, diusulkan ulang ke pemilik untuk 1080p | 720p muat 6 sampai 28 jam sumber; satu sumber 1080p 4 jam bisa lebih dari 4 GiB. Ukuran YouTube tidak terukur dari runner. |

## Temuan di luar daftar

- **YouTube menolak semua permintaan dari runner GitHub.** 60 dari 60 unduhan (3 cara × 20) dan
  6 dari 6 player client (`default`, `tv`, `web_safari`, `mweb`, `android_vr`, `web_embedded`)
  berakhir dengan "Sign in to confirm you're not a bot". Halaman pencarian masih terbaca (run
  uji awal [40102521274](https://github.com/RevDonz/ai-video-clipper/actions/runs/40102521274)),
  player tidak. Jadi semua angka YouTube di bawah tidak terukur dari CI; pengukuran yang butuh media
  YouTube memakai video.blender.org sebagai pengganti.
- **Node 20 di image tidak diterima yt-dlp sebagai JS runtime.** Header debug yt-dlp 2026.08.19
  di image produksi: `JS runtimes: node-20.20.2 (unsupported)` (yt-dlp butuh Node ≥ 22), dan
  `yt-dlp-ejs` tidak terpasang. Artinya `--js-runtimes node` di `web/scripts/run-job.mjs` saat ini
  tidak berpengaruh: yt-dlp tidak bisa menjalankan pemecah tantangan JS YouTube, dan menurut
  peringatannya sendiri sebagian format bisa hilang. Dampaknya di produksi tidak terukur dari sini
  (cek bot). Node 24 (MU-M0) membereskan runtime-nya. `yt-dlp-ejs` (lewat extra `yt-dlp[default]`) adalah dependensi baru
  dan perlu persetujuan pemilik.

## Sumber

- YouTube: trailer pilot Cosmos Laundromat (Blender Foundation, CC BY), video uji yang sama dengan
  `scripts/ytdlp/ytdlp_smoke.py`. Sumber CC BY dari `TRAINING_SOURCE_REGISTRY.json` tidak sampai
  diunduh karena cek bot.
- video.blender.org (PeerTube milik Blender Foundation): hanya video berlisensi CC BY, CC BY-SA atau
  domain publik menurut API instance itu. Daftar video yang dipakai ada di hasil mentah.
- Sumber uji sintetis untuk A/V: warna hitam dengan kilatan putih satu frame dan bunyi 20 ms
  setiap 2 detik (dibuat FFmpeg), disajikan lokal sebagai HLS dan DASH.
- Kick: metadata VOD dan klip dari kanal publik besar. Nama kanal diberikan saat run
  (`--kick-channels`) dan tidak disimpan di repo atau di hasil (kanal ditulis `kanal-1`, `kanal-2`).
  Tidak ada byte media yang diunduh.

Tidak ada cookie, proxy berbayar, atau kunci LLM. Seleksi memakai heuristik V3 saja (CI tidak
punya kunci LLM gratis), jadi waktu LLM tidak termasuk di angka waktu sampai seleksi. Whisper
memakai model `small` (default produksi), CPU 4 inti.

## M0-1 · Audio asli vs audio unduhan (codec)

**Status: sebagian.** Yang dibandingkan adalah audio file sumber dengan encode ulang AAC dan Opus
lokal, bukan dengan `ba` YouTube atau trek bahasa asli YouTube. Waktu unduh per varian (§B12)
tidak terukur, karena YouTube menolak runner; yang ada hanya ukuran file.

Lima talk video.blender.org (10 menit pertama tiap talk), run
[40104912904](https://github.com/RevDonz/ai-video-clipper/actions/runs/40104912904). Pembanding
**asli** = audio file sumber apa adanya (AAC). Dua encode ulang meniru format audio YouTube:
**AAC** 128 kbit/s 44,1 kHz (seperti itag 140) dan **Opus** 128 kbit/s 48 kHz (seperti itag 251).
Tiap varian ditranskripsi Whisper `small`, diukur timeline audionya, lalu diseleksi heuristik V3
(5 klip, 20 sampai 60 dtk). "Klip sama" = klip yang menutup momen yang sama dengan klip asli dan
batasnya bergeser ≤ 200 ms.

| Talk | Kata Whisper, selisih median / p95 (AAC · Opus) | Klip sama, Whisper (AAC · Opus) | Klip sama, subtitle tetap (AAC · Opus) |
|---|---|---|---|
| Blender 4.0 New Features | 0 / 20 ms · 0 / 20 ms | 4/5 · 3/5 | 5/5 · 4/5 |
| Grandma Z (BCON26) | 10 / 410 ms · 20 / 480 ms | 0/5 · 2/5 | 5/5 · 5/5 |
| Finish an Epic Shortfilm | 0 / 240 ms · 10 / 170 ms | 0/5 · 1/5 | 5/5 · 2/5 |
| Vertex to T. Rex (BCON26) | 0 / 70 ms · 10 / 110 ms | 3/5 · 2/5 | 5/5 · 3/5 |
| Closing Event | 10 / 160 ms · 10 / 170 ms | 0/5 · 1/5 | 2/5 · 2/5 |
| **Jumlah** | | **7/25 · 9/25** | **22/25 · 16/25** |

"Subtitle tetap" = transkrip asli dipakai untuk semua varian (jalur YouTube dengan subtitle), jadi
yang berbeda hanya timeline audio (jeda, tingkat suara) dari file itu.

- Waktu kata tidak bergeser secara sistematis: median selisih 0 sampai 20 ms. Start stream Opus
  −7 ms (pre-skip), AAC 0 ms. Tidak ada codec yang menggeser waktu sampai 200 ms.
- Tapi teks Whisper sedikit berbeda di tiap encode, dan itu cukup untuk mengubah kandidat: dengan
  Whisper, kurang dari separuh klip tetap sama, apa pun codec-nya.
- Timeline audio juga peka codec: dengan transkrip yang sama, AAC sama dengan asli di 22/25 klip,
  Opus 16/25. Asli di sini AAC, jadi AAC wajar lebih dekat; di YouTube audio aslinya tidak diketahui.
- Ukuran 10 menit: AAC 9,6 sampai 10,0 MB, Opus 7,9 sampai 9,2 MB (sekitar 15% lebih kecil).

**Keputusan (atas delegasi pemilik, perlu ditinjau pemilik):** audio-first mengunduh **format
yang sama dengan yang dipilih `ba` hari ini**
(biasanya Opus 251), dengan syarat bahasa asli dari §B4 butir 5. Alasannya gate FETCH-M3 ("klip
sama, batas ≤ 200 ms dibanding audio `ba` lama"): pengukuran ini menunjukkan gate itu hanya bisa
lolos kalau audionya file yang sama, bukan sekadar codec yang mirip. Merge ke mp4 tetap tanpa
transcode (FFmpeg menyalin Opus ke mp4, seperti unduhan `bv*+ba` hari ini). Bandingan `ba` vs audio
asli di YouTube sendiri (trek dubbing, varian DRC) tidak bisa diukur dari runner karena cek bot.
Ini menyimpang dari default rancangan §B4 butir 5 (AAC), dan alasannya ditarik dari uji "file yang
sama", bukan dari pengukuran di YouTube.

## M0-2 · Waktu sampai seleksi

Empat talk video.blender.org, unduhan 720p, Whisper `small`, seleksi heuristik.
**Sekuensial** = unduh video + transkripsi + timeline audio dengan pass adegan + seleksi.
**Audio-first** = unduh audio (disimulasikan: 128 kbit/s × durasi dibagi laju unduh video yang
terukur) + transkripsi + timeline audio tanpa pass adegan (§B5 memindahkan pass adegan ke setelah
video siap) + seleksi. Kolom "subtitle" = jalur YouTube dengan subtitle (tanpa Whisper).

| Sumber | Durasi | Unduh 720p | Laju | Whisper | Pass adegan | Sekuensial | Audio-first | Sekuensial, subtitle | Audio-first, subtitle |
|---|---|---|---|---|---|---|---|---|---|
| Interface Overview | 10,0 mnt | 3,7 dtk | 6,9 MB/dtk | 138 dtk | 9,0 dtk | 151 dtk | 140 dtk | 12,8 dtk | 2,5 dtk |
| Geometry Nodes Fields | 30,0 mnt | 8,5 dtk | 17,1 MB/dtk | 328 dtk | 36,6 dtk | 373 dtk | 332 dtk | 45,2 dtk | 3,7 dtk |
| Developers Ask Me Anything | 59,9 mnt | 234,9 dtk | 2,8 MB/dtk | 336 dtk | 93,8 dtk | 664 dtk | 360 dtk | 329 dtk | 24,0 dtk |
| BCON20 Together Apart | 99,0 mnt | 44,9 dtk | 22,4 MB/dtk | 711 dtk | 153,5 dtk | 910 dtk | 723 dtk | 199 dtk | 11,9 dtk |

Run: [600](https://github.com/RevDonz/ai-video-clipper/actions/runs/40103797198),
[1800](https://github.com/RevDonz/ai-video-clipper/actions/runs/40104278162),
[3600](https://github.com/RevDonz/ai-video-clipper/actions/runs/40104280298),
[7200](https://github.com/RevDonz/ai-video-clipper/actions/runs/40104282869). Tidak ada talk
berlisensi terbuka yang mendekati 120 menit; yang terpanjang di bawah batas toleransi 99 menit.

Bacaan:
- Dengan Whisper, transkripsi mendominasi (RTF 0,09 sampai 0,23). Audio-first memangkas 7% (10
  menit) sampai 46% (60 menit), terutama dari pass adegan yang dipindah dan unduhan video yang
  lambat.
- Dengan subtitle, audio-first hampir menghapus seluruh waktu tunggu: 199 dtk menjadi 12 dtk untuk
  99 menit.
- Laju unduhan dari host yang sama berbeda 8 kali lipat antar run (2,8 vs 22,4 MB/dtk; file 60
  menit yang sama terunduh 85 dtk di run range-only dan 235 dtk di run ini). Angka unduhan YouTube
  di produksi tidak terukur. **Baseline gate FETCH-M3 harus diambil ulang di produksi** dengan
  YouTube, median 5 sumber ≥ 30 menit.

## M0-3 · bgutil

| Cara | Cek bot | Token PO dibuat | JS runtime |
|---|---|---|---|
| Image apa adanya | 20/20 | 0 | `node-20.20.2 (unsupported)` |
| Node 24 + yt-dlp-ejs 0.8.0 | 20/20 | 0 | `node-24.21.0` |
| Node 24 + yt-dlp-ejs + bgutil 2.0.2 (server HTTP) | 20/20 | 0 | `node-24.21.0` |

Run: [40104914860](https://github.com/RevDonz/ai-video-clipper/actions/runs/40104914860) (dua run
sebelumnya, [40103793226](https://github.com/RevDonz/ai-video-clipper/actions/runs/40103793226) dan
[40104318988](https://github.com/RevDonz/ai-video-clipper/actions/runs/40104318988), hasilnya sama:
20/20 cek bot di setiap cara yang jalan). Percobaan diselang-seling antar cara, jeda 2 detik, satu
IP runner per run.

- Plugin terdeteksi (`PO Token Providers: bgutil:http-2.0.2 (external)`), server menjawab `/ping`,
  tapi tidak ada baris "Generating a … PO Token": YouTube menolak IP sebelum langkah token. Ini
  sesuai catatan README bgutil sendiri bahwa token PO tidak menembus pembatasan IP datacenter.
- Dengan proxy: **tidak diukur**. Tidak ada proxy gratis yang boleh dipakai, dan proxy berbayar
  butuh persetujuan pemilik.
- Untuk dipakai nanti: image `brainicism/bgutil-ytdlp-pot-provider:2.0.2`
  `@sha256:d7d34108b76e52c7d3b575fe9e797e4bf41c1b2a08f80c5292eff6f851ce8472` (varian Node), paket
  PyPI `bgutil-ytdlp-pot-provider==2.0.2`, argumen
  `--extractor-args "youtubepot-bgutilhttp:base_url=<url>"`. Server native butuh Node ≥ 22.

Skrip memberi label `no_token` untuk hasil ini, bukan `no_effect`: bgutil tidak pernah sampai
diuji, karena tidak ada satu pun permintaan token.

**Keputusan: tidak bisa disimpulkan dari CI; default Q11 tetap.** bgutil opt-in dan mati, seperti
§B7.4 (profil `pot`, `POTONGIN_POT_PROVIDER_URL` kosong). FETCH-M6 tetap membangun bagian bgutil
sesuai rencana, dengan digest image, paket dan argumen extractor di atas. Pengukuran yang bisa
memutuskan butuh IP yang tidak langsung kena cek bot (proxy atau server produksi), jadi butuh
pemilik. Pemilik yang memutuskan kalau bgutil mau dibuang.

## M0-4 · Proxy lewat file config

Proxy lokal (CONNECT, menghitung tunnel) dengan URL `http://<user>:<penanda acak>@127.0.0.1:<port>`.
File `attempt/.fetch/ytdlp.conf` (0600, satu baris `--proxy <url>`), argv
`yt-dlp --ignore-config --config-locations <file> …`, unduh satu talk pendek video.blender.org.
`/proc/*/cmdline` dan `/proc/*/environ` dipindai setiap 20 ms selama proses jalan.

| Cara | Tunnel lewat proxy | Pemindaian | Penanda ditemukan |
|---|---|---|---|
| `--config-locations` | 4 | 303 | 0 |
| Kontrol: `--proxy` di argv | 4 | 303 | 1 (`cmdline` yt-dlp) |

Run: [40104994075](https://github.com/RevDonz/ai-video-clipper/actions/runs/40104994075) (run
[40104065412](https://github.com/RevDonz/ai-video-clipper/actions/runs/40104065412) sama: 372 dan
361 pemindaian, penanda hanya di kontrol). `--ignore-config` tidak mematikan `--config-locations`, jadi argv §B3.4 dan §B7.3 bisa dipakai
bersama. **Desain §B7.3 dikonfirmasi.** Tes wajib FETCH-M6 (`web/tests/proxy-redaction.test.mjs`)
tetap perlu, karena pengukuran ini tidak memeriksa log, `job.json` atau respons API.

## M0-5 · Kick

| Cara | VOD | Klip | Manifest HLS |
|---|---|---|---|
| Tanpa `curl_cffi` (image apa adanya) | 3/3 terbaca, 5 format | 2/2 terbaca, 1 format | 200 di 5/5 |
| Dengan `curl_cffi` 0.16.0 | 3/3 | 2/2 | 200 di 5/5 |

Run: [40104994075](https://github.com/RevDonz/ai-video-clipper/actions/runs/40104994075) (run
[40104065412](https://github.com/RevDonz/ai-video-clipper/actions/runs/40104065412) sama). API kanal
Kick (`/api/v2/channels/<kanal>/videos` dan `/clips`) juga menjawab dari urllib biasa. Tanpa
`curl_cffi`, yt-dlp hanya memberi peringatan bahwa ia mencoba meniru browser, lalu lanjut.

Skrip memberi label `metadata_ok_without_curl_cffi`: yang terbukti hanya metadata dan manifest.

**Keputusan: bersyarat.** Metadata dan manifest jalan tanpa `curl_cffi`, jadi FETCH-M5 boleh
dibangun tanpa dependensi baru, dengan unduhan diuji lewat fixture. Unduhan media Kick belum
terbukti, karena VOD Kick tidak berlisensi terbuka dan tidak diunduh di CI. FETCH-M5 baru dihitung
go setelah satu unduhan Kick berhasil tanpa `curl_cffi`, dicoba pemilik atau di uji produksi,
sebelum flag dinyalakan. Flag tetap `off` (Q11). Cloudflare Kick bisa berubah; `ytdlp_smoke.py`
(FETCH-M8) sebaiknya ikut memeriksa satu VOD Kick (preflight saja).

## M0-6 · Range-only

**A/V potongan** (sumber uji sintetis 15 menit, 30 fps, GOP 2 dtk, segmen 6 dtk, 20 potongan 30
dtk per cara, posisi potong tersebar):

| Paket | Cara potong | A/V ≤ 1 frame | Offset | Waktu per potongan (median) |
|---|---|---|---|---|
| HLS | `-c copy` (bawaan) | 20/20 | +0,64 frame (+21 ms) | 1,0 dtk |
| HLS | `--force-keyframes-at-cuts` | 20/20 | −0,36 frame (−12 ms) | 1,9 dtk |
| DASH | `-c copy` | 20/20 | +0,64 frame | 1,2 dtk |
| DASH | `--force-keyframes-at-cuts` | 20/20 | −0,36 frame | 2,0 dtk |

Offset sama di setiap potongan: +21 ms = satu frame AAC (1024 sampel di 48 kHz). Sumber penuh
offset 0. Resolusi alat ukur 1 frame video (33 ms).

**Waktu potong vs unduhan penuh** (talk 60 menit video.blender.org, file progresif 720p 652 MB):
unduhan penuh 84,9 dtk; potongan 60 dtk 5,4 sampai 12,6 dtk dengan `-c copy`, 38 sampai 53 dtk
dengan `--force-keyframes-at-cuts` (encode ulang).

**Gerbang §B11** (5 klip × median potongan 6,0 dtk, berurutan, dibanding audio-first + video
paralel; kedua sisi memuat unduh audio, transkripsi, timeline audio dan seleksi; render sama di
kedua sisi):

| Sumber ≥ 40 menit | Dengan Whisper | Dengan subtitle |
|---|---|---|
| 60 menit | −8% | +77% |
| 99 menit | −4% | +7% |
| **Median** | **−6%** | **+42%** |

Contoh 99 menit dengan subtitle: range-only 4,25 + 7,41 + 0,21 + 30 = 41,9 dtk, audio-first
max(11,9; 44,85) = 44,85 dtk.

A/V ≤ 1 frame: 80/80 (100%). Run range:
[40103795306](https://github.com/RevDonz/ai-video-clipper/actions/runs/40103795306).

**Keputusan: no-go, FETCH-M9 tetap dilewati.** Dengan Whisper, range-only lebih lambat, karena video
penuh sudah selesai saat transkripsi selesai. Dengan subtitle, mediannya lolos tipis (42% lawan
batas 40%), tapi hanya dari dua sumber di host non-YouTube dengan laju unduhan yang naik-turun 8 kali
lipat, dan sangat bergantung pada laju itu (77% saat lambat, 7% saat cepat). Butir 3 gerbang (koeksistensi pemilihan ulang, editor ±60 dtk, identitas
`clip_id`) butuh jawaban pemilik. Kalau pemilik ingin meninjau ulang, ukur laju unduhan YouTube di
produksi dulu.

## M0-7 · Nama extractor

`yt-dlp --list-extractors` 2026.08.19 (versi pin `uv.lock`):

- YouTube: `youtube` (juga `youtube:tab`, `youtube:playlist`, `youtube:search`, dll.; hanya
  `youtube` yang dipakai)
- Twitch: `twitch:vod`, `twitch:clips` (juga `twitch:stream`, `twitch:videos`,
  `twitch:collection`, dll.)
- Kick: `kick:vod`, `kick:clips` (juga `kick:live`)

Nama ini untuk `PLATFORMS[p].extractors` (§B3.1). Perilaku `--use-extractors` (nama persis atau
pola) tetap diuji di MU-M4b.

## M0-8 · Disk per jam

Dari ukuran file di API video.blender.org (metadata, tanpa unduhan), run
[40104994075](https://github.com/RevDonz/ai-video-clipper/actions/runs/40104994075):

| Sumber | 720p per jam | 1080p per jam |
|---|---|---|
| Interface Overview (layar) | 0,15 GB | 0,25 GB |
| Geometry Nodes Fields | 0,29 GB | 0,38 GB |
| Developers Ask Me Anything (kamera) | 0,65 GB | 1,29 GB |
| BCON20 Together Apart | 0,61 GB | tidak ada |

Ukuran YouTube tidak terukur (cek bot). Dengan angka ini, cap 4 GiB (4,29 GB) memuat 6 sampai 28 jam
sumber 720p, tapi satu sumber 1080p 4 jam berbitrate kamera (≈ 5,1 GB) tidak muat. Admission §B6.6
sudah menolak menyimpan entri yang tidak muat, jadi cap tidak membuat job gagal; sumber itu hanya
tidak di-cache.

**Keputusan: cap tetap 4 GiB (default Q6).** Diusulkan ke pemilik: setelah disk produksi diukur,
pertimbangkan 8 GiB kalau resolusi 1080p sering dipakai.

## Yang perlu pemilik

1. Mengukur disk produksi (baseline 81%) dan ukuran satu video YouTube 720p dan 1080p di produksi
   (metadata saja: `yt-dlp -J <url>` di container `primary-worker`, jumlahkan `filesize` format
   terpilih). Agen tidak punya akses produksi.
2. Mengambil baseline gate FETCH-M3 di produksi: waktu sampai seleksi untuk 5 sumber YouTube ≥ 30
   menit, dengan unduhan YouTube yang sebenarnya.
3. Memutuskan `yt-dlp-ejs` (dependensi baru, lewat extra `yt-dlp[default]`) agar tantangan JS
   YouTube bisa dipecahkan setelah Node 24.
4. Memutuskan cap cache 1080p (tetap 4 GiB atau 8 GiB).
5. Range-only: menjawab butir 3 gerbang §B11 (pemilihan ulang, editor ±60 dtk, identitas
   `clip_id`) kalau mau ditinjau ulang.
6. Kick: mencoba satu unduhan Kick tanpa `curl_cffi` (uji pemilik atau di produksi) sebelum
   FETCH-M5 dihitung go dan sebelum `POTONGIN_FETCH_KICK` dinyalakan.
7. bgutil: memutuskan apakah bgutil dibuang dari FETCH-M6. Sampai ada keputusan, default Q11
   berlaku (opt-in, mati). Kalau mau diukur, butuh proxy atau server produksi.
8. Meninjau pilihan codec audio-first (Opus/format `ba`, bukan AAC dari §B4 butir 5).

## Run yang dipakai

| Fase | Run | Commit |
|---|---|---|
| `env`, `extractors`, `sizes`, `proxy`, `kick` | [40104994075](https://github.com/RevDonz/ai-video-clipper/actions/runs/40104994075) | `86d56e75` |
| `youtube` | [40104914860](https://github.com/RevDonz/ai-video-clipper/actions/runs/40104914860) | `3ce157fc` |
| `audio` | [40104912904](https://github.com/RevDonz/ai-video-clipper/actions/runs/40104912904) | `3ce157fc` |
| `range` | [40103795306](https://github.com/RevDonz/ai-video-clipper/actions/runs/40103795306) | `333b530e` |
| `timing` 600 | [40103797198](https://github.com/RevDonz/ai-video-clipper/actions/runs/40103797198) | `333b530e` |
| `timing` 1800, 3600, 7200 | [40104278162](https://github.com/RevDonz/ai-video-clipper/actions/runs/40104278162), [40104280298](https://github.com/RevDonz/ai-video-clipper/actions/runs/40104280298), [40104282869](https://github.com/RevDonz/ai-video-clipper/actions/runs/40104282869) | `cbfd9339` |

Kode fase `range` dan `timing` tidak berubah setelah commit run-nya. Setelah run `kick`, fase itu
hanya berubah di sumber nama kanal (argumen, bukan konstanta di skrip) dan kunci `api` di hasil
(`kanal-1/…` menggantikan nama kanal); kunci di hasil mentah yang di-commit diganti dengan cara yang
sama. `report-2026-10-24.json` dihitung ulang setelah rumus §B11 memasukkan timeline audio. Run lain di branch ini adalah
percobaan yang diganti: `audio` [40104275687](https://github.com/RevDonz/ai-video-clipper/actions/runs/40104275687)
gagal mengunduh karena meminta 360p (talk hanya punya 720p ke atas); `youtube`
[40103793226](https://github.com/RevDonz/ai-video-clipper/actions/runs/40103793226) belum bisa
membangun server bgutil.

## Cara menjalankan ulang

```
gh workflow run editor-gates.yml -f ref=<branch> -f suite=command \
  -f command='python scripts/fetch/m0_measure.py --out /out/unduhan-m0.json --only env,extractors,sizes,proxy,kick --kick-channels <kanal>,<kanal>'
```

Tanpa `--kick-channels` (atau `POTONGIN_M0_KICK_CHANNELS`) fase `kick` mencatat `not_measured`.

Fase lain: `--only youtube`, `--only audio`, `--only range`, `--only timing --target 600|1800|3600|7200`
(satu run per target, karena Whisper lama). Gabungkan hasil run dengan
`python scripts/fetch/m0_measure.py merge A.json B.json … --out ALL.json`, lalu hitung angka turunan
dengan `python scripts/fetch/m0_measure.py report ALL.json --out REPORT.json`.
