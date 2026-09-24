"""Gold-label benchmark for clip selectors.

A gold file (``docs/evaluation/gold/<source_id>.gold.json``) lists the moments a human (or an
LLM acting as an editor) would clip from one episode, plus "traps": spans that look attractive
to naive scorers but make bad clips. Gold files hold spans and short labels only, never raw
transcripts.

Every selector is a plain function registered by name. The benchmark calls it once with
``k = max(K)``, keeps the returned rank order, and scores the first K spans:

* a selection *hits* a gold span when IoU >= 0.3 or it covers >= 50% of the gold span;
* each gold moment counts once, however many selections hit it;
* recall@K = distinct gold moments hit / gold moments;
* precision@K = selections hitting any gold / selections considered;
* trap hits = selections hitting any trap (same hit rule).

Selectors that accept a ``context`` keyword also receive a :class:`SelectorContext` with the
episode's sound events (``--sound-events``) and LLM cache directory (``--llm-cache-dir``, by
default ``artifacts/eval/<source_id>/llm-cache``). A selector may return a Selection V3
``SelectionResult``: its clips are scored, its provenance (source, status, provider, model,
warnings, usage) is recorded, and the share of clips with a cold open is reported.

Run ``python -m ai_clipper.benchmark --help`` for the CLI.
"""

from __future__ import annotations

import argparse
import importlib
import inspect
import json
import math
import os
import re
import sys
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from numbers import Real
from pathlib import Path
from statistics import median
from typing import Protocol

from .candidates import generate_candidates, profile_duration_bounds
from .features import extract_features
from .highlight import select_highlights
from .models import ClipProfile, TranscriptSegment, TranscriptWord
from .ranking import RankedInput, rank_candidates_with_breakdowns
from .sound_events import SoundEvent, events_from_dict

BENCHMARK_VERSION = "selection-benchmark-v1"
GOLD_SCHEMA_VERSION = 1
REPORT_SCHEMA_VERSION = 1
HIT_MIN_IOU = 0.3
HIT_MIN_GOLD_COVERAGE = 0.5
DEFAULT_KS = (5, 10)
MAX_K = 1000
MAX_LABEL_CHARS = 80
MAX_INPUT_BYTES = 64 * 1024 * 1024
# Mirrors pipeline.DEFAULT_MAX_CANDIDATES so V2 is benchmarked exactly as it ships.
_V2_MAX_CANDIDATES = 200
_V2_SOURCE = "benchmark"
_EPSILON = 1e-9
_SAFE_SOURCE_ID = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
_SAFE_SPAN_ID = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"
_SAFE_SELECTOR_NAME = "abcdefghijklmnopqrstuvwxyz0123456789._-"
_GOLD_FIELDS = frozenset(
    {
        "schema_version",
        "source_id",
        "title",
        "duration_seconds",
        "labeler",
        "caveats",
        "moments",
        "traps",
    }
)
_MOMENT_FIELDS = frozenset({"id", "start", "end", "archetype", "label"})
_TRAP_FIELDS = frozenset({"id", "start", "end", "label"})
_TRANSCRIPT_IO_READERS = ("read_transcript_json", "read_transcript", "load_transcript")
# Optional modules that may expose ``benchmark_selectors() -> Mapping[str, Selector]``.
_OPTIONAL_SELECTOR_MODULES = ("selection_v3",)
_SECRET_ENV_MARKERS = ("KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL")
_MAX_ERROR_CHARS = 300
DEFAULT_LLM_CACHE_ROOT = Path("artifacts") / "eval"
_COMBINED_TAGS = re.compile(r"\]\s*\[")


class BenchmarkError(ValueError):
    """A sanitized benchmark input, selector, or output failure."""


# --- gold labels -----------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class GoldMoment:
    """One span an editor would clip; list order in the gold file is the editorial rank."""

    id: str
    start: float
    end: float
    archetype: str
    label: str

    def __post_init__(self) -> None:
        _check_span_fields(self.id, self.start, self.end, self.label, "gold moment")
        _check_text(self.archetype, "gold moment archetype", 64)
        object.__setattr__(self, "start", float(self.start))
        object.__setattr__(self, "end", float(self.end))


@dataclass(frozen=True, slots=True)
class GoldTrap:
    """A span that looks clip-worthy to naive scorers but should not be selected."""

    id: str
    start: float
    end: float
    label: str

    def __post_init__(self) -> None:
        _check_span_fields(self.id, self.start, self.end, self.label, "gold trap")
        object.__setattr__(self, "start", float(self.start))
        object.__setattr__(self, "end", float(self.end))


@dataclass(frozen=True, slots=True)
class GoldSet:
    schema_version: int
    source_id: str
    title: str
    duration_seconds: float
    labeler: str
    caveats: tuple[str, ...]
    moments: tuple[GoldMoment, ...]
    traps: tuple[GoldTrap, ...]

    def __post_init__(self) -> None:
        if self.schema_version != GOLD_SCHEMA_VERSION:
            raise BenchmarkError(f"gold schema_version must be {GOLD_SCHEMA_VERSION}")
        if not _is_safe_id(self.source_id, _SAFE_SOURCE_ID, 128):
            raise BenchmarkError("gold source_id must be a safe identifier")
        _check_text(self.title, "gold title", 200)
        _check_text(self.labeler, "gold labeler", 200)
        if not _is_number(self.duration_seconds) or not math.isfinite(self.duration_seconds):
            raise BenchmarkError("gold duration_seconds must be a finite number")
        if self.duration_seconds <= 0:
            raise BenchmarkError("gold duration_seconds must be positive")
        object.__setattr__(self, "duration_seconds", float(self.duration_seconds))
        if not isinstance(self.caveats, tuple):
            raise BenchmarkError("gold caveats must be a tuple")
        for caveat in self.caveats:
            _check_text(caveat, "gold caveat", 1000)
        if not isinstance(self.moments, tuple) or not self.moments:
            raise BenchmarkError("gold must contain at least one moment")
        if any(not isinstance(moment, GoldMoment) for moment in self.moments):
            raise BenchmarkError("gold moments must be GoldMoment values")
        if not isinstance(self.traps, tuple) or any(
            not isinstance(trap, GoldTrap) for trap in self.traps
        ):
            raise BenchmarkError("gold traps must be a tuple of GoldTrap values")
        spans = (*self.moments, *self.traps)
        ids = [span.id for span in spans]
        if len(set(ids)) != len(ids):
            raise BenchmarkError("gold moment and trap IDs must be unique")
        intervals = [(span.start, span.end) for span in spans]
        if len(set(intervals)) != len(intervals):
            raise BenchmarkError("gold moments and traps must not repeat the same span")
        if any(span.end > self.duration_seconds for span in spans):
            raise BenchmarkError("gold spans must end within duration_seconds")


def _is_number(value: object) -> bool:
    return isinstance(value, Real) and not isinstance(value, bool)


def _is_safe_id(value: object, alphabet: str, limit: int) -> bool:
    return (
        isinstance(value, str)
        and 0 < len(value) <= limit
        and value[0].isalnum()
        and all(character in alphabet for character in value)
    )


def _check_text(value: object, name: str, limit: int) -> None:
    if not isinstance(value, str) or not value.strip():
        raise BenchmarkError(f"{name} must be a non-empty string")
    if len(value) > limit:
        raise BenchmarkError(f"{name} must be at most {limit} characters")


def _check_span_fields(
    span_id: object, start: object, end: object, label: object, name: str
) -> None:
    if not _is_safe_id(span_id, _SAFE_SPAN_ID, 32) or not str(span_id)[0].isalpha():
        raise BenchmarkError(f"{name} id must be a short identifier such as G1 or T1")
    if not _is_number(start) or not _is_number(end):
        raise BenchmarkError(f"{name} {span_id} start and end must be numbers")
    if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
        raise BenchmarkError(f"{name} {span_id} must satisfy 0 <= start < end")
    _check_text(label, f"{name} {span_id} label", MAX_LABEL_CHARS)


def _exact_object(value: object, fields: frozenset[str], name: str) -> dict[str, object]:
    if type(value) is not dict:
        raise BenchmarkError(f"{name} must be a JSON object")
    if set(value) != fields:
        missing = sorted(fields - set(value))
        unknown = sorted(set(value) - fields)
        raise BenchmarkError(f"{name} has missing {missing} or unknown {unknown} fields")
    return value


def parse_gold(payload: object) -> GoldSet:
    """Validate a decoded gold document; unknown or missing fields are errors."""
    document = _exact_object(payload, _GOLD_FIELDS, "gold")
    schema_version = document["schema_version"]
    if type(schema_version) is not int:
        raise BenchmarkError("gold schema_version must be an integer")
    for key in ("caveats", "moments", "traps"):
        if type(document[key]) is not list:
            raise BenchmarkError(f"gold {key} must be a list")
    moments = []
    for index, raw in enumerate(document["moments"]):
        item = _exact_object(raw, _MOMENT_FIELDS, f"gold moment {index}")
        moments.append(
            GoldMoment(item["id"], item["start"], item["end"], item["archetype"], item["label"])
        )
    traps = []
    for index, raw in enumerate(document["traps"]):
        item = _exact_object(raw, _TRAP_FIELDS, f"gold trap {index}")
        traps.append(GoldTrap(item["id"], item["start"], item["end"], item["label"]))
    return GoldSet(
        schema_version=schema_version,
        source_id=document["source_id"],
        title=document["title"],
        duration_seconds=document["duration_seconds"],
        labeler=document["labeler"],
        caveats=tuple(document["caveats"]),
        moments=tuple(moments),
        traps=tuple(traps),
    )


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise BenchmarkError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _reject_constant(value: str) -> object:
    raise BenchmarkError(f"non-finite JSON constant is not allowed: {value}")


def _read_json(path: Path, label: str) -> object:
    try:
        if path.stat().st_size > MAX_INPUT_BYTES:
            raise BenchmarkError(f"{label} file is larger than {MAX_INPUT_BYTES} bytes")
        raw = path.read_bytes()
    except OSError as error:
        raise BenchmarkError(f"cannot read {label} file: {path.name}") from error
    try:
        return json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BenchmarkError(f"{label} file is not valid UTF-8 JSON: {path.name}") from error


def load_gold(path: str | Path) -> GoldSet:
    """Read and strictly validate one gold file."""
    return parse_gold(_read_json(Path(path), "gold"))


# --- transcripts -----------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class LoadedTranscript:
    segments: tuple[TranscriptSegment, ...]
    language: str | None
    reader: str  # "transcript_io" | "fallback"
    warnings: tuple[str, ...] = ()

    @property
    def has_word_timestamps(self) -> bool:
        return any(segment.words for segment in self.segments)


def _transcript_io_reader() -> Callable[[Path], object] | None:
    try:
        module = importlib.import_module(f"{__package__}.transcript_io")
    except Exception:  # noqa: BLE001 - the shared reader is optional while it is being built
        return None
    for name in _TRANSCRIPT_IO_READERS:
        reader = getattr(module, name, None)
        if callable(reader):
            return reader
    return None


def _segments_from_reader(result: object) -> tuple[tuple[TranscriptSegment, ...], str | None]:
    language = getattr(result, "language", None)
    segments = getattr(result, "segments", None)
    if segments is None and isinstance(result, tuple) and len(result) == 2:
        language, segments = result
    if segments is None:
        segments = result
    if not isinstance(segments, (list, tuple)) or any(
        not isinstance(segment, TranscriptSegment) for segment in segments
    ):
        raise BenchmarkError("transcript_io returned an unexpected value")
    if not segments:
        raise BenchmarkError("transcript has no usable segments")
    return tuple(segments), language if isinstance(language, str) else None


def _parse_words(raw_words: object, index: int) -> tuple[tuple[TranscriptWord, ...], int]:
    if raw_words is None:
        return (), 0
    if type(raw_words) is not list:
        raise BenchmarkError(f"transcript segment {index} words must be a list")
    words: list[TranscriptWord] = []
    skipped = 0
    for raw in raw_words:
        if type(raw) is not dict:
            skipped += 1
            continue
        text = raw.get("text", raw.get("word"))
        try:
            words.append(
                TranscriptWord(
                    raw.get("start"),
                    raw.get("end"),
                    text.strip() if isinstance(text, str) else text,
                    raw.get("probability"),
                )
            )
        except (TypeError, ValueError):
            skipped += 1
    words.sort(key=lambda word: (word.start, word.end))
    return tuple(words), skipped


def _read_transcript_fallback(path: Path) -> LoadedTranscript:
    payload = _read_json(path, "transcript")
    language: str | None = None
    if type(payload) is dict:
        raw_segments = payload.get("segments")
        language = payload.get("language") if isinstance(payload.get("language"), str) else None
    else:
        raw_segments = payload
    if type(raw_segments) is not list:
        raise BenchmarkError("transcript must be an object with a segments list")
    segments: list[TranscriptSegment] = []
    skipped_segments = 0
    skipped_words = 0
    for index, raw in enumerate(raw_segments):
        if type(raw) is not dict:
            raise BenchmarkError(f"transcript segment {index} must be an object")
        start, end, text = raw.get("start"), raw.get("end"), raw.get("text")
        if not _is_number(start) or not _is_number(end) or not isinstance(text, str):
            raise BenchmarkError(f"transcript segment {index} needs numeric start/end and text")
        if not math.isfinite(start) or not math.isfinite(end):
            raise BenchmarkError(f"transcript segment {index} timestamps must be finite")
        if not text.strip() or end <= start:
            skipped_segments += 1
            continue
        words, skipped = _parse_words(raw.get("words"), index)
        skipped_words += skipped
        try:
            segments.append(TranscriptSegment(float(start), float(end), text.strip(), words))
        except (TypeError, ValueError) as error:
            raise BenchmarkError(f"transcript segment {index} is invalid") from error
    if not segments:
        raise BenchmarkError("transcript has no usable segments")
    warnings = []
    if skipped_segments:
        warnings.append(f"skipped_segments:{skipped_segments}")
    if skipped_words:
        warnings.append(f"skipped_words:{skipped_words}")
    return LoadedTranscript(tuple(segments), language, "fallback", tuple(warnings))


def load_transcript(path: str | Path) -> LoadedTranscript:
    """Read a transcript with optional word timings.

    ``ai_clipper.transcript_io`` is preferred when it imports; the local tolerant reader is the
    fallback, and is also used (with a warning) when the shared reader rejects the file.
    """
    path = Path(path)
    reader = _transcript_io_reader()
    if reader is None:
        return _read_transcript_fallback(path)
    try:
        segments, language = _segments_from_reader(reader(path))
    except Exception:  # noqa: BLE001 - retry with the tolerant local reader
        fallback = _read_transcript_fallback(path)
        return LoadedTranscript(
            fallback.segments,
            fallback.language,
            fallback.reader,
            ("transcript_io_rejected_input", *fallback.warnings),
        )
    return LoadedTranscript(segments, language, "transcript_io")


def load_audio_timeline(path: str | Path) -> object:
    """Read an audio timeline with ``ai_clipper.audio_timeline`` when that module exists."""
    try:
        module = importlib.import_module(f"{__package__}.audio_timeline")
        reader = module.read_audio_timeline
    except Exception as error:
        raise BenchmarkError(
            "audio timeline support (ai_clipper.audio_timeline) is unavailable"
        ) from error
    try:
        return reader(Path(path))
    except Exception as error:
        raise BenchmarkError(f"audio timeline file is invalid: {Path(path).name}") from error


def _legacy_sound_events(payload: object) -> tuple[SoundEvent, ...]:
    """``{"source", "events": [{"time", "label"}]}`` from the first caption converter."""
    if type(payload) is not dict or type(payload.get("events")) is not list:
        raise BenchmarkError("sound events must be an object with an events list")
    events = []
    for item in payload["events"]:
        if type(item) is not dict or not isinstance(item.get("label"), str):
            raise BenchmarkError("each sound event needs a time and a label")
        for label in _COMBINED_TAGS.split(item["label"]):
            try:
                events.append(SoundEvent.from_label(item.get("time"), label))
            except (TypeError, ValueError):
                continue  # unreadable tags are skipped, like the caption parser does
    return tuple(sorted(events, key=lambda event: (event.time, event.kind, event.label)))


def load_sound_events(path: str | Path) -> tuple[SoundEvent, ...]:
    """Read ``analysis/sound-events.json`` (``sound-events-v1``) or the legacy converter format."""
    payload = _read_json(Path(path), "sound events")
    if type(payload) is dict and "version" in payload:
        try:
            return events_from_dict(payload)[0]
        except (TypeError, ValueError) as error:
            raise BenchmarkError(f"sound events file is invalid: {Path(path).name}") from error
    return _legacy_sound_events(payload)


# --- selectors -------------------------------------------------------------------------------


class Selector(Protocol):
    def __call__(
        self,
        segments: list[TranscriptSegment],
        *,
        k: int,
        min_duration: float,
        max_duration: float,
        audio_timeline: object | None = None,
    ) -> Sequence[tuple[float, float]]: ...


@dataclass(frozen=True, slots=True)
class SelectorContext:
    """Per-episode extras for selectors that declare a ``context`` keyword argument."""

    source_id: str
    sound_events: tuple[SoundEvent, ...] = ()
    llm_cache_dir: Path | None = None


def _accepts_context(fn: Callable[..., object]) -> bool:
    try:
        parameters = inspect.signature(fn).parameters.values()
    except (TypeError, ValueError):
        return False
    return any(
        parameter.kind is inspect.Parameter.VAR_KEYWORD
        or (parameter.name == "context" and parameter.kind is not inspect.Parameter.POSITIONAL_ONLY)
        for parameter in parameters
    )


@dataclass(frozen=True, slots=True)
class SelectorSpec:
    """A named selector; ``fixed_bounds`` is set when it ignores the CLI duration bounds."""

    name: str
    fn: Selector
    description: str = ""
    fixed_bounds: tuple[float, float] | None = None

    def __post_init__(self) -> None:
        if not _is_safe_id(self.name, _SAFE_SELECTOR_NAME, 64):
            raise BenchmarkError("selector name must be lowercase letters, digits, '.', '_', '-'")
        if not callable(self.fn):
            raise BenchmarkError("selector must be callable")
        if not isinstance(self.description, str):
            raise BenchmarkError("selector description must be a string")
        if self.fixed_bounds is not None:
            _validate_bounds(*self.fixed_bounds)


_SELECTORS: dict[str, SelectorSpec] = {}
# Optional selector modules that failed to import or to list selectors: module -> error type.
_PLUGIN_FAILURES: dict[str, str] = {}


def register_selector(
    name: str,
    fn: Selector,
    *,
    description: str = "",
    fixed_bounds: tuple[float, float] | None = None,
    replace: bool = False,
) -> SelectorSpec:
    """Register ``fn`` under ``name``; an existing name needs ``replace=True``."""
    spec = SelectorSpec(name, fn, description, fixed_bounds)
    if name in _SELECTORS and not replace:
        raise BenchmarkError(f"selector already registered: {name}")
    _SELECTORS[name] = spec
    return spec


def get_selector(name: str) -> SelectorSpec:
    try:
        return _SELECTORS[name]
    except KeyError:
        available = ", ".join(sorted(_SELECTORS))
        failures = "".join(
            f"; optional module {module} unavailable ({error})"
            for module, error in sorted(_PLUGIN_FAILURES.items())
        )
        raise BenchmarkError(
            f"unknown selector: {name} (available: {available}){failures}"
        ) from None


def available_selectors() -> tuple[str, ...]:
    return tuple(sorted(_SELECTORS))


def load_optional_selectors() -> tuple[str, ...]:
    """Register selectors from optional modules that expose ``benchmark_selectors()``.

    The mapping values may be plain selector functions or ``SelectorSpec`` values. Names that
    are already registered are kept, so built-ins cannot be shadowed by accident.
    """
    loaded: list[str] = []
    for module_name in _OPTIONAL_SELECTOR_MODULES:
        try:
            module = importlib.import_module(f"{__package__}.{module_name}")
            provider = getattr(module, "benchmark_selectors", None)
            selectors = provider() if callable(provider) else None
        except Exception as error:  # noqa: BLE001 - optional plugins must not break the benchmark
            # Keep the (secret-redacted, bounded) reason: "ImportError" alone hides the bug.
            _PLUGIN_FAILURES[module_name] = _failure_message(error)
            continue
        if not isinstance(selectors, Mapping):
            _PLUGIN_FAILURES[module_name] = "no benchmark_selectors() mapping"
            continue
        _PLUGIN_FAILURES.pop(module_name, None)
        for name, value in selectors.items():
            if name in _SELECTORS:
                continue
            try:
                if isinstance(value, SelectorSpec):
                    register_selector(
                        name,
                        value.fn,
                        description=value.description,
                        fixed_bounds=value.fixed_bounds,
                    )
                else:
                    register_selector(name, value, description=f"{module_name}.{name}")
            except BenchmarkError:
                continue
            loaded.append(name)
    return tuple(loaded)


def _select_v1(
    segments: list[TranscriptSegment],
    *,
    k: int,
    min_duration: float,
    max_duration: float,
    audio_timeline: object | None = None,
) -> list[tuple[float, float]]:
    highlights = select_highlights(
        segments, min_duration=min_duration, max_duration=max_duration, limit=k
    )
    # select_highlights returns chronological order; its greedy pick order is (-score, start).
    ranked = sorted(highlights, key=lambda highlight: (-highlight.score, highlight.start))
    return [(highlight.start, highlight.end) for highlight in ranked]


def _v2_selector(profile: ClipProfile) -> Selector:
    def select(
        segments: list[TranscriptSegment],
        *,
        k: int,
        min_duration: float,
        max_duration: float,
        audio_timeline: object | None = None,
    ) -> list[tuple[float, float]]:
        # V2 profiles own their duration bounds, and this path is text-only (no media rerank).
        boundaries = generate_candidates(segments, profile, max_candidates=_V2_MAX_CANDIDATES)
        if not boundaries:
            return []
        inputs = [
            RankedInput(
                f"{candidate.start_index}:{candidate.end_index}",
                candidate,
                extract_features(candidate),
            )
            for candidate in boundaries
        ]
        selection = rank_candidates_with_breakdowns(
            inputs, source=_V2_SOURCE, profile=profile, k=min(k, len(inputs))
        )
        ranked = sorted(selection.candidates, key=lambda candidate: candidate.rank or 0)
        return [(candidate.start, candidate.end) for candidate in ranked]

    return select


def _register_builtins() -> None:
    register_selector(
        "v1",
        _select_v1,
        description="highlight.select_highlights (keyword score), rank order by score",
    )
    for name, profile in (
        ("v2-standard", ClipProfile.STANDARD),
        ("v2-viral", ClipProfile.VIRAL_SHORT),
        ("v2-deep", ClipProfile.DEEP_DIVE),
    ):
        register_selector(
            name,
            _v2_selector(profile),
            description=f"V2 {profile.value}: candidates -> features -> ranking (text only)",
            fixed_bounds=profile_duration_bounds(profile),
        )


# --- metrics ---------------------------------------------------------------------------------


def _intersection(first: tuple[float, float], second: tuple[float, float]) -> float:
    return max(0.0, min(first[1], second[1]) - max(first[0], second[0]))


def iou(first: tuple[float, float], second: tuple[float, float]) -> float:
    """Temporal intersection over union of two spans."""
    overlap = _intersection(first, second)
    if overlap <= 0:
        return 0.0
    return overlap / (max(first[1], second[1]) - min(first[0], second[0]))


def coverage(selection: tuple[float, float], gold: tuple[float, float]) -> float:
    """Share of the gold span that the selection covers."""
    return _intersection(selection, gold) / (gold[1] - gold[0])


def is_hit(selection: tuple[float, float], gold: tuple[float, float]) -> bool:
    return (
        iou(selection, gold) >= HIT_MIN_IOU - _EPSILON
        or coverage(selection, gold) >= HIT_MIN_GOLD_COVERAGE - _EPSILON
    )


@dataclass(frozen=True, slots=True)
class SelectionMatch:
    """One ranked selection and the gold/trap spans it hits."""

    rank: int
    start: float
    end: float
    gold_ids: tuple[str, ...]
    trap_ids: tuple[str, ...]
    best_iou: float  # highest IoU with any gold moment, hit or not
    best_gold_id: str | None  # the hit gold with the highest IoU
    start_offset: float | None  # start - best_gold.start (positive = starts late)
    cold_open: bool | None = None  # None when the selector does not report cold opens

    @property
    def duration(self) -> float:
        return self.end - self.start


@dataclass(frozen=True, slots=True)
class KMetrics:
    k: int
    considered: int
    gold_count: int
    hits: int
    recall: float
    hit_selections: int
    precision: float
    duplicate_hits: int  # selections that only re-hit gold already hit at a better rank
    trap_hits: int
    trap_rate: float
    trap_ids: tuple[str, ...]
    mean_best_iou: float
    gold_first_hit_rank: tuple[tuple[str, int], ...]  # (gold id, first hitting rank) by rank
    start_offsets: tuple[float, ...]
    start_offset_median: float | None
    start_offset_mean_abs: float | None
    duration_min: float | None
    duration_median: float | None
    duration_max: float | None
    cold_open_share: float | None = None  # share of selections with a cold open, if reported


def validate_ks(ks: Iterable[object]) -> tuple[int, ...]:
    values = list(ks)
    if not values:
        raise BenchmarkError("at least one K is required")
    for value in values:
        if type(value) is not int or not 1 <= value <= MAX_K:
            raise BenchmarkError(f"K must be an integer between 1 and {MAX_K}")
    if len(set(values)) != len(values):
        raise BenchmarkError("K values must be unique")
    return tuple(sorted(values))


def _validate_bounds(min_duration: object, max_duration: object) -> tuple[float, float]:
    if not _is_number(min_duration) or not _is_number(max_duration):
        raise BenchmarkError("duration bounds must be numbers")
    if not math.isfinite(min_duration) or not math.isfinite(max_duration):
        raise BenchmarkError("duration bounds must be finite")
    if min_duration <= 0 or max_duration < min_duration:
        raise BenchmarkError("duration bounds must satisfy 0 < min <= max")
    return float(min_duration), float(max_duration)


def _validate_spans(raw: object) -> tuple[tuple[float, float], ...]:
    if isinstance(raw, (str, bytes)) or not isinstance(raw, Sequence):
        raise BenchmarkError("selector must return a sequence of (start, end) spans")
    spans: list[tuple[float, float]] = []
    for rank, item in enumerate(raw, 1):
        if hasattr(item, "start") and hasattr(item, "end"):
            start, end = item.start, item.end
        elif isinstance(item, Sequence) and not isinstance(item, (str, bytes)) and len(item) == 2:
            start, end = item
        else:
            raise BenchmarkError(f"selection {rank} must be a (start, end) pair")
        if not _is_number(start) or not _is_number(end):
            raise BenchmarkError(f"selection {rank} start and end must be numbers")
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
            raise BenchmarkError(f"selection {rank} must satisfy 0 <= start < end")
        spans.append((float(start), float(end)))
    return tuple(spans)


def _cold_open_flags(raw: object, count: int) -> tuple[bool | None, ...]:
    """Per selection: whether it has a cold open, or None when the value has no such field."""
    if isinstance(raw, (str, bytes)) or not isinstance(raw, Sequence):
        return (None,) * count
    flags = []
    for item in list(raw)[:count]:
        flags.append(None if not hasattr(item, "cold_open") else item.cold_open is not None)
    return tuple(flags) + (None,) * (count - len(flags))


def _match(
    rank: int, span: tuple[float, float], gold: GoldSet, cold_open: bool | None = None
) -> SelectionMatch:
    hit_moments = [moment for moment in gold.moments if is_hit(span, (moment.start, moment.end))]
    trap_ids = tuple(trap.id for trap in gold.traps if is_hit(span, (trap.start, trap.end)))
    best_iou = max(iou(span, (moment.start, moment.end)) for moment in gold.moments)
    best = None
    if hit_moments:
        # max() keeps the first maximum, so ties resolve to the better-ranked gold moment.
        best = max(hit_moments, key=lambda moment: iou(span, (moment.start, moment.end)))
    return SelectionMatch(
        rank=rank,
        start=span[0],
        end=span[1],
        gold_ids=tuple(moment.id for moment in hit_moments),
        trap_ids=trap_ids,
        best_iou=best_iou,
        best_gold_id=None if best is None else best.id,
        start_offset=None if best is None else span[0] - best.start,
        cold_open=cold_open,
    )


def _metrics_at(k: int, matches: Sequence[SelectionMatch], gold: GoldSet) -> KMetrics:
    top = list(matches[:k])
    considered = len(top)
    first_hit: dict[str, int] = {}
    duplicate_hits = 0
    for match in top:
        new = [gold_id for gold_id in match.gold_ids if gold_id not in first_hit]
        if match.gold_ids and not new:
            duplicate_hits += 1
        for gold_id in new:
            first_hit[gold_id] = match.rank
    gold_order = {moment.id: index for index, moment in enumerate(gold.moments)}
    hit_selections = sum(1 for match in top if match.gold_ids)
    trapped = [match for match in top if match.trap_ids]
    trap_ids = tuple(dict.fromkeys(trap_id for match in trapped for trap_id in match.trap_ids))
    best_ious = [
        max(
            (iou((match.start, match.end), (moment.start, moment.end)) for match in top),
            default=0.0,
        )
        for moment in gold.moments
    ]
    offsets = tuple(match.start_offset for match in top if match.start_offset is not None)
    durations = [match.duration for match in top]
    flags = [match.cold_open for match in top]
    cold_open_share = (
        sum(bool(flag) for flag in flags) / len(flags)
        if flags and all(flag is not None for flag in flags)
        else None
    )
    return KMetrics(
        k=k,
        considered=considered,
        gold_count=len(gold.moments),
        hits=len(first_hit),
        recall=len(first_hit) / len(gold.moments),
        hit_selections=hit_selections,
        precision=hit_selections / considered if considered else 0.0,
        duplicate_hits=duplicate_hits,
        trap_hits=len(trapped),
        trap_rate=len(trapped) / considered if considered else 0.0,
        trap_ids=trap_ids,
        mean_best_iou=sum(best_ious) / len(best_ious),
        gold_first_hit_rank=tuple(
            sorted(first_hit.items(), key=lambda item: (item[1], gold_order[item[0]]))
        ),
        start_offsets=offsets,
        start_offset_median=median(offsets) if offsets else None,
        start_offset_mean_abs=sum(abs(value) for value in offsets) / len(offsets)
        if offsets
        else None,
        duration_min=min(durations) if durations else None,
        duration_median=median(durations) if durations else None,
        duration_max=max(durations) if durations else None,
        cold_open_share=cold_open_share,
    )


def evaluate_selections(
    gold: GoldSet, selections: object, *, ks: Iterable[object] = DEFAULT_KS
) -> tuple[tuple[SelectionMatch, ...], tuple[KMetrics, ...]]:
    """Score ranked selections against a gold set at every K."""
    checked_ks = validate_ks(ks)
    spans = _validate_spans(selections)
    flags = _cold_open_flags(selections, len(spans))
    matches = tuple(_match(rank, span, gold, flags[rank - 1]) for rank, span in enumerate(spans, 1))
    return matches, tuple(_metrics_at(k, matches, gold) for k in checked_ks)


# --- runs ------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class BenchmarkRun:
    source_id: str
    selector: str
    status: str  # "completed" | "failed"
    error: str | None
    duration_bounds: tuple[float, float]
    bounds_source: str  # "cli" | "selector"
    gold_count: int
    trap_count: int
    selections: tuple[SelectionMatch, ...]
    metrics: tuple[KMetrics, ...]
    elapsed_seconds: float
    selector_info: Mapping[str, object] | None = None  # provenance of a SelectionResult


def _redact(text: str, env: Mapping[str, str] | None = None) -> str:
    """Remove secret-looking environment values from a message and bound its length."""
    environment = os.environ if env is None else env
    for name, value in environment.items():
        if len(value) >= 6 and any(marker in name.upper() for marker in _SECRET_ENV_MARKERS):
            text = text.replace(value, "[redacted]")
    return text[:_MAX_ERROR_CHARS]


def _failure_message(error: BaseException) -> str:
    return _redact(f"{type(error).__name__}: {error}")


def _is_selection_result(value: object) -> bool:
    return (
        not isinstance(value, (str, bytes, Sequence))
        and hasattr(value, "clips")
        and hasattr(value, "source")
        and hasattr(value, "status")
    )


def _selection_info(result: object) -> dict[str, object]:
    """Provenance of a Selection V3 result (codes and names only, secrets redacted)."""

    def text(value: object) -> str | None:
        return None if value is None else _redact(str(value))

    usage = getattr(result, "usage", {}) or {}
    return {
        "source": text(getattr(result, "source", None)),
        "status": text(getattr(result, "status", None)),
        "provider": text(getattr(result, "provider", None)),
        "model": text(getattr(result, "model", None)),
        "prompt_version": text(getattr(result, "prompt_version", None)),
        "warnings": [_redact(str(item)) for item in getattr(result, "warnings", ())],
        "usage": {
            str(key): value
            for key, value in dict(usage).items()
            if isinstance(value, int) and not isinstance(value, bool)
        },
    }


def run_benchmark(
    gold: GoldSet,
    segments: Sequence[TranscriptSegment],
    selector: str,
    *,
    ks: Iterable[object] = DEFAULT_KS,
    min_duration: float = 20.0,
    max_duration: float = 60.0,
    audio_timeline: object | None = None,
    context: SelectorContext | None = None,
) -> BenchmarkRun:
    """Run one registered selector once with ``k = max(K)`` and score it.

    Input errors raise ``BenchmarkError``; a selector that raises or returns invalid spans
    produces a ``failed`` run with a sanitized error so a comparison can continue. ``context``
    is passed only to selectors that declare a ``context`` keyword.
    """
    checked_ks = validate_ks(ks)
    bounds = _validate_bounds(min_duration, max_duration)
    spec = get_selector(selector)
    if context is not None and not isinstance(context, SelectorContext):
        raise BenchmarkError("context must be a SelectorContext")
    effective = spec.fixed_bounds or bounds
    extra = {"context": context} if context is not None and _accepts_context(spec.fn) else {}
    info: dict[str, object] | None = None
    started = time.perf_counter()
    try:
        raw = spec.fn(
            list(segments),
            k=max(checked_ks),
            min_duration=bounds[0],
            max_duration=bounds[1],
            audio_timeline=audio_timeline,
            **extra,
        )
        if _is_selection_result(raw):
            info = _selection_info(raw)
            raw = raw.clips
        top = list(raw)[: max(checked_ks)] if isinstance(raw, Sequence) else raw
        _validate_spans(raw)
        matches, metrics = evaluate_selections(gold, top, ks=checked_ks)
        status, error = "completed", None
    except Exception as failure:  # noqa: BLE001 - selector failures are reported, not raised
        matches, metrics = (), ()
        status, error = "failed", _failure_message(failure)
    return BenchmarkRun(
        source_id=gold.source_id,
        selector=spec.name,
        status=status,
        error=error,
        duration_bounds=effective,
        bounds_source="selector" if spec.fixed_bounds else "cli",
        gold_count=len(gold.moments),
        trap_count=len(gold.traps),
        selections=matches,
        metrics=metrics,
        elapsed_seconds=time.perf_counter() - started,
        selector_info=info,
    )


@dataclass(frozen=True, slots=True)
class PooledMetrics:
    """Micro-averaged metrics for one selector over every completed episode."""

    selector: str
    k: int
    episodes: int
    gold: int
    hits: int
    recall: float
    considered: int
    hit_selections: int
    precision: float
    trap_hits: int
    trap_rate: float
    mean_best_iou: float


def pool_runs(runs: Sequence[BenchmarkRun]) -> tuple[PooledMetrics, ...]:
    grouped: dict[tuple[str, int], list[KMetrics]] = {}
    for run in runs:
        if run.status != "completed":
            continue
        for metric in run.metrics:
            grouped.setdefault((run.selector, metric.k), []).append(metric)
    pooled = []
    for (selector, k), metrics in grouped.items():
        gold = sum(metric.gold_count for metric in metrics)
        hits = sum(metric.hits for metric in metrics)
        considered = sum(metric.considered for metric in metrics)
        hit_selections = sum(metric.hit_selections for metric in metrics)
        trap_hits = sum(metric.trap_hits for metric in metrics)
        pooled.append(
            PooledMetrics(
                selector=selector,
                k=k,
                episodes=len(metrics),
                gold=gold,
                hits=hits,
                recall=hits / gold,
                considered=considered,
                hit_selections=hit_selections,
                precision=hit_selections / considered if considered else 0.0,
                trap_hits=trap_hits,
                trap_rate=trap_hits / considered if considered else 0.0,
                mean_best_iou=sum(metric.mean_best_iou * metric.gold_count for metric in metrics)
                / gold,
            )
        )
    return tuple(pooled)


# --- reporting -------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Episode:
    gold: GoldSet
    transcript: LoadedTranscript
    audio_timeline: object | None = None
    warnings: tuple[str, ...] = ()
    context: SelectorContext | None = None


def _round(value: float | None) -> float | None:
    return None if value is None else round(value, 6)


def _metrics_dict(metric: KMetrics) -> dict[str, object]:
    return {
        "k": metric.k,
        "considered": metric.considered,
        "gold_count": metric.gold_count,
        "hits": metric.hits,
        "recall": _round(metric.recall),
        "hit_selections": metric.hit_selections,
        "precision": _round(metric.precision),
        "duplicate_hits": metric.duplicate_hits,
        "trap_hits": metric.trap_hits,
        "trap_rate": _round(metric.trap_rate),
        "trap_ids": list(metric.trap_ids),
        "mean_best_iou": _round(metric.mean_best_iou),
        "gold_first_hit_rank": dict(metric.gold_first_hit_rank),
        "start_offsets": [_round(value) for value in metric.start_offsets],
        "start_offset_median": _round(metric.start_offset_median),
        "start_offset_mean_abs": _round(metric.start_offset_mean_abs),
        "duration_min": _round(metric.duration_min),
        "duration_median": _round(metric.duration_median),
        "duration_max": _round(metric.duration_max),
        "cold_open_share": _round(metric.cold_open_share),
    }


def _run_dict(run: BenchmarkRun) -> dict[str, object]:
    return {
        "source_id": run.source_id,
        "selector": run.selector,
        "status": run.status,
        "error": run.error,
        "duration_bounds": list(run.duration_bounds),
        "bounds_source": run.bounds_source,
        "gold_count": run.gold_count,
        "trap_count": run.trap_count,
        "elapsed_seconds": round(run.elapsed_seconds, 3),
        "selector_info": None if run.selector_info is None else dict(run.selector_info),
        "selections": [
            {
                "rank": match.rank,
                "start": _round(match.start),
                "end": _round(match.end),
                "duration": _round(match.duration),
                "gold_hits": list(match.gold_ids),
                "trap_hits": list(match.trap_ids),
                "best_gold": match.best_gold_id,
                "best_iou": _round(match.best_iou),
                "start_offset": _round(match.start_offset),
                "cold_open": match.cold_open,
            }
            for match in run.selections
        ],
        "metrics": [_metrics_dict(metric) for metric in run.metrics],
    }


def report_dict(
    episodes: Sequence[Episode], runs: Sequence[BenchmarkRun], ks: Sequence[int]
) -> dict[str, object]:
    """Build the JSON report: spans, IDs and metrics only, never transcript text."""
    return {
        "schema_version": REPORT_SCHEMA_VERSION,
        "benchmark_version": BENCHMARK_VERSION,
        "hit_rule": {"min_iou": HIT_MIN_IOU, "min_gold_coverage": HIT_MIN_GOLD_COVERAGE},
        "ks": list(ks),
        "episodes": [
            {
                "source_id": episode.gold.source_id,
                "title": episode.gold.title,
                "labeler": episode.gold.labeler,
                "gold_count": len(episode.gold.moments),
                "trap_count": len(episode.gold.traps),
                "transcript_reader": episode.transcript.reader,
                "transcript_segments": len(episode.transcript.segments),
                "has_word_timestamps": episode.transcript.has_word_timestamps,
                "audio_timeline": episode.audio_timeline is not None,
                "sound_events": 0 if episode.context is None else len(episode.context.sound_events),
                "llm_cache": episode.context is not None
                and episode.context.llm_cache_dir is not None,
                "warnings": [*episode.transcript.warnings, *episode.warnings],
            }
            for episode in episodes
        ],
        "runs": [_run_dict(run) for run in runs],
        "pooled": [
            {
                "selector": row.selector,
                "k": row.k,
                "episodes": row.episodes,
                "gold": row.gold,
                "hits": row.hits,
                "recall": _round(row.recall),
                "considered": row.considered,
                "hit_selections": row.hit_selections,
                "precision": _round(row.precision),
                "trap_hits": row.trap_hits,
                "trap_rate": _round(row.trap_rate),
                "mean_best_iou": _round(row.mean_best_iou),
            }
            for row in pool_runs(runs)
        ],
    }


def _clock(seconds: float) -> str:
    minutes, rest = divmod(seconds, 60.0)
    return f"{int(minutes):02d}:{rest:04.1f}"


def _number(value: float | None, digits: int = 3, *, signed: bool = False) -> str:
    if value is None:
        return "-"
    return f"{value:+.{digits}f}" if signed else f"{value:.{digits}f}"


def _table(headers: Sequence[str], rows: Sequence[Sequence[str]]) -> str:
    widths = [max(len(str(cell)) for cell in column) for column in zip(headers, *rows)]
    lines = ["  ".join(cell.ljust(width) for cell, width in zip(headers, widths)).rstrip()]
    lines.append("  ".join("-" * width for width in widths))
    lines.extend(
        "  ".join(str(cell).ljust(width) for cell, width in zip(row, widths)).rstrip()
        for row in rows
    )
    return "\n".join(lines)


def _bounds_label(run: BenchmarkRun) -> str:
    low, high = run.duration_bounds
    return f"{low:g}-{high:g}"


def _metric_cells(metric: KMetrics) -> list[str]:
    durations = "/".join(
        _number(value, 1)
        for value in (metric.duration_min, metric.duration_median, metric.duration_max)
    )
    ranks = ", ".join(f"{gold_id}#{rank}" for gold_id, rank in metric.gold_first_hit_rank)
    traps = f"{metric.trap_hits}/{metric.considered}"
    if metric.trap_ids:
        traps += f" ({','.join(metric.trap_ids)})"
    return [
        str(metric.k),
        f"{metric.hits}/{metric.gold_count}",
        _number(metric.recall),
        _number(metric.precision),
        traps,
        _number(metric.mean_best_iou),
        _number(metric.start_offset_median, 1, signed=True),
        durations,
        ranks or "-",
    ]


_HIT_RULE_TEXT = f"hit = IoU >= {HIT_MIN_IOU} atau cakupan gold >= {HIT_MIN_GOLD_COVERAGE:.0%}"
_METRIC_HEADERS = ("K", "hits", "R@K", "P@K", "trap", "mIoU", "off_med", "dur min/med/max")


def format_run(run: BenchmarkRun, gold: GoldSet) -> str:
    """Detailed human report for one selector on one episode."""
    lines = [
        (
            f"Benchmark seleksi: {run.source_id} | selector {run.selector} | "
            f"durasi {_bounds_label(run)} s ({run.bounds_source})"
        ),
        (
            f"Gold: {len(gold.moments)} momen, {len(gold.traps)} trap "
            f"(labeler: {gold.labeler}). {_HIT_RULE_TEXT}."
        ),
        "",
    ]
    if run.status != "completed":
        lines.append(f"GAGAL: {run.error}")
        return "\n".join(lines)
    lines.append(
        _table(
            (*_METRIC_HEADERS, "gold#rank"),
            [_metric_cells(metric) for metric in run.metrics],
        )
    )
    lines.extend(["", "Seleksi (urutan rank):"])
    rows = [
        [
            str(match.rank),
            _clock(match.start),
            _clock(match.end),
            _number(match.duration, 1),
            ",".join(match.gold_ids) or "-",
            ",".join(match.trap_ids) or "-",
            _number(match.best_iou, 2),
            _number(match.start_offset, 1, signed=True),
        ]
        for match in run.selections
    ]
    lines.append(
        _table(("#", "mulai", "selesai", "durasi", "gold", "trap", "IoU", "offset"), rows)
        if rows
        else "(tidak ada seleksi)"
    )
    return "\n".join(lines)


def format_comparison(runs: Sequence[BenchmarkRun]) -> str:
    """Compact table: one row per episode x selector x K, plus pooled rows."""
    rows = []
    for run in runs:
        if run.status != "completed":
            rows.append([run.source_id, run.selector, _bounds_label(run), "GAGAL", run.error or ""])
            continue
        for metric in run.metrics:
            rows.append([run.source_id, run.selector, _bounds_label(run), *_metric_cells(metric)])
    lines = [
        f"Perbandingan selector ({_HIT_RULE_TEXT})",
        _table(("episode", "selector", "durasi", *_METRIC_HEADERS, "gold#rank"), rows),
    ]
    pooled = pool_runs(runs)
    if len({run.source_id for run in runs}) > 1 and pooled:
        lines.extend(["", "Gabungan semua episode (micro-average):"])
        lines.append(
            _table(
                ("selector", "K", "episode", "hits", "R@K", "P@K", "trap", "mIoU"),
                [
                    [
                        row.selector,
                        str(row.k),
                        str(row.episodes),
                        f"{row.hits}/{row.gold}",
                        _number(row.recall),
                        _number(row.precision),
                        f"{row.trap_hits}/{row.considered}",
                        _number(row.mean_best_iou),
                    ]
                    for row in pooled
                ],
            )
        )
    return "\n".join(lines)


def write_report(path: str | Path, report: Mapping[str, object]) -> None:
    """Atomically write the JSON report."""
    target = Path(path)
    pending = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        pending.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        os.replace(pending, target)
    except OSError as error:
        pending.unlink(missing_ok=True)
        raise BenchmarkError(f"cannot write report: {target.name}") from error


# --- CLI -------------------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m ai_clipper.benchmark",
        description=(
            "Score clip selectors against gold labels (Recall@K, Precision@K, trap hits). "
            "Pair each --gold with a --transcript in the same order."
        ),
    )
    parser.add_argument("--gold", action="append", type=Path, required=True)
    parser.add_argument("--transcript", action="append", type=Path, required=True)
    parser.add_argument(
        "--audio-timeline",
        action="append",
        type=Path,
        help="optional; give none or one per --gold, in the same order",
    )
    parser.add_argument(
        "--sound-events",
        action="append",
        type=Path,
        help=(
            "optional sound events (analysis/sound-events.json or the legacy converter format); "
            "give none or one per --gold"
        ),
    )
    parser.add_argument(
        "--llm-cache-dir",
        action="append",
        type=Path,
        help=(
            "optional LLM response cache for LLM selectors; give none or one per --gold "
            f"(default {DEFAULT_LLM_CACHE_ROOT}/<source_id>/llm-cache)"
        ),
    )
    parser.add_argument(
        "--selector",
        action="append",
        required=True,
        help="v1, v2-standard, v2-viral, v2-deep, or a registered/plugin selector",
    )
    parser.add_argument("--k", action="append", type=int, help="repeatable (default: 5 and 10)")
    parser.add_argument("--min-duration", type=float, default=20.0)
    parser.add_argument("--max-duration", type=float, default=60.0)
    parser.add_argument("--json", type=Path, help="write the full JSON report here")
    parser.add_argument(
        "--compare",
        action="store_true",
        help="allow several selectors and gold/transcript pairs; print a comparison table",
    )
    return parser


def _transcript_warnings(gold: GoldSet, transcript: LoadedTranscript) -> tuple[str, ...]:
    last_end = max(segment.end for segment in transcript.segments)
    if last_end > gold.duration_seconds + 2.0:
        return (f"transcript_longer_than_gold:{last_end:.1f}>{gold.duration_seconds:.1f}",)
    if last_end < 0.9 * gold.duration_seconds:
        return (f"transcript_shorter_than_gold:{last_end:.1f}<{gold.duration_seconds:.1f}",)
    return ()


def _load_episodes(args: argparse.Namespace) -> list[Episode]:
    timelines = args.audio_timeline or []
    sound_files = args.sound_events or []
    cache_dirs = args.llm_cache_dir or []
    if len(args.gold) != len(args.transcript):
        raise BenchmarkError("every --gold needs exactly one --transcript, in the same order")
    for name, values in (
        ("--audio-timeline", timelines),
        ("--sound-events", sound_files),
        ("--llm-cache-dir", cache_dirs),
    ):
        if values and len(values) != len(args.gold):
            raise BenchmarkError(f"give either no {name} or one per --gold")
    if not args.compare and len(args.gold) > 1:
        raise BenchmarkError("several gold/transcript pairs need --compare")
    episodes = []
    for index, (gold_path, transcript_path) in enumerate(zip(args.gold, args.transcript)):
        gold = load_gold(gold_path)
        transcript = load_transcript(transcript_path)
        timeline = load_audio_timeline(timelines[index]) if timelines else None
        events = load_sound_events(sound_files[index]) if sound_files else ()
        cache_dir = (
            cache_dirs[index]
            if cache_dirs
            else DEFAULT_LLM_CACHE_ROOT / gold.source_id / "llm-cache"
        )
        context = SelectorContext(gold.source_id, events, cache_dir)
        episodes.append(
            Episode(gold, transcript, timeline, _transcript_warnings(gold, transcript), context)
        )
    source_ids = [episode.gold.source_id for episode in episodes]
    if len(set(source_ids)) != len(source_ids):
        raise BenchmarkError("each gold file must describe a different source_id")
    return episodes


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point: 0 = all runs completed, 1 = a selector failed, 2 = invalid input."""
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exit_request:
        return exit_request.code if isinstance(exit_request.code, int) else 2
    try:
        selectors = list(args.selector)
        if any(name not in _SELECTORS for name in selectors):
            load_optional_selectors()
        if len(set(selectors)) != len(selectors):
            raise BenchmarkError("each --selector may be given only once")
        if not args.compare and len(selectors) > 1:
            raise BenchmarkError("several selectors need --compare")
        for name in selectors:
            get_selector(name)
        ks = validate_ks(args.k or DEFAULT_KS)
        _validate_bounds(args.min_duration, args.max_duration)
        episodes = _load_episodes(args)
        for episode in episodes:
            for warning in (*episode.transcript.warnings, *episode.warnings):
                print(f"benchmark_warning: {episode.gold.source_id}: {warning}", file=sys.stderr)
        runs = [
            run_benchmark(
                episode.gold,
                episode.transcript.segments,
                name,
                ks=ks,
                min_duration=args.min_duration,
                max_duration=args.max_duration,
                audio_timeline=episode.audio_timeline,
                context=episode.context,
            )
            for episode in episodes
            for name in selectors
        ]
        if args.compare:
            print(format_comparison(runs))
        else:
            print(format_run(runs[0], episodes[0].gold))
        if args.json is not None:
            write_report(args.json, report_dict(episodes, runs, ks))
    except BenchmarkError as error:
        print(f"benchmark_error: {_redact(str(error))}", file=sys.stderr)
        return 2
    failed = [run for run in runs if run.status != "completed"]
    for run in failed:
        print(f"benchmark_error: {run.source_id}/{run.selector}: {run.error}", file=sys.stderr)
    return 1 if failed else 0


_register_builtins()

if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
