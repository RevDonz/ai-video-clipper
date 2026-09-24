# Selection V3: LLM hook selection, word-accurate boundaries, and hook packaging

## Why

A measured audit on a real 65-minute Indonesian podcast (`Ive926sC6mc`) showed that the
current selectors cannot tell good moments from bad ones:

- score AUC gold-vs-rest was 0.50–0.57 for V1 and V2 (0.5 = chance);
- V2 standard hit 1 of 12 human-editor gold moments, the same as random 30 s windows;
- V1 renders every clip at exactly max duration, scores `9 + 2 × keyword count`, and puts
  the keyword in the clip's last seconds;
- V2 hook detection reduces to "does the first sentence end in `?`": the bold-claim and
  open-loop regexes matched 0 times, and punctuation was missing for ~50 minutes;
- the V2 filler penalty fires on 91–99% of candidates and decides the ranking;
- media re-ranking never changed the top 5; segment timestamps were quantized to 1 s.

In the gold set, 11 of 12 good moments start on a host question, and the strongest hook
line is the guest's, a median ~16–21 s after the natural start. Commercial tools (OpusClip,
Klap, Vizard, LokaClip) use an LLM with a rubric, snap to sentence/silence boundaries, and
add a text hook in the first ~5 s.

## Goals

1. An LLM proposes and ranks moments over sentence IDs. It works with **any
   OpenAI-compatible provider** (free or cheap: Gemini AI Studio, Groq, OpenRouter `:free`,
   Cerebras, Mistral, DeepSeek, local Ollama). Everything must be swappable through
   environment variables, and fallback models must be tried in order.
2. A deterministic heuristic fallback (no network) that beats V1/V2 on the benchmark and
   the held-out episode.
3. Word-level timestamps, punctuation-agnostic sentence units, and a transcript quality gate.
4. A whole-file audio timeline: relative loudness, silences, and camera cuts.
5. Hook packaging: an optional cold open (the hook line played first), an on-screen hook
   text for the first seconds, and word-timed (karaoke) captions.
6. A gold-label benchmark so every change is measured (Recall@K, Precision@K, trap hits).
7. `--selection-mode v3` renders clips. The dashboard defaults to V3. V1 and v2-shadow stay
   available.

Non-goals: guaranteeing virality, diarization models, GPU-only models, and learning-to-rank
(feedback capture is kept for later).

## Module map and ownership

| Module | Purpose |
|---|---|
| `models.py` | `TranscriptWord`; `TranscriptSegment.words: tuple[TranscriptWord, ...] = ()` (done) |
| `transcribe.py` | word timestamps on by default; optional `initial_prompt` |
| `transcript_io.py` | tolerant transcript JSON read/write with optional `words` |
| `transcript_quality.py` | punctuation-collapse, repetition-loop, script-mismatch, quantization checks |
| `sentences.py` | punctuation-agnostic `SentenceUnit`s built from words, falling back to segments |
| `audio_timeline.py` | one-pass whole-file RMS/loudness-z, relative silences, scene cuts |
| `llm.py` | provider-agnostic OpenAI-compatible JSON client, presets, fallback chain, cache |
| `selection_types.py` | shared V3 dataclasses (`ClipProposal`, `SelectedClip`, `SelectionResult`) |
| `llm_selection.py` | chunked propose prompt, validation, dedupe, listwise rerank, packaging |
| `hook_heuristics.py` | deterministic Q→A-anchored fallback selector |
| `selection_v3.py` | orchestration: units + audio + (LLM or heuristic) → boundary snapping → result |
| `benchmark.py` | gold-span metrics and a selector registry |
| `render.py` / `subtitles.py` | cold open, hook overlay, word-timed ASS/SRT captions |
| `pipeline.py` / `cli.py` | `v3` mode wiring, manifest fields, progress stages |
| web | `v3` option (default), LLM status, clip title/hook display, V2 artifact fix |

## Contracts

### Transcript JSON (`transcript.json`)

```json
{"language": "id",
 "segments": [
   {"start": 1.0, "end": 2.5, "text": "Gue bukan jambret.",
    "words": [{"start": 1.02, "end": 1.30, "text": "Gue", "probability": 0.93}]}
 ]}
```

`words` is omitted when empty. Every reader must accept segments with and without `words`.
The top level keeps exactly `language` and `segments`. Quality results go to
`analysis/transcript-quality.json`.

As implemented (`transcript_io.py`):

- Write with `write_transcript_json(path, transcription)`. It is atomic, writes one segment
  per line, rounds times and `probability` to 3 decimals, and omits `probability` when it is
  unknown. Written segments never overlap: a start is clamped to the previous written end, so
  the output always passes the strict readers in `evaluation.py` and `candidate_cues.py`.
  `pipeline.py` writes `transcript.json` with this writer in every selection mode (V1 and
  v2-shadow included). Older jobs have `asdict(segment)` files with `"words": []` and
  `"probability": null`; every reader accepts those too.
- Read with `read_transcript_json(path, *, max_bytes=16 MiB) -> Transcription`.
  - The top level is exactly `{language, segments}`; each segment is `{start, end, text}` plus
    optional `words`; each word is `{start, end, text}` plus optional `probability` (a number
    or null). Any other key is rejected.
  - Starts must be chronological. An overlap of 0.25 s or less is repaired, because YouTube
    caption converters produce overlaps of a few ms; a larger overlap is rejected.
  - JSON parsing is strict: no duplicate keys, no NaN or Infinity. Errors raise
    `TranscriptFormatError(ValueError)` and never echo transcript text.
- Other readers validate words with `words_from_payload(value)`.
- `transcribe_video(..., word_timestamps=True, initial_prompt=None)` keeps segments
  chronological and non-overlapping. Words are chronological by start and clamped inside
  their segment; they may overlap each other. `probability` is clamped to 0..1, or `None`
  when unknown.

### `transcript_quality.py`

```python
@dataclass(frozen=True, slots=True)
class TranscriptQuality:
    punctuated_ratio: float                      # segments ending in . ? ! (0..1)
    punctuation_blocks: tuple[tuple[float, float, float], ...]  # (start, end, ratio) per 300 s
    integer_duration_ratio: float                # share of whole-second segment durations
    has_word_timestamps: bool
    suspect_segment_indices: tuple[int, ...]     # loops, script mismatch, garbage
    warnings: tuple[str, ...]                    # stable codes, see below
def assess_transcript(segments: list[TranscriptSegment], *, language: str = "id") -> TranscriptQuality
```

Warning codes: `punctuation_collapse:<start_s>-<end_s>`, `repetition_loop:<first_idx>-<last_idx>`,
`script_mismatch:<idx>`, `no_word_timestamps`, `quantized_timestamps`.

As implemented:

- Order and extra code:
  - File-level codes come first (`no_word_timestamps`, `quantized_timestamps`,
    `punctuation_collapse`), then per-segment codes by index.
  - An extra code, `low_confidence:<idx>`, fires when the mean word probability is below 0.35
    over at least 3 scored words.
  - `is_warning_code(code)` validates a code.
- Suspect segments are loops, script mismatches and low-confidence segments, plus "garbage"
  segments with no letters or digits. Garbage segments get no warning code.
- Thresholds:
  - A single word needs 6 back-to-back repeats; a 2–8-word phrase needs 4 and must fill more
    than half of a segment it touches. Laughter is exempt.
  - Punctuation collapse is judged only on blocks of at least 5 segments, and only when some
    block reaches a ratio of 0.6.
  - `quantized_timestamps` needs at least 5 segments.
- `assess_transcript` accepts any `Sequence[TranscriptSegment]`.
- `TranscriptQuality.to_dict()` / `from_dict()` use `"version": "transcript-quality-v1"`.
- `write_transcript_quality_json(path, quality)` writes the artifact atomically.

### `sentences.py`

```python
@dataclass(frozen=True, slots=True)
class SentenceUnit:
    unit_id: str            # "S0001", 1-based, zero-padded to at least 4 digits
    index: int              # 0-based position
    start: float            # first word start (word mode) or segment start
    end: float              # last word end (word mode) or segment end
    text: str
    segment_start: int      # first covered TranscriptSegment index
    segment_end: int        # last covered index (inclusive)
    word_count: int
    is_question: bool       # '?' or a colloquial interrogative opener (apa, kenapa, gimana, …)
    gap_before: float       # silence before this unit in seconds (0.0 for the first)
    suspect: bool           # overlaps a quality-suspect segment
    words: tuple[TranscriptWord, ...]
def build_sentence_units(segments, *, quality=None, pause_split=0.6, max_words=32,
                         max_seconds=14.0, min_words=3) -> list[SentenceUnit]
```

Units never depend on punctuation alone. They split on terminal punctuation or on word gaps
≥ `pause_split`, split long runs at their largest internal gap, and merge fragments shorter
than `min_words` into a neighbour.

As implemented:

- **`quality=None` means no unit is ever `suspect`.** Callers must pass
  `quality=assess_transcript(segments, language=...)` built from the same segment list.
- Word mode applies per segment that has words; other segments become whole-segment atoms,
  so mixed input works. In segment mode `words=()`.
- Units always split where the suspect flag changes, and never merge across it.
- Fragments merge only across a gap of 1.5 s or less, and only while the result stays within
  `max_words + min_words` words and `max_seconds + 2` s.
- A single segment longer than `max_seconds` stays one unit.
- `SentenceUnit.duration` and `looks_like_question(text)` are public. The question rule is
  documented in the module docstring.

### `audio_timeline.py`

```python
@dataclass(frozen=True, slots=True)
class AudioTimeline:
    analyzer_version: str          # "audio-timeline-v1"
    duration: float
    step: float                    # seconds per sample (0.1)
    rms_db: tuple[float, ...]      # floored at -90
    loudness_z: tuple[float, ...]  # z-score vs this file's own speech distribution, smoothed
    silences: tuple[tuple[float, float], ...]   # relative threshold, >= 0.25 s
    scene_cuts: tuple[float, ...]  # seconds; empty when unavailable
    warnings: tuple[str, ...]
    def window_stats(self, start: float, end: float) -> dict[str, float]
        # energy_mean_z, energy_peak_z, cut_rate_per_min, silence_ratio
    def nearest_quiet_point(self, t: float, max_shift: float) -> float
def analyze_audio_timeline(source: Path, *, timeout: float = 900.0, scene_cuts: bool = True) -> AudioTimeline
def write_audio_timeline(timeline, path) / read_audio_timeline(path)
```

As implemented:

- **Signatures.**
  - `analyze_audio_timeline` also takes `ffmpeg_path="ffmpeg"` and `ffprobe_path="ffprobe"`.
  - `write_audio_timeline(timeline, path) -> Path` writes compact JSON atomically.
  - `read_audio_timeline(path)` raises `ValueError` for malformed content and `OSError` for
    I/O errors. Its key set is exactly the dataclass fields, and it reads at most 32 MiB.
  - The conventional location is `ARTIFACT_RELATIVE_PATH = analysis/audio-timeline.json`.
  - `build_audio_timeline(rms_db, *, duration, step=0.1, scene_cuts=(), warnings=())` is the
    pure builder, for tests and fixtures.
- **Errors and timeout.**
  - Failures raise `AudioTimelineError(RuntimeError)`: probe failed or timed out, audio pass
    failed or timed out, or media longer than 24 h. The message never contains the source
    path or file name.
  - A missing source raises `FileNotFoundError("source media not found")`.
  - `timeout` is one wall-clock deadline shared by the probe, audio and scene passes. The
    scene pass (the slow part, since it decodes video) degrades to a warning instead of
    failing.
- **Warning codes:** `no_audio_stream`, `no_video_stream`, `scene_cuts_disabled`,
  `scene_cuts_failed`, `scene_cuts_timeout`, `scene_cuts_truncated`, `no_audio_frames`,
  `audio_shorter_than_media`, `audio_flat`.
- **Values.**
  - `rms_db` is rounded to 0.1 dB and `loudness_z` to 0.01, clipped to ±6.
  - Silences are runs below the 10th-percentile floor + 6 dB.
  - Frame `i` covers `[i*step, (i+1)*step)`.
- **`nearest_quiet_point(t, max_shift)`.**
  - It returns `t` when `t` is already in a silence, when the frame at `t` is within 1 dB of
    the quietest reachable frame, when `max_shift == 0`, or when there is no audio.
  - Otherwise it returns the reachable silence point closest to `t`, inset by up to half a
    frame, or failing that the centre of the lowest-RMS frame.
  - The result stays within `±max_shift` and, when reachable, inside `[0, duration]`.
- **Evidence on Episode A (n = 12):** `silence_ratio` is the only useful audio signal (AUC
  0.69). `energy_mean_z` points the wrong way (AUC 0.33), so do not reward it.

### `llm.py`

The API key never appears in reprs, exceptions, logs, artifacts, or manifests.

```python
class LLMError(Exception)            # sanitized, safe to show to users
class LLMUnavailable(LLMError)       # not configured
@dataclass(frozen=True) class LLMConfig:
    provider: str; base_url: str; model: str; api_key: str | None  (repr=False)
    fallback_models: tuple[str, ...]; timeout: float; max_retries: int; temperature: float
    max_output_tokens: int; json_mode: bool; requests_per_minute: float | None
    context_tokens: int              # chunk sizing hint for callers
    def public_dict(self) -> dict    # never includes the key
def load_llm_config(env: Mapping[str, str] = os.environ) -> LLMConfig | None
@dataclass(frozen=True) class LLMResponse:
    data: dict; text: str; model: str; provider: str
    input_tokens: int | None; output_tokens: int | None; latency_s: float; cached: bool
class LLMClient(Protocol):
    def complete_json(self, *, system: str, user: str, max_output_tokens: int | None = None,
                      temperature: float | None = None) -> LLMResponse
class OpenAICompatibleClient     # urllib only; retries, Retry-After, fallback models, rate limit
class CachedLLMClient            # on-disk cache keyed by sha256 of the full request
class ScriptedLLMClient          # deterministic, for tests
```

Environment variables:

| Variable | Meaning |
|---|---|
| `POTONGIN_LLM_PROVIDER` | `gemini`, `groq`, `openrouter`, `cerebras`, `mistral`, `deepseek`, `openai`, `ollama`, `custom` |
| `POTONGIN_LLM_API_KEY` | falls back to the provider's own variable (`GEMINI_API_KEY`, `GROQ_API_KEY`, …) |
| `POTONGIN_LLM_BASE_URL` | required for `custom`; overrides a preset |
| `POTONGIN_LLM_MODEL` | overrides the preset's default model |
| `POTONGIN_LLM_FALLBACK_MODELS` | comma-separated list, tried in order on 404/429/5xx/invalid JSON |
| `POTONGIN_LLM_TIMEOUT`, `POTONGIN_LLM_RPM`, `POTONGIN_LLM_JSON_MODE`, `POTONGIN_LLM_CONTEXT_TOKENS`, `POTONGIN_LLM_MAX_OUTPUT_TOKENS` | tuning |
| `POTONGIN_LLM` | `off` disables the LLM even when configured |

As implemented (the owner's `.env` lists several free providers, so the loader supports a
failover list). The owner-facing guide is `docs/operations/LLM_PROVIDERS.md`.

- **Signatures.**
  - Loader functions take `env: Mapping[str, str] | None = None`, where `None` means
    `os.environ`. A default of `os.environ` would print every secret through
    `inspect.signature`.
  - Every `LLMConfig` field after `model` has a default: `api_key=None`, `timeout=120`,
    `max_retries=3`, `temperature=0.2`, `max_output_tokens=4096`, `json_mode=True`,
    `requests_per_minute=None`, `context_tokens=32768`.
  - Extra fields: `http_referer`, `app_title`, `reasoning_effort`.
  - `LLMConfig.model_chain` lists the primary model, then the fallbacks.
  - `public_dict()` has `api_key_set: bool` and never the key.
- **Providers.**
  - `PROVIDERS` adds `ollama-cloud` (`https://ollama.com/v1`, `OLLAMA_API_KEY`), for 10
    entries.
  - `PRESETS[name]` is a `ProviderPreset`. Local `ollama` never reads `OLLAMA_API_KEY`.
- **Several providers.**
  - `POTONGIN_LLM_PROVIDER` (or its alias `POTONGIN_LLM_PROVIDERS`) may be a comma list, tried
    in order.
  - In a list, a provider without a key, a paid provider under `POTONGIN_LLM_FREE_ONLY=1`, or
    an unknown name is skipped.
  - Per-provider overrides use `POTONGIN_LLM_<PROVIDER>_<NAME>`, with the hyphen written as an
    underscore.
  - Unscoped `API_KEY`, `BASE_URL`, `MODEL` and `FALLBACK_MODELS` apply only to the first
    listed provider. Unscoped tuning variables apply to all.
- **Other variables:** `POTONGIN_LLM_FREE_ONLY`, `POTONGIN_LLM_MAX_RETRIES`,
  `POTONGIN_LLM_TEMPERATURE`, `POTONGIN_LLM_REASONING_EFFORT`, `POTONGIN_LLM_HTTP_REFERER`,
  `POTONGIN_LLM_APP_TITLE`.
  - `POTONGIN_LLM_FALLBACK_MODELS=none` means no fallbacks.
  - `POTONGIN_LLM_RPM=0` or `off` means unlimited.
  - Empty values count as unset.
- **Loader behaviour.**
  - `load_llm_config(env)` returns the first usable config. It returns `None` only when
    nothing is configured or `POTONGIN_LLM=off`.
  - A misconfiguration raises `LLMUnavailable` with code `missing_api_key`, `not_free` or
    `config_invalid`. **Callers must catch `LLMUnavailable`**, not only test for `None`.
  - `load_llm_configs(env)` returns every usable config. `configured_providers(env)`,
    `llm_disabled(env)` and `is_free_model(provider, model)` are also public.
- **Factories.**
  - `create_llm_client_from_env(env=None, *, cache_dir=None) -> LLMClient | None` builds an
    `OpenAICompatibleClient`, or a `FailoverLLMClient` over several, optionally wrapped in
    `CachedLLMClient`. `pipeline.py` uses it with
    `cache_dir=<artifact root>/analysis/llm-cache`.
  - `create_llm_client(config, *, cache_dir=None)` does the same for one config.
- **`LLMError`.**
  - Constructor: `LLMError(code, message, *, provider, model, status, retryable, retry_after,
    attempts)`.
  - `attempts` is a tuple of `(model, code)`; for failover the model is written
    `provider/model`. `to_dict()` is safe to store in artifacts.
  - Runtime codes: `auth`, `rate_limited`, `quota_exhausted`, `timeout`, `network`, `bad_json`,
    `bad_response`, `model_not_found`, `payment_required`, `truncated`, `context_length`,
    `too_large`, `content_filter`, `http_<status>`, `script_exhausted`.
- **Client behaviour.**
  - 429 is retried with backoff, honouring Retry-After up to 60 s. A daily quota or a longer
    Retry-After instead cools that model down and moves on.
  - 401 and 403 stop that provider; `FailoverLLMClient` then tries the next one.
  - A 400 that rejects `response_format`, `temperature`, `reasoning_effort` or
    `max_tokens`/`max_completion_tokens` is retried once without that parameter.
  - Redirects are never followed.
  - When neither prompt contains the word "json", a JSON hint is appended to the system
    prompt.
- **What callers must handle.**
  - The client does no schema validation. Free models sometimes return incomplete objects, so
    `llm_selection` must validate every field.
  - `timeout` is per HTTP request. There is no overall deadline, so a caller that needs one
    must enforce it: provider × model × retry multiplies.
  - `context_tokens` is the total per-request budget (prompt plus output). Groq's is 8000.
- **CLI:** `python -m ai_clipper.llm --check [--json]` pings every configured provider and
  exits 0 when at least one answers. `--show-presets [--json]` lists the presets.

### Selection V3 (`selection_types.py`)

```python
@dataclass(frozen=True, slots=True)
class ClipProposal:            # before boundary snapping
    start_unit: int; end_unit: int; hook_unit: int; payoff_unit: int | None
    archetype: str; title: str; hook_text: str; description: str
    hashtags: tuple[str, ...]; reasons: tuple[str, ...]
    scores: Mapping[str, float]   # hook, standalone, payoff, emotion, shareability (0..10)
    score: float                  # 0..10 combined
    source: str                   # "llm" | "heuristic"
@dataclass(frozen=True, slots=True)
class SelectedClip:
    rank: int; start: float; end: float                   # snapped source seconds
    cold_open: tuple[float, float] | None                 # hook line played first
    unit_ids: tuple[str, str]; hook_unit_id: str
    title: str; hook_text: str; description: str; hashtags: tuple[str, ...]
    archetype: str; score: float; scores: Mapping[str, float]; reasons: tuple[str, ...]
    source: str; text: str
@dataclass(frozen=True, slots=True)
class SelectionResult:
    clips: tuple[SelectedClip, ...]
    source: str                 # "llm" | "heuristic"
    status: str                 # "completed" | "fallback" (LLM failed, heuristic used)
    provider: str | None; model: str | None; prompt_version: str
    warnings: tuple[str, ...]; usage: Mapping[str, int]
```

As implemented:

- **`SelectionResult`.**
  - `warnings` and `usage` default to empty.
  - A trailing field `selection_version = "selection-v3.0"` is added.
  - Ranks must run 1..n in order, and `status="fallback"` requires `source="heuristic"`.
  - `to_dict()` gives the artifact body.
- **`archetype`** must be one of `ARCHETYPES`, which are snake_case: `curiosity_gap`,
  `controversial_claim`, `confession`, `insider_secret`, `story_twist`, `number_proof`,
  `conflict`, `humor`, `relatable_pain`, `emotional`, `practical_tip`, `other`.
  - The gold files use free-form kebab-case archetypes. The benchmark does not compare them.
- **Scores:** `scores` must have exactly `SCORE_DIMENSIONS`, each 0..10.
- **Text fields.**
  - `hook_text` is non-empty and at most 90 characters (the render hook limit), and `title`
    is at most 100.
  - `description` is at most 600 characters and may be empty.
  - `hashtags` holds at most 10 items and `reasons` at most 8.
- **`SelectedClip.cold_open`** only checks `0 <= start < end`. The renderer is stricter (see
  Render), so the selector must enforce the render rules itself, or the render fails.

As implemented (`selection_v3.py`, the orchestration):

- **Entry point.** `select_clips_v3(segments, *, k, min_duration, max_duration,
  llm_client=None, llm_mode="auto", events=(), audio=None, quality=None, cold_open=True,
  context_tokens=32768, max_output_tokens=4096, max_requests=3, deadline_s=300.0,
  rerank=True, clock=None) -> SelectionResult` serves the pipeline and the benchmark.
  - `quality=None` runs `assess_transcript` itself; the pipeline passes the quality it wrote.
  - The heuristic always runs. With a usable LLM its proposals lead and the heuristic only
    fills the remaining slots (`llm_filled:<n>`).
- **`llm_mode`.**
  - `off` never calls the client.
  - `auto` turns `LLMUnavailable` into `llm_unavailable` and any other `LLMError` (including
    "no valid moment") into `llm_failed:<code>`, with `status="fallback"`,
    `source="heuristic"`.
  - `required` re-raises, also when the client is `None` (`not_configured`) or when every LLM
    moment is lost (`no_moments`).
- **Snapping** (source seconds). Starts get a pre-roll of at most 0.15 s, or the nearest quiet
  point within 0.25 s when an audio timeline exists, never into the previous word. Ends get a
  tail of at most 0.4 s (half the following gap), or cover laughter, applause or cheering
  tagged within 2.5 s plus 0.8 s. Durations must fit `[min_duration, max_duration]` after
  snapping; a proposal that cannot fit is dropped (`snap_dropped:<n>`).
- **Cold open.** Only for a hook unit at least 5 s after the clip start, not suspect, 1–8 s
  long. The result stays within the renderer's 0.5–8 s rule and never starts at the clip
  start. `cold_open=False` disables it.
- **Ranking.** Clips never share a sentence unit. A near-duplicate of an accepted clip
  (content-word Jaccard ≥ 0.25) moves to the end of its own source's list.
- **Provenance.** `prompt_version` is `llm-select-v2+std.<sha12>` for LLM-led results and
  `heuristic-v3.1` otherwise (`heuristic-v3.0` before the 2026-09-24 follow-up: text laughter
  for untagged tracks, host reactions, clean hook text and titles). `provider`/`model` are `None` unless the LLM led, and are
  joined with `+` (`ollama-cloud+openrouter`) when several engines answered.
- **Warnings**, in order: the LLM's own `llm_*` codes, `llm_unavailable` or
  `llm_failed:<code>`, `llm_filled:<n>`, `snap_dropped:<n>`, `few_clips:<n>`,
  `no_transcript`.
- **Artifact.** `SELECTION_ARTIFACT_RELATIVE_PATH = analysis/selection.v3.json`.
  `write_selection_artifact(path, result)` writes `SelectionResult.to_dict()` atomically.
  `read_selection_artifact(path)` is strict (at most 8 MiB, no duplicate keys or NaN) and
  raises `SelectionArtifactError(ValueError)`.
- **Budget.** `llm_request_budget(env=None) -> (context_tokens, max_output_tokens) | None`
  uses the smallest context over the failover chain and the primary provider's output
  budget, capped at half that context. A small-context provider anywhere in the chain (Groq:
  8000) therefore shrinks every request.
- **Benchmark.** `benchmark_selectors()` registers `v3-heuristic` (`llm_mode="off"`) and
  `v3-llm` (`llm_mode="required"`, client from the environment).

### Render

```python
render_vertical(source, output, *, start, end, transcript, width, height, render_mode,
                cold_open: tuple[float, float] | None = None,
                hook_text: str | None = None, hook_duration: float = 4.0,
                caption_style: str = "classic")   # "classic" | "karaoke"
```

- Output duration is the cold-open length plus `end - start`.
- Captions are word-timed when words exist. Words overlapping the clip are included, not
  whole segments only.
- The hook text sits in the top safe area.
- The downloadable `.srt` matches the burned captions, including the cold-open offset.

As implemented:

- **Rules, checked before any subprocess runs.** The error is `TypeError` or `ValueError`.
  - `cold_open` is a 2-item tuple or list.
  - Its length is between `COLD_OPEN_MIN_SECONDS = 0.5` and `COLD_OPEN_MAX_SECONDS = 8.0`.
  - `|cold_open[0] - start| >= 0.01`.
  - `cold_open[1]` must not exceed the source video duration. This is checked after the
    probe.
  - The cold open may lie outside `[start, end]`.
  - `hook_duration` is in `(0, 30]`.
  - A blank `hook_text` means no hook. Longer text is cut to 90 characters on a word boundary
    with "…".
  - `caption_style` is in `CAPTION_STYLES = ("classic", "karaoke")`.
- **Captions.**
  - A word belongs to a range when its midpoint lies inside it; its times are clamped to the
    range.
  - Segments without words are spread proportionally.
  - Cues hold up to 4 words and break on gaps over 0.6 s and on sentence ends. They are shown
    for at least 0.3 s, quantized to centiseconds, never overlap, and never cross the
    cold-open join.
  - Captions sit 17% from the bottom in both styles. Karaoke is bold, with the spoken word in
    #FFE14D.
  - The hook is a stack of boxed lines (up to 3) 13% from the top, fading in over 150 ms and
    out over 250 ms.
  - The fonts are DejaVu Sans and DejaVu Sans Bold, which must be installed in the image.
- **Helper modules.**
  - `subtitles`: `build_caption_cues(segments, ranges, *, max_words=4, max_gap=0.6,
    min_display=0.3) -> tuple[CaptionCue, ...]`, `cues_to_srt(cues)` and
    `timeline_to_srt(segments, ranges)`.
    - The legacy `to_srt(...)` behaves as before for transcripts without words.
  - `captions_ass`: `build_ass(cues, *, width, height, duration, caption_style="classic",
    hook_text=None, hook_duration=4.0, uppercase=False)`, `ass_escape(text)` and
    `shorten_hook_text(text, max_chars=90)`.
- **Command.** The single-range path keeps the historical FFmpeg command but burns
  `ass=filename='captions.ass'`. The cold-open path uses one seeked input per range and
  concatenates them, with a 30 ms audio fade at the join.
  - `FFMPEG_TIMEOUT_SECONDS` is still 300. A 29 s fit-blur clip with a cold open took about
    22 s at 720×1280.

### Manifest (additive)

Each clip adds these fields:

| Field | Type |
|---|---|
| `title` | string or null |
| `hook_text` | string or null |
| `description` | string or null |
| `hashtags` | list of strings |
| `archetype` | string or null |
| `selection_source` | `"v1"`, `"llm"` or `"heuristic"` |
| `reasons` | list of strings |
| `scores` | object or null |
| `cold_open` | `{start, end}` or null |
| `source_start`, `source_end` | numbers |
| `thumbnail` | path to `clip-XX.jpg`; V3 writes null if it failed, V1/v2-shadow omit the key |

`duration` is the rendered duration.

The top level adds:
`"selection_v3": {"mode": "v3", "status": "completed"|"fallback"|"failed", "source": "llm"|"heuristic",
"provider", "model", "prompt_version", "warnings": [codes], "artifact": "analysis/selection.v3.json"}`.

As implemented (`pipeline.py`):

- **Signature.** `run_pipeline(..., selection_mode="v3", llm_mode="auto", cold_open=True,
  hook_overlay=True, caption_style=None, captions_dir=None, word_timestamps=True,
  hook_duration=4.0, progress=None)`.
  - Every option is validated before any work starts (`TypeError`/`ValueError`, and the
    manifest is published as failed). V3 also requires finite `0 < min_duration <=
    max_duration`. `hook_duration` is in `(0, 30]`.
  - `caption_style=None` means `karaoke` for V3 and `classic` otherwise. `word_timestamps` is
    passed to every Whisper run. `llm_mode`, `cold_open`, `hook_overlay`, `hook_duration` and
    `captions_dir` only affect V3.
- **Stages** (`progress(stage, percent, detail)`): `analyzing` 26, `captions` 28 (only with
  `captions_dir`), `transcribing` 30–57 (only when Whisper runs), `audio` 58, `llm` 60 (with an
  LLM client) or `selecting` 60, `packaging` 63, `rendering` 65–94, `finalizing` 96.
- **Transcript.**
  - With `captions_dir`, the regular, non-hidden `.json3` files in `manual/` then `auto/` (at
    most 64; symlinks are skipped) go to `choose_caption_file` for the job language. For `id`,
    the legacy code `in` is tried when nothing matches. The directory is only read.
  - `load_youtube_captions` judges the track against the video duration from ffprobe (the
    stream the renderer uses). A usable track skips Whisper (`transcript_source =
    "youtube-captions"`) and its tags become `analysis/sound-events.json`
    (source `youtube-json3`).
  - Otherwise Whisper runs, with the warning `captions_missing`,
    `captions_rejected:invalid`, `captions_rejected:no_language` or one
    `captions_rejected:<reason>` per caption quality code.
  - Then `transcript.json` (`write_transcript_json`) and `analysis/transcript-quality.json`
    are written. An empty transcript fails as in V1.
- **Audio.** `analyze_audio_timeline(source, timeout=900)` starts on a daemon thread before
  the transcript step, so it overlaps Whisper, and is awaited for at most 930 s. Any failure
  (`audio_unavailable`, `audio_unavailable:timeout`, `audio_unavailable:error`) continues
  without audio. A timeline is written to `analysis/audio-timeline.json`.
- **LLM.**
  - `off` never builds a client.
  - Otherwise `create_llm_client_from_env(cache_dir=<artifact root>/analysis/llm-cache)` and
    `llm_request_budget()`; the selector gets `max_requests=3` and `deadline_s=300` (no new
    request after 300 s).
  - The client has no overall deadline, so the pipeline runs the LLM selection on a daemon
    thread and waits at most `LLM_WAIT_SECONDS = 1200`. After that `auto` renders the
    heuristic selection (`status="fallback"`, `llm_failed:deadline`) and `required` fails with
    `LLMError("timeout")`. The abandoned request may still finish and fill the cache. (One
    free `gpt-oss:120b` propose request on the 69-minute `0dzvz9JZFIM` took 755 s on
    2026-09-24, against 11–33 s during the evaluation.)
  - No configuration: `llm_not_configured` (or `llm_disabled` for `POTONGIN_LLM=off`) and a
    plain heuristic run (`status="completed"`).
  - `LLMUnavailable` adds `llm_unavailable:<code>`; `auto` then falls back through the
    selector (`status="fallback"`).
  - `required` raises instead, and a selector `LLMError` adds `llm_failed:<code>` before it
    propagates.
- **After selection.**
  - Clips are kept inside the probed video: an end past it is trimmed to the video end
    (`clip_trimmed_to_media:<rank>`); a clip with less than 1 s left is dropped
    (`clip_beyond_media:<rank>`); a cold open past it is removed
    (`cold_open_beyond_media:<rank>`). Ranks are renumbered, and the notes are also added to
    the artifact's warnings.
  - `analysis/selection.v3.json` is written before rendering. No clips fails with
    `ValueError("Tidak ada momen yang bisa dijadikan klip dalam batas durasi <min>-<max>
    detik.")`.
- **Render.** `render_vertical(start, end, cold_open=<clip cold open> if cold_open else None,
  hook_text=<clip hook> if hook_overlay else None, hook_duration, caption_style, render_mode,
  width, height)`.
- **Manifest clips.**
  - They keep `index`, `start`, `end` (the main source range), `text`, `output` and
    `subtitles`.
  - `duration` is the rendered length (cold open plus main range), `score` is 0–10 with 2
    decimals, `source_start`/`source_end` repeat the main range, and `cold_open` is
    `{start, end}` or null.
  - `hook_text` is always filled, also with `--no-hook-overlay`. An empty description becomes
    null.
  - Hashtags keep only `#[A-Za-z0-9_]{1,40}` (at most 10), and `selection_source` is `llm` or
    `heuristic`.
  - V1 manifests are unchanged: they get no packaging fields and never
    `selection_source: "v1"`. The offline V1 manifest reader in `evaluation.py` therefore
    rejects V3 manifests.
- **`selection_v3` summary.** Exactly `mode`, `status`, `source`, `provider`, `model`,
  `prompt_version`, `warnings`, `artifact`, `transcript_source`, in the web's value ranges
  (`web/lib/jobs.mjs` `sanitizeSelectionV3Summary`).
  - `source` is null only for a run that failed before selection.
  - For `a+b` engines the first provider and model are kept, with `llm_providers:<n>` and
    `llm_models:<n>`.
  - In `prompt_version` every character outside `[A-Za-z0-9._-]` becomes `.`
    (`llm-select-v1.std.<sha12>`). The artifact keeps the exact values.
  - Warnings are codes only. A code whose detail is unsafe keeps its bare code; anything else
    is dropped. They are deduplicated and capped at 50.
  - A failed run has `status: "failed"`, starts its warnings with `pipeline_failed:<stage>`,
    and keeps the manifest's `error` as before. `artifact` stays null until the artifact is
    written.
  - Pipeline codes: `media_probe_failed`, the caption codes above, the transcript-quality file
    codes (`no_word_timestamps`, `quantized_timestamps`, `punctuation_collapse:<a>-<b>`) plus
    `suspect_segments:<n>`, the audio and LLM codes above, then the selector's own codes.

### CLI

| Flag | Default |
|---|---|
| `--selection-mode v1\|v2-shadow\|v3` | stays `v1` for CLI compatibility; the dashboard sends `v3` |
| `--llm auto\|off\|required` | `auto` |
| `--cold-open` / `--no-cold-open` | on for v3 |
| `--hook-overlay` / `--no-hook-overlay` | on for v3 |
| `--caption-style classic\|karaoke` | karaoke for v3 |
| `--word-timestamps` / `--no-word-timestamps` | on |
| `--captions-dir DIR` | none; the worker passes `<input>/captions` when captions landed |
| `--hook-duration SECONDS` | 4.0 |

V3 uses `--min-duration`/`--max-duration`.

As implemented (`cli.py`):

- `--llm` is stored as `llm_mode`. The on/off flags use `argparse.BooleanOptionalAction`, and
  the last one given wins.
- `--caption-style` defaults to none, and `run_pipeline` resolves it per mode (karaoke for v3,
  classic otherwise), so an explicit `--caption-style karaoke` also works for V1.
- `--hook-duration` must be finite and in `(0, 30]`. Invalid values exit 2, like the existing
  flags.
- V1 and v2-shadow ignore the V3-only flags, so the legacy web command
  (`buildClipperInvocation` without the v3 block) parses exactly as before.
- For v3 the Whisper model loads lazily on the first transcription, so usable captions never
  load it. V1 and v2-shadow still load it before the pipeline starts.
- `LLMError` (for example `LLMUnavailable` under `--llm required`) exits 1 with
  `Error: <code>: <message>`, like the other pipeline errors.

### Benchmark

Gold files live in `docs/evaluation/gold/<source_id>.gold.json`: short labels and spans only,
never raw transcripts. A hit is IoU ≥ 0.3 or ≥ 50% coverage of the gold span.

```
python -m ai_clipper.benchmark --gold <gold.json> --transcript <transcript.json>
    [--audio-timeline <json>] --selector v1|v2-standard|v2-viral|v3-heuristic|v3-llm
    [--k 5 --k 10] [--min-duration 20 --max-duration 60] [--json out.json]
```

As implemented (guide: `docs/evaluation/SELECTION_BENCHMARK.md`):

- **CLI.**
  - `--gold`/`--transcript` pairs and `--selector` may be repeated. More than one of either
    requires `--compare`, which also prints pooled micro-average rows.
  - `--audio-timeline` is given zero times or once per pair.
  - Exit codes: 0 when every run completed, 1 when a selector run failed (others still run),
    2 for invalid input.
- **Built-in selectors.**
  - `v1`, returned in score (greedy pick) order.
  - `v2-standard`, `v2-viral` and `v2-deep`. These are text-only and use their profile bounds
    (`fixed_bounds`) instead of the CLI bounds.
- **V3 plugin hook.** `v3-heuristic` and `v3-llm` are registered from
  `ai_clipper.selection_v3.benchmark_selectors() -> Mapping[str, Selector | SelectorSpec]`.
  - A selector has the shape `fn(segments: list[TranscriptSegment], *, k: int, min_duration:
    float, max_duration: float, audio_timeline: AudioTimeline | None = None)`.
  - It returns spans in rank order, as `(start, end)` tuples or objects with `.start`/`.end`
    such as `SelectedClip`.
  - The benchmark calls it once with `k = max(K)`, so the top 5 must be a prefix of the top
    10.
  - `v3-llm` should raise when the LLM is unavailable. The run is then marked failed, env
    secrets are redacted, and the exit code is 1.
  - When the plugin fails to import, the "unknown selector" error names the (redacted) reason.
- **Transcripts** are read with `transcript_io.read_transcript_json`. A tolerant local reader
  is the fallback, and its use is flagged with the warning `transcript_io_rejected_input`.
- **Gold files.** `docs/evaluation/gold/` has Episode A (`Ive926sC6mc`) and three YouTube
  episodes (`0dzvz9JZFIM`, `DwTmRFyQ53E`, `rBg0ZcwjVKQ`), each with 12 moments and 6 traps.
  - Gold archetypes are free-form kebab-case, at most 64 characters.
  - Labels are at most 80 characters.

### Web artifact publication (implemented)

- `buildClipperInvocation` always passes `--artifact-root <attempt or job root>` for every
  selection mode. A phase 2 v3 block must not add it again.
- `publishAttemptAndComplete` publishes the attempt's `analysis/` for every mode, including
  `selection.v3.json`, `audio-timeline.json` and `transcript-quality.json`, together with
  `output/`.
  - For YouTube jobs it also publishes `input/` and rewrites `sourcePath`.
  - Foreign directories are moved to `.attempts/orphan.<name>.<uuid>`, never deleted.
  - `analysis/` contains a `.attempt-owner.json` marker, so code that lists `analysis/` must
    ignore dotfiles.
- Jobs completed before this fix still have their analysis stranded in
  `.attempts/<sha>/analysis`. A backfill has not been written.

## Evaluation protocol

- Episode A: `Ive926sC6mc`, the tuning set with 12 gold moments and 6 traps.
- Episode B: a held-out episode from the training-source registry with its own gold labels.
  Heuristic tuning must not use B.
- Success means V3-heuristic ≥ V1 on both episodes for Recall@5 and trap rate, and V3-LLM
  clearly above that when a key is available.
- The gold labels come from an LLM acting as an editor. They are a proxy, so the owner's own
  labels and real retention analytics supersede them.
