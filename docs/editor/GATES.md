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
