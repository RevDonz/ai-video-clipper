"""Face-track camera plan over the whole clip window (plan §5.7).

Owner: T1.5 (taken over by T3.6). The file ``camera.<sha16>.json`` (``potongin.camera-plan/1``,
canonical JSON, :func:`encode_camera_plan` / :func:`camera_file_name`) is read by T1.3, which
turns it into an integer crop x per source-grid frame (plan §5.2 R4); its fields are frozen in
docs/editor/CONTRACTS.md §5.7.

The detector is called once for the window:
``detector(source, start=a/1000, end=b/1000, sample_interval=0.75)`` →
``(times, centres, cuts, source_w, source_h)`` with ``times`` relative to ``start`` (strictly
increasing seconds), ``centres`` the normalised x centre of the face per sample (``None`` when
no face was found) and ``cuts`` the scene-change flags.

* A detector that accepts a ``smooth`` keyword is called with ``smooth=False`` and must return
  raw centres; the plan then applies ``face_tracking.smooth_face_track`` itself and lists every
  run of samples without a face that lasts longer than 1.5 s (from the first missing sample to
  the next sample, or the window end) as ``no_face``.
* Any other detector is assumed to return raw centres too (``None`` = no face), except
  today's ``face_tracking.detect_face_track``: it smooths internally and never reports a miss,
  so its centres are stored as returned and ``no_face`` stays empty until it accepts
  ``smooth=False`` (requested from the integrator; T3.6 owns the detector in W3).

``samples`` are ``[t_ms, centre_pm]`` with ``t_ms = a + ms_from_seconds(time)`` and
``centre_pm = round_half_up(centre · 1000)``; ``source_content_sha256`` is the sha256 of the
source file.
"""

from __future__ import annotations

import hashlib
import inspect
import math
from collections.abc import Callable
from itertools import pairwise
from pathlib import Path
from typing import Any

from ..face_tracking import detect_face_track, smooth_face_track
from . import CAMERA_SCHEMA
from .clip_id import ms_from_seconds
from .source_info import canonical_json, file_sha256
from .timemap import Fps

SAMPLE_MS = 750
NO_FACE_MIN_MS = 1500  # runs strictly longer than this are listed


def encode_camera_plan(plan: dict[str, Any]) -> bytes:
    """The plan's file bytes (plan §3.1 canonical JSON)."""
    return canonical_json(plan)


def camera_file_name(raw: bytes) -> str:
    """``camera.<sha16>.json``: the first 16 hex digits of the sha256 of the bytes."""
    return f"camera.{hashlib.sha256(raw).hexdigest()[:16]}.json"


def _accepts_smooth(detector: Callable) -> bool:
    try:
        parameters = inspect.signature(detector).parameters
    except (TypeError, ValueError):
        return False
    return "smooth" in parameters


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
    raw_capable = _accepts_smooth(detector)
    options: dict[str, Any] = {"smooth": False} if raw_capable else {}
    result = detector(source, start=a / 1000, end=b / 1000, sample_interval=SAMPLE_MS / 1000,
                      **options)
    times, centres, cuts, width, height = _checked(result)
    times_ms = [a + ms_from_seconds(float(t)) for t in times]
    if detector is detect_face_track and not raw_capable:
        smoothed = [0.5 if value is None else float(value) for value in centres]
        no_face: list[list[int]] = []
    else:
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
    "NO_FACE_MIN_MS",
    "SAMPLE_MS",
    "build_camera_plan",
    "camera_file_name",
    "detect_face_track",
    "encode_camera_plan",
]
