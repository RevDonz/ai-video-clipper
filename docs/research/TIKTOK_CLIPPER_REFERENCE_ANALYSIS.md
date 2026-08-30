# TikTok Clipper Reference Analysis

Captured at: 2026-08-30T14:49:47+07:00

## Tujuan

Menerjemahkan pola hook, pemilihan momen, editing, caption, dan UX platform dari referensi TikTok menjadi requirement terukur untuk Potongin AI. Referensi ini tidak disalin sebagai data training tanpa hak; ia dipakai sebagai evidence desain. Dataset training akan berasal dari sumber yang berhak diproses dan feedback pengguna Potongin.

## Sumber yang dianalisis

| Ref | Sumber | Durasi | Performa publik saat inspeksi | Peran |
|---|---|---:|---:|---|
| 1 | [`@edit.byta` video `7657119441938877717`](https://www.tiktok.com/@edit.byta/video/7657119441938877717) | 26 dtk | 42,9K views; 1.556 likes; 195 repost | Hook kontroversial + showcase before/after |
| 2/5 | [`@tan.rap` video `7504313016574364933`](https://www.tiktok.com/@tan.rap/video/7504313016574364933) | 45,7 dtk | 823,5K views; 34K likes; 3.401 repost | Demo platform AI clipper; kedua short URL mengarah ke video yang sama |
| 3 | [`@dunia.short88` video `7429057488537898247`](https://www.tiktok.com/@dunia.short88/video/7429057488537898247) | 4:48 | 15,7M views; 935,5K likes; 120,1K repost | Long-form educational podcast clip |
| 4 | [`@eric_lee74` video `7543571738555206917`](https://www.tiktok.com/@eric_lee74/video/7543571738555206917) | 2:38 | sekitar 324K views | Tutorial strategi clipper + sponsored integration |

Metode evidence: metadata publik, video media yang berhasil diakses, Whisper `small`
transcript, frame 0–5 detik per detik, 10 frame terdistribusi sepanjang video,
dan scene-change sampling. Engagement bersifat mutable dan hanya snapshot pada waktu
capture di atas. Hubungan antara pola edit dan performa adalah hipotesis untuk diuji,
bukan bukti kausal.

## Temuan per referensi

### Referensi 1 — pertanyaan provokatif dan mini-story lengkap

Hook audio dimulai tanpa intro pada 00:00–00:02:

> “Loh dokter berarti nggak punya teman?”

Struktur semantik:

1. Pertanyaan yang memicu konflik.
2. Jawaban kontra-intuitif: pasangan/keluarga sebagai teman terdekat.
3. Sanggahan singkat dari host.
4. Elaborasi.
5. Payoff pada 00:20–00:25: banyak relasi dianggap transaksional dan kebetulan bertemu.

Editing yang teramati:

- Before/after tampil serentak.
- Timeline editor terlihat sebagai bukti proses.
- Crop berganti mengikuti pembicara.
- Subtitle putih dengan keyword kuning.
- Beberapa graphic/B-roll inserts.
- Watermark kecil dan konsisten.

Pelajaran:

- Hook yang kuat adalah relasi antara kalimat pertama dan payoff, bukan keyword tunggal.
- Kandidat harus dinilai atas curiosity gap, contradiction, dan completeness.
- Showcase before/after adalah mode output berbeda dari clean clip.

### Referensi 2/5 — demo platform AI clipper

Hook audio pada sekitar 00:00–00:07:

> “Channel ini bisa monet dan dapat ratusan ribu subscriber dari klip podcast doang.”

Lalu memberi promise:

> “Cara bikin klip podcast otomatis, gratis, tanpa watermark.”

Alur produk yang terlihat/dijelaskan:

1. Social proof dan hasil yang diinginkan.
2. CTA save.
3. Ambil video panjang.
4. Buka AI Clip Maker.
5. Drop/upload video.
6. Pilih caption dan durasi.
7. Convert.
8. Sistem menghasilkan beberapa clip dan memberi keterangan bagian yang bagus.
9. Download tanpa watermark.
10. Rights reminder sebelum upload ulang.

Pelajaran UX:

- Pengguna membutuhkan preview hasil sebelum render/download.
- Caption style dan durasi harus menjadi preset yang mudah dipahami.
- AI harus menjelaskan mengapa kandidat dianggap bagus.
- Workflow ideal adalah select → customize → render, bukan create-job lalu menerima output final yang tidak dapat dikoreksi.

### Referensi 3 — clip 4:48 yang tetap sangat viral

Hook membuka masalah langsung pada sekitar 00:00–00:08:

> “Kenapa banyak orang asam lambung dan gimana caranya nggak asam lambung?”

Struktur:

1. Masalah dan pertanyaan universal.
2. Mekanisme biologis dasar.
3. Analogi dan humor percakapan.
4. Gejala dan konsekuensi berjenjang.
5. Mitos/pertanyaan host.
6. Solusi praktis.
7. Konsekuensi ekstrem sebagai penutup.

Editing:

- Hampir seluruh video memakai editorial speaker switching berdasarkan siapa yang
  terlihat berbicara; ini observasi hasil edit, bukan bukti diarization otomatis.
- Full-screen close crop, tanpa layout blur.
- Subtitle uppercase putih dengan outline hitam.
- Keyword/topik awal diberi blok merah.
- Pergantian visual terutama berasal dari pergantian speaker dan ekspresi, bukan B-roll.
- Gestur dan ekspresi wajah dibiarkan menjadi retention device.

Pelajaran:

- Batas 30–60 detik tidak universal. Deep-dive 1–5 menit dapat berhasil jika information density dan topic continuity tinggi.
- Model harus memiliki content profile: `viral-short`, `standard`, dan `deep-dive`.
- Hipotesis yang perlu diuji: untuk dialog kuat, speaker switching + caption yang
  sangat terbaca dapat cukup mempertahankan perhatian tanpa B-roll berlebihan.

### Referensi 4 — strategi clipper yang dijelaskan eksplisit

Hook pada sekitar 00:00–00:06:

> “Waktu gue jadi editornya Raymond Chin, gue harus bikin 60 clippers dalam satu bulan. Mau tahu caranya?”

Retention devices:

- Authority/proof: pernah menjadi editor Raymond Chin.
- Angka spesifik: 60 clips dalam satu bulan.
- Open loop: “mau tahu caranya?”
- Pattern interrupt berupa candaan sebelum masuk empat lesson.
- Numbered lessons.
- Graphic card `6 → 60`.
- On-camera, example inserts, screen recording, lalu product B-roll.

Empat prinsip yang disebut:

1. Satu detik pertama sangat penting.
2. Hook harus relevan, bukan hanya cepat.
3. Clip harus short and concise; preferensi kreator 30–60 detik.
4. Gunakan AI tools untuk reframe horizontal ke vertikal.

Pelajaran:

- Skor hook perlu menilai proof/authority, angka spesifik, relevance, dan open loop.
- Structured list memberi alasan untuk terus menonton.
- Sponsor/product section ditempatkan setelah value utama; jangan membiarkan CTA mengganggu hook.

## Editing grammar untuk Potongin

### Caption

Preset awal:

1. `clean`: sentence case, putih, outline gelap.
2. `bold-keyword`: uppercase/semibold, keyword kuning atau merah.
3. `karaoke`: active word highlight.
4. `podcast`: 2 baris, lower-middle, outline kuat, safe-area TikTok.
5. `minimal`: satu baris, ukuran kecil, tanpa animasi agresif.

Kontrol:

- font, size, weight, casing;
- warna base, keyword, warning;
- outline/shadow/background;
- posisi dan safe-area;
- max words/cue dan max lines;
- entrance animation;
- keyword manual override.

### Visual rhythm

Gunakan perubahan visual saat ada alasan semantik:

- editorial speaker switching atau prominent-face target berubah;
- keyword/punchline;
- contoh atau analogi;
- entity yang dapat divisualisasikan;
- perubahan topik;
- emosi/gestur kuat.

Hindari transisi acak. Mode dialog dapat cukup dengan editorial speaker cuts. Mode
explainer dapat memakai speaker → icon/B-roll → speaker → graphic card.

### Output modes

- `clean-clip`: hasil final siap upload.
- `dynamic-clip`: keyword graphics, icon/B-roll, prominent-face tracking.
- `editing-showcase`: before/after + timeline untuk portofolio editor.

## Clip Selection V2

### Candidate generation

- Gunakan sentence boundary, pause, speaker turn, dan topic boundary.
- Jangan selalu memperpanjang window sampai max duration.
- Bentuk beberapa varian boundary untuk satu momen.
- Profile durasi:
  - `viral-short`: 15–45 detik;
  - `standard`: 30–90 detik;
  - `deep-dive`: 60–300 detik.

### Score dimensions

Setiap kandidat mendapat score breakdown 0–10:

- `hook_strength`: question, contradiction, bold claim, number/proof, pain point, open loop;
- `hook_relevance`: hubungan hook dengan isi/payoff;
- `standalone_context`: dapat dipahami tanpa menit sebelumnya;
- `payoff_completeness`: jawaban/insight selesai;
- `information_density`;
- `emotion_energy`: prosody, volume, tempo, laughter;
- `dialogue_dynamics`: speaker turns yang mendukung konflik/clarification;
- `visual_activity`: scene, face, gesture, motion;
- `topic_value`: actionable, surprising, relatable;
- `boundary_quality`: tidak mulai/berakhir di tengah kalimat;
- `novelty` dan `diversity` terhadap kandidat lain;
- penalties: intro, outro, sponsor-first, repetition, missing context, transcription uncertainty.

Output harus bernama `clip potential`, bukan jaminan viral, dan menyertakan reasons.

### Diversity selection

Setelah ranking, gunakan greedy/MMR selection:

- hindari overlap timestamp;
- hindari topik semantik yang terlalu mirip;
- tetap izinkan dua kandidat dari topik sama jika payoff berbeda;
- urutan tampilan dapat chronological, tetapi UI juga menampilkan rank/score sebenarnya.

## Training and feedback strategy

Jangan langsung fine-tune model dari empat referensi. Mulai dengan human-in-the-loop dataset:

- kandidat yang diterima/ditolak;
- rank yang dipilih user;
- perubahan start/end;
- perubahan caption/keyword;
- rerender count;
- download/publish action;
- alasan manual opsional.

Simpan model/prompt/feature version. Split evaluation berdasarkan source video, bukan candidate window, untuk mencegah leakage.

Quality metrics:

- Precision@K berdasarkan clip yang dipertahankan;
- acceptance/download rate;
- median boundary adjustment;
- duplicate-topic rate;
- average human edit time;
- caption correction rate;
- prominent-face crop correction rate;

Gunakan 50–100 source videos berlabel sebagai **gate eksperimen awal**, bukan minimum
ilmiah. Sebelum itu gunakan explainable weighted scorer dan kumpulkan feedback; ukur
learning curve pada source-level split untuk menentukan apakah data sudah cukup.

## Product decision

Customized editor Potongin harus correction-oriented, bukan clone CapCut penuh. Fokus pada tindakan yang paling sering memperbaiki output AI:

- pilih/tolak kandidat;
- trim boundary;
- ubah layout/crop dan prominent-face tracking;
- edit transcript/caption;
- pilih caption preset;
- highlight keyword;
- tambahkan/matikan visual insert;
- preview lalu rerender deterministik.
