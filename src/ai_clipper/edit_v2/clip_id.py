"""Stable clip identity (plan §3.5, FINAL §4.9, Appendix A ``clip_id.py``).

``clip_id = "clip_" + sha256("potongin-clip-v1\\0" ‖ source_content_sha256 ‖ "\\0" ‖ start_ms ‖
"\\0" ‖ end_ms ‖ "\\0" ‖ (co_start_ms "-" co_end_ms, or "-"))[:24]`` with the integers written in
decimal ASCII. Rank and selection version are excluded, so a selection re-run that finds the same
moment re-attaches the saved edits.
"""

from __future__ import annotations

import hashlib
import math
import re
from decimal import ROUND_HALF_UP, Decimal

CLIP_ID_PATTERN = re.compile(r"clip_[0-9a-f]{24}")
_SHA256 = re.compile(r"[0-9a-f]{64}")
_DOMAIN = b"potongin-clip-v1\0"


def _ms(value: object, name: str) -> int:
    if type(value) is not int:
        raise TypeError(f"{name} must be an integer number of milliseconds")
    if value < 0:
        raise ValueError(f"{name} must not be negative")
    return value


def clip_id(
    source_content_sha256: str,
    start_ms: int,
    end_ms: int,
    cold_open_ms: tuple[int, int] | None,
) -> str:
    """The clip id of a V3 clip: body ``[start_ms, end_ms)`` plus its optional cold open.

    Times are the selection's source milliseconds (``ms_from_seconds`` of the V3 values), not
    frame-snapped values, so the id does not depend on the output frame rate.
    """
    if not isinstance(source_content_sha256, str) or not _SHA256.fullmatch(source_content_sha256):
        raise ValueError("source_content_sha256 must be 64 lowercase hex characters")
    start = _ms(start_ms, "start_ms")
    end = _ms(end_ms, "end_ms")
    if end <= start:
        raise ValueError("clip must satisfy start_ms < end_ms")
    if cold_open_ms is None:
        tail = "-"
    else:
        if type(cold_open_ms) is not tuple or len(cold_open_ms) != 2:
            raise TypeError("cold_open_ms must be a (start_ms, end_ms) tuple or None")
        co_start = _ms(cold_open_ms[0], "cold open start_ms")
        co_end = _ms(cold_open_ms[1], "cold open end_ms")
        if co_end <= co_start:
            raise ValueError("cold open must satisfy start_ms < end_ms")
        tail = f"{co_start}-{co_end}"
    payload = _DOMAIN + "\0".join((source_content_sha256, str(start), str(end), tail)).encode()
    return "clip_" + hashlib.sha256(payload).hexdigest()[:24]


def is_clip_id(value: object) -> bool:
    return isinstance(value, str) and CLIP_ID_PATTERN.fullmatch(value) is not None


def ms_from_seconds(seconds: float) -> int:
    """``round_half_up(seconds·1000)`` on the decimal value of ``seconds`` (plan §3.4).

    V3 times have three decimals; using the shortest decimal representation of the float (not
    the binary product) keeps ``x.xxx5`` values from rounding down.
    """
    if isinstance(seconds, bool) or not isinstance(seconds, (int, float)):
        raise TypeError("seconds must be a number")
    if not math.isfinite(seconds):
        raise ValueError("seconds must be finite")
    if seconds < 0:
        raise ValueError("seconds must not be negative")
    value = Decimal(repr(seconds)) * 1000
    return int(value.quantize(Decimal(1), rounding=ROUND_HALF_UP))


__all__ = ["CLIP_ID_PATTERN", "clip_id", "is_clip_id", "ms_from_seconds"]
