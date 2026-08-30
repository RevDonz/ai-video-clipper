# Clip Selection V2 and Customized Editor Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Membangun pemilihan klip explainable berbasis hook–payoff dan editor koreksi yang memungkinkan pengguna memilih kandidat, mengubah boundary/caption/layout, lalu merender ulang secara deterministik.

**Architecture:** Pipeline dipecah menjadi analysis artifacts, candidate generation, feature scoring, diversity selection, editable render manifest, dan deterministic render. Weighted scorer menjadi baseline yang dapat diuji dan menjelaskan alasan; feedback pengguna disimpan sebagai label untuk learning-to-rank setelah dataset cukup. Editor web hanya memodifikasi manifest, sementara FFmpeg tetap menjadi sumber final render.

**Tech Stack:** Python 3.11, faster-whisper, OpenCV, FFmpeg/FFprobe, Next.js 16, React 19, atomic JSON artifacts, Node test runner, pytest.

---

## Acceptance criteria

1. Kandidat tidak wajib selalu mendekati max duration dan tidak mulai/berakhir di tengah segmen.
2. Tersedia profile `viral-short`, `standard`, dan `deep-dive`.
3. Setiap kandidat mempunyai score breakdown dan alasan pemilihan.
4. Lima kandidat akhir tidak overlap dan tidak didominasi satu topik identik.
5. User dapat menerima/menolak kandidat dan mengubah start/end.
6. User dapat memilih preset caption dan mengedit cue/keyword.
7. Preview dan final render membaca manifest versi yang sama.
8. Feedback tersimpan dengan version/model provenance.
9. Existing jobs tetap dapat dibaca melalui compatibility adapter.
10. Tidak ada deployment saat worker aktif.
11. Profile durasi mengalir dashboard → API → job JSON → CLI tanpa merusak command CLI legacy.

## Target artifact model (dibangun pada Task 9)

Belum ada edit-manifest runtime sebelum Task 9. Contoh berikut menjadi canonical
JSON contract yang wajib diuji melalui strict encode/decode contract test.

```text
source.mp4
analysis/
  transcript.words.json
  speakers.json
  scenes.json
  audio-features.json
  candidates.v2.json
  selection-feedback.jsonl
edits/
  clip-01.edit.json
output/
  clip-01.mp4
  clip-01.srt
manifest.json
```

`clip-XX.edit.json` menjadi edit decision list (EDL) versioned:

```json
{
  "version": 1,
  "source": { "start": 12.5, "end": 51.2 },
  "layout": { "mode": "face-track", "tracking": "prominent-face" },
  "caption": {
    "preset": "bold-keyword",
    "position": "lower-middle",
    "baseColor": "#FFFFFF",
    "keywordColor": "#DFFF58",
    "maxWords": 5,
    "cues": []
  },
  "overlays": [],
  "selection": {
    "score": 8.4,
    "reasons": ["Pertanyaan langsung", "Payoff lengkap"]
  }
}
```

---

### Task 1: Add V2 domain models

**Objective:** Menambahkan model kandidat, feature breakdown, alasan, profile durasi, dan strict candidate JSON boundary tanpa merusak model V1. Edit manifest sengaja ditunda sampai Task 9 agar hanya ada satu canonical schema.

**Files:**
- Modify: `src/ai_clipper/models.py`
- Create: `tests/test_models_v2.py`

**Steps:**

1. Tulis failing tests untuk finite timestamps, bounded scores 0–10, known duration profiles, immutable evidence, positive integer rank, boolean-as-number rejection, dan JSON round-trip.
2. Jalankan `uv run pytest tests/test_models_v2.py -q`; expected FAIL karena model belum ada.
3. Implementasikan `ClipProfile`, `CandidateFeatures`, `ClipCandidate`, dan `CaptionStyle` sebagai dataclasses frozen/slots, plus strict `to_dict`/`from_dict` untuk candidate.
4. Jalankan test sampai lulus.
5. Jalankan seluruh Python suite.
6. Commit `feat: add clip selection v2 domain models`.

### Task 2: Generate boundary-aware candidates

**Objective:** Membentuk beberapa kandidat di sekitar sentence/pause/speaker boundaries, bukan satu window maksimal untuk setiap start.

**Files:**
- Create: `src/ai_clipper/candidates.py`
- Create: `tests/test_candidates.py`
- Modify: `src/ai_clipper/highlight.py` hanya untuk compatibility wrapper.

**Steps:**

1. Buat fixtures segmen dengan pause, pertanyaan, speaker turn, dan topic shift.
2. Tulis failing tests: kandidat mencakup beberapa durasi; boundary utuh; profile duration dipatuhi; tidak ada single segment yang melewati max.
3. Implementasikan profile:
   - viral-short 15–45;
   - standard 30–90;
   - deep-dive 60–300.
4. Emit top-N boundary variants per anchor untuk mencegah candidate explosion.
5. Verifikasi determinism dan batas jumlah kandidat.
6. Commit `feat: generate boundary-aware clip candidates`.

### Task 3: Add explainable hook–payoff feature extraction

**Objective:** Mengganti keyword-only score dengan structured feature extraction yang dapat dijelaskan.

**Files:**
- Create: `src/ai_clipper/features.py`
- Create: `tests/test_features.py`
- Keep: `src/ai_clipper/highlight.py` sebagai fallback V1 selama migrasi.

**Steps:**

1. Tulis fixtures bahasa Indonesia untuk:
   - question hook;
   - contradiction/bold claim;
   - number/authority proof;
   - pain point;
   - open loop;
   - answer/payoff;
   - missing context;
   - intro/outro/sponsor-first.
2. Tulis failing tests per dimension, jangan hanya total score.
3. Implementasikan normalization dan phrase patterns terpisah dari weights.
4. Hitung `hook_strength`, `hook_relevance`, `standalone_context`, `payoff_completeness`, `information_density`, `boundary_quality`, dan penalties.
5. Simpan reason strings dari evidence aktual; jangan membuat klaim yang tidak ada dalam transcript.
6. Commit `feat: add explainable hook payoff scoring`.

### Task 4: Add lightweight multimodal signals

**Objective:** Menambahkan audio energy, pause, scene change, face activity, dan speaker-turn evidence tanpa membangun model multimodal besar terlebih dahulu.

**Files:**
- Create: `src/ai_clipper/media_features.py`
- Create: `tests/test_media_features.py`
- Modify: `src/ai_clipper/pipeline.py`

**Steps:**

1. Buat synthetic audio/video fixtures dengan silence, energy change, scene cut, dan dua face tracks jika tersedia.
2. Tulis failing tests untuk bounded feature output dan graceful fallback saat visual analysis tidak tersedia.
3. Implementasikan FFmpeg audio RMS extraction dan OpenCV scene/motion summaries.
4. Gunakan existing face tracking untuk face-presence/activity, bukan expression claims.
5. Publish `analysis/audio-features.json` dan `analysis/scenes.json` secara atomik.
6. Commit `feat: add multimodal clip potential signals`.

### Task 5: Rank with diversity and reasons

**Objective:** Memilih K kandidat berkualitas yang non-overlap dan tidak semantik duplikat.

**Files:**
- Create: `src/ai_clipper/ranking.py`
- Create: `tests/test_ranking.py`
- Modify: `src/ai_clipper/pipeline.py`

**Steps:**

1. Tulis failing tests untuk weighted score, overlap removal, chronological display vs score rank, dan topic diversity.
2. Implementasikan weight config versioned (`selection-v2.0`).
3. Gunakan token/topic similarity baseline dan MMR-style diversity penalty.
4. Simpan `rank`, `display_order`, `score`, `score_breakdown`, dan `reasons`.
5. Publish `analysis/candidates.v2.json`.
6. Commit `feat: rank diverse clips with selection reasons`.

### Task 6: Separate analysis, selection, and render stages

**Objective:** Menghasilkan kandidat lebih dulu agar user dapat memilih/edit sebelum render mahal.

**Files:**
- Modify: `src/ai_clipper/pipeline.py`
- Modify: `src/ai_clipper/cli.py`
- Modify: `web/scripts/run-job.mjs`
- Modify: `web/lib/jobs.mjs`
- Modify: `web/app/api/jobs/route.js`
- Modify: `web/app/dashboard/page.jsx`
- Modify: `tests/test_pipeline.py`
- Modify: `web/tests/jobs.test.mjs`

**Steps:**

1. Tambahkan states `analyzing`, `candidates_ready`, `rendering`, `completed`.
2. Tulis failing tests bahwa analysis artifact tersedia sebelum render.
3. Propagasikan profile dari dashboard ke parser API, job JSON, worker, dan CLI; naikkan max duration terkontrol hingga 300 hanya untuk `deep-dive`.
4. Tambahkan CLI modes `analyze`, `render --edit-manifest`, dan compatibility `run`.
5. Tambahkan regression test yang menjalankan bentuk command production legacy persis: `ai-clipper SOURCE --output-dir ...`.
6. Worker web menyimpan candidates dan menunggu auto-render atau user selection sesuai option.
7. Existing jobs tanpa V2 artifacts tetap tampil melalui fallback.
8. Commit `refactor: split clip analysis selection and rendering`.

### Task 7: Add candidate review and feedback API

**Objective:** Menyimpan accept/reject, rank choice, dan boundary edits sebagai training labels yang audit-able.

**Files:**
- Create: `web/app/api/jobs/[id]/candidates/route.js`
- Create: `web/app/api/jobs/[id]/feedback/route.js`
- Create: `web/lib/feedback.mjs`
- Modify: `web/proxy.js` hanya jika matcher perlu disesuaikan.
- Create/Modify: `web/tests/feedback.test.mjs`

**Steps:**

1. Tulis failing tests untuk job ID/path validation dan explicit action enum.
2. Implementasikan GET candidates dan POST feedback.
3. Feedback append-only JSONL dengan `createdAt`, `selectionVersion`, `candidateId`, action, old/new boundary, dan optional reason.
4. Gunakan atomic/locked append atau per-event file lalu compact untuk mencegah corruption.
5. Jangan menyimpan credentials atau arbitrary client payload.
6. Commit `feat: capture clip selection feedback`.

### Task 8: Create candidate review UI

**Objective:** Memungkinkan user memahami dan memilih kandidat sebelum masuk editor.

**Files:**
- Create: `web/app/projects/[id]/select/page.jsx`
- Create: `web/app/components/CandidateCard.jsx`
- Modify: `web/app/globals.css`
- Modify: `web/app/projects/page.jsx`

**Steps:**

1. UI menampilkan preview, timestamp, duration, score bernama `Clip potential`, breakdown, dan reasons.
2. Tambahkan accept/reject, select all top K, dan boundary nudge.
3. Tampilkan warning jika hook membutuhkan konteks atau kandidat mirip dengan kandidat lain.
4. Pastikan keyboard semantics dan mobile layout.
5. Tambahkan source-level tests untuk protected route dan required controls.
6. Commit `feat: add candidate review workspace`.

### Task 9: Add versioned editable caption/render manifest

**Objective:** Menjadikan caption/layout sebagai data yang dapat diedit dan dirender identik.

**Files:**
- Create: `src/ai_clipper/edit_manifest.py`
- Modify: `src/ai_clipper/subtitles.py`
- Modify: `src/ai_clipper/render.py`
- Create: `tests/test_edit_manifest.py`
- Modify: `tests/test_subtitles.py`
- Modify: `tests/test_render.py`

**Steps:**

1. Definisikan canonical nested JSON schema version 1 sesuai contoh target di dokumen ini; tulis strict encode/decode test yang memuat contoh tersebut persis. Tidak ada migration dari model manifest prematur.
2. Tambahkan presets `clean`, `bold-keyword`, `karaoke`, `podcast`, `minimal`.
3. Generate short cues dengan keyword spans dan explicit style—not hard-coded CSS/ASS behavior.
4. Render membaca manifest yang sama dengan preview.
5. FFprobe output dan screenshot visual regression untuk setiap preset.
6. Commit `feat: add editable caption render manifests`.

### Task 10: Build correction-oriented custom editor

**Objective:** Membuat editor focused untuk trim, caption, crop/layout, dan rerender—bukan clone CapCut.

**Files:**
- Create: `web/app/projects/[id]/clips/[index]/edit/page.jsx`
- Create: `web/app/components/editor/PreviewCanvas.jsx`
- Create: `web/app/components/editor/TrimTimeline.jsx`
- Create: `web/app/components/editor/CaptionPanel.jsx`
- Create: `web/app/components/editor/LayoutPanel.jsx`
- Create: `web/app/api/jobs/[id]/clips/[index]/edit/route.js`
- Create: `web/app/api/jobs/[id]/clips/[index]/render/route.js`
- Modify: `web/app/globals.css`

**Steps:**

1. Preview proxy video dengan overlay DOM berdasarkan edit manifest.
2. Add trim handles dan timestamp inputs dengan source-bound validation.
3. Add caption preset cards, font/size/color/position/max words controls.
4. Add cue text and keyword override.
5. Add layout mode dan prominent-face tracking toggle. Jangan menamai fitur active-speaker sebelum diarization dan face-speaker association benar-benar tersedia.
6. Save manifest explicitly; rerender menjadi separate idempotent job.
7. Add unsaved-change guard dan accessible controls.
8. Commit `feat: add customized clip editor`.

### Task 11: Add evaluation harness and training export

**Objective:** Mengukur kualitas selection dan mengekspor dataset rights-cleared untuk learning-to-rank.

**Files:**
- Create: `src/ai_clipper/evaluation.py`
- Create: `scripts/export_selection_dataset.py`
- Create: `tests/test_evaluation.py`
- Create: `docs/evaluation/SELECTION_V2.md`

**Steps:**

1. Implementasikan Precision@K, acceptance rate, boundary adjustment, duplicate-topic rate, dan source-level split.
2. Export anonymized JSONL tanpa source media/token/credential.
3. Refuse training jika provenance/rights flag tidak tersedia.
4. Version feature schema dan ranker.
5. Gunakan 50–100 source videos berlabel sebagai gate eksperimen awal, bukan minimum ilmiah; ukur learning curve dan lanjutkan hanya jika split source-level menunjukkan signal yang stabil.
6. Commit `feat: add clip selection evaluation dataset export`.

### Task 12: Production hardening and staged rollout

**Objective:** Merilis V2 tanpa memutus jobs lama atau worker aktif.

**Files:**
- Modify: `README.md`
- Modify: `compose.yaml` jika queue/concurrency guard ditambahkan.
- Create: `docs/deploy/SELECTION_V2_ROLLOUT.md`

**Steps:**

1. Feature flag `CLIP_SELECTION_VERSION=v1|v2` dengan default v1 pada deploy pertama.
2. Shadow-score existing/new jobs tanpa memengaruhi output.
3. Bandingkan V1 vs V2 pada evaluation set.
4. Canary V2 untuk internal user.
5. Verifikasi no active jobs sebelum recreate container.
6. Uji persistent old jobs, candidate review, editor save, rerender, dan download.
7. Aktifkan V2 default hanya setelah acceptance metrics membaik.
8. Commit dan push release.

## Rollout phases

### Phase A — Selection V2 baseline

Tasks 1–5. Deliverable: explainable candidate JSON dan offline evaluation.

### Phase B — Human feedback loop

Tasks 6–8. Deliverable: user memilih kandidat dan menghasilkan labels.

### Phase C — Customized editor

Tasks 9–10. Deliverable: correction-oriented editor dan deterministic rerender.

### Phase D — Training and optimization

Tasks 11–12. Deliverable: rights-cleared dataset, learning-to-rank experiment, shadow/canary rollout.

## Non-goals awal

- Clone timeline multi-track CapCut penuh.
- Menjanjikan virality.
- Mengambil TikTok orang lain sebagai training corpus tanpa hak.
- Generative B-roll sebelum selection/caption/editor core terbukti.
- Billing/team collaboration sebelum single-user workflow stabil.
