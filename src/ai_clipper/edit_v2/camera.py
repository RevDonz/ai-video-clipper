"""Face-track camera plan over the whole clip window (plan §5.7).

Owner: T1.5 (taken over by T3.6). Stub landed by T1.0 with the frozen Appendix A signature.
The file ``camera.<sha16>.json`` (``potongin.camera-plan/1``, canonical JSON) is read by T1.3,
which turns it into an integer crop x per source-grid frame (plan §5.2 R4); its fields are frozen
in docs/editor/CONTRACTS.md.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from ..face_tracking import detect_face_track
from .timemap import Fps


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
    raise NotImplementedError("T1.5: edit_v2.camera.build_camera_plan (plan §5.7)")


__all__ = ["build_camera_plan"]
