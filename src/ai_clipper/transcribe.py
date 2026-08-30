"""Speech-to-text adapter backed by faster-whisper."""

from __future__ import annotations

from pathlib import Path
from collections.abc import Callable
from typing import Any

from .models import Transcription, TranscriptSegment


def load_whisper_model(model_size: str = "tiny", *, device: str = "cpu") -> Any:
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise RuntimeError(
            "Transcription dependencies are missing; run `uv sync --extra transcribe`."
        ) from exc
    compute_type = "int8" if device == "cpu" else "float16"
    return WhisperModel(model_size, device=device, compute_type=compute_type)


def transcribe_video(
    source: Path,
    *,
    model: Any,
    language: str | None = "id",
    progress_callback: Callable[[float], None] | None = None,
) -> Transcription:
    source = Path(source)
    if not source.is_file():
        raise FileNotFoundError(source)

    raw_segments, info = model.transcribe(
        str(source),
        language=language,
        vad_filter=True,
        beam_size=5,
    )
    duration = float(getattr(info, "duration", 0.0) or 0.0)
    segments = []
    for segment in raw_segments:
        start = float(segment.start)
        end = float(segment.end)
        text = segment.text.strip()
        if text and end > start:
            segments.append(TranscriptSegment(start, end, text))
        if progress_callback is not None and duration > 0:
            progress_callback(min(1.0, end / duration))
    detected_language = str(getattr(info, "language", language or "unknown"))
    return Transcription(detected_language, segments)