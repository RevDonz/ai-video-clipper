# 04 · Auto-reframe & unduhan

- **Status:** Rancangan — belum diimplementasi
- **Tanggal:** 2026-10-24
- **Indeks:** [00-README.md](00-README.md) · dokumen saudara 01–08 (daftar dan judulnya di 00-README.md; fase dan gate lintas dokumen di [08-fase-test-deploy.md](08-fase-test-deploy.md)) · **04 (dokumen ini)**
- **Sumber:** roadmap induk (Koreksi akhir KA1–KA26 berlaku di atas semua sumber, terutama KA3, KA6, KA9, KA11), roadmap fitur 01 + review #1–#16, editor 03 (§3f, §5.5, koreksi #6), dashboard 02 (§3.2), i18n 04.
- **Lingkup:** RF-M0…RF-M6 (+ RF-M7 opsional), editor F4b (bagian data/kompiler saja; UI ada di dokumen editor), MU-M4b bagian sumber link, FETCH-M0…FETCH-M8, FETCH-M10, FETCH-M9 (ditunda, gerbang keputusan).
- Path relatif terhadap root repo `ai-video-clipper/`. File bertanda **(baru)** belum ada di repo hari ini; semua path lain sudah dicek ada (2026-10-24).
- Clean-room: tidak ada kode, markup, string, konstanta, atau nama modul SupoClip. Repo SupoClip hanya dibaca untuk perilaku (09 §1). Semua ambang diturunkan dari sweep dev-split Potongin (§A9) dan pengukuran FETCH-M0 (§B12). Nama kode alasan, file, dan field di dokumen ini adalah nama Potongin. Setiap PR menulis `Rujukan: rencana 2026-10-24-rombak + kode Potongin`.

---

## 0. Ringkasan

| Bagian | Apa yang dibangun | Fase | Hari-dev |
|---|---|---|---|
| RF-M0 | Set evaluasi ±40 jendela berlisensi, label cut, `scripts/eval/auto_reframe.py`, baseline | 0 | 4 |
| PR kontrak | CONTRACTS §5.63 (shot-plan + `layout.ranges`) dan §5.64 (sumber link + cache) | 0 | (bagian dari 1) |
| RF-M1 | Deteksi shot + evidence per shot (Python, tanpa perubahan render) | 5 ‖ | 6 |
| RF-M2 | Spike graf → kompiler `layout.ranges` dengan jumlah konteks filter tetap | 5 ‖ | 8 |
| RF-M3 | Seed/pipeline/CLI `auto`, flag `POTONGIN_AUTO_REFRAME`, skrip downgrade = **release 1 (floor)** | 6 ‖ | 4 |
| RF-M4 | Penyetelan split + group framing di dev split, satu run test split | 6 ‖ | 4 |
| MU-M4b (sumber) | Inti `web/lib/source-url.mjs` + `fetch/platforms.py` (YouTube saja), `--use-extractors`, `--no-playlist`, tolak IP privat | 6 | (bagian dari 4) |
| FETCH-M0 | Pengukuran CI: audio, waktu-ke-seleksi, bgutil, proxy, Kick, range-only | 0 | 3 |
| FETCH-M1…M8, M10 | Twitch/Kick, preflight, cache, audio-first, transkrip cache, proxy+bgutil, ledger, workflow | 7 | 31 (+2 Kick) |
| RF-M5a | Kartu Otomatis di editor lama, command, draft-store, apply-all | 7 | 4 |
| RF-M6 | Gate P-FRAME/P-PLATE/P-JOIN-B/G-DET/PF-RENDER/PF-PIPELINE; **release 2** (flag `on`, opt-in) | 7 | 5 |
| F4b (data) | Command per shot, merge ulang analisis, vektor paritas | 11 | (bagian dari 15) |
| FETCH-M9 | Range-only — hanya kalau gerbang §B11 lolos | 12 (opsional) | 12 |

### 0.1 Keputusan pemilik yang berlaku di dokumen ini

| # | Isi | Status |
|---|---|---|
| Q1 | DESIGN.md diamendemen: Mode Cepat/Lengkap dihapus, diganti pengungkapan bertahap (06 §2). Editor satu layout, panel kanan satu per satu (tab Teks · Tata letak · Audio · Logo · Cold open); kontrol halus di disclosure "Lanjutan". Strip shot ada di tab **Tata letak**, bukan panel tersendiri. | Final |
| Q2 | Node 24 + `node:sqlite` (ledger unduhan di DB yang sama, DDL milik 01 §4.4), HeroUI v3, Tailwind v4, use-intl, `@babel/parser` (dev). | Final |
| Q4 | Cache video publik + transkrip dipakai lintas user (scope `umum`), **hanya untuk unduhan tanpa cookie**. Cookie YouTube = satu set global admin, dipakai untuk job anggota hanya bila `instance_settings.youtube_cookies_share = true` (02 §9.3). | (default, bisa diubah) |
| Q5 | Durasi sumber maks 4 jam (`POTONGIN_MAX_SOURCE_SECONDS=14400`). | (default, bisa diubah) |
| Q6 | Cache unduhan: cap 4 GiB, TTL 3 hari, di luar `/data/jobs`. | (default, bisa diubah) |
| Q9 | ID dan EN dua-duanya wajib ada pada akhirnya. EN dirilis bersama fase editor (Fase 11); pratinjau `id,en` hanya sebelum ada anggota. Semua kunci baru di dokumen ini ditulis di `id` **dan** `en` sejak PR pertamanya. | Final (waktu rilis: default, bisa diubah) |
| Q10 | Otomatis **opt-in** sampai PF-PIPELINE diukur dan pemilik memutuskan; override per shot hanya `camera`/`fill_center`/`fit_blur`; `split` hanya `origin:auto` (atau seluruh klip); "Pakai di semua klip" **mengantrekan analisis**; pemilik melabeli 20 jendela test split dan menilai 10 klip split. | (default, bisa diubah) |
| Q11 | Range-only **dilewati** (FETCH-M9 tidak dibangun kecuali gerbang §B11 + pemilik); **tanpa proxy berbayar** (fitur proxy ada, mati); **bgutil opt-in**; **Kick eksperimen, mati**. | (default, bisa diubah) |

### 0.2 Flag env (semua masuk `.env.example` + `compose.yaml` service terkait, dijaga `web/tests/env-example.test.mjs`)

| Flag | Nilai | Default rilis | Service | Efek |
|---|---|---|---|---|
| `POTONGIN_AUTO_REFRAME` | `off` \| `on` | `off` (release 1), `on` (release 2) | app, primary-worker, render-worker | `off`: Buat klip tidak menawarkan Otomatis, API menolak `renderMode: "auto"`, editor menyembunyikan kartu Otomatis. Dokumen `auto` yang sudah ada **tetap dirender** (floor). |
| `POTONGIN_FETCH_AUDIO_FIRST` | `off` \| `on` | `off` → `on` setelah FETCH-M10 | primary-worker | Audio-first + unduhan video paralel (§B5). |
| `POTONGIN_FETCH_TWITCH` | `off` \| `on` | `off` → `on` | app, primary-worker | Link Twitch diterima. |
| `POTONGIN_FETCH_KICK` | `off` \| `on` | `off` | app, primary-worker | Link Kick diterima (eksperimen). |
| `POTONGIN_FETCH_SECTIONS` | `off` | `off` | primary-worker | Dicadangkan untuk FETCH-M9. Nilai selain `off` ditolak saat start sampai M9 ada. |
| `POTONGIN_MEDIA_CACHE` | `off` \| `on` | `off` → `on` | app, primary-worker | Cache media + transkrip (§B6). App membacanya untuk `GET /api/admin/cache-unduhan` (§B6.7). |
| `POTONGIN_MEDIA_CACHE_BYTES` | bilangan bulat byte | `4294967296` | app, primary-worker | Cap total cache. |
| `POTONGIN_MEDIA_CACHE_TTL_DAYS` | 1–30 | `3` | app, primary-worker | TTL sejak `lastUsedAt`. |
| `POTONGIN_POT_PROVIDER_URL` | URL `http://pot-provider:4416` atau kosong | kosong | primary-worker | Kosong = bgutil mati apa pun setelannya. |
| `POTONGIN_MAX_SOURCE_SECONDS` | detik | `14400` | app, primary-worker | Batas global durasi sumber (§B4). |

**Cara membaca flag** (mengikuti kode yang ada, bukan pola baru):
- Flag `off|on`: hanya nilai persis `on` (abaikan huruf besar/kecil dan spasi luar) yang menyala; nilai lain = mati. Ini pola `isOn()` di `web/lib/editor/flags.mjs`; fungsi baru `readFetchFlags(env)` dan `readAutoReframeFlag(env)` ditambahkan di file yang sama (bukan modul baru).
- Flag angka (`_BYTES`, `_TTL_DAYS`, `_MAX_SOURCE_SECONDS`) dan `POTONGIN_FETCH_SECTIONS` ≠ `off`: nilai tidak sah membuat primary-worker gagal start (pola `PRIMARY_WORKER_POLL_MS` di `web/scripts/primary-worker.mjs:159`, `throw new Error("Invalid primary queue configuration: …")`).
- Python **tidak** membaca `POTONGIN_AUTO_REFRAME`: flag hanya menggerbang pembuatan (API/UI). Dokumen atau job `auto` yang sudah ada selalu dirender (floor). Karena itu `CHILD_ENV_ALLOWLIST` (`web/lib/python-cli.mjs`) tidak perlu diubah untuk flag ini.

---

# Bagian A — Auto-reframe ("Otomatis")

## A1. Alur end-to-end

```
Buat klip (Tata letak: Otomatis) ──► job.options.renderMode = "auto"
  │
  ▼ pipeline V3 (seleksi tidak berubah)
  │
  ▼ per klip terpilih: prepare_auto (src/ai_clipper/edit_v2/shots.py)
  │   1. camera plan hari ini (edit_v2/camera.py build_camera_plan, tidak berubah byte)
  │   2. batas shot: shot_cuts.py → fallback scene_cuts_ms → fallback 1 shot
  │   3. evidence per shot: shot_context.py (wajah semua, pembicara, gerak)
  │   4. keputusan per shot: shots.decide_shot (tabel §A5)
  │   5. tulis shots.<sha16>.json (potongin.shot-plan/1)
  ▼
seed: layout.default.mode="auto", layout.ranges (origin:"auto"), base.shots.sha256
  ▼
kompiler (compile_ffmpeg._Compiler.layout cabang ranges): satu rantai fallback §5.40
(+ satu rantai split bila spike lolos) — jumlah konteks filter TETAP berapa pun shot-nya
  ▼
render auto file (R10) — klip yang tidak diubah tetap memakai file otomatis
```

Mesin render `legacy` (`POTONGIN_RENDER_ENGINE=legacy`, `src/ai_clipper/render.py`) tidak punya Otomatis: job `auto` dirender `fit-blur` dan manifest mendapat warning `engine_fallback` (pola yang sudah ada di `pipeline.py`). Warning ini tidak pernah tampil sebagai pilihan mode di UI (aturan "Selalu terbaru", dijaga `ui-guards`).

## A2. Milestone dan file

| Milestone | File baru | File diubah | Tes |
|---|---|---|---|
| RF-M0 | `scripts/eval/auto_reframe.py` (baru), `docs/evaluation/AUTO_REFRAME.md` (baru), `docs/evaluation/auto-reframe/labels.dev.json` (baru), `…/labels.test.json` (baru, diisi pemilik) | `docs/evaluation/TRAINING_SOURCE_REGISTRY.json` (±40 jendela berlisensi terbuka, ditandai `split: dev|test`) | `tests/test_auto_reframe_eval.py` (baru) |
| RF-M1 | `src/ai_clipper/shot_context.py` (baru), `src/ai_clipper/edit_v2/shot_cuts.py` (baru), `src/ai_clipper/edit_v2/shots.py` (baru), `resources/reframe/rules.v1.json` (baru) | `src/ai_clipper/face_window.py` (`scan_window(frame_diff=)`, `detect_window(scan=)`), `src/ai_clipper/edit_v2/camera.py` (`build_camera_plan(scan=)`); `speaker_track.py` tidak berubah (dipakai `link_tracks`, `Face.activity`) | `tests/test_shot_context.py`, `tests/test_edit_v2_shot_cuts.py`, `tests/test_edit_v2_shots.py` (semua baru), `tests/test_face_window.py`, `tests/test_speaker_track.py` (tambah kasus), `tests/test_edit_v2_camera.py` (pin byte camera plan) |
| RF-M2 | `scripts/parity/auto_graph_spike.py` (baru) | `src/ai_clipper/edit_v2/{layouts,compile_ffmpeg,doc,plan,plates,errors,__init__}.py` | `tests/test_edit_v2_compile.py`, `tests/test_edit_v2_layout_switch.py`, `tests/test_edit_v2_doc.py`, `tests/test_edit_v2_plates.py` (tambah kasus), `tests/fixtures/edit_v2/shot-vectors.json` (baru) |
| RF-M3 | `scripts/ops/auto_layout_downgrade.py` (baru, folder `scripts/ops/` baru) | `src/ai_clipper/{pipeline,cli,render,render_queue}.py`, `src/ai_clipper/edit_v2/{seed,render_edit,preview_cli}.py`, `web/lib/{jobs,dashboard-choices,layout-names,look-preview}.mjs`, `web/lib/editor/flags.mjs`, `docs/editor/OPERASIONAL.md` | `tests/test_pipeline_v3.py`, `tests/test_edit_v2_seed.py`, `tests/test_auto_layout_downgrade.py` (baru), `web/tests/{jobs,dashboard-choices,layout-names}.test.mjs` |
| RF-M4 | — | `resources/reframe/rules.v1.json` (nilai final), `docs/evaluation/AUTO_REFRAME.md` | `scripts/eval/auto_reframe.py --split test` (sekali) |
| RF-M5a | — | `web/lib/editor/{doc-model,commands,rebase,apply-all,draft-store}.mjs`, `web/components/editor/quick/LayoutCard.jsx`, `web/components/editor/panels/{LayoutPanel.jsx,layout-model.mjs,layout-analysis.mjs}`, `web/app/api/jobs/[id]/clips/[clipId]/prepare/route.js`, `web/lib/camera-progress.mjs` | `web/tests/{editor-layout,editor-layout-analysis}.test.mjs`, e2e `web/e2e/editor-auto-layout.spec.mjs` (baru) |
| RF-M6 | — | `scripts/parity/{frame_identity,plate_gates,player_fixtures,camera_real,join_gates}.py`, `scripts/parity/run_all.sh`, `docs/editor/GATES.md`, `docs/editor/PANDUAN-EDITOR.md` | lihat §A10 |
| F4b (data) | `web/lib/editor/shots.mjs` (baru) | `web/lib/editor/{commands,doc-model,rebase,apply-all}.mjs`, `src/ai_clipper/edit_v2/{shots,apply_all}.py` | `web/tests/editor-shots.test.mjs` (baru), vektor bersama `tests/fixtures/edit_v2/shot-vectors.json` |

Catatan: Mode Cepat dihapus di Fase 10 (Q1). RF-M5a (Fase 7) masih menyentuh `quick/LayoutCard.jsx` dan `panels/LayoutPanel.jsx` di editor lama; command dan model datanya dipakai ulang tanpa perubahan oleh tab Tata letak editor baru.

## A3. Deteksi shot (`src/ai_clipper/edit_v2/shot_cuts.py`, baru, stdlib saja)

Paket `edit_v2` tetap stdlib-only; FFmpeg dipanggil sebagai subproses dengan pola `edit_v2/assets.py` `_start` (fungsi privat; `shot_cuts.py` memakai salinan kecilnya sendiri atau `_start` dijadikan publik di PR yang sama): `prlimit --as=2 GiB --cpu=…` (`assets.RLIMIT_AS_BYTES = 2 << 30`), sesi proses sendiri, env allowlist `child_env`, `-protocol_whitelist file,pipe`, tidak berjalan sebagai root. Decode 64×36 abu-abu jauh di bawah batas ini; batas 3 GiB (`edit_v2/execute.py RLIMIT_AS_BYTES = 3 << 30`, R8) hanya untuk render.

Catatan kode yang ada: `face_window.scan_window` sudah menandai cut per sampel 0,75 dtk (thumbnail 64×36, `CUT_CHANGE = 0.18`). Itu terlalu kasar untuk batas shot (resolusi 750 ms), jadi `shot_cuts.py` hanya memakainya sebagai kandidat tambahan, bukan sebagai batas.

**Input:** `source: Path`, `window_ms: (a, b)`, `fps: Fps` (grid dokumen), `coarse_cuts_ms: list[int]` (opsional), `rules: Rules`.

**Langkah:**
1. **Kandidat kasar.** Sumber kandidat, urutan prioritas:
   1. pass scene FFmpeg atas jendela `[a, b)` saja: `scale=160:-2,select='gt(scene,<rules.cut.coarse_scene>)',metadata=mode=print:file=-` (bentuk filter sama dengan `audio_timeline._SCENE_FILTER`; ambang dari rules, bukan konstanta `SCENE_THRESHOLD`);
   2. ditambah flag `cuts` dari camera plan (perpindahan pembicara ≥ 22% lebar, §5.42) — flag ini **bukan** batas shot, hanya kandidat yang diverifikasi di langkah 2.
2. **Penghalusan di grid render.** Untuk tiap kandidat `c`: decode `[c − 500 ms, c + 500 ms)` sekali dengan `-vf fps=<num>/<den>,scale=64:36,format=gray -f rawvideo pipe:1` (64×36 = 2.304 byte per frame). Hitung `d(k) = Σ|p_k − p_{k−1}| / (2304·255)` per frame grid `k`. Cut = `argmax d(k)` kalau `d(k) ≥ rules.cut.refine_diff_pm / 1000`, lalu dipetakan ke source-grid frame `sf` (frame pertama shot baru). Kandidat yang tidak lolos dibuang.
3. **Jarak minimum.** Dua cut yang berjarak < `rules.cut.min_gap_ms` digabung (yang `d` lebih besar menang).
4. **Output:** `cuts_sf: list[int]` naik ketat, semua di `(window_sf[0], window_sf[1])`, plus `cut_source = "shot_cuts"`.

**Fallback (urutan tetap, dicatat di shot plan `cut_source`):**
1. `shot_cuts` sukses → `"shot_cuts"`.
2. FFmpeg gagal/timeout (`rules.scan.timeout_s`) → `scene_cuts_ms` dari words artifact klip (`edit_v2/words.py`, CONTRACTS §5.7), dibulatkan `sf_floor` → `"scene_cuts"`.
3. `scene_cuts_ms` kosong (job lama, §3.6) → satu shot seluruh jendela → `"none"`.

**Biaya (gate):** scan ≤ 15 dtk + 0,5 dtk per cut untuk jendela 120 dtk di runner CI (`editor-gates.yml suite=command`), diukur `scripts/eval/auto_reframe.py --timing`.

**Akurasi (gate RF-M1):** di dev split, presisi ≥ 0,95 dan recall ≥ 0,90 dengan toleransi ±1 frame grid, termasuk fixture VFR, 59,94→29,97 dan 60→30.

## A4. Evidence per shot (`src/ai_clipper/shot_context.py`, baru; OpenCV boleh)

Sumber data: `face_window.scan_window` (fungsi publik yang ada) sudah mengembalikan `Scan.samples`, yaitu satu `speaker_track.Sample` per 0,75 dtk dengan **semua** wajah YuNet (`Face(x, y, w, h, activity)`; `activity` = rata-rata gerak mulut, `None` bila tidak diukur). `detect_window` dan `build_camera_plan` **tidak diubah** (byte camera plan dipin di `tests/test_edit_v2_camera.py`).

Satu tambahan di `face_window.py`: keyword `scan_window(..., frame_diff=False)`. Dengan `True`, `Scan` mendapat field `frame_diff: list[float]`, yaitu selisih rata-rata thumbnail 64×36 terhadap sampel sebelumnya (nilai yang sudah dihitung untuk flag cut, sampel pertama 0.0). Default `False` → `Scan` dan semua output hari ini identik (tes baru di `tests/test_face_window.py`).

Alur `prepare_auto`: kalau camera plan baru dibuat, `build_camera_plan` dan evidence **berbagi satu scan**. Caranya, `shot_context.scan_evidence(source, window)` memanggil `scan_window(frame_diff=True)` sekali. Hasilnya diteruskan lewat keyword baru `scan: Scan | None = None`, yaitu `build_camera_plan(..., scan=s)` → `detect_window(..., scan=s)`. `detect_window` memakai `s` sebagai ganti memanggil `scan_window`, dan semua langkah sesudahnya tetap sama (`choose_faces`, centres, boxes). Jalur detektor injeksi (`detector=`, tanpa smoothing) **tidak** dipakai. Kalau camera plan sudah ada (editor), evidence menjalankan scan kedua dengan `sample_interval = SAMPLE_MS / 1000` (`edit_v2/camera.py SAMPLE_MS = 750`). Tes: camera plan dari scan bersama byte-identik dengan jalur lama.

Turunan per sampel (di `shot_context.py`, murni):
- `motion_pm` = `round(frame_diff × 1000)`, juga di sampel tanpa wajah.
- Track: `speaker_track.link_tracks(samples)` (fungsi yang ada, tidak melintasi cut).
- "Bicara" per sampel: di antara wajah dengan `activity is not None` dan tinggi ≥ `Rules.min_relative` × wajah tertinggi, track dengan `activity` tertinggi. Kalau hanya satu wajah, track itu dihitung bicara. Skala `activity` tidak dinormalisasi; yang dipakai hanya peringkatnya.

`shot_context.summarize(samples, shot: (in_sf, out_sf), fps) -> ShotEvidence`:

| Field | Tipe | Arti |
|---|---|---|
| `samples` | int | jumlah sampel di shot |
| `face_share_pm` | 0–1000 | porsi sampel dengan ≥ 1 wajah |
| `faces_p90` | int | persentil-90 jumlah wajah per sampel |
| `face_w_med_pm` | 0–1000 | median lebar wajah terbesar (per mille lebar sumber) |
| `speakers` | int | jumlah track (`speaker_track.link_tracks`) dengan `talk_share_pm ≥ rules.speakers.active_pm` |
| `talk_share_pm` | list[int] | per track aktif: `round(1000 × sampel track itu "bicara" / sampel shot dengan ≥ 1 wajah terukur)`, urut menurun; `[]` bila tidak ada wajah terukur |
| `spread_pm` | 0–1000 | jarak horizontal antara tepi kiri wajah paling kiri dan tepi kanan wajah paling kanan (median) |
| `centre_dev_pm` | 0–1000 | median `|centre − 500|` wajah terbingkai |
| `motion_med_pm` | 0–1000 | median `motion_pm` |

Shot dengan `samples < 2` (lebih pendek dari ±1,5 dtk) tidak diputuskan sendiri: ia digabung ke tetangga (§A5 langkah 3).

## A5. Keputusan per shot (`src/ai_clipper/edit_v2/shots.py`, baru, stdlib, murni)

`decide_shot(ev: ShotEvidence, *, crop_w_pm: int, rules: Rules, split_enabled: bool) -> tuple[mode, reason]`. `crop_w_pm` = lebar crop 9:16 (atau 1:1) dalam per mille lebar sumber setelah zoom (dari `layouts.scaled_size`/`zoomed_output`).

Aturan dievaluasi berurutan; aturan pertama yang cocok menang.

| # | Kondisi | Mode | Kode alasan |
|---|---|---|---|
| 1 | `face_share_pm < rules.face.present_pm` | `fit_blur` | `rf_no_face` |
| 2 | `speakers ≥ 2` dan `talk_share_pm[1] ≥ rules.speakers.split_share_pm` dan `spread_pm > crop_w_pm` | `split` kalau `split_enabled`, kalau tidak `camera` | `rf_two_speakers` |
| 3 | `faces_p90 ≥ 3` dan `spread_pm > crop_w_pm` | `fit_blur` | `rf_group_wide` |
| 4 | `face_w_med_pm < rules.face.small_w_pm` | `fit_blur` | `rf_small_face` |
| 5 | `centre_dev_pm ≤ rules.face.centre_pm` dan `motion_med_pm ≤ rules.motion.still_pm` | `fill_center` | `rf_centred` |
| 6 | lainnya | `camera` | `rf_face` |

Q10 default untuk dua pembicara di shot lebar: Layar terbagi kalau spike lolos, kalau tidak Ikuti wajah yang berpindah (perilaku §5.42 hari ini). **(default, bisa diubah)**

**`plan_shots(cuts_sf, evidences, …) -> list[Shot]`:**
1. Putuskan tiap shot dengan `samples ≥ 2`.
2. Shot dengan `samples < 2`: ambil mode tetangga yang lebih panjang (kiri kalau sama panjang), alasan `rf_short_merged`.
3. Shot berurutan dengan mode sama digabung menjadi satu range (alasan = alasan shot terpanjang).
4. Kalau ada range `split`: hitung geometri split per range dari dua track aktif teratas (pusat wajah → `x_e5`, `y_e5` per band; band atas = wajah yang bicara lebih dulu). `top_pm` dan zoom **satu per klip** (dari range split terpanjang); posisi per range.

### Shot plan file (CONTRACTS §5.63, baru)

`<clip_dir>/shots.<sha16>.json`, JSON kanonik (`src/ai_clipper/edit_v2/source_info.py canonical_json`), nama dari sha256 byte (pola `edit_v2/camera.py camera_file_name`; pembaca menolak symlink dan nama yang tidak cocok dengan isi, pola `render_edit._load_camera`):

```json
{
  "schema": "potongin.shot-plan/1",
  "rules_id": "<sha16 resources/reframe/rules.v1.json>",
  "source_content_sha256": "<hex>",
  "camera_sha256": "<hex>",
  "window_ms": [1203040, 1323040],
  "fps": {"num": 30000, "den": 1001},
  "cut_source": "shot_cuts",
  "cuts_sf": [36101, 36488],
  "split": null,
  "shots": [
    {"in_sf": 36057, "out_sf": 36101, "mode": "camera", "reason": "rf_face",
     "evidence": {"samples": 2, "face_share_pm": 1000, "faces_p90": 1, "face_w_med_pm": 141,
                  "speakers": 1, "talk_share_pm": [930], "spread_pm": 152, "centre_dev_pm": 88,
                  "motion_med_pm": 31}},
    {"in_sf": 36101, "out_sf": 36488, "mode": "fit_blur", "reason": "rf_no_face", "evidence": {"…": "…"}}
  ],
  "ranges": [
    {"in_sf": 36057, "out_sf": 36101, "mode": "camera"},
    {"in_sf": 36101, "out_sf": 39667, "mode": "fit_blur"}
  ]
}
```

- `shots` = batas shot asli (untuk strip shot editor); `ranges` = hasil setelah gabung (yang disalin ke dokumen).
- `split` = `null` atau `{"top_pm": 500, "top": {"zoom_pm": 1000}, "bottom": {"zoom_pm": 1000}}`; range `split` membawa `"split_xy": {"top": {"x_e5", "y_e5"}, "bottom": {"x_e5", "y_e5"}}`.
- Batas file 256 KiB; ≤ 200 shot. Validator `shots.read_shot_plan(path)` ketat: kunci tak dikenal, tipe salah, atau partisi tidak sah → `AnalysisMissing("analysis_missing", ref="shots")`. Gaya validasinya meniru `_strict_object` (`src/ai_clipper/media_features.py:72`), tetapi **ditulis ulang di `edit_v2`**, karena `media_features` bukan stdlib-only dan tidak boleh diimpor dari `edit_v2`.

### `resources/reframe/rules.v1.json` (baru)

Semua angka ditulis **oleh sweep RF-M1/RF-M4** (§A9), bukan oleh dokumen ini. Kunci (semua bilangan bulat):

`cut.coarse_scene_pm`, `cut.refine_diff_pm`, `cut.min_gap_ms`, `scan.timeout_s`, `face.present_pm`, `face.small_w_pm`, `face.centre_pm`, `speakers.active_pm`, `speakers.split_share_pm`, `motion.still_pm`.

`rules_id` = 16 hex pertama sha256 byte kanonik file. Mengubah file = `rules_id` baru = plate key auto baru (tidak menyentuh plate key non-auto).

## A6. Kontrak dokumen `layout.ranges` (CONTRACTS §5.63, amandemen minor-0)

Ditetapkan di PR kontrak Fase 0 (KA6). Server lama menolak dokumen baru dengan `unknown_key`/`range_invalid` (§3.8), jadi tidak ada `schema_minor` baru.

**Perubahan tabel §3.3:**

| Path | Nilai | Aturan |
|---|---|---|
| `layout.default.mode` | tambah `auto` | `auto` wajib punya `layout.ranges` dan `base.shots`. `no_face` tetap ada dan dipakai untuk range `camera` (§5.40). |
| `layout.ranges` | opsional; 1–200 `{in_sf, out_sf, mode, origin, split_xy?}` | Lihat aturan di bawah. Seed non-auto tidak pernah menulisnya. |
| `base.shots` | `{sha256}` | Wajib bila `layout.default.mode = auto`; menunjuk `shots.<sha16>.json`. Hilang → `analysis_missing` (`ref="shots"`). |
| `layout.split` | sekarang juga boleh bersama `auto` | Bila ada range `split`: wajib, dan hanya `top_pm`, `top.zoom_pm`, `bottom.zoom_pm` yang dipakai; `x_e5`/`y_e5` diambil dari `split_xy` per range. |

**Aturan validasi (`doc.py _Validator`, kode yang sudah ada):**

| # | Aturan | Kode, path |
|---|---|---|
| V1 | `ranges` mempartisi `window_sf = [sf_floor(window_ms[0]), sf_ceil(window_ms[1])]`: range pertama mulai di `window_sf[0]`, terakhir berakhir di `window_sf[1]`, bersambung tanpa celah/tumpang, `in_sf < out_sf` | `range_invalid`, `/layout/ranges/<i>` |
| V2 | Kanonik: dua range bertetangga tidak boleh punya `(mode, origin, split_xy)` sama | `range_invalid`, `/layout/ranges/<i>` |
| V3 | `mode ∈ {camera, fill_center, fit_blur}`; `split` hanya bila `origin = "auto"` **dan** `AUTO_SPLIT` (`edit_v2/__init__.py`, baru, `False` sampai spike lolos) | `range_invalid`; split saat `AUTO_SPLIT = False` → `op_disabled` |
| V4 | `origin ∈ {auto, user}` | `range_invalid` |
| V5 | `layout.default.mode = split` + `ranges` | `range_invalid`, `/layout/ranges` |
| V6 | `layout.default.mode = auto` tanpa `ranges` | `range_invalid`, `/layout/ranges` |
| V7 | `layout.default.mode ∈ {camera, fill_center, fit_blur}` + `ranges`: setiap range `origin:"auto"` wajib ber-`mode` = `default.mode` (range user saja yang berbeda) | `range_invalid` |
| V8 | `layout.keyframes` + `ranges` | `range_invalid`, `/layout/keyframes` **(default, bisa diubah)**: tetap dilarang di v1 termasuk F4b. Akibatnya tombol "Lihat sumber" untuk shot disembunyikan selama `ranges` ada (06 §5.2). Pelonggaran untuk range `camera` = amandemen §5.63 tersendiri, bukan bagian rencana ini. |
| V9 | `split_xy` hanya pada range `split`; nilai 0–100000 | `range_invalid` |

**Kanonisasi (client dan server, fungsi sama):** `canonical_ranges(ranges)` menggabungkan tetangga yang sama; kalau `default.mode ≠ auto` dan semua range `origin:"auto"`, `ranges` dihapus. Dokumen tanpa `ranges` → kompiler memakai jalur hari ini **byte-identik**.

**Analisis ulang (`shots.merge_user_ranges(new_auto, old)`, Python, mirror JS `web/lib/editor/shots.mjs` dengan vektor `tests/fixtures/edit_v2/shot-vectors.json`):**
1. Mulai dari partisi `new_auto` (semua `origin:"auto"`).
2. Untuk tiap range lama `origin:"user"` (urut `in_sf`): potong ke `window_sf`; kalau kosong dibuang; kalau tidak, timpa partisi pada `[in_sf, out_sf)` (range auto dipotong di tepinya).
3. `canonical_ranges`.
Range user **tidak pernah** ditimpa analisis ulang. Diuji di vektor: user di tengah shot, user melewati batas shot baru, user di luar jendela baru, jendela menyusut.

**Apply-all (§5.53):** hari ini `apply_all.copied_part(doc, "layout")` menyalin seluruh `layout` kecuali `keyframes` (`src/ai_clipper/edit_v2/apply_all.py`; mirror `web/lib/editor/apply-all.mjs`). Perubahan: `copied_part` juga membuang `ranges`. `split_xy` ikut terbuang karena hanya ada di dalam `ranges`. `layout.split` tetap disalin seperti hari ini. `with_part` untuk sumber `default.mode = "auto"`:
- target **punya** shot plan siap (`shots.<sha16>.json` untuk jendela target): `ranges` = range auto dari shot plan target, ditambah range `origin:"user"` target yang lama lewat `merge_user_ranges`, lalu `base.shots` target. Satu revisi.
- target **belum** punya shot plan: dokumen target tidak diubah dulu. Batch record mencatat target `pending_analysis` (bukan "dilewati"), lalu klien memanggil `POST …/clips/<target>/prepare {layout:"auto"}` (Q10 default: mengantrekan analisis). Setelah `shots: "ready"`, klien yang sama menerapkan revisi seperti butir pertama. Kalau tab ditutup sebelum selesai, entri `pending_analysis` tetap di batch record dan diteruskan saat editor dibuka lagi (`draft-store.mjs`). Analisis gagal → target dicatat `failed` dengan kode `analysis_missing`.
- Tes: `tests/test_edit_v2_apply_all.py` (ranges tidak disalin, auto → ranges target), `web/tests/editor-apply-all.test.mjs` (`pending_analysis` → diterapkan), e2e `web/e2e/editor-apply-all.spec.mjs` (diperluas).

**Command editor (`web/lib/editor/commands.mjs`, merge key `layout`):**

| Command | Payload | Efek | Fase |
|---|---|---|---|
| `SetLayout` (ada) | `{mode: "auto"}` ditambahkan | Butuh shot plan; tanpa itu panel memulai analisis (`prepare`), command dikirim setelah siap (pola `layout-analysis.mjs` hari ini) | RF-M5a |
| `SetShotMode` (baru) | `{in_sf, out_sf, mode ∈ {camera, fill_center, fit_blur}}` | Range itu jadi `origin:"user"`; `kanonisasi` | F4b |
| `ResetShot` (baru) | `{in_sf, out_sf}` | Range user di rentang itu kembali ke range auto dari shot plan | F4b |
| `ResetAllShots` (baru) | `{}` | Semua range user dihapus ("Kembali ke otomatis") | F4b |

Semantik (dokumen ini pemilik; 06 §11.5 memakainya apa adanya):
- `SetShotMode`/`ResetShot`: `[in_sf, out_sf)` wajib sama persis dengan satu entri `shots` di shot plan `base.shots` yang dimuat klien (batas shot asli, bukan range hasil gabung). Tidak cocok, shot plan belum dimuat, atau rentang di luar `window_sf` → `CommandRejected("shot_not_found")`.
- `SetShotMode` dengan `mode ∉ {camera, fill_center, fit_blur}`, atau dokumen ber-`layout.default.mode = split` (V5) → `CommandRejected("shot_mode_invalid")`.
- `ResetShot` pada shot yang tidak punya range `origin:"user"` = no-op (tidak membuat revisi). `ResetAllShots` tanpa range user = no-op.
- Setiap command diakhiri `canonical_ranges` (V1, V2), jadi hasilnya selalu partisi kanonik.

Kode error command baru di `COMMAND_MESSAGES` (`web/lib/editor/commands.mjs`, domain `editor.*`, 07 §10.2): `shot_not_found`, `shot_mode_invalid`. `messageId` = `editor.<kode>`, kunci katalog `errors.editor.<kode>` di `web/messages/{id,en}/errors.json`.

## A7. Kompiler dengan jumlah konteks filter tetap

### A7.1 Tanpa split (wajib, RF-M2)

`_Compiler.layout(self, label_in, ranges, label_out, suffix)` (`src/ai_clipper/edit_v2/compile_ffmpeg.py:431`) mendapat cabang baru **sebelum** cabang `keyframes`. Perhatikan bahwa parameter `ranges` di sana adalah rentang **piece** (source-grid) yang sudah ada. Karena itu properti baru di `RenderPlan` diberi nama **`layout_ranges`**, bukan `ranges`.

Perubahan `plan.py`:
- `RenderPlan.layout_ranges` (properti, tuple `(in_sf, out_sf, mode)`, `()` bila dokumen tanpa `layout.ranges`);
- `build_plan`: `used_camera = camera if layout in ("camera", "auto") else None`. Untuk `auto` tanpa camera plan padahal ada range `camera` → `AnalysisMissing(ref="camera")`. Warning `no_face` (`_no_face`) dihitung hanya atas frame range `camera`;
- `plan_sha256` mencakup `layout_ranges` hanya bila tidak kosong (sha plan non-auto tidak berubah).

```
if self.plan.layout_ranges:               # plan.py: properti baru, () bila tidak ada
    per output frame n (urut pieces → frame sumber s):
        r = range yang memuat s           # bisect atas in_sf; s di luar semua range → DocSemanticInvalid("range_invalid")
        mode[n] = r.mode
    crop[n]     = camera:      crop_positions(camera plan, …)[s]   (sama dengan cabang camera hari ini)
                  fill_center: centre_x(picture, output, zoom)     (konstan)
                  fit_blur:    centre_x(…)                         (tidak terlihat; mengikuti §5.40)
    fallback[n] = mode[n] == "fit_blur"
                  or (mode[n] == "camera" and no_face == "fit_blur" and no_face_frames(...)[s])
    return layouts.layout_chain("camera", crop=crop, fallback=fallback, ...)
```

- Ini memakai ulang `_fallback_chain` (§5.40) apa adanya: **satu** rantai fit-blur dengan tiga saklar `if(lt(n,K),A,B)` seimbang. Jumlah konteks filter = konstan (sama dengan rantai camera+fallback hari ini) untuk 1, 8, atau 48 range.
- `all(fallback)` → rantai fit_blur murni; `not any(fallback)` → rantai camera murni (perilaku `layout_chain` hari ini).
- **Ekuivalensi `fill_center`:** frame `fill_center` dirender sebagai crop camera dengan x = `centre_x`. Spike RF-M2 wajib membuktikan md5 frame ini sama dengan rantai `fill_center` murni (P-FRAME). Kalau berbeda (mis. `crop_y`), kompiler menambah saklar keempat untuk y; jumlah konteks tetap konstan.
- Camera plan dimuat bila ada range `camera` (`render_edit._load_camera` diperluas: dipanggil untuk `auto` juga).

### A7.2 Dengan split (hanya kalau spike lolos → `AUTO_SPLIT = True`)

Kandidat yang diuji spike `scripts/parity/auto_graph_spike.py` (baru):

| Kandidat | Graf | Konteks tambahan |
|---|---|---|
| K1 overlay | `[vcat]split=2[a][b]`; `[a]` → rantai fallback A7.1; `[b]` → `split_chain` dengan crop x/y per frame (ekspresi `if(lt(n,K))` seperti crop camera); `[A][B]overlay=enable='<frame split>'` | 1 split + 1 rantai split + 1 overlay |
| K2 streamselect | sama, tapi `streamselect` dengan `sendcmd` per batas range | 1 split + 1 rantai split + 1 streamselect + sendcmd |
| K3 maskedmerge | sama, tapi `maskedmerge` dengan mask hitam/putih berbasis `n` | 1 split + 1 rantai split + 1 maskedmerge + 1 sumber mask |
| K0 (pembanding) | concat K rantai (satu per run) | tumbuh dengan K — hanya baseline |

**Kriteria lolos spike (semua wajib, pada 1, 8, dan 48 run):**
1. md5 setiap frame = rantai murni mode itu (P-FRAME 0 mismatch);
2. render jalan di bawah `RLIMIT_AS` 3 GiB (R8, `src/ai_clipper/edit_v2/execute.py RLIMIT_AS_BYTES = 3 << 30`, dipasang lewat `prlimit`) tanpa gagal alokasi, dan RSS puncak anak (`ru_maxrss` dari `os.wait4`) < 3 GiB pada 48 run, untuk sumber 1080p dan 720p;
3. jumlah konteks filter (hitung `-filter_complex` node) **tidak tumbuh** dari 1 ke 48 run;
4. waktu render ≤ 1,15× rantai fallback tanpa split.

Kandidat pertama yang lolos (urutan K1, K2, K3) dipakai. Tidak ada yang lolos → `AUTO_SPLIT` tetap `False`, aturan #2 di §A5 jatuh ke `camera`, dan RF-M4 hanya menyetel group framing. Hasil spike ditulis di `docs/editor/SPIKES.md` (bagian baru "Graf Otomatis").

### A7.3 Pin dan key

- `RENDER_SEMANTICS` tetap 2 (`src/ai_clipper/edit_v2/__init__.py`).
- Semua graf, plan sha, dan `plate_key` dokumen non-auto dipin tidak berubah (`tests/test_edit_v2_compile.py`, `tests/test_edit_v2_plates.py`).
- `plates.plate_key` mendapat input `shots_sha256` **hanya** bila `layout.default.mode = auto` atau `ranges` ada (dict tambahan hanya ditulis saat ada → key non-auto identik).
- `RenderPlan.shots_for(sf) -> str` (baru, `plan.py`) dipakai preview lane dan editor (strip shot) untuk menjawab mode per frame tanpa membangun graf.
- Validator: `doc.py _ROOT` mendapat `base.shots = _keys("sha256")` dan `layout.ranges`; `_LAYOUT_MODES[0]` mendapat `"auto"`. Image lama melihat `auto` → `range_invalid` dan `base.shots` → `unknown_key` (sesuai §A6, tanpa `schema_minor` baru).

## A8. Engine, job, dan UI

### A8.1 Opsi job dan CLI

| Tempat | Perubahan |
|---|---|
| `web/lib/jobs.mjs` | `RENDER_MODES` tetap tiga untuk validasi **pembuatan** saat flag `off`; tambah `"auto"` saat `POTONGIN_AUTO_REFRAME=on`. `validatePersistedJobOptions` **selalu** menerima `"auto"` (job lama tetap terbaca setelah flag dimatikan). |
| `web/lib/layout-names.mjs` | `LAYOUT_NAMES.auto = "Otomatis"`; `RENDER_MODE_LAYOUTS.auto = "auto"`. Sejak i18n M3 label berasal dari kunci `layout.names.*`. |
| `web/lib/dashboard-choices.mjs` | `LAYOUT_CHOICES` mendapat `{id: "auto"}` di **urutan pertama** hanya bila flag `on` (fungsi `layoutChoices({autoReframe})`, baru). Default pilihan tidak berubah: `DEFAULT_CHOICES.renderMode = "fit-blur"` (Latar blur; opt-in, Q10). Pilihan tersimpan di browser `renderMode: "auto"` saat flag `off` → `pick()` jatuh ke default (tes di `web/tests/dashboard-choices.test.mjs`). Layar terbagi tidak pernah ada di Buat klip (KA11). |
| `src/ai_clipper/render.py` | `RENDER_MODES` tidak berubah (legacy). |
| `src/ai_clipper/cli.py` | `--render-mode` menerima `auto` (pilihan = `RENDER_MODES + ("auto",)`); `auto` dengan engine legacy → render `fit-blur` + warning `engine_fallback`. |
| `src/ai_clipper/pipeline.py` | Setelah seleksi V3, per klip `prepare_auto` (stage code `reframe`, laporan `report("reframe", 70, …)`; i18n `stage.reframe`). Gagal analisis per klip → klip itu di-seed `fit_blur` + warning `auto_reframe_failed:<index>`; job tidak gagal. |
| `src/ai_clipper/edit_v2/seed.py` | `LAYOUT_BY_RENDER_MODE` (`seed.py:147`) mendapat `"auto": "auto"`. `renderMode auto` → `layout.default.mode = "auto"`, `no_face = "fit_blur"`, `ranges` dari shot plan (`origin:"auto"`), `base.shots.sha256`, `base.camera.sha256`. Mode lain: byte seed tidak berubah (dipin). |
| `src/ai_clipper/edit_v2/preview_cli.py` | Op `prepare` menerima `layout: "auto"` → `{words, camera, shots: "ready"|"building"|"failed"}`. |
| `web/app/api/jobs/[id]/clips/[clipId]/prepare/route.js` | Body `{layout: "auto"}` diterima bila flag `on`. Flag `off` → 404 dengan body dan header **identik** dengan 404 lain di route itu, yaitu keluarga `edit` (02 §7.4: `{"error":"Data tidak ditemukan","code":"not_found","messageId":"edit.not_found"}`, KA13), supaya fitur mati tidak terlihat. Pengecualian: dokumen yang **sudah** `auto` (floor) tetap boleh `prepare {layout:"auto"}` untuk analisis ulang. |
| `web/lib/camera-progress.mjs` | Respons tambah `phase: "camera"|"shots"`; file progres yang sama (`preview/camera.progress.json`), `total` = sampel camera + jumlah kandidat cut. |

### A8.2 POST `/api/jobs` (`web/app/api/jobs/route.js`)

- Field form `renderMode=auto`:
  - flag `on` → diterima, disimpan apa adanya;
  - flag `off` → `400 {error: "<id>", code: "auto_reframe_off", messageId: "web.auto_reframe_off"}`.
- Kode `auto_reframe_off` dan `auto_reframe_needs_v3` didaftarkan di `web/lib/error-codes.mjs` (baru, i18n M2, domain `web.*`, 07 §10.2) dengan kunci katalog `errors.web.<kode>` (= `"errors." + messageId`, 07 §7.2) di `id` dan `en`. Catatan: job baru selalu `CURRENT_SELECTION_MODE` (`v3`, `web/lib/jobs.mjs`), dan `selectionMode` lain sudah ditolak lebih dulu. `auto_reframe_needs_v3` dipertahankan sebagai pertahanan berlapis dan praktis tidak pernah tampil.
- `selectionMode ≠ v3` + `auto` → `400 {code: "auto_reframe_needs_v3", messageId: "web.auto_reframe_needs_v3"}`.

### A8.3 UI (label, bukan kalimat; semua bahasa)

| Tempat | Fase | Isi | Klik |
|---|---|---|---|
| Buat klip, chip **Tata letak** | 7 | Pilihan: Otomatis · Ikuti wajah · Potong tengah · Latar blur. Tidak ada deskripsi panjang. | 2 (chip → pilih) |
| Halaman proyek, kartu klip | 7 | Chip mode: "Otomatis". | 0 |
| Editor lama, kartu/panel Tata letak (RF-M5a) | 7 | Kartu "Otomatis" bergambar; progres analisis + "Coba lagi"; "Pakai di semua klip". | 1–2 |
| Editor baru, tab **Tata letak** (F4b; komponen dan tata letaknya milik [06-editor.md](06-editor.md) §8.2 dan §11.5, baris ini hanya merangkum) | 11 | Satu layout editor, panel kanan satu tab terbuka (Q1). Pilihan dasar terlihat: 5 kartu bergambar (Otomatis, Ikuti wajah, Potong tengah, Latar blur, Layar terbagi). Strip shot (RAC `GridList`, dependensi `react-aria-components` langsung, sesuai 06 Q2): tiap shot = thumbnail + mode efektif; tanda "Tanpa wajah" (`rf_no_face`) dan "Diubah" (`origin:user`). Klik shot → seek + `ShotPopover` (HeroUI `Popover`) berisi HeroUI `Select` (Ikuti wajah, Potong tengah, Latar blur) dan `Button` **Otomatis**. Ganti mode satu shot: shot → Select → opsi = **3 klik di dalam tab** (4 termasuk membuka tab; 06 #54). Kembalikan satu shot: shot → Otomatis (2 klik di dalam tab; 06 #55 = 3). "Kembali ke otomatis" (seluruh klip) ada di disclosure **Lanjutan** tab itu, dengan ringkasan di kepalanya, mis. "Lanjutan · 2 shot diubah" (06 §8.2). Strip hanya tampil bila mode bukan Layar terbagi dan ada ≥ 2 shot; kalau tidak, strip disembunyikan, bukan dinonaktifkan (06 aturan 6). | ≤ 3 di dalam tab |

Kunci i18n baru, ditulis di katalog per folder `web/messages/{id,en}/<namespace>.json` (07-i18n.md §2.2 "satu katalog per locale = satu folder"; **id dan en sekaligus**, karena `i18n-error-codes` dan tes kelengkapan locale menolak kunci yang hanya ada di satu locale). Namespace: `editor.layout`, `layout.names`, `stage`, `errors.*`. Label chip Buat klip (`dashboard.layout.auto`) dan kata yang tampil di dashboard milik [05-ui-dashboard.md](05-ui-dashboard.md) §6.3; dokumen ini tidak mendefinisikannya ulang. Kunci: `layout.names.auto` (dipakai `web/lib/layout-names.mjs`, 05 §6.3), `editor.layout.shots`, `editor.layout.shotNoFace`, `editor.layout.shotChanged`, `editor.layout.shotAuto`, `editor.layout.resetAll`, `editor.layout.summary.shotsChanged` (`{count, plural, …}`; item ringkasan Lanjutan lewat `advancedSummary` dan `editor.advanced.summary`, 06 §2.2 butir 3 dan §8.2), `stage.reframe`, `errors.web.auto_reframe_off`, `errors.web.auto_reframe_needs_v3`, `errors.editor.shot_not_found`, `errors.editor.shot_mode_invalid`. Kode alasan `rf_*` **tidak** ditampilkan sebagai teks (hanya `rf_no_face` → "Tanpa wajah").

### A8.4 Rollback dan floor

- **Release 1 (RF-M3, Fase 6):** validator, kompiler, seed, CLI, dan render `auto` ada; flag `off`. Ini **floor**: image rollback ke release 1 atau lebih baru aman untuk dokumen `auto`.
- **Release 2 (RF-M6, Fase 7):** flag `on` (opt-in di UI).
- **Rollback di bawah floor:** `scripts/ops/auto_layout_downgrade.py` (baru):
  - argumen: `--jobs-root <path>` (wajib), `--apply` (tanpa itu dry-run), `--job <uuid>` (opsional, berulang);
  - per dokumen tersimpan (`edit_v2/store.py`) dengan `mode = auto`: tulis revisi baru `mode = fit_blur`, hapus `ranges`, `base.shots`, `split_xy`; `audit.last_command = "Downgrade"`;
  - `job.json options.renderMode = "auto"` → `"fit-blur"` di bawah queue lock;
  - file otomatis (R10) yang sudah ada **tidak dihapus**;
  - output: satu baris JSON per perubahan + ringkasan; exit 0/1;
  - tes `tests/test_auto_layout_downgrade.py`: dry-run tidak menulis apa pun; apply idempoten; dokumen non-auto tidak tersentuh; menolak symlink dan path di luar `--jobs-root`.

## A9. Ambang dari sweep dev-split

**Data (RF-M0):**
- ±40 jendela 120 dtk dari sumber berlisensi terbuka yang dicatat di `docs/evaluation/TRAINING_SOURCE_REGISTRY.json` (lisensi, URL, tanggal akses). Komposisi target: 10 satu pembicara, 10 podcast dua orang, 8 panel ≥ 3 orang, 6 layar/slide, 6 campuran gameplay/b-roll.
- Dibagi **dev 20 / test 20** sebelum label dilihat (seed acak tercatat). Test split dikunci: hanya dijalankan sekali di RF-M4.
- Label per jendela (`labels.<split>.json`): `cuts_sf` (grid dokumen) dan mode yang benar per shot (`camera|fill_center|fit_blur|split`). Label dev ditulis implementer; label test ditulis **pemilik** (Q10, ±60–90 menit) lewat halaman bantu `scripts/eval/auto_reframe.py --label` (HTML lokal statis, bukan rute app).

**Sweep (`scripts/eval/auto_reframe.py --sweep --split dev`):**

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

- **Tahap 1 (cut):** pilih `cut.*` yang memaksimalkan F1 dengan syarat P ≥ 0,95 dan R ≥ 0,90 (±1 frame). Seri → `min_gap_ms` lebih besar, lalu `coarse_scene_pm` lebih besar.
- **Tahap 2 (mode):** dengan cut terkunci, pilih kunci lain yang memaksimalkan **agreement** = porsi frame dengan mode = label. Seri → konfigurasi dengan lebih sedikit frame non-`camera`.
- Hasil, grid lengkap, dan alasan pilihan ditulis di `docs/evaluation/AUTO_REFRAME.md`; nilai final ke `rules.v1.json`. Grid ini adalah ruang cari Potongin, bukan konstanta dari proyek lain.

**Gate (test split, satu kali, RF-M4):**
- agreement ≥ 85%;
- set `multi` SPEAKER_FRAMING (`scripts/eval/speaker_framing.py`, metrik yang sama dengan `docs/evaluation/SPEAKER_FRAMING.md`, hari ini 20,7%) ≤ 21,7% pada frame `camera`;
- pemilik menerima ≥ 8 dari 10 klip `split` (kalau `AUTO_SPLIT = False`: 10 klip Otomatis acak).
Gagal → nilai tidak dilonggarkan; ulang tahap 2 di dev dengan fitur evidence tambahan, lalu test split **baru** (jendela baru) — tercatat.

## A10. Gate dan tes reframe

| Gate | Isi | Milestone |
|---|---|---|
| Pin | byte camera plan di semua fixture dan `camera_real`; graf/plan sha/plate key non-auto; seed non-auto; `RENDER_SEMANTICS` 2 | RF-M1, RF-M2, RF-M3 |
| Cut | P ≥ 0,95 / R ≥ 0,90 ±1 frame (dev) | RF-M1 |
| Scan | ≤ 15 dtk + 0,5 dtk/cut (CI) | RF-M1 |
| Graf | spike §A7.2; konteks konstan 1/8/48 run; RSS < 3 GiB | RF-M2 |
| P-FRAME | fixture `cfr_30_auto`, `cfr_2997_auto`, `auto_keyframes` (harus `range_invalid`), `auto_zoom_content`, `auto_split` (bila `AUTO_SPLIT`), plus 2 dan 3 range campuran: 0 mismatch di CPU 1 dan 4 | RF-M2, RF-M6 |
| P-PLATE | crop x 0 px beda antara plate cell dan render final | RF-M6 |
| P-JOIN-B | batas range jatuh di batas piece dan di tengah piece | RF-M6 |
| G-DET | dua render berturut sama byte, CPU 1 dan 4 | RF-M6 |
| PF-RENDER | render auto p50 ≤ 0,4× real time | RF-M6 |
| PF-PIPELINE | delta CPU job dan waktu job auto vs fit-blur dilaporkan (syarat keputusan default, Q10) | RF-M6 |
| Kualitas | agreement ≥ 85%, SPEAKER_FRAMING ≤ 21,7%, ≥ 8/10 diterima | RF-M4 |
| Editor | `origin:user` bertahan setelah analisis ulang dan apply-all (vektor + e2e); S-COLOR dengan 2–3 range | RF-M5a, F4b |
| Downgrade | `tests/test_auto_layout_downgrade.py` | RF-M3 |

Unit tes per modul (semua baru kecuali disebut): `test_edit_v2_shot_cuts.py` (fixture sintetis: cut keras, fade 12 frame, flash, VFR; FFmpeg gagal → fallback `scene_cuts` → `none`), `test_shot_context.py` (ringkasan dari sampel buatan), `test_edit_v2_shots.py` (setiap baris tabel §A5, gabung shot pendek, kanonisasi, `merge_user_ranges`, round-trip file), `test_edit_v2_doc.py` (V1–V9), `test_edit_v2_compile.py` (cabang ranges: tidak ada konteks baru; ranges kosong = jalur lama).

---

# Bagian B — Unduhan sumber

## B1. Alur dan state machine job link

Hari ini: `web/scripts/run-job.mjs` (`main`, cabang `job.source.type === "youtube"`) mengunduh dengan `buildVideoDownload` lewat `runFencedProcess`, lalu (V3) subtitle YouTube, lalu engine. Rancangan baru mempertahankan proses itu sebagai jalur **flag mati** (argv identik, dipin snapshot) dan menambah fase `fetch`:

```
POST /api/jobs (sourceUrl) ── parseSourceUrl + assertPublicHost ──► 400 source_* | job queued
  ▼ primary-worker klaim (run-job.mjs)
[preflight]  yt-dlp -J (extractor allowlist, DNS-check) ──► gagal: failed + code
  ▼
[cache]      lookup scope user lalu umum ──► hit: hard link → [ready]
  ▼ miss
[audio]      (AUDIO_FIRST on & V3) unduh audio-only ──► engine mulai (--analyze-audio)
  ║ paralel
[video]      unduh bv*+<idAudio> → ffprobe allowlist → A/V cek → simpan ke cache
  ▼
[ready]      tulis input/.fetch/source-ready.json ──► engine lanjut ke tahap visual
  ▼ (gagal video) tulis source-failed.json → engine berhenti → job failed + code
```

**Field baru `job.fetch`** (ditulis worker, dibaca UI; aditif, image lama mengabaikan):

```json
{
  "phase": "preflight|cache|audio|video|ready|failed",
  "platform": "youtube|twitch|kick",
  "sourceKey": "youtube:dQw4w9WgXcQ",
  "cache": "off|hit|miss|stored|skipped",
  "scope": "umum|user",
  "audioFirst": true,
  "durationMs": 3540000,
  "formats": {"audio": "140", "video": "136"},
  "fallback": null,
  "readyAt": "2026-10-24T10:00:00.000Z"
}
```

`fallback` ∈ `null | "no_audio_first" | "av_offset" | "cache_exdev"`. Tidak ada URL proxy, cookie, path absolut, atau stderr mentah di field ini.

**Stage code (i18n `stage.*`, KA19/M5):** `fetch_preflight`, `fetch_audio`, `fetch_video`, `fetch_cache_hit`, `fetch_wait_video` (engine menunggu video). Dashboard menampilkan satu label per tahap ("Memeriksa link", "Mengunduh audio", "Mengunduh video", "Dari cache").

## B2. Milestone dan file

| Milestone | Fase | File baru | File diubah | Hari |
|---|---|---|---|---|
| FETCH-M0 | 0 | `docs/evaluation/UNDUHAN_M0.md`, `scripts/fetch/m0_measure.py` | — (suite `command` yang ada di `.github/workflows/editor-gates.yml` dipakai apa adanya) | 3 |
| MU-M4b (sumber) | 6 | `web/lib/source-url.mjs`, `src/ai_clipper/fetch/__init__.py`, `src/ai_clipper/fetch/platforms.py`, `tests/fixtures/fetch/urls.json`, `web/tests/source-url.test.mjs`, `tests/test_fetch_platforms.py` | `web/lib/jobs.mjs` (`normalizeYouTubeUrl` mendelegasi), `web/lib/dashboard-view.mjs` (hapus `YOUTUBE_HOSTS` ganda, pakai `source-url.mjs`), `web/scripts/run-job.mjs` (`--use-extractors`), `scripts/security/route_matrix.py` | 1 dari 4 |
| FETCH-M1 | 7 | `web/lib/fetch-args.mjs`, `web/lib/fetch-plan.mjs`, `src/ai_clipper/fetch/probe.py`, `web/tests/{fetch-args,fetch-plan,source-type-guard}.test.mjs`, `tests/test_fetch_probe.py` | `web/lib/primary-job-queue.mjs` (baris 816), `web/scripts/run-job.mjs`, `web/app/api/jobs/route.js`, `web/lib/{jobs,clip-library,source-language,project-view,dashboard-view,stage-summary,download-errors,help-catalog}.mjs`, `web/app/dashboard/page.jsx`, `web/app/projects/[id]/page.jsx` | 4 |
| FETCH-M2 | 7 | `web/lib/media-cache.mjs`, `web/lib/media-cache-lock.mjs`, `web/app/api/admin/cache-unduhan/route.js`, `web/app/api/admin/cache-unduhan/clear/route.js`, `web/tests/{media-cache,media-cache-lock,media-cache-routes}.test.mjs` | `web/scripts/primary-worker.mjs` (sweep), `web/lib/{system-info,system-info-view,storage-status-dto}.mjs`, `docs/operations/STORAGE_RETENTION.md` | 5 |
| FETCH-M3 | 7 | `src/ai_clipper/fetch/cache.py`, `src/ai_clipper/fetch/handshake.py`, `tests/test_fetch_cache.py`, `tests/test_fetch_handshake.py`, `tests/test_pipeline_audio_first.py` | `src/ai_clipper/{cli,pipeline,transcribe,transcribe_groq,audio_timeline,youtube_captions}.py`, `web/scripts/run-job.mjs` | 6 |
| FETCH-M4 | 7 | fixture `tests/fixtures/fetch/twitch-*.json` | `source-url.mjs`, `platforms.py`, `fetch-args.mjs`, `download-errors.mjs` | 3 |
| FETCH-M5 | 7 (kalau go) | fixture `tests/fixtures/fetch/kick-*.json` | sama dengan M4; `pyproject.toml`/`uv.lock` bila `curl_cffi` disetujui | 2 |
| FETCH-M6 | 7 | `web/lib/download-network-settings.mjs`, `web/lib/download-network-view.mjs`, `web/app/api/settings/download-network/route.js`, `web/tests/{download-network-settings,download-network-routes,proxy-redaction}.test.mjs` | `compose.yaml` (service `pot-provider`, profil `pot`), `pyproject.toml` + `uv.lock` (plugin bgutil), `web/lib/sealing.mjs` (purpose `download-network`), `web/app/settings/page.jsx` (tab Sistem, admin) | 5 |
| FETCH-M7 | 7 | `web/lib/db/migrations/0004-download-ledger.sql`, `web/lib/download-ledger.mjs`, `web/tests/download-ledger.test.mjs` | `web/scripts/run-job.mjs`, halaman `/admin/job` | 3 |
| FETCH-M8 | 7 | — | `.github/workflows/ytdlp-update.yml`, `scripts/ytdlp/ytdlp_smoke.py`, `tests/test_ytdlp_smoke.py`, `tests/test_ytdlp_update_workflow.py` | 2 |
| FETCH-M10 | 7 | `docs/operations/UNDUHAN_SUMBER.md` (rename dari `UNDUHAN_YOUTUBE.md`, `git mv`) | `docs/operations/{TRANSCRIPTION,PROGRES_JOB,BANTUAN}.md`, `.env.example`, `compose.yaml` | 3 |
| FETCH-M9 | 12 | lihat §B11 | | 12 |

Semua file di kolom "baru" ditandai **(baru)**; semua di kolom "diubah" sudah ada kecuali `web/lib/sealing.mjs`, `web/lib/db/*`, dan halaman `/admin/job`, yang dibuat di MU-M1/MU-M4/MU-M5 (dokumen multi-user).

## B3. URL allowlist (`web/lib/source-url.mjs` + `src/ai_clipper/fetch/platforms.py`, keduanya baru)

Inti modul ini dibangun di **MU-M4b (Fase 6)** sesuai [02-multiuser-keamanan.md](02-multiuser-keamanan.md) §11.4 (KA3). API dan kode error di bawah **sama dengan 02 §11.4**. Dokumen ini hanya menambah bagian Fase 7 (FETCH-M1/M4/M5), yang ditandai **[F7]**.

### B3.1 API

```js
// web/lib/source-url.mjs — parse tanpa I/O (client-safe); assertPublicHost hanya server
export const PLATFORMS = Object.freeze({
  youtube: { hosts: YOUTUBE_HOSTS, extractors: ["youtube"] },                 // MU-M4b
  twitch:  { hosts: TWITCH_HOSTS,  extractors: [/* dikunci FETCH-M0 */] },     // [F7] M4
  kick:    { hosts: KICK_HOSTS,    extractors: [/* dikunci FETCH-M0 */] },     // [F7] M5
});
export class SourceUrlError extends Error { code }          // code ∈ kode §B13
export function parseSourceUrl(text, { platforms = ["youtube"] } = {})
//   → { platform, kind: "video"|"clip"|"vod", mediaId, url /* kanonik */, sourceKey }  | throw SourceUrlError
export async function assertPublicHost(url, { lookup = dns.promises.lookup } = {})   // throw SourceUrlError("source_private_address")
export function isLinkSource(source)      // [F7] true untuk {type:"youtube"} dan {type:"link"}
export function linkUrlOf(source)         // [F7] url tersimpan atau null
export function sourceKeyOf(source)       // [F7] "platform:mediaId" atau null
```

`kind` dan `sourceKey` sudah dikembalikan sejak MU-M4b (aditif terhadap 02 §11.4; 02 cukup memakai `platform`, `url`, dan `mediaId`). `platforms` default `["youtube"]`. App memanggilnya dengan daftar platform yang flag-nya menyala (`readFetchFlags`). Nama `linkUrlOf` sengaja tidak `sourceUrlOf`, karena `web/lib/clip-library.mjs:60` sudah punya fungsi privat `sourceUrlOf(job)`.

`src/ai_clipper/fetch/platforms.py` mengekspor `parse_source_url(text, platforms) -> dict` dan `SourceUrlError(code)` dengan bentuk dan kode yang sama. **Paritas:** `tests/fixtures/fetch/urls.json` (baru) berisi ≥ 60 kasus `{input, platforms, expect: {…} | {error: code}}`, dibaca `web/tests/source-url.test.mjs` dan `tests/test_fetch_platforms.py`. Kasus wajib: semua bentuk di tabel B3.2, `http://` (di-upgrade), userinfo `https://a@youtube.com/…`, port `:443` (diterima) dan `:8443` (ditolak), IP literal (v4, v6, desimal `https://2130706433/`), host mirip (`youtube.com.evil.test`, punycode `xn--`), panjang > 2048, spasi/kontrol, fragmen, `music.youtube.com`, `m.youtube.com`, `list=` (dibuang), `/@kanal` dan `/channel/…` (ditolak).

### B3.2 Aturan

Umum (02 §11.4): skema `https` (`http` di-upgrade ke `https`); tanpa userinfo; port kosong atau 443; hostname cocok **persis** dengan `PLATFORMS[p].hosts` (huruf kecil); panjang ≤ 2048; tanpa karakter kontrol atau spasi. Query dibuang kecuali parameter yang disebut. Pelanggaran → `source_host_not_allowed`. Bentuk path yang tidak dikenal, playlist murni, atau kanal → `source_rejected_kind`. Platform dikenali tapi flag-nya mati → `source_platform_off` **[F7]**.

| Platform | Host | Bentuk diterima → `url` kanonik | `mediaId` | Flag |
|---|---|---|---|---|
| youtube | `youtu.be`, `youtube.com`, `www.youtube.com`, `m.youtube.com`, `music.youtube.com` (`YOUTUBE_HOSTS` yang ada di `web/lib/jobs.mjs:989`) | `/watch?v=ID`, `youtu.be/ID`, `/shorts/ID` → `https://www.youtube.com/watch?v=ID` (`t` dibuang; `list` dibuang). `/live/ID`: **MU-M4b menolak** (`source_rejected_kind`, 02 §11.4); **[F7] FETCH-M1 menerima** sebagai `video`, karena preflight (§B4) menolak siaran yang masih/akan berlangsung (`source_live`) dan menerima rekaman siaran yang sudah selesai. `/@…`, `/channel/…`, `/c/…`, `/playlist` → `source_rejected_kind` | `ID` `[A-Za-z0-9_-]{11}` | selalu |
| twitch **[F7]** | `www.twitch.tv`, `twitch.tv`, `m.twitch.tv`, `clips.twitch.tv` | `/videos/<digits>` → `https://www.twitch.tv/videos/<id>` (`vod`); `/<ch>/clip/<slug>` dan `clips.twitch.tv/<slug>` → `https://clips.twitch.tv/<slug>` (`clip`); `/<ch>` saja → `source_rejected_kind` | digits / slug `[A-Za-z0-9_-]{1,100}` | `POTONGIN_FETCH_TWITCH` |
| kick **[F7]** | `kick.com`, `www.kick.com` | `/<ch>/videos/<uuid>` (`vod`); `/<ch>/clips/<clip_id>` (`clip`); `/<ch>` saja → `source_rejected_kind` | uuid / id `[A-Za-z0-9_-]{1,100}` | `POTONGIN_FETCH_KICK` |

**Kompatibilitas penyimpanan:** `normalizeYouTubeUrl` hari ini menyimpan link `youtu.be`/`youtube.com` apa adanya. Untuk menjaga job lama dan image lama, job YouTube **baru** tetap menyimpan hasil `normalizeYouTubeUrl` (bukan `url` kanonik) di `source.url`; `url` kanonik hanya dipakai untuk argv yt-dlp dan `sourceKey`. `normalizeYouTubeUrl` diimplementasikan ulang di atas `parseSourceUrl` (output identik untuk semua kasus `web/tests/jobs.test.mjs` yang ada).

### B3.3 Skema `job.source` (CONTRACTS §5.64)

| Bentuk | Kapan ditulis | Pembaca |
|---|---|---|
| `{type: "youtube", url}` | YouTube, **selalu** (rilis ini dan seterusnya) | image lama dan baru |
| `{type: "link", platform: "twitch"\|"kick", url, mediaId}` | hanya Twitch/Kick, **hanya** di rilis setelah rilis yang bisa membacanya (R2) | image baru |
| `{type: "upload", name, size}` | tidak berubah | semua |

Rilis R1 (FETCH-M1) membaca kedua bentuk tetapi `parseSourceUrl` hanya menerima Twitch kalau flag `on`, dan flag baru dinyalakan di R2. Image lama hanya mempublikasikan `input/` bila `type === 'youtube'` (`primary-job-queue.mjs:816`), jadi urutan ini wajib.

**`isLinkSource()` di semua pembaca:** setiap pemeriksaan `type === "youtube"` / `type !== "youtube"` atas `job.source` di `web/` diganti `isLinkSource(job.source)`, atau dibiarkan dengan alasan tertulis. Daftar hari ini (grep 2026-10-24): `web/lib/primary-job-queue.mjs:816` (publikasi `input/` + rewrite `sourcePath`), `web/scripts/run-job.mjs:624` (cabang unduh), `web/lib/clip-library.mjs:61` (`sourceUrlOf`), `web/lib/source-language.mjs:22`, `web/lib/project-view.mjs:47`, `web/lib/dashboard-view.mjs:56` dan `:91` (`JOB_STEPS` langkah unduh), `web/app/projects/[id]/page.jsx:558` (tautan sumber). `web/app/dashboard/page.jsx:520` (`sourceType === "youtube"`) adalah state form, bukan `job.source`; field-nya diganti `sourceUrl` (§B8) dan baris itu masuk allowlist dengan alasan. `web/lib/stage-summary.mjs` hanya memuat label `"youtube-captions"` dan tidak perlu diubah. `web/lib/dashboard-view.mjs:200` (`YOUTUBE_HOSTS` salinan lokal) diganti impor dari `source-url.mjs`. **Guard CI** `web/tests/source-type-guard.test.mjs` (baru): grep `web/{app,lib,scripts,components}` untuk regex `(type|sourceType)\s*[!=]==\s*["']youtube["']`; setiap temuan di luar allowlist (path:pola + alasan per baris) → gagal.

### B3.4 Pertahanan di worker (MU-M4b + FETCH-M1)

- argv yt-dlp selalu memuat `--ignore-config`, `--no-playlist`, `--use-extractors <PLATFORMS[p].extractors>`, `--max-filesize <MAX_UPLOAD_BYTES>` (MU-M4b, 02 §11.4), dan `--js-runtimes node` (sudah ada di `buildVideoDownload`/`buildCaptionDownloads`, `web/scripts/run-job.mjs:192`, `:285`). Nama extractor (mis. `youtube`, `twitch:vod`, `twitch:clips`, `kick:vod`, `kick:clips`) **diverifikasi di FETCH-M0** terhadap `yt-dlp --list-extractors` versi yang dipin (`pyproject.toml` extra `web`, `yt-dlp>=2026.8.19`) dan dipin di fixture; perubahan nama memecah `test_ytdlp_smoke.py`, bukan produksi diam-diam.
- **DNS check dua kali:** `assertPublicHost` (02 §11.4: `dns.promises.lookup(host, {all: true})`; tolak loopback, RFC 1918, link-local, CGNAT `100.64/10`, ULA `fc00::/7`, `::ffff:`-mapped privat, multicast, `0.0.0.0/8`) dijalankan app saat `POST /api/jobs`, lalu **diulang** di worker tepat sebelum preflight, karena DNS bisa berubah di antara keduanya. Gagal → `source_private_address`. Ini melengkapi allowlist host, misalnya terhadap DNS internal yang salah set.
- Hasil file: diperiksa dengan probe yang **sama** dengan upload, yaitu `src/ai_clipper/media_probe.py` / `web/lib/media-probe.mjs` (baru di MU-M4b, 02 §11.2): `format_name` persis `mov,mp4,m4a,3gp,3g2,mj2` atau `matroska,webm`, allowlist codec, demuxer eksplisit, `-protocol_whitelist file,pipe`. Gagal → `source_rejected_format` / `source_rejected_codec` (kode 02). File audio-only (§B5) memakai probe yang sama dengan syarat "≥ 1 video" diganti "tepat 1 audio, 0 video" (`media_probe --audio-only`, opsi baru).
- Env anak = `downloaderEnv(env)` yang ada (`web/scripts/run-job.mjs:262`). Regex `DOWNLOADER_SECRET` (`:250`) sudah membuang `POTONGIN_SETTINGS_*` (termasuk `POTONGIN_SETTINGS_SECRET`), `POTONGIN_LLM*`, `*API_KEY`, dan `APP_*`. Tambahan: `POTONGIN_DB_PATH`. `python -m ai_clipper.fetch` (preflight, §B4) dijalankan run-job lewat `runFencedProcess` dengan env yang sama, bukan lewat `web/lib/python-cli.mjs`, sehingga `PYTHON_CLI_MODULES` tidak berubah.

## B4. Preflight metadata (FETCH-M1)

**Perintah** (`web/lib/fetch-args.mjs` `buildPreflight(plan)`):
`yt-dlp --ignore-config --no-playlist --use-extractors <…> --js-runtimes node --skip-download --dump-single-json --no-warnings [--config-locations <tmp>] [--cookies <file>] <url kanonik>`
- timeout 45 dtk; stdout dibatasi 8 MiB (lebih → `download_failed`, detail `preflight_too_large`); stderr diklasifikasi `classifyDownloadError` yang ada.
- dijalankan lewat `runFencedProcess` (lease/cancel sama dengan unduhan).

**Parsing** di Python (`src/ai_clipper/fetch/probe.py`, dipanggil `python -m ai_clipper.fetch preflight --in <json> --out <json> --max-seconds N --platform P`) agar satu implementasi dipakai worker dan tes. Output `input/.fetch/preflight.json` (0600):

```json
{
  "schema": "potongin.fetch-preflight/1",
  "platform": "youtube", "mediaId": "…", "sourceKey": "youtube:…",
  "durationMs": 3540000, "live": false,
  "availability": "public", "ageLimit": 0,
  "audio": {"formatId": "140", "ext": "m4a", "acodec": "mp4a.40.2", "language": "id", "original": true},
  "video": {"formatId": "136", "height": 720, "fps": 30},
  "filesizeApprox": 412000000,
  "language": "id",
  "decision": "ok",
  "code": null
}
```

**Keputusan (urutan):**
1. `is_live` true atau `live_status ∈ {is_live, is_upcoming, post_live}` → `source_live`.
2. `duration` hilang → `source_duration_unknown`.
3. `duration > maxSourceSeconds` → `source_rejected_duration` (kode 02 §11.2; params `{limit}` menit). `maxSourceSeconds` = batas efektif pemilik menurut 02 §3.3 dan §11.2 (anggota: `min(POTONGIN_MAX_SOURCE_SECONDS, users.max_source_seconds ?? instance_settings.member_max_source_seconds)`; admin: hanya `POTONGIN_MAX_SOURCE_SECONDS`), dihitung app dan disalin ke `job.limits.maxSourceSeconds` saat POST (worker tidak membaca DB untuk ini); job lama tanpa field → env global. Untuk link, ini cek **utama** dan satu-satunya yang terjadi sebelum byte pertama (konflik 5 roadmap). Probe pipeline dari 02 §11.2 tetap berjalan atas file hasil unduhan sebagai cek cadangan, dengan kode yang sama.
4. Twitch `availability = subscriber_only` → `download_members_only` (kode yang ada).
5. Pilih audio: format audio-only dengan `language` = bahasa video dan penanda asli (`format_note` memuat "original" atau `language_preference` tertinggi); di antara itu codec sesuai hasil FETCH-M0 (default rancangan: AAC `m4a` agar merge mp4 tanpa transcode; alternatif Opus ditentukan M0). Tidak ada audio-only → `audioFirst=false`, `fallback="no_audio_first"`.
6. Pilih video: `bv*[height<=H]` dengan `H = sourceHeightFor(job.options)` (fungsi yang ada).
7. `filesizeApprox` dipakai admission ruang kosong (§B6.6).

Bahasa video (`readVideoLanguage` hari ini dari `--print-to-file`) diambil dari `preflight.language`; `--print-to-file` tetap ada di jalur flag-mati.

## B5. Audio-first + unduhan video paralel (FETCH-M3)

Berlaku bila `POTONGIN_FETCH_AUDIO_FIRST=on`, `selectionMode = v3`, sumber link, cache miss, dan preflight memberi `audio.formatId`. Selain itu jalur sekuensial hari ini.

**Worker (`run-job.mjs`):**
1. Unduh audio: `-f <A> -o input/audio.%(ext)s` (`buildAudioDownload`, baru di `fetch-args.mjs`).
2. Setelah audio selesai dan lolos ffprobe: **mulai bersamaan**
   - unduhan video: `-f "bv*[height<=H]+<A>/b[height<=H]" --merge-output-format mp4 -o input/source.%(ext)s` (audio id yang **sama** → timeline identik);
   - subtitle YouTube (`fetchYouTubeCaptions`, yang ada);
   - engine dengan argumen tambahan `--analyze-audio <abs input/audio.m4a> --media-duration <durasi dtk, 3 desimal> --source-ready <abs input/.fetch/source-ready.json> --source-wait-timeout <dtk>`; argumen posisi tetap path video final (`input/source.mp4`, boleh belum ada).
3. Video selesai → ffprobe allowlist → cek A/V (di bawah) → tulis `source-ready.json` atomik (tmp + rename, 0600):

```json
{"schema": "potongin.source-ready/1", "path": "source.mp4", "durationMs": 3540040,
 "fps": {"num": 30, "den": 1}, "width": 1280, "height": 720,
 "audioOffsetMs": 0, "status": "ready"}
```
   Gagal → `{"schema": "potongin.source-ready/1", "status": "failed", "code": "download_stalled"}` di path yang sama.
4. Proses tree: cancel/lease-loss membunuh unduhan video **dan** engine (`process-tree.mjs` yang ada); `download-monitor.mjs` mengawasi tiap unduhan sendiri-sendiri.

**Engine (`src/ai_clipper/fetch/handshake.py`, baru, stdlib):** `wait_source_ready(path, timeout_s, poll_s=1.0) -> SourceReady` — membaca file hanya bila bukan symlink, ≤ 4 KiB, skema cocok; `status=failed` → `SourceUnavailable(code)`; timeout → `SourceUnavailable("download_stalled")`.

**Tahap engine yang memakai audio saja (sebelum menunggu):** transkripsi Whisper/Groq (`transcribe.py`, `transcribe_groq.py` menerima path audio), subtitle YouTube, `analyze_audio_timeline` **bagian audio** (`audio_timeline.py`: pass scene dipisah ke `scene_pass_later`), seleksi V3 + LLM, packaging.
**Tahap yang menunggu `source-ready`:** pass scene, `source_info`/probe dokumen, words artifact (`scene_cuts_ms`), camera/shot plan, seed, render. Stage `fetch_wait_video` dilaporkan bila menunggu > 1 dtk.

**Cek A/V (`probe.py av_offset_ms(audio_path, video_path)`):** `start_time` stream audio file audio vs stream audio di mp4 hasil merge. `|offset| ≤ 1 frame` sumber (`1000·den/num` ms) → lanjut. Lebih → `fallback = "av_offset"`: engine membuang hasil tahap audio dan mengulang analisis dari `source.mp4` (benar, lebih lambat), dicatat di manifest dan `job.fetch`. Ambang 1 frame = keputusan Potongin (roadmap §1, "ambang A/V = 1 frame pada fps sumber, diukur di M0").

**Gate FETCH-M3:**
- episode eval (`docs/evaluation/SELECTION_BENCHMARK.md`) menghasilkan klip yang sama dengan batas ≤ 200 ms antara audio `ba` lama dan audio terpilih baru; unit test exact-equality memakai file audio yang sama;
- gold `SELECTION_BENCHMARK` tidak berubah, atau dijalankan ulang dan dilaporkan sebelum merge;
- waktu sampai seleksi (`stage=llm` selesai) membaik untuk sumber ≥ 30 menit (median 5 sumber, FETCH-M0 sebagai baseline);
- render `POTONGIN_RENDER_ENGINE` `edit-v2` dan `legacy` tidak berubah (parity yang ada).

## B6. Cache media + transkrip lintas job (FETCH-M2, FETCH-M3)

### B6.1 Tata letak disk

Root tetap `/data/cache-unduhan` (nama clean-room §2.2-D; tata letak tingkat atas mengikuti [01-arsitektur-data.md](01-arsitektur-data.md) §1.2 dan §6.4). Direktori ini dibuat saat runtime oleh primary-worker (mode 0700), tidak di Dockerfile. Ia berada di volume `clipper_data` yang sama dengan `/data/jobs`, karena hard link mensyaratkan `st_dev` yang sama (01 §1.2).

```
/data/cache-unduhan/
  umum/                                 scope umum (Q4 default)
    <platform>/<mediaId>/<variant>/
        entry.json          (potongin.media-cache/1)
        source.mp4
        audio.m4a           (bila audio-first)
    _transkrip/<sourceKeyHash>/<transcriptKey>.json
  k-<fairnessKey>/                      scope pemilik, struktur sama dengan umum/
  .locks/<lockKey>/owner.json
  .tmp/<random>/            (unduhan berjalan; dipindah dengan rename saat selesai)
```

- `<scope>` = `umum` atau `k-<fairnessKey>`, dengan `fairnessKey` = `fk1_<16 hex>` yang sudah ada di `job.json` (01 §6.1: `"fk1_" + hex(HMAC-SHA256(K_fair, ownerId))[0..16]`). Python tidak pernah melihat `ownerId` (01 §1.4). Worker meneruskan path scope sebagai argumen, jadi Python tidak menghitung HMAC.
- `<platform>` ∈ `PLATFORMS`; `_transkrip` diawali `_` supaya tidak bisa bentrok dengan nama platform.
- Versi format ada di `entry.json.schema` dan header transkrip (bukan di path). Skema baru → entri lama dianggap miss dan dihapus sweep.
- `<variant>` = `h<H>-a<audioFormatId>-v<videoFormatId>` (karakter `[A-Za-z0-9_-]`, ≤ 64; karakter lain dari format id → `_`).
- `<sourceKeyHash>` = 16 hex sha256 `sourceKey`.

`entry.json`:

```json
{
  "schema": "potongin.media-cache/1",
  "sourceKey": "youtube:…", "scope": "umum", "variant": "h720-a140-v136",
  "files": [{"name": "source.mp4", "size": 412001234}, {"name": "audio.m4a", "size": 56001234}],
  "durationMs": 3540040, "createdAt": "…", "lastUsedAt": "…",
  "ytDlp": "2026.10.10", "cookies": false
}
```

### B6.2 Aturan scope (Q4, **default, bisa diubah**)

| Kondisi unduhan | Scope tulis | Bisa dibaca oleh |
|---|---|---|
| tanpa cookie, preflight `availability = public`, `ageLimit = 0` | `umum` | semua user |
| dengan cookie, atau tidak publik, atau umur dibatasi | `k-<fairnessKey>` | pemilik itu saja (job lain dengan `fairnessKey` sama) |

"Dengan cookie" = `prepareYoutubeCookies` memasang cookie global untuk job itu, yang bagi anggota hanya terjadi bila `youtube_cookies_share = true` (02 §9.3). Lookup: scope user dulu, lalu `umum`. Preflight **selalu** dijalankan walau cache hit (video yang sudah dihapus/privat tidak disajikan dari cache; batas durasi tetap ditegakkan).

### B6.3 Penyajian ke job

- Hit → `link(cache/source.mp4, attempt/input/source.mp4)` (hard link). Job memegang byte-nya sendiri; cache **tidak pernah** menjadi satu-satunya pemilik byte job.
- `st_dev` cache ≠ `st_dev` `JOBS_ROOT` (dicek saat start) → cache dimatikan untuk proses itu + peringatan log; `EXDEV` saat link → salin, `fallback="cache_exdev"`, entri tidak ditulis.
- Miss → unduh ke `attempt/input/`, lalu (bila lolos semua cek) **salin-masuk dengan link**: `link(attempt/input/source.mp4, .tmp/<r>/source.mp4)` + `entry.json` → `rename(.tmp/<r>, <scope>/<platform>/<mediaId>/<variant>)`. Gagal admission (§B6.6) → tidak disimpan, `cache="skipped"`.
- `lastUsedAt` diperbarui (tulis atomik `entry.json`) setiap hit.

### B6.4 Kunci (dua proses mengunduh sekali)

Protokol sama di Node (`web/lib/media-cache-lock.mjs`) dan Python (`src/ai_clipper/fetch/cache.py`):
- `lockKey` = 16 hex sha256 `scope + "\0" + sourceKey + "\0" + variant` (media) atau `transcriptKey` (transkrip).
- Ambil: `mkdir(.locks/<lockKey>)` (atomik) lalu tulis `owner.json {token, pid, host, leaseUntilMs}`; lease 45 dtk, diperbarui tiap 10 dtk.
- Sudah ada → tunggu (poll 1 dtk) sampai entri muncul atau lock hilang; lease lewat → ambil alih: `rename(.locks/<k>, .locks/.stale-<token>)` lalu `mkdir` ulang; `.stale-*` dihapus sweep.
- Penunggu menghormati cancel/lease job; batas tunggu = timeout unduhan.
- Pemegang di-SIGKILL → lease habis → ambil alih; `.tmp/<r>` yatim dihapus sweep (umur > 1 jam).

### B6.5 Cache transkrip

- `transcriptKey` = 16 hex sha256 JSON kanonik `{sourceKey, audioFormatId, engine: "whisper"|"groq"|"youtube-captions", model, language, wordTimestamps, transcriptSchema}` (`transcriptSchema` = versi `transcript_io`).
- Isi = artefak transkrip persis seperti yang ditulis engine (`transcript_io`), plus header `{schema: "potongin.transcript-cache/1", key}`.
- Engine: argumen `--transcript-cache <abs dir <scope>/_transkrip> --source-key <sourceKey>`; hit → lewati transkripsi, warning info `transcript_cached`; tulis setelah transkripsi sukses (kunci §B6.4).
- Hanya sumber link; upload tidak pernah.
- Hasil transkripsi dari cache wajib byte-identik dengan file yang dihasilkan run asli (tes `tests/test_fetch_cache.py`).

### B6.6 TTL, cap, admission, sweep

- **TTL:** entri dengan `lastUsedAt + POTONGIN_MEDIA_CACHE_TTL_DAYS` < sekarang dihapus.
- **Cap:** `cacheBytes` (jumlah ukuran file semua entri) ≤ `POTONGIN_MEDIA_CACHE_BYTES`; lebih → hapus LRU sampai di bawah 90% cap. Entri yang terkunci tidak dihapus.
- **Admission tulis:** hanya bila ruang kosong > `JOBS_STORAGE_MIN_FREE_BYTES + JOBS_STORAGE_ACTIVE_RESERVE_BYTES + filesizeApprox` (env yang ada, `web/lib/storage-admission.mjs`).
- **Sweep** (`sweepMediaCache({now, root, jobsRoot})`): saat primary-worker start dan tiap 60 menit.
  - root `realpath` wajib bukan `JOBS_ROOT`, bukan di bawahnya, dan `JOBS_ROOT` bukan di bawah root → tolak + log, tanpa hapus apa pun;
  - jalan dengan `lstat`, tidak pernah mengikuti symlink; symlink yang ditemukan dihapus **sebagai link** dan dicatat (`symlink tanam`);
  - setiap path yang akan dihapus dicek ulang `realpath` di dalam root.
- **Akuntansi:** `cacheBytes` dan `cacheOnlyBytes` (file `nlink == 1`) ditampilkan di Tentang sistem (admin). Byte cache **tidak** dihitung ke kuota user; byte yang di-link ke job tetap dihitung ke kuota job itu seperti hari ini.
- `POTONGIN_MEDIA_CACHE=off`: tanpa lookup dan tanpa tulis; sweep tetap jalan (membersihkan sisa sesuai TTL).

### B6.7 API admin cache

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/api/admin/cache-unduhan` | `secureRoute(handler, {role: "admin", owner: "none"})` (02 §7.2) | — | `200 {enabled, capBytes, ttlDays, cacheBytes, cacheOnlyBytes, entries, transcripts, lastSweepAt}`; `lastSweepAt` dibaca dari `/data/cache-unduhan/.sweep.json` (`{at, removedEntries, freedBytes}`, ditulis atomik oleh sweep primary-worker); angka byte dihitung app dengan `lstat` saat request (cache ≤ ribuan file) |
| POST | `/api/admin/cache-unduhan/clear` | `secureRoute(handler, {role: "admin", owner: "none"})`; `sameOriginMutation` sudah langkah 2 `secureRoute` | `{scope?: "all"\|"media"\|"transkrip"}` (default `all`) | `200 {removedEntries, freedBytes}`; `409 {code: "cache_busy", messageId: "web.cache_busy"}` bila ada lock aktif; `400 invalid_request`; `429 rate_limited` (limiter `admin`, 30/menit per sesi, 02 §7.1) |

Non-admin → 404 identik keluarga `web` (02 §7.2 langkah 4, §7.4; `ownership-matrix`, peran). Kedua route wajib masuk matriks route 02 §8 (baris "Route dari dokumen lain", peran A). Audit `code: "cache.cleared"`, `params_json {"scope":"all","removedEntries":N}` (pola nama `domain.aksi` daftar beku 01 §4.1 / 02 §9.7; kode ini ditambahkan ke `web/lib/audit.mjs` di PR FETCH-M2). UI: Pengaturan → Sistem (admin): baris "Cache unduhan · 1,2 GB" + tombol "Kosongkan" (tata letak layar milik 05 §6.10).

## B7. Jaringan: proxy sticky tersegel + bgutil (FETCH-M6)

### B7.1 Setelan

Disimpan tersegel (`web/lib/sealing.mjs` v2, purpose `download-network`, scope `instance`) di `POTONGIN_SETTINGS_DIR/download-network.json`.

```json
{"proxy": {"url": "<rahasia>", "mode": "off|youtube|all"}, "bgutil": {"enabled": false}}
```

- `proxy.url`: `http(s)://` atau `socks5h://`, boleh memuat placeholder `{sesi}` (template sticky). Validasi: skema itu saja, host bukan IP privat, panjang ≤ 512.
- `mode`: `off` (default, Q11), `youtube` (hanya platform youtube), `all`.

### B7.2 API

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/api/settings/download-network` | `secureRoute({role: "admin", owner: "none"})` | — | `200 {proxy: {set: bool, scheme, host, sticky: bool, mode}, bgutil: {enabled, available}}` — **tanpa** URL/kredensial |
| PUT | `/api/settings/download-network` | `secureRoute({role: "admin", owner: "none", reauth: true})` (403 `reauth_required` bila re-auth > 10 menit) | `{proxy?: {url?: string\|null, mode?}, bgutil?: {enabled?}}`; `url: null` menghapus; field yang tidak dikirim tetap | `200` bentuk GET; `400 {code: "proxy_invalid"}`; `400 {code: "bgutil_unavailable"}` bila `POTONGIN_POT_PROVIDER_URL` kosong |

Dimasukkan ke `scripts/security/route_matrix.py`, `route-guard-coverage`, `ownership-matrix` (anggota → 404 keluarga `web`; route ini sudah tercantum di 02 §8.2 "Route dari dokumen lain"). PUT menulis audit `download_network.changed` `{"fields":["proxy.mode","bgutil.enabled"]}` (hanya nama field, tidak pernah URL; ditambahkan ke daftar beku `web/lib/audit.mjs` di PR FETCH-M6). Kode `proxy_invalid` dan `bgutil_unavailable` masuk `web/lib/error-codes.mjs` (§B13).

### B7.3 Pemakaian di worker

- Sesi sticky: `{sesi}` diganti `hex(HMAC-SHA256(secret, "proxy-session\0" + jobId))[:12]` → preflight, audio, video, dan subtitle satu job memakai IP keluar yang sama; percobaan ulang job yang sama juga.
- Proxy ditulis ke `attempt/.fetch/ytdlp.conf` (0600, isi satu baris `--proxy <url>`), argv hanya `--config-locations <path>`; file dihapus di `finally` dan saat start attempt berikutnya.
- **Cookie tidak lewat proxy** (Q7 roadmap fitur, default): bila cookie dipakai untuk unduhan itu, proxy tidak dipasang.
- Redaksi: `download-monitor.mjs`/`sanitizeDownloadLine` mengganti `scheme://user:pass@host` dan host proxy dengan `[proxy]`.
- **Tes wajib** (`web/tests/proxy-redaction.test.mjs`): proxy tidak muncul di `/proc/<pid>/cmdline` proses yt-dlp nyata (fixture yt-dlp palsu yang mencetak argv-nya), env anak, log, `job.json`, maupun respons API.

### B7.4 bgutil (opt-in)

- `compose.yaml`: service `pot-provider` di `profiles: ["pot"]`, image dipin digest (diputuskan FETCH-M0), network bridge sendiri `pot` (tidak `internal`, butuh HTTPS keluar), tanpa `ports:`, `read_only: true`, `cap_drop: [ALL]`, hanya primary-worker ikut network `pot`; app dan render-worker tidak. Dijaga `deploy-env-contract`.
- Plugin yt-dlp `bgutil-ytdlp-pot-provider` dipin di extra `web` `pyproject.toml` + `uv.lock` (nama paket dan sintaks extractor-arg diverifikasi FETCH-M0).
- Dipakai hanya bila `POTONGIN_POT_PROVIDER_URL` terisi **dan** `bgutil.enabled`; argv: `--extractor-args "youtubepot-bgutilhttp:base_url=<url>"` (URL ini bukan rahasia; tetap tidak dicetak ke UI).
- Gagal minting → yt-dlp lanjut tanpa token (perilaku plugin); kalau hasilnya `download_bot_check`, pesan tetap kode yang ada.

## B8. Twitch (+ Kick eksperimen) (FETCH-M4, FETCH-M5)

- **Twitch:** VOD publik dan klip. Tanpa cookie (`prepareYoutubeCookies` hanya untuk youtube). Subtitle tidak ada → Whisper/Groq. Sub-only → `download_members_only`; siaran langsung → `source_live`; link kanal → `source_rejected_kind`. Job ditulis `{type: "link", platform: "twitch"}` (R2), `input/` dipublikasikan dan `sourcePath` ditulis ulang (`primary-job-queue.mjs:816` via `isLinkSource`).
- **Kick:** sama, di balik `POTONGIN_FETCH_KICK=off`. Go hanya bila FETCH-M0 menunjukkan unduhan berhasil di CI **tanpa** `curl_cffi`, atau pemilik menyetujui dependensi `curl_cffi` (dipin). No-go → kode, fixture, dan flag tetap ada, `parseSourceUrl` melempar `SourceUrlError("source_platform_off")` untuk `kick`.
- **UI Buat klip:** field "Link video" (placeholder memuat platform yang menyala: "YouTube" atau "YouTube · Twitch"). Ikon platform di kartu proyek.
- **Form:** field `sourceUrl` (baru); `youtubeUrl` tetap diterima (alias, dipakai klien lama/agen). Dua-duanya terisi → 400 `invalid_request`.

## B9. Ledger per user (FETCH-M7)

Migrasi aditif `web/lib/db/migrations/0004-download-ledger.sql` (baru). **DDL-nya milik [01-arsitektur-data.md](01-arsitektur-data.md) §4.4**, dan dokumen ini tidak menduplikasinya. Kolom yang diisi FETCH-M7 (`web/lib/download-ledger.mjs`, baru):

| Kolom | Nilai dari dokumen ini |
|---|---|
| `owner_id`, `job_id` | `job.ownerId`, id job |
| `platform`, `source_key` | `parseSourceUrl` (§B3) |
| `phase` | `preflight` \| `audio` \| `video` (§B1) |
| `cache` | `job.fetch.cache`: `off` \| `hit` \| `miss` \| `stored` \| `skipped` |
| `cache_scope` | `umum` \| `pemilik` (`k-<fairnessKey>`) \| `none` (cache mati atau tidak dipakai) |
| `proxy` | 1 bila proxy dipasang untuk fase itu (§B7.3); URL tidak pernah ditulis |
| `bytes`, `media_seconds` | ukuran file fase itu; `round(durationMs/1000)` dari preflight (INTEGER; NULL bila preflight gagal sebelum durasi diketahui) |
| `outcome`, `error_code` | `ok` / `failed` / `cancelled`; kode `download_*`/`source_*` (§B13) bila gagal; `NULL` selama baris terbuka |
| `started_at`, `finished_at` | INTEGER ms epoch UTC (konvensi `*_at` 01 §4); baris dibuka saat fase mulai, ditutup di akhir fase |

- Ditulis primary-worker (proses yang boleh membuka DB, 01 §1.3). Gagal tulis ledger hanya dicatat ke log dan tidak menggagalkan job.
- Prune: milik `web/lib/db/prune.mjs` (01 §4.4 dan tabel retensi 01): baris dengan `started_at` > 180 hari dihapus (Q6); baris terbuka > 24 jam ditutup `outcome='failed'`, `error_code='abandoned'`. `abandoned` hanya kode ledger, tidak pernah tampil ke pengguna.
- Tampil di `/admin/job` (kolom "Unduhan": byte + cache). Tidak ada kuota baru dari ledger di rancangan ini.

## B10. Workflow yt-dlp mingguan (FETCH-M8)

`.github/workflows/ytdlp-update.yml` yang ada diperluas:
- co-bump plugin bgutil bersama yt-dlp di `uv.lock`;
- `scripts/ytdlp/ytdlp_smoke.py` menambah kasus: preflight `-J` YouTube publik, Twitch VOD fixture (preflight saja), daftar extractor yang dipakai masih ada (`--list-extractors`);
- PR otomatis hanya bila smoke hijau; `tests/test_ytdlp_update_workflow.py` mengunci langkah baru.

## B11. Range-only (FETCH-M9) — ditunda, gerbang keputusan

Default Q11: **dilewati**. Dibangun hanya bila **semua** terpenuhi:
1. `UNDUHAN_M0.md` menunjukkan penghematan median ≥ 40% waktu sampai klip siap untuk sumber ≥ 40 menit dibanding audio-first + video paralel;
2. A/V pada potongan HLS/DASH ≤ 1 frame di ≥ 95% sampel M0;
3. pemilik menjawab koeksistensi dengan pemilihan ulang klip, editor ±60 dtk di luar jendela, dan perubahan identitas klip (`clip_id` dari sha sumber + start/end, CONTRACTS §3.5) bila sumber diperluas.

Kalau dibangun (ringkas, untuk estimasi): `POTONGIN_FETCH_SECTIONS`, artefak kanonik waktu-kompak + salinan waktu-asli di `analysis/original/`, span dari PTS video yang benar-benar diambil, `src/ai_clipper/source_timeline.py`, `src/ai_clipper/fetch/pieces.py`, `web/lib/source-timeline.mjs`, `scripts/fetch/av_alignment_report.py`, `tests/support/hls_server.py` (semua baru), fallback ke unduhan penuh.

## B12. FETCH-M0: pengukuran (`docs/evaluation/UNDUHAN_M0.md`, baru)

Dijalankan di GitHub Actions (`gh workflow run editor-gates.yml -f ref=<branch> -f suite=command -f command='python scripts/fetch/m0_measure.py --out /out/unduhan-m0.json'`; suite `command` mengunggah isi `/out` sebagai artefak run, yang diambil dengan `gh run download`. Angkanya lalu disalin ke `UNDUHAN_M0.md`), tidak di PC pemilik.

| # | Ukuran | Metode | Keputusan yang dihasilkan |
|---|---|---|---|
| M0-1 | Audio asli vs `ba` | 5 sumber publik berlisensi; codec, ukuran, waktu unduh; seleksi V3 pada keduanya | codec audio-first (AAC vs Opus); batas ≤ 200 ms dipastikan |
| M0-2 | Waktu sampai seleksi | sekuensial vs audio-first simulasi, sumber 10/30/60/120 menit | baseline gate FETCH-M3 |
| M0-3 | bgutil | minting dengan/tanpa proxy, tingkat `download_bot_check` 20 percobaan | go/no-go bgutil, digest image, nama extractor-arg |
| M0-4 | Proxy | file config tidak muncul di `/proc/<pid>/cmdline` | desain §B7.3 dikonfirmasi |
| M0-5 | Kick | 5 VOD/klip, dengan/tanpa `curl_cffi` | go/no-go Kick |
| M0-6 | Range-only | waktu potong HLS/DASH, A/V offset | input gerbang §B11 |
| M0-7 | Extractor | `yt-dlp --list-extractors` versi pin | nama di `PLATFORMS[p].extractors` |
| M0-8 | Disk | ukuran sumber 720p/1080p per jam | cap 4 GiB masuk akal / diusulkan ulang ke pemilik |

Hasil: tabel angka + keputusan go/no-go tertulis (kriteria selesai Fase 0).

## B13. Kode error sumber (satu daftar, entri Bantuan wajib)

Satu kode = satu kunci teks, di mana pun kode itu muncul (respons `POST /api/jobs` atau `job.error` dari worker). `messageId` selalu eksplisit dan berbentuk `<domain>.<kode>` (§5.65, 07 §10.2); kunci katalog = `"errors." + messageId` (07 §7.2), sehingga kode worker boleh menunjuk ke domain `web.*`. Teks ditulis di `web/messages/{id,en}/errors.json` (07-i18n.md §2.2) dalam **id dan en**. Anchor `/bantuan#<kode>` stabil. `help-catalog.test.mjs` dan `i18n-error-codes` memaksa kelengkapan.

| Kode | Pemilik definisi | Daftar kode | `messageId` (kunci = `errors.` + ini) | Kapan | Teks `id` (label) |
|---|---|---|---|---|---|
| `source_host_not_allowed` | 02 §11.4 (MU-M4b) | `web/lib/error-codes.mjs` | `web.source_host_not_allowed` | skema/host/port/userinfo tidak sah (API) | Link tidak dikenali |
| `source_rejected_kind` | 02 §11.4 | sama | `web.source_rejected_kind` | kanal, playlist, bentuk path lain; `/live/` sebelum FETCH-M1 | Pakai link satu video |
| `source_private_address` | 02 §11.4 | sama | `web.source_private_address` | DNS ke alamat privat (API, atau cek ulang di worker) | Link tidak bisa dibuka server |
| `source_rejected_duration` | 02 §11.2 | sama | `web.source_rejected_duration` | durasi > batas (`{limit}` menit): preflight (§B4) atau probe cadangan | Video lebih dari {limit} menit |
| `source_rejected_format` / `source_rejected_codec` | 02 §11.2 | sama | `web.<kode>` | file hasil unduhan gagal `media_probe` (§B3.4) | Format video tidak didukung |
| `source_platform_off` | **dokumen ini** (FETCH-M1) | `web/lib/error-codes.mjs` | `web.source_platform_off` | platform dikenali tapi flag-nya mati | Platform ini belum aktif |
| `source_live` | **dokumen ini** (FETCH-M1) | `web/lib/download-errors.mjs` (`MESSAGES`, `DOWNLOAD_ERROR_CODES`) | `download.source_live` | siaran sedang/akan berlangsung (preflight) | Siaran langsung belum bisa |
| `source_duration_unknown` | **dokumen ini** (FETCH-M1) | `web/lib/download-errors.mjs` | `download.source_duration_unknown` | durasi tidak ada di metadata | Durasi video tidak diketahui |

Teks `en` ditulis implementer sebagai draf, lalu direview pemilik per fase (Q9 default).

Kode baru lain dari dokumen ini (semua domain `web.*` di `web/lib/error-codes.mjs`, `messageId` = `web.<kode>`, teks id + en):

| Kode | Status | Sumber |
|---|---|---|
| `auto_reframe_off`, `auto_reframe_needs_v3` | 400 | §A8.2 |
| `cache_busy` | 409 | §B6.7 |
| `proxy_invalid`, `bgutil_unavailable` | 400 | §B7.2 |

Kode command editor (`shot_not_found`, `shot_mode_invalid`) ada di domain `editor.*` (§A6). `invalid_request`, `not_found`, `rate_limited`, `reauth_required` memakai kode yang sudah ada (02 §16, 07 §10.2).

Kode yang ada (`download_private`, `download_bot_check`, `download_stalled`, dll.) tetap; teks "YouTube" di pesan umum diganti netral platform ("Video gagal diunduh") hanya untuk sumber non-YouTube (params `{platform}`), sehingga teks YouTube hari ini tidak berubah.

## B14. API yang berubah (ringkas)

| Method | Path | Perubahan | Error |
|---|---|---|---|
| POST | `/api/jobs` | `sourceUrl` (baru) / `youtubeUrl` (alias); `renderMode=auto`; app menyalin `job.limits.maxSourceSeconds` | `400 source_host_not_allowed\|source_rejected_kind\|source_private_address\|source_platform_off\|auto_reframe_off\|auto_reframe_needs_v3\|invalid_request` dengan `{error, code, messageId}` (§5.65) |
| GET | `/api/jobs/[id]` (serialisasi yang ada) | tambah `fetch` (§B1, tanpa rahasia) | — |
| POST | `/api/jobs/[id]/clips/[clipId]/prepare` | `layout: "auto"` | flag `off` → `404 not_found` keluarga `edit` identik (§A8.1, 02 §7.4) |
| GET/PUT | `/api/settings/download-network` (baru) | §B7.2 | §B7.2 |
| GET | `/api/admin/cache-unduhan` (baru) | §B6.7 | 404 `web` non-admin |
| POST | `/api/admin/cache-unduhan/clear` (baru) | §B6.7 | `409 cache_busy`, 404 `web` non-admin, 403 `csrf_rejected`, 429 |

## B15. Tes dan gate unduhan

| Gate | Isi | Milestone |
|---|---|---|
| Snapshot argv | flag semua `off` → argv yt-dlp identik dengan argv **setelah MU-M4b** (`buildVideoDownload`, `buildCaptionDownloads`; snapshot di `web/tests/worker-download.test.mjs` yang ada) | M1 |
| Paritas URL | `urls.json` JS = Python | MU-M4b, M1, M4, M5 |
| Guard tipe sumber | `source-type-guard.test.mjs` | M1 |
| Publikasi | job Twitch (fake yt-dlp) mempublikasikan `input/`, `sourcePath` ditulis ulang (`web/tests/primary-job-queue.test.mjs`) | M4 |
| Preflight | `test_fetch_probe.py`: live, upcoming, durasi hilang, terlalu panjang (global vs user), sub-only, tanpa audio-only, pilihan audio asli | M1 |
| Konkurensi cache | dua proses Node nyata mengunduh `sourceKey` sama → fake yt-dlp dipanggil **sekali**; pemegang SIGKILL → penunggu ambil alih; cancel saat menunggu; EXDEV → salin; symlink tanam ditolak; sweep menolak root di bawah `JOBS_ROOT` | M2 |
| Scope | entri `k-*` tidak terbaca user lain; unduhan bercookie tidak pernah masuk `umum`; preflight tetap jalan saat hit | M2 |
| Transkrip cache | hit = byte identik; kunci berubah bila model/bahasa berubah | M3 |
| Audio-first | `test_pipeline_audio_first.py`: engine menunggu `source-ready`; `failed` → job gagal dengan kode; timeout; `av_offset` > 1 frame → analisis ulang; eval ≤ 200 ms; gold tidak berubah | M3 |
| Redaksi | §B7.3 | M6 |
| Keamanan | `route_matrix.py` + `ownership-matrix` untuk route baru; `deploy-env-contract`: `pot-provider` tanpa ports, tidak tersambung ke app/render-worker | M6 |
| Ledger | baris per fase; gagal tulis tidak menggagalkan job | M7 |
| Workflow | `test_ytdlp_update_workflow.py` | M8 |
| Drill flag | tiap flag `off` lewat `.env` + `docker compose up -d`: job baru jalur lama, job `link` lama tetap tampil | M10 |
| e2e | `web/e2e/create-from-link.spec.mjs` (baru): YouTube dan Twitch (fake origin), penolakan live/terlalu panjang sebelum unduh, label tahap, `id` dan `en` | M10 |

Tes lokal hanya yang ditargetkan (`node --test web/tests/<file>`, `pytest tests/<file>`); konkurensi cache, e2e, dan pengukuran di GitHub Actions.

## B16. Rollback unduhan

| Lapisan | Mekanisme | Catatan |
|---|---|---|
| Fitur | `POTONGIN_FETCH_*`, `POTONGIN_MEDIA_CACHE` → `off`, recreate | Tanpa rebuild |
| Skema sumber | YouTube selalu `{type:"youtube"}`; `{type:"link"}` hanya setelah R2 | Rollback image ke < R1 dengan job Twitch yang ada: job itu tampil tanpa `input/` (dokumen di `UNDUHAN_SUMBER.md`) |
| Cache | Hapus `/data/cache-unduhan` kapan saja | Job tidak terdampak (hard link) |
| bgutil | Matikan profil `pot` / kosongkan `POTONGIN_POT_PROVIDER_URL` | — |

---

# Bagian C — Urutan rilis dan kriteria selesai

| Rilis | Fase | Isi | Selesai bila |
|---|---|---|---|
| PR kontrak | 0 | §5.63 (shot plan, `layout.ranges` V1–V9, command), §5.64 (skema sumber, cache, handshake) di `docs/editor/CONTRACTS.md` | di-merge sebelum RF-M1/FETCH-M1 |
| RF-M0, FETCH-M0 | 0 | set evaluasi + baseline; `UNDUHAN_M0.md` | baseline camera hari ini dilaporkan di dev; go/no-go Kick, bgutil, range-only tertulis |
| RF-M1 + RF-M2 | 5 ‖ | analisis + kompiler | gate §A10 baris Pin, Cut, Scan, Graf, P-FRAME (RF-M2) |
| MU-M4b (sumber) | 6 | allowlist YouTube + pertahanan worker | sebelum undangan pertama; tes `urls.json`, `test_security_*` |
| RF-M3 (release 1) + RF-M4 | 6 ‖ | floor + penyetelan | flag `off` di produksi; agreement ≥ 85%, SPEAKER_FRAMING ≤ 21,7%, ≥ 8/10 |
| FETCH-M1…M8 | 7 | unduhan | gate §B15 |
| RF-M5a + RF-M6 (release 2) | 7 | Otomatis opt-in | P-FRAME 0, P-PLATE 0 px, G-DET 0, PF-RENDER p50 ≤ 0,4×; PF-PIPELINE dilaporkan; pemilik setuju menyalakan |
| FETCH-M10 | 7 | rollout + drill | semua flag drill hijau; waktu sampai seleksi membaik untuk ≥ 30 menit |
| F4b (data) | 11 | per shot di editor | vektor paritas; `origin:user` bertahan; S-COLOR 2–3 range |

Keputusan default Otomatis (tetap opt-in atau jadi default menggantikan Latar blur) diambil pemilik **setelah** angka PF-PIPELINE ada (Q10). Sampai itu default Buat klip tetap seperti hari ini: **Latar blur** (`DEFAULT_CHOICES.renderMode = "fit-blur"`, `web/lib/dashboard-choices.mjs`).

---

# Bagian D — Celah yang belum terselesaikan

Hanya item yang benar-benar masih terbuka. Keputusan default yang sudah ditulis di badan dokumen (V8 tetap dilarang, §A6; split jatuh ke Ikuti wajah bila spike gagal, §A7.2; ambang dari sweep, §A9) tidak diulang di sini.

**Butuh jawaban pemilik**
1. **Scope cache vs cookie global (Q4).** Default "`umum` hanya tanpa cookie" + cookie YouTube global admin (`youtube_cookies_share = true` default, 02 §9.3) = hampir semua unduhan YouTube bercookie, sehingga scope `umum` jarang terisi. Alternatif: `umum` bila `availability=public` dan `ageLimit=0` walau bercookie. Perlu jawaban sebelum Fase 7.

**Dikunci oleh pengukuran**
2. **Kesetaraan `fill_center` dengan crop camera ber-x tengah** belum dibuktikan; bila beda, kompiler butuh saklar y (jumlah konteks tetap konstan, graf berubah dari rancangan §A7.1). Diputuskan spike RF-M2.
3. **Nama extractor yt-dlp, nama/sintaks plugin bgutil, digest image `pot-provider`, codec audio-first** ditulis sebagai kandidat; dikunci FETCH-M0 (§B12). Perilaku pencocokan `--use-extractors` juga diuji di MU-M4b (02 §17 butir 5).

**Penyelarasan dokumen lain:** selesai pada pemeriksaan silang akhir 2026-10-24 ([00-README.md](00-README.md) §8): 08 merujuk §A6/§A4; 02 §11.4 memakai `parseSourceUrl` dengan `kind`/`sourceKey`/`{platforms}` dan §8.2 mencantumkan route cache; 01 §1.2, §4.1 (`cache.cleared`, `download_network.changed`) dan §6.1 (`fetch`, `limits.maxSourceSeconds`, `source.type="link"`) sudah memuat isi dokumen ini; 05 §6.10 memuat baris Cache unduhan; 07 §7.1 punya namespace `layout` dan kode tahap `stage.reframe`/`stage.fetch_*`.

**Urutan merge**
4. Halaman `/admin/job`, `web/lib/sealing.mjs`, dan `web/lib/db/*` berasal dari 01/02 (MU-M1/MU-M4/MU-M5); FETCH-M6/M7 di-merge setelahnya.
