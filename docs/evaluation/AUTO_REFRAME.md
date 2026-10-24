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

### Set yang tercapai (2026-10-24)

- Semua sumber dari Wikimedia Commons, berlisensi CC BY 3.0/4.0, CC0, atau domain publik
  (karya pemerintah AS: NASA, VOA, Gedung Putih, HHS, Marinir AS). Lisensi dicek dari templat
  lisensi di halaman berkas Commons. 15 sumber masih berstatus "license review needed" di
  Commons (lisensi diklaim pengunggah, belum dicek peninjau Commons); kolom
  `commons_license_review` di registry mencatatnya.
- 51 kandidat dicari, 7 kandidat terpanjang yang berlebih per kategori dibuang sebelum diunduh.
  Dari 44 sisanya, lembar ringkas (satu ubin per detik) dilihat sebelum split: 2 jendela dibuang
  karena isinya satu gambar diam tanpa orang (`rf-18`, `rf-22`), 4 jendela pindah kategori
  (`rf-25` → gameplay/b-roll, `rf-27` dan `rf-35` → satu pembicara, `rf-33` → layar).
- **42 jendela**: 12 satu pembicara, 8 podcast dua orang, 6 panel, 8 layar/slide, 8
  gameplay/b-roll. Target 10/10/8/6/6 tidak tercapai untuk podcast dua orang dan panel: sumber dua
  orang dan panel yang berlisensi terbuka dan bisa diunduh lebih sedikit. Dua kategori itu yang
  paling menguji `split` dan banyak wajah, jadi angka per kategorinya (dev 4 dan 3 jendela) lemah.
  Set tidak ditambah setelah split dan label dev dibuat; menambah sumber berarti split baru.
- Split seed `20261024`: dev 21, test 21 (per kategori 6/6, 4/4, 3/3, 4/4, 4/4).

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
| Rekaman layar: pindah halaman, dialog, menu, gulir di aplikasi yang sama | bukan cut |
| Ganti slide penuh (gambar lama diganti seluruhnya) | cut |
| Kotak webcam kecil muncul atau hilang di atas slide | bukan cut (overlay) |
| Sudut sama, cahaya berubah tiba-tiba dan bertahan | cut |
| Animasi datar: elemen bergerak di komposisi yang sama | bukan cut; ganti komposisi utuh = cut |

Lima baris terakhir ditambahkan 2026-10-25 saat melabeli dev, sebelum ada label test.

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
  ±60–90 menit untuk 20 jendela. Tiap jendela dicentang **Selesai** setelah dilabeli. Jendela yang
  belum dicentang diunduh tanpa label (`cuts_sf` dan `modes` `null`), dan `--score` menolak file
  itu, jadi jendela yang terlewat tidak terbaca sebagai satu shot `camera`.

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

Prediksi diukur di GitHub Actions tanpa membaca label (`--predict`, run
[40116487099](https://github.com/RevDonz/ai-video-clipper/actions/runs/40116487099), image produksi,
OpenCV 4.14.0), lalu dinilai dengan label dev (`--score`). Prediksi CI:
`docs/evaluation/auto-reframe/predictions-dev-2026-10-25.json`; hasil lengkap:
`docs/evaluation/auto-reframe/baseline-dev-2026-10-25.json` (bisa diulang dengan `--score` tanpa
footage).

Mode hari ini = Ikuti wajah, dan bagian tanpa wajah (`no_face` camera plan, > 1,5 detik) dipusatkan,
karena seed menulis `layout.default.no_face = "center"` (CONTRACTS §5.40). Sumber cut hari ini: flag cut camera plan (sampel
0,75 detik) dan potongan adegan FFmpeg pipeline (`scene > 0,3`).

| Ukuran (21 jendela, 95 cut) | Hasil |
|---|---|
| Cut camera plan, ±1 frame | P 0,051 · R 0,074 · F1 0,060 |
| Cut camera plan, ±1 sampel (±0,75 detik) | P 0,377 · R 0,547 |
| Potongan adegan FFmpeg, ±1 frame | P 0,981 · R 0,547 · F1 0,703 |
| Potongan adegan FFmpeg, rata-rata per jendela (11 jendela ber-cut) | P 0,889 · R 0,474 |
| Potongan adegan FFmpeg tanpa `rf-49`, ±1 frame | P 0,967 · R 0,527 |
| Agreement mode hari ini (Ikuti wajah, tanpa wajah dipusatkan) | 23,0% |
| Agreement mode, Ikuti wajah di semua frame (tanpa fallback `no_face`) | 21,0% |
| Agreement mode, Latar blur di semua frame (default Buat klip) | 63,1% |
| Porsi frame label | camera 21,0% · fill_center 10,5% · fit_blur 63,1% · split 5,3% |
| Waktu camera plan per jendela 120 detik (CI) | rata-rata 3,75 detik, maks 5,16 detik |

Per kategori, recall potongan adegan FFmpeg: satu pembicara 0,10 (wipe dan fade tidak terdeteksi),
dua orang 1,00, panel 1,00, layar 0 (3 cut slide terlewat, 1 dialog salah dihitung), gameplay/b-roll
0,63. Agreement mode hari ini tertinggi di satu pembicara (57,8%) dan 0% di layar dan dua orang.

Artinya untuk RF-M1: flag cut camera plan tidak bisa jadi batas shot (resolusinya satu sampel),
potongan adegan FFmpeg presisinya sudah tinggi tapi recall-nya jauh di bawah gerbang 0,90.

Batasan label dev: kandidat cut diambil dari dua ukuran perbedaan gambar, jadi cut yang tidak
mengubah gambar secara mencolok bisa terlewat oleh kandidat dan oleh pelabel; ubin per detik dipakai
untuk menutup celah itu. `rf-49` (game showcase dengan banyak menu kabur) adalah label paling tidak
pasti, dan memuat 40 dari 95 cut dev, jadi P/R gabungan sebagian besar mencerminkan satu jendela
itu; karena itu hasil juga memuat P/R rata-rata per jendela (`*_per_window`) dan jendela dengan cut
terbanyak (`most_cuts`). Di dev, dua orang dan panel masing-masing hanya punya satu jendela ber-cut.
90 dari 95 cut label jatuh di kandidat dari skor `scene` FFmpeg dan selisih frame 64×36, keluarga
sinyal yang sama dengan detektor RF-M1, jadi recall detektor itu di dev kemungkinan terlalu tinggi;
test split yang dilabeli pemilik di halaman `--label` tidak memakai kandidat. `rf-17` berisi satu gambar sampul diam; jendela ini terlewat saat penyaringan sebelum split
dan tetap dipakai (label `fit_blur`) supaya split tidak berubah setelah lembar dev dilihat.

## Menjalankan

```bash
# unduh jendela ke cache (butuh internet dan FFmpeg)
uv run python scripts/eval/auto_reframe.py --fetch --split dev --cache ~/.cache/potongin-reframe
# lembar kontak untuk melabeli
uv run python scripts/eval/auto_reframe.py --sheets --split dev --cache ~/.cache/potongin-reframe --out lembar/
# halaman bantu label (pemilik, test split)
uv run python scripts/eval/auto_reframe.py --label --split test --cache ~/.cache/potongin-reframe --out label-test.html
# baseline camera hari ini di dev split: ukur (tanpa label), lalu nilai
uv run python scripts/eval/auto_reframe.py --predict --split dev --cache ~/.cache/potongin-reframe --out prediksi.json
uv run python scripts/eval/auto_reframe.py --score prediksi.json --split dev --cache ~/.cache/potongin-reframe --out hasil.json
```

Di GitHub Actions: `gh workflow run editor-gates.yml -f ref=<branch> -f suite=command -f
command='…'` dengan `--fetch` lalu perintah lain dan `--out /out/…`, cache di `/tmp`.
