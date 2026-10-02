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
from collections.abc import Sequence
from fractions import Fraction
from numbers import Real
from pathlib import Path

from .captions_ass import CAPTION_STYLES, build_ass
from .edit_v2 import errors as _edit_errors
from .edit_v2 import transitions as _transitions
from .edit_v2.glyphs import RESOURCES_DIR as SFX_RESOURCES_DIR
from .face_tracking import build_crop_expression, detect_face_track
from .models import TranscriptSegment
from .subtitles import build_caption_cues, cues_to_srt

RENDER_MODES = ("face-track", "fit-blur", "center-crop")
FFPROBE_TIMEOUT_SECONDS = 30
FFMPEG_TIMEOUT_SECONDS = 300
OUTPUT_DURATION_TOLERANCE_SECONDS = 0.25
COLD_OPEN_MIN_SECONDS = 0.5
COLD_OPEN_MAX_SECONDS = 8.0
HOOK_DURATION_MAX_SECONDS = 30.0
AUDIO_JOIN_FADE_SECONDS = 0.03
# A cold open starting this close to the main start would only repeat the opening line.
_COLD_OPEN_SAME_START_TOLERANCE_SECONDS = 0.01
_LENGTH_EPSILON_SECONDS = 1e-9
_SILENT_AUDIO = "anullsrc=channel_layout=stereo:sample_rate=48000"
_CAPTIONS_FILTER = "ass=filename='captions.ass'"
_SFX_FORMAT = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"
_ENCODE_ARGUMENTS = (
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
)


def _is_number(value: object) -> bool:
    return isinstance(value, Real) and not isinstance(value, bool)


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
    input_label: str,
    start: float,
    end: float,
    width: int,
    height: int,
    render_mode: str,
    label_suffix: str = "",
) -> str:
    """Portrait layout chain for one source range; its output pad is left unlabelled."""
    if render_mode == "fit-blur":
        background = f"[background{label_suffix}]"
        foreground = f"[foreground{label_suffix}]"
        blurred = f"[blurred{label_suffix}]"
        fit = f"[fit{label_suffix}]"
        return (
            f"{input_label}split=2{background}{foreground};"
            f"{background}scale={width}:{height}:force_original_aspect_ratio=increase,"
            f"crop={width}:{height},gblur=sigma=35{blurred};"
            f"{foreground}scale={width}:{height}:force_original_aspect_ratio=decrease{fit};"
            f"{blurred}{fit}overlay=(W-w)/2:(H-h)/2,setsar=1"
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
            f"{input_label}scale={width}:{height}:force_original_aspect_ratio=increase,"
            f"crop={width}:{height}:x='{crop_x}':y=(ih-oh)/2,setsar=1"
        )
    return (
        f"{input_label}scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"crop={width}:{height},setsar=1"
    )


def _validate_cold_open(
    cold_open: Sequence[float] | None, *, start: float
) -> tuple[float, float] | None:
    """Check a cold-open source range; the source-duration bound is checked after probing."""
    if cold_open is None:
        return None
    if not isinstance(cold_open, (tuple, list)) or len(cold_open) != 2:
        raise TypeError("cold open must be a (start, end) pair")
    cold_start, cold_end = cold_open
    if not _is_number(cold_start) or not _is_number(cold_end):
        raise TypeError("cold open timestamps must be numbers")
    if not math.isfinite(cold_start) or not math.isfinite(cold_end):
        raise ValueError("cold open timestamps must be finite")
    if cold_start < 0 or cold_end <= cold_start:
        raise ValueError("cold open must satisfy 0 <= start < end")
    length = cold_end - cold_start
    if not (
        COLD_OPEN_MIN_SECONDS - _LENGTH_EPSILON_SECONDS
        <= length
        <= COLD_OPEN_MAX_SECONDS + _LENGTH_EPSILON_SECONDS
    ):
        raise ValueError(
            f"cold open length must be between {COLD_OPEN_MIN_SECONDS:g} and "
            f"{COLD_OPEN_MAX_SECONDS:g} seconds"
        )
    if abs(cold_start - start) < _COLD_OPEN_SAME_START_TOLERANCE_SECONDS:
        raise ValueError("cold open must not start at the clip start")
    return float(cold_start), float(cold_end)


def _validate_packaging(hook_text: object, hook_duration: object, caption_style: object) -> None:
    if caption_style not in CAPTION_STYLES:
        raise ValueError(f"unknown caption style: {caption_style}")
    if hook_text is not None and not isinstance(hook_text, str):
        raise TypeError("hook text must be a string or None")
    if (
        not _is_number(hook_duration)
        or not math.isfinite(hook_duration)
        or not 0 < hook_duration <= HOOK_DURATION_MAX_SECONDS
    ):
        raise ValueError(
            f"hook duration must be greater than 0 and at most {HOOK_DURATION_MAX_SECONDS:g} seconds"
        )


def _single_range_command(
    source: Path,
    *,
    start: float,
    end: float,
    layout_filter: str,
    audio_stream_index: int | None,
    output_path: str,
) -> list[str]:
    """One seeked input; the historical V1 command with ASS captions burned on top."""
    video_filter = f"{layout_filter},{_CAPTIONS_FILTER}[video]"
    audio_filter = (
        f"[0:{audio_stream_index}]apad[audio]"
        if audio_stream_index is not None
        else "[1:a:0]anull[audio]"
    )
    command = ["ffmpeg", "-y", "-ss", f"{start:.3f}", "-i", str(source)]
    if audio_stream_index is None:
        command.extend(["-f", "lavfi", "-i", _SILENT_AUDIO])
    command.extend(
        [
            "-t",
            f"{end - start:.3f}",
            "-filter_complex",
            f"{video_filter};{audio_filter}",
            *_ENCODE_ARGUMENTS,
            output_path,
        ]
    )
    return command


def _milliseconds(value: int) -> str:
    return f"{value // 1000}.{value % 1000:03d}"


def _microseconds(value: int) -> str:
    return f"{value // 1_000_000}.{value % 1_000_000:06d}"


def _cold_open_join_s(source: Path, video_index: int, start: float, length: float) -> str | None:
    """Where the body starts in the cold-open range's own time: the end of its last frame, as
    ``%d.%06d`` seconds, decoded with the render's own seek (``-ss``/``-t`` before ``-i``).

    The range holds the source frames the seek keeps, so its end is a frame boundary that a
    guess from the frame rate misses by a frame at about a third of seek points; the effect on
    the cold-open side is placed against it. ``None`` when it cannot be read."""
    command = ["ffmpeg", "-nostdin", "-v", "error", "-ss", f"{start:.3f}", "-t",
               f"{length:.3f}", "-i", str(source), "-map", f"0:{video_index}", "-f",
               "framecrc", "-"]
    try:
        result = subprocess.run(command, check=True, capture_output=True, text=True,
                                timeout=FFMPEG_TIMEOUT_SECONDS)
        time_base = None
        frames: list[tuple[int, int]] = []
        for line in result.stdout.splitlines():
            if line.startswith("#tb 0:"):
                time_base = Fraction(line.split(":", 1)[1].strip())
            elif line and not line.startswith("#"):
                fields = [field.strip() for field in line.split(",")]
                frames.append((int(fields[2]), int(fields[3])))
    except (OSError, subprocess.SubprocessError, ValueError, IndexError, ZeroDivisionError):
        return None
    if time_base is None or not frames or frames[-1][1] <= 0 or time_base <= 0:
        return None
    end = (frames[-1][0] - frames[0][0] + frames[-1][1]) * time_base * 1_000_000
    micro = (2 * end.numerator + end.denominator) // (2 * end.denominator)
    return _microseconds(micro) if micro > 0 else None


def _join_effect(style: str, index: int, cold_open_ms: int, join_s: str | None = None) -> str:
    """The cold-open effect of range ``index`` (0: the cold open, 1: the body), appended to its
    layout (spec 2026-10-02 §4.3): ``alpha(τ) = max(0, 1 − |τ|/W)`` at the range's own frame
    times, blended toward the style's 8-bit TV-range colour in ``yuv420p``; ``""`` for a cut
    or a later range. ``join_s`` is the cold open's measured end (:func:`_cold_open_join_s`);
    without it the range length as written stands for it."""
    if style == "cut" or index > 1:
        return ""
    width_ms = _transitions.HALF_WIDTH_MS[style]
    width = _milliseconds(width_ms)
    if index == 0:
        if join_s is None:
            join, start = _milliseconds(cold_open_ms), _milliseconds(cold_open_ms - width_ms)
        else:
            whole, _, fraction = join_s.partition(".")
            join_us = int(whole) * 1_000_000 + int(fraction)
            join, start = join_s, _microseconds(max(0, join_us - width_ms * 1000))
        alpha = f"clip(floor(1000-1000*({join}-T)/{width}+0.5),0,1000)"
        enable = f"gte(t,{start})"
    else:
        alpha = f"clip(floor(1000-1000*T/{width}+0.5),0,1000)"
        enable = f"lt(t,{width})"
    planes = ":".join(
        f"{plane}='st(0,{alpha});floor(({plane}(X,Y)*(1000-ld(0))+{colour}*ld(0)+500)/1000)'"
        for plane, colour in zip(("lum", "cb", "cr"), _transitions.YUV_TV[style], strict=True))
    return f",format=yuv420p,geq={planes}:enable='{enable}'"


def _multi_range_command(
    source: Path,
    *,
    ranges: Sequence[tuple[float, float]],
    video_stream_index: int,
    audio_stream_index: int | None,
    width: int,
    height: int,
    render_mode: str,
    output_path: str,
    join_style: str = "cut",
    join_sfx_path: Path | None = None,
    cold_open_join_s: str | None = None,
) -> list[str]:
    """Play source ranges back to back (cold open, then main) with one caption pass on top.

    Each range is its own seeked input, gets its own layout (a face-track crop is computed
    per range), and its audio is padded/trimmed to the range length so concat stays in sync.
    Short fades at each join avoid clicks; audio-less sources get generated silence.

    ``join_style`` (``flash_white``/``dip_black``) adds the cold-open effect at the end of the
    cold open and the start of the body; ``join_sfx_path`` (the checked whoosh file) is one
    more input, mixed at unity gain with its hit on the join. With the defaults the command is
    byte-identical to the one before the transition existed.
    """
    command = ["ffmpeg", "-y"]
    parts: list[str] = []
    last = len(ranges) - 1
    fade = AUDIO_JOIN_FADE_SECONDS
    # The cold open's length exactly as written for -t, in milliseconds: the join's time.
    cold_open_ms = int(f"{ranges[0][1] - ranges[0][0]:.3f}".replace(".", ""))
    for index, (range_start, range_end) in enumerate(ranges):
        length = range_end - range_start
        command.extend(["-ss", f"{range_start:.3f}", "-t", f"{length:.3f}", "-i", str(source)])
        parts.append(f"[{index}:{video_stream_index}]setpts=PTS-STARTPTS[source{index}]")
        layout = _layout_filter(
            source,
            input_label=f"[source{index}]",
            start=range_start,
            end=range_end,
            width=width,
            height=height,
            render_mode=render_mode,
            label_suffix=str(index),
        )
        effect = _join_effect(join_style, index, cold_open_ms, cold_open_join_s)
        parts.append(f"{layout}{effect}[video{index}]")
        audio = (
            f"[{index}:{audio_stream_index}]asetpts=PTS-STARTPTS,apad"
            if audio_stream_index is not None
            else _SILENT_AUDIO
        )
        audio += f",atrim=duration={length:.3f}"
        if index > 0:
            audio += f",afade=t=in:st=0:d={fade:.3f}"
        if index < last:
            audio += f",afade=t=out:st={max(0.0, length - fade):.3f}:d={fade:.3f}"
        parts.append(f"{audio}[audio{index}]")
    pads = "".join(f"[video{index}][audio{index}]" for index in range(len(ranges)))
    if join_sfx_path is None:
        parts.append(f"{pads}concat=n={len(ranges)}:v=1:a=1[joined][audio]")
    else:
        # The whoosh (spec §4.4): its hit (file sample 11 520) on the join, at 48 kHz.
        spec = _transitions.SFX[("whoosh", _transitions.LATEST_SFX["whoosh"])]
        delay = cold_open_ms * 48 - spec.hit_smp
        if delay < 0:
            raise ValueError("the cold open is too short for the sound effect")
        command.extend(["-i", str(join_sfx_path)])
        parts.append(f"{pads}concat=n={len(ranges)}:v=1:a=1[joined][speech]")
        parts.append(f"[speech]{_SFX_FORMAT}[sp]")
        parts.append(f"[{len(ranges)}:a]{_SFX_FORMAT},adelay=delays={delay}S:all=1,apad[wh]")
        parts.append("[sp][wh]amix=inputs=2:normalize=0:duration=first[audio]")
    parts.append(f"[joined]{_CAPTIONS_FILTER}[video]")
    command.extend(["-filter_complex", ";".join(parts), *_ENCODE_ARGUMENTS, output_path])
    return command


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
    cold_open: tuple[float, float] | None = None,
    hook_text: str | None = None,
    hook_duration: float = 4.0,
    caption_style: str = "classic",
    join_style: str = "cut",
    join_sfx: str | None = None,
) -> Path:
    """Render a portrait clip using secure temporary files and no-clobber publication.

    With ``cold_open`` the rendered timeline is the cold-open source range followed by
    ``start``-``end``; captions (and the sidecar ``.srt``) follow that timeline. ``hook_text``
    is shown in the top safe area for the first ``hook_duration`` seconds. ``caption_style``
    is ``"classic"`` or ``"karaoke"`` (word-by-word highlight when word timestamps exist).

    ``join_style`` (``cut``, ``flash_white`` or ``dip_black``) and ``join_sfx`` (``None`` or
    ``"whoosh"``) are the cold-open transition (spec 2026-10-02 §4.3, §4.4); without a cold open
    they change nothing, and with their defaults the command is the one of before.
    """
    if join_style not in _transitions.JOIN_STYLES:
        raise ValueError(f"unknown cold-open join style: {join_style!r}")
    if join_sfx is not None and join_sfx not in _transitions.LATEST_SFX:
        raise ValueError(f"unknown cold-open sound effect: {join_sfx!r}")
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
    validated_cold_open = _validate_cold_open(cold_open, start=start)
    _validate_packaging(hook_text, hook_duration, caption_style)
    sfx_path = None
    if validated_cold_open is not None and join_sfx is not None:
        spec = _transitions.SFX[(join_sfx, _transitions.LATEST_SFX[join_sfx])]
        try:
            sfx_path = _transitions.sfx_file(SFX_RESOURCES_DIR, spec)
        except _edit_errors.RenderFailed as exc:
            raise RuntimeError("cold-open sound effect is missing or changed") from exc

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

        if validated_cold_open is not None and validated_cold_open[1] > source_video_duration:
            raise ValueError(
                f"cold open end {validated_cold_open[1]} exceeds selected source video "
                f"duration {source_video_duration}"
            )

        ranges = (
            ((start, end),) if validated_cold_open is None else (validated_cold_open, (start, end))
        )
        rendered_duration = sum(range_end - range_start for range_start, range_end in ranges)
        cues = build_caption_cues(transcript, ranges)
        subtitle_content = cues_to_srt(cues)
        captions_content = build_ass(
            cues,
            width=width,
            height=height,
            duration=rendered_duration,
            caption_style=caption_style,
            hook_text=hook_text,
            hook_duration=hook_duration,
        )
        render_fd, render_temp = _create_sibling_temp(directory_fd, ".mp4")
        subtitle_fd, subtitle_temp = _create_sibling_temp(directory_fd, ".srt")
        _write_all(subtitle_fd, subtitle_content.encode("utf-8"))

        output_path = f"/proc/self/fd/{render_fd}"
        if validated_cold_open is None:
            command = _single_range_command(
                source,
                start=start,
                end=end,
                layout_filter=_layout_filter(
                    source,
                    input_label=f"[0:{video_stream_index}]",
                    start=start,
                    end=end,
                    width=width,
                    height=height,
                    render_mode=render_mode,
                ),
                audio_stream_index=audio_stream_index,
                output_path=output_path,
            )
        else:
            join_s = None
            if join_style != "cut":
                join_s = _cold_open_join_s(source, video_stream_index, ranges[0][0],
                                           ranges[0][1] - ranges[0][0])
            command = _multi_range_command(
                source,
                ranges=ranges,
                video_stream_index=video_stream_index,
                audio_stream_index=audio_stream_index,
                width=width,
                height=height,
                render_mode=render_mode,
                output_path=output_path,
                join_style=join_style,
                join_sfx_path=sfx_path,
                cold_open_join_s=join_s,
            )
        with tempfile.TemporaryDirectory(prefix="ai-clipper-") as temporary_directory:
            filter_captions_path = Path(temporary_directory) / "captions.ass"
            filter_captions_path.write_text(captions_content, encoding="utf-8")
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
            Path(output_path),
            width=width,
            height=height,
            duration=rendered_duration,
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
