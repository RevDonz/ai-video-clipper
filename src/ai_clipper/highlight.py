"""Transcript-first highlight selection for the technical spike."""

from __future__ import annotations

import math

from .models import Highlight, TranscriptSegment

_POSITIVE_PHRASES = (
    "kesalahan terbesar",
    "rahasia",
    "ternyata",
    "jangan",
    "cara",
    "mengapa",
    "kenapa",
    "penting",
    "masalah",
    "buktikan",
)
_INTRO_PHRASES = ("halo semuanya", "selamat datang")
_OUTRO_PHRASES = ("terima kasih", "sampai jumpa")


def _score(text: str, duration: float) -> float:
    lowered = text.casefold()
    score = min(len(text.split()) / 8.0, 8.0)
    score += sum(2.0 for phrase in _POSITIVE_PHRASES if phrase in lowered)
    score -= sum(4.0 for phrase in _INTRO_PHRASES if phrase in lowered)
    score -= sum(4.0 for phrase in _OUTRO_PHRASES if phrase in lowered)
    score += min(duration, 45.0) / 45.0
    return round(score, 3)


def select_highlights(
    segments: list[TranscriptSegment],
    *,
    min_duration: float = 20.0,
    max_duration: float = 60.0,
    limit: int = 5,
) -> list[Highlight]:
    """Return the highest-scoring non-overlapping transcript windows."""
    if not math.isfinite(min_duration) or not math.isfinite(max_duration):
        raise ValueError("duration bounds must be finite")
    if min_duration <= 0 or max_duration < min_duration:
        raise ValueError("duration bounds are invalid")
    if limit <= 0:
        raise ValueError("limit must be positive")

    candidates: list[Highlight] = []
    for start_index, first in enumerate(segments):
        end_index = start_index
        while end_index + 1 < len(segments):
            proposed_end = segments[end_index + 1].end
            if proposed_end - first.start > max_duration:
                break
            end_index += 1

        if end_index < start_index:
            continue
        last = segments[end_index]
        duration = last.end - first.start
        if not min_duration <= duration <= max_duration:
            continue
        text = " ".join(segment.text.strip() for segment in segments[start_index : end_index + 1])
        candidates.append(Highlight(first.start, last.end, text, _score(text, duration)))

    selected: list[Highlight] = []
    for candidate in sorted(candidates, key=lambda clip: (-clip.score, clip.start)):
        overlaps = any(candidate.start < clip.end and clip.start < candidate.end for clip in selected)
        if not overlaps:
            selected.append(candidate)
            if len(selected) == limit:
                break
    return sorted(selected, key=lambda clip: clip.start)
