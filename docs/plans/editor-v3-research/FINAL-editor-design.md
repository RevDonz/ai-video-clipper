# FINAL: Potongin Studio editor design (architect's synthesis)

Date: 2026-09-24. Branch context: `feat/selection-v3-llm` (other agents are editing it; the repo was
only read). This is the chief architect's ruling on three competing proposals in this folder:

- `proposal-parity-first.md` (PF)
- `proposal-incremental.md` (INC)
- `proposal-ux-first.md` (UX)

It also draws on the research reports `r1-existing-editor.md` (R1), `r2-feature-inventory.md` (R2)
and `r3-tech.md` (R3). This is the first write of this file: none existed when the run resumed after
the usage-limit cut-off.

Evidence tags:

| Tag | Meaning |
|---|---|
| `[PF]` | Measured in `spike-pf/`: production image `ai-video-clipper:latest` (FFmpeg 5.1.9, libass 0.17.1), and Chrome for Testing 147 with JASSUB 2.5.16 |
| `[INC-E1..E6]` | Measured in `inc/` (same image, `--cpus 4`) |
| `[UX-M1..M6]` | Measured in `ux/` |
| `[R1]` `[R2]` `[R3]` | Research reports |
| `[REPO]` | Read from the code on 2026-09-24 |
| `[LC]` | LokaClip binary strings or release notes |
| `[E]` | Estimate. A named gate must confirm it before anything depends on it. |
| `[D]` | Decision made in this document |

---

## 1. Decision summary

### 1.1 Ringkasan keputusan (Bahasa Indonesia)

Tidak ada proposal yang menang mutlak. **Parity-first** punya arsitektur paling kuat untuk syarat
utama owner, yaitu "pratinjau = hasil render" dan "jangan menurunkan kualitas". **Incremental** punya
rencana pengiriman paling aman. **UX-first** punya model interaksi paling lengkap. Desain final
memakai ketiganya:

1. **K1. Arsitektur dari parity-first, cara kirim dari incremental, model interaksi dari UX-first.**
   Arsitekturnya: satu dokumen integer, satu resolver, dan satu RenderPlan yang dieksekusi dua mesin.
   Cara kirimnya: strangler, feature flag, dan gate numerik di tiap langkah. Model interaksinya:
   transkrip sebagai tulang punggung, dengan Mode Cepat dan Mode Pro.
2. **K2. Satu resolver: `edit-core`.** Ini JavaScript ESM murni tanpa dependensi npm saat runtime;
   harfbuzz WASM di-vendor.
   - Resolver yang sama jalan di browser (pratinjau instan) dan di Node 20 yang **sudah ada di setiap
     kontainer** (image berbasis `node:20-bookworm-slim` `[REPO Dockerfile]`).
   - Python tetap **stdlib-only** (`dependencies = []` `[REPO pyproject]`). Tugasnya: penyimpanan,
     antrean, kompilasi RenderPlan → argumen FFmpeg, eksekusi, verifikasi, dan analisis.
   - Tidak ada lagi dua generator ASS atau dua layout builder.
3. **K3. Dokumen `clip-edit-v2` hanya berisi integer.**
   - Potongan video dalam frame grid sumber (`_sf`) pada fps output. Kata dalam ms sumber. Posisi
     dalam e5 (fraksi ×100.000). Gain dalam centi-dB.
   - Kata disimpan terpisah di artefak imutabel `potongin.words/1`, sehingga dokumen cukup 8–12 KB
     dan autosave murah.
   - Stiker boleh **ditambatkan ke kata**, jadi ikut bergeser saat kalimat sebelumnya dihapus.
4. **K4. Grid frame kanonik dan waktu ASS "frame-safe".** Keduanya terbukti dengan pengukuran:
   - Cara `render.py` sekarang memilih frame sumber yang berbeda pada **49,6%** frame. Aturan grid
     memberi **0 dari 1.125** `[PF]` (dan 60/60 lawan 40/60 `[INC-E6]`).
   - JASSUB **membulatkan** waktu, sedangkan FFmpeg **memotong**, sehingga karaoke bisa meleset satu
     frame. Aturan centidetik frame-safe memberi **0 kegagalan** di 8 frame rate `[PF]`.
5. **K5. Tangga paritas pratinjau: N → D → B → T.**
   - N: op native WebGL2 yang lulus golden test.
   - D: aset turunan server, dengan byte yang sama untuk pratinjau dan render.
   - B: potongan yang di-bake server oleh kompiler yang sama.
   - T: frame kebenaran saat jeda.

   **Piksel perkiraan tidak pernah ditampilkan.** Op yang belum lulus gate tetap bisa dipakai lewat
   B; hanya lebih lambat, tidak pernah salah.
6. **K6. Render otomatis V3 pindah ke mesin yang sama sebelum UI apa pun.** Klip AI menjadi
   "revisi 0". Membuka lalu mengekspor tanpa edit memberi video yang identik (framemd5).
7. **K7. Kompositing server di yuv444p**, lalu yuv420p hanya saat encode. Selisih maks tepi teks
   turun dari 93 ke 15 level, dengan biaya +19–29% waktu render; tetap 0,35× realtime `[PF]`.
   **Butuh persetujuan owner.**
8. **K8. Semua gaya caption dan 9 desain hook adalah ASS murni** (libass di dua sisi). Gradien
   memakai 16 pita alpha bertingkat. Emoji selalu overlay PNG (Noto, Apache-2.0), karena libass
   produksi menggambar kotak tofu `[R2]`.
9. **K9. Audio memakai envelope gain eksplisit** untuk ducking, fade, micro-fade 8 ms dan mute.
   - Galat FFmpeg lawan WebAudio −148,6 sampai −153 dB `[INC-E3b]` `[UX-M5]`.
   - Loudness dua pass ke −14 LUFS, output 48 kHz.
   - Bila limiter aktif, pratinjau memakai audio master dari server (kelas D).
10. **K10. AI hanya menyarankan, pengguna yang memutuskan.**
    - Saran heuristik muncul ≤ 300 ms. LLM gratis berjalan async (prompt ≤ 3k token) dengan
      grounding ketat.
    - "Rapikan" berbentuk **daftar tinjauan**, karena 78% jeda panjang ternyata tidak hening
      `[UX-M2]`.
    - "Padatkan ke N detik" adalah alat pemadat utama.
11. **K11. Keamanan.**
    - Unggahan selalu dinormalisasi FFmpeg: demuxer dipaksa, protocol whitelist, tanpa SVG, tanpa
      font.
    - COOP/COEP/CSP di rute editor. Sesi bisa dicabut.
    - Klien tidak pernah mengirim ASS atau filtergraph.
12. **K12. Tahapan.**
    - **Tahap 1** = setara LokaClip pada klip V3, plus keunggulan yang tidak dimiliki LokaClip:
      cold open, edit transkrip, ducking, emoji, marker tawa, dan saran hook AI.
    - **Tahap 2** = inti multi-track CapCut (Mode Pro).
    - **Tahap 3** = keyframe, transisi, dan efek.
    - Setiap fitur terkunci flag sampai gate-nya hijau.

### 1.2 Decision summary (English)

No proposal wins outright. **Parity-first** is the strongest architecture for the owner's first
requirements, "preview = final render" and "jangan menurunkan kualitas". **Incremental** is the
safest delivery plan. **UX-first** is the most complete interaction design. The final design
combines them:

1. **D1. Architecture from parity-first, delivery from incremental, interaction model from
   UX-first.** The architecture is one integer document, one resolver, and one RenderPlan executed
   by two backends. The delivery is a strangler with feature flags and numeric gates at every step.
   The interaction model puts the transcript at the centre, with a fast mode (Cepat) and a Pro mode.
2. **D2. One resolver: `edit-core`.** It is pure ESM JavaScript with zero npm runtime dependencies;
   harfbuzz WASM is vendored.
   - The same resolver runs in the browser (instant preview) and in the Node 20 that **every
     container already has**, because the image base is `node:20-bookworm-slim` `[REPO]`.
   - Python stays **stdlib-only** (`dependencies = []` `[REPO]`). It owns storage, queue, the
     plan→argv compiler, execution, verification and analysis.
   - The two ASS generators and two layout builders that exist today `[R1]` both disappear.
3. **D3. Integer-only `clip-edit-v2`.**
   - Video cut points are source-grid frames (`_sf`) at the output fps. Words are source ms.
     Geometry is in e5 (fractions ×100,000). Gain is in centi-dB.
   - Words live in an immutable, sha-pinned `potongin.words/1` artifact, so a document is 8–12 KB
     and autosave is cheap.
   - Items can be **anchored to words**, so they follow ripple edits.
4. **D4. Canonical frame grid and frame-safe ASS timing.** Both are measured facts:
   - Today's `render.py` seeking picks a different source frame for **49.6%** of frames against
     **0/1,125** with the grid rule `[PF]` (and 40/60 against 60/60 `[INC-E6]`).
   - JASSUB **rounds** time while FFmpeg's `ass` filter **truncates**, which is a one-frame karaoke
     mismatch. The frame-safe centisecond rule has **0 failures** at 8 frame rates `[PF]`.
5. **D5. The preview parity ladder: N → D → B → T.**
   - N: a native WebGL2 op, shown only after its golden gate passes.
   - D: a derived asset whose bytes both sides share.
   - B: a server-baked span from the same compiler.
   - T: a server truth frame on pause.

   **An approximate pixel is never shown.** An op that has not passed its gate still ships through
   B: slower, never wrong.
6. **D6. The V3 auto render moves onto the new engine before any UI ships.** The AI clip becomes
   revision 0, and export-without-edits is framemd5-identical to it by construction.
7. **D7. The server composites in yuv444p and converts to yuv420p only for the encode.** Text-edge
   max diff drops from 93 to 15 levels for +19–29% render time, still 0.35× realtime `[PF]`.
   **Owner approval needed.**
8. **D8. Every caption pack and all 9 hook designs are pure ASS**, drawn by libass on both sides.
   Gradients are 16 stepped alpha bands. Emoji are always PNG overlays (Noto, Apache-2.0), because
   production libass draws tofu `[R2]`.
9. **D9. Audio uses explicit gain envelopes** for ducking, fades, 8 ms join micro-fades and mutes.
   - FFmpeg against WebAudio error is −148.6 to −153 dB.
   - Loudness is two-pass to −14 LUFS, with 48 kHz output.
   - When the limiter engages, the preview plays the server's mastered audio (class D).
10. **D10. AI suggests; the user decides.**
    - A heuristic suggestion arrives within 300 ms. Free-tier LLM results follow asynchronously
      (prompts ≤ 3k tokens) with strict grounding.
    - "Rapikan" (tidy up) is a **review list**, because 78% of long gaps are not silent `[UX-M2]`.
    - "Padatkan ke N detik" (condense to N seconds) is the main tightening tool.
11. **D11. Security.**
    - Uploads are always normalised by FFmpeg, with a forced demuxer and a protocol whitelist; SVG
      and font uploads are refused.
    - Editor routes send COOP, COEP and a CSP. Sessions become revocable.
    - The client never sends ASS or a filtergraph.
12. **D12. Stages.**
    - **Stage 1** is LokaClip parity on V3 clips, plus what LokaClip lacks: cold open, transcript
      editing, ducking, emoji, laughter markers and AI hooks.
    - **Stage 2** is the CapCut multi-track core (Mode Pro).
    - **Stage 3** is keyframes, transitions and effects.
    - Every feature sits behind a flag until its gates are green.

---

## 2. Scorecard

Scores are 1–10. The weighted total counts parity ×2, because it is the owner's explicit
requirement, and completeness and feasibility ×1.5 each.

| Criterion | Weight | Parity-first | Incremental | UX-first |
|---|---|---|---|---|
| Output quality and preview/render parity | ×2 | **10** | 8 | 7 |
| Feature completeness vs CapCut + LokaClip | ×1.5 | 9 | 7 | **10** |
| Feasibility (Python stdlib + FFmpeg, Next 16 / React 19, CPU-only) | ×1.5 | 6 | **8** | 7 |
| Security | ×1 | 9 | 9 | 9 |
| Incremental shippability | ×1 | 6 | **10** | 7 |
| Maintainability | ×1 | **8** | **8** | 6 |
| **Unweighted (out of 60)** | | 48 | **50** | 46 |
| **Weighted (out of 80)** | | **65.5** | **65.5** | 61.5 |

### 2.1 Parity-first: why it scored this way, and what the final design takes

- **Parity 10.**
  - It is the only proposal that found and fixed the ASS time-conversion hazard: FFmpeg truncates,
    JASSUB rounds, and at 30 fps 7,328 frames in 3 h are hazards.
  - It proved frame identity on CFR, VFR and two FFmpeg versions, and measured the yuv444p text gain.
  - It adds deterministic maths, a plan-hash handshake and a cross-engine hash test.
- **Completeness 9.** It covers M1–M17 and S1–S16. It lacks word-anchored items and the voiced-gap
  finding, so its default "shorten gaps 600→200 ms" would cut real speech in 78% of cases.
- **Feasibility 6.** It is about 12–17k LOC of specialised code: a JS core, a single-canvas WebGL2
  engine, forked JASSUB glue and its own YUV conversion. It needs 8–10 person-weeks before any user
  sees a change. It is sound on this stack, because Node is in every container.
- **Shippability 6.** The first editor ships only after Stage 0 and Stage 1a, about 20 pw.
- **Maintainability 8.** A single implementation of every decision is the dominant factor. Lint bans
  on non-deterministic maths keep it honest.
- **Taken:**
  - D1 single core, D2 integers, D3 grid, D4 frame-safe timing, D5 yuv444p, D6 and D7 as spikes;
  - D9 sendcmd, D12 native fps, D13 handshake, D14 flags with evidence;
  - the op catalog, the golden-suite design, the compile contract, the render key, the verify gates
    and the fontconfig lockdown.
- **Changed:**
  - UX-first's pure-ASS hook designs replace its PNG generator;
  - `web/app/_parity` is not routable in Next.js (`_` folders are private), so the harness moves;
  - breakpoint envelopes plus WebAudio ramps replace its per-sample AudioWorklet (same gate, far less
    code);
  - Python expands envelopes, so Node is not on the per-sample path.

### 2.2 Incremental: why it scored this way, and what the final design takes

- **Parity 8.**
  - Plates and bakes are FFmpeg pixels, which is exact by construction.
  - But the preview shows 720p re-encoded plates (crop-mode SSIM 0.9896 against lossless,
    `[INC-E1]`, below the 0.99 composite gate it then made relative).
  - It passes `mediaTime = f/fps` to JASSUB, which is the rounding hazard.
- **Completeness 7.** Every feature exists on paper. But keyframes, transitions, effects and B-roll
  video all wait on server bakes (≤ 1.5 s per edit), and animated items are banned above the
  captions. Neither is a CapCut-level experience.
- **Feasibility 8.** It has a narrow engine (1.5–2k LOC) and reuses code by strangling it. The costs
  are plate CPU per layout edit and a non-stdlib `uharfbuzz` in Phase 2.
- **Shippability 10.** Phase 0 is about 3 ew. Each step is one PR behind a flag, and existing tests
  stay green.
- **Maintainability 8.** It is Python-canonical, with a JS mirror of the time map and the parity-class
  registry, plus cache-key invalidation logic.
- **Taken:**
  - the strangler and flag discipline, and the Phase-0 hardening (receipt pruning, render key,
    scaled timeout, `-progress` liveness, asset root, hard-link source snapshot);
  - the interactive lane in the `app` container;
  - one decoder per monotonic run `[INC-E4]`;
  - the camera path via sendcmd `[INC-E2]`;
  - **class B baked spans that exclude the text band**;
  - the promotion rule with a shadow sentinel, and "hold the last exact frame, never guess";
  - the virtual seed as revision 0 (no side-effecting GET).

### 2.3 UX-first: why it scored this way, and what the final design takes

- **Parity 7.**
  - Its graph uses float `-ss` + `setpts` reset + `fps=round=near`, the family PF measured at
    49.6% frame mismatch against a grid proxy.
  - It has floats in the document (`x: 0.78`, `gain_db: -14`), two implementations kept in sync by
    vectors, three unsynchronised canvases, and no ASS time-hazard handling.
- **Completeness 10.** It is the only proposal with full interaction specs:
  - Mode Cepat and Pro;
  - the transcript panel; Rapikan with measured gap classes; condense; word anchors;
  - the "Perlu dicek" warning list;
  - apply-all with a diff; A/B history wipe; a keyboard map; latency budgets;
  - the derived-asset rule for speed and denoise;
  - a UX acceptance protocol.
- **Feasibility 7.** The WebGL2 engine, a JS port of captions, hooks and anchors, and a canonical
  Python side all have to be built.
- **Shippability 7.**
- **Maintainability 6.** It keeps two implementations of the time map, anchors, captions, ASS,
  camera sampling, envelopes and snapping in sync forever (≥ 500 vectors).
- **Taken:**
  - the whole interaction model (§9), the words artifact, segment-scoped removals and word anchors;
  - Rapikan classes and the condense AI; "Perlu dicek"; pure-ASS hook designs;
  - the derived-asset rule (our class D); apply-all; the UX acceptance protocol (QG-UX);
  - the latency budgets, and the auto-render `<video>` fallback while the proxy builds;
  - raw-body uploads with PNG ancillary-chunk stripping in stdlib.

**Tie-break.** The two weighted totals tie. The base is **parity-first's architecture**, because it is
the only one of the three whose preview scales to CapCut-level live editing (dragging a keyframe or a
reframe box) without a second resolver or a server round trip per drag. Its weaknesses, cost and a
late first ship, are exactly what incremental's delivery plan and class-B safety net fix.

---

## 3. Architecture

```
                    V3 pipeline (primary-worker, Node → Python)
 transcript.json ─┐   words_artifact.py ─► analysis/clips/<clip>/words.<sha>.json   (potongin.words/1)
 selection.v3.json┤   camera_plan.py    ─► analysis/clips/<clip>/camera.<sha>.json  (potongin.camera-plan/1)
 audio-timeline ──┤   media_prep.py     ─► window proxy (grid), peaks, filmstrip
 sound-events ────┘   seed_inputs.py ──► node edit-core seed ─► revision 0 (virtual)
                                                                  │
                  ┌───────────────────────────────────────────────┴───────────────┐
                  ▼                                                               ▼
   Browser (Chrome/Edge ≥ 120)                                   Server (Node route + Python, CPU)
   ┌──────────────────────────────────┐                          ┌──────────────────────────────────┐
   │ UI (React 19, Next 16)           │  PUT If-Match +          │ route: edit-core validate/canon/ │
   │  commands (edit-core, Immer)     │  X-Plan-Sha256 ────────► │  plan hash (in-process ESM)      │
   │  timeline · transcript · gizmos  │                          │ python edit_v2.api put (locks,   │
   │ engine worker (OffscreenCanvas)  │                          │  receipts, archive)              │
   │  edit-core resolve → RenderPlan  │  truth frame / bake /    │ preview lane (app ctr, sem 2):   │
   │  Mediabunny decode (grid proxy)  │  audio span  ──────────► │  compile(frame|segment|audio)    │
   │  WebGL2 ops (N) · libass WASM    │                          │ render-worker: node cli plan →   │
   │  bake spans (B) · derived (D)    │                          │  compile_ffmpeg → FFmpeg 5.1.9 → │
   │  WebAudio clock + gain ramps     │                          │  verify G1–G5 → publish          │
   │  sentinel SSIM vs truth (T)      │                          └──────────────────────────────────┘
   └──────────────────────────────────┘
          both backends execute the SAME RenderPlan bytes (plan_sha256), golden-tested per op
```

### 3.1 Where code lives

| Area | Path | Notes |
|---|---|---|
| Single resolver | `web/lib/edit-core/**` | Pure ESM; no DOM or Node-only APIs; no npm runtime deps. Vendored `vendor/harfbuzz/{hb.wasm,hbjs.mjs}` (harfbuzzjs 1.6.2, MIT, sha-pinned). Build-time: ajv 8.20.0 standalone validators. Reached at `/app/lib/edit-core/cli.mjs` in the image, because `COPY web/lib ./lib` already exists `[REPO]` |
| Browser engine | `web/lib/preview/**` | Worker, decoder pool, WebGL2 ops, libass adapter, audio graph, bake source, truth frame, sentinel |
| Editor client state | `web/lib/editor/**` | Store, history, autosave, IndexedDB draft, rebase, API client, shortcuts, flags |
| Server glue (Node) | `web/lib/studio-server/**` | Edit bridge, preview lane, media serving, asset upload, AI bridge, security headers |
| UI | `web/app/projects/[id]/clips/[clipId]/edit/page.jsx`, `web/components/studio/**` | Mode Cepat (Stage 1) and Mode Pro (Stage 2) |
| API routes | `web/app/api/jobs/[id]/clips/**`, `…/assets/**`, `…/media/**`, `web/app/api/workspace/**`, `web/app/api/resources/**` | §7.2 |
| Python engine | `src/ai_clipper/edit_v2/**`, `src/ai_clipper/versioned_store.py`, `src/ai_clipper/editor_ai.py` | Stdlib only. OpenCV (existing `vision` extra) only for face analysis |
| Resources in the image | `resources/{fonts,fontconfig,stylepacks,hook-designs,text-presets,templates,emoji,lexicon,music,sfx,models}/`, `resources/flags.json` | Immutable and versioned; `Dockerfile` gains `COPY resources ./resources` |
| Tests | `tests/edit_v2/**`, `tests/fixtures/edit-v2/**`, `tests/golden/**`, `tests/security/upload-fuzz/**`, `web/tests/{edit-core,preview,studio}-*.test.mjs`, `web/e2e/studio-*.spec.mjs`, `web/e2e/parity.spec.mjs`, `scripts/parity/**` | |

### 3.2 Flows

| Flow | Path |
|---|---|
| Edit | A UI command runs an edit-core command (Immer `produceWithPatches`). The time map and lightweight derived data are recomputed on the main thread (≤ 2 ms). The engine worker re-resolves the plan (≤ 16 ms for a 90 s clip) and uploads the changed parts. Autosave then sends a `PUT` with `If-Match` and `X-Plan-Sha256`. |
| Preview | Output frame n maps to a piece, then a source-grid frame, then a proxy frame by **index**. WebGL2 ops and libass bitmaps render at `nowMs(n)`, and the presenter shows the frame on the AudioContext clock. |
| Truth frame | Paused 250 ms → `POST …/preview/frame {doc\|etag, f, res}`. The Node route validates and plans with edit-core in-process, then Python `preview_cli frame` renders a PNG with colour chunks stripped. The sentinel computes SSIM. |
| Final render | `POST …/renders {etag, preset}` enqueues a render. The worker runs `node cli.mjs plan` (plan + sidecars), then `compile_ffmpeg`, `execute`, `verify` (G1–G5), and publishes `output/edits/<clip_id>/<render_key16>.mp4`. |
| Auto render (V3) | `pipeline.py` (V3 path) runs `seed_inputs` → `node cli.mjs seed` → the same render path, synchronously. `render_vertical()` becomes a wrapper behind `POTONGIN_RENDER_ENGINE=v2`. |

### 3.3 Process placement (CPU-only box)

| Work | Where | Limits |
|---|---|---|
| Final renders | `render-worker` (4 CPUs), one at a time; priority export > background | Timeout `max(120 s, 3 × predicted)` with a per-op cost model; `-progress` must advance within 20 s |
| Truth frames, bake spans, audio spans, annex measurement | `app` container (6 CPUs, mostly idle) via `web/lib/studio-server/preview-jobs.mjs` → `python -m ai_clipper.edit_v2.preview_cli` | Semaphore 2, `nice 5`, `-threads 2`; cancelled when superseded by a newer plan hash. A separate `preview-worker` service is added **only if** web p95 latency degrades by more than 50 ms under load (measured in Stage 1 W1) |
| Window proxies, peaks, filmstrips, words artifacts, camera plans | `primary-worker` job queue, after the auto renders, at `nice 10` | 12 clips ≤ 2 min CPU per job |

---

## 4. Data model

### 4.1 Units and conventions (integers only; floats are rejected at parse time)

| Suffix | Unit | Example |
|---|---|---|
| `_sf` | Source-grid frame: frame *k* of `fps=output.fps` applied to the source from t = 0 | `in_sf: 37215` |
| `_f` | Output frame at `output.fps` | `dur_f: 120` |
| `_ms` | Source milliseconds (words, audio-only offsets) | `start_ms: 1241930` |
| `_smp` | 48 kHz sample | `src_in_smp: 0` |
| `_e5` | Fraction ×100,000 of the **design space** width or height (1080×1920 for 9:16), or of the source width or height for crops | `x_e5: 50000` is the centre |
| `_pm` | Per-mille (1000 = 100%) | `opacity_pm: 850` |
| `_cdb` | Centi-dB | `gain_cdb: -1800` |
| `_cdeg` | Centi-degrees | `rot_cdeg: -400` |
| `_clufs` | Centi-LUFS | `target_clufs: -1400` |
| `fps` | `[num, den]` with `den ∈ {1, 1001}` | `[30000, 1001]` |
| Colours | `#RRGGBB` or `#RRGGBBAA`, uppercase | `#FFE14D` |
| IDs | `^[a-z]{2,3}_[0-9a-z]{1,16}$` for items, segments, removals and tracks; words `w` + 6–7 digit global transcript index; assets `sha256:<64 hex>`; emoji `emoji:<cp>[-<cp>]` | `it_emoji1`, `w048121` |

Text rules (kept from V1 `[R1]`):
- NFC only, with no Cc/Cs characters.
- Hook text ≤ 90 characters, text item ≤ 300, word display text ≤ 40.
- Canonical bytes are sorted keys with no whitespace (`ensure_ascii=False`), and a document is
  **≤ 1 MiB**.
- Unknown keys are rejected at every level.

### 4.2 `clip-edit-v2` JSON Schema (2020-12, excerpt)

Source of truth: `web/lib/edit-core/schema/clip-edit-v2.schema.json`. The validator is generated
with ajv 8.20.0 `standalone` (no `eval`, CSP-safe) into `schema/validate.generated.mjs`. Python never
re-implements validation; it re-parses strictly (integers only, canonical bytes equal, size) and
stores the document.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://potongin.local/schema/clip-edit-v2.schema.json",
  "title": "Potongin clip edit document v2",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema", "schema_minor", "clip_id", "revision", "parent_sha256", "base", "output",
               "main", "captions", "layout", "tracks", "audio", "assets", "packaging", "export", "audit"],
  "properties": {
    "schema": {"const": "clip-edit-v2"},
    "schema_minor": {"type": "integer", "minimum": 0, "maximum": 99},
    "clip_id": {"type": "string", "pattern": "^clip_[0-9a-f]{24}$"},
    "revision": {"type": "integer", "minimum": 0},
    "parent_sha256": {"oneOf": [{"$ref": "#/$defs/sha256"}, {"type": "null"}]},
    "base": {"$ref": "#/$defs/base"},
    "output": {
      "type": "object", "additionalProperties": false,
      "required": ["w", "h", "fps", "sample_rate", "channels", "safe_zone"],
      "properties": {
        "w": {"enum": [720, 1080]}, "h": {"enum": [1280, 1920]},
        "fps": {"$ref": "#/$defs/fps"},
        "sample_rate": {"const": 48000}, "channels": {"const": 2},
        "safe_zone": {"enum": ["tiktok", "reels", "shorts", "none"]}
      }
    },
    "main": {
      "type": "object", "additionalProperties": false,
      "required": ["segments", "removals", "joins", "intro_hold_f", "cut_fade_ms"],
      "properties": {
        "segments": {"type": "array", "minItems": 1, "maxItems": 200, "items": {"$ref": "#/$defs/segment"}},
        "removals": {"type": "array", "maxItems": 2000, "items": {"$ref": "#/$defs/removal"}},
        "joins": {"type": "array", "maxItems": 199, "items": {"$ref": "#/$defs/join"}},
        "intro_hold_f": {"type": "integer", "minimum": 0, "maximum": 120},
        "cut_fade_ms": {"type": "integer", "minimum": 0, "maximum": 50}
      }
    },
    "captions": {"$ref": "#/$defs/captions"},
    "layout": {"$ref": "#/$defs/layout"},
    "tracks": {"type": "array", "maxItems": 16, "items": {"$ref": "#/$defs/track"}},
    "audio": {"$ref": "#/$defs/audio"},
    "assets": {"type": "object", "maxProperties": 200,
               "propertyNames": {"pattern": "^sha256:[0-9a-f]{64}$"},
               "additionalProperties": {"$ref": "#/$defs/assetMeta"}},
    "markers": {"type": "array", "maxItems": 200, "items": {"$ref": "#/$defs/marker"}},
    "packaging": {"$ref": "#/$defs/packaging"},
    "export": {"$ref": "#/$defs/export"},
    "template_ref": {"oneOf": [{"type": "null"}, {"$ref": "#/$defs/templateRef"}]},
    "audit": {"$ref": "#/$defs/audit"}
  },
  "$defs": {
    "sha256": {"type": "string", "pattern": "^[0-9a-f]{64}$"},
    "id": {"type": "string", "pattern": "^[a-z]{2,3}_[0-9a-z]{1,16}$"},
    "wordId": {"type": "string", "pattern": "^w[0-9]{6,7}$"},
    "sf": {"type": "integer", "minimum": 0, "maximum": 2592000, "$comment": "≤ 24 h at 30 fps"},
    "f": {"type": "integer", "minimum": 0, "maximum": 36000, "$comment": "≤ 600 s at 60 fps"},
    "e5": {"type": "integer", "minimum": -50000, "maximum": 150000},
    "pm": {"type": "integer", "minimum": 0, "maximum": 4000},
    "cdb": {"type": "integer", "minimum": -9600, "maximum": 2400},
    "color": {"type": "string", "pattern": "^#[0-9A-F]{6}([0-9A-F]{2})?$"},
    "fps": {"type": "array", "minItems": 2, "maxItems": 2,
            "prefixItems": [{"enum": [24, 25, 30, 24000, 30000]}, {"enum": [1, 1001]}]},
    "resourceRef": {"type": "object", "additionalProperties": false, "required": ["id", "v", "sha256"],
                    "properties": {"id": {"type": "string", "pattern": "^[a-z0-9-]{2,40}$"},
                                   "v": {"type": "integer", "minimum": 1},
                                   "sha256": {"$ref": "#/$defs/sha256"}}},
    "segment": {
      "type": "object", "additionalProperties": false, "required": ["id", "role", "src", "in_sf", "out_sf"],
      "properties": {"id": {"$ref": "#/$defs/id"},
                     "role": {"enum": ["cold_open", "body", "insert"], "$comment": "insert = Stage 2"},
                     "src": {"const": "S"},
                     "in_sf": {"$ref": "#/$defs/sf"}, "out_sf": {"$ref": "#/$defs/sf"},
                     "speed": {"$ref": "#/$defs/speed", "$comment": "Stage 2, class D"}}
    },
    "removal": {
      "type": "object", "additionalProperties": false,
      "required": ["id", "seg", "in_sf", "out_sf", "words", "reason", "origin"],
      "properties": {"id": {"$ref": "#/$defs/id"}, "seg": {"$ref": "#/$defs/id"},
                     "in_sf": {"$ref": "#/$defs/sf"}, "out_sf": {"$ref": "#/$defs/sf"},
                     "words": {"type": "array", "maxItems": 400, "items": {"$ref": "#/$defs/wordId"}},
                     "reason": {"enum": ["user", "gap_silent", "gap_voiced", "filler", "repeat",
                                         "ai_condense", "timeline"]},
                     "origin": {"type": "string", "pattern": "^(user|seed|template:[a-z0-9-]{2,40}|suggestion:[a-z]{2,3}_[0-9a-z]{1,16})$"}}
    },
    "join": {
      "type": "object", "additionalProperties": false, "required": ["after", "style", "dur_f", "audio_fade_ms"],
      "properties": {"after": {"$ref": "#/$defs/id"},
                     "style": {"enum": ["cut", "flash_white", "dip_black", "xfade"],
                               "$comment": "xfade = Stage 3 (needs 'transition')"},
                     "dur_f": {"type": "integer", "minimum": 0, "maximum": 30},
                     "audio_fade_ms": {"type": "integer", "minimum": 0, "maximum": 250},
                     "transition": {"enum": ["fade", "fadeblack", "fadewhite", "wipeleft", "wiperight",
                                             "wipeup", "wipedown", "slideleft", "slideright", "slideup",
                                             "slidedown", "circleopen", "circleclose", "smoothleft",
                                             "smoothright", "smoothup", "smoothdown"]}}
    },
    "anchor": {"oneOf": [
      {"type": "object", "additionalProperties": false, "required": ["at", "f"],
       "properties": {"at": {"const": "out"}, "f": {"$ref": "#/$defs/f"}}},
      {"type": "object", "additionalProperties": false, "required": ["at"],
       "properties": {"at": {"enum": ["clip_start", "clip_end"]}}},
      {"type": "object", "additionalProperties": false, "required": ["at", "word", "edge"],
       "properties": {"at": {"const": "word"}, "word": {"$ref": "#/$defs/wordId"},
                      "edge": {"enum": ["start", "end"]},
                      "offset_f": {"type": "integer", "minimum": -600, "maximum": 600},
                      "seg": {"$ref": "#/$defs/id"}}}]},
    "transform": {
      "type": "object", "additionalProperties": false, "required": ["x_e5", "y_e5"],
      "properties": {"x_e5": {"$ref": "#/$defs/e5"}, "y_e5": {"$ref": "#/$defs/e5"},
                     "w_e5": {"type": "integer", "minimum": 500, "maximum": 100000},
                     "scale_pm": {"type": "integer", "minimum": 100, "maximum": 4000},
                     "rot_cdeg": {"type": "integer", "minimum": -18000, "maximum": 18000},
                     "opacity_pm": {"type": "integer", "minimum": 0, "maximum": 1000}}
    },
    "keyframes": {
      "type": "object", "additionalProperties": false, "$comment": "Stage 3",
      "propertyNames": {"enum": ["x_e5", "y_e5", "w_e5", "scale_pm", "rot_cdeg", "opacity_pm",
                                 "crop_x_e5", "crop_y_e5", "gain_cdb"]},
      "additionalProperties": {"type": "array", "minItems": 1, "maxItems": 600, "items": {
        "type": "object", "additionalProperties": false, "required": ["f", "v", "ease"],
        "properties": {"f": {"$ref": "#/$defs/f"}, "v": {"type": "integer"},
                       "ease": {"type": "string",
                                "pattern": "^(hold|linear|in|out|in_out|bezier:-?[0-9]{1,6},-?[0-9]{1,6},-?[0-9]{1,6},-?[0-9]{1,6})$"}}}}
    },
    "track": {
      "type": "object", "additionalProperties": false, "required": ["id", "kind", "items"],
      "properties": {"id": {"$ref": "#/$defs/id"},
                     "kind": {"enum": ["visual", "text", "hook", "audio"]},
                     "band": {"enum": ["under_text", "over_text"], "$comment": "visual tracks only"},
                     "role": {"enum": ["broll", "overlay", "music", "sfx", "voice"]},
                     "locked": {"type": "boolean"}, "hidden": {"type": "boolean"}, "muted": {"type": "boolean"},
                     "items": {"type": "array", "maxItems": 64, "items": {"$ref": "#/$defs/item"}}}
    },
    "item": {
      "type": "object", "required": ["id", "type", "start"],
      "properties": {"id": {"$ref": "#/$defs/id"},
                     "type": {"enum": ["hook", "text", "credit", "label", "sticker", "emoji", "image",
                                       "video", "audio", "effect"]},
                     "start": {"$ref": "#/$defs/anchor"}, "end": {"$ref": "#/$defs/anchor"},
                     "dur_f": {"type": "integer", "minimum": 1, "maximum": 36000},
                     "transform": {"$ref": "#/$defs/transform"},
                     "anim": {"type": "object", "additionalProperties": false,
                              "properties": {"in": {"enum": ["none", "fade", "pop", "slide_up"]},
                                             "out": {"enum": ["none", "fade", "pop", "slide_down"]},
                                             "in_f": {"type": "integer", "minimum": 0, "maximum": 30},
                                             "out_f": {"type": "integer", "minimum": 0, "maximum": 30}}},
                     "kf": {"$ref": "#/$defs/keyframes"},
                     "safe_override": {"type": "boolean"},
                     "origin": {"type": "string", "maxLength": 80},
                     "payload": {"type": "object"}},
      "$comment": "payload is validated per type by discriminated sub-schemas (hookPayload, textPayload, mediaPayload, audioPayload, …); exactly one of end / dur_f"
    },
    "hookPayload": {
      "type": "object", "additionalProperties": false, "required": ["text", "design"],
      "properties": {"text": {"type": "string", "minLength": 1, "maxLength": 90},
                     "design": {"$ref": "#/$defs/resourceRef"},
                     "params": {"type": "object", "additionalProperties": false,
                                "properties": {"accent": {"$ref": "#/$defs/color"},
                                               "label": {"type": "string", "maxLength": 24},
                                               "tilt_cdeg": {"type": "integer", "minimum": -1500, "maximum": 1500}}},
                     "emphasis": {"type": "array", "maxItems": 12,
                                  "items": {"type": "integer", "minimum": 0, "maximum": 30}},
                     "timing": {"enum": ["fixed", "cold_open", "persist"]}}
    },
    "mediaPayload": {
      "type": "object", "additionalProperties": false, "required": ["asset", "mode"],
      "properties": {"asset": {"type": "string", "pattern": "^(sha256:[0-9a-f]{64}|emoji:[0-9a-f]{4,6}(-[0-9a-f]{4,6}){0,4})$"},
                     "mode": {"enum": ["pip", "cutaway", "split_top", "split_bottom", "free"]},
                     "fit": {"enum": ["cover", "contain"]},
                     "src_in_f": {"$ref": "#/$defs/f"},
                     "radius_e5": {"type": "integer", "minimum": 0, "maximum": 20000},
                     "border": {"type": "object", "additionalProperties": false,
                                "properties": {"w_e5": {"type": "integer", "minimum": 0, "maximum": 2000},
                                               "color": {"$ref": "#/$defs/color"}}},
                     "gain_cdb": {"$ref": "#/$defs/cdb"}, "mute": {"type": "boolean"}}
    },
    "audioPayload": {
      "type": "object", "additionalProperties": false, "required": ["asset", "gain_cdb"],
      "properties": {"asset": {"type": "string", "pattern": "^sha256:[0-9a-f]{64}$"},
                     "src_in_smp": {"type": "integer", "minimum": 0}, "loop": {"type": "boolean"},
                     "gain_cdb": {"$ref": "#/$defs/cdb"},
                     "fade_in_f": {"type": "integer", "minimum": 0, "maximum": 300},
                     "fade_out_f": {"type": "integer", "minimum": 0, "maximum": 300},
                     "duck": {"type": "object", "additionalProperties": false,
                              "required": ["on", "depth_cdb", "attack_ms", "release_ms", "hold_ms", "detector"],
                              "properties": {"on": {"type": "boolean"},
                                             "depth_cdb": {"type": "integer", "minimum": 300, "maximum": 2400},
                                             "attack_ms": {"type": "integer", "minimum": 5, "maximum": 500},
                                             "release_ms": {"type": "integer", "minimum": 50, "maximum": 2000},
                                             "hold_ms": {"type": "integer", "minimum": 0, "maximum": 1000},
                                             "detector": {"enum": ["words", "rms"]}}}}
    },
    "captions": {
      "type": "object", "additionalProperties": false,
      "required": ["enabled", "pack", "overrides", "offset_ms", "word_edits", "breaks"],
      "properties": {"enabled": {"type": "boolean"}, "pack": {"$ref": "#/$defs/resourceRef"},
                     "overrides": {"type": "object", "additionalProperties": false,
                                   "properties": {"y_e5": {"$ref": "#/$defs/e5"},
                                                  "size_pm": {"type": "integer", "minimum": 700, "maximum": 1600},
                                                  "case": {"enum": ["upper", "lower", "asis", "sentence"]},
                                                  "highlight": {"$ref": "#/$defs/color"},
                                                  "words_per_chunk": {"type": "integer", "minimum": 1, "maximum": 8},
                                                  "max_lines": {"type": "integer", "minimum": 1, "maximum": 3},
                                                  "anim": {"enum": ["none", "fade", "pop", "bump", "slam", "glow", "neon", "comic", "box_pop"]}}},
                     "offset_ms": {"type": "integer", "minimum": -300, "maximum": 300},
                     "word_edits": {"type": "object", "maxProperties": 6000,
                                    "propertyNames": {"pattern": "^w[0-9]{6,7}$"},
                                    "additionalProperties": {"type": "object", "additionalProperties": false,
                                      "properties": {"text": {"type": "string", "minLength": 1, "maxLength": 40},
                                                     "hidden": {"type": "boolean"}, "emphasis": {"type": "boolean"},
                                                     "emoji_after": {"type": "string", "pattern": "^[0-9a-f]{4,6}(-[0-9a-f]{4,6}){0,4}$"},
                                                     "start_ms": {"type": "integer", "minimum": 0},
                                                     "end_ms": {"type": "integer", "minimum": 0}}}},
                     "breaks": {"type": "object", "maxProperties": 2000,
                                "propertyNames": {"pattern": "^w[0-9]{6,7}$"},
                                "additionalProperties": {"enum": ["cue", "line", "none"]}}}
    },
    "layout": {
      "type": "object", "additionalProperties": false, "required": ["default", "ranges", "camera"],
      "properties": {"default": {"type": "object", "additionalProperties": false, "required": ["mode", "no_face"],
                                 "properties": {"mode": {"$ref": "#/$defs/layoutMode"},
                                                "no_face": {"enum": ["fail", "fit_blur"]}}},
                     "ranges": {"type": "array", "maxItems": 100, "items": {
                       "type": "object", "additionalProperties": false, "required": ["id", "from_sf", "to_sf", "mode"],
                       "properties": {"id": {"$ref": "#/$defs/id"}, "from_sf": {"$ref": "#/$defs/sf"},
                                      "to_sf": {"$ref": "#/$defs/sf"}, "mode": {"$ref": "#/$defs/layoutMode"},
                                      "params": {"type": "object"}}}},
                     "camera": {"type": "object", "additionalProperties": false, "required": ["plan_sha256", "manual_keys", "seat_force"],
                                "properties": {"plan_sha256": {"oneOf": [{"$ref": "#/$defs/sha256"}, {"type": "null"}]},
                                               "manual_keys": {"type": "array", "maxItems": 500, "items": {
                                                 "type": "object", "additionalProperties": false, "required": ["sf", "cx_e5", "cy_e5", "ease"],
                                                 "properties": {"sf": {"$ref": "#/$defs/sf"}, "cx_e5": {"$ref": "#/$defs/e5"},
                                                                "cy_e5": {"$ref": "#/$defs/e5"}, "ease": {"enum": ["hold", "linear", "in_out"]}}}},
                                               "seat_force": {"type": "array", "maxItems": 100, "items": {
                                                 "type": "object", "additionalProperties": false, "required": ["from_sf", "to_sf", "seat"],
                                                 "properties": {"from_sf": {"$ref": "#/$defs/sf"}, "to_sf": {"$ref": "#/$defs/sf"},
                                                                "seat": {"type": "string", "pattern": "^[A-D]$"}}}}}},
                     "branded": {"oneOf": [{"type": "null"}, {"$ref": "#/$defs/resourceRef"}]}}
    },
    "layoutMode": {"enum": ["camera", "smart_speaker", "fill_center", "fit_blur", "fit_black", "split", "branded"]},
    "audio": {
      "type": "object", "additionalProperties": false, "required": ["source", "master"],
      "properties": {"source": {"type": "object", "additionalProperties": false, "required": ["gain_cdb", "mute"],
                                "properties": {"gain_cdb": {"$ref": "#/$defs/cdb"},
                                               "mute": {"type": "array", "maxItems": 200, "items": {
                                                 "type": "object", "additionalProperties": false, "required": ["from_f", "to_f"],
                                                 "properties": {"from_f": {"$ref": "#/$defs/f"}, "to_f": {"$ref": "#/$defs/f"}}}}}},
                     "master": {"type": "object", "additionalProperties": false, "required": ["mode", "target_clufs", "tp_cdb"],
                                "properties": {"mode": {"enum": ["normalize", "off"]},
                                               "target_clufs": {"type": "integer", "minimum": -2400, "maximum": -900},
                                               "tp_cdb": {"type": "integer", "minimum": -300, "maximum": 0}}}}
    }
  }
}
```

Stage gating inside the schema: fields marked Stage 2 or Stage 3 exist from `schema_minor: 0`, but
the semantic validator rejects them with `op_disabled` until their flag is on (§6.2). No schema churn
is needed when a stage opens.

The semantic validator also restricts `fps` to the pairs 24/1, 25/1, 30/1, 24000/1001 and
30000/1001, and enforces exactly one of `end` / `dur_f` per item and the per-type payload
sub-schemas.

Checked for this document: the excerpt compiles under ajv 8.20.0 `Ajv2020` in strict mode (with the
unlisted `$defs` stubbed). The §4.3 example validates once its abbreviated hashes are filled in, and
a float `in_sf` is rejected (`final-check/check2.mjs`).

### 4.3 Complete example (a seed plus a few edits, abridged only where `…` appears)

```json
{
  "schema": "clip-edit-v2", "schema_minor": 0,
  "clip_id": "clip_9b2e41c07d3a5f18e6c2a0b4", "revision": 7, "parent_sha256": "4c1d…",
  "base": {
    "job_id": "j_20260924_…",
    "source": {"content_sha256": "e3b0…", "w": 1920, "h": 1080, "native_fps": [30000, 1001], "vfr": false,
               "duration_ms": 3901120, "has_audio": true, "audio_sr": 44100,
               "color": {"matrix": "bt709", "range": "tv", "decided_by": "probe"}},
    "selection": {"artifact_sha256": "…", "selection_version": "selection-v3.0", "rank_at_seed": 3,
                  "hook_unit_id": "S0412", "prompt_version": "llm-select-v1", "source": "llm"},
    "words": {"sha256": "7f0a…", "count": 512},
    "analysis": {"audio_timeline_sha256": "…", "sound_events_sha256": "…", "camera_plan_sha256": "…"},
    "seed_sha256": "…", "core_version_at_seed": "1.0.0", "migrated_from": null
  },
  "output": {"w": 1080, "h": 1920, "fps": [30000, 1001], "sample_rate": 48000, "channels": 2, "safe_zone": "tiktok"},
  "main": {
    "segments": [
      {"id": "seg_co", "role": "cold_open", "src": "S", "in_sf": 38210, "out_sf": 38345},
      {"id": "seg_b1", "role": "body", "src": "S", "in_sf": 37215, "out_sf": 39284}
    ],
    "removals": [
      {"id": "rm_01", "seg": "seg_b1", "in_sf": 37483, "out_sf": 37556, "words": ["w048131", "w048132"],
       "reason": "user", "origin": "user"},
      {"id": "rm_02", "seg": "seg_b1", "in_sf": 37813, "out_sf": 37848, "words": [],
       "reason": "gap_silent", "origin": "suggestion:sug_5"}
    ],
    "joins": [{"after": "seg_co", "style": "flash_white", "dur_f": 3, "audio_fade_ms": 30}],
    "intro_hold_f": 0, "cut_fade_ms": 8
  },
  "captions": {
    "enabled": true, "pack": {"id": "kotak-hitam", "v": 3, "sha256": "…"},
    "overrides": {"y_e5": 66000, "case": "upper"}, "offset_ms": 0,
    "word_edits": {"w048121": {"text": "Ijal"}, "w048140": {"emphasis": true},
                   "w048151": {"hidden": true}, "w048166": {"emoji_after": "1f602"}},
    "breaks": {"w048130": "cue", "w048177": "line"}
  },
  "layout": {
    "default": {"mode": "camera", "no_face": "fail"},
    "ranges": [{"id": "lr_1", "from_sf": 38600, "to_sf": 38900, "mode": "split",
                "params": {"top": "A", "bottom": "B", "divider": "line2"}}],
    "camera": {"plan_sha256": "…", "manual_keys": [{"sf": 37500, "cx_e5": 62000, "cy_e5": 50000, "ease": "in_out"}],
               "seat_force": [{"from_sf": 38000, "to_sf": 38165, "seat": "B"}]},
    "branded": null
  },
  "tracks": [
    {"id": "tr_brl", "kind": "visual", "band": "under_text", "role": "broll", "locked": false, "hidden": false, "items": [
      {"id": "it_br1", "type": "image", "start": {"at": "word", "word": "w048190", "edge": "start"}, "dur_f": 75,
       "transform": {"x_e5": 75000, "y_e5": 20000, "w_e5": 36000, "opacity_pm": 1000},
       "anim": {"in": "fade", "out": "fade", "in_f": 5, "out_f": 5},
       "payload": {"asset": "sha256:9d2e…", "mode": "pip", "fit": "cover", "radius_e5": 1500,
                   "border": {"w_e5": 250, "color": "#FFFFFF"}}, "origin": "user"}]},
    {"id": "tr_hook", "kind": "hook", "items": [
      {"id": "it_hook", "type": "hook", "start": {"at": "out", "f": 0}, "dur_f": 120,
       "transform": {"x_e5": 50000, "y_e5": 13000, "w_e5": 88000},
       "payload": {"text": "Dia ditahan security di film-nya sendiri 😂",
                   "design": {"id": "sticker-label", "v": 2, "sha256": "…"},
                   "params": {"label": "LUCU", "tilt_cdeg": -400}, "emphasis": [4, 5], "timing": "fixed"},
       "origin": "suggestion:sug_2"}]},
    {"id": "tr_txt", "kind": "text", "items": [
      {"id": "it_cr1", "type": "credit", "start": {"at": "clip_start"}, "end": {"at": "clip_end"},
       "transform": {"x_e5": 50000, "y_e5": 90500},
       "payload": {"text": "Source YT : @podkesmas", "style": {"id": "credit-small", "v": 1, "sha256": "…"}},
       "origin": "template:tpl-brand"}]},
    {"id": "tr_ovr", "kind": "visual", "band": "over_text", "role": "overlay", "items": [
      {"id": "it_emoji1", "type": "emoji", "start": {"at": "word", "word": "w048166", "edge": "end"}, "dur_f": 36,
       "transform": {"x_e5": 78000, "y_e5": 58000, "w_e5": 12000}, "anim": {"in": "pop", "out": "fade", "in_f": 5, "out_f": 4},
       "payload": {"asset": "emoji:1f602", "mode": "free"}, "origin": "user"},
      {"id": "it_logo", "type": "image", "start": {"at": "clip_start"}, "end": {"at": "clip_end"},
       "transform": {"x_e5": 90000, "y_e5": 8000, "w_e5": 14000, "opacity_pm": 850},
       "payload": {"asset": "sha256:5c1f…", "mode": "free"}, "origin": "template:tpl-brand"}]},
    {"id": "tr_mus", "kind": "audio", "role": "music", "muted": false, "items": [
      {"id": "it_music", "type": "audio", "start": {"at": "clip_start"}, "end": {"at": "clip_end"},
       "payload": {"asset": "sha256:91aa…", "src_in_smp": 0, "loop": true, "gain_cdb": -1400,
                   "fade_in_f": 15, "fade_out_f": 30,
                   "duck": {"on": true, "depth_cdb": 1000, "attack_ms": 30, "release_ms": 400, "hold_ms": 250,
                            "detector": "words"}}, "origin": "user"}]}
  ],
  "audio": {"source": {"gain_cdb": 0, "mute": []},
            "master": {"mode": "normalize", "target_clufs": -1400, "tp_cdb": -100}},
  "assets": {
    "sha256:5c1f…": {"kind": "image", "mime": "image/png", "w": 512, "h": 512, "scope": "workspace", "license": {"owner": "user"}},
    "sha256:9d2e…": {"kind": "image", "mime": "image/png", "w": 1280, "h": 720, "scope": "job", "license": {"owner": "user"}},
    "sha256:91aa…": {"kind": "audio", "mime": "audio/mp4", "duration_ms": 142000, "lufs_c": -1620, "scope": "library",
                      "license": {"owner": "library", "id": "musik:santai-01", "attribution": "…", "url": "…"}}
  },
  "markers": [{"id": "mk_1", "f": 300, "label": "cek ini"}],
  "packaging": {"title": "…", "description": "…", "hashtags": ["podcastindonesia"], "cover_f": 42,
                "credit": {"channel": "podkesmas", "url": "…"}},
  "export": {"preset": "1080p", "crf": 20, "srt": true, "cover_jpg": true},
  "template_ref": {"id": "tpl-brand", "v": 4, "sha256": "…", "overridden": ["captions.overrides.y_e5"]},
  "audit": {"created_at_ms": 1790000000000, "updated_at_ms": 1790000123456, "editor": "studio/1.0.0",
            "last_command": "AddRemoval"}
}
```

Band and z-order: the render order is the main video, then `under_text` tracks in array order, then
one ASS pass (captions, hook and text items, ordered by libass layers), then `over_text` tracks in
array order. This three-band rule is the same as in all three proposals. Stage 2 relaxes it to free
interleaving through multiple ASS passes (T2.04).

### 4.4 Words artifact `potongin.words/1` (immutable; `analysis/clips/<clip_id>/words.<sha>.json`)

This is UX-first §2.4, converted to integers.

```json
{"schema": "potongin.words/1", "clip_id": "clip_…", "transcript_sha256": "…", "source_content_sha256": "…",
 "range_ms": [1181900, 1370900],
 "words": [{"id": "w048121", "s": 1241930, "e": 1242210, "t": "Ijai", "p_pm": 410, "u": "S0412", "z": false}],
 "units": [{"id": "S0412", "s": 1241930, "e": 1245880, "q": true}],
 "gaps": [{"s": 1244100, "e": 1245320, "class": "voiced", "rms_cdb": -3150}],
 "events": [{"kind": "laughter", "s": 1256800, "e": 1258600, "span": "estimated", "src": "yt-caption"}],
 "silences": [[1261330, 1262490]], "scene_cuts_ms": [1263040],
 "peaks": {"file": "media/peaks.dat", "per_sec": 100}}
```

- **Words.** `id` is `w` plus the zero-padded global word index, stable for a given
  `transcript_sha256`. The range is the clip ±60 s. Zero-length words (up to 4.7% with YouTube
  captions `[UX-M1]`) get `e = min(s + 80, next.s)` and `z: true`.
- **Gap classes** (§5.3): `silent` means at least 80% of the gap is covered by `audio_timeline`
  silences, `laughter` means a laughter event within ±500 ms, and everything else is `voiced`.
- **Laughter spans.** `sound_events.py` gives points. A span ends at the first 100 ms frame where
  `rms_db` falls below the silence floor + 6 dB, capped at 4 s. Spans are shown only after the
  precision gate (≥ 0.8 on 30 labelled events); until then they are points.
- **Re-anchoring.** When the transcript sha changes, each old word ID is mapped to a new one: ≥ 50%
  time overlap and equal case-folded text, or failing that the nearest word within 300 ms with
  equal text. Unmapped `word_edits` and anchors are **kept** and listed under "Perlu dicek" (needs
  checking). They are never dropped.

### 4.5 Camera plan `potongin.camera-plan/1` (analysis artifact, immutable)

```json
{"schema": "potongin.camera-plan/1", "source_content_sha256": "…", "grid": [30000, 1001],
 "analyzer": "haar-v1", "sample_every_sf": 6,
 "seats": [{"id": "A", "median_cx_e5": 31000, "median_cy_e5": 42000}, {"id": "B", "median_cx_e5": 69000, "median_cy_e5": 44000}],
 "shots": [{"from_sf": 37200, "to_sf": 38480, "kind": "single", "seat": "A"}],
 "keys": [{"sf": 37215, "cx_e5": 30500, "cy_e5": 42000, "seat": "A", "conf_pm": 930}],
 "speaking": [{"from_sf": 37215, "to_sf": 37330, "seat": "A"}],
 "cuts_sf": [38420], "no_face": [{"from_sf": 39010, "to_sf": 39100}]}
```

- All smoothing happens **once, at analysis**: the existing EMA, dead zone and hysteresis from
  `face_tracking.smooth_face_track`. edit-core only interpolates between keys, holding across
  `cuts_sf`.
- Stage 1 W0 ports today's Haar pipeline. Its per-frame samples must equal the current
  `build_crop_expression` output within ±1 px on 360 frames (the `[INC-E2]` method).
- `analyzer: "yunet-asd-v1"` (OpenCV `FaceDetectorYN` plus mouth-motion ASD plus VAD) is a **new**
  artifact. The user adopts it explicitly ("Analisis wajah baru tersedia — terapkan?"), so old clips
  never change underneath the user.

### 4.6 Versioned resources

| Resource | Path | Schema | Rule |
|---|---|---|---|
| Style pack | `resources/stylepacks/<id>/v<N>.json` | `potongin.stylepack/1`: the R2 §7.2 fields in integer units (`size_cap_e5`, `stroke_e5`, `pad_x_em_pm`, …) plus `reveal`, `anim`, `words_per_chunk`, `max_lines`, `wrap_width_e5`, `position`, `min_scale_pm` | Immutable per version. Documents pin `{id, v, sha256}`. Upgrading is an explicit, undoable command ("Perbarui gaya") |
| Legacy packs | `legacy-classic/v1`, `legacy-karaoke/v1`, hook design `legacy-bar/v1` | same | Reproduce today's `captions_ass.py` constants (DejaVu Sans; font 12/288 H; outline 1/150 H; margin 17% from the bottom; karaoke `#FFE14D`; hook box α `0x59`, 13% from the top; fades 150/250 ms) `[REPO]` |
| Hook design | `resources/hook-designs/<id>/v<N>.json` | `potongin.hookdesign/1`: a declarative event program (text blocks, `\p1` shapes, clip bands, tilt, label pill, fit rules, `max_chars`, fonts). Interpreted by `edit-core/ass/hookdesign/interpreter.mjs`. **Not code** | Pure ASS; no PNG |
| Text preset | `resources/text-presets/<id>/v<N>.json` | subset of the stylepack schema | |
| Template | `resources/templates/<id>/v<N>.json` (built-ins Umum, Podcast, Gaming, Edukasi) and `JOBS_ROOT/_workspace/templates/<id>/v<N>.json` | `potongin.template/1`: a partial document (caption pack and overrides, hook design and params, layout default, items anchored at `clip_start`/`clip_end`, music defaults, export) | Applying records `template_ref.overridden[]` |
| Brand kit | `JOBS_ROOT/_workspace/brand-kit.json` | `potongin.brandkit/1` | Logo asset, corner, opacity (850 by default), credit format |
| Fonts | `resources/fonts/*.ttf` + `OFL-*.txt` + `fonts.json` | `{family, style, weight, file, sha256, license, upem, libass_height_units, cap_height_units, x_height_units}` | The same bytes are served to the browser (never WOFF2). Calibrated against libass in CI |
| Emoji | `resources/emoji/noto/<cp>.png` (136 px and 512 px) + `LICENSE` | | Noto Emoji images, Apache-2.0 |
| Flags | `resources/flags.json` + `JOBS_ROOT/_workspace/flag-overrides.json` (kill switch) | `{"<op/pack/design>": {"enabled": bool, "class": "N\|D\|B", "evidence": {"ci_run": "…", "golden": "…"}}}` | Flipped only by a PR that links green evidence |

Stage 1 fonts (all OFL-1.1):
- Montserrat Black and ExtraBold, Poppins Bold and Black, Anton, Oswald Bold, Plus Jakarta Sans
  Bold, Courier Prime Bold, Lilita One, Bangers, Inter;
- DejaVu Sans and Sans Bold (Bitstream Vera licence), for the legacy packs.

Never bundle "The Bold Font" or Komika Axis `[R2 §7.4]`.

### 4.7 RenderPlan `render-plan-v1` (integers only; produced only by edit-core; excerpt)

```json
{"plan": "render-plan-v1", "core_version": "1.0.0", "render_semantics": 1,
 "doc_sha256": "…", "words_sha256": "…", "camera_sha256": "…",
 "design": {"w": 1080, "h": 1920},
 "output": {"w": 1080, "h": 1920, "fps": [30000, 1001], "frames": 2011, "sample_rate": 48000,
            "samples": 3219216, "composite": "yuv444p", "matrix": "bt709", "range": "tv"},
 "inputs": [{"id": "S", "kind": "source", "content_sha256": "…", "color": {"matrix": "bt709", "range": "tv"}},
            {"id": "sha256:5c1f…", "kind": "image"}, {"id": "emoji:1f602", "kind": "image"},
            {"id": "sha256:91aa…", "kind": "audio"}],
 "runs": [{"src": "S", "seek_sf": 37185, "pieces": [1, 2, 3]}, {"src": "S", "seek_sf": 38180, "pieces": [0]}],
 "pieces": [
   {"i": 0, "seg": "seg_co", "in_sf": 38210, "out_sf": 38345, "out_f0": 0, "frames": 135,
    "video": {"op": "camera", "crop": {"w": 608, "h": 1080}, "cmd": "cam_0.cmd", "scale": {"w": 1080, "h": 1920}}},
   {"i": 1, "seg": "seg_b1", "in_sf": 37215, "out_sf": 37483, "out_f0": 135, "frames": 268,
    "video": {"op": "camera", "crop": {"w": 608, "h": 1080}, "cmd": "cam_1.cmd", "scale": {"w": 1080, "h": 1920}}}
 ],
 "joins": [{"after": 0, "style": "flash_white", "frames": 3, "at_f": 135}],
 "layers": [
   {"id": "it_br1", "band": "under_text", "op": "overlay", "asset": "sha256:9d2e…", "enable": [611, 686],
    "box": {"x": 612, "y": 222, "w": 389, "h": 219}, "mask": {"kind": "rrect", "r": 16}, "alpha_cmd": "ly_it_br1.cmd"},
   {"id": "it_emoji1", "band": "over_text", "op": "overlay", "asset": "emoji:1f602", "enable": [640, 676],
    "box": {"x": 777, "y": 1049, "w": 130, "h": 130}, "scale_cmd": "ly_it_emoji1.cmd"},
   {"id": "it_logo", "band": "over_text", "op": "overlay", "asset": "sha256:5c1f…", "enable": [0, 2011],
    "box": {"x": 896, "y": 78, "w": 151, "h": 151}, "alpha_pm": 850}],
 "text": {"ass": "captions.ass", "ass_sha256": "…", "play_res": [1080, 1920], "events": 486,
          "fonts": [{"file": "Montserrat-ExtraBold.ttf", "sha256": "…"}]},
 "audio": {"pieces": [{"i": 0, "src_smp0": 61136000, "smp": 216216}],
           "envelopes": {"src": {"file": "env_src.json", "sha256": "…"}, "it_music": {"file": "env_it_music.json", "sha256": "…"}},
           "tracks": [{"id": "it_music", "asset": "sha256:91aa…", "out_smp0": 0, "smp": 3219216, "src_in_smp": 0, "loop": true}],
           "master": {"annex_sha256": "…", "gain_cdb": -230, "limiter": false, "master_audio": null}},
 "classes": {"camera": "N", "overlay": "N", "text": "N", "flash_white": "N"},
 "warnings": ["tight_cut:rm_01:in"],
 "sidecars": {"captions.ass": "…sha…", "cam_0.cmd": "…", "cam_1.cmd": "…", "ly_it_br1.cmd": "…",
              "ly_it_emoji1.cmd": "…", "env_src.json": "…", "env_it_music.json": "…"},
 "plan_sha256": "…"}
```

- `plan_sha256` is SHA-256 over the canonical plan without that field. It includes every sidecar
  hash, so every byte either backend consumes is covered.
- Envelope sidecars are breakpoint lists `{"points": [[smp, g_e6], …]}`, piecewise linear in
  **linear gain**. Python expands them per sample into f32. The browser uses
  `linearRampToValueAtTime` on the same points.
- `plan(doc, res)` exists for `res ∈ {1080×1920, 720×1280}`. **Layout decisions (wraps, fits,
  timing, cut frames, crop rectangles in source pixels) are made in the design space and do not
  depend on `res`.** ASS is always `PlayResX/Y = 1080×1920`, and libass scales to the frame. A 720p
  preview is therefore L0-identical to the 1080p export, and pixel-exact against a 720p export of the
  same plan.

### 4.8 Validation levels and "Perlu dicek"

| Level | Examples | Effect |
|---|---|---|
| Schema (ajv) | Unknown key, a float, a string out of range | HTTP 422 `{errors: [{path, code}]}` |
| Semantic, blocking save | `range_invalid` (a piece shorter than 2 frames or outside the source), `duration_out_of_bounds` (3–600 s), `cold_open_invalid` (0.5–8.0 s, first, `\|in − body.in\| ≥ 1 frame`, ≤ 80% overlap with `[body.in, body.in + len + 2 s]`), `removal_outside_segment`, `unknown_word`, `asset_missing`, `resource_unknown`, `op_disabled`, `glyph_unsupported:U+XXXX`, `too_large` | 422 with an Indonesian message id |
| Warning: save allowed, export blocked until acknowledged | `caption_overflow`, `hook_overflow`, `anchor_removed`, `item_out_of_range`, `no_face`, `unsafe_zone`, `laughter_cut`, `tight_cut`, `low_res_source`, `reanchor_unmatched`, `music_license_missing`, `cold_open_overlap_50` | The "Perlu dicek (n)" list, each entry with a jump-to target. Nothing falls back silently (G-FAIL) |

Limits:
- ≤ 200 segments, ≤ 2,000 removals, ≤ 16 tracks, ≤ 64 items per track and ≤ 500 in total;
- ≤ 2,000 keyframes (Stage 3), ≤ 5,000 ASS events;
- a document of ≤ 1 MiB.

### 4.9 Identity, seeding, versioning and migration

- **`clip_id`** is
  `"clip_" + sha256("potongin-clip-v1\0" ‖ source_content_sha256 ‖ "\0" ‖ start_ms ‖ "\0" ‖ end_ms ‖ "\0" ‖ (co_start_ms "-" co_end_ms | "-"))[:24]`.
  - `selection_version` and `rank` are **excluded**, so a selection re-run that finds the same
    moment re-attaches the edit (PF).
  - It is written additively as `clips[].clip_id` in `selection.v3.json`, coordinated with the V3
    owners. Until then `edit_v2/clip_id.py` computes it on the fly.
  - Edits whose clip disappears after a re-run stay reachable and are listed as "Klip yang diedit
    dari seleksi sebelumnya" (clips edited from an earlier selection).
- **Seed** (`edit-core/seed.mjs`, pure): input is the bundle from `edit_v2/seed_inputs.py`, namely
  the `SelectedClip`, the job options, the words sha, the camera sha and the probe.
  - Segments: `in_sf = ⌊start·F⌋` and `out_sf = ⌈end·F⌉`. V3 already snaps boundaries to words and
    silences. The cold open goes first, with a join of `cut` and a 30 ms audio fade
    (`AUDIO_JOIN_FADE_SECONDS`).
  - Captions: `legacy-karaoke@1` or `legacy-classic@1` from `captionStyle`.
  - Hook: `legacy-bar@1` with `hook_text`, 0 to `hook_duration` (4 s by default).
  - Layout: from `renderMode`. `face-track` becomes `camera`, `fit-blur` becomes `fit_blur`,
    `center-crop` becomes `fill_center`.
  - Output: the job's render size (the dashboard passes `--width/--height` `[REPO run-job.mjs]`).
  - Frame rate:
    - native standard rates are kept (24000/1001, 24, 25, 30000/1001, 30);
    - 50 and 60 are halved; 60000/1001 becomes 30000/1001;
    - VFR becomes 30.
  - Loudness: `off`, which equals today's auto render.
  - Packaging: title, description and hashtags.
- **Virtual revision 0.** `GET …/edit` with no document returns the seed with
  `ETag: "<seed sha>"` and `X-Edit-Seed: 1`, and writes nothing (no side-effecting GET, `[R1]`). The
  first `PUT` with `If-Match: <seed sha>` creates revision 1. If the seed inputs changed in between,
  the server returns 409 `seed_changed` with the new seed.
- **Versioning.**
  - `schema_minor` adds optional keys only. A document with a newer minor than the server knows is
    rejected with 426 "muat ulang editor".
  - A major version needs a pure migration `migrate_v2_to_v3(doc)`, applied on read and written
    only on the next save. Archives keep the original bytes.
  - `core_version` (semver) and `render_semantics` (an integer) go into every plan and render key.
    Any change that alters a golden pixel bumps `render_semantics`, attaches a heatmap report and
    needs owner approval ("look change").
- **V1 migration** (`edit-core/normalize/migrate-v1.mjs`; inputs gathered by
  `edit_v2/migrate_inputs.py`), triggered when a V2 editor URL is opened. The old route then
  redirects to the new one and becomes read-only.

  | V1 field | V2 target |
  |---|---|
  | `timeline` | one body segment |
  | `visual.render_mode` | `layout.default`; `focal_x` becomes one manual key, using the *render* formula, not the CSS one `[R1 P15]` |
  | `caption_style` | nearest pack (`clean`/`podcast` → `tiktok-box`, `bold-keyword` → `kuning-merah`, `karaoke` → `karaoke-sweep`, `minimal` → `santai-ketik`) |
  | Edited cue text | a token diff becomes `word_edits` and `hidden` |
  | `title` | a text item |
  | `logo` | an image item (or an `asset_missing` warning) |
  | `gain_db` | `audio.source.gain_cdb` |
  | `normalize` | `audio.master.mode` |

  The report goes to `migration.<sha>.json` plus a one-time banner. V1 renderer bugs are not
  emulated.

---

## 5. Core algorithms (all in `web/lib/edit-core`, one implementation)

### 5.1 Grid and time map

- Grid `F = num/den`. Output frame n has time `n·den/num` s. Samples are
  `smp(n) = ⌊n·48000·den/num⌋` in integer arithmetic; every product stays below 2^53 for 10 h at
  60 fps. At 29.97 fps this gives 1601/1602 samples per frame with **zero accumulated drift**.
- **Pieces:**
  1. For each segment s, `pieces(s)` is `[in_sf, out_sf)` minus the union of removals with
     `seg == s.id`.
  2. Pieces shorter than 2 frames are merged into the adjacent cut.
  3. Pieces are laid out consecutively: `out_f0(p) = intro_hold_f + Σ frames(prev)`.
  4. A Stage 3 `xfade` join of d frames overlaps its neighbours by d, and the total shrinks by d.
- Output frame n in piece p maps to source-grid frame `in_sf(p) + (n − out_f0(p))`. Output sample s
  maps to source sample `smp_src(in_sf(p)) + (s − smp(out_f0(p)))`, where each piece's sample count
  is `smp(out_f0 + frames) − smp(out_f0)`.
- `src_to_out(seg, ms)` returns a frame, or `REMOVED(cut_f)`. `out_to_src(f)` returns
  `(piece, sf)`. Lookups are binary searches over cumulative arrays.
- Property tests: the map is monotonic within pieces; the output duration equals Σ frames; delete
  followed by restore is byte-identical.

### 5.2 Frame-safe text timing `[PF]`

```
nowMs(n)  = Math.trunc(n * (den / num) * 1000)     // FFmpeg vf_subtitles arithmetic, byte for byte
safeCs(n) = Math.floor((nowMs(n) - 2) / 10)         // an event "visible from frame n"
```

- Events are written with `Start = safeCs(a)` and `End = safeCs(b)` for visibility on `[a, b)`.
- Karaoke `\k`/`\kf` durations are differences of `safeCs`. `\t` and `\fad` are relative ms,
  evaluated at the same `nowMs(n)` on both sides.
- The browser calls libass with `nowMs(n)/1000`. JASSUB's rounding then returns exactly `nowMs(n)`.
- P-TIME checks every boundary in the corpus, including all hazard frames. This rule is why neither
  `f/fps` (INC) nor `floor(t·fps)/fps` (UX, R3) is used as JASSUB's time input.

### 5.3 Snapping, cut placement, Rapikan classes

- **Trim targets.** For a word boundary between words a and b with `gap = b.s − a.e`:
  - if the gap is at least 40 ms, pick the quietest 10 ms bin (from `peaks.dat` at 100/s) inside
    `[a.e + 20, b.s − 20]`; ties go to `b.s − min(80, gap/2)` for in-points and to
    `a.e + min(80, gap/2)` for out-points;
  - otherwise use the midpoint and flag the edge `tight`.

  The chosen point is then converted to the frame boundary **inside the gap** closest to it:
  in-points use ⌊⌋ and out-points use ⌈⌉, so a word is never clipped. Other targets are scene cuts,
  laughter ends (out-points only; `LAUGH_TAIL_SECONDS = 0.8` `[REPO selection_v3.py]`), silence
  midpoints, the playhead and markers. The magnet radius is 8 px, Alt disables snapping, and ties
  prefer word boundary > laughter end > scene cut.
- **Removing words `[wi..wj]`.** `cut_in = boundary(keep_a, wi)` as an out-point and
  `cut_out = boundary(wj, keep_b)` as an in-point. If the energy at either edge is above −30 dBFS,
  the warning `tight_cut` is raised with an audition button.
- **Rapikan (tidy-up) classes**, precomputed in the words artifact. For gaps over 600 ms:
  - laughter within ±500 ms: class `laughter`, **locked off**;
  - at least 80% silent: class `silent`, **pre-checked**, and each silent sub-span longer than X is
    shortened to Y (defaults 600 → 200 ms), centred;
  - otherwise class `voiced`, **unchecked**, with audition.

  Transcript filler tokens are pre-checked **only after** the lexicon precision gate. Repeats are
  unchecked. Protected particles are never listed: `sih, dong, kok, lho, loh, deh, kan, ya, nih,
  tuh, gitu, kayak, yah, lah`.

### 5.4 Captions: derivation, layout and emission

1. **Visible words.** A word is visible when its midpoint maps to an unremoved output frame (the V3
   midpoint rule) and it is not `hidden`. Display text is `word_edits.text` or the ASR text; case is
   a pack property and never rewrites the text.
2. **Timing.** `n_on = src_to_out(start_ms + offset)`, rounded half up and clamped inside the word's
   piece. A word never spans a cut.
3. **Chunking.** Today's `subtitles.build_caption_cues` semantics are generalised:
   - at most `words_per_chunk` words per cue (default `CUE_MAX_WORDS = 4` for legacy packs);
   - a break on a gap over 600 ms, on a sentence end, on **every piece boundary** (never across a
     jump cut or the cold-open join), and on `breaks` overrides; `none` suppresses a break;
   - a minimum display of 300 ms, and no overlaps.

   The Python function's tests become vectors.
4. **Layout** (the only place text is measured).
   - Shape with harfbuzzjs using the same TTF bytes, with 26.6 advances.
   - Size by cap height: `Fontsize = cap_px · libass_height_units / cap_height_units`.
   - Wrap greedily within `wrap_width`. On overflow:
     - (a) shrink in 4% steps down to `min_scale_pm` (850);
     - (b) captions only: split the chunk;
     - (c) hooks only: ellipsize at a word boundary, as `shorten_hook_text` does;
     - (d) if it still overflows, raise the warning `caption_overflow` or `hook_overflow`. There is
       never a silent cut.
   - Metric error can only affect spacing, never parity, because libass draws the glyphs on both
     sides at the same `\pos` (UX).
5. **Emission.**
   - The header is `ScriptType v4.00+`, `PlayRes 1080×1920`, `WrapStyle 2`,
     `ScaledBorderAndShadow yes`, `YCbCr Matrix: None`, `Kerning yes`.
   - Escaping is a port of `captions_ass.ass_escape` (a U+2060 word joiner after `\`, `{}` escaped,
     line-breaking characters turned into spaces, Cc/Cs dropped).
   - Animated modes (`per_word`, `chunk_karaoke`, `cumulative`) get **one event per word with
     `\an5\pos`**, which prevents the 56 px pop reflow `[R2]`. The base event is split around the
     active window so glyphs never double-draw `[UX-M4]`. Box highlights are a layer-0 `\p1`
     rectangle.
   - `segment_static` gets one event per line with `\an7\pos\q2`. `karaoke_sweep` uses `\kf`.
   - Inline emoji become derived PNG overlay layers at their placeholder boxes.
   - The event budget is < 3,000 per 90 s clip.
6. **Hook designs** are declarative programs (§4.6). Gradient becomes 16 stepped-alpha `\p1` bands
   over 28% H. Punchline two-tone becomes 8 `\clip` bands with inner and outer strokes as two layers.
   Sticker labels use seeded deterministic roughness. Auto-fit generalises `_hook_layout`, and tilted
   designs are checked against the safe zone with a rotated bbox.

### 5.5 Anchors

- `{"at":"out","f":n}` resolves to n. `clip_start` and `clip_end` resolve to 0 and `total_f`.
- `{"at":"word",…}` resolves to `src_to_out(word.s or word.e) + offset_f`, preferring the body
  occurrence unless `seg` pins the cold-open occurrence.
- If the anchor word was removed, the item resolves to the cut frame and raises `anchor_removed`.
  An item that resolves beyond `total_f` is not rendered and raises `item_out_of_range`; it is never
  deleted silently.

### 5.6 Camera sampling

- At every output frame, `cx(n)` comes from the manual keys when inside their span (with a 10-frame
  eased blend at the span edges), otherwise from the plan keys. `seat_force` overrides the seat.
- The crop is `crop_w × crop_h` in source pixels (fixed per piece: FFmpeg cannot change crop size
  mid-stream `[R2]`), and x/y are even-aligned for 4:2:0 sources.
- The plan build enforces pan ≤ 6% of W per 100 ms and no seat switch within 1.0 s. A layout change
  (single → split → wide) is a piece boundary.

### 5.7 Audio envelopes and loudness

- **Envelope per mixed source.** It is a product of piecewise-linear factors in linear gain, with
  breakpoints at integer samples:
  - join micro-fades (`cut_fade_ms`, 8 ms by default; 30 ms at the cold-open join), with no overlap;
  - mutes;
  - item fades;
  - `gain_cdb`;
  - duck: speech intervals are kept words in output time merged across gaps below `hold_ms`
    (`detector=words`) or `audio_timeline` RMS above the floor (`rms`), ramped over attack and
    release;
  - the master constant gain.

  dB is converted to linear with `detmath.exp10`.
- **Server.** `amultiply` with an f32 envelope expanded by Python from the breakpoints. Measured
  max error 7.4e-9 `[INC-E3]` and 1.5e-5 `[PF]`. Every channel mapping is an explicit `pan`,
  because the implicit mono→stereo `aformat` is **−3 dB** `[PF]`.
- **Browser.** One GainNode per factor with `setValueAtTime` and `linearRampToValueAtTime` on the
  same breakpoints. Measured −148.6 dB `[INC-E3b]` and −153 dB `[UX-M5]` against FFmpeg, where the
  gate is < −40 dB.
- **Loudness, two-pass.**
  1. The annex is an audio-only render of the pre-master mix with `ebur128=peak=true`, cached by
     `audio_mix_sha256` (≤ 3 s for 90 s `[E]`).
  2. The gain is `g = target − I`, clamped so `TP + g ≤ tp_target`.
  3. If the clamp costs more than 1 LU, the annex also renders the mastered audio with `alimiter`
     to `annex/master-<sha>.m4a`, and **both** the preview and the final render use those bytes
     (class D).
  4. Until the annex exists, the preview plays at unity master gain with the badge "level akhir
     sedang dihitung" (final level is being calculated).

  `sidechaincompress` and dynamic `loudnorm` are banned.

### 5.8 Determinism rules (lint plus tests)

- Banned in edit-core: `Math.round` (use `roundHalfUp`), `Math.pow`/`sin`/`cos`/`exp`/`log` (use
  `detmath.mjs`, built from `+ − × ÷ √` only), `toFixed` in logic, `Intl`, `localeCompare`, `Date`
  in resolve, and unsorted object-key iteration.
- Comparators are total, with ties broken by id.
- P-XENG runs 120 fixtures on Node 20, Node 22, Chrome 147, Firefox and WebKit. All must produce
  equal `plan_sha256`.

---

## 6. Preview/render parity architecture

### 6.1 Contract

| Level | Meaning | Mechanism | Gate |
|---|---|---|---|
| L0 semantic | Same frame for every event: joins, source frame, text on/off, karaoke switch, overlay enable, transition progress, keyframe values, gain per sample | One edit-core, integer plan, grid, frame-safe timing | **Hard: 0 mismatches** (P-FRAME, P-TIME, P-XENG) |
| L1 perceptual | Live frame vs the lossless FFmpeg reference of the same plan | Op catalog, yuv444p compositing, own colour conversion | Per op (§6.6) |
| L2 pixel | The production binary's frame | Truth frame on pause (0.16–0.43 s) | Always one pause away |

**What "identical" cannot mean** (stated once in the UI help): the final H.264 encode (crf 20–21,
4:2:0) loses about SSIM 0.005 against the lossless graph `[R3]`, and the preview decodes a 720p
proxy while the render decodes the source.

Invariants:
- **I1.** Only edit-core makes layout, timing or mix decisions.
- **I2.** The document and plan are integers only.
- **I3.** Frames and samples follow §5.1.
- **I4.** ASS follows §5.2.
- **I5.** Every rectangle is an integer, and source crops are even-aligned.
- **I6.** Font and PNG bytes are identical on both sides, with colour chunks stripped `[R3 bug 2]`.
- **I7.** Animated parameters are pre-sampled per frame (`sendcmd` on the server, uniforms in the
  browser). There are no FFmpeg expressions and no CSS animation.
- **I8.** Non-reproducible audio is class D.
- **I9.** Colour matrix, range, SAR, timebase and channel layout are always explicit in the graph
  (`in_color_matrix`, `setsar=1`, `settb`, `pan`, `aresample=48000`). Implicit conversions are
  compiler test failures.
- **I10.** An op without passing *server* goldens (compile string goldens, G1–G5, P-BAKE) is
  hidden in the UI and rejected by the validator (`op_disabled`). An op whose *browser* goldens have
  not passed yet is served as class B (§6.2), never approximated.

### 6.2 The parity ladder (N → D → B → T), promotion and kill switch

| Class | Pixels or samples come from | Used for | Why it is exact |
|---|---|---|---|
| **N** native | WebGL2 op in the engine worker (+ libass WASM for text) | Everything in the Stage-1 catalog once its gate is green | Same plan integers; golden-proven per op |
| **D** derived | A server-rendered intermediate asset consumed by **both** preview and render | Mastered audio when the limiter engages (Stage 1); speed-changed media and fps variants (Stage 2); denoise and voice EQ, GIF/animated stickers (Stage 3) | Shared bytes |
| **B** baked | A server bake of the **under-text band** for a 2 s output-aligned span, from the same compiler (`segment` mode); text and over-band stay live | Any op whose native path is not yet green; Stage 3 ops while their shaders mature; browsers without WebGL2 or WebCodecs (full bake including text, "Pratinjau server") | Same compiler and graph |
| **T** truth | A single server frame on pause | Everything, always | The production binary |

- **While a B span is baking** (budget ≤ 1.5 s p95), the timeline band is hatched and the canvas
  holds the last exact frame with "Menyiapkan pratinjau…" (preparing the preview). Approximate
  pixels are **never** drawn `[INC]`.
- **Promotion from B to N** needs three things:
  1. the op's golden cases pass in the production image with pinned Chrome;
  2. **shadow mode** for 14 days of owner usage: the op is rendered natively, compared, and not
     shown, and fewer than 0.1% of paused frames may fall below SSIM 0.985;
  3. the flag flips in a PR that links the evidence.
- **Kill switch.** If sentinel SSIM p5 falls below 0.98 for an op class in production, that op is
  demoted to B through `flag-overrides.json`. The document stays editable.

### 6.3 Browser engine (`web/lib/preview/`)

```
Main thread: React UI · zustand 5.0.15 store · edit-core commands (Immer 11.1.18) · timeline/transcript DOM ·
             gizmos (DOM handles above the canvas) · time map + derived UI data (≤ 2 ms)
Engine worker (OffscreenCanvas, WebGL2):
  edit-core resolve → RenderPlan (memoised per block; ≤ 16 ms / 90 s clip)
  Mediabunny 1.59.1 (MPL-2.0, unmodified): Input(UrlSource) → VideoSampleSink per media; decoder pool
     (current piece + next piece pre-rolled ≥ 500 ms before each cut); frame LRU
  YUV: VideoFrame.copyTo() I420 → 3 R8 textures → BT.709 limited-range shader        [S-COPYTO decides]
  ops/*.mjs + shaders/*.glsl (one per catalog op, same name as the Python ops/*.py)
  libass: JASSUB 2.5.16 WASM (unmodified) → ASS_Image bitmaps → R8 atlas → same pass  [S-LIBASS-ENGINE decides;
          fallback: stock JASSUB canvas stacked between two WebGL canvases with a present barrier]
  presenter: frame n drawn when AudioContext time crosses n; drawn only when all layers are ready,
             otherwise dropped and counted (never partial)
Audio: AudioContext(48 kHz) · AudioBufferSink per piece/asset · GainNode ramps per envelope factor ·
       class-D master audio when present · master clock = currentTime
Sentinel: on 250 ms pause → truth frame → ssim.js 3.5.0 on 270×480 luma → swap if < 0.985 → local telemetry
```

- **Proxies.** A window proxy per clip covers the grid frames `[in − 60 s, out + 60 s]`:
  - built with `-ss (a0/F − 1) -copyts -i SRC -vf fps=F,trim=start_pts=a0:end_pts=b0,setpts=PTS-STARTPTS,scale=-2:'min(720,ih)':flags=bicubic:in_color_matrix=<S.color>,setsar=1`;
  - encoded x264 crf 24, `-g F/2 -bf 0 -sc_threshold 0`, BT.709 tags, AAC 48 kHz with an explicit
    `pan` (or FLAC-in-MP4 if S-AAC-PRIME fails);
  - addressed **by frame index**: `getSample((k' + 0.5)/F)`.

  The whole-source 360p scrub proxy is lazy and serves only the source view (cold-open picking and
  context expansion).
- **Before the proxy exists** (old jobs, or the build is still running): the stage plays the
  auto-render MP4 in a `<video>` element, which is exact for revision 0. The transcript is already
  editable and edits queue up (UX).
- **Preview resolution.** A device probe times 60 frames of WebGL plus libass at 1080×1920 and picks
  1080 or 720 ("Pratinjau 720p"). Truth frames are always at export resolution.
- **Browser policy.**
  - GA: Chrome and Edge ≥ 120 on desktop (WebCodecs, WebGL2, OffscreenCanvas,
    `VideoFrame.copyTo`).
  - Firefox ≥ 130 and Safari ≥ 17 run the suites report-only until green.
  - Phones: review, text edits and export, with "Pratinjau server".
- **Headers.** Editor routes send COOP `same-origin` and COEP `require-corp` (JASSUB threads), and
  self-host every subresource. The Google Fonts `@import` is removed `[R1 §8]`.

### 6.4 FFmpeg compilation (`src/ai_clipper/edit_v2/compile_ffmpeg.py`, pure)

`compile(plan, mode, sidecar_dir) → FfmpegJob{argv, filter_script, fds, expected}`, with
`mode ∈ {final, reference, frame, segment, audio_measure, audio_master, audio_span}`.

Rules (each one has a string-golden test):
- **R1. Frame identity.**
  - Each run uses `-ss (seek_sf/F − 1 s) -copyts -i /proc/self/fd/N`.
  - Each piece uses `fps=F,trim=start_pts=a:end_pts=b,setpts=PTS-STARTPTS`.
  - Measured: 0/1,125 mismatches (CFR 29.97 and VFR, 5.1.9 and 6.1.1) `[PF]`, and 60/60 `[INC-E6]`.
- **R2. Decoder runs.**
  - Consecutive pieces share one decoder (`split` + frame trims) when
    `gap_frames < preroll + distance to the previous keyframe`; otherwise a new seeked input is
    used.
  - Measured with 20 cuts: 2096/2096 frames and A/V −0.7 ms, 13% faster than 21 inputs at 720p
    `[INC-E4]`, and equal cost at 1080p `[UX-M3]`.
- **R3.** Every branch is normalised with `setsar=1,settb=1/F` and `format=yuv444p` before
  `concat`/`overlay`/`xfade` (xfade fails otherwise `[R2]`). The output ends with
  `scale=out_color_matrix=bt709:out_range=tv,format=yuv420p`.
- **R4. Animated values via `sendcmd`:** `crop@cam x/y`, `overlay@id x/y`, `scale@id w/h`
  (`eval=frame`), `colorchannelmixer@id aa`, `rotate@id a`. Each is one interval per changed frame
  `[(n−0.5)/F, (n+0.5)/F)`. All were measured frame-exact in 5.1.9 `[PF]`, and camera paths are
  bit-identical to today's expression crop `[INC-E2]`.
- **R5. Enables use frame indices:** `enable='between(n,a,b−1)'`, never float t.
- **R6. Text.** `ass=filename=captions.ass:fontsdir=fonts`, with `FONTCONFIG_FILE` →
  `resources/fontconfig/fonts.conf` listing **only** `/app/resources/fonts`. A CI missing-glyph
  probe proves there is no fallback.
- **R7. Audio.**
  - Per piece: `aresample=48000,pan=stereo|…,asettb=1/48000,atrim=start_pts:end_pts,asetpts=PTS-STARTPTS`.
  - Then `concat`, then `amultiply` with the envelope, then `amix=normalize=0:duration=first`, then
    the constant master gain, then `aresample=48000`.
- **R8. Fit-blur plate:**
  `scale=90:160:force_original_aspect_ratio=increase:flags=area,crop=90:160,boxblur=4:3:2:3,scale=W:H:flags=bilinear`.
  It is 37% faster than `gblur`, and SSIM 0.993 against the old look `[R3]`.
- **R9. Encode.** x264 `veryfast` crf 20 (Standar) or `medium` crf 18 (Tinggi), High profile,
  `-g 2F`, BT.709/tv tags, AAC-LC 192k 48 kHz stereo, `-map_metadata -1`, `+faststart`.
- **R10. Hygiene.**
  - The graph goes through `-filter_complex_script`. Sidecars have constant names in a private
    temp directory.
  - **No user string ever appears in argv or the graph.** Text reaches FFmpeg only through
    edit-core-escaped ASS.
  - `-nostdin -protocol_whitelist file,pipe,fd`, `RLIMIT_AS` 3 GB, `RLIMIT_NOFILE` 256,
    `-progress pipe:3`.
- **R11. Verification** (`verify.py`) blocks publication (§6.6 G1–G5). A failure writes the
  existing but never-used `verification_failed` state `[R1]`, with an Indonesian message.
- **R12. Render key:**
  `sha256(plan_sha256 ‖ annex_sha256 ‖ compiler_version ‖ ffmpeg -version line ‖ libass version ‖ fonts.json sha ‖ preset)`.
  The output goes to `output/edits/<clip_id>/<key16>.mp4`. Re-exporting an unchanged document is
  instant, and a renderer fix produces a new key `[R1 D8]`.

### 6.5 Op catalog by stage (each op = `ops/<name>.py` + `compositor/ops/<name>.mjs` + goldens + flag)

| Op | Stage | FFmpeg 5.1.9 | Browser (N) | Gate |
|---|---|---|---|---|
| `range` (cuts, cold open) | 1 | R1/R2 | Proxy frame by index | P-FRAME 0 mismatches |
| `crop_scale` (fill_center) | 1 | `crop` (source px, even) + `scale=…:flags=bicubic:in_color_matrix=…` | Bicubic shader (B=0, C=0.6) | Region SSIM ≥ 0.995; rect exact |
| `camera` (face track, manual keys, seat force) | 1 | R4 `crop@cam` | Same per-frame ints | Rect exact |
| `split` (two seats) | 1 | `split` → 2× crop_scale → `vstack` | Two quads | As crop_scale |
| `fit_blur` plate-v1 | 1 | R8 | Area downscale, 3× integer box blur (port of `vf_boxblur`), bilinear up | Composite SSIM ≥ 0.99 (0.9937 measured on Canvas2D) |
| `fit_black`, `branded` | 1 | `pad` + template background still | Clear colour + quad | Exact / as overlay |
| `overlay` (still: sticker, emoji, logo, B-roll image) + rounded mask | 1 | `overlay@id … format=yuv444:eval=frame`, `alphamerge` with an edit-core mask | Premultiplied quad + mask texture (same alpha function) | Box exact; region SSIM ≥ 0.995; logo alpha ±2% |
| `overlay_video` (B-roll PiP, cutaway, split) | 1 (W3) | Second input (normalised mezzanine) + overlay | Second decoder | P-COMP; timing 0 frames |
| `rotate` | 1 (W2) | `rotate@id … c=none:bilinear=1` | Bilinear rotated quad | Region SSIM ≥ 0.99; bbox ±1 px |
| `fade`, `flash_white`, `dip_black`, anim presets (fade/pop/slide) | 1 | `colorchannelmixer` alpha / `scale` via sendcmd | Uniforms | Exact alpha per frame |
| `text` (captions, hook, text items) | 1 | R6 on yuv444p | libass WASM | P-TXT |
| audio `mix` + envelopes | 1 | R7 | GainNode ramps | P-AUD |
| Z-interleave (N ASS passes) | 2 | Several `ass` filters with event subsets | Several libass tracks, same pass | P-TXT + P-COMP; ≤ 3 passes |
| `speed` (constant) + freeze | 2 | `setpts` on the grid; audio **D** (`rubberband`/`atempo`, derived file) | Frame index map + D audio | Frame map exact; D bytes shared |
| `keyframes` (x, y, w, scale, rotation, opacity, crop, gain) | 3 | R4 per frame | Per-frame uniforms | Values exact by construction + P-COMP with 5 keyframed overlays |
| `zoom` (animated punch-in, Ken Burns) | 3 | `zoompan` with per-frame integer rect **[S-ZOOM]** | Rect per frame | Rect exact at ≤ 1.3× static cost, or the op stays off (static punch-in ships) |
| `transition` xfade subset | 3 | Island: tail/head trimmed → `format=gbrp` → `xfade` → yuv444p → concat; audio equal-power crossfade on the same samples | GLSL port of `vf_xfade.c` per type | SSIM ≥ 0.995 at 25/50/75%. **No `dissolve`** (random per pixel) |
| `eq`, `lut3d`, `vignette`, `unsharp`, shake | 3 | `eq` (sendcmd), `lut3d interp=tetrahedral` (validated `.cube` ≤ 65³), `vignette`, `unsharp`, sampled crop offsets | GLSL of the same formulas; 3D texture | eq SSIM ≥ 0.995; LUT ΔRGB ≤ 1 |
| Audio clean-up (`afftdn`/`arnndn`, EQ, de-ess) | 3 | Derived file (D) | D bytes | Listening panel + G3 |

Banned everywhere: `gblur`, `dissolve`, `sidechaincompress`, dynamic `loudnorm`, time-varying crop
size, `drawtext`, expression-driven animation, CSS filters, Canvas `filter`, Lottie as final pixels,
and colour emoji through libass.

### 6.6 Test strategy and numeric thresholds

**Corpus** (`tests/golden/`: self-owned, CC0 or synthetic only; no YouTube media):
- barcode sources (frame index as a 24-bit block code) at 29.97 CFR, 25, 30, VFR, and AV1 GOP 6 s;
- colour bars (709, 601, untagged);
- a 60 s two-shot podcast (CC0 or self-recorded), a vertical source and a 4:3 source;
- `clicks.wav` and `tone_bursts.wav`;
- about 120 document fixtures: every op alone; every pack × 3 texts (10/40/90 chars, with and
  without emoji) × 5 timestamps; every hook design; and combined scenes (cold open + 20 jump cuts +
  karaoke + hook + sticker above captions + B-roll + ducked music; Stage 3 adds transitions and
  keyframes).

**Harness** (`scripts/parity/run.sh`, inside the production image at a pinned digest):
- FFmpeg `reference` mode produces lossless yuv444p frames converted to RGB with BT.709.
- Playwright 1.62.1 with **Chrome for Testing 147.0.7727.15** (`chromium-1217`) loads the dev-only
  route `web/app/parity-harness/page.jsx`.
  - It returns `notFound()` unless `POTONGIN_PARITY_HARNESS=1` and the user is authenticated. It
    cannot be `_parity`, because Next.js treats `_` folders as private.
  - It renders frame n from the **full-resolution source**, so compositor error is measured
    separately from proxy softness, and returns `readPixels`.
- Metrics: FFmpeg `ssim`/`psnr`, pixel-threshold counts, per-region masks from plan boxes, and the
  best temporal offset within ±2 frames.
- A red case uploads a ×8 heatmap, a side-by-side image and the metrics JSON. Baselines change only
  through `--bless` plus a reviewer.

| Gate | Runs | Threshold (measured basis) |
|---|---|---|
| **P-XENG** plan hash across engines | Every PR | 120 fixtures, Node 20/22, Chrome 147, Firefox, WebKit: **0 mismatches** |
| **P-FRAME** source frame identity | PR (small), nightly (≥ 2,000 frames) | **0 mismatches** on CFR, VFR and AV1, for the server segment, final render and browser engine against the whole-file `fps=F` grid (0/1,125 measured `[PF]`) |
| **P-TIME** event and karaoke onset frame | Every PR | **0 mismatches**, hazard frames included |
| **P-TXT** text layers vs FFmpeg yuv444p lossless | PR (subset), nightly | SSIM ≥ **0.999**, max diff ≤ **16**, **0 px > 16** (0.99925 / 15 measured); vs RGB24 SSIM ≥ 0.9995 (0.9998 / 13 `[R3]`) |
| **P-COMP** full composite vs lossless | Nightly | SSIM ≥ **0.99**, PSNR ≥ **35 dB**, px > 64 ≤ **0.05%**; axis-aligned boxes exact; rotated ±1 px; temporal offset 0 |
| **P-DEC** browser decode + conversion vs FFmpeg | Nightly | SSIM ≥ **0.997**, max ≤ **8** (0.9983 / 4 on the drawImage path `[R3]`) |
| **P-AUD** audio | PR (render), nightly (preview) | Render: `env × source` ≤ 1 LSB s16; join positions exact to the sample. Preview (OfflineAudioContext): 10 ms RMS envelope error < **−40 dB** (−148.6 / −153 dB measured); click onsets ±48 samples |
| **P-BAKE** baked span vs final at the same resolution | Nightly | SSIM ≥ final-encode SSIM − 0.002 `[INC-E1]` |
| **P-ENC** final vs lossless | Nightly | SSIM ≥ 0.99 (0.995 measured) |
| **P-RT** round trip | Every PR | Seed via the editor path = auto render, **framemd5-identical**. Once, at the engine switch: vs legacy `render.py` output on 20 clips, SSIM ≥ 0.98, caption bbox ±2 px, owner look approval |
| **G1** container | Every render | H.264 High, yuv420p, W×H, SAR 1:1, CFR `num/den`, BT.709/tv tags, AAC-LC 48 kHz stereo, faststart |
| **G2** A/V | Every render | Video frames = `plan.frames` exactly; audio samples = `plan.samples` ± 1,024 |
| **G3** loudness | When normalize is on | −14 ± 1 LUFS integrated, true peak ≤ −1.0 dBTP |
| **G4** sanity | Every render | No `blackdetect`/`freezedetect` span > 0.5 s unless the plan has intended stills (run on a 270×480 `split` branch in the same pass) |
| **G5** text-safe | Every render | All text and sticker bboxes inside the preset (TikTok at 1080×1920: top 140, bottom 420, right 140 px) unless `safe_override`; confirmed on 3 sampled frames |
| **G-SYNC** | CI | 20 cuts + cold open (+ 3 transitions in Stage 3): A/V end ≤ 1 frame; caption onset = plan frame (±1 frame of `word.start + offset`) |
| **G-CLICK** | CI | Sample step at every cut < −40 dBFS |
| **G-DET** | Every PR | Same document + assets + engine gives identical plan hash, graph string, ASS, sendcmd and envelope bytes |
| **G-FAIL** | Every PR | No face, missing font, emoji or asset, unknown op or pack: an explicit Indonesian error or warning code |
| **Sentinel** (production) | Continuous | Swap to the truth frame at SSIM < 0.985 (270×480 luma); kill switch at p5 < 0.98 per op class |

### 6.7 Performance budgets

| Budget | Target | Basis |
|---|---|---|
| PF-OPEN | Interactive ≤ **1.5 s** p95 on a repeat visit and ≤ **3 s** on the first (window proxy prebuilt); ≤ 8 s if the proxy must be built, with the auto-render playing meanwhile | UX §1.6 |
| PF-SEEK | Scrub → frame ≤ **50 ms** p95 | Proxy seek 3.7 / 8.6 ms `[R3]`; libass p95 29 ms at 1080 `[UX-M4]` |
| PF-PLAY | ≤ 1 dropped frame per 10 s at 30 fps; **0** at cuts (S-PLAY) | |
| PF-INPUT | UI ≤ 50 ms; caption keystroke → preview ≤ **100 ms** p95 | `setTrack` + render p95 23.9 ms `[UX-M4]` |
| PF-RESOLVE | Plan rebuild ≤ **16 ms** for a 90 s clip | |
| PF-SAVE | Autosave ≤ 2 s after the last edit; PUT p95 ≤ **300 ms** | CLI 70–90 ms `[R1]` |
| PF-TRUTH | ≤ **0.5 s** p95 at 1080×1920 | 0.43 s `[R2]`; 0.16–0.20 s at 720 `[R3]` |
| PF-BAKE | 2 s span ≤ **1.5 s** p95 including queueing | 0.45–0.56 s `[R3]` |
| PF-LIBASS | Heaviest Stage-1 pack at the chosen preview resolution: p95 ≤ **20 ms/frame** on the reference laptop | 14.4 / 29 ms at 1080 (headless SwiftShader) `[UX-M4]` |
| PF-RENDER S1 | 1080×1920, 4 CPUs, production image: p50 ≤ **0.5×**, p95 ≤ **0.75×** clip duration | yuv444p plate + ASS 0.35× `[PF]`; 21 cuts at 1080 0.33× `[UX-M3]` |
| PF-RENDER S2/S3 | p95 ≤ **1.0×** | Stage-2 graph 0.53× `[R2]` |
| PF-PREP | Window proxies + words + camera for 12 clips ≤ **2 min** CPU at nice 10 | 5–8 s per proxy `[R3]` |
| PF-TIMELINE (S2) | 50 items interactive at 60 fps | |

The reference laptop is a Core i5-1135G7 or Ryzen 5 5500U with 8 GB, an integrated GPU, Chrome
stable, and 1366×768 and 1920×1080 screens.

---

## 7. API, storage, concurrency, security

### 7.1 Storage layout

```
JOBS_ROOT/<job>/
  analysis/source.json                                   {content_sha256, probe, color}
  analysis/selection.v3.json                             + clips[].clip_id (additive)
  analysis/media/{scrub-360.mp4, peaks.dat, sprite.json, sprite-<n>.webp}   whole source, lazy
  analysis/clips/<clip_id>/
      edit/doc.json                                      current revision (canonical, 0600)
      edit/archive/r<N>.<sha>.json.gz                    retained per policy
      edit/receipts/<key>.json                           {payload_sha256, result_etag, result_revision, state, at}
      edit/checkpoints.json, edit/.lock
      words.<sha>.json · camera.<sha>.json               immutable analysis artifacts
      media/{window-<a0>-<b0>.mp4, window-….json, peaks.dat, filmstrip.json, filmstrip-<n>.webp}
      plans/<plan_sha>/{plan.json, captions.ass, *.cmd, env_*.json}   LRU 20
      annex/<audio_mix_sha>.json (+ master-<sha>.m4a)    loudness measurement / class-D master
      bakes/<bake_key>.mp4 · frames/<plan_sha>-<f>-<res>.png         LRU caches
      suggestions/<task_id>.json · migration.<sha>.json
  analysis/assets/<sha>.<ext> + <sha>.json · analysis/assets/derived/<sha>@<variant>.<ext>
  analysis/render-requests/<id>.json                     queue (render-request-v3)
  output/edits/<clip_id>/<render_key16>.{mp4,srt,jpg} + latest.json
JOBS_ROOT/_workspace/
  brand-kit.json · templates/<id>/v<N>.json · style-packs/user-<uuid>/v<N>.json
  library/<sha>.<ext> + .json · flag-overrides.json · telemetry/parity.jsonl (local only)
/app/resources/ (read-only in the image)
```

**Retention** (a janitor in the primary job queue, under the document lock):
- Receipts: 24 h or the last 200, whichever keeps more. Digests only. This removes the 1,000-save
  lockout `[R1 D5]`.
- Archives: revision 1, every revision referenced by a render request or checkpoint, the last 50,
  and one per hour for 7 days; gzip level 6.
- Caches (plans, bakes, frames, proxies) are LRU and counted by the existing storage admission.
- Suggestions: 30 days.
- Unreferenced assets: deleted 30 days after their refcount reaches 0.
- Render inputs: **hard-linked** job source (0 bytes) with a copy fallback. The content sha is still
  verified (`_assert_source_binding`).

### 7.2 Endpoints

Every route uses the existing `requireAuth`. Every mutation checks Origin, Host and
`Sec-Fetch-Site` (`verifySameOrigin`), streams and counts its body, and requires an
`Idempotency-Key` (UUID). Python is reached by `execFile` of `python -m ai_clipper.edit_v2.api`
(stdin envelope, the exit-code map of `editor_api.py`).

| Method and path | Purpose | Contract |
|---|---|---|
| `GET /api/jobs/:id/clips` | V3 clips with `clipId`, edit status (`seed`/`edited`/`rendered`/`stale`), latest render, proxy readiness | |
| `GET …/clips/:clipId/edit` | Document + `ETag`, or the virtual seed with `X-Edit-Seed: 1`; 202 `preparing` if the words or camera artifact is missing | **No side effects** |
| `PUT …/clips/:clipId/edit` | Save the full document (≤ 1 MiB) | `If-Match` (428 if missing), `X-Plan-Sha256`, `X-Core-Version`. Responses: 200 `{doc, etag, warnings}`; 409 `revision_conflict {current, etag}` or `seed_changed`; 422 `{errors: [{path, code, messageId}]}`; 426 for a stale core |
| `GET …/edit/revisions?before=&limit=`, `GET …/edit/revisions/:rev`, `POST …/edit/restore {rev, expectedEtag}`, `POST …/edit/checkpoints {name, etag}` | "Riwayat" (history), A/B compare, "Kembali ke versi AI" (back to the AI version) | Restore writes a new revision |
| `GET …/clips/:clipId/words` | Words artifact | `ETag` = sha; `immutable` |
| `GET …/clips/:clipId/plan?etag=&res=` | Server plan (debugging, parity triage) | |
| `POST …/preview/frame {doc\|etag, f, res}` | Truth frame, `image/png` without colour chunks | ≤ 4/s per session, concurrency 2; cache `(plan_sha, f, res)` |
| `POST …/preview/bake {doc\|etag, f0, f1}` | Class-B spans: `{segments: [{f0, url\|state}]}` | One active bake per user; cancelled when superseded |
| `POST …/preview/audio {doc\|etag}` | Class-D master audio / annex state | |
| `POST …/clips/:clipId/renders {etag, preset}` | Enqueue a final render (storage reservation as today) | An identical key completes instantly |
| `GET/DELETE /api/jobs/:id/renders/:rid` | Status + stages (Potong → Reframe → Teks → Overlay → Audio → Master) / **cancel** | |
| `GET /api/jobs/:id/media/[...name]` | Scrub proxy, window proxies, peaks, filmstrips, bake segments (Range) | `private, max-age=31536000, immutable` (content-hashed names) |
| `POST /api/jobs/:id/assets` | Upload (§7.4); 201 `{sha256, kind, w, h, durMs, hasAudio, lufs_c}` | |
| `GET /api/jobs/:id/assets/:sha` | Normalised bytes | §7.4 headers |
| `POST …/clips/:clipId/ai {task, etag, params}` → `GET …/ai/:taskId` | AI suggestions (§8) | 202; poll every 1 s |
| `POST /api/jobs/:id/clips/apply-all {what, source, targets, mode}` | Batch-apply a template, pack or brand kit; one new revision per clip | Per-clip results |
| `GET/PUT /api/workspace/{templates,brand-kit,style-packs,library}` | Workspace resources | Same `If-Match` and idempotency |
| `GET /api/resources/[...path]` | Fonts, packs, designs, text presets, emoji, flags (read from `/app/resources`, so the browser gets **the same bytes** libass uses) | `immutable` |

**Bridging.** The Node route imports edit-core **in-process**: validate, canonicalise, compute the
plan hash. It then calls Python `api put` (about 80 ms) for the locked, receipt-checked commit.
Python re-parses strictly (integers only, canonical bytes equal, revision chain, size). The render
worker re-validates with `node cli.mjs validate` before any render.

### 7.3 Revisions and concurrency

- **Server.** V1 rules are kept exactly `[R1 §5]`: `If-Match == current sha`,
  `revision == current + 1`, `parent == current`, `created_at` immutable, `updated_at` strictly
  increasing, all under the per-clip `flock`. The idempotency algorithm (pending → committed, crash
  reconciliation) is unchanged, with digest-only receipts.
- **Plan handshake (D13).** The server recomputes `plan_sha256`. A mismatch with `X-Plan-Sha256`
  still saves the document (it is valid) but returns `warning: plan_mismatch`. The client then shows
  "Editor perlu dimuat ulang" (the editor needs a reload) and disables export until it reloads.
- **Client.**
  - Autosave is debounced 1.5 s, fires at least every 10 s during continuous editing and on blur,
    with one PUT in flight.
  - The IndexedDB draft (idb-keyval 6.3.0) holds `{baseEtag, pending commands, doc}`.
  - `BroadcastChannel` warns "Klip ini terbuka di tab lain" (this clip is open in another tab).
- **409 handling.**
  1. Replay the pending **semantic commands** onto `current`.
  2. If every precondition holds, save automatically with the toast "Digabung dengan perubahan dari
     tab lain" (merged with changes from another tab).
  3. Otherwise open a per-part dialog ("Teks hook", "Potongan 00:12"): "Pakai punyaku / Pakai yang
     tersimpan" (use mine / use the saved one).

  The editor never locks and the draft is never discarded. There is no CRDT.

### 7.4 Security

**Asset uploads** (`src/ai_clipper/edit_v2/assets.py`, `png_strip.py`,
`web/lib/studio-server/asset-upload.mjs`):

| Step | Rule |
|---|---|
| Transport | Raw body (no multipart parser), a `Content-Type` allowlist, `Content-Length` required and ≤ the kind cap (image 20 MB, audio 50 MB, video 300 MB, LUT 2 MB in Stage 3), `X-Asset-Name` ≤ 80 chars NFC. A storage-admission reservation comes first. At most 30 uploads per minute per session; ≤ 2 GB and ≤ 300 assets per job; a 10 GB workspace library |
| Quarantine | `analysis/assets/.incoming/<uuid>` with `O_EXCL\|O_NOFOLLOW` and mode 0600, hashing and counting while streaming and aborting at the cap |
| Sniff | The first 64 bytes must match the declared kind: PNG, JPEG, WebP, GIF (first frame only), MP4/MOV `ftyp`, WebM/MKV EBML, MP3, M4A, WAV `RIFF…WAVE`, Ogg, FLAC; `.cube` text in Stage 3. **Rejected:** SVG (the image's FFmpeg links `librsvg` `[UX]`), HEIC, PDF, fonts, archives, playlists, concat scripts |
| Ingest | `python -m ai_clipper.edit_v2.assets ingest`: no shell; input through `/proc/self/fd/N`; **forced demuxer** from the sniff (`-f png_pipe\|mov\|matroska\|…`); `-protocol_whitelist file,pipe,fd`; `RLIMIT_AS` 2 GiB; CPU and wall timeouts (image 20 s, audio 60 s, video 10 min); `-threads 2`; non-root. Probe caps: ≤ 4096² and ≤ 16.7 MP (`_verify_raster` limits), video ≤ 1920×1080, ≤ 60 fps, ≤ 10 min; audio ≤ 15 min; at most 1 video + 1 audio stream |
| Normalise | **Images:** EXIF orientation applied, then sRGB RGBA PNG with all ancillary chunks stripped (only IHDR, PLTE, tRNS, IDAT and IEND kept; a stdlib writer, since there is no Pillow), ≤ 2048 px on the long edge. **Video:** H.264 High yuv420p CFR at the job's output fps (other fps become `derived/<sha>@<fps>.mp4` on demand), ≤ 1080p, GOP 0.5 s, BT.709 tags, AAC 48 kHz via explicit `pan`. The **same file** feeds the preview decoder and the render. **Audio:** AAC-LC 192k 48 kHz stereo, with `ebur128` LUFS stored |
| Identity | `sha256(normalised bytes)`. The original is deleted. The name is kept for display only |
| Serve | `Content-Type` from the allowlist, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: same-origin`, `Content-Disposition: inline; filename="asset.<ext>"`, Range, immutable |
| Use | Documents reference asset ids only. The compiler resolves them through fixed roots, which the worker now receives `[R1 D3]`. Client paths never reach FFmpeg |
| Licensing | Library music and SFX need `{owner, id, attribution, url}` or they are not listed. User uploads carry a one-time Content ID warning |
| QG-SEC fuzz | Truncated and malformed PNG, JPEG and MP4; PNG/ZIP and MP4/HTML polyglots; SVG renamed `.png`; a decompression-bomb header; a 10 h silent MP3; MKV with external references; an HLS playlist renamed `.mp4`; a concat script; path-traversal names. **100%** are rejected or safely normalised within their time cap, with no 5xx. `strace` in CI shows no network syscalls and no open outside the quarantine and asset roots |

**Application:**
- **Editor routes** send:
  - `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`;
  - a CSP of `default-src 'self'; script-src 'self' 'nonce-…' 'wasm-unsafe-eval'; worker-src 'self' blob:; img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'`,
    with the nonce set in `web/proxy.js` for Next inline scripts.
- **UI fonts** are self-hosted.
- **Sessions** become server-side session ids with a denylist on logout and a 7-day idle expiry,
  replacing stateless 30-day tokens `[R1 §8]`. This is required **before** the upload route is
  enabled.
- **ASS and graph injection.** The client never sends ASS, filtergraphs or paths. The server
  regenerates everything from the validated document. An escape fuzz test covers `\N {\b1} \h`, RTL
  and emoji `[R1 G8]`.
- **LLM.** Keys stay server-only (`llm.py` redacts them). Only the clip's own transcript text is
  sent. `POTONGIN_LLM=off` hides every AI button.
- **Telemetry** stays local (`_workspace/telemetry/parity.jsonl`) and never leaves the box.
- **Licences.** JASSUB's WASM (LGPL FriBidi, FTL FreeType) and Mediabunny (MPL-2.0) ship unmodified
  as separate assets, with a notices page and source links. If the Docker image is distributed,
  GPL source offers are needed for FFmpeg and x264. A legal review is required before GA `[R3 §10]`.

---

## 8. AI features in the editor

Rules for every task:
- Module `src/ai_clipper/editor_ai.py` (a stdin-envelope CLI) with versioned prompts
  `src/ai_clipper/prompts/editor_{hooks,cold_open,keywords,condense,packaging,broll}_v1.md`.
- It uses `llm.create_llm_client_from_env(cache_dir=<job>/analysis/llm-cache)`, which provides
  `FailoverLLMClient` and `CachedLLMClient` `[REPO llm.py]`.
- An optional `POTONGIN_LLM_EDITOR_MODELS` lets fast models serve the editor while selection keeps
  larger models.
- **Heuristic first:** at most 300 ms, always shown.
- **Async:** 202, then a poll. There is an **overall task deadline** of 20 s for hooks and
  keywords and 30 s for condense and B-roll, which `llm.py` lacks (its timeouts are per request and
  multiply across failover). On any failure the UI shows "Saran AI belum tersedia (kuota/koneksi);
  memakai saran otomatis" (AI suggestions not available because of quota or connection; using
  automatic suggestions).
- **Small prompts:** ≤ 3k input tokens (a 1.2k excerpt of `standar_klip_ai.md` plus the clip's
  *edited* visible transcript as `L0001…` sentence units), `max_output_tokens` 800–1,200,
  `reasoning_effort="low"` where supported. 4–5k-token prompts measured 3.3–14.7 s on the free
  provider `[UX-M6]`.
- **Validated like selection.** Every field is checked and invalid items are dropped; drop reasons
  are stored. Accepting a suggestion runs a normal undoable command with
  `origin: "suggestion:<id>"`. **AI never writes the document.**
- At most 30 AI calls per job per hour, on top of `POTONGIN_LLM_RPM`.

| Task | Stage | Output contract | Validation | Heuristic fallback | Gate (QG-AI) |
|---|---|---|---|---|---|
| **Hook text** | 1 W2 | `{"hooks":[{"text","archetype","style":"pertanyaan\|klaim\|penasaran\|angka\|kutipan\|lucu","emphasis":[…],"label":…,"evidence":["L0003"]}]}`, 6 variants | Length ≤ the design's fit budget (60 by default, 90 at most); `normalize_archetype`; evidence lines exist; **entity grounding** (every number, capitalised non-initial token and quote must occur in the clip text, case-folded, with light `meN-/di-/-nya` stemming); a quote needs `quote_overlap ≥ 0.6`; no URL, @handle or hashtag; token Jaccard < 0.6 between variants; an edit-core fit check ("muat" / "akan terpotong", fits / will be cut) | V3 `hook_text`; hook-unit excerpt; question form if `is_question`; the V3 title | 0 ungrounded entities on 100 clips; the owner rates ≥ 1 of the variants usable as-is on ≥ 70% of 30 clips; p95 ≤ 15 s; the LLM beats the heuristic on ≥ 60% of pairs, **else it ships disabled** |
| **Cold-open picks** | 1 W1 | `{"picks":[{"line":"L0007"}]}` reranking the heuristic candidates | 0.5–8 s, word-snapped; not a duplicate of the body opening (§4.8) | V3 `cold_open`; the `hook_unit_id` unit; top-3 quotability units | The owner prefers the pick over "no cold open" on ≥ 60% of 20 clips (blind A/B) |
| **Keyword emphasis** | 1 W2 | `{"cues":[{"cue":12,"word":"w048140"}]}`, ≤ 1 per cue | The word is in the cue; never a protected particle or pronoun | Numbers and amounts ("Rp", "juta", "%"), capitalised non-initial tokens, highest-IDF content word | Owner accepts ≥ 70% on 10 clips |
| **Condense ("Padatkan ke N dtk")** | 1 W3 | `{"drop":["L0004","L0011"],"reason":"…"}` | Never the hook unit, the payoff unit (`ClipProposal.payoff_unit`, persisted additively), the body occurrence of the cold-open line, or a setup question; result within N ± 10%; ≤ 12 new cuts; removals are placed by §5.3 | Drop the lowest-scoring units; laughter units never dropped | ±10% in 100% of cases; 0 hook or payoff drops; the owner accepts ≥ 70% of proposed cuts on 20 clips |
| **Rapikan** (no LLM) | 1 W3 | Gap classes + lexicon + repeats (§5.3) | Protected particles never listed | n/a | Filler precision ≥ 0.9 on 200 labelled tokens before auto-check; 0 particle false positives; G-CLICK; G-SYNC with 20 cuts |
| **Packaging refresh** | 1 W2 | Title, description, hashtags | `MAX_TITLE_CHARS` 70, `MAX_DESCRIPTION_CHARS` 300, `MAX_HASHTAGS` 6 `[REPO llm_selection]` | Keep the V3 values | The V3 validators pass; shown as a diff |
| **SFX suggestions** (deterministic) | 2 | Ghost SFX items: whoosh at the cold-open join, pop on emphasis, at most 1 per 5 s | Licensed assets only | n/a | Owner accepts ≥ 60% |
| **B-roll moments** | 2 (user library), 3 (opt-in Pexels) | `{"moments":[{"line","phrase","kind","query_id","query_en","confidence_pm"}]}`, ≤ 1 per 8 s | The phrase fuzzy-matches the line; the span is mapped to words | Hidden without an LLM | Relevance ≥ 0.7 on 50 judged moments |

Privacy note in the UI: provider free tiers may use data (the Gemini preset says so). Local `ollama`
is supported.

---

## 9. UX essentials (from UX-first, kept as the product spec)

- **Mode Cepat (Stage 1)** at 1920×1080 (side panels shrink at 1366×768):
  - left: tabs Transkrip / Hook / Subtitle / Media / Audio / Template;
  - centre: the 9:16 stage with safe-zone overlays and an "Exact ●" badge;
  - right: a context inspector plus "Perlu dicek (n)";
  - bottom: five lanes (Video with the cold open and filmstrip; Hook; Subtitle with cue blocks and
    word ticks at ≥ 200 px/s; Overlay; Audio with the waveform, 😂 laughter, ⏸ silences, │ camera
    cuts, and music with the duck envelope drawn **from the plan**).

  **Mode Pro (Stage 2)** changes only the bottom panel: track headers, keyframe lanes (Stage 3) and
  transition handles.
- **The transcript is the spine.**
  - It is a custom word list, **not contenteditable**, with its own selection model.
  - Delete makes a removal with a restorable "⋯ 2,4 dtk" chip.
  - Ctrl+Shift+X hides a word from captions. Double-click edits a word inline; Tab moves to the next
    word.
  - Ctrl+E marks emphasis. `:` opens the emoji picker.
  - Enter forces a cue break. Alt+[ / Alt+] set in and out. Ctrl+Shift+H makes the selection the
    cold open.
  - Ctrl+H is find and replace (this clip or every clip in the project).
- **Keyboard** (CapCut-compatible):
  - Space/K play; J/L shuttle; ←/→ frame step;
  - Ctrl+B split; Q/W trim; Delete ripple; I/O set in/out;
  - `,`/`.` word nudge; Shift+`,`/`.` frame nudge;
  - Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y undo and redo; Ctrl+T add text;
  - `'` safe zones; Ctrl+Shift+R exact frame; Ctrl+Shift+E export; `?` help;
  - Alt+K keyframe (Stage 3).

  Context rules decide Ctrl+E (emphasis when the transcript has focus, effects on the timeline in
  Stage 3).
- **History:** 200 steps; a drag or slider session is one entry (`mergeKey` within 500 ms). Rapikan,
  templates, find and replace, and accept-all are transactions. Measured costs: 15 µs for a trim,
  88 µs for a cue edit, 82 µs for an undo on a 600 KB document `[R3]`.
- **Export dialog:**
  - 1080×1920 (recommended) or the seed's resolution;
  - Standar (veryfast crf 20) or Tinggi (medium crf 18);
  - an SRT sidecar and `cover.jpg` from `cover_f`;
  - title, description and hashtags with copy buttons;
  - a batch queue for the selected clips;
  - the remaining "Perlu dicek" warnings must be clicked through.
- **Templates** ("Simpan sebagai template"; built-ins Umum, Podcast, Gaming, Edukasi):
  "Terapkan ke semua klip" shows a diff ("12 klip akan berubah; 2 punya ubahan manual →
  [Lewati|Timpa]", 12 clips will change; 2 have manual changes → skip or overwrite).
- **UX acceptance protocol (QG-UX)** per wave:
  - 5 Indonesian clippers (≥ 2 LokaClip users, ≥ 2 CapCut-only users) on the reference laptop at
    1366×768 and 1920×1080, think-aloud, 3 unseen gold clips each;
  - a 90% unaided success rate and the median time per task;
  - SUS ≥ 72 at the Stage 1 exit;
  - no open severity-1 issue and ≤ 2 open severity-2 issues;
  - an exported clip that fails any G-gate counts as a failed task.

---

## 10. Staged implementation plan

### 10.0 How to read this plan

- **Task format:** ID · name · **size** in agent-days (ad, `[E]`) · **owns** (exclusive files; no
  other task in the same wave may edit them) · **consumes** (frozen contracts) · **acceptance** ·
  **gates**.
- **Hot files.** Each wave's integrator task **T#.xZ** is the only editor of these files. Other tasks
  put the exact patch in their PR description, and the integrator merges it:
  - `Dockerfile`, `compose.yaml`;
  - `web/package.json` + lock, `pyproject.toml` + `uv.lock`;
  - `web/next.config.mjs`, `web/proxy.js`;
  - `resources/flags.json`;
  - `.github/workflows/*`;
  - the op registries `src/ai_clipper/edit_v2/ops/__init__.py`,
    `web/lib/edit-core/resolve/index.mjs`, `web/lib/preview/compositor/ops/index.mjs`,
    `web/lib/edit-core/commands/index.mjs`.
- **Contract-first.** W0a freezes every schema and module interface (JS and Python signatures, error
  codes, fixture corpus) before parallel work starts. A contract change after the freeze needs a PR
  to `docs/editor/CONTRACTS.md` approved by the architect.
- **Coordination with the V3 branch.** Stage 1 starts after `feat/selection-v3-llm` merges.
  `selection_types.py`, `selection_v3.py`, `pipeline.py`, `render.py`, `captions_ass.py` and
  `subtitles.py` are V3-owned until then. Our only additive requests are `SelectedClip.clip_id` and
  a persisted `payoff_unit`.
- **Definition of done** for every task: unit tests, lint (determinism bans), docs in
  `docs/editor/`, the flag registered and **off**, and every gate named in the task green in CI.
- **Parallel UI before the engine lands.** In W1 the UI tasks develop against a stub engine
  (`web/lib/preview/engine-host.mjs` contract) that plays full class-B bakes, which are exact but
  slow. They do not wait for T1.11.

### 10.1 Stage 1: "Setara LokaClip" (LokaClip-level parity on V3 clips), ≈ 255 ad `[E]`

The critical path is W0 (≈ 3 weeks), then W1 (≈ 5 weeks, bounded by T1.11), W2 (≈ 3 weeks) and
W3 (≈ 3 weeks), plus the 14-day shadow period and the UX sessions. That is ≈ 14–16 calendar weeks
with 8–10 parallel agents `[E]`.

#### Wave W0a: contract freeze (serial, one agent)

**T1.00 Contracts and fixtures** · 4 ad
- **Owns:**
  - `web/lib/edit-core/schema/{clip-edit-v2,render-plan-v1,words-v1,camera-plan-v1,stylepack-v1,hookdesign-v1,template-v1,render-request-v3}.schema.json`;
  - `web/lib/edit-core/errors.mjs`, `src/ai_clipper/edit_v2/errors.py`;
  - `web/lib/edit-core/index.mjs` (typed stubs);
  - `tests/fixtures/edit-v2/{valid,invalid,plans}/**`;
  - `docs/editor/CONTRACTS.md`.
- **Acceptance:**
  - Every schema compiles under ajv 8.20.0 strict mode.
  - ≥ 40 valid and ≥ 60 invalid document fixtures, plus ≥ 30 plan fixtures, are classified.
  - The error-code table has Indonesian message ids.
  - The interfaces of every W0b module are signed off.
- **Gate:** architect and owner review of units and limits.

#### Wave W0b: foundations and spikes (10 parallel agents plus an integrator; no new UI)

**T1.01 edit-core base** · 8 ad
- **Owns:**
  - `web/lib/edit-core/{canon,hash,detmath,rational,ids}.mjs`, `web/lib/edit-core/time/{grid,timemap,asstime}.mjs`;
  - `web/lib/edit-core/schema/validate.generated.mjs`, `web/scripts/gen-validators.mjs`;
  - `web/tests/edit-core-{canon,time,detmath,timemap}.test.mjs`, `tests/edit_v2/test_canon_parity.py`.
- **Acceptance:**
  - Canonical bytes equal Python `json.dumps(sort_keys=True, separators=(",",":"), ensure_ascii=False)` on 200 fixtures.
  - `safeCs` rule: 0 failures over 3 h at 24, 25, 30, 50, 60, 24000/1001, 30000/1001 and 60000/1001 fps.
  - Time-map property tests pass (monotonic; Σ frames; delete then restore is identical).
  - detmath is within 2 ULP of an mpmath reference.
- **Gates:** P-XENG (fixtures), G-DET.

**T1.02 edit-core text and captions** · 10 ad
- **Owns:**
  - `web/lib/edit-core/text/**`, `web/lib/edit-core/vendor/harfbuzz/**`;
  - `web/lib/edit-core/ass/{escape,header,emit}.mjs`, `web/lib/edit-core/ass/reveal/{segment_static,karaoke_sweep}.mjs`;
  - `web/lib/edit-core/resolve/{captions,hook}.mjs` (legacy hook only);
  - `resources/stylepacks/legacy-*/**`, `resources/hook-designs/legacy-bar/**`;
  - `scripts/parity/gen_legacy_vectors.py`, `web/tests/edit-core-captions.test.mjs`.
- **Acceptance:**
  - Chunking vectors from `subtitles.build_caption_cues` tests match 100%.
  - Legacy ASS event text, styles and positions match `captions_ass.py` on 50 cue sets; times differ
    only by frame-safe quantisation (≤ 1 frame).
  - The escape fuzz suite passes.
- **Gates:** P-TXT (legacy packs, via T1.08), P-TIME.

**T1.03 Font pack and resources** · 4 ad
- **Owns:**
  - `resources/fonts/**` (TTF + OFL + `fonts.json`), `resources/fontconfig/fonts.conf`;
  - `resources/emoji/noto/**`;
  - `scripts/parity/calibrate_fonts.py`, `tests/edit_v2/test_fonts.py`.
- **Acceptance:**
  - sha256 of every file matches `fonts.json`.
  - `libass_height_units` are calibrated in the production image, with the ink bbox within ±1 px of
    the harfbuzz prediction at 3 sizes.
  - A missing glyph yields `glyph_unsupported`, and FFmpeg shows no fallback face.
- **Gate:** G-FAIL (fonts).

**T1.04 Python compiler, runner and verifier** · 10 ad
- **Owns:**
  - `src/ai_clipper/edit_v2/{__init__,compile_ffmpeg,execute,verify,core_bridge}.py`;
  - `src/ai_clipper/edit_v2/ops/{range,crop_scale,camera,split,fit_blur,fit_black,overlay,text,fade,audio_mix}.py`;
  - `tests/edit_v2/test_compile_*.py`, `tests/edit_v2/test_verify.py`.
- **Acceptance:**
  - Graph, sendcmd and argv string goldens for R1–R12.
  - No user string in argv or the graph (a property test with hostile text).
  - G1–G5 pass on 6 real renders in the production image.
  - Per-sample envelope expansion is deterministic.
- **Gates:** P-FRAME (server), P-AUD (render), G1–G5, G-DET.

**T1.05 Storage and queue generalisation** · 7 ad
- **Owns:**
  - `src/ai_clipper/versioned_store.py`, `src/ai_clipper/edit_manifest.py` (re-import only);
  - `src/ai_clipper/edit_v2/{store,api}.py`;
  - `src/ai_clipper/render_queue.py` (request v3: `clip_id`, `kind`, `priority`, `render_key`,
    `preset`, the `cancelled` state), `src/ai_clipper/render_worker.py` (lanes, scaled timeout,
    `-progress` liveness, assets root, hard-link snapshot);
  - `tests/edit_v2/test_store*.py`.
- **Acceptance:**
  - The existing 101 editor Python tests pass unchanged.
  - A soak of 5,000 consecutive saves succeeds, with the receipts directory ≤ 200 files.
  - Crash-reconciliation tests pass.
  - A renderer bump forces a re-render.
  - A 300 s clip does not time out.
- **Gate:** QG-PERSIST.

**T1.06 Analysis artifacts and media prep** · 8 ad
- **Owns:** `src/ai_clipper/edit_v2/{words_artifact,camera_plan,media_prep,seed_inputs,clip_id}.py`,
  `tests/edit_v2/test_{words,camera_plan,media_prep}.py`. It does **not** touch `audio_timeline.py`:
  peaks come from media_prep's own window decode.
- **Acceptance:**
  - Window proxies are on the grid (barcode: 0 mismatches), with `setsar=1` and BT.709 tags.
  - Camera-plan samples equal `build_crop_expression` within ±1 px on 360 frames.
  - Gap classes reproduce the `[UX-M2]` distribution on the 48 gold moments.
  - 12 clips are prepared in ≤ 2 min CPU at nice 10.
- **Gates:** P-FRAME (proxy), PF-PREP.

**T1.07 Seed, migration of the auto render, clip identity** · 6 ad
- **Owns:** `web/lib/edit-core/seed.mjs`, `web/lib/edit-core/cli.mjs`,
  `src/ai_clipper/edit_v2/render_edit.py`, `src/ai_clipper/pipeline.py` (the V3 render call only,
  behind `POTONGIN_RENDER_ENGINE=v2`), `tests/edit_v2/test_render_edit.py`.
- **Acceptance:** `render_vertical` keeps its signature and `.srt` sidecar, and `tests/test_render.py`
  stays green with the flag both off and on.
- **Gates:**
  - P-RT: framemd5-identical between the editor path and the auto path; SSIM ≥ 0.98 against legacy
    on 20 clips; owner look approval.
  - PF-RENDER: ≤ the legacy wall time.

**T1.08 Golden harness** · 8 ad
- **Owns:**
  - `scripts/parity/{run.sh,reference.py,compare.py,bless.py,make_sources.py}`;
  - `web/app/parity-harness/page.jsx`, `web/e2e/parity.spec.mjs`;
  - `tests/golden/cases/**` (sources are generated by script, not stored).
- **Acceptance:**
  - Runs inside the production image digest with Chrome for Testing 147.0.7727.15.
  - Heatmap, side-by-side and metrics artifacts are uploaded.
  - The first suite (JASSUB vs libass, legacy packs) runs green.
- **Gates:** the harness itself (P-TXT smoke).

**T1.09 Browser spikes** · 8 ad
- **Owns:** `spikes/editor/**` (throwaway, never imported) and `docs/editor/SPIKES.md`.
- **Exit criteria:**

  | Spike | Criterion | Decides |
  |---|---|---|
  | S-LIBASS-ENGINE | JASSUB WASM driven from our worker, bitmaps blended in WebGL2: P-TXT ≥ 0.999 / max ≤ 16, ≤ 20 ms/frame p95 at 720×1280 on the reference laptop | Single canvas vs stacked canvases with a barrier |
  | S-COPYTO | `VideoFrame.copyTo` I420 + shader: P-DEC SSIM ≥ 0.997, max ≤ 8, ≤ 3 ms/frame at 720p | Own YUV vs `texImage2D(VideoFrame)` with `UNPACK_COLORSPACE_CONVERSION_WEBGL = NONE` |
  | S-AAC-PRIME | Onset error of browser-decoded proxy AAC ≤ 48 samples | AAC vs FLAC-in-MP4 proxy audio |
  | S-PLAY | Playback of 20 cuts over 60 s at 30 fps: 0 dropped frames, A/V ≤ 1 frame at each cut | Pre-roll depth |
  | S-COEP | JASSUB + Mediabunny workers under COOP/COEP + nonce CSP inside Next 16.3.3: loads in < 1.5 s | Header setup |

**T1.10 Security baseline** · 3 ad
- **Owns:** `web/lib/auth.mjs` (server-side sessions + denylist),
  `web/lib/studio-server/security-headers.mjs`, `web/app/globals.css` (removing the Google Fonts
  `@import`), `web/public/fonts/ui/**`, `web/tests/studio-security.test.mjs`.
- **Acceptance:** logout revokes the session; e2e header checks pass; there is no third-party
  request.
- **Gate:** QG-SEC (headers and sessions).

**T1.0Z W0 integrator** · 3 ad
- **Owns:** the hot files (`Dockerfile` gains `COPY resources ./resources` and `FONTCONFIG_FILE`),
  CI workflows, and the registries.
- **Acceptance:** the image builds, CI runs every W0 suite, and the flag defaults are off.

**W0 exit gate.**
- P-XENG, P-FRAME (≥ 2,000 frames, CFR/VFR/AV1), P-TIME, P-TXT (legacy vs yuv444p), P-AUD
  (render), P-RT, G1–G5 on 20 real clips, and PF-RENDER ≤ the legacy wall time.
- Owner approval of the plate blur, yuv444p and native fps.
- Then `POTONGIN_RENDER_ENGINE=v2` becomes the default: every auto clip now comes from the new engine.

#### Wave W1: editor shell and timing edits (9 parallel agents)

**T1.11 Preview engine core** · 20 ad (critical path)
- **Owns:** `web/lib/preview/**`: engine worker, clock, scheduler, decoder pool, frame cache,
  `compositor/{gl,yuv}.mjs`, `compositor/ops/{range,crop_scale,camera,split,fit_blur,fit_black,overlay,fade,text}.mjs`,
  shaders, libass adapter, audio graph, bake source, truth frame, sentinel, device probe; plus
  `web/tests/preview-*.test.mjs`.
- **Gates:** P-FRAME, P-TIME, P-TXT, P-COMP, P-DEC and P-AUD in the browser; PF-SEEK, PF-PLAY,
  PF-LIBASS.

**T1.12 Preview server lane** · 5 ad
- **Owns:** `web/lib/studio-server/{preview-jobs,media-serve}.mjs`,
  `web/app/api/jobs/[id]/clips/[clipId]/preview/{frame,bake,audio}/route.js`,
  `web/app/api/jobs/[id]/media/[...name]/route.js`, `src/ai_clipper/edit_v2/preview_cli.py`.
- **Gates:** PF-TRUTH, PF-BAKE, P-BAKE; cancel on supersede; rate limits.

**T1.13 Edit API and bridge** · 5 ad
- **Owns:** `web/lib/studio-server/edit-bridge.mjs`, `web/app/api/jobs/[id]/clips/route.js`,
  `web/app/api/jobs/[id]/clips/[clipId]/{edit,edit/revisions,edit/revisions/[rev],edit/restore,edit/checkpoints,words,plan}/route.js`.
- **Acceptance:** contract tests for 200, 202, 409, 422, 426 and 428; the virtual seed; the plan
  handshake; the 5,000-save soak over HTTP.
- **Gates:** QG-PERSIST, QG-SEC (CSRF).

**T1.14 Commands, history, autosave, rebase** · 7 ad
- **Owns:** `web/lib/edit-core/commands/{main,captions,hook,history}.mjs`,
  `web/lib/editor/{store,history,autosave,draft-idb,rebase,api-client,flags}.mjs`.
- **Gates:**
  - QG-UNDO: 10k random command sequences, where undo-all equals the initial state and redo-all
    equals the final state.
  - The two-tab e2e test: both edits survive.
  - Reload loses ≤ 2 s of work.

**T1.15 Snapping and removals** · 4 ad
- **Owns:** `web/lib/edit-core/analysis/{snapping,removals}.mjs` and their tests.
- **Gates:**
  - 0 clipped phonemes on 20 hand-labelled gold boundaries (a listening test).
  - Delete then restore is byte-identical.
  - G-CLICK and G-SYNC with 20 cuts.

**T1.16 Studio shell and timeline (Mode Cepat)** · 12 ad
- **Owns:**
  - `web/app/projects/[id]/clips/[clipId]/edit/page.jsx`;
  - `web/components/studio/{TopBar,Stage,Inspector,ChecksPanel,HistoryPanel,ExportDialog,studio.module.css}.jsx`;
  - `web/components/studio/timeline/**` (Video with cold open, Hook, Subtitle with block drag = word
    retime, split = cue break, delete = hide; Overlay; Audio with waveform and markers);
  - `web/lib/editor/shortcuts.mjs`;
  - `web/app/projects/[id]/page.jsx` (the clip-card link and badges).
- **Gates:**
  - PF-OPEN and PF-INPUT; axe with no critical violations; every action reachable by keyboard.
  - QG-UX: T1 fix a clipped first word ≤ 20 s; T2 extend to the laugh ≤ 20 s; T3 replace the cold
    open ≤ 45 s; T4 reload mid-edit; T5 two-tab conflict.

**T1.17 Transcript panel** · 8 ad
- **Owns:** `web/components/studio/transcript/**`.
- **Acceptance:** covers the §9 transcript actions; a 1,000-word window updates in ≤ 16 ms;
  `@tanstack/react-virtual` 3.14.13 for the whole-source search.
- **Gates:** QG-UX T2 (remove a 5 s ramble via the transcript ≤ 20 s); QG-I18N.

**T1.18 Export, SRT and render hook-up** · 4 ad
- **Owns:** `web/app/api/jobs/[id]/clips/[clipId]/renders/route.js`,
  `web/app/api/jobs/[id]/renders/[renderId]/route.js` (adds cancel), `web/lib/edit-core/plan/srt.mjs`,
  `src/ai_clipper/edit_v2/render_edit.py` (stage reporting).
- **Gates:** G1–G5; a cache hit on re-export; stage progress shown; the SRT equals the burned-in
  captions (event times and text).

**T1.19 Cold-open suggestions (heuristic + LLM rerank)** · 3 ad
- **Owns:** `src/ai_clipper/editor_ai.py` (skeleton: envelope, deadline, cache, the `cold_open`
  task), `src/ai_clipper/prompts/editor_cold_open_v1.md`, `web/lib/studio-server/ai-bridge.mjs`,
  `web/app/api/jobs/[id]/clips/[clipId]/ai/**`.
- **Gate:** QG-AI (cold open).

**T1.1Z W1 integrator** · 3 ad
- **Owns:** the hot files (`web/package.json` adds jassub 2.5.16, mediabunny 1.59.1, immer 11.1.18,
  zustand 5.0.15, idb-keyval 6.3.0, ssim.js 3.5.0, react-aria-components 1.21.1,
  @tanstack/react-virtual 3.14.13 and hls.js 1.7.3; ajv 8.20.0 as a dev dependency) and the
  registries.

**W1 exit gate.**
- Every W1 gate green in CI, plus the QG-UX tasks T1–T5.
- The owner ramp opens with the flag `studio.core`: V3 clips become editable (trim, cold open,
  transcript cuts, caption text and retime, legacy styles, legacy hook text, export).

#### Wave W2: the look (8 parallel agents)

**T1.21 Caption packs P1–P8 plus all eight LokaClip animations** · 10 ad
- Packs: Kuning Pop, Kuning-Merah, Kotak Hitam, Stabilo Kuning, Satu Kata, Karaoke Sweep, Santai
  Ketik, TikTok Box.
- Animations: fade, pop, bump, slam, glow, neon, comic, box_pop.
- **Owns:** `resources/stylepacks/{kuning-pop,kuning-merah,kotak-hitam,stabilo-kuning,satu-kata,karaoke-sweep,santai-ketik,tiktok-box}/**`,
  `web/lib/edit-core/ass/reveal/{per_word,chunk_karaoke,cumulative}.mjs`,
  `web/lib/edit-core/ass/anim/**`.
- **Gates:**
  - P-TXT for every pack × 3 texts × 5 timestamps.
  - Non-active words move ≤ 1 px between frames; active-word onset exactly on `n_on`.
  - Cap height ±3% of the pack spec at 1080×1920.
  - < 3,000 events per 90 s clip; ≤ +15% render time; PF-LIBASS.

**T1.22 Hook designs ×9 and HookPanel** · 8 ad
- Designs: Bar, Marker, Note, Gradient, Sticker label, Punchline, Comic, Quote card, Top banner.
- **Owns:** `resources/hook-designs/**` (except legacy), `web/lib/edit-core/ass/hookdesign/**`,
  `web/lib/edit-core/resolve/hook.mjs` (full), `web/components/studio/panels/HookPanel.jsx`.
- **Gates:**
  - P-TXT and G5 at 10/40/90 chars with and without emoji; tilted corners stay inside the frame.
  - Switching design takes ≤ 150 ms.
  - The gallery tiles render the clip's own hook text through libass.

**T1.23 Subtitle panel, custom drawer, find and replace** · 4 ad
- **Owns:** `web/components/studio/panels/SubtitlePanel.jsx`,
  `web/lib/edit-core/commands/captions.mjs` (extensions), `web/lib/editor/find-replace.mjs`.
- **Gate:** QG-UX T6 (apply a pack and fix a misheard word ≤ 15 s); find and replace is one undo
  step.

**T1.24 Overlays: text, sticker, emoji, label, logo, credit, rotate** · 8 ad
- **Owns:**
  - `web/lib/edit-core/resolve/{items,anchors,safe}.mjs`, `web/lib/edit-core/commands/items.mjs`;
  - `resources/text-presets/**`;
  - `web/components/studio/{gizmos/**,panels/MediaPanel.jsx}`;
  - `web/lib/preview/compositor/ops/rotate.mjs`, `src/ai_clipper/edit_v2/ops/rotate.py`;
  - `web/lib/edit-core/raster/mask.mjs`.
- **Acceptance:** the credit auto-fills from yt-dlp `channel`, correctly for 100% of YouTube sources
  that have it.
- **Gates:**
  - P-COMP (stickers above captions, logo); rotated bbox ±1 px; logo alpha ±2%.
  - Emoji in colour in the production image (> 3 distinct hues in the bbox).
  - G5; QG-UX T8 (emoji + logo + credit ≤ 45 s).

**T1.25 Asset store and upload security** · 7 ad
- **Owns:** `src/ai_clipper/edit_v2/{assets,png_strip}.py`,
  `web/lib/studio-server/asset-upload.mjs`, `web/app/api/jobs/[id]/assets/**`,
  `web/app/api/workspace/library/route.js`, `tests/security/upload-fuzz/**`.
- **Gate:** QG-SEC fuzz 100% plus the strace check. **The upload route stays disabled until this is
  green and T1.10 is live.**

**T1.26 AI hooks, keywords, packaging** · 7 ad
- **Owns:** `src/ai_clipper/prompts/editor_{hooks,keywords,packaging}_v1.md`, the task functions in
  `src/ai_clipper/editor_ai.py` (the file is owned in W2), and `web/components/studio/suggestions/**`
  (ghost cards consumed by HookPanel and SubtitlePanel through props).
- **Gates:** QG-AI (hooks, keywords, packaging); QG-UX T7 (AI hook + design + export ≤ 60 s).

**T1.27 Templates, brand kit, apply-all** · 6 ad
- **Owns:** `resources/templates/**`, `web/app/api/workspace/{templates,brand-kit,style-packs}/route.js`,
  `web/app/api/jobs/[id]/clips/apply-all/route.js`, `web/lib/editor/templates.mjs`,
  `web/lib/edit-core/commands/template.mjs`, `web/components/studio/panels/TemplatePanel.jsx`.
- **Gates:** apply to 12 clips as a batch; `skip_overrides` keeps manual changes; each clip is undoable
  on its own; a user style pack exports, re-imports and renders identically.

**T1.2Z W2 integrator** · 3 ad

**W2 exit gate.** Every pack, design and AI flag is on only with its evidence. QG-UX T6–T8 pass.

#### Wave W3: layouts, audio, tightening, migration (8 parallel agents)

**T1.31 Layout engine and editing** · 8 ad
- Modes: camera, split, fit_blur, fit_black, fill_center, branded. Features: layout lane, manual
  reframe box in the source view, seat chips.
- **Owns:**
  - `web/lib/edit-core/resolve/{layout,camera}.mjs`, `web/lib/edit-core/commands/layout.mjs`;
  - `web/components/studio/{panels/LayoutPanel.jsx,timeline/LayoutLane.jsx,source-view/**}`;
  - `src/ai_clipper/edit_v2/ops/branded.py`, `web/lib/preview/compositor/ops/branded.mjs`.
- **Gates:**
  - Manual keys: preview crop = render crop, rect exact.
  - A face-less segment fails loudly or uses an explicit fit_blur (G-FAIL).
  - Split segments ≥ 2 s (8 s by default).
  - QG-UX T9 (force speaker B for a sentence ≤ 15 s).

**T1.32 Smart speaker analysis (YuNet + mouth-motion ASD + VAD)** · 10 ad
- **Owns:** `src/ai_clipper/edit_v2/camera_asd.py`,
  `resources/models/face_detection_yunet_2023mar.onnx` (licence verified), `tests/golden/asd/**`
  (10 labelled two-speaker clips).
- **Gate:**
  - The active speaker's face centre is inside the crop in **≥ 97%** of speech frames.
  - No switch within 1.0 s; pan ≤ 6% of W per 100 ms.
  - **If this fails, "Auto speaker" stays off** and only manual chips ship.

**T1.33 B-roll: image and video** · 8 ad
- Modes: PiP, cutaway, split; fades; rounded masks; mute by default.
- **Owns:** `web/lib/edit-core/resolve/broll.mjs`, `web/lib/preview/compositor/ops/overlay_video.mjs`,
  `src/ai_clipper/edit_v2/ops/overlay_video.py`.
- **Gates:** P-COMP; timing 0 frames against the plan; a VFR phone clip normalised with no drift over
  10 s; 5 overlays on a 60 s clip within PF-RENDER; QG-UX T11 (PiP with fade ≤ 30 s).

**T1.34 Music, SFX, ducking, loudness, class-D master** · 8 ad
- **Owns:**
  - `web/lib/edit-core/{audio/**,resolve/audio.mjs,commands/audio.mjs}`;
  - `src/ai_clipper/edit_v2/audio_annex.py`;
  - `resources/music/**` and `resources/sfx/**` (licensed: whoosh, pop, ding, boom);
  - `web/components/studio/panels/AudioPanel.jsx`.
- **Gates:**
  - During speech, music RMS is ≥ 8 dB below the voice; it recovers ≤ 600 ms after speech ends.
  - Preview vs render envelope < −40 dB (P-AUD).
  - G3 (−14 ± 1 LUFS, TP ≤ −1 dBTP); G-CLICK.
  - QG-UX T10 (add music and confirm the speech is clear ≤ 30 s).

**T1.35 Rapikan, fillers, condense** · 7 ad
- **Owns:** `web/lib/edit-core/analysis/{rapikan,fillers}.mjs`, `resources/lexicon/id-fillers.v1.json`,
  `src/ai_clipper/prompts/editor_condense_v1.md`, the condense task in `src/ai_clipper/editor_ai.py`
  (the file is owned in W3), `web/components/studio/transcript/RapikanDialog.jsx`.
- **Gates:** QG-AI (Rapikan and condense); QG-UX T12 (review 10 items ≤ 60 s) and "tighten a 70 s
  clip to ≤ 50 s using only the transcript in ≤ 3 min".

**T1.36 Batch export, cover frame, export presets** · 4 ad
- **Owns:** `web/components/studio/{ExportDialog.jsx,BatchExport.jsx}` (ExportDialog is taken over
  from W1), `web/lib/editor/batch-export.mjs`.
- **Gate:** export of 12 clips queued in one action, with ≤ 3 min of user time including a template.

**T1.37 V1 migration and V2 editor read-only** · 4 ad
- **Owns:** `web/lib/edit-core/normalize/migrate-v1.mjs`, `src/ai_clipper/edit_v2/migrate_inputs.py`,
  `web/app/projects/[id]/candidates/[candidateId]/edit/page.jsx` (the redirect and read-only banner).
- **Gates:** a fixture for every V1 test document; migrated renders pass G1–G5; the report banner is
  shown.

**T1.3Z W3 integrator** · 3 ad

**Stage 1 exit gate** (all must hold before the stage is called done):
- Every M1–M17 feature `[R2]` is flag-on with linked evidence, including every LokaClip v2.1.0
  capability:
  - jump cuts, undo/redo, subtitle blocks on the timeline, a movable hook, free text;
  - image and video overlays, music with clip and music volume, watermark;
  - 4 layouts + split, 5 reveal modes + 8 animations, 9 hook designs;
  - intro hold, templates, filmstrip, autosave, auto-fit.
- The Potongin-only extras hold their gates: cold open, transcript editing, ducking, emoji,
  laughter markers, AI hooks, Rapikan and condense, and source credit.
- Every P-*, G-* and PF-* gate is green in CI.
- The sentinel shows p5 ≥ 0.98 per op class over 14 days of owner usage.
- QG-UX: SUS ≥ 72; the T-POLISH median ≤ 3 min (trim to a laugh, fix 2 words, delete a sentence,
  choose an AI hook and design, switch to Kotak Hitam, export); "Kembali ke versi AI" found in
  ≤ 20 s; 0 sev-1 issues.
- QG-SEC is green, and every render passes G1–G5.

### 10.2 Stage 2: "Mode Pro", the CapCut multi-track core, ≈ 90 ad `[E]`

**T2.01 Schema minor 1 and resolver: general tracks** · 8 ad
- Up to 8 visual and 4 audio tracks, ≤ 64 items per track; `insert` segments (reordered ranges);
  link groups (A/V), item groups; per-aspect overrides.
- **Owns:** `web/lib/edit-core/schema/*` (minor 1), `web/lib/edit-core/resolve/{main,items}.mjs`,
  `web/lib/edit-core/normalize/migrate.mjs`.
- **Gates:** `compile(migrate(doc_old)) == compile(doc_new)`; P-XENG.

**T2.02 Mode Pro timeline UI** · 14 ad
- Track headers (lock, hide, mute, height), add and remove tracks, drag between tracks, a magnetic
  main track, zoom (Ctrl+= / Ctrl+-, Shift+Z), markers (Shift+M), virtualised lanes.
- **Owns:** `web/components/studio/timeline-pro/**`.
- **Gates:** PF-TIMELINE (50 items at 60 fps); axe.

**T2.03 Pro trim commands** · 8 ad
- Ripple, roll, slip, slide; Q/W; Ctrl+Shift+D; duplicate; link/unlink (Ctrl+L); group (Ctrl+G);
  copy and paste attributes.
- **Owns:** `web/lib/edit-core/commands/{protrim,groups}.mjs`.
- **Gates:** property tests (time map monotonic, captions consistent, anchors resolved); QG-UNDO with
  200-step multi-track sequences.

**T2.04 Free z-order** (text between images) via N ASS passes · 8 ad
- **Owns:** `web/lib/edit-core/plan/bands.mjs`, `src/ai_clipper/edit_v2/ops/text_multi.py`,
  `web/lib/preview/libass/multi.mjs`.
- **Gates:** P-TXT and P-COMP with 3 passes; ≤ +10% render time per extra pass.

**T2.05 Constant speed 0.5–2× and freeze frame** · 8 ad
- Video uses the grid index map. Audio uses a class-D derived file (`rubberband` is in the image
  `[UX]`).
- **Owns:** `src/ai_clipper/edit_v2/derived.py`, `web/lib/edit-core/resolve/speed.mjs`,
  `web/lib/preview/derived-source.mjs`.
- **Gates:** the frame map is exact; the D bytes are shared (sha equal); A/V ≤ 1 frame; speech is
  intelligible at 1.25× (listening panel).

**T2.06 Multi-aspect export** (9:16, 1:1, 4:5, 16:9) · 8 ad
- Per-aspect design spaces and layout overrides, safe-area reflow.
- **Owns:** `web/lib/edit-core/resolve/aspect.mjs`, `web/components/studio/AspectSwitcher.jsx`.
- **Gates:** G5 per aspect; P-COMP per aspect.

**T2.07 SFX library and deterministic SFX suggestions** · 5 ad
- **Owns:** `resources/sfx/**` (expanded), `web/lib/edit-core/analysis/sfx-suggest.mjs`.
- **Gate:** QG-AI (SFX).

**T2.08 B-roll moments from the user library** · 6 ad
- **Owns:** `src/ai_clipper/prompts/editor_broll_v1.md`, the broll task in `editor_ai.py`,
  `web/components/studio/suggestions/BrollGhosts.jsx`.
- **Gate:** QG-AI (B-roll).

**T2.09 Change fps and re-grid command** · 4 ad
- A rational rescale of every `_sf` with a warning.
- **Owns:** `web/lib/edit-core/commands/regrid.mjs`.
- **Gate:** P-FRAME after the re-grid.

**T2.10 Browser promotion** (Firefox and Safari report-only → supported where green) · 5 ad
- **Owns:** `web/e2e/parity-*.spec.mjs` matrices.
- **Gate:** the full parity suite green per browser.

**T2.11 Retire the V2 editor and legacy render code** · 4 ad
- Retire `render_manifest._build_ass` and `_layout_filter`, `candidate_cues.py` (V3 path), and the
  `render.py` command builders.
- **Gates:** a dry-run migration report; every test green.

Plus integrators **T2.xZ**.

**Stage 2 exit gate:**
- R2 S1–S4 (the non-keyframe parts), S6, S11–S13 shipped.
- QG-UX: CapCut-only users complete "split, delete, drag to another track, reorder, speed 1.25×"
  unaided, with a median ≤ 2 min; SUS ≥ 72.
- PF-TIMELINE; PF-RENDER p95 ≤ 1.0×.

### 10.3 Stage 3: keyframes, transitions, effects, ≈ 85 ad `[E]` (excluding T3.10)

Each new op starts as **class B** and is promoted to N by §6.2.

**T3.01 Keyframe engine** · 12 ad
- Properties: x, y, w, scale, rotation, opacity, crop, gain. Eases: hold, linear, in, out, in_out,
  bézier (detmath, 24 fixed bisection steps). Emitted through sendcmd. UI: Alt+K, diamonds, easing
  presets.
- **Owns:** `web/lib/edit-core/resolve/keyframes.mjs`, `web/lib/edit-core/commands/keyframes.mjs`,
  `web/components/studio/keyframes/**`.
- **Gates:** per-frame values equal by construction (P-XENG over 40 keyframe fixtures); P-COMP with 5
  keyframed overlays; sendcmd size ≤ 2 MB per 60 s; QG-UX "punch-in on a laugh ≤ 30 s".

**T3.02 Spike S-ZOOM, then animated zoom, punch-in and Ken Burns** · 8 ad
- **Owns:** `src/ai_clipper/edit_v2/ops/zoom.py`, `web/lib/preview/compositor/ops/zoom.mjs`.
- **Gate:** rect exact on 300 frames at ≤ 1.3× the static cost, or the op stays off.

**T3.03 Transitions: xfade subset as islands** · 12 ad
- Types: fade, fadeblack, fadewhite, wipe×4, slide×4, circleopen/close, smooth×4; equal-power audio
  crossfade on the same samples.
- **Owns:** `src/ai_clipper/edit_v2/ops/transition.py`,
  `web/lib/preview/compositor/ops/transition.mjs`, `web/lib/preview/compositor/shaders/xfade/**`.
- **Gates:** per type SSIM ≥ 0.995 at 25/50/75% (S-XFADE); G-SYNC with 3 transitions.

**T3.04 Effects** · 12 ad
- eq, LUT (strict `.cube` parser ≤ 65³ in `src/ai_clipper/edit_v2/cube_lut.py`), vignette, sharpen,
  shake, flash.
- **Owns:** `ops/{eq,lut3d,vignette,unsharp,shake}.py` and `.mjs` twins.
- **Gates:** eq SSIM ≥ 0.995; LUT ΔRGB ≤ 1; the LUT fuzz corpus is rejected.

**T3.05 Text animation in/out/loop and caption pack 2** · 8 ad
- Pack 2: Neon, Komik, Glow, Kapsul. Animations: bounce, shake. Per-word emoji auto-insert (AI) is
  offered as suggestions.
- **Owns:** `resources/stylepacks/{neon,komik,glow,kapsul}/**`, `web/lib/edit-core/ass/anim/pack2/**`.
- **Gates:** P-TXT and the jitter test.

**T3.06 Masks and PiP shapes** (circle, rounded rectangle, border, shadow) · 6 ad
- **Owns:** `web/lib/edit-core/raster/shapes.mjs`, `ops/mask.*`.
- **Gate:** mask edge ±1 px.

**T3.07 Audio clean-up as class D** (`afftdn` / `arnndn` RNNoise BSD-3, EQ, de-ess) · 6 ad
- **Owns:** `src/ai_clipper/edit_v2/derived_audio.py`.
- **Gates:** a 10-clip listening panel; G3.

**T3.08 Cover card and comment-reply card** · 6 ad
- **Owns:** `resources/hook-designs/{cover,comment-card}/**`,
  `web/components/studio/panels/CoverPanel.jsx`.
- **Gates:** the cover never delays the audio hook by more than 1.0 s; readable at 1080 w (cap
  ≥ 1.6% H).

**T3.09 Segment-parallel rendering** · 8 ad
- **Owns:** `src/ai_clipper/edit_v2/render_parallel.py`.
- **Gate:** framemd5-identical to a single pass in `reference` mode; 1.5–2× faster on 4 CPUs.

**T3.10 COULD items**, each scheduled with its own spike: Pexels opt-in B-roll, TTS, EN/MY
translation, "edit dengan chat" on the command API (every action a logged, undoable command),
three-person and gaming layouts.

**Stage 3 exit gate:**
- Every op promoted to N, or explicitly left as B with a named reason.
- P-COMP on the combined scene (cold open + 20 cuts + 3 transitions + 5 keyframed overlays + LUT +
  ducked music).
- PF-RENDER p95 ≤ 1.0×.
- QG-UX: "split, delete, add a transition, keyframe a zoom" median ≤ 2 min for CapCut users.

---

## 11. Risks

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| Custom engine cost (the Stage-1 critical path, T1.11) | High / Medium | A narrow Stage-1 op set; class B as a safety net from day 1; UI developed against a stub engine; spikes decide the risky paths first |
| libass skew (JASSUB 0.17.4-43 vs Debian 0.17.1) | Medium / Medium | Exact pins; P-TXT on every upgrade (measured 0.9998 against RGB, 0.99925 against yuv444p). Option: build FFmpeg against the same libass tag (about 1 pw) |
| Forked JASSUB glue breaks on upgrade | Medium / Low | Exact pin; a 300-line adapter with contract tests; unmodified WASM; fallback to the stacked-canvas mode |
| GPU and colour paths on Safari and Firefox | Medium / Medium | Own YUV conversion (if S-COPYTO passes); report-only suites; sentinel kill switch; Chromium-only GA |
| Cross-engine float drift | Low / High | detmath, lint bans, P-XENG on every PR, plan handshake |
| Node in the render path | Low / Medium | Same image; zero npm runtime deps; bounded `core_bridge.py`; Node 22 nightly ahead of the LTS move |
| CPU contention (Whisper + renders + previews) | High / Medium | Lanes, `nice`, semaphores, cancel on supersede; proxies only for selected clips; the `preview-worker` split is measured, not assumed |
| Face and ASD quality | High / High | Editable camera plan; manual chips; 97% gate; never a silent centre crop |
| Whisper drops fillers; voiced gaps | High / Low | Rapikan is a review list; condense works on sentences; honest UI copy `[UX-M1/M2]` |
| Free-LLM limits and latency | High / Low | Heuristics always shown; deadlines; cache; a separate editor model chain |
| Scope pressure against "no half-baked" | High / High | Flags with evidence; stage gates; §12 |
| Licensing (LGPL in WASM, GPL FFmpeg if distributed, music) | Medium / Medium | Notices; legal review before GA; licensed library only |
| Owner rejects a look change (plate blur, yuv444p, native fps) | Medium / Low | Approval gate at the W0 exit; fallbacks: `fit_blur_legacy` as a class-B op, yuv420p compositing |

## 12. What we will NOT build

- DOM or CSS rendering of any shipped pixel. DOM is for handles, guides and gizmos only.
- ffmpeg.wasm (32 MB, GPL, 0.9× realtime `[R3]`), Remotion, Editframe, DesignCombo, Twick, Shotstack
  Studio or etro (licences `[R3 §7]`).
- Browser-only effects, `sidechaincompress`, dynamic `loudnorm`, `gblur`, `dissolve`, time-varying
  crop size, `drawtext`, expression-driven animation.
- Colour emoji through libass, user font uploads, SVG uploads, and animated GIF or Lottie (until a
  class-D pre-rasterisation path exists in Stage 3).
- A second implementation of any resolver logic. `captions_ass.py`, the `subtitles.py` chunking,
  `render_manifest._build_ass` and `_layout_filter` are retired after the W0 flip and T2.11; their
  tests become edit-core vectors.
- A blind "Hapus semua kata pengisi" (remove all filler words) button.
- Real-time collaboration or CRDT. This is a single-owner product.
- GET requests with side effects. Client-sent ASS, graphs or paths.
- HDR editing ("sumber HDR belum didukung", HDR sources are not supported yet), 4K output, or a 60 fps
  default.
- Speed ramps with curves, pitch-shifted live audio, generative features (morph cuts, eye contact),
  or background removal unless it runs at ≤ 2× realtime on CPU.
- Per-edit clean-master re-renders (LokaClip's model). Server pixels are a fallback, never the main
  path.

## 13. Decisions the owner must make (before W0 exit unless noted)

1. **yuv444p compositing** (+19–29% render time; text-edge max diff 93 → 15). Recommended: yes.
2. **Plate blur** replaces `gblur` (SSIM 0.993 against the old look, −37% time). Side-by-side
   approval on 5 clips.
3. **Native frame rate** (29.97 stays 29.97; 60 is halved). Recommended: yes.
4. **Node in the render path** (edit-core via `/app/lib/edit-core/cli.mjs`). Recommended: yes; the
   image already runs Node in every service.
5. **Browser policy:** Chrome and Edge desktop at Stage-1 GA.
6. **libass alignment:** accept the pinned skew under gates, or rebuild FFmpeg against JASSUB's
   libass tag.
7. **Music and SFX library source** (curated CC0 or royalty-free vs paid), before W3.
8. **LGPL-in-WASM legal review**, before GA.
9. **The reference laptop model**, before the W1 exit.

---

## Appendix A: libraries (npm or PyPI; versions checked 2026-09-24 by R3 and PF)

| Package | Version | Licence | Use | Where |
|---|---|---|---|---|
| jassub | 2.5.16 (exact) | MIT wrapper; WASM bundles libass (ISC), FriBidi (LGPL-2.1+), FreeType (FTL), HarfBuzz (MIT) | libass WASM | Browser |
| mediabunny | 1.59.1 | MPL-2.0 (unmodified) | WebCodecs demux and decode | Browser |
| harfbuzzjs | 1.6.2 (vendored WASM, sha-pinned) | MIT | Shaping in edit-core | Browser + Node |
| ajv | 8.20.0 | MIT | Standalone validators (build time) | Dev |
| immer | 11.1.18 | MIT | Patches and undo | Browser |
| zustand | 5.0.15 | MIT | Store | Browser |
| idb-keyval | 6.3.0 | Apache-2.0 | Drafts | Browser |
| ssim.js | 3.5.0 | MIT | Sentinel | Browser |
| react-aria-components | 1.21.1 | Apache-2.0 | Accessible controls | Browser |
| @tanstack/react-virtual | 3.14.13 | MIT | Transcript and lane virtualisation | Browser |
| hls.js | 1.7.3 | Apache-2.0 | "Pratinjau server" fallback | Browser |
| @playwright/test | 1.62.1 + Chrome for Testing 147.0.7727.15 | Apache-2.0 | Golden harness | Dev (already a dependency) |
| opencv-python-headless | ≥ 4.10 (existing `vision` extra) | Apache-2.0 | `FaceDetectorYN` (YuNet model from OpenCV Zoo, MIT per its model card; verify at adoption) | Python |
| Fonts | see §4.6 | OFL-1.1 (DejaVu: Bitstream Vera) | Packs and designs | Image + browser (same bytes) |
| Noto Emoji PNG | pinned | Apache-2.0 | Emoji overlays | Image + browser |

No new Python runtime dependency: the engine stays stdlib-only.

## Appendix B: fate of existing code

| Existing | Fate | When |
|---|---|---|
| `edit_manifest.py` primitives | Extracted into `versioned_store.py`; V1 schema frozen | T1.05 |
| `editor_api.py` receipts and reconcile | Algorithm kept; digest-only, pruned | T1.05 |
| `render_queue.py`, `render_worker.py` | Generalised (request v3, lanes, cancel, scaled timeout, render key) | T1.05, T1.18 |
| `render.py` | `render_vertical` becomes a wrapper over seed → plan → compile; fd and no-clobber helpers reused by `execute.py` | T1.07; builders retired in T2.11 |
| `captions_ass.py`, `subtitles.py` chunking | Semantics ported into edit-core (legacy packs, vectors), then retired | T1.02 → T2.11 |
| `face_tracking.py` | `detect_face_track`/`smooth_face_track` move to analysis-time `camera_plan.py`; `build_crop_expression` stays as the test reference | T1.06 |
| `render_manifest._build_ass`, `_layout_filter`, `candidate_cues.py`, `web/lib/caption-cues.mjs` | Retired | T2.11 |
| V2 editor page | Read-only, then redirect | T1.37 → T2.11 |
| `editor-timeline.mjs` ideas (10 Hz seeks, playhead outside React) | Carried into the new timeline | T1.16 |
| `preview-source` fd Range streaming | Reused for `/media/*` and `/assets/*` | T1.12, T1.25 |
| `llm.py`, `llm_selection` validators, `hook_heuristics.py`, `sentences.py`, `audio_timeline.py`, `sound_events.py` | Consumed as they are | W1–W3 |

## Appendix C: evidence index

| Claim | Source |
|---|---|
| Grid rule 0/1,125 vs 558/1,125 (CFR) and 350/1,125 (VFR) | `spike-pf/frame_identity.py`, `naive_identity.py` |
| ASS truncation vs JASSUB rounding; frame-safe rule 0 failures | `spike-pf/t.sh`, `jprobe.mjs`, `ass_time_rule.py` |
| yuv444p text parity and cost | `spike-pf/ref_fmt.sh`, `cost444.sh`, `rgbcost.sh` |
| sendcmd crop, overlay, scale and alpha frame-exact; `amultiply` 1.5e-5; −3 dB upmix | `spike-pf/graph.sh`, `sheet.png` |
| Camera sendcmd bit-identical 360/360 | `inc/e2_sendcmd.py` |
| Envelopes 7.4e-9 / −148.6 dB; −153 dB | `inc/e3_duck.py`, `e3_webaudio.mjs`; `ux/duck_envelope.py`, `webaudio_env.mjs` |
| One decoder per run: 2096/2096, 13% faster (720p); equal cost at 1080p | `inc/e4_cuts.py`; `ux/jumpcut_bench.py` |
| Plate cells cost and fidelity | `inc/e1_plate.sh`, `e1b.sh` |
| Fillers rare; 78% of long gaps not silent | `ux/tighten_stats.py`, `gap_classes.py`, `safe_tighten.py` |
| JASSUB 1080×1920, 520 events, p95 29 / 23.9 ms | `ux/jassub_edit_bench.mjs` |
| Free-LLM latency 3.3–14.7 s at 4–5k tokens | `ux` UX-M6 (read from `llm-cache`) |
| JASSUB vs libass 0.9998; CSS 0.976–0.990; decode 0.9983; seek 3.7 ms; plate blur 0.9937; ffmpeg.wasm rejected | `lab/` (R3 Appendix A) |
| Emoji tofu; pop reflow 56 px; crop reinit failure; xfade timebase; acrossfade drift | `_bench/` (R2 §2.4) |
| V2 editor defects D1–D11, parity gaps P1–P22 | `measure/` (R1) |
