# Editor V3 Esensial: spike results

Owner: T1.2b (wave W1), 2026-09-25. Plan: `docs/plans/2026-09-24-editor-v3-esensial.md` §5.2 R5,
§5.4, §10.1, K2 and K6. Every number below comes from the evidence files
`docs/editor/evidence/W1/T1.2b-{P-TIME,P-TXT,P-ENC,P-COLOR,S-COLOR}.json` (numbers only).

Toolchain: FFmpeg references, exports and scoring ran inside `ai-video-clipper:editor-ref`
(FFmpeg 5.1.9, libass 0.17.1, freetype 2.12.1, harfbuzz 6.0.0, fribidi 1.0.8, fontconfig 2.14.1,
Python 3.11.2), 4 CPUs (`docker run --cpus 4`). The browser side is Chrome for Testing
147.0.7727.15 (Playwright 1.62.1, `chromium-1217`, headless) with JASSUB 2.5.16 (baseline
`jassub-worker.wasm`, single-threaded libass). Machine: the K15 reference PC (Ryzen 7 5700G,
16 threads, shared with other agents while measuring). Fonts: the pinned bytes of T1.2a's
`resources/fonts` (DejaVu Sans / Sans Bold from bookworm `fonts-dejavu-core` 2.37-6, Montserrat
ExtraBold v7.222, sha256 as in `fonts.json`).

## 1. S-COLOR: the text compositing format (K2)

**Decision: `gbrp`** (planar RGB). R5 for T1.3 becomes

```
scale=in_color_matrix=bt709:in_range=tv,format=gbrp,
ass=filename=captions.ass:fontsdir=fonts:shaping=complex,
[logo overlay in gbrp],
scale=out_color_matrix=bt709:out_range=tv,format=yuv420p
```

How it was reached:

- The §5.2 rule ("the cheapest candidate that passes P-TXT, P-COLOR and P-ENC; yuv420p wins
  within 0.002 of the best delivered text SSIM") selects **no** candidate
  (`decision.rule = none_passed`): P-ENC's absolute thresholds fail for **every** candidate
  (§3.3). The final 4:2:0 + x264 crf 21 step is the same in all three, so P-ENC cannot rank
  them (delivered text SSIM against one common reference: gbrp 0.98193, yuv420p 0.98064,
  yuv444p 0.98066 on the synthetic plate; 0.98695 / 0.98738 / 0.98743 on natural video).
- `gbrp` is the only candidate that passes P-TXT and P-COLOR, so `s_color.recommend` picks it
  (`basis = p_enc_fails_for_every_candidate`, `open_gates = [p_enc]`).

| Candidate | P-TXT (worst of 120 frames) | P-COLOR worst \|Δ\| (≤ 4) | P-ENC own ref, min whole / text | Cost 30 s @720×1280, best / median of 5 |
|---|---|---|---|---|
| `yuv420p` | **fail**: SSIM 0.990808, text SSIM 0.919593, PSNR 42.98 dB, max 106, 5,564 px > 16 | **fail** 23.81 | 0.98817 / 0.98049 | 8.09 s / 9.60 s (1.00×) |
| `yuv444p` | **fail**: SSIM 0.999376, text 0.992745, PSNR 53.41 dB, max 18 (22 on the DejaVu Bold variant), 4 px > 16 | **fail** 23.17 | 0.98168 / 0.97268 | 8.18 s / 9.85 s (1.01×) |
| `gbrp` | **pass**: SSIM 0.999942, text 0.999442, PSNR 62.50 dB, max 14, 0 px > 16 | **pass** 2.18 | 0.98660 / 0.97455 | 9.04 s / 10.88 s (1.12×) |

Cost: `fit_blur` of a 1280×720 H.264 source + karaoke captions + hook + R7 encode, 30 s of
output, `-threads 4`, `-filter_complex_threads 4`, x264 `threads=4`, interleaved runs. gbrp is
**+11.7 %** (best) / +13 % (median) over yuv420p, 0.30× real time, inside PF-RENDER (p50 ≤ 0.4×).
The [PF] estimate of +40 % (1080×1920, blurred plate) does not hold at 720×1280.

**Why the YUV candidates fail (E6 claim confirmed).** `s_color.py matrix-probe` composites the
six swatch colours over black and reads the fills back:

| Variant | worst \|Δ\| vs the ASS colour | e.g. `#3DF5A6` (ΔR, ΔG, ΔB) |
|---|---|---|
| yuv420p, read as BT.709 | 23 | (−15, −23, 0) |
| yuv444p, read as BT.709 | 23 | (−15, −23, 0) |
| yuv444p + `setparams=colorspace=bt709`, read as BT.709 | 23 | (−15, −23, 0) |
| yuv444p, read as **BT.601** | **1** | (0, −1, 0) |
| gbrp | **0** | (0, 0, 0) |

FFmpeg 5.1.9's `ass` filter converts ASS colours with BT.601 coefficients in YUV formats and
ignores the frame's colour tags, so every coloured caption (karaoke `#FFE14D`, emphasis
`#FF5C8A`, all swatches) is off by up to 23 levels in a BT.709 file. White, black and the
translucent box are unaffected (≤ 1.3). A "colour-correct YUV path" that keeps the ASS bytes
(plate to BT.601 before `ass`, back to BT.709 after) was not built: it needs two YUV↔YUV matrix
conversions, which swscale performs through RGB, so it cannot be cheaper than gbrp's two
conversions [E], and yuv420p would still fail P-TXT on chroma resolution (max 106).

**Finding for T1.3 (the final step).** R5's `scale=out_color_matrix=bt709:out_range=tv,
format=yuv420p` is correct from gbrp. From a YUV composite it is wrong: swscale treats untagged
YUV as BT.601 and converts YUV→YUV through RGB when the matrices differ, shifting every plate
colour (measured: luma SSIM 0.977 against the composite in the first S-COLOR run). A YUV
composite must name `in_color_matrix=bt709:in_range=tv` as well
(`reference_text.final_graph`). Same rule as R3: every `scale` names its input matrix.

## 2. Pack variants (§5.4, K6)

All measured on the chosen `gbrp` composite, 3 lengths × 5 probe frames each (P-TXT thresholds:
SSIM ≥ 0.999, PSNR ≥ 45 dB, max ≤ 16, 0 px > 16):

| Pack / variant | Result | min text-region SSIM | max diff |
|---|---|---|---|
| **Bold, Montserrat ExtraBold** (planned) | **pass → kept** | 0.999815 | 14 |
| Bold, DejaVu Sans Bold (fallback) | pass | 0.999784 | 14 |
| **Box, Montserrat, `BorderStyle 3`** (planned) | **pass → kept** | 0.999442 | 12 |
| Box, Montserrat, `\p` vector box | pass | 0.999438 | 12 |
| Box, DejaVu Sans Bold, `BorderStyle 3` | pass | 0.999430 | 14 |
| Classic / Karaoke / Hook (today's `build_ass`) | pass | 0.999911 / 0.999840 / 0.999669 | 12 / 12 / 11 |
| Fallback glyph U+2665 ♥ (Montserrat lacks it; DejaVu Sans on both sides) | pass | 0.999857 | 13 |

Decisions: **Bold = Montserrat ExtraBold; Box = Montserrat ExtraBold with `BorderStyle 3`**
(alpha on `OutlineColour`). The fallbacks (DejaVu Sans Bold, `\p` box) also pass, so they stay
available without re-measurement. On yuv444p both Bold variants fail (max 17–22, from the BT.601
highlight colour), which is another reason for gbrp.

The Bold and Box ASS are hand-written from §5.4 with T1.2a's pack numbers (72 px / 64 px,
outline H/90 = 14.22, padding H/100 = 12.8, MarginV 218, side margins 43, box alpha `&H40`),
one Bold event per word with every word coloured so only `\1c` changes. Once T1.2a is merged,
re-run the harness on `build_ass_v2` output (T1.Z): the gate is on the shipped bytes.

## 3. Gates (T1.2b)

**P-TIME, JASSUB side: pass.** 0 mismatches over 231 transitions (event starts and ends, karaoke
`\k` onsets, active-word switches, hook in/out with `\fad`), 44 of them on hazard frames, at 24,
25, 30, 24000/1001 and 30000/1001. Each transition is checked as "frame t differs from t − 1,
t − 2 = t − 1, t = t + 1" on libass's own image list (per-colour coverage and box). A control
that shifts the libass output by one frame is flagged on 231 of 231 transitions. Hazard frames
(FFmpeg's double `now_ms` one below the exact floor) do not occur in the first 20,000 frames at
24 and 30000/1001, so those two rates have 0 hazard transitions. The adapter passes
`now_ms(n)/1000` and JASSUB's `(long long)(t·1e3 + 0.5)` returns `now_ms(n)` on every
time-map vector (unit test).

**P-TXT: pass (gbrp).** 24 clips × 5 probe frames (4 packs × 10/40/90 characters, hook,
fallback glyph, P-COLOR sheet, 9 variant clips), JASSUB drawn through the editor's text layer on
a Canvas2D over the plate frame vs the FFmpeg composite before 4:2:0 (RGB). Worst over the 14
gated clips: SSIM 0.999942, text-region SSIM 0.999442, PSNR 62.50 dB, max 14, 0 px > 16. No
composite pixel changes outside the text region.

**P-COLOR: pass (gbrp).** Interior fill (5×5 erosion, ≥ 1,587 px per colour) of the six swatch
colours and of the Box fill, exported MP4 decoded as BT.709 vs JASSUB: worst mean |Δ| 2.18
(`#52C7FF`, ΔB −2.18). yuv420p 23.81 and yuv444p 23.17 fail (the BT.601 colours above).

**P-ENC baseline: recorded; the absolute thresholds are NOT met.** Scored with FFmpeg's `ssim`
on BT.709 limited-range 4:4:4 planes (the delivered chroma upsampled, so the 4:2:0 loss counts),
the exported R7 MP4 against the lossless gbrp composite, text region = the clip's caption/hook box:

| Plate | whole frame (≥ 0.990) | text regions (≥ 0.980) | luma only, whole / text |
|---|---|---|---|
| `fit_blur` of `testsrc2` (synthetic, saturated) | 0.98660–0.98947, all 14 gated clips below | 0.97455–0.98969; bold-90, hook, karaoke-40, karaoke-90 below | ≥ 0.99650 / ≥ 0.99554 |
| `fit_blur` of a real 640×360 BT.709 source (supplementary, read only) | 0.98967–0.99170; bold-90, karaoke-90 below | 0.97670–0.99399; bold-90, karaoke-90 below | ≥ 0.99315 / ≥ 0.99444 |

The loss is chroma, not luma, and mostly the encoder, not the compositing format: 4:2:0 alone
(lossless) gives 0.9911–0.9923 whole / 0.9890–0.9944 text on the synthetic plate and
0.9972–0.9983 / 0.9922–0.9986 on natural video; x264 veryfast crf 21 then takes coloured text
(yellow karaoke/Bold highlight over the black outline) to 0.977. RGB-channel SSIM, reported as a
diagnostic, is lower still (0.904–0.914 whole on the synthetic plate) because it weighs chroma
error three times. The per-clip values in `T1.2b-P-ENC.json` are the W1 baseline for the relative
gate (a drop > 0.002 fails). Not weakened, not decided here: accepting the baseline, or changing
R7 (for example a negative x264 chroma QP offset, or crf 18) is for the integrator and owner.

## 4. Observations for later tasks

- **PF-LIBASS input.** JASSUB `rawRender` on the 120 probe frames at 720×1280 (single-threaded,
  headless, this PC): p50 0.4 ms, p95 2.1 ms, max 13.6 ms (the first frame after `setTrack`).
- **Determinism.** Two full runs produced byte-identical FFmpeg references and byte-identical
  browser composites.
- **Threads.** The adapter hides `crossOriginIsolated` from JASSUB's glue, so libass runs
  single-threaded with or without COOP/COEP. Whether W2 enables the pthread pool is W2's call;
  re-run P-TXT if it does.

## 5. Running the harness

1. Fixtures and FFmpeg references, in the reference image (≈ 4 min):

   ```sh
   OUT=/some/scratch   # contains fonts-in/ with the pinned .ttf files
   docker run --rm --user 1000:1000 --cpus 4 -v "$PWD":/w -v "$OUT":/out -w /w \
     -e PYTHONPATH=/w/src -e HOME=/tmp ai-video-clipper:editor-ref \
     /app/.venv/bin/python scripts/parity/reference_text.py --out /out/fixtures --fonts /out/fonts-in
   ```

2. A server with the harness on (never in production), then the spec:

   ```sh
   cd web && npm run build
   POTONGIN_PARITY_HARNESS=1 POTONGIN_PARITY_FIXTURES=$OUT/fixtures \
     APP_USERNAME=… APP_PASSWORD=… APP_SESSION_SECRET=… npx next start -p 3217 -H 127.0.0.1
   E2E_BASE_URL=http://127.0.0.1:3217 E2E_NO_WEB_SERVER=1 E2E_USERNAME=… E2E_PASSWORD=… \
     POTONGIN_PARITY_FIXTURES=$OUT/fixtures PARITY_OUT_DIR=$OUT/browser npm run test:parity
   ```

   `PARITY_GATE_FORMAT` (default `gbrp`) is the candidate the P-TXT assertion gates on.

3. Cost, colour probe, decision and evidence (reference image for the first three):

   ```sh
   … scripts/parity/s_color.py cost --out /out/cost.json --fonts /out/fonts-in --runs 5
   … scripts/parity/s_color.py matrix-probe --out /out/matrix.json --fonts /out/fonts-in
   … scripts/parity/s_color.py decide --fixtures /out/fixtures --browser /out/browser \
         --cost /out/cost.json --p-txt /out/browser/p_txt.json --out /out/decision.json
   python scripts/parity/s_color.py evidence --decision $OUT/decision.json \
         --browser $OUT/browser --matrix $OUT/matrix.json --out-dir docs/editor/evidence/W1
   ```

   The supplementary natural-video P-ENC: `reference_text.py … --plate-video SRC --plate-start S
   --no-timing --only …` then `enc_check.py fixtures --fixtures … --out …`, passed to
   `evidence` as `--p-enc-natural`.
