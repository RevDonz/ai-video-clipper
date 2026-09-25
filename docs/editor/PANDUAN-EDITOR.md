# Panduan Editor V3 (tahap W2: "Editor bisa dipakai")

Panduan ini untuk pemilik Potongin. Isinya: apa yang sudah bisa dipakai di Editor V3, arti tanda
di layar, dan cara mencobanya di aplikasi lokal. Rencana lengkapnya ada di
`docs/plans/2026-09-24-editor-v3-esensial.md`; angka pengujian ada di `docs/editor/GATES.md`.

Editor V3 **masih mati secara bawaan**. Ia hanya muncul kalau `POTONGIN_EDITOR_V3=on`. Klip
otomatis juga masih dibuat mesin lama (`POTONGIN_RENDER_ENGINE=legacy`) sampai Anda menyetujui
tampilan mesin baru (keputusan K1 di checkpoint 2).

## 1. Yang sudah bisa dipakai

Buka proyek V3, lalu klik **"Edit klip"** di kartu klip. Untuk proyek yang dibuat sebelum
editor ini ada, klik **"Siapkan untuk editor"** sekali per proyek (beberapa detik; proyek
face-track sampai ± 1 menit karena jalur kameranya dihitung; setelah itu tombol "Edit klip"
muncul). Pembukaan pertama tiap klip butuh 1–3 detik sampai gambar pertama tampil, karena potongan
video pratinjaunya dibuat saat itu.

Di dalam editor:

- **Transkrip (tab kiri).** Klik kata untuk memilih, Shift+klik untuk rentang.
  - **Delete/Backspace** memotong kata terpilih (jump cut). Bagian yang dipotong tampil dicoret
    dengan chip "⋯ 1,4 dtk"; klik chip untuk memulihkannya.
  - **Enter** atau klik dua kali: perbaiki tulisan kata (Enter simpan, Esc batal, Tab ke kata
    berikutnya). Yang berubah hanya caption; suara tetap.
  - **Ctrl+Shift+X** menyembunyikan kata dari caption; **Ctrl+E** memberi warna kata kunci.
  - **I / O** ("Mulai di sini" / "Akhiri di sini") memindah awal atau akhir klip ke kata terpilih.
    Kata di luar klip tampil redup dengan tombol **"Perpanjang ke sini"**.
  - **Ctrl+Shift+H** ("Jadikan cold open") menjadikan pilihan 0,5–8 detik sebagai cold open.
- **Teks (tab).** Caption: nyala/mati, 4 gaya (Karaoke, Classic, Bold, Box), posisi, ukuran,
  huruf besar, warna sorot dan warna kata kunci. Hook: nyala/mati, teks (maks. 90 karakter, dengan
  tanda "Muat"/"Akan terpotong"), durasi dan posisi.
- **Cold open (tab).** Nyala/mati, kalimatnya dan panjangnya, tambah/buang satu kata di tiap
  ujung.
- **Timeline (bawah).** Klik untuk pindah posisi; seret gagang awal/akhir klip (selalu menempel
  ke batas kata); Ctrl+scroll untuk zoom.
- **Urungkan / Ulangi** (Ctrl+Z, Ctrl+Shift+Z) sampai 200 langkah.
- **Simpan otomatis.** Setiap perubahan disimpan sendiri (± 1,5 detik setelah berhenti mengetik)
  dan juga disimpan di browser. Muat ulang halaman di tengah pengeditan tidak menghilangkan apa
  pun. Status di atas: "Tersimpan · 3 dtk lalu" / "Menyimpan…" / "Belum tersimpan".
- **"Kembali ke versi AI"** mengembalikan klip ke hasil otomatis (bisa diurungkan).
- **Ekspor.** Tombol **"Ekspor"**: centang tiap peringatan di "Perlu dicek", lalu "Mulai ekspor".
  Tahapannya Antre → Merender (n%) → Memverifikasi → Selesai, lalu **"Unduh MP4"** dan
  **"Unduh SRT"**. Ekspor bisa dibatalkan. Klip yang tidak diubah langsung selesai: file yang
  diunduh adalah file klip otomatis itu sendiri.
- **Dua tab.** Kalau klip yang sama terbuka di dua tab, muncul "Klip ini terbuka di tab lain".
  Perubahan di bagian berbeda digabung otomatis; kalau bagian yang sama diubah di dua tab, editor
  menanyakan per bagian ("Pakai punyaku" / "Pakai yang tersimpan").

Tab **Tata letak, Logo dan Musik** serta lajur **Audio, Penanda dan Musik** di timeline sudah
terlihat tetapi masih kosong: isinya datang di tahap berikutnya (W3), bersama saran hook AI,
"Rapikan" (filler, pengulangan, jeda) dan penanda tawa/jeda.

## 2. Arti tanda di bawah layar pratinjau

| Tanda | Artinya |
|---|---|
| **● Sesuai hasil akhir** | Frame, teks, logo dan audio yang Anda lihat sama dengan hasil ekspor. File MP4 akhir dikompresi (H.264, warna 4:2:0), jadi tepi teks berwarna sedikit lebih lembut. Tekan **"Frame akhir"** (Ctrl+Shift+R) untuk melihat piksel persisnya. Tanda ini hanya muncul kalau semua lapisan sudah terbaru; pratinjau tidak pernah menebak atau memperkirakan. |
| **Menyiapkan video (7/30)…** | Potongan video pratinjau masih dibuat server. Frame terakhir yang pasti tetap tampil. |
| **Memperbarui teks…** | Caption/hook sedang diperbarui (biasanya < 0,4 detik). |
| **Menyiapkan audio…** | Campuran audio baru sedang dibuat; tombol putar menunggu. |
| **Menyiapkan frame…** | Frame di posisi ini sedang digambar. |
| **● Belum diubah: ekspor = klip otomatis (mesin lama)** | Klip dari proyek lama yang belum diedit. Ekspornya adalah klip otomatis lama itu sendiri, sedangkan pratinjau memakai mesin baru, jadi tampilannya bisa sedikit berbeda. Setelah ada perubahan, ekspor memakai mesin baru dan tanda kembali ke "Sesuai hasil akhir". |
| **● Frame akhir** | Anda sedang melihat piksel hasil render akhir untuk frame ini. |

Tombol **"Apa artinya?"** di sebelah tanda menampilkan penjelasan yang sama.

## 3. Mencoba editor di aplikasi lokal

Syarat: Chrome atau Edge desktop, jendela minimal 1024 px. (Browser lain tetap bisa mengedit dan
mengekspor, tetapi pratinjaunya hanya berupa "Frame akhir".)

1. Pakai cabang hasil W2 di folder repo:

   ```bash
   cd /home/revdonz/Projects/ai-video-clipper
   git switch editor-w2-integration
   uv sync --frozen --extra vision
   (cd web && npm ci)
   ```

2. Buat berkas toolchain lokal sekali saja. Ekspor editor memberi nama file menurut versi
   FFmpeg/libass yang dipakai; image Docker membuatnya sendiri, di lokal buat dengan:

   ```bash
   .venv/bin/python -m ai_clipper.edit_v2.toolchain write resources/toolchain.json \
     --base-image "local/dev-host@sha256:$(printf potongin-local-dev | sha256sum | cut -c1-64)"
   ```

   Berkas ini tidak masuk git. Tanpa berkas ini ekspor menjawab "Layanan editor sedang tidak
   tersedia".

3. Jalankan aplikasi seperti biasa, tetapi dengan editor menyala:

   ```bash
   POTONGIN_EDITOR_V3=on artifacts/local/start-local.sh
   ```

4. Di terminal kedua, jalankan render worker (dipakai untuk ekspor dari editor). Nilainya sama
   dengan `start-local.sh`:

   ```bash
   cd /home/revdonz/Projects/ai-video-clipper
   JOBS_ROOT="$PWD/artifacts/local/jobs" \
   RENDER_STORAGE_CLI="$PWD/web/scripts/render-storage-admission.mjs" \
   JOBS_STORAGE_QUOTA_BYTES=32212254720 JOBS_STORAGE_MIN_FREE_BYTES=16106127360 \
   JOBS_STORAGE_ACTIVE_RESERVE_BYTES=2147483648 JOBS_STORAGE_SCAN_MAX_ENTRIES=200000 \
   JOBS_STORAGE_SCAN_MAX_DEPTH=16 JOBS_STORAGE_SCAN_DEADLINE_MS=30000 \
   JOBS_STORAGE_RECHECK_BYTES=8388608 JOBS_STORAGE_RECHECK_INTERVAL_MS=5000 \
   .venv/bin/python -m ai_clipper.render_worker --jobs-root "$PWD/artifacts/local/jobs" --watch --poll-seconds 2
   ```

5. Buka `http://127.0.0.1:3000/projects`, pilih proyek V3, klik **"Siapkan untuk editor"**
   (sekali), lalu **"Edit klip"**.

Untuk mematikan editor lagi, jalankan `start-local.sh` tanpa `POTONGIN_EDITOR_V3=on`: tombol
"Edit klip" dan semua rute editor hilang (404). Dokumen edit yang sudah tersimpan tetap ada di
folder proyek (`analysis/clips/…`) dan tidak mengubah klip otomatis.

Di server (Docker), editor dinyalakan dengan `POTONGIN_EDITOR_V3=on` di `.env`; `compose.yaml`
sudah meneruskannya ke container `app` dan bawaannya `off`.

## 4. Pintasan keyboard

| Tombol | Aksi |
|---|---|
| Spasi / K | Putar / jeda |
| ← / → | Mundur / maju satu frame (Shift: 1 detik) |
| Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y | Urungkan / ulangi |
| Delete / Backspace | Potong kata terpilih |
| Enter | Edit kata |
| I / O | Awal / akhir klip di pilihan atau di posisi putar |
| Ctrl+Shift+H | Pilihan → cold open |
| Ctrl+E / Ctrl+Shift+X | Warna kata kunci / sembunyikan dari caption |
| ' | Zona aman TikTok |
| Ctrl+Shift+R | Frame akhir |
| Ctrl+Shift+E | Ekspor |
| ? | Bantuan pintasan |

Setiap aksi juga punya tombol di layar. Pintasan tidak aktif saat Anda mengetik di kolom teks.

## 5. Kalau ada masalah

| Yang terlihat | Penyebab dan jalan keluar |
|---|---|
| "Klip perlu disiapkan dulu" | Proyek lama: klik "Siapkan untuk editor" di halaman proyek. |
| "Transkrip berubah sejak klip diedit" (baca saja) | Proyek dijalankan ulang dan transkripnya berubah. Klik "Mulai dari versi AI" untuk mulai lagi dari hasil otomatis yang baru. |
| "Klip ini diubah di tab lain" | Dua tab mengubah bagian yang sama. Pilih versi per bagian; draf Anda tidak hilang. |
| "Gagal menyimpan; perubahan aman di browser ini" | Server tidak terjangkau. Perubahan tersimpan di browser dan dikirim lagi otomatis; ada tombol untuk mencoba lagi. |
| Ekspor: "Layanan editor sedang tidak tersedia" | Di lokal: berkas `resources/toolchain.json` belum dibuat (langkah 2). |
| Ekspor tetap "Antre" | Render worker belum berjalan (langkah 4). |
| Ekspor: "Video sumber sudah tidak ada" | File video sumber proyek hilang atau proyek dipindah ke folder lain. |
| "Editor butuh layar minimal 1024 px" | Perlebar jendela atau pakai laptop/komputer. |
| "Pratinjau langsung butuh Chrome/Edge desktop" | Browser tidak punya WebCodecs. Mengedit dan mengekspor tetap bisa; pratinjau memakai "Frame akhir". |
