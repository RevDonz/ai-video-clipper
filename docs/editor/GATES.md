# Editor V3 Esensial: quality gates

Owner: the wave integrator (plan `docs/plans/2026-09-24-editor-v3-esensial.md` §11.0). Every
number below comes from a JSON file in `docs/editor/evidence/W<n>/` (numbers only, no media).
A threshold is never weakened here; a gate that misses its number says so and names who decides.

## W1 "Mesin tunggal": exit gate (T1.Z, 2026-09-25)

Branch `editor-w1-integration`: T1.0 base `a2bd7b2`, then T1.1 → T1.5 → T1.2a → T1.2b → T1.4 →
T1.3 cherry-picked in that order (no conflicts), then the integration commits listed under
"Patches". Flags stay off (`POTONGIN_RENDER_ENGINE=legacy`, `POTONGIN_EDITOR_*=off`): nothing
changes for users in W1.

Toolchain of record: `ai-video-clipper:editor-w1`, built from this branch's `Dockerfile` with
the pins (base `node:20-bookworm-slim@sha256:2cf067cf…`, Debian snapshot `20260924T000000Z`,
FFmpeg 5.1.9, libass 0.17.1, freetype 2.12.1, harfbuzz 6.0.0, fribidi 1.0.8, fontconfig 2.14.1,
Python 3.11.2); `docker run --cpus 4`. Browser: Chrome for Testing 147.0.7727.15 (Playwright
1.62.1), JASSUB 2.5.16. Machine: the K15 reference PC (Ryzen 7 5700G, 16 threads), shared with
other agents while measuring (load averages are in the evidence files).

### Summary table

| Gate | Threshold | Measured (W1 exit, real modules) | Evidence | Result |
|---|---|---|---|---|
| pytest (Python 3.13.13) | green | 3,032 passed, 1 skipped (the opt-in PUT timing gate) | — | **pass** |
| pytest (Python 3.11.15) | green | 3,032 passed, 1 skipped (the opt-in PUT timing gate) | — | **pass** |
| ruff `src tests` | 0 findings | 0 | — | **pass** |
| `npm test` / `npm run build` | green | 457/457; build OK | — | **pass** |
| P-FRAME (server) | 0 mismatches, ≥ 2,000 frames | 0 / 2,290 final + 2,290 plate output + 2,990 plate cell frames (29.97 CFR, 25, 30, VFR; 20 cuts + cold open each) | `T1.Z-P-FRAME.json` | **pass** |
| P-FRAME in the chain | 0 mismatches | 0 / 9,495 reference frames of the synthetic job, 3 clips × 3 layouts (720 frames under the hook of the crop layouts not checked) | `T1.Z-chain.json` | **pass** |
| P-PLATE (server part) | plate SSIM ≥ final − 0.002; crop x 0 px | margins +0.00243 fit_blur, +0.00221 fill_center, +0.00227 camera; crop x 0 px on 710 frames × 3 streams, 514 distinct x values | `T1.Z-P-PLATE.json` | **pass** (after patch 3) |
| P-TIME, FFmpeg side | 0 mismatches | 0 / 570 events, 1,223 boundaries (247 hazard), 83 karaoke onsets, 24/25/30/24000/1001/30000/1001 | `T1.Z-P-TIME-ffmpeg.json` | **pass** |
| P-TIME, JASSUB side | 0 mismatches | 0 / 231 transitions (44 on hazard frames) | `T1.Z-P-TIME-jassub.json` | **pass** |
| P-TXT (gbrp, the shipped `build_ass_v2` bytes) | SSIM ≥ 0.999, PSNR ≥ 45 dB, max ≤ 16, 0 px > 16 | 120 frames: SSIM 0.999948, text SSIM 0.999489, PSNR 62.50 dB, max 14, 0 px > 16 | `T1.Z-P-TXT.json` | **pass** |
| P-COLOR (gbrp) | \|Δ\| ≤ 4 | worst mean 2.18 (yuv420p 23.81, yuv444p 23.17: BT.601 colours in FFmpeg 5.1.9's `ass`) | `T1.Z-P-COLOR.json` | **pass** |
| P-ENC baseline | baseline recorded; absolute whole ≥ 0.990, text ≥ 0.980 | baseline recorded (gbrp, 14 gated clips): whole 0.98660–0.98947, text 0.97455–0.98969 (5 clips below 0.980: bold-90, fallback, hook, karaoke-40, karaoke-90), luma ≥ 0.99650 | `T1.Z-P-ENC.json` | **baseline recorded; absolute thresholds FAIL** (owner decision, see "Open") |
| S-COLOR decided and applied | the cheapest candidate passing P-TXT, P-COLOR, P-ENC | rule: none passes (P-ENC fails all three); recommendation **gbrp** (only one passing P-TXT and P-COLOR), cost +12.4 % over yuv420p (9.04 s vs 8.05 s per 30 s, best of 5); applied in `compile_ffmpeg.COMPOSITE_FORMAT` | `T1.Z-S-COLOR.json` | **applied** (recommendation; P-ENC open) |
| Pack variants | recorded | Bold = Montserrat ExtraBold, Box = Montserrat + `BorderStyle 3`; both fallbacks also pass | `T1.Z-S-COLOR.json` | **pass** |
| P-AUD (server) | PCM md5 equal; samples == plan | reference ×2 == `audio_preview` = `db08a410…`; 722,321 == plan (through `compile_job`); per clip in the chain: 3/3 equal | `T1.Z-P-AUD.json`, `T1.Z-chain.json` | **pass** |
| G-CLICK | join step < −40 dBFS | max −80.77 dBFS over 4 joins; hard-cut control 4/4 detected | `T1.Z-G-CLICK.json` | **pass** |
| Duck | ducked = unducked − depth ± 0.5 dB; recovery ≤ 1 dB | max deviation 0.000 dB over 6 spans; 5 recovery checks 0.000 dB | `T1.Z-duck.json` | **pass** |
| G3 | −14 ± 1 LUFS, TP ≤ −1.0 dBTP | 3 normalized mixes: −14.0 / −14.1 / −14.0 LUFS, TP −10.3 / −7.3 / −5.9 dBTP | `T1.Z-G3.json` | **pass** |
| G3b | TP ≤ −1.0 dBTP with music or gain > 0 | 5 mixes: −7.3, −5.9, −2.1 (hot, mode off), −1.5 (speech +12 dB), −8.3 dBTP; square stress probe −2.1 (informational) | `T1.Z-G3b.json` | **pass** |
| G1/G2 | 6 synthetic renders pass | 6/6 (29.97, 25, 30, VFR, 1080×1920 23.976 with logo, no audio); chain: 9/9 | `T1.Z-G1-G2.json`, `T1.Z-chain.json` | **pass** |
| G-DET | identical plan, ASS, graph, envelope; preview ASS = export ASS | 0 digest differences over 3 processes (hash seeds 11, 4242); 0 ASS mismatches; final bytes and 13 plate cells identical across runs | `T1.Z-G-DET.json` | **pass** |
| QG-PERSIST (in process) | 5,000 saves, no lockout, receipts ≤ 200 | the soak test passes in the integrated suite on 3.13 and 3.11; T1.1's run: 0 failures, 200 receipts, save p95 19.2 ms | `T1.1-QG-PERSIST.json` | **pass** |
| Image builds with the pins | builds; toolchain.json present and in the render key | `docker build -t ai-video-clipper:editor-w1 .` OK; `/app/resources/toolchain.json` sha `4fefb754…`; the chain computes 9 render keys from it; same 319 packages at the same versions as `editor-ref` | `T1.Z-chain.json` | **pass** |
| Full chain (seed → plan → reference + final × 3 clips × 3 layouts → verify) | all checks | prepare via the api CLI 3/3 openable, every seed valid, 9/9 G1/G2, exact frame and sample counts, R10 seed-is-seed, render key with toolchain | `T1.Z-chain.json` | **pass** |
| PF-RENDER (report only) | p50 ≤ 0.4×, p95 ≤ 0.6× | synthetic 60 s, 1280×720 source, gbrp, real captions and hook: p50 0.201×, p95 0.343×; chain renders 0.161–0.300× | `T1.Z-PF-RENDER.json` | **within budget** (lower bound: synthetic source) |
| ASS goldens (T1.2a) | equal | `support.edit_v2_text goldens --check` exit 0 in `editor-w1` | — | **pass** |
| Missing-glyph probe (R6) | only DejaVu as fallback | 0 failures; fallback faces DejaVuSans, DejaVuSans-Bold | `T1.Z-glyph-probe.json` | **pass** |

The phase-B evidence (`T1.1-*` … `T1.5-*`) stays as each task measured it; the `T1.Z-*` files
are the same gates re-measured on the integrated branch, with the real modules and the pinned
image.

### Suites

- `uv run pytest` (Python 3.13.13, local FFmpeg 6.1.1): 3,032 passed, 1 skipped at the final commit.
- `uv run --python 3.11 --isolated --with-editable . --extra vision --with "pytest>=8,<9"
  pytest`: 3,032 passed, 1 skipped (the opt-in PUT timing gate, `POTONGIN_GATES=1`).
- `uv run ruff check src tests`: 0 findings. `npm test`: 457/457. `npm run build`: OK.
- `npm run test:parity` against fixtures made in `editor-w1`: 3/3.

## Patches by the integrator (logged per plan §11.0)

1. `tests/test_edit_v2_timemap.py` (T1.0): import block (ruff I001), requested by every phase-B
   task; the only ruff finding of the wave.
2. `edit_v2/compile_ffmpeg.py` (T1.3): `COMPOSITE_FORMAT = "gbrp"` (S-COLOR); the master stage
   comes from `audio_graph.master_filter` (`framelog=verbose` in `audio_measure`).
   `RENDER_SEMANTICS` stays 1: no render with semantics 1 existed before.
3. `edit_v2/compile_ffmpeg.py` (T1.3): plate cells take the final's colour path (`format=gbrp`
   round trip, no text, no logo). With gbrp the final clips the few YUV values outside the RGB
   gamut (bicubic overshoot); the plate did not, and P-PLATE failed in the image: plate SSIM
   0.98499 fill_center and 0.98566 camera against the final's 0.99941 / 0.99929. After the
   patch: margins +0.0022 to +0.0024 (table above).
4. `edit_v2/audio_graph.py` (T1.4): `pan` after `atrim` in each piece chain (T1.3's request).
   FFmpeg 6.1, 150 pieces over 108 s, `audio_preview`: pan first 2.47 GiB peak RSS and a
   `render_stalled` failure under `RLIMIT_AS`; pan after 100 MiB, 2.6 s.
5. `tests/test_edit_v2_compile.py`, `tests/test_edit_v2_audio_graph.py`, goldens (T1.3/T1.4):
   expectations follow patches 2–4; the composite goldens now cover yuv420p and yuv444p (gbrp is
   the default).
6. `scripts/parity/frame_identity.py` (T1.3): the gates run the real modules and pinned
   resources (`--harness` keeps the stand-ins; `--task` names the evidence file).
7. `tests/support/edit_v2_audio_harness.py` (T1.4): a `compiler` backend (`build_plan` +
   `compile_job` + `execute.run`) used for the gates of record; the unit tests keep the fast
   audio-only harness. T1.4's harness PCM md5 and the compiler's are identical (`db08a410…`).
8. `scripts/parity/reference_text.py`, `scripts/parity/s_color.py` (T1.2b): the gated P-TXT
   clips are the shipped `fit_cues` + `build_ass_v2` bytes; `evidence --task`.
9. `src/ai_clipper/face_tracking.py` (outside W1, T1.5's request): `detect_face_track(…,
   smooth=False)` returns raw centres so the camera plan reports `no_face` for today's detector
   (plan §5.7); default unchanged for the legacy render. `tests/test_edit_v2_camera.py`: the
   faceless synthetic window now reports `[[0, 4000]]`.
10. `docs/editor/CONTRACTS.md`: §5.8 (master stage, headroom, warning format, pan order), §5.9
    (api tables, asset metadata), §5.15 (W1 resolutions).

New integrator files: `src/ai_clipper/edit_v2/toolchain.py` (+ tests), `scripts/parity/w1_chain.py`,
`tests/test_edit_v2_integration.py` (+ `goldens/integration/`), the Dockerfile pins, the
compose/.env/CI changes and the W2 scaffolding (below).

## Phase-B requests

| From | Request | Decision |
|---|---|---|
| all | ruff I001 in `tests/test_edit_v2_timemap.py` | **applied** (patch 1) |
| T1.1 | copy the api per-op tables into CONTRACTS §5.9 | **applied** |
| T1.1 | pin the job asset-store metadata format for T3.1 | **applied** (CONTRACTS §5.9) |
| T1.1 | list `tight_cut`/`laughter_cut` for `removals_max_2000__c25` in the fixture index | **declined**: §5.11 allows extra warnings and `test_edit_v2_doc` tolerates exactly these two; regenerating T1.0's fixture set for it adds churn and no check |
| T1.1 | record the store's durability model | **applied** (below) |
| T1.2a | `COPY resources/` in the Dockerfile | **applied** |
| T1.2a | `ass=…:fontsdir=…:shaping=complex` and `FONTCONFIG_FILE` for the FFmpeg child only | **already in place** (T1.3's `execute.run` links `fonts` into the private directory and sets `FONTCONFIG_FILE`); confirmed by the glyph probe, P-TIME and the chain in `editor-w1` |
| T1.2a | record the T1.2a evidence | **applied** (table) |
| T1.2a | plan §11.1 "😂 is flagged for DejaVu" is wrong for DejaVu Sans 2.37 | **accepted as a documented deviation**: 😂 raises `glyph_unsupported` for the Montserrat packs and U+1F525 for the DejaVu packs (the frozen plan text is not edited) |
| T1.2a | the `\p` box fallback is ready | **noted**: not switched on; `BorderStyle 3` passes P-TXT on the shipped bytes |
| T1.2b | apply S-COLOR gbrp in R5 with named input matrices | **applied** (patch 2) |
| T1.2b | record the T1.2b gates; decide P-ENC | **recorded**; P-ENC goes to the owner (Open) |
| T1.2b | re-run the harness on `build_ass_v2` | **applied** (patch 8; P-TXT, P-TIME, P-COLOR, P-ENC and S-COLOR re-measured) |
| T1.2b | the manual `test:parity` CI job | **applied** (`.github/workflows/ci-cd.yml`, job `parity`, `workflow_dispatch` input `parity`) |
| T1.3 | `pan` after `atrim` | **applied** (patch 4, measured) |
| T1.3 | coarse pre-trim before `aresample` (or one label per run) for 1,000+ removals | **deferred to W4 (T4.3, performance)**: it changes the frozen §5.8 seam; T1.3 measured 80 s for a 97 s output at 1,000 removals (0.82×, over the p95 0.6× budget only at that extreme); no W1 gate needs it |
| T1.3 | set `COMPOSITE_FORMAT`, bump `RENDER_SEMANTICS` if pixels change, regenerate goldens | **applied**; semantics stays 1 (no earlier render) |
| T1.3 | `render_key` needs `toolchain.json`, fonts.json and pack files | **satisfied** by the image (`COPY resources/` + the toolchain step); the chain computes keys |
| T1.3 | record the graph-shape change | **applied** (CONTRACTS §5.15) |
| T1.3 | W2: set `RenderPlan.loudness_clamped_clufs` before `verify_output` | **handed to W2** (T2.1/T2.2) |
| T1.3 | `content_equals_seed` tests stop skipping | **confirmed**: they run and pass |
| T1.4 | approve `ENCODE_HEADROOM_CDB = 100` | **approved** (CONTRACTS §5.8); the plan §5.6 text is not edited, the contract records it |
| T1.4 | `compile_job` appends `master_filter` | **applied** (patch 2) |
| T1.4 | warning detail format in CONTRACTS | **applied** |
| T1.4 | accept `tests/support/edit_v2_audio_harness.py` | **accepted**, with the compiler backend (patch 7) |
| T1.4 | `[sa<i>]` untouched with `-copyts`; asset input options passed through | **confirmed** by G-CLICK and P-AUD through `compile_job` |
| T1.5 | `detect_face_track(smooth=False)` | **applied** (patch 9) |
| T1.5 | sequential decode in `detect_face_track` | **deferred to T3.6**: it changes which frames today's legacy face-track samples (a look change for existing renders, P-LOOK); not a W1 gate. The camera gate passes on synthetic media (real detector 9.19 s ≤ 15 s) |

## Store durability model (T1.1)

Every file is fsynced before its rename. The pending receipt, the archive and the new document
are fsynced concurrently while the document is validated, and nothing is renamed unless the
document is valid. The three directories are fsynced together after the document's rename,
before PUT returns. The rewrite of a receipt to `committed` is not fsynced. Trade-off: after a
power loss a surviving document can have lost its pending receipt; the retry then gets the
documented 409 rebase path. (V1 fsynced every receipt write and directory in sequence.)
`store.put` pauses Python's cyclic collector for the duration of a save (thread-safe counter;
the caller's collector state is restored). Nothing prunes `edit/archive/` in W1 (W4 janitor).

## W2 scaffolding (landed by T1.Z)

`web/lib/python-cli.mjs` (E11 env allowlist, fixed modules, bounded IO, process-group kill,
exit-code map), `web/lib/rate-limit.mjs` (plan 10/s, frame 4/s, upload 30/min per session hash;
AI 30/h per job), `web/components/editor/EditorApp.jsx` (skeleton with slots),
`panels/index.mjs` (Transkrip, Teks, Cold open) and `timeline/lanes.mjs` (Video, Teks, Hook)
with one placeholder per entry, `__dev__/fakes.mjs` (store, player, API and preview clients of
Appendix A.2) and `editor.module.css` (tokens only). Unit tests: `web/tests/python-cli.test.mjs`
(the env allowlist checked in a real child's `/proc/self/environ`), `rate-limit.test.mjs`,
`editor-scaffold.test.mjs`.

## Open (decisions and known limits)

1. **P-ENC absolute thresholds (owner or W5).** The delivered MP4 misses whole ≥ 0.990 and
   text ≥ 0.980 for every S-COLOR candidate, because the final 4:2:0 + x264 veryfast crf 21
   step is the same for all of them (luma ≥ 0.9965; the loss is chroma). The baseline is
   recorded for the relative gate (a drop > 0.002 fails). Options: accept the recorded baseline
   as the W1 gate, or change R7 (e.g. a negative x264 chroma QP offset, or crf 18) and re-measure.
   Not weakened here.
2. **S-COLOR by recommendation, not by the rule.** The plan's rule picks no candidate because
   of (1); gbrp is the only one that passes P-TXT and P-COLOR and is applied. Owner
   confirmation with (1).
3. **1,000+ removals** (T1.3): 80 s for a 97 s output (0.82×); 2,000 removals not measured;
   each removal ≥ 10 s opens another decoder run (~40 such could approach `RLIMIT_AS`). W4.
4. **Audio start time > 0** (T1.4): a source whose audio starts after t = 0 would shorten the
   first piece (`apad` pads only the end). Synthetic and typical MP4/AAC sources start at 0.
5. **Multichannel sources** (T1.4): 5.1 folds `FL+FC`/`FR+FC` and drops surround/LFE.
6. **Real-source camera timing** (T1.5): not recorded (real job media is not evidence
   material); one long-GOP 720p source measured over the 15 s budget until the sequential
   decode lands (T3.6).
7. **PF-RENDER** numbers use a synthetic source: a lower bound until W2's real clips.
