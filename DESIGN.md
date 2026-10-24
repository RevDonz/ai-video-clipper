# DESIGN.md: Potongin

Arah desain dari pemilik, dijawab 2026-09-30, dengan amandemen G0 rombak (Q1, 2026-10-24) di
"Pola tata letak" dan "Bahasa". Dokumen ini mencatat jawaban pemilik apa adanya; ubah di sini
kalau arahnya berubah. Aturan anti-slop (`.claude/skills/antislop*/`) berlaku di atas
arah ini.

Dial: ENERGY 1 / RHYTHM 1 / MOTION 2

## Kepribadian

Alat kerja pro yang cepat: padat, tegas, efisien, fokus ke hasil. Penggunanya clipper yang
memproduksi banyak klip setiap hari.

## Palet

Gelap di semua halaman: halaman depan, login, semua halaman aplikasi dan editor. Dasarnya palet
gelap yang sudah dipakai halaman depan:

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
Lokaclip, Social Visuals dan editor CapCut (sebagai rujukan, bukan untuk ditiru). Pola ini live di
`main` sejak PR #30 (2026-10-23).

Amandemen G0 (Q1, disetujui pemilik 2026-10-24) menetapkan arah rombak. Setiap butir di bawah
memuat **Sekarang** (yang ada di `main`) dan **Sasaran** dengan fase mulai berlakunya. Sampai fase
itu selesai, UI mengikuti "Sekarang"; sesudahnya "Sekarang" dihapus dari butir ini. Rencana:
`docs/plans/2026-10-24-rombak/` (05 dashboard, 06 editor, 07 bahasa, 08 urutan fase).

- **Navigasi aplikasi.**
  - Sekarang: sidebar kiri di semua halaman yang butuh login (Buat klip di atas, lalu Kerja:
    Riwayat, Konteks Tren; Sistem: Pengaturan, Bantuan; Keluar di bawah).
  - Sasaran (Fase 1): sidebar datar tanpa label kelompok: Buat klip, Proyek, Sosial, Analitik,
    Tren, Pengaturan, Admin, Bantuan. Item muncul per peran dan flag; item yang tidak berlaku
    tidak dirender. Menu akun di bawah: Akun, Bahasa, Pintasan, Keluar.
  - Tetap: di bawah 1024 px sidebar menjadi bar atas dengan tombol **Menu** berlabel yang
    membuka laci (Escape dan Tutup menutup, fokus kembali ke tombol, isi di belakang inert). Buat
    klip di sidebar memakai tombol netral yang kuat; lime tetap untuk satu aksi utama halaman.
    Halaman depan, login dan editor tidak memakai sidebar.
- **Kepala halaman.**
  - Sekarang: judul, satu kalimat fungsi halaman, dan aksi halaman di kanan (kelas `.pageHead`),
    dengan ukuran dan jarak yang sama.
  - Sasaran (Fase 1–3, ikut layar yang ditulis ulang): judul + aksi, tanpa kalimat. Ukuran dan
    jarak tetap seragam.
- **Buat klip.**
  - Sekarang: sumber dan tombol Buat klip di baris pertama; Jumlah klip, Rasio, Durasi dan Layout
    selalu terlihat; pilihan lain di tiga lipatan berlabel (Subtitle dan hook, Arahkan pilihan
    momen, Bahasa dan resolusi), masing-masing dengan ringkasan pilihannya.
  - Sasaran (Fase 2): chip bernilai (`3 klip`, `9:16 · 720p`, `Latar blur`, `Karaoke`) yang
    membuka Popover berisi kontrolnya, menggantikan tiga lipatan. Setelah Buat klip, pengguna
    dibawa ke halaman proyeknya.
- **Komponen** (Fase 1): HeroUI v3 di atas token Potongin. Keadaan terpilih tidak memakai lime;
  lime hanya untuk aksi utama dan titik progres.
- **Kata status.** Dua set tetap, tanpa kata keenam:
  - proses (Fase 2): Antre · Diproses · Selesai · Gagal · Dibatalkan, ditambah Menghapus dan
    Tidak dikenal untuk keadaan transien atau tak dikenal. "Menunggu" diganti "Antre";
  - postingan (Fase 8): Terjadwal · Mengunggah · Terbit · Gagal · Dibatalkan.
  - Keterangan seperti Pemeliharaan, Hubungkan ulang akun, Menunggu kuota dan Perlu dicek tampil
    sebagai detail di samping status, misalnya `Antre · Pemeliharaan`.
- **Label.** Riwayat → Proyek, Konteks Tren → Tren (navigasi Fase 1, halamannya Fase 3).
  Publikasi: **Terbitkan** untuk aksi, **Terbit** untuk status (Fase 8).
- **Editor.**
  - Sekarang: di Mode Lengkap rel alat di kiri, pratinjau di tengah, panel alat di kanan,
    timeline di bawah. Mode Cepat: pratinjau di kiri, kartu di kanan.
  - Sasaran (Fase 10 di balik flag, untuk semua di Fase 11): satu tata letak. Daftar klip di
    kiri, pratinjau dan transkrip di tengah, satu panel alat di kanan (Teks, Tata letak, Audio,
    Logo, Cold open). Pilihan dasar terlihat, kontrol halus di lipatan Lanjutan dengan ringkasan
    pilihannya. Linimasa detail terlipat di bawah. Mode Cepat dan Mode Lengkap dihapus.
- **Halaman depan:** judul besar lalu langsung contoh nyata sebelum/sesudah. Satu momen gerak
  yang menjelaskan (jendela 9:16 bergeser ke subjek, penanda menit, panah, klip muncul), lalu
  diam; dengan `prefers-reduced-motion` langsung tampil di keadaan akhir. Tangkapan editor di
  halaman depan memperlihatkan tata letak editor yang sedang live; diambil ulang setelah editor
  satu tata letak dirilis.

## Bahasa

Sasaran rombak (07 i18n). Sampai Fase 1, copy masih ditulis langsung di komponen, dalam bahasa
Indonesia.

- **Bahasa UI:** Indonesia dan English, bisa ditambah dengan satu katalog dan satu baris registry.
  Katalog `web/messages/id/*.json` adalah sumber (Fase 1); `en` diterjemahkan dari katalog `id`
  dan glosarium. `en` dirilis untuk semua pengguna di Fase 11.
- **Pemilih bahasa:** menu akun dan login (Fase 1), halaman undangan dan atur ulang sandi, dan
  `/akun` (Fase 6). Editor tidak punya pemilih sendiri; ia mengikuti bahasa halaman.
- **URL netral:** URL dan slug tidak berubah per bahasa (`/dashboard`, bukan `/en/dashboard`).
  Anchor `#<kode>`, query (`?klip=`, `?tab=`, `?hasil=`) dan nama file unduhan juga tetap.
- **Aturan label (semua bahasa):** label, bukan kalimat. Huruf kapital hanya di awal (sentence
  case), juga di English. Tanpa teks pengisi dan tanpa kata versi atau "baru".
- **Istilah:** wajib dari `docs/glosarium.md`. Istilah baru ditambahkan di PR yang
  memperkenalkannya.
- **Bahasa konten** (caption, transkrip, hook, judul, hashtag, keluaran LLM) mengikuti bahasa
  video, tidak pernah bahasa UI.
- **Jam dan tanggal:** format 24 jam di semua bahasa (Q8, default). Zona jadwal = zona perangkat,
  nama zonanya ditampilkan (Fase 8).

## Di luar dokumen ini

Tampilan klip video (caption, teks hook) adalah gaya konten dan diatur oleh paket caption, bukan
oleh dokumen ini.
