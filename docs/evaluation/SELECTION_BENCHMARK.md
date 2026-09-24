# Benchmark seleksi klip (gold label)

Benchmark ini mengukur seberapa sering sebuah *selector* (V1, V2, V3) memilih momen yang
memang layak dijadikan klip, dan seberapa sering ia terjebak memilih momen yang kelihatannya
menarik tapi sebenarnya buruk. Setiap perubahan pada logika seleksi harus dijalankan lewat
benchmark ini sebelum dianggap lebih baik.

Kode: `src/ai_clipper/benchmark.py`. Gold label: `docs/evaluation/gold/<source_id>.gold.json`.
Hasil evaluasi pertama Selection V3 ada di bagian
[Evaluasi Selection V3 (2026-09-24)](#evaluasi-selection-v3-2026-09-24).

## Apa yang diukur

Setiap episode punya satu file gold berisi:

- **moments** (G1, G2, …): momen yang layak diklip. Urutan di file = peringkat editorial
  (G1 paling kuat).
- **traps** (T1, T2, …): momen jebakan, misalnya padat kata kunci tapi tanpa payoff,
  basa-basi penuh tanda tanya, loop halusinasi ASR, atau konten yang berisiko brand safety.

Selector dipanggil **sekali** dengan `k = K terbesar`. Urutan hasilnya dianggap urutan
peringkat, lalu K teratas dinilai:

| Metrik | Arti |
|---|---|
| **hit** | Seleksi mengenai sebuah span jika **IoU ≥ 0,3** *atau* seleksi menutupi **≥ 50%** span gold. |
| **hits** | Jumlah momen gold yang berbeda yang terkena. Satu momen gold dihitung sekali, berapa pun jumlah seleksi yang mengenainya. |
| **R@K** (recall) | hits ÷ jumlah momen gold. |
| **P@K** (precision) | Jumlah seleksi yang mengenai gold mana pun ÷ jumlah seleksi yang dinilai. |
| **duplicate_hits** | Seleksi yang hanya mengenai gold yang sudah terkena di peringkat lebih atas (klip ganda). |
| **trap** | Jumlah seleksi yang mengenai trap (aturan hit yang sama), beserta ID trap-nya. `trap_rate` = trap ÷ seleksi. |
| **mIoU** | Rata-rata IoU terbaik untuk setiap momen gold (0 bila tidak tersentuh). |
| **off_med** | Median selisih mulai (`mulai seleksi − mulai gold`) untuk seleksi yang hit. Positif = klip mulai terlambat dan kemungkinan kehilangan setup/pertanyaan host. |
| **dur min/med/max** | Distribusi durasi seleksi. Penting karena klip panjang lebih mudah memenuhi aturan cakupan 50%. |
| **gold#rank** | Momen gold yang terkena dan peringkat seleksi pertama yang mengenainya. |
| **cold_open_share** | Khusus V3: bagian klip di K teratas yang punya *cold open* (kalimat hook diputar lebih dulu). Kosong untuk selector yang tidak melaporkannya. |

Laporan JSON hanya berisi rentang waktu, ID, dan angka; teks transkrip tidak pernah ditulis.
Untuk V3, setiap run juga mencatat `selector_info`: sumber (`llm`/`heuristic`), status
(`completed`/`fallback`), provider, model, versi prompt, kode peringatan, dan pemakaian token.

## Cara menjalankan

Satu selector pada satu episode (laporan rinci per seleksi):

```bash
.venv/bin/python -m ai_clipper.benchmark \
  --gold docs/evaluation/gold/Ive926sC6mc.gold.json \
  --transcript artifacts/eval/Ive926sC6mc/yt/transcript.json \
  --sound-events artifacts/eval/Ive926sC6mc/yt/analysis/sound-events.json \
  --audio-timeline artifacts/eval/Ive926sC6mc/audio-timeline.json \
  --selector v3-heuristic --min-duration 20 --max-duration 90 \
  --k 5 --k 10 --json /tmp/bench-v3.json
```

Membandingkan beberapa selector dan beberapa episode sekaligus (`--compare` wajib bila ada
lebih dari satu `--selector` atau lebih dari satu pasangan gold/transkrip):

```bash
set -a; . ./.env; set +a   # hanya untuk v3-llm; nilai key tidak dicetak
.venv/bin/python -m ai_clipper.benchmark --compare \
  --gold docs/evaluation/gold/Ive926sC6mc.gold.json \
  --transcript artifacts/eval/Ive926sC6mc/yt/transcript.json \
  --sound-events artifacts/eval/Ive926sC6mc/yt/analysis/sound-events.json \
  --audio-timeline artifacts/eval/Ive926sC6mc/audio-timeline.json \
  --gold docs/evaluation/gold/0dzvz9JZFIM.gold.json \
  --transcript artifacts/eval/0dzvz9JZFIM/yt/transcript.json \
  --sound-events artifacts/eval/0dzvz9JZFIM/yt/analysis/sound-events.json \
  --audio-timeline artifacts/eval/0dzvz9JZFIM/audio-timeline.json \
  --selector v1 --selector v3-heuristic --selector v3-llm \
  --min-duration 20 --max-duration 90 --json /tmp/bench-compare.json
```

- `--gold` dan `--transcript` dipasangkan sesuai urutan. Opsi per episode berikut harus
  diberikan **nol kali atau satu kali per episode**, dengan urutan yang sama:
  - `--audio-timeline`: dibaca dengan `ai_clipper.audio_timeline.read_audio_timeline` lalu
    diteruskan ke selector. Buat dengan
    `python -m ai_clipper.audio_timeline <video> --output <json> --no-scene-cuts`.
  - `--sound-events`: tag suara (tertawa, tepuk tangan, …). Format artefak
    `analysis/sound-events.json` (`sound-events-v1`) maupun format converter lama
    (`{"source", "events": [{"time", "label"}]}`, misalnya `sound-events.yt.json`) diterima.
    Tag gabungan seperti `tertawa][terkesiap` dipecah; label yang tidak terbaca dilewati.
  - `--llm-cache-dir`: cache jawaban LLM untuk `v3-llm`. Default:
    `artifacts/eval/<source_id>/llm-cache` (relatif terhadap folder kerja). Run ulang dengan
    prompt yang sama tidak memakai request baru.
- Selector yang menerima argumen `context` mendapat sound events dan folder cache itu
  (`SelectorContext`). Selector lama tanpa argumen itu tetap dipanggil seperti biasa.
- `--k` boleh diulang; default K=5 dan K=10.
- `--min-duration`/`--max-duration` dipakai V1 dan V3. Profil V2 punya batas sendiri
  (standard 30–90, viral 15–45, deep 60–300 detik); kolom `durasi` di tabel menunjukkan batas
  yang benar-benar dipakai.
- Dengan lebih dari satu episode, tabel juga menampilkan baris gabungan (micro-average):
  total hits ÷ total gold, dan seterusnya.
- Kode keluar: `0` semua selesai, `1` ada selector yang gagal (run lain tetap dijalankan dan
  errornya tercatat di JSON), `2` input tidak valid (gold rusak, pasangan tidak cocok, selector
  tidak dikenal, K atau durasi tidak valid).
- Pesan error selector dibersihkan: nilai environment variable yang namanya mengandung
  `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, atau `CREDENTIAL` diganti `[redacted]`.
- Transkrip dibaca dengan `ai_clipper.transcript_io` bila modul itu tersedia; jika tidak,
  dipakai pembaca lokal yang toleran (segmen dengan atau tanpa `words`). Pembaca yang dipakai
  tercatat di JSON (`episodes[].transcript_reader`).

### Selector yang tersedia

| Nama | Isi |
|---|---|
| `v1` | `highlight.select_highlights`. Fungsi aslinya mengembalikan urutan kronologis; benchmark memulihkan urutan peringkat berdasarkan skor (sama dengan urutan pilihan greedy-nya). |
| `v2-standard`, `v2-viral`, `v2-deep` | Kandidat → fitur → ranking V2, **hanya teks** (tanpa re-rank media), maksimal 200 kandidat seperti pipeline. |
| `v3-heuristic` | `selection_v3.select_clips_v3(..., llm_mode="off")`: heuristik deterministik (`hook_heuristics`) plus boundary snapping, cold open, dan ranking akhir. Tanpa jaringan. |
| `v3-llm` | `select_clips_v3(..., llm_mode="required")` dengan klien dari `.env` (`create_llm_client_from_env`) yang dibungkus cache. Gagal (exit 1) bila LLM tidak dikonfigurasi, error, atau tidak memberi satu pun momen valid. Anggaran konteks = konteks terkecil di rantai failover; token output = milik provider pertama. |

Menambah selector baru dari kode:

```python
from ai_clipper.benchmark import register_selector

def my_selector(segments, *, k, min_duration, max_duration, audio_timeline=None, context=None):
    return [(start, end), ...]  # urut dari peringkat terbaik

register_selector("my-selector", my_selector)
```

Modul opsional `ai_clipper.selection_v3` menyediakan
`benchmark_selectors() -> Mapping[str, selector]` (nilai boleh berupa fungsi atau
`SelectorSpec`). Selector boleh mengembalikan pasangan `(start, end)`, objek yang punya atribut
`start` dan `end` (misalnya `SelectedClip`), atau `SelectionResult` utuh (klipnya dinilai,
provenance-nya dicatat). Nama bawaan tidak bisa ditimpa oleh plugin.

## Menambah gold untuk episode baru

1. Transkripsikan episode seperti biasa. **Jangan commit transkrip mentah atau media.**
2. Tonton atau baca episode dan pilih 8–15 momen terbaik plus 4–8 trap. Trap yang bagus adalah
   span yang *akan* dipilih oleh scorer naif: padat kata kunci, banyak tanda tanya, topik
   kontroversial tanpa konteks, atau bagian dengan ASR rusak.
3. Tulis `docs/evaluation/gold/<source_id>.gold.json` dengan skema berikut. Semua field wajib,
   field lain ditolak:

```json
{
  "schema_version": 1,
  "source_id": "<video id>",
  "title": "<judul deskriptif>",
  "duration_seconds": 3922.15,
  "labeler": "<siapa dan kapan, mis. owner 2026-10-01>",
  "caveats": ["<batasan label ini>"],
  "moments": [
    {"id": "G1", "start": 1241.9, "end": 1310.9, "archetype": "story_twist",
     "label": "<≤ 80 karakter, kata-kata sendiri>"}
  ],
  "traps": [
    {"id": "T1", "start": 3278.75, "end": 3304.75, "label": "<kenapa ini jebakan>"}
  ]
}
```

   Aturan yang dicek oleh loader: `schema_version` = 1; `source_id` hanya huruf, angka,
   `.`, `_`, `-`; minimal satu moment; ID unik di antara moments dan traps; `0 ≤ start < end
   ≤ duration_seconds`; label tidak kosong dan maksimal 80 karakter; tidak ada span yang sama
   persis; tidak ada kunci JSON ganda maupun `NaN`/`Infinity`.
4. `archetype` memakai kode yang sama dengan `selection_types.ARCHETYPES`: `curiosity_gap`,
   `controversial_claim`, `confession`, `insider_secret`, `story_twist`, `number_proof`,
   `conflict`, `humor`, `relatable_pain`, `emotional`, `practical_tip`, `other`. Keempat file
   gold sudah memakai kode ini. Di dua file tuning, label lama dipetakan tanpa mengubah span
   atau label momen: `story-with-twist` → `story_twist`, `insider-secret` → `insider_secret`,
   `curiosity-gap` → `curiosity_gap`, `humor-banter` → `humor`,
   `controversial-confession` → `confession`, `relatable-pain` → `relatable_pain`.
   Benchmark tidak membandingkan archetype.
5. Label ditulis dengan kata-kata sendiri. Kutipan transkrip maksimal sekitar 8 kata.
6. Pakai batas alami momen: biasanya mulai dari pertanyaan host dan berakhir pada payoff atau
   rekap host. Jangan pakai batas klip yang sudah dipotong oleh selector mana pun.
7. Jalankan benchmark untuk memastikan file terbaca (`--selector v1` sudah cukup).
8. Episode held-out **tidak boleh** dipakai untuk menyetel heuristik atau prompt. Jalankan hanya
   untuk verifikasi akhir.

## Batasan (caveats)

- **Label proxy.** Keempat file gold dibuat oleh LLM yang berperan sebagai editor
  (`llm-editor-proxy`), bukan oleh editor manusia. Label dari pemilik dan data retensi nyata
  (views, watch time, share) selalu lebih diutamakan.
- **Sedikit episode.**
  - Set **tuning**: `Ive926sC6mc` dan `0dzvz9JZFIM`. Heuristik dan prompt boleh disetel di
    sini.
  - Set **held-out**: `DwTmRFyQ53E` dan `rBg0ZcwjVKQ`. Jangan dipakai untuk tuning; jalankan
    hanya untuk verifikasi akhir.
  - Tiap episode punya 12 momen dan 6 trap, jadi selisih satu hit = 0,083 recall per episode
    dan 0,021 pada gabungan 48 gold. Selisih 2–3 hit pada gabungan masih dalam batas noise.
- **Batas kasar.** Timestamp segmen ASR terkuantisasi sekitar 1–2 detik. Aturan hit
  (IoU ≥ 0,3 atau cakupan ≥ 50%) sengaja longgar untuk menampung itu. Akibatnya, hit tidak
  menjamin batas klip yang bagus; lihat `off_med` dan daftar seleksi.
- **Klip panjang diuntungkan.** Seleksi 60 detik lebih mudah menutupi 50% span gold daripada
  seleksi 18 detik. Selalu baca kolom durasi bersama recall, dan bandingkan dengan pembanding
  acak dengan durasi yang sama (di bawah).
- **Hanya teks.** Momen yang hanya terlihat secara visual (misalnya demo copet dua jari
  13:22–14:04) tidak dimasukkan sebagai gold.
- **Bukan prediksi viral.** Benchmark ini mengukur kecocokan dengan pilihan editor, bukan
  peluang sebuah klip menjadi viral.

## Hasil final V3 setelah poles (2026-09-24, kode dibekukan)

Dijalankan **sekali** setelah semua poles (LLM `llm-select-v2`, heuristik hasil setel ulang).
Tidak ada yang disetel sesudahnya.

**Setup.**
- Transkrip dari subtitle YouTube (`yt/transcript.json`), penanda suara, dan timeline audio.
- V1 dan V2 memakai batas 20–60 detik (V2 memakai profilnya sendiri); V3 memakai 20–90 detik.
- Rantai LLM produksi (custom → ollama-cloud → openrouter). Semua 10 jawaban dilayani **Hermes
  `LJNAI-FAST`** milik pemilik dengan `reasoning_effort=none`: 2 permintaan per episode (propose
  ±40–67 detik, rerank ±5 detik), tanpa fallback.
- Cache: `artifacts/eval/<id>/llm-cache-final/`.
- Perintah: `scratchpad/final/run_final.sh` (argumen sama dengan contoh `--compare` di atas).

**Ujian 2: episode segar yang belum pernah dilihat** (`FxQDATkYHtk` VINDES, `0K37SYfox7M`
Habib Ja'far, `WRxJGz-TA44` Suara Berkelas; 36 gold):

| Selector | Hits@5 | P@5 | Trap@5 | Hits@10 | P@10 | Trap@10 | mIoU@10 |
|---|---|---|---|---|---|---|---|
| v1 (20–60) | 5 | 0,33 | 0 | 9 | 0,30 | 3 | 0,14 |
| v2-standard | 4 | 0,27 | 3 | 9 | 0,30 | 3 | 0,13 |
| v2-viral | 1 | 0,07 | 1 | 1 | 0,03 | 3 | 0,04 |
| v3-heuristic (20–90) | 7 | 0,40 | 2 | 7 | 0,20 | 4 | 0,12 |
| **v3-llm (20–90)** | **8** | **0,53** | **1** | **11** | **0,37** | **1** | **0,25** |

**Ujian 1: dilihat untuk kedua kalinya, sekunder** (`DwTmRFyQ53E`, `rBg0ZcwjVKQ`; 24 gold):

| Selector | Hits@5 | P@5 | Trap@5 | Hits@10 | P@10 | Trap@10 | mIoU@10 |
|---|---|---|---|---|---|---|---|
| v1 (20–60) | 2 | 0,20 | 1 | 8 | 0,40 | 2 | 0,20 |
| v3-heuristic (20–90) | 5 | 0,50 | 1 | 6 | 0,30 | 1 | 0,14 |
| **v3-llm (20–90)** | 4 | 0,40 | 0 | **9** | **0,45** | **0** | **0,27** |

**Adu model dengan kode yang sama** (`gemma4:31b` via Ollama Cloud, cache
`llm-cache-final-gemma`, 1 permintaan per episode, 11–14 detik):

| Model | Hits@5 (60 gold) | P@5 | Hits@10 | Trap@10 | mIoU@10 |
|---|---|---|---|---|---|
| v1 | 7 | 0,28 | 17 | 5 | ~0,15 |
| v3-llm, Hermes `LJNAI-FAST` | 12 | 0,48 | 20 | 1 | ~0,26 |
| **v3-llm, `gemma4:31b`** | **17** | **0,68** | **27** | 3 | **~0,31** |

Gemma per set: ujian 2 top-5 11/36 (P@5 0,73, 0 jebakan) dan top-10 16/36; ujian 1 top-5 6/24
dan top-10 11/24. Keputusan: rantai default menjadi **ollama-cloud (Gemma) → custom (Hermes) →
openrouter**. Paket Free Ollama hanya memberi kredit awal; saat kredit habis, Hermes mengambil
alih.

**Kesimpulan** (gabungan 5 episode, 60 gold):

| | Top-5 | Top-10 | Jebakan @10 |
|---|---|---|---|
| **V3-LLM** | **12** | **20** | **1** |
| V1 | 7 | 17 | 5 |

- Presisi @5 V3-LLM 0,48, dibanding V1 0,28.
- Kecocokan batas klip (mIoU) V3-LLM kira-kira dua kali V1.
- Keunggulan terbesar V3-LLM ada di klip teratas yang benar-benar diposting, dan jebakannya jauh
  lebih sedikit. Di top-10 keunggulannya masih moderat.
- Heuristik bagus di episode edukatif dan interview, tetapi **0 hit di episode banter VINDES**.
  Momen komedi masih butuh LLM.
- Gold masih label proksi dari LLM. Label pemilik sendiri dan data retensi nyata tetap menjadi
  hakim akhir.

## Evaluasi Selection V3 (2026-09-24)

Evaluasi pertama V3: 4 episode × 2 sumber transkrip × 7 selector, K=5 dan K=10. Set **tuning**
dan **held-out** dilaporkan terpisah. Angka held-out di bawah adalah **satu-satunya** kali
held-out dilihat pada fase ini. Angkanya dilaporkan apa adanya, dan tidak ada yang disetel
sesudahnya.

### Setup

- **Transkrip.**
  - *YouTube*: `artifacts/eval/<id>/yt/transcript.json` dari parser `youtube_captions`
    (tanda baca rapi, waktu per kata), plus `yt/analysis/sound-events.json` (tertawa, tepuk
    tangan, dan lain-lain).
  - *Whisper*: `artifacts/eval/<id>/transcript.json` (faster-whisper small dengan word
    timestamps), tanpa sound events. Tanda bacanya rusak di `0dzvz9JZFIM` dan di 25 menit
    pertama `rBg0ZcwjVKQ`.
- **Audio timeline** (jeda/silence) diberikan ke semua run V3:
  `artifacts/eval/<id>/audio-timeline.json`, dibuat dengan `--no-scene-cuts`.
- **Selector dan batas durasi.**
  - `v1` memakai 20–60 detik. `v2-standard` dan `v2-viral` memakai profilnya sendiri
    (30–90 dan 15–45).
  - `v3-heuristic` dijalankan pada 20–60 dan 20–90. `v3-llm` hanya pada 20–90.
  - Semua selector dipanggil sekali dengan k=10, jadi top-5 adalah awal dari top-10.
  - Baris **"v3-llm mode auto"** memutar ulang jawaban LLM yang sama dari cache dalam mode
    `auto`, yaitu perilaku produksi: kalau LLM gagal atau kosong, heuristik dipakai
    (`status=fallback`). `v3-llm` sendiri memakai mode `required`, sehingga jawaban kosong
    dihitung gagal.
- **LLM.**
  - Rantai failover dari `.env` (khusus model gratis): ollama-cloud (`gpt-oss:120b`, lalu
    `qwen3.5:397b`, `gemma4:31b`), kemudian openrouter (model `:free`).
  - Semua jawaban datang dari **ollama-cloud / `gpt-oss:120b`**. Failover tidak pernah terjadi.
  - Setiap run hanya butuh **satu request propose** (input 21–27 ribu token, output 2,5–9,4
    ribu token termasuk reasoning, 11–33 detik).
  - Rerank tidak pernah berjalan. Rerank hanya dipanggil kalau momen valid lebih dari k=10,
    padahal gpt-oss hanya memberi 0–8 momen valid meskipun diminta sekitar 20.
  - **Total request live baru untuk seluruh evaluasi: 8** (4 tuning + 4 held-out), dengan
    anggaran maksimal 20. Replay mode auto, pemeriksaan CLI, dan render QA memakai cache
    (0 request).
  - Cache ada di `artifacts/eval/<id>/llm-cache/`.

### TUNING (`Ive926sC6mc`, `0dzvz9JZFIM`)

Gabungan 2 episode per sumber transkrip (24 gold dan 12 trap per sumber, 48 gold untuk
gabungan). Dasar trap = jumlah klip yang dinilai. *Cold open* = bagian klip di top-10 yang
punya cold open. Pada tuning, "v3-llm mode auto" identik dengan `v3-llm` (tidak ada fallback),
jadi barisnya tidak diulang.

| Selector | Transkrip | Hits@5 | R@5 | P@5 | Trap@5 | Hits@10 | R@10 | P@10 | Trap@10 | mIoU@10 | Durasi med (s) | Cold open |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| v1 (20–60) | YouTube | 2/24 | 0,083 | 0,20 | 1/10 | 4/24 | 0,167 | 0,20 | 2/20 | 0,095 | 59 | – |
| v2-standard (30–90) | YouTube | 2/24 | 0,083 | 0,20 | 0/10 | 5/24 | 0,208 | 0,25 | 1/20 | 0,119 | 37 | – |
| v2-viral (15–45) | YouTube | 3/24 | 0,125 | 0,30 | 0/10 | 4/24 | 0,167 | 0,20 | 1/20 | 0,076 | 18 | – |
| v3-heuristic (20–60) | YouTube | 4/24 | 0,167 | 0,40 | 1/10 | 8/24 | 0,333 | 0,40 | 1/20 | 0,234 | 51 | 60% |
| v3-heuristic (20–90) | YouTube | 5/24 | 0,208 | 0,50 | 1/10 | 9/24 | 0,375 | 0,45 | 2/20 | 0,265 | 70 | 80% |
| v3-llm (20–90) | YouTube | 2/24 | 0,083 | 0,20 | 0/10 | 7/24 | 0,292 | 0,35 | 1/20 | 0,183 | 48 | 80% |
| v1 (20–60) | Whisper | 2/24 | 0,083 | 0,30 | 1/10 | 4/24 | 0,167 | 0,25 | 3/20 | 0,088 | 59 | – |
| v2-standard (30–90) | Whisper | 2/24 | 0,083 | 0,20 | 1/10 | 2/24 | 0,083 | 0,10 | 2/20 | 0,070 | 32 | – |
| v2-viral (15–45) | Whisper | 3/24 | 0,125 | 0,30 | 0/10 | 4/24 | 0,167 | 0,20 | 1/20 | 0,086 | 18 | – |
| v3-heuristic (20–60) | Whisper | 3/24 | 0,125 | 0,30 | 0/10 | 6/24 | 0,250 | 0,30 | 0/20 | 0,169 | 38 | 35% |
| v3-heuristic (20–90) | Whisper | 5/24 | 0,208 | 0,50 | 1/10 | 7/24 | 0,292 | 0,35 | 2/20 | 0,190 | 60 | 35% |
| v3-llm (20–90) | Whisper | 1/24 | 0,042 | 0,10 | 0/10 | 5/24 | 0,208 | 0,25 | 1/20 | 0,121 | 35 | 65% |
| v1 (20–60) | **gabungan** | 4/48 | 0,083 | 0,25 | 2/20 | 8/48 | 0,167 | 0,23 | 5/40 | 0,092 | 59 | – |
| v2-standard (30–90) | **gabungan** | 4/48 | 0,083 | 0,20 | 1/20 | 7/48 | 0,146 | 0,17 | 3/40 | 0,094 | 33 | – |
| v2-viral (15–45) | **gabungan** | 6/48 | 0,125 | 0,30 | 0/20 | 8/48 | 0,167 | 0,20 | 2/40 | 0,081 | 18 | – |
| v3-heuristic (20–60) | **gabungan** | 7/48 | 0,146 | 0,35 | 1/20 | 14/48 | 0,292 | 0,35 | 1/40 | 0,202 | 48 | 48% |
| v3-heuristic (20–90) | **gabungan** | 10/48 | 0,208 | 0,50 | 2/20 | 16/48 | 0,333 | 0,40 | 4/40 | 0,228 | 69 | 57% |
| v3-llm (20–90) | **gabungan** | 3/48 | 0,062 | 0,15 | 0/20 | 12/48 | 0,250 | 0,30 | 2/40 | 0,152 | 41 | 72% |

Per episode (hits@5/hits@10, trap@5/trap@10):

| Selector | Ive926sC6mc YT | Ive926sC6mc Whisper | 0dzvz9JZFIM YT | 0dzvz9JZFIM Whisper |
|---|---|---|---|---|
| v1 (20–60) | 2/4, 1/2 | 2/4, 1/3 | 0/0, 0/0 | 0/0, 0/0 |
| v2-standard (30–90) | 1/3, 0/0 | 1/1, 0/0 | 1/2, 0/1 | 1/1, 1/2 |
| v2-viral (15–45) | 2/2, 0/1 | 2/3, 0/0 | 1/2, 0/0 | 1/1, 0/1 |
| v3-heuristic (20–60) | 2/4, 1/1 | 1/4, 0/0 | 2/4, 0/0 | 2/2, 0/0 |
| v3-heuristic (20–90) | 3/5, 1/2 | 3/5, 1/2 | 2/4, 0/0 | 2/2, 0/0 |
| v3-llm (20–90) | 2/5, 0/1 | 1/3, 0/1 | 0/2, 0/0 | 0/2, 0/0 |

Catatan tuning:

- **`v3-heuristic` paling kuat di tuning.** Pada 20–90 hasilnya 10/48 di K=5 dan 16/48 di
  K=10. Pembanding acak dengan durasi 75 detik hanya sekitar 4,8 dan 9,5. `v3-heuristic`
  20–60 juga mengalahkan v1 20–60 (7 vs 4 di K=5, 14 vs 8 di K=10) dengan trap lebih sedikit
  (1/40 vs 5/40 di K=10).
- **`v3-llm` lebih lemah dari heuristik di K=5 (3/48).**
  - gpt-oss hanya memberi 4–7 momen valid per episode. Sisa slot top-10 diisi heuristik
    (`llm_filled:3`–`6`).
  - Beberapa pilihannya adalah momen gold yang benar tapi klipnya terlalu pendek sehingga
    meleset dari aturan hit. Contoh di `0dzvz9JZFIM`: G5 dengan IoU 0,29 dan G7 dengan IoU
    0,13. Median durasi klip `v3-llm` 41 detik, sedangkan median span gold `0dzvz9JZFIM`
    sekitar 70 detik.
  - Run tunggal juga bervariasi. Agen llm-selection sebelumnya mendapat 2/12 di K=5 untuk
    `0dzvz9JZFIM` dengan prompt k=5, sedangkan run ini 0/12.
- **Cold open** muncul pada 35–80% klip V3. Pada Whisper lebih jarang karena unit yang tidak
  bertanda baca jarang pas 1–8 detik.
- **Sensitivitas terhadap versi transkrip YouTube.** Dengan converter lama
  (`transcript.yt.json`), heuristik mendapat 6/12 di K=10 untuk `0dzvz9JZFIM`. Dengan parser
  baru (`yt/transcript.json`, segmen dipecah di setiap pergantian pembicara) hasilnya 4/12.
  Heuristik disetel dengan converter lama. Orkestrator V3 tidak mengubah hasil ini: span
  heuristik mentah dan hasil akhir V3 memberi hits yang identik.

### HELD-OUT (`DwTmRFyQ53E`, `rBg0ZcwjVKQ`)

Format sama dengan tabel tuning. † = satu run `v3-llm` gagal (lihat catatan). Run itu dihitung
0 hit dengan 12 gold, dan klipnya tidak masuk dasar P@K atau trap.

| Selector | Transkrip | Hits@5 | R@5 | P@5 | Trap@5 | Hits@10 | R@10 | P@10 | Trap@10 | mIoU@10 | Durasi med (s) | Cold open |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| v1 (20–60) | YouTube | 2/24 | 0,083 | 0,20 | 1/10 | 8/24 | 0,333 | 0,40 | 2/20 | 0,198 | 59 | – |
| v2-standard (30–90) | YouTube | 1/24 | 0,042 | 0,10 | 0/10 | 2/24 | 0,083 | 0,10 | 2/20 | 0,029 | 35 | – |
| v2-viral (15–45) | YouTube | 1/24 | 0,042 | 0,10 | 1/10 | 2/24 | 0,083 | 0,10 | 1/20 | 0,074 | 20 | – |
| v3-heuristic (20–60) | YouTube | 2/24 | 0,083 | 0,20 | 0/10 | 5/24 | 0,208 | 0,25 | 1/20 | 0,103 | 53 | 35% |
| v3-heuristic (20–90) | YouTube | 3/24 | 0,125 | 0,30 | 0/10 | 6/24 | 0,250 | 0,30 | 2/20 | 0,128 | 83 | 50% |
| v3-llm (20–90) † | YouTube | 3/24 | 0,125 | 0,60 | 0/5 | 4/24 | 0,167 | 0,40 | 0/10 | 0,109 | 64 | 40% |
| v3-llm mode auto (20–90) | YouTube | 5/24 | 0,208 | 0,50 | 0/10 | 8/24 | 0,333 | 0,40 | 1/20 | 0,200 | 73 | 35% |
| v1 (20–60) | Whisper | 1/24 | 0,042 | 0,10 | 1/10 | 5/24 | 0,208 | 0,25 | 2/20 | 0,134 | 59 | – |
| v2-standard (30–90) | Whisper | 2/24 | 0,083 | 0,20 | 0/10 | 2/24 | 0,083 | 0,10 | 0/20 | 0,039 | 33 | – |
| v2-viral (15–45) | Whisper | 1/24 | 0,042 | 0,10 | 1/10 | 2/24 | 0,083 | 0,10 | 2/20 | 0,046 | 19 | – |
| v3-heuristic (20–60) | Whisper | 4/24 | 0,167 | 0,40 | 1/10 | 7/24 | 0,292 | 0,35 | 2/20 | 0,159 | 51 | 45% |
| v3-heuristic (20–90) | Whisper | 4/24 | 0,167 | 0,40 | 1/10 | 5/24 | 0,208 | 0,25 | 2/20 | 0,099 | 58 | 55% |
| v3-llm (20–90) | Whisper | 4/24 | 0,167 | 0,40 | 0/10 | 5/24 | 0,208 | 0,25 | 1/20 | 0,108 | 44 | 75% |
| v3-llm mode auto (20–90) | Whisper | 4/24 | 0,167 | 0,40 | 0/10 | 5/24 | 0,208 | 0,25 | 1/20 | 0,108 | 44 | 75% |
| v1 (20–60) | **gabungan** | 3/48 | 0,062 | 0,15 | 2/20 | 13/48 | 0,271 | 0,33 | 4/40 | 0,166 | 59 | – |
| v2-standard (30–90) | **gabungan** | 3/48 | 0,062 | 0,15 | 0/20 | 4/48 | 0,083 | 0,10 | 2/40 | 0,034 | 34 | – |
| v2-viral (15–45) | **gabungan** | 2/48 | 0,042 | 0,10 | 2/20 | 4/48 | 0,083 | 0,10 | 3/40 | 0,060 | 19 | – |
| v3-heuristic (20–60) | **gabungan** | 6/48 | 0,125 | 0,30 | 1/20 | 12/48 | 0,250 | 0,30 | 3/40 | 0,131 | 52 | 40% |
| v3-heuristic (20–90) | **gabungan** | 7/48 | 0,146 | 0,35 | 1/20 | 11/48 | 0,229 | 0,28 | 4/40 | 0,114 | 76 | 52% |
| v3-llm (20–90) † | **gabungan** | 7/48 | 0,146 | 0,47 | 0/15 | 9/48 | 0,188 | 0,30 | 1/30 | 0,108 | 54 | 63% |
| v3-llm mode auto (20–90) | **gabungan** | 9/48 | 0,188 | 0,45 | 0/20 | 13/48 | 0,271 | 0,33 | 2/40 | 0,154 | 57 | 55% |

Per episode (hits@5/hits@10, trap@5/trap@10):

| Selector | DwTmRFyQ53E YT | DwTmRFyQ53E Whisper | rBg0ZcwjVKQ YT | rBg0ZcwjVKQ Whisper |
|---|---|---|---|---|
| v1 (20–60) | 1/4, 0/1 | 1/4, 0/1 | 1/4, 1/1 | 0/1, 1/1 |
| v2-standard (30–90) | 0/1, 0/0 | 1/1, 0/0 | 1/1, 0/2 | 1/1, 0/0 |
| v2-viral (15–45) | 0/1, 0/0 | 1/1, 0/1 | 1/1, 1/1 | 0/1, 1/1 |
| v3-heuristic (20–60) | 1/3, 0/1 | 3/5, 1/1 | 1/2, 0/0 | 1/2, 0/1 |
| v3-heuristic (20–90) | 2/4, 0/1 | 3/4, 1/1 | 1/2, 0/1 | 1/1, 0/1 |
| v3-llm (20–90) | gagal | 2/3, 0/1 | 3/4, 0/0 | 2/2, 0/0 |
| v3-llm mode auto (20–90) | 2/4, 0/1 | 2/3, 0/1 | 3/4, 0/0 | 2/2, 0/0 |

Catatan held-out:

- **Run gagal.** Untuk `DwTmRFyQ53E` dengan transkrip YouTube, gpt-oss menjawab
  `{"moments": []}` (2.512 token output, hampir semuanya reasoning).
  - Dalam mode `required` itu dihitung gagal (`LLMError no_moments`).
  - Dalam mode `auto`, yang dipakai produksi, V3 jatuh ke heuristik dengan
    `status=fallback` dan peringatan `llm_failed:no_moments`.
  - Request tidak diulang, karena mengulang berarti memilih hasil yang disukai dari
    held-out.
- **K=5.** V3 (mode auto) mendapat 9/48 dengan P@5 0,45 dan tanpa trap. `v3-heuristic`
  mendapat 6–7/48, sedangkan v1 hanya 3/48 dan V2 2–3/48. Pembanding acak dengan durasi 60
  detik sekitar 4,5/48.
- **K=10.** v1 (13/48), V3 mode auto (13/48), dan `v3-heuristic` (11–12/48) berada dalam
  batas noise. Pembanding acak 60 detik sekitar 9,1/48 dan 75 detik sekitar 10,5/48. Artinya,
  di K=10 semua selector hanya sedikit di atas acak.
- **Trap.** V3 lebih sedikit terjebak daripada v1: mode auto 0/20 di K=5 dan 2/40 di K=10,
  sedangkan v1 2/20 dan 4/40.
- **Kriteria sukses rencana** (V3-heuristic ≥ V1 untuk Recall@5 dan trap rate di setiap
  episode; pada 20–60):
  - *Recall@5*: terpenuhi di keempat kombinasi episode × transkrip. Dua kombinasi seri 1 vs 1,
    dua lainnya lebih baik (3 vs 1 dan 1 vs 0).
  - *Trap rate*: terpenuhi di 3 dari 4 kombinasi. Di `DwTmRFyQ53E` Whisper, V3 kena 1 trap di
    top-5 sementara v1 kena 0.
  - *"V3-LLM jelas di atasnya"*: **belum terpenuhi**. Di held-out, LLM unggul di K=5 (+2
    sampai +3 hit, masih dalam batas noise). Di tuning, LLM kalah (−7 hit di K=5). Di K=10,
    hasilnya seri.

### Pembanding acak (jendela tanpa tumpang tindih, 2.000 percobaan per episode)

Hits yang diharapkan per 2 episode (24 gold). Untuk baris gabungan kedua sumber transkrip,
kalikan 2.

| Set | Durasi jendela | Hits@5 | Hits@10 | Trap@5 (dari 10) |
|---|---|---|---|---|
| Tuning | 30 s | 1,41 | 2,79 | 0,58 |
| Tuning | 45 s | 1,74 | 3,53 | 0,72 |
| Tuning | 60 s | 2,06 | 4,14 | 0,89 |
| Tuning | 75 s | 2,38 | 4,73 | 1,04 |
| Held-out | 30 s | 1,59 | 3,10 | 0,68 |
| Held-out | 45 s | 1,96 | 3,91 | 0,84 |
| Held-out | 60 s | 2,25 | 4,54 | 1,01 |
| Held-out | 75 s | 2,66 | 5,24 | 1,18 |

### Kesimpulan

1. **V3 lebih baik dari V1/V2 di top-5 dan lebih jarang terjebak trap,** baik di tuning maupun
   held-out. Untuk top-10, keunggulan di held-out hilang: semua selector dekat dengan
   pembanding acak.
2. **Jalur LLM (gpt-oss:120b gratis) belum terbukti lebih baik dari heuristik.**
   - Hasilnya berbalik antara tuning dan held-out.
   - Model ini memberi sedikit momen (0–8), sekali tidak memberi apa pun, dan cenderung
     memilih klip lebih pendek dari span gold.
   - Mode `auto` penting di produksi: tanpa itu satu dari empat run held-out gagal total.
3. **Label masih proxy LLM.** Klip LLM yang tidak ada di gold belum tentu buruk; contohnya
   "Kasus 28 miliar kembali ke korban" dan "Bawa tumbler biar nggak ketangkep copet". Label
   pemilik dan data retensi tetap ukuran akhir.
4. **Langkah berikut yang disarankan** (disetel hanya di tuning, lalu dievaluasi dengan
   episode held-out baru):
   - Ulangi sekali dengan model kedua bila jawaban kosong atau kurang dari k.
   - Minta durasi mendekati span gold, dengan setup pertanyaan host ikut masuk.
   - Coba model gratis lain di ollama-cloud, misalnya `qwen3.5:397b` atau
     `deepseek-v4-pro:0813`.
   - Tambah episode held-out baru, karena dua episode ini sudah terpakai.

### Render QA (satu klip V3 nyata)

Klip peringkat 1 `v3-llm` di `Ive926sC6mc` (YouTube, dari cache) dirender end-to-end dengan
`render_vertical`:

- **Opsi render:** `fit-blur`, 720×1280, `caption_style="karaoke"`, `hook_text`, dan
  `cold_open`. Kata-kata berasal dari transkrip YouTube.
- **Klip:**
  - Rentang klip 03:23,25–04:45,77 (82,5 detik). Klip dimulai dari pertanyaan "Apa itu?".
  - Klip berakhir pada kalimat rekap "Berarti kalau orang udah ngomong kita mutus, … kita
    harus curiga", tepat sebelum pertanyaan berikutnya. Ini mengenai gold G9.
- **Cold open:** 03:37,40–03:43,36 (6,0 detik), berisi kalimat tamu "Jadi, pertama itu kalau
  … di keramaian ada ngomong mutusmutus itu artinya ada pencopet".
- **Hook di layar:** "Dengar kata 'mutus'? Itu artinya copet!".
- **Durasi render:** 88,48 detik (6,0 + 82,5), sesuai perhitungan.
- **Frame QA:** cold open dengan hook box, sesudah sambungan cold open, tengah, dan akhir.
  Hook box tampil di area aman atas, kata aktif karaoke berwarna kuning, dan layout
  fit-blur benar.

## Baseline lama: `Ive926sC6mc` (65 menit, 12 gold, 6 trap)

Dijalankan 2026-09-24 pada `artifacts/youtube/Ive926sC6mc-output/transcript.json` (2354
segmen, tanpa word timestamps). Ini baseline sebelum V3 dan transkrip YouTube. Angka V3 di
atas memakai transkrip lain, jadi tidak bisa dibandingkan baris per baris.

| Selector | Durasi (s) | K | Hits | R@K | P@K | Trap | mIoU | Durasi med (s) | Gold#rank |
|---|---|---|---|---|---|---|---|---|---|
| v1 | 20–60 | 5 | 2/12 | 0,167 | 0,40 | 1/5 (T3) | 0,123 | 60,0 | G11#2, G6#5 |
| v1 | 20–60 | 10 | 4/12 | 0,333 | 0,40 | 3/10 (T3, T6, T2) | 0,190 | 60,0 | G11#2, G6#5, G10#8, G4#10 |
| v1 | 15–45 | 5 | 1/12 | 0,083 | 0,20 | 1/5 (T3) | 0,043 | 45,0 | G11#1 |
| v1 | 15–45 | 10 | 3/12 | 0,250 | 0,40 | 2/10 (T3, T1) | 0,136 | 44,5 | G11#1, G6#6, G10#10 |
| v2-standard | 30–90 | 5 | 0/12 | 0,000 | 0,00 | 0/5 | 0,002 | 31,0 | – |
| v2-standard | 30–90 | 10 | 1/12 | 0,083 | 0,10 | 1/10 (T6) | 0,036 | 31,0 | G11#10 |
| v2-viral | 15–45 | 5 | 1/12 | 0,083 | 0,20 | 0/5 | 0,040 | 18,0 | G4#4 |
| v2-viral | 15–45 | 10 | 1/12 | 0,083 | 0,10 | 0/10 | 0,061 | 18,0 | G4#4 |
| v2-deep | 60–300 | 5 | 1/12 | 0,083 | 0,20 | 0/5 | 0,074 | 63,0 | G9#5 |
| v2-deep | 60–300 | 10 | 3/12 | 0,250 | 0,30 | 0/10 | 0,182 | 64,0 | G9#5, G11#6, G3#10 |

Catatan pembacaan:

- Angka V1 dan V2 sama persis dengan audit manual sebelumnya (`compare.md`). Misalnya V1
  20–60 mengenai G11, G6, G10, dan G4 di 10 besar dengan mIoU 0,190.
- V1 20–60 hanya sedikit di atas acak (4 vs 2,06 hit), sebagian karena setiap klipnya selalu
  60 detik penuh. Tiga dari 10 pilihannya kena trap.
- V2 standard dan viral setara atau di bawah jendela acak. `v2-deep` terlihat lebih baik di
  K=10, tetapi klipnya ≥ 60 detik sehingga lebih mudah memenuhi aturan cakupan 50%.
