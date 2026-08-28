"""Speech-to-text adapter backed by faster-whisper."""

from __future__ import annotations

from pathlib import Path
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
    segments = [
        TranscriptSegment(float(segment.start), float(segment.end), segment.text.strip())
        for segment in raw_segments
        if segment.text.strip() and float(segment.end) > float(segment.start)
    ]
    detected_language = str(getattr(info, "language", language or "unknown"))
    return Transcription(detected_language, segments)