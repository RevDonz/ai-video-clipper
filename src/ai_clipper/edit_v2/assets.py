"""Job asset store: upload ingest and metadata (plan §9.2, §4.1, §4.2; T3.1).

``python -m ai_clipper.edit_v2.assets`` reads one JSON envelope on stdin (CONTRACTS §5.9):

* ``ingest {jobId, incomingId, kind, mime, name, idempotencyKey}`` normalises the file that
  ``web/lib/asset-upload.mjs`` streamed into the quarantine
  ``analysis/assets/.incoming/<incomingId>`` and stores it; result
  ``{asset: {sha256, kind, mime, w, h, durationMs, lufsC, name}, created}``.
* ``meta {jobId, sha256}``: the same ``asset`` object of a stored asset.

Rules (plan §9.2, one row each):

* **Transport (re-checked).** ``kind`` ``logo`` takes ``image/png|jpeg|webp`` up to 10 MiB,
  ``music`` takes ``audio/mpeg|mp4|wav|ogg|flac`` up to 50 MiB; the display name is at most 80
  code points, NFC, without Cc/Cs characters, reduced to its last path segment (display only:
  it never becomes a path). Per job at most 50 assets and 1 GiB.
* **Quarantine.** The file is opened with ``O_NOFOLLOW`` below real (non-symlink) directories
  and **unlinked at once**: from then on only the open descriptor exists, so the original is
  gone whatever happens next. Leftovers of crashed uploads older than an hour are pruned.
* **Sniff.** The first 64 bytes must match the declared type (:func:`sniff`); SVG, GIF, HEIC/AVIF,
  PDF, fonts, archives, playlists and concat scripts match nothing.
* **Ingest.** Every child is ``prlimit --as=2 GiB --cpu=…`` + FFmpeg/ffprobe, no shell, its own
  session, an allowlisted environment (``PATH``, locale, ``HOME``/``TMPDIR`` = a private
  directory: no secret, E11), the input as ``/proc/self/fd/N``, the demuxer **forced** from the
  sniff (``png_pipe|jpeg_pipe|webp_pipe|mp3|mov|wav|ogg|flac``), ``-enable_drefs 0`` for ``mov``,
  ``-protocol_whitelist file,pipe`` and ``-threads 2``; wall caps image 20 s, audio 60 s (the
  process group is killed at the cap and the upload is refused, never a 5xx); never as root.
  Probe caps: images ≤ 4096 × 4096 and ≤ 16.7 MP (header dimensions are checked in Python
  before anything is spawned, the decompression-bomb case); audio ≤ 15 min (also enforced on the
  decode, whatever the header says), exactly one audio stream, 1–2 channels, no video stream
  other than cover art (dropped).
* **Normalise.** Images: the JPEG EXIF orientation applied (FFmpeg 5.1 ignores it; a bounded
  stdlib reader takes only tag 0x0112) → RGBA PNG ≤ 1024 px on the long edge → ancillary chunks
  stripped (:mod:`png_strip`). Audio: AAC-LC 192k, 48 kHz, stereo with an explicit ``pan``
  (mono to both channels at full gain), deterministic bytes (bitexact, no metadata); then the
  normalised file itself is decoded once for its exact sample count (``astats``; the loop period
  the compiler sees), the integrated loudness and true peak (``ebur128``) and the waveform peaks
  (the words artifact's format: 8-bit min/max pairs, 100 per second, mono 8 kHz).
* **Identity.** ``sha256(normalised bytes)``: ``<sha>.png`` or ``<sha>.m4a`` (+
  ``<sha>.peaks.bin``) and ``<sha>.json``, written tmp → fsync → rename (0600, directories
  0700), the metadata last. The same content is stored once (the first display name is kept).
  The metadata is in document form (``store.load_assets``), extra keys ignored by readers.
* **Idempotency.** ``.receipts/<key>.json`` ``{key, raw_sha256, sha256, at_ms}`` (digests
  only): the same key with the same bytes replays the stored asset without running FFmpeg; with
  other bytes it is ``idempotency_conflict`` (exit 9). The newest 200 receipts are kept.

Failures: :class:`AssetRejected` (exit 3; ``asset_type_unsupported``, ``asset_too_large``,
``asset_rejected`` with a fixed ``ref`` reason, ``asset_quota_exceeded``), ``NotFound`` (4),
``IdempotencyConflict`` (9), usage (2), anything else internal (1). Nothing echoes a path, a
name or FFmpeg's output.
"""

from __future__ import annotations

import array
import contextlib
import fcntl
import hashlib
import json
import math
import os
import re
import secrets
import shutil
import signal
import stat
import struct
import subprocess
import sys
import tempfile
import time
import unicodedata
from collections.abc import Iterator, Mapping, Sequence
from pathlib import Path
from typing import Any

from .errors import (
    EXIT_INTERNAL,
    EXIT_INVALID,
    EXIT_OK,
    EXIT_USAGE,
    EditV2Error,
    IdempotencyConflict,
    NotFound,
    exit_code_for,
    message_id,
)
from .errors import message as _edit_message
from .png_strip import PngError, png_info, strip_png
from .timemap import div_round_half_up

OPS = ("ingest", "meta")
SCHEMA = "potongin.asset/1"
KINDS = {"logo": "image", "music": "audio"}
ALLOWED_TYPES = {
    "logo": ("image/png", "image/jpeg", "image/webp"),
    "music": ("audio/mpeg", "audio/mp4", "audio/wav", "audio/ogg", "audio/flac"),
}
FORMATS = {"image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp",
           "audio/mpeg": "mp3", "audio/mp4": "mp4", "audio/wav": "wav", "audio/ogg": "ogg",
           "audio/flac": "flac"}
DEMUXERS = {"png": "png_pipe", "jpeg": "jpeg_pipe", "webp": "webp_pipe", "mp3": "mp3",
            "mp4": "mov", "wav": "wav", "ogg": "ogg", "flac": "flac"}
IMAGE_CODECS = {"png": "png", "jpeg": "mjpeg", "webp": "webp"}
AUDIO_CODECS = {"mp3": ("mp3",), "mp4": ("aac", "alac", "mp3"), "ogg": ("vorbis", "opus", "flac"),
                "flac": ("flac",), "wav": ()}  # wav: any pcm_*
MAX_UPLOAD_BYTES = {"logo": 10 << 20, "music": 50 << 20}
MAX_ASSETS_PER_JOB = 50
MAX_STORE_BYTES = 1 << 30
MAX_NAME_CHARS = 80
TIME_CAPS_S = {"image": 20.0, "audio": 60.0}
RLIMIT_AS_BYTES = 2 << 30
FFMPEG_THREADS = 2
MAX_IMAGE_SIDE = 4096
MAX_IMAGE_PIXELS = 4096 * 4096
NORMALISED_MAX_SIDE = 1024
MAX_AUDIO_MS = 15 * 60_000
MIN_AUDIO_MS = 100
AAC_TAIL_MS = 25  # the decoder's last AAC frame may carry up to 1,023 padding samples (21 ms)
MAX_CHANNELS = 2
SAMPLE_RATE = 48_000
AUDIO_BITRATE = "192k"
PEAKS_PER_SEC = 100
PEAKS_RATE = 8000
RECEIPTS_KEEP = 200
INCOMING_MAX_AGE_S = 3600
MAX_META_BYTES = 64 << 10
MAX_ENVELOPE_BYTES = 16 << 10
HEADER_BYTES = 256 << 10
STDERR_TAIL_BYTES = 256 << 10
REASONS = frozenset({"empty", "dimensions", "duration", "short", "streams", "channels", "codec",
                     "probe", "decode", "timeout"})

ASSET_CODES = {
    "asset_type_unsupported": ("Jenis file tidak didukung. Logo: PNG, JPEG atau WebP. Musik: MP3, "
                               "M4A, WAV, OGG atau FLAC."),
    "asset_too_large": "File terlalu besar (logo maksimal 10 MB, musik maksimal 50 MB)",
    "asset_rejected": ("File tidak bisa dibaca atau tidak aman diproses; simpan ulang file-nya lalu "
                       "unggah lagi"),
    "asset_quota_exceeded": "Batas file untuk job ini tercapai (maksimal 50 file dan 1 GB)",
}

_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
_SHA = re.compile(r"[0-9a-f]{64}")
_STORE_FILE = re.compile(r"([0-9a-f]{64})\.(png|m4a|json|peaks\.bin)")
_RECEIPT = re.compile(r"([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})"
                      r"\.json")
_SAMPLES = re.compile(r"Number of samples:\s*([0-9]+)")
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_HEIF_BRANDS = frozenset({b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"mif1", b"msf1",
                          b"avif", b"avis", b"heif"})
_NEW_FILE = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC
_FIELDS = {"ingest": ("jobId", "incomingId", "kind", "mime", "name", "idempotencyKey"),
           "meta": ("jobId", "sha256")}


class AssetRejected(EditV2Error):
    """The upload is refused (exit 3); ``ref`` is a fixed reason from :data:`REASONS` or None."""

    default_code = "asset_rejected"
    http_status = 422
    exit_code = EXIT_INVALID


def message(code: str) -> str:
    """The Indonesian message of an asset code (else the edit_v2 message of ``code``)."""
    return ASSET_CODES[code] if code in ASSET_CODES else _edit_message(code)


def _reject(ref: str | None = None, code: str = "asset_rejected") -> AssetRejected:
    return AssetRejected(code, ref=ref if ref in REASONS else None)


# --- pure rules ------------------------------------------------------------------------------------


def _id3(head: bytes) -> bool:
    return (len(head) >= 10 and head[:3] == b"ID3" and head[3] in (2, 3, 4) and head[4] != 0xFF
            and all(byte < 0x80 for byte in head[6:10]))


def _mpeg_layer3(head: bytes) -> bool:
    if len(head) < 4 or head[0] != 0xFF or head[1] & 0xE0 != 0xE0:
        return False
    version, layer = (head[1] >> 3) & 3, (head[1] >> 1) & 3
    bitrate, rate = head[2] >> 4, (head[2] >> 2) & 3
    return version != 1 and layer == 1 and 1 <= bitrate <= 14 and rate != 3


def sniff(head: bytes) -> str | None:
    """The format of a file from its first 64 bytes, or None (plan §9.2 "Sniff")."""
    head = bytes(head[:64])
    if head.startswith(_PNG_SIGNATURE) and head[12:16] == b"IHDR":
        return "png"
    if len(head) >= 4 and head[:3] == b"\xff\xd8\xff" and 0xC0 <= head[3] <= 0xFE:
        return "jpeg"
    if len(head) >= 16 and head[:4] == b"RIFF" and head[8:12] == b"WEBP" \
            and head[12:16] in (b"VP8 ", b"VP8L", b"VP8X"):
        return "webp"
    if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "wav"
    if len(head) >= 12 and head[4:8] == b"ftyp" and 12 <= int.from_bytes(head[:4], "big") <= 1024 \
            and head[8:12] not in _HEIF_BRANDS:
        return "mp4"
    if len(head) >= 5 and head[:4] == b"OggS" and head[4] == 0:
        return "ogg"
    if head[:4] == b"fLaC":
        return "flac"
    if _id3(head) or _mpeg_layer3(head):
        return "mp3"
    return None


def check_declared(kind: str, mime: str, head: bytes) -> str:
    """The sniffed format when ``mime`` is allowed for ``kind`` and matches the content."""
    if mime not in ALLOWED_TYPES.get(kind, ()):
        raise _reject(code="asset_type_unsupported")
    fmt = sniff(head)
    if fmt is None or fmt != FORMATS[mime]:
        raise _reject(code="asset_type_unsupported")
    return fmt


def normalise_name(value: object) -> str | None:
    """The display name: last path segment, NFC, outer spaces removed; None when empty.

    Raises ``ValueError`` for a non-string, a Cc/Cs character anywhere or more than 80 code
    points. ``web/lib/asset-upload.mjs`` (``normaliseAssetName``) applies the same rule.
    """
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("the name must be a string")  # noqa: TRY004 - one error for any bad name
    if any(unicodedata.category(char) in ("Cc", "Cs") for char in value):
        raise ValueError("the name holds a control character")
    base = unicodedata.normalize("NFC", re.split(r"[/\\]", value)[-1]).strip(" ")
    if base in ("", ".", ".."):
        return None
    if len(base) > MAX_NAME_CHARS:
        raise ValueError("the name is too long")
    return base


def _tiff_orientation(tiff: bytes) -> int:
    if tiff[:4] == b"II*\x00":
        order = "<"
    elif tiff[:4] == b"MM\x00*":
        order = ">"
    else:
        return 1
    (offset,) = struct.unpack_from(order + "I", tiff, 4)
    if offset < 8 or offset + 2 > len(tiff):
        return 1
    (count,) = struct.unpack_from(order + "H", tiff, offset)
    count = min(count, (len(tiff) - offset - 2) // 12)
    for index in range(count):
        entry = offset + 2 + 12 * index
        tag, kind, number = struct.unpack_from(order + "HHI", tiff, entry)
        if tag == 0x0112:
            if kind != 3 or number != 1:
                return 1
            (value,) = struct.unpack_from(order + "H", tiff, entry + 8)
            return value if 1 <= value <= 8 else 1
    return 1


def _jpeg_segments(data: bytes) -> Iterator[tuple[int, bytes]]:
    """``(marker, payload)`` of the JPEG header segments up to the first scan (bounded)."""
    if data[:2] != b"\xff\xd8":
        return
    position, end = 2, len(data)
    while position + 4 <= end:
        if data[position] != 0xFF:
            return
        marker = data[position + 1]
        if marker == 0xFF:  # fill byte
            position += 1
            continue
        if marker == 0x01 or 0xD0 <= marker <= 0xD8:  # standalone markers
            position += 2
            continue
        if marker in (0xD9, 0xDA):  # end of image, start of scan: no header after this
            return
        (length,) = struct.unpack_from(">H", data, position + 2)
        if length < 2 or position + 2 + length > end:
            return
        yield marker, data[position + 4:position + 2 + length]
        position += 2 + length


def jpeg_orientation(data: bytes) -> int:
    """The EXIF Orientation (1–8) of a JPEG; 1 when absent or malformed (never raises)."""
    try:
        for marker, payload in _jpeg_segments(bytes(data)):
            if marker == 0xE1 and payload[:6] == b"Exif\x00\x00":
                return _tiff_orientation(payload[6:])
    except (IndexError, ValueError, struct.error):
        return 1
    return 1


_ORIENTATION_FILTERS = {1: (), 2: ("hflip",), 3: ("hflip", "vflip"), 4: ("vflip",),
                        5: ("transpose=0",), 6: ("transpose=1",), 7: ("transpose=3",),
                        8: ("transpose=2",)}


def orientation_filters(orientation: int) -> tuple[str, ...]:
    """The FFmpeg filters that display an image stored with EXIF ``orientation``."""
    return _ORIENTATION_FILTERS.get(orientation, ())


def oriented_size(width: int, height: int, orientation: int) -> tuple[int, int]:
    return (height, width) if orientation in (5, 6, 7, 8) else (width, height)


def normalised_size(width: int, height: int, limit: int = NORMALISED_MAX_SIDE) -> tuple[int, int]:
    """The size with the long edge at most ``limit`` (aspect kept, half up, at least 1 px)."""
    if max(width, height) <= limit:
        return width, height
    if width >= height:
        return limit, max(1, div_round_half_up(height * limit, width))
    return max(1, div_round_half_up(width * limit, height)), limit


def header_size(fmt: str, data: bytes) -> tuple[int, int] | None:
    """Image dimensions from the header bytes alone (no decode), or None when not found."""
    data = bytes(data)
    try:
        if fmt == "png":
            if data.startswith(_PNG_SIGNATURE) and data[12:16] == b"IHDR" and len(data) >= 24:
                return struct.unpack_from(">II", data, 16)
        elif fmt == "jpeg":
            for marker, payload in _jpeg_segments(data):
                if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC) and len(payload) >= 5:
                    height, width = struct.unpack_from(">HH", payload, 1)
                    return width, height
        elif fmt == "webp" and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            chunk = data[12:16]
            if chunk == b"VP8X" and len(data) >= 30:
                return (1 + int.from_bytes(data[24:27], "little"),
                        1 + int.from_bytes(data[27:30], "little"))
            if chunk == b"VP8L" and len(data) >= 25 and data[20] == 0x2F:
                bits = int.from_bytes(data[21:25], "little")
                return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
            if chunk == b"VP8 " and len(data) >= 30 and data[23:26] == b"\x9d\x01\x2a":
                width, height = struct.unpack_from("<HH", data, 26)
                return width & 0x3FFF, height & 0x3FFF
    except struct.error:
        return None
    return None


def _check_image_size(width: object, height: object) -> None:
    """``probe`` when the size is unreadable (a truncated or malformed image), ``dimensions``
    only when it is readable and over the caps (the message then says "too large")."""
    if type(width) is not int or type(height) is not int or width < 1 or height < 1:
        raise _reject("probe")
    if width > MAX_IMAGE_SIDE or height > MAX_IMAGE_SIDE or width * height > MAX_IMAGE_PIXELS:
        raise _reject("dimensions")


# --- children ------------------------------------------------------------------------------------


def child_env(work: Path) -> dict[str, str]:
    """The environment of an ingest child: an allowlist, nothing of the parent's (E11)."""
    return {"PATH": os.environ.get("PATH", os.defpath), "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
            "HOME": str(work), "TMPDIR": str(work)}


def _tool(name: str, env: Mapping[str, str]) -> str:
    path = shutil.which(name, path=env["PATH"])
    if path is None:
        raise EditV2Error("internal_error", ref=name)
    return path


def _spawn(argv: Sequence[str], *, work: Path, deadline: float, pass_fds: Sequence[int] = (),
           capture: bool = False) -> tuple[int, bytes, str]:
    """Run ``argv`` (``argv[0]`` a tool name) under prlimit in its own session; returns
    ``(returncode, stdout, stderr tail)``. At the deadline the whole group is killed and the
    upload refused (``timeout``)."""
    if os.geteuid() == 0:
        raise EditV2Error("internal_error", ref="root")  # never parse untrusted media as root
    env = child_env(work)
    prlimit = _tool("prlimit", env)
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise _reject("timeout")
    cpu = max(1, math.ceil(remaining * FFMPEG_THREADS) + 1)
    full = [prlimit, f"--as={RLIMIT_AS_BYTES}:{RLIMIT_AS_BYTES}", f"--cpu={cpu}:{cpu}", "--",
            _tool(argv[0], env), *argv[1:]]
    log = work / f"stderr-{secrets.token_hex(4)}.log"
    with open(log, "wb") as err:
        try:
            process = subprocess.Popen(
                full, cwd=work, env=env, stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE if capture else subprocess.DEVNULL, stderr=err,
                pass_fds=tuple(pass_fds), start_new_session=True, close_fds=True)
        except OSError as exc:
            raise EditV2Error("internal_error", ref="spawn") from exc
        try:
            out, _ = process.communicate(timeout=remaining)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(process.pid, signal.SIGKILL)
            process.communicate()
            raise _reject("timeout") from None
        except BaseException:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            raise
    size = log.stat().st_size
    with open(log, "rb") as handle:
        handle.seek(max(0, size - STDERR_TAIL_BYTES))
        tail = handle.read().decode("utf-8", "replace")
    return process.returncode, out or b"", tail


def _input_args(fmt: str, fd: int | None = None, path: Path | None = None) -> list[str]:
    options = ["-protocol_whitelist", "file,pipe"]
    if DEMUXERS[fmt] == "mov":
        options += ["-enable_drefs", "0"]
    target = f"/proc/self/fd/{fd}" if fd is not None else str(path)
    return [*options, "-f", DEMUXERS[fmt], "-i", target]


def _probe(fmt: str, fd: int, *, work: Path, deadline: float, entries: str) -> dict:
    code, out, _ = _spawn(["ffprobe", "-v", "error", "-hide_banner", *_input_args(fmt, fd),
                           "-show_entries", entries, "-of", "json"],
                          work=work, deadline=deadline, pass_fds=(fd,), capture=True)
    if code != 0:
        raise _reject("probe")
    try:
        value = json.loads(out.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise _reject("probe") from None
    if not isinstance(value, dict) or not isinstance(value.get("streams"), list):
        raise _reject("probe")
    return value


# --- images ----------------------------------------------------------------------------------------


def _normalise_image(fd: int, fmt: str, head: bytes, *, work: Path, deadline: float
                     ) -> tuple[bytes, dict]:
    found = header_size(fmt, head)
    if found is not None:  # the decompression-bomb header is refused before anything runs
        _check_image_size(*found)
    probed = _probe(fmt, fd, work=work, deadline=deadline,
                    entries="stream=index,codec_type,codec_name,width,height")
    streams = probed["streams"]
    if len(streams) != 1 or not isinstance(streams[0], dict):
        raise _reject("streams")
    stream = streams[0]
    if stream.get("codec_type") != "video" or stream.get("codec_name") != IMAGE_CODECS[fmt]:
        raise _reject("codec")
    width, height = stream.get("width"), stream.get("height")
    _check_image_size(width, height)
    orientation = jpeg_orientation(head) if fmt == "jpeg" else 1
    shown = oriented_size(width, height, orientation)
    target_w, target_h = normalised_size(*shown)
    scale = (f"scale={target_w}:{target_h}"
             ":flags=lanczos+accurate_rnd+full_chroma_int+full_chroma_inp")
    chain = [*orientation_filters(orientation), scale, "format=rgba"]
    output = work / "image.png"
    code, _, _ = _spawn(["ffmpeg", "-nostdin", "-hide_banner", "-nostats", "-loglevel", "error",
                         "-threads", str(FFMPEG_THREADS), "-noautorotate", *_input_args(fmt, fd),
                         "-frames:v", "1", "-vf", ",".join(chain), "-threads", str(FFMPEG_THREADS),
                         "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact",
                         "-f", "image2", "-update", "1", "-c:v", "png", "-pix_fmt", "rgba",
                         str(output)],
                        work=work, deadline=deadline, pass_fds=(fd,))
    if code != 0 or not output.is_file():
        raise _reject("decode")
    try:
        media = strip_png(output.read_bytes())
        info = png_info(media)
    except (OSError, PngError):
        raise _reject("decode") from None
    if (info.width, info.height, info.color_type, info.bit_depth) != (target_w, target_h, 6, 8):
        raise _reject("decode")
    meta = {"kind": "image", "mime": "image/png", "w": target_w, "h": target_h,
            "source": {"format": fmt, "w": width, "h": height, "orientation": orientation}}
    return media, meta


# --- music -----------------------------------------------------------------------------------------


def _audio_stream(fmt: str, probed: dict) -> dict:
    audio, other_video = [], []
    for stream in probed["streams"]:
        if not isinstance(stream, dict):
            raise _reject("probe")
        if stream.get("codec_type") == "audio":
            audio.append(stream)
        elif stream.get("codec_type") == "video":
            disposition = stream.get("disposition")
            if not (isinstance(disposition, dict) and disposition.get("attached_pic") == 1):
                other_video.append(stream)
    if len(audio) != 1 or other_video:
        raise _reject("streams")
    stream = audio[0]
    codec = stream.get("codec_name")
    allowed = AUDIO_CODECS[fmt]
    if not isinstance(codec, str) or not (codec in allowed or (fmt == "wav"
                                                               and codec.startswith("pcm_"))):
        raise _reject("codec")
    channels = stream.get("channels")
    if type(channels) is not int or channels < 1:
        raise _reject("probe")
    if channels > MAX_CHANNELS:
        raise _reject("channels")
    try:
        rate = int(stream.get("sample_rate"))
    except (TypeError, ValueError):
        raise _reject("probe") from None
    if not 1 <= rate <= 768_000 or type(stream.get("index")) is not int:
        raise _reject("probe")
    duration = (probed.get("format") or {}).get("duration") if isinstance(
        probed.get("format"), dict) else None
    if duration not in (None, "N/A"):
        try:
            seconds = float(duration)
        except (TypeError, ValueError):
            raise _reject("probe") from None
        if not math.isfinite(seconds) or seconds * 1000 > MAX_AUDIO_MS + AAC_TAIL_MS:
            raise _reject("duration")
    return stream


def _seconds(ms: int) -> str:
    return f"{ms // 1000}.{ms % 1000:03d}"


def _normalise_audio(fd: int, fmt: str, *, work: Path, deadline: float
                     ) -> tuple[bytes, dict, bytes]:
    from .loudness import parse_ebur128
    from .peaks import peaks_from_pcm

    probed = _probe(fmt, fd, work=work, deadline=deadline,
                    entries="stream=index,codec_type,codec_name,channels,sample_rate"
                            ":stream_disposition=attached_pic:format=duration")
    stream = _audio_stream(fmt, probed)
    right = "c0" if stream["channels"] == 1 else "c1"
    output = work / "music.m4a"
    cap = _seconds(MAX_AUDIO_MS + 500)  # the decode stops here whatever the header claims
    code, _, _ = _spawn(["ffmpeg", "-nostdin", "-hide_banner", "-nostats", "-loglevel", "error",
                         "-threads", str(FFMPEG_THREADS), *_input_args(fmt, fd),
                         "-map", f"0:{stream['index']}", "-vn", "-sn", "-dn", "-t", cap,
                         "-af", f"pan=stereo|c0=c0|c1={right},aresample={SAMPLE_RATE}",
                         "-c:a", "aac", "-profile:a", "aac_low", "-b:a", AUDIO_BITRATE,
                         "-ar", str(SAMPLE_RATE), "-ac", "2", "-threads", str(FFMPEG_THREADS),
                         "-map_metadata", "-1", "-map_chapters", "-1", "-fflags", "+bitexact",
                         "-flags:a", "+bitexact", "-movflags", "+faststart", "-f", "mp4",
                         str(output)],
                        work=work, deadline=deadline, pass_fds=(fd,))
    if code != 0 or not output.is_file() or output.stat().st_size == 0:
        raise _reject("decode")
    raw_peaks = work / "peaks.raw"
    graph = ("[0:a:0]asplit=3[m][c][p];"
             "[m]aformat=sample_fmts=dbl,ebur128=peak=true:framelog=verbose[mo];"
             "[c]astats=measure_overall=Number_of_samples:measure_perchannel=none[co];"
             f"[p]pan=mono|c0=0.5*c0+0.5*c1,aresample={PEAKS_RATE}[po]")
    code, _, tail = _spawn(["ffmpeg", "-nostdin", "-hide_banner", "-nostats", "-loglevel", "info",
                            "-threads", str(FFMPEG_THREADS), *_input_args("mp4", path=output),
                            "-filter_complex", graph, "-map", "[mo]", "-f", "null", "-",
                            "-map", "[co]", "-f", "null", "-", "-map", "[po]", "-c:a",
                            "pcm_s16le", "-f", "s16le", str(raw_peaks)],
                           work=work, deadline=deadline)
    counts = _SAMPLES.findall(tail)
    if code != 0 or not counts:
        raise _reject("decode")
    samples = int(counts[-1])
    duration_ms = samples * 1000 // SAMPLE_RATE
    if duration_ms > MAX_AUDIO_MS + AAC_TAIL_MS:
        raise _reject("duration")
    if duration_ms < MIN_AUDIO_MS:
        raise _reject("short")
    try:
        loudness = parse_ebur128(tail)
    except EditV2Error:
        raise _reject("decode") from None
    pcm = array.array("h")
    data = raw_peaks.read_bytes() if raw_peaks.is_file() else b""
    pcm.frombytes(data[: len(data) - len(data) % 2])
    if sys.byteorder != "little":
        pcm.byteswap()
    bins = -(-duration_ms * PEAKS_PER_SEC // 1000)
    peaks = peaks_from_pcm(pcm, bins=bins, samples_per_bin=PEAKS_RATE // PEAKS_PER_SEC)
    meta = {"kind": "audio", "mime": "audio/mp4", "duration_ms": duration_ms,
            "lufs_c": loudness.i_clufs, "tp_cdb": loudness.tp_cdb, "samples": samples,
            "peaks": {"per_sec": PEAKS_PER_SEC, "start_ms": 0, "bins": bins},
            "source": {"format": fmt, "codec": stream["codec_name"],
                       "channels": stream["channels"], "sample_rate": int(stream["sample_rate"])}}
    return output.read_bytes(), meta, peaks


# --- the store -------------------------------------------------------------------------------------


def _real_dir(path: Path) -> Path:
    try:
        info = path.lstat()
    except (FileNotFoundError, NotADirectoryError):
        raise NotFound() from None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise NotFound()
    return path


def _ensure_dir(path: Path) -> Path:
    with contextlib.suppress(FileExistsError):
        path.mkdir(mode=0o700)
    return _real_dir(path)


def _job_dir(jobs_root: str | os.PathLike | None, job_id: str) -> Path:
    if jobs_root is None or str(jobs_root) == "":
        raise EditV2Error("internal_error")
    try:
        root = Path(jobs_root).resolve(strict=True)
    except OSError:
        raise EditV2Error("internal_error") from None
    return _real_dir(root / job_id)


def store_dir(job_dir: Path, *, create: bool = False) -> Path:
    """``<job>/analysis/assets`` (every level a real directory; created 0700 on request)."""
    analysis = _real_dir(Path(job_dir) / "analysis")
    target = analysis / "assets"
    return _ensure_dir(target) if create else _real_dir(target)


@contextlib.contextmanager
def _locked(directory: Path) -> Iterator[None]:
    fd = os.open(directory / ".lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def _read_small(path: Path, limit: int = MAX_META_BYTES) -> bytes | None:
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    except (FileNotFoundError, NotADirectoryError):
        return None
    except OSError:
        return None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            return None
        return os.read(fd, limit + 1)[:limit]
    finally:
        os.close(fd)


def _canonical(value: Mapping[str, Any]) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def _write_atomic(directory: Path, name: str, data: bytes) -> None:
    temporary = directory / f".{name}.{secrets.token_hex(8)}.tmp"
    fd = os.open(temporary, _NEW_FILE, 0o600)
    try:
        view = memoryview(data)
        while view:
            view = view[os.write(fd, view):]
        os.fsync(fd)
    except BaseException:
        os.close(fd)
        with contextlib.suppress(OSError):
            temporary.unlink()
        raise
    os.close(fd)
    os.replace(temporary, directory / name)


def _fsync_dir(directory: Path) -> None:
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _media_name(sha: str, kind: str) -> str:
    return f"{sha}.png" if kind == "image" else f"{sha}.m4a"


def _stored(directory: Path, sha: str) -> dict | None:
    """The stored metadata of ``sha`` when it and its media file are intact, else None."""
    raw = _read_small(directory / f"{sha}.json")
    if raw is None:
        return None
    try:
        meta = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(meta, dict) or meta.get("kind") not in ("image", "audio"):
        return None
    try:
        info = (directory / _media_name(sha, meta["kind"])).lstat()
    except OSError:
        return None
    if not stat.S_ISREG(info.st_mode):
        return None
    return meta


def _dto(sha: str, meta: Mapping[str, Any]) -> dict:
    image = meta["kind"] == "image"
    name = meta.get("name")
    return {"sha256": sha, "kind": "logo" if image else "music", "mime": meta["mime"],
            "w": meta["w"] if image else None, "h": meta["h"] if image else None,
            "durationMs": None if image else meta["duration_ms"],
            "lufsC": None if image else meta["lufs_c"],
            "name": name if isinstance(name, str) else None}


def _usage(directory: Path) -> tuple[int, int]:
    count = used = 0
    with os.scandir(directory) as entries:
        for entry in entries:
            match = _STORE_FILE.fullmatch(entry.name)
            if match is None or not entry.is_file(follow_symlinks=False):
                continue
            used += entry.stat(follow_symlinks=False).st_size
            count += match.group(2) == "json"
    return count, used


def _prune_incoming(incoming: Path, now: float) -> None:
    with os.scandir(incoming) as entries:
        for entry in entries:
            if _UUID.fullmatch(entry.name) is None:
                continue
            with contextlib.suppress(OSError):
                info = entry.stat(follow_symlinks=False)
                if not stat.S_ISDIR(info.st_mode) and now - info.st_mtime > INCOMING_MAX_AGE_S:
                    os.unlink(entry.path)


def _receipt(receipts: Path, key: str) -> dict | None:
    raw = _read_small(receipts / f"{key}.json", 4096)
    if raw is None:
        return None
    try:
        value = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(value, dict) or value.get("key") != key:
        return None
    return value


def _prune_receipts(receipts: Path) -> None:
    items = []
    with os.scandir(receipts) as entries:
        for entry in entries:
            match = _RECEIPT.fullmatch(entry.name)
            if match is None:
                continue
            value = _receipt(receipts, match.group(1))
            at = value.get("at_ms") if value else None
            items.append((at if type(at) is int else -1, entry.name))
    items.sort(reverse=True)
    for _at, name in items[RECEIPTS_KEEP:]:
        with contextlib.suppress(OSError):
            os.unlink(receipts / name)


def _hash_fd(fd: int) -> str:
    digest = hashlib.sha256()
    offset = 0
    while True:
        chunk = os.pread(fd, 1 << 20, offset)
        if not chunk:
            return digest.hexdigest()
        digest.update(chunk)
        offset += len(chunk)


def _open_incoming(incoming: Path, incoming_id: str) -> int:
    try:
        fd = os.open(incoming / incoming_id, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
                     | os.O_NONBLOCK)
    except OSError:
        raise NotFound() from None
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise NotFound()
    return fd


def ingest(job_dir: Path, incoming_id: str, *, kind: str, mime: str, name: str | None,
           idempotency_key: str, now_ms: int) -> dict:
    """Normalise and store the quarantined upload ``incoming_id`` (see the module text)."""
    started = time.monotonic()
    directory = store_dir(job_dir, create=True)
    incoming = _real_dir(directory / ".incoming")
    fd = _open_incoming(incoming, incoming_id)
    try:
        with contextlib.suppress(OSError):
            os.unlink(incoming / incoming_id)  # only the descriptor is left from here on
        size = os.fstat(fd).st_size
        if size == 0:
            raise _reject("empty")
        if size > MAX_UPLOAD_BYTES[kind]:
            raise _reject(code="asset_too_large")
        head = os.pread(fd, HEADER_BYTES, 0)
        fmt = check_declared(kind, mime, head[:64])
        raw_sha = _hash_fd(fd)
        receipts = _ensure_dir(directory / ".receipts")
        with _locked(directory):
            _prune_incoming(incoming, time.time())
            receipt = _receipt(receipts, idempotency_key)
            if receipt is not None:
                if receipt.get("raw_sha256") != raw_sha:
                    raise IdempotencyConflict()
                sha = receipt.get("sha256")
                meta = _stored(directory, sha) if isinstance(sha, str) and _SHA.fullmatch(sha) \
                    else None
                if meta is not None:
                    return {"asset": _dto(sha, meta), "created": False}
        work = Path(tempfile.mkdtemp(prefix="edit-v2-asset-"))
        try:
            os.chmod(work, 0o700)
            deadline = started + TIME_CAPS_S[KINDS[kind]]
            peaks = None
            if kind == "logo":
                media, meta = _normalise_image(fd, fmt, head, work=work, deadline=deadline)
            else:
                media, meta, peaks = _normalise_audio(fd, fmt, work=work, deadline=deadline)
        finally:
            shutil.rmtree(work, ignore_errors=True)
        sha = hashlib.sha256(media).hexdigest()
        with _locked(directory):
            existing = _stored(directory, sha)
            created = existing is None
            if created:
                meta.update({"schema": SCHEMA, "name": name, "bytes": len(media),
                             "created_at_ms": now_ms})
                meta_bytes = _canonical(meta)
                extra = len(media) + len(meta_bytes) + (len(peaks) if peaks is not None else 0)
                count, used = _usage(directory)
                if count + 1 > MAX_ASSETS_PER_JOB or used + extra > MAX_STORE_BYTES:
                    raise _reject(code="asset_quota_exceeded")
                _write_atomic(directory, _media_name(sha, meta["kind"]), media)
                if peaks is not None:
                    _write_atomic(directory, f"{sha}.peaks.bin", peaks)
                _write_atomic(directory, f"{sha}.json", meta_bytes)
                existing = meta
            _write_atomic(receipts, f"{idempotency_key}.json", _canonical(
                {"key": idempotency_key, "raw_sha256": raw_sha, "sha256": sha, "at_ms": now_ms}))
            _prune_receipts(receipts)
            _fsync_dir(directory)
            _fsync_dir(receipts)
        return {"asset": _dto(sha, existing), "created": created}
    finally:
        os.close(fd)


def asset_meta(job_dir: Path, sha: str) -> dict:
    """The ``asset`` object of a stored asset (NotFound when missing or incomplete)."""
    meta = _stored(store_dir(job_dir), sha)
    if meta is None:
        raise NotFound()
    try:
        return _dto(sha, meta)
    except (KeyError, TypeError):
        raise NotFound() from None


# --- CLI -------------------------------------------------------------------------------------------


class _Usage(Exception):
    """A malformed envelope (exit 2)."""


def _pairs(items: list[tuple[str, Any]]) -> dict:
    result = dict(items)
    if len(result) != len(items):
        raise _Usage()
    return result


def _envelope(raw: bytes) -> dict:
    if not isinstance(raw, (bytes, bytearray)) or not raw or len(raw) > MAX_ENVELOPE_BYTES:
        raise _Usage()
    try:
        value = json.loads(bytes(raw).decode("utf-8"), object_pairs_hook=_pairs,
                           parse_constant=lambda _value: _Usage())
    except (ValueError, RecursionError):
        raise _Usage() from None
    if type(value) is not dict:
        raise _Usage()
    op = value.get("op")
    if not isinstance(op, str) or op not in _FIELDS or set(value) != {"op", *_FIELDS[op]}:
        raise _Usage()
    strings = {"jobId": _UUID, "incomingId": _UUID, "idempotencyKey": _UUID, "sha256": _SHA}
    for field, pattern in strings.items():
        if field in value and (not isinstance(value[field], str)
                               or pattern.fullmatch(value[field]) is None):
            raise _Usage()
    if op == "ingest":
        if value["kind"] not in KINDS or value["mime"] not in FORMATS:
            raise _Usage()
        try:  # the route sends it normalised already; normalising again changes nothing
            value["name"] = normalise_name(value["name"])
        except ValueError:
            raise _Usage() from None
    return value


def _error(error: EditV2Error) -> dict:
    return {"error": {"code": error.code, "path": None, "ref": error.ref,
                      "messageId": message_id(error.code)}}


def handle(raw: bytes, *, jobs_root: str | os.PathLike | None,
           now_ms: int | None = None) -> tuple[int, dict]:
    """Run one envelope; (exit code, stdout object). Never raises and never echoes a path, a
    name or FFmpeg's output (only fixed codes and reasons)."""
    internal = {"error": {"code": "internal_error", "path": None, "ref": None,
                          "messageId": message_id("internal_error")}}
    try:
        envelope = _envelope(raw)
        job = _job_dir(jobs_root, envelope["jobId"])
        if envelope["op"] == "meta":
            return EXIT_OK, {"asset": asset_meta(job, envelope["sha256"])}
        stamp = time.time_ns() // 1_000_000 if now_ms is None else now_ms
        return EXIT_OK, ingest(job, envelope["incomingId"], kind=envelope["kind"],
                               mime=envelope["mime"], name=envelope["name"],
                               idempotency_key=envelope["idempotencyKey"], now_ms=stamp)
    except _Usage:
        return EXIT_USAGE, internal
    except EditV2Error as error:
        code = exit_code_for(error)
        return code, (_error(error) if code != EXIT_INTERNAL else internal)
    except Exception:  # noqa: BLE001 - the process boundary exposes fixed codes only
        return EXIT_INTERNAL, internal


def main(argv: Sequence[str] | None = None) -> int:
    """Run one op from the stdin envelope; returns the process exit code."""
    arguments = sys.argv[1:] if argv is None else list(argv)
    if arguments:
        code, payload = EXIT_USAGE, handle(b"", jobs_root=None)[1]
    else:
        raw = sys.stdin.buffer.read(MAX_ENVELOPE_BYTES + 1)
        code, payload = handle(raw, jobs_root=os.environ.get("JOBS_ROOT"))
    sys.stdout.buffer.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
                            .encode("utf-8") + b"\n")
    sys.stdout.buffer.flush()
    return code


__all__ = [
    "ALLOWED_TYPES", "ASSET_CODES", "DEMUXERS", "FORMATS", "KINDS", "MAX_ASSETS_PER_JOB",
    "MAX_AUDIO_MS", "MAX_IMAGE_PIXELS", "MAX_IMAGE_SIDE", "MAX_NAME_CHARS", "MAX_STORE_BYTES",
    "MAX_UPLOAD_BYTES", "NORMALISED_MAX_SIDE", "OPS", "REASONS", "TIME_CAPS_S", "AssetRejected",
    "asset_meta", "check_declared", "child_env", "handle", "header_size", "ingest",
    "jpeg_orientation", "main", "message", "normalise_name", "normalised_size",
    "orientation_filters", "oriented_size", "sniff", "store_dir",
]


if __name__ == "__main__":
    raise SystemExit(main())
