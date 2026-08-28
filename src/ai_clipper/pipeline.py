"""End-to-end orchestration for the technical spike."""

from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path
from typing import Any

from .highlight import select_highlights
from .render import render_vertical, validate_render_mode
from .transcribe import transcribe_video


def _publish_manifest(path: Path, payload: dict[str, object]) -> None:
    """Atomically replace the public manifest with one complete state."""
    pending_path = path.with_name(".manifest.json.next")
    pending_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    pending_path.replace(path)


def run_pipeline(
    source: Path,
    output_dir: Path,
    *,
    model: Any,
    language: str | None = "id",
    min_duration: float = 20.0,
    max_duration: float = 60.0,
    limit: int = 5,
    width: int = 1080,
    height: int = 1920,
    render_mode: str = "center-crop",
) -> Path:
    """Transcribe, select highlights, render clips, and publish a status manifest."""
    source = Path(source).resolve()
    output_dir = Path(output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = output_dir / "manifest.json"
    manifest_base: dict[str, object] = {"source": str(source), "render_mode": render_mode}
    _publish_manifest(manifest_path, {**manifest_base, "status": "processing"})

    try:
        validate_render_mode(render_mode)
        transcription = transcribe_video(source, model=model, language=language)
        if not transcription.segments:
            raise ValueError("Transcription produced no usable segments")

        highlights = select_highlights(
            transcription.segments,
            min_duration=min_duration,
            max_duration=max_duration,
            limit=limit,
        )
        if not highlights:
            raise ValueError("No eligible highlights found within the requested duration bounds")

        transcript_path = output_dir / "transcript.json"
        transcript_path.write_text(
            json.dumps(
                {
                    "language": transcription.language,
                    "segments": [asdict(segment) for segment in transcription.segments],
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

        clips: list[dict[str, object]] = []
        for index, highlight in enumerate(highlights, start=1):
            clip_path = output_dir / f"clip-{index:02d}.mp4"
            render_vertical(
                source,
                clip_path,
                start=highlight.start,
                end=highlight.end,
                transcript=transcription.segments,
                width=width,
                height=height,
                render_mode=render_mode,
            )
            clips.append(
                {
                    "index": index,
                    "start": round(highlight.start, 3),
                    "end": round(highlight.end, 3),
                    "duration": round(highlight.end - highlight.start, 3),
                    "score": highlight.score,
                    "text": highlight.text,
                    "output": str(clip_path),
                    "subtitles": str(clip_path.with_suffix(".srt")),
                }
            )

        completed_manifest: dict[str, object] = {
            **manifest_base,
            "status": "completed",
            "language": transcription.language,
            "transcript": str(transcript_path),
            "clips": clips,
            "render_mode": render_mode,
        }
        _publish_manifest(manifest_path, completed_manifest)
        return manifest_path
    except Exception as exc:
        _publish_manifest(
            manifest_path,
            {
                **manifest_base,
                "status": "failed",
                "error": str(exc),
            },
        )
        raise
