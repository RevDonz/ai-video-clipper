# Uji penerimaan editor (U1–U7)

Protokol ini untuk pemilik Potongin di titik cek 3 (rencana §11.0 dan §10.2 QG-UX). Tujuh tugas
diukur dengan stopwatch di laptop yang dipakai sehari-hari, di dua ukuran jendela. Hasilnya menjadi
gerbang QG-UX: editor siap rilis kalau ketujuh tugas lulus di kedua ukuran.

Waktu yang dibutuhkan: sekitar 30 menit. Panduan fitur ada di `docs/editor/PANDUAN-EDITOR.md`; angka
pengujian otomatis ada di `docs/editor/GATES.md`.

## 1. Persiapan (5 menit)

1. Jalankan aplikasi dengan editor, unggahan, dan saran AI menyala (`PANDUAN-EDITOR.md` §4, langkah
   1 sampai 4), lalu buka `http://127.0.0.1:3000/projects` di Chrome atau Edge.
2. Pilih satu proyek yang sudah selesai dan punya klip berdurasi 30 sampai 90 detik. Catat nomor
   proyek dan klipnya di tabel §4.
3. Siapkan dua file di komputer: satu logo PNG (latar transparan kalau ada) dan satu lagu pendek
   (MP3, M4A, atau WAV).
4. Atur jendela browser ke 1366×768 dulu. Ulangi semua tugas di 1920×1080 setelah selesai.
5. Siapkan stopwatch di ponsel.

## 2. Aturan stopwatch

- Setiap tugas punya titik **mulai** dan titik **berhenti** yang ditulis di bawah. Waktu persiapan
  sebelum titik mulai tidak dihitung.
- "Tersimpan" berarti tulisan di kiri atas, di bawah judul klip, berubah menjadi "Tersimpan".
- Hitung percobaan pertama. Kalau gagal karena salah klik, catat waktunya, lalu ulangi sekali dan
  catat juga waktu kedua. Yang menentukan lulus adalah percobaan pertama.
- Mulai setiap tugas dari versi AI: klik **Kembali ke versi AI** di kanan atas, tunggu "Tersimpan".
- Kalau lewat batas, tulis di kolom catatan apa yang membuat lambat (tombol tidak ketemu, menunggu
  pratinjau, salah paham tulisan, dan sebagainya). Catatan itu yang paling berguna untuk perbaikan.

## 3. Tujuh tugas

### U1. Perbaiki kata pertama yang terpotong (batas 20 detik)

- Persiapan: buat kata pertama terpotong. Di tab Transkrip klik kata kedua, tekan **I**, tunggu
  "Tersimpan", lalu muat ulang halaman (F5).
- Mulai: editor sudah terbuka setelah muat ulang dan tanda di bawah pratinjau sudah tampil.
- Tugas: kembalikan kata pertama ke klip. Caranya bebas: klik kata yang redup lalu **Perpanjang ke
  sini**, atau pilih kata itu lalu tekan **I**, atau seret gagang awal di timeline.
- Berhenti: kata pertama tidak redup lagi dan tulisan "Tersimpan" tampil.

### U2. Buang omongan sekitar 5 detik lewat transkrip (batas 20 detik)

- Mulai: editor terbuka di versi AI.
- Tugas: di tab Transkrip, pilih satu kalimat atau beberapa kata yang lamanya sekitar 5 detik (klik
  kata pertama, Shift+klik kata terakhir; lama pilihan tertulis di atas transkrip), lalu tekan
  **Delete**.
- Berhenti: kata-kata itu tercoret, muncul tombol "⋯ x dtk", dan "Tersimpan" tampil.

### U3. Ganti cold open (batas 45 detik)

- Mulai: editor terbuka di versi AI.
- Tugas: jadikan kalimat lain sebagai cold open. Pilih kalimat 0,5 sampai 8 detik di Transkrip lalu
  tekan **Ctrl+Shift+H**, atau buka tab Cold open, dengarkan saran dengan **Putar**, lalu klik
  **Pakai**.
- Berhenti: kalimat baru tertulis di tab Cold open (atau ditandai di transkrip) dan "Tersimpan"
  tampil.

### U4. Pakai saran hook dan ganti gaya caption (batas 30 detik)

- Mulai: editor terbuka di versi AI.
- Tugas: di tab Teks, klik **Pakai** pada salah satu saran hook, lalu pilih gaya caption lain
  (Klasik, Karaoke, Bold, atau Box).
- Berhenti: teks hook berganti, gaya caption terpilih, dan "Tersimpan" tampil.

### U5. Tambah logo dan musik yang mengecil saat ada suara (batas 60 detik)

- Mulai: editor terbuka di versi AI.
- Tugas: di tab Logo klik **Unggah logo** dan pilih file logo; di tab Musik klik **Tambah musik**,
  baca catatan hak cipta, pilih lagu, lalu pilih kekuatan **Sedang** atau **Kuat**.
- Berhenti: logo tampil di pratinjau, lajur Musik di timeline menunjukkan garis volume yang turun
  saat ada suara, dan "Tersimpan" tampil.

### U6. Ekspor dan unduh (batas: durasi klip + 30 detik)

- Persiapan: ubah sesuatu kecil (misalnya teks hook), supaya ekspor benar-benar merender.
- Mulai: klik **Ekspor**.
- Tugas: centang setiap hal yang perlu dicek (catatan berwarna biru tidak perlu dicentang), klik
  **Mulai ekspor**, tunggu Selesai, lalu klik **Unduh MP4**.
- Berhenti: file MP4 tersimpan di komputer.
- Setelahnya: putar file itu sekali. Bandingkan dengan pratinjau: teks, logo, musik, dan potongan
  harus sama.

### U7. Muat ulang di tengah mengedit, lalu kembali ke versi AI (batas 20 detik untuk bagian kedua)

- Bagian pertama (tanpa stopwatch): ubah teks hook dan gaya caption, lalu langsung muat ulang
  halaman (F5) sebelum tulisan "Tersimpan" muncul. Lulus kalau setelah halaman terbuka lagi kedua
  perubahan masih ada.
- Bagian kedua: mulai stopwatch saat halaman sudah terbuka. Cari dan klik **Kembali ke versi AI**.
  Berhenti saat "Tersimpan" tampil dan perubahan tadi hilang.

## 4. Lembar hasil

Proyek: ________  Klip: ________  Durasi klip: ________ detik  Browser: ________

| Uji | Batas | 1366×768 | 1920×1080 | Lulus | Catatan |
|---|---|---|---|---|---|
| U1 kata pertama | 20 dtk | | | | |
| U2 buang 5 detik | 20 dtk | | | | |
| U3 cold open | 45 dtk | | | | |
| U4 saran hook + gaya | 30 dtk | | | | |
| U5 logo + musik | 60 dtk | | | | |
| U6 ekspor + unduh | durasi + 30 dtk | | | | |
| U7 muat ulang | tidak ada yang hilang | | | | |
| U7 kembali ke versi AI | 20 dtk | | | | |

Kirim lembar ini ke agen berikutnya (atau tulis ke `docs/editor/evidence/W4/T4.5-QG-UX-owner.json`),
lengkap dengan catatannya.

## 5. Tur singkat 13 kemampuan (tanpa stopwatch, sekitar 10 menit)

Satu baris per kemampuan rencana §1.1. Centang kalau berjalan seperti yang tertulis.

| # | Kemampuan | Coba ini | Yang harus terlihat |
|---|---|---|---|
| 1 | Buka klip | **Edit klip** di kartu klip dan di Riwayat | Klip terbuka tanpa langkah "Siapkan"; klip yang tidak bisa diedit menulis alasannya |
| 2 | Trim menempel ke kata | Tekan **I** / **O** pada kata, atau seret gagang di timeline | Awal dan akhir selalu jatuh di celah antar kata |
| 3 | Cold open | Tab Cold open: **Pakai** saran, **Buang kata terakhir** | Kalimat cold open diputar paling awal; pilihan di atas 8 detik ditolak dengan alasan |
| 4 | Hook + saran AI | Tab Teks: tulis hook, **Pakai** saran | "Muat" atau "Akan terpotong"; saran otomatis langsung tampil, saran AI menyusul (sekitar 10 detik) |
| 5 | Caption + 4 gaya | Tab Teks: Klasik, Karaoke, Bold, Box; **Ctrl+E** pada kata | Pratinjau berganti; kata kunci berwarna |
| 6 | Potong lewat transkrip | Pilih kata, **Delete**; **Rapikan** | Kata tercoret dengan tombol pulihkan; Rapikan memotong yang dicentang dalam satu langkah |
| 7 | Tata letak | Tab Tata letak: Potong tengah, Ikuti wajah, Latar blur | Pratinjau berganti; bagian tanpa wajah didaftar |
| 8 | Logo | Tab Logo: unggah, pilih sudut, geser dengan panah | Logo di pratinjau dan di hasil ekspor |
| 9 | Musik + ducking | Tab Musik: unggah, **Kuat**, **Samakan kenyaringan** | Garis volume turun saat ada suara; hasil ekspor tidak pecah |
| 10 | Waveform + penanda | Lihat lajur Audio dan Penanda, klik penanda | Waveform tampil; klik penanda memindah posisi putar |
| 11 | Delapan bug lama | Gaya Box, kata berisi `{` atau `\`, kata kunci, logo | Kotak caption tembus pandang, tulisan tampil apa adanya, warna kata kunci dan logo muncul di hasil |
| 12 | Urungkan dan simpan | **Ctrl+Z**, **Ctrl+Shift+Z**, buka klip yang sama di dua tab | Urungkan sampai 200 langkah; dua tab diberi tahu dan perubahannya digabung |
| 13 | Ekspor | **Ekspor** sampai Selesai, **Unduh MP4** dan **Unduh SRT** | Tahap Antre, Merender, Memverifikasi, Selesai; klip tanpa perubahan memakai file klip otomatis |

Catatan tentang caption: posisi bawaan caption sama dengan klip otomatis dan bagian bawahnya
sedikit masuk area tombol TikTok. Editor menuliskannya sebagai catatan biru di "Perlu dicek" dan di
dialog Ekspor, tanpa perlu dicentang. Kalau caption tertutup tombol, geser ke atas di tab Teks.

## 6. Versi otomatis

`web/e2e/editor-acceptance.spec.mjs` menjalankan 13 kemampuan di atas plus QG-A11Y dengan bot
(aplikasi produksi, salinan job asli, Chrome for Testing 147). `web/e2e/editor-flow.spec.mjs`
menjalankan U1–U7 versi skrip dengan batas waktu yang sama. Bot jauh lebih cepat dari manusia, jadi
angka pemilik yang menentukan gerbang ini.
