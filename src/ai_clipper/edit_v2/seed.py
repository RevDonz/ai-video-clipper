"""Revision 0 (the seed) of a V3 clip, and the prepare step for older jobs (plan §3.5, §4.4).

Owner: T1.5 (T4.1 adds ``seed_from_candidate``). The seed is written once as
``analysis/clips/<clip_id>/seed.json`` (canonical, immutable, 0600); ``base.seed_sha256`` is the
sha256 of the seed's canonical bytes with that field set to null (docs/editor/CONTRACTS.md
§5.6).

**The ``job`` mapping of** :func:`build_seed` is the web's ``job.json`` object (``id`` and
``options``: ``renderMode``, ``captionStyle``, ``coldOpen``, ``hookOverlay``; missing options
take the dashboard's V3 defaults) plus optional seed-context keys that never occur in
``job.json``:

* ``renderSize`` ``[w, h]``: the job's render size, default ``[720, 1280]`` (the dashboard's);
* ``hookDuration``: seconds, default 4.0 (the pipeline's ``DEFAULT_HOOK_DURATION``);
* ``seedAtMs``: the seed time (``audit.created_at_ms``), default now;
* ``seedBy``: ``"pipeline"`` (default; ``base.engine.compiler`` ``edit-v2/1``, editor
  ``pipeline/edit-v2/1``) or ``"prepare"`` (``legacy``, ``prepare/edit-v2/1``).

**Rules beyond the plan table** (each keeps the seed valid for the validator):

* ``output.fps``: native standard rates are kept, 50 → 25, 60 → 30, 60000/1001 → 30000/1001,
  VFR or anything else → 30/1. A rate within 0.01 % of one of those (a container's rounded
  ``2997/100``) counts as that rate.
* The cold open is kept only when the job ran with cold open and the clip has one. Frame
  snapping (``sf_floor``/``sf_ceil``) can make an 8.0 s teaser one frame too long: its end is
  pulled in to ``⌊8·F⌋`` frames. A teaser that would still break the §3.4 cold-open rule
  (shorter than ``⌈0.5·F⌉`` frames, starting on the body's first frame, more than 80 % inside
  the body's opening, or past the source end) is left out, and the clip id is then computed
  without it.
* The hook text is ``clean_caption_text`` in NFC, shortened to 90 characters like the renderer;
  ``dur_f`` is clamped to the document's 15 … ``⌊30·F⌋`` frames.
* Segment edges and the window stay inside the source-grid frames that exist
  (``source_info.grid_range``, measured once per source): a clip that starts before the
  video's first grid frame (a video that starts at 0.041 s has no frame 0) starts at it, and one
  that ends at the end of the source stops at the last grid frame (``sf_ceil`` of the rounded-up
  ``duration_ms`` can be one frame past it). The window is narrowed to
  ``[⌈first·1000·den/num⌉, ⌊end·1000·den/num⌋]`` ms, so the validator's frame-covering window
  (``[sf_floor(a), sf_ceil(b)]``) is exactly the frames that exist at the edges and a document
  that validates renders every planned frame. A cold open is clamped the same way.
* A body shorter than 3 s, longer than 300 s or beyond the source raises :class:`SeedError`.

:func:`prepare_legacy_job` persists ``analysis/source.json``, then per clip the peaks, the words
artifact, the camera plan (face-track jobs only) and ``seed.json``, each once and never
overwritten, under a job-level ``flock``. Every clip that cannot be opened is named with the
first matching reason: ``not_v3`` (the job did not run Selection V3), ``analysis_incomplete``
(no ``analysis/selection.v3.json`` but one stranded in ``.attempts/*/analysis/``, or an existing
seed whose words artifact is gone), ``selection_unreadable``, ``transcript_missing``,
``source_missing`` (the source must be a regular file inside ``input/``; ``job.json``'s absolute
``sourcePath`` is only used when it points there). Those checks come before any write.
:func:`inspect_job` reports the same entries without writing or decoding anything, with
``needs_prepare`` for clips whose seed does not exist yet.
"""

from __future__ import annotations

import fcntl
import json
import math
import os
import re
import stat
import time
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import TYPE_CHECKING, Any, Self

from .. import audio_timeline as _audio_timeline
from .. import sound_events as _sound_events
from ..captions_ass import shorten_hook_text
from ..selection_types import SELECTION_V3_VERSION
from ..selection_v3 import SELECTION_ARTIFACT_RELATIVE_PATH, selection_from_dict
from ..subtitles import clean_caption_text
from ..transcript_io import MAX_TRANSCRIPT_BYTES, transcription_from_json_bytes
from . import (
    COMPILER_ID,
    DOC_FPS,
    OUTPUT_SIZES,
    PACK_DEFAULT_OVERRIDES,
    RENDER_SEMANTICS,
    SCHEMA,
    SCHEMA_MINOR,
)
from . import camera as _camera
from . import timemap as tm
from .clip_id import clip_id as _clip_id
from .clip_id import ms_from_seconds
from .errors import NotFound
from .peaks import build_peaks, peaks_file_name
from .source_info import (
    SOURCE_INFO_RELATIVE_PATH,
    SourceInfoError,
    canonical_json,
    ensure_private_dir,
    ensure_source_info,
    grid_range,
    read_regular,
    sha256_hex,
    write_immutable,
)
from .timemap import Fps
from .words import build_words_artifact, encode_words, words_file_name

if TYPE_CHECKING:
    from ..selection_types import SelectedClip

HOOK_DURATION_DEFAULT_S = 4.0  # == pipeline.DEFAULT_HOOK_DURATION (checked by a test)
DEFAULT_RENDER_SIZE = (720, 1280)  # the dashboard's render size (web/scripts/run-job.mjs)
WINDOW_MARGIN_MS = 60_000
HOOK_TEXT_MAX = 90
LAYOUT_BY_RENDER_MODE = {"face-track": "camera", "fit-blur": "fit_blur",
                         "center-crop": "fill_center"}
PACK_BY_CAPTION_STYLE = {"karaoke": "karaoke", "classic": "classic"}
HALVED_FPS = {(50, 1): (25, 1), (60, 1): (30, 1), (60000, 1001): (30000, 1001)}
FALLBACK_FPS = (30, 1)
EDITORS = {"pipeline": "pipeline/edit-v2/1", "prepare": "prepare/edit-v2/1"}
ENGINES = {"pipeline": COMPILER_ID, "prepare": "legacy"}

CLIPS_RELATIVE_PATH = Path("analysis") / "clips"
SEED_FILE = "seed.json"
PREPARE_LOCK = ".prepare.lock"
TRANSCRIPT_RELATIVE_PATH = Path("output") / "transcript.json"
AUDIO_TIMELINE_RELATIVE_PATH = _audio_timeline.ARTIFACT_RELATIVE_PATH
SOUND_EVENTS_RELATIVE_PATH = Path("analysis") / "sound-events.json"
MAX_JOB_BYTES = 4 * 1024 * 1024
MAX_SELECTION_BYTES = 8 * 1024 * 1024
MAX_AUDIO_TIMELINE_BYTES = 32 * 1024 * 1024
MAX_SOUND_EVENTS_BYTES = _sound_events.MAX_SOUND_EVENTS_BYTES
MAX_SEED_BYTES = 1 << 20
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_SHA = re.compile(r"[0-9a-f]{64}")


class SeedError(ValueError):
    """The clip or its context cannot be represented as a valid revision 0."""


# --- rules ---------------------------------------------------------------------------------------


def _same_rate(rate: Fraction, target: tuple[int, int]) -> bool:
    goal = Fraction(*target)
    return abs(rate - goal) * 10_000 <= goal


def output_fps(probe: Mapping) -> Fps:
    """The document frame rate for a probed source (plan §3.5 ``output`` row)."""
    if probe.get("vfr") is True:
        return Fps(*FALLBACK_FPS)
    try:
        num, den = probe["fps_native"]
        rate = Fraction(int(num), int(den))
    except (KeyError, TypeError, ValueError, ZeroDivisionError):
        return Fps(*FALLBACK_FPS)
    if rate <= 0:
        return Fps(*FALLBACK_FPS)
    for target in DOC_FPS:
        if _same_rate(rate, target):
            return Fps(*target)
    for source, target in HALVED_FPS.items():
        if _same_rate(rate, source):
            return Fps(*target)
    return Fps(*FALLBACK_FPS)


def seed_window_ms(
    start_ms: int, end_ms: int, cold_open_ms: tuple[int, int] | None, duration_ms: int
) -> tuple[int, int]:
    """``[min(start, co_start) − 60 s, max(end, co_end) + 60 s]`` clamped to the source."""
    low, high = start_ms, end_ms
    if cold_open_ms is not None:
        low, high = min(low, cold_open_ms[0]), max(high, cold_open_ms[1])
    return max(0, low - WINDOW_MARGIN_MS), min(duration_ms, high + WINDOW_MARGIN_MS)


def grid_window_ms(window_ms: tuple[int, int], grid: tuple[int, int],
                   fps: Fps) -> tuple[int, int]:
    """``window_ms`` narrowed to the source-grid frames ``[first, end)`` that exist: the start
    of frame ``first`` rounded up to whole ms and the start of frame ``end`` rounded down, so
    ``sf_floor(a) >= first`` and ``sf_ceil(b) <= end`` (exactly those at the edges)."""
    first, end = grid
    low = -(-first * 1000 * fps.den // fps.num)
    high = end * 1000 * fps.den // fps.num
    a, b = max(window_ms[0], low), min(window_ms[1], high)
    if a >= b:
        raise SeedError("the clip lies outside the frames of the source")
    return a, b


def encode_seed(seed: Mapping[str, Any]) -> bytes:
    """The seed file bytes (plan §3.1 canonical JSON)."""
    return canonical_json(seed)


def seed_sha256(seed: Mapping[str, Any]) -> str:
    """``base.seed_sha256``: sha256 of the seed's canonical bytes with that field null
    (CONTRACTS §5.6)."""
    content = dict(seed)
    content["base"] = {**seed["base"], "seed_sha256": None}
    return sha256_hex(encode_seed(content))


@dataclass(frozen=True)
class _Context:
    job_id: str
    layout: str
    pack: str
    cold_open: bool
    hook: bool
    hook_duration_ms: int
    render_size: tuple[int, int]
    seed_at_ms: int
    by: str


def _flag(options: Mapping, name: str) -> bool:
    value = options.get(name, True)
    if not isinstance(value, bool):
        raise SeedError(f"job option {name} must be a boolean")
    return value


def _context(job: Mapping) -> _Context:
    if not isinstance(job, Mapping):
        raise SeedError("job must be a mapping")
    job_id = job.get("id")
    if not isinstance(job_id, str) or not _UUID.fullmatch(job_id):
        raise SeedError("job id must be a lowercase UUID")
    options = job.get("options") or {}
    if not isinstance(options, Mapping):
        raise SeedError("job options must be a mapping")
    layout = LAYOUT_BY_RENDER_MODE.get(options.get("renderMode", "fit-blur"))
    pack = PACK_BY_CAPTION_STYLE.get(options.get("captionStyle", "karaoke"))
    if layout is None or pack is None:
        raise SeedError("unsupported render mode or caption style")
    hook_duration = job.get("hookDuration", HOOK_DURATION_DEFAULT_S)
    if (isinstance(hook_duration, bool) or not isinstance(hook_duration, (int, float))
            or not math.isfinite(hook_duration) or not 0 < hook_duration <= 30):
        raise SeedError("hookDuration must be a number of seconds in (0, 30]")
    size = job.get("renderSize", DEFAULT_RENDER_SIZE)
    if not isinstance(size, (list, tuple)) or tuple(size) not in OUTPUT_SIZES:
        raise SeedError("renderSize must be one of the document output sizes")
    seed_at = job.get("seedAtMs")
    if seed_at is None:
        seed_at = time.time_ns() // 1_000_000
    if type(seed_at) is not int or seed_at < 0:
        raise SeedError("seedAtMs must be a non-negative integer")
    by = job.get("seedBy", "pipeline")
    if by not in EDITORS:
        raise SeedError("seedBy must be pipeline or prepare")
    return _Context(job_id, layout, pack, _flag(options, "coldOpen"), _flag(options, "hookOverlay"),
                    ms_from_seconds(float(hook_duration)), (int(size[0]), int(size[1])), seed_at,
                    by)


def _source(source_info: Mapping) -> dict[str, Any]:
    try:
        sha = source_info["content_sha256"]
        probe = source_info["probe"]
        fields = {key: probe[key] for key in ("w", "h", "fps_native", "vfr", "duration_ms",
                                              "has_audio")}
    except (KeyError, TypeError):
        raise SeedError("source_info must hold content_sha256 and the probe fields") from None
    if not isinstance(sha, str) or not _SHA.fullmatch(sha):
        raise SeedError("source content sha is invalid")
    fps = fields["fps_native"]
    if (not all(type(fields[key]) is int and fields[key] > 0 for key in ("w", "h", "duration_ms"))
            or type(fields["vfr"]) is not bool or type(fields["has_audio"]) is not bool
            or not isinstance(fps, (list, tuple)) or len(fps) != 2
            or not all(type(item) is int and item > 0 for item in fps)):
        raise SeedError("source probe fields are invalid")
    return {"content_sha256": sha, **fields, "fps_native": [fps[0], fps[1]]}


def _grid(source_info: Mapping, fps: Fps) -> tuple[int, int]:
    try:
        return grid_range(source_info["probe"], fps)
    except (SourceInfoError, KeyError, TypeError):
        raise SeedError("source_info must hold the source frame grid (probe.grid_sf)") from None


@dataclass(frozen=True)
class _ClipPlan:
    clip_id: str
    fps: Fps
    window_ms: tuple[int, int]
    segments: tuple[dict[str, Any], ...]
    teaser_ms: tuple[int, int] | None


def _teaser_frames(teaser_ms: tuple[int, int], body_in: int, fps: Fps,
                   duration_ms: int, grid: tuple[int, int]) -> tuple[int, int] | None:
    co_in = max(tm.sf_floor(teaser_ms[0], fps), grid[0])
    co_out = min(tm.sf_ceil(teaser_ms[1], fps), grid[1])
    longest, shortest = tm.sf_floor(8000, fps), tm.sf_ceil(500, fps)
    co_out = min(co_out, co_in + longest)
    length = co_out - co_in
    if length < shortest or co_in == body_in or teaser_ms[1] > duration_ms:
        return None
    opening_end = body_in + length + Fraction(2 * fps.num, fps.den)
    overlap = max(Fraction(0), min(Fraction(co_out), opening_end) - max(co_in, body_in))
    if 5 * overlap > 4 * length:
        return None
    return co_in, co_out


def _clip_plan(clip: SelectedClip, context: _Context, source: Mapping[str, Any],
               source_info: Mapping) -> _ClipPlan:
    fps = output_fps(source)
    grid = _grid(source_info, fps)
    start_ms, end_ms = ms_from_seconds(clip.start), ms_from_seconds(clip.end)
    duration_ms = source["duration_ms"]
    if end_ms > duration_ms:
        raise SeedError("the clip ends after the source")
    body_in = max(tm.sf_floor(start_ms, fps), grid[0])
    body_out = min(tm.sf_ceil(end_ms, fps), grid[1])
    if not tm.sf_ceil(3000, fps) <= body_out - body_in <= tm.sf_floor(300_000, fps):
        raise SeedError("the body must last 3 s to 300 s")
    teaser_ms = None
    segments: list[dict[str, Any]] = []
    if context.cold_open and clip.cold_open is not None:
        candidate = (ms_from_seconds(clip.cold_open[0]), ms_from_seconds(clip.cold_open[1]))
        frames = _teaser_frames(candidate, body_in, fps, duration_ms, grid)
        if frames is not None:
            teaser_ms = candidate
            segments.append({"id": "seg_co", "role": "cold_open", "in_sf": frames[0],
                             "out_sf": frames[1]})
    segments.append({"id": "seg_b1", "role": "body", "in_sf": body_in, "out_sf": body_out})
    window = grid_window_ms(seed_window_ms(start_ms, end_ms, teaser_ms, duration_ms), grid, fps)
    low, high = tm.sf_floor(window[0], fps), tm.sf_ceil(window[1], fps)
    if any(not low <= segment["in_sf"] < segment["out_sf"] <= high for segment in segments):
        raise SeedError("the clip lies outside its analysis window")
    return _ClipPlan(_clip_id(source["content_sha256"], start_ms, end_ms, teaser_ms), fps,
                     window, tuple(segments), teaser_ms)


def _hook_text(text: str) -> str:
    cleaned = unicodedata.normalize("NFC", clean_caption_text(text))
    if len(cleaned) > HOOK_TEXT_MAX:
        cleaned = unicodedata.normalize("NFC", shorten_hook_text(cleaned, HOOK_TEXT_MAX))
    return cleaned.strip()[:HOOK_TEXT_MAX].strip()


def _sha(value: object, name: str, *, optional: bool = False) -> str | None:
    if value is None and optional:
        return None
    if not isinstance(value, str) or not _SHA.fullmatch(value):
        raise SeedError(f"{name} must be 64 lowercase hex characters")
    return value


def build_seed(
    *,
    clip: SelectedClip,
    job: Mapping,
    source_info: Mapping,
    words_sha: str,
    words_count: int,
    camera_sha: str | None,
    selection_sha: str,
) -> dict:
    """The seed document of ``clip`` following every row of the plan §3.5 table."""
    context = _context(job)
    source = _source(source_info)
    _sha(words_sha, "words_sha")
    _sha(selection_sha, "selection_sha")
    _sha(camera_sha, "camera_sha", optional=True)
    if type(words_count) is not int or words_count < 0:
        raise SeedError("words_count must be a non-negative integer")
    if (context.layout == "camera") != (camera_sha is not None):
        raise SeedError("a camera plan is required for, and only for, the face-track layout")
    plan = _clip_plan(clip, context, source, source_info)
    fps = plan.fps
    tracks: list[dict[str, Any]] = []
    text = _hook_text(clip.hook_text) if context.hook else ""
    if text:
        dur_f = tm.div_round_half_up(context.hook_duration_ms * fps.num, 1000 * fps.den)
        dur_f = min(max(dur_f, 15), tm.sf_floor(30_000, fps))
        tracks.append({
            "id": "tr_hook",
            "kind": "hook",
            "items": [{
                "id": "it_hook",
                "type": "hook",
                "start": {"at": "out", "f": 0},
                "dur_f": dur_f,
                "transform": {"x_e5": 50000, "y_e5": 13000},
                "payload": {"text": text, "design": {"id": "legacy-bar", "v": 1}},
                "origin": "seed",
            }],
        })
    hook_unit = clip.hook_unit_id if 1 <= len(clip.hook_unit_id) <= 16 else None
    joins = ([{"after": "seg_co", "style": "cut", "audio_fade_ms": 30}]
             if plan.teaser_ms is not None else [])
    seed: dict[str, Any] = {
        "schema": SCHEMA,
        "schema_minor": SCHEMA_MINOR,
        "clip_id": plan.clip_id,
        "revision": 0,
        "parent_sha256": None,
        "base": {
            "job_id": context.job_id,
            "source": source,
            "origin": {
                "kind": "v3_clip",
                "selection_artifact_sha256": selection_sha,
                "selection_version": SELECTION_V3_VERSION,
                "rank_at_seed": clip.rank,
                "hook_unit_id": hook_unit,
                "selection_source": clip.source,
            },
            "window_ms": list(plan.window_ms),
            "words": {"sha256": words_sha, "count": words_count},
            "camera": {"sha256": camera_sha},
            "seed_sha256": None,
            "engine": {"compiler": ENGINES[context.by], "render_semantics": RENDER_SEMANTICS},
        },
        "output": {"w": context.render_size[0], "h": context.render_size[1],
                   "fps": fps.to_json(), "sample_rate": 48000, "channels": 2},
        "main": {"segments": [dict(segment) for segment in plan.segments], "removals": [],
                 "joins": joins, "cut_fade_ms": 8},
        "captions": {"enabled": True, "pack": {"id": context.pack, "v": 1},
                     "overrides": dict(PACK_DEFAULT_OVERRIDES[context.pack]), "word_edits": {}},
        "layout": {"default": {"mode": context.layout, "no_face": "center"}},
        "tracks": tracks,
        "audio": {"source": {"gain_cdb": 0},
                  "master": {"mode": "off", "target_clufs": -1400, "tp_cdb": -100}},
        "assets": {},
        "audit": {"created_at_ms": context.seed_at_ms, "updated_at_ms": context.seed_at_ms,
                  "editor": EDITORS[context.by], "last_command": "Seed"},
    }
    seed["base"]["seed_sha256"] = seed_sha256(seed)
    return seed


# --- jobs ----------------------------------------------------------------------------------------


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _reject_constant(_value: str) -> Any:
    raise ValueError("non-finite JSON number")


def _strict_json(raw: bytes) -> Any:
    return json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object,
                      parse_constant=_reject_constant)


def _load_job(job_dir: Path) -> dict[str, Any]:
    try:
        job = _strict_json(read_regular(job_dir / "job.json", MAX_JOB_BYTES))
    except (OSError, ValueError, UnicodeDecodeError, RecursionError):
        raise NotFound() from None
    if type(job) is not dict or not isinstance(job.get("id"), str) or not _UUID.fullmatch(
        job["id"]
    ):
        raise NotFound()
    return job


def _entry(clip_id: str | None, index: int, reason: str | None) -> dict[str, Any]:
    return {"clip_id": clip_id, "index": index, "openable": reason is None, "reason": reason}


def _job_indices(job: Mapping[str, Any]) -> list[int]:
    clips = job.get("clips")
    if not isinstance(clips, list):
        return []
    indices = set()
    for position, clip in enumerate(clips):
        index = clip.get("index") if isinstance(clip, dict) else None
        indices.add(index if type(index) is int and index > 0 else position + 1)
    return sorted(indices)


def _is_regular(path: Path) -> bool:
    try:
        return stat.S_ISREG(os.lstat(path).st_mode)
    except OSError:
        return False


def _is_dir(path: Path) -> bool:
    try:
        return stat.S_ISDIR(os.lstat(path).st_mode)
    except OSError:
        return False


def _stranded(job_dir: Path) -> bool:
    attempts = job_dir / ".attempts"
    if not _is_dir(attempts):
        return False
    with os.scandir(attempts) as entries:
        for entry in entries:
            if entry.is_dir(follow_symlinks=False) and _is_regular(
                Path(entry.path) / SELECTION_ARTIFACT_RELATIVE_PATH
            ):
                return True
    return False


def _read_selection(job_dir: Path) -> tuple[Any, str] | str:
    path = job_dir / SELECTION_ARTIFACT_RELATIVE_PATH
    if not os.path.lexists(path):
        return "analysis_incomplete" if _stranded(job_dir) else "selection_unreadable"
    try:
        raw = read_regular(path, MAX_SELECTION_BYTES)
        result = selection_from_dict(_strict_json(raw))
    except (OSError, ValueError, UnicodeDecodeError, RecursionError, TypeError):
        return "selection_unreadable"
    return result, sha256_hex(raw)


def _resolve_source(job_dir: Path, job: Mapping[str, Any]) -> Path | None:
    """The job source: a regular file (not a symlink) inside ``job_dir/input``."""
    input_dir = job_dir / "input"
    if not _is_dir(input_dir):
        return None
    recorded = job.get("sourcePath")
    if not isinstance(recorded, str) or not recorded or "\0" in recorded:
        return None
    candidates = [input_dir / Path(recorded).name]
    if Path(recorded).is_absolute():
        candidates.insert(0, Path(recorded))
    real_input = os.path.realpath(input_dir)
    for candidate in candidates:
        real = os.path.realpath(candidate)
        if os.path.commonpath([real, real_input]) != real_input or real == real_input:
            continue  # outside input/ (another job, a moved job dir, or a symlink out)
        if _is_regular(candidate):  # lstat: the file itself is never a symlink
            return candidate
    return None


def _read_audio(job_dir: Path) -> Any:
    path = job_dir / AUDIO_TIMELINE_RELATIVE_PATH
    try:
        return _audio_timeline.AudioTimeline.from_dict(
            _strict_json(read_regular(path, MAX_AUDIO_TIMELINE_BYTES))
        )
    except (OSError, ValueError, TypeError, UnicodeDecodeError, RecursionError):
        return None


def _read_events(job_dir: Path) -> Any:
    path = job_dir / SOUND_EVENTS_RELATIVE_PATH
    try:
        events, _source = _sound_events.events_from_dict(
            _strict_json(read_regular(path, MAX_SOUND_EVENTS_BYTES))
        )
    except (OSError, ValueError, TypeError, UnicodeDecodeError, RecursionError):
        return None
    return events


@dataclass(frozen=True)
class _JobState:
    job: dict[str, Any]
    selection: Any
    selection_sha: str
    source: Path
    context: _Context


def _job_state(job_dir: Path) -> _JobState | list[dict[str, Any]]:
    """The job-level checks shared by prepare and inspect (no writes, no decoding)."""
    job = _load_job(job_dir)
    indices = _job_indices(job)
    options = job.get("options")
    if not isinstance(options, dict) or options.get("selectionMode") != "v3":
        return [_entry(None, index, "not_v3") for index in indices]
    loaded = _read_selection(job_dir)
    if isinstance(loaded, str):
        return [_entry(None, index, loaded) for index in indices]
    selection, selection_sha = loaded
    ranks = [clip.rank for clip in selection.clips]
    if not _is_regular(job_dir / TRANSCRIPT_RELATIVE_PATH):
        return [_entry(None, rank, "transcript_missing") for rank in ranks]
    source = _resolve_source(job_dir, job)
    if source is None:
        return [_entry(None, rank, "source_missing") for rank in ranks]
    try:
        context = _context({**job, "seedBy": "prepare", "seedAtMs": 0})
    except SeedError:  # options the dashboard never writes
        return [_entry(None, rank, "selection_unreadable") for rank in ranks]
    return _JobState(job, selection, selection_sha, source, context)


def _existing_seed(clip_dir: Path) -> dict[str, Any] | None:
    path = clip_dir / SEED_FILE
    if not os.path.lexists(path):
        return None
    try:
        seed = _strict_json(read_regular(path, MAX_SEED_BYTES))
        words_sha = seed["base"]["words"]["sha256"]
    except (OSError, ValueError, UnicodeDecodeError, RecursionError, KeyError, TypeError):
        return {}
    if not isinstance(words_sha, str) or not _SHA.fullmatch(words_sha):
        return {}
    return seed


def _words_path(clip_dir: Path, words_sha: str) -> Path:
    return clip_dir / f"words.{words_sha[:16]}.json"


def inspect_job(job_dir: Path) -> list[dict]:
    """``[{clip_id | None, index, openable, reason}]`` without writing or decoding anything.

    Clips whose seed (and words artifact) exist are openable with their id; clips that
    :func:`prepare_legacy_job` would seed are ``needs_prepare`` with a null id.
    """
    job_dir = Path(job_dir)
    state = _job_state(job_dir)
    if isinstance(state, list):
        return state
    try:
        info = json.loads(read_regular(job_dir / SOURCE_INFO_RELATIVE_PATH, 64 * 1024))
        source = _source(info)
    except (OSError, ValueError, UnicodeDecodeError):
        return [_entry(None, clip.rank, "needs_prepare") for clip in state.selection.clips]
    entries = []
    for clip in state.selection.clips:
        try:
            plan = _clip_plan(clip, state.context, source, info)
        except SeedError:
            entries.append(_entry(None, clip.rank, "selection_unreadable"))
            continue
        clip_dir = job_dir / CLIPS_RELATIVE_PATH / plan.clip_id
        seed = _existing_seed(clip_dir)
        if seed is None:
            entries.append(_entry(None, clip.rank, "needs_prepare"))
        elif not seed or not _is_regular(_words_path(clip_dir, seed["base"]["words"]["sha256"])):
            entries.append(_entry(None, clip.rank, "analysis_incomplete"))
        else:
            entries.append(_entry(plan.clip_id, clip.rank, None))
    return entries


class _Lock:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.fd = -1

    def __enter__(self) -> Self:
        ensure_private_dir(self.path.parent)
        self.fd = os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        if not stat.S_ISREG(os.fstat(self.fd).st_mode):
            os.close(self.fd)
            raise OSError("prepare lock is not a regular file")
        fcntl.flock(self.fd, fcntl.LOCK_EX)
        return self

    def __exit__(self, *_exc: object) -> None:
        fcntl.flock(self.fd, fcntl.LOCK_UN)
        os.close(self.fd)


def _write_or_match(path: Path, data: bytes) -> bool:
    """Publish ``data`` or confirm the existing file holds exactly it."""
    if write_immutable(path, data):
        return True
    try:
        return read_regular(path, max(len(data), 1)) == data
    except (OSError, ValueError):
        return False


def _prepare_clip(job_dir: Path, state: _JobState, clip: SelectedClip, source_info: Mapping,
                  transcription: Any, audio: Any, events: Any) -> dict[str, Any]:
    context = state.context
    try:
        plan = _clip_plan(clip, context, _source(source_info), source_info)
    except SeedError:
        return _entry(None, clip.rank, "selection_unreadable")
    clip_dir = job_dir / CLIPS_RELATIVE_PATH / plan.clip_id
    seed = _existing_seed(clip_dir)
    if seed is not None:
        if not seed:
            return _entry(None, clip.rank, "analysis_incomplete")
        words_sha = seed["base"]["words"]["sha256"]
        if _is_regular(_words_path(clip_dir, words_sha)):
            return _entry(plan.clip_id, clip.rank, None)
    peaks = build_peaks(state.source, plan.window_ms)
    words = build_words_artifact(transcription, clip_id=plan.clip_id, window_ms=plan.window_ms,
                                 fps=plan.fps, audio=audio, events=events, peaks=peaks)
    words_raw = encode_words(words)
    words_sha = sha256_hex(words_raw)
    if seed is not None:
        # The seed exists but its words artifact is gone: restore it only if identical.
        if words_sha != seed["base"]["words"]["sha256"]:
            return _entry(None, clip.rank, "analysis_incomplete")
        _write_or_match(clip_dir / peaks_file_name(peaks), peaks)
        _write_or_match(clip_dir / words_file_name(words_raw), words_raw)
        return _entry(plan.clip_id, clip.rank, None)
    _write_or_match(clip_dir / peaks_file_name(peaks), peaks)
    _write_or_match(clip_dir / words_file_name(words_raw), words_raw)
    camera_sha = None
    if context.layout == "camera":
        camera_plan = _camera.build_camera_plan(
            state.source, plan.window_ms, plan.fps, out_w=context.render_size[0],
            out_h=context.render_size[1], detector=_camera.detect_face_track,
        )
        camera_raw = _camera.encode_camera_plan(camera_plan)
        _write_or_match(clip_dir / _camera.camera_file_name(camera_raw), camera_raw)
        camera_sha = sha256_hex(camera_raw)
    job = {**state.job, "seedBy": "prepare", "seedAtMs": time.time_ns() // 1_000_000}
    new_seed = build_seed(clip=clip, job=job, source_info=source_info, words_sha=words_sha,
                          words_count=len(words["words"]), camera_sha=camera_sha,
                          selection_sha=state.selection_sha)
    if new_seed["clip_id"] != plan.clip_id:  # pragma: no cover - the same rules build both
        raise SeedError("clip id changed while seeding")
    write_immutable(clip_dir / SEED_FILE, encode_seed(new_seed))  # a concurrent seed wins
    return _entry(plan.clip_id, clip.rank, None)


def prepare_legacy_job(job_dir: Path) -> list[dict]:
    """Persist source.json, words, peaks and seed.json once for every openable clip of a job
    rendered before Essentials; returns ``[{clip_id | None, index, openable, reason}]``."""
    job_dir = Path(job_dir)
    state = _job_state(job_dir)
    if isinstance(state, list):
        return state
    try:
        transcription = transcription_from_json_bytes(
            read_regular(job_dir / TRANSCRIPT_RELATIVE_PATH, MAX_TRANSCRIPT_BYTES)
        )
    except (OSError, ValueError):
        return [_entry(None, clip.rank, "transcript_missing") for clip in state.selection.clips]
    audio = _read_audio(job_dir)
    events = _read_events(job_dir)
    with _Lock(job_dir / CLIPS_RELATIVE_PATH / PREPARE_LOCK):
        try:
            source_info = ensure_source_info(job_dir, state.source)
        except SourceInfoError:
            return [_entry(None, clip.rank, "source_missing") for clip in state.selection.clips]
        return [
            _prepare_clip(job_dir, state, clip, source_info, transcription, audio, events)
            for clip in state.selection.clips
        ]


__all__ = [
    "DEFAULT_RENDER_SIZE",
    "HOOK_DURATION_DEFAULT_S",
    "SeedError",
    "build_seed",
    "encode_seed",
    "grid_window_ms",
    "inspect_job",
    "output_fps",
    "prepare_legacy_job",
    "seed_sha256",
    "seed_window_ms",
]
