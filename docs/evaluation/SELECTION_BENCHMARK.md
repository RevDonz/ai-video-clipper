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

## Konteks Tren (2026-09-25)

Mengukur engine Konteks Tren (`trend_context.py`, grounding dan dorongan ringan di
`selection_v3.py`; aturannya di `docs/operations/STANDAR_KLIP_AI.md`, bagian "Konteks Tren").
Semua run memakai K=10, durasi 20–90 detik, `yt/transcript.json`, sound events, dan timeline
audio. Skrip pengukurnya sementara (scratchpad, tidak di-commit). Tidak ada model berbayar:
pemutaran ulang memakai cache lama tanpa jaringan (klien HTTP dimatikan, cache miss = error),
dan hanya 5 permintaan baru ke rantai gratis lokal.

**Gerbang 1: tanpa tren hasilnya identik.** Hasil setiap run dibandingkan byte demi byte dengan
kode dasar `59fbb9a`, lengkap dengan sha256 setiap prompt yang dikirim:

| Run | Episode | Hasil |
|---|---|---|
| `v3-heuristic` | 7 | 7/7 identik |
| Cache Hermes `llm-cache-final` (rantai custom → ollama-cloud → openrouter), diputar ulang | 5 | 5/5 identik, 10/10 permintaan kena cache |
| Cache Gemma `llm-cache-final-gemma`, diputar ulang | 5 | 5/5 identik, 5/5 permintaan kena cache |
| Prompt usulan `Ive926sC6mc` dan `0dzvz9JZFIM` (belum ada cache untuk rantai sekarang) | 2 | sha256 identik |
| Sama seperti di atas, tetapi dengan file tren yang itemnya tidak disebut episode mana pun (termasuk item yang hanya berisi "viral"/"fyp") | 7 | 21/21 catatan identik |

Test unit juga mengunci sha256 permintaan empat skenario fixture (tunggal, permintaan ulang,
dipotong per bagian dengan permintaan ulang, peringkat ulang) pada nilai dari `59fbb9a`.

**Gerbang 2: tren sintetis yang benar-benar disebut episode.** File 1 untuk `0K37SYfox7M`
(8 item: 6 disebut, yaitu "beda server" 5×, "noted" 3×, "istidraj" 3×, "halal bihalal" 2×,
"Yura Yunita" 1×, dan "innalillah" 1× sebagai tren **sensitif**; 2 item tidak disebut). File 2
untuk `FxQDATkYHtk` (6 item: pilkada/Tangsel, Marcel, fiber optik, open mic, Pamulang, dan Papua
sebagai tren sensitif). Untuk mengukur grounding terhadap model yang mengarang, jawaban cache
diputar ulang dengan **semua** ID tren ditempelkan ke **setiap** momen.

| Episode, run | Momen sama (dari 10) | Pindah peringkat | Hits@5 | Hits@10 | Trap@10 | Tren ter-grounding | Salah | Ref karangan dibuang |
|---|---|---|---|---|---|---|---|---|
| `0K37SYfox7M` heuristik | 9 | 0 | 4 → 4 | 4 → 5 | 2 → 2 | 2 | 0 | – |
| `0K37SYfox7M` cache Hermes + ref karangan | 10 | 2 | 3 → 3 | 4 → 4 | 0 → 0 | 3 | 0 | 98 |
| `0K37SYfox7M` cache Gemma + ref karangan | 10 | 2 | 4 → 4 | 6 → 6 | 0 → 0 | 3 | 0 | 57 |
| `FxQDATkYHtk` heuristik | 9 | 6 | 0 → 0 | 0 → 1 | 1 → 0 | 2 | 0 | – |
| `FxQDATkYHtk` cache Hermes + ref karangan | 10 | 5 | 2 → 2 | 3 → 3 | 0 → 0 | 4 | 0 | 108 |
| `FxQDATkYHtk` cache Gemma + ref karangan | 9 | 3 | 3 → 3 | 4 → 4 | 1 → 1 | 3 | 0 | 52 |

"Momen sama" = IoU ≥ 0,5 dengan klip run tanpa tren; semua klip yang sama juga punya rentang
yang persis sama. Satu item file 2 juga disebut di `DwTmRFyQ53E` dan `0K37SYfox7M` (1 + 1
ter-grounding, 0 salah, 16 + 6 + 17 + 10 ref karangan dibuang); episode lain tidak menyebut item
mana pun dan hasilnya identik. Setiap tren ter-grounding diperiksa ulang dengan cara lain
(pencarian substring tanpa aksen pada batas kata, bukan pencocok token engine): **24 dari 24
benar, 0 salah**, dan **364 ref karangan dibuang** (tercatat sebagai `trend_ref_ungrounded:<n>`).
Tren sensitif ter-grounding (duka "innalillah", Papua) tidak memberi dorongan dan tidak
menyumbang hashtag.

Yang berubah hanya kemasan (`hashtags`, `reasons`, `trends`) dan urutan; judul, skor, dan
sub-skor tidak berubah. Karena dorongan bekerja sebelum K teratas diambil, kandidat ke-11 yang
nyambung tren bisa masuk ke 10 besar menggantikan klip ke-10 yang selisih nilainya < 0,3 (3 dari
6 run di atas; di `0K37SYfox7M` klip pengganti itu gold G12, di `FxQDATkYHtk` klip yang tergeser
adalah trap). Nilai heuristik rapat, jadi satu klip bisa naik beberapa peringkat: di
`FxQDATkYHtk` klip "open mic" (5,404 + 0,3) naik dari peringkat 6 ke 2 melewati empat klip
bernilai 5,41–5,68.

**Model sungguhan dengan blok tren** (`0K37SYfox7M`, file 1, 5 permintaan baru ke rantai gratis
lokal; cache di scratchpad):

| Run | `trend_refs` diisi model | Tren ter-grounding | Momen sama dengan cache tanpa tren | Hits@5 | Hits@10 | Trap@10 |
|---|---|---|---|---|---|---|
| Gemma tanpa tren, diulang (ukuran variasi model) | – | – | 9/10 | 4 | 6 | 0 |
| Gemma + blok tren sesuai spesifikasi | 0 dari 10 momen | 0 | 8/10 | 5 | 8 | 0 |
| Hermes `LJNAI-FAST` + blok tren sesuai spesifikasi | 0 dari 20 momen | 0 | 5/10 (variasi Hermes belum diukur) | 4 | 5 | 0 |
| Gemma + blok tren + satu baris format (eksperimen, tidak di-commit) | 5 dari 10 momen | 5 (0 salah) | 7/10 | 4 | 7 | 0 |

Temuan:
- Dengan blok persis sesuai spesifikasi, **kedua model tidak mengisi `trend_refs`** (standar
  sistem tidak menyebut field itu, dan blok tidak memberi contoh bentuknya). Model tetap memakai
  tren di judul ("Definisi cinta beda server versi Habib Jafar", "Kenapa Halal Bihalal itu
  tradisi yang jenius?"), tetapi klip AI tidak mendapat tren ter-grounding, hashtag tren, atau
  dorongan. Satu baris tambahan
  `Format: di setiap momen isi "trend_refs" dengan id tren yang dipakai, misalnya ["T1"]; isi [] bila tidak ada.`
  membuat Gemma mengisi 5 ref yang kelimanya benar. **Baris ini dipakai sejak integrasi**
  (blok tren sekarang diakhiri baris `Format:` itu); tanpa tren prompt tetap byte-identik.
- Blok tren ikut memengaruhi **momen yang dipilih model**, bukan hanya kemasan: dengan tren,
  Gemma memilih dua momen tren yang tidak ada di run tanpa tren (beda server dan halal bihalal;
  keduanya gold, G6 dan G12), sehingga Hits@10 naik dari 6 ke 8, dan trap tetap 0. Satu episode
  belum cukup untuk menyimpulkan efeknya secara umum.

## Fokus klip (2026-09-25)

Mengukur Fokus klip (`focus.py`, blok FOKUS PENGGUNA di `llm_selection.py`, label dan urutan di
`selection_v3.py`; aturannya di `docs/operations/STANDAR_KLIP_AI.md`, bagian "Fokus klip").
Setup sama dengan Konteks Tren: K=10, durasi 20–90 detik, `yt/transcript.json`, sound events,
timeline audio. Pemutaran ulang memakai cache Hermes lama tanpa jaringan; model sungguhan hanya
rantai gratis. Skrip pengukurnya sementara (scratchpad, tidak di-commit).

**Gerbang 1: tanpa fokus hasilnya identik** (dibandingkan dengan kode dasar `54a360a`):

| Run | Hasil |
|---|---|
| `v3-heuristic`, 7 episode | 7/7 identik byte demi byte |
| Cache Hermes diputar ulang, 5 episode | 5/5 identik, termasuk sha256 setiap permintaan |
| Hanya tren (tanpa fokus), 2 episode, heuristik dan putar ulang | identik |
| sha256 permintaan 4 skenario fixture, dengan dan tanpa tren | sama dengan `54a360a` (dikunci di test unit) |
| E2E `rBg0ZcwjVKQ`, heuristik dan permintaan usulan pertama | identik (lihat E2E di bawah) |

**Gerbang 2: fokus sintetis yang benar-benar diucapkan** (satu istilah per episode; `L/S/N` =
jumlah klip `literal`/`semantic`/`none` di 10 besar; gold = Hits@5, Hits@10, Trap@10 sebelum →
sesudah):

| Episode | Istilah | Run | Unit yang menyebut | L/S/N | Label literal salah | Momen sama dengan tanpa fokus | Hits@5 | Hits@10 | Trap@10 |
|---|---|---|---|---|---|---|---|---|---|
| `0dzvz9JZFIM` | kasus | heuristik | 12 | 7/0/3 | 0 | 4/10 | 3 → 2 | 5 → 4 | 0 → 0 |
| `0K37SYfox7M` | whatsapp, grup wa | heuristik | 10 | 4/0/6 | 0 | 7/10 | 4 → 4 | 4 → 5 | 2 → 2 |
| `0K37SYfox7M` | whatsapp, grup wa | putar ulang | 10 | 4/0/6 | 0 | 6/10 | 3 → 4 | 4 → 6 | 0 → 0 |
| `DwTmRFyQ53E` | medsos, akun anonim | heuristik | 7 | 6/0/4 | 0 | 5/10 | 4 → 3 | 4 → 7 | 1 → 1 |
| `DwTmRFyQ53E` | medsos, akun anonim | putar ulang | 7 | 6/0/4 | 0 | 7/10 | 3 → 4 | 7 → 6 | 0 → 0 |
| `FxQDATkYHtk` | politik | heuristik | 17 | 10/0/0 | 0 | 0/10 | 0 → 3 | 0 → 4 | 1 → 2 |
| `FxQDATkYHtk` | politik | putar ulang | 17 | 10/0/0 | 0 | 2/10 | 2 → 2 | 3 → 3 | 0 → 2 |
| `Ive926sC6mc` | copet | heuristik | 41 | 10/0/0 | 0 | 3/10 | 3 → 2 | 5 → 3 | 1 → 1 |
| `rBg0ZcwjVKQ` | jomok | heuristik | 14 | 9/0/1 | 0 | 3/10 | 1 → 3 | 2 → 4 | 0 → 1 |
| `rBg0ZcwjVKQ` | jomok | putar ulang | 14 | 10/0/0 | 0 | 3/10 | 1 → 3 | 2 → 4 | 0 → 1 |
| `WRxJGz-TA44` | burnout | heuristik | 3 | 3/0/7 | 0 | 8/10 | 3 → 2 | 3 → 2 | 1 → 2 |
| `WRxJGz-TA44` | burnout | putar ulang | 3 | 3/0/7 | 0 | 8/10 | 3 → 3 | 4 → 4 | 1 → 1 |
| **Total 12 run** | | | | 82 literal | **0** | | 30 → 35 | 43 → 52 | 7 → 13 |

- **0 label literal salah dari 82**, diperiksa ulang dengan regex terpisah (bukan pencocok
  engine) yang juga memastikan `at` ada di dalam klipnya. Urutan `literal`, `semantic`, `none`
  benar di semua run. Tidak ada sebutan yang tertinggal selama masih ada klip `none`.
- **36 run tambahan** (3 istilah lain yang diucapkan per episode): 0 label salah dari 169.
  8 sebutan tertinggal padahal ada klip `none`: 6 berada di celah 9 detik di antara dua klip
  literal terpilih (tidak muat jendela 20 detik), 2 ("meme" di 3357 dtk `rBg0ZcwjVKQ`) hanya bisa
  dicakup jendela yang dimulai di baris jawaban ("Iya K dia tahunya meme ..."), yang tidak pernah
  dipakai heuristik sebagai awal klip.
- **Kualitas vs cakupan (perlu keputusan pemilik).** Di mode `prefer`, jendela heuristik di
  sekitar setiap sebutan naik di atas pilihan `semantic` dan `none` milik LLM, persis seperti
  aturan partisi di spesifikasi. Hits naik (30 → 35 di 5 besar, 43 → 52 di 10 besar) tetapi trap
  di 10 besar juga naik (7 → 13). Trap yang ikut terangkat: `FxQDATkYHtk` T3 (kata "politik"
  tanpa isi), `rBg0ZcwjVKQ` T1 (sapaan kanal 00:53 "belajar perjomokan di sini"), `WRxJGz-TA44`
  T1 (teaser pembuka yang mengulang "Burnout-nya ..."), `Ive926sC6mc` T1. Pilihan lanjutan: skor
  minimum untuk jendela heuristik yang diangkat fokus, mengecualikan teaser dan sapaan pembuka,
  atau membaca butir "Heuristik fallback" di spesifikasi hanya untuk run tanpa LLM.

**Model sungguhan dengan blok fokus** (Ollama Cloud gratis, `gemma4:31b`, 6 permintaan):

| Episode | Istilah | L/S/N | Label literal salah | Momen sama dengan tanpa fokus | Momen yang diisi `"focus"` oleh model |
|---|---|---|---|---|---|
| `rBg0ZcwjVKQ` | jomok | 10/0/0 (4 AI + 6 heuristik) | 0 | 0/10 | 10 dari 10 |
| `0K37SYfox7M` | whatsapp, grup wa | 4/1/5 | 0 | 4/10 | 3 dari 10 |
| `WRxJGz-TA44` | burnout | 2/1/7 | 0 | 3/10 | 10 dari 10 |

Di `rBg0ZcwjVKQ`, 1 momen `semantic` dan 5 momen `none` pilihan model tergeser oleh jendela
heuristik yang menyebut "jomok"; gold di 10 besar turun dari 5 ke 4. Baris `Format:` membuat
model mengisi `"focus"` hampir selalu, tetapi tidak selalu (jawaban kosong dibaca `none`, dan
label `literal` tetap diputuskan kode).

**E2E kasus pemilik** (build produksi dan worker, job YouTube `rBg0ZcwjVKQ` dari form
dashboard, 8 klip, 20–90 detik, subtitle YouTube, rantai LLM gratis):

| Job | Model | Ringkasan | Label | Label literal salah (regex terpisah) |
|---|---|---|---|---|
| Fokus "jomok" (catatan "momen jomok yang lucu") | `gemma4:31b` | 8 dari 8 klip cocok | 8 literal (5 AI, 3 heuristik) | 0 |
| Fokus "drama" (istilah yang lebih jarang) | `gemma4:31b` | 2 dari 8 klip cocok, `focus_few_matches:2` | 2 literal, 6 "Di luar fokus" | 0 |
| Tanpa fokus | `gpt-oss:120b` | – | tanpa kunci `focus` | – |

- Bentuk turunan yang terbukti di klip: `perjomokan`, `jomoknya`, `berjomok`, dan `dramanya`
  untuk "drama". `dramok` dan varian subtitle `jombok` tidak ikut cocok.
- Tanpa fokus, pada transkrip, sound events, dan timeline audio job ini, seleksi heuristik dan
  permintaan usulan LLM pertama identik byte demi byte dengan `54a360a`. Kunci job, manifest,
  dan `selection.v3.json` sama dengan job V3 yang dibuat kode lama.
- Dengan fokus "jomok", 3 dari 8 klip adalah jendela heuristik dengan judul lemah, termasuk
  sapaan pembuka kanal (0:06–1:19, trap T1). Di job "drama", satu jendela heuristik (skor 5,6)
  naik di atas klip AI bernilai 8,x. Ini trade-off `prefer` yang dijelaskan di atas.

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

## Heuristik v3.1 (2026-09-24, susulan)

Perubahan: tawa tertulis ("Hahaha", "Wkwk", "lucu banget") dihitung sebagai tawa bila transkrip
sama sekali tidak punya tag tawa; reaksi host ("Hah? Serius?", "Masa sih?") tidak memotong
jawaban dan tidak pernah menjadi awal klip; label humor butuh tawa jauh di atas rata-rata
episode; teks hook (≤60) dan judul (≤70 karakter) dari kalimat bersih tanpa "…".

**Tuning** (8 konfigurasi: YT/Whisper × 20–60/20–90 × 2 episode, top-10):

| | Sebelum | Sesudah |
|---|---|---|
| Hits@5 / Hits@10 | 21 / 36 | 23 / 37 |
| Jebakan @5 / @10 | 2 / 2 | 2 / 3 |
| Momen humor gold @5 / @10 | 2 / 4 | 4 / 6 |
| Proposal berisi "…" (dari 80) | 36 | 0 |
| Judul > 70 karakter | 41 | 0 |
| Judul gagal cek `packaging_problem` | 28 | 0 |

**Held-out, dijalankan sekali setelah dibekukan** (5 episode, 60 gold): hits @5 27→27, @10
38→38, jebakan @5 9→6, @10 15→15. Seleksi dari subtitle YouTube identik dengan sebelumnya;
perubahan hanya di jalur Whisper.

**Banter tetap 0/12** (VINDES `FxQDATkYHtk`). Track YouTube-nya hanya punya 1 tag tawa dalam
78 menit, dan satu tag itu mematikan fallback tawa tertulis. Ambang "jarang ditandai" (mis. <1
tag per 10 menit) adalah kandidat, tetapi menyetelnya di episode ini berarti menyetel di
held-out; perlu episode banter baru ber-gold. Semua ide hadiah-tawa lain (kata roasting,
callback, tawa awal, setup→punchline) menambah jebakan di tuning dan ditolak. Kemungkinan butuh
sinyal lain: giliran bicara (`speaker-changes.json`) atau deteksi tawa dari audio.

Skrip dan keluaran mentah: `scratchpad/followups/taskC/` (ablations, heldout-base/new).

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
