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

- `uv run pytest` (Python 3.13.13, local FFmpeg 6.1.1): 3,054 passed, 1 skipped at the final code commit.
- `uv run --python 3.11 --isolated --with-editable . --extra vision --with "pytest>=8,<9"
  pytest` (Python 3.11.15): 3,054 passed, 1 skipped (the opt-in PUT timing gate, `POTONGIN_GATES=1`).
- Inside `editor-w1z` (Python 3.11.2, FFmpeg 5.1.9, pytest 8.4.2 in a scratch target on
  `PYTHONPATH`): 3,051 passed, 3 skipped (PUT timing gate, no C compiler, no git), run before the grid-fallback test was added; the
  image rebuilt at the final code commit passes the source-info, seed, integration and execute
  files 120/120.
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
