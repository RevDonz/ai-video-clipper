"""End-to-end orchestration for the technical spike.

``run_pipeline`` transcribes, selects, renders, and publishes ``manifest.json``. V1 and the V2
shadow keep their historical behaviour. Selection V3 (``selection_mode="v3"``) runs:

1. **Transcript** (stages ``captions``, ``transcribing``). With ``captions_dir`` the best json3
   track in ``<captions_dir>/manual`` and ``<captions_dir>/auto`` is chosen
   (:func:`choose_caption_file`) and judged against the probed video duration. A usable track
   replaces Whisper (``transcript_source="youtube-captions"``) and its sound tags become
   ``analysis/sound-events.json``; otherwise Whisper runs with word timestamps. The captions
   directory is only ever read.
2. **Audio** (stage ``audio``). :func:`analyze_audio_timeline` starts on a daemon thread before
   the transcript step, so it overlaps Whisper, and is awaited for at most
   ``AUDIO_TIMELINE_TIMEOUT + AUDIO_WAIT_GRACE`` seconds. Any failure only adds a warning.
3. **Selection** (stage ``llm`` with an LLM client, ``selecting`` without).
   :func:`select_clips_v3` with the client from :func:`create_llm_client_from_env` (response
   cache in ``analysis/llm-cache``) and the budget from :func:`llm_request_budget`. The LLM
   phase gets at most ``LLM_WAIT_SECONDS`` of wall-clock time (the client itself has no overall
   deadline); after that ``auto`` uses the heuristic and ``required`` fails. Clips are kept
   inside the probed video, then ``analysis/selection.v3.json`` is written.
4. **Packaging and rendering** (stages ``packaging``, ``rendering``): cold open, hook overlay,
   and caption style per clip; the manifest gets every packaging field.

**Konteks Tren.** With ``trend_context`` (the worker's ``analysis/trend-context.json``
snapshot, CLI ``--trend-context``), the active trend items are read with
:func:`load_trend_context` right before selection and passed to :func:`select_clips_v3`. Only
the path is ever handled here: trend text never reaches argv or FFmpeg. A missing or invalid
file only adds ``trend_context_invalid`` and the job runs without trends; malformed items add
``trend_items_skipped:<n>``. A clip grounded in trends gets ``"trends": [{"id", "title",
"kind"}]`` in the manifest; clips without trends keep the exact historical shape, so a job
without relevant trends writes the same manifest and ``selection.v3.json`` as before.

**Fokus klip.** With ``focus`` (a :class:`ai_clipper.focus.FocusSpec`, CLI ``--focus-term`` and
``--focus-note``) the option is passed to :func:`select_clips_v3`, including the heuristic
fallback after the LLM deadline. Every clip then gets ``"focus": {"match", "terms", "at"}`` in
the manifest and the ``selection_v3`` summary gets ``"focus": {"terms", "matched",
"requested"}`` (``matched`` counted from the clips kept inside the video). The focus text is
only data for the selector: it never reaches argv, FFmpeg or the renderer. Without ``focus``
the manifest and ``selection.v3.json`` are exactly as before.

Every mode writes a poster next to each rendered clip: :func:`write_clip_thumbnail` grabs one
frame of ``clip-XX.mp4`` at :func:`thumbnail_time` (1.0 s, so the hook text and the first
captions are on it; earlier for very short clips) into ``clip-XX.jpg``, at most
``THUMBNAIL_WIDTH`` pixels wide, with the same no-clobber publication as the render. The clip's
manifest entry gets ``"thumbnail": "<path>"``. A poster that could not be written never fails
the job: a V3 clip then has ``"thumbnail": null`` (its contract lists every field) and the
summary warning ``thumbnail_failed:<index>``; a V1/V2-shadow clip keeps its historical shape
without the key.

Always written by V3: ``<output>/transcript.json``, ``analysis/transcript-quality.json``,
``analysis/selection.v3.json`` (once selection ran), ``analysis/audio-timeline.json`` and
``analysis/sound-events.json`` when available. The manifest's ``selection_v3`` summary holds
only values the web sanitizers accept (see :func:`_selection_v3_summary`).

V3 summary warning codes added here, before the selector's own codes: ``media_probe_failed``,
``captions_missing``, ``captions_rejected:<reason>`` (``invalid``, ``no_language`` or a
caption quality code), the transcript-quality file codes (``no_word_timestamps``,
``quantized_timestamps``, ``punctuation_collapse:<a>-<b>``) and ``suspect_segments:<n>``,
``audio_unavailable`` (``:timeout``/``:error``), ``trend_context_invalid``,
``trend_items_skipped:<n>``, ``llm_unavailable:<code>``, ``llm_disabled``,
``llm_not_configured``, ``llm_failed:<code>`` (``deadline`` when the wall-clock bound ran out).
After the selector's codes: ``clip_trimmed_to_media:<rank>``, ``cold_open_beyond_media:<rank>``,
``clip_beyond_media:<rank>``, then ``llm_providers:<n>`` and ``llm_models:<n>`` (several
engines answered; the summary names the first), then ``thumbnail_failed:<index>``. A failed run
starts with ``pipeline_failed:<stage>``.
"""

from __future__ import annotations

import json
import math
import os
import re
import stat
import subprocess
import threading
import uuid
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field, replace
from numbers import Real
from pathlib import Path
from typing import Any

from .audio_timeline import ARTIFACT_RELATIVE_PATH as AUDIO_TIMELINE_RELATIVE_PATH
from .audio_timeline import (
    AudioTimeline,
    AudioTimelineError,
    analyze_audio_timeline,
    write_audio_timeline,
)
from .candidates import generate_candidates
from .captions_ass import CAPTION_STYLES
from .features import extract_features
from .focus import FocusSpec
from .highlight import select_highlights
from .llm import LLMClient, LLMError, LLMUnavailable, create_llm_client_from_env, llm_disabled
from .media_features import analyze_media
from .models import ClipProfile, SelectionMode, Transcription
from .ranking import (
    MAX_RANKING_INPUTS,
    SELECTION_VERSION,
    CandidatesArtifact,
    RankedInput,
    WeightConfig,
    rank_candidates_with_breakdowns,
    write_candidates_artifact,
)
from .render import (
    HOOK_DURATION_MAX_SECONDS,
    _create_sibling_temp,
    _probe_source,
    _unlink_if_same,
    _unlink_quietly,
    render_vertical,
    validate_render_mode,
)
from .selection_types import SelectedClip, SelectionResult
from .selection_v3 import (
    LLM_MODES,
    SELECTION_ARTIFACT_RELATIVE_PATH,
    llm_request_budget,
    select_clips_v3,
    write_selection_artifact,
)
from .sound_events import SoundEvent, write_sound_events
from .transcribe import transcribe_video
from .transcript_io import write_transcript_json
from .transcript_quality import (
    TranscriptQuality,
    assess_transcript,
    write_transcript_quality_json,
)
from .trend_context import TrendContextError, TrendItem, load_trend_context
from .youtube_captions import (
    SOUND_EVENTS_RELATIVE_PATH,
    CaptionFormatError,
    choose_caption_file,
    load_youtube_captions,
)
from .youtube_captions import SOURCE_NAME as CAPTIONS_SOURCE_NAME

MAX_MEDIA_CANDIDATES = 100
MAX_MEDIA_TIMEOUT = 300.0
DEFAULT_MAX_CANDIDATES = 200
DEFAULT_MAX_MEDIA_CANDIDATES = 12
DEFAULT_MEDIA_TIMEOUT = 30.0
_CANDIDATES_ARTIFACT = Path("analysis/candidates.v2.json")
_SAFE_INPUT_KEY = re.compile(r"\A\d+:\d+\Z")

DEFAULT_LLM_MODE = "auto"
DEFAULT_HOOK_DURATION = 4.0
AUDIO_TIMELINE_TIMEOUT = 900.0  # one wall-clock deadline for the whole audio analysis
AUDIO_WAIT_GRACE = 30.0
LLM_DEADLINE_SECONDS = 300.0  # the selector starts no new LLM request after this
# The client has no overall deadline (provider x model x retry x per-request timeout), so the
# pipeline stops waiting for the whole LLM phase after this and uses the heuristic instead.
# One free ollama-cloud gpt-oss:120b propose request on a 69-minute episode took 755 s on
# 2026-09-24 (11-33 s during the evaluation), so the bound is generous.
LLM_WAIT_SECONDS = 1200.0
LLM_MAX_REQUESTS = 3
MIN_MEDIA_CLIP_SECONDS = 1.0
MAX_CAPTION_FILES = 64
CAPTION_KINDS = ("manual", "auto")  # directory names written by the web worker, in order
TRANSCRIPT_QUALITY_RELATIVE_PATH = Path("analysis") / "transcript-quality.json"
LLM_CACHE_RELATIVE_PATH = Path("analysis") / "llm-cache"
# The web worker also downloads the legacy ISO 639 code "in" for Indonesian subtitles.
_CAPTION_LANGUAGE_ALIASES = {"id": ("in",)}
_QUALITY_FILE_CODES = ("no_word_timestamps", "quantized_timestamps", "punctuation_collapse")

# Mirrors of the web sanitizers (web/lib/jobs.mjs); anything else is dropped there.
_SUMMARY_PROVIDER = re.compile(r"[a-z0-9][a-z0-9_-]{0,39}")
_SUMMARY_MODEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}")
_SUMMARY_PROMPT_VERSION = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
_SUMMARY_WARNING = re.compile(r"[a-z][a-z0-9_]{0,63}(?::[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,95})?")
_SUMMARY_CODE = re.compile(r"[a-z][a-z0-9_]{0,63}")
_PROMPT_VERSION_JUNK = re.compile(r"[^A-Za-z0-9._-]")
_HASHTAG_BODY = re.compile(r"[A-Za-z0-9_]{1,40}")
_ARCHETYPE_CODE = re.compile(r"[a-z][a-z0-9_]{0,39}")
MAX_SUMMARY_WARNINGS = 50
MAX_SUMMARY_WARNING_CHARS = 160
MAX_MANIFEST_HASHTAGS = 10

THUMBNAIL_SUFFIX = ".jpg"
THUMBNAIL_WIDTH = 720  # never upscaled: a narrower render keeps its own width
THUMBNAIL_QUALITY = 4  # FFmpeg -q:v for MJPEG (2 is best, 31 worst)
THUMBNAIL_AT_SECONDS = 1.0  # the hook overlay and the first caption are on screen by now
THUMBNAIL_SHORT_AT_SECONDS = 0.3
THUMBNAIL_SHORT_CLIP_SECONDS = 2.0
THUMBNAIL_TIMEOUT_SECONDS = 60
MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024
_JPEG_START = b"\xff\xd8\xff"
_JPEG_END = b"\xff\xd9"


class ThumbnailError(RuntimeError):
    """A clip poster could not be written. Messages never contain a path."""


def thumbnail_time(duration: float) -> float:
    """Where the poster frame is taken in a clip of ``duration`` rendered seconds."""
    if duration >= THUMBNAIL_SHORT_CLIP_SECONDS:
        return THUMBNAIL_AT_SECONDS
    return max(0.0, min(THUMBNAIL_SHORT_AT_SECONDS, duration / 2))


def _require_thumbnail_absent(directory_fd: int, name: str) -> None:
    try:
        info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    except OSError as exc:
        raise ThumbnailError("thumbnail destination could not be inspected") from exc
    if stat.S_ISLNK(info.st_mode):
        raise ThumbnailError("thumbnail destination is not a regular file")
    raise ThumbnailError("thumbnail destination already exists")


def _require_jpeg(fd: int) -> None:
    size = os.fstat(fd).st_size
    if not len(_JPEG_START) + len(_JPEG_END) <= size <= MAX_THUMBNAIL_BYTES:
        raise ThumbnailError("thumbnail is not a JPEG")
    if (
        os.pread(fd, len(_JPEG_START), 0) != _JPEG_START
        or os.pread(fd, len(_JPEG_END), size - len(_JPEG_END)) != _JPEG_END
    ):
        raise ThumbnailError("thumbnail is not a JPEG")


def _thumbnail_command(clip_fd: int, image_fd: int, at: float) -> list[str]:
    return [
        "ffmpeg",
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        f"{at:.3f}",
        "-i",
        f"/proc/self/fd/{clip_fd}",
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-vf",
        f"scale='min({THUMBNAIL_WIDTH},iw)':-2",
        "-q:v",
        str(THUMBNAIL_QUALITY),
        "-map_metadata",
        "-1",
        "-f",
        "image2",
        "-update",
        "1",
        "-c:v",
        "mjpeg",
        f"/proc/self/fd/{image_fd}",
    ]


def write_clip_thumbnail(clip: Path, *, duration: float) -> Path:
    """Write ``clip``'s poster frame to ``clip-XX.jpg`` beside it and return that path.

    The rendered clip is opened without following symlinks and FFmpeg only sees file
    descriptors. The JPEG goes to a private sibling temporary file, is checked, and is then
    hard-linked into place, so an existing file or symlink is never replaced and a failure
    leaves nothing behind. Raises :class:`ThumbnailError` (or ``OSError``) on failure.
    """
    if not isinstance(duration, Real) or isinstance(duration, bool):
        raise TypeError("duration must be a number")
    duration = float(duration)
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("duration must be finite and positive")
    clip = Path(clip).absolute()
    destination = clip.with_suffix(THUMBNAIL_SUFFIX)
    if destination.name == clip.name:
        raise ValueError("clip and thumbnail destinations must be distinct")
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    try:
        directory_fd = os.open(clip.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | nofollow)
    except OSError as exc:
        raise ThumbnailError("thumbnail directory is not safe") from exc

    clip_fd = image_fd = -1
    temporary = ""
    published: os.stat_result | None = None
    try:
        try:
            clip_fd = os.open(clip.name, os.O_RDONLY | os.O_CLOEXEC | nofollow, dir_fd=directory_fd)
        except FileNotFoundError as exc:
            raise ThumbnailError("thumbnail clip is missing") from exc
        except OSError as exc:
            raise ThumbnailError("thumbnail clip is not a regular file") from exc
        if not stat.S_ISREG(os.fstat(clip_fd).st_mode):
            raise ThumbnailError("thumbnail clip is not a regular file")
        _require_thumbnail_absent(directory_fd, destination.name)
        try:
            image_fd, temporary = _create_sibling_temp(directory_fd, THUMBNAIL_SUFFIX)
        except (OSError, RuntimeError) as exc:
            raise ThumbnailError("could not create a thumbnail temporary file") from exc
        command = _thumbnail_command(clip_fd, image_fd, thumbnail_time(duration))
        try:
            subprocess.run(
                command,
                check=True,
                capture_output=True,
                timeout=THUMBNAIL_TIMEOUT_SECONDS,
                pass_fds=(clip_fd, image_fd),
            )
        except subprocess.TimeoutExpired as exc:
            raise ThumbnailError("FFmpeg thumbnail timed out") from exc
        except (subprocess.CalledProcessError, OSError) as exc:
            raise ThumbnailError("FFmpeg thumbnail failed") from exc
        _require_jpeg(image_fd)
        os.fsync(image_fd)
        _require_thumbnail_absent(directory_fd, destination.name)
        os.link(
            temporary,
            destination.name,
            src_dir_fd=directory_fd,
            dst_dir_fd=directory_fd,
            follow_symlinks=False,
        )
        published = os.fstat(image_fd)
        os.fsync(directory_fd)
        return destination
    except FileExistsError as exc:
        raise ThumbnailError("thumbnail destination already exists") from exc
    except BaseException:
        if published is not None:
            _unlink_if_same(directory_fd, destination.name, published)
        raise
    finally:
        for fd in (clip_fd, image_fd):
            if fd >= 0:
                os.close(fd)
        if temporary:
            _unlink_quietly(directory_fd, temporary)
        os.close(directory_fd)


def _clip_thumbnail(
    clip_path: Path, duration: float, index: int, warnings: list[str] | None
) -> str | None:
    """The poster path for the manifest, or ``None``: a missing poster never fails a job."""
    try:
        return str(write_clip_thumbnail(clip_path, duration=duration))
    except (ThumbnailError, OSError):
        if warnings is not None:
            warnings.append(f"thumbnail_failed:{index}")
        return None


def _publish_manifest(path: Path, payload: dict[str, object]) -> None:
    """Atomically replace the public manifest with one complete state."""
    pending_path = path.with_name(".manifest.json.next")
    pending_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    pending_path.replace(path)


def _bounded_integer(value: object, name: str, maximum: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError(f"{name} must be an integer")
    if not 1 <= value <= maximum:
        raise ValueError(f"{name} must be between 1 and {maximum}")
    return value


def _positive_integer(value: object, name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError(f"{name} must be an integer")
    if value <= 0:
        raise ValueError(f"{name} must be positive")
    return value


def _bounded_timeout(value: object) -> float:
    if not isinstance(value, Real) or isinstance(value, bool):
        raise TypeError("media_timeout must be a number")
    result = float(value)
    if not math.isfinite(result) or not 0 < result <= MAX_MEDIA_TIMEOUT:
        raise ValueError(f"media_timeout must be finite and between 0 and {MAX_MEDIA_TIMEOUT}")
    return result


def _boolean(value: object, name: str) -> bool:
    if not isinstance(value, bool):
        raise TypeError(f"{name} must be a boolean")
    return value


def _choice(value: object, name: str, choices: tuple[str, ...]) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{name} must be a string")
    if value not in choices:
        raise ValueError(f"{name} must be one of {', '.join(choices)}")
    return value


def _hook_duration(value: object) -> float:
    if not isinstance(value, Real) or isinstance(value, bool):
        raise TypeError("hook_duration must be a number")
    result = float(value)
    if not math.isfinite(result) or not 0 < result <= HOOK_DURATION_MAX_SECONDS:
        raise ValueError(
            f"hook_duration must be finite, above 0 and at most {HOOK_DURATION_MAX_SECONDS:g}"
        )
    return result


def _clip_bounds(min_duration: object, max_duration: object) -> tuple[float, float]:
    values = []
    for name, value in (("min_duration", min_duration), ("max_duration", max_duration)):
        if not isinstance(value, Real) or isinstance(value, bool):
            raise TypeError(f"{name} must be a number")
        if not math.isfinite(value) or value <= 0:
            raise ValueError(f"{name} must be finite and positive")
        values.append(float(value))
    if values[1] < values[0]:
        raise ValueError("max_duration must not be below min_duration")
    return values[0], values[1]


def _optional_path(value: object, name: str) -> Path | None:
    if value is None:
        return None
    if not isinstance(value, (str, os.PathLike)):
        raise TypeError(f"{name} must be a path or None")
    return Path(value).resolve()


def _job_trends(path: Path | None, warnings: list[str]) -> tuple[TrendItem, ...]:
    """The snapshot's active items; a missing or invalid snapshot only adds a warning."""
    if path is None:
        return ()
    try:
        context = load_trend_context(path)
    except (TrendContextError, ValueError, OSError):
        warnings.append("trend_context_invalid")
        return ()
    if context.skipped:
        warnings.append(f"trend_items_skipped:{context.skipped}")
    return context.items


def _safe_candidate_key(input_key: str, ordinal: int) -> str:
    """Return only an internally generated numeric candidate identifier."""
    return input_key if _SAFE_INPUT_KEY.fullmatch(input_key) else str(ordinal)


def _archive_current_artifact(output_dir: Path) -> Path | None:
    """Move the canonical artifact aside without following links or deleting data."""
    current = output_dir / _CANDIDATES_ARTIFACT
    if current.parent.is_symlink():
        raise ValueError("analysis directory must not be a symlink")
    if not os.path.lexists(current):
        return None
    mode = current.lstat().st_mode
    if not (stat.S_ISREG(mode) or stat.S_ISLNK(mode)):
        raise ValueError("current candidates artifact must be a regular file or symlink")
    previous = current.with_name(f"{current.name}.previous")
    if os.path.lexists(previous):
        while True:
            previous = current.with_name(f"{current.name}.previous.{uuid.uuid4().hex}")
            if not os.path.lexists(previous):
                break
    os.replace(current, previous)
    return previous


def _run_v2_shadow(
    source: Path,
    output_dir: Path,
    segments: list[Any],
    *,
    profile: ClipProfile,
    max_candidates: int,
    max_media_candidates: int,
    media_timeout: float,
    k: int,
    report: Callable[[str, int, str], None],
) -> dict[str, object]:
    analysis_id = uuid.uuid4().hex
    warnings: list[str] = []
    try:
        _archive_current_artifact(output_dir)
        report("candidates_generating", 58, "Membuat kandidat V2 dari batas transkrip")
        boundaries = generate_candidates(
            segments,
            profile,
            max_candidates=max_candidates,
        )
        if not boundaries:
            raise ValueError("no V2 candidates satisfy the selected profile")

        report("features", 58, "Mengukur fitur teks kandidat V2")
        text_inputs = [
            RankedInput(
                f"{candidate.start_index}:{candidate.end_index}",
                candidate,
                extract_features(candidate),
            )
            for candidate in boundaries
        ]
        report("ranking", 59, "Membuat shortlist teks V2")
        shortlist = rank_candidates_with_breakdowns(
            text_inputs,
            source=str(source),
            profile=profile,
            k=min(max_media_candidates, len(text_inputs)),
        )
        input_by_interval = {
            (item.candidate.start, item.candidate.end): item for item in text_inputs
        }
        shortlisted_inputs = [
            input_by_interval[(candidate.start, candidate.end)]
            for candidate in shortlist.candidates
        ]

        report("media", 59, "Mengukur media hanya untuk shortlist V2")
        rerank_inputs: list[RankedInput] = []
        for ordinal, item in enumerate(shortlisted_inputs, start=1):
            safe_key = _safe_candidate_key(item.input_key, ordinal)
            try:
                measured = analyze_media(
                    source,
                    start=item.candidate.start,
                    end=item.candidate.end,
                    timeout=media_timeout,
                )
                if measured.warnings:
                    warnings.append(
                        f"candidate {safe_key}: media_analysis_warnings={len(measured.warnings)}"
                    )
                rerank_inputs.append(
                    RankedInput(item.input_key, item.candidate, item.extraction, measured)
                )
            except Exception:  # noqa: BLE001 - isolate each shadow media measurement
                warnings.append(f"candidate {safe_key}: media_unavailable")
                rerank_inputs.append(item)

        selection = rank_candidates_with_breakdowns(
            rerank_inputs,
            source=str(source),
            profile=profile,
            k=min(k, len(rerank_inputs)),
        )
        artifact = CandidatesArtifact(
            selection_version=SELECTION_VERSION,
            source=str(source),
            provenance=(
                "pipeline: transcript boundary candidates",
                "pipeline: deterministic text shortlist before bounded media analysis",
            ),
            weight_config=WeightConfig(),
            candidates=selection.candidates,
            breakdowns=selection.breakdowns,
            media_snapshots=selection.media_snapshots,
        )
        artifact_path = output_dir / _CANDIDATES_ARTIFACT
        write_candidates_artifact(artifact_path, artifact)
        report("candidates_ready", 60, "Kandidat bayangan V2 siap")
        return {
            "mode": SelectionMode.V2_SHADOW.value,
            "status": "completed",
            "analysis_id": analysis_id,
            "selection_version": SELECTION_VERSION,
            "candidate_count": len(selection.candidates),
            "artifact": _CANDIDATES_ARTIFACT.as_posix(),
            "warnings": warnings,
        }
    except Exception:  # noqa: BLE001 - the entire V2 shadow must not break V1
        try:
            _archive_current_artifact(output_dir)
        except Exception:  # noqa: BLE001 - preserve the original isolated shadow failure
            warnings.append("artifact_archive_failed")
        return {
            "mode": SelectionMode.V2_SHADOW.value,
            "status": "failed",
            "analysis_id": analysis_id,
            "selection_version": SELECTION_VERSION,
            "candidate_count": 0,
            "artifact": _CANDIDATES_ARTIFACT.as_posix(),
            "warnings": warnings,
            "error": "shadow_failed",
        }


# --- Selection V3 -----------------------------------------------------------------------------


@dataclass(slots=True)
class _V3State:
    """What a V3 run has learned so far; the manifest summary is built from it."""

    stage: str = "analyzing"
    warnings: list[str] = field(default_factory=list)
    transcript_source: str | None = None
    result: SelectionResult | None = None
    artifact_written: bool = False


class _StillRunning(Exception):
    """A background call did not finish within the wait (never raised by the call itself)."""


class _BackgroundCall:
    """Runs ``target`` on a daemon thread, so a stuck call never blocks process exit."""

    def __init__(self, target: Callable[[], Any], *, name: str) -> None:
        self._target = target
        self._done = threading.Event()
        self._value: Any = None
        self._error: BaseException | None = None
        threading.Thread(target=self._run, name=name, daemon=True).start()

    def _run(self) -> None:
        try:
            self._value = self._target()
        except BaseException as error:  # noqa: BLE001 - handed over to the waiting thread
            self._error = error
        finally:
            self._done.set()

    def result(self, timeout: float) -> Any:
        if not self._done.wait(timeout):
            raise _StillRunning
        if self._error is not None:
            raise self._error
        return self._value


def _probe_video_duration(source: Path) -> float | None:
    """The selected video stream's duration as the renderer sees it, or ``None``."""
    try:
        duration, _video, _audio = _probe_source(source)
    except (OSError, RuntimeError, ValueError):
        return None
    return duration if math.isfinite(duration) and duration > 0 else None


def _caption_files(captions_dir: Path) -> list[Path]:
    """Regular, non-hidden ``.json3`` files in ``manual/`` then ``auto/``; nothing is written."""
    files: list[Path] = []
    for kind in CAPTION_KINDS:
        directory = captions_dir / kind
        if directory.is_symlink() or not directory.is_dir():
            continue
        try:
            with os.scandir(directory) as entries:
                names = sorted(
                    entry.name
                    for entry in entries
                    if not entry.name.startswith(".")
                    and entry.name.casefold().endswith(".json3")
                    and entry.is_file(follow_symlinks=False)
                )
        except OSError:
            continue
        files.extend(directory / name for name in names)
    return files[:MAX_CAPTION_FILES]


def _choose_captions(files: list[Path], language: str) -> Path | None:
    for code in (language, *_CAPTION_LANGUAGE_ALIASES.get(language.casefold(), ())):
        chosen = choose_caption_file(files, language=code)
        if chosen is not None:
            return chosen
    return None


def _load_captions(
    captions_dir: Path,
    *,
    language: str | None,
    media_duration: float | None,
    warnings: list[str],
) -> tuple[Transcription, tuple[SoundEvent, ...]] | None:
    """A usable caption track and its sound events, or ``None`` (with a warning code)."""
    if language is None:
        warnings.append("captions_rejected:no_language")
        return None
    try:
        chosen = _choose_captions(_caption_files(captions_dir), language)
        if chosen is None:
            warnings.append("captions_missing")
            return None
        transcription, events, quality = load_youtube_captions(
            chosen, media_duration=media_duration, language=language
        )
    except (CaptionFormatError, OSError, TypeError, ValueError):
        warnings.append("captions_rejected:invalid")
        return None
    if not quality.ok:
        warnings.extend(f"captions_rejected:{reason}" for reason in quality.reasons)
        return None
    return transcription, events


def _v3_transcript(
    source: Path,
    *,
    model: Any,
    language: str | None,
    captions_dir: Path | None,
    media_duration: float | None,
    word_timestamps: bool,
    report: Callable[[str, int, str], None],
    state: _V3State,
) -> tuple[Transcription, tuple[SoundEvent, ...]]:
    if captions_dir is not None:
        state.stage = "captions"
        report("captions", 28, "Memeriksa subtitle YouTube")
        captions = _load_captions(
            captions_dir,
            language=language,
            media_duration=media_duration,
            warnings=state.warnings,
        )
        if captions is not None:
            state.transcript_source = "youtube-captions"
            return captions
    state.stage = "transcribing"
    report("transcribing", 30, "Mendengarkan dan menulis transkrip")
    transcription = transcribe_video(
        source,
        model=model,
        language=language,
        word_timestamps=word_timestamps,
        progress_callback=lambda fraction: report(
            "transcribing",
            30 + round(fraction * 27),
            f"Transkripsi audio {round(fraction * 100)}%",
        ),
    )
    state.transcript_source = "whisper"
    return transcription, ()


def _quality_codes(quality: TranscriptQuality) -> list[str]:
    """File-level transcript-quality codes plus one count for the per-segment ones."""
    codes = [code for code in quality.warnings if code.split(":", 1)[0] in _QUALITY_FILE_CODES]
    if quality.suspect_segment_indices:
        codes.append(f"suspect_segments:{len(quality.suspect_segment_indices)}")
    return codes


def _collect_audio(job: _BackgroundCall, warnings: list[str]) -> AudioTimeline | None:
    try:
        timeline = job.result(AUDIO_TIMELINE_TIMEOUT + AUDIO_WAIT_GRACE)
    except _StillRunning:
        warnings.append("audio_unavailable:timeout")
        return None
    except AudioTimelineError:
        warnings.append("audio_unavailable")
        return None
    except Exception:  # noqa: BLE001 - the audio timeline only refines boundaries
        warnings.append("audio_unavailable:error")
        return None
    if not isinstance(timeline, AudioTimeline):
        warnings.append("audio_unavailable:error")
        return None
    return timeline


def _v3_llm_client(
    llm_mode: str, artifact_root: Path, warnings: list[str]
) -> tuple[LLMClient | None, tuple[int, int] | None, str]:
    """``(client, (context_tokens, max_output_tokens), llm_mode for the selector)``."""
    if llm_mode == "off":
        return None, None, "off"
    try:
        client = create_llm_client_from_env(cache_dir=artifact_root / LLM_CACHE_RELATIVE_PATH)
        budget = None if client is None else llm_request_budget()
    except LLMUnavailable as error:
        warnings.append(f"llm_unavailable:{error.code}")
        if llm_mode == "required":
            raise
        return None, None, llm_mode  # the selector records the fallback
    if client is None or budget is None:
        disabled = llm_disabled()
        warnings.append("llm_disabled" if disabled else "llm_not_configured")
        if llm_mode == "required":
            raise LLMUnavailable(
                "not_configured",
                "LLM wajib dipakai (--llm required), tetapi "
                + (
                    "dimatikan dengan POTONGIN_LLM=off."
                    if disabled
                    else "belum dikonfigurasi; atur POTONGIN_LLM_PROVIDER dan API key-nya."
                ),
            )
        return None, None, "off"
    return client, budget, llm_mode


def _select_within_deadline(
    select: Callable[[], SelectionResult],
    *,
    heuristic: Callable[[], SelectionResult],
    llm_mode: str,
) -> SelectionResult:
    """Run an LLM-backed selection for at most ``LLM_WAIT_SECONDS`` of wall-clock time.

    A request still in flight after that is abandoned on its daemon thread. ``auto`` then
    returns the heuristic selection as a fallback (``llm_failed:deadline``); ``required``
    raises ``LLMError("timeout")``.
    """
    job = _BackgroundCall(select, name="potongin-llm-selection")
    try:
        return job.result(LLM_WAIT_SECONDS)
    except _StillRunning:
        if llm_mode == "required":
            raise LLMError(
                "timeout",
                f"LLM tidak selesai memilih momen dalam {LLM_WAIT_SECONDS:g} detik.",
            ) from None
    fallback = heuristic()
    return replace(
        fallback, status="fallback", warnings=("llm_failed:deadline", *fallback.warnings)[:200]
    )


def _fit_to_media(result: SelectionResult, duration: float | None) -> SelectionResult:
    """Keep every clip inside the probed video; the renderer rejects ranges past its end."""
    if duration is None:
        return result
    limit = math.floor(duration * 1000) / 1000
    clips: list[SelectedClip] = []
    notes: list[str] = []
    for clip in result.clips:
        end = min(clip.end, limit)
        if end - clip.start < MIN_MEDIA_CLIP_SECONDS:
            notes.append(f"clip_beyond_media:{clip.rank}")
            continue
        if end < clip.end:
            notes.append(f"clip_trimmed_to_media:{clip.rank}")
        teaser = clip.cold_open
        if teaser is not None and teaser[1] > duration:
            notes.append(f"cold_open_beyond_media:{clip.rank}")
            teaser = None
        clips.append(replace(clip, rank=len(clips) + 1, end=end, cold_open=teaser))
    if not notes:
        return result
    return replace(result, clips=tuple(clips), warnings=(*result.warnings, *notes)[:200])


def _manifest_hashtags(hashtags: Iterable[str]) -> list[str]:
    tags: list[str] = []
    for item in hashtags:
        body = item.strip().lstrip("#")
        tag = f"#{body}"
        if _HASHTAG_BODY.fullmatch(body) and tag not in tags:
            tags.append(tag)
        if len(tags) == MAX_MANIFEST_HASHTAGS:
            break
    return tags


def _rendered_seconds(clip: SelectedClip, cold_open: tuple[float, float] | None) -> float:
    rendered = clip.end - clip.start
    if cold_open is not None:
        rendered += cold_open[1] - cold_open[0]
    return rendered


def _v3_manifest_clip(
    index: int,
    clip: SelectedClip,
    cold_open: tuple[float, float] | None,
    clip_path: Path,
    thumbnail: str | None,
) -> dict[str, object]:
    """V1-compatible clip fields plus the Selection V3 packaging (the web contract)."""
    rendered = _rendered_seconds(clip, cold_open)
    entry: dict[str, object] = {
        "index": index,
        "start": round(clip.start, 3),
        "end": round(clip.end, 3),
        "duration": round(rendered, 3),
        "score": round(clip.score, 2),
        "text": clip.text,
        "output": str(clip_path),
        "subtitles": str(clip_path.with_suffix(".srt")),
        "title": clip.title,
        "hook_text": clip.hook_text,
        "description": clip.description or None,
        "hashtags": _manifest_hashtags(clip.hashtags),
        "archetype": clip.archetype if _ARCHETYPE_CODE.fullmatch(clip.archetype) else None,
        "selection_source": clip.source,
        "reasons": list(clip.reasons),
        "scores": {name: round(float(value), 2) for name, value in clip.scores.items()},
        "cold_open": None
        if cold_open is None
        else {"start": round(cold_open[0], 3), "end": round(cold_open[1], 3)},
        "source_start": round(clip.start, 3),
        "source_end": round(clip.end, 3),
        "thumbnail": thumbnail,
    }
    if clip.trends:  # optional: clips without trends keep the historical contract
        entry["trends"] = [item.to_dict() for item in clip.trends]
    if clip.focus is not None:  # optional: only a job with focus terms has it
        entry["focus"] = clip.focus.to_dict()
    return entry


def _summary_warnings(codes: Iterable[str]) -> list[str]:
    """Stable codes only: a code with an unsafe detail keeps its bare code, others are dropped."""
    kept: list[str] = []
    for code in codes:
        if not isinstance(code, str):
            continue
        if len(code) > MAX_SUMMARY_WARNING_CHARS or not _SUMMARY_WARNING.fullmatch(code):
            code = code.split(":", 1)[0]
            if not _SUMMARY_CODE.fullmatch(code):
                continue
        if code not in kept:
            kept.append(code)
        if len(kept) == MAX_SUMMARY_WARNINGS:
            break
    return kept


def _engine_name(
    value: str | None, pattern: re.Pattern[str], code: str, notes: list[str]
) -> str | None:
    """The first of ``a+b`` provider/model names (several engines answered), if it is safe."""
    if value is None:
        return None
    names = [name for name in value.split("+") if name]
    if len(names) > 1:
        notes.append(f"{code}:{len(names)}")
    return names[0] if names and pattern.fullmatch(names[0]) else None


def _summary_prompt_version(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = _PROMPT_VERSION_JUNK.sub(".", value)[:64]
    return normalized if _SUMMARY_PROMPT_VERSION.fullmatch(normalized) else None


def _selection_v3_summary(state: _V3State, *, failed: bool) -> dict[str, object]:
    """The manifest's ``selection_v3`` object, restricted to what the web sanitizer keeps."""
    result = state.result
    notes: list[str] = []
    provider = model = prompt_version = source = None
    status = "failed" if failed else "completed"
    if result is not None:
        source = result.source
        provider = _engine_name(result.provider, _SUMMARY_PROVIDER, "llm_providers", notes)
        model = _engine_name(result.model, _SUMMARY_MODEL, "llm_models", notes)
        prompt_version = _summary_prompt_version(result.prompt_version)
        if not failed:
            status = result.status
    leading = [f"pipeline_failed:{state.stage}"] if failed else []
    summary: dict[str, object] = {
        "mode": SelectionMode.V3.value,
        "status": status,
        "source": source,
        "provider": provider,
        "model": model,
        "prompt_version": prompt_version,
        "warnings": _summary_warnings([*leading, *state.warnings, *notes]),
        "artifact": SELECTION_ARTIFACT_RELATIVE_PATH.as_posix() if state.artifact_written else None,
        "transcript_source": state.transcript_source,
    }
    if result is not None and result.focus is not None:  # only a job with focus terms
        summary["focus"] = {
            "terms": list(result.focus.terms),
            "matched": result.focus_matched,
            "requested": result.focus.requested,
        }
    return summary


def _run_v3(
    source: Path,
    output_dir: Path,
    artifact_root: Path,
    *,
    state: _V3State,
    report: Callable[[str, int, str], None],
    model: Any,
    language: str | None,
    min_duration: float,
    max_duration: float,
    limit: int,
    width: int,
    height: int,
    render_mode: str,
    llm_mode: str,
    cold_open: bool,
    hook_overlay: bool,
    hook_duration: float,
    caption_style: str,
    captions_dir: Path | None,
    word_timestamps: bool,
    trend_context: Path | None = None,
    focus: FocusSpec | None = None,
) -> tuple[Transcription, Path, list[dict[str, object]]]:
    """Transcript, audio, selection, and rendering for Selection V3 (see the module docstring)."""
    media_duration = _probe_video_duration(source)
    if media_duration is None:
        state.warnings.append("media_probe_failed")
    audio_job = _BackgroundCall(
        lambda: analyze_audio_timeline(source, timeout=AUDIO_TIMELINE_TIMEOUT),
        name="potongin-audio-timeline",
    )
    transcription, events = _v3_transcript(
        source,
        model=model,
        language=language,
        captions_dir=captions_dir,
        media_duration=media_duration,
        word_timestamps=word_timestamps,
        report=report,
        state=state,
    )
    if not transcription.segments:
        raise ValueError("Transcription produced no usable segments")
    transcript_path = output_dir / "transcript.json"
    write_transcript_json(transcript_path, transcription)
    quality = assess_transcript(transcription.segments, language=transcription.language or "id")
    write_transcript_quality_json(artifact_root / TRANSCRIPT_QUALITY_RELATIVE_PATH, quality)
    state.warnings.extend(_quality_codes(quality))
    if events:
        write_sound_events(
            artifact_root / SOUND_EVENTS_RELATIVE_PATH, events, source=CAPTIONS_SOURCE_NAME
        )

    state.stage = "audio"
    report("audio", 58, "Menganalisis jeda dan energi audio")
    audio = _collect_audio(audio_job, state.warnings)
    if audio is not None:
        write_audio_timeline(audio, artifact_root / AUDIO_TIMELINE_RELATIVE_PATH)

    trends = _job_trends(trend_context, state.warnings)
    context_options: dict[str, object] = {"trends": trends} if trends else {}
    if focus is not None:
        context_options["focus"] = focus
    state.stage = "llm"
    client, budget, selector_mode = _v3_llm_client(llm_mode, artifact_root, state.warnings)
    if client is not None:
        report("llm", 60, "AI (LLM) memilih momen terbaik")
    else:
        state.stage = "selecting"
        report("selecting", 60, "Memilih momen terbaik dengan heuristik lokal")
    budget_options = (
        {} if budget is None else {"context_tokens": budget[0], "max_output_tokens": budget[1]}
    )

    def select(selector_client: LLMClient | None, mode: str) -> SelectionResult:
        return select_clips_v3(
            transcription.segments,
            k=limit,
            min_duration=min_duration,
            max_duration=max_duration,
            llm_client=selector_client,
            llm_mode=mode,
            events=events,
            audio=audio,
            quality=quality,
            cold_open=cold_open,
            max_requests=LLM_MAX_REQUESTS,
            deadline_s=LLM_DEADLINE_SECONDS,
            **budget_options,
            **context_options,
        )

    try:
        if client is None:
            result = select(None, selector_mode)
        else:
            result = _select_within_deadline(
                lambda: select(client, selector_mode),
                heuristic=lambda: select(None, "off"),
                llm_mode=selector_mode,
            )
    except LLMError as error:
        state.warnings.append(f"llm_failed:{error.code}")
        raise
    result = _fit_to_media(result, media_duration)
    state.result = result
    state.warnings.extend(result.warnings)
    write_selection_artifact(artifact_root / SELECTION_ARTIFACT_RELATIVE_PATH, result)
    state.artifact_written = True
    if not result.clips:
        raise ValueError(
            "Tidak ada momen yang bisa dijadikan klip dalam batas durasi "
            f"{min_duration:g}-{max_duration:g} detik."
        )

    state.stage = "packaging"
    report("packaging", 63, "Menyiapkan judul, hook, dan caption klip")
    plans = [(clip, clip.cold_open if cold_open else None) for clip in result.clips]

    state.stage = "rendering"
    clips: list[dict[str, object]] = []
    for index, (clip, teaser) in enumerate(plans, start=1):
        report(
            "rendering",
            65 + round(((index - 1) / len(plans)) * 29),
            f"Merender klip {index} dari {len(plans)}",
        )
        clip_path = output_dir / f"clip-{index:02d}.mp4"
        render_vertical(
            source,
            clip_path,
            start=clip.start,
            end=clip.end,
            transcript=transcription.segments,
            width=width,
            height=height,
            render_mode=render_mode,
            cold_open=teaser,
            hook_text=clip.hook_text if hook_overlay else None,
            hook_duration=hook_duration,
            caption_style=caption_style,
        )
        thumbnail = _clip_thumbnail(
            clip_path, _rendered_seconds(clip, teaser), index, state.warnings
        )
        clips.append(_v3_manifest_clip(index, clip, teaser, clip_path, thumbnail))
    state.stage = "finalizing"
    return transcription, transcript_path, clips


def run_pipeline(
    source: Path,
    output_dir: Path,
    *,
    model: Any,
    artifact_root: Path | None = None,
    language: str | None = "id",
    min_duration: float = 20.0,
    max_duration: float = 60.0,
    limit: int = 5,
    width: int = 1080,
    height: int = 1920,
    render_mode: str = "center-crop",
    selection_mode: SelectionMode | str = SelectionMode.V1,
    clip_profile: ClipProfile | str = ClipProfile.STANDARD,
    max_candidates: int = DEFAULT_MAX_CANDIDATES,
    max_media_candidates: int = DEFAULT_MAX_MEDIA_CANDIDATES,
    media_timeout: float = DEFAULT_MEDIA_TIMEOUT,
    llm_mode: str = DEFAULT_LLM_MODE,
    cold_open: bool = True,
    hook_overlay: bool = True,
    caption_style: str | None = None,
    captions_dir: Path | str | None = None,
    word_timestamps: bool = True,
    hook_duration: float = DEFAULT_HOOK_DURATION,
    progress: Callable[[str, int, str], None] | None = None,
    trend_context: Path | str | None = None,
    focus: FocusSpec | None = None,
) -> Path:
    """Transcribe, select highlights, render clips, and publish a status manifest.

    ``llm_mode``, ``cold_open``, ``hook_overlay``, ``hook_duration``, ``captions_dir``,
    ``trend_context`` (a Konteks Tren snapshot) and ``focus`` (the Fokus klip option) only
    apply to ``selection_mode="v3"``. ``caption_style`` defaults to ``"karaoke"`` for V3 and
    ``"classic"`` otherwise; ``word_timestamps`` applies to every Whisper run.
    """
    source = Path(source).resolve()
    output_dir = Path(output_dir).resolve()
    artifact_root = output_dir if artifact_root is None else Path(artifact_root).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = output_dir / "manifest.json"
    manifest_base: dict[str, object] = {"source": str(source), "render_mode": render_mode}
    _publish_manifest(manifest_path, {**manifest_base, "status": "processing"})
    selection_v2_summary: dict[str, object] | None = None
    v3_state: _V3State | None = None

    def report(stage: str, percent: int, detail: str) -> None:
        if progress is not None:
            progress(stage, percent, detail)

    try:
        if not isinstance(selection_mode, (SelectionMode, str)):
            raise TypeError("selection_mode must be a SelectionMode or string")
        selection_mode = SelectionMode(selection_mode)
        if selection_mode is SelectionMode.V3:
            v3_state = _V3State()
        if not isinstance(clip_profile, (ClipProfile, str)):
            raise TypeError("clip_profile must be a ClipProfile or string")
        clip_profile = ClipProfile(clip_profile)
        limit = _positive_integer(limit, "limit")
        max_candidates = _bounded_integer(max_candidates, "max_candidates", MAX_RANKING_INPUTS)
        max_media_candidates = _bounded_integer(
            max_media_candidates, "max_media_candidates", MAX_MEDIA_CANDIDATES
        )
        max_media_candidates = min(max_media_candidates, max_candidates)
        media_timeout = _bounded_timeout(media_timeout)
        llm_mode = _choice(llm_mode, "llm_mode", LLM_MODES)
        cold_open = _boolean(cold_open, "cold_open")
        hook_overlay = _boolean(hook_overlay, "hook_overlay")
        word_timestamps = _boolean(word_timestamps, "word_timestamps")
        hook_duration = _hook_duration(hook_duration)
        if caption_style is None:
            caption_style = "karaoke" if selection_mode is SelectionMode.V3 else "classic"
        caption_style = _choice(caption_style, "caption_style", CAPTION_STYLES)
        captions_dir = _optional_path(captions_dir, "captions_dir")
        trend_context = _optional_path(trend_context, "trend_context")
        if focus is not None and not isinstance(focus, FocusSpec):
            raise TypeError("focus must be a FocusSpec or None")
        if selection_mode is SelectionMode.V3:
            min_duration, max_duration = _clip_bounds(min_duration, max_duration)
        report("analyzing", 26, "Memeriksa video dan memuat model AI")
        validate_render_mode(render_mode)

        if v3_state is not None:
            transcription, transcript_path, clips = _run_v3(
                source,
                output_dir,
                artifact_root,
                state=v3_state,
                report=report,
                model=model,
                language=language,
                min_duration=min_duration,
                max_duration=max_duration,
                limit=limit,
                width=width,
                height=height,
                render_mode=render_mode,
                llm_mode=llm_mode,
                cold_open=cold_open,
                hook_overlay=hook_overlay,
                hook_duration=hook_duration,
                caption_style=caption_style,
                captions_dir=captions_dir,
                word_timestamps=word_timestamps,
                trend_context=trend_context,
                focus=focus,
            )
            report("finalizing", 96, "Menyimpan hasil, subtitle, dan metadata")
            _publish_manifest(
                manifest_path,
                {
                    **manifest_base,
                    "status": "completed",
                    "language": transcription.language,
                    "transcript": str(transcript_path),
                    "clips": clips,
                    "render_mode": render_mode,
                    "selection_v3": _selection_v3_summary(v3_state, failed=False),
                },
            )
            return manifest_path

        report("transcribing", 30, "Mendengarkan dan menulis transkrip")
        transcription = transcribe_video(
            source,
            model=model,
            language=language,
            word_timestamps=word_timestamps,
            progress_callback=lambda fraction: report(
                "transcribing",
                30 + round(fraction * 27),
                f"Transkripsi audio {round(fraction * 100)}%",
            ),
        )
        if not transcription.segments:
            raise ValueError("Transcription produced no usable segments")

        if selection_mode is SelectionMode.V2_SHADOW:
            selection_v2_summary = _run_v2_shadow(
                source,
                artifact_root,
                transcription.segments,
                profile=clip_profile,
                max_candidates=max_candidates,
                max_media_candidates=max_media_candidates,
                media_timeout=media_timeout,
                k=limit,
                report=report,
            )

        report("selecting", 60, "Menilai dan memilih momen terbaik")
        highlights = select_highlights(
            transcription.segments,
            min_duration=min_duration,
            max_duration=max_duration,
            limit=limit,
        )
        if not highlights:
            raise ValueError("No eligible highlights found within the requested duration bounds")

        transcript_path = output_dir / "transcript.json"
        write_transcript_json(transcript_path, transcription)

        clips: list[dict[str, object]] = []
        for index, highlight in enumerate(highlights, start=1):
            report(
                "rendering",
                65 + round(((index - 1) / len(highlights)) * 29),
                f"Merender klip {index} dari {len(highlights)}",
            )
            clip_path = output_dir / f"clip-{index:02d}.mp4"
            render_vertical(
                source,
                clip_path,
                start=highlight.start,
                end=highlight.end,
                transcript=transcription.segments,
                width=width,
                height=height,
                render_mode=render_mode,
                caption_style=caption_style,
            )
            thumbnail = _clip_thumbnail(clip_path, highlight.end - highlight.start, index, None)
            clip_entry: dict[str, object] = {
                "index": index,
                "start": round(highlight.start, 3),
                "end": round(highlight.end, 3),
                "duration": round(highlight.end - highlight.start, 3),
                "score": highlight.score,
                "text": highlight.text,
                "output": str(clip_path),
                "subtitles": str(clip_path.with_suffix(".srt")),
            }
            if thumbnail is not None:
                clip_entry["thumbnail"] = thumbnail
            clips.append(clip_entry)

        report("finalizing", 96, "Menyimpan hasil, subtitle, dan metadata")
        completed_manifest: dict[str, object] = {
            **manifest_base,
            "status": "completed",
            "language": transcription.language,
            "transcript": str(transcript_path),
            "clips": clips,
            "render_mode": render_mode,
        }
        if selection_v2_summary is not None:
            completed_manifest["selection_v2"] = selection_v2_summary
        _publish_manifest(manifest_path, completed_manifest)
        return manifest_path
    except Exception as exc:
        failed_manifest: dict[str, object] = {
            **manifest_base,
            "status": "failed",
            "error": str(exc),
        }
        if selection_v2_summary is not None:
            failed_manifest["selection_v2"] = selection_v2_summary
        if v3_state is not None:
            failed_manifest["selection_v3"] = _selection_v3_summary(v3_state, failed=True)
        _publish_manifest(
            manifest_path,
            failed_manifest,
        )
        raise
