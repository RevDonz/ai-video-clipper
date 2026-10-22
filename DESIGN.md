# DESIGN.md: Potongin

Arah desain dari pemilik, dijawab 2026-09-30. Dokumen ini mencatat jawaban pemilik apa adanya;
ubah di sini kalau arahnya berubah. Aturan anti-slop (`.claude/skills/antislop*/`) berlaku di atas
arah ini.

Dial: ENERGY 1 / RHYTHM 1 / MOTION 2

## Kepribadian

Alat kerja pro yang cepat: padat, tegas, efisien, fokus ke hasil. Penggunanya clipper yang
memproduksi banyak klip setiap hari.

## Palet

Gelap di semua halaman: halaman depan, dashboard, riwayat, proyek, pengaturan, Konteks Tren dan
editor. Dasarnya palet gelap yang sudah dipakai halaman depan:

| Peran | Warna |
|---|---|
| Latar | `#080907` |
| Permukaan (kartu, panel) | `#11120f` |
| Garis | `#292b25` |
| Teks | `#f7f5ed` |
| Teks redup | `#a5a69d` |
| Aksen (satu, dipakai hemat) | lime `#dfff58` |

- Info (biru) dan bahaya (merah) sekarang `#3f5efb` dan `#e44e3f`, dipilih untuk latar terang.
  Di latar gelap nilainya disesuaikan dan kontrasnya dicek (R-25).
- Palet terang yang dipakai halaman aplikasi sekarang (krem `#f3f1ea`, kartu `#fcfbf7`, hitam
  `#151515`, lime `#b8ff57`) diganti oleh palet gelap ini.

## Tipografi

DM Sans untuk semua teks.

## Gerak

Halus dan hidup: transisi lembut dan mikro-interaksi kecil (hover, pindah tab, chip muncul, status
"Tersimpan"), tanpa berlebihan. Pengguna dengan `prefers-reduced-motion` tidak mendapat animasi
yang tidak perlu.

## Pola tata letak

Permintaan pemilik 2026-10-22: tampilan profesional tapi ramah, mudah dipelajari, dengan rujukan
Lokaclip, Social Visuals dan editor CapCut (sebagai rujukan, bukan untuk ditiru). Diterapkan di
branch `feat/ux-redesign-workspace`:

- **Navigasi aplikasi:** sidebar kiri di semua halaman yang butuh login (Buat klip di atas, lalu
  Kerja: Riwayat, Konteks Tren; Sistem: Pengaturan, Bantuan; Keluar di bawah). Di bawah 1024 px
  menjadi bar atas dengan tombol **Menu** berlabel yang membuka laci (Escape dan Tutup menutup,
  fokus kembali ke tombol). Buat klip di sidebar memakai tombol netral yang kuat; lime tetap untuk
  satu aksi utama halaman. Halaman depan, login dan editor tidak memakai sidebar.
- **Kepala halaman:** setiap halaman dibuka dengan judul, satu kalimat fungsi halaman, dan aksi
  halaman di kanan (kelas `.pageHead`), dengan ukuran dan jarak yang sama.
- **Buat klip:** sumber dan tombol Buat klip di baris pertama; Jumlah klip, Rasio, Durasi dan
  Layout selalu terlihat; pilihan lain dilipat di tiga lipatan berlabel (Subtitle dan hook,
  Arahkan pilihan momen, Bahasa dan resolusi), masing-masing menampilkan ringkasan pilihannya.
- **Editor:** di Mode Lengkap rel alat di kiri, pratinjau di tengah, panel alat di kanan,
  timeline di bawah. Mode Cepat: pratinjau di kiri, kartu di kanan. Tangkapan editor di halaman
  depan memperlihatkan tata letak ini.
- **Halaman depan:** judul besar lalu langsung contoh nyata sebelum/sesudah. Satu momen gerak
  yang menjelaskan (jendela 9:16 bergeser ke subjek, penanda menit, panah, klip muncul), lalu
  diam; dengan `prefers-reduced-motion` langsung tampil di keadaan akhir.

## Di luar dokumen ini

Tampilan klip video (caption, teks hook) adalah gaya konten dan diatur oleh paket caption, bukan
oleh dokumen ini.
