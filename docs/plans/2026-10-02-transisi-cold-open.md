# Cold-open transition (Transisi cold open): implementation spec

Date: 2026-10-02. Status: ready to build (three parallel tasks, §9). Branch of this spec:
`transisi-spec`.

The owner asked for a transition at the cold-open join: the hook teaser that opens a clip (segment
role `cold_open`) cuts into the body that follows, and that cut should get an effect. The owner's
decisions (2026-10-02, final) are inputs here and are not reopened:

1. Auto clips whose clip has a cold open get a **white flash** (Kilat putih, about 0.2 s in total)
   plus a **whoosh** at the join by default. Clips without a cold open are unchanged.
2. The editor's Cold open panel offers Potong langsung (`cut`) / Kilat putih (`flash_white`) /
   Gelap sebentar (`dip_black`, about 0.3 s), plus a separate Whoosh on/off toggle. There is no
   crossfade: `xfade` stays disabled, because it overlaps the pieces and would shift every caption.
3. The transition does not change clip duration, caption timing or the time map.
4. Clips that are already rendered stay exactly as they are. Their revision 0 stays a cut, and the
   R10 hard link (an unchanged clip exports the auto file itself) keeps holding for old and new
   clips.
5. Both engines render the transition: `legacy` (`src/ai_clipper/render.py`, production
   auto-render today) and `edit-v2` (`src/ai_clipper/edit_v2`, editor exports and auto-render
   with `POTONGIN_RENDER_ENGINE=edit-v2`). The two engines may differ only within the look gate
   (P-LOOK). The browser preview must match the export within the parity gates.

Everything below was checked against the code at `origin/main` `8996a1b`. The FFmpeg filters it
relies on were probed on 2026-10-02 in the production image (`ai-video-clipper:latest`, FFmpeg
5.1.9-0+deb12u1):
- `lutrgb` runs on `gbrp` natively (no `auto_scale` inserted), and its timeline `enable` on `t`
  turns it on for exactly the intended frame;
- `geq` on `yuv420p` with `T` and `enable` gives the expected values;
- `adelay=delays=480S:all=1` delays by exactly 480 samples;
- `amix=…:normalize=0` adds its inputs exactly (0.25 + 0.5 → 24576 in s16).

## 0. Decisions at a glance

| Question | Decision | Why (details in the section) |
|---|---|---|
| Whoosh representation | A field on the join: `"sfx": {"id": "whoosh", "v": 1}` (absent = no sound) | It belongs to the join and must move with it. The track model would need four lifts that are `op_disabled` today (a second audio track, a 4th track, a join anchor and assets that live outside the job store) (§1.2) |
| Transition length | Fixed per style, **no `dur_f` in the document** | No UI control asks for it. A stored value would only duplicate a function of fps (§1.3) |
| Values leaving `op_disabled` | Join styles `flash_white`, `dip_black`. `xfade` and the audio role `sfx` stay `op_disabled` | Owner decision 2; the whoosh is not a track (§1.1) |
| New error code | `sfx_unknown` (semantic, blocking), "Efek suara transisi tidak dikenal" | Mirrors `pack_unknown` (§1.1) |
| `schema_minor`, `COMPILER_ID`, `COMPILER_VERSION`, `RENDER_SEMANTICS`, plan schema | **All unchanged** | Documents without a transition give byte-identical plans, graphs and keys. Every key that can see a transition covers it through the plan sha, or gains an explicit field (§1.5) |
| How a clip records what its auto render used | Manifest clip field `cold_open_join`. Absent = cut, no sound | Old manifests lack it, so old clips seed as a cut (§6) |
| Preview | The server mix carries the whoosh. The player draws a full-frame colour fill **between the plate and the text** | Plates stay per source frame. Audio stays exact (P-AUD) (§5) |
| Layer order | The effect covers the video only. Captions, hook and logo stay on top, unchanged | The same order in both engines and in the browser, and P-TIME/P-TXT keep their meaning (§4) |

## 1. Contract changes to `clip-edit-v2`

### 1.1 The join

```json
"joins": [{"after": "seg_co", "style": "flash_white", "audio_fade_ms": 30,
           "sfx": {"id": "whoosh", "v": 1}}]
```

| Key | Rule (Essentials) | Codes |
|---|---|---|
| `after` | unchanged: the cold-open segment id | `cold_open_invalid` as today |
| `style` | `cut`, `flash_white`, `dip_black` | `xfade` → `op_disabled`; any other string → `range_invalid` |
| `audio_fade_ms` | unchanged, 0–250 (seed 30) | `range_invalid` |
| `sfx` | **optional**. Absent: no sound. Present: an object with exactly `id` (string) and `v` (integer) | `null`, a non-object, or a missing `id`/`v` → `range_invalid` at the key; an extra key → `unknown_key` (parse level); a well-formed `{id, v}` other than `{"id": "whoosh", "v": 1}` → **`sfx_unknown`** at `/main/joins/0/sfx` |

- Any style can be combined with `sfx`. "Potong langsung + whoosh" is a valid document.
- The existing structural rules are unchanged: exactly one join when a cold open exists, none
  without one, and `after` names the cold open. So a transition without a cold open is
  `cold_open_invalid`, as any join without a cold open already is.
- `edit_v2/doc.py`:
  - `_ROOT`'s join key set becomes `_keys("after", "style", "audio_fade_ms", sfx=_keys("id", "v"))`;
  - `_JOIN_STYLES = ({"cut", "flash_white", "dip_black"}, {"xfade"})`;
  - `joins_rule` checks `sfx` the way `captions.pack` is checked: `self.obj`,
    `self.string(…, "id")`, `self.integer(…, "v", -MAX_SAFE_INTEGER)`, then any well-formed
    `(id, v)` that is not a key of `transitions.SFX` is `sfx_unknown`.
  - `_AUDIO_ROLES` is **not** changed: `sfx` stays `op_disabled` as a track role.
- `edit_v2/errors.py`: add `"sfx_unknown"` to `SEMANTIC_CODES` and
  `"sfx_unknown": "Efek suara transisi tidak dikenal"` to `_MESSAGES` (semantic block, after
  `pack_unknown`). The client never produces it, so the web shell's `MESSAGES` table does not
  need it (its drift test only checks the codes it lists).
- Canonical form: the "no sound" state is the **absent** key, never `null`. Each meaning has
  exactly one byte form, so content equality (R10) means "same look and sound".

### 1.2 Why the whoosh is a join field, not an `sfx` track item (FINAL §4)

FINAL models SFX as audio-track items with role `sfx`. That route would lift four Essentials
limits at once:
- a second `audio` track (`kind` seen twice → `op_disabled`);
- a 4th track (`index >= 3` → `op_disabled`);
- a start anchor that follows the join (`at: "word"`/`seg` → `op_disabled`; the item would need
  a new "join" anchor);
- an asset that lives in `resources/`, not in the job asset store (every item asset today is
  `sha256:<hex>` in `analysis/assets/` and in `doc.assets`).

The UI has one toggle in the Cold open panel. The sound only exists with the join, and must move
when the cold open or the body is trimmed. As a join field it moves by construction (§2.1), and
it disappears with the cold open (joins are emptied when the cold open is removed). Two-tab merge
treats it as one part (§7.3). Stage 2 can still migrate `join.sfx` into an item later: the value
is already a versioned resource reference.

### 1.3 Why there is no `dur_f`

FINAL's join has `dur_f`. Owner decision 2 has no duration control, and the length is "about
0.2 s / 0.3 s" per style. A stored `dur_f` would have to equal a function of the fixed output fps,
so the same meaning would have two byte forms (or a rule forcing one). The length is therefore
fixed per style in `edit_v2/transitions.py` (§2). Changing it later is a look change: it bumps
`RENDER_SEMANTICS`, or a later stage adds `dur_f` as an optional key whose absence means today's
constant.

### 1.4 Backward compatibility

- **Stored documents** (seeds, `edit/doc.json`, archives) have joins without `sfx` and with
  `style: "cut"`. They stay valid unchanged, mean exactly what they meant before, and give
  byte-identical plans (§1.5).
- **`schema_minor` stays 0.** `sfx` is optional and every minor-0 document stays valid. A minor
  bump would not help anyone:
  - the editor client and the validator ship in one image;
  - an older server already refuses the new values with precise codes (`op_disabled` for the
    style, `unknown_key` for `sfx`);
  - stamping minor 1 on every new seed would only change the bytes of seeds that use nothing new.

  CONTRACTS §3.8 ("join styles under minor 1") is amended by this section.
- **Rollback.** After a revert to the previous image, a document or seed that *uses* a transition
  or a whoosh cannot be read (422 `op_disabled`/`unknown_key`). Clips that use neither are
  unaffected. T1 adds this to `docs/editor/OPERASIONAL.md` §2 (rollback).
- **`base.engine.render_semantics`** stays 1 in new seeds.

### 1.5 Versions, keys and caches

None of `COMPILER_ID` (`edit-v2/1`), `COMPILER_VERSION` (`edit-v2/1.0.0`), `RENDER_SEMANTICS`
(1), `SCHEMA_MINOR` (0) or `PLAN_SCHEMA` (`potongin.render-plan/1`) changes. Each key and cache
was checked:

| Key / cache | Change | Effect |
|---|---|---|
| `plan_sha256` (`RenderPlan.to_json`) | Gains a `"joins"` key **only when** a join has `style != "cut"` or an `sfx` (§1.6) | Every existing document hashes to the same plan sha (test: every fixture plan sha and every golden is unchanged). A transition document has its own plan sha |
| Render key (R9) | none (it contains `plan_sha256`) | covered |
| `plate_key` | none | plates are the layout of source frames; the transition never reaches them |
| Preview audio `audio_key` (`preview_cli.audio_key`) | gains `"sfx": [{id, v, sha256, start_smp, skip_smp}]` **only when** a join has an sfx | Old preview FLACs stay valid. Toggling the whoosh makes a new mix; changing only the style reuses the mix |
| `mix_sha256` (`audio_graph`) | none to the rule; the whoosh changes the graph text, the inputs and the sidecars it already hashes | covered |
| Loudness cache `<mix16>.loudness.json` | none | keyed by `mix_sha256` |
| `frame_key` (truth frames) | none | contains `plan_sha256` |
| `_rev0_identity` (`preview_cli`) | gains `"sfx": <sha256 of the WAV>` **only when** the seed has an sfx | the cached rev0 plan sha follows the resource |
| `toolchain.json` | none | the WAV is pinned by sha in code and in the plan (§3.4) |

`COMPILER_VERSION` is deliberately not bumped. It is part of `plate_key`, `audio_key`,
`frame_key` and the derived-logo key, so a bump would throw away every preview cache for no gain:
documents without a transition compile to byte-identical graphs (the existing goldens prove it),
and documents with one have new plan shas.

### 1.6 Render plan and plan DTO (the cross-task shapes)

**`RenderPlan`** (`edit_v2/plan.py`) gains one field at the end:
`joins: tuple[transitions.JoinPlan, ...] = ()`. It holds one entry per document join, in document
order; Essentials has 0 or 1.

```python
@dataclass(frozen=True)
class SfxPlan:          # edit_v2/transitions.py
    id: str             # "whoosh"
    v: int              # 1
    sha256: str         # the pinned WAV sha (transitions.SFX[(id, v)].sha256)
    start_smp: int      # output sample where the whoosh's first used sample plays
    skip_smp: int       # whoosh samples dropped at its head (0 in every valid document)
    samples: int        # whoosh samples used = 20160 - skip_smp
    hit_smp: int        # output sample of the hit = smp(at_f)

@dataclass(frozen=True)
class JoinPlan:
    after: str                              # "seg_co"
    style: str                              # "cut" | "flash_white" | "dip_black"
    at_f: int                               # J, the first output frame after the join
    alpha: tuple[tuple[int, int], ...]      # (output frame, alpha_pm) for alpha_pm > 0, ascending
    sfx: SfxPlan | None
```

**Plan JSON** (hashed into `plan_sha256`). The key `"joins"` is added to `RenderPlan.to_json()`
only when `any(j.style != "cut" or j.sfx is not None for j in plan.joins)`, and then lists every
join:

```json
"joins": [{"after": "seg_co", "style": "flash_white", "at_f": 60,
           "alpha_pm": [[58, 333], [59, 666], [60, 1000], [61, 666], [62, 333]],
           "sfx": {"id": "whoosh", "v": 1, "sha256": "<64 hex>", "start_smp": 84576,
                   "skip_smp": 0, "samples": 20160, "hit_smp": 96096}}]
```

**Plan DTO** (`preview/plan`, CONTRACTS §4.3; built by `transitions.joins_dto(plan.joins)` in
`preview_cli._plan`). The DTO **always** has the key, `[]` when there is no join:

```json
"joins": [{"after": "seg_co", "style": "flash_white", "atF": 60, "rgb": [255, 255, 255],
           "alphaPm": [[58, 333], [59, 666], [60, 1000], [61, 666], [62, 333]],
           "sfx": {"id": "whoosh", "v": 1, "startSmp": 84576, "hitSmp": 96096, "samples": 20160}}]
```

- `rgb` is `[255, 255, 255]` for `flash_white`, `[0, 0, 0]` for `dip_black`, and `null` for `cut`.
- `alphaPm` is `[]` for `cut`. Its frames are strictly increasing, in `[0, totalFrames)`, with
  alpha 1–1000.
- `sfx` is `null` without a whoosh. It is informational: the player never schedules it (§5.3).
- The DTO is not hashed, so including cut joins costs nothing.

## 2. Frame math

### 2.1 Definitions

- `J` (`at_f`) is the output frame of the first piece after the join: the sum of the `frames` of
  every piece whose `seg` is the cold open. Pieces are laid out back to back from 0, so this is
  also `out_f0` of the body's first piece.
- For output frame `n`, `k = n − J` and `τ = k · den/num` seconds. `τ` is the frame's start time
  relative to the join; the join is the start of frame `J`.
- Each style is a symmetric triangle in time, peaking (alpha 1000 = pure colour) on frame `J`.
  Its half-width is `W`: `flash_white` `W = 100 ms`, `dip_black` `W = 150 ms`.
  `alpha(τ) = max(0, 1 − |τ|/W)`, sampled at each frame's start.
- Integer form, exact at every rate (`transitions.alpha_pm(style, k, fps)`):

  ```
  v = W_ms · num − 1000 · |k| · den
  alpha_pm = div_round_half_up(1000 · v, W_ms · num)   if v > 0, else 0
  ```

- Frames with `alpha_pm > 0` per side: `before = ⌈W·F⌉ − 1` frames (`J−before … J−1`, the
  cold-open side) and `after = ⌈W·F⌉` frames (`J … J+after−1`, the body side). The support is
  exactly `2W` = 200 ms / 300 ms.

### 2.2 Tables (every supported fps)

`alpha_pm` from the first affected frame to the last; `J` is the entry 1000.

| Style | fps | before | after | alpha_pm | Visible frames (ms) |
|---|---|---|---|---|---|
| flash_white | 24/1 | 2 | 3 | 167, 583, **1000**, 583, 167 | 5 (208) |
| flash_white | 25/1 | 2 | 3 | 200, 600, **1000**, 600, 200 | 5 (200) |
| flash_white | 30/1 | 2 | 3 | 333, 667, **1000**, 667, 333 | 5 (167) |
| flash_white | 24000/1001 | 2 | 3 | 166, 583, **1000**, 583, 166 | 5 (209) |
| flash_white | 30000/1001 | 2 | 3 | 333, 666, **1000**, 666, 333 | 5 (167) |
| dip_black | 24/1 | 3 | 4 | 167, 444, 722, **1000**, 722, 444, 167 | 7 (292) |
| dip_black | 25/1 | 3 | 4 | 200, 467, 733, **1000**, 733, 467, 200 | 7 (280) |
| dip_black | 30/1 | 4 | 5 | 111, 333, 556, 778, **1000**, 778, 556, 333, 111 | 9 (300) |
| dip_black | 24000/1001 | 3 | 4 | 166, 444, 722, **1000**, 722, 444, 166 | 7 (292) |
| dip_black | 30000/1001 | 4 | 5 | 110, 333, 555, 778, **1000**, 778, 555, 333, 110 | 9 (300) |

`tests/test_edit_v2_transitions.py` pins this table verbatim.

### 2.3 Pixels

The effect is a per-pixel blend toward a constant colour `C`, applied to the video layer only:

```
out = floor((p · (1000 − a) + C · a + 500) / 1000)        a = alpha_pm, p and out 8-bit
```

- edit-v2 applies it in the composite's planar RGB (`gbrp`), with `C = 255` (white) or `0`
  (black) on R, G and B, before the text (§4.1).
- legacy applies it in `yuv420p` (TV range), with `C = (235, 128, 128)` (white) or
  `(16, 128, 128)` (black) on Y, Cb, Cr (§4.3). The blend is affine, so in YUV it is the same
  blend as in RGB up to rounding.
- The browser draws `fillStyle = rgb(C)` with `globalAlpha = a/1000` over the plate frame (§5).

### 2.4 Invariants and short segments

- **Unchanged by any join:** `pieces`, `total_frames`, `total_samples`, `speech_spans`, the ASS
  bytes and their sha, `cues`, `hook`, `speech_envelope` and `music_envelope`. The 30 ms speech
  fade at the cold-open join (`audio_fade_ms`) stays as it is. Test: a transition document's
  plan equals the cut document's plan in every field except `joins` and `plan_sha256`.
- **Short sides cannot happen in a valid document.** After removals, the cold open has at least
  `⌈0.5·F⌉ ≥ 12` frames and the body at least `⌈3·F⌉ ≥ 72` frames (`cold_open_invalid`,
  `duration_out_of_bounds`); the widest sides are 4 and 5 frames. Defined behaviour anyway, for
  robustness: affected frames outside `[0, total_frames)` are dropped and the others keep their
  alpha (never rescaled). The whoosh head is trimmed (`skip_smp`) when `smp(J) < 11520`, which a
  valid document cannot produce (`smp(⌈0.5·F⌉) ≥ 24000`). The tail past the end is cut by the
  graph (§4.2).
- **Pieces inside the window.** The effect is defined on output frames, so a jump cut inside the
  window (e.g. a removal 2 frames into the body) stays under the colour fill. Nothing special
  happens there.
- `plan_joins` raises `DocSemanticInvalid("cold_open_invalid", path="/main/joins/0")` when the
  `after` segment has no pieces or no piece follows it (unreachable for a validated document).

## 3. The whoosh asset

### 3.1 Files

```
resources/sfx/whoosh/v1.wav         48 kHz, stereo, s16le PCM, 20 160 frames (420 ms), 80 684 bytes
resources/sfx/whoosh/v1.meta.json
scripts/sfx/make_whoosh.py          stdlib-only, deterministic generator (Appendix A)
```

`v1.meta.json`:

```json
{"schema": "potongin.sfx/1", "id": "whoosh", "v": 1, "file": "v1.wav",
 "sha256": "<sha256 of v1.wav>", "bytes": 80684,
 "sample_rate": 48000, "channels": 2, "sample_format": "s16le", "samples": 20160,
 "hit_smp": 11520, "peak": 4370,
 "loudness": {"i_clufs": -2900, "tp_cdb": -1720, "measured_with": "FFmpeg 5.1.9 ebur128=peak=true"},
 "license": "CC0-1.0", "author": "Potongin (self-made; no third-party material)",
 "generator": {"script": "scripts/sfx/make_whoosh.py", "sha256": "<sha256 of the script when v1 was made>",
               "seed": 2654435769}}
```

- The licence is CC0: the sound is synthesised from a seeded PRNG by our own script, with no
  samples or recordings. No `/licenses` entry is needed (nothing third-party), and the meta file
  says so.
- Determinism uses Python `int` and `fractions.Fraction` only: no float and no `math`, so no
  platform libm. `make_whoosh.py --check` regenerates v1 in memory and exits 1 unless the bytes
  equal the committed file and its sha equals the meta's `sha256`.
- The prototype in Appendix A, run on 2026-10-02, gave 80 684 bytes with the same sha twice, its
  loudest 10 ms at samples 11 280–11 760, and with peak 4370: `I = −29.0 LUFS`,
  `TP = −17.2 dBTP` (FFmpeg 6.1 ebur128). T1 records the pinned image's numbers in the meta.
- `v1.wav` is immutable. A different sound or level is `v2.wav` with its own pin; documents that
  name v1 keep v1.

### 3.2 Level, relative to speech

- Fixed level: sample peak 4370 (−17.5 dBFS). Integrated loudness of the file (one 400 ms
  gating block, so the momentary maximum) **−29.0 ± 1.0 LUFS**, true peak **≤ −16.0 dBTP**. A
  test inside the image checks both on the committed file.
- The speech loudness of the 20 real owner clips in the P-LOOK evidence
  (`docs/editor/evidence/W2/T2.Z2-P-LOOK.json`) ranges from −10.4 to −27.5 LUFS integrated. At
  −29 LUFS the whoosh is below the speech of every one of them: 1.5 LU under the quietest, which
  speaks above its integrated level while talking, and 18.6 LU under the loudest.
- It stays audible because its hit lands on the join: the speech there dips to 0 over ±30 ms
  (`audio_fade_ms`), and cold opens end and bodies start at word boundaries.
- A per-clip adaptive level was rejected:
  - it needs an audio measurement of revision 0, which must stay unmeasured (R10, P-RT);
  - the editor's toggle would need audio analysis on the client;
  - legacy has no analysis artifacts at render time.
- Owner listening check before release (§10).

### 3.3 Placement and mixing

- **Position:** the hit (sample 11 520 of the file) plays at `smp(J)`, the first sample of the
  first body frame. The whoosh starts 240 ms before the join (inside the cold open) and ends
  180 ms after it (inside the body). `start_smp = max(0, smp(J) − 11520)`,
  `skip_smp = max(0, 11520 − smp(J))`.
- **Mix:** unity gain, added to the pre-master mix (`[apre]`) beside speech and music. It is not
  a ducking trigger (the music envelope still comes from the words), and it is not ducked.
- **Loudness:**
  - `needs_measurement` is unchanged, so a document whose only addition is the whoosh (revision
    0 included) is never measured. `mode: off` renders it at gain 0, which keeps R10 and P-RT
    exact.
  - With `normalize`, music or source gain > 0, the measured pre-master mix includes the whoosh,
    and the master gain and peak protection apply to it like everything else.
- **G-CLICK** stays measured on documents without a whoosh. A whoosh document's speech stem is
  proven identical to the cut document's by G-WHOOSH (§5.4), so G-CLICK carries over.

### 3.4 Pinning

- `edit_v2/transitions.py` holds `SFX = {("whoosh", 1): SfxSpec(id="whoosh", v=1,
  sha256="<pin>", samples=20160, hit_smp=11520)}`. Tests check that the pin equals the file's
  sha and the meta's `sha256`.
- The pin sha is in the plan JSON (so in `plan_sha256` and the render key), in `audio_key` and,
  through the sidecar bytes, in `mix_sha256`.
- `Dockerfile` already runs `COPY resources/ ./resources/`, so no build change and no
  `toolchain.json` change is needed.
- `transitions.load_sfx_pcm(resources_root, spec) -> bytes`:
  - opens `resources/sfx/<id>/v<v>.wav` with `O_NOFOLLOW` (regular file only);
  - checks the sha256 against the pin, then reads it with `wave` (48000 Hz, 2 channels, 16-bit,
    `samples` frames);
  - returns the interleaved s16le frames, cached per process by `(path, size, mtime_ns)`.
- `transitions.sfx_file(resources_root, spec) -> Path` makes the same checks and returns the path
  (legacy passes it to FFmpeg as an input).
- A missing or changed file raises `errors.RenderFailed("render_failed", ref="sfx")` (edit-v2).
  Legacy raises `RuntimeError("cold-open sound effect is missing or changed")`. The image suite
  tests the file, so this is a packaging invariant.

## 4. FFmpeg graphs

### 4.1 edit-v2 video (`compile_ffmpeg._Compiler.picture`)

Today the text chain is `[vlay]{_TEXT_IN[gbrp]},{_TEXT_FILTER}[vtext]`. It becomes:

```python
self.graph.append(f"[vlay]{_TEXT_IN[self.composite]}"
                  f"{transitions.lut_chain(self.plan.joins, self.fps)},{_TEXT_FILTER}[vtext]")
```

`transitions.lut_chain(joins, fps) -> str` returns `""` when no join has an alpha. Otherwise it
returns `","` followed by one `lutrgb` per `(f, a)` of every `JoinPlan.alpha`, joined by commas,
in frame order:

```
lutrgb=r=floor((val*K1+K2)/1000):g=floor((val*K1+K2)/1000):b=floor((val*K1+K2)/1000):enable='between(t,LO,HI)'
K1 = 1000 − a          K2 = C·a + 500          (C = 255 flash_white, 0 dip_black)
LO = (2f − 1)·den / (2·num)   HI = (2f + 1)·den / (2·num)   seconds, rounded half up to 6 decimals,
     written "%d.%06d"
```

- After `concat … settb=den/num` the pts of output frame `n` is `n`, so the timeline's `t` is
  `n·den/num`. The window `[LO, HI]` is ± half a frame around it, so float rounding cannot pick a
  neighbour.
- `frame` mode (truth frames) restamps its single frame to `pts = frame` (`setpts=PTS-STARTPTS+
  <frame>`) and runs the same `picture()`, so the matching `lutrgb` fires there too.
- `final`, `reference` and `frame` share the string (G-DET). `plate_cells` never calls
  `picture()`, so plates carry no effect.
- `lut_chain` raises `ValueError` for a composite other than `gbrp`. Only the S-COLOR gate tools
  build others, and they use cut documents.
- Cost: ≤ 9 filters that are bypassed outside their frame, and a 256-entry table each. No
  measurable change to PF-RENDER (T1 reports it).

Worked example, 30000/1001, `J = 60`, `flash_white`:

```
[vlay]scale=in_color_matrix=bt709:in_range=tv,format=gbrp,
lutrgb=r=floor((val*667+85415)/1000):g=floor((val*667+85415)/1000):b=floor((val*667+85415)/1000):enable='between(t,1.918583,1.951950)',
lutrgb=r=floor((val*334+170330)/1000):g=floor((val*334+170330)/1000):b=floor((val*334+170330)/1000):enable='between(t,1.951950,1.985317)',
lutrgb=r=floor((val*0+255500)/1000):g=floor((val*0+255500)/1000):b=floor((val*0+255500)/1000):enable='between(t,1.985317,2.018683)',
lutrgb=r=floor((val*334+170330)/1000):g=floor((val*334+170330)/1000):b=floor((val*334+170330)/1000):enable='between(t,2.018683,2.052050)',
lutrgb=r=floor((val*667+85415)/1000):g=floor((val*667+85415)/1000):b=floor((val*667+85415)/1000):enable='between(t,2.052050,2.085417)',
ass=filename=captions.ass:fontsdir=fonts:shaping=complex[vtext]
```

The graph file has it on one line; it is wrapped here for reading. The `dip_black` example for
the same `J` has 9 filters, starting
`lutrgb=r=floor((val*890+500)/1000):…:enable='between(t,1.851850,1.885217)'`.

### 4.2 edit-v2 audio (`audio_graph._build`)

The whoosh is a **sidecar**, so `execute.py` needs no new input kind:
- name `audio-sfx-whoosh-v1.pcm` (matches `SIDECAR_NAME`);
- bytes `transitions.load_sfx_pcm(...)`;
- `InputSpec("sidecar", name, ("-f", "s16le", "-ar", "48000", "-ac", "2"))`, added **after**
  every existing own input (speech envelope, music asset, music envelope), so the numbering of
  documents without a whoosh is unchanged.

Branch, with `S0 = sfx.start_smp`, `T = plan.total_samples`, `K = sfx.skip_smp`:

```
[#k:a]asetpts=PTS-STARTPTS[,atrim=start_sample=K,asetpts=PTS-STARTPTS],adelay=delays=S0S:all=1,apad,atrim=end_sample=T[au_w]
```

The bracketed part appears only when `K > 0`. `adelay` gets the literal `S` suffix, e.g.
`adelay=delays=84576S:all=1`.

Mix: the inputs are the speech label, the music label (if any) and `[au_w]` (if any), in that
order. When there are two or more, they mix with `amix=inputs=<n>:normalize=0:duration=first`,
then `,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[apre]` as today. When
the whoosh is present, the speech is closed into `[au_s]` even without music. Without a whoosh,
both existing texts (speech only; speech + music with `inputs=2`) are byte-identical to today.

Example (no music, 30000/1001, `J = 60`, `T = 4 000 000`):
`[au_s][au_w]amix=inputs=2:normalize=0:duration=first,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[apre]`

A/V sync:
- the speech pieces and their timestamps are untouched;
- `amix … duration=first` ends with the speech;
- the whoosh branch is padded and trimmed to exactly `T`;
- so G2 (frames = plan, samples = plan ± 1024) and P-AUD (md5) hold by construction.
`amix` adds `+ 0.0` outside the whoosh window, so those samples are bit-identical to the cut
document's (G-WHOOSH proves it).

### 4.3 legacy video (`render._multi_range_command`)

`render_vertical(..., join_style: str = "cut", join_sfx: str | None = None)`:
- `join_style` is one of `transitions.JOIN_STYLES` and `join_sfx` is `None` or `"whoosh"`;
  anything else raises `ValueError`;
- with `cold_open=None` both are ignored, and `_single_range_command` is untouched;
- with the defaults, the multi-range command is **byte-identical** to today (old behaviour for
  every existing caller and test).

Let `L0_ms = int(f"{length0:.3f}".replace(".", ""))` be the cold-open range length exactly as
written for `-t`, `L0 = f"{L0_ms // 1000}.{L0_ms % 1000:03d}"`, `W` = `0.100` or `0.150`, and
`Y, U, V` = `235, 128, 128` (white) or `16, 128, 128` (black). For a style other than `cut`, each
range's layout chain gets a suffix before its `[video<i>]` label:

```
range 0 (cold open):  <layout>,format=yuv420p,geq=lum='EXPR(lum,Y)':cb='EXPR(cb,U)':cr='EXPR(cr,V)':enable='gte(t,L0−W)'[video0]
range 1 (body):       <layout>,format=yuv420p,geq=lum='EXPR(lum,Y)':cb='EXPR(cb,U)':cr='EXPR(cr,V)':enable='lt(t,W)'[video1]

EXPR(plane, c) = st(0,A);floor((plane(X,Y)*(1000-ld(0))+c*ld(0)+500)/1000)
A (range 0)    = clip(floor(1000-1000*(L0-T)/W+0.5),0,1000)
A (range 1)    = clip(floor(1000-1000*T/W+0.5),0,1000)
```

Example, cold open of 2.002 s, `flash_white`, range 0:

```
…,format=yuv420p,geq=lum='st(0,clip(floor(1000-1000*(2.002-T)/0.100+0.5),0,1000));floor((lum(X,Y)*(1000-ld(0))+235*ld(0)+500)/1000)':cb='st(0,clip(floor(1000-1000*(2.002-T)/0.100+0.5),0,1000));floor((cb(X,Y)*(1000-ld(0))+128*ld(0)+500)/1000)':cr='st(0,clip(floor(1000-1000*(2.002-T)/0.100+0.5),0,1000));floor((cr(X,Y)*(1000-ld(0))+128*ld(0)+500)/1000)':enable='gte(t,1.902)'[video0]
```

- `T`/`t` are the range-local frame times (`setpts=PTS-STARTPTS` already starts each range at
  0). Legacy keeps the source's own frame grid, so it uses the same continuous `alpha(τ)` as
  §2.1, evaluated at its own frame times. On a CFR source at the document rate it gives the §2.2
  values within one frame (P-LOOK-JOIN, §5.4).
- `format=yuv420p` normalises the range to 8-bit TV range before `geq`. For the usual
  `yuv420p` source it is a no-op. For other formats it moves, to before the captions, the
  conversion that the encoder's `-pix_fmt yuv420p` already does.
- The captions and hook (`[joined]ass=…`) are drawn after `concat`, so on top of the effect, as in
  edit-v2.
- `geq` is evaluated only on the 2–5 frames per side that `enable` admits, with slice threads;
  T1 reports the render time.

### 4.4 legacy audio

With `join_sfx="whoosh"`, the whoosh file is one more input after the ranges (no `-ss`/`-t`):
`-i <RESOURCES_DIR>/sfx/whoosh/v1.wav`, checked by `transitions.sfx_file()` first. Its input
index is `len(ranges)`. The concat's audio label is renamed, and three chains follow:

```
[video0][audio0][video1][audio1]concat=n=2:v=1:a=1[joined][speech];
[speech]pan=stereo|FL=FL+FC|FR=FR+FC,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[sp];
[2:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,adelay=delays=<S0>S:all=1,apad[wh];
[sp][wh]amerge=inputs=2,pan=stereo|c0=c0+c2|c1=c1+c3[audio]
```

- `S0 = round(J_us·48/1000) − 11520`, with `J` the join: the later of `L0` and the cold open's
  measured end (`render._cold_open_join_s`, T1 decision 3), since concat pads the range's
  shorter stream and starts the body's picture and sound at `J`. For the 2.002 s example
  measured at 2.002000 s, `84576`; at 25 fps with `-ss 4.004` the range holds 51 frames, so
  `J` = 2.040 s and `S0` = `86400` (review of PR #23: `L0_ms·48 − 11520` put the hit 38 ms
  before the body).
- The per-range `afade` micro-fades are unchanged.
- The `pan` and `aformat` on the speech are explicit, so the mix never depends on FFmpeg's
  format negotiation:
  - a stereo 48 kHz source is unchanged (bit for bit);
  - other rates are resampled to 48 kHz;
  - a mono source is copied to both channels at 1.0 (edit-v2's `pan`), so it plays at the level
    of the clips of the same job without a cold open (a mono file plays at full level on both
    speakers). Review of PR #23: swresample's upmix (−3 dB per channel) made these clips 3 dB
    quieter.
- `amerge` + `pan` adds the two at unity (the sum `amix … normalize=0` gave). `amix …
  duration=first` drops the samples it still holds when its first input ends: on a test source
  the speech lost 21 ms at the tail, and 0.59 s once the `pan` changed the scheduling (FFmpeg
  6.1). `amerge` keeps the speech queued until the whoosh branch has the same samples, so the
  mix ends on the speech's last sample.
- Without a whoosh, the audio chains are byte-identical to today.
- The legacy duration check (±0.25 s) is unaffected.

### 4.5 Posters

`pipeline.thumbnail_time` takes the frame at 1.0 s, which can fall inside a flash when the cold
open is about 1 s long. The signature becomes `thumbnail_time(duration, avoid: tuple[float, float]
| None = None)`. `_render_v3_clips` passes `avoid = (L0 − 0.2, L0 + 0.2)` (seconds of the
rendered clip; 0.2 ≥ the dip's 0.15 s plus one frame) for clips with a teaser and a style other
than `cut`. When the default time falls inside `avoid`, the poster is taken at `L0 + 0.25`.
`write_clip_thumbnail(..., at=...)` receives that time.

## 5. Browser preview

### 5.1 Approach

- **Video:** a canvas fill in the player, drawn between the plate frame and the text.
  - Plates are per source frame and shared by every document of the clip and layout
    (`plate_key`). Burning the effect into them would make cells depend on the join, J and the
    style, and would break P-PLATE's meaning.
  - The fill is computed from the plan DTO, so it is current whenever the plan is. No new pending
    layer and no new badge state are needed.
- **Audio:** nothing new in the browser. The whoosh is in the server mix (the FLAC from
  `audio_preview`), which is already the player's clock. P-AUD covers it (§5.3).

### 5.2 Player (`web/lib/editor/player/`)

New pure module `join-layer.mjs`:

```js
/** Map<frame, {rgb: [r, g, b], alphaPm}> of a plan DTO's joins (missing joins = none). */
export function joinOverlays(joins = []) → Map
/** The fill of output frame n, or null. */
export function overlayAt(overlays, n) → { rgb, alphaPm } | null
/** Fills the whole canvas: save; globalCompositeOperation "source-over"; globalAlpha = alphaPm/1000;
 *  fillStyle = `rgb(r, g, b)`; fillRect(0, 0, width, height); restore. */
export function drawOverlay(ctx, overlay, width, height)
```

`player.mjs`:
- `validatePlan` accepts `dto.joins` absent or an array. Each entry must have:
  - `style` ∈ {cut, flash_white, dip_black};
  - `atF` a safe integer in `[0, totalFrames]`;
  - `rgb` `null` or three integers 0–255;
  - `alphaPm` an array of `[f, a]` with `f` strictly increasing in `[0, totalFrames)` and `a` in
    1–1000, empty when `rgb` is null;
  - `sfx` `null` or an object.

  Anything else throws `TypeError("invalid plan DTO: joins")`.
- `load()` builds the overlays once per DTO.
- `draw(n, …)`: the order becomes plate (`copy`) → `drawOverlay(c, overlayAt(overlays, n), w, h)`
  → text parts → logo. Nothing else in the presenter changes.
- `onFrame` gains `joinAlphaPm` (the alpha drawn for that frame, 0 when none). The parity harness
  reads it.
- `debug.joinAt(n)` returns `overlayAt(overlays, n)` for the harness.
- Modes:
  - `auto_render` (revision 0 exact) plays the auto MP4, which already holds the effect and the
    whoosh;
  - `truth` and `unsupported` show server frames, which hold it too.

`preview-client.mjs` passes the DTO through unchanged and needs **no change**. No server preview
code belongs to T2: the DTO field and the audio key are T1's (`preview_cli.py`).

### 5.3 Audio clock

The player starts the `AudioContext` at `smp(n)` of the server mix, so the whoosh plays at
`hitSmp` exactly as in the export. Changing the style keeps `mixSha256` (§1.5), so no new audio
loads. Toggling the whoosh changes `mixSha256` and goes through the existing swap rules
(`planChangeDecision`: pause while playing, reload while paused, "Menyiapkan audio…").

### 5.4 Gates (definitions; T1 writes them into GATES.md, thresholds never weakened)

Existing gates keep their cases and numbers. Their documents keep `cut` joins and no sfx, because
P-FRAME and P-PLATE read barcodes and plate pixels that a fill would cover on purpose. The new
gates cover what a transition adds:

| Gate | What is compared | Threshold | Cases | When | Owner |
|---|---|---|---|---|---|
| **P-JOIN** (server) | `reference` render of a transition document vs the same document with `cut`, both decoded to RGB with the BT.709 matrix (`_PNG_DECODE`'s conversion) | (a) every frame outside the window: framemd5 identical; (b) inside: every pixel within 3 levels of `blend(cut, alpha)` per channel, mean abs ≤ 1.0; (c) per frame, the alpha estimated by least squares over pixels with \|C − cut\| ≥ 32 within 10 per mille of the plan; (d) frame count, sample count and ASS sha equal to the cut document's; exactly `len(alpha)` `lutrgb` in the graph | 10 cases: 5 rates × 2 styles over the barcode sources of `frame_identity` (cold open at 300 frames, 20 cuts; 29.97 with the hook). Smoke: 29.97 `flash_white` only | PR (smoke), nightly (full) | T1 |
| **G-WHOOSH** (server audio) | s16 `reference` PCM of a whoosh document minus that of the same document without it | outside `[start_smp, start_smp+samples)`: **0** on every sample; inside: \|diff − whoosh\| ≤ 1 LSB, ≥ 99.9 % of samples exactly equal; the largest 10 ms of diff starts within ±480 samples of `hit_smp − 240` | 29.97 `flash_white`+whoosh, 25 `dip_black`+whoosh, 29.97 `cut`+whoosh, 29.97 whoosh with ducked music | PR (smoke: the first), nightly | T1 |
| **P-AUD** (server, new case) | `audio_preview` FLAC PCM vs `reference` PCM of a whoosh document | md5 equal, samples == plan | 29.97 `flash_white`+whoosh | PR | T1 |
| **P-LOOK-JOIN** | legacy vs edit-v2 auto renders of the same clip, each against its own `cut` render: the per-frame alpha each engine applied, and the whoosh onset | per-frame alpha within 0.05 at the best offset in ±1 frame; whoosh onset (cross-correlation of each engine's PCM difference with the WAV) within 2 ms; whole-clip loudness within 0.5 LU (P-LOOK's number) | synthetic `main` job clip 1 (29.97 CFR, fit-blur), a 25 fps and a 60 fps (legacy 60 vs edit-v2 30) fixture | nightly | T1 |
| **R10 / P-RT** (new fixture jobs) | as today | P-RT framemd5 and PCM md5 identical; R10 hard link 100 % | `main` (edit-v2, now flash+whoosh), `old` (legacy, pre-transition: cut, no manifest key), new `legacy_new` (legacy with flash+whoosh, prepared afterwards) | PR (r10), toolchain/nightly (rt) | T1 |
| **P-JOIN-B** (browser) | (a) the player's `joinAlphaPm` for every frame of `[J−before−2, J+after+2)` vs the plan; (b) the canvas vs the server composite of the same frame (decoded plate frame + `lut_chain` + `ass` [+ logo], before 4:2:0); (c) the AudioBuffer of the whoosh mix vs the reference PCM | (a) **0 mismatches**; (b) P-TXT's numbers (SSIM ≥ 0.999, PSNR ≥ 45 dB, max ≤ 16, 0 px > 16) and \|mean diff\| ≤ 1.0 per channel; (c) ≤ 1 LSB, same length | 29.97 `flash_white`+whoosh fit-blur with the hook; 25 `dip_black` center-crop; 23.976 `flash_white` with a logo | nightly (ci-cd parity job) | T2 |
| **G-DET** | unchanged rule, plus the 29.97 transition document | identical plan, ASS, graph and envelope across 3 processes | | PR | T1 |

Every other gate (P-FRAME, P-PLATE, P-TIME both sides, P-TXT, P-ENC, P-COLOR, P-LOGO, P-SYNC,
G1–G3b, G-CLICK, duck, PF-*) must stay green unchanged. They reach the transition through the
argument in §2.4: the source frame and the text of a transition frame are the cut document's,
which those gates already prove.

## 6. Seed, R10 and the pipeline

### 6.1 What records the join of an auto render

- **Manifest clip field** `cold_open_join`, written by `pipeline._render_v3_clips` for every clip
  whose auto render has a cold open (teaser not `None`), whichever engine rendered it:
  `"cold_open_join": {"style": "flash_white", "sfx": {"id": "whoosh", "v": 1}}` (`"sfx": null`
  when off).
  - It is absent on clips without a cold open and on every manifest written before this change.
  - The web's manifest sanitiser (`web/lib/jobs.mjs`) whitelists keys and drops it. No web change
    is needed.
- **Seed context key** `coldOpenJoin` in `seed.build_seed`'s `job` mapping, with the same JSON.
  Missing (every existing caller) means `cut` without sfx, so every existing seed test and golden
  is unchanged.
  - When the seed keeps the cold open, the join is
    `{"after": "seg_co", "style": <style>, "audio_fade_ms": 30}` plus `"sfx"` when it is on.
  - When the seed drops an invalid teaser there is no join at all, as today.
- `transitions.ColdOpenJoin(style: str, sfx: str | None)` provides:
  - `to_json()` → `{"style": <style>, "sfx": {"id": "whoosh", "v": 1} | null}` (the manifest
    and seed-context form) and `from_json(value) -> ColdOpenJoin | None` (strict: exactly those
    two keys, a known style, and an sfx that is `null` or the whoosh pair; anything else →
    `None`);
  - `doc_join(after, audio_fade_ms) -> dict`;
  - the constants `AUTO_COLD_OPEN_JOIN = ColdOpenJoin("flash_white", "whoosh")` and
    `CUT_JOIN = ColdOpenJoin("cut", None)`.
- **prepare** (`seed.prepare_legacy_job` → `_prepare_clip`) reads `output/manifest.json`
  (≤ 16 MiB, strict JSON) once per job.
  - It maps each entry to its clip id with `clip_id(source_content_sha256, start_ms, end_ms,
    cold_open_ms)`, the rule of `render_edit._manifest_clip_id`, ported or shared through a small
    helper in `clip_id.py`.
  - The seed of that clip gets `coldOpenJoin` from the entry's `cold_open_join` when
    `from_json` accepts it. Otherwise (absent, malformed, or no manifest) it gets `CUT_JOIN`.
  - So an old legacy clip seeds a cut, and a new one seeds the join it was rendered with.

### 6.2 Pipeline wiring (both engines)

- `pipeline._render_v3_clips(..., cold_open_join: ColdOpenJoin | None)`. `run_pipeline` (V3)
  passes `AUTO_COLD_OPEN_JOIN`. `None` is "the pipeline before this change": cut, no whoosh, no
  manifest key. It exists only for fixtures (make_job's `old`).
- **legacy:** `render_vertical(..., cold_open=teaser, join_style=j.style,
  join_sfx=j.sfx)`, then the manifest field when `teaser` is not `None`.
- **edit-v2:**
  - `render_edit.AutoOptions` gains `cold_open_join: ColdOpenJoin = CUT_JOIN` (last field,
    defaulted, so existing constructions keep cuts), and `AutoOptions.job()` adds
    `"coldOpenJoin"`;
  - the seed carries the join and the clip renders **from the seed file**, as today;
  - the manifest field comes from the seed's join (none when the seed dropped the teaser);
  - a per-clip `engine_fallback` renders the same join through legacy and records it.
- `pipeline.render_v3_job(..., cold_open_join: ColdOpenJoin | None = AUTO_COLD_OPEN_JOIN)`, for
  the tools (P-LOOK kit, make_job).
- `run_pipeline` has no CLI flag for the join: the default is always on (latest only).

### 6.3 R10 for every kind of clip

| Clip | Seed's join | Auto file | Unchanged export |
|---|---|---|---|
| Rendered before this change, legacy, not yet prepared | prepare: no manifest key → `cut` | cut | hard link to the cut file ✓ |
| Rendered before this change, seed already written (either engine) | `cut` (immutable) | cut | hard link ✓ |
| New, legacy (production default) | prepare: manifest key → flash+whoosh, engine `legacy` | flash+whoosh (legacy) | hard link ✓ (legacy contract). Preview: plates + fill + server mix, within P-LOOK of the file (the existing `legacy_engine` notice applies) |
| New, edit-v2 | pipeline seed: flash+whoosh, engine `edit-v2/1` | rendered from that seed | hard link ✓, `rev0.exact` ✓ (the manifest's `plan_sha256` is the seed's) |
| New, edit-v2 with `engine_fallback` | seed removed (`AutoRenderer.fallback`); prepare later reads the manifest key | flash+whoosh (legacy) | as "new, legacy" ✓ |

Since the seed is immutable, `ResetToSeed` ("Kembali ke versi AI") always goes back to the join
the auto file has.

## 7. Editor UI

### 7.1 Cold open panel (`web/components/editor/panels/ColdOpenPanel.jsx`)

A new section **"Transisi"** sits right after the cold-open card and before "Saran cold open".
It is always rendered: enabled when a cold open exists and the clip is not read-only, disabled
otherwise.

```
Transisi
<note>  cold open on:   "Efek di sambungan cold open ke awal klip. Durasi klip tetap."
        cold open off:  "Aktifkan cold open dulu."
fieldset  legend "Efek gambar"   three radio cards (native <input type="radio">, one name)
   ( ) Potong langsung   · Tanpa efek
   ( ) Kilat putih       · 0,2 dtk
   ( ) Gelap sebentar    · 0,3 dtk
switch    "Suara whoosh"         (<input type="checkbox" role="switch">)
button    "Putar transisi"
status    "Transisi: Kilat putih." / "Whoosh aktif." / "Whoosh mati."   (role="status")
```

- Replace the cold-open note "Potongan singkat (0,5–8 dtk) yang diputar lebih dulu, lalu klip
  mulai dari awal. Sambungannya potong langsung dengan fade audio 30 ms." with "Potongan singkat
  (0,5–8 dtk) yang diputar lebih dulu, lalu klip mulai dari awal."
- The radio cards reuse the MusicPanel duck-preset pattern (`.presets`/`.preset`, the `cover`
  radio from `panels.module.css`):
  - the checked card has a `--text` border on `--surface-3`, not lime (DESIGN.md: one accent,
    used sparingly);
  - `ColdOpenPanel.module.css` stays **token-only** (`web/tests/editor-markers.test.mjs`
    rejects literal colours, so no white/black swatches written as literals).
- **Putar transisi** plays `[max(0, J − ⌈F⌉), min(total, J + ⌈F⌉))` with the panel's existing
  `useAudition` (seek, play, pause at the end). `J` is the sum of the cold open's piece frames
  (`web/lib/editor/timemap.mjs` `pieces(doc)`), so it needs no DTO.
- The view model is the new pure module `panels/coldopen-transition.mjs`, so the panel stays
  thin:
  `transitionView(doc, { readOnly })` → `{ enabled, reason, style, sfxOn, joinFrame }`.
  `reason` is "Aktifkan cold open dulu." or "Klip ini sedang dalam mode baca-saja".
- **A11y:**
  - a `fieldset` and `legend`, and native radios (arrow keys move inside the group);
  - the switch has a visible label;
  - disabled controls carry `aria-describedby` pointing to the reason note, plus a `title`;
  - the status line is a polite live region;
  - the focus ring comes from the existing `:has(input:focus-visible)` rule;
  - no animation, so `prefers-reduced-motion` needs nothing.

  The implementer announces `antislop active: during (project setting).` and follows DESIGN.md
  and the antislop UI, copy and human skills.

### 7.2 Commands (`web/lib/editor/commands.mjs`, Appendix B additions)

| Command | Args (normalised) | Precondition → code | Effect | `defaultMergeKey` |
|---|---|---|---|---|
| `SetJoinStyle` | `{ style }` | cold open exists → `cold_open_missing`; style ∈ JOIN_STYLES → `value_out_of_range` | `joins[0].style = style` (other keys kept) | `null` (each choice is one undo step) |
| `SetJoinSfx` | `{ on }` (boolean) | cold open exists → `cold_open_missing`; `on` boolean → `invalid_args` | on: `joins[0].sfx = {id: "whoosh", v: 1}`; off: **delete** the key | `null` |

- **`SetColdOpen` keeps the transition.** When a join exists, its `style` and `sfx` carry over
  to the new range. When none exists (no cold open before), the template is:
  - the **seed's** join `style`/`sfx` when the seed has a cold open;
  - otherwise `AUTO_JOIN = { style: "flash_white", sfx: { id: "whoosh", v: 1 } }`.

  So removing and re-adding the seed's own cold open gives content equal to the seed (R10). The
  existing test "SetColdOpen builds the cold open from bounds with a 30 ms cut join" (C25: the
  seed has no cold open) changes its expected join to `flash_white` + whoosh. This is the owner
  decision applied, not a weakened test, and a new test pins the C30 case (the seed's cut kept).
- `NudgeColdOpen`, `SetColdOpen(null)` and `ResetToSeed` are unchanged. Removing the cold open
  empties `joins`, which drops the whoosh too.
- `COMMANDS` gains `"SetJoinStyle", "SetJoinSfx"` right after `"NudgeColdOpen"` (37 commands).
  `web/components/editor/__dev__/fakes.mjs` gets the same list and a fake DTO `joins` (a
  dev-only port of §2.1).
- `doc-model.mjs`:
  - exports `JOIN_STYLES = ["cut", "flash_white", "dip_black"]`,
    `SFX_WHOOSH = { id: "whoosh", v: 1 }`, `AUTO_JOIN` and `joinTemplate(doc, seed)` (the
    SetColdOpen rule, shared with rebase);
  - `checkDoc` accepts a join whose keys are within `{after, style, audio_fade_ms, sfx}`, whose
    style is in `JOIN_STYLES`, and whose `sfx` is absent or deep-equal to `SFX_WHOOSH`.
    Anything else is `cold_open_invalid` at `/main/joins`, as today.
- Undo, autosave and drafts need nothing new: every command is an ordinary history entry and
  autosave PUTs the whole document. The preview re-plans on the new document. A style change
  keeps the mix; a whoosh toggle rebuilds it (§5.3).

### 7.3 Two-tab merge (`web/lib/editor/rebase.mjs`)

- `PARTS`: insert `"join.style", "join.sfx"` right after `"coldopen"`, so the cold open is set
  before them.
- `partValue`: `join.style` → `joins[0]?.style ?? null`; `join.sfx` → `joins[0]?.sfx ?? null`.
- `PREREQUISITES`: both need `"coldopen"`.
- `setPart`:
  - `"coldopen"` builds the join from the current join if one exists, else `joinTemplate`;
  - `"join.style"` sets the style; `null` changes nothing; no cold open → `cold_open_missing`;
  - `"join.sfx"`: an object sets the key and needs a cold open (`cold_open_missing`); `null`
    deletes the key (nothing to do without a cold open).
- `GROUP_LABELS.join = "Transisi cold open"`. `describe(doc, "join")` gives "Potong langsung",
  "Kilat putih" or "Gelap sebentar", with " + whoosh" appended when the whoosh is on.
- Result: tab A picks a style while tab B trims the cold open, and both merge. Both tabs picking
  styles show one conflict, "Transisi cold open". A tab that set a style after the other tab
  removed the cold open gets the existing grouped conflict with its prerequisite.

### 7.4 Guide

`docs/editor/PANDUAN-EDITOR.md` §2, under **Cold open (tab)**, gains one paragraph:
- the three choices and the whoosh toggle;
- auto clips get Kilat putih + whoosh;
- old clips stay a plain cut;
- the clip's duration and captions do not move.

## 8. Test plan per task

Locally: only targeted tests for the files changed, plus at most a few single-clip FFmpeg runs.
Everything heavy runs on GitHub Actions:

```
gh workflow run editor-gates.yml -f ref=<branch> -f suite=full|image|command [-f command='…']
gh run list --workflow editor-gates.yml --branch <branch> --limit 1
gh run watch <id> --exit-status ; gh run view <id> --log-failed ; gh run download <id>
gh workflow run ci-cd.yml --ref <branch> -f suite=nightly|toolchain
```

Before every push, scan with main's gitleaks config (`.gitleaks.toml`, mounting the main repo's
`.git` for a worktree). The 64-hex shas of `v1.meta.json` and the new evidence may need a
content allowlist entry in `.gitleaks.toml` (T1 only).

### T1 (Python engine)

- New `tests/test_edit_v2_transitions.py`:
  - the §2.2 table verbatim, plus `before`/`after` and the 200/300 ms support;
  - clamping at the clip edges;
  - `lut_chain` against the §4.1 example string;
  - `joins_dto`;
  - `ColdOpenJoin` round trip and rejection;
  - the whoosh file: 48 kHz, 2 ch, 16-bit, 20 160 frames, peak exactly `meta.peak`, the loudest
    10 ms within ±480 samples of 11 280, the first and last 96 samples ramped, sha = pin = meta;
  - `make_whoosh.py --check` (in process, stdlib).
- `tests/test_edit_v2_doc.py` and the generated fixtures (`tests/support/edit_v2_fixtures.py`,
  `tests/fixtures/edit_v2/docs/{valid,invalid}`, `index.json`):
  - valid: `flash_white`, `dip_black`, `cut`+sfx, `dip_black`+sfx;
  - invalid: `xfade` → `op_disabled`, `"fade"` → `range_invalid`, `sfx: null` →
    `range_invalid`, `{"id": "pop", "v": 1}` and `{"id": "whoosh", "v": 2}` → `sfx_unknown`,
    an extra key → `unknown_key`, a missing `v` → `range_invalid`, a flash join without a cold
    open → `cold_open_invalid`.
- `tests/test_edit_v2_contracts.py`: `sfx_unknown` is in the code set and has a message; the
  `RenderPlan.joins` field; the `transitions` names of §1.6, §3.4 and §6.1.
- `tests/test_edit_v2_plan.py`:
  - **every pre-existing fixture plan sha is unchanged**;
  - `"joins"` is in the plan JSON only when a transition or sfx exists;
  - §2.4: a transition plan equals the cut plan except `joins` and the sha.
- `tests/test_edit_v2_compile.py` and `tests/fixtures/edit_v2/goldens/`:
  - every existing golden is byte-identical;
  - new goldens `final__flash_whoosh__c30.txt`, `frame__dip__c25.txt`,
    `reference__flash__c24.txt`, `audio_preview__whoosh_music__c30.txt`,
    `audio_measure__whoosh_music__c30.txt`;
  - `lut_chain` raises for a non-`gbrp` composite.
- `tests/test_edit_v2_audio_graph.py`: the whoosh sidecar name, bytes and options; the input
  order; `mix_sha256` changes with the whoosh and stays the same without it; the
  `amix inputs=2/3` texts; `skip_smp > 0` (synthetic plan).
- `tests/test_edit_v2_seed.py`:
  - the `coldOpenJoin` key (and its absence = cut);
  - prepare with a manifest that has, lacks, or garbles `cold_open_join`;
  - the matching by clip id.
- `tests/test_edit_v2_preview_cli.py`:
  - the DTO `joins` shape (and `[]`);
  - `audio_key` is the same for a cut document as today, differs with the whoosh, and is the
    same for `flash_white` vs `dip_black` with the same sfx;
  - the `_rev0_identity` sfx entry.
- `tests/test_edit_v2_render_edit.py`: `AutoOptions.cold_open_join` reaches the seed; R10 for
  old and new seeds (the §6.3 matrix) with stub files.
- `tests/test_render.py`:
  - with the defaults, the multi-range argv is byte-identical (golden);
  - the `join_style`/`join_sfx` strings for both styles;
  - `ValueError` for bad values;
  - **one** small synthetic render (360×640, 2 s cold open): the luma of the first body frame
    ≈ 235 (white) and the audio duration within ±0.25 s.
- `tests/test_pipeline_v3.py`:
  - `cold_open_join` only on clips with a teaser;
  - `render_vertical` gets `join_style`/`join_sfx`;
  - the poster `avoid` rule;
  - `cold_open_join=None` keeps the old manifest shape.
- Parity tooling:
  - new `scripts/parity/join_gates.py` (`p-join`, `g-whoosh`, `look`, `smoke`, `all`), built on
    `frame_identity`'s `Workspace`;
  - `frame_identity.py`: `Case.join_style: str = "cut"`, `Case.whoosh: bool = False`, and
    `make_doc(..., join_style="cut", whoosh=False)`;
  - `ci_gates.py`: `REQUIRED["smoke"] += ("P-JOIN", "G-WHOOSH")`;
    `REQUIRED["full"] += ("P-JOIN", "G-WHOOSH", "P-LOOK-JOIN", "P-JOIN-B")`;
  - `run_all.sh`: section `join` in smoke (`join_gates.py smoke`) and full (`join_gates.py
    all`);
  - `scripts/editor_fixture/make_job.py`: `old` passes `cold_open_join=None`, and a new
    `legacy_new` job; `rt_check.py` only if a case needs it.
- CI:
  - `editor-gates.yml` `suite=full` (ruff, pytest 3.11, web);
  - `suite=image` (pytest in the pinned image, FFmpeg 5.1.9, which re-verifies the probe
    results);
  - `suite=command`, `command='OUT=/out sh scripts/parity/run_all.sh smoke'`, then
    `command='OUT=/out sh scripts/parity/run_all.sh full join rt frame audio'`;
  - after the integration merge, `ci-cd.yml -f suite=nightly`.
- Evidence: `docs/editor/evidence/TR/T1-{P-JOIN,G-WHOOSH,P-LOOK-JOIN,P-AUD,R10,P-RT,G-DET,PF-RENDER}.json`
  (numbers only, from the downloaded artifacts).
- Docs:
  - `docs/editor/CONTRACTS.md`: §3.3 joins row, §3.5 seed row, §3.7 codes, §3.8 amendment, §4.3
    DTO `joins`, and a new **§5.26 "Cold-open transition"** holding §1.6, §3.4, §6.1 and §7.2–7.3
    of this spec (the command and part names T3 implements);
  - `docs/editor/GATES.md`: a new section "Transisi cold open" with §5.4's table and the
    numbers. The P-JOIN-B row is filled from T2's evidence at integration;
  - `docs/editor/OPERASIONAL.md` §2: the rollback note of §1.4.

### T2 (browser preview)

- New `web/tests/editor-player-join.test.mjs`: `joinOverlays`/`overlayAt` on the §1.6 example;
  `drawOverlay` call order and values on a recording fake context (`globalAlpha` 0.333/1, fill
  colour, restore).
- `web/tests/editor-player-player.test.mjs`:
  - the draw order plate → overlay → text → logo (recording context);
  - no overlay outside `alphaPm` or with `joins` missing;
  - `onFrame.joinAlphaPm`;
  - `validatePlan` rejects malformed `joins` (unsorted frames, alpha 0 or 1001, `rgb` with
    alphas missing, a frame ≥ totalFrames);
  - a style-only DTO change redraws the paused frame without reloading audio (same
    `mixSha256`).
- Harness:
  - `web/app/parity-harness/player/*`: open the join variants, read back `joinAlphaPm` and
    composites;
  - `web/e2e/editor-player.spec.mjs`: test `P-JOIN-B` (§5.4);
  - `scripts/parity/player_fixtures.py`:
    - `generate --only join` builds the three P-JOIN-B cases with `frame_identity.make_doc(...,
      join_style=..., whoosh=...)`, the DTO `joins` from `transitions.joins_dto`, and the server
      composites with `transitions.lut_chain`, restamping the probe frame to `pts = n`,
      `settb=den/num` before it;
    - `score` and `evidence --label CI` write `CI-P-JOIN-B.json`.
- `.github/workflows/ci-cd.yml` parity job, nightly and `suite=nightly` only:
  - a step generating the join player fixtures into `$PARITY_OUT/ptxt/player` inside
    `parity-tools` (the app container already serves that directory read-only);
  - `npx playwright test e2e/editor-player.spec.mjs --project=desktop-chromium -g "P-JOIN-B"`;
  - the scoring/evidence command before `summary`.
- Local: `cd web && node --test tests/editor-player-join.test.mjs tests/editor-player-player.test.mjs tests/editor-player-presenter.test.mjs`.
- CI: `editor-gates.yml suite=full` (web tests and build). After T1 is merged into the integration
  branch, `ci-cd.yml -f suite=nightly` (the browser gate needs T1's engine for the fixtures).
- Evidence: `docs/editor/evidence/TR/T2-P-JOIN-B.json`.

#### Decisions during build (T2)

Where the spec was silent, T2 chose as follows (branch `transisi-t2`, the name the run was
given, instead of `transisi-t2-preview`):

1. **DTO validation** (`join-layer.joinsValid`, called by `validatePlan`). Beyond §5.2's list:
   - `rgb` is `null` exactly for `cut`, and `alphaPm` is non-empty exactly when `rgb` is set (the
     §1.6 shape; "rgb with alphas missing" is refused);
   - a frame may be claimed by one join only (one fill per frame; Essentials has one join);
   - an absent `sfx` reads as `null`: it is informational and the player never uses it.
2. **Player.** `onFrame.joinAlphaPm` is sent with every live frame the player draws. The
   `auto_render` frame events keep their shape: the auto MP4 holds the effect and the player
   draws nothing there. `debug.joinAt(n)` returns the frozen overlay `{rgb, alphaPm}` or `null`.
3. **The blend is exact, not a `globalAlpha` fill (amends §2.3's browser line and §5.2's
   `drawOverlay`).**
   - The first P-JOIN-B run (pre-integration, run 36964783673) used §5.2's
     `fillRect` at `globalAlpha = a/1000`. Max differences were ≤ 3, PSNR ≥ 52.9 dB and |mean|
     ≤ 0.32 on every frame. Five `dip_black` frames still failed SSIM ≥ 0.999 (0.982–0.9988):
     Skia rounds through an 8-bit alpha, and on dark content SSIM's luminance term punishes the
     resulting ±1. Unblended frames matched the server apart from the text.
   - So `drawOverlay` now reads the plate frame back (`getImageData`), maps R, G and B through
     the export's own `⌊(p·(1000 − a) + C·a + 500) / 1000⌋` (a 256-entry table per channel) and
     writes it back (`putImageData`), still between the plate and the text. The threshold is
     unchanged.
   - The cost falls only on the frames of the window (5–9 per clip). P-JOIN-B records the seek
     time of blended frames and the drops while playing through the join, without gating them.
4. **P-JOIN-B cases** (`player_fixtures.JOIN_CASES`, `generate --only join`): `join_29.97`
   (`flash_white` + whoosh, fit-blur, hook), `join_25` (`dip_black`, `fill_center`) and
   `join_23.976` (`flash_white`, fit-blur, 5 cuts, the P-LOGO logo at top right). All use the
   `frame_identity` barcode sources at 720×1280, the harness canvas size. The documents are built
   by `player_fixtures.join_document`, which calls `frame_identity.make_doc(..., join_style=…,
   whoosh=…)` itself, so the cases do not depend on `Workspace.clip` reading `Case.join_style`.
   The generator refuses a plan that lost the transition (`transition_of`), and a DTO whose
   `alphaPm` is not the plan's alpha.
5. **What each part measures.**
   - (a) runs on every frame of `[J − before − 2, J + after + 2)`. It compares
     `onFrame.joinAlphaPm`, `debug.joinAt` and the `rgb` with the plan. It also runs a
     one-frame-late control, as P-TIME does, which must flag every change of the plan.
   - (b) takes every filled frame plus the unfilled frame on each side (7, 9 and 7 frames). The
     mean difference is signed, per channel, over the whole frame. The text region is the union
     of where the composite differs from the same frame without text (the whole frame when no
     text is drawn).
   - (c) runs only on the case with the whoosh, through the existing `audioCheck`.
   - The cases without the whoosh get the plate cells of frame 0 and of the window only. The
     whoosh case is also played through the join, so it gets every cell, the mix and the
     reference PCM.
6. **Scoring and evidence.**
   - The spec runs `player_fixtures.py score --join` on the host `python3`, as P-TXT does, and
     merges the scores into `p_join_b.json`.
   - `evidence` takes `--label` (an alias of `--task`) and `--gate` (repeatable, to write only
     some gates). The parity job runs `evidence --label CI --gate P-JOIN-B` in `parity-tools`
     before `summary`.
7. **CI.** The two new steps run when `SUITE` is `full` (the schedule and `suite=nightly`).
   `Decide` also requires the P-JOIN-B step, and the player results
   (`browser/player/*.json`) are kept with the evidence.
8. **Python tests.** The tests of `player_fixtures.py` live in the existing
   `tests/test_parity_player_fixtures.py`. That file belongs to `player_fixtures.py` (GATES.md
   T2.4) and is not in T1's list. The one test that needs T1's engine (the cases' plans and DTO
   against the §2.2 table) uses `pytest.importorskip("ai_clipper.edit_v2.transitions")`: it is
   skipped on `transisi-t2` and runs on the integration branch.
9. **Evidence file.** `T2-P-JOIN-B.json` is the `CI-P-JOIN-B.json` of a run made before
   integration, with `task` set to `T2` and the run recorded in it:
   - run 36965911172, on the throwaway branch `transisi-t2-joincheck` (T1 `dd41aeb` merged with
     T2 `ce621f0`);
   - `frame_identity.make_doc`'s join arguments were a stand-in written to §8, and the parity job
     ran only the image sections that P-JOIN-B needs.

   The integration branch's `ci-cd.yml -f suite=nightly` measures it again as
   `CI-P-JOIN-B.json`. Use that run's numbers for GATES.md.

### T3 (editor UI)

- `web/tests/editor-commands.test.mjs`:
  - `SetJoinStyle`/`SetJoinSfx` happy paths and rejections;
  - SetColdOpen keeps the style and sfx when replacing, and uses the template rule when creating
    (C25 → auto join; C30 with its seed's cut → cut);
  - removing and re-adding the seed's cold open is content-equal to the seed;
  - `COMMANDS.length === 37`, equal to the fakes;
  - `checkDoc` rejects `xfade`, `sfx: null` and other sfx values.
- `web/tests/editor-rebase.test.mjs`:
  - parts, prerequisites and labels;
  - the merges of §7.3 (style vs trim merges; style vs style conflicts; style after the other
    tab's removal gets the grouped conflict);
  - `__parts` replay determinism.
- New `web/tests/editor-coldopen-transition.test.mjs`: `transitionView` (enabled, reason, style,
  sfx, `joinFrame` = Σ cold-open piece frames).
- `scripts/edit_v2/crosscheck_commands.mjs`: add both commands to `GENERATORS` with weights
  (SetJoinStyle 3, SetJoinSfx 2) and to the two-tab sequences. It runs through
  `tests/test_edit_v2_crosscheck.py` in pytest and passes only with T1's validator, so check it
  on the integration branch.
- New e2e `web/e2e/editor-transition.spec.mjs` on the editor fakes (as `editor-music.spec.mjs`):
  - choose each style and toggle the whoosh, checking the dispatched commands, replayed through
    the real `commands.mjs`;
  - disabled with "Aktifkan cold open dulu." when the cold open is off;
  - keyboard (Tab into the group, arrows between styles, Space on the switch);
  - axe with no violations;
  - Putar transisi seeks to `J − ⌈F⌉`.
- `.github/workflows/editor-gates.yml`: a new choice `suite=e2e`.
  - On the runner: Node 20, `npm ci`, `npm run build`, Chrome for Testing 147.0.7727.15 (the
    parity pin, installed as in ci-cd.yml).
  - `next start` with `POTONGIN_EDITOR_V3=on`, `POTONGIN_EDITOR_FAKES=1` and throwaway
    credentials (masked).
  - `E2E_EDITOR_FAKES=1 npx playwright test <command> --project=desktop-chromium`, where
    `command` names the spec file(s).
- Local: `cd web && node --test tests/editor-commands.test.mjs tests/editor-rebase.test.mjs tests/editor-coldopen-transition.test.mjs tests/editor-markers.test.mjs`.
- CI: `editor-gates.yml suite=full`, then
  `editor-gates.yml -f suite=e2e -f command='e2e/editor-transition.spec.mjs'`.
- Docs: `docs/editor/PANDUAN-EDITOR.md` (§7.4).

## 9. The three tasks

Each task branches from `transisi-spec` (this commit): `transisi-t1-engine`,
`transisi-t2-preview`, `transisi-t3-ui`. They merge into `transisi-integrasi` in the order T1,
T2, T3. File ownership is disjoint, so there are no conflicts. Then the integration runs every
suite and opens one PR to `main` (never pushed to `main`, never force-pushed, never merged by an
agent).

### T1 — Python engine (owns)

- `src/ai_clipper/edit_v2/transitions.py` (new): `JOIN_STYLES`, `DISABLED_JOIN_STYLES`,
  `HALF_WIDTH_MS`, `RGB`, `YUV_TV`, `SfxSpec`, `SFX`, `SfxPlan`, `JoinPlan`, `ColdOpenJoin`,
  `AUTO_COLD_OPEN_JOIN`, `CUT_JOIN`, `alpha_pm`, `join_alpha`, `plan_joins`, `lut_chain`,
  `joins_dto`, `sfx_file`, `load_sfx_pcm`. Stdlib only; it imports only `timemap`, `errors` and
  `glyphs.RESOURCES_DIR` (never `plan`, `compile_ffmpeg` or `render`, so `render.py` can import
  it without a cycle).
- `src/ai_clipper/edit_v2/{doc,errors,seed,plan,compile_ffmpeg,audio_graph,preview_cli,render_edit,clip_id}.py`
- `src/ai_clipper/render.py`, `src/ai_clipper/pipeline.py`
- `resources/sfx/whoosh/v1.wav`, `resources/sfx/whoosh/v1.meta.json`, `scripts/sfx/make_whoosh.py`
- `scripts/parity/{join_gates.py (new), frame_identity.py, ci_gates.py, run_all.sh, rt_check.py}`,
  `scripts/editor_fixture/make_job.py`
- Every Python test and fixture listed in §8 T1 (`tests/**`), and `.gitleaks.toml` if needed
- `docs/editor/{CONTRACTS.md, GATES.md, OPERASIONAL.md}`, `docs/editor/evidence/TR/T1-*.json`

### T2 — browser preview (owns)

- `web/lib/editor/player/join-layer.mjs` (new), `web/lib/editor/player/player.mjs`
- `web/tests/editor-player-join.test.mjs` (new), `web/tests/editor-player-player.test.mjs`
- `web/app/parity-harness/player/*`, `web/e2e/editor-player.spec.mjs`
- `scripts/parity/player_fixtures.py`
- `.github/workflows/ci-cd.yml`
- `docs/editor/evidence/TR/T2-P-JOIN-B.json`
- Server preview code: **none**. `web/lib/editor/preview-client.mjs` is unchanged. The DTO is
  produced by T1's `preview_cli.py`.

### T3 — editor UI and the JS document model (owns)

- `web/lib/editor/{doc-model,commands,rebase}.mjs`
- `web/components/editor/panels/{ColdOpenPanel.jsx, ColdOpenPanel.module.css, coldopen-transition.mjs (new)}`,
  `web/components/editor/__dev__/fakes.mjs`
- `scripts/edit_v2/crosscheck_commands.mjs`
- `web/tests/{editor-commands,editor-rebase}.test.mjs`, `web/tests/editor-coldopen-transition.test.mjs` (new),
  `web/e2e/editor-transition.spec.mjs` (new)
- `.github/workflows/editor-gates.yml`
- `docs/editor/PANDUAN-EDITOR.md`

### Decisions during build (T3)

Where §7 and §8 were silent or would not hold as written, T3 chose the option closest to FINAL and
CONTRACTS:

1. **`joinTemplate(doc, seed)` is the whole SetColdOpen rule**: the current join, else the seed's
   join when the seed has a cold open, else `AUTO_JOIN`. It returns `{ style, sfx }` (sfx
   `{id, v}` or `null`) as fresh objects. `doc-model.mjs` also exports `coldOpenJoin(after,
   audioFadeMs, template)` (the document join, with no `sfx` key when silent) and
   `JOIN_STYLE_NAMES` (Potong langsung, Kilat putih, Gelap sebentar), so commands, rebase and the
   panel build and name joins one way.
2. **Command details.** Both commands check the cold open first (`cold_open_missing`). Any style
   outside `JOIN_STYLES`, a non-string or a missing one included, is `value_out_of_range` (as
   SetLayout). `SetJoinSfx {on: false}` on a silent join changes nothing, so it adds no history
   entry.
3. **The change detector of `join.sfx` tells "no cold open" from "cold open without whoosh".**
   `partValue` stays as §7.3 says (`joins[0]?.sfx ?? null`), but `identity()` (what `diffParts`
   compares) is `null` without a cold open and `{ sfx: <value or null> }` with one. Without this, a
   cold open whose whoosh was switched off, rebuilt from parts (an undo past a save, a conflict
   resolution), would get the template's whoosh back on clips whose seed has no cold open: the
   existing "applyParts reconstructs a document exactly" property fails on c25.
4. **"Pakai punyaku" for a cold open brings its own transition.** When one side has a cold open and
   the other has none and the `coldopen` group conflicts, `join.style`/`join.sfx` that differ join
   that group (as `removals:cold_open` does), so restoring mine restores its style and whoosh, not
   the template's. `checkConflictScenario` allows `join.*` in the `coldopen` group.
5. **Panel.** The reason is read-only first, then "Aktifkan cold open dulu.". "Putar transisi"
   stays enabled in read-only when a cold open exists (playing is not editing, like "Putar cold
   open") and reads "Hentikan" while it plays, like the suggestions' "Putar". The status line
   describes the last choice only while the document still shows it (an undo or the other tab
   clears it) and keeps its line height when empty, so the panel does not jump. `title` and
   `aria-describedby` sit on each disabled radio, which covers its card and so receives the hover.
6. **R10 round trip in tests.** The fixture seeds' cold opens do not sit on the words' bounds table
   (c30: seed `in_sf` 38217, SetColdOpen from its words gives 38222), so "remove and re-add the
   seed's cold open is the seed" is tested through the cold-open part (exact bounds); the
   SetColdOpen path compares the joins.
7. **Fakes.** `fakeAlphaPm`/`fakeJoins` are exported and pinned against the §2.2 table at all five
   rates; frames outside the clip are dropped, a cut with a whoosh keeps its `sfx` placement. The
   fake store gets no reducers for the join commands (the fake seed has no cold open); the e2e
   spec uses its own scenario store, like `editor-music.spec.mjs`.
8. **crosscheck.** `SetJoinStyle` sends `xfade`/`fade` 5 % of the time and `SetJoinSfx` a
   non-boolean 3 %, for rejection coverage; a transition command without a cold open is turned
   into SetColdOpen 60 % of the time (the `NEEDS` rule of the item commands). Checked against
   T1's validator (`transisi-t1` `6135705`): 1,000 sequences, 22,994 documents, 0 failures. On
   this branch alone `tests/test_edit_v2_crosscheck.py` fails (`unknown_key`/`op_disabled`), as
   §8 expects until T1 is merged.
9. **editor-gates.yml.** `suite=e2e` serves `next start` on 127.0.0.1:3217 with an empty
   `JOBS_ROOT` and settings directory, and takes axe-core 4.10.3 from the registry tarball outside
   `node_modules` (GATES.md T2.6 declined axe as a devDependency). `suite=full` now runs the web
   suites when pytest failed (`!cancelled()`), so one run shows every failure; the job still
   fails. Until this file is on `main`, dispatch with `--ref <branch>` so the branch's workflow
   (with `e2e`) is used.
10. **Outside the owned files**, one line: `web/e2e/editor-acceptance.spec.mjs` (capability 3)
    asserted a plain cut join after Ctrl+Shift+H; it now expects
    `coldOpenJoin(id, 30, joinTemplate(seed, seed))`.

### Files nobody touches

- `web/lib/editor/{preview-client,history,autosave,store,timemap}.mjs`,
  `web/lib/editor/player/{presenter,plate-source,text-layer,audio-clock,frame-map,logo-layer}.mjs`
- `web/components/editor/{shell-model.mjs, runtime.mjs, EditorApp.jsx}`, `web/lib/preview-lane.mjs`,
  `web/lib/jobs.mjs`
- `src/ai_clipper/edit_v2/{execute,verify,plates,envelope,loudness,store,api,coldopen,timemap}.py`,
  `Dockerfile`, `compose.yaml`, `docs/HANDOFF.md`

If a task finds it must change one of these, it stops and reports instead.

### Cross-task shapes, fixed here so T2 and T3 can build before T1 lands

| Shape | Producer | Consumers | Section |
|---|---|---|---|
| Document join `{after, style, audio_fade_ms, sfx?}`, `sfx = {"id": "whoosh", "v": 1}`, styles `cut \| flash_white \| dip_black` | T3 (commands), T1 (seed) | T1 validator, T3 checkDoc | §1.1 |
| Plan DTO `joins[]` `{after, style, atF, rgb, alphaPm, sfx}` | T1 `transitions.joins_dto` via `preview_cli` | T2 player, T2 fixtures, T3 fakes | §1.6 |
| Alpha table | T1 `transitions.alpha_pm` | T2 tests (fixed DTOs), T3 fakes (port) | §2.1–2.2 |
| `transitions.lut_chain(joins, fps)`, `transitions.joins_dto(joins)` | T1 | T2 `player_fixtures.py` | §4.1, §1.6 |
| `frame_identity.make_doc(..., join_style="cut", whoosh=False)`, `Case.join_style`, `Case.whoosh` | T1 | T2 `player_fixtures.py` | §8 |
| Evidence `CI-P-JOIN-B.json` (a `pass` bool) | T2 | T1 `ci_gates.REQUIRED["full"]` | §5.4 |
| `onFrame.joinAlphaPm`, `debug.joinAt(n)` | T2 | T2 harness | §5.2 |
| Commands `SetJoinStyle {style}`, `SetJoinSfx {on}`; parts `join.style`, `join.sfx` | T3 | T1 documents them in CONTRACTS §5.26 | §7.2–7.3 |
| Manifest `cold_open_join`, seed context `coldOpenJoin` | T1 | T1 only | §6.1 |

## 10. Risks and checks

1. **Fixed whoosh level.** On the quietest corpus clip the margin under its speech is 1.5 LU; on
   loud clips the whoosh is mostly heard in the cut gap. Before release, the owner listens to the
   committed WAV and one real clip of each style. A different level ships as `whoosh/v2`; v1
   documents keep v1.
2. **Peaks in revision 0.** Revision 0 is never measured. Speech at full scale could add up to
   +1.3 dB of true peak in the 420 ms window, worst case and only if a speech peak meets the
   hit; at the hit the speech is faded to 0. Auto clips already reach +0.4 dBTP
   (`T2.Z2-P-LOOK.json`). Any measured document (music, gain, normalize) is peak-protected as
   today.
3. **Legacy uses the source grid.** Its alphas follow the same function at its own frame times,
   so they can sit one frame off edit-v2's on non-matching rates. P-LOOK-JOIN bounds it.
4. **Legacy audio for whoosh clips becomes 48 kHz stereo** (a mono source copied to both
   channels at 1.0, so it plays at the level of the job's other clips). Clips without a cold
   open are unchanged.
5. **Rollback** makes documents and seeds that use a transition unreadable (§1.4).
6. **Workflow edits** (`ci-cd.yml` by T2, `editor-gates.yml` by T3) must each be dispatched once
   and pass before the integration PR.
7. **FFmpeg filters** were probed in the local copy of the production image (5.1.9). T1's
   `suite=image` run is the proof of record.
8. **Poster frames** inside a flash are moved after it (§4.5).

## Decisions during build (T1)

Where this spec was silent or did not hold against the code, T1 chose the option closest to
FINAL and CONTRACTS. Each is in CONTRACTS §5.26 or GATES "Transisi cold open".

1. **Branch.** T1 is built on `transisi-t1` (the orchestrator's name), not `transisi-t1-engine`.
2. **`lut_chain(joins, fps, composite="gbrp")`.** A third, defaulted parameter carries the
   compiler's composite. It raises `ValueError` only when there is an effect, so the S-COLOR
   tools (cut documents in other composites) keep compiling. T2's two-argument call is valid.
   A window that would start before 0 (an effect on frame 0, unreachable in a valid document)
   starts at `0.000000`.
3. **Legacy's cold-open side is placed against the measured join.** §4.3 puts it against `L0`,
   the range length as written. The range really ends at a source frame boundary: measured with
   FFmpeg 6.1 at 4 rates × 6 seek points, a frame-rate prediction of the range's frame count was
   off by one at 8 of 24 points (e.g. 25 fps, `-ss 4.004 -t 2.002`: 51 frames, not 50). Against
   `L0` the cold-open-side alphas sit up to `1/(F·W)` off the table (0.33 for the flash at
   30 fps), beyond P-LOOK-JOIN's 0.05. `render._cold_open_join_s` reads the range's end with
   the render's own seek (one `framecrc` pass of 0.5–8 s, before the render) and the range-0
   `geq` uses it (`%d.%06d`); it falls back to `L0` when the pass fails. The body side and the
   cut command are unchanged. (The whoosh delay kept `L0_ms·48 − 11520` here; the review of
   PR #23 moved it to the measured join too, see "Decisions after review".)
4. **P-JOIN and the text.** (b) "every pixel within 3 levels of `blend(cut)`" cannot hold on
   the text, which §4 draws over the effect on purpose. The text's pixels are left out of (b)
   and (c): the luma and chroma samples the text changes, with the 4:2:0 reach (3 chroma
   samples), in the cut render and in the transition render, each against the same render
   without text (two more renders per rate and style; a translucent box over black video is
   invisible in one and visible in the other). On those pixels the layer order is judged: the
   text's share over the effect (`Σ(u − j)(u − c) / Σ(u − c)²`, `u = blend(c)`) must be ≥ 0.5 on
   frames with alpha ≥ 500 (text under the effect gives 0; the hook's 65 %-opaque bar gives
   0.65). The 29.97 cases hold the hook over the join so the order is always judged. The cases
   use 600 source frames (310 output frames at 29.97) to keep the nightly short; still 20 cuts
   and the 2 s cold open.
5. **G-WHOOSH's "same document without it"** is the cut document: a style changes no audio
   (the fragment and `mix_sha256` are equal, tested). The ducked-music case renders both
   documents with the measurement of the one without the whoosh, so the master gain is the same
   and the difference is the mix alone (in production the whoosh is part of the measured mix,
   §3.3).
6. **P-LOOK-JOIN** compares each engine's per-frame alphas around its own join (its peak
   frame) at the best offset in ±1 legacy frame, and each whoosh onset with where that engine
   places it (edit-v2 `start_smp`; legacy, since the review of PR #23, its hit on the cold
   open's end decoded with the render's own seek, at least `L0`), within 2 ms. The two engines'
   joins themselves differ by up to a frame (edit-v2 snaps the cold open to its frame grid),
   which is P-LOOK's existing territory. Loudness: both auto renders within 0.5 LU.
7. **P-AUD's new case** runs in the gate's existing runner (`support.edit_v2_audio_harness
   .p_aud`); `CI-P-AUD.json` gains `whoosh_preview_equals_reference` and the whoosh sample
   count.
8. **`AutoClip.cold_open_join`** (defaulted last field) carries the seed's join, so the
   manifest field comes from the seed; the pipeline falls back to its own join. `ColdOpenJoin`'s
   `sfx` names the latest version of the sound (`"whoosh"` → v1).
9. **Seed context.** A malformed `coldOpenJoin` raises `SeedError` (only our code writes it);
   prepare filters manifest values through `ColdOpenJoin.from_json` first, so a garbled
   manifest seeds a cut.
10. **Posters.** `write_clip_thumbnail(at=…)` checks `0 ≤ at < duration`. `thumbnail_time`
    moves a time inside `avoid` to its middle + 0.25 s (= `L0 + 0.25`), kept only when it is
    inside the clip.
11. **Fixtures.** `make_job`: `old` renders with `cold_open_join=None`; `legacy_new` is the
    `main` media rendered by legacy with the transition. `run_all.sh` builds `main,legacy_new`
    for R10 (pull request) and `main,fps60,old,legacy_new` for P-RT.
12. **Pins of "unchanged".** The pre-transition plan sha of every valid document fixture is in
    `tests/fixtures/edit_v2/plan-shas.json` (real caption track and envelopes, the repository's
    resources), the pre-transition legacy multi-range argv in
    `tests/fixtures/render/legacy-multi-range.json`, and three pre-transition preview
    `audio_key`s in `tests/test_edit_v2_preview_cli.py`.
13. **`render_v3_job`'s default is the pipeline's join**, so the P-LOOK kit (`look_report.py`)
    and make_job render what production renders.
14. **P-JOIN-B** is in `ci_gates.REQUIRED["full"]` as specified; a nightly on a branch without
    T2's `ci-cd.yml` step lists it as missing.

## Decisions after review (PR #23)

1. **Legacy mono speech under the whoosh** goes to both channels at 1.0 (edit-v2's
   `pan=stereo|FL=FL+FC|FR=FR+FC`), and the whoosh is added by `amerge` + `pan` instead of
   `amix` (§4.4). `tests/test_render.py` renders a mono source with and without the whoosh: the
   same level per channel before the whoosh, the same decoded length.
2. **Legacy's whoosh hit is on the measured join**, the later of `L0` and the cold open's
   measured end, where concat starts the body's picture and sound (§4.4). A cut with the whoosh
   measures the join as well. A measured end before `L0` (never on a CFR source) leaves the
   join, effect included, at `L0`. P-LOOK-JOIN expects legacy's onset from the decoded join,
   not from the length the render writes, so it would see a hit placed against `L0` again.

## Appendix A. Reference whoosh generator (prototype, run 2026-10-02)

Integer and `Fraction` arithmetic only. T1 turns this into `scripts/sfx/make_whoosh.py`:
- writes `v1.wav` and `v1.meta.json`;
- `--check` regenerates in memory and compares;
- tunes nothing without regenerating the meta, and keeps the final bytes deterministic.

The prototype gave sha `a722efe7…6c7fa5`, 80 684 bytes, with `PEAK = 4370`.

```python
RATE, SAMPLES, HIT, PEAK, SEED = 48_000, 20_160, 11_520, 4_370, 0x9E3779B9
PI, Q16 = Fraction(355, 113), 1 << 16

def xorshift32(s):
    s ^= (s << 13) & 0xFFFFFFFF; s ^= s >> 17; s ^= (s << 5) & 0xFFFFFFFF
    return s & 0xFFFFFFFF

def sin_q16(x):                       # x ≤ 0.21 rad: 4-term Taylor, rounded half up to Q16
    v = (x - x**3 / 6 + x**5 / 120 - x**7 / 5040) * Q16
    return (2 * v.numerator + v.denominator) // (2 * v.denominator)

def fc_at(n):                         # Hz: 500 → 3200 at the hit, then → 900 at the end
    if n <= HIT: return Fraction(500) + Fraction(2700 * n, HIT)
    return Fraction(3200) - Fraction(2300 * (n - HIT), SAMPLES - 1 - HIT)

def env_q16(n):                       # quadratic swell to the hit, quadratic decay after
    u = Fraction(n, HIT) if n <= HIT else Fraction(SAMPLES - 1 - n, SAMPLES - 1 - HIT)
    return int(u * u * Q16)

state, low, band, q = SEED, 0, 0, Q16 * 7 // 10     # Chamberlin state-variable band-pass, q = 0.7
raw = []
for n in range(SAMPLES):
    state = xorshift32(state); noise = (state >> 16) - 32768
    f = 2 * sin_q16(PI * fc_at(n) / RATE)
    low += (f * band) >> 16
    high = (noise << 4) - low - ((q * band) >> 16)
    band += (f * high) >> 16
    s = (band * env_q16(n)) >> 16
    left = (s * (Q16 - (Q16 * 3 // 10) * n // SAMPLES)) >> 16          # pan L 1.0 → 0.7
    right = (s * (Q16 * 7 // 10 + (Q16 * 3 // 10) * n // SAMPLES)) >> 16  # pan R 0.7 → 1.0
    raw.append((left, right))
peak = max(max(abs(a), abs(b)) for a, b in raw)
# scale to PEAK, rounded half up, with a 96-sample (2 ms) linear ramp at both ends
pcm = b"".join(struct.pack("<hh", *((2 * c * PEAK * r + peak * 96) // (2 * peak * 96) for c in pair))
               for n, pair in enumerate(raw) for r in [min(n, SAMPLES - 1 - n, 96)])
# write with wave: 2 channels, 2-byte samples, 48000 Hz
```
