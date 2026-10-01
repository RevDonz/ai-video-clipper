"""Waveform peaks of the analysis window (plan §3.6 "Peaks").

Owner: T1.5. Format (frozen, see docs/editor/CONTRACTS.md §5.7): mono audio decoded once at
8 kHz by FFmpeg; per bin of ``1000 / per_sec`` ms from ``window_ms[0]``, two signed bytes
``(min, max)`` of the s16 samples divided by 256 (floor); ``ceil((b − a) · per_sec / 1000)``
bins. Stored immutably as ``analysis/clips/<clip_id>/peaks.<sha16>.bin``.

Bins past the end of the audio, and every bin of a source without audio, are ``(0, 0)``. The
decode seeks with ``-ss`` before the input, which FFmpeg makes sample-accurate for audio, and
uses the default-disposition audio stream (else the first), like the renderer. The level of a
bin (:func:`bin_level`) is ``max(max, −min)`` in 1/128 of full scale; :func:`level_cdb` turns it
into centi-dBFS for the words artifact's ``rms_cdb``.
"""

from __future__ import annotations

import array
import hashlib
import json
import math
import os
import shutil
import stat
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path

from .source_info import PROTOCOL_WHITELIST, child_env

PEAKS_SAMPLE_RATE = 8000
DEFAULT_PER_SEC = 100
FLOOR_CDB = -9000  # level of an all-zero bin (the audio timeline's -90 dB floor)
FFMPEG_THREADS = 4
_TIMEOUT_BASE_S = 60.0


class PeaksError(RuntimeError):
    """FFmpeg could not decode the source's audio."""


def _window(window_ms: tuple[int, int]) -> tuple[int, int]:
    if not isinstance(window_ms, (tuple, list)) or len(window_ms) != 2:
        raise ValueError("window_ms must be an (a, b) pair")
    a, b = window_ms
    if type(a) is not int or type(b) is not int:
        raise ValueError("window_ms must hold integers")
    if a < 0 or b <= a:
        raise ValueError("window_ms must satisfy 0 <= a < b")
    return a, b


def _samples_per_bin(per_sec: int) -> int:
    if type(per_sec) is not int or per_sec <= 0 or PEAKS_SAMPLE_RATE % per_sec:
        raise ValueError("per_sec must be a positive divisor of 8000")
    return PEAKS_SAMPLE_RATE // per_sec


def bin_count(window_ms: tuple[int, int], per_sec: int = DEFAULT_PER_SEC) -> int:
    """``ceil((b − a) · per_sec / 1000)``."""
    a, b = _window(window_ms)
    _samples_per_bin(per_sec)
    return -(-(b - a) * per_sec // 1000)


def peaks_from_pcm(samples: Sequence[int], *, bins: int, samples_per_bin: int) -> bytes:
    """Pack ``bins`` ``(min // 256, max // 256)`` pairs of mono s16 ``samples``.

    Bins without samples (past the end of the audio) are ``(0, 0)``; extra samples are ignored.
    """
    if bins < 0 or samples_per_bin <= 0:
        raise ValueError("bins and samples_per_bin must be positive")
    out = array.array("b", bytes(2 * bins))
    usable = min(bins, -(-len(samples) // samples_per_bin))
    for index in range(usable):
        chunk = samples[index * samples_per_bin : (index + 1) * samples_per_bin]
        out[2 * index] = min(chunk) // 256
        out[2 * index + 1] = max(chunk) // 256
    return out.tobytes()


def bin_level(peaks: bytes, index: int) -> int:
    """The level of bin ``index``: ``max(max, −min)``, 0 (silence) to 128 (full scale)."""
    low = peaks[2 * index]
    high = peaks[2 * index + 1]
    low = low - 256 if low > 127 else low
    high = high - 256 if high > 127 else high
    return max(high, -low, 0)


_LEVEL_CDB = [FLOOR_CDB] + [
    math.floor(2000 * math.log10(level / 128) + 0.5) for level in range(1, 129)
]


def level_cdb(level: int) -> int:
    """``round_half_up(2000 · log10(level / 128))`` centi-dBFS; ``FLOOR_CDB`` for 0."""
    return _LEVEL_CDB[level]


def peaks_file_name(raw: bytes) -> str:
    """``peaks.<sha16>.bin``: the first 16 hex digits of the sha256 of the bytes."""
    return f"peaks.{hashlib.sha256(raw).hexdigest()[:16]}.bin"


def _audio_stream(ffprobe: str, source: Path) -> int | None:
    result = subprocess.run(
        [ffprobe, "-v", "error", *PROTOCOL_WHITELIST, "-select_streams", "a", "-show_entries",
         "stream=index:stream_disposition=default,attached_pic", "-of", "json", str(source)],
        capture_output=True, text=True, check=False, timeout=_TIMEOUT_BASE_S,
        stdin=subprocess.DEVNULL, env=child_env(),
    )
    if result.returncode != 0:
        raise PeaksError("ffprobe could not read the source")
    try:
        streams = json.loads(result.stdout).get("streams") or []
    except json.JSONDecodeError:
        raise PeaksError("ffprobe output is not JSON") from None
    candidates = [s for s in streams if not (s.get("disposition") or {}).get("attached_pic", 0)]
    for stream in candidates:
        if (stream.get("disposition") or {}).get("default", 0):
            return int(stream["index"])
    return int(candidates[0]["index"]) if candidates else None


def _seconds(ms: int) -> str:
    return f"{ms // 1000}.{ms % 1000:03d}"


def build_peaks(source: Path, window_ms: tuple[int, int], *, per_sec: int = 100) -> bytes:
    """The peaks bytes of ``source`` over ``window_ms``."""
    a, b = _window(window_ms)
    samples_per_bin = _samples_per_bin(per_sec)
    bins = bin_count((a, b), per_sec)
    source = Path(source)
    info = os.stat(source)  # FileNotFoundError for a missing source
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("source must be a regular file")
    ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
    if ffmpeg is None or ffprobe is None:
        raise PeaksError("ffmpeg/ffprobe not found")
    stream = _audio_stream(ffprobe, source)
    if stream is None:
        return bytes(2 * bins)
    argv = [
        ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-threads", str(FFMPEG_THREADS),
        *PROTOCOL_WHITELIST, "-ss", _seconds(a), "-t", _seconds(b - a), "-i", str(source),
        "-map", f"0:{stream}", "-vn", "-sn", "-dn", "-ac", "1", "-ar", str(PEAKS_SAMPLE_RATE),
        "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1",
    ]
    timeout = _TIMEOUT_BASE_S + (b - a) / 1000 / 10
    try:
        result = subprocess.run(argv, capture_output=True, check=False, timeout=timeout,
                                stdin=subprocess.DEVNULL, env=child_env())
    except subprocess.TimeoutExpired:
        raise PeaksError("peaks decode timed out") from None
    if result.returncode != 0:
        raise PeaksError("ffmpeg could not decode the source audio")
    data = result.stdout
    samples = array.array("h")
    samples.frombytes(data[: len(data) - len(data) % 2])
    if sys.byteorder != "little":
        samples.byteswap()
    return peaks_from_pcm(samples, bins=bins, samples_per_bin=samples_per_bin)


__all__ = [
    "DEFAULT_PER_SEC",
    "FLOOR_CDB",
    "PEAKS_SAMPLE_RATE",
    "PeaksError",
    "bin_count",
    "bin_level",
    "build_peaks",
    "level_cdb",
    "peaks_file_name",
    "peaks_from_pcm",
]
