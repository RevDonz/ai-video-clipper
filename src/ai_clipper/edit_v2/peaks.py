"""Waveform peaks of the analysis window (plan §3.6 "Peaks").

Owner: T1.5. Stub landed by T1.0 with the frozen Appendix A signature. Format (frozen, see
docs/editor/CONTRACTS.md): mono audio decoded once at 8 kHz by FFmpeg; per bin of
``1000 / per_sec`` ms from ``window_ms[0]``, two signed bytes ``(min, max)`` of the s16 samples
divided by 256 (floor); ``ceil((b − a) · per_sec / 1000)`` bins. Stored immutably as
``analysis/clips/<clip_id>/peaks.<sha16>.bin``.
"""

from __future__ import annotations

from pathlib import Path


def build_peaks(source: Path, window_ms: tuple[int, int], *, per_sec: int = 100) -> bytes:
    """The peaks bytes of ``source`` over ``window_ms``."""
    raise NotImplementedError("T1.5: edit_v2.peaks.build_peaks (plan §3.6)")


__all__ = ["build_peaks"]
