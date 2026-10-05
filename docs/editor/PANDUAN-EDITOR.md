# Panduan editor klip

Panduan ini untuk pemilik Potongin: apa yang bisa dipakai di editor, arti tanda di layar, dan cara
mencobanya di aplikasi lokal. Rencana lengkapnya ada di `docs/plans/2026-09-24-editor-v3-esensial.md`;
angka pengujian ada di `docs/editor/GATES.md`; cara menjalankan dan memeriksa server ada di
`docs/editor/OPERASIONAL.md`.

Saat rilis, `compose.yaml` menyalakan semuanya: editor (`POTONGIN_EDITOR_V3=on`), unggah logo dan
musik (`POTONGIN_EDITOR_UPLOADS=on`, tinjauan keamanan lolos) dan saran hook yang ditulis AI
(`POTONGIN_EDITOR_LLM=on`, gerbang keras saran AI lolos; penilaian 30 klip oleh pemilik menyusul).
Klip otomatis masih dirender dengan cara lama (`POTONGIN_RENDER_ENGINE=legacy`) sampai pemilik
memutuskan soal kuota CPU; dengan `edit-v2` klip otomatis dirender sama dengan ekspor editor,
tampilannya sedikit berubah dan filenya lebih besar karena kualitasnya lebih tinggi. Pra-centang kata pengisi di Rapikan masih mati sampai pemilik
mengonfirmasi labelnya. Daftar flag, syaratnya dan cara mematikannya: `docs/editor/OPERASIONAL.md`
§2.

Proyek lama tetap bisa dilihat dan diunduh dari Riwayat. Editor kandidat yang lama sudah tidak ada.

Editor punya dua tampilan untuk klip yang sama: **Mode Cepat** (bawaan), enam kartu untuk pekerjaan
sehari-hari, dan **Mode Lengkap**, untuk memotong per kata di transkrip, timeline dan pengaturan
detail. Keduanya memakai dokumen, riwayat Urungkan, simpan otomatis dan ekspor yang sama, jadi
pindah tampilan tidak menghilangkan apa pun. Rencananya: `docs/plans/2026-10-02-editor-mode-cepat.md`.

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
- Klip terbuka di **Mode Cepat**, kecuali terakhir kali Anda memilih Mode Lengkap di browser ini.
  Pindah lewat sakelar **Cepat | Lengkap** di bar atas: dengan mouse, atau Tab ke sakelar lalu
  ←/→. Pilihan itu diingat per browser, dan alamatnya ikut berubah (`?mode=cepat` atau
  `?mode=lengkap`), jadi muat ulang tetap di tampilan yang sama.
- Alamat langsung: `?panel=transcript` (juga `text`, `coldopen`, `layout`, `logo`, `music`) membuka
  Mode Lengkap dengan panel itu; `?card=lines` (juga `hook`, `caption`, `coldopen`, `layout`,
  `extras`) membuka Mode Cepat dengan kartu itu. Alamat langsung tidak mengubah pilihan yang
  diingat. Kalau harus login dulu, editor terbuka di tampilan yang diingat tanpa panel atau kartu
  pilihan.

## 2. Yang bisa dipakai

### Mode Cepat

Kartu ada di kanan pratinjau, dan hanya satu yang terbuka: klik judul kartu untuk membuka atau
menutupnya. Saat editor dibuka, kartu **Caption** yang terbuka. Judul tiap kartu menulis
ringkasannya, misalnya "Karaoke · Sedang · Bawah" atau "Kilat putih + whoosh". Di bawah pratinjau
ada Putar, waktu, bilah posisi (penjelasannya di bawah), dan **"Potong per kata di Mode Lengkap →"**
yang membuka transkrip.

**Hook.** Sakelar **Tampilkan hook** dan kolom **Teks di awal klip** (maks. 90 karakter, tanda
"Muat" / "Akan terpotong"). Di bawahnya **Saran**: klik satu saran untuk memakainya (bisa
diurungkan). Saran AI baru diminta saat kartu ini dibuka, jadi membuka editor tidak memakai kuota AI.
Durasi dan posisi hook diatur di Mode Lengkap.

**Caption.** Sakelar **Tampilkan caption**, empat gaya, **Warna sorot**, **Ukuran** (Kecil, Sedang,
Besar) dan **Posisi** (Atas, Tengah, Bawah; Bawah adalah posisi bawaan klip otomatis). Ukuran atau
posisi yang diatur halus di Mode Lengkap tampil sebagai persen di ringkasan, dan tidak ada tombol
yang tertekan. Kalau caption terlalu dekat dengan teks hook, kartu menulis "Caption dekat teks hook.
Kalau bertumpuk di pratinjau, turunkan caption." Catatan ini hanya petunjuk: pratinjau yang
menentukan.

**Teks caption.** Satu kolom per baris caption, diberi label waktunya. Ketik untuk membetulkan
kata, lalu Enter, Tab atau klik di luar untuk menyimpan; Esc membatalkan. Saat diam, mengeklik
baris memindah pratinjau ke baris itu; saat diputar, baris yang sedang tampil diberi garis tepi.
- Waktu kata tidak berubah dan suara tidak dipotong: ini hanya tulisan caption.
- Menghapus kata menyembunyikannya dari caption. Mengetik ulang kata yang tadi dihapus
  memunculkannya lagi dengan waktunya sendiri.
- Kata yang benar-benar baru menempel ke kata di sebelahnya, jadi di Karaoke dan Bold keduanya
  menyala bersamaan.
- Mengosongkan baris menyembunyikan seluruh baris ("Baris disembunyikan dari caption."). Satu
  Urungkan membatalkan satu baris yang disimpan.
- Baris dibagi seperti di hasil akhir: maks. 4 kata, putus setelah akhir kalimat, dan di Box juga
  menurut lebar. Mengetik titik atau tanda tanya, atau menghapus kata, bisa memecah atau
  menggabungkan baris; kursor tetap di baris yang memuat kata Anda.
- Kalau susunan baris berubah saat Anda masih mengetik, ketikan Anda tetap disimpan dan hanya
  mengubah kata yang tampil di kolom itu waktu Anda mulai mengetik.
- Kalimat cold open muncul dua kali (di cold open dan di isi klip), bertanda "Cold open". Mengubah
  salah satunya mengubah keduanya.
- Di gaya Bold kolomnya huruf besar, seperti pratinjau; mengetik ulang teks yang sama tidak
  mengubah apa pun.
- Batas: maks. 40 kata per baris dan 40 huruf per kata (termasuk tambahannya). Baris yang ditolak
  tetap berisi ketikan Anda, bertepi merah, dengan alasannya di bawahnya.

**Cold open.** Kalimat cold open dan panjangnya, **Putar**, **Ganti kalimat** (daftar saran, tiap
saran dengan Putar dan Pakai), lalu bagian **Transisi** yang sama persis dengan Mode Lengkap, dan
**Hapus cold open**. Tanpa cold open kartu menulis "Belum ada cold open." dengan tombol **Pilih
kalimat**. Menambah atau membuang kata di ujung kalimat ada di Mode Lengkap.

**Tata letak.** **Latar blur**, **Potong tengah** dan **Ikuti wajah**. Analisis wajah tetap berjalan
walau kartu ditutup atau tampilan dipindah; progresnya juga tampil di panel Tata letak.

**Logo & Musik.** **Tambah logo** (lalu geser logo langsung di pratinjau), **Tambah musik** (catatan
hak cipta muncul sekali, sama dengan di Mode Lengkap), kekuatan **Saat ada suara** (Halus, Sedang,
Kuat) dan **Hapus**. Unggahan tetap berjalan walau kartu ditutup. **"Atur detail di Mode Lengkap"**
membuka panel Logo atau Musik untuk sudut, ukuran, opasitas, volume, fade dan lainnya.

**Bilah posisi** (bawah). Klik atau seret untuk pindah posisi; klik dekat tanda menempel ke tanda
itu. Tandanya: titik tawa, garis jeda, palang cold open di awal, dan belah ketupat transisi di
sambungan cold open. Arahkan kursor ke tanda untuk namanya; tanda yang berdekatan digabung jadi
satu titik. Tombolnya ada di §5. Kalau job lama tidak punya data tawa/jeda, ada catatannya di bawah
bilah.

### Mode Lengkap

**Rel panel (kiri).** Enam ikon bernama: Transkrip, Teks, Cold open, Tata letak, Logo, Musik. Dengan
keyboard: ↑/↓ pindah panel, Home/End ke ujung.

**Transkrip.** Klik kata untuk memilih, Shift+klik untuk rentang. Begitu ada pilihan, **bilah aksi**
muncul tepat di atasnya (di bawahnya kalau tidak ada tempat) dan tidak pernah menutupi kata yang
dipilih:
- tombol utama: **Hapus**, atau **Pulihkan** / **Perpanjang ke sini** kalau itu yang cocok untuk
  pilihan ini;
- **Jadikan cold open** (abu-abu dengan alasannya kalau tidak bisa), **Kata kunci**;
- **Lainnya**: Edit kata, Sembunyikan dari caption, Mulai di sini, Akhiri di sini, dan aksi
  potong yang tidak sedang jadi tombol utama.

Dari daftar kata, **Tab** masuk ke bilah aksi, ←/→ pindah tombol, **Esc** atau Shift+Tab kembali ke
kata dengan pilihan tetap. Bilah aksi bisa menutupi kata di sebelah pilihan: tahan Shift untuk
Shift+klik kata di bawahnya, atau tekan Esc dulu untuk mengeklik kata itu.
- **Delete/Backspace** memotong kata terpilih (jump cut); klik chip "⋯ 1,4 dtk" untuk
  memulihkannya.
- **Enter** atau klik dua kali memperbaiki tulisan kata (caption saja; suara tetap).
- **Ctrl+Shift+X** menyembunyikan kata dari caption; **Ctrl+E** menandai kata kunci (tebal dan
  bergaris bawah warna kata kunci).
- **I / O** memindah awal atau akhir klip ke kata terpilih, juga saat fokus di bilah aksi. Kata di
  luar klip redup: pilih, lalu **Perpanjang ke sini**. **Ctrl+Shift+H** menjadikan pilihan 0,5–8
  detik sebagai cold open.
- **Rapikan** (tombol di atas transkrip): daftar kata pengisi ("eh", "anu"), pengulangan
  ("saya saya") dan jeda hening yang bisa dipotong di titik yang tenang. Jeda hening sudah
  tercentang, kata pengisi dan pengulangan belum (kata pengisi ikut tercentang setelah pemilik
  mengonfirmasi daftar labelnya). **Putar** memperdengarkan tiap item, **Lihat**
  menandainya di transkrip. **"Terapkan (n)"** memotong semua yang dicentang dalam satu langkah, dan
  satu Urungkan mengembalikan semuanya. Partikel ("kan", "sih", "mah", "toh", …) dan kata ulang
  ("anak-anak") tidak pernah didaftar. Jeda yang masih ada suaranya hanya bisa didengarkan.

**Teks.** Caption: nyala/mati, gaya (Karaoke, Classic, Bold, Box), posisi, ukuran, huruf
besar, warna sorot dan warna kata kunci, dengan catatan yang sama seperti kartu Caption (posisi
bawaan, area tombol TikTok, dekat teks hook). Hook: teks (maks. 90 karakter, tanda "Muat" / "Akan
terpotong"), durasi dan posisi. **Saran hook** di bawah kolom teks: saran otomatis langsung
muncul dengan sumbernya ("AI seleksi" dari pemilihan klip, "Heuristik" dari transkrip); **"Pakai"**
mengganti teks hook (bisa diurungkan). Dengan `POTONGIN_EDITOR_LLM=on`, AI gratis di Pengaturan
juga menulis saran dari transkrip yang sudah diedit (sekitar 10 detik).

**Cold open.** Nyala/mati, kalimat dan panjangnya, tambah/buang satu kata di tiap ujung.
**Saran cold open** mengusulkan kalimat terkuat dari klip; **Putar** memperdengarkannya,
**Pakai** menjadikannya cold open.

**Transisi** (di panel Cold open, dan di kartu Cold open Mode Cepat) mengatur efek di sambungan cold open ke awal klip: **Potong
langsung** (tanpa efek), **Kilat putih** (layar memutih sekitar 0,2 detik) atau **Gelap sebentar**
(layar menggelap sekitar 0,3 detik), plus sakelar **Suara whoosh**. **Putar transisi** memutar satu
detik sebelum dan sesudah sambungan. Klip otomatis yang punya cold open memakai Kilat putih dengan
whoosh; klip yang dirender sebelum fitur ini tetap potong langsung, dan "Kembali ke versi AI"
mengembalikan transisi yang dipakai file otomatisnya. Efeknya hanya menutup gambar video (caption,
hook dan logo tetap di atasnya); durasi klip dan waktu caption tidak bergeser. Tanpa cold open,
bagian ini mati dengan keterangan "Aktifkan cold open dulu."

**Tata letak.** **Latar blur**, **Ikuti wajah** dan **Potong tengah**, masing-masing dengan
contoh gambar di posisi putar. Berlaku untuk seluruh klip. "Ikuti wajah" pada proyek yang belum
punya analisis wajah menganalisis dulu (hitungan persen); bagian tanpa wajah didaftar dengan
tombol lompat, dan di bagian itu video dipusatkan.

**Logo.** **"Unggah logo"** (PNG, JPEG atau WebP, maks. 10 MB; PNG transparan paling rapi)
atau seret file ke panel. Logo baru muncul di kanan atas, di luar area tombol TikTok/Reels. Posisi
cepat di empat sudut (semuanya di luar area itu), **Ukuran** dan **Opasitas**; di layar pratinjau
logo bisa digeser dan diubah ukurannya (panah 1 px, Shift+panah 10 px). Kalau logo digeser masuk
area tombol TikTok/Reels, muncul peringatan dengan tombol **"Geser ke area aman"**.

**Musik.** **"Tambah musik"** (MP3, M4A, WAV, OGG atau FLAC, maks. 50 MB; baca dulu
catatan hak cipta). Volume musik, mulai dari, ulangi sampai klip selesai, muncul/hilang perlahan.
**Kecilkan musik saat ada suara** dengan kekuatan **Halus** (−6 dB), **Sedang** (−10 dB) atau
**Kuat** (−16 dB), plus "Atur detail" (waktu turun, naik, jeda tahan). Volume suara asli dan
**Samakan kenyaringan** (−14 LUFS) dengan hasil yang tercapai; kalau volume diturunkan supaya
tidak pecah, panel menuliskannya.

**Timeline (bawah).** Di atasnya: Putar, mundur/maju satu frame dan waktu. Lajur video, teks, hook, **Audio** (waveform suara klip), **Penanda** (😂
tawa, jeda ≥ 0,6 detik, potongan kamera; klik untuk lompat; arahkan kursor untuk asal tandanya) dan
**Musik** (waveform musik dengan garis volume yang turun saat ada suara). Klik untuk pindah posisi,
seret gagang awal/akhir (menempel ke batas kata), Ctrl+scroll untuk zoom; scroll timeline ke bawah
untuk lajur Musik di layar pendek. Kalau job lama tidak punya data tawa/jeda, ada catatan "tidak
tersedia untuk job ini" (di lajurnya, atau di baris atas timeline bila lajurnya berisi penanda).

### Di kedua tampilan

**Bar atas.** Dari kiri: "← Proyek", judul klip dengan status simpan (dan "Terbuka di tab lain"
kalau klip ini juga terbuka di tab lain), sakelar **Cepat | Lengkap**, Urungkan / Ulangi (ikon),
**Perlu dicek (n)**, menu **⋯ Lainnya** (**Kembali ke versi AI**, **Pintasan keyboard**) dan
**Ekspor**.

**Lainnya.** Urungkan / Ulangi (Ctrl+Z, Ctrl+Shift+Z) sampai 200 langkah, juga untuk perubahan
yang dibuat di tampilan lain; simpan otomatis (± 1,5 detik setelah berhenti, juga disimpan di
browser); **"Kembali ke versi AI"** (di ⋯ Lainnya); **Ekspor**
(centang tiap item "Perlu dicek"; catatan biru tidak perlu dicentang, begitu juga semua item klip
yang belum diubah, karena ekspornya file klip otomatis itu sendiri; lalu Antre → Merender →
Memverifikasi → Selesai, **"Unduh MP4"** dan **"Unduh SRT"**, tersimpan sebagai
`klip-02-revisi-5.mp4` dan seterusnya; bisa dibatalkan); dua tab pada klip yang sama digabung per
bagian.

## 3. Status di atas pratinjau

Status ada di kiri atas, di samping pratinjau (tidak menutupi video), dan tiap perubahannya
dibacakan pembaca layar. Tombol **?** di sebelahnya menampilkan penjelasan status itu; Esc
menutupnya. Di kanan atas ada dua tombol: **Frame akhir** (Ctrl+Shift+R, piksel persis hasil
render) dan **Zona aman** (', area tombol TikTok/Reels di atas pratinjau). Tampilannya sama di
kedua mode.

| Status | Artinya |
|---|---|
| **Sesuai hasil akhir** | Frame, teks, logo dan audio yang Anda lihat sama dengan hasil ekspor. File MP4 akhir dikompresi (H.264, warna 4:2:0), jadi tepi teks berwarna sedikit lebih lembut. **"Frame akhir"** (Ctrl+Shift+R) menampilkan piksel persisnya. Tanda ini hanya muncul kalau semua lapisan sudah terbaru. |
| **Menyiapkan video (7/30)…** | Potongan video pratinjau masih dibuat server. Frame terakhir yang pasti tetap tampil. |
| **Memperbarui teks… / logo… / Menyiapkan audio…** | Lapisan itu sedang diperbarui (biasanya < 1 detik). |
| **Menyiapkan frame…** | Frame di posisi ini sedang digambar. |
| **Frame gagal dimuat** | Browser belum bisa menampilkan frame di posisi ini, juga setelah dicoba ulang (gagal, atau terlalu lama, misalnya saat memori komputer penuh). Kalau akhirnya selesai, frame langsung tampil. Putar atau geser playhead untuk mencoba lagi; **"Frame akhir"** menampilkan piksel dari server. |
| **Frame akhir** | Piksel hasil render akhir untuk frame ini. |
| (kosong) | Klip belum diubah dan file klip otomatisnya dibuat sebelum editor ada. Ekspornya adalah file itu apa adanya, jadi bisa sedikit berbeda dari pratinjau (misalnya posisi video, warna teks). Tombol **?** menjelaskannya. Setelah ada perubahan apa pun, status menjadi "Sesuai hasil akhir". |

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
| ? | Bantuan pintasan (juga di ⋯ Lainnya) |

Setiap aksi juga punya tombol di layar. Pintasan tidak aktif saat Anda mengetik di kolom teks, dan
tetap bekerja setelah Anda mengeklik tombol pilihan (gaya caption, warna, sakelar, efek transisi):
Spasi dan panah tetap milik tombol yang sedang fokus, Ctrl+Z, ', ? dan K tetap jalan. Tidak ada
pintasan satu huruf baru.

Tombol yang bekerja saat fokus di satu tempat:

| Di mana | Tombol | Aksi |
|---|---|---|
| Sakelar Cepat \| Lengkap | ← / → | Pindah tampilan (fokus tetap di sakelar) |
| Bilah posisi (Mode Cepat) | ← / →, Shift+← / → | Satu frame, satu detik |
| Bilah posisi | Home / End | Ke awal / akhir klip |
| Bilah posisi | PageUp / PageDown | Ke tanda sebelumnya / berikutnya (termasuk ujung cold open) |
| Bilah posisi | Spasi / K | Putar / jeda |
| Rel panel (Mode Lengkap) | ↑ / ↓, Home / End | Pindah panel |
| Daftar kata (Mode Lengkap) | Tab | Masuk ke bilah aksi |
| Bilah aksi | ← / →, Home / End | Pindah tombol |
| Bilah aksi | Esc, Shift+Tab | Kembali ke kata, pilihan tetap |
| Bilah aksi, tombol Lainnya | ↓, Enter, Spasi | Buka menu (↑/↓ pilih, Enter jalankan, Esc tutup) |
| Teks caption (Mode Cepat) | Enter, Tab | Simpan baris (Tab lalu ke baris berikutnya) |
| Teks caption | Esc | Batalkan ketikan di baris itu |

## 6. Kalau ada masalah

| Yang terlihat | Penyebab dan jalan keluar |
|---|---|
| Tidak menemukan transkrip | Transkrip ada di Mode Lengkap: sakelar **Lengkap** di bar atas, atau **"Potong per kata di Mode Lengkap →"** di bawah pratinjau Mode Cepat. |
| "Menyiapkan klip untuk diedit" lama sekali | Proyek panjang dengan face-track. Tunggu; setelah 12 menit editor menyerah dan meminta muat ulang. |
| "Video sumber tidak bisa dibaca; proses ulang videonya" | FFmpeg gagal membaca video sumber proyek ini (filenya masih ada). Proses ulang videonya dari dashboard. |
| Catatan biru "Caption di posisi bawaan, dekat tombol TikTok" | Hanya pemberitahuan, bukan kesalahan, dan tidak perlu dicentang saat ekspor: caption bawaan memang di posisi yang sama dengan klip otomatis, supaya klip yang tidak diubah tetap diekspor sebagai file klip otomatis. Kalau di aplikasi caption tertutup tombol, geser caption ke atas (kartu Caption: Posisi, atau panel Teks di Mode Lengkap). Caption yang Anda geser sendiri ke area itu tetap muncul di "Perlu dicek" dan perlu dicentang. |
| "Transkrip berubah sejak klip diedit" (baca saja) | Proyek dijalankan ulang dan transkripnya berubah. Klik "Mulai dari versi AI". |
| "Terbuka di tab lain" (bar atas) | Klip ini juga terbuka di tab lain. Perubahan di bagian yang berbeda digabung otomatis. |
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
