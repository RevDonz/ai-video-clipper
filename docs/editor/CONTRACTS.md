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
Part 5 (T1.0 resolutions; §5.15–§5.16 W1; §5.17–§5.18 W2; §5.19–§5.20 W3; W4: §5.21 performance
and retention, §5.22 the release contracts (CI suites, the toolchain guard, the licences page, the
lock clock), §5.23 security hardening, §5.24 the caption note, §5.25 the W4 verifier fixes).

Final for Essentials: this file plus the W4 additions of the other W4 tasks is the contract the
released editor keeps. Operating it: `docs/editor/OPERASIONAL.md`.

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
               assets: Mapping[str, Mapping], resources: Resources,
               faces: Mapping | None = None) -> RenderPlan   # .to_json(), .plan_sha256; faces: §5.50
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
| `python -m ai_clipper.render_queue` (added in W2, T2.2; §5.17) | `estimate`, `create`, `get`, `cancel`, `list` (no arguments: the Editor V3 envelope; any argument exits 2 `render_queue_usage`: the candidate editor's `--job-dir` protocol was retired in W4, T4.1) |
| `python -m ai_clipper.system_info` (Pengaturan "Tentang sistem"; §5.34) | `versions` |

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
//     cleanup(), coldOpenSuggestions(), aiHooks(doc), aiSpelling(doc), aiTask(taskId) }

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
| `output` | `w×h` ∈ {720×1280, 1080×1920, 720×720, 1080×1080} (1:1 since §5.54); `fps` as §3.1; `sample_rate` 48000; `channels` 2 | Fixed at seed (the job's render size: the dashboard's Rasio and Resolusi, 720×1280 without them). Exports render at this size (§4.6) |
| `main.segments` | 1–2 items: optional `cold_open` first, then exactly one `body` | Cold-open rules in §3.4 |
| `main.removals` | ≤ 2,000; `reason` ∈ {`user`, `filler`, `repeat`, `gap_silent`}; `origin` `user` or `suggestion:<id>` | Sorted by `in_sf` within a segment; no overlap; `words` must exist in the words artifact |
| `main.joins` | 0–1 item: `after` = cold-open id; `style` `"cut"`, `"flash_white"` or `"dip_black"`; `audio_fade_ms` 0–250 (seed 30); optional `sfx` `{"id": "whoosh", "v": 1}` (absent = no sound) | The cold-open transition (§5.26, amended 2026-10-02). `xfade` stays `op_disabled`; another `{id, v}` is `sfx_unknown` |
| `main.cut_fade_ms` | 0–50 (default 8) | Micro-fade at every jump cut (G-CLICK) |
| `captions.pack` | `{id ∈ {classic, karaoke, bold, box, sorot}, v: 1}` (`sorot` amended 2026-10-20, §5.30) | Packs are immutable per version (§5.4) |
| `captions.overrides.y_e5` | 20000–92000 (bottom anchor of the caption block) | Seed 83000 (= today's 17% bottom margin) |
| `captions.overrides.size_pm` | 700–1400 | Seed 1000 |
| `captions.overrides.case` | `asis`, `upper` | Case is a display transform; text is never rewritten |
| `captions.overrides.highlight`, `.emphasis` | swatch `#FFE14D #FFFFFF #3DF5A6 #52C7FF #FF5C8A #FF9F1C` | `highlight` is used by karaoke, bold and sorot (the box behind the spoken word) |
| `captions.overrides.words_max` | optional; 1–4 (amended 2026-10-20, §5.30) | "Kata per baris": at most this many words per caption line; absent = the pack's `words_per_cue`. Seeds never write it |
| `captions.overrides.entrance` | optional; `none`, `fade`, `pop`, `blur` (amended 2026-10-21, §5.39) | "Animasi masuk": how each caption line appears, at most 120 ms; absent = `none`. Seeds never write it |
| `captions.word_edits` | ≤ 6,000 keys (word ids); values `{text?, hidden?, emphasis?}` with ≥ 1 key | `text` 1–40 chars. `emphasis` fixes defect #6 (§8) |
| `layout.default.mode` | `fit_blur`, `camera` (face-track), `fill_center` (center-crop), `split` (layar terbagi, amended 2026-10-21, §5.45) | `no_face` is `"center"` (today's behaviour) or `"fit_blur"` (face-track shows its runs without a face as `fit_blur`, §5.40); no-face spans are *reported*, never silent |
| `layout.keyframes` | optional; 1–100 `{sf, pan_e5 0–100000, move "cut"\|"slide"}`, `sf` strictly increasing inside the window (amended 2026-10-21, §5.44) | "Atur bingkai": the crop of the two crop layouts set by hand; with `fit_blur` or `split` `range_invalid`; absent = the layout's own framing. Seeds never write it |
| `layout.split` | with `split` only, and then required: `{top_pm 300\|500\|700, top {x_e5 0–100000, y_e5 0–100000, zoom_pm 1000–5000}, bottom {…}}` (amended 2026-10-21, §5.45) | "Layar terbagi": two stacked crops of the source and a 1 px black line. Seeds never write it |
| `tracks` | ≤ 3 tracks: ≤ 1 `hook`, ≤ 1 `visual/over_text/overlay`, ≤ 1 `audio/music`; ≤ 1 item each | Stage 2 lifts the counts; the shapes stay |
| hook item | `start {"at":"out","f":0}`; `dur_f` 15 to `floor(30·F)`; `transform.x_e5` 50000; `y_e5` 6000–40000 (top of the hook stack; seed 13000); `payload.text` 1–90; `design {"id": "legacy-bar"|"kicker"|"blok"|"kotak", "v": 1}` (the three new designs amended 2026-10-20, §5.33; seeds write `legacy-bar`) | Fixed start at 0 as today |
| logo item | `start clip_start`, `end clip_end`; `x_e5, y_e5` 0–100000 (box centre); `w_e5` 4000–40000; `opacity_pm` 200–1000; `payload.mode` `"free"` | The resolved box must lie inside the frame (`item_out_of_frame`) |
| music item | `start clip_start`, `end clip_end`; `src_in_smp` 0 to asset length − 1; `loop` bool; `gain_cdb` −4800–600; `fade_in_f`/`fade_out_f` 0 to `10·F`; `duck` fully specified: `depth_cdb` 300–2400, `attack_ms` 5–500, `release_ms` 50–2000, `hold_ms` 0–1000, `detector` `"words"` | Default gain `clamp(−2600 − lufs_c, −4800, 600)` |
| `audio.source.gain_cdb` | −2400–1200 | Seed 0 |
| `audio.master` | `mode` `off`/`normalize`; `target_clufs` −2400 to −900; `tp_cdb` −300–0 | Seed `off` (= today's auto render) |
| `assets` | map of the assets the document references; metadata copied from the asset store | `asset_missing` if the store lacks the sha |
| `audit` | `created_at_ms` immutable; `updated_at_ms` **stamped by the server**; `editor`; `last_command` (≤ 40 chars, `^[A-Za-z]+$`) | The server stamp removes client-clock issues |
| `watermark` | optional `{text, pos, size_pm, opacity_pm}` (amended 2026-10-21, §5.43) | The text watermark: `text` 1–40 code points (the hook's text rules), `pos` one of nine places, `size_pm` 500–2000, `opacity_pm` 200–1000; absent = none. Seeds write it only for a job created with the Pengaturan default |

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
| ASS time (frame-safe) | `now_ms(n) = trunc(n · (den/num) · 1000)` in IEEE double, **the exact expression order of FFmpeg's `vf_subtitles`** with time base `den/num` (the graph sets `settb=den/num` before `ass`). `safe_cs(n) = (now_ms(n) − 2) // 10`. An event visible on `[a, b)` is written `Start = safe_cs(a)`, `End = safe_cs(b)`; `\kf` durations (`\k` before §5.49) are differences of `safe_cs`. The browser calls libass with `now_ms(n)/1000`, and JASSUB's rounding returns exactly `now_ms(n)` [PF `ass_time_rule.py`: 0 failures, 24–60 fps, 3 h] |
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
| `main.joins` | With a kept cold open: `{"after": "seg_co", "style", "audio_fade_ms": 30}` (+ `sfx`) from the seed context `coldOpenJoin`: the pipeline's `flash_white` + whoosh; prepare: the clip's manifest `cold_open_join`, else `cut` without sound (§5.26, amended 2026-10-02). `audio_fade_ms` is today's `AUDIO_JOIN_FADE_SECONDS` |
| `captions.pack` | The job's `captionStyle` (any pack id); overrides at the pack defaults, with `y_e5`/`size_pm` from the job's `captionPosition`/`captionSize` when it has them (§5.48) |
| hook item | When `hookOverlay` and `hook_text` exist: `[0, round_half_up(hook_duration·F))`, `legacy-bar`, `y_e5 13000` |
| `layout.default.mode` | `face-track` → `camera`, `fit-blur` → `fit_blur`, `center-crop` → `fill_center` |
| `output` | The job's render size (the job option `outputSize`, 720×1280 without it [REPO run-job.mjs], §5.54); fps: native standard rates kept; 50 → 25, 60 → 30, 60000/1001 → 30000/1001; VFR or other → 30/1 |
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
| Semantic, blocking | `base_changed`, `outside_window`, `range_invalid`, `cold_open_invalid`, `duration_out_of_bounds`, `removal_outside_segment`, `removal_overlap`, `unknown_word`, `asset_missing`, `pack_unknown`, `sfx_unknown` (2026-10-02, §5.26), `op_disabled`, `item_out_of_frame`, `revision_mismatch`, `parent_mismatch` | 422 |
| Warning (save allowed; export asks for acknowledgement in "Perlu dicek") | `tight_cut`, `laughter_cut` (a cut inside a laughter span or within 300 ms of a laughter point), `hook_overflow` (the hook does not fit 3 lines at the smallest size and will be shortened with "…"), `glyph_unsupported:U+XXXX` (the pack font lacks a character, e.g. emoji), `no_face` (face-track spans with no face; listed with jump-to), `unsafe_zone` (caption, hook or logo box inside the TikTok UI zone), `loudness_clamped`, `peak_reduced` (§5.6 step 5), `music_shorter_than_clip` (loop off), `no_face_blur` (a face-track run without a face shown with latar blur, §5.40; the editor lists it as a note) | Listed with a jump-to target; nothing is silently changed |

### 3.8 Forward compatibility with FINAL (Stage 2)

- Stage 2 adds **optional** keys under `schema_minor: 1`: more tracks and items, word anchors,
  `intro_hold_f`, `markers`, `template_ref`, `packaging`, join styles, `layout.ranges`, and
  `camera.manual_keys`. A minor-0 document stays valid unchanged.
- *Amended 2026-10-02 (§5.26):* the join styles `flash_white` and `dip_black` and the optional
  join key `sfx` are valid under `schema_minor: 0`. Every minor-0 document stays valid and
  means what it meant; an older server refuses the new values with `op_disabled` (style) and
  `unknown_key` (`sfx`). `xfade` and a join `dur_f` remain Stage 2.
- *Amended 2026-10-20 (§5.30):* the optional override `captions.overrides.words_max` (1–4) and
  the pack id `sorot` are valid under `schema_minor: 0`. A document without them is unchanged in
  meaning (absent `words_max` = the pack's own count); an older server refuses the key with
  `unknown_key` and the pack with `pack_unknown`.
- *Amended 2026-10-20 (§5.33):* the hook designs `kicker`, `blok` and `kotak` (each `v` 1) are
  valid under `schema_minor: 0`; a document with the bar means what it meant, and an older
  server refuses the new designs with `op_disabled`.
- *Amended 2026-10-21 (§5.39):* the optional override `captions.overrides.entrance` (`none`,
  `fade`, `pop`, `blur`) is valid under `schema_minor: 0`. A document without it is unchanged in
  meaning (absent = `none`); an older server refuses the key with `unknown_key`.
- *Amended 2026-10-21 (§5.43):* the optional root key `watermark` (the text watermark) is valid
  under `schema_minor: 0`. A document without it is unchanged in meaning (no watermark); an older
  server refuses the key with `unknown_key`.
- *Amended 2026-10-21 (§5.44):* manual framing landed as the optional `layout.keyframes` under
  `schema_minor: 0`, in place of Stage 2's `camera.manual_keys`. A document without it is
  unchanged in meaning; an older server refuses the key with `unknown_key`.
- *Amended 2026-10-21 (§5.45):* the reserved layout mode `split` is valid under `schema_minor: 0`
  with its `layout.split`. Every other document is unchanged in meaning; an older server refuses
  the mode with `op_disabled` and the key with `unknown_key`.
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
  analysis/apply-all/<batchId>.json             "Pakai di semua klip" batches, newest 50 (§5.53)
  analysis/assets/<sha256>.{png,m4a} + <sha256>.json    job asset store (§9.2)
  analysis/render-requests/<render_id>.json     render-request-v3 (old jobs may keep v1/v2 files: never acted on)
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
| `GET /clips` | V3 clips of the job | `{clips:[{clipId, index, title, hookText, description, hashtags, durationMs, engine: "edit-v2/1"\|"legacy", edit:{state:"seed"\|"edited", revision, etag, updatedAtMs}, latestRender:{renderId, state, url, srtUrl, revision}\|null, openable, reason}]}`. For jobs rendered before Essentials, `clipId` is null with `reason: "needs_prepare"` until `POST /clips` has run. Other `reason` values (fixed codes with Indonesian messages): `source_missing`, `selection_unreadable`, `transcript_missing`, `analysis_incomplete` (`.attempts/` left), `not_v3` (V1/v2-shadow jobs; their candidate editor is retired); `POST /clips` can also answer `source_unreadable` (the source is there but cannot be probed or measured; §5.20) |
| `GET /clips/:clipId/edit` | Current document, or the seed as virtual revision 0 | `200 {doc, etag, seed, words:{sha256, url}, readOnly, readOnlyReason}` with `ETag` and `X-Edit-Seed: 1` for the seed. `?seed=1` always returns the seed (for "Kembali ke versi AI"). **No side effects.** `409 analysis_missing` when the words artifact does not exist yet (the client then calls `prepare`) |
| `PUT /clips/:clipId/edit` | Save the full document | `If-Match` required (428), `Idempotency-Key` UUID required, `Content-Type: application/json`, ≤ 1 MiB. `200 {doc, etag, warnings}`; `409 revision_conflict {current, etag}`; `409 idempotency_conflict`; `422 {errors:[{path, code}]}`; `426 schema_too_new` |
| `GET /clips/:clipId/words` | Words artifact | `ETag` = sha; `Cache-Control: private, max-age=31536000, immutable` |
| `POST /clips/:clipId/prepare` | Build missing artifacts (source info, words, peaks, camera for the requested layout) and enqueue the first plate cells | Body `{layout?}` ≤ 1 KiB; `202 {words, camera, plate:{state, ready, total}}`; idempotent |
| `POST /clips/:clipId/preview/plan` | Validate and resolve an **unsaved** document for preview | Body `{doc, known:{assSha256?}}` ≤ 1 MiB. `200 PlanDTO` (§4.3) or `422 {errors}`. Rate ≤ 10/s per session; a superseded request for the same clip is cancelled |
| `POST /clips/:clipId/preview/frame` | Truth frame | Body `{doc, f}`; `image/png` at the output size with ancillary chunks stripped; ≤ 4/s; cached by `(plan_sha, f)` |
| `GET /clips/:clipId/media/:kind/:name` | Plate cells, audio mixes, ASS, derived logos, peaks | `kind` ∈ {`plates`, `audio`, `ass`, `derived`, `peaks`}; `name` matches a content-hash regex; realpath containment; HTTP Range; `private, max-age=31536000, immutable`; `nosniff`; `Cross-Origin-Resource-Policy: same-origin`. ASS (which contains user text) is served as `text/plain; charset=utf-8` with `Content-Security-Policy: sandbox` |
| `POST /clips/:clipId/renders` | Enqueue an export | `Idempotency-Key`; body exactly `{"editEtag":"<64 hex>"}` ≤ 1 KiB (size and quality are fixed to the auto clip's in Essentials); storage reservation first (existing admission). `202 RenderDTO`, or `200` with `state:"completed"` when the document content equals the seed (R10) or the render key already exists |
| `GET /renders/:renderId` (extended) | Status of a v3 request; 404 for a missing one and for a v1/v2 request of the retired candidate editor (W4, T4.1) | `RenderDTO {renderId, clipId, state, stage, progressPm, revision, errorCode, resultUrl, srtUrl}` |
| `DELETE /renders/:renderId` (new) | Cancel a v3 request | Same-origin; queued → `cancelled`; rendering → the worker kills FFmpeg within 2 s and marks `cancelled` |
| `POST /clips/:clipId/ai` | AI hook suggestions (§7) and Cek ejaan (§5.35) | Body exactly `{task:"hooks"\|"spelling", doc}` (no provider, model or URL field is accepted; those come only from the sealed LLM settings); hooks: `202 {taskId, heuristic:[…], llm:{state:"pending"\|"disabled"\|"rate_limited"}}`; spelling: `202 {taskId, llm:{…}}` (no instant part) |
| `GET /clips/:clipId/ai/:taskId` | Poll an AI task | `taskId` is a UUID (checked in Node and Python); `{state:"pending"\|"done"\|"failed", suggestions:[…], error:{code, messageId}\|null}`, plus `truncated` for a done spelling task |
| `GET /clips/:clipId/cleanup` | Rapikan review list (§7.3) | Immutable per `(words sha, lexicon version)` |
| `GET /clips/:clipId/coldopen-suggestions` | Cold-open candidates (§7.2) | Immutable per words sha |
| `POST /clips/:clipId/apply-all` (amended 2026-10-21, §5.53) | "Pakai di semua klip": this clip's caption, logo or layout on the job's other clips | Same-origin; body exactly `{group, etag}`; `Idempotency-Key` = batch id; `200 {batchId, group, applied, skipped, unchanged}` |
| `POST /clips/:clipId/hook` (amended 2026-10-21, §5.57) | "Hook di video" on the project page: the hook overlay on or off | Same-origin; body exactly `{on, etag}`; `Idempotency-Key`; `200 {etag, revision, changed, hook}` |
| `POST /apply-all/:batchId/undo` (amended 2026-10-21, §5.53) | Undo that batch on the clips nobody saved since | Same-origin; empty body or `{}`; `200 {batchId, group, restored, skipped}` |
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
  "errors": [],
  "joins": [{"after": "seg_co", "style": "flash_white", "atF": 135, "rgb": [255, 255, 255],
             "alphaPm": [[133, 333], [134, 666], [135, 1000], [136, 666], [137, 333]],
             "sfx": {"id": "whoosh", "v": 1, "startSmp": 204696, "hitSmp": 216216, "samples": 20160}}]
}
```

- `joins` (added 2026-10-02, §5.26) is always present (`[]` without a cold open): the
  cold-open transition the player blends into the plate frame, between the plate and the text,
  with the export's own per-pixel arithmetic (§5.26 "Browser preview"). `rgb` is `null` and
  `alphaPm` `[]` for `cut`; `sfx` is informational (the whoosh is in the server mix).

- `text.ass` is omitted when `known.assSha256` equals the new sha. `cues` and `hook` exist only to
  draw the timeline and the transcript; pixels always come from the ASS.
- `audio.musicGainPoints` are the duck/fade breakpoints `[out_sample, gain_e6]`, used only to
  draw the envelope on the music lane. The audible gain comes from the server mix.
- `rev0.exact` is true only when `planSha256 == rev0.planSha256` and the auto render was produced
  by `edit-v2`. The player may then play `autoRenderUrl` while plate cells build.
- In Essentials `plate.w/h` always equals `output` (the job's size, §5.54), so the preview
  resolution is the export resolution.

# Part 5. T1.0 resolutions

Where the plan is silent or leaves two readings, the choice below is binding for every task. The
names are pinned by `tests/test_edit_v2_contracts.py` (parameter names, kinds and defaults;
annotations may be spelled differently).

## 5.1 Where each name lives

| Module | Names | Owner |
|---|---|---|
| `ai_clipper.edit_v2` (`__init__`) | `COMPILER_VERSION`, `COMPILER_ID` (`"edit-v2/1"`), `RENDER_SEMANTICS`, `SCHEMA`, `SCHEMA_MINOR`, `WORDS_SCHEMA`, `CAMERA_SCHEMA`, `DOC_FPS`, `OUTPUT_SIZES`, `PACK_IDS`, `SWATCHES`, `PACK_DEFAULT_OVERRIDES`, `WORDS_MAX_RANGE` (§5.30), `HOOK_DESIGN_IDS` (§5.33), `CAPTION_ENTRANCES` (§5.39), `WATERMARK_TEXT_MAX`, `WATERMARK_POSITIONS`, `WATERMARK_SIZE_RANGE`, `WATERMARK_OPACITY_RANGE`, `UI_ZONE_720` (§5.43), `EDGE_MARGIN_PM`, `ui_zone`, `frame_margins`, `text_height` (§5.54) | T1.0 |
| `edit_v2.errors` | exceptions, code sets, `MESSAGES`, `message`, `message_id`, `base_code`, `exit_code_for`, `EXIT_*` | T1.0 |
| `edit_v2.timemap` | Appendix A names plus `SAMPLE_RATE`, `MIN_PIECE_FRAMES`, `div_round_half_up`, `speech_spans`, `logo_box`, `Fps.from_json`, `Fps.to_json`, `Piece.to_dto` | T1.0 |
| `edit_v2.clip_id` | `clip_id`, `is_clip_id`, `ms_from_seconds`, `CLIP_ID_PATTERN` | T1.0 |
| `edit_v2.doc` | `MAX_DOC_BYTES`, `Issue` (+`to_json`), `Validation` (+`ok`), `parse_doc`, `canonical_bytes`, `doc_sha256`, `content_sha256`, `content_equals_seed`, `validate_doc` | T1.1 |
| `edit_v2.store` | `get`, `seed`, `put`, `archive_for_render`, `prune_receipts`, the §4.1 path constants | T1.1 |
| `edit_v2.api` | `OPS`, `main` (CLI) | T1.1 |
| `ai_clipper.subtitles` (additions) | `SourceWord`, `FrameWord`, `FrameCue`, `build_frame_cues` | T1.2a |
| `ai_clipper.captions_ass` (additions) | `CaptionPack`, `load_pack`, `HookSpec`, `build_ass_v2`; `WordBox`, `words_per_cue`, `lightness`, `word_box_text` (§5.30); `LEGACY_HOOK_DESIGN`, `HOOK_LAYOUTS`, `HookDesign`, `HookBox`, `HookKicker`, `hook_design`, `hook_font_file`, `boxed_word_index` (§5.33); `ENTRANCE_MS` (§5.39); `WATERMARK_FONT_FILE`, `WatermarkSpec`, `WatermarkLayout`, `layout_watermark` (§5.43); `Glow` (§5.49) | T1.2a |
| `edit_v2.captions` | `CaptionResult`, `caption_track` | T1.2a |
| `edit_v2.glyphs` | `missing_glyphs`, `advance_px` | T1.2a |
| `edit_v2.envelope` | `Envelope`, `speech_envelope`, `music_envelope`, `expand_f32` | T1.4 |
| `edit_v2.audio_graph` | `AudioFragment`, `audio_fragment`, `SOURCE_AUDIO_LABEL`, `OUTPUT_LABEL`, `LABEL_PREFIX`, `AUDIO_MODES` | T1.4 |
| `edit_v2.loudness` | `Loudness`, `parse_ebur128`, `master_gain`, `needs_measurement`, `output_gain` | T1.4 |
| `edit_v2.plan` | `Resources`, `RenderPlan`, `build_plan`, `render_key` | T1.3 |
| `edit_v2.compile_ffmpeg` | `MODES`, `QUALITIES`, `InputSpec`, `FfmpegJob`, `compile_job` | T1.3 |
| `edit_v2.layouts` | `LAYOUT_MODES`, `NO_FACE_MODES` (§5.40; the builders are internal to T1.3) | T1.3 |
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

# layouts.py (T1.3; "split" since §5.45)
LAYOUT_MODES = ("fit_blur", "camera", "fill_center", "split")
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
  `{"id": <one of HOOK_DESIGN_IDS>, "v": 1}` (§5.33); logo `payload.mode` `pip`, `cutaway`, `split_top`,
  `split_bottom`; `captions.overrides.case` `lower`, `sentence`; layout mode `smart_speaker`,
  `fit_black`, `branded` (`split` is valid since §5.45); `no_face` `fail` (`fit_blur` is valid
  since §5.40); duck
  detector `rms`.
- **`pack_unknown`**: `captions.pack.id` (a string) not in `PACK_IDS`, or `v` (an int) ≠ 1.
- **`base_changed`** (only when `seed` is given): any difference from the seed in `base`,
  `output`, `clip_id` or `audit.created_at_ms` (the plan fixes all four at seed time).
- **Revisions.** `validate_doc`: revision 0 ⇔ `parent_sha256` null, otherwise
  `parent_mismatch`. `store.put`: `revision == current + 1` else `revision_mismatch`;
  `parent_sha256 == current etag` else `parent_mismatch` (both 422).
- **`outside_window`**: with `window_sf = [sf_floor(window_ms[0]), sf_ceil(window_ms[1])]`, every
  segment needs `window_sf[0] ≤ in_sf` and `out_sf ≤ window_sf[1]` (frame-covering, so a seed
  that ends at the end of the source is inside), and every framing keyframe `window_sf[0] ≤ sf
  < window_sf[1]` (§5.44). The seed narrows `window_ms` to the source-grid
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
- **Watermark** (optional, §5.43): an object (else `range_invalid` at `/watermark`; `null` is
  not "absent"); `text` 1…40 code points without leading or trailing whitespace, `pos` in
  `WATERMARK_POSITIONS`, `size_pm` 500…2000, `opacity_pm` 200…1000, each else `range_invalid` at
  `/watermark/<key>`.
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
captions  enabled bool · pack {id, v} · overrides {y_e5, size_pm, case, highlight, emphasis,
          words_max (optional, §5.30), entrance (optional, §5.39)}
          · word_edits {<word id>: {text?, hidden?, emphasis?}} (values: 1–3 keys)
layout    default {mode, no_face "center"|"fit_blur"}
          · keyframes [{sf, pan_e5, move "cut"|"slide"}] (optional, 1–100, §5.44)
          · split {top_pm 300|500|700, top {x_e5, y_e5, zoom_pm}, bottom {…}} (split only, §5.45)
tracks    hook   {id, kind "hook", items}
          visual {id, kind "visual", band "over_text", role "overlay", items}
          audio  {id, kind "audio", role "music", items}
  hook    {id, type "hook", start {at "out", f 0}, dur_f, transform {x_e5, y_e5},
           payload {text, design {id "legacy-bar"|"kicker"|"blok"|"kotak" (§5.33), v 1}},
           origin}
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
watermark (optional, §5.43) {text, pos, size_pm, opacity_pm}
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
  `{"after": "seg_co", "style": "cut", "audio_fade_ms": 30}`; `cut_fade_ms` 8; `removals` [] (an
  automatic clip's seed: its pause trims, §5.58).
- `base.window_ms` = §3.5's window, then narrowed to the grid:
  `[max(a, ⌈first_sf·1000·den/num⌉), min(b, ⌊end_sf·1000·den/num⌋)]`
  (`seed.grid_window_ms`), so `window_sf` is exactly the frames that exist at the source edges.
- `captions`: `enabled` true, `pack {id, v: 1}`, `overrides = PACK_DEFAULT_OVERRIDES[pack]`
  (every pack: `y_e5` 83000, `size_pm` 1000, `case` `asis` (`upper` for `bold` and `sorot`),
  `highlight` `#FFE14D`, `emphasis` `#FF5C8A`; never `words_max` or `entrance`), `word_edits` {}.
- Hook: track `{"id": "tr_hook", "kind": "hook"}` with item `it_hook`, origin `seed`,
  `dur_f = round_half_up(hook_duration_ms · num / (1000·den))`,
  `hook_duration_ms = ms_from_seconds(hook_duration)`.
- `assets` {} (a job created with a Pengaturan default logo: one entry and the `tr_ovr` track,
  §5.36); no `watermark` (a job created with a Pengaturan default text watermark: that one,
  §5.43); `audio` `{source {gain_cdb 0}, master {mode "off", target_clufs −1400,
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
frame. Optional `faces` (§5.50): the framed face per sample, `[x_pm, y_pm, w_pm, h_pm] | null`.

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
  for today's detector too (plan §5.7). The legacy render path asks for the raw centres too and
  smooths them with `smooth_face_track` itself (the same crop), so it can report the seconds
  without a face (§5.31).
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

## 5.17 W2 integration resolutions (T2.Z, 2026-09-25)

Approved by the W2 integrator; each change and its evidence is logged in
`docs/editor/GATES.md` (W2, "Patches by the W2 integrator" and "Phase-B requests"). Appendix A's
signatures stay; everything below is additive unless marked **changed**.

### render_edit (T2.1)

- `render_document(..., source=None, resources=None, timeout_s=None)` and
  `render_request(..., resources=None, timeout_s=None)`: extra keyword-only arguments with
  defaults. `render_document`'s `progress` receives per-mille of the frames written. Default
  timeout `max(120 s, 3 × output seconds × k)`, k = fit_blur 0.5, camera 0.5, fill_center 0.4.
- `RenderResult`: `clip_id, output, srt, render_engine, plan_sha256, render_key` (None without
  `resources/toolchain.json`), `reused` (None, `"auto_file"`, `"existing"`), `frames, samples,
  elapsed_s, warnings, verify`; `to_json()` is camelCase. The render worker maps `reused` to the
  request's `completed_by` (`auto_file` → `seed`, `existing` → `key`, else `render`).
- `heartbeat(stage, progress_pm)`: `("merender", 0…1000)`, `("memverifikasi", 1000)`,
  `("selesai", 1000)`. Failures raise `RenderFailed` with ref `request`, `document`, `source` or
  `output`; `Cancelled`, `VerificationFailed`, `AnalysisMissing`, `DocSemanticInvalid` propagate.
- Helpers: `engine_from_env, load_render_inputs, render_key_for, measure_sha256` (sha256 of the
  canonical `{schema: "potongin.loudness/1", i_clufs, tp_cdb}`), `auto_file, verify_file,
  job_source, job_id_for, AutoRenderer, AutoOptions, AutoClip`.
- Pipeline: `run_pipeline(render_engine=None)` and `pipeline.render_v3_job`. With `edit-v2` a
  manifest clip gains `clip_id`, `render_engine` (`"edit-v2/1"` or `"legacy"`), `render_key`,
  `plan_sha256`; the summary warning `engine_fallback:<index>` marks a per-clip fallback, and the
  clip itself gets `fallbacks` (§5.31). `POTONGIN_RENDER_ENGINE` is `edit-v2` by default since
  2026-10-21; only `legacy` (any case, outer spaces ignored) selects the legacy engine, the
  rollback switch (§5.48).

### render-request-v3 and its routes (T2.2)

- Fields and states as documented at the top of the v3 section of `render_queue.py`
  (`version, render_id, idempotency_key, state, stage, progress_pm, clip_id, doc_sha256,
  doc_revision, doc_relative, render_key, size "output", quality "standar", output_relative
  (output/edits/<clip_id>/<render_key16>.mp4), source_content_sha256,
  source_snapshot_relative, timeout_ms`, the times, `attempts, error_code, warnings,
  completed_by, lease_token, heartbeat_at` and the three `storage_reservation_*`).
- CLI: `python -m ai_clipper.render_queue` with no arguments reads the envelope `{op, …}` with
  ops `estimate {jobId, clipId, editEtag}`, `create {jobId, clipId, editEtag, idempotencyKey,
  storageReservation?}`, `get {jobId, renderId}`, `cancel {jobId, renderId}`,
  `list {jobId, clipId}`, with the §5.3 exit codes. It is in `PYTHON_CLI_MODULES`.
- The render key is computed at create with `measure_sha=None`: the measurement depends only on
  inputs the key already holds. Without `resources/toolchain.json` create answers 503
  `backend_unavailable` (a local run writes the file, see `docs/editor/PANDUAN-EDITOR.md`).
- **R10 has two checks; the create-time one is authoritative.** At create (the queue): an
  edit-v2 auto file passes G1–G2 against the seed's plan; a legacy-engine auto file passes G1
  except the document frame rate (constant rate at its own rate) and G2 by duration within 4
  output frames (32/32 real clips; strict G1–G2 passes 5/32). At render time (`render_edit`,
  reached only when the create-time check failed): the legacy contract (H.264/AAC, size, SAR
  1:1, duration within 0.25 s of the manifest). A failing auto file renders with the warning
  `auto_file_unavailable`.
- Retention: a terminal v3 request is pruned when older than 7 days and not among the newest
  200 terminal requests; v1/v2 files of the retired candidate editor are never pruned,
  claimed, listed or rewritten (strict canonical JSON still required; `get` answers not found).
- `GET …/edit`: `seed` is a boolean, plus `seedEtag`, `engine`, `notices`; `words.url` carries
  `?sha=<sha>` and is cached immutably; the bare words URL is revalidated (no-cache + ETag, 304)
  because it changes after "Mulai dari versi AI" (a deviation from §4.2's immutable words).
- `RenderDTO` adds `warnings, completedBy, cancelRequested, createdAt, updatedAt`. `POST
  …/renders` answers 200 for a terminal result and 202 otherwise. `DELETE /renders/:id`
  answers 200 cancelled, 202 when a cancel is requested, 409 `render_finished` or
  `not_cancellable`. `GET /clips/:clipId/renders` lists a clip's exports (additive).
- Every new route answers 404 `editor_disabled` while `POTONGIN_EDITOR_V3` is not `on`; the
  render status GET is not gated (it reads the request file, never spawns). A job's `sourcePath`
  must lie in its own `input/` for the source snapshot (the legacy rule, unchanged): a job copied
  to another `JOBS_ROOT` exports only after its `job.json` names the copy's file.
- Storage: a terminal v3 request (completed, failed or cancelled) releases its reservation; so
  does a v2 request of the retired candidate editor in any state (nothing renders it any more).
  The render admission and the shared accounting use the same predicate
  (`shared-storage-accounting.requestReleasesReservation`). The admission scan counts a
  hard-linked file (source snapshots, R10 exports) once.

### Preview lane (T2.3)

- `preview/plan` body `{doc, known?: {assSha256?}, playhead?}`: `playhead` is the output frame
  to build first. A repeated document is answered from the lane's cache (cell, audio and logo
  states refreshed from disk) without a new process, whatever its `known` or `playhead`.
- DTO: cell and audio states `ready|building|queued`; `logo` gains `state` (and `url` when
  ready); `rev0.planSha256` may be null when the seed cannot be planned (camera plan missing).
  `rev0.exact` is true only when the plan sha equals the manifest clip's `plan_sha256`, the
  manifest `render_engine` is `edit-v2/1` and the seed's compiler is `edit-v2/1`.
- Names: derived logo `<key16>@<w>x<h>a<opacity_pm>.png` (opacity baked in), truth frame
  `<key16>-<f>-<w>.png`; `key16` covers the plan or asset, `COMPILER_VERSION` and the toolchain
  sha. New files under `preview/`: `rev0.<key16>.json`, `audio/<key16>.json`,
  `audio/<mix16>.loudness.json`, `.cancel/`. Font URLs carry `?v=<sha16>`; `text.fonts` always
  lists the fallback font (`fonts.json` `fallback`, DejaVu Sans).
- `prepare` answers `plate.state` `ready|building`. Server-only env:
  `POTONGIN_PREVIEW_CACHE_BYTES` (cap override, default 1 GiB), `POTONGIN_RESOURCES_DIR`.
- `GET /api/resources/:kind/:name` **changed**: `kind` may also be `jassub`
  (`jassub-worker.js`, `jassub-worker.wasm`, byte for byte from the installed package, with COEP
  `require-corp`); `createPlayer`'s default `jassubUrl` is `/api/resources/jassub/`.
- The Node routes answer with the codes of `errors.ROUTE_CODES` (`invalid_request`,
  `csrf_rejected`, `rate_limited`, `backend_unavailable`, `superseded`, `editor_disabled`,
  `precondition_required`, `payload_too_large`, the storage codes, `render_finished`,
  `not_cancellable`), each with an Indonesian message (`messageId` `edit.<code>`).
- `python-cli` **changed**: a timeout or an abort sends SIGTERM to the child's process group,
  then SIGKILL after `killGraceMs` (default 2 s); `preview_cli` stops FFmpeg on SIGTERM and exits
  12.

### Client (T2.5, T2.4, T2.6)

- `createEditorStore` returns, beyond Appendix A.2: `ready, context, draftKey, draftWriter,
  resolveConflict(choices), startFromSeed(), retrySave(), setSelection(), dismissNotice()`;
  `flush()` resolves with the saved etag. Extra state: `revision, conflict {groups: [{id,
  label, parts, mine, theirs}], error}, notice {code, message}, error {code, message,
  retrying}, readOnlyReason, notices, engine, otherTab, previewError, phase`. Options:
  `timers`, `autosave`, `channel`, `lifecycle`, `tabStorage`, `planPollMs` (default 750: while
  a plan names a layer that is not ready, the same document is asked for again; an abandoned or
  failed plan request is retried).
- Command choices where Appendix B leaves room: `RemoveWords` merges overlapping or touching
  removals and splits runs over 400 words; `SetCaptionPack` switches `case` to the new pack's
  default only when it was the old pack's default; `SetHookText`/`SetHookEnabled` restore the
  seed origin when the text equals the seed text; `EditWordText` drops an edit equal to the ASR
  text; `MoveLogo`/`ResizeLogo` reject a box outside the frame while `SetLogo`/`SnapLogo` fit it
  (`clampLogoPosition()` for drags). Commands with the same `mergeKey` inside 500 ms merge into
  one undo step whatever their type.
- Drafts are per tab: key `<clipId>#<tabId>`, sessionStorage `potongin-editor-tab`,
  BroadcastChannel `potongin-editor` with `{type: open|here|closed, clipId, tab, instance}` and
  a 150 ms discovery wait. The store joins the channel only after it has loaded (a store
  destroyed while loading never joins).
- `createPreviewClient({…, playhead})`: `playhead()` is sent with every plan request; a 409
  `superseded` rejects as an `AbortError`.
- `createPlayer({canvas, fetchImpl, onState, onFrame, video?, requestTruthFrame?, jassubUrl?,
  lookaheadMs?, capacity?, deps?})`: options additive. `state()` also returns `playing, ended,
  waitingFor, exact, pending, slow, error, presentedFrame, plate {ready, total}`;
  `play({silent})` plays without the mix; `stats()` serves the gates. The player owns the
  `<video>` element's `src`.
- Paused frame (PR #22): three attempts with budgets of 1.5, 4 and 4 s; a retry asks the plate
  source for `need(k, j, {fresh: true})` (passes over the cell with no progress are abandoned,
  one sequential pass from the cell start). A cell abandons at most two passes that have not
  settled, since nothing can close their decoders; past that a fresh need waits on the cell's
  pass. After the last attempt `state().error` is `{layer: "plate"|"text"|"logo", message,
  frame}`: the layer the frame waited for, `"logo"` for a logo load that never finishes. Once no
  layer is pending the badge reads "Frame gagal dimuat"; a frame that still comes is drawn and
  clears it. A `load()` of the same plan (the store's polls while cells build) leaves these
  attempts alone: one waiting, a retry due, or a failure already reported. A seek, Play, a pause
  on a frame that is not on screen, and a new plan ask again. Play supersedes an attempt still
  waiting, which never draws over playback. `pause()` draws the playhead frame when playback was
  holding another. `stats().paused`, `stats().plate.abandoned` and `stats().plate.stalled`
  (abandoned passes that have not settled) record the misses.
- Runtime (`web/components/editor/runtime.mjs`): `createEditorRuntime({kind: "real"})` builds
  the API client, the preview client, the store (IndexedDB draft, channel, lifecycle) and the
  player (truth frames from the preview client for the current document); `setPlayhead(frame)`;
  `window.__potonginEditorInspect` (state, player state and stats; read-only) on the real page.
- Stage badge: besides §6.1, an unchanged legacy-engine clip (plan sha = `rev0.planSha256`,
  `rev0.exact` false) reads "● Belum diubah: ekspor = klip otomatis (mesin lama)", because R10
  exports the old auto file there. While paused the badge waits for the player's `exact`.
- The editor page carries `Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Embedder-Policy: require-corp`, `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`
  (`crossOriginIsolated` is true).

### Compiler (W1 modules, fixed at the W2 integration)

- **R2 changed**: a decoder run of several pieces is `fps=num/den,trim=start_pts=<first
  in_sf>:end_pts=<last out_sf>,select='<ranges>',setpts=N`. `select` alone never ends its
  stream, so FFmpeg decoded the rest of the source after the last piece (a removal on a 66 min
  source: `render_stalled`). Same frames kept; `RENDER_SEMANTICS` stays 1 (pixels unchanged).
- `execute._supervise` wakes on the process's exit (a waiter thread) instead of sleeping 50 ms.

### W3 seams (scaffolding landed by T2.Z)

- Registries: `panels/index.mjs` adds `layout` (Tata letak, T3.6), `logo` (Logo, T3.2) and
  `music` (Musik, T3.3); `timeline/lanes.mjs` adds `audio` (Audio, T3.7), `markers` (Penanda,
  T3.7) and `music` (Musik, T3.3), with files under `timeline/lanes/`; `gizmos/index.mjs` lists
  `logo` (`gizmos/LogoGizmo.jsx`, T3.2), mounted by `EditorApp` in the Stage's gizmo slot with
  props `{plan, state, dispatch, player, output, readOnly}`; `suggestions/index.jsx`
  (`HookSuggestions`, T3.4). W3 tasks replace these files, never the registries.
- Fakes: `createFakeUploadClient().uploadAsset(jobId, file, kind, {onProgress, signal})` (the
  §9.2 type allowlist and caps, the `POST /assets` DTO); Rapikan items, cold-open candidates and
  instant hook suggestions from the fake API; `CommandRejected` is the real one.
- `ApplyCleanup` items: `{id, kind: "filler"|"repeat", wordIds}` or `{id, kind: "gap_silent",
  afterWord, inSf, outSf}`, `id` matching `^[a-z]{2,3}_[0-9a-z]{1,16}$`; the origin becomes
  `suggestion:<id>`. `RemoveGap` rejects a `laughter` gap (or laughter within 500 ms) with
  `laughter_locked`.
- `SetLogo`/`SetMusic` take `{asset, meta}`: `asset` is `"sha256:<hex>"` or bare hex; `meta`
  in document form or the `POST /assets` DTO; `mime` `image/png` or `audio/mp4` (the normalised
  job asset store metadata), compared byte for byte by the validator.

## 5.18 W2 re-exit resolutions (T2.Z2, 2026-09-25)

Approved by the W2 integrator after the W2 verifier (docs/editor/GATES.md, "W2 re-exit").
Everything here is additive: no frozen signature, mode, DTO field or route changed.

### Preview audio in one decode (PF-AUDIO)

- `execute.run_piped(producer, consumer, *, output_fd, timeout_s, cancel=None)` → `(producer
  result, consumer result)`: the producer's `expected["output"]` is `"pipe"` (its `@out` is the
  write end of a pipe; no size check), the consumer has exactly one `InputSpec("pipe", name)`
  input (the read end, dup'ed; a FIFO is required). Both run at the same time, each a `run` with
  its own limits, timeout and stall window; the parent closes its pipe ends as soon as a side
  ends, so a dead consumer stops the producer at once (broken pipe). A cancel wins; otherwise
  the first failure is raised. `execute.run` keeps its frozen signature (a private `_run` takes
  the pipes).
- `compile_ffmpeg.premaster_jobs(plan, *, source, assets_root)` → `(producer, consumer)`: the
  producer is the `audio_measure` job up to `[apre]` (f32le out); the consumer runs the
  `audio_measure` stage text on that stream (stderr: the ebur128 summary) and writes the stream
  unchanged (f32le) to its `@out`. `compile_ffmpeg.master_job(plan, *, premaster, assets_root,
  loudness, mix_sha256)`: the `audio_preview` master stage and FLAC output over a stored
  pre-master (`InputSpec("source", "premaster", PREMASTER_INPUT)`). The master stage text of
  every mode comes from one function (`_master_chain`). `MODES` is unchanged.
- `preview_cli audio`: when a measurement is needed and not cached, the source is decoded once
  (`run_piped`), the measurement is cached as before (`<mix16>.loudness.json`) and the master
  stage runs on the kept pre-master (a private temp file, removed after). f32 carries `[apre]`
  exactly: the loudness equals `audio_measure`'s and the FLAC's PCM the reference's (tests; the
  server P-AUD re-run, 6/6 md5).
- `preview/probe.json` (per clip): the source's `compile_ffmpeg` probe under its file identity
  (device, inode, size, mtime ns), written atomically (replaced when the identity changes);
  `compile_ffmpeg.seed_probe` / `source_identity` / `streams_to_json` / `streams_from_json` /
  `clear_probe_cache`. Used by the `audio`, `cells` and `frame` ops.
- The truth frame (`frame` op) runs at the lane's two threads (plan §2.6), byte-identical to
  the four-thread compiler output (test).

### The persistent preview worker (plan §10.3 contingency; PF-PLAN, PF-AUDIO)

- `python -m ai_clipper.edit_v2.preview_server`: stdin line 1 is `{"op": "serve", "dir": <abs
  path>}` (an existing directory, not a symlink, owned by the user, mode 0700); it listens on
  `<dir>/preview.sock` (0600), prints `{"ready": true, "pid": <pid>}`, imports the lane's modules
  once (`PRELOAD`; not `camera`/`seed`) and forks one child per connection. A connection sends
  one envelope and shuts its write side; the child answers `{"pid": <pid>}\n` at once, then
  `<exit code>\n<result JSON>\n`. The child is one `preview_cli.handle` run (`renice=True`, its
  own session via `setsid`, SIGTERM → cancel → 12). stdin EOF or SIGTERM stops the server (the
  socket is removed); running children finish on their own. The server never starts a thread;
  SIGCHLD is ignored in it and restored in each child.
- `web/lib/python-cli.mjs`: `PYTHON_SERVER_MODULES = ["ai_clipper.edit_v2.preview_server"]`,
  `createPythonServer(module, {cliModule, env, pythonBin, spawnImpl, fallback, readyTimeoutMs,
  restartDelayMs, tmpdir, now})` → `{run(op, payload, options), start(), state(), pid(),
  close()}`. The server is spawned with `childEnv` (E11); `run` has `runPythonCli`'s contract
  (exit codes, bounded output, timeout/abort: SIGTERM to the child's group, SIGKILL after
  `killGraceMs`). While the server is starting, down (restart after `restartDelayMs`, default
  5 s) or when a connection ends before the pid line, the request runs through `fallback`
  (`runPythonCli`): nothing ran it yet.
- `web/lib/preview-lane.mjs`: `PREVIEW_SERVER_MODULE`, `previewServerEnabled(env)`,
  `previewCliRunner({env, createServer, spawnCli})`; `getPreviewLane()` runs preview ops on the
  worker. Server-only env `POTONGIN_PREVIEW_SERVER=off` turns it off (every op spawned).

### Captions (Open 11)

- `subtitles.build_frame_cues`: between two words of the **same piece** the gap is measured in
  source milliseconds (`next.s_ms − min(prev.e_ms, next.s_ms) > max_gap_ms`), as
  `build_caption_cues` measures it; across a cut it stays in output frames. Inside a piece the
  frame cues group words exactly as the legacy cues (property test at the five document rates).
  `RENDER_SEMANTICS` stays 1: `plan_sha256` covers the ASS, so render keys follow, and no
  production render with the new engine exists (the engine flag is `legacy`).

### Job-level prepare and the older helpers

- `POST /api/jobs/:id/clips` (`clip-edit.createPrepareGate`, `PREPARE_RATE` capacity 3, one
  more per 20 s per job): concurrent requests for a job share one `prepare_job` run, jobs are
  prepared one at a time, a burst answers 429 `rate_limited` with `Retry-After`. The
  `prepare_job` process runs at nice 5 (`api.NICE`; `api.handle(..., renice=False)` for
  in-process callers). The lane's own semaphore is not shared (a different CLI module); T4.3 may
  merge them.
- `CHILD_ENV_ALLOWLIST` adds `MAX_UPLOAD_BYTES` (not a secret; `render_queue` reads it for the
  source snapshot limit). `render-requests`, `edit-document`, `candidates`, `caption-cues` and
  `candidate-feedback` spawn Python with `childEnv(options.env || process.env)`.

### Editor client

- Export dialog: the revision shown is `shell-model.exportRevision(state)` (the store's saved
  `revision`; `doc.revision` is the loaded one). `createExportFlow` state adds `lastRunning`
  (the last running RenderDTO); `exportStepView(render, lastRunning)` keeps a cancelled or
  failed render on the step it reached with the status `"stopped"` (`aria-current="step"`).
  `export-flow.earlierExports({history, current, latest})` leaves out the export the dialog is
  running.
- `shell-model.badgeHelp(view)`: the §6.1 statement (`BADGE_HELP`) for the exact badge only;
  the pending, legacy, truth, unsupported and loading badges explain themselves.
- `shell-model.LIVE_WAVES = ["W1", "W2"]` and `liveEntries(entries, runtimeKind, liveWaves)`:
  the real editor shows only the panels and lanes of landed waves; the fakes show every entry.
  **The W3 integrator adds `"W3"`.** `Timeline` takes a `lanes` prop.
- `POTONGIN_EDITOR_FAKES` is a CI/development switch only: the shell specs run it on a
  production build, so it is not tied to `NODE_ENV`; `compose.yaml` never passes it; the fake
  runtime makes no API call. `window.__potonginEditorInspect` stays (read-only state, player
  state and stats; the e2e flow and support read it).

## 5.19 W3 integration resolutions (T3.Z, 2026-10-01)

### Wiring

- `shell-model.LIVE_WAVES = ["W1", "W2", "W3"]`: every registered panel, lane and gizmo shows in
  the app; `EditorApp` filters the gizmos with `liveEntries` too.
- Panel props: `{state, dispatch, player}` plus `api` (the runtime's API client), `previewClient`,
  `uploadAsset` (Appendix A.2; the real runtime's is `lib/editor/upload-client.uploadAsset`, the
  fake runtime passes none and the panels resolve their own fake), `uploadsEnabled`
  (`POTONGIN_EDITOR_UPLOADS`, read by the page through `readEditorFlags`; always true on the
  fakes), `notify` and `readOnly`. A panel may ignore any of them.
- `createEditorRuntime({kind: "real"})` returns `uploadAsset` (`deps.uploadAsset` in tests).
- `EditorApp({jobId, clipId, clipIndex, runtimeKind, features: {uploads}})`.

### Opening a clip with no manual prepare (owner feedback)

- The editor page is `/projects/:id/clips/:ref/edit`; `:ref` is the clip id or `klip-<n>`
  (1–99, the clip's number on the project page) for a clip that has no id until its job is
  prepared (`lib/editor/open-clip.clipRefFromSegment`; anything else is a 404).
- `open-clip.prepareForEditor({jobId, clipId | index})`: `GET /clips`; an openable clip opens at
  once; `needs_prepare` or `analysis_incomplete` → one `POST /clips` (`429` waits `Retry-After`),
  then the listing every 2 s until the clip is openable (12 min limit, `prepare_timeout`); any
  other reason is an error with its Appendix C.6 text; `401` → login with `next` set to the
  editor URL. `EditorApp` runs it when it has no clip id, or once per page load when the store's
  first load answers `not_found`/`analysis_missing`, shows "Menyiapkan klip untuk diedit" with the
  seconds, then replaces the address with the clip id's.
- `clip-entry-view.clipEntryView`: `editHref` for openable clips and for clips the editor
  prepares on open (by id, else `klip-<n>`); `reasonText` only when there is no link;
  `engineLegacy` and `prepareClipEntries` are gone (no engine is named on screen; the page has no
  prepare step).
- `GET /api/jobs` adds `editor: boolean` (`POTONGIN_EDITOR_V3`), so the history offers "Edit klip"
  (to `/projects/:id#klip`) only while the editor is on. The project page's clip list is
  `<section id="klip">`.

### Dark design and latest-only copy

- The editor's colours are the `:root` tokens of `app/globals.css` (no `--ed-color-*`);
  `editor.module.css` holds sizes, the focus ring and the popover shadow. New tokens:
  `--cold-open`, `--cold-open-bg`, `--info-veil`, `--danger-veil`, `--shadow`
  (`docs/design/TOKENS.md`). `web/tests/ui-guards.test.mjs` covers the editor like every page.
- Caption and hook colours (clip content) live in `lib/editor/content-colours.mjs`
  (`CAPTION_SWATCHES`, `DEFAULT_HIGHLIGHT`, `DEFAULT_EMPHASIS`).
- Messages without version or engine words (Python `_MESSAGES` and the JS copy together):
  `op_disabled`, `engine_fallback`, `editor_disabled`, `not_v3`, `legacy_engine`, the unchanged-clip
  badge `"● Belum diubah: ekspor = klip otomatis"` and its help.

## 5.20 W3 verifier fixes (2026-10-01)

- **Timeline layout.** `.timelineBody` aligns its two columns to the top (`align-items:
  flex-start`): the labels and the lanes' scroller take their content's height, the body scrolls
  both together, the last lane (Musik) scrolls fully into view at 1366×768 and 1920×1080, and the
  scroller cannot scroll vertically on its own (labels stay beside their lanes). Hooks for tests:
  `data-timeline-body`, `data-timeline-scroller`, `data-lane-label=<id>` (rows keep
  `data-lane-row=<id>`).
- **Lane notes.** Lanes also receive `onNote(text | null)`; the timeline shows each lane's note
  at the end of its header (`data-lane-note=<id>`, the text in `[data-note-text]`). The marker
  lane keeps its "tidak tersedia untuk job ini" note in the lane when it has no markers and moves
  it to the header when it has some, so no marker covers it.
- **Prepare answer.** `open-clip.prepareForEditor` reads the `POST /clips` answer: when it is
  `{state: "done"}` and lists the requested clip (matched by its number, from the first listing)
  as not openable, the editor shows that reason at once (its Appendix C.6 text; `needs_prepare`
  or an unknown reason → `prepare_failed`) instead of polling the listing for 12 minutes.
  New clip reason `source_unreadable` ("Video sumber tidak bisa dibaca; proses ulang videonya";
  Python `errors.CLIP_REASONS`/`MESSAGES`, `clip-edit.CLIP_REASONS`,
  `clip-entry-view.CLIP_REASON_TEXT`, `shell-model.MESSAGES`): `seed.prepare_legacy_job` uses it
  when `ensure_source_info` raises `SourceInfoError` while the source file exists;
  `source_missing` stays for a source that is gone.
- **Frame grid.** `source_info._grid_pts` runs FFmpeg with `GRID_THREADS` and, when that run
  exits non-zero, once more with `-threads 1 -filter_complex_threads 1` (FFmpeg 6.1.1 aborts on
  some AV1 sources with several threads); a timeout is not retried.
- **Logo presets.** `SnapLogo` places the box 4 % of the width from the left edge and against
  the TikTok zone's right, top and bottom edges (plan §5.9: 93/280/93 px at 720×1280, scaled like
  `plan.ui_zone`), clamped into the frame when the logo is larger than the safe area. `SetLogo`
  without a current logo fits `w_e5` 16000 and places it at the `top_right` preset (a 512×512
  logo at 720×1280: box (512, 93) 115×115, `x_e5` 79097, `y_e5` 11758), so no preset and no new
  logo starts with the G5 warning. `logo-geometry.cornerTransform`/`cornerOf` follow; the
  "margin" magnet guides (4 %/2.5 %) stay for deliberate placements.
- **Check text.** `checksView` names what an `unsafe_zone` warning is about from its pointer:
  `/captions/…` "Caption masuk ke area tombol TikTok", `/tracks/N/items/N/transform/y_e5` "Hook
  …", `/tracks/N/items/N/transform` "Logo …"; other pointers keep the generic message.
  `messageFor` writes a measured detail the Indonesian way (`peak_reduced:-2.20 dB` →
  "(−2,2 dB)", `loudness_clamped:-16.30 LUFS` → "(−16,3 LUFS)"); other details are unchanged.
- **Download names.** The final-file route takes `name` (lower-case letters and digits in words
  joined by `-`, ≤ 64 characters) and answers `Content-Disposition: …; filename="<name><the file's
  extension>"`; anything else keeps the stored name. `clip-entry-view.exportDownload(href, {index,
  revision})` → `{href: "…?download=1&name=klip-NN-revisi-R", filename}`; the export dialog
  (`ExportDialog` takes `clipIndex` from the listing), its earlier exports and the project page's
  latest export use it.

## 5.21 W4 T4.3 additions (performance and retention, 2026-10-02)

Additive; no frozen signature changes. Every FFmpeg argument and graph is unchanged, so the
goldens, the render keys and the delivered bytes stay as they were.

- **Auto render, several clips at once (PF-PIPELINE).** `render_edit.render_slots(budget=None)`
  = `ceil(budget / FFMPEG_THREADS)` clamped to `1…RENDER_SLOTS_MAX` (4); `budget` defaults to
  `face_window.cpu_budget()` (affinity capped by a cgroup CPU quota): 16 CPUs → 4, a 6-CPU
  quota → 2, 4 CPUs → 1. `AutoRenderer(…, slots=None)` adds `schedule(items)` (every
  `(rank, output)` starts in the background, the longest clip first by window plus cold open;
  `order` lists the ranks as handed out), `render(rank, output)` (returns or raises the scheduled
  clip's result; an unscheduled clip renders synchronously as before) and `close()` (cancels what
  nobody took: FFmpeg is killed, nothing of it is published; idempotent, never raises). A heavy
  slot is held by each final encode and each camera plan; workers = slots + 1, so seeds and
  verification overlap the encodes. `render_document(…, encode_slot=None)`: an optional context
  manager held around the final encode only. The pipeline calls `schedule` before its loop and
  `close` in a `finally`; a renderer that cannot schedule renders one clip at a time
  (`potongin: edit-v2 schedule: …` on stderr).
- **Verify.** `verify_output` runs its three readers (the `-count_frames` probe, the video
  packet list of `v:0`, the decode of `a:0`) at the same time, each through its own description
  of the descriptor; the gates and their values are unchanged.
- **OpenCV threads.** `face_window.one_opencv_thread(cv2)`: the first of several overlapping
  windows sets OpenCV's pool to one thread, the last one restores the saved count.
- **Janitor CLI** (`python -m ai_clipper.edit_v2.janitor`, in `PYTHON_CLI_MODULES`): envelope
  `{"op": "run", "nowMs"?, "capBytes"?, "budgetMs"?, "after"?}` (integers; `after` a job UUID;
  ≤ 4 KiB; any other key or op is exit 2), `JOBS_ROOT` from the environment, stdout
  `{jobs, receipts, archives, suggestions, cache_files, cache_bytes, assets, complete, next}`.
  Policies (module docstring): receipts as `store.prune_receipts` (200 committed + pending),
  archives = revision 1 + render-referenced (`doc_relative`) + newest 50 (skipped while an
  export of the job is queued, claimed or rendering), suggestions and leftover temporaries,
  preview caches unused for 30 days, then the job cap (default 1 GiB) by least recent use
  (`max(mtime, atime)`, never a file used in the last 10 min), temporaries and `.cancel`
  markers older than 10 min, assets unreferenced for 30 days (first seen in
  `analysis/assets/.janitor.json` {schema `potongin.janitor/1`, `orphans: {sha: ms}`}; a
  document that cannot be read keeps every asset; a request's `doc_relative` counts only when it
  is `analysis/clips/<clip>/edit/archive/r<N>.<sha>.json.gz`). Jobs being deleted are skipped.
- **Primary worker.** `createJanitorTick` / `createWorkerActivity` in
  `web/scripts/primary-worker.mjs`: slot 0 runs the janitor after the deletion purge when no job
  is active or being claimed, at most every `DEFAULT_JANITOR_INTERVAL_MS` (6 h) and at once on
  start, with `JANITOR_BUDGET_MS` (60 s); an unfinished run continues from its cursor at the next
  idle poll; no slot claims while it runs; a failure is logged as "Editor janitor failed" only.
  `capBytes` comes from `POTONGIN_PREVIEW_CACHE_BYTES` when it is a positive integer. The health
  snapshot (`primaryHealthSnapshot`) counts a running janitor as one active claim (and adds
  `janitor: true`), so `check-primary-worker-health.mjs` does not call the busy loop stale; the
  poll time is refreshed when the run ends. A clip never edited (no `edit/`) is not locked.
- **Preview lane.** A plan answer that finds a cell, the mix or the derived logo missing on disk
  forgets its "built" memory, so the lane queues it again at once (W3 Open 24).

## 5.22 Release contracts (W4, T4.4, 2026-10-02)

### CI suites (`scripts/parity/run_all.sh`, `scripts/parity/ci_gates.py`)

- `sh scripts/parity/run_all.sh smoke|toolchain|full [section…]` runs from a writable copy of the
  repository inside the production image with its environment synced (`uv sync --frozen --python
  /usr/bin/python3 --extra vision --extra web`); `OUT` (default `/out`), `WORK` (default
  `/tmp/parity-work`). Sections: `toolchain ptime ptxt ptxt_full penc pframe gdet paud r10 rt
  frame audio glyph goldens app`. Suites: smoke = `toolchain ptime ptxt pframe gdet paud r10`;
  toolchain = `toolchain ptime ptxt_full penc rt`; full = toolchain + `frame audio glyph goldens
  app`. A failing section is appended to `$OUT/fail.txt`; the script runs the rest and exits 1.
- Evidence: `$OUT/evidence/CI-<gate>.json`. `ci_gates.gate_passed(doc)` reads `pass` (a bool),
  else every `runs[*]` verdict, else `summary.pass`, else `mismatches == 0` or `failures == 0`;
  anything else is a report (PF-RENDER). `ci_gates.REQUIRED[suite]`: smoke `P-TIME-ffmpeg
  P-TIME-jassub P-TXT P-FRAME G-DET P-AUD R10`; toolchain `P-TIME-ffmpeg P-TIME-jassub P-TXT P-ENC
  P-COLOR P-RT R10`; full = toolchain + `P-FRAME P-PLATE G1-G2 G-DET P-AUD G-CLICK duck G3 G3b
  glyph-probe`. `summary --suite S DIR…` exits 1 on a FAIL, an unreadable file or a missing
  required gate. The app gates of `full` (the W3 runner, `scripts/editor/w3_exit_gates.sh plate
  audio`) write to `$OUT/app/evidence` and fail the `app` section through their own `fail.txt`.
- Smoke P-FRAME: `ci_gates.SMOKE_P_FRAME_CASES`, two barcode sources (29.97 CFR fit-blur with the
  hook; 30 VFR center-crop), 760 source frames, 20 cuts and a cold open each (470 output frames
  each); verdict `frame_totals_pass(totals, 300)`, `frame_identity`'s rule with the PR minimum.
- P-TXT: smoke `classic-40,karaoke-40,bold-40,box-40,hook,fallback` plus the five timing
  fixtures, `--formats gbrp --no-export`; toolchain and full: every clip, gbrp, with exports.
  P-ENC: `enc_check.measure_fixtures(…, formats=("gbrp",))` against `W1/T1.Z-P-ENC.json` (the
  baseline rule). P-COLOR: `s_color.score_p_color(…, formats=("gbrp",))`. `ci_gates.py text`
  refuses browser output that names another JASSUB than the pin; P-TIME (JASSUB side) passes only
  with five rates, 0 mismatches and the one-frame-late control flagging every edge.
- `ci_gates.py perf-report` collects every `*PF-*` and `*switch*` evidence of a run into
  `$OUT/perf.json` (`potongin.perf-report/1`); times on CI runners are indicative.

### Workflow (`.github/workflows/ci-cd.yml`)

- PR and push to `main`: `test` (steps unchanged), `toolchain-guard`, `parity` (smoke). Schedule
  `30 18 * * *` (01:30 WIB): `parity` (full). Dispatch input `suite` ∈ {`pr`, `toolchain`,
  `nightly`}. `deploy` is unchanged (needs `test`; push to `main` only). The manual boolean
  `parity` input is gone: its harness is the browser half of every suite. Concurrency groups carry
  the event and the suite, so a nightly never waits for, or blocks, a deploy.
- `parity` builds `potongin-parity:<sha>`, runs the suite in a long-lived tools container, starts
  the image's own app (`node server.js`, `POTONGIN_PARITY_HARNESS=1`, the fixtures read-only) on
  127.0.0.1:3217, installs Chrome for Testing 147.0.7727.15 into
  `~/.cache/ms-playwright/chromium-1217` (`PARITY_CHROME`) and checks its version, runs
  `npm run test:parity`, scores the text gates in the image, writes the gate table to the run
  summary and uploads `parity-<suite>` (JSON evidence and logs, no media) and, outside the smoke,
  `toolchain-evidence` (stamped evidence and record, laid out from the repository root).

### Toolchain guard (`scripts/parity/toolchain_guard.py`)

- `derive_toolchain(dockerfile)` is the `toolchain.json` document the image writes: `ARG
  NODE_IMAGE=` and `ARG DEBIAN_SNAPSHOT=` exactly once each, and the six `toolchain.PACKAGES`
  pinned exactly once (`package=version`) in the one `apt-get install` command; anything else is
  a `GuardError`. `toolchain_sha256` hashes `toolchain.encode(document)` (`4fefb754…85f0` at this
  commit, the W1 image's value).
- `jassub_pin(package.json, package-lock.json)` is `{version, integrity}`: an exact version, the
  same version in the lock and a sha512 integrity.
- Record `docs/editor/evidence/toolchain/record.json` (`potongin.toolchain-record/1`):
  `{toolchain, toolchain_sha256, jassub, gates: {P-TIME: [ffmpeg, jassub], P-TXT, P-ENC, P-COLOR,
  P-RT}, commit, run}`. Each evidence file it names carries `stamp`
  (`potongin.evidence-stamp/1`: `{toolchain_sha256, jassub, commit, run}`); only evidence with a
  boolean `pass` can be stamped.
- `check` fails when the derived sha or the JASSUB pin differs from the record, or when a
  required gate's file is missing, outside the repository, not `pass: true`, or stamped for other
  pins. `image --toolchain /app/resources/toolchain.json` fails when the image's bytes differ from
  the derivation (the `toolchain` section of every suite).

### Licences page (`/licenses`)

- `web/app/licenses/notices.mjs`: `JASSUB` (version, npm integrity, the served files = the keys
  of `clip-media.JASSUB_FILES`, the SPDX expression, source commit `656371a…` and the build
  scripts at it, every component with its source at the exact submodule commit and its licence
  texts, `fullNotice`), `FREETYPE_CREDIT`, `MEDIABUNNY` (version, integrity, tag `v1.59.1`,
  commit), `FONTS`, `WEB`, `licenceFiles()`. Texts: `web/public/licenses/{jassub,mediabunny,
  fonts,web}/*.txt`, served as static files. `web/tests/licenses.test.mjs`: versions and
  integrities equal the pins and the lock; `JASSUB.version === text-layer.JASSUB_VERSION`; every
  linked file exists and every file is linked; the npm and font copies are byte-identical to
  `node_modules` and `resources/fonts`.
- The page sits behind the login like every page (`web/proxy.js` unchanged).

### Lock and lease clocks in tests

- `withPrimaryQueueLock(root, callback, {timeoutMs, staleMs, retryDelayMs, clock})`: `clock =
  {now(): epoch ms, sleep(ms, signal?): Promise}`, default the system clock; a value without both
  functions is refused. The heartbeat (every `staleMs/3`), the owner's `createdAt`/`heartbeatAt`,
  the stale test and the retry delay use it; a partial lock without `owner.json` is still aged by
  its directory mtime (wall time). `web/tests/support/manual-clock.mjs` is the test clock
  (`tick()` jumps to the next wake-up; tests tick only while every party sleeps).
- `tests/test_render_worker.py::test_v3_worker_heartbeats_during_a_long_render_and_prevents_reclaim`
  drives `render_queue.datetime` and the v3 monitor's `clock` (a `_V3Monitor` subclass) from one
  fake clock, moves it only after the monitor's first clock read, and waits for the worker's own
  beat. (T4.4 wrote it for the legacy worker test; T4.1 removed that path, so T4.Z ported it.)

## 5.23 Security hardening (W4, T4.2, 2026-10-02)

Additive; route behaviour is unchanged apart from the refusals below. Evidence:
`docs/editor/evidence/W4/T4.2-QG-SEC*.json`.

- **One guard per route method.** `web/lib/security-headers.mjs` `secureRoute(handler, {params,
  limit})` wraps every method under `/api/jobs/:id/clips/**` and `/api/jobs/:id/assets/**`, and
  (T4.Z) GET and DELETE `/api/jobs/:id/renders/:renderId` with the `api` bucket. Order:
  `requireAuth`; `sameOriginMutation` for any method other than GET/HEAD; each named id against
  `ROUTE_PARAMS` (`id`, `taskId`, `renderId`, `idempotencyKey`: lower-case UUID v1–8; `clipId`:
  `clip_[0-9a-f]{24}`; `sha`: 64 lower-case hex); then the route's rate-limit bucket. Refusals are
  `{error, code, messageId}`: 401; 403 `csrf_rejected`; 400 `invalid_request`; 429
  `rate_limited` with `Retry-After`. A handler exception becomes 503 `backend_unavailable` instead
  of the framework's 500.
- **Headers on every answer.** `X-Content-Type-Options: nosniff` and
  `Cross-Origin-Resource-Policy: same-origin`, plus `Cache-Control: no-store` unless the handler
  set its own. `EDITOR_PAGE_HEADERS` (COOP same-origin, COEP require-corp, nosniff,
  `frame-ancestors 'none'`, `X-Frame-Options: DENY`) is what `next.config.mjs` sends on the editor
  page; a test keeps the two equal.
- **Error redaction.** In an error JSON body, any string that names `JOBS_ROOT` (as set or
  resolved), `POTONGIN_SETTINGS_DIR`, `POTONGIN_RESOURCES_DIR`, the app directory, `/proc/self/` or
  a Python traceback becomes `null`; the status and the code stay.
- **Rate limits** (`web/lib/rate-limit.mjs` `EDITOR_RATE_LIMITS`): new per-session bucket `api`
  (burst 60, then 20/s) for GET/POST `/clips`, GET/PUT `/edit`, `/words`, `/prepare`, GET/POST
  `/renders`, POST `/ai`, GET `/ai/:taskId`, `/cleanup` and `/coldopen-suggestions`. `plan` (10,
  10/s), `frame` (4, 4/s), `upload` (30, 30/min) and `ai` (30 per job per hour) keep their own
  buckets; media and asset GETs have no limit. Scripts that drive the API (a soak, a benchmark)
  stay under 20 requests/s per session, honour `Retry-After`, or log in once per worker.
- **AI quota answer.** The 202 with `llm.state` `rate_limited` also sends `Retry-After`.
- **Media ids.** The media route accepts lower-case job ids only (an upper-case id no longer
  reaches Python).
- `web/lib/python-cli.mjs` is unchanged: the child-environment audit (312 children) found no name
  outside `CHILD_ENV_ALLOWLIST` and no planted secret outside the AI task children.

## 5.24 The caption's default spot is a note (W4, T4.5, K5, 2026-10-02)

The seed keeps the auto clip's caption position (K5: an unchanged clip exports the auto file,
R10), which sits inside the TikTok button zone. The warning about it is now informative:

- `shell-model.checksView({warnings, plan, doc, seed})` returns `severity: "info"` (message
  `CAPTION_SPOT_NOTE`: "Caption di posisi bawaan, dekat tombol TikTok. Kalau tertutup, geser caption
  ke atas.", since §5.27; it no longer names a tab) for an `unsafe_zone` warning on a `/captions/…` pointer when
  `captionAtSeedSpot(doc, seed)` (`doc.captions.overrides.y_e5` equals the seed's). Notes sort last.
- `actionableChecks(checks)` drops notes: "Perlu dicek (n)" counts only errors and warnings, and
  notes appear under "Catatan" with a jump button.
- `export-flow.canStartExport(checks, acknowledged)` ignores `info`: a note needs no tick in the
  export dialog.
- A caption the user moved into the zone, the hook and the logo stay warnings that need a tick.
  The server's `unsafe_zone` warning and the plan are unchanged.

## 5.25 W4 verifier fixes (2026-10-02)

- **Deploy guard.** `deploy/production.sh` (`active_jobs`) treats render-request-v3 `cancelled`
  as finished, like `completed` and `failed`; jobs `completed`, `failed`, `deleting` and (since
  "Batalkan", `docs/operations/PROGRES_JOB.md`) `cancelled` stay quiet. Anything else, and any
  file it cannot read, still blocks the deploy.
  `tests/test_deploy_guard.py` runs the script's embedded Python unchanged on a temporary jobs
  root and ties the allow-list to `render_queue.V3_TERMINAL`.
- **Render worker.** `run_one` skips a job without `analysis/render-requests/` instead of calling
  `claim_next`, which created the directory and its `.queue.lock` in every job it walked past.
- **Export checks.** `export-flow.exportChecks(checks, {unchanged})` →
  `{blocking, warnings, notes}`, and `canStartExport(checks, acknowledged, {unchanged})`. With
  `unchanged` (`exportMatchesSeed`: the export is the auto file, R10) every warning is a note:
  shown, never ticked. Errors still block. "Perlu dicek (n)" and the checks panel do not change.
- **Project entries.** `clip-entry-view.clipEntryFor(listing, job, index)`: the listing's entry,
  else (listing `available` without that clip) a closed entry with the `not_v3` text for a job
  without Selection V3 and the generic text otherwise; null while the listing is off, loading or
  failed. `clip-entry-view.historyOffersEdit(job, editor)`: the history's "Edit klip" needs the
  editor on, a completed job with clips and `options.selectionMode === "v3"`.

## 5.26 Cold-open transition (Transisi cold open, 2026-10-02)

The hook teaser that opens a clip (segment role `cold_open`) cuts into the body with an effect
and an optional whoosh. Spec: `docs/plans/2026-10-02-transisi-cold-open.md` (owner decisions of
2026-10-02, including its "Decisions during build (T1)"). Nothing here moves a frame or a
sample: pieces, frames, samples, speech spans, captions (ASS bytes and cues), the hook, both
envelopes and the time map are the cut's.

### The document join (§3.3)

`{"after": "seg_co", "style": "cut"|"flash_white"|"dip_black", "audio_fade_ms": 0–250,
"sfx"?: {"id": "whoosh", "v": 1}}`. `xfade` → `op_disabled`; another string → `range_invalid`;
`sfx` `null`, not an object or without `id`/`v` → `range_invalid` at the key; an extra key →
`unknown_key`; a well-formed unpinned `{id, v}` → **`sfx_unknown`** ("Efek suara transisi tidak
dikenal") at `/main/joins/0/sfx`. "No sound" is the absent key, never null. Every style can carry
the sound. The structural join rules are unchanged (one join with a cold open, none without).
`schema_minor` stays 0 (§3.8 amendment); `_AUDIO_ROLES` still has `sfx` as `op_disabled` (the
whoosh is a join field, not a track item).

### `edit_v2/transitions.py` (stdlib; imports only `timemap`, `errors`, `glyphs`)

```python
JOIN_STYLES = ("cut", "flash_white", "dip_black"); DISABLED_JOIN_STYLES = ("xfade",)
HALF_WIDTH_MS = {"flash_white": 100, "dip_black": 150}
RGB = {"flash_white": (255, 255, 255), "dip_black": (0, 0, 0)}
YUV_TV = {"flash_white": (235, 128, 128), "dip_black": (16, 128, 128)}

@dataclass(frozen=True)
class SfxSpec:                     # SFX[("whoosh", 1)]: resources/sfx/whoosh/v1.wav
    id: str; v: int; sha256: str; samples: int; hit_smp: int     # 20160 frames, hit 11520

@dataclass(frozen=True)
class SfxPlan:
    id: str; v: int; sha256: str
    start_smp: int                 # max(0, smp(at_f) − hit)
    skip_smp: int                  # max(0, hit − smp(at_f)); 0 in every valid document
    samples: int                   # spec.samples − skip_smp
    hit_smp: int                   # smp(at_f)

@dataclass(frozen=True)
class JoinPlan:
    after: str; style: str
    at_f: int                      # J = Σ frames of the after-segment's pieces
    alpha: tuple[tuple[int, int], ...]   # (output frame, alpha_pm > 0), ascending
    sfx: SfxPlan | None

@dataclass(frozen=True)
class ColdOpenJoin:                # the manifest / seed-context form of an auto render's join
    style: str; sfx: str | None    # sfx: None or "whoosh"
    v: int | None = None           # the sound's pinned version; left out, its latest
    def to_json(self) -> dict: ...                      # {"style", "sfx": {id, v} | null}
    @classmethod
    def from_json(cls, value) -> ColdOpenJoin | None: ...   # strict (any pinned (id, v)), else None
    def doc_join(self, after: str, audio_fade_ms: int) -> dict: ...
AUTO_COLD_OPEN_JOIN = ColdOpenJoin("flash_white", "whoosh"); CUT_JOIN = ColdOpenJoin("cut", None)

def alpha_pm(style, k, fps) -> int: ...          # v = W·num − 1000·|k|·den; round_half_up(1000·v / (W·num)) if v > 0
def join_alpha(style, at_f, total_frames, fps) -> tuple: ...    # frames outside the clip dropped, never rescaled
def plan_joins(doc, pieces, fps, total_frames) -> tuple[JoinPlan, ...]: ...
def lut_chain(joins, fps, composite="gbrp") -> str: ...   # "" or "," + one lutrgb per frame; ValueError off gbrp
def joins_dto(joins) -> list[dict]: ...
def sfx_file(resources_root, spec) -> Path: ...           # O_NOFOLLOW, regular, sha = pin
def load_sfx_pcm(resources_root, spec) -> bytes: ...      # s16le frames, cached by (path, size, mtime)
```

A missing or changed sound file is `RenderFailed("render_failed", ref="sfx")` (legacy:
`RuntimeError("cold-open sound effect is missing or changed")`).

### Frame math

`k = n − J`; each style is a symmetric triangle peaking (1000) on `J`; per side `⌈W·F⌉ − 1`
frames before and `⌈W·F⌉` from `J` (spec §2.2 table, pinned by `tests/test_edit_v2_transitions.py`).
Pixels: `out = floor((p·(1000 − a) + C·a + 500)/1000)`, video layer only: captions, hook and logo
are drawn on top in both engines and in the browser.

### Render plan, plan JSON and keys

- `RenderPlan.joins: tuple[JoinPlan, ...] = ()` is the **last** field (one per document join).
- `RenderPlan.to_json()` gains `"joins": [JoinPlan.to_json(), …]` **only when** a join has a
  style other than `cut` or a sound; every pre-existing document keeps its plan sha (pinned in
  `tests/fixtures/edit_v2/plan-shas.json`).
- `COMPILER_ID`, `COMPILER_VERSION`, `RENDER_SEMANTICS`, `SCHEMA_MINOR`, `PLAN_SCHEMA` and
  `toolchain.json` are unchanged. The render key, `frame_key` and `mix_sha256` cover the
  transition through the plan sha and the graph; `plate_key` never sees it.
- `preview_cli.audio_key` gains `"sfx": [{id, v, sha256, start_smp, skip_smp}]` only with a
  sound (a style-only change reuses the preview mix); `_rev0_identity` gains `"sfx": <sha256 of
  the file>` only when the seed has one.

### Compiler (edit-v2)

- Video: `[vlay]{_TEXT_IN[gbrp]}{lut_chain(joins, fps)},{_TEXT_FILTER}[vtext]` in `final`,
  `reference` and `frame`; each `lutrgb` is enabled on `between(t,(2f−1)·den/(2·num),(2f+1)·den/
  (2·num))` (6 decimals, half up, ≥ 0). Plate cells never carry it.
- Audio: the sound is the fragment's **last** own input, the sidecar `audio-sfx-<id>-v<v>.pcm`
  (`-f s16le -ar 48000 -ac 2`): `asetpts=PTS-STARTPTS[,atrim=start_sample=<skip>,
  asetpts=PTS-STARTPTS],adelay=delays=<start>S:all=1,apad,atrim=end_sample=<T>[au_w]`; the speech
  is closed into `[au_s]` and `[au_s][au_m]?[au_w]amix=inputs=<n>:normalize=0:duration=first`
  feeds `[apre]`. Without a sound the fragment is byte-identical to before.

### Plan DTO (§4.3)

`joins` is always present: `[{after, style, atF, rgb: [r, g, b] | null, alphaPm: [[f, a], …],
sfx: {id, v, startSmp, hitSmp, samples} | null}]`.

### Browser preview (T2)

`web/lib/editor/player/join-layer.mjs`. `validatePlan` refuses a DTO whose `joins` breaks the
shape above (`TypeError("invalid plan DTO: joins")`): `rgb` null exactly for `cut`, `alphaPm`
non-empty exactly when `rgb` is set, frames strictly increasing in `[0, totalFrames)`, alphas
1–1000, one fill per frame. For frame `n` the player draws the plate frame, then blends the whole
canvas toward `rgb` with the export's `⌊(p·(1000 − a) + C·a + 500)/1000⌋` per channel
(`getImageData`/`putImageData` with a 256-entry table; not a `globalAlpha` fill, whose 8-bit
alpha failed P-JOIN-B's SSIM on dark frames, spec "Decisions during build (T2)" 3), then the
text and the logo. `onFrame` carries `joinAlphaPm` (0 without a fill) and `debug.joinAt(n)`
returns the fill. The whoosh comes with the server mix; a style-only change keeps `mixSha256`.
`tests/test_edit_v2_transition_wiring.py` runs the editor's commands, this engine and the
player's validator against each other.

### Auto renders, seeds and the manifest

- `pipeline._render_v3_clips(..., cold_open_join: ColdOpenJoin | None)`: `run_pipeline` passes
  `AUTO_COLD_OPEN_JOIN` (no option; latest only), `render_v3_job(..., cold_open_join=
  AUTO_COLD_OPEN_JOIN)` for the tools, `None` = the stage before the transition (fixtures).
- Legacy: `render_vertical(..., join_style="cut", join_sfx=None)`; with the defaults the command
  is byte-identical. A style adds, per range, `format=yuv420p,geq=lum/cb/cr` blending toward
  `YUV_TV` (`enable` on the side's window); the sound is one more input (`-i <resources>/sfx/
  whoosh/v1.wav`), delayed by `round(J_us·48/1000) − 11520` samples and added at unity by
  `amerge=inputs=2,pan=stereo|c0=c0+c2|c1=c1+c3` after `[speech]pan=stereo|FL=FL+FC|FR=FR+FC,
  aformat=fltp:48000:stereo` (a mono source at 1.0 on both channels, as edit-v2; `amerge` keeps
  the speech to its last sample, where `amix … duration=first` dropped what it held). The join
  `J` (cold-open effect and hit) is where concat starts the body: the later of the length as
  written and the range's measured end (`render._cold_open_join_s`, one `framecrc` pass with
  the render's own seek, run for a style or a sound), else the length as written.
- edit-v2: `render_edit.AutoOptions.cold_open_join: ColdOpenJoin = CUT_JOIN` (last field);
  `AutoOptions.job()` adds `"coldOpenJoin"`; `AutoClip.cold_open_join` is the seed's join (or
  `None` when the seed left the teaser out).
- Manifest clip field `"cold_open_join": {"style", "sfx": {id, v} | null}` on every clip whose
  auto render has a cold open (either engine, fallback included); absent otherwise and on every
  older manifest. The web's manifest sanitiser drops it.
- Seed context key `coldOpenJoin` (the same JSON; missing = `CUT_JOIN`; malformed →
  `SeedError`). `seed.prepare_legacy_job` reads `output/manifest.json` once (≤ 16 MiB, strict)
  and matches entries by `clip_id.manifest_clip_id(entry, source_sha)` (the entry's `clip_id`,
  else the id of its `start`/`end`/`cold_open`); `seed.manifest_joins` keeps the readable
  values. So an old clip seeds a cut and a new one the join it was rendered with: R10 (the
  unchanged clip exports the auto file) holds for both.
- Posters: `pipeline.thumbnail_time(duration, avoid=None)`; a clip with a teaser and a style
  other than `cut` avoids `(L0 − 0.2, L0 + 0.2)`; a default time inside moves to `L0 + 0.25`.
  `write_clip_thumbnail(..., at=None)`.

### Editor commands and two-tab merge (T3)

`SetJoinStyle {style}` and `SetJoinSfx {on}` (precondition `cold_open_missing`; `null` merge
key), `SetColdOpen` keeps the join's style and sound or takes the seed's (else
`AUTO_JOIN = {style: "flash_white", sfx: {id: "whoosh", v: 1}}`); rebase parts `join.style` and
`join.sfx` after `coldopen` (prerequisite `coldopen`; group label "Transisi cold open"). See the
spec §7.2–§7.3.

### Resources

`resources/sfx/whoosh/v1.wav` (48 kHz, stereo, s16le, 20 160 frames, 80 684 bytes; CC0,
self-made, no third-party material) with `v1.meta.json` (`potongin.sfx/1`: sha256, peak 4370,
loudness −29.00 LUFS / −17.20 dBTP measured with FFmpeg 5.1.9). `scripts/sfx/make_whoosh.py`
(stdlib, integers and `Fraction` only) regenerates it; `--check` exits 1 unless the bytes and
the meta's sha are the committed ones. `v1.wav` is immutable: another sound or level is `v2`.

## 5.27 Editor views: Mode Cepat and Mode Lengkap (2026-10-05)

Spec: `docs/plans/2026-10-02-editor-mode-cepat.md` (owner decisions of 2026-10-02 and the
"Decisions during build" sections 13 to 19). No engine, Python, command, rebase, plan or seed
changes: every plan sha and golden is unchanged.

### One editor, two views

- `EditorApp` resolves the view before the shell mounts; the root carries
  `data-editor-view="cepat"|"lengkap"`. Shared, never forked: the store (document, history,
  autosave, draft, two-tab merge), the player and frame bus, the export flow, the conflict dialog,
  "Perlu dicek", the toast, the transcript selection (`selectionStoreFor(clipId)`, which I and O
  also read), and the per-clip clients and stores below. Per view: the side region (cards, or the
  rail and a panel), the bottom region (the scrubber bar, or the transport row and the Timeline),
  the open card or panel.
- The shell is one grid with named areas (`top`, `side`, `stage`, `bottom`, plus `rail` in
  Lengkap). Its children come in a fixed order: TopBar, side, `StageRegion`, bottom. The stage
  keeps its element, parent and key in both views, so a switch never remounts the canvas or calls
  `createPlayer` again. Since the workspace redesign (branch `feat/ux-redesign-workspace`) Lengkap
  places `rail` left, `stage` centre and `side` (the panel, `data-slot="panels"`) right; the rail is
  its own `<nav aria-label="Alat editor">` (`data-slot="rail"`) and comes before the panel in the
  DOM, so Tab still goes from a tab to its panel. Cepat keeps the stage left and the cards right.
- The props bundle (`state`, `getState`, `dispatch`, `player`, `api`, `previewClient`,
  `uploadAsset`, `uploadsEnabled`, `llmEnabled` (§5.35), `notify`, `readOnly`) is built once and
  spread onto `<Panel>` and `<QuickPanel>` alike; cards also get `frameBus` and `showLengkap(panelId)`. `getState` is the
  store's own: work that outlives its panel or card (a music upload, a face analysis) reads the
  document as it is when it finishes.
- `showLengkap` moves focus to the opened panel's rail tab when the pressed control left with Mode
  Cepat. The view switch's polite live region names the view on every change of view, never on
  load. Both bottom regions are `<footer>` landmarks.

### Preference and address (`web/lib/editor/view-mode.mjs`)

- `VIEWS = ["cepat", "lengkap"]`, `VIEW_KEY = "potongin-editor-view"` (localStorage, per viewer),
  `PANEL_IDS`, `CARD_IDS`, `readStoredView(storage)` (null on a throw or an unknown value),
  `writeStoredView(storage, view)` (boolean, never throws), `viewFromUrl(search)` →
  `{view, panel, card}` (unknown ids are null), `resolveView({url, stored})`,
  `urlWithView(href, view)` (sets `?mode`, drops `panel` and `card`), `browserStorage()`.
- Order: `?mode`, else `?panel` (Lengkap) or `?card` (Cepat), then the stored view, then Cepat.
  An `initialPanel` prop counts as `?panel`.
- Only the top bar's switch writes the preference; it replaces the address with
  `urlWithView(location.href, view)` through `history.replaceState`. A card's way to Lengkap
  (`showLengkap`) changes the view and the address, never the preference. Opening never rewrites
  the address. The prepare flow's `replaceState` keeps `location.search` and the hash.
- Login limit: `page.jsx` (out of scope) builds the login `next` without the query, so a
  logged-out deep link lands in the resolved view with no panel or card chosen.

### Cards (`web/components/editor/quick/`)

- Registry `quick/cards.mjs`: `{id, label, owner, component, panel, file, load}` for `hook`,
  `caption`, `lines`, `coldopen`, `layout`, `extras`; `DEFAULT_CARD = "caption"` (no card asks the
  LLM on load, R1); `?card=` overrides; the open card is not remembered.
- Accordion: one card open, a header click on the open card closes it. A body mounts on first
  open and stays mounted while Cepat shows; a closed body is `inert` and hidden after its
  transition. A view switch unmounts every card. Summaries come from `quick/quick-model.mjs`
  (`cardSummary(id, {state, analysis})`).
- Shared rules, one function per control for both views: `panels/caption-model.mjs`
  (`captionCommand(key, value, {drag})`: merge key `null` for a preset pick, `cap:<key>` for a
  slider drag; sizes Kecil 850, Sedang 1000, Besar 1200 (`size_pm`); positions Atas 38000,
  Tengah 60000, Bawah 83000 (`y_e5`, the seed spot); `presetId` is null off the presets;
  `highlightNote`, `captionZoneNote(doc, seed, plan)`, `hookNearNote(doc)`: the note when captions
  and the hook are on and `captions.overrides.y_e5 < hook.transform.y_e5 + 35000`
  (`HOOK_NEAR_BAND_E5`); a hint only, no warning code, check or export tick) and
  `panels/hook-model.mjs` (cleaned text, 90-point limit, `hookTextCommand` with `hook:text`,
  `hookFit`).
- Extracted once, rendered by both views: `panels/TransitionSection.jsx` (T3's markup and copy),
  `panels/ColdOpenSuggestions.jsx`, `panels/use-audition.js`,
  `suggestions/use-hook-suggestions.js` with `suggestions/CompactSuggestions.jsx` (every state and
  the privacy line of the panel).
- Per-clip stores that outlive a card, a panel and a view switch (read with
  `useSyncExternalStore`): `panels/layout-analysis.mjs` `layoutAnalysisFor(clipId)`
  (`subscribe`, `get`, `start({api, dispatch, getState, switchAfter, auto})`, `cancelSwitch()`;
  state `{phase, startedAt, done, total, target, message, code, range, cameraReady}`; a finished
  run applies `SetLayout` once unless a newer run or choice superseded it) and
  `panels/music-upload.mjs` `musicUploadFor(clipId)` (`{phase: "idle"|"uploading"|"processing",
  name, progress, replace, message, names}`; the finished upload applies `SetMusic` to the
  document as it is then). `musicNoticeRead` / `markMusicNoticeRead` keep the keys
  `potongin-editor-music-notice` and `potongin-editor-music-names`, so the copyright notice shows
  once across both views.

### Caption lines as word edits (`web/lib/editor/caption-lines.mjs`)

- `captionRows({plan, doc, words, model})`: one row per `plan.cues` entry,
  `{key: "<seg>:<firstWordId>", seg, cold, f0, f1, wordIds, hiddenIds, text, edited}`. `seg` and
  `cold` come from the plan piece holding `cue.f0`; hidden words are dropped before the next plan;
  `hiddenIds` are the caption-hidden words kept by the cuts next to or between the visible ones.
  `linesSummary({plan, doc, words})`.
- `lineEdit({row, draft, doc, words, upper})` → `{ok: true, commands}` or
  `{ok: false, code, message}`. Tokens are `draft.normalize("NFC").trim().split(/\s+/u)`. Anchors
  are a longest common subsequence of the old words (visible and `hiddenIds`) and the tokens: a
  word pairs with the run of tokens that spells its stored text (two or more once an insertion
  rode on it), each token under `===` or, with `upper`, `toLocaleUpperCase("id")` equality, and the
  length counts tokens; among the longest, the fewest hidden anchors, then the earliest pairing. A
  hidden anchor is unhidden. Between anchors,
  unmatched old words take the tokens in order; extra old words are hidden; extra tokens ride on a
  host word (appended to the hunk's last old word or the preceding anchor, or prepended to the
  next anchor at the start of the row). Commands come word by word in word order:
  `SetWordHidden {on: false}`, then `EditWordText` when the final text differs under the same
  equality (a case-only change under `upper` keeps the stored text), and `SetWordHidden {on: true}`
  for deletions. An empty draft hides every visible word; a draft equal to the row commits nothing.
- Limits (`LINE_LIMITS`, `LINE_MESSAGES`): over 40 tokens `too_many_tokens`; a final word text
  over 40 code points `text_too_long`; control or lone-surrogate characters `text_invalid`;
  `too_many_word_edits` from the dry run. These codes belong to `caption-lines.mjs`, not to the
  command catalogue.
- `checkCommands(doc, ctx, commands)` folds `applyCommand` over the document (all or nothing);
  `commitLine(...)` is `lineEdit`, the dry run and one merge key on every command
  (`actionKey("captionLine")` through `runCommands`), so one commit is one Urungkan. With
  `base: {row, doc}` (the line and document of the draft's first keystroke) the draft is diffed
  against them and the dry run runs on `doc`; the card passes it, and a field whose line leaves the
  page commits its draft that way, as a blur would. Two tabs
  merge per word (`word:<id>.text`, `word:<id>.hidden`). `focusAfterRegroup(oldRows, newRows,
  focusedKey)`: the row now holding the focused row's first visible word, else the first row at or
  after the old `f0` in the segment, else the previous row, else the card's status line.
- The editor fakes caption like the engine (`fakePlan`: per segment, hidden words skipped, a break
  after 4 words and after `.?!…`, Box split over 24 characters as a dev-only width stand-in), and
  `createRealEditorStore` runs the real store over the fake API.

### Keyboard (`web/lib/editor/shortcuts.mjs`)

- `isEditableTarget` is true for content-editable elements, `TEXTAREA`, `SELECT` and text-entry
  `INPUT`s (text, search, email, url, tel, password, number, the date and time types, a missing or
  unknown type); false for checkbox, radio, range, button, submit, reset, color, file and image.
- Space belongs to a focused checkbox, radio, range or button input (as to buttons and the
  `SPACE_ROLES`); arrows belong to a focused radio or range input. Every other global shortcut
  stays global, in both views. No new single-key shortcut.
- The scrubber's own keys are listed in the help with scope `scrubber` (`scrubEnds`,
  `scrubMarks`).

### Mode Lengkap rail, word toolbar; Mode Cepat scrubber

- `rail/Rail.jsx` `Rail({panels, value, onChange})`: a vertical tablist (`aria-label="Panel
  editor"`), tabs `editor-tab-<id>` with `aria-controls="editor-panel"`, names unchanged; ↑/↓ (and
  ←/→) move and select, Home/End, one tab stop. Rows `minmax(var(--ed-target), 64px)`.
- `transcript/word-toolbar.mjs`: `primaryAction(actions)` (extend, else restore when remove is
  off, else remove), `toolbarButtons`, `menuItems` (fixed order, unavailable items keep their
  place with the reason), `toolbarKey`, `toolbarPosition` (8 px above the first selected word,
  below the selection when less than 56 px is free above, clamped). `TOOLBAR_LABEL` "Aksi kata
  terpilih". Every action runs `commandsFor` and `perform`; no command changed.
- `scrubber/scrubber-model.mjs`: `scrubberMarks({doc, words})` (laughs and pauses from
  `buildMarkers`, camera cuts left out; the cold-open range `[0, J)`; the join mark when the style
  is not `cut` or the whoosh is on; `unavailable` passed through), `drawGroups` (marks closer than
  `MERGE_PX` 6 merge at the earliest frame), `nearestMark` (`SNAP_PX` 6), `nextMark`,
  `valueText` ("00:02,2 dari 01:00,6"), `scrubberKey`. `Scrubber({plan, state, player, frameBus,
  disabled})` is a native range input under the drawing.

### Top bar, stage and removed texts

- `--ed-topbar-height` is 64 px. TopBar: "← Proyek", "Klip n/total ‹ ›" (§5.29), title and save
  status, the chip `OTHER_TAB_TEXT` "Terbuka di tab lain", the view switch (`role="radiogroup"`,
  `aria-label="Tampilan editor"`, native radios, a polite live region "Tampilan Cepat" /
  "Tampilan Lengkap"), Urungkan and Ulangi icon buttons, "Perlu dicek (n)" (always rendered), the
  ⋯ "Lainnya" menu ("Kembali ke versi AI", "Pintasan keyboard") and Ekspor.
- Stage: the status sits top left beside the stage (`data-testid="stage-badge"`, `role="status"`,
  no "● " prefix), with a 44 px "?" button named "Apa artinya?"; "Frame akhir" and "Zona aman"
  are pressed-state toggles top right. Tone `legacy` has an empty text and no detail; its help is
  unchanged. `noticesView` never returns `legacy_engine` (the message stays in the JS mirror);
  "Klip ini terbuka di tab lain" is the chip now.
- Lime (`--accent*`) only on Ekspor and the three progress fills; ReadOnlyBanner's button and the
  panels' `.primary:hover` are neutral. The version guard adds `/editor (?:lama|baru)/i` and
  `/tampilan (?:lama|baru)/i`.

## 5.28 Project page workspace and clip downloads (2026-10-20)

Plan `docs/plans/2026-10-20-lanjutan-sesi.md` P1 #7 and A5. Web only; no engine, data or flag
change.

### Download names (`web/lib/clip-download.mjs`, client-safe)

- `slugify(text, limit = 48)`: NFKD, combining marks and apostrophes dropped, lower-case ASCII
  words of `[a-z0-9]` joined by `-`, cut after the last whole word within `limit` (a first word
  longer than `limit` is cut inside it).
- `clipSaveName(clip)` → `"NN-slug"`: the clip number in two digits at least (1–9999, else null)
  and the title's slug (≤ min(48, 64 − number − 1)); `"NN-klip"` without a usable title. Every
  name passes `final-files.isSaveName` (the route's `SAVE_NAME`, now exported).
- `namedDownloadHref(href, name)` sets `download=1&name=<name>` on the files route link;
  `clipDownloads(clip)` → `{name, mp4, mp4File, srt, srtFile}`. The project page's "Unduh MP4" and
  "Subtitle SRT" use it, so they save as `NN-judul.mp4` / `.srt`.
- `zipHref(jobId, indexes = null, {check})`, `zipSaveName(job)` (`<project slug>-klip.zip`, the
  video extension of an upload dropped, `proyek-<id8>` without a usable name), `formatSize(bytes)`
  ("2,4 GB", "18 MB", "98 KB").

### ZIP route (`GET /api/jobs/:id/zip`, `web/lib/clips-zip.mjs`, `web/lib/zip-store.mjs`)

- Behind `secureRoute(…, {params: ["id"]})`: session, lower-case UUID, nosniff, CORP same-origin,
  `Cache-Control: no-store`; no rate-limit bucket (like the files route). The handler checks the
  id again (`invalid_request` 400). It runs behind `web/proxy.js` (a GET download, not an
  upload). `HEAD` answers 405 `Allow: GET` (it would open every file for a body nobody reads).
- `?clips=1,3`: 1–4 digit clip numbers without a leading zero, each once, ≤ 1000 characters,
  every one in the job; the archive keeps the job's order. Without `clips`, every clip.
- Only a `completed` job; each clip's file is its own `output/clip-NN.mp4`, taken from its
  `videoUrl`/`downloadUrl` when they point at this job's `/files/output/<name>` (`clipOutputName`),
  opened with `openFinalFile` (no symlink, contained in `output/`). Every file is opened and the
  total checked before the first byte; any refusal closes what was opened.
- `MAX_ZIP_BYTES` (`maxZipBytes(env)`): blank = 2 GiB (`DEFAULT_MAX_ZIP_BYTES`), capped at
  `HARD_MAX_ZIP_BYTES` 0xFFFF0000; anything but a positive whole number is `zip_config_invalid`.
- `?check=1` → `200 {count, bytes, filename}` without opening a stream. The download: `200`,
  `application/zip`, the exact `Content-Length`, `Content-Disposition: attachment;
  filename="<zipSaveName>"`.
- Errors (`{error, code}`, Indonesian): `invalid_request` 400, `not_found` 404, `not_ready` 409
  (not completed), `no_clips` 404, `invalid_clips` 400, `unknown_clip` 404 ("Klip 07 tidak ada di
  proyek ini."),
  `file_missing` 404 ("File Klip 03 tidak ditemukan di server."), `zip_too_large` 413 ("ZIP-nya
  2,4 GB, batasnya 2 GB. Pilih lebih sedikit klip, atau unduh satu per satu."),
  `zip_config_invalid` 500, `read_failed` 503.
- `storedZipLayout(entries)` → `{entries (with offset), centralOffset, centralSize, total}`; flat
  ASCII names `^(?!\.)[A-Za-z0-9._-]{1,128}$`, unique; ≤ 65534 entries; every size, offset and the
  total ≤ 0xFFFFFFFE (no ZIP64), else `ZipTooLargeError`.
- `storedZipStream(entries, {signal, chunkSize = 256 KiB, readImpl, closeImpl})`: store method,
  version needed 1.0, made by 2.0 (MS-DOS), no data descriptor, DOS time from the file's mtime
  (UTC). Per entry a CRC pass, then the local header and the data, checked against that CRC
  (`ZipSourceChangedError` before the last chunk on a mismatch or a short read). One chunk per
  pull (`highWaterMark` 1). The stream closes each descriptor after its entry and all of them on
  completion, error, cancel or abort. `crc32` is `zlib.crc32` when Node has it (≥ 20.15), else
  `crc32Table`.

### Project page (`web/app/projects/[id]/page.jsx`, `web/lib/project-workspace.mjs`)

- `<section id="klip">`: the heading, the download actions, the filters, then a poster grid
  (`<ul aria-label="Daftar klip">`, one `<article>` per clip labelled by its title, one button
  inside) and one detail panel (`<section id="klip-detail" data-clip-detail=<index>>`, labelled by
  the clip's `<h3>`). The detail panel holds what the card held: video, tags (jenis hook, cold
  open, fokus, "Diedit · revisi n"), title with "Salin judul", hook text, trend chips, score
  block, "Kenapa dipilih", caption with "Salin caption", "Edit klip" first, the latest export,
  "Unduh MP4", "Subtitle SRT", the source range; plus a stepper "‹ n/m ›".
- `scorePill(clip)` → `{text, high}` from the current selection's 0–10 total rounded to tenths
  (`high` from 8,0); null for older clips. The pill is neutral; a lime dot marks `high`. No score
  is called "Hot" or "viral" (README "Important limitations").
- `clipFilterView(clips, filter, edited)`: chips "Semua", "Skor 8+" and "Diedit" with counts and
  the active one. "Skor 8+" is offered only when a clip has a score; "Diedit" only when `edited`
  is a set: `editedIndexes(clips, entryFor)` collects the clips whose editor entry carries the
  "Diedit" badge (`editBadge.tone === "edited"`, `lib/clip-entry-view.mjs`) and is null while the
  clips listing is off, loading or failed, or when no clip can open in the editor. The chip row
  shows with two chips or more; a filter that is not offered reads as "Semua". An empty filter
  shows `filterEmptyText` ("Belum ada klip dengan skor 8 atau lebih." / "Belum ada klip yang
  diedit.") with "Tampilkan semua klip". The choice lives in component state only.
  `keepSelection`, `stepSelection` (no wrap), `clipPosition`.
- `arrowDelta(event)`: ←/→ without a modifier, except in fields, a video or audio element, a
  slider, spin button, list box, menu, tab list, radio group, text box or grid. A keydown on the
  document steps the shown clips; from a poster, the focus follows. Only the current poster is a
  tab stop (`tabIndex` 0, the others −1).
- "Pilih" mode: the posters become toggles (`aria-pressed`), the bar reads "n dipilih · Pilih
  semua · Batal · Unduh (n)"; "Pilih semua" picks the shown clips, a filter change drops hidden
  picks (`prunePicks`), Escape or "Batal" leaves, focus goes to the first poster and back to
  "Pilih". "Unduh semua" zips every clip of the project.
- `checkZip(jobId, indexes)` asks `?check=1` first: a refusal shows the route's message in an
  alert, 401 goes to login, success starts the download with a same-origin `<a download>` and the
  status line "ZIP n klip (size) mulai diunduh.".
- Below 721 px: one column, posters two across (`minmax(132px, 1fr)`), the detail panel under the
  grid; tapping a poster scrolls the panel into view. From 1100 px the video sits beside the text
  and the panel scrolls on its own (sticky, `100dvh − 32px`).

## 5.29 Moving between clips in the editor (2026-10-20)

"Klip 3/8 ‹ ›" in the top bar opens the project's previous or next clip without going back to the
project page. Nothing changes on the server: the order and the neighbours come from the
`GET /clips` listing the shell already loads for the title, so there is no extra request.

### Model (`web/lib/editor/clip-nav.mjs`, DOM-free)

- `clipNavigation({jobId, clipId, clips})`: the listing in clip-number order (the project page's
  order; equal numbers keep the listing's order), `position` and `total`, and `previous` / `next`
  = `{href, position}` of the nearest clip on that side the editor can open, or null. A target
  follows the project page's "Edit klip" rule (`clipEntryView(...).editHref`): an openable clip by
  id, a clip the editor prepares on open by id or `klip-<n>`; any other clip is skipped. Null for
  a one-clip project or a clip the listing does not name: the top bar then shows no group.
- `clipNavHref(href, {view, panel, card})`: the neighbour's path with `?mode=<view>`, plus
  Lengkap's `panel` or Cepat's open `card` (QuickPanel reports it through `onCardChange`); other
  params and the hash are dropped.
- `saveBeforeLeaving({flush, getState, exportPhase})` → `{ok: true}` or `{ok: false, reason}`.
  An export in `saving` or `submitting`: `export`, no flush (leaving could cut the request off).
  Otherwise up to three rounds of `store.flush()`: state `conflict` → `conflict`; state `error`, or
  a rejection that is not a 409 revision conflict → `error`; `saved` with no rejection → ok. A 409
  that merged by itself, or work added while saving, gets another round. `LEAVE_TEXT[reason]` is a
  toast; the store's own UI stays (save status with "Coba simpan lagi", the conflict dialog) and
  nothing is discarded.

### Shell and top bar

- TopBar, right after "← Proyek": `role="group"` `aria-label="Pindah klip"`, `aria-busy` while
  the leave saves; the visible "Klip n/total" (`aria-hidden`) with a visually hidden "Klip n dari
  total"; then two 44 px icon buttons "Klip sebelumnya" / "Klip berikutnya" (icons `back` /
  `forward`, `title` with the shortcut, `aria-keyshortcuts`), `disabled` when that side has no
  target. `.titleBlock` clips sideways, so a long save error, its retry button and the other-tab
  chip never draw over the view switch.
- `goToClip` (EditorApp) runs one leave at a time: it awaits `saveBeforeLeaving`, then
  `window.location.assign`s the neighbour. A full page load gives the next clip a fresh runtime,
  player and store, and the browser's Back returns to the clip before.
- Keyboard: Ctrl+Shift+← / Ctrl+Shift+→ (⌘ on a Mac), ids `previousClip` / `nextClip`, scope
  `global`; like the frame arrows they are left to text fields and focused arrow widgets (radios,
  ranges, sliders, tabs, menus), and the shell ignores them while a dialog is open. The modifier
  keeps the rule of no new single-key shortcut (WCAG 2.1.4).
- Tests: `web/tests/editor-clip-nav.test.mjs` (the model, and the real store over the fake server:
  save, failure, conflict, merge), `web/tests/editor-shortcuts.test.mjs`; in the browser
  `web/e2e/editor-clip-nav.spec.mjs` on the fakes (`editor-gates.yml` `suite=e2e`).

## 5.30 Caption: "Kata per baris" and the Sorot pack (2026-10-20)

Plan `docs/plans/2026-10-20-lanjutan-sesi.md` P1 #9. Every existing document, seed, plan sha,
golden and auto render is unchanged: `PACK_DEFAULT_OVERRIDES` of the four older packs, the seeds
(no `words_max`) and `tests/fixtures/edit_v2/plan-shas.json` are pinned by
`tests/test_edit_v2_captions.py` and `tests/test_edit_v2_plan.py`; a document that writes a
pack's own count compiles to the same cues and ASS bytes as one without the key.

### The override `words_max` ("Kata per baris")

- Document: optional `captions.overrides.words_max`, an integer `WORDS_MAX_RANGE` = 1–4 (§3.3,
  §3.8 amendment). Anything else at the key is `range_invalid` at
  `/captions/overrides/words_max`; `schema_minor` stays 0.
- Engine: `caption_track` builds cues with `max_words = captions_ass.words_per_cue(pack,
  overrides)` (`words_max`, else `pack.words_per_cue`); one-line packs (`max_width_pm`) still
  split wider cues. `build_ass_v2` checks the key like the other overrides.
- Migration: none on disk. Seeds, older documents and the revision-0 ETag stay byte for byte;
  the client reads an absent key as the pack's count (`captionWordsPerLine(doc)` in
  `web/lib/editor/doc-model.mjs`, `PACK_WORDS_PER_LINE` = each pack file's `words_per_cue`).
- Commands: `SetCaptionOverride {key: "words_max", value}` (merge key `cap:words_max`; a value
  outside 1–4 is `value_out_of_range`). The key is present only while it differs from the pack's
  count: choosing that count removes it (a manual revert equals the seed, R10), and
  `SetCaptionPack` removes it when the new pack's count equals it (as `case` follows a pack
  default). `checkDoc` accepts the five keys plus an optional valid `words_max`.
- Two tabs: part `captions.override.words_max` in the "Gaya caption" group; its value is `null`
  while absent and setting `null` removes the key (`rebase.mjs`).
- UI: a `PillGroup` "Kata per baris" (1, 2, 3, 4; four columns) after Ukuran in the Caption card
  and the Teks panel (`CAPTION_WORDS`, `captionWordsId`, `captionWordsCommand` in
  `caption-model.mjs`). The pressed pill is the effective count; the preview regroups with the
  next plan. The editor fakes group by `words_max` when it is set.

### The Sorot pack (`resources/caption-packs/sorot/v1.json`)

- Montserrat ExtraBold at 1.2× (64 px at 720×1280), white with a black outline (H/150),
  `case` `upper` by default, 3 words per cue, one line (`max_width_pm` 880), reveal
  `word_box` with the pack field `word_box` `{pad_x_pm 160, top_pm 110, radius_pm 140,
  dark_text "#111111", light_text "#FFFFFF", dark_from_lstar 60}` (per mille of the font size;
  required with `word_box`, refused otherwise, and only on a `border_style` 1 pack with
  `max_width_pm`).
- Events: per active word window (the Bold windows), every other word of the line as its own
  event, then the box, then the active word, all layer 0 and `\an2\pos(x, bottom)` with
  `bottom = H − MarginV` and `x` the word's centre in the line centred on `W/2` (`hmtx`
  advances in exact integers, centipixels). Words never move between windows; the box shares
  the active word's centre, so kerning inside the word only widens the box on both sides. A
  word event is `{\an2\pos(x,y)\q2[\fsN]…}` (`\1c` emphasis colour on an inactive keyword);
  the active word adds `\bord0\shad0\1c<text>`.
- Box: `{\an2\pos(x,bottom)\bord0\shad0\1c<colour>\p1}` + `_box_path(w, h, r)` +
  `{\p0}`; `w` = the word's advance + 2·pad, `h` = font size − top inset (the box ends at the
  line's bottom), corners rounded with one cubic Bézier each (control offset
  `round_half_up(r·4477/10000)`; `r` capped at half the shorter side; `r` 0 is the plain
  rectangle the Box pack's vector variant draws). Colour: `highlight` ("Warna sorot"), or
  `emphasis` on a keyword. A single word wider than the line limit shrinks with `\fsN` and the
  box follows.
- Text on the box: `word_box_text(colour, box)` is `dark_text` when the CIE L* of the colour
  (`lightness`, from its WCAG relative luminance) is at least `dark_from_lstar` (60), else
  `light_text`. All six swatches are at L* ≥ 62.3, so the spoken word is dark on each (contrast
  6.4:1 on `#FF5C8A` to 18.9:1 on white); a box at L* < 60 gets white text.
- Gates: P-TXT covers `sorot` at 10, 40 and 90 characters (`reference_text.PACKS`, word onsets
  are probe edges), the smoke subset adds `sorot-40` (`run_all.sh`), the player fixtures add the
  `sorot` variant, P-TIME (`support.edit_v2_text`) expects `len(words) + 1` events per window and
  renders Sorot on grey; ASS goldens `sorot__c30` and `words_max_1__c30`; the thumbnail
  `pack-thumbs/sorot.png` comes from `make_pack_thumbs.py`.
- Pack lists: `PACK_IDS` (Python and JS), `PACK_DEFAULT_CASE`, `PACK_WORDS_PER_LINE`,
  `CAPTION_PACKS` ("Sorot", "Kotak warna di kata terucap"), `HIGHLIGHT_PACKS`, `PACK_IMAGES`, the
  transcript harness store. The highlight note for the other packs reads "Dipakai oleh Karaoke,
  Bold dan Sorot; tidak tampak di gaya ini."

## 5.31 Per-clip fallback notes (2026-10-21)

Plan `docs/plans/2026-10-20-lanjutan-sesi.md` A2. Engine and web; no flag. A clip without a
fallback keeps its exact manifest and job shape.

- **Manifest.** `pipeline._render_v3_clips` gives a V3 clip `"fallbacks": [codes]` only when
  something fell back, in this order (the editor's code names):
  - `no_face`: the job's layout is face-track and the clip had no face for at least
    `NO_FACE_CLIP_SHARE` (0.5) of its rendered length, so the crop stayed centred there. Both
    engines count "without a face" with the camera plan's rule: runs of samples without a face
    longer than 1.5 s (`face_tracking.NO_FACE_MIN_SECONDS` = `camera.NO_FACE_MIN_MS`), from the
    run's first sample to the next sample or the end of the range.
  - `engine_fallback`: the edit-v2 engine failed for the clip and the legacy engine rendered it
    (the summary keeps `engine_fallback:<index>`).
- **Legacy engine.** `render_vertical(…, no_face_report=callable)`: under face-track the callable
  gets each source range's seconds without a face (`face_tracking.no_face_seconds`), cold open
  first, before FFmpeg runs. Other layouts never call it.
- **edit-v2 engine.** `AutoClip.no_face_ms` (face-track only, else None): the ms of the seed's main
  segments, each counted as often as it plays, inside the camera plan's `no_face` spans
  (`render_edit._no_face_ms`; the plan's window is wider than the clip).
- **Web.** `lib/jobs.mjs` `CLIP_FALLBACKS` (`no_face`, `engine_fallback`): the manifest's and the
  stored clip's `fallbacks` keep only these codes, once each, in this order; an empty result
  drops the field. `lib/project-workspace.mjs` `clipFallbackNotes(clip)` → `[{code, card, text}]`:
  - `no_face`: poster "Potong tengah", detail "Wajah tidak terdeteksi · potong tengah";
  - `engine_fallback`: detail only, "Dirender dengan cara cadangan" (the editor's wording; the
    picture is the usual one, so the poster stays quiet).
- **Project page.** The poster adds its note to the meta row and to the poster button's
  description; the detail panel lists every note under the tags (`<ul aria-label="Catatan
  klip">`). Both are muted text (`--text-muted`, 7.6:1 on `--surface`), with no colour, badge or
  icon of their own.

## 5.32 Riwayat clip view and the clip listing (2026-10-21)

Plan `docs/plans/2026-10-20-lanjutan-sesi.md` A7. Web only; no engine, data or flag change.

### Clip listing (`GET /api/clips`, `web/lib/clip-library.mjs`)

- Behind `secureRoute(clipLibraryRoute)`: session, nosniff, CORP same-origin, `Cache-Control:
  no-store`; no rate-limit bucket. It runs behind `web/proxy.js` (a GET, not an upload).
- Query, each name at most once: `q` (trimmed, ≤ 200 characters), `high=1`, `since` (an ISO
  moment with a time and a zone), `cursor` (`<createdAtMs>.<jobId>.<index>` from the previous
  page), `limit` 1 to 48 (default 24). Anything else is `400 {error, code: "invalid_request"}`.
- Answer `200 {clips, matched, total, projects, nextCursor, partial}`; a jobs root that cannot be
  read is `503 read_failed` (the message names no directory). A missing root is an empty library.
- Items: `{jobId, index, title, duration, posterUrl, score, projectName, sourceUrl, createdAt}`,
  taken from `serializePublicJob` (so `sanitizeStoredClip`): only a `completed` job whose `id` is
  its directory's name (a lower-case UUID, a real directory, `job.json` a regular file), clip
  numbers 1 to 9999 once each; `title` through `sanitizeLine` (100), `posterUrl` only this job's
  `clip-NN.jpg`, `score` the shown total (`shownScore`, one decimal, null for older clips),
  `projectName` as the history names it (`sanitizeLine`, 160), `sourceUrl` only a stored https
  YouTube link. Transcript, description, hashtags and server paths never leave.
- Order: newest project first (`createdAt`, else `updatedAt`; the job id breaks a tie), then the
  clip number. `nextCursor` is keyset: a project that finishes between two pages does not shift
  them.
- Filters: `high` keeps a shown score ≥ 8,0 (`HIGH_SCORE`, the project page's mark); `since` keeps
  projects made at or after it; `q` matches the lower-cased title, project name and source URL,
  except that a YouTube link (watch, youtu.be, shorts, live, embed, m. and music.) matches the
  video id exactly (`youtubeVideoId`).
- Bounded work: one `readdir` and one `lstat` per job directory per request; a file is read again
  only when its (inode, size, mtime) changed. Changed files are read newest mtime first, at most
  `MAX_READS_PER_REQUEST` (400) and `READ_BUDGET_BYTES` (24 MiB) per request (at least one), each
  file at most `MAX_JOB_FILE_BYTES` (2 MiB, opened `O_NOFOLLOW`); the rest waits for the next
  request and the answer says `partial: true`. A broken or oversized file lists nothing until it
  changes. The cache holds only the items, per process, and starts again for another jobs root.

### Riwayat page (`web/app/projects/page.jsx`, `web/components/ClipLibrary.jsx`, `web/lib/clip-library-view.mjs`)

- "Proyek | Klip" (`role="group"`, `aria-pressed`) under the heading ("Riwayat proyek" / "Riwayat
  klip"). The choice is kept in `localStorage` `potongin-history-view` (`projects` | `clips`),
  every access in try/catch; nothing is shown until it is read, so a remembered "Klip" does not
  flash the project list. The project list loads only in its own view.
- Klip view: a search box (`maxLength` 200, 250 ms after typing), toggle chips "Skor 8+" and
  "Minggu ini" (`since` = Monday 00:00 in the viewer's time zone, `startOfWeek`), a grid of
  `<article>` posters (`components/ClipPoster.jsx`, the project page's), "n dari m klip" and "Muat
  lagi" (the next page appended once per clip; the focus moves to its first new card). The grid
  is grouped by `groupClipsByDay(clips, loadedAt)`: `clipDayGroup` puts a clip's `createdAt` (the
  job's creation time) under "Hari ini" from 00:00 of the viewer's day (a moment ahead of the
  clock too), "Minggu ini" from Monday 00:00 (`startOfWeek`), else "Lebih lama" (also a missing
  date); only groups that hold a clip, in that order. `loadedAt` is the moment the first page
  arrived, so "Muat lagi" (older clips, newest first) only appends below and never regroups what
  shows. With nothing from this week the headings are left out (one plain grid). Markup: `<ul
  aria-label="Klip">` of groups, each an `<li>` with an `<h2>` and its own poster `<ul>`
  labelled by it. States:
  "Memuat klip…", an error with "Coba lagi", "Belum ada klip", "Tidak ada klip yang cocok" with
  "Tampilkan semua klip", and an info line with "Muat ulang" while `partial`.
- A card is a link to `/projects/<id>?klip=N`; its accessible name is the title, its description
  "Klip NN, length, skor x, project, day". Grid columns `minmax(168px, 1fr)` (six across at full
  width), `minmax(140px, 1fr)` below 601 px (two across on a phone, one below about 330 px).
- Project page: `clipFromParam` reads `?klip=N` (1 to 9999); that clip is selected on open, its
  poster takes the focus once and the clip scrolls into view (the detail panel on a phone).
- The shared poster's `PosterText` takes a page's own `flags` on its meta row: the project page
  passes its fallback notes there (§5.31). The listing carries no fallbacks, so the Klip grid shows
  none.

## 5.33 Hook designs: Kicker, Blok and Kotak kata (2026-10-20)

Plan `docs/plans/2026-10-20-lanjutan-sesi.md` P1 #10. The bar (`legacy-bar@1`) stays the
seeds' design and its bytes do not change: the seeds, `tests/fixtures/edit_v2/plan-shas.json`,
the older ASS goldens and `LEGACY_PIN` are pinned by `tests/test_hook_designs.py`,
`tests/test_edit_v2_plan.py` and `tests/test_captions_ass.py`. A document picks a design and
nothing else about the hook changes (start 0, `dur_f`, `y_e5`, at most 90 code points).

### Document

- `payload.design` is `{id, v: 1}` with `id` in `HOOK_DESIGN_IDS` = `legacy-bar`, `kicker`,
  `blok`, `kotak` (`edit_v2/__init__.py`, `web/lib/editor/doc-model.mjs`). Any other id or
  version stays `op_disabled` at `/tracks/N/items/0/payload/design`; a non-string id or a
  non-integer `v` is `range_invalid`. `schema_minor` stays 0 (§3.8 amendment).

### Design files (`resources/hook-designs/<id>/v1.json`, `potongin.hook-design/1`)

- The bar's file records the constants of its code and is unchanged. Every other file has
  exactly the keys `schema id v name layout font font_ratios_e5 max_lines max_chars
  side_margin_pm line_pitch_pm outline colours box kicker fade_in_ms fade_out_ms default_y_e5
  layer`, integers only, checked by `captions_ass.hook_design` (cached; `HookDesign`, `HookBox`,
  `HookKicker`): `layout` is `kicker`, `block` or `keyword`; `font` is a pinned font of
  `fonts.json`; `font_ratios_e5` strictly decreasing (largest first); `max_chars` 90; `colours
  {text, outline, accent, on_accent}`; `box {pad_x_pm, top_pm, radius_pm}` with `block` and
  `keyword` only; `kicker {scale_pm, max_words, gap_pm}` with `kicker` only; a `block` design's
  `text` colour equals `on_accent`.
- All three use Montserrat ExtraBold (OFL-1.1, already pinned), at most 3 lines, a 6% side
  margin, accent `#FFE14D` with `#111111` on it, outlined text white with a black outline H/150,
  `\fad(150,250)` like the bar, and layer 1 (over the captions).

| Design | id / layout | `font_ratios_e5` | Look |
|---|---|---|---|
| Kicker | `kicker` / `kicker` | 5800 … 2900 (8 sizes) | A kicker line at 600‰ of the punchline size in the accent colour (outline scaled to it), gap −40‰, then the punchline; pitch 960‰ |
| Blok | `blok` / `block` | 5200 … 2700 (8 sizes) | Every line on its own rounded accent box, dark text without outline; pad 260‰, top inset 60‰, radius 120‰, pitch 1100‰ |
| Kotak kata | `kotak` / `keyword` | 5800 … 2900 (8 sizes) | Outlined white lines; one word on a rounded accent box, dark without outline; pad 160‰, top inset 60‰, radius 140‰, pitch 1000‰ |

### Layout (`captions_ass.layout_hook(text, *, play_res, y_e5, design)`)

- The text is `shorten_hook_text` (90 code points, "…"), as for the bar. Sizes
  `S = max(1, rhu(H·ratio, 10⁵))` are tried largest first. A line fits when
  `units·S ≤ usable·height_units` (`hmtx` advances of the drawn text), with
  `usable = W − 2·rhu(W·side_margin_pm, 1000) − 2·edge` and `edge` the outline rounded up (or,
  for a box design, at least `rhu(S·pad_x_pm, 1000)`). Greedy word wrap; a word wider than a
  line is split by characters. The first size with at most `max_lines` lines wins. Otherwise, at
  the smallest size, the lines after the second are joined and shortened with "…" until they
  fit, and `overflow` is true: the `hook_overflow` warning, the plan's `hook.overflow` and the
  "Muat / Akan terpotong" badge work as for the bar.
- Kicker: with three words or more, the kicker is the leading words through the first word that
  ends with `: ? ! . , ; …` among the first `max_words` (5), never the last word; without one,
  the first `max(1, min(⌊n/3⌋, 3))` words. Its size is `rhu(S·scale_pm, 1000)`, shrunk to
  `⌊usable·height_units/units⌋` when wider than a line. Only the rest wraps and auto-fits. The
  layout's `lines` (the plan DTO's `hook.lines`) list the kicker first.
- Kotak kata: the boxed word is `boxed_word_index(tokens)` over the shown lines: the first token
  written in capitals (two letters or more) unless every token with letters is, else the
  longest by letters and digits (the last of equals).
- Vertical, with `top = rhu(y_e5·H, 10⁵)`: Kicker puts the kicker's bottom at `top + K` and the
  first punchline line's bottom at `top + K + rhu(S·gap_pm, 1000) + S` (`top + S` without a
  kicker). Blok and Kotak kata put the first box's top at `top`, so the first line's bottom is
  `top + S − rhu(S·top_pm, 1000)`. Each next line is `rhu(S·line_pitch_pm, 1000)` lower.

### Events (`build_ass_v2`)

- Style `Hook`: the design's font at `S`, primary `colours.text`, outline colour
  `colours.outline`, outline `H·num/den` in centipixels, BorderStyle 1, shadow 0, MarginV 0.
  Every event is `Dialogue: 1,<safe_cs(f0)>,<safe_cs(f1)>,Hook,,0,0,0,,` and then
  `{\fad(150,250)\an2\pos(x,bottom)…}`, all on the hook's frame window.
- Kicker: the kicker line `…\q2\fsK\bordO\1c<accent>}`, then one event per punchline line
  `…\q2}` centred on `W/2`.
- Blok: per line a box `…\bord0\shad0\blurE\1c<accent>\p1}` +
  `_box_path(rhu(S·units, height_units) + 2·pad, S − inset, radius)` + `{\p0}`, then the line
  `…\q2}`. `E = H/1280` px to two decimals (H the text height: 1 at 1280, 1.5 at 1920;
  amended 2026-10-22): under 4:2:0 a hard accent edge over the video rings in chroma, and
  P-ENC measured Blok at SSIM 0.9888 whole frame and 0.9734 on the hook; with the soft edge
  0.9903 and 0.9864. Kotak's box and every text stay sharp.
- Kotak kata: a line without the boxed word is one event; the line with it is one `\pos` event
  per word at its place in the line centred on `W/2` (as Sorot, §5.30), the box right before the
  boxed word, which is drawn `…\q2\bord0\shad0\1c<on_accent>}`.
- `HookSpec` gains `design` (default `LEGACY_HOOK_DESIGN`); `HookLayout` gains `style`, `events`
  and `layer`, empty for the bar, which keeps `_hook_style` and `_hook_events`.
- `glyph_unsupported` checks the design's font (`hook_font_file`: DejaVu Sans Bold for the bar,
  Montserrat ExtraBold for the others). The AI hook suggestions measure `fits` and missing glyphs
  against the item's design (`editor_ai.HookContext.hook_design`).

### Editor

- Command `SetHookDesign {id}` (after `SetHookY`; merge key null): `hook_missing` without a hook,
  `value_out_of_range` for an id outside `HOOK_DESIGN_IDS`; it replaces `payload.design` only.
  Picking the bar again equals the seed (R10). `SetHookEnabled` still brings back the seed's item
  (the bar).
- Two tabs: part `hook.design` after `hook.y`, prerequisite `hook.on`, group "Teks hook";
  `hook.on`'s identity no longer includes the design. The dialog shows the text with the design
  name when it is not the bar.
- UI: "Desain hook" in Mode Cepat's Hook card (four tiles after the suggestions) and in Mode
  Lengkap's Teks panel (four cards with a note, before "Durasi hook"), both from
  `hook-model.mjs` (`HOOK_DESIGNS`, `hookDesignId`, `hookDesignCommand`, `hookDesignHint`).
  Names (`HOOK_DESIGN_NAMES`): Bar, Kicker, Blok, Kotak kata. Kicker and Kotak kata add a line
  under the picker on which words they set apart. The picker is disabled while the hook is off.
- Thumbnails: `web/components/editor/panels/hook-thumbs/<id>.png` (320×80; the sample
  "Ternyata: dia DITAHAN" at `y_e5` 13000 over the pack thumbnails' flat plate, band
  `0,160,720,180`) from `scripts/editor/make_hook_thumbs.py` in the toolchain image, with a
  `manifest.json` that pins the design files (`tests/test_editor_hook_thumbs.py`).

### Gates

- P-TXT: the gated clips `hook-kicker`, `hook-blok` and `hook-kotak`
  (`reference_text.HOOK_DESIGN_TEXTS`), all three in the smoke subset of `run_all.sh`; the player
  fixtures add the variants `hook-kicker`, `hook-blok` and `hook-kotak` on the 29.97 case.
- P-TIME: `<rate>/hook0-<design>` cases, rendered on grey; a hook's expected events are its
  layout's `events` (the bar: one per line).
- ASS goldens `hook_kicker__c30`, `hook_blok__c30` and `hook_kotak__c30` from the fixtures
  `valid/hook_design_<id>__c30.json`.

## 5.34 Pengaturan "Tentang sistem" (2026-10-20)

A read-only section at the bottom of Pengaturan (`/settings`) shows the tools this server runs.
Nothing in it reaches the network or names a host, a path or a user.

- **`python -m ai_clipper.system_info`** (in `PYTHON_CLI_MODULES`, stdlib only): envelope exactly
  `{"op": "versions"}` (≤ 1 KiB, no duplicate keys), answer `{"yt_dlp": "<version>" | null}`
  with exit 0. The version is `importlib.metadata.version("yt-dlp")` when it matches
  `[0-9A-Za-z][0-9A-Za-z.+!_-]{0,39}`; a missing package or broken metadata is `null`. Any other
  envelope exits 2 with the fixed `internal_error` body of §5.9.
- **`web/lib/system-info.mjs`** (server only): `readSystemInfo({env, resources, ytDlp})` resolves
  `{ytDlp, ffmpeg, libass, whisperModel, whisperModelCustom, commit}` and never rejects; each
  unknown value is `null`.
  - `ytDlp`: `createYtDlpReader()` runs the CLI through `runPythonCli` (10 s timeout, 1 KiB of
    stdout), keeps a version for 10 minutes and a failure for 1 minute, and shares one call
    between concurrent readers.
  - `ffmpeg`, `libass`: the upstream part (no epoch, no Debian revision) of `packages.ffmpeg`
    and `packages.libass9` in `<resourcesDir()>/toolchain.json` with schema
    `potongin.toolchain/1`, read with a 64 KiB cap. No file (local runs), odd JSON or an odd
    version string is `null`.
  - `whisperModel`: `WHISPER_MODEL`, `small` when blank (as `run-job.mjs`). A value that is not
    a plain model name (`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`, so any path or repository id) is
    `null` with `whisperModelCustom: true`.
  - `commit`: the first 7 hex digits (lower case) of `POTONGIN_APP_COMMIT` when it is 7 to 40 hex
    digits. The image sets it from the build argument of the same name; compose passes
    `${IMAGE_TAG:-}`, which `deploy/production.sh` sets to the deployed commit. The `ARG` and
    `ENV` lines sit after the Dockerfile's last `RUN`, so a new commit rebuilds no layer.
- **`GET /api/settings/system`**: the session first (`requireAuth`, 401 `no-store`, the reader
  does not run), then `readSystemInfo()` as JSON with `Cache-Control: no-store`; a reader failure
  is 500 `{error: "Info sistem tidak bisa dibaca", code: "system_info_failed"}`.
- **`web/lib/system-info-view.mjs`** (browser-safe): `systemInfoRows(info)` gives five rows in
  order (`yt-dlp`, `FFmpeg`, `libass`, `Whisper`, `Build`), each `{id, label, hint, value,
  known}`. A missing value, or one that is not a short plain token, is `UNKNOWN`
  ("tidak diketahui"); a custom Whisper model shows "Model kustom". The labels carry no version
  wording (the "latest only" guard of `settings-trends-ui.test.mjs` forbids "versi" on the page).
- The page loads the section on its own (`SystemInfo`), independent of the AI settings: states
  "Memuat info sistem…" (`role="status"`), "Info sistem tidak bisa dimuat." with a plain
  "Coba lagi" (`role="alert"`), and the `<dl className="systemList">`. No lime: the accent stays
  on Simpan.

## 5.35 Cek ejaan (2026-10-20)

Spelling suggestions for the clip's caption words through the free LLM chain (plan
`docs/plans/2026-10-20-lanjutan-sesi.md` P2). No engine, plan, seed or command change: an accepted
suggestion is an `EditWordText` (plus `SetWordHidden` for merged words), so every golden and plan
sha is unchanged.

### Route and flags

- `POST /clips/:clipId/ai` takes `{task: "spelling", doc}` beside `{task: "hooks", doc}`, under
  the same prologue (session, `POTONGIN_EDITOR_V3`, same origin, ids, JSON type, 1 MiB + 4 KiB).
  Spelling has no instant part: no `heuristic` child, the answer is `202 {taskId, llm}` with the
  hook task's `llm` states (`pending`, `disabled` with the settings notice, `rate_limited` with
  `retryAfterMs` and Retry-After). The LLM part runs under the same rule (`POTONGIN_EDITOR_LLM=on`,
  `POTONGIN_LLM` not off, a provider in the saved Pengaturan settings), the same per-job limit
  (30 tasks per hour, hooks and spelling together) and at most 3 tasks at once; the child is
  `run-task` with `engineProcessEnv(await loadLlmEnv())` and the 25 s kill.
- The page passes `features.llm` (`readEditorFlags().llm`); the shell's props bundle carries
  `llmEnabled = runtime.kind === "fake" || features.llm === true`. Without it neither view shows
  the "Cek ejaan" button.

### Python (`ai_clipper.editor_ai` + `ai_clipper.editor_spelling`)

- `editor_ai.request_parts(raw) → (task, doc bytes)` accepts `TASKS = ("hooks", "spelling")`; the
  `heuristic` op refuses a spelling body (`invalid_json`, exit 3). `run_task` builds a
  `_TaskPlan` per task: the spelling one sends `spelling_lines(doc, words)` (the hook task's
  visible lines, each word with its id, index and current text; a word whose prompt-cleaned text
  differs from the stored one is shown but takes no fix), cut from the end to
  `PROMPT_TOKEN_BUDGET` 4000, with `prompts/editor_spelling_v1.md`, `MAX_OUTPUT_TOKENS` 1500 and
  temperature 0, inside the same 20 s deadline. The task file (`potongin.editor-ai-task/1`) has
  `task: "spelling"`, `promptVersion: "editor-spelling-v1"`, `truncated`, `linesSent`,
  `linesTotal`; the answer adds `truncated`. Error codes are the hook task's.
- The model answers `{"fixes": [{"line", "from", "to"}]}`; `{"fixes": []}` is a clean transcript.
  `validate_fixes` keeps a fix when `from` (outer punctuation stripped) is one to three adjacent,
  visible words of that line (exact match first, case-folded only when nothing matches exactly;
  every non-overlapping occurrence) and `to` stays a spelling of them: letters, marks, digits,
  space, `-`, `'`, `’`, `.`, `&` only; at most `words + 1` tokens (≤ 3); the same digit runs; on the
  words without spaces, hyphens and apostrophes, case-folded, an edit distance with adjacent
  transpositions of at most one per three letters (at least one). The words' own leading and
  trailing punctuation is kept; the new text is at most 40 characters. Dropped codes: `format`,
  `line`, `not_found`, `empty`, `text`, `too_many_words`, `number`, `too_different`, `unchanged`,
  `too_long`, `overlap`, `limit` (60 suggestions). An answer that is not a `fixes` list, or a list
  with no well-formed item, is `invalid_output`.
- A suggestion is `{id: "sp_<task prefix><n>", wordIds: [1–3], from, to, kind}` in transcript
  order: `from` the words' current text joined by spaces, `to` the first word's new text (the
  other words are merged into it), `kind` `case` (capital letters only), `spacing` (word boundary
  or hyphen) or `spelling`.

### Node and the client

- `taskView` reads the record's `task`: a spelling record is sanitised by `sanitizeSpelling`
  (`sp_` id, 1–3 distinct word ids `w\d{6,7}`, `from` ≤ 160 and `to` ≤ 40 characters after
  cleaning, `from ≠ to`, a known kind; other fields dropped), at most 60, plus `truncated`.
- `createApiClient().aiSpelling(doc)` posts `{task: "spelling", doc}`; the fakes answer a pending
  task that `aiTask` completes with two suggestions on the fake words.
- `components/editor/spelling/model.mjs`: `createSpellCheck({api})` (phases `idle`, `checking`,
  `done`, `failed` with a code, `error`, `off` with the settings notice, `rate_limited`; polls
  every second for 30 s; `skip(id)` and `restoreSkipped()` are the viewer's own and a new check
  clears them), `spellingFor(api, clipId)` (one controller per clip and client for the page),
  `spellingRows({suggestions, model, skipped})` → `{rows, applied, stale, skipped}`: open while the
  words read `from` and show (body or cold open, not hidden), applied once the first reads `to` and
  the others are hidden, else stale; rows carry three words of context each side within the
  sentence unit and the source span for "Putar". `acceptCommands(row, mergeKey)` and
  `planAccept({rows, doc, ctx, mergeKey})` (a dry run per row; a refused row is skipped with its
  message).
- `use-spell-check.js` and `SpellingReview.jsx` (region "Cek ejaan", list "Saran ejaan"): rows
  "…context salah → benar context…" with the kind ("Huruf kapital", "Spasi", "Ejaan") and
  Terima, Lewati, Putar; "Terima semua (n)" and "Periksa lagi"; one `actionKey("spelling")` per
  accept, so one Urungkan. After a row leaves, focus goes to the next row's Terima, else the status
  line. The review opens from the transcript header (beside Rapikan; one review open at a time) and
  from the Teks caption card; the first opening asks the LLM, never the editor's load (R1).

## 5.36 Pengaturan "Logo bawaan" (2026-10-21)

One logo set in Pengaturan (`/settings`) that the clips of every job created afterwards start
with (plan 2026-10-20 A6). Each clip keeps it replaceable and removable in the Logo panel.

- **Store** (`web/lib/default-logo.mjs`, server only): `<settings>/default-logo/` (0700, files
  0600) holds `current.json` `{"schema": "potongin.default-logo/1", "sha256", "updatedAtMs"}`
  and the pair `<sha>.png` + `<sha>.json`, byte for byte what a job's asset store holds after an
  upload (§9.2: RGBA PNG ≤ 1024 px, metadata `potongin.asset/1`). A logo reads as set only when
  the pointer, the metadata (`kind image`, `mime image/png`, `w`/`h` 1…1024) and a regular PNG
  of `bytes` bytes agree; anything else is no logo. Writes in the web process are serialised
  (one in-process lock): install, removal and a job's copy never see half of another.
- **`GET /api/settings/logo`** → `{logo: DTO | null, enabled, autoClips}`. DTO = the asset
  upload's (`sha256, kind "logo", mime, w, h, durationMs null, lufsC null, name, peaksUrl null`)
  plus `url` `/api/settings/logo/<sha>` and `updatedAtMs`. `enabled`: `POTONGIN_EDITOR_V3` and
  `POTONGIN_EDITOR_UPLOADS` both `on`. `autoClips`: the automatic clips render with `edit-v2`
  (`POTONGIN_RENDER_ENGINE` is not `legacy`, §5.48).
- **`POST /api/settings/logo`**: the transport of `POST /api/jobs/:id/assets` with
  `X-Asset-Kind: logo` (types, 10 MiB cap, `Content-Length`, `Idempotency-Key`, `X-Asset-Name`,
  the 64-byte sniff, the upload rate bucket, drain before a refusal). Order: session (401),
  flags (404 `uploads_disabled`), same origin (403), rate (429), transport (400/411/413/415;
  `music` is 415). The body goes to `<dir>/.work/<uuid>/analysis/assets/.incoming/<uuid>` and
  `python -m ai_clipper.edit_v2.assets ingest` runs with `JOBS_ROOT=<dir>/.work` and that scratch
  job id (the same normaliser, caps, prlimit and child env as a job upload; at most two ingests
  at once, shared with the editor). Exit 3 keeps its code (`asset_rejected` with its `reason`,
  415, 413); anything else is 503 `backend_unavailable`. On success the pair moves into `<dir>`,
  `current.json` is replaced atomically, other pairs go, and the answer is `201` DTO. The scratch
  job is always removed. A settings directory that cannot be used (inside `JOBS_ROOT`, a
  symlink) is 503 `settings_unavailable`. No storage reservation: one file of at most 10 MiB
  outside `JOBS_ROOT`.
- **`DELETE /api/settings/logo`**: same origin; removes `current.json` and the pairs; `200` with
  `logo: null`. Jobs created earlier keep their copy.
- **`GET|HEAD /api/settings/logo/:sha`** (behind the proxy): only the current logo's PNG,
  `private, max-age=31536000, immutable`, `Content-Security-Policy: default-src 'none';
  sandbox`, `nosniff`, `ETag`; any other sha, a symlink or a broken pair is 404.
- **Proxy**: `web/proxy.js` excludes exactly `api/settings/logo/?$` (the streamed body); every
  method there checks the session itself (`secureRoute`, then the handler). The image route
  still runs the proxy (`web/tests/proxy-matcher.test.mjs`).
- **The job's copy**: `POST /api/jobs` calls `snapshotDefaultLogo(jobRoot)` before the job is
  published: the current pair is copied (O_EXCL, 0600) into `<job>/logo/` (0700). It never fails
  the job; without a logo nothing is written. `<job>/logo/` sits beside `input/`, `analysis/` and
  `output/`, so a queue attempt's publication (which replaces `analysis/`) leaves it alone.
- **Seeding** (`edit_v2.assets.job_logo` / `seed_logo`, `edit_v2.seed`): `job_logo(job_root)`
  accepts exactly one `<sha>.png` + `<sha>.json` whose PNG hashes to `sha`, is an intact
  stripped 8-bit RGBA PNG (`strip_png` round-trips) of the metadata's `w`×`h` (≤ 1024), with
  `schema`, `kind`, `mime` and `bytes` as the ingest writes them; anything else is no logo.
  `seed_logo(job_root, job_dir)` adopts it into `job_dir`'s store under the store lock (upload
  quota; a failure means no logo) and gives the seed-context key `logo {sha256, w, h}`.
  `prepare_legacy_job` resolves it once per run under the prepare lock; `AutoRenderer` resolves it
  in its constructor from `render_edit.job_dir_for(artifact_root)` (the job, also for a queue
  attempt) into the attempt's store. `build_seed` places it as track `{"id": "tr_ovr", "kind":
  "visual", "band": "over_text", "role": "overlay"}` after the hook, item `it_logo`,
  `{at clip_start}`…`{at clip_end}`, `payload {asset, mode "free"}`, origin `seed`, and the
  `assets` entry `{kind image, mime image/png, w, h}`. The transform is
  `seed.default_logo_transform(output, w, h)`, the editor's SetLogo placement (`commands.mjs`
  `defaultLogo`): `w_e5` 16000 shrunk until the box fits, the top-right preset just outside the
  TikTok zone, `opacity_pm` 850; a logo no size from 4 % fits is left out (the editor refuses
  it too). `tests/fixtures/edit_v2/default-logo-vectors.json` holds 24 placements written by
  SetLogo; Python and JS both check them. The logo changes `base.seed_sha256`, never the clip id.
- **R10 with a logo** (`doc.auto_file_is_seed`, JS `doc-model.autoFileIsSeed`): the legacy
  renderer never draws a logo, so a seed with `base.engine.compiler` `legacy` and a visual item
  is not its auto file. The queue (`render_queue._prepare_v3`) and the worker
  (`render_edit._is_seed_content`) skip R10 for it without `auto_file_unavailable` and render
  the export; the preview's `rev0` has `autoRenderUrl: null`; the export dialog does not say
  "Tanpa perubahan: file klip otomatis dipakai langsung" (`shell-model.exportMatchesSeed`).
  An edit-v2 seed keeps R10: the auto clip was rendered from the seed, logo included.
- **Janitor**: `seed.json` now counts as a document, so an asset only a seed names (the default
  logo of a clip whose user removed it) is never an orphan.
- **Card** (`web/app/settings/DefaultLogoCard.jsx`, `web/lib/default-logo-view.mjs`, browser
  upload `upload-client.uploadDefaultLogo`): loaded on its own like "Tentang sistem". States:
  "Memuat logo bawaan…", "Logo bawaan tidak bisa dimuat." with "Coba lagi", "Belum ada logo"
  with the accepted types, the logo on the editor's checkerboard with name and `w × h px`,
  "Pilih logo" / "Ganti logo", "Hapus", upload progress with "Batalkan unggahan", and
  "Unggah logo belum diaktifkan di server ini." when `enabled` is false (removal still works).
  The copy says where the logo goes, that existing clips do not change, and, by `autoClips`,
  either that the automatic clip files carry it or that it is used when a clip opens in the
  editor (and in its export) while the automatic clip file stays without it. `accept` equals the
  Logo panel's. No lime: the accent stays on Simpan. The Logo panel names a seeded logo
  "Logo bawaan".

## 5.37 Rentang waktu: time ranges kept as clips (2026-10-21)

Plan `docs/plans/2026-10-20-lanjutan-sesi.md` P2 "Rentang waktu manual". Engine and web; no flag.
A job without ranges keeps its exact options, argv, selection artifact, manifest and stage
summaries (tests compare them byte for byte).

- **Grammar** (`src/ai_clipper/time_ranges.py` and `web/lib/time-ranges.mjs`, one grammar and the
  same Indonesian messages; `web/tests/time-ranges.test.mjs` runs both on the same inputs). A
  range is `<start>-<end>`; a time is whole seconds (`90`), `m.ss`/`m:ss` or `h.mm.ss`/`h:mm:ss`,
  parts after the first exactly two digits 00–59. NFKC first (full-width digits, `．`, `：`,
  `－`); hyphen, `‐`, `‑`, `‒`, en dash, em dash or `−` between the times. Ranges are split on
  `,`, `;` and line breaks and keep the typed order. Each lasts 5–180 s; at most 10 ranges, at
  most the job's `limit`, none overlapping (touching is fine); the text is at most 500 code
  points. Refusals are `TimeRangeError` with code `time_range_invalid`.
- **Job API.** Form field `timeRanges` (in `JOB_FORM_FIELDS`); stored as `options.ranges: [{start,
  end}]` in whole seconds, V3 only, omitted when empty. `POST /api/jobs` answers a refused range
  `400 {error: <the message>, code: "time_range_invalid"}` and queues nothing.
  `validatePersistedJobOptions` re-checks stored ranges (`validStoredRanges`).
- **Worker → engine.** One `--range=<start>-<end>` per stored range, in order. CLI `--range`
  (repeatable, V3 only, at most `--limit`) reads the same grammar.
- **Engine.** `run_pipeline(ranges=…)` (`TimeRange` values) refuses a range that ends more than
  1 s past the probed video before any transcript work (`range_beyond_video`). `select_clips_v3`
  makes each range a clip exactly as typed, first, `manual=True`: units whose middle lies inside
  the range (else those it touches), packaging, scores and reasons from
  `hook_heuristics.package_spans` (first reason "Rentang waktu yang kamu ketik: m:ss–m:ss."),
  cold open, focus label and trends as for a heuristic clip. A range without a unit is refused
  (`range_no_speech`) before the LLM is asked. The other `limit - n` slots are filled as without
  ranges from proposals asked for `limit`; a candidate sharing more than 0.5 s with a range, or a
  unit with its clip, is never chosen. Ranges that take every slot create no LLM client (stage
  `selecting`, "Menyiapkan klip dari rentang waktu").
- **Outputs.** `SelectedClip.manual` (artifact key `"manual": true` only when set; the reader
  refuses any other value), manifest clip `"manual": true`, stage summary `moments.ranges` (how
  many clips came from ranges). A refused range's failed manifest adds `error_code` beside the
  Indonesian `error`; the worker stores `errorCode` and that line as `stageDetail` for
  `RANGE_FAILURE_CODES` only.
- **Web.** `sanitizeV3ClipFields` keeps `manual` only when exactly `true`.
  `stageSummaryRows`: "2 dari rentang waktu · 3 dipilih AI". `clipRangeChip(clip)` → "Rentang
  waktu kamu" (project page tag). `selectionNotices` drops "Dibuat tanpa AI" when every clip is
  typed.
- **Dashboard.** Momen section, "Rentang waktu (opsional)" textarea (`#time-ranges`) above the
  focus field; `jobFormProblems({…, timeRanges})` checks it with the API's rules (the count only
  when Jumlah klip is a count) and focuses it as the first problem inside the folded options; the
  summary line adds "n rentang waktu". The text is never stored in the browser.

## 5.38 Clip title and description: Ubah and Tulis ulang (2026-10-21)

Plan `docs/plans/2026-10-20-lanjutan-sesi.md` P2 ("Judul dan deskripsi klip bisa diedit, dengan
tombol Tulis ulang"). No engine render, flag or schema change: the clip video, its hook text and
the editor document are untouched.

### Stored edit and what serves it (`web/lib/jobs.mjs`)

- `job.json` `clips[i].textEdit = {title, description, editedAt}` beside the engine's packaging,
  which stays as it was. Only `PATCH /clip-text` writes it.
- `clipTextEdit(value)` → `{title, description, hashtags}` or null: `title` through
  `sanitizeLine(…, 100)` and required (an edit without a usable title is ignored), `description`
  through `sanitizeMultiline(…, 1200)` (may be empty), `hashtags` = the `#tag`s written in the
  description through `sanitizeHashtags` (≤ 10, first spelling kept).
- `serializePublicJob` applies `withClipTextEdit` last (after `enrichJobSocialMetadata`), so the
  edit wins for packaged and older clips alike and `textEdit` itself is never served. Every
  consumer follows: `clipDownloads` names (`NN-judul`), "Salin judul"/"Salin caption",
  `zipEntryNames` (`web/lib/clips-zip.mjs`, now exported), `libraryItems` (Riwayat, search), and
  `GET /api/jobs/:id/clips`, which overlays `title`, `description` and `hashtags` by clip number
  from `job.json` (the editor's export dialog copies them).
- `clipCaptionText` copies the title alone when the description is empty.

### `PATCH /api/jobs/:id/clip-text` (`web/lib/clip-text-api.mjs`)

- `secureRoute(…, {params: ["id"], limit: "api"})`: session, same origin, lower-case UUID,
  nosniff, CORP, no-store. Runs behind `web/proxy.js` (a small JSON body).
- Body: JSON, ≤ 32 KiB, exactly `{index, title, description}`; `index` 1–9999, both texts
  strings. Over-long text is refused, not cut (the form counts the same code points).
- Written by `updateCompletedJob({jobsRoot, id}, change)` (`web/lib/primary-job-queue.mjs`): the
  queue lock, a no-follow read, the job's identity checked, only `status: "completed"`, then
  `durableWriteJson`. `updatedAt` is left alone (editing text is not a run of the job).
- `200 {clip}`: the clip as `serializePublicJob` serves it. Errors `{error, code}`:
  `invalid_request` 400, `title_empty` 400 ("Judul tidak boleh kosong."), `title_too_long` 400,
  `description_too_long` 400 ("Deskripsi paling banyak 1.200 karakter."), `unsupported_media_type`
  415, `payload_too_large` 413, `not_found` 404, `clip_not_found` 404, `not_ready` 409 (not
  completed), `save_failed` 500.

### `POST /api/jobs/:id/clip-text/rewrite`

- Same guard; body JSON ≤ 256 B, exactly `{index}`. No field can name a provider, model or URL.
- Before any spawn: the job is read (`not_found` 404, `read_failed` 503), must be completed
  (`not_ready` 409), have the clip (`clip_not_found` 404) and its transcript (`no_transcript`
  409). The LLM plan: `POTONGIN_LLM` off, saved settings off or without a provider → `llm_disabled`
  409; unreadable settings → `llm_settings` 409. Then at most 3 running in the process (`429
  rate_limited`, retry 5 s) and 30 per job per hour (`EDITOR_RATE_LIMITS.ai`, its own bucket; `429`
  with `Retry-After` and the minutes in the message).
- `runPythonCli("ai_clipper.post_text", "rewrite", {jobId, index})` with `withLlmEnv` (the loaded
  settings, plus `POTONGIN_LLM_EDITOR_MODELS` when set), a 25 s kill and no grace. The module is in
  `PYTHON_CLI_MODULES`.
- `200 {suggestion: {title, description}}`, re-cleaned with the PATCH limits (otherwise
  `invalid_output` 502). A failed state answers `{error, code, llmCode}`: `timeout` 504,
  `invalid_output` 502, `llm_unavailable` 502 (also any unknown code), `llm_disabled` 409,
  `no_transcript` 409; `llmCode` is the LLM error code (`^[a-z][a-z0-9_]{0,39}$`) or null. CLI exit
  4 → `clip_not_found` 404; a killed child → `timeout` 504; anything else `backend_unavailable`
  503. A suggestion is never written anywhere.

### `python -m ai_clipper.post_text` (`src/ai_clipper/post_text.py`)

- stdin `{"op": "rewrite", "jobId", "index"}` (strict JSON: no float, no doubled key, no other
  member); exit 2 for anything else, 4 when the job is not a completed job with that clip (no
  symlinked job directory, `job.json` ≤ 2 MiB), 0 with `{state: "done", suggestion, error: null}`
  or `{state: "failed", suggestion: null, error: {code, llmCode}}` (`code` in `ERRORS`).
- The prompt `prompts/post_text_v1.md` (`post-text-v1`) restates the packaging rules of the
  editorial standard; the user message is the current title, the current description without
  hashtags (the owner's edit when there is one) and the clip's `text`, marked as data.
- One `complete_json` (600 tokens, temperature 0.8) on `editor_ai.editor_chain(env)`, the editor's
  chain without the response cache (asking again gives another variant), inside a 20 s deadline.
- The answer: `title` 1–100 characters, no URL, @account, hashtag or emoji, no
  `packaging_problem` (disfluent, cut quote, verbatim copy) and grounded (`grounding_problem`),
  not the current title; `description` 1–600 characters, no URL, @account or emoji, grounded;
  hashtags written in it move out (closing ones join the list, inline ones lose the `#`); the
  hashtags go through the engine's rule (`_clean_hashtags`: lower case, 2–38, ≤ 6) and close the
  description on their own line.

### Project page (`web/components/ClipText.jsx`, `web/lib/clip-text.mjs`)

- In the detail panel's caption box, for a completed project: "Salin caption", **Ubah** (accessible
  name "Ubah judul dan deskripsi") and **Tulis ulang**.
- **Ubah**: Judul (input) and Deskripsi (textarea, the whole description with its hashtag line),
  each with a counter ("29/100", "1.201/1.200" in red past the limit), its problem under it
  (`aria-invalid`, `aria-describedby`), a hint for hashtags; **Simpan** (sends only a real change),
  **Batal**, **Tulis ulang**. The focus goes to Judul on open and back to Ubah after Simpan or
  Batal; "Judul dan deskripsi tersimpan." in the status line. A save is not aborted when another
  clip is shown; the page replaces the clip with the saved one (`replaceClip`).
- **Tulis ulang**: "Menulis…" with the status line, then a "Saran AI" region with the title and
  description, **Pakai** (fills the form, nothing saved) and **Buang** (focus back to Tulis ulang).
  A failure is a warning notice "Tulis ulang gagal" with the route's message, "Cara memperbaiki"
  (`helpHref(llmCode)`; timeout and AI off have their own entries) and "Buka Pengaturan" for
  `llm_disabled`, `llm_settings` and `llm_unavailable`.
- An open draft or suggestion waits in a per-page map while another clip is shown; a running
  rewrite is aborted then.
- The hook text is part of the rendered clip; it is shown or hidden by the "Hook di video" switch
  in the same box (§5.57) and edited through the editor's Hook card, each followed by an export.

## 5.39 Caption entrance: "Animasi masuk" (2026-10-21)

Plan `docs/plans/2026-10-20-lanjutan-sesi.md` P2 ("Animasi masuk caption"). Every existing
document, seed, plan sha, golden and auto render is unchanged: the seeds carry no `entrance`, and
a document with `entrance` `none` compiles to the same cues and ASS bytes as one without the key
(`tests/test_edit_v2_captions.py`, `tests/test_captions_ass.py`).

### Document

- Optional `captions.overrides.entrance`, one of `CAPTION_ENTRANCES` = `none`, `fade`, `pop`,
  `blur` (`edit_v2/__init__.py`, `web/lib/editor/doc-model.mjs`). Another string or a
  non-string is `range_invalid` at `/captions/overrides/entrance`; `schema_minor` stays 0 (§3.8
  amendment).

### Engine (`captions_ass.build_ass_v2`, ASS only)

- `_check_overrides` refuses any other value. For each caption line (a cue after `fit_cues`),
  every event of its first window (the events whose first frame is the line's `f0`: the line,
  the vector box, Bold's first active-word event, Sorot's words and box) starts with one more
  override block. Later windows are unchanged, so the line has settled by the time the next word
  lights. No event's style, start or end moves; a fading entrance of Classic or Karaoke adds
  the drop shadow's copy and moves the line to layer 1 ("Outline drawn as a shadow" below).
- `d = min(ENTRANCE_MS, 10·(end_cs − start_cs))` of that window, `ENTRANCE_MS` = 120:
  - Fade: `{\fad(d,0)<X>}`.
  - Pop (amended 2026-10-22, P-TXT): 70 % to 108 % over `t = rhu(2·d, 3)` ms, then back to
    100 % at `d`, in steps. The scale at `u` ms in 32nds is `n(u) = rhu(32·(70·t + 38·u), 100·t)`
    before `t` and `rhu(32·(108·(d − t) − 8·(u − t)), 100·(d − t))` from `t` on; the block is
    `{\fscxS\fscyS` with `S = 100·n(0)/32` (68.75), then `\t(u,u,\fscxS\fscyS)` at every
    `u` = 10, 20, … below `d` and at `d` where `n` changes (109.375 at the peak of a 120 ms
    entrance, 100 at `d`), and `}`; `S` is written exactly (at most three decimals). A
    continuous `\t` scale placed glyphs apart in JASSUB and FFmpeg now and then (82 % or 89.5 %
    moved an outline edge by up to 0.15 px, P-TXT 18 levels on Bold and Sinar); every 32nd from
    68.75 % to 109.375 % agreed on every Pop clip. libass scales each event around its anchor:
    the bottom centre of a line, Sorot's words and box around their own `\pos`.
  - Blur: `{\fad(d,0)\blurB\t(0,d,\blur0)<X>}` with `B` = H/128 pixels to two decimals (10 at
    1280, 15 at 1920). libass blurs only the outline of outlined text, so the line also fades in;
    boxes (`BorderStyle 3`, `\p`) and text without a border blur whole.
  - `<X>` is empty for Box and the tags of "Outline drawn as a shadow" below for the other
    packs.
- *Outline drawn as a shadow (amended 2026-10-21, P-TXT).* Under a translucent or fading fill
  libass cuts the glyphs out of the border (`ass_fix_outline`: `o > g ? o − g/2 : 0`). The
  step turns a one-level difference in glyph coverage between JASSUB's libass and FFmpeg's
  (their FreeType and HarfBuzz differ) into half the outline: up to 43 levels in the CI P-TXT
  of the fading entrances. A shadow of the border's shape is never cut, so a Fade or Blur
  entrance of a pack with a plain outline (BorderStyle 1, outline > 0, not a vector box: every
  pack but Box) ends its block with `\3a&HFF&\4c<outline>\4a&H<outline alpha>&\shad0.02`
  (the border transparent, the outline as the smallest nonzero shadow offset, 1/64 px). A pack
  with a drop shadow (Classic, Karaoke) draws that shadow from a copy of the event placed just
  before it, whose block ends with `\3a&HFF&\1a&HFE&\2a&HFE&` (fill all but transparent, so
  libass keeps the shadow uncut; border transparent), on layer 0; the event itself then moves
  to layer 1, because libass stacks overlapping events of one layer apart. Once the fade ends
  the picture is the same as before, byte for byte in the CI references; while the line fades,
  its fill shows over its outline instead of over a hole cut in it (up to 64 levels darker in
  the first frames). Pop has no fade and keeps its outline.
- The hook (its own `\fad(150,250)`) and the legacy `build_ass` are untouched.

### Editor

- Command `SetCaptionOverride {key: "entrance", value}` (merge key `cap:entrance`; a value
  outside the four is `value_out_of_range`). `none` removes the key (a manual revert equals the
  seed, R10); `SetCaptionPack` keeps it. `checkDoc` accepts an optional valid `entrance`;
  `captionEntrance(doc)` reads an absent or unknown value as `none`.
- Two tabs: part `captions.override.entrance` (after `words_max`) in the "Gaya caption" group;
  its value is `null` while absent and setting `null` removes the key. Word parts still come
  after every caption part (`rebase.mjs`).
- UI: a `PillGroup` "Animasi masuk" (Tanpa, Fade, Pop, Blur; four columns) after "Kata per
  baris" in the Caption card and the Teks panel (`CAPTION_ENTRANCE_OPTIONS`,
  `captionEntranceId`, `captionEntranceCommand` in `caption-model.mjs`). The preview plays the
  entrance from the plan's ASS, the bytes FFmpeg burns.

### Gates

- ASS goldens `entrance_fade__c30` (Karaoke), `entrance_pop__c30` (Bold) and
  `entrance_blur__c30` (Sorot) from `valid/entrance_<id>__c30.json`; also
  `valid/entrance_none__c30.json` and `invalid/range_invalid__entrance_{value,not_string}.json`.
  The golden evidence probes a line that fades in at its middle frame.
- P-TXT: the gated clips `<pack>-<entrance>-40` (3 entrances × 5 packs,
  `reference_text.ENTRANCES`), probed on frames 1–3 of the first line and 1–2 of the second
  (`ENTRANCE_PROBES`), all inside the 120 ms, so JASSUB and FFmpeg are compared while the line
  is still opening. The smoke subset adds `karaoke-fade-40`, `bold-pop-40` and
  `sorot-blur-40`. The player fixtures add the variants `entrance-fade` (Karaoke),
  `entrance-pop` (Bold) and `entrance-blur` (Sorot), whose first probes are frames 1–2 of the
  first two lines.
- P-TIME is unchanged: no event edge moves (the Start and End fields are checked byte for byte
  against the document without the key).
- The 1,000-sequence crosscheck draws `entrance` values, valid and not.

## 5.40 Face-track's latar blur fallback (2026-10-21)

Where face-track (`camera`) finds no face, the clip can show the whole 16:9 picture over its own
blurred copy (the `fit_blur` layout) instead of a centred 9:16 crop. The value was reserved in
`doc.py` (`_NO_FACE`); this section enables it. Nothing that renders today changes: documents
with `no_face: "center"` keep their graph, plan sha and plate key, so `RENDER_SEMANTICS` stays 1
and no golden moves.

### The document (§3.3)

`layout.default.no_face` ∈ {`center`, `fit_blur`} (`layouts.NO_FACE_MODES`); `fail` stays
`op_disabled`; another string is `range_invalid`. Valid with every layout under `schema_minor: 0`
(§3.8, like the 2026-10-02 amendment); only `camera` renders it.

### Where the fallback is decided

- **Editor, `SetLayout`** (`web/lib/editor/doc-model.mjs` `switchedLayout`): a switch into
  `camera` from another layout sets `no_face: "fit_blur"`; every other switch keeps `no_face`.
  Mode Cepat's Tata letak card and the Mode Lengkap panel both send `SetLayout`, and the panel's
  thumbnails (`withLayout`) and `preview_cli` `prepare` (`_switched`) apply the same rule, so the
  plate a switch prepares is the plate it shows.
- **`SetNoFace {mode: "center"|"fit_blur"}`** (new command after `SetLayout`, `null` merge key,
  `value_out_of_range` otherwise): the one-click switch in the panel's "Bagian tanpa wajah"
  choice. It changes only `layout.default.no_face`; the two-tab merge treats it as part of the
  `layout` part (the dialog names `camera + latar blur`).
- **Seeds are unchanged** (`no_face: "center"`): an auto clip, either engine, renders exactly as
  before, and an unchanged face-track clip still exports the auto file (R10). Turning the
  fallback on for auto clips needs the legacy face-track render to do the same first (owner
  decision, not taken here).

### Frames and graph (`layouts.py`, `compile_ffmpeg.py`)

- A camera-plan span `[s_ms, e_ms)` covers the source-grid frames it touches, `[sf_floor(s),
  sf_ceil(e))` (integers: `k·1000·den < e·num` and `(k+1)·1000·den > s·num`;
  `layouts.no_face_frames`). Its first frame is the frame the plan's issue jumps to.
- `layout_chain("camera", …, crop, fallback)`: no flagged frame gives today's camera chain byte
  for byte; every frame flagged gives the `fit_blur` chain; otherwise fit-blur's chain with three
  switches indexed by the frame counter `n` (balanced `if(lt(n,K),A,B)` trees, as the crop): the
  background crop x is the camera's, or `centre_x` (`(scaled_w − W) // 2`, crop's default) on
  fallback frames; `gblur` carries `enable` on fallback frames; the foreground gets
  `lutyuv=a=0:enable=<the other frames>` after its `format=yuva444p`, so `overlay` leaves the
  camera crop untouched there. Each output frame is therefore exactly the camera frame or the
  `fit_blur` frame (`tests/test_edit_v2_compile.py`, real FFmpeg, `framemd5` of lossless
  renders).
- The flags follow the source frame like the crop table, so plate cells, the truth frame and
  the final render agree per frame.

### Plan, keys and the lane

- `RenderPlan.no_face`; the runs become `no_face_blur` at `/layout/default/no_face` (same output
  frames as `no_face`), a warning code (`errors.WARNING_CODES`, so render records accept it) that
  the editor shows as a note. `RenderPlan.to_json` is unchanged; the content sha carries the
  value.
- `plates.plate_key` adds `"no_face": "fit_blur"` to the identity for `camera` with the fallback
  only; every other key is the one before (pinned in `tests/test_edit_v2_plates.py`).
- `preview_cli`: the plan's `lane` and `prepare` name `noFace` (`"fit_blur"` or `null`); `cells`
  takes an optional `noFace: "fit_blur"` (absent: centred, as before; another value is a usage
  error). `web/lib/preview-lane.mjs` keeps it on the clip's plate and sends it with every cells
  batch of that plate; a lane result with another `noFace` is not trusted (503).
- The plan DTO keeps one warning per `(code, path, ref, f)`: every run without a face is listed
  (before, the runs after the first were dropped; the xfail that recorded it now passes).

### Client

- `shell-model.checksView`: `no_face_blur` is `severity: "info"` (a note under "Catatan", no tick
  before export, §5.24); `no_face` stays a check. Message "Tidak ada wajah terdeteksi di bagian
  ini; tampil dengan latar blur".
- `layout-model`: `NO_FACE_OPTIONS` ("Latar blur", "Dipusatkan"), `noFaceView(doc, plan)` →
  `{mode, runs, note}`, `noFaceCommand(mode)`, `noFaceList` reads both codes, `layoutNote` (the
  face-track note of a centred clip says "dipusatkan"). The panel shows the choice (`PillGroup`
  "Bagian tanpa wajah") above the list whenever face-track is chosen, so it keeps its place and
  focus while the plan is asked again; with latar blur the jump buttons take the info tone.

### Gates

`P-FRAME` gains `cfr_30_no_face_blur` (fallback frames read with the fit-blur geometry) and
`P-PLATE` gains `plate_camera_no_face_blur` (crop x checked on the other frames, SSIM on all):
`scripts/parity/frame_identity.py`. The pytest pixel test runs wherever FFmpeg is installed.

## 5.41 Pengaturan "Transkripsi": Groq opt-in (2026-10-21)

An opt-in switch (plan 2026-10-20 P2) that sends the audio of a V3 video without usable YouTube
captions to Groq's hosted Whisper; local Whisper stays the fallback. Operations:
`docs/operations/TRANSCRIPTION.md` "Transkripsi lewat Groq".

- **Store** (`web/lib/transcription-settings.mjs`): `<settings>/transcription.json` (0600 in a
  0700 directory, atomic) `{"schema": "potongin.transcription/1", "groq": bool, "apiKey"?:
  {ciphertext, iv, tag}, "updatedAt"}`. The key is sealed by `encryptApiKey` under the label
  `transcription:groq`. A file that does not validate is `problem: "corrupt"` (the switch reads
  off) and the next save overwrites it.
- **`GET /api/settings/transcription`** → `{enabled, key, ownKey, llmKey, secretConfigured,
  updatedAt, problem}`. `key` is the key a job would use: `llm` (the Groq entry of the LLM
  settings, or of the environment without a settings file, whose key goes to `api.groq.com`),
  `own` (this file), `unreadable` (a key that no longer opens) or `missing`. Never a key value.
- **`PUT /api/settings/transcription`** `{enabled, apiKey?: {action: keep|replace|clear,
  value?}}`, JSON of at most 8 KiB. Session (401), same origin (403); `invalid` 422 (the key's
  problem as the message, never the value), `secret_missing` and `settings_unavailable` 503. The
  answer is the new view. The route runs behind `web/proxy.js` and checks the session itself.
- **Worker** (`run-job.mjs` `engineEnvironment` → `transcriptionEngineEnv`): drops inherited
  `POTONGIN_TRANSCRIBE_GROQ*`; with the switch on sets `POTONGIN_TRANSCRIBE_GROQ=on` and, when a
  key resolves, `POTONGIN_TRANSCRIBE_GROQ_API_KEY`. Only the engine child gets them
  (`downloaderEnv` drops `*API_KEY`).
- **Engine** (`transcribe_groq.groq_from_env`, `pipeline._v3_transcript`): V3 only, after the
  captions step. Success: `selection_v3.transcript_source = "groq"` and the stage summary
  `transcript.source = "groq"`. Any failure: the summary warning `groq_fallback:<code>` (codes in
  `transcribe_groq.FALLBACK_REASONS`, plus `error`) and the local Whisper run, unchanged.
- **Project page** (`selection-v3-view.mjs`): every `groq_fallback` code is a note ("Groq tidak
  dipakai (…); transkrip dibuat dengan Whisper di server ini."); `no_key` and `auth` are notices
  with "Buka Pengaturan". The progress row reads "dari audio lewat Groq".

## 5.42 Face-track follows the speaker: YuNet and mouth motion (2026-10-21)

Evaluation and numbers: `docs/evaluation/SPEAKER_FRAMING.md`. The camera plan's schema, file name
and fields (§5.7) are unchanged; its samples now come from another detector, so a new seed gets
another camera plan (existing seeds keep theirs, content-addressed as before). Every FFmpeg
argument is unchanged.

- **Model.** `resources/models/face_detection_yunet_2023mar.onnx` (OpenCV Zoo commit
  `f12e12798e8314f7c074a6656816c048dcc95b7a`, MIT, `LICENSE-YuNet.txt`), listed with its sha256
  in `resources/models/models.json` (`potongin.models/1`). `face_model.model_path()` checks the
  sha256 before OpenCV reads the file and raises `RuntimeError` when the file is missing or
  different. No new Python dependency: `cv2.FaceDetectorYN` is in the pinned
  `opencv-python-headless` 4.14 (the `vision` extra); the image copies `resources/` as before.
- **`face_model`** (OpenCV and NumPy passed in or imported lazily): `YuNet(cv2, w, h).detect(bgr)`
  → `Detection(x, y, w, h, score, landmarks)` in source pixels, sorted by position; detection runs
  on the frame scaled to at most 640 px on the long side (score 0.6, NMS 0.3, top 50).
  `mouth_region`, `mouth_patch` (grey 40×28, clipped to the frame) and `mouth_motion` (the earlier
  patch matched inside the later one within 4 px, then the mean absolute difference over the
  patches' contrast).
- **`speaker_track`** (stdlib only): `Face(x, y, w, h, activity)`, `Sample(time, cut, faces)`,
  `Rules(window=3, margin=0.03, jump=0.22, link_iou=0.3, min_relative=0.5)`,
  `link_tracks(samples)` and `choose(samples, *, width, rules=RULES) → (centres, switches)`: faces
  lower than half the sample's tallest are ignored; one face is framed whatever it does; among
  several, the track with the highest mean activity over ±3 samples of the same shot, kept until
  another leads by 0.03; no activity anywhere → the largest face (equal areas: leftmost, then
  topmost). `switches[i]` is true when the framed track changes and the centre moves at least 0.22
  of the width (a lone face appearing that far away included).
- **`face_window`** **changed**: `scan_window(source, *, start, end, sample_interval=0.75,
  progress=None) → Scan(times, samples, width, height)` decodes the window once (one seek), takes
  the sample frames exactly as before (`int(seconds·fps + 0.5)`) with the same cut flags, runs
  YuNet on each and measures each face's mouth motion over the frames until the next sample, about
  15 a second (after a cut-like change the rest of the interval is not measured).
  `detect_window(source, *, start, end, sample_interval=0.75, progress=None, rules=RULES)` returns
  `(times, centres, cuts, w, h)` with `cuts[i] = scene cut or speaker switch`. The `workers`
  keyword and `DETECT_WORKERS_MAX` are gone (the scan is one thread; `one_opencv_thread` still
  holds OpenCV's pool at one thread). A source without a frame rate is sampled by seeking,
  without mouth motion (the largest face is framed).
- **`face_tracking.detect_face_track(source, *, start, end, sample_interval=0.75, smooth=True)`**
  **changed**: it returns `face_window.detect_window`'s track (smoothed unless `smooth=False`); the
  `sequential` keyword and `choose_prominent_face` are gone, and the legacy render's face-track
  goes through the same scan as the camera plan (one decode instead of a seek per sample).
  `camera.build_camera_plan` still passes `sequential=True` to another detector that accepts it.
- **Evaluation harness** `scripts/eval/speaker_framing.py` (`select`, `fetch`, `run`, `time`):
  the set `docs/evaluation/speaker-framing/set-val.json` lists film windows of AVA ActiveSpeaker
  v1.0 (annotations CC BY 4.0, sha256-pinned; the footage is downloaded into a cache, never
  committed). It keeps the Haar detector as a frozen baseline.

## 5.43 Text watermark: "Teks watermark" (2026-10-21)

Plan `docs/plans/2026-10-20-lanjutan-sesi.md` P2 ("Watermark teks satu baris"). One line of text
over the whole clip, drawn by the same ASS as the captions and the hook, so the preview (JASSUB)
and the export (FFmpeg) draw the same bytes. Every existing document, seed, plan sha, golden and
auto render is unchanged: without the key `build_ass_v2` writes the bytes it wrote before.

### Document

- Optional root key `watermark` `{text, pos, size_pm, opacity_pm}` (§3.3, §5.4, §5.5): `text`
  1–40 code points (`WATERMARK_TEXT_MAX`, the hook's text rules), `pos` one of
  `WATERMARK_POSITIONS` = `top_left`, `top_center`, `top_right`, `middle_left`, `middle_center`,
  `middle_right`, `bottom_left`, `bottom_center`, `bottom_right`, `size_pm` 500–2000
  (`WATERMARK_SIZE_RANGE`), `opacity_pm` 200–1000 (`WATERMARK_OPACITY_RANGE`). Another key inside
  is `unknown_key` at parse; `schema_minor` stays 0 (§3.8 amendment).

### Layout (`captions_ass.layout_watermark(spec, *, play_res)`)

- DejaVu Sans Bold (`WATERMARK_FONT_FILE`; family "DejaVu Sans", Bold), white with a black
  outline, BorderStyle 1. The outline is drawn as a shadow of the border's shape (see "Outline
  drawn as a shadow" in §5.39): under a translucent fill libass cuts the glyphs out of a border
  and the two renderers then disagree; a shadow is never cut.
- The zones of `UI_ZONE_720` scaled like `plan.ui_zone`: `top = rhu(93·H, 1280)`,
  `bottom = rhu(280·H, 1280)`, `right = rhu(93·W, 720)`; the left margin `L = rhu(40·W, 1000)`
  (the logo presets' 4 %).
- Size `S0 = max(1, rhu(H·size_pm, 40000))` (H/40 at 100 %: 32 px at 1280, 48 at 1920); outline
  `O(S) = rhu(100·S, 16)` centipixels, edge `E(S) = ⌈O/100⌉`.
- Column: `usable = W − 2·right − 2·E(S0)` in the centre, `W − right − L − 2·E(S0)` at the left
  and the right. With `units, hu = advance_units(text)` (the font's `hmtx`), a line wider than
  its column (`units·S0 > usable·hu`) takes `S = max(1, ⌊usable·hu / units⌋)`; then `O = O(S)`
  and `E = E(S)`.
- Anchor at the bottom of the line: `\an1` at `x = L + E`, `\an2` at `x = W/2`, `\an3` at
  `x = W − right − E`; `y = top + E + S` (top row), `rhu(H + S, 2)` (middle row) or
  `H − bottom − E` (bottom row). The line never reaches the TikTok zone, so no `unsafe_zone` is
  computed for it.
- Alpha `A = 255 − rhu(255·opacity_pm, 1000)` on the fill, the karaoke colour and the shadow;
  the border is transparent (`FF`).

### Events (`build_ass_v2(…, watermark=None)`)

- Style `Watermark,DejaVu Sans,S,&H<A>FFFFFF,&H<A>FFFFFF,&HFF000000,&H<A>000000,-1,0,0,0,100,100,0,0,1,<O>,0.02,<an>,0,0,0,1`,
  after the other styles.
- One event, the first of `[Events]`:
  `Dialogue: 0,0:00:00.00,<safe_cs(total)>,Watermark,,0,0,0,,{\an<n>\pos(x,y)\q2\blurE}<ass_escape(text)>`,
  `E = H/1280` px to two decimals (H the text height; amended 2026-10-22). libass blurs the
  border, so the outline (its shadow) is soft and the fill stays sharp: under 4:2:0 a hard
  outline around small white text over the video rings in chroma, and P-ENC measured the 16 px
  watermark at Tengah kiri at SSIM 0.9678 on its text (0.9866 with the blur). A larger minimum
  size did not help (0.9564 at 32 px), so the size range stays 500–2000.
  libass draws by layer, then in file order, so the captions (layer 0, later in the file) and the
  hook (layer 1) are drawn over it.
- `edit_v2.captions.caption_track` reads the key and adds `glyph_unsupported:U+XXXX` against
  DejaVu Sans Bold at `/watermark/text` (no `ref`, frame 0). The preview's font list
  (`preview_cli._font_entries`) adds DejaVu Sans Bold whenever the key is present.

### Editor

- Commands, after SnapLogo: `SetWatermarkText {text}` (trimmed NFC, 1–40 code points) adds the
  watermark at `DEFAULT_WATERMARK` (Tengah atas, 100 %, 85 %) or changes only its text (merge key
  `wm:text`); `SetWatermarkPosition {pos}`, `SetWatermarkSize {size_pm}` (`wm:size`),
  `SetWatermarkOpacity {opacity_pm}` (`wm:opacity`) and `RemoveWatermark {}` need one
  (`watermark_missing`, "Belum ada teks watermark."). `checkDoc` mirrors the validator (a wrong
  key set is `range_invalid` at `/watermark`). Removing it drops the key, so a clip without one
  equals its seed again (R10).
- Two tabs: the parts `watermark.on` (presence; its value is the whole object),
  `watermark.text`, `watermark.pos`, `watermark.size` and `watermark.opacity` after the logo's,
  each field with the prerequisite `watermark.on`, group "Teks watermark". The dialog describes a
  side as "@akun (Kiri bawah, ukuran 100%, opasitas 85%)" or "Tanpa teks watermark".
- UI: the section "Teks watermark" at the end of the Logo panel in both of its states
  (`panels/WatermarkSection.jsx`, `panels/watermark-model.mjs`): the text field (at most 40
  characters, a counter), then, once there is a text, the 3×3 place grid (radios named Kiri atas
  … Kanan bawah), Ukuran (50–200 %, steps of 5 %), Opasitas (20–100 %, steps of 1 %) and "Hapus
  teks". Typing is one undo step; an emptied field sends nothing and shows the stored text again
  when it loses focus. Characters the font lacks are named under the field. Mode Cepat has no
  watermark control: its Logo & Musik card leads to the Logo panel.

### Pengaturan "Teks watermark bawaan"

- Store (`web/lib/default-watermark.mjs`, server only): `<settings>/default-watermark.json`
  (0600, the settings folder 0700): `{"schema": "potongin.default-watermark/1", text, pos,
  size_pm, opacity_pm, updatedAtMs}`, written to a temporary file and renamed, one change at a
  time in the web process. A file that is not valid reads as none.
- `GET /api/settings/watermark` → `{watermark: {text, pos, size_pm, opacity_pm, updatedAtMs} |
  null, autoClips}`. `PUT` with `{text, pos, size_pm, opacity_pm}` (JSON, at most 4 KiB; the
  document's rules, the text trimmed in NFC; else `400 invalid_watermark` with `field`) answers
  the same; `DELETE` answers `watermark: null`. The small body goes through `web/proxy.js`; the
  handlers check the session again and the origin of a change (403). A settings folder that
  cannot be used is `503 settings_unavailable`.
- The job's copy: `POST /api/jobs` calls `snapshotDefaultWatermark(jobRoot)` after the logo's
  and writes `<job>/watermark.json` (O_EXCL, 0600) `{"schema": "potongin.job-watermark/1", text,
  pos, size_pm, opacity_pm}`. It never fails the job and never overwrites.
- Seeding: `edit_v2.seed.job_watermark(job_root)` accepts only a regular file of at most 4 KiB
  with that schema and a valid watermark (NFC, no control character), else none;
  `prepare_legacy_job` and `AutoRenderer` hand it to `build_seed` as the seed-context key
  `watermark`, which becomes the seed's `watermark`. The clip id does not change;
  `base.seed_sha256` does.
- R10: the legacy renderer draws no text watermark, so `doc.auto_file_is_seed` (and JS
  `autoFileIsSeed`) is false for a legacy seed with one, as for the default logo (§5.36).
- Card (`web/app/settings/DefaultWatermarkCard.jsx`, `web/lib/default-watermark-view.mjs`):
  loading, an error with "Coba lagi", the form (Teks with a counter, Posisi as a list of the nine
  places, Ukuran, Opasitas), Simpan (plain: the page's lime stays on its own save bar) and Hapus.
  The copy says only new clips get the text and, by `autoClips`, whether the automatic clip files
  carry it.

### Gates

- ASS goldens `watermark__c30` (the default), `watermark_max__c30` (40 characters,
  `bottom_right`, 200 % shrunk to its column, 20 %) and `watermark_min__c24` (1080×1920,
  `middle_left`, 50 %, 100 %) from `valid/watermark*`; the invalid fixtures
  `range_invalid__watermark_{text_empty,text_long,text_edge_space,pos,size_low,size_high,opacity_low,opacity_high,null}`,
  `unknown_key__watermark` and `not_nfc__watermark_text`.
- P-TXT: the gated clips `watermark-top_center`, `watermark-bottom_right` and
  `watermark-middle_left` (`reference_text.WATERMARK_CLIPS`: the watermark alone over the plate),
  the first two in the smoke subset; the player fixtures add the variant `watermark`
  (`middle_right`, 140 %).
- The 1,000-sequence crosscheck draws the five commands, valid and not.

## 5.44 Manual framing: "Atur bingkai" (2026-10-21)

Plan `docs/plans/2026-10-20-lanjutan-sesi.md` P2 ("Reframe manual"). The two crop layouts
(`camera`, `fill_center`) can be framed by hand with keyframes: the 9:16 crop is placed on the
source picture at chosen frames and either holds until the next keyframe or moves to it. Nothing
that renders today changes: a document without `layout.keyframes` keeps its graph, plan sha and
plate key, so `RENDER_SEMANTICS` stays 1 and no golden moves.

### The document (§3.3, §5.5)

- Optional `layout.keyframes`: 1–100 (`MAX_KEYFRAMES`) objects `{sf, pan_e5, move}`, with exactly
  those keys (another is `unknown_key` at parse level).
  - `sf`: a source-grid frame at the output rate, strictly increasing (else `range_invalid` at
    `/layout/keyframes/<i>/sf`), inside the window: `window_sf[0] ≤ sf < window_sf[1]` (else
    `outside_window`). A keyframe follows the source, so cuts and trims never move it; one
    inside a cut keeps framing the frames around it but has no place on the timeline.
  - `pan_e5`: 0–100000 (`PAN_E5_MAX`), the crop from the left edge (0) to the right edge
    (100000) of its travel; 50000 is the centre.
  - `move` (`KEYFRAME_MOVES`): `cut` holds the crop of the keyframe before until this one's
    frame ("Potong"); `slide` moves linearly from the keyframe before ("Geser"). The first
    keyframe's `move` is never read.
- An empty list is `range_invalid` (no keyframes is no key, R10). With `fit_blur` the list is
  `range_invalid` at `/layout/keyframes`. `schema_minor` stays 0 (§3.8 amendment).
- Constants in `edit_v2/__init__.py`; the client's in `web/lib/editor/doc-model.mjs`
  (`CROP_MODES`, `KEYFRAME_MOVES`, `MAX_KEYFRAMES`, `PAN_E5_MAX`).

### Frames (`layouts.py`)

- `pan_limit(source, output)`: the camera crop's travel, `scaled_w − W` floored to even (0 for a
  source that is 9:16 or taller: nothing to pan).
- `keyframe_positions(keyframes, *, source, output, first_sf, count)`: the even crop x of every
  source-grid frame. Keyframe `i` is at `pan_e5·limit/100000` on its frame; before the first the
  first holds, after the last the last holds; towards the next keyframe the crop holds (`cut`, or
  the same pan) or moves linearly in the frame index (`slide`). Exact rationals, rounded once to
  the nearest even integer (half up), as `crop_positions`. `pan_e5` 50000 is `centre_x` for a
  16:9 source (an odd centre, 4:3 at 720 wide, is one pixel off).
- `check_keyframes`: the rules above without the window (`ValueError`; `TypeError` for an item
  that is not an object).
- `tests/fixtures/edit_v2/framing-vectors.json` (`potongin.framing-vectors/1`): 29 inputs with
  their crop x (hand-picked and seeded random cases over 7 source/output sizes), written by
  `tests/test_edit_v2_framing.py` (`EDIT_V2_UPDATE_VECTORS=1`); `web/tests/editor-framing.test.mjs`
  checks `web/lib/editor/framing.mjs` against the same file.

### Compiler, plan and keys

- `compile_ffmpeg` (`layout`): with keyframes, either crop layout uses the camera chain (`crop`
  with an x expression of the frame counter `n`) with the keyframe x of the source frame each
  output frame shows, in every mode with a layout (final, reference, plate cells, frame). So a
  plate cell, the truth frame and the final crop any source frame at the same x. Face-track's
  camera plan is still required (as before) but neither its crop nor its no-face fallback is
  used.
- `RenderPlan.keyframes`; `build_plan` lists no `no_face`/`no_face_blur` issue while keyframes
  exist (the manual framing covers those runs). `RenderPlan.to_json` is unchanged; the content
  sha carries the keyframes.
- `plates.plate_key` adds `"keyframes": [[sf, pan_e5, move], …]` only when there are keyframes,
  and then never `no_face` (the fallback is off); every other key is the one before (pinned in
  `tests/test_edit_v2_plates.py`).
- `preview_cli`: `plan`'s `lane` and `prepare` name `keyframes` (the triples, or `null`) next to
  `noFace` (always `null` with keyframes); `cells` takes an optional `keyframes` (triples; a
  malformed list is a usage error, a frame outside the window `outside_window`, keyframes with
  `fit_blur` `range_invalid`, both exit 6). `prepare` with a switch to `fit_blur` reports the
  document without keyframes (`_switched`, as `SetLayout`). `web/lib/preview-lane.mjs` keeps the
  plate's keyframes and sends them with every cells batch of that plate; a plan or prepare
  result with malformed keyframes is not trusted (503).

### Commands and the two-tab merge (`web/lib/editor/commands.mjs`, `rebase.mjs`)

- `SetKeyframe {sf, pan_e5, move?}`: adds a keyframe at a source frame of the window (sorted), or
  moves the one at that frame (keeping its `move` unless given); a new keyframe is `cut`. Needs a
  crop layout (`framing_unavailable`, "Atur bingkai hanya untuk Ikuti wajah dan Potong
  tengah."); at most 100 (`too_many_keyframes`); `outside_window`, `value_out_of_range`,
  `invalid_args` as the other commands. Merge key `frame:<sf>`: a drag or the keys at one frame
  are one undo step.
- `RemoveKeyframe {sf}`, `SetKeyframeMove {sf, move}` (`keyframe_missing` when there is none at
  `sf`) and `ClearKeyframes {}` ("Kembali ke otomatis"; nothing to clear is no change). The last
  keyframe gone is no `keyframes` key (R10).
- `SetLayout` keeps the keyframes between `camera` and `fill_center` and drops them for
  `fit_blur` (`layoutAfterSwitch`; the layout thumbnails and `preview_cli` `_switched` do the
  same). `checkDoc` mirrors the validator's rules (an unknown key is `range_invalid` there); the
  cross-check generator sends the four commands.
- Two tabs: part `layout.keyframes` (value: the list or `null`) in the "Tata letak" group; the
  dialog names `<mode> + bingkai manual (<n> keyframe)`. "Pakai punyaku" for mine's keyframes
  over the other tab's latar blur brings mine's crop layout along.

### Editor

- `web/lib/editor/framing.mjs`: the JS mirror (integer math, BigInt products) plus
  `framingAvailability`, `keyframeMarks` (the output frame of each keyframe the clip shows) and
  `sourceFrameAt`.
- "Atur bingkai" (`FramingDialog.jsx` and its model `framing-model.mjs` in
  `web/components/editor/`, a shell dialog like the export), opened from the Tata letak panel
  (section "Bingkai") and Mode Cepat's Tata letak card under a crop layout (`openFraming` in the
  panel props bundle). The picture is the truth frame (`preview/frame`) of
  `sourceFrameDoc`: the document with `fit_blur`, no keyframes, captions off, no tracks or
  assets and the cold-open join as a plain cut, so the band in the middle is the whole source and
  nothing covers it; it is asked 150 ms after the playhead rests (its own preview client in the
  app). The gizmo (`gizmos/FrameGizmo.jsx`, `gizmos/frame-geometry.mjs`) draws the 9:16 box at
  `x / scaled_w` with a grid of thirds and dims the rest; a drag (magnet on the centre, Alt
  frees it; a press outside brings the box's middle there) is drawn locally and stored once, on
  release; ←/→ 1 %, Shift or PageUp/PageDown 10 %, Home/End store at once. "Hasil" is a CSS crop
  of the same picture at the box (`resultBackground`), shown for Potong tengah and for every
  frame once a keyframe exists; face-track without keyframes says "Mengikuti wajah" instead
  (its crop is the camera plan's, which the dialog does not draw). The scrubber marks each
  keyframe with a lime diamond; "Tambah keyframe", "Hapus keyframe", "Ke keyframe ini" (Potong /
  Geser, from the second keyframe on), "Kembali ke otomatis" and "Selesai". The dialog's
  playhead is the player's; Ctrl+Z / Ctrl+Shift+Z undo and redo inside it.
- Mode Lengkap's video lane draws a lime diamond at each keyframe; the Tata letak card's summary
  adds " · bingkai manual". With keyframes the panel hides face-track's "Bagian tanpa wajah"
  choice and says the manual framing covers those runs.

### Gates

P-FRAME gains `cfr_30_keyframes` and P-PLATE gains `plate_fill_center_keyframes` and
`plate_camera_keyframes` (face-track with its fallback on, which the keyframes turn off): crop x
of every plate, reference and final frame against `keyframe_positions`
(`scripts/parity/frame_identity.py`). `tests/test_edit_v2_compile.py` decodes the crop x of the
plate cells and the lossless reference of a framed synthetic clip with real FFmpeg (0 px).
Browser spec: `web/e2e/editor-framing.spec.mjs` on the editor fakes.

## 5.45 Layar terbagi: two stacked crops (2026-10-21)

Plan `docs/plans/2026-10-20-lanjutan-sesi.md` P2 ("Layout split 30/70 dan 50/50"). The reserved
layout mode `split` stacks two crops of the source in the 9:16 output with a 1 px black line
between them, for a facecam over gameplay or two speakers. Nothing that renders today changes:
every other document keeps its graph, plan sha and plate key, so `RENDER_SEMANTICS` stays 1 and no
golden moves.

### The document (§3.3, §5.5)

- `layout.default.mode: "split"` with `layout.split`, exactly `{top_pm, top, bottom}`:
  - `top_pm` (`SPLIT_TOP_PM`): 300, 500 or 700, the top band's share per mille of the `H − 1`
    rows beside the line (30/70, 50/50, and 30/70 swapped). Another value is `range_invalid` at
    `/layout/split/top_pm`.
  - `top`, `bottom` (`SPLIT_BANDS`): each band's crop, exactly `{x_e5, y_e5, zoom_pm}`. `x_e5` and
    `y_e5` (0–100000, `PAN_E5_MAX`) place the crop from the left or top edge (0) to the right or
    bottom edge (100000) of its travel; `zoom_pm` (1000–5000, `SPLIT_ZOOM_RANGE`) divides the
    largest box of the band's shape inside the source. Out of range is `range_invalid` at the
    field, a missing band at `/layout/split/<band>`, another key `unknown_key` at parse level.
- The split needs `layout.split` (`range_invalid` at `/layout/split` without it) and only the split
  has it (`range_invalid` at `/layout/split` under another mode). `layout.keyframes` with the
  split is `range_invalid` (manual framing belongs to the crop layouts). `no_face` is kept and
  unused. `schema_minor` stays 0 (§3.8 amendment). Seeds never write the split.
- Constants in `edit_v2/__init__.py`; the client's in `web/lib/editor/doc-model.mjs`
  (`SPLIT_TOP_PM`, `SPLIT_BANDS`, `SPLIT_ZOOM_RANGE`, `defaultSplit`).

### Geometry (`layouts.py`)

- `split_bands(output, top_pm)`: the top band has `round_half_up((H − 1)·top_pm/1000)` rows, the
  line is the next row, the bottom band the rest: 576 / line 576 / 1343 at 1080×1920 for 30/70,
  384 / 384 / 895 at 720×1280; 300 and 700 are mirror images, 500 gives 960 / 959.
- `split_crop(source, band, crop)` → `(x, y, w, h)` in source pixels: the largest box of the
  band's shape (the whole height of a source wider than the band, else the whole width) divided
  by `zoom_pm/1000`, each side rounded to even (half up); then `x = even(x_e5·travel_x/100000)`
  and the same for `y`, with the travel `source − side` floored to even. Every value is even, so
  the crop is exact on 4:2:0 sources; the crop's shape is the band's to within one pixel per side.
- `split_geometry(split, *, source, output)` → `{line, top: {y, size, crop}, bottom: {…}}`;
  `check_split`, `default_split()` (30/70, both crops `{50000, 50000, 1000}`), the lane form
  `split_lane` / `split_from_lane` (`[top_pm, [x_e5, y_e5, zoom_pm], [x_e5, y_e5, zoom_pm]]`).
- `tests/fixtures/edit_v2/split-vectors.json` (`potongin.split-vectors/1`): 32 inputs with their
  line, bands and crops (hand-picked and seeded random cases over 8 source/output sizes), written
  by `tests/test_edit_v2_split.py` (`EDIT_V2_UPDATE_VECTORS=1`); `web/tests/editor-split.test.mjs`
  checks `web/lib/editor/split.mjs` against the same file.

### Compiler, plan and keys

- `layouts.split_chain`: `split=2`, then per band `crop=w:h:x:y,scale=W:band_h:` with R3's
  explicit conversion to `yuv444p`; the top band is padded with one black row
  (`pad=W:band_h+1:0:0:black`), then `vstack=inputs=2,setsar=1`. No implicit conversion (pinned by
  `test_no_implicit_video_conversions`). The crops are the same on every frame, so plate cells,
  truth frames and the final agree per frame. The split needs no camera plan.
- `RenderPlan.split` (the document's bands, `None` under another layout). `RenderPlan.to_json`
  is unchanged; the content sha carries the bands.
- `plates.plate_key` adds `"split": split_lane(...)` for the split only; every other key is the
  one before (pinned in `tests/test_edit_v2_plates.py`).
- `preview_cli`: `plan`'s `lane` and `prepare` name `split` (the lane form, or `null`) next to
  `keyframes`; `cells` takes an optional `split` (a malformed one is a usage error; the split
  without it, or a split with another layout, `range_invalid`, exit 6). `prepare` with a switch
  into the split reports the default bands, or the document's own when it is a split already
  (`_switched`, as `SetLayout`). `web/lib/preview-lane.mjs` keeps the plate's split and sends it
  with every cells batch of that plate; a plan or prepare result with a malformed split, or a
  split without its layout, is not trusted (503).
- Render budget: `render_queue.RENDER_COST_PERMILLE` and `render_edit.PREDICTED_X` give the split
  fit-blur's cost until it is measured.

### Commands and the two-tab merge (`web/lib/editor/commands.mjs`, `rebase.mjs`)

- `SetLayout` into the split starts from `defaultSplit()` (or keeps the bands when already a
  split); any other layout drops `layout.split` (R10: a clip switched back equals its seed), and
  the keyframes stay with the crop layouts only (`layoutAfterSwitch`; the layout thumbnails and
  `preview_cli` `_switched` do the same).
- `SetSplitRatio {top_pm}` (300, 500, 700; `value_out_of_range`), `SwapSplit {}` ("Tukar": the
  crops change places and `top_pm` becomes `1000 − top_pm`, so the small band moves with its
  picture) and `SetSplitCrop {band, x_e5, y_e5, zoom_pm}` (merge key `split:<band>`: a drag, a
  zoom or the keys on one band are one undo step). All three need the split
  (`split_unavailable`, "Hanya untuk tata letak Layar terbagi."); the same values are no change.
  `checkDoc` mirrors the validator; the cross-check generator sends the three commands and
  switches to the split before them.
- Two tabs: part `layout.split` (value: the bands or `null`) in the "Tata letak" group; the dialog
  names `split 30/70`. Mine's bands over another layout bring mine's split layout along, and
  mine's layout brings mine's bands (or their absence).

### Editor

- `web/lib/editor/split.mjs`: the JS mirror plus `splitOf`, `splitRatio` and `swappedSplit`.
- Tata letak panel: a fourth card "Layar terbagi" (its thumbnail is the truth frame with the
  default bands, or the document's own). Under the split, the section **Layar terbagi** takes
  Bingkai's place: "Atas 30%, bawah 70%.", **Pembagian** (30/70, 50/50; 30/70 keeps a swapped
  order), **Atur potongan** and **Tukar atas dan bawah**. Mode Cepat's Tata letak card shows the
  same (its four pills in two columns); its summary is "Layar terbagi · 30/70" (top share first).
- "Atur layar terbagi" (`SplitDialog.jsx`, model `split-model.mjs`, a shell dialog like Atur
  bingkai, `openSplit` in the panel props bundle): the source picture of FramingDialog's
  `useStill` (the latar blur truth frame, nothing over it) with one box per band
  (`gizmos/SplitGizmo.jsx`, `gizmos/split-geometry.mjs`), drawn from the render's crops. A drag
  moves a box, a corner resizes it around the opposite one (the box keeps its band's shape; the
  zoom lands on 10 per mille steps), arrows move it 1 % of its travel (Shift 10 %), + and −
  zoom it 10 %; **Potongan** (Atas, Bawah) picks the band being edited, drawn in lime and on top;
  **Perbesar** zooms it. A drag and the slider are drawn from a draft and stored once, on release;
  a key stores at once. **Hasil** draws both bands and the line as CSS crops of the still
  (`bandBackground`). A scrubber picks the frame (the player's playhead); **Tukar atas dan
  bawah** and **Pembagian** are there too; Ctrl+Z / Ctrl+Shift+Z work inside; **Selesai** and
  Escape close and give focus back.

### Gates

P-FRAME gains `cfr_30_split` (the frame index read through the top band, whose crop starts at the
source's first row) and P-PLATE gains `plate_split` and `plate_split_swapped` (each band's column
ruler against `split_geometry` in the plate, the reference and the final, ≤ 3 % of the columns off
by more than 1.5 px; the line row of the lossless reference black): `scripts/parity/frame_identity.py`.
The player fixtures read the split's index through the same band and expect no single crop x
(`scripts/parity/player_fixtures.py`; they now also expect the manual framing keyframes' crop x).
`tests/test_edit_v2_compile.py` reads both bands' rulers, the top band's frame index and the line
row from the plate cells and the lossless reference of a split synthetic clip with real FFmpeg.
Browser spec: `web/e2e/editor-split.spec.mjs` on the editor fakes.

## 5.46 A clip that fails to render (2026-10-21, waits for the owner)

Plan `docs/plans/2026-10-20-lanjutan-sesi.md` P1 #4. It reverses the deliberate fail-closed
render of the automatic clips, so it ships only when the owner accepts it (draft PR). No flag,
no data migration; jobs made before it are unchanged.

### Engine (`src/ai_clipper/pipeline.py`)

- `_render_v3_clips(..., isolate: bool = False)`. `run_pipeline` (V3) passes `True`;
  `render_v3_job` (P-LOOK, PF-PIPELINE, fixtures) keeps `False` and still raises the first
  failure. V1 and the V2 shadow are unchanged.
- With `isolate`, an exception from `render_vertical` (the legacy engine, also as the fallback of
  `edit-v2`) is caught per clip. `render_vertical` publishes nothing when it fails, so no file of
  that clip exists. The clip's manifest entry is `_v3_manifest_clip(...)` with `output`,
  `subtitles` and `thumbnail` null, plus `"status": "failed"` and `"error_code"`:
  `render_timeout` when a `subprocess.TimeoutExpired` or `TimeoutError` is anywhere in the
  error's `__cause__`/`__context__` chain, else `render_failed` (`CLIP_RENDER_TIMEOUT`,
  `CLIP_RENDER_FAILED`). No engine fields (`clip_id`, `render_engine`, ...), no poster, no
  `cold_open_join`. Rendered clips keep their exact shape: no `status` key.
- The summary warning `clip_failed:<index>` (after that clip's `engine_fallback:<index>`), and
  one stderr line `potongin: clip_failed:<index>: <ExceptionType> <code>` (never the error's text).
- At least one clip rendered: the manifest is `completed` with every entry, failed ones
  included, in rank order. No clip rendered: the first clip's exception is raised after every
  clip was tried, so the manifest is `failed` with that error and `pipeline_failed:rendering`
  first, as before.
- Readers of `output/manifest.json` need no change: `render_edit.auto_file` and
  `render_queue._auto_file` find no file for a failed entry, `seed.manifest_joins` skips an
  entry without `cold_open_join`, the editor listing (`edit_v2.api` `clips`) reads the
  selection, not the manifest.

### Web

- `web/lib/clip-status.mjs` (client-safe): `CLIP_ERROR_CODES` (`render_failed`,
  `render_timeout`), `clipErrorCode(value)` (unknown → `render_failed`), `isFailedClip(clip)`
  (`status === "failed"` only), `readyClips`, `clipCounts` → `{total, ready, failed}`,
  `clipCountText` ("5 klip", "4 klip · 1 gagal"), `failedClipView(clip)` → `{label: "Gagal",
  text, hint}` or null.
- Worker (`web/scripts/run-job.mjs`): a manifest entry with `status: "failed"` becomes
  `{index, score, start, end, duration, text, status: "failed", errorCode, ...packaging}` with
  no `videoUrl`, `downloadUrl`, `subtitleUrl`, `thumbnailUrl`, `clipId` or `renderEngine`,
  whatever the entry names. A completed manifest without a ready clip fails the job ("Semua klip
  gagal dirender"). `completedStageDetail(clips)`: "Semua klip siap digunakan", or "n dari m klip
  siap; k gagal dirender".
- Job API (`sanitizeStoredClip`): a failed clip keeps `status: "failed"` and a known
  `errorCode` and loses every file link; any other clip loses a stray `status` or `errorCode`.
- ZIP route: every clip means every ready clip; `?clips=` naming a failed clip answers 409
  `clip_failed` ("Klip 02 gagal dirender, jadi tidak bisa diunduh."); a job without a ready clip
  answers `no_clips`.
- Project page: the heading "n dari m klip siap diunggah" (`clipsHeading`), the header
  "n klip · k gagal"; a failed poster shows "Gagal" (`chip error`, the shared poster's `badge`
  in place of its frame, `components/ClipPoster.jsx`), `data-failed`, "gagal dirender" in its
  description, and in "Pilih" `aria-disabled` instead of `aria-pressed` (`pickAll`/`prunePicks`
  skip it). Its detail panel has a frame of the video's size with "Gagal", the reason and one
  suggestion in place of the player; no "Edit klip", latest export, "Unduh MP4" or "Subtitle
  SRT", and the caption box has no "Ubah" or "Tulis ulang" (§5.38): there is no video to post.
- Riwayat "Klip" (§5.32): `libraryItems` leaves a failed clip out of `GET /api/clips`, so it is
  not in the grid, the search, "Skor 8+" or the total; its project row still says "n klip · k
  gagal".
- Dashboard: a failed clip's card shows "Gagal" and the reason in a short frame in place of the
  video, then its title and the suggestion; no download or copy. History rows and the summary
  count ready clips; "Edit klip" in the history needs a ready clip.

## 5.47 Caption on the stage: drag to move (2026-10-21)

The caption block can be dragged up or down on the 9:16 stage, as well as set by the Teks slider
and the Caption card's Posisi pills. It writes the one field those already write,
`captions.overrides.y_e5` (§3.3, the block's bottom, 20000–92000), through the same command, so
the document, the schema, the engine and the render do not change. There is no X axis. The drag
stays inside that range, the frame's safe range for the caption; the TikTok bottom band is drawn
as a warning while dragging, not a wall, because Bawah (83000, the automatic clips' spot) lies in
it.

### Geometry (`web/components/editor/gizmos/caption-geometry.mjs`)

- The bottom is the ASS one: `H − rhu((100000 − y_e5)·H, 100000)` (`captions_ass._margin_v`).
- The box above it is where to grab the caption, not a measure of its text: the pack's font size
  (`rhu(H·12·scale_pm·size_pm, 288·10⁶)`), its font's line height (DejaVu Sans 1.164 em,
  Montserrat 1.219 em) times the lines of a cue (one for the packs with `max_width_pm`, Box and
  Sorot; two for the others), plus the pack's outline; sides at `margin_side_pm` (60). The node
  test reads every pack file, so a pack change that the table misses fails there. An unknown pack
  is drawn like Klasik.
- The TikTok zone check is the server's caption rule (`plan.unsafe_zone_issues`):
  `y_e5·H > (H − zone bottom)·100000`.
- `CAPTION_Y_RANGE` (`web/lib/editor/doc-model.mjs`, used by `checkDoc`) and `CAPTION_Y_STEP` (500,
  `panels/caption-model.mjs`) are the Teks slider's `min`, `max` and `step`, and the gizmo's.

### Drag and keys (`gizmos/CaptionGizmo.jsx`, registered before the logo in `gizmos/index.mjs`)

- A press on the box captures the pointer; under 3 screen px of movement it is a click (focus
  only). A drag moves the bottom by the pointer's vertical travel; within 8 screen px of Atas
  38000, Tengah 60000 or Bawah 83000 it rests on that preset (Alt drags without the magnet), else
  on the 500 grid, always inside the range.
- The drag is drawn by the gizmo (box, preset guides, the zone's bottom band, a read-out such as
  "60% dari atas · Tengah") and stored once, on release: one `SetCaptionOverride {key: "y_e5"}`
  with merge key `null`, so a drag is one undo step however long it lasts and never merges into a
  slider or key step. A drag that ends where it began stores nothing; Escape during a drag puts
  the box back and stores nothing; `pointercancel` drops it.
- Keys on the focused box: ↑/↓ 500, Shift+↑/↓ and PageUp/PageDown 5000, Home 20000, End 92000;
  an off-grid value steps onto the grid. Each key stores at once with `cap:y_e5`, the slider's
  merge key. ←/→ do nothing (the box is a `role="slider"`, so the shell leaves the arrows to it).
  Escape leaves the box.
- `role="slider"`, `aria-orientation="vertical"`, name "Caption di video", `aria-valuemin` 20,
  `aria-valuemax` 92, `aria-valuenow` the percent, `aria-valuetext` "83% dari atas, Bawah". The
  hit area is at least 44 px tall. At rest nothing is drawn over the video; the outline shows on
  hover, focus and while dragging. Read-only: shown with `aria-disabled`, nothing moves. With
  captions off the gizmo is not drawn.
- The logo gizmo comes after it in the registry, so a logo over the caption stays on top.

### Gates

`web/tests/editor-caption-gizmo.test.mjs` (geometry against the pack files and the ASS bottom,
snap, range, grid, keys, commands, undo steps through the real edit session); browser spec
`web/e2e/editor-caption-gizmo.spec.mjs` on the editor fakes.

## 5.48 Automatic clips on the edit-v2 engine, and the caption look at job creation (2026-10-21)

Owner decision (2026-10-21, by delegation): the automatic clips render with the editor's compiler.
The legacy engine stays as the rollback switch and as the per-clip fallback (`engine_fallback`).
No schema change: a seed only takes other values of keys it always had.

### Engine default

- `render_edit.engine_from_env(env)`: `"legacy"` only when `POTONGIN_RENDER_ENGINE`, stripped and
  lower-cased, is `legacy`; unset, empty or anything else is `"edit-v2"`. `web/lib/editor/flags.mjs`
  `readEditorFlags(env).renderEngine` reads it the same way.
- `compose.yaml` passes `${POTONGIN_RENDER_ENGINE:-edit-v2}` to `app`, `primary-worker` and
  `render-worker`; `.env.example` shows `# POTONGIN_RENDER_ENGINE=edit-v2` and the rollback line.
- Unchanged: a clip edit-v2 cannot render falls back to the legacy engine
  (`engine_fallback:<index>`, `render_engine: "legacy"`); with §5.46 a clip legacy cannot render
  either is failed on its own.
- Per-clip timeout: unchanged, `max(300 s, 3 × output seconds × k(layout))` (the pipeline's
  floor is the legacy FFmpeg timeout; it counts only the clip's own FFmpeg run, not the wait for a
  render slot). From T4.3 (`T4.3-PF-PIPELINE.json`): the edit-v2 encode of the centre-crop job
  used 297 CPU seconds for about 238 s of output (face-track 222 for about 219 s), so under the
  production quota (`--cpus 6`, 2 render slots, about 3 CPUs each) a clip encodes at about
  0.45 s of wall time per output second. A 190 s clip (180 s plus a cold open) then takes about
  85 s of its 300 s, so no timeout or queue budget is raised.

### Job options (`web/lib/jobs.mjs`)

- `CAPTION_STYLES` is every caption pack (`PACK_IDS`, also `edit_v2.PACK_IDS`);
  `LEGACY_CAPTION_STYLES` is `["karaoke", "classic"]`.
- Two optional V3 keys: `captionPosition` (`top` | `middle` | `bottom`) and `captionSize`
  (`small` | `medium` | `large`). `parseJobOptions` reads them from the form fields of the same
  name, stores each only when given (an empty field is not given) and refuses any other value
  ("Unsupported caption position" / "... size"). `validatePersistedJobOptions` keeps them when
  stored, refuses unknown values and refuses them on a non-V3 job. Jobs stored before them have
  neither and keep working: the pack's own spot and size.
- The runner (`web/scripts/run-job.mjs`) adds `--caption-position <id>` and `--caption-size <id>`
  to the V3 command only when the job has them. The CLI (`ai_clipper.cli`) takes
  `--caption-style <pack>`, `--caption-position` and `--caption-size` (argparse choices) and
  passes them to `run_pipeline(caption_position=, caption_size=)`; with a selection mode other
  than V3, a pack other than `classic`/`karaoke`, a spot or a size is a `ValueError` before any
  work.

### Seed (`edit_v2/seed.py`) and render

- `edit_v2.CAPTION_POSITIONS = {top: 38000, middle: 60000, bottom: 83000}` (`y_e5`, the bottom
  edge of the caption block) and `CAPTION_SIZES = {small: 850, medium: 1000, large: 1200}`
  (`size_pm`): the editor's Atas/Tengah/Bawah and Kecil/Sedang/Besar presets.
- `build_seed`: `captions.pack` is the job's `captionStyle` (`PACK_BY_CAPTION_STYLE` maps every
  pack id to itself); `captions.overrides` is the pack's defaults with `y_e5` and `size_pm` from
  `captionPosition`/`captionSize` (absent: `bottom`, `medium`, the pack defaults, so an older
  job's seed is byte-identical). An unknown value is a `SeedError`. The clip id does not depend
  on the look; the seed sha does. `render_edit.AutoOptions` carries `caption_position` and
  `caption_size` into the pipeline's seed, and `render_v3_job` reads them from `job.json`, so the
  automatic file is the revision 0 the editor opens.
- The legacy engine (rollback or fallback) draws a pack as `captions_ass.legacy_caption_style`:
  the pack itself when it is `classic`/`karaoke`, else `classic` for a pack whose words do not
  light up (`reveal: "static"`, Box) and `karaoke` for the others, always at the bottom in one
  size. `edit_v2.doc.auto_file_is_seed` and `doc-model.mjs` `autoFileIsSeed` therefore hand out a
  legacy clip's automatic file as the unchanged export only when its seed is Klasik or Karaoke at
  `y_e5` 83000 and `size_pm` 1000 (and without a logo or a text watermark, §5.36/§5.43); other
  seeds render.

### Dashboard

- `GET /api/jobs` adds `renderEngine` (`"edit-v2"` | `"legacy"`) beside `editor`
  (`jobListFlags(env)` in `web/lib/editor/flags.mjs`).
- `web/lib/dashboard-choices.mjs`: `CAPTION_STYLE_CHOICES` (every pack, the editor's names),
  `CAPTION_POSITION_CHOICES` (Atas, Tengah, Bawah) and `CAPTION_SIZE_CHOICES` (Kecil, Sedang,
  Besar); `lookChoices(engine)` gives all of them, or with `"legacy"` only Karaoke and Klasik and
  `null` for spot and size; `normalizeChoices(raw, {engine})` turns a look the engine does not
  draw into the default. `DEFAULT_CHOICES` gains `captionPosition: "bottom"` and
  `captionSize: "medium"` (kept per browser with the other choices). The summary names a spot or
  size only when it is not the pack's own ("subtitle atas", "subtitle besar").
- The page (`app/dashboard/page.jsx`) offers `lookChoices(renderEngine)` (edit-v2 until the jobs
  list answers) and sends `captionPosition`/`captionSize` only while they are offered. The groups
  "Posisi subtitle" and "Ukuran subtitle" are radio pills (48 px).
- The 9:16 preview (`lib/look-preview.mjs`, `LookPreview.jsx`) places the pack's thumbnail with
  its bottom edge at `y_e5` and scales it by `size_pm` about the middle of that edge; an SVG
  filter (`CAPTION_KEY`, two luminance rows of `feColorMatrix`) keys out the thumbnail's
  backdrop so a subtitle over the picture shows only the pack's ink. `data-position` and
  `data-size` name the choice. The zone note shows only for Bawah.
- Pengaturan's Logo bawaan and Teks watermark bawaan cards already say from `autoClips` whether
  they reach the automatic clip files; with the new default they say they do.

## 5.49 Karaoke sweep, the Sinar pack and RENDER_SEMANTICS 2 (2026-10-21)

The karaoke highlight sweeps each word from left to right instead of switching it on, and a sixth
pack, Sinar, draws that sweep with a soft glow. This changes golden pixels, so
`RENDER_SEMANTICS` is 2 (the one bump of this batch; the owner's look approval was given by
delegation). `schema_minor`, `COMPILER_ID`, `COMPILER_VERSION` and the plan schema are unchanged.

### The sweep (`captions_ass._karaoke_text`, `_karaoke_line`)

- Both karaoke writers (the legacy `build_ass` and `build_ass_v2`) write `{\kfN}` where they
  wrote `{\kN}`, with the same `N`: in `build_ass_v2` the differences of `safe_cs` (§3.4 time
  rule), so each word's sweep **starts** on its planned frame and is complete on the next word's
  onset (or the line's end). A keyword keeps `\1c`/`\2c` in the emphasis colour, so its sweep is
  not seen. There is no option to keep `\k` (latest only).
- `LEGACY_PIN` in `tests/test_captions_ass.py` still pins the legacy bytes with `\kf` read back
  as `\k`, so every duration is the old one.
- P-TIME (`support.edit_v2_text`): each sweep is checked on a copy of its line in which only that
  word changes colour (`isolate_sweep`): the same picture at `k − 2` and `k − 1`, a new one at
  `k + 1`, still moving between `k + 1` and `e − 1`, the same picture at `e` and `e + 1`
  (`sweep_early`, `sweep_start`, `sweep_moves`, `sweep_late`). The same line with `\k` fails
  `sweep_moves`.
- P-TXT probes stay clear of word onsets (`WORD_REVEAL_PACKS`); between them the sweep is at
  the same place in both renderers, which call libass with the same time.

### The Sinar pack (`resources/caption-packs/sinar/v1.json`)

- Montserrat ExtraBold at 1.1× (59 px at 720×1280), white, a thin black outline (H/320, 4 px),
  no shadow, `case` `asis`, 3 words per cue, one line (`max_width_pm` 880), reveal `karaoke`
  (style primary = `highlight`, secondary = text colour, as the Karaoke pack).
- Pack field `glow` `{outline {num 7, den 640}, blur {num 7, den 1280}, alpha 48}` (`Glow`):
  ratios of H in centipixels (14 px border and blur 7 at 720×1280; 21 and 10.5 at 1080×1920)
  and an ASS alpha 0–255. The blur was H·9/1280 until 2026-10-22: FFmpeg's 8-bit blend
  truncates where the browser rounds, and across the wider halo that ±1 noise held P-TXT SSIM
  at 0.9989 (sinar-90); H·7/1280 is the smallest change that brings every Sinar clip to
  ≥ 0.9992. Only on a one-line karaoke pack (`reveal` `karaoke`, `border_style`
  1, `max_width_pm` set); anything else is refused by `load_pack` and `build_ass_v2`.
- Events: per cue, two events on layer 0 with the cue's start and end, both placed with
  `\an2\pos(W/2, H − MarginV)\q2[\fsN]` (a single word wider than the line limit shrinks with
  `\fsN`, as Box and Sorot do), so libass never stacks them apart:
  1. the glow: `{<place>\bord<g>\blur<b>\3a&HFF&\4c<highlight>\4a&H30&\shad0.02\1a&HFE&\2a&HFE&}`
     and the line's words (escaped, case applied, no karaoke tags): the blurred border's shape
     drawn as a shadow (§5.39 "Outline drawn as a shadow"), never cut by the glyphs, under an
     all but transparent fill; the line drawn over it hides the glyphs' area, so the picture
     equals a border glow with transparent glyphs (amended 2026-10-21, P-TXT);
  2. the line: `{<place>}` and the Karaoke pack's `\kf` text for the same cue.
  An entrance (§5.39) opens both; the glow's own `\blur` comes after the entrance block, so the
  glow stays soft while a Blur entrance sharpens the line.
- The glow takes the `highlight` colour ("Warna sorot"); a keyword's sweep keeps the emphasis
  colour in the line, the glow stays one colour.
- Pack lists: `PACK_IDS` (Python and JS), `PACK_DEFAULT_CASE` (`asis`), `PACK_WORDS_PER_LINE`
  (3), `CAPTION_PACKS` ("Sinar", "Karaoke dengan cahaya lembut"), `HIGHLIGHT_PACKS`,
  `CAPTION_NOTES.highlightGlow` ("Kata yang sedang diucapkan dan cahayanya."; the note for the
  packs without a highlight reads "Dipakai oleh Karaoke, Bold, Sorot dan Sinar; tidak tampak di
  gaya ini."), `PACK_IMAGES`, the dashboard's `CAPTION_STYLE_CHOICES` ("Sinar", "Karaoke dengan cahaya
  lembut."; a job takes it with the edit-v2 engine, §5.48), the fakes' one-line packs, the
  transcript harness store.
- Fixtures and gates: document `valid/pack_sinar__c30.json`, ASS golden `sinar__c30`, P-TIME
  expects the glow event (no sweep) before each line, P-TXT `sinar-10/40/90` (smoke
  `sinar-40`), the player variant `sinar`, thumbnail `pack-thumbs/sinar.png`.

### RENDER_SEMANTICS 2

- New seeds write `base.engine.render_semantics` 2. A document keeps the stamp it was seeded
  with (the validator accepts any integer ≥ 1); the committed fixtures stay at 1
  (`edit_v2_fixtures.FIXTURE_RENDER_SEMANTICS`) and compile with today's engine.
- The plan body, `render_key`, `plate_key` and `preview_cli.audio_key` include the value, so
  every plan sha, render key, plate key and preview mix key moves once; caches rebuild on the
  next open or export. `tests/fixtures/edit_v2/plan-shas.json` is recomputed; the plate and mix
  keys of semantics 1 stay pinned next to those of 2 (`PLATE_KEYS`,
  `MIX_IDENTITY_SEMANTICS_2`), so nothing but the bump moved them.
## 5.50 Caption over the speaker's face (2026-10-21)

A caption that sits on the speaker's face is a check: the plan warns `caption_over_face` and the
editor moves the caption to the nearest of Atas, Tengah and Bawah that clears the face, in one
click. The document, the schema and the render do not change; warnings are not part of the plan
sha, so `RENDER_SEMANTICS` stays.

### The face boxes (camera plan, §5.7)

- `speaker_track.choose_faces` returns the framed face per sample (`choose` is its centres, so the
  crop is unchanged). `face_window.detect_window(..., boxes=True)` adds a sixth value, the framed
  face as `(x, y, w, h)` shares of the source frame or `None`.
- `camera.build_camera_plan` asks the window detector for boxes when it takes `boxes`, and takes a
  sixth value from any other detector, and writes `faces`: one entry per sample,
  `[x_pm, y_pm, w_pm, h_pm]` (`ms_from_seconds` rounding, clamped inside the frame) or `null`.
  The boxes are raw, not smoothed. A detector without boxes, and every plan built before, has no
  `faces` key: the schema stays `potongin.camera-plan/1` and those plans keep their bytes.
- Under face-track a new plan's sha changes (it carries `faces`), so its plate key and plan sha
  change with it; plans already on disk are read as they are.

### The check (`edit_v2/face_zone.py`, stdlib)

- `build_plan(..., faces=None)`: a camera plan read only for its `faces`. Without it the `camera`
  plan given is used. `plates.faces_for(clip, doc)` finds the plan face-track would use for the
  same window, rate, size and source (never builds one; `None` under face-track, whose own plan is
  passed as `camera`). `preview_cli`, `render_edit.load_render_inputs` and `render_queue` pass it,
  so the check also runs under Latar blur, Potong tengah and Layar terbagi once the clip's faces
  were analysed.
- The caption block is `caption_box`: the same integers as `captionBox` in
  `gizmos/caption-geometry.mjs` (§5.47), its metrics read from the pack file (font size ratio and
  scale, outline, the font's line height: DejaVu Sans 1.164 em, Montserrat 1.219 em, one line for
  packs with `max_width_pm`, else two).
- Each sample whose source frame (`sf_floor(t_ms)`) is kept by a piece and whose output frame shows
  a caption cue is counted. Its face is mapped into the output (`face_rects`): the scaled source
  minus the crop x for Potong tengah (`centre_x`), Ikuti wajah (`crop_positions`, or the fit-blur
  picture where the latar blur fallback shows the frame) and manual framing (`keyframe_positions`);
  the fitted picture for Latar blur; each band's crop for Layar terbagi (two rectangles when both
  bands show it). Rectangles are clipped to the picture or band.
- A sample is over the face when the overlap is at least 15 % (`OVERLAP_PM`) of the smaller of the
  face and the block. The clip is warned when at least 25 % (`SHARE_PM`) and at least 2
  (`MIN_SAMPLES`) of the counted samples are over the face.
- One issue: `{code: "caption_over_face", path: "/captions/overrides/y_e5", ref, f}`. `f` is the
  earliest output frame of those samples; `ref` is the fix, the id of the preset
  (`edit_v2.CAPTION_PRESETS`: `atas` 38000, `tengah` 60000, `bawah` 83000) nearest to the
  caption's `y_e5`, other than that value, under which the clip would not be warned (ties go up),
  or absent when none clears.
- `errors.WARNING_CODES`, `render_queue.V3_WARNING_CODES` (through it) and
  `web/lib/clip-renders.mjs` accept the code. Message: "Caption menutupi wajah pembicara".

### Client

- `caption-model.captionFaceFix(warning)` → `{id, label: "Pindah ke Tengah", command}` (the
  Posisi pills' `SetCaptionOverride {key: "y_e5"}`, merge key `null`: one undo step), or null for
  another code or an unknown or absent `ref`. `captionFaceNote(plan)` → `{text, fix}`: "Caption
  menutupi wajah pembicara." with the fix, or "… Geser caption atau kecilkan ukurannya." without.
- It is a check (severity `warning`, a tick before export), also at the auto clip's spot: unlike
  the TikTok-zone note (K5), a face under the caption is a problem in the clip itself.
- "Perlu dicek" shows the fix beside the jump (`onFix`, null when read-only); the Caption card
  (Mode Cepat, 44 px button, named in the Posisi pills' `aria-describedby`) and the Teks panel
  (Mode Lengkap) show the line and the button under the position controls.

### Gates

`tests/test_edit_v2_face_zone.py` (mapping per layout, thresholds, fix, cut samples, malformed
faces, the caption box and presets against the JS sources), `tests/test_edit_v2_camera.py`,
`tests/test_face_window.py`, `tests/test_speaker_track.py`, `tests/test_edit_v2_plan.py`,
`tests/test_edit_v2_plates.py`; `web/tests/editor-caption-face.test.mjs`; browser spec
`web/e2e/editor-shell.spec.mjs` ("a caption over the face…") on the editor fakes.

## 5.51 Keywords: the emphasis block and two accent fonts (2026-10-21)

A keyword ("Kata kunci", `word_edits[id].emphasis`) changed colour only. A pack may now also give
it a size and an accent font through an optional `emphasis` block in its file. There is no free
per-word font, size or colour: the look of a keyword belongs to the pack. Golden pixels change
for keywords in Karaoke, Bold and Sinar; this falls under the batch's one `RENDER_SEMANTICS` bump
(§5.49), so the value stays 2. `schema_minor`, the document and the commands are unchanged.

### Pack field `emphasis` (`captions_ass.Emphasis`, `load_pack`)

- `{"scale_pm": int, "font"?: {"family", "file", "bold"}}`, nothing else. `scale_pm` is
  `EMPHASIS_SCALE_RANGE` (1000–2000) per mille of the line's font size. `font.file` must be a
  pinned font of `fonts.json`, and `font.family` one of the names libass selects that file by
  (its `family`, or `family` + " " + `style`): a misspelt family would silently fall back to
  DejaVu Sans, so `load_pack` refuses it.
- Only on an outlined pack (`border_style` 1) with the `static`, `word` or `karaoke` reveal.
  Box (BorderStyle 3 boxes each run separately) and Sorot (each word placed by hand) are refused
  by `load_pack` and by `build_ass_v2`.
- The colour stays where it was: `defaults.emphasis`, changed by "Warna kata kunci"
  (`overrides.emphasis`).
- Pack files: Karaoke `{"scale_pm": 1400}` (size only, DejaVu Sans Bold stays); Bold
  `{"scale_pm": 1400, "font": Anton}`; Sinar `{"scale_pm": 1400, "font": DM Serif Display
  Italic}`. Klasik, Box and Sorot have no block. The pack files change in place (v1), as
  Sorot's did (§5.30); `pack-thumbs/manifest.json` takes the new pack hashes and the PNGs are
  unchanged, because the thumbnail words hold no keyword (the thumbnail ASS bytes are identical).

### Events

- Line size `S` (the pack size, or a single too-wide word's `\fsS`), keyword size
  `E = round_half_up(S · scale_pm / 1000)`. A keyword opens with its colour tags followed by
  `\fsE`, then `\fn<accent family>` when the block has a font, then `\b0`/`\b1` when the accent
  font's `bold` differs from the pack's; the closing block restores the colours, `\fsS`,
  `\fn<pack family>` and the pack's `\b` in the same order. Without a block nothing but the
  colour is written (byte-identical to before).
  - Static and Bold: `{\1c<emphasis>\fsE\fn…}WORD{\1c<text>\fsS\fn…}`.
  - Karaoke: `{\kfN\1c<emphasis>\2c<emphasis>\fsE…}word{\1c<highlight>\2c<text>\fsS…}`.
  - Sinar: the glow copy carries the same `{\fsE\fn…}word{\fsS\fn…}` around the keyword, so the
    glow and the line keep the same glyphs.
- The entrances (§5.39) are unchanged: Pop scales with `\fscx`/`\fscy`, which multiply `\fs`.
- One-line packs (`max_width_pm`) measure a keyword in its own size and font
  (`_line_fits`: `hmtx` advances of plain words and spaces at `S` in the pack font plus the
  keywords at `E` in the accent font): `fit_cues` splits a line the keyword makes too wide. A
  single keyword wider than the limit shrinks the line to the largest `S` whose `E` fits in the
  accent font (`_single_word_size`).

### Fonts

- `resources/fonts/Anton-Regular.ttf` (family "Anton") and `DMSerifDisplay-Italic.ttf` (family
  "DM Serif Display", style "Italic"; packs name it "DM Serif Display Italic", its full name),
  both OFL-1.1 from `github.com/google/fonts` at commit `47d54ca1`, with `OFL-Anton.txt` and
  `OFL-DMSerifDisplay.txt`. `fonts.json` lists sha256, size, licence and source (`kind`
  `google-fonts`, the raw URL at that commit, the upstream repository and commit).
- The render loads them like Montserrat: FFmpeg's `ass` filter with `fontsdir=fonts` (libass'
  embedded-font provider); fontconfig still accepts DejaVu Sans only, which stays the only
  fallback. The image copies `resources/` as before.
- The preview: `preview_cli._font_entries` lists the pack's accent font after the pack font,
  whether or not a word is a keyword yet, so JASSUB has it before the first frame.
- `glyph_unsupported:U+XXXX` checks a keyword against the accent font (₿ is in Montserrat, not in
  Anton). The licences page lists both fonts with their OFL text.

### Gates

- Tests: `tests/test_captions_ass.py` (the block's rules, the tags per pack, size per output,
  `\b` switching, Sinar's glow, one-line splits and a shrunk keyword, entrances),
  `tests/test_edit_v2_glyphs.py` (`fonts.json`), `tests/test_edit_v2_captions.py` (the glyph
  check), `tests/test_edit_v2_preview_cli.py` (the browser's font list).
- ASS goldens: `word_edits__c30` (Karaoke) and `full_example__c30` (Bold) rewritten; new
  document `valid/keywords_sinar__c30.json` and golden `keywords_sinar__c30`;
  `plan-shas.json` recomputed for the two documents whose ASS changed.
- P-TXT: `karaoke-kunci-40`, `bold-kunci-40`, `sinar-kunci-40` (`reference_text.EMPHASIS_PACKS`,
  "WAJIB" and "Ayahku" as keywords), all three in the smoke subset; the glyph probe's
  `PINNED_FACES` add `Anton-Regular` and `DMSerifDisplay-Italic`.

## 5.52 Zoom and the source's black bars (2026-10-21)

A P2 item of the 2026-10-21 adoption batch, next to `docs/plans/2026-10-20-lanjutan-sesi.md`
P2. Two inputs reach every layout chain: a per-clip static zoom from 100 % to 150 %
(`layout.zoom_pm`) and the picture inside constant black bars of the source
(`base.source.content_rect`), measured once when the source is probed. Nothing that renders today changes: a document without either key keeps its
graph, plan sha and plate key, so `RENDER_SEMANTICS` stays 2 (§5.49) and no golden moves; a source without
bars has no content rect, so its clips are exactly today's.

### The document (§3.3, §5.5)

- Optional `layout.zoom_pm` (`ZOOM_RANGE` 1000–1500): the zoom of every layout but the split. 1000
  is no key (R10: back to 100 % equals the seed), so the key is 1001–1500; 1000 or out of range is
  `range_invalid` at `/layout/zoom_pm`, and so is any zoom under the split (its bands carry their
  own, §5.45). It composes with the keyframes (§5.44) and the latar blur fallback (§5.40).
- Optional `base.source.content_rect` `{x, y, w, h}` (exactly those keys; another is
  `unknown_key` at parse level): even integers, `w`/`h` ≥ 16, inside the source and not the whole
  source (each field `range_invalid` at its pointer, the rect at `/base/source/content_rect`). It
  is part of the base: the seed writes it from `analysis/source.json` and every revision keeps it
  (`base_changed` otherwise). `schema_minor` stays 0 (§3.8 amendment).
- `doc.auto_file_is_seed`: a legacy seed with a content rect is not its auto file (the legacy
  renderer never crops the bars), as with a logo or a text watermark (§5.43).
- Constants in `edit_v2/__init__.py`; the client's in `web/lib/editor/doc-model.mjs`
  (`ZOOM_RANGE`, `ZOOM_STEP_PM` 50, `zoomOf`).

### Black bars (`source_info.py`)

- `probe.content_rect` (probe `version` stays 2; an older file has no key and stays valid, its
  clips keep the whole picture): `measure_content_rect(source, video_stream, duration_ms, size)`
  runs FFmpeg's `cropdetect=limit=0.094:round=2:reset=0` (luma ≤ 24/255 is black) on 8 frames
  (`CROPDETECT_FRAMES`) at the middle of each fifth of the video (`CROPDETECT_SAMPLES` 5), each run
  bounded by `CROPDETECT_TIMEOUT_S` (30 s, two threads, the allowlisted environment and
  `-protocol_whitelist file,pipe`). A run that fails or times out is a sample without a picture.
- `content_rect_from_cropdetect(samples, size)`: the last `x1 x2 y1 y2` bounds of each run; a
  black picture (`x2 < x1`) or bounds outside the size are left out; fewer than two samples, or
  fewer than half, is no rect. The rect is the bounds of every sample together (a frame whose
  picture reaches further widens it). Per axis the bars count only when both are at least 1 % of
  the side (and 4 px), alike (within 2 % and 8 px), with at least a quarter of the side between
  them; else the axis is whole. Rounded inwards to even. No bars on either axis is null.
- `ensure_source_info` refuses a stored rect that is not null or a valid rect of the probe's size.
  `seed._source` copies a non-null rect into `base.source.content_rect`.

### Geometry (`layouts.py`)

- `zoomed_output(output, zoom_pm)`: each side times `zoom_pm/1000`, rounded half up (the output
  itself at 1000). The crop layouts scale to cover it (`force_original_aspect_ratio=increase`) and
  keep an output-sized crop: `pan_limit`, `centre_x` and `crop_y` (the crop's row, `(in_h −
  out_h)/2` truncated, `crop`'s default) take `zoom_pm`, so the travel widens and a 9:16 source
  gains some. Latar blur scales its picture to fit the zoomed output
  (`force_original_aspect_ratio=decrease`, `foreground_size`) and crops it, centred, to the frame
  where it outgrows it; the blurred background is the zoomed cover crop.
- The content rect: every chain starts with the exact `crop=w:h:x:y` to it, after its input
  label (`layout_chain(..., content=)`, `split_chain(..., content=)`), and lays out that picture
  (`picture_size`). `keyframe_positions` and `pan_limit` take the picture's size;
  `crop_positions(..., zoom_pm, content)` moves the camera plan's centres (fractions of the whole
  source) into it: a centre `c` is at `(c·W_src − x)/w` of the picture, one fraction rounded half
  up to even, clamped to the travel. `check_content_rect` is the validator's rule (`ValueError`).
- `tests/fixtures/edit_v2/zoom-vectors.json` (`potongin.zoom-vectors/1`): 29 inputs (hand-picked
  letterbox, pillarbox and 9:16-in-16:9 cases and seeded random ones over 7 source/output sizes and
  zooms 1000–1500) with the picture, zoomed output, scaled size, travel, centre, row, latar blur's
  foreground and the crop x of their keyframes, written by `tests/test_edit_v2_zoom.py`
  (`EDIT_V2_UPDATE_VECTORS=1`); `web/tests/editor-zoom.test.mjs` checks
  `web/lib/editor/framing.mjs` against the same file.

### Compiler, plan and keys

- `RenderPlan.zoom_pm` (1000 without the key) and `RenderPlan.content_rect` (`(x, y, w, h)` or
  `None`); `compile_ffmpeg` (`layout`) passes both to every chain in every mode with a layout
  (final, reference, plate cells, frame), so plate cells, truth frames and the final agree per
  frame. `RenderPlan.to_json` is unchanged; the content sha carries both.
- `plates.plate_key` adds `"zoom_pm"` and `"content_rect": [x, y, w, h]`, each only when present;
  every other key is the one before (pinned in `tests/test_edit_v2_plates.py`).
- `preview_cli`: `plan`'s `lane` and `prepare` name `zoom` (`zoom_pm` or `null`) next to `split`;
  `cells` takes an optional `zoom` (1001–1500; anything else a usage error; with the split
  `range_invalid`, exit 6). The content rect comes with the seed. `prepare` with a switch into the
  split reports no zoom (`_switched`, as `SetLayout`). `web/lib/preview-lane.mjs` keeps the
  plate's zoom and sends it with every cells batch of that plate; a plan or prepare result with a
  malformed zoom, or a zoom on the split, is not trusted (503).

### Commands and the two-tab merge (`web/lib/editor/commands.mjs`, `rebase.mjs`)

- `SetZoom {zoom_pm}` (1000–1500; 1000 drops the key; `invalid_args`, `value_out_of_range`; the
  same value is no change). Not under the split (`zoom_unavailable`, "Layar terbagi mengatur zoom
  di Atur potongan."). Merge key `layout:zoom`: a slider drag is one undo step. `SetLayout` keeps
  the zoom except into the split (`layoutAfterSwitch`, the layout thumbnails and `preview_cli`
  `_switched` do the same). `checkDoc` mirrors the validator's zoom rule; the cross-check
  generator sends `SetZoom`.
- Two tabs: part `layout.zoom` (value: `zoom_pm` or `null`) in the "Tata letak" group; the dialog
  names `<mode>, zoom 125%`. Mine's zoom over the other tab's split brings mine's layout (and so
  the split's bands, or their absence) along, and mine's layout brings mine's zoom.

### Editor

- `web/lib/editor/framing.mjs`: `zoomedOutput`, `centreX`, `cropY`, `foregroundSize`,
  `pictureSize`; `panLimit`, `keyframePositions` (`zoomPm`) and `cropAt` take the zoom;
  `framingSizes(doc)` → `{source: the picture, output, zoom}`, so `framingAvailability`, "Atur
  bingkai" and "Atur layar terbagi" (`split-model.mjs` `splitView`) work on the picture inside the
  bars. `gizmos/frame-geometry.mjs` `frameGeometry(source, output, zoom)`: the box is
  `W/scaled_w` by `H/scaled_h` of the picture, its top at `crop_y/scaled_h`. The still
  (`sourceFrameDoc`) has no zoom, so it shows the whole picture.
- Tata letak panel: a section **Zoom** under every layout but the split ("Perbesar gambar sampai
  150%. Tepi gambar ikut terpotong."): a range input 100–150 % in 5 % steps (`ZOOM_OPTIONS_PM`)
  with its value beside it, drawn from a draft and stored once on release (pointer or key), and
  **Kembali ke 100%** while zoomed (`layout-model.mjs` `zoomView`, `zoomCommand`). A source with a
  content rect adds "Garis hitam di tepi video sumber sudah dibuang." under the layouts. The
  layout thumbnails' `contentKey` includes the zoom. Mode Cepat's Tata letak summary adds
  " · zoom 125%" while zoomed.

### Gates

P-FRAME gains `cfr_30_zoom` (latar blur at 150 %) and `cfr_30_zoom_content` (latar blur at 125 % on
a 4:3 content rect of the 640×360 barcode source; the rect keeps the first row, where the index
is). P-PLATE gains `plate_fill_center_zoom_keyframes` (125 %, the keyframes of
`plate_fill_center_keyframes`), `plate_camera_zoom_content` (face-track at 120 % inside the 4:3
rect) and `plate_split_content` (the split's bands inside it): the crop x of every plate, reference
and final frame against `keyframe_positions` / `crop_positions` / `centre_x` at the zoom over the
picture, read with `edit_v2_media.decode_crop_x(..., offset, picture_w)`
(`scripts/parity/frame_identity.py`). The player fixtures expect the zoomed crop x over the
picture (`scripts/parity/player_fixtures.py`). `tests/test_edit_v2_compile.py` decodes the crop x
of the plate cells and the lossless reference of a zoomed, framed synthetic clip with a content
rect, and the frame index of latar blur at the same zoom, with real FFmpeg; and
`tests/test_edit_v2_source_info.py` measures the bars of a letterboxed source and none on a plain
one. Browser spec: `web/e2e/editor-zoom.spec.mjs` on the editor fakes.

## 5.53 "Pakai di semua klip": one clip's settings on every other clip (2026-10-21)

One button under Caption, Logo and Tata letak copies that settings group of the open clip to every
other clip of its job in one batch, server-side. Each target is saved through the document store
(§4.4: If-Match, `revision + 1`, `parent_sha256`, receipts), so the schema, the validators, the
engine and the render do not change and `RENDER_SEMANTICS` stays.

### Groups (`src/ai_clipper/edit_v2/apply_all.py`, stdlib)

| Group | What is copied | What stays the target's |
|---|---|---|
| `captions` | `captions.enabled`, `captions.pack`, `captions.overrides` | `captions.word_edits` (word ids of its own transcript) |
| `logo` | the `visual` overlay track (with its `assets` entry) and `watermark` (absent copies as absent) | the hook and music tracks and their assets |
| `layout` | `layout` without `keyframes` (mode, `no_face`, `split`) | nothing; the source's keyframes are frames of its own window and are never copied |

`part(doc, group)` is what is compared, `copied_part` what is written, `with_part` the result.
Tracks keep the order hook, visual, audio; `assets` is exactly what the tracks reference.

### The skip rule

A target that already matches is `unchanged` and not written. Otherwise it is written only while
that group is still its seed's (`part(doc) == part(seed)`) or exactly what an earlier batch of the
group wrote to it and no undo took back (the job's batch records), so a second batch updates the
first one's clips. Otherwise it is listed, never overwritten: `edited` (changed by hand), `not_ready` (no seed or
words yet, or a clip without an id), `read_only` (the job re-ran with other words), `conflict`
(saved elsewhere while the batch ran: the store's If-Match refused it), `invalid` (the result does
not validate for that clip). The source clip is never written.

### Batch record and idempotency

`analysis/apply-all/<batchId>.json` (canonical JSON, 0600; directory 0700; one batch or undo at a
time per job, `flock` on `analysis/apply-all/.lock`) is written before the first save with the
group, the source clip and etag, the copied value and, per target, the etag it starts from and its
group before. Each save uses an Idempotency-Key derived from the batch id (UUIDv5), and its
document is built from that starting revision with `audit.updated_at_ms` unchanged (the server
stamps it), so a retry after a crash replays the saves already made (§4.4 receipts) and finishes
the rest. The request's own Idempotency-Key is the batch id: the same key with the same arguments
answers the stored result; with other arguments `idempotency_conflict`. The newest 50 records are
kept (`RECORDS_KEEP`). `audit.last_command` is `ApplyToAllClips`.

### Undo

For each applied clip still at the batch's revision (If-Match = the etag the batch wrote), a new
revision with the group restored to its value before the batch (`UndoApplyToAllClips`). A clip
saved since is skipped as `changed`; an asset the janitor removed makes it `invalid`. The result is
stored in the record: a second undo answers it without writing.

### API (`edit_v2.api`, `web/lib/apply-all.mjs`)

| Op / route | Arguments | Answer |
|---|---|---|
| `apply_all` · `POST /api/jobs/:id/clips/:clipId/apply-all` | `{jobId, clipId, etag, group, batchId}`; HTTP: body exactly `{group, etag}` ≤ 1 KiB, `Content-Type: application/json`, `Idempotency-Key` UUID (the batch id) | `200 {batchId, group, applied: [{clipId, index}], skipped: [{clipId, index, reason}], unchanged: [{clipId, index}]}`; `409 revision_conflict` when `etag` is not the source's current revision (no document in the answer); `409 idempotency_conflict`; `404 not_found` |
| `undo_apply_all` · `POST /api/jobs/:id/apply-all/:batchId/undo` | `{jobId, batchId}`; HTTP: empty body or `{}` | `200 {batchId, group, restored: [{clipId, index}], skipped: [{clipId, index, reason: "changed"\|"invalid"}]}`; `404 not_found` for an unknown or pruned batch |

Both routes: session, `POTONGIN_EDITOR_V3`, same-origin (`sameOriginMutation`), ids by regex
(`batchId` joins `ROUTE_PARAMS`), the editor rate-limit bucket, the CLI timeout 5 minutes. The
targets are the job's clips listing (`clips` op) in its order.

### Editor (`web/lib/editor/apply-all.mjs`, `components/editor/apply-all/ApplyAll.jsx`)

- The shell builds one controller per clip (`createApplyAll`, in the panel props bundle as
  `applyAll`), so the result stays across a card close and a view switch. Buttons: "Pakai caption
  di semua klip" (Caption card, Teks panel), "Pakai logo di semua klip" (Logo & Musik card, Logo
  panel; it carries the text watermark), "Pakai tata letak di semua klip" (Tata letak card and
  panel). Hidden while the job has no other clip; disabled read-only and during a face analysis.
- A click saves the clip first (`store.flush()`, whose etag is sent); a save that fails or waits on
  a conflict sends nothing. After a lost answer (network, 5xx) the next click reuses the key while
  the saved etag is the same, so the server replays the batch instead of skipping its own writes.
- The result (`role="status"`): "Dipakai di n klip · k dilewati" (plus "· m sudah sama"), the
  skipped clips by number and reason under "Lihat yang dilewati", and **Urungkan**, which becomes
  "Dikembalikan di n klip" (plus "· k dilewati").
- A clip switched to Ikuti wajah gets its face analysis when it is next opened (the editor's
  prepare), as after any layout switch; its export needs that analysis.

### Gates

`tests/test_edit_v2_apply_all.py` (groups, skip reasons, unchanged, conflict, invalid, replay,
resume after a crash, pruning, undo, undo after a later save, undo resume, the envelope);
`web/tests/apply-all-api.test.mjs` (auth, flag, CSRF, ids, body, exit-code mapping, sanitizing,
a real batch and undo through the routes); `web/tests/editor-apply-all.test.mjs` (texts,
controller, API client, fakes, the six places); browser spec `web/e2e/editor-apply-all.spec.mjs`
on the editor fakes.

## 5.54 Output sizes: 1:1 and 1080p (2026-10-21)

A P3 item of the 2026-10-21 adoption batch. A job renders its clips at one of four sizes: 9:16 at
720×1280 (the default, every clip before this) or 1080×1920, or 1:1 at 720×720 or 1080×1080. No
2K, 4K or 16:9. The render cost of each size is measured in `docs/editor/GATES.md` "Output sizes
(PF-SIZE)". Nothing that renders today changes: every rule below gives a 9:16 output exactly
its earlier numbers, so `RENDER_SEMANTICS` stays 2 and no golden moves.

### The document and the seed

- `OUTPUT_SIZES` (`edit_v2/__init__.py`) = `((720, 1280), (1080, 1920), (720, 720), (1080, 1080))`;
  the validator's `/output` rule, `seed.renderSize`, `AutoOptions`, `compile_job(size=)`,
  `verify_output` and `render_edit` take exactly these. `schema_minor` stays 0: the document's
  shape is unchanged, only the allowed values grow (§3.8 amendment). The output is fixed at seed
  (`base_changed` in the editor): the editor has no format setting, a clip keeps its job's size.
- Three frame rules in the package, mirrored in `web/lib/output-frame.mjs` (`uiZone`,
  `frameMargins`, `textHeight`, checked against the Python constants by
  `web/tests/output-size.test.mjs`):
  - `ui_zone(output)`: the TikTok zone of plan §5.9 G5 (93/280/93 at 720×1280, scaled) for 9:16;
    `(0, 0, 0)` for 1:1, so a 1:1 clip never gets `unsafe_zone` (captions, hook or logo).
    `plan.ui_zone` is this function.
  - `frame_margins(output)`: where the logo presets and the text watermark stop: the zone at 9:16;
    at 1:1 `EDGE_MARGIN_PM` (40 ‰ of the width, the presets' left margin: 29 px at 720, 43 at
    1080) on the top, bottom and right. `seed.default_logo_transform` and the editor's `SetLogo`
    / `SnapLogo` (`commands.mjs` `snapTarget`, `logo-geometry.mjs` `cornerStart`) use it;
    `tests/fixtures/edit_v2/default-logo-vectors.json` has 48 vectors (12 logos × the four sizes).
  - `text_height(output)` = `max(H, rhu(16·W, 9))`: the height every text size is computed from
    (caption font, outline, shadow, glow, box padding, entrance blur, hook sizes of every design,
    the watermark's size). At 9:16 it is H; at 1:1 it is the 9:16 frame of the same width, so a
    1:1 caption, hook or watermark is exactly the size it has in the 9:16 clip of that width and
    wraps the same. Positions stay fractions of the output's own height: the caption's `y_e5`
    (Bawah is 83 % of 720 at 720×720), the hook's `y_e5`, the watermark rows.
- `captions_ass.layout_watermark` uses `frame_margins` and `text_height`;
  `edit_v2/captions.py` reads the zone from `ui_zone` (no warning at 1:1).

### Job option, runner and CLI

- `outputSize` (`web/lib/jobs.mjs` `OUTPUT_SIZE_IDS`: `720x1280`, `1080x1920`, `720x720`,
  `1080x1080`): an optional V3 option of the job form and of a stored job, like Posisi/Ukuran
  (§5.48); anything else is refused ("Unsupported output size"). A job without it is 720×1280.
- `web/scripts/run-job.mjs` passes `--width`/`--height` from it. A YouTube source is downloaded up
  to 1080p for a 1080-wide size and up to 720p otherwise (`sourceHeightFor`, `buildVideoDownload
  {maxHeight}`): a 1080p clip from a 720p source would only be an upscale. An upload is used as it
  is.
- `ai-clipper` (CLI) refuses a V3 run whose `--width`/`--height` is not in `OUTPUT_SIZES`
  (exit 2). V1 and V2 jobs keep any size (the legacy engine renders any).
- The legacy engine (the rollback switch and the per-clip fallback) renders 1:1 with the same
  chains (`render.py` is size-generic) and the same text sizes (`build_ass` uses `text_height`).
- Time budgets: `render_queue.RENDER_COST_PERMILLE` gives a 1:1 export the budget of the 9:16
  size of its width (PF-SIZE measured 1:1 at 0.6-0.95× of it); `render_edit.render_timeout_s`
  (the automatic clips) multiplies its prediction by the output's pixels over 720×1280's when
  larger (1080×1080 ×1.27, 1080×1920 ×2.25), so a 1080p clip is not cut off by the 720p budget.

### Dashboard and editor

- Dashboard: a section **Format video** before Layout with **Rasio** (9:16, 1:1) and
  **Resolusi** (720p, 1080p) pills (`dashboard-choices.mjs` `RATIO_CHOICES`, `RESOLUTION_CHOICES`,
  `outputSizeOf`), kept per browser with the other choices; the folded summary names 1:1 and
  1080p (9:16 and 720p go unsaid). The preview under Tampilan klip is 720×720 at 1:1 without the
  TikTok zone and its key (`look-preview.mjs` `tiktok: false`), the text at the 9:16 sizes; the
  layout icons turn square.
- Editor: the stage, the gizmos and the dialogs follow `doc.output`. At 1:1 there is no
  **Zona aman** toggle and no zone overlay (`StageToggles zone={false}`, `Stage`), the logo and
  caption gizmos draw no zone bands, the caption gizmo's box uses `textHeight`, "Atur bingkai" and
  "Atur layar terbagi" show a 1:1 result ("Bingkai 1:1", "Hasil 1:1 di …"), and the layout notes
  say "Potongan 1:1" (`layout-model.mjs` `noteForRatio`). The project page plays a 1:1 clip inside
  its usual frame (`object-fit: contain`).

### Gates

`tests/test_edit_v2_output_sizes.py`: the frame rules, the document, the seed and its logo, no
`unsafe_zone` at 1:1, captions/hook/watermark sizes per pack and design, and a real 720×720 render
(latar blur and potong tengah) that passes `verify_output` with every frame the planned source
frame. `scripts/parity/frame_identity.py`: P-FRAME and G1/G2 gain `SQUARE_CASES`
(`square_720_29.97` latar blur with hook, `square_720_camera`, `square_1080_keyframes`), P-PLATE
gains `plate_camera_square` and `plate_split_square`; the browser player fixtures keep their
720×1280 cases. `scripts/parity/logo_gates.py` adds 720×720 to the G5 logo vectors. PF-SIZE:
`scripts/perf/output_sizes.py` (GATES "Output sizes (PF-SIZE)").

## 5.55 Small edits: the 0.1 s nudge, "di sumber mm:ss" and Ctrl+klik for Kata kunci (2026-10-21)

Three small editor additions. The document, the schema (`schema_minor`), the validators, the
engine and the render do not change: a nudged edge is an ordinary segment edge, and a keyword
set by Ctrl+klik is the `SetWordEmphasis` that Ctrl+E already sends.

### NudgeEdge (`web/lib/editor/commands.mjs`)

- `NudgeEdge {seg: "body" | "cold_open", edge: "in" | "out", ms}` moves one edge of that segment
  by `ms` (a safe integer, not 0, |ms| ≤ 1000), in whole frames:
  `sign(ms) · max(1, divRoundHalfUp(|ms|·num, 1000·den))` (0.1 s is 3 frames at 30000/1001 and
  at 25 fps). It sits after TrimEnd in the command list (53 names, `__dev__/fakes.mjs` too).
- The moved edge may leave the `bounds` table (§3.6): it is the one cut point placed by hand.
  TrimStart/TrimEnd, the drag and the handle's plain arrows still snap to a word gap. `tight_cut`
  fires only when the edge lands on a `tight` bounds frame, as for any edge.
- The body: the same path as the trims (`trimBody`: `range_invalid`, `outside_window`, the
  removals it crosses clamped or dropped, then `checkDoc`, so `duration_out_of_bounds` and
  `cold_open_invalid` hold). The cold open: the same path as NudgeColdOpen (removals clamped, the
  join and its transition kept; `cold_open_missing` without one, `cold_open_invalid` outside
  0.5–8 s or when it would only repeat the opening).
- Args are normalised to `{seg, edge, ms}`; merge key `edge:<seg>:<edge>`, so quick nudges of one
  edge within 500 ms are one undo step. The rebase replays the step relative to the other tab's
  edge (parts `trim` or `coldopen`, found by `diffParts`); both tabs moving the same edge is a
  `trim` conflict.
- `scripts/edit_v2/crosscheck_commands.mjs` generates it (weight 4, ±100…1000 ms, rarely out of
  range), so the 1,000-sequence Python cross-check, QG-UNDO and QG-CONFLICT cover off-gap edges.
  QG-CONFLICT compares `captions.override.words_max` by its effect (`captionWordsPerLine`): a
  pack switch in the other tab may drop the key while the chosen count stays (§5.30).

### Editor

- Timeline (Mode Lengkap): the header has "Awal | Akhir" (pressed pair: the selected trim edge)
  and "−0,1 dtk" / "+0,1 dtk". Focusing, clicking or dragging a trim handle selects its edge, which
  the handle shows in the text colour (the other stays blue). On a focused handle ←/→ go to the
  next word gap as before and Shift+←/→ send `NudgeEdge` ±100 (`timeline-model.trimHandleKey`);
  the shell leaves both to the handle (`role="slider"`). The help lists them with the scope
  "di gagang timeline".
- Cold open panel: four buttons under the one-word nudges, "Awal −0,1 dtk", "Awal +0,1 dtk",
  "Akhir −0,1 dtk", "Akhir +0,1 dtk" (merge key `edge:cold_open:<edge>`).
- Transport row (`StageControls.jsx`): after the clip time, "di sumber 12:34" (`h:mm:ss` from one
  hour): the source-video time of the playhead's frame through the plan's pieces
  (`shell-model.sourceClockAt`), painted from the frame bus outside React. Mode Cepat's bottom
  bar does not show it.
- Transcript: Ctrl+klik (Cmd+klik on macOS, where Ctrl+click opens the context menu) on a word
  sends `SetWordEmphasis {wordId, on: !emphasis}` and leaves the selection and the playhead alone;
  a plain or Shift click keeps today's behaviour (`transcript/actions.mjs` `keywordClick`,
  `keywordCommand`). Every word's tooltip ends with "Ctrl+klik: jadikan kata kunci" (or
  "batalkan …", "⌘+klik" on macOS), and the transcript's hint line names it. Read-only: no hint,
  and the click only says "Mode baca-saja".

### Gates

Tests: `web/tests/editor-commands.test.mjs` (frames per fps, both segments, window, removals,
cold-open rules, bad args, merge key), `editor-history.test.mjs` (one undo step, replay),
`editor-rebase.test.mjs` (merge and the `trim` conflict; words per line across a pack switch),
`editor-shell-model.test.mjs` (`sourceClockAt`), `editor-timeline-model.test.mjs`
(`trimHandleKey`), `editor-transcript.test.mjs` (Ctrl/Cmd+klik), `editor-shortcuts.test.mjs`;
`tests/test_edit_v2_crosscheck.py`. Browser spec `web/e2e/editor-nudge.spec.mjs` on the editor
fakes.
## 5.56 Logo or text watermark over the caption (2026-10-21)

The logo is drawn above the caption and the text watermark beside it, both for the whole clip, so
either one on the caption block hides words. The plan warns `logo_over_caption` and the editor
moves the part to the nearest spot that clears the caption, in one click. The document, the schema
and the render do not change; warnings are not part of the plan sha, so `RENDER_SEMANTICS` stays.

### The check (`edit_v2/overlay_zone.py`, stdlib)

- The caption block is `face_zone.caption_box` (§5.50, the caption gizmo's box). Nothing is
  checked when captions are off or the caption track has no cue.
- The logo box is `timemap.logo_box`; the watermark box is `captions_ass.watermark_box`: the line
  as `layout_watermark` places it, its `hmtx` advance at the laid-out size, one DejaVu line
  (1.164 em) above its bottom, plus the outline.
- A part covers the caption when the overlap is at least 15 % (`face_zone.OVERLAP_PM`) of the
  smaller of the two boxes, the face check's rule.
- At most one issue per part, the logo's first:
  `{code: "logo_over_caption", path, ref, f}`. `f` is the first caption cue's frame.
  - Logo: `path` is `/tracks/<i>/items/0/transform`; `ref` is the SnapLogo corner
    (`overlay_zone.corner_box`, the same box as `snapTarget` in `web/lib/editor/commands.mjs`)
    nearest to the logo's centre, other than the box it already has, that clears the caption
    (ties: top before bottom, left before right).
  - Watermark: `path` is `/watermark/pos`; `ref` is the nearest other place on the 3×3 grid that
    clears it (fewest steps, the same column first, then the higher row).
  - `ref` is absent when nothing clears.
- `errors.WARNING_CODES`, `render_queue.V3_WARNING_CODES` (through it) and
  `web/lib/clip-renders.mjs` accept the code. Message: "Logo atau teks watermark menutupi caption".
  A document the check cannot read gives no warning; it never stops the plan.

### Client

- `logo-model.logoCaptionFix(warning)` → `{id, part, label, command}`: `SnapLogo {corner}` for
  the logo ("Pindah ke Kanan atas"), `SetWatermarkPosition {pos}` for the watermark ("Pindah ke
  Kanan tengah"), merge key `null` (one undo step); null for another code or an unknown `ref`.
  `logoCaptionNote(plan, part)` → `{text, fix}` for `"logo"` or `"watermark"`.
- Perlu dicek names the part ("Logo menutupi caption", "Teks watermark menutupi caption", from
  the path) and keeps the two apart even when both name the same place. It is a check (severity
  `warning`, a tick before export) with the fix beside the jump.
- The Logo panel and its watermark section (Mode Lengkap) and the Logo & Musik card (Mode Cepat,
  logo only, 44 px button) show the line and the button.

### Gates

`tests/test_edit_v2_overlay_zone.py` (corners, watermark box, cover rule, fixes, no caption, no
fix, unreadable documents), `tests/test_edit_v2_plan.py` (the plan carries it; the sha stays);
`web/tests/editor-logo-caption.test.mjs` (messages, fixes, the same corner boxes as the Python
test, one undo step, the views), `web/tests/clip-renders.test.mjs`; browser spec
`web/e2e/editor-shell.spec.mjs` ("a watermark over the caption…") on the editor fakes.

## 5.57 "Hook di video": the hook on or off from the project page (2026-10-21)

One switch per clip in the project page's caption box, beside **Ubah** and **Tulis ulang**,
shows or hides the hook text in the video. It changes the clip's editor document, as the editor's
`SetHookEnabled` does, and then exports that revision, so the editor, the export and (when the
clip is back at its seed) the automatic file agree. No schema, validator, engine or flag change:
`SCHEMA_MINOR` and `RENDER_SEMANTICS` stay. The default stays the seed's (hook on when the clip has
one).

### Document (`src/ai_clipper/edit_v2/hook_toggle.py`, stdlib)

- `with_hook(doc, seed, on)`: off drops the `hook` track; on keeps a hook the document has, or
  puts back the seed's hook track (its text, design, length and place) in the hook, visual, audio
  order; on without a seed hook is `range_invalid` at `/tracks`. Off and on again equals the seed,
  so its export completes at once with the automatic file (R10).
- `set_hook(clip_dir, *, etag, on, idempotency_key, now_ms)` builds the new revision from the one
  at `etag` (`revision + 1`, `parent_sha256 = etag`, `audit.last_command = "SetHookEnabled"`, the
  rest of `audit` kept; the store stamps `updated_at_ms`) and saves it with `store.put` (If-Match,
  receipts), so a retry with the same key replays the save. A switch to the state the document
  already has writes nothing (`changed: false`). `etag` not current: `RevisionConflict`. A
  read-only document (§3.6, the job re-ran): `op_disabled` at `/base/words`.
- `state(doc, seed)` → `{on, available}`: `on` when the document has a hook item; `available`
  when the document or the seed has one and the document is not read-only.

### API (`edit_v2.api`, `web/lib/clip-hook-api.mjs`)

| Op / route | Arguments | Answer |
|---|---|---|
| `set_hook` · `POST /api/jobs/:id/clips/:clipId/hook` | `{jobId, clipId, etag, hook: "on"\|"off", idempotencyKey}`; HTTP: body exactly `{on: boolean, etag}` ≤ 1 KiB, `Content-Type: application/json`, `Idempotency-Key` UUID | `200 {etag, revision, changed, hook: {on, available}}`; `409 revision_conflict` (no document in the answer); `409 idempotency_conflict`; `422` (`op_disabled`, `range_invalid`); `404 not_found` |
| `clips` · `GET /api/jobs/:id/clips` (amended) | | each clip also carries `hook: {on, available}` from its current document, or null without a seed |

The route: session, `POTONGIN_EDITOR_V3`, same-origin (`sameOriginMutation`), ids by regex, the
`api` rate-limit bucket, the CLI's default timeout. `web/tests/security-support.mjs` lists it.

### Project page (`web/components/HookSwitch.jsx`, `web/lib/clip-hook.mjs`)

- `clipEntryView` adds `hook` and `editEtag` (the current revision's etag). `hookSwitchView(entry,
  {editable})` → `{on, clipId, etag}` for a completed project's clip that is openable and whose
  `hook.available` is true; otherwise the switch is not shown (no listing, a clip still needing
  prepare, a failed clip, no hook, read-only).
- A checkbox with `role="switch"`, its visible label "Hook di video", a hint ("Mengubahnya
  mengekspor ulang klip. Hasilnya di Ekspor terakhir."), a status line (`role="status"`). Space
  and Enter switch it; 44 px tall; `aria-busy` while saving; the track draws the focus ring.
- `switchHook({jobId, clipId, etag, on})`: `POST …/hook`, then, when it changed, `POST …/renders
  {editEtag}` with its own Idempotency-Key. Status texts: "Hook disembunyikan. Klip sedang diekspor
  ulang." / "Hook tampil. Klip sedang diekspor ulang.", "Hook tampil di video." when the export
  completed at once, "Tersimpan, tapi ekspor belum jalan. Ekspor dari editor." when the export was
  refused (storage), "Klip ini sudah diubah di editor. Coba lagi." on a conflict (the listing is
  read again so the next try saves from the new revision), "Hook belum tersimpan. Coba lagi."
  otherwise; 401 goes to login.
- After a switch the page reads the clips listing again; while any listed export is queued,
  claimed or rendering (`entriesExporting`), it reads it again every 8 s (at most 75 times after
  the page or a switch asked), so "Ekspor sedang diproses" becomes "Ekspor terakhir · revisi n". A
  reload that fails keeps the entries shown.
- "Unduh MP4", the ZIP and the video in the panel stay the automatic file, as for any editor
  edit; the switched file is the latest export.

### Gates

`tests/test_edit_v2_hook_toggle.py` (off, on from the seed, track order, no-op, an edited hook
text, stale etag, replay and key reuse, no seed hook, read-only, unprepared clip, envelope),
`tests/test_edit_v2_api.py` (the listing's `hook`), `web/tests/clip-hook-api.test.mjs` (auth,
flag, CSRF, ids, body, exit-code mapping, sanitizing, a real switch through the route and the
listing), `web/tests/clip-hook.test.mjs` (copy, view, the save and export requests, failures, the
listing poll, the page wiring); browser spec `web/e2e/clip-hook.spec.mjs` on faked routes.

## 5.58 Automatic clips trim their silent pauses (2026-10-21)

Owner decision (2026-10-21, by delegation, after the measurement below): the seed of an automatic
clip already carries the cuts Rapikan proposes, checked, for silent pauses, so the automatic file
has no dead air over 0.6 s and the editor opens exactly those cuts (each one restorable). No
schema change: the seed only fills `main.removals`, which a seed always had. The clip id does not
change (the moment is the same); the seed sha and the plan do.

### Measurement (`scripts/eval/pause_trim.py`, `docs/evaluation/PAUSE_TRIM.md`)

The 84 labelled moments of the selection benchmark (7 episodes), word timings, the audio timeline,
caption tags and the clips' peaks, no render. Whisper transcripts (4 episodes, 48 clips, 3,167 s):
59.0 s removed (1.9 %), 37 of 48 clips trimmed, 81 trims of 729 ms on average; per clip p50
1.3 %, p90 5.3 %, max 7.8 %. YouTube captions (7 episodes, 84 clips, 5,582 s): 143.4 s (2.6 %),
69 of 84 clips, 215 trims of 667 ms; p50 1.7 %, p90 6.1 %, max 13.6 %. Laughter gaps (52 and 73)
and voiced gaps (265 and 349) are never cut.

### The trims (`cleanup.auto_pause_removals`, stdlib)

- The candidates are the `gap_silent` items of `build_cleanup(words, peaks=…)` (§5.17: a gap over
  600 ms between two words, at least 80 % audio-timeline silence, cut 100 ms inside each side so
  200 ms of pause is kept, each edge moved to a quiet frame with the clip's peaks; a laughter gap
  and anything within 500 ms of laughter is locked).
- Kept only when both words of the gap lie in the body (`sf_floor(left.s) ≥ body.in_sf`,
  `sf_ceil(right.e) ≤ body.out_sf`) and no caption tag or transcript event of kind `laughter`,
  `applause`, `cheer` or `music` lies within 500 ms of the gap (`AUTO_PAUSE_LOCK_KINDS`,
  `AUTO_PAUSE_LOCK_MS`). The cold open is never trimmed.
- Each one becomes the removal `ApplyCleanup` writes for that item:
  `{id: "rm_<n>" (1, 2, … in order), seg: <body id>, in_sf: inSf, out_sf: outSf, words: [],
  reason: "gap_silent", origin: "suggestion:<item id>"}`. Rapikan therefore counts them as applied
  (`cleanup-model.mjs` `appliedIds`), the transcript shows each as a removed gap, and
  RestoreRemoval brings one back.
- None at all when the body's kept frames would be fewer than `sf_ceil(3000)`
  (`duration_out_of_bounds`).

### Seed (`seed.build_seed`) and pipeline

- Seed-context key `pauseRemovals` (never in `job.json`): missing, null or `[]` seeds exactly as
  before. Otherwise only with `seedBy` `pipeline` (a `prepare` seed describes a legacy file,
  rendered without trims); each entry has exactly the removal keys, an id `rm_[0-9a-z]{1,16}`
  (unique), the body's id, `in_sf < out_sf` inside the body and at or after the previous removal's
  `out_sf`, `words` `[]`, `reason` `gap_silent` and origin `suggestion:<id>`; the body's pieces
  must keep at least `sf_ceil(3000)` frames. Anything else is a `SeedError`.
- `render_edit.AutoRenderer._seed` builds the words artifact, then (when
  `AutoOptions.trim_pauses`) `auto_pause_removals(words, body=<the provisional seed's body>,
  peaks=<the clip's peaks>)`, and seeds with them; the file renders from that seed.
- `render_edit.pause_trim_from_env(env)`: off only when `POTONGIN_AUTO_PAUSE_TRIM`, stripped and
  lower-cased, is `off`, `0`, `false` or `no`; unset or anything else is on. The pipeline passes it
  as `AutoOptions(trim_pauses=…)`. `compose.yaml` gives it to `primary-worker` only
  (`${POTONGIN_AUTO_PAUSE_TRIM:-on}`); `.env.example` shows `# POTONGIN_AUTO_PAUSE_TRIM=on` and
  the off line.
- `AutoClip.seconds` (`render_edit.output_seconds`: the document's pieces) is the rendered length.
  The manifest's `duration`, the poster time and the `no_face` share use it for an edit-v2 clip;
  the legacy engine (rollback or fallback) keeps the selection's length. `_no_face_ms` counts the
  pieces, so a trimmed pause is not counted as time without a face.
- A legacy-engine clip (rollback or fallback) is never trimmed: its seed comes from `prepare`.

### Gates

`tests/test_edit_v2_auto_pauses.py` (body rule, laughter/music/applause/cheer lock, quiet cut,
3 s floor, the fixture seeds validate with their trims, the seed's refusals, the committed
`tests/fixtures/edit_v2/auto-pauses-c30.json`), `tests/test_edit_v2_render_edit.py` (the switch,
the seed on disk carries the trims, `output_seconds`, `_no_face_ms`), `tests/test_pipeline_v3.py`
(the switch reaches `AutoOptions`, the manifest length), `web/tests/editor-cleanup.test.mjs`
(`ApplyCleanup` of the same items gives exactly the committed removals; Rapikan counts them
applied; RestoreRemoval), `web/tests/editor-w3-wiring.test.mjs` (compose and `.env.example`).

## 5.59 Multi-user: job owner and fair queues (2026-10-24, waits for the owner)

The 2026-10-24 overhaul plan `docs/plans/2026-10-24-rombak/` ("rombak"; on the branch
`docs/rombak-spec` until it lands on `main`) allocates §5.59–§5.65 in its Fase 0 contract PR;
§5.66–§5.69 are allocated later by its Fase 10 contract PR (rombak 06 §11.1). These sections are
**contracts only**: none of the code they name exists yet. Each is binding on the PR that builds
it; where a section and its owner document in the plan differ, the owner document wins and this
file is corrected in the same PR. Names are Potongin's own (clean-room, rombak 09 §1).

Owner: rombak 01 §1.3–§1.4 and §6 (fields, deviation), 02 §7.3–§7.4 and §10 (ownership, fairness).
Built in Fase 4–6 (MU-M1 … MU-M9). DDL: rombak 01 §4.1 only.

**Waits for the owner.** The fairness key lives in `job.json`, not in the render request as the
roadmap (§2.2-C) wrote: render-request-v3 is checked as an exact key set on both sides
(`set(value) != _V3_FIELDS`, `src/ai_clipper/render_queue.py:548`; `KEYS`,
`web/lib/clip-renders.mjs:57`), so a new request key would make a rollback image refuse every new
request. This deviation (rombak 01 §6.2, §12 item 1; 00 §11 #1) needs the owner's approval before
this contract is merged.

### `job.json` (additive; `queue.version` stays 1)

| Field | Shape | Written by | Rule |
|---|---|---|---|
| `ownerId` | UUID v4 (`users.id`) | `POST /api/jobs`, `failedAdmissionRecord` (owner from a v3 reservation; a v2 reservation writes no owner), an ingest agent that creates a job | Set at creation; changed only by an admin transfer under the queue lock (audit `job.transferred`) |
| `fairnessKey` | `^fk1_[0-9a-f]{16}$` | the same writers, and the transfer | `"fk1_" + hex(HMAC-SHA256(K_fair, ownerId))[0:16]`, `K_fair = HKDF-SHA256(POTONGIN_SETTINGS_SECRET, salt "potongin", info "fairness-v1")` |
| `queue.firstClaimedAt` | ISO UTC ms | `web/lib/primary-job-queue.mjs` | Written on the first claim, kept until a terminal status; an old image drops it when it rewrites `queue` (fairness only, never correctness) |
| `limits.maxSourceSeconds` | integer > 0 | `POST /api/jobs` (Fase 6) | The owner's effective source limit at creation (rombak 02 §11.2); a job without it uses the global env |

- No `job.json` is rewritten at boot. `effectiveOwnerId(job, bootstrapOwnerId)`
  (`web/lib/job-ownership.mjs`) = `job.ownerId` when it is a UUID string, else the bootstrap
  owner (`meta.bootstrap_owner_id`). The optional `web/scripts/multiuser-migrate.mjs
  --dry-run|--apply` fills both fields for terminal jobs under the queue lock.
- `serializePublicJob` (`web/lib/jobs.mjs`) drops `ownerId` and `fairnessKey` from every answer.
- Python never reads `ownerId`, never opens the DB and never computes the HMAC; it sees only the
  opaque `fairnessKey` and cache paths built from it (§5.64).

### Ownership on the routes

- `readOwnedJob(jobsRoot, id, principal)` throws `JobOwnershipNotFound` for a bad id, a missing or
  unreadable `job.json` (`O_NOFOLLOW`, regular file) and a job whose effective owner is not the
  principal. Admins are not excepted: an admin acts on other people's jobs only through the
  audited transfer, delete and cancel routes (rombak 02 §9.5).
- "Missing" and "someone else's" answer one identical 404: status, body byte for byte and every
  header but `date`, with no Python spawned (rombak 02 §0 rule 1, §7.4). Each route keeps the
  404 builder it uses today and gains `code`/`messageId` additively (§5.65); new routes use the
  presets `job`, `edit` and `web` of rombak 02 §7.4.
- Lists are filtered by owner: `GET /api/jobs`, `GET /api/clips`, the member storage status and
  `listJobClips`.

### Primary queue (`claimNextJob({…, policy})`)

The queue module stays DB-free; the policy is injected. No policy = today's FIFO by `createdAt`.
The multi-user primary-worker passes the fair policy (rombak 02 §10.3): drop jobs whose owner is
disabled (held `owner_disabled`) and owners already at `max_running_jobs`; per owner
`lastServedAt` = the latest `queue.firstClaimedAt` among its non-terminal jobs (none = −∞); the
owner with the smallest value goes first (ties: the oldest job), FIFO within the owner.
`GET /api/jobs/[id]` adds `queue.position` (1-based, by the fair policy) and `queue.etaSeconds`
(`null` below 5 finished samples).

Admission reservations `.primary-reservations/<id>.json` gain `version: 3` =
`RESERVATION_V2_KEYS + ["ownerId"]` in two releases: R1 reads v1, v2 and v3 and still writes v2;
R2 writes v3. A rollback to before R1 is forbidden while a v3 reservation is alive (at most
`RESERVATION_STALE_MS`, 60 minutes).

### Render-worker (`src/ai_clipper/render_worker.py run_one`)

Today `run_one` takes the first job by name (`_job_directories`). It becomes:

```
candidates = jobs that have analysis/render-requests/ (the check run_one makes today)
key(job)   = job.json fairnessKey when it matches ^fk1_[0-9a-f]{16}$, else "legacy"
             (job.json read with a 2 MiB bound, as render_queue.py reads it; any read error → "legacy")
pick the key with the smallest last_served[key] (never served = 0; ties → key order);
within a key: job-name order, claim_next(job) as today; None → next job, then next key
last_served[key] = time.monotonic() on a successful claim (in memory; a restart resets it)
```

The render request file and its protocol do not change.

### Isolation

- Only `app`, `primary-worker` and `social-worker` mount `/control` and receive
  `POTONGIN_DB_PATH`; the render-worker and `pot-provider` get neither (rombak 01 §1.3). Checked
  on `compose.yaml` mounts and env by `web/tests/deploy-env-contract.test.mjs`.
- Child processes (`run-job.mjs`, `python-cli.mjs`, `editor-ai.mjs`, `clip-text-api.mjs`) never
  receive `POTONGIN_DB_PATH`, `POTONGIN_SETTINGS_SECRET`, `APP_SESSION_SECRET` or `NODE_OPTIONS`
  (`web/tests/security-child-env.test.mjs`, extended).
- Python in the `app` and `primary-worker` containers can physically see `/control`. The guarantee
  is the env rule above plus a static check, `tests/test_control_plane_isolation.py`: no
  `import sqlite3`, `"/control"`, `POTONGIN_DB_PATH` or `potongin.sqlite` under
  `src/ai_clipper/`. It is not a mount boundary.
- A module whose stderr a parent parses (`web/scripts/render-storage-admission.mjs`) never imports
  `web/lib/db/*` (rombak 01 §8.3, `web/tests/sqlite-import-boundary.test.mjs`).

### Rollback

An image without multi-user ignores the DB, `ownerId`, `fairnessKey` and `queue.firstClaimedAt`;
every job is visible to the `APP_*` login again. DB migrations are additive only (rombak 01 §3.2).

### Gates

`tests/test_render_worker_fairness.py` (A has 10 requests, B one later: the second claim is B; no
key and a malformed key are `legacy`; name order within a key), `web/tests/job-ownership.test.mjs`
(effective owner, serializer drops both fields, `fairnessKeyFor` vectors),
`web/tests/queue-fairness.test.mjs` (fair policy; the existing `primary-job-queue` tests stay
unchanged), the v3 reservation tests both ways in `web/tests/reservation-v3.test.mjs` (rombak 02
§13) plus the cases added to `web/tests/primary-job-queue.test.mjs` (rombak 01 §6.3), the
`ownership-matrix` and `route-guard-coverage` gates of rombak 02 §13.

## 5.60 Posting to social platforms: publish runs (2026-10-24)

Contract only; no code exists. Owner: rombak 03 §2–§12 (behaviour, states, API, error codes);
DDL in rombak 01 §4.3 (`0003-social-base`) and §4.5 (`0005-posts`). Built in Fase 6 (SOS-M1, the
tables and the worker, feature off) and Fase 8 (SOS-M2 … M6). UI words: **Terbitkan** (action),
**Terbit** (state); screens rombak 05 §5, §6.5–§6.7.

### Flag and process

- `POTONGIN_SOCIAL` = `off` (default) | `admin` | `on` (app, social-worker). `off`, or `admin` for a
  member: every `/api/social/**` route and `/api/jobs/:id/clips/:clipId/posts` answer the identical
  404 of their family (§5.59), the nav entry is hidden, the worker only heartbeats; data stays.
- Only `social-worker` (`web/scripts/social-worker.mjs`) uploads and refreshes tokens. `app` starts
  OAuth, exchanges the code once in the callback, revokes on disconnect and reads the DB. No
  network I/O inside a SQLite transaction: short claim/CAS, network, short CAS.
- The worker mounts `/control` and only the `social` subpath of `clipper_data` (`/data/social`);
  its env is an allowlist (`NODE_ENV`, `TZ`, `POTONGIN_DB_PATH`, `POTONGIN_SETTINGS_SECRET`,
  `POTONGIN_SETTINGS_DIR`, `POTONGIN_PUBLIC_URL`, `POTONGIN_SOCIAL`, `SOCIAL_*`). It never
  migrates; `requireSchema` retries for 60 s, then exits 78.
- Two releases (rombak 03 §12.2): R0 ships the worker in the image without a compose service; R1
  adds the service. An image older than R0 under an R1 compose runs `--scale social-worker=0`.

### Tables (clean-room names)

`social_connections` (one row per connected account; disconnect deletes the row),
`oauth_pending` (state, PKCE verifier box, 10 minutes), `social_quota` (unit ledger per
provider, bucket, window, purpose), `publish_runs` (one upload to one account), and `posts`
(§5.61). Enum values are frozen JS constants in their owner modules (`RUN_STATES`, `RUN_HOLDS`,
`CONNECTION_STATUSES` in `web/lib/social/store.mjs`), not SQL `CHECK … IN`.

### Provider interface (`web/lib/social/providers/<id>.mjs`)

One pure module per platform (`youtube`, `tiktok`, `instagram`), registered in `registry.mjs`;
all I/O through an injected `http`, `now` injected, no DB. Members: `id`, `scopes`, `pkce`,
`authorizeUrl`, `exchangeCode`, `refresh`, `revoke`, `describe`, `limits`, `validate` (pure, used
by app and worker), `begin`, `send`, `finish`, `poll`, `reconcile`, `readPostStats`, `statsCost`,
`statsBatch`. Every member throws a `SocialError {code, class, retryAfterMs?, detail?}` only. The
JSDoc of rombak 03 §5.1 is the shape, pinned by `web/tests/social-provider-contract.test.mjs`.
TikTok uses `FILE_UPLOAD` only; Instagram uses the resumable upload, with the public media URL
(`GET /api/social/media/:token`) only as the fallback SOS-M0 allows. Platform numbers marked [V]
in rombak 03 are working values until `docs/operations/SOSMED.md` cites the official source; the
code constants follow SOSMED.md.

### Run states (`publish_runs.state`)

`scheduled` → `claimed` → `uploading` → `processing` → `published`, plus the terminal `failed`,
`cancelled` and `maybe_sent`. The legal transitions are exactly T1–T12 of rombak 03 §6.1; each is
one `UPDATE … WHERE id=? AND state IN (…) [AND fence=? AND lease_token=?]` checking
`changes === 1`, anything else throws `IllegalTransition`. `hold` ∈ `reauth` | `quota` | `rate`.

- Claim: one run per free slot (`SOCIAL_UPLOAD_CONCURRENCY`, 1–4, default 2), at most one
  `claimed|uploading` run per connection, lease 120 s renewed every 30 s and after every chunk,
  `fence + 1` per claim. A failed renewal stops work on that run at once. A run taken over from
  an expired lease goes through `reconcile`, never `begin`.
- `checkpoint_json` = `{phase: none|session|sent|committed, bytesSent, remoteId?, claimedAt,
  limitsSeen?, cancelRequested?}`, written by CAS after every step and chunk. Upload session URLs
  are never in it: they live sealed in `publish_runs.upload_box` (purpose `oauth-token`, AAD
  `run:<runId>\0upload`) and are never sent to a client.
- Classes: retryable (backoff 1, 5, 15, 60, 180 minutes ±20 %; the fifth failure is
  `social_attempts_exhausted`), deferred (`attempts` unchanged, `hold` set, longer than 7 days
  after `scheduled_at` → `social_deferred_too_long`), reauth (`hold='reauth'`; over 7 days →
  `social_reauth_expired`), permanent, unknown outcome (`maybe_sent`, never retried by itself).
- Exactly once: the remote id or session is stored before the first byte, `reconcile` runs before
  any step is repeated, and `maybe_sent` is the answer when it cannot be sure. `begin` is never
  called twice for a run whose checkpoint is `sent` or `committed`.

### Idempotency, media, deletion

- `POST /api/social/posts` requires `Idempotency-Key` (UUID v4). The same key with the same
  canonical body (`request_sha256`) answers the existing runs (200); with another body 409
  `social_idempotency_conflict`. Keys never expire.
- The media is always a completed export: `media = {kind: "export", renderId}` (default: the
  clip's newest completed export). No completed export → 409 `social_media_unavailable` with
  `params.needsExport = true`; the drawer exports through the existing renders route and retries
  with the same key. `app` pins the file at `/data/social/media/<runId>.mp4` (hard link; `EXDEV`
  → copy + fsync), reads its duration from `moov/mvhd` in JS (no ffprobe in `app`). The worker
  sweeps pins: 1 hour after `published`, `SOCIAL_PIN_KEEP_DAYS` (default 7) for `failed`,
  `cancelled` and `maybe_sent`; only `<uuid>.mp4` names inside `realpath(/data/social/media)`.
- Deleting a job calls `cancelRunsForJob(ownerId, jobId)` before `requestJobDeletion` (scheduled
  runs → `cancelled`, running ones get `cancelRequested`); deleting a derived clip calls
  `cancelRunsForClip`. Published `posts` stay.
- Tokens are sealed per user (`sealing.mjs` v2, purpose `oauth-token`, rombak 02 §9.2) and never
  appear in an answer, a log, an error, `job.json` or argv; `web/lib/social/redact.mjs` filters
  them. A changed `POTONGIN_SETTINGS_SECRET` makes connections `reauth_required`.

### API and errors

Routes, bodies and the `Run` shape: rombak 03 §9.1 (`/api/social/providers`, `connect`,
`callback`, `connections`, `posts`, `cancel`, `retry`, `mark-published`, `meta/deauthorize`,
`meta/data-deletion`, `media/:token`; `/api/settings/social-apps` for the admin). Guards:
`secureRoute` of rombak 02 §7.2, mutation rate limit 30/min per user. Error codes are the
`social_*` list of rombak 03 §8, flat shape of §5.65 with `messageId = "social.<code>"`. A run's
error is `{code, messageId, params?}` from `error_code` + `error_params_json`; `error_detail`
(redacted platform text) never reaches a member.

### Gates

`web/tests/social-store.test.mjs` (T1–T12 and every illegal pair, claim, fence, lease),
`social-provider-contract`, `social-scheduler`, `social-tokens`, `social-media`, `social-caps`,
`social-redact`, `social-fake-origin-gate` (`SOCIAL_FAKE_ORIGIN` refused in a production-shaped
env), `social-job-delete`, `social-routes`, `web/tests/social-crash-matrix.test.mjs` on
`web/tests/support/fake-social-platform.mjs`, the `POTONGIN_SOCIAL=off` drill and
`web/e2e/social-publish.spec.mjs` (rombak 03 §12.3, §16).

## 5.61 Post registry and metric snapshots (2026-10-24)

Contract only; no code exists. Owner: rombak 03 §4.2, §10.4–§10.6, §13.2–§13.3, §14; DDL in
rombak 01 §4.5 (`posts`) and §4.7 (`metric_*`). Built in Fase 8 (SOS-M3a, the registry) and Fase 9
(FB-M1 …, metrics).

### The registry (`posts`, `web/lib/post-registry.mjs`)

One row = one clip posted once to one platform account, shared by publishing (§5.60) and
performance feedback (§5.62). `createPost` is the only writer.

- `origin` ∈ `publish` | `csv` | `manual` | `agent` (`POST_ORIGINS`). A `publish` row is created
  in the same transaction that makes its run `published` (or "Sudah terbit" from `maybe_sent`):
  one run → at most one post (`post_id UNIQUE`). A failed run leaves no post; "Coba lagi" is a new
  run. `agent` never creates a post, it only adds snapshots to an existing one.
- `clip_kind` ∈ `pipeline` | `derived`. A derived clip is recognised from its `listJobClips` entry
  (`entry.derived !== null`), never from the shape of its id; it is stored with
  `selection_keys_json = NULL` and `excluded_reason = 'derived'`.
- `selection_keys_json` = `selectionKeysFor(clip, rules)` (§5.62) from the engine's fields, not
  the user's edited text; `NULL` when excluded. `excluded_reason` ∈ `derived` | `edited_far` |
  `manual_exclude` | NULL.
- `packaging_json` = `snapshotClipPackaging(job, clip, source)` at posting time (title, hook text,
  description, hashtags, archetype, source span, layout); `posted_features_json` is for Analitik
  only and never enters a profile.
- `edit_class` ∈ `none` | `light` | `far` | `unknown` (`EDIT_CLASSES`), computed when posting by
  a new owner-agnostic Python op `edit_distance` (`src/ai_clipper/edit_v2/edit_distance.py`,
  stdlib; dispatched through `edit_v2.api`): `none` when the export was `completed_by='seed'` or
  the document equals its seed; `far` when the kept source overlap with the seed is below
  `editFarOverlap` (0.8) or the normalised hook changed; else `light`; a failed or timed-out op
  (10 s) is `unknown`. `csv` and `manual` are always `unknown`.
- `error_code` on a post: `social_processing_rejected` (YouTube rejected after publishing; the run
  stays `published`) or `social_remote_missing` (3 failed metric reads).
- Disconnecting an account sets `posts.connection_id` to NULL; the post stays.

### Snapshots (`metric_snapshots`, `web/lib/performance-store.mjs`)

- Append-only. `source` ∈ `api` | `csv` | `manual` | `agent` (`SNAPSHOT_SOURCES`). The only updates
  are the YouTube collapse below and soft delete (`deleted_at`), enforced by the triggers of rombak
  01 §4.7.
- Refresh (`web/lib/metrics-refresh.mjs`, social-worker maintenance loop, every 10 minutes): due
  intervals by post age 6 h (< 48 h), 24 h (2–8 d), 72 h (8–35 d), 7 d (35–90 d), then stopped;
  calls are budgeted through `social_quota` before each batch (`statsCost`, `statsBatch`). An id
  missing 3 times stops its refresh and marks the post `social_remote_missing`.
- YouTube collapse (pending the SOS-M0 policy check): raw API values not refreshed for 30 days
  become `aggregate_json = {"relViews": …}` with the numbers set to NULL and `collapsed_at` set.
  If derived aggregates are not allowed, the step becomes a hard delete with no schema change.
  CSV, manual and agent snapshots are never removed automatically. Disconnecting an account
  hard-deletes its `api` snapshots and their horizons.
- Horizons (`metric_horizons`, `h` ∈ `1d` | `7d` | `30d`): `exact` (a snapshot in
  `[T, T + 0.25·h]`), `interpolated` (linear between snapshots at most `h` apart), else `missing`.
  `rel_views` = views ÷ the median of the same horizon over the same account (at least 5 posts,
  else NULL). Horizons are a cache: deleted when a snapshot arrives, rebuilt lazily, fully
  rebuildable (`rebuildHorizons(ownerId)`).

### Import and manual entry

CSV import (≤ 2 MiB, ≤ 5000 rows, UTF-8, `,` or `;`) previews into `metric_imports` and
`metric_import_rows`, matches rows to the user's posts by `(provider, external_id)` then by
normalised URL, lets the user pair or skip the rest, and commits in one transaction. The template
header is `platform,url,external_id,posted_at,captured_at,views,likes,comments,shares,saves`
(`resources/performance/template.csv`); platform export profiles
(`resources/performance/csv-profiles.v1.json`) wait for the owner's sample files. Numbers are
integers ≥ 0; decimals and abbreviations are a row problem (`performance_metric_invalid`).

### Privacy

Every query filters `owner_id = ?` (`web/tests/db-owner-scope.test.mjs`); an admin sees only their
own data. API routes: rombak 03 §9.2–§9.3 (`/api/analytics/**`, `/api/posts/**`,
`/api/performance/**`); error codes `performance_*` (rombak 03 §8, §14.4).

### Gates

`web/tests/post-registry.test.mjs` (`createPost`, NULL keys for derived and edited-far clips,
unique external id), `social-derived-clip`, `metrics-refresh` (tiers, batching, budget, an id
missing 3 times), `metric-horizons` (exact, interpolated, missing, account median, rebuild),
`metrics-csv` (delimiters, BOM, numbers, dates, duplicates, size), `analytics-view`,
`performance-routes`, `tests/test_edit_distance.py`, `db-owner-scope` (rombak 03 §16).

## 5.62 Performance profile and the selection tie-breaker (2026-10-24)

Contract only; no code exists. Owner: rombak 03 §13 (rules, profile, injection) and §3 (flags);
the tables it reads are §5.61, DDL in rombak 01 §4.3, §4.5 and §4.7 (not repeated here). The rules
file is frozen in Fase 0 (FB-M0); the rest is Fase 9 (FB-M1 … M6).

### Flags

`POTONGIN_PERFORMANCE` = `off` (default) | `on` (app, primary-worker): `off` answers the
performance routes with the identical 404, writes no profile and passes no profile to Python.
`POTONGIN_PERF_MIN_POSTS` (integer ≥ 20, default 20; lower refuses to start; a change needs a
re-gate) and `POTONGIN_PERF_HORIZON` (`7d` default, `1d`, `30d`). The per-user switch is
`users.perf_use_in_selection` (default 0; UI "Pakai di pemilihan klip").

### `resources/performance/rules.v1.json`

`rulesId: "rules.v1"`; dimensions `archetype`, `durationBucket`, `hookForm`; the archetype list
equals `ARCHETYPES` in `src/ai_clipper/selection_types.py` as a set (`ARCHETYPES` is a frozenset;
the file's order is the only order); duration buckets `[0,20)`, `[20,30)`, `[30,45)`, `[45,60)`,
`[60,∞)` on `sourceEnd − sourceStart` without the cold open; `hookForm` decided in the order
`none` (empty), `question` (contains `?`), `number` (contains `\p{Nd}`), `quote` (starts with one of
the `quoteOpeners`), else `statement`; `minPosts 20`, `minGroup 5`, `minAccountPosts 5`,
`shrinkK 5`, `liftFull 0.25`, `capPerDimension 0.2`, `capTotal 0.4`, `windowDays 180`,
`staleDays 14`, `editFarOverlap 0.8`. The caps are in Selection V3's 0–10 rank scale (the trend
boost is 0.3 on the same scale). Changing any value is a new `rulesId`.

Selection keys are computed twice with one table of cases: JS `selectionKeysFor(clip, rules)`
(`web/lib/performance-keys.mjs`) and Python `selection_keys_json(archetype, start, end,
hook_text, rules)` (`src/ai_clipper/performance_profile.py`), both checked against
`tests/fixtures/performance/keys.json`.

### The profile (`web/lib/performance-profile.mjs`)

Input: the user's posts not deleted, with selection keys, not excluded, posted within
`windowDays`, with `rel_views` at the configured horizon. Fewer than
`max(minPosts, POTONGIN_PERF_MIN_POSTS)` → `collecting`, no profile. Otherwise per post
`l = ln(max(rel_views, 0.01))`; per dimension value with `n ≥ minGroup`: `μ = Σl / (n + shrinkK)`,
`lift = e^μ − 1`, `boost = round2(capPerDimension × clamp(lift / liftFull, 0, 1))`; only positive
boosts are written. Stale (every post's newest snapshot older than `staleDays`) keeps the profile
in use and shows "Data lama". No table: computed deterministically, cached in memory per
`(owner_id, max(metric_snapshots.id))`.

### The profile snapshot (`<job>/analysis/performance-profile.json`)

```json
{
  "version": "performance-profile-v1",
  "rulesId": "rules.v1",
  "horizon": "7d",
  "posts": 34,
  "boosts": {
    "archetype": {"humor": 0.2, "practical_tip": 0.08},
    "durationBucket": {"20-30": 0.12},
    "hookForm": {"question": 0.05}
  }
}
```

- Written by `preparePerformanceProfile(job)` in `web/scripts/primary-worker.mjs` after
  `claimNextJob` and before `run-job.mjs` is spawned, only when the flag is `on`, the effective
  owner's switch is 1 and the state is `ready` or `stale`; otherwise an earlier file is removed.
  `run-job.mjs` never opens the DB: it only checks that the file exists and then passes
  `--performance-profile <absolute path>` (the content never goes into argv).
- No user id, post id, URL or raw number in the file.
- `performance_profile.load_profile(path)` is strict (exact keys, `rulesId` equals the installed
  rules, every value `0 ≤ x ≤ capPerDimension`). An invalid file is ignored with the warning
  `performance_profile_invalid`; the job runs.

### Injection in `selection_v3.py`

- `select_clips_v3(..., performance=None)`; `_Candidate.perf = min(capTotal, Σ boosts)`, filled
  only with a profile.
- `_boosted(candidates, value=_trend_boost)` replaces every use of `.boost` by `value(…)`: all
  four, the early return (`any(item.boost …)`), the `if item.boost:` guard, `item.rank_value +
  item.boost` and `above.rank_value + above.boost`. Left on `.boost`, the guard keeps a candidate
  with `perf > 0` and no trend boost in place, so the profile does nothing without a trend. The
  rule that a candidate never passes one whose own `rank_value` is higher is unchanged.
  `_ordered(..., value=)` passes `value` to both of its `_boosted` calls; `select_clips_v3` gives
  `value=_order_boost` (`boost + perf`) only with a profile. `_focus_floors` keeps the trend-only
  boost.
- `score`, the five sub-scores, reasons, packaging and the LLM prompt do not change. A selected
  candidate that moved up because of `perf` gets the reason code `perf_order` (§5.65) and the
  manifest gets an optional `performance: {rulesId, horizon, posts, moved}` block, written only
  with a profile. Without a profile the output is byte-identical (`SelectorContext.performance`
  defaults to None in `src/ai_clipper/benchmark.py`).

### `ProfileStatus` (`GET /api/analytics/feedback`, `GET /api/settings/performance`)

`{state: off|collecting|ready|stale, useInSelection, posts, needed, horizon, excluded:
{editedFar, derived, noMetrics}, top: [{dimension, key, ratio, n}], updatedAt}`. Turning the
switch on while `collecting` → 422 `performance_profile_collecting`.

### Gates

`tests/test_performance_profile.py`, `web/tests/performance-profile.test.mjs` (the formulas with
hand numbers, caps, `collecting` and `stale`), `performance-profile-prepare` (written only when
the conditions hold, an old file removed), `web/tests/performance-keys-parity.test.mjs` (shared key
table, archetype set parity with `ARCHETYPES`), `tests/test_selection_v3_performance.py` (no
profile = identical output; near-ties move only within `[own, own + boost)`; focus floors
unchanged), the hook-form drift check on the gold episodes (≤ 2 %), the `POTONGIN_PERFORMANCE=off`
drill (rombak 03 §12.3, §15.2).

## 5.63 Automatic layout: the shot plan and `layout.ranges` (2026-10-24)

Contract only; no code exists. Owner: rombak 04 §A5–§A7 (this section restates its §A6 for the
document; on a difference 04 wins). Minor-0 amendment: no new `schema_minor`; an older server
refuses a new document with `unknown_key` or `range_invalid` (§3.8). The PR that ships the
validator (RF-M2) adds the §3.8 amendment bullet. `RENDER_SEMANTICS` stays 2. Built in Fase 5–7
(RF-M1 … RF-M6) and Fase 11 (F4b, the per-shot commands). Flag `POTONGIN_AUTO_REFRAME` gates
creation only (§A8 of rombak 04); a stored `auto` document always renders.

### Shot plan file (`src/ai_clipper/edit_v2/shots.py`, stdlib)

`<clip_dir>/shots.<sha16>.json`: canonical JSON (`source_info.canonical_json`), named from the
sha256 of its bytes (the pattern of `camera.camera_file_name`), ≤ 256 KiB, ≤ 200 shots.

```json
{
  "schema": "potongin.shot-plan/1",
  "rules_id": "<sha16 of resources/reframe/rules.v1.json>",
  "source_content_sha256": "<hex>",
  "camera_sha256": "<hex>",
  "window_ms": [1203040, 1323040],
  "fps": {"num": 30000, "den": 1001},
  "cut_source": "shot_cuts",
  "cuts_sf": [36101, 36488],
  "split": null,
  "shots": [{"in_sf": 36057, "out_sf": 36101, "mode": "camera", "reason": "rf_face", "evidence": {}}],
  "ranges": [{"in_sf": 36057, "out_sf": 36101, "mode": "camera"}]
}
```

- `shots` are the original shot bounds (the editor's shot strip); `ranges` the merged result that
  is copied into the document. `reason` is a `rf_*` code (`rf_no_face`, `rf_two_speakers`,
  `rf_group_wide`, `rf_small_face`, `rf_centred`, `rf_face`, `rf_short_merged`); only `rf_no_face`
  is ever shown ("Tanpa wajah").
- `split` is null or `{top_pm, top: {zoom_pm}, bottom: {zoom_pm}}` (one per clip); a `split` range
  carries `split_xy: {top: {x_e5, y_e5}, bottom: {x_e5, y_e5}}`.
- `shots.read_shot_plan(path)` is strict: a symlink, a name that does not match the content, an
  unknown key, a wrong type or a bad partition → `AnalysisMissing("analysis_missing",
  ref="shots")`. Its strictness follows `media_features._strict_object` but is written again in
  `edit_v2`, which stays stdlib-only.
- `resources/reframe/rules.v1.json` holds integer thresholds set by the dev-split sweep (rombak
  04 §A9), never by hand; `rules_id` = 16 hex of the sha256 of its canonical bytes.

### Document paths (amendment of §3.3)

| Path | Value | Rule |
|---|---|---|
| `layout.default.mode` | adds `auto` | `auto` requires `layout.ranges` and `base.shots`; `no_face` still applies to `camera` ranges (§5.40) |
| `layout.ranges` | optional; 1–200 `{in_sf, out_sf, mode, origin, split_xy?}` | V1–V9 below; a non-auto seed never writes it |
| `base.shots` | `{sha256}` | Required when `default.mode = auto`; names `shots.<sha16>.json`; missing → `analysis_missing` (`ref="shots"`) |
| `layout.split` | also allowed with `auto` | Required when a `split` range exists; only `top_pm`, `top.zoom_pm`, `bottom.zoom_pm` are used, x/y come from each range's `split_xy` |

### Validation (`doc.py _Validator`)

| # | Rule | Code, path |
|---|---|---|
| V1 | `ranges` partition `window_sf = [sf_floor(window_ms[0]), sf_ceil(window_ms[1])]`: first starts at `window_sf[0]`, last ends at `window_sf[1]`, contiguous, no overlap, `in_sf < out_sf` | `range_invalid`, `/layout/ranges/<i>` |
| V2 | Canonical: no two neighbours with equal `(mode, origin, split_xy)` | `range_invalid`, `/layout/ranges/<i>` |
| V3 | `mode` ∈ {`camera`, `fill_center`, `fit_blur`}; `split` only with `origin = "auto"` and `AUTO_SPLIT` (new in `edit_v2/__init__.py`, False until the RF-M2 spike passes) | `range_invalid`; `split` while `AUTO_SPLIT` is False → `op_disabled` |
| V4 | `origin` ∈ {`auto`, `user`} | `range_invalid` |
| V5 | `default.mode = split` with `ranges` | `range_invalid`, `/layout/ranges` |
| V6 | `default.mode = auto` without `ranges` | `range_invalid`, `/layout/ranges` |
| V7 | `default.mode` ∈ {`camera`, `fill_center`, `fit_blur`} with `ranges`: every `origin:"auto"` range has `mode = default.mode` (only user ranges differ) | `range_invalid` |
| V8 | `layout.keyframes` with `ranges` (default, can be changed: forbidden in v1, F4b included; relaxing it for `camera` ranges is a separate §5.63 amendment) | `range_invalid`, `/layout/keyframes` |
| V9 | `split_xy` only on `split` ranges; values 0–100000 | `range_invalid` |

`doc.py _ROOT` gains `base.shots = _keys("sha256")` and `layout.ranges`; `_LAYOUT_MODES[0]` gains
`"auto"`.

### Canonical form and re-analysis (Python and JS, same vectors)

- `canonical_ranges(ranges)` merges equal neighbours; when `default.mode ≠ auto` and every range
  is `origin:"auto"`, `ranges` is dropped. A document without `ranges` compiles byte-identically
  to today (graph, plan sha and `plate_key` pinned by `tests/test_edit_v2_compile.py` and
  `tests/test_edit_v2_plates.py`).
- `shots.merge_user_ranges(new_auto, old)` (mirror `web/lib/editor/shots.mjs`): start from the
  new auto partition; for each old `origin:"user"` range in `in_sf` order, clip it to `window_sf`,
  drop it when empty, else overwrite the partition on `[in_sf, out_sf)` (auto ranges cut at its
  edges); then `canonical_ranges`. A user range is never overwritten by a new analysis. Vectors:
  `tests/fixtures/edit_v2/shot-vectors.json` (user range inside a shot, across a new shot bound,
  outside the new window, a shrinking window).

### Apply-all (§5.53)

`apply_all.copied_part(doc, "layout")` also drops `ranges` (so `split_xy` goes with it);
`layout.split` is still copied. `with_part` for a source with `default.mode = "auto"`: a target
whose shot plan is ready gets the auto ranges of its own plan, its old user ranges through
`merge_user_ranges`, and its own `base.shots`, in one revision. A target without a shot plan is
not changed yet: the batch record lists it `pending_analysis` (not skipped), the client calls
`POST …/clips/<target>/prepare {layout: "auto"}` and applies the revision once `shots` is
`ready`; a pending entry survives a closed tab (`draft-store.mjs`); a failed analysis is recorded
`failed` with `analysis_missing`.

### Editor commands (`web/lib/editor/commands.mjs`, merge key `layout`)

| Command | Payload | Effect |
|---|---|---|
| `SetLayout` (exists) | adds `{mode: "auto"}` | Needs a shot plan; without one the panel starts `prepare` and sends the command when ready |
| `SetShotMode` | `{in_sf, out_sf, mode}` | That shot becomes an `origin:"user"` range |
| `ResetShot` | `{in_sf, out_sf}` | The user range there goes back to the shot plan's auto range; none there → no-op |
| `ResetAllShots` | `{}` | Every user range is removed ("Kembali ke otomatis"); none → no-op |

`[in_sf, out_sf)` must equal one entry of the loaded plan's `shots` exactly (original shot bounds,
not a merged range); no match, no loaded plan or outside `window_sf` → `CommandRejected("shot_not_found")`.
A mode outside {`camera`, `fill_center`, `fit_blur`}, or a document with `default.mode = split` →
`CommandRejected("shot_mode_invalid")`. Every command ends with `canonical_ranges`. Both codes join
`COMMAND_MESSAGES` (`messageId` `editor.<code>`, §5.65).

### Plan, compiler and keys

- `RenderPlan.layout_ranges` (new property, tuples `(in_sf, out_sf, mode)`, `()` without
  `layout.ranges`; named so because `_Compiler.layout` already takes piece `ranges`). `plan_sha256`
  covers it only when it is not empty. `build_plan` uses the camera plan for `camera` and `auto`;
  `auto` with a `camera` range and no camera plan → `AnalysisMissing(ref="camera")`; the `no_face`
  warning counts `camera`-range frames only. `RenderPlan.shots_for(sf) -> str` answers the mode at
  a frame without building a graph.
- `_Compiler.layout` gets an `auto` branch before the `keyframes` branch that reuses the §5.40
  fallback chain: one fit-blur chain with per-frame crop and fallback switches, so the number of
  filter contexts is the same for 1, 8 or 48 ranges. `fill_center` frames are a camera crop at
  `centre_x`; the RF-M2 spike must show md5-identical frames to the pure `fill_center` chain
  (P-FRAME) or the compiler adds a y switch, still constant in size. Split ranges only after the
  spike of rombak 04 §A7.2 passes (`AUTO_SPLIT = True`).
- `plates.plate_key` gains `shots_sha256` only when `default.mode = auto` or `ranges` exist; every
  non-auto key is unchanged.
- Rollback below the release-1 floor: `scripts/ops/auto_layout_downgrade.py --jobs-root <path>
  [--apply] [--job <uuid>]` writes `fit_blur` revisions without `ranges`, `base.shots` and
  `split_xy` (`audit.last_command = "Downgrade"`) and sets `options.renderMode` back to
  `"fit-blur"`; existing automatic files stay.

### Gates

`tests/test_edit_v2_doc.py` (V1–V9 with their paths), `tests/test_edit_v2_shots.py` (decision
rules, short-shot merge, canonical form, `merge_user_ranges`, shot plan round trip), `tests/test_edit_v2_apply_all.py` (ranges not copied, auto
source → target ranges, `pending_analysis`), `web/tests/editor-apply-all.test.mjs`, the JS mirror
of the shot vectors, the non-auto pins in `test_edit_v2_compile.py` and `test_edit_v2_plates.py`,
`tests/test_auto_layout_downgrade.py`, and the RF-M6 gates P-FRAME, P-PLATE, P-JOIN-B, G-DET,
PF-RENDER, PF-PIPELINE (rombak 04 §A10).

## 5.64 Link sources and the download cache (2026-10-24)

Contract only; no code exists. Owner: rombak 04 §B1–§B6, §B13 (and 02 §11.4 for the URL rules
built in MU-M4b). Built in Fase 6 (MU-M4b, YouTube only) and Fase 7 (FETCH-M1 … M10).

### `job.source`

| Shape | Written | Readers |
|---|---|---|
| `{type: "youtube", url}` | YouTube, always (this release and every later one) | old and new images |
| `{type: "link", platform: "twitch"\|"kick", url, mediaId}` | Twitch or Kick only, and only in the release after the one that can read it (R2) | new images |
| `{type: "upload", name, size}` | unchanged | all |

- A new YouTube job keeps storing the `normalizeYouTubeUrl` result in `source.url`; the canonical
  URL is used only for yt-dlp argv and `sourceKey`.
- Every check of `type === "youtube"` on `job.source` in `web/` becomes `isLinkSource(job.source)`
  or stays with a written reason; `web/tests/source-type-guard.test.mjs` fails on any new match
  outside its allowlist.

### URL parsing (`web/lib/source-url.mjs`, `src/ai_clipper/fetch/platforms.py`)

`parseSourceUrl(text, {platforms = ["youtube"]})` → `{platform, kind: video|clip|vod, mediaId,
url, sourceKey}` or `SourceUrlError(code)`; Python `parse_source_url(text, platforms)` has the
same shape and codes, both read the ≥ 60 cases of `tests/fixtures/fetch/urls.json`. Rules: `https`
(an `http` URL is upgraded), no userinfo, port empty or 443, exact host match, ≤ 2048 characters,
no control or space characters. `assertPublicHost` runs in `app` on `POST /api/jobs` and again in
the worker right before preflight; a private, loopback, link-local, CGNAT, ULA, mapped-private,
multicast or `0.0.0.0/8` address → `source_private_address`. `sourceKey` = `"<platform>:<mediaId>"`.

### Worker defences

yt-dlp argv always has `--ignore-config`, `--no-playlist`, `--use-extractors <names>`,
`--max-filesize <MAX_UPLOAD_BYTES>` and `--js-runtimes node`. Extractor names are locked by
FETCH-M0 against the pinned yt-dlp and pinned in fixtures. The downloaded file passes the same
probe as an upload (`media_probe`); an audio-only file must have exactly one audio stream and no
video. The downloader env (`downloaderEnv`) also drops `POTONGIN_DB_PATH`.

### Preflight (`input/.fetch/preflight.json`, 0600)

`yt-dlp … --skip-download --dump-single-json` (45 s, stdout ≤ 8 MiB) parsed by
`python -m ai_clipper.fetch preflight`. Schema `potongin.fetch-preflight/1` with `platform`,
`mediaId`, `sourceKey`, `durationMs`, `live`, `availability`, `ageLimit`, `audio {formatId, ext,
acodec, language, original}`, `video {formatId, height, fps}`, `filesizeApprox`, `language`,
`decision`, `code`. Decisions in order: live or upcoming → `source_live`; no duration →
`source_duration_unknown`; longer than `job.limits.maxSourceSeconds` → `source_rejected_duration`;
Twitch subscriber-only → `download_members_only`. Preflight runs even on a cache hit.

### `job.fetch` (additive, written by the worker, read by the UI)

`{phase: preflight|cache|audio|video|ready|failed, platform, sourceKey, cache:
off|hit|miss|stored|skipped, scope: umum|user, audioFirst, durationMs, formats {audio, video},
fallback: null|no_audio_first|av_offset|cache_exdev, readyAt}`. Never a proxy URL, cookie,
absolute path or raw stderr.

### Audio first: the `source-ready` handshake

With `POTONGIN_FETCH_AUDIO_FIRST=on`, V3 selection, a link source, a cache miss and an audio
format in the preflight, the worker downloads audio first, then starts the video download (same
audio format id), YouTube captions and the engine together. The engine gets `--analyze-audio
<audio> --media-duration <s> --source-ready <abs input/.fetch/source-ready.json>
--source-wait-timeout <s>`; the worker writes the file atomically (tmp + rename, 0600):

```json
{"schema": "potongin.source-ready/1", "path": "source.mp4", "durationMs": 3540040,
 "fps": {"num": 30, "den": 1}, "width": 1280, "height": 720, "audioOffsetMs": 0, "status": "ready"}
```

or `{"schema": "potongin.source-ready/1", "status": "failed", "code": "download_stalled"}`.
`fetch.handshake.wait_source_ready(path, timeout_s, poll_s=1.0)` (stdlib) reads it only when it is
not a symlink and ≤ 4 KiB; `failed` or a timeout raise `SourceUnavailable(code)`. Transcription,
the audio timeline, selection and packaging run on the audio; the scene pass, source info, words
artifact, camera and shot plans, seed and render wait for it (stage `fetch_wait_video` after 1 s).
An A/V offset over one source frame sets `fallback = "av_offset"` and the engine redoes the audio
stages from `source.mp4`.

### Cache (`/data/cache-unduhan`)

```
/data/cache-unduhan/
  umum/<platform>/<mediaId>/<variant>/{entry.json, source.mp4, audio.m4a?}
  umum/_transkrip/<sourceKeyHash>/<transcriptKey>.json
  k-<fairnessKey>/…            same layout, one owner's scope (§5.59)
  .locks/<lockKey>/owner.json
  .tmp/<random>/
  .sweep.json
```

- On the `clipper_data` volume next to `/data/jobs` (hard links need the same `st_dev`), created
  at runtime by the primary-worker (0700). `<variant>` = `h<H>-a<audioFormatId>-v<videoFormatId>`
  (`[A-Za-z0-9_-]`, ≤ 64); `<sourceKeyHash>` = 16 hex of sha256(`sourceKey`).
- `entry.json` (`potongin.media-cache/1`): `sourceKey`, `scope`, `variant`, `files [{name, size}]`,
  `durationMs`, `createdAt`, `lastUsedAt`, `ytDlp`, `cookies`. Another schema is a miss and is
  swept.
- Scope (Q4, default, can be changed): an unauthenticated download of a public video without an
  age limit goes to `umum`; with cookies, not public or age-limited it goes to
  `k-<fairnessKey>`. Lookup: the owner's scope, then `umum`.
- A hit is hard-linked into the attempt's `input/`; the cache is never the only owner of a job's
  bytes. A miss is downloaded into the job, then linked into `.tmp/<r>/` and renamed into place.
  `EXDEV` copies and writes no entry (`fallback = "cache_exdev"`).
- Lock (same protocol in `web/lib/media-cache-lock.mjs` and `src/ai_clipper/fetch/cache.py`):
  `lockKey` = 16 hex of sha256(`scope\0sourceKey\0variant`) or the `transcriptKey`;
  `mkdir(.locks/<lockKey>)` then `owner.json {token, pid, host, leaseUntilMs}`, lease 45 s renewed
  every 10 s; an expired lease is taken over by renaming the lock to `.stale-<token>`.
- Transcript cache: `transcriptKey` = 16 hex of sha256 of the canonical JSON `{sourceKey,
  audioFormatId, engine, model, language, wordTimestamps, transcriptSchema}`; the content is the
  engine's transcript artifact byte for byte plus the header `{schema:
  "potongin.transcript-cache/1", key}`. Link sources only.
- `POTONGIN_MEDIA_CACHE` (`off` default), `_BYTES` (4 GiB), `_TTL_DAYS` (3): TTL from
  `lastUsedAt`, LRU down to 90 % of the cap, writes only above the storage reserves plus
  `filesizeApprox`. The sweep never follows a symlink, refuses a root that is or contains
  `JOBS_ROOT`, and re-checks every path's `realpath` before deleting. Cache bytes do not count
  towards a user's quota.
- Admin API: `GET /api/admin/cache-unduhan`, `POST /api/admin/cache-unduhan/clear {scope?:
  all|media|transkrip}` (409 `cache_busy` while a lock is held; audit `cache.cleared`); a member
  gets the identical 404 of the `web` family.

### Errors

Source codes and their `messageId` (§5.65): `web.source_host_not_allowed`,
`web.source_rejected_kind`, `web.source_private_address`, `web.source_rejected_duration`,
`web.source_rejected_format`, `web.source_rejected_codec`, `web.source_platform_off`,
`download.source_live`, `download.source_duration_unknown`, plus `web.cache_busy`,
`web.proxy_invalid`, `web.bgutil_unavailable`. Existing `download_*` codes stay.

### Gates

`web/tests/source-url.test.mjs` and `tests/test_fetch_platforms.py` (shared URL fixture),
`source-type-guard`, `fetch-args`, `fetch-plan`, `tests/test_fetch_probe.py`,
`tests/test_fetch_handshake.py`, `tests/test_fetch_cache.py` (byte-identical cached transcript),
`tests/test_pipeline_audio_first.py`, `media-cache`, `media-cache-lock`, `media-cache-routes`
(rombak 04 §B15).

## 5.65 UI language: message ids on errors, stage and reason codes (2026-10-24)

Contract only; no code exists. Owner: rombak 07 §3, §5, §9.2 and §10. Built in Fase 1 (i18n M0,
M1) and Fase 2 (M2, M5); the full `stage_code` and `reason_codes` lists are fixed in the M5 PR,
which amends this section.

### Error bodies (additive)

Every route keeps its shape and gains fields; nothing is removed:

- flat: `{"error": "<Indonesian text>", "code": "<code>", "messageId": "<domain>.<code>", "params"?: {…}}`;
- nested: `{"error": {"code", "messageId", "params"?, …old fields}}`;
- a route that answers a bare string today gains the flat shape.

The Indonesian `error` string stays for good: logs, the trend agent (`api/ingest/trends`) and a
rollback image read it. `params` holds primitives only, at most 8 keys. `messageId` =
`<domain>.<code>` without an `errors.` prefix; the catalog key is `"errors." + messageId`. A code
with detail (`glyph_unsupported:U+1F602`) maps to `edit.glyph_unsupported` with
`params.detail = "U+1F602"`, as Python's `base_code()` splits it. Existing `messageId` values
never change.

Domains: `web` (`web/lib/error-codes.mjs`), `http` (no known body; key `http.s<status>`),
`download`, `storage`, `llm` (`ERROR_CODES`, `src/ai_clipper/llm.py`), `edit` (`_MESSAGES`,
`src/ai_clipper/edit_v2/errors.py`), `editor` (`COMMAND_MESSAGES`, `web/lib/editor/commands.mjs`),
`editor_ai`, `social` and `performance` (§5.60–§5.62), `account` (rombak 02 §16), `global`
(`global-error.jsx`). A new code from any plan needs `errors.<messageId>` (and `hints.<messageId>`
when there is a hint) in every locale and a Help entry; `i18n-error-codes` enforces it.

### Python: codes next to prose

- `pipeline.report(stage, percent, detail, *, code=None, params=None)` writes `stage_code` and
  `stage_params` beside `detail`; `run-job.mjs` and `primary-job-queue.mjs` add `stageCode` and
  `stageParams` beside `stageDetail`. A job without them shows `stageDetail` as today.
- Clip manifests gain `reason_codes` and `warning_codes`, each `[{code, params}]`, beside the
  existing prose. Reasons written by the LLM are content and are never translated.
- Python never learns the UI language: no locale env or argv reaches it
  (`content-language-isolation`). Gold selection output stays identical; manifests only gain
  fields.

### Locale registry and resolution

`web/lib/i18n/locales.mjs`: `id` (`id-ID`) and `en` (`en-US`), `DEFAULT_LOCALE = "id"`.
`POTONGIN_LOCALES` (app only; default `id`; `id` is always on). Resolution: `users.locale` (once
multi-user), the cookie `potongin_locale`, `Accept-Language`, then `id`; a candidate that is not
enabled is skipped. `proxy.js` reads neither the DB nor the locale. The cookie:
`potongin_locale=<code>; Path=/; Max-Age=31536000; SameSite=Lax; Secure`, not HttpOnly.

### `POST /api/locale` (`web/app/api/locale/route.js`)

| Aspect | Value |
|---|---|
| Method | POST only; anything else 405 with `Allow: POST` |
| Auth | Public: excluded from the `proxy.js` matcher (`api/locale/?$`); with a valid session it also writes `users.locale` (once multi-user) |
| Origin | `sameOriginMutation` required |
| Rate limit | 20/min token bucket keyed on `"locale:" + sha256hex(trusted client IP)`; checked after method and origin, before the body |
| Body | form (`locale`, optional `next`) or JSON `{locale}`, at most 1 KiB (`Content-Length` over 1 KiB → 413 before reading) |
| Effect | `Set-Cookie: potongin_locale=…` |
| Answer | Form: 303 to `next` when `safeNextPath(next) === next`, else a same-origin `Referer` path, else `/`; JSON: 200 `{locale}`; both `Cache-Control: no-store` |

Errors (flat shape): 400 `web.invalid_request`, 400 `web.locale_unsupported`, 403
`web.csrf_rejected`, 405 `web.method_not_allowed`, 413 `web.request_too_large`, 429
`web.rate_limited` with `Retry-After`. A form request that fails with 400, 413 or 429 is answered
303 to its page with `bahasa=gagal`.

### Gates

`i18n-error-codes`, `i18n-catalog`, `i18n-registry`, `i18n-resolve`, `locale-route`,
`content-language-isolation` (rombak 07 §14); `web/tests/proxy-matcher.test.mjs` gains
`/api/locale`; existing route and contract tests stay green unchanged.
