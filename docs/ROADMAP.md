# Roadmap & status Potongin

Terakhir diperbarui: 2026-09-24. Legenda: ✅ selesai · 🔄 sedang dikerjakan · ⬜ belum · ⏸️ ditunda
(menunggu keputusan). Selection V3 dan halaman Pengaturan AI sudah di `main` dan live di
https://potongin.revdonz.dev sejak 2026-09-24. Empat tugas susulan (server LLM sendiri + 9Router,
thumbnail + upgrade Next/React, Whisper, heuristik v3.1) live sejak 2026-09-24 (PR #6).
Editor V3 Esensial dikerjakan di branch `feat/editor-v3-esensial` mulai 2026-09-25.

Dokumen rujukan:
- Rencana teknis: [`docs/plans/2026-09-24-selection-v3-llm-hooks.md`](plans/2026-09-24-selection-v3-llm-hooks.md)
- Hasil benchmark: [`docs/evaluation/SELECTION_BENCHMARK.md`](evaluation/SELECTION_BENCHMARK.md)
- Standar editorial AI: [`docs/operations/STANDAR_KLIP_AI.md`](operations/STANDAR_KLIP_AI.md)
- Penyedia LLM gratis: [`docs/operations/LLM_PROVIDERS.md`](operations/LLM_PROVIDERS.md)
- Transkripsi Whisper: [`docs/operations/TRANSCRIPTION.md`](operations/TRANSCRIPTION.md)

## 1. Analisis & evaluasi

- ✅ Audit algoritma lama (V1/V2) di podcast asli 65 menit. Kemampuan skor membedakan momen
  bagus hampir setara lempar koin (AUC 0,50–0,57). V1 selalu 60 detik dengan kata kunci di
  ekor klip.
- ✅ Analisis LokaClip (Tauri/Rust, LLM via OpenRouter/BYOK, whisper.cpp, YuNet + active
  speaker, overlay teks hook).
- ✅ Riset industri (OpusClip, Klap, Vizard, PodReels, dll.).
- ✅ Gold set editor untuk 4 episode:
  - penyetelan: Iqbaal, Tuah Kreasi;
  - ujian 1: dr. Tirta, Ferry × Reza.
- ✅ Harness benchmark (`python -m ai_clipper.benchmark`): Recall/Precision@K, jebakan, IoU.
- ✅ Benchmark pertama V1/V2/V3. Hasil di ujian 1, top-5 dari 48 momen:
  - V1: 3 momen, 2 jebakan;
  - V3 heuristik: 6–7 momen;
  - V3 LLM: 9 momen, 0 jebakan.
- ✅ Sweep model gratis Ollama Cloud. Hasil top-10:
  - `gemma4:31b`: 9 momen (menjadi default);
  - `gpt-oss:120b`: 4 momen;
  - model lain berbayar, kehabisan token, atau timeout.
- ✅ Gold set ujian 2 (episode segar, 36 momen + 18 jebakan): VINDES Pandji × Desta, Raditya Dika × Habib Industri,
  Suara Berkelas #209.
- ✅ Benchmark final V3 (kode dibekukan, dijalankan sekali). Gabungan 5 episode ujian (60 gold):
  V3-LLM (Hermes) top-5 **12** vs V1 7, top-10 20 vs 17, jebakan @10 **1** vs 5, presisi @5
  0,48 vs 0,28. Heuristik masih lemah di episode banter.
- ⬜ Label dari pemilik sendiri (5–10 episode) dan data retensi nyata (YouTube/TikTok
  analytics). Gold saat ini masih proksi dari LLM.

## 2. Transkrip & sinyal

- ✅ Timestamp per kata (Whisper `word_timestamps`), `TranscriptWord`, dan IO transkrip yang
  atomik dan ketat.
- ✅ Cek kualitas transkrip: tanda baca hilang, loop halusinasi, huruf asing, confidence rendah,
  timestamp terkuantisasi.
- ✅ Peringatan `no_punctuation` saat seluruh file tanpa tanda baca (terbukti menangkap episode
  Deddy × dr. Gia, 1,2% bertanda baca).
- ✅ Tanda baca Whisper `small` tidak lagi hilang: `condition_on_previous_text` dimatikan dan
  prompt pendek bertanda baca dipasang di tiap jendela 30 detik. Segmen bertanda baca di 3
  episode penuh 2% / 1% / 59% → 91% / 93% / 96%, akurasi kata sama, 21% lebih cepat. Bisa
  diatur lewat `WHISPER_*` atau flag CLI. `large-v3-turbo` ~30% lebih akurat tapi 1,9× lebih
  lambat, jadi `small` tetap default.
- ⬜ Whisper kadang menerjemahkan sisipan bahasa Inggris ("however" → "bagaimanapun") dan
  sesekali membuat loop pendek ("Bukan gue." ×8).
- ⬜ Simpan cache model Whisper di `/data` (`HF_HOME`) agar tidak diunduh ulang tiap deploy;
  setelan jumlah thread CPU.
- ✅ Unit kalimat yang tidak bergantung pada tanda baca (memakai jeda antar-kata).
- ✅ Jalur cepat subtitle YouTube (json3): timing per kata, tanda baca, dan penanda
  `[tertawa]`/`[tepuk tangan]`, dengan cek kualitas. Terbukti lebih andal daripada Whisper
  `small`, yang gagal tanda baca di 2 dari 4 episode.
- ✅ Timeline audio satu kali jalan: loudness relatif, jeda, dan potongan kamera.
- ⬜ Deteksi tawa dari audio untuk video tanpa subtitle YouTube (misalnya PANNs/Gillick). Saat
  ini tawa hanya diketahui dari tag subtitle.
- ⬜ Diarization atau penanda pembicara (host vs tamu).

## 3. AI / LLM gratis

- ✅ Klien LLM universal OpenAI-compatible: Gemini, Groq, OpenRouter, Cerebras, Mistral,
  DeepSeek, OpenAI, Ollama lokal, Ollama Cloud, dan sampai 3 server sendiri (custom, custom2,
  custom3).
- ✅ Server sendiri bisa diberi nama (mis. Hermes, 9Router), key disegel per server, kartu
  "9Router (gateway)" dengan peringatan ketentuan layanan dan alarm untuk rute langganan
  (`cc/`, `cx/`, `gh/`, `cu/`). `compose.yaml` memetakan `host.docker.internal`.
- ✅ Rantai fallback antar-provider dan antar-model, mode `FREE_ONLY`, cache respons, retry,
  rate limit, dan key tidak pernah bocor.
- ✅ `STANDAR_KLIP_AI.md`: standar editorial yang sekaligus menjadi prompt sistem untuk model
  apa pun.
- ✅ Selector LLM: baris ber-ID, validasi dan perbaikan jawaban, dedupe, peringkat ulang.
- ✅ Default Ollama Cloud diganti ke `gemma4:31b`, dengan cadangan `gpt-oss:120b`.
- ✅ Model lokal pemilik (Hermes `LJNAI-FAST`, OpenAI-compatible) dengan fase berpikir dimatikan
  (`reasoning_effort=none`) menjadi provider utama. Top-10: 9 momen, setara Gemma, 10/10 klip
  valid.
- ✅ Adu model di 5 episode ujian dengan kode final: `gemma4:31b` terbaik (top-5 17 vs Hermes
  12 vs V1 7; top-10 27 vs 20 vs 17). Rantai default: ollama-cloud (Gemma) → custom (Hermes)
  → openrouter.
- ✅ **Halaman Pengaturan AI (`/settings`)**:
  - provider, API key, URL, dan model diatur dari UI;
  - key terenkripsi AES-256-GCM di `/data/settings`;
  - worker memakai pengaturan UI dan mengabaikan `.env`;
  - tersedia "Tes koneksi", "Ambil daftar model", dan impor dari `.env`;
  - review keamanan memperbaiki 2 celah; 396 test web lolos.
- ✅ Produksi: `APP_SESSION_SECRET` sudah acak; key LLM diimpor ke `/settings` (terenkripsi di
  `/data/settings`). Tes dari worker: ollama-cloud `gemma4:31b` 0,7 dtk, Hermes 0,2 dtk,
  OpenRouter `:free` 22 dtk; Gemini/Groq belum punya key.
- ⬜ Ganti semua key yang sempat tertempel di chat (Hermes, OpenRouter, Ollama) lalu isi yang
  baru di `/settings`.
- ✅ Perbaikan hasil sweep (tuning: top-5 4→8, top-10 9→13):
  - jangan buang momen saat kutipan hook tidak persis (Gemma kehilangan 9 dari 10 momen);
  - judul jangan menyalin mentah transkrip;
  - dorong durasi mendekati momen ideal (sekitar 60–70 detik);
  - coba lagi dengan model berikutnya saat jawaban kosong atau terlalu sedikit.
- ✅ Skor gabungan konsisten dengan sub-skor; rerank hanya menentukan urutan.
- ⬜ Perbarui `LLM_PROVIDERS.md` dengan hasil sweep: model gratis vs berbayar di Ollama Cloud,
  dan kredit awal paket Free.

## 4. Pemilihan klip V3

- ✅ Tipe data bersama (`selection_types.py`) dan penanda suara (`sound_events.py`).
- ✅ Selector heuristik tanpa internet (pertanyaan host → jawaban, tawa, kontras, reveal,
  penalti basa-basi/sponsor/segue).
- ✅ Orkestrator (`selection_v3.py`):
  - penyelarasan batas ke kata dan jeda;
  - ekor tawa;
  - keputusan cold open;
  - keberagaman topik;
  - fallback otomatis ke heuristik;
  - artefak `selection.v3.json`.
- ✅ Setel ulang heuristik (tuning: top-5 17→21, top-10 30→36, jebakan 5→2).
- ✅ Heuristik v3.1: tawa tertulis untuk transkrip tanpa tag, reaksi host, label humor yang
  lebih ketat. Tuning top-5 21→23, top-10 36→37; held-out hits sama, jebakan @5 9→6.
- ✅ Teks hook (≤60) dan judul (≤70 karakter) heuristik dari kalimat bersih, tanpa "…":
  dari 80 proposal tuning, elipsis 36→0 dan judul bermasalah 28→0.
- ⬜ Heuristik untuk episode banter/komedi: VINDES tetap 0/12 setelah v3.1 (episode itu hanya
  punya 1 tag tawa dalam 78 menit). Butuh sinyal lain (giliran bicara, tawa dari audio) dan
  episode banter baru ber-gold untuk validasi. Sementara ini momen komedi mengandalkan LLM.
- ⬜ Kata hasil ASR yang rusak (mis. "kuulu") masih bisa lolos ke judul heuristik.
- ⬜ Uji end-to-end V3 di episode tanpa subtitle YouTube (Deddy × dr. Gia, jalur Whisper).

## 5. Render & kemasan klip

- ✅ Cold open: kalimat terkuat diputar lebih dulu, lalu klip mulai dari setup.
- ✅ Teks hook di 4 detik pertama (area aman atas, kotak semi-transparan).
- ✅ Caption karaoke per kata (ASS/libass). File `.srt` unduhan sama persis dengan yang
  di-burn.
- ✅ Kata di tepi segmen tidak lagi hilang dari caption.
- ✅ Thumbnail tiap klip (`clip-XX.jpg`, frame detik ke-1, lebar 720) dipakai sebagai poster
  video di dashboard dan halaman proyek. Job lama tetap tanpa poster.
- ⬜ Face-track memakai active speaker (sekarang mengikuti wajah terbesar).

## 6. Pipeline & CLI

- ✅ Mode `--selection-mode v3` di `pipeline.py`/`cli.py` (tahap 3b):
  - subtitle YouTube lalu fallback Whisper;
  - timeline audio;
  - LLM;
  - render kemasan;
  - manifest baru.
- ✅ Review adversarial dan uji end-to-end sungguhan (jalur subtitle + LLM, dan jalur Whisper
  tanpa LLM). 1.533 test Python + 361 test web lolos.
- ⬜ Timeout render disesuaikan dengan panjang klip; batas FFmpeg 300 detik untuk klip panjang.
- ⬜ Perkuat test berbasis waktu yang kadang gagal di runner CI:
  `tests/test_render_worker.py::test_worker_heartbeats_during_long_render_and_prevents_reclaim`.

## 7. Web, dashboard & deploy

- ✅ Artefak `analysis/` dan sumber YouTube tidak lagi "tersangkut" di `.attempts/` untuk job
  dashboard.
- ✅ Dashboard:
  - V3 sebagai default ("AI Hook (V3)");
  - pilihan LLM/heuristik, cold open, teks hook, karaoke/klasik;
  - badge status LLM;
  - mode lama di menu terpisah.
- ✅ Halaman proyek "Klip siap posting": judul, teks hook, jenis hook, skor + 5 sub-skor,
  alasan, caption + hashtag + tombol salin, badge sumber, chip cold open.
- ✅ Worker mengunduh subtitle YouTube (manual + auto).
- ✅ `compose.yaml` meneruskan variabel LLM; `.env.example` punya bagian LLM; README
  diperbarui.
- ✅ Jalan lokal lengkap (web + worker), generate sungguhan dari dashboard: `bash
  artifacts/local/start-local.sh`, lalu buka http://127.0.0.1:3000. Video Ferry × Reza 66 menit
  selesai dalam ~2 menit (subtitle YouTube → Gemma → render 3 klip).
- ✅ Deploy produksi 2026-09-24 lewat GitHub Actions (PR #4 dan #5): semua kontainer di image
  `3169ab0`, `/api/health` 200.
- ✅ Upgrade Next.js 16.3.3 → 16.3.6 (perbaikan RCE `next/og`) dan React 19.2.8 → 19.3.0; test
  dan build lolos, image Docker memakai versi baru.
- ✅ `next.config`: `agentRules: false` (dev server tidak lagi membuat `AGENTS.md`/`CLAUDE.md`).
- ⬜ Backfill job dashboard lama yang artefaknya tersangkut sebelum perbaikan.
- ⬜ `.env.example`: tambahkan `JOBS_STORAGE_*`; README: port 8100 vs 3000.

## 8. Editor V3 Esensial (kualitas penuh)

Keputusan: esensial dulu, lalu bertahap. Desain final ada di scratchpad sesi
(`editor-design/FINAL-editor-design.md`) dan akan dipindah ke `docs/plans/` saat mulai.

- ✅ Riset editor: audit editor lama (8 bug), inventaris fitur CapCut/LokaClip/Descript, dan
  teknologi preview = render.
- ✅ Desain arsitektur (3 proposal + juri): satu *render plan* dijalankan di browser
  (WebGL2 + libass-WASM) dan di FFmpeg, dengan gerbang kualitas berangka.
- ✅ Rencana eksekusi Editor V3 Esensial sudah jadi dan dikritik:
  [`docs/plans/2026-09-24-editor-v3-esensial.md`](plans/2026-09-24-editor-v3-esensial.md).
  Isinya 4 gelombang (W1–W4, ~30 agen) + cadangan W5; riset di
  [`docs/plans/editor-v3-research/`](plans/editor-v3-research/).
- ✅ Keputusan pemilik K1–K15: semua rekomendasi diterima; mesin acuan = PC Ryzen 7 5700G.
- 🔄 **Eksekusi dimulai 2026-09-25** di branch `feat/editor-v3-esensial`: W1 "Mesin tunggal".
- (arsip) Keputusan teknis dari desain FINAL (rekomendasi dalam kurung):
  - komposit yuv444p (ya);
  - blur "plate" resolusi rendah (perlu dilihat berdampingan);
  - frame rate asli (ya);
  - Node di jalur render (ya);
  - selisih versi libass (terima dengan gerbang);
  - browser Chrome/Edge desktop dulu (ya).
- ⬜ Perbaiki 8 bug editor lama:
  - opasitas latar caption;
  - caption terpotong sekitar 64 karakter;
  - escape `\N`;
  - normalize 96 kHz;
  - logo tidak pernah ter-render;
  - warna kata kunci tidak berfungsi;
  - simpan mati setelah 1.000 kali;
  - render lama tidak ikut diperbaiki.
- ⬜ Buka klip V3 di editor (`clip_id` stabil; revisi 0 = versi AI).
- ⬜ Trim menempel ke kata dan atur cold open.
- ⬜ Edit teks hook dan saran hook dari AI.
- ⬜ Edit caption dengan 4 preset (karaoke, bold, box, klasik); preview caption identik render.
- ⬜ Potong berbasis transkrip (hapus kata/filler jadi jump cut).
- ⬜ Ganti layout (fit-blur, face-track, center-crop).
- ⬜ Logo/watermark.
- ⬜ Musik latar dengan ducking.
- ⬜ Waveform dan penanda tawa di timeline.
- ⬜ Gerbang kualitas: uji paritas frame (SSIM), undo/autosave, dan performa.

## 9. Editor tahap lanjut (sesi berikutnya)

- ⬜ Sisa tahap 1 level LokaClip:
  - preset caption 8 paket;
  - 9 desain hook;
  - stiker/emoji;
  - split-screen 2 pembicara;
  - B-roll;
  - template;
  - ekspor.
- ⬜ Tahap 2 multi-track ala CapCut: timeline multi-layer, shortcut, keyframe + easing,
  transisi, efek/LUT.
- ⬜ Tahap 3: keyframe, transisi, dan efek tingkat lanjut, dipindah ke browser setelah terbukti
  identik dengan server.

## 10. Rilis & operasional

- ✅ Review kode akhir (bug, keamanan, performa) dan uji integrasi sebelum commit.
- ✅ Commit bertahap dan PR ke `main` (PR #4 Selection V3 + Pengaturan AI, PR #5 CI).
- ✅ Rollout: V3 default di produksi (2026-09-24).
- ⬜ Ganti password SSH VM dan pindah ke login dengan SSH key.
