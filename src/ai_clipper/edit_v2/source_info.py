"""``analysis/source.json``: content sha and probe of the job source, written once per job.

Owner: T1.5 (plan §4.1, §2.5, §3.5). The file is ``{content_sha256, probe}`` in canonical JSON
(plan §3.1 encoding), 0600, and is never rewritten: a later code change cannot move a clip id
(clip ids hash the content sha) or the seed's ``base.source``.

``probe`` (``version`` 1) summarises the selected video stream (the default-disposition video
stream that is not cover art, else the first) and audio stream (default, else the first):

* ``w``, ``h``: display size (swapped for a ±90° rotation); ``rotation`` in degrees;
* ``fps_native``: ``r_frame_rate`` reduced, e.g. ``[30000, 1001]`` (``avg_frame_rate`` when the
  packet timestamps follow it instead; ``[30, 1]`` when neither is usable);
* ``vfr``: more than 0.5 % of the frame steps (sorted packet timestamps) deviate from
  ``fps_native`` by more than one time-base tick and 0.5 ms. Matroska files report their nominal
  rate even after frames were dropped, so the rates alone cannot tell;
* ``duration_ms``: the video stream duration (else the container's), rounded up to whole ms;
* ``has_audio``, ``video_stream``, ``audio_stream``, ``video_codec``, ``pix_fmt``, the four
  ``color_*`` tags (or null), ``audio_sample_rate``, ``audio_channels``, ``size_bytes``,
  ``frame_steps`` and ``irregular_frame_steps``.

This module also holds the small file helpers every T1.5 artifact uses: canonical JSON,
bounded no-follow reads, and immutable no-clobber publication (temporary file, fsync, ``link``,
directory fsync; 0600 files in 0700 directories, plan §9.1).
"""

from __future__ import annotations

import errno
import functools
import hashlib
import json
import math
import os
import secrets
import shutil
import stat
import subprocess
from collections.abc import Mapping, Sequence
from decimal import ROUND_CEILING, Decimal, InvalidOperation
from fractions import Fraction
from itertools import pairwise
from pathlib import Path
from typing import Any

SOURCE_INFO_RELATIVE_PATH = Path("analysis") / "source.json"
MAX_SOURCE_INFO_BYTES = 64 * 1024
PROBE_VERSION = 1
FFPROBE_TIMEOUT_S = 120.0
VFR_IRREGULAR_RATIO = Fraction(1, 200)  # more than 0.5 % irregular frame steps
_HASH_CHUNK = 1 << 20
_PROBE_KEYS = frozenset(
    {
        "version", "w", "h", "fps_native", "vfr", "duration_ms", "has_audio", "video_stream",
        "audio_stream", "video_codec", "pix_fmt", "color_space", "color_primaries",
        "color_transfer", "color_range", "rotation", "audio_sample_rate", "audio_channels",
        "size_bytes", "frame_steps", "irregular_frame_steps",
    }
)  # fmt: skip
_STREAM_ENTRIES = (
    "stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,time_base,"
    "duration,duration_ts,pix_fmt,color_space,color_primaries,color_transfer,color_range,"
    "sample_rate,channels:stream_disposition=default,attached_pic:stream_tags=rotate:"
    "stream_side_data=rotation:format=duration"
)


class SourceInfoError(ValueError):
    """The source cannot be read or probed, or an existing ``source.json`` is invalid."""


# --- shared file helpers (T1.5 artifacts) ----------------------------------------------------


def canonical_json(value: Any) -> bytes:
    """Plan §3.1 canonical bytes: sorted keys, no spaces, UTF-8, no NaN/Infinity."""
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode("utf-8")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_regular(path: Path, limit: int) -> bytes:
    """The bytes of a regular file of at most ``limit`` bytes; never follows a final symlink.

    Raises ``FileNotFoundError`` when missing, ``OSError`` for a symlink or a special file and
    ``ValueError`` when the file is larger than ``limit``.
    """
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError as error:
        if error.errno == errno.ENOENT:
            raise FileNotFoundError(errno.ENOENT, "file not found") from None
        raise
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise OSError(errno.EINVAL, "not a regular file")
        if info.st_size > limit:
            raise ValueError("file is larger than allowed")
        chunks: list[bytes] = []
        total = 0
        while total <= limit:
            chunk = os.read(fd, min(_HASH_CHUNK, limit + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        if total > limit:
            raise ValueError("file is larger than allowed")
        return b"".join(chunks)
    finally:
        os.close(fd)


def _fsync_directory(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def ensure_private_dir(path: Path) -> Path:
    """Create ``path`` and its missing parents as 0700 directories; symlinks are refused."""
    path = Path(path)
    missing: list[Path] = []
    current = path
    while True:
        try:
            info = os.lstat(current)
        except FileNotFoundError:
            missing.append(current)
            parent = current.parent
            if parent == current:
                raise
            current = parent
            continue
        if not stat.S_ISDIR(info.st_mode):
            raise NotADirectoryError(errno.ENOTDIR, "not a directory (or a symlink)")
        break
    for directory in reversed(missing):
        try:
            os.mkdir(directory, 0o700)
        except FileExistsError:
            pass
        info = os.lstat(directory)
        if not stat.S_ISDIR(info.st_mode):
            raise NotADirectoryError(errno.ENOTDIR, "not a directory (or a symlink)")
        os.chmod(directory, 0o700)  # mkdir's mode is filtered by the umask
        _fsync_directory(directory.parent)
    return path


def write_immutable(path: Path, data: bytes) -> bool:
    """Publish ``data`` at ``path`` (0600) unless something already exists there.

    Returns True when this call created the file, False when a file, directory or symlink was
    already present (it is left untouched; callers read it back with :func:`read_regular`).
    The content is written to a private temporary file, fsynced, then hard-linked into place,
    so readers see either nothing or the complete bytes.
    """
    if not isinstance(data, bytes):
        raise TypeError("data must be bytes")
    path = Path(path)
    directory = ensure_private_dir(path.parent)
    if os.path.lexists(path):
        return False
    temp = directory / f".{path.name}.{secrets.token_hex(8)}.tmp"
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                 0o600)
    try:
        try:
            view = memoryview(data)
            while view:
                written = os.write(fd, view)
                view = view[written:]
            os.fsync(fd)
        finally:
            os.close(fd)
        try:
            os.link(temp, path, follow_symlinks=False)
        except FileExistsError:
            return False
    finally:
        try:
            os.unlink(temp)
        except FileNotFoundError:
            pass
    _fsync_directory(directory)
    return True


@functools.lru_cache(maxsize=32)
def _cached_sha256(_real: str, _device: int, _inode: int, _size: int, _mtime_ns: int,
                   path: str) -> str:
    digest = hashlib.sha256()
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        while True:
            chunk = os.read(fd, _HASH_CHUNK)
            if not chunk:
                break
            digest.update(chunk)
    finally:
        os.close(fd)
    return digest.hexdigest()


def file_sha256(path: Path) -> str:
    """sha256 of a regular file's bytes (memoised per inode, size and mtime)."""
    path = Path(path)
    info = os.stat(path, follow_symlinks=False)
    if not stat.S_ISREG(info.st_mode):
        raise SourceInfoError("source must be a regular file")
    return _cached_sha256(os.path.realpath(path), info.st_dev, info.st_ino, info.st_size,
                          info.st_mtime_ns, str(path))


# --- frame steps ---------------------------------------------------------------------------------


def frame_step_irregularity(
    pts: Sequence[int], *, time_base: tuple[int, int], fps: tuple[int, int]
) -> tuple[int, int]:
    """``(steps, irregular)`` of the sorted timestamps ``pts`` (in ``time_base`` ticks).

    A step is irregular when it differs from ``1/fps`` by more than one tick and more than
    0.5 ms (so the 33/34 ms steps of 29.97 fps in a millisecond time base are regular), or when
    it is zero (a duplicate timestamp).
    """
    tb_num, tb_den = time_base
    fps_num, fps_den = fps
    if min(tb_num, tb_den, fps_num, fps_den) <= 0:
        raise ValueError("time base and fps must be positive")
    ordered = sorted(pts)
    expected = Fraction(fps_den * tb_den, fps_num * tb_num)  # ticks per frame
    tolerance = max(Fraction(1), Fraction(tb_den, 2000 * tb_num))  # 1 tick, 0.5 ms
    irregular = 0
    for earlier, later in pairwise(ordered):
        step = later - earlier
        if step == 0 or abs(step - expected) > tolerance:
            irregular += 1
    return max(0, len(ordered) - 1), irregular


# --- probe ---------------------------------------------------------------------------------------


def _tool(name: str) -> str:
    path = shutil.which(name)
    if path is None:
        raise SourceInfoError(f"{name} not found")
    return path


def _run_probe(argv: list[str]) -> str:
    try:
        result = subprocess.run(argv, capture_output=True, text=True, check=False,
                                timeout=FFPROBE_TIMEOUT_S, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        raise SourceInfoError("ffprobe timed out") from None
    if result.returncode != 0:
        raise SourceInfoError("ffprobe could not read the source")
    return result.stdout


def _rate(value: object) -> tuple[int, int] | None:
    if not isinstance(value, str) or "/" not in value:
        return None
    num, _, den = value.partition("/")
    try:
        fraction = Fraction(int(num), int(den))
    except (ValueError, ZeroDivisionError):
        return None
    if fraction <= 0 or fraction > 1000:
        return None
    return fraction.numerator, fraction.denominator


def _int_or_none(value: object) -> int | None:
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _text_or_none(value: object) -> str | None:
    if isinstance(value, str) and value and value not in ("unknown", "N/A"):
        return value[:40]
    return None


def _pick(streams: list[dict[str, Any]], kind: str) -> dict[str, Any] | None:
    candidates = [
        stream for stream in streams
        if stream.get("codec_type") == kind
        and not (stream.get("disposition") or {}).get("attached_pic", 0)
    ]
    for stream in candidates:
        if (stream.get("disposition") or {}).get("default", 0):
            return stream
    return candidates[0] if candidates else None


def _rotation(stream: Mapping[str, Any]) -> int:
    for item in stream.get("side_data_list") or ():
        if isinstance(item, dict) and "rotation" in item:
            value = _int_or_none(item["rotation"])
            if value is not None:
                return value % 360
    value = _int_or_none((stream.get("tags") or {}).get("rotate"))
    return 0 if value is None else value % 360


def _seconds_to_ms_ceil(value: object) -> int | None:
    if not isinstance(value, str | int | float) or isinstance(value, bool):
        return None
    try:
        seconds = Decimal(str(value))
    except InvalidOperation:
        return None
    if not seconds.is_finite() or seconds <= 0:
        return None
    return int((seconds * 1000).to_integral_value(rounding=ROUND_CEILING))


def _duration_ms(stream: Mapping[str, Any], container: Mapping[str, Any]) -> int:
    duration = _seconds_to_ms_ceil(stream.get("duration"))
    if duration is None:
        ticks = _int_or_none(stream.get("duration_ts"))
        base = _rate(stream.get("time_base"))
        if ticks is not None and ticks > 0 and base is not None:
            duration = math.ceil(Fraction(ticks * base[0] * 1000, base[1]))
    if duration is None:
        duration = _seconds_to_ms_ceil(container.get("duration"))
    if duration is None:
        raise SourceInfoError("source duration is unknown")
    return duration


def _packet_pts(ffprobe: str, source: Path, index: int) -> list[int]:
    output = _run_probe([
        ffprobe, "-v", "error", "-select_streams", str(index), "-show_entries",
        "packet=pts,dts", "-of", "csv=p=0", str(source),
    ])
    values: list[int] = []
    for line in output.splitlines():
        fields = [field.strip() for field in line.split(",")]
        for field in fields[:2]:
            parsed = _int_or_none(field)
            if parsed is not None:
                values.append(parsed)
                break
    return values


def probe_source(source: Path) -> dict[str, Any]:
    """The ``probe`` object of ``source.json`` (see the module docstring)."""
    source = Path(source)
    try:
        info = os.stat(source)
    except FileNotFoundError:
        raise SourceInfoError("source not found") from None
    if not stat.S_ISREG(info.st_mode):
        raise SourceInfoError("source must be a regular file")
    ffprobe = _tool("ffprobe")
    try:
        document = json.loads(_run_probe([
            ffprobe, "-v", "error", "-show_entries", _STREAM_ENTRIES, "-of", "json", str(source),
        ]))
    except json.JSONDecodeError:
        raise SourceInfoError("ffprobe output is not JSON") from None
    streams = [stream for stream in document.get("streams") or () if isinstance(stream, dict)]
    video = _pick(streams, "video")
    if video is None:
        raise SourceInfoError("source has no video stream")
    audio = _pick(streams, "audio")
    width, height = _int_or_none(video.get("width")), _int_or_none(video.get("height"))
    if not width or not height or width <= 0 or height <= 0:
        raise SourceInfoError("source video size is unknown")
    rotation = _rotation(video)
    if rotation in (90, 270):
        width, height = height, width
    time_base = _rate(video.get("time_base"))
    nominal = _rate(video.get("r_frame_rate"))
    average = _rate(video.get("avg_frame_rate"))
    rate = nominal or average or (30, 1)
    steps = irregular = 0
    if time_base is not None:
        pts = _packet_pts(ffprobe, source, int(video["index"]))
        steps, irregular = frame_step_irregularity(pts, time_base=time_base, fps=rate)
        if irregular and average is not None and average != rate:
            other = frame_step_irregularity(pts, time_base=time_base, fps=average)
            if other[1] < irregular:
                rate, (steps, irregular) = average, other
    vfr = steps > 0 and Fraction(irregular, steps) > VFR_IRREGULAR_RATIO
    return {
        "version": PROBE_VERSION,
        "w": width,
        "h": height,
        "fps_native": [rate[0], rate[1]],
        "vfr": vfr,
        "duration_ms": _duration_ms(video, document.get("format") or {}),
        "has_audio": audio is not None,
        "video_stream": int(video["index"]),
        "audio_stream": None if audio is None else int(audio["index"]),
        "video_codec": _text_or_none(video.get("codec_name")),
        "pix_fmt": _text_or_none(video.get("pix_fmt")),
        "color_space": _text_or_none(video.get("color_space")),
        "color_primaries": _text_or_none(video.get("color_primaries")),
        "color_transfer": _text_or_none(video.get("color_transfer")),
        "color_range": _text_or_none(video.get("color_range")),
        "rotation": rotation,
        "audio_sample_rate": None if audio is None else _int_or_none(audio.get("sample_rate")),
        "audio_channels": None if audio is None else _int_or_none(audio.get("channels")),
        "size_bytes": info.st_size,
        "frame_steps": steps,
        "irregular_frame_steps": irregular,
    }


# --- source.json -----------------------------------------------------------------------------


def _valid_info(value: object) -> bool:
    if type(value) is not dict or set(value) != {"content_sha256", "probe"}:
        return False
    sha = value["content_sha256"]
    probe = value["probe"]
    if not isinstance(sha, str) or len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha):
        return False
    if type(probe) is not dict or not _PROBE_KEYS <= set(probe):
        return False
    fps = probe["fps_native"]
    return (
        all(type(probe[key]) is int and probe[key] > 0 for key in ("w", "h", "duration_ms"))
        and type(probe["vfr"]) is bool
        and type(probe["has_audio"]) is bool
        and type(fps) is list and len(fps) == 2
        and all(type(item) is int and item > 0 for item in fps)
    )


def _read_existing(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(read_regular(path, MAX_SOURCE_INFO_BYTES).decode("utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        raise SourceInfoError("analysis/source.json is unreadable") from None
    if not _valid_info(value):
        raise SourceInfoError("analysis/source.json is invalid")
    return value


def ensure_source_info(job_dir: Path, source: Path) -> dict:
    """Return ``{content_sha256, probe}``, computing and writing it immutably on first use.

    An existing ``analysis/source.json`` is returned as stored (never recomputed or
    rewritten); an invalid one raises :class:`SourceInfoError`. The source must be a regular
    file (not a symlink).
    """
    job_dir = Path(job_dir)
    path = job_dir / SOURCE_INFO_RELATIVE_PATH
    if os.path.lexists(path):
        return _read_existing(path)
    source = Path(source)
    try:
        info = os.lstat(source)
    except FileNotFoundError:
        raise SourceInfoError("source not found") from None
    if not stat.S_ISREG(info.st_mode):
        raise SourceInfoError("source must be a regular file, not a symlink")
    value = {"content_sha256": file_sha256(source), "probe": probe_source(source)}
    if not write_immutable(path, canonical_json(value)):
        return _read_existing(path)  # another prepare won the race
    return value


__all__ = [
    "MAX_SOURCE_INFO_BYTES",
    "SOURCE_INFO_RELATIVE_PATH",
    "SourceInfoError",
    "canonical_json",
    "ensure_private_dir",
    "ensure_source_info",
    "file_sha256",
    "frame_step_irregularity",
    "probe_source",
    "read_regular",
    "sha256_hex",
    "write_immutable",
]
