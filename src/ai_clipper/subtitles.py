"""Caption cue building and SRT serialization for rendered clip timelines.

A rendered clip plays one or more source ranges back to back (an optional cold open followed
by the main range). Cues are expressed in clip-relative seconds on that concatenated timeline,
quantized to centiseconds so the SRT sidecar and the burned ASS captions share exact timings.
"""

from __future__ import annotations

import math
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass
from itertools import pairwise
from numbers import Real

from .models import TranscriptSegment

CUE_MAX_WORDS = 4
CUE_MAX_GAP_SECONDS = 0.6
CUE_MIN_DISPLAY_SECONDS = 0.3
# Cues shorter than this (in centiseconds) are merged into a neighbour instead of flashing.
_DEGENERATE_CUE_CENTISECONDS = 5
# Segments farther than this from a range cannot contribute words to it.
_SEGMENT_SEARCH_MARGIN_SECONDS = 1.0
_SENTENCE_END_CHARACTERS = ".?!…"
_TRAILING_CLOSERS = "\"')]}»”’"
_DROPPED_CATEGORIES = frozenset({"Cc", "Cs"})

TimelineRange = tuple[float, float]


def _is_number(value: object) -> bool:
    return isinstance(value, Real) and not isinstance(value, bool)


def _centiseconds(seconds: float) -> int:
    return round(seconds * 100)


def _seconds(centiseconds: int) -> float:
    return centiseconds / 100


def clean_caption_text(text: str) -> str:
    """Drop control characters and collapse whitespace so text is safe on one caption line."""
    kept = "".join(
        " " if character.isspace() else character
        for character in text
        if character.isspace() or unicodedata.category(character) not in _DROPPED_CATEGORIES
    )
    return " ".join(kept.split())


@dataclass(frozen=True, slots=True)
class CaptionWord:
    """One displayed word in clip-relative seconds."""

    start: float
    end: float
    text: str

    def __post_init__(self) -> None:
        if not _is_number(self.start) or not _is_number(self.end):
            raise TypeError("caption word timestamps must be numbers")
        if not math.isfinite(self.start) or not math.isfinite(self.end):
            raise ValueError("caption word timestamps must be finite")
        if self.start < 0 or self.end < self.start:
            raise ValueError("caption word timestamps must satisfy 0 <= start <= end")
        if not isinstance(self.text, str) or not self.text.strip():
            raise ValueError("caption word text cannot be empty")


@dataclass(frozen=True, slots=True)
class CaptionCue:
    """One on-screen caption in clip-relative seconds; words carry karaoke timing."""

    start: float
    end: float
    words: tuple[CaptionWord, ...]

    def __post_init__(self) -> None:
        if not _is_number(self.start) or not _is_number(self.end):
            raise TypeError("caption cue timestamps must be numbers")
        if not math.isfinite(self.start) or not math.isfinite(self.end):
            raise ValueError("caption cue timestamps must be finite")
        if self.start < 0 or self.end <= self.start:
            raise ValueError("caption cue timestamps must satisfy 0 <= start < end")
        if not isinstance(self.words, tuple) or any(
            not isinstance(word, CaptionWord) for word in self.words
        ):
            raise TypeError("caption cue words must be a tuple of CaptionWord values")
        if not self.words:
            raise ValueError("caption cue needs at least one word")
        if any(word.start < self.start or word.end > self.end for word in self.words):
            raise ValueError("caption cue words must lie inside the cue")
        if any(later.start < earlier.start for earlier, later in pairwise(self.words)):
            raise ValueError("caption cue words must be chronological")

    @property
    def text(self) -> str:
        return " ".join(word.text for word in self.words)


@dataclass(frozen=True, slots=True)
class _Word:
    start: int  # clip-relative centiseconds
    end: int
    text: str


def validate_timeline_ranges(ranges: Sequence[TimelineRange]) -> tuple[TimelineRange, ...]:
    """Return source ranges as float pairs after checking they are finite and non-empty."""
    validated: list[TimelineRange] = []
    for item in ranges:
        if not isinstance(item, (tuple, list)) or len(item) != 2:
            raise TypeError("timeline ranges must be (start, end) pairs")
        start, end = item
        if not _is_number(start) or not _is_number(end):
            raise TypeError("timeline range timestamps must be numbers")
        if not math.isfinite(start) or not math.isfinite(end):
            raise ValueError("timeline range timestamps must be finite")
        if start < 0 or end <= start:
            raise ValueError("timeline ranges must satisfy 0 <= start < end")
        validated.append((float(start), float(end)))
    if not validated:
        raise ValueError("caption timeline needs at least one range")
    return tuple(validated)


def timeline_duration(ranges: Sequence[TimelineRange]) -> float:
    """Total rendered duration of ranges played back to back."""
    return sum(end - start for start, end in validate_timeline_ranges(ranges))


def _segment_words(segment: TranscriptSegment) -> list[tuple[float, float, str]]:
    if segment.words:
        return [(word.start, word.end, word.text) for word in segment.words]
    tokens = segment.text.split()
    duration = segment.end - segment.start
    count = len(tokens)
    return [
        (
            segment.start + duration * index / count,
            segment.start + duration * (index + 1) / count,
            token,
        )
        for index, token in enumerate(tokens)
    ]


def _range_words(
    segments: Sequence[TranscriptSegment],
    range_start: float,
    range_end: float,
    offset: float,
) -> list[_Word]:
    """Words whose midpoint lies in the range, clamped to it and shifted onto the timeline."""
    collected: list[_Word] = []
    for segment in segments:
        if (
            segment.end < range_start - _SEGMENT_SEARCH_MARGIN_SECONDS
            or segment.start > range_end + _SEGMENT_SEARCH_MARGIN_SECONDS
        ):
            continue
        for start, end, raw_text in _segment_words(segment):
            midpoint = (start + end) / 2
            if not range_start <= midpoint < range_end:
                continue
            text = clean_caption_text(raw_text)
            if not text:
                continue
            clamped_start = max(start, range_start) - range_start + offset
            clamped_end = min(end, range_end) - range_start + offset
            collected.append(_Word(_centiseconds(clamped_start), _centiseconds(clamped_end), text))
    collected.sort(key=lambda word: word.start)
    normalized: list[_Word] = []
    for index, word in enumerate(collected):
        end = word.end
        if index + 1 < len(collected):
            end = min(end, collected[index + 1].start)
        normalized.append(_Word(word.start, max(end, word.start), word.text))
    return normalized


def _ends_sentence(text: str) -> bool:
    stripped = text.rstrip(_TRAILING_CLOSERS)
    return bool(stripped) and stripped[-1] in _SENTENCE_END_CHARACTERS


def _group_words(words: list[_Word], *, max_words: int, max_gap: int) -> list[list[_Word]]:
    groups: list[list[_Word]] = []
    current: list[_Word] = []
    for word in words:
        if current and (
            len(current) >= max_words
            or word.start - current[-1].end > max_gap
            or _ends_sentence(current[-1].text)
        ):
            groups.append(current)
            current = []
        current.append(word)
    if current:
        groups.append(current)
    return groups


def _merge_degenerate_groups(groups: list[list[_Word]], range_end: int) -> list[list[_Word]]:
    """Fold groups that would be shown for less than a flash into a neighbour."""
    kept: list[list[_Word]] = []
    carry: list[_Word] = []
    for index, group in enumerate(groups):
        words = carry + group
        carry = []
        limit = groups[index + 1][0].start if index + 1 < len(groups) else range_end
        if limit - words[0].start < _DEGENERATE_CUE_CENTISECONDS:
            if index + 1 < len(groups):
                carry = words
                continue
            if kept:
                kept[-1] = kept[-1] + words
                continue
            if limit <= words[0].start:
                continue
        kept.append(words)
    return kept


def _range_cues(groups: list[list[_Word]], *, range_end: int, min_display: int) -> list[CaptionCue]:
    cues: list[CaptionCue] = []
    for index, words in enumerate(groups):
        start = words[0].start
        limit = groups[index + 1][0].start if index + 1 < len(groups) else range_end
        natural_end = max(word.end for word in words)
        end = min(max(natural_end, start + min_display), limit)
        cues.append(
            CaptionCue(
                _seconds(start),
                _seconds(end),
                tuple(
                    CaptionWord(_seconds(word.start), _seconds(min(word.end, end)), word.text)
                    for word in words
                ),
            )
        )
    return cues


def build_caption_cues(
    segments: Sequence[TranscriptSegment],
    ranges: Sequence[TimelineRange],
    *,
    max_words: int = CUE_MAX_WORDS,
    max_gap: float = CUE_MAX_GAP_SECONDS,
    min_display: float = CUE_MIN_DISPLAY_SECONDS,
) -> tuple[CaptionCue, ...]:
    """Build clip-relative cues for source ranges rendered back to back.

    Word timestamps drive cue timing when a segment has them; otherwise the segment's words are
    spread proportionally over it. A word belongs to a range when its midpoint lies inside it,
    so edge words of partially overlapping segments are kept. Cues hold up to ``max_words``
    words, break on gaps longer than ``max_gap`` and on sentence ends, start at the first word,
    end at the last word (held for at least ``min_display`` seconds), never overlap, and never
    cross the join between two ranges.
    """
    validated = validate_timeline_ranges(ranges)
    if not isinstance(max_words, int) or isinstance(max_words, bool) or max_words <= 0:
        raise ValueError("max_words must be a positive integer")
    for name, value in (("max_gap", max_gap), ("min_display", min_display)):
        if not _is_number(value) or not math.isfinite(value) or value < 0:
            raise ValueError(f"{name} must be a finite non-negative number")

    cues: list[CaptionCue] = []
    offset = 0.0
    for range_start, range_end in validated:
        length = range_end - range_start
        words = _range_words(segments, range_start, range_end, offset)
        timeline_end = _centiseconds(offset + length)
        groups = _group_words(words, max_words=max_words, max_gap=_centiseconds(max_gap))
        cues.extend(
            _range_cues(
                _merge_degenerate_groups(groups, timeline_end),
                range_end=timeline_end,
                min_display=_centiseconds(min_display),
            )
        )
        offset += length
    return tuple(cues)


def _timestamp(seconds: float) -> str:
    milliseconds = round(max(seconds, 0.0) * 1000)
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def cues_to_srt(cues: Sequence[CaptionCue]) -> str:
    """Serialize cues as SRT; these are exactly the cues burned into the video."""
    blocks = [
        f"{number}\n{_timestamp(cue.start)} --> {_timestamp(cue.end)}\n{cue.text}"
        for number, cue in enumerate(cues, start=1)
    ]
    return "\n\n".join(blocks) + ("\n" if blocks else "")


def timeline_to_srt(
    segments: Sequence[TranscriptSegment],
    ranges: Sequence[TimelineRange],
    *,
    max_words: int = CUE_MAX_WORDS,
) -> str:
    """SRT for a clip that plays ``ranges`` back to back (e.g. cold open, then main range)."""
    return cues_to_srt(build_caption_cues(segments, ranges, max_words=max_words))


def to_srt(
    segments: list[TranscriptSegment],
    *,
    clip_start: float,
    clip_end: float,
    max_words: int = 4,
) -> str:
    """Serialize transcript text as short clip-relative SRT cues.

    With word timestamps this delegates to the word-timed cue builder. Without them it keeps
    the historical behaviour: only segments fully inside the clip, split proportionally.
    """
    if clip_end <= clip_start:
        raise ValueError("clip_end must be greater than clip_start")
    if max_words <= 0:
        raise ValueError("max_words must be positive")
    if any(segment.words for segment in segments):
        return timeline_to_srt(segments, [(clip_start, clip_end)], max_words=max_words)

    cues: list[str] = []
    for segment in segments:
        if segment.start < clip_start or segment.end > clip_end:
            continue
        start = segment.start
        end = segment.end
        words = segment.text.strip().split()
        duration = end - start
        for word_index in range(0, len(words), max_words):
            chunk = words[word_index : word_index + max_words]
            chunk_start = start + duration * word_index / len(words)
            chunk_end = start + duration * (word_index + len(chunk)) / len(words)
            relative_start = chunk_start - clip_start
            relative_end = chunk_end - clip_start
            cues.append(
                f"{len(cues) + 1}\n"
                f"{_timestamp(relative_start)} --> {_timestamp(relative_end)}\n"
                f"{' '.join(chunk)}"
            )
    return "\n\n".join(cues) + ("\n" if cues else "")
