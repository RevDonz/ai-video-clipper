"""Face-track camera plan over the whole clip window (plan §5.7).

Owner: T1.5, taken over by T3.6 (``no_face`` spans, progress reporting, the window detector).
The file ``camera.<sha16>.json`` (``potongin.camera-plan/1``, canonical JSON,
:func:`encode_camera_plan` / :func:`camera_file_name`) is read by T1.3, which turns it into an
integer crop x per source-grid frame (plan §5.2 R4); its fields are frozen in
docs/editor/CONTRACTS.md §5.7.

The detector is called once for the window:
``detector(source, start=a/1000, end=b/1000, sample_interval=0.75)`` →
``(times, centres, cuts, source_w, source_h)`` with ``times`` relative to ``start`` (strictly
increasing seconds), ``centres`` the normalised x centre of the face per sample (``None`` when
no face was found) and ``cuts`` the scene-change flags.

* The default, today's ``face_tracking.detect_face_track`` (as long as no caller replaced it),
  runs as ``face_window.detect_window`` (re-exported here as :func:`detect_window`): the same
  cascade, detection parameters, sampled frames (one decode of the window, ``sequential=True``)
  and cut flags, with the Haar work, which is ~80% of the time, spread over worker threads
  (T3.6: the W1 budget of 15 s for a 3 min window was met with 0.38 s to spare on a long-GOP
  AV1 720p source in a 4-CPU container). Each worker has its own classifier and OpenCV's own
  thread pool is held at one thread meanwhile, so the result does not depend on the CPU count.
  The one deliberate difference: equal-area faces are chosen by position (the leftmost, then
  the topmost), never by OpenCV's detection order, which varies with its thread count.
  OpenCV stays outside this stdlib-only package (``ai_clipper.face_window``).
* A detector that accepts a ``smooth`` keyword is called with ``smooth=False`` and must return
  raw centres; the plan then applies ``face_tracking.smooth_face_track`` itself and lists every
  run of samples without a face that lasts longer than 1.5 s (from the first missing sample to
  the next sample, or the window end) as ``no_face``.
* Any other detector is assumed to return raw centres too (``None`` = no face). A detector
  that accepts a ``sequential`` keyword is called with ``sequential=True``.

Progress: inside ``with reporting(callback):`` the plan calls ``callback(done, total)`` with the
number of samples analysed (``(0, total)`` first, ``(total, total)`` last; a detector of its own
reports only the start and the end). A failing callback never stops the plan.
:class:`ProgressFile` is such a callback: it keeps ``{schema, window_ms, done, total}``
(``potongin.camera-progress/1``) in a 0600 file replaced atomically, and :func:`read_progress`
reads it back (``None`` when missing, malformed or a symlink).

``samples`` are ``[t_ms, centre_pm]`` with ``t_ms = a + ms_from_seconds(time)`` and
``centre_pm = round_half_up(centre · 1000)``; ``source_content_sha256`` is the sha256 of the
source file.
"""

from __future__ import annotations

import contextlib
import contextvars
import hashlib
import inspect
import json
import math
import os
import secrets
import stat
import time
from collections.abc import Callable, Iterator
from itertools import pairwise
from pathlib import Path
from typing import Any

from ..face_tracking import detect_face_track, smooth_face_track
from ..face_window import DETECT_WORKERS_MAX, detect_window, sample_times
from . import CAMERA_SCHEMA
from .clip_id import ms_from_seconds
from .source_info import canonical_json, ensure_private_dir, file_sha256
from .timemap import Fps

SAMPLE_MS = 750
NO_FACE_MIN_MS = 1500  # runs strictly longer than this are listed
PROGRESS_SCHEMA = "potongin.camera-progress/1"
MAX_PROGRESS_BYTES = 4096
# Today's tracker, captured at import: callers (prepare, the fixture script, tests) may replace
# the module attribute ``detect_face_track`` with another detector, which must then be treated
# as a raw detector.
_TODAYS_TRACKER = detect_face_track

Progress = Callable[[int, int], None]
_PROGRESS: contextvars.ContextVar[Progress | None] = contextvars.ContextVar(
    "potongin_camera_progress", default=None)


def encode_camera_plan(plan: dict[str, Any]) -> bytes:
    """The plan's file bytes (plan §3.1 canonical JSON)."""
    return canonical_json(plan)


def camera_file_name(raw: bytes) -> str:
    """``camera.<sha16>.json``: the first 16 hex digits of the sha256 of the bytes."""
    return f"camera.{hashlib.sha256(raw).hexdigest()[:16]}.json"


# --- progress ------------------------------------------------------------------------------------


@contextlib.contextmanager
def reporting(callback: Progress) -> Iterator[None]:
    """Report the progress of every camera plan built inside the block to ``callback``."""
    token = _PROGRESS.set(callback)
    try:
        yield
    finally:
        _PROGRESS.reset(token)


def _reporter(callback: Progress | None) -> Progress:
    def report(done: int, total: int) -> None:
        if callback is None:
            return
        # progress is advice: the plan never fails because of its reporter
        with contextlib.suppress(Exception):
            callback(done, total)

    return report


class ProgressFile:
    """A progress callback that keeps ``path`` at the last ``(done, total)`` it was given:
    ``{schema, window_ms, done, total}``, canonical JSON, 0600, replaced atomically (the parent
    is created 0700). Writes are at most every ``min_interval_s``, except the last sample."""

    def __init__(self, path: Path, *, window_ms: tuple[int, int] | list[int],
                 min_interval_s: float = 0.25,
                 clock: Callable[[], float] = time.monotonic) -> None:
        a, b = window_ms
        if type(a) is not int or type(b) is not int or not 0 <= a < b:
            raise ValueError("window_ms must satisfy 0 <= a < b")
        self.path = Path(path)
        self.window_ms = [a, b]
        self.min_interval_s = float(min_interval_s)
        self._clock = clock
        self._written_at: float | None = None

    def __call__(self, done: int, total: int) -> None:
        now = self._clock()
        if (done < total and self._written_at is not None
                and now - self._written_at < self.min_interval_s):
            return
        self._written_at = now
        data = canonical_json({"schema": PROGRESS_SCHEMA, "window_ms": self.window_ms,
                               "done": int(done), "total": int(total)})
        directory = ensure_private_dir(self.path.parent)
        temp = directory / f".{self.path.name}.{secrets.token_hex(8)}.tmp"
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                     0o600)
        try:
            try:
                view = memoryview(data)
                while view:
                    view = view[os.write(fd, view):]
            finally:
                os.close(fd)
            os.replace(temp, self.path)
        finally:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(temp)

    def clear(self) -> None:
        """Remove the file (the plan is written, or its build failed)."""
        with contextlib.suppress(FileNotFoundError):
            os.unlink(self.path)


def read_progress(path: Path) -> dict[str, Any] | None:
    """``{window_ms, done, total}`` of a progress file, or ``None`` when it is missing, not a
    regular file (a symlink is never followed), too large or malformed."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    except OSError:
        return None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_PROGRESS_BYTES:
            return None
        raw = os.read(fd, MAX_PROGRESS_BYTES + 1)
    except OSError:
        return None
    finally:
        os.close(fd)
    try:
        value = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(value, dict) or value.get("schema") != PROGRESS_SCHEMA:
        return None
    window, done, total = value.get("window_ms"), value.get("done"), value.get("total")
    if not (isinstance(window, list) and len(window) == 2
            and all(type(item) is int for item in window)
            and type(done) is int and type(total) is int and 0 <= done <= total and total >= 1):
        return None
    return {"window_ms": window, "done": done, "total": total}


# --- the plan ------------------------------------------------------------------------------------


def _accepts(detector: Callable, keyword: str) -> bool:
    try:
        parameters = inspect.signature(detector).parameters
    except (TypeError, ValueError):
        return False
    return keyword in parameters


def _checked(result: object) -> tuple[list[float], list[float | None], list[bool], int, int]:
    if not isinstance(result, (tuple, list)) or len(result) != 5:
        raise ValueError("detector must return (times, centres, cuts, width, height)")
    times, centres, cuts, width, height = result
    times, centres, cuts = list(times), list(centres), list(cuts)
    if not times or not len(times) == len(centres) == len(cuts):
        raise ValueError("detector times, centres and cuts must be non-empty and equally long")
    for value in times:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise TypeError("detector times must be numbers")
        if not math.isfinite(value) or value < 0:
            raise ValueError("detector times must be finite and non-negative")
    if any(later <= earlier for earlier, later in pairwise(times)):
        raise ValueError("detector times must be strictly increasing")
    for value in centres:
        if value is None:
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise TypeError("detector centres must be numbers or None")
        if not math.isfinite(value) or not 0.0 <= value <= 1.0:
            raise ValueError("detector centres must lie in [0, 1]")
    # Today's detector returns numpy.bool_ flags; anything equal to True or False is a flag.
    if any(isinstance(flag, str) or flag not in (True, False) for flag in cuts):
        raise ValueError("detector cut flags must be booleans")
    if type(width) is not int or type(height) is not int or width <= 0 or height <= 0:
        raise ValueError("detector must report a positive source size")
    return times, centres, [bool(flag) for flag in cuts], width, height


def _no_face(times_ms: list[int], centres: list[float | None], end_ms: int) -> list[list[int]]:
    spans: list[list[int]] = []
    run_start: int | None = None
    for index, centre in enumerate(centres):
        if centre is None:
            if run_start is None:
                run_start = index
            continue
        if run_start is not None:
            start, end = times_ms[run_start], times_ms[index]
            if end - start > NO_FACE_MIN_MS:
                spans.append([start, end])
            run_start = None
    if run_start is not None:
        start = times_ms[run_start]
        if end_ms - start > NO_FACE_MIN_MS:
            spans.append([start, end_ms])
    return spans


def build_camera_plan(
    source: Path,
    window_ms: tuple[int, int],
    fps: Fps,
    *,
    out_w: int,
    out_h: int,
    detector: Callable = detect_face_track,
) -> dict:
    """Run ``detector`` (today's detection + smoothing, one sample per 0.75 s) once over the
    window and return the camera plan: samples, cut flags and ``no_face`` spans (> 1.5 s)."""
    a, b = window_ms
    if type(a) is not int or type(b) is not int or not 0 <= a < b:
        raise ValueError("window_ms must satisfy 0 <= a < b")
    if type(out_w) is not int or type(out_h) is not int or out_w <= 0 or out_h <= 0:
        raise ValueError("output size must be positive integers")
    fps = Fps.from_json(fps)
    source = Path(source)
    content_sha = file_sha256(source)
    report = _reporter(_PROGRESS.get())
    start, end, interval = a / 1000, b / 1000, SAMPLE_MS / 1000
    if detector is _TODAYS_TRACKER:
        result = detect_window(source, start=start, end=end, sample_interval=interval,
                               progress=report)
    else:
        options: dict[str, Any] = {"smooth": False} if _accepts(detector, "smooth") else {}
        if _accepts(detector, "sequential"):
            options["sequential"] = True
        report(0, len(sample_times(start, end, interval)))
        result = detector(source, start=start, end=end, sample_interval=interval, **options)
    times, centres, cuts, width, height = _checked(result)
    if detector is not _TODAYS_TRACKER:
        report(len(times), len(times))
    times_ms = [a + ms_from_seconds(float(t)) for t in times]
    smoothed = smooth_face_track(list(centres), cuts=list(cuts))
    no_face = _no_face(times_ms, centres, b)
    return {
        "schema": CAMERA_SCHEMA,
        "source_content_sha256": content_sha,
        "window_ms": [a, b],
        "fps": fps.to_json(),
        "source": {"w": width, "h": height},
        "output": {"w": out_w, "h": out_h},
        "sample_ms": SAMPLE_MS,
        "samples": [[t, ms_from_seconds(min(max(float(c), 0.0), 1.0))]
                    for t, c in zip(times_ms, smoothed)],
        "cuts": [bool(flag) for flag in cuts],
        "no_face": no_face,
    }


__all__ = [
    "DETECT_WORKERS_MAX",
    "NO_FACE_MIN_MS",
    "PROGRESS_SCHEMA",
    "SAMPLE_MS",
    "ProgressFile",
    "build_camera_plan",
    "camera_file_name",
    "detect_face_track",
    "detect_window",
    "encode_camera_plan",
    "read_progress",
    "reporting",
]
