# Potongin editor: incremental, risk-first architecture proposal

Date: 2026-09-24 · Branch audited: `feat/selection-v3-llm` (read-only; other agents are editing) ·
Inputs: `r1-existing-editor.md`, `r2-feature-inventory.md`, `r3-tech.md`, LokaClip binary strings,
plus six new measurements made for this proposal (§12, scripts in `editor-design/inc/`).

Evidence tags: **[M]** measured on this host (Ryzen 7 5700G; production image
`ai-video-clipper:latest`, FFmpeg 5.1.9 + libass 0.17.1, pinned with `--cpus 4` like the
`render-worker` container), **[R1]/[R2]/[R3]** from the research reports, **[REPO]** read from the
code, **[LC]** LokaClip binary strings, **[E]** an estimate that a gate must confirm.

---

## 0. Summary

**The strategy is to evolve what already works, one shippable step at a time, and to start
with the risks.** The existing editor's storage and concurrency core, render queue and safe
FFmpeg execution are kept and generalised. The document schema, caption renderer and preview
are replaced, and the old editor keeps running until its replacement passes the same gates.

Five decisions carry the design:

1. **The automatic V3 render becomes the first user of the new edit document.** Before any
   editor UI ships, `render_vertical` is rebuilt as `seed_document(...) → compile(doc) →
   execute`. Every automatic clip then exercises the new compiler in production, and "revision 1
   reproduces the auto clip" (R1 G7) holds by construction instead of by testing two
   implementations against each other.
2. **An integer-only, source-anchored edit document (`potongin.edit` v2).**
   - Main-track ranges are integer frames on an absolute source grid at the canvas frame rate.
   - Words are integer source milliseconds; overlays are integer output frames; geometry is
     integer pixels in a 1080×1920 design space.
   - There are no floats anywhere, so Python and JS serialise and round identically.
   - Captions are *derived* from words plus the edit list, never stored as frozen cues. This
     removes the V1 "cue bindings immutable after revision 1" trap.
3. **Preview parity by construction, not by emulation.** Each preview layer gets exactly one
   source of pixels:
   - **text**: libass in the browser (JASSUB) from the same ASS bytes as the server (SSIM
     0.9998 [R3]);
   - **video layout** (face-track, fit-blur, crop, split screen): a server-rendered
     **plate**, i.e. the layout graph with no text, cut into 2-second cells addressed by
     *source time*. Cutting, trimming, cold opens and transcript edits never invalidate a
     plate; only a layout change re-renders the cells it touches (0.56 s per cell [M]);
   - **static stickers and logos**: server-prescaled bitmaps drawn 1:1;
   - **anything else** (transitions, effects, keyframed or video overlays): server-**baked**
     preview segments for exactly the spans that contain them. An effect moves to
     browser-native WebGL only after its golden-frame tests pass. The rule is that an
     approximate pixel is never shown and labelled as the preview.
4. **The browser engine stays narrow.** Mediabunny (WebCodecs) decodes plate cells, the
   WebAudio clock drives playback, and the canvas draws decoded frames 1:1. There is no
   browser-side crop, scale or blur maths in stages 1–3, which removes every geometry parity
   bug R1 found (for example the 246 px crop error and the blur mismatch).
5. **Frame-exact FFmpeg compilation rules found by measurement:**
   - Anchor frame-rate conversion to absolute source time (E6): the current `render.py` rule
     shows a different source frame on 20 of 60 output frames, while the proposed rule matches
     60 of 60.
   - Store the face-track camera path as data and apply it with per-frame `sendcmd`. This is
     bit-identical to today's expression crop, 360 of 360 frames (E2).
   - Make jump cuts frame-exact with one decoder per monotonic run. With 20 cuts the output
     has exactly 2096/2096 frames, A/V differs by 0.7 ms, and it is 13% faster (E4).
   - Duck music with an explicit gain envelope through `amultiply`. WebAudio reproduces it to
     −148.6 dB error (E3).

The plan has five phases (§8). Each phase ships to users and has explicit gates: tests, parity
thresholds, UX acceptance and performance budgets.
- **Phase 1:** V3 clips become editable (trim, cold open, hook text, caption text, layout) with
  an exact preview.
- **Phase 2:** transcript editing, style packs and AI hooks.
- **Phase 3:** overlays, B-roll and music, which completes the LokaClip-level MUST set.
- **Phase 4:** the CapCut core (multi-track, keyframes, transitions, effects).
- **Phase 5:** retire the old editor and render path, and move effects into the browser.

---

## 1. Principles (how "incremental, risk-first" is enforced)

| # | Principle | Consequence |
|---|---|---|
| P1 | **Retire the unknowns first.** Anything that could invalidate the architecture gets a spike with a numeric go/no-go before UI work. | Phase 0 carries spikes S-A…S-F (§8.1). |
| P2 | **Strangler, not rewrite.** New code wraps old entry points with the same signature (`render_vertical`, `edit_manifest` storage helpers) until the gate passes, and then the old body is deleted. | Existing test suites (101 Python, 122 web [R1]) must stay green at every step. |
| P3 | **Every step is shippable behind a flag.** Flags: `POTONGIN_RENDER_ENGINE=v2`, `EDITOR_V2=1`, and per-op preview flags `PREVIEW_NATIVE_<op>=1`. | A bad step is reverted by flipping a flag, not by reverting code. |
| P4 | **One implementation per concern.** One ASS generator (Python, `captions_ass` lineage), one layout compiler, one caption-derivation algorithm. A second implementation (for example a JS port) is added only with byte-identical conformance vectors, and only when latency data demands it. | `render_manifest._build_ass` and `_layout_filter` are retired (R1 §12). |
| P5 | **No silent fallback** (R2 G-FAIL). | A render that cannot honour a setting fails with a named Indonesian error. A preview that cannot be exact says so ("Pratinjau efek sedang dirender"); it never shows a guess. |
| P6 | **Content anchors to source time; edits anchor to output time.** | Words, camera path, layout segments and plate cells are keyed by source time, so edit-list changes never invalidate them. Overlays, hook, music and text are in output frames and ripple with main-track edits. |
| P7 | **Determinism over cleverness.** | Integer document; identical rounding rules (lrint = half-to-even) on both sides; pre-sampled keyframes; no FFmpeg filter with temporal state in plates. |

---

## 2. Architecture overview

```
 V3 pipeline (primary-worker)                             Browser (Chrome/Edge first)
 ───────────────────────────                             ─────────────────────────────
 transcript.json (words) ─┐                               EditorV2 page
 analysis/selection.v3.json┤  seed_document()  ┌──────►   ├─ store: EditDocument (Immer patches, semantic commands)
 analysis/audio-timeline ──┤  (pure, cached)   │         ├─ save loop: PUT If-Match + Idempotency-Key, IndexedDB draft
 analysis/sound-events ────┤        │          │         ├─ timeline / transcript / inspector (DOM, rAF playhead)
 analysis/camera/<sha>.json┘        ▼          │         └─ preview engine
                          EditDocument v2 ─────┘              ├─ clock: AudioContext.currentTime
                            │        │                        ├─ video: Mediabunny ← plate cells (source-time, 2 s)
            compile_ffmpeg()│        │ASS (server-generated)  │          ← baked spans (output-time) for Class B ops
            modes: final,   │        └──────────────────────► ├─ text:  JASSUB manualRender(t_out) – same ASS, same fonts
            plate, bake,    │                                 ├─ over:  static bitmaps 1:1 (server-prescaled)
            frame, audio    ▼                                 ├─ audio: WebAudio buffers + linear gain ramps (same breakpoints)
      FFmpeg 5.1.9 (no shell, fd inputs,                      └─ sentinel: SSIM(live, truth frame) on pause
      protocol whitelist, -progress liveness)
         │               │                 │
  final render     plate/bake cells   truth frame 0.16–0.43 s
  (render-worker   (app container:    (app container,
   queue, v3        interactive lane;   interactive lane)
   requests)        render-worker:
                    prefetch lane)
```

The container roles stay as they are today (`compose.yaml` [REPO]):
- **`app` (6 CPUs):** serves the UI. It runs interactive preview jobs (truth frames, a few
  plate cells, ASS generation) through the existing `execFile` Python bridge pattern, bounded
  by a semaphore.
- **`render-worker` (4 CPUs):** runs final renders and background prefetch through the
  existing file queue, extended with request kinds and priorities.
- **`primary-worker`:** runs the pipeline. At the end of a job it enqueues plate prefetch for
  the top-3 clips.

---

## 3. Data model: EditDocument v2

### 3.1 Identity

- **`clip_id`** = `"clip_" + sha256("potongin-clip-v1\0" + start_ms + "\0" + end_ms + "\0" +
  (co_start_ms + "-" + co_end_ms | "-"))[:24]`.
  - The inputs are the V3 `SelectedClip.start/end/cold_open`, rounded to integer ms. IDs are
    scoped to a job directory.
  - It is **derived, not stored**, so `selection_types.py` (in flight) does not change. A
    selection re-run that yields the same span re-attaches the user's edit. `rank` is never
    used (R1: not stable).
  - V2 candidates map to `"clip_" + sha256("v2cand\0" + candidate_id)[:24]`.
- **Word IDs:** `"w" + zero-padded source start ms (9 digits) + disambiguator a–z`, unique
  within the document. Words are copied into the document (below), so a regenerated
  `transcript.json` never orphans an edit.
- **ETag:** `sha256(canonical bytes)`, unchanged from V1 (`edit_manifest.canonical_manifest_bytes`
  rules: sorted keys, compact separators, `ensure_ascii=False`, NFC, no Cc/Cs).
- **`render_key`:** `sha256(doc ETag ‖ compiler_version ‖ ffmpeg_build ‖ fonts.lock sha ‖
  stylepack shas ‖ export preset)[:32]`. This fixes R1 D8: a renderer upgrade produces a new
  key, while an unchanged document re-exports instantly as a cache hit.

### 3.2 Top level

All times, positions, gains and opacities are **integers**. Allowed strings: IDs, enums, colours
`#RRGGBB`, text (NFC, no Cc/Cs, length-capped) and hex digests.

```jsonc
{
  "schema": "potongin.edit", "version": [2, 0],          // [major, minor]; minor = additive
  "clip_id": "clip_3f9a0c1b2d4e5f60718293a4",
  "revision": 12,
  "parent_revision_sha256": "…64 hex…",                    // rev 1's parent = the seed's sha
  "provenance": {
    "seeded_from": "v3-auto",                              // | "v2-candidate" | "blank"
    "seed_sha256": "…", "job_id": "<uuid>",
    "source": {"content_sha256": "…", "duration_ms": 3912345, "w": 1920, "h": 1080,
               "fps": {"num": 25, "den": 1}, "has_audio": true, "rotation": 0},
    "selection": {"artifact_sha256": "…", "version": "selection-v3.0", "rank_at_seed": 2,
                  "source": "llm", "prompt_version": "llm-select-v1", "archetype": "confession",
                  "hook_unit_id": "S0412", "auto_output": "output/clip-02.mp4"},
    "transcript": {"sha256": "…", "source": "whisper", "word_timing": "asr"},  // | "estimated"
    "audio_timeline_sha256": "…", "sound_events_sha256": "…",
    "compiler_at_seed": "compile-v2.0.0"
  },
  "canvas":  {"design": {"w": 1080, "h": 1920}, "fps": 30, "background": "#000000",
              "safe_zone": "tiktok"},
  "export":  {"preset": "1080p", "crf": 20},             // "1080p" | "720p"; fps = canvas.fps
  "words":   [ /* §3.4 */ ],
  "tracks":  [ /* §3.5, array order = z-order bottom→top */ ],
  "camera":  { /* §3.6 */ },
  "assets":  { /* sha256 → metadata, §6.5 */ },
  "loudness":{"enabled": true, "target_lufs_x10": -140, "tp_ceiling_x10": -10},
  "markers": [{"id": "m1", "f": 450, "kind": "user", "text": "cek ini"}],
  "applied": {"template": null, "stylepacks": [{"id": "kuning-pop", "v": 3, "sha256": "…"}]},
  "audit":   {"created_at": "2026-09-24T10:00:00.000Z", "updated_at": "…", "editor": "web-v2.0.0"}
}
```

**`canvas.fps`** must be one of {24, 25, 30, 50, 60}.
- Seed rule: use the source frame rate if it is one of those integers. Otherwise use 30,
  which covers 29.97 and VFR sources.
- This keeps today's behaviour (a 25 fps source renders at 25, because `render.py` sets no
  `fps`) while making every position an exact frame.
- Audio samples per frame (48000/fps) are integers for every allowed rate.

**Limits** (validated server-side; the canonical document stays ≤ 2 MiB as in V1):

| Limit | Value |
|---|---|
| Tracks | ≤ 16 |
| Items | ≤ 600 |
| Words | ≤ 6,000 (a 180 s clip with ±60 s context is about 900) |
| Keyframes per property | ≤ 600 |
| Text per item | ≤ 500 chars |
| Hook text | ≤ 90 chars (render limit) |
| Assets | ≤ 200 |
| Main-track items | ≤ 400 |
| Duration | 3 s ≤ Σ ≤ 600 s |

### 3.3 Units

| Quantity | Unit | Field suffix |
|---|---|---|
| Main-track source position | frames on the absolute source grid at `canvas.fps` (source time = f / fps) | `_f` with `src_` prefix |
| Output time (overlays, hook, music placement) | output frames | `start_f`, `len_f` |
| Word times, audio-only offsets | source milliseconds | `s`, `e`, `_ms` |
| Geometry | design-space pixels (1080×1920), anchor = item centre | `x`, `y`, `w`, `h` |
| Scale | permille (1000 = 100 %) | `_pm` |
| Rotation | millidegrees | `rot_md` |
| Opacity | permille | `opacity_pm` |
| Gain | centibels (0 = unity, −9600 = mute) | `_cdb` |
| Camera centre | basis points of the source width/height (0–10000) | `cx_bp`, `cy_bp` |
| Speed | rational `{num, den}` | `speed` |

**Rounding rule (shared, conformance-tested).**
- Every derived pixel uses `lrint` (round half to even) and is then cleared to even for
  4:2:0 planes.
- FFmpeg's `crop` does exactly this. Measured in E2: using truncation instead broke 76 of 360
  frames, and `lrint` gave 360 of 360.
- Python's `round()` matches `lrint`. JS needs a `roundHalfEven()` helper, never `Math.round`.

### 3.4 Words (the transcript slice the clip owns)

```jsonc
{"id": "w001203456a", "s": 1203456, "e": 1203790, "t": "gue", "p": 93,
 "d": "Gue",            // optional display override (typo fix); "t" is kept as ASR text
 "fl": 5,               // bit flags: 1 emphasis, 2 hide in captions, 4 cue break before,
                        //            8 join (forbid break) before, 16 filler (detected)
 "emoji": "1f602"}      // optional emoji after the word (Noto Emoji PNG id), rendered as overlay
```

- **Slice.** The seed copies words in `[min(start, cold_open.start) − 60 s,
  max(end, cold_open.end) + 60 s]`. "Perluas konteks" appends more words deterministically.
- **Transcripts without word timings** (`transcript.source = youtube-captions` or old jobs):
  - words are spread over their segment by character count, exactly as
    `subtitles.build_caption_cues` does;
  - they are marked `word_timing: "estimated"`;
  - the UI shows "timing kata perkiraan" on snapping tooltips.
- **Edit semantics** (R2 M5):
  - Editing text never changes timing. Typing extra words splits the word's time by character
    count into new IDs derived from the parent ID (`…a1`, `…a2`).
  - Retiming a word (wordbar) changes only `s`/`e`, and must stay within its neighbours.

### 3.5 Tracks and items

`tracks[0]` is always the **main track**. Every other track has `type` and, if it is visual, a
`band`: `"under"` (below the text band) or `"over"` (above it). The text band sits between
them and always holds the captions, hook and text tracks. This mirrors the FFmpeg order
overlay → `ass` → overlay [R3 §4].

```jsonc
// MAIN (exactly one)
{"id": "main", "type": "main", "intro_hold_f": 0,
 "audio": {"gain_cdb": 0, "mute": false},
 "items": [
   {"id": "i1", "role": "cold_open", "src_in_f": 36735, "len_f": 118},
   {"id": "i2", "role": "body", "src_in_f": 36102, "len_f": 402,
    "join": {"kind": "cold_open_join", "style": "cut", "fade_ms": 30}},
   {"id": "i3", "role": "body", "src_in_f": 36521, "len_f": 377,
    "join": {"kind": "cut", "fade_ms": 8, "reason": "transcript"}}   // jump cut
 ],
 "layout": {"default": "face_track",       // face_track|fit_blur|center_crop|split_two|branded_frame
            "segments": [{"src_from_f": 36600, "src_to_f": 36750, "mode": "split_two",
                          "params": {"top_seat": "A", "divider": "line2"}}],
            "reframe_keys": [{"src_f": 36200, "cx_bp": 3120, "cy_bp": 5000, "zoom_pm": 1000,
                              "ease": "ease_in_out"}]}}
```

**Main-track invariants:**
- `cold_open` items form a prefix of at most 2 items, each 0.5–8 s long (`render.py`
  `COLD_OPEN_MIN/MAX_SECONDS`).
- `len_f ≥ 2`, and 3 s ≤ Σ `len_f` ≤ 600 s.
- Every item lies within the source.
- `join.kind` is one of:
  - `cut` (audio `afade` out/in, 0–50 ms, default 8 ms);
  - `cold_open_join`;
  - `xfade` (Phase 4: `{"type": "fade", "len_f": 8}`, which consumes source handles
    symmetrically so output length never changes);
  - `flash` (Phase 3: 1–3 frames dip to white).
- A jump cut is two consecutive `body` items; transcript deletions produce exactly this.
- `speed` exists only on non-main video items in Phase 4.

```jsonc
// CAPTIONS (0..1) – cues are derived, see §3.7
{"id": "captions", "type": "captions", "enabled": true,
 "pack": {"id": "kuning-pop", "v": 3, "sha256": "…"},
 "overrides": {"size_pm": 1000, "y_pm": 640, "case": "upper", "highlight": "#FFE14D",
               "words_per_chunk": 3, "max_lines": 1, "anim": "pop"},
 "timing_offset_ms": 0,
 "static_cues": [{"id": "sc1", "start_f": 0, "len_f": 60, "text": "…"}]}   // manual blocks

// HOOK (0..1 track, ≤ 3 items)
{"id": "hook", "type": "hook", "items": [
  {"id": "h1", "start_f": 0, "len_f": 120, "text": "Kenapa dia berhenti jadi PNS?",
   "design": {"id": "bar", "v": 1, "sha256": "…"}, "params": {"accent": "#FFE14D"},
   "x": 540, "y": 250, "scale_pm": 1000, "rot_md": 0, "emphasis": [3],
   "labels": [{"text": "FAKTA", "emoji": null}], "source": "v3"}]}   // | "ai:<req>" | "user"

// TEXT (n tracks) – free text, credits, CTA
{"id": "t1", "type": "text", "items": [
  {"id": "x1", "start_f": 30, "len_f": 90, "text": "Source YT : @curhatbang", "role": "credit",
   "style": {"preset": "label-pill", "font": "plus-jakarta-700"}, "x": 540, "y": 1700,
   "scale_pm": 1000, "rot_md": 0, "opacity_pm": 1000,
   "anim": {"in": {"type": "fade", "len_f": 4}, "out": null}, "keys": {}}]}

// GRAPHICS (n tracks) – stickers, emoji, logo, static images
{"id": "g1", "type": "graphics", "band": "over", "items": [
  {"id": "s1", "start_f": 0, "len_f": 900, "asset": "<sha256>", "role": "watermark",
   "span": "full", "x": 980, "y": 120, "w": 140, "h": 140, "rot_md": 0, "opacity_pm": 850,
   "fade_in_f": 0, "fade_out_f": 0, "keys": {}}]}

// VIDEO OVERLAY (B-roll)
{"id": "v2", "type": "video", "band": "under", "items": [
  {"id": "b1", "start_f": 300, "len_f": 75, "asset": "<sha256>", "src_in_f": 0,
   "mode": "pip",                       // cutaway | pip | split_top | split_bottom
   "x": 540, "y": 700, "w": 720, "h": 405, "radius_px": 24, "border": {"px": 0, "color": "#FFFFFF"},
   "opacity_pm": 1000, "fade_in_f": 6, "fade_out_f": 6, "audio": {"gain_cdb": -9600}, "keys": {}}]}

// AUDIO (music / sfx)
{"id": "a2", "type": "music",
 "duck": {"enabled": true, "depth_cdb": 1000, "attack_ms": 30, "release_ms": 400,
          "key": "kept_words", "merge_gap_ms": 250},
 "items": [{"id": "m1", "start_f": 0, "len_f": 900, "asset": "<sha256>", "src_in_ms": 12000,
            "loop": true, "gain_cdb": -1800, "fade_in_ms": 500, "fade_out_ms": 1200, "keys": {}}]}

// EFFECTS (Phase 4)
{"id": "fx1", "type": "effects", "band": "under", "items": [
  {"id": "e1", "start_f": 120, "len_f": 60, "effect": "eq",
   "params": {"brightness_pm": 30, "contrast_pm": 1080, "saturation_pm": 1150, "gamma_pm": 1000},
   "keys": {}}]}
```

**Keyframes (Phase 4)** use `keys: {prop: [{"f": 0, "v": 540, "e": "linear"}, …]}`.
- `f` is relative to the item start.
- `e` is one of `hold`, `linear`, `ease_in`, `ease_out`, `ease_in_out`, or
  `cubic:[x1,y1,x2,y2]` in permille.
- A shared sampler (`edit_v2/sample.py`, later `sample.mjs`) evaluates each property at every
  output frame in float64 and then applies `lrint` into the property's integer unit.
  - Video properties go to FFmpeg as per-frame `sendcmd` lines (the LokaClip pattern; E2
    proved the mechanism exact).
  - Audio gain keys become ≤ 10 ms-spaced linear breakpoints on both sides (§3.8).

**Band rule** (Stages 1–3): anything animated (keyframes, video, Ken Burns) must be in the
`under` band. Only static bitmaps and text sit `over` the captions. This keeps every preview
layer on exactly one pixel source (§4). The rule is relaxed per op when its browser-native
path is promoted.

### 3.6 Camera (face track, smart speaker, manual reframe)

```jsonc
"camera": {"artifact_sha256": "…", "analysis": "haar-v1",   // analysis/camera/<sha>.json
           "status": "ready"}                                // | "pending" (never rendered)
```

The artifact is written once per clip window by `edit_v2/camera.py` (wrapping today's
`face_tracking.detect_face_track`). It is immutable and content-addressed:

```jsonc
{"version": "camera-v1", "source_content_sha256": "…", "src_from_ms": 1140000, "src_to_ms": 1330000,
 "sample_ms": 750, "keys": [{"ms": 1140000, "cx_bp": 4930, "cut": false, "faces": 1}, …]}
```

- **Sampling.** The compiler samples the camera path at every grid frame with exactly
  `build_crop_expression`'s interpolation and `lrint` + even rounding, then writes a
  `sendcmd` script. Measured bit-identical to the current expression crop on 360 of 360
  frames, at the same speed (1.21 s vs 1.21 s) (E2).
- **Overrides.** `main.layout.reframe_keys` (manual reframe) override the artifact inside
  their span, with eased interpolation.
- **Upgrades.** A better detector (YuNet, active-speaker detection) is a *new* artifact
  (`analysis: "yunet-asd-v1"`). The user adopts it explicitly ("Analisis wajah baru tersedia
  — terapkan?"), so old clips never change underneath the user.
- **Policy.** Face-track with no face in a segment fails loudly or uses the plan's explicit
  `fit_blur`. It never falls back silently to a centre crop (R2 M11, LokaClip v1.10.4).

### 3.7 Derived structures (deterministic algorithms, Python-canonical)

**Time map** (`edit_v2/timemap.py`):
- `out_start_f[i] = intro_hold_f + Σ_{j<i} len_f[j]`.
- Output frame `f` in item `i` maps to source frame `src_in_f[i] + (f − out_start_f[i])`.
- Source ms `m` maps to output frames for each item containing `floor(m·fps/1000)`. Several
  items can contain the same source position; a cold open usually duplicates part of the body.
- Lookups use binary search over a cumulative array. The map is monotonic within each item,
  and a property test checks this.

**Caption derivation** (`edit_v2/captions.py`, generalising `subtitles.build_caption_cues`):
1. For each main item, take the non-hidden words whose midpoint falls in the item's source span
   (the `render.py` rule), and clamp them to the item.
2. Map the words to output milliseconds, then add `timing_offset_ms`.
3. Group words into cues. A new cue starts when any of these holds:
   - `words_per_chunk` is reached;
   - the gap exceeds `max_gap_ms` (pack default 600);
   - the display text ends a sentence;
   - a word has flag 4 (break before);
   - the next item's join is `cold_open_join` (the V3 rule: never cross the cold-open join).

   A word with flag 8 suppresses a break. Ordinary jump cuts may be crossed when the output
   gap is under `max_gap_ms`.
4. Apply the minimum display of 300 ms, centisecond quantisation and the no-overlap rule,
   exactly as today.
5. Append `static_cues`.

With no overrides, the output equals `build_caption_cues(transcript, ranges)` for the seed.
This is gate G7.

**Word-snapped trim** (R2 M1):
1. Take the target from the dragged handle.
2. Snap candidates, in priority order: word boundary ± pad (in 40 ms, out 80 ms), then the
   midpoint of a silence longer than 80 ms, then a scene cut.
3. Refine with `AudioTimeline.nearest_quiet_point(t, max_shift=0.1)`.
4. Convert to the frame grid: in-points use `floor`, out-points use `ceil`, so a word is never
   clipped.
5. The out-point may extend over a laughter event: `sound_events` kind laughter within
   0.5 s, extended by `LAUGH_TAIL_SECONDS` = 0.8 as in `selection_v3.py`.

Alt disables snapping.

**Transcript deletion becomes a jump cut** (R2 M4):
- For each maximal run of deleted words inside an item, cut `[prev_kept.e + pad, next_kept.s
  − pad]` with pad = min(40 ms, gap/2).
- Snap the cut edges to the quietest 10 ms bin within ±40 ms, using peaks at 100/s (§4.6).
- Split the item into two, merge any piece shorter than 2 frames, and set `join = {cut,
  fade_ms: 8, reason: "transcript"}`.
- Restoring a "⋯ 2,4 dtk" chip merges the two items back. The chip is derived: kept words
  that fall in a source gap between consecutive body items.
- The operation is exactly invertible; a property test does delete → restore → deep-equal.

**Gap shortening**: every kept inter-word gap longer than X (default 600 ms) becomes Y
(200 ms) by cutting `[w.e + Y/2, next.s − Y/2]`.

**Filler candidates**:
- Detected deterministically from `resources/lexicon/id-fillers.v1.json`: eh, em, emm, ehm,
  hmm, mm, uh, heeh, isolated ah, isolated anu, and immediate repeats.
- The protected particles (sih, dong, kok, lho, deh, kan, ya, nih, tuh, gitu, kayak) are never
  candidates (R2 M4).
- This matches `hook_heuristics._FILLERS`, and a test keeps the two lists in sync.

### 3.8 Audio envelopes (exact in both engines)

**Ducking envelope** (`edit_v2/audio_env.py`):
1. Speech intervals are the **kept words** in output time, merged across gaps under 250 ms.
   Using words instead of VAD makes the envelope deterministic and editable.
2. Breakpoints are in *linear gain*:
   `(s − attack, g0), (s, g0·10^(−depth/20)), (e, ducked), (e + release, g0)`.
   Overlapping ramps merge (the gain stays ducked).
3. Fades and gain keyframes are separate factors, each reduced to linear breakpoints spaced at
   most 10 ms apart.

How each side applies it:
- **Server:** the product of all factors is sampled per 48 kHz sample into a float32 envelope
  stream and applied with `[music][env]amultiply`. Measured max error 7.4e-9 against the
  analytic product; the 10 s envelope costs 55 ms (E3).
- **Browser:** one `GainNode` per factor with `setValueAtTime` / `linearRampToValueAtTime` on
  the same breakpoints. Measured with Chrome 147 `OfflineAudioContext`: max abs error 4.1e-8,
  error energy **−148.6 dB** against FFmpeg (E3b). R3's gate is −40 dB.
- `sidechaincompress` is not used (R3: WebAudio cannot reproduce it).

**Loudness**:
1. Pass 1 renders the audio-only mix and measures it with `loudnorm=print_format=json`. On
   60 s of audio this takes under 2 s [E].
2. The final mix gets a **constant gain** of `target − measured_I`, clamped so that `measured_TP
   + gain ≤ −1 dBTP`, then `aresample=48000` (fixes R1 D4, which output 96 kHz).
3. If the clamp costs more than 1 dB, `alimiter` is applied in the final render only, and the
   preview shows "puncak dibatasi" (peaks limited).

The preview applies the same constant gain. The measurement is refreshed in the background 3 s
after the last audio-affecting edit.

### 3.9 Versioning and migration

| From | To | How | Gate |
|---|---|---|---|
| V3 `SelectedClip` + artifacts | v2.0 seed (revision 0, virtual) | `edit_v2/seed.py::seed_from_v3(clip, transcript, audio_timeline, sound_events, camera, options)`, pure and cached at `analysis/edits-v2/<clip_id>/seed.json` keyed by input shas | G7: compiled seed equals the auto render (§8.3) |
| `clip-edit-v1.0` (V2 candidate) | v2.0 | `edit_v2/migrate.py::from_v1(manifest, candidate, transcript)`, see below | fixtures for every V1 test document; the migrated render passes G1–G4 |
| v2.x | v2.(x+1) | pure `migrate_2_x_to_2_{x+1}(doc)`, applied **on read**; written back on the next save | fixture per minor; `compile(migrate(doc_old)) == compile(doc_new)` for additive minors |
| v2 | v3 (future major) | explicit batch job that writes a new file name and archives the old one | dry-run report before the flag flip |

**What the V1 → v2 migration does:**
- The `timeline` becomes one body item.
- `visual.render_mode` maps to `layout.default`. A `focal_x` becomes one `reframe_key`.
- The canvas becomes `export.preset = "720p"`. Old documents are never upscaled silently.
- Unedited cues are rebuilt from words. **Edited cue text** (text sha differs from
  `original_text_sha256`) becomes `static_cues` with the V1 times, because a free-text edit of
  one 500-character cue cannot be mapped to words honestly.
- `title` becomes a text item for the full clip. `logo` becomes a watermark graphic, because
  the asset store now exists.
- `gain_db` becomes `main.audio.gain_cdb`. `normalize` becomes `loudness.enabled`.
- The migrated document carries `provenance.seeded_from = "v2-candidate"` and shows a one-time
  notice: "Tampilan subtitle diperbarui ke mesin baru" (subtitle look updated to the new
  engine). The V1 renderer bugs (opaque box, character wrap) are *not* emulated.

**Seeding from V3:**
- Body item: `src_in_f = floor(start·fps)`, `len_f = ceil(end·fps) − src_in_f`.
- Cold-open item: likewise, placed first.
- Join: `cold_open_join`, 30 ms fade (the current `AUDIO_JOIN_FADE_SECONDS`).
- Hook: `hook_text` becomes a hook item at 0–4 s with the `bar` design, which is today's
  boxed hook from `captions_ass`.
- Captions: the pack for the current style, `potongin-karaoke-v0` or `potongin-classic-v0`.
  Both are frozen replicas of `captions_ass` today; see G7.
- Layout: the job's `render_mode`, with `camera` from the persisted artifact.

**Virtual seed.**
- `GET …/edit` on a clip with no document returns the seed as revision 0 with its ETag and
  writes nothing, which fixes the V1 "GET creates revision 1" side effect.
- The first `PUT` must carry `If-Match: <seed sha>`. The server recomputes the seed; if its
  inputs changed, it returns 409 `seed_changed` with the new seed, and nothing is lost because
  nothing was saved.
- If the camera artifact is missing (a legacy V3 job), the GET returns 202 `{code: "preparing",
  retry_after_ms}` and enqueues camera analysis. Detection takes about 2–10 s per window [E].

---

## 4. Browser preview architecture and exact-parity strategy

### 4.1 Parity classes (the contract)

Every renderable op is assigned exactly one preview class. A registry
(`web/lib/edit-v2/parity-classes.mjs`, mirrored in `edit_v2/ops.py`) holds the class and its
flag.

| Class | Pixels come from | Ops (initial) | Why it is exact |
|---|---|---|---|
| **T** text | JASSUB 2.5.16 (`manualRender`) with the **server-generated ASS** and the pinned font files | captions (all packs), hook designs expressible in ASS, free text, credits | Measured SSIM 0.9998–0.99988, max diff 13 [R3] |
| **P** plate | server **plate cells**: the layout graph with no text or overlays, 720×1280, source-time addressed | face-track / camera path, reframe keys, fit-blur (low-res box plate), center-crop, split_two, branded frame background | They *are* FFmpeg output of the same compiler; encode loss only (§4.3) |
| **S** static bitmap | a server-prescaled RGBA bitmap at the exact target pixel size, drawn 1:1 at even integer coordinates | stickers, emoji, logo/watermark, static images, gradient hook backdrops (PNG) | No resampling on the client. The final render overlays the *same* prescaled bitmap, colour chunks stripped (fixes R3 bug 2). |
| **B** baked | server **bake segments**: output-time, under-band composite at 720×1280, 2 s, for spans containing such ops | transitions (xfade, flash), effects (eq, LUT, vignette), keyframed transforms, B-roll video, Ken Burns, animated stickers, speed | Same compiler and graph as the final render, limited to the span |
| **N** native | WebGL2 shader or canvas op in the browser | none at launch; candidates are crop-only layouts, `fade`, `eq`, and the xfade `fade`/`wipe*`/`slide*` | Only after promotion (§4.5) |

Audio is always rendered client-side (WebAudio), with the exact envelopes of §3.8.

### 4.2 Engine (Phase 1; about 1.5–2k lines)

**Files** (`web/lib/preview/`):
- `engine.mjs` — clock, scheduler, frame presenter, in a worker with `OffscreenCanvas`
- `plate-source.mjs` — Mediabunny `Input(UrlSource)` per cell, `VideoSampleSink`, and an LRU of
  90 decoded frames (720×1280 RGBA ≈ 330 MB cap)
- `bake-source.mjs`
- `audio-graph.mjs`
- `captions-jassub.mjs`
- `overlay-canvas.mjs`
- `truth-frame.mjs`
- `parity-sentinel.mjs`

**Libraries:**

| Library | Version | Licence | Notes |
|---|---|---|---|
| mediabunny | 1.59.1 | MPL-2.0 | subset ~60 KB gz [R3] |
| jassub | 2.5.16 | MIT wrapper; the WASM bundles LGPL/FTL (notices required) | |
| immer | 11.1.18 | MIT | |
| idb-keyval | 6.3.0 | Apache-2.0 | optional; ~60 lines of raw IndexedDB also suffice |

The web app today depends only on next, react and busboy; these are the only additions for
Phase 1.

**Clock and scheduling:**
- `AudioContext.currentTime` is the master clock; the presented frame is
  `f = floor((ctx.currentTime − t0)·fps)`.
- For frame `f`, the time map gives the source grid frame `g`. The frame comes from cell
  `k = floor(g / (2·fps))`, frame `j = g mod (2·fps)`.
- Decode-ahead fetches the first 15 frames of the next item's cell at least 500 ms before each
  cut. Proxy seeks cost 3.7 ms p50 and 8.6 ms p90 [R3], and a cell always starts on an IDR
  frame.

**Drawing (bottom to top):**
1. The plate frame (or baked frame) on canvas A (720×1280, CSS-scaled with the stage).
2. JASSUB on canvas B, fed `mediaTime = f/fps`, which is the *output* time, not the source time.
3. Canvas C with over-band static bitmaps.
4. The DOM gizmo layer: selection, drag handles, safe-zone guides.

All three canvases share one CSS transform, so scaling is identical.

**Audio:**
- `audio-window.m4a` covers the clip window ±60 s: AAC-LC 48 kHz, source-time aligned,
  produced with the plate.
- Each main item becomes an `AudioBufferSourceNode.start(when, src_in, len)` with 8 ms linear
  gain ramps at joins, the same `afade` default `tri` curve as the server.
- Music and SFX buffers are decoded once and scheduled with their envelope gain chains.

**Not ready yet:**
- Cells that are still rendering show as hatched bands on the timeline.
- Playback proceeds over ready cells. If a needed cell is missing, the presenter holds the last
  exact frame and shows a spinner with "Menyiapkan pratinjau…".
- An approximate crop of the proxy is **never** shown in the output canvas.
- The 360p whole-source scrub proxy is used only in the *source view*: cold-open picking,
  manual reframe gizmo and "Perluas konteks". Those are editing views, not the output.

### 4.3 Plate cells (the core parity device)

**Key:**
```
cell_key = sha256(compiler_version, ffmpeg_build, source_content_sha256,
                  layout slice for [k·2 s, (k+1)·2 s) incl. camera samples + reframe keys,
                  plate spec "720x1280/fps/crf18/g15")
```

**Command:** one process per contiguous run of invalid cells:
- seek to the cell grid;
- `fps` before any re-anchoring (§5.2 rule R1);
- the layout chain;
- `-force_key_frames "expr:gte(t,n_forced*2)" -g 15 -bf 0 -f segment -segment_time 2
  -reset_timestamps 1`;
- BT.709 tags.

**Rules:**
- Plate ops must be **frame-local**: no filter with temporal state, such as `tmix`,
  `deflicker`, or `minterpolate`. A cell rendered alone or in a batch then shows the same
  source frames.
- Camera smoothing is baked into the camera artifact, not computed at render time.

**Measured (E1, `--cpus 4`, 1080p25 source → 720×1280 at 30 fps):**

| Layout | 60 s plate (30 cells), one process | One cell re-rendered alone | Size | SSIM vs lossless (batch cell / single cell) |
|---|---|---|---|---|
| fit-blur (low-res box plate) | **10.11 s** | **0.56 s** | 10.9 MB/min | 0.9957 / 0.9956 |
| center-crop | **10.56 s** | **0.58 s** | 20.5 MB/min | 0.9896 / 0.9896 |

Every cell had exactly 60 frames. Lowering the CRF barely helps crop-mode fidelity: CRF 14
gives 0.9901 for +57 % bytes (E1b). So the gate is relative, "plate SSIM ≥ the final encode's
SSIM − 0.002", not a fixed 0.99.

**Invalidation:**
- Edit-list edits (trim, cuts, cold open, transcript deletions) never invalidate cells.
- A layout-segment or reframe-key edit over `[a, b]` invalidates cells overlapping
  `[a − 0.5 s, b + 0.5 s]`, because easing reaches into neighbours. A 4-cell re-render costs
  about 1.2–2.3 s wall time on 4 CPUs [M: 0.56 s per cell, batching reduces this].

**Storage and scheduling:**
- A 60 s clip with ±30 s of context is about 22–41 MB.
- Plates are *cache*: LRU-evicted per job (at most 5 clip plates), regenerable, and counted by
  the existing storage admission code.
- Prefetch for the top-3 clips when the pipeline finishes: about 3 × 20 s of CPU in the
  render-worker background lane.

This is LokaClip's "clean master" idea, which it invalidates on every edit ("editor clean master
invalidated; it will be rebuilt on next edit" [LC 15728]), made source-addressed and
cell-granular, so Potongin's plate survives all edit-list edits.

### 4.4 Baked segments (Class B)

- **Key:** `bake_key = sha256(compiler_version, doc slice affecting output [f0, f1) — under-band
  items, main items incl. xfade handles —, plate spec)`, with `[f0, f1)` aligned to the 2 s
  output grid.
- **Content:** the plate for that span plus under-band ops, **no text band**, so JASSUB still
  draws text live and typing never waits on a bake.
- **Cost:** a 2 s segment renders in 0.45–0.56 s [R3].
- **Budget:** a Class B span is exact within ≤ 1.5 s p95 after the edit. Until then its
  timeline band is hatched and the canvas holds the last exact frame. This is the render bar
  every NLE shows.
- **Concurrency:** 1 bake process at a time per user, at the lowest priority. Superseded bakes
  (older document ETag) are cancelled with SIGTERM.

### 4.5 Promotion from B or P to N (browser-native)

An op moves to Class N only when all of the following hold:
1. Its golden cases pass in the production image with pinned Chrome (thresholds in §9).
2. The parity sentinel in production shows fewer than 0.1 % of paused frames below SSIM 0.98
   over 14 days while running in "shadow" mode: rendered natively, compared, but not shown.
3. The `PREVIEW_NATIVE_<op>` flag can flip it back.

The first candidates are crop-only layouts (zero server CPU per reframe drag), `fade`, and
`eq`. The WebGL2 compositor (R3 option b, about 6–9k lines) is **only** built if bake latency
data shows users waiting. That is a Phase 5 decision, not a Phase 1 assumption.

### 4.6 Media prep (per job, once)

| Artifact | Command | Cost | Use |
|---|---|---|---|
| `media/scrub-360.mp4` (whole source) | `scale=-2:360,setsar=1,fps=<canvas>` x264 crf 30, g = fps/2 | 2.5–6 min per hour of source [R3], nice 10, after transcription | source view, cold-open picking |
| `media/peaks.dat` (BBC audiowaveform v2 layout, int8 min/max at 100/s) | computed in the `audio_timeline` decode pass | ~0 extra; 780 KB per 65 min [R3] | waveform, 10 ms quiet-point snapping |
| `media/sprite-*.webp` + `sprite.json` | keyframes of the scrub proxy, `tile=20x40` | 1.5 s per 65 min [R3] | filmstrip |
| `media/clips/<clip_id>/audio-window.m4a` | AAC 48 kHz for window ±60 s | < 1 s [E] | preview audio |
| plate cells | §4.3 | 10 s per 60 s, 4 CPUs [M] | preview video |

Markers need no media prep:
- laughter, applause and music from `analysis/sound-events.json` (point events; spans are
  added once the precision gate of R2 M3 passes);
- silences and scene cuts from `analysis/audio-timeline.json`;
- speaker changes from `analysis/speaker-changes.json` when the transcript came from YouTube
  captions.

### 4.7 Truth frames and the parity sentinel

- **Endpoint:** `POST …/preview/frame {etag | draft_sha, f, res}` returns a PNG, compiled in
  `frame` mode (full graph including text, `-frames:v 1`). Colour chunks are stripped.
- **Cost:** 0.16–0.20 s at 720×1280 [R3]; 0.43 s at 1080×1920 [R2]. Results are LRU-cached by
  `(etag, f, res)`.
- **Sentinel:** on pause (debounced 250 ms), fetch the truth frame at 720×1280 and compute SSIM
  on luma downscaled to 360×640 (about 80 lines, in a worker).
  - Below 0.98, show the "Frame persis" badge, swap in the truth frame, and record telemetry
    `{op classes present, browser, gpu, ssim}`.
  - This is how production drift (GPU drivers, Safari, new ops) is caught.
- **UI:** "Render frame ini" (Ctrl+Shift+R) shows the 1080×1920 truth frame side by side.

### 4.8 Browser support

- **Official:** Chromium-based browsers (Chrome/Edge ≥ 120) on desktop, which cover WebCodecs,
  OffscreenCanvas and `requestVideoFrameCallback`.
- **Best effort:** Firefox ≥ 130 and Safari ≥ 16.4, with the sentinel. The suites run
  report-only for those two until they are green.
- **Fallback when WebCodecs is missing:** the preview plays *server-baked full segments with
  text* (bake mode including the text band) through `<video>`. It is exact but slower to
  update, and says so.
- **Headers:** the editor route sends COOP/COEP (`same-origin` / `require-corp`) for JASSUB
  threads, and a CSP of `script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:;
  frame-ancestors 'none'`.
  - The dashboard's Google Fonts `@import` [R1 §8] is replaced by self-hosted OFL fonts. This
    is required under COEP, and it also removes a third-party request.

---

## 5. FFmpeg compilation strategy and CPU performance

### 5.1 Module shape

`src/ai_clipper/edit_v2/compile_ffmpeg.py` is a **pure function**:

```python
def compile_job(doc: EditDocument, *, mode: Literal["final", "plate", "bake", "frame", "audio"],
                span: FrameSpan | None = None, cells: range | None = None,
                preset: ExportPreset) -> FfmpegJob
@dataclass(frozen=True)
class FfmpegJob:
    inputs: tuple[InputSpec, ...]        # kind: source | asset | envelope | lavfi; seek_s, dur_s, demuxer
    filter_complex: str
    side_files: Mapping[str, bytes]      # "captions.ass", "cam-0.cmd", "env-m1.f32", …
    maps: tuple[str, ...]; encode_args: tuple[str, ...]
    expected: Expected                   # w, h, fps, frames, audio_samples, has_audio
```

- **Execution.** `edit_v2/execute.py` runs the job. It reuses `render.py`'s no-shell, fd-based
  temp and no-clobber publication code, and adds:
  - `-protocol_whitelist file,pipe`;
  - a **forced demuxer per input** (`-f mov|matroska|image2|f32le|…`, chosen from the asset's
    ingest record), so user files can never select `hls`/`concat` demuxers;
  - `-progress pipe:3` liveness: 30 s without progress ends in SIGKILL;
  - a timeout of `clamp(60 + 1.5 × out_seconds × px/921600, 120, 3600)` s (R1 D9).
- **Verification.** `edit_v2/verify.py` runs gates G1–G5 on every final render (§9).
- **Unit tests.** They assert on *strings* (graph, `sendcmd`, ASS) without running FFmpeg.
  Integration tests run the production image.

### 5.2 Frame-exact rules (measured)

**R1. Anchor frame-rate conversion to absolute source time.**
- Seek each run to the plate grid or anywhere earlier, apply `fps=<canvas>` *before* any
  timestamp re-anchoring, then `trim=start_frame:end_frame`.
- Never `setpts=PTS-STARTPTS` before `fps`.
- E6 (25 fps source → 30 fps output, 60 output frames):

| Rule | Output frames showing the same source frame as the plate cells |
|---|---|
| proposed: grid seek, then `fps`, then frame trim | **60/60** |
| off-grid seek, then `fps`, then time trim | 60/60 |
| `render.py` today: seek at `src_in`, `setpts=PTS-STARTPTS`, then fps | **40/60** |

  Today's rule would make a third of the frames in any plate-based or proxy-based preview show
  a neighbouring source frame. `render.py` therefore adopts R1 in step 1.5. This is an
  intentional one-time change to auto-render frame choice, covered by the G7-migration gate.

**R2. One decoder per monotonic run.**
- Partition main items into maximal runs where the source position increases. A cold open is
  normally its own run.
- Start a new run when a gap exceeds 10 s, because seeking is cheaper than decoding the gap.
- Each run is `-ss <grid seek> -t <span> -i source`, then `fps`, the layout chain, `split=N`,
  and a `trim=start_frame/end_frame` per item. Audio is `aresample=48000`, `asplit`,
  `atrim=start_sample/end_sample` (`k·48000/fps`) and 8 ms `afade` in/out at cuts, with **no
  overlap**.
- `concat` joins all pieces. E4 (21 ranges, 20 cuts, 70 s output, 720×1280, 4 CPUs):

| Approach | Frames | A/V delta | Wall time |
|---|---|---|---|
| one decoder + frame trims | **2096/2096** | −0.7 ms | **15.6 s** |
| one seeked input per range (today's `_multi_range_command` generalised) | 2096/2096 | −0.7 ms | 17.9 s |

  Both are frame-exact; R2 is 13 % faster and opens 1 decoder instead of 21. `acrossfade` is
  used only for `xfade` joins, where handles keep the length constant (R2: each acrossfade
  otherwise shortens output).

**R3. The camera path goes through `sendcmd` as data.**
- The fixed-size `crop@cam` has per-frame x/y commands written at `(n − 0.5)/fps` from the
  shared sampler with `lrint` and even rounding.
- Bit-identical to the current `build_crop_expression` crop on 360/360 frames (E2). It avoids
  unbounded nested `if()` expressions: 739 characters for 12 s today, growing linearly.
- The crop *size* never changes over time, because FFmpeg cannot reinitialise it [R2].
- Zoom is a *step* ("punch-in") that changes the scale per segment. Animated zoom is out of
  scope until spike S-E passes (§8.1, §11).

**R4. Normalise before joining.** Every segment gets `fps=<canvas>,settb=1/<canvas>,setsar=1,
format=yuv420p` before `concat`/`xfade` (R2: `xfade` otherwise fails on timebase).

**R5. Overlays use shared integer geometry.**
- `overlay=x:y:enable='between(t,a,b)':eof_action=pass` at even pixels computed by the shared
  rounding rule, so FFmpeg's `(int)d & ~1` truncation [R3 bug 3] never has to round.
- Static bitmaps come from a single-frame input with `eof_action=repeat`: no per-frame decode.
- Fades use `loop=-1:1,trim,fade=alpha=1`.

**R6. One `ass` filter** with `fontsdir=/app/resources/fonts`. The ASS uses
`PlayResX/Y = design space (1080×1920)`, so line breaks are identical at the 720p and 1080p
exports. Captions `WrapStyle` and pre-wrapped `\N` + `\q2` follow today's `captions_ass`.

**R7. Colour and container.** `-colorspace bt709 -color_primaries bt709 -color_trc bt709
-color_range tv`, `-map_metadata -1`, H.264 High `veryfast` at CRF from the preset (20), AAC-LC
48 kHz 192 kbps, `+faststart`.

**R8. Fit-blur uses the low-res box plate**:
`scale=90:160:force_original_aspect_ratio=increase:flags=area,crop=90:160,boxblur=4:3:2:3,
scale=W:H:flags=bilinear`. It is 37 % faster than `gblur` and matches its look at SSIM 0.993
[R3].

### 5.3 Final graph (stage-1 shape)

```
runs:   [0:v] fps → layout(run 0: sendcmd crop | plate blur | vstack) → split → trim×n ─┐
        [1:v] fps → layout(run 1) → split → trim×m ─────────────────────────────────────┤ concat
        audio per run: aresample → asplit → atrim×k → afade(8ms)  ──────────────────────┘   │
under:  [asset] single-frame/loop → alpha/fade → overlay(enable=…)  (B-roll: setpts offset) │
text:   ass=captions.ass:fontsdir=…                                                          │
over:   overlay(static bitmaps)                                                              │
audio:  [main] volume(const) ; [music] atrim/aloop,adelay → [env] amultiply ; amix normalize=0│
        → volume(loudness const) → (alimiter only if clamp > 1 dB) → aresample=48000         │
encode: libx264 veryfast crf 20, BT.709 tags, AAC 48k                                        ▼
```

### 5.4 Performance budgets (render-worker, 4 CPUs)

| Workload | Measured / derived | Budget (p95) |
|---|---|---|
| Stage-1 final, 60 s, 1080×1920, fit-blur + karaoke + hook | 30 s at 1080×1920 took 11.6 s with gblur [R3]; the plate blur removes ≈ 36 % [R3] ⇒ ≈ 15 s per 60 s [E] | **≤ 0.5× clip duration** (30 s for 60 s) |
| Stage-1 final, 70 s, 720×1280, 20 cuts, center-crop | 15.6 s [M, E4] | ≤ 0.35× |
| Stage-2/3 graph (cuts, xfade, overlay, animated ASS, ducking, loudnorm) | 17.8 s at 1080×1920 in 9.44 s in the production image [R2] | **≤ 0.75×** |
| 300 s deep-dive clip, 1080×1920 | ≈ 75 s [E] | the timeout formula gives 450 s, well above it |
| Plate, 60 s clip | 10.1–10.6 s [M] | first cell ≤ 1 s; all cells ≤ 12 s |
| Plate re-render after a layout edit (≤ 4 cells) | 0.56–0.58 s per cell [M] | ≤ 2.5 s |
| Bake segment (2 s) | 0.45–0.56 s [R3] | ≤ 1.5 s including queueing |
| Truth frame 720p / 1080p | 0.16–0.20 s / 0.43 s [R3, R2] | ≤ 0.5 s / 0.8 s |
| ASS generation, 60 s / 180 s clip | 1.55 ms / 4.27 ms in-process; Python start + import 30 ms [M, E5] | editor ASS endpoint ≤ 150 ms p95 end-to-end |

**Lanes and concurrency:**
- **Interactive lane** (truth frames, plate cells for the open clip, bakes):
  - runs in the `app` container through `web/lib/preview-jobs.mjs`, using the existing
    `execFile` bridge, `nice -n 5`, and `-threads 2` for x264;
  - allows at most 2 processes, with dedupe by key and cancellation on supersede;
  - moves to a dedicated `preview-worker` service on a Unix socket only if web p95 latency
    degrades by more than 50 ms under load (measure in Phase 1).
- **Final lane:** render-worker queue, 1 at a time as today, priority 1.
- **Prefetch lane:** render-worker, priority 2, preempted by finals. Plates are only prefetched
  when the queue is idle.
- **Source snapshot:** a render request **hard-links** the job source into
  `render-inputs/source.<sha>` (same filesystem) instead of copying ≤ 500 MB [R1 §7.2], with a
  copy fallback. The content sha is still verified at render time
  (`_assert_source_binding`).

---

## 6. API, storage, revisions, concurrency, asset security

### 6.1 Storage layout (per job)

```
analysis/edits-v2/<clip_id>/doc.json                    current (canonical, 0600)
analysis/edits-v2/<clip_id>/seed.json                   cache of the virtual seed (+ inputs digest)
analysis/edits-v2/<clip_id>/archive/r<N>.<sha>.json.gz  superseded revisions (gzip)
analysis/edits-v2/<clip_id>/receipts/<uuid>.json        {key, payload_sha256, result_etag, result_revision, state, created_at}
analysis/edits-v2/<clip_id>/ai/<request_sha>.json       AI suggestion results (audit + cache)
analysis/edits-v2/<clip_id>/.lock
analysis/camera/<sha256>.json                           camera artifacts (immutable)
analysis/assets/<sha256>.<ext> + <sha256>.meta.json     normalised user assets (immutable)
analysis/media/scrub-360.mp4, peaks.dat, sprite-*.webp, sprite.json
analysis/media/clips/<clip_id>/audio-window.m4a
analysis/media/plates/<cell_key>.mp4                    plate cells (cache, LRU)
analysis/media/bakes/<bake_key>.mp4                     bake segments (cache, LRU)
analysis/render-requests/<render_id>.json               queue (existing dir; request v3 adds fields)
output/edits/<clip_id>/<render_key>.mp4 + .srt          finals (no-clobber)
```

### 6.2 Reused core (Phase 0 extraction)

`src/ai_clipper/versioned_store.py` is extracted verbatim from `edit_manifest.py`:
- `_read_regular`
- `_atomic_write`
- `_archive_current`
- `_edit_lock` (flock + process RLock reset after fork)
- canonical bytes
- strict decode (duplicate keys, NaN)
- `_utc_timestamp`

`edit_manifest.py` re-imports them, so its 21 tests pass unchanged.

It changes in three ways:
- **Receipts** store digests only (≈ 300 B, not the 2 MiB manifest). Committed receipts are
  pruned after 7 days or beyond 500 per clip. Pending receipts younger than 1 h are never
  pruned, because crash reconciliation needs them. This fixes R1 D5, the 1000-save lockout.
- **Archive retention:**
  - keep every revision referenced by a non-failed render request, and failed ones for 30
    days;
  - keep the last 100 revisions, all named checkpoints, and seed r0;
  - gzip level 6.
- **The idempotency algorithm is unchanged**, including pending → committed and crash
  reconciliation [R1 §5].

### 6.3 HTTP API (new routes beside the V2 ones; same auth, CSRF and error envelope)

Every mutating route requires:
- `requireAuth`;
- the same-origin check (`Origin == URL origin`, `Host`, `Sec-Fetch-Site`), the existing
  `verifySameOrigin`;
- a streamed, byte-counted body;
- an `Idempotency-Key` (UUID).

Python is reached through `execFile` of `python -m ai_clipper.edit_v2.api` (JSON envelope on
stdin, fixed exit-code map as in `editor_api.py`).

| Route | Method | Body / headers | Result |
|---|---|---|---|
| `/api/jobs/:id/clips` | GET | – | `[{clipId, rank, title, hookText, duration, coldOpen, autoOutputUrl, edit: {revision, etag, updatedAt} \| null, latestRender}]` |
| `/api/jobs/:id/clips/:clipId/edit` | GET | – | 200 doc + `ETag` (revision 0 = virtual seed, `X-Edit-Seed: 1`), or 202 `preparing` |
| same | PUT | `If-Match`, `Idempotency-Key`, JSON ≤ 2 MiB | 200 doc + ETag; 409 `revision_conflict` {current, etag}; 409 `seed_changed`; 422 `semantic_invalid` {path, code} |
| `…/edit/revisions` | GET | `?before=<rev>&limit=50` | `[{revision, etag, updatedAt, label, renders}]` |
| `…/edit/restore` | POST | `{revision, expectedEtag}` | new revision whose content is the old one (label "Pulihkan r7") |
| `…/ass` | POST | draft doc (≤ 2 MiB) **or** `{etag}` | `text/x-ssa` + layout metrics JSON (per-cue/word bboxes for hit-testing). Server-generated, so the client never sends ASS (R3). |
| `…/preview/plate` | POST | `{layoutDigest, cells: [k…]}` | `{cells: {k: {state, url}}}`; missing cells enqueued (interactive lane) |
| `…/preview/bake` | POST | `{etag \| draftDigest, f0, f1}` | `{segments: [{f0, url \| state}]}` |
| `…/preview/frame` | POST | `{etag \| draft, f, res: 720 \| 1080}` | `image/png` |
| `…/renders` | POST | `{"editEtag": "<64hex>", "preset": "1080p" \| "720p"}` (strict regex, ≤ 1 KiB) | 202 status DTO; identical key means an instant `completed` (cache hit) |
| `/api/jobs/:id/renders/:renderId` | GET | – | existing DTO, plus `stage` (Potong/Reframe/Subtitle/Overlay/Audio/Master) and `progress` |
| `/api/jobs/:id/assets` | POST | raw body, `Content-Type` in the allowlist, `X-Asset-Name` (≤ 80 chars), `Idempotency-Key` | 201 `{sha256, kind, w, h, durMs, hasAudio, lufs}` |
| `/api/jobs/:id/assets/:sha` | GET | Range | normalised bytes, immutable |
| `/api/jobs/:id/media/:name` | GET | Range | scrub proxy, peaks, sprites, audio window, plate/bake cells |
| `/api/editor/stylepacks`, `/api/editor/fonts/:sha.ttf` | GET | – | pack JSON (versioned), font bytes (`immutable`) |
| `…/ai/hooks`, `…/ai/keywords`, `…/ai/tighten`, `…/ai/broll` | POST | `{etag, options}` | suggestions (§7). Nothing is written to the document. |

### 6.4 Concurrency and conflict handling

- **Server:** the V1 rules are kept exactly:
  - `If-Match` equals the current sha;
  - `revision` equals current + 1;
  - `parent` equals the current sha;
  - `created_at` is immutable and `updated_at` strictly increases;
  - everything runs under the per-clip flock.
- **Client:** every user action is a **semantic command** addressed by ID, for example
  `TrimItem{itemId, edge, srcF}`, `DeleteWords{wordIds}`, `SetHookText{itemId, text}`.
  - Commands are recorded as Immer 11 patches for undo/redo. Drags and slider moves merge
    under a `mergeKey`, and history holds up to 200 entries. R3 measured the costs: 15 µs to
    trim, 88 µs to edit a cue, 487 µs to delete 12 words, 82 µs to undo, on a 600 KB document.
  - Saves are debounced 1.5 s, also fire on blur, and fire at least every 10 s during
    continuous editing. One PUT is in flight at a time.
  - The draft is persisted to IndexedDB as `{baseEtag, commands, doc}`, keyed by
    `(jobId, clipId)`.
- **Response to a 409:** the client replays its pending semantic commands onto `current` from
  the 409 body.
  - If every command's precondition holds, it saves automatically with "Digabung dengan
    perubahan dari tab lain".
  - Otherwise it keeps the draft and offers "Pakai versi saya (timpa)", a new PUT with
    `If-Match` on the new head (an explicit user choice), or "Pakai versi server". It never
    locks the editor (fixes R1 §5 conflict UX).
- **Not built:** no CRDT or real-time co-editing. Potongin is a single-user product, and
  If-Match plus semantic replay is enough (§11).

### 6.5 Asset upload security

1. **Admission.** Before reading the body, check:
   - authentication and CSRF;
   - the storage admission reservation (existing `storage-admission.mjs`);
   - per-kind caps: image ≤ 20 MB, audio ≤ 50 MB, video ≤ 300 MB;
   - per-job caps: ≤ 2 GB and ≤ 500 assets.
2. **Streaming.** Stream to `analysis/assets/.incoming/<uuid>` (`O_EXCL|O_NOFOLLOW`, 0600) while
   hashing and counting bytes. Abort over the cap.
3. **Magic-byte allowlist:** PNG, JPEG, WebP, static GIF (first frame only), MP4/MOV (`ftyp`),
   WebM/MKV (EBML), MP3, M4A, WAV (RIFF WAVE), Ogg/Opus, FLAC. **SVG, HEIC, PSD and fonts are
   rejected** in stages 1–3.
4. **Probe with a forced demuxer:** `ffprobe -f <demuxer from magic> -protocol_whitelist
   file,pipe`, a 10 s timeout, `-probesize 32M`. Checks:
   - codec allowlist: video h264, hevc, vp9, av1, mpeg4, mjpeg; audio aac, mp3, opus, vorbis,
     flac, pcm_*;
   - dimensions ≤ 4096² and ≤ 16.7 MP (reusing `render_manifest._verify_raster` limits), then
     dimensions are re-checked *before* decode to prevent decompression bombs;
   - fps ≤ 60, duration ≤ 10 min for video and ≤ 15 min for audio.
5. **Normalise:** the bytes that are stored and served are FFmpeg output, never user bytes.
   - Images become PNG sRGB with EXIF orientation applied, metadata and `cICP`/`gAMA`/`iCCP`
     chunks stripped (R3 bug 2), capped at 2048 px on the long edge.
   - Video becomes H.264 High, CFR `canvas.fps`, yuv420p, `setsar=1`, ≤ 1080p, g = fps/2, AAC
     48 kHz, BT.709 tags. That mezzanine serves both WebCodecs preview and the final render.
   - Audio becomes AAC-LC 48 kHz stereo 192 kbps, and ebur128 integrated LUFS is stored in
     `.meta.json`.
6. **Content addressing.** The asset is named by the sha256 of the normalised bytes; the
   original is deleted.
7. **Serving:** `Content-Type` from the allowlist, `X-Content-Type-Options: nosniff`,
   `Content-Disposition: inline; filename="asset.<ext>"`, `Content-Security-Policy: sandbox;
   default-src 'none'`, `Cache-Control: private, max-age=31536000, immutable`.
8. **Garbage collection.** A daily mark-and-sweep treats as references:
   - all current documents;
   - archived revisions referenced by render requests;
   - templates.

   Unreferenced assets are deleted after 7 days.
9. **The worker receives the assets root** (fixes R1 D3), read-only.
10. **Licensing records.** Library assets (Noto Emoji PNG images, Apache-2.0; the curated
    music and SFX packs) carry licence metadata in `.meta.json`, and assets without it are not
    listed (R2 M13).

---

## 7. AI features in the editor (free-first `llm.py`)

All AI calls:
- run in a short-lived process, `python -m ai_clipper.editor_ai <op>`, spawned by the web route
  with a **15 s SIGKILL timeout**. That timeout is the overall deadline `llm.py` lacks;
- use `create_llm_client_from_env(cache_dir=<job>/analysis/llm-cache)`, so the failover chain
  and on-disk cache come for free;
- catch `LLMUnavailable` and `LLMError`, and always return a **deterministic fallback**
  alongside;
- send only the clip window's words (≤ ~2k tokens) and never the API key (llm.py guarantees
  it). They are rate-limited to 30 calls per job per hour, on top of `POTONGIN_LLM_RPM`;
- return *suggestions only*. Applying one is an ordinary undoable command, and the document
  records `source: "ai:<request_sha>"`.

| Feature | Prompt / module | Output (validated) | Deterministic fallback | Acceptance gate |
|---|---|---|---|---|
| **Hook suggestions** (M8) | `prompts/editor_hooks.md` (`editor-hooks-v1`); reuses the hook rules of `standar_klip_ai.md` §1/§3; tone chips Santai/Serius/Lucu/Clickbait halus | 5 × `{text ≤ 60 (UI max 90), archetype ∈ ARCHETYPES, emphasis: [word idx], evidence: "L0003"}` | 4 variants: V3 `hook_text`; the hook unit sentence (via `sentences.build_sentence_units` on the clip's words) shortened on a word boundary; the setup question if `is_question`; the V3 title | **Grounding:** 0 % of variants contain a number or capitalised name absent from the clip words (casefolded, `quote_overlap` from `llm_selection`) on 50 gold clips. **Quality:** the owner rates ≥ 1 of 5 variants ≥ 4/5 on ≥ 60 % of clips. **Latency:** p95 ≤ 8 s, otherwise the fallback shows first and the LLM results stream in. **Rules:** pairwise token Jaccard < 0.7; no emoji (emoji are stickers). |
| **Keyword emphasis** (M5, "AI tandai kata kunci") | `editor-keywords-v1` | ≤ 1 word ID per cue | highest-IDF content word per cue over the episode transcript, excluding particles and fillers | ≥ 80 % agreement with owner picks on 100 cues; never a protected particle |
| **Filler and gap removal** (M4) | **no LLM**: lexicon + repeats + gap shortener (§3.7) | candidate list with per-item toggle and preview | – | precision ≥ 0.9 on 200 labelled Indonesian filler tokens before "Hapus semua" is enabled; protected particles are never selected; 20-cut G-SYNC |
| **"Rapikan ke N detik"** (tighten) | `editor-tighten-v1` | sentence-unit IDs to cut + reason; never the `hook_unit_id` or the payoff unit | drop units that score below median on `hook_heuristics` signals, in order | result within ±15 % of the target duration; the owner accepts ≥ 70 % of proposed cuts on 20 clips |
| **Auto B-roll suggestions** (Phase 3) | `editor-broll-v1` | ≤ 1 per 8 s: `{start_word, end_word, query_id, query_en, kind ∈ person/place/object/brand/concept/reaction, reason}` | none (feature hidden without an LLM) | ghost items on the B-roll lane matched against the user's own assets (filename/tags). **No web image fetching or stock API in stages 1–3** (copyright); stock is a COULD with licence metadata |
| **Refresh title, description, hashtags after edits** | reuse `llm_selection` packaging prompts on the edited transcript | same limits as `selection_types` | keep the V3 values | same validators as V3 |

Known limitation (risk X4): Whisper tends to drop disfluencies ("eh", "em") from transcripts, so
lexicon recall will be modest. The gap shortener works on silences, which are reliable.
"Suara tanpa kata" candidates (a voiced RMS region with no word, from `audio_timeline` plus
peaks) are shown but never auto-selected.

---

## 8. Staged delivery plan

Each step is roughly one PR, shippable behind its flag. Effort is in engineer-weeks [E], for
two engineers working in parallel where the dependencies allow.

### 8.1 Phase 0: hardening, extraction, spikes (≈ 3 ew)

| Step | Change | Gate |
|---|---|---|
| 0.1 | Extract `versioned_store.py`; `edit_manifest.py` re-imports it | the 101 editor Python tests pass unchanged |
| 0.2 | Digest-only receipts + pruning; gzip archive + retention | 5,000 consecutive saves on one clip succeed; receipts dir ≤ 500 files; crash-reconciliation tests still pass |
| 0.3 | Render queue: renderer version in the output key (D8), duration-scaled timeout + `-progress` liveness (D9), assets root passed to the worker (D3), source hard-link snapshot | new tests: a renderer bump forces a re-render; a 300 s clip does not time out; a logo renders in the worker |
| 0.4 | Cheap fixes in the **current** V2 editor, which users of v2-shadow still use: `ass_escape` from `captions_ass` (D2), box alpha on `OutlineColour` (D1), `aresample=48000` after loudnorm (D4), font list restricted to what the image has (D10/P3), fix the two cwd-dependent web tests (D11) | pixel tests: box fill 44–46 at opacity 0.65; `\N` renders literally; 48 kHz output |
| 0.5 | Font pack: `resources/fonts/*.ttf` (OFL: Montserrat, Poppins, Anton, Plus Jakarta Sans, Lilita One, Bangers, Courier Prime, Inter, DejaVu) + `fonts.lock.json` {family, weight, file, sha256, license}; Dockerfile copies them; `fontsdir=` in both render paths | CI: `fc-scan` sha check; the image has no font outside the lock (so fontconfig cannot substitute) |
| 0.6 | Golden harness in the production image: FFmpeg reference frames + Playwright 1.62.1 with pinned Chrome for Testing 147.0.7727.15 + `cmp.py` metrics + heatmap artifacts. First suite: JASSUB vs libass on today's `captions_ass` output | text SSIM ≥ 0.9995, max diff ≤ 16 (R3 measured 0.9998 / 13) |
| 0.7 | Spikes, each with a go/no-go: | |
| S-A | Browser plays plate cells across 20 cuts: Mediabunny + WebAudio clock | 0 dropped frames at 30 fps over 60 s on the reference laptop (4c/8t 2019-class mobile CPU, 8 GB, iGPU, Chrome stable); A/V offset at each cut ≤ 1 frame (rVFC + audio timestamp log). **No-go fallback:** full-segment server bake playback through `<video>` (§4.8) |
| S-B | Rule R1 across 24/25/29.97/30/60 fps and VFR phone sources | plate frame = final frame, source identity 100 % (E6 method) |
| S-C | Camera path via `sendcmd` | done: 360/360 (E2) |
| S-D | `xfade` with handles + R4 normalisation in 5.1.9 | output length = Σ `len_f`; A/V ≤ 1 frame |
| S-E | Animated zoom without jitter (`zoompan` on a 2× pre-scale, vs `scale eval=frame` + fixed crop) | ≤ 0.5 px jitter on a static scene, ≤ 1.2× cost; otherwise animated zoom stays out of scope |
| S-F | JASSUB under COOP/COEP inside Next 16 (worker + WASM + CSP) | loads in < 1.5 s on the reference laptop |

### 8.2 Phase 1: V3 clips become editable with an exact preview (≈ 8 ew)

Scope: open any V3 clip; word-snapped trim; cold-open on/off, re-pick and trim; intro hold;
hook text edit (Bar design) and move; caption word text edits and cue break/join; hide word;
classic/karaoke styles with size/position; layout default (face-track/fit-blur/center-crop);
waveform with laughter, silence and scene-cut markers; transcript panel (read-only,
click-to-seek); undo/redo/autosave/draft/conflict; revisions and "Kembali ke versi AI"; export
720p/1080p; truth frame.

| Step | Change |
|---|---|
| 1.1 | `edit_v2/schema.py` (strict dataclasses, the limits in §3.2), JSON Schema export → `web/lib/edit-v2/edit-v2.schema.json` → Ajv 8.20.0 (MIT, devDependency) **standalone** validator generated at build time; shared fixtures `tests/fixtures/edit-v2/{valid,invalid}/*.json` classified identically by both |
| 1.2 | `timemap.py`, `captions.py`, `sample.py` + conformance vectors `tests/fixtures/edit-v2/vectors/*.json` (the JS mirror of the time map is needed now; the caption and ASS mirrors are not) |
| 1.3 | `camera.py`: persist `analysis/camera/<sha>.json` from `detect_face_track`; sampler + `sendcmd` writer |
| 1.4 | `compile_ffmpeg.py` modes `final`/`frame`/`plate`/`audio` for main runs (R1–R4), layouts, captions via `captions_ass.build_ass` (PlayRes = design space, fonts via `fontsdir`), Bar hook, two-pass constant-gain loudness; `execute.py`; `verify.py` G1–G5 |
| 1.5 | **Strangler:** `render_vertical` becomes `seed → compile → execute` behind `POTONGIN_RENDER_ENGINE=v2`. The signature and sidecar `.srt` are unchanged; `tests/test_render.py` stays green. Flip the default after the G7-migration gate |
| 1.6 | `seed.py` (virtual seed), `ids.py`, storage, `edit_v2/api.py` CLI, routes in §6.3 (edit, revisions, restore, ass, clips, renders), render-request v3 (`clip_id`, `render_key`, `preset`, `kind`, `priority`, `cancelled` state) in `render_queue.py`, worker lanes |
| 1.7 | Media prep: peaks in the `audio_timeline` pass, scrub proxy, sprites, audio window, plate cells (interactive runner `web/lib/preview-jobs.mjs` + prefetch at pipeline end) |
| 1.8 | UI `web/app/projects/[id]/clips/[clipId]/edit/page.jsx` + components: Canvas (engine §4.2), Timeline (lanes: cold open, main, hook, captions, waveform/markers; rAF playhead; word snapping; ≈ 2.5k lines, built in-house [R3 §7]), TranscriptPanel, Inspector, History; the project page links V3 clips to it |
| 1.9 | Truth frame + sentinel + "Render frame ini" |

**Phase 1 gates (all must pass before `EDITOR_V2` defaults on):**

| Gate | Threshold |
|---|---|
| **G7-migration** (once, at the 1.5 flip) | new auto render vs the old `render.py` output on 20 clips (4 gold episodes, both layouts, with and without cold open): duration identical; ASS bytes identical at 1080×1920; SSIM ≥ 0.98 (the frame-choice change of R1 is intentional); owner visual review signs off |
| **G7 round trip** | an unedited seed rendered from the editor has the **same `render_key`** as the auto render and the same bytes, because the auto render *is* the seed compile |
| G1 container | H.264 High, yuv420p, W×H per preset, SAR 1:1, CFR `canvas.fps`, BT.709 tags, AAC-LC 48 kHz stereo, `+faststart` |
| G2 duration and A/V | video frames = Σ `len_f` + `intro_hold_f`; audio samples within ±1 frame; A/V delta ≤ 1 frame (E4 measured −0.7 ms) |
| G3 loudness | −14 ± 1 LUFS integrated, TP ≤ −1 dBTP (or a flagged limiter clamp) |
| G4 integrity | no `blackdetect`/`freezedetect` span > 0.5 s that is absent from the source |
| G5 text-safe | every caption and hook bbox (from ASS layout metrics) inside the TikTok safe zone (R2 G-SAFE); confirmed on sampled frames |
| Text parity | JASSUB vs libass on the new ASS: SSIM ≥ 0.9995, max ≤ 16 |
| Plate parity | plate frame vs `frame`-mode lossless reference: SSIM ≥ final-encode SSIM − 0.002; source-frame identity 100 % (S-B method) |
| Composite parity | live canvas capture (plate + JASSUB) vs final decoded at 720p: SSIM ≥ 0.99, PSNR ≥ 35 dB, geometry ±1 px, frame offset 0 at 10 seeded + boundary frames |
| Audio parity | OfflineAudioContext render vs FFmpeg PCM: envelope error < −40 dB; joins ±1 ms |
| Performance | editor TTI ≤ 2.0 s p95 with the plate prefetched, ≤ 3.0 s to first frame when cold; scrub ≤ 50 ms p95 to paint; 60 s playback with 3 joins drops 0 frames (reference laptop); save p95 ≤ 300 ms; ASS endpoint ≤ 150 ms p95; final ≤ 0.5× clip duration at 1080p |
| Robustness | 5,000-save soak; a two-tab conflict replays or keeps the draft (never locks); reload restores ≤ 2 s of work; property test: random command sequence → undo all = initial document |
| UX acceptance | 5 scripted tasks, 3 first-time testers, median time: fix a clipped first word ≤ 20 s; extend the end to include the laugh ≤ 20 s; turn off the cold open and re-enable it from a different sentence ≤ 45 s; fix a misheard name in captions ≤ 20 s; export and download ≤ 1.2× clip duration of wait |

### 8.3 Phase 2: transcript editing, style packs, hook designs, AI hooks (≈ 8 ew)

| Step | Change |
|---|---|
| 2.1 | Transcript panel editing: select → Delete gives a jump cut; "⋯ 2,4 dtk" restore chips; Ctrl+Shift+X ignore (strike, keep media); filler/gap dialog (§3.7) with per-item preview; Q/W/Ctrl+B/Delete on the timeline |
| 2.2 | Style-pack engine: `edit_v2/ass_v2.py` + `resources/style-packs/*.v<N>.json` (schema in R2 §7.2); 8 packs P1–P8; case, stroke, highlight modes (colour/box/scale); reveal modes (per_word, chunk_karaoke, cumulative, segment_static, karaoke_sweep); animations (fade, pop, slam, glow, box_pop). **Absolute per-word layout** (`\an5\pos` per word) from word advances measured with uharfbuzz 0.56.2 (Apache-2.0, optional extra `editor`) on the pinned TTF |
| 2.3 | Hook designs (9): ASS vector drawings for Bar, Marker, Note, Sticker label, Comic, Quote card, Top banner; Gradient and Punchline backdrops as server PNG (Class S) under the text; labels; emphasis; auto-fit |
| 2.4 | AI hooks, keywords, tighten (§7); UI "Saran AI" with tone chips |
| 2.5 | *Only if* ASS endpoint p95 > 150 ms: JS port of `ass_v2` with byte-identical vectors (traps: Python `round` vs `Math.round`, `f"{x:g}"` formatting, `ass_escape` Unicode categories [R3]) |

**Phase 2 gates:**

| Gate | Threshold |
|---|---|
| Jump-cut sync | G-SYNC with 20 transcript cuts: A/V ≤ 1 frame; caption word onset ±1 frame of `word.s` + offset |
| No clicks | no sample step > −40 dBFS at a cut |
| Reversibility | delete then restore is bit-identical (document and `render_key`) |
| Filler precision | ≥ 0.9 on 200 labelled tokens (else "Hapus semua" stays disabled) |
| Pack parity | every pack × 3 texts (10/40/90 chars, one with digits and "Rp") × 5 timestamps: text SSIM ≥ 0.9995; cap height within ±3 % of spec at 1080×1920 |
| Jitter | non-active words move ≤ 1 px between any two frames of a cue (R2 M7; inline pop measured 56 px) |
| Event budget | < 3,000 ASS events per 90 s clip; animated captions cost ≤ +15 % render time |
| Hook designs | G-PARITY and G-SAFE at 10/40/90 chars; tilted designs keep all corners inside the frame |
| AI | gates in §7 |
| UX | tighten a 70 s clip to ≤ 50 s using only the transcript in ≤ 3 min; apply an AI hook in ≤ 15 s |

### 8.4 Phase 3: overlays, layouts, B-roll, music; completes the MUST set (≈ 10 ew)

| Step | Change |
|---|---|
| 3.1 | Asset API + ingest/normalise + GC (§6.5); Noto Emoji PNG library (Apache-2.0) at 136 px and 512 px; emoji picker |
| 3.2 | Text overlays (Ctrl+T), stickers, emoji, label pills, logo/watermark (4 corners, 85 % default), source credit auto-filled from yt-dlp `channel` (Class S/T) |
| 3.3 | Layout segments: `split_two` (seat pick, divider), fit-blur/black, branded frame; manual reframe in the source view → `reframe_keys` → cell invalidation; speaker chips A/B (face clusters of the camera artifact; `speaker-changes.json` when present) |
| 3.4 | B-roll: image (static = S; Ken Burns = B) and video (cutaway/PiP/split = B), fades, muted by default |
| 3.5 | Music + SFX lanes, ducking (§3.8), fades, loop, licensed library with metadata; "Samakan loudness" |
| 3.6 | Templates + brand kit (workspace dir), apply-to-N-clips with a diff preview; export dialog + batch export; cover frame picker |

**Phase 3 gates:**

| Gate | Threshold |
|---|---|
| Overlay geometry | canvas position = rendered position ±1 px (golden bbox from alpha); rotation ±0.5° |
| Emoji colour | emoji renders in colour in the production image (emoji bbox has > 3 distinct hues) |
| B-roll timing | ±1 frame; a VFR phone clip normalised with no drift over 10 s |
| Ducking | music RMS ≥ 8 dB under voice during speech; recovers within 600 ms; preview vs render envelope < −40 dB (E3b measured −148.6 dB) |
| Asset security | fuzz corpus: a polyglot file, an HLS playlist renamed `.mp4`, a concat-demuxer text, a decompression-bomb PNG, SVG with script, an oversized MP4 with a huge moov. All are rejected or neutralised; none makes FFmpeg read another path or open a URL (checked with strace in CI) |
| Performance | a 60 s clip with 20 overlays + 2 B-roll + music renders ≤ 0.75× at 1080p; editor stays 60 fps with 50 items |
| UX | add logo + credit + 2 emoji + music with ducking in ≤ 2 min |

When Phase 3 is green, every R2 MUST feature M1–M17 is shipped.

### 8.5 Phase 4: CapCut core, R2 SHOULD S1–S16 (≈ 10–12 ew)

Scope:
- free multi-track arrangement (drag between tracks, lock/hide/mute), ripple/roll/slip/slide,
  link/unlink;
- keyframes (position, scale, rotation, opacity, volume; crop pans) with preset easings;
- step zoom punch-ins; animated zoom only if S-E passed;
- transitions: `xfade` subset fade, fadeblack, fadewhite, wipe*, slide*, circleopen/close,
  smooth*, with handles. `dissolve` is excluded (random per pixel);
- effects: `eq`, LUT (strict `.cube` parser in Python, ≤ 33³, re-emitted canonically),
  vignette, sharpen;
- constant speed on muted/B-roll items and freeze frame;
- text animation presets (ASS `\t`, `\move`, `\fad`);
- masks as pre-rendered alpha PNGs + `alphamerge`;
- multi-aspect export (1:1, 4:5, 16:9 design spaces with per-aspect overrides).

Every new op starts in Class B.

**Phase 4 gates per op:**

| Gate | Threshold |
|---|---|
| Graph determinism | identical document → identical graph string, `sendcmd` script and ASS (G-DET) |
| Bake parity | bake vs final at 720p: SSIM ≥ 0.99 |
| Keyframe sampler | Python and JS values equal at every frame (vectors) |
| Transitions | transition length consumes handles; output length unchanged; A/V ≤ 1 frame |
| Pro-trim ops | every ripple/roll/slip/slide op passes a property test that keeps the time map monotonic and captions consistent |
| Performance | 50 items interactive at 60 fps; Stage-2 graph ≤ 0.75× |

### 8.6 Phase 5: consolidation (ongoing)

- Retire the V2 editor route, `render_manifest._build_ass`/`_layout_filter`, and `render.py`'s
  old command builders once the V1 documents are migrated (a batch dry-run report comes first).
- Promote ops to Class N per §4.5, based on sentinel data.
- Pick up COULD items (R2 §9) only after their own spikes.

---

## 9. Test and gate infrastructure

| Layer | What | Where | Runs |
|---|---|---|---|
| Unit (Python) | schema strictness, migrations, time map, captions derivation, snapping, cut/restore inverse, envelopes, compile *strings* | `tests/edit_v2/test_*.py` | every commit (seconds) |
| Unit (JS) | Ajv validator vs fixtures; time-map vectors; commands + undo property tests; save loop (409 replay, idempotent retry) | `web/tests/edit-v2-*.test.mjs` | every commit |
| Conformance vectors | `tests/fixtures/edit-v2/vectors/{timemap,sample,rounding}.json` (+ `ass/*.json → *.ass` from Phase 2.5 if a JS port exists) | shared | both suites |
| Golden frames | cases = every op alone + combined scenes; sampled at boundaries ±1 frame, transition 25/50/75 %, karaoke word onsets, fade midpoints, 10 seeded frames; references are lossless RGB from the production image (pinned digest), PNG colour chunks stripped | `tests/golden/editor-v2/<case>/` + `web/e2e/editor-v2-parity.spec.mjs` | CI job in the production image with pinned Chrome; a red case uploads ×8 heatmaps + side-by-side + metrics JSON |
| Render contract | G1–G5 on every final in production (`verify.py`); failures become a `verification_failed` state with a named Indonesian message | worker | every render |
| Corpus | 4 self-owned or CC0 sources (16:9 1080p H.264 two-shot; 4:3; vertical; AV1 480p) + the 4 gold episodes for G7 and AI gates (clip windows only; no raw transcript in the repo) | `tests/golden/sources/` (LFS or a fetch script) | CI |
| Soak and fuzz | 5,000-save soak; asset fuzz corpus; random command sequences | nightly | nightly |
| Production telemetry | sentinel SSIM per op class; render time per output second; plate cell latency; AI latency and fallback rate; 409 rate | dashboard (existing storage/status pages) | continuous |

Thresholds, tuned to R3's lab:

| Check | Threshold |
|---|---|
| Text layer (JASSUB vs libass, RGB) | SSIM ≥ 0.9995, max ≤ 16, 0 px > 32 |
| Text on 4:2:0 | ≥ 0.998 |
| Composite (live vs lossless) | ≥ 0.99, PSNR ≥ 35 dB, pixels > 64 ≤ 0.05 % |
| Decode | ≥ 0.997 |
| Plate | ≥ final-encode − 0.002 |
| Audio envelope | < −40 dB |
| Timing | frame offset 0 |

---

## 10. Risks (ranked) and mitigations

| # | Risk | Likelihood / impact | Mitigation | Owner gate |
|---|---|---|---|---|
| X1 | **Plate-cell playback across cuts is not seamless on low-end laptops** (decode + canvas upload cost) | M / H | Spike S-A before Phase 1 UI; decode-ahead ≥ 500 ms; frames drawn 1:1 (no scaling); fallback full-segment bake via `<video>` | S-A |
| X2 | **libass version skew** (JASSUB 0.17.4 vs server 0.17.1) changes a glyph or effect | L now (0.9998 measured) / H | pin JASSUB; the golden suite blocks upgrades; option to build the image FFmpeg against JASSUB's libass tag | 0.6 |
| X3 | **Server CPU contention** (plates, bakes, truth frames vs Whisper/selection on one CPU box) | M / M | lanes + priorities; interactive in `app` (6 CPUs, mostly idle) with `nice`; prefetch only when idle; plate LRU; measure web p95 under load and split out a `preview-worker` if needed | Phase 1 perf gate |
| X4 | **Whisper omits fillers**, so filler removal underdelivers | H / L | gap shortener and "suara tanpa kata" candidates; honest UI copy; precision gate | 2.1 |
| X5 | **Face-track quality** (Haar cascade, no active-speaker detection): the wrong face in two-shots | H / H | layout per segment + manual reframe + speaker chips in Phase 3; a better detector is a separate project producing a *new* camera artifact (YuNet ONNX via OpenCV, MIT; ASD later); never a silent centre crop | 3.3 |
| X6 | **Strangler flip changes auto clips** (frame choice R1, fps, fonts) | certain / L | G7-migration on 20 clips with owner review; flag rollback | 1.5 |
| X7 | **Schema churn across phases** | M / M | additive minors with pure migrations on read; fixture per minor; compile equality | every phase |
| X8 | **Asset ingestion attack surface** (FFmpeg demuxers) | M / H | forced demuxer, protocol whitelist, normalise-then-serve, sandbox CSP, fuzz + strace gate | 3.1 |
| X9 | **Free LLM tiers rate-limit or time out** | H / L | deterministic fallbacks always shown; cache; 15 s kill; per-job rate cap | 2.4 |
| X10 | **Licensing**: FriBidi (LGPL) inside the JASSUB WASM; MPL Mediabunny; font OFL; music/SFX; Noto Emoji | M / M | ship WASM unmodified as a separate asset + notices page + source link; legal review before GA; licence metadata required to list assets; no "The Bold Font" or Komika Axis [R2 §7.4] | before GA |
| X11 | **Storage growth** (plates ~22–41 MB per clip, bakes, archives) | M / M | cache classes are LRU-evicted and counted by storage admission; archives gzip + retention; source hard-link snapshots | 0.2, 1.7 |
| X12 | **Two render engines coexisting** during migration | M / M | one flag; V2-editor renders move to the compiler at Phase 5; the old ASS builder is frozen (bug fixes only, from 0.4) | 5 |
| X13 | **Browser support** outside Chromium | M / L | official Chromium; report-only suites + sentinel for Firefox/Safari; bake fallback | 1.9 |

---

## 11. What I would NOT build (and why)

| Not building | Reason | Instead |
|---|---|---|
| DOM/CSS caption or title rendering for the preview | SSIM 0.976–0.990 and no `\k`/`\t` parity [R3]; the source of most R1 P-bugs | JASSUB with server ASS |
| Browser-side crop/scale/blur maths in stages 1–3 | R1 measured a 246 px crop error and a blur mismatch; R3 needs custom shaders per op | server plate cells; Class N promotion later, data-driven |
| A general WebGL2 compositor up front (≈ 6–9k lines) | high cost with unproven need; plates + bakes cover every op exactly | build only if bake latency hurts (Phase 5) |
| ffmpeg.wasm | 32 MB, GPL distribution, 0.9× realtime, no AV1 [R3] | server FFmpeg |
| Remotion, DesignCombo, Twick, Editframe, Shotstack, etro | licences (company, commercial, non-compete, GPL) or telemetry [R3 §7] | in-house timeline (≈ 2.5–3.5k lines) |
| `sidechaincompress` ducking | not reproducible in WebAudio [R3] | explicit envelope + `amultiply` (E3: exact) |
| `gblur` backgrounds | 36 % of render time, not portable [R3] | low-res box plate |
| Time-varying crop size, smooth animated zoom (before S-E), speed ramps with audio, `dissolve` | FFmpeg reinit failure; zoompan jitter; no audio parity; random per pixel | step punch-ins, constant speed on muted items, deterministic `xfade` subset |
| Colour emoji through libass | tofu boxes in production [R2] | Noto Emoji PNG overlays |
| User-uploaded fonts, SVG uploads, Lottie/animated stickers (stages 1–3) | parity (fontconfig substitution), script and XML attack surface, no FFmpeg twin | pinned OFL pack; PNG/WebP; pre-rasterised animation later |
| CRDT / real-time collaboration, JSON-Patch transport | single-user product; documents ≤ 2 MiB, save p95 ≤ 300 ms | If-Match + semantic replay; revisit JSON-Patch only if documents exceed 1 MB |
| A JS port of the ASS generator in Phases 1–2 | a second implementation invites drift; the server ASS path takes ms (E5) | server-generated ASS; port only if p95 > 150 ms |
| AI that edits the document server-side, web image search / stock fetch for B-roll | trust, undo and copyright | suggestions → user-applied commands; own assets only |
| Silent fallbacks (centre crop without a face, font substitution, dropped overlay) | "jangan menurunkan kualitas" | named errors (G-FAIL) |
| Emulating V1 renderer bugs for migrated documents | preserving known defects | one-time notice on migration |
| GPU-only features (background removal, generative smooth cuts, eye contact) | CPU-only server | COULD, after spikes |

---

## 12. New measurements for this proposal (reproducible)

Scripts and outputs are in `editor-design/inc/`. They ran in the production image
(`ai-video-clipper:latest`, FFmpeg 5.1.9) with `--cpus 4`, except E3b (Chrome for Testing 147)
and E5 (host Python 3). The source is `lab/src1080.mp4` (1920×1080 H.264 25 fps, 120 s). Other
agents were loading the machine, so times are indicative.

| ID | Question | Result |
|---|---|---|
| **E1** `e1_plate.sh` | Plate cells: batch vs single cell, size, fidelity | 60 s plate (30 cells) in **10.11 s** (fit-blur) / **10.56 s** (crop); one cell alone **0.56–0.58 s**; 60 frames per cell; 10.9 / 20.5 MB/min; SSIM vs lossless 0.9957 / 0.9896, the same for batch and single cell |
| **E1b** `e1b.sh` | Does a lower CRF raise crop-mode plate fidelity? | CRF 18/16/14 → SSIM 0.98958 / 0.98994 / 0.99011 for 19.6 / 25.8 / 30.7 MB/min: no, so the gate is relative to the final encode |
| **E2** `e2_sendcmd.py` | Camera path as per-frame `sendcmd` vs today's `build_crop_expression` | **360/360 frames bit-identical** with `lrint` rounding (truncation gave 284/360); same speed, 1.21 s vs 1.21 s |
| **E3** `e3_duck.py` | Ducking via envelope + `amultiply` | 480,000/480,000 samples; max abs error **7.4e-9**; 55 ms for 10 s |
| **E3b** `e3_webaudio.mjs` | WebAudio `GainNode` linear ramps vs FFmpeg `amultiply` | max abs error **4.1e-8**, error energy **−148.6 dB**, offline render 4.8 ms |
| **E4** `e4_cuts.py` | 20 jump cuts, frame-exact? | one decoder + frame trims: 2096/2096 frames, A/V −0.7 ms, **15.6 s**; 21 seeked inputs: same exactness, 17.9 s (70 s output at 720×1280) |
| **E5** `e5_ass_latency.py` | Server-side ASS cost | 60 s clip: 56 cues, 6.2 KB, **1.55 ms** p50; 180 s: 177 cues, 16.4 KB, 4.27 ms; Python start + import 30 ms |
| **E6** `e6_grid.py` | Same source frame in preview (plate) and final? | proposed grid rule 60/60; off-grid seek with fps first 60/60; **today's `render.py` rule 40/60** |

Production-image filter availability was checked with `ffmpeg -filters`: `amultiply`,
`sendcmd`, `asendcmd`, `xfade`, `zoompan`, `boxblur`, `lut3d`, `alimiter`, `loudnorm`,
`ebur128`, `colorchannelmixer`, `overlay` (with timeline and commands), `ass`, `tpad`,
`blackdetect`, `freezedetect`, `ssim`, `psnr`. `crop` x/y/w/h are runtime (`T`) parameters.

---

## Appendix A: reuse map

| Existing | Fate | Step |
|---|---|---|
| `edit_manifest.py` storage primitives | **extract** → `versioned_store.py` | 0.1 |
| `ClipEditManifest` schema | **frozen**, migrated by `edit_v2/migrate.py` | 1.x / 5 |
| `editor_api.py` receipts/reconcile | **keep the algorithm**, digest-only + pruning | 0.2 |
| `render_queue.py` | **extend**: request v3 (`clip_id`, `kind`, `priority`, `render_key`, `preset`, `cancelled`), hard-link source snapshot | 0.3, 1.6 |
| `render_worker.py` | **extend**: lanes, scaled timeout, `-progress`, assets root, G1–G5 | 0.3, 1.6 |
| `render.py` | **strangle**: wrapper over seed + compile; fd/no-clobber helpers reused by `execute.py` | 1.5 |
| `captions_ass.py` | **promote** to the single ASS generator (Phase 1), grown into `ass_v2` (Phase 2) | 1.4, 2.2 |
| `subtitles.py` | **generalise** into `edit_v2/captions.py`, equal for seed inputs | 1.2 |
| `face_tracking.py` | **wrap** in `camera.py`; the expression builder is kept as the reference in tests | 1.3 |
| `render_manifest._build_ass`, `_layout_filter` | **retire** (bug fixes only until then) | 0.4 → 5 |
| `candidate_cues.py` | **retire** for V3 (words replace segment cues) | 5 |
| web `edit/page.jsx` (V2) | **keep** until Phase 5; new page beside it | 1.8 |
| web `editor-timeline.mjs` ideas | **keep**: rAF playhead, 10 Hz seek throttling | 1.8 |
| web `preview-source` range streaming | **reuse** for `/media/*` and `/assets/*` | 1.7, 3.1 |
| auth, CSRF (`verifySameOrigin`), `execFile` bridge | **keep** | all |
| `llm.py`, `llm_selection` validators, `hook_heuristics`, `sentences` | **reuse** for editor AI | 2.4 |
| `audio_timeline.py` decode pass | **extend** to write `peaks.dat` | 1.7 |

## Appendix B: new files (planned)

Python (`src/ai_clipper/`):
- `versioned_store.py`
- `edit_v2/{__init__,schema,ids,seed,migrate,timemap,captions,sample,camera,audio_env,ass_v2,stylepacks,ops,compile_ffmpeg,execute,verify,api,assets,media_prep}.py`
- `editor_ai.py`
- `prompts/editor_{hooks,keywords,tighten,broll}.md`
- `resources/{fonts/, fonts.lock.json, style-packs/, hook-designs/, lexicon/id-fillers.v1.json}`

Web:
- `web/lib/edit-v2/{edit-v2.schema.json, validate.generated.mjs, timemap.mjs, commands.mjs, history.mjs, store.mjs, save-loop.mjs, draft-idb.mjs, parity-classes.mjs, rounding.mjs}`
- `web/lib/preview/{engine,plate-source,bake-source,audio-graph,captions-jassub,overlay-canvas,truth-frame,parity-sentinel}.mjs`
- `web/lib/preview-jobs.mjs`
- `web/app/projects/[id]/clips/[clipId]/edit/page.jsx` + `components/editor-v2/*`
- `web/app/api/jobs/[id]/clips/**`, `web/app/api/jobs/[id]/assets/**`,
  `web/app/api/jobs/[id]/media/**`, `web/app/api/editor/**`

Tests:
- `tests/edit_v2/*`, `tests/fixtures/edit-v2/**`, `tests/golden/editor-v2/**`
- `web/tests/edit-v2-*.test.mjs`, `web/e2e/editor-v2-parity.spec.mjs`
