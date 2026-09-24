# Editor V3 Esensial: rencana implementasi

Tanggal: 2026-09-24. Status: rencana siap dieksekusi, revisi 2 (setelah kritik adversarial);
belum ada kode Editor V3.
Keputusan pemilik yang dijalankan: **"Esensial dulu, lalu bertahap."** Editor V3 Esensial dibangun
dengan kualitas penuh (tidak ada fitur setengah jadi). Multi-track ala CapCut menyusul di sesi
berikutnya (Tahap 2/3 desain besar).

**Perubahan revisi 2** (rincian di `docs/plans/editor-v3-research/editor-essentials-critique.md`):

- **Klaim pratinjau dipersempit.**
  - "Identik" berarti raster teks yang sama sebelum encode (P-TXT).
  - MP4 akhir menambah kompresi H.264/4:2:0 dan diuji terpisah (gerbang baru **P-ENC**).
  - Lencana menjadi "● Sesuai hasil akhir".
- **Revisi 0 selalu file otomatis.** Aturan identitas konten R10: dokumen yang isinya sama dengan
  seed diekspor sebagai file klip otomatis. Toolchain Docker dipin (`toolchain.json`).
- **Musik tidak pernah clipping.** True peak ≤ −1 dBTP (gerbang G3b). Pratinjau audio 48 kHz.
- **Rahasia server dan AI.**
  - Proses anak memakai env allowlist.
  - Saran AI memakai pengaturan LLM yang disimpan (`loadLlmEnv`).
- **Ruang lingkup dipangkas (§1.3).** Ditunda: ekspor 1080×1920/Tinggi, sesi server-side + CSP
  nonce, pemanasan plate, G4, dan snap ke akhir tawa.
- **Gelombang.**
  - T1.2 dipecah, antrean render v3 pindah ke W2, scaffolding UI dibuat sebelum tiap gelombang.
  - Ada workflow cadangan W5.
  - Pemilik cukup hadir di 3 titik cek.
- **Rapikan** tidak menandai reduplikasi ("hati hati") sebagai gagap.
- **Job lama.** Seed dipersist saat *prepare*, dan setiap alasan klip tidak bisa dibuka diberi
  nama.

Sumber yang dipakai (semuanya dibaca untuk rencana ini):

| Singkatan | Dokumen |
|---|---|
| **FINAL** | `docs/plans/editor-v3-research/FINAL-editor-design.md` (sintesis arsitek, basis parity-first) |
| **R1** | `docs/plans/editor-v3-research/r1-existing-editor.md` (audit editor lama) |
| **R2**, **R3** | `docs/plans/editor-v3-research/r2-feature-inventory.md` (inventaris fitur); `docs/plans/editor-v3-research/r3-tech.md` (riset teknologi pratinjau = render; artefak `lab/` dari sesi riset tidak disimpan) |
| **INC**, **PF**, **UX** | `docs/plans/editor-v3-research/proposal-incremental.md` (sel *plate*, pengukuran E1–E6), `docs/plans/editor-v3-research/proposal-parity-first.md` (`spike-pf/` tidak disimpan), `docs/plans/editor-v3-research/proposal-ux-first.md` (pengukuran M1–M6) |
| **V3** | `docs/plans/2026-09-24-selection-v3-llm-hooks.md`, termasuk bagian "As implemented" |
| **[REPO]** | kode di `feat/selection-v3-llm`, dibaca 2026-09-24 |
| **[E]** | perkiraan; gerbang yang disebut harus mengonfirmasinya sebelum ada yang bergantung padanya |

Bahasa: judul dan ringkasan dalam Bahasa Indonesia; detail teknis dalam bahasa Inggris supaya
langsung bisa dipakai agen.

---

## 0. Ringkasan untuk pemilik

1. **Yang dibangun.** Editor untuk setiap klip V3. Isinya 13 kemampuan: buka klip, trim yang
   menempel ke kata, cold open, teks hook plus saran AI, edit caption dengan 4 preset, potong lewat
   transkrip, ganti tata letak, logo, musik dengan ducking, waveform dan penanda, perbaikan 8 bug
   editor lama, undo/autosave, dan ekspor lewat antrean render yang sudah ada.
2. **Satu mesin render.** Klip otomatis dan hasil editor dirender oleh **kompiler Python yang
   sama**. Kompiler itu memakai ulang `captions_ass.py` dan `subtitles.py` dan menjalankan FFmpeg.
   Karena itu "revisi 0" di editor *adalah* klip otomatis: ekspor tanpa perubahan **selalu**
   mengembalikan file klip otomatis itu sendiri, juga setelah image Docker diperbarui (aturan
   R10).
3. **Pratinjau yang jujur.**
   - Caption dan hook digambar di browser oleh libass (JASSUB) dari **byte ASS yang sama**
     dengan yang dibakar server. Raster teksnya identik dengan komposit server sebelum encode
     (gerbang P-TXT).
   - MP4 akhir menambah kompresi H.264 dan subsampling warna 4:2:0. Tepi teks berwarna jadi
     sedikit lebih lembut. Ini diukur terpisah (P-ENC). Tombol "Frame akhir" selalu menunjukkan
     piksel persisnya.
   - Semua piksel lain berasal dari server: video bertata letak ("sel plate"), audio campuran,
     logo yang sudah diskalakan, dan "frame akhir".
   - **Piksel perkiraan tidak pernah ditampilkan.** Selama sesuatu belum siap, editor menahan frame
     terakhir yang tepat dan menulis "Memperbarui…".
4. **Lebih sederhana dari desain besar.** Tidak ada mesin WebGL2 dan tidak ada resolver JavaScript
   kedua pada tahap ini. Python satu-satunya "otak", dan browser hanya menampilkan. Kerjanya jauh
   lebih kecil, tetapi dokumen edit dibuat sama bentuknya dengan desain besar, jadi Tahap 2
   (multi-track) tidak perlu migrasi.
5. **Cara kerja.**
   - Ada 4 gelombang (workflow), masing-masing paling banyak 8 agen, total 30 agen.
   - Ada satu workflow cadangan (W5, ≤ 4 agen) yang hanya dijalankan bila gerbang keluar
     gagal. Jadi totalnya paling banyak 5 workflow.
   - Setiap agen memiliki file yang tidak disentuh agen lain di gelombang yang sama.
   - Tes ditulis dulu (TDD), dan setiap gelombang punya gerbang berangka yang harus hijau.
   - Bila cadangan pun tidak cukup, Anda memilih satu butir utuh untuk ditunda di balik flag.
     Tidak ada fitur setengah jadi.
6. **Yang perlu Anda putuskan** ada di §12: 15 butir, masing-masing dengan rekomendasi (2 di
   antaranya kini ditunda). Anda cukup hadir di 3 titik cek (§11.0). Yang terpenting: klip
   otomatis V3 pindah ke mesin baru, yang membawa perubahan tampilan kecil (frame rate tetap,
   audio 48 kHz, warna caption tepat). Anda menyetujuinya setelah melihat 20 klip berdampingan.

### 0.1 Istilah

| Istilah | Arti |
|---|---|
| **Heuristik** | **Aturan praktis yang ditulis tangan oleh programmer, tanpa AI dan tanpa internet.** Contoh di editor ini: "jadikan kalimat tanya pertama sebagai hook", "kata *eh*, *em*, *hmm* adalah kata pengisi", "jeda lebih dari 0,6 detik yang minimal 80% hening boleh dipendekkan". Kelebihannya: instan (≤ 0,3 detik), gratis, selalu tersedia, dan hasilnya sama setiap kali. Kekurangannya: tidak "memahami" isi pembicaraan seperti LLM, jadi kurang kreatif. Karena itu editor **selalu menampilkan saran heuristik lebih dulu**, lalu saran LLM menyusul kalau kuota dan koneksi tersedia. |
| **LLM** | Model bahasa (AI) yang dipanggil lewat `src/ai_clipper/llm.py`, dengan provider gratis lebih dulu. |
| **Revisi 0** | Dokumen edit yang menggambarkan klip otomatis persis seperti yang dirender pipeline. Belum ada perubahan pengguna. |
| **Sel plate** | Potongan video 2 detik *tanpa teks* yang sudah diberi tata letak (fit-blur, face-track atau center-crop), dirender server dengan graf FFmpeg yang sama dengan render akhir. |
| **Frame akhir** (*truth frame*) | Satu frame yang dirender server dengan graf render akhir, untuk dicek kapan saja. |
| **Jump cut** | Potongan di tengah klip (kata atau jeda dihapus), disambung tanpa jeda. |
| **Ducking** | Musik latar otomatis dikecilkan saat ada orang bicara. |
| **Gerbang** (*gate*) | Uji otomatis berangka yang harus lulus sebelum fitur boleh dinyalakan. |
| **SSIM / PSNR** | Ukuran kemiripan dua gambar (SSIM 1,0 = identik; PSNR makin tinggi makin mirip). |
| `_sf`, `_f`, `_ms`, `_e5`, `_cdb`, `_pm` | Satuan integer di dokumen (§3.1). |

---

## 1. Ruang lingkup

### 1.1 Termasuk (Esensial) dan yang ditunda

| # | Kemampuan (keputusan pemilik) | Termasuk di Esensial | Ditunda (tahap desain besar) |
|---|---|---|---|
| 1 | Buka klip V3 mana pun | `clip_id` stabil; daftar klip per job; revisi 0 virtual = klip otomatis (kompiler sama; ekspor tanpa perubahan isi = file klip otomatis itu sendiri, aturan R10); job lama yang dirender mesin lama bisa dibuka dengan pemberitahuan jujur, dan seed-nya dipersist saat *prepare*; klip yang tidak bisa dibuka menampilkan alasannya (`source_missing`, `selection_unreadable`, `transcript_missing`, `analysis_incomplete`, `not_v3`) | Re-anchoring setelah transkrip berubah (untuk sekarang: mode baca-saja plus "mulai dari versi AI"); backfill job yang analisisnya tersangkut di `.attempts/` (Tahap 2 / ROADMAP §7) |
| 2 | Trim yang menempel ke kata | Pegangan awal/akhir di timeline dan "Mulai/Akhiri di sini" di transkrip; titik potong dari tabel *bounds* server (titik paling hening di celah, dibulatkan ke frame di dalam celah); dalam jendela analisis ±60 s | Trim bebas dengan Alt; perluas di luar jendela (Tahap 2, "Perluas konteks") |
| 3 | Cold open | Nyala/mati; pilih kalimat atau seleksi di transkrip; geser tepi ± kata; aturan 0,5–8,0 s; saran heuristik (pilihan V3 + 3 kandidat); sambungan *cut* dengan fade audio 30 ms | Sambungan flash/dip; rerank cold open dengan LLM (Tahap 2) |
| 4 | Teks hook + saran AI | Edit teks (≤ 90 karakter), durasi, posisi vertikal, nyala/mati; indikator "muat / akan terpotong"; saran heuristik instan plus saran LLM async dengan grounding | 9 desain hook, label pill, kata penekanan di hook (Tahap 2) |
| 5 | Edit caption + 4 preset | Perbaiki teks kata, sembunyikan kata, tandai kata kunci (warna penekanan); preset **Klasik, Karaoke, Bold, Box** plus posisi, ukuran, huruf besar, dan warna sorot; pratinjau = libass yang sama, byte ASS yang sama | 8 paket LokaClip + 8 animasi, pisah/gabung cue manual, retime kata, emoji, cari & ganti lintas klip, saran kata kunci AI (Tahap 2) |
| 6 | Potong lewat transkrip | Hapus kata atau kalimat → jump cut dengan micro-fade 8 ms; chip pulihkan; daftar tinjau "Rapikan" (kata pengisi, pengulangan gagap, jeda hening panjang); partikel (*sih, dong, kok, lho, mah, …*) **tidak pernah** masuk daftar; reduplikasi (*hati hati, pelan pelan*) tidak dianggap gagap; jeda di sekitar tawa dikunci | "Padatkan ke N detik" (LLM condense); pemendekan jeda bersuara otomatis (Tahap 2) |
| 7 | Ganti tata letak | fit-blur, face-track, center-crop untuk seluruh klip; rentang tanpa wajah dilaporkan di "Perlu dicek" | Layout per rentang, split 2 pembicara, reframe manual, *smart speaker* YuNet/ASD (Tahap 2) |
| 8 | Logo/watermark | Unggah PNG/JPEG/WebP → PNG ternormalisasi; seret atau 4 preset sudut; ukuran; opasitas; sepanjang klip | Brand kit dan logo lintas job, stiker, emoji, gambar B-roll (Tahap 2); animasi (Tahap 3) |
| 9 | Musik + ducking | Unggah MP3/M4A/WAV/OGG/FLAC → AAC 48 kHz; volume; titik mulai; loop; fade in/out; ducking (kedalaman, attack, release, hold; detektor = kata yang tersisa); volume suara sumber; normalisasi −14 LUFS opsional; **perlindungan puncak selalu aktif** (true peak ≤ −1 dBTP bila ada musik atau gain > 0) | Perpustakaan musik/SFX, banyak trek audio, pembersihan audio (Tahap 2/3) |
| 10 | Waveform + penanda | Waveform suara per potongan dan waveform musik; penanda tawa (tag caption YouTube + token transkrip "haha/wkwk"), jeda hening ≥ 0,6 s, potongan kamera (data `audio_timeline.scene_cuts` yang sudah ada); klik untuk lompat; job tanpa data penanda menampilkan "tidak tersedia untuk job ini" | Deteksi tawa dari audio (klasifier); snap trim ke akhir tawa (Tahap 2) |
| 11 | Perbaiki 8 bug editor lama | Kedelapannya mustahil terjadi di Editor V3 (by construction), masing-masing dengan tes regresi. Editor lama mendapat 6 perbaikan sisi server (bug 1, 2, 3, 4, 7, 8) plus tombol "Buka di Editor V3" untuk bug 5 dan 6 (§8). Selisih pratinjau editor lama (R1 P1–P3, P15) tidak diperbaiki di sana; pratinjaunya diberi label "Pratinjau perkiraan" | Migrasi penuh manifest V1 ke dokumen V2 (Tahap 2) |
| 12 | Undo/redo, autosave, konflik | 200 langkah (seret digabung jadi satu), autosave 1,5 s, draf IndexedDB, peringatan tab ganda, rebase saat 409 plus dialog per bagian, "Kembali ke versi AI" | Riwayat revisi, checkpoint, bandingkan A/B (Tahap 2) |
| 13 | Render akhir lewat antrean | `render-request-v3`; kunci render (render ulang instan bila tidak berubah); tahap progres; batal; verifikasi G1–G3, G3b, G5; MP4 + SRT; ukuran dan kualitas **sama dengan klip otomatis** (720×1280, Standar) | Ekspor 1080×1920 dan kualitas "Tinggi" (ditunda, K14); ekspor massal, cover frame, multi-aspek (Tahap 2) |

### 1.2 Di luar Esensial (tetap mengikuti FINAL §10.2–10.3)

- **Tahap 2 (Mode Pro):**
  - timeline multi-track, B-roll, stiker/emoji, teks bebas, sisip/urut ulang segmen;
  - kecepatan/freeze, multi-aspek, template, brand kit, terapkan ke semua klip, SFX;
  - caption packs P1–P8 dan 9 desain hook;
  - kompositor WebGL2 plus resolver JS `edit-core` (pratinjau native tanpa round trip server);
  - pratinjau langsung di Firefox/Safari, ekspor massal, pensiun editor V2, migrasi V1;
  - editor judul, deskripsi dan hashtag (di Esensial: baca-saja dengan tombol salin).
- **Tahap 3:** keyframe, transisi, efek/LUT, mask, pembersihan audio, animasi teks pack 2, render
  paralel per segmen.

### 1.3 Dipangkas dari revisi 1 (tidak ada di daftar pemilik; hasil kritik)

| Dipangkas | Keputusan | Alasan |
|---|---|---|
| Ekspor 1080×1920 dan kualitas "Tinggi" (K14) | Ditunda ke Tahap 2 | Menggandakan kerja logo turunan, frame akhir dan P-LOGO; sumber 720p tidak menjadi lebih tajam |
| Sesi server-side yang bisa dicabut (K10), CSP dengan nonce, font UI self-hosted | Ditunda ke Tahap 2 | Tidak ada di daftar pemilik; unggahan tidak memperluas apa yang bisa dilakukan token curian (sudah bisa menghapus proyek). **Yang tetap:** COOP/COEP di rute editor, `frame-ancestors`/nosniff di rute baru, batas laju, env allowlist untuk proses anak |
| Pemanasan sel plate di pipeline | Dihapus | Fallback `<video>` revisi 0 sudah menutup waktu buka |
| G4 (blackdetect/freezedetect) | Dihapus | Satu decode penuh tambahan per render hanya untuk peringatan |
| G5 dari ink bbox hasil render | Disederhanakan menjadi geometri dari plan | Peringatan sama, biaya nol |
| Arsip "satu per jam selama 7 hari" | Disederhanakan: revisi 1 + yang dirujuk render + 50 terbaru | Janitor lebih sederhana |
| Pratinjau baca-saja di bawah 1024 px | Disederhanakan menjadi pemberitahuan | Di luar lingkup |
| Snap trim ke akhir tawa | Ditunda | Bertentangan dengan aturan "nilai tersimpan selalu frame `bounds`" |

---

## 2. Arsitektur

### 2.1 Keputusan arsitektur Esensial

| ID | Keputusan | Alasan dan bukti |
|---|---|---|
| **E1** | **Satu resolver/kompiler: Python stdlib** di `src/ai_clipper/edit_v2/`. `captions_ass.py` dan `subtitles.py` tetap satu-satunya pembuat ASS dan cue. Pipeline (render otomatis), jalur pratinjau, dan render-worker memanggil kode yang sama. Tidak ada resolver JS dan tidak ada Node di jalur render. | Hari ini ada dua pembuat ASS dan dua layout builder, dan editor lama tidak cocok dengan keduanya [R1 §7, R3 §2]. Satu implementasi menghapus seluruh kelas bug itu. Jalur render yang ada dipakai ulang, bukan ditulis ulang: string filter tata letak `render.py` (fit-blur, center-crop, face-track) pindah ke `edit_v2/layouts.py` dan hanya ditambah aturan grid; helper publikasi aman dan probe `render.py` diimpor apa adanya; `render_vertical` tetap melayani mode V1/v2-shadow. |
| **E2** | **Render otomatis V3 pindah ke kompiler ini** (flag `POTONGIN_RENDER_ENGINE=edit-v2`). Seed revisi 0 ditulis pipeline sebagai file imutabel. | Revisi 0 = klip otomatis *by construction*; ekspor tanpa edit mengembalikan file yang sama (FINAL D6). |
| **E3** | **Dokumen integer `clip-edit-v2`** (bentuk dan satuan FINAL, subset Esensial). | Autosave murah; tanpa drift float; Tahap 2 cukup menambah kunci opsional. |
| **E4** | **Grid frame kanonik (R1) + waktu ASS "frame-safe".** | Cara seek `render.py` sekarang memilih frame sumber berbeda pada 49,6% frame; aturan grid 0/1.125 [PF]. JASSUB membulatkan sedangkan FFmpeg memotong; aturan centidetik frame-safe 0 gagal di 8 frame rate [PF]. |
| **E5** | **Pratinjau = piksel server + libass di browser.** Tiga lapisan Canvas2D: (1) frame sel plate yang di-decode WebCodecs (Mediabunny), (2) JASSUB dengan byte ASS server pada `nowMs(n)`, (3) PNG logo yang sudah diskalakan server, digambar 1:1. Jam = AudioContext yang memutar **audio campuran dari server**. Frame akhir tersedia kapan saja. | Sel plate = keluaran FFmpeg dari graf yang sama, tidak pernah dibatalkan oleh edit potongan: 0,56 s per sel, SSIM 0,9957 fit-blur [INC-E1]. JASSUB vs libass server: SSIM 0,99980–0,99988, maks 13 [R3]; caption DOM/CSS hanya 0,976–0,990 [R3]. |
| **E6** | **Format komposit teks dipilih oleh spike S-COLOR di W1**, dengan penilaian pada **MP4 yang dikirim**, bukan hanya pada referensi lossless. Kandidat: `yuv420p` (+ perbaikan warna bila perlu), `yuv444p`, dan RGB planar `gbrp`. Yang termurah dan lulus P-COLOR + P-ENC dipakai. `yuv420p` menang bila SSIM daerah teksnya di MP4 akhir berselisih ≤ 0,002 dari yang terbaik. | Terhadap referensi lossless: yuv420p maks 93 level di tepi teks; yuv444p 0,99925 / maks 15; rgb24 0,9998 / maks 13 [PF]. Namun MP4 akhir **selalu** 4:2:0, jadi tepi teks berwarna kehilangan resolusi warna di format mana pun. Keuntungan nyata 444/gbrp adalah **ketepatan warna**: menurut kode FFmpeg 5.1, `drawutils` memakai koefisien BT.601 di format YUV walaupun keluaran diberi tag BT.709. Biayanya +19–40% waktu render. |
| **E7** | **Tahan frame tepat terakhir; jangan pernah menebak.** Setiap lapisan punya status "terkini / basi"; UI menampilkan lencana, bukan piksel perkiraan. | Aturan kualitas pemilik: "jangan menurunkan kualitas". |
| **E8** | **Pakai ulang kekuatan yang ada:** JSON kanonik + ETag sha256, `If-Match`, receipt idempotensi (sekarang digest saja dan dipangkas), `flock`, penulisan atomik, antrean render (lease, heartbeat, publikasi berpagar, reservasi storage). | Sudah diuji: 101 tes Python + 122 tes web; PUT 19 ms in-process, 70–90 ms lewat CLI [R1]. |
| **E9** | **AI hanya menyarankan, pengguna yang memutuskan.** Heuristik selalu tampil lebih dulu. | FINAL D10; LLM gratis berlatensi 3,3–14,7 s [UX-M6]. |
| **E10** | **Toolchain dipin, dan revisi 0 ditentukan oleh isi.** Base image dipin per digest dan paket apt dipin per versi (ffmpeg, libass9, libfreetype6, libharfbuzz0b, libfribidi0, fontconfig). `resources/toolchain.json` ditulis saat build (`dpkg-query`) dan masuk ke kunci render. Dokumen yang isinya sama dengan seed selalu diekspor sebagai file klip otomatis (R10). | Dockerfile sekarang memasang `ffmpeg` tanpa pin di `node:20-bookworm-slim` tanpa digest [REPO]. Satu pembaruan keamanan Debian akan mengubah kunci render dan membuat "ekspor tanpa perubahan" merender ulang ke file yang berbeda. |
| **E11** | **Proses anak tanpa rahasia.** Setiap proses Python/FFmpeg dari container `app` dijalankan lewat `web/lib/python-cli.mjs` dengan env allowlist. Hanya tugas AI yang menerima env LLM, lewat `engineProcessEnv(await loadLlmEnv())`, pola yang sama dengan `run-job.mjs`. | Env `app` berisi `APP_PASSWORD`, `APP_SESSION_SECRET`, `POTONGIN_SETTINGS_SECRET` dan semua `*_API_KEY` [REPO compose.yaml]. `execFile` mewariskannya secara default, termasuk ke FFmpeg yang membaca unggahan tak tepercaya. |

### 2.2 Yang diambil dari FINAL dan yang disederhanakan

| Elemen FINAL | Di Esensial | Alasan |
|---|---|---|
| Dokumen integer `clip-edit-v2` | **Diambil** (subset; nama dan satuan sama) | Kompatibel ke depan |
| Artefak kata `potongin.words/1` | **Diambil**, ditambah tabel snap `bounds` | Snap satu sumber (Python); UI tetap instan |
| Resolver JS `edit-core` + Node di jalur render | **Tidak.** Resolver Python; browser hanya mencerminkan *time map* (±150 baris) yang dicek dengan vektor | Satu implementasi; tanpa harfbuzz dan ajv; tanpa lint determinisme lintas engine |
| Mesin WebGL2 + katalog op | **Tidak.** Canvas2D dengan 3 lapisan | Semua piksel video berasal dari server; tidak ada yang perlu di-shader |
| JASSUB (libass WASM) | **Diambil** | Satu-satunya jalur terukur ke paritas caption |
| Sel plate (INC) | **Diambil** sebagai lapisan video | Tepat *by construction*; tahan edit potongan |
| Bake kelas B | **Tidak perlu** | Tidak ada op Esensial yang membutuhkannya |
| Envelope WebAudio | **Diganti** audio campuran dari server (kelas D) | Sampel identik *by construction*; latensi ≤ 1 s p95 |
| Kamera `sendcmd` | **Tidak.** Ekspresi crop per potongan dari rencana kamera (waktu sumber), cara yang sudah terbukti | Nilai crop hanya bergantung pada waktu sumber, jadi plate dan render akhir sama |
| Blur "plate" menggantikan `gblur` | **Tidak perlu.** `gblur` tetap, sigma diskalakan dengan tinggi | Piksel pratinjau dari server, jadi blur tidak perlu portabel; tampilan tidak berubah |
| Komposit yuv444p | **Diputuskan S-COLOR** (420, 444 atau gbrp; dinilai pada MP4 akhir) | Lihat E6 |
| Style pack P1–P8, 9 desain hook | **4 preset + hook lama** | Ruang lingkup |
| Sentinel SSIM yang menukar frame | **Hanya telemetri** (W4) | Pikselnya sudah dari server |
| Frame akhir, kunci render, G1–G3 + G5, timeout berskala, keamanan unggahan, COOP/COEP | **Diambil** | Memperbaiki D3, D5, D8, D9 dan menutup risiko keamanan |
| G4, sesi bisa dicabut, CSP nonce | **Ditunda** (§1.3) | Di luar daftar pemilik |

### 2.3 Diagram

```
              Pipeline V3 (primary-worker)  —  render otomatis = revisi 0
 transcript.json ─┐
 selection.v3 ────┤  edit_v2.{source_info,words,peaks,camera,seed}
 audio-timeline ──┤    └─► analysis/clips/<clip_id>/{seed.json, words.<h>.json, peaks.<h>.bin, camera.<h>.json}
 sound-events ────┘  edit_v2.plan → compile_ffmpeg → FFmpeg 5.1.9 → verify ─► output/clip-NN.mp4 (+ .srt)

 Browser (Chrome/Edge ≥ 120, desktop)                 app container: Next route → python -m ai_clipper.edit_v2.*
 ┌─────────────────────────────────────┐  POST preview/plan {doc}  ┌────────────────────────────────────────────────┐
 │ React UI · store · commands · undo  │ ────────────────────────► │ validate → resolve → plan DTO + ASS bytes      │
 │ timemap.mjs (dicek vektor Python)   │ ◄─── plan DTO + ASS ───── │ antrekan sel plate / audio mix / logo turunan  │
 │ Player (Canvas2D, ukuran output):   │  GET media (Range)        │ sel plate: graf tata letak sama, 2 s, crf 18   │
 │  1. frame sel plate (Mediabunny)    │ ◄──────────────────────── │ audio mix: graf audio sama → FLAC 48 kHz       │
 │  2. JASSUB(ASS, nowMs(n))           │  POST preview/frame       │ frame akhir: graf render akhir, 1 frame PNG    │
 │  3. PNG logo 1:1                    │ ◄──────────────────────── │                                                │
 │  jam = AudioContext (audio mix)     │  PUT edit (If-Match)      │ edit_v2.api put (flock, receipt, arsip)        │
 └─────────────────────────────────────┘ ────────────────────────► └────────────────────────────────────────────────┘
          POST renders {editEtag} ─► render-request-v3 ─► render-worker ─► kompiler yang sama ─► verifikasi
                                                                        ─► output/edits/<clip_id>/<key16>.mp4 + .srt
```

### 2.4 Mengapa belum perlu WebGL2, dan mengapa `<video>` saja tidak cukup

- **WebGL2 belum perlu.** Di Esensial, lapisan yang dikomposit browser hanya bitmap libass dan satu
  logo yang sudah diskalakan. Semua yang ada di bawah teks adalah keluaran FFmpeg. `drawImage`
  Canvas2D untuk tiga lapisan pada 720×1280 jauh di bawah 16 ms. Jalur decode WebCodecs +
  `drawImage` terukur SSIM 0,9983, maks 4 terhadap decode FFmpeg [R3].
- **`<video>` saja tidak cukup.**
  - Jump cut butuh decode yang diindeks per frame dan decode di depan; `<video>` macet saat seek di
    setiap potongan [R3 §3].
  - Caption DOM/CSS tidak bisa mencapai paritas `\k`/`\fad` (SSIM 0,976–0,990 [R3]).
  - `<video>` hanya dipakai untuk memutar MP4 klip otomatis selama sel plate revisi 0 masih
    disiapkan. Itu tepat, karena byte-nya sama.
- **Kapan WebGL2 dibutuhkan (Tahap 2).** Saat geometri harus dipratinjau langsung sambil diseret
  (keyframe, kotak reframe, B-roll bergerak) tanpa round trip server. Format dokumen dan DTO plan
  tidak berubah; hanya ada lapisan pemutar baru.

### 2.5 Alur

| Alur | Langkah |
|---|---|
| **Render otomatis** (pipeline V3) | seleksi → untuk tiap klip: `source_info` (sha konten sumber, sekali per job) → artefak kata/peaks/kamera → `seed.json` (revisi 0) → plan → kompilasi → FFmpeg → verifikasi → publikasi `output/clip-NN.mp4`; manifest mencatat `clip_id`, `render_engine`, `render_key` |
| **Buka** | `GET …/clips` → `GET …/edit` (dokumen + ETag, atau seed virtual dengan `X-Edit-Seed: 1`, tanpa efek samping) → `POST …/prepare` (artefak yang hilang, sel plate pertama) → `POST …/preview/plan`; sampai sel siap, panggung memutar MP4 otomatis bila `plan_sha == rev0_plan_sha` |
| **Edit** | Perintah UI → dokumen baru (lokal, undoable) → time map lokal memperbarui transkrip/timeline seketika → debounce 120 ms → `POST preview/plan {doc}` → ASS baru dipasang ke JASSUB; audio mix dan sel yang hilang diantrekan; lencana "Memperbarui…" sampai semua lapisan terkini |
| **Simpan** | autosave (debounce 1,5 s, maks tiap 10 s, satu PUT sekaligus) → `PUT …/edit` dengan `If-Match` + `Idempotency-Key` → 200 / 409 (rebase) / 422 |
| **Ekspor** | flush autosave → `POST …/renders {editEtag}` → render-request-v3 (selesai instan bila isi dokumen = seed (R10) atau kunci render sama dengan render yang ada) → worker → verifikasi → unduh MP4 + SRT |

### 2.6 Penempatan proses (mesin hanya CPU)

| Pekerjaan | Tempat | Batas |
|---|---|---|
| Render otomatis | `primary-worker` (pipeline) | Seperti sekarang; x264 `threads=4` dikunci supaya bitstream deterministik |
| Plan/ASS per edit | container `app`, satu proses Python per permintaan | ≤ 200 ms p95 di server; konkurensi 4; permintaan yang tersusul dibatalkan |
| Sel plate, audio mix, frame akhir, logo turunan, kamera sesuai permintaan | container `app` lewat `web/lib/preview-lane.mjs` | Semafor 2 proses berat, `nice 5`, `-threads 2`; tugas yang tersusul dibatalkan; cache LRU dihitung storage admission |
| Render akhir | `render-worker` (4 CPU), satu per satu | Timeout `max(120 s, 3 × prediksi)`; `-progress` harus maju dalam 20 s |

---

## 3. Dokumen edit `clip-edit-v2` (subset Esensial)

The document describes *content* (what the clip is). Export options (size, quality) are render
request parameters, not document fields; in Essentials they have exactly one allowed value each
(`output`, `standar`), and Stage 2 widens the enums without a schema change. Python (`edit_v2/doc.py`) is the **only** validator; the
client builds valid documents by construction (commands) and treats 422 as a bug.

### 3.1 Units and conventions (integers only; a JSON number with `.` or `e` is rejected at parse)

| Suffix / field | Unit | Notes |
|---|---|---|
| `_sf` | Source-grid frame at `output.fps`: frame *k* covers source time `[k·den/num, (k+1)·den/num)` s, counted from t = 0 | Cut points, segment and removal edges |
| `_f` | Output frame at `output.fps` | Hook timing, fades |
| `_ms` | Source milliseconds | Words, analysis window |
| `_smp` | 48 kHz sample | Music offset |
| `_e5` | Fraction × 100,000 of the output width (x, w) or height (y) | `50000` = centre |
| `_pm` | Per-mille (1000 = 100%) | Opacity, size scale |
| `_cdb`, `_clufs` | Centi-dB, centi-LUFS | `-1400` = −14.00 |
| `fps` | `[num, den]`, one of `[24,1] [25,1] [30,1] [24000,1001] [30000,1001]` | Fixed at seed time |
| Colours | `#RRGGBB`, uppercase | Swatch sets per field (§3.3) |
| IDs | items, segments, removals, tracks `^[a-z]{2,3}_[0-9a-z]{1,16}$`; words `^w[0-9]{6,7}$`; assets `sha256:<64 hex>`; clip `^clip_[0-9a-f]{24}$` | |

Text rules (kept from V1 [R1 §3]): NFC only; no Cc/Cs characters; no leading or trailing
whitespace; hook ≤ 90 characters; word display text 1–40 characters. Canonical bytes are
`json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)`. A document is ≤ 1 MiB.
Duplicate keys, NaN and unknown keys are rejected at every level.

### 3.2 Complete example (revision 4: cold open, two cuts, Bold preset, logo, ducked music)

```json
{
  "schema": "clip-edit-v2",
  "schema_minor": 0,
  "clip_id": "clip_9b2e41c07d3a5f18e6c2a0b4",
  "revision": 4,
  "parent_sha256": "4c1d2e…64 hex…",
  "base": {
    "job_id": "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55",
    "source": {"content_sha256": "e3b0c4…", "w": 1280, "h": 720, "fps_native": [30000, 1001],
               "vfr": false, "duration_ms": 3901120, "has_audio": true},
    "origin": {"kind": "v3_clip", "selection_artifact_sha256": "a91f…", "selection_version": "selection-v3.0",
               "rank_at_seed": 3, "hook_unit_id": "S0412", "selection_source": "llm"},
    "window_ms": [1181900, 1370900],
    "words": {"sha256": "7f0a…", "count": 512},
    "camera": {"sha256": null},
    "seed_sha256": "51be…",
    "engine": {"compiler": "edit-v2/1", "render_semantics": 1}
  },
  "output": {"w": 720, "h": 1280, "fps": [30000, 1001], "sample_rate": 48000, "channels": 2},
  "main": {
    "segments": [
      {"id": "seg_co", "role": "cold_open", "in_sf": 38210, "out_sf": 38345},
      {"id": "seg_b1", "role": "body", "in_sf": 37215, "out_sf": 39284}
    ],
    "removals": [
      {"id": "rm_01", "seg": "seg_b1", "in_sf": 37483, "out_sf": 37556,
       "words": ["w048131", "w048132"], "reason": "user", "origin": "user"},
      {"id": "rm_02", "seg": "seg_b1", "in_sf": 37813, "out_sf": 37848,
       "words": ["w048140"], "reason": "filler", "origin": "suggestion:cl_7"}
    ],
    "joins": [{"after": "seg_co", "style": "cut", "audio_fade_ms": 30}],
    "cut_fade_ms": 8
  },
  "captions": {
    "enabled": true,
    "pack": {"id": "bold", "v": 1},
    "overrides": {"y_e5": 83000, "size_pm": 1000, "case": "upper", "highlight": "#FFE14D", "emphasis": "#FF5C8A"},
    "word_edits": {
      "w048121": {"text": "Ijal"},
      "w048150": {"emphasis": true},
      "w048151": {"hidden": true}
    }
  },
  "layout": {"default": {"mode": "fit_blur", "no_face": "center"}},
  "tracks": [
    {"id": "tr_hook", "kind": "hook", "items": [
      {"id": "it_hook", "type": "hook", "start": {"at": "out", "f": 0}, "dur_f": 120,
       "transform": {"x_e5": 50000, "y_e5": 13000},
       "payload": {"text": "Dia ditahan security di film-nya sendiri", "design": {"id": "legacy-bar", "v": 1}},
       "origin": "suggestion:sg_2"}]},
    {"id": "tr_ovr", "kind": "visual", "band": "over_text", "role": "overlay", "items": [
      {"id": "it_logo", "type": "image", "start": {"at": "clip_start"}, "end": {"at": "clip_end"},
       "transform": {"x_e5": 88000, "y_e5": 7000, "w_e5": 16000, "opacity_pm": 850},
       "payload": {"asset": "sha256:5c1f…", "mode": "free"}, "origin": "user"}]},
    {"id": "tr_mus", "kind": "audio", "role": "music", "items": [
      {"id": "it_music", "type": "audio", "start": {"at": "clip_start"}, "end": {"at": "clip_end"},
       "payload": {"asset": "sha256:91aa…", "src_in_smp": 0, "loop": true, "gain_cdb": -1000,
                   "fade_in_f": 15, "fade_out_f": 30,
                   "duck": {"on": true, "depth_cdb": 1000, "attack_ms": 30, "release_ms": 400,
                            "hold_ms": 250, "detector": "words"}},
       "origin": "user"}]}
  ],
  "audio": {"source": {"gain_cdb": 0},
            "master": {"mode": "off", "target_clufs": -1400, "tp_cdb": -100}},
  "assets": {
    "sha256:5c1f…": {"kind": "image", "mime": "image/png", "w": 512, "h": 512},
    "sha256:91aa…": {"kind": "audio", "mime": "audio/mp4", "duration_ms": 142000, "lufs_c": -1620}
  },
  "audit": {"created_at_ms": 1790000000000, "updated_at_ms": 1790000123456,
            "editor": "editor-v3/1.0.0", "last_command": "RemoveWords"}
}
```

### 3.3 Field rules (Essentials; anything else is `op_disabled` or `unknown_key`)

| Path | Type / range | Essentials rule |
|---|---|---|
| `schema`, `schema_minor` | `"clip-edit-v2"`, `0` | A newer minor → 426 "muat ulang editor" |
| `revision`, `parent_sha256` | int ≥ 0; sha or null | Revision 0 only for the seed (parent null). PUT requires `revision == current + 1` and `parent_sha256 == current etag` |
| `base.*` | set at seed, **immutable** | PUT with any change to `base` → 422 `base_changed` |
| `base.window_ms` | `[a, b]`, clip range ±60 s clamped to the source | Every segment must lie inside it (`outside_window`) |
| `output` | `w×h` ∈ {720×1280, 1080×1920}; `fps` as §3.1; `sample_rate` 48000; `channels` 2 | Fixed at seed (the job's render size; the dashboard uses 720×1280). Exports render at this size (§4.6) |
| `main.segments` | 1–2 items: optional `cold_open` first, then exactly one `body` | Cold-open rules in §3.4 |
| `main.removals` | ≤ 2,000; `reason` ∈ {`user`, `filler`, `repeat`, `gap_silent`}; `origin` `user` or `suggestion:<id>` | Sorted by `in_sf` within a segment; no overlap; `words` must exist in the words artifact |
| `main.joins` | 0–1 item: `after` = cold-open id; `style` `"cut"`; `audio_fade_ms` 0–250 (seed 30) | Other styles are Stage 2 |
| `main.cut_fade_ms` | 0–50 (default 8) | Micro-fade at every jump cut (G-CLICK) |
| `captions.pack` | `{id ∈ {classic, karaoke, bold, box}, v: 1}` | Packs are immutable per version (§5.4) |
| `captions.overrides.y_e5` | 20000–92000 (bottom anchor of the caption block) | Seed 83000 (= today's 17% bottom margin) |
| `captions.overrides.size_pm` | 700–1400 | Seed 1000 |
| `captions.overrides.case` | `asis`, `upper` | Case is a display transform; text is never rewritten |
| `captions.overrides.highlight`, `.emphasis` | swatch `#FFE14D #FFFFFF #3DF5A6 #52C7FF #FF5C8A #FF9F1C` | `highlight` is used by karaoke and bold |
| `captions.word_edits` | ≤ 6,000 keys (word ids); values `{text?, hidden?, emphasis?}` with ≥ 1 key | `text` 1–40 chars. `emphasis` fixes defect #6 (§8) |
| `layout.default.mode` | `fit_blur`, `camera` (face-track), `fill_center` (center-crop) | `no_face` is `"center"` (today's behaviour), and no-face spans are *reported*, never silent |
| `tracks` | ≤ 3 tracks: ≤ 1 `hook`, ≤ 1 `visual/over_text/overlay`, ≤ 1 `audio/music`; ≤ 1 item each | Stage 2 lifts the counts; the shapes stay |
| hook item | `start {"at":"out","f":0}`; `dur_f` 15 to `floor(30·F)`; `transform.x_e5` 50000; `y_e5` 6000–40000 (top of the hook stack; seed 13000); `payload.text` 1–90; `design {"id":"legacy-bar","v":1}` | Fixed start at 0 as today |
| logo item | `start clip_start`, `end clip_end`; `x_e5, y_e5` 0–100000 (box centre); `w_e5` 4000–40000; `opacity_pm` 200–1000; `payload.mode` `"free"` | The resolved box must lie inside the frame (`item_out_of_frame`) |
| music item | `start clip_start`, `end clip_end`; `src_in_smp` 0 to asset length − 1; `loop` bool; `gain_cdb` −4800–600; `fade_in_f`/`fade_out_f` 0 to `10·F`; `duck` fully specified: `depth_cdb` 300–2400, `attack_ms` 5–500, `release_ms` 50–2000, `hold_ms` 0–1000, `detector` `"words"` | Default gain `clamp(−2600 − lufs_c, −4800, 600)` |
| `audio.source.gain_cdb` | −2400–1200 | Seed 0 |
| `audio.master` | `mode` `off`/`normalize`; `target_clufs` −2400 to −900; `tp_cdb` −300–0 | Seed `off` (= today's auto render) |
| `assets` | map of the assets the document references; metadata copied from the asset store | `asset_missing` if the store lacks the sha |
| `audit` | `created_at_ms` immutable; `updated_at_ms` **stamped by the server**; `editor`; `last_command` (≤ 40 chars, `^[A-Za-z]+$`) | The server stamp removes client-clock issues |

### 3.4 Integer and frame rules

All arithmetic is integer (Python `int`, JS `BigInt` only where a product can exceed 2^53, which
never happens below 10 h at 30 fps). Rational comparisons use cross-multiplication, never floats.

| Quantity | Rule |
|---|---|
| ms ↔ source-grid frame | `sf_floor(ms) = ⌊ms·num / (1000·den)⌋`, `sf_ceil(ms) = ⌈ms·num / (1000·den)⌉`; the start time of frame k is `k·1000·den/num` ms (rational) |
| Seed segment edges | `start_ms = round_half_up(start_s·1000)` (V3 values have 3 decimals); `in_sf = sf_floor(start_ms)`, `out_sf = sf_ceil(end_ms)` |
| Pieces | For each segment in order: `[in_sf, out_sf)` minus the union of its removals. A remaining sub-range shorter than 2 frames is dropped (it joins the adjacent cut). `out_f0(p) = Σ frames(previous pieces)`; `frames = out_sf − in_sf` |
| Duration | `total_f = Σ frames`; the body alone must satisfy `3 s ≤ frames/F ≤ 300 s` (`duration_out_of_bounds`) |
| Samples | `smp(n) = ⌊n·48000·den / num⌋` (1601/1602 at 29.97 with zero drift [PF D12]); piece sample count `smp(out_f0+frames) − smp(out_f0)`; the first source sample of a piece is `⌊in_sf·48000·den / num⌋` |
| Word visibility (captions) | A word is shown when it is not `hidden` and its midpoint `(s+e)/2` lies inside a piece's source span (the V3 midpoint rule) |
| Word output frames | `n_on = out_f0(p) + round_half_up((s_ms − t0_ms(p))·num / (1000·den))`, clamped to the piece; `n_off` the same from `e_ms`. A word never spans a cut |
| ASS time (frame-safe) | `now_ms(n) = trunc(n · (den/num) · 1000)` in IEEE double, **the exact expression order of FFmpeg's `vf_subtitles`** with time base `den/num` (the graph sets `settb=den/num` before `ass`). `safe_cs(n) = (now_ms(n) − 2) // 10`. An event visible on `[a, b)` is written `Start = safe_cs(a)`, `End = safe_cs(b)`; `\k` durations are differences of `safe_cs`. The browser calls libass with `now_ms(n)/1000`, and JASSUB's rounding returns exactly `now_ms(n)` [PF `ass_time_rule.py`: 0 failures, 24–60 fps, 3 h] |
| Cold open | At most one, first, `⌈0.5·F⌉ ≤ frames ≤ ⌊8·F⌋`, `abs(co.in_sf − body.in_sf) ≥ 1`. Blocking `cold_open_invalid` when more than 80% of it lies inside `[body.in_sf, body.in_sf + frames + 2·F)`, because it would only repeat the opening (FINAL §4.8) |
| Plate cells | `cell_frames = 2·⌈num/den⌉` (60 at 29.97 and 30, 50 at 25, 48 at 24 and 23.976). Cell k covers source-grid frames `[k·cell_frames, (k+1)·cell_frames)` |
| Logo box | `w_px = round_half_up(w_e5·W / 100000)`, `h_px = round_half_up(w_px·asset_h / asset_w)`, `x0 = round_half_up(x_e5·W/100000 − w_px/2)`, `y0` likewise, computed as integers from the doc's output size (export at another size recomputes from the same `_e5` values) |

### 3.5 Seed (revision 0) from a V3 clip

The pipeline writes the seed once to `analysis/clips/<clip_id>/seed.json` (canonical bytes,
immutable) and renders the auto clip **from that file**. The editor never recomputes it for new
jobs, so it cannot drift. For jobs rendered before Essentials, `POST /clips` (prepare) builds the
seed once with the same function, marks `base.engine.compiler = "legacy"` and **writes it as the
same immutable `seed.json`**, together with `source.json`, words and peaks (§4.4). GET never
writes. A later code change therefore never moves the revision-0 ETag or the "Kembali ke versi
AI" target of an existing clip.

| Doc field | Source |
|---|---|
| `clip_id` | `"clip_" + sha256("potongin-clip-v1\0" ‖ source_content_sha256 ‖ "\0" ‖ start_ms ‖ "\0" ‖ end_ms ‖ "\0" ‖ (co_start_ms "-" co_end_ms, or "-"))[:24]` (FINAL §4.9; rank and selection version excluded, so a re-run that finds the same moment re-attaches the edits) |
| `main.segments` | Cold open (when the job ran with cold open and the clip has one) + body, edges per §3.4 |
| `main.joins` | `cut` with `audio_fade_ms: 30` (today's `AUDIO_JOIN_FADE_SECONDS`) |
| `captions.pack` | `karaoke` or `classic` from the job's `captionStyle`; overrides at the pack defaults |
| hook item | When `hookOverlay` and `hook_text` exist: `[0, round_half_up(hook_duration·F))`, `legacy-bar`, `y_e5 13000` |
| `layout.default.mode` | `face-track` → `camera`, `fit-blur` → `fit_blur`, `center-crop` → `fill_center` |
| `output` | The job's render size (the dashboard passes 720×1280 [REPO run-job.mjs]); fps: native standard rates kept; 50 → 25, 60 → 30, 60000/1001 → 30000/1001; VFR or other → 30/1 |
| `audio` | Source gain 0; master `off` |
| `base.window_ms` | `[min(start, co_start) − 60 000, max(end, co_end) + 60 000]` clamped to `[0, duration_ms]` |

### 3.6 Words artifact `potongin.words/1`

Immutable file `analysis/clips/<clip_id>/words.<sha16>.json`, built from `transcript.json`
**as written** (read back through `transcript_io.read_transcript_json`), so the IDs match what
every later reader sees.

```json
{"schema": "potongin.words/1", "clip_id": "clip_9b2e…", "transcript_sha256": "…", "fps": [30000, 1001],
 "window_ms": [1181900, 1370900],
 "words": [{"id": "w048121", "s": 1241930, "e": 1242210, "t": "Ijai", "p_pm": 410, "u": "S0412", "z": false}],
 "units": [{"id": "S0412", "s": 1241930, "e": 1245880, "q": true}],
 "bounds": [{"after": "w048120", "before": "w048121", "sf": 37229, "tight": false, "rms_cdb": -5210}],
 "gaps": [{"after": "w048130", "s": 1244100, "e": 1245320, "class": "voiced"}],
 "events": [{"kind": "laughter", "s": 1256800, "e": 1256800, "src": "yt-caption"},
            {"kind": "laughter", "s": 1301200, "e": 1301900, "src": "transcript"}],
 "silences": [[1261330, 1262490]], "scene_cuts_ms": [1263040],
 "peaks": {"file": "peaks.9c1e….bin", "per_sec": 100, "start_ms": 1181900}}
```

- **Word IDs.** `w` + the zero-padded global index of the word in the transcript's flattened word
  list. Segments without word timestamps are split proportionally exactly like
  `subtitles._segment_words`, so revision 0 captions equal the auto render's captions. Zero-length
  words (up to 4.7% with YouTube captions [UX-M1]) get `e = min(s + 80, next.s)` and `z: true`.
- **`bounds`, the snap table (single source of truth for every cut and trim).** For each
  adjacent word pair (and before the first and after the last word of the window), the chosen
  frame boundary `sf`:
  1. If `gap = b.s − a.e ≥ 40 ms`: take the quietest 10 ms bin in `[a.e + 20, b.s − 20]` from
     the peaks; ties go to the gap centre.
  2. Convert it to the frame boundary *inside* the gap nearest to that point.
  3. When no frame boundary fits inside the gap (gap < 1 frame), use the boundary nearest the
     midpoint and set `tight: true`, which raises the warning `tight_cut` on any cut that uses it.

  Trim-in, trim-out, removal-in and removal-out at that gap all use this same `sf`, so the client
  never computes a cut point itself.
- **Gap classes** (for Rapikan and markers; only gaps > 600 ms): `laughter` when a laughter event
  lies within ±500 ms; `silent` when ≥ 80% of the gap is covered by `audio_timeline` silences;
  otherwise `voiced` [FINAL §5.3; UX-M2: 78% of long gaps are not silent].
- **Events.** From `analysis/sound-events.json` (YouTube tags, points) plus transcript tokens
  matching `^(ha){2,}h?$|^(he){2,}$|^wk(wk)+$` (source `transcript`), both case-folded.
- **Peaks.** `peaks.<sha16>.bin`: 8-bit min/max pairs at 100 per second over the window, mono,
  decoded once at 8 kHz by FFmpeg. Used by the snap table, the waveform lane and Rapikan audition.
- **Transcript changed** (the job re-ran): the words sha in `base.words` no longer matches → the
  editor opens **read-only** with "Transkrip berubah sejak klip diedit" and offers "Mulai dari
  versi AI". Re-anchoring is Stage 2.
- **Overlapping words** (allowed by `transcript_io`: words may overlap each other): a negative gap
  takes the frame boundary nearest `(a.e + b.s)/2`, clamped to `[a.s, b.e]`, with `tight: true`.
- **Missing optional analysis** (older jobs without `sound-events.json` or `audio-timeline.json`):
  `events`, `silences`, `scene_cuts_ms` and the gap classes are empty, and the artifact records
  `"missing": ["sound_events", …]` so that the UI can show "tidak tersedia untuk job ini" instead
  of an empty lane.

### 3.7 Validation results

| Level | Codes (Indonesian message id = `edit.<code>`) | Effect |
|---|---|---|
| Parse | `invalid_json`, `float_not_allowed`, `duplicate_key`, `unknown_key`, `too_large`, `not_nfc`, `control_char` | 422 `{errors:[{path, code}]}` |
| Semantic, blocking | `base_changed`, `outside_window`, `range_invalid`, `cold_open_invalid`, `duration_out_of_bounds`, `removal_outside_segment`, `removal_overlap`, `unknown_word`, `asset_missing`, `pack_unknown`, `op_disabled`, `item_out_of_frame`, `revision_mismatch`, `parent_mismatch` | 422 |
| Warning (save allowed; export asks for acknowledgement in "Perlu dicek") | `tight_cut`, `laughter_cut` (a cut inside a laughter span or within 300 ms of a laughter point), `hook_overflow` (the hook does not fit 3 lines at the smallest size and will be shortened with "…"), `glyph_unsupported:U+XXXX` (the pack font lacks a character, e.g. emoji), `no_face` (face-track spans with no face; listed with jump-to), `unsafe_zone` (caption, hook or logo box inside the TikTok UI zone), `loudness_clamped`, `peak_reduced` (§5.6 step 5), `music_shorter_than_clip` (loop off) | Listed with a jump-to target; nothing is silently changed |

### 3.8 Forward compatibility with FINAL (Stage 2)

- Stage 2 adds **optional** keys under `schema_minor: 1`: more tracks and items, word anchors,
  `intro_hold_f`, `markers`, `template_ref`, `packaging`, join styles, `layout.ranges`, and
  `camera.manual_keys`. A minor-0 document stays valid unchanged.
- The pack ids `classic` and `karaoke` are the FINAL `legacy-classic@1` and `legacy-karaoke@1`
  (an alias table is added in Stage 2).
- FINAL puts the resolver in JS. If Stage 2 adopts that, the Python resolver becomes the
  reference: FINAL's P-XENG test is then run against Python output (plan-hash equality), which
  this plan's goldens already enable.

---

## 4. Penyimpanan, API, dan model revisi

### 4.1 Storage layout (new paths only; everything under the job directory)

```
JOBS_ROOT/<job>/
  analysis/source.json                          {content_sha256, probe}; written once per job (edit_v2.source_info)
  analysis/clips/<clip_id>/
      seed.json                                 revision 0, canonical, immutable (0600)
      words.<sha16>.json · peaks.<sha16>.bin    immutable analysis artifacts
      camera.<sha16>.json                       immutable, only when face-track was needed
      edit/doc.json                             current revision (canonical, 0600)
      edit/archive/r<N>.<sha>.json.gz           superseded + render-referenced revisions
      edit/receipts/<idempotency-key>.json      digest-only receipts (pruned, §4.4)
      edit/.lock                                flock for the clip's document
      preview/plates/<plate_key16>-c<k:07d>.mp4 plate cells (LRU cache; flat names)
      preview/audio/<mix_sha16>.flac            preview audio mixes (LRU cache)
      preview/ass/<ass_sha16>.ass               ASS served to JASSUB (LRU cache)
      preview/frames/<plan_sha16>-<f>-<w>.png   truth frames (LRU cache)
      preview/derived/<asset_sha16>@<w>x<h>.png logo prescaled to its exact pixel box
      suggestions/<task_id>.json                AI tasks (30 days)
  analysis/assets/<sha256>.{png,m4a} + <sha256>.json    job asset store (§9.2)
  analysis/render-requests/<render_id>.json     render-request-v1/v2 (legacy) and v3 (new)
  output/clip-NN.mp4 + .srt                     auto renders (unchanged paths; = revision 0)
  output/edits/<clip_id>/<render_key16>.{mp4,srt}   editor exports
```

Caches (`preview/**`) are regenerable. They are LRU-evicted per job with a default cap of 1 GiB
(owner decision K11) and counted by the existing storage admission scan.

### 4.2 Endpoints

Every route calls `requireAuth`, validates IDs with regexes before spawning anything, and reaches
Python through the shared `web/lib/python-cli.mjs` (`execFile`, no shell, bounded stdin/stdout,
timeout + SIGKILL, fixed exit-code map as in `edit-document.mjs`, and an **allowlisted env**:
`PATH HOME LANG TZ TMPDIR JOBS_ROOT FONTCONFIG_FILE` plus non-secret `POTONGIN_EDITOR_*` /
`POTONGIN_RENDER_ENGINE` flags; never `APP_*`, `POTONGIN_SETTINGS_*`, `POTONGIN_LLM*` or
`*_API_KEY`). Only the AI task adds `engineProcessEnv(await loadLlmEnv())` (E11). Every **mutation** (all POST, PUT, DELETE, including the read-like POSTs
`preview/plan` and `preview/frame`, which cost CPU) checks Origin, Host and `Sec-Fetch-Site`
(`sameOriginMutation`) and streams and counts its body.

| Method and path (under `/api/jobs/:id`) | Purpose | Contract |
|---|---|---|
| `POST /clips` | Job-level prepare for jobs rendered before Essentials: writes `analysis/source.json`, computes the clip ids and writes each clip's immutable `seed.json`, words and peaks (§3.5) | Same-origin; idempotent; `202 {state}` |
| `GET /clips` | V3 clips of the job | `{clips:[{clipId, index, title, hookText, description, hashtags, durationMs, engine: "edit-v2/1"\|"legacy", edit:{state:"seed"\|"edited", revision, etag, updatedAtMs}, latestRender:{renderId, state, url, srtUrl, revision}\|null, openable, reason}]}`. For jobs rendered before Essentials, `clipId` is null with `reason: "needs_prepare"` until `POST /clips` has run. Other `reason` values (fixed codes with Indonesian messages): `source_missing`, `selection_unreadable`, `transcript_missing`, `analysis_incomplete` (`.attempts/` left), `not_v3` (V1/v2-shadow jobs; V2 candidates use the legacy editor and its "Buka di Editor V3") |
| `GET /clips/:clipId/edit` | Current document, or the seed as virtual revision 0 | `200 {doc, etag, seed, words:{sha256, url}, readOnly, readOnlyReason}` with `ETag` and `X-Edit-Seed: 1` for the seed. `?seed=1` always returns the seed (for "Kembali ke versi AI"). **No side effects.** `409 analysis_missing` when the words artifact does not exist yet (the client then calls `prepare`) |
| `PUT /clips/:clipId/edit` | Save the full document | `If-Match` required (428), `Idempotency-Key` UUID required, `Content-Type: application/json`, ≤ 1 MiB. `200 {doc, etag, warnings}`; `409 revision_conflict {current, etag}`; `409 idempotency_conflict`; `422 {errors:[{path, code}]}`; `426 schema_too_new` |
| `GET /clips/:clipId/words` | Words artifact | `ETag` = sha; `Cache-Control: private, max-age=31536000, immutable` |
| `POST /clips/:clipId/prepare` | Build missing artifacts (source info, words, peaks, camera for the requested layout) and enqueue the first plate cells | Body `{layout?}` ≤ 1 KiB; `202 {words, camera, plate:{state, ready, total}}`; idempotent |
| `POST /clips/:clipId/preview/plan` | Validate and resolve an **unsaved** document for preview | Body `{doc, known:{assSha256?}}` ≤ 1 MiB. `200 PlanDTO` (§4.3) or `422 {errors}`. Rate ≤ 10/s per session; a superseded request for the same clip is cancelled |
| `POST /clips/:clipId/preview/frame` | Truth frame | Body `{doc, f}`; `image/png` at the output size with ancillary chunks stripped; ≤ 4/s; cached by `(plan_sha, f)` |
| `GET /clips/:clipId/media/:kind/:name` | Plate cells, audio mixes, ASS, derived logos, peaks | `kind` ∈ {`plates`, `audio`, `ass`, `derived`, `peaks`}; `name` matches a content-hash regex; realpath containment; HTTP Range; `private, max-age=31536000, immutable`; `nosniff`; `Cross-Origin-Resource-Policy: same-origin`. ASS (which contains user text) is served as `text/plain; charset=utf-8` with `Content-Security-Policy: sandbox` |
| `POST /clips/:clipId/renders` | Enqueue an export | `Idempotency-Key`; body exactly `{"editEtag":"<64 hex>"}` ≤ 1 KiB (size and quality are fixed to the auto clip's in Essentials); storage reservation first (existing admission). `202 RenderDTO`, or `200` with `state:"completed"` when the document content equals the seed (R10) or the render key already exists |
| `GET /renders/:renderId` (extended) | Status of legacy and v3 requests | `RenderDTO {renderId, clipId\|candidateId, state, stage, progressPm, revision, errorCode, resultUrl, srtUrl}` |
| `DELETE /renders/:renderId` (new) | Cancel a v3 request | Same-origin; queued → `cancelled`; rendering → the worker kills FFmpeg within 2 s and marks `cancelled` |
| `POST /clips/:clipId/ai` | AI hook suggestions (§7) | Body exactly `{task:"hooks", doc}` (no provider, model or URL field is accepted; those come only from the sealed LLM settings); `202 {taskId, heuristic:[…], llm:{state:"pending"\|"disabled"\|"rate_limited"}}` |
| `GET /clips/:clipId/ai/:taskId` | Poll an AI task | `taskId` is a UUID (checked in Node and Python); `{state:"pending"\|"done"\|"failed", suggestions:[…], error:{code, messageId}\|null}` |
| `GET /clips/:clipId/cleanup` | Rapikan review list (§7.3) | Immutable per `(words sha, lexicon version)` |
| `GET /clips/:clipId/coldopen-suggestions` | Cold-open candidates (§7.2) | Immutable per words sha |
| `POST /assets` | Upload a logo or music file (§9.2) | Raw body; `Content-Type` allowlist; `Content-Length` required; `X-Asset-Kind: logo\|music`; `Idempotency-Key`; `201 {sha256, kind, mime, w, h, durationMs, lufsC, peaksUrl}` |
| `GET /assets/:sha` | Normalised asset bytes | §9.2 headers |
| `GET /api/resources/:kind/:name` (global) | Font files and pack JSON: **the same bytes libass uses** | `kind` ∈ {`fonts`, `caption-packs`, `hook-designs`}; immutable; the sha is checked against `resources/fonts/fonts.json` in tests |

### 4.3 Plan DTO (returned by `preview/plan`; also the contract between server, player and UI)

```json
{
  "planSha256": "…", "docSha256": "…", "compiler": "edit-v2/1", "renderSemantics": 1,
  "fps": [30000, 1001], "totalFrames": 1811, "output": {"w": 720, "h": 1280},
  "pieces": [{"i": 0, "seg": "seg_co", "role": "cold_open", "inSf": 38210, "outSf": 38345, "outF0": 0, "frames": 135},
             {"i": 1, "seg": "seg_b1", "role": "body", "inSf": 37215, "outSf": 37483, "outF0": 135, "frames": 268}],
  "cues": [{"f0": 135, "f1": 160, "text": "KAMU TAHU NGGAK", "words": ["w048121", "w048122", "w048123"]}],
  "hook": {"f0": 0, "f1": 120, "lines": ["Dia ditahan security", "di film-nya sendiri"], "overflow": false},
  "text": {"assSha256": "…", "ass": "[Script Info]…", "url": "/api/jobs/…/media/ass/<sha16>.ass",
           "fonts": [{"family": "Montserrat ExtraBold", "url": "/api/resources/fonts/Montserrat-ExtraBold.ttf", "sha256": "…"}]},
  "plate": {"plateKey": "…", "cellFrames": 60, "w": 720, "h": 1280,
            "cells": [{"k": 620, "state": "ready", "url": "/api/jobs/…/media/plates/<key16>-c0000620.mp4"},
                      {"k": 621, "state": "queued"}]},
  "logo": {"box": {"x": 560, "y": 26, "w": 115, "h": 115}, "opacityPm": 850,
           "url": "/api/jobs/…/media/derived/<sha16>@115x115.png"},
  "audio": {"mixSha256": "…", "state": "ready", "url": "/api/jobs/…/media/audio/<mix16>.flac",
            "samples": 2901901, "musicGainPoints": [[0, 0], [1440, 316228]], "speechSpans": [[0, 4320]]},
  "rev0": {"planSha256": "…", "autoRenderUrl": "/api/jobs/…/files/output/clip-03.mp4", "exact": true},
  "warnings": [{"code": "tight_cut", "ref": "rm_01", "f": 402}],
  "errors": []
}
```

- `text.ass` is omitted when `known.assSha256` equals the new sha. `cues` and `hook` exist only to
  draw the timeline and the transcript; pixels always come from the ASS.
- `audio.musicGainPoints` are the duck/fade breakpoints `[out_sample, gain_e6]`, used only to
  draw the envelope on the music lane. The audible gain comes from the server mix.
- `rev0.exact` is true only when `planSha256 == rev0.planSha256` and the auto render was produced
  by `edit-v2`. The player may then play `autoRenderUrl` while plate cells build.
- In Essentials `plate.w/h` always equals `output` (every job is 720×1280), so the preview
  resolution is the export resolution.

### 4.4 Revision model (reusing the V1 core)

- **Virtual revision 0.** Without `edit/doc.json`, GET returns `seed.json` with
  `ETag = sha256(seed canonical bytes)`. The first PUT with `If-Match: <seed sha>` creates
  revision 1. Nothing is written by GET, which fixes the side-effecting GET of V1 [R1 §8].
- **PUT rules, kept exactly from V1** [R1 §5], all under the clip's `flock`:
  - `If-Match == current etag`, `revision == current + 1`, `parent_sha256 == current etag`;
  - `base` unchanged and `audit.created_at_ms` unchanged;
  - the server stamps `audit.updated_at_ms = max(now, previous + 1)`, re-validates, and writes
    atomically (tmp → fsync → rename → dir fsync, `O_NOFOLLOW`, 0600);
  - the superseded revision is archived as `r<N>.<sha>.json.gz`.
- **Idempotency receipts** (same algorithm as `editor_api.py`, smaller storage):
  - Each receipt is `{key, payload_sha256 = sha256(expected_etag ‖ 0x00 ‖ canonical(client doc)),
    state: pending|committed, result_etag, result_revision, at_ms}`. **No document copy.**
  - Replaying the same key and digest returns the result revision (current or archived). Same key
    with a different digest → 409 `idempotency_conflict`. A pending receipt after a crash is
    reconciled as in V1.
  - **Pruning** under the lock after each commit: keep the newest 200 committed receipts (more
    than 30 minutes of continuous autosave) plus any pending one; delete the rest. This fixes
    defect #7, the 1,000-save lockout [R1 D5]. A retry that arrives after its receipt was pruned
    is safe: its `If-Match` no longer equals the current etag, so it gets 409 and the client's
    rebase sees that the server already holds its document.
- **Archive retention** (janitor, W4): revision 1, every revision referenced by a render request,
  and the newest 50.
- **Legacy-engine jobs** (rendered before the engine switch): the seed is built once by
  `POST /clips` and persisted (§3.5) with `base.engine.compiler = "legacy"`. The editor works,
  but shows "Klip ini dibuat dengan mesin lama; ekspor dari editor memakai mesin baru (tampilan
  teks bisa sedikit berbeda)". "Ekspor tanpa perubahan" returns the original file (R10).

### 4.5 Client: undo/redo, autosave, draft and conflicts

- **Commands** (Appendix B) are pure functions `(doc, args) → doc`. History keeps up to 200
  `{command, before, after}` entries with structural sharing. Commands with the same `mergeKey`
  within 500 ms (drags, sliders, typing in one word) merge into one entry. "Kembali ke versi AI"
  is one undoable command that replaces the body with the seed (keeping `base`, `revision` and
  `parent_sha256`).
- **Autosave.** Debounced 1.5 s after the last command, at least every 10 s during continuous
  editing, on blur and on `visibilitychange`, with at most one PUT in flight. A retry of the same
  payload reuses the same `Idempotency-Key`. A `beforeunload` guard is active while unsaved.
- **Draft.** IndexedDB (≈ 60-line raw wrapper, no dependency) stores
  `{clipId, baseEtag, commands[], doc, savedAtMs}` after every command. On open, a draft whose
  `baseEtag` equals the server etag and which has commands is restored silently. A draft on an
  older etag goes through rebase.
- **Tabs.** `BroadcastChannel("potongin-editor")` warns "Klip ini terbuka di tab lain".
- **409 rebase.**
  1. Replay the pending semantic commands onto `current`, re-checking each precondition (a word
     still exists, a removal still fits its segment, a trim still yields ≥ 3 s).
  2. If all hold, save automatically and toast "Digabung dengan perubahan dari tab lain".
  3. Otherwise open a per-part dialog ("Teks hook", "Potongan 00:12", "Caption kata 'Ijal'"):
     "Pakai punyaku" / "Pakai yang tersimpan".

  The draft is never discarded and the editor never locks.

### 4.6 Render queue v3

`render_queue.py` keeps v1/v2 validation byte-for-byte (legacy candidate requests keep working)
and adds `render-request-v3`:

| Field | Rule |
|---|---|
| `version`, `render_id`, `idempotency_key`, `state` | `state` ∈ {queued, claimed, rendering, completed, failed, **cancelled**} |
| `clip_id`, `doc_sha256`, `doc_revision` (≥ 0), `doc_relative` | `analysis/clips/<clip_id>/edit/archive/r<N>.<sha>.json.gz`; revision 0 points at `seed.json` |
| `render_key`, `size`, `quality`, `output_relative` | `output/edits/<clip_id>/<render_key16>.mp4`; `size` is `"output"` and `quality` is `"standar"` (the only values in Essentials) |
| `source_content_sha256`, `source_snapshot_relative` | Snapshot by **hard link** (copy fallback on cross-device), content sha verified as today (`_assert_source_binding`) |
| `stage`, `progress_pm` | `antre`, `merender`, `memverifikasi`, `selesai`; updated with each heartbeat from `-progress` |
| timestamps, `attempts`, `error_code` (+ `verification_failed`, `cancelled`), lease, storage fields | As v2 |

Rules:
- **Idempotency and completion.** An identical key completes instantly.
- **R10, content identity (checked first).** When the document's *content* equals the seed, the
  request completes by hard-linking `output/clip-NN.mp4` (+ `.srt`) into
  `output/edits/<clip_id>/` after re-verifying G1–G2, **whatever the toolchain or engine
  version**:
  - "content" is the canonical bytes without `revision`, `parent_sha256` and `audit`;
  - this also covers legacy-engine clips and a document whose edits were all undone.

  This is what makes revision 0 **the** auto render, even after an image rebuild changes the
  render key. If the auto file is missing or fails G1–G2, the request renders normally and the
  DTO carries `warning: "auto_file_unavailable"`. Otherwise, when `render_key` equals a finished
  export's key, that file is reused.
- **Timeout** is `max(120 s, 3 × predicted)`, with `predicted = duration × k(layout, size)` from a
  calibration table. Liveness: FFmpeg `-progress pipe:3` must advance within 20 s. This fixes
  D9.
- **Retention.** Terminal requests older than 7 days are pruned, keeping the newest 200. This
  removes the 1,000-request ceiling.

---

## 5. Jalur render (satu kompiler)

### 5.1 Modules and modes

`edit_v2.plan.build_plan(doc, words, camera, assets) → RenderPlan` resolves the document once.
`edit_v2.compile_ffmpeg.compile_job(plan, mode, …) → FfmpegJob{argv, filter_script, inputs,
sidecars, expected}` turns it into FFmpeg work. `edit_v2.execute.run(job, …)` runs it with fd
inputs, timeouts, `-progress` liveness and cancel. `edit_v2.verify` checks the result. Every
caller goes through these four functions:

| Mode | Used by | Output |
|---|---|---|
| `final` | pipeline (auto render), render-worker (exports) | H.264/AAC MP4 at `size`, plus the `.srt` sidecar |
| `reference` | gates only | Lossless video (`ffv1` in `.mkv`) and `pcm_s16le`, same graph, no encode loss |
| `plate_cells` | preview lane | Cells `k…` of the layout graph, **no text, no logo, no audio**, H.264 crf 18, `-bf 0`, IDR exactly at every cell start (`-force_key_frames expr:eq(mod(n\,C)\,0)` with `-sc_threshold 0`; `-g` alone is not enough, because x264 scene cuts reset the GOP counter), yuv420p, BT.709 tags, one file per cell (`-f segment -segment_frames …` with `-reset_timestamps 1`), at the output size |
| `frame` | preview lane (truth frame) | One output frame of the full final graph, **including the final 4:2:0 conversion and an intra-coded H.264 encode at the export CRF**, decoded back → PNG (rgb24; ancillary chunks stripped). This is the closest single-frame equivalent of the delivered file. The same frame inside the export (often a P-frame) differs only by encoder noise, which P-ENC bounds |
| `audio_preview` | preview lane | The final audio graph → FLAC s16 48 kHz stereo |
| `audio_measure` | preview lane, render-worker | Pre-master mix → `ebur128=peak=true`; returns integrated LUFS and true peak |
| `derive_image` | preview lane, render-worker | Logo asset → exact pixel box, opacity baked in → PNG (both sides overlay these same bytes) |

### 5.2 Graph rules (each has a string-golden test)

- **R1. Frame identity: the grid rule measured in PF, ported verbatim.** Each decoder run uses
  `-ss (first_sf/F − 1.0) -copyts -i /proc/self/fd/N`. Each piece uses
  `fps=num/den,trim=start_pts=<in_sf>:end_pts=<out_sf>,setpts=PTS-STARTPTS`. Measured: 0 of 1,125
  frames differ from the whole-file `fps=F` grid, on CFR 29.97 and VFR, in FFmpeg 5.1.9 and 6.1.1
  (`spike-pf/frame_identity.py`). Plate cells use the same rule with `[k·cell_frames,
  (k+1)·cell_frames)`, so a plate frame and a final frame for the same `sf` are the same decoded
  source frame (gate P-FRAME). Any change to these strings (for example `start_time`) needs P-FRAME
  re-measured.
- **R2. Decoder runs.** Consecutive pieces whose source gap is below 10 s share one seeked input
  (`split=n` then per-piece trims); otherwise a new input is opened. Measured with 20 cuts:
  2096/2096 frames, A/V −0.7 ms, 13% faster than one input per piece [INC-E4].
- **R3. Normalisation.** Every branch gets `setsar=1`. The layout `scale` sets
  `in_color_matrix=<probe, or bt709 for ≥ 720p, bt601 below>` explicitly, because swscale assumes
  BT.601 for untagged video [PF]. After `concat`: `settb=<den>/<num>` (required by the
  frame-safe ASS rule, §3.4). Implicit conversions are compiler test failures.
- **R4. Layouts** (the same builders feed `plate_cells` and `final`):
  - **`fit_blur`:** `split → bg: scale=W:H:force_original_aspect_ratio=increase,crop=W:H,
    gblur=sigma=σ; fg: scale=W:H:force_original_aspect_ratio=decrease; overlay=(W-w)/2:(H-h)/2`
    with `σ = 35·H/1280`. That is today's look at 720×1280 [REPO render.py] and the same
    *relative* blur at other sizes. Both overlay inputs are converted to `yuv444p` first, in
    plate and final alike, so the even-pixel truncation of yuv420 overlays [R3 bug 3] cannot
    occur.
  - **`fill_center`:** `scale=increase` + centred `crop`, as today.
  - **`camera`:** `scale=increase` + `crop=W:H:x='<expr>':y=(ih-oh)/2`. The camera plan
    (§5.7) is turned **in Python** into an integer crop x per source-grid frame, using the
    interpolation of `face_tracking.build_crop_expression`, rounded once and made even.
    - `<expr>` is a piecewise function of the **integer** source-grid index `n + first_sf` of
      that branch (`n` is the crop filter's frame counter), never of float `t` with per-piece
      offsets. Float offsets differ between plate cells and final pieces and could flip the
      integer truncation by 1–2 px.
    - The crop at any source frame is therefore independent of cuts and bit-identical in plate
      and final.
    - The plan is computed once per clip window (§5.7), never per range.
- **R5. Text compositing** in the format chosen by spike S-COLOR:
  `format=<yuv420p|yuv444p|gbrp>` → `ass=filename=captions.ass:fontsdir=fonts:shaping=complex`
  (shaping pinned; FFmpeg's default is `auto`) → logo `overlay` →
  `scale=out_color_matrix=bt709:out_range=tv,format=yuv420p`.
  - Measured [PF] at 1080×1920 on 4 CPUs, per 30 s: yuv420p 8.2–8.9 s, yuv444p 10.6 s
    (+19–29%), gbrp 12.3 s. Text vs JASSUB **against the lossless pre-subsampling reference**:
    yuv420p max diff 93; yuv444p SSIM 0.99925, max 15; rgb24 0.9998, max 13.
  - `ass` works on `gbrp` in 5.1.9 (`spike-pf/graph.sh`).
  - **The delivered MP4 is always 4:2:0.** Coloured text edges lose chroma resolution in every
    candidate, so the 93 → 15 gain does not carry over to the export. S-COLOR therefore scores
    each candidate on the **delivered MP4** as well: P-ENC for text regions, and P-COLOR for
    solid fills. Per the 5.1 source, `drawutils` converts ASS colours with BT.601 coefficients in
    YUV formats; the spike confirms or refutes this.
  - S-COLOR picks the cheapest candidate that passes P-COLOR and P-ENC. yuv420p wins when its
    delivered text-region SSIM is within 0.002 of the best. When the only failure is the BT.601
    colour, S-COLOR may instead make a colour-correct yuv420p/yuv444p path work, **provided the
    ASS bytes stay identical** for FFmpeg and JASSUB (G-DET).
- **R6. Fonts are locked down.** The FFmpeg subprocess (only) gets
  `FONTCONFIG_FILE=/app/resources/fontconfig/fonts.conf`, which lists only
  `/app/resources/fonts`. JASSUB loads the same files from `/api/resources/fonts/…`. A CI
  missing-glyph probe proves no other face is ever used.
  - **The same fallback on both sides.** fontconfig lists DejaVu Sans as the only fallback, and
    JASSUB gets `fallbackFont` = DejaVu Sans (the same file), never its bundled default.
  - P-TXT includes a glyph that Montserrat lacks and DejaVu has.
- **R7. Encode.** Standar (the only Essentials setting, equal to today's auto render):
  `libx264 -preset veryfast -crf 21`. ("Tinggi", `-preset medium -crf 18`, is deferred to
  Stage 2.) It uses:
  - `-profile:v high -pix_fmt yuv420p -g <2·⌈F⌉> -x264-params threads=4`;
  - `-filter_complex_threads 4` (pinned so that the `primary-worker` and `render-worker`
    containers run the same filter slicing);
  - BT.709/tv tags (`-color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv`);
  - `-map_metadata -1 -fflags +bitexact -flags:v +bitexact -flags:a +bitexact -movflags +faststart`;
  - AAC-LC 192 kb/s, 48 kHz, stereo (today 128 kb/s; decision K4).

  Pinned x264 threads make the bitstream identical in the `primary-worker` (6 CPUs) and the
  `render-worker` (4 CPUs); gate P-RT proves it.
- **R8. Hygiene.**
  - `-nostdin`; the graph goes through `-filter_complex_script`; sidecars (`captions.ass`,
    envelopes, derived PNGs) have constant names in a private 0700 temp directory.
  - **No user string ever reaches argv or the graph.** User text reaches FFmpeg only as
    `ass_escape`d ASS.
  - Inputs through `/proc/self/fd/N`; `-protocol_whitelist file,pipe` (FFmpeg 5.1 has no `fd` protocol; `/proc/self/fd/N` goes through `file`); `RLIMIT_AS` 3 GiB;
    wall-clock timeout; `-progress pipe:3`.
- **R9. Render key.**
  - `render_key = sha256("potongin-render-v1\0" ‖ plan_sha256 ‖ compiler_version ‖
    toolchain.json sha ‖ fonts.json sha ‖ packs sha ‖ size ‖ quality ‖ loudness/peak
    measurement sha)`.
  - `toolchain.json` is written at image build by `dpkg-query` for ffmpeg, libass9,
    libfreetype6, libharfbuzz0b, libfribidi0 and fontconfig, plus the base image digest. The
    `ffmpeg -version` line alone misses freetype/harfbuzz changes that alter glyph rasterisation.
  - `plan_sha256` covers the document's **content** (canonical bytes without `revision`,
    `parent_sha256` and `audit`), the words, camera plan, asset shas, ASS bytes and envelope
    bytes.
  - A renderer fix bumps `compiler_version` or `render_semantics`, so a new key is produced and
    old exports are re-rendered on request. This fixes defect #8 [R1 D8].
- **R10. Unchanged content = the auto file** (§4.6): the only exception to R9, and the guarantee
  behind "revisi 0 = klip otomatis".

### 5.3 Jump cuts

- Pieces come from §3.4. Video: every piece is a trimmed branch (R1) → layout (R4) → `concat`.
- Audio: every piece is `aresample=48000,pan=stereo|…,asettb=1/48000,atrim=start_pts=<a>:end_pts=<b>,asetpts=PTS-STARTPTS`
  where `a = ⌊in_sf·48000·den/num⌋` and `b = a + (smp(out_f0+frames) − smp(out_f0))`. Channel
  mapping is always an explicit `pan`: a mono source uses `c0=c0|c1=c0`, because the implicit
  upmix is −3 dB [PF].
- **Micro-fades at every join** live in the speech envelope (§5.6): a linear ramp to 0 over the
  last `cut_fade_ms` before the join and back to 1 over the first `cut_fade_ms` after it, clamped
  to half of each neighbour. The cold-open join uses `audio_fade_ms` (seed 30 ms), which is the
  shape and length of today's `afade` pair [REPO render.py].
- G-CLICK: the sample step at every join is below −40 dBFS. G-SYNC: 20 cuts plus a cold open end
  with A/V within 1 frame.

### 5.4 Captions and hook (`captions_ass.py` stays the only ASS generator)

`subtitles.build_frame_cues(words, pieces, fps, …)` generalises `build_caption_cues` to integer
ms and frames:
- at most 4 words per cue, or the pack's `words_per_cue`;
- a break on a gap over 600 ms, measured in **output time** after cuts (equal to source time for
  revision 0), or a sentence end;
- a cue shows for at least 300 ms, clamped by the next cue;
- no overlaps;
- cues **may** span jump cuts inside the body, because output time is continuous there, but never
  span the cold-open join.

For revision 0 (no removals) this is exactly today's behaviour.
`captions_ass.build_ass_v2(cues, play_res, fps, total_frames, pack, overrides, hook)` emits the
document using the frame-safe times of §3.4. The existing `build_ass` stays byte-compatible for
its current tests (the V1 and v2-shadow paths still call `render_vertical`).

| Pack (UI name) | Font | Size | Look | Reveal |
|---|---|---|---|---|
| `classic` (Klasik) | DejaVu Sans | today's `12/288·H` | White, black outline `H/150`, shadow `H/288`, bottom-anchored at `y_e5` | Static |
| `karaoke` (Karaoke) | DejaVu Sans Bold | `12/288·H` | Same metrics; spoken words switch to `highlight` (default `#FFE14D`) with `\k` and stay lit (today's karaoke) | `\k` sweep, onset = word frame |
| `bold` (Bold) | Montserrat ExtraBold (K6; DejaVu Sans Bold if declined) | `1.35 × 12/288·H` | UPPERCASE by default, white, black outline `H/90`, no shadow; the **active word** in `highlight` | One event per word window, the full cue text in each, only a colour change, so glyphs never reflow |
| `box` (Box) | Montserrat ExtraBold (K6) | `1.2 × 12/288·H` | White text on a black box at 75% opacity (`BorderStyle 3`, alpha on `OutlineColour`: the defect #1 fix), padding `H/100` | Static; ≤ 3 words and **one line per cue**. A cue wider than 88% of W (measured from the font's `hmtx`) is split, so there is never a 2-line box with overlapping translucent bands |

Common rules:
- **Overrides.** `y_e5` sets `MarginV = H − y`; `size_pm` scales the font size; `case: upper`
  uppercases with Python `str.upper()` at emission (the text itself is never rewritten).
- **Emphasis** (defect #6 fix). An emphasised word gets `{\1c&H…&}` (in karaoke also `\2c`) in
  the `emphasis` colour, and the colour is reset right after the word.
- **Escaping.** All user text goes through `captions_ass.ass_escape` (U+2060 after `\`; `{}`
  escaped; line-breaking characters become spaces; Cc/Cs dropped). This is the defect #3 fix.
- **Glyph coverage.** `edit_v2/glyphs.py` reads each pack font's `cmap` (stdlib `struct`). A
  character the font lacks raises `glyph_unsupported:U+XXXX`; emoji are Stage 2 PNG overlays.
- **Hook (`legacy-bar@1`).** Today's `_hook_layout`: boxed lines, up to 3, `\an8\q2\pos`,
  `\fad(150,250)`. The top is at `y_e5·H/100000`. `hook_overflow` is raised when
  `_hook_layout` has to cut the tail with "…".
- **Pack files** `resources/caption-packs/<id>/v1.json` hold integer parameters and are immutable.
  The `classic` and `karaoke` style lines must equal today's `build_ass` style lines for the same
  size (test), so revision 0 looks the same.
- **No pack ships without passing P-TXT.** Montserrat ExtraBold and the `BorderStyle 3` box
  were never measured across libass 0.17.1 (server) and 0.17.4 (JASSUB). If `bold` or `box`
  fails P-TXT in W1:
  - the pack falls back to DejaVu Sans Bold (the K6 alternative);
  - `box` may draw its background as a `\p` vector rectangle instead of `BorderStyle 3`;
  - the chosen variant is recorded in `docs/editor/SPIKES.md`.

### 5.5 Logo

- Upload normalisation is in §9.2. `derive_image` produces `derived/<sha16>@<w>x<h>.png` for the
  box of §3.4. It uses `scale=w:h:flags=lanczos`, then `format=rgba`, then
  `colorchannelmixer=aa=<opacity>`, so **the opacity is baked into the bitmap**. The PNG is
  written with ancillary chunks stripped, and FFmpeg overlays exactly this file at `(x0, y0)`.
- The browser draws the same PNG 1:1 at `(x0, y0)` with no scaling and no `globalAlpha`. The only
  remaining difference is the blend arithmetic (gate P-LOGO: box exact, mean abs ≤ 2 levels).
- The logo is drawn over the captions (`over_text` band). The export size equals the preview
  size, so one derived PNG serves both.

### 5.6 Audio: speech, music, ducking, loudness

1. **Speech.** Pieces (§5.3) → `concat` → `amultiply` with the speech envelope: micro-fades ×
   `audio.source.gain_cdb`. A source without audio uses `anullsrc` with the exact sample count.
2. **Music.** `-stream_loop -1` when looping → `atrim=start_sample=<src_in_smp>:end_sample=<src_in_smp+samples>`
   → `amultiply` with the music envelope → `amix=inputs=2:normalize=0:duration=first`.
   The music envelope is the product, in linear gain, of:
   - `gain_cdb`;
   - `fade_in_f` and `fade_out_f` as linear ramps;
   - **ducking**:
     - speech spans are the kept words in output samples `[smp(n_on), smp(n_off))`, merged when
       the gap is below `hold_ms`;
     - within a span the gain is `10^(−depth_cdb/2000)`;
     - it ramps down linearly over `attack_ms` *before* the span and back up over `release_ms`
       after `span_end + hold_ms`;
     - overlapping ramps take the minimum.

   Breakpoints are integers `[sample, round_half_up(g·10⁶)]`.
3. **Envelope files.** Python expands each envelope to mono f32 at 48 kHz, fed as
   `-f f32le -ar 48000 -ac 1 -i /proc/self/fd/M` and panned to stereo before `amultiply`.
   - Constant spans use `array('f', [g]) * n` (C speed); only ramps are computed in Python.
   - Budget: ≤ 150 ms for a 90 s clip.
   - Measured precision of this method: 7.4e-9 [INC-E3] and 1.5e-5 [PF].
4. **Master.** `mode: off` → gain 0 dB (seed; equal to today). `mode: normalize` uses two passes:
   1. `audio_measure` measures the pre-master mix;
   2. `gain = target − I`, clamped so that `TP + gain ≤ tp`;
   3. if the clamp costs more than 1 LU → warning `loudness_clamped` with the achieved value.

   Output then goes through `volume=<gain>dB,aresample=48000`. No limiter, no `loudnorm` (the
   single-pass `loudnorm` is what produced 96 kHz, defect #4), no `sidechaincompress`. The
   measurement is cached by the pre-master mix sha and reused by the export.
5. **Peak protection (always on, also with `mode: off`).**
   - When a music item exists or `audio.source.gain_cdb > 0`, `audio_measure` measures the
     pre-master true peak (cached by mix sha).
   - If `TP > −1.0 dBTP`, a constant negative gain `−1.0 − TP` dB is applied and the warning
     `peak_reduced` names the reduction.
   - Without it, `amix normalize=0` plus music, or a source gain up to +12 dB, would clip on
     playback and on platform re-encodes.
   - Revision 0 (no music, gain 0) is never measured or changed, so R10 and P-RT stay exact.
   - Gate G3b.
6. **Preview audio** = `audio_preview` of the same graph, written as FLAC s16. Its decoded PCM is
   bit-identical to the final render's pre-encode PCM quantised to s16 (gate P-AUD). The final
   only adds AAC encoding.
   - The browser decodes it into `new AudioContext({sampleRate: 48000})`, so `decodeAudioData`
     never resamples. (A device-rate context, often 44.1 kHz, would.)
   - The browser half of P-AUD checks that the AudioBuffer equals the reference PCM within 1 LSB.

### 5.7 Camera plan (face-track)

`edit_v2/camera.build_camera_plan(source, window_ms, fps, out_w, out_h)` runs today's
`detect_face_track` + `smooth_face_track` **once over the whole clip window** (sampling every
0.75 s, as today). It stores:
- source-time samples `[t_ms, center_pm]`;
- cut flags;
- `no_face` spans (runs with no detection longer than 1.5 s).

The file is immutable (`camera.<sha16>.json`). The pipeline uses it for the auto render (it
replaces the per-range detection inside `render.py`, a look change covered by P-LOOK) and the
editor uses the same file. The compiler converts it to integer per-frame crop positions (R4).
Detection over the ±60 s window costs roughly 2–3× today's per-range detection [E]. Only
face-track jobs pay it, and it has its own PF-PIPELINE budget. No face never means a silent centre: the crop holds the centre as
today, **and** every `no_face` span is listed in "Perlu dicek" with a jump-to target.

### 5.8 Revision 0 and the engine switch

1. **The pipeline change.** `pipeline._run_v3` writes, per clip: `source.json` (once per job),
   words, peaks, camera (face-track only) and `seed.json`. It then calls
   `edit_v2.render_edit.render_document(seed, …)` → `output/clip-NN.mp4` + `.srt`. The manifest
   clip gains `clip_id`, `render_engine: "edit-v2/1"`, `render_key` and `plan_sha256` (additive;
   `web/lib/jobs.mjs` passes `clipId` and `renderEngine` through).
2. **Flag.** `POTONGIN_RENDER_ENGINE=edit-v2|legacy`. The default stays `legacy` until the owner
   approves P-LOOK; `legacy` keeps today's `render_vertical` call byte-for-byte.
3. **Proofs.**
   - P-RT: re-rendering revision 0 in the render-worker container, bypassing the cache, gives a
     framemd5-identical video and an md5-identical decoded PCM.
   - The editor's instant export of an unchanged revision 0 hard-links the auto file.
4. **P-LOOK (one-off, at the switch).** New engine vs legacy on 20 real clips from the owner's
   jobs (prerequisite P3), including at least one 60 fps source, one VFR source and one
   face-track clip, because K3 and §5.7 change exactly those:
   - per-frame SSIM ≥ 0.98 at the best offset within ±1 frame (the grid rule may move a frame);
   - caption and hook bbox ±2 px;
   - integrated loudness within 0.5 LU.

   The deliverables are side-by-side sheets plus 3 MP4 pairs, for owner approval (K1).

### 5.9 Verification (`edit_v2/verify.py`)

| Gate | Check | On failure |
|---|---|---|
| **G1** container | H.264 High, yuv420p, W×H, SAR 1:1, CFR `num/den`, BT.709/tv tags, AAC-LC 48 kHz stereo, `faststart` | **Blocks** → `verification_failed` |
| **G2** A/V | Video frame count == `plan.frames` exactly (`-count_frames`); audio samples == `plan.samples` ± 1,024 | **Blocks** |
| **G3** loudness | Only with `normalize`: −14 ± 1 LUFS integrated, TP ≤ −1.0 dBTP (or the recorded `loudness_clamped` value ± 0.5 LU) | **Blocks** |
| **G3b** peak | With music or source gain > 0: TP ≤ −1.0 dBTP on the decoded export (§5.6 step 5) | **Blocks** |
| **G5** text-safe | Caption, hook and logo boxes vs the TikTok UI zone (720×1280: top 93 px, bottom 280 px, right 93 px), computed from plan geometry (margins, font size, line count, logo box) | Warning (today's 17% caption margin already touches this zone; see K5) |

G4 (blackdetect/freezedetect) is deferred (§1.3), because it costs a full extra decode per render
for a warning.

A blocking failure writes `verification_failed`, the state that exists today but is never written
[R1 §7.2], with an Indonesian message.

---

## 6. Strategi pratinjau per fitur (tingkat kejujuran)

### 6.1 Per feature

| Feature | What the viewer sees | Source of the pixels/samples | Honesty class | Proven by | While not current |
|---|---|---|---|---|---|
| Cuts, trims, cold open (timing) | Plate frame for `sf = inSf + (n − outF0)`; server audio mix | Server | **Exact** (same source frame and same samples as the final) | P-FRAME, P-SYNC, P-AUD | Hold the last exact frame; timeline band hatched; "Menyiapkan video (7/30)…" |
| Layout pixels (fit-blur, face-track, center-crop) | Plate cells from the same layout graph | Server (FFmpeg) | **Server pixels** at output size (720×1280 = the final size for every current job) | P-PLATE | Same as above |
| Captions and hook | JASSUB draws the **same ASS bytes** at `now_ms(n)` with the same font files | Browser libass | **Identical raster** (within P-TXT) against the server composite *before* encode; the export adds H.264/4:2:0 (bounded by P-ENC) | P-TXT, P-ENC, P-TIME, P-COLOR, G-DET (ASS sha of preview = export) | The previous exact ASS stays up; "Memperbarui teks…" (≤ 400 ms p95) |
| Logo | The derived PNG drawn 1:1 | Server bitmap, browser blend | **Identical bitmap**; blend within ±2 levels | P-LOGO | The previous box stays up |
| Music, ducking, source volume, loudness | The server mix (FLAC) is the audio clock | Server | **Exact samples** | P-AUD | Play waits (≤ 1 s p95): "Menyiapkan audio…"; after 3 s the option "Putar tanpa suara" appears |
| Waveform and markers | Peaks and events mapped through the time map | Server data | Exact positions | Time-map vectors | Always current (local) |
| Final pixels | "Frame akhir" button (Ctrl+Shift+R) | Server, production graph including 4:2:0 and an intra encode at the export CRF | **Ground truth** (up to encoder noise, P-ENC) | PF-TRUTH | n/a |
| Revision 0 before plate cells exist | The auto-render MP4 in `<video>`, frame-stepped with `requestVideoFrameCallback` | The same file as the export | **Exact** (only when `rev0.exact`) | P-RT | n/a |
| Unsupported browser (no WebCodecs or OffscreenCanvas) | Truth frames at the playhead; full editing and export | Server | Ground truth, no playback | n/a | "Pratinjau langsung butuh Chrome/Edge desktop" |

Rule: the stage badge reads **"● Sesuai hasil akhir"** only when every layer is current.
Otherwise it names what is pending. Pixels are never approximated or interpolated.

**What "sesuai" cannot mean.** This text is stated once, in the badge's help popover:

> "Frame, teks, logo dan audio sama dengan hasil akhir. File MP4 akhir dikompresi (H.264,
> warna 4:2:0), jadi tepi teks berwarna sedikit lebih lembut. Tekan 'Frame akhir' untuk melihat
> piksel persisnya."

The plate cells are a crf 18 encode, and the export is crf 21. Video under the text is therefore
the same frame in both, but not the same compressed bits.

### 6.2 Player design (`web/lib/editor/player/`)

- **Compositor.** One Canvas2D at the output size (720×1280 for every current job), CSS-scaled
  for display. Layers are drawn bottom-to-top per frame: plate frame → text bitmap → logo.
- **Clock and presentation.**
  - The clock is `AudioContext` playing the decoded mix; `getOutputTimestamp()` corrects for
    output latency.
  - Frame n is presented when the clock reaches `n·den/num`.
  - A frame is presented **only when all three layers for n are ready**; otherwise the previous
    frame stays up and a drop is counted (never a partial frame).
- **Plate source (Mediabunny 1.59.1, MPL-2.0, unmodified).**
  - Mapping: piece by binary search on `outF0` → `sf` → cell `k = ⌊sf / cellFrames⌋`, index
    `j = sf mod cellFrames` → `VideoSampleSink.getSample((j + 0.5)·den/num)`.
  - Decoders stay open for the current cell and for the next cell *in output order* (which may be
    a jump), pre-rolled ≥ 500 ms before every cut.
  - Frame LRU of 90. Cells start on an IDR frame; seeks measured 3.7 ms p50 and 8.6 ms p90 on
    short-GOP proxies [R3].
- **Text layer (JASSUB 2.5.16, exact pin).**
  - Manual render into an OffscreenCanvas in a worker, called with `now_ms(n)/1000`. The adapter
    is written in W1 for the parity harness and reused unchanged.
  - Fonts: `availableFonts` → `/api/resources/fonts/…`, `queryFonts: false`, `fallbackFont`
    DejaVu Sans (the same file as the server's fontconfig fallback, R6).
  - A new ASS (`text.assSha256` changed) is swapped in with `setTrack` between frames.
  - **Bitmap reuse.** When libass reports no change for frame n, the previous text bitmap is
    reused. With `\k` (step, not `\kf` sweep), text changes only at word onsets, cue edges and
    during hook fades, so PF-LIBASS applies to changed frames only.
- **Logo layer.** An `ImageBitmap` of the derived PNG, drawn with `drawImage(bitmap, x0, y0)`
  and no scaling.
- **Audio.** `decodeAudioData` of the mix into an `AudioContext({sampleRate: 48000})`, so the
  samples are the server's samples, not a resampled copy (≤ 300 s ⇒ ≤ 115 MB of float PCM). A
  new mix is swapped in while paused; an edit during playback pauses playback.
- **Seek and scrub.** Decode and draw of the target frame; budget PF-SEEK. Scrubbing is throttled
  to animation frames, and the playhead DOM is moved outside React (idea kept from
  `editor-timeline.mjs`).
- **Revision 0 fallback.** When `rev0.exact` and the cells for the playhead are not ready, a
  `<video>` of `autoRenderUrl` replaces the canvas. It switches to the canvas once ready.
- **Device check.** If JASSUB p95 exceeds 20 ms/frame over the first 60 frames, show "Perangkat
  lambat: pemutaran bisa patah-patah". Resolution is never lowered, so exactness is kept.

---

## 7. Desain saran AI

Rules for every task:
- **Heuristic first:** at most 300 ms p95 end-to-end, always shown.
- **LLM second:** asynchronous (202 + poll every 1 s), with an **overall task deadline of 20 s**
  enforced by a thread plus wait (as the pipeline does, since `llm.py` timeouts are per request
  and multiply across failover [V3 §llm.py]).
- **Settings come from the Pengaturan page, not only from `.env`.**
  - The Node route builds the child env exactly as `run-job.mjs` does:
    `engineProcessEnv(await loadLlmEnv(process.env))` from `web/lib/llm-settings.mjs`. That is
    the sealed settings in `/data/settings`, or the env fallback when no settings file exists.
  - If `loadLlmEnv` reports a problem, the LLM part is `disabled` with the same Indonesian
    message as the pipeline.
  - Inside Python, the client is `llm.create_llm_client_from_env(cache_dir=<job>/analysis/llm-cache)`
    (`FailoverLLMClient` + `CachedLLMClient`) over that env.
  - An optional `POTONGIN_LLM_EDITOR_MODELS` selects fast models for the editor (K13).
- **Task lifecycle.** The Node process owns the child. It SIGKILLs the child's process group at
  25 s and the child writes `suggestions/<task_id>.json` atomically; a missing file after the
  kill means `failed` / `timeout`. The route never accepts a provider, model or base URL from the
  request. `llm.py` already refuses redirects and non-local `http://`, so the editor adds no SSRF
  surface.
- **Grounding and validation** reuse the V3 validators (`llm_selection.packaging_problem`,
  `quote_overlap`, `tidy_packaging_text`). Invalid items are dropped with their reasons stored in
  the task file.
- **AI never writes the document.** Accepting a suggestion runs a normal undoable command with
  `origin: "suggestion:<id>"`.
- **Limits and failures.** At most 30 AI calls per job per hour, on top of `POTONGIN_LLM_RPM`.
  `POTONGIN_LLM=off` (global) or `POTONGIN_EDITOR_LLM=off` (editor only) hides every LLM button and keeps the instant suggestions. Any failure shows "Saran AI
  belum tersedia (kuota/koneksi); memakai saran otomatis".
- **Privacy.** Only the clip's own visible transcript text is sent. Keys stay server-side
  (`llm.py` redacts them). The UI notes that free provider tiers may use the data.

### 7.1 Hook text (`src/ai_clipper/editor_ai.py`, task `hooks`)

| Part | Design |
|---|---|
| Instant (no network) | Up to 5 variants, deduplicated (token Jaccard < 0.6), each **labelled by source**. Labelled "AI seleksi" (text already generated by the LLM during selection, reused at no cost): (1) the V3 `hook_text` from the seed; (2) the V3 title. Labelled "Heuristik" (hand-written rules): (3) the hook-unit sentence, tidied (`tidy_packaging_text`) and cut to ≤ 60 characters on a word boundary; (4) a question form when the unit `is_question`; (5) the strongest other sentence of the edited clip by the `hook_heuristics._analyse_unit` hook `strength` (skipping sponsor, greeting, outro, backchannel and pronoun-led units). Each variant carries `fit` from the same `_hook_layout` used for rendering: "muat" or "akan terpotong" |
| LLM prompt | `src/ai_clipper/prompts/editor_hooks_v1.md`, ≤ 3k input tokens: a ≤ 1.2k-token excerpt of `standar_klip_ai.md` (hook rules), the clip's **edited, visible** transcript as numbered lines `L0001…`, the current hook, the archetype. Output `{"hooks":[{"text","style":"pertanyaan\|klaim\|penasaran\|angka\|kutipan\|lucu","evidence":["L0003"]}]}`, 6 variants, `max_output_tokens` 800, `reasoning_effort: low` where supported |
| Validation | Length ≤ 60 characters preferred and ≤ 90 hard; no URL, @handle, hashtag or emoji (glyph coverage); evidence lines exist; **entity grounding**: every number, every capitalised non-initial token and every quoted span occurs in the clip text (case-folded, light `meN-/di-/-nya` stemming); a quote needs `quote_overlap ≥ 0.6`; not `disfluent`; Jaccard < 0.6 against the other variants |
| UI | Ghost cards under the hook text field: instant cards at once, "AI baru" cards when ready, each with its source label, "Pakai" (one undoable command) and the fit badge |
| Gates (QG-AI) | **Hard (block the LLM part):** offline, with a scripted client over 100 adversarial responses, 0 ungrounded entities accepted and 100% of the malformed JSON rejected; online, instant p95 ≤ 300 ms and LLM p95 ≤ 15 s with a hard stop at 20 s; owner check on 30 clips, at least one "AI baru" variant usable as-is on ≥ 70% of clips. **Informational:** blind pairs of "AI baru" vs the instant set. The owner's item 4 asks for AI suggestions, so a weak blind result is reported to the owner (K13) and fixed with prompt iterations in W5, never by silently shipping the button disabled. Only a failed hard gate keeps the LLM part behind its flag |

### 7.2 Cold-open candidates (heuristic only; `edit_v2/coldopen.py`)

- **Candidates.**
  - The V3 cold open (when present).
  - The sentence unit named by `hook_unit_id`.
  - The top 3 other sentence units in the window by `hook_heuristics._analyse_unit` hook
    `strength` (sponsor, greeting, outro, backchannel and pronoun-led units skipped).
- **Filtering.** Each candidate is word-snapped through `bounds` and must satisfy the §3.4 rules;
  it must not duplicate the body opening. Laughter within 800 ms after the unit extends the out
  point (`LAUGH_TAIL_SECONDS` [REPO selection_v3.py]).
- **UI.** A list in the cold-open panel with "Putar" (audition from the preview) and "Pakai".
- **LLM reranking** is Stage 2.

### 7.3 Rapikan: fillers, repeats and silent gaps (`edit_v2/cleanup.py`, no LLM)

| Class | Source | Default in the review list |
|---|---|---|
| `filler` | Lexicon `resources/lexicon/id-fillers.v1.json`: `eh ee eee e em emm ehm hmm hm anu` (hard fillers, from `hook_heuristics._FILLERS` minus the backchannel `heeh`) plus the phrase "apa namanya" | **Unchecked** until the precision gate passes (≥ 0.9 on 200 labelled tokens), then pre-checked |
| `repeat` | An immediate token repeat of a **function word or pronoun** ("gua gua", "yang yang", "di di", "ini ini", "jadi jadi"), or a repeated 2–3-word phrase within 1.5 s. **Never** Indonesian reduplication written without a hyphen by ASR ("hati hati", "pelan pelan", "sama sama", "masing masing", "anak anak", "jalan jalan"): a repeated content word is excluded unless ≥ 250 ms of silence separates the two tokens and the pair is not in `resources/lexicon/id-reduplication.v1.json` | Unchecked |
| `gap_silent` | A gap class `silent` > 600 ms (§3.6); the proposal shortens it to 200 ms, centred, snapped to frames inside the gap | Pre-checked |
| `gap_voiced` | Gap class `voiced` | Listed only, unchecked, with an audition button (78% of long gaps are voiced [UX-M2]) |
| Laughter | Gap class `laughter`, or any item within ±500 ms of a laughter event | **Locked**: never proposed |
| **Protected particles** | `sih dong kok lho loh deh kan ya yah nih tuh gitu kayak kaya lah mah toh nah kek` (plus `heeh`) | **Never listed.** Removable only when the user selects the word explicitly in the transcript |

- **Behaviour.** Items are shown in transcript order with context, and "Terapkan (n)" applies the
  checked items as **one** undoable transaction (removals with `reason` and
  `origin: "suggestion:cl_<n>"`).
- **UI copy** is honest: "Whisper sering tidak menulis 'eh/em', jadi daftar kata pengisi bisa
  pendek".
- **Gates.** 0 particle false positives and 0 reduplication false positives on the labelled set;
  filler precision ≥ 0.9 before auto-check (fillers ship **unchecked** until the owner confirms
  the labels at checkpoint 3); G-CLICK and G-SYNC on a clip after applying 20 items.

---

## 8. Delapan bug editor lama

The list is the owner's (ROADMAP §8), mapped to R1 evidence:

| # | Bug (ROADMAP) | R1 evidence | In Editor V3 (by construction) | Regression test in V3 | Legacy V2 editor (W4, T4.1; K8) |
|---|---|---|---|---|---|
| 1 | Caption background opacity has no effect | D1: box fill (4,4,4) at 0.3/0.65/1.0 | The `box` pack puts alpha on `OutlineColour` (BorderStyle 3) | Render a box over grey 128: fill = 32 ± 2 at 75% opacity (FFmpeg and JASSUB) | Fixed in `render_manifest._build_ass` (alpha on `OutlineColour`, verified approach in R1 `measure/bs4`) |
| 2 | Captions cut at about 64 characters | D6/P6: one cue for the whole window, char wrap + "…" | Word-level cues of ≤ 4 words from the words artifact; captions are never truncated | A 300-word clip: every visible word appears in exactly one event; no "…" in caption events | Long cues are split into sequential sub-cues timed by character share instead of "…" (render-only fix, works for existing manifests) |
| 3 | `\N` escape | D2: `\N`, `\h` injectable | Only `captions_ass.ass_escape` | Fuzz: `\N \h \n {\b1} {}`, RTL, emoji render literally (bbox check) | `_ass_escape` replaced by `captions_ass.ass_escape` |
| 4 | normalize → 96 kHz | D4: single-pass `loudnorm` | Two-pass constant gain + `aresample=48000`; G1 checks 48 kHz | normalize on → 48000 Hz, −14 ± 1 LUFS | `aresample=48000` after `loudnorm` + verification of 48 kHz |
| 5 | Logo never renders | D3: no `logo_assets_root`, no upload API | Asset store, upload route, derived PNG, compiler overlay | Upload → export → logo box present (P-LOGO) | Broken control hidden; "Buka di Editor V3" offered |
| 6 | Keyword colour does nothing | P21: `SecondaryColour` without `\k` | `word_edits.emphasis` + `overrides.emphasis`, inline `\1c` | Emphasised word fill = the swatch colour ± 4 (P-COLOR) | Control hidden (legacy data has no keyword marks); "Buka di Editor V3" |
| 7 | Saving dies after 1,000 saves | D5: receipts never pruned | Digest-only receipts, pruned to the newest 200 | 5,000 consecutive saves; receipts directory ≤ 200 files | The same pruning in `editor_api.py` |
| 8 | Old renders never re-render after a fix | D8: output key `revision-N.mp4` | Render key includes the compiler version and `render_semantics` | Bumping `compiler_version` changes the key and re-renders | Legacy output name gains the renderer version; `_verify_existing` checks it |

Also closed:
- D7 (loaded cues discarded) and D10 (preview font without fallback) disappear with the new
  editor.
- D9 (fixed 120 s timeout) → scaled timeout plus liveness.
- D11 (web tests that depend on the working directory): every new test resolves paths from
  `import.meta.url`.
- Not fixed in the legacy editor: its preview-parity gaps (R1 P1–P3 caption position, size and
  font; P15 center-crop focal point). Its stage gets the label "Pratinjau perkiraan — hasil
  akhir bisa berbeda" next to "Buka di Editor V3", so it never claims parity it does not have.

"Buka di Editor V3" for a V2 candidate: `edit_v2.seed.seed_from_candidate(candidate, job options)`
turns the candidate window into a clip (no cold open, no hook, caption pack from the job's style).
Existing legacy edits stay viewable and exportable in the legacy editor. Nothing is migrated
(Stage 2).

---

## 9. Keamanan

### 9.1 Application

- **Authentication.** `requireAuth` on every route; `proxy.js` already guards `/api/*`.
- **Sessions: unchanged in Essentials (K10 deferred).**
  - Today's stateless 30-day HMAC token stays; logout cannot revoke it [R1 §8].
  - Uploads do not widen what a stolen token can already do (it can delete projects), so this
    matches the repo's posture. Revocable sessions are Stage 2.
- **Child processes carry no secrets (E11).**
  - Every Python/FFmpeg child spawned by the `app` container gets the allowlisted env of
    `web/lib/python-cli.mjs`. This includes upload ingest, which parses untrusted files.
  - Only the AI task child receives LLM keys.
  - Test: a spawned child's `/proc/self/environ` contains none of `APP_PASSWORD`,
    `APP_SESSION_SECRET`, `POTONGIN_SETTINGS_SECRET` or `*_API_KEY`.
- **CSRF.** `sameOriginMutation` (Origin, Host, `Sec-Fetch-Site`) on every POST, PUT and DELETE.
  `Idempotency-Key` is required on edit PUT, render POST and asset POST.
- **Input.**
  - Bodies are streamed and counted: document 1 MiB, render 1 KiB, AI 1 MiB, assets per kind
    (§9.2).
  - IDs are validated by regex in Node before any spawn.
  - Python re-validates everything (integers only, unknown keys, NFC, no Cc/Cs, sizes).
  - Errors map to fixed codes and never echo paths or text.
- **Process boundary.** `execFile` without a shell; bounded IO; timeout + SIGKILL; a fixed
  exit-code map (reusing the `edit-document.mjs` pattern).
- **Filesystem.** `O_NOFOLLOW`; realpath containment for every served file; content-hash names
  only; atomic tmp → fsync → rename; 0600 files and 0700 directories; caches written to temp and
  renamed.
- **FFmpeg.** The client never sends ASS, filtergraphs or paths. Every graph is generated from the
  validated document. The escape fuzz covers `\N {\b1} \h`, RTL and emoji. R8 hygiene applies
  (§5.2).
- **Headers.**
  - The editor route sends `Cross-Origin-Opener-Policy: same-origin` and
    `Cross-Origin-Embedder-Policy: require-corp` from W2 (JASSUB threads).
  - Every new route and the editor page send `X-Content-Type-Options: nosniff`.
  - The editor page sends `Content-Security-Policy: frame-ancestors 'none'` (a header-only CSP
    directive; no script policy yet).
  - The full nonce CSP and self-hosted UI fonts are deferred to Stage 2 (§1.3). COEP does not
    block the Google Fonts `@import`, because fonts load in CORS mode.
- **Rate limits.** `preview/plan` ≤ 10/s, `preview/frame` ≤ 4/s, AI ≤ 30 per job per hour,
  uploads ≤ 30/min, per session.
- **Resource exhaustion.**
  - Renders keep the storage-admission reservation.
  - Preview caches have an LRU cap per job (K11) and are counted by the storage scan.
  - Receipts and render requests are pruned; archives follow the retention policy.
- **LLM.** Keys stay server-only and reach only the AI task child (from the sealed settings via
  `loadLlmEnv`); only clip text is sent; `POTONGIN_LLM=off` is honoured; no request field can
  change the provider, model or base URL.

### 9.2 Uploads (`edit_v2/assets.py`, `png_strip.py`, `web/lib/asset-upload.mjs`)

| Step | Rule |
|---|---|
| Transport | Raw body, no multipart. `Content-Type` allowlist: logo `image/png`, `image/jpeg`, `image/webp`; music `audio/mpeg`, `audio/mp4`, `audio/wav`, `audio/ogg`, `audio/flac`. `Content-Length` required. Caps: logo 10 MB, music 50 MB. `X-Asset-Name` ≤ 80 chars NFC (display only). A storage-admission reservation comes first. Per job: ≤ 50 assets and ≤ 1 GB |
| Quarantine | `analysis/assets/.incoming/<uuid>` opened `O_EXCL\|O_NOFOLLOW`, 0600; hashed and counted while streaming; aborted at the cap |
| Sniff | The first 64 bytes must match the declared type (PNG, JPEG, WebP `RIFF…WEBP`, MP3 frame sync or `ID3`, MP4/M4A `ftyp`, WAV `RIFF…WAVE`, Ogg `OggS`, FLAC `fLaC`). **Rejected:** SVG (the image's FFmpeg links librsvg [UX]), GIF, HEIC, PDF, fonts, archives, playlists, concat scripts |
| Ingest | `python -m ai_clipper.edit_v2.assets ingest`: no shell; allowlisted env (E11); input via `/proc/self/fd/N`; **forced demuxer** from the sniff (`-f png_pipe\|jpeg_pipe\|webp_pipe\|mp3\|mov\|wav\|ogg\|flac`); `-enable_drefs 0` for `mov`; `-protocol_whitelist file,pipe`; `RLIMIT_AS` 2 GiB; CPU and wall timeouts (image 20 s, audio 60 s); `-threads 2`; non-root. Probe caps: images ≤ 4096² and ≤ 16.7 MP (the `_verify_raster` limits); audio ≤ 15 min, exactly one audio stream and no video stream other than cover art (dropped) |
| Normalise | **Images:** EXIF orientation applied (FFmpeg 5.1 does not do this for JPEG: a stdlib parser reads only the Orientation tag, and the value maps to `transpose`/`hflip`/`vflip`) → sRGB RGBA PNG ≤ 1024 px on the long edge → ancillary chunks stripped by `png_strip.py` (keep only IHDR, PLTE, tRNS, IDAT, IEND; stdlib). **Audio:** AAC-LC 192k, 48 kHz, stereo (explicit `pan`), with `ebur128` LUFS and peaks stored in `<sha>.json` |
| Identity | `sha256(normalised bytes)`. The original is deleted; the name is kept only for display |
| Serve | Allowlisted `Content-Type`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: same-origin`, `Content-Disposition: inline; filename="asset.<ext>"`, Range |
| Use | Documents reference `sha256:` ids only. The compiler resolves them under the fixed asset root, which the worker now receives (the defect #5 root cause). Music uploads show a one-time copyright (Content ID) notice |
| Gate QG-SEC | A fuzz corpus generated by script (not stored): truncated and malformed PNG/JPEG/WebP/MP3/M4A; PNG+ZIP and MP4+HTML polyglots; SVG renamed `.png`; a decompression-bomb header; a 10 h silent MP3; MKV with external references; an HLS playlist renamed `.mp4`; an FFmpeg concat script; path-traversal names. **100%** are rejected or safely normalised within their time cap, with no 5xx |

---

## 10. Gerbang kualitas dan anggaran performa (angka)

All media in tests is self-made or synthetic (no YouTube media in the repository). References are
produced **inside the production image** (`ai-video-clipper:<tag>`; FFmpeg 5.1.x and libass 0.17.1
exactly as pinned in `resources/toolchain.json`, E10). Any change to `toolchain.json` or the
JASSUB pin re-runs P-TIME, P-TXT, P-ENC, P-COLOR and P-RT before merge.
The browser side runs on Chrome for Testing 147.0.7727.15 through Playwright 1.62.1 (already a
dev dependency). "PR" = on every pull request; "Nightly" = scheduled; "Exit" = required at the
named wave exit.

### 10.1 Parity gates (preview vs final)

| Gate | What is compared | Threshold | When |
|---|---|---|---|
| **P-FRAME** | Source frame shown for each output frame: plate cells, final render and browser presenter, each against the whole-file `fps=F` grid; barcode sources at 29.97 CFR, 25, 30 and VFR, with 20 cuts and a cold open | **0 mismatches** over ≥ 2,000 frames (300 on PR) | PR, Nightly, W1 (server), W2 (browser) |
| **P-TIME** | First and last visible frame of every caption and hook event and every karaoke/active-word onset: FFmpeg `ass` and JASSUB, each against the plan frame, hazard frames included, at 24, 25, 30, 24000/1001 and 30000/1001 | **0 mismatches** | PR, W1, W2 |
| **P-TXT** (raster parity) | Text over a plate frame: JASSUB canvas vs the FFmpeg `reference` of the same frame and size, **taken before the final 4:2:0 conversion** (the composite in the S-COLOR format, converted to RGB with the BT.709 matrix), RGB | SSIM ≥ **0.999**, PSNR ≥ **45 dB**, max channel diff ≤ **16**, **0 px** > 16. Matrix: 4 packs × {10, 40, 90 chars} × 5 timestamps + hook + one fallback-glyph case (measured 0.99925/15 yuv444p, 0.9998/13 RGB [PF]; Montserrat and the box pack unmeasured, see §5.4) | PR (subset), Nightly, W1, W2 |
| **P-ENC** (delivered file) | The **exported MP4**, decoded, vs the lossless `reference` of the same frames; text regions = union of the plan's caption/hook boxes | Whole frame SSIM ≥ **0.990**; text regions SSIM ≥ **0.980**. The W1 baseline is recorded; afterwards a drop of more than 0.002 from the baseline fails. This is the honest bound behind "Sesuai hasil akhir" | W1 (baseline + S-COLOR), Nightly |
| **P-COLOR** | Interior glyph fill of every swatch colour and the box fill: the **exported MP4** (decoded as tagged BT.709) vs JASSUB | \|ΔR\|,\|ΔG\|,\|ΔB\| ≤ **4** | W1 (decides S-COLOR), Nightly |
| **P-PLATE** | Browser-decoded plate frame vs the final `reference` frame with text and logo disabled; crop x decoded from a **column-ruler** test pattern (T1.0 media) | SSIM ≥ SSIM(final encode vs reference) − **0.002** [INC E1 relative gate]; crop x **0 px** difference on every frame, including across cuts and cell boundaries | W2, W3 (per layout), Nightly |
| **P-LOGO** | Logo region: browser vs final | Box position and size exact (0 px); mean abs diff ≤ **2**; max ≤ 8 | W2 (fixture asset), W3 |
| **P-AUD** | Server: preview FLAC decoded PCM vs the final graph's pre-encode PCM (`reference`, s16). Browser: the `AudioBuffer` from `AudioContext({sampleRate: 48000})` vs the same PCM | Server **md5 equal**, sample count == `plan.samples`; browser max abs diff ≤ **1 LSB** (1/32768), same sample count | PR, W1, W2 |
| **P-SYNC** | Browser, instrumented (headless Chrome cannot "hear"): for each presented frame n at 20 cuts, the audio position from `AudioContext.getOutputTimestamp()` at presentation vs `smp(n)` | ≤ **1 frame** p99 on the reference laptop | W2 |
| **P-RT** | Revision 0 re-rendered in `render-worker` (cache bypass) vs the auto render from `primary-worker`; plus R10: an unchanged document (also after all edits undone, also with a changed `toolchain.json`) exports the auto file itself (same inode) | Video framemd5 **identical**; decoded PCM md5 **identical**; R10 hard link 100% | W2, Nightly |
| **P-LOOK** | New engine vs legacy `render_vertical`, 20 real clips incl. a 60 fps, a VFR and a face-track source (one-off at the switch) | SSIM ≥ 0.98 at the best offset within ±1 frame; caption/hook bbox ±2 px; loudness ±0.5 LU; **owner approval** | W2 (kit), before the K1 flip |

### 10.2 Render and data gates

| Gate | Threshold | When |
|---|---|---|
| **G1–G3, G3b, G5** | §5.9 (G1–G3 and G3b block, G5 warns) | Every render |
| **G-SYNC** | 20 cuts + cold open: A/V end ≤ 1 frame; caption onset = plan frame | PR |
| **G-CLICK** | Sample step at every join < −40 dBFS | PR |
| **G-DET** | Same document + assets + engine → identical `plan_sha256`, ASS bytes, graph string and envelope bytes; the preview ASS sha equals the export's ASS sha | PR |
| **G-FAIL** | Every failure or degraded path (missing asset, FFmpeg error, timeout, cancel → fixed error code; no face, missing glyph, clamped loudness → named warning) carries an Indonesian message; nothing falls back silently | PR |
| **Duck** | Music-only stem during speech = unducked − `depth` ± 0.5 dB after `attack`; back within 1 dB of unducked by `release + 50 ms` after span end + hold | W1 (synthetic), W3 (export) |
| **QG-PERSIST** | 5,000 consecutive saves (in-process in W1, over HTTP in W2): no lockout; receipts ≤ 200 files; crash-reconciliation tests; reload loses ≤ 2 s of work | W1, W2 |
| **QG-UNDO** | 10,000 random command sequences: undo-all == initial and redo-all == final (canonical bytes); 1,000 sequences cross-checked: every intermediate document accepted by the Python validator | W2 |
| **QG-CONFLICT** | Two tabs edit the same clip: both edits survive (auto-merge) or the per-part dialog appears; no draft is lost | W2 |
| **QG-SEC** | Upload fuzz 100% rejected or normalised without 5xx; CSRF and auth matrix on every mutation; editor headers; **no secret in any spawned child's env** (`/proc/<pid>/environ` checked for ingest, preview, api and AI children; only the AI child holds LLM keys); ID regexes (job, clip, render, task, asset, idempotency key) in Node and Python; AI route rejects any extra body field | W2 (routes + env), W3 (fuzz), W4 (all) |
| **QG-AI** | §7.1 | W3 |
| **QG-CLEAN** | 0 particle and 0 reduplication false positives on the labelled set; filler precision ≥ 0.9 before pre-check; **automated cut-edge check** on every cut of 20 applied items: each edge lies inside the word gap `[a.e, b.s]` (or is flagged `tight`), and the RMS over ±10 ms around the edge is ≤ −35 dBFS unless `tight`; G-CLICK and G-SYNC after the 20 items | W3 |
| **G3b** | Every export with music or source gain > 0: true peak ≤ −1.0 dBTP (decoded export) | Every render; W1 (synthetic), W3 (export) |
| **QG-A11Y** | axe: no critical or serious violations on the editor page; every action reachable by keyboard | W2, W4 |
| **QG-UX** | Owner (or a stand-in clipper) on the reference laptop at 1366×768 and 1920×1080: **U1** fix a clipped first word ≤ 20 s; **U2** remove a 5 s ramble via the transcript ≤ 20 s; **U3** replace the cold open ≤ 45 s; **U4** apply a suggested hook and switch the pack ≤ 30 s; **U5** add a logo and ducked music ≤ 60 s; **U6** export and download ≤ clip length + 30 s; **U7** reload mid-edit and lose nothing; "Kembali ke versi AI" found ≤ 20 s | Owner checkpoint 2 (U1, U6, U7), checkpoint 3 (U1–U7). W2/W3 exits use the scripted e2e versions of the same tasks with the same time limits |

### 10.3 Performance budgets

The reference laptop is a Core i5-1135G7 or Ryzen 5 5500U with 8 GB, integrated GPU, Chrome
stable, at 1366×768 and 1920×1080 (K15). Server numbers are for the production containers.

| Budget | Target | Basis |
|---|---|---|
| **PF-OPEN** | Editor interactive (transcript + stage showing revision 0) ≤ 2.0 s p95 on a repeat visit, ≤ 3.0 s on the first; first plate cell at the playhead ≤ 2.0 s after `prepare` | CLI round trip 70–90 ms [R1]; cell 0.56 s [INC-E1] |
| **PF-CELLS** | All cells of a 60 s clip ≤ 15 s (fit-blur, center-crop) and ≤ 25 s (face-track, including the camera plan), semaphore 2 | 0.56 s per cell with a box blur [INC-E1]; `gblur` adds ≈ 36% [R3] [E] |
| **PF-SEEK** | Paused seek → frame on screen ≤ 50 ms p95 | Short-GOP seek 3.7/8.6 ms [R3] |
| **PF-PLAY** | 0 dropped frames at cuts; ≤ 1 dropped frame per 10 s at 30 fps on a 20-cut clip | S-PLAY [FINAL] |
| **PF-PLAN** | Last keystroke → new text on the stage ≤ 400 ms p95 (120 ms debounce + server ≤ 200 ms p95 + `setTrack` ≤ 40 ms) | `setTrack` + render p95 23.9 ms [UX-M4] |
| **PF-AUDIO** | Edit → fresh mix ≤ 1.0 s p95 for a 90 s clip with music | [E]; checked in W2 |
| **PF-TRUTH** | ≤ 0.6 s p95 at 720×1280 (the truth frame now includes the 4:2:0 step and a 1-frame intra encode) | 0.16–0.20 s without the encode [R3]; the encode adds ≈ 0.1 s [E] |
| **PF-SAVE** | PUT p95 ≤ 300 ms | 80–90 ms CLI [R1] |
| **PF-LIBASS** | JASSUB ≤ 12 ms p95 per **changed** frame at 720×1280 for the heaviest pack (`bold`, one event per word); unchanged frames reuse the bitmap (§6.2) | 29 ms at 1080×1920 headless [UX-M4]; 720p has 44% of the pixels [E] |
| **PF-RENDER** | Final 720×1280 on 4 CPUs: p50 ≤ 0.4×, p95 ≤ 0.6× clip length | 60 s fit-blur today 14.7 s = 0.25× [R1]; compositing +19–40% [PF] |
| **PF-PIPELINE** | V3 job with the new engine vs legacy wall time, per layout: fit-blur and center-crop ≤ **1.35×**; face-track ≤ **1.6×** [E] (camera plan over the ±60 s window) | Words + peaks + compositing (+ camera for face-track) |
| **PF-MEM** | Editor tab ≤ 1.2 GB for a 300 s clip | Decoded audio ≤ 115 MB + frame LRU |

If PF-PLAN misses its target because of Python start-up, T4.3 adds a persistent preview worker (a
stdin/stdout JSON-lines process per app container, restarted on crash). That is a contingency,
not the default.

---

## 11. Rencana gelombang (4 workflow, 30 agen, + cadangan W5 ≤ 4 agen)

### 11.0 Aturan main untuk semua gelombang

- **Budget and realism.**
  - By FINAL's own sizing, the Essentials subset is roughly 40–55% of Stage 1
    (≈ 100–140 agent-days [E]). 30 agent runs are enough only if each run delivers 3–5
    agent-days of work. That is plausible for the M tasks and tight for the 12 L tasks.
  - The plan therefore has three safety valves:
    1. the cuts in §1.3;
    2. a **reserve workflow W5** (≤ 4 agents, §11.5), run only if an exit gate fails or the
       owner asks for rework at a checkpoint (fix-forward, no new scope);
    3. a **deferral rule**: if W5 cannot close a gap, the owner defers one *whole* owner item
       behind its flag, never a half feature. Recommended order: 10 markers → the LLM part of 4
       (the instant suggestions stay) → face-track in 7 (fit-blur and center-crop stay).
  - The maximum is 5 workflows.
- **Prerequisites (before W1).**
  - **P0.** The V3 work on `feat/selection-v3-llm` is committed and merged into `main`
    (ROADMAP §10). Editor V3 starts on `feat/editor-v3-esensial` from `main`.
  - **P1.** The owner decides K1–K6 provisionally (§12); S-COLOR supplies the data for K2 inside
    W1. K10 and K14 are deferred.
  - **P2.** Chrome for Testing 147.0.7727.15 is installed for Playwright on the dev machine and in
    CI.
  - **P3.** The owner provides ≥ 3 real V3 jobs (≥ 20 clips in total, including a 60 fps, a VFR
    and a face-track source), copied from `/data/jobs` to a local path the agents can read.
    Needed for P-RT (real), the P-LOOK kit, QG-AI and the filler labels. No media is ever
    committed.
- **Owner checkpoints (the only times the owner is needed).**
  1. **Before W1** (≈ 10 min): K1–K6 provisional, K7–K9, K11–K13, K15.
  2. **After W2** (≈ 30 min): the P-LOOK sheets (K1), and U1, U6 and U7 on the reference laptop.
  3. **After W4** (≈ 60 min): U1–U7 acceptance, the QG-AI 30-clip review and blind pairs, and
     confirmation of the filler labels (which turns the filler pre-check on).
- **Workflow shape.**
  - Phase A (optional, 1 agent) freezes contracts.
  - Phase B runs in parallel; **file ownership is disjoint** inside the wave.
  - Phase C (1 integrator agent) merges, owns the hot files, fixes seams (it may patch any file of
    its wave; every patch is logged in `docs/editor/GATES.md`) and runs the wave exit gate.
  - Each phase-B agent works in its own git worktree off the wave base, and the integrator merges
    in the listed order.
  - **Scaffolding before a wave, not during it.** The integrator of wave *n* lands the skeleton
    that wave *n+1* fills: registries listing **every** panel and lane of the next wave, a
    placeholder component per file, the fakes and the shared helpers. Phase-B tasks then
    **replace their own placeholder files** and never edit a registry, so no two agents touch the
    same file. (This fixes the T2.6/T2.7 and W3 panel-mounting conflicts of revision 1.)
- **TDD protocol.** Every task first commits failing tests (the lists below), then the
  implementation, then refactoring. UI tasks write Playwright specs first, running against fakes
  (`web/components/editor/__dev__/fakes.mjs`, landed by T1.Z) until the integrator wires the real
  modules.
- **Test hygiene.** `tests/conftest.py` (new, T1.0) contains fixtures only, never `autouse`.
  Gate evidence goes to one file per task and gate: `docs/editor/evidence/W<n>/<task>-<gate>.json`.
- **Contracts.** Appendix A (Python and JS signatures), §3 (document), §4.3 (plan DTO) and §4.2
  (routes) are frozen. A change needs the wave integrator's approval and an update of
  `docs/editor/CONTRACTS.md` in the same PR.
- **Definition of done (every task).**
  - Its tests pass, and `uv run ruff check src tests`, `uv run pytest`, `npm test` and
    `npm run build` stay green.
  - No new Python runtime dependency (`dependencies = []` stays).
  - npm additions only as listed (jassub 2.5.16 and mediabunny 1.59.1, exact pins).
  - Flags stay **off** by default.
  - Gate evidence is written as small JSON files under `docs/editor/evidence/W<n>/` (numbers
    only, no media) and summarised in `docs/editor/GATES.md`.
- **Sizes.** S ≤ 600 lines including tests, M 600–1,500, L 1,500–3,000 [E].
- **Flags** (env, passed through `compose.yaml` by integrators):
  - `POTONGIN_RENDER_ENGINE=legacy|edit-v2` (default `legacy` until K1);
  - `POTONGIN_EDITOR_V3=off|on` (the Edit button and routes);
  - `POTONGIN_EDITOR_UPLOADS=off|on` (on only after QG-SEC, W4);
  - `POTONGIN_EDITOR_LLM=off|on` (the LLM part of item 4; on after the QG-AI hard gates);
  - `POTONGIN_PARITY_HARNESS` (dev and CI only).

| Wave | Agents | Phase A | Phase B | Integrator |
|---|---|---|---|---|
| W1 | 8 | T1.0 | T1.1, T1.2a, T1.2b, T1.3, T1.4, T1.5 | T1.Z (+ toolchain pin + W2 scaffolding) |
| W2 | 8 | — | T2.1, T2.2 (+ queue v3), T2.3, T2.4, T2.5, T2.6, T2.7 | T2.Z (+ W3 scaffolding) |
| W3 | 8 | — | T3.1–T3.7 | T3.Z |
| W4 | 6 | — | T4.1–T4.5 | T4.Z |
| W5 (reserve) | ≤ 4 | — | Only failing gates or checkpoint rework | T5.Z |

### 11.1 Wave W1: "Mesin tunggal" (server core, no UI): 1 + 6 + 1 agents (T1.0; T1.1, T1.2a, T1.2b, T1.3, T1.4, T1.5; T1.Z)

Goal: the single compiler renders any Essentials document on the fixture job, with every
server-side parity gate green. Nothing changes for users yet.

#### T1.0 Contracts and time foundations (phase A, serial) · M
- **Owns:**
  - `src/ai_clipper/edit_v2/{__init__,errors,timemap,clip_id}.py`;
  - stubs with the Appendix A signatures that raise `NotImplementedError` for `doc, store, api,
    captions, glyphs, plan, compile_ffmpeg, layouts, execute, verify, derive, audio_graph, envelope,
    loudness, source_info, words, peaks, camera, seed` (each stub passes to its phase-B owner);
  - `tests/conftest.py` (fixtures only); `tests/support/edit_v2_media.py` (barcode video with
    the frame index as a 24-bit block code **plus a column ruler**, i.e. the source column index
    encoded in a stripe, so crop x is decodable from any output frame; tone bursts with click
    markers; generated through FFmpeg lavfi and raw frames, never stored); `tests/support/edit_v2_fixtures.py` (document, words and plan
    builders);
  - `tests/fixtures/edit_v2/docs/{valid,invalid}/*.json` (≥ 40 valid; ≥ 60 invalid, each file
    named after its expected error code);
  - `scripts/edit_v2/gen_timemap_vectors.py` + `tests/fixtures/edit_v2/timemap-vectors.json`
    (≥ 500 vectors: pieces, `out_f0`, word frames, src↔out, samples, `now_ms`/`safe_cs`
    including hazard frames);
  - `tests/test_edit_v2_{timemap,clip_id}.py`;
  - `docs/editor/CONTRACTS.md`.
- **Consumes:** this plan.
- **Produces:** the frozen contracts, the time map, clip identity and the test media generators
  every other task uses.
- **TDD:**
  - time-map property tests: monotonic; Σ frames; delete then restore is byte-identical; pieces
    under 2 frames drop;
  - samples at 29.97 over 10 h with zero drift;
  - `safe_cs`: 0 failures at 24, 25, 30, 50, 60, 24000/1001, 30000/1001 and 60000/1001 over 3 h
    (port of `ass_time_rule.py`);
  - `now_ms` reproduces FFmpeg's double expression on the hazard list;
  - `clip_id` vectors, including "selection re-run gives the same id";
  - vector generation is deterministic (a second run is byte-identical).
- **Acceptance:** every stub imports; pytest is green; the contracts are published.

#### T1.1 Document validation, store and edit API (Python) · L
- **Owns:** `edit_v2/doc.py`, `edit_v2/store.py`, `edit_v2/api.py`,
  `tests/test_edit_v2_{doc,store,api}.py`.
- **Consumes:** T1.0; the private helpers of `edit_manifest.py` (`_read_regular`, `_atomic_write`,
  `_fsync_directory`, the lock pattern), imported and **not modified**; `selection_v3`,
  `transcript_io` (read-only).
- **Produces:**
  - `parse_doc`, `validate_doc`, `canonical_bytes`, `doc_sha256`, `content_sha256`, `content_equals_seed` (R10);
  - the store (`get`, `put`, `seed`, `archive_for_render`, `prune_receipts`);
  - the CLI `python -m ai_clipper.edit_v2.api`: stdin envelope, ops `clips|prepare_job|get|put|seed|archive` (`prepare_job` calls T1.5's `seed.prepare_legacy_job` through its contract);
    exit codes 0 ok, 3 invalid, 4 not found, 5 conflict, 6 semantic, 7 too new, 8 analysis
    missing, 9 idempotency.
- **TDD:**
  - every fixture is classified with its exact code;
  - floats, duplicate keys, NaN and unknown keys are rejected;
  - every §3.3/§3.4 rule, with a positive and a negative case;
  - `GET` of a seed writes nothing (directory listing before and after);
  - PUT rules and server stamping of `updated_at_ms`;
  - receipts: replay, conflict, crash reconciliation (ported cases from `test_editor_api.py`),
    pruning to the newest 200 committed receipts (pending ones kept), a retry after pruning;
  - a 5,000-save soak in process;
  - archive naming and gzip;
  - `base_changed`; a changed words sha → `readOnly`;
  - the `clips` listing from `selection.v3.json` plus the manifest, including a legacy-engine job.
- **Gates:** QG-PERSIST (in process); in-process PUT p95 ≤ 30 ms for a 100 KB document.

#### T1.2a Text (Python): captions, hook, packs, fonts · L
- **Owns:**
  - `src/ai_clipper/{subtitles,captions_ass}.py`, `edit_v2/{captions,glyphs}.py`;
  - `resources/caption-packs/{classic,karaoke,bold,box}/v1.json`,
    `resources/hook-designs/legacy-bar/v1.json`;
  - `resources/fonts/**`:
    - DejaVu Sans and Sans Bold at the exact bytes of Debian bookworm `fonts-dejavu-core`;
    - Montserrat ExtraBold if K6, from a pinned upstream release URL + sha256 recorded in
      `fonts.json`; if the agent has no network, the owner drops the file in at checkpoint 1;
    - `fonts.json` with sha and licence; `OFL.txt` and `LICENSE-DejaVu.txt`;
  - `resources/fontconfig/fonts.conf` (DejaVu Sans as the only fallback, R6);
  - `tests/test_{subtitles,captions_ass}.py` (additions only), `tests/test_edit_v2_{captions,glyphs}.py`.
- **Consumes:** T1.0.
- **Produces:** `build_frame_cues`, `build_ass_v2`, the pack loader, glyph coverage,
  `edit_v2.captions.caption_track(doc, words, pieces) → CaptionResult`, and the `\p`-box
  variant of `box` (used only if P-TXT fails for `BorderStyle 3`, §5.4).
- **TDD:**
  - frame cues reproduce `build_caption_cues` on its existing cases (converted to frames);
  - cues span jump cuts inside the body and never the cold-open join; the 600 ms gap is
    measured in output time;
  - hidden and removed words are excluded; a 300-word clip is never truncated;
  - escape fuzz;
  - the `classic` and `karaoke` style lines equal `build_ass`;
  - `bold`: one event per word, identical glyph string across events, only `\1c` differs;
  - `box`: ≤ 3 words and one line per cue, split when wider than 88% of W (from `hmtx`);
  - emphasis colour; `y_e5`, `size_pm` and `case`; hook `y_e5` and `hook_overflow`;
  - event times equal `safe_cs`; `\k` sums equal the cue length;
  - 😂 is flagged for DejaVu; the `fonts.json` sha check; the missing-glyph probe shows no
    fallback face other than DejaVu Sans in FFmpeg.
- **Gates:** P-TIME, FFmpeg side (0 mismatches); ASS goldens for all 4 packs + hook.

#### T1.2b Text parity harness (browser) and spike S-COLOR · L
- **Owns:**
  - `scripts/parity/{reference_text.py,compare.py,s_color.py,enc_check.py}`;
  - `web/lib/editor/player/text-layer.mjs` (the JASSUB adapter: manual render at
    `now_ms(n)/1000`, `fallbackFont` DejaVu Sans, bitmap reuse on "no change");
  - `web/app/parity-harness/page.jsx` and `web/app/api/parity-fixtures/[...path]/route.js`
    (both 404 unless `POTONGIN_PARITY_HARNESS=1` and the user is authenticated);
  - `web/e2e/parity-text.spec.mjs`;
  - `web/package.json` and the lock (jassub 2.5.16 and mediabunny 1.59.1, exact; a
    `test:parity` script);
  - `docs/editor/SPIKES.md`.
- **Consumes:** T1.0; T1.2a's ASS output through the Appendix A contract. Until merge, it uses
  ASS goldens generated by today's `captions_ass.build_ass` plus hand-written Bold/Box samples.
- **Produces:** the text parity harness, the P-ENC measurement tool, and the **S-COLOR
  decision**:
  - candidates yuv420p, yuv444p and gbrp, scored on P-TXT (raster), P-ENC and P-COLOR on the
    **exported MP4**, and on render cost at 720×1280;
  - the pack variant decisions (Montserrat or DejaVu Bold; `BorderStyle 3` or `\p` box).
- **TDD:** the harness's own comparison code has unit tests (SSIM/PSNR on known image pairs,
  box-region masks); the adapter's time conversion equals `now_ms` on the hazard list.
- **Gates:** P-TIME, JASSUB side (0 mismatches); P-TXT; P-ENC baseline; P-COLOR; S-COLOR and pack
  variants recorded in `SPIKES.md`.

#### T1.3 Video compiler, execution and verification · L
- **Owns:** `edit_v2/{plan,compile_ffmpeg,layouts,execute,verify,derive}.py`;
  `tests/test_edit_v2_{plan,compile,execute,verify,derive}.py`;
  `tests/fixtures/edit_v2/goldens/*.txt`; `scripts/parity/frame_identity.py` (a port of the PF
  spike against the compiler).
- **Consumes:** T1.0. `caption_track` (T1.2a) and the audio fragment (T1.4) through their
  Appendix A contracts; tests use stubs until the integrator connects them. From `render.py`
  (imported, not modified): the layout filter strings as the starting point of `layouts.py`, the
  no-clobber publication helpers (`_create_sibling_temp`, `_require_destination_absent`,
  `_unlink_if_same`) and the probe helpers (`_probe_source`, `_stream_duration`).
- **Produces:** `build_plan`, `compile_job` for all modes (§5.1), `execute.run` (fd inputs,
  private temp directory, timeout, `-progress` liveness, cancel), `verify.verify_output` (G1–G3,
  G3b, G5), `derive_image`, the render-key helper (R9, reading `resources/toolchain.json`) and
  `content_equals_seed(doc, seed)` (R10).
- **TDD:**
  - string goldens for R1–R9 in every mode;
  - a hostile-text property test: argv and graph never contain user text;
  - decoder-run grouping;
  - `fit_blur` σ scaling; the `camera` crop as integer per-frame positions over `n + first_sf`
    (no float `t`); the same source frame gives the same crop x in a plate cell and in a final
    piece;
  - plate cells: exact frame count per cell, an IDR frame at every cell start
    (`-force_key_frames` + `-sc_threshold 0`, even on a scene-cut-heavy source), cell boundaries
    on the grid;
  - `plan_sha256` ignores `revision`, `parent_sha256` and `audit`; `content_equals_seed` vectors;
  - `frame` mode shifts pts so that `ass` sees `now_ms(n)`;
  - `execute`: timeout, cancel and liveness kill (tested with a fake FFmpeg script);
  - `verify` on good and deliberately broken outputs;
  - `derive_image`: box size, alpha baked, ancillary chunks stripped;
  - render-key composition.
- **Gates:** P-FRAME server-side (plate + final, 4 barcode sources, ≥ 2,000 frames, 0
  mismatches); P-PLATE server part; G1/G2 on 6 synthetic renders; G-DET; PF-RENDER measured
  (report only).

#### T1.4 Audio: speech, music, ducking, loudness · M
- **Owns:** `edit_v2/{audio_graph,envelope,loudness}.py`,
  `tests/test_edit_v2_{audio_graph,envelope,loudness}.py`.
- **Consumes:** T1.0; words spans through the Appendix A contract.
- **Produces:** speech and music envelopes (integer breakpoints), f32 expansion, the audio filter
  fragment for `final`, `reference`, `audio_preview` and `audio_measure`, and loudness measure
  and gain.
- **TDD:**
  - micro-fade breakpoints: clamping at half a neighbour; 30 ms at the cold-open join;
  - duck spans: merged by `hold`, attack before, release after, minimum on overlap;
  - fades; deterministic gain conversion;
  - expansion ≤ 150 ms for 90 s; fragment string goldens;
  - `ebur128` summary parsing; the clamp rule; 48 kHz in every mode; explicit `pan` for mono;
  - peak protection (§5.6 step 5): measured only with music or gain > 0; gain `−1.0 − TP`;
    `peak_reduced`; revision 0 never measured.
- **Gates:** G-CLICK; the duck gate; G3 and G3b on 3 synthetic mixes (one deliberately hot:
  music at +6 dB over loud speech); P-AUD determinism (two runs give the same PCM md5;
  `audio_preview` PCM == `reference` PCM). Until the integrator connects the compiler, the task
  uses a minimal audio-only harness graph.

#### T1.5 Analysis artifacts, seed and the synthetic job · L
- **Owns:** `edit_v2/{source_info,words,peaks,camera,seed}.py`,
  `tests/test_edit_v2_{source_info,words,peaks,camera,seed}.py`,
  `scripts/editor_fixture/make_job.py`.
- **Consumes:** T1.0; `transcript_io`, `audio_timeline`, `sound_events`, `sentences`,
  `face_tracking`, `selection_v3`, `subtitles._segment_words` (read-only use).
- **Produces:**
  - `source.json`; the words artifact (`bounds`, `gaps`, `events`, the `missing` list); peaks;
    the camera plan; the seed builder;
  - `seed.prepare_legacy_job(job_dir)`, which persists `source.json`, words, peaks and
    `seed.json` immutably for every openable clip of a pre-Essentials job and returns the
    per-clip `openable`/`reason` (§4.2). It is called by T1.1's `api prepare_job` op;
  - **the synthetic V3 job**:
    - a 180 s source (barcode + column ruler + tone bursts at 29.97 CFR, plus 25 fps, 60 fps and
      VFR variants);
    - an Indonesian transcript with word timings on the bursts, including the fillers "eh" and
      "anu", the particles "sih", "dong" and "mah", a stutter "gua gua", a reduplication
      "hati hati", a pair of overlapping words, a "wkwk" token and a `[tertawa]` event;
    - a second, "old" job variant without `sound-events.json` and with an `.attempts/`
      directory, for the legacy and `openable` paths;
    - `selection.v3.json` with 3 clips (one with a cold open), the audio timeline, the sound
      events, the transcript quality;
    - `job.json` and the manifest in the web's format; no renders yet.
- **TDD:**
  - word ids equal the global flattened indices, including the proportional split;
  - the zero-length fix; overlapping words (negative gap → `tight`);
  - `bounds` on synthetic peaks: quietest bin, frame boundary inside the gap, `tight`;
  - `prepare_legacy_job` writes each artifact once, is idempotent, never overwrites, and maps
    each broken-job case to its `reason`;
  - gap classes; events from tags and tokens; the peaks format;
  - the camera plan from a stubbed detector (deterministic) and `no_face` spans;
  - every row of the §3.5 seed table; the fps rule; the window clamp;
  - the synthetic job loads with `read_selection_artifact` and `read_transcript_json`.
- **Gates:** every seed passes T1.1 validation (checked at integration); words + peaks for a 60 s
  clip ≤ 1.0 s; the camera plan for a 3 min window ≤ 15 s.

(Revision 1's T1.6 "Render queue v3" moved into W2's T2.2, where the export path is built end to
end. W1 stays at 8 agents with T1.2 split into T1.2a/T1.2b.)

#### T1.Z W1 integrator, toolchain pin and W2 scaffolding · M
- **Owns (hot):**
  - `Dockerfile`:
    - `COPY resources ./resources`;
    - the base image pinned by digest; apt `ffmpeg`, `libass9`, `libfreetype6`,
      `libharfbuzz0b`, `libfribidi0` and `fontconfig` pinned to exact versions;
    - a build step writing `/app/resources/toolchain.json` (`dpkg-query -W` output + the base
      digest), E10;
  - `compose.yaml` and `.env.example` (flag passthrough);
  - `.github/workflows/ci-cd.yml` (Chrome for Testing install; a manual job running the
    `test:parity` script from T1.2b);
  - `docs/editor/GATES.md`;
  - **W2 scaffolding** (landed before W2 starts; W2 tasks replace these files, never the
    registries):
    - `web/lib/python-cli.mjs`: the one Python spawn helper, with the allowlisted env (E11),
      bounded IO, timeout, process-group kill and the exit-code map;
    - `web/lib/rate-limit.mjs`: token bucket per session hash and per job;
    - `web/components/editor/EditorApp.jsx` skeleton with slots;
    - `web/components/editor/panels/index.mjs` and `web/components/editor/timeline/lanes.mjs`,
      registries listing every W2 panel and lane;
    - one placeholder component per W2 panel/lane file (TranscriptPanel, TextPanel,
      ColdOpenPanel, VideoLane, CaptionLane, HookLane, …);
    - `web/components/editor/__dev__/fakes.mjs`: fake store, player and API from Appendix A.2;
    - `web/components/editor/editor.module.css`: design tokens only.
- **Merge order:** T1.1 → T1.5 → T1.2a → T1.2b → T1.4 → T1.3.
- **Steps:** remove the stubs from call paths; run the full chain on the synthetic job (seed →
  plan → `reference` + `final` for 3 clips × 3 layouts, with a stubbed camera plan for
  face-track → verify); run every W1 gate; land the W2 scaffolding with its own unit tests
  (`python-cli` env allowlist, rate limiter).
- **W1 exit gate:**
  - pytest, ruff, `npm test` and build green;
  - P-FRAME (server), P-TIME (both sides), P-TXT, P-ENC baseline, P-COLOR (S-COLOR decided and
    applied), P-AUD, G-CLICK, duck, G3, G3b, G1/G2, G-DET all green;
  - QG-PERSIST (in process);
  - the image builds with the pins, and `toolchain.json` is present and hashed into the render
    key;
  - the PF-RENDER report (with the S-COLOR choice).

### 11.2 Wave W2: "Editor bisa dipakai" (open, trim, cut, captions, hook, cold open, export): 7 + 1 agents

Goal: the owner can open any V3 clip, trim, cut via the transcript, fix and style captions, edit
the hook and cold open, undo/redo with autosave, and export through the queue. Preview is exact
per §6. Flag `POTONGIN_EDITOR_V3=on` for the owner's beta at exit.

#### T2.1 Engine switch and revision 0 · L
- **Owns:** `edit_v2/render_edit.py`, `src/ai_clipper/pipeline.py`,
  `web/lib/{jobs,selection-v3-view}.mjs`, `tests/test_pipeline_v3.py`,
  `tests/test_edit_v2_render_edit.py`, `web/tests/{jobs,selection-v3}.test.mjs` (additions),
  `scripts/parity/{rt_check.py,look_report.py}`, `scripts/editor_fixture/make_job.py` (adds
  `--render`).
- **Produces:**
  - `render_document(doc, job_dir, output, *, size, quality, progress, cancel)` and
    `render_request(job_dir, request, *, heartbeat, cancel)`;
  - the V3 pipeline path behind `POTONGIN_RENDER_ENGINE` (§5.8), which writes `source.json`,
    words, peaks, camera (face-track only), `seed.json`, the clip and its `.srt`, plus the
    manifest fields `clip_id`, `render_engine`, `render_key` and `plan_sha256`;
  - **engine fallback per clip.** If the new engine fails for a clip, the pipeline renders that
    clip with the legacy engine and records `render_engine: "legacy"` and the warning
    `engine_fallback:<rank>`. The job never fails because of the editor path;
  - the P-RT and P-LOOK tools.
- **TDD:**
  - `legacy` keeps today's command and assertions unchanged;
  - `edit-v2` writes every artifact and field;
  - the fallback path;
  - the SRT comes from frame cues and matches the burned events (text equal, times within 1
    frame);
  - `render_request` uses the archived document and publishes under the render key;
  - **R10:** a document whose content equals the seed (including after all edits were undone,
    with a changed `toolchain.json`, and for a legacy-engine clip) completes by hard-linking the
    auto file; a missing auto file renders normally with `auto_file_unavailable`;
  - `jobs.mjs` passes `clipId` and `renderEngine` through, and rejects malformed ones.
- **Gates:** P-RT (synthetic job: 3 clips incl. a cold open and face-track with a stub camera,
  plus the real owner clips of P3); PF-PIPELINE per layout; the P-LOOK kit delivered (20 real
  clips incl. 60 fps, VFR and face-track; side-by-side sheets and 3 MP4 pairs) for K1 at owner
  checkpoint 2.

#### T2.2 Export path end to end: render queue v3, worker, edit and render API · L
- **Owns:**
  - `src/ai_clipper/{render_queue,render_worker}.py`, `tests/test_{render_queue,render_worker}.py`
    (additions; legacy cases unchanged). This absorbs revision 1's T1.6;
  - `web/lib/{clip-edit,clip-renders}.mjs`;
  - `web/app/api/jobs/[id]/clips/route.js`;
  - `web/app/api/jobs/[id]/clips/[clipId]/{edit,words,renders}/route.js`;
  - `web/app/api/jobs/[id]/renders/[renderId]/route.js` (v3 DTO + DELETE);
  - `web/tests/{clip-edit,clip-renders}.test.mjs`.
- **Consumes:** `web/lib/python-cli.mjs` and `rate-limit.mjs` (T1.Z); the
  `render_edit.render_request` contract (T2.1; stubbed until merge).
- **Produces:**
  - `render-request-v3` (create, get, claim, update, publish, **cancel**) with R10 checked
    first;
  - the hard-link source snapshot with copy fallback;
  - retention pruning (newest 200, < 7 days);
  - scaled timeout and liveness plumbing;
  - the `verification_failed` and `cancelled` states; `stage` and `progress_pm`;
  - the worker wiring `renderer_v3 = render_edit.render_request`;
  - the §4.2 routes for clips (GET, and the job-level POST prepare via `api prepare_job`), edit,
    words and renders, with DTO sanitisation (no path ever leaves the server).
- **TDD:**
  - v1/v2 validation byte-for-byte unchanged (the existing tests stay green untouched);
  - v3 strictness (body exactly `{editEtag}`); cancel from `queued` and from `rendering`;
  - heartbeat carries progress; hard link, copy fallback and sha check;
  - pruning; idempotent create; instant completion by R10 and by an existing verified key;
  - the timeout formula; a liveness kill after 20 s without progress;
  - the status matrix per route: 200/202/400/401/403 (CSRF)/404/409/413/422/426/428/503;
  - the seed headers and `?seed=1`; PUT replay with the same key;
  - the storage reservation; a Python spawn failure → 503 with a fixed code;
  - every `openable`/`reason` code in the clips listing (synthetic "old" job of T1.5);
  - all paths resolved from `import.meta.url` (the D11 lesson).
- **Gates:** all 101 legacy editor tests and the new tests green; 1,500 requests created over
  time never hit a ceiling; QG-PERSIST over HTTP (5,000 saves); the QG-SEC CSRF/auth matrix and
  the child-env check for these routes; PF-SAVE.

#### T2.3 Server preview lane · L
- **Owns:**
  - `edit_v2/{preview_cli,plates}.py`;
  - `web/lib/{preview-lane,clip-media}.mjs`;
  - `web/app/api/jobs/[id]/clips/[clipId]/{prepare,preview/plan,preview/frame}/route.js`,
    `web/app/api/jobs/[id]/clips/[clipId]/media/[kind]/[name]/route.js`,
    `web/app/api/resources/[kind]/[name]/route.js`;
  - `tests/test_edit_v2_{preview_cli,plates}.py`, `web/tests/{preview-lane,clip-media}.test.mjs`.
- **Produces:**
  - `prepare`; the plan DTO (§4.3, ASS inline unless already known);
  - cell scheduling: cells at the playhead first, then in playback order;
  - audio mix builds, derived logos, truth frames;
  - the semaphore (2), `nice 5`, cancellation of superseded work (process group kill), per-job
    LRU caps;
  - Range media serving and resource serving (ASS as `text/plain` + `CSP: sandbox`);
  - every spawn through `web/lib/python-cli.mjs`; limits through `web/lib/rate-limit.mjs`
    (T1.Z).
- **TDD:**
  - the plan DTO shape against fixtures; ASS omitted when `known` matches;
  - cell order; supersede cancellation; LRU eviction under the cap;
  - media name regex, realpath containment and Range; resource bytes equal `fonts.json` shas;
  - a truth frame equals the compiler's `frame`-mode output for frame n pixel for pixel, and stays
    within P-ENC of the `reference` frame;
  - mix cache by mix sha; peak measurement cached by mix sha; rate limits.
- **Gates:** PF-PLAN (server part ≤ 200 ms p95 warm), PF-CELLS, PF-AUDIO, PF-TRUTH, P-AUD
  (through the lane), P-PLATE (through the lane).

#### T2.4 Browser player · L
- **Owns:** `web/lib/editor/player/**` (it keeps `text-layer.mjs` from W1),
  `web/app/parity-harness/**`, `web/app/api/parity-fixtures/**`, `web/e2e/editor-player.spec.mjs`,
  `web/tests/editor-player-*.test.mjs`.
- **Produces:** `createPlayer` (Appendix A) with frame mapping, decoder pool and decode-ahead
  across jumps, the presenter barrier, the audio clock on `AudioContext({sampleRate: 48000})`,
  the revision-0 `<video>` fallback, truth-frame mode, text-bitmap reuse and the device check
  (§6.2).
- **TDD:**
  - unit (node): frame→cell mapping against the vectors; the decode-ahead schedule across jumps;
    the presenter-barrier state machine; audio swap rules;
  - e2e (pinned Chrome): the barcode and column ruler are read back from the canvas for 600
    frames with 20 cuts; event onset frames; the canvas vs the reference; logo; the instrumented
    A/V sync probe; the AudioBuffer vs the reference PCM.
- **Gates:** P-FRAME, P-TIME, P-TXT, P-LOGO, P-AUD (browser half) and P-SYNC in the browser;
  PF-SEEK, PF-PLAY, PF-LIBASS, PF-MEM.

#### T2.5 Client state: document, commands, history, autosave, rebase · L
- **Owns:** `web/lib/editor/{timemap,doc-model,commands,history,store,autosave,draft-store,rebase,api-client,preview-client,flags}.mjs`,
  `web/tests/editor-{timemap,commands,history,store,autosave,rebase,draft}.test.mjs`,
  `scripts/edit_v2/crosscheck_commands.mjs`, `tests/test_edit_v2_crosscheck.py`.
- **Produces:** the store API; **all** Essentials commands (Appendix B, including those whose UI
  arrives in W3); history; autosave; the IndexedDB draft; rebase; `preview-client`
  (debounced, latest-wins plan requests with `known.assSha256`).
- **TDD:**
  - `timemap.mjs` equals ≥ 500 vectors;
  - preconditions and postconditions of every command;
  - QG-UNDO with 10,000 random sequences; `mergeKey` merging;
  - autosave debounce, maximum interval, one PUT in flight, retry with the same key;
  - draft restore; rebase success and per-part conflict classification;
  - latest-wins preview requests;
  - the cross-check: 1,000 random sequences, every document accepted by the Python validator.
- **Gates:** QG-UNDO; QG-CONFLICT (unit level); the draft is written after every command (reload
  loses ≤ 2 s).

#### T2.6 Editor shell, stage, timeline and export · L
- **Owns:**
  - `web/app/projects/[id]/clips/[clipId]/edit/page.jsx`;
  - `web/components/editor/{EditorApp,TopBar,Stage,StageControls,ChecksPanel,ExportDialog,ConflictDialog,ReadOnlyBanner,StageBadge}.jsx`
    (`EditorApp` replaces the T1.Z skeleton);
  - `web/components/editor/timeline/{Timeline,Ruler,VideoLane,CaptionLane,HookLane}.jsx`
    (`VideoLane` with pieces, cut markers, the cold-open block and word-snapped trim handles).
    The registry `timeline/lanes.mjs` and `panels/index.mjs` stay as T1.Z landed them;
  - `web/components/editor/editor.module.css`;
  - `web/lib/editor/shortcuts.mjs`;
  - `web/app/projects/[id]/page.jsx` (the "Edit klip" button, the edit state badge, the latest
    export link and the `openable`/`reason` message on `V3ClipCard`);
  - `web/e2e/editor-shell.spec.mjs`.
  - Read-only for W2 phase B: `__dev__/fakes.mjs` (T1.Z). A missing fake is requested from T2.Z.
- **Produces:** the page (UI spec in Appendix C), timeline with trim handles snapped through
  `bounds`, the keyboard map, the export dialog (acknowledging warnings, progress stages,
  cancel, downloads, read-only packaging with copy buttons; no size or quality choice in
  Essentials), the checks panel with jump-to, the conflict and read-only states, the stage badge
  with its help popover (§6.1), and the project-page entry.
- **TDD (e2e first, with fakes):**
  - opening revision 0 shows the auto render and "● Sesuai hasil akhir"; the help popover text;
  - trim drag snaps to `bounds`; shortcuts;
  - export states including cancel and a verification failure;
  - checks-panel jump; the conflict dialog; axe.
- **Gates:** QG-A11Y; PF-OPEN; scripted QG-UX U1 and U6.

#### T2.7 Transcript, text panel and cold-open panel · L
- **Owns:**
  - `web/components/editor/transcript/**` (`TranscriptPanel`, `WordSpan`, the selection model,
    the inline word editor, removal chips, dimmed context words, and its own
    `transcript.module.css`);
  - `web/components/editor/panels/{TextPanel,ColdOpenPanel}.jsx` + `panels/panels.module.css`
    (these replace the T1.Z placeholders; the registry is untouched);
  - `web/components/editor/panels/pack-thumbs/**` (static pack thumbnails rendered by FFmpeg from
    the packs) and `scripts/editor/make_pack_thumbs.py`;
  - `web/e2e/editor-transcript.spec.mjs`.
- **Produces:** the transcript interactions (Appendix C.2); the text panel (captions on/off, 4
  packs, position, size, uppercase, highlight and emphasis swatches; hook on/off, text with a
  counter and a fit badge, duration, position); the cold-open panel (on/off, current line and
  length, ± word on each edge, "Jadikan cold open" from a selection, with a disabled reason
  outside 0.5–8 s).
- **TDD:**
  - unit tests of the selection model;
  - e2e: delete words → removal, chip and restore; edit a word's text; hide a word; emphasis;
    set trim from the transcript; set a cold open from a selection; switch packs; hook overflow
    badge; the active word follows playback.
- **Gates:** scripted QG-UX U2 and U3; a command on a 1,500-word window updates the transcript in
  ≤ 16 ms.

#### T2.Z W2 integrator and W3 scaffolding · M
- **Owns (hot):** `web/next.config.mjs` (COOP/COEP, nosniff and `frame-ancestors 'none'` headers
  for `/projects/:id/clips/:clipId/edit`), `web/package.json` (if needed), `compose.yaml`
  (`POTONGIN_EDITOR_V3`), `web/e2e/editor-flow.spec.mjs`, `docs/editor/{GATES,PANDUAN-EDITOR}.md`,
  `web/components/editor/__dev__/fakes.mjs`, `panels/index.mjs`, `timeline/lanes.mjs`.
- **Merge order:** T2.1 → T2.2 → T2.3 → T2.5 → T2.4 → T2.6 → T2.7.
- **Wiring:** replace the fakes with the real store, player and API clients.
- **W3 scaffolding** (landed at the end of W2): registry entries and placeholder files for
  `panels/{LayoutPanel,LogoPanel,MusicPanel}.jsx`, `timeline/lanes/{MusicLane,AudioLane,MarkerLane}.jsx`,
  `suggestions/index.jsx`, `gizmos/LogoGizmo.jsx`, the fakes for upload/AI/cleanup, and the
  `Stage` gizmo slot. W3 tasks replace these files, never the registries.
- **The e2e flow:** open → trim → delete words → fix a word → switch pack → edit the hook →
  change the cold open → undo/redo → reload → export → download → G1–G3 on the file → undo
  everything → export → the auto file itself (R10).
- **W2 exit gate:**
  - every W1 gate still green;
  - P-RT (including R10); P-FRAME, P-TIME, P-TXT, P-LOGO (fixture asset), P-AUD and P-SYNC in
    the browser; P-PLATE;
  - PF-OPEN, SEEK, PLAY, PLAN, AUDIO, CELLS, TRUTH, SAVE and LIBASS;
  - QG-UNDO, QG-CONFLICT (two-tab e2e), QG-PERSIST (HTTP), QG-SEC (routes + child env),
    QG-A11Y;
  - scripted QG-UX U1–U3, U6 and U7 (e2e with time limits);
  - the P-LOOK kit delivered.

  **Owner checkpoint 2** follows: the P-LOOK sheets (K1), and U1, U6 and U7 on the reference
  laptop. The owner beta starts. The auto-render engine flips only after K1 approval.

### 11.3 Wave W3: "Fitur Esensial lengkap" (assets, logo, music, AI, Rapikan, layout, markers): 7 + 1 agents

Goal: the remaining Essentials features, each with its gates. The command set and compiler
support already exist (W1/W2), so these tasks are UI + domain logic + gates.

#### T3.1 Uploads and the asset store · M
- **Owns:** `edit_v2/{assets,png_strip}.py`, `web/lib/asset-upload.mjs`, `web/lib/editor/upload-client.mjs`
  (browser upload helper with progress and error mapping, used by T3.2 and T3.3),
  `web/app/api/jobs/[id]/assets/route.js`, `web/app/api/jobs/[id]/assets/[sha]/route.js`,
  `scripts/security/make_upload_fuzz.py`, `tests/test_edit_v2_{assets,png_strip}.py`,
  `tests/test_upload_fuzz.py`, `web/tests/asset-upload.test.mjs`.
- **Produces:** §9.2 end to end; the asset metadata (`w`, `h`, `durationMs`, `lufsC`); music
  peaks served by the same `[sha]` route as `?part=peaks` (the `peaksUrl`).
- **TDD:** every row of §9.2 (transport caps, quarantine, sniff, forced demuxer,
  `-enable_drefs 0`, EXIF orientation, normalisation, chunk stripping, identity, serving
  headers); the fuzz corpus; the ingest child's env holds no secret (E11).
- **Gates:** QG-SEC fuzz 100%, no 5xx; ingest p95 ≤ 2 s per image and ≤ 8 s per 5-minute track.

#### T3.2 Logo and watermark · M
- **Owns:** `web/components/editor/panels/LogoPanel.jsx`, `web/components/editor/gizmos/**`
  (`LogoGizmo`: drag, aspect-locked resize, snap to 4 corner presets and safe-zone guides; it
  mounts in the `Stage` gizmo slot landed by T2.Z, so `Stage.jsx` is not edited),
  `web/e2e/editor-logo.spec.mjs`.
- **Consumes:** `web/lib/editor/upload-client.mjs` (T3.1, Appendix A contract; a fake until
  merge).
- **Produces:** upload → place → size → opacity → remove, all through the existing commands.
- **TDD:** e2e for placement snapping; keyboard nudges (arrows 1 px, Shift 10 px); the
  `item_out_of_frame` guard; the upload error states (size, type, rejected file).
- **Gates:** P-LOGO at the output size and via a truth frame; the G5 warning when the logo
  enters the unsafe zone; scripted QG-UX U5 (logo part).

#### T3.3 Music and ducking · M
- **Owns:** `web/components/editor/panels/MusicPanel.jsx`,
  `web/components/editor/timeline/lanes/MusicLane.jsx` (asset waveform plus the duck envelope
  from `audio.musicGainPoints`), `web/e2e/editor-music.spec.mjs`, `scripts/parity/audio_gates.py`.
- **Produces:**
  - music add, replace and remove; gain; start offset; loop; fades;
  - ducking controls with presets ("Halus" −6 dB, "Sedang" −10 dB, "Kuat" −16 dB) and an
    advanced section (attack, release, hold);
  - source volume; the normalize toggle with the achieved LUFS; the `peak_reduced` note
    ("Volume diturunkan x dB agar tidak pecah");
  - the copyright notice.
- **TDD:** e2e for every control; the envelope drawing equals the plan points; a music-shorter
  warning; the `loudness_clamped` and `peak_reduced` displays.
- **Gates:** the duck gate on real exports; G3; G3b with a deliberately loud track; G-CLICK with
  music; P-AUD (server and browser); scripted QG-UX U5 (music part).

#### T3.4 AI hook suggestions · M
- **Owns:** `src/ai_clipper/editor_ai.py`, `src/ai_clipper/prompts/editor_hooks_v1.md`,
  `web/lib/editor-ai.mjs`, `web/app/api/jobs/[id]/clips/[clipId]/ai/route.js`,
  `web/app/api/jobs/[id]/clips/[clipId]/ai/[taskId]/route.js`,
  `web/components/editor/panels/TextPanel.jsx` (taken over),
  `web/components/editor/suggestions/**`, `tests/test_editor_ai.py`,
  `web/tests/editor-ai.test.mjs`.
- **Produces:** §7.1:
  - the instant variants, with source labels "AI seleksi" / "Heuristik";
  - the LLM task: env from `engineProcessEnv(await loadLlmEnv())`, a thread-enforced deadline,
    the Node-side kill at 25 s, the cache, the rate limit, and the `POTONGIN_EDITOR_LLM` flag;
  - validation and grounding;
  - ghost cards.
- **TDD:**
  - the instant variant rules and labels; the fit flag;
  - a scripted LLM (`ScriptedLLMClient`) with adversarial outputs: ungrounded numbers and names,
    URLs, emoji, near-duplicates, malformed JSON, timeouts, `LLMUnavailable`;
  - the deadline stops at 20 s; the Node kill at 25 s leaves `failed/timeout`;
  - the rate limit; `POTONGIN_LLM=off`;
  - saved Pengaturan settings win over `.env` (same precedence as `run-job.mjs`); a body with
    any extra field → 400;
  - the non-AI children never see LLM keys.
- **Gates:** QG-AI hard gates (the owner's 30-clip review happens at checkpoint 3).

#### T3.5 Rapikan: fillers, repeats, gaps · M
- **Owns:** `edit_v2/cleanup.py`, `resources/lexicon/{id-fillers,id-reduplication}.v1.json`,
  `tests/fixtures/edit_v2/fillers-labelled.json` (200 tokens from the synthetic job and the P3
  owner transcripts, labelled by the agent and confirmed by the owner at checkpoint 3; it
  includes ≥ 20 reduplication pairs and every protected particle),
  `web/app/api/jobs/[id]/clips/[clipId]/cleanup/route.js`,
  `web/components/editor/transcript/**` (taken over; adds `CleanupReview` and in-transcript
  badges), `tests/test_edit_v2_cleanup.py`, `web/e2e/editor-cleanup.spec.mjs`.
- **Produces:** §7.3; "Terapkan (n)" as one transaction.
- **TDD:** each class and default state; protected particles (including `mah toh nah kek`) never
  listed; reduplication never listed as `repeat`; function-word stutters listed; laughter lock;
  gap shortening snapped to frames inside the gap; the transaction undoes in one step; the
  automated cut-edge check.
- **Gates:** QG-CLEAN.

#### T3.6 Layout switch and face-track · M
- **Owns:** `web/components/editor/panels/LayoutPanel.jsx`, `edit_v2/camera.py` (taken over:
  `no_face` spans, progress reporting), `web/e2e/editor-layout.spec.mjs`,
  `scripts/parity/plate_gates.py`.
- **Produces:** the layout picker with live thumbnails (truth frames at the playhead), camera
  analysis progress, the `no_face` list with jump-to.
- **TDD:** the layout command and plate-key change; the camera plan cached and reused; `no_face`
  detection on a synthetic plan; e2e switching between all three layouts.
- **Gates:** P-PLATE and P-FRAME per layout; after a switch, the first cells at the playhead
  ≤ 3 s (fit-blur, center-crop); the camera plan for a 3-minute window ≤ 15 s; PF-CELLS per
  layout.

#### T3.7 Waveform, markers and cold-open suggestions · M
- **Owns:** `web/components/editor/timeline/lanes/{AudioLane,MarkerLane}.jsx`,
  `edit_v2/coldopen.py`, `web/app/api/jobs/[id]/clips/[clipId]/coldopen-suggestions/route.js`,
  `web/components/editor/panels/ColdOpenPanel.jsx` (taken over), `tests/test_edit_v2_coldopen.py`,
  `web/e2e/editor-markers.spec.mjs`.
- **Produces:**
  - the speech waveform laid out per piece;
  - markers for laughter (😂 icon with a tooltip giving the source), silences ≥ 0.6 s and camera
    cuts (`audio_timeline.scene_cuts`);
  - "tidak tersedia untuk job ini" when the words artifact lists the data as `missing`;
  - click-to-seek;
  - §7.2 suggestions with audition.

  (Trim snapping to laughter ends is deferred: it would store a non-`bounds` frame and needs
  `VideoLane`, which W3 does not own.)
- **TDD:** marker frames equal the time-map vectors; laughter from tags and tokens; the
  missing-data state; every suggestion satisfies §3.4.
- **Gates:** marker positions exact (0 frames); scripted QG-UX U3 with suggestions ≤ 30 s.

#### T3.Z W3 integrator · M
- **Owns (hot):** `web/components/editor/EditorApp.jsx`,
  `web/components/editor/panels/index.mjs`, `web/components/editor/timeline/lanes.mjs`,
  `web/components/editor/__dev__/fakes.mjs`, `web/lib/editor/commands.mjs` (only if a command
  must change), `compose.yaml` (`POTONGIN_EDITOR_UPLOADS` and `POTONGIN_EDITOR_LLM`, default
  off), `docs/editor/{GATES,PANDUAN-EDITOR}.md`, `web/e2e/editor-flow.spec.mjs` (extended).
- **Merge order:** T3.1 → T3.2 → T3.3 → T3.4 → T3.5 → T3.6 → T3.7.
- **W3 exit gate:** QG-SEC fuzz; P-LOGO; duck, G3, G3b and G-CLICK with music; QG-AI hard
  gates; QG-CLEAN; P-PLATE (crop x 0 px) per layout; marker tests; one e2e per feature;
  scripted QG-UX U4 and U5.

### 11.4 Wave W4: "Siap rilis" (legacy fixes, security, performance, CI, acceptance): 5 + 1 agents

#### T4.1 Legacy editor: the 8 bugs and "Buka di Editor V3" · M
- **Owns:**
  - `src/ai_clipper/{render_manifest,editor_api,render_queue,render_worker}.py`;
  - `web/app/projects/[id]/candidates/[candidateId]/edit/page.jsx`, `web/lib/editor-view.mjs`;
  - `edit_v2/seed.py` (adds `seed_from_candidate`);
  - `web/app/api/jobs/[id]/candidates/[candidateId]/open-in-editor/route.js`;
  - `tests/test_{render_manifest,editor_api,render_queue,render_worker}.py`,
    `web/tests/editor-view.test.mjs`, `tests/test_edit_v2_seed.py` (additions).
- **Produces:** the §8 legacy column:
  - alpha on `OutlineColour`;
  - sub-cue splitting instead of "…";
  - `ass_escape`;
  - `aresample=48000` and a 48 kHz check;
  - receipt pruning;
  - a renderer-versioned legacy output name (the queue accepts `revision-N.mp4` and
    `revision-N.r<ver>.mp4`; new legacy requests use the versioned name, and `_verify_existing`
    checks the recorded renderer version);
  - broken controls (keyword colour, logo) hidden with an explanation;
  - the legacy stage labelled "Pratinjau perkiraan — hasil akhir bisa berbeda" (R1 P1–P3, P15
    stay unfixed there);
  - "Buka di Editor V3" (a same-origin POST creates the clip seed from the candidate, then
    redirects).
- **TDD:** one regression test per bug (§8 column 5, legacy side); existing legacy tests keep
  passing (any intentional change is listed in the PR); the candidate seed passes validation.
- **Gates:** 8/8 legacy regression tests; the legacy e2e (`mutation.spec.mjs`) still green.

#### T4.2 Security review and hardening · S/M
- **Owns:**
  - `web/lib/{security-headers,rate-limit,python-cli}.mjs` (hardening only);
  - every route under `web/app/api/jobs/[id]/clips/**` and `web/app/api/jobs/[id]/assets/**`
    (rate limits and headers only; behaviour is unchanged);
  - `web/tests/security-*.test.mjs`, `web/e2e/editor-security.spec.mjs`.
- **Produces:**
  - an adversarial review of every new route: auth, same-origin, body caps, ID regexes, error
    codes that never echo paths;
  - the rate limits of §9.1 on every route;
  - the header set of §9.1, with COOP/COEP verified (`crossOriginIsolated === true` on the
    editor);
  - the child-env check across every spawn site.
  - Revocable sessions and the nonce CSP are **not** built (K10 deferred).
- **TDD:** every limit returns 429 with `Retry-After`; `/proc/<pid>/environ` of each child
  kind; the AI route rejects extra body fields; path-traversal names on every `:name`/`:sha`
  route; the fuzz re-run.
- **Gates:** complete QG-SEC. Then `POTONGIN_EDITOR_UPLOADS` may default to on (T4.Z).

#### T4.3 Performance and retention · M
- **Owns:**
  - `web/lib/preview-lane.mjs`, `edit_v2/preview_cli.py` (plus the optional
    `edit_v2/preview_server.py` persistent worker), `edit_v2/janitor.py`;
  - `web/scripts/primary-worker.mjs` (a janitor tick between jobs; revision 1 left this
    unowned);
  - `web/lib/editor/player/**` (performance fixes only);
  - `scripts/perf/editor_budgets.mjs`, `tests/test_edit_v2_janitor.py`.
- **Produces:** the budget report on the reference laptop; the persistent worker *only if*
  PF-PLAN misses; the janitor (receipts, archives per §4.4, caches, suggestions, orphan assets
  after 30 days) running under the document lock from the primary worker. (The plate pre-warm
  of revision 1 is cut, §1.3.)
- **TDD:** janitor policies; the janitor tick never runs while a job is active; the persistent
  worker (if built): crash restart and a request timeout.
- **Gates:** every PF-* budget green; a retention soak (1,000 saves + 50 exports + cache churn)
  stays inside the caps.

#### T4.4 CI gates and documentation · S/M
- **Owns:** `.github/workflows/ci-cd.yml`, `scripts/parity/run_all.sh`,
  `docs/editor/{PANDUAN-EDITOR,OPERASIONAL,CONTRACTS}.md` (final), `README.md` (editor
  section), `web/app/licenses/page.jsx` + `web/public/licenses/**` (third-party notices:
  JASSUB's LGPL/FTL/MIT components with the exact tag and build-script link, the Mediabunny
  MPL-2.0 notice, the OFL and DejaVu licences; required by R3, unowned in revision 1).
- **Produces:**
  - a PR job: pytest, node tests, build, and a parity smoke inside the built image (P-TIME,
    the P-TXT subset, 300-frame P-FRAME, G-DET, P-AUD, R10);
  - a job that fails when `toolchain.json` or the JASSUB pin changes without a fresh
    P-TXT/P-ENC/P-COLOR/P-RT run;
  - a nightly job: the full parity suite (including P-ENC) plus the performance report as
    artifacts;
  - the owner guide in Indonesian, including what "Sesuai hasil akhir" means.
- **Gates:** CI green on the PR; one green nightly run.

#### T4.5 Acceptance and accessibility polish · M
- **Owns:** `web/components/editor/**` (polish only: accessibility, copy, empty and error
  states; no behaviour change without a test), `web/e2e/editor-acceptance.spec.mjs` (one test per
  Essentials capability, 13 in total), `docs/editor/UJI-PENERIMAAN.md` (the owner protocol for
  U1–U7 with timers).
- **Gates:** QG-A11Y; 13/13 acceptance specs; the owner session recorded.

#### T4.Z Release integrator · S
- **Owns (hot):** `compose.yaml` defaults (`POTONGIN_EDITOR_V3=on`, `POTONGIN_EDITOR_UPLOADS=on`,
  `POTONGIN_EDITOR_LLM=on` once the QG-AI hard gates pass, and `POTONGIN_RENDER_ENGINE=edit-v2`
  once K1 is approved), `docs/ROADMAP.md` (§8 ticks), `docs/editor/GATES.md` (final evidence
  table).
- **W4 exit gate (= Essentials done):**
  - every gate in §10 green in CI (the PR subset and one full nightly);
  - 8/8 legacy regression tests;
  - QG-SEC complete; every PF budget on the reference laptop;
  - **owner checkpoint 3:** QG-UX U1–U7 by the owner, the QG-AI 30-clip review, and the filler
    labels confirmed;
  - K1 approved and applied.

### 11.5 Wave W5 (cadangan, hanya bila perlu): ≤ 3 + 1 agents

- **Trigger.** An exit gate of W1–W4 is still red after its integrator's fixes, or the owner asks
  for rework at checkpoint 2 or 3. W5 **adds no scope**.
- **Shape.** Up to 3 fix agents, each owning the files of one failing gate (taken from the
  original owner task's list), plus T5.Z, which re-runs the complete §10 suite.
- **If W5 cannot close a gap,** the deferral rule of §11.0 applies: the owner defers one whole
  owner item behind its flag and records it in `docs/ROADMAP.md` §9.
- **Typical candidates, from the critique:**
  - P-TXT for Montserrat or the box pack → the variant switch of §5.4;
  - PF-PLAN → the persistent preview worker;
  - QG-AI blind pairs → prompt iterations;
  - PF-PIPELINE for face-track.

---

## 12. Keputusan pemilik (dengan rekomendasi)

> **Status keputusan (dicatat 2026-09-24):** pemilik **menerima semua rekomendasi** (K1–K9,
> K11–K13; K10 dan K14 tetap ditunda). **K15:** mesin acuan performa adalah PC pengembangan ini
> (AMD Ryzen 7 5700G, 16 thread, RAM 30 GB, tanpa GPU diskrit). **Eksekusi ditunda** atas
> permintaan pemilik. Saat dimulai, langsung jalankan W1 tanpa bertanya ulang tentang K1–K15.
> Prasyarat sebelum W1: minimal 3 job V3 nyata yang bisa dibaca agen (satu sudah ada di
> `artifacts/local/jobs/`, yaitu video Ferry × Reza; buat 2 lagi dari episode ber-subtitle
> dengan `artifacts/local/start-local.sh`).

| ID | Keputusan | Pilihan | Rekomendasi | Kapan |
|---|---|---|---|---|
| **K1** | Klip otomatis V3 dirender mesin baru (syarat "revisi 0 = klip otomatis" untuk job baru) | Ya (setelah melihat 20 klip berdampingan) / tidak (editor tetap jalan, tapi klip lama selalu diberi catatan "mesin lama") | **Ya.** Perubahannya kecil dan terukur: frame rate tetap (60 → 30, VFR → CFR), frame yang dipilih konsisten (grid), audio 48 kHz, tag warna BT.709, warna caption tepat (bila S-COLOR memilih komposit RGB), pelacakan wajah dihitung sekali per jendela. Kit P-LOOK memuat sumber 60 fps, VFR dan face-track | Titik cek 2 (setelah W2) |
| **K2** | Format komposit teks | yuv420p (biaya sekarang; warna mungkin bergeser sedikit) / yuv444p (+19–29%) / RGB planar gbrp (+≈40%, warna caption paling tepat) | **Biarkan spike S-COLOR memilih** yang termurah dan lulus P-COLOR + P-ENC **pada MP4 akhir** (MP4 akhir selalu 4:2:0, jadi keuntungan 444/gbrp terutama pada ketepatan warna) | W1 |
| **K3** | Frame rate keluaran | Rate standar asli dipertahankan; 50/60 → 25/30; VFR → 30 (selalu CFR) | **Ya.** Tidak ada duplikasi frame 29,97→30; potongan A/V tepat per sampel | Sebelum W1 |
| **K4** | Audio keluaran | AAC-LC 192 kb/s 48 kHz (sekarang 128 kb/s) | **Ya** | Sebelum W1 |
| **K5** | Posisi caption default dan zona aman TikTok | Pertahankan 17% dari bawah (revisi 0 identik) + peringatan / pindahkan ke ±26% untuk job baru | **Pertahankan dulu** dan tampilkan peringatan zona aman. Pemindahan dibahas sebagai perubahan tampilan terpisah setelah K1 | Sebelum W2 |
| **K6** | Font tambahan | Montserrat ExtraBold (OFL-1.1) untuk preset Bold dan Box; DejaVu tetap untuk Klasik dan Karaoke | **Ya.** Tampilan Bold/Box ala TikTok butuh font tebal; lisensi aman | Sebelum W1 |
| **K7** | Browser untuk pratinjau langsung | Chrome/Edge desktop ≥ 120; browser lain memakai "frame akhir" + ekspor | **Ya** | Sebelum W2 |
| **K8** | Editor lama (kandidat V2) | (a) 6 perbaikan sisi server + sembunyikan kontrol rusak + "Buka di Editor V3" / (b) porting semua fitur ke editor lama / (c) pensiunkan sekarang | **(a).** Output lama benar lagi tanpa menduplikasi fitur; editor lama pensiun di Tahap 2 | Sebelum W4 |
| **K9** | Normalisasi loudness default | Mati (revisi 0 = klip otomatis) dengan toggle −14 LUFS / nyala otomatis saat musik ditambah | **Mati secara default**; panel Musik menyarankan menyalakannya | Sebelum W3 |
| **K10** | Sesi login bisa dicabut (server-side) | Ya / tidak | **Ditunda ke Tahap 2** (di luar daftar Esensial). Unggahan tidak memperluas apa yang bisa dilakukan token curian; proses anak tidak lagi membawa rahasia (E11) | Tidak perlu sekarang |
| **K11** | Batas cache pratinjau per job | 1 GiB LRU / lainnya | **1 GiB**; klip 60 s dengan konteks kira-kira 20–40 MB per tata letak [INC E1] | Sebelum W2 |
| **K12** | Sumber musik | Unggahan pengguna saja (dengan peringatan hak cipta) / perpustakaan berlisensi | **Unggahan saja**; perpustakaan di Tahap 2 | Sebelum W3 |
| **K13** | LLM untuk saran hook | Rantai provider dari halaman Pengaturan (sama dengan pipeline), tenggat 20 s, maks 30 panggilan/job/jam; opsional `POTONGIN_LLM_EDITOR_MODELS` untuk model cepat. Bila saran "AI baru" jarang lebih baik dari saran instan di uji buta: tetap nyala / perbaiki prompt di W5 / matikan | **Ya; tetap nyala dan perbaiki prompt di W5** bila perlu. Tombol hanya dimatikan bila gerbang wajib (grounding, format, latensi, layak pakai ≥ 70%) gagal | Titik cek 1; hasil di titik cek 3 |
| **K14** | Opsi ekspor | Ukuran 1080×1920 dan kualitas "Tinggi" | **Ditunda ke Tahap 2.** Esensial mengekspor dengan ukuran dan kualitas klip otomatis (720×1280, Standar); sumber YouTube 720p tidak menjadi lebih tajam di 1080×1920 | Tidak perlu sekarang |
| **K15** | Laptop acuan untuk gerbang performa | Sebutkan model (mis. i5-1135G7 / Ryzen 5 5500U, 8 GB) | Pakai laptop yang benar-benar Anda pakai untuk mengedit | Titik cek 1 |

Catatan: keputusan FINAL "Node di jalur render" dan "blur plate" **tidak diperlukan** di Esensial
(resolver tetap Python; `gblur` tetap karena piksel pratinjau berasal dari server).

---

## 13. Risiko

| Risiko | Kemungkinan / dampak | Mitigasi |
|---|---|---|
| Warna caption di FFmpeg 5.1 (BT.601 di `drawutils`) tidak sama dengan JASSUB | Sedang / sedang | Spike S-COLOR di W1; komposit gbrp bila perlu (K2); gerbang P-COLOR per warna swatch |
| Selisih versi libass (JASSUB 0.17.4 vs Debian 0.17.1), terutama untuk Montserrat dan kotak `BorderStyle 3` yang belum diukur | Sedang / sedang | Terukur SSIM 0,9998 hanya untuk DejaVu [R3]; versi dipin; P-TXT per pack di W1; pack yang gagal memakai varian cadangan (§5.4); opsi jangka panjang: FFmpeg dengan tag libass yang sama |
| Python start-up membuat PF-PLAN > 400 ms | Sedang / rendah | Debounce + latest-wins; ASS tidak dikirim ulang bila sha sama; worker persisten (T4.3) sebagai cadangan |
| Pembangunan sel plate lambat saat CPU sibuk (Whisper + render) | Sedang / sedang | Semafor 2, `nice`, pembatalan pekerjaan tersusul, sel di posisi playhead lebih dulu, MP4 otomatis untuk revisi 0 |
| Image Docker dibangun ulang (pembaruan keamanan Debian) mengubah FFmpeg/libass/freetype | Tinggi / tinggi | Toolchain dipin dan `toolchain.json` masuk kunci render (E10); revisi 0 tetap file otomatis (R10); CI menolak perubahan toolchain tanpa P-TXT/P-ENC/P-COLOR/P-RT baru |
| Klaim "sama dengan hasil akhir" terlalu luas (MP4 selalu 4:2:0 + H.264) | Pasti / sedang | Klaim dipersempit ke raster teks (P-TXT); MP4 diukur terpisah (P-ENC); teks bantuan lencana; tombol "Frame akhir" |
| Rahasia server bocor ke proses anak (termasuk FFmpeg yang membaca unggahan) | Sedang / tinggi | Env allowlist di `python-cli.mjs` (E11); hanya tugas AI yang menerima kunci LLM; uji `/proc/<pid>/environ` |
| Pekerjaan melebihi 30 agen | Sedang / tinggi | Pemangkasan §1.3; T1.2 dipecah; W5 cadangan; aturan penundaan butir utuh (§11.0) |
| Musik membuat audio pecah (clipping) | Sedang / sedang | Perlindungan puncak selalu aktif (§5.6), gerbang G3b |
| Penyimpanan membengkak (plate, audio, arsip) | Sedang / sedang | Cap LRU per job (K11), janitor, receipt/arsip/permintaan render dipangkas, dihitung storage admission |
| Pemilik menolak perubahan tampilan mesin baru (K1) | Rendah / sedang | Flag `POTONGIN_RENDER_ENGINE=legacy` tetap tersedia; editor tetap jalan dengan catatan "mesin lama"; parameter yang ditolak (mis. komposit, fps) bisa dibuat opsi kompiler |
| Bitstream x264 berbeda antar container | Rendah / sedang | `threads=4` dipin + flag bitexact; gerbang P-RT; ekspor revisi 0 memakai hard link file otomatis |
| WebCodecs/Mediabunny bermasalah di GPU/driver tertentu | Rendah / sedang | Browser GA hanya Chrome/Edge desktop; mode "frame akhir" selalu tersedia; pemeriksaan perangkat |
| Kualitas face-track (Haar lama) | Tinggi / sedang | Tidak diperbaiki di Esensial; setiap rentang tanpa wajah dilaporkan (tidak diam-diam); YuNet/ASD di Tahap 2 |
| Whisper jarang menulis kata pengisi | Tinggi / rendah | Rapikan adalah daftar tinjauan, jeda hening disertakan, teks UI jujur |
| Transkrip berubah setelah diedit (job diproses ulang) | Rendah / sedang | Mode baca-saja + "Mulai dari versi AI"; re-anchoring di Tahap 2 |
| Kuota/latensi LLM gratis | Tinggi / rendah | Heuristik selalu tampil; tenggat 20 s; cache; batas panggilan |
| Konflik integrasi antar agen paralel | Sedang / sedang | Kontrak dibekukan (Lampiran A), stub di fase A, integrator per gelombang dengan urutan merge tetap, gerbang keluar |
| Unggahan berbahaya | Rendah / tinggi | §9.2 + fuzz 100% + flag unggahan mati sampai W4 + proses ingest tanpa rahasia (E11) |
| Lisensi (LGPL di WASM JASSUB, MPL Mediabunny, font OFL, musik pengguna) | Sedang / sedang | Dikirim tanpa modifikasi sebagai aset terpisah + halaman pemberitahuan; font OFL disertai lisensi; peringatan hak cipta musik |
| Ruang lingkup melebar ("sekalian tambah …") | Tinggi / tinggi | Tabel §1 adalah kontrak; apa pun di luar itu masuk backlog Tahap 2 |

---

## Lampiran A. Kontrak modul (dibekukan di T1.0; disalin ke `docs/editor/CONTRACTS.md`)

### A.1 Python (`src/ai_clipper/edit_v2/`, stdlib only)

```python
# __init__.py
COMPILER_VERSION = "edit-v2/1.0.0"          # plan field "compiler" is "edit-v2/1"
RENDER_SEMANTICS = 1                        # bump on any golden-pixel change (owner look approval)

# errors.py
class EditV2Error(Exception):               # .code (stable), .path (JSON pointer) | None, .ref (id) | None
class DocInvalid(EditV2Error): ...          # parse level → 422
class DocSemanticInvalid(EditV2Error): ...  # semantic level → 422
class RevisionConflict(EditV2Error): ...    # 409, carries current doc + etag
class IdempotencyConflict(EditV2Error): ... # 409
class NotFound(EditV2Error): ...            # 404
class AnalysisMissing(EditV2Error): ...     # 409 analysis_missing
class SchemaTooNew(EditV2Error): ...        # 426
class RenderFailed(EditV2Error): ...; class VerificationFailed(EditV2Error): ...; class Cancelled(EditV2Error): ...
MESSAGES: Mapping[str, str]                 # code → Indonesian message (id "edit.<code>")

# timemap.py
@dataclass(frozen=True, slots=True)
class Fps: num: int; den: int
@dataclass(frozen=True, slots=True)
class Piece: i: int; seg: str; role: str; in_sf: int; out_sf: int; out_f0: int; frames: int
def pieces(doc: Mapping) -> tuple[Piece, ...]
def total_frames(pieces: Sequence[Piece]) -> int
def smp(n: int, fps: Fps, rate: int = 48_000) -> int
def sf_floor(ms: int, fps: Fps) -> int
def sf_ceil(ms: int, fps: Fps) -> int
def word_frames(s_ms: int, e_ms: int, pieces: Sequence[Piece], fps: Fps) -> tuple[int, int] | None  # None: not visible
def out_to_src(n: int, pieces: Sequence[Piece]) -> tuple[Piece, int]
def now_ms(n: int, fps: Fps) -> int          # FFmpeg vf_subtitles double arithmetic, verbatim
def safe_cs(n: int, fps: Fps) -> int
def cell_frames(fps: Fps) -> int

# clip_id.py
def clip_id(source_content_sha256: str, start_ms: int, end_ms: int,
            cold_open_ms: tuple[int, int] | None) -> str

# doc.py
MAX_DOC_BYTES = 1 << 20
@dataclass(frozen=True)
class Issue: code: str; path: str; ref: str | None = None; f: int | None = None
@dataclass(frozen=True)
class Validation: errors: tuple[Issue, ...]; warnings: tuple[Issue, ...]
def parse_doc(raw: bytes) -> dict
def canonical_bytes(doc: Mapping) -> bytes
def doc_sha256(doc: Mapping) -> str
def content_sha256(doc: Mapping) -> str      # canonical bytes without revision, parent_sha256, audit
def content_equals_seed(doc: Mapping, seed: Mapping) -> bool   # R10
def validate_doc(doc: Mapping, *, words: Mapping, assets: Mapping[str, Mapping],
                 seed: Mapping | None) -> Validation

# store.py (clip_dir = analysis/clips/<clip_id>)
def get(clip_dir: Path) -> tuple[dict, str, bool]                       # doc, etag, is_seed
def seed(clip_dir: Path) -> tuple[dict, str]
def put(clip_dir: Path, *, expected_etag: str, idempotency_key: str, raw: bytes,
        now_ms: int) -> tuple[dict, str, tuple[Issue, ...]]
def archive_for_render(clip_dir: Path, etag: str) -> tuple[str, int]    # relative path, revision
def prune_receipts(clip_dir: Path, *, keep: int = 200) -> int     # keeps pending receipts

# subtitles.py (added) / captions_ass.py (added) / edit_v2/captions.py
@dataclass(frozen=True, slots=True)
class SourceWord: id: str; s_ms: int; e_ms: int; text: str; emphasis: bool
@dataclass(frozen=True, slots=True)
class FrameWord: id: str; f0: int; f1: int; text: str; emphasis: bool
@dataclass(frozen=True, slots=True)
class FrameCue: f0: int; f1: int; seg: str; words: tuple[FrameWord, ...]
def build_frame_cues(words: Sequence[SourceWord], pieces: Sequence[Piece], fps: Fps, *,
                     max_words: int = 4, max_gap_ms: int = 600,
                     min_display_ms: int = 300) -> tuple[FrameCue, ...]
def load_pack(pack_id: str, version: int) -> CaptionPack                 # resources/caption-packs
@dataclass(frozen=True)
class HookSpec: text: str; f0: int; f1: int; y_e5: int
def build_ass_v2(cues: Sequence[FrameCue], *, play_res: tuple[int, int], fps: Fps,
                 total_frames: int, pack: CaptionPack, overrides: Mapping,
                 hook: HookSpec | None) -> str
@dataclass(frozen=True)
class CaptionResult: cues: tuple[FrameCue, ...]; ass: str; ass_sha256: str
                     hook_lines: tuple[str, ...]; warnings: tuple[Issue, ...]
def caption_track(doc: Mapping, words: Mapping, pieces: Sequence[Piece]) -> CaptionResult

# glyphs.py
def missing_glyphs(text: str, font_file: Path) -> tuple[str, ...]
def advance_px(text: str, font_file: Path, font_size: float) -> float    # from hmtx, for box/bold splits

# envelope.py / audio_graph.py / loudness.py
Envelope = tuple[tuple[int, int], ...]                                   # (sample, gain_e6), increasing
def speech_envelope(pieces: Sequence[Piece], joins: Mapping[str, int], cut_fade_ms: int,
                    fps: Fps, gain_cdb: int) -> Envelope
def music_envelope(speech_spans: Sequence[tuple[int, int]], item: Mapping,
                   total_samples: int, fps: Fps) -> Envelope
def expand_f32(env: Envelope, total_samples: int) -> bytes
@dataclass(frozen=True)
class AudioFragment: graph: str; inputs: tuple[InputSpec, ...]; sidecars: Mapping[str, bytes]
                     mix_sha256: str
def audio_fragment(plan: RenderPlan, *, mode: str, first_input_index: int) -> AudioFragment
@dataclass(frozen=True)
class Loudness: i_clufs: int; tp_cdb: int
def parse_ebur128(stderr: str) -> Loudness
def master_gain(measured: Loudness, target_clufs: int, tp_cdb: int) -> tuple[int, bool]   # gain_cdb, clamped

# plan.py / compile_ffmpeg.py / layouts.py / execute.py / verify.py / derive.py
def build_plan(doc: Mapping, *, words: Mapping, camera: Mapping | None,
               assets: Mapping[str, Mapping], resources: Resources) -> RenderPlan   # .to_json(), .plan_sha256
def compile_job(plan: RenderPlan, *, mode: str, source: Path, assets_root: Path,
                size: tuple[int, int] | None = None, quality: str = "standar",
                cells: Sequence[int] = (), frame: int | None = None,
                loudness: Loudness | None = None) -> FfmpegJob  # argv, filter_script, inputs, sidecars, expected
def run(job: FfmpegJob, *, output_fd: int | None, timeout_s: float,
        on_progress: Callable[[int], None] | None = None,
        cancel: threading.Event | None = None) -> ExecResult
def verify_output(fd: int, plan: RenderPlan, *, size: tuple[int, int], normalize: bool) -> VerifyReport
def render_key(plan: RenderPlan, *, size: tuple[int, int], quality: str,
               measure_sha: str | None, toolchain_sha: str) -> str   # measure = loudness/peak
# Essentials: size is always the doc's output size and quality "standar"; the parameters stay
# for Stage 2.

# source_info.py / words.py / peaks.py / camera.py / seed.py
def ensure_source_info(job_dir: Path, source: Path) -> dict
def build_peaks(source: Path, window_ms: tuple[int, int], *, per_sec: int = 100) -> bytes
def build_words_artifact(transcription: Transcription, *, clip_id: str, window_ms: tuple[int, int],
                         fps: Fps, audio: AudioTimeline | None, events: Sequence[SoundEvent],
                         peaks: bytes) -> dict
def build_camera_plan(source: Path, window_ms: tuple[int, int], fps: Fps, *, out_w: int,
                      out_h: int, detector: Callable = detect_face_track) -> dict
def build_seed(*, clip: SelectedClip, job: Mapping, source_info: Mapping, words_sha: str,
               words_count: int, camera_sha: str | None, selection_sha: str) -> dict
def prepare_legacy_job(job_dir: Path) -> list[dict]   # persists source/words/peaks/seed once;
                                                       # → [{clip_id|None, index, openable, reason}]

# render_edit.py (W2)
def render_document(doc: Mapping, job_dir: Path, output: Path, *, size: tuple[int, int],
                    quality: str, progress: Callable[[int], None] | None = None,
                    cancel: threading.Event | None = None) -> RenderResult    # mp4 + srt, no-clobber
def render_request(job_dir: Path, request: Mapping, *, heartbeat: Callable[[str, int], None],
                   cancel: threading.Event) -> RenderResult
```

CLIs (stdin JSON envelope → stdout JSON, bounded; exit codes as in T1.1):

| Module | Ops |
|---|---|
| `python -m ai_clipper.edit_v2.api` | `clips`, `prepare_job`, `get`, `put`, `seed`, `archive` |
| `python -m ai_clipper.edit_v2.preview_cli` | `prepare`, `plan`, `cells`, `audio`, `frame`, `derive` |
| `python -m ai_clipper.edit_v2.assets` | `ingest`, `meta` |
| `python -m ai_clipper.edit_v2.cleanup` / `coldopen` | `list` |
| `python -m ai_clipper.editor_ai` | `heuristic`, `run-task` |

### A.2 JavaScript (browser; ESM; no new dependency except jassub and mediabunny)

```js
// web/lib/editor/timemap.mjs — mirrors timemap.py, verified by timemap-vectors.json
export function pieces(doc) {}              // → [{i, seg, role, inSf, outSf, outF0, frames}]
export function totalFrames(pieces) {}
export function smp(n, fps) {}  export function sfFloor(ms, fps) {}  export function wordFrames(sMs, eMs, pieces, fps) {}
export function outToSrc(n, pieces) {}      export function nowMs(n, fps) {}  export function safeCs(n, fps) {}
export function cellFrames(fps) {}

// web/lib/editor/store.mjs
export function createEditorStore({ jobId, clipId, api, previewClient, draftStore, now }) {}
// → { getState() → { status: "loading"|"ready"|"readOnly"|"error", doc, seed, words, etag,
//        save: "saved"|"dirty"|"saving"|"conflict"|"error", savedAtMs, canUndo, canRedo,
//        plan, pending: ["text"|"audio"|"plate"|"logo"], warnings, selection },
//     dispatch(type, args, { mergeKey }?)   // throws CommandRejected(code) when a precondition fails
//     undo(), redo(), flush() → Promise, subscribe(fn) → unsubscribe, destroy() }

// web/lib/editor/player/player.mjs
export function createPlayer({ canvas, fetchImpl, onState, onFrame }) {}
// → { load(planDTO), play() → Promise, pause(), seek(frame) → Promise, step(delta) → Promise,
//     showTruthFrame(frame) → Promise, state() → { mode: "live"|"auto_render"|"truth"|"unsupported",
//     current: { text, plate, audio, logo }, frame }, destroy() }

// web/lib/editor/api-client.mjs
export function createApiClient({ jobId, clipId, fetchImpl }) {}
// → { clips(), getEdit({ seed }), putEdit(doc, { etag, key }), words(url), prepare({ layout }),
//     createRender({ editEtag }, key), getRender(id), cancelRender(id),
//     cleanup(), coldOpenSuggestions(), aiHooks(doc), aiTask(taskId) }

// web/lib/editor/preview-client.mjs
export function createPreviewClient({ jobId, clipId, fetchImpl, debounceMs = 120 }) {}
// → { plan(doc) → Promise<PlanDTO> (latest wins; aborts superseded), frame(doc, f) → Promise<Blob> }

// web/lib/python-cli.mjs (server; landed by T1.Z) — the ONLY way editor routes spawn Python
export function runPythonCli(module, op, payload, { timeoutMs, maxStdoutBytes, withLlmEnv = false, signal }) {}
// → Promise<{ exitCode, json }>; env = allowlist (E11) plus engineProcessEnv(loadLlmEnv()) only
//   when withLlmEnv is true (AI task); process group killed on timeout or abort
export const CHILD_ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "TZ", "TMPDIR", "JOBS_ROOT", "FONTCONFIG_FILE" /* + non-secret flags */];

// web/lib/editor/upload-client.mjs (W3)
export function uploadAsset(jobId, file, kind, { onProgress, signal }) {}
// → Promise<{ sha256, kind, mime, w, h, durationMs, lufsC, peaksUrl }>
```

---

## Lampiran B. Perintah editor (semua dibuat di T2.5)

Every command is pure (`(doc, args) → doc`), sets `audit.last_command`, checks its preconditions
(throwing `CommandRejected(code)` with a user message), and is replayable for rebase.

| Command | Args | Effect | Preconditions | mergeKey |
|---|---|---|---|---|
| `TrimStart` / `TrimEnd` | `{gapWord}` (the word the edge moves next to) | `body.in_sf` / `body.out_sf` = the `bounds` frame of that gap | Body ≥ 3 s and ≤ 300 s; inside the window; cold-open rules still hold | — |
| `RemoveWords` | `{wordIds, reason, origin}` (contiguous) | Removal `[bounds(before first), bounds(after last))`, merged with touching removals | All in one segment and visible; body stays ≥ 3 s | — |
| `RemoveGap` | `{afterWord, inSf, outSf, origin}` | Gap removal (Rapikan `gap_silent`) | Inside the gap; not in a laughter lock | — |
| `RestoreRemoval` | `{removalId}` | Deletes the removal | Exists | — |
| `ApplyCleanup` | `{items}` | One transaction of removals | Each item valid on the current document | — |
| `SetColdOpen` | `{firstWord, lastWord}` or `null` | Cold-open segment from `bounds` + join (`cut`, 30 ms) / removes it | §3.4 cold-open rules | — |
| `NudgeColdOpen` | `{edge: "in"\|"out", words: ±1}` | Moves the edge by one word gap | §3.4 | `co:<edge>` |
| `EditWordText` | `{wordId, text}` | `word_edits[id].text` (removes the key when equal to the ASR text) | 1–40 chars, NFC, no controls | `word:<id>` |
| `SetWordHidden` / `SetWordEmphasis` | `{wordId, on}` | `word_edits[id].hidden` / `.emphasis` | Word in the window | — |
| `SetCaptionsEnabled` / `SetCaptionPack` | `{on}` / `{id}` | `captions.enabled` / `captions.pack` | Known pack | — |
| `SetCaptionOverride` | `{key, value}` (`y_e5`, `size_pm`, `case`, `highlight`, `emphasis`) | `captions.overrides[key]` | Ranges and swatches in §3.3 | `cap:<key>` |
| `SetHookEnabled` / `SetHookText` / `SetHookDuration` / `SetHookY` | `{on, text?}` / `{text, origin}` / `{dur_f}` / `{y_e5}` | Hook track item | §3.3 | `hook:<field>` |
| `SetLayout` | `{mode}` | `layout.default.mode` | Enum | — |
| `SetLogo` / `RemoveLogo` | `{asset, meta}` / `{}` | Logo track item + `assets` entry (default: top-right, `w_e5` 16000, opacity 850) | Asset kind image | — |
| `MoveLogo` / `ResizeLogo` / `SetLogoOpacity` / `SnapLogo` | `{x_e5, y_e5}` / `{w_e5}` / `{opacity_pm}` / `{corner}` | Logo transform | Box inside the frame | `logo:<field>` |
| `SetMusic` / `RemoveMusic` | `{asset, meta}` / `{}` | Music item with defaults (gain from LUFS, loop on, fades 15/30 f, duck "Sedang") + `assets` entry | Asset kind audio | — |
| `SetMusicGain` / `SetMusicOffset` / `SetMusicLoop` / `SetMusicFades` / `SetDuck` | per field | Music payload | §3.3 | `music:<field>` |
| `SetSourceGain` / `SetLoudness` | `{gain_cdb}` / `{mode}` | `audio.source` / `audio.master` | §3.3 | `audio:<field>` |
| `ResetToSeed` | `{}` | Body replaced by the seed's (keeps `base`, `revision`, `parent_sha256`, `audit.created_at_ms`) | — | — |

---

## Lampiran C. Spesifikasi UI (Mode Cepat)

### C.1 Page layout (`/projects/[id]/clips/[clipId]/edit`)

- **At 1920×1080.**
  - Top bar (56 px): "← Proyek", the clip title, the save state ("Tersimpan · 3 dtk lalu" /
    "Menyimpan…" / "Belum tersimpan" / "Konflik"), Undo and Redo, "Perlu dicek (n)",
    **"Ekspor"**.
  - Left panel (380 px) with tabs Transkrip · Teks · Cold open (W2) and Tata letak · Logo · Musik
    (W3).
  - Centre: the 9:16 stage, fitted, with controls underneath: play, frame step, the time
    "00:12,3 / 00:48,0", the safe-zone toggle, the state badge and "Frame akhir".
  - Bottom (240 px): the timeline.
- **At 1366×768:** the left panel shrinks to 320 px, the timeline to 200 px, and the stage
  shrinks with them. Nothing is hidden.
- **Under 1024 px wide:** a notice "Editor butuh layar minimal 1024 px" with a link back to the
  project (the read-only mobile preview is cut, §1.3).

### C.2 Transcript (the spine; a custom word list, not `contenteditable`)

- **Layout.** Sentence units are paragraphs. Words are spans. Words outside the clip are shown
  dimmed with "Perpanjang ke sini" (trim).
- **Removals.** Removed words are struck through and grey with a chip "⋯ 1,4 dtk" that restores
  them.
- **Other marks.** Hidden words are outlined; emphasised words take their colour; the active word
  follows playback, updated outside React.
- **Selection.** Click, Shift+click or drag; arrows move, Shift+arrows extend.
- **Actions on a selection:**
  - **Delete/Backspace** → `RemoveWords` (jump cut);
  - **Enter** or double-click → inline word edit (Enter saves, Esc cancels, Tab goes to the next
    word);
  - **Ctrl+Shift+X** hides from captions;
  - **Ctrl+E** marks the keyword colour;
  - **I / O** → "Mulai di sini" / "Akhiri di sini";
  - **Ctrl+Shift+H** → "Jadikan cold open", disabled with a reason outside 0.5–8 s.
- Clicking a word while playing seeks to it.
- **Protected particles** get no special treatment and are never suggested, but the user can
  select and delete them like any other word.

### C.3 Timeline (output time; zoom with Ctrl+scroll)

- **Lanes:**
  - **Video:** pieces with ⋯ cut markers, the cold-open block (a distinct colour) and trim
    handles on the body edges, magnet-snapped to `bounds` (Alt disables the magnet only for the
    view; the stored value is always a `bounds` frame);
  - **Teks:** cue blocks from the plan;
  - **Hook:** a block with a duration handle;
  - **Audio** (W3): speech waveform per piece, markers (😂 laughter, ⏸ silence, │ camera cut),
    and a music lane with the duck curve drawn from the plan.
- **Plate state.** Cells still building show as hatched bands.
- **Interaction.** Clicking seeks; dragging the playhead scrubs (throttled per animation frame).

### C.4 Keyboard map

| Key | Action |
|---|---|
| Space / K | Play / pause |
| ← / → | One frame (with Shift: 1 s) |
| Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y | Undo / redo |
| Delete / Backspace | Remove the selected words |
| Enter | Edit the word |
| I / O | Trim start / end at the selection or playhead (snapped) |
| Ctrl+Shift+H | Selection → cold open |
| Ctrl+E / Ctrl+Shift+X | Keyword colour / hide from captions |
| ' | Safe-zone overlay |
| Ctrl+Shift+R | Frame akhir (truth frame) |
| Ctrl+Shift+E | Ekspor |
| ? | Help |

Every action also has a visible control; focus order is logical, and focus rings stay visible.

### C.5 Export dialog

1. The revision to export (autosave is flushed first) and the "Perlu dicek" items, which must be
   acknowledged one by one.
2. The output line: "720×1280, kualitas sama dengan klip otomatis". When the content equals
   the AI version: "Tanpa perubahan: file klip otomatis dipakai langsung" (R10).
3. Progress stages: Antre → Merender (n%) → Memverifikasi → Selesai. Cancel stays available until
   the end.
4. The result: "Unduh MP4", "Unduh SRT", and the read-only title, description and hashtags with
   copy buttons. `peak_reduced` or `loudness_clamped` are shown as notes.
5. Earlier exports of this clip (revision, time, link).
6. On `verification_failed`: an Indonesian explanation plus "Coba lagi".

### C.6 States and wording

| State | Copy |
|---|---|
| Loading | Skeleton + "Membuka klip…" |
| Preparing | "Menyiapkan analisis klip (kata, waveform, wajah)…" with progress |
| Stage current | "● Sesuai hasil akhir" (help popover: §6.1 "What 'sesuai' cannot mean") |
| Clip not openable | Per `reason`: "Video sumber sudah tidak ada", "Hasil seleksi tidak terbaca", "Transkrip tidak ditemukan", "Analisis job belum selesai", "Job ini bukan job V3" |
| Marker data missing | "Penanda tawa/jeda tidak tersedia untuk job ini" |
| Stage pending | "Memperbarui teks…" / "Menyiapkan audio…" / "Menyiapkan video (7/30)…" |
| Revision 0 fallback | "Memutar klip otomatis (identik)" |
| Legacy engine | "Klip ini dibuat dengan mesin lama; ekspor dari editor memakai mesin baru" |
| Transcript changed | "Transkrip berubah sejak klip diedit" → "Mulai dari versi AI" |
| Unsupported browser | "Pratinjau langsung butuh Chrome/Edge desktop. Anda tetap bisa mengedit dan mengekspor." |
| Conflict | "Klip ini diubah di tab lain" → auto-merge toast or the per-part dialog |
| Save error | "Gagal menyimpan; perubahan aman di browser ini" + retry |
