"""Data models for the clipping spike."""

import math
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class TranscriptSegment:
    start: float
    end: float
    text: str

    def __post_init__(self) -> None:
        if not math.isfinite(self.start) or not math.isfinite(self.end):
            raise ValueError("segment timestamps must be finite")
        if self.start < 0 or self.end <= self.start:
            raise ValueError("segment timestamps must satisfy 0 <= start < end")
        if not self.text.strip():
            raise ValueError("segment text cannot be empty")


@dataclass(frozen=True, slots=True)
class Highlight:
    start: float
    end: float
    text: str
    score: float

    def __post_init__(self) -> None:
        if not all(math.isfinite(value) for value in (self.start, self.end, self.score)):
            raise ValueError("highlight timestamps and score must be finite")
        if self.start < 0 or self.end <= self.start:
            raise ValueError("highlight timestamps must satisfy 0 <= start < end")


@dataclass(frozen=True, slots=True)
class Transcription:
    language: str
    segments: list[TranscriptSegment]
