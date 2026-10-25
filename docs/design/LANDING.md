# Halaman depan

Sumber: `web/app/page.jsx`, `web/app/landing.module.css`, `web/components/LandingClip.jsx`,
`web/lib/landing-media.mjs`, `web/lib/landing-preview.mjs`. Arah: `DESIGN.md`, dial ENERGY 1 /
RHYTHM 1 / MOTION 2.

Urutan bagian: hero berbasis tipografi ("Tempel link, klipnya menyusul."), langsung disusul
**Contoh** (frame 16:9 dengan jendela 9:16 yang bergeser sekali ke subjek, penanda 8:09 di panjang
film, panah, lalu klip 9:16 yang diputar), Cara kerja (dua jalur: Anda di awal dan akhir, Potongin
di tengah), **Gaya** (enam render gaya subtitle dari `components/editor/panels/pack-thumbs/` dan
empat tata letak), Fitur (panel Hasil dan Editor dengan tangkapan layarnya, catatan "Editor butuh
layar minimal 1024 px", lalu daftar fitur kecil), Privasi, penutup, footer dengan kredit video
contoh.

Posisi jendela 9:16 (kiri 23,4 %, lebar 31,64 % frame) diukur dengan membandingkan `sesudah.webp`
dengan `sebelum.webp`; penanda ada di 489 dari 658 detik (74,3 %). `editor.webp` sudah
memperlihatkan tata letak editor terbaru (rel alat kiri, pratinjau tengah, panel kanan), diambil
2026-10-22 (langkah 6 di bawah).

## Bukti produk

Semua gambar dan klip berasal dari **satu proyek nyata** yang dibuat Potongin dari satu video
sumber; `editor.webp` memakai klip proyek itu (`sesudah.mp4`) di editor sungguhan. Tidak ada
gambar tiruan, angka karangan, atau footage pihak ketiga tanpa lisensi.

| File (`web/public/landing/`) | Isi | Ukuran gambar |
|---|---|---|
| `hasil.webp` | Tangkapan layar penampil klip di halaman proyek (klip terbaik terbuka) pada proyek contoh yang disemai di CI dari `sesudah.mp4` (`web/e2e/landing-shots.spec.mjs`, `editor-gates.yml -f suite=e2e -f seed=true -f command=e2e/landing-shots.spec.mjs`) | 1400 × 860 |
| `editor.webp` | Tangkapan layar editor sungguhan, Mode Lengkap, detik ke-2, pada job contoh yang sumbernya `sesudah.mp4` (langkah 6) | 1440 × 900 |
| `sebelum.webp` | Frame sumber 16:9 di 8:09,62 (saat yang sama dengan poster klip) | 960 × 540 |
| `sesudah.webp` | Poster klip: frame klip 2 di detik 0,6 | 432 × 768 |
| `sesudah.mp4` | 11 detik pertama klip 2 (cold open, transisi, awal klip), H.264 tanpa audio, `+faststart` | 432 × 768 |

Total sekitar 1,1 MB. `web/tests/landing-media.test.mjs` menjaga anggarannya: semua media
bersama ≤ 4 MB, gambar ≤ 250 KB per file, klip ≤ 1,5 MB, 4 sampai 15 detik, 9:16, tanpa trek
audio, `moov` sebelum `mdat`; isi folder sama persis dengan daftar di `landing-media.mjs`, dan
lebar/tinggi di daftar sama dengan file (tidak ada geser tata letak saat gambar dimuat).

Hanya path yang persis ada di daftar itu yang dilayani tanpa login (`web/proxy.js`); file lain di
`public/` tetap di balik login.

## Video contoh dan lisensinya

- Judul: **Elephants Dream** (2006), Orange Open Movie Project.
- Hak cipta: © Blender Foundation / Netherlands Media Art Institute, www.elephantsdream.org.
- Lisensi: **CC BY 2.5** (https://creativecommons.org/licenses/by/2.5/).
- File sumber: Wikimedia Commons, `File:Elephants_Dream_(2006)_1080p24.webm`, turunan 1080p VP9.
- Perubahan: potongan frame 16:9, klip 9:16 dengan subtitle dan teks hook, dan dua tangkapan
  layar aplikasi, semuanya dibuat dengan Potongin.

Kredit ditulis di bawah contoh (judul dan tautan ke sumber) dan di footer (judul, pemegang hak,
lisensi dengan tautan, keterangan perubahan), sesuai syarat atribusi CC BY.

Kenapa film ini: animasi tanpa orang sungguhan (tidak ada potret orang yang dipakai untuk
promosi tanpa izin), lisensinya boleh diedarkan ulang di repo publik, rasio 16:9, dan banyak
dialog. Dialognya bahasa Inggris; halaman menyebutnya, dan Potongin memang menerima video bahasa
Inggris ("Bahasa video").

## Cara membuatnya (dan menggantinya)

1. Jalankan aplikasi lokal di port bebas (bukan 3000/3001) dengan `JOBS_ROOT` dan folder
   pengaturan baru yang kosong, `POTONGIN_RENDER_ENGINE=edit-v2`, `POTONGIN_EDITOR_V3=on`,
   `WHISPER_MODEL=small`, plus primary worker. Tanpa penyedia AI di Pengaturan, momen dipilih
   heuristik lokal (halaman menyebut "dibuat tanpa AI").
2. Unggah video sumber dari dashboard: Ikuti pembicara, 3 klip, durasi 20 sampai 60 detik, cold
   open dan teks hook menyala, Karaoke, bahasa video Inggris.
3. Tangkapan layar dengan Chromium headless (Playwright) di 1440 × 900: halaman proyek
   `?klip=2` dengan skala 2 lalu dipotong ke bagian klip. Indikator dev Next (`nextjs-portal`)
   disembunyikan. Tangkapan editor: langkah 6.
4. Media, dengan FFmpeg:

   ```bash
   # 11 detik pertama klip, tanpa audio
   ffmpeg -i clip-02.mp4 -t 11 -an -vf "scale=432:768:flags=lanczos,format=yuv420p" \
     -c:v libx264 -preset slow -crf 30 -profile:v main -tune film -movflags +faststart sesudah.mp4
   # poster klip dan frame sumber di saat yang sama (cold open klip 2 mulai di 489,02 detik)
   ffmpeg -ss 0.6 -i clip-02.mp4 -frames:v 1 -vf "scale=432:768:flags=lanczos" \
     -c:v libwebp -quality 78 -compression_level 6 sesudah.webp
   ffmpeg -ss 489.62 -i sumber.webm -frames:v 1 -vf "scale=960:540:flags=lanczos" \
     -c:v libwebp -quality 78 -compression_level 6 sebelum.webp
   # tangkapan layar panel Hasil (editor.webp: langkah 6)
   ffmpeg -i tangkapan.png -c:v libwebp -quality 80 -compression_level 6 hasil.webp
   ```

5. Perbarui ukuran di `web/lib/landing-media.mjs`, teks waktu di `page.jsx` (menit sumber, durasi
   film dan klip), tabel di atas, dan kredit kalau sumbernya berganti. Jalankan
   `node --test tests/landing-media.test.mjs tests/landing-preview.test.mjs tests/entry-pages.test.mjs`.
6. `editor.webp` saja (tanpa memproses ulang film, tanpa FFmpeg encode):
   - `python scripts/editor_fixture/landing_demo.py <JOBS_ROOT kosong>` membuat satu job V3 dari
     `sesudah.mp4` (disalin apa adanya). Kata dan waktunya dibaca dari caption karaoke klip itu
     (frame tiap 0,2 detik di Chrome); judul, teks hook dan skor sama dengan panel Hasil proyek
     aslinya. `prepare_job` menulis seed, kata dan peaks; revisi 1 mematikan caption editor
     karena klip sumber sudah membawa caption hasil render.
   - Jalankan aplikasi di port bebas dengan `JOBS_ROOT` itu, `POTONGIN_EDITOR_V3=on`,
     `PYTHON_BIN` dari `.venv`, tanpa fakes. Buka `/projects/<id>/clips/<clipId>/edit?mode=lengkap`
     di Google Chrome (perlu H.264 dan WebCodecs) di 1440 × 900, tunggu "Sesuai hasil akhir",
     Shift+→ dua kali, sembunyikan `nextjs-portal`, ambil tangkapan layar. Lane preview server
     membuat sel plate kecil dari sumber saat editor dibuka; render worker tidak perlu.
   - Encode WebP di browser yang sama (`canvas.toDataURL("image/webp", 0.82)`), cek ≤ 250 KB, lalu
     jalankan tes di langkah 5.

## Klip yang bergerak

`web/lib/landing-preview.mjs` mengatur satu-satunya video di halaman:

- diputar hanya saat terlihat di layar (IntersectionObserver), dijeda saat tab disembunyikan;
- tombol **Jeda** / **Putar** selalu terlihat di bawahnya, dan pilihan itu bertahan saat halaman
  digulir atau tab berpindah;
- dengan `prefers-reduced-motion`, klip mulai dalam keadaan jeda (poster) sampai pengunjung
  menekan Putar; kalau setelan itu dinyalakan saat klip berjalan, klip dijeda;
- `preload="none"`, `muted`, `playsInline`, `loop`, tanpa atribut `autoplay`. Kalau browser
  menolak memutar, tombolnya menjadi Putar. Tanpa JavaScript, yang tampil hanya posternya.
