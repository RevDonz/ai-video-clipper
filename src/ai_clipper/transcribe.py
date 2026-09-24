"""Speech-to-text adapter backed by faster-whisper."""

from __future__ import annotations

import math
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any

from .models import Transcription, TranscriptSegment, TranscriptWord


def load_whisper_model(model_size: str = "tiny", *, device: str = "cpu") -> Any:
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise RuntimeError(
            "Transcription dependencies are missing; run `uv sync --extra transcribe`."
        ) from exc
    compute_type = "int8" if device == "cpu" else "float16"
    return WhisperModel(model_size, device=device, compute_type=compute_type)


def _finite(value: object) -> float | None:
    try:
        result = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _clean_text(value: object) -> str:
    return " ".join(value.split()) if isinstance(value, str) else ""


def _probability(value: object) -> float | None:
    result = _finite(value) if value is not None and not isinstance(value, bool) else None
    return None if result is None else min(1.0, max(0.0, result))


def _normalize_words(
    raw_words: Iterable[Any] | None, segment_start: float, segment_end: float
) -> tuple[TranscriptWord, ...]:
    """Keep non-empty, finite words, clamped chronologically inside their segment."""
    words: list[TranscriptWord] = []
    earliest = segment_start
    for raw in raw_words or ():
        text = _clean_text(getattr(raw, "word", None))
        start = _finite(getattr(raw, "start", None))
        end = _finite(getattr(raw, "end", None))
        if not text or start is None or end is None:
            continue
        start = min(max(start, earliest, 0.0), segment_end)
        end = min(max(end, start), segment_end)
        words.append(
            TranscriptWord(start, end, text, _probability(getattr(raw, "probability", None)))
        )
        earliest = start
    return tuple(words)


def transcribe_video(
    source: Path,
    *,
    model: Any,
    language: str | None = "id",
    progress_callback: Callable[[float], None] | None = None,
    word_timestamps: bool = True,
    initial_prompt: str | None = None,
) -> Transcription:
    """Transcribe ``source`` into chronological, non-overlapping segments.

    With ``word_timestamps`` (the default) every segment carries its recognized words;
    ``initial_prompt`` is passed to Whisper unchanged (for example to encourage punctuation).
    """
    source = Path(source)
    if not source.is_file():
        raise FileNotFoundError(source)
    if initial_prompt is not None and not isinstance(initial_prompt, str):
        raise TypeError("initial_prompt must be a string or None")

    raw_segments, info = model.transcribe(
        str(source),
        language=language,
        vad_filter=True,
        beam_size=5,
        word_timestamps=bool(word_timestamps),
        initial_prompt=initial_prompt,
    )
    duration = float(getattr(info, "duration", 0.0) or 0.0)
    segments: list[TranscriptSegment] = []
    previous_end = 0.0
    for segment in raw_segments:
        raw_start = _finite(getattr(segment, "start", None))
        end = _finite(getattr(segment, "end", None))
        text = _clean_text(getattr(segment, "text", None))
        if raw_start is not None and end is not None:
            start = max(raw_start, previous_end, 0.0)
            if text and end > start:
                words = (
                    _normalize_words(getattr(segment, "words", None), start, end)
                    if word_timestamps
                    else ()
                )
                segments.append(TranscriptSegment(start, end, text, words))
                previous_end = end
        if progress_callback is not None and duration > 0 and end is not None:
            progress_callback(min(1.0, max(0.0, end / duration)))
    detected_language = str(getattr(info, "language", language or "unknown"))
    return Transcription(detected_language, segments)
