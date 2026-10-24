# Evaluasi auto-reframe (Otomatis)

Evaluasi ini mengukur dua hal untuk tata letak **Otomatis**: apakah batas shot ditemukan di frame
yang benar, dan apakah tiap shot mendapat mode 9:16 yang benar (`camera`, `fill_center`,
`fit_blur`, `split`). Rancangannya ada di rencana `2026-10-24-rombak`, dokumen 04 §A3–§A10.

Harness: `scripts/eval/auto_reframe.py`. Sumber dan jendela: `docs/evaluation/TRAINING_SOURCE_REGISTRY.json`
(blok `reframe_eval`). Label: `docs/evaluation/auto-reframe/labels.dev.json` dan
`labels.test.json`.

## Set evaluasi

- ±40 jendela 120 detik dari sumber berlisensi terbuka (CC BY, CC0, domain publik). Setiap sumber
  di registry mencatat URL halaman, lisensi, URL lisensi, tanggal lisensi dicek dan tanggal akses.
  Footage tidak di-commit: `--fetch` mengunduh tiap jendela ke cache di luar repo.
- Komposisi target: 10 satu pembicara, 10 podcast dua orang, 8 panel ≥ 3 orang, 6 layar/slide,
  6 campuran gameplay/b-roll.
- Kategori dan titik mulai jendela ditetapkan sebelum split. Titik mulai diambil acak dari seed
  tercatat, di antara 10% durasi dan 90% durasi dikurangi 120 detik.
- **Split dev/test** dibuat sebelum label apa pun ditulis: per kategori, jendela diacak dengan seed
  tercatat (`reframe_eval.split.seed`), separuh pertama dev, sisanya test (kalau ganjil, dev dapat
  yang lebih sedikit). Jendela dari sumber yang sama selalu masuk split yang sama.
- **Test split dikunci.** Hanya dijalankan sekali, di RF-M4. Harness menolak menjalankannya tanpa
  `--confirm-once` dan menolak kalau `docs/evaluation/auto-reframe/test-run.json` sudah ada.

## Label

Satu entri per jendela:

```json
{"id": "rf-07", "fps": [30, 1], "window_sf": [5400, 9000],
 "cuts_sf": [6012, 7330], "modes": ["camera", "fit_blur", "camera"]}
```

- Semua frame memakai **grid dokumen**: frame rate dokumen sumber itu (aturan
  `edit_v2.seed.output_fps`: 50 → 25, 60 → 30, 59,94 → 29,97, VFR → 30), dihitung dari awal sumber.
  `window_sf` = `[sf_ceil(start_ms), sf_ceil(start_ms) + sf_floor(120000))`.
- `cuts_sf` naik ketat, di dalam jendela (tidak di frame pertamanya). Cut = **frame pertama shot
  baru**.
- `modes` berisi satu mode per shot, jadi panjangnya `len(cuts_sf) + 1`.

### Apa yang dihitung cut

| Kejadian | Label |
|---|---|
| Potongan keras ke sudut kamera, orang, atau gambar lain | cut |
| Dissolve, fade, wipe | satu cut, di frame pertama gambar baru tampak ≥ 50% |
| Pindah tata letak (layar penuh ↔ gambar dalam gambar, slide ↔ pembicara) | cut |
| Kilat, lampu blitz, satu-dua frame putih | bukan cut |
| Grafis, teks, logo, lower third yang muncul di atas gambar yang sama | bukan cut |
| Kamera menggeser, zoom, atau objek lewat di depan kamera | bukan cut |

### Mode yang benar per shot

Pilih bingkai 9:16 yang akan dipilih clipper berpengalaman untuk shot itu:

| Mode | Kapan |
|---|---|
| `camera` (Ikuti wajah) | ada wajah yang jelas jadi pusat perhatian dan perlu diikuti, misalnya pembicara bergerak atau tidak di tengah |
| `fill_center` | subjek sudah di tengah dan diam; crop tengah cukup |
| `fit_blur` (Latar blur) | tidak ada wajah utama, atau isi penting melebar (layar, slide, gameplay, banyak orang sekaligus), atau wajahnya terlalu kecil |
| `split` (Layar terbagi) | dua orang di satu shot lebar, keduanya bergantian bicara, dan tidak muat dalam satu crop |

Kalau ragu antara `camera` dan `fill_center`, pilih `camera`.

### Siapa yang melabeli

- **Dev split:** implementer, dibantu lembar kontak (`--sheets`): satu ubin tiap detik untuk
  seluruh jendela dan potongan ±2 frame di sekitar tiap kandidat cut. Kandidat diambil dari dua
  ukuran yang berbeda: skor `scene` FFmpeg dengan ambang rendah dan selisih frame berturut 64×36.
  Ubin per detik dipakai untuk menemukan cut yang tidak masuk kandidat.
- **Test split:** pemilik, lewat halaman bantu statis `--label` (HTML lokal, bukan rute app),
  ±60–90 menit untuk 20 jendela.

## Metrik

- **Cut:** presisi, recall dan F1 dengan toleransi ±1 frame grid. Pasangan cut prediksi–label dibuat
  satu-satu dengan jumlah pasangan terbanyak; cut tanpa pasangan dihitung salah. Dijumlahkan di semua
  jendela split sebelum dibagi.
- **Agreement mode:** porsi frame jendela yang modenya sama dengan label, dijumlahkan di semua
  jendela.
- **Waktu pindai:** detik jam dinding per jendela 120 detik di runner CI
  (`editor-gates.yml suite=command`).

## Gerbang (dikunci sebelum test split dijalankan)

Gerbang ini ditulis 2026-10-24, sebelum label test ada dan sebelum test split pernah dijalankan.
Angka di bawah tidak dilonggarkan.

| Gerbang | Syarat | Split | Milestone |
|---|---|---|---|
| Cut | presisi ≥ 0,95 dan recall ≥ 0,90, toleransi ±1 frame grid, termasuk fixture VFR, 59,94→29,97 dan 60→30 | dev | RF-M1 |
| Waktu pindai | ≤ 15 detik + 0,5 detik per cut untuk jendela 120 detik | CI | RF-M1 |
| Agreement | ≥ 85% frame | test, sekali | RF-M4 |
| Framing pembicara | galat set `multi` SPEAKER_FRAMING (`scripts/eval/speaker_framing.py`, metrik `SPEAKER_FRAMING.md`, hari ini 20,7%) ≤ 21,7% pada frame `camera` | AVA val | RF-M4 |
| Penilaian pemilik | ≥ 8 dari 10 klip `split` diterima; kalau `AUTO_SPLIT = False`, 10 klip Otomatis acak | — | RF-M4 |

Kalau gerbang RF-M4 gagal: nilai tidak dilonggarkan. Tahap 2 sweep diulang di dev dengan fitur
evidence tambahan, lalu dibuat test split **baru** dari jendela baru. Semua itu dicatat di sini.

## Sweep (RF-M1/RF-M4, `--sweep --split dev`)

| Kunci | Grid |
|---|---|
| `cut.coarse_scene_pm` | 200, 250, 300, 350, 400 |
| `cut.refine_diff_pm` | 60, 80, 100, 130, 160 |
| `cut.min_gap_ms` | 300, 500, 800 |
| `face.present_pm` | 300, 400, 500, 600 |
| `face.small_w_pm` | 40, 60, 80, 100 |
| `face.centre_pm` | 60, 100, 140 |
| `speakers.active_pm` | 100, 150, 200 |
| `speakers.split_share_pm` | 200, 250, 300, 350 |
| `motion.still_pm` | 20, 40, 60 |

- **Tahap 1 (cut):** kunci `cut.*` dengan F1 tertinggi di antara yang presisi ≥ 0,95 dan recall
  ≥ 0,90. Seri: `min_gap_ms` lebih besar, lalu `coarse_scene_pm` lebih besar.
- **Tahap 2 (mode):** dengan cut terkunci, kunci lain dengan agreement tertinggi. Seri: yang
  memberi lebih sedikit frame non-`camera`.
- Nilai terpilih masuk `resources/reframe/rules.v1.json` (RF-M1/RF-M4).

## Baseline hari ini (dev split)

Belum dijalankan. Diisi dari run CI setelah label dev selesai.

## Menjalankan

```bash
# unduh jendela ke cache (butuh internet dan FFmpeg)
uv run python scripts/eval/auto_reframe.py --fetch --split dev --cache ~/.cache/potongin-reframe
# lembar kontak untuk melabeli
uv run python scripts/eval/auto_reframe.py --sheets --split dev --cache ~/.cache/potongin-reframe --out lembar/
# halaman bantu label (pemilik, test split)
uv run python scripts/eval/auto_reframe.py --label --split test --cache ~/.cache/potongin-reframe --out label-test.html
# baseline camera hari ini di dev split
uv run python scripts/eval/auto_reframe.py --split dev --cache ~/.cache/potongin-reframe --out hasil.json
```

Di GitHub Actions: `gh workflow run editor-gates.yml -f ref=<branch> -f suite=command -f
command='…'` dengan `--fetch` lalu perintah lain dan `--out /out/…`, cache di `/tmp`.
