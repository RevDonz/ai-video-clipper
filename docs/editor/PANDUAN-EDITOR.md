# Panduan editor klip

Panduan ini untuk pemilik Potongin: apa yang bisa dipakai di editor, arti tanda di layar, dan cara
mencobanya di aplikasi lokal. Rencana lengkapnya ada di `docs/plans/2026-09-24-editor-v3-esensial.md`;
angka pengujian ada di `docs/editor/GATES.md`; cara menjalankan dan memeriksa server ada di
`docs/editor/OPERASIONAL.md`.

Saat rilis, `compose.yaml` menyalakan semuanya: editor (`POTONGIN_EDITOR_V3=on`), unggah logo dan
musik (`POTONGIN_EDITOR_UPLOADS=on`, tinjauan keamanan lolos) dan saran hook yang ditulis AI
(`POTONGIN_EDITOR_LLM=on`, gerbang keras saran AI lolos; penilaian 30 klip oleh pemilik menyusul).
Klip otomatis dirender dengan cara yang sama dengan ekspor editor
(`POTONGIN_RENDER_ENGINE=edit-v2`): tampilannya sedikit berubah dan filenya lebih besar karena
kualitasnya lebih tinggi. Pra-centang kata pengisi di Rapikan masih mati sampai pemilik
mengonfirmasi labelnya. Daftar flag, syaratnya dan cara mematikannya: `docs/editor/OPERASIONAL.md`
§2.

Proyek lama tetap bisa dilihat dan diunduh dari Riwayat. Editor kandidat yang lama sudah tidak ada.

## 1. Membuka klip

- Di halaman proyek, setiap kartu klip punya tombol **"Edit klip"** (tombol pertama, paling
  terang). Klip yang sudah diedit memberi label "Diedit · revisi n" dan tautan "Ekspor terakhir".
- Di **Riwayat**, proyek yang selesai punya tombol **"Edit klip"** yang membuka daftar klipnya.
  Proyek lama yang dibuat sebelum editor ada tidak punya tombol ini; di halaman proyeknya, setiap
  kartu klip menyebut alasannya.
- Tidak ada langkah "Siapkan" lagi. Kalau proyeknya belum pernah dibuka di editor, editor
  menyiapkannya sendiri saat klip dibuka: layar "Menyiapkan klip untuk diedit" dengan hitungan
  detik. Ini hanya sekali per proyek: beberapa detik, sampai ± 1 menit untuk video panjang dengan
  face-track. Setelah itu alamatnya pindah ke alamat klip itu sendiri, jadi muat ulang langsung
  membuka klip.
- Klip yang memang tidak bisa diedit (misalnya video sumbernya sudah dihapus) menulis alasannya di
  kartu dan di editor, dengan tautan kembali ke proyek.

## 2. Yang bisa dipakai

**Transkrip (tab kiri).** Klik kata untuk memilih, Shift+klik untuk rentang.
- **Delete/Backspace** memotong kata terpilih (jump cut); klik chip "⋯ 1,4 dtk" untuk
  memulihkannya.
- **Enter** atau klik dua kali memperbaiki tulisan kata (caption saja; suara tetap).
- **Ctrl+Shift+X** menyembunyikan kata dari caption; **Ctrl+E** menandai kata kunci (tebal dan
  bergaris bawah warna kata kunci).
- **I / O** memindah awal atau akhir klip ke kata terpilih; kata di luar klip redup dengan tombol
  "Perpanjang ke sini". **Ctrl+Shift+H** menjadikan pilihan 0,5–8 detik sebagai cold open.
- **Rapikan** (tombol di atas transkrip): daftar kata pengisi ("eh", "anu"), pengulangan
  ("saya saya") dan jeda hening yang bisa dipotong di titik yang tenang. Jeda hening sudah
  tercentang, kata pengisi dan pengulangan belum (kata pengisi ikut tercentang setelah pemilik
  mengonfirmasi daftar labelnya). **Putar** memperdengarkan tiap item, **Lihat**
  menandainya di transkrip. **"Terapkan (n)"** memotong semua yang dicentang dalam satu langkah, dan
  satu Urungkan mengembalikan semuanya. Partikel ("kan", "sih", "mah", "toh", …) dan kata ulang
  ("anak-anak") tidak pernah didaftar. Jeda yang masih ada suaranya hanya bisa didengarkan.

**Teks (tab).** Caption: nyala/mati, gaya (Karaoke, Classic, Bold, Box), posisi, ukuran, huruf
besar, warna sorot dan warna kata kunci. Hook: teks (maks. 90 karakter, tanda "Muat" / "Akan
terpotong"), durasi dan posisi. **Saran hook** di bawah kolom teks: saran otomatis langsung
muncul dengan sumbernya ("AI seleksi" dari pemilihan klip, "Heuristik" dari transkrip); **"Pakai"**
mengganti teks hook (bisa diurungkan). Dengan `POTONGIN_EDITOR_LLM=on`, AI gratis di Pengaturan
juga menulis saran dari transkrip yang sudah diedit (sekitar 10 detik).

**Cold open (tab).** Nyala/mati, kalimat dan panjangnya, tambah/buang satu kata di tiap ujung.
**Saran cold open** mengusulkan kalimat terkuat dari klip; **Putar** memperdengarkannya,
**Pakai** menjadikannya cold open.

**Tata letak (tab).** **Latar blur**, **Ikuti wajah** dan **Potong tengah**, masing-masing dengan
contoh gambar di posisi putar. Berlaku untuk seluruh klip. "Ikuti wajah" pada proyek yang belum
punya analisis wajah menganalisis dulu (hitungan persen); bagian tanpa wajah didaftar dengan
tombol lompat, dan di bagian itu video dipusatkan.

**Logo (tab).** **"Unggah logo"** (PNG, JPEG atau WebP, maks. 10 MB; PNG transparan paling rapi)
atau seret file ke panel. Logo baru muncul di kanan atas, di luar area tombol TikTok/Reels. Posisi
cepat di empat sudut (semuanya di luar area itu), **Ukuran** dan **Opasitas**; di layar pratinjau
logo bisa digeser dan diubah ukurannya (panah 1 px, Shift+panah 10 px). Kalau logo digeser masuk
area tombol TikTok/Reels, muncul peringatan dengan tombol **"Geser ke area aman"**.

**Musik (tab).** **"Tambah musik"** (MP3, M4A, WAV, OGG atau FLAC, maks. 50 MB; baca dulu
catatan hak cipta). Volume musik, mulai dari, ulangi sampai klip selesai, muncul/hilang perlahan.
**Kecilkan musik saat ada suara** dengan kekuatan **Halus** (−6 dB), **Sedang** (−10 dB) atau
**Kuat** (−16 dB), plus "Atur detail" (waktu turun, naik, jeda tahan). Volume suara asli dan
**Samakan kenyaringan** (−14 LUFS) dengan hasil yang tercapai; kalau volume diturunkan supaya
tidak pecah, panel menuliskannya.

**Timeline (bawah).** Lajur video, teks, hook, **Audio** (waveform suara klip), **Penanda** (😂
tawa, jeda ≥ 0,6 detik, potongan kamera; klik untuk lompat; arahkan kursor untuk asal tandanya) dan
**Musik** (waveform musik dengan garis volume yang turun saat ada suara). Klik untuk pindah posisi,
seret gagang awal/akhir (menempel ke batas kata), Ctrl+scroll untuk zoom; scroll timeline ke bawah
untuk lajur Musik di layar pendek. Kalau job lama tidak punya data tawa/jeda, ada catatan "tidak
tersedia untuk job ini" (di lajurnya, atau di baris atas timeline bila lajurnya berisi penanda).

**Lainnya.** Urungkan / Ulangi (Ctrl+Z, Ctrl+Shift+Z) sampai 200 langkah; simpan otomatis
(± 1,5 detik setelah berhenti, juga disimpan di browser); **"Kembali ke versi AI"**; **Ekspor**
(centang tiap item "Perlu dicek"; catatan biru tidak perlu dicentang, begitu juga semua item klip
yang belum diubah, karena ekspornya file klip otomatis itu sendiri; lalu Antre → Merender →
Memverifikasi → Selesai, **"Unduh MP4"** dan **"Unduh SRT"**, tersimpan sebagai
`klip-02-revisi-5.mp4` dan seterusnya; bisa dibatalkan); dua tab pada klip yang sama digabung per
bagian.

## 3. Arti tanda di bawah layar pratinjau

| Tanda | Artinya |
|---|---|
| **● Sesuai hasil akhir** | Frame, teks, logo dan audio yang Anda lihat sama dengan hasil ekspor. File MP4 akhir dikompresi (H.264, warna 4:2:0), jadi tepi teks berwarna sedikit lebih lembut. **"Frame akhir"** (Ctrl+Shift+R) menampilkan piksel persisnya. Tanda ini hanya muncul kalau semua lapisan sudah terbaru. |
| **Menyiapkan video (7/30)…** | Potongan video pratinjau masih dibuat server. Frame terakhir yang pasti tetap tampil. |
| **Memperbarui teks… / logo… / Menyiapkan audio…** | Lapisan itu sedang diperbarui (biasanya < 1 detik). |
| **Menyiapkan frame…** | Frame di posisi ini sedang digambar. |
| **● Belum diubah: ekspor = klip otomatis** | Klip belum diedit, jadi ekspornya adalah file klip otomatis apa adanya. Klip otomatis dari proyek yang dirender sebelum render disamakan dengan editor bisa sedikit berbeda dari pratinjau. Setelah ada perubahan, tanda kembali ke "Sesuai hasil akhir". |
| **● Frame akhir** | Piksel hasil render akhir untuk frame ini. |

Tombol **"Apa artinya?"** di sebelah tanda menampilkan penjelasan yang sama.

### Apa yang dijamin "Sesuai hasil akhir"

Pratinjau dan ekspor dibuat dari dokumen yang sama oleh aturan yang sama, dan CI mengujinya pada
setiap perubahan kode (setiap PR) dan setiap malam:

- **Frame:** setiap frame pratinjau menampilkan frame sumber yang sama dengan file akhir, termasuk
  di setiap potongan dan cold open. Uji: 0 frame berbeda (ribuan frame, empat jenis frame rate).
- **Waktu teks:** caption, hook dan kata aktif karaoke muncul dan hilang di frame yang sama.
  Uji: 0 selisih di lima frame rate.
- **Bentuk teks:** gambar teks di browser hampir identik dengan gambar teks di file akhir
  sebelum kompresi (SSIM ≥ 0,999, beda tiap warna maksimal 16 dari 255).
- **Audio:** sampel audio pratinjau sama persis dengan audio sebelum dikompresi ke AAC.
- **Yang memang berbeda:** file MP4 dikompresi (H.264, warna 4:2:0), jadi tepi teks berwarna
  sedikit lebih lembut. Batasnya diuji: kemiripan seluruh frame ≥ 0,990 dan area teks ≥ 0,980.
  Untuk melihat piksel persisnya, pakai **"Frame akhir"**.
- Klip yang belum diubah diekspor sebagai file klip otomatis itu sendiri (tidak dirender ulang).

## 4. Mencoba editor di aplikasi lokal

Syarat: Chrome atau Edge desktop, jendela minimal 1024 px.

1. Pakai cabang `main` terbaru di folder repo (sebelum editor digabung ke `main`: cabang
   integrasi editor yang terakhir, lihat `docs/HANDOFF.md`):

   ```bash
   cd /home/revdonz/Projects/ai-video-clipper
   git switch main && git pull
   uv sync --frozen --extra vision
   (cd web && npm ci)
   ```

2. Buat berkas toolchain lokal sekali saja (ekspor memberi nama file menurut versi FFmpeg/libass;
   image Docker membuatnya sendiri):

   ```bash
   .venv/bin/python -m ai_clipper.edit_v2.toolchain write resources/toolchain.json \
     --base-image "local/dev-host@sha256:$(printf potongin-local-dev | sha256sum | cut -c1-64)"
   ```

3. Jalankan aplikasi dengan editor, unggahan dan (kalau mau) saran AI menyala:

   ```bash
   POTONGIN_EDITOR_V3=on POTONGIN_EDITOR_UPLOADS=on POTONGIN_EDITOR_LLM=on artifacts/local/start-local.sh
   ```

4. Di terminal kedua, jalankan render worker (untuk ekspor dari editor):

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

5. Buka `http://127.0.0.1:3000/projects`, klik **"Edit klip"** di proyek mana pun yang selesai,
   lalu **"Edit klip"** di kartu klipnya.

Tanpa `POTONGIN_EDITOR_V3=on`, tombol "Edit klip", tautan "Ekspor terakhir" dan semua rute editor
hilang (404); file ekspornya tetap ada dan tautannya kembali saat flag dinyalakan. Dokumen edit
yang sudah tersimpan tetap ada di folder proyek (`analysis/clips/…`), logo dan musik di
`analysis/assets/`, dan klip otomatis tidak berubah.

Di server (Docker), flag diatur di `.env`; `compose.yaml` meneruskannya ke container yang
memerlukannya dan memegang bawaan rilisnya (`docs/editor/OPERASIONAL.md` §2).
`POTONGIN_LLM_EDITOR_MODELS` (opsional, `provider/model` dipisah koma) memilih model gratis khusus
untuk saran hook; kosong berarti rantai di Pengaturan.

## 5. Pintasan keyboard

| Tombol | Aksi |
|---|---|
| Spasi / K | Putar / jeda |
| ← / → | Mundur / maju satu frame (Shift: 1 detik) |
| Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y | Urungkan / ulangi |
| Delete / Backspace | Potong kata terpilih |
| Enter | Edit kata |
| I / O | Awal / akhir klip di pilihan atau di posisi putar |
| Ctrl+Shift+H | Pilihan → cold open |
| Ctrl+E / Ctrl+Shift+X | Kata kunci / sembunyikan dari caption |
| ' | Zona aman TikTok |
| Ctrl+Shift+R | Frame akhir |
| Ctrl+Shift+E | Ekspor |
| ? | Bantuan pintasan |

Setiap aksi juga punya tombol di layar. Pintasan tidak aktif saat Anda mengetik di kolom teks.

## 6. Kalau ada masalah

| Yang terlihat | Penyebab dan jalan keluar |
|---|---|
| "Menyiapkan klip untuk diedit" lama sekali | Proyek panjang dengan face-track. Tunggu; setelah 12 menit editor menyerah dan meminta muat ulang. |
| "Video sumber tidak bisa dibaca; proses ulang videonya" | FFmpeg gagal membaca video sumber proyek ini (filenya masih ada). Proses ulang videonya dari dashboard. |
| Catatan biru "Caption di posisi bawaan, dekat tombol TikTok" | Hanya pemberitahuan, bukan kesalahan, dan tidak perlu dicentang saat ekspor: caption bawaan memang di posisi yang sama dengan klip otomatis, supaya klip yang tidak diubah tetap diekspor sebagai file klip otomatis. Kalau di aplikasi caption tertutup tombol, geser caption ke atas di tab Teks. Caption yang Anda geser sendiri ke area itu tetap muncul di "Perlu dicek" dan perlu dicentang. |
| "Transkrip berubah sejak klip diedit" (baca saja) | Proyek dijalankan ulang dan transkripnya berubah. Klik "Mulai dari versi AI". |
| "Klip ini diubah di tab lain" | Dua tab mengubah bagian yang sama. Pilih versi per bagian; draf Anda tidak hilang. |
| "Gagal menyimpan; perubahan aman di browser ini" | Server tidak terjangkau. Perubahan tersimpan di browser dan dikirim lagi otomatis. |
| "Unggah logo belum tersedia di server ini" / "Unggah file belum diaktifkan di server ini" | `POTONGIN_EDITOR_UPLOADS` belum `on`. |
| Saran hook hanya "AI seleksi"/"Heuristik" | `POTONGIN_EDITOR_LLM` belum `on`, atau AI di Pengaturan sedang tidak bisa dipakai. |
| Lajur Penanda: "tidak tersedia untuk job ini" | Job lama tanpa analisis audio; jalankan ulang proyeknya kalau butuh penanda. |
| Ekspor: "Layanan editor sedang tidak tersedia" | Di lokal: `resources/toolchain.json` belum dibuat (langkah 2). |
| Ekspor tetap "Antre" | Render worker belum berjalan (langkah 4). |
| "Editor butuh layar minimal 1024 px" | Perlebar jendela atau pakai laptop/komputer. |
| "Pratinjau langsung butuh Chrome/Edge desktop" | Browser tanpa WebCodecs. Mengedit dan mengekspor tetap bisa; pratinjau memakai "Frame akhir". |

## 7. Lisensi pihak ketiga

Pratinjau editor memakai JASSUB (libass di browser) dan Mediabunny, dan caption memakai font
Montserrat dan DejaVu. Lisensinya, versi persisnya dan tempat kode sumbernya ada di halaman
**`/licenses`** aplikasi (teksnya di `web/public/licenses/`). Kewajiban yang perlu dijaga saat
mengganti salah satunya: `docs/editor/OPERASIONAL.md` §6.
