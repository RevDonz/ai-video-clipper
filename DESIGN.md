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

## Di luar dokumen ini

Tampilan klip video (caption, teks hook) adalah gaya konten dan diatur oleh paket caption, bukan
oleh dokumen ini.
