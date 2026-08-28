"""Subtitle serialization helpers."""

from __future__ import annotations

from .models import TranscriptSegment


def _timestamp(seconds: float) -> str:
    milliseconds = round(max(seconds, 0.0) * 1000)
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def to_srt(
    segments: list[TranscriptSegment],
    *,
    clip_start: float,
    clip_end: float,
    max_words: int = 4,
) -> str:
    """Serialize overlapping transcript segments as short clip-relative SRT cues."""
    if clip_end <= clip_start:
        raise ValueError("clip_end must be greater than clip_start")
    if max_words <= 0:
        raise ValueError("max_words must be positive")

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
