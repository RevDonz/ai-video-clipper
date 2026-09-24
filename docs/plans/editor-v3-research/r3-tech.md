# R3: Making the browser preview match the final FFmpeg render

Date: 2026-09-24. Status: research and recommendation. No repo files were changed.
Lab scripts and raw outputs are in `scratchpad/editor-design/lab/` (see Appendix A).

---

## 0. Summary

**Recommendation: (e) hybrid, "one document, two compilers".** An `EditDocument v2` is compiled
two ways:

1. **Python compiler to an FFmpeg filtergraph.** It produces the final render and the server's
   "truth" preview frames.
2. **JS compiler to a WebGL2 scene.** It drives the live preview:
   - WebCodecs decode via Mediabunny, reading a short-GOP H.264 proxy;
   - WebAudio as the master clock;
   - **all text is drawn by libass itself, compiled to WASM (JASSUB)**, from the *same ASS
     bytes* the server burns in.

The preview only uses video operations from a **parity-safe op catalog**: operations whose math
both sides implement the same way, each with a golden-frame test. Anything that cannot be matched
is either pre-rasterized on the server or left out of the product.

Findings measured on this machine (Ryzen 7 5700G, 16 threads; Chrome for Testing 147 headless;
production Docker image `ai-video-clipper:latest` with FFmpeg 5.1.9, libass 0.17.1, harfbuzz 6.0.0):

| Question | Measured result |
|---|---|
| JASSUB 2.5.16 (libass 0.17.4-43-g266b983, WASM) vs server libass. The production image and local FFmpeg 6.1.1 were bit-identical to each other. Current `captions_ass.py` output (karaoke + hook box + classic), 720x1280, 16 frames | **SSIM 0.99980–0.99988, max channel diff ≤ 13/255, 0 px off by more than 16**. The ~49.9 dB PSNR floor comes from a 1-level background-color round-trip, not from text. |
| Best-effort DOM/CSS captions (current approach, metrics carefully derived from libass) vs libass | **SSIM 0.976–0.990, PSNR 27–33 dB, 7.6k–21k px off by more than 16 levels.** There is no path to `\k`, `\t` or `\fad` parity. |
| WebCodecs (Chrome 147, software) decode of H.264 proxy then `drawImage`, vs FFmpeg decode to rgb24 | **SSIM 0.9983, PSNR 46.2 dB, max diff 4**. Decode is not the problem. |
| Random-seek latency, Mediabunny `getSample(t)` | H.264 proxy (GOP 0.6 s): **p50 3.7 ms, p90 8.6 ms**. Original YouTube AV1 480p (GOP ~6 s): **p50 41 ms, p90 88 ms**. |
| Canvas2D compositor prototype (fit-blur + fg + JASSUB) vs production FFmpeg graph | naive: SSIM 0.981 / 27.3 dB. Edge-extended blur: 0.991 / 36.4 dB. **Portable low-res box-blur plate: 0.9937 / 36.8 dB.** |
| Current `gblur=sigma=35` cost | **36% of the final render time.** Final 30 s at 720x1280 takes 5.46 s with gblur and **3.45 s with the portable plate** (same as no blur). The plate looks the same: SSIM 0.993 vs the old look. |
| ffmpeg.wasm 0.12.10 (option c) | 32 MB WASM (10 MB gzip), GPL (x264), no AV1 decoder. A 2 s 720x1280 segment takes **2.24 s single-threaded (0.9x realtime)**; native takes 0.45–0.56 s. **Rejected.** |
| Server low-res preview render (option d) | 30 s at 360x640 renders in 2.0–2.1 s, a 2 s segment in 0.45–0.56 s, one exact 720x1280 frame in **0.16–0.20 s**. **But 360p preview vs 720p lossless is only SSIM 0.965**, and 540p only 0.973: lower pixel fidelity than the browser compositor. |
| Final encode loss (x264 veryfast crf21 vs lossless graph output) | SSIM 0.995, PSNR 46.8 dB. This is the floor any "identical" claim has to live with. |

Parity bugs found in the current V1 editor and render path, each reproduced:

1. **Fonts.** The editor offers Inter and Noto Sans, but the production image has only DejaVu
   (`fc-list`), and `render_manifest._FONT_MAP` maps every choice to DejaVu Sans. So the preview
   shows a font the render never uses.
2. **Color management.** PNGs written by FFmpeg carry `cICP` and `gAMA` (BT.709 transfer), and
   Chrome color-manages them. The result is a uniform −9.5-level shift, and composite SSIM drops
   from 0.991 to 0.947. All shared raster assets must be normalized.
3. **Overlay offset.** In yuv420 graphs, `overlay` truncates x and y to *even* pixels
   (`(int)d & ~1`). The fg ends up at y=436, not 437.5. A 1-row mismatch gives max diffs of 150+.
4. **Proxy SAR.** `scale=-2:360` leaves SAR 1281:1280, so the browser shows 641 px wide. Always
   add `setsar=1`.
5. **Blur.** `gblur` (a recursive approximation) is not portable and is expensive (see the table).
6. **Chroma.** 4:2:0 subsampling gives up to ~90-level diffs on the edges of saturated text
   (yellow karaoke) while SSIM stays ≥ 0.998. Accept this in the thresholds; do not emulate it.

---

## 1. What "preview = final render" can mean

| Level | Definition | Who guarantees it |
|---|---|---|
| **L0 semantic parity (must be 100%)** | Same layout decisions: line breaks, positions, which frame each layer and word highlight is visible on, cut points, transition offsets, audio gain envelope | Both compilers read one document. Text uses the same ASS bytes through libass on both sides. Every animated value is sampled on the output frame grid by shared code. |
| **L1 perceptual parity** | Live preview frame vs lossless FFmpeg reference: SSIM(All) ≥ 0.99, PSNR ≥ 35 dB, geometry ±1 px | Parity-safe op catalog plus golden tests in CI |
| **L2 pixel parity** | Frame produced by the production binary and graph | Server truth frames (0.16–0.20 s each) and segment preview renders |

The owner's rule "jangan menurunkan kualitas" ("don't lower quality") maps to: L0 is a hard
gate, L1 is a CI gate per op, and L2 is always one click (or one pause) away.

---

## 2. Current state (V1 editor), with measured gaps

- `edit/page.jsx` draws the approximation in DOM. It already warns: *"Tampilan browser mendekati
  hasil render; detail font, blur, dan komposisi akhir dapat berbeda"* ("the browser view is close
  to the render; font, blur and final composition details may differ").
  - Two `<video>` elements: the backdrop uses CSS blur, the fg uses `object-position`.
  - The caption `<div>` uses `fontSize = font_size/3 px` and CSS `backgroundColor`.
  - The title `<div>` is plain; the logo is a "LOGO" placeholder.
- The preview source is the **original upload** (`/api/jobs/:id/preview-source`), which is AV1
  480p with a GOP of about 6 s for YouTube downloads. That explains the ~41–88 ms seeks and why
  `editor-timeline.mjs` throttles seeks to 10/s.
- Final rendering (`render_manifest.py`) builds its own ASS, separate from V3's `captions_ass.py`.
  So there are already **two ASS generators**, and the editor matches neither.
- The render worker's face-track crop is computed *at render time* (`detect_face_track` inside
  `_layout_filter`). The editor cannot preview or edit it; the V1 UI disables face-track for this
  reason.

---

## 3. Options compared

| | (a) DOM/CSS over `<video>` | (b) WebGL2 + WebCodecs compositor | (c) ffmpeg.wasm | (d) server low-res renders | **(e) hybrid (b)+JASSUB+(d)** |
|---|---|---|---|---|---|
| Text fidelity vs final | SSIM 0.976–0.990, 27–33 dB (measured) | With JASSUB: SSIM 0.9998 (measured) | Same libass, but a different FFmpeg build (6.x in 0.12.x core vs 5.1.9 in prod) | Exact semantics; 360p softness (SSIM 0.965 overall) | 0.9998 text, 0.9937 composite; L2 on demand |
| Interactive latency | Instant | Instant (seek 3.7 ms p50 on proxy) | 2.24 s per 2 s at 720p | 0.16–0.2 s per frame; 0.5 s per 2 s segment; plus queueing | Instant, plus 0.2 s truth frame on pause |
| Seamless jump cuts / multi-range | No (a `<video>` seek at every cut) | Yes (decode ahead) | n/a | Yes, after re-render | Yes |
| Keyframes / transitions / blend | Only by re-implementing in CSS (no parity) | Yes, via ported ops | Yes (real FFmpeg) | Yes | Yes |
| Server CPU per edit | 0 | 0 | 0 | Up to a full clip re-render | ~0.2 s per pause (cacheable) |
| Client requirements | Any | WebCodecs + WebGL2 (Chrome/Edge 94+, Safari 16.4+ video, Firefox 130+ desktop; verify before GA) | SharedArrayBuffer for MT; 10 MB+ download | Any | Falls back to (d) if (b) is unavailable |
| Licensing | n/a | Mediabunny MPL-2.0, JASSUB MIT wrapper + LGPL/FTL components | GPL-2.0+ distributed to every browser | FFmpeg on our server (no distribution in SaaS) | MPL-2.0 + LGPL notices |
| Build cost | Low | High (~6–9k LOC engine) | Medium | Medium | High; the single best-quality option |
| Verdict | Only for handles and gizmos, never for pixels | Core of the live preview | **Reject** | Truth/fallback layer | **Recommended** |

Why not (d) alone? It is the only option with exact parity by construction. But it adds 0.5–2 s
per edit, puts the whole CPU cost on the same CPU-only box that runs Whisper, selection and
renders, and its low-res output measured *worse* than the client compositor on pixel fidelity
(0.965 vs 0.9937).

---

## 4. Captions and text in the browser

| Library | Version (npm, 2026-09-24) | libass | Downloads/wk | Notes |
|---|---|---|---|---|
| **jassub** | 2.5.16 (2026-09-05) | 0.17.4-43-g266b983 (from the WASM string) | 13.1k | Maintained. WebGL2/WebGL1/Canvas2D/WebGPU renderers in a worker. `manualRender({mediaTime})` canvas-only mode (used in the lab). SIMD "modern" WASM 2.18 MB (914 KB gz). Worker JS 43 KB gz, main 7.6 KB gz. Threads if COOP/COEP is set (the lab ran with `crossOriginIsolated=true`). License expression: `LGPL-2.1-or-later AND (FTL OR GPL-2.0-or-later) AND MIT AND …`; the JS wrapper is MIT. |
| @jellyfin/libass-wasm | 4.2.4 (2026-01) | older 0.17 | 4.4k | SubtitlesOctopus fork; slower canvas path |
| libass-wasm (SubtitlesOctopus) | 4.1.0 (2022) | old | – | Unmaintained |
| CSS/DOM | – | – | – | Measured SSIM 0.976–0.990. No `\k` sweep, `\t` transforms, BorderStyle-3 boxes or libass wrap. |

Rules that make the numbers above hold:

- **One ASS generator.** Today there are two (`captions_ass.py`, and `render_manifest._build_ass`).
  Pick one:
  - *Option A (recommended):* keep Python canonical and port it to `web/lib/edit-v2/ass/*.mjs`.
    Add **byte-identical conformance vectors**: `tests/fixtures/ass-vectors/*.json` → `*.ass`,
    run by both `pytest` and `node --test`.
    - Known traps: Python `round()` rounds half to even, JS `Math.round` rounds half up; the
      Python `f"{x:g}"` format in `_ass_number`; Unicode category filtering in `ass_escape`.
  - *Option B:* the browser calls a long-lived Python ASS endpoint (~5–20 ms plus RTT). Worse
    offline behavior and typing latency.
- **Never let the client send ASS.** The server regenerates it from the validated document, which
  also removes an injection surface; `ass_escape` already neutralizes override blocks.
- **Pinned font pack, identical bytes on both sides.** Ship it as `assets/fonts/<sha256>.ttf`,
  plus a manifest (family, weight, license, sha256).
  - Server: `ass=filename=captions.ass:fontsdir=/app/assets/fonts`, and install only those fonts,
    so fontconfig cannot pick a different face.
  - Browser: JASSUB `fonts:[…]`, `availableFonts`, `queryFonts:false` (the lab used exactly this).
  - Candidate OFL-1.1 faces for TikTok-style packs: Inter, Montserrat (ExtraBold/Black), Poppins,
    Plus Jakarta Sans (Indonesian-designed), Anton, Bebas Neue, Lilita One, Bangers (comic hook
    style), Noto Sans, DejaVu Sans (current default).
- **Emoji and stickers.** In libass 0.17 glyphs are single-color alpha bitmaps, so color emoji
  fonts do not render in color. Render emoji and stickers as **image overlays** (Noto Emoji OFL /
  Twemoji CC-BY-4.0 PNG/WebP), not as ASS text.
- **Time source.** Pass JASSUB `mediaTime = t_out` **quantized to the output frame grid**
  (`floor(t·fps)/fps`), not the proxy's `mediaTime`. Output time differs from source time once
  there are cuts, cold opens or transitions.
- **Fixed-size canvas.** Size the JASSUB canvas to the output resolution (720x1280, or 1080x1920
  for 1080p exports) with `devicePixelRatio`-independent sizing, then scale with CSS. The default
  `prescaleHeightLimit=1080` does not shrink 1280-high canvases (see `_computeRenderSize`), which
  was verified.
- **Keep `YCbCr Matrix: None`** in the header (already set). This stops JASSUB's color-matrix
  "mangling".
- **z-order bands.** JASSUB draws on its own canvas. Mirror the FFmpeg graph order with three
  bands: `[video, B-roll, under-stickers] → [ASS text] → [over-stickers, logo/watermark]`. That is
  two WebGL canvases with the JASSUB canvas between them, and the FFmpeg graph runs overlay → `ass`
  → overlay. Arbitrary interleaving would need multiple ASS groups; defer it.
- **Future-proof text effects** (LokaClip parity: pop, bump, slam, glow, neon, word_box,
  chunk_karaoke, cumulative, karaoke_sweep). All are expressible as ASS override tags: `\t`,
  `\fscx/\fscy`, `\1a/\3a`, `\kf`, `\blur`, `\bord`. They therefore come *for free* in the
  preview. LokaClip's binary contains exactly these tags (`{\1a&HFF&\3a&HFF&}`,
  `\fscy100\t(…,1.2,\fscy…)`).

---

## 5. Recommended architecture

```
                         EditDocument v2 (JSON, validated both sides, revision + ETag)
                                   │
          ┌────────────────────────┴─────────────────────────┐
  web/lib/edit-v2/compile-scene.mjs                 src/ai_clipper/edit_v2/compile_ffmpeg.py
  (per-frame scene: layers, rects, alphas,          (inputs, -filter_complex, sendcmd script,
   shader params, audio envelope)                    ASS file, fontsdir, encode args)
          │                                                  │
  ┌───────┴────────────── browser ────────────┐     ┌────────┴──────── server (CPU) ─────────┐
  │ engine worker (OffscreenCanvas):          │     │ truth frame: 1 PNG/JPEG @ t (0.2 s)    │
  │  Mediabunny UrlSource → VideoSampleSink   │     │ preview segments: 2 s fMP4, cached by   │
  │  (H.264 proxy, GOP 0.5 s, look-ahead)     │     │   hash(layers∩[t0,t1]) (0.5 s each)    │
  │  WebGL2 op shaders (catalog §5.2)         │     │ final render: same compiler, full res  │
  │ JASSUB worker: same ASS, same fonts       │     └────────────────────────────────────────┘
  │ WebAudio: AudioBufferSink → gain envelope │           ▲ same ASS bytes, same font files
  │ clock = AudioContext.currentTime          │───────────┘
  │ parity sentinel: SSIM(live, truth) on     │
  │   pause, reported as telemetry            │
  └───────────────────────────────────────────┘
```

### 5.1 Files (proposed)

- `src/ai_clipper/edit_v2/schema.py`: dataclasses and JSON Schema export. v2 adds tracks, items,
  keyframes, transitions, assets, `camera_plan` and `fps`.
- `src/ai_clipper/edit_v2/compile_ffmpeg.py`: pure function from document to
  `{inputs, filter_complex, sendcmd_script, ass_text, encode_args}`, unit-tested on strings.
- `src/ai_clipper/edit_v2/ops/*.py` and `web/lib/edit-v2/ops/*.mjs`: one module per catalog op,
  with the same name on both sides.
- `web/lib/edit-v2/sample.mjs` and `src/ai_clipper/edit_v2/sample.py`: keyframe/easing/face-track
  sampling at `n/fps`, with conformance vectors (shared JSON: expected values per frame).
- `web/lib/preview/engine.worker.mjs`, `decoder-pool.mjs`, `audio-graph.mjs`,
  `compositor-webgl2.mjs`, `shaders/*.glsl`, `captions-jassub.mjs`, `truth-frame.mjs`,
  `parity-sentinel.mjs`.
- API routes, next to the existing `edit`, `renders` and `caption-cues`:
  - `GET /api/jobs/:id/media/proxy.mp4` (Range)
  - `GET …/media/peaks.bin`
  - `GET …/media/filmstrip.json` and `…/filmstrip-<n>.webp`
  - `POST …/candidates/:cid/preview-frame` with `{etag, t, w}` → `image/png`
  - `POST …/candidates/:cid/preview-segments` with `{etag, from, to}` → segment URLs

### 5.2 Parity-safe op catalog (the contract)

Each op ships as a pair: an FFmpeg 5.1-compatible template and a GLSL/JS implementation. Each has
golden cases and is behind a feature flag until those pass.

| Op | FFmpeg (prod 5.1.9) | Browser | Parity rule / tolerance |
|---|---|---|---|
| Source range, trim, jump cut | per-range `-ss/-t` input + `setpts=PTS-STARTPTS`, `concat` (existing `_multi_range_command`); audio `afade` 30 ms at joins | output frame n → source time `in + n/fps`, then nearest source frame; WebAudio the same 30 ms fades | Frame-exact. Fix the output `fps` in the document (LokaClip uses `fps=30`). Use one rounding rule, "nearest", on both sides. |
| Reframe crop and scale | `crop=w:h:x:y,scale=W:H:flags=bicubic` | texture sub-rect + bicubic shader (swscale bicubic B=0, C=0.6, footprint widened on downscale) | x and y floored then **cleared to even** (yuv420). Region SSIM ≥ 0.995. Canvas bilinear already gave fg mean diff 0.69. |
| Face-track / smart speaker (`camera_plan`) | `sendcmd=f=cam.cmd` (per output frame) → `crop@cam` x,y (LokaClip pattern), or the existing `if(lt(t,…))` expression for short tracks | Same sampled values | Exact values: the plan is *data* in the document, computed once at analysis and editable. It is no longer detected at render time. |
| Split screen / two-shot | `split`, 2×(crop, scale=1080:960), `vstack` | 2 quads | As crop |
| Fit-blur background | **new:** `scale=90:160:force_original_aspect_ratio=increase:flags=area,crop=90:160,boxblur=4:3:2:3,scale=W:H:flags=bilinear` | area downscale; 3× integer box blur (a port of `vf_boxblur` with mirrored edges and 16.16 fixed point, ~20 lines, in the lab); bilinear upscale | Measured 0.9937 / 36.8 dB (Canvas2D prototype); 37% faster final render |
| Image/video overlay (B-roll, sticker, logo) | `scale`, `format=rgba`, `colorchannelmixer=aa=`, `overlay=x:y:enable='between(t,a,b)':eof_action=pass` (LokaClip uses the same) | Premultiplied textured quad | Same even-pixel rule. Assets normalized to sRGB with color chunks stripped (see bug 2). |
| Text: captions, hook, titles, text overlays | `ass=filename=…:fontsdir=…` | JASSUB `manualRender` | SSIM ≥ 0.9995, max diff ≤ 16 (measured 0.9998 / 13) |
| Fades | `fade=t=in:st=:d=(:alpha=1)` | Uniform alpha | Frame-quantized start and duration |
| Transitions | `xfade=transition=<t>:duration=:offset=` + `acrossfade` | GLSL port of the xfade per-pixel formulas | Allow only deterministic ones: fade, fadeblack, fadewhite, wipe*, slide*, circleopen/close, radial, smooth*, pixelize, squeeze*. **Exclude `dissolve`** (per-pixel random). Check each against FFmpeg 5.1.9. |
| Color adjust | `eq=brightness:contrast:saturation:gamma` | GLSL of the `eq` formulas | Golden per parameter sweep |
| LUT | `lut3d=file=x.cube:interp=tetrahedral` | 3D texture + tetrahedral interpolation | Golden |
| Keyframed transform or opacity | **per-frame `sendcmd` script** (values pre-sampled at n/fps) to overlay x/y, scale w/h (`eval=frame`), `rotate` angle, colorchannelmixer `aa` | The same pre-sampled values | Exact. No expression-language parity needed, and it avoids very deep nested `if()` expressions (their size limit needs testing). |
| Music mix + ducking | `amix=inputs=N:duration=first:normalize=0` (LokaClip), gain via `volume=eval=frame` or sendcmd **from an explicit envelope** computed from transcript speech intervals | WebAudio `GainNode` automation from the same breakpoints | Envelope RMS error < −40 dB. **Do not use `sidechaincompress`**: WebAudio has no sidechain, so it is not reproducible. |
| Loudness | Two-pass `loudnorm` in `linear=true` mode with measured params, which is a constant gain | The same constant gain | Exact |
| Speed ramps | `setpts`, `atempo` | `playbackRate` changes pitch | **Audio parity not achievable**: gate this feature (B-roll or muted clips only) or flag the audio preview as approximate |

**Forbidden in the product**: any effect that exists only in the browser (CSS filters, Canvas
`filter`, Lottie, WebGL-only shaders) until it has an FFmpeg twin. Lottie and animated stickers
are pre-rasterized on the server to WebM with alpha or PNG sequences, and both sides consume that
same asset.

### 5.3 Playback engine details

- **Decode.** Mediabunny `Input(UrlSource)` → `VideoSampleSink.getSample()` for scrubbing and
  `.samples(a,b)` for playback, with look-ahead. At every cut, pre-decode the next range's first
  GOP ≥ 500 ms ahead.
  - Measured on the proxy: 0.33 ms/frame sequential, 3.7 ms p50 for a seek.
  - The lab subset (Input, UrlSource, VideoSampleSink, AudioBufferSink) is **60 KB gzip**.
- **Audio.** `AudioBufferSink` decodes the proxy's AAC. Schedule `AudioBufferSourceNode`s per
  range with the same 30 ms join fades and the ducking/gain automation.
  `AudioContext.currentTime` is the master clock; the video presenter picks the frame for
  `t_out = floor(audioT·fps)/fps` in rAF.
- **Compositor.** Raw WebGL2 on an `OffscreenCanvas` in a worker (optionally `twgl.js` 7.0.0 MIT).
  PixiJS, Konva and Fabric are not used for rendered pixels: their resamplers and blend math are
  theirs, not FFmpeg's, and parity shaders would be custom anyway. Canvas2D `drawImage` quality is
  browser-specific (`imageSmoothingQuality`), so it is not a parity base.
- **Handles and gizmos** (selection box, drag, safe-area guides) stay in DOM above the canvases,
  as now.
- **Fallback.** If there is no WebCodecs or WebGL2, or an op is not yet ported, use server segment
  previews (HLS/fMP4 via `hls.js` 1.7.3, Apache-2.0) and truth frames. Server segments are video
  only; audio stays client-side, which avoids AAC-priming gaps between independently encoded
  segments.
- **Parity sentinel.** On pause, fetch a truth frame (debounced 250 ms; LRU cache keyed by
  `(etag, t)`). Compute SSIM on a downscaled luma image (`ssim.js` 3.5.0 MIT). If it is below 0.98,
  show an "exact frame" badge, swap in the truth frame, and report telemetry. This catches drift
  from GPU drivers, Safari quirks and new ops in production.
- **UX.** An "Exact" toggle shows server frames while paused. An A/B wipe comparator is useful for
  QA.

### 5.4 Changes to the final render (needed for parity, cheap)

1. Set `fps` explicitly (source CFR rate or 30).
2. Tag color explicitly: `-colorspace bt709 -color_primaries bt709 -color_trc bt709
   -color_range tv`, with an explicit YUV↔RGB matrix in scalers.
3. Replace `gblur=sigma=35` with the low-res plate (−37% time, portable).
4. Compute all overlay coordinates with the shared even-rounding rule.
5. Use `fontsdir` with the pinned font pack, and remove the silent `Inter→DejaVu` mapping.
6. Store `camera_plan` in the document instead of detecting at render time.
7. Record `ffmpeg -version`, the libass version, the font-pack hash and the compiler version in
   the render manifest.
8. Parity tests run **inside the production image**. Local FFmpeg 6.1.1 and prod 5.1.9 happened
   to be bit-identical for ASS, but filters such as xfade change between versions.

---

## 6. Media prep on the server (proxies, waveforms, thumbnails)

Measured best-of-3 on this box, which was under concurrent load from other agents. "4 cores" means
`taskset -c 0-3`.

| Job | Command essence | 16 threads | 4 cores |
|---|---|---|---|
| Proxy 120 s, AV1 480p → 640x360 | `-vf scale=-2:360 … -g 15 -sc_threshold 0` | 4.59 s (26x RT) | 6.04 s (20x) |
| Proxy 120 s, H.264 1080p → 960x540 | same | 7.37 s (16x) | 11.32 s (10.6x) |
| **Proxy 120 s, 1080p → 1280x720, g13, bf0** | see spec below | **7.72 s (15.6x)** | **12.53 s (9.6x)** |
| Final 30 s, 720x1280, fit-blur(gblur)+ASS, veryfast crf21 | current graph | 5.10 s | 5.92 s |
| Final 30 s, 1080x1920, same | | 10.23 s | 11.63 s |
| Final 30 s, 720x1280, low-res plate blur | proposed | 3.45 s | – |
| Preview 30 s, 360x640, ultrafast crf30 | | 2.13 s | 2.04 s |
| Segment 2 s, 720x1280 ultrafast (from source) | | 0.56 s | 0.54 s |
| Segment 2 s, from 360p proxy | | 0.48 s | 0.45 s |
| Truth frame PNG, 720x1280 | `-ss t -frames:v 1` | 0.20 s | 0.16 s |
| Waveform decode, 65 min → 8 kHz mono s16 | `-vn -ac 1 -ar 8000 -f s16le` | 9.5 s | – |
| Filmstrip 30 s @1 fps, 160 px, tiled | `fps=1,scale=160:-2,tile=30x1` | 0.33 s | – |
| Whole-source keyframe sprite (65 min) | `-skip_frame nokey … tile=20x40` | 1.5 s | – |

gblur is the single-threaded bottleneck: 16 threads and 4 cores give nearly the same final time.

**Proxy spec** (`media/proxy.mp4`):

```
ffmpeg -i SRC -vf "scale=-2:'min(720,ih)':flags=bicubic,setsar=1,fps=<doc fps>" \
  -c:v libx264 -preset veryfast -crf 24 -g <fps/2> -keyint_min <fps/2> -sc_threshold 0 -bf 0 \
  -pix_fmt yuv420p -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv \
  -c:a aac -b:a 128k -ar 48000 -ac 2 -movflags +faststart proxy.mp4
```

- Why 720p: the 9:16 crop of a 16:9 720p proxy is 405x720, which is 1:1 for a ~405 px preview
  panel. The crop of a 540p proxy is only 304x540 and looks soft on DPR 2.
- Keep **source time = proxy time** (no trimming), so any range can be referenced.
- Storage is ~1.06 Mbps at crf 24 for podcast content, so a 65-min source gives ~515 MB, next to a
  157 MB AV1 original.
- Recommended split:
  - A whole-source **360p crf 30 "scrub proxy"** (~120 MB/65 min; ~2.5–3.3 min CPU at nice 10,
    after transcription). Used for jumping anywhere and cold-open search.
  - A **720p "window proxy"** per candidate, `[start−60 s, end+60 s]` (≈5–8 s CPU, ~20 MB).
    Pre-built for the top-N V3 candidates, or on first editor open.
  - Both go through the existing storage admission and accounting code.

**Waveform peaks** (`media/peaks.bin`):

- Int8 min/max pairs at 100/s (≈780 KB for 65 min, before gzip), plus levels at 25/s and 5/s.
  Byte-compatible with the BBC audiowaveform `.dat` v2 header, which keeps the format standard.
- Compute with numpy in the same decode pass that `audio_timeline.py` already runs (one pass, no
  extra 9.5 s).
- Laughter markers come from `sound_events` (`[tertawa]`); silences and camera cuts from the
  `AudioTimeline`.
- Render with a custom canvas tile renderer (~200 LOC). `wavesurfer.js` 8.0.0 (BSD-3) is possible
  but wants to own playback. `peaks.js` 4.0.0 and `waveform-data` 4.5.2 are LGPL-3.0; not needed.

**Filmstrip**:

- Per window: 1 fps, 160 px WebP sprites (`tile=30x1`), with a JSON index
  `{interval, tileW, tileH, cols, url}`.
- Whole source: take keyframes from the scrub proxy (`-skip_frame nokey`, GOP 0.5 s → 2/s).

LokaClip does the same with `editor_clip_filmstrip`, `editor_clip_peaks{peaksPerSec}` and
`ensure_editor_clip` (a persistent cut copy with decode validation).

---

## 7. Timeline UI: build vs buy

| Package | Version / date | License | Downloads/wk | Assessment |
|---|---|---|---|---|
| @xzdarcy/react-timeline-editor (+ timeline-engine) | 1.0.0 / 2026-01-25 | MIT / ISC | 6.4k | Rows, actions, drag/resize, grid snap, custom action renderers; peer React ≥18. Depends on `react-virtualized` 9.22.6 (legacy, but peer allows React 19) and `interactjs` 1.10 (MIT). No ripple edit, keyframe lanes or word snapping. Usable as a reference or fork. |
| animation-timeline-js | 2.3.5 / 2024 | MIT | 0.6k | Canvas keyframe timeline; stale |
| @designcombo/timeline | 5.5.8 | **DesignCombo Commercial License** (subscription, no redistribution, no competing product) | 11k | Reject |
| @twick/timeline, @twick/video-editor | 0.15.31 | **Sustainable Use License**; pulls `posthog-js` | 3.3k | Reject (license and telemetry) |
| remotion / @remotion/player | 4.0.527 | Remotion License: free ≤3 employees, else **Company License** | 1.2M | Not justified: a React-to-Chromium render model is expensive on CPU-only servers and duplicates FFmpeg |
| @editframe/elements | 0.60.11 | Editframe SDK License: free ≤3 employees, paid above | – | Reject |
| @shotstack/shotstack-studio | 2.19.6 | PolyForm Shield 1.0.0 | – | Reject (non-compete) |
| etro | 0.14.1 | GPL-3.0 | – | Reject for SaaS front-end code |

**Recommendation: build** (~2.5–3.5k LOC), because the model is domain-specific: transcript-linked
source ranges, word snapping, cold open and hook lanes. Helpers:

- `@tanstack/react-virtual` 3.14 (MIT) or manual time-window culling;
- `@use-gesture/react` 10.3 (MIT) or raw Pointer Events;
- `react-aria-components` 1.21 (Apache-2.0) for accessible controls.

Design points:

- **Lanes:**
  - V1 main (source ranges, cold open)
  - V2+ B-roll/media
  - Text/sticker overlays
  - Captions (cue blocks, word ticks at zoom ≥ 200 px/s)
  - Hook text
  - A1 source audio (waveform)
  - A2 music (ducking envelope drawn)
  - Markers (laughter, silence, camera cut, LLM hook suggestions)
  - Keyframe sub-lanes appear for the selected item.
- **Rendering:**
  - Items are absolutely positioned DOM with `transform: translateX`, culled to the visible
    window ± 1 screen.
  - Waveform and filmstrip are 256 px canvas tiles per zoom level (`ImageBitmap` cache).
  - The playhead layer is moved in rAF via refs, never through React state; the current editor
    already does this.
- **Snapping:**
  - Targets, in a sorted array searched by binary search: word start/end (preferring the silence
    midpoint when the gap is > 80 ms), cue edges, item edges, playhead, markers.
  - Magnet radius 8 px; hold Alt to disable.
  - Trims snap to words by default; this is the "word-snapped trim" requirement.
- **Edits:** ripple delete; roll/slip/slide on V1; split (S); J/K/L; I/O; frame step (←/→ =
  1/fps). Transcript deletions create range cuts with 20–40 ms padding into silence and 30 ms
  audio fades.

---

## 8. State, undo/redo, persistence

- **Store:** `zustand` 5.0.15 (MIT) or a `useSyncExternalStore` wrapper. The document is immutable
  JSON; UI state (selection, zoom, playhead) is kept out of history.
- **Commands:** Immer 11.1.18 (MIT) `produceWithPatches` with `enablePatches()`. Each command
  records `{label, patches, inversePatches, mergeKey, at}`.
  - Measured on a 600 KB document (1000 cues, 6000 words, 40 ranges): **15 µs** to trim one item,
    **88 µs** to edit one cue, **487 µs** to mark 12 words deleted, **82 µs** to undo.
  - Mutative 1.3.0 (MIT) did a one-cue edit in 15 µs if more speed is ever needed.
  - Snapshot-based `zundo` is not recommended: memory grows with document size times history
    length.
- **Coalescing:**
  - A drag or slider session is one entry (pointerdown→up, or the same `mergeKey` within 500 ms).
  - Multi-op actions ("apply style pack to all cues") run inside a transaction.
  - History limit 200.
- **Saving:** debounced autosave of the full document via the existing `PUT …/edit` with
  `If-Match` (revision chain + sha256 ETag in `edit_manifest.py`). The server validates the whole
  document; JSON-Patch transport (RFC 6902) is an optional later optimization.
- **Crash-safe draft** in IndexedDB (`idb-keyval` 6.3, Apache-2.0), as a per-viewer convenience
  only.

---

## 9. Parity testing strategy (CI gates)

**Corpus** (`tests/golden/editor-v2/<case>/doc.json` + sources):

- Use 3–4 short, **self-owned or CC0** clips, not YouTube content:
  - 16:9 1080p H.264 two-shot podcast
  - 4:3 source
  - vertical source
  - AV1 480p (the YouTube-download case)
- Cases: every catalog op alone, then combined scenes: cold open + jump cuts + karaoke + hook +
  sticker above captions + B-roll with transition + keyframed zoom + ducked music.

**Sampling times per case:**

- every layer or event boundary ±1 output frame;
- transition 25/50/75%;
- karaoke word boundaries;
- fade midpoints;
- 10 seeded random frames.

**References:**

- The production image (pinned digest) runs `compile_ffmpeg` in *reference mode*: the same graph
  plus `select` of those frames, output as lossless `rgb24` PNG, with color chunks stripped.
- It also does the normal final encode, for encode-loss checks.

**Candidates:**

- Playwright with a **pinned Chrome for Testing**; the lab used 147.0.7727.15, available as
  Playwright's `chromium-1217` build.
- A deterministic capture page renders the scene at each time: DPR 1, compositor fed the
  *full-resolution source* so that compositor error is measured separately from proxy softness.
- Screenshot the stage element, which includes the JASSUB canvas.
- WebKit and Firefox run the same suite **report-only** at first.

**Metrics:**

- FFmpeg `ssim` and `psnr` (All and Y);
- max abs diff; pixel counts above 16 and above 64;
- per-region metrics using layer masks: text bbox, video, overlay;
- layer bbox from alpha, required within ±1 px;
- temporal: the best-matching frame offset in ±2 frames must be 0.

Audio: render the WebAudio graph in an `OfflineAudioContext` and compare its RMS envelope (10 ms
windows) with FFmpeg PCM output. Error must be < −40 dB; join-fade positions within ±1 ms.

**Thresholds**, derived from this lab:

| Check | Gate | Measured here |
|---|---|---|
| Text layers (JASSUB vs libass, RGB) | SSIM ≥ 0.9995, max ≤ 16, 0 px above 32 | 0.9998, max 13 |
| Text on yuv420 reference | SSIM ≥ 0.998 | 0.9982–0.9992 (edge diffs ≤ 93) |
| Full composite, live vs lossless ref | SSIM ≥ 0.99, PSNR ≥ 35 dB, px above 64 ≤ 0.05% | 0.9937, 36.8 dB, 0.016% (Canvas2D prototype; WebGL2 bicubic should raise this) |
| Decode path (WebCodecs vs FFmpeg) | SSIM ≥ 0.997, max ≤ 8 | 0.9983, max 4 |
| Final encode vs lossless | SSIM ≥ 0.99 | 0.995 (crf 21 veryfast) |
| Truth frame vs decoded final | SSIM ≥ 0.99 | same graph, so ≈ encode loss |
| Event timing | Visibility changes on the same output frame | – |
| Within-FFmpeg floor (RGB vs YUV path, same graph) | informational | SSIM 0.9947, 45 dB |

**Gating and artifacts:**

- An op or style pack is **not exposed in the UI** until its golden cases pass. Use the per-op
  feature flags in `ops/*`.
- A red case uploads the ×8 diff heatmap, side-by-side images and metrics JSON as CI artifacts.
  `lab/cmp.py` shows the method.
- The ASS conformance vectors (byte-identical Python vs JS) and the sampling vectors (identical
  per-frame values) run in the ordinary unit suites (`pytest`, `node --test`), so most drift is
  caught before any pixels are compared.

---

## 10. Licensing (commercial SaaS and self-hosted distribution)

| Component | License | Obligation |
|---|---|---|
| Mediabunny 1.59.1 | MPL-2.0 (file-level copyleft) | Unmodified use is fine. If its files are modified, publish those files. |
| JASSUB 2.5.16 | Wrapper MIT; WASM bundles libass (ISC), FriBidi (LGPL-2.1+), FreeType (FTL or GPL-2.0; choose FTL), HarfBuzz (MIT), and others | Ship the WASM as a separate, unmodified asset. Add a third-party notices page with the FreeType credit line, LGPL text and a link to the exact JASSUB tag and build scripts. |
| Immer, zustand, mutative, twgl.js, ssim.js, @tanstack/*, interactjs | MIT | Notices |
| hls.js, react-aria-components, idb-keyval | Apache-2.0 | Notices |
| FFmpeg (Debian build, `--enable-gpl`, libx264) on our server | GPL-2.0+ | Running a SaaS is not distribution. If the Docker image is **distributed** to customers (self-hosted product), provide GPL source offers for FFmpeg and x264 (Debian source packages) and notices. |
| @ffmpeg/core 0.12.10 | GPL-2.0-or-later (x264 inside) | Would be distribution to every browser. Avoid (also rejected on performance). |
| Fonts | OFL-1.1 (Inter, Montserrat, Poppins, Plus Jakarta Sans, Anton, Bebas Neue, Lilita One, Bangers, Noto) | Bundling and embedding allowed; do not sell the fonts alone; keep license files |
| Remotion, Editframe, DesignCombo, Twick, Shotstack Studio | Company, commercial or non-compete licenses | Not used |

Get a legal review before GA for the LGPL static-link-in-WASM question (FriBidi inside JASSUB).
Common practice is unmodified upstream WASM plus a source link, but it is a judgment call.

---

## 11. CPU-only server budget

- **Interactive editing costs the server almost nothing**: proxy bytes over Range requests, one
  ~0.2 s truth frame per pause (cached), and autosave JSON. Compare (d), where every edit costs
  0.5–2 s of CPU.
- **Background jobs**, at nice 10 in the existing primary job queue, after transcription:
  - scrub proxy: ~2.5–6 min per hour of source, depending on source resolution and cores;
  - peaks: 0 extra, reusing the audio pass;
  - sprites: ~1.5 s;
  - window proxies: ~5–8 s per candidate.
- **Final renders:** 30 s at 720p takes ~3.5 s with the plate blur (was 5.1–5.9 s); 1080x1920
  takes ~10–11.6 s today and should drop by a similar gblur share. Measure that after the change.
- **Concurrency caps:** truth frames 2 at a time; preview segments 1 per user, lowest priority;
  cancel superseded requests using the document ETag.

---

## 12. Phased plan with quality gates

1. **P0 (foundation):**
   - Pinned font pack in the image and the browser.
   - A single ASS generator with conformance vectors.
   - JASSUB replaces the DOM caption and hook preview in the *existing* editor.
   - Asset color normalization; `setsar=1`; explicit fps and color tags.
   - *Gate:* text golden tests pass at 0.9995 in the production image.
2. **P1 (media):**
   - Proxies (scrub + window), peaks, sprites.
   - Truth-frame endpoint and "Exact" toggle.
   - Low-res plate blur in the final render.
   - *Gate:* render-time regression tests (−30% or better), and plate SSIM vs old look ≥ 0.99.
3. **P2 (engine):**
   - Mediabunny + WebAudio clock + WebGL2 compositor.
   - Ops: range/cut, crop/scale, fit-blur plate, overlay, fade.
   - Seamless jump-cut playback.
   - *Gate:* composite golden ≥ 0.99 / 35 dB; no dropped frames at 30 fps on the reference
     low-end laptop (define the device); parity sentinel reporting in production.
4. **P3 (CapCut-level):**
   - Timeline v2 (multi-track, ripple, word snapping, keyframe lanes).
   - Transitions (xfade subset), `eq`/LUT, keyframed transforms via sendcmd.
   - Music + ducking envelope; B-roll; stickers; face-track `camera_plan` editing; split screen.
   - *Gate:* per-op golden tests; audio envelope tests; a feature flag stays off until green.
5. **P4 (style packs):**
   - LokaClip-level caption and hook style packs as ASS templates: per_word, chunk_karaoke,
     cumulative, karaoke_sweep; pop, bump, slam, glow, neon, word_box, comic, punchline.
   - AI hook suggestions shown in the hook lane.
   - *Gate:* every pack has golden frames at 5 timestamps and passes.

---

## 13. Risks and open questions

- **Safari/Firefox GPU paths:** color conversion and chroma upsampling of `VideoFrame` in WebGL
  can differ from Chrome's. Hence the sentinel plus report-only suites first.
- **AV1 in WebCodecs:** Safari only with hardware support. The proxies remove this dependency.
- **Frame-rate edge cases:** VFR phone uploads need the proxy with `fps=` normalization; both
  compilers must use the document fps.
- **FFmpeg expression limits:** very long nested `if()` crop expressions (current face-track) are a
  risk. Prefer `sendcmd` (LokaClip does); test the limits in 5.1.9.
- **JASSUB changes:** a JASSUB update changes the libass version. Pin the exact version and gate
  upgrades on the golden suite. Optionally build JASSUB against the same libass tag as the server,
  or build the server's FFmpeg against JASSUB's libass tag; today 0.17.1 vs 0.17.4+git already
  gives 0.9998.
- **Storage:** 720p whole-source proxies are ~0.5 GB/hour. Hence the scrub + window split, which
  needs storage-admission integration.

---

## Appendix A: lab artifacts (reproducible)

All under `scratchpad/editor-design/lab/`:

- **ASS generation:** `gen_ass.py` builds `captions_{karaoke,classic}.ass` with the repo's
  `captions_ass.build_ass` from `artifacts/eval/Ive926sC6mc/transcript.json`, window 600–630 s,
  720x1280, hook text.
- **FFmpeg reference frames:**
  - `ref.sh` renders local FFmpeg 6.1.1 libass frames into `ref/`.
  - `refdocker.sh` renders the same frames inside the production image
    (`ai-video-clipper:latest`) into `refdocker/`.
- **Browser captures:**
  - `serve.mjs`: static server with COOP/COEP and Range.
  - `parity.mjs` + `www/jassub.html`: JASSUB frames into `jassub/`.
  - `css.mjs` + `www/css.html`: best-effort CSS captions into `css/`.
  - `comp.mjs` + `www/comp.html`: Canvas2D compositor modes naive, extend and plate.
  - `decode.mjs` + `www/decode.html`: Mediabunny/WebCodecs support, seek and decode timings, pixel
    readback.
  - `ffwasm.mjs` + `www/ffwasm.html`: ffmpeg.wasm st/mt benchmark.
- **Server benchmarks:** `bench.sh` (proxy, final, preview, segment, frame, waveform, sprites,
  best-of-3) and `blur.sh` (gblur vs low-res plate).
- **Other:** `undo_bench.mjs` (Immer/Mutative patch timings) and `cmp.py` (SSIM/PSNR via FFmpeg
  plus numpy pixel stats).
- **Side-by-side images:** `side_by_side_03.png` (libass vs CSS), `diff_601.png` and
  `diff2_601.png` (compositor diff heatmaps), `blur_compare.png` (gblur vs plate).

Versions checked on npm on 2026-09-24:

- Media and captions: jassub 2.5.16, mediabunny 1.59.1, mp4box 2.4.1, web-demuxer 4.0.0 (MIT),
  @ffmpeg/ffmpeg 0.12.15, @ffmpeg/core 0.12.10.
- Timeline: @xzdarcy/react-timeline-editor 1.0.0, @designcombo/timeline 5.5.8, @twick/timeline
  0.15.31, remotion 4.0.527.
- State: immer 11.1.18, zustand 5.0.15, zundo 2.3.0, mutative 1.3.0.
- Audio and graphics: wavesurfer.js 8.0.0, peaks.js 4.0.0, pixi.js 8.21.0, konva 10.7.0,
  twgl.js 7.0.0, hls.js 1.7.3, ssim.js 3.5.0.

Repo web stack: Next 16.3.3, React 19.2.8, Playwright 1.62.1.
