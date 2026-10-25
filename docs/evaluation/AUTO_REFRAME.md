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

## Detektor shot dan sweep (RF-M1)

Kode: `src/ai_clipper/edit_v2/shot_cuts.py` (cut), `src/ai_clipper/shot_context.py` (evidence per
shot), `src/ai_clipper/edit_v2/shots.py` (keputusan, shot plan). Ambang: `resources/reframe/rules.v1.json`.

**Cara detektor bekerja (satu proses FFmpeg per jendela):** jendela didekode di grid dokumen
persis seperti kompiler (`-ss` dengan pre-roll 1 dtk, `-copyts`, `fps`, `trim` di indeks grid).
Setiap frame grid diukur dua kali: skor `scene` FFmpeg di gambar lebar 160 px (filter
`audio_timeline._SCENE_FILTER`, semua frame disimpan) dan gambar abu-abu 64×36, dari mana selisih
rata-rata ke frame 1, 2, 3 dan 12 frame sebelumnya disimpan. Lalu:

1. kandidat = frame dengan skor `scene` > `cut.coarse_scene_pm`, ditambah flag cut camera plan;
2. di ±500 ms tiap kandidat, frame dengan selisih terbesar ke frame sebelumnya adalah cut bila
   selisih itu ≥ `cut.refine_diff_pm` **dan** frame itu membawa ≥ separuh perubahan dari dua frame
   sebelumnya sampai frame sesudahnya (langkah dissolve atau gerak kamera tidak); gambar yang
   kembali dalam ≤ 2 frame adalah kilat, bukan cut;
3. lompatan tunggal: selisih ≥ separuh `cut.refine_diff_pm` yang ≥ 4× selisih kedua tetangganya
   (cut di antara dua gambar mirip, yang skor `scene`-nya rendah), dengan syarat yang sama;
4. transisi bertahap (fade, dissolve, wipe): 12 frame yang ujung-ujungnya berbeda ≥
   `cut.refine_diff_pm`, tanpa satu frame pun yang membawa separuh perubahan itu, dengan gambar
   diam sebelum dan sesudahnya (selisih per 3 frame ≤ 1/8 perubahan; gerak kamera tidak lolos).
   Cut-nya frame pertama saat separuh perubahan frame-ke-frame sudah terjadi (gambar baru ≥ 50%).
   Dua transisi yang berjarak ≤ 24 frame adalah satu dip lewat hitam/putih: cut-nya yang kedua,
   saat gambar baru datang;
5. dua cut yang lebih dekat dari `cut.min_gap_ms`: yang lebih kuat dipertahankan.

Langkah 3, 4 dan aturan kilat ditambahkan di atas rancangan 04 §A3 karena baseline menunjukkan
wipe dan fade tidak tertangkap (recall satu pembicara 0,10) dan label menyebut kilat bukan cut;
konstantanya (2 frame, 4×, separuh, 12 frame, 1/8, 24 frame) tetap, tidak ikut sweep. Pengukuran
satu proses untuk seluruh jendela menggantikan dekode ±500 ms per kandidat dari 04 §A3: hasil per
frame sama, dan profil yang sama bisa dinilai ulang untuk setiap konfigurasi sweep tanpa footage.

### Hasil sweep dev (2026-10-25)

Profil diukur di GitHub Actions tanpa membaca label (`--profile`, run
[40185140026](https://github.com/RevDonz/ai-video-clipper/actions/runs/40185140026), image produksi):
`docs/evaluation/auto-reframe/profiles-dev-2026-10-25.json`. Sweep dua tahap di profil itu
(`--sweep`, bisa diulang tanpa footage): `docs/evaluation/auto-reframe/sweep-dev-2026-10-25.json`.
Nilai terpilih ditulis ke `resources/reframe/rules.v1.json` (`rules_id` `6b67494539ede149`):

| Kunci | Nilai |
|---|---|
| `cut.coarse_scene_pm` / `refine_diff_pm` / `min_gap_ms` | 200 / 130 / 800 |
| `face.present_pm` / `small_w_pm` / `centre_pm` | 400 / 80 / 60 |
| `speakers.active_pm` / `split_share_pm` | 100 / 300 |
| `motion.still_pm` | 20 |

| Gerbang (dev) | Syarat | Hasil |
|---|---|---|
| Cut, ±1 frame (21 jendela, 95 cut) | P ≥ 0,95 dan R ≥ 0,90 | **gagal**: P 0,915 · R 0,789 · F1 0,847 (75 benar, 7 salah, 20 terlewat) |
| Waktu pindai (CI) | ≤ 15 dtk + 0,5 dtk/cut | lolos di 21/21 jendela, maks 9,99 dtk |
| Agreement mode (dev, informatif; gerbangnya test split di RF-M4) | ≥ 85% | 82,5% (baseline hari ini 23,0%; Latar blur di semua frame 63,1%) |

Tidak ada konfigurasi cut yang memenuhi kedua lantai, jadi tahap 2 berjalan di F1 terbaik dan
gerbang cut RF-M1 dicatat **gagal**; lantainya tidak dilonggarkan. Per kategori: dua orang dan panel
P = R = 1,0; gameplay/b-roll P 0,94 · R 0,85 (`rf-49` memuat 9 dari 20 cut terlewat); satu pembicara
P 0,85 · R 0,55 (`rf-10`: 7 cut di antara sudut yang hampir sama, selisih 64×36 hanya 3–10%); layar
P 0,33 · R 0,33 (`rf-37`: pindah dialog yang menurut label bukan cut; `rf-44`: ganti slide dengan
selisih 6–7%). Agreement per kategori: layar 100%, gameplay/b-roll 87%, satu pembicara 79%, panel
75%, dua orang 72% (frame `split` berlabel selalu salah selama `AUTO_SPLIT = False`).

Detektor diperbaiki dua kali di dev sebelum nilai ini dipilih (dicatat supaya tidak tampak satu
kali coba): versi pertama (tanpa syarat separuh perubahan, tanpa lompatan tunggal, tanpa dip)
memberi P 0,784 · R 0,726; versi kedua (dengan syarat separuh dan posisi 50%) P 0,843 · R 0,737.
Langkah berikutnya untuk menutup celah tanpa melonggarkan gerbang: sinyal cut yang lebih halus
dari 64×36 abu-abu (warna atau resolusi lebih tinggi untuk `rf-10` dan slide), lalu sweep ulang di
dev; test split tetap tertutup sampai RF-M4.

**Sweep tanpa footage:** `--profile` (di CI, tanpa membaca label) menyimpan profil grid, scan wajah
dan waktu tiap jendela; `--sweep --profiles …` menjalankan tahap 1 (75 konfigurasi `cut.*`) dan
tahap 2 (1.728 konfigurasi kunci lain dengan cut tahap 1) di mana saja. Kalau tidak ada konfigurasi
cut yang memenuhi P ≥ 0,95 dan R ≥ 0,90, hasil mencatat `cut.gate_met: false`, tahap 2 tetap
berjalan di F1 terbaik, dan gerbang **tidak** dilonggarkan. `--write-rules` menulis nilai terpilih
ke `rules.v1.json`. `Split` tidak pernah diprediksi selama `AUTO_SPLIT = False` (spike RF-M2), jadi
frame berlabel `split` dihitung tidak cocok.

## Release 1 dan test split (RF-M3, RF-M4)

**RF-M3 (2026-10-25).** Otomatis sekarang dibuat dari job: `renderMode: "auto"` menjalankan
`shots.prepare_auto` per klip di dalam render-nya (camera plan dan shot plan dari satu scan),
lalu seed menyalin `ranges` shot plan. Klip yang analisisnya gagal dirender Latar blur dengan
warning `auto_reframe_failed:<index>`. Flag `POTONGIN_AUTO_REFRAME` bawaannya `off`: API job
menolak Otomatis untuk job baru, sedangkan job dan dokumen Otomatis yang sudah ada tetap
dirender (floor). Nilai `rules.v1.json` tidak berubah (`rules_id` `6b67494539ede149`).

**Split dan group framing (RF-M4, dev).** Tidak ada penyetelan baru di dev:

- `split`: `AUTO_SPLIT` masih `False` karena gate spike graf §A7.2 (1080p dan 720p, 1/8/48
  run) belum dijalankan di CI. Aturan #2 jatuh ke `camera`, jadi `speakers.split_share_pm` tidak
  bisa dinilai. Kalau spike lolos, split disetel di dev dulu, sebelum test split.
- group framing (`face.*`, `speakers.active_pm`, `motion.still_pm`): nilainya sudah dipilih oleh
  tahap 2 sweep RF-M1 di profil dev yang sama (agreement dev 82,5%). Tanpa profil dev baru atau
  fitur evidence tambahan, sweep ulang memberi nilai yang sama. Menurut aturan di atas, fitur
  evidence tambahan baru dipakai kalau gerbang test split gagal, lewat sweep dev ulang dan test
  split **baru**.

**Satu run test split.** Perintahnya sudah ada (`--profile --split test`, lalu
`--test-run --confirm-once`, lihat Menjalankan). Run ini **belum** dijalankan karena dua hal:

1. `labels.test.json` masih placeholder (`cuts_sf`/`modes` `null`). Pemilik melabeli 21 jendela
   lewat halaman `--label` (±60–90 menit). `--test-run` menolak file yang belum lengkap, jadi
   jendela yang terlewat tidak menghabiskan test split.
2. Profil test diukur di CI (`suite=command`), sama seperti profil dev.

`--test-run` memakai `rules.v1.json` apa adanya, tanpa sweep. Ia membuat lock `test-run.json`
(rules, profil, dan label lewat sha, serta agreement) sebelum melaporkan hasil, dan lock yang
di-commit menolak semua run berikutnya.

**Dua gerbang RF-M4 lain:**

- *SPEAKER_FRAMING multi ≤ 21,7% pada frame `camera`.* Camera plan dari scan bersama sama byte
  dengan jalur lama (pin RF-M1), jadi frame `camera` Otomatis memakai crop yang sama dengan Ikuti
  wajah. Angka ini tetap diukur sekali di CI dengan `scripts/eval/speaker_framing.py` (set
  `multi`, AVA val). Status: **menunggu**.
- *Penilaian pemilik.* Selama `AUTO_SPLIT = False`, pemilik menilai 10 klip Otomatis acak:
  `POTONGIN_AUTO_REFRAME=on` di server uji, buat job dengan tata letak Otomatis dari video
  sendiri, lalu nilai 10 klip pertama. Lolos kalau ≥ 8 diterima. Status: **menunggu pemilik**.

| # | Job / klip | Diterima? | Catatan |
|---|---|---|---|
| 1–10 | (diisi pemilik) | | |

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
# detektor shot RF-M1: profil (di CI, tanpa label), lalu sweep (tanpa footage)
uv run python scripts/eval/auto_reframe.py --profile --split dev --cache ~/.cache/potongin-reframe --out profil-dev.json
uv run python scripts/eval/auto_reframe.py --sweep --split dev --profiles profil-dev.json --out sweep-dev.json
# test split, sekali (RF-M4): profil (tanpa label), lalu satu run dengan rules yang di-commit
uv run python scripts/eval/auto_reframe.py --profile --split test --cache ~/.cache/potongin-reframe --out profil-test.json
uv run python scripts/eval/auto_reframe.py --test-run --split test --profiles profil-test.json --confirm-once --out hasil-test.json
```

Di GitHub Actions: `gh workflow run editor-gates.yml -f ref=<branch> -f suite=command -f
command='…'` dengan `--fetch` lalu perintah lain dan `--out /out/…`, cache di `/tmp`. Di CI,
`--test-run` diberi `--lock /out/test-run.json`; file itu lalu di-commit ke
`docs/evaluation/auto-reframe/test-run.json` bersama hasilnya.
