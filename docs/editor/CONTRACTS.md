# Editor V3 Esensial: frozen contracts

Status: **frozen** by T1.0 (wave W1, 2026-09-25) from
`docs/plans/2026-09-24-editor-v3-esensial.md` ("the plan"). Parts 1–4 are copied **verbatim** from
the plan: Appendix A (module contracts), §3 (the `clip-edit-v2` document), §4.1–§4.2 (storage
and endpoints) and §4.3 (plan DTO). Part 5 records the **T1.0 resolutions**: where the plan is
silent or leaves two readings, the choice made there is binding. A change to anything here needs
the wave integrator's approval and an update of this file in the same PR (plan §11.0).

Phase-B tasks: read §5.1 (where each name lives), §5.2 (additional signatures) and the sections
of Part 5 your module touches; the tests `tests/test_edit_v2_contracts.py` pin the signatures.

Contents: Part 1 (Appendix A) · Part 2 (§3) · Part 3 (§4.1–§4.2) · Part 4 (§4.3) ·
Part 5 (T1.0 resolutions, §5.15 the W1 integration resolutions of T1.Z, §5.16 the W1 verifier
fixes).

# Part 1. Module contracts (plan Appendix A, verbatim)

## Lampiran A. Kontrak modul (dibekukan di T1.0; disalin ke `docs/editor/CONTRACTS.md`)

### A.1 Python (`src/ai_clipper/edit_v2/`, stdlib only)

```python
# __init__.py
COMPILER_VERSION = "edit-v2/1.0.0"          # plan field "compiler" is "edit-v2/1"
RENDER_SEMANTICS = 1                        # bump on any golden-pixel change (owner look approval)

# errors.py
class EditV2Error(Exception):               # .code (stable), .path (JSON pointer) | None, .ref (id) | None
class DocInvalid(EditV2Error): ...          # parse level → 422
class DocSemanticInvalid(EditV2Error): ...  # semantic level → 422
class RevisionConflict(EditV2Error): ...    # 409, carries current doc + etag
class IdempotencyConflict(EditV2Error): ... # 409
class NotFound(EditV2Error): ...            # 404
class AnalysisMissing(EditV2Error): ...     # 409 analysis_missing
class SchemaTooNew(EditV2Error): ...        # 426
class RenderFailed(EditV2Error): ...; class VerificationFailed(EditV2Error): ...; class Cancelled(EditV2Error): ...
MESSAGES: Mapping[str, str]                 # code → Indonesian message (id "edit.<code>")

# timemap.py
@dataclass(frozen=True, slots=True)
class Fps: num: int; den: int
@dataclass(frozen=True, slots=True)
class Piece: i: int; seg: str; role: str; in_sf: int; out_sf: int; out_f0: int; frames: int
def pieces(doc: Mapping) -> tuple[Piece, ...]
def total_frames(pieces: Sequence[Piece]) -> int
def smp(n: int, fps: Fps, rate: int = 48_000) -> int
def sf_floor(ms: int, fps: Fps) -> int
def sf_ceil(ms: int, fps: Fps) -> int
def word_frames(s_ms: int, e_ms: int, pieces: Sequence[Piece], fps: Fps) -> tuple[int, int] | None  # None: not visible
def out_to_src(n: int, pieces: Sequence[Piece]) -> tuple[Piece, int]
def now_ms(n: int, fps: Fps) -> int          # FFmpeg vf_subtitles double arithmetic, verbatim
def safe_cs(n: int, fps: Fps) -> int
def cell_frames(fps: Fps) -> int

# clip_id.py
def clip_id(source_content_sha256: str, start_ms: int, end_ms: int,
            cold_open_ms: tuple[int, int] | None) -> str

# doc.py
MAX_DOC_BYTES = 1 << 20
@dataclass(frozen=True)
class Issue: code: str; path: str; ref: str | None = None; f: int | None = None
@dataclass(frozen=True)
class Validation: errors: tuple[Issue, ...]; warnings: tuple[Issue, ...]
def parse_doc(raw: bytes) -> dict
def canonical_bytes(doc: Mapping) -> bytes
def doc_sha256(doc: Mapping) -> str
def content_sha256(doc: Mapping) -> str      # canonical bytes without revision, parent_sha256, audit
def content_equals_seed(doc: Mapping, seed: Mapping) -> bool   # R10
def validate_doc(doc: Mapping, *, words: Mapping, assets: Mapping[str, Mapping],
                 seed: Mapping | None) -> Validation

# store.py (clip_dir = analysis/clips/<clip_id>)
def get(clip_dir: Path) -> tuple[dict, str, bool]                       # doc, etag, is_seed
def seed(clip_dir: Path) -> tuple[dict, str]
def put(clip_dir: Path, *, expected_etag: str, idempotency_key: str, raw: bytes,
        now_ms: int) -> tuple[dict, str, tuple[Issue, ...]]
def archive_for_render(clip_dir: Path, etag: str) -> tuple[str, int]    # relative path, revision
def prune_receipts(clip_dir: Path, *, keep: int = 200) -> int     # keeps pending receipts

# subtitles.py (added) / captions_ass.py (added) / edit_v2/captions.py
@dataclass(frozen=True, slots=True)
class SourceWord: id: str; s_ms: int; e_ms: int; text: str; emphasis: bool
@dataclass(frozen=True, slots=True)
class FrameWord: id: str; f0: int; f1: int; text: str; emphasis: bool
@dataclass(frozen=True, slots=True)
class FrameCue: f0: int; f1: int; seg: str; words: tuple[FrameWord, ...]
def build_frame_cues(words: Sequence[SourceWord], pieces: Sequence[Piece], fps: Fps, *,
                     max_words: int = 4, max_gap_ms: int = 600,
                     min_display_ms: int = 300) -> tuple[FrameCue, ...]
def load_pack(pack_id: str, version: int) -> CaptionPack                 # resources/caption-packs
@dataclass(frozen=True)
class HookSpec: text: str; f0: int; f1: int; y_e5: int
def build_ass_v2(cues: Sequence[FrameCue], *, play_res: tuple[int, int], fps: Fps,
                 total_frames: int, pack: CaptionPack, overrides: Mapping,
                 hook: HookSpec | None) -> str
@dataclass(frozen=True)
class CaptionResult: cues: tuple[FrameCue, ...]; ass: str; ass_sha256: str
                     hook_lines: tuple[str, ...]; warnings: tuple[Issue, ...]
def caption_track(doc: Mapping, words: Mapping, pieces: Sequence[Piece]) -> CaptionResult

# glyphs.py
def missing_glyphs(text: str, font_file: Path) -> tuple[str, ...]
def advance_px(text: str, font_file: Path, font_size: float) -> float    # from hmtx, for box/bold splits

# envelope.py / audio_graph.py / loudness.py
Envelope = tuple[tuple[int, int], ...]                                   # (sample, gain_e6), increasing
def speech_envelope(pieces: Sequence[Piece], joins: Mapping[str, int], cut_fade_ms: int,
                    fps: Fps, gain_cdb: int) -> Envelope
def music_envelope(speech_spans: Sequence[tuple[int, int]], item: Mapping,
                   total_samples: int, fps: Fps) -> Envelope
def expand_f32(env: Envelope, total_samples: int) -> bytes
@dataclass(frozen=True)
class AudioFragment: graph: str; inputs: tuple[InputSpec, ...]; sidecars: Mapping[str, bytes]
                     mix_sha256: str
def audio_fragment(plan: RenderPlan, *, mode: str, first_input_index: int) -> AudioFragment
@dataclass(frozen=True)
class Loudness: i_clufs: int; tp_cdb: int
def parse_ebur128(stderr: str) -> Loudness
def master_gain(measured: Loudness, target_clufs: int, tp_cdb: int) -> tuple[int, bool]   # gain_cdb, clamped

# plan.py / compile_ffmpeg.py / layouts.py / execute.py / verify.py / derive.py
def build_plan(doc: Mapping, *, words: Mapping, camera: Mapping | None,
               assets: Mapping[str, Mapping], resources: Resources) -> RenderPlan   # .to_json(), .plan_sha256
def compile_job(plan: RenderPlan, *, mode: str, source: Path, assets_root: Path,
                size: tuple[int, int] | None = None, quality: str = "standar",
                cells: Sequence[int] = (), frame: int | None = None,
                loudness: Loudness | None = None) -> FfmpegJob  # argv, filter_script, inputs, sidecars, expected
def run(job: FfmpegJob, *, output_fd: int | None, timeout_s: float,
        on_progress: Callable[[int], None] | None = None,
        cancel: threading.Event | None = None) -> ExecResult
def verify_output(fd: int, plan: RenderPlan, *, size: tuple[int, int], normalize: bool) -> VerifyReport
def render_key(plan: RenderPlan, *, size: tuple[int, int], quality: str,
               measure_sha: str | None, toolchain_sha: str) -> str   # measure = loudness/peak
# Essentials: size is always the doc's output size and quality "standar"; the parameters stay
# for Stage 2.

# source_info.py / words.py / peaks.py / camera.py / seed.py
def ensure_source_info(job_dir: Path, source: Path) -> dict
def build_peaks(source: Path, window_ms: tuple[int, int], *, per_sec: int = 100) -> bytes
def build_words_artifact(transcription: Transcription, *, clip_id: str, window_ms: tuple[int, int],
                         fps: Fps, audio: AudioTimeline | None, events: Sequence[SoundEvent],
                         peaks: bytes) -> dict
def build_camera_plan(source: Path, window_ms: tuple[int, int], fps: Fps, *, out_w: int,
                      out_h: int, detector: Callable = detect_face_track) -> dict
def build_seed(*, clip: SelectedClip, job: Mapping, source_info: Mapping, words_sha: str,
               words_count: int, camera_sha: str | None, selection_sha: str) -> dict
def prepare_legacy_job(job_dir: Path) -> list[dict]   # persists source/words/peaks/seed once;
                                                       # → [{clip_id|None, index, openable, reason}]

# render_edit.py (W2)
def render_document(doc: Mapping, job_dir: Path, output: Path, *, size: tuple[int, int],
                    quality: str, progress: Callable[[int], None] | None = None,
                    cancel: threading.Event | None = None) -> RenderResult    # mp4 + srt, no-clobber
def render_request(job_dir: Path, request: Mapping, *, heartbeat: Callable[[str, int], None],
                   cancel: threading.Event) -> RenderResult
```

CLIs (stdin JSON envelope → stdout JSON, bounded; exit codes as in T1.1):

| Module | Ops |
|---|---|
| `python -m ai_clipper.edit_v2.api` | `clips`, `prepare_job`, `get`, `put`, `seed`, `archive` |
| `python -m ai_clipper.edit_v2.preview_cli` | `prepare`, `plan`, `cells`, `audio`, `frame`, `derive` |
| `python -m ai_clipper.edit_v2.assets` | `ingest`, `meta` |
| `python -m ai_clipper.edit_v2.cleanup` / `coldopen` | `list` |
| `python -m ai_clipper.editor_ai` | `heuristic`, `run-task` |

### A.2 JavaScript (browser; ESM; no new dependency except jassub and mediabunny)

```js
// web/lib/editor/timemap.mjs — mirrors timemap.py, verified by timemap-vectors.json
export function pieces(doc) {}              // → [{i, seg, role, inSf, outSf, outF0, frames}]
export function totalFrames(pieces) {}
export function smp(n, fps) {}  export function sfFloor(ms, fps) {}  export function wordFrames(sMs, eMs, pieces, fps) {}
export function outToSrc(n, pieces) {}      export function nowMs(n, fps) {}  export function safeCs(n, fps) {}
export function cellFrames(fps) {}

// web/lib/editor/store.mjs
export function createEditorStore({ jobId, clipId, api, previewClient, draftStore, now }) {}
// → { getState() → { status: "loading"|"ready"|"readOnly"|"error", doc, seed, words, etag,
//        save: "saved"|"dirty"|"saving"|"conflict"|"error", savedAtMs, canUndo, canRedo,
//        plan, pending: ["text"|"audio"|"plate"|"logo"], warnings, selection },
//     dispatch(type, args, { mergeKey }?)   // throws CommandRejected(code) when a precondition fails
//     undo(), redo(), flush() → Promise, subscribe(fn) → unsubscribe, destroy() }

// web/lib/editor/player/player.mjs
export function createPlayer({ canvas, fetchImpl, onState, onFrame }) {}
// → { load(planDTO), play() → Promise, pause(), seek(frame) → Promise, step(delta) → Promise,
//     showTruthFrame(frame) → Promise, state() → { mode: "live"|"auto_render"|"truth"|"unsupported",
//     current: { text, plate, audio, logo }, frame }, destroy() }

// web/lib/editor/api-client.mjs
export function createApiClient({ jobId, clipId, fetchImpl }) {}
// → { clips(), getEdit({ seed }), putEdit(doc, { etag, key }), words(url), prepare({ layout }),
//     createRender({ editEtag }, key), getRender(id), cancelRender(id),
//     cleanup(), coldOpenSuggestions(), aiHooks(doc), aiTask(taskId) }

// web/lib/editor/preview-client.mjs
export function createPreviewClient({ jobId, clipId, fetchImpl, debounceMs = 120 }) {}
// → { plan(doc) → Promise<PlanDTO> (latest wins; aborts superseded), frame(doc, f) → Promise<Blob> }

// web/lib/python-cli.mjs (server; landed by T1.Z) — the ONLY way editor routes spawn Python
export function runPythonCli(module, op, payload, { timeoutMs, maxStdoutBytes, withLlmEnv = false, signal }) {}
// → Promise<{ exitCode, json }>; env = allowlist (E11) plus engineProcessEnv(loadLlmEnv()) only
//   when withLlmEnv is true (AI task); process group killed on timeout or abort
export const CHILD_ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "TZ", "TMPDIR", "JOBS_ROOT", "FONTCONFIG_FILE" /* + non-secret flags */];

// web/lib/editor/upload-client.mjs (W3)
export function uploadAsset(jobId, file, kind, { onProgress, signal }) {}
// → Promise<{ sha256, kind, mime, w, h, durationMs, lufsC, peaksUrl }>
```

# Part 2. The `clip-edit-v2` document (plan §3, verbatim)

## 3. Dokumen edit `clip-edit-v2` (subset Esensial)

The document describes *content* (what the clip is). Export options (size, quality) are render
request parameters, not document fields; in Essentials they have exactly one allowed value each
(`output`, `standar`), and Stage 2 widens the enums without a schema change. Python (`edit_v2/doc.py`) is the **only** validator; the
client builds valid documents by construction (commands) and treats 422 as a bug.

### 3.1 Units and conventions (integers only; a JSON number with `.` or `e` is rejected at parse)

| Suffix / field | Unit | Notes |
|---|---|---|
| `_sf` | Source-grid frame at `output.fps`: frame *k* covers source time `[k·den/num, (k+1)·den/num)` s, counted from t = 0 | Cut points, segment and removal edges |
| `_f` | Output frame at `output.fps` | Hook timing, fades |
| `_ms` | Source milliseconds | Words, analysis window |
| `_smp` | 48 kHz sample | Music offset |
| `_e5` | Fraction × 100,000 of the output width (x, w) or height (y) | `50000` = centre |
| `_pm` | Per-mille (1000 = 100%) | Opacity, size scale |
| `_cdb`, `_clufs` | Centi-dB, centi-LUFS | `-1400` = −14.00 |
| `fps` | `[num, den]`, one of `[24,1] [25,1] [30,1] [24000,1001] [30000,1001]` | Fixed at seed time |
| Colours | `#RRGGBB`, uppercase | Swatch sets per field (§3.3) |
| IDs | items, segments, removals, tracks `^[a-z]{2,3}_[0-9a-z]{1,16}$`; words `^w[0-9]{6,7}$`; assets `sha256:<64 hex>`; clip `^clip_[0-9a-f]{24}$` | |

Text rules (kept from V1 [R1 §3]): NFC only; no Cc/Cs characters; no leading or trailing
whitespace; hook ≤ 90 characters; word display text 1–40 characters. Canonical bytes are
`json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)`. A document is ≤ 1 MiB.
Duplicate keys, NaN and unknown keys are rejected at every level.

### 3.2 Complete example (revision 4: cold open, two cuts, Bold preset, logo, ducked music)

```json
{
  "schema": "clip-edit-v2",
  "schema_minor": 0,
  "clip_id": "clip_9b2e41c07d3a5f18e6c2a0b4",
  "revision": 4,
  "parent_sha256": "4c1d2e…64 hex…",
  "base": {
    "job_id": "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55",
    "source": {"content_sha256": "e3b0c4…", "w": 1280, "h": 720, "fps_native": [30000, 1001],
               "vfr": false, "duration_ms": 3901120, "has_audio": true},
    "origin": {"kind": "v3_clip", "selection_artifact_sha256": "a91f…", "selection_version": "selection-v3.0",
               "rank_at_seed": 3, "hook_unit_id": "S0412", "selection_source": "llm"},
    "window_ms": [1181900, 1370900],
    "words": {"sha256": "7f0a…", "count": 512},
    "camera": {"sha256": null},
    "seed_sha256": "51be…",
    "engine": {"compiler": "edit-v2/1", "render_semantics": 1}
  },
  "output": {"w": 720, "h": 1280, "fps": [30000, 1001], "sample_rate": 48000, "channels": 2},
  "main": {
    "segments": [
      {"id": "seg_co", "role": "cold_open", "in_sf": 38210, "out_sf": 38345},
      {"id": "seg_b1", "role": "body", "in_sf": 37215, "out_sf": 39284}
    ],
    "removals": [
      {"id": "rm_01", "seg": "seg_b1", "in_sf": 37483, "out_sf": 37556,
       "words": ["w048131", "w048132"], "reason": "user", "origin": "user"},
      {"id": "rm_02", "seg": "seg_b1", "in_sf": 37813, "out_sf": 37848,
       "words": ["w048140"], "reason": "filler", "origin": "suggestion:cl_7"}
    ],
    "joins": [{"after": "seg_co", "style": "cut", "audio_fade_ms": 30}],
    "cut_fade_ms": 8
  },
  "captions": {
    "enabled": true,
    "pack": {"id": "bold", "v": 1},
    "overrides": {"y_e5": 83000, "size_pm": 1000, "case": "upper", "highlight": "#FFE14D", "emphasis": "#FF5C8A"},
    "word_edits": {
      "w048121": {"text": "Ijal"},
      "w048150": {"emphasis": true},
      "w048151": {"hidden": true}
    }
  },
  "layout": {"default": {"mode": "fit_blur", "no_face": "center"}},
  "tracks": [
    {"id": "tr_hook", "kind": "hook", "items": [
      {"id": "it_hook", "type": "hook", "start": {"at": "out", "f": 0}, "dur_f": 120,
       "transform": {"x_e5": 50000, "y_e5": 13000},
       "payload": {"text": "Dia ditahan security di film-nya sendiri", "design": {"id": "legacy-bar", "v": 1}},
       "origin": "suggestion:sg_2"}]},
    {"id": "tr_ovr", "kind": "visual", "band": "over_text", "role": "overlay", "items": [
      {"id": "it_logo", "type": "image", "start": {"at": "clip_start"}, "end": {"at": "clip_end"},
       "transform": {"x_e5": 88000, "y_e5": 7000, "w_e5": 16000, "opacity_pm": 850},
       "payload": {"asset": "sha256:5c1f…", "mode": "free"}, "origin": "user"}]},
    {"id": "tr_mus", "kind": "audio", "role": "music", "items": [
      {"id": "it_music", "type": "audio", "start": {"at": "clip_start"}, "end": {"at": "clip_end"},
       "payload": {"asset": "sha256:91aa…", "src_in_smp": 0, "loop": true, "gain_cdb": -1000,
                   "fade_in_f": 15, "fade_out_f": 30,
                   "duck": {"on": true, "depth_cdb": 1000, "attack_ms": 30, "release_ms": 400,
                            "hold_ms": 250, "detector": "words"}},
       "origin": "user"}]}
  ],
  "audio": {"source": {"gain_cdb": 0},
            "master": {"mode": "off", "target_clufs": -1400, "tp_cdb": -100}},
  "assets": {
    "sha256:5c1f…": {"kind": "image", "mime": "image/png", "w": 512, "h": 512},
    "sha256:91aa…": {"kind": "audio", "mime": "audio/mp4", "duration_ms": 142000, "lufs_c": -1620}
  },
  "audit": {"created_at_ms": 1790000000000, "updated_at_ms": 1790000123456,
            "editor": "editor-v3/1.0.0", "last_command": "RemoveWords"}
}
```

### 3.3 Field rules (Essentials; anything else is `op_disabled` or `unknown_key`)

| Path | Type / range | Essentials rule |
|---|---|---|
| `schema`, `schema_minor` | `"clip-edit-v2"`, `0` | A newer minor → 426 "muat ulang editor" |
| `revision`, `parent_sha256` | int ≥ 0; sha or null | Revision 0 only for the seed (parent null). PUT requires `revision == current + 1` and `parent_sha256 == current etag` |
| `base.*` | set at seed, **immutable** | PUT with any change to `base` → 422 `base_changed` |
| `base.window_ms` | `[a, b]`, clip range ±60 s clamped to the source | Every segment must lie inside it (`outside_window`) |
| `output` | `w×h` ∈ {720×1280, 1080×1920}; `fps` as §3.1; `sample_rate` 48000; `channels` 2 | Fixed at seed (the job's render size; the dashboard uses 720×1280). Exports render at this size (§4.6) |
| `main.segments` | 1–2 items: optional `cold_open` first, then exactly one `body` | Cold-open rules in §3.4 |
| `main.removals` | ≤ 2,000; `reason` ∈ {`user`, `filler`, `repeat`, `gap_silent`}; `origin` `user` or `suggestion:<id>` | Sorted by `in_sf` within a segment; no overlap; `words` must exist in the words artifact |
| `main.joins` | 0–1 item: `after` = cold-open id; `style` `"cut"`; `audio_fade_ms` 0–250 (seed 30) | Other styles are Stage 2 |
| `main.cut_fade_ms` | 0–50 (default 8) | Micro-fade at every jump cut (G-CLICK) |
| `captions.pack` | `{id ∈ {classic, karaoke, bold, box}, v: 1}` | Packs are immutable per version (§5.4) |
| `captions.overrides.y_e5` | 20000–92000 (bottom anchor of the caption block) | Seed 83000 (= today's 17% bottom margin) |
| `captions.overrides.size_pm` | 700–1400 | Seed 1000 |
| `captions.overrides.case` | `asis`, `upper` | Case is a display transform; text is never rewritten |
| `captions.overrides.highlight`, `.emphasis` | swatch `#FFE14D #FFFFFF #3DF5A6 #52C7FF #FF5C8A #FF9F1C` | `highlight` is used by karaoke and bold |
| `captions.word_edits` | ≤ 6,000 keys (word ids); values `{text?, hidden?, emphasis?}` with ≥ 1 key | `text` 1–40 chars. `emphasis` fixes defect #6 (§8) |
| `layout.default.mode` | `fit_blur`, `camera` (face-track), `fill_center` (center-crop) | `no_face` is `"center"` (today's behaviour), and no-face spans are *reported*, never silent |
| `tracks` | ≤ 3 tracks: ≤ 1 `hook`, ≤ 1 `visual/over_text/overlay`, ≤ 1 `audio/music`; ≤ 1 item each | Stage 2 lifts the counts; the shapes stay |
| hook item | `start {"at":"out","f":0}`; `dur_f` 15 to `floor(30·F)`; `transform.x_e5` 50000; `y_e5` 6000–40000 (top of the hook stack; seed 13000); `payload.text` 1–90; `design {"id":"legacy-bar","v":1}` | Fixed start at 0 as today |
| logo item | `start clip_start`, `end clip_end`; `x_e5, y_e5` 0–100000 (box centre); `w_e5` 4000–40000; `opacity_pm` 200–1000; `payload.mode` `"free"` | The resolved box must lie inside the frame (`item_out_of_frame`) |
| music item | `start clip_start`, `end clip_end`; `src_in_smp` 0 to asset length − 1; `loop` bool; `gain_cdb` −4800–600; `fade_in_f`/`fade_out_f` 0 to `10·F`; `duck` fully specified: `depth_cdb` 300–2400, `attack_ms` 5–500, `release_ms` 50–2000, `hold_ms` 0–1000, `detector` `"words"` | Default gain `clamp(−2600 − lufs_c, −4800, 600)` |
| `audio.source.gain_cdb` | −2400–1200 | Seed 0 |
| `audio.master` | `mode` `off`/`normalize`; `target_clufs` −2400 to −900; `tp_cdb` −300–0 | Seed `off` (= today's auto render) |
| `assets` | map of the assets the document references; metadata copied from the asset store | `asset_missing` if the store lacks the sha |
| `audit` | `created_at_ms` immutable; `updated_at_ms` **stamped by the server**; `editor`; `last_command` (≤ 40 chars, `^[A-Za-z]+$`) | The server stamp removes client-clock issues |

### 3.4 Integer and frame rules

All arithmetic is integer (Python `int`, JS `BigInt` only where a product can exceed 2^53, which
never happens below 10 h at 30 fps). Rational comparisons use cross-multiplication, never floats.

| Quantity | Rule |
|---|---|
| ms ↔ source-grid frame | `sf_floor(ms) = ⌊ms·num / (1000·den)⌋`, `sf_ceil(ms) = ⌈ms·num / (1000·den)⌉`; the start time of frame k is `k·1000·den/num` ms (rational) |
| Seed segment edges | `start_ms = round_half_up(start_s·1000)` (V3 values have 3 decimals); `in_sf = sf_floor(start_ms)`, `out_sf = sf_ceil(end_ms)` |
| Pieces | For each segment in order: `[in_sf, out_sf)` minus the union of its removals. A remaining sub-range shorter than 2 frames is dropped (it joins the adjacent cut). `out_f0(p) = Σ frames(previous pieces)`; `frames = out_sf − in_sf` |
| Duration | `total_f = Σ frames`; the body alone must satisfy `3 s ≤ frames/F ≤ 300 s` (`duration_out_of_bounds`) |
| Samples | `smp(n) = ⌊n·48000·den / num⌋` (1601/1602 at 29.97 with zero drift [PF D12]); piece sample count `smp(out_f0+frames) − smp(out_f0)`; the first source sample of a piece is `⌊in_sf·48000·den / num⌋` |
| Word visibility (captions) | A word is shown when it is not `hidden` and its midpoint `(s+e)/2` lies inside a piece's source span (the V3 midpoint rule) |
| Word output frames | `n_on = out_f0(p) + round_half_up((s_ms − t0_ms(p))·num / (1000·den))`, clamped to the piece; `n_off` the same from `e_ms`. A word never spans a cut |
| ASS time (frame-safe) | `now_ms(n) = trunc(n · (den/num) · 1000)` in IEEE double, **the exact expression order of FFmpeg's `vf_subtitles`** with time base `den/num` (the graph sets `settb=den/num` before `ass`). `safe_cs(n) = (now_ms(n) − 2) // 10`. An event visible on `[a, b)` is written `Start = safe_cs(a)`, `End = safe_cs(b)`; `\k` durations are differences of `safe_cs`. The browser calls libass with `now_ms(n)/1000`, and JASSUB's rounding returns exactly `now_ms(n)` [PF `ass_time_rule.py`: 0 failures, 24–60 fps, 3 h] |
| Cold open | At most one, first, `⌈0.5·F⌉ ≤ frames ≤ ⌊8·F⌋`, `abs(co.in_sf − body.in_sf) ≥ 1`. Blocking `cold_open_invalid` when more than 80% of it lies inside `[body.in_sf, body.in_sf + frames + 2·F)`, because it would only repeat the opening (FINAL §4.8) |
| Plate cells | `cell_frames = 2·⌈num/den⌉` (60 at 29.97 and 30, 50 at 25, 48 at 24 and 23.976). Cell k covers source-grid frames `[k·cell_frames, (k+1)·cell_frames)` |
| Logo box | `w_px = round_half_up(w_e5·W / 100000)`, `h_px = round_half_up(w_px·asset_h / asset_w)`, `x0 = round_half_up(x_e5·W/100000 − w_px/2)`, `y0` likewise, computed as integers from the doc's output size (export at another size recomputes from the same `_e5` values) |

### 3.5 Seed (revision 0) from a V3 clip

The pipeline writes the seed once to `analysis/clips/<clip_id>/seed.json` (canonical bytes,
immutable) and renders the auto clip **from that file**. The editor never recomputes it for new
jobs, so it cannot drift. For jobs rendered before Essentials, `POST /clips` (prepare) builds the
seed once with the same function, marks `base.engine.compiler = "legacy"` and **writes it as the
same immutable `seed.json`**, together with `source.json`, words and peaks (§4.4). GET never
writes. A later code change therefore never moves the revision-0 ETag or the "Kembali ke versi
AI" target of an existing clip.

| Doc field | Source |
|---|---|
| `clip_id` | `"clip_" + sha256("potongin-clip-v1\0" ‖ source_content_sha256 ‖ "\0" ‖ start_ms ‖ "\0" ‖ end_ms ‖ "\0" ‖ (co_start_ms "-" co_end_ms, or "-"))[:24]` (FINAL §4.9; rank and selection version excluded, so a re-run that finds the same moment re-attaches the edits) |
| `main.segments` | Cold open (when the job ran with cold open and the clip has one) + body, edges per §3.4 |
| `main.joins` | `cut` with `audio_fade_ms: 30` (today's `AUDIO_JOIN_FADE_SECONDS`) |
| `captions.pack` | `karaoke` or `classic` from the job's `captionStyle`; overrides at the pack defaults |
| hook item | When `hookOverlay` and `hook_text` exist: `[0, round_half_up(hook_duration·F))`, `legacy-bar`, `y_e5 13000` |
| `layout.default.mode` | `face-track` → `camera`, `fit-blur` → `fit_blur`, `center-crop` → `fill_center` |
| `output` | The job's render size (the dashboard passes 720×1280 [REPO run-job.mjs]); fps: native standard rates kept; 50 → 25, 60 → 30, 60000/1001 → 30000/1001; VFR or other → 30/1 |
| `audio` | Source gain 0; master `off` |
| `base.window_ms` | `[min(start, co_start) − 60 000, max(end, co_end) + 60 000]` clamped to `[0, duration_ms]` |

### 3.6 Words artifact `potongin.words/1`

Immutable file `analysis/clips/<clip_id>/words.<sha16>.json`, built from `transcript.json`
**as written** (read back through `transcript_io.read_transcript_json`), so the IDs match what
every later reader sees.

```json
{"schema": "potongin.words/1", "clip_id": "clip_9b2e…", "transcript_sha256": "…", "fps": [30000, 1001],
 "window_ms": [1181900, 1370900],
 "words": [{"id": "w048121", "s": 1241930, "e": 1242210, "t": "Ijai", "p_pm": 410, "u": "S0412", "z": false}],
 "units": [{"id": "S0412", "s": 1241930, "e": 1245880, "q": true}],
 "bounds": [{"after": "w048120", "before": "w048121", "sf": 37229, "tight": false, "rms_cdb": -5210}],
 "gaps": [{"after": "w048130", "s": 1244100, "e": 1245320, "class": "voiced"}],
 "events": [{"kind": "laughter", "s": 1256800, "e": 1256800, "src": "yt-caption"},
            {"kind": "laughter", "s": 1301200, "e": 1301900, "src": "transcript"}],
 "silences": [[1261330, 1262490]], "scene_cuts_ms": [1263040],
 "peaks": {"file": "peaks.9c1e….bin", "per_sec": 100, "start_ms": 1181900}}
```

- **Word IDs.** `w` + the zero-padded global index of the word in the transcript's flattened word
  list. Segments without word timestamps are split proportionally exactly like
  `subtitles._segment_words`, so revision 0 captions equal the auto render's captions. Zero-length
  words (up to 4.7% with YouTube captions [UX-M1]) get `e = min(s + 80, next.s)` and `z: true`.
- **`bounds`, the snap table (single source of truth for every cut and trim).** For each
  adjacent word pair (and before the first and after the last word of the window), the chosen
  frame boundary `sf`:
  1. If `gap = b.s − a.e ≥ 40 ms`: take the quietest 10 ms bin in `[a.e + 20, b.s − 20]` from
     the peaks; ties go to the gap centre.
  2. Convert it to the frame boundary *inside* the gap nearest to that point.
  3. When no frame boundary fits inside the gap (gap < 1 frame), use the boundary nearest the
     midpoint and set `tight: true`, which raises the warning `tight_cut` on any cut that uses it.

  Trim-in, trim-out, removal-in and removal-out at that gap all use this same `sf`, so the client
  never computes a cut point itself.
- **Gap classes** (for Rapikan and markers; only gaps > 600 ms): `laughter` when a laughter event
  lies within ±500 ms; `silent` when ≥ 80% of the gap is covered by `audio_timeline` silences;
  otherwise `voiced` [FINAL §5.3; UX-M2: 78% of long gaps are not silent].
- **Events.** From `analysis/sound-events.json` (YouTube tags, points) plus transcript tokens
  matching `^(ha){2,}h?$|^(he){2,}$|^wk(wk)+$` (source `transcript`), both case-folded.
- **Peaks.** `peaks.<sha16>.bin`: 8-bit min/max pairs at 100 per second over the window, mono,
  decoded once at 8 kHz by FFmpeg. Used by the snap table, the waveform lane and Rapikan audition.
- **Transcript changed** (the job re-ran): the words sha in `base.words` no longer matches → the
  editor opens **read-only** with "Transkrip berubah sejak klip diedit" and offers "Mulai dari
  versi AI". Re-anchoring is Stage 2.
- **Overlapping words** (allowed by `transcript_io`: words may overlap each other): a negative gap
  takes the frame boundary nearest `(a.e + b.s)/2`, clamped to `[a.s, b.e]`, with `tight: true`.
- **Missing optional analysis** (older jobs without `sound-events.json` or `audio-timeline.json`):
  `events`, `silences`, `scene_cuts_ms` and the gap classes are empty, and the artifact records
  `"missing": ["sound_events", …]` so that the UI can show "tidak tersedia untuk job ini" instead
  of an empty lane.

### 3.7 Validation results

| Level | Codes (Indonesian message id = `edit.<code>`) | Effect |
|---|---|---|
| Parse | `invalid_json`, `float_not_allowed`, `duplicate_key`, `unknown_key`, `too_large`, `not_nfc`, `control_char` | 422 `{errors:[{path, code}]}` |
| Semantic, blocking | `base_changed`, `outside_window`, `range_invalid`, `cold_open_invalid`, `duration_out_of_bounds`, `removal_outside_segment`, `removal_overlap`, `unknown_word`, `asset_missing`, `pack_unknown`, `op_disabled`, `item_out_of_frame`, `revision_mismatch`, `parent_mismatch` | 422 |
| Warning (save allowed; export asks for acknowledgement in "Perlu dicek") | `tight_cut`, `laughter_cut` (a cut inside a laughter span or within 300 ms of a laughter point), `hook_overflow` (the hook does not fit 3 lines at the smallest size and will be shortened with "…"), `glyph_unsupported:U+XXXX` (the pack font lacks a character, e.g. emoji), `no_face` (face-track spans with no face; listed with jump-to), `unsafe_zone` (caption, hook or logo box inside the TikTok UI zone), `loudness_clamped`, `peak_reduced` (§5.6 step 5), `music_shorter_than_clip` (loop off) | Listed with a jump-to target; nothing is silently changed |

### 3.8 Forward compatibility with FINAL (Stage 2)

- Stage 2 adds **optional** keys under `schema_minor: 1`: more tracks and items, word anchors,
  `intro_hold_f`, `markers`, `template_ref`, `packaging`, join styles, `layout.ranges`, and
  `camera.manual_keys`. A minor-0 document stays valid unchanged.
- The pack ids `classic` and `karaoke` are the FINAL `legacy-classic@1` and `legacy-karaoke@1`
  (an alias table is added in Stage 2).
- FINAL puts the resolver in JS. If Stage 2 adopts that, the Python resolver becomes the
  reference: FINAL's P-XENG test is then run against Python output (plan-hash equality), which
  this plan's goldens already enable.

# Part 3 and Part 4. Storage, endpoints and plan DTO (plan §4.1, §4.2 and §4.3, verbatim)

### 4.1 Storage layout (new paths only; everything under the job directory)

```
JOBS_ROOT/<job>/
  analysis/source.json                          {content_sha256, probe}; written once per job (edit_v2.source_info)
  analysis/clips/<clip_id>/
      seed.json                                 revision 0, canonical, immutable (0600)
      words.<sha16>.json · peaks.<sha16>.bin    immutable analysis artifacts
      camera.<sha16>.json                       immutable, only when face-track was needed
      edit/doc.json                             current revision (canonical, 0600)
      edit/archive/r<N>.<sha>.json.gz           superseded + render-referenced revisions
      edit/receipts/<idempotency-key>.json      digest-only receipts (pruned, §4.4)
      edit/.lock                                flock for the clip's document
      preview/plates/<plate_key16>-c<k:07d>.mp4 plate cells (LRU cache; flat names)
      preview/audio/<mix_sha16>.flac            preview audio mixes (LRU cache)
      preview/ass/<ass_sha16>.ass               ASS served to JASSUB (LRU cache)
      preview/frames/<plan_sha16>-<f>-<w>.png   truth frames (LRU cache)
      preview/derived/<asset_sha16>@<w>x<h>.png logo prescaled to its exact pixel box
      suggestions/<task_id>.json                AI tasks (30 days)
  analysis/assets/<sha256>.{png,m4a} + <sha256>.json    job asset store (§9.2)
  analysis/render-requests/<render_id>.json     render-request-v1/v2 (legacy) and v3 (new)
  output/clip-NN.mp4 + .srt                     auto renders (unchanged paths; = revision 0)
  output/edits/<clip_id>/<render_key16>.{mp4,srt}   editor exports
```

Caches (`preview/**`) are regenerable. They are LRU-evicted per job with a default cap of 1 GiB
(owner decision K11) and counted by the existing storage admission scan.

### 4.2 Endpoints

Every route calls `requireAuth`, validates IDs with regexes before spawning anything, and reaches
Python through the shared `web/lib/python-cli.mjs` (`execFile`, no shell, bounded stdin/stdout,
timeout + SIGKILL, fixed exit-code map as in `edit-document.mjs`, and an **allowlisted env**:
`PATH HOME LANG TZ TMPDIR JOBS_ROOT FONTCONFIG_FILE` plus non-secret `POTONGIN_EDITOR_*` /
`POTONGIN_RENDER_ENGINE` flags; never `APP_*`, `POTONGIN_SETTINGS_*`, `POTONGIN_LLM*` or
`*_API_KEY`). Only the AI task adds `engineProcessEnv(await loadLlmEnv())` (E11). Every **mutation** (all POST, PUT, DELETE, including the read-like POSTs
`preview/plan` and `preview/frame`, which cost CPU) checks Origin, Host and `Sec-Fetch-Site`
(`sameOriginMutation`) and streams and counts its body.

| Method and path (under `/api/jobs/:id`) | Purpose | Contract |
|---|---|---|
| `POST /clips` | Job-level prepare for jobs rendered before Essentials: writes `analysis/source.json`, computes the clip ids and writes each clip's immutable `seed.json`, words and peaks (§3.5) | Same-origin; idempotent; `202 {state}` |
| `GET /clips` | V3 clips of the job | `{clips:[{clipId, index, title, hookText, description, hashtags, durationMs, engine: "edit-v2/1"\|"legacy", edit:{state:"seed"\|"edited", revision, etag, updatedAtMs}, latestRender:{renderId, state, url, srtUrl, revision}\|null, openable, reason}]}`. For jobs rendered before Essentials, `clipId` is null with `reason: "needs_prepare"` until `POST /clips` has run. Other `reason` values (fixed codes with Indonesian messages): `source_missing`, `selection_unreadable`, `transcript_missing`, `analysis_incomplete` (`.attempts/` left), `not_v3` (V1/v2-shadow jobs; V2 candidates use the legacy editor and its "Buka di Editor V3") |
| `GET /clips/:clipId/edit` | Current document, or the seed as virtual revision 0 | `200 {doc, etag, seed, words:{sha256, url}, readOnly, readOnlyReason}` with `ETag` and `X-Edit-Seed: 1` for the seed. `?seed=1` always returns the seed (for "Kembali ke versi AI"). **No side effects.** `409 analysis_missing` when the words artifact does not exist yet (the client then calls `prepare`) |
| `PUT /clips/:clipId/edit` | Save the full document | `If-Match` required (428), `Idempotency-Key` UUID required, `Content-Type: application/json`, ≤ 1 MiB. `200 {doc, etag, warnings}`; `409 revision_conflict {current, etag}`; `409 idempotency_conflict`; `422 {errors:[{path, code}]}`; `426 schema_too_new` |
| `GET /clips/:clipId/words` | Words artifact | `ETag` = sha; `Cache-Control: private, max-age=31536000, immutable` |
| `POST /clips/:clipId/prepare` | Build missing artifacts (source info, words, peaks, camera for the requested layout) and enqueue the first plate cells | Body `{layout?}` ≤ 1 KiB; `202 {words, camera, plate:{state, ready, total}}`; idempotent |
| `POST /clips/:clipId/preview/plan` | Validate and resolve an **unsaved** document for preview | Body `{doc, known:{assSha256?}}` ≤ 1 MiB. `200 PlanDTO` (§4.3) or `422 {errors}`. Rate ≤ 10/s per session; a superseded request for the same clip is cancelled |
| `POST /clips/:clipId/preview/frame` | Truth frame | Body `{doc, f}`; `image/png` at the output size with ancillary chunks stripped; ≤ 4/s; cached by `(plan_sha, f)` |
| `GET /clips/:clipId/media/:kind/:name` | Plate cells, audio mixes, ASS, derived logos, peaks | `kind` ∈ {`plates`, `audio`, `ass`, `derived`, `peaks`}; `name` matches a content-hash regex; realpath containment; HTTP Range; `private, max-age=31536000, immutable`; `nosniff`; `Cross-Origin-Resource-Policy: same-origin`. ASS (which contains user text) is served as `text/plain; charset=utf-8` with `Content-Security-Policy: sandbox` |
| `POST /clips/:clipId/renders` | Enqueue an export | `Idempotency-Key`; body exactly `{"editEtag":"<64 hex>"}` ≤ 1 KiB (size and quality are fixed to the auto clip's in Essentials); storage reservation first (existing admission). `202 RenderDTO`, or `200` with `state:"completed"` when the document content equals the seed (R10) or the render key already exists |
| `GET /renders/:renderId` (extended) | Status of legacy and v3 requests | `RenderDTO {renderId, clipId\|candidateId, state, stage, progressPm, revision, errorCode, resultUrl, srtUrl}` |
| `DELETE /renders/:renderId` (new) | Cancel a v3 request | Same-origin; queued → `cancelled`; rendering → the worker kills FFmpeg within 2 s and marks `cancelled` |
| `POST /clips/:clipId/ai` | AI hook suggestions (§7) | Body exactly `{task:"hooks", doc}` (no provider, model or URL field is accepted; those come only from the sealed LLM settings); `202 {taskId, heuristic:[…], llm:{state:"pending"\|"disabled"\|"rate_limited"}}` |
| `GET /clips/:clipId/ai/:taskId` | Poll an AI task | `taskId` is a UUID (checked in Node and Python); `{state:"pending"\|"done"\|"failed", suggestions:[…], error:{code, messageId}\|null}` |
| `GET /clips/:clipId/cleanup` | Rapikan review list (§7.3) | Immutable per `(words sha, lexicon version)` |
| `GET /clips/:clipId/coldopen-suggestions` | Cold-open candidates (§7.2) | Immutable per words sha |
| `POST /assets` | Upload a logo or music file (§9.2) | Raw body; `Content-Type` allowlist; `Content-Length` required; `X-Asset-Kind: logo\|music`; `Idempotency-Key`; `201 {sha256, kind, mime, w, h, durationMs, lufsC, peaksUrl}` |
| `GET /assets/:sha` | Normalised asset bytes | §9.2 headers |
| `GET /api/resources/:kind/:name` (global) | Font files and pack JSON: **the same bytes libass uses** | `kind` ∈ {`fonts`, `caption-packs`, `hook-designs`}; immutable; the sha is checked against `resources/fonts/fonts.json` in tests |

### 4.3 Plan DTO (returned by `preview/plan`; also the contract between server, player and UI)

```json
{
  "planSha256": "…", "docSha256": "…", "compiler": "edit-v2/1", "renderSemantics": 1,
  "fps": [30000, 1001], "totalFrames": 1811, "output": {"w": 720, "h": 1280},
  "pieces": [{"i": 0, "seg": "seg_co", "role": "cold_open", "inSf": 38210, "outSf": 38345, "outF0": 0, "frames": 135},
             {"i": 1, "seg": "seg_b1", "role": "body", "inSf": 37215, "outSf": 37483, "outF0": 135, "frames": 268}],
  "cues": [{"f0": 135, "f1": 160, "text": "KAMU TAHU NGGAK", "words": ["w048121", "w048122", "w048123"]}],
  "hook": {"f0": 0, "f1": 120, "lines": ["Dia ditahan security", "di film-nya sendiri"], "overflow": false},
  "text": {"assSha256": "…", "ass": "[Script Info]…", "url": "/api/jobs/…/media/ass/<sha16>.ass",
           "fonts": [{"family": "Montserrat ExtraBold", "url": "/api/resources/fonts/Montserrat-ExtraBold.ttf", "sha256": "…"}]},
  "plate": {"plateKey": "…", "cellFrames": 60, "w": 720, "h": 1280,
            "cells": [{"k": 620, "state": "ready", "url": "/api/jobs/…/media/plates/<key16>-c0000620.mp4"},
                      {"k": 621, "state": "queued"}]},
  "logo": {"box": {"x": 560, "y": 26, "w": 115, "h": 115}, "opacityPm": 850,
           "url": "/api/jobs/…/media/derived/<sha16>@115x115.png"},
  "audio": {"mixSha256": "…", "state": "ready", "url": "/api/jobs/…/media/audio/<mix16>.flac",
            "samples": 2901901, "musicGainPoints": [[0, 0], [1440, 316228]], "speechSpans": [[0, 4320]]},
  "rev0": {"planSha256": "…", "autoRenderUrl": "/api/jobs/…/files/output/clip-03.mp4", "exact": true},
  "warnings": [{"code": "tight_cut", "ref": "rm_01", "f": 402}],
  "errors": []
}
```

- `text.ass` is omitted when `known.assSha256` equals the new sha. `cues` and `hook` exist only to
  draw the timeline and the transcript; pixels always come from the ASS.
- `audio.musicGainPoints` are the duck/fade breakpoints `[out_sample, gain_e6]`, used only to
  draw the envelope on the music lane. The audible gain comes from the server mix.
- `rev0.exact` is true only when `planSha256 == rev0.planSha256` and the auto render was produced
  by `edit-v2`. The player may then play `autoRenderUrl` while plate cells build.
- In Essentials `plate.w/h` always equals `output` (every job is 720×1280), so the preview
  resolution is the export resolution.

# Part 5. T1.0 resolutions

Where the plan is silent or leaves two readings, the choice below is binding for every task. The
names are pinned by `tests/test_edit_v2_contracts.py` (parameter names, kinds and defaults;
annotations may be spelled differently).

## 5.1 Where each name lives

| Module | Names | Owner |
|---|---|---|
| `ai_clipper.edit_v2` (`__init__`) | `COMPILER_VERSION`, `COMPILER_ID` (`"edit-v2/1"`), `RENDER_SEMANTICS`, `SCHEMA`, `SCHEMA_MINOR`, `WORDS_SCHEMA`, `CAMERA_SCHEMA`, `DOC_FPS`, `OUTPUT_SIZES`, `PACK_IDS`, `SWATCHES`, `PACK_DEFAULT_OVERRIDES` | T1.0 |
| `edit_v2.errors` | exceptions, code sets, `MESSAGES`, `message`, `message_id`, `base_code`, `exit_code_for`, `EXIT_*` | T1.0 |
| `edit_v2.timemap` | Appendix A names plus `SAMPLE_RATE`, `MIN_PIECE_FRAMES`, `div_round_half_up`, `speech_spans`, `logo_box`, `Fps.from_json`, `Fps.to_json`, `Piece.to_dto` | T1.0 |
| `edit_v2.clip_id` | `clip_id`, `is_clip_id`, `ms_from_seconds`, `CLIP_ID_PATTERN` | T1.0 |
| `edit_v2.doc` | `MAX_DOC_BYTES`, `Issue` (+`to_json`), `Validation` (+`ok`), `parse_doc`, `canonical_bytes`, `doc_sha256`, `content_sha256`, `content_equals_seed`, `validate_doc` | T1.1 |
| `edit_v2.store` | `get`, `seed`, `put`, `archive_for_render`, `prune_receipts`, the §4.1 path constants | T1.1 |
| `edit_v2.api` | `OPS`, `main` (CLI) | T1.1 |
| `ai_clipper.subtitles` (additions) | `SourceWord`, `FrameWord`, `FrameCue`, `build_frame_cues` | T1.2a |
| `ai_clipper.captions_ass` (additions) | `CaptionPack`, `load_pack`, `HookSpec`, `build_ass_v2` | T1.2a |
| `edit_v2.captions` | `CaptionResult`, `caption_track` | T1.2a |
| `edit_v2.glyphs` | `missing_glyphs`, `advance_px` | T1.2a |
| `edit_v2.envelope` | `Envelope`, `speech_envelope`, `music_envelope`, `expand_f32` | T1.4 |
| `edit_v2.audio_graph` | `AudioFragment`, `audio_fragment`, `SOURCE_AUDIO_LABEL`, `OUTPUT_LABEL`, `LABEL_PREFIX`, `AUDIO_MODES` | T1.4 |
| `edit_v2.loudness` | `Loudness`, `parse_ebur128`, `master_gain`, `needs_measurement`, `output_gain` | T1.4 |
| `edit_v2.plan` | `Resources`, `RenderPlan`, `build_plan`, `render_key` | T1.3 |
| `edit_v2.compile_ffmpeg` | `MODES`, `QUALITIES`, `InputSpec`, `FfmpegJob`, `compile_job` | T1.3 |
| `edit_v2.layouts` | `LAYOUT_MODES` (the builders are internal to T1.3) | T1.3 |
| `edit_v2.execute` | `ExecResult`, `run` | T1.3 |
| `edit_v2.verify` | `VerifyReport`, `verify_output` | T1.3 |
| `edit_v2.derive` | `derive_image` | T1.3 |
| `edit_v2.source_info`, `.peaks`, `.words`, `.camera`, `.seed` | Appendix A names | T1.5 |
| `edit_v2.render_edit` | `render_document`, `render_request` | T2.1 (W2) |

`content_equals_seed` appears under both T1.1 and T1.3 in plan §11.1: it lives in `doc.py`
(T1.1); T1.3 consumes it and may add vector tests in its own test files.

## 5.2 Additional frozen signatures and types

```python
# timemap.py (T1.0)
SAMPLE_RATE = 48_000
MIN_PIECE_FRAMES = 2
class Fps:                                   # frozen, slots; num, den positive ints
    @classmethod
    def from_json(cls, value: object) -> Fps          # Fps or [num, den]
    def to_json(self) -> list[int]
class Piece:                                 # frozen, slots
    def to_dto(self) -> dict                 # {"i","seg","role","inSf","outSf","outF0","frames"} (§4.3)
def div_round_half_up(numerator: int, denominator: int) -> int          # halves toward +inf
def speech_spans(words: Sequence[tuple[int, int]], pieces: Sequence[Piece], fps: Fps,
                 rate: int = 48_000) -> tuple[tuple[int, int], ...]
def logo_box(*, x_e5: int, y_e5: int, w_e5: int, asset_w: int, asset_h: int, out_w: int,
             out_h: int) -> tuple[int, int, int, int]                    # x0, y0, w_px, h_px

# clip_id.py (T1.0)
CLIP_ID_PATTERN = re.compile(r"clip_[0-9a-f]{24}")
def is_clip_id(value: object) -> bool
def ms_from_seconds(seconds: float) -> int   # round_half_up(seconds·1000) on the decimal repr

# doc.py (T1.1)
class Issue:
    def to_json(self) -> dict                # {"code","path"} + "ref"/"f" when not None
class Validation:
    ok: bool                                 # property: no errors

# plan.py (T1.3)
@dataclass(frozen=True)
class Resources:
    root: Path                               # resources/ (/app/resources in the image)
@dataclass(frozen=True)
class RenderPlan:                            # the first nine fields are frozen, in this order
    doc: Mapping[str, Any]
    fps: Fps
    output: tuple[int, int]                  # (w, h) of the document
    pieces: tuple[Piece, ...]
    total_frames: int
    total_samples: int                       # smp(total_frames, fps)
    speech_spans: tuple[tuple[int, int], ...]
    assets: Mapping[str, Mapping[str, Any]]  # doc["assets"]
    plan_sha256: str
    def to_json(self) -> dict

# compile_ffmpeg.py (T1.3)
MODES = ("final", "reference", "plate_cells", "frame", "audio_preview", "audio_measure",
         "derive_image")
QUALITIES = ("standar",)
@dataclass(frozen=True, slots=True)
class InputSpec:
    kind: str                                # "source" | "asset" | "sidecar"
    name: str                                # "source" | "sha256:<hex>" | sidecar name
    options: tuple[str, ...] = ()            # input options placed before -i
@dataclass(frozen=True)
class FfmpegJob:
    argv: tuple[str, ...]
    filter_script: str
    inputs: tuple[InputSpec, ...]
    sidecars: Mapping[str, bytes]
    expected: Mapping[str, Any]

# audio_graph.py (T1.4)
SOURCE_AUDIO_LABEL = "sa{i}"; OUTPUT_LABEL = "apre"; LABEL_PREFIX = "au_"
AUDIO_MODES = ("final", "reference", "audio_preview", "audio_measure")

# loudness.py (T1.4)
def needs_measurement(doc: Mapping) -> bool
def output_gain(doc: Mapping, measured: Loudness | None) -> tuple[int, tuple[Issue, ...]]

# derive.py (T1.3)
def derive_image(asset: Path, *, w: int, h: int, opacity_pm: int,
                 timeout_s: float = 20.0) -> bytes

# api.py (T1.1)
OPS = ("clips", "prepare_job", "get", "put", "seed", "archive")
def main(argv: Sequence[str] | None = None) -> int

# layouts.py (T1.3)
LAYOUT_MODES = ("fit_blur", "camera", "fill_center")
```

`ExecResult` and `VerifyReport` are placeholders whose fields T1.3 defines (no other W1 task reads
them). `RenderPlan` fields after the first nine, and `Resources` fields after `root`, may be
added by T1.3, each with a default (the fixture plan builder constructs `RenderPlan` with the
nine fields).

## 5.3 Errors, exit codes, HTTP status and messages

| Exception | Default code | HTTP | CLI exit |
|---|---|---|---|
| `EditV2Error` | `internal_error` | 500 | 1 |
| `DocInvalid` | `invalid_json` (any parse code) | 422 | 3 |
| `NotFound` | `not_found` | 404 | 4 |
| `RevisionConflict(current=, etag=)` | `revision_conflict` | 409 | 5 |
| `DocSemanticInvalid` | `range_invalid` (any semantic code) | 422 | 6 |
| `SchemaTooNew` | `schema_too_new` | 426 | 7 |
| `AnalysisMissing` | `analysis_missing` | 409 | 8 |
| `IdempotencyConflict` | `idempotency_conflict` | 409 | 9 |
| `RenderFailed` | `render_failed` (also `render_timeout`, `render_stalled`) | 500 | 10 |
| `VerificationFailed` | `verification_failed` | 500 | 11 |
| `Cancelled` | `cancelled` | 409 | 12 |

Exit 0 is success and 2 a usage error. Every exception carries `.code`, `.path` (JSON pointer or
None), `.ref` (an id or None) and `.issues` (every `doc.Issue`, for a 422 that lists them all).

Code sets in `errors`: `PARSE_CODES` and `SEMANTIC_CODES` (plan §3.7), `WARNING_CODES`,
`PROTOCOL_CODES` (`schema_too_new`, `revision_conflict`, `idempotency_conflict`, `not_found`,
`analysis_missing`, `internal_error`), `RENDER_CODES` (`render_failed`, `render_timeout`,
`render_stalled`, `verification_failed`, `cancelled`, `auto_file_unavailable`,
`engine_fallback`), `CLIP_REASONS` (§4.2), `READ_ONLY_REASONS` (`transcript_changed`) and
`NOTICE_CODES` (`legacy_engine`, `markers_unavailable`). `MESSAGES` maps every code to its
Indonesian message (id `edit.<code>`); `message("glyph_unsupported:U+1F602")` appends the detail
after the colon in parentheses. A new code needs its message in `errors.py` (request it through
the integrator).

## 5.4 Validation: order, code assignment and exact rules

**`parse_doc` (parse level, raises on the first problem):**

1. More than `MAX_DOC_BYTES` bytes → `too_large` (checked before decoding).
2. Not UTF-8, a UTF-8 BOM, not JSON, or a top level that is not an object → `invalid_json`.
3. A duplicate key at any level → `duplicate_key`. Any number with a fraction or an exponent
   (`1.0`, `8e0`) and `NaN`, `Infinity`, `-Infinity` → `float_not_allowed`. When a document has
   several such problems, the first in document order wins.
4. `schema_minor` an integer > 0 → `SchemaTooNew` (426), checked before unknown keys because a
   newer minor adds keys.
5. A key not in §5.5 at any level → `unknown_key` (Stage 2 keys such as `markers`,
   `layout.ranges`, `audio.source.mute`, `captions.offset_ms`, `payload.params` are unknown at
   minor 0). The key sets of a track, of its items and of their `transform` and `payload` are
   chosen by the **track's `kind`** (`hook` → the hook shapes, `visual` → the image shapes,
   `audio` → the audio shapes; any other kind → the union of the three), never by the item's
   `type`, so a wrong `type` is a semantic `range_invalid`. An anchor (`start`, `end`) allows the
   union `{at, f, word, edge, offset_f, seg}`; which combination is valid is semantic. An
   `assets` entry's keys are chosen by its `kind` (`image` or `audio`; otherwise the union).
6. Any string (keys included) with a Cc or Cs character → `control_char`; not NFC →
   `not_nfc`.

**`validate_doc` (semantic level, reports every issue):** checks that depend on an invalid value
are skipped, so one violation never cascades into issues with other codes (e.g. a string `in_sf`
yields `range_invalid` only, with no duration or window issue).

- **`range_invalid`** is the catch-all: wrong JSON type, missing required key, pattern mismatch
  (ids, sha, colours, UUID), value out of range, enum value that no stage defines, text length or
  whitespace rule, duplicate id, list over an Essentials limit that is not a Stage 2 limit
  (removals > 2,000, `word_edits` > 6,000, removal `words` > 400), an item type that does not
  match its track, an `assets` entry nobody references or whose metadata differs from the store.
  A value that fails its pattern is not looked up further (a malformed word id is
  `range_invalid`, not `unknown_word`).
- **`op_disabled`** is exactly: a Stage 2/3 value of FINAL that Essentials does not enable, or a
  count beyond Essentials but within FINAL. The complete list: segment role `insert` or more than
  two segments; join style `flash_white`, `dip_black`, `xfade`; removal reason `gap_voiced`,
  `ai_condense`, `timeline`; track kind `text`; a second track of a kind or more than three
  tracks; more than one item in a track; visual band `under_text`; visual role `broll`; audio
  role `sfx`, `voice`; item types `text`, `credit`, `label`, `sticker`, `emoji`, `video`,
  `effect`; an anchor `{"at": "word", …}` or a hook start with `f` ≠ 0; hook design other than
  `{"id": "legacy-bar", "v": 1}`; logo `payload.mode` `pip`, `cutaway`, `split_top`,
  `split_bottom`; `captions.overrides.case` `lower`, `sentence`; layout mode `smart_speaker`,
  `fit_black`, `split`, `branded`; `no_face` `fail`, `fit_blur`; duck detector `rms`.
- **`pack_unknown`**: `captions.pack.id` (a string) not in `PACK_IDS`, or `v` (an int) ≠ 1.
- **`base_changed`** (only when `seed` is given): any difference from the seed in `base`,
  `output`, `clip_id` or `audit.created_at_ms` (the plan fixes all four at seed time).
- **Revisions.** `validate_doc`: revision 0 ⇔ `parent_sha256` null, otherwise
  `parent_mismatch`. `store.put`: `revision == current + 1` else `revision_mismatch`;
  `parent_sha256 == current etag` else `parent_mismatch` (both 422).
- **`outside_window`**: with `window_sf = [sf_floor(window_ms[0]), sf_ceil(window_ms[1])]`, every
  segment needs `window_sf[0] ≤ in_sf` and `out_sf ≤ window_sf[1]` (frame-covering, so a seed
  that ends at the end of the source is inside). The seed narrows `window_ms` to the source-grid
  frames that exist (§5.6, §5.16), so `window_sf` never reaches a frame the compiler cannot
  decode.
- **Segments**: 1–2 items, exactly one `body` (zero or two bodies → `range_invalid`),
  `in_sf < out_sf` (`range_invalid`).
- **`duration_out_of_bounds`**: the body's frames after removals and dropped slivers (Σ of its
  `timemap.pieces`) must satisfy `sf_ceil(3000) ≤ frames ≤ sf_floor(300000)`.
- **`cold_open_invalid`**: at most one cold open and it is `segments[0]`; its frames after
  removals within `[sf_ceil(500), sf_floor(8000)]`; `|co.in_sf − body.in_sf| ≥ 1`; with
  `L = co.out_sf − co.in_sf`, the overlap of `[co.in_sf, co.out_sf)` with
  `[body.in_sf, body.in_sf + L + 2·num/den)` (rational end) must not exceed 80% of `L`
  (`5·overlap > 4·L` is invalid); `joins` holds exactly one item when a cold open exists and none
  otherwise, and that item's `after` is the cold open's id.
- **Removals**: `in_sf < out_sf` (`range_invalid`); `seg` names a segment and
  `[in_sf, out_sf)` lies inside it (`removal_outside_segment`); within one segment, in array
  order, each removal starts at or after the previous one's `out_sf` (unsorted or overlapping →
  `removal_overlap`; touching is allowed); `words` exist in the words artifact
  (`unknown_word`); `reason` ∈ {`user`, `filler`, `repeat`, `gap_silent`}; `origin` is `user` or
  `suggestion:<id>`.
- **`word_edits`**: keys exist in the words artifact (`unknown_word`); values have 1–3 of
  `text` (1–40 code points, NFC, no leading or trailing whitespace), `hidden`, `emphasis`
  (booleans).
- **Hook item**: `dur_f` 15…`sf_floor(30000)`; `transform` exactly `{x_e5: 50000, y_e5:
  6000…40000}`; `payload.text` 1–90 code points without leading or trailing whitespace.
- **Logo item**: `x_e5`, `y_e5` 0…100000, `w_e5` 4000…40000, `opacity_pm` 200…1000;
  `timemap.logo_box` with the asset's `w`/`h` and the document's output size must give
  `x0 ≥ 0`, `y0 ≥ 0`, `x0 + w ≤ W`, `y0 + h ≤ H`, else `item_out_of_frame`.
- **Music item**: `src_in_smp` 0…`duration_ms·48 − 1`; `gain_cdb` −4800…600; `fade_in_f`,
  `fade_out_f` 0…`sf_floor(10000)`; `duck` complete: `depth_cdb` 300…2400, `attack_ms` 5…500,
  `release_ms` 50…2000, `hold_ms` 0…1000, `detector` `words`.
- **`asset_missing`**: an item's asset is not a key of the document's `assets`, or the store
  (`validate_doc(assets=…)`) lacks it.
- **Ids**: segments, removals, tracks and items match `^[a-z]{2,3}_[0-9a-z]{1,16}$` and are
  unique across the whole document (one namespace).
- **Audit**: `created_at_ms` int ≥ 0; `updated_at_ms` int ≥ `created_at_ms` (stamped by the
  server on PUT); `editor` 1–64 code points; `last_command` `^[A-Za-z]{1,40}$`.

**Warnings computed by `validate_doc`** (others come from captions, camera and audio):
`tight_cut` (a removal or segment edge equal to the `sf` of a `bounds` entry with
`tight: true`; `ref` = the removal or segment id, `f` = the output frame of the cut),
`laughter_cut` (a removal edge whose frame start lies inside a laughter event span or within 300 ms
of a laughter point) and `music_shorter_than_clip` (loop off and
`duration_ms·48 − src_in_smp < total output samples`).

## 5.5 Document structure (schema_minor 0; every key required unless marked optional)

```
root      schema "clip-edit-v2" · schema_minor 0 · clip_id ^clip_[0-9a-f]{24}$ · revision int≥0
          · parent_sha256 sha|null · base · output · main · captions · layout · tracks · audio
          · assets · audit
base      job_id (lowercase UUID) · source · origin · window_ms [a,b] (0≤a<b≤duration_ms)
          · words {sha256, count int≥0} · camera {sha256 sha|null} · seed_sha256 sha
          · engine {compiler "edit-v2/1"|"legacy", render_semantics int≥1}
  source  content_sha256 · w · h (16…8192) · fps_native [num,den] (positive ints) · vfr bool
          · duration_ms int≥1 · has_audio bool
  origin  kind "v3_clip" · selection_artifact_sha256 · selection_version (1–40 chars)
          · rank_at_seed int≥1 · hook_unit_id (1–16 chars)|null · selection_source "llm"|"heuristic"
output    w · h ((720,1280)|(1080,1920)) · fps (one of DOC_FPS) · sample_rate 48000 · channels 2
main      segments · removals · joins · cut_fade_ms 0…50
  segment id · role "cold_open"|"body" · in_sf · out_sf (ints ≥ 0)
  removal id · seg · in_sf · out_sf · words [word id] · reason · origin
  join    after · style "cut" · audio_fade_ms 0…250
captions  enabled bool · pack {id, v} · overrides {y_e5, size_pm, case, highlight, emphasis}
          · word_edits {<word id>: {text?, hidden?, emphasis?}} (values: 1–3 keys)
layout    default {mode, no_face "center"}
tracks    hook   {id, kind "hook", items}
          visual {id, kind "visual", band "over_text", role "overlay", items}
          audio  {id, kind "audio", role "music", items}
  hook    {id, type "hook", start {at "out", f 0}, dur_f, transform {x_e5, y_e5},
           payload {text, design {id "legacy-bar", v 1}}, origin}
  image   {id, type "image", start {at "clip_start"}, end {at "clip_end"},
           transform {x_e5, y_e5, w_e5, opacity_pm}, payload {asset, mode "free"}, origin}
  audio   {id, type "audio", start {at "clip_start"}, end {at "clip_end"},
           payload {asset, src_in_smp, loop, gain_cdb, fade_in_f, fade_out_f,
                    duck {on, depth_cdb, attack_ms, release_ms, hold_ms, detector}}, origin}
  origin  "seed" | "user" | "suggestion:<id>"   (removals: "user" | "suggestion:<id>")
audio     source {gain_cdb −2400…1200} · master {mode "off"|"normalize",
          target_clufs −2400…−900, tp_cdb −300…0}
assets    {"sha256:<64 hex>": {kind "image", mime "image/png", w, h (1…4096)}
                            | {kind "audio", mime "audio/mp4", duration_ms int≥1, lufs_c int}}
audit     created_at_ms · updated_at_ms · editor · last_command
```

`origin.kind` `"v2_candidate"` is reserved for T4.1 (`seed_from_candidate`) and is not valid
in W1. Canonical bytes, hashes and the document size limit are as in §3.1.

## 5.6 Seed specifics (T1.5)

- `base.seed_sha256` = sha256 of the canonical bytes of the seed with `base.seed_sha256` set to
  `null` **and without `audit`** (a document cannot contain its own hash; revision ≥ 1 copies
  `base` unchanged). W1 integration: the seed time is not content (R9), so identical content
  gets the same `plan_sha256` and render key whenever it was seeded (`seed.seed_sha256`).
- Revision 0, `parent_sha256` null; `audit` = `{created_at_ms = updated_at_ms = seed time,
  editor "pipeline/edit-v2/1" (prepare of an older job: "prepare/edit-v2/1"),
  last_command "Seed"}`.
- Segment ids `seg_co` (cold open) and `seg_b1` (body), edges `sf_floor(start_ms)` and
  `sf_ceil(end_ms)` with `start_ms = ms_from_seconds(start)`, **clamped to the source grid**
  `[first_sf, end_sf)` of `source.json` (§5.16); join
  `{"after": "seg_co", "style": "cut", "audio_fade_ms": 30}`; `cut_fade_ms` 8; `removals` [].
- `base.window_ms` = §3.5's window, then narrowed to the grid:
  `[max(a, ⌈first_sf·1000·den/num⌉), min(b, ⌊end_sf·1000·den/num⌋)]`
  (`seed.grid_window_ms`), so `window_sf` is exactly the frames that exist at the source edges.
- `captions`: `enabled` true, `pack {id, v: 1}`, `overrides = PACK_DEFAULT_OVERRIDES[pack]`
  (every pack: `y_e5` 83000, `size_pm` 1000, `case` `asis` (`upper` for `bold`),
  `highlight` `#FFE14D`, `emphasis` `#FF5C8A`), `word_edits` {}.
- Hook: track `{"id": "tr_hook", "kind": "hook"}` with item `it_hook`, origin `seed`,
  `dur_f = round_half_up(hook_duration_ms · num / (1000·den))`,
  `hook_duration_ms = ms_from_seconds(hook_duration)`.
- `assets` {}; `audio` `{source {gain_cdb 0}, master {mode "off", target_clufs −1400,
  tp_cdb −100}}`; `base.words` = sha256 of the words file bytes and the word count;
  `base.camera.sha256` = sha256 of the camera plan file bytes (face-track only), else null.

## 5.7 Words artifact, peaks and camera plan (T1.5 → T1.1, T1.2a, T1.3, W2, W3)

**Words** (`potongin.words/1`): stored as its canonical bytes (§3.1 encoding) in
`words.<sha16>.json`, `sha16` = the first 16 hex of the sha256 of those bytes. Every key of the
§3.6 example is present (lists may be empty) plus `missing`:

- `words[]` `{id, s, e, t, p_pm (int 0…1000 | null), u (unit id | null), z}` in start order
  with increasing ids;
- `units[]` `{id, s, e, q}`;
- `bounds[]`: `len(words) + 1` entries in order: `{after: null, before: <first>}`, one per
  adjacent pair `{after: a, before: b}`, `{after: <last>, before: null}`; each with `sf`,
  `tight` and `rms_cdb` (level of the chosen 10 ms bin in centi-dBFS, or null);
- `gaps[]` for gaps > 600 ms: `{after, s, e, class}` with class `laughter`, `silent` or
  `voiced`;
- `events[]` `{kind, s, e, src}` (`kind` from `sound_events.KINDS`, `s == e` for points,
  `src` `yt-caption` or `transcript`), sorted by `s`;
- `silences` `[[s, e], …]` and `scene_cuts_ms` sorted; `peaks` `{file, per_sec: 100,
  start_ms: window_ms[0]}`;
- `missing`: sorted subset of `["audio_timeline", "sound_events"]`.

**Peaks** (`peaks.<sha16>.bin`): mono, decoded once at 8 kHz; per bin of `1000/per_sec` ms from
`window_ms[0]`, two signed bytes `(min, max)` = the bin's s16 extremes divided by 256 (floor);
`ceil((b − a) · per_sec / 1000)` bins.

**Camera plan** (`potongin.camera-plan/1`, canonical bytes, `camera.<sha16>.json`):
`{schema, source_content_sha256, window_ms, fps [num, den], source {w, h}, output {w, h},
sample_ms: 750, samples [[t_ms, center_pm], …], cuts [bool, …], no_face [[s_ms, e_ms], …]}`.
`t_ms` is absolute source time; `center_pm = round_half_up(smoothed normalised x centre ·
1000)`; `cuts` is parallel to `samples`; `no_face` lists runs without a detection longer than
1,500 ms. T1.3 interpolates like `face_tracking.build_crop_expression` (linear between
samples, held across a cut) and turns the result into an integer, even crop x per source-grid
frame.

## 5.8 RenderPlan and the T1.3/T1.4 audio seam

- `RenderPlan.speech_spans` = `timemap.speech_spans([(w["s"], w["e"]) for w in
  words["words"]], pieces, fps)`: every word occurrence (hidden words included) in output
  samples, sorted, not merged. The plan DTO's `audio.speechSpans` carries the same values.
- **Source audio in.** When `base.source.has_audio`, `compile_job` provides one label per piece,
  `[sa0]`, `[sa1]`, …: the source's first audio stream from that piece's decoder run, as decoded
  (native layout and rate), timestamps untouched (`-copyts`), no filter applied. Without source
  audio no `[sa<i>]` exists and the fragment generates silence with the exact sample count.
- **Fragment inputs.** The fragment's own inputs are `[<first_input_index + k>:a]` for the k-th
  `InputSpec` of `AudioFragment.inputs`; sidecar names match `audio-[a-z0-9-]+\.[a-z0-9]+` and
  internal labels start with `au_`.
- **Out.** Exactly one label, `[apre]`: the pre-master mix at 48 kHz stereo, the same in all
  four audio modes. `compile_job` appends the master stage: gain `g` from
  `loudness.output_gain(doc, measured)` (no volume filter when `g == 0`), then
  `aresample=48000`; in `audio_measure` it appends `ebur128=peak=true` instead.
  `measured` is `None` exactly when `loudness.needs_measurement(doc)` is false (revision 0 is
  never measured).
  - *W1 integration (T1.Z):* the stage text comes from `audio_graph.master_filter(mode, g)`:
    `volume=<g>dB,aresample=48000` (`aresample=48000` when `g == 0`), and in `audio_measure`
    `aformat=sample_fmts=dbl,ebur128=peak=true:framelog=verbose`, run at `-loglevel info` and
    parsed by `loudness.parse_ebur128` (`framelog=verbose` keeps the per-frame lines out of
    the info log).
  - *Encode headroom (approved at W1):* `loudness.ENCODE_HEADROOM_CDB = 100`. Both true-peak
    ceilings (the document's `tp_cdb` and the −1.0 dBTP of peak protection) are applied 1.0 dB
    lower on the pre-encode mix, because G3/G3b check the decoded AAC export and the AAC-LC
    192k encode adds +0.4 to +0.6 dB of true peak. `output_gain` still never exceeds
    `−100 − TP`; a protected mix is mastered to −2.0 dBTP.
  - *Warnings carry their value after the colon:* `loudness_clamped:-16.30 LUFS` (the loudness
    reached, path `/audio/master`) and `peak_reduced:-3.80 dB` (the reduction, path
    `/audio`); `errors.message()` renders them as `<message> (-3.80 dB)`.
- **Piece chain (W1 integration).** Each piece is
  `[sa<i>]aresample=48000,asettb=1/48000,apad,atrim=start_pts=<a>:end_pts=<b>,pan=stereo|FL=FL+FC|FR=FR+FC,asetpts=PTS-STARTPTS`:
  the `pan` follows the trim (plan §5.3 lists it first). Every `[sa<i>]` carries its whole
  decoder run, and a `pan` before the trim kept that audio queued in every finished piece
  (FFmpeg 6.1, 150 pieces over 108 s: 2.47 GiB and a stalled render against 100 MiB).
- Observation for T1.4 (FFmpeg 6.1.1): `pan=stereo|FL=FL+FC|FR=FR+FC` maps a mono source to
  both channels at full gain and keeps a stereo source unchanged, with no channel count needed.
  Whether it is used is T1.4's decision.

## 5.9 CLI protocol (`edit_v2.api` and every edit_v2 CLI)

stdin is one JSON envelope `{"op": <op>, …}` with camelCase arguments; ids (`jobId`,
`clipId`, `renderId`, `taskId`, idempotency keys) are validated by regex before use; paths are
never accepted: the job directory is `$JOBS_ROOT/<jobId>`; document bytes travel base64-encoded
(`docRaw`) so they are validated exactly as received. stdout is one JSON object; a failure writes
`{"error": {"code", "path", "ref", "messageId"}}` (plus `current` and `etag` for a revision
conflict) and exits with the §5.3 code. T1.1 writes the per-op argument and result tables in
the `api.py` docstring; the integrator copies them here.

**`python -m ai_clipper.edit_v2.api` (T1.1, copied at the W1 integration).** The envelope is
≤ 2 MiB with no duplicate keys and exactly the keys of its op. Exit 2 is used **only** for a
malformed envelope (error code `internal_error`); anything unexpected after a valid envelope
(corrupt stored data included) is exit 1. `JOBS_ROOT` unset is exit 1.

| Op | Arguments | Result |
|---|---|---|
| `clips` | `{jobId}` | `{clips: [{clipId, index, title, hookText, description, hashtags, durationMs, engine, edit, latestRender, openable, reason}]}`. Read-only. V3 clips come from `analysis/selection.v3.json` in rank order (`index` = rank = the `clip-NN` number); without a readable selection, or for a non-V3 job, the manifest's clips are listed. `clipId` needs `analysis/source.json`; `engine` is the seed's `base.engine.compiler`; `edit` is `{state: "seed"\|"edited", revision, etag, updatedAtMs}` when `seed.json` exists, else null; `durationMs` is the current document's length (else the selection's); `latestRender` is null until T2.2; `openable` is true exactly when the seed and the source file exist. `reason`, first match: `not_v3`, `analysis_incomplete`, `selection_unreadable`, `source_missing`, `transcript_missing`, `needs_prepare` |
| `prepare_job` | `{jobId}` | `{state: "done", clips: [{clipId, index, openable, reason}]}` through `seed.prepare_legacy_job(job_dir)`; idempotent |
| `get` | `{jobId, clipId}` | `{doc, etag, isSeed, seed, seedEtag, engine ("edit-v2/1"\|"legacy"), notices (["legacy_engine"] for a prepared older job), words: {sha256, url}, readOnly, readOnlyReason}`. Writes nothing. `readOnly` with `readOnlyReason: "transcript_changed"` when the document's `base.words.sha256` is not the seed's. Exit 8 (`analysis_missing`) without the words artifact |
| `seed` | `{jobId, clipId}` | the same shape for the seed itself (`?seed=1`) |
| `put` | `{jobId, clipId, expectedEtag, idempotencyKey, docRaw}` | `{doc, etag, warnings: [{code, path, ref?, f?}]}`; `expectedEtag` is the `If-Match` value (64 lowercase hex), `idempotencyKey` a UUID, `docRaw` the body in base64 |
| `archive` | `{jobId, clipId, etag}` | `{relative, revision}`: the job-relative path of that revision for a render request (`seed.json` for revision 0), archiving the current revision when needed |

**Job asset-store metadata (pinned for T3.1).** `store.load_assets` reads
`analysis/assets/<hex>.json` in document form, snake_case, extra keys ignored:
`{kind: "image", mime, w, h}` or `{kind: "audio", mime, duration_ms, lufs_c}`. It is not the
camelCase shape of the `POST /assets` response.

## 5.10 Time map semantics

- `pieces(doc)` subtracts the union of each segment's removals (clamped to the segment), drops
  remaining sub-ranges shorter than two frames and lays pieces out from frame 0; removals naming
  another segment are ignored (the validator reports them); a segment with `in_sf ≥ out_sf` or a
  removal with `in_sf ≥ out_sf` raises `ValueError`, non-integers `TypeError`.
- `word_frames` returns the frames in the **first piece, in output order,** whose source span
  contains the word's midpoint; pass one segment's pieces to get that segment's occurrence. Both
  frames are clamped to the piece and `n_off ≥ n_on` (zero-length results are possible).
- `now_ms(n) = int(float(n) * (den / num) * 1000)`; `settb=den/num` yields exactly that time base
  on FFmpeg 5.1.9 and 6.1.1. `safe_cs(0)` is −1: ASS writers clamp it to 0 (still visible from
  frame 0 since `now_ms(0) == 0`). Measured: 0 failures over 3 h at 24, 25, 30, 50, 60,
  24000/1001, 30000/1001 and 60000/1001 (margins ≥ 2 ms); FFmpeg's `ass` filter switches exactly
  at `now_ms` on the hazard frames (evidence `docs/editor/evidence/W1/T1.0-now_ms.json`).
- `logo_box` computes §3.4's box from integers; the box may lie partly outside the frame (the
  validator reports `item_out_of_frame`).

## 5.11 Document fixtures (`tests/fixtures/edit_v2/docs/`)

- `contexts/<id>.words.json` and `contexts/<id>.seed.json` (canonical bytes) for `c30`
  (30000/1001, 720×1280, cold open, hook, karaoke, fit_blur), `c25` (25/1, 720×1280, 200 s body,
  classic, camera, no hook, no `sound-events.json`) and `c24` (24000/1001, 1080×1920, window
  clamped at both source ends, cold open, hook, fill_center); `contexts/assets.json` is the job
  asset store in document form.
- `valid/<name>__<context>.json` and `invalid/<code>__<variant>.json`: every invalid document
  differs from a valid one by exactly one targeted violation. The file stem up to `__` is the
  expected code.
- `index.json`: `{schema, put_now_ms, assets, contexts {id: {words, seed}}, fixtures [{file,
  context, check, code, path} | {file, context, check, warnings}]}`.
- `check: "put"`: `store.put` onto a clip directory whose only document is the context's
  `seed.json` (virtual revision 0), with `expected_etag = sha256(canonical(seed))`, any
  idempotency key and `now_ms = put_now_ms`. Valid → saved; `warnings` lists codes the result
  must include (it may include more). Invalid → the raised error's code equals `code`, every
  reported issue has that code, and one of them has `path` as its JSON pointer (`""` for
  document-level parse errors). Each invalid fixture breaks exactly one rule, so no other code
  may appear; a disagreement with a fixture goes to the integrator, not into the validator.
- `check: "validate"`: `parse_doc` then `validate_doc(doc, words=…, assets=…, seed=None)`
  (used for the seeds themselves).
- Regenerate with `PYTHONPATH=src:tests python -m support.edit_v2_fixtures --write`; the tests fail
  when the committed files differ from a fresh render.

## 5.12 Time-map vectors (`tests/fixtures/edit_v2/timemap-vectors.json`)

Written by `scripts/edit_v2/gen_timemap_vectors.py` (`--write`, `--check`) from independent
reference arithmetic (`Fraction`, frame-by-frame expansion); one compact JSON value per line.
`cases[]`: `{name, fps, doc, pieces (DTO names), total_frames, out_to_src [[n, i, sf]],
word_frames [{scope (null = all pieces, else a segment id), s_ms, e_ms, expect [on, off] | null}],
speech_words [[s, e]], speech_spans [[a, b]]}`; scalar lists `smp` (`in [num, den, n, rate]`),
`sf_floor`, `sf_ceil` (`in [num, den, ms]`), `now_ms` (`in [num, den, n]`, `hazard`), `safe_cs`,
`cell_frames` (`in [num, den]`), `div_round_half_up` (`in [numerator, denominator]`),
`logo_box` (`in` = keyword arguments); `counts.total` = 2,220 checks. All integers are below
2^53, so the browser mirror can read them as Numbers.

## 5.13 Test support (`tests/support/`, `tests/conftest.py`)

- `support.edit_v2_media`: `VideoSpec`, `AudioSpec`, `ToneBurst`, `Pattern`,
  `make_barcode_video`, `make_audio`, `make_logo_png`, `render_pcm`, `render_luma`,
  `read_gray_frames`, `read_pcm`, `probe`, `frame_times_ms`, `grid_indices`, `decode_index`,
  `decode_ruler`, `decode_crop_x`, `find_clicks`, `audio_samples`, `default_bursts`,
  `default_clicks`, `reference_toolchain_problem`, `ffmpeg_has_filter`; CLI
  `python -m support.edit_v2_media self-check OUT.json`. Frame layout: 27 index bands (white
  sync, black sync, 24 bits MSB first, even parity), then `ruler_bits` Gray-code bands of the
  source column, then a grey background; `band_h = max(4, (height // 64) & ~1)`; luma 235/16.
- `support.edit_v2_fixtures`: `Context`, `FixtureCase`, `CONTEXT_IDS`, `load_context`,
  `load_cases`, `load_index`, `build_context`, `canonical_bytes`, `sha256_hex`, `etag`,
  `asset_store`, `make_render_plan`, the asset ids `LOGO`, `LOGO_WIDE`, `MUSIC`, `MUSIC_SHORT`,
  `LOGO_NOT_IN_STORE`.
- `tests/conftest.py` (fixtures only, never autouse): `edit_v2_ffmpeg`, `edit_v2_libass`,
  `edit_v2_reference_toolchain`, `edit_v2_media_factory`, `edit_v2_doc_contexts`,
  `edit_v2_doc_cases`.

## 5.14 Pinned-toolchain tests and evidence

- A test that is only meaningful on the pinned toolchain requests the fixture
  `edit_v2_reference_toolchain`: it skips elsewhere with the reason from
  `reference_toolchain_problem()` (FFmpeg 5.1.9, libass 0.17.1, freetype 2.12.1, harfbuzz 6.0.0,
  fribidi 1.0.8, fontconfig 2.14.1 via `dpkg-query`). Its gate is still measured in
  `ai-video-clipper:editor-ref`:
  `docker run --rm --user 1000:1000 -v "$PWD":/w -w /w -e PYTHONPATH=/w/src:/w/tests
  ai-video-clipper:editor-ref /app/.venv/bin/python -m <module>` (the image has no pytest; gate
  scripts are stdlib-only modules).
- Evidence files: `docs/editor/evidence/W<n>/<task>-<gate>.json`, numbers only.

## 5.15 W1 integration resolutions (T1.Z, 2026-09-25)

Recorded by the W1 integrator; each is logged with its evidence in `docs/editor/GATES.md`.

- **S-COLOR = `gbrp`** (T1.2b, `docs/editor/SPIKES.md` §1). `compile_ffmpeg.COMPOSITE_FORMAT`
  is `"gbrp"`; R5 is `scale=in_color_matrix=bt709:in_range=tv,format=gbrp,` →
  `ass=filename=captions.ass:fontsdir=fonts:shaping=complex` → the logo overlay in `gbrp`
  (`format=gbrap` logo, `overlay=…:format=gbrp`) → `scale=out_color_matrix=bt709:out_range=tv,
  format=yuv420p`. `RENDER_SEMANTICS` stays 1: no render with semantics 1 existed before.
- **Plate cells take the final's colour path** without text and logo (the same `format=gbrp`
  round trip), so a plate frame equals the final's pixels under the text (P-PLATE).
- **Graph shape** (T1.3, plan §5.2–§5.3 are not frozen): the layout is applied once after
  `concat` (once per plate run); a decoder run with several pieces is one
  `fps=num/den,select='<balanced between(pts,…) tree>',setpts=N` chain instead of `split` plus
  a `trim` per piece; a run of one piece keeps R1's `trim` string verbatim. The source audio
  keeps one `asplit` label per piece (§5.8). `SourceStreams.duration_s` is `Optional`
  (Matroska states no stream duration).
- **`resources/toolchain.json`** (E10) is written by the image build with
  `python -m ai_clipper.edit_v2.toolchain write … --base-image <name>@sha256:<64 hex>
  --apt-snapshot <YYYYMMDDTHHMMSSZ>`: canonical bytes (sorted keys, two-space indent,
  newline) of `{schema: "potongin.toolchain/1", base_image, apt_snapshot, packages: {ffmpeg,
  libass9, libfreetype6, libharfbuzz0b, libfribidi0, fontconfig}}` from `dpkg-query -W`. It is
  never committed. `plan.toolchain_sha256(Resources(glyphs.RESOURCES_DIR))` is the
  `toolchain_sha` of `plan.render_key`; a missing file raises `FileNotFoundError` (no key
  without a pinned toolchain).
- **`face_tracking.detect_face_track(…, smooth=True)`** gained `smooth=False` (raw centres,
  `None` without a face), which `camera.build_camera_plan` uses so `no_face` spans are reported
  for today's detector too (plan §5.7). The legacy render path keeps the default.
- **Editor routes spawn Python only through `web/lib/python-cli.mjs`** (`runPythonCli`):
  `CHILD_ENV_ALLOWLIST` = `PATH HOME LANG TZ TMPDIR JOBS_ROOT FONTCONFIG_FILE
  POTONGIN_RENDER_ENGINE POTONGIN_EDITOR_V3 POTONGIN_EDITOR_UPLOADS POTONGIN_EDITOR_LLM`
  (explicit names, no prefixes); the module must be one of the Appendix A.1 CLIs; exit codes
  0 and 3–12 resolve `{exitCode, json}`, anything else rejects `PythonCliError`
  (`backend_failed`); `httpStatusForExit` is the §5.3 table.

## 5.16 W1 verifier fixes (T1.Z, 2026-09-25)

Approved by the W1 integrator after the W1 verifier's findings; each is logged with its numbers
in `docs/editor/GATES.md` ("Patches" 11–18).

- **`source.json` probe version 2: `grid_sf`.** `[[num, den, first_sf, end_sf], …]` for every
  rate of `DOC_FPS`, in that order: the source-grid frames `[first_sf, end_sf)` that the
  compiler's own decode yields (R1: `-ss 0` / `-ss (duration − 3 s)`, or from the start when
  that finds no frame, `-copyts`, `fps=num/den`), measured once per source (`source_info.measure_grid`; read with
  `source_info.grid_range(probe, fps)`). `duration_ms` (rounded up) cannot tell: `sf_ceil` of it
  can be one frame past the last frame, and a video that starts after t = 0 (0.041 s in two real
  downloads) has no grid frame 0. A version-1 `source.json` is refused (`SourceInfoError`); none
  existed outside W1 development.
- **Seeds stay inside the grid** (§5.6): body and cold-open edges are clamped to `[first_sf,
  end_sf)` and `window_ms` narrowed as in §5.6; clip ids still hash the clip's own ms, so they do
  not move. `seed.build_seed` raises `SeedError` for a `source_info` without the grid.
- **Plate cells below the window.** A cell that starts below `sf_floor(window_ms[0])` decodes
  from that frame and repeats it (`tpad=start=<n>:start_mode=clone`) for the frames below, so
  frame `i` of cell `k` stays grid frame `k·C + i` for every frame a document can show; a cell
  wholly below the window is a `ValueError`.
- **R7 "Standar"** is `libx264 -preset veryfast -crf 18 -x264-params
  threads=4:chroma-qp-offset=-12` (`compile_ffmpeg.encode_video_args`; `final` and `frame`), and
  R5's last step is `scale=…:flags=accurate_rnd+full_chroma_int+full_chroma_inp+lanczos,
  format=yuv420p` (`compile_ffmpeg.final_conversion`; `FINAL_SCALE_FLAGS`) for final, frame,
  reference and plate cells. Plate cells keep `veryfast` crf 18 without the chroma offset. The
  parity harness exports with these strings. Reason: P-ENC (§10.1) failed for every S-COLOR
  candidate at crf 21; the thresholds are unchanged. `RENDER_SEMANTICS` stays 1: no render
  with semantics 1 exists outside W1 tests.
- **`execute.run`**: a job that declares `fonts_dir` or `fontconfig_file` fails with
  `render_failed` (ref `fonts` / `fontconfig`) before FFmpeg starts when either is missing;
  `RLIMIT_AS` is set by util-linux `prlimit --as=<n>:<n> --`, which execs FFmpeg (same pid and
  process group), so FFmpeg never runs without the limit (`render_failed`, ref `prlimit`, when
  the tool is missing).
- **R8 outside the compiler**: `source_info`, `peaks` and `compile_ffmpeg.probe_source` pass
  `-protocol_whitelist file,pipe` and `source_info.child_env()` (`PATH`, `LANG`, `LC_ALL`).
- **`face_tracking.detect_face_track(…, sequential=False)`** gained `sequential=True`: one seek,
  then the window decoded front to back, keeping for each sample the frame the per-sample seek
  lands on (`int(seconds·fps + 0.5)`). `camera.build_camera_plan` passes it to a detector that
  accepts the keyword; the legacy render keeps the per-sample seeks.
