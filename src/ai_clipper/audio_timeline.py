"""Whole-file audio/visual timeline: relative loudness, silences, and camera cuts.

One FFmpeg pass decodes the default audio stream to mono 16 kHz and reports the RMS level
of every 0.1 s frame. An optional second pass, run concurrently, reports scene cuts from a
downscaled copy of the video. Loudness is expressed as a z-score against the file's own
speech level, so a quiet podcast and a loud vlog are comparable. The values describe signal
level only; they do not detect laughter, emotion, or speakers.
"""

from __future__ import annotations

import argparse
import bisect
import json
import math
import os
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
from collections import deque
from collections.abc import Callable, Iterable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from itertools import islice, pairwise
from numbers import Real
from pathlib import Path
from typing import Any

ANALYZER_VERSION = "audio-timeline-v1"
ARTIFACT_RELATIVE_PATH = Path("analysis") / "audio-timeline.json"
STEP_SECONDS = 0.1
FLOOR_DB = -90.0
MIN_SILENCE_SECONDS = 0.25
SCENE_THRESHOLD = 0.3

_SAMPLE_RATE = 16_000
_NOISE_PERCENTILE = 10.0
_SPEECH_MARGIN_DB = 10.0
_SILENCE_MARGIN_DB = 6.0
_SMOOTHING_SECONDS = 0.5
_MIN_SPEECH_FRAMES = 5
_MIN_SPEECH_STD_DB = 1.0
_Z_LIMIT = 6.0
_PEAK_PERCENTILE = 95.0
_QUIET_GAIN_DB = 1.0
_AUDIO_SHORTFALL_SECONDS = 1.0
_MAX_DURATION_SECONDS = 24 * 3600.0
_MAX_TIMEOUT_SECONDS = 24 * 3600.0
_MAX_STEP_SECONDS = 1.0
_MAX_SCENE_CUTS = 100_000
_MAX_WARNINGS = 64
_MAX_WARNING_LENGTH = 200
_MAX_ARTIFACT_BYTES = 32 * 1024 * 1024
_MAX_PROBE_LINES = 10_000
_STREAM_LINE_LIMIT = 4096
_STDERR_TAIL_LINES = 20
_DIAGNOSTIC_CHARS = 300
_WATCHDOG_POLL_SECONDS = 0.05
_EPSILON = 1e-6

_FRAME_LINE = re.compile(r"^frame:\s*\d+\s+pts:\s*\S+\s+pts_time:\s*(\S+)")
_RMS_LINE = re.compile(r"^lavfi\.astats\.Overall\.RMS_level=(\S+)")
_AUDIO_FILTER = (
    f"aresample={_SAMPLE_RATE}:async=1:first_pts=0,"
    f"aformat=sample_fmts=flt:sample_rates={_SAMPLE_RATE}:channel_layouts=mono,"
    f"asetnsamples=n={round(_SAMPLE_RATE * STEP_SECONDS)}:p=0,"
    "astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=RMS_level,"
    "ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-"
)
_SCENE_FILTER = f"scale=160:-2,select='gt(scene,{SCENE_THRESHOLD})',metadata=mode=print:file=-"


class AudioTimelineError(RuntimeError):
    """A sanitized analysis failure that is safe to show to users."""


# --- validation helpers ----------------------------------------------------------------------


def _number(value: object, name: str) -> float:
    if not isinstance(value, Real) or isinstance(value, bool):
        raise TypeError(f"{name} must be a number")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{name} must be finite")
    return result


def _number_tuple(values: object, name: str) -> tuple[float, ...]:
    if not isinstance(values, tuple):
        raise TypeError(f"{name} must be a tuple")
    return tuple(_number(value, name) for value in values)


def _max_frames(duration: float, step: float) -> int:
    return max(1, math.ceil(duration / step - _EPSILON))


def _percentile(ordered: Sequence[float], percentile: float) -> float:
    """Linear-interpolated percentile of an ascending, non-empty sequence."""
    rank = (len(ordered) - 1) * percentile / 100.0
    lower = math.floor(rank)
    upper = min(lower + 1, len(ordered) - 1)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (rank - lower)


def _canonical_spans(spans: object, duration: float) -> tuple[tuple[float, float], ...]:
    if not isinstance(spans, tuple):
        raise TypeError("silences must be a tuple")
    result: list[tuple[float, float]] = []
    for span in spans:
        if not isinstance(span, tuple) or len(span) != 2:
            raise TypeError("each silence must be a (start, end) tuple")
        start = round(_number(span[0], "silence start"), 3)
        end = round(_number(span[1], "silence end"), 3)
        if start < 0 or end <= start or end > duration + _EPSILON:
            raise ValueError("silences must satisfy 0 <= start < end <= duration")
        if end - start < MIN_SILENCE_SECONDS - _EPSILON:
            raise ValueError(f"silences must last at least {MIN_SILENCE_SECONDS} seconds")
        if result and start < result[-1][1]:
            raise ValueError("silences must be ordered and non-overlapping")
        result.append((start, end))
    return tuple(result)


def _canonical_cuts(cuts: object, duration: float) -> tuple[float, ...]:
    values = tuple(round(value, 3) for value in _number_tuple(cuts, "scene cut"))
    if len(values) > _MAX_SCENE_CUTS:
        raise ValueError("too many scene cuts")
    if any(value < 0 or value > duration + _EPSILON for value in values):
        raise ValueError("scene cuts must lie within the media duration")
    if any(later <= earlier for earlier, later in pairwise(values)):
        raise ValueError("scene cuts must be strictly increasing")
    return values


def _canonical_warnings(warnings: object) -> tuple[str, ...]:
    if not isinstance(warnings, tuple) or any(
        not isinstance(item, str) or not item for item in warnings
    ):
        raise TypeError("warnings must be a tuple of non-empty strings")
    if len(warnings) > _MAX_WARNINGS or any(len(item) > _MAX_WARNING_LENGTH for item in warnings):
        raise ValueError("warnings are too many or too long")
    return warnings


def _strict_object(payload: object, expected: set[str]) -> dict[str, Any]:
    if type(payload) is not dict:
        raise TypeError("audio timeline payload must be an object")
    if set(payload) != expected:
        raise ValueError("audio timeline payload has missing or unknown fields")
    return payload


def _json_array(value: object, name: str) -> list[Any]:
    if type(value) is not list:
        raise TypeError(f"{name} must be an array")
    return value


# --- timeline contract -------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class AudioTimeline:
    """Per-frame signal level of one source file; frame ``i`` covers ``[i*step, (i+1)*step)``."""

    analyzer_version: str
    duration: float
    step: float
    rms_db: tuple[float, ...]
    loudness_z: tuple[float, ...]
    silences: tuple[tuple[float, float], ...]
    scene_cuts: tuple[float, ...]
    warnings: tuple[str, ...]

    def __post_init__(self) -> None:
        if self.analyzer_version != ANALYZER_VERSION:
            raise ValueError(f"unsupported analyzer version: {self.analyzer_version!r}")
        duration = round(_number(self.duration, "duration"), 3)
        if not 0 < duration <= _MAX_DURATION_SECONDS:
            raise ValueError("duration must be positive and at most 24 hours")
        step = _number(self.step, "step")
        if not 0 < step <= _MAX_STEP_SECONDS:
            raise ValueError("step must be in (0, 1] seconds")
        rms = tuple(round(value, 1) for value in _number_tuple(self.rms_db, "rms_db"))
        if any(not FLOOR_DB <= value <= 0.0 for value in rms):
            raise ValueError(f"rms_db values must lie in [{FLOOR_DB:g}, 0] dBFS")
        z = tuple(round(value, 2) for value in _number_tuple(self.loudness_z, "loudness_z"))
        if len(z) != len(rms):
            raise ValueError("loudness_z must have one value per rms_db frame")
        if any(abs(value) > _Z_LIMIT for value in z):
            raise ValueError(f"loudness_z values must lie in [-{_Z_LIMIT:g}, {_Z_LIMIT:g}]")
        if len(rms) > _max_frames(duration, step):
            raise ValueError("more frames than the duration allows")
        object.__setattr__(self, "duration", duration)
        object.__setattr__(self, "step", step)
        object.__setattr__(self, "rms_db", rms)
        object.__setattr__(self, "loudness_z", z)
        object.__setattr__(self, "silences", _canonical_spans(self.silences, duration))
        object.__setattr__(self, "scene_cuts", _canonical_cuts(self.scene_cuts, duration))
        object.__setattr__(self, "warnings", _canonical_warnings(self.warnings))

    def _frame_range(self, start: float, end: float) -> tuple[int, int]:
        """Indices of frames overlapping ``[start, end)``, as a half-open range."""
        first = max(0, math.floor(start / self.step + 1e-9))
        last = min(len(self.rms_db), math.ceil(end / self.step - 1e-9))
        return first, max(first, last)

    def window_stats(self, start: float, end: float) -> dict[str, float]:
        """Energy, cut rate, and silence share of a window clamped to the media."""
        start = _number(start, "start")
        end = _number(end, "end")
        if end <= start:
            raise ValueError("window end must be after its start")
        low = max(0.0, start)
        high = min(self.duration, end)
        if high <= low:
            return {
                "energy_mean_z": 0.0,
                "energy_peak_z": 0.0,
                "cut_rate_per_min": 0.0,
                "silence_ratio": 0.0,
            }
        span = high - low
        first, last = self._frame_range(low, high)
        values = self.loudness_z[first:last]
        mean_z = math.fsum(values) / len(values) if values else 0.0
        peak_z = _percentile(sorted(values), _PEAK_PERCENTILE) if values else 0.0
        cuts = bisect.bisect_left(self.scene_cuts, high) - bisect.bisect_left(self.scene_cuts, low)
        quiet = 0.0
        index = bisect.bisect_right(self.silences, low, key=lambda item: item[1])
        for silence_start, silence_end in islice(self.silences, index, None):
            if silence_start >= high:
                break
            quiet += max(0.0, min(silence_end, high) - max(silence_start, low))
        return {
            "energy_mean_z": round(mean_z, 3),
            "energy_peak_z": round(peak_z, 3),
            "cut_rate_per_min": round(cuts * 60.0 / span, 3),
            "silence_ratio": round(min(1.0, quiet / span), 3),
        }

    def nearest_quiet_point(self, t: float, max_shift: float) -> float:
        """The quietest time within ``±max_shift`` of ``t``, preferring silences.

        When a silence is within reach, the point inside it closest to ``t`` is returned
        (``t`` itself when it already lies in a silence). Otherwise the centre of the
        lowest-RMS frame is returned, unless the frame at ``t`` is within 1 dB of it.
        """
        t = _number(t, "t")
        max_shift = _number(max_shift, "max_shift")
        if max_shift < 0:
            raise ValueError("max_shift must be non-negative")
        low = max(0.0, t - max_shift)
        high = min(self.duration, t + max_shift)
        if max_shift == 0 or high < low or not self.rms_db:
            return t

        best: float | None = None
        index = bisect.bisect_left(self.silences, low, key=lambda item: item[1])
        for silence_start, silence_end in islice(self.silences, index, None):
            if silence_start > high:
                break
            reach_start = max(silence_start, low)
            reach_end = min(silence_end, high)
            if reach_start <= t <= reach_end:
                return t
            inset = min(self.step / 2.0, (reach_end - reach_start) / 2.0)
            candidate = reach_start + inset if t < reach_start else reach_end - inset
            if best is None or abs(candidate - t) < abs(best - t):
                best = candidate
        if best is not None:
            return best

        count = len(self.rms_db)
        first = max(0, math.ceil(low / self.step - 0.5 - 1e-9))
        last = min(count - 1, math.floor(high / self.step - 0.5 + 1e-9))
        if first > last:
            return t
        quietest = min(self.rms_db[first : last + 1])
        current = min(count - 1, math.floor(t / self.step))
        # A negative t has no frame of its own (and must not wrap to rms_db[-1]).
        covered = 0.0 <= t <= count * self.step + 1e-9
        if covered and self.rms_db[current] - quietest < _QUIET_GAIN_DB:
            return t
        chosen = min(
            (index for index in range(first, last + 1) if self.rms_db[index] == quietest),
            key=lambda index: (abs((index + 0.5) * self.step - t), index),
        )
        return min(high, max(low, (chosen + 0.5) * self.step))

    def to_dict(self) -> dict[str, object]:
        return {
            "analyzer_version": self.analyzer_version,
            "duration": self.duration,
            "step": self.step,
            "rms_db": list(self.rms_db),
            "loudness_z": list(self.loudness_z),
            "silences": [[start, end] for start, end in self.silences],
            "scene_cuts": list(self.scene_cuts),
            "warnings": list(self.warnings),
        }

    @classmethod
    def from_dict(cls, payload: object) -> AudioTimeline:
        value = _strict_object(
            payload,
            {
                "analyzer_version",
                "duration",
                "step",
                "rms_db",
                "loudness_z",
                "silences",
                "scene_cuts",
                "warnings",
            },
        )
        silences = []
        for span in _json_array(value["silences"], "silences"):
            if len(_json_array(span, "silence")) != 2:
                raise ValueError("each silence must be a [start, end] pair")
            silences.append(tuple(span))
        return cls(
            analyzer_version=value["analyzer_version"],
            duration=value["duration"],
            step=value["step"],
            rms_db=tuple(_json_array(value["rms_db"], "rms_db")),
            loudness_z=tuple(_json_array(value["loudness_z"], "loudness_z")),
            silences=tuple(silences),
            scene_cuts=tuple(_json_array(value["scene_cuts"], "scene_cuts")),
            warnings=tuple(_json_array(value["warnings"], "warnings")),
        )


# --- pure construction from measurements ---------------------------------------------------


def _normalize_db(value: float | None) -> float:
    if value is None or math.isnan(value):
        return FLOOR_DB
    return round(min(0.0, max(FLOOR_DB, value)), 1)


def _speech_statistics(values: Sequence[float], floor: float) -> tuple[float, float] | None:
    speech = [value for value in values if value > floor + _SPEECH_MARGIN_DB]
    if len(speech) < _MIN_SPEECH_FRAMES:
        speech = [value for value in values if value > floor]
    if len(speech) < _MIN_SPEECH_FRAMES:
        return None
    mean = math.fsum(speech) / len(speech)
    spread = math.sqrt(math.fsum((value - mean) ** 2 for value in speech) / len(speech))
    return mean, max(spread, _MIN_SPEECH_STD_DB)


def _smoothed_z(
    values: Sequence[float], statistics: tuple[float, float] | None, step: float
) -> tuple[float, ...]:
    if statistics is None:
        return (0.0,) * len(values)
    mean, spread = statistics
    raw = [max(-_Z_LIMIT, min(_Z_LIMIT, (value - mean) / spread)) for value in values]
    radius = (max(1, round(_SMOOTHING_SECONDS / step)) - 1) // 2
    prefix = [0.0]
    for value in raw:
        prefix.append(prefix[-1] + value)
    smoothed = []
    for index in range(len(raw)):
        low = max(0, index - radius)
        high = min(len(raw), index + radius + 1)
        smoothed.append(round((prefix[high] - prefix[low]) / (high - low), 2))
    return tuple(smoothed)


def _quiet_spans(
    values: Sequence[float], threshold: float, step: float, duration: float
) -> tuple[tuple[float, float], ...]:
    spans: list[tuple[float, float]] = []
    run_start: int | None = None
    for index in range(len(values) + 1):
        quiet = index < len(values) and values[index] < threshold
        if quiet and run_start is None:
            run_start = index
        elif not quiet and run_start is not None:
            start = round(run_start * step, 3)
            end = round(min(index * step, duration), 3)
            if end - start >= MIN_SILENCE_SECONDS - _EPSILON:
                spans.append((start, end))
            run_start = None
    return tuple(spans)


def build_audio_timeline(
    rms_db: Iterable[float | None],
    *,
    duration: float,
    step: float = STEP_SECONDS,
    scene_cuts: Iterable[float] = (),
    warnings: Iterable[str] = (),
) -> AudioTimeline:
    """Derive loudness z-scores and silences from raw per-frame RMS levels.

    Non-finite or missing levels are floored at -90 dBFS. The noise floor is the 10th
    percentile; speech frames are those more than 10 dB above it. Z-scores are clipped to
    ±6 and smoothed with a centred 0.5 s moving average. Silences are runs below
    floor + 6 dB lasting at least 0.25 s.
    """
    duration = _number(duration, "duration")
    step = _number(step, "step")
    if duration <= 0 or not 0 < step <= _MAX_STEP_SECONDS:
        raise ValueError("duration must be positive and step in (0, 1] seconds")
    values = [_normalize_db(value) for value in rms_db][: _max_frames(duration, step)]
    notes = list(warnings)
    silences: tuple[tuple[float, float], ...] = ()
    statistics = None
    if values:
        floor = _percentile(sorted(values), _NOISE_PERCENTILE)
        statistics = _speech_statistics(values, floor)
        if statistics is None:
            notes.append("audio_flat")
        silences = _quiet_spans(values, floor + _SILENCE_MARGIN_DB, step, duration)
    cuts = sorted(
        {
            round(cut, 3)
            for cut in (_number(item, "scene cut") for item in scene_cuts)
            if 0 <= cut <= duration
        }
    )
    return AudioTimeline(
        analyzer_version=ANALYZER_VERSION,
        duration=duration,
        step=step,
        rms_db=tuple(values),
        loudness_z=_smoothed_z(values, statistics, step),
        silences=silences,
        scene_cuts=tuple(cuts),
        warnings=tuple(dict.fromkeys(notes)),
    )


# --- bounded FFmpeg subprocesses ------------------------------------------------------------


class _PassTimedOut(Exception):
    pass


class _PassCancelled(Exception):
    pass


class _PassFailed(Exception):
    pass


def _redactor(source: Path, resolved: Path) -> Callable[[str], str]:
    secrets = {str(resolved), str(source)}
    if len(source.name) >= 3:
        secrets.add(source.name)
    ordered = sorted(secrets, key=len, reverse=True)

    def redact(text: str) -> str:
        for secret in ordered:
            text = text.replace(secret, "<source>")
        return text

    return redact


def _kill_group(process: subprocess.Popen[str]) -> None:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except OSError:
        try:
            process.kill()
        except OSError:
            pass


def _run_streaming(
    argv: list[str],
    *,
    deadline: float,
    cancel: threading.Event,
    on_line: Callable[[str], None],
    redact: Callable[[str], str],
) -> None:
    """Run one process, feeding stdout lines to ``on_line`` under a wall-clock deadline."""
    try:
        process = subprocess.Popen(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            start_new_session=True,
        )
    except OSError as exc:
        raise _PassFailed(f"could not start {Path(argv[0]).name} ({type(exc).__name__})") from None
    assert process.stdout is not None and process.stderr is not None
    stdout, stderr = process.stdout, process.stderr
    tail: deque[str] = deque(maxlen=_STDERR_TAIL_LINES)
    finished = threading.Event()
    stopped: list[str] = []

    def drain() -> None:
        for line in iter(lambda: stderr.readline(_STREAM_LINE_LIMIT), ""):
            if line.strip():
                tail.append(redact(line.strip()))

    def watchdog() -> None:
        while not finished.wait(_WATCHDOG_POLL_SECONDS):
            reason = "cancelled" if cancel.is_set() else None
            if reason is None and time.monotonic() >= deadline:
                reason = "timeout"
            if reason is not None and process.poll() is None:
                stopped.append(reason)
                _kill_group(process)
                return

    helpers = [
        threading.Thread(target=drain, name="audio-timeline-stderr", daemon=True),
        threading.Thread(target=watchdog, name="audio-timeline-watchdog", daemon=True),
    ]
    for helper in helpers:
        helper.start()
    try:
        for line in iter(lambda: stdout.readline(_STREAM_LINE_LIMIT), ""):
            on_line(line)
        process.wait()
    except BaseException:
        _kill_group(process)
        raise
    finally:
        finished.set()
        helpers[1].join()
        if process.poll() is None:
            _kill_group(process)
        process.wait()
        helpers[0].join(timeout=2.0)
        stdout.close()
        stderr.close()
    if "timeout" in stopped:
        raise _PassTimedOut
    if "cancelled" in stopped:
        raise _PassCancelled
    if process.returncode != 0:
        detail = " | ".join(tail)[-_DIAGNOSTIC_CHARS:]
        suffix = f": {detail}" if detail else ""
        raise _PassFailed(f"exit code {process.returncode}{suffix}")


@dataclass(frozen=True, slots=True)
class _MediaProbe:
    duration: float
    audio_stream: int | None
    video_stream: int | None


def _pick_stream(streams: list[dict[str, Any]], codec_type: str) -> int | None:
    candidates = []
    for stream in streams:
        disposition = stream.get("disposition")
        flags = disposition if type(disposition) is dict else {}
        if stream.get("codec_type") != codec_type or flags.get("attached_pic") == 1:
            continue
        index = stream.get("index")
        if isinstance(index, int) and not isinstance(index, bool) and index >= 0:
            candidates.append((flags.get("default") != 1, index))
    return min(candidates)[1] if candidates else None


def _parse_probe(text: str) -> _MediaProbe:
    payload = json.loads(text)
    if type(payload) is not dict:
        raise ValueError("probe output must be an object")
    format_payload = payload.get("format")
    streams = payload.get("streams", [])
    if type(format_payload) is not dict or type(streams) is not list:
        raise ValueError("probe output is missing format or streams")
    raw_duration = format_payload.get("duration")
    if not isinstance(raw_duration, str | int | float) or isinstance(raw_duration, bool):
        raise TypeError("probed duration is missing")
    duration = float(raw_duration)
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("probed duration must be positive")
    typed = [stream for stream in streams if type(stream) is dict]
    return _MediaProbe(duration, _pick_stream(typed, "audio"), _pick_stream(typed, "video"))


def _probe(
    source_arg: str, ffprobe_path: str, deadline: float, redact: Callable[[str], str]
) -> _MediaProbe:
    lines: list[str] = []

    def collect(line: str) -> None:
        if len(lines) >= _MAX_PROBE_LINES:
            raise _PassFailed("probe output is too large")
        lines.append(line)

    try:
        _run_streaming(
            [
                ffprobe_path,
                "-v",
                "error",
                "-show_entries",
                "format=duration:stream=index,codec_type:stream_disposition=default,attached_pic",
                "-of",
                "json",
                source_arg,
            ],
            deadline=deadline,
            cancel=threading.Event(),
            on_line=collect,
            redact=redact,
        )
        return _parse_probe("".join(lines))
    except _PassTimedOut:
        raise AudioTimelineError("media probe timed out") from None
    except _PassFailed as exc:
        raise AudioTimelineError(f"media probe failed ({exc})") from None
    except (ValueError, TypeError) as exc:
        raise AudioTimelineError(f"media probe returned unusable output ({exc})") from None


class _RmsCollector:
    """Streams astats metadata lines into per-frame RMS levels, placing frames by pts."""

    __slots__ = ("limit", "pending_time", "values")

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.pending_time: float | None = None
        self.values: list[float] = []

    def feed(self, line: str) -> None:
        if match := _FRAME_LINE.match(line):
            moment = _parse_float(match.group(1))
            # An unusable time (NOPTS, nan, inf) keeps the frame in arrival order.
            self.pending_time = moment if moment is not None and math.isfinite(moment) else None
            return
        match = _RMS_LINE.match(line)
        if match is None:
            return
        if self.pending_time is not None:
            index = math.floor(self.pending_time / STEP_SECONDS + 0.5)
            gap = min(index, self.limit) - len(self.values)
            if gap > 0:
                self.values.extend([FLOOR_DB] * gap)
            self.pending_time = None
        if len(self.values) < self.limit:
            self.values.append(_normalize_db(_parse_float(match.group(1))))


def _parse_float(text: str) -> float | None:
    try:
        return float(text)
    except ValueError:
        return None


def _scene_pass(
    argv: list[str],
    *,
    duration: float,
    deadline: float,
    cancel: threading.Event,
    redact: Callable[[str], str],
) -> tuple[tuple[float, ...], tuple[str, ...]]:
    cuts: list[float] = []
    overflow = False

    def collect(line: str) -> None:
        nonlocal overflow
        match = _FRAME_LINE.match(line)
        moment = _parse_float(match.group(1)) if match else None
        if moment is None or not math.isfinite(moment) or not 0 < moment <= duration:
            return
        if len(cuts) < _MAX_SCENE_CUTS:
            cuts.append(moment)
        else:
            overflow = True

    try:
        _run_streaming(argv, deadline=deadline, cancel=cancel, on_line=collect, redact=redact)
    except _PassTimedOut:
        return (), ("scene_cuts_timeout",)
    except _PassCancelled:
        return (), ()
    except _PassFailed:
        return (), ("scene_cuts_failed",)
    return tuple(cuts), ("scene_cuts_truncated",) if overflow else ()


def _ffmpeg_argv(ffmpeg_path: str, source_arg: str, stream: int, *options: str) -> list[str]:
    return [
        ffmpeg_path,
        "-hide_banner",
        "-nostdin",
        "-nostats",
        "-loglevel",
        "error",
        "-i",
        source_arg,
        "-map",
        f"0:{stream}",
        *options,
        "-f",
        "null",
        "-",
    ]


def analyze_audio_timeline(
    source: Path,
    *,
    timeout: float = 900.0,
    scene_cuts: bool = True,
    ffmpeg_path: str = "ffmpeg",
    ffprobe_path: str = "ffprobe",
) -> AudioTimeline:
    """Measure the whole file: one audio pass plus an optional concurrent scene-cut pass.

    A missing audio or video stream, or a failed scene pass, degrades to a warning code.
    A failed or timed-out probe or audio pass raises :class:`AudioTimelineError`.
    ``timeout`` bounds the whole analysis in wall-clock seconds.
    """
    if not isinstance(source, Path):
        raise TypeError("source must be a pathlib.Path")
    if not isinstance(scene_cuts, bool):
        raise TypeError("scene_cuts must be a boolean")
    timeout = _number(timeout, "timeout")
    if not 0 < timeout <= _MAX_TIMEOUT_SECONDS:
        raise ValueError("timeout must be positive and at most 24 hours")
    if not all(isinstance(item, str) and item for item in (ffmpeg_path, ffprobe_path)):
        raise TypeError("FFmpeg executable paths must be non-empty strings")
    if not source.is_file():
        raise FileNotFoundError("source media not found")

    deadline = time.monotonic() + timeout
    resolved = source.resolve()
    source_arg = str(resolved)
    redact = _redactor(source, resolved)
    probe = _probe(source_arg, ffprobe_path, deadline, redact)
    if probe.duration > _MAX_DURATION_SECONDS:
        raise AudioTimelineError("media is longer than the supported 24 hours")

    warnings: list[str] = []
    if probe.audio_stream is None:
        warnings.append("no_audio_stream")
    if probe.video_stream is None:
        warnings.append("no_video_stream")
    elif not scene_cuts:
        warnings.append("scene_cuts_disabled")

    collector = _RmsCollector(_max_frames(probe.duration, STEP_SECONDS))
    cancel = threading.Event()
    cuts: tuple[float, ...] = ()
    with ThreadPoolExecutor(max_workers=1, thread_name_prefix="audio-timeline-scenes") as pool:
        future = None
        if scene_cuts and probe.video_stream is not None:
            future = pool.submit(
                _scene_pass,
                _ffmpeg_argv(
                    ffmpeg_path,
                    source_arg,
                    probe.video_stream,
                    "-an",
                    "-sn",
                    "-dn",
                    "-vf",
                    _SCENE_FILTER,
                ),
                duration=probe.duration,
                deadline=deadline,
                cancel=cancel,
                redact=redact,
            )
        try:
            if probe.audio_stream is not None:
                _run_streaming(
                    _ffmpeg_argv(
                        ffmpeg_path,
                        source_arg,
                        probe.audio_stream,
                        "-vn",
                        "-sn",
                        "-dn",
                        "-af",
                        _AUDIO_FILTER,
                    ),
                    deadline=deadline,
                    cancel=cancel,
                    on_line=collector.feed,
                    redact=redact,
                )
        except _PassTimedOut:
            cancel.set()
            raise AudioTimelineError(
                f"audio timeline timed out after {timeout:g} seconds"
            ) from None
        except _PassFailed as exc:
            cancel.set()
            raise AudioTimelineError(f"audio pass failed ({exc})") from None
        except BaseException:
            cancel.set()
            raise
        if future is not None:
            cuts, scene_warnings = future.result()
            warnings.extend(scene_warnings)

    if probe.audio_stream is not None:
        covered = len(collector.values) * STEP_SECONDS
        if not collector.values:
            warnings.append("no_audio_frames")
        elif covered < probe.duration - _AUDIO_SHORTFALL_SECONDS:
            warnings.append("audio_shorter_than_media")
    return build_audio_timeline(
        collector.values,
        duration=probe.duration,
        scene_cuts=cuts,
        warnings=warnings,
    )


# --- artifact ----------------------------------------------------------------------------------


def _reject_constant(name: str) -> float:
    raise ValueError(f"non-finite JSON number {name} is not allowed")


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON object key")
        result[key] = value
    return result


def write_audio_timeline(timeline: AudioTimeline, path: Path | str) -> Path:
    """Atomically publish the compact JSON artifact (conventionally ``analysis/...``)."""
    if not isinstance(timeline, AudioTimeline):
        raise TypeError("timeline must be an AudioTimeline")
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    encoded = (
        json.dumps(timeline.to_dict(), separators=(",", ":"), allow_nan=False) + "\n"
    ).encode("utf-8")
    pending: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb", delete=False, dir=target.parent, prefix=f".{target.name}.", suffix=".tmp"
        ) as stream:
            pending = Path(stream.name)
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(pending, target)
        pending = None
    finally:
        if pending is not None:
            pending.unlink(missing_ok=True)
    return target


def read_audio_timeline(path: Path | str) -> AudioTimeline:
    """Read and strictly validate an artifact; malformed content raises ``ValueError``."""
    with Path(path).open("rb") as stream:
        raw = stream.read(_MAX_ARTIFACT_BYTES + 1)
    if len(raw) > _MAX_ARTIFACT_BYTES:
        raise ValueError("audio timeline artifact is too large")
    try:
        payload = json.loads(
            raw.decode("utf-8"), parse_constant=_reject_constant, object_pairs_hook=_unique_object
        )
        return AudioTimeline.from_dict(payload)
    except (TypeError, ValueError, RecursionError) as exc:
        raise ValueError(f"invalid audio timeline artifact: {exc}") from None


# --- command line ------------------------------------------------------------------------------


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m ai_clipper.audio_timeline",
        description="Analisis satu file: loudness relatif, jeda, dan potongan kamera.",
    )
    parser.add_argument("source", type=Path, help="file video/audio sumber")
    parser.add_argument("--output", type=Path, required=True, help="path JSON hasil analisis")
    parser.add_argument(
        "--no-scene-cuts", action="store_true", help="lewati deteksi potongan kamera"
    )
    parser.add_argument("--timeout", type=float, default=900.0, help="batas waktu total (detik)")
    args = parser.parse_args(argv)
    try:
        timeline = analyze_audio_timeline(
            args.source, timeout=args.timeout, scene_cuts=not args.no_scene_cuts
        )
    except (AudioTimelineError, FileNotFoundError, ValueError) as exc:
        print(f"Analisis gagal: {exc}", file=sys.stderr)
        return 1
    write_audio_timeline(timeline, args.output)
    print(
        f"Selesai: durasi {timeline.duration:.1f} detik, {len(timeline.silences)} jeda, "
        f"{len(timeline.scene_cuts)} potongan kamera."
    )
    if timeline.warnings:
        print("Peringatan: " + ", ".join(timeline.warnings))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
