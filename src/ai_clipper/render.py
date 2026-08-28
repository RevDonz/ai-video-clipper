"""FFmpeg rendering for vertical captioned clips."""

from __future__ import annotations

import importlib.util
import math
import subprocess
import tempfile
from pathlib import Path

from .face_tracking import build_crop_expression, detect_face_track
from .models import TranscriptSegment
from .subtitles import to_srt

RENDER_MODES = ("face-track", "fit-blur", "center-crop")


def validate_render_mode(render_mode: str) -> None:
    """Fail fast for unknown modes or a missing optional vision dependency."""
    if render_mode not in RENDER_MODES:
        raise ValueError(f"unknown render mode: {render_mode}")
    if render_mode == "face-track" and importlib.util.find_spec("cv2") is None:
        raise RuntimeError("face-track mode requires the vision extra: uv sync --extra vision")


def _probe_duration(source: Path) -> float:
    """Return the source duration reported by FFprobe."""
    command = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(source),
    ]
    try:
        result = subprocess.run(command, check=True, capture_output=True, text=True)
        duration = float(result.stdout.strip())
    except (subprocess.CalledProcessError, ValueError) as exc:
        raise RuntimeError("FFprobe could not determine source duration") from exc
    if not math.isfinite(duration) or duration < 0:
        raise RuntimeError("FFprobe returned an invalid source duration")
    return duration


def _layout_filter(
    source: Path,
    *,
    start: float,
    end: float,
    width: int,
    height: int,
    render_mode: str,
) -> str:
    if render_mode == "fit-blur":
        return (
            f"[0:v]split=2[background][foreground];"
            f"[background]scale={width}:{height}:force_original_aspect_ratio=increase,"
            f"crop={width}:{height},gblur=sigma=35[blurred];"
            f"[foreground]scale={width}:{height}:force_original_aspect_ratio=decrease[fit];"
            f"[blurred][fit]overlay=(W-w)/2:(H-h)/2,setsar=1"
        )
    if render_mode == "face-track":
        times, centers, source_width, source_height = detect_face_track(
            source,
            start=start,
            end=end,
        )
        crop_x = build_crop_expression(
            times,
            centers,
            source_width=source_width,
            source_height=source_height,
            output_width=width,
            output_height=height,
        )
        return (
            f"[0:v]scale={width}:{height}:force_original_aspect_ratio=increase,"
            f"crop={width}:{height}:x='{crop_x}':y=(ih-oh)/2,setsar=1"
        )
    return (
        f"[0:v]scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"crop={width}:{height},setsar=1"
    )


def render_vertical(
    source: Path,
    output: Path,
    *,
    start: float,
    end: float,
    transcript: list[TranscriptSegment],
    width: int = 1080,
    height: int = 1920,
    render_mode: str = "center-crop",
) -> Path:
    """Render a portrait clip using face tracking, fit-blur, or a centered crop."""
    source = Path(source).resolve()
    output = Path(output).resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    validate_render_mode(render_mode)
    if not math.isfinite(start) or not math.isfinite(end):
        raise ValueError("timestamps must be finite")
    if start < 0 or end <= start:
        raise ValueError("timestamps must satisfy 0 <= start < end")
    if width <= 0 or height <= 0 or width % 2 or height % 2:
        raise ValueError("output dimensions must be positive even numbers")
    source_duration = _probe_duration(source)
    if end > source_duration:
        raise ValueError(f"clip end {end} exceeds source duration {source_duration}")

    output.parent.mkdir(parents=True, exist_ok=True)
    subtitle_path = output.with_suffix(".srt")
    subtitle_content = to_srt(transcript, clip_start=start, clip_end=end)
    subtitle_path.write_text(subtitle_content, encoding="utf-8")

    layout_filter = _layout_filter(
        source,
        start=start,
        end=end,
        width=width,
        height=height,
        render_mode=render_mode,
    )
    with tempfile.TemporaryDirectory(prefix="ai-clipper-") as temporary_directory:
        filter_subtitle_path = Path(temporary_directory) / "captions.srt"
        filter_subtitle_path.write_text(subtitle_content, encoding="utf-8")
        video_filter = (
            f"{layout_filter},subtitles=filename='captions.srt':"
            "force_style='FontName=DejaVu Sans,FontSize=12,"
            "PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,"
            "BorderStyle=1,Outline=3,Shadow=1,Alignment=2,MarginV=90'[video]"
        )

        command = [
            "ffmpeg",
            "-y",
            "-ss",
            f"{start:.3f}",
            "-i",
            str(source),
            "-t",
            f"{end - start:.3f}",
            "-filter_complex",
            video_filter,
            "-map",
            "[video]",
            "-map",
            "0:a?",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "21",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
            str(output),
        ]
        try:
            subprocess.run(
                command,
                check=True,
                capture_output=True,
                text=True,
                cwd=temporary_directory,
            )
        except subprocess.CalledProcessError as exc:
            raise RuntimeError(f"FFmpeg render failed: {exc.stderr[-2000:]}") from exc
    return output
