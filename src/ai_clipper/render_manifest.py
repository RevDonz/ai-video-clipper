"""Standalone, fail-closed rendering from a canonical Clip Edit Manifest."""

from __future__ import annotations

import fcntl
import hashlib
import json
import math
import os
import stat
import subprocess
import tempfile
import textwrap
import threading
import uuid
from collections.abc import Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

from .edit_manifest import (
    MAX_EDIT_MANIFEST_BYTES,
    ClipEditManifest,
    EditManifestInvalid,
    LogoOverlay,
    TitleOverlay,
    canonical_manifest_bytes,
    manifest_from_bytes,
    manifest_sha256,
    read_edit_manifest,
)
from .ranking import MAX_ARTIFACT_BYTES, _canonical_source, read_candidates_artifact

_MAX_LOGO_BYTES = 20 * 1024 * 1024
_FONT_MAP = {
    "Inter": "DejaVu Sans",
    "Noto Sans": "DejaVu Sans",
    "DejaVu Sans": "DejaVu Sans",
    "sans-serif": "DejaVu Sans",
}
_CAPTION_PRESET_STYLE = {
    # bold, border style, outline, shadow
    "clean": (0, 3, 2, 0),
    "bold-keyword": (-1, 3, 3, 0),
    "karaoke": (-1, 3, 3, 0),
    "podcast": (-1, 3, 4, 1),
    "minimal": (0, 1, 1, 0),
}
_MAX_RASTER_DIMENSION = 4096
_MAX_RASTER_PIXELS = 16_777_216


class ManifestRenderError(Exception):
    """The renderer could not safely produce a verified artifact."""


class UnsupportedRenderMode(ManifestRenderError):
    """The manifest requests semantics this renderer cannot reproduce."""


class RenderUnsupported(UnsupportedRenderMode):
    """Rendering is impossible without inventing unavailable source semantics."""


class RenderConflict(ManifestRenderError):
    """The no-clobber output target already exists."""


class ManifestRenderTimeout(ManifestRenderError):
    """An FFmpeg or FFprobe child exceeded its deadline."""


@dataclass(frozen=True, slots=True)
class ManifestRenderResult:
    """Non-sensitive description of one verified output."""

    revision: int
    manifest_sha256: str
    output_path: str
    duration: float
    has_audio: bool
    width: int = 720
    height: int = 1280
    video_codec: str = "h264"
    audio_codec: str | None = None

    @property
    def output_file(self) -> str:
        """Backward-readable basename alias; never exposes an absolute path."""
        return self.output_path


def _read_regular(path: Path, limit: int, description: str) -> bytes:
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        raise ManifestRenderError(f"{description} must be a regular non-symlink file") from exc
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise ManifestRenderError(f"{description} must be a bounded regular file")
        chunks: list[bytes] = []
        total = 0
        while total <= limit:
            chunk = os.read(fd, min(65536, limit + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        if total > limit:
            raise ManifestRenderError(f"{description} exceeds its size limit")
        return b"".join(chunks)
    finally:
        os.close(fd)


def _validate_regular(path: Path, description: str) -> None:
    """Validate a potentially large file without reading it into memory."""
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        raise ManifestRenderError(f"{description} must be a regular non-symlink file") from exc
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ManifestRenderError(f"{description} must be a regular non-symlink file")
    finally:
        os.close(fd)


def _validate_directory(path: Path, description: str) -> Path:
    try:
        info = path.lstat()
    except OSError as exc:
        raise ManifestRenderError(f"{description} is invalid") from exc
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise ManifestRenderError(f"{description} is invalid")
    if path.resolve() != path.absolute():
        raise ManifestRenderError(f"{description} is not trusted")
    return path.absolute()


def _load_bound_manifest(manifest_path: Path, candidate_path: Path) -> ClipEditManifest:
    snapshot_match = __import__("re").fullmatch(
        r"candidates\.([0-9a-f]{64})\.json", candidate_path.name
    )
    if candidate_path.name == "candidates.v2.json":
        analysis = _validate_directory(candidate_path.parent, "analysis directory")
    elif snapshot_match is not None and candidate_path.parent.name == "render-inputs":
        _validate_directory(candidate_path.parent, "render inputs directory")
        analysis = _validate_directory(candidate_path.parent.parent, "analysis directory")
    else:
        raise ManifestRenderError("candidate artifact path is invalid")
    edits = analysis / "edits"
    _validate_directory(edits, "edits directory")
    is_current = manifest_path.parent.absolute() == edits
    is_archive = (
        manifest_path.parent.name == "archive" and manifest_path.parent.parent.absolute() == edits
    )
    if not is_current and not is_archive:
        raise ManifestRenderError("manifest path is not an exact current manifest or archive")
    if is_archive:
        _validate_directory(manifest_path.parent, "archive directory")

    raw = _read_regular(manifest_path, MAX_EDIT_MANIFEST_BYTES, "manifest")
    manifest = manifest_from_bytes(raw)
    digest = hashlib.sha256(raw).hexdigest()
    current_name = f"{manifest.identity.candidate_id}.edit.v1.json"
    archive_name = f"{manifest.identity.candidate_id}.edit.v1.r{manifest.revision}.{digest}.json"
    expected_name = current_name if is_current else archive_name
    if manifest_path.name != expected_name or raw != canonical_manifest_bytes(manifest):
        raise ManifestRenderError("manifest path is not an exact canonical manifest revision")

    # This public API locks both current edit state and candidate generation, then
    # revalidates artifact digest, canonical source hash, candidate ID/window/profile.
    if is_current:
        current = read_edit_manifest(analysis, manifest.identity.candidate_id)
        if current != manifest or manifest_sha256(current) != digest:
            raise EditManifestInvalid("manifest changed while preparing render")
        return current

    candidate_raw = _read_regular(candidate_path, MAX_ARTIFACT_BYTES, "candidate artifact")
    if (
        snapshot_match is not None
        and hashlib.sha256(candidate_raw).hexdigest() != snapshot_match[1]
    ):
        raise ManifestRenderError("candidate snapshot content digest mismatch")
    artifact = read_candidates_artifact(candidate_path)
    candidate = next(
        (
            item
            for item in artifact.candidates
            if item.candidate_id == manifest.identity.candidate_id
        ),
        None,
    )
    canonical_source = _canonical_source(artifact.source)
    if (
        candidate is None
        or manifest.identity.candidate_artifact_sha256 != hashlib.sha256(candidate_raw).hexdigest()
        or manifest.identity.source_sha256
        != hashlib.sha256(canonical_source.encode("utf-8")).hexdigest()
        or manifest.identity.selection_version != artifact.selection_version
        or (manifest.identity.candidate_start, manifest.identity.candidate_end)
        != (candidate.start, candidate.end)
        or manifest.identity.profile != candidate.profile.value
    ):
        raise EditManifestInvalid("archived manifest identity does not match candidate artifact")
    return manifest


def _ass_escape(value: str) -> str:
    """Escape user text so libass cannot interpret it as override syntax."""
    return value.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")


def _wrap_lines(value: str, width: int, maximum: int) -> list[str]:
    lines = textwrap.wrap(
        value,
        width=width,
        break_long_words=True,
        break_on_hyphens=False,
        replace_whitespace=True,
        drop_whitespace=True,
    ) or [""]
    if len(lines) <= maximum:
        return lines
    kept = lines[:maximum]
    if width == 1:
        kept[-1] = "…"
    else:
        kept[-1] = kept[-1][: width - 1].rstrip() + "…"
    return kept


def _ass_time(seconds: float) -> str:
    centiseconds = max(0, round(seconds * 100))
    hours, remainder = divmod(centiseconds, 360_000)
    minutes, remainder = divmod(remainder, 6_000)
    whole_seconds, fraction = divmod(remainder, 100)
    return f"{hours}:{minutes:02d}:{whole_seconds:02d}.{fraction:02d}"


def _ass_color(color: str, *, alpha: int = 0) -> str:
    red, green, blue = color[1:3], color[3:5], color[5:7]
    return f"&H{alpha:02X}{blue}{green}{red}"


def _build_ass(manifest: ClipEditManifest) -> str:
    """Build deterministic ASS captions and title events from validated fields."""
    style = manifest.caption_style
    if style.emphasis == "keyword":
        raise RenderUnsupported(
            "keyword emphasis spans are absent from clip-edit-v1; keyword rendering is unsupported"
        )
    safe = manifest.visual.safe_area
    alignment = {"bottom": 2, "center": 5, "top": 8}[style.position]
    background_alpha = round((1.0 - style.background_opacity) * 255)
    margin_v = round(
        manifest.visual.canvas_height
        * ({"top": safe.top, "center": 0.0, "bottom": safe.bottom}[style.position])
    )
    margin_l = round(manifest.visual.canvas_width * safe.left)
    margin_r = round(manifest.visual.canvas_width * safe.right)
    font = _FONT_MAP[style.font_family]
    bold, preset_border_style, outline, shadow = _CAPTION_PRESET_STYLE[style.preset]
    border_style = preset_border_style if style.background_opacity > 0 else 1

    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        "WrapStyle: 2\n"
        "ScaledBorderAndShadow: yes\n"
        "PlayResX: 720\n"
        "PlayResY: 1280\n\n"
        "[V4+ Styles]\n"
        "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,"
        "BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,"
        "BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\n"
        f"Style: Caption,{font},{style.font_size},{_ass_color(style.color)},"
        f"{_ass_color(style.keyword_color)},{_ass_color(style.background_color)},"
        f"{_ass_color(style.background_color, alpha=background_alpha)},"
        f"{bold},0,0,0,100,100,0,0,{border_style},{outline},{shadow},{alignment},"
        f"{margin_l},{margin_r},{margin_v},1\n"
        f"Style: Title,{font},52,{_ass_color(style.color)},{_ass_color(style.color)},"
        f"{_ass_color('#000000')},{_ass_color('#000000', alpha=128)},"
        "-1,0,0,0,100,100,0,0,1,3,1,5,0,0,0,1\n\n"
        "[Events]\n"
        "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n"
    )
    duration = manifest.timeline.end - manifest.timeline.start
    events: list[str] = []
    for cue in manifest.captions:
        lines = _wrap_lines(cue.text, style.max_chars_per_line, style.max_lines)
        escaped = "\\N".join(_ass_escape(line) for line in lines)
        start = cue.start - manifest.timeline.start
        end = cue.end - manifest.timeline.start
        events.append(f"Dialogue: 0,{_ass_time(start)},{_ass_time(end)},Caption,,0,0,0,,{escaped}")
    for overlay in manifest.overlays:
        if isinstance(overlay, TitleOverlay):
            approximate_width = max(4, int(overlay.max_width * 720 / (52 * 0.58)))
            title = "\\N".join(
                _ass_escape(line) for line in _wrap_lines(overlay.text, approximate_width, 3)
            )
            x = round(overlay.x * 720)
            y = round(overlay.y * 1280)
            clip_x1 = round(safe.left * 720)
            clip_y1 = round(safe.top * 1280)
            clip_x2 = round((1 - safe.right) * 720)
            clip_y2 = round((1 - safe.bottom) * 1280)
            events.append(
                f"Dialogue: 1,0:00:00.00,{_ass_time(duration)},Title,,0,0,0,,"
                f"{{\\an5\\pos({x},{y})\\clip({clip_x1},{clip_y1},{clip_x2},{clip_y2})}}"
                f"{title}"
            )
    return header + "\n".join(events) + ("\n" if events else "")


def _layout_filter(manifest: ClipEditManifest) -> str:
    visual = manifest.visual
    if visual.render_mode == "fit-blur":
        return (
            "[0:v]split=2[background][foreground];"
            "[background]scale=720:1280:force_original_aspect_ratio=increase,"
            "crop=720:1280,gblur=sigma=35[blurred];"
            "[foreground]scale=720:1280:force_original_aspect_ratio=decrease[fit];"
            "[blurred][fit]overlay=(W-w)/2:(H-h)/2,setsar=1[base]"
        )
    if visual.render_mode == "face-track":
        raise UnsupportedRenderMode(
            "face-track requires a persisted crop track; silent fallback is forbidden"
        )
    focal_x = 0.5 if visual.focal_x is None else visual.focal_x
    focal_y = 0.5 if visual.focal_y is None else visual.focal_y
    return (
        "[0:v]scale=720:1280:force_original_aspect_ratio=increase,"
        rf"crop=720:1280:x=clip(iw*{focal_x:.6f}-ow/2\,0\,iw-ow):"
        rf"y=clip(ih*{focal_y:.6f}-oh/2\,0\,ih-oh),setsar=1[base]"
    )


def _logo_filter(logo: LogoOverlay) -> str:
    """Contain a raster in the declared centered square footprint."""
    logo_width = round(720 * logo.scale)
    x = round(logo.x * 720)
    y = round(logo.y * 1280)
    return (
        f";[1:v]format=rgba,scale={logo_width}:{logo_width}:"
        "force_original_aspect_ratio=decrease,"
        f"pad={logo_width}:{logo_width}:(ow-iw)/2:(oh-ih)/2:color=black@0,"
        f"colorchannelmixer=aa={logo.opacity:.6f}[logo];"
        f"[captioned][logo]overlay=x={x}-overlay_w/2:y={y}-overlay_h/2:shortest=1[video]"
    )


def _raster_matches(extension: str, data: bytes) -> bool:
    if extension == "png":
        return data.startswith(b"\x89PNG\r\n\x1a\n")
    if extension in {"jpg", "jpeg"}:
        return data.startswith(b"\xff\xd8\xff")
    if extension == "webp":
        return len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    return False


def _load_logo(
    manifest: ClipEditManifest, root: Path | None
) -> tuple[LogoOverlay, bytes, str] | None:
    logo = next((item for item in manifest.overlays if isinstance(item, LogoOverlay)), None)
    if logo is None:
        return None
    if root is None:
        raise ManifestRenderError("logo asset root is required")
    root = _validate_directory(root, "logo asset root")
    assets = _validate_directory(root / "assets", "logo assets directory")
    relative = Path(logo.asset)
    target = root / relative
    if target.parent.absolute() != assets:
        raise ManifestRenderError("logo asset path is invalid")
    data = _read_regular(target, _MAX_LOGO_BYTES, "logo asset")
    extension = target.suffix[1:].lower()
    expected_digest = target.stem
    if hashlib.sha256(data).hexdigest() != expected_digest or not _raster_matches(extension, data):
        raise ManifestRenderError("logo asset hash or raster format is invalid")
    return logo, data, extension


def _verify_raster(path: Path, extension: str, *, timeout: float) -> None:
    result = _execute(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,codec_name,width,height",
            "-of",
            "json",
            str(path),
        ],
        cwd=None,
        timeout=timeout,
    )
    try:
        streams = json.loads(result.stdout)["streams"]
        stream = streams[0]
        expected_codec = {"png": "png", "jpg": "mjpeg", "jpeg": "mjpeg", "webp": "webp"}[extension]
        valid = (
            len(streams) == 1
            and stream["codec_type"] == "video"
            and stream["codec_name"] == expected_codec
            and int(stream["width"]) > 0
            and int(stream["height"]) > 0
            and int(stream["width"]) <= _MAX_RASTER_DIMENSION
            and int(stream["height"]) <= _MAX_RASTER_DIMENSION
            and int(stream["width"]) * int(stream["height"]) <= _MAX_RASTER_PIXELS
        )
    except (KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise ManifestRenderError("logo asset is not a decodable raster") from exc
    if not valid:
        raise ManifestRenderError("logo asset is not a decodable raster")


def _execute(
    argv: Sequence[str],
    *,
    cwd: Path | None,
    timeout: float,
    pass_fds: tuple[int, ...] = (),
) -> subprocess.CompletedProcess[str]:
    """Execute argv without a shell, terminating then killing on timeout."""
    try:
        process = subprocess.Popen(
            list(argv),
            cwd=cwd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            pass_fds=pass_fds,
        )
    except OSError as exc:
        raise ManifestRenderError("media tool could not be started") from exc
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        process.terminate()
        try:
            process.communicate(timeout=min(2.0, timeout))
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
        raise ManifestRenderTimeout("media tool timed out") from exc
    result = subprocess.CompletedProcess(list(argv), process.returncode, stdout, stderr)
    if result.returncode != 0:
        raise ManifestRenderError("FFmpeg/FFprobe process failed")
    return result


def _probe_media(
    path: Path | str, *, timeout: float, pass_fds: tuple[int, ...] = ()
) -> dict[str, Any]:
    result = _execute(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_type,codec_name,width,height,sample_aspect_ratio",
            "-of",
            "json",
            str(path),
        ],
        cwd=None,
        timeout=timeout,
        pass_fds=pass_fds,
    )
    try:
        payload = json.loads(result.stdout)
        duration = float(payload["format"]["duration"])
        streams = payload["streams"]
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise ManifestRenderError("FFprobe returned invalid metadata") from exc
    if not math.isfinite(duration) or duration <= 0 or not isinstance(streams, list):
        raise ManifestRenderError("FFprobe returned invalid metadata")
    video = next((item for item in streams if item.get("codec_type") == "video"), None)
    audio = next((item for item in streams if item.get("codec_type") == "audio"), None)
    return {
        "duration": duration,
        "has_video": video is not None,
        "has_audio": audio is not None,
        "video_codec": None if video is None else video.get("codec_name"),
        "audio_codec": None if audio is None else audio.get("codec_name"),
        "width": None if video is None else video.get("width"),
        "height": None if video is None else video.get("height"),
        "sar": None if video is None else video.get("sample_aspect_ratio"),
    }


def _verify_output(metadata: dict[str, Any], expected_duration: float, require_audio: bool) -> None:
    tolerance = max(0.25, expected_duration * 0.02)
    if (
        not metadata.get("has_video")
        or metadata.get("video_codec") != "h264"
        or metadata.get("width") != 720
        or metadata.get("height") != 1280
        or metadata.get("sar") != "1:1"
        or abs(float(metadata.get("duration", -1)) - expected_duration) > tolerance
    ):
        raise ManifestRenderError("rendered video failed media verification")
    if require_audio:
        if not metadata.get("has_audio") or metadata.get("audio_codec") != "aac":
            raise ManifestRenderError("rendered audio failed media verification")
    elif metadata.get("has_audio"):
        raise ManifestRenderError("render unexpectedly contains audio")


def _fsync_directory(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _stream_sha256_regular(path: Path, description: str) -> str:
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        raise ManifestRenderError(f"{description} must be a regular non-symlink file") from exc
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ManifestRenderError(f"{description} must be a regular non-symlink file")
        digest = hashlib.sha256()
        while chunk := os.read(fd, 1024 * 1024):
            digest.update(chunk)
        return digest.hexdigest()
    finally:
        os.close(fd)


def _sha256_fd(fd: int) -> str:
    os.lseek(fd, 0, os.SEEK_SET)
    digest = hashlib.sha256()
    while chunk := os.read(fd, 1024 * 1024):
        digest.update(chunk)
    os.lseek(fd, 0, os.SEEK_SET)
    return digest.hexdigest()


def _assert_source_binding(
    source: Path,
    source_fd: int,
    candidate_path: Path,
    manifest: ClipEditManifest,
    expected_source_content_sha256: str | None,
) -> None:
    """Bind local identities by path and remote identities by trusted content digest."""
    artifact = read_candidates_artifact(candidate_path)
    canonical = _canonical_source(artifact.source)
    if hashlib.sha256(canonical.encode("utf-8")).hexdigest() != manifest.identity.source_sha256:
        raise EditManifestInvalid("manifest source identity hash does not match candidate artifact")
    parsed = urlsplit(canonical)
    scheme = parsed.scheme.casefold()
    if expected_source_content_sha256 is not None:
        if not isinstance(expected_source_content_sha256, str) or not __import__("re").fullmatch(
            r"[0-9a-f]{64}", expected_source_content_sha256
        ):
            raise ManifestRenderError("source content digest is invalid")
        if _sha256_fd(source_fd) != expected_source_content_sha256:
            raise ManifestRenderError("source content digest mismatch")
    try:
        if scheme == "file" and parsed.netloc in {"", "localhost"}:
            identity_path = Path(unquote(parsed.path))
        elif not parsed.scheme and Path(canonical).is_absolute():
            identity_path = Path(canonical)
        elif scheme in {"http", "https"}:
            if expected_source_content_sha256 is None:
                raise RenderUnsupported("source content digest is required for remote source")
            return
        else:
            raise ValueError
        if identity_path.resolve(strict=True) != source.resolve(strict=True):
            if expected_source_content_sha256 is not None:
                return
            raise ValueError
    except (OSError, ValueError):
        raise RenderUnsupported("source content binding unavailable") from None


_render_thread_lock = threading.RLock()


def _reset_render_lock() -> None:
    global _render_thread_lock
    _render_thread_lock = threading.RLock()


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_reset_render_lock)


@contextmanager
def _output_lock(output: Path):
    lock_path = output.with_name(f"{output.name}.render.lock")
    try:
        fd = os.open(
            lock_path,
            os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK,
            0o600,
        )
    except OSError as exc:
        raise ManifestRenderError("render lock must be a regular non-symlink file") from exc
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ManifestRenderError("render lock must be a regular non-symlink file")
        with _render_thread_lock:
            fcntl.flock(fd, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def render_from_manifest(
    source: Path,
    manifest_path: Path,
    output: Path,
    candidate_artifact_path: Path,
    logo_assets_root: Path | None = None,
    timeout: float = 120.0,
    expected_source_content_sha256: str | None = None,
) -> ManifestRenderResult:
    """Render and no-clobber publish one manifest-bound H.264/AAC portrait MP4."""
    output = Path(output).absolute()
    if output.suffix.lower() != ".mp4":
        raise ManifestRenderError("output must use the .mp4 extension")
    _validate_directory(output.parent, "output directory")
    with _output_lock(output):
        return _render_from_manifest_locked(
            source,
            manifest_path,
            output,
            candidate_artifact_path,
            logo_assets_root,
            timeout,
            expected_source_content_sha256,
        )


def _render_from_manifest_locked(
    source: Path,
    manifest_path: Path,
    output: Path,
    candidate_artifact_path: Path,
    logo_assets_root: Path | None,
    timeout: float,
    expected_source_content_sha256: str | None,
) -> ManifestRenderResult:
    if not isinstance(timeout, (int, float)) or isinstance(timeout, bool):
        raise TypeError("timeout must be a positive finite number")
    timeout = float(timeout)
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("timeout must be a positive finite number")

    source = Path(source).absolute()
    manifest_path = Path(manifest_path).absolute()
    candidate_path = Path(candidate_artifact_path).absolute()
    output = Path(output).absolute()
    manifest = _load_bound_manifest(manifest_path, candidate_path)
    if manifest.visual.render_mode == "face-track":
        raise UnsupportedRenderMode(
            "face-track requires a persisted crop track; silent fallback is forbidden"
        )

    _validate_regular(source, "source")
    if output.suffix.lower() != ".mp4":
        raise ManifestRenderError("output must use the .mp4 extension")
    output_parent = _validate_directory(output.parent, "output directory")
    try:
        output_info = output.lstat()
    except FileNotFoundError:
        pass
    else:
        if stat.S_ISLNK(output_info.st_mode) or not stat.S_ISREG(output_info.st_mode):
            raise ManifestRenderError("output must be a regular non-symlink file")
        raise RenderConflict("output already exists; no-clobber publication refused")
    if source == output or (output.exists() and os.path.samefile(source, output)):
        raise ManifestRenderError("source and output must be different files")

    source_fd = os.open(source, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(source_fd).st_mode):
            raise ManifestRenderError("source must be a regular non-symlink file")
        return _render_opened_source(
            source,
            source_fd,
            manifest,
            candidate_path,
            output,
            output_parent,
            logo_assets_root,
            timeout,
            expected_source_content_sha256,
        )
    finally:
        os.close(source_fd)


def _render_opened_source(
    source: Path,
    source_fd: int,
    manifest: ClipEditManifest,
    candidate_path: Path,
    output: Path,
    output_parent: Path,
    logo_assets_root: Path | None,
    timeout: float,
    expected_source_content_sha256: str | None,
) -> ManifestRenderResult:
    logo_data = _load_logo(manifest, None if logo_assets_root is None else Path(logo_assets_root))
    _assert_source_binding(
        source, source_fd, candidate_path, manifest, expected_source_content_sha256
    )
    source_proc = f"/proc/self/fd/{source_fd}"
    source_metadata = _probe_media(source_proc, timeout=timeout, pass_fds=(source_fd,))
    if not source_metadata["has_video"]:
        raise ManifestRenderError("source has no video stream")
    if manifest.timeline.end > source_metadata["duration"] + 0.001:
        raise ManifestRenderError("candidate window exceeds source duration")

    expected_duration = manifest.timeline.end - manifest.timeline.start
    temporary_output = output_parent / f".{output.name}.{uuid.uuid4()}.tmp.mp4"
    fd = os.open(
        temporary_output,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
        0o600,
    )
    os.close(fd)
    try:
        with tempfile.TemporaryDirectory(prefix="ai-clipper-render-") as temporary:
            work = Path(temporary)
            ass_path = work / "captions.ass"
            ass_fd = os.open(
                ass_path,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
                0o600,
            )
            try:
                ass_bytes = _build_ass(manifest).encode("utf-8")
                offset = 0
                while offset < len(ass_bytes):
                    offset += os.write(ass_fd, ass_bytes[offset:])
                os.fsync(ass_fd)
            finally:
                os.close(ass_fd)

            command = [
                "ffmpeg",
                "-nostdin",
                "-y",
                "-ss",
                f"{manifest.timeline.start:.6f}",
                "-i",
                source_proc,
            ]
            if logo_data is not None:
                _logo, data, extension = logo_data
                logo_path = work / f"logo.{extension}"
                logo_path.write_bytes(data)
                os.chmod(logo_path, 0o600)
                _verify_raster(logo_path, extension, timeout=timeout)
                command.extend(["-loop", "1", "-i", logo_path.name])

            filters = _layout_filter(manifest) + ";[base]ass=filename='captions.ass'[captioned]"
            video_label = "captioned"
            if logo_data is not None:
                logo, _data, _extension = logo_data
                filters += _logo_filter(logo)
                video_label = "video"

            has_audio = bool(source_metadata["has_audio"])
            if has_audio:
                audio_filters = []
                if manifest.audio.gain_db != 0:
                    audio_filters.append(f"volume={manifest.audio.gain_db:.6f}dB")
                if manifest.audio.normalize:
                    audio_filters.append("loudnorm=I=-16:TP=-1.5:LRA=11")
                if audio_filters:
                    filters += ";[0:a]" + ",".join(audio_filters) + "[audio]"

            command.extend(
                [
                    "-t",
                    f"{expected_duration:.6f}",
                    "-filter_complex",
                    filters,
                    "-map",
                    f"[{video_label}]",
                    "-map",
                    "[audio]"
                    if has_audio and (manifest.audio.gain_db != 0 or manifest.audio.normalize)
                    else "0:a?",
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
                    str(temporary_output),
                ]
            )
            _execute(command, cwd=work, timeout=timeout, pass_fds=(source_fd,))

        file_fd = os.open(temporary_output, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
        try:
            os.fsync(file_fd)
        finally:
            os.close(file_fd)
        rendered_metadata = _probe_media(temporary_output, timeout=timeout)
        _verify_output(rendered_metadata, expected_duration, bool(source_metadata["has_audio"]))
        try:
            os.link(temporary_output, output, follow_symlinks=False)
        except FileExistsError:
            raise RenderConflict("output already exists; no-clobber publication refused") from None
        _fsync_directory(output_parent)
        return ManifestRenderResult(
            revision=manifest.revision,
            manifest_sha256=manifest_sha256(manifest),
            output_path=output.name,
            duration=float(rendered_metadata["duration"]),
            has_audio=bool(rendered_metadata["has_audio"]),
            audio_codec="aac" if rendered_metadata["has_audio"] else None,
        )
    finally:
        try:
            temporary_output.unlink()
        except FileNotFoundError:
            pass
