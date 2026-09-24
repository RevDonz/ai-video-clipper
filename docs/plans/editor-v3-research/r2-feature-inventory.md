# R2: Potongin editor feature inventory

Status: research deliverable, 2026-09-24. Read-only on the repo. Artifacts that back the
measurements are under `editor-design/_bench/` (renders, frames, contact sheets) and
`editor-design/_sources/lokaclip-releases.md` (all LokaClip release notes, v1.4.8 to v2.1.0).

Each claim carries one of these evidence tags:

| Tag | Meaning |
|---|---|
| `[LC-bin]` | LokaClip `loka-clip.exe` string table (`lokaclip/strings.txt`, line numbers given) |
| `[LC-rel vX]` | LokaClip public release notes, `github.com/Rafi718/lokaclip_release` |
| `[WEB]` | Vendor or third-party web page (listed in §11) |
| `[FIELD]` | Measured from 21 popular `#podcastindonesia` YouTube Shorts (88 k to 5.7 M views), §2.3 |
| `[BENCH]` | Measured on this host: Ryzen 7 5700G (16 threads). Local run: ffmpeg 6.1.1 + libass 0.17.1. Production run: the `ai-video-clipper:latest` image (ffmpeg 5.1.9, libass 0.17.1) |
| `[REPO]` | Current Potongin code |

---

## 0. Summary of decisions

1. **Stage 1 (MUST) is LokaClip parity plus the gaps LokaClip still has.** LokaClip v2.1.0
   already ships the following:
   - jump cuts, undo and redo, subtitle blocks on the timeline;
   - a hook that can be moved and resized;
   - free text, image and video overlays;
   - music with separate clip and music volume, and a watermark;
   - four layouts plus a two-person split screen;
   - five caption reveal modes and eight caption animations;
   - seven hook designs, intro hold, and named templates.

   Its own changelog says "preview identical to render" (v1.9.6, v2.0.5).

   LokaClip does not have the following (from its binary and changelog), so these are where
   Potongin can win:
   - **music ducking**: LokaClip mixes with `amix … normalize=0` and a static `volume=`
     `[LC-bin 15823-15825]`;
   - **transcript (text-based) editing**;
   - **filler and silence removal**;
   - **laughter and sound-event markers**;
   - **cold open**: LokaClip only has an intro *hold* (freeze frame), not a re-ordered hook
     line;
   - **AI hook variants inside the editor**;
   - **emoji rendering**;
   - **source-credit automation**.
2. **Stage 2 (SHOULD) is the CapCut core.** It covers a multi-track timeline with
   ripple/magnetic main track, keyframes with easing, transitions, effects and filters, speed,
   SFX, text animation, masks/PiP, and multi-aspect export.
3. **Stage 3+ (COULD)** covers AI B-roll search, TTS/dubbing, translation, background
   removal, an agentic "edit by chat" mode, direct publishing, and collaboration.
4. **Caption style packs** (§7) come from what top Indonesian clipper channels actually use
   `[FIELD]`, not from US templates. The dominant looks are:
   - ALL-CAPS heavy sans with a black stroke, at 61–70 % of frame height, with cap height
     1.7–2.6 % of frame height;
   - an active word shown as a **black box**, a **yellow highlighter box**, or a
     **colour swap** (yellow base with a red keyword);
   - one-word-at-a-time pop;
   - lowercase "typewriter" captions.

   Hooks and titles are:
   - white quote cards;
   - coloured top banners;
   - red "sticker label" pills with an emoji;
   - a thumbnail-style cover as the first frame.
5. **Non-negotiable render rules found by measurement** `[BENCH]`:
   - **Emoji.** libass 0.17.1 cannot draw colour emoji. It drew monochrome outlines locally
     and **tofu boxes in the production image**. Emoji must be composited as PNG overlays.
   - **Pop animation.** Inline `\fscx/\fscy` "pop" reflows the whole line: neighbouring words
     moved **56 px at 1080 px width** during one 170 ms pop. Every word must be laid out at an
     absolute `\pos`.
   - **Fonts.** The production image has **only DejaVu fonts**. The V2 manifest offers
     "Inter" and "Noto Sans", but those do not exist in the image, so preview and render already
     diverge. OFL font files must be bundled and passed to libass with `fontsdir`, and the
     browser must load the same files.
   - **xfade** fails unless both inputs share a timebase (`settb`), frame rate and SAR.
   - **acrossfade.** Each `acrossfade` shortens audio by its duration. Jump cuts must use
     micro-fades (5–10 ms `afade` out/in) without overlap, or A/V drift accumulates. With
     0.03 s + 0.25 s crossfades, the test output ended 33 ms out of sync.
   - **Crop size cannot change mid-stream** (`Error reinitializing filters`). Zoom keyframes
     need `zoompan`, or scale-then-fixed-crop. Pans (`sendcmd` on `crop@c` x/y, as LokaClip
     does) are fine.
   - **Render cost is acceptable on CPU.** The full stage-2 graph (3 segments, punch-in zoom,
     xfade, image overlay, animated ASS, sidechain ducking, loudnorm), 17.8 s output at
     1080×1920, took **5.9 s locally and 9.4 s in the production image** (about 1.9–3.0×
     realtime). A single exact server-rendered frame takes 0.43 s. A 540×960 proxy of a 20 s
     clip takes 1.7 s.
6. **Preview parity strategy:**
   - the browser renders captions and titles with **JASSUB** (npm `jassub@2.5.16`, libass
     0.17.4 compiled to WASM) from the **same ASS text and the same font files** as the server;
   - the browser composites layout and overlays from the same geometry JSON;
   - a CI **golden-frame suite** diffs browser frames against ffmpeg frames;
   - a **"Render frame ini"** (server-truth frame) button costs 0.43 s.

   Note the version skew: libass 0.17.1 on the server against 0.17.4 in JASSUB. The two must be
   pinned together or gated by golden tests (§3).

---

## 1. Competitor feature matrix (short-form podcast relevant)

✔ means shipped, ◐ means partial, ✘ means absent or not found.

| Capability | LokaClip 2.1 | CapCut desktop | OpusClip | Descript | Submagic / Captions.ai | VEED / Kapwing | Potongin today `[REPO]` |
|---|---|---|---|---|---|---|---|
| Word-timed captions + styles | ✔ 5 reveal modes, 8 animations `[LC-bin 14188,14191]` | ✔ auto captions, word-by-word, "Auto highlight keywords" `[WEB]` | ✔ templates Karaoke, Beasty, Deep Diver, Pod P, Mozi… `[WEB]` | ✔ | ✔ 41 Submagic templates; 75+ Captions styles `[WEB]` | ✔ | ◐ `classic`/`karaoke` in V3 render; V2 editor presets `clean, bold-keyword, karaoke, podcast, minimal`, keyword emphasis unsupported |
| Caption text editing | ✔ click to edit, timeline blocks (move, extend, split, delete) `[LC-rel v1.10.0]` | ✔ | ✔ | ✔ wordbar retime | ✔ | ✔ | ◐ cue text edit (V2) |
| Hook / title text | ✔ Gradient, Note, Marker, Bar, Punchline, Sticker, Comic; movable; char counter `[LC-rel 1.9.2–2.1.0]` | ◐ generic text | ✔ AI hook title | ✘ | ◐ | ◐ | ◐ top box hook, 90 chars, 4 s `[REPO captions_ass.py]` |
| Intro hold / cold open | ◐ intro hold only (`tpad start_mode=clone`) `[LC-bin 15838]` | manual | ◐ | manual | ✘ | ✘ | ✔ cold open in V3 render (0.5–8 s) |
| Jump cut / segment delete | ✔ cut at playhead, gap closes, subtitles shift `[LC-rel v1.10.0]` | ✔ | ✔ | ✔ | ◐ | ✔ | ✘ |
| Transcript-based editing | ✘ | ✔ "Transcript-based editing", fillers, pauses `[WEB]` | ✔ "edit like a doc" | ✔ delete vs ignore, restore `[WEB]` | ◐ | ◐ | ✘ |
| Filler / silence removal | ✘ | ✔ | ✔ | ✔ Shorten word gaps (threshold + target, e.g. 200 ms) `[WEB]` | ✔ | ✔ Smart Cut sensitivity slider, per-silence handles `[WEB]`; VEED Magic Cut | ✘ (silences computed in `audio_timeline.py`) |
| Waveform | ✔ `peaksPerSec` `[LC-bin 14179]` | ✔ | ✔ | ✔ | ✔ | ✔ | ✘ |
| Sound-event markers (laughter) | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | data exists (`sound_events.py`), not surfaced |
| Layouts | ✔ fill, smart_speaker, fit_black, fit_blur `[LC-bin 14195]`; stacked two-shot (capped 5 s, v1.9.5) | manual + Auto reframe | ✔ Fill, Fit, Split, Three; manual reframe `[WEB]` | ✔ layouts, scenes | ◐ | ◐ | ◐ fit-blur, center-crop; face-track in V3 render but "unsupported" in V2 editor render |
| Speaker detection | ✔ YuNet face + Silero VAD + ASD (mouth ROI) + scene + camera plan single/twoshot/wide `[LC-bin 14104-14151, 14832, 16089]` | ✘ (no ASD) | ✔ ReframeAnything | ◐ | ✘ | ✘ | ◐ OpenCV face track (`face_tracking.py`) |
| Image/video overlay (B-roll) | ✔ image v1.10.4, video v2.0.0; fade in/out, time-sliced `[LC-bin 15833-15838]` | ✔ | ✔ AI B-roll | ✔ | ✔ AI B-roll | ✔ | ◐ 1 logo overlay |
| Music | ✔ path, `musicVolume`, `clipVolume`, **no ducking** `[LC-bin 14194, 15824]` | ✔ + ducking (mobile documented) `[WEB]` | ✔ AI music | ✔ | ✔ | ✔ | ✘ |
| Watermark / logo | ✔ 4 corners, 85 % alpha `[LC-bin 15820]` | ✔ | ✔ brand template | ✔ | ✔ | ✔ | ✔ logo overlay |
| Keyframes / transitions / effects | ✘ | ✔ keyframes + graphs, transitions, effects, filters `[WEB]` | ◐ transitions, auto-zoom | ◐ scene transitions | ✔ AI zoom, SFX | ✔ | ✘ |
| Templates / presets | ✔ named templates, 4 built-ins, user style-pack JSON dir `[LC-rel v1.10.2, LC-bin 13992]` | ✔ | ✔ brand templates | ✔ | ✔ themes | ✔ brand kit | ✘ |
| Undo/redo, autosave | ✔ Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y; autosave `[LC-rel v1.9.8, v1.10.0]` | ✔ | ✔ | ✔ | ✔ | ✔ | ◐ revision-based manifest (etag, parent revision) |
| Preview = render | ✔ claimed | ✔ (single engine) | ✔ | ✔ | ✔ | ✔ | ✘ (720×1280 manifest, fonts diverge) |

What the LokaClip binary tells us about its data model, decoded from serde field names:

- **Subtitle style** `[LC-bin 14187,14191]`: `presetId, backdrop, backdropColor,
  backdropOpacity, cornerRadiusPx, paddingPx, fontFamily, fontSizePx, fontWeight
  (regular|bold), textColor, outlineColor, outlinePx, gradientHeightPct, gradientOpacityMax,
  bottomMarginPct, wrapWidthFrac, maxChars, fadeInSec, fadeOutSec, customPositionX/Y,
  position (top|middle|lower_third|bottom), revealMode
  (per_word|chunk_karaoke|cumulative|segment_static|karaoke_sweep), wordsPerChunk,
  highlightEnabled, highlightColor, animation (fade|pop|bump|slam|glow|neon|comic|word_box),
  unsungColor, boxEnabled, boxColor, marginVPx, boxWidthFrac, delayMs`.
- **Hook "kit"** `[LC-bin 14199]`: `accentColor, padEm, lineHeight, tiltDeg, fillTop,
  fillBottom, innerStrokeColor/Em, outerStrokeColor/Em, shadowOpacity, shadowBlurEm,
  shadowOffsetYEm, labelFill, labelTextColor, labelStrokeColor/Em, labelScale, labelPadX/YEm,
  labelGapEm, labelTiltDeg, labelRoughness, accentWidthEm, accentGapEm`. The labels drive the
  "Sticker" hook's category label. `introHoldSec` and `hook_start|intro_hold` exist
  `[LC-bin 14187, 15993]`.
- **Render job** `[LC-bin 14175, 14192-14194]`:
  - `segments` (jump cuts);
  - `textOverlays` (4 fields);
  - `mediaOverlays` (12 fields: `startSec, endSec, sourceStartSec, sourceEndSec, widthFrac,
    naturalWidth, naturalHeight, opacity, …`);
  - `hookText, hookLabels, captionsPath, previewVideoPath, subtitleStyle, hookStyle,
    musicPath, musicVolume, clipVolume, watermarkPath, watermarkPosition, videoLayout,
    addHook/addCaptions/addWatermark`.
- **Stages**: `Download → Reframe → Intro → Hook → Caption → Watermark → Master`
  `[LC-bin 16140]`. Error codes: `cut_failed, reframe_failed, caption_failed,
  watermark_failed, intro_hook_failed, write_master_failed, no_encoder_available, disk_full`
  `[LC-bin 15401]`.
- **Editor assets**: `editor_clip_filmstrip (intervalSec, cellWidth, cellHeight)`,
  `editor_clip_peaks (peaksPerSec)`, `ensure_editor_clip`, and an "editor clean master" that
  is invalidated on edit `[LC-bin 14178-14179, 15728]`.
- **Smart crop**:
  - `crop-trajectory.json` with `Keyframe`, `TrajectorySegment`, `CropRect`, `StackedLayout`,
    fields `cx, cy, w, seatId, schemaVersion, sourceWidth, sourceHeight, analysisFps,
    keyframes, stacked` `[LC-bin 14199, 15476-15490]`;
  - a **refusal to render a centre crop when no face is found** `[LC-bin 14808, LC-rel
    v1.10.4]`.
- **ASS techniques used**:
  - per-word Dialogue layers with alpha masking: `{\alpha&HFF&…}`, `\1a&HFF&`,
    `\3a&H00&`;
  - pop: `\fscx70\fscy70\t(0,90,1.4,\fscx108\fscy108)\t(90,170,\fscx100\fscy100)`;
  - glow: `{\blur6\t(0,160,\blur0)}`;
  - fade: `\fad(120,0)`;
  - a `WordBox` style with BorderStyle 3;
  - a `Karaoke` style with SecondaryColour `&H000000FF`

  `[LC-bin 15766-15810]`.
- **Fonts bundled** `[LC-bin resources/fonts]`:
  - Poppins-Bold, Inter-Bold, Lato-Bold, LilitaOne-Regular, each shipped with its OFL file;
  - `theboldfont.ttf`, which is **"THE BOLD FONT (FREE VERSION)", © 2015 Sven Pels, "All
    rights reserved", with uppercase-only glyphs** (the cmap has no a–z) and no licence file.
    Potongin should not ship it (§7.4).

---

## 2. Evidence details

### 2.1 LokaClip editor timeline (what "parity" means)

| Version (2026) | Editor capability `[LC-rel]` |
|---|---|
| v1.7.0 (07-08) | First editor; style templates |
| v1.9.2 (08-05) | Title backdrops Gradient, Note, Marker, Bar; karaoke sweep with preview parity |
| v1.9.3 (08-06) | Layout picker with animated previews (Fill, Smart Speaker, Fit Black, Fit Blur) |
| v1.9.5 (08-09) | Split-screen overlap fix; split screen **capped at 5 s** |
| v1.9.6 (08-14) | Hook text editable, with character counter and overflow warning (empty removes it); clip volume/mute with waveform; **preview identical to render**; styles persist; smart-crop cache |
| v1.9.8 (08-19) | Undo Ctrl/Cmd+Z; redo Ctrl/Cmd+Shift+Z or Ctrl+Y |
| v1.10.0 (08-21) | Jump cut at playhead (gap closes, subtitles shift); subtitles editable on the timeline (move, extend, cut, delete); hook movable, not locked at 0 s; free text; left panel tabs Media / Audio / Teks / Subtitle; filmstrip thumbnails; autosave |
| v1.10.2 (08-26) | Templates (genre, layout, hook, subtitle style, count and duration); built-ins Umum, Podcast, Gaming, Edukasi |
| v1.10.4 (09-04) | Image overlay, drag to move and resize; layout badges on clip cards (AI Track, Fill, Letterbox, Blur) |
| v2.0.0 (09-10) | Video overlay from the timeline |
| v2.0.5 (09-18) | Hook designs Punchline and Sticker (category label); **Intro Hold**; preview/render text parity |
| v2.1.0 (09-22) | Subtitle animations Slam, Glow, Neon, Comic, Box Pop; Comic hook; preview tiles for styles; auto-fit so text never leaves the frame |

The Indonesian competitors show the same direction:
- **KlipAja** has "Geser Momen" (shift clip bounds), title duration (default, full clip or
  custom), subtitle styles "Casual" and "Pill", watermark layering, music with position,
  **"Subtitle melewati kata pengisi seperti eh dan hmm"** (captions skip fillers), and
  dual-speaker, podcast, solo and gameplay layouts `[WEB klipaja.id/changelog]`.
- **KlipDong** has subtitle templates "dari per-kata sampai karaoke", a "Title Hook" (write
  your own or follow the AI), layouts (Auto, Center, Fit Penuh + Blur/Black, Crop 1:1 +
  Blur/Black, Split Screen, Gaming), and a text or image watermark `[WEB klipdong.id]`.

### 2.2 Western editors: patterns worth copying

- **Descript**:
  - "Delete" removes words from the media, but the media stays recoverable, and "Ignore"
    strikes the text through while keeping it visible;
  - a wordbar retimes word start and end for caption sync;
  - "Shorten word gaps" is either "more than" or "between" a threshold, shortened to a target
    such as 200 ms, with Shorten and Shorten all;
  - "Smooth jump cuts" heals the video at cuts `[WEB]`.
- **CapCut desktop**:
  - Transcript-based editing (from the Layout menu), with pause, filler and repeat detection;
  - "Identify filler words" and "Auto highlight keywords" in Auto captions;
  - word-by-word captions as "moving word highlight or one-word pop-ups";
  - keyframes and graphs, transitions, effects, filters, Auto reframe, noise removal, voice
    enhancer, text-to-speech;
  - shortcuts: Ctrl+B split, J/K/L, ←/→ frame step, Ctrl+Shift+D delete and close gap, Alt+K
    add keyframe, Ctrl+L link/unlink, Ctrl+Shift+E export `[WEB]`.
- **OpusClip**:
  - Fill, Fit (4:3 with padding), Split, Three layouts, plus manual reframe by double-click;
  - B-roll layouts PiP and split;
  - an **edit log explaining what changed and why**;
  - filler and pause removal `[WEB]`.
- **Kapwing Smart Cut**:
  - a "Silence Sensitivity" slider;
  - detected silences shown red (selected) or grey (kept), each with left/right handles;
  - reset `[WEB]`.
- **Hormozi-style specs** (widely copied), from two sources that disagree:
  - Ascynd: Montserrat Black or Anton, ALL CAPS, 80–120 px on 1080×1920, 8–12 px black
    stroke, highlight #FFD93D or #FFEE33 (alt #39FF14), 1–3 words per beat, 60–70 % from top,
    ≤105 % snap scale;
  - Submagic: newer Hormozi uses Anton with a yellow stroke and a small shadow, pop-in from
    the bottom, 4–6 words over 2 lines `[WEB]`.

### 2.3 Field sample of Indonesian podcast clips `[FIELD]`

Method:
- `yt-dlp` listed `youtube.com/hashtag/podcastindonesia/shorts`, and the 21 Shorts with at
  least 88 k views were downloaded (video only, 720×1280);
- frames were sampled at 8 %, 45 % and 80 % of each clip;
- caption bands were measured by pixel scan.

Artifacts: `_bench/shorts/sheet{0,1,2}.png`, `_bench/shorts/caps{1,2}.png`. The clipper
channels include AJ Recap / AJ Recap 99, QuickClips id, DuniaWTF, Unlocked Media and Seputar
Viral Hari Ini.

| Observation | Where seen | Measured (fraction of frame height H) |
|---|---|---|
| Yellow ALL-CAPS captions with one **red keyword**, condensed heavy sans, thin black stroke plus soft dark glow, 2 lines of 2–3 words | QuickClips (`ToSyYoKLIbE`, 395 k) | block top 61.3 % H; cap height 1.9 % (line 1) and 2.6 % (line 2) |
| White ALL-CAPS, one line of ≤6 words, **active word on a solid black box** | Unlocked Media (`VBLpMsbBCuk` 382 k, `CyCMOZE7QHo` 1.0 M) | 68 % H; cap 1.7 % |
| White ALL-CAPS with black stroke, **active phrase on a yellow highlighter box** | DuniaWTF (`UD2YN2DKdnM`, 1.2 M) | 70 % H; cap 1.8 % |
| **One word at a time**, white heavy caps, thick black stroke, placed on the speaker in the upper pane of a fit-blur layout | Seputar Viral (`tFjbbcxRaAs`, 101 k) | 27.7 % H; cap 2.5 % |
| Lowercase or sentence-case "typewriter"/serif white text with soft shadow, no stroke | AJ Recap, AJ Recap 99 (`GQYqrchyV64` 938 k, `c22KGylD68k`) | about 70–75 % H |
| **Quote-card hook**: white rectangle, black text (Title Case line plus ALL-CAPS bold line), green quote badge, three dots; persistent | `7CHlNdYnWzo` (92 k) | card about 47–59 % H, about 3.5 % side margins |
| **Top banner hook**: full-width blue or orange band, white ALL-CAPS 2 lines | `JKYvkDMJizo` 88 k, `jCxC_9lpFkE`, `zkiXun-Iycg` 781 k | top 20–30 % H |
| **Red sticker label** with emoji ("Pantek Bener", "Awok Awok 😬", "Wadidaw Bjiir") | `HuQJ4Mw4Dpo` 2.4 M, `TWNKTP2kZpM`, `_1uEEbKMLVA` | top-left, about 3–8 % H |
| **Branded frame**: 16:9 source in the middle, black header with ALL-CAPS title, channel logo, "Source YT : @…" | AJ Recap (`SDKDA5s1szA` 1.1 M, `2SuXT-cBRHM`) | header 3–8 % H |
| **Thumbnail cover first frame**: giant condensed caps title, yellow emphasis words, tilted yellow sticker ("JAWABANNYA MENOHOK!"), 👀 emoji; switches to the clip after about 1 s | QuickClips (`ToSyYoKLIbE`, `ni3_r_SW9zY` 649 k) | full frame |
| **Stacked split screen** (two panes) | AJ Recap 99, `g7h7m0l8aII` 340 k | 2 × about 50 % H |
| **Fit-blur** background with title band | Seputar Viral | n/a |
| **Source credit** "Source YT : <channel>" / "Source : Curhatbang" | 12 of 21 clips | about 2 % cap, 88–92 % H or top |
| **Comment-screenshot overlays** (reply-to-comment look) | `JKYvkDMJizo`, `jCxC_9lpFkE`, `zkiXun-Iycg` | mid frame |
| Emoji inside hooks and captions (😬 🫢 😁 👀 😭) | 7 of 21 | n/a |

Takeaways:
1. Captions are **smaller** (cap 1.7–2.6 % H, about 33–50 px at 1920) and **lower**
   (61–70 % H) than the US Hormozi spec (80–120 px font). Every pack must expose size and
   position.
2. **Box highlights** (black or yellow) are as common as colour-swap highlights.
3. A **persistent hook or title** (card, banner or header) is at least as common as a
   4-second hook.
4. **Source credit and emoji are table stakes.**

### 2.4 Render measurements `[BENCH]`

| Test | Result |
|---|---|
| 20 s 1080p source to 1080×1920: centre crop only | 3.40 s (5.9× realtime) locally |
| + animated per-word ASS (pop plus hook) | 3.88 s locally; **6.57 s in the production image** |
| fit-blur + ASS | 5.82 s locally |
| fit-blur background only: V2 `gblur sigma=35` at 1080×1920 vs LokaClip 270×480 `boxblur` + upscale | 7.72 s vs **4.46 s** |
| Stage-2 graph (3 segments, zoompan punch-in, xfade 0.25 s, PNG overlay 5–8 s, ASS, `sidechaincompress` ducking, `loudnorm` −14) | 5.91 s locally, **9.44 s in production** for 17.8 s output; loudness measured −14.0 LUFS |
| Proxy 540×960 ultrafast with ASS | 1.7 s for 20 s |
| One exact 1080×1920 frame with ASS at t=12 s | 0.43 s |
| Peaks at 100/s (8 kHz mono decode) for 20 s | 0.08 s |
| Filmstrip at 1 fps, 90×160 sprite, 20 s | 0.53 s, 33 KB |
| Inline pop `\t(\fscx…)` in a 3-word line | neighbouring words shifted up to **56 px** (first-word x 203 → 259 at 1080 w) |
| Emoji via libass (Noto Color Emoji requested) | local: monochrome fallback glyphs; production image: **tofu boxes** |
| Time-varying `crop` w/h | fails: `Error reinitializing filters` |
| `xfade` after `concat` without `settb` | fails: `timebase 1/1000000 do not match 1/30` |
| `acrossfade d=0.03` + `d=0.25` | output shortened by the fade durations; A/V end mismatch 33 ms |

---

## 3. Global quality gates (apply to every feature)

"Jangan menurunkan kualitas" means a feature ships only when all of its own acceptance
criteria and these gates pass.

| Gate | Criterion | How it is measured |
|---|---|---|
| G-PARITY | Preview frame vs server frame: caption/overlay band SSIM ≥ 0.985 and 99th-percentile per-pixel ΔE2000 ≤ 3; glyph bounding boxes within ±2 px at 1080 w | golden suite: for each style pack × 3 texts × 5 timestamps, JASSUB canvas capture (Playwright 1.62) vs `ffmpeg -frames:v 1` PNG |
| G-SYNC | A/V offset ≤ 1 frame (33 ms) at the end of a clip with 20 jump cuts; caption word onset within ±1 frame of `word.start` | render → `ffprobe` stream durations; burn a test tone at known word times and detect onset |
| G-AUDIO | Integrated −14 ±1 LUFS, true peak ≤ −1.0 dBTP, no click at cuts (sample step at a cut < −40 dBFS after 5–10 ms fades) | `ebur128=peak=true`; scan for sample discontinuities at cut times |
| G-SAFE | No text or sticker outside the platform safe area unless the user overrides it (TikTok: top 130–140 px, bottom 324–484 px, right 140 px at 1080×1920 `[WEB]`); auto-fit shrinks text to fit | geometry validator on the edit document plus a golden-frame bounding-box test |
| G-DET | Same edit document + same assets → bit-identical ASS and filter graph; render video hash stable per ffmpeg build | unit tests on generator output |
| G-PERF | Open the editor for a 60 s clip in < 2 s after the first analysis; scrub commits ≤ 10 Hz (`TIMELINE_SCRUB_INTERVAL_MS=100` exists `[REPO editor-timeline.mjs]`); UI input latency < 50 ms; final render ≤ 1.0× realtime in the production image for a stage-1 graph | Playwright trace; render timer |
| G-UNDO | Every mutation is undoable (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl+Y); autosave ≤ 2 s after an edit; reload restores the exact state | property test: random op sequence → undo all → deep-equal the initial document |
| G-FAIL | No silent fallback: a render that cannot honour a setting (missing face track, font, emoji asset) fails with an Indonesian message naming the cause (LokaClip v1.9.3 / v1.10.4 practice; Potongin V2 already raises `UnsupportedRenderMode`) | negative tests |
| G-I18N | UI strings in Bahasa Indonesia, captions keep NFC text, and Indonesian casing rules apply (`upper()` on "ı/İ" is not relevant to ID; keep numerals, "%" and "Rp" intact) | unit tests |

Versions to pin for G-PARITY:
- **Server**: ffmpeg 5.1.9 / libass 0.17.1 today (production image).
- **Browser**: JASSUB 2.5.16 with libass 0.17.4.

Either make the two libass versions equal (one option is a trixie-based image, which the docs
list as libass 0.17.3; verify before choosing), or accept the skew only while the golden suite
passes. Treat this as a Stage-1 blocker.

---

## 4. Data inventory the editor consumes

| Data | Source | Status |
|---|---|---|
| Word timestamps `{start,end,text,probability}` | `transcribe.py` / `transcript_io.py` (`TranscriptWord`) | exists `[REPO]` |
| Sentence units (hook, payoff anchors) | `sentences.py` `SentenceUnit` | exists |
| Sound events `{time, kind, label}` (`[tertawa]`, `[tepuk tangan]`, `[musik]`) | `sound_events.py` | exists; point events only, so duration must be added (see M3) |
| Audio timeline: `rms_db` at 0.1 s, `loudness_z`, `silences` ≥0.25 s, `scene_cuts` | `audio_timeline.py` → `analysis/audio-timeline.json` | exists |
| Selected clip: `start, end, cold_open, hook_text, title, description, hashtags, scores, hook_unit_id` | `selection_types.py` / `llm_selection.py` | exists |
| Waveform peaks: int8 min/max pairs at 100/s for clip ± 30 s context | new: ffmpeg decode to 8 kHz mono (0.08 s per 20 s) | new |
| Filmstrip: 1 fps sprite, 90×160 JPEG (and 4 fps at deep zoom) | new: ffmpeg `fps,scale,tile` (0.53 s per 20 s) | new |
| Face and speaker track: per 0.2 s `faces[{x,y,w,h,score,track_id}]`, `active_track_id`, `vad` | new: extend `face_tracking.py` (OpenCV YuNet ONNX, MIT) + VAD (Silero, MIT) + mouth-motion ASD | new (LokaClip parity) |
| Camera plan: segments `{t0,t1,mode: single\|twoshot\|wide, keyframes[{t,cx,cy,w}], seat_ids}` | new, derived from the face track | new |
| Style packs (JSON, versioned) + fonts (TTF with OFL files) | new: `resources/style-packs/*.json`, `resources/fonts/` | new |
| Asset library: images, video, audio, stickers, emoji PNG; sha256-addressed (V2 already uses `assets/<sha256>.(png\|jpg\|jpeg\|webp)`) | existing pattern `[REPO edit_manifest.py _ASSET]`; extend to mp4/m4a/webm | extend |
| Music library metadata `{title, artist, license, url, bpm, lufs, duration}` | new, curated | new |
| Edit document | today `clip-edit-v1.0` (timeline, visual 720×1280, caption_style, captions, ≤2 overlays, audio gain) | must become a track-based v2 (R-architecture task) |

---

## 5. MUST: Stage 1, LokaClip parity for clip polishing

Format per feature: **Value** (for Indonesian clippers) · **UX** · **Data** · **Render** ·
**Accept** (acceptance criteria).

### M1. Word-snapped trim and range adjust ("Geser momen")
- **Value.** The #1 complaint about AI clips is a start or end that cuts mid-word or
  mid-laugh. Clippers must fix it in seconds, not re-export from CapCut.
- **UX.**
  - In/out handles on the clip bar snap to the nearest word boundary. Alt-drag disables snap.
  - Snap priority: word end/start, then silence midpoint, then scene cut.
  - `I`/`O` set in/out at the playhead.
  - `,`/`.` nudge by one word; Shift+`,`/`.` nudge by one frame.
  - The handle tooltip shows the first or last word ("…gitu loh |").
  - A grey pre-roll or post-roll of ±30 s context is visible and draggable.
  - "Perpanjang sampai tawa selesai": a button that extends to the end of the next laughter
    event.
- **Data.** Words, silences, scene cuts, sound events, and a source-duration bound.
- **Render.** Changes `timeline.start/end` only. The render must re-derive caption cues
  (words whose midpoint is inside the range, as V3 already does `[REPO plan §render]`).
- **Accept.**
  - A snapped in/out lands on `word.start − pad` or `word.end + pad` with pad 40–80 ms
    (configurable) and never inside a word unless Alt was used.
  - There is no clipped phoneme on 20 hand-labelled gold boundaries (listening test).
  - Handle drag is 60 fps and re-seeks at ≤ 10 Hz.
  - Min length 3 s; max as configured (default 180 s).

### M2. Cold-open control (hook line first) + intro hold
- **Value.** The strongest pattern for podcast clips is to play the punchline or question
  first. V3 already selects `cold_open`. LokaClip only has a freeze-frame "Intro Hold",
  so this is where Potongin can beat it.
- **UX.**
  - A dedicated "Cold open" lane before 0:00. The AI suggestion is pre-filled.
  - Drag to re-pick from the transcript (select words → "Jadikan cold open").
  - Word-snapped handles (M1 rules).
  - Transition chooser into the main body: hard cut, 3-frame dip-to-white flash, whoosh SFX,
    or "rewind" effect (stage 2).
  - Toggle "Tahan intro" (intro hold 0.3–2.0 s: freeze the first frame so the hook text is
    readable).
  - Rule: when a cold open exists, the hook text defaults to spanning the cold open.
- **Data.** `SelectedClip.cold_open (start,end)` and the words inside it. Constraints from V3:
  0.5–8.0 s, `|cold_open.start − start| ≥ 0.01`, within the source duration `[REPO plan]`.
- **Render.**
  - Concat `[cold_open][main]` with the chosen join, and caption cues offset by the cold-open
    length (V3 does this already).
  - Intro hold is `tpad=start_duration=X:start_mode=clone` plus `adelay` on audio (LokaClip's
    exact method `[LC-bin 15838-15840]`) or silence.
- **Accept.**
  - SRT and burned captions are identical, including the offset.
  - No duplicated audio at the join; the flash is ≤ 3 frames.
  - The cold open never exceeds 8 s.
  - The UI prevents a cold open that overlaps the main range end-to-end by more than 80 %
    (it would be a duplicate). Warn at 50 %.

### M3. Waveform, laughter and sound-event markers, silence shading
- **Value.** Indonesian podcast clips live on "ngakak" moments. Seeing laughter and pauses
  lets the clipper end on the laugh, cut dead air, and place SFX.
- **UX.**
  - Waveform under the video track (peaks min/max, 100/s).
  - Coloured markers:
    - 😂 `tertawa` in orange;
    - 👏 `tepuk tangan`;
    - 🎵 `musik`;
    - silences as hatched grey spans with their duration label (e.g., "1,2 dtk");
    - scene cuts as thin white ticks.
  - Hovering a marker previews ±1 s. Clicking seeks.
  - Filter chips: "Tawa / Jeda / Potongan kamera".
  - Keyboard: `Shift+→`/`Shift+←` jump to the next or previous marker.
- **Data.**
  - Sound events: the current model is a point `time`. Add `end` or `duration` (laughter
    spans 0.5–4 s), derived from the audio-timeline RMS envelope after the event (energy stays
    above −30 dBFS) or from a classifier.
  - Peaks; `silences`; `scene_cuts`.
- **Render.** None (analysis only). Peaks JSON is ≤ 25 KB per minute (int8 × 2 × 100/s × 60
  = 12 KB, plus headers).
- **Accept.**
  - The waveform is drawn in < 100 ms for a 3-minute window.
  - Marker times are within ±50 ms of the transcript tag time.
  - Silence spans match `audio_timeline.silences`.
  - Laughter-span precision is ≥ 0.8 on 30 labelled events (gate before showing spans; until
    then show points).

### M4. Transcript-based editing and jump cuts (text = timeline)
- **Value.** It is faster than scrubbing and is how Descript, CapCut and OpusClip work. It
  lets clippers tighten a 70 s clip to 45 s by deleting rambling sentences. LokaClip only has
  cut-at-playhead.
- **UX.**
  - A transcript panel synced to the playhead, with the karaoke-highlighted current word.
  - Select words and press Delete/Backspace to cut them. Cut words show as collapsed
    `⋯ 2,4 dtk` chips that can be restored (Descript "delete but recoverable").
  - `Ctrl+Shift+X` = "Abaikan" (ignore: strike through, keep the media).
  - Detected fillers are underlined, and the "Hapus jeda & kata pengisi" dialog has these
    controls:
    - silence threshold slider (Kapwing-style sensitivity);
    - "shorten gaps longer than X ms to Y ms" (Descript-style, defaults X=600, Y=200);
    - per-item toggle list with preview.
  - Timeline equivalents: `Ctrl+B` split at the playhead, `Delete` removes the segment and
    closes the gap (ripple), `Q`/`W` trim the left or right of the playhead (CapCut habit).
  - The Indonesian filler lexicon defaults to pure disfluencies only: `eh, em, emm, ehm, hmm,
    mm, uh, ah (isolated), anu (isolated)`, immediate word repeats ("aku aku"), and false
    starts.
  - Discourse particles (`sih, dong, kok, lho, deh, kan, ya, nih, tuh, gitu, kayak`) are
    **never auto-removed**. They carry meaning and humour.
  - Two separate toggles:
    - "Sembunyikan di subtitle" (KlipAja-style, captions only);
    - "Potong dari audio".
- **Data.**
  - Words with probabilities.
  - The segments list (source ranges kept), stored as an ordered list of
    `{src_start, src_end}` in the edit document.
  - The filler lexicon (versioned JSON).
  - Silences.
- **Render.**
  - Each kept range is `trim/atrim` + `setpts/asetpts`, then `concat`.
  - Audio gets **5–10 ms `afade` out/in at every cut with no overlap**. Measured: `acrossfade`
    shortens output by d per cut, which is drift.
  - Optional stage-2 "smooth cut" (short zoom punch-in on alternate cuts to hide the jump; a
    common CapCut technique).
  - Captions are re-timed through a source→output time map, so words inside removed ranges
    disappear.
- **Accept.**
  - G-SYNC with 20 cuts.
  - No audible click (G-AUDIO).
  - Undoing a cut restores bit-identical output.
  - The source→output time map is monotonic.
  - No cut shorter than 2 frames remains (merge it).
  - Particles in the protected list are never selected by the auto-remove.
  - Filler precision ≥ 0.9 on 200 labelled Indonesian filler tokens before "Hapus semua" is
    enabled.

### M5. Caption editing (words, lines, timing, emphasis, emoji)
- **Value.** Whisper mishears names and slang ("gue", "anjir", "bjir", brand names). Clippers
  fix these before posting.
- **UX.**
  - Click a caption on the canvas or the timeline to edit its text inline.
  - Editing a word keeps its timing. Typing extra words splits the time proportionally by
    character count.
  - Retime: drag word edges in a wordbar (Descript pattern).
  - Split or merge cues: `Enter` / `Backspace` at the cue boundary.
  - Force a line break with `Shift+Enter`.
  - Emphasis: select a word and press `Ctrl+E` to mark it as a keyword (keyword colour or box).
    There is also "AI tandai kata kunci", an LLM pass that picks 1 keyword per cue, reviewable.
  - Emoji picker inserts an emoji token after a word.
  - Find & replace across all clips of the project ("anjir" → "anjay"), with an "apply to all
    clips" checkbox.
  - Auto casing: none / ALL CAPS / Sentence.
  - A custom-dictionary suggestion list learns from past corrections (per workspace).
- **Data.**
  - Words with `display_text` (edited) separate from `asr_text`. Keep `original_text_sha256`
    as V2 does.
  - Per-word flags `{emphasis, hidden, emoji_after}`.
  - Cue boundaries as explicit word indices.
- **Render.** The ASS generator reads display text. Emphasis maps to style (colour, box or
  scale). Emoji go to the overlay compositor (M10), not libass.
- **Accept.**
  - Editing text never shifts other words' timing.
  - Every cue has 1–`maxWords` words and ≤ `maxLines` lines after auto-wrap. Overflow triggers
    shrink-to-fit down to 85 % of the pack size, then a warning.
  - Find & replace is undoable as one step.
  - Casing does not alter the underlying display text (it is a style property).

### M6. Caption style packs and custom style editor
- **Value.** The look is the brand. Indonesian clippers copy specific channel styles
  (§2.3). One click must give a pixel-accurate TikTok-grade look.
- **UX.**
  - A gallery of preview tiles, animated on hover (LokaClip v2.1.0).
  - The live preview uses the current clip's words.
  - The "Kustom" drawer exposes:
    - font (from bundled OFL list), weight, size (as % H), case;
    - text colour, stroke colour and width, shadow (blur, offset, opacity);
    - highlight mode (colour / box / scale / underline), highlight colour, box colour, radius
      and padding;
    - reveal mode, words per chunk (1–6), lines (1–3), position (Atas / Tengah / Sepertiga
      bawah / Bawah / custom drag), wrap width %;
    - animation.
  - "Simpan sebagai gaya saya" writes a user style pack (JSON), exportable and importable.
    This matches LokaClip's `list_user_style_packs`, with the "File style pack bukan JSON yang
    valid" validation `[LC-bin 13992, 14602]`.
- **Data.** A `StylePack` JSON schema (field list in §7.2), fonts under `resources/fonts` with
  licence files, and pack version plus hash stored in the edit document so old clips never
  change (LokaClip v2.0.6 lesson: "Gaya hook pada klip-klip lama tetap tersimpan rapi").
- **Render.**
  - Generate ASS with `fontsdir=` pointing at bundled fonts.
  - All sizes are expressed as fractions of H (the current code already does this
    `[REPO captions_ass.py]`).
  - Box highlight uses a separate Layer-0 event per active word with `BorderStyle 3` or an ASS
    vector rectangle `\p1` at the computed word bbox.
- **Accept.**
  - All 8 stage-1 packs pass G-PARITY.
  - At 1080×1920, the rendered cap height is within ±3 % of the pack spec.
  - Text never exceeds the safe area (G-SAFE).
  - Changing pack is undoable.
  - A saved pack reloads identically.
  - A pack references only bundled fonts; unknown fonts fail validation.

### M7. Caption animation engine (reveal modes and per-word animation)
- **Value.** Motion is what makes captions "TikTok-style". The engine must never jitter or
  drift.
- **UX.**
  - Reveal modes (LokaClip parity): `per_word` (one word on screen), `chunk_karaoke` (N words,
    active highlighted), `cumulative` (words appear as spoken, line builds), `segment_static`
    (whole cue at once), `karaoke_sweep` (colour sweeps within words, `\kf`).
  - Animations: `none, fade, pop, bump, slam, glow, box_pop` (stage 1); `neon, comic, shake,
    bounce-in` (stage 2).
  - Timing offset slider "Geser waktu subtitle" (−300 to +300 ms) for perceived sync.
- **Data.** Words (start/end) and pack animation parameters (durations in ms, scale keyframes,
  easing exponent).
- **Render.**
  - **Absolute per-word layout.** Measure each word's advance with the pack font. The server
    uses HarfBuzz via Python (`uharfbuzz`, Apache-2.0, or FreeType metrics); the browser uses
    the same TTF through JASSUB, and editor hit-testing uses `harfbuzzjs` 1.6.2 (MIT).
  - Emit one Dialogue per word with `\an5\pos(x,y)`, so a scaled active word does not reflow
    neighbours. Measured problem: inline pop moved neighbours by 56 px.
  - Pop default: `\fscx70\fscy70 → \t(0,90,1.4,\fscx108\fscy108) → \t(90,170,\fscx100\fscy100)`
    (the LokaClip curve).
  - Glow: `\blur6\t(0,160,\blur0)`.
  - Fade: `\fad(120,0)`.
- **Accept.**
  - Non-active words move ≤ 1 px between any two frames of a cue (frame-diff test on the
    golden suite).
  - Active-word onset is within ±1 frame of `word.start + offset`.
  - No cue overlaps the next one (the next cue starts ≥ 1 frame after the previous one ends,
    or they replace each other in the same frame).
  - The per-word event count for a 90 s clip is < 3,000 (libass perf).
  - Render overhead for animated captions is ≤ 15 % over plain captions. Measured: +14 %
    (3.40 → 3.88 s).

### M8. Hook text editing, hook designs, and AI hook suggestions
- **Value.** The first 1–3 s decide the scroll. The field sample shows persistent hook cards
  and banners as the norm. LokaClip has 7 designs, a char counter, and a movable and
  resizable hook.
- **UX.**
  - Hook text box with a character counter (V3 limit 90) and live overflow warning
    ("teks akan terpotong").
  - Emptying the text removes the hook.
  - **"Saran AI" button**: 5 variants from the LLM (question, bold claim, curiosity gap,
    number, quote from the clip), each ≤ 60 chars by default, marked with the archetype, and
    grounded in the clip transcript. Click to apply; regenerate with one click.
  - Tone chips: "Santai / Serius / Lucu / Clickbait halus".
  - Hook lane on the timeline, movable and resizable (default 0–4 s; "Sepanjang klip" option
    as in KlipAja).
  - Design gallery: Bar, Marker, Note, Gradient, Sticker label, Punchline, Comic (LokaClip
    set), Quote card and Top banner (field sample); details in §7.3.
  - Emphasis words: select a word, then `Ctrl+E`.
  - Emoji allowed.
- **Data.**
  - `hook_text`, `hook_start/end`, `hook_design_id` + version, per-design params (§7.3),
    `labels[]` for sticker categories (e.g., "FAKTA", "LUCU", "REAL"), and the emphasis
    indices.
  - LLM context: the clip's sentence units, title and existing hook.
  - Prompt templates in `src/ai_clipper/prompts/`.
- **Render.**
  - An ASS layer with vector backdrops (`\p1` drawing for marker swipe, note card and sticker
    pill with `\frz` tilt), or a pre-rendered PNG card when the design needs gradients or
    rough edges. libass has no gradient fill, so the "Gradient" backdrop is a PNG or a
    `geq`/`gradients` source filter.
  - Auto-fit: shrink until it fits the safe width, with ≤ 3 lines (V3 has
    `_HOOK_FONT_RATIOS`).
  - The measured failure mode (tilted, unwrapped hook overflowing the frame) must be caught by
    G-SAFE.
- **Accept.**
  - AI variants: 100 % ≤ limit, 0 % containing names or claims absent from the transcript
    (LLM-judge + regex check), latency ≤ 8 s p95 or a fallback to heuristic hooks
    (`hook_heuristics.py`).
  - Every design passes G-PARITY and G-SAFE for 10, 40 and 90-char texts, with and without
    emoji.
  - Tilted designs keep all corners inside the frame.

### M9. Free text overlays
- **Value.** Clippers add "POV:", speaker names, "Part 2", context lines, and CTA ("Follow
  untuk part 2").
- **UX.**
  - "T" button or `Ctrl+T` adds text at the playhead for 3 s.
  - Direct manipulation on canvas: drag, corner-scale, rotate handle; snapping guides to the
    centre and safe-area edges; `Shift` keeps the aspect ratio; arrow keys nudge 1 px
    (`Shift` for 10 px).
  - Style from text presets (TikTok classic box, outline, shadow, label pill) or the hook
    designs.
  - Time range on its own text lane.
- **Data.** `{id, text, style_ref, x, y (fraction of W/H, anchor centre), rotation, scale,
  start, end, z}`.
- **Render.** ASS event with `\an5\pos\frz\fscx\fscy`, or a PNG when styled beyond ASS
  (emoji, gradient).
- **Accept.**
  - Canvas position equals rendered position ±2 px.
  - Rotation parity is ±0.5°.
  - ≥ 20 overlays per clip render without failure. V2 caps overlays at 2 `[REPO
    MAX_OVERLAYS]`, so the cap must be lifted.

### M10. Stickers, emoji, logo/watermark, source credit
- **Value.** Emoji labels, the channel logo and "Source YT : …" credits appear in 12 of 21
  top clips `[FIELD]`. Many clipping programs require the credit.
- **UX.**
  - Sticker panel: emoji (search in Indonesian and English), label pills (preset text: "LUCU",
    "FAKTA", "PLOT TWIST", "Awok Awok"), arrows and circles.
  - Uploaded PNG/WebP/GIF (static in stage 1).
  - Logo: position presets (4 corners, as LokaClip `top_left…bottom_right` `[LC-bin 14193]`),
    or free drag; opacity default 85 %; scale.
  - "Kredit sumber" toggle auto-fills `Source YT : {channel}` from the source metadata
    (yt-dlp `channel`), editable, placed bottom-centre above the safe area by default.
  - Workspace brand kit remembers the logo and credit format.
- **Data.** Asset refs (sha256), emoji codepoint → PNG path, `{x, y, scale, rotation,
  opacity, start, end}`, source metadata `{channel, url}`.
- **Render.**
  - **Emoji must be PNG overlays.** libass drew tofu in production.
  - Bundle Noto Emoji PNGs (images Apache-2.0; font OFL-1.1) at 136 px and 512 px.
    Alternative: Twemoji graphics (CC-BY-4.0, attribution required).
  - Overlay with `overlay=…:enable='between(t,a,b)'`.
  - The logo is pre-scaled once, and alpha is applied with `colorchannelmixer=aa=` (LokaClip
    method `[LC-bin 15820]`).
- **Accept.**
  - Emoji render in colour in the production image. The test is a frame check that the emoji
    bbox has more than 3 distinct hues.
  - The credit auto-fill is correct for 100 % of YouTube sources that have `channel`.
  - Logo alpha parity is ±2 %.

### M11. Layouts: face-track, smart speaker, split screen, fit-blur/black, branded frame
- **Value.** Two-person podcasts are the majority. The wrong face on screen kills a clip.
  LokaClip's biggest investment is here (ASD, camera plan, trajectory, stacked).
- **UX.**
  - Layout picker with animated mini-previews (LokaClip v1.9.3) that show what gets cropped.
  - Per-segment layout on a "Layout" lane: split the lane at the playhead and set a layout
    per segment ("Auto" = camera plan).
  - Manual reframe: double-click the video (OpusClip pattern) to show a draggable 9:16 crop
    box over the 16:9 source. Dragging creates a keyframe at the playhead; interpolation is
    eased.
  - Speaker chips "Pembicara A / B": click to force the camera to that person for the
    selection.
  - Split screen: choose which seat goes top and bottom; the divider can be styled (none,
    2 px white line, shadow).
  - Branded frame: a template with header and footer areas (title bar, logo, credit) and the
    16:9 video in the middle (AJ Recap pattern).
- **Data.**
  - Face and speaker track, camera plan (§4).
  - Manual keyframes `{t, cx, cy, w}` in source-normalised units.
  - Layout segments `{t0, t1, mode, params}`.
  - Split-screen seats.
  - Frame template ref.
- **Render.**
  - Single: `crop@c` with fixed w/h and `sendcmd` x/y per keyframe (LokaClip), or
    expression-based x from a smoothed track (V3 already has `build_crop_expression`
    `[REPO face_tracking.py]`).
  - Stacked: `split` → 2 crops → `scale=1080:960` each → `vstack` (LokaClip filter
    `[LC-bin 15843-15847]`).
  - Fit-blur: downscale-blur-upscale (LokaClip: `270×480 boxblur=5:5`) is cheaper than
    `gblur sigma=35` at full size. Measured on a 20 s clip at 1080×1920: 4.46 s against
    7.72 s `[BENCH]`.
  - All segments are normalised (`fps=30,settb=1/30,setsar=1,format=yuv420p`) before concat
    or xfade.
- **Accept.**
  - Face-track: on 10 labelled 2-speaker clips, the active speaker's face centre is inside the
    crop in ≥ 97 % of speech frames.
  - No camera switch within 1.0 s of the previous one (hysteresis).
  - Pan velocity ≤ 6 % of frame width per 100 ms, with no whip (LokaClip v1.6.7: "4× lebih
    halus, tidak ada lagi whip pan").
  - A face-less segment either uses fit-blur (explicit user or plan choice) or fails loudly;
    it is never a silent centre crop (LokaClip v1.10.4 practice).
  - Split segments are ≥ 2 s. Default max 8 s, configurable (LokaClip caps at 5 s).
  - Manual keyframes play back in the preview exactly as rendered (crop rect equal ±1 px).

### M12. B-roll: image and video overlays (cut-away, PiP, split)
- **Value.** Clippers add a reaction meme, the product mentioned, or the photo of the person
  being discussed. LokaClip added image in v1.10.4 and video in v2.0.0.
- **UX.**
  - Drag media from the Media tab to an overlay track at the playhead.
  - Modes: Full-frame cut-away (replaces the video and keeps the audio), PiP (drag, resize,
    rounded corners, border), Split (top or bottom half, OpusClip "B-roll split").
  - Trim the source range of a video overlay (`sourceStartSec/sourceEndSec`, as LokaClip).
  - Fade in/out (0–500 ms).
  - Images get an optional Ken Burns (start and end rect).
  - A video overlay's own audio is muted by default, with a volume slider.
- **Data.** Asset ref, `{src_in, src_out, start, end, mode, rect (x, y, w, h), radius,
  border, opacity, fade_in, fade_out, kenburns?}`. Asset probe (w, h, fps, has_audio,
  duration).
- **Render.**
  - `setpts=PTS-STARTPTS+start/TB`, `fade=t=in:alpha=1`, `overlay=…:enable='between(t,a,b)':
    eof_action=pass` (LokaClip's pattern `[LC-bin 15833-15838]`).
  - Rounded corners via `geq` alpha mask or a pre-rendered mask PNG + `alphamerge`.
  - Ken Burns via `zoompan` on the still (fixed output size; measured requirement).
- **Accept.**
  - Overlay timing is ±1 frame.
  - A 60 s clip with 5 overlays renders within the G-PERF budget. Measured: 1 overlay adds
    under 5 % in the stage-2 graph.
  - VFR phone videos are normalised to 30 fps with no A/V drift over 10 s.
  - Unsupported codecs are rejected at upload with a clear message.

### M13. Background music with ducking, clip volume, SFX basics
- **Value.** Music raises the perceived production value. Beating LokaClip here is cheap:
  it has no ducking.
- **UX.**
  - Audio tab: music library with genre and mood chips, each track showing licence and BPM;
    upload your own (with a warning about Content ID).
  - Place the music on the A2 lane; trim and loop.
  - Volume slider in dB; "Ducking otomatis" toggle (default on) with an amount (6–15 dB,
    default 10), attack 30 ms, release 400 ms.
  - Fade in/out handles on the clip corners.
  - Clip audio volume/mute (LokaClip parity).
  - "Samakan loudness" (on by default) targets −14 LUFS.
  - Stage-1 SFX: a small pack (whoosh, pop, ding, boom), each with licence metadata.
- **Data.** Music asset + metadata (licence, source URL, attribution text), volume and duck
  params, fades, loop points, and the voice activity from VAD or the RMS timeline.
- **Render.**
  - `[music]volume,afade…[m]; [m][voice]sidechaincompress=threshold=0.03:ratio=8:attack=30:
    release=400[md]; [voice][md]amix=normalize=0, loudnorm=I=-14:TP=-1.5:LRA=11` (tested:
    −14.0 LUFS).
  - For exact preview parity, compute a **gain envelope** from the VAD timeline (a piecewise
    dB curve) and apply it as `volume=eval=frame` expressions or an `asendcmd` script.
    WebAudio can then reproduce the same envelope in the preview. `sidechaincompress` cannot
    be reproduced 1:1 in the browser.
- **Accept.**
  - During speech, music RMS is ≥ 8 dB below voice RMS.
  - Music recovers to its set level within 600 ms of speech end.
  - G-AUDIO holds.
  - Preview and render envelopes match within ±1 dB.
  - Every library track has licence metadata. Tracks without it are not listed.

### M14. Preview identical to final render
- **Value.** The owner's requirement, and LokaClip's claim. It is also what makes users trust
  one-click export.
- **UX.**
  - The preview is a canvas at the true 9:16 aspect ratio, with a toggleable safe-zone overlay
    (TikTok / Reels / Shorts presets).
  - "Render frame ini" produces an exact server frame (0.43 s measured) shown side by side
    for trust.
  - "Pratinjau cepat" is a 540×960 proxy render of the full clip (1.7 s per 20 s measured)
    when the user wants to watch the whole edit with a server-exact result.
- **Data.** The same edit document drives both paths. Fonts, emoji PNGs and style packs are
  served to the browser from the same files.
- **Render / engine choice.**
  - Browser: HTML5 video (proxy or original source) + WebGL/Canvas2D compositor (Konva 10.7
    MIT or a hand-written layer) for crop, layout and overlays, plus **JASSUB** for all ASS
    text.
  - Server: ffmpeg filter graph + libass.
  - The geometry for crop rects, overlay rects and word positions is computed **once**
    (server-side, JSON "render plan") and consumed by both paths.
  - Remotion (4.0.527) was rejected: its licence requires a company licence beyond small
    teams, and it is Chromium rendering, not the ffmpeg pipeline.
  - JASSUB licence note: the wrapper is MIT, but the WASM bundles LGPL/FTL components
    (package licence
    `LGPL-2.1-or-later AND (FTL OR GPL-2.0-or-later) AND MIT AND ISC …`). Ship it unmodified
    as a separate asset and include the notices.
- **Accept.** G-PARITY on the full golden suite (8 caption packs, 9 hook designs, 4 layouts,
  2 overlay modes). Parity regressions block merge.

### M15. Undo/redo, autosave, revisions, shortcuts
- **Value.** Confidence to experiment. LokaClip shipped it early (v1.9.8).
- **UX.** See the §8 shortcut map. There is a history panel ("Riwayat") with named
  checkpoints and "Kembali ke versi AI" (reset to the AI original). Autosave shows as
  "Tersimpan • 2 dtk lalu".
- **Data.** An operation log (command pattern) on top of revisioned documents. The V2
  manifest already has `revision` and `parent_revision_sha256` + etag conflict handling
  `[REPO edit_manifest.py]`.
- **Render.** None.
- **Accept.** G-UNDO: 200-step history, and a reload mid-edit loses ≤ 2 s of work. A conflict
  (two tabs) is surfaced, never silently overwritten.

### M16. Export and publishing package
- **Value.** A clip is done only when it is uploaded with a title, description and hashtags.
- **UX.**
  - Export dialog:
    - resolution 1080×1920 (default) or 720×1280;
    - fps 30 (default) or source (≤ 60);
    - quality (CRF 18/20/23);
    - the SRT sidecar is always available.
  - Batch export of selected clips.
  - The progress bar shows stages (Potong → Reframe → Intro/Hook → Subtitle → Overlay →
    Audio → Master), LokaClip-style.
  - Copy buttons for the title, description and hashtags generated by V3.
  - Cover frame picker: choose the frame YouTube and TikTok show as the thumbnail.
- **Data.** Render settings, V3 metadata, and cover time.
- **Render.**
  - H.264 High, yuv420p, `+faststart`, AAC-LC 48 kHz 192 kbps, BT.709 tags.
  - Idempotent master by document hash. LokaClip: "master.mp4 already exists; skipping render
    (R20.3 idempotency)" `[LC-bin 14454]`.
- **Accept.**
  - Output passes an ffprobe contract: 1080×1920, SAR 1, 30 fps CFR, AAC 48 kHz, duration
    equal to the edit duration ±1 frame.
  - G-AUDIO holds.
  - Re-exporting an unchanged document is instant (cache hit).
  - Failures give a named stage and an Indonesian message.

### M17. Templates / presets and batch apply
- **Value.** Clippers produce 10–30 clips per episode and want one look. LokaClip's
  templates (v1.10.2) save generate-time settings.
- **UX.**
  - "Simpan sebagai template" captures the caption pack, hook design, layout default, logo,
    credit, music defaults and export settings.
  - Built-ins: Podcast, Umum, Edukasi, Gaming.
  - Apply to all clips in a project, with a diff preview ("12 klip akan berubah").
  - A per-clip override stays marked.
- **Data.** Template JSON (refs to pack and design versions), project default template id.
- **Render.** None directly.
- **Accept.** Applying to N clips is one undoable operation. Clips with manual overrides keep
  them unless "timpa semua" (overwrite all) is chosen. Templates survive app upgrades
  (versioned refs).

---

## 6. SHOULD: Stage 2, CapCut multi-track core

| ID | Feature | Value | UX pattern | Data | Render | Acceptance |
|---|---|---|---|---|---|---|
| S1 | **Multi-track timeline**: V1 main (magnetic), V2..Vn overlays, T text/caption/hook lanes, A1 source, A2 music, A3 SFX; lock, hide, mute per track | CapCut muscle memory; complex edits | Drag between tracks; magnetic main track closes gaps; snapping to playhead, clip edges, words, markers (toggle `N`, proposed); zoom `Ctrl+=`/`Ctrl+-`, fit `Shift+Z` (CapCut) | Track-based document (tracks → items with `start, dur, src_in, src_out, z`) | Graph compiler: per-track chains → overlay stack in z order → audio mix | 50 items at 60 fps interaction; compiler produces an identical graph for identical docs (G-DET) |
| S2 | **Pro trim tools**: split `Ctrl+B`, trim-left `Q`, trim-right `W`, ripple delete `Ctrl+Shift+D` / `Delete`, roll and slip edits, duplicate `Ctrl+D` | Rough cut speed | CapCut shortcuts; Alt-drag = slip | same | same | Every op ripple-correct; captions follow via the time map |
| S3 | **Keyframes + easing** (position, scale, rotation, opacity, crop, volume) | Punch-ins, motion text, volume rides | `Alt+K` add keyframe (CapCut); diamond markers on the item; graph editor with presets (linear, ease-in/out, cubic-bezier) | `keyframes[{t, prop, value, ease}]` | Crop/zoom via `zoompan` or scale→fixed crop (**no time-varying crop size**, measured); overlays via `overlay x/y` expressions; volume via `volume=eval=frame` | Browser and server positions equal ±1 px at 10 random t; eased curves match to 1e-3 |
| S4 | **Transitions**: cut, fade/dissolve, dip to black/white, slide, zoom/whip, flash | Smooth segment joins, cold-open join | Drop a transition on a cut; duration handle 0.1–1.0 s | `transition{type, dur}` on a cut | `xfade` (needs `settb`, fps, SAR normalisation, measured); audio via symmetric afade, or `acrossfade` with **timeline compensation** | No A/V drift (G-SYNC); preview uses the same curve (WebGL shader per xfade type) |
| S5 | **Effects and filters**: auto punch-in zoom on emphasis, shake, flash, vignette, colour adjust (brightness, contrast, saturation, temperature), sharpen, LUT `.cube` | Energy and a consistent look | Effect lane items; intensity slider; LUT upload | Effect items with params | `eq`, `colortemperature`, `unsharp`, `lut3d`, `vignette`; zoom via zoompan | Parity: WebGL shader vs ffmpeg frame SSIM ≥ 0.98 per effect |
| S6 | **Speed**: constant 0.5–2×, freeze frame | Comedic timing | Right-click → Kecepatan; freeze `Shift+F` (proposed) | `speed` on an item | `setpts` + `atempo` chains (pitch-preserving); freeze via `tpad`/`loop` | Speech intelligible at 1.25×; A/V aligned |
| S7 | **SFX library** + "AI saran SFX" at hook and punchlines (whoosh on cold-open join, ding on keyword) | Retention cues used by Submagic and Captions.ai | Drag onto A3; AI suggestions shown as ghost items to accept | SFX assets with licence | Mixed pre-loudnorm, excluded from ducking sidechain | Every asset licensed; suggestions ≤ 1 per 5 s |
| S8 | **Text animations** in/out/loop + text templates (CapCut-like) | Motion text without keyframing | Animation tab: In, Out, Loop with a duration slider | Anim preset ids | ASS `\t`, `\move`, `\fad`, `\clip` | Parity per preset |
| S9 | **Audio clean-up**: denoise, voice EQ/enhance, de-ess, silence-level normalise | Bad podcast mics | Toggle + amount | Per-track audio FX | `arnndn` (RNNoise model, BSD-3) or `afftdn`; `equalizer`, `deesser` | No artefacts on a 10-clip listening panel; LUFS gate |
| S10 | **Masks and PiP shapes** (circle, rounded rect), borders, drop shadow | Facecam PiP, reaction bubble | Shape picker on an overlay | mask params | Pre-rendered alpha mask PNG + `alphamerge` | Mask edge parity ±1 px |
| S11 | **Group, copy/paste attributes** (style, position, animation) | Speed across many overlays | `Ctrl+G`, `Ctrl+Alt+C/V` (proposed) | Group ids | none | Undo as one op |
| S12 | **Markers and chapters** | Plan edits and share review notes | `M` add marker (mute is also `M` in CapCut; resolve conflict: marker `Shift+M`, proposed) | markers | none | none |
| S13 | **Multi-aspect export** (9:16, 1:1, 4:5, 16:9) from one doc | Reels, IG feed, X | Aspect switcher with per-aspect layout overrides and safe-area reflow | Per-aspect geometry | Graph per aspect | All text in the safe area for each aspect |
| S14 | **Cover card / thumbnail frame** (giant title, emphasis words, tilted sticker, emoji) as a 0.5–1.0 s first frame or a separate cover image | Seen in top QuickClips clips `[FIELD]`; the first frame is the thumbnail | Cover editor using hook designs at large scale; duration 0 (image only) or 0.3–1.0 s | cover doc | PNG render + prepend with `concat`, or a separate `cover.jpg` | The cover never delays the audio hook by > 1.0 s |
| S15 | **Comment reply card** (reply-to-comment look) | Seen in 3 of 21 top clips `[FIELD]` | Paste a comment text and handle → styled card | card params | PNG | Readable at 1080 w (cap ≥ 1.6 % H) |
| S16 | **Caption animation pack 2**: neon, comic, bounce-in, shake; per-word emoji auto-insert (AI) | LokaClip v2.1.0 parity+ | Gallery | pack params | ASS + emoji PNG | G-PARITY |

---

## 7. Caption style packs (specification)

### 7.1 Stage-1 packs

Sizes are fractions of frame height H (1920 at export). "Cap" means the rendered cap height of
uppercase glyphs. Position means the vertical centre of the caption block. Animation curves
are in ms.

| # | Pack (UI name) | Evidence | Font (OFL) | Weight / case | Text / stroke / shadow | Highlight | Reveal and animation | Words / lines | Position |
|---|---|---|---|---|---|---|---|---|---|
| P1 | **Kuning Pop** (Hormozi-ID) | Hormozi specs `[WEB]`; current V3 karaoke colour #FFE14D `[REPO]` | Montserrat Black (900) | ALL CAPS | #FFFFFF; stroke #000 0.45 % H (≈9 px); shadow 0 | Active word #FFE14D (colour swap) | `chunk_karaoke`; pop 70→108→100 % over 0–90–170 ms | 1–3 words, 1 line (2 if > 14 chars) | 64 % H; cap 3.2 % H (≈61 px) |
| P2 | **Kuning-Merah** (QuickClips) | `[FIELD]` ToSyYoKLIbE | Anton (condensed) or Oswald Bold | ALL CAPS | Base #FFE45C; stroke #000 0.2 % H (≈4 px); soft glow: shadow #000 alpha 60 %, blur 0.35 % H | Keyword (Ctrl+E or AI) #FF3B4F; non-keyword stays yellow | `segment_static` per cue; fade 120 ms | 2 lines × 2–3 words | block 61–68 % H; cap 2.2 % H |
| P3 | **Kotak Hitam** (Word box) | `[FIELD]` Unlocked Media; LokaClip `word_box` | Montserrat ExtraBold (800) | ALL CAPS | #FFFFFF; stroke #000 0.12 % H; no shadow | Active word on a #000000 box, 100 % opacity, padding 0.18 em × 0.08 em, radius 0 | `chunk_karaoke`; box jumps word to word (no tween) | ≤ 6 words, 1 line | 68 % H; cap 1.8 % H (≈35 px) |
| P4 | **Stabilo Kuning** (Highlighter) | `[FIELD]` DuniaWTF | Montserrat ExtraBold | ALL CAPS | #FFFFFF; stroke #000 0.2 % H | Active word or phrase on a #FFD21F box, padding 0.15 em, radius 0.1 em; text stays white with stroke | `chunk_karaoke`; box slides in with a 60 ms width tween (`\clip` animate) | ≤ 5 words, 1 line | 70 % H; cap 1.9 % H |
| P5 | **Satu Kata** (One word) | `[FIELD]` Seputar Viral; CapCut "one-word pop-ups" `[WEB]` | Poppins Black (900) | ALL CAPS | #FFFFFF; stroke #000 0.35 % H (≈7 px); shadow 0 | none (each word is the active one) | `per_word`; slam 130→100 % in 120 ms | 1 word | default 55 % H; "ikuti wajah" option places it 12 % H below the tracked face bbox |
| P6 | **Karaoke Sweep** | LokaClip `karaoke_sweep` (v1.9.2); Potongin V3 karaoke | Poppins Bold (700) | Sentence case (toggle caps) | Unsung #FFFFFF; stroke #000 0.3 % H; shadow 0.1 % H | Sung colour #FFE14D sweeping via `\kf` | `karaoke_sweep` | ≤ 4 words, ≤ 2 lines (V3 cue rule) | 64 % H (V3 today: 17 % from bottom, i.e. 83 %; re-tune to the field median); cap 2.6 % H |
| P7 | **Santai Ketik** (lowercase) | `[FIELD]` AJ Recap / AJ Recap 99 | Courier Prime Bold (OFL) or Space Mono Bold (OFL) | lowercase / as spoken | #FFFFFF; no stroke; shadow #000 alpha 50 %, offset 0.12 % H, blur 0.2 % H | none | `segment_static`; fade 120/80 ms | ≤ 7 words, ≤ 2 lines | 72 % H; x-height 1.4 % H |
| P8 | **TikTok Box** (native classic) | TikTok "Classic" with background `[WEB]`; field `sheet2 col3` | Plus Jakarta Sans Bold (OFL; Indonesian foundry Tokotype) | Sentence case | #000000 on a #FFFFFF box, radius 0.35 em, padding 0.3 em; inverse variant white on #000 60 % | none (optional keyword bold) | `segment_static` | ≤ 8 words, ≤ 3 lines | 70 % H or top 10 % H |

Stage 2 adds these packs:
- **P9 Neon**: Poppins Bold, #FFFFFF core, `\blur` glow in #00E5FF, animated from glow 6 to 2.
- **P10 Komik**: Lilita One or Bangers, yellow #FFE14D fill, double stroke (inner white 0.15 %
  H, outer black 0.45 % H), tilt −3°, bump animation.
- **P11 Glow**: LokaClip `glow` curve `\blur6 → \blur0` over 160 ms.
- **P12 Kapsul (Pill)**: KlipAja "Pill"; each cue sits on a rounded pill of #000 70 %.

### 7.2 StylePack JSON (fields)

These are LokaClip-compatible concepts in Potongin naming. All lengths are fractions of H
unless marked em.

```json
{
  "schema": "potongin.stylepack.v1", "id": "kotak-hitam", "version": 3,
  "font": {"family": "Montserrat", "file": "Montserrat-ExtraBold.ttf", "weight": 800},
  "case": "upper", "size_cap": 0.018, "letter_spacing_em": 0.0, "line_height_em": 1.12,
  "fill": "#FFFFFF", "stroke": {"color": "#000000", "width": 0.0012},
  "shadow": {"color": "#000000", "alpha": 0.0, "blur": 0.0, "dx": 0.0, "dy": 0.0},
  "highlight": {"mode": "box", "color": "#000000", "text_color": "#FFFFFF",
                "pad_x_em": 0.18, "pad_y_em": 0.08, "radius_em": 0.0},
  "keyword": {"color": null, "box": null},
  "reveal": "chunk_karaoke", "words_per_chunk": 6, "max_lines": 1, "wrap_width": 0.84,
  "animation": {"type": "none", "in_ms": 0, "curve": []},
  "position": {"anchor": "center", "y": 0.68, "x": 0.5, "follow_face": false},
  "safe_area": "tiktok", "min_scale": 0.85,
  "license": {"font": "OFL-1.1", "font_notice": "fonts/OFL-Montserrat.txt"}
}
```

### 7.3 Hook designs

Stage 1 ships all nine (M8).

| Design | Evidence | Spec |
|---|---|---|
| Bar | LokaClip "Bar"; current Potongin hook box | Text on a #000 65 % box per line (BorderStyle 3, one event per line to avoid overlapping boxes, as `captions_ass.py` already does) |
| Marker | LokaClip "Marker" | Highlighter swipe behind each line, #FFE14D, 0.9 em tall, skewed −4°, drawn left to right in 200 ms (`\p1` rect with `\clip` animation); text #000 |
| Note | LokaClip "Note" | White card, radius 0.25 em, tilt −2°, drop shadow 0.4 % H, text #111 Poppins Bold |
| Gradient | LokaClip "Gradient" (`gradientHeightPct`, `gradientOpacityMax`) | Top dark gradient 0→70 % alpha over 28 % H (PNG or `gradients` source), white bold text over it |
| Sticker label | LokaClip "Sticker" (label fill, stroke, tilt, roughness); `[FIELD]` red pills | Category pill ("LUCU", "FAKTA", "Awok Awok 😬"): #E53935 fill, white Poppins ExtraBold, radius 0.3 em, tilt −4°, above or beside the hook; emoji via PNG |
| Punchline | LokaClip "Punchline" (inner and outer strokes, fill top/bottom) | Two-tone huge caps: fill #FFFFFF top → #FFE14D bottom (PNG gradient text), inner stroke #000, outer stroke #FFF, tilt −3°, slam in |
| Comic | LokaClip "Comic" (`ComicFrame/ComicFill/ComicText`) | Jagged burst frame (`\p1` polygon), yellow fill, black 0.4 % H outline, Bangers or Lilita One |
| Quote card | `[FIELD]` 7CHlNdYnWzo | White rect, 3.5 % side margins, green (#22C55E) quote badge top-left, 3 dots bottom-right; line 1 Title Case semibold, line 2 ALL CAPS bold; persistent by default |
| Top banner | `[FIELD]` blue and orange bands | Full-width band (#1565C0 or #F57C00), white ALL-CAPS Montserrat ExtraBold, 2 lines, top 20–30 % H, persistent |

### 7.4 Fonts and licences

| Font | Licence | Use |
|---|---|---|
| Montserrat (Black, ExtraBold, Bold) | OFL-1.1 (Google Fonts) | P1, P3, P4, banners |
| Poppins (Bold, ExtraBold, Black) | OFL-1.1 (LokaClip bundles Poppins-Bold with its OFL file) | P5, P6, hooks |
| Anton, Oswald | OFL-1.1 | P2 condensed |
| Plus Jakarta Sans | OFL-1.1 (Tokotype, Jakarta) | P8, UI-native |
| Courier Prime / Space Mono | OFL-1.1 | P7 |
| Lilita One, Bangers | OFL-1.1 (LokaClip bundles Lilita One) | Comic |
| Inter | OFL-1.1 | UI and neutral captions |
| Noto Emoji images (PNG) | Apache-2.0 (images), font OFL-1.1 | Emoji overlays |
| **Avoid**: The Bold Font (free version) | © Sven Pels, "All rights reserved"; free version uppercase-only (cmap has no lowercase); redistribution terms unclear | Do not bundle. Offer Anton or Montserrat Black as "Hormozi-like" |
| **Avoid**: Komika Axis | Freeware; "no modification … for re-release"; font subsetting in the browser counts as modification risk `[WEB fontsquirrel]` | Use Bangers or Lilita One instead |

Every font must be (a) copied into the image under `resources/fonts/` with its licence text,
(b) passed with `ass=…:fontsdir=` (LokaClip does `subtitles=…:fontsdir=` `[LC-bin 15816]`),
and (c) served to JASSUB as the same TTF (`availableFonts` / `fonts` option). Browser WOFF2
conversions are forbidden for parity.

---

## 8. Keyboard shortcut map

CapCut-compatible where known `[WEB]`, LokaClip-compatible for undo `[LC-rel v1.9.8]`, and
otherwise proposed.

| Action | Key | Origin |
|---|---|---|
| Play/pause | Space / K | CapCut |
| Reverse / forward shuttle | J / L | CapCut |
| Frame step | ← / → | CapCut |
| Word step (transcript) / marker step | Alt+← / Alt+→; Shift+← / Shift+→ | proposed |
| Split at playhead | Ctrl+B | CapCut |
| Trim left / right of playhead | Q / W | CapCut |
| Delete (ripple on main track) | Delete / Backspace | CapCut + Descript |
| Delete and close gap | Ctrl+Shift+D | CapCut (per skillademia) |
| Ignore (strike) words | Ctrl+Shift+X | proposed (Descript concept) |
| Set in / out | I / O | NLE convention |
| Nudge boundary by word / frame | , . / Shift+, Shift+. | proposed |
| Undo / redo | Ctrl+Z / Ctrl+Shift+Z, Ctrl+Y | LokaClip, CapCut |
| Add keyframe | Alt+K | CapCut |
| Link / unlink A/V | Ctrl+L | CapCut |
| Duplicate | Ctrl+D | CapCut |
| Add text | Ctrl+T | proposed |
| Mark keyword (caption/hook) | Ctrl+E | proposed (CapCut uses Ctrl+E for effects: resolve by context, text focus vs timeline focus) |
| Zoom timeline | Ctrl+= / Ctrl+- / Shift+Z fit | CapCut |
| Toggle snapping | N | proposed |
| Toggle safe zones | ' (apostrophe) | proposed |
| Render exact frame | Ctrl+Shift+R | proposed |
| Export | Ctrl+Shift+E | CapCut |

Help overlay: `?`. Shortcuts are shown in tooltips in Bahasa Indonesia ("Potong (Ctrl+B)").

---

## 9. COULD: Stage 3+

| ID | Feature | Why later | Key risk or gate |
|---|---|---|---|
| C1 | AI B-roll search (stock or AI images) from the transcript | Needs a stock API (Pexels licence allows free use but has redistribution limits) and relevance QA | Relevance ≥ 0.7 judged; licence metadata stored |
| C2 | TTS voice-over / Indonesian dubbing | Voice licensing and quality of `id-ID` voices | Listening-test MOS ≥ 3.8 |
| C3 | Caption translation (EN/MY) + bilingual captions | Market expansion (KlipAja added Arabic and Malay) | Keep edited captions (CapCut bilingual re-recognition pitfall `[WEB]`) |
| C4 | Background removal / green screen | CPU cost (U²-Net / rembg MIT) | ≤ 2× realtime on CPU, or skip |
| C5 | "Edit dengan chat" agent (OpusClip-style edit log) | Needs a stable command API first (S1–S4) | Every agent edit is an undoable op with a human-readable log |
| C6 | Smooth jump cut (morph/regenerate) | Generative; GPU | none |
| C7 | Eye contact / face retouch | Generative; ethics | none |
| C8 | Three-person layout, gameplay layout | OpusClip "Three", KlipDong "Gaming" | ASD accuracy with 3 seats |
| C9 | Beat-synced cuts, speed ramps with curves | Music-driven edits (less relevant for podcasts) | none |
| C10 | Progress bar / series "Part N" auto-labels | Retention tricks | none |
| C11 | Direct publish (TikTok / YouTube APIs), scheduling | OAuth, platform review | none |
| C12 | Review links with timestamped comments | Team clipping agencies | none |
| C13 | Reaction-shot insertion (PodReels research: teasers use reaction shots, transitions, music) | Needs ASD plus listener-face detection | none |
| C14 | Animated stickers (GIF/Lottie) | Render cost and Lottie → ffmpeg path | none |

---

## 10. Gaps between the current Potongin editor (V2) and the MUST set `[REPO]`

1. Canvas is 720×1280 (`VisualEdit.canvas_width/height` defaults, render `PlayResX 720`).
   Stage 1 must render at 1080×1920. The measured cost is fine (§2.4).
2. `font_family` accepts "Inter" and "Noto Sans", but the production image has only DejaVu.
   This is a **live parity bug**. Fix it via bundled fonts and `fontsdir`.
3. `emphasis="keyword"` raises `RenderUnsupported`. Keyword highlight is core to P2 and P5
   and to M5.
4. `face-track` raises `UnsupportedRenderMode` in the editor render. V3's `render.py` has
   face-track, so the two paths diverge. The single-render-plan design (M14) removes this.
5. `MAX_OVERLAYS = 2` (one title and one logo). M9, M10 and M12 need ≥ 20 overlays.
6. No segments/jump-cut model, waveform, filmstrip, sound-event UI, music, emoji, templates,
   or cold-open or hook editing in the editor.
7. The V2 editor is bound to `candidates.v2.json`, while V3 outputs `SelectedClip` (cold
   open, hook, title, hashtags). The edit document must be keyed by the V3 selection.

---

## 11. Sources

LokaClip:
- Releases v1.4.8 to v2.1.0: https://github.com/Rafi718/lokaclip_release/releases (local copy
  `_sources/lokaclip-releases.md`)
- https://lokaclip.pro
- Binary strings: `scratchpad/lokaclip/strings.txt` lines 13966, 13992, 14104-14199, 14454,
  14563, 14602, 15401, 15476-15490, 15766-15853, 15993, 16059-16093, 16109, 16140
- Bundled fonts: `scratchpad/lokaclip/extract/resources/fonts/`

Indonesian competitors:
- https://klipaja.id/changelog
- https://klipdong.id/

CapCut:
- https://www.capcut.com/tools/desktop-video-editor
- https://www.capcut.com/resource/edit-video-with-text
- https://www.capcut.com/tools/filler-words
- https://capcutguide.com/capcut-word-by-word-captions/
- https://capcutguide.com/capcut-audio-mixing/
- https://www.skillademia.com/shortcuts/capcut-shortcuts/

OpusClip:
- https://www.opus.pro/ai-video-editor
- https://help.opus.pro/docs/article/layout-and-reframing
- https://help.opus.pro/api-reference/brand-template (preset template ids incl.
  preset-fancy-Karaoke)
- https://www.opus.pro/captions
- https://opusclip.canny.io/changelog/new-b-roll-layouts-picture-in-picture-and-split

Descript:
- https://help.descript.com/hc/en-us/articles/15726742913933-Edit-like-a-doc
- https://help.descript.com/hc/en-us/articles/10164807277453-Shorten-word-gaps
- https://help.descript.com/hc/en-us/articles/10164806394509-Filler-words
- https://help.descript.com/descript-terms-and-concepts

Captions and styles:
- https://docs.submagic.co/api-reference/templates
- https://www.submagic.co/blog/how-to-make-alex-hormozi-captions
- https://ascynd.io/en/blog/hormozi-captions
- https://captions.ai/features/edit-with-ai
- https://techcrunch.com/2024/06/26/video-editing-app-captions-releases-a-new-ai-edit-feature-that-automatically-adds-effects-to-your-video/

VEED and Kapwing:
- https://www.kapwing.com/help/how-to-use-smart-cut/
- https://support.veed.io/en/articles/11589317-magic-cut

Safe zones:
- https://kreatli.com/guides/tiktok-safe-zone
- https://zeely.ai/blog/tiktok-safe-zones/

Font licences:
- https://the-bold-font.com/
- https://www.fontsquirrel.com/license/komika-axis
- Google Fonts OFL families as listed.

Libraries (npm registry, 2026-09-24):

| Package | Version | Licence |
|---|---|---|
| jassub | 2.5.16 | LGPL-2.1+ / FTL / MIT mix; bundles libass 0.17.4-43 |
| wavesurfer.js | 8.0.0 | BSD-3-Clause |
| mp4box | 2.4.1 | BSD-3-Clause |
| konva | 10.7.0 | MIT |
| react-konva | 19.3.0 | MIT |
| @xzdarcy/react-timeline-editor | 1.0.0 | MIT |
| harfbuzzjs | 1.6.2 | MIT |
| opentype.js | 2.0.0 | MIT |
| ass-compiler | 0.1.16 | MIT |
| remotion | 4.0.527 | custom licence |

Field sample: YouTube `#podcastindonesia` Shorts. The frames are in
`_bench/shorts/sheet{0,1,2}.png` and `caps{1,2}.png`.

| Video id | Views |
|---|---|
| RRI57ERJjlE | 5.7 M |
| HuQJ4Mw4Dpo | 2.4 M |
| UD2YN2DKdnM | 1.2 M |
| SDKDA5s1szA | 1.1 M |
| CyCMOZE7QHo | 1.0 M |
| GQYqrchyV64 | 938 k |
| zkiXun-Iycg | 781 k |
| ni3_r_SW9zY | 649 k |
| 2SuXT-cBRHM | 598 k |
| UNkAyEZbXqQ | 482 k |
| TWNKTP2kZpM | 457 k |
| ToSyYoKLIbE | 395 k |
| VBLpMsbBCuk | 382 k |
| _1uEEbKMLVA | 375 k |
| g7h7m0l8aII | 340 k |
| W-R3YL6_RkY | 223 k |
| c22KGylD68k | 178 k |
| tFjbbcxRaAs | 101 k |
| jCxC_9lpFkE | 100 k |
| 7CHlNdYnWzo | 92 k |
| JKYvkDMJizo | 88 k |

Benchmarks: `_bench/` holds `fg.txt` (the stage-2 filter graph), `pop.ass`, `emoji.ass`,
`bands.png` (pop-jitter evidence), and `emoji_s.png` / `emoji_docker_s.png` (emoji
evidence).
