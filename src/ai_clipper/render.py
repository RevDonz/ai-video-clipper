"""FFmpeg rendering for vertical captioned clips."""

from __future__ import annotations

import importlib.util
import json
import math
import os
import secrets
import stat
import subprocess
import tempfile
from pathlib import Path

from .face_tracking import build_crop_expression, detect_face_track
from .models import TranscriptSegment
from .subtitles import to_srt

RENDER_MODES = ("face-track", "fit-blur", "center-crop")
FFPROBE_TIMEOUT_SECONDS = 30
FFMPEG_TIMEOUT_SECONDS = 300
OUTPUT_DURATION_TOLERANCE_SECONDS = 0.25


def validate_render_mode(render_mode: str) -> None:
    """Fail fast for unknown modes or a missing optional vision dependency."""
    if render_mode not in RENDER_MODES:
        raise ValueError(f"unknown render mode: {render_mode}")
    if render_mode == "face-track" and importlib.util.find_spec("cv2") is None:
        raise RuntimeError("face-track mode requires the vision extra: uv sync --extra vision")


def _stream_duration(stream: dict[str, object]) -> float:
    raw_duration = stream.get("duration")
    if raw_duration not in (None, "N/A"):
        duration = float(raw_duration)
    else:
        duration_ts = int(stream["duration_ts"])
        numerator, denominator = (int(part) for part in str(stream["time_base"]).split("/"))
        duration = duration_ts * numerator / denominator
    if not math.isfinite(duration) or duration < 0:
        raise ValueError("invalid stream duration")
    return duration


def _probe_source(source: Path) -> tuple[float, int, int | None]:
    """Return selected video duration/index and the selected audio index, if any."""
    command = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "stream=index,codec_type,duration,duration_ts,time_base:stream_disposition=attached_pic,default",
        "-of",
        "json",
        str(source),
    ]
    try:
        result = subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
            timeout=FFPROBE_TIMEOUT_SECONDS,
        )
        streams = json.loads(result.stdout)["streams"]
        videos = [
            item
            for item in streams
            if item.get("codec_type") == "video"
            and not item.get("disposition", {}).get("attached_pic", 0)
        ]
        video = next(
            (item for item in videos if item.get("disposition", {}).get("default", 0)),
            videos[0],
        )
        audios = [item for item in streams if item.get("codec_type") == "audio"]
        audio = next(
            (item for item in audios if item.get("disposition", {}).get("default", 0)),
            audios[0] if audios else None,
        )
        duration = _stream_duration(video)
        video_index = int(video.get("index", streams.index(video)))
        audio_index = None if audio is None else int(audio.get("index", streams.index(audio)))
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("FFprobe source inspection timed out") from exc
    except (
        subprocess.CalledProcessError,
        json.JSONDecodeError,
        KeyError,
        IndexError,
        StopIteration,
        TypeError,
        ValueError,
    ) as exc:
        raise RuntimeError("FFprobe could not determine selected source video duration") from exc
    return duration, video_index, audio_index


def _require_regular_output(output: Path) -> None:
    try:
        info = output.lstat()
    except OSError as exc:
        raise RuntimeError("render output is not a regular file") from exc
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise RuntimeError("render output is not a regular file")


def _require_destination_absent(directory_fd: int, name: str) -> None:
    try:
        info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    except OSError as exc:
        raise RuntimeError("render destination could not be inspected") from exc
    if stat.S_ISLNK(info.st_mode):
        raise RuntimeError("render output is not a regular file")
    raise RuntimeError("render destination already exists")


def _create_sibling_temp(directory_fd: int, suffix: str) -> tuple[int, str]:
    flags = os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
    for _ in range(128):
        name = f".ai-clipper-{secrets.token_hex(16)}{suffix}"
        try:
            return os.open(name, flags, 0o600, dir_fd=directory_fd), name
        except FileExistsError:
            continue
    raise RuntimeError("could not create a secure render temporary file")


def _unlink_quietly(directory_fd: int, name: str) -> None:
    try:
        os.unlink(name, dir_fd=directory_fd)
    except FileNotFoundError:
        pass


def _unlink_if_same(directory_fd: int, name: str, expected: os.stat_result) -> None:
    try:
        current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if (current.st_dev, current.st_ino) == (expected.st_dev, expected.st_ino):
            os.unlink(name, dir_fd=directory_fd)
    except FileNotFoundError:
        pass


def _write_all(fd: int, content: bytes) -> None:
    view = memoryview(content)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise RuntimeError("could not write render subtitle temporary file")
        view = view[written:]
    os.fsync(fd)


def _verify_rendered_media(
    output: Path, *, width: int, height: int, duration: float, inherited_fd: int | None = None
) -> None:
    """Fail closed unless FFprobe confirms the V1 media contract."""
    if inherited_fd is None:
        _require_regular_output(output)
    elif not stat.S_ISREG(os.fstat(inherited_fd).st_mode):
        raise RuntimeError("render output is not a regular file")
    command = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        (
            "stream=index,codec_type,codec_name,width,height,sample_aspect_ratio,"
            "duration,duration_ts,time_base"
        ),
        "-of",
        "json",
        str(output),
    ]
    try:
        result = subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
            timeout=FFPROBE_TIMEOUT_SECONDS,
            pass_fds=() if inherited_fd is None else (inherited_fd,),
        )
        metadata = json.loads(result.stdout)
        streams = metadata["streams"]
        if len(streams) != 2:
            raise RuntimeError("render output has an invalid stream contract")
        video, audio = streams
        if video.get("codec_type") != "video" or audio.get("codec_type") != "audio":
            raise RuntimeError("render output has an invalid stream contract")
        video_duration = _stream_duration(video)
        audio_duration = _stream_duration(audio)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("FFprobe render verification timed out") from exc
    except (
        subprocess.CalledProcessError,
        json.JSONDecodeError,
        KeyError,
        IndexError,
        StopIteration,
        TypeError,
        ValueError,
    ) as exc:
        raise RuntimeError("FFprobe render verification failed") from exc
    if video.get("codec_name") != "h264":
        raise RuntimeError("render output has an invalid video codec")
    if audio.get("codec_name") != "aac":
        raise RuntimeError("render output has an invalid audio codec")
    if video.get("width") != width or video.get("height") != height:
        raise RuntimeError("render output has invalid dimensions")
    if video.get("sample_aspect_ratio") != "1:1":
        raise RuntimeError("render output has an invalid sample aspect ratio")
    for stream_name, actual_duration in (
        ("video", video_duration),
        ("audio", audio_duration),
    ):
        if abs(actual_duration - duration) > OUTPUT_DURATION_TOLERANCE_SECONDS:
            raise RuntimeError(f"render output has an invalid {stream_name} duration")


def _layout_filter(
    source: Path,
    *,
    video_stream_index: int,
    start: float,
    end: float,
    width: int,
    height: int,
    render_mode: str,
) -> str:
    if render_mode == "fit-blur":
        return (
            f"[0:{video_stream_index}]split=2[background][foreground];"
            f"[background]scale={width}:{height}:force_original_aspect_ratio=increase,"
            f"crop={width}:{height},gblur=sigma=35[blurred];"
            f"[foreground]scale={width}:{height}:force_original_aspect_ratio=decrease[fit];"
            f"[blurred][fit]overlay=(W-w)/2:(H-h)/2,setsar=1"
        )
    if render_mode == "face-track":
        times, centers, cuts, source_width, source_height = detect_face_track(
            source,
            start=start,
            end=end,
        )
        crop_x = build_crop_expression(
            times,
            centers,
            cuts=cuts,
            source_width=source_width,
            source_height=source_height,
            output_width=width,
            output_height=height,
        )
        return (
            f"[0:{video_stream_index}]scale={width}:{height}:force_original_aspect_ratio=increase,"
            f"crop={width}:{height}:x='{crop_x}':y=(ih-oh)/2,setsar=1"
        )
    return (
        f"[0:{video_stream_index}]scale={width}:{height}:force_original_aspect_ratio=increase,"
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
    """Render a portrait clip using secure temporary files and no-clobber publication."""
    source = Path(source).resolve()
    output = Path(output).absolute()
    if not source.is_file():
        raise FileNotFoundError(source)
    validate_render_mode(render_mode)
    if not math.isfinite(start) or not math.isfinite(end):
        raise ValueError("timestamps must be finite")
    if start < 0 or end <= start:
        raise ValueError("timestamps must satisfy 0 <= start < end")
    if width <= 0 or height <= 0 or width % 2 or height % 2:
        raise ValueError("output dimensions must be positive even numbers")

    output.parent.mkdir(parents=True, exist_ok=True)
    subtitle_path = output.with_suffix(".srt")
    if subtitle_path.name == output.name:
        raise ValueError("render output and subtitle destinations must be distinct")
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
    try:
        directory_fd = os.open(output.parent, directory_flags)
    except OSError as exc:
        raise RuntimeError("render output directory is not safe") from exc
    try:
        _require_destination_absent(directory_fd, output.name)
        _require_destination_absent(directory_fd, subtitle_path.name)
    except BaseException:
        os.close(directory_fd)
        raise

    render_fd = subtitle_fd = -1
    render_temp = subtitle_temp = ""
    published_render = published_subtitle = None
    try:
        source_video_duration, video_stream_index, audio_stream_index = _probe_source(source)
        if end > source_video_duration:
            raise ValueError(
                f"clip end {end} exceeds selected source video duration {source_video_duration}"
            )

        subtitle_content = to_srt(transcript, clip_start=start, clip_end=end)
        render_fd, render_temp = _create_sibling_temp(directory_fd, ".mp4")
        subtitle_fd, subtitle_temp = _create_sibling_temp(directory_fd, ".srt")
        _write_all(subtitle_fd, subtitle_content.encode("utf-8"))

        layout_filter = _layout_filter(
            source,
            video_stream_index=video_stream_index,
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
            audio_filter = (
                f"[0:{audio_stream_index}]apad[audio]"
                if audio_stream_index is not None
                else "[1:a:0]anull[audio]"
            )
            command = [
                "ffmpeg",
                "-y",
                "-ss",
                f"{start:.3f}",
                "-i",
                str(source),
            ]
            if audio_stream_index is None:
                command.extend(
                    ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
                )
            command.extend(
                [
                    "-t",
                    f"{end - start:.3f}",
                    "-filter_complex",
                    f"{video_filter};{audio_filter}",
                    "-map",
                    "[video]",
                    "-map",
                    "[audio]",
                    "-map_metadata",
                    "-1",
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
                    "-f",
                    "mp4",
                    f"/proc/self/fd/{render_fd}",
                ]
            )
            try:
                subprocess.run(
                    command,
                    check=True,
                    capture_output=True,
                    text=True,
                    cwd=temporary_directory,
                    timeout=FFMPEG_TIMEOUT_SECONDS,
                    pass_fds=(render_fd,),
                )
            except subprocess.TimeoutExpired as exc:
                raise RuntimeError("FFmpeg render timed out") from exc
            except subprocess.CalledProcessError as exc:
                raise RuntimeError("FFmpeg render failed") from exc
        os.fsync(render_fd)
        _verify_rendered_media(
            Path(f"/proc/self/fd/{render_fd}"),
            width=width,
            height=height,
            duration=end - start,
            inherited_fd=render_fd,
        )

        _require_destination_absent(directory_fd, subtitle_path.name)
        _require_destination_absent(directory_fd, output.name)
        os.link(
            subtitle_temp,
            subtitle_path.name,
            src_dir_fd=directory_fd,
            dst_dir_fd=directory_fd,
            follow_symlinks=False,
        )
        published_subtitle = os.fstat(subtitle_fd)
        try:
            os.link(
                render_temp,
                output.name,
                src_dir_fd=directory_fd,
                dst_dir_fd=directory_fd,
                follow_symlinks=False,
            )
        except BaseException:
            _unlink_if_same(directory_fd, subtitle_path.name, published_subtitle)
            raise
        published_render = os.fstat(render_fd)
        os.fsync(directory_fd)
        return output
    except FileExistsError as exc:
        raise RuntimeError("render destination already exists") from exc
    except BaseException:
        if published_render is not None:
            _unlink_if_same(directory_fd, output.name, published_render)
        if published_subtitle is not None:
            _unlink_if_same(directory_fd, subtitle_path.name, published_subtitle)
        raise
    finally:
        if render_fd >= 0:
            os.close(render_fd)
        if subtitle_fd >= 0:
            os.close(subtitle_fd)
        if render_temp:
            _unlink_quietly(directory_fd, render_temp)
        if subtitle_temp:
            _unlink_quietly(directory_fd, subtitle_temp)
        os.close(directory_fd)
