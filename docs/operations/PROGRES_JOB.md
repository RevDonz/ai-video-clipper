# Progres job dan ringkasan per tahap

Terakhir diperbarui: 2026-10-21.

Worker (`web/scripts/run-job.mjs`) menjalankan engine (`ai-clipper`) dan membaca progresnya dari
stdout. Dokumen ini menjelaskan baris progres itu, ringkasan hasil per tahap yang ikut di
dalamnya, apa yang tampil di layar, dan badge job di header.

## Baris progres

Setiap baris progres engine berbentuk `POTONGIN_PROGRESS <json>` dengan `stage`, `progress`
(bilangan bulat 0–99) dan `detail` (`src/ai_clipper/cli.py`). Worker membacanya dengan
`parseWorkerProgress` (`web/lib/jobs.mjs`) dan menyimpan `stage`, `progress` (tidak pernah turun)
dan `stageDetail` di `job.json`. Baris lain diteruskan ke log worker.

## Ringkasan per tahap

Begitu satu tahap selesai dan hasilnya sudah diketahui engine, engine mencetak ulang baris progres
terakhirnya dengan tambahan `summary`:

```text
POTONGIN_PROGRESS {"stage": "transcribing", "progress": 57, "detail": "Transkripsi audio 100%", "summary": {"transcript": {"words": 2304, "source": "youtube-captions", "language": "id"}}}
```

Jadi setiap baris tetap satu event progres utuh, dan pembaca lama mengabaikan `summary`.

| Jenis | Kapan | Isi | Di layar |
|---|---|---|---|
| `video` | setelah durasi video terbaca | `duration` (detik) | Video: 48:12 |
| `transcript` | setelah transkrip jadi | `words`, `source` (`youtube-captions`, `groq` atau `whisper`), `language` (kode 2–3 huruf) | Transkrip: 2.304 kata · dari subtitle YouTube (`groq`: dari audio lewat Groq) |
| `moments` | setelah momen dipilih | `count`, `source` (`llm` atau `heuristic`) | Momen: 5 dipilih AI |

- Hanya job dengan seleksi terbaru (V3) yang mengirim ringkasan.
- Jumlah kata menghitung kata bertimestamp di setiap segmen, atau kata di teks segmen kalau
  segmen itu tidak punya timestamp kata.
- Nilai yang tidak diketahui engine tidak dikirim: durasi yang gagal dibaca tidak menghasilkan
  `video`, job yang gagal sebelum momen dipilih tidak punya `moments`, dan bahasa yang bukan kode
  2–3 huruf ditinggalkan.
- Bahasa hanya tampil ("bahasa Inggris") kalau job meminta "Deteksi otomatis".
- Baris "Klip: 5 siap" diambil dari daftar klip job yang selesai, bukan dari engine.

## Yang tersimpan di job

- `stageSummary`: gabungan semua ringkasan yang diterima worker selama satu percobaan, misalnya
  `{ "video": {…}, "transcript": {…}, "moments": {…} }`. Ringkasan baru menimpa jenis yang sama.
- Percobaan baru (antrean mencoba ulang job) mulai dengan `stageSummary: null`.
- Ringkasan tetap ada setelah job selesai atau gagal.
- Setiap nilai disaring oleh `sanitizeStageSummary` (`web/lib/stage-summary.mjs`) saat dibaca dari
  engine dan lagi saat API mengirim job ke browser: jenis dan field yang tidak dikenal dibuang,
  angka harus bilangan bulat dalam batas (kata ≤ 10.000.000, momen ≤ 1000, durasi ≤ 7 hari).

## Di layar

`components/StageSummary.jsx` menampilkan daftar "Hasil per tahap" di bawah bilah progres:

- **Dashboard:** untuk job yang berjalan, selesai, maupun gagal.
- **Halaman proyek:** di panel progres, yang hanya tampil selama job berjalan.

Job lama tanpa `stageSummary` tidak menampilkan baris apa pun selain "Klip" untuk job yang
selesai.

## Di header

Header bersama (`components/AppHeader.jsx`) punya badge job di samping logo
(`components/JobBadge.jsx`, logikanya di `web/lib/job-badge.mjs`). Badge itu tautan ke proyeknya:

| Keadaan | Badge | Bentuk pendek (< 384 px) |
|---|---|---|
| Ada job yang belum selesai (termasuk yang masih menunggu) | **1 berjalan · 42%** dengan titik lime | 42% |
| Tidak ada yang berjalan, job terbaru selesai | **Terakhir: 8 klip** | 8 klip |
| Job terbaru gagal / dibatalkan | **Terakhir: gagal** (merah) / **Terakhir: dibatalkan** | Gagal / Batal |
| Belum ada job | tidak ada badge | |

- Jumlah dan persen ditulis cara Indonesia ("1.234 klip"). Persennya dari job yang sedang dikerjakan
  worker: yang sudah lewat "Menunggu", yang tertua dulu (urutan antrean). "Terakhir" adalah job
  selesai yang paling baru dibuat, urutan yang sama dengan Riwayat; jumlahnya hanya klip yang
  jadi (klip yang gagal dirender tidak punya file). Proyek yang sedang dihapus tidak dihitung.
- **Membaca server:** pembacaan pertama menunggu browser senggang setelah halaman dimuat, supaya
  permintaan halaman itu sendiri jalan dulu. Selama ada job berjalan, badge membaca job itu saja
  (`GET /api/jobs/<id>`) setiap 5 detik dan daftar lengkap (`GET /api/jobs`) sekali semenit. Tanpa job
  berjalan, daftar dibaca sekali semenit. Tab yang tersembunyi tidak membaca apa pun; begitu tab
  terlihat lagi, daftar langsung dibaca. Membuat job (dashboard), **Batalkan** dan menghapus proyek
  (Riwayat) memberi tahu badge supaya langsung membaca ulang.
- **Gagal membaca:** jeda dilipatgandakan sampai paling lama 5 menit. Dua kegagalan berturut-turut
  masih menampilkan keadaan terakhir; mulai yang ketiga badge disembunyikan sampai server menjawab
  lagi. Sesi yang habis (401) menyembunyikan badge dan menghentikan pembacaan.
- **Pembaca layar:** nama tautannya teks lengkap badge. Satu wilayah `aria-live="polite"` yang
  terpisah hanya mengumumkan job yang tadinya berjalan lalu berhenti ("Proyek selesai: 8 klip",
  "Proyek gagal", "Proyek dibatalkan"); persen yang bergerak dan job yang baru mulai tidak
  diumumkan.
- **Tata letak:** badge mengisi ruang kosong di kiri, jadi kemunculannya tidak menggeser apa pun.
  Mulai 850 px ke bawah menu pindah ke baris sendiri (sebelumnya 720 px; di 721–800 px label menu
  sampai terlipat dua baris). Di tempat nama "Potongin AI" dan badge tidak muat berdua (≤ 481 px dan
  851–939 px), nama disembunyikan secara visual dan tetap dibaca pembaca layar; di bawah 360 px nama
  itu selalu disembunyikan supaya Bantuan dan Keluar muat di baris pertama. Di layar sentuh
  (≤ 850 px) badge setinggi 44 px.

## Membatalkan job

Job yang masih dalam antrean atau sedang berjalan punya tombol **Batalkan** di dashboard dan di
panel progres halaman proyek. Konfirmasinya muncul di halaman itu sendiri ("Batalkan proses
ini?"), bukan dialog browser.

- `POST /api/jobs/<id>/cancel` (perlu sesi dan origin yang sama) menandai job `cancelled` dan
  mencabut lease-nya. Jawabannya 200 untuk job yang dibatalkan (juga kalau ditekan dua kali), 409
  `job_finished` untuk job yang sudah selesai atau gagal, 409 `job_deleting` untuk proyek yang
  sedang dihapus, dan 404 untuk job yang tidak ada.
- Worker (`web/scripts/run-job.mjs`) memeriksa lease setiap detik. Begitu lease dicabut, semua
  proses job (yt-dlp, engine, FFmpeg, termasuk yang berjalan di sesi sendiri) dihentikan dalam
  beberapa detik, lalu file percobaan yang belum jadi dihapus. Rinciannya:
  `docs/operations/STORAGE_RETENTION.md` "Cancelling a job".
- Di layar job itu tampil **Dibatalkan**: bilah progres berhenti di posisi terakhir dengan warna
  netral, tanpa persen, dan halaman proyek menampilkan "Proses dibatalkan" dengan tautan untuk
  membuat ulang. Status ini terpisah dari **Gagal**.
