# Editor V3 Esensial: quality gates

Owner: the wave integrator (plan `docs/plans/2026-09-24-editor-v3-esensial.md` §11.0). Every
number below comes from a JSON file in `docs/editor/evidence/W<n>/` (numbers only, no media).
A threshold is never weakened here; a gate that misses its number says so and names who decides.

## W1 "Mesin tunggal": exit gate (T1.Z, 2026-09-25)

Branch `editor-w1-integration`: T1.0 base `a2bd7b2`, then T1.1 → T1.5 → T1.2a → T1.2b → T1.4 →
T1.3 cherry-picked in that order (no conflicts), then the integration commits listed under
"Patches" (1–10 at the first exit, `c20ceb5`; 11–19 after the W1 verifier, below). Flags stay off
(`POTONGIN_RENDER_ENGINE=legacy`, `POTONGIN_EDITOR_*=off`): nothing changes for users in W1.

Toolchain of record: `ai-video-clipper:editor-w1z`, built from this branch's `Dockerfile` after
the verifier fixes (base `node:20-bookworm-slim@sha256:2cf067cf…`, uv `0.11.6@sha256:b1e69936…`,
Debian snapshot `20260924T000000Z`, FFmpeg 5.1.9, libass 0.17.1, freetype 2.12.1, harfbuzz 6.0.0,
fribidi 1.0.8, fontconfig 2.14.1, Python 3.11.2); `/app/resources/toolchain.json` sha
`4fefb754…85f0`, unchanged from `editor-w1`; `docker run --cpus 4`. The gates ran on the image
built at `b7d034f`; the image was rebuilt at the final code commit (later code changes: a
spacing fix and the grid fallback of patch 11, whose source-info, seed, integration and execute
tests pass inside it, 120/120). Browser: Chrome for Testing
147.0.7727.15 (Playwright 1.62.1), JASSUB 2.5.16, on a private server at 127.0.0.1:3217. Machine:
the K15 reference PC (Ryzen 7 5700G, 16 threads), shared with other agents while measuring (load
averages are in the evidence files, 4–8 during these runs).

### W1 verifier findings and what changed (re-run 2026-09-25)

The verifier re-ran every gate at `c20ceb5` and reproduced all numbers, but found the exit gate
not met. Each finding, the fix, and the number after it:

| Finding (severity) | Fix | After |
|---|---|---|
| P-ENC fails its absolute thresholds for every S-COLOR candidate, so the R5 rule picks none (blocker) | R7 "Standar" is now `veryfast` **crf 18** with x264 **chroma-qp-offset −12**, and R5's 4:2:0 step computes chroma at full resolution with lanczos (patch 14). Thresholds unchanged. 4:2:0 alone caps whole-frame SSIM at 0.9911–0.9914 on the synthetic plate; the options measured are in `T1.Z-R7-options.json` | synthetic plate: whole 0.99017–0.99189, text 0.98768–0.99459 on the 14 gated clips; natural plate: whole ≥ 0.99704, text ≥ 0.99045. S-COLOR = **gbrp by the rule** (`cheapest_passing`) |
| A document that validates can fail G2 at the source edges: `sf_ceil(duration_ms)` is one frame past the last frame; a video starting at 0.041 s has no grid frame 0 (major) | `source.json` v2 records the grid that exists at every document rate, measured with the compiler's own decode; seeds clamp their edges and window to it; plate cells below the window keep their frame positions (patches 11–12) | P-FRAME and G2 on the source edges: 902-frame 29.97 source, body [0, 902): 855/855 frames; 23.976 video starting 41 ms late, body [1, 480): 480/480; 0 mismatches. One grid frame past the window is `outside_window` |
| Camera plan over budget on a real source: 16.35 s (AV1 720p) for a 3 min window, budget 15 s (major) | the camera plan decodes its window once (`detect_face_track(sequential=True)`); the legacy render keeps its per-sample seeks (patch 16) | real sources, image `--cpus 4`: 14.62 / 8.90 / 5.52 s (per-sample seeks 25.92 / 16.34 / 6.58 s); local: 7.44 / 5.41 / 3.12 s. **Pass**, with 0.38 s to spare on the AV1 source in the 4-CPU container (Open 6) |
| Revision-0 keys depend on the seed's wall-clock time (minor) | `base.seed_sha256` leaves out `audit` (patch 13) | two chain runs, seeds written at different times: 18/18 `plan_sha256` and render keys identical |
| Debian snapshot couples security updates to re-running the parity gates; uv pinned by tag (minor) | uv pinned by digest; snapshot-bump procedure below. Hashing only the six packages was **declined**: libx264, libavcodec, libswscale and dav1d are pinned only through the snapshot, so dropping it from the key would let an encoder change reuse old render keys | `test_every_image_the_build_pulls_is_pinned_by_digest` |
| Hostile-text property tests only with stand-ins (minor) | the same documents through the real caption track and audio fragment (patch 18) | 6 modes and 20 random documents: 0 leaks into argv or the graph |
| G5 checks only the text anchors, not the boxes (minor) | **not fixed** (Open 8) | — |
| Probes outside the compiler without the protocol whitelist (minor) | `source_info`, `peaks` and `compile_ffmpeg.probe_source` pass `-protocol_whitelist file,pipe` and an allowlisted env (patch 17) | `test_every_helper_that_opens_the_source_whitelists_file_and_pipe` |
| A toolchain test needs git (minor) | skips with a reason without git (patch 19) | image suite: 0 failures (below) |
| RLIMIT_AS set after FFmpeg starts; a missing fonts.conf is skipped silently (minor) | util-linux `prlimit` execs FFmpeg with the limit; a declared but missing fonts dir or fonts.conf is `render_failed` (patch 15) | `test_the_address_space_limit_is_set_before_ffmpeg_runs`, `test_a_declared_but_missing_fontconfig_file_fails` |

### Summary table

| Gate | Threshold | Measured (W1 exit after the verifier fixes, real modules, `editor-w1z`) | Evidence | Result |
|---|---|---|---|---|
| pytest (Python 3.13.13, FFmpeg 6.1.1) | green | 3,054 passed, 1 skipped (the opt-in PUT timing gate) | — | **pass** |
| pytest (Python 3.11.15) | green | 3,054 passed, 1 skipped (the opt-in PUT timing gate) | — | **pass** |
| pytest inside `editor-w1z` (Python 3.11.2, FFmpeg 5.1.9) | green | 3,051 passed, 3 skipped (the PUT timing gate; no C compiler for the `vf_subtitles` reference; no git), 0 failed (the verifier had 1 failure: git) | — | **pass** |
| ruff `src tests` | 0 findings | 0 | — | **pass** |
| `npm test` / `npm run build` | green | 457/457; build OK | — | **pass** |
| P-FRAME (server) | 0 mismatches, ≥ 2,000 frames | 0 / 3,625 final + 3,625 plate output + 4,371 plate cell frames: 29.97 CFR, 25, 30, VFR (20 cuts + cold open each) and the two source-edge cases (5 cuts each: body [0, 902) at 29.97; body [1, 480) plus a cold open for a 23.976 video starting 41 ms late) | `T1.Z-P-FRAME.json` | **pass** |
| P-FRAME in the chain | 0 mismatches | 0 / 9,495 reference frames of the synthetic job, 3 clips × 3 layouts (720 frames under the hook of the crop layouts not checked) | `T1.Z-chain.json` | **pass** |
| P-PLATE (server part) | plate SSIM ≥ final − 0.002; crop x 0 px | margins +0.00200 fit_blur, +0.00200 fill_center, +0.00199 camera (the final's SSIM rose with R7; plate − final = +0.000001 / −0.000003 / −0.000013); crop x 0 px on 710 frames × 3 streams, 514 distinct x values | `T1.Z-P-PLATE.json` | **pass** |
| P-TIME, FFmpeg side | 0 mismatches | 0 / 570 events, 1,223 boundaries (247 hazard), 83 karaoke onsets, 24/25/30/24000/1001/30000/1001 | `T1.Z-P-TIME-ffmpeg.json` | **pass** |
| P-TIME, JASSUB side | 0 mismatches | 0 / 231 transitions (44 on hazard frames) | `T1.Z-P-TIME-jassub.json` | **pass** |
| P-TXT (gbrp, the shipped `build_ass_v2` bytes) | SSIM ≥ 0.999, PSNR ≥ 45 dB, max ≤ 16, 0 px > 16 | 120 frames: SSIM 0.999948, text SSIM 0.999489, PSNR 62.50 dB, max 14, 0 px > 16 (before the 4:2:0 step, so R7 does not move it) | `T1.Z-P-TXT.json` | **pass** |
| P-COLOR (gbrp) | \|Δ\| ≤ 4 | worst mean 1.65 (yuv420p 22.63, yuv444p 22.50: BT.601 colours in FFmpeg 5.1.9's `ass`) | `T1.Z-P-COLOR.json` | **pass** |
| P-ENC | whole ≥ 0.990, text ≥ 0.980; baseline recorded (later drop > 0.002 fails) | gbrp, 14 gated clips: whole 0.99017–0.99189 (mean 0.99105), text 0.98768–0.99459 (mean 0.99049), lowest both on the hook clip; natural plate (supplementary): whole ≥ 0.99704, text ≥ 0.99045. These are the new baseline | `T1.Z-P-ENC.json`, `T1.Z-R7-options.json` | **pass** (after patch 14) |
| S-COLOR decided and applied | the cheapest candidate passing P-TXT, P-COLOR, P-ENC | rule `cheapest_passing` → **gbrp**; yuv420p fails P-TXT and P-COLOR, yuv444p fails P-TXT, P-COLOR and P-ENC; cost gbrp 11.85 s vs yuv420p 10.83 s per 30 s (+9.5 %, best of 5, load 4–8) | `T1.Z-S-COLOR.json` | **pass** (by the rule) |
| Pack variants | recorded | Bold = Montserrat ExtraBold, Box = Montserrat + `BorderStyle 3`; both fallbacks also pass | `T1.Z-S-COLOR.json` | **pass** |
| P-AUD (server) | PCM md5 equal; samples == plan | reference ×2 == `audio_preview` = `db08a410…`; 722,321 == plan (through `compile_job`); per clip in the chain: 3/3 equal | `T1.Z-P-AUD.json`, `T1.Z-chain.json` | **pass** |
| G-CLICK | join step < −40 dBFS | max −80.77 dBFS over 4 joins; hard-cut control 4/4 detected | `T1.Z-G-CLICK.json` | **pass** |
| Duck | ducked = unducked − depth ± 0.5 dB; recovery ≤ 1 dB | max deviation 0.000 dB over 6 spans; 5 recovery checks 0.000 dB | `T1.Z-duck.json` | **pass** |
| G3 | −14 ± 1 LUFS, TP ≤ −1.0 dBTP | 3 normalized mixes: −14.0 / −14.1 / −14.0 LUFS, TP −10.3 / −7.3 / −5.9 dBTP | `T1.Z-G3.json` | **pass** |
| G3b | TP ≤ −1.0 dBTP with music or gain > 0 | 5 mixes: −7.3, −5.9, −2.1 (hot, mode off), −1.5 (speech +12 dB), −8.3 dBTP; square stress probe −2.1 (informational) | `T1.Z-G3b.json` | **pass** |
| G1/G2 | 6 synthetic renders pass | 8/8 (29.97, 25, 30, VFR, the two source-edge cases, 1080×1920 23.976 with logo, no audio); chain: 9/9 | `T1.Z-G1-G2.json`, `T1.Z-chain.json` | **pass** |
| G-DET | identical plan, ASS, graph, envelope; preview ASS = export ASS | 0 digest differences over 3 processes (hash seeds 11, 4242), 8 cases; 0 ASS mismatches; final bytes and 13 plate cells identical across runs | `T1.Z-G-DET.json` | **pass** |
| R9 keys reproduce | same content → same keys | two chain runs, seeds prepared at different times: 18/18 `plan_sha256` and render keys equal | `T1.Z-chain-repro.json` | **pass** |
| QG-PERSIST (in process) | 5,000 saves, no lockout, receipts ≤ 200 | the soak test passes in the integrated suite on 3.13 and 3.11; T1.1's run: 0 failures, 200 receipts, save p95 19.2 ms | `T1.1-QG-PERSIST.json` | **pass** |
| Image builds with the pins | builds; toolchain.json present and in the render key | `docker build -t ai-video-clipper:editor-w1z .` OK; `/app/resources/toolchain.json` sha `4fefb754…`; the chain computes 9 render keys from it | `T1.Z-chain.json` | **pass** |
| Full chain (seed → plan → reference + final × 3 clips × 3 layouts → verify) | all checks | prepare via the api CLI (source.json v2 with the grid) 3/3 openable, every seed valid, 9/9 G1/G2, exact frame and sample counts, R10 seed-is-seed, render key with toolchain | `T1.Z-chain.json` | **pass** |
| T1.5 camera plan, real sources (3 min window) | ≤ 15 s | `--cpus 4` image: AV1 1280×720 23.976 14.62 s, AV1 1280×720 25 8.90 s, h264 640×360 60 5.52 s (per-sample seeks 25.92 / 16.34 / 6.58 s) | `T1.Z-camera-real.json` | **pass** (thin on AV1, Open 6) |
| PF-RENDER (report only) | p50 ≤ 0.4×, p95 ≤ 0.6× | synthetic 60 s, 1280×720 source, gbrp, R7 crf 18, real captions and hook: p50 0.206×, p95 0.347× (crf 21: 0.201× / 0.343×); chain renders 0.196–0.398× | `T1.Z-PF-RENDER.json`, `T1.Z-chain.json` | **within budget** (lower bound: synthetic source) |
| ASS goldens (T1.2a) | equal | `support.edit_v2_text goldens --check` exit 0 in `editor-w1z` | — | **pass** |
| Missing-glyph probe (R6) | only DejaVu as fallback | 0 failures; fallback faces DejaVuSans, DejaVuSans-Bold | `T1.Z-glyph-probe.json` | **pass** |

The phase-B evidence (`T1.1-*` … `T1.5-*`) stays as each task measured it; the `T1.Z-*` files
are the same gates re-measured on the integrated branch, with the real modules and the pinned
image (P-TIME, P-TXT, P-AUD, G-CLICK, duck, G3, G3b and the glyph probe re-ran in `editor-w1z`
with byte-identical results).

### Suites

- `uv run pytest` (Python 3.13.13, local FFmpeg 6.1.1): 3,054 passed, 1 skipped at the final
  code commit.
- `uv run --python 3.11 --isolated --with-editable . --extra vision --with "pytest>=8,<9"
  pytest` (Python 3.11.15): 3,054 passed, 1 skipped (the opt-in PUT timing gate,
  `POTONGIN_GATES=1`).
- Inside `editor-w1z` (Python 3.11.2, FFmpeg 5.1.9, pytest 8.4.2 in a scratch target on
  `PYTHONPATH`): 3,051 passed, 3 skipped (PUT timing gate, no C compiler, no git), run before
  the grid-fallback test was added; the image rebuilt at the final code commit passes the
  source-info, seed, integration and execute files 120/120.
- `uv run ruff check src tests`: 0 findings. `npm test`: 457/457. `npm run build`: OK.
- `npm run test:parity` against fixtures made in `editor-w1z`: 3/3.

### Snapshot bumps (security updates of the image)

The Debian snapshot freezes every apt package, security fixes included, and `apt_snapshot` is
part of `toolchain.json` (so of every render key). To take Debian security updates:

1. Bump `DEBIAN_SNAPSHOT` in the `Dockerfile` to a newer `snapshot.debian.org` timestamp. If a
   pinned rendering package has a newer version there, the build fails on the pin: update the pin
   in the same change.
2. Build the image and run `python -m ai_clipper.edit_v2.toolchain check` (the build does);
   compare `toolchain.json` and `dpkg-query -W` against the previous image.
3. Re-run P-TIME (both sides), P-TXT, P-ENC, P-COLOR and, from W2, P-RT in the new image before
   merge (plan §10). Every render key changes, which is intended: libx264, libavcodec,
   libswscale and dav1d are pinned only through the snapshot. Revision 0 stays the auto file by
   content identity (R10), so no user sees a different auto clip.
4. Log the bump here with the numbers. A bump that only changes packages outside the render path
   still re-keys renders; that cost is accepted over a key that could miss an encoder change.

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

After the W1 verifier (T1.Z re-run, 2026-09-25; each fix test-first):

11. `edit_v2/source_info.py`, `edit_v2/seed.py` (T1.5): `source.json` probe version 2 with
    `grid_sf` (the source-grid frames `[first_sf, end_sf)` at every document rate, measured with
    the compiler's own decode); seeds clamp body and cold-open edges to it and narrow
    `window_ms` to `[⌈first·1000·den/num⌉, ⌊end·1000·den/num⌋]` (`seed.grid_window_ms`); a
    version-1 file is refused; when the video ends more than 3 s before `duration_ms` (a
    container duration), the grid end is decoded from the start. Before: a 902-frame 29.97
    source seeded to its end rendered 150 of 151 planned frames (G2); a video starting at
    0.041 s lost frame 0 of the first piece. After: 855/855 and 480/480 frames in the image,
    P-FRAME 0 mismatches on both edges.
    `tests/support/edit_v2_media.py` (T1.0) can delay the video stream (`video_delay_ms`) and
    reads the whole-file grid range (`grid_range`).
12. `edit_v2/compile_ffmpeg.py` (T1.3): a plate cell starting below the window decodes from the
    window's first frame and repeats it (`tpad`) for the frames below, so frame `i` of cell `k`
    stays grid frame `k·C + i` (before: cell 0 of a late-starting video held grid frames 1–60
    and cell 1 only 59 frames).
13. `edit_v2/seed.py` (T1.5), `tests/support/edit_v2_fixtures.py` + regenerated document
    fixtures (T1.0): `base.seed_sha256` without `audit` (CONTRACTS §5.6). Before: 18 of 18 keys
    of identical content differed between two chain runs; after: 18 of 18 equal.
14. `edit_v2/compile_ffmpeg.py` (T1.3), `scripts/parity/{reference_text,s_color}.py` (T1.2b),
    goldens: R7 Standar = veryfast crf 18, `chroma-qp-offset=-12`; R5's 4:2:0 step with
    `flags=accurate_rnd+full_chroma_int+full_chroma_inp+lanczos`; the harness uses the
    compiler's strings. `RENDER_SEMANTICS` stays 1 (no render outside W1 tests). Cost: 2.5× the
    bytes of crf 21 on the natural plate, 3.4× on the synthetic one, same preset; PF-RENDER
    p50 0.201× → 0.206×.
15. `edit_v2/execute.py` (T1.3): `prlimit --as=<n>:<n> --` execs FFmpeg (RLIMIT_AS before the
    first instruction; no `preexec_fn` in a threaded worker); a declared but missing fonts
    directory or `fonts.conf` is `render_failed` before FFmpeg starts (G-FAIL). Tests and the
    P-FRAME `--harness` mode now run with the pinned resources.
16. `src/ai_clipper/face_tracking.py` (outside W1, as patch 9), `edit_v2/camera.py` (T1.5):
    `detect_face_track(…, sequential=True)` decodes the window once; the camera plan asks for
    it; the legacy default is unchanged (on a real AV1 source 1 of 240 samples lands one frame
    apart, so the legacy crop track must not switch without P-LOOK).
17. `edit_v2/peaks.py` (T1.5), `edit_v2/compile_ffmpeg.py` (T1.3), `edit_v2/source_info.py`:
    `-protocol_whitelist file,pipe` and `source_info.child_env()` for every probe and decode that
    opens the source by path.
18. `scripts/parity/frame_identity.py` (T1.3): the two source-edge cases in P-FRAME, G1/G2 and
    G-DET; `scripts/parity/camera_real.py` (new): the camera-plan budget on read-only real
    sources; `tests/test_edit_v2_integration.py`: hostile and random text through the real
    modules, R8 hygiene of the helpers, the rendered source-edge documents.
19. `Dockerfile`: uv pinned by digest; `tests/test_edit_v2_toolchain.py`: every pulled image
    pinned by digest, the git check skips without git.

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
| T1.2b | record the T1.2b gates; decide P-ENC | **recorded**; P-ENC fixed by the R7 change after the W1 verifier (patch 14); the owner confirms its cost (Open 1) |
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
| T1.5 | sequential decode in `detect_face_track` | **applied for the camera plan** after the W1 verifier (patch 16: `sequential=True`, real AV1 source 16.35 s → 7.44 s locally, 14.62 s in the 4-CPU image); the legacy render keeps its per-sample seeks (a look change there needs P-LOOK) |

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

1. **R7 cost (owner confirmation at checkpoint 2).** P-ENC now passes because Standar encodes
   at crf 18 with the chroma QP 12 below luma (patch 14): 2.5× the bytes of today's crf 21 on
   the natural plate and 3.4× on the saturated synthetic plate (`T1.Z-R7-options.json`), at the
   same preset and +2 % PF-RENDER. Flags are off, so nothing ships; K1 (the engine switch) would
   make the auto clips this size too. Cheaper options that were measured and fail the synthetic
   whole-frame threshold: crf 21 + chroma offset −12 (0.98929), crf 18 alone (0.98797),
   crf 19 + offset −12 + lanczos (0.98999). The margin at the chosen setting is +0.00017 whole
   frame on the hook clip; the 4:2:0 ceiling there is 0.9911–0.9914.
2. ~~S-COLOR by recommendation~~: **resolved**, gbrp by the rule after patch 14.
3. **1,000+ removals** (T1.3): 80 s for a 97 s output (0.82×); 2,000 removals not measured;
   each removal ≥ 10 s opens another decoder run (~40 such could approach `RLIMIT_AS`). W4.
4. **Audio start time > 0** (T1.4): a source whose audio starts after t = 0 would shorten the
   first piece (`apad` pads only the end). Synthetic and typical MP4/AAC sources start at 0. The
   video side of this is fixed (patch 11); the audio side is unchanged.
5. **Multichannel sources** (T1.4): 5.1 folds `FL+FC`/`FR+FC` and drops surround/LFE.
6. **Camera-plan margin in a 4-CPU container** (T1.5 → T3.6, and W2's PF-CELLS ≤ 25 s): the
   long-GOP AV1 720p source takes 14.62 s of the 15 s budget in `editor-w1z --cpus 4` (load 4–6):
   decode 2.2 s, Haar detection 10.8 s for 240 samples at 1280×720. Owner of the next step:
   T3.6 (detector) or the W2 integrator when PF-CELLS is measured (overlapping decode and
   detection, or a detector that is not Haar, which the plan keeps for Stage 2, §13).
7. **PF-RENDER** numbers use a synthetic source: a lower bound until W2's real clips.
8. **G5 boxes** (verifier minor, not fixed): `plan.unsafe_zone_issues` still checks only the
   caption block's bottom anchor, the hook's top and the logo box. The caption and hook boxes
   need the laid-out line widths (`captions_ass.fit_cues` has them) and the pack metrics; G5 only
   warns. Owner: W2 (T2.2, the verify step of the export path).
9. **Source opened by path outside FFmpeg**: `camera.build_camera_plan` reads the source through
   OpenCV's bundled FFmpeg, which takes no protocol whitelist (the path is the job's own
   `input/` file, never user text).
10. **P-PLATE margin**: with R7 at crf 18 the final's SSIM equals the plate's (+0.000001 to
    −0.000013); the gate keeps its 0.002 margin. A later change to the plate encode must keep
    the plate within it.

---

## W2 "Editor bisa dipakai": exit gate (T2.Z, 2026-09-25; re-exit T2.Z2, 2026-09-26)

Branch `editor-w2-integration`: the W2 base `44b4437`, then T2.1 → T2.2 → T2.3 → T2.5 → T2.4 →
T2.6 → T2.7 cherry-picked in that order (60 commits, no conflicts), then the integration commits
(`4c4fd67` onward: failing tests first, then each fix; patches 20–38 below). Flags stay off by
default: `POTONGIN_RENDER_ENGINE=legacy` (K1 pending), `POTONGIN_EDITOR_V3=off`,
`POTONGIN_EDITOR_UPLOADS=off`, `POTONGIN_EDITOR_LLM=off`; `compose.yaml` already passes
`POTONGIN_EDITOR_V3` (default `off`) to the app since W1, so it needs no change.

Toolchain of record: `ai-video-clipper:editor-w2`, built from this branch at `55629e6` (the last
code commit; later commits are evidence and documents): the W1 pins unchanged,
`/app/resources/toolchain.json` sha `4fefb754…85f0` (the same as `editor-w1z`, so every W1 render
key is still valid), FFmpeg 5.1.9, libass 0.17.1, Python 3.11.2, and the JASSUB worker glue and
wasm traced into the standalone build. Browser: Chrome for Testing 147.0.7727.15 (Playwright
1.62.1, build 1217) for every browser gate. Real jobs: copies of the owner's P3 jobs in scratch
`JOBS_ROOT`s (the originals were only read); the e2e ran against the image's app and render-worker
containers (`--cpus 6` and `4`) on 127.0.0.1:3481, the QG-SEC and browser-gate runs against a
production build of the branch on 127.0.0.1:3471. Machine: the K15 reference PC (Ryzen 7 5700G, 16
threads), shared with other agents; load averages are in the evidence files (2–8 during these
runs).

### W2 verifier findings and what changed (T2.Z2 re-exit, 2026-09-26)

The W2 verifier re-ran every gate at `1ba6d80` and found the exit gate not met (PF-AUDIO) plus
four majors and ten minors. The re-exit (`0ea1929` onward: failing tests first, then each fix)
addresses each one; the gates it touches were measured again on `ai-video-clipper:editor-w2r2`,
built at `e13c351` (later commits: evidence, this document and a docstring; `toolchain.json` sha
`4fefb754…85f0`, unchanged, so every render key stays valid), with copies of the owner's P3 jobs
in a scratch `JOBS_ROOT` (app `--cpus 6`, render worker `--cpus 4`, 127.0.0.1:3495), Chrome for
Testing 147.0.7727.15, on the K15 reference PC shared with other agents (loads in the evidence).
The table in the next subsection is the first exit's; where a gate was measured again, this
subsection supersedes it.

| Finding (severity) | Fix | After (evidence `T2.Z2-*`) | Result |
|---|---|---|---|
| **PF-AUDIO** (blocker): with music 2,245 ms p95, speech only 1,291 ms (verifier, load 4.7) | The source is decoded **once**: the pre-master mix streams into the ebur128 measurement, which keeps a copy, then only the master stage and the FLAC run (`execute.run_piped`, `compile_ffmpeg.premaster_jobs`/`master_job`; the loudness is `audio_measure`'s and the PCM the reference's, tested). The source probe is kept in `preview/probe.json`. The **persistent preview worker** (plan §10.3) runs every lane op in a forked child without the interpreter start-up | 90 s clip: **with music p95 914.5 ms** (p50 902, load 2.0); speech only 620.5 ms. With five busy CPU loops on the host (load 5.6): **with music 1,132.6 ms**, speech only 673.2 ms. Stage times (music, one run): decode+mix‖measure 463 ms, master+FLAC 170 ms, compile 72 ms (probe cached) | **pass** at the nominal load; **fail with music under heavy load** (Open 22). Speech only (all W2 documents: music arrives in W3) passes at every measured load |
| **Export dialog revision** (major): "Revisi 0" after edits | The dialog shows the store's saved revision (`shell-model.exportRevision`); the fakes' scenario store keeps revisions as the real store does | Fakes spec: "Revisi 1 · tersimpan" after the autosave; real stack: after every export the dialog names `render.revision` and the store agrees (`T2.Z2-e2e-flow.json`) | **fixed** |
| **PF-PIPELINE** (major): reported as a layout aggregate that hid 1.48×/1.51× jobs | `look_report.py evidence` passes a layout only when every job of it passes, and reports each job with its source rate; re-measured (legacy then new engine, interleaved per job, 20 clips) | fit-blur 24 fps **1.68×**, 25 fps **1.41×**, 60 fps 0.89× (budget 1.35×); center-crop **1.79×** (1.35×); face-track **2.06×** (1.6×) | **fail**: blocks K1; T4.3 before the flip (Open 14) |
| **PF-PLAN server** (major): 218 ms p95 | The persistent preview worker | HTTP p95 **33.7 ms** (load 1.8), 34.7 ms with five busy CPUs (load 6.0); a fresh CLI process alone is 115–171 ms p95 | **pass** |
| **P-LOOK** (major): thresholds fail on 20/20; Open 11 deferred | **Open 11 fixed** (`subtitles.build_frame_cues`: inside a piece the word gap is measured in source ms, like the legacy cues; property test: identical grouping at all five document rates); P-LOOK re-rendered and re-measured; kit and owner pack regenerated with the R7 cost | Caption cues **894/894** with the legacy words (was 889); caption/hook boxes **19/20** clips at 0 px (one 60 fps clip 89 px: a zero-length word exactly at the cold-open end is shown because segment edges snap to frames); loudness 20/20 within 0.1 LU; SSIM ≥ 0.98 per frame **0/20** (13,257 of 29,767 frames; mean 0.963; deliberate: fit-blur row, face-track camera, R7, 60/VFR → 30); size **2.27×** | thresholds **fail** → owner (K1); P-RT re-run below passes |
| PF-OPEN method (minor) | The spec's first visit is a never-opened clip, fresh context, until the first presented frame | VFR job, 5 cold clips: p50 1,775, **p95 2,428 ms**; face-track job, 6 cold clips: p95 2,494 ms (load 6.2); repeat 925 ms; first cell after prepare 736 ms | **pass** |
| P-AUD VFR −8 samples (minor) | — | unchanged | open (Open 12, with W1 Open 4) |
| E11 in the older helpers (minor) | `render-requests` (both spawns), `edit-document`, `candidates`, `caption-cues`, `candidate-feedback` pass `childEnv`; `MAX_UPLOAD_BYTES` joins the allowlist (not a secret; `render_queue` reads it) | `web/tests/legacy-spawn-env.test.mjs`; child-env audit (lane gates + e2e): **1,388** app children (733 preview worker incl. its forks, 179 api, 417 ffmpeg, 31 prlimit, 21 ffprobe, 6 render_queue, 1 preview_cli), 0 names outside the allowlist, **0 of 6 planted secrets** | **fixed** |
| Job-level prepare (minor) | One run per job for concurrent requests, one job at a time, `PREPARE_RATE` (3, then one per 20 s; 429), `prepare_job` at nice 5; the project page shows one job-level action with "Menyiapkan analisis klip (kata, waveform, wajah)… N d" | `clip-edit.test.mjs`, `test_edit_v2_api.py`, fakes spec | **fixed** (the lane's semaphore is not shared: Open 23) |
| Badge help (minor) | `shell-model.badgeHelp`: the §6.1 text for the exact badge only | unit + fakes spec | **fixed** |
| Truth-frame threads (minor) | The `frame` op runs at the lane's two threads | PNG byte-identical to the four-thread compile (test, FFmpeg 6.1 and 5.1.9); PF-TRUTH p95 **292.8 ms** | **fixed** |
| Fakes in production (minor) | `POTONGIN_EDITOR_FAKES` documented as a CI/development switch (CONTRACTS §5.18: the specs run it on `next start`; compose never passes it; the fake runtime makes no API call); the read-only inspect hook stays | — | **documented** |
| Thin margins (minor) | Re-measured with the worker | PF-CELLS fit-blur 60 fps **11.62 s** (15), center-crop 7.71 s, face-track 14.10 s with the camera plan (25), 6.77 s without; PF-TRUTH 292.8 ms (600) | **pass** |
| Owner beta UX (minor) | W3 panels and lanes hidden in the app (`LIVE_WAVES`; the fakes show them); a cancelled or failed export keeps the step it reached (`stopped`); the running export is not an earlier one | fakes spec; real stack: tabs Transkrip/Teks/Cold open, 3 lanes | **fixed** |
| R10 rule for legacy clips (minor) | Recorded for the owner (checkpoint 2) | — | owner |

Also re-run on the final image: **P-RT** on the 20 re-rendered clips: video, PCM, bytes and SRT
identical 20/20 (29,807 frames; revision 0 re-rendered in another container on CPUs 8–11); R10
**60/60** hard links (seed, undone edit, changed toolchain) (`T2.Z2-P-RT.json`). **P-AUD**
(server, through the worker and the single-decode path): 6/6 md5 equal, samples = plan,
including the measured music case (`T2.Z2-P-AUD.json`). **e2e flow** on the VFR center-crop job
(990f3f37): every step, the edited export (16.2 s render for a 62.3 s clip) passes G1 and G2 on
the download (G5 warns), R10 same inode; **QG-CONFLICT** two-tab e2e pass; **U1** 2.86 s, **U2**
2.92 s, **U3** 2.91 s, **U6** 19.9 s for an 81.3 s clip (limit 111.3 s), **U7** 0 lost, reset
found in 1.9 s; **QG-A11Y** 8 states, 0 violations of any impact. The browser parity gates
(P-FRAME, P-TIME, P-TXT, P-LOGO, browser P-AUD, P-SYNC, PF-PLAY/SEEK/LIBASS/MEM) were not run
again: the player, the text layer and the compiler's video path are unchanged; the server's
cells are the same compile; the preview FLAC's PCM is proven equal to the reference; the Open 11
change only regroups cues, which both renderers draw from the same ASS.

**W2 exit verdict (re-exit).** Met except: (1) **PF-AUDIO with music under heavy load** (1.13 s
p95 at load 5.6; 0.91 s at load 2.0; music is a W3 feature, and every W2 document passes at every
measured load), (2) **PF-PIPELINE** (1.41–2.06× on four of five jobs; blocks K1 only, the engine
flag stays `legacy`), (3) **P-LOOK's measured thresholds** (SSIM by design; one 89 px probe).
These need the owner at checkpoint 2 (K1, R7 file size, the PF-PIPELINE condition, the R10
legacy rule, and whether PF-AUDIO-with-music-under-load goes to W5/T3.3/T4.3); none changes what
users see while the flags stay off.

#### Suites at the re-exit commit

- `uv run pytest` (Python 3.13.13, FFmpeg 6.1.1): 3,304 passed, 2 skipped (the opt-in PUT timing gate; the pack-thumbnail reproduction, toolchain-only).
- `uv run --python 3.11 --isolated --with-editable . --extra vision --with "pytest>=8,<9"
  pytest` (Python 3.11.15): 3,304 passed, 2 skipped (the same two).
- Inside `editor-w2r2` (Python 3.11.2, FFmpeg 5.1.9, `--cpus 4`, the W1 scratch pytest target on
  `PYTHONPATH`): 3,303 passed, 3 skipped (the PUT timing gate; no C compiler for the `vf_subtitles` reference; no git metadata in the container), 0 failed.
- `uv run ruff check src tests`: 0 findings. `npm test`: 845/845. `npm run build`: OK (the same 13 Turbopack warnings as the first exit, all in routes that predate W2).
- Browser specs (Chrome for Testing 147.0.7727.15): `e2e/editor-shell.spec.mjs` +
  `e2e/editor-transcript.spec.mjs` on the fakes (`next start`, `EDITOR_GATES=1`, axe) 51 passed,
  1 skipped (the optional real-clip budget); `e2e/editor-flow.spec.mjs` 10/10 against the image
  stack (PF-OPEN run first so its clips were cold).
- `docker build -t ai-video-clipper:editor-w2r2 .`: OK; `toolchain.json` sha `4fefb754…`; the
  JASSUB worker files present.

#### Patches by the W2 integrator (re-exit; numbering continues)

39. `src/ai_clipper/edit_v2/execute.py` (T1.3): `run_piped` and pipe inputs/outputs; `run`'s
    frozen signature kept (a private `_run`). Tests: `tests/test_edit_v2_execute.py`.
40. `src/ai_clipper/edit_v2/compile_ffmpeg.py` (T1.3): `_master_chain` (one master-stage text),
    `premaster_jobs`, `master_job`, `PREMASTER_INPUT`; probe seeding (`source_identity`,
    `seed_probe`, `streams_to_json/from_json`, `clear_probe_cache`). `MODES` unchanged.
41. `src/ai_clipper/edit_v2/preview_cli.py` (T2.3): the single-decode measured mix,
    `preview/probe.json`, the truth frame at two threads. Tests:
    `tests/test_edit_v2_preview_cli.py`.
42. New `src/ai_clipper/edit_v2/preview_server.py` (+ `tests/test_edit_v2_preview_server.py`);
    `web/lib/python-cli.mjs` `createPythonServer`, `PYTHON_SERVER_MODULES`
    (+ `web/tests/python-server.test.mjs`); `web/lib/preview-lane.mjs` `previewCliRunner`,
    `POTONGIN_PREVIEW_SERVER` (server-only kill switch).
43. `src/ai_clipper/subtitles.py` (T1.2a): Open 11 (+ `tests/test_subtitles.py`).
44. `web/lib/clip-edit.mjs` `createPrepareGate`/`PREPARE_RATE`; `src/ai_clipper/edit_v2/api.py`
    `NICE` for `prepare_job`; `web/app/projects/[id]/page.jsx` the job-level prepare.
45. `web/lib/python-cli.mjs` allowlist + `render-requests`, `edit-document`, `candidates`,
    `caption-cues`, `candidate-feedback` (`childEnv`); `web/tests/python-cli.test.mjs`
    expectation (+ `web/tests/legacy-spawn-env.test.mjs`).
46. Editor UI (T2.6): `shell-model.mjs` (`exportRevision`, `badgeHelp`, `LIVE_WAVES`,
    `liveEntries`), `export-flow.mjs` (`lastRunning`, `stopped`, `earlierExports`),
    `ExportDialog.jsx`, `StageBadge.jsx`, `EditorApp.jsx`, `timeline/Timeline.jsx` (`lanes`),
    `shell.module.css`; `web/e2e/editor-shell.spec.mjs` (the scenario store keeps revisions as the
    real store does; the U1 predicate reads the saved revision accordingly).
47. Gate tools: `scripts/parity/look_report.py` (per-job PF-PIPELINE pass, `LOOK_TASK`, kit
    text), `scripts/parity/preview_lane_gates.py` (the mix cache cleared before PF-AUDIO, the
    single-decode stage breakdown, `LANE_GATES_TASK`), `web/e2e/editor-flow.spec.mjs` (the
    dialog's revision, W3 hidden, strict cold PF-OPEN). `docs/editor/CONTRACTS.md` §5.18.

#### Open (re-exit updates)

- Open 11 is **closed** (fixed; P-LOOK and P-RT re-run).
- Open 14 is updated: PF-PLAN is met (worker); PF-AUDIO see 22; PF-PIPELINE per job 1.41–2.06×
  (causes, T2.1's diagnosis: R7 crf 18 + chroma offset, the `gbrp` composite and scale flags;
  then verify's full decode, peaks and the camera plan per clip; T4.3 candidates: overlap a clip's
  verify, peaks and camera plan with the next clip's render, reuse per-job decodes). `probe_source`
  is cached on disk for the lane.
- Open 20 is updated: the face-track prepare still takes ~50 s for 8 clips, now niced, gated and
  shown once per job with a seconds counter (no per-clip progress yet: T4.5).
- 22. **PF-AUDIO with music under heavy load**: 1,132.6 ms p95 at load 5.6 (914.5 ms at 2.0). The
  long pole is decode+mix (~460 ms) running beside the measurement, then the master+FLAC pass
  (~170 ms). Measured and rejected: splitting speech and music into two producers (−30 ms, the
  measurement becomes the pole). Left: splitting the true-peak measurement per channel with the
  split producers, caching a clip's decoded runs (exactness to be proven for Opus pre-roll). T3.3
  (music) or T4.3; owner at checkpoint 2.
- 23. **Two heavy semaphores**: job-level prepares have their own gate (1 at a time, nice 5) beside
  the lane's two heavy slots (a different CLI module); T4.3 may merge them.
- 24. **P-LOOK's last caption probe**: a zero-length word exactly at the cold-open end is shown by
  the new engine (segment edges snap to the frame grid) and not by the legacy engine (half-open
  range in seconds); one probe of one clip, 89 px. Owner (K1).
- 25. **Preview worker**: the server forks from a process without threads; a hung child is stopped
  by its caller's timeout (SIGTERM to its group, SIGKILL after 2 s) as a spawned CLI was; the
  server restarts after a crash with a 5 s back-off, spawning CLIs meanwhile.
  `POTONGIN_PREVIEW_SERVER=off` returns to spawning.

### Summary table

The first exit, at `1ba6d80`; the re-exit subsection above supersedes a row where a gate was
measured again.

| Gate | Threshold | Measured (W2 exit, integrated branch) | Evidence | Result |
|---|---|---|---|---|
| pytest (Python 3.13.13, FFmpeg 6.1.1) | green | 3,283 passed, 2 skipped (the opt-in PUT timing gate; the pack-thumbnail reproduction, toolchain-only) | — | **pass** |
| pytest (Python 3.11.15) | green | 3,283 passed, 2 skipped (the same two) | — | **pass** |
| pytest inside `editor-w2` (Python 3.11.2, FFmpeg 5.1.9) | green | 3,282 passed, 3 skipped (the PUT timing gate; no C compiler for the `vf_subtitles` reference; no git metadata in the container), 0 failed | — | **pass** |
| ruff `src tests` | 0 findings | 0 | — | **pass** |
| `npm test` / `npm run build` | green | 828/828 (T2.2's child-env test of the render-queue routes runs now that patch 20 landed); build OK (13 Turbopack warnings, all in routes that predate W2) | — | **pass** |
| `docker build -t ai-video-clipper:editor-w2 .` | builds | OK at `55629e6`; `toolchain.json` sha `4fefb754…`; `/app/node_modules/jassub/dist/wasm/jassub-worker.{js,wasm}` present | — | **pass** |
| **W1 gates still green** (re-run in `editor-w2` after the R2 fix, patch 34) | as W1 | P-FRAME (server) 0 mismatches: 3,625 final + 3,625 plate output + 4,371 plate-cell frames (6 cases); P-PLATE margins +0.00200 / +0.00200 / +0.00199, crop x 0 px on 710 frames × 3 streams (514 distinct x); G1/G2 8/8; G-DET 0 digest differences over 8 cases and 3 processes, 0 preview/export ASS mismatches; PF-RENDER p50 0.171×, p95 0.299× (report). P-TIME, P-TXT, P-COLOR, P-ENC, P-AUD (server), G-CLICK, duck, G3, G3b: their code is unchanged since W1 (text, audio graph, encode); their unit tests are in the suites above and T2.4 re-ran P-TXT/P-TIME on the changed text adapter with W1's numbers | `T2.Z-P-FRAME-server.json`, `T2.Z-P-PLATE-server.json`, `T2.Z-G1-G2.json`, `T2.Z-G-DET.json`, `T2.Z-PF-RENDER.json`, `T2.4-W1-TEXT-RECHECK.json` | **pass** |
| **e2e flow** (open → trim → delete words → fix a word → switch pack → edit the hook → change the cold open → undo/redo → reload → export → download → G1–G3 → back to the AI version → export → R10) | every step; G1–G3 on the file; R10 = the auto file | image stack, a real 48.8 s legacy-engine clip: every step passes; the edited export renders in 22.1 s and passes G1 and G2 on the downloaded file (G3 applies only to `normalize` documents; this seed is `off`; G5 warns `unsafe_zone`); the AI version exports the auto file itself (same inode, bytes equal, `completedBy: seed`, 200 at create) | `T2.Z-e2e-flow.json` | **pass** |
| Open any V3 clip | every real clip opens | 32/32 real clips of the five P3 jobs (fit-blur, center-crop, face-track; 30, 25, 24000/1001 fps) open and show a frame; first open p50 2.4 s, max 3.4 s (cells built on demand); 0 page errors | `T2.Z-open-all-clips.json` | **pass** |
| P-RT (incl. R10) | framemd5 + PCM md5 identical; R10 100 % | T2.1: 26/26 revision-0 re-renders identical in video, PCM and bytes (6 synthetic incl. cold open and face-track, 20 real, 32,620 frames); R10 147/147 by inode. T2.Z: R10 through the UI on a real clip (row above) | `T2.1-P-RT.json`, `T2.Z-e2e-flow.json` | **pass** |
| P-FRAME (browser) | 0 mismatches, ≥ 2,000 frames | 0 / 3,625 frames (6 barcode cases: 29.97, 25, 30, VFR, two source edges; 20 cuts + cold open); crop x 0 / 1,925 | `T2.Z-P-FRAME.json` (T2.4's `T2.4-P-FRAME.json`) | **pass** |
| P-TIME (browser) | 0 mismatches | 0 / 231 transitions (44 on hazard frames); the one-frame-late control flags 231/231 | `T2.Z-P-TIME.json` | **pass** |
| P-TXT (browser) | SSIM ≥ 0.999, PSNR ≥ 45 dB, max ≤ 16, 0 px > 16 | 48 frames (4 packs, logo, fallback glyph): worst SSIM 0.99988, text 0.99986, PSNR 60.57 dB, max 13, 0 px > 16 | `T2.Z-P-TXT.json` | **pass** |
| P-LOGO (fixture asset) | box 0 px; mean ≤ 2; max ≤ 8 | 8 frames: box exact, mean 1.20, max 2 | `T2.Z-P-LOGO.json` | **pass** |
| P-AUD | server md5 equal, samples = plan; browser ≤ 1 LSB, same count | server (T2.3, through the lane): 6/6 real cases md5 equal, samples = plan; browser: 6 mixes, 48 kHz, max 0.707 LSB against x/32768 (0 samples differ under Chrome's int16 scaling), sample count = the reference PCM. The VFR barcode source's mix is 8 samples short of `plan.samples` on both sides (Open 12) | `T2.3-P-AUD.json`, `T2.Z-P-AUD.json` | **pass** (VFR note) |
| P-SYNC | ≤ 1 frame p99 | 4 clips (21 joins each), 2,286 frames, 0 pixel mismatches, p99 0.34–0.36 frames | `T2.Z-P-SYNC.json` | **pass** |
| P-PLATE (through the lane) | plate SSIM ≥ final − 0.002; crop x 0 px | T2.3: crop x 0 mismatches on 924 frames per layout; margins 0.00196 / 0.00198 / 0.00200 synthetic, 0.00143 / 0.00148 / 0.00092 real | `T2.3-P-PLATE.json` | **pass** |
| P-LOOK kit delivered (K1) | kit + owner approval | 20 real clips (60 fps × 5, VFR × 4, face-track × 5, fit-blur 24/25 fps × 6), 20 sheets, 3 MP4 pairs, `index.md` in the scratchpad (`editor-w2/p-look/`). Its thresholds are **not met**: SSIM ≥ 0.98 per frame on 0/20 clips (13,394 of 29,767 frames below; mean of the per-frame best 0.963; min 0.443 face-track); caption/hook boxes 0 px on 17/20 clips (3 probes off 40, 89, 229 px; hook 0 px 20/20); loudness 20/20 within 0.1 LU. The causes are deliberate (fit-blur row rounding, the face-track camera plan, R7, 60/VFR → 30 fps) plus the cue grouping of Open 11 | `T2.1-P-LOOK.json` | **kit delivered**; thresholds **fail** → owner (K1) |
| PF-PIPELINE (T2.1) | fit-blur, center-crop ≤ 1.35×; face-track ≤ 1.6× | fit-blur 1.206× overall (1.48× and 1.51× on the 23.976 and 25 fps jobs, 0.99× on 60 fps); center-crop 2.51×; face-track 2.16× | `T2.1-PF-PIPELINE.json` | **fail** (center-crop, face-track) |
| PF-OPEN | first ≤ 3.0 s p95, repeat ≤ 2.0 s p95; first playhead cell ≤ 2.0 s after `prepare` | image stack, a real clip, 10 runs at 1366×768: first p95 932 ms, repeat p95 873 ms (frame on the stage p95 878 ms); first playhead cell 1,034 ms after `prepare` on a clip with no cells | `T2.Z-PF-OPEN.json` | **pass** |
| PF-SEEK | ≤ 50 ms p95 | 360 cold paused seeks: p50 24.0 ms, p95 38.6 ms, max 54.6 ms (T2.4: 71–91 ms p95 at load 14–23, Open 13) | `T2.Z-PF-SEEK.json` | **pass** (at the measured load) |
| PF-PLAY | 0 drops at cuts; ≤ 1 per 10 s | 0 drops, 0 at cuts, 4 clips (plain and instrumented) | `T2.Z-PF-PLAY.json` | **pass** |
| PF-PLAN (server part) | ≤ 200 ms p95 warm | image, 120 distinct documents per run: p95 226.0 ms at load 3.98, 180.6 ms at load 2.85 (T2.3: 196.4 ms at 4.5); Python start-up per request is the cost | `T2.Z-PF-PLAN.json`, `T2.3-PF-PLAN.json` | **fail** at load ≥ 4 (pass at 2.9) |
| PF-AUDIO | ≤ 1.0 s p95 (90 s clip with music) | image: with music p95 1,911 ms, speech only 959 ms (T2.3: 2,086 / 929 ms); two full decodes (the ebur128 measurement 892 ms, the preview FLAC 664 ms) | `T2.Z-PF-AUDIO.json` | **fail** (music) |
| PF-CELLS | ≤ 15 s (fit-blur, center-crop), ≤ 25 s (face-track) | T2.3: fit-blur 60 fps 13.38 s, center-crop VFR 9.12 s, face-track 16.01 s with the camera plan (8.09 s with it); 16.75 s for fit-blur at load ~12 | `T2.3-PF-CELLS.json` | **pass** (thin under load) |
| PF-TRUTH | ≤ 0.6 s p95 | image, 36 frames over 3 layouts: p95 499.5 ms (T2.3: 669 ms before patch 35) | `T2.Z-PF-TRUTH.json` | **pass** |
| PF-SAVE | PUT ≤ 300 ms p95 | image, 1,000 sequential PUTs of a real clip: p50 124.4 ms, p95 137.9 ms, 0 failures (T2.2: 390.8 ms p95 before patch 30, at load 11–20) | `T2.Z-PF-SAVE.json`, `T2.2-PF-SAVE.json` | **pass** |
| PF-LIBASS | ≤ 12 ms p95 per changed frame | Bold, 450 changed frames: p50 3.7 ms, p95 6.3 ms (libass alone 0.4 ms); 159 unchanged reused | `T2.Z-PF-LIBASS.json` | **pass** |
| PF-MEM | ≤ 1.2 GB (300 s clip) | peak 1.070 GB PSS | `T2.Z-PF-MEM.json` | **pass** |
| Truth frames and the revision-0 `<video>` | exact | truth frames max diff 0; the fallback shows the right source frame 12/12 | `T2.Z-REV0-TRUTH.json` | **pass** |
| QG-UNDO | 10,000 sequences; 1,000 cross-checked | T2.5: 10,000 sequences, 134,398 commands, 0 mismatches (undo-all, redo-all, stepwise); 1,000 sequences = 23,258 documents accepted by the Python validator (3.13 and the image's 3.11.2) | `T2.5-QG-UNDO.json`, `T2.5-crosscheck.json` | **pass** |
| QG-CONFLICT | both edits survive or the dialog asks; no draft lost | unit (T2.5): 10,000 rebase scenarios and 500 two-tab store runs, 0 problems; **two-tab e2e** (image): different parts (hook in A, a caption word in B) merge, both on the server; the same part asks per part, "Pakai punyaku" wins and B's other edit stays | `T2.5-QG-CONFLICT.json`, `T2.Z-QG-CONFLICT-e2e.json` | **pass** |
| QG-PERSIST (HTTP) | 5,000 saves, no lockout, receipts ≤ 200, reload ≤ 2 s lost | T2.2: 5,000/5,000 saves, 0 lockouts, 200 receipt files, 20/20 replays same etag, stale If-Match 409; T2.5: the draft is durable 3.6 ms p95 after each command, 0 commands lost on reload; U7 below | `T2.2-QG-PERSIST-http.json`, `T2.5-draft.json` | **pass** |
| QG-SEC (routes + child env) | CSRF/auth/id matrix on every mutation; editor headers; no secret in any child | T2.Z, every new route (T2.2 and T2.3): 47/47 checks (anonymous 401; foreign Origin, cross-site `Sec-Fetch-Site` and missing Origin 403 on every mutation; malformed or unknown ids 4xx); editor page COOP, COEP, nosniff, `frame-ancestors 'none'` 4/4 and `crossOriginIsolated` true; 57 Python children of the flow and conflict e2e (30 api, 19 preview_cli, 8 render_queue): 0 names outside the allowlist, 0 of 6 planted secret canaries. T2.2: 33/33 and 5,095 children | `T2.Z-QG-SEC.json`, `T2.2-QG-SEC.json` | **pass** |
| QG-A11Y | axe: no critical/serious; all by keyboard | real editor (image): 8 states (ready, export dialog, text and cold-open panels at 1366×768 and 1920×1080), 0 critical, 0 serious (1 moderate `heading-order` on the cold-open panel at both sizes); T2.6 on the fakes: 16 states 0 violations, 19 controls reached by keyboard | `T2.Z-QG-A11Y.json`, `T2.6-QG-A11Y.json` | **pass** |
| QG-UX U1 (scripted) | ≤ 20 s | 2.87 s (reload, "Perpanjang ke sini" on the clipped word, saved) | `T2.Z-QG-UX-U1.json` | **pass** |
| QG-UX U2 (scripted) | ≤ 20 s | 2.91 s (14 words, 5.28 s removed via the transcript, saved) | `T2.Z-QG-UX-U2.json` | **pass** |
| QG-UX U3 (scripted) | ≤ 45 s | 2.91 s (a 2.08 s cold open from the transcript, saved) | `T2.Z-QG-UX-U3.json` | **pass** |
| QG-UX U6 (scripted, real render) | ≤ clip length + 30 s | 28.1 s for an 89.3 s clip (limit 119.3 s; render 28.0 s) | `T2.Z-QG-UX-U6.json` | **pass** |
| QG-UX U7 (scripted) | lose nothing; "Kembali ke versi AI" ≤ 20 s | 2 unsaved commands at reload, 0 lost; reset reached in 1.9 s | `T2.Z-QG-UX-U7.json` | **pass** |
| Scripted times are automation speed | — | the owner times U1, U6 and U7 at checkpoint 2 (the pack lists the steps) | — | owner |

The phase-B evidence (`T2.1-*` … `T2.7-*`) stays as each task measured it; the `T2.Z-*` files
are the gates re-measured on the integrated branch (browser gates, W1 frame gates, lane and save
timings) or measured for the first time with the real modules (e2e flow, two-tab conflict, the
scripted U tasks, PF-OPEN, QG-SEC over every route, open-all).

### Suites

- `uv run pytest` (Python 3.13.13, local FFmpeg 6.1.1): 3,283 passed, 2 skipped, at the final
  code commit.
- `uv run --python 3.11 --isolated --with-editable . --extra vision --with "pytest>=8,<9"
  pytest` (Python 3.11.15): 3,283 passed, 2 skipped.
- Inside `editor-w2` (Python 3.11.2, FFmpeg 5.1.9, `--cpus 4`, the W1 scratch pytest target on
  `PYTHONPATH`): 3,282 passed, 3 skipped, 0 failed.
- `uv run ruff check src tests`: 0 findings. `npm test`: 828/828. `npm run build`: OK.
- Browser specs in Chrome for Testing 147.0.7727.15: `e2e/editor-flow.spec.mjs` 10/10 against
  the image stack; `e2e/editor-player.spec.mjs` 10/10 (fixtures made in `editor-w1z`);
  `e2e/editor-shell.spec.mjs` 31/31 on the fakes (with `EDITOR_GATES=1` and axe) and
  `e2e/editor-transcript.spec.mjs` 20/20 + 1 optional skipped (the real-clip budget run) on the
  final branch.
- `docker build -t ai-video-clipper:editor-w2 .`: OK.

### Patches by the W2 integrator (logged per plan §11.0)

Numbering continues from W1. Each patch has a failing test committed first.

20. `web/lib/python-cli.mjs` (T1.Z scaffolding): `ai_clipper.render_queue` in `PYTHON_CLI_MODULES`
    (T2.2 R1; before it every export route answered 503); a timeout or abort sends SIGTERM to the
    group and SIGKILL after `killGraceMs` (2 s), so `preview_cli` stops FFmpeg's own session first
    (T2.3). Tests: `web/tests/editor-w2-seams.test.mjs`.
21. `web/lib/render-storage-admission.mjs`: a terminal `render-request-v3` (completed, failed or
    cancelled) releases its reservation (T2.2 R2).
22. `web/lib/storage-admission.mjs`: the scan counts a file with several links once (T2.2 R3:
    source snapshots and R10 exports are hard links).
23. `web/lib/preview-source.mjs`: the read stream never closes the borrowed descriptor
    (`fs.close` no-op override); its owner closes it once. Before, `destroy()` closed it and the
    owner closed the same number again, which under concurrent requests closed a reused socket
    and aborted the Next server (T2.3's finding; `/api/jobs/:id/preview-source` and
    `/api/jobs/:id/files/*`).
24. `web/lib/clip-media.mjs` (+ `web/tests/clip-media.test.mjs` expectation): resource kind
    `jassub` (the worker glue and wasm, COEP `require-corp`), the default `jassubUrl` of the
    player (T2.4). `web/next.config.mjs`: `outputFileTracingIncludes` carries them into the
    standalone build (checked in the image), and the editor page gets COOP, COEP, nosniff,
    `frame-ancestors 'none'` and `X-Frame-Options: DENY`.
25. `web/lib/editor/preview-client.mjs`: the playhead in every plan request; a 409 `superseded`
    is an abandoned request (T2.3 → T2.5).
26. `web/lib/editor/store.mjs`: readiness polling (`planPollMs` 750: the same document again
    while a layer builds; an abandoned or failed plan retried), without which the stage never saw
    a cell become ready; the store joins the tab channel only after it has loaded (a store
    destroyed while loading, as React StrictMode does in development, answered the live store as
    a ghost "other tab").
27. `web/components/editor/runtime.mjs`: the real runtime (API client, preview client, store with
    the IndexedDB draft, player with truth frames from the preview client), `setPlayhead`, the
    facade's `stats()`; `web/tests/editor-runtime.test.mjs` no longer expects
    `runtime_unavailable` for `real`.
28. `web/components/editor/EditorApp.jsx`: the playhead to the lane; `otherTab`, the notice and
    the conflict groups from the store (its own BroadcastChannel removed: its messages looked like
    another tab to the store); keys a panel already handled are skipped; the player's `exact`
    reaches the badge; the gizmo registry mounts in the Stage slot; the read-only
    `window.__potonginEditorInspect` on the real page. `ConflictDialog.jsx` reads the store's
    `groups` and shows `conflict.error`. `Stage.jsx` no longer sets the `<video>` `src` the player
    owns; `player/player.mjs` compares the `src` attribute, so a relative auto-render URL does not
    reload the element on every return to that mode.
29. `web/components/editor/shell-model.mjs` + `shell.module.css`: the badge waits for the paused
    player's `exact`; an unchanged legacy-engine clip reads "● Belum diubah: ekspor = klip
    otomatis (mesin lama)" (R10 exports the old file there, so "Sesuai hasil akhir" would be
    false); `conflictParts`; the route-code messages; the tab row wraps (six tabs).
    `errors.py` `legacy_engine`: "…; setelah diubah, ekspor dari editor memakai mesin baru …"
    (mirrored in `shell-model.mjs`, `web/tests/editor-shell-model.test.mjs`,
    `web/e2e/editor-shell.spec.mjs`).
30. `src/ai_clipper/edit_v2/api.py` (T1.1): `seed` and `selection_v3` imported where used
    (T2.2 R5): import 120 → 65 ms locally; PF-SAVE p95 137.9 ms in the image.
31. `src/ai_clipper/edit_v2/glyphs.py` (T1.2a): `fonts.json` read once per process, keyed by its
    size and mtime (T2.3: per-word re-reads in every plan).
32. `src/ai_clipper/edit_v2/errors.py` (T1.1): `ROUTE_CODES` with Indonesian messages for the
    codes the Node routes answer with (T2.3), mirrored in the shell.
33. `src/ai_clipper/render_worker.py` (T2.2): `completed_by` from T2.1's `RenderResult.reused`
    (`auto_file` → `seed`, `existing` → `key`); the worker's default renderer is exercised end to
    end by `tests/test_edit_v2_w2_seams.py`.
34. `src/ai_clipper/edit_v2/compile_ffmpeg.py` (T1.3) + string goldens +
    `tests/test_edit_v2_compile.py` expectation: **R2 bounded**: `trim=start_pts=<first>:
    end_pts=<last>` before `select` in a multi-piece decoder run. `select` never ends its stream,
    so FFmpeg decoded the rest of the source after the last piece: on the owner's 66 min source a
    single removal stalled the export at 98 % (`render_stalled`, found by the e2e flow). After:
    that clip renders in 12.7 s; W1's P-FRAME, P-PLATE, G1/G2 and G-DET re-run in the image pass
    (table). `RENDER_SEMANTICS` stays 1 (same frames).
35. `src/ai_clipper/edit_v2/execute.py` (T1.3): the supervisor wakes on the process's exit (a
    waiter thread) instead of sleeping 50 ms after it (T2.3; PF-TRUTH 669 → 499.5 ms p95).
36. `web/components/editor/__dev__/fakes.mjs`: the real `CommandRejected`; the fake store has the
    real store's surface (T2.5); W3 fakes for uploads, Rapikan, cold-open candidates and AI hooks.
37. W3 scaffolding (below) and `web/tests/editor-scaffold.test.mjs` (asserts the W2 entries; the
    W3 ones are in `web/tests/editor-w3-scaffold.test.mjs`).
38. New integrator files: `web/e2e/editor-flow.spec.mjs`, `scripts/editor/verify_export.py`,
    `tests/test_edit_v2_w2_seams.py`, `web/tests/editor-w2-seams.test.mjs`,
    `web/tests/editor-w3-scaffold.test.mjs`; `web/package.json` scripts `test:player` and
    `test:editor-flow` (no dependency change).

### Phase-B requests

| From | Request | Decision |
|---|---|---|
| T2.1 | record the `render_edit` surface in CONTRACTS | **applied** (§5.17) |
| T2.1 | T2.2 builds requests `render_request` accepts | **verified**: `tests/test_edit_v2_w2_seams.py` runs a queued request through the worker's default renderer; the e2e flow exports through it |
| T2.1 | T2.3's `rev0.exact` rule | **confirmed** (`preview_cli._rev0`: plan sha = the manifest's, engine `edit-v2/1`, seed compiler `edit-v2/1`) |
| T2.1 | T2.6 may use `renderEngineView` | **noted**; the project page shows the edit state, the engine appears in the editor notice |
| T2.1 | record the evidence, the kit and K1/R7 in GATES | **applied** (table, Open 1, 11) |
| T2.1 | `subtitles._group_frame_words` measures word gaps after frame rounding | **deferred** to W5/T4 before the K1 flip (Open 11): it changes revision 0 of 2 of 20 P-LOOK clips and the ASS goldens; with the flag at `legacy` nothing ships |
| T2.1 | T4.3 performance candidates (PF-PIPELINE) | **handed to T4.3** (Open 14) |
| T2.2 R1 | `render_queue` in `PYTHON_CLI_MODULES` | **applied** (patch 20) |
| T2.2 R2 | v3 reservations reclaimed | **applied** (patch 21) |
| T2.2 R3 | hard links counted once | **applied** (patch 22) |
| T2.2 R4 | the `render_request` seam | **verified**; (h) not applied: `render_edit` keeps its own R10 check, which runs only when the create-time check failed; the create-time rule is authoritative (CONTRACTS §5.17) |
| T2.2 R5 | lazy imports in `api.py` | **applied** (patch 30) |
| T2.2 R6 | CONTRACTS additions (a)–(k) | **approved**, incl. (d) the legacy R10 duration rule (32/32 real clips) (§5.17) |
| T2.2 R7 | the UI follows R6(f)–(j) | **applied** where it matters: the store reads `seed` as a boolean and uses `words.url`; the export flow handles 200 and 202; "Ekspor sebelumnya" still comes from the flow and the listing's `latestRender`, not `GET /clips/:clipId/renders` (Open 16) |
| T2.2 R8 | G5 boxes | **open** (Open 8 of W1, owner T4.2) |
| T2.3 | the double close in `preview-source.mjs` | **applied** (patch 23) |
| T2.3 | SIGTERM before SIGKILL in `python-cli` | **applied** (patch 20) |
| T2.3 | memoise `fonts_manifest`/`font_path` | **applied** (patch 31) |
| T2.3 | `execute._supervise` polling | **applied** (patch 35) |
| T2.3 | a disk cache for `probe_source` | **handed to T4.3** (Open 14) |
| T2.3 | CONTRACTS §4.1–§4.3 additions (a)–(i) | **approved** (§5.17) |
| T2.3 | Indonesian messages for the Node codes | **applied** (patch 32) |
| T2.3 | `render_edit` resolves the camera plan like the lane when the layout was switched | **handed to T3.6** (the layout switch arrives in W3; no W2 document can switch layout) |
| T2.3 | the preview client sends the playhead, polls, treats 409 as abandoned | **applied** (patches 25, 26) |
| T2.3 / T2.4 | a production route for JASSUB's files | **applied** (patch 24) |
| T2.3 | the persistent preview worker | **handed to T4.3** (plan §10.3 contingency; PF-PLAN, PF-AUDIO) |
| T2.4 | `text.fonts` always lists DejaVu Sans | **already true** (`fonts.json` `fallback`) |
| T2.4 | plate cells with `-g ceil(F/3)` | **handed to T4.3**: PF-SEEK passes at the measured load; the change needs the server P-FRAME/P-PLATE re-run (Open 13) |
| T2.4 | one cell job per contiguous run | **kept as is**: the lane batches at most 4 cells (≤ 4 runs); PF-CELLS passes; T4.3 checks `RLIMIT_AS` with 4 non-contiguous runs |
| T2.4 | the VFR mix is 8 samples short | **open** (Open 12, with W1 Open 4) |
| T2.4 | the wiring of `createPlayer` | **applied** (patches 27, 28) |
| T2.4 | ownership of `scripts/parity/player_fixtures.py` and its test; the `text-layer.mjs` change | **confirmed** (T2.4 owns both; the adapter change is logged here: banded compositing, byte-identical, and the opt-in `keepBitmaps`/`split`) |
| T2.4 | `test:player` script and a manual CI job | script **applied** (patch 38); the CI job is **handed to T4.4** |
| T2.5 | CONTRACTS W2 client section | **applied** (§5.17) |
| T2.5 | T3.5 / T3.1–T3.3 notes | **recorded** in CONTRACTS §5.17 for W3 |
| T2.5 | GET edit shapes | **confirmed** by the e2e flow |
| T2.5 | fakes: the real `CommandRejected`, the store surface | **applied** (patch 36) |
| T2.5 / T2.6 | conflict groups, notice, `otherTab`, `startFromSeed`, `flush` | **applied** (patches 28, 29) |
| T2.5 | wiring | **applied** (patch 27) |
| T2.6 | `axe-core` as a devDependency | **declined**: the W2 rule allows only the jassub and mediabunny pins; `AXE_CORE_PATH` stays (T4.4 decides for CI) |
| T2.6 | the real runtime | **applied** (patch 27) |
| T2.6 | the `video` element and `playing`/`frame` in `onState` | **confirmed**; the Stage no longer sets `src` (patch 28) |
| T2.6 | store fields | **applied** (patches 26–29) |
| T2.6 | `gapWord` convention | **confirmed** (T2.5's `TrimStart`/`TrimEnd` and T2.7's I/O use the same reading; U1 passes through both) |
| T2.6 / T2.7 | transcript keys not handled globally | **applied** (`defaultPrevented`, patch 28) |
| T2.6 | the clips route 404 with the flag off | **confirmed** (T2.2's routes answer `editor_disabled` 404) |
| T2.6 | new files and the CI note | **recorded** |
| T2.7 | `playing` in `player.state()` | **already true** (T2.4) |
| T2.7 | merge by `mergeKey` whatever the type; `pending` "text"; `state.seed`; rejection messages; `RemoveWords` by ids | **confirmed** by T2.5's store and the e2e flow |
| T2.7 | fold the harness store into the fakes; re-run the 16 ms budget on the real store | **declined** (the harness store stays for T2.7's self-contained spec); the budget on the real store is **not re-measured** (Open 21) |
| T2.7 | `playwright.config.mjs` without credentials for self-contained specs | **handed to T4.4** (CI) |
| T2.7 | `transcript/model.mjs` imports `timemap.mjs` | **handed to T3.5** (it takes over `transcript/**`); both copies pass the same vectors |
| T2.7 | T3.4 / T3.7 notes | **recorded** in the W3 scaffolding comments |

### W3 scaffolding (landed by T2.Z)

`panels/index.mjs` lists Tata letak (T3.6), Logo (T3.2) and Musik (T3.3) after the W2 tabs, and
`timeline/lanes.mjs` lists Audio (T3.7), Penanda (T3.7) and Musik (T3.3) under the W2 lanes, each
with a placeholder file (`panels/{LayoutPanel,LogoPanel,MusicPanel}.jsx`,
`timeline/lanes/{AudioLane,MarkerLane,MusicLane}.jsx`). `gizmos/index.mjs` lists the logo gizmo
(`gizmos/LogoGizmo.jsx`), which `EditorApp` mounts in the Stage's gizmo slot;
`suggestions/index.jsx` is the hook-suggestions slot (T3.4). `__dev__/fakes.mjs` adds
`createFakeUploadClient` (Appendix A.2 `uploadAsset`) and Rapikan, cold-open and AI-hook data.
Tests: `web/tests/editor-w3-scaffold.test.mjs`. In the owner's beta the W3 tabs and lanes are
hidden until W3 lands (re-exit: `shell-model.LIVE_WAVES`; the W3 integrator adds `"W3"`); the
fakes show them.

### Open (W2 additions; W1's list above stays)

11. **Cue grouping** (closed at the re-exit: fixed, P-LOOK and P-RT re-run) (T2.1 finding, T1.2a module): `_group_frame_words` compares the word gap after
    rounding to frames, so real gaps of 0.611–0.620 s become 0.600 s and a cue does not break
    where the legacy engine breaks (5 of 894 real cues, 2 of 20 P-LOOK clips). Fix before the K1
    flip (W5/T4): measure the gap in source ms inside a piece; re-run P-LOOK and P-RT.
12. **VFR mix 8 samples short** (T2.4): on the VFR barcode source the final graph's PCM and the
    lane's FLAC both hold 975,992 samples against `plan.samples` 976,000; G2 (±1,024) passes.
    Likely W1 Open 4 (audio start > 0).
13. **PF-SEEK under load**: 38.6 ms p95 at the measured load, 71–91 ms at load 14–23 (T2.4). The
    10-frame plate GOP (T2.4: 20.2 / 54 ms) is T4.3's, with the server P-FRAME/P-PLATE re-run.
14. **Server timings** (T4.3): PF-PLAN p95 226 ms at load ≥ 4 (one Python process per plan:
    start-up and imports; `store` → `edit_manifest` → `ranking` is the next import to cut);
    PF-AUDIO 1.9 s p95 with music (two full decodes); PF-PIPELINE center-crop 2.51× and face-track
    2.16×; `probe_source` re-run per process. The persistent preview worker of plan §10.3 is the
    planned answer.
15. **R10 has two legacy rules** (CONTRACTS §5.17): the queue's duration rule at create
    (authoritative) and `render_edit`'s 0.25 s contract at render time. Both pass the 32 real
    clips; T4.2 may unify them.
16. **"Ekspor sebelumnya"** lists this session's exports and the clip's latest one, not
    `GET /clips/:clipId/renders` (T2.2's listing route): T4.5.
17. **A copied job exports only after its `job.json` names the copy's source** (the legacy
    snapshot rule, unchanged): the e2e copies are rehomed; a restored backup in another
    `JOBS_ROOT` would need the same. T4.2 decides whether v3 may use the `input/` basename rule
    that `prepare` and `render_edit` use.
18. **Local runs need `resources/toolchain.json`** for exports (render keys); the image writes
    it. `docs/editor/PANDUAN-EDITOR.md` gives the one-line local command.
19. **QG-A11Y moderate**: `heading-order` on the cold-open panel (T4.5).
20. **Face-track prepare** of an older job takes ~50 s for 8 clips (camera plans; the button
    shows "Menyiapkan…").
21. **The 16 ms transcript budget on the real store** was measured with T2.7's harness store
    (p95 4.0 ms, max 11.7 ms on 1,500 words); T2.5 measured the real store's dispatch alone
    (p95 ≤ 1.94 ms). The two together are not measured on the integrated page (T4.5).

---

## Rebase onto main (W3 base, 2026-09-28)

Branch `editor-w3-base`: `editor-w2-integration` (`550723e`, 197 commits on `80c7901`) rebased
onto `main` `55e4c6c` (Konteks Tren, Fokus klip, the content-based `.gitleaks.toml`); linear, no
merge commits, no commit became empty (197 → 197), `rerere` on. Then five commits: three test
commits where the two sides meet, one `ruff format`, one gitleaks allowlist. Flags unchanged
(all off; `POTONGIN_RENDER_ENGINE=legacy`).

**What conflicted and how it was resolved** (4 of the 197 commits; every other file of both sides
merged cleanly, including `web/lib/selection-v3-view.mjs` and both web test files):

| Commit (rebased) | File | Resolution |
|---|---|---|
| `06dbe93` engine-switch tests | `tests/test_pipeline_v3.py` | Both appended sections kept: main's Konteks Tren and Fokus klip tests, then the engine-switch tests (the fixture's `POTONGIN_RENDER_ENGINE` removal merged by itself) |
| `9a85215` engine switch | `src/ai_clipper/pipeline.py` | `_run_v3` and `run_pipeline` take `trend_context`, `focus` **and** `render_engine`; the call passes all three; one docstring names all three. Trends and focus stay selection data: `_v3_manifest_clip` writes `trends`/`focus`, `_render_v3_clips` then adds the four engine fields, so a clip rendered by edit-v2 (or falling back) keeps both |
| `9a85215` engine switch | `web/lib/jobs.mjs` | `sanitizeV3ClipFields` keeps `trends` and `focus`, then `clipId` and `renderEngine`; both name maps and `JOB_V3_ONLY_KEYS` carry all four |
| `b874b1e` V3 shell, `1577049` job-level prepare | `web/app/projects/[id]/page.jsx` | Both imports; `FocusSummary` then the editor's `ClipEditorEntry`/`JobPrepare`; `V3ClipCard({ clip, job, copied, onCopy, editorEntry })`: focus chip in the badge row, then `TrendChips`, then `ClipEditorEntry`; the list keeps main's pinned `<V3ClipCard key={clip.index} clip={clip} job={job}` and adds `editorEntry`; `FocusSummary` sits above the editor's error panel and job-level prepare |

Checked beyond the text: edit-v2 reads `selection.v3.json` through `selection_from_dict`, which
accepts main's optional `trends`/`focus`; clip ids come from the source sha and times, so they are
unchanged; the worker's engine environment is a denylist, so `POTONGIN_RENDER_ENGINE` still reaches
the CLI beside `--trend-context`/`--focus-term`. Every test of both tips is still present (static
count by file and name right after the rebase: main 1,734, editor 2,619, merged 3,006, 0 missing).

**New tests where the sides meet.** `tests/test_pipeline_v3.py`: a V3 job with a trend snapshot and
a focus rendered with `render_engine="edit-v2"` (one clip falling back) writes the legacy manifest
plus exactly the four engine fields, trends, focus and the focus summary included, and no trend or
focus text reaches the engine. `tests/test_edit_v2_render_edit.py` (real compiler): a job selected
with a trend and focus labels seeds the same documents as without them (only
`origin.selection_artifact_sha256` differs, so its plan sha does too), renders identical frames and
PCM, opens in the editor listing, and `render_v3_job` keeps both. `web/tests/selection-v3.test.mjs`:
the four clip fields side by side through the manifest and the job API, each dropped on its own;
the summary's focus beside `engine_fallback`; the card structure. `web/e2e/editor-shell.spec.mjs`:
the project page shows the focus line, the focus chip, the "Nyambung tren" chips and "Edit klip"
in the same card (and at 390 px), and only the chips without the editor flag.

`.gitleaks.toml`: main's content-based allowlist did not cover the W2 unit tests' fake keys (the
example UUID family and `0123456789abcdef` in `web/tests/clip-{edit,media,renders}.test.mjs` and
`tests/test_render_queue.py`: 7 findings). Those exact line shapes are now allowed; gitleaks
v8.28.0 finds nothing in `main..editor-w3-base` or the branch's whole history, and real-format
GitHub, Stripe, AWS-shaped and generic keys added to the same files (or after an allowed value on
the same line, or in the evidence folder) are still reported.

**Suites at the W3 base** (the last code commit; later commits are this document, evidence and the
gitleaks config):

- `uv run ruff check src tests`: 0 findings (`pipeline.py` and `tests/test_pipeline_v3.py` are
  `ruff format` clean again, as on main).
- `uv run pytest` (Python 3.13.13, FFmpeg 6.1.1): **3,783 passed, 2 skipped** (the opt-in PUT
  timing gate; the pack-thumbnail reproduction, toolchain-only).
- Python 3.11.15 (scratch venv from `uv.lock`, `--extra vision`): **3,783 passed, 2 skipped** (the
  same two).
- Inside `ai-video-clipper:editor-w3base` (Python 3.11.2, FFmpeg 5.1.9, `--cpus 4`, pytest 8.4.2
  from a scratch target): **3,782 passed, 3 skipped** (the PUT timing gate; no C compiler; no git
  metadata), 0 failed.
- `npm test`: **983/983**. `npm run build`: OK (the same 13 Turbopack warnings).
- Browser specs on a production build (`next start`, Chrome for Testing 147.0.7727.15):
  `editor-shell` + `editor-transcript` on the fakes (`EDITOR_GATES=1`, axe) 53 passed, 1 skipped
  (the optional real-clip budget); `focus` + `trends` 11 passed, and the live trends block 1/1 on
  the temp server.
- `docker build -t ai-video-clipper:editor-w3base .`: OK; `/app/resources/toolchain.json` sha
  `4fefb754…85f0`, **the same as `editor-w2r2`** (every render key stays valid); `toolchain check`
  OK; the JASSUB worker files present.

**Gates re-run in `editor-w3base`** (evidence `docs/editor/evidence/W3/W3base-*.json`; the image's
own `src` and `resources`):

- **P-RT/R10**, synthetic job (`make_job.py build --only main,fps60,old --render --stub-camera` in
  one container, `rt_check.py` in another on CPUs 8–11): 6/6 revision-0 re-renders identical in
  video, PCM, bytes and SRT, render key and plan equal (6,813 frames, fit-blur 29.97 and camera
  60→30); R10 **27/27** hard links (seed, undone edit, changed toolchain; edit-v2 and legacy).
- **G-DET**: 0 digest differences over 8 cases and 3 processes (hash seeds 11, 4242), 0
  preview/export ASS mismatches, final bytes and 13 plate cells identical (2 cases).
- **e2e flow** (`e2e/editor-flow.spec.mjs`) against the image's app and render worker with a temp
  copy of the owner's jobs (the originals only read): **10/10** on e7f0d37b (fit-blur): the edited
  export (revision 1, 27.6 s render for a 48.8 s clip) passes G1 and G2 on the download (G5 warns),
  R10 same inode; QG-CONFLICT pass; U1 3.9 s, U2 3.0 s, U3 3.0 s, U6 36.7 s for an 89.3 s clip
  (limit 119.3 s), U7 0 lost and the reset found in 1.9 s; QG-A11Y 8 states, 0 violations;
  PF-OPEN first visit p95 1,705 ms, repeat 1,555 ms, first cell 1,259 ms (load 18.5). PF-OPEN on
  860fef1a (face-track): 1,097 / 1,005 / 874 ms.
- A scratch check on the same stack (not committed): the e7f0d37b copy given a trend and a focus
  shows the focus line, the focus chips, the trend chips and "Edit klip" in the same cards, and the
  editor opens from them.

**Open (noticed, not changed here).** The project page of a V3 job asks `/candidate-feedback`
(404 without V2 candidates, unchanged since before both branches) and, with the editor flag off,
`/api/jobs/:id/clips` (404, W2), so its console shows two 404s. A spec built on
`e2e/support/harness.mjs` counts any API response ≥ 400 as a failure if pointed at such a page
(`read-only` and `smoke` pick V2 jobs, so they are not affected; the Konteks Tren and Fokus specs
fake the job routes).

---

## W3 "Fitur Esensial lengkap": exit gate (T3.Z, 2026-10-01)

Branch `editor-w3-integration`. T3.1 → T3.2 → T3.3 → T3.4 → T3.5 → T3.6 → T3.7 cherry-picked in that
order onto the W3 base `7a63f3a` (106 commits, no conflicts: the seven tasks touched disjoint files),
then the whole branch rebased onto `main` `b1ab3e0` (track A: the dark design, latest-only copy,
the candidate editor retired, the UI guards, the login rate-limit fix, the editor-gates workflow):
309 commits, linear, `rerere` on, then the integration commits (patches 39–51 below). Flags stay off
by default (`POTONGIN_EDITOR_V3`, `POTONGIN_EDITOR_UPLOADS`, `POTONGIN_EDITOR_LLM` = `off`,
`POTONGIN_RENDER_ENGINE=legacy` until the W4 speed-up); `compose.yaml` passes all of them, plus the
optional `POTONGIN_LLM_EDITOR_MODELS`, to the app only.

Where it was measured (owner rule 2026-10-01: heavy work on GitHub Actions, the owner's PC only for
targeted tests and one browser pass): the suites and every FFmpeg gate ran in `editor-gates.yml`
(`suite=full`, `suite=image`, and `suite=command` with `scripts/editor/w3_exit_gates.sh`) on
4 vCPU runners, so every timing there is indicative. The production image of record is the one
those runs build (FFmpeg 5.1.9, libass 0.17.1, Python 3.11.2, Node 20). The browser parts ran on the
owner's PC against the standalone app that image built (downloaded from CI run 36861153869), one
browser at a time: Chrome for Testing 147.0.7727.15, the fakes specs, the P-TXT subset against the
image's references, and the real-stack flow on a copy of the owner's job `e7f0d37b` (the original
only read).

### Summary table

| Gate | Threshold | Measured (W3 exit, integrated branch) | Evidence | Result |
|---|---|---|---|---|
| ruff, pytest (Python 3.11), npm test (Node 20), build | green | 0 findings; 4,269 passed; 1,141 pass, 0 fail; compiled (run 36862523910) | — | **pass** |
| pytest in the production image | green | 4,267 passed, 4 skipped, 1 xfailed (run 36862524594) | — | **pass** |
| UI guards (main's `ui-guards.test.mjs`) on the editor | no version wording; colours only from `:root`; every text pair AA | 0 / 0 / 0 (the editor's own palette removed, patches 40–42) | — | **pass** |
| AA contrast of the new pairs (`contrast-check.py`) | 4.5:1 text, 3:1 control edges | cold-open 9.67 on bg, 7.50 on surface-3; selected word 8.13; strong button 18.28; control edge 3.57 | `W3Z-contrast.json` | **pass** |
| QG-SEC upload fuzz (HTTP and ingest) | 100 % rejected or normalised, no 5xx | 66 cases: 45 rejected, 21 normalised, 0 5xx, both levels | `W3Z-QG-SEC-fuzz-http.json`, `W3Z-QG-SEC-fuzz-ingest.json` | **pass** |
| QG-SEC route matrix + E11 child env | 20/20; no name outside the allowlist, no planted value | 20/20; 129 children (ffmpeg 37, ffprobe 50, python 42), 0 names outside, 0 planted values | `W3Z-QG-SEC-http.json` | **pass** |
| Ingest p95 | ≤ 2 s per image, ≤ 8 s per 5-min track | 1,091 ms (60 samples); 5,989 ms (25 samples) | `W3Z-ingest-perf.json` | **pass** (indicative) |
| G5 (logo in the unsafe zone) | build_plan = export check = §5.9 zone | 450 cases (242 unsafe), 0 mismatches | `W3Z-G5.json` | **pass** |
| P-LOGO | max ≤ 8 in the logo region | not re-measured (unchanged since T3.2: 17/18 frames pass, 1 frame max 9 from the captions under the logo's transparent pixels) | `T3.2-P-LOGO.json` | **fail, owner decision** (Open 23) |
| duck (Halus −6, Sedang −10, Kuat −16 dB) | ±0.5 dB, recovery ±1 dB | 9 cases, worst 0.361 dB; 6 recovery checks within 1 dB | `W3Z-duck.json` | **pass** |
| G3 | −14 ± 1 LUFS, TP ≤ −1 dBTP | −14.0 to −14.1 LUFS, TP −10.9 to −7.1 dBTP | `W3Z-G3.json` | **pass** |
| G3b (deliberately loud track) | TP ≤ −1.0 dBTP | 9 cases, worst −1.1 dBTP; `peak_reduced` 2.3–12.0 dB | `W3Z-G3b.json` | **pass** |
| G-CLICK with music | every faded join < −40 dBFS; the hard-cut control must click | worst −59.94 dBFS over 52 joins; control 21/26 | `W3Z-G-CLICK.json` | **pass** |
| P-AUD (server, preview lane) | PCM md5 equal; samples = plan | md5 equal 6/6; samples 5/6: `02-vfr-bed` 16 samples short on preview and reference alike | `W3Z-P-AUD.json` | **fail** (Open 12, unchanged) |
| PF-AUDIO with music | p95 ≤ 1,000 ms | p95 834.6 ms, 20 edits, 90 s clip (load 3.1–4.1); the verifier's re-run on the same commit: **1,199.5 ms** (load 3.3–4.6, run 36870736233) | `W3Z-PF-AUDIO.json`, `W3Z-PF-AUDIO-rerun.json` | **borderline**: passes on a quiet 4 vCPU runner, fails on a busy one (W2 Open 22; the W4 speed-up, T4.3) |
| QG-AI hard gates (offline) | 0 ungrounded, 0 malformed accepted | `tests/test_editor_ai.py` 73/73 in the image, including the 100 scripted adversarial answers | T3.4 + run 36857927653 | **pass** |
| QG-AI online (instant p95 ≤ 300 ms; LLM p95 ≤ 15 s, none > 20 s) | as stated | T3.4, local real jobs, free chain: 209 ms; 10.1 s; 0 over 20 s | `T3.4-QG-AI-online.json` | **pass** (owner review at checkpoint 3) |
| QG-CLEAN labelled set | particles 0 FP, reduplication 0 FP, filler precision ≥ 0.9 | 490 tokens, 37 pairs: 0, 0, 0.933 (agent labels; pre-check stays off) | `W3Z-QG-CLEAN-labels.json` | **pass** |
| QG-CLEAN cut edges + G-CLICK + G-SYNC | edges inside the gap; < −40 dBFS; A/V ≤ 1 frame | 6 items: 12/12 edges inside, −200 dBFS, A/V end 9.9 ms, 12 caption onsets | `W3Z-QG-CLEAN-synthetic.json` | **pass** |
| P-FRAME per layout | 0 mismatches | 12 cases (fit-blur, center-crop, face-track; 29.97, 25, 60, VFR), 7,572 frames, 0 | `W3Z-P-FRAME.json` | **pass** |
| P-PLATE per layout | crop x 0 px, SSIM margin ≥ 0 | 5 cases incl. switched seeds: crop x 0 on 924 + 923 frames × 3 streams; margins 0.00198–0.00200 | `W3Z-P-PLATE.json` | **pass** |
| Switch: first cell at the playhead | ≤ 3 s (fit-blur, center-crop) | 11 gated cases, max 1.59 s; face-track (reported) 4.8–5.8 s incl. analysis | `W3Z-switch.json` | **pass** (indicative) |
| Markers exact | 0 frames | node 25/25, pytest, fixture vectors up to date (T3.7: 0 of 2,632 on real clips) | run 36857927653, `T3.7-markers-exact.json` | **pass** |
| P-RT / R10 | identical frames, PCM, bytes; 100 % hard links | 6/6 clips, 6,813 frames, bytes and PCM identical; R10 27/27 | `W3Z-P-RT.json` | **pass** |
| G-DET | 0 digest differences; preview ASS = export ASS | 8 cases × 3 processes, 0; 0 ASS mismatches | `W3Z-G-DET.json` | **pass** |
| P-TXT (subset: 4 packs at 40 chars, hook, fallback) | SSIM ≥ 0.999, PSNR ≥ 45, max ≤ 16, 0 px > 16 | 30 frames (gbrp): SSIM 0.99995, text 0.99964, PSNR 62.77, max 13, 0 | `W3Z-P-TXT.json` | **pass** |
| Fakes specs on the production build | green | 139 passed, 8 skipped (real-data blocks) | — | **pass** |
| Real-stack flow, one per feature (`editor-flow.spec.mjs`) | green, time limits | 20 passed: entry, W2 flow, QG-CONFLICT, U1–U7, logo, music, export G1/G2/G3b, hooks, Rapikan, layout, markers, PF-OPEN, QG-A11Y | `W3Z-e2e-*.json`, `W3Z-QG-UX-*.json` | **pass** |
| Scripted QG-UX U4 and U5 (real stack) | ≤ 30 s; ≤ 60 s | 2.8 s; 4.6 s | `W3Z-QG-UX-U4.json`, `W3Z-QG-UX-U5.json` | **pass** |
| QG-A11Y (real stack, every W3 panel, both viewports) | 0 critical, 0 serious | 16 states: 0, 0 (2 moderate, Open 19) | `W3Z-QG-A11Y.json` | **pass** |

### Suites

On GitHub Actions at `6857674` (the last code commit; later commits are this document and
evidence):

- `ci-gate full` (run 36862523910): **success**. ruff "All checks passed!"; pytest on Python 3.11
  "4269 passed, 2 skipped, 1 xfailed"; npm test on Node 20 "# pass 1141", "# fail 0"; npm run build
  "✓ Compiled successfully".
- `ci-gate image` (run 36862524594): **success**. The image builds (Next "✓ Compiled
  successfully"); pytest inside it (Python 3.11.2, FFmpeg 5.1.9) "4267 passed, 4 skipped, 1 xfailed".
- Exit-gate command runs (`scripts/editor/w3_exit_gates.sh`): run 36857927653 (web, sec, ai,
  markers, logo, gdet, ptxt at `96db8fd`: the QG-SEC HTTP half and G-DET failed on the script's own
  setup, fixed in `24f3d02`), run 36860568957 (sec, gdet at `24f3d02`: pass), run 36857944101
  (audio: every gate passes except P-AUD's known VFR case), run 36857976574 (clean, rt: pass), run
  36858009742 (plate: pass), run 36861153869 (web: the standalone app of `1a417e1` for the browser
  runs). The gate code did not change after those commits.
- Earlier full runs on this branch: 36857462744 (pytest 4,268 passed, 1 failed: the heartbeat test,
  patch 47; the web suite did not run), 36860568483 (pytest 4,269 passed; web 1,139 pass, 2 fail:
  the rebase seams of the next commit).

Browser (owner's PC, Chrome for Testing 147.0.7727.15, one browser at a time, the CI-built
standalone app):

- Fakes specs on the production build: `editor-shell` 33 passed, 1 skipped (the optional real-clip
  budget); `editor-layout`, `editor-ai`, `editor-logo`, `editor-music` 54 passed, 4 skipped (their
  real-stack blocks); harness specs `editor-transcript`, `editor-cleanup`, `editor-markers` 52
  passed, 3 skipped (axe there ran with `AXE_CORE_PATH`; the skips are real-data blocks).
- P-TXT subset against the image's references: 30 frames, gbrp gate pass (table).
- **`web/e2e/editor-flow.spec.mjs` on a fresh copy of the owner's job `e7f0d37b`: 20 passed
  (3.8 m)**. Entry: 3 cards, each with "Edit klip", the history link, the unprepared clip opened
  with the progress in 5.5 s. W2 flow (edit, undo/redo, reload, export, G1/G2 on the download,
  R10 same inode) pass; QG-CONFLICT pass; U1 2.9 s (≤ 20), U2 2.9 s (≤ 20), U3 3.0 s (≤ 45),
  U4 2.8 s (≤ 30), U5 4.6 s (≤ 60), U6 26.9 s for a 89.3 s clip (≤ 119.3), U7 pass; logo upload
  1.1 s, music upload 1.1 s, the export with logo and ducked music passes G1, G2 and G3b (G5 warns:
  the logo sits top right in the TikTok zone, as placed); hook suggestion used; Rapikan 8 listed,
  8 applied, one Urungkan restores; layout switch exact after 11.5 s (center-crop, cells built)
  and 1.9 s (back); 11 markers, a click seeks to its frame, a cold-open suggestion applied;
  PF-OPEN first visit p95 933 ms, repeat 887 ms, first cell 882 ms; QG-A11Y 16 states (both
  viewports, every W3 panel and the Rapikan review), 0 critical, 0 serious (2 moderate: the cold-open
  panel's heading order, W2 Open 19). Evidence:
  `W3Z-e2e-*.json`, `W3Z-QG-UX-U1…U7.json`, `W3Z-PF-OPEN.json`, `W3Z-QG-A11Y.json`,
  `W3Z-QG-CONFLICT-e2e.json` (renders there used the PC's FFmpeg 6.1.1; the image's gates are the
  CI rows).
- Before that pass, two earlier runs found two test seams (the W2 flow expected the W3 tabs hidden;
  the W3 export flow left its dialog open) and the local server first had a storage setting out of
  range; QG-A11Y now waits for the panel's entrance animation before axe reads contrast.

### Patches by the W3 integrator (logged per plan §11.0)

Numbering continues from W2.

39. `web/tests/editor-player-plate.test.mjs` (T2.4): `harness()` injects the microtask yield that
    `gatedHarness` already uses. On Node 20 the default `setTimeout(0)` yield fired after the
    test's one `setImmediate`, so "need(k, j) decodes the cell from j…" saw the decoder still
    open (every W3 branch's full run). Assertions unchanged.
40. Latest-only copy: `src/ai_clipper/edit_v2/errors.py` `_MESSAGES` and its JS copy in
    `shell-model.mjs`, `clip-edit.mjs`, `clip-entry-view.mjs`, `clip-renders.mjs`, `runtime.mjs`,
    `EditorApp.jsx`: no "Editor V3", "mesin lama/baru" or "job V3"; the unchanged-clip badge reads
    "● Belum diubah: ekspor = klip otomatis". Tests keep their checks with the new copy.
41. Dark design: every editor stylesheet (W2 and W3 files) draws with the `:root` tokens of
    `app/globals.css`; `editor.module.css` keeps sizes, the focus ring and the popover; new tokens
    `--cold-open`, `--cold-open-bg`, `--info-veil`, `--danger-veil`, `--shadow`
    (`docs/design/TOKENS.md`); caption swatches move to `lib/editor/content-colours.mjs`; a
    transcript keyword is bold and underlined in its swatch (text stays `--text`); the harness page
    (`transcript/__dev__/bundle.mjs`) carries the `:root` block. Specs: `editor-cleanup` checks
    the dark tokens and that no lime shows in the review; `editor-transcript` checks the underline.
42. DESIGN.md "one accent": lime only on Ekspor (and progress fills); panel actions (Terapkan, the
    logo upload) are the strong neutral button; selections `--surface-3` with light edges;
    control edges `--border-strong`; focus outlines `--focus`.
43. Wiring: `LIVE_WAVES` adds `W3`; `EditorApp` gives panels `api`, `previewClient`,
    `uploadAsset`, `uploadsEnabled`, `notify`, `readOnly` and filters gizmos with `liveEntries`;
    the real runtime returns T3.1's `uploadAsset`; the page passes `features.uploads`.
44. Entry (owner feedback): `lib/editor/open-clip.mjs` (the `klip-<n>` address and the automatic
    job-level prepare), `EditorApp` prepare step with progress, `clip-entry-view` links clips that
    need preparing, the project page puts "Edit klip" first on every card, the history offers
    "Edit klip" (`GET /api/jobs` says whether the editor is on), the editor page accepts
    `klip-<n>` and is titled "Edit klip · Potongin". `prepareClipEntries`, `engineLegacy` and the
    page's "Siapkan untuk editor" are gone.
45. `open-clip.prepareForEditor` reads the prepare answer to the end (a production build showed
    the unread POST cut off as `net::ERR_ABORTED` when the editor left the prepare step).
46. `compose.yaml`: `POTONGIN_LLM_EDITOR_MODELS` (blank) for the app (T3.4's request);
    `web/tests/editor-w3-wiring.test.mjs` checks every editor flag and its default.
47. `tests/test_render_worker.py`: the heartbeat test runs on the queue's clock (it failed on a
    busy CI runner with an 80 ms wall-clock lease, T3.5's report); without heartbeats it still fails.
48. Specs: `editor-layout` "does not animate" means under 1 ms (main's global reduced-motion rule
    leaves 0.01 ms); `editor-shell` lists every element focused without a ring; the project-page
    block of `editor-shell` follows the new entry; `selection-v3.test.mjs` checks that no view
    names the engine (main dropped the engine label) and follows main's `ClipCard`.
49. `web/e2e/editor-flow.spec.mjs`: the entry flow first, then logo, music (and their export with
    G1–G3), hook suggestions, Rapikan, the layout switch, waveform/markers/cold-open suggestions,
    the scripted U4 and U5, and QG-A11Y over the W3 panels.
50. `scripts/editor/w3_exit_gates.sh`: the exit gate by section inside the image (new).
51. `docs/editor/PANDUAN-EDITOR.md` (every W3 feature, no version words), `CONTRACTS.md` §5.19.
52. Seams found by the full suite and the real pass: `web/tests/legacy-spawn-env.test.mjs` (W2)
    keeps E11 for the render-queue helpers (main deleted the four candidate-editor helpers it
    also covered); `editor.module.css` holds custom properties only (`editor-scaffold` test);
    `editor-flow.spec.mjs`: the W2 flow expects the W3 tabs and lanes, the W3 export closes its
    dialog, and QG-A11Y waits for entrance animations before axe reads contrast (the Rapikan
    review fades in for 240 ms; axe read the fading text as 1.5:1).

### The rebase onto main (what conflicted)

| Commit (rebased) | File | Resolution |
|---|---|---|
| `eb85bdb` roadmap | `docs/ROADMAP.md` | main's text (track A and the 2026-09-30 decisions) |
| `443b0f7` engine switch | `web/lib/selection-v3-view.mjs` | main's file: `selectionSourceLabel` and `isV3Job` are gone there, and `renderEngineView` ("Mesin baru/lama") is not added (latest only; its test replaced, patch 48) |
| `f165a86` shell, `5ad7855` prepare | `web/app/projects/[id]/page.jsx` | main's page each time; the editor entry rebuilt on it (patch 44) |
| `17a2b1b` E11 helpers | `web/lib/{candidates,caption-cues,edit-document,candidate-feedback}.mjs` | deleted, as on main (the candidate editor is retired) |
| `a1c6900` gitleaks | `.gitleaks.toml` | both allowlists kept, each in its own table |

Every other file of both sides merged by itself. gitleaks v8.28.0 with main's config finds nothing
in `origin/main..editor-w3-integration`.

### Phase-B requests (resolved here or forwarded)

| From | Request | Status |
|---|---|---|
| T3.1–T3.7 | the Node 20 failure in `editor-player-plate.test.mjs` | **fixed** (patch 39) |
| T3.2 | connect the real upload client to the Logo panel | **done** (patch 43) |
| T3.2 | P-LOGO 1/18 frames: does "logo region" include what shows through a transparent logo? | **owner decision**, checkpoint 3 (Open 23) |
| T3.3 | GATES rows for the music gates | **done** (table above) |
| T3.3 | P-AUD VFR 16-sample shortfall | **open** (Open 12, compiler's source-audio path; W4/W5) |
| T3.3, T3.6 | PF-AUDIO and PF-CELLS fit-blur budgets on 4 vCPU | PF-AUDIO borderline (834.6 ms in this run, 1,199.5 ms in the verifier's re-run); both forwarded to W4/T4.3 |
| T3.4 | the shell passes its API client to the panels | **done** (patch 43) |
| T3.4 | compose passes `POTONGIN_LLM_EDITOR_MODELS` | **done** (patch 46) |
| T3.5 | the flaky render-worker heartbeat test | **fixed** (patch 47) |
| T3.5 | the owner confirms the 490 filler labels | checkpoint 3 |
| T3.6 | the lane does not re-queue a cell deleted within 30 s of its build | forwarded to W4/T4.3 (Open 24) |
| T3.7 | the gitleaks command needs the main `.git` mounted in a worktree | used here; noted in HANDOFF |

### Open (W3 additions; the W1 and W2 lists above stay)

22. **PF-CELLS fit-blur** is thin on a 4 vCPU runner (projected 16–21 s for a 60 s clip against
    15 s; the owner's PC measured 13.4 s in W2): the W4 speed-up (T4.3).
23. **P-LOGO, 1 of 18 frames** (max 9 against 8) comes from captions seen through the logo's
    transparent pixels; the threshold is unchanged until the owner decides what the logo region is.
24. **The preview lane** does not re-queue a cell deleted within 30 s of being built (cache
    eviction, outside cleanup): the editor recovers on its next poll (T3.6; W4).
25. **Uploads and AI stay off** until the owner's checkpoint 3 (QG-AI review) and W4's security
    review; both are wired and gated.
26. **Filler pre-check** stays off until the owner confirms the labels (QG-CLEAN precision on
    agent labels 0.933).
27. **The caption's default spot is inside the TikTok zone** (83 % down; the zone starts at 78 %):
    seeds keep today's caption position (K5) so an unchanged clip exports the auto file (R10), and
    every export lists "Caption masuk ke area tombol TikTok" in "Perlu dicek". Moving the default
    changes every clip's look: owner decision.
28. **The real-stack flow (`editor-flow.spec.mjs`) was not re-run after the verifier fixes**: it
    renders with FFmpeg on the owner's PC (heavy-work rule). The fixes are covered by unit tests,
    the fakes specs on the CI-built app, the harness specs and the CI gate run below; the next
    real-stack pass (owner's walkthrough at checkpoint 3, or W4's) covers them on a real job.

## W3 verifier findings: fixes (2026-10-01)

The verifier re-ran W3 at `e4fbbbc` and found three majors and five minors (both suites green).
All eight are handled on `editor-w3-integration`, test first; seven are fixed, PF-AUDIO is
re-recorded as borderline.

| Finding | Fix | Tests and gates | Result |
|---|---|---|---|
| **Major**: the MUSIK lane can never be seen (1366×768, 1920×1080); a scrolled scroller moves every label a row off its lane | `.timelineBody` aligns its columns to the top: labels and the lanes' scroller take their content's height and scroll together; the scroller has nothing to scroll on its own | `editor-markers.spec` "timeline layout" at both sizes (every label beside its lane, the last lane inside the scroller and the body after scrolling, scroller `scrollTop` stays 0); `editor-music.spec` U5 now asserts the lane on screen: lane 738–768 = label 738–768 at 1366×768 | **fixed** (`W3fix-QG-UX-U5-music-*.json`) |
| **Major**: a prepare that ends with the clip closed leaves "Menyiapkan" up for 12 min; a source FFmpeg cannot read is called "Video sumber sudah tidak ada" | `open-clip.prepareForEditor` reads the `POST /clips` answer and shows the clip's reason at once; new reason `source_unreadable` ("Video sumber tidak bisa dibaca; proses ulang videonya") when the source exists but cannot be probed (CONTRACTS §5.20) | `editor-open-clip.test` (reason by number or id, no polling, unknown → `prepare_failed`), `clip-edit.test`, `test_edit_v2_seed` (garbage source → `source_unreadable`), `test_edit_v2_contracts` | **fixed** |
| **Major**: all four logo presets and a new logo's spot are inside the TikTok zone | `SnapLogo` rests against the zone's right/top/bottom edges (4 % from the left); `SetLogo` places a new logo on the top-right preset (box (512, 93) for 512×512 at 720×1280); "Perlu dicek" names caption, hook or logo | `editor-commands.test`, `editor-logo.test` (every preset and new logo outside the zone for 6 shapes × 5 widths × 2 sizes whenever the logo fits), `editor-logo.spec` 16 passed with axe (U5 logo 3.0 s), G5 re-run 450 cases, 0 mismatches (run 36878186098) | **fixed** (`W3fix-G5.json`, `W3fix-QG-UX-U5-logo-*.json`); the caption default stays in the zone (Open 27) |
| Minor: FFmpeg 6.1.1 aborts the frame-grid check on an AV1 source (`-threads 4`) | a failed threaded grid run is run once more on one thread | `test_edit_v2_source_info` (retry, and a failure on one thread too); local check on job `860fef1a` (read only, FFmpeg 6.1.1): head run threads 4 rc −6, threads 1 rc 0, tail threads 4 rc 0; grid recorded in 1.9 s | **fixed** (`W3fix-grid-av1-local.json`) |
| Minor: PF-AUDIO recorded as a pass | the row says borderline with both runs | the verifier's run 36870736233: p95 1,199.5 ms (load 3.3–4.6) | **re-recorded** (`W3Z-PF-AUDIO-rerun.json`; W2 Open 22, T4.3) |
| Minor: the Penanda note sits under the markers | with markers, the lane's note moves to the timeline header (`onNote`); without markers it stays in the lane | `editor-markers.spec`: the note is visible, not truncated and overlaps no marker | **fixed** |
| Minor: "(−2.20 dB)" in "Perlu dicek" and the export dialog | `messageFor` writes measured details the Indonesian way: "(−2,2 dB)", "(−16,3 LUFS)" | `editor-shell-model.test`, `editor-shell.spec` export test | **fixed** |
| Minor: "Unduh MP4" saves a hash name | the file route takes a checked `name`; the export dialog, its earlier exports and the project page save `klip-NN-revisi-R.mp4` / `.srt` | `final-files.test` (valid and hostile names), `editor-clip-entry.test`, `editor-shell.spec`: the download is `klip-01-revisi-1.mp4` | **fixed** |

**Where it ran.** CI on GitHub Actions at `95ad2a3` (the last code commit; later commits are
specs, this document and evidence): `ci-gate full` run 36878146602 **success** (ruff "All checks
passed!"; pytest on Python 3.11 "4272 passed, 2 skipped, 1 xfailed"; npm test on Node 20 "# pass
1147", "# fail 0"; build "✓ Compiled successfully"); `ci-gate image` run 36878193964 **success**
("4270 passed, 4 skipped, 1 xfailed" in the production image, FFmpeg 5.1.9); gate command run
36878186098 (`w3_exit_gates.sh logo markers web`: logo vectors up to date, logo
pytest, G5 450/0, logo node 20/20, markers node 25/25, markers pytest, the standalone app). Owner's
PC, one browser at a time (Chrome for Testing 147.0.7727.15) against that CI-built app with the
fakes on a private port: `editor-shell` 34 tests (33 passed on the first run; the project-page test
still expected the hash link and passes with the new name), `editor-music` 13 passed, 1 skipped
(+ U5 at both sizes with the lane check), `editor-layout` 16 passed, `editor-ai` 11 passed;
harness specs `editor-logo` 16 passed (axe on), `editor-markers` 17 passed, 3 skipped (real-data
blocks; axe on in a separate run). QG-A11Y on the fakes: 16 states, 0 critical, 0 serious
(`W3fix-QG-A11Y-shell.json`); logo and music panels 0 serious (`W3fix-QG-A11Y-logo.json`,
`W3fix-QG-A11Y-music.json`).

### Patches by the W3 integrator (continued)

53. `shell.module.css` `.timelineBody { align-items: flex-start }`; `Timeline.jsx` test hooks and
    lane notes in the header (`onNote`); `MarkerLane.jsx` moves its note there when it has markers.
54. `open-clip.mjs` reads the prepare answer; `source_unreadable` in `errors.py`, `seed.py`,
    `api.py` (doc), `clip-edit.mjs`, `clip-entry-view.mjs`, `shell-model.mjs`.
55. `source_info._grid_pts` retries a failed threaded run on one thread.
56. `commands.mjs` `SnapLogo`/`SetLogo`, `logo-geometry.mjs` corner presets outside the zone; the
    logo specs and tests follow (presets (29|512, 93|885) for a 115 px logo at 720×1280).
57. `shell-model.mjs`: `checksView` names the element in the zone; `messageFor` localises numbers.
58. `final-files.mjs` `name`; `clip-entry-view.exportDownload`; `ExportDialog` (`clipIndex`),
    `EditorApp`, the project page.
59. `web/tests/asset-upload.test.mjs` (T3.1) and `web/tests/preview-lane.test.mjs` (W2): one session
    token per file. The helpers made a token per request, and a token changes when the clock
    passes a second, so a rate-limit test that crossed a second used two keys: the full run on
    `83ad2d5` (run 36880261354) failed "uploads are rate limited per session" with 200 instead of
    429 (the run on `95ad2a3` passed it). Assertions unchanged. `ci-gate full` on `d257283` (run
    36892302530): **success**; ruff clean, pytest "4272 passed, 2 skipped, 1 xfailed", npm test
    "# pass 1147", "# fail 0", build compiled. Two runs before it on `d257283` were cancelled
    after the runner stalled (36882605320 in the Python step for 45 min, 36888344104 in
    `apt-get install ffmpeg` for 30 min; no test output, infrastructure).


---

## W4 T4.1: the candidate editor's backend retired (2026-10-02)

Branch `editor-w4-t4.1` on the W3 end (`105b567`). Owner decision (W4, binding): the old
candidate editor is retired, its web side already gone on `main`; T4.1 does **not** fix its eight
bugs (plan §8, legacy column) but removes the backend code only that editor used, keeps old jobs
viewable and downloadable, and keeps the benchmark baselines working. The eight bugs leave with
the editor; the new editor fixes them by construction (plan §8, V3 column, gated in W1–W3).

**Removed** (code and tests at `1189731`: 37 files, −7,874 / +1,457 lines):

| What | It was | Reached only from |
|---|---|---|
| `src/ai_clipper/editor_api.py` | the candidate edit CLI (edit manifest PUT/GET, receipts) | `/api/jobs/:id/candidates/:cid/edit` (retired on `main`) |
| `src/ai_clipper/edit_manifest.py` | the `clip-edit-v1.0` manifest contract and store | `editor_api`, `render_manifest`, the v1/v2 queue |
| `src/ai_clipper/render_manifest.py` | the manifest renderer (its ASS, logo, loudnorm: bugs 1–6, 8) | the worker's v1/v2 branch |
| `src/ai_clipper/candidate_api.py` | the candidates presentation CLI | `/api/jobs/:id/candidates` |
| `src/ai_clipper/candidate_cues.py` | the caption-cue sanitizer CLI | `.../candidates/:cid/caption-cues` |
| `src/ai_clipper/candidate_feedback.py` | the accept/reject log CLI | `/api/jobs/:id/candidate-feedback` |
| `render_queue.py`: `render-request-v1`/`-v2` (create, update, publish, estimate, candidate and source snapshots, the `--job-dir` protocol) | the candidate exports | `.../candidates/:cid/renders`, the legacy status read |
| `render_worker.py`: the manifest branch (`renderer`, `verifier`, `_verify_existing`, `_output_parent`, `_heartbeat_loop`, `analysis/render-staging`) | rendering a candidate export | v1/v2 requests |
| `web/lib/render-requests.mjs` | the v1/v2 schema, its `--job-dir` bridge (spawned outside `python-cli.mjs`), the create, the legacy status DTO | the retired renders route, the status route's legacy branch |
| tests | `tests/test_{editor_api,edit_manifest,render_manifest,candidate_api,candidate_cues,candidate_feedback}.py`, the candidate-request cases of `test_render_queue.py` and `test_render_worker.py`, `web/tests/{render-requests,legacy-spawn-env}.test.mjs` | — |

**Kept, and why:**

- The V1/V2 selection code (`highlight`, `candidates`, `features`, `ranking`, `media_features`):
  queued or retried old jobs still run with their mode (`--selection-mode v1`/`v2-shadow`, `main`
  `26ac083`), and the benchmark baselines `v1`, `v2-standard`, `v2-viral`, `v2-deep` use it.
- `evaluation.py` (the offline V1-versus-V2 report): it read the old accept/reject feedback
  through `candidate_feedback`; the strict reader moved into it with the same rules (exact
  schema, bound to the exact candidate bytes, known candidates, unique event and request IDs,
  8 MiB cap, no symlink or FIFO).
- The storage helpers the clip store and the queue shared with the old store: moved, unchanged,
  to `src/ai_clipper/job_files.py` (stdlib only). `edit_v2.store`, `edit_v2.api` and
  `render_queue` no longer import `ranking`: the import named in W2 Open 14 (PF-PLAN) is cut,
  70–90 ms per process on the reference PC (`T4.1-import-cut.json`; T4.3 may use it).
- Everything the old editor left in a job is never rewritten: `analysis/edits`,
  `analysis/render-inputs`, `analysis/candidate-feedback.v1.json`, old
  `analysis/render-requests/*.json`, `output/edits/cand_*`. The files route still serves the
  clips, subtitles and old exports.

**Intentional behaviour changes** (listed per the T4.1 rule):

1. `GET /api/jobs/:id/renders/:renderId` of a v1/v2 request answers 404 `not_found` (the body of
   a missing one) instead of the legacy DTO; an unreadable request file answers 503; the route
   never spawns. Its ID check is the editor's (UUID versions 1–8). It stays ungated by the flag.
2. `python -m ai_clipper.render_queue` with any argument exits 2 with `render_queue_usage`.
3. A v1/v2 file in a queue must still be strict canonical JSON (else the queue is invalid, as
   before), but it is never claimed, listed, cancelled, pruned or rewritten; `get` answers not
   found. A queued or stale-claimed old request is never rendered.
4. Storage: one predicate (`shared-storage-accounting.requestReleasesReservation`) for the render
   admission and the shared accounting: a finished v3 export, or a v2 request in any state,
   releases its reservation (a queued v2 one would otherwise hold its bytes forever). The shared
   accounting therefore also stops counting finished v3 exports, which it counted until the next
   render admission swept them (`docs/operations/STORAGE_RETENTION.md`).
5. `MAX_UPLOAD_BYTES` is read by no Python child any more (the v1/v2 source snapshot was its only
   reader); it is still in `CHILD_ENV_ALLOWLIST` (T4.2's file, request below).

**Tests (test first: `1466104` Python, `7911a20` web, then the code):**

| Proof | Test | Result |
|---|---|---|
| The six modules are gone; queue and worker expose no candidate API; the editor backend imports no ranking/selection code | `tests/test_retired_candidate_editor.py` | pass |
| Old queues: v1/v2 files never claimed, listed, cancelled or pruned, byte-identical after; a v3 export beside them works; malformed or symlinked v1/v2 files still invalid; `--job-dir` refused | `test_render_queue.py` (2 new, the module-CLI test extended) | pass |
| The worker leaves old requests alone (same queue and another old job), skips jobs without `analysis/` and directories that are not jobs | `test_render_worker.py` (2 new) | pass |
| Old projects (no mode; v2-shadow with every leftover of the old editor) load through the real job route with every clip, no old score, no version notice; clips, subtitles and the old export download; the clip listing (real Python CLI) offers no editor link; old render statuses 404; the old queue untouched; no web code knows the retired protocol | `web/tests/old-jobs.test.mjs` | pass |
| Render status: v3 from the file, v1/v2 as missing, no spawn | `web/tests/clip-renders.test.mjs` | pass |
| Reservations: v3 terminal reaped, v3 live kept, v2 reaped in every state, owner and token checked; shared accounting counts live exports only | `web/tests/render-storage-admission.test.mjs` | pass |
| `python -m ai_clipper.benchmark --compare` runs `v1`, `v2-standard`, `v2-viral`, `v2-deep`, `v3-heuristic` on two episodes, every run completed | `test_benchmark.py::test_cli_compare_runs_the_builtin_baselines_as_a_module` | pass |
| Old feedback still read strictly by the evaluation report (13 tampered shapes, duplicate keys, 8 MiB cap, symlink, FIFO) | `test_evaluation.py::test_old_candidate_feedback_is_read_strictly` | pass |
| `job_files` keeps the old store's rules (symlink, FIFO, oversize, directory trust, parent fsync and its retry, atomic replace) | `tests/test_job_files.py` | pass |
| In a browser: an old project (a copy of the owner's job `d1e45678`, no selection mode, 5 clips) and a synthetic old v2-shadow project with every leftover of the old editor render every card, play the first clip, send old editor links to the project page, 404 the six retired routes, and make no API call answer ≥ 400 | `e2e/read-only.spec.mjs` + `e2e/smoke.spec.mjs`, desktop and mobile, against the CI-built app (run 36898941555) | 10/10 per job (`T4.1-old-jobs-browser.json`) |

Generic properties the candidate-request tests carried were ported to v3 requests, so none lost
coverage: one winner per claim, a fenced expired owner, strict JSON, long-render heartbeats on the
queue clock, the storage time cadence, byte growth, storage lost mid-render, a release transport
failure. The flaky-test entry of `docs/ROADMAP.md` §6
(`test_worker_heartbeats_during_long_render_and_prevents_reclaim`, already on the queue clock since
W3 patch 47) is now `test_v3_worker_heartbeats_during_a_long_render_and_prevents_reclaim`.

**Where it ran.** CI on GitHub Actions at `1189731` (the last code commit; later commits are this
document, the README, CONTRACTS, STORAGE_RETENTION and evidence): `ci-gate full` run 36898607754
**success** (ruff "All checks passed!"; pytest on Python 3.11 "4170 passed, 2 skipped, 1 xfailed";
npm test on Node 20 "# pass 1154", "# fail 0"; build "✓ Compiled successfully"); `ci-gate image`
run 36898617856 **success** ("4168 passed, 4 skipped, 1 xfailed" in the production image). The
counts against W3's (4,272 / 1,147) are the removed suites minus the new and ported tests. Owner's
PC: targeted tests only, the import timing (`T4.1-import-cut.json`) and one browser pass on the
standalone app the image built (`editor-gates` command run 36898941555; table above). The first
browser pass on the copy of `d1e45678` failed the no-version-wording check on desktop and mobile
because of the project's own name, which the owner typed as "… V1 lama (pembanding)"; user text is
not UI wording, and with the copy renamed all 10 passed (the original job was only read).

### Phase-B requests (T4.1 → others)

| To | Request |
|---|---|
| T4.Z | Approve the CONTRACTS changes (§A.1 CLI row, §4.1 layout, `GET /clips` `not_v3`, `GET /renders/:renderId`, render-request-v3 retention/flag/storage notes). |
| T4.Z | The W4 exit gate's "8/8 legacy regression tests" and the legacy e2e (`mutation.spec.mjs`, deleted on `main`) no longer apply: the proofs above replace them. Tick plan §8 as "retired" in `docs/ROADMAP.md`; update ROADMAP §6's test name (above) and HANDOFF §3/§4 ("modul backend lama dibiarkan dulu"). |
| T4.2 | `MAX_UPLOAD_BYTES` can leave `CHILD_ENV_ALLOWLIST` (`web/lib/python-cli.mjs`); no child reads it now. |
| T4.3 | PF-PLAN: the store/api import of `ranking` is gone (`T4.1-import-cut.json`); re-measure with it. |
| T4.4 | README's editor section and the final CONTRACTS/PANDUAN: the README paragraph on the retired editor is updated here; nothing in `PANDUAN-EDITOR.md` named the removed code. |
| any W4 branch | Import `ai_clipper.job_files` (`read_regular`, `fsync_directory`, `ensure_directory`, `atomic_write`, `validate_analysis_dir`; errors `JobFileError`/`JobFileInvalid`/`JobFileNotFound`) instead of `edit_manifest`'s private helpers. |

---

## W4 T4.3 "Performa dan retensi" (phase B, 2026-10-02)

Branch `editor-w4-t4.3` off `105b567` (the W3 verifier fixes). Owner decision for W4: the auto
render switches to the new engine (`POTONGIN_RENDER_ENGINE=edit-v2`, flipped by T4.Z) once
PF-PIPELINE is within budget per layout **on the K15 PC** (fit-blur and center-crop ≤ 1.35×,
face-track ≤ 1.6×, real sources), without changing the delivered pixels.

Where it was measured (the owner allowed heavy local runs overnight, one at a time): the K15
reference PC (Ryzen 7 5700G, 8 cores / 16 threads), shared with other agents' work (load
averages per job in the evidence, mostly 6–12 during the rounds). Toolchain of record: the
production image `ai-video-clipper:editor-w3-t31-r2` (FFmpeg 5.1.9, libass 0.17.1, Python 3.11.2,
node 20) with this branch's `src` mounted over `/app/src`; the copies of the owner's five P3 jobs
(e7f0d37b, 899226f8, 860fef1a, 3c7d024c, 990f3f37; the originals only read) in scratch.

### What changed (no FFmpeg argument, graph or encoder setting changed)

- **The auto render runs the clips of a job at once** (`render_edit.AutoRenderer.schedule`,
  CONTRACTS §5.21): heavy slots (a final encode or a camera plan, ~4 CPUs each) =
  `ceil(CPU budget / 4)`, at most 4 (16 threads → 4, the compose quota of 6 → 2, 4 vCPU → 1),
  plus one worker that seeds or verifies meanwhile; the longest clips start first. The pipeline
  keeps its loop, order, per-clip fallback and manifest.
- **Verify** reads the probe, the packet list and the audio at the same time, and decodes the
  frame count on the whole CPU budget (a 2,440-frame clip: 1.7 s at 4 threads, 0.9 s at 16).
- Measured and dropped: a lower priority (nice 5) for all but the longest clip (no gain in an
  A/B of 3 + 3 runs: the job is CPU-bound); three slots (the fourth clip of a job ran alone:
  center-crop 39.9 s against 29.6 s with four).

### Summary table

| Gate | Threshold | Measured | Evidence | Result |
|---|---|---|---|---|
| **PF-PIPELINE fit-blur** | ≤ 1.35× per job | median of 3 rounds: 23.976 fps **1.03×** (1.02–1.03), 25 fps **1.02×** (1.00–1.02), 60 fps **0.59×** (0.56–0.60); before this task 1.76×, 1.80×, 0.99× on this PC (W2: 1.68×, 1.41×, 0.89×) | `T4.3-PF-PIPELINE.json` | **pass** |
| **PF-PIPELINE center-crop** | ≤ 1.35× | VFR → 30 fps job, 4 clips: **1.28×** (1.27–1.30; legacy 21.4–21.7 s, new 27.5–27.8 s); the 5 earlier rounds without the verify change 1.32× (1.28–1.35); before 2.24× (W2 1.79×) | `T4.3-PF-PIPELINE.json` | **pass** (the thinnest layout) |
| **PF-PIPELINE face-track** | ≤ 1.6× | 5 clips: **1.12×** (1.11–1.21); before 2.35× (W2 2.06×) | `T4.3-PF-PIPELINE.json` | **pass** |
| Delivered files unchanged | byte-identical | every MP4 and SRT of every round equals the render of the code before this task (one clip at a time): **200/200** (8 rounds on 16 threads + 2 under the quota, 20 clips each); unit test: two clips at once = one at a time (frames, PCM, bytes, SRT) | `T4.3-PF-PIPELINE.json` `same_files`, `test_edit_v2_render_edit.py` | **pass** (P-RT/R10, P-ENC, P-COLOR and the goldens are untouched: same argv, same bytes) |
| PF-PIPELINE under the compose quota (`--cpus 6`, indicative) | (production containers) | 2 rounds: fit-blur 1.34×, 1.29×, 0.65×; **center-crop 1.99×; face-track 1.82×** | `T4.3-PF-PIPELINE.json` `cpu_quota_6` | **fails** two layouts: the new engine needs more CPU (below); owner decision (open item 30) |
| PF-AUDIO with music | ≤ 1,000 ms p95 | 90 s clip, 16 edits: **p95 906.2 ms** (p50 894.2); speech only 618.1 ms; load 2.9 | `T4.3-PF-AUDIO.json` | **pass** (thin; CI's 4 vCPU runner measured 835–1,200 ms in W3) |
| PF-PLAN (server) | ≤ 200 ms p95 | HTTP p95 **40.1 ms** (120 documents, persistent worker) | `T4.3-PF-PLAN.json` | **pass** |
| PF-TRUTH | ≤ 600 ms p95 | p95 **387.6 ms** (36 frames, 3 layouts) | `T4.3-PF-TRUTH.json` | **pass** |
| PF-CELLS | ≤ 15 s (fit-blur, center-crop), ≤ 25 s (face-track) | fit-blur 60 fps **11.49 s**, center-crop 7.81 s, face-track **13.29 s** with the camera plan (6.66 s without) | `T4.3-PF-CELLS.json` | **pass** |
| PF-OPEN | first visit ≤ 3.0 s p95, repeat ≤ 2.0 s, first cell ≤ 2.0 s | VFR job, 5 never-opened clips: first visit p95 **2,437 ms**; first p95 1,039 ms, repeat p95 932 ms, first cell 850 ms (fresh e7f0d37b copy: 2,485 / 1,080 / 962 / 879 ms) | `T4.3-PF-OPEN.json` | **pass** |
| Plate cells under RLIMIT_AS (T2.4's request) | a 4-run cell job builds under 3 GiB | fit-blur needs 2.0–2.25 GiB, face-track and center-crop < 2 GiB | `T4.3-RLIMIT-cells.json` | **pass** (≥ 0.75 GiB headroom) |
| Retention soak | 1,000 saves + 50 exports + cache churn inside the caps | 1,000 saves (a simulated 8 h 20 min autosave session, one save every 30 s), 50 exports (all completed, p50 10.5 s), 1 GiB of preview churn under a 64 MiB cap, a janitor tick every 100 saves: cache ≤ cap at all 10 ticks; committed receipts ≤ 200 and none pending; archives ≤ 65 per clip (revision 1 + newest 50 + the 16–17 that exports name); 50 requests; 31 days later 100 suggestions and 3 unused assets removed, none left; janitor tick ≤ 21 ms; save p95 14.5 ms in process | `T4.3-retention-soak.json` | **pass** |

The app for the lane gates and PF-OPEN: the branch's standalone build in the image, app container
`--cpus 6` (the compose quota) with the persistent preview worker, the lane harness in the same
image `--cpus 4`, Chrome for Testing 147.0.7727.15. Earlier evidence still stands for PF-SAVE,
PF-SEEK, PF-PLAY, PF-LIBASS and PF-MEM (W2; the player, the store and the text layer did not
change); `node scripts/perf/editor_budgets.mjs` prints every budget with its newest evidence.

**CPU per job** (children of the stage, plus the process for face-track, final rounds): fit-blur
1.6× legacy at 24/25 fps (R7 crf 18 + chroma offset, the gbrp composite and lanczos 4:2:0),
1.06× at 60 fps (the new engine renders 30 fps); center-crop **2.5×** (the same, plus 25 % more
frames: the VFR source becomes 30 fps CFR); face-track **2.2×** (the camera plan's Haar
detection over the whole window). On 16 threads the clips overlap and the job takes about as
long as the legacy job; under a 6-CPU quota the new engine is CPU-bound, which the
`cpu_quota_6` rounds show. No speed-up that keeps the delivered bytes is left in the encode
itself: every FFmpeg argument (x264 threads, filters, scale flags) is part of the pixels.

### The janitor and the retention soak

`python -m ai_clipper.edit_v2.janitor` (CONTRACTS §5.21; plan §4.4): per clip under its document
lock, receipts (200 committed + pending), archives (revision 1, render-referenced, newest 50),
suggestions after 30 days, preview caches unused for 30 days and the job cap, temporaries and
cancel markers after 10 min; assets unreferenced for 30 days under the asset store's lock. The
primary worker runs it between jobs (slot 0, at most every 6 h, never while a job is active or
being claimed; claims wait while it runs). `docs/operations/STORAGE_RETENTION.md` names it as the
editor's own retention, which never removes a job, its source, its analysis, its renders or an
export. Tests: `tests/test_edit_v2_janitor.py` (26), `web/tests/primary-worker-janitor.test.mjs`
(7).

### Also in this task

- **W3 Open 24 fixed**: a plan answer that finds a cell, the mix or the derived logo missing on
  disk forgets that it was built, so the lane queues it again at once (`preview-lane.test.mjs`).
- **OpenCV threads**: overlapping face windows keep OpenCV at one thread until the last ends
  (`face_window.one_opencv_thread`).
- Tools: `scripts/perf/pf_pipeline.py` (rounds, byte check, evidence),
  `scripts/perf/retention_soak.py`, `scripts/perf/editor_budgets.mjs`.

### Suites

- On GitHub Actions at `3225b52` (the concurrent render, verify, janitor, lane fix and tools):
  `ci-gate full` run 36907633864 **success** (ruff "All checks passed!"; pytest on Python 3.11
  "4309 passed, 2 skipped, 1 xfailed"; npm test on Node 20 "# pass 1155", "# fail 0"; build
  "✓ Compiled successfully"); `ci-gate image` run 36911044239 **success** ("4307 passed,
  4 skipped, 1 xfailed" inside the production image, FFmpeg 5.1.9).
- At `e064ba7` (+ the janitor's never-edited clips, the health snapshot, the soak clock):
  `ci-gate full` run 36913459891 **success** (pytest "4310 passed, 2 skipped, 1 xfailed"; npm
  test "# pass 1156", "# fail 0"); `ci-gate image` run 36913500400 **success** ("4308 passed,
  4 skipped, 1 xfailed" in the production image).
- At `88afca6` (the last code commit: the janitor reads only the queue's archive paths):
  `ci-gate full` run 36914779612 **success** (ruff "All checks passed!"; pytest on Python 3.11
  "4311 passed, 2 skipped, 1 xfailed"; npm test on Node 20 "# pass 1156", "# fail 0"; build
  "✓ Compiled successfully"). Later commits are this document only.
- Locally (targeted): `tests/test_edit_v2_render_edit.py`, `test_pipeline_v3.py`,
  `test_edit_v2_verify.py`, `test_edit_v2_camera.py`, `test_edit_v2_janitor.py`;
  `web/tests/{primary-worker,primary-worker-janitor,python-cli,preview-lane}.test.mjs`.

### Open (W4 T4.3)

29. **PF-AUDIO margin**: 906 ms p95 on this PC against 1,000 ms (W2 Open 22's levers remain:
    splitting the true-peak measurement per channel, which needs a producer with several
    consumers; caching a clip's decoded runs). Measured here: the true peak adds ~165 ms to the
    ebur128 pass over a 90 s stereo mix (FFmpeg 5.1.9: 0.37 s with, 0.20 s without); the FLAC
    level does not matter (0.169 s default, 0.176 s level 0).
30. **Production quota**: under `cpus: 6` (compose `primary-worker`) the new engine is 1.8×
    (face-track) and 2.0× (center-crop) the legacy engine: raising that quota (the slots follow
    it, up to 4 at 16 CPUs) or accepting the slower auto render is the owner's call before the
    engine flag reaches production.
31. **Center-crop margin on this PC**: 1.28× against 1.35× with other agents' load on the PC
    (6–12); a quieter PC measures lower, a busier one higher.
32. Not built: the persistent preview worker was already in place (W2); the two heavy semaphores
    (W2 Open 23) stay separate; the 10-frame plate GOP (W2 Open 13) stays out (PF-SEEK passes).

---

## W4 "Siap rilis": exit gate (T4.Z, 2026-10-02)

Branch `editor-w4-integration`. T4.1 → T4.2 → T4.3 → T4.4 → T4.5 cherry-picked in that order onto
the W4 base `105b567` (50 commits, linear, `rerere` on), then the integration commits (patches
60–66 below). `origin/main` (`b1ab3e0`) was already an ancestor of the base, so the rebase onto
`main` changed nothing. Three conflicts, all at seams the tasks named: `GATES.md` (T4.1 and T4.3
both appended a section; both kept), `tests/test_render_worker.py` (T4.4 changed a legacy test
that T4.1 removed; patch 61) and `CONTRACTS.md` (T4.3 and T4.4 both wrote a §5.21; patch 62).

Owner decisions that changed W4 (binding): (1) the old candidate editor is retired, so T4.1
removed its backend instead of fixing its 8 bugs, and the plan's "8/8 legacy regression tests"
and legacy e2e gates are **retired** with it (T4.1's proofs replace them: old jobs open, play and
download in a browser 10/10 and through the routes 4/4, the benchmark baselines run; acceptance
capability 11 shows the eight bugs cannot happen in the new editor); (2) the auto render becomes
`edit-v2` once PF-PIPELINE is within budget per layout on this PC, with the look change and the
larger R7 files accepted (this is K1); (3) release with each flag on where its gate passes, the
filler pre-check off; (4) the editor entry of W3 stays; (5) the K5 caption spot stays and its
warning becomes a note.

Where it was measured: the suites and the FFmpeg gates on GitHub Actions (4 vCPU runners; times
there are indicative); the performance budgets on the K15 PC (T4.3, overnight, one run at a
time); the browser acceptance on the owner's PC against a production build with copies of real
jobs (T4.5 on its branch, T4.Z on the integrated branch, below).

### Release defaults and the gate behind each

| Flag (`compose.yaml`) | Default | Gate | Evidence | Result |
|---|---|---|---|---|
| `POTONGIN_EDITOR_V3` | `on` | the W1–W4 exit gates (table below) | this file | **on** |
| `POTONGIN_EDITOR_UPLOADS` | `on` | QG-SEC complete (T4.2), re-run on the integrated head | `T4.2-QG-SEC*.json`, run 36920184986 | **on** |
| `POTONGIN_EDITOR_LLM` | `on` | QG-AI hard gates: offline 0 ungrounded and 0 malformed accepted (100 scripted answers, `tests/test_editor_ai.py` in the image); online instant p95 209 ms (≤ 300), LLM p95 10.1 s (≤ 15), 0 over 20 s; the T4.Z real-stack run: the free chain answered with 5 cards | W3 rows above, `T4.Z-real-stack-e2e.json` | **on**; the owner's 30-clip review follows at checkpoint 3 |
| `POTONGIN_RENDER_ENGINE` | `edit-v2` (app, primary worker, render worker) | PF-PIPELINE per layout on the K15 PC: fit-blur 1.03×/1.02×/0.59×, center-crop 1.28×, face-track 1.12×; delivered files byte-identical (200/200); K1 approved by decision (2) | `T4.3-PF-PIPELINE.json` | **on** (the production CPU quota is an owner item: Open 30) |
| Filler pre-check (`resources/lexicon/id-fillers.v1.json` `precheck`) | `false` | the owner confirms the labels (QG-CLEAN precision ≥ 0.9 on them) | `web/tests/editor-w3-wiring.test.mjs` | **off** |

`.env.example` lists each default and the value that switches it off;
`docs/editor/OPERASIONAL.md` §2 gives the commands (`.env` line, `docker compose up -d`, no
rebuild) and the rollback (revert the PR).

### Final evidence table (plan §10, newest measurement per gate)

| Gate | Threshold | Newest measurement | Where | Result |
|---|---|---|---|---|
| **P-FRAME** | 0 mismatches, ≥ 2,000 frames (300 on PR) | W3 per layout 7,572 frames, 0; PR smoke 940 frames, 0 (T4.4, run 36901027617; PR #18 run 36921940571 pass) | `W3Z-P-FRAME.json`, CI | **pass** |
| **P-TIME** | 0 mismatches | 0 / 570 events (FFmpeg) and 0 / 231 transitions (JASSUB), stamped toolchain evidence | `toolchain/P-TIME-*.json` (run 36899253661) | **pass** |
| **P-TXT** | SSIM ≥ 0.999, PSNR ≥ 45, max ≤ 16, 0 px > 16 | 120 frames gbrp: SSIM 0.999948, max 14 | `toolchain/P-TXT.json` | **pass** |
| **P-ENC** | whole ≥ 0.990, text ≥ 0.980, ≤ 0.002 below the W1 baseline | min whole 0.99017, text 0.98682 | `toolchain/P-ENC.json` | **pass** |
| **P-COLOR** | \|Δ\| ≤ 4 | worst mean 1.654 | `toolchain/P-COLOR.json` | **pass** |
| **P-PLATE** | crop x 0 px; SSIM margin ≥ 0 | 5 cases incl. switched seeds, margins 0.00198–0.00200 | `W3Z-P-PLATE.json` | **pass** |
| **P-LOGO** | box 0 px, mean ≤ 2, max ≤ 8 | 17/18 frames; 1 frame max 9 from captions under the logo's transparent pixels | `T3.2-P-LOGO.json` | **fail, owner decision** (Open 23) |
| **P-AUD** | md5 equal; samples = plan; browser ≤ 1 LSB | md5 equal 6/6; `02-vfr-bed` 16 samples short on preview and reference alike; browser 0.707 LSB (W2) | `W3Z-P-AUD.json`, nightly run 36920054208 | **fail** (Open 12, the only red nightly gate) |
| **P-SYNC** | ≤ 1 frame p99 | p99 0.34–0.36 frames | `T2.Z-P-SYNC.json` | **pass** |
| **P-RT / R10** | identical frames and PCM; 100 % hard links | toolchain suite P-RT 6/6, R10 27/27; T4.3 200/200 byte-identical; acceptance: the unchanged clip exports the auto file (same inode) | `toolchain/P-RT.json`, `T4.3-PF-PIPELINE.json` | **pass** |
| **P-LOOK** (K1) | thresholds + owner approval | kit thresholds fail by design (W2); the owner accepted the look change and the R7 files (decision 2) | `T2.1-P-LOOK.json` | **approved by the owner** |
| **G1–G3, G3b, G5** | §5.9 | every export through the worker; T4.Z acceptance: G1/G2 pass on every export, G3b with music pass, G5 warns as designed | `T4.Z-real-stack-e2e.json` | **pass** |
| **G-SYNC** | A/V end ≤ 1 frame | A/V end 9.9 ms after 20 Rapikan items | `W3Z-QG-CLEAN-synthetic.json` | **pass** |
| **G-CLICK** | < −40 dBFS | worst −59.94 dBFS over 52 joins with music | `W3Z-G-CLICK.json` | **pass** |
| **G-DET** | identical digests; preview ASS = export ASS | 8 cases × 3 processes, 0 differences; PR smoke pass | `W3Z-G-DET.json`, CI | **pass** |
| **G-FAIL** | fixed code + Indonesian message on every failure path | unit tests in the suites (`errors.py` codes and their drift-tested JS mirror) | suites | **pass** |
| **Duck** | ±0.5 dB; recovery ±1 dB | worst 0.361 dB | `W3Z-duck.json` | **pass** |
| **QG-PERSIST** | 5,000 saves; receipts ≤ 200 | HTTP 5,000/5,000 (W2); retention soak 1,000 saves + 50 exports inside every cap (T4.3) | `T2.2-QG-PERSIST-http.json`, `T4.3-retention-soak.json` | **pass** |
| **QG-UNDO** | 10,000 sequences | 0 mismatches; 23,258 documents accepted by Python | `T2.5-QG-UNDO.json` | **pass** |
| **QG-CONFLICT** | both edits survive or the dialog asks | two-tab e2e pass (W2, W3, T4.Z flow run) | `T4.Z-real-stack-e2e.json` | **pass** |
| **QG-SEC** | complete (§9) | fuzz 66 cases, 0 5xx; 491 route checks, 0 failed; 716 answers without a leak; 312 children, 0 names outside the allowlist; editor headers 3/3 in a browser. Re-run on the integrated head `0867dd7` (`scripts/editor/w4_qg_sec.sh`, run 36920184986): fuzz 66/66 at both levels with 0 5xx, 491 route checks with 0 failed, 312 children with 0 names outside the allowlist, 0 dashboard values and the LLM key only in the AI task children | `T4.2-QG-SEC*.json` | **pass** |
| **QG-AI** | hard gates; owner review ≥ 21/30 | hard gates pass (row above) | W3 rows | **pass**; owner review **pending** (checkpoint 3) |
| **QG-CLEAN** | 0 particle/reduplication FP; filler precision ≥ 0.9 | 0, 0, 0.933 on agent labels | `W3Z-QG-CLEAN-labels.json` | **pass**; pre-check **off** until the owner confirms |
| **QG-A11Y** | 0 critical/serious; every control by keyboard | 26 states, 0 findings of any impact; keyboard walk of 9 regions per viewport (T4.5; T4.Z re-run 26 states, 0) | `T4.5-QG-A11Y.json`, `T4.Z-real-stack-e2e.json` | **pass** |
| **QG-UX** | U1–U7 limits | scripted on the integrated branch: U1 2.4 s, U2 2.5 s, U3 2.5 s, U4 2.8 s, U5 3.8 s, U6 26.9 s for an 89.3 s clip (≤ 119.3 s), U7 0 commands lost and the reset found in 1.9 s; owner session at checkpoint 3 | `T4.Z-real-stack-e2e.json`, `UJI-PENERIMAAN.md` | scripted **pass**; owner **pending** |
| **PF-OPEN** | 3.0 s / 2.0 s / 2.0 s | 2,437 / 1,039 / 932 / 850 ms | `T4.3-PF-OPEN.json` | **pass** |
| **PF-CELLS** | ≤ 15 s / ≤ 25 s | 11.49 s, 7.81 s, 13.29 s | `T4.3-PF-CELLS.json` | **pass** |
| **PF-SEEK** | ≤ 50 ms p95 | 38.6 ms (W2; the player did not change) | `T2.Z-PF-SEEK.json` | **pass** |
| **PF-PLAY** | 0 drops at cuts | 0 | `T2.Z-PF-PLAY.json` | **pass** |
| **PF-PLAN** | ≤ 200 ms p95 (server) | 40.1 ms | `T4.3-PF-PLAN.json` | **pass** |
| **PF-AUDIO** | ≤ 1,000 ms p95 | 906.2 ms (K15 PC); a busy 4 vCPU runner measured up to 1.2 s | `T4.3-PF-AUDIO.json` | **pass** (thin, Open 29) |
| **PF-TRUTH** | ≤ 600 ms p95 | 387.6 ms | `T4.3-PF-TRUTH.json` | **pass** |
| **PF-SAVE** | ≤ 300 ms p95 | 137.9 ms (W2) | `T2.Z-PF-SAVE.json` | **pass** |
| **PF-LIBASS** | ≤ 12 ms p95 | 6.3 ms (W2) | `T2.Z-PF-LIBASS.json` | **pass** |
| **PF-RENDER** | report | p50 0.171×, p95 0.299× (W2) | `T2.Z-PF-RENDER.json` | **within budget** |
| **PF-PIPELINE** | 1.35× / 1.6× per layout | 1.03× / 1.02× / 0.59×, 1.28×, 1.12× on the K15 PC; under `--cpus 6` center-crop 1.99×, face-track 1.82× | `T4.3-PF-PIPELINE.json` | **pass** on the reference PC; quota: owner (Open 30) |
| **PF-MEM** | ≤ 1.2 GB | 1.070 GB (W2) | `T2.Z-PF-MEM.json` | **pass** |
| 8/8 legacy regression tests, legacy e2e | — | retired with the old editor (decision 1); replaced by T4.1's proofs | `T4.1-old-jobs-browser.json` | **retired** |

### W4 phase-B results not summarised elsewhere

- **T4.2 security** (branch `editor-w4-t4.2`, CONTRACTS §5.23): one guard (`secureRoute`) on every
  method under `/api/jobs/:id/clips/**` and `/assets/**`; six findings fixed (401 without
  nosniff, no CORP anywhere, an upper-case job id reaching Python on the media and preview
  routes, `path`/`ref` fields of CLI errors passed through, nine Python-starting routes without a
  rate limit, the AI quota 202 without `Retry-After`, a handler exception reaching the framework's
  500). Gate run 36899557124 and suite run 36899551730 on `f50f898`: green. The first gate run
  (36898041360) failed 3 of 491 checks, all `%2e%2e` answered by the router with a same-origin
  308, now accepted.
- **T4.4 CI and docs** (branch `editor-w4-t4.4`, CONTRACTS §5.22): the PR suite (test,
  toolchain guard, parity smoke: P-TIME, P-TXT subset, 940-frame P-FRAME, G-DET, P-AUD, R10, then
  the JASSUB side in Chrome for Testing 147.0.7727.15 against the image's app) green in 6.8 min
  (run 36901027617); the stamped toolchain evidence (run 36899253661); the nightly passes all 17
  required gates and fails only on the app section's P-AUD (run 36899263216, Open 12); the
  `/licenses` page; the two timing-flaky tests on fake clocks (15/15 and 12/12 under 12 busy
  loops; controls fail).
- **T4.5 acceptance** (branch `editor-w4-t4.5`, CONTRACTS §5.24): 13/13 capabilities on a fresh
  copy of `e7f0d37b` (9.2 min), QG-A11Y 26 states with 0 findings, the W2/W3 `heading-order`
  finding gone, the K5 note; `docs/editor/UJI-PENERIMAAN.md` is the owner's U1–U7 protocol. Runs
  36905745425, 36905012080, 36901341857 (full, green).

### Real-stack e2e on the integrated branch (T4.Z, owner's PC, 2026-10-02 03:00–03:45 WIB)

The owner was away, so the heavy local run was allowed. A production build of `fc09edf`
(`next build`, then `next start` on 127.0.0.1:3291), the render worker from the same tree
(`python -m ai_clipper.render_worker --watch`; the PC's FFmpeg 6.1.1, so the image's gates stay
the CI rows), every flag at its new default (`POTONGIN_EDITOR_V3`, `_UPLOADS`, `_LLM` on,
`POTONGIN_RENDER_ENGINE=edit-v2`), a copy of the saved Pengaturan chain (free models only), and
copies of the owner's jobs: a fresh `e7f0d37b` per run (never opened in the editor) and
`899226f8` without its source video as the closed case; the originals were only read and the
copies deleted afterwards. Chrome for Testing 147.0.7727.15, axe 4.13.0, one browser.

- `web/e2e/editor-acceptance.spec.mjs`: **14/14 in 5.6 min** (13 capabilities + QG-A11Y). Open:
  3 clips, 9.7–17.3 s each including the first prepare, the closed card names "Video sumber sudah
  tidak ada". Hook: instant suggestions at once, the free chain answered with 5 cards. Layout:
  exact after 6.9 s (center-crop), 16.3 s (face-track, analysis included), 1.9 s (back). Music:
  upload 1.5 s, export 17.0 s, G3b pass, 48 kHz. Export: a 48.8 s clip rendered in 16.0 s, Antre →
  Merender → Memverifikasi, the key reused, cancel works, the unchanged clip exports the auto
  file. Eight old bugs: box `&H40000000` with `BorderStyle 3`, escapes, keyword `&H8A5CFF&`,
  54 cues for 133 words, logo derived 115×46, 48 kHz with normalize, the render key changes with
  the compiler, 215 saves keep 200 receipts. Undo depth 200, saved 1.9 s after the last key.
  QG-A11Y 26 states, 0 critical, 0 serious, 0 other.
- `web/e2e/editor-flow.spec.mjs`: **20/20 in 3.4 min**, which also closes W3 Open 28 (the
  flow had not run on the real stack since the W3 verifier fixes). Entry: 3 cards with "Edit
  klip", the unprepared clip opened with the progress in 5.5 s. The editor page is cross-origin
  isolated, nosniff, never framed. W2 flow: the edited 48.8 s clip exported in 19.9 s, G1/G2 pass
  on the download, back to the AI version exports the auto file (same inode). QG-CONFLICT pass.
  Scripted U1–U7 as in the table. Logo upload 0.3 s, music upload 1.1 s, the export with both
  passes G1, G2 and G3b (28.8 s). Instant hook suggestions used. Rapikan: 8 listed, 8 applied in
  one step, one Urungkan restores. Layout exact after 10.9 s (center-crop) and 1.9 s (back).
  11 markers, a click seeks, a cold-open suggestion used. PF-OPEN (clips already prepared by the
  entry test) first p95 457 ms, repeat p95 403 ms, first cell 873 ms. QG-A11Y 16 states, 0.
- After patch 66 (the export status route behind the guard), the flow ran again on a rebuild of
  `58e1c02` with a fresh job copy: **20/20 in 3.5 min**; U1 2.4 s, U2 2.5 s, U3 2.5 s, U4 2.8 s,
  U5 3.8 s, U6 26.8 s, U7 0 lost and 1.9 s; the export with logo and music 28.9 s, verified.
- Before the green acceptance run, two starts failed on my setup, not on the code: the copies'
  `job.json` still named the originals' source path (an absolute path the listing accepts), so the
  sourceless copy listed `needs_prepare` instead of a closed reason; and the settings copy landed
  one folder too deep, so the LLM part was off and the AI status never appeared. Both copies were
  fixed (each `sourcePath` pointed at the copy's own `input/`; the settings file moved), the job
  copy made fresh again, and the spec ran unchanged.

### Suites

- `ci-gate full` at `c935768` (the cherry-picks alone; run 36917866643): **success**. ruff "All
  checks passed!"; pytest on Python 3.11 "4246 passed, 2 skipped, 1 xfailed"; npm test on Node 20
  "# tests 1203", "# pass 1202", "# fail 0"; build "✓ Compiled successfully".
- `ci-gate image` at `c935768` (run 36917906440): **success**. Image build compiled; pytest inside
  it "4244 passed, 4 skipped, 1 xfailed".
- On the final code `ca0a7d5` (patch 66 included; later commits are this document):
  - `ci-gate full` (run 36921967246): **success**. ruff "All checks passed!"; pytest on Python
    3.11 "4246 passed, 2 skipped, 1 xfailed"; npm test on Node 20 "# tests 1205", "# pass 1204",
    "# fail 0"; build "✓ Compiled successfully".
  - `ci-gate image` (run 36922015311): **success**. pytest inside the production image "4244
    passed, 4 skipped, 1 xfailed".
  - PR #18's `CI/CD` run (36921940571): **success**. Test and build (the same suites), the
    toolchain evidence guard, and the parity smoke inside the built image: P-TIME-ffmpeg,
    P-TIME-jassub, P-TXT, P-FRAME, G-DET, P-AUD, R10 all pass, the browser half 3/3 on Chrome for
    Testing 147.0.7727.15 (6.5 min).
- QG-SEC gate on `0867dd7` (run 36920184986): **success** (table above).
- The nightly suite on `0867dd7` (`ci-cd.yml -f suite=nightly`, run 36920054208): **failure, on
  the known item only**. All 17 required gates pass (P-TIME ffmpeg and JASSUB, P-TXT, P-ENC,
  P-COLOR, P-RT, R10, P-FRAME, P-PLATE, G1-G2, G-DET, P-AUD (the parity section), G-CLICK, duck,
  G3, G3b, glyph-probe) plus the PF-RENDER report. The app section fails P-AUD for `02-vfr-bed`
  (1,614,384 samples against 1,614,400 planned, preview and reference alike: Open 12), and the
  performance report lists PF-AUDIO with music at p95 1,196 ms on the 4 vCPU runner (906 ms on the
  K15 PC). Same result as T4.4's nightly (run 36899263216).
- The runs on `03c496b` (full 36921061601, image 36921113840, PR 36921044329) were cancelled once
  patch 66 superseded that head.

### Patches by the W4 integrator (logged per plan §11.0)

Numbering continues from W3.

60. `docs/editor/GATES.md`: T4.1's and T4.3's sections both kept (T4.1 first).
61. `tests/test_render_worker.py`: T4.4 made the legacy heartbeat test deterministic, and T4.1
    removed that test with the legacy path. The fake clock is ported to
    `test_v3_worker_heartbeats_during_a_long_render_and_prevents_reclaim`: one clock drives
    `render_queue.datetime` and the v3 monitor's clock (a `_V3Monitor` subclass passes `clock=`;
    the default is bound at definition, so patching `time` would not reach it); the clock moves
    only after the monitor's first read, which removes a start-up race; the test waits for the
    worker's own beat. Ten repeated runs pass; with the monitor's heartbeat call removed it fails.
62. `docs/editor/CONTRACTS.md`: T4.4's §5.21 becomes §5.22 (T4.3 keeps §5.21) with the ported
    test's name; §5.23 records T4.2's guard (its request) and §5.24 T4.5's caption note (its
    request to T4.4); the contents line.
63. Release defaults: `compose.yaml` and `.env.example`; `web/tests/editor-w3-wiring.test.mjs`
    now pins them, the `.env.example` lines and `precheck: false` (committed failing in
    `c253829`, then `fc09edf`).
64. `docs/editor/PANDUAN-EDITOR.md` (intro with the actual defaults, the export line and the K5
    row: a note needs no tick), `docs/editor/OPERASIONAL.md` §2 (defaults, what switching off
    does, commands, rollback, the CPU quota), the README editor section.
65. `docs/ROADMAP.md` (§8 ticks, §6's test name, what remains for the owner), `docs/HANDOFF.md`
    (§1–§4), this section and `evidence/W4/T4.Z-real-stack-e2e.json`.
66. `web/app/api/jobs/[id]/renders/[renderId]/route.js` (T4.2's low finding for T4.1/T4.Z): GET
    and DELETE go through `secureRoute({params: ["id", "renderId"], limit: "api"})`; the DELETE
    starts the `render_queue` cancel and had no rate limit, and neither answer carried nosniff
    or CORP. `web/tests/security-support.mjs` adds the `renders` tree and both methods to T4.2's
    matrix (committed failing in `17303d2`: 7 of 14 tests, then `58e1c02`). The handlers did not
    change; the real-stack flow ran again on the rebuilt app afterwards (below).

### Phase-B requests (resolved here or forwarded)

| From | Request | Status |
|---|---|---|
| T4.1 | approve its CONTRACTS changes (§A.1 CLI row, §4.1 layout, `GET /clips` `not_v3`, `GET /renders/:renderId`, render-request-v3 notes) | **approved** (they match the code and the suites) |
| T4.1 | mark the legacy gates retired; ROADMAP §6's test name; HANDOFF §3/§4 | **done** (patches 61, 65) |
| T4.1 | T4.2: drop `MAX_UPLOAD_BYTES` from `CHILD_ENV_ALLOWLIST` | **not done**: T4.2's audit found it harmless (not a secret); Open 40 |
| T4.1 | T4.3: re-measure PF-PLAN without the `ranking` import | **done by T4.3** (40.1 ms) |
| T4.2 | CONTRACTS §5.2x and GATES text | **done** (§5.23; above) |
| T4.2 | pace the retention soak under 20 requests/s | **done by T4.3** (the soak runs in process on a simulated clock) |
| T4.2 | wrap `renders/[renderId]` in `secureRoute` | **done** (patch 66) |
| T4.2 | other low items outside its files | Open 38 |
| T4.3 | `python-cli.mjs` janitor module, `pipeline.py` schedule/close, CONTRACTS §5.21, STORAGE_RETENTION | **merged** (no conflict) |
| T4.3 | owner: the janitor deletes uploads unused for 30 days | checkpoint 3 (Open 45) |
| T4.4 | keep the fake-clock render-worker test after T4.1 | **done** (patch 61) |
| T4.4 | `primary-job-queue.mjs` gained an optional `clock` (default the system clock) | **recorded** here |
| T4.4 | reconcile the guides with the compose defaults; T4.4 rows; HANDOFF notes | **done** (patches 64, 65) |
| T4.4 | `/licenses` outside the login; a "Lisensi" link; link from the editor help | Open 37 (owner) |
| T4.4 | `editor_budgets.mjs` in `run_all.sh` | Open 46 |
| T4.5 | the K5 text in PANDUAN and CONTRACTS | **done** (patches 62, 64) |
| T4.5 | GATES rows | **done** (above) |
| T4.5 | `verify_export.py --loudness-clamped` | Open 41 |

### Open (W4 additions; the W1–W3 lists and T4.3's 29–32 stay)

33. **The nightly is red on P-AUD only** (Open 12: the compiler's source-audio path for a VFR
    synthetic clip, 16 samples short on preview and reference alike). W5 or later; re-run with
    `gh workflow run ci-cd.yml --ref <branch> -f suite=nightly`.
34. **Owner checkpoint 3**: U1–U7 with a stopwatch at both window sizes, the QG-AI 30-clip review
    (≥ 21/30; the LLM flag is already on by decision 3, so a fail means switching it off) and the
    490 filler labels (then `precheck: true` by PR). The pack is outside the repository
    (`editor-w4/checkpoint3.md` in the integrator's scratchpad).
35. **P-LOGO** (Open 23): owner decision.
36. **CPU quota of the primary worker** (Open 30): raise `cpus`, accept slower auto renders, or keep
    `legacy` until then. The owner decides before the deploy.
37. **`/licenses` sits behind the login**; anonymous landing visitors also receive Next/React and
    DM Sans. Exempting it in `web/proxy.js` (with a proxy-matcher test) and linking it from the
    landing footer and the editor's help is suggested. Optional: mirror the JASSUB and FriBidi
    sources (2.5.16 has no git tag).
38. Low security items from T4.2 still open: the proxy's 401 has no nosniff/CORP; non-editor
    pages can be framed; the Pengaturan connection check uses a denylist environment; the HTTP
    gate script (`scripts/security/route_matrix.py`) does not yet list the export status route
    (the node matrix does, patch 66). Deferred by plan: revocable sessions and the nonce CSP (K10).
39. Info: Python `render_queue`/`render_worker` accept UUID versions 1–5 in any case; the routes
    accept lower-case versions 1–8. Fails closed (app ids are v4).
40. `MAX_UPLOAD_BYTES` stays in `CHILD_ENV_ALLOWLIST` though no Python child reads it (not a
    secret).
41. `scripts/editor/verify_export.py` rebuilds the plan without the measured loudness clamp, so it
    reports G3 failed for a clamped normalize export; the worker's own G3 passes and the
    acceptance spec reads the clamp from the plan.
42. A job without `analysis/` (or a V1 job without `output/manifest.json`) lists no clips and no
    reason; the listing accepts an absolute `sourcePath` outside the job while prepare requires
    the job's own `input/` (production always writes the latter).
43. Copy: "Penanda tawa/jeda tidak tersedia untuk job ini" says "job" where the UI says
    "proyek" (`errors.py` and its drift-tested mirror change together).
44. At 1366×768 the transcript toolbar takes four rows and the tabs two while Rapikan is open.
45. The janitor deletes uploaded logos and music that no document or kept revision used for 30
    days (plan §4.4); STORAGE_RETENTION.md records it as the editor's own retention. Owner to
    confirm.
46. `scripts/perf/editor_budgets.mjs` is not yet a `perf` section of `scripts/parity/run_all.sh`.
47. Scheduled workflows stop after 60 days without repository activity; the nightly then needs
    re-enabling in the Actions tab.
48. Exports of the old editor (`output/edits/cand_*/revision-N.mp4`) download by URL but no page
    lists them (track A's decision).

## W4 verifier findings: fixes (T4.Z, 2026-10-02)

The release verification of `536f5de` (production image, the real `compose.yaml` at its release
defaults, copies of the owner's jobs) answered "not yet": one blocker and six minor findings.
Everything else held: CI full, image and PR green, acceptance 14/14, the flow 19/20 (the one
failure is finding 5a), old jobs viewable and downloadable, the benchmark baselines identical to
`main`, no version wording on screen, QG-SEC probes as designed. Each fix below was committed
test-first (the failing test, then the fix).

| # | Finding | Severity | What changed | Proof |
|---|---|---|---|---|
| 1 | `deploy/production.sh` counts a **cancelled** export (`render-request-v3` terminal state) as live work, so one cancel blocks every later deploy and the revert-PR rollback until files are deleted over SSH | **blocker** | The guard's allow-list for render requests is `{"completed", "failed", "cancelled"}` (patch 67) | `tests/test_deploy_guard.py`: the script's own Python, unchanged, on a temporary jobs root; 3 of 14 failed before the fix, 14/14 after; the allow-list is tied to `render_queue.V3_TERMINAL` |
| 2 | With `POTONGIN_EDITOR_V3=off` the "Ekspor terakhir" links leave the project page (files kept, back when on); OPERASIONAL promised only the auto clips | minor | Documented, not changed: OPERASIONAL §2 and PANDUAN now say the links hide and the files stay (patch 72). Showing them while the editor is off needs a read path outside the editor's routes (Open 50) | docs |
| 3 | The history offers "Edit klip" on jobs made before Selection V3, landing on a page with no editor entry and no reason (Open 42) | minor | The history needs `options.selectionMode === "v3"`; on the project page a clip the listing does not name says why it cannot open (patch 70) | unit tests; real stack: no "Edit klip" for `d1e45678`, every card of `d1e45678` and `d3e45678` names its reason |
| 4 | PF-PIPELINE under the compose CPU quota is moderate (whole job ≈ 1.10×, render phase ≈ 1.5×, auto files ≈ 2× the size, center-crop) | minor | No code: the numbers join Open 36 (the owner's quota decision) | the verifier's run |
| 5a | QG-A11Y (flow) ran axe while the cold-open suggestions faded in | minor | Both real-stack specs wait for the open panel to mount ("Membuka panel…" gone, a `[data-panel]` visible) and finish loading (no `aria-busy="true"` inside it), then for 300 ms without a running animation (patch 71) | reproduced 1 of 4 before (contrast 4.31 mid fade-in; 6.76 settled), 8 of 8 after |
| 5b | Acceptance capability 13 required "Memverifikasi" on screen; the dialog polls once a second and a short verification can fall between two polls | minor | The test records the stages its status polls received and requires each of them on screen, with `merender` among them; verification itself is proven by `completedBy: "render"` and the G1–G3 checks (patch 71) | the second real-stack run hit the case (received `antre`, `merender`, `selesai`) and passed; the first saw all three on screen |
| 6 | An untouched clip asks for a tick on the AI's own tight cut although its export is the auto file | minor | `exportChecks(checks, {unchanged})`: for an unchanged clip every warning is a note in the export dialog (no tick); errors still block, an edited clip still asks for each tick. "Perlu dicek (n)" and the checks panel stay as they are: while editing, the cut is worth a look (patch 69) | unit tests; fake spec "an unchanged clip's checks are notes in the export"; real stack: 3 unchanged clips, 0 tick boxes, export enabled |
| 7a | Capability 11 needs a local `resources/toolchain.json`, unstated | minor | The acceptance setup header names it (patch 71) | the header |
| 7b | The render worker created `analysis/render-requests/.queue.lock` in every job with `analysis/` | minor | `run_one` skips a job without `analysis/render-requests/` (patch 68) | `test_v3_worker_writes_nothing_into_a_job_that_was_never_exported`; real stack: 0 queues created in untouched copies |
| 7c | A malformed render-request file blocks deploys (as on `main`) | minor | Kept (fails closed), now pinned by a test and documented with the way out (OPERASIONAL §7) | `test_an_unreadable_request_still_blocks_a_deploy` |

**Rollback after the guard fix.** A revert of PR #18 also reverts `deploy/production.sh`; main's
guard does not know `cancelled`, so a cancelled export on the server would block that rollback
deploy. The fix is its own commit (`fix(deploy): a cancelled export is not live work for the
deploy guard`, test in the commit before it); landing it on `main` first in a small PR keeps any
later revert of #18 deployable (Open 49; OPERASIONAL §2 says the same to the owner).

### Real-stack re-check (owner's PC, 2026-10-02 05:30–05:55 WIB)

The owner was away. The root disk was full, so the production build (`next build`, `next start`
on a private port) and the job copies lived in `/dev/shm`; the render worker ran from this
worktree. Flags at the release defaults except `POTONGIN_EDITOR_LLM=off` (no settings copy, so
the instant hook suggestions only). Fresh copies of `e7f0d37b` per run, `899226f8` without its
source as the closed case, `d1e45678` and `d3e45678` for the old-job pages; originals only read,
copies deleted afterwards. Numbers: `evidence/W4/T4.Z-verifier-fixes.json`.

- `web/e2e/editor-flow.spec.mjs`: **20/20 in 3.6 min**; U1 2.5 s, U2 2.5 s, U3 2.5 s, U4 2.7 s,
  U5 3.9 s, U6 26.8 s for an 89.3 s clip, U7 0 lost and the reset found in 1.9 s; QG-A11Y 16
  states, 0 findings. Its QG-A11Y alone: 8/8 repeats.
- `web/e2e/editor-acceptance.spec.mjs`: **14/14 in 5.7 min**; QG-A11Y 26 states, 0 critical,
  0 serious; capability 13 as in row 5b.
- `web/e2e/editor-shell.spec.mjs` on the fakes (same build with `POTONGIN_EDITOR_FAKES=1`):
  36 passed, 1 skipped (the PF-OPEN timing gate without `EDITOR_GATES`).

### Suites

- `ci-gate full` at `00e40ce` (every code change of this section; run 36935260211): **success**.
  ruff "All checks passed!"; pytest on Python 3.11 "4261 passed, 2 skipped, 1 xfailed"; npm test
  on Node 20 "# tests 1209", "# pass 1208", "# fail 0"; build "✓ Compiled successfully".
- `ci-gate image` at `00e40ce` (run 36935302658): **success**, pytest inside the production image
  "4259 passed, 4 skipped, 1 xfailed".
- PR #18's `CI/CD` at `00e40ce` (run 36935257855): **success** (tests, toolchain guard, parity
  smoke).
- On the final code `f87dd8f` (the e2e harness commits and a comment rewrap on top; later commits
  are this document):
  - `ci-gate full` (run 36938001003): **success**. ruff "All checks passed!"; pytest on Python
    3.11 "4261 passed, 2 skipped, 1 xfailed"; npm test on Node 20 "# tests 1209", "# pass 1208",
    "# fail 0"; build "✓ Compiled successfully".
  - `ci-gate image` (run 36938032673): **success**, pytest inside the production image "4259
    passed, 4 skipped, 1 xfailed".
  - PR #18's `CI/CD` (run 36937967572): **success**.

### Patches by the W4 integrator (continued)

67. `deploy/production.sh` (the blocker) and the new `tests/test_deploy_guard.py`.
68. `src/ai_clipper/render_worker.py` (`run_one`), `tests/test_render_worker.py`.
69. `web/components/editor/export-flow.mjs` (`exportChecks`, `canStartExport(…, {unchanged})`),
    `web/components/editor/ExportDialog.jsx`, `web/tests/editor-export-flow.test.mjs`,
    `web/e2e/editor-shell.spec.mjs` (one test).
70. `web/lib/clip-entry-view.mjs` (`historyOffersEdit`, `clipEntryFor`), `web/app/projects/page.jsx`,
    `web/app/projects/[id]/page.jsx`, `web/tests/editor-clip-entry.test.mjs`,
    `web/tests/project-view.test.mjs` (the history pin now names the helper).
71. `web/e2e/editor-flow.spec.mjs` (`settledForAxe`), `web/e2e/editor-acceptance.spec.mjs`
    (`axeRun`, `exportClip` records the received stages, capability 13, the setup header).
72. `docs/editor/OPERASIONAL.md` (§2 editor off, the rollback; §7 a blocked deploy),
    `docs/editor/PANDUAN-EDITOR.md`, `docs/editor/CONTRACTS.md` §5.25.
73. This section, `evidence/W4/T4.Z-verifier-fixes.json`, `docs/HANDOFF.md` (the rollback note).

### Open (verifier additions; the lists above stay)

- **36** gains the verifier's compose-quota run: the same 4-minute upload, center-crop, the same
  two spans: `legacy` job 59 s (render phase ≈ 12 s, files 11.05 + 5.71 MB), `edit-v2/1` job 65 s
  (render phase ≈ 18 s, files 22.80 + 13.06 MB).
- **42** is closed on the page side: every card of such a job names its reason. The listing itself
  still returns no entries for them, and the history still offers "Edit klip" for a Selection V3
  job without `analysis/` (only synthetic copies have that shape; production always writes it).
49. Land `fix(deploy): a cancelled export is not live work for the deploy guard` on `main` ahead of
    PR #18 (owner or integrator; no deploy from this branch). **Done 2026-10-02:** PR #19, then the
    editor itself as PR #20 (squash commit `5064831`, since GitHub cannot rebase-merge 403 commits;
    full history on branch `editor-release`). Reverting `5064831` keeps the guard.
50. With the editor off, edited exports have no link on any page (files kept, links back when on).
    A read-only "Ekspor terakhir" outside the editor's routes would keep them reachable; owner to
    decide whether it is worth it.
51. The real-stack specs run only on the owner's PC (they need real jobs, which never leave it);
    this section's run used `POTONGIN_EDITOR_LLM=off`, so the free-LLM hook cards were last seen
    on the real stack in T4.Z's run and the verifier's.

## Transisi cold open (2026-10-02)

Spec: `docs/plans/2026-10-02-transisi-cold-open.md` (owner decisions of 2026-10-02, with T1's
"Decisions during build"); contract: CONTRACTS §5.26. Auto clips that keep a cold open get a
white flash and a whoosh at the join (both engines); the editor offers Potong langsung / Kilat
putih / Gelap sebentar and a whoosh toggle. Nothing moves a frame or a sample, so every gate
above keeps its cases and its numbers: its documents keep `cut` joins without a sound, and the
transition reaches them through the cut document (spec §2.4), which these new gates prove.

Where it was measured: GitHub Actions, 4 vCPU, the production image (FFmpeg 5.1.9, Python
3.11.2), branch `transisi-t1`. Evidence: `evidence/TR/T1-*.json` (numbers only; each names its
run and commit). P-JOIN-B (the browser half) is T2's and is filled at integration.

| Gate | What is compared | Threshold | Cases | When | Result (T1) |
|---|---|---|---|---|---|
| **P-JOIN** | `reference` of a transition document against the same document with `cut`, decoded to RGB (BT.709): (a) frames outside the effect; (b) inside it, the pixels the text cannot reach against `blend(cut, alpha)`; (c) per frame, the alpha by least squares; (d) frames, samples, ASS sha, pieces, one `lutrgb` per affected frame; the text's pixels decide the layer order (text share over the effect, frames with alpha ≥ 500) | (a) md5 identical; (b) every pixel ≤ 3 levels, mean ≤ 1.0; (c) ±10 per mille; text share ≥ 0.5 (under the effect: 0) | 10: 5 rates × 2 styles, 600-frame barcode source, 20 cuts, a 2 s cold open; the 29.97 cases hold the hook over the join. PR smoke: 29.97 `flash_white` + whoosh | PR (smoke), nightly | **pass** 10/10 (run 36966430990): outside 0 mismatches; inside max 1 level, mean ≤ 0.84; alpha within 8 per mille; text share 0.65–0.74 (the hook bar is 65 % opaque) and 0.998–1.000 under the dip. Smoke pass (run 36966427934) |
| **G-WHOOSH** | s16 `reference` PCM of a whoosh document minus the same without it | outside the whoosh: 0 on every sample; inside: ≤ 1 LSB from the file, ≥ 99.9 % exact; the loudest 10 ms within ±480 samples of `hit − 240` | 29.97 `flash_white`, 25 `dip_black`, 29.97 `cut`, 29.97 with ducked music (both renders with the no-whoosh measurement) | PR (smoke: the first), nightly | **pass** 4/4: outside 0 non-zero samples; inside max 1 LSB, 99.990–100 % exact; loudest 10 ms 22 samples after `hit − 240` |
| **P-AUD** (new case) | `audio_preview` FLAC PCM against `reference` PCM of a 29.97 `flash_white` + whoosh document | md5 equal; samples = plan | the click document with the whoosh | PR | **pass** (run 36966427934): md5 equal, 722,321 samples = plan |
| **P-LOOK-JOIN** | legacy and edit-v2 auto renders of the synthetic job's clip 1, each against its own render without the transition: per-frame alpha around each one's own join; each whoosh onset against where that engine places it; both renders' loudness | alpha within 50 per mille at the best offset in ±1 frame; onset within 2 ms; loudness within 0.5 LU | main (29.97 fit-blur), fps25 (center-crop), fps60 (face-track: legacy 60 against edit-v2 30) | nightly | pending (rerun 36968543523; the first run's legacy face-track crashed on the stub track's empty samples, fixed in `d062d7a`) |
| **R10 / P-RT** | as above | P-RT framemd5 and PCM md5 identical; R10 hard link 100 % | `main` (edit-v2 with the flash and whoosh), `fps60`, `old` (legacy, before the transition: cut, no manifest key), `legacy_new` (legacy with the flash and whoosh, prepared afterwards) | PR (R10), toolchain / nightly (P-RT) | **pass**: P-RT re-render 6/6 clips, 6,813 frames, video, PCM and bytes identical; R10 36/36 linked (18 edit-v2, 18 legacy). PR smoke R10 18/18 |
| **G-DET** | unchanged rule, plus a 29.97 `flash_white` + whoosh document | identical plan, ASS, graph, sidecars and envelope across 3 processes | 9 cases | PR | **pass**: 0 differences, preview ASS = export ASS |
| **PF-RENDER** (report) | each engine's delivered render of the 29.97 clip (10.3 s) with and without the flash and the whoosh | report | edit-v2 `final` of the 20-cut document; legacy `render_vertical` of the cold open and the body's span | nightly | edit-v2 5.04 → 5.17 s (+0.13 s); legacy 4.37 → 5.54 s (+1.17 s: `geq` on the affected frames and the join-measuring pass). The existing PF-RENDER (unchanged documents) p50 0.318×, p95 0.473× (within budget) |
| **P-JOIN-B** (browser) | the player's `joinAlphaPm`, the canvas against the server composite, the whoosh mix | 0 mismatches; P-TXT's numbers; ≤ 1 LSB | 29.97, 25, 23.976 (spec §5.4) | nightly (ci-cd parity job) | T2 |

Unchanged gates measured on this branch at `99c0916`: P-FRAME 3,625 frames, 0 mismatches; P-PLATE,
G1/G2, G-CLICK, duck, G3, G3b pass (run 36966430990); `suite=full` (ruff, pytest 4,442 on
Python 3.11, web 1,208/1,209 with 1 skip, build) run 36966421656 and `suite=image` (pytest 4,441
in the image, the whoosh level test included) run 36966424538 green.

- The whoosh file's level in the image: −29.00 LUFS integrated, −17.20 dBTP
  (`resources/sfx/whoosh/v1.meta.json`; `tests/test_edit_v2_transitions.py` checks −29.0 ± 1.0
  and ≤ −16.0 dBTP on the pinned toolchain).
- Open for the owner (spec §10): listen to the committed whoosh and one real clip of each style
  before release; a different level ships as `whoosh/v2`.
