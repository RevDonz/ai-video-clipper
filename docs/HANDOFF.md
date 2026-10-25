# Handoff: status dan cara melanjutkan

Terakhir diperbarui 2026-10-25. Dokumen ini untuk agen atau device mana pun yang melanjutkan.
Aturan proyek: `AGENTS.md`; arah desain: `DESIGN.md`.

**Rombak 2026-10-24** (multi-pengguna, dashboard HeroUI, ID/EN, unduhan link, Otomatis, sosmed,
umpan balik performa, editor satu tata letak): rencana di `docs/plans/2026-10-24-rombak/`
(PR #31, branch `docs/rombak-spec` sampai di-merge). Sekarang di gerbang G0; status dan langkah
berikutnya: §10.

**Redesign UX** (sidebar aplikasi, Buat klip dengan lipatan, halaman depan baru, tata letak
editor, panduan di Bantuan) sudah live: PR #30, di-merge dengan rebase dan ter-deploy 2026-10-23.
Isi, validasi dan sisa risiko: §9.

**PR gabungan adopsi** (45 paket, antrean `docs/plans/2026-10-20-lanjutan-sesi.md`) sudah masuk ke
`main` lewat #29 (2026-10-22). Isinya, keputusan atas delegasi pemilik dan yang masih untuk
pemilik: §8.

## 1. Sudah live di produksi (`main`)

- Selection V3 (pemilihan momen dengan LLM gratis + heuristik), halaman Pengaturan AI (key
  terenkripsi), server LLM sendiri/9Router, thumbnail klip, Whisper bertanda baca, heuristik v3.1.
- Upload > 10 MB (route upload tidak lewat proxy).
- Konteks Tren (`docs/plans/2026-09-25-konteks-tren.md`) dan Fokus klip
  (`docs/plans/2026-09-25-fokus-klip.md`).
- Jalur A (PR #14): tampilan selalu terbaru tanpa label versi, tema gelap di semua halaman, editor
  kandidat lama dipensiunkan di sisi web, penjaga UI di CI; perbaikan rate limit login (PR #15);
  workflow `editor-gates.yml` untuk tes berat (PR #16).
- Skill antislop (mode during), `AGENTS.md`, `DESIGN.md`.
- Editor klip (Esensial, W1–W4), PR #20, live sejak 2026-10-02: tombol **Edit klip** di kartu
  klip dan riwayat. Editor, unggahan aset dan saran AI menyala; render otomatis klip memakai
  mesin `legacy` sampai pemilik memutuskan kuota CPU (§4).
- Transisi di sambungan cold open (PR #23: Kilat putih / Gelap sebentar + whoosh) dan perbaikan
  frame pertama pratinjau (PR #24).
- Editor dengan dua tampilan, Mode Cepat dan Mode Lengkap (PR #25, digabung 2026-10-06),
  termasuk 10 perbaikan dari review PR. Rombak menggantinya dengan satu tata letak (Fase 10–11,
  `DESIGN.md` "Pola tata letak").
- Redesign UX (PR #30, ter-deploy 2026-10-23): sidebar aplikasi, Buat klip dengan lipatan,
  halaman depan baru, rel alat editor di kiri, Panduan di Bantuan (§9).

Deploy terjadi otomatis lewat CI setiap ada merge ke `main`.

## 2. Keputusan pemilik yang berlaku

- **Selalu terbaru:** tanpa label versi di tampilan, tanpa mode lama; yang lebih baik langsung
  menggantikan yang lama.
- **Desain:** gelap di semua halaman, DM Sans, satu aksen lime, gerak halus (`DESIGN.md`).
- **LLM:** penyedia gratis dulu; jangan pindah ke model berbayar tanpa bertanya.
- **Konteks Tren:** tren hanya untuk kemasan + dorongan ringan, selalu di-ground ke transkrip.
- **Fokus klip:** "utamakan, sisanya diisi" (klip yang cocok duluan, sisa slot diisi dan diberi
  label).
- **Editor lama (kandidat V2) dipensiunkan**, termasuk backend-nya (W4). Job lama tetap bisa
  dilihat dan diunduh; baseline benchmark tetap jalan.
- **Mesin render klip otomatis:** `edit-v2` (diputuskan atas delegasi 2026-10-21, berlaku setelah
  PR gabungan di-merge; §8). Render potong tengah dan ikuti wajah ± 2× lebih lambat di kuota
  `cpus: 6` diterima, kuota tidak dinaikkan. `POTONGIN_RENDER_ENGINE=legacy` adalah saklar
  rollback; mesin lama juga tetap jadi fallback per klip. Perubahan tampilan dan file yang lebih
  besar sudah disetujui.
- **Rilis setelah W4 dengan flag menyala bila gerbangnya lolos:** editor; unggahan setelah QG-SEC
  lengkap; saran AI setelah gerbang keras QG-AI otomatis (penilaian 30 klip oleh pemilik menyusul).
  Pra-centang kata pengisi di Rapikan tetap mati sampai pemilik mengonfirmasi labelnya.
- **Masuk ke editor** mudah ditemukan dan tanpa langkah "Siapkan" manual (W3, dipertahankan).
- **Caption bawaan (K5)** tetap di posisi klip otomatis (klip yang tidak diubah mengekspor file
  otomatis); pemberitahuan area aman TikTok dibuat informatif (catatan biru, tanpa centang).
- Rencana editor dan semua keputusan K1–K15: `docs/plans/2026-09-24-editor-v3-esensial.md` §12.

## 3. Jalur A: UI "selalu terbaru" + tema gelap (selesai, di `main`)

Dashboard satu alur tanpa V1/V2/"Mode lama", tanpa label versi di mana pun, halaman dan route web
editor lama dihapus (tautan lama diarahkan ke halaman proyek), semua halaman gelap sesuai
`DESIGN.md`. Job baru selalu memakai seleksi terbaru; API menolak v1/v2; default CLI ikut
terbaru. Digabung lewat PR #14. Modul backend editor lama dihapus kemudian di jalur B (W4, T4.1).

Catatan terbuka untuk pemilik: pilihan "Tanpa LLM" per job hilang dari dashboard (AI diatur di
Pengaturan; API masih menerima `llmMode=off`).

## 4. Jalur B: Editor (live sejak 2026-10-02, menunggu titik cek 3)

Rencana lengkap: `docs/plans/2026-09-24-editor-v3-esensial.md`. Kontrak, hasil gerbang, panduan
dan operasional: `docs/editor/{CONTRACTS,GATES,PANDUAN-EDITOR,OPERASIONAL,UJI-PENERIMAAN}.md`.

- **Live lewat PR #20** (commit `5064831` di `main`). GitHub tidak bisa merge-rebase branch
  sebesar ini (403 commit, 961 file), jadi masuk sebagai satu commit squash; riwayat lengkapnya
  ada di branch `editor-release` (pohon identik; jangan dihapus). PR #18 ditutup karena
  digantikan #20. Isi W4 dan hasil gerbangnya: `docs/editor/GATES.md` bagian "W4 Siap rilis".
  Penjaga deploy untuk ekspor `cancelled` masuk lebih dulu lewat PR #19.
- **Cek produksi setelah deploy:** health OK; semua halaman dan route editor mengarah ke login
  tanpa sesi; ketiga container memakai image `5064831`; flag sesuai bawaan di bawah; FFmpeg
  5.1.9; tidak ada error di log; beban server rendah.
- **Bawaan rilis di `compose.yaml`:** `POTONGIN_EDITOR_V3=on`, `POTONGIN_EDITOR_UPLOADS=on`,
  `POTONGIN_EDITOR_LLM=on`; di `main` sekarang `POTONGIN_RENDER_ENGINE=legacy`, di PR gabungan
  `edit-v2` dan `POTONGIN_AUTO_PAUSE_TRIM=on` (§8). Cara mengubah satu flag di server:
  `docs/editor/OPERASIONAL.md` §2 (baris di `.env`, lalu `docker compose up -d`, tanpa build).
- Branch tugas `editor-w4-t4.1` … `editor-w4-t4.5` sudah masuk; tidak perlu dilanjutkan.

- **Mode Cepat dan Mode Lengkap** (PR #25, digabung 2026-10-06): spek
  `docs/plans/2026-10-02-editor-mode-cepat.md`, hasil gerbang `docs/editor/GATES.md` "Mode Cepat
  and Mode Lengkap" dan "Review fixes". Rollback: revert commit PR itu lewat PR baru.

Langkah berikutnya:
1. **Titik cek pemilik 3** (± 60 menit; paketnya di luar repo, di PC pemilik:
   `artifacts/handoff/checkpoint3/`):
   - uji U1–U8 dengan stopwatch di 1366×768 dan 1920×1080 (`docs/editor/UJI-PENERIMAAN.md`;
     Mode Cepat sudah di `main`);
   - penilaian 30 saran hook AI (lulus ≥ 21/30). Flag LLM sudah menyala karena gerbang otomatisnya
     lolos; kalau penilaian gagal, matikan `POTONGIN_EDITOR_LLM` dan perbaiki prompt di W5;
   - konfirmasi 490 label kata pengisi; kalau presisi tetap ≥ 0,9, ubah `precheck` di
     `resources/lexicon/id-fillers.v1.json` ke `true` lewat PR.
2. ~~Keputusan kuota CPU dan P-LOGO.~~ Diambil atas delegasi 2026-10-21 (§8).
3. **Uji di produksi oleh pemilik:** buka satu proyek, **Edit klip**, ekspor satu klip; proses
   satu video baru. Rollback seluruh editor = revert commit `5064831` lewat PR (penjaga deploy
   dari #19 tetap, jadi deploy rollback tidak tertahan). Satu fitur saja bisa dimatikan lewat
   flag-nya (`docs/editor/OPERASIONAL.md` §2).
4. **Sisa teknis (W5 atau sesudahnya):** P-AUD klip VFR sintetis 16 sampel lebih pendek (Open 12)
   membuat nightly merah; PF-AUDIO dengan musik tipis di runner 4 vCPU; halaman `/licenses` masih
   di balik login.

Gerbang berat jalan di GitHub Actions, bukan di PC pemilik: `editor-gates.yml` (`suite=full`,
`suite=image`, `suite=command`) dan `ci-cd.yml` (PR: tes + penjaga toolchain + smoke paritas;
`-f suite=nightly|toolchain` lewat dispatch). Di worktree, perintah pemindai rahasia (gitleaks)
perlu folder `.git` repo utama ikut di-mount (beserta `safe.directory`); tanpa itu ia memindai 0
commit. Docker image gitleaks bisa dipakai dengan mode `dir` atas salinan file yang diubah
(`git diff --name-only origin/main HEAD`), memakai `.gitleaks.toml` dari `origin/main`.

## 5. Lain-lain yang tertunda

- Judul klip fokus dari heuristik masih kasar: satu permintaan LLM untuk merapikan judulnya.
- ~~Perbarui `docs/ROADMAP.md` dengan keputusan 2026-09-30.~~ Selesai di `feat/ui-latest-dark`.
- Pemilik: ganti API key LLM dan password server yang pernah tertempel di chat (§8).
- Disk server 81%: build cache Docker ± 17 GB dan image lama ± 10 GB bisa dibersihkan. Server
  juga dipakai aplikasi lain, jadi pemilik yang memutuskan.

## 6. Menyiapkan lingkungan di device baru

```bash
git clone https://github.com/RevDonz/ai-video-clipper.git && cd ai-video-clipper
git fetch origin && git switch <branch>
uv sync --frozen --extra vision --extra web --extra transcribe   # Python 3.11+, FFmpeg di PATH
(cd web && npm ci && npx playwright install chromium)
uv run ruff check src tests && uv run pytest        # pyproject sudah memakai -q; jangan tambah -q lagi
(cd web && npm test && npm run build)
```

Menjalankan aplikasi lokal: `web` (Next.js) + `web/scripts/primary-worker.mjs` dengan env
`JOBS_ROOT`, `POTONGIN_SETTINGS_DIR`, `APP_USERNAME`, `APP_PASSWORD`, `APP_SESSION_SECRET` (acak,
≥ 32 karakter, simpan, karena key LLM terenkripsi dengannya), `PYTHON_BIN`/`AI_CLIPPER_BIN` dari
`.venv`, `MAX_UPLOAD_BYTES`, dan `JOBS_STORAGE_*`/`PRIMARY_*` seperti di `compose.yaml` dan
`docs/operations/STORAGE_RETENTION.md`. Key LLM diisi lewat halaman Pengaturan. Untuk editor:
`POTONGIN_EDITOR_V3=on`, render worker (`python -m ai_clipper.render_worker --watch`), dan
`resources/toolchain.json` lokal (`python -m ai_clipper.edit_v2.toolchain write …`, lihat
`docs/editor/PANDUAN-EDITOR.md` di branch editor).

## 7. Hemat token

- Satu jalur dulu (A lebih kecil dan hasilnya langsung terlihat), baru B.
- Sedikit agen: untuk bagian kecil cukup satu pembangun + satu pemeriksa.
- Lanjutkan dari commit yang ada; jangan mulai ulang tugas yang sudah punya banyak commit.

## 8. Adopsi 2026-10-21 (PR gabungan #29, sudah di `main`)

Branch `adopsi/gabungan-2026-10-21`: 45 paket dari `docs/plans/2026-10-20-lanjutan-sesi.md`,
dibangun per paket di worktree, lalu diintegrasikan dalam tiga gelombang; suite lokal penuh hijau
setelah tiap paket. Hasil CI dan gerbang berat ada di PR. Rincian per paket ada di deskripsi dan
komentar PR, dan di `docs/editor/CONTRACTS.md` / `GATES.md`.

**Yang dikirim**
- **Unduhan dan job:** kode galat unduhan YouTube dengan saran, penjaga unduhan macet, link
  `m.`/`music.youtube.com`, cookies YouTube tersegel di Pengaturan, pembaruan yt-dlp mingguan
  dengan smoke test, Batalkan job, isolasi kegagalan per klip, `.srt` opsional untuk unggahan,
  Rentang waktu manual, Groq Whisper opt-in dengan fallback lokal, output 1:1 dan 1080p per job.
- **Klip otomatis:** mesin `edit-v2`, potong jeda hening otomatis, YuNet + pembicara aktif untuk
  Ikuti wajah, buang garis hitam sumber, catatan saat wajah tidak ditemukan atau render cadangan
  dipakai, karaoke `\kf` dan gaya Sinar, Kata per baris dan gaya Sorot, font aksen kata kunci.
- **Dashboard, proyek, riwayat:** pilihan diingat, preset durasi, Bahasa video, gaya/posisi/ukuran
  subtitle dengan pratinjau 9:16, ringkasan per tahap, badge job di header, workspace proyek
  dengan ZIP dan nama `NN-judul`, sakelar "Hook di video", judul/deskripsi bisa diubah dengan
  Tulis ulang, chip "Diedit", Riwayat "Proyek | Klip", halaman `/bantuan`, landing dengan contoh
  nyata.
- **Editor:** navigasi "Klip n/m", Atur bingkai (keyframe), Layar terbagi 30/70 dan 50/50, latar
  blur tanpa wajah, Zoom 100–150 %, animasi masuk caption, desain hook baru, gizmo caption,
  peringatan caption menutupi wajah, Cek ejaan, "Pakai di semua klip" dengan Urungkan, geser
  0,1 dtk, watermark teks, peringatan logo menimpa caption.
- **Pengaturan dan dokumen:** logo bawaan, watermark teks bawaan, "Tentang sistem", label tombol
  simpan yang spesifik, README/compose/`.env.example`/nama paket yang benar.

**Saklar rollback (tanpa revert, di `.env` server lalu `docker compose up -d`)**
- `POTONGIN_RENDER_ENGINE=legacy`: klip otomatis kembali ke mesin lama (dashboard hanya Klasik dan
  Karaoke).
- `POTONGIN_AUTO_PAUSE_TRIM=off`: proyek baru tanpa potong jeda.
- `POTONGIN_EDITOR_LLM=off`: Cek ejaan dan saran hook AI mati.
- Groq Whisper mati bawaan; dimatikan lagi lewat kartu Transkripsi di Pengaturan.
- Paket lain: revert commit-nya lewat PR baru (catatan per paket di PR).

### Keputusan yang diambil atas delegasi pemilik (2026-10-21)

- **Klip otomatis dirender `edit-v2`**; render ± 2× lebih lambat di `cpus: 6` diterima, kuota tidak
  dinaikkan (server dipakai bersama); `legacy` tinggal fallback per klip dan saklar rollback.
  Watchdog `-progress` untuk mesin lama tidak dibuat karena mesin itu kini hanya cadangan.
- **P-LOGO diterima apa adanya** (1 dari 18 frame lewat batas karena caption terlihat di balik logo
  transparan); ambang tidak diubah, penerimaannya dicatat di GATES.
- **Karaoke memakai `\kf`** tanpa opsi kembali ke `\k`; varian cahaya dikirim sebagai gaya Sinar;
  persetujuan tampilan gaya baru (Sinar, Sorot, font aksen) diberikan lewat delegasi.
- **`RENDER_SEMANTICS` naik sekali ke 2** untuk seluruh batch; perubahan piksel lain masuk ke
  kenaikan itu.
- **Output 1:1 dan 1080p dirilis setelah biaya render diukur**, dipilih per job (bukan per klip),
  kuota CPU tetap.
- **Isolasi kegagalan per klip dipakai**: job tetap "Selesai" bila minimal satu klip jadi, klip yang
  gagal ditandai "Gagal"; tanpa flag (rollback = revert).
- **Potong jeda hening otomatis menyala bawaan** (8 dari 10 klip terbantu, rata-rata 0,7 detik per
  jeda; tawa, musik dan jeda bersuara tidak dipotong); rollback `POTONGIN_AUTO_PAUSE_TRIM=off`.
- **Most Replayed tidak dikirim.** A/B di 7 episode gold: dorongan 1,5–5 poin hanya bergeser ±1
  (noise), mulai 10 poin hasilnya turun; momen gold ada di persentil 0,50 kurva replay (sama dengan
  acak), trap di 0,63. Branch `adopsi/most-replayed` hanya lokal; ukur ulang kalau ada label
  pemilik atau data performa klip.
- **Batas klip tetap 1–10 klip dan 5–180 detik:** kasus terberat sudah ± 13,5 menit render di 720p
  dan ± 30 menit di 1080p per job; 20 klip berarti ± 1 jam render dan ± 1,5 GB klip di server
  bersama, dan klip di atas 180 detik melewati batas Shorts/Reels.
- **Tombol simpan di Pengaturan tetap terpisah** dengan label spesifik (AI, watermark, key Groq),
  karena datanya dan validasinya berbeda.
- **Nama tata letak** di semua tempat memakai nama editor (Latar blur, Ikuti wajah, Potong tengah,
  Layar terbagi); perbaikan logo menimpa caption memindahkan logo, bukan caption.
- **Peringatan caption menutupi wajah** adalah cek yang perlu dicentang sebelum ekspor; perbaikan
  sekali klik hanya ke preset Atas/Tengah/Bawah.
- **`.srt` hanya untuk unggahan** (maks 2 MB), ditolak hanya bila kosong atau lebih panjang dari
  video; job lalu kembali ke Whisper dengan catatan.
- **Landing** memakai footage *Elephants Dream* (CC BY 2.5) dan klip contoh tanpa penyedia AI.
- **Badge header** menghitung job menunggu sebagai berjalan; titik lepas menu pindah ke 850 px.
- Keputusan kecil lain per paket (gizmo, Zoom, "Pakai di semua klip", sakelar hook, chip
  "Diedit", geser 0,1 dtk) tercatat di deskripsi PR.

### Masih untuk pemilik

1. Uji U1–U8 dengan stopwatch (`docs/editor/UJI-PENERIMAAN.md`), sebaiknya setelah PR gabungan
   di-merge.
2. Penilaian 30 saran hook AI (lulus ≥ 21/30).
3. Konfirmasi 490 label kata pengisi (`precheck` di `resources/lexicon/id-fillers.v1.json`).
4. Ganti API key LLM dan password server yang pernah tertempel di chat.
5. Izin "Allow GitHub Actions to create and approve pull requests" (Settings > Actions > General)
   untuk PR yt-dlp mingguan; tanpa izin itu, PR dibuka lewat tautan di Summary run.
6. ~~Merge PR gabungan.~~ Masuk lewat #29 (2026-10-22).
7. Kalau ingin meninjau ulang: tampilan gaya caption baru (Sinar, Sorot, font aksen), yang disetujui
   lewat delegasi.
8. ~~Gerbang merah di PR #27 yang butuh keputusan.~~ Diputuskan atas delegasi pemilik
   (2026-10-22), diperbaiki di produk tanpa mengubah ambang (`docs/editor/GATES.md`
   "Combined adoption PR"):
   - Pop naik dalam langkah 1/32 setiap 10 ms (68,75 % → 109,375 % → 100 %);
   - cahaya Sinar diperkecil: blur H·9/1280 → H·7/1280;
   - kotak hook Blok dan garis watermark diberi tepi lembut H/1280 (1 px di 1280);
   - ukuran watermark minimal tetap 500 ‰: ukuran lebih besar tidak menolong P-ENC.
   PF-SEEK (pemutar) dan P-AUD (nightly) juga merah di `main`; smoke yt-dlp tidak meyakinkan
   karena cek bot YouTube di IP runner.
9. Perbaikan parity mengubah tampilan sedikit: 2–3 frame awal Fade lebih gelap (isi di atas
   garis), dan watermark tembus pandang lebih gelap di dalam (maks 32 level di 85 %).

## 9. Redesign UX (PR #30, live sejak 2026-10-23)

Permintaan pemilik: tampilan profesional tapi ramah dan mudah dipelajari, rujukan Lokaclip, Social
Visuals dan editor CapCut. Dibuat dari `main` 4b0ef34, di-merge dengan rebase sebagai #30
(`77ff02a1` + tindak lanjut e2e `70c3a26a`) dan ter-deploy lewat CI pada 2026-10-23. Arah dan
polanya: `DESIGN.md` "Pola tata letak" (butir "Sekarang").

**Yang berubah**
- **Sidebar aplikasi** (`web/components/AppShell.jsx`, `lib/app-nav.mjs`, `lib/app-menu.mjs`,
  `lib/app-icons.mjs`): menggantikan `AppHeader` di semua halaman login, 404, error dan lisensi.
  Buat klip di atas, grup Kerja dan Sistem, Keluar di bawah, badge job tetap tepat setelah merek.
  Di bawah 1024 px: bar atas + tombol Menu (laci, Escape/Tutup, fokus kembali, halaman `inert`).
  Ada skip link "Langsung ke isi". Bilah simpan Pengaturan kini `sticky` di kolom halaman.
- **Buat klip:** Jumlah klip, Rasio, Durasi, Layout selalu terlihat; tiga lipatan berlabel
  dengan ringkasan (`OPTION_SECTIONS`, `sectionSummary`, `withSection` di
  `lib/dashboard-choices.mjs`; `openSections` menggantikan `optionsOpen`, nilai lama `true`
  membuka ketiganya). Error membuka lipatannya lalu memfokuskan field. Tombol Buat klip punya
  deskripsi "Job berikutnya: …". Dua kolom mulai 1180 px.
- **Kepala halaman** seragam (`.pageHead` di `globals.css`): Buat klip, Riwayat, Konteks Tren,
  Pengaturan (dengan indeks bagian per tugas), Bantuan, Lisensi.
- **Bantuan:** bagian Panduan (`lib/help-guide.mjs`) sebelum referensi error; teks diambil dari
  daftar yang dipakai halaman. Satu langkah bantuan diperbaiki: tombolnya "Pilih file", bukan
  "Unggah file". Penulisan "Buat Klip" diseragamkan menjadi "Buat klip".
- **Halaman depan:** hero tipografi, contoh sebelum/sesudah tepat di bawahnya dengan satu animasi
  CSS (jendela 9:16, penanda 8:09, panah, klip), dua jalur cara kerja, galeri render gaya
  subtitle asli, tata letak, showcase panel Hasil dan editor. Login memakai poster klip asli.
  `public/landing/editor.webp` diambil ulang dari editor sungguhan dengan tata letak baru (job
  contoh dari `sesudah.mp4`, dibuat `scripts/editor_fixture/landing_demo.py`; prosedur di
  `docs/design/LANDING.md` langkah 6). `docs/design/LANDING.md` diperbarui.
- **Editor (Mode Lengkap):** rel alat kiri (`<nav aria-label="Alat editor">`), pratinjau tengah,
  panel di kanan, timeline bawah; DOM rel → panel → pratinjau. Mode Cepat tetap. Tooltip di
  tombol Cepat/Lengkap. `docs/editor/CONTRACTS.md` dan `PANDUAN-EDITOR.md` diperbarui.

**Validasi yang sudah jalan (lokal, ringan)**
- 46 file tes node yang terkait perubahan (`node --test tests/<file>.test.mjs …`): 697 lulus,
  0 gagal. Tes struktur lama yang mengunci header atas dan lipatan tunggal diganti dengan
  pemeriksaan setara untuk sidebar dan lipatan baru (lihat diff `web/tests/`).
- Parse JSX/JS semua file yang berubah dengan SWC bawaan Next: 38 file OK.
- Kontras pasangan warna baru dengan `contrast-check.py`: teks ≥ 7,04:1, tepi kontrol ≥ 3,29:1.
- Pratinjau terisolasi (`next dev` di port lain, data sementara di luar repo, prioritas rendah,
  editor memakai fakes) + 22 cek klik otomatis: semua lulus (laci, Escape, skip link, lipatan,
  validasi, satu item aktif di sidebar, tanpa overflow di 390 px, susunan editor). Satu-satunya
  error konsol: `/api/storage/status` 503 karena penyimpanan tidak dikonfigurasi di pratinjau.
- `editor.webp` baru: editor mode nyata (bukan fakes) di Google Chrome 1440 × 900 pada job contoh;
  status "Sesuai hasil akhir", playhead 00:02,0, rel x 0 / pratinjau x 84 / panel x 1120, area
  pratinjau tidak kosong (simpangan luminans 47), tanpa error konsol atau respons gagal; WebP
  68 KB. `tests/landing-media`, `entry-pages`, `landing-preview`: 26 lulus. `ruff check` untuk
  `landing_demo.py`: bersih; skrip itu menghasilkan job yang sama (seed, kata, peaks, dokumen;
  hanya waktu audit yang beda).
- Spec editor yang lain diperiksa untuk anggapan "rel di dalam panel" atau "panel di kiri
  pratinjau": tidak ada selector atau ukuran lain yang terdampak (rel → panel tetap berurutan di
  DOM, ukuran yang diuji relatif ke panel atau pratinjau). Hanya komentar di
  `e2e/editor-lengkap.spec.mjs` yang diperbarui.
- Koreksi pemilik: label dan kontrol Jumlah klip–Rasio disejajarkan dengan jarak label 6 px
  dan tinggi kontrol 56 px. Pengukuran browser di lebar 768, 1024, 1280 dan 1440 px menunjukkan
  posisi atas dan tinggi yang sama; di 390 px tersusun vertikal tanpa overflow.
- Cek tambahan di preview lokal yang tetap berjalan: dashboard, Pengaturan, Bantuan, Riwayat
  dan Tren HTTP 200 tanpa galat JavaScript atau overflow di desktop/ponsel; penyimpanan
  terkonfigurasi dan HTTP 200. Editor job demo juga HTTP 200, siap, menampilkan frame video
  dan status "Sesuai hasil akhir" tanpa galat JavaScript. Ini pemeriksaan ringan, bukan suite
  browser penuh atau uji render ekspor.

**Pemeriksaan berat di GitHub Actions** (rencana saat branch dibuat; PR #30 lolos check wajib
"Test and build", parity smoke dan penjaga toolchain sebelum merge)
- CI PR (`ci-cd.yml`, check wajib "Test and build"): gitleaks atas seluruh riwayat, ruff dan
  pytest, `npm test`, `npm run build`, validasi image produksi, penjaga toolchain dan parity smoke.
- Gerbang browser: `editor-gates.yml` `suite=e2e` di HEAD branch, dengan spec yang diubah atau
  ditambah (`app-shell` baru, `dashboard`, `focus`, `header-badge`, `cancel-job`, `bantuan`,
  `editor-shell` dengan gerbang tata letak rel 84 px kiri dan panel di kanan pratinjau,
  `editor-lengkap`, `editor-views`) plus `smoke` dan `read-only`.

**Menjalankan lengkap di lokal (2026-10-22)**
- Gejala di pratinjau lokal: "Layanan pembuatan job sementara tidak tersedia" (503
  `job_service_unavailable`). Penyebab: proses web hanya mendapat `JOBS_STORAGE_*`, padahal
  `POST /api/jobs` juga butuh `MAX_UPLOAD_BYTES` dan `PRIMARY_MAX_ACTIVE_JOBS`,
  `PRIMARY_WORKER_CONCURRENCY`, `PRIMARY_MAX_ATTEMPTS`, `PRIMARY_LEASE_MS` (README "Run locally");
  primary worker dan render worker juga tidak jalan. Skrip startnya membuat `APP_SESSION_SECRET`
  baru setiap start, jadi login dan key AI di Pengaturan hilang tiap restart. Bukan bug di repo.
- Perbaikan di luar repo: runner lokal menjalankan web, primary worker (1 job sekaligus) dan render
  worker dengan satu lingkungan seperti `compose.yaml`, rahasia sesi yang tetap, log privat dan PID
  milik sendiri. `resources/toolchain.json` lokal dibuat (gitignored, PANDUAN-EDITOR §4 langkah 2).
- Smoke: unggahan 11 detik + `.srt` lewat API biasa: job diambil primary worker, selesai, klip
  edit-v2 720 × 1280; satu ekspor editor selesai lewat render worker.
- Ekstra dari lockfile dipasang (`uv sync --frozen --inexact --extra transcribe --extra vision
  --extra web`, tanpa menghapus paket atau mengubah lock): faster-whisper 1.2.1, yt-dlp
  2026.08.19, opencv-python-headless 4.14. Model Whisper `small` (bawaan `WHISPER_MODEL`) sudah
  di cache. Dicek: semua import, `yt-dlp --version`, model `small` termuat offline, YuNet (model
  di `resources/models/`, sha256 cocok) menemukan wajah di frame klip contoh. Belum dicek: akurasi
  transkripsi (tidak ada contoh suara di repo; klip contoh tanpa audio) dan unduhan YouTube
  sungguhan (butuh internet, bisa terkena cek bot).

**Catatan untuk pemilik**
- Tata letak editor berubah sebelum uji U1–U8 (§4): uji dengan stopwatch sebaiknya memakai tata
  letak yang akan dirilis.
- Buat klip di sidebar sengaja tombol netral, bukan lime: lime tetap satu aksi utama per layar.

## 10. Rombak 2026-10-24: status

Rencana lengkap: `docs/plans/2026-10-24-rombak/` (PR #31, branch `docs/rombak-spec`). Mulai dari
`00-README.md`; urutan fase, kriteria terima dan gate ada di `08-fase-test-deploy.md`; tiap topik
punya dokumen pemilik yang menang bila berbeda. `lampiran/` hanya catatan sejarah.

**Keputusan pemilik:** Q1, Q2 dan Q9 final (Q9 = opsi (b): `en` dirilis bersama editor di
Fase 11). Q8 format jam = 24 jam di semua bahasa (default, bisa diubah). Q3–Q7 dan Q10–Q12
memakai default sampai tenggatnya (08 §7).

**Keputusan pemilik 2026-10-25** ("setuju semua"):
- Penyimpangan `fairnessKey` di `job.json`, bukan di request render (01 §6.2, CONTRACTS §5.59):
  disetujui.
- Ambang performa Q11 memakai default (20 posting/14 hari, n ≥ 5 per grup, batas +0,2, gabungan
  0,4).
- Data YouTube untuk profil performa: kebijakan YouTube melarang metrik turunan dari data API
  (`docs/operations/SOSMED.md` §1). Profil memakai CSV ekspor YouTube Studio; metrik turunan dari
  data API baru dipakai bila izinnya didapat di audit YouTube (diputuskan atas delegasi pemilik).
- TikTok tetap dicoba lewat audit, dengan risiko penolakan "menyalin konten dari platform lain"
  dicatat di `SOSMED.md`.
- Node 24 (PR #36) di-merge setelah disk produksi diukur (`docs/editor/OPERASIONAL.md` §3).

**G0 (gerbang sebelum Fase 0):**
- [x] Redesign UX di `main` (PR #30).
- [x] PR amandemen G0 disetujui pemilik (2026-10-25): `DESIGN.md` (pola sasaran per fase, kata status, bagian
  Bahasa), `AGENTS.md` (copy dari katalog, clean-room, migrasi aditif, guard auth sinkron, suite
  `editor-gates`), `docs/glosarium.md` (baru), dan dokumen ini.
- [ ] Pemilik mendaftarkan app Google (YouTube Data API), TikTok dan Meta dalam mode testing;
  tanggal tiketnya dicatat di `docs/operations/SOSMED.md` saat Fase 0.
- [ ] Pemilik memilih domain HTTPS publik dan email kontak publik (tidak ditulis di repo).

**Fase 0** (runtime Node 24, kontrak CONTRACTS §5.59–§5.65, pengukuran): rinci di 08 §4. Bukti
toolchain baru dibuat lewat `gh workflow run ci-cd.yml --ref <branch> -f suite=toolchain`, lalu
`docs/editor/evidence/toolchain/record.json` yang bercap di-commit.

**Fase 1** (fondasi UI + i18n + shell + pemilih bahasa; status 2026-10-25). Permintaan pemilik:
satu PR gabungan per fase, tes berat sekali di akhir fase.
- Sudah di `main`: Dashboard F0 (#41: `ui.css`, HeroUI di atas token, `PublicCard`, `Providers`)
  dan i18n M0 (#43: katalog `web/messages/{id,en}`, resolusi locale, `generateMetadata`, HTML
  `private, no-store`, `POTONGIN_LOCALES`, catatan cache HTML di `deploy/VM_NGINX_CLOUDFLARE.md`).
- Di PR #44 (branch `feat/f1-shell`, belum di-merge):
  - Dashboard F1: `NavList` datar, Drawer di bawah 1024 px, menu akun, Keluar lewat form
    tersembunyi, saklar "Pintasan satu tombol" (cookie `potongin_shortcuts`).
  - i18n M1: `POST /api/locale` (publik, dikecualikan dari `proxy.js`, origin + 20/menit per IP
    + body ≤ 1 KiB, form → 303, `?bahasa=gagal` bila ditolak); pemilih bahasa di menu akun (2 klik,
    muat ulang penuh) dan di `/login` (form native, jalan tanpa JS); `/login` jadi satu kartu
    `PublicCard` dengan field HeroUI (nama field sama); 404 dan halaman error dari katalog; tes
    baru `locale-route`, `route-guard-coverage` (allowlist awal beralasan), `measure-ttfb`;
    ratchet `i18n-hardcoded` = 0 untuk `AppShell`, login, not-found, error.
  - Pemilih bahasa hanya tampil bila `POTONGIN_LOCALES` memuat lebih dari satu bahasa; produksi
    tetap `id`, jadi pengguna produksi tidak melihat perubahan bahasa sampai pemilik
    menyalakannya.
  - CI: push ke `main` yang hanya mengubah dokumentasi (`docs/**`, `*.md` di luar `src/`,
    `resources/`, `web/`) melewati build image, parity dan deploy; `Test and build` tetap jalan
    (`scripts/ci/deploy_scope.py`, ragu = deploy).
- Gerbang akhir fase sudah jalan di GitHub Actions (run dan angka di badan PR #44): `ci-cd.yml`,
  `editor-gates.yml` `full`, `image`, `player`, e2e `desktop-chromium`, `mobile-chromium` dan
  `en-smoke`, screenshot shell. `-f ttfb=true` (suite e2e, sekali `-f ref=main`, sekali
  `-f ref=feat/f1-shell`) mencatat TTFB `/`, `/dashboard`, `/login` di `ttfb.json` dan CSS/JS
  rute editor di `editor-assets.json` (`web/scripts/measure-route-assets.mjs`): CSS editor
  identik (digest sama), JS awal rute editor naik 4.218 B (1.685 B gzip), di bawah use-intl
  11.814 B (5.484 B gzip). Celah: e2e `smoke` dan `read-only` butuh proyek selesai yang tidak ada
  di app gerbang (gagal sama di `main`).
- Untuk pemilik: review copy `en` baru (`web/messages/en/auth.json`, `common.json`,
  `shell.json` `account.language`); izin merge PR #44; pilihan menyalakan `id,en` di produksi
  sebagai pratinjau (boleh sampai undangan anggota pertama di Fase 6).
- Diputuskan atas delegasi pemilik (rinci di badan PR #44): pesan batas login tetap kalimat lama
  (`auth.login.limited`, bukan `errors.web.rate_limited` yang generik); halaman error tidak
  menampilkan `digest`; teks 404/error ada di `common.page` (subtree inti `errors` tetap `web` +
  `http`); tautan "Buka Riwayat" menjadi "Buka Proyek" mengikuti nama baru di navigasi; menu akun
  tidak memberi tanda bila ganti bahasa ditolak (hanya terjadi saat batas 20/menit habis).

**Fase 2 + 3** (dashboard baru: Buat klip, halaman proyek, Proyek, Pengaturan, Tren, Bantuan;
kode error dan progres; status 2026-10-25). Satu PR gabungan: #47, branch `fase/2-3`, belum
di-merge, menunggu izin merge pemilik.
- Gerbang akhir hijau di `e2441041` (run dan angka di badan PR #47 dan komentar
  issuecomment-6399516092): CI/CD PR, `full`, e2e dashboard/proyek/pengaturan/tren/bantuan,
  `settings-tabs` 8×, `landing-shots`; di `2fe693ee` (sesudahnya hanya file tes web): `image`,
  `player`, semua `editor-*` + `parity-text`, en-smoke, mobile dan desktop dengan proyek semaian.
  Gold seleksi (7 episode, K=5 dan K=10, selector heuristik) identik dengan `main`, dijalankan
  lokal karena transkrip gold tidak ada di runner.
- Kriteria 08 Fase 2 dan Fase 3 terpenuhi, kecuali: ratchet `i18n-hardcoded` = 0 untuk semua file
  rute dashboard, tapi lima modul view (`project-view`, `clip-entry-view`, `clip-text`,
  `llm-presets`, `source-language`) masih di baseline (lihat "Belum selesai" di bawah); satu tes
  kontrak sengaja diubah (`CLIP_KEYS`, field tambahan).
- Tanpa flag env baru dan tanpa migrasi. Rollback: image sebelumnya (semua aditif; job yang
  ditulis image baru hanya punya field tambahan).
- Diputuskan atas delegasi pemilik (alasan singkat di sini, rinci di commit masing-masing):
  - Satu `stageText(t, job)` (`web/lib/i18n/stage.mjs`) untuk baris tahap di semua halaman:
    `stage.<stageCode>` bila ada, kalau tidak `stageDetail` lama apa adanya.
  - Pemetaan langkah stepper proyek: Unduh, Transkrip, Pilih momen, Render (empat langkah,
    `web/lib/project-progress.mjs`), dari tahap mesin yang ada.
  - "Kenapa dipilih" tidak menampilkan kode `llm_rerank` (skor peringkat ulang LLM): itu catatan
    metode, tetap di artefak.
  - Baseline ratchet `i18n-hardcoded` saat menggabung sub-track: diambil angka terkecil per file
    (min-merge), lalu dikunci turun.
  - Hasil hapus proyek diberitahukan lewat toast saja, tanpa baris status di halaman.
  - Label "Diedit" dipakai bersama sebagai `common.edited`.
  - Skor klip memakai `role="meter"` biasa, bukan komponen Meter HeroUI (axe membaca
    `role="meter progressbar"` HeroUI sebagai peran tak dikenal).
  - Tab Pengaturan yang tidak aktif disembunyikan lewat CSS `[data-inert]` dan tetap terpasang,
    bukan dilepas dari DOM.
  - Escape menutup AlertDialog di Tren.
  - Toast duduk di atas bar Simpan Pengaturan (offset), supaya tidak menutupi tombol.
  - Padding composer Buat klip 12 px.
  - `ranking.py` dan `features.py` tidak menulis `reason_codes`/`warning_codes` sendiri; alasan
    dipecah sesudahnya dari template di `src/ai_clipper/reason_codes.py`. Gold terurai penuh (401
    alasan, tanpa jatuh ke kode `text`). Risiko: template baru di `ranking.py`/`features.py` tanpa
    pola di `reason_codes.py` akan tampil sebagai teks apa adanya (prosa mesin, Indonesia) sampai
    polanya ditambah.
  - Satu-satunya tes kontrak lama yang diubah dengan sengaja: `tests/test_pipeline_v3.py`
    `CLIP_KEYS` mendapat `reason_codes` (manifest hanya bertambah field). Tidak ada asersi route yang
    diubah atau dihapus; perubahan di file tes route hanya asersi sumber halaman dan view.
  - Review 2026-10-25: modul view Buat klip dan proyek (`dashboard-view`, `dashboard-choices`,
    `selection-v3-view`, `trend-view`) kini mengembalikan deskriptor katalog dan ratchet-nya 0;
    tes view membandingkan teks Indonesia lewat katalog asli (`textsOf`). Pesan masalah form Buat
    klip di tes kini label katalog yang memang tampil di layar. Teks unduhan dan penyimpanan
    punya satu sumber (katalog); `legacyMessage()` (`web/lib/i18n/legacy.mjs`) mengisi
    `stageDetail` worker. Entri Bantuan unduhan/penyimpanan tidak lagi membawa teks sendiri (sama
    seperti entri AI); indeks pencarian halaman Bantuan membaca katalog. Notice "Buka Konteks Tren"
    menjadi "Buka Tren". `/licenses` dari katalog (`help.licenses.*`), kepala halaman tanpa kalimat.
  - Gerbang read-only produksi diuji pada proyek selesai yang disemai di CI
    (`web/scripts/seed-e2e-project.mjs`, `editor-gates.yml -f seed=true`): `read-only` dan
    `smoke` lulus di desktop, mobile dan en-smoke (run 40202796408, 40202804203, 40202802047).
    `hasil.webp` landing diambil ulang dari proyek itu (penampil klip, 1400 × 860,
    `e2e/landing-shots.spec.mjs`, run 40203327967); daftar klip editor di-fake di spec itu supaya
    tampak seperti proyek metode sekarang (Edit klip ada). `editor.webp` dibiarkan: isinya editor
    yang dikirim sekarang (Mode Lengkap pada klip sungguhan), editor baru datang di Fase 10–11, dan
    editor fakes tidak punya video untuk pratinjau.
  - Penampil klip di desktop melebar sampai 980 px: ukuran `lg` Modal HeroUI membatasi dialog di
    32rem, sehingga judul menjadi satu kolom huruf (terlihat di tangkapan CI).
- Belum selesai, perlu keputusan atau penundaan eksplisit dari pemilik:
  - Peta pesan sisi server yang masih menulis teks Indonesia sendiri untuk field `error`
    (`clip-text-api`, `clips-zip`, `transcription-settings`, `llm-settings-actions`, `clip-edit`)
    belum diganti `legacyMessage()`; teksnya lebih rinci dari katalog (mis. ukuran ZIP), jadi
    menggantinya mengurangi detail di `id` sampai katalog punya parameter.
  - Pembaca klien `body.error` yang tersisa di luar editor: `lib/clip-text.mjs` (Simpan, Tulis
    ulang), `checkZip` di `lib/project-workspace.mjs`, kode `invalid` di
    `TranscriptionCard`/`transcription-settings-view`: di `en` masih bisa tampil teks server
    Indonesia. Editor (`editor/commands`, `editor-ai`) di luar cakupan "UI en lengkap kecuali
    editor".
  - Modul view yang belum disentuh dan masih Indonesia di `en`: `lib/project-view.mjs`
    (`projectName`, `clipLabel`, mis. "Klip 03"), `lib/clip-entry-view.mjs` (alasan klip tidak
    bisa diedit, label ekspor), `lib/clip-text.mjs` (masalah form judul),
    `lib/source-language.mjs` (notice bahasa video), `lib/stage-summary.mjs`; `app/licenses/notices.mjs`
    (keterangan pemakaian paket) sengaja tetap seperti diterbitkan.
- Untuk pemilik: izin merge PR #47; review copy `en` baru (`web/messages/en/*.json` namespace
  `dashboard`, `project`, `projects`, `settings`, `trends`, `help`, `errors`, `hints`, `stage`,
  `reason`, `landing`, `layout`, `shell` `badge`);
  apakah transkrip gold (`artifacts/eval`) perlu tersedia di CI supaya cek gold tidak hanya lokal
  (08 §11 butir 5).

Sampai fase yang bersangkutan selesai, UI tetap seperti di `main`; `DESIGN.md` menandai setiap
pola sasaran dengan fase mulai berlakunya.
