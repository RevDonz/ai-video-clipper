"""Rentang waktu: time ranges a person types, each kept as a clip (plan 2026-10-20 P2).

A range is ``<start>-<end>``. A time is whole seconds (``90``), minutes and seconds (``10.30`` or
``10:30``) or hours, minutes and seconds (``1:02:10`` or ``1.02.10``); seconds and minutes after
the first part have exactly two digits, 00 to 59. Full-width digits and punctuation are read
as their ASCII forms (NFKC), and a hyphen, en dash, em dash or minus sign separates the two
times. Several ranges are separated by commas, semicolons or line breaks and keep the typed
order. Each lasts :data:`MIN_RANGE_SECONDS` to :data:`MAX_RANGE_SECONDS`; a job has at most
:data:`MAX_RANGES`, never more than its clip count, and no two overlap.

``web/lib/time-ranges.mjs`` reads the same grammar with the same messages (a web test compares
the two), so the dashboard refuses a range before any download. Every refusal is a
:class:`TimeRangeError` with an Indonesian message the person can act on and a ``code``:
``time_range_invalid`` for the text, ``range_beyond_video`` once the video's length is known
(:func:`check_within_video`) and ``range_no_speech`` from the selection (no transcript inside).
"""

from __future__ import annotations

import math
import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass

MIN_RANGE_SECONDS = 5
MAX_RANGE_SECONDS = 180
MAX_RANGES = 10
MAX_RANGES_TEXT = 500
# A range may end up to this far past the probed length (a player shows whole seconds); the
# selection then trims it to the video.
BEYOND_VIDEO_TOLERANCE_SECONDS = 1.0
MAX_SHOWN_CHARS = 24

INVALID = "time_range_invalid"
BEYOND_VIDEO = "range_beyond_video"
NO_SPEECH = "range_no_speech"

_RANGE_SEPARATORS = re.compile(r"[,;\r\n]+")
_DASH = "-‐‑‒–—−"
_RANGE = re.compile(rf"\s*([0-9:.]+)\s*[{_DASH}]\s*([0-9:.]+)\s*")
_TIME_PARTS = re.compile(r"[:.]")
_EXAMPLE = "Contoh: 10.30-12.05 atau 1:02:10-1:03:00."


class TimeRangeError(ValueError):
    """A time range the job cannot use; the message is Indonesian and says what to fix."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def format_clock(seconds: float) -> str:
    """``m:ss`` or ``h:mm:ss`` of the whole seconds in ``seconds``."""
    total = max(0, math.floor(seconds))
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"


def _shown(text: str) -> str:
    text = text.strip()
    return text if len(text) <= MAX_SHOWN_CHARS else f"{text[:MAX_SHOWN_CHARS]}…"


class _UnknownText(TimeRangeError):
    """Text that is no time or range at all (as opposed to one with impossible values)."""


def _unknown(text: str) -> TimeRangeError:
    return _UnknownText(INVALID, f"“{_shown(text)}” tidak dikenali. {_EXAMPLE}")


def _whole(value: object, name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError(f"{name} must be whole seconds")
    return value


@dataclass(frozen=True, slots=True)
class TimeRange:
    """One range in whole source seconds, ``start`` inclusive to ``end``."""

    start: int
    end: int

    def __post_init__(self) -> None:
        start = _whole(self.start, "start")
        end = _whole(self.end, "end")
        if start < 0 or end <= start:
            raise TimeRangeError(
                INVALID, f"Rentang {self.label}: waktu selesai harus setelah waktu mulai."
            )
        if end - start < MIN_RANGE_SECONDS:
            raise TimeRangeError(
                INVALID, f"Rentang {self.label} terlalu pendek: minimal {MIN_RANGE_SECONDS} detik."
            )
        if end - start > MAX_RANGE_SECONDS:
            raise TimeRangeError(
                INVALID,
                f"Rentang {self.label} terlalu panjang: maksimal {MAX_RANGE_SECONDS} detik "
                f"({MAX_RANGE_SECONDS // 60} menit).",
            )

    @property
    def duration(self) -> int:
        return self.end - self.start

    @property
    def label(self) -> str:
        return f"{format_clock(self.start)}–{format_clock(self.end)}"


def parse_time(text: str) -> int:
    """Whole seconds of one typed time (see the module docstring)."""
    if not isinstance(text, str):
        raise TypeError("time must be text")
    normal = unicodedata.normalize("NFKC", text).strip()
    parts = _TIME_PARTS.split(normal)
    if not all(part.isascii() and part.isdigit() for part in parts):
        raise _unknown(text)
    if len(parts) == 1:
        if len(parts[0]) > 5:
            raise _unknown(text)
        return int(parts[0])
    lead, *rest = parts
    if len(parts) > 3 or any(len(part) != 2 for part in rest) or len(lead) > 5 - len(parts):
        raise _unknown(text)
    if any(int(part) >= 60 for part in rest):
        raise TimeRangeError(
            INVALID, f"“{_shown(text)}” tidak valid: menit dan detik hanya 00 sampai 59."
        )
    seconds = 0
    for part in parts:
        seconds = seconds * 60 + int(part)
    return seconds


def parse_time_range(text: str) -> TimeRange:
    """One typed range, such as ``10.30-12.05``."""
    if not isinstance(text, str):
        raise TypeError("time range must be text")
    match = _RANGE.fullmatch(unicodedata.normalize("NFKC", text))
    if match is None:
        raise _unknown(text)
    try:
        start, end = parse_time(match[1]), parse_time(match[2])
    except _UnknownText:
        raise _unknown(text) from None  # name the whole range the person typed
    return TimeRange(start, end)


def check_ranges(ranges: Sequence[TimeRange], limit: int | None = None) -> tuple[TimeRange, ...]:
    """``ranges`` as a tuple once they fit together: at most :data:`MAX_RANGES` (and at most
    ``limit``, the job's clip count), none overlapping another."""
    items = tuple(ranges)
    if any(not isinstance(item, TimeRange) for item in items):
        raise TypeError("ranges must be TimeRange values")
    if len(items) > MAX_RANGES:
        raise TimeRangeError(INVALID, f"Maksimal {MAX_RANGES} rentang waktu.")
    for index, first in enumerate(items):
        for second in items[index + 1 :]:
            if first.start < second.end and second.start < first.end:
                raise TimeRangeError(
                    INVALID, f"Rentang {first.label} dan {second.label} tumpang tindih."
                )
    if limit is not None and len(items) > limit:
        raise TimeRangeError(
            INVALID,
            f"Ada {len(items)} rentang waktu, tetapi jumlah klip {limit}. "
            "Naikkan jumlah klip atau kurangi rentang.",
        )
    return items


def parse_time_ranges(text: str, limit: int | None = None) -> tuple[TimeRange, ...]:
    """Every range in ``text`` (empty pieces are skipped), checked with :func:`check_ranges`."""
    if not isinstance(text, str):
        raise TypeError("time ranges must be text")
    if len(text) > MAX_RANGES_TEXT:
        raise TimeRangeError(INVALID, "Isian rentang waktu terlalu panjang.")
    pieces = [piece for piece in _RANGE_SEPARATORS.split(text) if piece.strip()]
    return check_ranges([parse_time_range(piece) for piece in pieces], limit)


def check_within_video(ranges: Sequence[TimeRange], duration: float | None) -> None:
    """Refuse the first range that ends past the video (``duration`` seconds; ``None`` is
    unknown and not checked), allowing :data:`BEYOND_VIDEO_TOLERANCE_SECONDS`."""
    if duration is None:
        return
    for item in ranges:
        if item.end > duration + BEYOND_VIDEO_TOLERANCE_SECONDS:
            raise TimeRangeError(
                BEYOND_VIDEO,
                f"Rentang {item.label} melewati panjang video ({format_clock(duration)}). "
                "Perbaiki rentangnya lalu buat job lagi.",
            )


def no_speech_error(item: TimeRange) -> TimeRangeError:
    """The refusal of a range without a transcript line inside it."""
    return TimeRangeError(
        NO_SPEECH,
        f"Rentang {item.label} tidak berisi ucapan. Pilih bagian yang ada ucapannya "
        "lalu buat job lagi.",
    )
