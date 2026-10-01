# Operasional editor klip

Untuk pemilik dan siapa pun yang menjalankan server Potongin: layanan yang dipakai editor, flag
dan bawaannya, toolchain render yang dikunci, gerbang CI (setiap PR, setiap malam, dan saat
toolchain berubah), bukti pengujian, serta lisensi pihak ketiga. Cara memakai editor ada di
`docs/editor/PANDUAN-EDITOR.md`; angka gerbang di `docs/editor/GATES.md`; kontrak teknis di
`docs/editor/CONTRACTS.md`.

## 1. Layanan

`compose.yaml` menjalankan tiga container dari image yang sama:

| Layanan | Tugas untuk editor |
|---|---|
| `app` (Next.js) | Halaman editor, semua rute `/api/jobs/:id/clips/**` dan `/api/jobs/:id/assets/**`, lane pratinjau (sel video, audio, teks), saran AI. Unggahan logo dan musik tidak lewat `web/proxy.js`; rutenya memeriksa sesi sendiri. |
| `primary-worker` | Memproses video baru sampai klip otomatis jadi. |
| `render-worker` | Mengerjakan antrean ekspor dari editor (`analysis/render-requests/`), lalu memverifikasi hasilnya (G1–G3b) sebelum ditandai selesai. Tanpa layanan ini ekspor tetap "Antre". |

Semua data editor ada di folder job (`JOBS_ROOT/<job>/`): dokumen edit dan arsip revisi di
`analysis/clips/<clip_id>/edit/`, cache pratinjau di `analysis/clips/<clip_id>/preview/` (bisa
dibuat ulang), logo dan musik di `analysis/assets/`, hasil ekspor di `output/edits/<clip_id>/`.
Klip otomatis (`output/clip-NN.mp4`) tidak pernah ditimpa editor. Kapasitas dan aturan hapus job:
`docs/operations/STORAGE_RETENTION.md`.

## 2. Flag

Flag dibaca dari `.env` server dan diteruskan `compose.yaml` ke container yang memerlukannya.
Mengubah flag cukup dengan mengubah `.env` lalu deploy ulang; dokumen edit yang sudah tersimpan
tidak hilang saat flag dimatikan.

| Flag | Fungsi | Syarat menyala (keputusan pemilik) |
|---|---|---|
| `POTONGIN_EDITOR_V3` | Tombol "Edit klip" dan semua rute editor; `off` = 404 | Menyala saat rilis |
| `POTONGIN_EDITOR_UPLOADS` | Unggah logo dan musik | Setelah QG-SEC lengkap (tinjauan keamanan W4) |
| `POTONGIN_EDITOR_LLM` | Saran hook yang ditulis AI gratis di Pengaturan (saran instan tetap ada tanpa flag ini) | Setelah gerbang keras QG-AI lolos; penilaian 30 klip oleh pemilik menyusul |
| `POTONGIN_RENDER_ENGINE` | `edit-v2`: klip otomatis dirender dengan kompiler yang sama dengan ekspor editor; `legacy`: cara lama | `edit-v2` begitu PF-PIPELINE masuk anggaran di PC acuan (latar blur dan potong tengah ≤ 1,35×, ikuti wajah ≤ 1,6× dibanding `legacy`). Tampilan klip sedikit berubah dan file lebih besar (kualitas R7); keduanya sudah disetujui |
| `POTONGIN_LLM_EDITOR_MODELS` | Opsional: daftar `provider/model` gratis khusus saran hook; kosong = rantai di Pengaturan | Tidak ada syarat |
| `POTONGIN_PARITY_HARNESS` | Halaman uji paritas untuk CI | **Jangan pernah** di produksi |

Pra-centang kata pengisi di Rapikan tetap mati sampai pemilik mengonfirmasi label kata pengisinya.
Bawaan di `compose.yaml` diatur integrator rilis (T4.Z) sesuai gerbang yang lolos; `.env` selalu
bisa menimpanya.

## 3. Toolchain render yang dikunci

Cara teks dan video dirender bergantung pada versi persis FFmpeg, libass, FreeType, HarfBuzz,
FriBidi dan fontconfig. `Dockerfile` mengunci semuanya: image dasar per digest, arsip Debian per
snapshot (`DEBIAN_SNAPSHOT`) dan enam paket per versi. Saat image dibangun, versi itu dicatat di
`/app/resources/toolchain.json`, dan hash file itu masuk ke kunci setiap render. Di sisi browser,
pratinjau memakai JASSUB dengan versi persis (`web/package.json`).

Setiap perubahan pada kunci itu (snapshot Debian baru, versi paket, image dasar, atau JASSUB)
wajib disertai bukti P-TIME, P-TXT, P-ENC, P-COLOR dan P-RT yang diukur ulang pada kunci baru
(rencana §10). Job **Toolchain evidence guard** di CI menegakkannya:

1. `scripts/parity/toolchain_guard.py` menurunkan isi `toolchain.json` dari `Dockerfile` (tanpa
   build) dan membaca pin JASSUB dari `web/package.json` dan `web/package-lock.json`.
2. Hasilnya dibandingkan dengan catatan `docs/editor/evidence/toolchain/record.json` dan cap
   (`stamp`) di setiap file bukti yang disebut catatan itu. Bukti harus lolos dan bercap kunci
   yang sekarang; kalau tidak, PR gagal dengan pesan yang menyebut apa yang berubah.
3. Di dalam image, langkah `toolchain` dari `run_all.sh` memastikan `toolchain.json` image sama
   persis dengan turunan dari `Dockerfile`, jadi penurunan di langkah 1 tidak bisa melenceng.

Cara mengganti kunci (misalnya pembaruan keamanan Debian):

1. Ubah `DEBIAN_SNAPSHOT` (dan pin paket bila versinya ikut berubah) di cabang kerja, push.
2. Jalankan `gh workflow run ci-cd.yml --ref <cabang> -f suite=toolchain`.
3. Kalau lolos, unduh artifact `toolchain-evidence` dari run itu, salin isinya ke akar repositori
   (menimpa `docs/editor/evidence/toolchain/`), commit bersama perubahan kunci.
4. Catat perubahan dan angkanya di `docs/editor/GATES.md` ("Snapshot bumps"). Setiap kunci render
   berubah; revisi 0 tetap file klip otomatis karena isinya sama (R10).

Mengganti JASSUB sama caranya, ditambah memperbarui `web/app/licenses/notices.mjs` dan
`web/public/licenses/` (tes `web/tests/licenses.test.mjs` gagal kalau versi atau teks lisensinya
tidak cocok dengan paket yang terpasang).

## 4. Gerbang CI

Semua pekerjaan berat jalan di GitHub Actions, tidak di PC pemilik. Workflow `ci-cd.yml`:

| Kapan | Job | Isi |
|---|---|---|
| Setiap PR ke `main` dan setiap push ke `main` | Test and build | ruff, pytest (Python 3.11), `npm test` (Node 20), `npm run build`, build image, cek toolchain image, cek Compose |
| | Toolchain evidence guard | §3 di atas (beberapa detik) |
| | Parity (smoke) | Di dalam image produksi commit itu: P-TIME sisi FFmpeg (lima frame rate), referensi P-TXT untuk subset (4 paket × 40 karakter, hook, glyph cadangan), P-FRAME 940 frame (dua sumber barcode, 20 potongan dan cold open masing-masing; rencana minta ≥ 300), G-DET, P-AUD server dan R10. Lalu Chrome for Testing 147.0.7727.15 menjalankan harness teks terhadap aplikasi dari image yang sama: P-TIME sisi JASSUB dan P-TXT. ± 10 menit |
| Setiap malam pukul 01.30 WIB (cabang `main`) | Parity (nightly) | Semua isi smoke dalam ukuran penuh: P-FRAME ≥ 2.000 frame, P-PLATE, G1/G2, G-DET, PF-RENDER, matriks P-TXT lengkap dengan P-ENC dan P-COLOR, P-RT dan R10 pada tiga job, gerbang audio (duck, G3, G3b, G-CLICK, P-AUD), probe glyph, golden ASS, lalu gerbang lewat aplikasi (P-FRAME dan P-PLATE per tata letak, ganti tata letak, P-AUD dan PF-AUDIO lewat lane pratinjau). Artifact: `parity-full` (bukti JSON, log, `perf.json` laporan performa) dan `toolchain-evidence` (bukti bercap, siap di-commit) |
| Manual | sesuai `suite` | `gh workflow run ci-cd.yml --ref <cabang> -f suite=pr` (cek PR di cabang mana pun), `-f suite=toolchain` (§3), `-f suite=nightly` (run malam di cabang itu) |

Hasil tiap run: tabel lolos/gagal per gerbang di ringkasan run (Summary), dan artifact berisi
bukti JSON (angka saja, tanpa media). Angka waktu di runner 4 vCPU hanya indikasi; anggaran
performa (rencana §10.3) diukur di PC acuan.

Kalau run malam gagal: buka ringkasan run, cari gerbang yang `FAIL` atau `missing`, lalu baca
log bagiannya di artifact (`logs/<bagian>.txt`). Ambang tidak pernah diturunkan untuk membuat run
lolos; perbaikannya di kode, atau keputusan pemilik dicatat di `GATES.md`.

Untuk cabang kerja, `editor-gates.yml` tetap tersedia: `suite=full` (seperti Test and build),
`suite=image` (pytest di dalam image) dan `suite=command` (satu perintah di dalam image, misalnya
`sh scripts/parity/run_all.sh smoke pframe gdet`).

## 5. Bukti dan GATES

Setiap gerbang menulis bukti berupa JSON kecil (angka saja). Bukti gelombang ada di
`docs/editor/evidence/W<n>/`, bukti toolchain yang berlaku di `docs/editor/evidence/toolchain/`,
dan ringkasannya di `docs/editor/GATES.md`. Media pengujian selalu sintetis; video pemilik tidak
pernah masuk repositori atau CI.

## 6. Lisensi pihak ketiga

Halaman `/licenses` mencantumkan JASSUB 2.5.16 beserta komponen di dalam file WebAssembly-nya
(libass ISC, FriBidi LGPL-2.1, FreeType FTL, HarfBuzz, Brotli, runtime Emscripten), kode sumber
tiap komponen pada commit persisnya dan skrip build JASSUB; Mediabunny 1.59.1 (MPL-2.0); font
Montserrat (OFL), DejaVu dan DM Sans (OFL); Next.js dan React. Teks lisensinya ada di
`web/public/licenses/`. Seperti halaman lain, halaman ini sekarang meminta login.

Kewajiban yang perlu dijaga:

- FriBidi (LGPL-2.1) dikirim ke browser di dalam `jassub-worker.wasm`. Tautan kode sumber dan
  skrip build di halaman itu memungkinkan siapa pun membangun ulang file tersebut; jangan
  menghapusnya.
- FreeType meminta kalimat kredit di dokumentasi produk; kalimat itu ada di halaman lisensi.
- File JASSUB dan Mediabunny dikirim tanpa diubah. Kalau suatu saat diubah, perubahan pada file
  MPL (Mediabunny) harus dibuka dengan lisensi yang sama.

## 7. Masalah yang sering muncul

| Gejala | Penyebab dan jalan keluar |
|---|---|
| Ekspor tetap "Antre" | `render-worker` tidak jalan. Di server: `docker compose ps`; di lokal: langkah 4 di PANDUAN. |
| Ekspor: "Layanan editor sedang tidak tersedia" (lokal) | `resources/toolchain.json` belum dibuat (PANDUAN langkah 2). Image Docker membuatnya sendiri. |
| PR gagal di Toolchain evidence guard | Kunci toolchain atau JASSUB berubah tanpa bukti baru: ikuti §3. |
| Parity gagal di "Install Chrome for Testing" | Unduhan Chrome for Testing 147.0.7727.15 gagal; jalankan ulang job. Versi browser ini bagian dari kunci paritas, jadi jangan diganti tanpa mengukur ulang P-TIME dan P-TXT. |
| Saran hook hanya "AI seleksi"/"Heuristik" | `POTONGIN_EDITOR_LLM` mati, atau penyedia AI gratis di Pengaturan sedang tidak bisa dipakai. |
