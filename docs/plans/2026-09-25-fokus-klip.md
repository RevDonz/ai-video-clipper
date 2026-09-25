# Fokus klip: spesifikasi

Tanggal: 2026-09-25. Status: kontrak untuk implementasi (branch `feat/focus-keywords`), dibangun di atas Konteks Tren
(sudah di `main`) karena memakai mesin yang sama (pencocokan kata kunci, blok prompt
bersyarat, cek grounding).

## Ringkasan untuk pemilik

Saat membuat job, pemilik bisa mengisi **kata kunci atau topik yang dicari** (contoh: video
Reza Auditore + "jomok"). Pemilihan klip **mengutamakan** momen yang cocok; bila momen yang cocok
kurang dari jumlah klip yang diminta, sisa slot diisi momen terbaik lain yang diberi label
"di luar fokus" (keputusan pemilik 2026-09-25: *utamakan, sisanya diisi*).

Prinsip:
1. **Tanpa fokus, hasil identik** dengan sekarang (prompt LLM byte-identik, seleksi, artefak).
2. **Jujur soal alasan.** Setiap klip berlabel salah satu: "Menyebut 'jomok' · 12:34"
   (literal, dicek kode), "Terkait 'jomok' (menurut AI)" (makna, klaim LLM), atau
   "Di luar fokus".
3. **Kualitas tetap dijaga.** Fokus menentukan urutan prioritas, bukan alasan memilih momen yang
   jelek. Momen fokus tetap harus lolos validasi dan standar editorial seperti momen lain.

## 1. Opsi job

```jsonc
"focus": {
  "terms": ["jomok", "jomokers"],   // 1..8 istilah, masing-masing 2..40 karakter, unik (casefold)
  "note": "momen jomok yang lucu",   // opsional, 0..200 karakter: deskripsi bebas untuk AI
  "mode": "prefer"                    // hanya "prefer" untuk sekarang; enum disiapkan untuk "only"
}
```

- Hanya untuk `selectionMode: "v3"`. Teks dinormalisasi seperti item tren (NFC, tanpa
  kontrol/bidi/zero-width, spasi dirapikan).
- Form dashboard: field `focusTerms` (dipisah koma atau Enter menjadi chip) dan `focusNote`.
  Kosong = tanpa fokus (opsi `focus` tidak ditulis).
- CLI: `--focus-term TERM` (boleh berulang, maks 8) dan `--focus-note TEXT`. Worker meneruskan
  opsi job ke CLI.

## 2. Engine

- **Pencocokan literal:** pakai ulang mesin pencocokan Konteks Tren (casefold, tanpa aksen,
  batas kata Unicode, frasa). Istilah < 3 huruf atau stopword tidak cocok sendirian. Hasil:
  daftar kemunculan (unit, waktu) per istilah.
- **Imbuhan bahasa Indonesia (wajib untuk fokus):** istilah satu kata juga cocok dengan kata
  turunannya: awalan `di-, ke-, se-, ber-, be-, per-, pe-, ter-, me-, mem-, men-, meng-, meny-,
  peng-, pen-, pem-, peny-` dan akhiran/partikel `-an, -kan, -i, -in, -nya, -ku, -mu, -lah, -kah,
  -pun, -tah`, termasuk konfiks (`per…an`, `ke…an`, `pe…an`) dan pengulangan (`jomok-jomok`).
  Contoh nyata dari transkrip `rBg0ZcwjVKQ` (Ferry × Reza): "jomok" harus cocok dengan
  "perjomokan", "jomoknya", "kejomok", "jomok-jomok", tetapi tidak dengan kata lain yang
  kebetulan memuat hurufnya (batas: sisa kata setelah imbuhan dilepas harus persis istilahnya;
  istilah < 4 huruf tidak memakai pelepasan awalan). Pelepasan imbuhan ini **khusus fokus**;
  pencocokan Konteks Tren tidak berubah (kecuali bila diputuskan terpisah).
- **LLM:** blok bersyarat "FOKUS PENGGUNA" di pesan pengguna, hanya bila fokus diisi:
  - istilah dan catatan pemilik (di-escape, dibatasi);
  - daftar ID baris yang menyebut istilah secara literal (maks 60), sebagai petunjuk;
  - instruksi: utamakan momen yang membahas fokus, baik disebut langsung maupun maknanya; beri
    tiap momen `"focus": "literal" | "semantic" | "none"`; tetap nilai kualitas menurut standar;
    usulkan semua momen fokus yang layak lebih dulu, lalu momen terbaik lain.
- **Validasi di kode:**
  - `literal` diterima hanya bila unit klip final memuat istilah; kalau tidak, diturunkan ke
    `semantic` bila catatan/istilah relevan menurut LLM, dicatat `focus_literal_ungrounded:<n>`;
  - `semantic` diterima sebagai klaim LLM dan dilabeli "(menurut AI)";
  - klip heuristik: `literal` bila memuat istilah, selain itu `none`.
- **Urutan (mode prefer):** partisi stabil: klip `literal`, lalu `semantic`, lalu `none`,
  masing-masing dengan urutan kualitasnya sendiri (rerank LLM / skor heuristik). Dorongan
  Konteks Tren tetap berlaku di dalam tiap partisi. `score` dan sub-skor yang ditampilkan tidak
  berubah.
- **Heuristik fallback:** kandidat heuristik yang menyentuh kemunculan literal diprioritaskan
  dengan partisi yang sama; bila perlu, satu kandidat tambahan dibentuk di sekitar setiap
  kemunculan literal yang belum tercakup (tetap melalui snapping dan aturan durasi).
- **Kemasan:** judul, teks hook, dan deskripsi boleh memakai tema fokus hanya untuk klip
  `literal`/`semantic`.
- **Keluaran:** `SelectedClip.focus = {match, terms, at}` (`at` = waktu kemunculan literal
  dalam klip, detik); `selection.v3.json` dan manifest mencatatnya; ringkasan job
  `focus: {terms, matched: n, requested: k}`; peringatan `focus_few_matches:<n>` bila
  `literal + semantic < k`. Provenance `…+focus.v1` bila blok dikirim.

## 3. UI

- Dashboard (mode V3): field "Cari momen tentang… (opsional)" dengan input chip + contoh, dan
  "Catatan untuk AI (opsional)". Ringkas; tidak mengganggu alur yang ada.
- Halaman proyek: baris "Fokus: jomok, jomokers — 5 dari 8 klip cocok"; chip per klip:
  "Menyebut 'jomok' · 12:34" / "Terkait 'jomok' (menurut AI)" / "Di luar fokus".
- Job lama tanpa fokus tampil persis seperti sekarang.

## 4. Gerbang

- Tanpa fokus: prompt byte-identik, seleksi identik, benchmark identik.
- Dengan fokus sintetis pada episode benchmark (istilah yang benar-benar diucapkan): semua
  kemunculan literal yang layak (lolos durasi) muncul di atas klip `none`; 0 label `literal` yang
  salah; label `semantic` tercatat terpisah.
- Uji injeksi lewat `note` tidak mengubah kontrak jawaban.
- Semua suite hijau.
- **E2E wajib dengan kasus pemilik:** job YouTube `https://youtu.be/rBg0ZcwjVKQ` (Ferry Irwandi ×
  Reza Auditore, subtitle YouTube tersedia) dengan fokus `jomok` (catatan: "momen jomok yang
  lucu") → klip teratas adalah momen jomok yang layak, label literal benar (termasuk
  kemunculan "perjomokan"/"jomoknya"), ringkasan "n dari k klip cocok", dan sisa slot berlabel
  "di luar fokus". Bandingkan dengan job yang sama tanpa fokus.

## 5. Keputusan setelah review (2026-09-25, menunggu konfirmasi pemilik)

Review adversarial menemukan label `literal` yang salah dan momen lemah yang terangkat. Yang
diterapkan, dengan alasannya (hasil ukur di `docs/evaluation/SELECTION_BENCHMARK.md`, bagian
"Fokus klip"):

- **Imbuhan lebih ketat** (gerbang "0 label literal yang salah"): akhiran `-an, -kan, -i, -in`
  tanpa awalan butuh istilah minimal 5 huruf (dengan awalan, konfiks, cukup 4); `-nya, -ku,
  -mu` dan partikel boleh untuk semua istilah. Kata umum yang tetap tampak seperti turunan
  ("sekarang", "perang", "pandai", "masalah", "berubah" untuk "rubah") ada di daftar
  `FOCUS_WORD_ROOTS` dan tidak pernah dianggap turunan istilah lain.
- **Stopword khusus fokus:** hanya kata fungsi dan pengisi dari daftar Konteks Tren. Topik
  sehari-hari yang sengaja dipilih pemilik ("tiktok", "uang", "keluarga") tetap dicari. Istilah
  yang tetap tidak mungkin cocok ("AI", "5G") diberi catatan di dashboard dan dicatat
  `focus_terms_unmatchable:<n>`.
- **Urutan mode `prefer`** (prinsip 3): partisi `literal`, `semantic`, `none` berlaku di dalam
  tiap sumber. Klip AI tetap di depan; heuristik, termasuk kandidat tambahan di sekitar sebutan,
  hanya mengisi slot yang tidak diisi AI (butir "Heuristik fallback"). Momen fokus hanya
  didahulukan bila nilainya paling banyak `FOCUS_QUALITY_GAP` = 1,0 di bawah klip terlemah
  pilihan sumbernya tanpa fokus. Gerbang 2 dibaca dengan "layak" = lolos durasi dan batas
  kualitas, dan di run AI juga diusulkan model. `focus_llm_outranked` tidak lagi mungkin terjadi
  dan dihapus; provenance tetap dari AI selama ada klip AI.
- **Label dan kemasan:** sebutan harus mulai sebelum akhir klip untuk label `literal`; klaim
  `literal` yang turun ke `semantic` tidak boleh mengutip istilah di judul, teks hook, atau
  deskripsi; `focus_literal_ungrounded:<n>` menghitung klip terpilih saja.
- **Istilah kembar:** istilah yang sama setelah tokenisasi ("jomok" dan "Jomok!") dianggap satu.
