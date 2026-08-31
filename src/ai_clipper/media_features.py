"""Bounded, deterministic measurements from media streams.

The values in this module describe decoded signal activity only. They do not
infer emotion, expression, speaker identity, active speakers, or virality.
"""

from __future__ import annotations

import json
import math
import multiprocessing
import os
import re
import subprocess
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from itertools import pairwise
from numbers import Real
from pathlib import Path
from typing import Any

ANALYZER_VERSION = "media-features-v1"
_ARTIFACT_THREAD_LOCK = threading.Lock()


def _reset_artifact_thread_lock_after_fork() -> None:
    global _ARTIFACT_THREAD_LOCK
    _ARTIFACT_THREAD_LOCK = threading.Lock()


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_reset_artifact_thread_lock_after_fork)


def _number(value: object, name: str) -> float:
    if not isinstance(value, Real) or isinstance(value, bool):
        raise TypeError(f"{name} must be a number")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{name} must be finite")
    return result


def _optional_number(value: object, name: str, *, bounded: bool = False) -> float | None:
    if value is None:
        return None
    result = _number(value, name)
    if bounded and not 0.0 <= result <= 10.0:
        raise ValueError(f"{name} must be between 0 and 10")
    return result


def _ratio(value: object, name: str) -> float | None:
    result = _optional_number(value, name)
    if result is not None and not 0.0 <= result <= 1.0:
        raise ValueError(f"{name} must be between 0 and 1")
    return result


def _sample_count(value: object) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError("sample_count must be an integer")
    if value < 0:
        raise ValueError("sample_count must be non-negative")
    return value


def _strict_object(payload: object, expected: set[str], label: str) -> dict[str, Any]:
    if type(payload) is not dict:
        raise TypeError(f"{label} payload must be an object")
    if set(payload) != expected:
        raise ValueError(f"{label} payload has missing or unknown fields")
    return payload


@dataclass(frozen=True, slots=True)
class MeasuredInterval:
    start: float
    end: float

    def __post_init__(self) -> None:
        start = _number(self.start, "interval start")
        end = _number(self.end, "interval end")
        if start < 0 or end <= start:
            raise ValueError("interval must satisfy 0 <= start < end")
        object.__setattr__(self, "start", start)
        object.__setattr__(self, "end", end)

    def to_dict(self) -> dict[str, float]:
        return {"start": self.start, "end": self.end}

    @classmethod
    def from_dict(cls, payload: object) -> MeasuredInterval:
        value = _strict_object(payload, {"start", "end"}, "interval")
        return cls(value["start"], value["end"])


def _canonical_intervals(
    intervals: tuple[MeasuredInterval, ...] | list[MeasuredInterval],
) -> tuple[MeasuredInterval, ...]:
    ordered = sorted(intervals, key=lambda interval: (interval.start, interval.end))
    merged: list[MeasuredInterval] = []
    for interval in ordered:
        if merged and interval.start <= merged[-1].end:
            previous = merged[-1]
            merged[-1] = MeasuredInterval(previous.start, max(previous.end, interval.end))
        else:
            merged.append(interval)
    return tuple(merged)


@dataclass(frozen=True, slots=True)
class AudioFeatures:
    rms_db: float | None
    energy_score: float | None
    pause_intervals: tuple[MeasuredInterval, ...]
    pause_ratio: float | None
    energy_change_score: float | None
    sample_count: int

    def __post_init__(self) -> None:
        object.__setattr__(self, "rms_db", _optional_number(self.rms_db, "rms_db"))
        object.__setattr__(
            self, "energy_score", _optional_number(self.energy_score, "energy_score", bounded=True)
        )
        if not isinstance(self.pause_intervals, tuple) or any(
            not isinstance(item, MeasuredInterval) for item in self.pause_intervals
        ):
            raise TypeError("pause_intervals must be a tuple of MeasuredInterval values")
        object.__setattr__(self, "pause_intervals", _canonical_intervals(self.pause_intervals))
        object.__setattr__(self, "pause_ratio", _ratio(self.pause_ratio, "pause_ratio"))
        object.__setattr__(
            self,
            "energy_change_score",
            _optional_number(self.energy_change_score, "energy_change_score", bounded=True),
        )
        object.__setattr__(self, "sample_count", _sample_count(self.sample_count))

    def to_dict(self) -> dict[str, object]:
        return {
            "rms_db": self.rms_db,
            "energy_score": self.energy_score,
            "pause_intervals": [interval.to_dict() for interval in self.pause_intervals],
            "pause_ratio": self.pause_ratio,
            "energy_change_score": self.energy_change_score,
            "sample_count": self.sample_count,
        }

    @classmethod
    def from_dict(cls, payload: object) -> AudioFeatures:
        value = _strict_object(
            payload,
            {
                "rms_db",
                "energy_score",
                "pause_intervals",
                "pause_ratio",
                "energy_change_score",
                "sample_count",
            },
            "audio features",
        )
        if not isinstance(value["pause_intervals"], list):
            raise TypeError("pause_intervals JSON value must be an array")
        return cls(
            rms_db=value["rms_db"],
            energy_score=value["energy_score"],
            pause_intervals=tuple(
                MeasuredInterval.from_dict(item) for item in value["pause_intervals"]
            ),
            pause_ratio=value["pause_ratio"],
            energy_change_score=value["energy_change_score"],
            sample_count=value["sample_count"],
        )


@dataclass(frozen=True, slots=True)
class VisualFeatures:
    scene_cut_timestamps: tuple[float, ...]
    scene_activity_score: float | None
    motion_score: float | None
    face_presence_ratio: float | None
    face_activity_score: float | None
    sample_count: int

    def __post_init__(self) -> None:
        if not isinstance(self.scene_cut_timestamps, tuple):
            raise TypeError("scene_cut_timestamps must be a tuple")
        cuts = tuple(_number(item, "scene cut timestamp") for item in self.scene_cut_timestamps)
        if any(item < 0 for item in cuts) or any(a >= b for a, b in pairwise(cuts)):
            raise ValueError("scene cut timestamps must be non-negative and strictly increasing")
        object.__setattr__(self, "scene_cut_timestamps", cuts)
        for name in ("scene_activity_score", "motion_score", "face_activity_score"):
            object.__setattr__(
                self, name, _optional_number(getattr(self, name), name, bounded=True)
            )
        object.__setattr__(
            self, "face_presence_ratio", _ratio(self.face_presence_ratio, "face_presence_ratio")
        )
        object.__setattr__(self, "sample_count", _sample_count(self.sample_count))

    def to_dict(self) -> dict[str, object]:
        return {
            "scene_cut_timestamps": list(self.scene_cut_timestamps),
            "scene_activity_score": self.scene_activity_score,
            "motion_score": self.motion_score,
            "face_presence_ratio": self.face_presence_ratio,
            "face_activity_score": self.face_activity_score,
            "sample_count": self.sample_count,
        }

    @classmethod
    def from_dict(cls, payload: object) -> VisualFeatures:
        value = _strict_object(
            payload,
            {
                "scene_cut_timestamps",
                "scene_activity_score",
                "motion_score",
                "face_presence_ratio",
                "face_activity_score",
                "sample_count",
            },
            "visual features",
        )
        if not isinstance(value["scene_cut_timestamps"], list):
            raise TypeError("scene_cut_timestamps JSON value must be an array")
        return cls(
            scene_cut_timestamps=tuple(value["scene_cut_timestamps"]),
            scene_activity_score=value["scene_activity_score"],
            motion_score=value["motion_score"],
            face_presence_ratio=value["face_presence_ratio"],
            face_activity_score=value["face_activity_score"],
            sample_count=value["sample_count"],
        )


def _validate_measurement_window(
    *,
    start: float,
    end: float,
    audio: AudioFeatures | None = None,
    visual: VisualFeatures | None = None,
) -> None:
    if audio is not None and any(
        interval.start < start - 1e-6 or interval.end > end + 1e-6
        for interval in audio.pause_intervals
    ):
        raise ValueError("measurement timestamp is outside analysis window")
    if visual is not None and any(
        cut < start - 1e-6 or cut > end + 1e-6 for cut in visual.scene_cut_timestamps
    ):
        raise ValueError("measurement timestamp is outside analysis window")


@dataclass(frozen=True, slots=True)
class MediaFeatureAnalysis:
    analyzer_version: str
    source: str
    source_duration: float
    window_start: float
    window_end: float
    audio: AudioFeatures
    visual: VisualFeatures
    warnings: tuple[str, ...]
    provenance: tuple[str, ...]
    analysis_id: str = field(default_factory=lambda: uuid.uuid4().hex)

    def __post_init__(self) -> None:
        if self.analyzer_version != ANALYZER_VERSION:
            raise ValueError(f"unsupported analyzer version: {self.analyzer_version}")
        if not isinstance(self.analysis_id, str) or not self.analysis_id:
            raise ValueError("analysis_id must be a non-empty string")
        if not isinstance(self.source, str) or not self.source:
            raise ValueError("source must be a non-empty string")
        duration = _number(self.source_duration, "source_duration")
        start = _number(self.window_start, "window_start")
        end = _number(self.window_end, "window_end")
        if duration <= 0 or start < 0 or end <= start or end > duration + 1e-6:
            raise ValueError("window must satisfy 0 <= start < end <= source duration")
        object.__setattr__(self, "source_duration", duration)
        object.__setattr__(self, "window_start", start)
        object.__setattr__(self, "window_end", end)
        if not isinstance(self.audio, AudioFeatures) or not isinstance(self.visual, VisualFeatures):
            raise TypeError("audio and visual must use their typed feature contracts")
        _validate_measurement_window(start=start, end=end, audio=self.audio, visual=self.visual)
        for name in ("warnings", "provenance"):
            values = getattr(self, name)
            if not isinstance(values, tuple) or any(
                not isinstance(item, str) or not item for item in values
            ):
                raise TypeError(f"{name} must be a tuple of non-empty strings")

    def to_dict(self) -> dict[str, object]:
        return {
            "analyzer_version": self.analyzer_version,
            "analysis_id": self.analysis_id,
            "source": self.source,
            "source_duration": self.source_duration,
            "window_start": self.window_start,
            "window_end": self.window_end,
            "audio": self.audio.to_dict(),
            "visual": self.visual.to_dict(),
            "warnings": list(self.warnings),
            "provenance": list(self.provenance),
        }

    @classmethod
    def from_dict(cls, payload: object) -> MediaFeatureAnalysis:
        value = _strict_object(
            payload,
            {
                "analyzer_version",
                "analysis_id",
                "source",
                "source_duration",
                "window_start",
                "window_end",
                "audio",
                "visual",
                "warnings",
                "provenance",
            },
            "media feature analysis",
        )
        if not isinstance(value["warnings"], list) or not isinstance(value["provenance"], list):
            raise TypeError("warnings and provenance JSON values must be arrays")
        return cls(
            analyzer_version=value["analyzer_version"],
            analysis_id=value["analysis_id"],
            source=value["source"],
            source_duration=value["source_duration"],
            window_start=value["window_start"],
            window_end=value["window_end"],
            audio=AudioFeatures.from_dict(value["audio"]),
            visual=VisualFeatures.from_dict(value["visual"]),
            warnings=tuple(value["warnings"]),
            provenance=tuple(value["provenance"]),
        )


_MEAN_VOLUME = re.compile(r"mean_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB")
_SILENCE_START = re.compile(r"silence_start:\s*(\d+(?:\.\d+)?)")
_SILENCE_END = re.compile(r"silence_end:\s*(\d+(?:\.\d+)?)")
_RMS_METADATA = re.compile(r"lavfi\.astats\.Overall\.RMS_level=(-?(?:\d+(?:\.\d+)?|inf))")


def _empty_audio() -> AudioFeatures:
    return AudioFeatures(None, None, (), None, None, 0)


def _empty_visual() -> VisualFeatures:
    return VisualFeatures((), None, None, None, None, 0)


def _run(argv: list[str], timeout: float) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        check=True,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def _diagnostic(exc: BaseException) -> str:
    detail = str(exc)
    stderr = getattr(exc, "stderr", None)
    if isinstance(stderr, bytes):
        stderr = stderr.decode(errors="replace")
    if isinstance(stderr, str) and stderr.strip():
        detail = f"{detail}; stderr={stderr.strip()[-400:]}"
    return f"{type(exc).__name__}: {detail}"


def _probe_media(source: Path, ffprobe_path: str, timeout: float) -> tuple[float, bool, bool]:
    completed = _run(
        [
            ffprobe_path,
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_type",
            "-of",
            "json",
            str(source),
        ],
        timeout,
    )
    payload = json.loads(completed.stdout)
    if type(payload) is not dict:
        raise ValueError("ffprobe top-level JSON value must be an object")
    format_payload = payload.get("format")
    if type(format_payload) is not dict:
        raise ValueError("ffprobe format value must be an object")
    streams = payload.get("streams")
    if not isinstance(streams, list):
        raise ValueError("ffprobe streams value must be an array")  # noqa: TRY004
    if any(type(stream) is not dict for stream in streams):
        raise ValueError("ffprobe stream entry must be an object")
    if any(not isinstance(stream.get("codec_type"), str) for stream in streams):
        raise ValueError("ffprobe stream codec_type must be a string")
    raw_duration = format_payload.get("duration")
    if isinstance(raw_duration, bool):
        raise ValueError("probed duration must be numeric")  # noqa: TRY004
    try:
        duration = float(raw_duration)
    except (TypeError, ValueError) as exc:
        raise ValueError("probed duration must be numeric") from exc
    if not math.isfinite(duration):
        raise ValueError("probed duration must be finite")
    if duration <= 0:
        raise ValueError("probed duration must be positive")
    stream_types = {stream.get("codec_type") for stream in streams}
    return duration, "audio" in stream_types, "video" in stream_types


def _db_score(db: float) -> float:
    """Map -60..0 dBFS linearly onto the bounded measurement scale."""
    return round(min(10.0, max(0.0, (db + 60.0) / 6.0)), 3)


def _parse_silences(
    stderr: str, duration: float, max_intervals: int, *, timeline_offset: float
) -> tuple[tuple[MeasuredInterval, ...], float]:
    intervals: list[MeasuredInterval] = []
    pending: float | None = None
    for line in stderr.splitlines():
        if match := _SILENCE_START.search(line):
            pending = min(max(float(match.group(1)), 0.0), duration)
        if match := _SILENCE_END.search(line):
            end = min(max(float(match.group(1)), 0.0), duration)
            if pending is not None and end > pending:
                intervals.append(MeasuredInterval(pending, end))
            pending = None
    if pending is not None and pending < duration:
        intervals.append(MeasuredInterval(pending, duration))
    canonical = _canonical_intervals(intervals)
    total_duration = sum(interval.end - interval.start for interval in canonical)
    published = tuple(
        MeasuredInterval(
            round(timeline_offset + interval.start, 6),
            round(timeline_offset + interval.end, 6),
        )
        for interval in canonical[:max_intervals]
    )
    return published, total_duration


def _analyze_audio(
    source: Path,
    *,
    start: float,
    duration: float,
    max_samples: int,
    ffmpeg_path: str,
    timeout: float,
) -> tuple[AudioFeatures, tuple[str, ...]]:
    common = [
        ffmpeg_path,
        "-hide_banner",
        "-nostdin",
        "-ss",
        f"{start:.6f}",
        "-t",
        f"{duration:.6f}",
        "-i",
        str(source),
        "-vn",
    ]
    summary = _run(
        [
            *common,
            "-af",
            "silencedetect=noise=-45dB:d=0.25,volumedetect",
            "-f",
            "null",
            "-",
        ],
        timeout,
    )
    volume_match = _MEAN_VOLUME.search(summary.stderr)
    rms_db: float | None = None
    if volume_match and volume_match.group(1) != "-inf":
        rms_db = round(float(volume_match.group(1)), 3)
    warnings: list[str] = []
    if volume_match is None:
        warnings.append("audio mean volume metadata unavailable")
    intervals, pause_duration = _parse_silences(
        summary.stderr, duration, max_samples, timeline_offset=start
    )
    # volumedetect emits mean_volume only after the shared audio filter graph
    # has consumed its input. Its presence therefore distinguishes a completed
    # no-silence measurement from a successful-but-empty mocked/unparseable
    # result, while silence events are direct silencedetect evidence.
    has_pause_evidence = volume_match is not None or any(
        pattern.search(summary.stderr) for pattern in (_SILENCE_START, _SILENCE_END)
    )
    pause_ratio = round(min(1.0, pause_duration / duration), 6) if has_pause_evidence else None
    if not has_pause_evidence:
        warnings.append("audio pause metadata unavailable")

    sample_rate = 8000
    samples_per_bucket = max(1, math.ceil(duration * sample_rate / max_samples))
    activity = _run(
        [
            *common,
            "-af",
            (
                f"aresample={sample_rate},asetnsamples=n={samples_per_bucket}:p=0,"
                "astats=metadata=1:reset=1,"
                "ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-"
            ),
            "-f",
            "null",
            "-",
        ],
        timeout,
    )
    bucket_matches = list(_RMS_METADATA.finditer(activity.stdout + activity.stderr))[:max_samples]
    # FFmpeg reports digital silence as -inf; use a fixed floor only for the
    # change calculation while preserving the raw aggregate as unavailable.
    bucket_db = [
        -100.0 if match.group(1) == "-inf" else float(match.group(1)) for match in bucket_matches
    ]
    changes = [abs(right - left) for left, right in pairwise(bucket_db)]
    energy_change = None
    if bucket_db:
        energy_change = round(min(10.0, sum(changes) / len(changes) / 6.0), 3) if changes else 0.0
    else:
        warnings.append("audio RMS bucket metadata unavailable")
    return (
        AudioFeatures(
            rms_db=rms_db,
            energy_score=(
                _db_score(rms_db)
                if rms_db is not None
                else (0.0 if volume_match is not None else None)
            ),
            pause_intervals=intervals,
            pause_ratio=pause_ratio,
            energy_change_score=energy_change,
            sample_count=min(len(bucket_db), max_samples),
        ),
        tuple(warnings),
    )


class _VisualAnalysisUnavailable(Exception):
    """A controlled native/availability failure that permits partial analysis."""


class _VisualWorkerProgrammingError(Exception):
    """An unexpected worker error that must not be converted into a warning."""


def _analyze_visual(
    source: Path,
    *,
    start: float,
    duration: float,
    max_samples: int,
) -> tuple[VisualFeatures, tuple[str, ...]]:
    try:
        import cv2
    except ImportError as exc:
        raise _VisualAnalysisUnavailable("OpenCV is unavailable; install the vision extra") from exc

    capture = None
    try:
        capture = cv2.VideoCapture(str(source))
        if not capture.isOpened():
            raise _VisualAnalysisUnavailable("OpenCV could not open the video stream")
        previous_thumbnail: Any | None = None
        previous_timestamp: float | None = None
        changes: list[float] = []
        cuts: list[float] = []
        sample_count = 0
        rejected_seeks = 0
        failed_decodes = 0
        invalid_timestamps = 0
        nonmonotonic_timestamps = 0
        tolerance = min(0.05, duration / max_samples)
        # Bucket midpoints are deterministic, cover the complete window, and never
        # exceed max_samples regardless of source duration or frame rate.
        sample_times = (
            start + duration * (index + 0.5) / max_samples for index in range(max_samples)
        )
        for requested_timestamp in sample_times:
            if not capture.set(cv2.CAP_PROP_POS_MSEC, requested_timestamp * 1000.0):
                rejected_seeks += 1
                continue
            ok, frame = capture.read()
            if not ok:
                failed_decodes += 1
                continue
            raw_timestamp = capture.get(cv2.CAP_PROP_POS_MSEC)
            if isinstance(raw_timestamp, bool) or not isinstance(raw_timestamp, Real):
                invalid_timestamps += 1
                continue
            actual_timestamp = float(raw_timestamp) / 1000.0
            if (
                not math.isfinite(actual_timestamp)
                or actual_timestamp < start - tolerance
                or actual_timestamp > start + duration + tolerance
            ):
                invalid_timestamps += 1
                continue
            actual_timestamp = min(start + duration, max(start, actual_timestamp))
            if previous_timestamp is not None and actual_timestamp <= previous_timestamp:
                nonmonotonic_timestamps += 1
                continue
            thumbnail = cv2.resize(frame, (64, 36), interpolation=cv2.INTER_AREA)
            sample_count += 1
            if previous_thumbnail is not None:
                change = float(cv2.absdiff(previous_thumbnail, thumbnail).mean()) / 255.0
                changes.append(change)
                if change >= 0.18:
                    cuts.append(round(actual_timestamp, 6))
            previous_thumbnail = thumbnail
            previous_timestamp = actual_timestamp
        if sample_count == 0:
            raise _VisualAnalysisUnavailable(
                "OpenCV produced no samples with valid, increasing seek timestamps"
            )

        motion = sum(changes) / len(changes) if changes else 0.0
        scene_rate = len(cuts) / max(len(changes), 1)
        warnings = []
        if rejected_seeks:
            warnings.append(f"OpenCV rejected {rejected_seeks} requested seek(s)")
        if failed_decodes:
            warnings.append(f"OpenCV failed to decode {failed_decodes} sought frame(s)")
        if invalid_timestamps:
            warnings.append(f"OpenCV reported {invalid_timestamps} invalid seek timestamp(s)")
        if nonmonotonic_timestamps:
            warnings.append(
                f"OpenCV skipped {nonmonotonic_timestamps} timestamp(s) that were not strictly increasing"
            )
        return (
            VisualFeatures(
                scene_cut_timestamps=tuple(cuts),
                scene_activity_score=round(min(10.0, scene_rate * 10.0), 3),
                motion_score=round(min(10.0, motion * 20.0), 3),
                face_presence_ratio=None,
                face_activity_score=None,
                sample_count=sample_count,
            ),
            tuple(warnings),
        )
    except cv2.error as exc:
        raise _VisualAnalysisUnavailable(f"OpenCV visual analysis failed: {exc}") from exc
    finally:
        if capture is not None:
            try:
                capture.release()
            except cv2.error as exc:
                raise _VisualAnalysisUnavailable(f"OpenCV visual cleanup failed: {exc}") from exc


def _visual_worker(connection: Any, request: dict[str, object]) -> None:
    """Run OpenCV in an isolated process and send only serializable results."""
    try:
        visual, warnings = _analyze_visual(
            Path(str(request["source"])),
            start=float(request["start"]),
            duration=float(request["duration"]),
            max_samples=int(request["max_samples"]),
        )
        connection.send(("ok", {"features": visual.to_dict(), "warnings": list(warnings)}))
    except _VisualAnalysisUnavailable as exc:
        connection.send(("unavailable", _diagnostic(exc)))
    # Preserve unexpected programming failures across the process boundary;
    # the parent re-raises them instead of degrading them to a warning.
    except Exception as exc:  # noqa: BLE001
        connection.send(("error", _diagnostic(exc)))
    finally:
        connection.close()


def _stop_process(process: Any) -> None:
    if process.is_alive():
        process.terminate()
        process.join(0.25)
    if process.is_alive():
        process.kill()
        process.join()
    process.close()


def _run_visual_analysis(
    *,
    source: Path,
    start: float,
    duration: float,
    max_samples: int,
    timeout: float,
    worker_target: Any = _visual_worker,
) -> tuple[VisualFeatures, tuple[str, ...]]:
    """Run visual analysis with a parent-enforced wall-clock timeout."""
    context = multiprocessing.get_context("spawn")
    receive, send = context.Pipe(duplex=False)
    process = context.Process(
        target=worker_target,
        args=(
            send,
            {
                "source": str(source),
                "start": start,
                "duration": duration,
                "max_samples": max_samples,
            },
        ),
    )
    started = False
    try:
        process.start()
        started = True
        send.close()
        deadline = time.monotonic() + timeout
        message: object | None = None
        while message is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise _VisualAnalysisUnavailable(
                    f"visual analysis timed out after {timeout:g} seconds"
                )
            if receive.poll(min(remaining, 0.05)):
                try:
                    message = receive.recv()
                except EOFError as exc:
                    raise _VisualAnalysisUnavailable(
                        "visual analysis worker closed its pipe without a result"
                    ) from exc
                break
            if not process.is_alive():
                raise _VisualAnalysisUnavailable(
                    f"visual analysis worker exited without a result (exit code {process.exitcode})"
                )

        process.join(max(0.0, deadline - time.monotonic()))
        if process.is_alive():
            raise _VisualAnalysisUnavailable(f"visual analysis timed out after {timeout:g} seconds")
        if not isinstance(message, tuple) or len(message) != 2:
            raise _VisualWorkerProgrammingError("visual worker returned a malformed message")
        status, payload = message
        if not isinstance(status, str):
            raise _VisualWorkerProgrammingError("visual worker returned a malformed status")
        if status == "ok":
            if type(payload) is not dict:
                raise _VisualWorkerProgrammingError("visual worker returned a malformed payload")
            value = _strict_object(payload, {"features", "warnings"}, "visual worker result")
            if not isinstance(value["warnings"], list) or any(
                not isinstance(item, str) or not item for item in value["warnings"]
            ):
                raise _VisualWorkerProgrammingError("visual worker returned malformed warnings")
            return VisualFeatures.from_dict(value["features"]), tuple(value["warnings"])
        if status == "unavailable":
            if not isinstance(payload, str):
                raise _VisualWorkerProgrammingError("visual worker returned a malformed payload")
            raise _VisualAnalysisUnavailable(payload)
        if status != "error" or not isinstance(payload, str):
            raise _VisualWorkerProgrammingError(
                "visual worker returned a malformed status or payload"
            )
        raise _VisualWorkerProgrammingError(f"unexpected visual worker failure: {payload}")
    finally:
        send.close()
        receive.close()
        if started:
            _stop_process(process)
        else:
            process.close()


def analyze_media(
    source: Path,
    *,
    start: float = 0.0,
    end: float | None = None,
    max_samples: int = 120,
    timeout: float = 30.0,
    ffmpeg_path: str = "ffmpeg",
    ffprobe_path: str = "ffprobe",
) -> MediaFeatureAnalysis:
    """Measure available streams, retaining partial results and diagnostics."""
    if not isinstance(source, Path):
        raise TypeError("source must be a pathlib.Path")
    if not source.is_file():
        raise FileNotFoundError(source)
    start = _number(start, "start")
    if start < 0:
        raise ValueError("start must be non-negative")
    if not isinstance(max_samples, int) or isinstance(max_samples, bool):
        raise TypeError("max_samples must be an integer")
    if not 2 <= max_samples <= 10_000:
        raise ValueError("max_samples must be between 2 and 10000")
    timeout = _number(timeout, "timeout")
    if timeout <= 0:
        raise ValueError("timeout must be positive")
    if not all(isinstance(item, str) and item for item in (ffmpeg_path, ffprobe_path)):
        raise TypeError("FFmpeg executable paths must be non-empty strings")

    try:
        source_duration, has_audio, has_video = _probe_media(source, ffprobe_path, timeout)
    except (FileNotFoundError, subprocess.SubprocessError, json.JSONDecodeError, ValueError) as exc:
        raise RuntimeError(f"media probe failed: {_diagnostic(exc)}") from exc
    window_end = source_duration if end is None else _number(end, "end")
    if window_end <= start or window_end > source_duration + 1e-6:
        raise ValueError("window must satisfy 0 <= start < end <= source duration")
    window_end = min(window_end, source_duration)
    window_duration = window_end - start

    warnings: list[str] = []
    provenance = ["ffprobe"]
    audio = _empty_audio()
    if has_audio:
        try:
            audio, audio_warnings = _analyze_audio(
                source,
                start=start,
                duration=window_duration,
                max_samples=max_samples,
                ffmpeg_path=ffmpeg_path,
                timeout=timeout,
            )
            warnings.extend(audio_warnings)
            provenance.append("ffmpeg")
        except (FileNotFoundError, subprocess.SubprocessError, ValueError) as exc:
            warnings.append(f"audio analysis unavailable: {_diagnostic(exc)}")
    else:
        warnings.append("source has no audio stream")

    visual = _empty_visual()
    if not has_video:
        warnings.append("source has no video stream")
    else:
        try:
            visual, visual_warnings = _run_visual_analysis(
                source=source,
                start=start,
                duration=window_duration,
                max_samples=max_samples,
                timeout=timeout,
            )
            warnings.extend(visual_warnings)
            provenance.append("opencv")
        except _VisualAnalysisUnavailable as exc:
            warnings.append(f"visual analysis unavailable: {_diagnostic(exc)}")

    return MediaFeatureAnalysis(
        analyzer_version=ANALYZER_VERSION,
        source=str(source.resolve()),
        source_duration=source_duration,
        window_start=start,
        window_end=window_end,
        audio=audio,
        visual=visual,
        warnings=tuple(warnings),
        provenance=tuple(provenance),
    )


def _artifact_payload(
    analysis: MediaFeatureAnalysis, kind: str, features: AudioFeatures | VisualFeatures
) -> dict[str, object]:
    return {
        "analyzer_version": analysis.analyzer_version,
        "analysis_id": analysis.analysis_id,
        "kind": kind,
        "source": analysis.source,
        "source_duration": analysis.source_duration,
        "window_start": analysis.window_start,
        "window_end": analysis.window_end,
        "warnings": list(analysis.warnings),
        "provenance": list(analysis.provenance),
        "features": features.to_dict(),
    }


def _atomic_json(path: Path, payload: dict[str, object]) -> None:
    encoded = (json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode()
    pending: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            delete=False,
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
        ) as stream:
            pending = Path(stream.name)
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(pending, path)
    finally:
        if pending is not None:
            pending.unlink(missing_ok=True)


@contextmanager
def _artifact_publication_lock(artifact_dir: Path):
    import fcntl

    lock_path = artifact_dir / ".media-features.lock"
    flags = os.O_CREAT | os.O_RDWR
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    with _ARTIFACT_THREAD_LOCK:
        descriptor = os.open(lock_path, flags, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            yield
        finally:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
            finally:
                os.close(descriptor)


def _fsync_directory(path: Path) -> None:
    flags = os.O_RDONLY
    if hasattr(os, "O_DIRECTORY"):
        flags |= os.O_DIRECTORY
    descriptor = os.open(path, flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_feature_artifacts(analysis: MediaFeatureAnalysis, output_dir: Path) -> tuple[Path, Path]:
    """Atomically publish scoped measured-signal artifacts under ``analysis/``."""
    if not isinstance(analysis, MediaFeatureAnalysis):
        raise TypeError("analysis must be a MediaFeatureAnalysis")
    if not isinstance(output_dir, Path):
        raise TypeError("output_dir must be a pathlib.Path")
    artifact_dir = output_dir / "analysis"
    artifact_dir.mkdir(parents=True, exist_ok=True)
    audio_path = artifact_dir / "audio-features.json"
    scenes_path = artifact_dir / "scenes.json"
    with _artifact_publication_lock(artifact_dir):
        _atomic_json(audio_path, _artifact_payload(analysis, "audio", analysis.audio))
        _atomic_json(scenes_path, _artifact_payload(analysis, "visual", analysis.visual))
        _fsync_directory(artifact_dir)
    return audio_path, scenes_path


@dataclass(frozen=True, slots=True)
class _FeatureArtifactEnvelope:
    analyzer_version: str
    analysis_id: str
    kind: str
    source: str
    source_duration: float
    window_start: float
    window_end: float
    warnings: tuple[str, ...]
    provenance: tuple[str, ...]
    features: AudioFeatures | VisualFeatures


def _read_feature_artifact_envelope(path: Path) -> _FeatureArtifactEnvelope:
    payload = json.loads(path.read_text(encoding="utf-8"))
    value = _strict_object(
        payload,
        {
            "analyzer_version",
            "analysis_id",
            "kind",
            "source",
            "source_duration",
            "window_start",
            "window_end",
            "warnings",
            "provenance",
            "features",
        },
        "feature artifact",
    )
    if value["analyzer_version"] != ANALYZER_VERSION:
        raise ValueError("unsupported analyzer version")
    if not isinstance(value["analysis_id"], str) or not value["analysis_id"]:
        raise ValueError("artifact analysis_id must be a non-empty string")
    if not isinstance(value["source"], str) or not value["source"]:
        raise ValueError("artifact source must be a non-empty string")
    duration = _number(value["source_duration"], "artifact source_duration")
    start = _number(value["window_start"], "artifact window_start")
    end = _number(value["window_end"], "artifact window_end")
    if duration <= 0 or start < 0 or end <= start or end > duration + 1e-6:
        raise ValueError("artifact window is outside source duration")
    for name in ("warnings", "provenance"):
        if not isinstance(value[name], list) or any(
            not isinstance(item, str) or not item for item in value[name]
        ):
            raise TypeError(f"artifact {name} must be an array of non-empty strings")
    if value["kind"] == "audio":
        features = AudioFeatures.from_dict(value["features"])
        _validate_measurement_window(start=start, end=end, audio=features)
    elif value["kind"] == "visual":
        features = VisualFeatures.from_dict(value["features"])
        _validate_measurement_window(start=start, end=end, visual=features)
    else:
        raise ValueError("unknown feature artifact kind")
    return _FeatureArtifactEnvelope(
        analyzer_version=value["analyzer_version"],
        analysis_id=value["analysis_id"],
        kind=value["kind"],
        source=value["source"],
        source_duration=duration,
        window_start=start,
        window_end=end,
        warnings=tuple(value["warnings"]),
        provenance=tuple(value["provenance"]),
        features=features,
    )


def read_feature_artifact(path: Path) -> AudioFeatures | VisualFeatures:
    """Decode one artifact's features; use the pair reader when consistency matters."""
    if not isinstance(path, Path):
        raise TypeError("path must be a pathlib.Path")
    return _read_feature_artifact_envelope(path).features


def read_feature_artifacts(output_dir: Path) -> MediaFeatureAnalysis:
    """Read and validate one generation-consistent audio/visual artifact pair."""
    if not isinstance(output_dir, Path):
        raise TypeError("output_dir must be a pathlib.Path")
    artifact_dir = output_dir / "analysis"
    with _artifact_publication_lock(artifact_dir):
        audio = _read_feature_artifact_envelope(artifact_dir / "audio-features.json")
        visual = _read_feature_artifact_envelope(artifact_dir / "scenes.json")
        if audio.kind != "audio" or visual.kind != "visual":
            raise ValueError("feature artifact pair has incorrect artifact kinds")
        metadata_fields = (
            "analyzer_version",
            "analysis_id",
            "source",
            "source_duration",
            "window_start",
            "window_end",
            "warnings",
            "provenance",
        )
        mismatches = [
            name for name in metadata_fields if getattr(audio, name) != getattr(visual, name)
        ]
        if mismatches:
            raise ValueError(f"feature artifact pair metadata mismatch: {', '.join(mismatches)}")
        if not isinstance(audio.features, AudioFeatures) or not isinstance(
            visual.features, VisualFeatures
        ):
            raise TypeError("feature artifact pair has incorrect feature types")
        return MediaFeatureAnalysis(
            analyzer_version=audio.analyzer_version,
            analysis_id=audio.analysis_id,
            source=audio.source,
            source_duration=audio.source_duration,
            window_start=audio.window_start,
            window_end=audio.window_end,
            audio=audio.features,
            visual=visual.features,
            warnings=audio.warnings,
            provenance=audio.provenance,
        )
