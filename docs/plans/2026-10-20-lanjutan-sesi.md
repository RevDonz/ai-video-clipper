# Rencana lanjutan sesi 2026-10-20

Status (2026-10-21): **dikerjakan.** Semua item masuk ke satu PR gabungan dari branch
`adopsi/gabungan-2026-10-21` (menunggu merge pemilik), kecuali yang ditandai di bawah. Rincian dan
keputusan atas delegasi: `docs/HANDOFF.md` §8. Dokumen ini adalah antrean kerja yang disusun di
sesi 2026-10-20.

Hasil per item:

| Item | Hasil |
|---|---|
| P1 #1–3 error unduhan, unduhan macet, link YouTube | selesai |
| P1 #4 isolasi kegagalan per klip | selesai (dipakai atas delegasi) |
| P1 #5 pembaruan yt-dlp terjadwal | selesai; PR otomatis butuh izin Actions dari pemilik |
| P1 #6 dashboard | selesai |
| P1 #7 halaman proyek, ZIP | selesai |
| P1 #8 navigasi antar klip | selesai |
| P1 #9 Kata per baris, gaya Sorot | selesai |
| P1 #10 desain hook baru | selesai (Kicker, Blok, Kotak kata) |
| A1–A8 | selesai |
| A9 gaya caption saat buat job | selesai, termasuk posisi/ukuran/pack setelah klip otomatis pindah ke `edit-v2` |
| P2 Atur bingkai, Layar terbagi, latar blur, YuNet, cookies, Groq Whisper | selesai |
| P2 Rentang waktu, watermark teks, animasi masuk, Cek ejaan, judul/deskripsi | selesai |
| P2 Most Replayed | **tidak dikirim**: A/B tidak menunjukkan manfaat (HANDOFF §8); branch hanya lokal |
| P3 dokumen basi | selesai |

Tambahan yang ikut dikirim: mesin `edit-v2` untuk klip otomatis, potong jeda otomatis, karaoke
`\kf` dan gaya Sinar, output 1:1 dan 1080p, font aksen, gizmo caption, peringatan caption menutupi
wajah, "Pakai di semua klip", Zoom dan buang garis hitam, badge header, landing. Tidak dibuat:
watchdog `-progress` untuk mesin lama, karena mesin itu kini hanya fallback dan saklar rollback. Aturan proyek tetap `AGENTS.md`, arah desain
`DESIGN.md`, status umum `docs/HANDOFF.md`.

Ide-ide di bawah berasal dari riset produk clipper lain dan dari pembacaan kode Potongin. Ambil
idenya saja dan implementasikan ulang. Jangan salin kode, aset, font, atau teks dari produk lain.
Bahan riset mentahnya hanya tersimpan lokal di PC rumah dan tidak dibutuhkan untuk mengerjakan
antrean ini.

## Cara kerja

- Checkout utama tetap di branch `potongin-adopsi-scl`, yang berisi dokumen ini.
- Setiap paket kerja dikerjakan di git worktree baru dari `origin/main`, dengan branch
  `adopsi/<nama>`. Paket yang file-nya tidak bertabrakan boleh dikerjakan paralel.
- **Merge ke `main` diizinkan pemilik (2026-10-20)** selama aplikasi belum dipakai. Setiap merge
  ke `main` langsung deploy ke produksi, dan pemilik memantau deploy-nya.
  - Satu paket per PR. Merge dengan rebase (`gh pr merge --rebase`), hanya setelah semua check
    CI hijau. Jangan pernah push langsung ke `main`.
  - Setelah merge, pantau job deploy (`gh run watch`). Kalau deploy gagal, perbaiki lewat PR
    berikutnya.
  - Paket yang ditandai **KEPUTUSAN PEMILIK DIPERLUKAN** tetap draft PR dan tidak di-merge.
- Tes dulu, baru kode. Di lokal hanya jalankan tes yang ditargetkan:
  - `uv run pytest tests/test_x.py`
  - `cd web && node --test tests/x.test.mjs`
- Suite penuh dijalankan di GitHub Actions:
  `gh workflow run editor-gates.yml -f ref=<branch> -f suite=full`, lalu `gh run watch`.
- Sebelum push, jalankan gitleaks dengan config repo. Jangan pernah melemahkan tes atau ambang.
- Tidak ada dependensi runtime baru. Python tetap 3.11. `src/ai_clipper/edit_v2` hanya stdlib.
- UI selalu versi terbaru tanpa label versi. Tema gelap, satu aksen lime, DM Sans. Copy Indonesia
  singkat. Jangan pakai kata "Hot" atau "viral" untuk skor (`README.md` sekitar baris 296).
- Sebelum mengerjakan tiap item, cek dulu apakah fiturnya sudah ada. Kalau sudah ada, lewati dan
  catat di laporan.

## P1

1. **Error unduhan YouTube.**
   - Masalah: stderr yt-dlp tidak ditangkap (`web/scripts/run-job.mjs` sekitar :284, stdio
     `inherit`), jadi pengguna hanya melihat "yt-dlp gagal (exit N)" (sekitar :329).
   - Tangkap ujung stderr dengan batas ukuran.
   - Buat `web/lib/download-errors.mjs` yang memetakan baris `ERROR:` ke kode tetap: privat,
     dihapus, dibatasi usia, khusus member, diblokir wilayah, bot-check, dan format/ekstraktor
     (artinya yt-dlp perlu diperbarui).
   - Tiap kode punya teks Indonesia singkat dengan satu saran. Teks itu ditampilkan lewat
     `web/lib/project-view.mjs` (sekitar :88-93). Kode mentah tetap disimpan di job.
2. **Penjaga unduhan macet.** Jalankan yt-dlp dengan `--newline` dan baca progresnya. Kalau
   progres tidak bergerak selama N detik, hentikan dengan pesan "Unduhan macet". Tahap merge tidak
   dihitung macet. Lokasi: `run-job.mjs` sekitar :388-392.
3. **Link YouTube.** Terima juga `m.youtube.com` dan `music.youtube.com` (`web/lib/jobs.mjs`
   sekitar :856-861).
4. **Isolasi kegagalan per klip di render legacy.**
   - Lokasi: `src/ai_clipper/pipeline.py`, loop sekitar :1268-1330 dan publish sekitar
     :1671-1685.
   - Satu klip yang gagal tidak boleh menggagalkan seluruh job. Tandai klip itu gagal. Job tetap
     `completed` selama minimal satu klip berhasil. Halaman proyek menampilkan "Gagal" di kartu
     klip tersebut.
   - Ini mengubah perilaku fail-closed. Tulis **KEPUTUSAN PEMILIK DIPERLUKAN** di PR.
5. **Pembaruan yt-dlp terjadwal.**
   - Buat workflow GitHub Actions mingguan yang menaikkan yt-dlp di `uv.lock`, menjalankan smoke
     test unduhan satu video publik pendek, lalu membuka PR.
   - Tulis prosedur darurat "YouTube rusak: naikkan yt-dlp" di `docs/editor/OPERASIONAL.md`.
6. **Dashboard** (`web/app/dashboard/page.jsx`).
   - Ingat pilihan terakhir di localStorage, dengan try/catch. Default sekarang di-hardcode di
     sekitar :187-196.
   - URL/file dan tombol "Buat klip" dalam satu baris di atas. Opsi lain dilipat dengan ringkasan
     satu baris.
   - Durasi pakai preset: Otomatis / Pendek / Sedang / Panjang / Atur sendiri.
   - Tambah pilihan "Bahasa video": Indonesia (default), Inggris, Deteksi otomatis. Nilainya
     diteruskan ke `--language`. Sekarang masih `WHISPER_LANGUAGE || "id"` (`run-job.mjs:42`) dan
     `CAPTION_LANGUAGES` (`:118`). Fungsi transkripsi di `transcribe.py` sudah menerima `None`
     untuk deteksi otomatis.
7. **Halaman proyek** (`web/app/projects/[id]/page.jsx`).
   - Grid kartu poster berisi nomor, judul, pill skor, dan durasi, plus satu panel detail.
   - Chip filter "Semua" dan "Skor 8+".
   - Mode "Pilih" dengan tombol "Unduh (n)" dan "Unduh semua", lewat route ZIP baru di bawah
     `web/app/api/jobs/[id]/`. ZIP dibuat tanpa dependensi baru (zlib dan crc32 bawaan Node) dan
     punya batas ukuran.
8. **Editor: navigasi antar klip.** Tambah "Klip 3/8 ‹ ›" di
   `web/components/editor/TopBar.jsx`. Simpan autosave dulu sebelum pindah klip.
9. **Caption.**
   - Override baru "Kata per baris" 1–4 (`words_max`). Lokasi terkait:
     `src/ai_clipper/edit_v2/captions.py` sekitar :110-113 dan `web/lib/editor/doc-model.mjs`
     sekitar :420. Butuh migrasi skema. Klip otomatis tidak boleh berubah.
   - Pack caption baru dengan kotak di belakang kata yang sedang diucapkan. Perluas kotak di
     `captions_ass.py` sekitar :805-815. Teks otomatis jadi gelap di atas kotak terang.
   - Wajib lolos gerbang paritas P-TXT.
10. **2–3 desain hook baru** di `resources/hook-designs/`, `captions_ass.py`, dan `HookCard.jsx`.
    Auto-fit dan badge "Muat / Akan terpotong" tetap dipertahankan.

## Tambahan (A)

- **A1. Halaman `/bantuan` berbasis kode error.**
  - Satu entri per kode error, berisi penyebab dan langkah perbaikan. Sumber kodenya: kode unduhan
    dari P1 #1, `storageMessage` di `web/lib/dashboard-view.mjs`, dan galat LLM di
    `src/ai_clipper/llm.py` sekitar :1540-1565.
  - Kolom cari: pengguna menempelkan teks error, lalu entri yang paling cocok terbuka.
  - Pesan error di halaman proyek menautkan ke `/bantuan#<kode>`.
- **A2. Fallback per klip harus terlihat.**
  - Klip otomatis yang tidak menemukan wajah (jatuh ke potong tengah), atau yang jatuh ke mesin
    render cadangan (`engine_fallback` di `src/ai_clipper/pipeline.py` sekitar :1282), mendapat
    catatan singkat di kartunya.
  - Kode `no_face` sudah ada untuk editor (`web/lib/clip-renders.mjs` sekitar :49).
- **A3. Ringkasan hasil per tahap di progres job.**
  - Contoh: "Transkrip: 2.304 kata · dari subtitle YouTube" atau "AI memilih momen: 12 kandidat".
  - Label tahap sudah ada di `JOB_STAGE_LABELS`. Isinya diambil dari data yang sudah ada; jangan
    mengarang angka.
- **A4. Tombol "Batalkan" untuk job yang sedang berjalan.** Proses anak harus berhenti dengan
  bersih dan statusnya jelas. Cek dulu apakah API-nya sudah ada.
- **A5. Nama file unduhan `NN-judul-klip.mp4`.** `web/lib/final-files.mjs` sudah menerima
  parameter `name`. Pakai juga untuk ZIP di P1 #7.
- **A6. Logo bawaan di Pengaturan.** Otomatis dipakai untuk klip baru, dan tetap bisa diganti per
  klip lewat `LogoPanel`.
- **A7. Tampilan "Klip" di Riwayat.** Grid poster lintas proyek, pencarian judul atau URL sumber,
  filter "Skor 8+" dan "Minggu ini", serta tombol "Muat lagi".
- **A8. "Tentang sistem" di Pengaturan.** Tampilkan versi yt-dlp, FFmpeg/libass
  (`resources/toolchain.json`), dan model Whisper.
- **A9. Gaya caption saat buat job.**
  - Isinya: kanvas mini 9:16 dengan zona aman, Atas/Tengah/Bawah, ukuran, dan 4 pack dengan
    thumbnail.
  - Bergantung pada keputusan mesin `edit-v2` untuk klip otomatis (`docs/HANDOFF.md` §4).
    Kerjakan hanya bagian yang tidak bergantung pada keputusan itu, dan catat sisanya sebagai
    keputusan pemilik.

## P2

- Reframe manual "Atur bingkai" dengan keyframe: `edit_v2/doc.py` (layout), `edit_v2/layouts.py`,
  dan gizmo baru.
- Layout split 30/70 dan 50/50. Mode `split` sudah dicadangkan di `edit_v2/doc.py` sekitar
  :511-512.
- Fallback `fit_blur` saat tidak ada wajah (`doc.py` sekitar :513).
- Deteksi wajah YuNet (`cv2.FaceDetectorYN`) dan pembicara aktif, dibuktikan dengan set evaluasi.
- `cookies.txt` di Pengaturan: disimpan tersegel seperti `web/lib/llm-settings.mjs`, divalidasi
  saat diunggah, dan tidak pernah dilog.
- Groq Whisper sebagai pilihan opt-in, dengan fallback ke Whisper lokal.
- Sinyal "Most Replayed" dari heatmap yt-dlp. Ukur dulu dengan `python -m ai_clipper.benchmark`.
- Rentang waktu manual.
- Watermark teks satu baris.
- Animasi masuk caption: Tanpa / Fade / Pop / Blur.
- "Cek ejaan" lewat rantai LLM gratis.
- Judul dan deskripsi klip bisa diedit, dengan tombol "Tulis ulang".

## P3: dokumen yang basi

- `README.md` masih menulis "Technical Spike", port 3000, dan saran seolah belum ada login.
- Komentar di `compose.yaml` dan `README.md` menyebut render `edit-v2`, padahal nilai
  sebenarnya `legacy`.
- `docs/HANDOFF.md` masih menulis PR #25 menunggu merge, padahal isinya sudah ada di `main`.
- `.env.example` belum memuat `JOBS_STORAGE_*`.
- Nama di `pyproject.toml` masih `ai-video-clipper-spike`.

## Laporan akhir

Perbarui `docs/HANDOFF.md` di branch `potongin-adopsi-scl`. Isinya:

- paket yang selesai, beserta branch dan PR-nya;
- hasil CI;
- keputusan yang menunggu pemilik;
- langkah berikutnya.

Push branch itu, buka PR, lalu merge dengan rebase setelah CI hijau. (2026-10-21: batch ini masuk
sebagai satu PR gabungan yang di-merge pemilik sendiri, bukan oleh agen.)
