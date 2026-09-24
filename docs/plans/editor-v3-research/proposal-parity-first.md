# Proposal: a parity-first editor for Potongin

Date: 2026-09-24. Angle: **parity first**. There is one declarative edit document. One
implementation compiles it into a frame-exact render plan. The FFmpeg filtergraph and the browser
compositor only execute that plan, and golden-frame tests prove that they agree. Every other
decision in this proposal follows from that.

Inputs:
- R1 `r1-existing-editor.md` (audit of the V2 editor)
- R2 `r2-feature-inventory.md` (features, competitors, style packs)
- R3 `r3-tech.md` (preview technology lab)
- New measurements from this run, in `editor-design/spike-pf/`

The repo was only read; nothing in it was changed.

Evidence tags:

| Tag | Meaning |
|---|---|
| `[PF]` | Measured in this run: production image `ai-video-clipper:latest` (FFmpeg 5.1.9, libass 0.17.1), local FFmpeg 6.1.1, and Chrome for Testing 147 with JASSUB 2.5.16 |
| `[R1]` `[R2]` `[R3]` | Measured by the earlier research runs |
| `[D]` | Design decision in this proposal |
| `[SPIKE]` | Must be proven, with the stated exit criterion, before anything is built on it |

---

## 0. Summary

### 0.1 The shape

```
EditDocument  (clip-edit-v2, integers only, stored, revisioned, ETag)
     │   edit-core (ONE implementation, pure ESM JavaScript; runs in the browser and in Node on the server)
     │     normalize → resolve → layout text (harfbuzzjs) → emit ASS → sample keyframes → build envelopes
     ▼
RenderPlan    (render-plan-v1: every frame index, pixel rectangle, ASS byte, and gain sample decided)
     ├──► Python compile_ffmpeg.py → FFmpeg 5.1.9 argv + sidecars → final render, truth frames, segments
     └──► Browser engine (worker): WebCodecs decode → WebGL2 ops → libass (WASM) bitmaps → one canvas
                                     WebAudio + AudioWorklet envelopes (AudioContext = master clock)
                     ▲
          Golden suite: the same plan fixtures run through both backends, compared per op, per frame
```

### 0.2 Decisions

| # | Decision | Why (evidence) |
|---|---|---|
| D1 | **One compiler front end (`edit-core`) in JavaScript.** It runs in the browser for instant preview and under Node in the render worker. The image already runs Node 20 next to Python, and the worker already calls a Node script (`RENDER_STORAGE_CLI`). This replaces R3's option A (Python canonical plus a JS port with conformance vectors). | Two implementations drift, and conformance vectors only catch what they cover. The browser needs the resolver locally for typing latency. Python keeps storage, the queue, execution, the FFmpeg compiler and analysis. |
| D2 | **Integers only** in the document and the plan: frames, source-grid frames, milliseconds, samples, 1e-5 fractions, per-mille, centi-dB. | Canonical JSON is byte-identical from Python `json.dumps(sort_keys, separators, ensure_ascii=False)` and from ES `JSON.stringify`. There is no `round()` half-even vs `Math.round` trap and no float formatting difference (R3 flagged both). |
| D3 | **Canonical source grid.** Source frame *k* means frame *k* of `fps=F` applied from source t=0. The final render reaches a range with `-ss (a/F − 1 s) -copyts -i SRC … fps=F,trim=start_pts=a:end_pts=b`. Proxies are built on the same grid, and the browser addresses them by frame index. | [PF] 0 mismatches in 2 × 1,125 random frames (CFR 29.97 and VFR), in both FFmpeg 5.1.9 and 6.1.1. The current `render.py` style (float `-ss`, timestamp reset) picked a different frame for **558/1,125 (49.6%)** CFR and **350/1,125 (31%)** VFR frames. |
| D4 | **Frame-safe ASS timing.** Every event and karaoke boundary is written at a centisecond that lies ≥ 2 ms inside the frame interval, as FFmpeg computes it. The browser gives libass `nowMs(n) = trunc(n·(den/num)·1000)`, the same double arithmetic. | [PF] FFmpeg's `ass` filter truncates `pts·tb·1000`. At 25 fps an event at 32.12 s is **not** visible on frame 803 (32119.999… ms). JASSUB **rounds** mediaTime·1000 (32119.5 → visible), so naive preview and render disagree by one frame. At 30 fps, 7,328 frames in 3 h are hazards. The rule gives 0 failures at 24–60 fps and at NTSC rates, with a margin of ≥ 2 ms. |
| D5 | **Composite in yuv444p** on the server, and convert to yuv420p only for the master encode. | [PF] Text parity against JASSUB: yuv420p compositing gives SSIM 0.9970–0.9992, max diff 93, and up to 2,686 px off by more than 16. yuv444p gives **0.99925–0.99958, max 15, 0 px off by more than 16**. Cost at 1080×1920 on 4 CPUs: yuv420p 8.2–8.9 s, **yuv444p 10.6 s**, gbrp 12.3 s, rgb24 14.2 s per 30 s of output. |
| D6 | **libass runs inside the preview engine.** The engine worker drives JASSUB's WASM and composites the `ASS_Image` bitmaps in the same WebGL2 pass as the video and overlays. That gives one canvas and frame-synchronous text, instead of three stacked canvases (R3). | Karaoke highlight timing must not lag the video by one frame during playback. This also allows arbitrary z-bands later. |
| D7 | **The engine does its own YUV→RGB conversion.** It uses `VideoFrame.copyTo()` I420 planes and a BT.709 limited-range shader that matches the `scale=in_color_matrix=…` the final graph uses. | This removes the dependence on browser and GPU colour management, which R3 lists as the main Safari/Firefox risk. |
| D8 | **Gain envelopes are signals.** edit-core generates the per-sample gain: join micro-fades, mutes, ducking, fades and limiter. FFmpeg multiplies with `amultiply`, and the browser multiplies with an AudioWorklet running the same JS generator. | [PF] `amultiply` against a reference envelope: max error 1.5e-5, which is half of one s16 LSB. The implicit mono→stereo `aformat` upmix is **−3 dB**, so every channel mapping must be an explicit `pan`. |
| D9 | **All animated video parameters go through `sendcmd`**, with per-frame integers precomputed by edit-core: crop x/y, overlay x/y, overlay scale w/h, alpha, rotation angle. | [PF] In FFmpeg 5.1.9: a `crop@cam` pan, `overlay@` move, `scale@…:eval=frame` resize into `overlay eval=frame`, and `colorchannelmixer` alpha all worked frame-exactly (`spike-pf/sheet.png`). |
| D10 | **Audio operations WebAudio cannot reproduce** (speed with pitch preservation, denoise, the true-peak limiter measurement) are previewed with server-rendered audio for that span. | Audio parity without pretending. Audio-only renders are cheap. |
| D11 | **The automatic V3 render moves onto the same engine.** It becomes the render of a seeded revision 0, so "revision 1 equals the auto clip" holds by construction (decoded-frame MD5 identical). | This removes today's second and third pipelines (`render.py`, `render_manifest.py`). |
| D12 | **Output fps defaults to the native standard rate** (24000/1001 … 30, with 50/60 halved), and sample positions are integer: `smp(n) = ⌊n·48000·den/num⌋`. | This avoids 29.97→30 duplicate-frame judder and keeps A/V cuts sample-exact (the sequence is 1601/1602 samples at 29.97). |
| D13 | **Plan-hash handshake.** The client sends the `plan_sha256` it previewed, and the server recomputes it. A mismatch blocks export and asks the user to reload. | This catches a stale client bundle or cross-engine math drift before it reaches a render. |
| D14 | **Nothing ships behind an approximation.** Each op, style pack and hook design sits behind a flag that turns on only when its golden cases, UX tasks and performance budget pass. | This is the owner's rule, "jangan menurunkan kualitas". |

### 0.3 Effort

Rough sizing for 2–3 engineers:

| Stage | Size |
|---|---|
| Stage 0 (foundations and auto-render migration) | 8–10 person-weeks (pw) |
| Stage 1 (LokaClip parity plus the gaps LokaClip has), split 1a / 1b / 1c | 12 + 10 + 12 pw |
| Stage 2 (CapCut core) | 18–22 pw |

Section 10 holds the gates for each stage.

---

## 1. The parity contract

### 1.1 Levels (R3 terms, sharpened)

| Level | Meaning | Mechanism | Gate |
|---|---|---|---|
| L0, semantic | Same frame for every event: range joins, which source frame, text on/off, karaoke switch, overlay enable, transition progress, keyframe values, gain per sample | Single edit-core, integer plan, frame-safe timing, canonical grid | **Hard, 0 mismatches** (P-FRAME, P-TIME, P-XENG) |
| L1, perceptual | Live preview frame vs the lossless FFmpeg reference of the same plan | Parity-safe op catalog (§5.5), yuv444 compositing, own colour conversion | Per op: text SSIM ≥ 0.999 with 0 px off by more than 16; composite SSIM ≥ 0.99 / PSNR ≥ 35 dB |
| L2, pixel | Frames from the production binary | Truth frames (0.16–0.43 s) on pause, and server segments | Always one pause away |

**What "identical" cannot mean.** Honesty with the owner comes first here.
- The final H.264 encode (crf 20–21, 4:2:0) loses about SSIM 0.005 against the lossless graph output: 0.995 measured [R3]. The preview shows the lossless look.
- The preview decodes a 720p proxy, while the render decodes the source. At 9:16 crop scale that is about 1:1 on a 405 px stage [R3], but a 1080×1920 preview upsamples.

The UI states both facts once, in the help text. It never pretends otherwise.

### 1.2 Invariants (enforced by code, tested in CI)

- **I1.** The browser and the server never make a layout, timing or mixing decision. Only edit-core does, and its output is the RenderPlan.
- **I2.** The document and the plan contain only JSON integers, strings, booleans, null, arrays and objects. Floats are rejected at parse time.
- **I3.** Every time on the output timeline is an integer frame index `n` at `output.fps = num/den`. Every source reference is an integer source-grid frame. Audio positions are `smp(n) = ⌊n·48000·den/num⌋`.
- **I4.** ASS event and karaoke times are frame-safe centiseconds (§4.2). libass's clock is `nowMs(n)` on both sides.
- **I5.** Every pixel rectangle in the plan is integer. Source crops are even-aligned (yuv420 sources). Overlay positions need no even rounding, because compositing is yuv444p.
- **I6.** The same font bytes (sha256-pinned) are used by libass in FFmpeg (`fontsdir`, with no system fallback) and by libass in WASM. The same PNG bytes, with colour chunks (`cICP`, `gAMA`, `iCCP`, `sRGB`) stripped, are used on both sides [R3 bug 2].
- **I7.** Every animated parameter is pre-sampled per frame by edit-core, and both sides consume the samples: `sendcmd` on the server, a uniform per frame in the browser. Neither side evaluates FFmpeg expressions, CSS animations or GPU-only effects.
- **I8.** Gains are per-sample signals produced by the same generator on both sides. The only non-reproducible audio operations are rendered on the server, including for preview.
- **I9.** Channel layouts, sample rates, colour matrices, colour ranges, SAR and timebases are always explicit in the FFmpeg graph (`pan`, `aresample=48000`, `in_color_matrix`, `setsar=1`, `settb`). Implicit conversions are compile errors in `compile_ffmpeg.py` tests.
- **I10.** Any op without a passing golden case is invisible in the UI, and rejected by the server validator unless its feature flag is on.

### 1.3 New measurements in this run (`spike-pf/`)

| Question | Result |
|---|---|
| Does a seeked range render pick the same source frames as a whole-file `fps=F` pass (the proxy grid)? | With `-ss (a/F−1) -copyts … fps=F,trim=start_pts=a:end_pts=b,setpts=PTS-STARTPTS`: **0/1,125** frames differ (29.97 CFR H.264 GOP 250, and VFR MKV with jittered 1 ms timestamps), on both FFmpeg 5.1.9 (prod) and 6.1.1. With float `-ss`, a timestamp reset and `fps` (today's approach): **558/1,125** differ (11 ranges off by exactly one frame) and **350/1,125** on VFR. |
| When does FFmpeg's `ass` filter switch an event on? | `(long long)(pts·av_q2d(tb)·1000)`, truncating. At 25 fps an event starting at `0:00:32.12` is invisible on frame 803 and visible from 804 (signalstats YAVG 16 → 74). At 30 fps, 7,328 of the 3-hour frames are such hazards. |
| How does JASSUB 2.5.16 map mediaTime to libass ms? | It **rounds** to the nearest ms: mediaTime 32.1194 → hidden, 32.1195 → shown, `803/25` → shown. So a naive preview shows frame 803 while FFmpeg does not. |
| Does the frame-safe centisecond rule always exist? | Rule: `cs = ⌊(nowMs(n) − 2)/10⌋`. **0 failures** over 3 h at 24, 25, 30, 50, 60, 24000/1001, 30000/1001 and 60000/1001 fps. Minimum distance to either frame clock is 2–9 ms. |
| Do the FFmpeg 5.1.9 per-frame mechanisms needed for keyframes work? | Tested via `sendcmd`: `crop@cam x`, `overlay@st x/y`, `scale@sts w/h` (with `eval=frame`, variable-size overlay input), `colorchannelmixer@sta aa`, and `overlay … enable='between(n,10,80)'`. **All frame-exact.** `ass` works on a gbrp graph (`sheet.png`). |
| Is an explicit gain envelope applied sample-exactly? | Yes. `amultiply` with a float32 envelope: max error **1.5e-5** (half of one s16 LSB), after correcting for the **−3 dB** that `aformat` silently applied on the mono→stereo upmix. |
| What does the compositing pixel format cost, and what does it buy? | 30 s of 1080×1920, low-res plate blur plus karaoke ASS, `--cpus 4`, best of 3: yuv420p 8.2–8.9 s, **yuv444p 10.6 s (+19–29%)**, gbrp 12.3 s, rgb24 14.2 s. Text vs JASSUB: yuv420p SSIM ≥ 0.9970 (max 93), yuv444p ≥ **0.99925 (max 15)**, rgb24 ≥ 0.9998 (max 13). |

Timings were taken on a machine shared with other agents, so treat them as indicative.

---

## 2. System architecture

### 2.1 Components and where code lives

```
web/lib/edit-core/            (NEW, pure ESM, no DOM, no Node-only APIs; ~6–8k LOC)
  schema/clip-edit-v2.schema.json     JSON Schema 2020-12 (source of truth for both validators)
  schema/validate.generated.mjs       ajv 8.20.0 (MIT) standalone output (no eval → CSP-safe)
  canon.mjs, hash.mjs                 canonical bytes, SHA-256 (WebCrypto / node:crypto)
  detmath.mjs                         deterministic exp/log/pow/sin/cos from + − × ÷ √ only
  time.mjs                            grid, smp(n), nowMs(n), frame-safe centiseconds, time map
  normalize/{defaults,migrate,packs}.mjs
  resolve/{main,layout,camera,captions,hook,overlays,audio,effects,transitions,safe}.mjs
  text/{fonts,shape(harfbuzzjs 1.6.2 MIT),measure,wrap,fit}.mjs
  ass/{escape,styles,emit,anim/*}.mjs
  audio/{envelope,duck,fades,join}.mjs   (generator used by Node sidecar writer AND AudioWorklet)
  plan/{plan,bands,sidecars,hash}.mjs
  commands/*.mjs                      intent-level edit commands (undo + rebase), pure
  analysis/fillers.mjs                lexicon filler/silence detection (instant, deterministic)
  cli.mjs                             node cli.mjs {validate|plan|sidecars|seed-check} (used by Python)
web/lib/preview/              (NEW, browser engine; ~6–9k LOC incl. shaders)
web/app/projects/[id]/clips/[clipId]/edit/page.jsx  + web/lib/editor2/* (UI, timeline, transcript)
src/ai_clipper/edit_v2/       (NEW Python)
  store.py        (generalised from edit_manifest.py primitives: locks, atomic writes, archive)
  api.py          (stdin-envelope CLI like editor_api.py: get/put/seed/revisions/restore)
  seed.py         (selection.v3.json + transcript + camera plan → revision 0/1 document)
  migrate_v1.py   (clip-edit-v1.0 → clip-edit-v2)
  core_bridge.py  (runs `node /app/lib/edit-core/cli.mjs` with bounded I/O)
  compile_ffmpeg.py + ops/*.py   (RenderPlan → argv + sidecar wiring; pure, golden-tested)
  execute.py      (fd-passing, no shell, -progress liveness, scaled timeout)
  verify.py       (output contract gates G1–G5)
  camera_plan.py  (face/speaker analysis → camera.v1.json; YuNet later)
  audio_annex.py  (loudness pass-1 → annex json)
src/ai_clipper/editor_ai.py + prompts/editor_*.md   (AI suggestions; §8)
resources/fonts/ (TTF + OFL + fonts.json), resources/stylepacks/, resources/hooks/,
resources/emoji/ (Noto Emoji PNG 512, Apache-2.0), resources/lexicon/id-fillers.v1.json
```

`web/lib` is already copied to `/app/lib` in the runner image (`Dockerfile`: `COPY web/lib ./lib`).
The render worker, which runs in the same image, therefore reaches edit-core at
`/app/lib/edit-core/cli.mjs` with no packaging change.

### 2.2 Why the core is JavaScript and not Python

- Instant preview needs the resolver in the browser. Typing a caption must not wait for a server
  round trip; the current CLI bridge costs 70–90 ms [R1].
- There must be exactly one implementation (I1). The only runtime that exists on both sides is
  JavaScript. Pyodide (about 10 MB, slow start-up) is rejected.
- Text shaping has to agree too: harfbuzzjs (WASM, deterministic) produces the same advances in
  Chrome and Node. A Python `uharfbuzz` would be a second HarfBuzz build, possibly a different
  version.
- Python keeps what it does well and what is already hardened [R1 §12]:
  - the storage core (receipts, locks, archive) and the queue (leases, fencing, storage
    reservations);
  - fail-closed FFmpeg execution;
  - analysis (Whisper, audio timeline, faces, LLM);
  - the plan→argv compiler, which is next to the execution code and tested on strings.

### 2.3 Flows

| Flow | Path |
|---|---|
| Edit | UI command → edit-core `apply` (Immer patches for undo) → local re-resolve (≤ 16 ms budget for a 90 s clip) → engine uploads the changed plan parts → autosave `PUT` with `If-Match` plus `X-Plan-Sha256` |
| Preview | The engine reads the plan: frame n → segment → source-grid frame → proxy frame by index → WebGL2 ops → libass bitmaps (`nowMs(n)`) → canvas. Audio: AudioContext(48 kHz) → per-segment buffers → envelope worklet → mix |
| Truth frame | Paused 250 ms → `POST …/preview-frame {plan_sha256, n, scale}` → Node route re-plans (or uses the cached plan) → Python compile in `frame` mode → FFmpeg → PNG with colour chunks stripped → sentinel SSIM |
| Final render | `POST …/renders {etag}` → queue → worker runs `node cli.mjs plan` (writes `plan.json`, `captions.ass`, `*.cmd`, `*.f32`) → `compile_ffmpeg` → FFmpeg → `verify.py` gates → publish `output/edits/<clip_id>/<render_key16>.mp4` |
| Auto render (V3 pipeline) | `pipeline.py` → `seed.py` builds revision 0 in memory → the same worker path, synchronously. `render_vertical()` becomes a thin wrapper (Stage 0c) |

---

## 3. The document: `clip-edit-v2`

### 3.1 Conventions

| Suffix / form | Unit | Example |
|---|---|---|
| `_f` | Output frame index at `output.fps` | `start_f: 90` |
| `_sf` | Source-grid frame: frame of `fps=output.fps` applied to the source from t = 0 (D3) | `in_sf: 18321` |
| `_ms` | Milliseconds on the source clock (transcript words are 3-decimal seconds, so exact) | `start_ms: 610734` |
| `_smp` | Sample at 48 kHz | `src_in_smp: 0` |
| `_e5` | Fraction × 100,000 of a reference length (canvas W or H; source W or H for crops) | `x_e5: 50000` is the centre |
| `_pm` | Per-mille (opacity, intensity, scale; 1000 means 100%) | `scale_pm: 1150` |
| `_cdb` | Centi-decibels | `gain_cdb: -1800` is −18 dB |
| `_cdeg` | Centi-degrees | `rotation_cdeg: -300` |
| colours | `"#RRGGBB"` or `"#RRGGBBAA"`, uppercase | `"#FFE14D"` |
| fps | `[num, den]` | `[30000, 1001]` |
| ids | Items `it_` + 10 base32 chars (client-generated, collision-checked). Words `w` + 6 digits (transcript order). Assets `sha256:<64 hex>`. Emoji `emoji:<codepoint[-codepoint]>` | |

Text rules (kept from V1):
- NFC only, with no Cc/Cs characters;
- at most 90 characters for the hook and 300 per text item;
- a document is at most 4 MiB and must be canonical (sorted keys, no whitespace);
- unknown keys are rejected at every level; `schema_minor` gates which keys exist.

### 3.2 Complete example (abbreviated)

```json
{
  "schema": "clip-edit-v2", "schema_minor": 0,
  "clip_id": "clip_5c0e…64hex",
  "revision": 12, "parent_revision_sha256": "a41b…64hex",
  "provenance": {
    "job_id": "j_20260924_…", "seeded_from": "selection-v3", "core_version_at_seed": "1.0.0",
    "source_content_sha256": "3b1f…", "selection": {"artifact_sha256": "…", "selection_version": "selection-v3.0",
      "rank_at_seed": 2, "prompt_version": "llm-select-v1", "selection_source": "llm"},
    "transcript_sha256": "…", "words_sha256": "…", "audio_timeline_sha256": "…",
    "sound_events_sha256": "…", "camera_plan_sha256": "…"
  },
  "output": {"w": 1080, "h": 1920, "fps": [30, 1], "sample_rate": 48000, "channels": 2,
             "composite": "yuv444p", "color": "bt709-tv"},
  "sources": {
    "S": {"content_sha256": "3b1f…", "grid": [30, 1],
          "probe": {"w": 1920, "h": 1080, "native_fps": [30000, 1001], "vfr": false, "duration_ms": 3901120,
                    "has_audio": true, "audio_sr": 44100, "start_pts_ms": 0},
          "color": {"matrix": "bt709", "range": "tv", "decided_by": "probe"}}
  },
  "assets": {
    "sha256:9d2e…": {"kind": "image", "mime": "image/png", "w": 512, "h": 512},
    "sha256:77aa…": {"kind": "audio", "mime": "audio/mp4", "duration_ms": 94000,
                     "license": {"id": "potongin-lib-0042", "attribution": "…"}}
  },
  "main": {
    "items": [
      {"id": "it_co00000001", "kind": "range", "role": "cold_open", "src": "S", "in_sf": 18321, "out_sf": 18477},
      {"id": "it_bd00000001", "kind": "range", "role": "body", "src": "S", "in_sf": 17610, "out_sf": 18090,
       "join": {"kind": "transition", "type": "fadewhite", "dur_f": 3}},
      {"id": "it_bd00000002", "kind": "range", "role": "body", "src": "S", "in_sf": 18132, "out_sf": 19410,
       "join": {"kind": "cut"}}
    ],
    "intro_hold": {"dur_f": 0, "audio": "silence"},
    "excisions": [
      {"id": "ex_0001", "between": ["it_bd00000001", "it_bd00000002"], "in_sf": 18090, "out_sf": 18132,
       "words": ["w004521", "w004522"], "reason": "filler", "origin": "lexicon:id-fillers.v1"}
    ],
    "join_fade_smp": 384
  },
  "layout": {
    "default": {"mode": "camera", "no_face": "fail"},
    "overrides": [{"from_sf": 18800, "to_sf": 19100, "mode": "split",
                   "params": {"top": "A", "bottom": "B", "divider": {"h_e5": 0}}}],
    "camera": {"plan_sha256": "…", "manual_keys": [], "seat_force": [{"from_sf": 18500, "to_sf": 18620, "seat": "B"}]},
    "fit_blur": {"plate": "plate-v1"}
  },
  "captions": {
    "enabled": true,
    "pack": {"id": "kuning-pop", "v": 3, "sha256": "…"},
    "overrides": {"y_e5": 64000, "case": "upper"},
    "chunking": {"max_words": 3, "max_gap_ms": 600, "min_display_ms": 300, "break_on_sentence": true},
    "offset_ms": 0,
    "word_edits": {"w004533": {"text": "anjay"}, "w004540": {"emphasis": 1}, "w004541": {"hidden": 1},
                   "w004550": {"emoji_after": "emoji:1F602"}},
    "inserted": [],
    "breaks": {"cue_before": ["w004545"], "join_after": [], "line_before": []}
  },
  "hook": {
    "id": "it_hk00000001", "text": "Copet ini ngaku: dompet paling gampang diambil di KRL jam 6 sore",
    "design": {"id": "bar", "v": 1, "sha256": "…"}, "start_f": 0, "end_f": 120,
    "anchor": {"x_e5": 50000, "y_e5": 13000}, "max_w_e5": 88000, "labels": [], "emphasis_words": [3, 4],
    "origin": {"kind": "selection-v3"}
  },
  "tracks": [
    {"id": "tr_v2", "kind": "visual", "band": "under_text", "hidden": false, "locked": false, "items": [
      {"id": "it_br00000001", "kind": "media", "asset": "sha256:9d2e…", "start_f": 90, "dur_f": 75,
       "mode": "pip", "rect": {"x_e5": 57000, "y_e5": 9000, "w_e5": 36000, "h_e5": 20250}, "fit": "cover",
       "radius_e5": 1500, "border": {"w_e5": 250, "color": "#FFFFFF"}, "opacity_pm": 1000,
       "fade_in_f": 5, "fade_out_f": 5,
       "kf": {"scale_pm": [{"f": 0, "v": 800, "ease": "out"}, {"f": 6, "v": 1000, "ease": "hold"}]}}
    ]},
    {"id": "tr_t1", "kind": "text", "band": "text", "items": [
      {"id": "it_tx00000001", "kind": "text", "text": "POV: kamu naik KRL jam 6", "style": {"id": "tiktok-box", "v": 1},
       "start_f": 0, "dur_f": 90, "anchor": {"x_e5": 50000, "y_e5": 24000}, "max_w_e5": 80000,
       "rotation_cdeg": 0, "anim": {"in": "pop", "out": "fade"}}
    ]},
    {"id": "tr_o1", "kind": "visual", "band": "over_text", "items": [
      {"id": "it_lg00000001", "kind": "logo", "asset": "sha256:…", "corner": "top_right", "w_e5": 14000, "opacity_pm": 850},
      {"id": "it_cr00000001", "kind": "credit", "text": "Source YT : @podkesmas", "style": {"id": "credit-small", "v": 1}}
    ]}
  ],
  "audio": {
    "source": {"gain_cdb": 0, "mute": []},
    "tracks": [{"id": "tr_a2", "kind": "music", "items": [
      {"id": "it_mu00000001", "asset": "sha256:77aa…", "start_f": 0, "dur_f": 1911, "src_in_smp": 0, "loop": true,
       "gain_cdb": -1800, "fade_in_f": 15, "fade_out_f": 30,
       "duck": {"on": true, "depth_cdb": 1000, "attack_ms": 30, "release_ms": 400, "hold_ms": 150, "detector": "words"}}
    ]}],
    "master": {"loudness": {"mode": "normalize", "target_clufs": -1400, "tp_cdb": -100}}
  },
  "effects": [],
  "markers": [{"id": "mk_1", "f": 300, "label": "cek ini"}],
  "publish": {"title": "…", "description": "…", "hashtags": ["podcast", "krl"], "cover_f": 12},
  "export": {"preset": "tiktok-1080", "crf": 20, "srt": true},
  "audit": {"created_at_ms": 1790000000000, "updated_at_ms": 1790000123456, "editor": "potongin-editor/2.0.0"}
}
```

### 3.3 Block semantics

**`sources` and `assets`**
- There is exactly one primary source `S` in Stage 1; more are possible later for multi-camera.
- `grid` must equal `output.fps`. `probe` and `color` are fixed at seed time from ffprobe. The
  colour matrix is decided once, from the probe, or `bt709` if height ≥ 720 and `bt601`
  otherwise. It is used identically by the final graph and the proxy builder.
  - Note: swscale's default for untagged video is BT.601, and I9 makes this explicit.
- HDR (PQ/HLG) sources are refused in the editor with the message "sumber HDR belum didukung"
  (G-FAIL).
- `assets` is a snapshot of immutable asset metadata, copied from the asset store at insertion.
  edit-core needs the dimensions and durations to lay out without I/O.

**`main` (V1, magnetic)**
- An ordered list of `range` items (`role` is `cold_open` or `body`). `cold_open` items must
  come first, 0.5–8.0 s in total (the V3 rule, `render.py`), with `|in − body.in| ≥ 1 frame`.
- **Output duration** is `Σ(out_sf − in_sf) − Σ transition.dur_f + intro_hold.dur_f`.
- `join` on item *i* describes the join from item *i−1*:
  - `cut` (the default) means video hard cut, audio micro-fade over `join_fade_smp` (384 = 8 ms)
    on each side with **no overlap**, so there is no drift [R2];
  - `transition` means an xfade of `dur_f` frames. It consumes frames from both sides, so the
    total duration shrinks by `dur_f`, and audio uses an equal-power crossfade over the same
    samples.
- `intro_hold` freezes output frame 0 for `dur_f` frames, with audio as silence or a clone
  (LokaClip `tpad start_mode=clone` [R2]).
- `excisions` are **restorable cuts** (Descript "delete but recoverable"): the source span removed
  between two adjacent body ranges, with the transcript words it held.
  - Restoring one merges the two ranges.
  - Excisions are how transcript deletes, filler removal and gap shortening are stored: the
    intent is the words, the materialisation is the frames.

**`layout` (source-anchored)**
- Modes:
  - `camera`: face-track or smart-speaker 9:16 crop following the camera plan;
  - `fill_center`, `fit_blur`, `fit_black`;
  - `split`: two seats stacked (`vstack` of two crops [R2]);
  - `branded`: header and footer bands with the 16:9 video in the middle.
- Overrides are stored in **source-grid frames**, not output frames, so they travel with the
  content through ripple edits. The UI projects them through the time map onto a "Layout" lane.
- `no_face`:
  - `fail` refuses to export a camera segment without a face (G-FAIL, LokaClip v1.10.4
    practice);
  - `fit_blur` falls back explicitly, and the plan records the fallback, so the UI shows a badge.
- `camera.manual_keys` are `{sf, cx_e5, cy_e5, w_e5, ease}`. Inside the span between the first
  and last manual key they replace the plan; there is a 10-frame eased blend at the span edges.
- `seat_force` pins a seat (speaker chip "Pembicara A/B").

**`camera.v1.json` (analysis artifact, referenced by sha256)**

This is LokaClip's `crop-trajectory.json` concept [R2] in our units:

```json
{"schema": "camera-plan-v1", "source_sha256": "…", "grid": [30, 1], "analyzer": "haar-v0|yunet-asd-v1",
 "sample_every_sf": 6,
 "seats": [{"id": "A", "median_cx_e5": 31000}, {"id": "B", "median_cx_e5": 69000}],
 "shots": [{"from_sf": 17600, "to_sf": 18480, "kind": "single", "seat": "A"}],
 "keys": [{"sf": 17610, "cx_e5": 30500, "cy_e5": 42000, "seat": "A", "conf_pm": 930}],
 "cuts_sf": [18420]}
```

- All smoothing (the current EMA, dead zone and hysteresis in `face_tracking.smooth_face_track`)
  happens **once, at analysis**. edit-core only interpolates between keys (linear, held across
  `cuts_sf`), which keeps the plan simple and identical on both sides.
- Stage 0 fills it from the existing Haar detector, 0.75 s sampling converted to keys. Stage 1c
  upgrades it to OpenCV `FaceDetectorYN` (YuNet, OpenCV Zoo, MIT) at 5 Hz, plus mouth-motion ASD
  and VAD [R2 M11].

**`captions`**
- Words come from `transcript.json` (`TranscriptWord`), addressed as `w` + index. Edits live in
  `word_edits`:
  - `text` (display text; ASR text stays in the transcript);
  - `hidden`, `emphasis`, `emoji_after`;
  - `start_ms`/`end_ms` retime.
- `inserted` holds user words with explicit times. `breaks` holds forced cue and line breaks and
  joins.
- The pack is pinned by `{id, v, sha256}`. `overrides` is a whitelisted subset of pack fields
  (§3.5).
- Chunking follows today's `subtitles.build_caption_cues` semantics: ≤ `max_words`, break on
  gaps > `max_gap_ms` and on sentence ends, minimum display 300 ms, never across a
  cold-open→body join or a transition. It is re-implemented in edit-core, with the Python
  function's tests converted to vectors.

**`hook`**
- Text ≤ 90 characters (`MAX_HOOK_TEXT_CHARS`). The design is pinned by `{id, v, sha256}`.
- `start_f`/`end_f` default to `0..min(4 s, duration)`. `"persist": true` means the whole clip
  (the KlipAja "Sepanjang klip" option).
- `labels` holds sticker-design category pills. `emphasis_words` are word indices into the hook
  text.

**`tracks` (overlays)**
- `band` is one of `under_text`, `text` or `over_text`. The compositing order is:
  video (main) → `under_text` tracks (in order) → captions, hook and text items (one ASS pass,
  libass layers) → `over_text` tracks.
  - Arbitrary interleaving between ASS and images is deferred. The engine design (D6) allows it
    later with several ASS passes.
- Item kinds and their fields:

  | Kind | Fields |
  |---|---|
  | `media` | image or video asset; `mode` is `pip`, `cutaway` or `split_top`/`split_bottom`; `rect`; `fit`; `radius_e5`; `border`; `opacity_pm`; fades; `src_in_f` for video; `audio {gain_cdb, mute}` for video; optional `kenburns {from_rect, to_rect}` for images (Stage 2) |
  | `text` | `text`, `style` (text preset), `anchor`, `max_w_e5`, `rotation_cdeg`, `scale_pm`, `anim {in, out}` |
  | `sticker` | asset or emoji, `anchor`, `w_e5`, `rotation_cdeg`, `opacity_pm` |
  | `label` | pill text plus fill colour, rendered as an ASS vector shape and text |
  | `logo` | corner preset or anchor, `w_e5`, `opacity_pm`, whole clip |
  | `credit` | "Source YT : {channel}" auto-fill (§7), a text style |

- `kf` (keyframes) on any item: a map from property to a sorted list `{f (relative to item
  start), v (integer in the property's unit), ease}`.
  - Properties: `x_e5`, `y_e5`, `scale_pm`, `rotation_cdeg`, `opacity_pm`, and for `media` also
    `crop_*_e5`.
  - Eases: `hold`, `linear`, `in`, `out`, `in_out` (cubic), and `bezier:[x1,y1,x2,y2]` in e5.

**`audio`**
- `source` covers A1, the main track's audio: `gain_cdb`, plus `mute` spans in output frames.
  Stage 2 adds `cleanup {denoise, voice_eq}`.
- `tracks` holds `music` and `sfx` items: asset, `start_f`/`dur_f`, `src_in_smp`, `loop`,
  `gain_cdb`, fades, and `duck` (music only).
  - `duck.detector` is `words` (speech intervals from the output-timeline words, merged across
    gaps < `hold_ms`) or `rms` (the audio timeline above its silence floor).
- `master.loudness` is `normalize` (two-pass constant gain plus a peak envelope, §4.6) or `off`.

**`effects`** (Stage 2) are adjustment items over output time applied to the video band before
text: `eq`, `lut` (a `.cube` asset), `vignette`, and `punch_in` (static zoom per span; animated
zoom only after the zoompan spike, §6.3).

**`publish`**, **`export`** and **`markers`** are editorial data. They do not affect the plan,
except `export` (resolution, fps choice, crf) and `cover_f` for the cover frame.

### 3.4 Semantic validation (edit-core, also run by the server)

| Rule | Error code (Indonesian message in the UI) |
|---|---|
| ≥ 1 body range. Each range ≥ 2 frames (shorter ranges are merged by the command layer). Ranges lie inside `[0, source_frames)` | `range_invalid` |
| Output duration is 3 s to 600 s. More than 180 s shows a warning (render time) | `duration_out_of_bounds` |
| Cold open is 0.5–8 s and comes first | `cold_open_invalid` |
| `transition.dur_f ≤ ⌊min(len A, len B)/2⌋`; type is in the enabled op catalog | `transition_invalid` / `op_disabled` |
| Items on one track do not overlap; keyframes are sorted and inside the item | `overlap` / `kf_invalid` |
| Every text glyph is covered by the pinned font's cmap. Emoji are allowed only as tokens | `glyph_unsupported:<U+XXXX>` (never a silent fallback) |
| Text, stickers and hook stay inside the platform safe zone (TikTok preset at 1080×1920: top 140 px, bottom 420 px, right 140 px [R2 G-SAFE]) unless `safe_override: true` on the item | `unsafe_area` (warning; blocks export without override) |
| Asset exists in the store and its metadata matches the snapshot | `asset_missing` |
| Limits: ≤ 200 main ranges, ≤ 8 overlay tracks, ≤ 64 items per track, ≤ 2,000 keyframes, ≤ 5,000 ASS events, document ≤ 4 MiB | `too_large` |

### 3.5 Style packs, hook designs, text presets and templates

These are versioned resources, pinned by hash in documents, so old clips never change look
(LokaClip v2.0.6 lesson [R2]).

```
resources/stylepacks/kuning-pop/v3.json   (schema potongin.stylepack.v2; fields = R2 §7.2 in our integer units)
resources/hooks/bar/v1.json               (hook design: box/shape geometry as ASS vector templates + text style)
resources/text-presets/tiktok-box/v1.json
resources/templates/podcast/v2.json       (refs to pack/design/layout/logo/music/export defaults)
resources/fonts/fonts.json + *.ttf + OFL-*.txt
```

`fonts.json` carries the metrics edit-core needs and CI verifies against libass:

```json
{"pack": "potongin-fonts-2026.09", "fonts": [
  {"family": "Montserrat", "style": "Black", "weight": 900, "file": "Montserrat-Black.ttf", "sha256": "…",
   "license": "OFL-1.1", "license_file": "OFL-Montserrat.txt", "upem": 1000,
   "libass_height_units": 1219, "cap_height_units": 700, "x_height_units": 525}]}
```

- `libass_height_units` is the font-unit height that libass maps to `Fontsize` (the FreeType
  REAL_DIM request). It is calibrated by rendering, not assumed; DejaVu Sans is 1.164 em [R1].
- Stage 1 fonts, all OFL-1.1:
  - DejaVu Sans / Bold (for the legacy packs);
  - Montserrat Black / ExtraBold;
  - Poppins Bold / Black;
  - Anton;
  - Plus Jakarta Sans Bold;
  - Courier Prime Bold;
  - Lilita One;
  - Bangers.
- Never bundle "The Bold Font" or Komika Axis [R2].
- Built-in legacy resources reproduce today's auto-render look exactly: `legacy-classic@1`,
  `legacy-karaoke@1` and `legacy-bar@1` (the constants in `captions_ass.py`: font 12/288 H,
  outline 1/150 H, margin 17% from the bottom, karaoke #FFE14D bold, hook box α 0x59, 13% from
  the top, fades 150/250 ms).

### 3.6 Versioning and migration

- **Schema:**
  - `schema: "clip-edit-v2"` plus an integer `schema_minor`. A minor adds optional keys only.
    The server rejects a document whose minor is newer than it knows (`schema_too_new`, "muat
    ulang editor").
  - A major bump (v3) ships `normalize/migrate.mjs::v2_to_v3`. Documents migrate lazily on read
    and are written back only as a new revision on the next save. The archived originals stay
    untouched.
- **Resources:** a pack or design gets a new version as a new file, and old versions are never
  edited. `templates` pin versions. "Upgrade to v4" is an explicit, undoable command.
- **Engine semantics:**
  - `core_version` (semver) and `render_semantics` (an integer) are recorded in every plan and
    render.
  - A change that alters any pixel of the golden corpus must bump `render_semantics`, attach the
    old-vs-new heatmap report, and get owner approval ("look change").
  - Documents are not rewritten; the render cache key changes (§6.7).
- **Clip identity** (fixes R1's "no stable ID"):
  `clip_id = "clip_" + sha256("potongin-clip-v1\0" ‖ source_content_sha256 ‖ "\0" ‖ start_ms ‖ "\0" ‖ end_ms ‖ "\0" ‖ (cold_open ? co_start_ms+"-"+co_end_ms : "-"))`.
  - `selection_version` is deliberately **excluded**, so a re-run that finds the same moment
    re-attaches the edit.
  - It is written additively into `selection.v3.json` as `clips[].clip_id` (an optional field
    for `SelectedClip`, to coordinate with the V3 owners). Until then edit-core and `seed.py`
    compute it with the same formula.
- **Provenance drift:** if `transcript_sha256` or `words_sha256` changes (a re-transcription),
  the document is not orphaned (R1's `selection_changed` failure). Instead:
  - `seed.py re-anchor` maps old word ids to new ones by time overlap ≥ 50% and case-folded text
    equality, with Levenshtein ≤ 2 as the fallback;
  - frames stay as they are, because they are source-anchored;
  - unmapped `word_edits` are listed in a warning banner, and the user resolves them.
- **Seeding from V3** (`seed.py`, revision 1, created by an explicit `POST …:seed`; no GET with
  a side effect, R1):
  - `SelectedClip.start/end/cold_open` → ranges. Cuts snap to the nearest source-grid frame
    boundary inside the adjacent silence (`audio_timeline.nearest_quiet_point`, ±40 ms).
    Otherwise they round to the nearest frame.
  - The job's `renderMode` maps to a layout: `face-track` → `camera` (a camera plan is
    persisted), `fit-blur` → `fit_blur`, `center-crop` → `fill_center`.
  - `captionStyle` karaoke/classic maps to `legacy-karaoke@1` / `legacy-classic@1`.
  - `hook_text` → hook with `legacy-bar@1`, 0–4 s.
  - `title`/`description`/`hashtags` → `publish`.
  - Output: job width × height (1080×1920 by default) and native fps (D12).
- **Migration from `clip-edit-v1.0`** (V2 candidates; `migrate_v1.py`). This is optional,
  because only `v2-shadow` jobs have these.

  | V1 field | V2 target |
  |---|---|
  | `timeline` | one body range |
  | `visual.render_mode` fit-blur | `fit_blur` |
  | `visual.render_mode` center-crop with `focal_x` | a `fill_center` override with manual key `cx = focal_x`. The V1 render formula `x = clip(iw·f − ow/2)` becomes even-aligned |
  | `caption_style` | the nearest legacy pack. Cue text becomes `inserted` words with times spread proportionally, and the doc is flagged `timing: segment` |
  | `overlays.title` | a text item (`legacy-title@1`: DejaVu Bold 52/1280, outline 3) |
  | `overlays.logo` | a logo item, once the asset is imported into the store |
  | `audio.gain_db` | `source.gain_cdb` |
  | `audio.normalize` | `master.loudness` |

  Provenance is `seeded_from: "clip-edit-v1.0@r<N>"`. V1 files stay readable for renders
  already queued.

---

## 4. edit-core: document → RenderPlan

### 4.1 Time model

- Grid `F = num/den`. The output frame `n` has time `n·den/num` s.
- `smp(n) = ⌊n·48000·den / num⌋`, integer arithmetic; all products stay below 2^53 for up to
  10 h at 60 fps.
- **Time map.** Main items become segments `{i, src, in_sf, out_sf, out_f0, frames}`, with
  transitions overlapping.
  - Output frame `n` in segment `i` maps to source-grid frame `in_sf + (n − out_f0)`.
  - Output audio sample `s` maps to source sample `smp_src(in_sf) + (s − smp(out_f0))`.
    Each segment's sample count is `smp(out_f0 + frames) − smp(out_f0)`, anchored on the output
    grid, so concatenation accumulates **zero** rounding drift.
- **Words to output frames.** A word belongs to a segment when its midpoint is inside it (today's
  rule). Its output time is `out_ms = (word_ms − src_ms(in_sf)) + out_ms(out_f0)`, in exact
  rational milliseconds.
  - Onset frame: `n_on = ⌊(2·out_ms·num + 1000·den) / (2000·den)⌋`, nearest frame, half up.
  - Words inside excisions or hidden are dropped from captions. Their audio is excised only when
    they sit inside an excision.
- **Snapping** (used by commands, not by resolve):
  - a trim or excision edge first aims at the ideal time: the silence midpoint if the gap is
    > 80 ms, otherwise `word.end + 40 ms` / `word.start − 40 ms` [R2 M1];
  - it then picks the frame boundary inside the gap closest to that ideal;
  - if the gap is shorter than one frame, it picks the boundary with the least word overlap and
    marks the edge `tight`, which shows a UI warning and a listening prompt.

### 4.2 Frame-safe text timing

```
nowMs(n)  = Math.trunc(n * (den / num) * 1000)        // byte-for-byte FFmpeg vf_subtitles arithmetic
safeCs(n) = Math.floor((nowMs(n) - 2) / 10)            // event boundary for "visible from frame n"
```

- An event visible on output frames `[a, b)` is written `Start = safeCs(a)`, `End = safeCs(b)`.
- A karaoke word switching on at frame `k` gets `\k` durations computed as differences of
  `safeCs`, so libass switches the highlight exactly at frame `k` on both sides.
- `\t(t1,t2,…)` and `\fad` times are relative ms, and both sides evaluate them at the same
  `nowMs(n)`.
- The browser gives JASSUB's WASM `rawRender(nowMs(n) / 1000)`. JASSUB rounds to the nearest ms,
  which returns exactly `nowMs(n)`. [PF] verified the rounding. CI test P-TIME checks every event
  boundary of the corpus, including all hazard frames.

### 4.3 Text layout (the only place text is measured)

1. **Resolve style.** Take the pack, apply the whitelisted overrides, and compute the font size.
   `size_cap_e5` fixes the cap height, so `Fontsize = cap_px · libass_height_units /
   cap_height_units`, which is the libass REAL_DIM semantics.
2. **Case.** Apply `toUpperCase()`, which is locale-independent. `display_text` is never mutated;
   case is a style property [R2 M5].
3. **Shape** every token with harfbuzzjs (same TTF bytes). Keep the advance in 26.6 fixed point
   and the ink bbox. Emoji tokens get a square advance of `1.10 em`.
4. **Wrap** greedily by advance within `max_w`, honouring forced line breaks. For each overflow
   step:
   - (a) shrink the font by 4% down to `min_scale_pm` (850);
   - (b) captions only: split the chunk (fewer words per cue);
   - (c) hooks only: ellipsize at a word boundary, exactly as `shorten_hook_text` does.
5. **Position.** Lines stack at `line_height_em` around `anchor`. Every word gets an integer box
   `{x, y_top, w, h}` (round half up). Line boxes are the union.
6. **Emit.** Words that animate individually (pop, bump, slam, word box) get one Dialogue each,
   with `\an5\pos(cx,cy)`. That stops neighbours reflowing, which moved them 56 px [R2].
   Otherwise there is one Dialogue per line with `\an7\pos(x,y)\q2`. libass never wraps
   (`WrapStyle: 2`).
7. **Safe-zone check** on the union bbox of all frames. It produces `unsafe_area`.

Calibration test (CI):
- For each font in `fonts.json`, render the glyph set `A–Z a–z 0–9 .,!?` with FFmpeg `ass` at 3
  sizes.
- Check the ink bbox against the harfbuzzjs prediction: ±1 px at 1080×1920.
- Any drift in `libass_height_units` fails the build.

### 4.4 ASS emission rules

- **Header:** `ScriptType: v4.00+`, `PlayResX/Y` = output, `WrapStyle: 2`,
  `ScaledBorderAndShadow: yes`, `YCbCr Matrix: None` (avoids JASSUB colour mangling [R3]),
  `Kerning: yes`.
- **Escaping:** a port of `captions_ass.ass_escape`: a word joiner after `\`, `\{` `\}`,
  line-breaking characters turned into spaces, Cc/Cs dropped. The client never sends ASS, and
  the server regenerates it from the document [R3].
- **Layers:**
  - 0: highlight boxes (`\p1` rectangles with rounded corners via `b` curves);
  - 1: caption text;
  - 2: text items;
  - 3: hook backdrops;
  - 4: hook text.

  The event order in the file is `(layer, start, id)`, which is deterministic.
- **Box opacity** goes into `OutlineColour`/`BackColour` alpha. This fixes the V1 bug where the
  box was always opaque [R1 D1].
- **Animation templates** live in `ass/anim/*.mjs` and take integer parameters from the pack:
  - pop `\fscx70\fscy70\t(0,90,1.4,\fscx108\fscy108)\t(90,170,\fscx100\fscy100)`;
  - glow `\blur6\t(0,160,\blur0)`;
  - fade `\fad(120,0)`;
  - box slide by `\clip` animation;
  - `\kf` sweep for `karaoke_sweep`.

  All of these are LokaClip's own curves [R2].
- Gradient backdrops and rough-edge stickers, which libass cannot draw, become **server-baked
  PNG assets** produced by a deterministic generator in edit-core (a PNG encoder in JS with a
  fixed zlib level). Both sides consume the same bytes. There is no `geq`/`gradients` in the
  graph.

### 4.5 Keyframes and deterministic math

- Sampling happens at every output frame of the item: `v(n) = interp(kf, n − start_f, ease)`,
  then quantised to the unit the backend consumes:
  - px: integer, round half up;
  - alpha: `round(v·255/1000)`;
  - angle: centi-degrees.
- `detmath.mjs` implements `pow`, `exp`, `log`, `sin`, `cos` and cubic-Bézier solving (fixed 24
  bisection steps) using only IEEE-754 `+ − × ÷ √`. Those are correctly rounded and therefore
  identical in V8, SpiderMonkey and JavaScriptCore. `Math.pow`, `Math.sin` and similar are
  **banned** in edit-core by lint rule: their last-ULP results differ between engines, and a
  single flipped rounding changes the plan hash.
- dB to linear goes through `detmath.exp10`. The envelope generator uses the same function in
  Node and in the AudioWorklet.

### 4.6 Audio envelopes

For each audio source in the mix, edit-core defines `gain(s)` for output sample `s` as a product
of pieces, each linear-in-gain between breakpoints:
- join micro-fades (8 ms);
- mutes and excision edges;
- item fades;
- `gain_cdb`;
- duck (a speech mask, ramped over attack/release in dB, then converted);
- the master constant gain and a limiter envelope.

It emits:
- **Server:** a `f32le` mono file per mixed source (`env_src.f32`, `env_m1.f32`), streamed to
  FFmpeg through a pipe for long clips.
- **Browser:** an `EnvelopeProcessor` AudioWorklet that calls `envelope.fill(buffer, s0)` per
  128-sample quantum. It is the same function, so the float32 values are identical.

**Loudness (two-pass, deterministic).**
1. **Annex.** After a debounced edit that changes the audio plan (`audio_mix_sha256`), the
   preview worker runs an audio-only render of the pre-master mix (about 50× realtime) with
   `ebur128=peak=true`. It stores `{i_clufs, tp_cdb}` in `annex/<audio_mix_sha256>.json`.
2. **Gain.** `g = target − measured`, capped by `tp_target − (tp + g)`.
3. **Peaks.** If the cap stops `g` from reaching the target by more than 1 LU, a look-ahead peak
   limiter (5 ms attack, 50 ms release, computed offline over the mix samples in Node) produces a
   **gain-reduction envelope**. It is just another envelope, identical on both sides.
   `sidechaincompress` and `loudnorm` in dynamic mode are banned (R3, R1 D4).
4. **Preview.** Until the annex exists, the preview shows the badge "level akhir sedang
   dihitung" and plays at unity master gain.

### 4.7 RenderPlan (`render-plan-v1`, integers only; abbreviated)

```json
{"plan": "render-plan-v1", "core_version": "1.0.0", "render_semantics": 1, "doc_sha256": "…",
 "output": {"w": 1080, "h": 1920, "fps": [30, 1], "frames": 1911, "sample_rate": 48000, "samples": 3057600,
            "composite": "yuv444p"},
 "segments": [
   {"i": 0, "src": "S", "in_sf": 18321, "out_sf": 18477, "out_f0": 0, "frames": 156,
    "video": {"mode": "camera", "crop": {"w": 608, "h": 1080}, "crop_xy_cmd": "cam_0.cmd",
              "scale": {"w": 1080, "h": 1920, "filter": "bicubic"}}},
   {"i": 1, "src": "S", "in_sf": 17610, "out_sf": 18090, "out_f0": 153, "frames": 480,
    "video": {"mode": "fit_blur", "plate": "plate-v1", "fg": {"x": 0, "y": 656, "w": 1080, "h": 608}}}],
 "transitions": [{"between": [0, 1], "type": "fadewhite", "frames": 3, "at_f": 153}],
 "layers": [
   {"id": "it_br00000001", "band": "under_text", "kind": "image", "asset": "sha256:9d2e…",
    "enable": [90, 165], "box": {"x": 616, "y": 173, "w": 389, "h": 389}, "cmd": "ly_it_br00000001.cmd",
    "mask": "mask_r1500_389.png", "fade": [5, 5]}],
 "text": {"ass": "captions.ass", "ass_sha256": "…", "events": 812,
          "fonts": [{"file": "Montserrat-Black.ttf", "sha256": "…"}]},
 "audio": {"segments": [{"i": 0, "src_smp0": 29313600, "smp": 249600}],
           "envelopes": {"src": {"sha256": "…"}, "it_mu00000001": {"sha256": "…"}},
           "music": [{"id": "it_mu00000001", "asset": "sha256:77aa…", "out_smp0": 0, "smp": 3057600, "loop": true}],
           "master": {"annex": "sha256-of-audio-mix", "gain_cdb": -230, "limiter": null}},
 "warnings": ["tight_cut:it_bd00000002:in"],
 "plan_sha256": "…"}
```

`plan_sha256` is SHA-256 over the canonical plan without that field. It includes the sidecar
hashes (ASS bytes, cmd files, envelope data hashes), so every byte either backend consumes is
covered.

### 4.8 Determinism rules for edit-core (enforced by lint and tests)

- No `Math.round` (use `roundHalfUp`), no `Math.pow`/`sin`/`cos`/`exp`/`log`, no `toFixed` in
  logic, no `Intl` or `localeCompare`, no `Date` in resolve, and no iteration over object keys
  without sorting.
- Sort comparators are explicit and total (tie-break by id).
- **P-XENG test:**
  - The fixture corpus (40 documents) is planned in Node 20, Chrome 147, Firefox and WebKit
    (Playwright). All `plan_sha256` values must be equal. This runs on every PR.
  - A second job runs Node 22 in preparation for the LTS upgrade.

---

## 5. Browser preview engine

### 5.1 Threads and components

```
Main thread (React 19 / Next 16 UI):
  zustand 5.0.15 store; Immer 11.1.18 patches; commands; timeline DOM; transcript; inspector;
  gizmos (DOM handles over the canvas); edit-core resolve (≤16 ms for a 90 s clip; moved to a
  worker if the budget is exceeded)
Engine worker (OffscreenCanvas, WebGL2):
  Mediabunny 1.59.1 (MPL-2.0) Input/UrlSource/VideoSampleSink per media, decoder pool, frame cache
  libass: JASSUB 2.5.16 WASM driven directly (forked MIT worker glue, WASM unmodified)
  compositor: op shaders (§5.5), bands, upload of ASS_Image bitmaps into an R8 atlas
  presenter: draws frame n when AudioContext time crosses nowMs(n); rVFC-free (no <video>)
Audio: AudioContext({sampleRate: 48000}); AudioBufferSink per segment/asset; EnvelopeProcessor
  worklet per source; GainNode-free mixing (all gain is envelope); master clock = currentTime
Sentinel: truth-frame fetch + SSIM (ssim.js 3.5.0 MIT) on pause
```

### 5.2 Preview media (server-prepared, D3 grid)

| Artifact | Spec | Cost |
|---|---|---|
| Scrub proxy `analysis/media/scrub.mp4` | Whole source, `fps=F` from t=0, 640×360, crf 30, `-g F/2 -bf 0 -sc_threshold 0`, `setsar=1`, BT.709 tags, AAC 96k 48 kHz stereo | 2.5–6 min CPU per source hour at nice 10 [R3]; about 120 MB/h |
| Window proxy `analysis/clips/<clip_id>/media/w-<a0>-<b0>.mp4` | Grid frames `[in−60 s, out+60 s]`: `-ss (a0/F−1) -copyts -i SRC -vf fps=F,trim=start_pts=a0:end_pts=b0,setpts=PTS-STARTPTS,scale=-2:'min(720,ih)':flags=bicubic:in_color_matrix=<S.color>,setsar=1`, crf 24, `-g F/2 -bf 0`, AAC 128k via explicit `pan` | 5–8 s per candidate [R3]; about 20 MB |
| Index `w-….json` | `{a0, b0, grid, frames, width, height, sha256}` | none |
| Peaks `analysis/media/peaks.bin` | int8 min/max at 100/s plus 25/s and 5/s levels, BBC audiowaveform `.dat` v2 header, computed in the `audio_timeline.py` decode pass | about 0 extra |
| Filmstrip | Per window: 1 fps at 160 px WebP sprites. Whole source: keyframe sprite | 0.3–1.5 s [R3] |

- Proxies are created for the top-N V3 clips after selection (N = 5 by default), and on first
  editor open for any other clip. That is the ≤ 8 s "preparing" state, with a progress bar.
- **Frame addressing.** The engine asks for grid frame `k`. The window proxy holds `k' = k − a0`
  and has exact pts `k'/F`, so the engine requests `getSample((k' + 0.5)/F)`, which returns
  frame `k'`.
  - Timestamp floats never decide which frame is shown.
  - P-FRAME checks this with barcode sources end to end (§9).

### 5.3 Clock and scheduling

- **Playing:**
  - `n = ⌊(ctx.currentTime − t0_ctx)·num/den⌋ + n0`, computed in the presenter each rAF of the
    worker (`requestAnimationFrame` exists in dedicated workers with OffscreenCanvas).
  - A frame is drawn only when all its layers are ready. If one misses the deadline, the
    presenter **drops** the frame (it never draws partial layers) and counts it in the perf HUD.
- **Look-ahead:** decode 300 ms ahead across segment joins, and pre-roll the next segment's first
  GOP ≥ 500 ms before the join (the proxy GOP is 0.5 s, and the measured seek is p50 3.7 ms
  [R3]).
- **Paused or scrubbing:** render the frame at the playhead, then after 250 ms of stability
  request a truth frame.

### 5.4 Compositor

- **Colour (D7):**
  - `VideoFrame.copyTo()` I420 → three R8 textures;
  - a shader applies the BT.709 limited-range matrix, with chroma upsampling that matches
    swscale's bicubic chroma path within 1 level (verified by P-DEC);
  - fallback: `texImage2D(VideoFrame)` with `UNPACK_COLORSPACE_CONVERSION_WEBGL = NONE`, only if
    P-DEC passes on that path for that browser.
- **Blending:** premultiplied alpha, gamma-encoded, on an 8-bit RGBA8 framebuffer at the plan
  resolution. Output resolution is 1080×1920 when the device probe passes (§5.8). Otherwise it
  is 720×1280, with the plan re-resolved at 720 and a "Pratinjau 720p" label; truth frames are
  always at export resolution.
- **libass bitmaps (D6):** each `ASS_Image` (8-bit alpha, RGBA colour) is packed into an atlas
  and drawn as a quad with `α = mask·(255 − colorA)/255`, the same formula as FFmpeg
  `ff_blend_mask`. The text band is drawn between `under_text` and `over_text`.
- **Budgets:**
  - ≤ 8 ms GPU and ≤ 6 ms libass per frame at 1080×1920 for the heaviest Stage-1 pack (per-word
    pop, about 800 events) on the reference laptop;
  - libass renders only when `nowMs` or the plan changed.

### 5.5 Parity-safe op catalog (the contract between §5 and §6)

Each op ships as a pair: `ops/<name>.py` (FFmpeg template) and `ops/<name>.glsl.mjs` (shader plus
uniforms). Each op has golden cases and a feature flag.

| Op | FFmpeg 5.1.9 (prod) | Browser | Parity gate |
|---|---|---|---|
| `range` | Per input: `-ss (a/F−1) -copyts`; `fps=F,trim=start_pts=a:end_pts=b,setpts=PTS-STARTPTS`. Audio: `aresample=48000,pan=…,asettb=1/48000,atrim=start_pts=S:end_pts=E,asetpts=PTS-STARTPTS` | Proxy frame by index; audio sample offset | P-FRAME 0 mismatches [PF measured] |
| `crop_scale` (fill, camera) | `crop=w:h:x:y` in **source px, even-aligned**, then `scale=W:H:flags=bicubic:in_color_matrix=…:in_range=tv,format=yuv444p,setsar=1` | Normalised source rect → bicubic shader (B=0, C=0.6, footprint widened on downscale) | Region SSIM ≥ 0.995; rect exact |
| `camera` (pan) | `sendcmd=f=cam_i.cmd` → `crop@cam_i x/y` (fixed w/h) | Same per-frame integers | Rect exact [PF: sendcmd crop frame-exact] |
| `split` | `split` → 2× crop_scale (to W×H/2) → `vstack` | Two quads | As crop_scale |
| `fit_blur` plate-v1 | `scale=90:160:force_original_aspect_ratio=increase:flags=area,crop=90:160,boxblur=4:3:2:3,scale=W:H:flags=bilinear` plus the fg crop_scale | Area downscale, 3× integer box blur (port of `vf_boxblur`), bilinear upscale | Composite SSIM ≥ 0.99 (R3 prototype 0.9937) |
| `fit_black` | `pad` | Clear colour | Exact |
| `overlay` (image/video) | `format=yuva444p` or `rgba`; `overlay@id=x:y:format=yuv444:eval=frame:enable='between(n,a,b−1)'`; per-frame x/y/scale/alpha via sendcmd; masks `alphamerge` with generated PNG | Premultiplied quad; same integers; mask texture | Box exact; region SSIM ≥ 0.995 |
| `rotate` | `rotate@id=a:ow:oh:c=none:bilinear=1` + sendcmd `a` | Bilinear rotated quad | Region SSIM ≥ 0.99; bbox ±1 px |
| `text` | `ass=filename=captions.ass:fontsdir=fonts` on yuv444p | libass WASM bitmaps | P-TXT: SSIM ≥ 0.999, max ≤ 16, 0 px off by more than 16 [PF measured 0.99925 / 15] |
| `fade` | `fade=t=in:s=n0:n=k` (frame-based) or alpha envelope via sendcmd | Uniform alpha | Exact alpha per frame |
| `transition` | Island: tail(A) and head(B) trimmed → `format=gbrp` → `xfade=transition=T:duration=d:offset=0` → `format=yuv444p` → concat | GLSL port of the `vf_xfade.c` formula for T | Per type, SSIM ≥ 0.995 at 25/50/75% progress. Allowed: fade, fadeblack, fadewhite, wipe*, slide*, circleopen/close, smooth*. **No `dissolve`** (random) |
| `eq` | `eq=contrast:brightness:saturation:gamma` via sendcmd when keyframed | GLSL of the `vf_eq` formulas in YUV | Golden sweep, SSIM ≥ 0.995 |
| `lut3d` | `format=gbrp,lut3d=file=x.cube:interp=tetrahedral` | 3D texture, tetrahedral | ΔRGB ≤ 1 |
| `punch_in` (static) | Per-segment crop_scale with a smaller rect | Same | Rect exact |
| `zoom` (animated) | `zoompan` with integer rect per frame emulated in edit-core, **[SPIKE S-ZOOM]** | Rect per frame | Rect exact, or the op stays disabled |
| audio `mix` | `amultiply` (source × envelope), `amix=inputs=N:duration=first:normalize=0` | Worklet multiply and sum | P-AUD: render exact (≤ 1 LSB); preview RMS error < −40 dB |
| audio `speed`, `denoise`, `limiter-measure` | `atempo`, `afftdn`/`arnndn`, offline analysis | **Server-rendered audio span** (D10) | Same bytes |

Banned: `gblur`, `dissolve`, `sidechaincompress`, `loudnorm` dynamic mode, time-varying crop
size, CSS filters or Lottie as final pixels, `drawtext`, expression-driven animation. Each ban
has a lint rule in `compile_ffmpeg` tests or edit-core.

### 5.6 Truth frames, sentinel and server fallbacks

- **Truth frame:** `POST /api/jobs/:id/clips/:clipId/preview-frame` with
  `{plan_sha256, n, scale: 1|0.5}`. The server re-plans (cached by plan hash) and renders frame
  `n` in compile mode `frame`:
  - only the segment containing `n`, with `-ss` preroll;
  - `select=eq(n,k)`;
  - output PNG with colour chunks stripped.

  Cached LRU by `(plan_sha256, n, scale)`. Budget p95 ≤ 0.5 s at 1080×1920 (measured 0.43 s
  [R2]; 0.16–0.20 s at 720 [R3]).
- **Sentinel:** on pause, compute SSIM(live, truth) on 270×480 luma.
  - Below 0.985: show the badge "Tampilan persis" and swap in the truth frame.
  - It also sends telemetry `{op set, browser, GPU, ssim}` to `analysis/telemetry/parity.jsonl`
    (local, opt-in). This catches driver quirks in the field.
- **Server segments:**
  - For browsers without WebCodecs or WebGL2, or when an op is flagged `server_preview_only`,
    2 s fMP4 video segments are rendered on demand (0.45–0.56 s each [R3]) and played via
    hls.js 1.7.3 (Apache-2.0).
  - Audio stays client-side, or uses server audio spans (D10).
  - The UI labels this mode "Pratinjau server".

### 5.7 Editor UI architecture (parity-relevant parts)

- **Commands** (`edit-core/commands`) are pure `{name, args, precondition(doc), apply(doc)}`.
  Examples:
  - `range.trim`, `range.split`, `excise.words`, `excise.restore`, `coldopen.set`;
  - `caption.word_text`, `caption.emphasis`, `pack.apply`;
  - `hook.set_text`, `hook.set_design`;
  - `item.add`, `item.move`, `kf.set`;
  - `layout.override`, `camera.key`;
  - `music.add`, `duck.set`;
  - `template.apply` (a transaction).
- **Undo/redo** uses Immer inverse patches per command. A drag or slider session is one entry
  (same `mergeKey` within 500 ms). History holds 200 steps. Measured cost on a 600 KB document:
  trim 15 µs, cue edit 88 µs, undo 82 µs [R3].
- **Autosave:**
  - debounce 1.5 s, one PUT in flight, the full document (typically 100–600 KB);
  - the draft (document plus un-acked command log) is mirrored in IndexedDB (idb-keyval 6.3.0,
    Apache-2.0).
- **Conflict (409):**
  - fetch the head, replay the un-acked commands (intent-based, so a trim by the other tab and a
    caption edit here both survive), and PUT again;
  - failed preconditions go to a conflict sheet listing the commands that could not apply. The
    draft is never discarded, which fixes R1's "lock and reload".
- **Timeline** (custom, about 3k LOC, R3 build-not-buy):
  - lanes: Cold open, V1 main (filmstrip), Layout, V2..Vn, Text, Captions (cue blocks; word
    ticks at zoom ≥ 200 px/s), Hook, A1 waveform (peaks), A2 music (duck envelope drawn from the
    **plan**), A3 SFX, Markers (laughter from `sound_events`, silences and scene cuts from
    `audio_timeline`, AI suggestions as ghost items);
  - snap targets are word edges, silence midpoints, item edges, playhead and markers (8 px
    magnet; Alt disables).
- **Transcript panel:** words from the plan's time map. Deleted words show as `⋯ 2,4 dtk` chips
  (restorable excisions), ignored words are struck through, and fillers are underlined.
- **Helper libraries:** `react-aria-components` 1.21.1 (Apache-2.0), `@tanstack/react-virtual`
  3.14.13 (MIT).

### 5.8 Browser support policy

| Tier | Browsers | Support |
|---|---|---|
| Stage 1 GA | Chrome and Edge ≥ 120 desktop | Requires WebCodecs, WebGL2, OffscreenCanvas, AudioWorklet and `VideoFrame.copyTo` |
| Report-only | Firefox ≥ 130, Safari ≥ 17 desktop | Golden suites run report-only until green; then promoted |
| Server preview only | Mobile | Read and review, "Pratinjau server" |

A **device probe** on first open times WebGL2 plus libass at 1080×1920 for 60 frames and picks a
preview resolution of 1080 or 720.

---

## 6. FFmpeg compilation and CPU performance

### 6.1 Compiler contract

`compile(plan, mode, sidecar_dir) → FfmpegJob{argv, filter_script_path, fds, expected}` is a pure
function. `expected` is `{w, h, fps, frames, samples, has_audio}`.

| Mode | Purpose | Encode |
|---|---|---|
| `final` | Export | x264 `-preset veryfast -crf 20 -profile:v high -pix_fmt yuv420p -r num/den -g 2F`, colour tags bt709/tv, AAC-LC 192k 48 kHz stereo, `-map_metadata -1`, `+faststart` |
| `reference` | Golden tests | Same graph, `select` of listed frames → lossless PNG of the yuv444p composite converted to RGB with the BT.709 matrix |
| `frame` | Truth frame | One frame |
| `segment` | Server preview | Frames `[a, b)`, ultrafast crf 26, video only |
| `audio_measure` | Loudness annex | Pre-master mix → `ebur128` |
| `audio_span` | Server-rendered preview audio (D10) | `[a, b)` |

The graph is passed via `-filter_complex_script` (no argv length limits). Sidecars live in a
private temp dir with constant names (`captions.ass`, `cam_0.cmd`, `ly_<id>.cmd`, `env_*.f32`,
`a_<sha>.png`). **No user string ever appears in the graph or argv.** Text reaches FFmpeg only
through the ASS file, which edit-core has escaped.

### 6.2 Graph skeleton

Generated for §3.2, abridged and reflowed:

```
-nostdin -y -progress pipe:3
-ss 609.700 -copyts -i /proc/self/fd/4          # segment 0 (cold open)
-ss 586.000 -copyts -i /proc/self/fd/4          # segment 1  (shared input when gap < cost threshold, §6.7)
-ss 603.400 -copyts -i /proc/self/fd/4          # segment 2
-loop 1 -framerate 30 -i a_9d2e.png             # B-roll still
-i a_77aa.m4a                                   # music
-f f32le -ar 48000 -ac 1 -i pipe:5              # env_src (streamed by the Node sidecar writer)
-f f32le -ar 48000 -ac 1 -i pipe:6              # env_it_mu00000001
-filter_complex_script graph.txt  -map [vout] -map [aout]  <final encode args>  /proc/self/fd/7

graph.txt:
[0:v]fps=30,trim=start_pts=18321:end_pts=18477,setpts=PTS-STARTPTS,sendcmd=f=cam_0.cmd,
     crop@cam0=608:1080:656:0,scale=1080:1920:flags=bicubic:in_color_matrix=bt709:in_range=tv,
     format=yuv444p,setsar=1,settb=1/30[v0];
[1:v]fps=30,trim=start_pts=17610:end_pts=18090,setpts=PTS-STARTPTS,split[b1][f1];
     [b1]scale=90:160:force_original_aspect_ratio=increase:flags=area,crop=90:160,boxblur=4:3:2:3,
         scale=1080:1920:flags=bilinear,format=yuv444p[p1];
     [f1]scale=1080:608:flags=bicubic:in_color_matrix=bt709:in_range=tv,format=yuv444p[g1];
     [p1][g1]overlay=0:656:format=yuv444,setsar=1,settb=1/30[v1];
[2:v]…[v2];
[0:a]aresample=48000,pan=stereo|c0=c0|c1=c1,asettb=1/48000,atrim=start_pts=29313600:end_pts=29563200,asetpts=PTS-STARTPTS[a0];
[1:a]…[a1]; [2:a]…[a2];
# transition island between segments 0|1 (3 frames), concat with plain cuts elsewhere:
[v0]split[v0h][v0t]; [v0h]trim=end_frame=153[v0b]; [v0t]trim=start_frame=153,setpts=PTS-STARTPTS,format=gbrp[x0];
[v1]split[v1h][v1t]; [v1h]trim=end_frame=3,format=gbrp[x1]; [v1t]trim=start_frame=3,setpts=PTS-STARTPTS[v1b];
[x0][x1]xfade=transition=fadewhite:duration=0.1:offset=0,format=yuv444p[xf];
[a0][a1][a2]concat=n=3:v=0:a=1[acat];                       # join micro-fades live in env_src
[v0b][xf][v1b][v2]concat=n=4:v=1:a=0,settb=1/30,setpts=N[vmain];
[vmain]sendcmd=f=layers.cmd[vcmd];
[3:v]format=yuva444p,scale@br1=389:389:eval=frame,alphamerge-mask…,colorchannelmixer@br1a=aa=1[br1];
[vcmd][br1]overlay@br1=616:173:format=yuv444:eval=frame:enable='between(n,90,164)'[vu];
[vu]ass=filename=captions.ass:fontsdir=fonts[vt];
[vt][logo]overlay=…:format=yuv444[vo];
[vo]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[vout];
[5:a]pan=stereo|c0=c0|c1=c0[e0]; [acat][e0]amultiply[as];
[4:a]aresample=48000,pan=stereo|c0=c0|c1=c1,aloop=…,atrim=end_sample=3057600[m]; [6:a]pan=stereo|c0=c0|c1=c0[e1]; [m][e1]amultiply[ms];
[as][ms]amix=inputs=2:duration=first:normalize=0[aout]
```

Notes:
- The `-ss` preroll is 1 s before the first needed frame. `-copyts` keeps absolute timestamps, so
  the `fps` grid is anchored at source 0, exactly like the proxy's.
- The transition is cut out as an island so `xfade` runs on 3 gbrp frames only (RGB math
  identical to the shader). `settb` and `setsar` are normalised before `xfade`/`concat` [R2].
- The segment boundaries, `setpts=N` and `settb=1/30` give the `ass` filter integer pts `n`, so
  `nowMs(n)` is exact.

### 6.3 Spikes before building on an op

| Spike | Question | Exit criterion |
|---|---|---|
| S-ZOOM | Can `zoompan` (per-frame integer rect from edit-core, `d=1`) replicate edit-core's rect exactly, at acceptable cost? | Rect exact on 300 frames; ≤ 1.3× the cost of a static crop. Otherwise animated zoom stays disabled; static punch-in ships |
| S-LIBASS-ENGINE | Driving JASSUB's WASM from our worker and blending `ASS_Image` in WebGL2 | P-TXT ≥ 0.999 / max ≤ 16 against the yuv444 reference; ≤ 6 ms/frame at 1080×1920 for pack P1 |
| S-COPYTO | `VideoFrame.copyTo` I420 + shader YUV→RGB, compared with FFmpeg `scale` bicubic chroma | P-DEC SSIM ≥ 0.997, max ≤ 8; ≤ 3 ms/frame at 720p |
| S-XFADE | Each allowed xfade type in FFmpeg 5.1.9 gbrp vs the GLSL port | SSIM ≥ 0.995 at 25/50/75% |
| S-AAC-PRIME | Browser-decoded proxy AAC vs FFmpeg decode, aligned sample-exactly (priming/edit list) | Click-track onset error ≤ 48 samples (1 ms). Otherwise the window proxy audio moves to FLAC in MP4 |

### 6.4 Sidecars

- `cam_i.cmd` and `layers.cmd` are sendcmd files. There is one interval per changed frame:
  `[(n−0.5)/F, (n+0.5)/F)` with the `[enter]` flag, so each frame matches exactly one interval.
  Unchanged runs are compressed. Values are integers.
- `env_*.f32` files are streamed by `node cli.mjs envelope --plan … --source … | fd 5`. A 600 s
  mono envelope is 115 MB of float32; it is never written to disk.
- `captions.ass` plus `fonts/` is a directory of symlinks to pinned font files (verified sha256
  at start-up). The FFmpeg process runs with `FONTCONFIG_FILE` pointing at a config that lists
  **only** `/app/resources/fonts`. libass cannot fall back to a system face, and a
  missing-glyph probe in CI proves it.

### 6.5 Execution (`execute.py`, extending R1's fail-closed runner)

- **Sandboxing:**
  - no shell; the source and output go through `/proc/self/fd`;
  - `-protocol_whitelist file,pipe,fd`;
  - `RLIMIT_AS` of 3 GB and `RLIMIT_NOFILE` of 256;
  - `nice 5`; `-threads 4 -filter_complex_threads 4`.
- **Liveness:** `-progress pipe:3` must advance `frame=` at least every 20 s.
- **Timeout:** `max(120 s, 3 × predicted)`. `predicted` comes from a per-op cost model
  calibrated nightly (seconds per output frame per op at 1080×1920 on 4 CPUs). This replaces the
  fixed 120 s [R1 D9].
- **Stages** reported to the UI: Potong → Reframe → Teks → Overlay → Audio → Master (the
  LokaClip-style progress [R2]), derived from `-progress` frame counts and the pass currently
  running.

### 6.6 Output verification (`verify.py`, blocks publication)

| Gate | Check |
|---|---|
| G1 container | h264 High, yuv420p, W×H, SAR 1:1, `r_frame_rate = num/den` CFR, bt709/tv tags, AAC-LC 48 kHz stereo, faststart |
| G2 A/V | Video frames = `plan.frames`; audio samples = `plan.samples` ± 1,024 (encoder padding accounted for) |
| G3 loudness | `ebur128` integrated −14 ± 1 LUFS, true peak ≤ −1.0 dBTP (when normalize is on) |
| G4 sanity | `blackdetect` and `freezedetect` spans longer than 0.5 s only where the plan has intended stills |
| G5 text-safe | Plan bbox check plus, on 3 sampled frames, ink bbox inside the safe zone |

### 6.7 Performance on the CPU-only box

Measured basis:

| Graph | Result | Source |
|---|---|---|
| 30 s at 1080×1920, plate plus karaoke ASS, 4 CPUs | yuv444p **10.6 s (0.35× realtime)**; yuv420p 8.2–8.9 s | [PF] |
| 30 s at 720×1280 | 3.45 s plate vs 5.46 s gblur | [R3] |
| Stage-2 graph (3 segments, zoompan, xfade, overlay, ASS, ducking, loudnorm), 17.8 s at 1080×1920 | 9.44 s in the production image | [R2] |
| Truth frame | 0.43 s at 1080; 0.16–0.20 s at 720 | [R2] [R3] |
| Window proxy, 120 s 1080p source | 12.5 s on 4 cores | [R3] |

Budgets on the 4-CPU render container:

| Work | Budget |
|---|---|
| Stage-1 typical graph (camera or fit-blur, karaoke pack, hook, ≤ 5 stickers, music plus duck) at 1080×1920 | **p50 ≤ 0.5×, p95 ≤ 0.75× clip duration** |
| Stage-2 graph with ≤ 3 transitions and ≤ 5 keyframed overlays | p95 ≤ 1.0× |
| Audio annex | ≤ 3 s for a 90 s clip |
| Truth frame | p95 ≤ 0.5 s |

Optimisations built into the compiler:

1. The plate blur replaces gblur: −37% [R3].
2. **Input sharing.** For consecutive ranges, the compiler compares `cost(new input) ≈ preroll +
   distance to the previous keyframe` with `cost(shared) ≈ gap frames`. It shares one decoder
   with `split`+`trim` when that is cheaper. This matters for jump-cut-heavy edits on long-GOP
   sources, where 20 cuts × a 5 s GOP would otherwise decode about 3,000 wasted frames.
3. xfade runs only on island frames.
4. Static layers (logo, credit) are pre-scaled once; `overlay` with `enable` skips work outside
   the span.
5. **Render cache key:**
   `render_key = sha256(plan_sha256 ‖ annex_sha256 ‖ compiler_version ‖ ffmpeg_build (ffmpeg -version + libass version) ‖ font_pack_sha ‖ encode_preset)`.
   The output is `output/edits/<clip_id>/<render_key[:16]>.mp4`. Re-exporting an unchanged
   document is instant, and a renderer fix re-renders instead of reusing a stale file [R1 D8].
6. **Stage 3 option: segment-parallel rendering.**
   - Split at cuts into chunks of at least 10 s, encode the chunks with forced IDR at their
     boundaries, render the audio once, then concat with stream copy.
   - Gate: framemd5-identical to a single pass in `reference` mode.
   - Expected 1.5–2× on 4 CPUs, because `ass` and `boxblur` are single-threaded.

**Process placement:**
- `render-worker` (4 CPUs) runs final renders only.
- A new `preview-worker` process (same image, `cpus: 1.5`, priority queue) handles truth frames,
  segments, window proxies, peaks, filmstrips, annex measurements and audio spans. The web route
  may call it synchronously for truth frames.
- Whisper and selection (primary worker, 6 CPUs) are untouched.
- Caps:
  - 2 truth frames at a time;
  - 1 segment job per user, cancelled when a newer plan hash supersedes it;
  - proxy builds at nice 10.

---

## 7. API, storage, revisions, concurrency, assets

### 7.1 Storage layout (per job, plus a workspace asset store)

```
analysis/clips/<clip_id>/edit/doc.json                    current revision, canonical bytes, 0600
analysis/clips/<clip_id>/edit/archive/r<N>.<sha>.json      superseded revisions (pruned, see below)
analysis/clips/<clip_id>/edit/receipts/<uuid>.json         {key, payload_sha256, result_etag, state, at}  (digest only)
analysis/clips/<clip_id>/plans/<plan_sha>.json + sidecars  cache (LRU 20)
analysis/clips/<clip_id>/annex/<audio_mix_sha>.json        loudness measurements
analysis/clips/<clip_id>/camera.v1.json                    camera plan (analysis)
analysis/clips/<clip_id>/media/w-<a0>-<b0>.{mp4,json}      window proxy
analysis/media/{scrub.mp4, peaks.bin, filmstrip/*}         whole-source media
output/edits/<clip_id>/<render_key16>.{mp4,srt}            renders (no-clobber, fenced publish as today)
/data/assets/<sha256>.<ext> + <sha256>.meta.json           workspace assets (brand kit, uploads), refcounted
```

**Pruning** (fixes R1 D5):
- Receipts are kept for 24 h or the last 64, whichever is larger, and store only digests.
- Archives keep:
  - every revision referenced by a render request;
  - the last 50 revisions;
  - one checkpoint per hour for 7 days;
  - revision 1 ("Kembali ke versi AI").
- A nightly compactor enforces this and never touches a revision a render lease references.

### 7.2 Endpoints

All routes use the existing `requireAuth`. Mutations use the existing Origin/Host/Sec-Fetch-Site
CSRF checks.

| Method and path | Purpose | Notes |
|---|---|---|
| `GET /api/jobs/:id/clips` | V3 clips with `clip_id`, edit status, proxy readiness | From `selection.v3.json` |
| `POST /api/jobs/:id/clips/:clipId/edit:seed` | Create revision 1 from V3 | Idempotency-Key; 409 if it exists |
| `GET …/edit` | Current document plus `ETag: "<sha>"` | `no-store` |
| `PUT …/edit` | Save the full document | `If-Match` (428 if missing), `Idempotency-Key`, `X-Plan-Sha256`, `X-Core-Version`, ≤ 4 MiB streamed |
| `GET …/edit/revisions`, `GET …/edit/revisions/:n`, `POST …/edit:restore {n}` | History panel "Riwayat" | Restore creates a new revision |
| `GET …/plan?etag=` | Server plan (debugging, parity triage) | |
| `POST …/preview-frame {plan_sha256, n, scale}` | Truth frame, `image/png` | 409 if the plan hash is unknown or stale |
| `POST …/preview-segments {plan_sha256, a, b}` | Server segments, `{urls}` | Fallback mode |
| `POST …/audio-span {plan_sha256, a, b}` | Server audio for D10 ops | |
| `POST …/renders {etag, preset}` | Enqueue a final render | Storage reservation as today |
| `GET /api/jobs/:id/renders/:rid` | Status plus stages | |
| `GET /api/jobs/:id/media/scrub.mp4`, `…/clips/:clipId/media/window.mp4`, `…/peaks.bin`, `…/filmstrip/:n.webp` | Range streaming (existing `preview-source` fd code) | `Cache-Control: private, max-age=31536000, immutable` (content-hashed names) |
| `POST /api/assets` (multipart), `GET /api/assets/:sha`, `GET /api/assets?kind=` | Asset store | §7.5 |
| `POST …/ai/{hooks,cold-open,fillers,keywords,broll}` → `GET …/ai/tasks/:tid` | AI suggestions (async) | §8 |
| `GET /editor-static/fonts/:sha.ttf`, `/editor-static/emoji/:cp.png`, `/editor-static/core/*` | Immutable resources | COEP-compatible (same origin) |

**Bridging:**
- The Node route validates the document with edit-core in-process, canonicalises it and computes
  the plan hash. It then calls Python `edit_v2.api` over the existing stdin-envelope CLI (about
  80 ms) for the locked, receipt-checked commit.
- Python re-parses strictly: integers only, canonical bytes equal, schema id, revision chain,
  size. It does not re-run semantic validation; the worker re-validates via `node cli.mjs` before
  any render.

### 7.3 Revisions and concurrency

- The ETag is `sha256(canonical bytes)`. A PUT requires `If-Match == current`,
  `revision == current + 1` and `parent == current`. This is kept from V1 and is sound [R1].
- **Plan handshake (D13):**
  - the server recomputes `plan_sha256` for the saved document;
  - a mismatch with `X-Plan-Sha256` saves the document anyway (it is valid) and returns
    `warning: plan_mismatch` plus the server core version;
  - the client then shows "Editor perlu dimuat ulang" and disables export until it reloads;
  - telemetry records the pair.
- `X-Core-Version` older than the server's minimum gives 426, "muat ulang editor". The document
  is kept in IndexedDB.
- Multi-tab in one browser: `BroadcastChannel` warns "Klip ini terbuka di tab lain". Otherwise
  the rebase flow in §5.7 applies. There is no CRDT and no real-time collaboration (§12).

### 7.4 Render queue generalisation (keep R1's state machine)

- `candidate_id` becomes `clip_id`.
- `kind` is `final|frame|segment|audio_span|annex|proxy|peaks|filmstrip`. `priority` is
  `interactive` > `export` > `background`.
- `cancel` is added (by plan-hash supersession for interactive kinds).
- Output key per §6.7. Leases, heartbeats and fenced publication are kept.
- The request binds `{doc revision sha, plan_sha256, annex_sha256, source content sha, asset
  shas}`. The full source copy into `render-inputs/` (R1: it doubles storage) is replaced by an
  **fd-held, content-verified open** of the job's source, plus a hard link into `render-inputs/`
  when the filesystem allows it.

### 7.5 Asset upload security

| Step | Rule |
|---|---|
| Transport | `POST /api/assets`, multipart via busboy (already a dependency). The byte count is enforced while streaming: images ≤ 20 MB, video ≤ 500 MB, audio ≤ 50 MB, LUT ≤ 2 MB. Storage admission reservation first |
| Quarantine | Write to `/data/assets/.quarantine/<uuid>` (0600, O_NOFOLLOW, `O_EXCL`), hashing while streaming |
| Sniff | Magic bytes against an allowlist: PNG, JPEG, WebP, GIF (first frame only, Stage 1), MP4/MOV (`ftyp`), WebM/MKV (EBML), M4A, MP3, WAV, FLAC, OGG, `.cube` (text, ≤ 65³ entries, parsed by our own parser). **Rejected:** SVG, HEIC (Stage 1), PDFs, any playlist or concat format |
| Probe | `ffprobe` with `-protocol_whitelist file,fd`, the demuxer forced from the sniffed type (`-f`), a timeout of 20 s and rlimits. Reject > 4096×4096 or > 16.7 MP images [R1 `_verify_raster`], > 1920×1080 or > 60 fps or > 10 min video, > 15 min audio, and more than 1 video + 1 audio stream |
| Normalise (sandboxed FFmpeg) | **Images:** apply EXIF orientation, convert to sRGB 8-bit RGBA PNG, strip all metadata and colour chunks (I6). **Video:** H.264 yuv420p CFR at 30 fps, `setsar=1`, BT.709 tagged, audio AAC 48 kHz stereo via explicit `pan`, plus a 720p short-GOP preview copy. **Audio:** AAC-LC 192k 48 kHz stereo (the same bytes decoded on both sides) |
| Address | `sha256(normalised bytes)` is the asset id. The original's sha is kept in metadata for dedupe. Metadata: `{kind, mime, w, h, duration_ms, has_audio, license?, uploaded_at, refcount}` |
| Serve | `GET /api/assets/:sha`: auth, `Content-Type` from the allowlist, `nosniff`, `Content-Disposition: inline; filename="asset.<ext>"`, `Cross-Origin-Resource-Policy: same-origin`, immutable caching |
| Use | Documents can reference only existing sha ids. The FFmpeg graph refers to assets by constant temp names |
| GC | Refcount over documents and templates. Unreferenced assets are deleted after 30 days |
| Licensing | Music and SFX library entries require `{license, source_url, attribution}`. User uploads carry a "Content ID" warning; no licence field is required |

**App-wide headers for the editor route:**
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp` (for WASM threads)
- CSP: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'`
- Self-hosted UI fonts, which also removes the Google Fonts `@import` [R1 §8].
- Session revocation (a server-side session id with a denylist) is recommended before multi-user
  use [R1].

---

## 8. AI features in the editor (free-first LLM layer)

### 8.1 Principles

- **Suggestions, not edits.** AI returns candidates. Accepting one runs a normal command (one
  undo step) that records
  `origin: {kind: "ai", task, prompt_version, provider, model, cached}`.
- **Server-side only.** Keys never reach the browser. The client is
  `llm.create_llm_client_from_env(cache_dir=<job>/analysis/llm-cache)`, which gives
  `FailoverLLMClient` over the free providers configured (Gemini Flash-Lite, Groq, OpenRouter
  free, Cerebras, Ollama…) with `CachedLLMClient`.
- **Deterministic fallback.** Every AI task has a heuristic path (`hook_heuristics.py`, the
  filler lexicon, IDF keywords) that returns within 1 s. The LLM result replaces it when it
  arrives. `LLMUnavailable`, `quota_exhausted` and timeouts show "Saran AI tidak tersedia —
  memakai saran otomatis".
- **Deadline.** `llm.py` has no overall deadline, so `editor_ai.py` enforces one: 12 s for hooks,
  20 s for fillers and B-roll. The provider × model × retry product is bounded by the deadline.
- **Grounding and validation.** Every LLM field is validated like `llm_selection` does
  (free-tier models return partial objects). Ungrounded names or numbers are dropped (§8.2).
- **Privacy.** Only transcript text is sent, never media. The UI shows the provider's free-tier
  data note (the Gemini preset says free-tier data may be used by Google). `POTONGIN_LLM=off` and
  local `ollama` are supported.
- **Module:** `src/ai_clipper/editor_ai.py`, a CLI with a stdin envelope:
  `python -m ai_clipper.editor_ai --task hooks`. Prompts live in
  `src/ai_clipper/prompts/editor_{hooks,fillers,keywords,broll}_v1.md` with a `PROMPT_VERSION`
  per task.

### 8.2 Hook suggestions (Stage 1b; M8)

- **Input:**
  - output-timeline text of the clip after edits, as numbered lines `L1..Ln` (reusing
    `llm_selection.build_prompt_lines` / `render_prompt_line`);
  - archetype, current hook, title;
  - tone chip: Santai, Serius, Lucu or "Clickbait halus";
  - the design's character budget from edit-core's fit (for example 38 chars for 2 lines of
    "Punchline").
- **Output schema:**

  ```json
  {"hooks":[{"text":"…","archetype":"curiosity_gap","evidence":["L3","L4"],"label":"FAKTA"|null}]}
  ```

  5 hooks are requested.
- **Validation** (each failure drops the item, and the reason is logged):
  - NFC, no control characters, no URL, no hashtag;
  - length ≤ the budget (default 60, maximum 90);
  - archetype in `selection_types.ARCHETYPES`;
  - evidence lines exist;
  - **entity grounding:** every number, capitalised non-initial token and quoted span in the hook
    must occur in the clip text (case-folded, with Indonesian affix-light matching of the
    `meN-`/`di-`/`-nya` stems). Otherwise the hook is dropped;
  - near-duplicate removal (token Jaccard ≥ 0.6);
  - fit check by edit-core for the current design: "muat" or "akan terpotong".
- **Fallback:** the heuristic hook from `hook_heuristics` (≤ 60 chars), plus the V3 hook
  (`SelectedClip.hook_text`), plus 3 question/claim templates filled from the top-salience
  sentence unit.
- **Gates:**
  - 0% ungrounded entities on a 100-clip eval set (script check plus an LLM judge);
  - ≥ 70% rated "usable as is" by the owner on 30 clips;
  - p95 ≤ 8 s with at least one working provider;
  - fallback ≥ 3 suggestions in ≤ 1 s.

### 8.3 Cold-open suggestions (Stage 1a)

- Candidates are sentence units within ±90 s of the clip that score high on the V3 hook features
  (question, claim, laugh-adjacent), 0.5–8 s long, and not overlapping the body by more than
  50%.
- The LLM reranks the top 8 (prompt `editor_hooks_v1` in `cold_open` mode, returning line refs
  only).
- Accepting a candidate snaps it by word (§4.1).
- **Gate:** the owner prefers the suggestion over "no cold open" on ≥ 60% of 20 clips (blind A/B
  on renders).

### 8.4 Filler and silence removal (Stage 1c; M4)

- **Deterministic core** (edit-core `analysis/fillers.mjs`, instant, offline):
  - lexicon `resources/lexicon/id-fillers.v1.json`: `eh, em, emm, ehm, hmm, mm, uh`, isolated
    `ah`, isolated `anu`;
  - immediate repeats ("aku aku");
  - gaps from `audio_timeline.silences` and word gaps;
  - "shorten gaps > X ms to Y ms" (defaults 600 → 200) [R2].
  - **Protected particles** are never proposed: `sih, dong, kok, lho, deh, kan, ya, nih, tuh,
    gitu, kayak`.
- **LLM assist** (optional, server) classifies **false starts and restarts** only. It returns
  `{"spans":[{"from":"w004511","to":"w004514","kind":"false_start","why":"…"}]}`, and those ids
  must exist and be contiguous.
- **UX:** a review dialog with per-item toggles, a preview (±1 s around each item), and the
  choice "Sembunyikan di subtitle" vs "Potong dari audio". Accepting creates excisions in one
  transaction.
- **A/V:** frame-snapped edges, 8 ms envelope fades, zero drift by construction (§4.1).
- **Gates:**
  - lexicon precision ≥ 0.9 on 200 labelled Indonesian tokens before "Hapus semua" is enabled;
  - protected-particle false positives = 0;
  - no audible click (sample step at a cut < −40 dBFS);
  - G-SYNC with 20 cuts: 0 samples drift (by construction; verified).

### 8.5 Keyword emphasis (Stage 1b)

- The LLM picks ≤ 1 keyword per cue (word ids). The fallback is the top-IDF content word per cue,
  excluding particles and pronouns, with numbers preferred.
- Keywords are shown as suggestions and applied with "Terapkan semua".
- **Gate:** the owner accepts ≥ 70% on 10 clips.

### 8.6 B-roll suggestions (Stage 2: user library; Stage 3: stock)

- **LLM output:**

  ```json
  {"moments":[{"line":"L7","phrase":"dompet","kind":"object|person|place|concept|meme","query_id":"dompet kulit","query_en":"leather wallet","confidence":0.0-1.0}]}
  ```

  `phrase` must fuzzy-match words in that line, and is then mapped to word ids and frame spans.
- **Retrieval:**
  - Stage 2: the workspace asset library by tags and filename tokens;
  - Stage 3: an opt-in Pexels API key, with licence metadata stored and the API terms respected.
- Suggestions appear as ghost items on a B-roll lane: PiP by default, a 150 ms fade, and duration
  equal to the phrase span clamped to 1.5–4 s.
- **Gates:** relevance ≥ 0.7 on a 50-moment judged set; at most 1 suggestion per 8 s.

### 8.7 Metadata regeneration (Stage 1b)

After edits, title, description and hashtags can be regenerated with the V3 prompt conventions
(`MAX_TITLE_CHARS`, `MAX_HASHTAGS`) and the same validators. They go into `publish` as a
suggestion.

---

## 9. Golden-test system (how parity is proven)

### 9.1 Corpus (`tests/golden/`, self-owned or synthetic only; no YouTube media)

| Asset | Purpose |
|---|---|
| `barcode_{2997cfr,25,30,vfr}.mp4` | Every frame carries its index as a 24-bit black/white block code (4 px blocks, top row). Used for P-FRAME. H.264 GOP 250, AV1 GOP 6 s (the YouTube case), HEVC (report-only) |
| `colorbars_{709,601,untagged}.mp4` | Colour matrix decisions and P-DEC |
| `podcast_twoshot_1080p.mp4` (60 s, self-recorded or CC0), `vertical.mp4`, `4x3.mp4` | Realistic composites |
| `clicks.wav` (48 kHz, impulses at known samples), `tone_bursts.wav` | Audio alignment and envelopes |
| `docs/*.json` (about 120 plan fixtures) | Every op alone; every pack × 3 texts (10/40/90 chars, with and without emoji tokens) × 5 timestamps; every hook design; combined scenes (cold open + 20 jump cuts + karaoke + hook + sticker above captions + B-roll with transition + keyframed overlay + ducked music) |

### 9.2 Test layers

| Layer | Runs | What it asserts |
|---|---|---|
| Unit and conformance (`node --test`, `pytest`) | Every PR, under 60 s | Schema vectors; canonical bytes equal from Python and JS; resolver: doc → plan byte-exact golden; ASS bytes golden; sendcmd files golden; envelope hashes; `compile_ffmpeg` argv/graph string goldens; lint bans (§4.8, §5.5) |
| P-XENG | Every PR | Plan hashes equal across Node 20, Chrome, Firefox and WebKit |
| P-FRAME | Every PR (small), nightly (full) | Barcode decode on both sides at all output frames: **0 mismatches** |
| P-TIME | Every PR | For every ASS event boundary and karaoke switch: first visible frame equal on both sides; hazard frames included |
| P-TXT | Every PR (subset), nightly (full) | Text-only layers vs FFmpeg yuv444 reference: SSIM ≥ 0.999, max ≤ 16, 0 px off by more than 16; vs RGB24 reference: SSIM ≥ 0.9995 |
| P-COMP | Nightly | Full composites vs lossless reference: SSIM ≥ 0.99, PSNR ≥ 35 dB, px off by more than 64 ≤ 0.05%; layer boxes exact (integer rects), rotated ±1 px |
| P-DEC | Nightly | Browser decode+convert vs FFmpeg decode+convert: SSIM ≥ 0.997, max ≤ 8 |
| P-AUD | Every PR (render), nightly (preview) | Render: `env × source` exact to ≤ 1 LSB s16; join positions exact samples. Preview (OfflineAudioContext at 48 kHz): 10 ms RMS envelope error < −40 dB; click onsets ±48 samples |
| P-ENC | Nightly | Final vs lossless SSIM ≥ 0.99 (measured 0.995) |
| P-RT | Every PR | seed(V3 clip) → render **framemd5-identical** to the auto render (same engine); against the pre-migration `render.py` output: SSIM ≥ 0.98 plus an owner look review (Stage 0 only) |
| Output contract | Every render in CI | G1–G5 |
| Perf | Nightly on the reference box | Budgets in §10; regression > 10% fails |

### 9.3 Harness

- `scripts/parity/run.sh` runs **inside the production image** at a pinned digest:
  - FFmpeg `reference` renders;
  - Playwright 1.62.1 with **pinned Chrome for Testing 147.0.7727.15** (`chromium-1217`) runs the
    deterministic capture page `web/app/_parity/page.jsx` (a dev-only route). It loads a plan
    fixture, renders frame `n` with the full-resolution source (to separate compositor error from
    proxy softness) and returns `readPixels`.
- Metrics:
  - FFmpeg `ssim`/`psnr`;
  - numpy max/threshold counts;
  - per-region masks from the plan's layer boxes;
  - temporal: the best offset within ±2 frames must be 0.
- A red case uploads the ×8 diff heatmap, a side-by-side image and the metrics JSON as CI
  artifacts (the method is in `lab/cmp.py`).
- Baselines are updated only by `--bless` plus a reviewer, and the heatmap report goes into the
  PR.
- Nightly: the full corpus in Firefox and WebKit, report-only until promoted.

---

## 10. Staged delivery and quality gates

### 10.1 Gate catalogue (referenced below)

- **Parity:** P-XENG, P-FRAME, P-TIME, P-TXT, P-COMP, P-DEC, P-AUD, P-ENC, P-RT (§9).
- **Output:** G1–G5 (§6.6), G-SAFE, G-FAIL (no silent fallback: every refusal names the cause in
  Indonesian), G-UNDO (random command sequences, then undo all, deep-equal; 200 steps), G-I18N
  (UI in Bahasa Indonesia, NFC, "Rp" and "%" intact).
- **Performance:**

  | Budget | Target |
  |---|---|
  | PF-OPEN | Editor interactive ≤ 2.0 s with a warm window proxy; ≤ 8 s cold, including the proxy build |
  | PF-SEEK | p95 ≤ 50 ms |
  | PF-PLAY | ≤ 1 dropped frame per 10 s at the chosen preview resolution on the reference laptop |
  | PF-INPUT | ≤ 50 ms |
  | PF-RESOLVE | ≤ 16 ms for a 90 s clip |
  | PF-SAVE | Autosave ≤ 2 s after the last edit |
  | PF-TRUTH | p95 ≤ 0.5 s |
  | PF-RENDER | §6.7 |

  - The reference laptop needs choosing. Proposed: an Intel i5-1135G7 or Ryzen 5 5500U, 8 GB,
    integrated GPU, Chrome stable.
- **UX:** timed tasks with the owner plus 2–3 working clippers. Each task needs a 90% success
  rate unaided and must meet its median time. SUS ≥ 72 at the end of Stage 1.
- **Security:** an upload fuzz corpus (truncated, polyglot, oversized, playlist-in-MP4, SVG
  renamed to PNG) is 100% rejected or normalised; CSP/COEP are verified by an e2e test; the ASS
  escape fuzz test covers `\N {\b1} \h`, RTL and emoji [R1 G8].

Every op, pack and design has `resources/flags.json`:

```
{"<op>": {"enabled": false, "evidence": {"ci_run": "…", "golden": "…"}}}
```

The UI and the server validator read it. A flag flips only in a PR that links green evidence.

### 10.2 Stage 0: foundations (8–10 pw). No new editor UI; users see no change

- **0a. edit-core skeleton:**
  - schema, canonicalisation, detmath, time model, time map;
  - captions (legacy packs), hook (`legacy-bar`), camera pans, fit_blur plate, fill_center;
  - ASS emitter; envelopes (join fades only); `cli.mjs`.
- **0b. Server side:**
  - Python `compile_ffmpeg` for those ops; yuv444p compositing; explicit colour, pan and
    timebase;
  - font pack plus the fontconfig lockdown; `verify.py` G1–G5;
  - `camera_plan.py` (Haar → keys);
  - `seed.py`, and `clip_id` in `selection.v3.json` (coordinated with the V3 owners).
- **0c. Auto render migrated.** `pipeline.py` renders through seed → plan → compile behind
  `POTONGIN_RENDER_ENGINE=v2`. It becomes the default after the gate.
- **0d. Golden harness:** corpus, capture page, CI in the production image.
- **Spikes:** S-COPYTO, S-LIBASS-ENGINE, S-AAC-PRIME. Results decide the §5 paths.
- **Gates:**
  - P-XENG, P-FRAME (0 mismatches, ≥ 2,000 frames, CFR, VFR and AV1), P-TIME, P-TXT (≥ 0.999 /
    ≤ 16 against yuv444 on legacy packs), P-AUD (render), P-RT, G1–G5;
  - **PF-RENDER:** a 60 s fit-blur auto render at 1080×1920 is **≤ today's time** despite the
    yuv444 compositing (the plate saves 37%), in the production image on 4 CPUs;
  - **Owner look approval** of the plate blur and the migrated legacy look, side by side on 5
    real clips.

### 10.3 Stage 1a: editor shell, engine, timing edits (12 pw)

- **Features:**
  - new route `/projects/[id]/clips/[clipId]/edit` for V3 clips;
  - proxies (scrub and window), peaks, filmstrip;
  - engine: range, crop_scale, camera, fit_blur, fit_black, overlay (images), text (libass),
    fade;
  - truth frame plus sentinel;
  - timeline lanes: V1, cold open, captions (read-only style), hook, A1 waveform, markers
    (laughter, silence, scene cut);
  - **word-snapped trim (M1)**; **cold-open lane plus intro hold (M2)**; **waveform and markers
    (M3)**; **transcript editing with restorable excisions (M4, manual only)**;
  - caption word text edit and retime (M5 core);
  - undo/redo, autosave, IndexedDB draft, rebase (M15);
  - export dialog (M16) with the render cache key;
  - cold-open suggestions (§8.3).
- **Gates:**
  - P-FRAME, P-TIME and P-TXT in the browser engine; P-COMP ≥ 0.99 / 35 dB for the enabled ops;
    P-DEC; P-AUD (preview);
  - PF-OPEN, PF-SEEK, PF-PLAY, PF-INPUT, PF-RESOLVE, PF-SAVE, PF-TRUTH;
  - G-UNDO; the conflict e2e test (two tabs, both edits survive);
  - **UX tasks:**
    - T1 fix a mid-word start: median ≤ 10 s, 0 clipped phonemes on 20 gold boundaries
      (listening test);
    - T2 remove a 5 s ramble via the transcript: ≤ 20 s;
    - T3 replace the cold open with another sentence: ≤ 30 s;
    - T4 reload mid-edit: ≤ 2 s of work lost;
    - T5 two-tab conflict: no data loss.

### 10.4 Stage 1b: the look (10 pw)

- **Features:**
  - 8 caption packs P1–P8 [R2 §7.1] with the reveal modes (per_word, chunk_karaoke, cumulative,
    segment_static, karaoke_sweep) and animations (fade, pop, bump, slam, glow, box_pop) (M6,
    M7);
  - the custom style drawer, and user packs saved as versioned JSON;
  - 9 hook designs (M8), with gradients and rough edges as edit-core-baked PNGs;
  - **AI hook suggestions (§8.2)**, AI keyword emphasis (§8.5), metadata regeneration (§8.7);
  - text overlays (M9); stickers, emoji PNGs, label pills, logo, source credit auto-fill from
    yt-dlp `channel` (M10); templates (M17).
- **Gates:**
  - every pack and design: P-TXT at 5 timestamps × 3 texts, and G-SAFE for 10/40/90-char texts
    with emoji;
  - animation stability: non-active words move ≤ 1 px between frames [R2 M7];
  - active-word onset exactly on frame `n_on`;
  - cap height ±3% of the pack spec;
  - P-COMP for stickers and logo; logo alpha ±2%;
  - emoji render in colour in the production image (> 3 distinct hues in the bbox);
  - AI gates from §8.2 and §8.5;
  - libass ≤ 6 ms/frame for P1 at 1080×1920 on the reference laptop;
  - **UX tasks:**
    - T6 apply a pack and fix a misheard word: ≤ 15 s;
    - T7 choose an AI hook plus a design and export: ≤ 60 s;
    - T8 add an emoji sticker, logo and credit: ≤ 45 s.

### 10.5 Stage 1c: layouts and audio (12 pw)

- **Features:**
  - camera-plan editing (manual keys, seat chips);
  - smart speaker via YuNet plus mouth-motion ASD plus VAD (M11);
  - split screen (≥ 2 s segments, 8 s by default);
  - branded frame;
  - B-roll images and video (PiP, cutaway, split) with fades and rounded masks (M12);
  - music library with licence metadata; music with **envelope ducking** (M13), fades and loop;
    SFX basics;
  - loudness two-pass plus the limiter envelope;
  - filler and silence removal with review (§8.4).
- **Gates:**
  - **Face-track:** the active speaker's face centre stays inside the crop in ≥ 97% of speech
    frames on 10 labelled two-speaker clips. No camera switch within 1.0 s of the last one. Pan
    ≤ 6% of width per 100 ms. A face-less segment either falls back explicitly or fails [R2 M11].
  - **If the ASD gate fails:** ship manual seat chips only, and keep "Auto speaker" disabled.
  - **Ducking:** music RMS ≥ 8 dB below voice during speech; recovery ≤ 600 ms; preview vs render
    ±1 dB (by construction: identical envelopes).
  - **Audio output:** G3 −14 ± 1 LUFS, true peak ≤ −1 dBTP; G-SYNC with 20 cuts, 0 drift;
    B-roll timing exact to the frame.
  - **Performance:** PF-RENDER for a 60 s clip with 5 overlays plus music.
  - Filler gates from §8.4.
  - **UX tasks:**
    - T9 force speaker B for a sentence: ≤ 15 s;
    - T10 add music and confirm speech is clear: ≤ 30 s;
    - T11 B-roll PiP with fade: ≤ 30 s;
    - T12 review 10 filler items: ≤ 60 s;
    - SUS ≥ 72.

### 10.6 Stage 2: CapCut core (18–22 pw)

- **Features:**
  - general multi-track (≤ 8 tracks, ≤ 64 items each); ripple, roll, slip and slide (S1, S2);
  - keyframes with a curve editor for all sendcmd-backed properties (S3);
  - transitions: the xfade subset as islands (S4);
  - effects: eq, LUT, vignette; static punch-in; animated zoom if S-ZOOM passed (S5);
  - constant speed (S6): video via `setpts`, audio via server audio spans;
  - SFX library with "AI saran SFX" ghost items (S7);
  - text in/out/loop animations as ASS templates (S8);
  - audio clean-up (`afftdn`/`arnndn`, server audio spans) (S9);
  - masks (generated PNG masks) (S10);
  - group and copy attributes (S11); markers (S12);
  - multi-aspect export with per-aspect layout overrides and safe-area reflow (S13);
  - cover card (S14); comment-reply card (S15); caption packs P9–P12 (S16);
  - B-roll suggestions from the user library (§8.6).
- **Gates:**
  - per op: its golden cases and a flag; P-COMP with 3 transitions and 5 keyframed overlays;
  - timeline with 50 items interacts at 60 fps; PF-RENDER Stage-2 budget;
  - G-UNDO with 200 random multi-track commands;
  - UX tasks for keyframing ("punch-in on a laugh": ≤ 30 s) and transitions.

### 10.7 Stage 3+ (COULD, [R2] §9)

- AI B-roll stock search (Pexels opt-in); TTS and dubbing; caption translation (EN/MY);
  background removal (only if ≤ 2× realtime on CPU); "edit dengan chat" (only on top of the
  command API: every agent action is a logged, undoable command); three-person and gaming
  layouts; direct publishing; review links.
- Segment-parallel rendering (§6.7.6).
- Gates are defined per feature when each is scheduled. The global parity gates always apply.

---

## 11. Risks and mitigations

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| libass skew: JASSUB 0.17.4-43 vs Debian 0.17.1 | Medium / medium | Pin JASSUB 2.5.16. Every upgrade is gated by the full P-TXT suite. Optionally rebuild FFmpeg against the same libass tag in a later image. Measured skew today is SSIM 0.9998 against RGB [R3] and 0.99925 against yuv444 [PF] |
| Our use of JASSUB internals (driving the WASM and forking the worker glue) breaks on upgrade | Medium / low | Exact version pin; a 300-line adapter with contract tests; the WASM stays unmodified (LGPL notices). Fallback: the three-canvas mode with the sync barrier |
| Safari and Firefox GPU paths (`copyTo`, WebGL precision) | Medium / medium | D7 own conversion; report-only suites; sentinel telemetry; Chrome/Edge-only GA |
| Cross-engine float drift changes plan hashes | Low / high | detmath, lint bans, P-XENG on every PR, handshake (D13) |
| Node in the render path (a new cross-language dependency) | Low / medium | Same image, pinned Node 20 LTS. The core is zero-dependency except harfbuzzjs and the ajv-generated validator. `core_bridge.py` has timeouts and bounded I/O. Nightly run on Node 22 ahead of the upgrade |
| CPU contention (Whisper plus renders plus previews on one box) | High / medium | Separate preview-worker with a CPU share; nice levels; top-N-only window proxies; cancellation by plan-hash supersession |
| yuv444 cost (+19–29%) | Certain / low | Offset by the plate blur (−37%); budget still met (0.35×); measured, not assumed |
| Face and ASD quality (Haar today) | High / high for two-speaker clips | Stage 1c gate; fall back to manual seat chips; never a silent centre crop |
| Proxy storage (about 20 MB per window, 120 MB/h scrub) | Medium / low | Storage admission reservations; delete proxies with the job; window proxies only for opened or top-N clips |
| Scope pressure versus "no half-baked" | High / high | Flags plus evidence rule (D14); stage gates; the "what we will not build" list |
| LGPL in WASM (FriBidi inside JASSUB); GPL FFmpeg if the image is distributed | Low / medium | Notices page with source links; legal review before GA [R3] |
| Owner rejects look changes (plate, native fps) | Medium / low | Stage 0 look approval gate; the legacy gblur can be kept as an op `fit_blur_legacy` (server-preview-only) if required |

---

## 12. What we will NOT build

- **No DOM or CSS rendering of any shipped pixel.** DOM is for handles, guides and gizmos only.
- **No ffmpeg.wasm** (32 MB, GPL distribution, 0.9× realtime [R3]). **No** Remotion, Editframe,
  DesignCombo, Twick, Shotstack Studio or etro (licences [R3]).
- **No browser-only effects**: CSS filters, Canvas `filter`, Lottie, WebGL-only shaders. **No**
  `drawtext`, `gblur`, `dissolve`, `sidechaincompress`, dynamic `loudnorm`, time-varying crop
  size, or expression-driven animation in the final graph.
- **No colour emoji through libass.** Emoji are always PNG overlays [R2].
- **No approximate preview mode shipped silently.** An op that cannot be previewed exactly is
  either hidden or explicitly served by server frames and segments or server audio.
- **No second implementation of any resolver logic.** `captions_ass.py`, `subtitles.py` chunking,
  `render_manifest._build_ass` and `_layout_filter` are retired after Stage 0c. Their tests become
  edit-core vectors.
- **No real-time collaboration or CRDT.** This is a single-owner product; optimistic concurrency
  plus intent rebase is enough.
- **No user-uploaded fonts** in Stages 1–2 (licence and parity risk), **no SVG uploads**, **no
  animated GIF/Lottie** until a server pre-rasterisation path exists (Stage 3).
- **No HDR editing, no 4K output, no 60 fps default.** 60 fps sources are halved unless the user
  opts in.
- **No arbitrary z-interleaving** of text and images beyond the three bands until there is demand
  (D6 keeps the door open).
- **No speed ramps with curves**, **no pitch-shifted audio preview**, **no generative features**
  (smooth-cut morphs, eye contact).
- **No GET with a side effect** (revision-1 creation is an explicit seed POST).
- **No clean-master re-renders per edit** (LokaClip's model). They cost server CPU on every
  layout change. Server frames and segments remain the fallback only.

---

## 13. Decisions needed from the owner

1. **Plate blur** replaces `gblur=sigma=35`: the same look at SSIM 0.993 [R3], 37% faster. Needs
   a side-by-side approval in Stage 0.
2. **yuv444p compositing:** +19–29% render time for text parity (max diff 93 → 15). Recommended
   yes.
3. **Native frame rate output** (29.97 stays 29.97) instead of forcing 30. Recommended yes.
4. **Node in the render worker path** (D1). Recommended yes, since the same image already does
   this.
5. **Browser policy:** Chrome/Edge desktop for Stage 1 GA.
6. **libass alignment:** accept the 0.17.1 (server) vs 0.17.4 (browser) skew under gates, or
   build our own FFmpeg image with a matching libass (about 1 pw plus ongoing maintenance).
7. **Music library source and licence** (curated CC0/royalty-free list vs a paid library).
8. **LGPL-in-WASM legal review** before GA.
9. **Reference laptop** for the PF budgets.

---

## Appendix A. Spike artifacts from this run (`editor-design/spike-pf/`)

| File | What it shows |
|---|---|
| `frame_identity.py` | Seeked `-copyts`+`fps`+`trim` range vs whole-file grid (framemd5). Result: 0/1,125 (CFR 29.97 and VFR), in the production image and locally |
| `naive_identity.py` | `render.py`-style float `-ss`: 558/1,125 and 350/1,125 mismatched |
| `t.ass`, `t.sh` | FFmpeg `ass` at 25 fps: an event at 32.12 s is hidden on frame 803 (YAVG 16) and shown from 804 (74.0) |
| `jprobe.mjs`, `www/t.html` | JASSUB 2.5.16 rounds mediaTime·1000 to the nearest ms (32119.4 hidden, 32119.5 shown) |
| `ass_time_rule.py` | Frame-safe centisecond rule: 0 failures over 3 h at 8 frame rates; 7,328 hazard frames at 30 fps |
| `graph.sh`, `anim.cmd`, `env.f32`, `sheet.png` | sendcmd crop pan, overlay move, scale resize, alpha, `enable=between(n,…)`, ASS on gbrp, `amultiply` envelope, all in FFmpeg 5.1.9. Envelope error 1.5e-5 after the implicit −3 dB upmix is accounted for |
| `ref_fmt.sh`, `ref_yuv420p/`, `ref_yuv444p/` | Text parity of JASSUB vs FFmpeg composited in yuv420p (SSIM ≥ 0.9970, max 93) and yuv444p (≥ 0.99925, max 15). Compare with `../lab/cmp.py` using the repo `.venv` Python |
| `rgbcost.sh`, `cost444.sh` | 30 s at 1080×1920 on `--cpus 4`: yuv420p 8.2–8.9 s, yuv444p 10.6 s, gbrp 12.3 s, rgb24 14.2 s |

Large media produced by the spikes were deleted. The scripts regenerate them: synthetic sources
come from `testsrc2`, and `src1080.mp4` is from `../lab/`.

## Appendix B. Libraries (npm or PyPI, checked 2026-09-24)

| Package | Version | Licence | Use |
|---|---|---|---|
| jassub | 2.5.16 | LGPL-2.1+ / FTL / MIT mix (the wrapper is MIT) | libass WASM (WASM unmodified; worker glue adapted) |
| mediabunny | 1.59.1 | MPL-2.0 | Demux and decode (unmodified) |
| harfbuzzjs | 1.6.2 | MIT | Shaping and metrics in edit-core |
| ajv | 8.20.0 | MIT | Standalone validator generation (build time) |
| immer | 11.1.18 | MIT | Patches and undo |
| zustand | 5.0.15 | MIT | UI store |
| idb-keyval | 6.3.0 | Apache-2.0 | Draft persistence |
| ssim.js | 3.5.0 | MIT | Sentinel |
| react-aria-components | 1.21.1 | Apache-2.0 | Accessible controls |
| @tanstack/react-virtual | 3.14.13 | MIT | Lane virtualisation |
| hls.js | 1.7.3 | Apache-2.0 | Server-segment fallback |
| twgl.js (optional) | 7.0.0 | MIT | WebGL helpers |
| Playwright | 1.62.1, with Chrome for Testing 147.0.7727.15 | Apache-2.0 | Golden harness |
| OpenCV `FaceDetectorYN` + YuNet model | OpenCV 4.x / OpenCV Zoo | Apache-2.0 / MIT (verify at adoption) | Camera plan (Stage 1c) |
| Fonts | see §3.5 | OFL-1.1 | Pack fonts |
| Noto Emoji PNG | current | Apache-2.0 | Emoji overlays |

## Appendix C. Mapping from existing code

| Existing | Fate |
|---|---|
| `edit_manifest.py` (canonical bytes, ETag, locks, atomic writes, archive) | Primitives move to `edit_v2/store.py`; the V1 schema stays read-only |
| `editor_api.py` (receipts, reconciliation) | Algorithm kept in `edit_v2/api.py`, with digest-only receipts and pruning |
| `render_queue.py`, `render_worker.py` | Generalised (§7.4); the fixed 120 s timeout is replaced |
| `render_manifest.py` (`_build_ass`, `_layout_filter`) | Retired after Stage 0c |
| `render.py`, `captions_ass.py`, `subtitles.py`, `face_tracking.build_crop_expression` | Semantics ported into edit-core (legacy packs, chunking, camera keys). `render_vertical()` becomes a wrapper. The modules are retired once P-RT is green |
| `face_tracking.detect_face_track` / `smooth_face_track` | Moved to analysis-time `camera_plan.py` |
| `candidate_cues.py`, `web/lib/caption-cues.mjs` | Dropped for V3 (words come from the transcript) |
| `web/lib/editor-timeline.mjs` ideas (10 Hz seeks, playhead outside React) | Carried into the new timeline |
| `preview-source` route (fd Range streaming) | Serves proxies and media instead of the raw upload |
| `llm.py`, `llm_selection` helpers, `hook_heuristics.py`, `audio_timeline.py`, `sound_events.py`, `sentences.py` | Consumed as they are (§8, §5.7) |
